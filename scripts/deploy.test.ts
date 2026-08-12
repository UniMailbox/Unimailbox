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
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  resolveConfigTemplate,
  generateSecret,
  checkEnvironmentGuard,
  loadResourceState,
  saveResourceState,
  computeSecretAction,
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

      const resolved = resolveConfigTemplate(mockTemplate, state);

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

      const resolved = resolveConfigTemplate(mockTemplate, state);

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

      const resolved = resolveConfigTemplate(alreadyResolved, state);

      // Should not change anything (placeholders already gone)
      expect(resolved).toContain('real-d1-id');
      expect(resolved).toContain('real-kv-setup-id');
      expect(resolved).toContain('real-kv-cache-id');
      expect(resolved).toContain('real-ss-id');
      expect(resolved).not.toContain('d1-abc123');
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
      expect(result.error).toContain("(unset)");
      expect(result.error).toContain("must be non-'local'");
    });

    it('rejects local environment', () => {
      const result = checkEnvironmentGuard('local');
      expect(result.ok).toBe(false);
      expect(result.error).toContain("ENVIRONMENT=local");
      expect(result.error).toContain("must be non-'local'");
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
});
