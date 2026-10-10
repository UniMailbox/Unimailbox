# CAP-064 — Draft editor autosave and PATCH integration

**Phase:** 3
**Status:** Implemented locally
**Started:** 2026-08-31

## Goal

A signed-in user can open an existing draft, edit its recipients, subject, and body, and have the
working copy saved locally and persisted to the server through the existing optimistic-concurrency
PATCH route.

## Scope

- Turn the existing mailbox-scoped CAP-062 draft recovery page into an editable draft form for an
  already-existing server draft.
- Keep the current server GET contract as the initial authoritative state and keep the explicit
  local-recovery / load-server choice before editing when a recoverable local copy exists.
- Save form changes to the authenticated user's CAP-061 IndexedDB namespace with a short debounce.
- Autosave the latest server draft through `PATCH /api/v1/drafts/:draftId` with the server's exact
  `updated_at` in `If-Match`; use the shared draft response contract for the response and mirror
  successful responses into IndexedDB.
- Expose clear `Saving`, `Saved`, and retryable error/conflict states without logging draft
  contents, tokens, or credentials.
- Add focused Web tests for editing, debounce, PATCH headers/body, local cache mirroring, success,
  failure, and stale-version recovery.

## Out of scope

- New compose/draft creation wiring; the existing send-only compose route remains unchanged and
  draft creation is a later capability.
- Draft send, discard, attachments, rich-text editing, upload flows, folder/query redesign,
  Worker route changes, migrations, preview/deployment, and live-provider calls.
- Changes to `.claude/rules/`, `CLAUDE.md`, design specifications, or the existing CAP-061 cache
  schema unless the implementation proves a narrowly necessary compatibility fix; report such a
  need instead of broadening scope.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-AUTHZ-003` | The browser uses the authenticated session namespace; it never accepts a user ID or authorization identity from route/search/form input. |
| `R-AUTHZ-004` | The draft and mailbox IDs remain bound to the authenticated mailbox-scoped route and server authorization; a response for another resource is rejected rather than rendered. |
| `R-API-002` | API error codes remain stable and visible in the editor's retry/conflict state. |
| `R-API-003` | A PATCH failure, especially `412 STALE_IF_MATCH`, is handled as an explicit user-visible state, not a silent success. |
| `R-API-004` | Every PATCH relies on the existing API client to mint a fresh `Idempotency-Key`; the form must not hand-roll or persist one. |
| `R-SECRET-003` | Local persistence and UI state contain only draft content plus non-secret identity/version metadata; no credentials, bearer tokens, or storage handles are stored or logged. |
| `R-DATA-004` | Shared strict response parsing and route identity checks prevent foreign or storage-only fields from crossing into the editor. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`, existing CAP-061/CAP-062 contracts,
and the committed CAP-047 PATCH route contract.

## Acceptance criteria

- [x] 1. An authenticated existing draft renders labeled editable To, Cc, Bcc, Subject, and plain
  text Body controls populated from the selected server or explicitly recovered local copy; the
  route remains mailbox- and draft-scoped.
- [x] 2. Valid field changes are persisted to the current user's/mailbox/draft IndexedDB row after
  the debounce; stale timers are cancelled on unmount and no cache write contains credentials or
  idempotency keys.
- [x] 3. The latest changed content produces a PATCH with JSON field names matching
  `updateDraftSchema`, `If-Match` equal to the latest server `updated_at`, and an API-client
  generated `Idempotency-Key`; successful response parsing uses `draftDetailResponseSchema`.
- [x] 4. Successful PATCH updates the displayed server version, records the returned
  `updated_at` as the cache base, marks the matching local revision synced, and renders a stable
  saved state. Omitted fields are not accidentally cleared by the client payload.
- [x] 5. A pending save renders `Saving`; deterministic API errors render their stable code/message
  with a retry action while preserving the user's latest form values. A `412 STALE_IF_MATCH`
  response renders an explicit newer-server-version conflict/reload action and does not silently
  overwrite local edits.
- [x] 6. Existing CAP-062 loading, expired-session, malformed-response, mismatched-resource, and
  explicit local-recovery/load-server behaviours remain intact, and the existing draft-folder link
  reaches the editor without changing non-draft rows.
- [x] 7. Focused Web tests and the repository quality gates pass; no Worker, migration, provider,
  secret, or deployment changes are required for this capability.

## Vertical slice

Layers touched, in dependency order:

- [x] domain — none
- [x] migration — none
- [x] repository — none
- [x] use case — existing Worker PATCH route only; no source change
- [x] contract schema — existing `packages/contracts` draft schemas, consumed without widening
- [x] route — existing authenticated `/mailbox/$mailboxId/draft/$draftId`
- [x] client — `apps/web/src/features/mailbox/DraftRecoveryPage.tsx`,
  `apps/web/src/features/mailbox/mailbox-queries.ts`
- [x] tests — focused Web draft page/query tests

New module dependency edges introduced: none.

## Delivery path

`authenticated browser draft link` → `/mailbox/$mailboxId/draft/$draftId` → `DraftRecoveryPage` →
`draftQuery` GET + `useUpdateDraftMutation` PATCH → existing Worker draft route → D1 draft row,
recipients, audit, and idempotency batch → updated server draft and local IndexedDB working copy
visible in the editor.

- Build/runtime configuration touched: none
- Fresh-deploy evidence required: no; this slice consumes the already-mounted route
- Repeat-deploy/idempotency evidence required: API client and existing Worker route tests cover it;
  no deployment is authorized in this capability

## Reference implementation

None. Adapt the existing `ComposeEmail`, `DraftRecoveryPage`, `mailbox-queries`, and CAP-061 cache
patterns already in this repository.

## File ownership

| Agent | Owns |
|---|---|
| `codex-implementer` | `apps/web/src/features/mailbox/DraftRecoveryPage.tsx`, `apps/web/src/features/mailbox/DraftRecoveryPage.test.tsx`, `apps/web/src/features/mailbox/mailbox-queries.ts`, plus new files under `apps/web/src/features/mailbox/` only if strictly required by this scope |
| `orchestrator` | this task file, `docs/rebuild/capability-ledger.md`, `docs/rebuild/implementation-log.md`, review reports, and any out-of-scope integration decision |

The implementer must not edit Worker, migration, contracts, rules, or documentation files. If the
existing API/client/cache boundary is insufficient, stop and report the exact required file rather
than widening ownership.

## Reading list

- `CLAUDE.md`
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md`
- `.claude/rules/coding.md`
- `.claude/rules/security.md`
- `.claude/rules/testing.md`
- `work/archive/2026-08/CAP-061-draft-cache/task.md`
- `work/archive/2026-08/CAP-062-draft-recovery-view/task.md`
- `work/archive/2026-08/CAP-047-draft-patch/task.md`
- `apps/web/src/features/mailbox/DraftRecoveryPage.tsx`
- `apps/web/src/features/mailbox/DraftRecoveryPage.test.tsx`
- `apps/web/src/features/mailbox/mailbox-queries.ts`
- `apps/web/src/lib/draft-cache.ts`
- `packages/contracts/src/index.ts`

## Dependencies

- Requires: CAP-061 (Implemented locally), CAP-062 (Implemented locally), CAP-047 draft PATCH
  (Implemented locally)
- Blocks: the later draft send/discard UI and the broader new-compose autosave path

## Decisions made during this capability

- Use the existing CAP-062 route/page as the editor entry point so server response identity and
  local recovery checks remain in one mailbox-scoped surface.
- Treat the server's returned `updated_at` as the next optimistic-concurrency token and let the
  existing API client own both `Idempotency-Key` and request-id headers.
- Keep a clean server baseline in the existing CAP-061 row before the first edit so a failed
  initial PATCH remains recoverable without changing the cache schema.
- Disable editing until a dirty/server-changed local copy has an explicit recovery decision; a
  conflict reload refetches the latest server draft before deleting local work.
- Serialize saves per draft and invalidate the generation on route changes so an older request
  cannot affect a newly selected draft; a local cache-sync failure retries only the cache operation.

## Open questions

- None for the bounded existing-draft editor. New draft creation and send/discard remain separate
  capabilities.

## Implementation evidence

- The existing authenticated `/mailbox/:mailboxId/draft/:draftId` route now renders labeled
  controlled To/Cc/Bcc/Subject/plain-text Body controls. Server GET content remains the initial
  authority; dirty local copies require an explicit recovery action before editing.
- Autosave uses a 500 ms debounce, the authenticated CAP-061 cache namespace, serial per-draft
  saves, exact server `updated_at` in `If-Match`, and the shared API client's request-id/idempotency
  headers. Successful responses are strict-parsed and checked against both requested resource
  IDs before query/cache updates.
- `412 STALE_IF_MATCH` preserves the form and local copy, blocks editing, and requires a fresh GET
  before the user explicitly loads the newer server version. Generic API errors retain values and
  expose retry; cache-sync retry does not repeat PATCH.
- Focused evidence: `DraftRecoveryPage` 21/21; full unit 71 files, 1122/1122; Worker 50 files,
  886/886; doctor 14/14; lint/typecheck/format/build/diff clean. Independent final subagent
  review: `NO FINDINGS`.
- No Worker source, migration, provider, secret, deployment, push, or remote operation was
  performed for this capability.
