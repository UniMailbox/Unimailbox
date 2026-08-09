import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setAccessToken } from "../../lib/api/index";
import { useUiStore } from "../../lib/ui-store";
import { createI18nInstance, LOCALE_STORAGE_KEY } from "../../i18n";
import { TIME_ZONE_STORAGE_KEY } from "../../i18n/timezone";
import {
  applyThemeColor,
  DEFAULT_THEME_COLOR,
  THEME_COLOR_STORAGE_KEY,
} from "../../lib/theme";
import { SettingsPage } from "./SettingsPage";

vi.mock("@tanstack/react-router", async () => {
  const { createElement } = await import("react");
  return {
    Link: ({
      children,
      to: _to,
      ...props
    }: {
      children: ReactNode;
      to: string;
    }) => createElement("a", props, children),
    useNavigate: () => (input: { to: string }) => {
      window.history.replaceState({}, "", input.to);
      return Promise.resolve();
    },
  };
});

function renderSettings(section: "account" | "mailboxes" | "preferences") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={createI18nInstance("en")}>
        <SettingsPage section={section} />
      </I18nextProvider>
    </QueryClientProvider>,
  );
}

describe("authenticated settings", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/settings");
    window.sessionStorage.clear();
    window.localStorage.clear();
    useUiStore.setState({ themeColor: DEFAULT_THEME_COLOR, timeZone: "UTC" });
    applyThemeColor(DEFAULT_THEME_COLOR);
    vi.restoreAllMocks();
  });

  it("changes language immediately and persists it without exposing the test-only locale", async () => {
    renderSettings("preferences");

    fireEvent.change(screen.getByRole("combobox", { name: "Language" }), {
      target: { value: "zh-CN" },
    });

    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
    expect(screen.getByRole("heading", { name: "语言与地区" })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: /ar-XB/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Cloudflare Mail/i })).toBeNull();
    expect(
      screen.queryByRole("link", { name: /Storage & runtime/i }),
    ).toBeNull();
  });

  it("persists the selected time zone from language and region settings", () => {
    renderSettings("preferences");

    fireEvent.change(screen.getByRole("combobox", { name: "Time zone" }), {
      target: { value: "Asia/Singapore" },
    });

    expect(useUiStore.getState().timeZone).toBe("Asia/Singapore");
    expect(localStorage.getItem(TIME_ZONE_STORAGE_KEY)).toBe("Asia/Singapore");
  });

  it("applies and persists the selected theme color", () => {
    renderSettings("preferences");

    fireEvent.change(screen.getByLabelText("Theme color"), {
      target: { value: "#2563eb" },
    });

    expect(useUiStore.getState().themeColor).toBe("#2563eb");
    expect(localStorage.getItem(THEME_COLOR_STORAGE_KEY)).toBe("#2563eb");
    expect(
      document.documentElement.style.getPropertyValue("--theme-color"),
    ).toBe("#2563eb");
  });

  it("changes only the login email and returns to login", async () => {
    setAccessToken("access-token");
    const fetchMock = vi.spyOn(window, "fetch").mockResolvedValue(
      Response.json({
        data: {
          email: "new.login@example.com",
          sessionsRevoked: true,
        },
      }),
    );
    renderSettings("account");

    fireEvent.change(screen.getByLabelText("New login email"), {
      target: { value: "new.login@example.com" },
    });
    fireEvent.change(
      screen.getAllByLabelText("Current password", {
        selector: "input",
      })[0] as HTMLInputElement,
      { target: { value: "current-password-1234" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Update login email" }));

    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(window.sessionStorage.getItem("unimailbox.access-token")).toBeNull();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/v1/auth/email");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(init?.body))).toEqual({
      currentPassword: "current-password-1234",
      email: "new.login@example.com",
    });
    expect(
      screen.getByText(/does not create, select, or modify a mailbox/i),
    ).toBeVisible();
  });

  it("shows localized validation before sending an invalid account update", async () => {
    const fetchMock = vi.spyOn(window, "fetch");
    renderSettings("account");
    fireEvent.click(screen.getByRole("button", { name: "Update login email" }));

    expect(
      await screen.findByText("Enter a valid New login email."),
    ).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.skip(
    "shows localized validation before sharing a mailbox with an invalid member ID (M2+ — MailboxMembers UI is hidden in M1, issue #21)",
    async () => {
    const fetchMock = vi.spyOn(window, "fetch").mockResolvedValue(
      Response.json({
        data: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            address: "ops@example.com",
            display_name: "Operations",
            status: "active",
            domain_id: "22222222-2222-4222-8222-222222222222",
            role: "owner",
          },
        ],
      }),
    );
    renderSettings("mailboxes");
    fireEvent.click(await screen.findByText("Manage sharing"));
    fetchMock.mockClear();
    fireEvent.change(screen.getByLabelText("Member user ID"), {
      target: { value: "not-a-member-uuid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Share mailbox" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Member user ID",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows localized validation before creating an invalid mailbox", async () => {
    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockResolvedValue(Response.json({ data: [] }));
    renderSettings("mailboxes");
    await screen.findByRole("heading", { name: "Create mailbox" });
    fetchMock.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Create mailbox" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.map((alert) => alert.textContent).join(" ")).toContain(
      "Local part",
    );
    expect(alerts.map((alert) => alert.textContent).join(" ")).toContain(
      "Domain ID",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.skip(
    "submits a whitespace-padded member UUID normalized by the endpoint schema (M2+ — MailboxMembers UI is hidden in M1, issue #21)",
    async () => {
    setAccessToken("access-token");
    const mailboxId = "11111111-1111-4111-8111-111111111111";
    const userId = "33333333-3333-4333-8333-333333333333";
    const fetchMock = vi
      .spyOn(window, "fetch")
      .mockImplementation((input, init) => {
        if (String(input).endsWith(`/mailboxes/${mailboxId}/members`)) {
          if (init?.method === "POST") {
            return Promise.resolve(
              Response.json(
                { data: { mailboxId, userId, role: "viewer" } },
                { status: 201 },
              ),
            );
          }
          return Promise.resolve(Response.json({ data: [] }));
        }
        return Promise.resolve(
          Response.json({
            data: [
              {
                id: mailboxId,
                address: "ops@example.com",
                display_name: "Operations",
                status: "active",
                domain_id: "22222222-2222-4222-8222-222222222222",
                role: "owner",
              },
            ],
          }),
        );
      });
    renderSettings("mailboxes");
    fireEvent.click(await screen.findByText("Manage sharing"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fetchMock.mockClear();

    fireEvent.change(screen.getByLabelText("Member user ID"), {
      target: { value: `  ${userId}  ` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Share mailbox" }));

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.find(
          ([url, init]) =>
            url === `/api/v1/mailboxes/${mailboxId}/members` &&
            init?.method === "POST",
        ),
      ).toBeDefined(),
    );
    const [url, init] =
      fetchMock.mock.calls.find(
        ([requestUrl, requestInit]) =>
          requestUrl === `/api/v1/mailboxes/${mailboxId}/members` &&
          requestInit?.method === "POST",
      ) ?? [];
    expect(url).toBe(`/api/v1/mailboxes/${mailboxId}/members`);
    expect(JSON.parse(String(init?.body))).toEqual({
      userId,
      role: "viewer",
    });
  });
});
