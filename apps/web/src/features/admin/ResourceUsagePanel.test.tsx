import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { resourceUsageFixture } from '@unimailbox/test-kit/resource-usage';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { setLanguage } from '../../infrastructure/i18n/locale';
import { ResourceUsagePanel, summarize } from './ResourceUsagePanel';

afterEach(() => {
  cleanup();
  setLanguage('en');
  vi.restoreAllMocks();
});
function setup(handler?: (days: 7 | 30) => Response) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes('/auth/me'))
      return Response.json({
        data: {
          user: { id: 'admin', email: 'admin@example.test', name: 'Admin' },
          session: { userId: 'admin', expiresAt: '2099-01-01T00:00:00Z' },
        },
      });
    const days = url.includes('days=30') ? 30 : 7;
    return handler?.(days) ?? Response.json({ data: resourceUsageFixture(days) });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <ApiClientProvider
        client={createApiClient({ baseUrl: '', getSessionToken: () => null, fetchImpl: fetcher })}
      >
        <ResourceUsagePanel />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return fetcher;
}
describe('R-ANALYTICS-001/002 resource dashboard', () => {
  it('switches ranges and resources, provides daily values and uses storage maxima', async () => {
    setup();
    await screen.findByRole('button', { name: /Worker requests/ });
    fireEvent.click(screen.getByRole('button', { name: /Worker errors/ }));
    expect(screen.getByRole('button', { name: /Worker errors/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Last 30 days' }));
    fireEvent.click(screen.getByRole('button', { name: 'R2' }));
    await screen.findByRole('button', { name: /R2 stored bytes/ });
    fireEvent.click(screen.getByText('View daily values'));
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(31);
    expect(screen.getByText('2026-09-17')).toBeInTheDocument();
    expect(screen.getAllByText('Period maximum').length).toBeGreaterThan(0);
  });
  it('keeps missing samples distinct from real zero and exposes values on keyboard focus', async () => {
    setup();
    await screen.findByRole('button', { name: /Worker errors/ });
    fireEvent.click(screen.getByRole('button', { name: /Worker errors/ }));
    const zero = screen.getByRole('img', { name: '2026-10-16: 0' });
    expect(screen.getByRole('img', { name: '2026-10-10: No data' })).toBeInTheDocument();
    fireEvent.focus(zero);
    expect(screen.getByText('2026-10-16 · 0')).toBeInTheDocument();
  });
  it('shows isolated forbidden and unconfigured states with Chinese translations', async () => {
    setLanguage('zh-CN');
    setup();
    await screen.findByRole('button', { name: /Worker 请求数/ });
    fireEvent.click(screen.getByRole('button', { name: 'KV' }));
    expect(screen.getByText('资源统计访问被拒绝')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Queue' }));
    expect(screen.getByText('接入资源统计')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '最近 7 天' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
  it('handles no samples and recovers a failed refresh without discarding existing data', async () => {
    let failing = false;
    setup(() =>
      failing
        ? new Response('{}', { status: 502 })
        : Response.json({ data: resourceUsageFixture() }),
    );
    await screen.findByRole('button', { name: /Worker requests/ });
    failing = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    await screen.findByTestId('resource-usage-error');
    expect(screen.getByRole('button', { name: /Worker requests/ })).toBeInTheDocument();
    failing = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(screen.queryByTestId('resource-usage-error')).not.toBeInTheDocument(),
    );
  });
  it('does not refetch on focus/reconnect and allows explicit refresh', async () => {
    const fetcher = setup();
    await screen.findByRole('button', { name: /Worker requests/ });
    const count = () =>
      fetcher.mock.calls.filter(([url]) => String(url).includes('/resource-usage')).length;
    expect(count()).toBe(1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    expect(count()).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    await waitFor(() => expect(count()).toBe(2));
  });
  it('does not expose provider data to a user lacking analytics.read', async () => {
    setup(() =>
      Response.json({ error: { code: 'PERMISSION_DENIED', message: 'Denied' } }, { status: 403 }),
    );
    await screen.findByText('You do not have permission to view resource usage.');
    expect(screen.queryByRole('button', { name: /Worker requests/ })).not.toBeInTheDocument();
  });
  it('hides previously cached metrics when permission is revoked during refresh', async () => {
    let revoked = false;
    setup(() =>
      revoked
        ? Response.json(
            { error: { code: 'PERMISSION_DENIED', message: 'Denied' } },
            { status: 403 },
          )
        : Response.json({ data: resourceUsageFixture() }),
    );
    await screen.findByRole('button', { name: /Worker requests/ });
    revoked = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    await screen.findByText('You do not have permission to view resource usage.');
    expect(screen.queryByRole('button', { name: /Worker requests/ })).not.toBeInTheDocument();
  });
  it('summarizes counter totals and storage peaks without treating missing points as zero', () => {
    const fixture = resourceUsageFixture();
    const metric = fixture.services[0]?.metrics[0];
    if (!metric) throw new Error('Missing fixture');
    expect(summarize({ ...metric, points: [{ date: '2026-10-16', value: null }] })).toBeNull();
    expect(
      summarize({
        ...metric,
        points: [
          { date: '2026-10-15', value: 10 },
          { date: '2026-10-16', value: 20 },
        ],
      }),
    ).toBe(30);
    expect(
      summarize({
        ...metric,
        aggregation: 'max',
        points: [
          { date: '2026-10-15', value: 10 },
          { date: '2026-10-16', value: 20 },
        ],
      }),
    ).toBe(20);
  });
});
