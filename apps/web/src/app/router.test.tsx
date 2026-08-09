import { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ADMINISTRATOR_PERMISSIONS } from "@unimailbox/contracts";
import { authKeys } from "../features/auth/api";
import { createI18nInstance } from "../i18n";
import { createAppRouter, safeLoginTarget } from "./router";

const ADMIN_SESSION = {
  userId: "user-1",
  email: "admin@example.com",
  permissions: [...ADMINISTRATOR_PERMISSIONS],
};

function routerAt(
  path: string,
  session:
    | typeof ADMIN_SESSION
    | { userId: string; email: string; permissions: string[] }
    | null = ADMIN_SESSION,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (session) queryClient.setQueryData(authKeys.session(), session);
  const history = createMemoryHistory({ initialEntries: [path] });
  return {
    history,
    queryClient,
    router: createAppRouter({ queryClient, history }),
  };
}

function apiError(code: string, status: number): Response {
  return new Response(
    JSON.stringify({
      error: { code, message: "never render this", requestId: "router-test" },
    }),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

function renderRouter(
  router: ReturnType<typeof createAppRouter>,
  queryClient: QueryClient,
) {
  return render(
    <I18nextProvider i18n={createI18nInstance("en")}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} context={{ queryClient }} />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("safe post-login destinations", () => {
  it.each([
    ["/admin/roles", "/admin/roles"],
    ["/messages/123?view=full", "/messages/123?view=full"],
    ["https://evil.example", "/inbox"],
    ["//evil.example", "/inbox"],
    ["/\\evil.example", "/inbox"],
    ["/admin\\users", "/inbox"],
    ["/login", "/inbox"],
    ["/register", "/inbox"],
  ])("maps %s to %s", (input, expected) => {
    expect(safeLoginTarget(input)).toBe(expected);
  });
});

describe("router memory history", () => {
  it("redirects a signed-in visitor from register while an anonymous visitor remains there", async () => {
    const signedIn = routerAt("/register");
    await signedIn.router.load();
    expect(signedIn.router.state.location.pathname).toBe("/inbox");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => apiError("AUTH_REQUIRED", 401)),
    );
    const anonymous = routerAt("/register", null);
    renderRouter(anonymous.router, anonymous.queryClient);
    expect(
      await screen.findByRole("heading", {
        name: "Sign in to your mail plane.",
      }),
    ).toBeVisible();
    expect(anonymous.router.state.location.pathname).toBe("/register");
  });

  it("redirects the protected settings index to the account section", async () => {
    const { router } = routerAt("/settings");
    await router.load();
    expect(router.state.location.pathname).toBe("/settings/account");
  });

  it.each(["cloudflare", "storage"])(
    "moves the legacy workspace %s route to administration settings",
    async (section) => {
      const { router } = routerAt(`/settings/${section}`);
      await router.load();
      expect(router.state.location.pathname).toBe("/admin/settings");
    },
  );

  it.each([
    "/inbox",
    "/sent",
    "/drafts",
    "/starred",
    "/archive",
    "/trash",
    "/settings/account",
    "/admin/users",
    "/admin/messages",
    "/admin/attachments",
    "/messages/message-1",
  ])("keeps an authenticated visitor on protected %s", async (path) => {
    const { router } = routerAt(path);
    await router.load();
    expect(router.state.location.pathname).toBe(path);
  });

  it("replaces a 401 protected route with login and preserves its safe target", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const path = String(input).replace(/^.*\/api\/v1/u, "");
        calls.push(path);
        return path === "/auth/session"
          ? apiError("AUTH_REQUIRED", 401)
          : apiError("REFRESH_TOKEN_REQUIRED", 401);
      }),
    );
    const { history, queryClient, router } = routerAt(
      "/messages/message-1",
      null,
    );
    const length = history.length;
    renderRouter(router, queryClient);
    expect(
      await screen.findByRole("heading", {
        name: "Sign in to your mail plane.",
      }),
    ).toBeVisible();
    expect(router.state.location.href).toBe(
      "/login?next=%2Fmessages%2Fmessage-1",
    );
    expect(history.length).toBe(length);
    expect(calls).not.toEqual([]);
    expect(
      calls.every(
        (path) => path === "/auth/session" || path === "/auth/refresh",
      ),
    ).toBe(true);
  });

  it("keeps a member on an admin route as a forbidden error instead of redirecting to login", async () => {
    // M1 surface (issue #21): /admin/users is unrouted; the equivalent
    // forbidden-error assertion runs against /admin/audit-events so the
    // contract stays pinned to a live route.
    const { queryClient, router } = routerAt("/admin/audit-events", {
      ...ADMIN_SESSION,
      permissions: ["message.read"],
    });
    renderRouter(router, queryClient);
    expect(
      await screen.findByText("You do not have access to this area"),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe("/admin/audit-events");
    expect(
      screen.getByText("This page requires the analytics.read permission."),
    ).toBeVisible();
  });

  it.skip(
    "does not let mailbox-scoped message.read open the global message route (M2+ — /admin/messages is hidden in M1, issue #21)",
  );

  it.skip(
    "lets a mailbox member open the attachment catalog without global message access (M2+ — /admin/attachments is hidden in M1, issue #21)",
  );

  it.each([
    [503, "BOOTSTRAP_INCOMPLETE"],
    [500, "INTERNAL_ERROR"],
  ])(
    "keeps a %i session failure on its protected URL",
    async (status, code) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => apiError(code, status)),
      );
      const { queryClient, router } = routerAt("/inbox", null);
      renderRouter(router, queryClient);
      expect(
        await screen.findByText(
          code === "BOOTSTRAP_INCOMPLETE"
            ? "Setup is not complete."
            : "Something went wrong.",
        ),
      ).toBeVisible();
      expect(router.state.location.pathname).toBe("/inbox");
    },
  );

  it("keeps an unknown path for the localized not-found boundary", async () => {
    const { queryClient, router } = routerAt("/not-a-route");
    renderRouter(router, queryClient);
    await router.load();
    expect(router.state.location.pathname).toBe("/not-a-route");
    expect(router.state.matches.at(-1)?.globalNotFound).toBe(true);
    expect(await screen.findByText("This page was not found")).toBeVisible();
  });

  it("keeps an unsupported settings section on its localized not-found route", async () => {
    const { queryClient, router } = routerAt("/settings/typo");
    renderRouter(router, queryClient);
    await router.load();
    expect(router.state.location.pathname).toBe("/settings/typo");
    expect(await screen.findByText("This page was not found")).toBeVisible();
  });

  it("follows browser back and forward through authenticated folder routes", async () => {
    const { history, router } = routerAt("/inbox");
    await router.load();
    await router.navigate({ to: "/sent" });
    expect(router.state.location.pathname).toBe("/sent");
    history.back();
    await router.load();
    expect(router.state.location.pathname).toBe("/inbox");
    history.forward();
    await router.load();
    expect(router.state.location.pathname).toBe("/sent");
  });
});
