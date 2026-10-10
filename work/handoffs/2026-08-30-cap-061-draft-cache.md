# CAP-061 handoff — Draft IndexedDB working-copy cache

## Outcome

CAP-061 is implemented locally on `master`. It adds the browser-local Dexie working-copy
foundation only; the draft editor, server fetch, autosave, send, and discard flows remain out of
scope for the next bounded slice.

## Behavior

- `apps/web/src/lib/draft-cache.ts` persists strict working copies containing `to`, `cc`, `bcc`,
  subject, text body, and HTML body, plus non-secret user/mailbox/draft identity and recovery
  markers.
- Primary keys are length-framed across all three identity components. `list`, `get`, `save`,
  `markSynced`, and `remove` validate identity parts at the boundary.
- `save` upserts content, increments revision only for changed content, and retains the server base.
- `markSynced` requires the expected local revision. Dexie v2 adds `baseServerRevision` to v1
  rows; duplicate/older responses are ignored, a response for a newer dirty local revision only
  advances the base and keeps dirty true, and a future revision throws `DraftCacheStaleSyncError`.
- `decideDraftRecovery` compares exact server/base versions and dirty state; it never compares
  client wall clocks. The Dexie handle is private and production code contains no logging,
  credentials, tokens, or storage handles.

## Verification

- Focused Web cache: **7/7 passed**.
- Full unit suite: **1013/1013 passed**.
- `pnpm scaffold doctor`: **14/14 passed**.
- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`, and `git diff --check`: passed.
- Independent architecture review: **ACCEPT**, no remaining findings.
- Unit runner printed that `apps/worker/.dev.vars` secrets are defined; no values were inspected or
  printed. No preview, deploy, R2, remote, or secret operation occurred.

## Next bounded slice

Implement the draft editor/recovery integration separately. It should derive the authenticated
user ID from the existing auth/session boundary, load the server draft first, then call
`decideDraftRecovery` and present an explicit load-server choice for `server-changed`. Capture the
working-copy revision before PATCH and pass it to `markDraftWorkingCopySynced`; do not make IndexedDB
the server authority or add autosave/send/discard in the same slice.
