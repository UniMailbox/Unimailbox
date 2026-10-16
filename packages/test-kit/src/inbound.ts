import { migrationsDb } from './migrationsDb';

/** A small, independent mailbox fixture for inbound/storage/recovery tests. */
export async function seedInboundMailbox() {
  const db = await migrationsDb();
  const ownerId = '10000000-0000-4000-8000-000000000001';
  const domainId = '20000000-0000-4000-8000-000000000001';
  const mailboxId = '30000000-0000-4000-8000-000000000001';
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id,email,status,password_algorithm,password_iterations,
      password_salt,password_hash) VALUES (?, 'owner@example.test', 'active', 'pbkdf2-sha256',
      100000,x'00',x'11')`,
      )
      .bind(ownerId),
    db
      .prepare("INSERT INTO managed_domains(id,name,status) VALUES (?, 'example.test', 'active')")
      .bind(domainId),
    db
      .prepare(
        `INSERT INTO mailboxes(id,domain_id,owner_user_id,local_part,status)
      VALUES (?,?,?,'inbox','active')`,
      )
      .bind(mailboxId, domainId, ownerId),
  ]);
  return { ownerId, domainId, mailboxId };
}

export const INBOUND_RAW_FIXTURE = [
  'From: sender@example.net',
  'To: inbox@example.test',
  'Subject: Recovery fixture',
  'Message-ID: <fixture@example.net>',
  'Content-Type: multipart/mixed; boundary="fixture"',
  '',
  '--fixture',
  'Content-Type: text/plain',
  '',
  'Fixture body',
  '--fixture',
  'Content-Type: application/octet-stream',
  'Content-Disposition: attachment; filename="fixture.bin"',
  'Content-Transfer-Encoding: base64',
  '',
  'AAEC/w==',
  '--fixture--',
  '',
].join('\r\n');
