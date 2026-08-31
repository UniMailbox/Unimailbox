# CAP-065 — Mailbox sharing and member-management UI

> The Web vertical slice for the already-implemented CAP-057 mailbox member API. This slice adds
> the reachable browser surface without inventing invitation delivery or a role-update endpoint.

**Phase:** 3 · **Status:** Implemented locally · **Started:** 2026-08-31 · **Completed:** 2026-08-31

## Goal

An authorized mailbox owner or global sharing operator can view the mailbox's explicit members,
add an existing active user by normalized email with a viewer/sender/admin role, and remove a member
from a reachable browser page with clear loading, empty, error, retry, and confirmation states.

## Scope

- Add the authenticated `/mailbox/:mailboxId/members` page.
- Add user-scoped TanStack Query keys, strict fetchers, and mutations for the CAP-057 member list,
  add, and remove contracts.
- Add an email + role form that uses the shared request schema and preserves values after a failed
  request so the operator can retry.
- Show safe member projections and require an explicit confirmation before removal.
- Add an entry link from the selected mailbox inbox and route-level session protection.
- Add focused Web tests for query paths/parsing, user-cache isolation, form behavior, failure/retry,
  and removal confirmation.

## Out of scope

- Invitation email delivery, registration-by-invite, or a pending invitation data model; the current
  CAP-057 API resolves only existing active users.
- Updating an existing member's role; CAP-057 exposes no PATCH role endpoint.
- Worker, migration, contract, permission, provider, deployment, or preview changes.
- Mailbox rename/delete, mailbox creation, folders, stars, draft send/discard, or admin settings.

## Business rules

| Rule ID | What it means for this slice |
|---|---|
| `R-AUTHZ-001` | The page and every mutation use the authenticated session; no user identity comes from form or URL query input. |
| `R-AUTHZ-003` | Client state is user-scoped and does not grant access; the CAP-057 server authorization remains authoritative. |
| `R-AUTHZ-004` | Every request and cache write remains bound to the mailbox ID in the route; a response for another mailbox is rejected. |
| `R-DATA-001` | The shared email schema trims and lowercases the add request before it is sent. |
| `R-DATA-004` | The client accepts only strict shared response projections and never renders storage-only fields. |
| `R-API-002` | Stable API error codes and messages remain visible with a retry action where retry is meaningful. |
| `R-API-003` | Duplicate, unknown-user, denied, and missing-member failures are explicit UI states, not silent success. |
| `R-API-004` | Mutating requests rely on the shared API client for fresh idempotency and request-correlation headers. |
| `R-SECRET-003` | UI state and logs contain only the safe member projection; credentials, tokens, and idempotency keys are never persisted or displayed. |

Source: `docs/rebuild/02-business-discovery/business-rules.md`, CAP-057's archived contract, and
the existing Web API/client rules.

## Acceptance criteria

- [x] 1. An authenticated user can reach `/mailbox/:mailboxId/members` from the mailbox inbox; the
  page loads `GET /api/v1/mailboxes/:mailboxId/members` with a user-scoped cache key and renders
  only `userId`, `email`, `displayName`, `role`, and `createdAt`.
- [x] 2. Loading, empty, expired-session, denied/not-found, and generic API failure states are
  explicit; a failed background refetch keeps already-loaded members visible and exposes a retry.
- [x] 3. The add form validates with `addMailboxMemberRequestSchema`, sends the normalized email and
  selected closed role to CAP-057, disables duplicate submission while pending, clears on success,
  and preserves values while showing the stable error code on failure/retry.
- [x] 4. Each member has a remove action requiring explicit confirmation; successful removal updates
  the current user's mailbox cache, while a failed removal keeps the member and exposes its error.
- [x] 5. Different authenticated users and different mailbox IDs cannot share member cache entries;
  a strict response shape rejects an item carrying an unexpected resource/storage field instead of
  rendering it.
- [x] 6. Focused Web tests and repository quality gates pass. No Worker, migration, contract,
  provider, deployment, or secret changes are required.

## Vertical slice

Layers touched, in dependency order:

- [x] domain — none; CAP-057 owns member role semantics
- [x] migration — none; existing `mailbox_members` schema is sufficient
- [x] repository — none; consume CAP-057 API
- [x] use case — none; consume CAP-057 API
- [x] contract schema — existing `packages/contracts/src/index.ts` only
- [x] route — `apps/web/src/app/router.tsx`
- [x] client — `apps/web/src/features/mailbox/mailbox-queries.ts`,
  `apps/web/src/features/mailbox/MailboxMembersPage.tsx`
- [x] tests — focused member-page/query tests and inbox entry-link coverage

New module dependency edges introduced: none.

## Delivery path

`authenticated browser` → `/mailbox/:mailboxId` inbox → Members link →
`/mailbox/:mailboxId/members` → `MailboxMembersPage` → TanStack Query fetcher/mutation →
CAP-057 `/api/v1/mailboxes/:mailboxId/members` route → authenticated tenancy authorization and D1
member rows → safe member list rendered in the browser.

- Build/runtime configuration touched: none
- Fresh-deploy evidence required: no; this consumes an existing API and mounted SPA route
- Repeat-deploy/idempotency evidence required: no new endpoint; mutation headers and server replay
  behavior remain covered by the shared API client and CAP-057 Worker tests

## Reference implementation

None. Adapt existing `InboxListPage`, `UsersPage`, `ComposeEmail`, `AlertDialog`, and mailbox query
key patterns; reject any reference that assumes invitation delivery or client-side authorization.

## File ownership

| Agent | Owns |
|---|---|
| `codex-implementer` | `apps/web/src/app/router.tsx`, `apps/web/src/features/mailbox/index.ts`, `apps/web/src/features/mailbox/mailbox-queries.ts`, `apps/web/src/features/mailbox/MailboxMembersPage.tsx`, `apps/web/src/features/mailbox/MailboxMembersPage.test.tsx`, `apps/web/src/features/mailbox/InboxListPage.tsx`, `apps/web/src/features/mailbox/InboxListPage.test.tsx`, `apps/web/src/features/mailbox/mailbox-query-keys.test.ts`, `apps/web/src/styles/tokens.css` |
| `orchestrator` | this task, `docs/rebuild/capability-ledger.md`, `docs/rebuild/implementation-log.md`, review coordination, archive, and final commit |

## Reading list

- `CLAUDE.md`
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/architecture.md`
- `.claude/rules/security.md`
- `.claude/rules/testing.md`
- `docs/rebuild/02-business-discovery/business-rules.md`
- `work/archive/2026-08/CAP-057-mailbox-sharing/task.md`
- `apps/web/src/app/router.tsx`
- `apps/web/src/features/mailbox/InboxListPage.tsx`
- `apps/web/src/features/mailbox/mailbox-queries.ts`
- `apps/web/src/features/admin/UsersPage.tsx`
- `apps/web/src/components/ui/AlertDialog.tsx`
- `packages/contracts/src/index.ts`

## Dependencies

- Requires: CAP-057 mailbox sharing backend — Implemented; CAP-043 authorized mailbox UI —
  Implemented; CAP-042 authentication/session bridge — Implemented
- Blocks: richer invitation delivery and member self-service, which remain separate capabilities

## Decisions made during this capability

- 2026-08-31: The UI calls the existing-member CAP-057 endpoint and labels the action as adding a
  mailbox member. It does not claim to send an invitation because no invitation-delivery endpoint
  exists.
- 2026-08-31: Existing member roles are displayed but not editable because CAP-057 has no role
  update contract; adding a member chooses the role at creation time.
- 2026-08-31: The page surfaces server authorization failures as the returned stable error state;
  the client does not pre-authorize based on the session descriptor.

## Review and verification

- Initial independent reviews: architecture, QA, and security accepted the slice; code and frontend
  reviewers identified the same refetch-race and stable-error-code gaps, plus success-announcement
  and focus-restoration accessibility gaps.
- Resolved review findings: add/remove mutations await exact member-query cancellation before cache
  writes; query failures normalize to `ApiError('UNKNOWN', ...)`; add/remove success is announced in
  a polite live region; removal focus returns to the trigger or the next usable member/form control.
- Code and frontend re-reviews accepted the fixes with no new findings. No BLOCKER, HIGH, or deferred
  MEDIUM findings remain.
- Verification: focused Web 85/85; unit 72 files / 1142 tests; Worker 50 files / 886 tests;
  typecheck, lint, scaffold doctor 14/14, build, CAP-065 format check, and `git diff --check`
  passed. Build retained the existing Vite bundle-size warning only.

## Open questions

- None for this bounded UI slice. Product decisions about invitation delivery and role updates are
  deferred to the capabilities that add those API contracts.
