import type { Database } from '../../platform/database';
import { systemClock } from '../../platform/clock';
import { sqliteTimestamp } from '../../platform/idempotency';

/** Bounded daily TTL cleanup; active sessions and unexpired replay records remain authoritative. */
export async function expireIdentityRecords(db: Database, now = systemClock.now()): Promise<void> {
  await db.batch([
    db
      .prepare(
        `DELETE FROM idempotency_records WHERE id IN (
          SELECT id FROM idempotency_records WHERE expires_at <= ? ORDER BY expires_at, id LIMIT 1000
        )`,
      )
      .bind(sqliteTimestamp(now)),
    db
      .prepare(
        `DELETE FROM sessions WHERE id IN (
          SELECT id FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL
          ORDER BY expires_at, id LIMIT 1000
        )`,
      )
      .bind(Math.floor(now.getTime() / 1000)),
  ]);
}
