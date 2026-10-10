// apps/worker/scripts/doctor.test.ts — CAP-003 self-test.
// Spawns `pnpm scaffold doctor` and asserts the exit code is 0 on the
// current repo state. Catches regressions to the doctor script's CLI.
//
// CAP-039 — Deployment substrate: extended to exercise the three new
// doctor checks (web-assets-binding, queue-consumer-topology,
// migration-strategy-pending-only) against synthetic wrangler.jsonc
// fixtures. The evaluators are exported from scripts/doctor.ts so the
// tests drive them directly without mutating the real wrangler config.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  evaluateWebAssetsBinding,
  evaluateQueueConsumerTopology,
  evaluateMigrationStrategyPendingOnly,
  evaluateMigrationCompanionSources,
  evaluateWranglerBindings,
  parseJsonc,
  type R,
} from '../../scripts/doctor';

const REPO = new URL('../../..', import.meta.url).pathname;

describe('pnpm scaffold doctor', () => {
  it('exits 0 on the current repo state', () => {
    const result = spawnSync('pnpm', ['scaffold', 'doctor'], {
      cwd: REPO,
      encoding: 'utf-8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    expect(result.status, result.stderr || result.stdout).toBe(0);
  });
});

describe('JSONC parsing', () => {
  it('accepts trailing commas added by the configured formatter', () => {
    expect(
      parseJsonc(`{
        // production-like JSONC
        "assets": {
          "run_worker_first": ["/api/*",],
        },
      }`),
    ).toEqual({ assets: { run_worker_first: ['/api/*'] } });
  });

  it('preserves commas and comment markers inside strings', () => {
    expect(parseJsonc('{"value":"comma, brace }, // not a comment",}')).toEqual({
      value: 'comma, brace }, // not a comment',
    });
  });

  it('rejects malformed JSONC instead of merging tokens across a block comment', () => {
    expect(() => parseJsonc('{"max_retries":5/* gap */0}')).toThrow(SyntaxError);
  });

  it('rejects an unterminated block comment', () => {
    expect(() => parseJsonc('{"max_retries":5} /*')).toThrow(SyntaxError);
  });
});

// CAP-039 — each new check is a pure function over a parsed
// wrangler.jsonc object. The fixtures below cover both the passing shape
// and each one-character mutation that should flip the check to FAIL.
describe('CAP-039 — deployment substrate doctor checks', () => {
  const repoRoot = REPO.replace(/\/$/, '');

  // Synthetic passing config — what the real wrangler.jsonc looks like.
  const passingProd = {
    assets: {
      directory: '../web/dist',
      binding: 'ASSETS',
      not_found_handling: 'none',
      run_worker_first: ['/api', '/api/*', '/healthz', '/healthz/*', '/readyz'],
    },
    queues: {
      producers: [{ queue: 'unimailbox-outbound' }],
      consumers: [{ queue: 'unimailbox-outbound', max_retries: 5 }],
    },
    d1_databases: [{ binding: 'DB', database_name: 'unimailbox-db', database_id: 'abc' }],
  } as Record<string, unknown>;

  const passingTest = {
    queues: {
      producers: [{ queue: 'test-outbound' }],
      consumers: [{ queue: 'test-outbound', max_retries: 5 }],
    },
  } as Record<string, unknown>;

  describe('web-assets-binding', () => {
    it('passes on a synthetic config that mirrors the real one', () => {
      const r = evaluateWebAssetsBinding(passingProd, repoRoot);
      expect(r).toEqual<R>({ name: 'web-assets-binding', ok: true });
    });

    it('fails when the assets block is missing', () => {
      const r = evaluateWebAssetsBinding({}, repoRoot);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('assets');
      expect(r.name).toBe('web-assets-binding');
    });

    it('fails when assets.binding is not "ASSETS"', () => {
      const mutated = {
        ...passingProd,
        assets: { ...(passingProd.assets as object), binding: 'WRONG' },
      };
      const r = evaluateWebAssetsBinding(mutated, repoRoot);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('WRONG');
    });

    it('fails when not_found_handling is missing', () => {
      const mutated = {
        ...passingProd,
        assets: { ...(passingProd.assets as object), not_found_handling: undefined },
      };
      const r = evaluateWebAssetsBinding(mutated, repoRoot);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('not_found_handling');
    });

    it('fails when /healthz is not worker-first', () => {
      const mutated = {
        ...passingProd,
        assets: { ...(passingProd.assets as object), run_worker_first: ['/api/*'] },
      };
      const r = evaluateWebAssetsBinding(mutated, repoRoot);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('/healthz');
    });
  });

  describe('queue-consumer-topology', () => {
    it('passes when producer and consumer queue names match and counts match', () => {
      const r = evaluateQueueConsumerTopology(passingProd, passingTest);
      expect(r).toEqual<R>({ name: 'queue-consumer-topology', ok: true });
    });

    it('fails when a producer has no matching consumer', () => {
      const mutated = {
        ...passingProd,
        queues: {
          producers: [{ queue: 'orphan' }],
          consumers: [{ queue: 'unimailbox-outbound', max_retries: 5 }],
        },
      };
      const r = evaluateQueueConsumerTopology(mutated, passingTest);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('producers without matching consumer');
      expect(r.detail).toContain('orphan');
    });

    it('fails when a consumer has no matching producer', () => {
      const mutated = {
        ...passingProd,
        queues: { producers: [], consumers: [{ queue: 'orphan', max_retries: 5 }] },
      };
      const r = evaluateQueueConsumerTopology(mutated, passingTest);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('consumers without matching producer');
    });

    it('fails when a consumer is missing max_retries', () => {
      const mutated = {
        ...passingProd,
        queues: {
          producers: [{ queue: 'unimailbox-outbound' }],
          consumers: [{ queue: 'unimailbox-outbound' }],
        },
      };
      const r = evaluateQueueConsumerTopology(mutated, passingTest);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('consumers missing max_retries');
    });

    it('fails when the test config has fewer producers than production', () => {
      const r = evaluateQueueConsumerTopology(passingProd, {
        queues: { producers: [], consumers: [{ queue: 'test-outbound', max_retries: 5 }] },
      } as Record<string, unknown>);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('test.jsonc has 0 producers');
    });

    // CAP-039 D6 — disjointness check. When the same queue name appears
    // in both configs (e.g. someone renames the test queue to match
    // the production queue but forgets the test pool will then drain
    // production-side messages), disjointness fails. The original
    // passing fixture is naturally disjoint (`unimailbox-outbound` vs
    // `test-outbound`); the mutation below forces an overlap.
    it('fails when a queue name appears in both prod and test configs (rename drift)', () => {
      const mutatedTest = {
        ...passingTest,
        queues: {
          producers: [{ queue: 'unimailbox-outbound' }],
          consumers: [{ queue: 'unimailbox-outbound', max_retries: 5 }],
        },
      };
      const r = evaluateQueueConsumerTopology(passingProd, mutatedTest);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('queue name drift');
      expect(r.detail).toContain('unimailbox-outbound');
    });
  });

  describe('migration-strategy-pending-only', () => {
    it('passes on a synthetic config without apply_migrations or migrations_dir', () => {
      const r = evaluateMigrationStrategyPendingOnly(passingProd);
      expect(r).toEqual<R>({ name: 'migration-strategy-pending-only', ok: true });
    });

    it('fails when top-level apply_migrations: true is set', () => {
      const mutated = { ...passingProd, apply_migrations: true };
      const r = evaluateMigrationStrategyPendingOnly(mutated);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('apply_migrations');
    });

    it('fails when d1_databases[0].migrations_dir is set', () => {
      const mutated = {
        ...passingProd,
        d1_databases: [
          { ...(passingProd.d1_databases as object[])[0], migrations_dir: '../../migrations' },
        ],
      };
      const r = evaluateMigrationStrategyPendingOnly(mutated);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('migrations_dir');
      expect(r.detail).toContain('d1_databases[0]');
    });

    it('passes when migrations_dir is absent on every d1 entry', () => {
      const mutated = {
        ...passingProd,
        d1_databases: [{ ...(passingProd.d1_databases as object[])[0] }],
      };
      const r = evaluateMigrationStrategyPendingOnly(mutated);
      expect(r.ok).toBe(true);
    });
  });

  // CAP-042 (AC 11): the wrangler-bindings check now compares the full
  // binding/var name set across three surfaces:
  //   1. apps/worker/wrangler.jsonc (production)
  //   2. apps/worker/wrangler.test.jsonc (worker-pool tests)
  //   3. apps/worker/src/platform/env.ts (typed Env surface)
  // Drift between any two is a blocking finding. The pure evaluator is
  // `evaluateWranglerBindings`; the fixtures below mirror the real
  // three surfaces so a regression on any name surfaces immediately.
  describe('wrangler-bindings (self-managed authentication)', () => {
    const requiredEnvKeys = new Set([
      'DB',
      'ATTACHMENTS',
      'SETUP_SESSION',
      'CACHE',
      'OUTBOUND',
      'ASSETS',
      'INSTALLATION_TOKEN',
      'CREDENTIAL_ENCRYPTION_KEY',
      'ENVIRONMENT',
    ]);

    const fullProd: Record<string, unknown> = {
      d1_databases: [{ binding: 'DB' }],
      r2_buckets: [{ binding: 'ATTACHMENTS' }],
      kv_namespaces: [{ binding: 'SETUP_SESSION' }, { binding: 'CACHE' }],
      queues: { producers: [{ binding: 'OUTBOUND' }] },
      secrets_store_secrets: [
        { binding: 'INSTALLATION_TOKEN' },
        { binding: 'CREDENTIAL_ENCRYPTION_KEY' },
      ],
      assets: { binding: 'ASSETS' },
      vars: {
        ENVIRONMENT: 'local',
      },
    };

    const fullTest: Record<string, unknown> = {
      d1_databases: [{ binding: 'DB' }],
      r2_buckets: [{ binding: 'ATTACHMENTS' }],
      kv_namespaces: [{ binding: 'SETUP_SESSION' }, { binding: 'CACHE' }],
      queues: { producers: [{ binding: 'OUTBOUND' }] },
      assets: { binding: 'ASSETS' },
      vars: {
        ENVIRONMENT: 'local',
        INSTALLATION_TOKEN: 'x',
        CREDENTIAL_ENCRYPTION_KEY: 'x',
      },
    };

    it('passes when every required name appears in all three surfaces', () => {
      const r = evaluateWranglerBindings(fullProd, fullTest, requiredEnvKeys);
      expect(r).toEqual<R>({ name: 'wrangler-bindings', ok: true });
    });

    it('fails when wrangler.jsonc omits CREDENTIAL_ENCRYPTION_KEY', () => {
      const prod = {
        ...fullProd,
        secrets_store_secrets: [{ binding: 'INSTALLATION_TOKEN' }],
      };
      const r = evaluateWranglerBindings(prod, fullTest, requiredEnvKeys);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('wrangler.jsonc missing');
      expect(r.detail).toContain('CREDENTIAL_ENCRYPTION_KEY');
    });

    it('fails when wrangler.test.jsonc omits CREDENTIAL_ENCRYPTION_KEY', () => {
      const test = {
        ...fullTest,
        vars: {
          ENVIRONMENT: 'local',
          INSTALLATION_TOKEN: 'x',
        },
      };
      const r = evaluateWranglerBindings(fullProd, test, requiredEnvKeys);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('wrangler.test.jsonc missing');
      expect(r.detail).toContain('CREDENTIAL_ENCRYPTION_KEY');
    });

    it('fails when env.ts omits CACHE', () => {
      const envKeys = new Set([...requiredEnvKeys]);
      envKeys.delete('CACHE');
      const r = evaluateWranglerBindings(fullProd, fullTest, envKeys);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('env.ts missing');
      expect(r.detail).toContain('CACHE');
    });

    it('allows production config without legacy auth variables', () => {
      const prod = {
        ...fullProd,
        vars: { ENVIRONMENT: 'local' },
      };
      const r = evaluateWranglerBindings(prod, fullTest, requiredEnvKeys);
      expect(r.ok).toBe(true);
    });

    it('reports every drift in a single failure detail', () => {
      const prod = { ...fullProd, vars: { ENVIRONMENT: 'local' } };
      const test = { ...fullTest, vars: { ENVIRONMENT: 'local' } };
      const r = evaluateWranglerBindings(prod, test, requiredEnvKeys);
      expect(r.ok).toBe(false);
      expect(r.detail).toContain('INSTALLATION_TOKEN');
      expect(r.detail).toContain('CREDENTIAL_ENCRYPTION_KEY');
    });
  });
});

describe('migration companion assertion contract', () => {
  it('accepts named assertion/pass queries', () => {
    expect(
      evaluateMigrationCompanionSources({
        '0001_ok.verify.sql': "SELECT 'table_exists' AS assertion, 1 AS pass;",
      }),
    ).toEqual<R>({ name: 'migrations-present', ok: true });
  });

  it('rejects legacy SELECT output that the runner would otherwise ignore', () => {
    const result = evaluateMigrationCompanionSources({
      '0001_bad.verify.sql': "SELECT 'looks fine' AS status;",
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('0001_bad.verify.sql');
    expect(result.detail).toContain('assertion/pass');
  });
});
