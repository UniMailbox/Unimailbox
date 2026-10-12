import { beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { CURRENT_SCHEMA_VERSION } from '@unimailbox/contracts';
import { resetAndMigrate } from '@unimailbox/test-kit';
import { runMaintenanceTasks } from './maintenance';
import { CRON_HEARTBEAT_KEY, DAILY_CRON_HEARTBEAT_KEY, maintenanceHealth } from './health';

describe('maintenance failure isolation and monitoring', () => {
  beforeEach(resetAndMigrate);
  it('continues after a real SQL failure, persists failed task identity and reports failure', async () => {
    await expect(
      runMaintenanceTasks(env, 'failure-test', [
        {
          name: 'broken',
          run: () => env.DB.prepare('SELECT * FROM deployment_missing_table').all(),
        },
        { name: 'following', run: () => env.CACHE.put('following-task', 'ran') },
      ]),
    ).rejects.toThrow('broken');
    expect(await env.CACHE.get('following-task')).toBe('ran');
    expect(await env.CACHE.get(CRON_HEARTBEAT_KEY, 'json')).toMatchObject({
      failedTasks: ['broken'],
    });
    expect((await SELF.fetch('http://localhost/healthz/maintenance')).status).toBe(503);
  });
  it('reports stale or absent heartbeats as unhealthy', async () => {
    await env.CACHE.delete(CRON_HEARTBEAT_KEY);
    expect((await SELF.fetch('http://localhost/healthz/maintenance')).status).toBe(503);
    await env.CACHE.put(
      CRON_HEARTBEAT_KEY,
      JSON.stringify({ completedAt: '2020-01-01T00:00:00Z', failedTasks: [] }),
    );
    expect((await SELF.fetch('http://localhost/healthz/maintenance')).status).toBe(503);
  });
  it('reports schema drift as not ready', async () => {
    await env.DB.prepare('DELETE FROM d1_migrations WHERE name LIKE ?')
      .bind(`${CURRENT_SCHEMA_VERSION}_%`)
      .run();
    const response = await SELF.fetch('http://localhost/readyz');
    expect(response.status).toBe(503);
    const previous = String(Number(CURRENT_SCHEMA_VERSION) - 1).padStart(4, '0');
    expect(await response.json()).toMatchObject({ ok: false, schema: previous });
  });

  it('keeps daily failure visible after a successful frequent tick, until daily recovery', async () => {
    await expect(
      runMaintenanceTasks(
        env,
        'daily-failure',
        [
          {
            name: 'avatars.sweep',
            run: () => env.DB.prepare('SELECT * FROM missing_daily_table').all(),
          },
        ],
        'daily',
      ),
    ).rejects.toThrow('avatars.sweep');
    await runMaintenanceTasks(env, 'frequent-success', []);
    expect(await maintenanceHealth(env)).toBe(false);
    expect(await env.CACHE.get(DAILY_CRON_HEARTBEAT_KEY, 'json')).toMatchObject({
      failedTasks: ['avatars.sweep'],
    });
    await runMaintenanceTasks(env, 'daily-recovery', [], 'daily');
    expect(await maintenanceHealth(env)).toBe(true);
  });

  it('allows the first daily cycle, then rejects absent/stale daily heartbeats', async () => {
    await runMaintenanceTasks(env, 'frequent-success', []);
    const fresh = { ...env, VERSION: { id: 'new', tag: '', timestamp: new Date().toISOString() } };
    expect(await maintenanceHealth(fresh)).toBe(true);
    const old = { ...env, VERSION: { id: 'old', tag: '', timestamp: '2020-01-01T00:00:00Z' } };
    expect(await maintenanceHealth(old)).toBe(false);
    await env.CACHE.put(
      DAILY_CRON_HEARTBEAT_KEY,
      JSON.stringify({
        completedAt: '2020-01-01T00:00:00Z',
        failedTasks: [],
      }),
    );
    expect(await maintenanceHealth(fresh)).toBe(false);
  });
});
