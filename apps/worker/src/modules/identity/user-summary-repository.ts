// user-summary-repository — the narrow, credential-free Identity seam used
// by tenancy mailbox sharing. Password-bearing UserRow never crosses this
// boundary.

import { emailAddressSchema, type EmailAddress } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';

export interface PublicUserSummary {
  readonly userId: string;
  readonly email: EmailAddress;
  readonly displayName: string | null;
}

interface UserSummaryRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string | null;
}

function toSummary(row: UserSummaryRow): PublicUserSummary {
  return {
    userId: row.id,
    email: emailAddressSchema.parse(row.email),
    displayName: row.display_name,
  };
}

/** Finds an active user by normalized email without selecting credentials. */
export async function findActiveUserByEmail(
  db: Database,
  email: EmailAddress,
): Promise<PublicUserSummary | null> {
  const row = await db
    .prepare(
      `SELECT id, email, display_name
       FROM users
       WHERE email = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(email)
    .first<UserSummaryRow>();

  return row ? toSummary(row) : null;
}

/** Finds an active user by id without selecting credentials. */
export async function findActiveUserById(
  db: Database,
  userId: string,
): Promise<PublicUserSummary | null> {
  const row = await db
    .prepare(
      `SELECT id, email, display_name
       FROM users
       WHERE id = ? AND status = 'active'
       LIMIT 1`,
    )
    .bind(userId)
    .first<UserSummaryRow>();

  return row ? toSummary(row) : null;
}

/** Finds several active users without exposing credentials or issuing N+1 queries. */
export async function findActiveUsersByIds(
  db: Database,
  userIds: readonly string[],
): Promise<PublicUserSummary[]> {
  if (userIds.length === 0) return [];

  // Keep each parameterized query below SQLite/D1's bind-variable limit;
  // this remains bounded by chunks rather than one query per member.
  const summaries: PublicUserSummary[] = [];
  for (let offset = 0; offset < userIds.length; offset += 100) {
    const chunk = userIds.slice(offset, offset + 100);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = await db
      .prepare(
        `SELECT id, email, display_name
         FROM users
         WHERE status = 'active' AND id IN (${placeholders})`,
      )
      .bind(...chunk)
      .all<UserSummaryRow>();
    summaries.push(...(rows.results?.map(toSummary) ?? []));
  }

  return summaries;
}
