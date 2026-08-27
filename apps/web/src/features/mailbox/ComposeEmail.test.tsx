// apps/web — ComposeEmail tests (CAP-044 Slice 1 / AC 2–7).
//
// Covers:
//   - form validation (AC 2): each invalid shape (no To, bad email in
//     To or Cc, empty subject, >998 subject) blocks submit (zero POSTs)
//     and reports the error; the valid shape submits exactly once.
//   - a11y (AC 2): labels are programmatically associated, error
//     messages are announced (aria-describedby + role="alert"), the
//     first erroring field is focused after an invalid submit, and the
//     send confirmation is a role="status" region.
//   - the mutation (AC 4 + AC 7): exactly one POST with the exact JSON
//     payload (comma-separated To → array, R-DATA-001 lower-casing,
//     subject trimmed, htmlBody always '', no threading keys on a fresh
//     compose, inReplyTo/references present on a reply prefill — parsed
//     through composeResponseSchema's 202 shape); submit disabled while
//     pending; success resets the form, shows the returned messageId,
//     and invalidates ['mailbox','messages',mailboxId]; failure keeps
//     the form's values, renders the stable error code inline, and a
//     retry is a SECOND POST with a DISTINCT Idempotency-Key (never an
//     automatic replay).
//   - reply prefill (AC 5): the parent detail loads via the existing
//     messageDetailQuery and the form renders buildReplyContext's
//     output; parent-load failure renders an error panel with retry.
//   - fix pass (c)/(d)/(h): a cached parent survives a failing
//     background refetch (typed draft + send confirmation kept); the
//     reply context clears after a successful send (second POST carries
//     no threading headers, title degrades to Compose); 403 surfaces
//     inline with values kept; empty body sends; the 1,000,001-char
//     body and whitespace-only subject are rejected with zero POSTs; a
//     trailing-comma To sends one clean recipient; a failed reply send
//     retries with the threading headers intact.
//
// The fetch harness is the MessageDetailPage pattern (URL+method
// dispatch, header capture) extended with request-body capture — the
// POSTed JSON is what AC 7 asserts against.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useParams,
} from '@tanstack/react-router';
import type { AnyRouter } from '@tanstack/react-router';
import type { MessageDetail } from '@unimailbox/contracts';
import { ComposeEmail } from './ComposeEmail';
import { mailboxQueryKeys } from './mailbox-queries';
import { authQueryKeys } from '../auth/auth-queries';
import { jsonResponse, errorResponse } from '../../test-utils';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';

afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});

const SESSION = {
  userId: 'u-1',
  email: 'a@b.test',
  displayName: 'A B',
  expiresAt: '2099-01-01T00:00:00Z',
};

const MAILBOX_ID = 'mb-1';
const PARENT_ID = '00000000-0000-4000-8000-00000000000a';
const SENT_MESSAGE_ID = '00000000-0000-4000-8000-0000000000f1';

const PARENT_DETAIL: MessageDetail = {
  id: PARENT_ID,
  fromAddress: 'Sender@Example.COM',
  fromName: 'Sender Name',
  subject: 'Quarterly report',
  htmlBody: '<p>out of scope</p>',
  textBody: 'The report body.',
  messageIdHeader: '<reply-1@example.com>',
  inReplyToHeader: '<root@example.com>',
  referencesHeader: '<root@example.com>',
  status: 'delivered',
  isRead: 1,
  isStarred: 0,
  folder: 'inbox',
  createdAt: '2026-02-02T00:00:00Z',
  recipients: {
    to: [{ address: 'me@example.com', displayName: 'Me' }],
    cc: [],
  },
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Fetch harness: URL+method dispatch with header AND body capture.
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

interface RouteHandler {
  match: (url: string, method: string) => boolean;
  response: () => Response | Promise<Response>;
}

function dispatchFetch(routes: ReadonlyArray<RouteHandler>): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers).entries()) {
        headers[key.toLowerCase()] = value;
      }
    }
    let body: unknown = undefined;
    if (init?.body !== undefined && typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: CapturedRequest = { url, method, headers, body };
    calls.push(call);
    const route = routes.find((r) => r.match(url, method));
    if (route === undefined) {
      // 400 (not 5xx): a missing test route must not trigger the
      // client's 5xx retry backoff and hang the test.
      return errorResponse('TEST_NO_ROUTE', `no route for ${method} ${url}`, 400);
    }
    return route.response();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function sessionRoute(): RouteHandler {
  return {
    match: (url) => url.includes('/api/v1/auth/better/get-session'),
    response: () =>
      jsonResponse({
        data: {
          user: { id: SESSION.userId, email: SESSION.email, name: SESSION.displayName },
          session: { userId: SESSION.userId, expiresAt: SESSION.expiresAt },
        },
      }),
  };
}

function parentDetailRoute(respond: () => Response): RouteHandler {
  return {
    match: (url, method) =>
      method === 'GET' && url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${PARENT_ID}`,
    response: respond,
  };
}

interface SendRouteOptions {
  /** Response(s) for the send POST; later entries used on repeat calls. */
  readonly responses: ReadonlyArray<Response | Promise<Response>>;
}

function sendRoute(options: SendRouteOptions): RouteHandler {
  let attempts = 0;
  return {
    match: (url, method) =>
      method === 'POST' && url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/send`,
    response: () => {
      const response = options.responses[Math.min(attempts, options.responses.length - 1)];
      if (response === undefined) {
        throw new Error('sendRoute requires at least one response');
      }
      attempts += 1;
      return response;
    },
  };
}

const sendAccepted = (): Response =>
  jsonResponse({ data: { messageId: SENT_MESSAGE_ID, status: 'queued' } }, 202);

// ---------------------------------------------------------------------------
// Mount harness.
// ---------------------------------------------------------------------------

interface RenderComposeOptions {
  readonly routes: ReadonlyArray<RouteHandler>;
  readonly replyToMessageId?: string;
  /**
   * Session cache seeding. `true` (default) seeds a valid descriptor;
   * `null` seeds the expired descriptor (D-CAP-041-9 fallback);
   * `false` seeds nothing (session fetch pending → skeleton).
   */
  readonly session?: true | false | null;
  /**
   * Fix (c) harness: pre-seeds the parent detail into the query cache.
   * `staleTime: 0` still fires a background refetch on mount — the
   * parentDetailRoute mock answers it.
   */
  readonly seedParentDetail?: MessageDetail;
}

async function renderCompose(options: RenderComposeOptions): Promise<{
  calls: CapturedRequest[];
  queryClient: QueryClient;
  router: AnyRouter;
}> {
  const { fetchImpl, calls } = dispatchFetch(options.routes);
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  if (options.session !== false) {
    queryClient.setQueryData(authQueryKeys.session(), options.session === null ? null : SESSION);
  }
  if (options.seedParentDetail !== undefined) {
    queryClient.setQueryData(
      mailboxQueryKeys.message(MAILBOX_ID, PARENT_ID),
      options.seedParentDetail,
    );
  }

  // ComposeEmail renders a router <Link> ("Back to inbox"), so it mounts
  // inside a real memory-history tree (MessageDetailPage pattern).
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const composeRouteEntry = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId/compose',
    component: () => {
      const params = useParams({ strict: false });
      return (
        <ComposeEmail mailboxId={params.mailboxId} replyToMessageId={options.replyToMessageId} />
      );
    },
  });
  const inboxRouteEntry = createRoute({
    getParentRoute: () => rootRoute,
    path: '/mailbox/$mailboxId',
    component: () => <div data-testid="arrived-inbox">inbox</div>,
  });
  const history = createMemoryHistory({
    initialEntries: [`/mailbox/${MAILBOX_ID}/compose`],
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([composeRouteEntry, inboxRouteEntry]),
    history,
  });
  await router.load();

  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );

  return { calls, queryClient, router };
}

async function renderBlankComposer(
  routes: ReadonlyArray<RouteHandler>,
): Promise<ReturnType<typeof renderCompose>> {
  const result = await renderCompose({ routes });
  await waitFor(() => {
    expect(screen.getByTestId('compose-form')).toBeInTheDocument();
  });
  return result;
}

function postCalls(calls: ReadonlyArray<CapturedRequest>): CapturedRequest[] {
  return calls.filter((call) => call.method === 'POST');
}

/** Types the four fields and submits — the shared "valid form" action. */
async function fillAndSubmit(
  user: ReturnType<typeof userEvent.setup>,
  fields: { to?: string; cc?: string; subject?: string; body?: string },
): Promise<void> {
  if (fields.to !== undefined) {
    await user.type(screen.getByLabelText('To'), fields.to);
  }
  if (fields.cc !== undefined) {
    await user.type(screen.getByLabelText('Cc'), fields.cc);
  }
  if (fields.subject !== undefined) {
    await user.type(screen.getByLabelText('Subject'), fields.subject);
  }
  if (fields.body !== undefined) {
    await user.type(screen.getByLabelText('Body'), fields.body);
  }
  await user.click(screen.getByRole('button', { name: 'Send' }));
}

describe('ComposeEmail — validation (AC 2)', () => {
  it('blocks submit with no To, reports the error, and focuses the To field', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({ responses: [sendAccepted()] }),
    ]);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Subject'), 'Only a subject');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('At least one email address is required.')).toBeInTheDocument();
    });
    expect(postCalls(calls)).toHaveLength(0);
    // First erroring field (To, field order) receives focus.
    expect(screen.getByLabelText('To')).toHaveFocus();
  });

  it('blocks submit when a To token is not a valid email address', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({ responses: [sendAccepted()] }),
    ]);
    const user = userEvent.setup();
    await fillAndSubmit(user, { to: 'a@b.test, not-an-email', subject: 'Hi' });

    await waitFor(() => {
      expect(screen.getByText('"not-an-email" is not a valid email address.')).toBeInTheDocument();
    });
    expect(postCalls(calls)).toHaveLength(0);
  });

  it('blocks submit when a Cc token is not a valid email address', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({ responses: [sendAccepted()] }),
    ]);
    const user = userEvent.setup();
    // (Cc itself may be empty — the pending-state test below submits
    // with an untouched Cc and succeeds.)
    await fillAndSubmit(user, { to: 'a@b.test', cc: 'x@y.test, nope', subject: 'Hi' });

    await waitFor(() => {
      expect(screen.getByText('"nope" is not a valid email address.')).toBeInTheDocument();
    });
    expect(postCalls(calls)).toHaveLength(0);
  });

  it('blocks submit with an empty subject and focuses the Subject field (To valid)', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({ responses: [sendAccepted()] }),
    ]);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('To'), 'a@b.test');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByText('Subject is required.')).toBeInTheDocument();
    });
    expect(postCalls(calls)).toHaveLength(0);
    // To is valid, so the FIRST error is the subject.
    expect(screen.getByLabelText('Subject')).toHaveFocus();
  });

  it('blocks submit with a subject longer than 998 characters', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({ responses: [sendAccepted()] }),
    ]);
    const user = userEvent.setup();
    await fillAndSubmit(user, { to: 'a@b.test', subject: 's'.repeat(999) });

    await waitFor(() => {
      expect(screen.getByText('Subject must be at most 998 characters.')).toBeInTheDocument();
    });
    expect(postCalls(calls)).toHaveLength(0);
  });

  // Fix pass (h): a whitespace-only subject is EMPTY after the schema's
  // trim — required, not merely cosmetic.
  it('blocks submit with a whitespace-only subject (fix h)', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({ responses: [sendAccepted()] }),
    ]);
    const user = userEvent.setup();
    await fillAndSubmit(user, { to: 'a@b.test', subject: '   ' });

    await waitFor(() => {
      expect(screen.getByText('Subject is required.')).toBeInTheDocument();
    });
    expect(postCalls(calls)).toHaveLength(0);
  });

  // Fix pass (h): body cap boundary +1. fireEvent, not userEvent.type —
  // a million synthesized keystrokes would dominate the suite's runtime
  // while exercising the same RHF registration path.
  it('blocks submit with a 1,000,001-character body and sends zero POSTs (fix h)', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({ responses: [sendAccepted()] }),
    ]);
    fireEvent.change(screen.getByLabelText('Body'), {
      target: { value: 'x'.repeat(1_000_001) },
    });
    const user = userEvent.setup();
    await fillAndSubmit(user, { to: 'a@b.test', subject: 'Oversized' });

    await waitFor(() => {
      expect(screen.getByText('Body must be at most 1,000,000 characters.')).toBeInTheDocument();
    });
    expect(postCalls(calls)).toHaveLength(0);
  });
});

describe('ComposeEmail — a11y (AC 2)', () => {
  it('associates every label with its control and announces errors via aria-describedby + role=alert', async () => {
    await renderBlankComposer([sessionRoute()]);
    const user = userEvent.setup();

    // Programmatic labels: getByLabelText resolves to the control.
    expect(screen.getByLabelText('To')).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText('Cc')).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText('Subject')).toBeInstanceOf(HTMLInputElement);
    expect(screen.getByLabelText('Body')).toBeInstanceOf(HTMLTextAreaElement);

    // Submit empty → To + Subject errors appear.
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.getByText('At least one email address is required.')).toBeInTheDocument();
    });

    // Each error is announced: the input is aria-invalid and its
    // aria-describedby points at a role="alert" region holding the text.
    const toInput = screen.getByLabelText('To');
    expect(toInput).toHaveAttribute('aria-invalid', 'true');
    const toErrorId = toInput.getAttribute('aria-describedby') ?? '';
    expect(toErrorId).not.toBe('');
    const toError = document.getElementById(toErrorId.split(' ')[0] ?? '');
    expect(toError).not.toBeNull();
    expect(toError?.getAttribute('role')).toBe('alert');

    const subjectInput = screen.getByLabelText('Subject');
    expect(subjectInput).toHaveAttribute('aria-invalid', 'true');
    const subjectErrorId = subjectInput.getAttribute('aria-describedby') ?? '';
    const subjectError = document.getElementById(subjectErrorId.split(' ')[0] ?? '');
    expect(subjectError?.getAttribute('role')).toBe('alert');
  });
});

describe('ComposeEmail — send mutation (AC 4 + AC 7)', () => {
  it('a valid form submits exactly one POST with the exact payload (R-DATA-001 normalisation, no threading keys)', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({ responses: [sendAccepted()] }),
    ]);
    const user = userEvent.setup();
    await fillAndSubmit(user, {
      to: ' User@Example.COM , second@Example.com ',
      cc: 'CC@Example.com',
      subject: '  Hello there  ',
      body: 'Line one',
    });

    await waitFor(() => {
      expect(screen.getByTestId('compose-confirmation')).toBeInTheDocument();
    });
    const posts = postCalls(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe(`/api/v1/mailboxes/${MAILBOX_ID}/messages/send`);
    // R-OUTBOUND-005: the POST carries a minted Idempotency-Key.
    expect(posts[0]?.headers['idempotency-key']).toMatch(UUID_PATTERN);
    expect(posts[0]?.body).toEqual({
      to: [{ address: 'user@example.com' }, { address: 'second@example.com' }],
      cc: [{ address: 'cc@example.com' }],
      subject: 'Hello there',
      htmlBody: '',
      textBody: 'Line one',
    });
    // A fresh compose carries NO threading headers at all.
    const payload = posts[0]?.body as Record<string, unknown>;
    expect('inReplyTo' in payload).toBe(false);
    expect('references' in payload).toBe(false);
  });

  it('disables the submit button while the POST is pending (AC 4)', async () => {
    let resolveSend: (response: Response) => void = () => {};
    const held = new Promise<Response>((resolve) => {
      resolveSend = resolve;
    });
    const { calls } = await renderBlankComposer([sessionRoute(), sendRoute({ responses: [held] })]);
    const user = userEvent.setup();
    await fillAndSubmit(user, { to: 'a@b.test', subject: 'Hi', body: 'b' });

    const submit = screen.getByTestId('compose-submit');
    await waitFor(() => {
      expect(submit).toBeDisabled();
      expect(submit).toHaveAttribute('aria-busy', 'true');
    });
    // Still exactly one POST — no second attempt while pending.
    expect(postCalls(calls)).toHaveLength(1);

    resolveSend(sendAccepted());
    await waitFor(() => {
      expect(screen.getByTestId('compose-confirmation')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByTestId('compose-submit')).toBeEnabled();
    });
  });

  it('on 202: resets the form, shows the returned messageId, and invalidates the mailbox messages family', async () => {
    const { calls, queryClient } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({ responses: [sendAccepted()] }),
    ]);
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const user = userEvent.setup();
    await fillAndSubmit(user, { to: 'a@b.test', subject: 'Hello', body: 'Body text' });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: mailboxQueryKeys.messages(MAILBOX_ID),
      });
    });
    // The confirmation carries the messageId parsed from the 202 body.
    const confirmation = screen.getByTestId('compose-confirmation');
    expect(confirmation.getAttribute('role')).toBe('status');
    expect(confirmation.textContent).toContain(SENT_MESSAGE_ID);
    // The form reset: every field blank, no error text.
    expect(screen.getByLabelText('To')).toHaveValue('');
    expect(screen.getByLabelText('Cc')).toHaveValue('');
    expect(screen.getByLabelText('Subject')).toHaveValue('');
    expect(screen.getByLabelText('Body')).toHaveValue('');
    expect(postCalls(calls)).toHaveLength(1);
    invalidateSpy.mockRestore();
  });

  it('on failure: the form keeps its values, the stable code + message render inline', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({
        responses: [
          errorResponse('PROVIDER_CONNECTION_NOT_FOUND', 'No active provider connection', 409),
        ],
      }),
    ]);
    const user = userEvent.setup();
    await fillAndSubmit(user, { to: 'a@b.test', subject: 'Hello', body: 'Body text' });

    await waitFor(() => {
      expect(screen.getByTestId('compose-send-error')).toBeInTheDocument();
    });
    const errorRegion = screen.getByTestId('compose-send-error');
    expect(errorRegion.getAttribute('role')).toBe('alert');
    expect(within(errorRegion).getByText('PROVIDER_CONNECTION_NOT_FOUND')).toBeInTheDocument();
    expect(errorRegion.textContent).toContain('No active provider connection');
    // The form KEEPS its values.
    expect(screen.getByLabelText('To')).toHaveValue('a@b.test');
    expect(screen.getByLabelText('Subject')).toHaveValue('Hello');
    expect(screen.getByLabelText('Body')).toHaveValue('Body text');
    // No confirmation appeared.
    expect(screen.queryByTestId('compose-confirmation')).not.toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(1);
  });

  it('retry after failure is a second mutate call — a second POST with a DISTINCT Idempotency-Key, never an auto-replay', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({
        responses: [errorResponse('INTERNAL', 'boom', 400), sendAccepted()],
      }),
    ]);
    const user = userEvent.setup();
    await fillAndSubmit(user, { to: 'a@b.test', subject: 'Hello', body: 'Body text' });
    await waitFor(() => {
      expect(screen.getByTestId('compose-send-error')).toBeInTheDocument();
    });
    // Exactly one POST so far — the client did not silently re-fire.
    expect(postCalls(calls)).toHaveLength(1);
    const firstKey = postCalls(calls)[0]?.headers['idempotency-key'];

    // The user retries manually: click Send again.
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.getByTestId('compose-confirmation')).toBeInTheDocument();
    });

    const posts = postCalls(calls);
    expect(posts).toHaveLength(2);
    const secondKey = posts[1]?.headers['idempotency-key'];
    // A retry is a NEW call → a fresh key (D-CAP-041-2 / R-OUTBOUND-005).
    expect(secondKey).toMatch(UUID_PATTERN);
    expect(secondKey).not.toBe(firstKey);
    // And nothing auto-replayed beyond the user's second click.
    expect(postCalls(calls)).toHaveLength(2);
  });

  // Fix pass (h) / R-MESSAGE-011: a 403 must surface as a user-visible
  // error with its stable code — never a silent drop. Same technique as
  // the 409 failure test above.
  it('surfaces a 403 MAILBOX_ACCESS_DENIED inline and keeps the form values (fix h / R-MESSAGE-011)', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({
        responses: [
          errorResponse('MAILBOX_ACCESS_DENIED', 'You cannot send from this mailbox.', 403),
        ],
      }),
    ]);
    const user = userEvent.setup();
    await fillAndSubmit(user, { to: 'a@b.test', subject: 'Hello', body: 'Body text' });

    await waitFor(() => {
      expect(screen.getByTestId('compose-send-error')).toBeInTheDocument();
    });
    const errorRegion = screen.getByTestId('compose-send-error');
    expect(within(errorRegion).getByText('MAILBOX_ACCESS_DENIED')).toBeInTheDocument();
    expect(errorRegion.textContent).toContain('You cannot send from this mailbox.');
    // The form KEEPS its values — the user can go back and fix context.
    expect(screen.getByLabelText('To')).toHaveValue('a@b.test');
    expect(screen.getByLabelText('Subject')).toHaveValue('Hello');
    expect(screen.getByLabelText('Body')).toHaveValue('Body text');
    expect(postCalls(calls)).toHaveLength(1);
  });

  // Fix pass (h): the body may be empty (AC 2) — the POST carries
  // textBody '' and still succeeds.
  it('sends successfully with an empty body (fix h)', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({ responses: [sendAccepted()] }),
    ]);
    const user = userEvent.setup();
    // body untouched — '' by default.
    await fillAndSubmit(user, { to: 'a@b.test', subject: 'No body' });

    await waitFor(() => {
      expect(screen.getByTestId('compose-confirmation')).toBeInTheDocument();
    });
    const posts = postCalls(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      to: [{ address: 'a@b.test' }],
      cc: [],
      subject: 'No body',
      htmlBody: '',
      textBody: '',
    });
    const payload = posts[0]?.body as Record<string, unknown>;
    expect('inReplyTo' in payload).toBe(false);
    expect('references' in payload).toBe(false);
  });

  // Fix pass (h): trailing separators are dropped by splitEmailList —
  // 'a@b.test,,' yields exactly one clean recipient. (The criterion's
  // literal 'a@b.c' is rejected by the shared emailAddressSchema —
  // zod's .email() needs a 2+ char TLD — so the test uses a
  // schema-valid address with the same trailing-comma shape.)
  it('a trailing-comma To input sends one clean recipient (fix h)', async () => {
    const { calls } = await renderBlankComposer([
      sessionRoute(),
      sendRoute({ responses: [sendAccepted()] }),
    ]);
    const user = userEvent.setup();
    await fillAndSubmit(user, { to: 'a@b.test,,', subject: 'Trailing commas' });

    await waitFor(() => {
      expect(screen.getByTestId('compose-confirmation')).toBeInTheDocument();
    });
    const posts = postCalls(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      to: [{ address: 'a@b.test' }],
      cc: [],
      subject: 'Trailing commas',
      htmlBody: '',
      textBody: '',
    });
  });
});

describe('ComposeEmail — reply prefill (AC 5 + AC 6 + AC 7)', () => {
  it('pre-fills from the parent detail per D-CAP-044-C and sends inReplyTo/references in the POST body', async () => {
    const { calls } = await renderCompose({
      routes: [
        sessionRoute(),
        parentDetailRoute(() => jsonResponse({ data: PARENT_DETAIL })),
        sendRoute({ responses: [sendAccepted()] }),
      ],
      replyToMessageId: PARENT_ID,
    });

    // The form renders only after the parent detail resolves.
    await waitFor(() => {
      expect(screen.getByTestId('compose-form')).toBeInTheDocument();
    });
    // buildReplyContext output drives the defaults (R-DATA-001 on the
    // from-address; Re: subject).
    expect(screen.getByLabelText('To')).toHaveValue('sender@example.com');
    expect(screen.getByLabelText('Subject')).toHaveValue('Re: Quarterly report');
    expect(screen.getByLabelText('Body')).toHaveValue('');

    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Body'), 'Here is the reply.');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => {
      expect(screen.getByTestId('compose-confirmation')).toBeInTheDocument();
    });
    const posts = postCalls(calls);
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      to: [{ address: 'sender@example.com' }],
      cc: [],
      subject: 'Re: Quarterly report',
      htmlBody: '',
      textBody: 'Here is the reply.',
      inReplyTo: '<reply-1@example.com>',
      references: '<root@example.com> <reply-1@example.com>',
    });
  });

  it('renders an error panel with retry when the parent detail fails to load', async () => {
    let detailAttempts = 0;
    const { calls } = await renderCompose({
      routes: [
        sessionRoute(),
        parentDetailRoute(() => {
          detailAttempts += 1;
          return detailAttempts === 1
            ? errorResponse('INTERNAL', 'parent boom', 400)
            : jsonResponse({ data: PARENT_DETAIL });
        }),
        sendRoute({ responses: [sendAccepted()] }),
      ],
      replyToMessageId: PARENT_ID,
    });

    await waitFor(() => {
      expect(screen.getByTestId('compose-parent-error')).toBeInTheDocument();
    });
    // The composer form never mounted — nothing to send.
    expect(screen.queryByTestId('compose-form')).not.toBeInTheDocument();
    expect(postCalls(calls)).toHaveLength(0);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => {
      expect(screen.getByTestId('compose-form')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('To')).toHaveValue('sender@example.com');
  });

  // Fix pass (c): a cached parent (staleTime 0 → background refetch on
  // mount) must keep the mounted form when the refetch FAILS — data
  // beats error, or a typed draft is destroyed.
  it('(fix c) keeps the mounted form and its typed draft when a background parent refetch fails on cached data', async () => {
    let resolveRefetch: (response: Response) => void = () => {};
    const heldRefetch = new Promise<Response>((resolve) => {
      resolveRefetch = resolve;
    });
    const { queryClient } = await renderCompose({
      routes: [sessionRoute(), parentDetailRoute(() => heldRefetch as unknown as Response)],
      replyToMessageId: PARENT_ID,
      seedParentDetail: PARENT_DETAIL,
    });

    // The prefilled form renders from the CACHE while the refetch is
    // still in flight.
    await waitFor(() => {
      expect(screen.getByTestId('compose-form')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('To')).toHaveValue('sender@example.com');
    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('To'));
    await user.type(screen.getByLabelText('To'), 'typed@b.test');

    // The background refetch fails while the form holds user input.
    resolveRefetch(errorResponse('INTERNAL', 'refetch boom', 400));
    await waitFor(() => {
      expect(
        queryClient.getQueryState(mailboxQueryKeys.message(MAILBOX_ID, PARENT_ID))?.error,
      ).not.toBeNull();
    });

    // Data-first: the typed draft survives the failed refetch; the
    // parent-error panel is only for the NO-data case.
    expect(screen.getByTestId('compose-form')).toBeInTheDocument();
    expect(screen.getByLabelText('To')).toHaveValue('typed@b.test');
    expect(screen.queryByTestId('compose-parent-error')).not.toBeInTheDocument();
  });

  // Fix pass (c), second half: the send-success invalidation refires the
  // parent query; its failure must not tear down the confirmation.
  it("(fix c) a successful send's confirmation survives a failing parent refetch triggered by the invalidation", async () => {
    let detailAttempts = 0;
    const { queryClient } = await renderCompose({
      routes: [
        sessionRoute(),
        parentDetailRoute(() => {
          detailAttempts += 1;
          return detailAttempts === 1
            ? jsonResponse({ data: PARENT_DETAIL })
            : errorResponse('INTERNAL', 'refetch boom', 400);
        }),
        sendRoute({ responses: [sendAccepted()] }),
      ],
      replyToMessageId: PARENT_ID,
      seedParentDetail: PARENT_DETAIL,
    });

    await waitFor(() => {
      expect(screen.getByTestId('compose-form')).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Body'), 'Here is the reply.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.getByTestId('compose-confirmation')).toBeInTheDocument();
    });

    // The mutation's invalidation refired the detail query (staleTime 0)
    // and the refetch failed — the confirmation and blank form stay.
    await waitFor(() => {
      expect(
        queryClient.getQueryState(mailboxQueryKeys.message(MAILBOX_ID, PARENT_ID))?.error,
      ).not.toBeNull();
    });
    expect(screen.getByTestId('compose-confirmation')).toBeInTheDocument();
    expect(screen.getByTestId('compose-form')).toBeInTheDocument();
    expect(screen.queryByTestId('compose-parent-error')).not.toBeInTheDocument();
  });

  // Fix pass (d): after a successful reply send, the reset form is a
  // FRESH compose — no stale inReplyTo/references on the second send,
  // and the titles degrade to the Compose wording.
  it('(fix d) after a successful reply send, the follow-up send carries NO threading headers and the title degrades to Compose', async () => {
    const { calls } = await renderCompose({
      routes: [
        sessionRoute(),
        parentDetailRoute(() => jsonResponse({ data: PARENT_DETAIL })),
        sendRoute({ responses: [sendAccepted(), sendAccepted()] }),
      ],
      replyToMessageId: PARENT_ID,
    });

    await waitFor(() => {
      expect(screen.getByTestId('compose-form')).toBeInTheDocument();
    });
    // Reply mode before the send.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Reply');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Body'), 'The reply.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.getByTestId('compose-confirmation')).toBeInTheDocument();
    });
    const firstPayload = postCalls(calls)[0]?.body as Record<string, unknown>;
    expect(firstPayload.inReplyTo).toBe('<reply-1@example.com>');
    expect(firstPayload.references).toBe('<root@example.com> <reply-1@example.com>');

    // The cleared context degrades the titles (fix d).
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Compose');
    expect(screen.getByText('New message')).toBeInTheDocument();

    // A second, unrelated send from the now-blank form.
    await user.type(screen.getByLabelText('To'), 'other@b.test');
    await user.type(screen.getByLabelText('Subject'), 'Unrelated');
    await user.type(screen.getByLabelText('Body'), 'Second message.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(postCalls(calls)).toHaveLength(2);
    });
    const secondPayload = postCalls(calls)[1]?.body as Record<string, unknown>;
    expect(secondPayload.subject).toBe('Unrelated');
    // NO threading keys on the follow-up send.
    expect('inReplyTo' in secondPayload).toBe(false);
    expect('references' in secondPayload).toBe(false);
  });

  // Fix pass (h): a FAILED reply send keeps the form values (AC 4), so
  // the manual retry must still carry the threading headers — the
  // context only clears on success.
  it('(fix h) a failed reply send retries with the threading headers intact', async () => {
    const { calls } = await renderCompose({
      routes: [
        sessionRoute(),
        parentDetailRoute(() => jsonResponse({ data: PARENT_DETAIL })),
        sendRoute({
          responses: [
            errorResponse('PROVIDER_CONNECTION_NOT_FOUND', 'No active provider connection', 409),
            sendAccepted(),
          ],
        }),
      ],
      replyToMessageId: PARENT_ID,
    });

    await waitFor(() => {
      expect(screen.getByTestId('compose-form')).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Body'), 'The reply.');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.getByTestId('compose-send-error')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => {
      expect(screen.getByTestId('compose-confirmation')).toBeInTheDocument();
    });

    const posts = postCalls(calls);
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      const payload = post.body as Record<string, unknown>;
      expect(payload.inReplyTo).toBe('<reply-1@example.com>');
      expect(payload.references).toBe('<root@example.com> <reply-1@example.com>');
    }
  });

  it('renders the session-gate surfaces (skeleton while pending, expired fallback)', async () => {
    // No session in the cache and a session fetch that never resolves →
    // the skeleton only; the form never mounts.
    const pendingSession = new Promise<Response>(() => {});
    await renderCompose({
      routes: [
        {
          match: (url) => url.includes('/api/v1/auth/better/get-session'),
          response: () => pendingSession as unknown as Response,
        },
      ],
      session: false,
    });
    expect(screen.getByTestId('compose-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('compose-form')).not.toBeInTheDocument();

    // D-CAP-041-9: a null descriptor renders the expired-session CTA.
    cleanup();
    await renderCompose({ routes: [sessionRoute()], session: null });
    await waitFor(() => {
      expect(screen.getByTestId('expired-session')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('compose-form')).not.toBeInTheDocument();
  });
});
