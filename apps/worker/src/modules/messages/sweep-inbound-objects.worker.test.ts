import { beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate } from '@unimailbox/test-kit';
import {
  INBOUND_OBJECT_GRACE_MS,
  sweepOrphanedInboundObjects,
  type InboundObjectStore,
  type InboundSweepCursorStore,
} from './sweep-inbound-objects';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const OLD = new Date(NOW.getTime() - INBOUND_OBJECT_GRACE_MS - 1_000);
const RECENT = new Date(NOW.getTime() - INBOUND_OBJECT_GRACE_MS + 1_000);

function fakeStores(objects: { key: string; uploaded: Date }[]) {
  const values = new Map(objects.map((object) => [object.key, object]));
  const cursors = new Map<string, string>();
  const failures = new Set<string>();
  const objectStore: InboundObjectStore = {
    async list({ prefix, limit, startAfter }) {
      const matching = [...values.values()]
        .filter(
          (object) => object.key.startsWith(prefix) && (!startAfter || object.key > startAfter),
        )
        .sort((a, b) => a.key.localeCompare(b.key));
      return { objects: matching.slice(0, limit), truncated: matching.length > limit };
    },
    async delete(key) {
      if (failures.has(key)) throw new Error('simulated R2 failure');
      values.delete(key);
    },
  };
  const cursorStore: InboundSweepCursorStore = {
    async get(key) {
      return cursors.get(key) ?? null;
    },
    async put(key, value) {
      cursors.set(key, value);
    },
    async delete(key) {
      cursors.delete(key);
    },
  };
  return { values, cursors, failures, objectStore, cursorStore };
}

async function seedReferencedObjects(rawKey: string, attachmentKey: string): Promise<void> {
  const messageId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages
         (id, from_address, subject, status, raw_object_key, created_at, updated_at)
       VALUES (?, 'sender@example.com', 'stored', 'delivered', ?, '2026-10-01', '2026-10-01')`,
    ).bind(messageId, rawKey),
    env.DB.prepare(
      `INSERT INTO inbound_message_attachments
         (id, message_id, object_key, filename, content_type, size_bytes,
          disposition, content_id, created_at)
       VALUES (?, ?, ?, 'logo.png', 'image/png', 4, 'inline', 'logo', '2026-10-01')`,
    ).bind(crypto.randomUUID(), messageId, attachmentKey),
  ]);
}

describe('inbound R2 orphan sweep', () => {
  beforeEach(async () => {
    await resetAndMigrate();
  });

  it('removes only aged, unreferenced raw MIME and attachment objects', async () => {
    const rawKey = `raw-mime/${crypto.randomUUID()}`;
    const attachmentKey = `inbound-attachment/${crypto.randomUUID()}/${crypto.randomUUID()}`;
    await seedReferencedObjects(rawKey, attachmentKey);
    const oldRawOrphan = `raw-mime/${crypto.randomUUID()}`;
    const oldAttachmentOrphan = `inbound-attachment/${crypto.randomUUID()}/${crypto.randomUUID()}`;
    const recentOrphan = `raw-mime/${crypto.randomUUID()}`;
    const stores = fakeStores([
      { key: rawKey, uploaded: OLD },
      { key: attachmentKey, uploaded: OLD },
      { key: oldRawOrphan, uploaded: OLD },
      { key: oldAttachmentOrphan, uploaded: OLD },
      { key: recentOrphan, uploaded: RECENT },
      { key: 'outbound/untouched', uploaded: OLD },
    ]);

    const result = await sweepOrphanedInboundObjects(
      { db: env.DB, objectStore: stores.objectStore, cursorStore: stores.cursorStore },
      NOW,
    );

    expect(result).toEqual({ scanned: 5, deleted: 2, failed: 0 });
    expect(stores.values.has(rawKey)).toBe(true);
    expect(stores.values.has(attachmentKey)).toBe(true);
    expect(stores.values.has(recentOrphan)).toBe(true);
    expect(stores.values.has('outbound/untouched')).toBe(true);
    expect(stores.values.has(oldRawOrphan)).toBe(false);
    expect(stores.values.has(oldAttachmentOrphan)).toBe(false);
  });

  it('walks bounded pages and retries a transient R2 deletion failure on the next cycle', async () => {
    const objects = Array.from({ length: 101 }, (_, index) => ({
      key: `raw-mime/orphan-${String(index).padStart(3, '0')}`,
      uploaded: OLD,
    }));
    const stores = fakeStores(objects);
    const failedKey = objects[0]?.key ?? '';
    stores.failures.add(failedKey);
    const dependencies = {
      db: env.DB,
      objectStore: stores.objectStore,
      cursorStore: stores.cursorStore,
    };

    expect(await sweepOrphanedInboundObjects(dependencies, NOW)).toEqual({
      scanned: 100,
      deleted: 99,
      failed: 1,
    });
    expect(stores.cursors.get('maintenance:inbound-r2-sweep:raw-mime/')).toBe(
      'raw-mime/orphan-099',
    );
    expect(await sweepOrphanedInboundObjects(dependencies, NOW)).toEqual({
      scanned: 1,
      deleted: 1,
      failed: 0,
    });
    expect(stores.cursors.has('maintenance:inbound-r2-sweep:raw-mime/')).toBe(false);
    stores.failures.delete(failedKey);
    expect(await sweepOrphanedInboundObjects(dependencies, NOW)).toEqual({
      scanned: 1,
      deleted: 1,
      failed: 0,
    });
    expect(stores.values.size).toBe(0);
  });

  it('stops before deletion when the D1 reference lookup fails', async () => {
    const key = `raw-mime/${crypto.randomUUID()}`;
    const stores = fakeStores([{ key, uploaded: OLD }]);
    const unavailableDb = {
      prepare() {
        throw new Error('simulated D1 outage');
      },
    } as unknown as D1Database;

    await expect(
      sweepOrphanedInboundObjects(
        { db: unavailableDb, objectStore: stores.objectStore, cursorStore: stores.cursorStore },
        NOW,
      ),
    ).rejects.toThrow('simulated D1 outage');
    expect(stores.values.has(key)).toBe(true);
  });
});
