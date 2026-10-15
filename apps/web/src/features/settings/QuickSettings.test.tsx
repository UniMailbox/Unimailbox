import { afterEach, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_PERSONAL_PREFERENCES, type PersonalSettings } from '@unimailbox/contracts';
import { renderAuthPage, jsonResponse, errorResponse } from '../../test-utils';
import { setLanguage } from '../../infrastructure/i18n/locale';
import { PersonalSettingsProvider } from './personal-settings-context';
import { QuickSettings } from './QuickSettings';
const userId = '00000000-0000-4000-8000-000000000001';
const mailboxId = '00000000-0000-4000-8000-000000000002';
afterEach(() => {
  setLanguage('en');
  document.documentElement.classList.remove('dark');
});
function harness(fail = false, pendingPreferences?: Promise<void>) {
  let saved: PersonalSettings = {
    preferences: { ...DEFAULT_PERSONAL_PREFERENCES },
    avatarVersion: null,
    avatarContentType: null,
  };
  const writes: unknown[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path.endsWith('/auth/me/preferences')) {
      if (init?.method !== 'PATCH') await pendingPreferences;
      if (init?.method === 'PATCH') {
        const patch = JSON.parse(String(init.body)) as Record<string, unknown>;
        writes.push(patch);
        if (fail) return errorResponse('PERMISSION_DENIED', 'raw backend diagnostic', 403);
        saved = { ...saved, preferences: { ...saved.preferences, ...patch } };
      }
      return jsonResponse({ data: saved });
    }
    if (path.endsWith('/auth/me/mcp'))
      return jsonResponse({
        data: {
          enabled: false,
          endpoint: 'https://mail.example.test/api/mcp',
          promptTemplate: '{{endpoint}}',
          tokens: [],
          mailboxes: [],
        },
      });
    if (path.endsWith('/auth/me'))
      return jsonResponse({
        data: { user: { id: userId, email: 'member@example.com', displayName: 'Tester' } },
      });
    if (path.endsWith('/mailboxes'))
      return jsonResponse({
        data: {
          items: [
            {
              id: mailboxId,
              domainId: userId,
              ownerUserId: userId,
              address: 'member@example.com',
              localPart: 'member',
              displayName: '',
              status: 'active',
            },
          ],
          nextCursor: null,
        },
      });
    throw new Error('Unexpected request');
  }) as typeof fetch;
  async function mount() {
    return renderAuthPage({
      fetchImpl,
      authSession: { userId, email: 'member@example.com', displayName: 'Tester', expiresAt: '' },
      login: (
        <PersonalSettingsProvider>
          <QuickSettings open onOpenChange={() => {}} />
        </PersonalSettingsProvider>
      ),
    });
  }
  return { mount, writes };
}
it('saves independent preferences and restores the server language when mounted again', async () => {
  const { mount, writes } = harness();
  const view = await mount();
  const user = userEvent.setup();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Change language' })).toBeEnabled(),
  );
  await user.selectOptions(screen.getByLabelText('Default mailbox'), mailboxId);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Change language' })).toBeEnabled(),
  );
  await user.click(screen.getByLabelText('Compact'));
  await waitFor(() => expect(document.documentElement.dataset.density).toBe('compact'));
  await user.click(screen.getByLabelText('Below inbox'));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Change theme' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Change theme' }));
  await user.click(screen.getByRole('menuitem', { name: 'Dark' }));
  await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
  await user.click(screen.getByRole('button', { name: 'Change language' }));
  await user.click(screen.getByRole('menuitem', { name: '简体中文' }));
  expect(await screen.findByText('快捷设置')).toBeInTheDocument();
  expect(screen.getByLabelText('默认邮箱')).toHaveValue(mailboxId);
  expect(writes).toEqual([
    { defaultMailboxId: mailboxId },
    { density: 'compact' },
    { readingPane: 'bottom' },
    { theme: 'dark' },
    { language: 'zh-CN' },
  ]);
  view.unmount();
  await mount();
  expect(await screen.findByText('快捷设置')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: '切换语言' })).toBeEnabled());
  expect(document.documentElement).toHaveClass('dark');
});
it('keeps the last saved choice and displays localized code-based errors when a write fails', async () => {
  const { mount } = harness(true);
  await mount();
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByLabelText('Compact')).toBeEnabled());
  await user.click(screen.getByLabelText('Compact'));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'You do not have permission for this action.',
  );
  expect(screen.getByLabelText('Comfortable')).toBeChecked();
  expect(screen.queryByText('raw backend diagnostic')).toBeNull();
});
it('keeps the preference menu open and the saved theme when its account update fails', async () => {
  const { mount } = harness(true);
  await mount();
  const user = userEvent.setup();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Change theme' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Change theme' }));
  await user.click(screen.getByRole('menuitem', { name: 'Dark' }));
  await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
  expect(screen.getByRole('menu')).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'System' })).toHaveAttribute('aria-current', 'true');
  expect(document.documentElement).not.toHaveClass('dark');
  expect(screen.queryByText('raw backend diagnostic')).toBeNull();
});

it('waits for account preferences before displaying selectable default values', async () => {
  let resolvePreferences!: () => void;
  const pending = new Promise<void>((resolve) => {
    resolvePreferences = resolve;
  });
  const { mount } = harness(false, pending);
  await mount();
  expect(await screen.findByTestId('quick-settings-loading')).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByLabelText('Default mailbox')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Comfortable')).not.toBeInTheDocument();
  resolvePreferences();
  expect(await screen.findByLabelText('Default mailbox')).toBeEnabled();
  expect(screen.queryByTestId('quick-settings-loading')).not.toBeInTheDocument();
});
