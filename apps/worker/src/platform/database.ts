// platform/database — CAP-001 stub.
// R-DATA-004: PRAGMA foreign_keys = ON. Real D1 wiring lands with CAP-004.
import type { Env } from './env';

export type Database = D1Database;

export function getDatabase(env: Env): Database {
  return env.DB;
}
