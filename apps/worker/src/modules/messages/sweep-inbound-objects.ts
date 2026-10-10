import type { Database } from '../../platform/database';
import { findReferencedInboundObjectKeys } from './inbound-object-repository';

// Legacy compose copies KV uploads into R2 before its D1 consume transaction.
// A late write can land after expiry was checkpointed; the daily scan catches it.
const PREFIXES = ['raw-mime/', 'inbound-attachment/', 'attachment:'] as const;
const PAGE_SIZE = 100;
export const INBOUND_OBJECT_GRACE_MS = 24 * 60 * 60 * 1000;

interface ListedObject {
  readonly key: string;
  readonly uploaded: Date;
}

export interface InboundObjectStore {
  list(options: {
    readonly prefix: string;
    readonly limit: number;
    readonly startAfter?: string;
  }): Promise<{ readonly objects: ReadonlyArray<ListedObject>; readonly truncated: boolean }>;
  delete(key: string): Promise<void>;
}

export interface InboundSweepCursorStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface SweepInboundObjectsResult {
  readonly scanned: number;
  readonly deleted: number;
  readonly failed: number;
}

/**
 * Reclaims R2 objects left by an interrupted Email Routing write or failed
 * best-effort rollback. Each cron tick scans one bounded page per prefix.
 * A 24-hour grace period exceeds a Worker invocation's lifetime, so an
 * in-flight D1 batch cannot have its bytes removed. D1 lookup failures stop
 * deletion; KV cursor failures merely cause a repeat-safe page rescan.
 */
export async function sweepOrphanedInboundObjects(
  dependencies: {
    readonly db: Database;
    readonly objectStore: InboundObjectStore;
    readonly cursorStore: InboundSweepCursorStore;
  },
  now = new Date(),
): Promise<SweepInboundObjectsResult> {
  let scanned = 0;
  let deleted = 0;
  let failed = 0;
  const cutoff = now.getTime() - INBOUND_OBJECT_GRACE_MS;

  for (const prefix of PREFIXES) {
    const cursorKey = `maintenance:inbound-r2-sweep:${prefix}`;
    const savedCursor = await dependencies.cursorStore.get(cursorKey);
    const startAfter = savedCursor?.startsWith(prefix) ? savedCursor : null;
    const page = await dependencies.objectStore.list({
      prefix,
      limit: PAGE_SIZE,
      ...(startAfter ? { startAfter } : {}),
    });
    if (page.objects.length === 0) {
      if (savedCursor !== null) await dependencies.cursorStore.delete(cursorKey);
      continue;
    }

    scanned += page.objects.length;
    const oldObjects = page.objects.filter(
      (object) => object.key.startsWith(prefix) && object.uploaded.getTime() < cutoff,
    );
    const referenced = await findReferencedInboundObjectKeys(
      dependencies.db,
      prefix,
      oldObjects.map((object) => object.key),
    );
    for (const object of oldObjects) {
      if (referenced.has(object.key)) continue;
      try {
        await dependencies.objectStore.delete(object.key);
        deleted += 1;
      } catch {
        // Continue the scan; the next full cycle retries this object.
        failed += 1;
      }
    }

    if (page.truncated) {
      const lastKey = page.objects.at(-1)?.key;
      if (lastKey) await dependencies.cursorStore.put(cursorKey, lastKey);
    } else if (savedCursor !== null) {
      await dependencies.cursorStore.delete(cursorKey);
    }
  }

  return { scanned, deleted, failed };
}
