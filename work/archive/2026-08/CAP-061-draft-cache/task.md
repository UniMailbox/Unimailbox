# CAP-061 — Draft IndexedDB working-copy cache

**Phase:** 3

**Status:** Implemented locally

**Started:** 2026-08-30
**Completed:** 2026-08-30

## Objective

Add the browser-local working-copy store required for draft crash recovery. This is a bounded
Web infrastructure slice: it must preserve draft content across a browser restart, isolate
records by authenticated user/mailbox/draft, and provide a clock-skew-safe recovery decision for
the future draft editor. It does not yet add a route, editor, autosave loop, server fetch, or
discard action.

## Scope

- Add Dexie as the Web runtime store (and a test-only IndexedDB implementation if required by the
  existing happy-dom test environment). Dexie 4.4.5 supplies the typed IndexedDB schema,
  compound-index query, and transaction boundary; `fake-indexeddb` 6.2.5 is dev-only and gives
  the focused tests a real in-memory IndexedDB implementation without introducing a production
  storage shim.
- Add `apps/web/src/lib/draft-cache.ts` with a strictly typed `DraftWorkingCopy` schema mirroring
  the server draft fields (`to`, `cc`, `bcc`, subject, text body, and HTML body), and explicit CRUD
  operations: save/upsert, get by user/mailbox/draft, list by user/mailbox, mark synced to a server
  `updated_at`, and remove.
- Derive the primary key from length-framed user, mailbox, and draft IDs so cache identity cannot
  collide across tenants or delimiter-containing values. Never use session tokens or credentials.
- Store the last server `updated_at` as the local base version plus a local dirty/revision marker;
  persist the revision associated with that base so duplicate/out-of-order responses cannot regress
  the base, and never clear a newer dirty revision;
  expose a deterministic recovery decision (`unchanged`, `local-ahead`, or `server-changed`)
  that does not compare unsynchronised wall clocks. A later editor will require an explicit
  "load server" action for the `server-changed` case.
- Add focused unit tests using a real in-memory IndexedDB test adapter for CRUD, user/mailbox
  isolation, key-collision resistance, revision/dirty transitions, malformed-record rejection,
  and clock-skew-safe recovery decisions.

## Acceptance criteria

- [x] A saved working copy can be read after the caller's promise completes and survives a fresh
  Dexie instance in the same browser database.
- [x] User A, user B, and different mailboxes/draft IDs never read or delete one another's rows;
  key construction has a regression for delimiter-like IDs.
- [x] Saving a changed copy advances a local revision without losing draft fields; marking a
  server response synced clears dirty state and records its exact `updated_at`.
- [x] Recovery decisions use the stored base server version and dirty marker, so a client/server
  clock offset cannot make a clean copy appear newer; a server version mismatch is surfaced as
  `server-changed`, not silently overwritten.
- [x] The cache validates its persisted shape at the boundary and never stores auth tokens,
  credentials, or storage handles. Focused tests are named with `R-MESSAGE-010`, `R-DATA-004`,
  and `R-SECRET-003` where applicable.
- [x] Focused cache tests, typecheck, lint, format, full unit tests, build, and diff hygiene pass.

## Implementation evidence

- `apps/web/src/lib/draft-cache.ts` owns the browser-local Dexie database and exposes only the
  typed working-copy CRUD/recovery boundary. Records include the server-compatible `to`, `cc`,
  `bcc`, subject, text, and HTML fields plus non-secret identity, revision, dirty, and server-base
  markers. The primary key uses length-framed identity components.
- Persisted records are strict-validated on every read. Dexie schema version 2 backfills
  `baseServerRevision: null` for rows created by the initial v1 cache implementation. Server
  acknowledgements use an expected revision in the same read/write transaction: stale responses
  cannot clear newer dirty content, and duplicate/out-of-order responses cannot regress the highest
  acknowledged server base.
- Focused real IndexedDB tests cover browser-restart persistence, same-draft cross-user/mailbox
  isolation, delimiter collisions, revision and `bcc` preservation, stale/ordered/future sync
  responses, clock-skew-safe recovery decisions, strict secret-shaped/corrupt-row rejection, and
  invalid identity/revision inputs.
- Local evidence: focused Web 7/7, full unit 1013/1013, scaffold doctor 14/14, typecheck, lint,
  format, Web/Worker build, and `git diff --check` all pass. Independent architecture review
  returned ACCEPT with no findings. No preview, deployment, R2, or secret access was performed.

## Out of scope

Draft editor/router integration, server draft API hooks, debounced PATCH/autosave, send/discard
actions, sharing UI, folder changes, Worker/database/migration changes, R2, preview/deployment,
and remote operations.
