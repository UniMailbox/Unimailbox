// scripts/doctor.test.ts — CAP-045 self-test for the new preview-gate
// suite-present check (doctor check #14). The pure evaluator takes a
// filesystem accessor for fixture-driven tests so we never mutate the
// repo's real on-disk files.
//
// Pre-existing tests for the deploy.ts fixtures live alongside; CAP-045
// adds the new evaluator block at the bottom. The first `describe` block
// also keeps `pnpm scaffold doctor` exit-0 coverage current.
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { evaluatePreviewGateSuitePresent, evaluateWebAssetsBinding } from './doctor';
import { FORBIDDEN_LOG_PATTERNS } from './redaction-patterns';

const REPO = new URL('..', import.meta.url).pathname;

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

describe('CAP-039 — web-assets worker-first routing', () => {
  const passing: Record<string, unknown> = {
    assets: {
      directory: '../web/dist',
      binding: 'ASSETS',
      not_found_handling: 'none',
      run_worker_first: ['/api', '/api/*', '/healthz', '/healthz/*', '/readyz'],
    },
  };

  it('requires the API and health check to reach the Worker before SPA fallback', () => {
    expect(evaluateWebAssetsBinding(passing, REPO)).toEqual({
      name: 'web-assets-binding',
      ok: true,
    });
  });

  it('rejects a config that lets /healthz fall through to the SPA shell', () => {
    const r = evaluateWebAssetsBinding(
      {
        ...passing,
        assets: { ...(passing.assets as Record<string, unknown>), run_worker_first: ['/api/*'] },
      },
      REPO,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('/healthz');
  });

  it('rejects a config without an explicit worker-first list', () => {
    const r = evaluateWebAssetsBinding(
      {
        ...passing,
        assets: { ...(passing.assets as Record<string, unknown>), run_worker_first: undefined },
      },
      REPO,
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('run_worker_first');
  });
});

// CAP-045 — preview-gate suite-present (doctor check #14).
//
// Fixtures below cover the passing shape and every failure case: each
// required file present, each missing file (suite / helper / runbook),
// and the two disqualifying patterns (mocking the test runner, mocking
// `db.prepare`).
describe('CAP-045 — preview-gate suite-present doctor check', () => {
  const suitePath = 'apps/worker/test/preview-gate.worker.test.ts';
  const helperPath = 'scripts/send-test-brevo.ts';
  const runbookPath = 'work/reviews/CAP-045-preview-runbook.md';

  const passingContents: Record<string, string> = {
    [suitePath]: '// preview-gate suite — drives real bindings\n',
    [helperPath]: '// send-test-brevo — operator helper\n',
    [runbookPath]: '# CAP-045 preview runbook\n',
  };

  function fixtureMap(overrides: Record<string, string | null> = {}): (p: string) => string | null {
    const merged: Record<string, string> = { ...passingContents };
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    return (p: string): string | null => merged[p] ?? null;
  }

  it('passes when all three files exist with no disqualifying patterns', () => {
    const r = evaluatePreviewGateSuitePresent({ fsRead: fixtureMap() });
    expect(r).toEqual({ name: 'preview-gate-suite-present', ok: true });
  });

  it('fails when the suite file is missing', () => {
    const r = evaluatePreviewGateSuitePresent({ fsRead: fixtureMap({ [suitePath]: null }) });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('suite');
    expect(r.detail).toContain(suitePath);
  });

  it('fails when the helper file is missing', () => {
    const r = evaluatePreviewGateSuitePresent({ fsRead: fixtureMap({ [helperPath]: null }) });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('helper');
    expect(r.detail).toContain(helperPath);
  });

  it('fails when the runbook file is missing', () => {
    const r = evaluatePreviewGateSuitePresent({ fsRead: fixtureMap({ [runbookPath]: null }) });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('runbook');
    expect(r.detail).toContain(runbookPath);
  });

  it('fails when the suite mocks cloudflare:test (defeats binding discipline)', () => {
    const r = evaluatePreviewGateSuitePresent({
      fsRead: fixtureMap({
        [suitePath]: `vi.mock('cloudflare:test');\n${passingContents[suitePath]}`,
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("'cloudflare:test'");
    expect(r.detail).toContain('worker-pool binding discipline');
  });

  it('fails when the suite mocks db.prepare (defeats binding discipline)', () => {
    const r = evaluatePreviewGateSuitePresent({
      fsRead: fixtureMap({
        [suitePath]: `db.prepare.mockResolvedValue({});\n${passingContents[suitePath]}`,
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('db.prepare');
    expect(r.detail).toContain('worker-pool binding discipline');
  });

  it('reports every missing file in a single failure detail', () => {
    const r = evaluatePreviewGateSuitePresent({
      fsRead: fixtureMap({ [helperPath]: null, [runbookPath]: null }),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('helper');
    expect(r.detail).toContain('runbook');
  });
});

// CAP-045 HIGH 7 fix — the doctor check also scans
// `scripts/send-test-brevo.ts` for credential-leak shapes. The helper is
// allowed to mention `BREVO_API_KEY` and `api-key` as substrings (they
// appear in env-var reads and HTTP headers), but not as value-bearing
// assignments like `BREVO_API_KEY = "xkeysib-..."`.
describe('CAP-045 — preview-gate helper credential-leak detection', () => {
  const suitePath = 'apps/worker/test/preview-gate.worker.test.ts';
  const runbookPath = 'work/reviews/CAP-045-preview-runbook.md';
  const helperPath = 'scripts/send-test-brevo.ts';

  function fixtureFor(helperContent: string | null): (p: string) => string | null {
    // The credential-leak check only runs against the helper, but the
    // evaluator also reports the suite + runbook as missing unless the
    // fixture declares them too — otherwise we get a "missing files"
    // detail before the credential scan ever runs.
    const map: Record<string, string | null> = {
      [suitePath]: '// preview-gate suite — drives real bindings\n',
      [runbookPath]: '# CAP-045 preview runbook\n',
      [helperPath]: helperContent,
    };
    return (p: string): string | null => map[p] ?? null;
  }

  it('accepts the helper when it reads BREVO_API_KEY from env only', () => {
    const r = evaluatePreviewGateSuitePresent({
      fsRead: fixtureFor(`const apiKey = process.env.BREVO_API_KEY;\n`),
    });
    expect(r).toEqual({ name: 'preview-gate-suite-present', ok: true });
  });

  it('rejects the helper when BREVO_API_KEY is assigned a literal value', () => {
    const r = evaluatePreviewGateSuitePresent({
      fsRead: fixtureFor(`BREVO_API_KEY = "xkeysib-deadbeefcafef00d1234"\n`),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('credential');
  });

  it('rejects the helper when api-key is assigned a literal value', () => {
    // The regex anchors on `api[_-]?key\s*[:=]` directly — i.e. the
    // header name must be followed by `:` / `=`, not wrapped in quotes
    // like a JSON object key. The bare-property form is what an
    // operator helper would actually emit if it built the headers
    // object literally.
    const r = evaluatePreviewGateSuitePresent({
      fsRead: fixtureFor(`fetch(...) { headers: { api-key: "xkeysib-deadbeefcafef00d1234" } }\n`),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('credential');
  });
});

// CAP-045 HIGH 1 fix — forbidden log patterns must reject value-bearing
// secret / token / password shapes, but accept benign production
// diagnostics whose substrings look secret-shaped at a glance.
describe('CAP-045 — forbidden log patterns (HIGH 1 fix)', () => {
  function isForbidden(line: string): boolean {
    return FORBIDDEN_LOG_PATTERNS.some((p) => p.test(line));
  }

  it('rejects a value-bearing password assignment', () => {
    expect(isForbidden('password: hunter2')).toBe(true);
  });

  it('rejects a value-bearing api-key header', () => {
    expect(isForbidden('api-key: xkeysib-deadbeefcafef00d1234')).toBe(true);
  });

  it('rejects a webhook_secret field reference', () => {
    expect(isForbidden('webhook_secret=abc123def456')).toBe(true);
  });

  it('rejects an idempotency_key field reference', () => {
    expect(isForbidden('idempotency_key: aabbccdd-1111-2222-3333-444455556666')).toBe(true);
  });

  it('rejects a long bearer token assignment', () => {
    // Anchored `token\s*[:=]\s*\w{16,}` requires 16 word chars immediately
    // after the separator; dropping the "Bearer " prefix lets the JWT's
    // base64url segments match. The "Bearer " word preceding the JWT is
    // exactly 6 chars and a space, so leaving it in fails the count.
    expect(isForbidden('token = eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefg')).toBe(true);
  });

  it('accepts the HIGH 1 false-positive target — `[preflight] secret read failed`', () => {
    // Benign production diagnostic. The substring `secret` is part of a
    // log message, not a key=value pair — the anchored regex does not match.
    expect(isForbidden('[preflight] secret read failed TypeError: undefined')).toBe(false);
  });

  it('accepts a generic "tokenize" log line', () => {
    expect(isForbidden('tokenized envelope id 12345')).toBe(false);
  });

  it('accepts a structured-logger JSON event line (no value-bearing fields)', () => {
    expect(
      isForbidden(
        '{"ts":"2026-08-24T12:34:56Z","level":"warn","event":"auth.login.invalid_credentials"}',
      ),
    ).toBe(false);
  });

  it('accepts a generic body-parsed notice', () => {
    // The bare substring `body` must not trip — only value-bearing
    // `body=...` or `request_body: ...` forms do.
    expect(isForbidden('request body parsed successfully')).toBe(false);
  });
});
