# CAP-060 — Web folder views

**Phase:** 3

**Status:** Implemented locally
**Started:** 2026-08-30
**Completed:** 2026-08-30

## Objective

Expose the five server-supported mailbox folders in the Web mailbox view. The existing
CAP-059 API remains authoritative; this slice carries the selected folder through the
router, request URL, query cache, and list presentation without changing the Worker,
database, attachment, sharing, or draft-recovery surfaces.

## Scope

- Validate the optional mailbox `folder` search parameter against the shared closed contract,
  defaulting invalid or missing values to `inbox`.
- Include the selected folder in the mailbox message query key and request URL while retaining
  the existing default-inbox URL for compatibility.
- Render accessible navigation for `inbox`, `sent`, `drafts`, `archive`, and `trash`, with a
  folder-specific heading and selected state.
- Keep row mutations and compose invalidation scoped to the active mailbox folder family and
  authenticated user; do not permit folder cache data to cross accounts.

## Acceptance criteria

- [x] The route accepts only the five contract folders; missing, empty, and unsupported search
  values resolve to `inbox` without a network request for another folder.
- [x] Selecting a non-inbox folder requests `?folder=<folder>` and renders that folder's rows;
  inbox remains the default request and view.
- [x] Folder-specific query keys are distinct and remain nested under the authenticated user's
  mailbox namespace; account switching cannot reuse another user's folder cache.
- [x] Star/delete/read/compose cache updates continue to target the active folder or its mailbox
  family without affecting another folder's list.
- [x] Focused Web tests cover route validation, request URL, navigation/selected state, folder
  query-key isolation, and existing inbox behavior. Typecheck, lint, format, unit tests, build,
  and diff hygiene pass.

## Implementation evidence

- `validateFolderSearch` uses the shared `messageFolderSchema` and returns the safe `inbox`
  default for malformed query values. The mailbox route passes the validated folder to the page.
- `mailboxMessagesInfiniteQuery` appends `folder=<value>` for non-inbox views and includes the
  folder in its authenticated user/mailbox query key. A family key keeps compose invalidation
  broad enough to refresh every folder after a send; row mutations target the active folder.
- `InboxListPage` renders all five accessible folder links, marks the selected view with
  `aria-current="page"`, and keeps existing inbox copy/URL behavior for compatibility.
- Focused Web evidence: router validation, query-key isolation, selected Sent view/request URL,
  and the existing inbox suite pass; full unit, typecheck, lint, format, build, doctor, and
  `git diff --check` pass locally.

## Out of scope

Draft DELETE/discard and IndexedDB recovery, sharing UI, attachment storage changes, R2,
preview/deployment, and remote operations.
