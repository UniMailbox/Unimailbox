import { afterEach, describe, expect, it } from 'vitest';
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
import { DEFAULT_SYSTEM_SETTINGS } from '@unimailbox/contracts';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { authQueryKeys } from '../auth/auth-queries';
import { resetAuthSessionForTesting } from '../auth/auth-session-store';
import { errorResponse, jsonResponse } from '../../test-utils';
import { SettingsPage } from './SettingsPage';

afterEach(() => {
  cleanup();
  resetAuthSessionForTesting();
});

const SESSION = {
  userId: 'u-settings-admin',
  email: 'admin@example.com',
  displayName: 'Admin',
  expiresAt: '2099-01-01T00:00:00Z',
};

function settings(
  settingOverrides: Record<string, unknown> = {},
  responseOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    settings: { ...DEFAULT_SYSTEM_SETTINGS, ...settingOverrides },
    environment: 'local',
    canManage: true,
    updatedAt: '2026-09-01 00:00:00',
    ...responseOverrides,
  };
}

function mountPage(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): {
  calls: Array<{ url: string; method: string; body?: string }>;
} {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? 'GET',
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });
    if (url.includes('/api/v1/auth/me')) {
      return jsonResponse({
        data: {
          user: { id: SESSION.userId, email: SESSION.email, name: SESSION.displayName },
          session: { userId: SESSION.userId, expiresAt: SESSION.expiresAt },
        },
      });
    }
    return handler(url, init);
  };
  const apiClient = createApiClient({ baseUrl: '', getSessionToken: () => null, fetchImpl });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(authQueryKeys.session(), SESSION);
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin/settings',
    component: SettingsPage,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/admin/settings'] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <RouterProvider router={router} />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return { calls };
}

describe('SettingsPage (CAP-069)', () => {
  it('shows a non-interactive skeleton until settings arrive, then replaces it with the form', async () => {
    let resolveSettings!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSettings = resolve;
    });
    mountPage(() => pending);
    const loading = await screen.findByTestId('admin-loading');
    expect(loading.querySelector('[role="status"]')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByLabelText('Site title')).not.toBeInTheDocument();
    expect(loading.querySelector('button, input, select')).toBeNull();
    resolveSettings(jsonResponse({ data: settings({ siteTitle: 'Ready mailbox' }) }));
    expect(await screen.findByText('Ready mailbox')).toBeInTheDocument();
    expect(screen.queryByTestId('settings-form')).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit settings' }));
    expect(screen.getByLabelText('Site title')).toHaveValue('Ready mailbox');
    expect(screen.queryByTestId('admin-loading')).not.toBeInTheDocument();
  });

  it('keeps form values visible and blocks duplicate saves while showing a busy button', async () => {
    let resolveSave!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveSave = resolve;
    });
    const { calls } = mountPage((_url, init) =>
      init?.method === 'PATCH' ? pending : jsonResponse({ data: settings() }),
    );
    await userEvent.setup().click(await screen.findByRole('button', { name: 'Edit settings' }));
    const title = await screen.findByLabelText('Site title');
    const user = userEvent.setup();
    await user.clear(title);
    await user.type(title, 'Operations');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    const busy = await screen.findByRole('button', { name: 'Saving…' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toBeDisabled();
    expect(busy.querySelector('[data-testid="spinner"]')).toHaveAttribute('aria-hidden', 'true');
    expect(title).toHaveValue('Operations');
    await user.click(busy);
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
    resolveSave(jsonResponse({ data: settings({ siteTitle: 'Operations' }) }));
    expect(await screen.findByTestId('settings-success')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('R-SETTINGS-007 renders, edits, and saves settings with a success state', async () => {
    const { calls } = mountPage((url, init) => {
      if ((init?.method ?? 'GET') === 'GET') return jsonResponse({ data: settings() });
      return jsonResponse({ data: settings({ siteTitle: 'Operations' }) });
    });
    await waitFor(() => expect(screen.getByTestId('admin-settings-page')).toBeInTheDocument());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit settings' }));
    const title = screen.getByLabelText('Site title');
    await user.clear(title);
    await user.type(title, 'Operations');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.getByTestId('settings-success')).toBeInTheDocument());
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(JSON.parse(patch?.body ?? '')).toMatchObject({ siteTitle: 'Operations' });
  });

  it('edits the attachment limit as a value and unit, defaulting to 100 MB', async () => {
    const { calls } = mountPage((_url, init) =>
      jsonResponse({ data: settings((init?.method ?? 'GET') === 'PATCH' ? {} : {}) }),
    );
    await waitFor(() => expect(screen.getByTestId('admin-settings-page')).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit settings' }));
    expect(screen.getByLabelText('Maximum attachment size')).toHaveValue(100);
    expect(screen.getByRole('combobox', { name: 'Attachment size unit' })).toHaveTextContent('MB');

    const user = userEvent.setup();
    await user.clear(screen.getByLabelText('Maximum attachment size'));
    await user.type(screen.getByLabelText('Maximum attachment size'), '50');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.getByTestId('settings-success')).toBeInTheDocument());
    expect(JSON.parse(calls.find((call) => call.method === 'PATCH')?.body ?? '')).toMatchObject({
      maxAttachmentBytes: 50 * 1024 * 1024,
    });
  });

  it('submits switch and select values using the existing settings contract', async () => {
    const { calls } = mountPage((_url, init) =>
      jsonResponse({
        data: settings(
          (init?.method ?? 'GET') === 'PATCH'
            ? { inboundEnabled: false, unknownRecipientPolicy: 'store' }
            : {},
        ),
      }),
    );
    expect(await screen.findByTestId('admin-settings-page')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit settings' }));
    await user.click(screen.getByRole('switch', { name: 'Inbound mail enabled' }));
    await user.click(screen.getByRole('combobox', { name: 'Unknown recipient policy' }));
    await user.click(screen.getByRole('option', { name: 'Store unknown recipients' }));
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    expect(await screen.findByTestId('settings-success')).toBeInTheDocument();
    expect(JSON.parse(calls.find((call) => call.method === 'PATCH')?.body ?? '')).toMatchObject({
      inboundEnabled: false,
      unknownRecipientPolicy: 'store',
    });
  });

  it('shows an unsaved status instead of presenting the default epoch as a save date', async () => {
    mountPage(() =>
      jsonResponse({ data: settings({}, { updatedAt: '1970-01-01T00:00:00.000Z' }) }),
    );
    expect(await screen.findByTestId('settings-runtime-info')).toHaveTextContent('Not saved yet');
    expect(screen.queryByText(/Jan 1, 1970/)).not.toBeInTheDocument();
  });

  it('keeps public registration visibly disabled', async () => {
    mountPage((url, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? jsonResponse({ data: settings({ registrationEnabled: true }) })
        : jsonResponse({ data: settings() }),
    );
    await waitFor(() => expect(screen.getByTestId('admin-settings-page')).toBeInTheDocument());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit settings' }));
    const registration = screen.getByRole('checkbox', {
      name: /public registration disabled/i,
    });
    expect(registration).toBeDisabled();
    expect(registration).not.toBeChecked();
  });

  it('R-SETTINGS-007 renders a reader as read-only', async () => {
    mountPage((url, init) =>
      (init?.method ?? 'GET') === 'GET'
        ? jsonResponse({ data: settings({}, { canManage: false }) })
        : jsonResponse({ data: settings({}, { canManage: false }) }),
    );
    await waitFor(() => expect(screen.getByTestId('settings-read-only-note')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Edit settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Site title')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save settings' })).not.toBeInTheDocument();
  });

  it('R-SETTINGS-007 hides stale cached data on permission denial', async () => {
    mountPage((url) =>
      url.endsWith('/admin/settings')
        ? errorResponse('PERMISSION_DENIED', 'Permission denied', 403)
        : jsonResponse({ data: settings() }),
    );
    await waitFor(() => expect(screen.getByTestId('admin-not-authorized')).toBeInTheDocument());
    expect(screen.queryByTestId('settings-form')).not.toBeInTheDocument();
  });

  it('R-SETTINGS-007 presents schema drift as a retryable client error', async () => {
    mountPage((url) =>
      url.endsWith('/admin/settings')
        ? jsonResponse({ data: { settings: { brevoApiKey: 'secret' } } })
        : jsonResponse({ data: settings() }),
    );
    await waitFor(() => expect(screen.getByTestId('admin-error')).toBeInTheDocument());
    expect(screen.getByTestId('admin-error-panel')).toHaveTextContent('INVALID_RESPONSE');
  });

  it('R-SETTINGS-009 refreshes the revision after a stale update response', async () => {
    let reads = 0;
    let releaseRefresh: (() => void) | undefined;
    const refresh = new Promise<Response>((resolve) => {
      releaseRefresh = () => resolve(jsonResponse({ data: settings({ siteTitle: 'Latest' }) }));
    });
    const user = userEvent.setup();
    mountPage((url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        reads += 1;
        return reads === 1 ? jsonResponse({ data: settings({ siteTitle: 'Initial' }) }) : refresh;
      }
      return errorResponse('STALE_IF_MATCH', 'Settings changed since they were loaded', 412);
    });
    await user.click(await screen.findByRole('button', { name: 'Edit settings' }));
    await waitFor(() => expect(screen.getByDisplayValue('Initial')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.getByTestId('settings-form-error')).toBeInTheDocument());
    expect(screen.getByTestId('settings-refreshing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    releaseRefresh?.();
    await waitFor(() => {
      expect(screen.getByDisplayValue('Latest')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save settings' })).toBeEnabled();
    });
  });

  it('R-SETTINGS-009 keeps edits disabled when the stale-value refresh fails', async () => {
    let reads = 0;
    const user = userEvent.setup();
    mountPage((url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        reads += 1;
        return reads === 1
          ? jsonResponse({ data: settings({ siteTitle: 'Initial' }) })
          : errorResponse('VALIDATION_ERROR', 'Temporary settings failure', 400);
      }
      return errorResponse('STALE_IF_MATCH', 'Settings changed since they were loaded', 412);
    });
    await user.click(await screen.findByRole('button', { name: 'Edit settings' }));
    await waitFor(() => expect(screen.getByDisplayValue('Initial')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(screen.getByTestId('settings-refreshing')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Refreshing…' })).toBeDisabled();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Retry loading latest settings' }),
      ).toBeInTheDocument(),
    );
  });
});
