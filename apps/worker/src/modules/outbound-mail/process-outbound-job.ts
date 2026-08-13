// process-outbound-job — CAP-023 queue consumer use case.
// Owner: outbound-mail module. Private file — export through
// modules/outbound-mail/index.ts.
//
// This is the seam between the Cloudflare Queue plumbing (entrypoints/queue.ts)
// and the actual send. It is intentionally callable directly from tests so the
// happy / failure / idempotent-skip paths can be exercised without queue
// plumbing (per .claude/rules/testing.md §Failure paths).
//
// Flow:
//   read job → (skip if already 'sent')
//   → read message + recipients + provider_connection + encrypted_credential
//   → decrypt API key (R-SECRET-002, ADR-007)
//   → mark job 'sending'
//   → build SendProviderMessage (R-OUTBOUND-004: idempotencyKey = message id)
//   → call adapter.send(ctx, msg)
//   → on success: message.status = 'sent', job.status = 'sent'
//   → on failure: job.status = 'failed', attempts++, rethrow (caller decides retry)
//
// The adapter is supplied by the caller (dependency inversion) so tests can
// pass a mock without reaching into module internals.

import type { Database } from '../../platform/database';
import type {
  OutboundProviderAdapter,
  ProviderRuntimeContext,
  SendProviderMessage,
} from '@unimailbox/contracts';
import { importEncryptionKey, decrypt } from '../../platform/crypto';
import { getOutboundJob, updateJobStatus } from './job-repository';

export interface ProcessJobDeps {
  readonly db: Database;
  readonly encryptionKey: string;
  readonly adapter: OutboundProviderAdapter;
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
 * Processes a single outbound job: looks everything up, decrypts the API key,
 * sends via the supplied adapter, and updates message + job status.
 *
 * @param jobId — UUID of the outbound_jobs row
 * @param deps — db, the decrypted CREDENTIAL_ENCRYPTION_KEY, and the adapter
 * @throws Error if the job, message, connection, or credential cannot be found
 *         (the queue consumer logs and retries / acks accordingly)
 * @throws the underlying provider error after recording it on the job
 */
export async function processOutboundJob(
  jobId: string,
  deps: ProcessJobDeps,
): Promise<void> {
  const { db, encryptionKey, adapter } = deps;

  // 1. Read job. A job that is already 'sent' is a redelivery — skip silently.
  // This keeps the consumer idempotent under at-least-once delivery.
  const job = await getOutboundJob(db, jobId);
  if (!job) {
    throw new Error(`Outbound job not found: ${jobId}`);
  }
  if (job.status === 'sent') {
    return;
  }

  // 2. Read message. We only select the columns we need to build the send.
  const msg = await db.prepare(
    'SELECT from_address, from_name, subject, html_body, text_body, message_id_header, in_reply_to_header, references_header FROM messages WHERE id = ?',
  ).bind(job.message_id).first<MessageRow>();
  if (!msg) {
    throw new Error(`Message not found: ${job.message_id}`);
  }

  // 3. Read recipients. bcc is intentionally not loaded — outbound providers
  // strip it anyway and we never want to leak bcc addresses to 'to'/'cc'
  // recipients via the provider payload.
  const recipientsResult = await db.prepare(
    "SELECT address, display_name, type FROM message_recipients WHERE message_id = ? AND type IN ('to', 'cc')",
  ).bind(job.message_id).all<RecipientRow>();
  const recipients = recipientsResult.results ?? [];

  // 4. Read provider connection.
  const conn = await db.prepare(
    'SELECT credential_id, provider_key FROM provider_connections WHERE id = ?',
  ).bind(job.provider_connection_id).first<ConnectionRow>();
  if (!conn) {
    throw new Error(`Provider connection not found: ${job.provider_connection_id}`);
  }

  // 5. Read encrypted credential by ID.
  const cred = await db.prepare(
    'SELECT ciphertext, iv, auth_tag FROM encrypted_credentials WHERE id = ?',
  ).bind(conn.credential_id).first<CredentialRow>();
  if (!cred) {
    throw new Error(`Credential not found: ${conn.credential_id}`);
  }

  // 6. Decrypt the API key. R-SECRET-002: the plaintext lives only for the
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

  // 7. Mark the job 'sending' before we hit the provider so an observer can
  // tell the two states apart.
  await updateJobStatus(db, jobId, 'sending');

  // 8. Build the provider-neutral payload.
  const toRecipients = recipients.filter((r) => r.type === 'to');
  const ccRecipients = recipients.filter((r) => r.type === 'cc');

  const sendMsg: SendProviderMessage = {
    // R-OUTBOUND-004: provider calls use the canonical message ID as their
    // idempotency key so a redelivery cannot double-send.
    idempotencyKey: job.message_id,
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
    attachments: [],
  };

  const ctx: ProviderRuntimeContext = { env: { BREVO_API_KEY: apiKey } };

  // 9. Send. On success, advance both the message and the job. On failure,
  // record the error on the job and re-throw so the queue consumer can
  // apply its retry policy.
  try {
    const result = await adapter.send(ctx, sendMsg);

    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await db.prepare(
      'UPDATE messages SET status = ?, sent_at = ?, updated_at = ? WHERE id = ?',
    ).bind('sent', now, now, job.message_id).run();

    await updateJobStatus(db, jobId, 'sent', { providerMessageId: result.providerMessageId });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    // Narrow without `any`: the only code we trust here is a DomainError's
    // stable `code` field. Anything else becomes 'SEND_FAILED'.
    const code = error instanceof Error && 'code' in error
      ? String((error as Record<string, unknown>).code)
      : 'SEND_FAILED';
    await updateJobStatus(db, jobId, 'failed', { errorCode: code, errorMessage: message });
    throw error;
  }
}
