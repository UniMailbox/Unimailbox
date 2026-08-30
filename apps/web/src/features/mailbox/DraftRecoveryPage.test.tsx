import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { jsonResponse, errorResponse } from '../../test-utils';
import {
  DRAFT_CACHE_DATABASE_NAME,
  getDraftWorkingCopy,
  markDraftWorkingCopySynced,
  saveDraftWorkingCopy,
} from '../../lib/draft-cache';
import { DraftRecoveryPage } from './DraftRecoveryPage';

const SESSION = {
  userId: 'user-a',
  email: 'a@example.test',
  displayName: 'User A',
  expiresAt: '2099-01-01T00:00:00Z',
};
const MAILBOX_ID = '00000000-0000-4000-8000-000000000001';
const DRAFT_ID = '00000000-0000-4000-8000-000000000002';
const SERVER_UPDATED_AT = '2026-08-30T10:00:00.000Z';

const SERVER_DRAFT = {
  id: DRAFT_ID,
  mailboxId: MAILBOX_ID,
  subject: 'Server subject',
  body_text: 'Server text',
  body_html: '<p>Server HTML</p>',
  to: ['to@example.test'],
  cc: [],
  bcc: [],
  status: 'draft' as const,
  created_at: '2026-08-30T09:00:00.000Z',
  updated_at: SERVER_UPDATED_AT,
};

const LOCAL_COPY = {
  userId: SESSION.userId,
  mailboxId: MAILBOX_ID,
  draftId: DRAFT_ID,
  to: ['to@example.test'],
  cc: [],
  bcc: [],
  subject: 'Local subject',
  textBody: 'Local text',
  htmlBody: '<p>Local HTML</p>',
};

afterEach(async () => {
  cleanup();
  resetAuthSessionForTesting();
  await Dexie.delete(DRAFT_CACHE_DATABASE_NAME);
});

function renderPage(
  options: {
    readonly session?: typeof SESSION | null;
    readonly draftResponse?: Response;
  } = {},
): string[] {
  const session = options.session === undefined ? SESSION : options.session;
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    if (url.includes('/api/v1/auth/better/get-session')) {
      return session === null
        ? jsonResponse({ data: { user: null, session: null } })
        : jsonResponse({
            data: {
              user: { id: session.userId, email: session.email, name: session.displayName },
              session: { userId: session.userId, expiresAt: session.expiresAt },
            },
          });
    }
    if (url.startsWith(`/api/v1/drafts/${DRAFT_ID}?mailboxId=`)) {
      return options.draftResponse ?? jsonResponse({ data: SERVER_DRAFT });
    }
    return errorResponse('TEST_NO_ROUTE', `no route for ${url}`, 400);
  }) as unknown as typeof fetch;
  const apiClient = createApiClient({ baseUrl: '', getSessionToken: () => null, fetchImpl });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
  });
  queryClient.setQueryData(authQueryKeys.session(), session);
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <DraftRecoveryPage mailboxId={MAILBOX_ID} draftId={DRAFT_ID} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return calls;
}

async function seedLocalCopy(
  baseServerUpdatedAt: string | null = SERVER_UPDATED_AT,
): Promise<void> {
  const saved = await saveDraftWorkingCopy({ ...LOCAL_COPY, subject: 'Server subject' });
  if (baseServerUpdatedAt !== null) {
    await markDraftWorkingCopySynced(
      SESSION.userId,
      MAILBOX_ID,
      DRAFT_ID,
      baseServerUpdatedAt,
      saved.revision,
    );
  }
  await saveDraftWorkingCopy(LOCAL_COPY);
}

describe('DraftRecoveryPage — CAP-062', () => {
  it('R-MESSAGE-010/R-API-002 renders the server draft when no local copy exists', async () => {
    const calls = renderPage();
    await waitFor(() => expect(screen.getByTestId('draft-recovery-page')).toBeInTheDocument());

    expect(calls).toContain(`/api/v1/drafts/${DRAFT_ID}?mailboxId=${MAILBOX_ID}`);
    expect(screen.getByTestId('draft-subject')).toHaveTextContent('Server subject');
    expect(screen.getByTestId('draft-text-body')).toHaveTextContent('Server text');
    expect(screen.queryByTestId('draft-local-ahead')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recover-local')).not.toBeInTheDocument();
  });

  it('R-MESSAGE-010 shows a same-base local revision only after explicit recovery', async () => {
    await seedLocalCopy();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('draft-local-ahead')).toBeInTheDocument());
    expect(screen.getByTestId('draft-subject')).toHaveTextContent('Server subject');

    await userEvent.setup().click(screen.getByTestId('recover-local'));
    expect(screen.getByTestId('draft-subject')).toHaveTextContent('Local subject');
    expect(screen.getByTestId('draft-text-body')).toHaveTextContent('Local text');
  });

  it('R-MESSAGE-010 requires an explicit server choice when the base version changed', async () => {
    await seedLocalCopy('2026-08-30T09:00:00.000Z');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('draft-server-changed')).toBeInTheDocument());
    expect(screen.getByTestId('draft-subject')).toHaveTextContent('Server subject');

    await userEvent.setup().click(screen.getByTestId('load-server'));
    await waitFor(() =>
      expect(screen.queryByTestId('draft-server-changed')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('draft-subject')).toHaveTextContent('Server subject');
  });

  it('R-MESSAGE-010 removes only the selected user/mailbox/draft cache row', async () => {
    await seedLocalCopy('2026-08-30T09:00:00.000Z');
    await saveDraftWorkingCopy({ ...LOCAL_COPY, draftId: '00000000-0000-4000-8000-000000000003' });
    await saveDraftWorkingCopy({
      ...LOCAL_COPY,
      userId: 'user-b',
      draftId: '00000000-0000-4000-8000-000000000004',
    });
    renderPage();
    await waitFor(() => expect(screen.getByTestId('draft-server-changed')).toBeInTheDocument());

    await userEvent.setup().click(screen.getByTestId('load-server'));
    await waitFor(async () => {
      await expect(getDraftWorkingCopy(SESSION.userId, MAILBOX_ID, DRAFT_ID)).resolves.toBeNull();
    });
    await expect(
      getDraftWorkingCopy(SESSION.userId, MAILBOX_ID, '00000000-0000-4000-8000-000000000003'),
    ).resolves.not.toBeNull();
    await expect(
      getDraftWorkingCopy('user-b', MAILBOX_ID, '00000000-0000-4000-8000-000000000004'),
    ).resolves.not.toBeNull();
  });

  it('R-API-002 exposes a typed retry surface for a missing server draft', async () => {
    renderPage({ draftResponse: errorResponse('MESSAGE_NOT_FOUND', 'Draft not found', 404) });
    await waitFor(() => expect(screen.getByTestId('draft-recovery-error')).toBeInTheDocument());
    expect(screen.getByTestId('error-code')).toHaveTextContent('MESSAGE_NOT_FOUND');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('R-SECRET-003/R-DATA-004 rejects storage-only response fields without rendering them', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      renderPage({
        draftResponse: jsonResponse({
          data: { ...SERVER_DRAFT, objectKey: 'secret-object-key', accessToken: 'secret-token' },
        }),
      });
      await waitFor(() => expect(screen.getByTestId('draft-recovery-error')).toBeInTheDocument());
      expect(screen.queryByText('secret-object-key')).not.toBeInTheDocument();
      expect(screen.queryByText('secret-token')).not.toBeInTheDocument();
      const consoleText = [...log.mock.calls, ...warn.mock.calls, ...error.mock.calls]
        .flat()
        .join(' ');
      expect(consoleText).not.toContain('secret-object-key');
      expect(consoleText).not.toContain('secret-token');
    } finally {
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('R-AUTHZ-004/R-DATA-004 never renders a draft under a mismatched mailbox path', async () => {
    renderPage({
      draftResponse: jsonResponse({
        data: { ...SERVER_DRAFT, mailboxId: '00000000-0000-4000-8000-000000000099' },
      }),
    });
    await waitFor(() => expect(screen.getByTestId('draft-recovery-error')).toBeInTheDocument());
    expect(screen.getByTestId('error-code')).toHaveTextContent('MESSAGE_NOT_FOUND');
    expect(screen.queryByTestId('draft-subject')).not.toBeInTheDocument();
  });

  it('R-DATA-004 never renders a different draft returned for the requested resource', async () => {
    renderPage({
      draftResponse: jsonResponse({
        data: { ...SERVER_DRAFT, id: '00000000-0000-4000-8000-000000000099' },
      }),
    });
    await waitFor(() => expect(screen.getByTestId('draft-recovery-error')).toBeInTheDocument());
    expect(screen.getByTestId('error-code')).toHaveTextContent('MESSAGE_NOT_FOUND');
    expect(screen.queryByText('Server subject')).not.toBeInTheDocument();
  });

  it('R-API-002 shows a loading state while the server draft request is pending', () => {
    renderPage();
    expect(screen.getByTestId('draft-recovery-loading')).toBeInTheDocument();
  });

  it('R-AUTHZ-003 renders the expired-session state when the session disappears', async () => {
    const calls: string[] = [];
    const apiClient = createApiClient({
      baseUrl: '',
      getSessionToken: () => null,
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(typeof input === 'string' ? input : input.toString());
        return jsonResponse({ data: { user: null, session: null } });
      }) as typeof fetch,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
    });
    queryClient.setQueryData(authQueryKeys.session(), null);
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const pageRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/draft',
      component: () => <DraftRecoveryPage mailboxId={MAILBOX_ID} draftId={DRAFT_ID} />,
    });
    const loginRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: '/login',
      component: () => <div data-testid="arrived-login">login</div>,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([pageRoute, loginRoute]),
      history: createMemoryHistory({ initialEntries: ['/draft'] }),
    });
    await router.load();
    render(
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <RouterProvider router={router} />
        </ApiClientProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('expired-session')).toBeInTheDocument());
    expect(calls.some((url) => url.includes('/api/v1/drafts/'))).toBe(false);
  });
});
