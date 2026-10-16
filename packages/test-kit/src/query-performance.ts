import { migrationsDb, type MigrationsDbOptions } from './migrationsDb';
import { seedInboundMailbox } from './inbound';

/** Synthetic mailbox with sparse threads; no real mail or credentials. */
export async function seedQueryPerformanceFixture(
  size = 1000,
  otherMailboxSize = 0,
  options: MigrationsDbOptions = {},
) {
  const db = await migrationsDb(options);
  const f = await seedInboundMailbox(options);
  const messageId = (i: number) => `40000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  const viewId = (i: number) => `41000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
  await db
    .prepare(
      `INSERT INTO sessions(id,user_id,refresh_token_hash,expires_at) VALUES ('query-fixture-session',?,'synthetic-query-refresh',2000000000)`,
    )
    .bind(f.ownerId)
    .run();
  for (let start = 0; start < size; start += 50) {
    const statements = [];
    for (let i = start; i < Math.min(start + 50, size); i++) {
      statements.push(
        db
          .prepare(
            `INSERT INTO messages(id,from_address,subject,text_body,message_id_header,references_header,status,created_at)
        VALUES (?,'sender@example.test','Synthetic query fixture','Synthetic body',?,?,'delivered','2026-01-01 00:00:00')`,
          )
          .bind(
            messageId(i),
            `<fixture-${i}@example.test>`,
            i % 100 === 0 ? '<query-thread@example.test>' : '',
          ),
      );
      statements.push(
        db
          .prepare(
            `INSERT INTO mailbox_messages(id,mailbox_id,message_id,folder) VALUES (?,?,?,'inbox')`,
          )
          .bind(viewId(i), f.mailboxId, messageId(i)),
      );
    }
    await db.batch(statements);
  }
  if (otherMailboxSize) {
    const otherId = '30000000-0000-4000-8000-000000000002';
    await db
      .prepare(
        `INSERT INTO mailboxes(id,domain_id,owner_user_id,local_part,status) VALUES (?,?,?,'other','active')`,
      )
      .bind(otherId, f.domainId, f.ownerId)
      .run();
    for (let start = 0; start < otherMailboxSize; start += 50) {
      const statements = [];
      for (let i = start; i < Math.min(start + 50, otherMailboxSize); i++) {
        const id = messageId(size + i);
        statements.push(
          db
            .prepare(
              `INSERT INTO messages(id,from_address,references_header,status,created_at) VALUES (?,'other@example.test','<query-thread@example.test>','delivered','2026-01-02 00:00:00')`,
            )
            .bind(id),
        );
        statements.push(
          db
            .prepare(`INSERT INTO mailbox_messages(id,mailbox_id,message_id) VALUES (?,?,?)`)
            .bind(viewId(size + i), otherId, id),
        );
      }
      await db.batch(statements);
    }
  }
  return {
    ...f,
    anchorId: messageId(0),
    sessionId: 'query-fixture-session',
    root: '<query-thread@example.test>',
  };
}
