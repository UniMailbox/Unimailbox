// platform/cache — CAP-001 stub.
// KV wrapper. Real get/set/invalidate lands with the modules that own the keys.
import type { Env } from './env';

export type Cache = KVNamespace;

export function getCache(env: Env): Cache {
  return env.CACHE;
}

export type SetupSessionStore = KVNamespace;

export function getSetupSessionStore(env: Env): SetupSessionStore {
  return env.SETUP_SESSION;
}

export interface AttachmentByteStorePutOptions {
  readonly expirationTtl: number;
}

/** Narrow CACHE seam for attachment bytes; modules never receive KVNamespace. */
export interface AttachmentByteStore {
  /**
   * Fetch the raw bytes for a CAP-049 staged upload.
   *
   * Returns `null` when the key is absent, has been garbage-collected, or
   * has expired; callers MUST treat both "metadata says the upload is
   * live" and "bytes say `null`" as a single unavailable-upload failure
   * (CAP-050 R-ATTACHMENT-005) and never surface the distinction to a
   * remote client.
   */
  get(key: string): Promise<ArrayBuffer | null>;
  put(key: string, bytes: ArrayBuffer, options: AttachmentByteStorePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Persistent object-store seam for attachments associated with messages. */
export interface AttachmentObjectStore {
  get(key: string): Promise<ArrayBuffer | null>;
  put(key: string, bytes: ArrayBuffer): Promise<void>;
  delete(key: string): Promise<void>;
}

export function getAttachmentByteStore(env: Env): AttachmentByteStore {
  return {
    // KVNamespace.get returns `string | ArrayBuffer | null`. The CAP-049
    // upload path only ever writes binary bytes, so we request them as an
    // ArrayBuffer explicitly — without the second arg the runtime returns
    // a UTF-8-decoded string, which has no `.byteLength` and would silently
    // pass our length check with a wrong value.
    //
    // A `string` here would mean another tenant of the CACHE namespace
    // wrote a text value under our `attachment:` prefix — treat that the
    // same as a miss rather than letting JSON leak out as raw bytes
    // downstream.
    get: async (key) => {
      const value = await env.CACHE.get(key, 'arrayBuffer');
      return value ?? null;
    },
    put: (key, bytes, options) => env.CACHE.put(key, bytes, options),
    delete: (key) => env.CACHE.delete(key),
  };
}

/**
 * R2-backed attachment bytes. R2 has no TTL; lifecycle and authorization stay
 * in D1, while scheduled expiry/deletion explicitly removes unreferenced
 * objects. This store is deliberately separate from the KV staging seam so
 * an upload can remain retryable until its D1 consume transaction commits.
 */
export function getAttachmentObjectStore(env: Env): AttachmentObjectStore {
  return {
    get: async (key) => {
      const object = await env.ATTACHMENTS.get(key);
      return object ? object.arrayBuffer() : null;
    },
    put: async (key, bytes) => {
      await env.ATTACHMENTS.put(key, bytes);
    },
    delete: (key) => env.ATTACHMENTS.delete(key).then(() => undefined),
  };
}
