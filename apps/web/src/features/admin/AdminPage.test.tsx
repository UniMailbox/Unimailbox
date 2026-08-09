import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it, vi } from "vitest";
import { createTestQueryClient } from "../../app/query-client";
import { createAppRouter } from "../../app/router";
import { createI18nInstance } from "../../i18n";
import en from "../../i18n/resources/en/admin.json";
import zhCN from "../../i18n/resources/zh-CN/admin.json";
import arXB from "../../i18n/resources/ar-XB/admin.json";
import { CreateDomainPanel, ManageDomainPanel } from "./AdminPage";

const toastSuccessSpy = vi.fn();

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessSpy(...args),
    error: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
  },
  Toaster: () => null,
}));

type TranslationTree = string | { [key: string]: TranslationTree };

function leaves(value: TranslationTree, prefix = ""): string[] {
  if (!value || typeof value !== "object") return [prefix];
  return Object.entries(value).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("Administration", () => {
  it("keeps English, Chinese, and pseudo-RTL administration keys aligned", () => {
    expect(leaves(zhCN)).toEqual(leaves(en));
    expect(leaves(arXB)).toEqual(leaves(en));
  });

  // M1 cut (issue #21): /admin/users is unrouted; this assertion stays
  // in the file as a placeholder so M2+ can flip it back on with a focused
  // PR. The router-level gate currently 404s any deep link to a hidden
  // resource, which is asserted by the router tests.
  it.skip("renders localized navigation and does not expose raw Worker values (M2+ — /admin/users is hidden in M1, issue #21)");

  it.skip(
    "shows the global message menu only with message.read_all and audits through the detail API (M2+ — /admin/messages is hidden in M1, issue #21)",
    async () => {
    Object.defineProperty(window, "scrollTo", {
      value: vi.fn(),
      configurable: true,
    });
    const messageId = "44444444-4444-4444-8444-444444444444";
    const domainId = "55555555-5555-4555-8555-555555555555";
    const mailboxId = "66666666-6666-4666-8666-666666666666";
    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/api/v1/admin/messages?")) {
          return Response.json({
            data: {
              items: [
                {
                  id: messageId,
                  domain_id: domainId,
                  domain_name: "private.example.com",
                  from_address: "sender@example.net",
                  from_name: "Sender",
                  subject: "Private subject",
                  status: "received",
                  recipient_addresses: "private@private.example.com",
                  mailbox_addresses: "private@private.example.com",
                  created_at: "2026-08-02 12:00:00",
                  sent_at: null,
                  received_at: "2026-08-02 12:00:00",
                },
              ],
              nextCursor: null,
            },
          });
        }
        if (url.endsWith(`/api/v1/admin/messages/${messageId}`)) {
          return Response.json({
            data: {
              id: messageId,
              domain_id: domainId,
              domain_name: "private.example.com",
              thread_id: null,
              from_address: "sender@example.net",
              from_name: "Sender",
              subject: "Private subject",
              html_body: "<p>Private body</p><script>alert(1)</script>",
              text_body: "Private body",
              message_id_header: null,
              in_reply_to_header: null,
              references_header: "",
              provider_key: null,
              provider_message_id: null,
              status: "received",
              created_at: "2026-08-02 12:00:00",
              updated_at: "2026-08-02 12:00:00",
              sent_at: null,
              received_at: "2026-08-02 12:00:00",
              recipients: [
                {
                  type: "to",
                  address: "private@private.example.com",
                  display_name: null,
                },
              ],
              mailboxes: [
                {
                  id: mailboxId,
                  address: "private@private.example.com",
                  folder: "inbox",
                },
              ],
              attachments: [],
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["auth", "session"], {
      userId: "11111111-1111-4111-8111-111111111111",
      email: "auditor@example.com",
      permissions: ["message.read_all", "attachment.read"],
    });
    const router = createAppRouter({ queryClient });
    await router.navigate({ to: "/admin/messages" });
    render(
      <I18nextProvider i18n={createI18nInstance("en")}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} context={{ queryClient }} />
        </QueryClientProvider>
      </I18nextProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "All messages" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "All messages" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Attachments" })).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Users" }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("Private subject")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "View message: Private subject" }),
    );

    const frame = await screen.findByTitle("Message content");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).toContain("<p>Private body</p>");
    expect(frame.getAttribute("srcdoc")).not.toContain("<script>");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(`/api/v1/admin/messages/${messageId}`),
      expect.anything(),
    );
  });

  it.skip(
    "searches and safely previews cataloged attachments (M2+ — /admin/attachments is hidden in M1, issue #21)",
    async () => {
    Object.defineProperty(window, "scrollTo", {
      value: vi.fn(),
      configurable: true,
    });
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn(() => "blob:admin-attachment"),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: vi.fn(),
      configurable: true,
    });
    const attachmentId = "44444444-4444-4444-8444-444444444444";
    const messageId = "55555555-5555-4555-8555-555555555555";
    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes("/api/v1/admin/attachments?")) {
          return Response.json({
            data: {
              items: [
                {
                  id: attachmentId,
                  message_id: messageId,
                  filename: "report.png",
                  mime_type: "image/png",
                  size_bytes: 4,
                  disposition: "attachment",
                  content_id: null,
                  md5: "8d777f385d3dfec8815d20f7496026dc",
                  subject: "Quarterly report",
                  from_address: "sender@example.net",
                  message_created_at: "2026-08-02 12:00:00",
                  created_at: "2026-08-02 12:00:00",
                  reference_count: 2,
                },
              ],
              nextCursor: null,
            },
          });
        }
        if (
          url.endsWith(`/api/v1/admin/attachments/${attachmentId}/download`)
        ) {
          return new Response(new Uint8Array([137, 80, 78, 71]), {
            headers: {
              "content-type": "image/png",
              "content-disposition": "attachment; filename=report.png",
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["auth", "session"], {
      userId: "11111111-1111-4111-8111-111111111111",
      email: "auditor@example.com",
      permissions: ["attachment.read"],
    });
    const router = createAppRouter({ queryClient });
    await router.navigate({ to: "/admin/attachments" });
    render(
      <I18nextProvider i18n={createI18nInstance("en")}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} context={{ queryClient }} />
        </QueryClientProvider>
      </I18nextProvider>,
    );

    expect(
      await screen.findByRole("heading", { name: "Attachments" }),
    ).toBeVisible();
    expect(await screen.findByText("report.png")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search attachments"), {
      target: { value: "8d777f" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(await screen.findByRole("button", { name: "View" }));

    expect(await screen.findByAltText("report.png")).toHaveAttribute(
      "src",
      "blob:admin-attachment",
    );
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "download",
      "report.png",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/admin/attachments?limit=50&q=8d777f"),
      expect.anything(),
    );
  });

  it("defines localized labels for every Worker user and webhook status", () => {
    const statuses = [
      "active",
      "suspended",
      "deleted",
      "draft",
      "queued",
      "sending",
      "sent",
      "delayed",
      "delivered",
      "bounced",
      "failed",
      "complained",
      "received",
    ] as const;
    for (const status of statuses) {
      expect(en.values[status]).toBeTruthy();
      expect(zhCN.values[status]).toBeTruthy();
      expect(arXB.values[status]).toBeTruthy();
    }
  });

  it("shows Cloudflare Email Routing guidance after creating a domain", async () => {
    vi.spyOn(window, "fetch").mockResolvedValue(
      Response.json(
        {
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
        },
        { status: 201 },
      ),
    );
    render(
      <I18nextProvider i18n={createI18nInstance("en")}>
        <QueryClientProvider client={createTestQueryClient()}>
          <CreateDomainPanel />
        </QueryClientProvider>
      </I18nextProvider>,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
      target: { value: "mail.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByRole("heading", {
        name: "Finish setup in Cloudflare",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open Email Routing" }),
    ).toHaveAttribute(
      "href",
      "https://dash.cloudflare.com/?to=%2Faccount-1%2Femail-service%2Frouting",
    );
  });

  it.skip(
    "hides user IDs and manages roles and mailbox access through selectors (M2+ — /admin/users is hidden in M1, issue #21)",
    async () => {
    Object.defineProperty(window, "scrollTo", {
      value: vi.fn(),
      configurable: true,
    });
    const adminId = "11111111-1111-4111-8111-111111111111";
    const userId = "22222222-2222-4222-8222-222222222222";
    const roleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const ownerMailboxId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const sharedMailboxId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const availableMailboxId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/api/v1/admin/users") && method === "GET") {
          return Response.json({
            data: [
              {
                id: userId,
                email: "member@example.com",
                display_name: "Member",
                status: "active",
                created_at: "2026-08-02 12:00:00",
                roles: "Administrators",
                role_ids: roleId,
              },
            ],
          });
        }
        if (url.endsWith("/api/v1/admin/users/role-options")) {
          return Response.json({
            data: [
              {
                id: roleId,
                name: "Administrators",
                is_system: 1,
              },
            ],
          });
        }
        if (
          url.endsWith(`/api/v1/admin/users/${userId}/mailboxes`) &&
          method === "GET"
        ) {
          return Response.json({
            data: {
              items: [
                {
                  mailboxId: ownerMailboxId,
                  address: "member@example.com",
                  displayName: "Personal",
                  status: "active",
                  domainId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                  role: "owner",
                  ownerUserId: userId,
                  ownerEmail: "member@example.com",
                  ownerDisplayName: "Member",
                },
                {
                  mailboxId: sharedMailboxId,
                  address: "team@example.com",
                  displayName: "Team",
                  status: "active",
                  domainId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                  role: "viewer",
                  ownerUserId: adminId,
                  ownerEmail: "admin@example.com",
                  ownerDisplayName: "Admin",
                },
              ],
              available: [
                {
                  mailboxId: availableMailboxId,
                  address: "sales@example.com",
                  displayName: "Sales",
                  status: "active",
                  ownerEmail: "admin@example.com",
                },
              ],
            },
          });
        }
        if (
          url.endsWith(`/api/v1/admin/users/${userId}/mailboxes`) &&
          method === "POST"
        ) {
          return Response.json(
            {
              data: {
                mailboxId: availableMailboxId,
                address: "sales@example.com",
                displayName: "Sales",
                status: "active",
                domainId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                role: "sender",
                ownerUserId: adminId,
                ownerEmail: "admin@example.com",
                ownerDisplayName: "Admin",
              },
            },
            { status: 201 },
          );
        }
        if (
          url.endsWith(
            `/api/v1/admin/users/${userId}/mailboxes/${sharedMailboxId}`,
          ) &&
          method === "DELETE"
        ) {
          return new Response(null, { status: 204 });
        }
        if (
          url.endsWith(`/api/v1/admin/users/${userId}`) &&
          method === "PATCH"
        ) {
          return Response.json({ data: { id: userId, roleIds: [] } });
        }
        if (url.endsWith("/api/v1/admin/users") && method === "POST") {
          return Response.json(
            { data: { id: userId, email: "new@example.com" } },
            { status: 201 },
          );
        }
        throw new Error(`Unexpected request: ${url}`);
      });
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(["auth", "session"], {
      userId: adminId,
      email: "admin@example.com",
      permissions: ["user.manage", "user.read"],
    });
    const router = createAppRouter({ queryClient });
    await router.navigate({ to: "/admin/users" });
    render(
      <I18nextProvider i18n={createI18nInstance("en")}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} context={{ queryClient }} />
        </QueryClientProvider>
      </I18nextProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Users" })).toBeVisible();
    // Internal ID column hidden from the table for the users resource.
    expect(screen.queryByRole("columnheader", { name: "ID" })).toBeNull();
    expect(await screen.findByText("member@example.com")).toBeVisible();
    expect(screen.queryByText(userId)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(
      await screen.findByRole("heading", { name: "Mailbox access" }),
    ).toBeVisible();
    expect(await screen.findByText("team@example.com")).toBeVisible();
    expect(screen.queryByText(sharedMailboxId)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Mailbox address"), {
      target: { value: "sales@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Access role"), {
      target: { value: "sender" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Grant mailbox access" }),
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/api/v1/admin/users/${userId}/mailboxes`),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            mailboxId: availableMailboxId,
            role: "sender",
          }),
        }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(
          `/api/v1/admin/users/${userId}/mailboxes/${sharedMailboxId}`,
        ),
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(await screen.findByText("Administrators")).toBeVisible();
    expect(screen.queryByText(roleId)).not.toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove Administrators" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply change" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining(`/api/v1/admin/users/${userId}`),
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({
            displayName: "Member",
            status: "active",
            roleIds: [],
          }),
        }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Add Users" }));
    const roleCombobox = await screen.findByRole("combobox", {
      name: "Assigned roles",
    });
    expect(screen.getByText("No roles assigned")).toBeVisible();
    expect(screen.queryByLabelText("Role IDs")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "New User" },
    });
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "new@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Temporary password"), {
      target: { value: "correct-horse-battery-staple" },
    });
    fireEvent.click(roleCombobox);
    fireEvent.change(screen.getByPlaceholderText("Search roles"), {
      target: { value: "Admin" },
    });
    fireEvent.click(screen.getByRole("option", { name: "Administrators" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/api/v1/admin/users"),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            email: "new@example.com",
            displayName: "New User",
            password: "correct-horse-battery-staple",
            roleIds: [roleId],
          }),
        }),
      ),
    );
  });

  it("selects a domain provider by label and sends a test to a chosen address", async () => {
    const connectionId = "22222222-2222-4222-8222-222222222222";
    const domainId = "33333333-3333-4333-8333-333333333333";
    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.endsWith("/api/v1/admin/provider-connections")) {
          return Response.json({
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
          });
        }
        if (url.endsWith(`/api/v1/admin/domains/${domainId}/provider-test`)) {
          expect(JSON.parse(String(init?.body))).toEqual({
            to: "owner@example.net",
          });
          return Response.json({
            data: {
              status: "sent",
              domainId,
              providerKey: "resend",
              connectionId,
              providerMessageId: "provider-message-id",
              acceptedAt: "2026-08-02T12:00:00.000Z",
            },
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      });
    render(
      <I18nextProvider i18n={createI18nInstance("en")}>
        <QueryClientProvider client={createTestQueryClient()}>
          <ManageDomainPanel
            onClose={() => undefined}
            row={{
              id: domainId,
              name: "mail.example.com",
              status: "active",
              outbound_connection_id: connectionId,
            }}
          />
        </QueryClientProvider>
      </I18nextProvider>,
    );

    const selector = await screen.findByRole("combobox", {
      name: "Outbound provider",
    });
    expect(
      await screen.findByRole("option", { name: "resend — Transactional" }),
    ).toBeVisible();
    expect(selector).toHaveValue(connectionId);

    fireEvent.change(screen.getByRole("textbox", { name: "Test recipient" }), {
      target: { value: "owner@example.net" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send test email" }));
    expect(fetchMock).toHaveBeenCalled();
    // Success now surfaces through the toast layer instead of an inline DOM
    // node; assert the side-effect fired rather than scanning the tree for a
    // confirmation banner that no longer exists.
    await waitFor(() => {
      expect(toastSuccessSpy).toHaveBeenCalled();
    });
  });
});
