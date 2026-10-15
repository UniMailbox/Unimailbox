import type { Env } from './env';
import { writeMaintenanceHeartbeat, type MaintenanceCadence } from './maintenance-heartbeats';
import { logger } from './logger';

export interface MaintenanceTask {
  name: string;
  run(): Promise<unknown>;
}
export async function runMaintenanceTasks(
  env: Env,
  requestId: string,
  tasks: readonly MaintenanceTask[],
  cadence: MaintenanceCadence = 'frequent',
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
    await writeMaintenanceHeartbeat(env.DB, {
      cadence,
      requestId,
      startedAt,
      completedAt,
      failedTasks,
    });
  } catch {
    failedTasks.push('heartbeat');
  }
  logger[failedTasks.length ? 'error' : 'info'](
    { event: 'cron.complete', requestId },
    { cadence, startedAt, completedAt, failedTasks, ok: failedTasks.length === 0 },
  );
  if (failedTasks.length) throw new Error(`Maintenance tasks failed: ${failedTasks.join(', ')}`);
}
