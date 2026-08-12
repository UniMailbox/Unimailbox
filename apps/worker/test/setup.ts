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
