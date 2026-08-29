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
  put(key: string, bytes: ArrayBuffer, options: AttachmentByteStorePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export function getAttachmentByteStore(env: Env): AttachmentByteStore {
  return {
    put: (key, bytes, options) => env.CACHE.put(key, bytes, options),
    delete: (key) => env.CACHE.delete(key),
  };
}
