import type { AdminOverviewResponse, AdminOverviewStats } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';

interface OverviewRow {
  readonly total_messages: number;
  readonly unread_messages: number;
  readonly received_messages: number;
  readonly sent_messages: number;
  readonly draft_messages: number;
  readonly mailbox_count: number;
  readonly domain_count: number;
}

interface DomainRow {
  readonly id: string;
  readonly name: string;
}

/** Reads the mailbox/message counters used by the administrator overview. */
export async function readAdminOverview(
  db: Database,
  domainId?: string,
): Promise<AdminOverviewResponse> {
  const domain = domainId
    ? await db
        .prepare('SELECT id, name FROM managed_domains WHERE id = ? LIMIT 1')
        .bind(domainId)
        .first<DomainRow>()
    : null;

  const filter =
    domainId === undefined
      ? "WHERE mb.status <> 'deleted'"
      : "WHERE mb.status <> 'deleted' AND mb.domain_id = ?";
  const statement = db.prepare(
    `SELECT
       COUNT(DISTINCT m.id) AS total_messages,
       COUNT(DISTINCT CASE WHEN mm.is_read = 0 THEN m.id END) AS unread_messages,
       COUNT(DISTINCT CASE WHEN mm.folder = 'inbox' THEN m.id END) AS received_messages,
       COUNT(DISTINCT CASE WHEN mm.folder = 'sent' THEN m.id END) AS sent_messages,
       COUNT(DISTINCT CASE WHEN mm.folder = 'drafts' THEN m.id END) AS draft_messages,
       COUNT(DISTINCT mb.id) AS mailbox_count,
       COUNT(DISTINCT mb.domain_id) AS domain_count
     FROM mailbox_messages mm
     JOIN messages m ON m.id = mm.message_id
     JOIN mailboxes mb ON mb.id = mm.mailbox_id
     ${filter}`,
  );
  const row = (domainId === undefined
    ? await statement.first<OverviewRow>()
    : await statement.bind(domainId).first<OverviewRow>()) ?? {
    total_messages: 0,
    unread_messages: 0,
    received_messages: 0,
    sent_messages: 0,
    draft_messages: 0,
    mailbox_count: 0,
    domain_count: 0,
  };

  const stats: AdminOverviewStats = {
    totalMessages: Number(row.total_messages ?? 0),
    unreadMessages: Number(row.unread_messages ?? 0),
    receivedMessages: Number(row.received_messages ?? 0),
    sentMessages: Number(row.sent_messages ?? 0),
    draftMessages: Number(row.draft_messages ?? 0),
    mailboxCount: Number(row.mailbox_count ?? 0),
    domainCount: Number(row.domain_count ?? 0),
  };

  return {
    scope: {
      domainId: domain?.id ?? null,
      domainName: domain?.name ?? null,
    },
    stats,
  };
}
