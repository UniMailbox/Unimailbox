// http/routes/setup — setup API routes.
// Hono sub-app for /api/v1/setup/* endpoints. GET /status, POST /claim, POST /preflight,
// POST /administrator, POST /domain, POST /cloudflare/dashboard-link, POST /cloudflare/verify,
// POST /inbound-smoke-test, POST /inbound-smoke-test/check, POST /brevo, POST /outbound-smoke-test,
// POST /complete.
//
// CAP-027 / ADR-004: All POST routes enforce Idempotency-Key. Actor is sha256_hex of the
// setup session token (or provided token for /claim). Best-effort mode: lookup before use case,
// record write after. /setup/outbound-smoke-test uses option C (pending → settle) to prevent
// double-send on retry.

import { Hono } from 'hono';
import {
  setupClaimRequestSchema,
  setupAdministratorRequestSchema,
  setupDomainRequestSchema,
  setupBrevoRequestSchema,
  isProviderError,
} from '@unimailbox/contracts';
import {
  claimSetup,
  getSetupStatus,
  runPreflight,
  createAdministrator,
  createDomainStep,
  getCloudflareDashboardLink,
  verifyCloudflareEmailRouting,
  startInboundSmokeTest,
  checkInboundSmokeTest,
  setupBrevo,
  runOutboundSmokeTest,
  completeSetup,
} from '../../modules/onboarding';
import { systemClock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';
import { readSecret } from '../../platform/secrets';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';
import { setupSession } from '../middleware/setup-session';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { parseJsonBody } from '../middleware/parse-json-body';
import { brevoAdapter } from '../../integrations/providers/brevo';
import {
  tryReplayIdempotency,
  sha256Hex,
  sqliteTimestamp,
  writeIdempotencyRecord,
  opaqueActorId,
  bearerToken,
  IDEMPOTENCY_PENDING_STATUS,
  IDEMPOTENCY_PENDING_BODY,
  prepareSettleIdempotencyRecord,
  prepareReleaseIdempotencyRecord,
  prepareCreateIdempotencyRecord,
  findIdempotencyRecord,
  assertSameRequestHash,
  isIdempotencyUniqueViolation,
  isPendingRecord,
  replayResponse,
} from '../../platform/idempotency';

// Operation strings for idempotency records (CAP-027 / ADR-004)
const CLAIM_OPERATION = 'POST /api/v1/setup/claim';
const PREFLIGHT_OPERATION = 'POST /api/v1/setup/preflight';
const ADMINISTRATOR_OPERATION = 'POST /api/v1/setup/administrator';
const DOMAIN_OPERATION = 'POST /api/v1/setup/domain';
const CLOUDFLARE_DASHBOARD_LINK_OPERATION = 'POST /api/v1/setup/cloudflare/dashboard-link';
const CLOUDFLARE_VERIFY_OPERATION = 'POST /api/v1/setup/cloudflare/verify';
const INBOUND_SMOKE_TEST_START_OPERATION = 'POST /api/v1/setup/inbound-smoke-test';
const INBOUND_SMOKE_TEST_CHECK_OPERATION = 'POST /api/v1/setup/inbound-smoke-test/check';
const BREVO_OPERATION = 'POST /api/v1/setup/brevo';
const OUTBOUND_SMOKE_TEST_OPERATION = 'POST /api/v1/setup/outbound-smoke-test';
const COMPLETE_OPERATION = 'POST /api/v1/setup/complete';

export function setupRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.get('/status', async (c) => {
    const status = await getSetupStatus(c.env.DB);
    return c.json({ data: status });
  });

  routes.post('/claim', requireIdempotencyKey, async (c) => {
    // Read raw body for hashing
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    // R-INPUT-002 / D-CAP-037-A: malformed JSON surfaces 400 INVALID_JSON
    // before any state change. /claim has no authenticated userId, so
    // actorUserId is omitted from the warn log.
    const body = parseJsonBody(rawBody, setupClaimRequestSchema, {
      event: 'setup.claim.invalid_json',
    });

    // Actor for /claim is sha256 of the provided token (R-SECRET-003)
    const actorId = await opaqueActorId('setup-session', body.token);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    // Secret-bearing endpoint (Fix 1): setup/claim returns a 30-minute session
    // token. Re-executing issues a fresh token; replaying would return a token
    // that may have expired or been revoked. Delete the old record and proceed.
    const existing = await findIdempotencyRecord(
      c.env.DB,
      actorId,
      CLAIM_OPERATION,
      idempotencyKey,
    );
    if (existing) {
      assertSameRequestHash(existing, requestHash);
      // Same key + same hash: delete the old record and re-execute.
      await c.env.DB.prepare(
        `DELETE FROM idempotency_records
           WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`,
      )
        .bind(actorId, CLAIM_OPERATION, idempotencyKey)
        .run();
    }

    const expectedToken = await readSecret(c.env.INSTALLATION_TOKEN);
    const result = await claimSetup(
      {
        db: c.env.DB,
        setupSessionStore: c.env.SETUP_SESSION,
        expectedToken,
        providedToken: body.token,
        // CAP-046 / D-CAP-046-A: thread the request-id the middleware
        // stamped onto this /claim request so the audit row carries it.
        requestId: c.get('requestId') ?? null,
      },
      { clock: systemClock, ids: systemIds },
    );

    // Write idempotency record after success (best-effort mode).
    // Fix 1 (R-SECRET-003): redact the session token from stored response.
    const successBody = JSON.stringify({ data: result });
    const redactedBody = JSON.stringify({
      data: { sessionToken: 'redacted' },
    });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: CLAIM_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseJson: redactedBody,
      createdAt: sqliteTimestamp(systemClock.now()),
    });

    return new Response(successBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // POST /preflight — session-protected endpoint that reports binding presence
  // and schema version. Requires a valid session token from /claim.
  routes.post('/preflight', setupSession, requireIdempotencyKey, async (c) => {
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    // Actor is sha256 of the session token
    const token = bearerToken(c.req.header('Authorization'));
    const actorId = await opaqueActorId('setup-session', token);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    const replay = await tryReplayIdempotency(
      c.env.DB,
      actorId,
      PREFLIGHT_OPERATION,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    // CAP-041 preflight hotfix: thread the request-id the middleware
    // stamped onto this /preflight request so the audit row inside
    // runPreflight carries it (R-AUDIT-001 + D-CAP-046-A — same shape
    // as /claim and /complete). The `advanced` flag is server-internal
    // and intentionally NOT surfaced in the response envelope (would be
    // a contract change to setupPreflightResponseSchema).
    const { bindings, schemaVersion } = await runPreflight(
      { db: c.env.DB, env: c.env, requestId: c.get('requestId') ?? null },
      { clock: systemClock, ids: systemIds },
    );

    const successBody = JSON.stringify({ data: { bindings, schemaVersion } });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: PREFLIGHT_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseJson: successBody,
      createdAt: sqliteTimestamp(systemClock.now()),
    });

    return new Response(successBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // POST /administrator — session-protected endpoint that creates the first user
  // (the initial administrator) with a PBKDF2-hashed password. After successful
  // creation, the installation step advances from 'administrator' to 'domain'.
  routes.post('/administrator', setupSession, requireIdempotencyKey, async (c) => {
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    const token = bearerToken(c.req.header('Authorization'));
    const actorId = await opaqueActorId('setup-session', token);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    const replay = await tryReplayIdempotency(
      c.env.DB,
      actorId,
      ADMINISTRATOR_OPERATION,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    // R-INPUT-002 / D-CAP-037-A: malformed JSON surfaces 400 INVALID_JSON
    // before any state change. /setup has no authenticated userId, so
    // actorUserId is omitted from the warn log.
    const body = parseJsonBody(rawBody, setupAdministratorRequestSchema, {
      event: 'setup.administrator.invalid_json',
    });
    const result = await createAdministrator(
      {
        db: c.env.DB,
        email: body.email,
        password: body.password,
        displayName: body.displayName ?? null,
      },
      { clock: systemClock, ids: systemIds },
    );

    // CAP-042 (AC 18): the use case now writes an `auth_accounts` row
    // in the same batch, but the response shape stays { data: { userId } }
    // — the existing wire contract — so we explicitly map the result.
    // The `credentialId` lives on the result for audit / test surfaces
    // but is not part of the operator-facing payload.
    const successBody = JSON.stringify({ data: { userId: result.userId } });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: ADMINISTRATOR_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseJson: successBody,
      createdAt: sqliteTimestamp(systemClock.now()),
    });

    return new Response(successBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // POST /domain — session-protected endpoint that creates a managed domain.
  // After successful creation, the installation step advances from 'domain' to 'cloudflare-verify'.
  routes.post('/domain', setupSession, requireIdempotencyKey, async (c) => {
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    const token = bearerToken(c.req.header('Authorization'));
    const actorId = await opaqueActorId('setup-session', token);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    const replay = await tryReplayIdempotency(
      c.env.DB,
      actorId,
      DOMAIN_OPERATION,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    // R-INPUT-002 / D-CAP-037-A: malformed JSON surfaces 400 INVALID_JSON
    // before any state change. /setup has no authenticated userId, so
    // actorUserId is omitted from the warn log.
    const body = parseJsonBody(rawBody, setupDomainRequestSchema, {
      event: 'setup.domain.invalid_json',
    });
    const result = await createDomainStep(
      {
        db: c.env.DB,
        name: body.name,
      },
      { clock: systemClock, ids: systemIds },
    );

    const successBody = JSON.stringify({ data: result });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: DOMAIN_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseJson: successBody,
      createdAt: sqliteTimestamp(systemClock.now()),
    });

    return new Response(successBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // POST /cloudflare/dashboard-link — session-protected endpoint that returns
  // an allowlisted Cloudflare dashboard URL. Does NOT advance the installation step.
  routes.post('/cloudflare/dashboard-link', setupSession, requireIdempotencyKey, async (c) => {
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    const token = bearerToken(c.req.header('Authorization'));
    const actorId = await opaqueActorId('setup-session', token);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    const replay = await tryReplayIdempotency(
      c.env.DB,
      actorId,
      CLOUDFLARE_DASHBOARD_LINK_OPERATION,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    const result = await getCloudflareDashboardLink();

    const successBody = JSON.stringify({ data: result });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: CLOUDFLARE_DASHBOARD_LINK_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseJson: successBody,
      createdAt: sqliteTimestamp(systemClock.now()),
    });

    return new Response(successBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // POST /cloudflare/verify — session-protected endpoint that confirms a managed
  // domain exists and advances the installation step to 'inbound-smoke'.
  // If no domain exists, returns 409 SETUP_DOMAIN_REQUIRED.
  routes.post('/cloudflare/verify', setupSession, requireIdempotencyKey, async (c) => {
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    const token = bearerToken(c.req.header('Authorization'));
    const actorId = await opaqueActorId('setup-session', token);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    const replay = await tryReplayIdempotency(
      c.env.DB,
      actorId,
      CLOUDFLARE_VERIFY_OPERATION,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    const result = await verifyCloudflareEmailRouting({ db: c.env.DB }, { clock: systemClock });

    const successBody = JSON.stringify({ data: result });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: CLOUDFLARE_VERIFY_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseJson: successBody,
      createdAt: sqliteTimestamp(systemClock.now()),
    });

    return new Response(successBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // POST /inbound-smoke-test — session-protected endpoint that starts the inbound
  // smoke test. Generates a unique smoke+<token>@<domain> address and stores the token in KV.
  // Returns { smokeTestAddress: "smoke+<token>@<domain>" }.
  routes.post('/inbound-smoke-test', setupSession, requireIdempotencyKey, async (c) => {
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    const token = bearerToken(c.req.header('Authorization'));
    const actorId = await opaqueActorId('setup-session', token);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    const replay = await tryReplayIdempotency(
      c.env.DB,
      actorId,
      INBOUND_SMOKE_TEST_START_OPERATION,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    const result = await startInboundSmokeTest(
      { db: c.env.DB, cache: c.env.CACHE },
      { ids: systemIds },
    );

    const successBody = JSON.stringify({ data: result });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: INBOUND_SMOKE_TEST_START_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseJson: successBody,
      createdAt: sqliteTimestamp(systemClock.now()),
    });

    return new Response(successBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // POST /inbound-smoke-test/check — session-protected endpoint that checks whether
  // the smoke test email has been received. Returns { status: "pending" | "received" }.
  // If received, advances the installation step to 'brevo'.
  routes.post('/inbound-smoke-test/check', setupSession, requireIdempotencyKey, async (c) => {
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    const token = bearerToken(c.req.header('Authorization'));
    const actorId = await opaqueActorId('setup-session', token);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    const replay = await tryReplayIdempotency(
      c.env.DB,
      actorId,
      INBOUND_SMOKE_TEST_CHECK_OPERATION,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    const result = await checkInboundSmokeTest(
      { db: c.env.DB, cache: c.env.CACHE },
      { clock: systemClock },
    );

    const successBody = JSON.stringify({ data: result });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: INBOUND_SMOKE_TEST_CHECK_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseJson: successBody,
      createdAt: sqliteTimestamp(systemClock.now()),
    });

    return new Response(successBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // POST /brevo — session-protected endpoint that validates and stores the Brevo
  // API key. Validates via Brevo API, encrypts with AES-GCM, stores credential and
  // connection, links to managed domain, and advances step to 'outbound-smoke'.
  routes.post('/brevo', setupSession, requireIdempotencyKey, async (c) => {
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    const token = bearerToken(c.req.header('Authorization'));
    const actorId = await opaqueActorId('setup-session', token);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    const replay = await tryReplayIdempotency(
      c.env.DB,
      actorId,
      BREVO_OPERATION,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    // R-INPUT-002 / D-CAP-037-A: malformed JSON surfaces 400 INVALID_JSON
    // before any state change. /setup has no authenticated userId, so
    // actorUserId is omitted from the warn log.
    const body = parseJsonBody(rawBody, setupBrevoRequestSchema, {
      event: 'setup.brevo.invalid_json',
    });
    const encryptionKey = await readSecret(c.env.CREDENTIAL_ENCRYPTION_KEY);
    const result = await setupBrevo(
      {
        db: c.env.DB,
        encryptionKey,
        apiKey: body.apiKey,
        adapter: brevoAdapter,
      },
      { clock: systemClock, ids: systemIds },
    );

    // Omit apiKey from response (R-SECRET-003) — setupBrevo already does this.
    const successBody = JSON.stringify({ data: result });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: BREVO_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseJson: successBody,
      createdAt: sqliteTimestamp(systemClock.now()),
    });

    return new Response(successBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  // POST /outbound-smoke-test — session-protected endpoint that sends a test email
  // via Brevo. Decrypts the stored API key, constructs a test message from
  // noreply@<domain> to the admin's email, sends it, and advances step to 'complete'.
  //
  // CAP-027 / ADR-004: Uses option (C) - inserts a pending idempotency record before
  // the Brevo call, then settles it after. This prevents double-send on retry.
  routes.post('/outbound-smoke-test', setupSession, requireIdempotencyKey, async (c) => {
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    const token = bearerToken(c.req.header('Authorization'));
    const actorId = await opaqueActorId('setup-session', token);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    // Check for existing record directly to handle the pending case without consuming Response body
    const existingRecord = await c.env.DB.prepare(
      `SELECT request_hash, response_status, response_json
         FROM idempotency_records
         WHERE actor_id = ? AND operation = ? AND idempotency_key = ?
           AND expires_at > datetime('now')
         LIMIT 1`,
    )
      .bind(actorId, OUTBOUND_SMOKE_TEST_OPERATION, idempotencyKey)
      .first<{ request_hash: string; response_status: number; response_json: string }>();

    if (existingRecord) {
      // Check if request hash matches (same body)
      if (existingRecord.request_hash === requestHash) {
        // Same hash - check if it's a pending record
        const parsedBody = JSON.parse(existingRecord.response_json) as { pending?: boolean };
        if (parsedBody.pending === true) {
          throw new DomainError({
            code: 'IDEMPOTENCY_REQUEST_PENDING',
            message: 'Idempotency key is pending from a previous request',
            httpStatus: 409,
          });
        }
        // Replay the stored response
        return new Response(existingRecord.response_json, {
          status: existingRecord.response_status,
          headers: { 'Content-Type': 'application/json' },
        });
      } else {
        // Different hash - this is IDEMPOTENCY_KEY_REUSED
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'Idempotency-Key reused with a different request body',
          httpStatus: 409,
        });
      }
    }

    // Insert a pending record BEFORE the Brevo call (option C)
    // This reserves the key so a concurrent or retried request won't send twice
    const pendingRecordId = systemIds.uuid();
    try {
      await prepareCreateIdempotencyRecord(c.env.DB, {
        id: pendingRecordId,
        actorId,
        operation: OUTBOUND_SMOKE_TEST_OPERATION,
        idempotencyKey,
        requestHash,
        responseStatus: IDEMPOTENCY_PENDING_STATUS,
        responseJson: IDEMPOTENCY_PENDING_BODY,
        createdAt: sqliteTimestamp(systemClock.now()),
      }).run();
    } catch (error) {
      // Fix 6: Handle UNIQUE-constraint race — two concurrent requests raced
      // to INSERT the pending record. Re-read the winner's row to determine
      // the response.
      if (isIdempotencyUniqueViolation(error)) {
        const winner = await findIdempotencyRecord(
          c.env.DB,
          actorId,
          OUTBOUND_SMOKE_TEST_OPERATION,
          idempotencyKey,
        );

        if (!winner) {
          // The row collided a moment ago but is gone now (TTL purge, or a
          // rolled-back sibling statement). Surface it rather than inventing a
          // response the client never received.
          throw new DomainError({
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'Concurrent request with the same Idempotency-Key is in flight',
            httpStatus: 409,
          });
        }

        assertSameRequestHash(winner, requestHash);
        // If it's still pending, report pending (Fix 6: reuse DomainError)
        if (isPendingRecord(winner)) {
          throw new DomainError({
            code: 'IDEMPOTENCY_REQUEST_PENDING',
            message: 'Idempotency key is pending from a previous request',
            httpStatus: 409,
          });
        }
        // Otherwise replay the settled response
        return replayResponse(winner);
      }
      throw error;
    }

    try {
      const encryptionKey = await readSecret(c.env.CREDENTIAL_ENCRYPTION_KEY);
      let result: Awaited<ReturnType<typeof runOutboundSmokeTest>>;
      try {
        result = await runOutboundSmokeTest(
          { db: c.env.DB, encryptionKey, adapter: brevoAdapter },
          { clock: systemClock, ids: systemIds },
        );
      } catch (error) {
        // CAP-029 D-CAP-028-A: provider errors now carry typed
        // RetryableProviderError / TerminalProviderError. The smoke-test
        // route surfaces every provider failure as 502 PROVIDER_SEND_FAILED
        // so the operator gets a single, actionable error code regardless
        // of the upstream HTTP status (4xx is terminal to the queue, but
        // here it is still "send failed from the operator's perspective").
        // CAP-029 L3 review-triage: attach the original error as `cause`
        // so the audit / log stream retains the underlying message and
        // stack for triage. The HTTP-layer envelope remains R-SECRET-003
        // compliant (the message is generic; the body / API key never
        // appear in the response).
        if (isProviderError(error)) {
          throw new DomainError({
            code: 'PROVIDER_SEND_FAILED',
            message: 'Brevo send failed',
            httpStatus: 502,
            cause: error,
          });
        }
        throw error;
      }

      // Settle the pending record with the actual response
      const successBody = JSON.stringify({ data: result });
      await prepareSettleIdempotencyRecord(c.env.DB, {
        actorId,
        operation: OUTBOUND_SMOKE_TEST_OPERATION,
        idempotencyKey,
        responseStatus: 200,
        responseJson: successBody,
      }).run();

      return new Response(successBody, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      // Release the pending record on failure so the operator can retry
      await prepareReleaseIdempotencyRecord(c.env.DB, {
        actorId,
        operation: OUTBOUND_SMOKE_TEST_OPERATION,
        idempotencyKey,
      }).run();
      throw error;
    }
  });

  // POST /complete — session-protected endpoint that marks installation as complete.
  // Sets status='complete' and current_step='complete'. After this, the setup gate
  // passes through to the app instead of redirecting to /setup.
  routes.post('/complete', setupSession, requireIdempotencyKey, async (c) => {
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    const token = bearerToken(c.req.header('Authorization'));
    const actorId = await opaqueActorId('setup-session', token);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    const replay = await tryReplayIdempotency(
      c.env.DB,
      actorId,
      COMPLETE_OPERATION,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    const result = await completeSetup(
      {
        db: c.env.DB,
        // CAP-046 / D-CAP-046-A: thread the request-id the middleware
        // stamped onto this /complete request so the audit row carries it.
        requestId: c.get('requestId') ?? null,
      },
      { clock: systemClock },
    );

    const successBody = JSON.stringify({ data: result });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: COMPLETE_OPERATION,
      idempotencyKey,
      requestHash,
      responseStatus: 200,
      responseJson: successBody,
      createdAt: sqliteTimestamp(systemClock.now()),
    });

    return new Response(successBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });

  return routes;
}
