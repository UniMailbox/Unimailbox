import { CURRENT_SCHEMA_VERSION } from '../database/schema-version';
import type { Env } from './env';
import { readSecret } from './secrets';
import { readMaintenanceHeartbeats, type HeartbeatRow } from './maintenance-heartbeats';

const HOURLY_HEARTBEAT_MAX_AGE_MS = 2 * 60 * 60_000;
const DAILY_HEARTBEAT_MAX_AGE_MS = 26 * 60 * 60_000;
function healthyHeartbeat(heartbeat: HeartbeatRow | undefined, maxAge: number): boolean {
  if (!heartbeat?.completed_at || heartbeat.failed_count !== 0) return false;
  const age = Date.now() - Date.parse(heartbeat.completed_at);
  return age >= 0 && age < maxAge;
}
export function releaseIdentity(env: Env) {
  return {
    version: env.VERSION?.id ?? 'local',
    revision: env.RELEASE_SHA ?? 'development',
    tree: env.RELEASE_TREE ?? 'development',
  };
}
export async function readiness(env: Env): Promise<{ ok: boolean; schema: string | undefined }> {
  try {
    const [row, token, encryption, cursor] = await Promise.all([
      env.DB.prepare('SELECT name FROM d1_migrations ORDER BY name DESC LIMIT 1').first<{
        name: string;
      }>(),
      readSecret(env.INSTALLATION_TOKEN),
      readSecret(env.CREDENTIAL_ENCRYPTION_KEY),
      readSecret(env.CURSOR_SIGNING_KEY),
    ]);
    const schema = row?.name.slice(0, 4);
    return {
      ok:
        schema === CURRENT_SCHEMA_VERSION &&
        token.length > 0 &&
        /^[a-f0-9]{64}$/i.test(encryption) &&
        cursor.length > 0,
      schema,
    };
  } catch {
    return { ok: false, schema: undefined };
  }
}
export async function maintenanceHealth(env: Env): Promise<boolean> {
  try {
    const rows = await readMaintenanceHeartbeats(env);
    const heartbeat = rows.find((row) => row.cadence === 'frequent');
    const hourly = rows.find((row) => row.cadence === 'hourly');
    const daily = rows.find((row) => row.cadence === 'daily');
    // Persisted initialization time makes grace independent of Worker redeployments.
    const healthyOrInitializing = (row: HeartbeatRow | undefined, maxAge: number) => {
      if (row?.completed_at) return healthyHeartbeat(row, maxAge);
      const age = Date.now() - Date.parse(row?.initialized_at ?? '');
      return row?.failed_count === 0 && age >= 0 && age < maxAge;
    };
    const hourlyHealthy = healthyOrInitializing(hourly, HOURLY_HEARTBEAT_MAX_AGE_MS);
    const dailyHealthy = healthyOrInitializing(daily, DAILY_HEARTBEAT_MAX_AGE_MS);
    if (!healthyHeartbeat(heartbeat, 15 * 60_000) || !hourlyHealthy || !dailyHealthy) return false;
    const [dlq, stalled] = await Promise.all([
      env.OUTBOUND_DLQ.metrics(),
      env.DB.prepare(
        "SELECT count(*) AS count FROM outbound_jobs WHERE status IN ('queued', 'sending') AND created_at < datetime('now', '-15 minutes') AND (scheduled_at IS NULL OR scheduled_at < datetime('now', '-15 minutes'))",
      ).first<{ count: number }>(),
    ]);
    return dlq.backlogCount === 0 && stalled?.count === 0;
  } catch {
    return false;
  }
}
