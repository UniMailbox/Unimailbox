# Durable inbound receipt and recovery

The [inbound rules](02-business-discovery/business-rules.md#r-inbound--inbound-mail)
own size, deduplication, acceptance and forwarding semantics. This document owns
their processing design. Migration `0038_inbound_receipts.sql` is additive; it
does not backfill or deduplicate existing messages.

## Acceptance boundary

The Email Routing entrypoint retains setup smoke handling and the existing
external-copy forwarding order. It then resolves the SMTP envelope recipient
before reading MIME. The declared size is checked before reading; a bounded
reader also checks the actual bytes, cancels an oversized stream and releases
its reader. The application raw-MIME limit is independent of upload settings.

MIME parsing, blocklist and owner-role policies remain synchronous. A rejection
creates neither a receipt, local message, R2 object nor receive audit. MIME To/Cc
never chooses a destination mailbox. External copying still occurs before local
rejection, and a forwarding failure still propagates before local persistence.

After policy acceptance:

1. Hash the original bytes and the mailbox/normalized SMTP sender/recipient scope.
2. Return the existing unexpired receipt when the scoped fingerprint matches.
3. Write the raw bytes to a fresh opaque R2 key, then reserve a D1 receipt.
   Concurrent reservations converge on one receipt; losing raw objects are
   removed best-effort. A failed or ambiguous reservation propagates and leaves
   raw cleanup to the reference-aware orphan sweep.
4. Attempt local message finalization immediately using the already parsed MIME.
5. A post-acceptance failure leaves durable work and requests delayed Queue
   processing. A failed enqueue does not undo acceptance: Cron repairs dispatch.

The durable receipt is the local acceptance boundary. No correctness claim
depends on Email Routing automatically retrying a failed Worker invocation.

## Receipt processing

`messages` owns receipt persistence; `inbound-mail` orchestrates acceptance and
processing through its public API. The receipt ID is the eventual message ID.
Raw bytes, source mailbox, envelope and receive correlation ID are fixed at
acceptance. Recovery verifies raw length and SHA-256 and reparses those bytes;
it does not rerun later policy changes or external forwarding.

| State | Transition |
| --- | --- |
| `pending` | Claim when its retry time is due; increment attempt count and acquire a two-minute lease. |
| `processing` | Complete, return to pending with backoff, or reclaim an expired lease. |
| `completed` | Terminal; repeated processing is a no-op. Expire only the receipt after the deduplication window. |

The completion batch first changes the receipt under its lease token and asserts
that the transition happened. Message, recipients, mailbox association, attachment
metadata and `message.receive` audit commit in the same batch. A stale token,
duplicate message or failed audit rolls back the entire batch. Operational
claims/retries are journal bookkeeping; the receive audit represents the visible
business transition exactly once.

Attachments use fresh attempt-specific keys so stale workers cannot overwrite a
winner's bytes. A failed attempt may leave unreferenced attachment objects for
normal orphan cleanup. Pending receipts protect their raw MIME regardless of age.
Once completed receipts expire, message/attachment references continue protecting
published bytes. Missing or corrupt raw bytes keep the receipt pending and make
the installation unhealthy when overdue; they are never silently discarded.

## Queue, maintenance and bounds

The existing queue's historical binding/name remains `OUTBOUND`; it now accepts
both legacy outbound `{jobId}` bodies and strict inbound
`{kind: "inbound", version: 1, receiptId}` envelopes. No new resource or trigger is
required. Queue payloads contain IDs rather than mail content. Inbound processing
does not require outbound-provider credentials.

The existing five-minute Cron dispatches at most 20 eligible receipts per tick.
An independent dispatch checkpoint prevents repeated concurrent dispatch without
delaying processing eligibility. A crash before enqueue or an enqueue failure
becomes eligible again after five minutes. Processing failure uses exponential
backoff from 30 seconds to one hour. Work remains durable after Queue retry
exhaustion; normal DLQ monitoring and inspection still apply. Shared queue
capacity and the bounded dispatch rate must be measured before increasing volume.

Hourly maintenance removes at most 1,000 expired completed receipts. Pending and
processing receipts are not expired. Maintenance health includes incomplete
receipts older than 15 minutes, using original acceptance time so retries cannot
hide stalled mail. Logs contain stable error codes and correlation IDs, never
raw MIME, envelope addresses, fingerprints, provider bodies or attachment bytes.

## Limits and operations

The deduplication scope deliberately distinguishes different bytes, SMTP senders,
envelope recipients and mailboxes, including catch-all aliases. This is bounded
local duplicate suppression, not a universal SMTP delivery identity. Identical
intentional deliveries inside the same window are indistinguishable from retries;
retries with changed raw bytes are distinct. External forwarding remains outside
the D1/R2 transaction and may produce another copy on an upstream retry.

Use the existing [backup and deployment procedure](../operations/deploy.md).
Apply schema 0038 before publishing its Worker. A prepared build or passing local
suite does not prove live Email Routing/Queue delivery. Verify real receive,
attachment access, deliberate post-acceptance failure/recovery and preserved
external copying on the selected installation before marking it verified.

For an incident, correlate the inbound Queue receipt ID with `inbound_receipts`;
inspect status, attempts, retry/lease times and raw-object existence privately.
Fix the cause and let eligible pending/expired work recover. Never reset completed
receipts or bulk replay an unknown DLQ payload. Prefer a compatible forward fix
over rollback: an older Worker does not process this envelope or protect pending
raw references. Do not revert to a pre-0038 Worker while incomplete receipts or
inbound Queue/DLQ work remain; preserve the additive table and original raw bytes.
