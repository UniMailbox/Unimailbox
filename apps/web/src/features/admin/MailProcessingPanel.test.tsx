import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { mailProcessingFixture, resourceUsageFixture } from '@unimailbox/test-kit/resource-usage';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import { createApiClient } from '../../infrastructure/api/client';
import { setLanguage } from '../../infrastructure/i18n/locale';
import { MailProcessingPanel } from './MailProcessingPanel';
import { ResourceUsagePanel } from './ResourceUsagePanel';
import { summarize } from './ResourceMetricChart';
afterEach(() => {
  cleanup();
  setLanguage('en');
});
function setup(handler?: (days: 7 | 30) => Response) {
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = String(input);
    if (url.includes('/auth/me'))
      return Response.json({ data: { user: { id: 'admin', email: 'admin@example.test' } } });
    if (url.includes('/resource-usage')) {
      const data = resourceUsageFixture();
      data.services = data.services.map((s) => ({ ...s, status: 'not_configured', metrics: [] }));
      return Response.json({ data });
    }
    const days = url.includes('days=30') ? 30 : 7;
    return handler?.(days) ?? Response.json({ data: mailProcessingFixture(days) });
  });
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}
    >
      <ApiClientProvider
        client={createApiClient({ baseUrl: '', getSessionToken: () => null, fetchImpl: fetcher })}
      >
        <ResourceUsagePanel />
        <MailProcessingPanel />
      </ApiClientProvider>
    </QueryClientProvider>,
  );
  return fetcher;
}
describe('R-ANALYTICS-003 two resource sections', () => {
  it('shows mail metadata independently of unconfigured Cloudflare analytics, with independent date controls', async () => {
    const fetcher = setup();
    await screen.findByRole('button', { name: /Retained inbound messages/ });
    expect(screen.getByRole('heading', { name: 'Cloudflare platform usage' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Mail processing' })).toBeInTheDocument();
    expect(screen.getByText('Connect resource analytics')).toBeInTheDocument();
    const mail = within(screen.getByTestId('mail-processing'));
    fireEvent.click(mail.getByRole('button', { name: 'Last 30 days' }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(([url]) => String(url).includes('mail-processing?days=30')),
      ).toBe(true),
    );
    fireEvent.click(await mail.findByText('View mail daily values'));
    await waitFor(() => expect(mail.getAllByRole('row')).toHaveLength(31));
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).includes('resource-usage')).length,
    ).toBe(1);
  });
  it('uses weighted sample averages rather than averaging daily averages', async () => {
    setup();
    await screen.findByRole('button', { name: /Retained inbound messages/ });
    const mail = within(screen.getByTestId('mail-processing'));
    fireEvent.click(mail.getByRole('button', { name: 'Outbound processing' }));
    expect(mail.getByRole('button', { name: /Created-to-sent latency/ })).toHaveTextContent('5 s');
    fireEvent.click(mail.getByText('View mail daily values'));
    expect(mail.getByRole('columnheader', { name: 'Samples' })).toBeInTheDocument();
    const metric = mailProcessingFixture().groups[2]?.metrics[0];
    if (!metric) throw new Error('Missing fixture');
    expect(summarize(metric)).toBe(5000);
  });
  it('labels retained receipts and missing historical samples in Chinese', async () => {
    setLanguage('zh-CN');
    setup();
    await screen.findByRole('button', { name: /保留的收信邮件数/ });
    const mail = within(screen.getByTestId('mail-processing'));
    fireEvent.click(mail.getByRole('button', { name: '保留回执样本' }));
    expect(mail.getByText(/完成的收信回执约 24 小时后清理/)).toBeInTheDocument();
    expect(mail.getByRole('img', { name: '2026-10-10: 暂无数据' })).toBeInTheDocument();
    expect(mail.getByRole('button', { name: /最大原始邮件样本/ })).toHaveTextContent('25 MiB');
  });
  it('hides cached mail metrics after authorization is revoked', async () => {
    let denied = false;
    setup(() =>
      denied
        ? Response.json(
            { error: { code: 'PERMISSION_DENIED', message: 'Denied' } },
            { status: 403 },
          )
        : Response.json({ data: mailProcessingFixture() }),
    );
    await screen.findByRole('button', { name: /Retained inbound messages/ });
    denied = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh mail statistics' }));
    await screen.findByText('You do not have permission to view resource usage.');
    expect(
      screen.queryByRole('button', { name: /Retained inbound messages/ }),
    ).not.toBeInTheDocument();
  });
  it('offers explicit retry without focus/reconnect polling and handles oversized cohorts honestly', async () => {
    let failing = true;
    const fetcher = setup((days) => {
      if (failing) return new Response('{}', { status: 503 });
      const data = mailProcessingFixture(days);
      data.groups[0] = { id: 'mail', status: 'limit_exceeded', metrics: [] };
      return Response.json({ data });
    });
    const mail = within(screen.getByTestId('mail-processing'));
    await mail.findByRole('button', { name: 'Retry' });
    const count = () =>
      fetcher.mock.calls.filter(([url]) => String(url).includes('/mail-processing')).length;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
    });
    expect(count()).toBe(1);
    failing = false;
    fireEvent.click(mail.getByRole('button', { name: 'Retry' }));
    await mail.findByText(/exceeds the 5,000-record statistics limit/);
    expect(
      mail.queryByRole('button', { name: /Retained inbound messages/ }),
    ).not.toBeInTheDocument();
  });
});
