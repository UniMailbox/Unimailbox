// process-outbound-job — CAP-023 + CAP-028 queue consumer use case.
// Owner: outbound-mail module. Private file — export through
// modules/outbound-mail/index.ts.
//
// This is the seam between the Cloudflare Queue plumbing (entrypoints/queue.ts)
// and the actual send. It is intentionally callable directly from tests so the
// happy / failure / idempotent-skip / stale-worker paths can be exercised
// without queue plumbing (per .claude/rules/testing.md §Failure paths).
//
// CAP-028 flow (replaces the unconditional 'sending' write of CAP-023):
//   1. claimOutboundJob with a per-invocation UUID (lockedBy) — R-OUTBOUND-007.
//      On null: throw DomainError(LOCK_CONTENTION). The queue consumer's catch
//      block calls msg.retry(); the lease expiry is the eventual backstop.
//   2. read everything else, decrypt the API key (R-SECRET-002, ADR-007).
//   3. adapter.send — R-OUTBOUND-004: provider idempotency key = message id.
//   4. success  → markOutboundJobSent (predicate locked_by = lockedBy)
//   5. retryable → if attempts+1 >= max_attempts, markOutboundJobTerminal,
//                  else markOutboundJobRetryable. Use case rethrows for retry.
//   6. terminal  → markOutboundJobTerminal, do NOT rethrow (job is acked).
//
// Steps 3–9 share one failure path: a failure anywhere AFTER the claim but
// BEFORE the send result exists (missing message/connection/credential,
// decrypt failure, provider error) goes through the same retryable/terminal
// decision (R-OUTBOUND-008), so no post-claim failure can strand the row in
// 'sending' with a held lease and no attempts increment. The success writes
// (steps 10–11) are deliberately OUTSIDE that catch — see the comment at the
// post-send block (CAP-028 F2).
//
// The adapter is supplied by the caller (dependency inversion) so tests can
// pass a mock without reaching into module internals.

import type { Database } from '../../platform/database';
import type {
  AuditEventWriter,
  OutboundProviderAdapter,
  ProviderAttachment,
  ProviderRuntimeContext,
  SendProviderMessage,
} from '@unimailbox/contracts';
import { TerminalProviderError } from '@unimailbox/contracts';
import type { AttachmentByteStore } from '../../platform/cache';
import { DomainError } from '../../platform/errors';
import { systemIds } from '../../platform/ids';
import { OUTBOX_LEASE_TTL_MS } from '../../platform/outbox-config';
import { sqliteTimestamp } from '../../platform/idempotency';
import { importEncryptionKey, decrypt } from '../../platform/crypto';
import { systemClock, type Clock } from '../../platform/clock';
import { logger } from '../../platform/logger';
import { listMessageAttachmentsForSend, updateMessageStatus } from '../messages';
import {
  claimOutboundJob,
  getOutboundJob,
  markOutboundJobRetryable,
  markOutboundJobSent,
  markOutboundJobTerminal,
  type OutboundJobRow,
} from './job-repository';
import { reconcileWebhookDeliveries } from './reconcile-webhook-deliveries';

export interface ProcessJobDeps {
  readonly db: Database;
  readonly encryptionKey: string;
  readonly adapter: OutboundProviderAdapter;
  /**
   * Per-invocation UUID stamping the lock. Optional — when the queue
   * consumer does not pass one, `processOutboundJob` generates a fresh
   * UUID via `systemIds.uuid()`. Tests inject a deterministic UUID.
   */
  readonly lockedBy?: string;
  /**
   * Clock used for the lease-until computation. Optional — defaults to
   * `systemClock`. Tests inject a fixed clock
   * (.claude/rules/testing.md §Determinism).
   */
  readonly clock?: Clock;
  /**
   * CAP-040 / R-AUDIT-001: per-invocation correlation UUID. The entrypoint
   * synthesises one and passes it through so every audit row emitted by
   * this use case (reconciliation back-fill) carries the same requestId.
   * Optional — when absent the reconciliation writes an audit row with
   * `request_id = NULL`.
   */
  readonly requestId?: string | null;
  /**
   * CAP-040 / D-CAP-029-A: cross-module audit writer, looked up off
   * AppContext by the entrypoint. Required to write the reconciliation
   * audit row atomically with the back-fill UPDATEs.
   */
  readonly auditEventWriter?: AuditEventWriter;
  /**
   * CAP-050: narrow CACHE seam used to read CAP-049-staged attachment
   * bytes for `SendProviderMessage.attachments`. Optional — the
   * no-attachment test fixtures (and the early CAP-023 / CAP-028
   * callers) never pass it, so existing entrypoints and tests stay
   * byte-identical. When present, every attachment row from
   * `listMessageAttachmentsForSend` is fetched through this store; a
   * missing or size-mismatched byte aborts the pre-send step with
   * SEND_FAILED, exactly like a missing credential.
   */
  readonly attachmentByteStore?: AttachmentByteStore;
}

/** Message columns read from the messages table for sending. */
interface MessageRow {
  readonly from_address: string;
  readonly from_name: string | null;
  readonly subject: string | null;
  readonly html_body: string | null;
  readonly text_body: string | null;
  readonly message_id_header: string | null;
  readonly in_reply_to_header: string | null;
  readonly references_header: string | null;
}

interface RecipientRow {
  readonly address: string;
  readonly display_name: string | null;
  readonly type: 'to' | 'cc' | 'bcc';
}

interface ConnectionRow {
  readonly credential_id: string;
  readonly provider_key: string;
}

interface CredentialRow {
  readonly ciphertext: ArrayBuffer;
  readonly iv: ArrayBuffer;
  readonly auth_tag: ArrayBuffer;
}

/**
 * Processes a single outbound job: claims it atomically, looks everything up,
 * decrypts the API key, sends via the supplied adapter, and updates the row
 * via a lock-holding write.
 *
 * @param jobId — UUID of the outbound_jobs row
 * @param deps — db, the decrypted CREDENTIAL_ENCRYPTION_KEY, the adapter, and
 *              optional per-invocation `lockedBy` UUID (defaults to a
 *              freshly-generated UUID) and `clock` (defaults to `systemClock`)
 * @throws DomainError(LOCK_CONTENTION) if the row is not in 'queued' status
 *         (already sending/sent/failed or no live lease available). The
 *         queue consumer's catch path is responsible for retry semantics.
 * @throws Error if the job does not exist (before any write)
 * @throws the underlying provider or pre-send error after recording it on
 *         the job (retryable path; the terminal path resolves instead)
 */
export async function processOutboundJob(jobId: string, deps: ProcessJobDeps): Promise<void> {
  const { db, encryptionKey, adapter } = deps;
  const lockedBy = deps.lockedBy ?? systemIds.uuid();
  const clock = deps.clock ?? systemClock;

  // 1. Read job. A job that is already 'sent' is a redelivery — skip silently.
  // This keeps the consumer idempotent under at-least-once delivery (R-OUTBOUND-009).
  const precheckJob = await getOutboundJob(db, jobId);
  if (!precheckJob) {
    throw new Error(`Outbound job not found: ${jobId}`);
  }
  if (precheckJob.status === 'sent') {
    return;
  }

  // 2. Claim the row atomically (R-OUTBOUND-007). The lease expiry is
  // computed from the injected clock so the claim and any later comparison
  // against it use the same instant.
  const leaseUntil = sqliteTimestamp(new Date(clock.unixMs() + OUTBOX_LEASE_TTL_MS));
  const claimed: OutboundJobRow | null = await claimOutboundJob(db, jobId, lockedBy, leaseUntil);
  if (!claimed) {
    // Either another worker holds a live lease (LOCK_CONTENTION — the queue's
    // msg.retry() is the right backoff) or the row is already in a terminal
    // state (R-OUTBOUND-009 — the precheck above catches the 'sent' case but
    // a 'failed' mid-flight by the reclaim path can also surface here).
    throw new DomainError({
      code: 'LOCK_CONTENTION',
      message: 'Outbound job is not claimable: leased or terminal',
    });
  }

  // Steps 3–9 share one try/catch: any failure after the claim (missing
  // message/connection/credential, decrypt failure, provider error) goes
  // through the same retryable/terminal decision so the row can never be
  // stranded in 'sending' with a held lease and no attempts increment.
  let sendResult: Awaited<ReturnType<OutboundProviderAdapter['send']>>;
  try {
    // 3. Read message. We only select the columns we need to build the send.
    const msg = await db
      .prepare(
        'SELECT from_address, from_name, subject, html_body, text_body, message_id_header, in_reply_to_header, references_header FROM messages WHERE id = ?',
      )
      .bind(claimed.message_id)
      .first<MessageRow>();
    if (!msg) {
      throw new Error(`Message not found: ${claimed.message_id}`);
    }

    // 4. Read recipients. bcc is intentionally not loaded — outbound providers
    // strip it anyway and we never want to leak bcc addresses to 'to'/'cc'
    // recipients via the provider payload.
    const recipientsResult = await db
      .prepare(
        "SELECT address, display_name, type FROM message_recipients WHERE message_id = ? AND type IN ('to', 'cc')",
      )
      .bind(claimed.message_id)
      .all<RecipientRow>();
    const recipients = recipientsResult.results ?? [];

    // 5. Read provider connection.
    const conn = await db
      .prepare('SELECT credential_id, provider_key FROM provider_connections WHERE id = ?')
      .bind(claimed.provider_connection_id)
      .first<ConnectionRow>();
    if (!conn) {
      throw new Error(`Provider connection not found: ${claimed.provider_connection_id}`);
    }

    // 6. Read encrypted credential by ID.
    const cred = await db
      .prepare('SELECT ciphertext, iv, auth_tag FROM encrypted_credentials WHERE id = ?')
      .bind(conn.credential_id)
      .first<CredentialRow>();
    if (!cred) {
      throw new Error(`Credential not found: ${conn.credential_id}`);
    }

    // 7. Decrypt the API key. R-SECRET-002: the plaintext lives only for the
    // lifetime of this request — it goes into the adapter context and nowhere
    // else. We do not cache it (ADR-007 §caching).
    const key = await importEncryptionKey(encryptionKey);
    const apiKey = await decrypt(
      {
        ciphertext: new Uint8Array(cred.ciphertext),
        iv: new Uint8Array(cred.iv),
        authTag: new Uint8Array(cred.auth_tag),
      },
      key,
    );

    // 8. Build the provider-neutral payload.
    const toRecipients = recipients.filter((r) => r.type === 'to');
    const ccRecipients = recipients.filter((r) => r.type === 'cc');

    // CAP-050: read the per-message attachment projection from D1, then
    // pull the exact bytes from CACHE through the `attachmentByteStore`
    // seam. The metadata is the authoritative source — never anything
    // derived from the client. Missing bytes or a size mismatch abort
    // the pre-send step the same way a missing credential does, so the
    // existing retryable/terminal decision treats this as a normal
    // send failure.
    const attachmentRows = await listMessageAttachmentsForSend(db, {
      messageId: claimed.message_id,
    });
    const providerAttachments: ProviderAttachment[] = [];
    for (const row of attachmentRows) {
      if (!deps.attachmentByteStore) {
        throw new Error(
          `Attachment byte store not provided but message ${claimed.message_id} has ${row.uploadId}`,
        );
      }
      const bytes = await deps.attachmentByteStore.get(row.objectKey);
      if (!bytes) {
        throw new Error(`Attachment bytes missing for upload ${row.uploadId}`);
      }
      if (bytes.byteLength !== row.sizeBytes) {
        throw new Error(
          `Attachment byte length mismatch for upload ${row.uploadId}: ` +
            `metadata=${row.sizeBytes} bytes=${bytes.byteLength}`,
        );
      }
      providerAttachments.push({
        filename: row.filename,
        contentType: row.contentType,
        disposition: row.disposition,
        ...(row.contentId ? { contentId: row.contentId } : {}),
        content: bytes,
      });
    }

    const sendMsg: SendProviderMessage = {
      // R-OUTBOUND-004: provider calls use the canonical message ID as their
      // idempotency key so a redelivery cannot double-send.
      idempotencyKey: claimed.message_id,
      from: {
        address: msg.from_address,
        ...(msg.from_name ? { displayName: msg.from_name } : {}),
      },
      to: toRecipients.map((r) => ({
        address: r.address,
        ...(r.display_name ? { displayName: r.display_name } : {}),
      })),
      cc: ccRecipients.map((r) => ({
        address: r.address,
        ...(r.display_name ? { displayName: r.display_name } : {}),
      })),
      bcc: [],
      subject: msg.subject ?? '',
      html: msg.html_body ?? '',
      text: msg.text_body ?? '',
      ...(msg.message_id_header ? { messageId: msg.message_id_header } : {}),
      ...(msg.in_reply_to_header ? { inReplyTo: msg.in_reply_to_header } : {}),
      references: msg.references_header ?? '',
      attachments: providerAttachments,
    };

    const ctx: ProviderRuntimeContext = { env: { BREVO_API_KEY: apiKey } };

    // 9. Send. Declared outside the try so the success writes below can read
    // it without widening the steps-3–9 catch to cover them.
    sendResult = await adapter.send(ctx, sendMsg);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';

    // CAP-029 D-CAP-028-A + B3: a typed TerminalProviderError short-circuits
    // the attempts budget — retrying an identical 4xx payload will never
    // succeed, so we mark the job failed on the first attempt instead of
    // burning `max_attempts` retries. The error code is recorded verbatim
    // ('TERMINAL_PROVIDER_ERROR' is stable for the audit trail); the
    // underlying provider HTTP status (when carried) goes in the message
    // via the underlying error's message, not as a separate column.
    if (error instanceof TerminalProviderError) {
      await markOutboundJobTerminal(db, jobId, lockedBy, 'TERMINAL_PROVIDER_ERROR', message);
      return;
    }

    // The only error code we trust from the remaining failure modes is a
    // DomainError's stable `code` field (closed catalog, CAP-032). Anything
    // else — a RetryableProviderError, an SDK error, a DOMException's legacy
    // numeric `code`, library strings like 'ECONNRESET' — is not in the
    // catalog and becomes 'SEND_FAILED'.
    const code = error instanceof DomainError ? error.code : 'SEND_FAILED';

    // R-OUTBOUND-008: retryable vs terminal is decided by the attempts
    // counter only. If the next attempt would reach max_attempts, mark
    // terminal (no retry, no rethrow → queue acks).
    const nextAttempts = claimed.attempts + 1;
    const isTerminal = nextAttempts >= claimed.max_attempts;

    if (isTerminal) {
      await markOutboundJobTerminal(db, jobId, lockedBy, code, message);
      // Do NOT rethrow — terminal failure means the queue should ack.
      return;
    }

    await markOutboundJobRetryable(db, jobId, lockedBy, code, message);
    throw error;
  }

  // Steps 10–11 — the success writes. These sit OUTSIDE the steps-3–9 catch
  // on purpose (CAP-028 F2): the send already succeeded, so a failure here is
  // bookkeeping, not a send failure. Routing it into the retryable/terminal
  // path would burn an attempt (or write `failed`!) on a send that succeeded
  // and would never fire the divergence warn. Instead: log the failure and
  // rethrow without any attempts logic — the row stays `sending` with this
  // worker's lease held, and the lease-expiry + cron reclaim path recovers
  // it. The resend on the recovered attempt is deduped by the provider
  // idempotency key (R-OUTBOUND-004), so no double-delivery.
  try {
    const now = sqliteTimestamp(new Date());
    const nowMs = Date.now();
    // CAP-029 D-CAP-028-D: the messages row write is the public messages-
    // module surface. updateMessageStatus owns the rank-aware predicate
    // (R-MESSAGE-007) so an out-of-order webhook arriving mid-send cannot
    // clobber the 'sent' status. sent_at is supplied by this call (Q3
    // decision: updateMessageStatus owns sent_at to keep `messages` row
    // writes consolidated inside the messages module).
    // CAP-029 L2 review-triage: capture the boolean return so the
    // divergence warn below can name which surface rejected the write
    // (cross-module = message row rejected by rank-aware predicate too).
    const messageAdvanced = await updateMessageStatus(db, {
      messageId: claimed.message_id,
      status: 'sent',
      providerEventTimeMs: nowMs,
      sentAt: now,
      now,
    });

    // R-OUTBOUND-007 / R-OUTBOUND-009: the predicate locked_by = lockedBy
    // makes this write a no-op if a reclaim stole the row mid-send. The
    // boolean return surfaces that divergence as a warn (adjudicated at
    // CAP-028 review triage) — the row was resolved by whoever stole the
    // lock and the provider did report success, so throwing here would
    // re-drive an already-resolved job.
    const jobAdvanced = await markOutboundJobSent(
      db,
      jobId,
      lockedBy,
      sendResult.providerMessageId,
    );

    // CAP-040 / D-CAP-040-ARCH-H1: gate reconciliation on
    // `sendResult.providerMessageId`, NOT on `jobAdvanced`. The provider has
    // already accepted the message — the canonical id is real — so even when
    // a reclaim stole the lock mid-send and `markOutboundJobSent` is a no-op,
    // any webhook_deliveries row that landed with `message_id = NULL`
    // (the early-event case) must still be back-filled. Skipping this would
    // orphan the delivery row forever: a sibling job that re-runs sees a
    // `sent` job and a `processed` delivery with no message link.
    //
    // Idempotent: a second pass with no unmatched rows back-fills nothing;
    // the audit row is still emitted for traceability.
    if (sendResult.providerMessageId && deps.auditEventWriter) {
      try {
        await reconcileWebhookDeliveries(db, {
          connectionId: claimed.provider_connection_id,
          providerMessageId: sendResult.providerMessageId,
          messageId: claimed.message_id,
          actorUserId: null,
          requestId: deps.requestId ?? null,
          createdAt: now,
          auditEventWriter: deps.auditEventWriter,
        });
      } catch (error) {
        // R-LOG-001: job ID only — no bodies, no provider payload. The
        // reconciliation is best-effort: the row stays in `sent` and any
        // future reconcile pass (e.g. a stuck-but-eventually-completed
        // sibling job) will catch up. Failing the whole send path on a
        // reconciliation miss would overstate the impact.
        logger.warn(
          { event: 'outbound.reconcile_failed' },
          {
            source: 'process-outbound-job',
            jobId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
    if (!jobAdvanced || !messageAdvanced) {
      // CAP-029 L2 review-triage: a single combined warn names which
      // surface(s) rejected the write so an operator triaging a "lock
      // stolen before success write" can see whether the message-row
      // write was also rejected (cross-module divergence) or succeeded
      // (intra-module only). R-LOG-001: job ID + boolean flags only —
      // no bodies, no provider payload, no stack traces.
      logger.warn(
        { event: 'outbound.job_sent_divergence' },
        {
          source: 'process-outbound-job',
          jobId,
          reason: 'lock stolen before success write; row resolved elsewhere',
          jobAdvanced,
          messageAdvanced,
        },
      );
    }
  } catch (error) {
    // R-LOG-001: job ID only — no bodies, no provider payload.
    logger.error(
      { event: 'outbound.job_post_send_write_failed' },
      {
        source: 'process-outbound-job',
        jobId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    throw error;
  }
}
