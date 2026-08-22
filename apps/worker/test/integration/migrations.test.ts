import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

describe("D1 migration chain", () => {
  it("builds an empty database with valid foreign keys", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const required = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_schema
       WHERE type = 'table' AND name IN (
         'users', 'sessions', 'roles', 'permissions', 'domains', 'mailboxes',
         'messages', 'message_recipients', 'mailbox_messages',
         'message_user_state', 'attachment_uploads', 'message_attachments',
         'attachment_files',
         'outbound_jobs', 'provider_connections', 'webhook_deliveries',
         'installation_state', 'configuration_checkpoints'
       )`,
    ).first<number>("count");
    const foreignKeys = await env.DB.prepare("PRAGMA foreign_key_check").all();
    const installation = await env.DB.prepare(
      "SELECT current_step FROM installation_state WHERE id = 1",
    ).first<{ current_step: string }>();

    expect(required).toBe(18);
    expect(foreignKeys.results).toEqual([]);
    expect(installation?.current_step).toBe("admin_bootstrap");
    const checkpoints = await env.DB.prepare(
      "SELECT checkpoint_key FROM configuration_checkpoints ORDER BY checkpoint_key",
    ).all<{ checkpoint_key: string }>();
    expect(checkpoints.results.map((row) => row.checkpoint_key)).toEqual([
      "brevo",
      "cloudflare_mail",
      "inbound_smoke_test",
      "outbound_smoke_test",
      "r2_storage",
    ]);
  });

  it("applies the MVP-trimmed permission seed (0010)", async () => {
    // After 0010_mvp_minimum_seed.sql the permission catalog carries only the
    // 5 keys the administrator role grants (see PR #31 / issue #14). The
    // historical 22-key count and the member role are restored in M2 (#23)
    // and later milestones; this test documents the current MVP state.
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const permissions = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM permissions",
    ).first<number>("count");
    const roles = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM roles WHERE is_system = 1",
    ).first<number>("count");
    const administratorPermissions = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM role_permissions
       WHERE role_id = '00000000-0000-4000-8000-000000000001'`,
    ).first<number>("count");

    expect(permissions).toBe(5);
    expect(roles).toBe(1);
    expect(administratorPermissions).toBe(5);
    const memberRole = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM roles WHERE name = 'member'",
    ).first<number>("count");
    expect(memberRole).toBe(0);
    const administratorKeys = await env.DB.prepare(
      `SELECT permission_key FROM role_permissions
       WHERE role_id = '00000000-0000-4000-8000-000000000001'
       ORDER BY permission_key`,
    ).all<{ permission_key: string }>();
    expect(administratorKeys.results.map((r) => r.permission_key)).toEqual([
      "mailbox.create",
      "message.read",
      "message.send",
      "settings.manage",
      "settings.read",
    ]);
    // The deferred keys listed in blueprint §3.3 are no longer seeded for
    // any principal in M1 — they will return in M2..M9.
    const deferredRows = await env.DB.prepare(
      `SELECT 1 FROM permissions WHERE key IN (
        'message.read_all', 'message.delete', 'attachment.read',
        'mailbox.manage', 'mailbox.share', 'user.read', 'user.manage',
        'role.read', 'role.manage', 'domain.read', 'domain.manage',
        'signature.read', 'signature.manage', 'provider.sync',
        'webhook_event.read', 'webhook_event.delete', 'analytics.read'
       ) LIMIT 1`,
    ).first();
    expect(deferredRows).toBeNull();
  });

  it("strips the attachment validation triggers (M1 cut)", async () => {
    // 0011_mvp_minimum.sql drops the two attachment triggers from 0001 so
    // the M1 baseline matches blueprint §3 (attachments 🟡: schema kept,
    // routes inactive). The corresponding enforcement test moves to the
    // M6 resurrection — see issue #27. Here we just assert the absence.
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_schema
       WHERE type = 'trigger' AND name IN (
         'validate_attachment_upload', 'consume_attachment_upload'
       )`,
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("upgrades the previous release fixture without losing existing data", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 2));
    await env.DB.prepare(
      `INSERT INTO users (
         id, email, password_hash, password_salt, password_iterations,
         display_name
       ) VALUES (?, 'existing@example.com', 'hash', 'salt', 1, 'Existing')`,
    )
      .bind("11111111-1111-4111-8111-111111111111")
      .run();

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(2));

    await expect(
      env.DB.prepare("SELECT email FROM users WHERE id = ?")
        .bind("11111111-1111-4111-8111-111111111111")
        .first<{ email: string }>(),
    ).resolves.toEqual({ email: "existing@example.com" });
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM sqlite_schema
         WHERE type = 'table' AND name = 'account_recovery_codes'`,
      ).first<number>("count"),
    ).resolves.toBe(1);
    await expect(
      env.DB.prepare(
        "SELECT current_step FROM installation_state WHERE id = 1",
      ).first<{ current_step: string }>(),
    ).resolves.toEqual({ current_step: "admin_bootstrap" });
    await expect(
      env.DB.prepare("PRAGMA foreign_key_check").all(),
    ).resolves.toMatchObject({ results: [] });
  });

  it("clears the 0007 attachment-files catalog after 0011", async () => {
    // The legacy MD5 backfill enqueued by 0007 is removed by 0011. The
    // `attachment_files` catalog still exists (🟡 per blueprint §3.1) but
    // carries zero rows in M1. This test pins that state. M6
    // (issue #27) re-runs 0007-equivalent logic and re-enqueues the
    // backfill; re-arm this assertion then.
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const fileCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM attachment_files",
    ).first<{ n: number }>();
    expect(fileCount?.n).toBe(0);
    const backfill = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM maintenance_jobs
       WHERE job_key = 'attachment-md5-backfill'`,
    ).first<{ n: number }>();
    expect(backfill?.n).toBe(0);
  });
});
