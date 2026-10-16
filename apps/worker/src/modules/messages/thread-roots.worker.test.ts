import { beforeEach, expect, it, vi } from 'vitest';
import { env, reset } from 'cloudflare:test';
import { resetAndMigrate, migrationsDb, seedQueryPerformanceFixture } from '@unimailbox/test-kit';
import { getMessageThread } from './index';

beforeEach(async () => {
  await resetAndMigrate();
});
it('R-AUTHZ-004 R-MESSAGE-005: mailbox/thread index reads only the target thread despite a common foreign root', async () => {
  const f = await seedQueryPerformanceFixture(1000, 1000);
  const capture = vi.spyOn(env.DB, 'prepare');
  let sql: string | undefined;
  try {
    const thread = await getMessageThread(env.DB, f.mailboxId, f.anchorId, f.ownerId);
    expect(thread?.items).toHaveLength(10);
    expect(thread?.items.every((item) => item.fromAddress === 'sender@example.test')).toBe(true);
    sql = capture.mock.calls.map(([q]) => q).find((q) => q.includes('mm.thread_root = ?'));
  } finally {
    capture.mockRestore();
  }
  if (!sql) throw new Error('Thread query not captured');
  const result = await env.DB.prepare(sql).bind(f.ownerId, f.mailboxId, f.root, 50).all();
  expect(result.meta.rows_read).toBeLessThanOrEqual(40);
  const plan = await env.DB.prepare('EXPLAIN QUERY PLAN ' + sql)
    .bind(f.ownerId, f.mailboxId, f.root, 50)
    .all<{ detail: string }>();
  expect(
    plan.results?.some(
      (row) =>
        row.detail.includes('mailbox_messages_mailbox_thread_idx') &&
        row.detail.includes('mailbox_id=? AND thread_root=?'),
    ),
  ).toBe(true);
});
it('R-MESSAGE-005: 0041 backfills existing associations and updates roots atomically when headers change', async () => {
  await reset();
  const f = await seedQueryPerformanceFixture(2, 0, { through: '0040_mail_analytics_indexes' });
  expect(
    (
      await env.DB.prepare(
        "SELECT name FROM pragma_table_info('mailbox_messages') WHERE name='thread_root'",
      ).all()
    ).results,
  ).toHaveLength(0);
  await migrationsDb();
  expect(
    (
      await env.DB.prepare('SELECT thread_root FROM mailbox_messages WHERE message_id=?')
        .bind(f.anchorId)
        .first<{ thread_root: string }>()
    )?.thread_root,
  ).toBe(f.root);
  await env.DB.prepare(
    "UPDATE messages SET thread_id='explicit',references_header='<ignored@example.test>',in_reply_to_header='<reply@example.test>' WHERE id=?",
  )
    .bind(f.anchorId)
    .run();
  const root = () =>
    env.DB.prepare('SELECT thread_root FROM mailbox_messages WHERE message_id=?')
      .bind(f.anchorId)
      .first<{ thread_root: string | null }>();
  expect((await root())?.thread_root).toBe('explicit');
  await env.DB.prepare(
    "UPDATE messages SET thread_id='',references_header='malformed > before <' WHERE id=?",
  )
    .bind(f.anchorId)
    .run();
  expect((await root())?.thread_root).toBe('<reply@example.test>');
  await env.DB.prepare("UPDATE messages SET in_reply_to_header='',message_id_header='' WHERE id=?")
    .bind(f.anchorId)
    .run();
  expect((await root())?.thread_root).toBeNull();
  expect((await getMessageThread(env.DB, f.mailboxId, f.anchorId, f.ownerId))?.items).toHaveLength(
    1,
  );
});

it('R-MESSAGE-005 R-DATA-004: root triggers follow association rebinding and roll back with message writes', async () => {
  const f = await seedQueryPerformanceFixture(2);
  const second = '40000000-0000-4000-8000-000000000001';
  await expect(
    env.DB.batch([
      env.DB.prepare("UPDATE messages SET thread_id='must-rollback' WHERE id=?").bind(f.anchorId),
      env.DB.prepare("UPDATE messages SET status='not-a-status' WHERE id=?").bind(f.anchorId),
    ]),
  ).rejects.toThrow();
  expect((await getMessageThread(env.DB, f.mailboxId, f.anchorId, f.ownerId))?.rootId).toBe(f.root);
  await env.DB.prepare('DELETE FROM mailbox_messages WHERE message_id=?').bind(second).run();
  await env.DB.prepare('UPDATE mailbox_messages SET message_id=? WHERE message_id=?')
    .bind(second, f.anchorId)
    .run();
  expect(await getMessageThread(env.DB, f.mailboxId, f.anchorId, f.ownerId)).toBeNull();
  expect((await getMessageThread(env.DB, f.mailboxId, second, f.ownerId))?.rootId).toBe(
    '<fixture-1@example.test>',
  );
});
