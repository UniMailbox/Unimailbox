# Inbound validation and durable recovery

Implemented locally on 2026-10-15 from main `0d61ab9`, branch
`codex/inbound-recovery-20261015`. User selected the inbound optimization proposal.
No commit, push, deployment, remote migration, provider operation or private-mail
access was performed. Preserve the unrelated personal MCP settings edit.

## Delivered behavior

- Resolve envelope recipients before consuming MIME. Enforce declared and actual
  raw byte limits before parsing; content policy rejection stays synchronous.
- After policy acceptance, persist raw R2 bytes and a scoped durable D1 receipt.
  Duplicate reservations converge; deduplication uses normalized SMTP sender,
  recipient, mailbox and raw SHA-256 rather than Message-ID alone.
- Finalize the receipt, message, relations and receive audit atomically under a
  lease token. Use the existing queue for delayed recovery and bounded Cron
  dispatch for interrupted processing or enqueue loss. Pending raw references
  remain protected from cleanup; completed receipt expiry retains message bytes.
- Include stalled inbound receipts in the existing maintenance health query.
  Queue errors expose stable codes rather than raw validation/provider errors.

Canonical rules, limits, state transitions and rollback restrictions live in
[inbound recovery](../../docs/rebuild/20-inbound-recovery.md), with persistence
authority in migration 0038. External forwarding retains its existing order and
failure behavior; the receipt processor never repeats it. This does not guarantee
exactly-once external forwarding or universal SMTP duplicate identification.

## Validation

The original checkout's `pnpm verify` passed doctor, binding drift, lint and types,
then stopped at three existing `PersonalMcpSettings.test.tsx` failures: failed-read
retry behavior, older-credential pagination and disabled-service revocation UI.
That UI edit was neither changed nor included in the validation snapshot.

A managed isolated checkout of the same base plus all owned changes, retaining
the committed MCP UI, passed the final `pnpm verify`: doctor 14/14, generated
bindings, ESLint, TypeScript, web/Worker builds and 2,442 tests (1,382 unit/web/
contracts/scripts, 1,032 Worker, 28 migration fixtures). Application, contracts,
test-kit and migration sources were compared byte-for-byte with the shared
checkout. The final pass includes the bounded CTE raw-reference query, with one
100-parameter input list shared by message and receipt lookups. Changed-document
links, inbound rule-ID uniqueness and diff checks passed.

Focused local binding tests cover concurrent acceptance/processing, missing
Message-ID, changed bodies/envelopes/mailboxes, declared/actual size boundaries,
stream failure, D1 message/audit rollback, failed receipt reservation, failed
enqueue, dispatch limits, expired/stolen leases, missing/corrupt raw bytes,
deduplication expiry, reference protection, Queue version validation, outbound
credential independence, scheduled health and repeated migration verification.
The shared source's focused boundary/Queue/Cron/storage suite passed 65 tests;
eight bounded-stream unit cases also passed. All evidence uses local runtime
bindings and synthetic mail. Self-review only.

## Remaining acceptance

Apply schema 0038 through the normal backed-up release process before publishing
the matching Worker on an explicitly selected installation. Existing remote
environments were not changed. Verify actual Email Routing receipt, attachments,
forwarded copy and controlled post-acceptance recovery there. Keep the compatible
receipt/Queue/sweeper implementation while incomplete inbound work remains;
pre-0038 rollback is unsafe for that work. See the canonical design/runbook.
