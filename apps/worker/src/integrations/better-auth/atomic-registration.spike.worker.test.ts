// CAP-042 Slice 0 — application-owned D1 atomicity proof.
//
// Better Auth's Drizzle transaction path cannot run on D1. These tests use
// the real Workers Pool D1 binding to prove the two application-owned batch
// boundaries that replace it:
//
// - invite: canonical user + credential + effective invite role + use count;
// - setup administrator: canonical user + credential + setup-step advance.
//
// The auth-account table and invite-use trigger are isolated spike artifacts.
// Repository migrations remain the production schema authority.

import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetAndMigrate, seedInstallationState } from '@unimailbox/test-kit';

const CREATOR_ID = '00000000-0000-4000-8000-00000000c001';
const MEMBER_ROLE_ID = '00000000-0000-4000-8000-00000000c002';
const SELECTED_ROLE_ID = '00000000-0000-4000-8000-00000000c003';
const ADMIN_ROLE_ID = 'administrator';
const INVITE_ID = '00000000-0000-4000-8000-00000000c004';
const USER_ID = '00000000-0000-4000-8000-00000000c050';
const ACCOUNT_ID = '00000000-0000-4000-8000-00000000c060';
const CREATED_AT = '2026-01-01 00:00:00';
const CREATED_AT_MS = 1_767_225_600_000;
const FIXED_SALT = new Uint8Array(16);
const FIXED_HASH = new Uint8Array(32);
const CREDENTIAL_ENVELOPE = `pbkdf2-sha256$600000$${'00'.repeat(16)}$${'00'.repeat(32)}`;

async function createSpikeSchema(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `CREATE TABLE cap042_spike_auth_accounts (
        id TEXT PRIMARY KEY NOT NULL,
        issuer TEXT NOT NULL,
        account_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
      `CREATE UNIQUE INDEX cap042_spike_auth_accounts_issuer_account_id
       ON cap042_spike_auth_accounts(issuer, account_id)`,
    ),
    env.DB.prepare(
      `CREATE INDEX cap042_spike_auth_accounts_user_id
       ON cap042_spike_auth_accounts(user_id)`,
    ),
    // An UPDATE that affects zero rows does not fail a D1 batch. The trigger
    // converts an over-limit increment into an in-batch SQLite abort, so all
    // preceding registration writes roll back atomically.
    env.DB.prepare(
      `CREATE TRIGGER cap042_spike_registration_key_usage_guard
       BEFORE UPDATE OF used_count ON registration_keys
       WHEN NEW.used_count > OLD.max_uses
       BEGIN
         SELECT RAISE(ABORT, 'CAP042_REGISTRATION_KEY_EXHAUSTED');
       END`,
    ),
  ]);
}

function prepareUserInsert(): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO users (
       id, email, display_name, status,
       password_algorithm, password_iterations, password_salt, password_hash,
       created_at, updated_at
     ) VALUES (?, ?, ?, 'active', 'pbkdf2-sha256', 600000, ?, ?, ?, ?)`,
  ).bind(
    USER_ID,
    'cap042-new-user@example.com',
    'CAP-042 User',
    FIXED_SALT,
    FIXED_HASH,
    CREATED_AT,
    CREATED_AT,
  );
}

function prepareCredentialInsert(): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO cap042_spike_auth_accounts (
       id, issuer, account_id, provider_id, user_id, password, created_at, updated_at
     ) VALUES (?, 'local:credential', ?, 'credential', ?, ?, ?, ?)`,
  ).bind(ACCOUNT_ID, USER_ID, USER_ID, CREDENTIAL_ENVELOPE, CREATED_AT_MS, CREATED_AT_MS);
}

function prepareRoleInsert(roleId: string): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, ?, ?)`,
  ).bind(USER_ID, roleId, CREATED_AT);
}

function prepareInviteIncrement(): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE registration_keys SET used_count = used_count + 1 WHERE id = ?`,
  ).bind(INVITE_ID);
}

function prepareSetupAdvance(): D1PreparedStatement {
  return env.DB.prepare(
    `UPDATE installation_state
     SET current_step = 'domain', updated_at = ?
     WHERE id = 1 AND current_step = 'administrator'`,
  ).bind(CREATED_AT);
}

async function seedInviteFixtures(roleId: string | null, usedCount = 0): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (
         id, email, display_name, status,
         password_algorithm, password_iterations, password_salt, password_hash,
         created_at, updated_at
       ) VALUES (?, ?, 'CAP-042 Creator', 'active',
         'pbkdf2-sha256', 600000, ?, ?, ?, ?)`,
    ).bind(
      CREATOR_ID,
      'cap042-creator@example.com',
      FIXED_SALT,
      FIXED_HASH,
      CREATED_AT,
      CREATED_AT,
    ),
    env.DB.prepare(
      `INSERT INTO roles (id, name, description, is_system, created_at)
       VALUES (?, 'member', 'Member fallback', 1, ?)`,
    ).bind(MEMBER_ROLE_ID, CREATED_AT),
    env.DB.prepare(
      `INSERT INTO roles (id, name, description, is_system, created_at)
       VALUES (?, 'viewer', 'Invite-selected role', 1, ?)`,
    ).bind(SELECTED_ROLE_ID, CREATED_AT),
    env.DB.prepare(
      `INSERT INTO registration_keys (
         id, code_hash, role_id, max_uses, used_count,
         expires_at, revoked_at, created_by, created_at
       ) VALUES (?, 'cap042-code-hash', ?, 1, ?, NULL, NULL, ?, ?)`,
    ).bind(INVITE_ID, roleId, usedCount, CREATOR_ID, CREATED_AT),
  ]);
}

async function effectiveInviteRole(): Promise<string> {
  const invite = await env.DB.prepare(`SELECT role_id FROM registration_keys WHERE id = ?`)
    .bind(INVITE_ID)
    .first<{ role_id: string | null }>();
  if (!invite) throw new Error('CAP-042 invite fixture missing');
  return invite.role_id ?? MEMBER_ROLE_ID;
}

function inviteBatch(roleId: string, trailing?: D1PreparedStatement): D1PreparedStatement[] {
  const statements = [
    prepareUserInsert(),
    prepareCredentialInsert(),
    prepareRoleInsert(roleId),
    prepareInviteIncrement(),
  ];
  if (trailing) statements.push(trailing);
  return statements;
}

async function captureFailure(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
    return null;
  } catch (error) {
    return error;
  }
}

function errorMessages(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current) {
    messages.push(current instanceof Error ? current.message : String(current));
    current = (current as { cause?: unknown }).cause;
  }
  return messages.join('\n');
}

async function readInviteEffects(): Promise<{
  user: number;
  account: number;
  role: string | null;
  usedCount: number;
}> {
  const user = await env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE id = ?`)
    .bind(USER_ID)
    .first<{ count: number }>();
  const account = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM cap042_spike_auth_accounts WHERE user_id = ?`,
  )
    .bind(USER_ID)
    .first<{ count: number }>();
  const role = await env.DB.prepare(`SELECT role_id FROM user_roles WHERE user_id = ?`)
    .bind(USER_ID)
    .first<{ role_id: string }>();
  const invite = await env.DB.prepare(`SELECT used_count FROM registration_keys WHERE id = ?`)
    .bind(INVITE_ID)
    .first<{ used_count: number }>();
  return {
    user: user?.count ?? 0,
    account: account?.count ?? 0,
    role: role?.role_id ?? null,
    usedCount: invite?.used_count ?? -1,
  };
}

async function seedSetupFixtures(): Promise<void> {
  await seedInstallationState({ status: 'setup', currentStep: 'administrator' });
  // Seed the role so the assertion that setup creates no role assignment is
  // not vacuously enforced by a missing FK target.
  await env.DB.prepare(
    `INSERT INTO roles (id, name, description, is_system, created_at)
     VALUES (?, 'administrator', 'Administrator', 1, ?)`,
  )
    .bind(ADMIN_ROLE_ID, CREATED_AT)
    .run();
}

async function readSetupEffects(): Promise<{
  user: number;
  account: number;
  role: number;
  currentStep: string;
}> {
  const user = await env.DB.prepare(`SELECT COUNT(*) AS count FROM users WHERE id = ?`)
    .bind(USER_ID)
    .first<{ count: number }>();
  const account = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM cap042_spike_auth_accounts WHERE user_id = ?`,
  )
    .bind(USER_ID)
    .first<{ count: number }>();
  const role = await env.DB.prepare(`SELECT COUNT(*) AS count FROM user_roles WHERE user_id = ?`)
    .bind(USER_ID)
    .first<{ count: number }>();
  const state = await env.DB.prepare(
    `SELECT current_step FROM installation_state WHERE id = 1`,
  ).first<{ current_step: string }>();
  return {
    user: user?.count ?? 0,
    account: account?.count ?? 0,
    role: role?.count ?? 0,
    currentStep: state?.current_step ?? '<missing>',
  };
}

describe('CAP-042 application-owned D1 auth batches', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await createSpikeSchema();
  });

  it('uses the invite-selected role and commits all invite effects once', async () => {
    await seedInviteFixtures(SELECTED_ROLE_ID);
    const roleId = await effectiveInviteRole();

    await env.DB.batch(inviteBatch(roleId));

    expect(await readInviteEffects()).toEqual({
      user: 1,
      account: 1,
      role: SELECTED_ROLE_ID,
      usedCount: 1,
    });
  });

  it('falls back to member when the invite role is null', async () => {
    await seedInviteFixtures(null);
    const roleId = await effectiveInviteRole();

    await env.DB.batch(inviteBatch(roleId));

    expect(await readInviteEffects()).toEqual({
      user: 1,
      account: 1,
      role: MEMBER_ROLE_ID,
      usedCount: 1,
    });
  });

  it('rolls back every invite effect when a later statement fails', async () => {
    await seedInviteFixtures(SELECTED_ROLE_ID);
    const roleId = await effectiveInviteRole();
    const duplicateRole = env.DB.prepare(
      `INSERT INTO roles (id, name, description, is_system, created_at)
       VALUES (?, 'duplicate', 'Injected failure', 0, ?)`,
    ).bind(SELECTED_ROLE_ID, CREATED_AT);

    const error = await captureFailure(env.DB.batch(inviteBatch(roleId, duplicateRole)));

    expect(errorMessages(error)).toMatch(/UNIQUE constraint failed/i);
    expect(await readInviteEffects()).toEqual({
      user: 0,
      account: 0,
      role: null,
      usedCount: 0,
    });
  });

  it('aborts the whole invite batch when the invite is already exhausted', async () => {
    await seedInviteFixtures(SELECTED_ROLE_ID, 1);
    const roleId = await effectiveInviteRole();

    const error = await captureFailure(env.DB.batch(inviteBatch(roleId)));

    expect(errorMessages(error)).toContain('CAP042_REGISTRATION_KEY_EXHAUSTED');
    expect(await readInviteEffects()).toEqual({
      user: 0,
      account: 0,
      role: null,
      usedCount: 1,
    });
  });

  it('commits setup user, credential, and step without assigning a role', async () => {
    await seedSetupFixtures();

    await env.DB.batch([prepareUserInsert(), prepareCredentialInsert(), prepareSetupAdvance()]);

    expect(await readSetupEffects()).toEqual({
      user: 1,
      account: 1,
      role: 0,
      currentStep: 'domain',
    });
  });

  it('rolls back setup user, credential, and step when a later statement fails', async () => {
    await seedSetupFixtures();
    const duplicateState = env.DB.prepare(
      `INSERT INTO installation_state (
         id, status, current_step, schema_version, updated_at, created_at
       ) VALUES (1, 'setup', 'administrator', 1, ?, ?)`,
    ).bind(CREATED_AT, CREATED_AT);

    const error = await captureFailure(
      env.DB.batch([
        prepareUserInsert(),
        prepareCredentialInsert(),
        prepareSetupAdvance(),
        duplicateState,
      ]),
    );

    expect(errorMessages(error)).toMatch(/UNIQUE constraint failed/i);
    expect(await readSetupEffects()).toEqual({
      user: 0,
      account: 0,
      role: 0,
      currentStep: 'administrator',
    });
  });
});
