import { CURRENT_SCHEMA_VERSION } from '../database/schema-version';
import type { Env } from './env';
import { readSecret } from './secrets';

export const CRON_HEARTBEAT_KEY = 'ops:cron';
export const HOURLY_CRON_HEARTBEAT_KEY = 'ops:cron:hourly';
export const DAILY_CRON_HEARTBEAT_KEY = 'ops:cron:daily';
const HOURLY_HEARTBEAT_MAX_AGE_MS = 2 * 60 * 60_000;
const DAILY_HEARTBEAT_MAX_AGE_MS = 26 * 60 * 60_000;
interface MaintenanceHeartbeat {
  completedAt: string;
  failedTasks: string[];
}
function healthyHeartbeat(heartbeat: MaintenanceHeartbeat | null, maxAge: number): boolean {
  if (!heartbeat || !Array.isArray(heartbeat.failedTasks) || heartbeat.failedTasks.length)
    return false;
  const age = Date.now() - Date.parse(heartbeat.completedAt);
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
    const [heartbeat, hourly, daily] = await Promise.all([
      env.CACHE.get<MaintenanceHeartbeat>(CRON_HEARTBEAT_KEY, 'json'),
      env.CACHE.get<MaintenanceHeartbeat>(HOURLY_CRON_HEARTBEAT_KEY, 'json'),
      env.CACHE.get<MaintenanceHeartbeat>(DAILY_CRON_HEARTBEAT_KEY, 'json'),
    ]);
    // New installations get one daily cycle plus propagation grace. An existing
    // failure/stale heartbeat is never excused by deploying a new version.
    const versionAge = Date.now() - Date.parse(env.VERSION?.timestamp ?? '');
    const hourlyHealthy = hourly
      ? healthyHeartbeat(hourly, HOURLY_HEARTBEAT_MAX_AGE_MS)
      : !env.VERSION || (versionAge >= 0 && versionAge < HOURLY_HEARTBEAT_MAX_AGE_MS);
    const dailyHealthy = daily
      ? healthyHeartbeat(daily, DAILY_HEARTBEAT_MAX_AGE_MS)
      : !env.VERSION || (versionAge >= 0 && versionAge < DAILY_HEARTBEAT_MAX_AGE_MS);
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
