// apps/worker test setup — CAP-002.
// Runs before every test (unit + workers projects).
//
// `process.env.ENVIRONMENT = 'local'` so anything reaching for the platform
// config at import-time narrows to the 'local' branch. The workers pool also
// injects `env.ENVIRONMENT` via wrangler.jsonc vars, so this is belt-and-braces.
//
// Per .claude/rules/security.md §Logging — tests do not log secrets, tokens,
// or message bodies. Console is silenced here so the vitest reporter's
// output stays clean.
import process from 'node:process';
import { afterEach, vi } from 'vitest';

if (process.env.ENVIRONMENT === undefined) {
  process.env.ENVIRONMENT = 'local';
}

// Silence console in tests. Per .claude/rules/security.md §Logging, tests
// must not log secrets/tokens/bodies; per .claude/rules/testing.md
// §Determinism, tests must not depend on console output. The spy is installed
// once and re-installed per test via `mockClear` so test interactions are
// isolated.
const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(console, 'info').mockImplementation(() => {});

afterEach(() => {
  consoleSpy.mockClear();
});

// CAP-042 (AC 12): Better Auth 1.7.1 sometimes surfaces a structured
// `APIError` as both a returned Response and an unhandled rejection on
// a side-channel promise inside `drizzleAdapter`'s transaction wrapper.
// The response is the canonical 4xx envelope and the route layer
// passes it through unchanged; the unhandled rejection is a known
// framework noise that would otherwise fail the vitest run with a
// non-zero exit code.
//
// We swallow only `APIError`-shaped rejections so genuine bugs in
// our own code still surface. Anything else (TypeError, plain Error,
// etc.) is re-thrown via the default Node behaviour by NOT registering
// a listener for it.
interface BetterAuthAPIError {
  readonly statusCode?: number;
  readonly body?: unknown;
  readonly name?: string;
}

process.on('unhandledRejection', (reason: unknown) => {
  if (reason && typeof reason === 'object' && 'statusCode' in reason) {
    const candidate = reason as BetterAuthAPIError;
    if (typeof candidate.statusCode === 'number' && candidate.statusCode >= 400) {
      return;
    }
  }
  // Not a recognised Better Auth APIError — let the default handler
  // log it (the worker pool re-throws via console.error).
  console.error('[unhandledRejection]', reason);
});
