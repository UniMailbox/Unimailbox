// Durable outbound submission; accepted/unknown evidence fences provider replay.
import { scheduleDelaySeconds, QUEUE_DELAY_MAX_SECONDS } from './schedule-time';
import type { Database } from '../../platform/database';
import type {
  AuditEventWriter,
  OutboundProviderAdapter,
  ProviderAttachment,
  ProviderRuntimeContext,
  ProviderKey,
  SendProviderMessage,
} from '@unimailbox/contracts';
import {
  parseProviderKey,
  TerminalProviderError,
  RetryableProviderError,
  UnknownProviderOutcomeError,
} from '@unimailbox/contracts';
import type { AttachmentByteStore, AttachmentObjectStore } from '../../platform/cache';
import { DomainError } from '../../platform/errors';
import { systemIds } from '../../platform/ids';
import {
  OUTBOX_LEASE_TTL_MS,
  OUTBOUND_REQUEST_TIMEOUT_MS,
  OUTBOUND_LEASE_WRITE_MARGIN_MS,
} from '../../platform/outbox-config';
import { sqliteTimestamp } from '../../platform/idempotency';
import { importEncryptionKey, decrypt } from '../../platform/crypto';
import { systemClock, type Clock } from '../../platform/clock';
import { logger } from '../../platform/logger';
import { listMessageAttachmentsForSend } from '../messages';
import { listHostedMessageObjectKeys } from '../editor-assets';
import {
  claimOutboundJob,
  getOutboundJob,
  markOutboundJobRetryable,
  markOutboundJobTerminal,
  isJobTerminal,
  type OutboundJobRow,
} from './job-repository';
import {
  findUnresolvedAttempt,
  getOutboundAttempt,
  prepareOutboundAttempt,
  submitOutboundAttempt,
  acceptOutboundAttempt,
  markAttemptUnknown,
  prepareRejectAttempt,
} from './attempt-repository';
import { finalizeAcceptedSubmission } from './finalize-submission';

export interface ProcessJobDeps {
  readonly db: Database;
  readonly encryptionKey: string;
  /** Legacy direct injection for focused tests and setup smoke sends. */
  readonly adapter?: OutboundProviderAdapter;
  /** Resolve the job's provider after claiming it, so failures are recorded. */
  readonly resolveAdapter?: (key: ProviderKey) => OutboundProviderAdapter | undefined;
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
  /** Persistent R2 bytes; CACHE remains a compatibility fallback for staged jobs. */
  readonly attachmentObjectStore?: AttachmentObjectStore;
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
  readonly status: 'active' | 'disabled' | 'invalid';
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
 * @param deps — db, the decrypted CREDENTIAL_ENCRYPTION_KEY, an adapter resolver, and
 *              optional per-invocation `lockedBy` UUID (defaults to a
 *              freshly-generated UUID) and `clock` (defaults to `systemClock`)
 * @throws DomainError(LOCK_CONTENTION) if the row is not in 'queued' status
 *         (already sending/sent/failed or no live lease available). The
 *         queue consumer's catch path is responsible for retry semantics.
 * @throws Error if the job does not exist (before any write)
 * @throws the underlying provider or pre-send error after recording it on
 *         the job (retryable path; the terminal path resolves instead)
 */
export async function processOutboundJob(
  jobId: string,
  deps: ProcessJobDeps,
): Promise<void | { delaySeconds: number }> {
  const { db, encryptionKey } = deps;
  const lockedBy = deps.lockedBy ?? systemIds.uuid();
  const clock = deps.clock ?? systemClock;

  // 1. Read job. Terminal jobs are redeliveries — skip silently so the
  // queue can ack them under at-least-once delivery (R-OUTBOUND-009).
  const precheckJob = await getOutboundJob(db, jobId);
  if (!precheckJob) {
    throw new Error(`Outbound job not found: ${jobId}`);
  }
  if (isJobTerminal(precheckJob.status)) {
    return;
  }

  const evidence = await findUnresolvedAttempt(db, jobId);
  if (evidence) {
    if (evidence.status === 'accepted')
      await finalizeAcceptedSubmission(db, evidence.id, clock.now(), deps.auditEventWriter);
    return; // Submitted/unknown work waits for authenticated evidence, never automatic replay.
  }
  if (precheckJob.next_attempt_at) {
    const retryDelay = Math.ceil(
      (Date.parse(precheckJob.next_attempt_at.replace(' ', 'T') + 'Z') - clock.unixMs()) / 1000,
    );
    if (retryDelay > 0) return { delaySeconds: Math.min(QUEUE_DELAY_MAX_SECONDS, retryDelay) };
  }

  const delaySeconds = scheduleDelaySeconds(precheckJob.scheduled_at, clock.now());
  if (delaySeconds > 0) {
    // A moved far-future task will be picked up by recovery within 24h.
    if (delaySeconds > QUEUE_DELAY_MAX_SECONDS) return;
    return { delaySeconds };
  }

  // 2. Claim the row atomically (R-OUTBOUND-007). The lease expiry is
  // computed from the injected clock so the claim and any later comparison
  // against it use the same instant.
  const leaseUntil = sqliteTimestamp(new Date(clock.unixMs() + OUTBOX_LEASE_TTL_MS));
  const claimed: OutboundJobRow | null = await claimOutboundJob(
    db,
    jobId,
    lockedBy,
    leaseUntil,
    sqliteTimestamp(clock.now()),
  );
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

  // Preparation failures are safe to retry. Once the submitted marker commits,
  // only explicit provider rejection can release the durable send fence.
  let sendResult: Awaited<ReturnType<OutboundProviderAdapter['send']>>;
  let attemptId: string | null = null;
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

    // Blind recipients belong only in the provider's Bcc envelope, never To/Cc.
    const recipientsResult = await db
      .prepare(
        "SELECT address, display_name, type FROM message_recipients WHERE message_id = ? AND type IN ('to', 'cc', 'bcc')",
      )
      .bind(claimed.message_id)
      .all<RecipientRow>();
    const recipients = recipientsResult.results ?? [];

    // 5. Read provider connection.
    const conn = await db
      .prepare('SELECT credential_id, provider_key, status FROM provider_connections WHERE id = ?')
      .bind(claimed.provider_connection_id)
      .first<ConnectionRow>();
    if (!conn) {
      throw new TerminalProviderError({
        message: `Provider connection not found: ${claimed.provider_connection_id}`,
      });
    }
    if (conn.status !== 'active') {
      throw new TerminalProviderError({
        message: `Provider connection is ${conn.status}: ${claimed.provider_connection_id}`,
      });
    }
    const providerKey = parseProviderKey(conn.provider_key);
    const adapter = deps.resolveAdapter?.(providerKey) ?? deps.adapter;
    if (!adapter) {
      throw new TerminalProviderError({
        message: `Provider adapter not registered: ${conn.provider_key}`,
      });
    }
    if (adapter.key !== providerKey) {
      throw new TerminalProviderError({
        message: `Provider adapter mismatch for connection ${claimed.provider_connection_id}`,
      });
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
    const hostedObjectKeys = await listHostedMessageObjectKeys(db, claimed.message_id);
    for (const row of attachmentRows) {
      if (hostedObjectKeys.has(row.objectKey)) continue;
      if (!deps.attachmentByteStore) {
        throw new Error(
          `Attachment byte store not provided but message ${claimed.message_id} has ${row.uploadId}`,
        );
      }
      const bytes =
        (await deps.attachmentObjectStore?.get(row.objectKey)) ??
        (await deps.attachmentByteStore?.get(row.objectKey));
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
      // idempotency key; the durable attempt fence separately guards replay.
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
      bcc: recipients
        .filter((r) => r.type === 'bcc')
        .map((r) => ({
          address: r.address,
          ...(r.display_name ? { displayName: r.display_name } : {}),
        })),
      subject: msg.subject ?? '',
      html: msg.html_body ?? '',
      text: msg.text_body ?? '',
      ...(msg.message_id_header ? { messageId: msg.message_id_header } : {}),
      ...(msg.in_reply_to_header ? { inReplyTo: msg.in_reply_to_header } : {}),
      references: msg.references_header ?? '',
      attachments: providerAttachments,
    };

    const ctx: ProviderRuntimeContext = {
      timeoutMs: OUTBOUND_REQUEST_TIMEOUT_MS,
      env: {
        // Provider-neutral adapters consume this key. BREVO_API_KEY remains
        // as a compatibility alias for the existing Brevo adapter contract.
        PROVIDER_API_KEY: apiKey,
        ...(conn.provider_key === 'brevo' ? { BREVO_API_KEY: apiKey } : {}),
      },
    };

    // Reserve and fence before the provider boundary. Prepared work is safe to
    // recover; a committed submitted record makes a later crash outcome unknown.
    const currentAttemptId = systemIds.uuid();
    attemptId = currentAttemptId;
    await prepareOutboundAttempt(db, {
      id: attemptId,
      jobId,
      providerKey,
      lockedBy,
      now: clock.now(),
      requestId: deps.requestId ?? null,
    });
    await submitOutboundAttempt(
      db,
      attemptId,
      lockedBy,
      clock.now(),
      new Date(clock.unixMs() + OUTBOUND_REQUEST_TIMEOUT_MS + OUTBOUND_LEASE_WRITE_MARGIN_MS),
    );
    sendResult = await boundedSubmission(() =>
      adapter.send(ctx, { ...sendMsg, attemptId: currentAttemptId }),
    );
    if (
      typeof sendResult?.providerMessageId !== 'string' ||
      !sendResult.providerMessageId.trim() ||
      sendResult.providerMessageId.length > 1024 ||
      !Number.isFinite(Date.parse(sendResult.acceptedAt))
    )
      throw new UnknownProviderOutcomeError({
        message: 'Provider returned invalid acceptance evidence',
      });
  } catch (error) {
    const recorded = attemptId ? await getOutboundAttempt(db, attemptId) : null;
    if (recorded?.status === 'accepted') {
      await finalizeAcceptedSubmission(db, recorded.id, clock.now(), deps.auditEventWriter);
      return;
    }
    if (
      recorded?.status === 'submitted' &&
      !(error instanceof RetryableProviderError) &&
      !(error instanceof TerminalProviderError)
    ) {
      await markAttemptUnknown(db, recorded, lockedBy, clock.now());
      logger.warn(
        {
          event: 'outbound.outcome_unknown',
          ...(deps.requestId ? { requestId: deps.requestId } : {}),
        },
        { code: 'SEND_OUTCOME_UNKNOWN' },
      );
      return;
    }
    if (recorded) await prepareRejectAttempt(db, recorded.id, clock.now()).run();
    const code = error instanceof TerminalProviderError ? 'TERMINAL_PROVIDER_ERROR' : 'SEND_FAILED';
    if (error instanceof TerminalProviderError || claimed.attempts + 1 >= claimed.max_attempts) {
      await markOutboundJobTerminal(
        db,
        jobId,
        lockedBy,
        code,
        error instanceof TerminalProviderError
          ? `Provider rejected submission: status ${error.httpStatus ?? 'unavailable'}`
          : 'Confirmed rejection exhausted attempts',
      );
      return;
    }
    const backoff = Math.min(3600, 30 * 2 ** Math.min(claimed.attempts, 7));
    const delay = Math.max(
      backoff,
      error instanceof RetryableProviderError ? (error.retryAfterSeconds ?? 0) : 0,
    );
    await markOutboundJobRetryable(
      db,
      jobId,
      lockedBy,
      code,
      'Confirmed unsent work deferred',
      sqliteTimestamp(new Date(clock.unixMs() + delay * 1000)),
    );
    throw error;
  }

  // Persist provider acceptance independently before the business finalization
  // batch. A failed message/audit write can then be repaired without another send.
  if (!attemptId) throw new Error('Outbound attempt was not reserved');
  await acceptOutboundAttempt(db, attemptId, sendResult, clock.now());
  await finalizeAcceptedSubmission(db, attemptId, clock.now(), deps.auditEventWriter);
}

async function boundedSubmission<T>(send: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(send),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new UnknownProviderOutcomeError({ message: 'Provider submission timed out' })),
          OUTBOUND_REQUEST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
