// apps/worker/src/integrations/better-auth/better-auth-d1.spike.worker.test.ts
//
// CAP-042 Slice 0 / Task 1 — Better Auth 1.7.1 + Cloudflare D1 compatibility
// harness. Proves the real Better Auth core, the real Drizzle adapter, the
// real Drizzle D1 driver, and the real Cloudflare D1 binding work together
// inside the Workers Pool against a raw Request. Acceptance criterion #3 in
// work/active/CAP-042-better-auth-shell/task.md.
//
// The harness uses isolated prefixed tables (`cap042_spike_*`) and inline
// drizzle-orm/sqlite-core definitions; it never touches canonical Unimailbox
// schema, routes, bindings, migrations, or the application factory. That
// separation is what makes this test red-allowed under spike-evidence.md
// §Cookie, origin, secret, and runtime decisions.
//
// The second test is the executable reason production must run with
// `transaction: false` (spike-evidence.md §D1 transaction and atomic
// registration result).
import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { drizzle } from 'drizzle-orm/d1';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';

const SPIKE_SECRET = 'unimailbox-cap042-spike-only-do-not-use-elsewhere';
const SPIKE_BASE_URL = 'http://localhost';
const SPIKE_BASE_PATH = '/api/v1/auth/better';
const SPIKE_COOKIE_PREFIX = 'unimailbox-cap042-spike';
const SPIKE_EMAIL = 'cap042-spike@example.com';
const SPIKE_PASSWORD = 'spikePassword123';
const SPIKE_NAME = 'Spike User';

// Isolated Better Auth SQLite shape. Keys (`user`, `account`, `session`,
// `verification`) match Better Auth 1.7.1's expected model names; physical
// table names are `cap042_spike_*` so the spike cannot collide with any
// canonical Unimailbox schema, application route, or downstream migration.
// Column shapes mirror the generated SQLite schema recorded in
// spike-evidence.md §Generated SQLite schema comparison.
const spikeUser = sqliteTable('cap042_spike_user', {
  id: text('id').primaryKey().notNull(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

const spikeAccount = sqliteTable(
  'cap042_spike_account',
  {
    id: text('id').primaryKey().notNull(),
    issuer: text('issuer').notNull(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => spikeUser.id, { onDelete: 'cascade' }),
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
  (table) => ({
    issuerAccountIdx: uniqueIndex('cap042_spike_account_issuer_account_id').on(
      table.issuer,
      table.accountId,
    ),
    userIdIdx: index('cap042_spike_account_user_id').on(table.userId),
  }),
);

const spikeSession = sqliteTable(
  'cap042_spike_session',
  {
    id: text('id').primaryKey().notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: text('user_id')
      .notNull()
      .references(() => spikeUser.id, { onDelete: 'cascade' }),
  },
  (table) => ({
    userIdIdx: index('cap042_spike_session_user_id').on(table.userId),
  }),
);

const spikeVerification = sqliteTable(
  'cap042_spike_verification',
  {
    id: text('id').primaryKey().notNull(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => ({
    identifierIdx: index('cap042_spike_verification_identifier').on(table.identifier),
  }),
);

const schema = {
  user: spikeUser,
  account: spikeAccount,
  session: spikeSession,
  verification: spikeVerification,
} as const;

// Create the prefixed tables via the real D1 binding. CREATE TABLE IF NOT
// EXISTS is idempotent so beforeEach does not need to detect prior runs.
async function ensureSpikeTables(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS cap042_spike_user (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        email_verified INTEGER NOT NULL DEFAULT 0,
        image TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS cap042_spike_account (
        id TEXT PRIMARY KEY NOT NULL,
        issuer TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES cap042_spike_user(id) ON DELETE CASCADE,
        access_token TEXT,
        refresh_token TEXT,
        id_token TEXT,
        access_token_expires_at INTEGER,
        refresh_token_expires_at INTEGER,
        scope TEXT,
        password TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ),
    env.DB.prepare(
      `CREATE UNIQUE INDEX IF NOT EXISTS cap042_spike_account_issuer_account_id
        ON cap042_spike_account(issuer, account_id)`,
    ),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS cap042_spike_account_user_id
        ON cap042_spike_account(user_id)`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS cap042_spike_session (
        id TEXT PRIMARY KEY NOT NULL,
        expires_at INTEGER NOT NULL,
        token TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        user_id TEXT NOT NULL REFERENCES cap042_spike_user(id) ON DELETE CASCADE
      )`,
    ),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS cap042_spike_session_user_id
        ON cap042_spike_session(user_id)`,
    ),
    env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS cap042_spike_verification (
        id TEXT PRIMARY KEY NOT NULL,
        identifier TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    ),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS cap042_spike_verification_identifier
        ON cap042_spike_verification(identifier)`,
    ),
  ]);
}

// Clear all rows so each test starts from an empty schema. Order matters
// because account/session/verification may have logical foreign-key
// references to user.
const SPIKE_TABLE_CLEAR_ORDER = [
  'cap042_spike_session',
  'cap042_spike_account',
  'cap042_spike_verification',
  'cap042_spike_user',
] as const;

async function clearSpikeRows(): Promise<void> {
  await env.DB.batch(
    SPIKE_TABLE_CLEAR_ORDER.map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
}

// Build a fresh Better Auth instance per test. The handler is bound to the
// real D1 binding via drizzle(env.DB) and the real Drizzle adapter. Cookie
// cache is intentionally left disabled to match spike-evidence.md §Cookie,
// origin, secret, and runtime decisions.
function buildAuth() {
  const db = drizzle(env.DB, { schema });
  return betterAuth({
    baseURL: SPIKE_BASE_URL,
    basePath: SPIKE_BASE_PATH,
    secret: SPIKE_SECRET,
    emailAndPassword: { enabled: true },
    advanced: { cookiePrefix: SPIKE_COOKIE_PREFIX },
    database: drizzleAdapter(db, {
      provider: 'sqlite',
      schema,
      transaction: false,
    }),
  });
}

describe('CAP-042 Slice 0 / Task 1 — Better Auth 1.7.1 + D1 isolated spike', () => {
  beforeEach(async () => {
    await ensureSpikeTables();
    await clearSpikeRows();
  });

  afterEach(async () => {
    await clearSpikeRows();
  });

  it('signs up via raw Request, returns HttpOnly SameSite=Lax cookie, and recovers the same session', async () => {
    const auth = buildAuth();

    const signUpResponse = await auth.handler(
      new Request(`${SPIKE_BASE_URL}${SPIKE_BASE_PATH}/sign-up/email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: SPIKE_EMAIL,
          password: SPIKE_PASSWORD,
          name: SPIKE_NAME,
        }),
      }),
    );

    expect(signUpResponse.status).toBe(200);

    const setCookie = signUpResponse.headers.get('set-cookie');
    expect(setCookie).not.toBeNull();
    if (!setCookie) throw new Error('Better Auth sign-up did not return a session cookie');
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);

    // Extract the cookie name=value pair (the first segment before the
    // first `;`). Never log it.
    const cookieHeader = setCookie.split(';')[0]?.trim();
    if (!cookieHeader) throw new Error('Better Auth returned an empty session cookie');

    const sessionResponse = await auth.handler(
      new Request(`${SPIKE_BASE_URL}${SPIKE_BASE_PATH}/get-session`, {
        method: 'GET',
        headers: { Cookie: cookieHeader },
      }),
    );

    expect(sessionResponse.status).toBe(200);
    const sessionBody = (await sessionResponse.json()) as {
      user?: { id?: string; email?: string };
      session?: { userId?: string; token?: string };
    };

    expect(sessionBody.user).toBeDefined();
    expect(sessionBody.session).toBeDefined();
    expect(sessionBody.user?.email).toBe(SPIKE_EMAIL);
    expect(sessionBody.user?.id).toBe(sessionBody.session?.userId);

    const userRow = await env.DB.prepare(`SELECT id, email FROM cap042_spike_user WHERE email = ?`)
      .bind(SPIKE_EMAIL)
      .first<{ id: string; email: string }>();

    expect(userRow).not.toBeNull();
    expect(userRow?.id).toBe(sessionBody.user?.id);

    const accountCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM cap042_spike_account WHERE user_id = ?`,
    )
      .bind(userRow?.id)
      .first<{ n: number }>();
    expect(accountCount?.n ?? 0).toBeGreaterThan(0);

    const sessionCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM cap042_spike_session WHERE user_id = ?`,
    )
      .bind(userRow?.id)
      .first<{ n: number }>();
    expect(sessionCount?.n ?? 0).toBeGreaterThan(0);
  });

  it('rejects drizzle(env.DB).transaction() — production must keep transaction: false', async () => {
    const db = drizzle(env.DB, { schema });

    let capturedError: unknown;
    let didThrow = false;

    try {
      await db.transaction(async () => {
        // Body is intentionally empty; we expect the BEGIN to fail before
        // any statement runs. This mirrors the spike-evidence.md guidance:
        // D1 requires state.storage.transaction(), not SQL transactions.
      });
    } catch (error) {
      didThrow = true;
      capturedError = error;
    }

    expect(didThrow).toBe(true);

    // Drizzle wraps the underlying D1 error as a DrizzleQueryError whose
    // .message is "Failed query: begin\nparams: ". The workerd/D1 guidance
    // lives on the chained .cause. Walk the chain to assert the D1 text is
    // preserved (not silently dropped) so a future Drizzle version that
    // hides the cause surfaces here as a failing test.
    const messages: string[] = [];
    for (
      let current: unknown = capturedError;
      current;
      current = (current as { cause?: unknown })?.cause
    ) {
      if (current instanceof Error) messages.push(current.message);
      else {
        messages.push(String(current));
        break;
      }
    }

    const combined = messages.join('\n');

    // The D1 guidance mentions transaction / SAVEPOINT / BEGIN and points
    // the reader at state.storage.transaction(...). The substring match
    // stays stable across D1 wording churn while still proving the cause
    // chain preserved the original D1 error rather than a sanitized shell.
    expect(combined).toMatch(/transaction|SAVEPOINT|BEGIN/i);
    expect(combined).toMatch(/state\.storage\.transaction/i);
  });
});
