import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

interface RequestLog {
  readonly url: string;
  readonly init: RequestInit;
}

const requestLog: RequestLog[] = [];

afterEach(async () => {
  cleanup();
  requestLog.length = 0;
  vi.useRealTimers();
  resetAuthSessionForTesting();
  await Dexie.delete(DRAFT_CACHE_DATABASE_NAME);
});

function renderPage(
  options: {
    readonly session?: typeof SESSION | null;
    readonly draftResponse?: Response;
    readonly draftResponses?: ReadonlyArray<Response>;
    readonly patchResponse?: Response;
    readonly patchResponseFactory?: (
      body: Partial<typeof SERVER_DRAFT>,
      attempt: number,
    ) => Response | Promise<Response>;
  } = {},
): string[] {
  const session = options.session === undefined ? SESSION : options.session;
  const calls: string[] = [];
  let draftReadCount = 0;
  let patchCount = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push(url);
    requestLog.push({ url, init: init ?? {} });
    if (url.includes('/api/v1/auth/me')) {
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
      const response = options.draftResponses?.[draftReadCount] ?? options.draftResponse;
      draftReadCount += 1;
      return response ?? jsonResponse({ data: SERVER_DRAFT });
    }
    if (url === `/api/v1/drafts/${DRAFT_ID}` && init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body)) as Partial<typeof SERVER_DRAFT>;
      if (options.patchResponseFactory !== undefined) {
        const response = options.patchResponseFactory(body, patchCount);
        patchCount += 1;
        return await response;
      }
      return (
        options.patchResponse ??
        jsonResponse({
          data: {
            ...SERVER_DRAFT,
            ...body,
            updated_at: '2026-08-30T10:01:00.000Z',
          },
        })
      );
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
    expect(screen.getByLabelText('Subject')).toHaveValue('Server subject');
    expect(screen.getByLabelText('Body')).toHaveValue('Server text');
    expect(screen.queryByTestId('draft-local-ahead')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recover-local')).not.toBeInTheDocument();
  });

  it('R-MESSAGE-010 shows a same-base local revision only after explicit recovery', async () => {
    await seedLocalCopy();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('draft-local-ahead')).toBeInTheDocument());
    expect(screen.getByLabelText('Subject')).toHaveValue('Server subject');

    await userEvent.setup().click(screen.getByTestId('recover-local'));
    expect(screen.getByLabelText('Subject')).toHaveValue('Local subject');
    expect(screen.getByLabelText('Body')).toHaveValue('Local text');
  });

  it('R-MESSAGE-010 requires an explicit server choice when the base version changed', async () => {
    await seedLocalCopy('2026-08-30T09:00:00.000Z');
    renderPage();
    await waitFor(() => expect(screen.getByTestId('draft-server-changed')).toBeInTheDocument());
    expect(screen.getByLabelText('Subject')).toHaveValue('Server subject');

    await userEvent.setup().click(screen.getByTestId('load-server'));
    await waitFor(() =>
      expect(screen.queryByTestId('draft-server-changed')).not.toBeInTheDocument(),
    );
    expect(screen.getByLabelText('Subject')).toHaveValue('Server subject');
  });

  it('CAP-064 requires an explicit recovery decision before editing a dirty local copy', async () => {
    await seedLocalCopy();
    renderPage();
    await waitFor(() => expect(screen.getByTestId('draft-local-ahead')).toBeInTheDocument());

    expect(screen.getByLabelText('Subject')).toBeDisabled();
    await userEvent.setup().click(screen.getByTestId('recover-local'));
    expect(screen.getByLabelText('Subject')).toBeEnabled();
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

  it('CAP-064 renders editable recipient, subject, and plain-text body controls', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('draft-editor-form')).toBeInTheDocument());

    expect(screen.getByLabelText('To')).toHaveValue('to@example.test');
    expect(screen.getByLabelText('Cc')).toHaveValue('');
    expect(screen.getByLabelText('Bcc')).toHaveValue('');
    expect(screen.getByLabelText('Subject')).toHaveValue('Server subject');
    expect(screen.getByLabelText('Body')).toHaveValue('Server text');
  });

  it('R-API-004 debounces the latest edit into a PATCH with If-Match and a client idempotency key', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('draft-editor-form')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Changed subject' } });
    expect(requestLog.filter((request) => request.init.method === 'PATCH')).toHaveLength(0);

    await waitFor(
      () => expect(requestLog.some((request) => request.init.method === 'PATCH')).toBe(true),
      { timeout: 2000 },
    );
    const patch = requestLog.find((request) => request.init.method === 'PATCH');
    expect(patch).toBeDefined();
    expect(new Headers(patch?.init.headers).get('If-Match')).toBe(SERVER_UPDATED_AT);
    expect(new Headers(patch?.init.headers).get('Idempotency-Key')).toBeTruthy();
    expect(JSON.parse(String(patch?.init.body))).toEqual({
      subject: 'Changed subject',
      body_text: 'Server text',
      body_html: '<p>Server HTML</p>',
      to: ['to@example.test'],
      cc: [],
      bcc: [],
    });
  });

  it('R-API-003 serializes same-draft saves and uses the first response as the next If-Match', async () => {
    let resolveFirst: (response: Response) => void = () => undefined;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    renderPage({
      patchResponseFactory: (body, attempt) => {
        if (attempt === 0) return firstResponse;
        return jsonResponse({
          data: {
            ...SERVER_DRAFT,
            ...body,
            updated_at: '2026-08-30T10:02:00.000Z',
          },
        });
      },
    });
    await waitFor(() => expect(screen.getByTestId('draft-editor-form')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'First save' } });
    await waitFor(
      () => expect(requestLog.filter((request) => request.init.method === 'PATCH')).toHaveLength(1),
      { timeout: 2000 },
    );
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Second save' } });
    resolveFirst(
      jsonResponse({
        data: {
          ...SERVER_DRAFT,
          subject: 'First save',
          updated_at: '2026-08-30T10:01:00.000Z',
        },
      }),
    );

    await waitFor(
      () => expect(requestLog.filter((request) => request.init.method === 'PATCH')).toHaveLength(2),
      { timeout: 2500 },
    );
    const secondPatch = requestLog.filter((request) => request.init.method === 'PATCH')[1];
    expect(new Headers(secondPatch?.init.headers).get('If-Match')).toBe('2026-08-30T10:01:00.000Z');
    expect(JSON.parse(String(secondPatch?.init.body))).toMatchObject({
      subject: 'First save',
      body_text: 'Second save',
    });
  });

  it('R-SECRET-003 mirrors a successful PATCH into the current user draft cache without headers', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('draft-editor-form')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Body'), { target: { value: 'Updated body' } });

    await waitFor(async () => {
      await expect(
        getDraftWorkingCopy(SESSION.userId, MAILBOX_ID, DRAFT_ID),
      ).resolves.toMatchObject({
        subject: 'Server subject',
        textBody: 'Updated body',
        dirty: false,
        baseServerUpdatedAt: '2026-08-30T10:01:00.000Z',
      });
    });
    expect(screen.getByTestId('draft-save-state')).toHaveTextContent('Saved');
    const cached = await getDraftWorkingCopy(SESSION.userId, MAILBOX_ID, DRAFT_ID);
    expect(cached).not.toHaveProperty('idempotencyKey');
    expect(cached).not.toHaveProperty('authorization');
  });

  it('R-API-002 preserves values and exposes a retryable API error after autosave fails', async () => {
    renderPage({
      patchResponse: errorResponse('DRAFT_UPDATE_FAILED', 'Draft could not be saved', 400),
    });
    await waitFor(() => expect(screen.getByTestId('draft-editor-form')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Keep this value' } });

    await waitFor(() => expect(screen.getByTestId('draft-save-error')).toBeInTheDocument());
    expect(screen.getByLabelText('Subject')).toHaveValue('Keep this value');
    expect(screen.getByTestId('error-code')).toHaveTextContent('DRAFT_UPDATE_FAILED');
    expect(screen.getByRole('button', { name: 'Retry save' })).toBeInTheDocument();
  });

  it('R-API-002 retry reuses the current form values with a new PATCH attempt', async () => {
    renderPage({
      patchResponse: errorResponse('DRAFT_UPDATE_FAILED', 'Draft could not be saved', 400),
    });
    await waitFor(() => expect(screen.getByTestId('draft-editor-form')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Retry this value' } });
    await waitFor(() => expect(screen.getByTestId('draft-save-error')).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(
      () => expect(requestLog.filter((request) => request.init.method === 'PATCH')).toHaveLength(2),
      { timeout: 2000 },
    );
    expect(screen.getByLabelText('Subject')).toHaveValue('Retry this value');
    const idempotencyKeys = requestLog
      .filter((request) => request.init.method === 'PATCH')
      .map((request) => new Headers(request.init.headers).get('Idempotency-Key'));
    expect(new Set(idempotencyKeys).size).toBe(2);
  });

  it('R-API-003 renders an explicit stale-version conflict without overwriting local edits', async () => {
    renderPage({
      patchResponse: errorResponse('STALE_IF_MATCH', 'A newer server version exists', 412),
    });
    await waitFor(() => expect(screen.getByTestId('draft-editor-form')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Subject'), {
      target: { value: 'Local conflict edit' },
    });

    await waitFor(() => expect(screen.getByTestId('draft-save-conflict')).toBeInTheDocument());
    expect(screen.getByLabelText('Subject')).toHaveValue('Local conflict edit');
    expect(screen.getByTestId('draft-conflict-reload')).toBeInTheDocument();
    expect(screen.getByTestId('error-code')).toHaveTextContent('STALE_IF_MATCH');
  });

  it('R-API-003 refreshes the latest server version before removing a conflicted local copy', async () => {
    const freshServerDraft = {
      ...SERVER_DRAFT,
      subject: 'Fresh server subject',
      updated_at: '2026-08-30T10:02:00.000Z',
    };
    renderPage({
      draftResponses: [
        jsonResponse({ data: SERVER_DRAFT }),
        jsonResponse({ data: freshServerDraft }),
      ],
      patchResponse: errorResponse('STALE_IF_MATCH', 'A newer server version exists', 412),
    });
    await waitFor(() => expect(screen.getByTestId('draft-editor-form')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Keep conflict edit' } });
    await waitFor(() => expect(screen.getByTestId('draft-save-conflict')).toBeInTheDocument());
    await userEvent.setup().click(screen.getByTestId('draft-conflict-reload'));

    await waitFor(() =>
      expect(screen.getByLabelText('Subject')).toHaveValue('Fresh server subject'),
    );
    await expect(getDraftWorkingCopy(SESSION.userId, MAILBOX_ID, DRAFT_ID)).resolves.toBeNull();
    expect(
      requestLog.filter(
        (request) =>
          request.init.method === 'GET' && request.url.startsWith(`/api/v1/drafts/${DRAFT_ID}?`),
      ),
    ).toHaveLength(2);
  });

  it('R-DATA-004 rejects a foreign resource in a successful PATCH response', async () => {
    renderPage({
      patchResponse: jsonResponse({
        data: {
          ...SERVER_DRAFT,
          id: '00000000-0000-4000-8000-000000000099',
        },
      }),
    });
    await waitFor(() => expect(screen.getByTestId('draft-editor-form')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Foreign response' } });
    await waitFor(() => expect(screen.getByTestId('draft-save-error')).toBeInTheDocument());
    expect(screen.getByTestId('error-code')).toHaveTextContent('INVALID_RESPONSE');
    expect(screen.getByLabelText('Subject')).toHaveValue('Foreign response');
  });

  it('CAP-064 cancels a pending debounce when the editor unmounts', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('draft-editor-form')).toBeInTheDocument());
    vi.useFakeTimers();
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Unmounted edit' } });
    cleanup();
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();

    expect(requestLog.filter((request) => request.init.method === 'PATCH')).toHaveLength(0);
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
