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
import {
  sqliteTable,
  text,
  integer,
  blob,
  index,
  uniqueIndex,
  customType,
} from 'drizzle-orm/sqlite-core';

// Canonical users predate Better Auth and store timestamps as SQLite UTC
// text. Better Auth's adapter works with Date values, so this typing-only
// bridge preserves the deployable DDL while presenting Date at that seam.
const sqliteUtcTextDate = customType<{ data: Date; driverData: string }>({
  dataType: () => 'text',
  toDriver: (value) => value.toISOString().replace('T', ' ').replace('Z', ''),
  fromDriver: (value) => {
    const isoLike = value.includes('T') ? value : value.replace(' ', 'T');
    const hasZone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(isoLike);
    return new Date(hasZone ? isoLike : `${isoLike}Z`);
  },
});

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    // Migration 0014 backfills and trigger-normalizes null/blank legacy
    // writes, so Better Auth can treat its mapped `name` as non-null.
    displayName: text('display_name').notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
    image: text('image'),
    status: text('status', { enum: ['active', 'banned', 'deleted'] }).notNull(),
    passwordAlgorithm: text('password_algorithm').notNull(),
    passwordIterations: integer('password_iterations').notNull(),
    passwordSalt: blob('password_salt', { mode: 'buffer' }).notNull(),
    passwordHash: blob('password_hash', { mode: 'buffer' }).notNull(),
    createdAt: sqliteUtcTextDate('created_at').notNull(),
    updatedAt: sqliteUtcTextDate('updated_at').notNull(),
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
// Better Auth 1.7.1 tables — CAP-042 / ADR-008.
//
// These declarations are adapter typings only. migrations/0014_* is the
// deployment authority. Logical model keys (user/account/session/
// verification) are composed by the request-scoped auth factory.
// ---------------------------------------------------------------------------

export const authAccounts = sqliteTable(
  'auth_accounts',
  {
    id: text('id').primaryKey().notNull(),
    issuer: text('issuer').notNull(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
    refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    issuerAccountUnique: uniqueIndex('auth_accounts_issuer_account_id_unique').on(
      t.issuer,
      t.accountId,
    ),
    userIdIdx: index('auth_accounts_user_id_idx').on(t.userId),
  }),
);

export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey().notNull(),
    token: text('token').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    tokenUnique: uniqueIndex('auth_sessions_token_unique').on(t.token),
    userIdIdx: index('auth_sessions_user_id_idx').on(t.userId),
  }),
);

export const authVerifications = sqliteTable(
  'auth_verifications',
  {
    id: text('id').primaryKey().notNull(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    identifierIdx: index('auth_verifications_identifier_idx').on(t.identifier),
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
export type AuthAccount = typeof authAccounts.$inferSelect;
export type NewAuthAccount = typeof authAccounts.$inferInsert;
export type AuthSession = typeof authSessions.$inferSelect;
export type NewAuthSession = typeof authSessions.$inferInsert;
export type AuthVerification = typeof authVerifications.$inferSelect;
export type NewAuthVerification = typeof authVerifications.$inferInsert;
export type IdempotencyRecord = typeof idempotencyRecords.$inferSelect;
export type NewIdempotencyRecord = typeof idempotencyRecords.$inferInsert;

// Typing only; migration 0031 is authoritative.
export const userPreferences = sqliteTable('user_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  language: text('language', { enum: ['en', 'zh-CN'] })
    .notNull()
    .default('en'),
  theme: text('theme', { enum: ['system', 'light', 'dark'] })
    .notNull()
    .default('system'),
  density: text('density', { enum: ['comfortable', 'compact'] })
    .notNull()
    .default('comfortable'),
  readingPane: text('reading_pane', { enum: ['none', 'right', 'bottom'] })
    .notNull()
    .default('none'),
  defaultMailboxId: text('default_mailbox_id'),
  avatarObjectKey: text('avatar_object_key').unique(),
  avatarContentType: text('avatar_content_type'),
  avatarVersion: text('avatar_version'),
  updatedAt: text('updated_at').notNull(),
});
