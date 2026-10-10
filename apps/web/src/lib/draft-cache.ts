// apps/web — browser-local draft working copies.
//
// CAP-061 deliberately keeps this store independent from auth, routing, and
// server state. Only draft content and a non-secret identity are persisted;
// session tokens, credentials, and storage handles never enter a record.
import Dexie, { type Table } from 'dexie';
import { z } from 'zod';

export const DRAFT_CACHE_DATABASE_NAME = 'unimailbox-draft-cache';

const cacheIdentityPartSchema = z.string().min(1).max(512);
const draftRecipientsSchema = z.array(z.string()).max(50);
const revisionSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const draftWorkingCopyInputSchema = z
  .object({
    userId: cacheIdentityPartSchema,
    mailboxId: cacheIdentityPartSchema,
    draftId: cacheIdentityPartSchema,
    to: draftRecipientsSchema,
    cc: draftRecipientsSchema,
    bcc: draftRecipientsSchema,
    subject: z.string(),
    textBody: z.string(),
    htmlBody: z.string(),
  })
  .strict();

export type DraftWorkingCopyInput = z.infer<typeof draftWorkingCopyInputSchema>;

export const draftWorkingCopySchema = draftWorkingCopyInputSchema
  .extend({
    key: z.string().min(1),
    revision: revisionSchema,
    dirty: z.boolean(),
    baseServerUpdatedAt: z.string().min(1).nullable(),
    baseServerRevision: revisionSchema.nullable(),
  })
  .strict();

export type DraftWorkingCopy = z.infer<typeof draftWorkingCopySchema>;

const serverUpdatedAtSchema = z.string().min(1);

export type DraftRecoveryDecision = 'unchanged' | 'local-ahead' | 'server-changed';

export class DraftCacheValidationError extends Error {
  constructor() {
    super('Draft cache record failed validation');
    this.name = 'DraftCacheValidationError';
  }
}

export class DraftNotFoundError extends Error {
  constructor() {
    super('Draft working copy not found');
    this.name = 'DraftNotFoundError';
  }
}

export class DraftCacheStaleSyncError extends Error {
  constructor() {
    super('Draft sync response is older than the current working copy');
    this.name = 'DraftCacheStaleSyncError';
  }
}

/**
 * Length-framing makes the three identity components unambiguous even when
 * they contain delimiter-like characters. The frame is deterministic and
 * contains no credential or browser-storage material.
 */
export function buildDraftCacheKey(userId: string, mailboxId: string, draftId: string): string {
  const frame = (value: string): string => {
    const validated = cacheIdentityPartSchema.parse(value);
    return `${validated.length}:${validated}`;
  };
  return `draft-v1:${frame(userId)}${frame(mailboxId)}${frame(draftId)}`;
}

function validateInput(input: DraftWorkingCopyInput): DraftWorkingCopyInput {
  return draftWorkingCopyInputSchema.parse(input);
}

function validatePersisted(
  value: unknown,
  userId: string,
  mailboxId: string,
  draftId: string,
): DraftWorkingCopy {
  const parsed = draftWorkingCopySchema.safeParse(value);
  if (!parsed.success) {
    throw new DraftCacheValidationError();
  }
  const expectedKey = buildDraftCacheKey(userId, mailboxId, draftId);
  if (
    parsed.data.key !== expectedKey ||
    parsed.data.userId !== userId ||
    parsed.data.mailboxId !== mailboxId ||
    parsed.data.draftId !== draftId
  ) {
    throw new DraftCacheValidationError();
  }
  return parsed.data;
}

function contentEquals(a: DraftWorkingCopy, b: DraftWorkingCopyInput): boolean {
  return (
    a.userId === b.userId &&
    a.mailboxId === b.mailboxId &&
    a.draftId === b.draftId &&
    a.subject === b.subject &&
    a.textBody === b.textBody &&
    a.htmlBody === b.htmlBody &&
    a.to.length === b.to.length &&
    a.to.every((value, index) => value === b.to[index]) &&
    a.cc.length === b.cc.length &&
    a.cc.every((value, index) => value === b.cc[index]) &&
    a.bcc.length === b.bcc.length &&
    a.bcc.every((value, index) => value === b.bcc[index])
  );
}

interface DraftCacheTable extends DraftWorkingCopy {
  readonly key: string;
}

class DraftCacheDatabase extends Dexie {
  drafts!: Table<DraftCacheTable, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      drafts: '&key, [userId+mailboxId], userId, mailboxId',
    });
    this.version(2)
      .stores({
        drafts: '&key, [userId+mailboxId], userId, mailboxId',
      })
      .upgrade((transaction) =>
        transaction
          .table('drafts')
          .toCollection()
          .modify((row: DraftCacheTable) => {
            row.baseServerRevision ??= null;
          }),
      );
  }
}

export interface DraftCacheStore {
  save(input: DraftWorkingCopyInput): Promise<DraftWorkingCopy>;
  get(userId: string, mailboxId: string, draftId: string): Promise<DraftWorkingCopy | null>;
  list(userId: string, mailboxId: string): Promise<ReadonlyArray<DraftWorkingCopy>>;
  /**
   * Apply a server response only in relation to the local revision that
   * produced it. Older responses never clear a newer dirty copy.
   */
  markSynced(
    userId: string,
    mailboxId: string,
    draftId: string,
    serverUpdatedAt: string,
    expectedRevision: number,
  ): Promise<DraftWorkingCopy>;
  remove(userId: string, mailboxId: string, draftId: string): Promise<void>;
}

/**
 * Create a store over a named IndexedDB database. A new wrapper over the same
 * name reads the same persisted rows, which is the browser-restart boundary
 * this cache is intended to cover. The Dexie handle remains private.
 */
export function createDraftCacheStore(
  databaseName: string = DRAFT_CACHE_DATABASE_NAME,
): DraftCacheStore {
  const database = new DraftCacheDatabase(databaseName);

  return {
    async save(input): Promise<DraftWorkingCopy> {
      const parsedInput = validateInput(input);
      const key = buildDraftCacheKey(
        parsedInput.userId,
        parsedInput.mailboxId,
        parsedInput.draftId,
      );
      let saved: DraftWorkingCopy | undefined;

      await database.transaction('rw', database.drafts, async () => {
        const rawExisting = await database.drafts.get(key);
        const existing =
          rawExisting === undefined
            ? null
            : validatePersisted(
                rawExisting,
                parsedInput.userId,
                parsedInput.mailboxId,
                parsedInput.draftId,
              );
        const sameContent = existing !== null && contentEquals(existing, parsedInput);
        if (existing !== null && !sameContent && existing.revision >= Number.MAX_SAFE_INTEGER) {
          throw new DraftCacheValidationError();
        }
        saved = {
          ...parsedInput,
          key,
          revision: existing === null ? 1 : existing.revision + (sameContent ? 0 : 1),
          dirty: existing === null ? true : sameContent ? existing.dirty : true,
          baseServerUpdatedAt: existing?.baseServerUpdatedAt ?? null,
          baseServerRevision: existing?.baseServerRevision ?? null,
        };
        await database.drafts.put(saved);
      });

      if (saved === undefined) {
        throw new DraftCacheValidationError();
      }
      return saved;
    },

    async get(userId, mailboxId, draftId): Promise<DraftWorkingCopy | null> {
      const key = buildDraftCacheKey(userId, mailboxId, draftId);
      const raw = await database.drafts.get(key);
      return raw === undefined ? null : validatePersisted(raw, userId, mailboxId, draftId);
    },

    async list(userId, mailboxId): Promise<ReadonlyArray<DraftWorkingCopy>> {
      const parsedUserId = cacheIdentityPartSchema.parse(userId);
      const parsedMailboxId = cacheIdentityPartSchema.parse(mailboxId);
      const rows = await database.drafts
        .where('[userId+mailboxId]')
        .equals([parsedUserId, parsedMailboxId]);
      return (await rows.toArray())
        .map((row) => validatePersisted(row, parsedUserId, parsedMailboxId, row.draftId))
        .sort((a, b) => a.draftId.localeCompare(b.draftId));
    },

    async markSynced(
      userId,
      mailboxId,
      draftId,
      serverUpdatedAt,
      expectedRevision,
    ): Promise<DraftWorkingCopy> {
      const parsedServerUpdatedAt = serverUpdatedAtSchema.parse(serverUpdatedAt);
      const parsedExpectedRevision = revisionSchema.parse(expectedRevision);
      const key = buildDraftCacheKey(userId, mailboxId, draftId);
      let synced: DraftWorkingCopy | undefined;

      await database.transaction('rw', database.drafts, async () => {
        const raw = await database.drafts.get(key);
        if (raw === undefined) {
          throw new DraftNotFoundError();
        }
        const existing = validatePersisted(raw, userId, mailboxId, draftId);
        if (existing.revision < parsedExpectedRevision) {
          throw new DraftCacheStaleSyncError();
        }
        if (
          existing.baseServerRevision !== null &&
          parsedExpectedRevision <= existing.baseServerRevision
        ) {
          // Duplicate or out-of-order responses must not regress the highest
          // server base already applied, whether the current copy is clean
          // or still dirty at a newer local revision.
          synced = existing;
          return;
        }
        synced = {
          ...existing,
          dirty: existing.revision > parsedExpectedRevision,
          baseServerUpdatedAt: parsedServerUpdatedAt,
          baseServerRevision: parsedExpectedRevision,
        };
        await database.drafts.put(synced);
      });

      if (synced === undefined) {
        throw new DraftCacheValidationError();
      }
      return synced;
    },

    async remove(userId, mailboxId, draftId): Promise<void> {
      await database.drafts.delete(buildDraftCacheKey(userId, mailboxId, draftId));
    },
  };
}

/**
 * Recovery compares the server's opaque version to the stored base version,
 * never to local wall-clock time. A dirty copy with the same base is local
 * work; a base mismatch requires an explicit server-conflict decision.
 */
export function decideDraftRecovery(
  copy: Pick<DraftWorkingCopy, 'dirty' | 'baseServerUpdatedAt'>,
  serverUpdatedAt: string | null,
): DraftRecoveryDecision {
  if (copy.baseServerUpdatedAt !== null) {
    serverUpdatedAtSchema.parse(copy.baseServerUpdatedAt);
  }
  if (serverUpdatedAt !== null) {
    serverUpdatedAtSchema.parse(serverUpdatedAt);
  }
  if (copy.baseServerUpdatedAt !== serverUpdatedAt) {
    return 'server-changed';
  }
  return copy.dirty ? 'local-ahead' : 'unchanged';
}

const defaultDraftCache = createDraftCacheStore();

export const saveDraftWorkingCopy = (input: DraftWorkingCopyInput): Promise<DraftWorkingCopy> =>
  defaultDraftCache.save(input);

export const getDraftWorkingCopy = (
  userId: string,
  mailboxId: string,
  draftId: string,
): Promise<DraftWorkingCopy | null> => defaultDraftCache.get(userId, mailboxId, draftId);

export const listDraftWorkingCopies = (
  userId: string,
  mailboxId: string,
): Promise<ReadonlyArray<DraftWorkingCopy>> => defaultDraftCache.list(userId, mailboxId);

export const markDraftWorkingCopySynced = (
  userId: string,
  mailboxId: string,
  draftId: string,
  serverUpdatedAt: string,
  expectedRevision: number,
): Promise<DraftWorkingCopy> =>
  defaultDraftCache.markSynced(userId, mailboxId, draftId, serverUpdatedAt, expectedRevision);

export const removeDraftWorkingCopy = (
  userId: string,
  mailboxId: string,
  draftId: string,
): Promise<void> => defaultDraftCache.remove(userId, mailboxId, draftId);
