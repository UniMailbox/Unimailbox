import type { Database } from '../../platform/database';

export interface MailboxOutboundConnection {
  readonly id: string;
  readonly providerKey: string;
}

/**
 * Resolve the connection explicitly assigned to a mailbox's managed domain.
 * A global first-active fallback would make multi-domain delivery
 * nondeterministic and could send through the wrong provider.
 */
export async function findActiveOutboundConnectionForMailbox(
  db: Database,
  mailboxId: string,
): Promise<MailboxOutboundConnection | null> {
  const row = await db
    .prepare(
      `SELECT pc.id, pc.provider_key
         FROM mailboxes m
         JOIN managed_domains d ON d.id = m.domain_id
         JOIN provider_connections pc ON pc.id = d.outbound_connection_id
        WHERE m.id = ?
          AND m.status = 'active'
          AND d.status = 'active'
          AND pc.status = 'active'
        LIMIT 1`,
    )
    .bind(mailboxId)
    .first<{ id: string; provider_key: string }>();

  return row === null ? null : { id: row.id, providerKey: row.provider_key };
}

export interface JobOutboundConnection extends MailboxOutboundConnection {
  readonly credentialId: string;
}

/** Resolve a queued job's connection for provider registry dispatch. */
export async function findActiveOutboundConnectionForJob(
  db: Database,
  jobId: string,
): Promise<JobOutboundConnection | null> {
  const row = await db
    .prepare(
      `SELECT pc.id, pc.provider_key, pc.credential_id
         FROM outbound_jobs j
         JOIN provider_connections pc ON pc.id = j.provider_connection_id
        WHERE j.id = ?
          AND pc.status = 'active'
        LIMIT 1`,
    )
    .bind(jobId)
    .first<{ id: string; provider_key: string; credential_id: string }>();

  return row === null
    ? null
    : { id: row.id, providerKey: row.provider_key, credentialId: row.credential_id };
}
