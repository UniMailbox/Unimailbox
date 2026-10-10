// packages/contracts/src/admin/blocklist.ts — D-CAP-021 / CAP-035.
// Inbound blocklist contracts (R-INBOUND-005).
//
// Blocklist matches on subject, content, and `from`. Three `kind` values:
// 'subject' | 'content' | 'from'. Pattern is a case-insensitive substring.
// No regex in v1 (substring only — keeps the security surface flat).
//
// The storage table (blocklist_entries) is owned by the admin module. The
// inbound-mail module reads through the BlocklistReader interface declared
// below — the architecture edge `inbound-mail → admin (via contracts)` is
// documented in the contract's `Decisions` section.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Kinds — closed enum; adding a value is a deliberate change.
// ---------------------------------------------------------------------------

export const blocklistKindSchema = z.enum(['subject', 'content', 'from']);

export type BlocklistKind = z.infer<typeof blocklistKindSchema>;

// ---------------------------------------------------------------------------
// Request / response shapes for the admin API surface
// ---------------------------------------------------------------------------

/**
 * Request body for POST /api/v1/admin/blocklist.
 * - kind: which header to match against ('subject' | 'content' | 'from')
 * - pattern: case-insensitive substring (1-512 chars; no regex in v1)
 */
export const createBlocklistEntryRequestSchema = z.object({
  kind: blocklistKindSchema,
  pattern: z.string().trim().min(1).max(512),
});

export type CreateBlocklistEntryRequest = z.infer<typeof createBlocklistEntryRequestSchema>;

/**
 * Response item for GET /api/v1/admin/blocklist.
 * Never returns anything more than id + kind + pattern + timestamps + createdBy.
 */
export const blocklistEntrySchema = z.object({
  id: z.string(),
  kind: blocklistKindSchema,
  pattern: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
});

export type BlocklistEntry = z.infer<typeof blocklistEntrySchema>;

// ---------------------------------------------------------------------------
// Storage row — used by repositories internally. Snake-case (DB) → camelCase
// is the responsibility of the repository layer.
// ---------------------------------------------------------------------------

export interface BlocklistEntryRow {
  readonly id: string;
  readonly kind: BlocklistKind;
  readonly pattern: string;
  readonly created_by: string | null;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Cross-module read surface
// ---------------------------------------------------------------------------

/**
 * The inbound-mail module depends on this interface — never on the admin
 * module directly. Implementations live in
 * apps/worker/src/modules/admin/blocklist-repository.ts and are wired through
 * apps/worker/src/app-context.ts (composition root). Same pattern as the
 * outbound provider registry (ADR-002).
 *
 * R-INBOUND-005: the inbound-mail handler loads ALL active blocklist entries
 * once per message (a typical deployment has tens, not thousands).
 */
export interface BlocklistReader {
  loadActiveBlocklistEntries(): Promise<ReadonlyArray<BlocklistEntryRow>>;
}
