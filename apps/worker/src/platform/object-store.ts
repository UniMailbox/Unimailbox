// platform/object-store — CAP-001 stub.
// R2 wrapper. Real attachment upload/download lands with the attachments module.
import type { Env } from './env';

export type ObjectStore = R2Bucket;

export function getObjectStore(env: Env): ObjectStore {
  return env.ATTACHMENTS;
}
