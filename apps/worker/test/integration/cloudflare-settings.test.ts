import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@unimailbox/contracts";
import { CloudflareSettingsService } from "../../src/modules/administration/cloudflare-settings";
import { CredentialCipher } from "../../src/platform/crypto";

const administrator: Principal = {
  userId: "11111111-1111-4111-8111-111111111111",
  email: "admin@example.com",
  permissions: new Set(["settings.manage"]),
};

const member: Principal = {
  userId: "22222222-2222-4222-8222-222222222222",
  email: "member@example.com",
  permissions: new Set(),
};

const domainManager: Principal = {
  userId: "33333333-3333-4333-8333-333333333333",
  email: "domain-manager@example.com",
  permissions: new Set(["domain.manage"]),
};

function settingsService() {
  return new CloudflareSettingsService(
    env.KV,
    env.DB,
    new CredentialCipher("e".repeat(32)),
    {} as never,
    {
      clientId: "oauth-client-id",
      clientSecret: "oauth-client-secret",
      scopes: "zone.read email_routing.write",
    },
  );
}

describe("authenticated Cloudflare settings", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    // M1 cut (issue #17): the configuration_checkpoints seed was removed
    // from 0004_zero_touch_bootstrap.sql. The Cloudflare settings service
    // still queries the table for the two checkpoint keys these tests
    // assert against, so the tests pre-seed them. When M5 (issue #26)
    // reintroduces the seed via 0014_resume_signatures.sql + a dedicated
    // checkpoint backfill, this beforeEach can drop the manual inserts.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO configuration_checkpoints (checkpoint_key)
         VALUES ('cloudflare_mail'), ('r2_storage')`,
      ),
    ]);
  });

  it("requires settings.manage for configuration state", async () => {
    const settings = settingsService();

    await expect(settings.listCheckpoints(member)).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      status: 403,
    });
    await expect(settings.listCheckpoints(administrator)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkpointKey: "cloudflare_mail",
          status: "pending",
        }),
        expect.objectContaining({
          checkpointKey: "r2_storage",
          status: "pending",
        }),
      ]),
    );
  });

  it("uses Cloudflare's current account-level Email Routing dashboard path", () => {
    expect(
      settingsService()
        .dashboardLink(administrator, {
          accountId: "account-1",
          zoneId: "zone-1",
          destination: "email-routing",
        })
        .toString(),
    ).toBe(
      "https://dash.cloudflare.com/?to=%2Faccount-1%2Femail-service%2Frouting",
    );
  });

  it("keeps a locally added domain pending and returns its manual Email Routing destination", async () => {
    const settings = settingsService();
    await env.DB.prepare(
      `UPDATE installation_state
       SET cloudflare_account_id = ?, cloudflare_zone_id = ?
       WHERE id = 1`,
    )
      .bind("account-1", "zone-1")
      .run();

    await expect(
      settings.createDomain(domainManager, { name: "mail.example.com" }),
    ).resolves.toMatchObject({
      name: "mail.example.com",
      routingConfiguration: {
        status: "manual_setup_required",
        dashboardUrl:
          "https://dash.cloudflare.com/?to=%2Faccount-1%2Femail-service%2Frouting",
      },
    });
    await expect(settings.listCheckpoints(administrator)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkpointKey: "cloudflare_mail",
          status: "pending",
          metadata: {
            domainName: "mail.example.com",
            routingStatus: "manual_setup_required",
          },
          verifiedAt: null,
        }),
      ]),
    );
  });

  it("falls back to Cloudflare's account chooser when no account has been saved", async () => {
    const settings = settingsService();

    await expect(
      settings.createDomain(domainManager, { name: "example.com" }),
    ).resolves.toMatchObject({
      routingConfiguration: {
        status: "manual_setup_required",
        dashboardUrl:
          "https://dash.cloudflare.com/?to=%2F%3Aaccount%2Femail-service%2Frouting",
      },
    });
  });

  it("reports verified only when OAuth configured Cloudflare routing", async () => {
    const credentialId = "44444444-4444-4444-8444-444444444444";
    const cipher = new CredentialCipher("e".repeat(32));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO encrypted_credentials (
           id, encrypted_payload, encryption_version
         ) VALUES (?, ?, 1)`,
      ).bind(
        credentialId,
        await cipher.encrypt({
          accessToken: "cloudflare-access-token",
          refreshToken: "",
        }),
      ),
      env.DB.prepare(
        `UPDATE installation_state
         SET cloudflare_account_id = ?, cloudflare_zone_id = ?,
             cloudflare_credential_id = ?
         WHERE id = 1`,
      ).bind("account-1", "zone-1", credentialId),
    ]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { name: "example.com" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { status: "ready" } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            enabled: true,
            actions: [{ type: "worker", value: ["unimailbox"] }],
          },
        }),
      );
    const settings = settingsService();

    await expect(
      settings.createDomain(domainManager, { name: "mail.example.com" }),
    ).resolves.toMatchObject({
      routingConfiguration: {
        status: "configured",
        dns: "ready",
        catchAll: "unimailbox",
      },
    });
    await expect(settings.listCheckpoints(administrator)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkpointKey: "cloudflare_mail",
          status: "verified",
          metadata: {
            domainName: "mail.example.com",
            routingStatus: "configured",
          },
        }),
      ]),
    );
  });

  it("reports the domain ready only after OAuth configures its Email Routing", async () => {
    const credentialId = crypto.randomUUID();
    const cipher = new CredentialCipher("e".repeat(32));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO encrypted_credentials (
           id, encrypted_payload, encryption_version
         ) VALUES (?, ?, 1)`,
      ).bind(
        credentialId,
        await cipher.encrypt({ accessToken: "cloudflare-access-token" }),
      ),
      env.DB.prepare(
        `UPDATE installation_state
         SET cloudflare_account_id = ?, cloudflare_zone_id = ?,
             cloudflare_credential_id = ?
         WHERE id = 1`,
      ).bind("account-1", "zone-1", credentialId),
    ]);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { name: "example.com" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ success: true, result: { status: "ready" } }),
      )
      .mockResolvedValueOnce(
        Response.json({
          success: true,
          result: {
            enabled: true,
            actions: [{ type: "worker", value: ["unimailbox"] }],
          },
        }),
      );
    const settings = settingsService();

    await expect(
      settings.createDomain(administrator, { name: "mail.example.com" }),
    ).resolves.toMatchObject({
      routingConfiguration: {
        status: "configured",
        dns: "ready",
        catchAll: "unimailbox",
      },
    });
    await expect(settings.listCheckpoints(administrator)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkpointKey: "cloudflare_mail",
          status: "verified",
          metadata: {
            domainName: "mail.example.com",
            routingStatus: "configured",
          },
        }),
      ]),
    );
  });

  it("uses state and PKCE and stores exchanged OAuth tokens encrypted", async () => {
    const settings = settingsService();
    const { url } = await settings.cloudflareOauthStart(
      administrator,
      new Request("https://mail.example/api/v1/admin/cloudflare/oauth/start"),
    );
    const authorization = new URL(url);

    expect(authorization.origin).toBe("https://dash.cloudflare.com");
    expect(authorization.pathname).toBe("/oauth2/auth");
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(url).not.toContain("oauth-client-secret");

    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        access_token: "cloudflare-access-token",
        refresh_token: "cloudflare-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "zone.read",
      }),
    );
    const callback = new URL(
      "/api/v1/admin/cloudflare/oauth/callback",
      "https://mail.example",
    );
    callback.searchParams.set(
      "state",
      authorization.searchParams.get("state") ?? "",
    );
    callback.searchParams.set("code", "authorization-code");

    await expect(
      settings.cloudflareOauthCallback(new Request(callback)),
    ).resolves.toEqual(
      new URL("https://mail.example/settings/cloudflare?connected=true"),
    );
    const encrypted = await env.DB.prepare(
      `SELECT ec.encrypted_payload
       FROM installation_state state
       JOIN encrypted_credentials ec
         ON ec.id = state.cloudflare_credential_id
       WHERE state.id = 1`,
    ).first<{ encrypted_payload: string }>();
    expect(encrypted?.encrypted_payload).not.toContain(
      "cloudflare-access-token",
    );
    await expect(settings.listCheckpoints(administrator)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkpointKey: "cloudflare_mail",
          status: "configured",
        }),
      ]),
    );
  });

  it("revokes the stored OAuth credential as an administrator", async () => {
    const settings = settingsService();
    const { url } = await settings.cloudflareOauthStart(
      administrator,
      new Request("https://mail.example/api/v1/admin/cloudflare/oauth/start"),
    );
    const authorization = new URL(url);
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      Response.json({
        access_token: "cloudflare-access-token",
        refresh_token: "cloudflare-refresh-token",
        token_type: "Bearer",
      }),
    );
    const callback = new URL(
      "/api/v1/admin/cloudflare/oauth/callback",
      "https://mail.example",
    );
    callback.searchParams.set(
      "state",
      authorization.searchParams.get("state") ?? "",
    );
    callback.searchParams.set("code", "authorization-code");
    await settings.cloudflareOauthCallback(new Request(callback));

    await env.DB.prepare(
      `INSERT INTO users (
         id, email, password_hash, password_salt, password_iterations,
         display_name
       ) VALUES (?, ?, 'hash', 'salt', 1, 'Administrator')`,
    )
      .bind(administrator.userId, administrator.email)
      .run();
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(
      settings.revokeCloudflareOauth(
        administrator,
        new Request(
          "https://mail.example/api/v1/admin/cloudflare/oauth/revoke",
          { headers: { "x-request-id": crypto.randomUUID() } },
        ),
      ),
    ).resolves.toEqual({ revoked: true });
    await expect(
      env.DB.prepare(
        "SELECT cloudflare_credential_id FROM installation_state WHERE id = 1",
      ).first<{ cloudflare_credential_id: string | null }>(),
    ).resolves.toMatchObject({ cloudflare_credential_id: null });
  });
});
