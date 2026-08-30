// packages/contracts/src/cursor.ts — cursor pagination primitives.
//
// CAP-044 Slice 3 amendment (cursor-payload promotion): `listUsers` is
// the THIRD consumer of the HMAC cursor mechanism (`platform/cursor.ts`
// in the worker), which fires the promotion trigger recorded in the
// CAP-044 Slice 2 review note — the payload SCHEMA and the closed
// surface union move into contracts so every paginated API agrees on
// one wire shape. The crypto (sign / verify / base64url) stays in the
// worker's `platform/cursor.ts`; this file owns the payload contract
// only.
//
// Surfaces (closed union — adding one is a deliberate change):
//   - 'messages'     — GET /api/v1/mailboxes/:id/messages (CAP-043)
//   - 'audit-events' — GET /api/v1/admin/audit-events (CAP-044 Slice 2)
//   - 'admin-users'  — GET /api/v1/admin/users (CAP-044 Slice 3)
//
// The `surface` discriminator (CAP-044 Slice 2 fix (d)) prevents a
// cursor minted by one API from being replayed against another — every
// consumer signs and verifies with its own surface even though all
// share one signing key (`CURSOR_SIGNING_KEY`).

import { z } from 'zod';

/**
 * Closed union of cursor-minting API surfaces. `verifyCursor` rejects a
 * token whose surface does not match the verifying endpoint, so the
 * union is the complete list of paginated list APIs. Extending it is a
 * deliberate contract change (enum closure, R-API-005).
 */
export const cursorSurfaceSchema = z.enum(['messages', 'audit-events', 'admin-users']);

export type CursorSurface = z.infer<typeof cursorSurfaceSchema>;

/**
 * The opaque payload encoded in every cursor. `createdAt` is the SQLite
 * datetime string the list query uses as the page-boundary key; `id` is
 * the row UUID (the second sort key for deterministic ordering when two
 * rows share a `created_at`); `surface` names the API that minted the
 * cursor. `scope` is an optional endpoint-specific discriminator; the
 * messages list uses `folder:<name>` so a cursor cannot silently cross
 * folder views. A payload missing `surface` fails the schema — intentionally
 * invalidating every pre-surface cursor (accepted pre-launch; see the
 * worker's platform/cursor.ts header note).
 */
export const cursorPayloadSchema = z.object({
  createdAt: z.string().min(1),
  id: z.string().min(1),
  surface: cursorSurfaceSchema,
  scope: z.string().min(1).optional(),
});

export type CursorPayload = z.infer<typeof cursorPayloadSchema>;
