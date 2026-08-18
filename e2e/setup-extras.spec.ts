import { expect, test } from "./fixtures/locale";
import type { Page } from "@playwright/test";

const systemSettings = {
  site_title: "UniMailbox",
  registration_enabled: 0,
  invite_required: 1,
  inbound_enabled: 1,
  outbound_enabled: 1,
  unknown_recipient_policy: "reject",
  max_mailboxes_per_user: 10,
  max_attachments_per_message: 20,
  max_attachment_bytes: 25_000_000,
  sender_blocklist_json: "[]",
  subject_blocklist_json: "[]",
  content_blocklist_json: "[]",
};

async function mockSystemSettingsShell(page: Page) {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          userId: "user-admin-1",
          email: "admin@example.com",
          permissions: ["settings.read", "settings.manage"],
        },
      }),
    }),
  );
  await page.route("**/api/v1/admin/settings", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: systemSettings }),
    }),
  );
  await page.route("**/api/v1/admin/cloudflare/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    }),
  );
  await page.route("**/api/v1/admin/infrastructure", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          required: { d1: "ok", kv: "ok", queue: "ok", assets: "ok" },
          attachments: { backend: "kv", r2: "missing", reason: "" },
        },
      }),
    }),
  );
}

test("storage settings show required services and healthy KV without R2", async ({
  page,
  uiLocale,
}) => {
  await mockSystemSettingsShell(page);
  await page.route("**/api/v1/admin/infrastructure", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          required: {
            d1: "ok",
            kv: "ok",
            queue: "ok",
            assets: "ok",
          },
          attachments: {
            backend: "kv",
            r2: "missing",
            reason:
              "ATTACHMENTS binding is absent; KV is the default storage backend",
          },
        },
      }),
    });
  });
  await page.goto("/admin/settings");

  await expect(page.getByText(uiLocale.copy.kvActive)).toBeVisible();
  await expect(page.getByText(uiLocale.copy.kvHealthy)).toBeVisible();
  await expect(
    page.getByRole("button", { name: uiLocale.copy.verifyR2 }),
  ).toBeDisabled();
});

test("Cloudflare mail configuration is available after login", async ({
  page,
  uiLocale,
}) => {
  await mockSystemSettingsShell(page);
  await page.route("**/api/v1/admin/cloudflare/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            checkpointKey: "cloudflare_mail",
            status: "pending",
            metadata: {},
            errorCode: null,
            errorMessage: null,
            verifiedAt: null,
          },
          {
            checkpointKey: "brevo",
            status: "pending",
            metadata: {},
            errorCode: null,
            errorMessage: null,
            verifiedAt: null,
          },
        ],
      }),
    });
  });
  await page.goto("/admin/settings");

  await expect(page.getByText(uiLocale.copy.controlPlane)).toBeVisible();
  await expect(page.getByText(uiLocale.copy.domainHeading)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: uiLocale.copy.brevo }),
  ).toBeVisible();
});

test("a locally added domain leads the operator to Cloudflare Email Routing", async ({
  page,
  uiLocale,
}) => {
  await mockSystemSettingsShell(page);
  await page.route("**/api/v1/admin/cloudflare/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [] }),
    });
  });
  await page.route("**/api/v1/admin/cloudflare/domains", async (route) => {
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          id: "11111111-1111-4111-8111-111111111111",
          name: "mail.example.com",
          expectedRoute: "*@mail.example.com -> unimailbox Worker",
          routingConfiguration: {
            status: "manual_setup_required",
            dashboardUrl:
              "https://dash.cloudflare.com/?to=%2Faccount-1%2Femail-service%2Frouting",
          },
        },
      }),
    });
  });
  await page.goto("/admin/settings");

  await page
    .getByRole("textbox", { name: /Managed domain|受管域名/u })
    .fill("mail.example.com");
  await page.getByRole("button", { name: /Add domain|添加域名/u }).click();

  await expect(
    page.getByRole("heading", { name: uiLocale.copy.finishCloudflare }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: uiLocale.copy.openEmailRouting }),
  ).toHaveAttribute(
    "href",
    "https://dash.cloudflare.com/?to=%2Faccount-1%2Femail-service%2Frouting",
  );
});

test("administration domain creation uses the same Email Routing guide", async ({
  page,
  uiLocale,
}) => {
  await page.route("**/api/v1/auth/session", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          userId: "user-admin-1",
          email: "admin@example.com",
          permissions: ["domain.read", "domain.manage"],
        },
      }),
    });
  });
  await page.route("**/api/v1/admin/domains", async (route) => {
    const data =
      route.request().method() === "POST"
        ? {
            id: "11111111-1111-4111-8111-111111111111",
            name: "mail.example.com",
            expectedRoute: "*@mail.example.com -> unimailbox Worker",
            routingConfiguration: {
              status: "manual_setup_required",
              dashboardUrl:
                "https://dash.cloudflare.com/?to=%2Faccount-1%2Femail-service%2Frouting",
            },
          }
        : [];
    await route.fulfill({
      status: route.request().method() === "POST" ? 201 : 200,
      contentType: "application/json",
      body: JSON.stringify({ data }),
    });
  });
  await page.goto("/admin/domains");

  await page.getByText(/Add Domains|添加域名/u).click();
  await page
    .getByRole("textbox", { name: /Name|名称/u })
    .fill("mail.example.com");
  await page.getByRole("button", { name: /Create|创建/u }).click();

  await expect(
    page.getByRole("heading", { name: uiLocale.copy.finishCloudflare }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: uiLocale.copy.openEmailRouting }),
  ).toHaveAttribute(
    "href",
    "https://dash.cloudflare.com/?to=%2Faccount-1%2Femail-service%2Frouting",
  );
});

test("administrator selects a domain provider and sends a provider test", async ({
  page,
}) => {
  const domainId = "11111111-1111-4111-8111-111111111111";
  const connectionId = "22222222-2222-4222-8222-222222222222";
  let selectedConnection: string | null = null;
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: {
          userId: "user-admin-1",
          email: "admin@example.com",
          permissions: ["domain.read", "domain.manage"],
        },
      }),
    }),
  );
  await page.route("**/api/v1/admin/domains", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: domainId,
            name: "mail.example.com",
            status: "active",
            outbound_connection_id: selectedConnection,
            provider_key: selectedConnection ? "resend" : null,
            provider_label: selectedConnection ? "Transactional" : null,
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/v1/admin/domains/${domainId}`, async (route) => {
    const body = route.request().postDataJSON() as {
      outboundConnectionId?: string | null;
    };
    selectedConnection = body.outboundConnectionId ?? null;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: { id: domainId, outboundConnectionId: selectedConnection },
      }),
    });
  });
  await page.route("**/api/v1/admin/provider-connections", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        data: [
          {
            id: connectionId,
            provider_key: "resend",
            label: "Transactional",
            status: "active",
            config_json: "{}",
            last_health_check_at: null,
            last_health_error: null,
            created_at: "2026-08-02 12:00:00",
            updated_at: "2026-08-02 12:00:00",
            webhook_path: `/api/v1/webhooks/resend/${connectionId}`,
          },
        ],
      }),
    }),
  );
  await page.route(
    `**/api/v1/admin/domains/${domainId}/provider-test`,
    async (route) => {
      expect(route.request().postDataJSON()).toEqual({
        to: "owner@example.net",
      });
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            status: "sent",
            domainId,
            providerKey: "resend",
            connectionId,
            providerMessageId: "provider-message-id",
            acceptedAt: "2026-08-02T12:00:00.000Z",
          },
        }),
      });
    },
  );

  await page.goto("/admin/domains");
  await page.getByRole("button", { name: /Edit|编辑/u }).click();
  await page
    .getByRole("combobox", { name: /Outbound provider|出站提供商/u })
    .selectOption(connectionId);
  await page.getByRole("button", { name: /Apply change|应用更改/u }).click();
  await expect(page.getByText("resend")).toBeVisible();

  await page.getByRole("button", { name: /Edit|编辑/u }).click();
  await page
    .getByRole("textbox", { name: /Test recipient|测试收件人/u })
    .fill("owner@example.net");
  await page
    .getByRole("button", { name: /Send test email|发送测试邮件/u })
    .click();
  // Scope to the sonner toaster so we disambiguate from any prior success
  // toast still on screen (e.g. the "Apply change" toast above).
  await expect(
    page
      .locator("[data-sonner-toaster]")
      .getByText(/accepted the test email|已接受发送/u)
      .last(),
  ).toBeVisible();
});
