// packages/contracts/src/admin/users.ts — CAP-044 Slice 3 (AC 18).
//
// The read contract for GET /api/v1/admin/users: the identity module's
// `listUsers` (D-CAP-044-H — the users table stays identity-owned; the
// admin route consumes the public read through the allowed
// admin → identity edge) returns rows shaped by `userListItemSchema`,
// wrapped in the standard cursor envelope.
//
// R-SECRET-003 / AC 16: the row carries NO credential material. The
// users table's password columns (algorithm, iterations, salt, hash)
// are excluded by explicit column enumeration in the repository — the
// schema below pins that exclusion contractually: a response row with
// a key matching /hash|credential|secret|token/i cannot parse.
//
// AC 16 status clause: the `users` table HAS an account-status column
// (`status TEXT NOT NULL CHECK (status IN ('active','banned','deleted'))`,
// migration 0001 — R-AUTH-002), so the field ships. It is returned as
// stored; soft-deleted users (status 'deleted') remain visible to the
// administrator — this is a personnel read, not a public directory.

import { z } from 'zod';

/** Closed account-status enum — mirrors the users.status CHECK (R-AUTH-002). */
export const userStatusSchema = z.enum(['active', 'banned', 'deleted']);

export type UserStatus = z.infer<typeof userStatusSchema>;

/**
 * One row in the GET /api/v1/admin/users response. Field names are the
 * camelCase wire forms of the enumerated users columns (id, email,
 * display_name, status, created_at) — nothing else.
 *
 * `displayName` is nullable because the column is (the row is mapped as
 * stored); in practice migration 0014's trigger normalises NULL/empty
 * display_name to the email local part at write time, so populated
 * deployments always serve a non-empty string.
 *
 * `.strict()` — unlike the sibling list schemas — is the R-SECRET-003
 * exclusion made structural: a row carrying any key beyond these five
 * (e.g. a leaked `passwordHash` / `password_salt`) fails to parse, so a
 * client parsing this schema can never admit credential material. The
 * worker's repository enumerates exactly these columns, so strictness
 * cannot reject a well-formed server response.
 */
export const userListItemSchema = z
  .object({
    id: z.string().uuid(),
    email: z.string().min(3).max(254),
    displayName: z.string().nullable(),
    status: userStatusSchema,
    createdAt: z.string().min(1),
  })
  .strict();

export type UserListItem = z.infer<typeof userListItemSchema>;

/**
 * Inner shape of the GET /api/v1/admin/users response body (the
 * envelope's `data` object): `{ data: { items, nextCursor } }` — the
 * same envelope/cursor convention as `messageListResponseSchema` and
 * `auditEventListResponseSchema` (R-API-004/005). The cursor is an
 * HMAC-signed `(createdAt, id, surface: 'admin-users')` token.
 */
export const userListResponseSchema = z.object({
  items: z.array(userListItemSchema),
  nextCursor: z.string().nullable(),
});

export type UserListResponse = z.infer<typeof userListResponseSchema>;

/**
 * Query parameters for GET /api/v1/admin/users, validated at the route
 * boundary from the raw string query record. The users list has no
 * filters (AC 15 — keyset ordering only), so the params are just the
 * cursor and the page size.
 *
 * `limit` is coerced from its string wire form; clamping to the page
 * max (50) happens server-side in the repository — same contract as
 * the messages and audit-events lists.
 */
export const userListQueryParamsSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().positive().optional(),
});

export type UserListQueryParams = z.infer<typeof userListQueryParamsSchema>;
