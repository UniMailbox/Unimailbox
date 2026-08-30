# CAP-062 — Draft server view and recovery decision

**Phase:** 3

**Status:** Implemented locally

**Started:** 2026-08-30

## Objective

Connect the CAP-061 browser working-copy store to a small Web read surface for existing server
drafts. A signed-in user can open a draft from the Drafts folder, see the server-authoritative
content, and make an explicit choice when this browser has a dirty copy or the server version has
changed. This slice is intentionally read/recovery-only; it does not add editing or mutation
loops.

## Scope

- Promote the existing `GET /api/v1/drafts/:id` wire shape into the shared contracts package with
  strict `draftResponseSchema` / response-envelope types, including `to`, `cc`, and `bcc`.
- Add a user-scoped Web draft query/fetcher that encodes the draft and mailbox IDs, parses the
  shared contract, and binds the existing server GET route to the requested mailbox when supplied;
  retain the server as the authoritative source.
- Add an authenticated route at `/mailbox/:mailboxId/draft/:draftId` and link draft-folder rows to
  it without changing the existing send-only Compose route.
- Add a recovery-aware draft view with loading, error/retry, and expired-session states. It renders
  server fields read-only in this slice. If a CAP-061 local copy exists, call
  `decideDraftRecovery`; show an explicit `Recover local copy` or `Load server version` choice.
  Loading the server version may remove the local working copy only after the explicit action.
- Use the authenticated session user ID for every cache/query operation. Never accept a user ID,
  credential, token, or storage handle from route search/body input.
- Add focused Web/contract tests for wire parsing, route/link reachability, server/local recovery
  choices, account isolation, loading/error/unauthorized states, and no secret fields.

## Acceptance criteria

- [x] The shared strict draft response contract accepts the server's documented fields and rejects
  unknown/internal fields; `body_text`/`body_html` and RFC-3339 timestamps remain wire names.
- [x] A draft-folder row links to the authenticated `/mailbox/:mailboxId/draft/:draftId` view with
  both IDs encoded; non-draft folders retain their current behavior.
- [x] The view fetches only the requested draft, parses it through contracts, and displays the
  server content read-only with loading, retryable error, and expired-session states.
- [x] No local copy displays as the server view with no recovery prompt. A dirty copy with the same
  base version offers an explicit local-recovery choice; a server-base mismatch offers an explicit
  load-server choice. No choice is made from wall-clock ordering.
- [x] `Load server version` removes only the current user's/mailbox/draft local row after the user
  activates it; account or draft IDs cannot access another cache namespace. No tokens, credentials,
  bytes, storage handles, or internal upload fields are returned or logged.
- [x] Focused Web/contract tests, typecheck, lint, format, full unit tests, build, doctor, and diff
  hygiene pass. The bounded existing Worker draft-read route gained only the optional mailbox
  association filter needed by the Web path; migrations, autosave, PATCH, send, discard, preview,
  deployment, and R2 stay out of scope.

## Out of scope

Editable form controls, draft creation, debounced autosave/PATCH, optimistic concurrency writes,
send/discard mutations, attachment editing, migrations and unrelated Worker/database changes, new bindings, preview,
deployment, and remote operations.

## Implementation evidence

- Web recovery view and Drafts-folder link are wired through the production router; the page keeps
  the server response authoritative until an explicit local-recovery action and deletes only the
  current user/mailbox/draft cache key on an explicit server choice.
- The existing draft GET accepts an optional validated `mailboxId` query, filters associations
  before authorization, and preserves the legacy no-query behavior for CAP-047 callers. The Web
  fetcher always supplies the encoded mailbox ID.
- Focused evidence: DraftRecoveryPage 10/10, production router 19/19, InboxListPage 29/29,
  draft-cache/query-key 17/17, contracts 383/383, and Worker draft routes 43/43.
- Full local evidence: unit 1030/1030, doctor 14/14, typecheck/lint/format/build and
  `git diff --check` clean. Independent architecture review: ACCEPT with no findings.
- Completed locally on 2026-08-30. No secrets were inspected, no deploy/preview/push occurred.
