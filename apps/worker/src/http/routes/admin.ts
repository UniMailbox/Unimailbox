// http/routes/admin — CAP-019 admin operations.
// Hono sub-app for /api/v1/admin/* endpoints: invite-codes CRUD.
//
// R-AUTHZ-001: Admin endpoints require 'user.manage' permission.
// R-AUTHZ-002: Authorization checks hit the database per request.
//
// Protected routes: invite-codes (requires authn + requirePermission).

import { Hono } from 'hono';
import { createInviteCodeRequestSchema } from '@unimailbox/contracts';
import { createRegistrationKey } from '../../modules/onboarding';
import { requirePermission } from '../middleware/authz';
import { systemClock } from '../../platform/clock';
import { systemIds } from '../../platform/ids';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Hash a token with SHA-256 for storage.
 * Used for registration invite codes (never stored plaintext).
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

/**
 * Generate a 64-character hex code (32 random bytes).
 * Used for registration invite codes.
 */
function generateInviteCode(): string {
  const codeBytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(codeBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export function adminRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  /**
   * POST /api/v1/admin/invite-codes
   *
   * Create a new registration invite code.
   *
   * - Requires authn (sets userId) + requirePermission('user.manage')
   * - Generates 64-char hex code
   * - Hashes with SHA-256 for storage
   * - Stores in registration_keys table
   * - Returns plaintext code (shown once)
   *
   * Returns 403 PERMISSION_DENIED if user lacks 'user.manage' permission.
   */
  routes.post('/invite-codes', requirePermission('user.manage'), async (c) => {
    const userId = c.get('userId');
    if (!userId) {
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    }

    const body = createInviteCodeRequestSchema.parse(await c.req.json());

    // Generate the code and its hash
    const code = generateInviteCode();
    const codeHash = await hashToken(code);

    // Calculate expiry
    let expiresAt: string | null = null;
    if (body.expiresInHours) {
      const expiryDate = new Date(
        systemClock.now().getTime() + body.expiresInHours * 60 * 60 * 1000,
      );
      expiresAt = expiryDate.toISOString();
    }

    // Create the registration key
    const keyId = systemIds.uuid();
    const now = systemClock.now().toISOString();

    await createRegistrationKey(c.env.DB, {
      id: keyId,
      codeHash,
      roleId: body.roleId ?? null,
      maxUses: body.maxUses ?? 1, // Schema default is 1, but zod.parse returns undefined
      createdBy: userId,
      expiresAt,
      createdAt: now,
    });

    // Return the code (shown only once)
    return c.json({
      data: {
        code,
        id: keyId,
        maxUses: body.maxUses,
        expiresAt,
      },
    });
  });

  /**
   * GET /api/v1/admin/invite-codes
   *
   * List registration invite codes.
   *
   * - Requires authn (sets userId) + requirePermission('user.manage')
   * - Returns list of keys WITHOUT code or hash (R-SECRET-003)
   *
   * Returns 403 PERMISSION_DENIED if user lacks 'user.manage' permission.
   */
  routes.get('/invite-codes', requirePermission('user.manage'), async (c) => {
    const userId = c.get('userId');
    if (!userId) {
      throw new DomainError({
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication required',
        httpStatus: 401,
      });
    }

    // Query all keys, excluding code_hash (never expose the hash)
    const rows = await c.env.DB
      .prepare(
        `SELECT id, role_id, max_uses, used_count, expires_at, revoked_at, created_by, created_at
         FROM registration_keys
         ORDER BY created_at DESC`,
      )
      .all<{
        id: string;
        role_id: string | null;
        max_uses: number;
        used_count: number;
        expires_at: string | null;
        revoked_at: string | null;
        created_by: string;
        created_at: string;
      }>();

    const keys =
      rows.results?.map((row) => ({
        id: row.id,
        roleId: row.role_id,
        maxUses: row.max_uses,
        usedCount: row.used_count,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        createdBy: row.created_by,
        createdAt: row.created_at,
      })) ?? [];

    return c.json({ data: { keys } });
  });

  return routes;
}
