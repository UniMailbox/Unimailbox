// mailbox-repository — creates and reads mailbox and mailbox_members rows.
// Owner: tenancy module. Private file — export through modules/tenancy/index.ts.
//
// R-DATA-001: local_part is case-insensitive (COLLATE NOCASE) via unique index.
// R-MAILBOX-003: Owner is implicitly a member; no explicit row needed in mailbox_members.
// Mailbox address = {localPart}@{domain.name} — domain lookup required for full address.

import type { Database } from '../../platform/database';
import {
  emailAddressSchema,
  type AdminUserMailboxItem,
  type MailboxMemberRole,
} from '@unimailbox/contracts';

export interface CreateMailboxInput {
  readonly id: string;
  readonly domainId: string;
  readonly ownerUserId: string;
  readonly localPart: string;
  readonly displayName: string;
  readonly status: 'active' | 'disabled' | 'deleted';
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MailboxInfo {
  readonly id: string;
  readonly address: string;
  readonly displayName: string;
  readonly status: string;
  readonly domainId: string;
  readonly localPart: string;
  readonly ownerUserId: string;
}

export interface MailboxMemberInfo {
  readonly mailboxId: string;
  readonly userId: string;
  readonly role: 'viewer' | 'sender' | 'admin';
}

export interface MailboxMemberRow {
  readonly mailboxId: string;
  readonly userId: string;
  readonly role: MailboxMemberRole;
  readonly createdAt: string;
}

export interface CreateMailboxMemberInput {
  readonly mailboxId: string;
  readonly userId: string;
  readonly role: MailboxMemberRole;
  readonly createdAt: string;
}

/** Prepares an explicit member insert for the tenancy-owned table. */
export function prepareCreateMailboxMember(
  db: Database,
  input: CreateMailboxMemberInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(input.mailboxId, input.userId, input.role, input.createdAt);
}

/** Prepares deletion of one explicit member; the owner has no row to delete. */
export function prepareDeleteMailboxMember(
  db: Database,
  mailboxId: string,
  userId: string,
): D1PreparedStatement {
  return db
    .prepare('DELETE FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?')
    .bind(mailboxId, userId);
}

/**
 * Fails the surrounding D1 batch when the preceding DELETE changed no row.
 * SQLite's changes() is scoped to the previous statement, so this keeps a
 * concurrent loser from committing an audit for a non-deletion.
 */
export function prepareRequireMailboxMemberDeleted(
  db: Database,
  mailboxId: string,
  userId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at)
       SELECT ?, ?, NULL, ? WHERE changes() = 0`,
    )
    .bind(mailboxId, userId, '');
}

/**
 * Inserts a mailbox row into the mailboxes table.
 *
 * R-DATA-004: Uses parameterized query, never string concatenation.
 *
 * @throws D1 error with "UNIQUE constraint failed: mailboxes.domain_id, mailboxes.local_part"
 *         on duplicate address (case-insensitive).
 */
export async function createMailbox(db: Database, input: CreateMailboxInput): Promise<MailboxInfo> {
  await db
    .prepare(
      `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.id,
      input.domainId,
      input.ownerUserId,
      input.localPart,
      input.displayName,
      input.status,
      input.createdAt,
      input.updatedAt,
    )
    .run();

  // Fetch the domain name to construct the full address
  const domain = await db
    .prepare('SELECT name FROM managed_domains WHERE id = ?')
    .bind(input.domainId)
    .first<{ name: string }>();

  if (!domain) {
    throw new Error(`Domain not found: ${input.domainId}`);
  }

  const address = `${input.localPart}@${domain.name}`;

  return {
    id: input.id,
    address,
    displayName: input.displayName,
    status: input.status,
    domainId: input.domainId,
    localPart: input.localPart,
    ownerUserId: input.ownerUserId,
  };
}

/**
 * Finds a mailbox by its ID.
 *
 * Returns the mailbox with full address (localPart@domain.name) or null.
 */
export async function findMailboxById(
  db: Database,
  mailboxId: string,
): Promise<MailboxInfo | null> {
  const result = await db
    .prepare(
      `SELECT
        m.id,
        m.domain_id,
        m.owner_user_id,
        m.local_part,
        m.display_name,
        m.status,
        d.name as domain_name
       FROM mailboxes m
       JOIN managed_domains d ON m.domain_id = d.id
       WHERE m.id = ?`,
    )
    .bind(mailboxId)
    .first<{
      id: string;
      domain_id: string;
      owner_user_id: string;
      local_part: string;
      display_name: string;
      status: string;
      domain_name: string;
    }>();

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    address: `${result.local_part}@${result.domain_name}`,
    displayName: result.display_name,
    status: result.status,
    domainId: result.domain_id,
    localPart: result.local_part,
    ownerUserId: result.owner_user_id,
  };
}

/**
 * Finds a mailbox by its address (localPart@domain.name, case-insensitive).
 *
 * Looks up the domain by name first, then finds the mailbox.
 * Returns null if no matching mailbox exists.
 */
export async function findMailboxByAddress(
  db: Database,
  address: string,
): Promise<MailboxInfo | null> {
  // Parse the address into localPart and domainName
  const atIdx = address.lastIndexOf('@');
  if (atIdx === -1) {
    return null;
  }

  const localPart = address.slice(0, atIdx);
  const domainName = address.slice(atIdx + 1);

  // Find the domain by name (case-insensitive)
  const domain = await db
    .prepare("SELECT id, name FROM managed_domains WHERE name = ? AND status = 'active' LIMIT 1")
    .bind(domainName.toLowerCase())
    .first<{ id: string; name: string }>();

  if (!domain) {
    return null;
  }

  // Find the mailbox by domainId and localPart (case-insensitive via index)
  const result = await db
    .prepare(
      `SELECT id, domain_id, owner_user_id, local_part, display_name, status
       FROM mailboxes
       WHERE domain_id = ? AND local_part = ? COLLATE NOCASE AND status = 'active'
       LIMIT 1`,
    )
    .bind(domain.id, localPart)
    .first<{
      id: string;
      domain_id: string;
      owner_user_id: string;
      local_part: string;
      display_name: string;
      status: string;
    }>();

  if (!result) {
    return null;
  }

  return {
    id: result.id,
    address: `${result.local_part}@${domain.name}`,
    displayName: result.display_name,
    status: result.status,
    domainId: result.domain_id,
    localPart: result.local_part,
    ownerUserId: result.owner_user_id,
  };
}

/**
 * Resolve the envelope in one lookup. An explicitly disabled/deleted address
 * remains rejected; only an absent address can use its own domain's fallback.
 */
export async function resolveInboundMailbox(
  db: Database,
  address: string,
  catchAllAddress?: string,
): Promise<MailboxInfo | null> {
  const recipient = emailAddressSchema.safeParse(address);
  if (!recipient.success) return null;
  const [localPart, domainName] = recipient.data.toLowerCase().split('@');
  const fallback = emailAddressSchema.safeParse(catchAllAddress);
  const [fallbackLocal, fallbackDomain] = fallback.success
    ? fallback.data.toLowerCase().split('@')
    : ['', ''];
  const fallbackPart = fallbackDomain === domainName ? fallbackLocal : localPart;
  const result = await db
    .prepare(
      `SELECT m.id, m.domain_id, m.owner_user_id, m.local_part, m.display_name,
              m.status, d.name AS domain_name
       FROM mailboxes m JOIN managed_domains d ON d.id = m.domain_id
       WHERE d.name = ? AND d.status = 'active'
         AND (m.local_part = ? COLLATE NOCASE OR m.local_part = ? COLLATE NOCASE)
       ORDER BY CASE WHEN m.local_part = ? COLLATE NOCASE THEN 0 ELSE 1 END
       LIMIT 1`,
    )
    .bind(domainName, localPart, fallbackPart, localPart)
    .first<{
      id: string;
      domain_id: string;
      owner_user_id: string;
      local_part: string;
      display_name: string;
      status: string;
      domain_name: string;
    }>();
  if (!result || result.status !== 'active') return null;
  return {
    id: result.id,
    address: `${result.local_part}@${result.domain_name}`,
    displayName: result.display_name,
    status: result.status,
    domainId: result.domain_id,
    localPart: result.local_part,
    ownerUserId: result.owner_user_id,
  };
}

/**
 * Lists all mailboxes accessible to a user through ownership or membership.
 *
 * Returns mailboxes with full addresses. Includes mailboxes where the user
 * is the owner or a member (via mailbox_members table).
 */
export async function listMailboxesByUser(db: Database, userId: string): Promise<MailboxInfo[]> {
  const results = await db
    .prepare(
      `SELECT DISTINCT
        m.id,
        m.domain_id,
        m.owner_user_id,
        m.local_part,
        m.display_name,
        m.status,
        d.name as domain_name
       FROM mailboxes m
       JOIN managed_domains d ON m.domain_id = d.id
       LEFT JOIN mailbox_members mm ON m.id = mm.mailbox_id
       WHERE m.owner_user_id = ? OR mm.user_id = ?
       ORDER BY m.created_at DESC`,
    )
    .bind(userId, userId)
    .all<{
      id: string;
      domain_id: string;
      owner_user_id: string;
      local_part: string;
      display_name: string;
      status: string;
      domain_name: string;
    }>();

  return (
    results.results?.map((r) => ({
      id: r.id,
      address: `${r.local_part}@${r.domain_name}`,
      displayName: r.display_name,
      status: r.status,
      domainId: r.domain_id,
      localPart: r.local_part,
      ownerUserId: r.owner_user_id,
    })) ?? []
  );
}

/**
 * Finds a mailbox member record.
 *
 * Returns the member role if the user is a member of the mailbox, null otherwise.
 * The owner is NOT returned as a member (R-MAILBOX-003: implicit membership).
 */
export async function findMailboxMember(
  db: Database,
  mailboxId: string,
  userId: string,
): Promise<MailboxMemberInfo | null> {
  const result = await db
    .prepare(
      'SELECT mailbox_id, user_id, role FROM mailbox_members WHERE mailbox_id = ? AND user_id = ?',
    )
    .bind(mailboxId, userId)
    .first<{ mailbox_id: string; user_id: string; role: 'viewer' | 'sender' | 'admin' }>();

  if (!result) {
    return null;
  }

  return {
    mailboxId: result.mailbox_id,
    userId: result.user_id,
    role: result.role,
  };
}

/** Lists explicit members in deterministic creation/id order. */
export async function listMailboxMemberRows(
  db: Database,
  mailboxId: string,
): Promise<MailboxMemberRow[]> {
  const results = await db
    .prepare(
      `SELECT mailbox_id, user_id, role, created_at
       FROM mailbox_members
       WHERE mailbox_id = ?
       ORDER BY created_at ASC, user_id ASC`,
    )
    .bind(mailboxId)
    .all<{
      mailbox_id: string;
      user_id: string;
      role: MailboxMemberRole;
      created_at: string;
    }>();

  return (
    results.results?.map((row) => ({
      mailboxId: row.mailbox_id,
      userId: row.user_id,
      role: row.role,
      createdAt: row.created_at,
    })) ?? []
  );
}

/** Metadata only: system administrators do not gain access to message content. */
export async function listAdministrativeMailboxes(
  db: Database,
  userId: string | null,
): Promise<AdminUserMailboxItem[]> {
  const rows = await db
    .prepare(
      `
    SELECT m.id, m.domain_id, m.owner_user_id, m.local_part, m.display_name, m.status,
      d.name AS domain_name, mm.role
    FROM mailboxes m JOIN managed_domains d ON d.id = m.domain_id
    LEFT JOIN mailbox_members mm ON mm.mailbox_id = m.id AND mm.user_id = ?
    WHERE m.status = 'active' AND d.status = 'active'
    ORDER BY d.name, m.local_part, m.id
  `,
    )
    .bind(userId)
    .all<{
      id: string;
      domain_id: string;
      owner_user_id: string;
      local_part: string;
      display_name: string;
      status: string;
      domain_name: string;
      role: MailboxMemberRole | null;
    }>();
  return (rows.results ?? []).map((row) => ({
    id: row.id,
    address: `${row.local_part}@${row.domain_name}`,
    displayName: row.display_name,
    status: row.status,
    domainId: row.domain_id,
    localPart: row.local_part,
    ownerUserId: row.owner_user_id,
    role: row.owner_user_id === userId ? 'owner' : row.role,
  }));
}

export function prepareSetMailboxMemberRole(
  db: Database,
  input: CreateMailboxMemberInput,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mailbox_members (mailbox_id, user_id, role, created_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(mailbox_id, user_id) DO UPDATE SET role = excluded.role`,
    )
    .bind(input.mailboxId, input.userId, input.role, input.createdAt);
}
