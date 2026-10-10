// CAP-065 mailbox sharing UI tests.
//
// The page consumes the already-implemented CAP-057 member API through the
// normal ApiClient and TanStack Query seams. The fetch harness captures the
// actual URL, method, headers, and JSON body so the tests prove the browser
// contract without mocking React Query or the page itself.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router';
import type { MailboxMemberItem } from '@unimailbox/contracts';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { errorResponse, jsonResponse } from '../../test-utils';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { mailboxQueryKeys } from './mailbox-queries';
import { MailboxMembersPage } from './MailboxMembersPage';

afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});

const SESSION = {
  userId: '00000000-0000-4000-8000-000000000001',
  email: 'owner@example.com',
  displayName: 'Mailbox Owner',
  expiresAt: '2099-01-01T00:00:00Z',
};

const MAILBOX_ID = '00000000-0000-4000-8000-000000000010';
const MEMBER_ID = '00000000-0000-4000-8000-000000000011';
const OTHER_MEMBER_ID = '00000000-0000-4000-8000-000000000012';
const membersPath = `/api/v1/mailboxes/${MAILBOX_ID}/members`;

const FIRST_MEMBER: MailboxMemberItem = {
  userId: MEMBER_ID,
  email: 'member@example.com',
  displayName: 'Member User',
  role: 'viewer',
  createdAt: '2026-08-31T00:00:00.000Z',
};

const SECOND_MEMBER: MailboxMemberItem = {
  userId: OTHER_MEMBER_ID,
  email: 'sender@example.com',
  displayName: null,
  role: 'sender',
  createdAt: '2026-08-31T00:01:00.000Z',
};

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

interface RouteHandler {
  readonly match: (url: string, method: string) => boolean;
  readonly response: () => Response | Promise<Response>;
}

function dispatchFetch(routes: ReadonlyArray<RouteHandler>): {
  readonly fetchImpl: typeof fetch;
  readonly calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers).entries()) {
      headers[key.toLowerCase()] = value;
    }
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      body = JSON.parse(init.body);
    }
    calls.push({ url, method, headers, body });
    const route = routes.find((candidate) => candidate.match(url, method));
    return route === undefined
      ? errorResponse('TEST_NO_ROUTE', `No route for ${method} ${url}`, 400)
      : route.response();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function sessionRoute(): RouteHandler {
  return {
    match: (url) => url.includes('/api/v1/auth/me'),
    response: () =>
      jsonResponse({
        data: {
          user: { id: SESSION.userId, email: SESSION.email, name: SESSION.displayName },
          session: { userId: SESSION.userId, expiresAt: SESSION.expiresAt },
        },
      }),
  };
}

function membersRoute(respond: () => Response | Promise<Response>): RouteHandler {
  return {
    match: (url, method) => url === membersPath && method === 'GET',
    response: respond,
  };
}

function addRoute(responses: ReadonlyArray<Response | Promise<Response>>): RouteHandler {
  let attempt = 0;
  return {
    match: (url, method) => url === membersPath && method === 'POST',
    response: () => {
      const response = responses[Math.min(attempt, responses.length - 1)];
      attempt += 1;
      if (response === undefined) {
        throw new Error('addRoute requires at least one response');
      }
      return response;
    },
  };
}

function removeRoute(
  memberId: string,
  responses: ReadonlyArray<Response | Promise<Response>>,
): RouteHandler {
  let attempt = 0;
  return {
    match: (url, method) => url === `${membersPath}/${memberId}` && method === 'DELETE',
    response: () => {
      const response = responses[Math.min(attempt, responses.length - 1)];
      attempt += 1;
      if (response === undefined) {
        throw new Error('removeRoute requires at least one response');
      }
      return response;
    },
  };
}

interface RenderMembersOptions {
  readonly routes: ReadonlyArray<RouteHandler>;
  readonly seedMembers?: ReadonlyArray<MailboxMemberItem>;
  readonly session?: typeof SESSION | null;
}

async function renderMembers(options: RenderMembersOptions): Promise<{
  readonly calls: CapturedRequest[];
  readonly queryClient: QueryClient;
}> {
  const { fetchImpl, calls } = dispatchFetch([sessionRoute(), ...options.routes]);
  const apiClient = createApiClient({ baseUrl: '', getSessionToken: () => null, fetchImpl });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(
    authQueryKeys.session(),
    options.session === undefined ? SESSION : options.session,
  );
  if (options.seedMembers !== undefined) {
    queryClient.setQueryData(mailboxQueryKeys.members(MAILBOX_ID, SESSION.userId), [
      ...options.seedMembers,
    ]);
  }

  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const membersRouteEntry = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId/members',
    component: () => <MailboxMembersPage mailboxId={MAILBOX_ID} />,
  });
  const inboxRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId',
    component: () => <div data-testid="arrived-inbox">Inbox</div>,
  });
  const loginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/login',
    component: () => <div data-testid="arrived-login">Login</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([membersRouteEntry, inboxRoute, loginRoute]),
    history: createMemoryHistory({ initialEntries: [`/mailbox/${MAILBOX_ID}/members`] }),
  });
  await router.load();

  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}

function getCalls(calls: ReadonlyArray<CapturedRequest>, method: string): CapturedRequest[] {
  return calls.filter((call) => call.method === method);
}

describe('MailboxMembersPage — CAP-065', () => {
  it('renders a busy skeleton while the member list is pending', async () => {
    await renderMembers({
      routes: [membersRoute(() => new Promise<Response>(() => {}))],
    });

    expect(screen.getByRole('status', { name: 'Loading…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByTestId('mailbox-member-form')).not.toBeInTheDocument();
  });

  it('R-AUTHZ-001 R-AUTHZ-004 R-DATA-004 loads a safe member projection in the requested mailbox namespace', async () => {
    const { calls } = await renderMembers({
      routes: [membersRoute(() => jsonResponse({ data: { items: [FIRST_MEMBER] } }))],
    });

    await waitFor(() => {
      expect(screen.getByTestId('mailbox-members-page')).toBeInTheDocument();
      expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toBeInTheDocument();
    });

    expect(screen.getByText('member@example.com')).toBeInTheDocument();
    expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toHaveTextContent('Member User');
    expect(screen.getByText('viewer')).toBeInTheDocument();
    expect(screen.queryByText(/password|credential|storage/i)).not.toBeInTheDocument();
    expect(getCalls(calls, 'GET')).toEqual(
      expect.arrayContaining([expect.objectContaining({ url: membersPath, method: 'GET' })]),
    );
  });

  it('R-API-002 renders an explicit empty state and preserves the member-management form', async () => {
    await renderMembers({
      routes: [membersRoute(() => jsonResponse({ data: { items: [] } }))],
    });

    await waitFor(() => expect(screen.getByTestId('mailbox-members-empty')).toBeInTheDocument());
    expect(screen.getByTestId('mailbox-member-form')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add member' })).toBeInTheDocument();
  });

  it('R-AUTHZ-003 surfaces a denied/not-found response without disclosing mailbox membership', async () => {
    await renderMembers({
      routes: [membersRoute(() => errorResponse('MAILBOX_NOT_FOUND', 'Mailbox not found', 404))],
    });

    await waitFor(() => expect(screen.getByTestId('mailbox-members-error')).toBeInTheDocument());
    expect(screen.getByTestId('error-code')).toHaveTextContent('MAILBOX_NOT_FOUND');
    expect(screen.getByTestId('mailbox-members-error')).not.toHaveTextContent('member@example.com');
  });

  it('R-API-002 normalizes a network failure to the stable NETWORK_ERROR error code', async () => {
    await renderMembers({
      routes: [membersRoute(() => Promise.reject(new TypeError('Failed to fetch')))],
    });

    await waitFor(() => expect(screen.getByTestId('mailbox-members-error')).toBeInTheDocument());
    expect(screen.getByTestId('error-code')).toHaveTextContent('NETWORK_ERROR');
  });

  it('keeps loaded members visible when a background refetch fails and offers retry', async () => {
    await renderMembers({
      seedMembers: [FIRST_MEMBER],
      routes: [membersRoute(() => errorResponse('TEMPORARY_FAILURE', 'Try again later', 400))],
    });

    await waitFor(() => {
      expect(screen.getByTestId('mailbox-member-list')).toBeInTheDocument();
      expect(screen.getByTestId('mailbox-members-error-banner')).toBeInTheDocument();
    });
    expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId('mailbox-members-banner-retry')).toBeInTheDocument();
  });

  it('R-DATA-001 blocks invalid add input without a POST', async () => {
    const { calls } = await renderMembers({
      routes: [membersRoute(() => jsonResponse({ data: { items: [] } }))],
    });
    await waitFor(() => expect(screen.getByTestId('mailbox-member-form')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Member email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(getCalls(calls, 'POST')).toHaveLength(0);
  });

  it('R-DATA-001 R-API-004 adds a normalized existing user with the selected role and clears on success', async () => {
    const { calls } = await renderMembers({
      routes: [
        membersRoute(() => jsonResponse({ data: { items: [] } })),
        addRoute([jsonResponse({ data: { ...FIRST_MEMBER, role: 'sender' } }, 201)]),
      ],
    });
    await waitFor(() => expect(screen.getByTestId('mailbox-member-form')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Member email'), '  MEMBER@EXAMPLE.COM ');
    await user.selectOptions(screen.getByLabelText('Member role'), 'sender');
    await user.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() =>
      expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toBeInTheDocument(),
    );
    const post = getCalls(calls, 'POST');
    expect(post).toHaveLength(1);
    expect(post[0]).toMatchObject({
      url: membersPath,
      body: { email: 'member@example.com', role: 'sender' },
    });
    expect(post[0]?.headers['idempotency-key']).toEqual(expect.any(String));
    expect(screen.getByLabelText('Member email')).toHaveValue('');
    expect(screen.getByLabelText('Member role')).toHaveValue('viewer');
    expect(screen.getByTestId('mailbox-members-success')).toHaveTextContent(
      'member@example.com was added to the mailbox.',
    );
  });

  it('disables the add form while a request is pending and prevents duplicate submits', async () => {
    let resolveAdd: (response: Response) => void = () => undefined;
    const pendingAdd = new Promise<Response>((resolve) => {
      resolveAdd = resolve;
    });
    const { calls } = await renderMembers({
      routes: [membersRoute(() => jsonResponse({ data: { items: [] } })), addRoute([pendingAdd])],
    });
    await waitFor(() => expect(screen.getByTestId('mailbox-member-form')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Member email'), 'member@example.com');
    await user.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
    });
    expect(getCalls(calls, 'POST')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Adding…' }));
    expect(getCalls(calls, 'POST')).toHaveLength(1);

    resolveAdd(jsonResponse({ data: FIRST_MEMBER }, 201));
    await waitFor(() =>
      expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toBeInTheDocument(),
    );
  });

  it('R-API-002 R-API-003 preserves add values and retries with a fresh mutation after failure', async () => {
    const { calls } = await renderMembers({
      routes: [
        membersRoute(() => jsonResponse({ data: { items: [] } })),
        addRoute([
          errorResponse('MAILBOX_MEMBER_USER_NOT_FOUND', 'Active user not found', 404),
          jsonResponse({ data: FIRST_MEMBER }, 201),
        ]),
      ],
    });
    await waitFor(() => expect(screen.getByTestId('mailbox-member-form')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Member email'), 'member@example.com');
    await user.selectOptions(screen.getByLabelText('Member role'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Add member' }));

    await waitFor(() => expect(screen.getByTestId('mailbox-member-add-error')).toBeInTheDocument());
    expect(screen.getByLabelText('Member email')).toHaveValue('member@example.com');
    expect(screen.getByLabelText('Member role')).toHaveValue('admin');
    expect(screen.getByTestId('error-code')).toHaveTextContent('MAILBOX_MEMBER_USER_NOT_FOUND');

    await user.click(screen.getByRole('button', { name: 'Retry add' }));
    await waitFor(() =>
      expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toBeInTheDocument(),
    );
    const posts = getCalls(calls, 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0]?.headers['idempotency-key']).not.toBe(posts[1]?.headers['idempotency-key']);
  });

  it('R-API-003 R-SECRET-003 requires confirmation and updates only the removed member on success', async () => {
    const { calls } = await renderMembers({
      routes: [
        membersRoute(() => jsonResponse({ data: { items: [FIRST_MEMBER, SECOND_MEMBER] } })),
        removeRoute(MEMBER_ID, [jsonResponse({ data: { removed: true, userId: MEMBER_ID } })]),
      ],
    });
    await waitFor(() => expect(screen.getByTestId('mailbox-member-list')).toBeInTheDocument());
    const user = userEvent.setup();
    const memberRow = screen.getByTestId(`mailbox-member-${MEMBER_ID}`);
    const removeButton = within(memberRow).getByRole('button', { name: 'Remove' });
    await user.click(removeButton);
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
    expect(getCalls(calls, 'DELETE')).toHaveLength(0);
    await user.click(screen.getByTestId('alert-dialog-cancel'));
    expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toBeInTheDocument();
    expect(removeButton).toHaveFocus();

    await user.click(removeButton);
    await user.click(screen.getByTestId('alert-dialog-confirm'));
    await waitFor(() =>
      expect(screen.queryByTestId(`mailbox-member-${MEMBER_ID}`)).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId(`mailbox-member-${OTHER_MEMBER_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId('mailbox-members-success')).toHaveTextContent(
      'member@example.com was removed from the mailbox.',
    );
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`mailbox-member-${OTHER_MEMBER_ID}`)).getByRole('button', {
          name: 'Remove',
        }),
      ).toHaveFocus(),
    );
    expect(getCalls(calls, 'DELETE')).toEqual([
      expect.objectContaining({ url: `${membersPath}/${MEMBER_ID}`, method: 'DELETE' }),
    ]);
  });

  it('R-API-002 R-API-003 keeps a member and exposes the remove error when deletion fails', async () => {
    await renderMembers({
      routes: [
        membersRoute(() => jsonResponse({ data: { items: [FIRST_MEMBER] } })),
        removeRoute(MEMBER_ID, [
          errorResponse('MAILBOX_MEMBER_NOT_FOUND', 'Member not found', 404),
        ]),
      ],
    });
    await waitFor(() =>
      expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(
      within(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).getByRole('button', {
        name: 'Remove',
      }),
    );
    await user.click(screen.getByTestId('alert-dialog-confirm'));

    await waitFor(() => expect(screen.getByTestId('alert-dialog-error')).toBeInTheDocument());
    expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toBeInTheDocument();
    expect(screen.getByTestId('alert-dialog-error')).toHaveTextContent('MAILBOX_MEMBER_NOT_FOUND');
  });

  it('cancels an in-flight member refetch before a successful removal updates the cache', async () => {
    let getCount = 0;
    let resolveRefresh: (response: Response) => void = () => undefined;
    const refresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const { queryClient } = await renderMembers({
      routes: [
        {
          match: (url, method) => url === membersPath && method === 'GET',
          response: () => {
            getCount += 1;
            return getCount === 1 ? jsonResponse({ data: { items: [FIRST_MEMBER] } }) : refresh;
          },
        },
        removeRoute(MEMBER_ID, [jsonResponse({ data: { removed: true, userId: MEMBER_ID } })]),
      ],
    });
    await waitFor(() =>
      expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toBeInTheDocument(),
    );

    const refreshPromise = queryClient.refetchQueries({
      queryKey: mailboxQueryKeys.members(MAILBOX_ID, SESSION.userId),
      exact: true,
    });
    await waitFor(() => expect(getCount).toBe(2));

    const user = userEvent.setup();
    await user.click(
      within(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).getByRole('button', {
        name: 'Remove',
      }),
    );
    await user.click(screen.getByTestId('alert-dialog-confirm'));
    await waitFor(() =>
      expect(screen.queryByTestId(`mailbox-member-${MEMBER_ID}`)).not.toBeInTheDocument(),
    );

    resolveRefresh(jsonResponse({ data: { items: [FIRST_MEMBER] } }));
    await refreshPromise;
    expect(screen.queryByTestId(`mailbox-member-${MEMBER_ID}`)).not.toBeInTheDocument();
  });

  it('rejects a remove response for a different member as INVALID_RESPONSE and keeps the row', async () => {
    await renderMembers({
      routes: [
        membersRoute(() => jsonResponse({ data: { items: [FIRST_MEMBER] } })),
        removeRoute(MEMBER_ID, [
          jsonResponse({ data: { removed: true, userId: OTHER_MEMBER_ID } }),
        ]),
      ],
    });
    await waitFor(() =>
      expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toBeInTheDocument(),
    );
    const user = userEvent.setup();
    await user.click(
      within(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).getByRole('button', {
        name: 'Remove',
      }),
    );
    await user.click(screen.getByTestId('alert-dialog-confirm'));

    await waitFor(() => expect(screen.getByTestId('alert-dialog-error')).toBeInTheDocument());
    expect(screen.getByTestId('alert-dialog-error')).toHaveTextContent('INVALID_RESPONSE');
    expect(screen.getByTestId(`mailbox-member-${MEMBER_ID}`)).toBeInTheDocument();
  });

  it('R-AUTHZ-003 shows the expired-session recovery surface without loading member data', async () => {
    await renderMembers({ session: null, routes: [] });

    await waitFor(() => expect(screen.getByTestId('expired-session')).toBeInTheDocument());
    expect(screen.getByTestId('unauthorized-login-button')).toBeInTheDocument();
    expect(screen.queryByTestId('mailbox-member-form')).not.toBeInTheDocument();
  });

  it('rejects an unexpected member projection field as INVALID_RESPONSE instead of rendering it', async () => {
    await renderMembers({
      routes: [
        membersRoute(() =>
          jsonResponse({
            data: {
              items: [{ ...FIRST_MEMBER, mailboxId: MAILBOX_ID }],
            },
          }),
        ),
      ],
    });

    await waitFor(() => expect(screen.getByTestId('mailbox-members-error')).toBeInTheDocument());
    expect(screen.getByTestId('error-code')).toHaveTextContent('INVALID_RESPONSE');
    expect(screen.queryByTestId(`mailbox-member-${MEMBER_ID}`)).not.toBeInTheDocument();
  });
});
