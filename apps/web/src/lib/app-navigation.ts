import type { LucideIcon } from "lucide-react";
import {
  Activity,
  Archive,
  Cable,
  FilePenLine,
  Globe2,
  Inbox,
  KeyRound,
  Mail,
  Paperclip,
  Palette,
  ScrollText,
  Send,
  Settings2,
  Shield,
  Star,
  Trash2,
  Users,
  Webhook,
  Bot,
} from "lucide-react";
import {
  ADMIN_RESOURCE_PERMISSIONS,
  type AdminResourceKey,
  type PermissionKey,
} from "@unimailbox/contracts";
import type { MailFolder } from "../features/mail/api";
import type { SettingsSection } from "../features/settings/sections";

export type NavigationGroupId = "workspace" | "settings" | "administration";

export interface NavigationLeaf {
  id: string;
  href: string;
  labelKey: string;
  icon: LucideIcon;
  requiredPermissions?: readonly PermissionKey[];
  isActive: (pathname: string) => boolean;
}

export interface NavigationGroup {
  id: NavigationGroupId;
  labelKey: string;
  icon: LucideIcon;
  children: NavigationLeaf[];
}

export interface NavigationModelOptions {
  pathname: string;
  mailboxId?: string | null;
  permissions?: readonly PermissionKey[];
}

export const WORKSPACE_FOLDER_IDS = [
  "inbox",
  "sent",
  "drafts",
  "starred",
  "archive",
  "trash",
] as const satisfies readonly MailFolder[];

export const WORKSPACE_FOLDER_NAVIGATION: ReadonlyArray<{
  id: MailFolder;
  labelKey: string;
  icon: LucideIcon;
}> = [
  { id: "inbox", labelKey: "mail:folders.inbox", icon: Inbox },
  { id: "sent", labelKey: "mail:folders.sent", icon: Send },
  { id: "drafts", labelKey: "mail:folders.drafts", icon: FilePenLine },
  { id: "starred", labelKey: "mail:folders.starred", icon: Star },
  { id: "archive", labelKey: "mail:folders.archive", icon: Archive },
  { id: "trash", labelKey: "mail:folders.trash", icon: Trash2 },
];

const ADMIN_NAVIGATION: ReadonlyArray<{
  id: AdminResourceKey;
  labelKey: string;
  icon: LucideIcon;
}> = [
  { id: "messages", labelKey: "admin:navigation.messages", icon: Mail },
  {
    id: "attachments",
    labelKey: "admin:navigation.attachments",
    icon: Paperclip,
  },
  { id: "users", labelKey: "admin:navigation.users", icon: Users },
  { id: "roles", labelKey: "admin:navigation.roles", icon: Shield },
  { id: "domains", labelKey: "admin:navigation.domains", icon: Globe2 },
  {
    id: "signatures",
    labelKey: "admin:navigation.signatures",
    icon: ScrollText,
  },
  {
    id: "settings",
    labelKey: "admin:navigation.settings",
    icon: Settings2,
  },
  {
    id: "provider-connections",
    labelKey: "admin:navigation.provider-connections",
    icon: Cable,
  },
  {
    id: "webhook-events",
    labelKey: "admin:navigation.webhook-events",
    icon: Webhook,
  },
  {
    id: "audit-events",
    labelKey: "admin:navigation.audit-events",
    icon: KeyRound,
  },
  { id: "analytics", labelKey: "admin:navigation.analytics", icon: Activity },
];

const SETTINGS_NAVIGATION: ReadonlyArray<{
  id: SettingsSection;
  labelKey: string;
  icon: LucideIcon;
}> = [
  {
    id: "account",
    labelKey: "settings:tabs.account",
    icon: KeyRound,
  },
  {
    id: "mailboxes",
    labelKey: "settings:tabs.mailboxes",
    icon: Mail,
  },
  {
    id: "preferences",
    labelKey: "settings:tabs.preferences",
    icon: Palette,
  },
  {
    id: "mcp",
    labelKey: "settings:tabs.mcp",
    icon: Bot,
  },
];

function pathStartsAt(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function folderPath(
  folder: MailFolder,
  mailboxId?: string | null,
): string {
  if (folder === "drafts" || folder === "starred") return `/${folder}`;
  return mailboxId ? `/${folder}/${mailboxId}` : `/${folder}`;
}

export function isFolderPathActive(
  folder: MailFolder,
  pathname: string,
): boolean {
  return pathStartsAt(pathname, `/${folder}`);
}

export function hasNavigationPermissions(
  requiredPermissions: readonly PermissionKey[] | undefined,
  permissions: readonly PermissionKey[] = [],
): boolean {
  if (!requiredPermissions?.length) return true;
  const granted = new Set<PermissionKey>(permissions);
  return requiredPermissions.every((permission) => granted.has(permission));
}

function makeWorkspaceLeaves(
  mailboxId?: string | null,
  permissions: readonly PermissionKey[] = [],
): NavigationLeaf[] {
  return WORKSPACE_FOLDER_NAVIGATION.map((item) => ({
    ...item,
    requiredPermissions: undefined,
    href: folderPath(item.id, mailboxId),
    isActive: (currentPathname: string) =>
      isFolderPathActive(item.id, currentPathname),
  })).filter((leaf) =>
    hasNavigationPermissions(leaf.requiredPermissions, permissions),
  );
}

function makeSettingsLeaves(
  permissions: readonly PermissionKey[] = [],
): NavigationLeaf[] {
  return SETTINGS_NAVIGATION.map((item) => ({
    ...item,
    requiredPermissions: undefined,
    href: `/settings/${item.id}`,
    isActive: (pathname: string) => pathname === `/settings/${item.id}`,
  })).filter((leaf) =>
    hasNavigationPermissions(leaf.requiredPermissions, permissions),
  );
}

function makeAdminLeaves(
  permissions: readonly PermissionKey[] = [],
): NavigationLeaf[] {
  return ADMIN_NAVIGATION.map((item) => ({
    ...item,
    href: `/admin/${item.id}`,
    requiredPermissions: [ADMIN_RESOURCE_PERMISSIONS[item.id]],
    isActive: (pathname: string) => pathStartsAt(pathname, `/admin/${item.id}`),
  })).filter((leaf) =>
    hasNavigationPermissions(leaf.requiredPermissions, permissions),
  );
}

/**
 * The authenticated navigation tree. This is the only source for labels,
 * icons, paths, active matching, and presentation-level permission filtering.
 * API authorization remains authoritative for every page and mutation.
 */
export function getNavigationModel({
  pathname,
  mailboxId,
  permissions = [],
}: NavigationModelOptions): NavigationGroup[] {
  // The pathname is part of the model input so callers can build one stable
  // tree for a route; leaf matchers intentionally remain reusable predicates.
  void pathname;
  const groups: NavigationGroup[] = [
    {
      id: "workspace",
      labelKey: "mail:navigation.workspace",
      icon: Inbox,
      children: makeWorkspaceLeaves(mailboxId, permissions),
    },
    {
      id: "settings",
      labelKey: "mail:navigation.settings",
      icon: Settings2,
      children: makeSettingsLeaves(permissions),
    },
    {
      id: "administration",
      labelKey: "admin:title",
      icon: Shield,
      children: makeAdminLeaves(permissions),
    },
  ];

  return groups.filter((group) => group.children.length > 0);
}

export function isNavigationGroupActive(
  group: NavigationGroup,
  pathname: string,
): boolean {
  return group.children.some((child) => child.isActive(pathname));
}

export function findNavigationLeaf(
  pathname: string,
  options: Omit<NavigationModelOptions, "pathname"> = {},
): NavigationLeaf | undefined {
  return getNavigationModel({ pathname, ...options })
    .flatMap((group) => group.children)
    .find((leaf) => leaf.isActive(pathname));
}

export function firstNavigationHref(
  options: Omit<NavigationModelOptions, "pathname"> = {},
): string {
  const first = getNavigationModel({ pathname: "/", ...options }).flatMap(
    (group) => group.children,
  )[0];
  return first?.href ?? "/inbox";
}

export function isAuthenticatedMailPath(pathname: string): boolean {
  return (
    WORKSPACE_FOLDER_IDS.some((folder) =>
      pathStartsAt(pathname, `/${folder}`),
    ) || pathStartsAt(pathname, "/messages")
  );
}
