import { beforeEach, describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { CURRENT_SCHEMA_VERSION } from '@unimailbox/contracts';
import { resetAndMigrate } from '@unimailbox/test-kit';
import { runMaintenanceTasks } from './maintenance';
import { maintenanceHealth } from './health';

describe('maintenance failure isolation and monitoring', () => {
  beforeEach(async () => {
    await resetAndMigrate();
    await env.DB.prepare('UPDATE maintenance_heartbeats SET legacy_imported=1').run();
  });
  it('continues after SQL failure and persists failed task identity in D1', async () => {
    let followingRan = false;
    await expect(
      runMaintenanceTasks(env, 'failure-test', [
        {
          name: 'broken',
          run: () => env.DB.prepare('SELECT * FROM deployment_missing_table').all(),
        },
        {
          name: 'following',
          run: async () => {
            await env.DB.prepare('SELECT 1').first();
            followingRan = true;
          },
        },
      ]),
    ).rejects.toThrow('broken');
    expect(followingRan).toBe(true);
    expect(
      await env.DB.prepare('SELECT task_name FROM maintenance_heartbeat_failures').all(),
    ).toMatchObject({ results: [{ task_name: 'broken' }] });
    expect((await SELF.fetch('http://localhost/healthz/maintenance')).status).toBe(503);
  });
  it('reports stale or absent frequent heartbeats as unhealthy', async () => {
    expect((await SELF.fetch('http://localhost/healthz/maintenance')).status).toBe(503);
    await runMaintenanceTasks(env, 'frequent', []);
    await env.DB.prepare(
      "UPDATE maintenance_heartbeats SET completed_at='2020-01-01T00:00:00Z' WHERE cadence='frequent'",
    ).run();
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
  it('keeps daily failure visible after frequent success until daily recovery', async () => {
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
    await runMaintenanceTasks(env, 'daily-recovery', [], 'daily');
    expect(await maintenanceHealth(env)).toBe(true);
  });
  it('keeps initialization grace durable across redeploys and never excuses a stale daily result', async () => {
    await runMaintenanceTasks(env, 'frequent-success', []);
    expect(await maintenanceHealth(env)).toBe(true);
    await env.DB.prepare(
      "UPDATE maintenance_heartbeats SET initialized_at='2020-01-01T00:00:00Z' WHERE cadence='daily'",
    ).run();
    const fresh = { ...env, VERSION: { id: 'new', tag: '', timestamp: new Date().toISOString() } };
    expect(await maintenanceHealth(fresh)).toBe(false);
    await runMaintenanceTasks(env, 'daily-success', [], 'daily');
    expect(await maintenanceHealth(fresh)).toBe(true);
    await env.DB.prepare(
      "UPDATE maintenance_heartbeats SET completed_at='2020-01-01T00:00:00Z' WHERE cadence='daily'",
    ).run();
    expect(await maintenanceHealth(fresh)).toBe(false);
  });
});
