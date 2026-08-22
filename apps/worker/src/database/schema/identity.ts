// apps/worker/src/database/schema/identity.ts — Drizzle typing for
// identity-owned tables (users, sessions). SQL in migrations/0001_initial.sql
// is the deployable artifact; these declarations are typing only and must
// not be used to regenerate the SQL.
//
// R-AUTH-002: users.status enum.
// R-AUTH-003: sessions(user_id, expires_at) eviction index.
// R-AUTH-005: sessions.user_id → users.id ON DELETE CASCADE.
// R-AUTH-009: users.email COLLATE NOCASE.
// ADR-006:    users.password_* four-column shape.
import { sqliteTable, text, integer, blob, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    displayName: text('display_name'),
    status: text('status', { enum: ['active', 'banned', 'deleted'] }).notNull(),
    passwordAlgorithm: text('password_algorithm').notNull(),
    passwordIterations: integer('password_iterations').notNull(),
    passwordSalt: blob('password_salt', { mode: 'buffer' }).notNull(),
    passwordHash: blob('password_hash', { mode: 'buffer' }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => ({
    emailUnique: uniqueIndex('users_email_unique').on(t.email),
    statusIdx: index('users_status_idx').on(t.status),
  }),
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    expiresAt: integer('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    createdAt: text('created_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => ({
    userIdExpiresAtIdx: index('sessions_user_id_expires_at_idx').on(t.userId, t.expiresAt),
    refreshTokenHashUnique: uniqueIndex('sessions_refresh_token_hash_unique').on(
      t.refreshTokenHash,
    ),
  }),
);

// ---------------------------------------------------------------------------
// Idempotency records — CAP-027 / ADR-004.
//
// R-API-004, R-OUTBOUND-005, R-OUTBOUND-006. The table is written from
// apps/worker/src/platform/idempotency.ts via D1 batch / prepared statements;
// Drizzle declarations are typing only (see docs/rebuild/05-target-architecture/
// data-model.md §Migration authority — SQL is the deployable artifact).
//
// actor_id is opaque on purpose: it may be a userId, a hash of a setup-session
// token, a hash of a registration code, or a hash of an email. The unique
// index on (actor_id, operation, idempotency_key) is what makes concurrent
// retries safe — the second INSERT collides and the handler replays.
// ---------------------------------------------------------------------------
export const idempotencyRecords = sqliteTable(
  'idempotency_records',
  {
    id: text('id').primaryKey(),
    actorId: text('actor_id').notNull(),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    responseStatus: integer('response_status').notNull(),
    responseJson: text('response_json').notNull(),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
  },
  (t) => ({
    unique: uniqueIndex('idempotency_records_unique').on(t.actorId, t.operation, t.idempotencyKey),
    expiresAtIdx: index('idempotency_records_expires_at_idx').on(t.expiresAt),
  }),
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;
