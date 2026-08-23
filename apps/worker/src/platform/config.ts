// platform/config — typed env parsing for the Worker runtime.
//
// CAP-001 stub evolved. The strict parsers here are the runtime authority
// for `AUTH_PROVIDER` and `BETTER_AUTH_URL`. Both fail closed: an unknown
// provider or an origin that carries credentials, query, or fragment is
// rejected with a typed `ConfigError` so the entrypoint can surface a
// 500 with a stable `code` instead of silently degrading.
//
// Why parse here rather than at route entry:
//   - The auth factory (Batch 2) and the deploy script (Batch 1) both need
//     the same canonical values. Parsing once in the platform layer keeps
//     the contract in one place.
//   - The doctor check (Batch 1) compares the binding/vars name set
//     across `wrangler.jsonc`, `wrangler.test.jsonc`, and this Env typing.
//     A `BETTER_AUTH_URL` default that is unusable in non-local targets
//     must be caught before the Worker tries to construct Better Auth.
//
// ADR-008 §HTTP and browser session contract — `BETTER_AUTH_SECRET` is
// distinct from `CREDENTIAL_ENCRYPTION_KEY`, the provider mode is the
// single closed enum (legacy|dual|better-auth), and HTTPS is required
// outside the local environment.
import type { EnvironmentName, SharedConfig } from '@unimailbox/config';
import type { AuthProviderName, Env } from './env';

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
export function parseBetterAuthUrl(
  raw: string | undefined,
  environment: EnvironmentName,
): string {
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
    throw new ConfigError(
      'INVALID_BETTER_AUTH_URL',
      'BETTER_AUTH_URL must not carry a fragment',
    );
  }
  if (environment !== 'local' && parsed.protocol !== 'https:') {
    throw new ConfigError(
      'INVALID_BETTER_AUTH_URL',
      `BETTER_AUTH_URL must use https for environment=${environment}`,
    );
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function loadConfig(env: Env): PlatformConfig {
  const rawEnv = env.ENVIRONMENT ?? 'local';
  const environment: EnvironmentName = ALLOWED_ENVIRONMENTS.includes(
    rawEnv as EnvironmentName,
  )
    ? (rawEnv as EnvironmentName)
    : 'local';
  const authProvider = parseAuthProvider(env.AUTH_PROVIDER);
  const betterAuthUrl = parseBetterAuthUrl(env.BETTER_AUTH_URL, environment);
  return {
    environment,
    runtime: 'workerd',
    authProvider,
    betterAuthUrl,
  };
}
