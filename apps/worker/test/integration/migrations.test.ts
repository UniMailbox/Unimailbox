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

  it("enforces attachment linkage triggers", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare(
      `INSERT INTO users (
         id, email, password_hash, password_salt, password_iterations,
         display_name
       ) VALUES (?, ?, 'hash', 'salt', 1, 'One')`,
    )
      .bind("11111111-1111-4111-8111-111111111111", "one@example.com")
      .run();
    await env.DB.prepare(
      `INSERT INTO attachment_uploads (
         id, user_id, object_key, filename, mime_type, size_bytes,
         disposition, status, expires_at
       ) VALUES (?, ?, 'attachments/a', 'a.txt', 'text/plain', 1,
                 'attachment', 'uploaded', datetime('now', '+1 hour'))`,
    )
      .bind(
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
      )
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO message_attachments (
           id, upload_id, object_key, filename, mime_type, size_bytes,
           disposition
         ) VALUES (?, ?, 'attachments/a', 'a.txt', 'text/plain', 1,
                   'attachment')`,
      )
        .bind(
          "33333333-3333-4333-8333-333333333333",
          "22222222-2222-4222-8222-222222222222",
        )
        .run(),
    ).rejects.toThrow();
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

  it("catalogs legacy attachment objects for scheduled MD5 backfill", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, 6));
    await env.DB.prepare(
      `INSERT INTO users (
         id, email, password_hash, password_salt, password_iterations,
         display_name
       ) VALUES (?, 'legacy@example.com', 'hash', 'salt', 1, 'Legacy')`,
    )
      .bind("11111111-1111-4111-8111-111111111111")
      .run();
    await env.DB.prepare(
      `INSERT INTO attachment_uploads (
         id, user_id, object_key, filename, mime_type, size_bytes,
         disposition, status, expires_at
       ) VALUES (?, ?, 'attachments/legacy', 'legacy.txt', 'text/plain', 6,
                 'attachment', 'uploaded', datetime('now', '+1 hour'))`,
    )
      .bind(
        "22222222-2222-4222-8222-222222222222",
        "11111111-1111-4111-8111-111111111111",
      )
      .run();

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(6));

    await expect(
      env.DB.prepare(
        `SELECT au.file_id, au.md5, af.object_key, af.md5 AS file_md5
         FROM attachment_uploads au
         JOIN attachment_files af ON af.id = au.file_id
         WHERE au.id = ?`,
      )
        .bind("22222222-2222-4222-8222-222222222222")
        .first(),
    ).resolves.toEqual({
      file_id: "legacy:attachments/legacy",
      md5: null,
      object_key: "attachments/legacy",
      file_md5: null,
    });
    await expect(
      env.DB.prepare(
        `SELECT status FROM maintenance_jobs
         WHERE job_key = 'attachment-md5-backfill'`,
      ).first(),
    ).resolves.toEqual({ status: "pending" });
  });
});
