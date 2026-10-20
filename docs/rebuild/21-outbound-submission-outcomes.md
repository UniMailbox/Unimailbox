# Outbound submission outcomes

The [outbound rules](02-business-discovery/business-rules.md#r-outbound--outbound-mail)
own the invariants. Migration `0039_outbound_send_attempts.sql` owns the attempt
journal and persisted retry time. This extends the existing D1 outbox/Queue;
business message/job status enums and browser mutation contracts stay compatible.

## Provider boundary and recovery

Each send first claims the outbox job and prepares its payload. Before calling
the adapter it commits a prepared attempt, then a submitted marker fenced by the
current job lease. A submitted marker deliberately means the request **may** have
reached the provider: a crash immediately before the network call cannot be
distinguished from a crash immediately after it.

| Attempt state | Meaning and allowed action |
| --- | --- |
| `prepared` | No submitted marker; failure/reclaim may safely retry preparation. |
| `submitted` | Request may have escaped; do not automatically resubmit. |
| `unknown` | Acceptance is unconfirmed after failure/expired lease; reconcile only. |
| `accepted` | Durable provider ID and acceptance time; repair local finalization without sending again. |
| `rejected` | Adapter explicitly proves nonacceptance; normal terminal/retry policy applies. |

Only one submitted/unknown/accepted attempt may exist for a job. Claim, retry and
stale recovery SQL preserve that fence. Generic exceptions after submission,
timeouts, malformed success responses, HTTP 408/5xx and duplicate-key responses
remain unknown. `RetryableProviderError` now specifically asserts a confirmed
nonacceptance; adapters must never use it merely because a transport failed.

Provider acceptance is saved independently before one atomic batch finalizes job,
message status, unmatched delivery reconciliation and audit. Thus failure to
update the message or write audit leaves accepted evidence that Queue redelivery
or Cron can repair. Existing `message.send` audit action carries
`stage: provider_accepted`; the closed public action catalog is unchanged. Terminal
jobs are not resurrected. An accepted legacy-reclaimed queued job passes through
queued → sending → sent inside one transaction, without another provider request.

## Positive evidence

Every new submission carries an opaque attempt tag in Brevo `tags` and
`X-Mailin-custom`. It contains no mailbox address, subject or body.

- An authenticated callback resolves the tag only within its verified provider
  connection and provider key. A matching provider ID is recorded with job/message
  changes, delivery and audit in the webhook transaction. Cross-connection,
  unauthenticated or conflicting provider-ID callbacks cannot resolve the attempt.
  A transaction guard rechecks acceptance after lookup, so concurrent conflicting
  evidence rolls back rather than linking a delivery to the wrong message.
- Cron can query the provider's transactional event report with the exact attempt
  tag. The adapter also checks the returned tag, bounded provider ID and explicitly
  zoned event date. A single consistent provider ID is positive evidence.
- Empty results, missing tags, conflicts, timeouts and query failures never prove
  nonacceptance. They retain the send fence. Unsupported provider lookup likewise
  retains the job for authenticated callbacks/operator investigation.

Once accepted work is finalized its reconciliation time is cleared. Duplicate
callbacks or a later HTTP response do not reactivate historical polling. The
existing maintenance health check already detects stalled sending/queued jobs;
retry reservations do not change their original creation time.

## Time and resource bounds

The outbound lease remains 60 seconds. Submission requires at least a 20-second
request budget plus a five-second write margin remaining on that lease. The
adapter aborts its HTTP request at the budget; an outer deadline also bounds a
misbehaving adapter. Caller timeout does not prove that upstream processing
stopped, so timed-out work remains unknown.

Confirmed rejection persists `next_attempt_at` before Queue retry. Exponential
backoff starts at 30 seconds and caps at one hour; a valid Retry-After can extend
that wait. Both direct Queue redelivery and Cron honor the stored time. Queue
delay limits never permit an early send: long waits are rechecked in chunks.

Each five-minute Cron handles at most 100 newly expired submission markers and
10 due reconciliation attempts. Individual provider lookups have a five-second
deadline; their retry interval grows from five minutes to one hour. Acceptance
repair uses saved evidence without decrypting credentials or contacting Brevo.
Provider JSON reads are bounded (64 KiB for submission, 256 KiB for event lookup).
Errors/audit/logs omit provider bodies, email content, secrets and underlying SDK
error chains; persisted failures use stable diagnostic text/codes.

## Upgrade and operational limits

Back up and use the [normal upgrade procedure](../operations/updates.md). Before
schema 0039, pause/drain old sending activity and inspect due queued work. Old
code could already have resubmitted an ambiguous job; no migration can reconstruct
that history or undo an external delivery.

Migration 0039 conservatively journals existing sending jobs and due queued jobs.
Rows with a saved provider ID become accepted repair work; rows without one are
held as uncorrelated legacy unknown work, even if some were truly never sent.
Future scheduled queued jobs remain queued. Legacy attempts have no transmitted
attempt tag, so they are not eligible for automatic tag lookup. Resolve their
actual provider submission privately before taking any intentional resend action;
never bulk reset unknown jobs. This change provides no automatic user-facing
override that would discard the evidence fence.

Do not revert to a pre-0039 sender/reclaimer while journaled work remains: older
code ignores the fence. Keep the additive schema and use a compatible forward fix.
Publication and real provider/callback acceptance are separate from local tests.

## Provider references

Retrieved 2026-10-16; these describe the protocol, not live-installation evidence:

- [Brevo send API](https://developers.brevo.com/reference/send-transac-email):
  custom headers and tags.
- [Idempotency](https://developers.brevo.com/docs/heterogenous-versions-batch-emails):
  documented `headers.idempotencyKey`, UUID keys and a 30-minute window. Local
  duplicate safety does not rely on that window or assume it was live-verified.
- [Transactional webhooks](https://developers.brevo.com/docs/transactional-webhooks):
  `X-Mailin-custom`, provider message IDs and event times.
- [Event report](https://developers.brevo.com/reference/get-email-event-report):
  serialized tag filter and returned tag/message/date evidence. Queries are
  bounded; absence of a result remains unknown.
