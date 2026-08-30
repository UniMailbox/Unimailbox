// preflight.worker.test.ts — POST /api/v1/setup/preflight.
//
// Worker-pool tests for the preflight endpoint. Uses SELF.fetch to exercise
// the full request pipeline through the real entrypoint, router, and middleware.
//
// Tests cover:
// - Valid session → 200 with binding report and schema version
// - No Authorization header → 401 SETUP_SESSION_REQUIRED
// - Invalid session token → 401 SETUP_SESSION_INVALID
// - All 7 bindings reported as present
// - Schema version from d1_migrations table

import { describe, expect, it, beforeEach } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import { resetAndMigrate } from '@unimailbox/test-kit';
import { CURRENT_SCHEMA_VERSION } from '@unimailbox/contracts';

describe('POST /api/v1/setup/preflight', () => {
  let sessionToken: string;

  // Helper: claim a session before each test
  async function claimSession(): Promise<string> {
    const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
      method: 'POST',
      body: JSON.stringify({ token: 'test-installation-token' }),
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'test-claim-session-key',
      },
    });

    if (response.status !== 200) {
      throw new Error(`Failed to claim session: ${response.status}`);
    }

    const body = await response.json();
    return body.data.sessionToken;
  }

  describe('valid session token', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('returns 200 with binding report and schema version', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-preflight-key',
        },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/^application\/json\b/);

      const body = await response.json();
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('bindings');
      expect(body.data).toHaveProperty('schemaVersion');
    });

    it('reports all 8 bindings as present', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-preflight-key',
        },
      });

      const body = await response.json();
      const { bindings } = body.data;

      // All 8 bindings should be present and true.
      // CAP-042 (AC 11): BETTER_AUTH_SECRET is an independent binding read
      // through readSecret() in preflight.ts. The test pool provides a
      // plain-string value (apps/worker/wrangler.test.jsonc), and
      // readSecret() handles both forms.
      expect(bindings).toEqual({
        DB: true,
        ATTACHMENTS: true,
        SETUP_SESSION: true,
        CACHE: true,
        OUTBOUND: true,
        INSTALLATION_TOKEN: true,
        CREDENTIAL_ENCRYPTION_KEY: true,
        BETTER_AUTH_SECRET: true,
      });

      // Exactly 8 keys
      expect(Object.keys(bindings).length).toBe(8);
    });

    it('reports schema version from d1_migrations', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-preflight-key',
        },
      });

      const body = await response.json();
      expect(body.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    });

    it('returns the success envelope { data: T }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-preflight-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();

      // Envelope must have a `data` key.
      expect(body).toHaveProperty('data');
      // And no other top-level keys.
      expect(Object.keys(body)).toEqual(['data']);
    });
  });

  describe('no Authorization header', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 SETUP_SESSION_REQUIRED', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-preflight-key',
        },
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
      expect(body.error.message).toBe('Authorization header required');
    });

    it('returns error envelope { error: { code, message } }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-preflight-key',
        },
      });

      const body = await response.json();

      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(Object.keys(body)).toEqual(['error']);
    });
  });

  describe('invalid session token', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 SETUP_SESSION_INVALID', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-preflight-key',
          Authorization: 'Bearer invalid-token',
        },
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body).toHaveProperty('error');
      expect(body.error.code).toBe('SETUP_SESSION_INVALID');
      expect(body.error.message).toBe('Invalid or expired session');
    });

    it('returns error envelope { error: { code, message } }', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-preflight-key',
          Authorization: 'Bearer invalid-token',
        },
      });

      const body = await response.json();

      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('code');
      expect(body.error).toHaveProperty('message');
      expect(Object.keys(body)).toEqual(['error']);
    });
  });

  describe('malformed Authorization header', () => {
    beforeEach(resetAndMigrate);

    it('returns 401 for "Bearer" prefix without token', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-preflight-key',
          Authorization: 'Bearer',
        },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
    });

    it('returns 401 SETUP_SESSION_REQUIRED for "Bearer " (trailing space stripped)', async () => {
      // HTTP trims trailing whitespace from header values, so 'Bearer ' becomes
      // 'Bearer', which does not match startsWith('Bearer ') → REQUIRED.
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-preflight-key',
          Authorization: 'Bearer ',
        },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
    });

    it('returns 401 for token without "Bearer" prefix', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-preflight-key',
          Authorization: 'some-token',
        },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error.code).toBe('SETUP_SESSION_REQUIRED');
    });
  });

  describe('setup gate exemption', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('is NOT 302-redirected by the setup gate (exempt path)', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-preflight-key',
          Authorization: `Bearer ${sessionToken}`,
        },
        redirect: 'manual',
      });

      // Should succeed, not redirect
      expect(response.status).toBe(200);
      expect(response.headers.get('Location')).toBeNull();
    });
  });

  describe('/status and /claim remain public (no session required)', () => {
    beforeEach(resetAndMigrate);

    it('GET /status works without Authorization header', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/status');

      expect(response.status).toBe(200);
    });

    it('POST /claim works without Authorization header', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/claim', {
        method: 'POST',
        body: JSON.stringify({ token: 'test-installation-token' }),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'test-claim-session-key',
        },
      });

      expect(response.status).toBe(200);
    });
  });

  describe('idempotency (CAP-027 / ADR-004)', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      sessionToken = await claimSession();
    });

    it('returns 400 IDEMPOTENCY_KEY_REQUIRED when Idempotency-Key is missing', async () => {
      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: { Authorization: `Bearer ${sessionToken}` },
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    });

    it('replays the stored response when same key + same body', async () => {
      const idempotencyKey = 'test-preflight-key-abc123';

      const response1 = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response1.status).toBe(200);
      const body1 = await response1.json();

      // Second request with same key should replay
      const response2 = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });

      expect(response2.status).toBe(200);
      const body2 = await response2.json();
      // Should return the same bindings and schema version
      expect(body2.data.bindings).toEqual(body1.data.bindings);
      expect(body2.data.schemaVersion).toBe(body1.data.schemaVersion);
    });
  });

  // ---------------------------------------------------------------------------
  // CAP-041 preflight hotfix — atomic advance (R-WORKFLOW-002 + R-AUDIT-001).
  // ---------------------------------------------------------------------------
  //
  // Each test starts from a clean DB + claimed session so installation_state
  // exists at current_step='preflight' (the value claimSetup seeds). The
  // tests then exercise each branch of the all-green / not-all-green matrix
  // and assert on both the DB row state and the audit_events count.

  /**
   * Returns the current_step of the single installation_state row, or null
   * if the row does not exist (the route only runs after /claim, which
   * always seeds the row, so callers should not see null).
   */
  async function currentInstallationStep(): Promise<string | null> {
    const row = await env.DB
      .prepare('SELECT current_step FROM installation_state WHERE id = 1')
      .first<{ current_step: string }>();
    return row?.current_step ?? null;
  }

  /**
   * Counts audit_events rows whose action matches the filter. Used to prove
   * R-AUDIT-001 (the advance emits exactly one row when it advances; zero
   * rows when it does not).
   */
  async function countAuditEvents(action: string): Promise<number> {
    const row = await env.DB
      .prepare('SELECT COUNT(*) AS n FROM audit_events WHERE action = ?')
      .bind(action)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  describe('CAP-041 hotfix — atomic preflight advance', () => {
    beforeEach(async () => {
      await resetAndMigrate();
      // CAP-041 follow-up (D-CAP-041-H3): wrangler.test.jsonc's
      // INSTALLATION_TOKEN is the literal `test-installation-token` —
      // every test fixture sends the same value. No per-test override
      // needed.
      sessionToken = await claimSession();
    });

    // AC-2: All bindings present AND schema matches → 200, state advances
    // preflight → administrator, exactly one `setup.preflight.complete`
    // audit row carrying the requestId the middleware stamped on the
    // /preflight request (R-WORKFLOW-002 + R-AUDIT-001).
    it('AC-2 all-green advance emits one audit row and advances state', async () => {
      expect(await currentInstallationStep()).toBe('preflight');

      const before = await countAuditEvents('setup.preflight.complete');

      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-preflight-ac2-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.bindings).toMatchObject({
        DB: true,
        INSTALLATION_TOKEN: true,
        BETTER_AUTH_SECRET: true,
      });
      expect(body.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
      // The `advanced` flag is server-internal and must NOT leak into the
      // response envelope (setupPreflightResponseSchema is a fixed contract).
      expect(body.data).not.toHaveProperty('advanced');

      expect(await currentInstallationStep()).toBe('administrator');

      const after = await countAuditEvents('setup.preflight.complete');
      expect(after - before).toBe(1);

      // R-AUDIT-001: the audit row carries the requestId the middleware
      // stamped on the HTTP request so logs/traces can correlate the
      // advance with the originating call.
      const audit = await env.DB
        .prepare(
          `SELECT actor_user_id, action, resource_type, request_id
             FROM audit_events WHERE action = 'setup.preflight.complete'`,
        )
        .first<{
          actor_user_id: string | null;
          action: string;
          resource_type: string;
          request_id: string | null;
        }>();
      expect(audit).not.toBeNull();
      expect(audit?.actor_user_id).toBeNull();
      expect(audit?.action).toBe('setup.preflight.complete');
      expect(audit?.resource_type).toBe('system');
      expect(audit?.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    // AC-3: Missing binding (BETTER_AUTH_SECRET cleared) → 200 with
    // bindings.<name>=false, current_step unchanged, ZERO new audit rows.
    it('AC-3 missing binding does not advance and does not write an audit row', async () => {
      // Remove BETTER_AUTH_SECRET from the test pool so checkSecret() fails.
      const originalSecret = env.BETTER_AUTH_SECRET;
      // Setting to undefined makes !!env.BETTER_AUTH_SECRET evaluate to false
      // and makes readSecret() throw — both prongs of the binding check
      // should report missing.
      (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET = undefined;
      try {
        expect(await currentInstallationStep()).toBe('preflight');
        const before = await countAuditEvents('setup.preflight.complete');

        const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${sessionToken}`,
            'Idempotency-Key': 'test-preflight-ac3-key',
          },
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.data.bindings.BETTER_AUTH_SECRET).toBe(false);
        // Object-store bindings are still present — only the secret fails.
        expect(body.data.bindings.DB).toBe(true);

        expect(await currentInstallationStep()).toBe('preflight');
        const after = await countAuditEvents('setup.preflight.complete');
        expect(after - before).toBe(0);
      } finally {
        (env as { BETTER_AUTH_SECRET?: string }).BETTER_AUTH_SECRET = originalSecret;
      }
    });

    // AC-4: Schema drift — top d1_migrations row rewritten to a
    // non-matching value → 200, current_step unchanged, no audit row.
    it('AC-4 schema drift does not advance and does not write an audit row', async () => {
      // Replace the top migration row with a name whose prefix does NOT
      // match CURRENT_SCHEMA_VERSION. The preflight's d1_migrations read
      // is `ORDER BY id DESC LIMIT 1`, so UPDATE the highest-id row in
      // place — preserves the desc-order invariant without resorting to
      // DELETE + re-INSERT.
      await env.DB
        .prepare(
          `UPDATE d1_migrations
             SET name = '0099_drift.sql'
             WHERE id = (SELECT id FROM d1_migrations ORDER BY id DESC LIMIT 1)`,
        )
        .run();

      expect(await currentInstallationStep()).toBe('preflight');
      const before = await countAuditEvents('setup.preflight.complete');

      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-preflight-ac4-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.schemaVersion).not.toBe(CURRENT_SCHEMA_VERSION);
      expect(body.data.bindings.DB).toBe(true);

      expect(await currentInstallationStep()).toBe('preflight');
      const after = await countAuditEvents('setup.preflight.complete');
      expect(after - before).toBe(0);
    });

    // AC-5: Re-running preflight when current_step is already
    // 'administrator' is a no-op. Conditional UPDATE matches zero rows
    // so no audit row is written. We simulate the post-advance state
    // by updating installation_state directly (mirrors what an operator
    // sees after a successful preflight that advanced, before they
    // ever navigate to /setup/administrator). UPDATE — not the
    // test-kit's `seedInstallationState` INSERT — because claimSession()
    // above already seeded the row at 'preflight' (UNIQUE PK on id=1).
    it('AC-5 re-applying preflight when already advanced is a no-op', async () => {
      await env.DB
        .prepare(
          `UPDATE installation_state
             SET current_step = ?, updated_at = ?
             WHERE id = 1`,
        )
        .bind('administrator', '2026-01-01 00:00:00')
        .run();

      expect(await currentInstallationStep()).toBe('administrator');
      const before = await countAuditEvents('setup.preflight.complete');

      const response = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': 'test-preflight-ac5-key',
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.bindings.DB).toBe(true);
      expect(body.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);

      expect(await currentInstallationStep()).toBe('administrator');
      const after = await countAuditEvents('setup.preflight.complete');
      expect(after - before).toBe(0);
    });

    // AC-6: Idempotency replay (same key + same body) returns the
    // stored response WITHOUT re-running the use case, so no second
    // audit_events row is written. The audit-count-delta check alone
    // is insufficient — a re-run that hits the conditional predicate
    // (state already `administrator`) would also produce zero new
    // audit rows. We assert response body equality to prove the
    // idempotency layer replayed the cached response rather than
    // re-running the use case.
    it('AC-6 idempotent replay does not write a second audit row and returns the identical body', async () => {
      const idempotencyKey = 'test-preflight-ac6-key';
      expect(await currentInstallationStep()).toBe('preflight');

      const response1 = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });
      expect(response1.status).toBe(200);
      const body1 = await response1.json();
      const afterFirst = await countAuditEvents('setup.preflight.complete');
      expect(afterFirst).toBe(1);
      expect(await currentInstallationStep()).toBe('administrator');

      // Same key + same body → replay (no use-case re-execution).
      const response2 = await SELF.fetch('http://localhost/api/v1/setup/preflight', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${sessionToken}`,
          'Idempotency-Key': idempotencyKey,
        },
      });
      expect(response2.status).toBe(200);
      const body2 = await response2.json();

      // Body equality (R-INBOUND-004 / Idempotency seam): the second
      // call returns the exact stored response. If usePreflight ran
      // again, `clock.now()` would move forward and the audit row's
      // `created_at` would shift; body equality proves the replay.
      expect(body2).toEqual(body1);

      const afterSecond = await countAuditEvents('setup.preflight.complete');
      expect(afterSecond).toBe(afterFirst);
    });
  });
});
