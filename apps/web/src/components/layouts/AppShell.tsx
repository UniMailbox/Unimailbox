/* Layout adapted from satnaing/shadcn-admin authenticated-layout/app-sidebar/header/nav-group/nav-user.
 * e16c87f213a5ba5e45964e9b67c792105ec74d26; MIT, Copyright (c) 2024 Sat Naing. */
import {
  Suspense,
  useEffect,
  createContext,
  useContext,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Link, useLocation } from '@tanstack/react-router';
import {
  Archive,
  ArrowLeft,
  ChevronDown,
  Check,
  FilePenLine,
  Globe,
  Inbox,
  LayoutDashboard,
  Mail,
  Send,
  Shield,
  Signature,
  Trash2,
  Unplug,
  Users,
  Webhook,
  ScrollText,
  Plus,
  X,
  Settings2,
} from 'lucide-react';
import { authSessionQuery } from '../../features/auth/auth-queries';
import { LogoutButton } from '../../features/auth/LogoutButton';
import {
  rememberMailbox,
  selectDefaultMailbox,
} from '../../infrastructure/preferences/default-mailbox';
import { mailboxListQuery } from '../../features/mailbox/mailbox-queries';
import { AppNav } from '../AppNav';
import { ThemeSwitch } from '../ThemeSwitch';
import { Button } from '../ui/shadcn/button';
import { Avatar, AvatarFallback } from '../ui/shadcn/avatar';
import { Separator } from '../ui/shadcn/separator';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/shadcn/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from '../ui/shadcn/sidebar';
const ShellContext = createContext(false);
export function useInAppShell(): boolean {
  return useContext(ShellContext);
}
export const adminNavigation = [
  {
    to: '/admin',
    label: 'Overview',
    icon: LayoutDashboard,
    description: 'Manage your mail system.',
  },
  {
    to: '/admin/settings',
    label: 'Settings',
    icon: Settings2,
    description: 'Configure preferences for this deployment.',
  },
  {
    to: '/admin/users',
    label: 'Users',
    icon: Users,
    description: 'Manage accounts and mailbox access.',
  },
  {
    to: '/admin/connections',
    label: 'Connections',
    icon: Unplug,
    description: 'Manage your email service connections.',
  },
  {
    to: '/admin/webhook-events',
    label: 'Webhook events',
    icon: Webhook,
    description: 'Review delivery updates from your provider.',
  },
  {
    to: '/admin/audit-events',
    label: 'Audit events',
    icon: ScrollText,
    description: 'Review administrative activity.',
  },
  {
    to: '/admin/roles',
    label: 'Roles',
    icon: Shield,
    description: 'Define permissions for your team.',
  },
  {
    to: '/admin/signatures',
    label: 'Signatures',
    icon: Signature,
    description: 'Manage reusable email signatures.',
  },
  {
    to: '/admin/domains',
    label: 'Domains',
    icon: Globe,
    description: 'Configure receiving domains and routing.',
  },
] as const;
const folders = [
  { key: 'inbox', label: 'Inbox', icon: Inbox },
  { key: 'sent', label: 'Sent', icon: Send },
  { key: 'drafts', label: 'Drafts', icon: FilePenLine },
  { key: 'archive', label: 'Archive', icon: Archive },
  { key: 'trash', label: 'Trash', icon: Trash2 },
] as const;
function Navigation({ admin }: { admin: boolean }): ReactElement {
  const { setOpenMobile, isMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const search = useLocation({ select: (location) => location.search as { folder?: string } });
  const mailboxId = pathname.startsWith('/mailbox/') ? pathname.split('/')[2] : undefined;
  const session = authSessionQuery().data;
  const mailboxes = mailboxListQuery();
  const activeMailboxes = mailboxes.data?.filter((item) => item.status === 'active') ?? [];
  const mailbox =
    activeMailboxes.find((item) => item.id === mailboxId) ??
    (session ? selectDefaultMailbox(activeMailboxes, session) : undefined);
  useEffect(() => {
    if (
      session &&
      mailboxId &&
      mailboxes.data?.some((item) => item.id === mailboxId && item.status === 'active')
    )
      rememberMailbox(session.userId, mailboxId);
  }, [session, mailboxId, mailboxes.data]);
  const close = (): void => setOpenMobile(false);
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" tooltip="Switch mailbox" aria-label="Switch mailbox">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Mail className="size-5" />
                  </span>
                  <span className="grid min-w-0 flex-1 text-start">
                    <span className="truncate font-semibold">
                      {mailbox?.displayName || mailbox?.localPart || 'Unimailbox'}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {mailbox?.address ?? 'All mailboxes'}
                    </span>
                  </span>
                  <ChevronDown className="ms-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="bottom"
                align="start"
                className="w-72 max-w-[calc(100vw-2rem)]"
              >
                <DropdownMenuLabel>Switch mailbox</DropdownMenuLabel>
                <div className="max-h-[50svh] overflow-y-auto">
                  {activeMailboxes.map((item) => (
                    <DropdownMenuItem asChild key={item.id}>
                      <Link
                        to="/mailbox/$mailboxId"
                        params={{ mailboxId: item.id }}
                        search={{ folder: 'inbox' }}
                        onClick={() => {
                          if (session) rememberMailbox(session.userId, item.id);
                          close();
                        }}
                        className="min-w-0"
                      >
                        <Mail className="size-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{item.address}</span>
                        {item.id === mailbox?.id ? (
                          <Check className="size-4 shrink-0" aria-label="Current mailbox" />
                        ) : null}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </div>
                {mailboxes.isPending ? <DropdownMenuLabel>Loading…</DropdownMenuLabel> : null}
                {mailboxes.isError ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      void mailboxes.refetch();
                    }}
                  >
                    Retry loading mailboxes
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/mailboxes" onClick={close}>
                    <Mail className="size-4" />
                    All mailboxes
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
        {isMobile ? (
          <Button variant="ghost" className="justify-start" onClick={close}>
            <X /> Close navigation
          </Button>
        ) : null}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{admin ? 'Manage' : 'Mailbox'}</SidebarGroupLabel>
          <nav aria-label={admin ? 'Administration navigation' : 'Mailbox navigation'}>
            <SidebarMenu>
              {admin ? (
                adminNavigation.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild isActive={pathname === item.to} tooltip={item.label}>
                      <Link to={item.to} onClick={close}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))
              ) : (
                <>
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname === '/mailboxes'}
                      tooltip="All mailboxes"
                    >
                      <Link to="/mailboxes" onClick={close}>
                        <Mail />
                        <span>All mailboxes</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                  {mailboxId ? (
                    <>
                      <SidebarMenuItem>
                        <SidebarMenuButton asChild tooltip="Compose">
                          <Link
                            to="/mailbox/$mailboxId/compose"
                            params={{ mailboxId }}
                            onClick={close}
                          >
                            <Plus />
                            <span>Compose</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      {folders.map((item) => (
                        <SidebarMenuItem key={item.key}>
                          <SidebarMenuButton
                            asChild
                            tooltip={item.label}
                            isActive={
                              pathname === `/mailbox/${mailboxId}` &&
                              (search.folder ?? 'inbox') === item.key
                            }
                          >
                            <Link
                              to="/mailbox/$mailboxId"
                              params={{ mailboxId }}
                              search={{ folder: item.key }}
                              onClick={close}
                            >
                              <item.icon />
                              <span>{item.label}</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          asChild
                          tooltip="Members"
                          isActive={pathname.endsWith('/members')}
                        >
                          <Link
                            to="/mailbox/$mailboxId/members"
                            params={{ mailboxId }}
                            onClick={close}
                          >
                            <Users />
                            <span>Members</span>
                          </Link>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </>
                  ) : null}
                </>
              )}
            </SidebarMenu>
          </nav>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        {admin ? (
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Back to mailbox">
                <Link to="/mailbox" onClick={close}>
                  <ArrowLeft />
                  <span>{admin ? 'Back to mailbox' : 'All mailboxes'}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
        <div className="sidebar-identity">
          <Avatar className="size-8">
            <AvatarFallback>{session?.email?.slice(0, 1).toUpperCase() ?? 'U'}</AvatarFallback>
          </Avatar>
          <span className="truncate text-xs text-muted-foreground">
            {session?.email ?? 'Unimailbox'}
          </span>
        </div>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
export function AppShell({
  children,
  admin = false,
}: {
  children: ReactNode;
  admin?: boolean;
}): ReactElement {
  const session = authSessionQuery().data;
  const pathname = useLocation({ select: (location) => location.pathname });
  const title = admin
    ? (adminNavigation.find((item) => item.to === pathname)?.label ?? 'Administration')
    : 'Mailbox';
  return (
    <ShellContext.Provider value={true}>
      <SidebarProvider
        defaultOpen={!document.cookie.split('; ').includes('sidebar_state=false')}
        className="product-shell"
        data-testid={admin ? 'admin-layout' : 'mailbox-layout'}
      >
        <a href="#page-content" className="skip-link">
          Skip to content
        </a>
        <Navigation admin={admin} />
        <SidebarInset className="min-w-0">
          <header className="product-header">
            <SidebarTrigger />
            <Separator orientation="vertical" className="h-5" />
            <span className="text-sm text-muted-foreground">{title}</span>
            <div className="ms-auto flex items-center gap-2">
              {!admin ? <AppNav /> : null}
              <ThemeSwitch />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Account menu">
                    <Avatar className="size-8">
                      <AvatarFallback>
                        {session?.email?.slice(0, 1).toUpperCase() ?? 'U'}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-w-[calc(100vw-2rem)]">
                  <DropdownMenuLabel className="break-all">
                    {session?.email ?? 'Account'}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/change-password">Change password</Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <div className="p-1">
                    <LogoutButton />
                  </div>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </header>
          <div id="page-content" className="product-content" tabIndex={-1}>
            <Suspense
              fallback={
                <div role="status" className="space-y-4">
                  <span className="text-sm text-muted-foreground">Loading…</span>
                  <div className="h-40 animate-pulse rounded-lg bg-muted" />
                </div>
              }
            >
              {children}
            </Suspense>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </ShellContext.Provider>
  );
}
