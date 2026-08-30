import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import {
  buildDraftCacheKey,
  createDraftCacheStore,
  decideDraftRecovery,
  DraftCacheValidationError,
  DraftCacheStaleSyncError,
  type DraftWorkingCopyInput,
} from './draft-cache';

let databaseNumber = 0;

function newDatabaseName(): string {
  databaseNumber += 1;
  return `unimailbox-draft-cache-test-${databaseNumber}`;
}

function draft(overrides: Partial<DraftWorkingCopyInput> = {}): DraftWorkingCopyInput {
  return {
    userId: 'user-a',
    mailboxId: 'mailbox-a',
    draftId: 'draft-a',
    to: ['to@example.com'],
    cc: [],
    bcc: [],
    subject: 'Subject',
    textBody: 'Text body',
    htmlBody: '<p>HTML body</p>',
    ...overrides,
  };
}

describe('draft-cache — CAP-061', () => {
  it('R-MESSAGE-010: persists a working copy across a fresh Dexie instance', async () => {
    const databaseName = newDatabaseName();
    const firstStore = createDraftCacheStore(databaseName);
    const saved = await firstStore.save(draft());

    // A fresh wrapper over the same IndexedDB database models a browser
    // restart while keeping the persisted working copy.
    const freshStore = createDraftCacheStore(databaseName);
    await expect(freshStore.get('user-a', 'mailbox-a', 'draft-a')).resolves.toEqual(saved);
  });

  it('R-MESSAGE-010 R-DATA-004: isolates CRUD by user/mailbox and frames delimiter-like IDs', async () => {
    const store = createDraftCacheStore(newDatabaseName());
    await store.save(draft({ draftId: 'draft-a' }));
    await store.save(draft({ userId: 'user-b', draftId: 'draft-b' }));
    await store.save(draft({ mailboxId: 'mailbox-b', draftId: 'draft-c' }));

    await expect(store.list('user-a', 'mailbox-a')).resolves.toEqual([
      expect.objectContaining({ draftId: 'draft-a' }),
    ]);
    await expect(store.list('user-b', 'mailbox-a')).resolves.toEqual([
      expect.objectContaining({ draftId: 'draft-b' }),
    ]);
    await expect(store.list('user-a', 'mailbox-b')).resolves.toEqual([
      expect.objectContaining({ draftId: 'draft-c' }),
    ]);

    const collisionA = draft({ userId: 'a|b', mailboxId: 'c', draftId: 'd' });
    const collisionB = draft({ userId: 'a', mailboxId: 'b', draftId: 'c|d' });
    expect(
      buildDraftCacheKey(collisionA.userId, collisionA.mailboxId, collisionA.draftId),
    ).not.toBe(buildDraftCacheKey(collisionB.userId, collisionB.mailboxId, collisionB.draftId));
    await store.save(collisionA);
    await store.save(collisionB);
    await expect(store.get('a|b', 'c', 'd')).resolves.toMatchObject(collisionA);
    await expect(store.get('a', 'b', 'c|d')).resolves.toMatchObject(collisionB);

    await store.remove('a|b', 'c', 'd');
    await expect(store.get('a|b', 'c', 'd')).resolves.toBeNull();
    await expect(store.get('a', 'b', 'c|d')).resolves.toMatchObject(collisionB);

    await store.save(draft({ draftId: 'shared-draft' }));
    await store.save(draft({ userId: 'user-b', draftId: 'shared-draft' }));
    await store.save(draft({ mailboxId: 'mailbox-b', draftId: 'shared-draft' }));
    await expect(store.list('user-a', 'mailbox-a')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ draftId: 'shared-draft', userId: 'user-a' }),
      ]),
    );
    await expect(store.list('user-b', 'mailbox-a')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ draftId: 'shared-draft', userId: 'user-b' }),
      ]),
    );
    await expect(store.list('user-a', 'mailbox-b')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ draftId: 'shared-draft', mailboxId: 'mailbox-b' }),
      ]),
    );
    await store.remove('user-a', 'mailbox-a', 'shared-draft');
    await expect(store.get('user-b', 'mailbox-a', 'shared-draft')).resolves.not.toBeNull();
    await expect(store.get('user-a', 'mailbox-b', 'shared-draft')).resolves.not.toBeNull();
  });

  it('R-MESSAGE-010: advances revision for changed content and records exact server sync state', async () => {
    const store = createDraftCacheStore(newDatabaseName());
    const first = await store.save(draft());
    expect(first.revision).toBe(1);
    expect(first.dirty).toBe(true);
    expect(first.baseServerUpdatedAt).toBeNull();

    const synced = await store.markSynced(
      'user-a',
      'mailbox-a',
      'draft-a',
      '2099-12-31T23:59:59.999Z',
      1,
    );
    expect(synced.revision).toBe(1);
    expect(synced.dirty).toBe(false);
    expect(synced.baseServerUpdatedAt).toBe('2099-12-31T23:59:59.999Z');

    const changed = await store.save(draft({ subject: 'Changed subject' }));
    expect(changed.revision).toBe(2);
    expect(changed.dirty).toBe(true);
    expect(changed.baseServerUpdatedAt).toBe('2099-12-31T23:59:59.999Z');
    expect(changed.textBody).toBe(first.textBody);
    expect(changed.to).toEqual(first.to);
    expect(changed.bcc).toEqual(first.bcc);

    const unchanged = await store.save(draft({ subject: 'Changed subject' }));
    expect(unchanged.revision).toBe(changed.revision);
    expect(unchanged.dirty).toBe(true);

    const staleResponse = await store.markSynced(
      'user-a',
      'mailbox-a',
      'draft-a',
      '2099-12-31T23:59:59.999Z',
      1,
    );
    expect(staleResponse.revision).toBe(2);
    expect(staleResponse.dirty).toBe(true);
    expect(staleResponse.baseServerUpdatedAt).toBe('2099-12-31T23:59:59.999Z');
    expect(decideDraftRecovery(staleResponse, '2099-12-31T23:59:59.999Z')).toBe('local-ahead');

    const latestResponse = await store.markSynced(
      'user-a',
      'mailbox-a',
      'draft-a',
      '2100-01-01T00:00:00.000Z',
      2,
    );
    expect(latestResponse.dirty).toBe(false);
    expect(latestResponse.baseServerUpdatedAt).toBe('2100-01-01T00:00:00.000Z');

    await store.save(draft({ subject: 'Third subject' }));
    const secondResponse = await store.markSynced(
      'user-a',
      'mailbox-a',
      'draft-a',
      '2100-01-01T00:00:00.000Z',
      2,
    );
    expect(secondResponse.revision).toBe(3);
    expect(secondResponse.dirty).toBe(true);
    const olderResponse = await store.markSynced(
      'user-a',
      'mailbox-a',
      'draft-a',
      '2099-12-31T23:59:59.999Z',
      1,
    );
    expect(olderResponse).toEqual(secondResponse);

    await expect(
      store.markSynced('user-a', 'mailbox-a', 'draft-a', '2101-01-01T00:00:00.000Z', 4),
    ).rejects.toBeInstanceOf(DraftCacheStaleSyncError);
  });

  it('R-MESSAGE-010: decides recovery from base version and dirty state, not wall clocks', () => {
    expect(
      decideDraftRecovery(
        { dirty: false, baseServerUpdatedAt: '2035-01-01T00:00:00.000Z' },
        '2035-01-01T00:00:00.000Z',
      ),
    ).toBe('unchanged');
    expect(
      decideDraftRecovery(
        { dirty: true, baseServerUpdatedAt: '2035-01-01T00:00:00.000Z' },
        '2035-01-01T00:00:00.000Z',
      ),
    ).toBe('local-ahead');
    expect(
      decideDraftRecovery(
        { dirty: false, baseServerUpdatedAt: '2035-01-01T00:00:00.000Z' },
        '1999-01-01T00:00:00.000Z',
      ),
    ).toBe('server-changed');
    // Even when local content is dirty, a changed server base requires an
    // explicit conflict decision; wall-clock ordering is never consulted.
    expect(
      decideDraftRecovery(
        { dirty: true, baseServerUpdatedAt: '2035-01-01T00:00:00.000Z' },
        '1999-01-01T00:00:00.000Z',
      ),
    ).toBe('server-changed');
  });

  it('R-DATA-004 R-SECRET-003: rejects malformed persisted records and secret-shaped fields', async () => {
    const databaseName = newDatabaseName();
    const store = createDraftCacheStore(databaseName);
    const value = draft();
    const key = buildDraftCacheKey(value.userId, value.mailboxId, value.draftId);

    // This is a real IndexedDB write through a separate Dexie instance, not
    // a mock of the cache implementation. The extra credential-shaped field
    // must be rejected at the read boundary and never exposed to callers.
    const rawDatabase = new Dexie(databaseName);
    rawDatabase.version(1).stores({
      drafts: '&key, [userId+mailboxId], userId, mailboxId',
    });
    await rawDatabase.table('drafts').put({
      ...value,
      key,
      revision: 1,
      dirty: true,
      baseServerUpdatedAt: null,
      accessToken: 'credential-shaped-test-value',
    });
    rawDatabase.close();

    await expect(store.get(value.userId, value.mailboxId, value.draftId)).rejects.toBeInstanceOf(
      DraftCacheValidationError,
    );
  });

  it('R-DATA-004: rejects invalid identities, unsafe revisions, and invalid sync versions', async () => {
    const store = createDraftCacheStore(newDatabaseName());
    await expect(store.save(draft({ userId: '' }))).rejects.toThrow();
    await expect(store.get('', 'mailbox-a', 'draft-a')).rejects.toThrow();
    await expect(store.list('user-a', '')).rejects.toThrow();
    await expect(store.markSynced('user-a', 'mailbox-a', 'draft-a', '', 1)).rejects.toThrow();

    const databaseName = newDatabaseName();
    const value = draft();
    const key = buildDraftCacheKey(value.userId, value.mailboxId, value.draftId);
    const rawDatabase = new Dexie(databaseName);
    rawDatabase.version(1).stores({
      drafts: '&key, [userId+mailboxId], userId, mailboxId',
    });
    await rawDatabase.table('drafts').put({
      ...value,
      key,
      revision: Number.MAX_SAFE_INTEGER + 1,
      dirty: true,
      baseServerUpdatedAt: null,
    });
    rawDatabase.close();

    await expect(
      createDraftCacheStore(databaseName).get(value.userId, value.mailboxId, value.draftId),
    ).rejects.toBeInstanceOf(DraftCacheValidationError);
  });

  it('R-DATA-004: rejects a malformed row discovered through list()', async () => {
    const databaseName = newDatabaseName();
    const store = createDraftCacheStore(databaseName);
    const rawDatabase = new Dexie(databaseName);
    rawDatabase.version(1).stores({
      drafts: '&key, [userId+mailboxId], userId, mailboxId',
    });
    await rawDatabase.table('drafts').put({
      ...draft(),
      key: 'corrupt-list-row',
      draftId: '',
      revision: 1,
      dirty: true,
      baseServerUpdatedAt: null,
    });
    rawDatabase.close();

    await expect(store.list('user-a', 'mailbox-a')).rejects.toBeInstanceOf(
      DraftCacheValidationError,
    );
  });
});
