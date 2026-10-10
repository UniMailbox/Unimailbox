# CAP-057 mailbox sharing — independent review

**Reviewer:** Codex orchestration + independent architecture reviewer
**Date:** 2026-08-30
**Scope:** current local CAP-057 diff only; no `.dev.vars`, secret values, remote resources, or deployment

## Verdict

**ACCEPT — 0 BLOCKER, 0 HIGH, 0 MEDIUM, 0 LOW.**

## Evidence

- Tenancy owns all `mailbox_members` SQL. Identity is accessed only through the public,
  credential-free summary seam, with parameterized single/batch lookups.
- The route authorizes the path mailbox before target-user/member reads. Owner or global
  `mailbox.share` is allowed; member-admin alone is not. Missing, foreign, and unauthorized target
  mailboxes share the `404 MAILBOX_NOT_FOUND` envelope.
- POST validates the strict contract before hashing the normalized object. Same-key equivalent JSON
  replays the stored body; same-key different content returns the stable conflict. DELETE also
  requires an idempotency key, uses a guarded delete marker, and handles same-key and different-key
  races without duplicate audit rows.
- Add/remove membership, audit, and idempotency writes are prepared in one D1 batch. Audit rows
  carry actor, mailbox resource, request ID, and only member ID/role metadata. Responses expose only
  `userId`, `email`, `displayName`, `role`, and `createdAt` (or the safe removal result).
- Focused Worker tests cover owner/global/denied access, IDOR/no-leak, active-user and self/duplicate
  validation, canonical replay/conflict, concurrent add/delete races, atomic audit evidence,
  downstream viewer/sender/admin semantics, stable ordering, and no credential projection.

## Validation observed

- `pnpm scaffold doctor`: 14/14
- `pnpm lint`: pass
- `pnpm typecheck`: pass
- `pnpm format:check`: pass
- `pnpm test:unit`: 993/993
- `pnpm test:worker`: 880/880
- `pnpm build`: pass (web + Worker Wrangler dry-run)
- `git diff --check`: pass
