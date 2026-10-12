import { InboxListSkeleton } from '../../features/mailbox/InboxListSkeleton';
import { MailboxListSkeleton } from '../../features/mailbox/MailboxListSkeleton';
import { MessageDetailSkeleton } from '../../features/mailbox/MessageDetailSkeleton';
import { ContentSkeleton } from '../ui/ContentSkeleton';
import { Skeleton } from '../ui/shadcn/skeleton';
import { useT } from '../../infrastructure/i18n/locale';
/* Layout adapted from satnaing/shadcn-admin authenticated-layout/app-sidebar/header/nav-group/nav-user.
 * e16c87f213a5ba5e45964e9b67c792105ec74d26; MIT, Copyright (c) 2024 Sat Naing. */
import {
  Suspense,
  useEffect,
  useState,
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
  Clock,
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
  Sparkles,
} from 'lucide-react';
import { authSessionQuery } from '../../features/auth/auth-queries';
import { QuickSettings, UserAvatar } from '../../features/settings/QuickSettings';
import { AppearanceControls } from '../../features/settings/AppearanceControls';
import { usePersonalSettings } from '../../features/settings/personal-settings-context';
import {
  rememberMailbox,
  selectDefaultMailbox,
} from '../../infrastructure/preferences/default-mailbox';
import { mailboxListQuery } from '../../features/mailbox/mailbox-queries';
import { AppNav } from '../AppNav';
import { useComposer } from '../../features/mailbox/compose-window-context';
import { Button } from '../ui/shadcn/button';
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
    to: '/admin/ai',
    label: 'AI services',
    icon: Sparkles,
    description: 'Configure AI backends and email reply assistance.',
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
  { key: 'scheduled', label: 'Scheduled', icon: Clock },
  { key: 'archive', label: 'Archive', icon: Archive },
  { key: 'trash', label: 'Trash', icon: Trash2 },
] as const;
function Navigation({
  admin,
  openSettings,
}: {
  admin: boolean;
  openSettings: () => void;
}): ReactElement {
  const t = useT();
  const { setOpenMobile, isMobile } = useSidebar();
  const pathname = useLocation({ select: (location) => location.pathname });
  const search = useLocation({ select: (location) => location.search as { folder?: string } });
  const mailboxId = pathname.startsWith('/mailbox/') ? pathname.split('/')[2] : undefined;
  const session = authSessionQuery().data;
  const mailboxes = mailboxListQuery();
  const personal = usePersonalSettings();
  const activeMailboxes = mailboxes.data?.filter((item) => item.status === 'active') ?? [];
  const mailbox =
    activeMailboxes.find((item) => item.id === mailboxId) ??
    (session
      ? selectDefaultMailbox(
          activeMailboxes,
          session,
          personal.settings.preferences.defaultMailboxId,
        )
      : undefined);
  const navigationMailboxId = mailboxId ?? mailbox?.id;
  useEffect(() => {
    if (
      session &&
      mailboxId &&
      mailboxes.data?.some((item) => item.id === mailboxId && item.status === 'active')
    )
      rememberMailbox(session.userId, mailboxId);
  }, [session, mailboxId, mailboxes.data]);
  const composer = useComposer();
  const close = (): void => setOpenMobile(false);
  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  tooltip={t('Switch mailbox')}
                  aria-label={t('Switch mailbox')}
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                    <Mail className="size-5" />
                  </span>
                  <span className="grid min-w-0 flex-1 text-start">
                    <span className="truncate font-semibold">
                      {mailbox?.displayName || mailbox?.localPart || 'Unimailbox'}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {mailbox?.address ?? t('All mailboxes')}
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
                <DropdownMenuLabel>{t('Switch mailbox')}</DropdownMenuLabel>
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
                          <Check className="size-4 shrink-0" aria-label={t('Current mailbox')} />
                        ) : null}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </div>
                {mailboxes.isPending ? (
                  <div
                    role="status"
                    aria-label={t('Loading mailboxes')}
                    aria-busy="true"
                    className="space-y-2 p-2"
                  >
                    <Skeleton className="h-8 w-full" />
                    <Skeleton className="h-8 w-full" />
                  </div>
                ) : null}
                {mailboxes.isError ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      void mailboxes.refetch();
                    }}
                  >
                    {t('Retry loading mailboxes')}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/mailboxes" onClick={close}>
                    <Mail className="size-4" />
                    {t('All mailboxes ')}
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
        {mailbox ? (
          <Button
            className="sidebar-compose my-2 justify-start gap-3"
            size="lg"
            onClick={() => {
              composer?.open({ mailboxId: mailbox.id });
              close();
            }}
            aria-label={t('Compose')}
            title={t('Compose')}
          >
            <Plus className="size-5 shrink-0" />
            <span className="group-data-[collapsible=icon]:hidden">{t('Compose')}</span>
          </Button>
        ) : null}
        {isMobile ? (
          <Button variant="ghost" className="justify-start" onClick={close}>
            <X /> {t('Close navigation ')}
          </Button>
        ) : null}
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <nav aria-label={admin ? t('Administration navigation') : t('Mailbox navigation')}>
            <SidebarMenu>
              {admin ? (
                adminNavigation.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton
                      asChild
                      isActive={pathname === item.to}
                      tooltip={t(item.label)}
                    >
                      <Link to={item.to} onClick={close}>
                        <item.icon />
                        <span>{t(item.label)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))
              ) : (
                <>
                  {navigationMailboxId ? (
                    <>
                      {folders.map((item) => (
                        <SidebarMenuItem key={item.key}>
                          <SidebarMenuButton
                            asChild
                            tooltip={t(item.label)}
                            isActive={
                              pathname === `/mailbox/${navigationMailboxId}` &&
                              (search.folder ?? 'inbox') === item.key
                            }
                          >
                            <Link
                              to="/mailbox/$mailboxId"
                              params={{ mailboxId: navigationMailboxId }}
                              search={{ folder: item.key }}
                              onClick={close}
                            >
                              <item.icon />
                              <span>{t(item.label)}</span>
                            </Link>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
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
              <SidebarMenuButton asChild tooltip={t('Back to mailbox')}>
                <Link to="/mailbox" onClick={close}>
                  <ArrowLeft />
                  <span>{admin ? t('Back to mailbox') : t('All mailboxes')}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        ) : null}
        <button
          type="button"
          className="sidebar-identity text-start"
          onClick={openSettings}
          aria-label={t('Open account settings')}
        >
          <UserAvatar />
          <span className="truncate text-xs text-muted-foreground">
            {session?.email ?? 'Unimailbox'}
          </span>
        </button>
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
  const t = useT();
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <ShellContext.Provider value={true}>
      <SidebarProvider
        defaultOpen={!document.cookie.split('; ').includes('sidebar_state=false')}
        className="product-shell"
        data-testid={admin ? 'admin-layout' : 'mailbox-layout'}
      >
        <a href="#page-content" className="skip-link">
          {t('Skip to content')}
        </a>
        <Navigation admin={admin} openSettings={() => setSettingsOpen(true)} />
        <SidebarInset className="min-w-0">
          <header className="product-header">
            <SidebarTrigger />
            <div className="ms-auto flex items-center gap-2">
              {!admin ? <AppNav /> : null}
              <AppearanceControls />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t('Account menu')}
                onClick={() => setSettingsOpen(true)}
              >
                <UserAvatar />
              </Button>
            </div>
          </header>
          <div id="page-content" className="product-content" tabIndex={-1}>
            <Suspense fallback={<ShellPending admin={admin} />}>{children}</Suspense>
          </div>
        </SidebarInset>
        <QuickSettings open={settingsOpen} onOpenChange={setSettingsOpen} />
      </SidebarProvider>
    </ShellContext.Provider>
  );
}

function ShellPending({ admin }: { admin: boolean }): ReactElement {
  const pathname = useLocation({ select: (location) => location.pathname });
  if (admin) {
    return (
      <main className="admin-page">
        <ContentSkeleton
          variant={
            pathname === '/admin/settings' || pathname === '/admin/ai'
              ? 'form'
              : pathname === '/admin'
                ? 'overview'
                : 'list'
          }
        />
      </main>
    );
  }
  if (pathname === '/mailboxes') return <MailboxListSkeleton />;
  if (pathname.includes('/messages/')) return <MessageDetailSkeleton />;
  if (pathname.includes('/draft/'))
    return (
      <main className="mailbox-shell">
        <ContentSkeleton variant="compose" />
      </main>
    );
  return <InboxListSkeleton />;
}
