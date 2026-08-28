// scripts/deploy.test.ts — CAP-005 unit tests for deploy automation.
//
// Tests cover:
// - Config resolution: all 4 placeholders replaced correctly
// - Config resolution: no-op when placeholders already absent
// - ENVIRONMENT guard: exits 2 on `local` and unset
// - Resource state file read/write roundtrip
// - Secret generation: produces hex strings of correct length
//
// Tests import the real functions from deploy.ts — no duplicated logic.
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  resolveConfigTemplate,
  generateSecret,
  checkEnvironmentGuard,
  loadResourceState,
  saveResourceState,
  computeSecretAction,
  computePendingMigrations,
  parseAppliedMigrationNames,
  NO_PENDING_LOG_FORMAT,
  evaluateDeployConfigForTarget,
  parseMigrationVerificationOutput,
  parseWranglerList,
  type ResourceState,
} from './deploy.js';

// ---------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------

describe('scripts/deploy.ts — pure logic', () => {
  describe('resolveConfigTemplate', () => {
    const mockTemplate = JSON.stringify(
      {
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'unimailbox-db',
            database_id: 'REPLACE_WITH_D1_DATABASE_ID',
          },
        ],
        kv_namespaces: [
          {
            binding: 'SETUP_SESSION',
            id: 'REPLACE_WITH_KV_SETUP_SESSION_ID',
          },
          {
            binding: 'CACHE',
            id: 'REPLACE_WITH_KV_CACHE_ID',
          },
        ],
        secrets_store_secrets: [
          {
            binding: 'INSTALLATION_TOKEN',
            store_id: 'REPLACE_WITH_SECRETS_STORE_ID',
            secret_name: 'INSTALLATION_TOKEN',
          },
          {
            binding: 'CREDENTIAL_ENCRYPTION_KEY',
            store_id: 'REPLACE_WITH_SECRETS_STORE_ID',
            secret_name: 'CREDENTIAL_ENCRYPTION_KEY',
          },
        ],
      },
      null,
      2,
    );

    it('replaces all 4 placeholders with real IDs', () => {
      const state: ResourceState = {
        d1DatabaseId: 'd1-abc123',
        kvSetupSessionId: 'kv-def456',
        kvCacheId: 'kv-ghi789',
        secretsStoreId: 'ss-jkl012',
      };

      const resolved = resolveConfigTemplate(mockTemplate, state, { targetEnv: 'local' });

      // Each placeholder should be replaced
      expect(resolved).toContain('"database_id": "d1-abc123"');
      expect(resolved).toContain('"id": "kv-def456"');
      expect(resolved).toContain('"id": "kv-ghi789"');
      // Both secrets_store_secrets entries should have the same store_id
      const storeIdMatches = resolved.match(/"store_id": "ss-jkl012"/g);
      expect(storeIdMatches).toHaveLength(2);

      // No placeholders should remain
      expect(resolved).not.toContain('REPLACE_WITH_D1_DATABASE_ID');
      expect(resolved).not.toContain('REPLACE_WITH_KV_SETUP_SESSION_ID');
      expect(resolved).not.toContain('REPLACE_WITH_KV_CACHE_ID');
      expect(resolved).not.toContain('REPLACE_WITH_SECRETS_STORE_ID');
    });

    it('handles missing IDs gracefully', () => {
      const state: ResourceState = {
        d1DatabaseId: 'd1-abc123',
        // Missing: kvSetupSessionId, kvCacheId, secretsStoreId
      };

      const resolved = resolveConfigTemplate(mockTemplate, state, { targetEnv: 'local' });

      expect(resolved).toContain('"database_id": "d1-abc123"');
      expect(resolved).toContain('"id": "<missing>"');
    });

    it('is a no-op when placeholders already replaced', () => {
      const alreadyResolved = mockTemplate
        .replace('REPLACE_WITH_D1_DATABASE_ID', 'real-d1-id')
        .replace('REPLACE_WITH_KV_SETUP_SESSION_ID', 'real-kv-setup-id')
        .replace('REPLACE_WITH_KV_CACHE_ID', 'real-kv-cache-id')
        .replace(/REPLACE_WITH_SECRETS_STORE_ID/g, 'real-ss-id');

      const state: ResourceState = {
        d1DatabaseId: 'd1-abc123',
        kvSetupSessionId: 'kv-def456',
        kvCacheId: 'kv-ghi789',
        secretsStoreId: 'ss-jkl012',
      };

      const resolved = resolveConfigTemplate(alreadyResolved, state, { targetEnv: 'local' });

      // Should not change anything (placeholders already gone)
      expect(resolved).toContain('real-d1-id');
      expect(resolved).toContain('real-kv-setup-id');
      expect(resolved).toContain('real-kv-cache-id');
      expect(resolved).toContain('real-ss-id');
      expect(resolved).not.toContain('d1-abc123');
    });
  });

  // INV-003 / CAP-005 follow-up: target-value substitution. The deploy flow
  // passes the requested ENVIRONMENT and an explicitly supplied
  // BETTER_AUTH_URL into the pure resolver so the gitignored generated
  // JSONC reflects the deploy target without mutating the committed
  // template. The override is optional — when absent the template's
  // local-default sentinel stays in place so the guard can still fail
  // closed.
  describe('resolveConfigTemplate target overrides (INV-003)', () => {
    const varsTemplate = JSON.stringify({
      vars: {
        ENVIRONMENT: 'local',
        BETTER_AUTH_URL: 'http://localhost',
        AUTH_PROVIDER: 'legacy',
      },
    });

    it('substitutes target ENVIRONMENT and an explicit https override for a preview target', () => {
      const resolved = resolveConfigTemplate(
        varsTemplate,
        {},
        {
          targetEnv: 'preview',
          betterAuthUrlOverride: 'https://preview.example.com',
        },
      );
      expect(() => JSON.parse(resolved)).not.toThrow();
      const parsed = JSON.parse(resolved) as {
        vars: { ENVIRONMENT: string; BETTER_AUTH_URL: string; AUTH_PROVIDER: string };
      };
      expect(parsed.vars.ENVIRONMENT).toBe('preview');
      expect(parsed.vars.BETTER_AUTH_URL).toBe('https://preview.example.com');
      // Unrelated vars entries must remain untouched.
      expect(parsed.vars.AUTH_PROVIDER).toBe('legacy');
    });

    it('keeps local template defaults when no BETTER_AUTH_URL override is supplied', () => {
      const resolved = resolveConfigTemplate(varsTemplate, {}, { targetEnv: 'local' });
      const parsed = JSON.parse(resolved) as {
        vars: { ENVIRONMENT: string; BETTER_AUTH_URL: string; AUTH_PROVIDER: string };
      };
      expect(parsed.vars.ENVIRONMENT).toBe('local');
      expect(parsed.vars.BETTER_AUTH_URL).toBe('http://localhost');
    });

    it('refuses a non-local target when BETTER_AUTH_URL override is missing (fails closed)', () => {
      // No override supplied → the committed local-default sentinel
      // (`http://localhost`) stays in place; the guard must reject it.
      const resolved = resolveConfigTemplate(varsTemplate, {}, { targetEnv: 'preview' });
      const parsed = JSON.parse(resolved) as {
        vars: { ENVIRONMENT: string; BETTER_AUTH_URL: string; AUTH_PROVIDER: string };
      };
      expect(parsed.vars.ENVIRONMENT).toBe('preview');
      expect(parsed.vars.BETTER_AUTH_URL).toBe('http://localhost');
      const guard = evaluateDeployConfigForTarget(resolved, 'preview');
      expect(guard.ok).toBe(false);
      expect(guard.error).toContain('http://localhost');
    });

    it('refuses a non-local target when BETTER_AUTH_URL override is http:// (fails closed)', () => {
      const resolved = resolveConfigTemplate(
        varsTemplate,
        {},
        {
          targetEnv: 'preview',
          betterAuthUrlOverride: 'http://preview.example.com',
        },
      );
      expect(resolved).toContain('"BETTER_AUTH_URL": "http://preview.example.com"');
      const guard = evaluateDeployConfigForTarget(resolved, 'preview');
      expect(guard.ok).toBe(false);
      expect(guard.error).toContain('https');
    });

    it('escapes JSON-unsafe characters so generated JSONC stays valid', () => {
      // Pathological value containing embedded quote, backslash, and
      // newline — the kind of input JSON.stringify handles by default.
      // The resolver must produce a string that re-parses cleanly and
      // round-trips the original value byte-for-byte.
      const unsafe = 'https://example.com/"q"\\q\nnext';
      const resolved = resolveConfigTemplate(
        varsTemplate,
        {},
        {
          targetEnv: 'preview',
          betterAuthUrlOverride: unsafe,
        },
      );
      expect(() => JSON.parse(resolved)).not.toThrow();
      const parsed = JSON.parse(resolved) as {
        vars: { ENVIRONMENT: string; BETTER_AUTH_URL: string; AUTH_PROVIDER: string };
      };
      expect(parsed.vars.ENVIRONMENT).toBe('preview');
      expect(parsed.vars.BETTER_AUTH_URL).toBe(unsafe);
      expect(parsed.vars.AUTH_PROVIDER).toBe('legacy');
    });
  });

  describe('generateSecret', () => {
    it('produces 64-character hex string (32 bytes)', () => {
      const secret = generateSecret();
      expect(secret).toHaveLength(64);
      expect(secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces different values on each call', () => {
      const s1 = generateSecret();
      const s2 = generateSecret();
      expect(s1).not.toBe(s2);
    });
  });

  describe('computeSecretAction (F8)', () => {
    it('returns create when secret not set, no force', () => {
      expect(computeSecretAction(false, false, false)).toBe('create');
    });

    it('returns create when secret not set, force (force irrelevant)', () => {
      expect(computeSecretAction(false, true, false)).toBe('create');
    });

    it('returns skip when secret set, no force', () => {
      expect(computeSecretAction(true, false, false)).toBe('skip');
    });

    it('returns update when secret set, force', () => {
      expect(computeSecretAction(true, true, false)).toBe('update');
    });

    it('returns create when secret not set, dry-run', () => {
      expect(computeSecretAction(false, false, true)).toBe('create');
    });

    it('returns update when secret set, dry-run, force', () => {
      expect(computeSecretAction(true, true, true)).toBe('update');
    });

    it('returns skip when secret set, dry-run, no force', () => {
      expect(computeSecretAction(true, false, true)).toBe('skip');
    });
  });

  describe('checkEnvironmentGuard', () => {
    it('allows non-local environments', () => {
      expect(checkEnvironmentGuard('preview')).toEqual({ ok: true });
      expect(checkEnvironmentGuard('production')).toEqual({ ok: true });
      expect(checkEnvironmentGuard('staging')).toEqual({ ok: true });
    });

    it('rejects unset ENVIRONMENT', () => {
      const result = checkEnvironmentGuard(undefined);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('(unset)');
      expect(result.error).toContain('preview|staging|production');
    });

    it('rejects local environment', () => {
      const result = checkEnvironmentGuard('local');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('ENVIRONMENT=local');
      expect(result.error).toContain('preview|staging|production');
    });

    it('rejects arbitrary non-local strings', () => {
      const result = checkEnvironmentGuard('prod');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('ENVIRONMENT=prod');
    });
  });

  describe('parseWranglerList', () => {
    it('accepts the current direct-array Wrangler list shape', () => {
      const result = parseWranglerList<{ uuid: string; name: string }>(
        {
          status: 0,
          stdout: JSON.stringify([{ uuid: 'd1-123', name: 'unimailbox-db' }]),
        },
        'd1-list',
      );

      expect(result).toEqual({ ok: true, data: [{ uuid: 'd1-123', name: 'unimailbox-db' }] });
    });

    it('continues to accept the legacy success/result wrapper', () => {
      const result = parseWranglerList<{ uuid: string; name: string }>(
        {
          status: 0,
          stdout: JSON.stringify([
            { success: true, result: [{ uuid: 'd1-123', name: 'unimailbox-db' }] },
          ]),
        },
        'd1-list',
      );

      expect(result).toEqual({ ok: true, data: [{ uuid: 'd1-123', name: 'unimailbox-db' }] });
    });

    it('treats an empty direct list as a valid empty result', () => {
      expect(parseWranglerList({ status: 0, stdout: '[]' }, 'd1-list')).toEqual({
        ok: true,
        data: [],
      });
    });
  });

  describe('ResourceState roundtrip', () => {
    const testStatePath = resolve(__dirname, '.tmp-resource-state-test.json');

    beforeEach(() => {
      if (existsSync(testStatePath)) {
        rmSync(testStatePath);
      }
    });

    it('saves and loads state correctly', () => {
      const state: ResourceState = {
        d1DatabaseId: 'd1-test-id',
        kvSetupSessionId: 'kv-setup-test',
        kvCacheId: 'kv-cache-test',
        r2Bucket: 'unimailbox-attachments',
        queue: 'unimailbox-outbound',
        secretsStoreId: 'ss-test-id',
        secrets: {
          installationToken: true,
          credentialEncryptionKey: true,
          betterAuthSecret: true,
        },
      };

      saveResourceState(state, testStatePath);
      const loaded = loadResourceState(testStatePath);

      expect(loaded).toEqual(state);
    });

    it('handles empty state', () => {
      const empty: ResourceState = {};
      saveResourceState(empty, testStatePath);
      const loaded = loadResourceState(testStatePath);

      expect(loaded).toEqual({});
    });

    it('handles partial state', () => {
      const partial: ResourceState = {
        d1DatabaseId: 'd1-partial',
        secrets: {
          installationToken: true,
          credentialEncryptionKey: false,
          betterAuthSecret: false,
        },
      };

      saveResourceState(partial, testStatePath);
      const loaded = loadResourceState(testStatePath);

      expect(loaded.d1DatabaseId).toBe('d1-partial');
      expect(loaded.secrets?.installationToken).toBe(true);
      expect(loaded.secrets?.credentialEncryptionKey).toBe(false);
      expect(loaded.kvSetupSessionId).toBeUndefined();
    });
  });

  // CAP-039 — Pending-only migration logic. The pure function
  // `computePendingMigrations` is the testable kernel of
  // `scripts/deploy.ts:runRemoteMigrations`. The four cases below match
  // AC #10: (a) empty applied → all, (b) full applied → zero,
  // (c) partial → only gap, (d) ghost → exit 1.
  describe('computePendingMigrations (CAP-039)', () => {
    it('case (a): empty applied → all on-disk are pending', () => {
      const onDisk = ['0001_initial.sql', '0002_users.sql', '0003_messages.sql'];
      const applied: string[] = [];
      const { ghost, pending } = computePendingMigrations(onDisk, applied);
      expect(ghost).toEqual([]);
      expect(pending).toEqual(onDisk);
    });

    it('case (b): full applied → zero pending (repeat deploy is a no-op)', () => {
      const onDisk = ['0001_initial.sql', '0002_users.sql', '0003_messages.sql'];
      const applied = [...onDisk];
      const { ghost, pending } = computePendingMigrations(onDisk, applied);
      expect(ghost).toEqual([]);
      expect(pending).toEqual([]);
    });

    it('case (c): partial applied → only the gap is pending', () => {
      const onDisk = [
        '0001_initial.sql',
        '0002_users.sql',
        '0003_messages.sql',
        '0004_outbound.sql',
      ];
      const applied = ['0001_initial.sql', '0002_users.sql'];
      const { ghost, pending } = computePendingMigrations(onDisk, applied);
      expect(ghost).toEqual([]);
      expect(pending).toEqual(['0003_messages.sql', '0004_outbound.sql']);
    });

    it('case (d): ghost — applied has a name that is not on disk', () => {
      const onDisk = ['0001_initial.sql', '0002_users.sql'];
      const applied = ['0001_initial.sql', '0002_users.sql', '0099_ghost.sql'];
      const { ghost, pending } = computePendingMigrations(onDisk, applied);
      expect(ghost).toEqual(['0099_ghost.sql']);
      // Pending list still contains everything not in applied — but the
      // ghost check in runRemoteMigrations exits before we get to apply
      // them, so callers must gate on `ghost.length === 0` first.
      expect(pending).toEqual([]);
    });

    it('preserves the on-disk order in the pending list', () => {
      const onDisk = ['0003_third.sql', '0001_first.sql', '0002_second.sql'];
      const applied: string[] = [];
      const { pending } = computePendingMigrations(onDisk, applied);
      // Pending keeps input order — runRemoteMigrations sorts the input
      // before calling, but the function itself is order-stable so a
      // caller that pre-sorts gets deterministic output.
      expect(pending).toEqual(['0003_third.sql', '0001_first.sql', '0002_second.sql']);
    });
  });

  // CAP-039 AC #11 — the no-op log line in the remote runner uses the
  // same dialect as the local `scripts/db-migrate.ts:124`. Asserting
  // the prefix means a future regression in either runner shows up in
  // CI before it bites an operator.
  describe('no-op log line (CAP-039 AC #11)', () => {
    it('NO_PENDING_LOG_FORMAT starts with the db-migrate.ts prefix', () => {
      expect(NO_PENDING_LOG_FORMAT).toBe('No pending migrations');
    });

    it('db-migrate.ts uses the same prefix', () => {
      // Resolve db-migrate.ts relative to this test file.
      const dbMigratePath = resolve(__dirname, 'db-migrate.ts');
      const src = readFileSync(dbMigratePath, 'utf-8');
      // Look for the literal log line — `console.log(\`No pending migrations (...)\`)`.
      expect(src).toContain('No pending migrations');
      // And confirm it is followed by `(${migrations.length} already applied)`
      // so the format is the same dialect the deploy script mirrors.
      expect(src).toMatch(/No pending migrations\s*\(\$\{migrations\.length\}\s*already applied\)/);
    });
  });

  // CAP-039 D7 / post-review MEDIUM — the parse-failure path of
  // `readRemoteApplied` is the fresh-DB entry point. Without this test
  // a future refactor could regress to exiting 1 on the missing-table
  // case and silently break every first deploy. Mirrors the local
  // runner's behaviour (`scripts/db-migrate.ts:98-101`).
  describe('parseAppliedMigrationNames (CAP-039 D7)', () => {
    it('returns parsed names on a successful wrangler batch', () => {
      const raw = JSON.stringify([
        {
          results: [{ name: '0001_initial.sql' }, { name: '0002_users.sql' }],
          success: true,
          meta: {},
        },
      ]);
      expect(parseAppliedMigrationNames(raw)).toEqual(['0001_initial.sql', '0002_users.sql']);
    });

    it('returns [] when wrangler reports success=false on a missing d1_migrations table (fresh DB)', () => {
      const raw = JSON.stringify([
        {
          success: false,
          error: 'D1_EXEC_ERROR: no such table: d1_migrations',
        },
      ]);
      expect(parseAppliedMigrationNames(raw)).toEqual([]);
    });

    it('throws on an unrelated parse failure (not the fresh-DB case)', () => {
      // Malformed JSON — the runner must NOT swallow this, otherwise a
      // genuine parse regression would silently treat the remote DB
      // as un-migrated.
      expect(() => parseAppliedMigrationNames('{not json')).toThrow(/JSON\.parse failed/);
    });

    it('throws on a success=false batch with a non-fresh-DB error', () => {
      const raw = JSON.stringify([{ success: false, error: 'D1_EXEC_ERROR: some other error' }]);
      expect(() => parseAppliedMigrationNames(raw)).toThrow(/some other error/);
    });
  });

  // CAP-042 (AC 11): deployment-time config guard. The committed
  // `wrangler.jsonc` ships with local-friendly defaults; the script
  // refuses to deploy them as-is to any non-local target. The pure
  // evaluator is the testable kernel of that refusal.
  describe('evaluateDeployConfigForTarget (CAP-042 AC 11)', () => {
    const localResolved = JSON.stringify({
      ENVIRONMENT: 'local',
      BETTER_AUTH_URL: 'http://localhost',
    });

    it('allows local defaults when the target is local', () => {
      const r = evaluateDeployConfigForTarget(localResolved, 'local');
      expect(r.ok).toBe(true);
    });

    it('refuses ENVIRONMENT=local when the target is preview', () => {
      const r = evaluateDeployConfigForTarget(localResolved, 'preview');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('ENVIRONMENT is "local"');
      expect(r.error).toContain('preview');
    });

    it('refuses ENVIRONMENT=local when the target is production', () => {
      const r = evaluateDeployConfigForTarget(localResolved, 'production');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('production');
    });

    it('refuses BETTER_AUTH_URL=http://localhost for any non-local target', () => {
      const resolved = JSON.stringify({
        ENVIRONMENT: 'preview',
        BETTER_AUTH_URL: 'http://localhost',
      });
      const r = evaluateDeployConfigForTarget(resolved, 'preview');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('http://localhost');
    });

    it('refuses a non-https BETTER_AUTH_URL for a non-local target', () => {
      const resolved = JSON.stringify({
        ENVIRONMENT: 'preview',
        BETTER_AUTH_URL: 'http://preview.example.com',
      });
      const r = evaluateDeployConfigForTarget(resolved, 'preview');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('https');
    });

    it('accepts an https BETTER_AUTH_URL for a non-local target', () => {
      const resolved = JSON.stringify({
        ENVIRONMENT: 'preview',
        BETTER_AUTH_URL: 'https://preview.example.com',
      });
      const r = evaluateDeployConfigForTarget(resolved, 'preview');
      expect(r.ok).toBe(true);
    });

    it('refuses a config environment that does not exactly match the target', () => {
      const resolved = JSON.stringify({
        ENVIRONMENT: 'staging',
        BETTER_AUTH_URL: 'https://preview.example.com',
      });
      const r = evaluateDeployConfigForTarget(resolved, 'preview');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('must match exactly');
    });

    it('refuses an unknown target even when the config string matches it', () => {
      const resolved = JSON.stringify({
        ENVIRONMENT: 'prod',
        BETTER_AUTH_URL: 'https://app.example.com',
      });
      const r = evaluateDeployConfigForTarget(resolved, 'prod');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('Unknown deploy target');
    });

    it('refuses when ENVIRONMENT is missing for a non-local target', () => {
      const resolved = JSON.stringify({ BETTER_AUTH_URL: 'https://app.example.com' });
      const r = evaluateDeployConfigForTarget(resolved, 'production');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('missing ENVIRONMENT');
    });

    it('refuses when BETTER_AUTH_URL is missing for a non-local target', () => {
      const resolved = JSON.stringify({ ENVIRONMENT: 'production' });
      const r = evaluateDeployConfigForTarget(resolved, 'production');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('missing BETTER_AUTH_URL');
    });
  });

  describe('parseMigrationVerificationOutput', () => {
    it('accepts one or more named passing assertions', () => {
      const raw = JSON.stringify([
        { results: [{ assertion: 'table_exists', pass: 1 }], success: true },
      ]);
      expect(parseMigrationVerificationOutput(raw, 'test.verify.sql')).toEqual({
        ok: true,
        assertions: [{ assertion: 'table_exists', pass: 1 }],
      });
    });

    it('rejects zero assertions instead of reporting a false green', () => {
      const raw = JSON.stringify([{ results: [], success: true }]);
      const result = parseMigrationVerificationOutput(raw, 'legacy.verify.sql');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('zero assertion rows');
    });

    it('rejects non-assertion rows even when another query returns a passing assertion', () => {
      const raw = JSON.stringify([
        { results: [{ assertion: 'table_exists', pass: 1 }], success: true },
        { results: [{ status: 'legacy output' }], success: true },
      ]);
      const result = parseMigrationVerificationOutput(raw, 'mixed.verify.sql');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('unexpected non-assertion row');
    });

    it('rejects malformed assertion rows and failed assertions', () => {
      const malformed = parseMigrationVerificationOutput(
        JSON.stringify([{ results: [{ assertion: 'broken', pass: '1' }], success: true }]),
        'bad.verify.sql',
      );
      expect(malformed.ok).toBe(false);

      const failed = parseMigrationVerificationOutput(
        JSON.stringify([{ results: [{ assertion: 'broken', pass: 0 }], success: true }]),
        'failed.verify.sql',
      );
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error).toContain('broken');
    });

    it('rejects failed Wrangler batches and invalid JSON', () => {
      expect(
        parseMigrationVerificationOutput(
          JSON.stringify([{ results: [], success: false, error: 'D1 failed' }]),
          'failed.verify.sql',
        ).ok,
      ).toBe(false);
      expect(parseMigrationVerificationOutput('{', 'invalid.verify.sql').ok).toBe(false);
    });
  });
});
