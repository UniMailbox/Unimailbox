// http/routes/admin-blocklist — D-CAP-021 / CAP-035.
// Hono sub-app for /api/v1/admin/blocklist/* endpoints.
//
// R-INBOUND-005: the blocklist is a global list of (kind, pattern) pairs
// applied to every inbound message before persistence. Patterns are
// case-insensitive substrings.
//
// R-AUTHZ-001: requires 'settings.manage' (the closest existing permission
// to "edit the security policy" without inventing a new key — R-AUTHZ-001
// says the PermissionKey enum is closed, so we reuse what's there).
//
// CAP-027 / ADR-004: writes enforce Idempotency-Key. Reads do not.

import { Hono } from 'hono';
import {
  createBlocklistEntryRequestSchema,
  type BlocklistEntry,
  type BlocklistEntryRow,
} from '@unimailbox/contracts';
import { requirePermission } from '../middleware/authz';
import { requireIdempotencyKey } from '../middleware/idempotency';
import {
  listBlocklistEntries,
  prepareCreateBlocklistEntry,
  prepareDeleteBlocklistEntry,
  prepareCreateAuditEvent,
  findBlocklistEntryById,
} from '../../modules/admin';
import { systemIds } from '../../platform/ids';
import { systemClock } from '../../platform/clock';
import {
  sha256Hex,
  sqliteTimestamp,
  prepareCreateIdempotencyRecord,
  findIdempotencyRecord,
  assertSameRequestHash,
} from '../../platform/idempotency';
import { DomainError } from '../../platform/errors';
import type { AppEnv } from '../../platform/env';
import { parseJsonBody } from '../middleware/parse-json-body';

const OPERATION_CREATE = 'POST /api/v1/admin/blocklist';

export function adminBlocklistRoutes(): Hono<AppEnv> {
  const routes = new Hono<AppEnv>();

  // POST /api/v1/admin/blocklist — create an entry.
  routes.post(
    '/blocklist',
    requirePermission('settings.manage'),
    requireIdempotencyKey,
    async (c) => {
      const userId = c.get('userId');
      if (!userId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }

      const idempotencyKey = c.get('idempotencyKey');
      if (!idempotencyKey) {
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header required',
          httpStatus: 400,
        });
      }

      const rawBody = await c.req.text();
      const requestHash = await sha256Hex(rawBody);

      const existing = await findIdempotencyRecord(
        c.env.DB,
        userId,
        OPERATION_CREATE,
        idempotencyKey,
      );
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        return new Response(existing.responseJson, {
          status: existing.responseStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // R-INPUT-002 / D-CAP-037-A: helper throws INVALID_JSON before the
      // D1 batch, so no idempotency_records row is written on malformed
      // bodies (a corrected retry with the same Idempotency-Key succeeds).
      const body = parseJsonBody(rawBody, createBlocklistEntryRequestSchema, {
        event: 'blocklist.post.invalid_json',
        actorUserId: userId,
      });

      const id = systemIds.uuid();
      const now = sqliteTimestamp(systemClock.now());

      const responseJson = JSON.stringify({
        data: {
          id,
          kind: body.kind,
          pattern: body.pattern.toLowerCase(),
          createdBy: userId,
          createdAt: now,
        },
      });

      // R-AUDIT-001: every state transition writes an audit row. The
      // business write, the idempotency record, and the audit row all land
      // in one D1 batch so a crash between them cannot produce a state
      // change without the matching audit entry.
      await c.env.DB.batch([
        prepareCreateBlocklistEntry(c.env.DB, {
          id,
          kind: body.kind,
          pattern: body.pattern.toLowerCase(),
          createdBy: userId,
          createdAt: now,
        }),
        prepareCreateAuditEvent(c.env.DB, {
          id: systemIds.uuid(),
          actorUserId: userId,
          action: 'blocklist.create',
          resourceType: 'blocklist_entry',
          resourceId: id,
          createdAt: now,
        }),
        prepareCreateIdempotencyRecord(c.env.DB, {
          id: systemIds.uuid(),
          actorId: userId,
          operation: OPERATION_CREATE,
          idempotencyKey,
          requestHash,
          responseStatus: 201,
          responseJson,
          createdAt: now,
        }),
      ]);

      return new Response(responseJson, {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  // GET /api/v1/admin/blocklist — list entries.
  routes.get('/blocklist', requirePermission('settings.manage'), async (c) => {
    const rows = await listBlocklistEntries(c.env.DB);
    const entries: BlocklistEntry[] = rows.map(rowToEntry);
    return c.json({ data: { entries } });
  });

  // DELETE /api/v1/admin/blocklist/:id — delete by id.
  routes.delete(
    '/blocklist/:id',
    requirePermission('settings.manage'),
    requireIdempotencyKey,
    async (c) => {
      const userId = c.get('userId');
      if (!userId) {
        throw new DomainError({
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication required',
          httpStatus: 401,
        });
      }

      const idempotencyKey = c.get('idempotencyKey');
      if (!idempotencyKey) {
        throw new DomainError({
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Idempotency-Key header required',
          httpStatus: 400,
        });
      }

      const id = c.req.param('id');
      if (!id) {
        throw new DomainError({
          code: 'VALIDATION_ERROR',
          message: 'id path param required',
          httpStatus: 400,
        });
      }

      // Include the path id in the operation string so two DELETEs against
      // different ids do not share an idempotency record (R-AUTHZ-004:
      // different resources, different idempotency namespace).
      const operation = `DELETE /api/v1/admin/blocklist/${id}`;

      // Empty body — hash an empty string so the lookup uses a stable value.
      const requestHash = await sha256Hex('');

      const existing = await findIdempotencyRecord(c.env.DB, userId, operation, idempotencyKey);
      if (existing) {
        assertSameRequestHash(existing, requestHash);
        return new Response(existing.responseJson, {
          status: existing.responseStatus,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Existence check before batching — the audit row only exists when
      // a row is actually removed. CAP-035 / R-AUDIT-001.
      const entry = await findBlocklistEntryById(c.env.DB, id);
      const now = sqliteTimestamp(systemClock.now());

      if (!entry) {
        // No business write happened, so no audit row is required.
        // We do NOT write an idempotency record for this 404: a retry
        // with the same Idempotency-Key + same id will re-hit this
        // branch (the entry is still absent) and produce the same
        // outcome. errorMiddleware renders the canonical envelope.
        // CAP-032 / R-API-001.
        throw new DomainError({
          code: 'BLOCKLIST_ENTRY_NOT_FOUND',
          message: `Blocklist entry not found: ${id}`,
          httpStatus: 404,
        });
      }

      const responseJson = JSON.stringify({ data: { id, deleted: true } });

      // R-AUDIT-001: every state transition writes an audit row. The
      // business DELETE, the audit row, and the idempotency record all
      // land in one D1 batch so a crash between them cannot produce a
      // state change without the matching audit entry.
      await c.env.DB.batch([
        prepareDeleteBlocklistEntry(c.env.DB, id),
        prepareCreateAuditEvent(c.env.DB, {
          id: systemIds.uuid(),
          actorUserId: userId,
          action: 'blocklist.delete',
          resourceType: 'blocklist_entry',
          resourceId: id,
          createdAt: now,
        }),
        prepareCreateIdempotencyRecord(c.env.DB, {
          id: systemIds.uuid(),
          actorId: userId,
          operation,
          idempotencyKey,
          requestHash,
          responseStatus: 200,
          responseJson,
          createdAt: now,
        }),
      ]);

      return new Response(responseJson, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  );

  return routes;
}

function rowToEntry(row: BlocklistEntryRow): BlocklistEntry {
  return {
    id: row.id,
    kind: row.kind,
    pattern: row.pattern,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
