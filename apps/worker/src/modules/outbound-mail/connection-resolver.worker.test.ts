import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate } from '@unimailbox/test-kit';
import {
  findActiveOutboundConnectionForJob,
  findActiveOutboundConnectionForMailbox,
} from './connection-resolver';

const NOW = '2026-10-04 00:00:00';

async function seedDomain(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO managed_domains (id, name, status, outbound_connection_id, created_at, updated_at)
     VALUES (?, ?, 'active', NULL, ?, ?)`,
  )
    .bind(id, name, NOW, NOW)
    .run();
  return id;
}

async function seedMailbox(domainId: string): Promise<string> {
  const userId = crypto.randomUUID();
  const id = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (id, email, display_name, status, password_algorithm, password_iterations, password_salt, password_hash, created_at, updated_at)
       VALUES (?, ?, '', 'active', 'pbkdf2-sha256', 100000, ?, ?, ?, ?)`,
    ).bind(userId, `${userId}@resolver.test`, new Uint8Array([1]), new Uint8Array([2]), NOW, NOW),
    env.DB.prepare(
      `INSERT INTO mailboxes (id, domain_id, owner_user_id, local_part, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'inbox', '', 'active', ?, ?)`,
    ).bind(id, domainId, userId, NOW, NOW),
  ]);
  return id;
}

async function seedConnection(providerKey: string, status = 'active'): Promise<string> {
  const credentialId = crypto.randomUUID();
  const connectionId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO encrypted_credentials (id, name, version, ciphertext, iv, auth_tag, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      credentialId,
      `${providerKey}-credential`,
      new Uint8Array([1]),
      new Uint8Array(12),
      new Uint8Array(16),
      NOW,
      NOW,
    ),
    env.DB.prepare(
      `INSERT INTO provider_connections (id, provider_key, label, credential_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(connectionId, providerKey, providerKey, credentialId, status, NOW, NOW),
  ]);
  return connectionId;
}

beforeEach(async () => {
  await resetAndMigrate();
});

describe('outbound connection resolver', () => {
  it('uses the mailbox domain binding instead of the first active connection', async () => {
    const domainA = await seedDomain('a.example');
    const domainB = await seedDomain('b.example');
    const mailboxA = await seedMailbox(domainA);
    const mailboxB = await seedMailbox(domainB);
    const connectionA = await seedConnection('brevo');
    const connectionB = await seedConnection('smtp');

    await env.DB.batch([
      env.DB.prepare('UPDATE managed_domains SET outbound_connection_id = ? WHERE id = ?').bind(
        connectionA,
        domainA,
      ),
      env.DB.prepare('UPDATE managed_domains SET outbound_connection_id = ? WHERE id = ?').bind(
        connectionB,
        domainB,
      ),
    ]);

    await expect(findActiveOutboundConnectionForMailbox(env.DB, mailboxA)).resolves.toEqual({
      id: connectionA,
      providerKey: 'brevo',
    });
    await expect(findActiveOutboundConnectionForMailbox(env.DB, mailboxB)).resolves.toEqual({
      id: connectionB,
      providerKey: 'smtp',
    });
  });

  it('returns null when the domain or connection is not active', async () => {
    const domainId = await seedDomain('inactive.example');
    const mailboxId = await seedMailbox(domainId);
    const connectionId = await seedConnection('brevo', 'disabled');
    await env.DB.prepare('UPDATE managed_domains SET outbound_connection_id = ? WHERE id = ?')
      .bind(connectionId, domainId)
      .run();

    await expect(findActiveOutboundConnectionForMailbox(env.DB, mailboxId)).resolves.toBeNull();
    await env.DB.prepare("UPDATE provider_connections SET status = 'active' WHERE id = ?")
      .bind(connectionId)
      .run();
    await env.DB.prepare("UPDATE managed_domains SET status = 'disabled' WHERE id = ?")
      .bind(domainId)
      .run();
    await expect(findActiveOutboundConnectionForMailbox(env.DB, mailboxId)).resolves.toBeNull();
  });

  it('resolves a queued job to its provider key for registry dispatch', async () => {
    const domainId = await seedDomain('job.example');
    const connectionId = await seedConnection('brevo');
    await env.DB.prepare('UPDATE managed_domains SET outbound_connection_id = ? WHERE id = ?')
      .bind(connectionId, domainId)
      .run();
    const messageId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (id, from_address, subject, status, created_at, updated_at)
         VALUES (?, 'from@job.example', 'subject', 'queued', ?, ?)`,
      ).bind(messageId, NOW, NOW),
      env.DB.prepare(
        `INSERT INTO outbound_jobs (id, message_id, provider_connection_id, status, attempts, max_attempts, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', 0, 3, ?, ?)`,
      ).bind(jobId, messageId, connectionId, NOW, NOW),
    ]);

    await expect(findActiveOutboundConnectionForJob(env.DB, jobId)).resolves.toMatchObject({
      id: connectionId,
      providerKey: 'brevo',
    });
  });
});
