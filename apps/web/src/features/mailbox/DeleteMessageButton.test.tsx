// apps/web — DeleteMessageButton tests.
//
// CAP-043 Slice 3 (AC 15 + AC 16). The delete action is confirmed:
// clicking Delete only OPENS the dialog; cancel sends nothing; confirm
// fires exactly one DELETE (with a minted Idempotency-Key,
// D-CAP-041-2), and the 204 (D-CAP-043-E) removes the row from the
// inbox infinite cache via structural setQueryData.
//
// The cache-bound row harness mirrors InboxListPage's derivation from
// `mailboxMessagesInfiniteQuery`, so `row-gone` appearing IS the cache
// removal proof — the same write the real page renders from.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import type { MessageListItem, MessageListResponse } from '@unimailbox/contracts';
import { DeleteMessageButton } from './DeleteMessageButton';
import { mailboxMessagesInfiniteQuery, mailboxQueryKeys } from './mailbox-queries';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { errorResponse, jsonResponse } from '../../test-utils';

afterEach(() => {
  cleanup();
});

const MAILBOX_ID = 'mb-1';
const MESSAGE_ID = '00000000-0000-4000-8000-00000000000a';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function messageFixture(): MessageListItem {
  return {
    id: MESSAGE_ID,
    fromAddress: 'sender@example.com',
    fromName: 'Sender',
    subject: 'Delete me',
    isRead: 0,
    isStarred: 0,
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

interface RouteHandler {
  match: (url: string, method: string) => boolean;
  // Slice 3 fix pass: a route may hold its response (Promise<Response>) so
  // tests can observe the pending window — H8 asserts Confirm is disabled
  // while the DELETE is in flight.
  response: () => Response | Promise<Response>;
}

/** URL+method dispatch with header capture (MessageDetailPage pattern). */
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
    calls.push({ url, method, headers });
    const route = routes.find((candidate) => candidate.match(url, method));
    if (route === undefined) {
      // 400 (not 5xx): a missing test route must not trigger the
      // client's retry backoff and hang the test. It also records the
      // call, so "cancel sends nothing" assertions still see it.
      return errorResponse('TEST_NO_ROUTE', `no route for ${method} ${url}`, 400);
    }
    return route.response();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function inboxRoute(): RouteHandler {
  return {
    match: (url, method) =>
      method === 'GET' && url.includes(`/api/v1/mailboxes/${MAILBOX_ID}/messages`),
    response: () => jsonResponse({ data: { items: [messageFixture()], nextCursor: null } }),
  };
}

function mountCacheBoundDeleteButton(fetchImpl: typeof fetch): {
  queryClient: QueryClient;
} {
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
  const seeded: InfiniteData<MessageListResponse> = {
    pages: [{ items: [messageFixture()], nextCursor: null }],
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
    return <DeleteMessageButton mailboxId={MAILBOX_ID} message={item} />;
  }

  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <CacheBoundRow />
      </ApiClientProvider>
    </QueryClientProvider>,
  );

  // H11 tests seed/inspect the detail + thread cache entries through the
  // same client the mutation writes to.
  return { queryClient };
}

describe('DeleteMessageButton', () => {
  it('cancel sends nothing — the dialog opens and closes without any DELETE request', async () => {
    const { fetchImpl, calls } = dispatchFetch([inboxRoute()]);
    mountCacheBoundDeleteButton(fetchImpl);

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('inbox-delete-button'));

    // The confirmation is visible before anything is sent.
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
    expect(screen.getByTestId('alert-dialog-confirm')).toBeInTheDocument();

    await user.click(screen.getByTestId('alert-dialog-cancel'));

    await waitFor(() => {
      expect(screen.queryByTestId('alert-dialog')).not.toBeInTheDocument();
    });
    // No request beyond the inbox mount refetch — cancel is a pure UI
    // decision. (An accidental DELETE would land in `calls` even if it
    // errored as TEST_NO_ROUTE.)
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    // The row is untouched.
    expect(screen.queryByTestId('row-gone')).not.toBeInTheDocument();
  });

  it('confirm fires one DELETE with a minted Idempotency-Key, and the 204 removes the row from the inbox cache', async () => {
    const { fetchImpl, calls } = dispatchFetch([
      inboxRoute(),
      {
        match: (url, method) =>
          method === 'DELETE' && url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}`,
        // D-CAP-043-E: 204 No Content, empty body.
        response: () => new Response(null, { status: 204 }),
      },
    ]);
    mountCacheBoundDeleteButton(fetchImpl);

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('inbox-delete-button'));
    await user.click(screen.getByTestId('alert-dialog-confirm'));

    // Exactly one DELETE to the message URL with a client-minted UUID
    // Idempotency-Key (D-CAP-041-2).
    await waitFor(() => {
      expect(screen.getByTestId('row-gone')).toBeInTheDocument();
    });
    const deleteCalls = calls.filter((call) => call.method === 'DELETE');
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]?.url).toBe(`/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}`);
    expect(deleteCalls[0]?.headers['idempotency-key']).toMatch(UUID_PATTERN);

    // The structural setQueryData removed the message from the infinite
    // cache — the cache-bound row can no longer derive it.
    expect(screen.queryByTestId('inbox-delete-button')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Slice 3 fix pass — H8 (failed delete is visible, dialog stays open),
// H11 (detail + thread cache entries dropped), H12 (dialog semantics +
// trigger accessible name).
// ---------------------------------------------------------------------------

describe('DeleteMessageButton — Slice 3 fix pass (H8/H11/H12)', () => {
  it('H8: a failed DELETE keeps the dialog open with an inline error and the row present, warns once, then a re-confirm succeeds', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Hold the first DELETE response so the pending window is
      // observable; after the failure flag flips, later DELETEs answer
      // 204 immediately.
      let failDelete = true;
      let settleDelete: () => void = () => {};
      const { fetchImpl } = dispatchFetch([
        inboxRoute(),
        {
          match: (url, method) =>
            method === 'DELETE' && url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}`,
          response: () => {
            if (!failDelete) {
              return new Response(null, { status: 204 });
            }
            return new Promise<Response>((resolve) => {
              // 403: non-retryable, immediate rejection as ApiError.
              settleDelete = () => resolve(errorResponse('MAILBOX_ACCESS_DENIED', 'denied', 403));
            });
          },
        },
      ]);
      mountCacheBoundDeleteButton(fetchImpl);

      const user = userEvent.setup();
      await user.click(await screen.findByTestId('inbox-delete-button'));
      await user.click(screen.getByTestId('alert-dialog-confirm'));

      // While in flight: Confirm is disabled (no double submit) and no
      // error is shown yet.
      await waitFor(() => {
        expect(screen.getByTestId('alert-dialog-confirm')).toBeDisabled();
      });

      // The DELETE fails. H8: the dialog STAYS open, the failure shows
      // inline, and the row stays.
      settleDelete();
      await waitFor(() => {
        expect(screen.getByTestId('alert-dialog-error')).toBeInTheDocument();
      });
      expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();
      expect(screen.getByTestId('alert-dialog-error').textContent).toContain(
        'The message was not deleted',
      );
      expect(screen.queryByTestId('row-gone')).not.toBeInTheDocument();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        'delete-message failed',
        expect.objectContaining({ code: 'MAILBOX_ACCESS_DENIED' }),
      );

      // Confirm re-enabled after the failure; a fresh confirm now gets a
      // 204 and the flow completes: dialog closed, row gone.
      expect(screen.getByTestId('alert-dialog-confirm')).not.toBeDisabled();
      failDelete = false;
      await user.click(screen.getByTestId('alert-dialog-confirm'));
      await waitFor(() => {
        expect(screen.getByTestId('row-gone')).toBeInTheDocument();
      });
      expect(screen.queryByTestId('alert-dialog')).not.toBeInTheDocument();
    } finally {
      warn.mockRestore();
    }
  });

  it('H12: the dialog is an alertdialog with aria-modal, an accessible name, and the trigger names its subject', async () => {
    const { fetchImpl } = dispatchFetch([inboxRoute()]);
    mountCacheBoundDeleteButton(fetchImpl);

    const user = userEvent.setup();

    // Trigger: subject-qualified accessible name (H12) — a bare "Delete"
    // beside every row is indistinguishable in the accessibility tree.
    const trigger = await screen.findByTestId('inbox-delete-button');
    expect(trigger).toHaveAccessibleName('Delete message: Delete me');

    await user.click(trigger);

    const dialog = screen.getByTestId('alert-dialog');
    expect(dialog).toHaveAttribute('role', 'alertdialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Delete this message?');
  });

  it('H12: initial focus lands on the CANCEL button (the non-destructive choice)', async () => {
    const { fetchImpl } = dispatchFetch([inboxRoute()]);
    mountCacheBoundDeleteButton(fetchImpl);

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('inbox-delete-button'));

    expect(screen.getByTestId('alert-dialog-cancel')).toHaveFocus();
  });

  it('H12: Escape cancels the dialog without sending a DELETE', async () => {
    const { fetchImpl, calls } = dispatchFetch([inboxRoute()]);
    mountCacheBoundDeleteButton(fetchImpl);

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('inbox-delete-button'));
    expect(screen.getByTestId('alert-dialog')).toBeInTheDocument();

    // Initial focus is the cancel button, so the key event originates
    // there and bubbles to the panel's onKeyDown.
    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('alert-dialog')).not.toBeInTheDocument();
    });
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    expect(screen.queryByTestId('row-gone')).not.toBeInTheDocument();
  });

  it('H11: a successful delete drops the cached detail + thread entries for the message', async () => {
    const { fetchImpl } = dispatchFetch([
      inboxRoute(),
      {
        match: (url, method) =>
          method === 'DELETE' && url === `/api/v1/mailboxes/${MAILBOX_ID}/messages/${MESSAGE_ID}`,
        response: () => new Response(null, { status: 204 }),
      },
    ]);
    const { queryClient } = mountCacheBoundDeleteButton(fetchImpl);

    // Seed detail + thread cache entries. Placeholder payloads: the
    // criterion is that the KEYS are dropped, and removeQueries matches by
    // key regardless of the stored value's shape.
    const detailKey = mailboxQueryKeys.message(MAILBOX_ID, MESSAGE_ID);
    const threadKey = mailboxQueryKeys.thread(MAILBOX_ID, MESSAGE_ID);
    queryClient.setQueryData(detailKey, { placeholder: 'detail' });
    queryClient.setQueryData(threadKey, { placeholder: 'thread' });
    expect(queryClient.getQueryData(detailKey)).toBeDefined();
    expect(queryClient.getQueryData(threadKey)).toBeDefined();

    const user = userEvent.setup();
    await user.click(await screen.findByTestId('inbox-delete-button'));
    await user.click(screen.getByTestId('alert-dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('row-gone')).toBeInTheDocument();
    });

    // H11: both sibling entries left the cache — a later visit cannot
    // render a deleted message from cache (the API 404s it).
    expect(queryClient.getQueryData(detailKey)).toBeUndefined();
    expect(queryClient.getQueryData(threadKey)).toBeUndefined();
  });
});
