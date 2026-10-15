import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { resetAndMigrate } from '@unimailbox/test-kit';
import { readMaintenanceHeartbeats, writeMaintenanceHeartbeat } from './maintenance-heartbeats';
import { runMaintenanceTasks } from './maintenance';
import { maintenanceHealth } from './health';

describe('D1 maintenance heartbeat handover and atomic snapshots', () => {
  beforeEach(resetAndMigrate);
  afterEach(() => vi.restoreAllMocks());

  it('imports each legacy snapshot once, retaining failures until the same cadence recovers', async () => {
    const now = new Date().toISOString();
    for (const key of ['ops:cron', 'ops:cron:hourly', 'ops:cron:daily']) {
      await env.CACHE.put(
        key,
        JSON.stringify({
          completedAt: now,
          failedTasks: key.endsWith('daily') ? ['avatars.sweep'] : [],
        }),
      );
    }
    const get = vi.spyOn(env.CACHE, 'get');
    const put = vi.spyOn(env.CACHE, 'put');
    const remove = vi.spyOn(env.CACHE, 'delete');
    expect(await maintenanceHealth(env)).toBe(false);
    expect(get).toHaveBeenCalledTimes(3);
    expect(
      await env.DB.prepare(
        "SELECT task_name FROM maintenance_heartbeat_failures WHERE cadence='daily'",
      ).first(),
    ).toEqual({ task_name: 'avatars.sweep' });
    get.mockClear();
    await runMaintenanceTasks(env, 'new-frequent', []);
    for (let i = 0; i < 4; i++) expect(await maintenanceHealth(env)).toBe(false);
    await runMaintenanceTasks(env, 'new-daily', [], 'daily');
    expect(await maintenanceHealth(env)).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('durably records missing legacy keys rather than looking them up on every probe', async () => {
    const get = vi.spyOn(env.CACHE, 'get');
    expect(await maintenanceHealth(env)).toBe(false);
    expect(get).toHaveBeenCalledTimes(3);
    get.mockClear();
    await runMaintenanceTasks(env, 'first-frequent', []);
    for (let i = 0; i < 4; i++) expect(await maintenanceHealth(env)).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });

  it.each(['malformed', 'unavailable'])(
    'keeps %s legacy state unhealthy without repeated KV fallback',
    async (kind) => {
      if (kind === 'malformed') await env.CACHE.put('ops:cron:daily', 'invalid JSON');
      const get = vi.spyOn(env.CACHE, 'get');
      if (kind === 'unavailable') get.mockRejectedValue(new Error('Synthetic unavailable KV'));
      expect(await maintenanceHealth(env)).toBe(false);
      get.mockClear();
      expect(await maintenanceHealth(env)).toBe(false);
      expect(get).not.toHaveBeenCalled();
      for (const cadence of ['frequent', 'hourly', 'daily'] as const)
        await runMaintenanceTasks(env, `recover-${cadence}`, [], cadence);
      expect(await maintenanceHealth(env)).toBe(true);
    },
  );

  it('does not let legacy adoption overwrite a live failure that wins the race', async () => {
    await env.DB.prepare(
      "UPDATE maintenance_heartbeats SET legacy_imported=1 WHERE cadence != 'daily'",
    ).run();
    const get = vi.spyOn(env.CACHE, 'get').mockImplementationOnce(async () => {
      const now = new Date().toISOString();
      await writeMaintenanceHeartbeat(env.DB, {
        cadence: 'daily',
        requestId: 'live',
        startedAt: now,
        completedAt: now,
        failedTasks: ['live.failure'],
      });
      return { completedAt: now, failedTasks: [] };
    });
    const rows = await readMaintenanceHeartbeats(env);
    expect(rows.find((row) => row.cadence === 'daily')?.failed_count).toBe(1);
    expect(
      await env.DB.prepare('SELECT task_name FROM maintenance_heartbeat_failures').first(),
    ).toEqual({ task_name: 'live.failure' });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps a newer failed run when an older successful run finishes late', async () => {
    const snapshot = { cadence: 'daily' as const, completedAt: '2026-10-15T12:00:00.000Z' };
    await writeMaintenanceHeartbeat(env.DB, {
      ...snapshot,
      requestId: 'new',
      startedAt: '2026-10-15T11:00:00.000Z',
      failedTasks: ['new.failure'],
    });
    await writeMaintenanceHeartbeat(env.DB, {
      ...snapshot,
      requestId: 'old',
      startedAt: '2026-10-15T10:00:00.000Z',
      failedTasks: [],
    });
    expect(
      await env.DB.prepare(
        "SELECT request_id,failed_count FROM maintenance_heartbeats WHERE cadence='daily'",
      ).first(),
    ).toEqual({ request_id: 'new', failed_count: 1 });
    expect(
      await env.DB.prepare('SELECT task_name FROM maintenance_heartbeat_failures').first(),
    ).toEqual({ task_name: 'new.failure' });
  });

  it('rolls status and task names back together if the failure-name insert fails', async () => {
    const now = new Date().toISOString();
    const snapshot = { cadence: 'daily' as const, startedAt: now, completedAt: now };
    await writeMaintenanceHeartbeat(env.DB, { ...snapshot, requestId: 'before', failedTasks: [] });
    await env.DB.prepare(
      "CREATE TRIGGER reject_failure BEFORE INSERT ON maintenance_heartbeat_failures BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
    ).run();
    await expect(
      writeMaintenanceHeartbeat(env.DB, {
        ...snapshot,
        requestId: 'after',
        failedTasks: ['broken'],
      }),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT request_id,failed_count FROM maintenance_heartbeats WHERE cadence='daily'",
      ).first(),
    ).toEqual({ request_id: 'before', failed_count: 0 });
    expect(
      (await env.DB.prepare('SELECT * FROM maintenance_heartbeat_failures').all()).results,
    ).toHaveLength(0);
  });

  it.each([
    ['frequent', 15 * 60_000],
    ['hourly', 2 * 60 * 60_000],
    ['daily', 26 * 60 * 60_000],
  ] as const)(
    'keeps the %s freshness boundary and rejects future snapshots',
    async (cadence, maxAge) => {
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const timestamp = new Date(now).toISOString();
      for (const current of ['frequent', 'hourly', 'daily'] as const) {
        await writeMaintenanceHeartbeat(env.DB, {
          cadence: current,
          requestId: current,
          startedAt: timestamp,
          completedAt: timestamp,
          failedTasks: [],
        });
      }
      const setCompleted = (value: number) =>
        env.DB.prepare('UPDATE maintenance_heartbeats SET completed_at=? WHERE cadence=?')
          .bind(new Date(value).toISOString(), cadence)
          .run();
      await setCompleted(now - maxAge + 1);
      expect(await maintenanceHealth(env)).toBe(true);
      await setCompleted(now - maxAge);
      expect(await maintenanceHealth(env)).toBe(false);
      await setCompleted(now + 1);
      expect(await maintenanceHealth(env)).toBe(false);
    },
  );

  it('fails closed when D1 is unavailable without using KV as an alternative store', async () => {
    await env.DB.exec(
      'DROP TABLE maintenance_heartbeat_failures; DROP TABLE maintenance_heartbeats;',
    );
    const get = vi.spyOn(env.CACHE, 'get');
    const put = vi.spyOn(env.CACHE, 'put');
    await expect(runMaintenanceTasks(env, 'no-database', [])).rejects.toThrow('heartbeat');
    expect(await maintenanceHealth(env)).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
