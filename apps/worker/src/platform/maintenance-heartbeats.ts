import type { Env } from './env';
import { logger } from './logger';
import { systemIds } from './ids';

export type MaintenanceCadence = 'frequent' | 'hourly' | 'daily';
export interface MaintenanceHeartbeat {
  cadence: MaintenanceCadence;
  requestId: string;
  startedAt: string;
  completedAt: string;
  failedTasks: readonly string[];
}
export interface HeartbeatRow {
  cadence: MaintenanceCadence;
  completed_at: string | null;
  failed_count: number;
  legacy_imported: number;
  initialized_at: string;
}

/** One transaction keeps status and task names consistent; delayed runs cannot erase newer results. */
export async function writeMaintenanceHeartbeat(
  db: Env['DB'],
  heartbeat: MaintenanceHeartbeat,
  legacyOnly = false,
): Promise<void> {
  const failures = [...new Set(heartbeat.failedTasks)];
  const { cadence, requestId, startedAt, completedAt } = heartbeat;
  await db.batch([
    db
      .prepare(
        `INSERT INTO maintenance_heartbeats
        (cadence, request_id, started_at, completed_at, failed_count, legacy_imported)
        VALUES (?, ?, ?, ?, ?, 1)
        ON CONFLICT(cadence) DO UPDATE SET request_id=excluded.request_id,
          started_at=excluded.started_at, completed_at=excluded.completed_at,
          failed_count=excluded.failed_count, legacy_imported=1
        WHERE (? = 0 OR maintenance_heartbeats.legacy_imported = 0)
          AND (maintenance_heartbeats.started_at IS NULL OR excluded.started_at >= maintenance_heartbeats.started_at)`,
      )
      .bind(cadence, requestId, startedAt, completedAt, failures.length, legacyOnly ? 1 : 0),
    db
      .prepare(
        `DELETE FROM maintenance_heartbeat_failures WHERE cadence = ?
        AND EXISTS (SELECT 1 FROM maintenance_heartbeats WHERE cadence = ? AND request_id = ?)`,
      )
      .bind(cadence, cadence, requestId),
    ...failures.map((task) =>
      db
        .prepare(
          `INSERT OR IGNORE INTO maintenance_heartbeat_failures(cadence, task_name)
        SELECT ?, ? WHERE EXISTS (SELECT 1 FROM maintenance_heartbeats WHERE cadence = ? AND request_id = ?)`,
        )
        .bind(cadence, task, cadence, requestId),
    ),
  ]);
}

const legacyKeys: Record<MaintenanceCadence, string> = {
  frequent: 'ops:cron',
  hourly: 'ops:cron:hourly',
  daily: 'ops:cron:daily',
};

function legacyHeartbeat(value: unknown, cadence: MaintenanceCadence): MaintenanceHeartbeat {
  if (!value || typeof value !== 'object') throw new Error('Invalid legacy heartbeat');
  const old = value as Record<string, unknown>;
  if (
    typeof old.completedAt !== 'string' ||
    !Number.isFinite(Date.parse(old.completedAt)) ||
    !Array.isArray(old.failedTasks) ||
    old.failedTasks.length > 20 ||
    !old.failedTasks.every((task: unknown) => typeof task === 'string' && task.length <= 128)
  )
    throw new Error('Invalid legacy heartbeat');
  const startedAt = typeof old.startedAt === 'string' ? old.startedAt : old.completedAt;
  if (!Number.isFinite(Date.parse(startedAt))) throw new Error('Invalid legacy heartbeat');
  return {
    cadence,
    requestId: systemIds.uuid(),
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(old.completedAt).toISOString(),
    failedTasks: old.failedTasks as string[],
  };
}

/** One-time handover only. The durable flag also records absent keys, so health probes never poll KV. */
export async function readMaintenanceHeartbeats(
  env: Pick<Env, 'DB' | 'CACHE'>,
): Promise<HeartbeatRow[]> {
  const read = async () =>
    (
      await env.DB.prepare(
        'SELECT cadence, completed_at, failed_count, legacy_imported, initialized_at FROM maintenance_heartbeats',
      ).all<HeartbeatRow>()
    ).results;
  const initial = await read();
  for (const row of initial.filter((entry) => entry.legacy_imported === 0)) {
    let heartbeat: MaintenanceHeartbeat | null = null;
    try {
      const old = await env.CACHE.get(legacyKeys[row.cadence], 'json');
      if (old !== null) heartbeat = legacyHeartbeat(old, row.cadence);
    } catch {
      // Preserve an unknown migration state as unhealthy until this cadence really recovers.
      logger.warn({ event: 'cron.legacy_import_failed' }, { cadence: row.cadence });
      const now = new Date().toISOString();
      heartbeat = {
        cadence: row.cadence,
        requestId: systemIds.uuid(),
        startedAt: now,
        completedAt: now,
        failedTasks: ['heartbeat.legacy-import'],
      };
    }
    if (heartbeat) await writeMaintenanceHeartbeat(env.DB, heartbeat, true);
    else
      await env.DB.prepare(
        'UPDATE maintenance_heartbeats SET legacy_imported=1 WHERE cadence=? AND legacy_imported=0',
      )
        .bind(row.cadence)
        .run();
  }
  return initial.some((row) => row.legacy_imported === 0) ? read() : initial;
}
