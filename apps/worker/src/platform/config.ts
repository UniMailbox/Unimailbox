// platform/config — typed env parsing for the Worker runtime.
//
// CAP-001 stub evolved. The strict parsers here are the runtime authority
// for `AUTH_PROVIDER`, `BETTER_AUTH_URL`, and `CURSOR_SIGNING_KEY`. All
// three fail closed: an unknown provider, an origin that carries
// credentials, query, or fragment, or a missing cursor key is rejected
// with a typed `ConfigError` so the entrypoint can surface a 500 with a
// stable `code` instead of silently degrading.
//
// Why parse here rather than at route entry:
//   - The auth factory (Batch 2) and the deploy script (Batch 1) both need
//     the same canonical values. Parsing once in the platform layer keeps
//     the contract in one place.
//   - The doctor check (Batch 1) compares the binding/vars name set
//     across `wrangler.jsonc`, `wrangler.test.jsonc`, and this Env typing.
//     A `BETTER_AUTH_URL` default that is unusable in non-local targets
//     must be caught before the Worker tries to construct Better Auth.
//     The `CURSOR_SIGNING_KEY` requirement (CAP-043 Slice 1 / D-CAP-043-D)
//     belongs in the same gate so the worker-pool tests catch a missing
//     binding at startup rather than at first request.
//
// ADR-008 §HTTP and browser session contract — `BETTER_AUTH_SECRET` is
// distinct from `CREDENTIAL_ENCRYPTION_KEY`, the provider mode is the
// single closed enum (legacy|dual|better-auth), and HTTPS is required
// outside the local environment. CAP-043 D-CAP-043-D adds
// `CURSOR_SIGNING_KEY` as a third independent secret: the cursor HMAC
// key is neither the credential AES-GCM key nor the Better Auth cookie
// HMAC key, and a rotation of one must not silently rotate the other.
import type { EnvironmentName, SharedConfig } from '@unimailbox/config';
import type { AuthProviderName, Env } from './env';
import { readSecret, type SecretLike } from './secrets';

const ALLOWED_ENVIRONMENTS: ReadonlyArray<EnvironmentName> = [
  'local',
  'preview',
  'staging',
  'production',
];

export interface PlatformConfig extends SharedConfig {
  readonly environment: EnvironmentName;
  readonly authProvider: AuthProviderName;
  readonly betterAuthUrl: string;
  /**
   * Origins (besides `betterAuthUrl`) that Better Auth accepts cross-origin
   * requests from. Empty in production where the SPA and API are
   * same-origin; populated in local dev where the Vite SPA (port 5173)
   * and the Worker (port 8787) are different origins. The browser
   * document origin is the Vite port, so BA's CSRF/origin middleware
   * must allow it explicitly to avoid INVALID_ORIGIN on the login form.
   * See `parseAdditionalTrustedOrigins` for the parser; values are
   * validated through the same rules as `betterAuthUrl`.
   */
  readonly additionalTrustedOrigins: readonly string[];
}

export class ConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

const AUTH_PROVIDERS: ReadonlyArray<AuthProviderName> = ['legacy', 'dual', 'better-auth'];

/** Parse ENVIRONMENT as a closed enum. Unknown values must never inherit local relaxations. */
export function parseEnvironment(raw: string | undefined): EnvironmentName {
  if (raw === undefined || raw === '') return 'local';
  if ((ALLOWED_ENVIRONMENTS as ReadonlyArray<string>).includes(raw)) {
    return raw as EnvironmentName;
  }
  throw new ConfigError(
    'INVALID_ENVIRONMENT',
    `ENVIRONMENT must be one of ${ALLOWED_ENVIRONMENTS.join('|')}; got ${JSON.stringify(raw)}`,
  );
}

/**
 * Parse the auth provider mode from the runtime env. Unknown values fail
 * closed with `INVALID_AUTH_PROVIDER` so a typo or stale var cannot
 * silently route through a non-existent mode. The default is `'legacy'`
 * because ADR-008 §Rollout and rollback requires an opt-in cutover; any
 * non-empty string that does not match the closed enum is a hard error.
 */
export function parseAuthProvider(raw: string | undefined): AuthProviderName {
  if (raw === undefined || raw === '') return 'legacy';
  if ((AUTH_PROVIDERS as ReadonlyArray<string>).includes(raw)) {
    return raw as AuthProviderName;
  }
  throw new ConfigError(
    'INVALID_AUTH_PROVIDER',
    `AUTH_PROVIDER must be one of ${AUTH_PROVIDERS.join('|')}; got ${JSON.stringify(raw)}`,
  );
}

/**
 * Validate the Better Auth URL.
 *
 * Rules (mirror ADR-008 §HTTP and browser session contract + Hono
 * "Better Auth on Cloudflare" reference):
 *   1. Must be a non-empty string.
 *   2. Must parse as a URL with `http:` or `https:` protocol.
 *   3. Must NOT carry userinfo (credentials).
 *   4. Must NOT carry query string or fragment — Better Auth uses the
 *      origin alone; anything else risks leaking internal state to the
 *      browser address bar.
 *   5. For non-`local` environments the scheme must be `https:` so a
 *      preview/production deployment cannot ship cookies that the
 *      browser refuses to attach.
 *
 * Returns the canonicalised origin string (`${protocol}//${host}`) so
 * Better Auth's `baseURL` is the same shape every request hits.
 */
export function parseBetterAuthUrl(raw: string | undefined, environment: EnvironmentName): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new ConfigError('INVALID_BETTER_AUTH_URL', 'BETTER_AUTH_URL is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConfigError(
      'INVALID_BETTER_AUTH_URL',
      `BETTER_AUTH_URL is not a valid URL: ${JSON.stringify(raw)}`,
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(
      'INVALID_BETTER_AUTH_URL',
      `BETTER_AUTH_URL must use http or https; got ${parsed.protocol}`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConfigError(
      'INVALID_BETTER_AUTH_URL',
      'BETTER_AUTH_URL must not carry credentials (userinfo)',
    );
  }
  if (parsed.search !== '') {
    throw new ConfigError(
      'INVALID_BETTER_AUTH_URL',
      'BETTER_AUTH_URL must not carry a query string',
    );
  }
  if (parsed.hash !== '') {
    throw new ConfigError('INVALID_BETTER_AUTH_URL', 'BETTER_AUTH_URL must not carry a fragment');
  }
  if (environment !== 'local' && parsed.protocol !== 'https:') {
    throw new ConfigError(
      'INVALID_BETTER_AUTH_URL',
      `BETTER_AUTH_URL must use https for environment=${environment}`,
    );
  }
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * Parse the optional `BETTER_AUTH_ADDITIONAL_TRUSTED_ORIGINS` env var
 * into a deduplicated list of canonical origins. The value is a
 * comma-separated list (whitespace tolerated); each entry is validated
 * through `parseBetterAuthUrl` so a typo or a non-http(s) URL fails
 * closed with the same `INVALID_BETTER_AUTH_URL` code — the threat
 * model is the same as the base URL (no credentials, no query, no
 * fragment; https required for non-local).
 *
 * Returns `[]` when the env var is unset or empty, which is the
 * production default: the SPA and API are same-origin so `betterAuthUrl`
 * already covers the only allowed origin.
 *
 * Why this exists: in local dev the Vite SPA (port 5173) and the Worker
 * (port 8787) are different origins. Vite proxies `/api/*` to the
 * Worker with `changeOrigin: false`, so the browser document origin
 * (5173) is preserved on every cross-origin request. Better Auth's
 * CSRF/origin middleware rejects anything not in `trustedOrigins`;
 * conflating `baseURL` with `trustedOrigins` (the prior factory shape)
 * meant the SPA origin was unreachable from the login form.
 */
export function parseAdditionalTrustedOrigins(
  raw: string | undefined,
  environment: EnvironmentName,
): readonly string[] {
  if (raw === undefined || raw.trim() === '') return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const parsed = parseBetterAuthUrl(trimmed, environment);
    if (seen.has(parsed)) continue;
    seen.add(parsed);
    out.push(parsed);
  }
  return out;
}

export function loadConfig(env: Env): PlatformConfig {
  const environment = parseEnvironment(env.ENVIRONMENT);
  const authProvider = parseAuthProvider(env.AUTH_PROVIDER);
  // Better Auth is migration-only and is not part of the deployed auth
  // surface. Keep a local sentinel for the quarantined adapter so the
  // composition root remains backwards-compatible while no deployment
  // configuration or request path depends on it.
  const betterAuthUrl = env.BETTER_AUTH_URL
    ? parseBetterAuthUrl(env.BETTER_AUTH_URL, environment)
    : 'http://localhost';
  const additionalTrustedOrigins = parseAdditionalTrustedOrigins(
    env.BETTER_AUTH_ADDITIONAL_TRUSTED_ORIGINS,
    environment,
  );
  // CAP-043 Slice 1 fix pass (F8): there is no `cursorSigningKey` field on
  // PlatformConfig. The key is Secrets-Store-backed and therefore read
  // asynchronously — the only valid path is `parseCursorSigningKey(env)`
  // (below), which the messages route awaits per request.
  return {
    environment,
    runtime: 'workerd',
    authProvider,
    betterAuthUrl,
    additionalTrustedOrigins,
  };
}

/**
 * Read the `CURSOR_SIGNING_KEY` binding and return its raw string form.
 *
 * The binding is a Secrets Store entry in production (SecretsStoreSecret
 * with `.get()`) and a plain string in the worker-pool test (set as a
 * var in `wrangler.test.jsonc`). `readSecret()` in `platform/secrets.ts`
 * abstracts the two forms; this helper only enforces the
 * non-empty-string rule that HMAC-SHA-256 needs to be deterministic.
 *
 * The key is required at runtime: the inbox list cursor must be signed
 * for every paginated response, and an absent or empty key would
 * silently produce HMACs over the empty string (a value any attacker
 * could compute independently). We fail closed with
 * `INVALID_CURSOR_SIGNING_KEY` so the error middleware renders a 500
 * rather than a 200 with an unsigned cursor.
 */
export async function parseCursorSigningKey(env: Env): Promise<string> {
  const raw: SecretLike | undefined = env.CURSOR_SIGNING_KEY;
  if (raw === undefined) {
    throw new ConfigError(
      'INVALID_CURSOR_SIGNING_KEY',
      'CURSOR_SIGNING_KEY is required (CAP-043 / D-CAP-043-D)',
    );
  }
  const value = await readSecret(raw);
  if (value.length === 0) {
    throw new ConfigError(
      'INVALID_CURSOR_SIGNING_KEY',
      'CURSOR_SIGNING_KEY must be a non-empty string',
    );
  }
  return value;
}
