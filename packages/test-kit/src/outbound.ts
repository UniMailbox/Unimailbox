import { migrationsDb, type MigrationsDbOptions } from './migrationsDb';
import type { SendProviderMessage } from '@unimailbox/contracts';

export function outboundMessageFixture(): SendProviderMessage {
  return {
    idempotencyKey: '50000000-0000-4000-8000-000000000001',
    attemptId: 'a0000000-0000-4000-8000-000000000001',
    from: { address: 'sender@example.test' },
    to: [{ address: 'recipient@example.test' }],
    cc: [],
    bcc: [],
    subject: 'Synthetic message',
    html: '',
    text: 'Synthetic body',
    attachments: [],
  };
}

/** Encrypted provider credentials are supplied by the Worker test boundary. */
export async function seedOutboundSubmission(
  encrypted: {
    ciphertext: Uint8Array;
    iv: Uint8Array;
    authTag: Uint8Array;
  },
  options: MigrationsDbOptions = {},
) {
  const db = await migrationsDb(options);
  const messageId = '50000000-0000-4000-8000-000000000001';
  const jobId = '60000000-0000-4000-8000-000000000001';
  const connectionId = '70000000-0000-4000-8000-000000000001';
  const credentialId = '80000000-0000-4000-8000-000000000001';
  await db.batch([
    db
      .prepare(
        "INSERT INTO messages(id,from_address,subject,text_body,status) VALUES (?,'sender@example.test','Synthetic submission','Synthetic body','queued')",
      )
      .bind(messageId),
    db
      .prepare(
        "INSERT INTO message_recipients(id,message_id,address,type) VALUES ('90000000-0000-4000-8000-000000000001',?,'recipient@example.test','to')",
      )
      .bind(messageId),
    db
      .prepare(
        "INSERT INTO encrypted_credentials(id,name,version,ciphertext,iv,auth_tag) VALUES (?,'synthetic-outbound',1,?,?,?)",
      )
      .bind(credentialId, encrypted.ciphertext, encrypted.iv, encrypted.authTag),
    db
      .prepare(
        "INSERT INTO provider_connections(id,provider_key,label,credential_id,status,webhook_secret) VALUES (?,'brevo','Synthetic provider',?,'active','synthetic-webhook-secret')",
      )
      .bind(connectionId, credentialId),
    db
      .prepare(
        "INSERT INTO outbound_jobs(id,message_id,provider_connection_id,status) VALUES (?,?,?,'queued')",
      )
      .bind(jobId, messageId, connectionId),
  ]);
  return { jobId, messageId, connectionId };
}
