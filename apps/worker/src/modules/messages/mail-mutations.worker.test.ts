import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate, seedMailMutationContext } from '@unimailbox/test-kit';
import { buildAppContext } from '../../app-context';
import {
  createDraft,
  readDraft,
  updateDraft,
  markRead,
  toggleStar,
  softDeleteMessage,
} from './index';
import { sendDraft, submitMessage } from '../outbound-mail';
import type { MutationInput, OperationResult } from '../../platform/operation';
import { getAttachmentByteStore, getAttachmentObjectStore } from '../../platform/cache';

let fixture: Awaited<ReturnType<typeof seedMailMutationContext>>;
const now = new Date('2030-01-01T00:00:00.000Z');
const draftBody = JSON.stringify({
  subject: 'Synthetic draft',
  body_text: 'Fixture',
  to: ['recipient@example.test'],
});
const composeBody = JSON.stringify({
  subject: 'Synthetic send',
  textBody: 'Fixture',
  htmlBody: '',
  to: [{ address: 'recipient@example.test' }],
});
const deps = () => ({
  ...buildAppContext(env),
  clock: { now: () => now, unixMs: () => now.getTime() },
});
function input(rawBody = draftBody, idempotencyKey = crypto.randomUUID()): MutationInput {
  return { actorUserId: fixture.ownerId, rawBody, idempotencyKey, requestId: 'synthetic-request' };
}
const data = (result: OperationResult) =>
  JSON.parse(result.responseJson).data as {
    messageId: string;
    updated_at: string;
    subject: string;
    to: string[];
  };
const draft = () => createDraft(deps(), { ...input(), mailboxId: fixture.mailboxId });
async function counts() {
  return env.DB.prepare(
    `SELECT (SELECT count(*) FROM messages) AS messages,
    (SELECT count(*) FROM message_recipients) AS recipients,
    (SELECT count(*) FROM idempotency_records) AS idempotency,
    (SELECT count(*) FROM audit_events) AS audit,
    (SELECT count(*) FROM outbound_jobs) AS jobs`,
  ).first();
}
beforeEach(async () => {
  await resetAndMigrate();
  fixture = await seedMailMutationContext();
});

describe('CAP-070 transport-independent mail mutations', () => {
  it('R-API-004: direct draft calls replay serialized results and reject changed bytes', async () => {
    const request = { ...input(), mailboxId: fixture.mailboxId };
    const first = await createDraft(deps(), request);
    expect(first.responseStatus).toBe(201);
    const before = await counts();
    expect(await createDraft(deps(), request)).toEqual(first);
    expect(await counts()).toEqual(before);
    await expect(
      createDraft(deps(), { ...request, rawBody: draftBody + ' ' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const read = await readDraft(deps(), {
      actorUserId: fixture.ownerId,
      draftId: data(first).messageId,
      mailboxId: fixture.mailboxId,
    });
    expect(data(read).subject).toBe('Synthetic draft');
  });

  it('R-INPUT-002 R-API-004: malformed JSON leaves the direct-operation key usable', async () => {
    const request = { ...input('{'), mailboxId: fixture.mailboxId };
    const before = await counts();
    await expect(createDraft(deps(), request)).rejects.toMatchObject({ code: 'INVALID_JSON' });
    expect(await counts()).toEqual(before);
    expect((await createDraft(deps(), { ...request, rawBody: draftBody })).responseStatus).toBe(
      201,
    );
  });

  it('R-CONCURRENCY-001 R-API-004: direct parallel saves share one commit; stale saves have no effects', async () => {
    const draftId = data(await draft()).messageId;
    const request = {
      ...input(JSON.stringify({ subject: 'Saved' })),
      draftId,
      ifMatch: now.toISOString(),
    };
    const [first, second] = await Promise.all([
      updateDraft(deps(), request),
      updateDraft(deps(), request),
    ]);
    expect(second).toEqual(first);
    expect(data(first).updated_at).toBe('2030-01-01T00:00:01.000Z');
    const before = await counts();
    await expect(
      updateDraft(deps(), { ...request, idempotencyKey: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'STALE_IF_MATCH' });
    expect(await counts()).toEqual(before);
  });

  it('R-OUTBOUND-006 R-AUDIT-001: a real audit failure rolls back direct save, recipients and replay record', async () => {
    const draftId = data(await draft()).messageId;
    const before = await counts();
    await env.DB.prepare(
      `CREATE TRIGGER abort_fixture_audit BEFORE INSERT ON audit_events
      WHEN NEW.action = 'draft.updated' BEGIN SELECT RAISE(ABORT, 'fixture audit failure'); END;`,
    ).run();
    try {
      await expect(
        updateDraft(deps(), {
          ...input(JSON.stringify({ subject: 'Must roll back', to: [] })),
          draftId,
          ifMatch: now.toISOString(),
        }),
      ).rejects.toThrow('fixture audit failure');
      expect(await counts()).toEqual(before);
      const read = data(
        await readDraft(deps(), {
          actorUserId: fixture.ownerId,
          draftId,
          mailboxId: fixture.mailboxId,
        }),
      );
      expect(read.subject).toBe('Synthetic draft');
      expect(read.to).toEqual(['recipient@example.test']);
    } finally {
      await env.DB.exec('DROP TRIGGER abort_fixture_audit');
    }
  });

  it('R-OUTBOUND-006 R-API-004: Queue failure after draft commit leaves one recoverable job and a replay', async () => {
    const draftId = data(await draft()).messageId;
    const request = { ...input(''), draftId };
    const send = vi.fn().mockRejectedValue(new Error('fixture Queue unavailable'));
    await expect(sendDraft({ ...deps(), outbound: { send } }, request)).rejects.toThrow(
      'fixture Queue unavailable',
    );
    const before = await counts();
    const replay = await sendDraft({ ...deps(), outbound: { send } }, request);
    expect(replay.responseStatus).toBe(202);
    expect(await counts()).toEqual(before);
    expect(send).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare('SELECT status FROM outbound_jobs WHERE message_id = ?')
        .bind(draftId)
        .first(),
    ).toEqual({ status: 'queued' });
    await env.DB.prepare('UPDATE mailboxes SET owner_user_id = ? WHERE id = ?')
      .bind(fixture.foreignId, fixture.mailboxId)
      .run();
    await expect(sendDraft({ ...deps(), outbound: { send } }, request)).rejects.toMatchObject({
      code: 'MESSAGE_NOT_FOUND',
    });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('R-API-004 R-OUTBOUND-006: direct compose submission replays one outbox job', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const dependencies = {
      ...deps(),
      outbound: { send },
      attachmentByteStore: getAttachmentByteStore(env),
      attachmentObjectStore: getAttachmentObjectStore(env),
    };
    const request = {
      ...input(composeBody),
      mailboxId: fixture.mailboxId,
      origin: 'https://example.test',
    };
    const first = await submitMessage(dependencies, request);
    expect(first.responseStatus).toBe(202);
    const before = await counts();
    expect(await submitMessage(dependencies, request)).toEqual(first);
    expect(await counts()).toEqual(before);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('R-MESSAGE-005 R-API-004: direct read/star/delete preserve caller state and replay outcomes', async () => {
    const messageId = data(await draft()).messageId;
    const request = { ...input(''), mailboxId: fixture.mailboxId, messageId };
    expect((await markRead(deps(), request)).responseStatus).toBe(200);
    const starInput = { ...request, idempotencyKey: crypto.randomUUID() };
    const starred = await toggleStar(deps(), starInput);
    expect(await toggleStar(deps(), starInput)).toEqual(starred);
    const deleted = await softDeleteMessage(deps(), request);
    expect(deleted.responseStatus).toBe(204);
    expect(deleted.responseJson).toBe('');
    const deletedReplay = await softDeleteMessage(deps(), request);
    expect(deletedReplay.responseStatus).toBe(deleted.responseStatus);
    expect(deletedReplay.responseJson).toBe(deleted.responseJson);
    expect(
      await env.DB.prepare(
        'SELECT is_read,is_starred,is_deleted FROM message_user_state WHERE user_id=?',
      )
        .bind(fixture.ownerId)
        .first(),
    ).toEqual({ is_read: 1, is_starred: 1, is_deleted: 1 });
  });

  it.each([
    'create',
    'read',
    'save',
    'sendDraft',
    'compose',
    'markRead',
    'star',
    'delete',
  ] as const)(
    'R-AUTHZ-004: direct %s rejects a foreign actor before writes or queue dispatch',
    async (operation) => {
      const draftId = data(await draft()).messageId;
      const send = vi.fn().mockResolvedValue(undefined);
      const dependencies = {
        ...deps(),
        outbound: { send },
        attachmentByteStore: getAttachmentByteStore(env),
        attachmentObjectStore: getAttachmentObjectStore(env),
      };
      const request = {
        ...input(),
        actorUserId: fixture.foreignId,
        mailboxId: fixture.mailboxId,
        draftId,
        messageId: draftId,
        origin: 'https://example.test',
        ifMatch: now.toISOString(),
      };
      const before = await counts();
      const call = {
        create: () => createDraft(dependencies, request),
        read: () => readDraft(dependencies, request),
        save: () => updateDraft(dependencies, request),
        sendDraft: () => sendDraft(dependencies, { ...request, rawBody: '' }),
        compose: () => submitMessage(dependencies, { ...request, rawBody: composeBody }),
        markRead: () => markRead(dependencies, request),
        star: () => toggleStar(dependencies, request),
        delete: () => softDeleteMessage(dependencies, request),
      }[operation];
      await expect(call()).rejects.toMatchObject({
        code: ['read', 'save', 'sendDraft'].includes(operation)
          ? 'MESSAGE_NOT_FOUND'
          : 'MAILBOX_ACCESS_DENIED',
      });
      expect(await counts()).toEqual(before);
      expect(send).not.toHaveBeenCalled();
    },
  );
});
