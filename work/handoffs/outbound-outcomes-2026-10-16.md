# Durable outbound submission outcomes

Implemented locally from main `0d61ab9` on branch
`codex/outbound-outcomes-20261015`, continued through 2026-10-16. The user selected
the outbound unknown-outcome optimization. No commit, push, deployment, remote
migration, real provider operation or private-mail access was performed. Preserve
the earlier uncommitted inbound slice and unrelated personal MCP settings edit.

## Delivered behavior

- Journal prepared/submitted attempts before the network call. Submitted,
  unknown and accepted attempts fence Queue claims, retries and stale recovery.
- Persist acceptance independently, then finalize job/message/scheduled folder,
  early-event reconciliation and audit atomically. Failed local writes repair
  from evidence without another provider send.
- Correlate authenticated callbacks to the provider connection and opaque attempt
  tag; recheck conflicting acceptance inside the transaction. Cron queries only
  bounded positive provider evidence. Empty/failed/conflicting lookup keeps the
  send fence.
- Bound submission to 20 seconds with a five-second lease write margin; bound
  reconciliation queries to five seconds, ten attempts per frequent run.
  Confirmed rejection persists exponential backoff/Retry-After for Queue/Cron.
  Network failure, 408/5xx, timeout and malformed acceptance remain unknown.
- Use Brevo's documented `headers.idempotencyKey` and attempt tags/custom header.
  Safety does not depend on assumed provider-side duplicate suppression.

The canonical design, migration authority, operational bounds and provider
references live in [submission outcomes](../../docs/rebuild/21-outbound-submission-outcomes.md).
Public job/message status enums and browser mutation contracts are unchanged.

## Validation

Final isolated owned-source `pnpm verify` passed: doctor 14/14, generated bindings,
ESLint, TypeScript, Web/Worker builds and 2,478 tests (1,399 non-Worker, 1,051
Worker, 28 migration fixtures). All 44 changed application/contracts/test-kit/
migration paths were compared byte-for-byte against the shared checkout.
The validation checkout uses committed personal MCP UI; the user's existing UI
edit is unchanged and excluded, retaining its three previously demonstrated
frontend failures documented in the [inbound handoff](inbound-recovery-2026-10-15.md).

The 19 outbound outcome tests use local D1 and synthetic provider calls, covering
lost responses, acceptance-record/message/audit failure, early and conflicting
callbacks, connection/signature isolation, lookup failure/empty results,
Retry-After, deadlines/lease fencing, interrupted submission, migration quarantine
and saved-evidence repair. The conflicting callback interleaving failed before
the transaction guard and passed after it. Provider wire-format/response cases
are also covered in the canonical gate. The old 0033 fixture now stops at 0033,
so it tests that migration rather than 0039's deliberate legacy quarantine.
Changed-document links, rule uniqueness and diff checks pass. Self-review only.

## Remaining acceptance and upgrade boundary

Use the normal backed-up release procedure on an explicitly selected installation.
Apply schemas 0038–0039 before publishing matching source. Pause/drain old sending
activity and inspect due queued work first. Migration 0039 conservatively holds
old sending/due queued jobs without saved provider IDs as uncorrelated unknown
work, including some genuinely unsent jobs; future scheduled jobs remain queued.
No transmitted legacy attempt tag exists, so those rows need private provider
reconciliation rather than automatic tag lookup or bulk resend.

Do not revert to a sender/reclaimer that ignores the attempt journal. Real Brevo
custom-header callbacks, event lookup, timeout/acceptance recovery, provider
duplicate suppression and end-to-end mail delivery have not been verified on a
deployed installation in this task. Local evidence does not close those gates.
