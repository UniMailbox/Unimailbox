// session-repository — sessions table CRUD.
// Owner: identity module. Private file — export through modules/identity/index.ts.
//
// R-AUTH-003: sessions(user_id, expires_at) index for efficient eviction.
// R-AUTH-005: sessions.user_id ON DELETE CASCADE (user deleted → sessions deleted).
//
// CAP-019: refresh tokens are stored as SHA-256 hashes, never plaintext.

import type { Database } from '../../platform/database';

/**
 * Input for creating a session. All fields except ip and userAgent are required.
 *
 * - expiresAt: Unix timestamp (seconds) when the refresh token expires
 * - refreshTokenHash: SHA-256 hash of the refresh token (never stored plaintext)
 */
export interface CreateSessionInput {
  readonly id: string;
  readonly userId: string;
  readonly refreshTokenHash: string;
  readonly expiresAt: number;
  readonly ip?: string;
  readonly userAgent?: string;
  readonly createdAt: string;
}

/**
 * Session row shape as returned from the database.
 */
export interface SessionRow {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  created_at: string;
  revoked_at: string | null;
}

/**
 * Inserts a session row into the sessions table.
 *
 * The refresh_token_hash is the SHA-256 hex string of the plaintext refresh token.
 * The plaintext token is never stored — only the hash, per R-SECRET-003.
 *
 * @throws D1 error on constraint violation
 */
export async function createSession(db: Database, input: CreateSessionInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, expires_at, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.userId,
      input.refreshTokenHash,
      input.expiresAt,
      input.ip ?? null,
      input.userAgent ?? null,
      input.createdAt,
    )
    .run();
}

/**
 * Find a session by its refresh token hash.
 *
 * Used during token refresh to validate the refresh token and retrieve the
 * associated user ID. Returns null if not found or if revoked.
 *
 * @param db — D1 database binding
 * @param refreshTokenHash — SHA-256 hash of the refresh token
 * @returns Session row if found and not revoked, null otherwise
 */
export async function findSessionByRefreshHash(
  db: Database,
  refreshTokenHash: string,
): Promise<SessionRow | null> {
  const result = await db
    .prepare(
      `SELECT id, user_id, refresh_token_hash, expires_at, ip, user_agent, created_at, revoked_at
       FROM sessions
       WHERE refresh_token_hash = ? AND revoked_at IS NULL`,
    )
    .bind(refreshTokenHash)
    .first<SessionRow>();

  return result ?? null;
}

/** Resolve a short-lived access token's session and enforce revocation/expiry. */
export async function findActiveSessionById(
  db: Database,
  sessionId: string,
  nowSeconds: number,
): Promise<SessionRow | null> {
  const result = await db
    .prepare(
      `SELECT id, user_id, refresh_token_hash, expires_at, ip, user_agent, created_at, revoked_at
       FROM sessions
       WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(sessionId, nowSeconds)
    .first<SessionRow>();
  return result ?? null;
}

/**
 * Revoke a session by setting revoked_at.
 *
 * Used during logout or when a refresh token is suspected to be compromised.
 *
 * @param db — D1 database binding
 * @param sessionId — UUID of the session to revoke
 */
export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db
    .prepare(`UPDATE sessions SET revoked_at = datetime('now') WHERE id = ?`)
    .bind(sessionId)
    .run();
}

/**
 * Revoke all sessions for a user except the current one.
 *
 * Used when a user changes their password (R-AUTH-005: revoke all sessions).
 *
 * @param db — D1 database binding
 * @param userId — UUID of the user
 * @param exceptSessionId — UUID of the session to keep (current session)
 */
export async function revokeUserSessions(
  db: Database,
  userId: string,
  exceptSessionId: string,
): Promise<void> {
  await db
    .prepare(
      `UPDATE sessions SET revoked_at = datetime('now')
       WHERE user_id = ? AND id != ? AND revoked_at IS NULL`,
    )
    .bind(userId, exceptSessionId)
    .run();
}

/** Revoke every session for a user, including the current one. */
export async function revokeAllUserSessions(db: Database, userId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE sessions SET revoked_at = datetime('now') WHERE user_id = ? AND revoked_at IS NULL`,
    )
    .bind(userId)
    .run();
}
