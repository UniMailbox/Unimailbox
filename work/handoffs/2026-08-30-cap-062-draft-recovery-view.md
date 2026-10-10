# CAP-062 handoff — Draft server view and recovery decision

## Outcome

CAP-062 is implemented locally on `master`. A signed-in user can open a Drafts-folder row at
`/mailbox/:mailboxId/draft/:draftId`, inspect the strict server draft envelope read-only, and make
an explicit choice when a CAP-061 browser working copy is dirty or based on a changed server
version. Editing, autosave, PATCH, send, discard, attachment editing, preview, and deployment are
not part of this slice.

## Implementation

- `packages/contracts` owns the strict `{ data: draft }` response, including `to`/`cc`/`bcc`,
  `status: 'draft'`, and canonical millisecond RFC-3339 timestamps. Unknown storage fields are
  rejected.
- `mailbox-queries.ts` scopes the draft cache key by authenticated user, mailbox, and draft IDs;
  the fetcher encodes both IDs and sends `mailboxId` to the existing draft GET route.
- The draft GET route preserves legacy no-query callers and adds an optional UUID-validated,
  association-bound `mailboxId` filter. This prevents a multi-mailbox draft from resolving under
  the wrong Drafts URL while retaining server-side authorization and the 404 no-leak envelope.
- `DraftRecoveryPage` verifies both returned resource IDs before rendering. It defaults to the
  server, offers `Recover local copy` for a dirty same-base copy, and offers `Load server version`
  for a changed base. The latter removes only the current user/mailbox/draft cache row after the
  explicit action. Bodies are rendered as text/source in `<pre>`; no HTML insertion or secret/log
  surface was added.
- The production router has the authenticated route guard; Drafts rows use a route link while
  non-Drafts rows retain plain subject rendering.

## Verification

| Gate | Result |
|---|---|
| DraftRecoveryPage focused Web tests | **10/10** |
| Production router + Inbox + query/cache focused Web tests | **53/53** |
| Contracts test | **383/383** |
| Worker draft route tests | **43/43** |
| Full non-worker unit suite | **1030/1030** |
| Scaffold doctor | **14/14** |
| Typecheck / lint / format | clean |
| Web + Worker build / Wrangler dry-run | clean |
| `git diff --check` | clean |

Independent architecture review: **ACCEPT**, no remaining findings. The Worker test runner reports
that `apps/worker/.dev.vars` is configured; no secret values were read or printed.

## Next bounded slice

Implement the draft editor/autosave/PATCH integration. Reuse CAP-061 revision and
`markDraftWorkingCopySynced` CAS semantics, preserve the server-first recovery decision, and keep
send/discard and attachment editing in separate slices. No preview, deploy, push, or R2 operation
was performed for CAP-062.
