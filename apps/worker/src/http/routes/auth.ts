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
  loginRequestSchema,
  refreshRequestSchema,
  changePasswordRequestSchema,
} from '@unimailbox/contracts';
import {
  findUserByEmail,
  findUserById,
  createSession,
  findSessionByRefreshHash,
  prepareUpdatePassword,
} from '../../modules/identity';
import { systemClock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';
import { hashPassword, verifyPassword } from '../../platform/crypto';
import { hasAdministrativePermission } from '../../modules/admin';
import { DomainError } from '../../platform/errors';
import { logger } from '../../platform/logger';
import type { AppEnv } from '../../platform/env';
import { requireIdempotencyKey } from '../middleware/idempotency';
import {
  sha256Hex,
  sqliteTimestamp,
  writeIdempotencyRecord,
  opaqueActorId,
  findIdempotencyRecord,
  assertSameRequestHash,
} from '../../platform/idempotency';

// Operation strings for idempotency records (CAP-027 / ADR-004)
const LOGIN_OPERATION = 'POST /api/v1/auth/login';
const REFRESH_OPERATION = 'POST /api/v1/auth/refresh';
const REFRESH_COOKIE_NAME = 'unimailbox_refresh';
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Hash a token with SHA-256 for storage.
 * Used for refresh tokens (never stored plaintext per R-SECRET-003).
 */
async function hashToken(token: string): Promise<string> {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie');
  if (header === null) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    if (key !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function refreshCookie(token: string, request: Request): string {
  const secure = new URL(request.url).protocol === 'https:';
  return [
    `${REFRESH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/api/v1/auth',
    'SameSite=Lax',
    `Max-Age=${REFRESH_TOKEN_TTL_SECONDS}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

function clearRefreshCookie(request: Request): string {
  const secure = new URL(request.url).protocol === 'https:';
  return [
    `${REFRESH_COOKIE_NAME}=`,
    'HttpOnly',
    'Path=/api/v1/auth',
    'SameSite=Lax',
    'Max-Age=0',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
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
  // Public registration is intentionally closed. Accounts are created by
  // the admin user-management API; registration keys are retained only as a
  // migration artifact and are not accepted by the runtime.
  routes.post('/register', async () => {
    throw new DomainError({
      code: 'REGISTRATION_DISABLED',
      message: 'Account creation is managed by an administrator',
      httpStatus: 403,
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

    // Extract minimal data for actorId before replay check (Fix 9: avoid re-validating stored replays).
    // D-CAP-031-C: see /register — local try/catch is required so the helper's
    // schema validation does not run before the replay lookup.
    let rawBodyJson: unknown;
    try {
      rawBodyJson = JSON.parse(rawBody);
    } catch (error) {
      if (error instanceof SyntaxError) {
        // R-LOG-001: never log the body bytes. /login has no
        // authenticated userId, so actorUserId is omitted (TS2379).
        logger.warn({ event: 'auth.login.invalid_json' });
        throw new DomainError({
          code: 'INVALID_JSON',
          message: 'Request body is not valid JSON',
          httpStatus: 400,
        });
      }
      throw error;
    }
    const email =
      typeof (rawBodyJson as { email?: unknown })?.email === 'string'
        ? (rawBodyJson as { email: string }).email
        : '';
    if (!email) {
      // Post-parse required-field guard (D-CAP-031-C / Fix 9). The
      // email is extracted before schema.parse so the actorId hash
      // can be computed before the replay lookup. A missing field
      // is a 400 validation error.
      throw new DomainError({
        code: 'VALIDATION_ERROR',
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
      await c.env.DB.prepare(
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

    if (
      user.must_change_password === 1 &&
      user.initial_password_expires_at !== null &&
      user.initial_password_expires_at <= sqliteTimestamp(systemClock.now())
    ) {
      throw new DomainError({
        code: 'INITIAL_PASSWORD_EXPIRED',
        message: 'Initial password has expired; ask an administrator to reset it',
        httpStatus: 403,
      });
    }

    // Generate tokens
    const accessToken = systemIds.uuid();
    const refreshToken = systemIds.uuid();
    const refreshTokenHash = await hashToken(refreshToken);

    // Calculate expiry times
    const now = systemClock.now();
    const accessTokenExpirySeconds = 15 * 60; // 15 minutes
    const expiresAt = Math.floor(now.getTime() / 1000) + REFRESH_TOKEN_TTL_SECONDS;

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
      createdAt: sqliteTimestamp(now),
    });

    // Store access token in CACHE KV with 15-minute TTL. The D1 session id
    // lets authn reject a token immediately after reset/deactivation.
    await c.env.CACHE.put(`auth:${accessToken}`, JSON.stringify({ userId: user.id, sessionId }), {
      expirationTtl: accessTokenExpirySeconds,
    });

    const canAccessAdmin = await hasAdministrativePermission(c.env.DB, user.id);

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
        mustChangePassword: user.must_change_password === 1,
        canAccessAdmin,
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
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': refreshCookie(refreshToken, c.req.raw),
      },
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

    // Extract minimal data for actorId before replay check (Fix 9: avoid re-validating stored replays).
    // D-CAP-031-C: see /register — local try/catch is required so the helper's
    // schema validation does not run before the replay lookup.
    let rawBodyJson: unknown;
    try {
      rawBodyJson = rawBody.trim() === '' ? {} : JSON.parse(rawBody);
    } catch (error) {
      if (error instanceof SyntaxError) {
        // R-LOG-001: never log the body bytes. /refresh has no
        // authenticated userId, so actorUserId is omitted (TS2379).
        logger.warn({ event: 'auth.refresh.invalid_json' });
        throw new DomainError({
          code: 'INVALID_JSON',
          message: 'Request body is not valid JSON',
          httpStatus: 400,
        });
      }
      throw error;
    }
    const refreshTokenFromBody =
      typeof (rawBodyJson as { refreshToken?: unknown })?.refreshToken === 'string'
        ? (rawBodyJson as { refreshToken: string }).refreshToken
        : '';
    const refreshToken = refreshTokenFromBody || readCookie(c.req.raw, REFRESH_COOKIE_NAME) || '';
    if (!refreshToken) {
      // Post-parse required-field guard (D-CAP-031-C / Fix 9). The
      // refreshToken is extracted before schema.parse so the actorId
      // hash can be computed before the replay lookup. A missing
      // credential is absent, so return a stable authentication code.
      throw new DomainError({
        code: 'REFRESH_TOKEN_REQUIRED',
        message: 'Refresh token required',
        httpStatus: 401,
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
      await c.env.DB.prepare(
        `DELETE FROM idempotency_records
           WHERE actor_id = ? AND operation = ? AND idempotency_key = ?`,
      )
        .bind(actorId, REFRESH_OPERATION, idempotencyKey)
        .run();
    }

    const body = refreshRequestSchema.parse({
      ...(typeof rawBodyJson === 'object' && rawBodyJson !== null ? rawBodyJson : {}),
      refreshToken,
    });

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
    const sessionUser = await findUserById(c.env.DB, session.user_id);
    if (!sessionUser || sessionUser.status !== 'active') {
      throw new DomainError({
        code: 'REFRESH_TOKEN_INVALID',
        message: 'Invalid or expired refresh token',
        httpStatus: 401,
      });
    }

    await c.env.CACHE.put(
      `auth:${accessToken}`,
      JSON.stringify({ userId: session.user_id, sessionId: session.id }),
      {
        expirationTtl: accessTokenExpirySeconds,
      },
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
      headers: {
        'Content-Type': 'application/json',
        'Set-Cookie': refreshCookie(refreshToken, c.req.raw),
      },
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
    const user = await c.env.DB.prepare(
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

    const canAccessAdmin = await hasAdministrativePermission(c.env.DB, userId);

    return c.json({
      data: {
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name,
        },
        mustChangePassword: c.get('mustChangePassword') === true,
        canAccessAdmin,
      },
    });
  });

  routes.post('/logout', async (c) => {
    const userId = c.get('userId');
    const sessionId = c.get('sessionId');
    const authHeader = c.req.header('Authorization');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : '';
    // Logout is intentionally idempotent. Even if the short-lived access
    // token has expired, clear the refresh cookie so a later reload cannot
    // silently restore the session. When identity is available, revoke the
    // corresponding D1 session and KV access token as well.
    if (userId && sessionId) {
      await c.env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?`)
        .bind(sqliteTimestamp(systemClock.now()), sessionId, userId)
        .run();
      // authn already established a live token. Unauthenticated logout only
      // clears the cookie; missing keys need no delete and revoked entries
      // are already unusable through D1 and disappear with their KV TTL.
      if (token !== '') await c.env.CACHE.delete(`auth:${token}`);
    }
    return new Response(null, {
      status: 204,
      headers: { 'Set-Cookie': clearRefreshCookie(c.req.raw) },
    });
  });

  /**
   * POST /api/v1/auth/change-password
   *
   * This is the only business endpoint available to a session that still has
   * `must_change_password=1`. The current session remains usable after the
   * change; every other session is revoked in the same D1 batch.
   */
  routes.post('/change-password', requireIdempotencyKey, async (c) => {
    const userId = c.get('userId');
    const sessionId = c.get('sessionId');
    if (!userId || !sessionId) {
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new DomainError({
        code: 'INVALID_JSON',
        message: 'Request body is not valid JSON',
        httpStatus: 400,
      });
    }
    const parsed = changePasswordRequestSchema.parse(body);
    const user = await findUserById(c.env.DB, userId);
    if (!user || user.status !== 'active') {
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    }

    const valid = await verifyPassword(parsed.currentPassword, {
      algorithm: user.password_algorithm as 'pbkdf2-sha256',
      iterations: user.password_iterations,
      salt: new Uint8Array(user.password_salt),
      hash: new Uint8Array(user.password_hash),
    });
    if (!valid) {
      throw new DomainError({
        code: 'INVALID_CREDENTIALS',
        message: 'Current password is invalid',
        httpStatus: 401,
      });
    }

    const password = await hashPassword(parsed.newPassword);
    const updatedAt = sqliteTimestamp(systemClock.now());
    const update = prepareUpdatePassword(c.env.DB, {
      userId,
      passwordAlgorithm: password.algorithm,
      passwordIterations: password.iterations,
      passwordSalt: password.salt,
      passwordHash: password.hash,
      updatedAt,
      mustChangePassword: false,
      initialPasswordExpiresAt: null,
    });
    const revokeOthers = c.env.DB.prepare(
      `UPDATE sessions SET revoked_at = ?
         WHERE user_id = ? AND id != ? AND revoked_at IS NULL`,
    ).bind(updatedAt, userId, sessionId);
    await c.env.DB.batch([update, revokeOthers]);

    return c.json({ data: { changed: true } });
  });

  return routes;
}
