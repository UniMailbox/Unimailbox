import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  createBrowserHistory,
  Outlet,
  redirect,
  notFound,
  type RouterHistory,
  useParams,
} from "@tanstack/react-router";
import type { QueryClient } from "@tanstack/react-query";
import { ADMIN_RESOURCE_PERMISSIONS } from "@unimailbox/contracts";
import { ApiClientError } from "../lib/api";
import { sessionQueryOptions } from "../features/auth/api";
import { LoginPage } from "../features/auth/LoginPage";
import { MailWorkspace } from "../features/mail/MailWorkspace";
import { MessagePage } from "../features/mail/MessagePage";
import { AdminPage } from "../features/admin/AdminPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import {
  isSettingsSection,
  type SettingsSection,
} from "../features/settings/sections";
import {
  ForbiddenRouteError,
  RouteErrorBoundary,
  RouteNotFoundBoundary,
} from "../routes/boundaries";
import { App } from "../App";
import { WORKSPACE_FOLDER_IDS } from "../lib/app-navigation";
import { AuthenticatedShell } from "../components/AuthenticatedShell";

export interface RouterContext {
  queryClient: QueryClient;
}
export const DEFAULT_AFTER_LOGIN = "/inbox";

export function safeLoginTarget(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/"))
    return DEFAULT_AFTER_LOGIN;
  if (/^\/[/\\\\]/u.test(value) || value.includes("\\"))
    return DEFAULT_AFTER_LOGIN;
  if (/^\/(login|register)(?:\/|\?|$)/u.test(value)) return DEFAULT_AFTER_LOGIN;
  return value;
}

function loginSearch(search: Record<string, unknown>) {
  return {
    next:
      safeLoginTarget(search.next) === DEFAULT_AFTER_LOGIN
        ? undefined
        : safeLoginTarget(search.next),
  };
}

function AuthenticatedLayout() {
  return (
    <AuthenticatedShell>
      <Outlet />
    </AuthenticatedShell>
  );
}

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: App,
  errorComponent: RouteErrorBoundary,
  notFoundComponent: RouteNotFoundBoundary,
});

async function redirectIfSignedIn({
  context,
  search,
}: {
  context: RouterContext;
  search: ReturnType<typeof loginSearch>;
}) {
  try {
    await context.queryClient.ensureQueryData(sessionQueryOptions());
    throw redirect({ to: safeLoginTarget(search.next), replace: true });
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 401) return;
    throw error;
  }
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "login",
  validateSearch: loginSearch,
  beforeLoad: redirectIfSignedIn,
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "register",
  validateSearch: loginSearch,
  beforeLoad: redirectIfSignedIn,
  component: LoginPage,
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup",
  beforeLoad: () => {
    throw redirect({ to: "/login", replace: true });
  },
});
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/inbox", replace: true });
  },
});

const authenticatedRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "authenticated",
  component: AuthenticatedLayout,
  beforeLoad: async ({ context, location }) => {
    try {
      return {
        session: await context.queryClient.ensureQueryData(
          sessionQueryOptions(),
        ),
      };
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 401) {
        throw redirect({
          to: "/login",
          search: { next: safeLoginTarget(location.href) },
          replace: true,
        });
      }
      throw error;
    }
  },
});

function FolderRoute({
  folder,
}: {
  folder: (typeof WORKSPACE_FOLDER_IDS)[number];
}) {
  const { mailboxId } = useParams({ strict: false }) as { mailboxId?: string };
  return <MailWorkspace folder={folder} routeMailboxId={mailboxId} />;
}
function MessageRoute() {
  const { messageId } = useParams({ strict: false }) as { messageId: string };
  return <MessagePage messageId={messageId} />;
}
function AdminRoute() {
  const { resource } = useParams({ strict: false }) as {
    resource: keyof typeof ADMIN_RESOURCE_PERMISSIONS;
  };
  return <AdminPage resource={resource} />;
}
function SettingsRoute() {
  const { section } = useParams({ strict: false }) as {
    section: SettingsSection;
  };
  return <SettingsPage section={section} />;
}
const folderRoutes = WORKSPACE_FOLDER_IDS.flatMap((folder) => [
  createRoute({
    getParentRoute: () => authenticatedRoute,
    path: folder,
    component: () => <FolderRoute folder={folder} />,
  }),
  createRoute({
    getParentRoute: () => authenticatedRoute,
    path: `${folder}/$mailboxId`,
    component: () => <FolderRoute folder={folder} />,
  }),
]);
const messageRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "messages/$messageId",
  component: MessageRoute,
});
// M1 admin surface (issue #21): only domains / settings / audit-events
// are reachable; any other resource 404s so deep links don't render a
// dormant admin tab. The complete resource map stays defined in
// `ADMIN_RESOURCE_PERMISSIONS` so a future milestone can flip them back
// on by extending this set.
const MVP_ADMIN_RESOURCES = new Set<keyof typeof ADMIN_RESOURCE_PERMISSIONS>([
  "domains",
  "settings",
  "audit-events",
]);

const adminRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "admin/$resource",
  beforeLoad: ({ context, params }) => {
    if (!(params.resource in ADMIN_RESOURCE_PERMISSIONS)) throw notFound();
    const resource = params.resource as keyof typeof ADMIN_RESOURCE_PERMISSIONS;
    if (!MVP_ADMIN_RESOURCES.has(resource)) throw notFound();
    const permission = ADMIN_RESOURCE_PERMISSIONS[resource];
    if (!context.session.permissions.includes(permission))
      throw new ForbiddenRouteError(permission);
  },
  component: AdminRoute,
});
const settingsRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "settings/$section",
  beforeLoad: ({ params }) => {
    if (params.section === "cloudflare" || params.section === "storage") {
      throw redirect({ to: "/admin/settings", replace: true });
    }
    if (!isSettingsSection(params.section)) throw notFound();
  },
  component: SettingsRoute,
});
const settingsIndexRoute = createRoute({
  getParentRoute: () => authenticatedRoute,
  path: "settings",
  beforeLoad: () => {
    throw redirect({ to: "/settings/account", replace: true });
  },
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  setupRoute,
  loginRoute,
  registerRoute,
  authenticatedRoute.addChildren([
    ...folderRoutes,
    messageRoute,
    adminRoute,
    settingsRoute,
    settingsIndexRoute,
  ]),
]);

export function createAppRouter({
  queryClient,
  history,
}: {
  queryClient: QueryClient;
  history?: RouterHistory;
}) {
  return createRouter({
    routeTree,
    context: { queryClient },
    history: history ?? createBrowserHistory(),
  });
}
