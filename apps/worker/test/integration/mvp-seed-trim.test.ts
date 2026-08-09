import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Validates migrations/0010_mvp_minimum_seed.sql. The M1 cut trims the
// 22-permission seed introduced by 0002 down to the 5 keys the
// administrator actually carries, and drops the `member` role (restored
// in M2 by issue #23).
describe("0010_mvp_minimum_seed", () => {
  it("leaves exactly the 5 MVP permission rows", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const row = await env.DB.prepare(
      "SELECT key FROM permissions ORDER BY key",
    ).all<{ key: string }>();
    const keys = row.results.map((r) => r.key);

    expect(keys).toEqual([
      "mailbox.create",
      "message.read",
      "message.send",
      "settings.manage",
      "settings.read",
    ]);
  });

  it("leaves exactly the administrator role and no member role", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const rows = await env.DB.prepare(
      "SELECT name FROM roles ORDER BY name",
    ).all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(["administrator"]);

    const members = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM roles WHERE name = 'member'",
    ).first<{ n: number }>();
    expect(members?.n).toBe(0);
  });

  it("links the administrator to all 5 MVP permissions", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    const linkCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM role_permissions",
    ).first<{ n: number }>();
    expect(linkCount?.n).toBe(5);

    const adminLinks = await env.DB.prepare(
      `SELECT rp.permission_key
       FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id
       WHERE r.name = 'administrator'
       ORDER BY rp.permission_key`,
    ).all<{ permission_key: string }>();
    expect(adminLinks.results.map((r) => r.permission_key)).toEqual([
      "mailbox.create",
      "message.read",
      "message.send",
      "settings.manage",
      "settings.read",
    ]);
  });
});
