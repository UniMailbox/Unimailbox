// http/routes/admin-users — CAP-044 Slice 3 (AC 17). Hono sub-app for
// the admin users-list API.
//
// GET /api/v1/admin/users — keyset cursor pagination over the identity
// module's users table (newest first), consumed by the web admin Users
// page.
//
// D-CAP-044-H: the users table is identity-owned; this route calls the
// identity module's public `listUsers` through the allowed
// admin → identity edge — the only new module code in identity for this
// slice. No cross-module table access.
//
// R-AUTHZ-001/002: requires the closed-enum 'user.read' permission,
// checked against the database per request via requirePermission.
// R-AUTHZ-005: the permission rides roles, never a hardcoded identity
// list.
// R-SECRET-003 / AC 16: the response carries NO credential material —
// the repository enumerates exactly the five non-credential columns and
// the contracts schema is .strict(), so a leaked password column cannot
// parse client-side either. Asserted by a dedicated worker test that
// walks every key of the serialized JSON against
// /password|salt|hash|credential|secret|token/i (the users table's
// credential columns are password_algorithm, password_iterations,
// password_salt, password_hash — none may ever leave the repository).

import { Hono } from 'hono';
import { requirePermission } from '../middleware/authz';
import {
  listUsers,
  UserCursorInvalidError,
  UserRowInvalidError,
  prepareCreateManagedUser,
  findUserById,
  prepareUpdatePassword,
  prepareUpdateUserStatus,
} from '../../modules/identity';
import {
  adminCreateUserRequestSchema,
  adminUserStatusRequestSchema,
  userListQueryParamsSchema,
  uuidSchema,
} from '@unimailbox/contracts';
import { parseCursorSigningKey } from '../../platform/config';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';
import { hashPassword } from '../../platform/crypto';
import { systemClock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';
import { requireIdempotencyKey } from '../middleware/idempotency';
import { parseJsonBody } from '../middleware/parse-json-body';
import {
  sha256Hex,
  findIdempotencyRecord,
  assertSameRequestHash,
  sqliteTimestamp,
  prepareCreateIdempotencyRecord,
  isIdempotencyUniqueViolation,
  replayAfterRace,
} from '../../platform/idempotency';
import { prepareCreateAuditEvent } from '../../modules/admin';

const INITIAL_PASSWORD_TTL_MS = 24 * 60 * 60 * 1000;
const CREATE_USER_OPERATION = 'POST /api/v1/admin/users';

function generateInitialPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `um_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;
}

function initialPasswordExpiry(): string {
  return sqliteTimestamp(new Date(systemClock.now().getTime() + INITIAL_PASSWORD_TTL_MS));
}

function requireUuid(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new DomainError({
      code: 'VALIDATION_ERROR',
      message: 'User id must be a UUID',
      httpStatus: 400,
    });
  }
  return parsed.data;
}

async function rejectOneTimePasswordReplay(
  db: D1Database,
  actorId: string,
  operation: string,
  idempotencyKey: string,
  requestHash: string,
  message: string,
): Promise<never> {
  const winner = await findIdempotencyRecord(db, actorId, operation, idempotencyKey);
  if (!winner) {
    throw new DomainError({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'Concurrent request with this Idempotency-Key is in flight',
      httpStatus: 409,
    });
  }
  assertSameRequestHash(winner, requestHash);
  // Stored responses deliberately redact generated initial passwords. A
  // competing request must never receive a 2xx with that unusable placeholder.
  throw new DomainError({ code: 'IDEMPOTENCY_KEY_REUSED', message, httpStatus: 409 });
}

export function adminUserRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  routes.post(
    '/admin/users',
    requirePermission('user.manage'),
    requireIdempotencyKey,
    async (c) => {
      const adminId = c.get('userId');
      if (!adminId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }
      const rawBody = await c.req.text();
      const requestHash = await sha256Hex(rawBody);
      const idempotencyKey = c.get('idempotencyKey');
      if (!idempotencyKey) {
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header required',
          httpStatus: 400,
        });
      }
      const existing = await findIdempotencyRecord(
        c.env.DB,
        adminId,
        CREATE_USER_OPERATION,
        idempotencyKey,
      );
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'The account was already created; the initial password cannot be replayed',
          httpStatus: 409,
        });
      }
      const body = parseJsonBody(rawBody, adminCreateUserRequestSchema, {
        event: 'admin.users.create.invalid_json',
        actorUserId: adminId,
      });
      const password = generateInitialPassword();
      const passwordHash = await hashPassword(password);
      const userId = systemIds.uuid();
      const now = sqliteTimestamp(systemClock.now());
      const expiresAt = initialPasswordExpiry();

      try {
        const responseJson = JSON.stringify({
          data: {
            user: { id: userId, email: body.email, displayName: body.displayName ?? null },
            initialPassword: 'redacted',
            initialPasswordExpiresAt: `${expiresAt.replace(' ', 'T')}Z`,
          },
        });
        await c.env.DB.batch([
          prepareCreateIdempotencyRecord(c.env.DB, {
            id: systemIds.uuid(),
            actorId: adminId,
            operation: CREATE_USER_OPERATION,
            idempotencyKey,
            requestHash,
            responseStatus: 201,
            responseJson,
            createdAt: now,
          }),
          ...prepareCreateManagedUser(c.env.DB, {
            id: userId,
            email: body.email,
            displayName: body.displayName ?? null,
            passwordAlgorithm: passwordHash.algorithm,
            passwordIterations: passwordHash.iterations,
            passwordSalt: passwordHash.salt,
            passwordHash: passwordHash.hash,
            createdAt: now,
            updatedAt: now,
            initialPasswordExpiresAt: expiresAt,
            grantedBy: adminId,
          }),
          prepareCreateAuditEvent(c.env.DB, {
            id: systemIds.uuid(),
            actorUserId: adminId,
            action: 'user.created',
            resourceType: 'user',
            resourceId: userId,
            requestId: c.get('requestId') ?? null,
            metadata: JSON.stringify({ email: body.email }),
            createdAt: now,
          }),
        ]);
      } catch (error) {
        if (isIdempotencyUniqueViolation(error)) {
          return rejectOneTimePasswordReplay(
            c.env.DB,
            adminId,
            CREATE_USER_OPERATION,
            idempotencyKey,
            requestHash,
            'The account was already created; the initial password cannot be replayed',
          );
        }
        if (
          error instanceof Error &&
          error.message.includes('UNIQUE constraint failed: users.email')
        ) {
          throw new DomainError({
            code: 'USER_EMAIL_TAKEN',
            message: 'A user with this email already exists',
            httpStatus: 409,
          });
        }
        throw error;
      }

      const successBody = {
        data: {
          user: { id: userId, email: body.email, displayName: body.displayName ?? null },
          initialPassword: password,
          initialPasswordExpiresAt: `${expiresAt.replace(' ', 'T')}Z`,
        },
      };
      // The plaintext is deliberately returned only from this response. It is
      // never included in audit data, logs, or an idempotency replay record.
      return c.json(successBody, 201);
    },
  );

  routes.post(
    '/admin/users/:id/password-reset',
    requirePermission('user.manage'),
    requireIdempotencyKey,
    async (c) => {
      const adminId = c.get('userId');
      const userId = requireUuid(c.req.param('id'));
      if (!adminId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }
      const idempotencyKey = c.get('idempotencyKey');
      if (!idempotencyKey) {
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header required',
          httpStatus: 400,
        });
      }
      const rawBody = await c.req.text();
      const requestHash = await sha256Hex(rawBody);
      const operation = `${'POST /api/v1/admin/users'}/${userId}/password-reset`;
      const existing = await findIdempotencyRecord(c.env.DB, adminId, operation, idempotencyKey);
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'The password reset was already completed',
          httpStatus: 409,
        });
      }
      const user = await findUserById(c.env.DB, userId);
      if (!user || user.status === 'deleted') {
        throw new DomainError({
          code: 'USER_NOT_FOUND',
          message: 'User not found',
          httpStatus: 404,
        });
      }
      const password = generateInitialPassword();
      const passwordHash = await hashPassword(password);
      const now = sqliteTimestamp(systemClock.now());
      const expiresAt = initialPasswordExpiry();
      const update = prepareUpdatePassword(c.env.DB, {
        userId,
        passwordAlgorithm: passwordHash.algorithm,
        passwordIterations: passwordHash.iterations,
        passwordSalt: passwordHash.salt,
        passwordHash: passwordHash.hash,
        updatedAt: now,
        mustChangePassword: true,
        initialPasswordExpiresAt: expiresAt,
      });
      const revoke = c.env.DB.prepare(
        `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
      ).bind(now, userId);
      const initialPasswordExpiresAt = `${expiresAt.replace(' ', 'T')}Z`;
      const responseJson = JSON.stringify({
        data: { userId, initialPassword: 'redacted', initialPasswordExpiresAt },
      });
      try {
        await c.env.DB.batch([
          prepareCreateIdempotencyRecord(c.env.DB, {
            id: systemIds.uuid(),
            actorId: adminId,
            operation,
            idempotencyKey,
            requestHash,
            responseStatus: 200,
            responseJson,
            createdAt: now,
          }),
          update,
          revoke,
          prepareCreateAuditEvent(c.env.DB, {
            id: systemIds.uuid(),
            actorUserId: adminId,
            action: 'user.password_reset',
            resourceType: 'user',
            resourceId: userId,
            requestId: c.get('requestId') ?? null,
            createdAt: now,
          }),
        ]);
      } catch (error) {
        if (isIdempotencyUniqueViolation(error)) {
          return rejectOneTimePasswordReplay(
            c.env.DB,
            adminId,
            operation,
            idempotencyKey,
            requestHash,
            'The password reset was already completed',
          );
        }
        throw error;
      }
      return c.json({ data: { userId, initialPassword: password, initialPasswordExpiresAt } });
    },
  );

  routes.patch(
    '/admin/users/:id/status',
    requirePermission('user.manage'),
    requireIdempotencyKey,
    async (c) => {
      const adminId = c.get('userId');
      if (!adminId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }
      const userId = requireUuid(c.req.param('id'));
      const user = await findUserById(c.env.DB, userId);
      if (!user) {
        throw new DomainError({
          code: 'USER_NOT_FOUND',
          message: 'User not found',
          httpStatus: 404,
        });
      }
      const rawBody = await c.req.text();
      const requestHash = await sha256Hex(rawBody);
      const idempotencyKey = c.get('idempotencyKey');
      if (!idempotencyKey) {
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header required',
          httpStatus: 400,
        });
      }
      const operation = `PATCH /api/v1/admin/users/${userId}/status`;
      const existing = await findIdempotencyRecord(c.env.DB, adminId, operation, idempotencyKey);
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'The account status update was already completed',
          httpStatus: 409,
        });
      }
      const body = parseJsonBody(rawBody, adminUserStatusRequestSchema, {
        event: 'admin.users.status.invalid_json',
        actorUserId: adminId,
      });
      if (userId === adminId && body.status !== 'active') {
        throw new DomainError({
          code: 'PERMISSION_DENIED',
          message: 'Administrators cannot deactivate their own account',
          httpStatus: 403,
        });
      }
      const now = sqliteTimestamp(systemClock.now());
      const update = prepareUpdateUserStatus(c.env.DB, userId, body.status, now);
      const statements: D1PreparedStatement[] = [update];
      if (body.status !== 'active') {
        statements.push(
          c.env.DB.prepare(
            `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
          ).bind(now, userId),
        );
      }
      const successBody = { data: { userId, status: body.status } };
      try {
        await c.env.DB.batch([
          prepareCreateIdempotencyRecord(c.env.DB, {
            id: systemIds.uuid(),
            actorId: adminId,
            operation,
            idempotencyKey,
            requestHash,
            responseStatus: 200,
            responseJson: JSON.stringify(successBody),
            createdAt: now,
          }),
          ...statements,
          prepareCreateAuditEvent(c.env.DB, {
            id: systemIds.uuid(),
            actorUserId: adminId,
            action: 'user.status_changed',
            resourceType: 'user',
            resourceId: userId,
            requestId: c.get('requestId') ?? null,
            metadata: JSON.stringify({ status: body.status }),
            createdAt: now,
          }),
        ]);
      } catch (error) {
        if (isIdempotencyUniqueViolation(error)) {
          return replayAfterRace(c.env.DB, adminId, operation, idempotencyKey, requestHash);
        }
        throw error;
      }
      return c.json(successBody);
    },
  );

  /**
   * GET /api/v1/admin/users
   *
   * Query (all optional; validated by userListQueryParamsSchema from
   * contracts — a ZodError surfaces as 400 VALIDATION_ERROR via the
   * error middleware):
   *   cursor — opaque HMAC-signed cursor from a prior page (surface
   *            'admin-users'; a cursor from another paginated API is a
   *            400, R-API-005)
   *   limit  — page size, default 50, clamped to 50 in the repository
   *
   * Response: `{ data: { items, nextCursor } }` (R-API-004/005) where
   * each item is `{ id, email, displayName, status, createdAt }` —
   * nothing else (AC 16).
   *
   * - Requires authn + requirePermission('user.read')
   */
  routes.get('/admin/users', requirePermission('user.read'), async (c) => {
    const params = userListQueryParamsSchema.parse(c.req.query());

    // R-API-005: resolve the HMAC key from the Secrets Store binding. A
    // missing key fails closed via the ConfigError path in platform/config.
    const cursorSigningKey = await parseCursorSigningKey(c.env);

    try {
      const result = await listUsers(c.env.DB, {
        ...(params.cursor !== undefined && { cursor: params.cursor }),
        ...(params.limit !== undefined && { limit: params.limit }),
        cursorSigningKey,
      });
      return c.json({ data: result });
    } catch (error) {
      // R-API-005: a tampered, malformed, or cross-surface cursor
      // surfaces as a single stable 400 INVALID_CURSOR. Malformed and
      // tampered tokens are observationally equivalent; one code keeps
      // the surface stable.
      if (error instanceof UserCursorInvalidError) {
        throw new DomainError({
          code: 'INVALID_CURSOR',
          message: 'The supplied cursor is invalid or has been tampered with',
          httpStatus: 400,
        });
      }
      // Fix (d), the CAP-044 Slice 2 fix (b) precedent: a stored row
      // violated the read contract (status outside the closed
      // users.status enum). Surface the corruption as a visible 500
      // with the dedicated USER_ROW_INVALID code (registry granted in
      // this fix pass) instead of returning a page the client cannot
      // parse; never skipped silently.
      if (error instanceof UserRowInvalidError) {
        throw new DomainError({
          code: 'USER_ROW_INVALID',
          message: 'A user row failed validation; the users table may be corrupt',
          httpStatus: 500,
        });
      }
      throw error;
    }
  });

  return routes;
}
