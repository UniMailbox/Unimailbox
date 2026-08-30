// platform/config.test.ts — CAP-042 (AC 11) closed-enum and origin
// validation. Pure unit tests for `parseAuthProvider`,
// `parseBetterAuthUrl`, and `loadConfig`.
//
// The rules under test:
//   - parseAuthProvider: closed enum (legacy|dual|better-auth), empty
//     defaults to 'legacy', unknown values fail closed.
//   - parseBetterAuthUrl: bare http(s) origin, no credentials, no
//     query, no fragment, https required for non-local environments.
//   - loadConfig: composes the three without leaking secrets.
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  loadConfig,
  parseAdditionalTrustedOrigins,
  parseAuthProvider,
  parseBetterAuthUrl,
  parseEnvironment,
} from './config';
import type { Env } from './env';

// The unit project does not pull in @cloudflare/workers-types globals;
// the values are placeholders so `loadConfig` can read the typed fields
// (ENVIRONMENT, AUTH_PROVIDER, BETTER_AUTH_URL) without touching any
// runtime Cloudflare binding.
const baseEnv = (overrides: Partial<Env> = {}): Env =>
  ({
    DB: undefined as never,
    ATTACHMENTS: undefined as never,
    SETUP_SESSION: undefined as never,
    CACHE: undefined as never,
    OUTBOUND: undefined as never,
    ASSETS: undefined as never,
    INSTALLATION_TOKEN: undefined as never,
    CREDENTIAL_ENCRYPTION_KEY: undefined as never,
    BETTER_AUTH_SECRET: undefined as never,
    ENVIRONMENT: 'local',
    BETTER_AUTH_URL: 'http://localhost',
    AUTH_PROVIDER: 'legacy',
    ...overrides,
  }) as Env;

describe('parseAuthProvider', () => {
  it('returns "legacy" when raw is undefined', () => {
    expect(parseAuthProvider(undefined)).toBe('legacy');
  });

  it('returns "legacy" when raw is the empty string', () => {
    expect(parseAuthProvider('')).toBe('legacy');
  });

  it('accepts each closed-enum value', () => {
    expect(parseAuthProvider('legacy')).toBe('legacy');
    expect(parseAuthProvider('dual')).toBe('dual');
    expect(parseAuthProvider('better-auth')).toBe('better-auth');
  });

  it('rejects unknown values with a typed ConfigError', () => {
    let captured: ConfigError | null = null;
    try {
      parseAuthProvider('postgres');
    } catch (err) {
      captured = err as ConfigError;
    }
    expect(captured?.code).toBe('INVALID_AUTH_PROVIDER');
    expect(captured?.message).toContain('postgres');
  });

  it('rejects case-mutated values (closed enum, no aliasing)', () => {
    expect(() => parseAuthProvider('Legacy')).toThrow(ConfigError);
    expect(() => parseAuthProvider('LEGACY')).toThrow(ConfigError);
    expect(() => parseAuthProvider('Better-Auth')).toThrow(ConfigError);
  });
});

describe('parseEnvironment', () => {
  it('defaults only missing or empty values to local', () => {
    expect(parseEnvironment(undefined)).toBe('local');
    expect(parseEnvironment('')).toBe('local');
  });

  it('accepts every closed-enum value', () => {
    expect(parseEnvironment('local')).toBe('local');
    expect(parseEnvironment('preview')).toBe('preview');
    expect(parseEnvironment('staging')).toBe('staging');
    expect(parseEnvironment('production')).toBe('production');
  });

  it('rejects unknown and case-mutated values', () => {
    expect(() => parseEnvironment('prod')).toThrow(ConfigError);
    expect(() => parseEnvironment('Production')).toThrow(ConfigError);
  });
});

describe('parseBetterAuthUrl', () => {
  it('rejects undefined and empty input', () => {
    expect(() => parseBetterAuthUrl(undefined, 'local')).toThrow(/required/);
    expect(() => parseBetterAuthUrl('', 'local')).toThrow(/required/);
  });

  it('rejects garbage that does not parse as a URL', () => {
    expect(() => parseBetterAuthUrl('not a url', 'local')).toThrow(/not a valid URL/);
  });

  it('rejects non-http(s) protocols', () => {
    expect(() => parseBetterAuthUrl('ftp://example.com', 'local')).toThrow(/http or https/);
    expect(() => parseBetterAuthUrl('javascript:alert(1)', 'local')).toThrow(/http or https/);
    expect(() => parseBetterAuthUrl('file:///etc/passwd', 'local')).toThrow(/http or https/);
  });

  it('rejects URLs that carry credentials', () => {
    expect(() => parseBetterAuthUrl('https://user@example.com', 'local')).toThrow(/credentials/);
    expect(() => parseBetterAuthUrl('https://user:pass@example.com', 'local')).toThrow(
      /credentials/,
    );
  });

  it('rejects URLs that carry a query string or fragment', () => {
    expect(() => parseBetterAuthUrl('https://example.com/?token=x', 'local')).toThrow(
      /query string/,
    );
    expect(() => parseBetterAuthUrl('https://example.com/#frag', 'local')).toThrow(/fragment/);
  });

  it('requires https for non-local environments', () => {
    expect(() => parseBetterAuthUrl('http://example.com', 'preview')).toThrow(/https/);
    expect(() => parseBetterAuthUrl('http://example.com', 'staging')).toThrow(/https/);
    expect(() => parseBetterAuthUrl('http://example.com', 'production')).toThrow(/https/);
  });

  it('accepts http://localhost for local', () => {
    expect(parseBetterAuthUrl('http://localhost', 'local')).toBe('http://localhost');
  });

  it('accepts http://localhost:3000 for local', () => {
    expect(parseBetterAuthUrl('http://localhost:3000', 'local')).toBe('http://localhost:3000');
  });

  it('accepts a bare https origin for non-local and returns the canonical origin', () => {
    expect(parseBetterAuthUrl('https://app.example.com', 'production')).toBe(
      'https://app.example.com',
    );
    // Strips trailing slash from inputs to keep `baseURL` stable.
    expect(parseBetterAuthUrl('https://app.example.com/', 'production')).toBe(
      'https://app.example.com',
    );
  });

  it('preserves the explicit port for non-local hosts', () => {
    expect(parseBetterAuthUrl('https://preview.example.com:8443', 'preview')).toBe(
      'https://preview.example.com:8443',
    );
  });
});

describe('loadConfig', () => {
  it('returns the documented defaults when no override is provided', () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.environment).toBe('local');
    expect(cfg.authProvider).toBe('legacy');
    expect(cfg.betterAuthUrl).toBe('http://localhost');
    expect(cfg.runtime).toBe('workerd');
  });

  it('passes through an explicit auth provider', () => {
    const cfg = loadConfig(baseEnv({ AUTH_PROVIDER: 'better-auth' }));
    expect(cfg.authProvider).toBe('better-auth');
  });

  it('fails closed on an unknown provider', () => {
    expect(() => loadConfig(baseEnv({ AUTH_PROVIDER: 'openid' }))).toThrow(ConfigError);
  });

  it('fails closed on an unknown environment instead of applying local URL rules', () => {
    let captured: ConfigError | null = null;
    try {
      loadConfig(baseEnv({ ENVIRONMENT: 'prod' as Env['ENVIRONMENT'] }));
    } catch (err) {
      captured = err as ConfigError;
    }
    expect(captured?.code).toBe('INVALID_ENVIRONMENT');
  });

  it('fails closed when a non-local environment ships http://localhost', () => {
    expect(() =>
      loadConfig(baseEnv({ ENVIRONMENT: 'preview', BETTER_AUTH_URL: 'http://localhost' })),
    ).toThrow(/https/);
  });

  it('accepts https for preview with the corresponding URL', () => {
    const cfg = loadConfig(
      baseEnv({ ENVIRONMENT: 'preview', BETTER_AUTH_URL: 'https://preview.example.com' }),
    );
    expect(cfg.environment).toBe('preview');
    expect(cfg.betterAuthUrl).toBe('https://preview.example.com');
  });

  it('rejects an unparseable URL with a typed ConfigError', () => {
    let captured: ConfigError | null = null;
    try {
      loadConfig(baseEnv({ BETTER_AUTH_URL: '::not::a::url::' }));
    } catch (err) {
      captured = err as ConfigError;
    }
    expect(captured?.code).toBe('INVALID_BETTER_AUTH_URL');
  });
});

// D-CAP-042-auth-origin: parseAdditionalTrustedOrigins is the parser
// that populates Better Auth's `trustedOrigins` array beyond
// `betterAuthUrl`. Mirrors parseBetterAuthUrl rules so a typo'd origin
// or a non-http(s) URL fails closed with the same ConfigError code.
describe('parseAdditionalTrustedOrigins', () => {
  it('returns [] when the env var is unset', () => {
    expect(parseAdditionalTrustedOrigins(undefined, 'local')).toEqual([]);
  });

  it('returns [] when the env var is empty / whitespace', () => {
    expect(parseAdditionalTrustedOrigins('', 'local')).toEqual([]);
    expect(parseAdditionalTrustedOrigins('   ', 'local')).toEqual([]);
  });

  it('parses a single origin', () => {
    expect(parseAdditionalTrustedOrigins('http://localhost:5173', 'local')).toEqual([
      'http://localhost:5173',
    ]);
  });

  it('parses multiple comma-separated origins and trims whitespace', () => {
    expect(
      parseAdditionalTrustedOrigins(
        'http://localhost:5173 , https://preview.example.com,http://localhost:4173',
        'local',
      ),
    ).toEqual([
      'http://localhost:5173',
      'https://preview.example.com',
      'http://localhost:4173',
    ]);
  });

  it('dedupes entries (case-sensitive on the canonical origin)', () => {
    // parseBetterAuthUrl canonicalises to `${protocol}//${host}`; two
    // inputs that differ only in path fragment or trailing slash
    // collapse to the same canonical form.
    expect(
      parseAdditionalTrustedOrigins(
        'http://localhost:5173,http://localhost:5173',
        'local',
      ),
    ).toEqual(['http://localhost:5173']);
  });

  it('skips empty entries between commas', () => {
    expect(
      parseAdditionalTrustedOrigins('http://localhost:5173,,http://localhost:4173,', 'local'),
    ).toEqual(['http://localhost:5173', 'http://localhost:4173']);
  });

  it('rejects a non-http(s) origin with INVALID_BETTER_AUTH_URL', () => {
    expect(() =>
      parseAdditionalTrustedOrigins('http://localhost:5173,ftp://example.com', 'local'),
    ).toThrow(/http or https/);
  });

  it('rejects an origin with credentials (userinfo) with INVALID_BETTER_AUTH_URL', () => {
    expect(() =>
      parseAdditionalTrustedOrigins('http://attacker:pw@example.com', 'local'),
    ).toThrow(/credentials/);
  });

  it('rejects an origin with a query string with INVALID_BETTER_AUTH_URL', () => {
    expect(() =>
      parseAdditionalTrustedOrigins('http://localhost:5173?token=x', 'local'),
    ).toThrow(/query/);
  });

  it('requires https for non-local environments', () => {
    expect(() =>
      parseAdditionalTrustedOrigins('http://preview.example.com', 'preview'),
    ).toThrow(/https/);
    expect(
      parseAdditionalTrustedOrigins('https://preview.example.com', 'preview'),
    ).toEqual(['https://preview.example.com']);
  });
});

// D-CAP-042-auth-origin: loadConfig wires additionalTrustedOrigins
// into the returned PlatformConfig.
describe('loadConfig — additionalTrustedOrigins', () => {
  it('populates additionalTrustedOrigins from the env var', () => {
    const cfg = loadConfig(
      baseEnv({
        BETTER_AUTH_URL: 'http://localhost:8787',
        BETTER_AUTH_ADDITIONAL_TRUSTED_ORIGINS: 'http://localhost:5173',
      }),
    );
    expect(cfg.additionalTrustedOrigins).toEqual(['http://localhost:5173']);
  });

  it('defaults to [] when the env var is not set', () => {
    const cfg = loadConfig(baseEnv({ BETTER_AUTH_URL: 'http://localhost:8787' }));
    expect(cfg.additionalTrustedOrigins).toEqual([]);
  });
});
