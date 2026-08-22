// packages/contracts/src/admin/role-policy.ts — D-CAP-021 / CAP-035.
// Per-role policy contracts (R-INBOUND-006).
//
// banEmail patterns: exact email, `@domain`, or `*`. Empty list is fine.
// availDomain patterns: `@domain`. Empty list means allow all (BF-100).
// Patterns are stored as TEXT JSON (R-DATA-005 relaxation — see the
// migration's deferred-normalization comment).
//
// The storage table (role_policies) is owned by the admin module. The
// inbound-mail module reads through the RolePolicyReader interface declared
// below — the architecture edge `inbound-mail → admin (via contracts)` is
// documented in the contract's `Decisions` section.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Pattern shapes
// ---------------------------------------------------------------------------

/**
 * A single banEmail pattern. Three accepted forms:
 * - exact: "spammer@example.com"
 * - domain: "@example.com" (matches anything at that domain, R-DATA-001 lowercased)
 * - wildcard: "*" (matches everything — denies all inbound for the role)
 */
export const banEmailPatternSchema = z
  .string()
  .trim()
  .min(1)
  .max(254)
  .refine(
    (p) => p === '*' || p.startsWith('@') || /^[^\s@]+@[^\s@]+$/.test(p),
    'banEmail must be exact email, @domain, or *',
  );

export type BanEmailPattern = z.infer<typeof banEmailPatternSchema>;

/**
 * A single availDomain pattern. One accepted form: `@domain`.
 * Empty availDomain list means "allow all" (BF-100).
 */
export const availDomainPatternSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(254)
  .regex(
    /^@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/,
    'availDomain must be @domain',
  );

export type AvailDomainPattern = z.infer<typeof availDomainPatternSchema>;

// ---------------------------------------------------------------------------
// Request / response shapes for the admin API surface
// ---------------------------------------------------------------------------

/**
 * Request body for PUT /api/v1/admin/roles/:id/policy. Replaces both arrays
 * atomically (PUT semantics — full replace, no merge).
 */
export const setRolePolicyRequestSchema = z.object({
  banEmail: z.array(banEmailPatternSchema).max(500),
  availDomain: z.array(availDomainPatternSchema).max(500),
});

export type SetRolePolicyRequest = z.infer<typeof setRolePolicyRequestSchema>;

/**
 * Response shape for GET /api/v1/admin/roles/:id/policy. Empty arrays are
 * always returned (not null) — empty availDomain means "allow all".
 */
export const rolePolicySchema = z.object({
  roleId: z.string(),
  banEmail: z.array(banEmailPatternSchema),
  availDomain: z.array(availDomainPatternSchema),
  updatedBy: z.string().nullable(),
  updatedAt: z.string(),
});

export type RolePolicy = z.infer<typeof rolePolicySchema>;

// ---------------------------------------------------------------------------
// Storage row — used by repositories internally. JSON columns are parsed
// inside the repository so the inbound-mail module sees plain arrays.
// ---------------------------------------------------------------------------

export interface RolePolicyRow {
  readonly role_id: string;
  readonly ban_email_patterns_json: string;
  readonly avail_domain_patterns_json: string;
  readonly updated_by: string | null;
  readonly updated_at: string;
}

// ---------------------------------------------------------------------------
// Cross-module read surface
// ---------------------------------------------------------------------------

/**
 * The inbound-mail module depends on this interface — never on the admin
 * module directly. Implementations live in
 * apps/worker/src/modules/admin/role-policy-repository.ts and are wired
 * through apps/worker/src/app-context.ts (composition root).
 *
 * R-INBOUND-006: the inbound-mail handler loads role policies for the
 * recipient mailbox owners once per message. Lookup is keyed by userId →
 * roleIds → role_policies rows. An entry is returned only if the role has a
 * non-default policy (defaults are: banEmail=[], availDomain=[all domains]).
 */
export interface RolePolicyReader {
  loadRolePoliciesForRoleIds(roleIds: ReadonlyArray<string>): Promise<ReadonlyArray<RolePolicyRow>>;
}
