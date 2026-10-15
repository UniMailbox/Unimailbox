import type { CreateMcpToken, McpConfiguration } from '@unimailbox/contracts';
import type { Database } from '../../platform/database';
import { DomainError } from '../../platform/errors';
import {
  sha256Hex,
  findIdempotencyRecord,
  assertSameRequestHash,
  prepareCreateIdempotencyRecord,
  isIdempotencyUniqueViolation,
  sqliteTimestamp,
} from '../../platform/idempotency';
import { findUserById } from '../identity';
import { assertCan, listMailboxesByUser, findMailboxById, findMailboxMember } from '../tenancy';
import { checkPermission } from './permission-repository';
import { prepareCreateAuditEvent } from './audit-event-repository';
import {
  readMcpConfiguration,
  listMcpTokens,
  readMcpTokenById,
  readMcpTokenByHash,
  mcpTokenMetadata,
  consumeMcpRateLimit,
} from './mcp-repository';

export async function getMcpAdministration(db: Database, userId: string, endpoint: string) {
  const { configuration, revision } = await readMcpConfiguration(db);
  return {
    configuration,
    revision,
    endpoint,
    canManage: await checkPermission(db, userId, 'settings.manage'),
  };
}
export async function getPersonalMcpSettings(db: Database, userId: string, endpoint: string) {
  const { configuration } = await readMcpConfiguration(db);
  const canRead = await checkPermission(db, userId, 'message.read');
  const canSend = canRead && (await checkPermission(db, userId, 'message.send'));
  const mailboxes = canRead
    ? (await listMailboxesByUser(db, userId)).filter((b) => b.status === 'active')
    : [];
  return {
    enabled: configuration.enabled,
    endpoint,
    promptTemplate: configuration.promptTemplate,
    ...(await listMcpTokens(db, userId)),
    mailboxes: await Promise.all(
      mailboxes.map(async (b) => ({
        id: b.id,
        address: b.address,
        canWrite:
          canSend &&
          (b.ownerUserId === userId ||
            ['sender', 'admin'].includes((await findMailboxMember(db, b.id, userId))?.role ?? '')),
      })),
    ),
  };
}

export async function getPersonalMcpTokenPage(db: Database, userId: string, cursor?: string) {
  return listMcpTokens(db, userId, cursor);
}

interface Mutation {
  actorUserId: string;
  idempotencyKey: string;
  requestHash: string;
  requestId: string | null;
}
function audit(
  db: Database,
  input: Mutation,
  action: 'mcp.configuration_updated' | 'mcp.token_created' | 'mcp.token_revoked',
  id: string,
) {
  return prepareCreateAuditEvent(db, {
    id: crypto.randomUUID(),
    actorUserId: input.actorUserId,
    action,
    resourceType: 'mcp',
    resourceId: id,
    requestId: input.requestId,
    metadata: '{}',
    createdAt: sqliteTimestamp(new Date()),
  });
}
async function replay(db: Database, input: Mutation, operation: string): Promise<string | null> {
  const r = await findIdempotencyRecord(db, input.actorUserId, operation, input.idempotencyKey);
  if (!r) return null;
  assertSameRequestHash(r, input.requestHash);
  return r.responseJson;
}
function record(db: Database, input: Mutation, operation: string, json: string) {
  return prepareCreateIdempotencyRecord(db, {
    id: crypto.randomUUID(),
    actorId: input.actorUserId,
    operation,
    idempotencyKey: input.idempotencyKey,
    requestHash: input.requestHash,
    responseStatus: 200,
    responseJson: json,
    createdAt: sqliteTimestamp(new Date()),
  });
}
async function settle(
  db: Database,
  input: Mutation,
  operation: string,
  statements: D1PreparedStatement[],
  json: string,
): Promise<string> {
  try {
    await db.batch([...statements, record(db, input, operation, json)]);
    return json;
  } catch (e) {
    if (isIdempotencyUniqueViolation(e)) {
      const r = await replay(db, input, operation);
      if (r !== null) return r;
    }
    throw e;
  }
}
export async function updateMcpConfiguration(
  db: Database,
  input: Mutation & { configuration: McpConfiguration; revision: number },
): Promise<string> {
  const operation = 'PUT /api/v1/admin/mcp';
  const old = await replay(db, input, operation);
  if (old !== null) return old;
  const current = await readMcpConfiguration(db);
  if (current.revision !== input.revision)
    throw new DomainError({
      code: 'STALE_IF_MATCH',
      message: 'MCP configuration changed',
      httpStatus: 412,
    });
  const c = input.configuration;
  const json = JSON.stringify({ data: { configuration: c, revision: current.revision + 1 } });
  try {
    return await settle(
      db,
      input,
      operation,
      [
        db
          .prepare(
            `UPDATE mcp_configuration SET enabled=?,revision=CASE WHEN revision=? THEN revision+1 ELSE -1 END WHERE id='system'`,
          )
          .bind(c.enabled ? 1 : 0, input.revision),
        db
          .prepare("UPDATE mcp_prompt SET prompt_template=? WHERE id='system'")
          .bind(c.promptTemplate),
        audit(db, input, 'mcp.configuration_updated', 'system'),
      ],
      json,
    );
  } catch (e) {
    if (e instanceof Error && e.message.includes('CHECK constraint failed: revision >= 0'))
      throw new DomainError({
        code: 'STALE_IF_MATCH',
        message: 'MCP configuration changed',
        httpStatus: 412,
      });
    throw e;
  }
}
export async function issueMcpToken(
  db: Database,
  input: Mutation & { request: CreateMcpToken },
): Promise<string> {
  const operation = 'POST /api/v1/auth/me/mcp/tokens';
  const old = await replay(db, input, operation);
  if (old !== null) return old;
  const { configuration } = await readMcpConfiguration(db);
  if (!configuration.enabled)
    throw new DomainError({
      code: 'MCP_DISABLED',
      message: 'MCP service is disabled',
      httpStatus: 503,
    });
  const user = await findUserById(db, input.actorUserId);
  if (!user || user.status !== 'active' || user.must_change_password === 1)
    throw new DomainError({
      code: 'PERMISSION_DENIED',
      message: 'Active account required',
      httpStatus: 403,
    });
  const r = input.request;
  for (const permission of (r.allowDraft || r.allowSend
    ? ['message.read', 'message.send']
    : ['message.read']) as Array<'message.read' | 'message.send'>) {
    if (
      !(await checkPermission(db, input.actorUserId, permission as 'message.read' | 'message.send'))
    )
      throw new DomainError({
        code: 'PERMISSION_DENIED',
        message: 'Mail permission required',
        httpStatus: 403,
      });
  }
  for (const id of r.mailboxIds) {
    if ((await findMailboxById(db, id))?.status !== 'active')
      throw new DomainError({
        code: 'MAILBOX_ACCESS_DENIED',
        message: 'Active mailbox required',
        httpStatus: 403,
      });
    await assertCan(db, input.actorUserId, id, 'read');
    if (r.allowDraft || r.allowSend) await assertCan(db, input.actorUserId, id, 'send');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = 'umcp_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const id = crypto.randomUUID();
  const credential = {
    id,
    label: r.label,
    allowDraft: r.allowDraft,
    allowSend: r.allowSend,
    mailboxIds: r.mailboxIds,
    expiresAt: Math.floor(Date.now() / 1000) + r.expiresInDays * 86400,
    revokedAt: null,
    createdAt: sqliteTimestamp(new Date()),
  };
  const redacted = JSON.stringify({ data: { credential, token: null } });
  const stored = await settle(
    db,
    input,
    operation,
    [
      db
        .prepare(
          'INSERT INTO mcp_tokens(id,user_id,label,token_hash,allow_draft,allow_send,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)',
        )
        .bind(
          id,
          input.actorUserId,
          r.label,
          await sha256Hex(token),
          r.allowDraft ? 1 : 0,
          r.allowSend ? 1 : 0,
          credential.expiresAt,
          credential.createdAt,
        ),
      ...r.mailboxIds.map((box) =>
        db
          .prepare('INSERT INTO mcp_token_mailboxes(token_id,mailbox_id) VALUES(?,?)')
          .bind(id, box),
      ),
      audit(db, input, 'mcp.token_created', id),
    ],
    redacted,
  );
  // A competing/replayed request never reveals another token or stores secret bytes.
  return stored === redacted ? JSON.stringify({ data: { credential, token } }) : stored;
}
export async function revokeMcpToken(
  db: Database,
  input: Mutation & { id: string },
): Promise<string> {
  const operation = `POST /api/v1/auth/me/mcp/tokens/${input.id}/revoke`;
  const old = await replay(db, input, operation);
  if (old !== null) return old;
  if (!(await readMcpTokenById(db, input.id, input.actorUserId)))
    throw new DomainError({
      code: 'NOT_FOUND',
      message: 'MCP credential not found',
      httpStatus: 404,
    });
  return settle(
    db,
    input,
    operation,
    [
      db
        .prepare('UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND user_id=?')
        .bind(Math.floor(Date.now() / 1000), input.id, input.actorUserId),
      audit(db, input, 'mcp.token_revoked', input.id),
    ],
    JSON.stringify({ data: { revoked: true } }),
  );
}
export async function authenticateMcp(db: Database, token: string) {
  const { configuration, requestsPerMinute } = await readMcpConfiguration(db);
  if (!configuration.enabled)
    throw new DomainError({
      code: 'MCP_DISABLED',
      message: 'MCP service is disabled',
      httpStatus: 503,
    });
  const fail = () =>
    new DomainError({
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Valid MCP credential required',
      httpStatus: 401,
    });
  if (!/^umcp_[a-f0-9]{64}$/.test(token)) throw fail();
  const row = await readMcpTokenByHash(db, await sha256Hex(token));
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.revoked_at !== null || row.expires_at <= now) throw fail();
  const user = await findUserById(db, row.user_id);
  if (!user || user.status !== 'active' || user.must_change_password === 1) throw fail();
  if (!(await consumeMcpRateLimit(db, row.id, requestsPerMinute, now)))
    throw new DomainError({
      code: 'MCP_RATE_LIMITED',
      message: 'MCP request limit exceeded',
      httpStatus: 429,
    });
  return { userId: row.user_id, token: await mcpTokenMetadata(db, row), configuration };
}

export async function auditMcpTool(
  db: Database,
  userId: string,
  tokenId: string,
  tool: string,
  succeeded: boolean,
  requestId: string | null,
): Promise<void> {
  await prepareCreateAuditEvent(db, {
    id: crypto.randomUUID(),
    actorUserId: userId,
    action: 'mcp.tool_called',
    resourceType: 'mcp',
    resourceId: tokenId,
    requestId,
    metadata: JSON.stringify({ tool, succeeded }),
    createdAt: sqliteTimestamp(new Date()),
  }).run();
}
