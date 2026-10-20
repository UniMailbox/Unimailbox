import { migrationsDb } from './migrationsDb';
import { seedInboundMailbox } from './inbound';
import { seedOutboundSubmission } from './outbound';

/** Synthetic owner, foreign actor and domain-bound provider for mutation use cases. */
export async function seedMailMutationContext() {
  const db = await migrationsDb();
  const mailbox = await seedInboundMailbox();
  const outbound = await seedOutboundSubmission({
    ciphertext: new Uint8Array(16),
    iv: new Uint8Array(12),
    authTag: new Uint8Array(16),
  });
  const foreignId = '10000000-0000-4000-8000-000000000002';
  await db.batch([
    db
      .prepare(
        `INSERT INTO users(id,email,status,password_algorithm,password_iterations,password_salt,password_hash)
      VALUES (?,'foreign@example.test','active','pbkdf2-sha256',100000,x'00',x'11')`,
      )
      .bind(foreignId),
    db
      .prepare('UPDATE managed_domains SET outbound_connection_id = ? WHERE id = ?')
      .bind(outbound.connectionId, mailbox.domainId),
  ]);
  return { ...mailbox, ...outbound, foreignId };
}
