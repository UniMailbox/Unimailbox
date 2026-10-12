import { mcpConfigurationSchema, type McpTokenMetadata } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';

export async function readMcpConfiguration(db: Database) {
  const row = await db
    .prepare(
      'SELECT enabled, allow_send, requests_per_minute, revision FROM mcp_configuration WHERE id=?',
    )
    .bind('system')
    .first<{
      enabled: number;
      allow_send: number;
      requests_per_minute: number;
      revision: number;
    }>();
  if (!row) throw new Error('MCP migration is missing');
  return {
    configuration: mcpConfigurationSchema.parse({
      enabled: row.enabled === 1,
      allowSend: row.allow_send === 1,
      requestsPerMinute: row.requests_per_minute,
    }),
    revision: row.revision,
  };
}
export interface McpTokenRow {
  id: string;
  user_id: string;
  label: string;
  allow_draft: number;
  allow_send: number;
  expires_at: number;
  revoked_at: number | null;
  created_at: string;
}
const TOKEN_COLUMNS =
  'id, user_id, label, allow_draft, allow_send, expires_at, revoked_at, created_at';
export async function readMcpTokenByHash(db: Database, hash: string): Promise<McpTokenRow | null> {
  return db
    .prepare(`SELECT ${TOKEN_COLUMNS} FROM mcp_tokens WHERE token_hash=?`)
    .bind(hash)
    .first<McpTokenRow>();
}
export async function readMcpTokenById(
  db: Database,
  id: string,
  userId: string,
): Promise<McpTokenRow | null> {
  return db
    .prepare(`SELECT ${TOKEN_COLUMNS} FROM mcp_tokens WHERE id=? AND user_id=?`)
    .bind(id, userId)
    .first<McpTokenRow>();
}
export async function mcpTokenMetadata(db: Database, row: McpTokenRow): Promise<McpTokenMetadata> {
  const boxes = await db
    .prepare('SELECT mailbox_id FROM mcp_token_mailboxes WHERE token_id=? ORDER BY mailbox_id')
    .bind(row.id)
    .all<{ mailbox_id: string }>();
  return {
    id: row.id,
    label: row.label,
    allowDraft: row.allow_draft === 1,
    allowSend: row.allow_send === 1,
    mailboxIds: boxes.results.map((b) => b.mailbox_id),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}
export async function listMcpTokens(db: Database, userId: string): Promise<McpTokenMetadata[]> {
  const rows = await db
    .prepare(
      `SELECT ${TOKEN_COLUMNS} FROM mcp_tokens WHERE user_id=? ORDER BY created_at DESC LIMIT 100`,
    )
    .bind(userId)
    .all<McpTokenRow>();
  return Promise.all(rows.results.map((row) => mcpTokenMetadata(db, row)));
}
export async function consumeMcpRateLimit(
  db: Database,
  id: string,
  limit: number,
  now: number,
): Promise<boolean> {
  const window = Math.floor(now / 60);
  const row = await db
    .prepare(
      `INSERT INTO mcp_rate_windows(token_id, window, count) VALUES (?, ?, 1)
    ON CONFLICT(token_id) DO UPDATE SET window=excluded.window, count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END
    WHERE window<>excluded.window OR count<? RETURNING count`,
    )
    .bind(id, window, limit)
    .first();
  return row !== null;
}
