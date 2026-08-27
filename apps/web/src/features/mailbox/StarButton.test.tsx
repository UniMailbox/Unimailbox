// apps/web — StarButton tests.
//
// CAP-043 Slice 3 (AC 13 + AC 16). The star toggle is OPTIMISTIC: the
// mutation's `onMutate` flips `isStarred` in the inbox infinite cache
// before the request resolves, and `onError` rolls it back. The tests
// prove the three legs:
//
//   - flip: the button renders starred WHILE the PATCH is still pending
//     (deferred fetch), carrying a minted Idempotency-Key (D-CAP-041-2);
//   - settle: on 200 the server's authoritative value sticks (no warn);
//   - rollback: on failure the row returns to its pre-click state and
//     the mutation warns once (G9 pattern) with the API error code.
//
// The button renders its PROPS, and the optimistic flip flows through
// the cache — so the harness mounts the button inside a row component
// that subscribes to the real `mailboxMessagesInfiniteQuery` cache,
// exactly like InboxListPage derives its rows. Observing the button
// therefore observes the cache.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { MessageListItem, MessageListResponse } from '@unimailbox/contracts';
import { StarButton } from './StarButton';
import {
  mailboxMessagesInfiniteQuery,
  mailboxQueryKeys,
  useDeleteMessageMutation,
} from './mailbox-queries';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { errorResponse, jsonResponse } from '../../test-utils';

afterEach(() => {
  cleanup();
});

const MAILBOX_ID = 'mb-1';
const MESSAGE_ID = '00000000-0000-4000-8000-00000000000a';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function messageFixture(isStarred: number, id: string = MESSAGE_ID): MessageListItem {
  return {
    id,
    fromAddress: 'sender@example.com',
    fromName: 'Sender',
    subject: 'Star me',
    isRead: 0,
    isStarred,
    folder: 'inbox',
    createdAt: '2026-02-01T00:00:00Z',
    recipients: { to: [], cc: [] },
  };
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

/**
 * Fetch harness where the PATCH /star response is held by the test: the
 * request is captured, but the returned promise stays pending until the
 * test resolves it — the only way to observe the optimistic state that
 * exists solely between click and response.
 */
function deferredStarFetch(): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
  resolveStar: (response: Response) => void;
} {
  const calls: CapturedRequest[] = [];
  let resolveStar: (response: Response) => void = () => {};
  const starPending = new Promise<Response>((resolve) => {
    resolveStar = resolve;
  });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      for (const [key, value] of new Headers(init.headers).entries()) {
        headers[key.toLowerCase()] = value;
      }
    }
    calls.push({ url, method, headers });
    if (
      method === 'PATCH' &&
      url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/star`
    ) {
      return starPending;
    }
    if (method === 'GET' && url.includes(`/api/v1/mailboxes/${MAILBOX_ID}/messages`)) {
      // The cache-bound row's refetch on mount — returns the unstarred
      // fixture, same as the seeded cache.
      return jsonResponse({ data: { items: [messageFixture(0)], nextCursor: null } });
    }
    // 400 (not 5xx): never triggers the client's retry backoff.
    return errorResponse('TEST_NO_ROUTE', `no route for ${method} ${url}`, 400);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, resolveStar };
}

interface MountOptions {
  readonly fetchImpl: typeof fetch;
  readonly initialMessage: MessageListItem;
}

/**
 * Cache-bound row harness: derives the message from the REAL inbox
 * infinite query (same derivation as InboxListPage) and renders the
 * StarButton from it. setQueryData writes from the mutation therefore
 * re-render this row — the optimistic flip is observable as the button
 * flipping while the request is still pending.
 */
function mountCacheBoundStarButton(options: MountOptions): void {
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: options.fetchImpl,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  const seeded: InfiniteData<MessageListResponse> = {
    pages: [{ items: [options.initialMessage], nextCursor: null }],
    pageParams: [undefined],
  };
  queryClient.setQueryData(mailboxQueryKeys.messages(MAILBOX_ID), seeded);

  function CacheBoundRow(): ReactElement {
    const query = mailboxMessagesInfiniteQuery(MAILBOX_ID);
    const item = query.data?.pages
      .flatMap((page) => page.items)
      .find((candidate) => candidate.id === MESSAGE_ID);
    if (item === undefined) {
      return <div data-testid="row-gone" />;
    }
    return <StarButton mailboxId={MAILBOX_ID} message={item} />;
  }

  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <CacheBoundRow />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

describe('StarButton', () => {
  it('flips optimistically while the PATCH is pending, with a minted Idempotency-Key, then keeps the server value on 200', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { fetchImpl, calls, resolveStar } = deferredStarFetch();
      mountCacheBoundStarButton({ fetchImpl, initialMessage: messageFixture(0) });

      const button = await screen.findByTestId('inbox-star-button');
      expect(button).toHaveAttribute('aria-pressed', 'false');
      expect(button.textContent).toBe('☆');

      const user = userEvent.setup();
      await user.click(button);

      // AC 16 — optimistic: starred BEFORE the response exists.
      await waitFor(() => {
        expect(screen.getByTestId('inbox-star-button')).toHaveAttribute('aria-pressed', 'true');
      });
      expect(screen.getByTestId('inbox-star-button').textContent).toBe('★');

      // The request went out once, to the star endpoint, with a
      // client-minted UUID Idempotency-Key (D-CAP-041-2 — the component
      // never touches the header).
      const patchCalls = calls.filter((call) => call.method === 'PATCH');
      expect(patchCalls).toHaveLength(1);
      expect(patchCalls[0]?.url).toBe(
        `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}/star`,
      );
      expect(patchCalls[0]?.headers['idempotency-key']).toMatch(UUID_PATTERN);

      // Settle: the server confirms starred — no change, no warn.
      resolveStar(jsonResponse({ data: { id: MESSAGE_ID, isStarred: 1 } }));
      await waitFor(() => {
        expect(screen.getByTestId('inbox-star-button')).not.toBeDisabled();
      });
      expect(screen.getByTestId('inbox-star-button')).toHaveAttribute('aria-pressed', 'true');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('rolls the optimistic flip back on API failure and warns once with the error code (G9)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { fetchImpl, calls, resolveStar } = deferredStarFetch();
      mountCacheBoundStarButton({ fetchImpl, initialMessage: messageFixture(0) });

      const button = await screen.findByTestId('inbox-star-button');
      const user = userEvent.setup();
      await user.click(button);

      // Optimistic flip visible while pending…
      await waitFor(() => {
        expect(screen.getByTestId('inbox-star-button')).toHaveAttribute('aria-pressed', 'true');
      });

      // …then the server denies it (403 — non-retryable, immediate).
      resolveStar(errorResponse('MAILBOX_ACCESS_DENIED', 'denied', 403));

      // Rollback: pre-click state restored, warn fired once with the code.
      await waitFor(() => {
        expect(screen.getByTestId('inbox-star-button')).toHaveAttribute('aria-pressed', 'false');
      });
      expect(screen.getByTestId('inbox-star-button').textContent).toBe('☆');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'toggle-message-star failed',
        expect.objectContaining({
          mailboxId: MAILBOX_ID,
          messageId: MESSAGE_ID,
          code: 'MAILBOX_ACCESS_DENIED',
        }),
      );
      // One PATCH, no retry (403 is terminal).
      expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('renders an already-starred message as pressed with the unstar label', async () => {
    const { fetchImpl } = deferredStarFetch();
    mountCacheBoundStarButton({ fetchImpl, initialMessage: messageFixture(1) });

    const button = await screen.findByTestId('inbox-star-button');
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveAccessibleName('Unstar message');
  });
});

// ---------------------------------------------------------------------------
// Slice 3 fix-pass harness: MULTIPLE rows, each with its own deferred star
// PATCH, plus a real delete trigger per row. Needed by the H7 rollback
// tests (row-scoped rollback is only observable when a sibling row exists)
// and the H10 server-wins test.
// ---------------------------------------------------------------------------

interface StarDeferred {
  readonly promise: Promise<Response>;
  resolve: (response: Response) => void;
  reject: (reason?: unknown) => void;
}

/**
 * Fetch harness with one deferred PATCH /star per message id. The mount
 * refetch GET echoes the seeded items so the background refetch on mount
 * cannot clobber the seeded cache.
 */
function perMessageStarFetch(items: MessageListItem[]): {
  fetchImpl: typeof fetch;
  deferredFor: (messageId: string) => StarDeferred;
} {
  const deferreds = new Map<string, StarDeferred>();
  const deferredFor = (messageId: string): StarDeferred => {
    const existing = deferreds.get(messageId);
    if (existing !== undefined) {
      return existing;
    }
    let resolve!: (response: Response) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<Response>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const created: StarDeferred = { promise, resolve, reject };
    deferreds.set(messageId, created);
    return created;
  };

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    const starMatch = url.match(/\/api\/v1\/mailboxes\/[^/]+\/messages\/([^/]+)\/star$/);
    if (method === 'PATCH' && starMatch !== null) {
      return deferredFor(starMatch[1] as string).promise;
    }
    if (method === 'DELETE' && /\/api\/v1\/mailboxes\/[^/]+\/messages\/[^/]+$/.test(url)) {
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && url.includes('/messages')) {
      return jsonResponse({ data: { items, nextCursor: null } });
    }
    // 400 (not 5xx): never triggers the client's retry backoff.
    return errorResponse('TEST_NO_ROUTE', `no route for ${method} ${url}`, 400);
  }) as unknown as typeof fetch;

  return { fetchImpl, deferredFor };
}

/**
 * Multi-row cache-bound harness. Renders, for every cached item, the real
 * StarButton plus a plain trigger wired to the REAL delete mutation — the
 * H7 tests need a sibling row and a genuine cache removal, not more
 * mocking. Each row's wrapper carries its message id so tests can address
 * rows individually; an absent row renders the row-gone sentinel.
 */
function mountCacheBoundRows(options: {
  fetchImpl: typeof fetch;
  messages: MessageListItem[];
}): void {
  const apiClient = createApiClient({
    baseUrl: '',
    getSessionToken: () => null,
    fetchImpl: options.fetchImpl,
  });
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  const seeded: InfiniteData<MessageListResponse> = {
    pages: [{ items: options.messages, nextCursor: null }],
    pageParams: [undefined],
  };
  queryClient.setQueryData(mailboxQueryKeys.messages(MAILBOX_ID), seeded);

  function RowActions(props: { message: MessageListItem }): ReactElement {
    const deleteMessage = useDeleteMessageMutation();
    return (
      <>
        <StarButton mailboxId={MAILBOX_ID} message={props.message} />
        <button
          type="button"
          data-testid={`delete-${props.message.id}`}
          onClick={() => {
            deleteMessage.mutate({ mailboxId: MAILBOX_ID, messageId: props.message.id });
          }}
        >
          Delete
        </button>
      </>
    );
  }

  function CacheBoundRows(): ReactElement {
    const query = mailboxMessagesInfiniteQuery(MAILBOX_ID);
    const items = query.data?.pages.flatMap((page) => page.items) ?? [];
    if (items.length === 0) {
      return <div data-testid="row-gone" />;
    }
    return (
      <>
        {items.map((item) => (
          <div key={item.id} data-message-id={item.id}>
            <RowActions message={item} />
          </div>
        ))}
      </>
    );
  }

  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <CacheBoundRows />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
}

function starButtonForRow(messageId: string): HTMLElement {
  const row = document.querySelector(`[data-message-id="${messageId}"]`);
  if (row === null) {
    throw new Error(`row for ${messageId} not found`);
  }
  return within(row as HTMLElement).getByTestId('inbox-star-button');
}

describe('StarButton — Slice 3 fix pass (H7 row-scoped rollback, H10 server truth)', () => {
  it("H7: two failed stars roll back independently — B's rollback does not resurrect A's optimistic star", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const messageA = messageFixture(0, '00000000-0000-4000-8000-00000000000a');
      const messageB = messageFixture(0, '00000000-0000-4000-8000-00000000000b');
      const { fetchImpl, deferredFor } = perMessageStarFetch([messageA, messageB]);
      mountCacheBoundRows({ fetchImpl, messages: [messageA, messageB] });

      const buttonA = starButtonForRow(messageA.id);
      const buttonB = starButtonForRow(messageB.id);
      expect(buttonA).toHaveAttribute('aria-pressed', 'false');
      expect(buttonB).toHaveAttribute('aria-pressed', 'false');

      const user = userEvent.setup();
      await user.click(buttonA);
      await user.click(buttonB);

      // Both optimistic flips are live at once.
      await waitFor(() => {
        expect(starButtonForRow(messageA.id)).toHaveAttribute('aria-pressed', 'true');
        expect(starButtonForRow(messageB.id)).toHaveAttribute('aria-pressed', 'true');
      });

      // Reject A FIRST, then B. Under the old whole-snapshot restore, B's
      // onError ran last and re-applied a snapshot taken AFTER A's
      // optimistic flip — leaving A starred with no server confirmation.
      // The row-scoped inverse flip must roll each row back alone.
      deferredFor(messageA.id).reject(new Error('star A failed'));
      await waitFor(() => {
        expect(starButtonForRow(messageA.id)).toHaveAttribute('aria-pressed', 'false');
      });
      deferredFor(messageB.id).reject(new Error('star B failed'));
      await waitFor(() => {
        expect(starButtonForRow(messageB.id)).toHaveAttribute('aria-pressed', 'false');
      });

      // The H7 regression assertion: A stayed rolled back after B's error.
      expect(starButtonForRow(messageA.id)).toHaveAttribute('aria-pressed', 'false');
      expect(starButtonForRow(messageB.id)).toHaveAttribute('aria-pressed', 'false');

      // Both failures warned (G9) — one warn per failed mutation.
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('toggle-message-star failed', expect.anything());
    } finally {
      warn.mockRestore();
    }
  });

  it('H7: a star failing AFTER the row was deleted does not resurrect the row', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const message = messageFixture(0, '00000000-0000-4000-8000-00000000000c');
      const { fetchImpl, deferredFor } = perMessageStarFetch([message]);
      mountCacheBoundRows({ fetchImpl, messages: [message] });

      const user = userEvent.setup();
      // Star first — optimistic flip visible, PATCH still pending.
      await user.click(starButtonForRow(message.id));
      await waitFor(() => {
        expect(starButtonForRow(message.id)).toHaveAttribute('aria-pressed', 'true');
      });

      // Delete lands while the star PATCH is still in flight — the row
      // leaves the cache via the mutation's success filter.
      await user.click(screen.getByTestId(`delete-${message.id}`));
      await waitFor(() => {
        expect(screen.getByTestId('row-gone')).toBeInTheDocument();
      });

      // Now the star PATCH fails. The old snapshot restore would have
      // re-applied a cache containing the deleted row; the functional
      // inverse flip no-ops on an absent row.
      deferredFor(message.id).reject(new Error('star failed after delete'));
      await waitFor(() => {
        expect(warn).toHaveBeenCalledWith('toggle-message-star failed', expect.anything());
      });
      expect(screen.getByTestId('row-gone')).toBeInTheDocument();
    } finally {
      warn.mockRestore();
    }
  });

  it('H10: aria-pressed settles to the SERVER-confirmed value even when it contradicts the optimistic flip', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { fetchImpl, resolveStar } = deferredStarFetch();
      mountCacheBoundStarButton({ fetchImpl, initialMessage: messageFixture(0) });

      const button = await screen.findByTestId('inbox-star-button');
      expect(button).toHaveAttribute('aria-pressed', 'false');

      const user = userEvent.setup();
      await user.click(button);

      // Optimistic: starred while pending.
      await waitFor(() => {
        expect(screen.getByTestId('inbox-star-button')).toHaveAttribute('aria-pressed', 'true');
      });

      // The server is the truth (another member may have toggled
      // concurrently — D-CAP-043-A): it answers isStarred 0, the OPPOSITE
      // of the optimistic guess. The button must settle to the server
      // value, not keep the guess.
      resolveStar(jsonResponse({ data: { id: MESSAGE_ID, isStarred: 0 } }));
      await waitFor(() => {
        expect(screen.getByTestId('inbox-star-button')).toHaveAttribute('aria-pressed', 'false');
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
