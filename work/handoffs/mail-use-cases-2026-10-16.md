# CAP-070 — Shared mail mutation use cases

Continue from `codex/resource-dashboard-20261016`, base `0d61ab9`. Existing
inbound/outbound reliability and resource dashboard work remains uncommitted.
The unrelated personal MCP settings edit is preserved. No commit, push,
deployment, remote migration, account access or real-mail/provider sends.

## Delivered

Messages owns create/read/update draft and per-user mark-read/star/soft-delete
use cases. Outbound-mail owns compose submission and draft submission. The HTTP
routes delegate to public operations; MCP create_draft/send_email invoke those
operations directly, retaining independent D1 credential authentication, token
scopes, global permissions and MCP tool auditing. MCP read/AI routing is unchanged.

Message association authorization and authored message/folder prepared statements
remain messages-owned. Shared use cases accept explicit database, audit, clock,
ID, Queue and attachment-store collaborators and return serialized outcomes;
Fetch Response construction and request-correlation headers stay in HTTP.
Shared JSON validation retains malformed-input logging and original replay hashes.

The optional admin audit-writer marker guard preserves request-scoped conditional
save/send audit writes. Save concurrency, one-transaction message/recipient/job/
audit/idempotency writes, send-after-commit notification, attachments/signatures
and scheduled behavior remain covered. Mark-read keeps its documented rerunnable
best-effort idempotency settlement. Draft-send replay now rechecks mailbox access
even after the message has left draft status; revoked actors receive the no-leak
404. No migration or frontend change in this slice.

## Validation

Focused existing HTTP/compose/attachment/MCP/draft tests passed 180 cases. Fifteen
new direct use-case tests pass against real local D1: allowed and foreign actors,
malformed input and reusable key, replay/conflict, parallel saves/stale writes,
audit-trigger rollback, Queue failure after commit, outbox replay and revoked
access. The 72-case message-route suite passed after restoring the HTTP request
correlation header. Main-session self-review only.

Final isolated `pnpm verify` passed: doctor 14/14, generated bindings, lint,
TypeScript, builds and 2,526 tests (1,422 non-Worker, 1,076 Worker, 28 migration
fixtures). All 718 application/contracts/test-kit/migration/script source paths
match the shared checkout. The gate exits 0; existing Vite size and source-map
warnings remain, and the local Worker runtime logged four network-connection-lost
exceptions without test failures. The intermediate missing signature dependency
edge and star request-correlation header were corrected and the final full gate
rerun. Scratch logs and the frozen manifest stay under `.tmp/mail-use-cases/`. The
snapshot uses committed PersonalMcpSettings.tsx; the user's unrelated edited file
retains SHA-1 `2a223c708de3ab4024dde65922e15932c9c72f22` and its earlier three UI
failures are outside this acceptance. Live installation/provider validation has
not been performed.

Architecture and preserved policies are owned by
[the module boundaries](../../docs/rebuild/05-target-architecture/module-boundaries.md#shared-mail-mutation-use-cases).
