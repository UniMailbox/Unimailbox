import type { Env } from './env';
import { CRON_HEARTBEAT_KEY, HOURLY_CRON_HEARTBEAT_KEY, DAILY_CRON_HEARTBEAT_KEY } from './health';
import { logger } from './logger';

export interface MaintenanceTask {
  name: string;
  run(): Promise<unknown>;
}
export async function runMaintenanceTasks(
  env: Env,
  requestId: string,
  tasks: readonly MaintenanceTask[],
  cadence: 'frequent' | 'hourly' | 'daily' = 'frequent',
): Promise<void> {
  const startedAt = new Date().toISOString();
  const failedTasks: string[] = [];
  for (const task of tasks) {
    const start = Date.now();
    try {
      await task.run();
    } catch {
      failedTasks.push(task.name);
      // Error details can contain provider payloads. Publish safe task identity only.
      logger.error(
        { event: 'cron.task', requestId, durationMs: Date.now() - start },
        { task: task.name, ok: false },
      );
    }
  }
  const completedAt = new Date().toISOString();
  try {
    await env.CACHE.put(
      cadence === 'daily'
        ? DAILY_CRON_HEARTBEAT_KEY
        : cadence === 'hourly'
          ? HOURLY_CRON_HEARTBEAT_KEY
          : CRON_HEARTBEAT_KEY,
      JSON.stringify({ requestId, startedAt, completedAt, failedTasks }),
      { expirationTtl: cadence === 'daily' ? 3 * 86400 : cadence === 'hourly' ? 3 * 3600 : 86400 },
    );
  } catch {
    failedTasks.push('heartbeat');
  }
  logger[failedTasks.length ? 'error' : 'info'](
    { event: 'cron.complete', requestId },
    { cadence, startedAt, completedAt, failedTasks, ok: failedTasks.length === 0 },
  );
  if (failedTasks.length) throw new Error(`Maintenance tasks failed: ${failedTasks.join(', ')}`);
}
