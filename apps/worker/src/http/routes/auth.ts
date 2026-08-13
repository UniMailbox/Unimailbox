// http/routes/auth — CAP-019 user authentication.
// Hono sub-app for /api/v1/auth/* endpoints: register, login, refresh, me.
//
// R-AUTH-007: Access tokens stored in KV with 15-minute TTL.
// R-AUTH-008: Refresh tokens stored as SHA-256 hashes in sessions table.
// R-SECRET-003: Secrets (tokens, passwords) are never logged or returned in errors.
//
// CAP-027 / ADR-004: All POST routes enforce Idempotency-Key. Best-effort mode:
// lookup before use case, record write after.
//
// Public routes: register, login, refresh (no authn/requirePermission needed).
// Protected route: me (requires authn, which sets userId).

import { Hono } from 'hono';
import {
  registerRequestSchema,
  loginRequestSchema,
  refreshRequestSchema,
} from '@unimailbox/contracts';
import {
  findUserByEmail,
  createSession,
  findSessionByRefreshHash,
} from '../../modules/identity';
import {
  findKeyByCodeHash,
  prepareIncrementKeyUsage,
} from '../../modules/onboarding';
import { systemClock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';
import { verifyPassword, hashPassword } from '../../platform/crypto';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';
import { requireIdempotencyKey } from '../middleware/idempotency';
import {
  tryReplayIdempotency,
  sha256Hex,
  sqliteTimestamp,
  writeIdempotencyRecord,
  opaqueActorId,
  findIdempotencyRecord,
  assertSameRequestHash,
} from '../../platform/idempotency';

// Operation strings for idempotency records (CAP-027 / ADR-004)
const REGISTER_OPERATION = 'POST /api/v1/auth/register';
const LOGIN_OPERATION = 'POST /api/v1/auth/login';
const REFRESH_OPERATION = 'POST /api/v1/auth/refresh';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Hash a token with SHA-256 for storage.
 * Used for refresh tokens (never stored plaintext per R-SECRET-003).
 */
async function hashToken(token: string): Promise<string> {
  const buffer = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export function authRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * POST /api/v1/auth/register
   *
   * Register a new user with an invite code.
   *
   * - Validates the invite code (hash lookup, check expiry/revocation/usage)
   * - Creates user with PBKDF2-hashed password
   * - Assigns 'member' role
   * - Increments key usage
   * - All in one D1 batch for atomicity (R-OUTBOUND-006 pattern)
   *
   * CAP-027 / ADR-004: Idempotency-Key required. Actor is sha256_hex of the registration code.
   * Best-effort mode: lookup before use case, record write after.
   *
   * Returns 409 REGISTRATION_CODE_INVALID if code is invalid/expired/revoked/fully-used.
   * Returns 409 USER_EMAIL_TAKEN if email already exists.
   */
  routes.post('/register', requireIdempotencyKey, async (c) => {
    // Read raw body for hashing
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    // Extract minimal data for actorId before replay check (Fix 9: avoid re-validating stored replays)
    const rawBodyJson = JSON.parse(rawBody);
    const code = typeof rawBodyJson?.code === 'string' ? rawBodyJson.code : '';
    if (!code) {
      throw new DomainError({
        code: 'INVALID_REQUEST',
        message: 'code is required',
        httpStatus: 400,
      });
    }

    // Actor for register is sha256 of the registration code (R-SECRET-003)
    const actorId = await opaqueActorId('registration-code', code);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    // Lookup replay (before use case, before schema.parse)
    const replay = await tryReplayIdempotency(
      c.env.DB,
      actorId,
      REGISTER_OPERATION,
      idempotencyKey,
      requestHash,
    );
    if (replay) return replay;

    const body = registerRequestSchema.parse(rawBodyJson);

    // Hash the code to look up in the database (also used as actor_id for idempotency)
    const codeHash = await hashToken(body.code);

    // Look up the registration key
    const key = await findKeyByCodeHash(c.env.DB, codeHash);
    if (!key) {
      throw new DomainError({
        code: 'REGISTRATION_CODE_INVALID',
        message: 'Invalid registration code',
        httpStatus: 409,
      });
    }

    // Check if key is expired
    if (key.expires_at && new Date(key.expires_at) < systemClock.now()) {
      throw new DomainError({
        code: 'REGISTRATION_CODE_EXPIRED',
        message: 'Registration code has expired',
        httpStatus: 409,
      });
    }

    // Check if key is revoked
    if (key.revoked_at) {
      throw new DomainError({
        code: 'REGISTRATION_CODE_REVOKED',
        message: 'Registration code has been revoked',
        httpStatus: 409,
      });
    }

    // Check if key has reached max uses
    if (key.used_count >= key.max_uses) {
      throw new DomainError({
        code: 'REGISTRATION_CODE_EXHAUSTED',
        message: 'Registration code has been fully used',
        httpStatus: 409,
      });
    }

    // Check if email already exists
    const existingUser = await findUserByEmail(c.env.DB, body.email);
    if (existingUser) {
      throw new DomainError({
        code: 'USER_EMAIL_TAKEN',
        message: 'Email address is already registered',
        httpStatus: 409,
      });
    }

    // Hash the password
    const passwordHash = await hashPassword(body.password);

    // Prepare all D1 statements for the batch
    const now = systemClock.now().toISOString();
    const userId = systemIds.uuid();

    // 1. Insert user
    const userStmt = c.env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status,
        password_algorithm, password_iterations, password_salt, password_hash,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      userId,
      body.email,
      body.displayName ?? null,
      'active',
      passwordHash.algorithm,
      passwordHash.iterations,
      passwordHash.salt,
      passwordHash.hash,
      now,
      now,
    );

    // 2. Find the member role ID (seed role from CAP-017)
    const memberRoleResult = await c.env.DB
      .prepare(`SELECT id FROM roles WHERE name = 'member' LIMIT 1`)
      .first<{ id: string }>();

    if (!memberRoleResult) {
      throw new DomainError({
        code: 'ROLE_NOT_FOUND',
        message: 'Member role not found',
        httpStatus: 500,
      });
    }

    // 3. Assign member role to user
    const userRoleStmt = c.env.DB.prepare(
      `INSERT INTO user_roles (user_id, role_id, granted_at, granted_by)
       VALUES (?, ?, ?, NULL)`,
    ).bind(userId, memberRoleResult.id, now);

    // 4. Increment key usage
    const incrementStmt = prepareIncrementKeyUsage(c.env.DB).bind(key.id);

    // Execute all statements in a single batch
    await c.env.DB.batch([userStmt, userRoleStmt, incrementStmt]);

    // Return user info (without password)
    const successBody = JSON.stringify({
      data: {
        user: {
          id: userId,
          email: body.email,
          displayName: body.displayName ?? null,
        },
      },
    });

    // Write idempotency record after success (best-effort mode)
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: REGISTER_OPERATION,
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

  /**
   * POST /api/v1/auth/login
   *
   * Authenticate with email and password.
   *
   * - Finds user by email
   * - Verifies password with PBKDF2
   * - Generates access token (KV, 15-min TTL) and refresh token (sessions table, 30-day)
   * - Returns tokens and user info
   *
   * CAP-027 / ADR-004: Idempotency-Key required. Actor is sha256_hex of the login email.
   * Best-effort mode: lookup before use case, record write after.
   *
   * Returns 401 INVALID_CREDENTIALS for both wrong email and wrong password
   * (don't leak which factor failed per R-AUTH-008).
   */
  routes.post('/login', requireIdempotencyKey, async (c) => {
    // Read raw body for hashing
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    // Extract minimal data for actorId before replay check (Fix 9: avoid re-validating stored replays)
    const rawBodyJson = JSON.parse(rawBody);
    const email = typeof rawBodyJson?.email === 'string' ? rawBodyJson.email : '';
    if (!email) {
      throw new DomainError({
        code: 'INVALID_REQUEST',
        message: 'email is required',
        httpStatus: 400,
      });
    }

    // Actor for login is sha256 of the email (R-SECRET-003)
    const actorId = await opaqueActorId('email', email);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    // Secret-bearing endpoint (Fix 1): re-execute on replay rather than serving
    // stored tokens, which may have been revoked per R-AUTH-005. Delete the old
    // record and fall through to the use case to mint fresh credentials.
    const existing = await findIdempotencyRecord(
      c.env.DB,
      actorId,
      LOGIN_OPERATION,
      idempotencyKey,
    );
    if (existing) {
      assertSameRequestHash(existing, requestHash);
      // Same key + same hash: delete the old record and re-execute.
      await c.env.DB
        .prepare(
          `DELETE FROM idempotency_records
           WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`,
        )
        .bind(actorId, LOGIN_OPERATION, idempotencyKey)
        .run();
    }

    const body = loginRequestSchema.parse(rawBodyJson);

    // Find user by email
    const user = await findUserByEmail(c.env.DB, body.email);
    if (!user) {
      throw new DomainError({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
        httpStatus: 401,
      });
    }

    // Check user status
    if (user.status === 'banned') {
      throw new DomainError({
        code: 'USER_BANNED',
        message: 'User account is banned',
        httpStatus: 403,
      });
    }
    if (user.status === 'deleted') {
      throw new DomainError({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
        httpStatus: 401,
      });
    }

    // Verify password
    const storedHash = {
      algorithm: user.password_algorithm as 'pbkdf2-sha256',
      iterations: user.password_iterations,
      salt: new Uint8Array(user.password_salt),
      hash: new Uint8Array(user.password_hash),
    };
    const isValid = await verifyPassword(body.password, storedHash);
    if (!isValid) {
      throw new DomainError({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
        httpStatus: 401,
      });
    }

    // Generate tokens
    const accessToken = systemIds.uuid();
    const refreshToken = systemIds.uuid();
    const refreshTokenHash = await hashToken(refreshToken);

    // Calculate expiry times
    const now = systemClock.now();
    const accessTokenExpirySeconds = 15 * 60; // 15 minutes
    const refreshTokenExpirySeconds = 30 * 24 * 60 * 60; // 30 days
    const expiresAt = Math.floor(now.getTime() / 1000) + refreshTokenExpirySeconds;

    // Store access token in CACHE KV with 15-minute TTL
    await c.env.CACHE.put(
      `auth:${accessToken}`,
      JSON.stringify({ userId: user.id }),
      { expirationTtl: accessTokenExpirySeconds },
    );

    // Create session in D1
    const sessionId = systemIds.uuid();
    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For');
    const userAgent = c.req.header('User-Agent');
    await createSession(c.env.DB, {
      id: sessionId,
      userId: user.id,
      refreshTokenHash,
      expiresAt,
      ...(ip !== undefined && { ip }),
      ...(userAgent !== undefined && { userAgent }),
      createdAt: now.toISOString(),
    });

    // Return tokens and user info
    const successBody = JSON.stringify({
      data: {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
        },
      },
    });

    // Write idempotency record after success (best-effort mode).
    // Fix 1 (R-SECRET-003): redact tokens from the stored response — replay
    // re-executes, so serving plaintext tokens would return dead credentials.
    const redactedBody = JSON.stringify({
      data: {
        accessToken: 'redacted',
        refreshToken: 'redacted',
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
        },
      },
    });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: LOGIN_OPERATION,
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

  /**
   * POST /api/v1/auth/refresh
   *
   * Refresh an access token using a refresh token.
   *
   * - Validates refresh token (hash lookup, check expiry/revocation)
   * - Generates new access token (KV, 15-min TTL)
   * - Returns new access token
   *
   * CAP-027 / ADR-004: Idempotency-Key required. Actor is sha256_hex of the refresh token.
   * Best-effort mode: lookup before use case, record write after.
   *
   * Returns 401 REFRESH_TOKEN_INVALID if token is invalid/expired/revoked.
   */
  routes.post('/refresh', requireIdempotencyKey, async (c) => {
    // Read raw body for hashing
    const rawBody = await c.req.text();
    const requestHash = await sha256Hex(rawBody);

    // Extract minimal data for actorId before replay check (Fix 9: avoid re-validating stored replays)
    const rawBodyJson = JSON.parse(rawBody);
    const refreshToken = typeof rawBodyJson?.refreshToken === 'string' ? rawBodyJson.refreshToken : '';
    if (!refreshToken) {
      throw new DomainError({
        code: 'INVALID_REQUEST',
        message: 'refreshToken is required',
        httpStatus: 400,
      });
    }

    // Actor for refresh is sha256 of the refresh token (R-SECRET-003)
    const actorId = await opaqueActorId('refresh-token', refreshToken);

    const idempotencyKey = c.get('idempotencyKey');
    if (!idempotencyKey) {
      throw new DomainError({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header required',
        httpStatus: 400,
      });
    }

    // Secret-bearing endpoint (Fix 1): re-execute on replay rather than serving
    // a stored token that may have been revoked per R-AUTH-005. Delete the old
    // record and fall through to the use case to mint a fresh access token.
    const existing = await findIdempotencyRecord(
      c.env.DB,
      actorId,
      REFRESH_OPERATION,
      idempotencyKey,
    );
    if (existing) {
      assertSameRequestHash(existing, requestHash);
      // Same key + same hash: delete the old record and re-execute.
      await c.env.DB
        .prepare(
          `DELETE FROM idempotency_records
           WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`,
        )
        .bind(actorId, REFRESH_OPERATION, idempotencyKey)
        .run();
    }

    const body = refreshRequestSchema.parse(rawBodyJson);

    // Hash the refresh token to look up in the database
    const tokenHash = await hashToken(body.refreshToken);

    // Find the session
    const session = await findSessionByRefreshHash(c.env.DB, tokenHash);
    if (!session) {
      throw new DomainError({
        code: 'REFRESH_TOKEN_INVALID',
        message: 'Invalid or expired refresh token',
        httpStatus: 401,
      });
    }

    // Check if session is expired
    const now = Math.floor(systemClock.now().getTime() / 1000);
    if (session.expires_at < now) {
      throw new DomainError({
        code: 'REFRESH_TOKEN_EXPIRED',
        message: 'Refresh token has expired',
        httpStatus: 401,
      });
    }

    // Generate new access token
    const accessToken = systemIds.uuid();
    const accessTokenExpirySeconds = 15 * 60; // 15 minutes

    // Store new access token in CACHE KV
    await c.env.CACHE.put(
      `auth:${accessToken}`,
      JSON.stringify({ userId: session.user_id }),
      { expirationTtl: accessTokenExpirySeconds },
    );

    // Return new access token
    const successBody = JSON.stringify({
      data: {
        accessToken,
      },
    });

    // Write idempotency record after success (best-effort mode).
    // Fix 1 (R-SECRET-003): redact accessToken from the stored response.
    const redactedBody = JSON.stringify({
      data: {
        accessToken: 'redacted',
      },
    });
    await writeIdempotencyRecord(c.env.DB, {
      id: systemIds.uuid(),
      actorId,
      operation: REFRESH_OPERATION,
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

  /**
   * GET /api/v1/auth/me
   *
   * Get current user info.
   *
   * Requires authn (sets userId from Authorization header).
   * Returns user info without password.
   *
   * Returns 401 AUTHENTICATION_REQUIRED if no valid token.
   */
  routes.get('/me', async (c) => {
    const userId = c.get('userId');

    if (!userId) {
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    }

    // Find user by ID
    const user = await c.env.DB
      .prepare(
        `SELECT id, email, display_name FROM users WHERE id = ? AND status = 'active'`,
      )
      .bind(userId)
      .first<{ id: string; email: string; display_name: string | null }>();

    if (!user) {
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    }

    return c.json({
      data: {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
        },
      },
    });
  });

  return routes;
}
