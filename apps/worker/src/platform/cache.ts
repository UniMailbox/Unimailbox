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