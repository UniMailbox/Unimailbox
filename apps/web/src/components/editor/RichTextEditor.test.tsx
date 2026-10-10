// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderBase, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, useState, type ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DEFAULT_SYSTEM_SETTINGS, type EditorUploadPolicy } from '@unimailbox/contracts';
import { RichTextEditor } from './RichTextEditor';
import { ApiClientProvider } from '../../infrastructure/api/client-provider';
import type { ApiClient } from '../../infrastructure/api/client';
afterEach(cleanup);
const defaultPolicy = {
  maxFileBytes: DEFAULT_SYSTEM_SETTINGS.maxAttachmentBytes,
  maxImageBytes: 5 * 1024 * 1024,
};
function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderBase(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}
function withPolicy(
  fetch: ApiClient['fetch'],
  policy: () => EditorUploadPolicy = () => defaultPolicy,
): ApiClient['fetch'] {
  return async <T,>(path: string, init?: Parameters<ApiClient['fetch']>[1]): Promise<T> => {
    if (path === '/api/v1/editor-assets/policy') return { data: policy() } as T;
    return fetch<T>(path, init);
  };
}
// jsdom has no layout geometry; ProseMirror asks for Range rects while scrolling a heading selection.
beforeAll(() => {
  Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
  });
});
const asset = {
  id: '00000000-0000-4000-8000-000000000001',
  filename: 'spec.pdf',
  contentType: 'application/pdf',
  sizeBytes: 3,
  kind: 'file',
  url:
    'https://mail.example.com/api/v1/editor-assets/00000000-0000-4000-8000-000000000001/' +
    'a'.repeat(64),
};
function mount(
  fetch: ApiClient['fetch'],
  onChange = vi.fn(),
  onBusyChange = vi.fn(),
  initial = '',
  policy: () => EditorUploadPolicy = () => defaultPolicy,
): void {
  function Harness() {
    const [html, setHtml] = useState(initial);
    return (
      <RichTextEditor
        id="body"
        label="Body"
        value={html}
        scope={{ mailboxId: 'mailbox' }}
        onChange={(next, text) => {
          setHtml(next);
          onChange(next, text);
        }}
        onBusyChange={onBusyChange}
      />
    );
  }
  render(
    <ApiClientProvider client={{ baseUrl: '', fetch: withPolicy(fetch, policy) }}>
      <Harness />
    </ApiClientProvider>,
  );
}
it('edits actual rich text and exports HTML plus text', async () => {
  const change = vi.fn();
  mount(vi.fn(), change);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Bold' }));
  screen.getByRole('textbox', { name: 'Body' }).focus();
  await user.type(screen.getByRole('textbox', { name: 'Body' }), 'Hello', { skipClick: true });
  expect(change).toHaveBeenLastCalledWith('<p><strong>Hello</strong></p>', 'Hello');
});
it('uploads a Blob and inserts a link including the URL in the text alternative', async () => {
  const change = vi.fn();
  const busy = vi.fn();
  const fetch = vi.fn().mockResolvedValue({ data: asset });
  mount(fetch, change, busy);
  const file = new File(['pdf'], 'spec.pdf', { type: 'application/pdf' });
  fireEvent.change(screen.getByLabelText('Choose attachments'), { target: { files: [file] } });
  await waitFor(() => expect(change).toHaveBeenCalled());
  expect(fetch).toHaveBeenCalledWith(
    '/api/v1/mailboxes/mailbox/editor-assets',
    expect.objectContaining({
      method: 'POST',
      body: file,
      headers: expect.objectContaining({ 'X-File-Size': '3' }),
    }),
  );
  expect(change.mock.lastCall?.[0]).toContain(asset.url);
  expect(change.mock.lastCall?.[1]).toContain(asset.url);
  expect(busy.mock.calls).toEqual([[true], [false]]);
});
it('retains content and permits retry when upload fails', async () => {
  const fetch = vi.fn().mockRejectedValue(new Error('Upload unavailable'));
  mount(fetch, vi.fn(), vi.fn(), '<p>Keep this</p>');
  fireEvent.change(screen.getByLabelText('Choose images'), {
    target: { files: [new File(['png'], 'image.png', { type: 'image/png' })] },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('Upload unavailable');
  expect(screen.getByRole('textbox', { name: 'Body' })).toHaveTextContent('Keep this');
  expect(screen.getByRole('button', { name: 'Upload image' })).toBeEnabled();
});
it('removes scripts and base64 images from initial content', async () => {
  mount(
    vi.fn(),
    vi.fn(),
    vi.fn(),
    '<p>safe</p><script>alert(1)</script><img src="data:image/png;base64,AAAA">',
  );
  const editor = screen.getByRole('textbox', { name: 'Body' });
  await waitFor(() => expect(editor).toHaveTextContent('safe'));
  expect(editor.querySelector('img')).toBeNull();
  expect(editor.querySelector('script')).toBeNull();
});

it('keeps an uploaded image when an attachment is inserted immediately afterwards', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({
      data: { ...asset, filename: 'logo.png', kind: 'image', contentType: 'image/png' },
    })
    .mockResolvedValueOnce({ data: asset });
  mount(fetch);
  fireEvent.change(screen.getByLabelText('Choose images'), {
    target: { files: [new File(['png'], 'logo.png', { type: 'image/png' })] },
  });
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Body' }).querySelectorAll('img')).toHaveLength(1),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Upload attachment' })).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText('Choose attachments'), {
    target: { files: [new File(['pdf'], 'spec.pdf', { type: 'application/pdf' })] },
  });
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Body' }).querySelectorAll('a')).toHaveLength(1),
  );
  expect(screen.getByRole('textbox', { name: 'Body' }).querySelectorAll('img')).toHaveLength(1);
});

it('cancels a pending upload while preserving existing content', async () => {
  const fetch = vi.fn().mockImplementation(
    (_path: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  mount(fetch, vi.fn(), vi.fn(), '<p>Keep my message</p>');
  fireEvent.change(screen.getByLabelText('Choose attachments'), {
    target: { files: [new File(['pdf'], 'spec.pdf', { type: 'application/pdf' })] },
  });
  await userEvent.setup().click(await screen.findByRole('button', { name: 'Cancel upload' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Upload canceled.');
  expect(screen.getByRole('textbox', { name: 'Body' })).toHaveTextContent('Keep my message');
  expect(screen.getByRole('button', { name: 'Upload attachment' })).toBeEnabled();
});

it('mounts safely through React strict mode lifecycle', () => {
  render(
    <StrictMode>
      <ApiClientProvider client={{ baseUrl: '', fetch: withPolicy(vi.fn()) }}>
        <RichTextEditor
          id="strict-body"
          label="Body"
          value=""
          onChange={vi.fn()}
          scope={{ mailboxId: 'mailbox' }}
        />
      </ApiClientProvider>
    </StrictMode>,
  );
  expect(screen.getByRole('textbox', { name: 'Body' })).toBeInTheDocument();
});

it('clears controlled content when sending finishes without resurrecting the old body', async () => {
  function ResetHarness() {
    const [html, setHtml] = useState('<p>Sent body</p>');
    const [pending, setPending] = useState(true);
    return (
      <ApiClientProvider client={{ baseUrl: '', fetch: withPolicy(vi.fn()) }}>
        <RichTextEditor
          id="reset-body"
          label="Body"
          value={html}
          disabled={pending}
          onChange={setHtml}
        />
        <button
          onClick={() => {
            setHtml('');
            setPending(false);
          }}
        >
          Complete send
        </button>
        <output data-testid="value">{html}</output>
      </ApiClientProvider>
    );
  }
  render(<ResetHarness />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Complete send' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Body' })).toHaveTextContent(''));
  expect(screen.getByTestId('value').textContent).toBe('');
});

it('exports font size, heading, indentation, alignment and paragraph spacing as email HTML', async () => {
  const change = vi.fn();
  mount(vi.fn(), change);
  const user = userEvent.setup();
  screen.getByRole('textbox', { name: 'Body' }).focus();
  await user.type(screen.getByRole('textbox', { name: 'Body' }), 'Formatted', { skipClick: true });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Paragraph style' }), 'h2');
  await user.click(screen.getByRole('button', { name: 'Increase indent' }));
  await user.click(screen.getByRole('button', { name: 'Align center' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Paragraph spacing' }), '2');
  const block = screen.getByRole('textbox', { name: 'Body' }).querySelector('h2');
  expect(block).toHaveStyle({ marginLeft: '32px', textAlign: 'center', lineHeight: '2' });
  await user.click(screen.getByRole('button', { name: 'Decrease indent' }));
  expect(screen.getByRole('textbox', { name: 'Body' }).querySelector('h2')).not.toHaveStyle({
    marginLeft: '32px',
  });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Font size' }), '24px');
  screen.getByRole('textbox', { name: 'Body' }).focus();
  await user.type(screen.getByRole('textbox', { name: 'Body' }), ' large', { skipClick: true });
  expect(change.mock.lastCall?.[0]).toContain('font-size: 24px');
  expect(change.mock.lastCall?.[0]).toContain('<h2');
});

it('retains safe block styles when reopening a signature', async () => {
  mount(
    vi.fn(),
    vi.fn(),
    vi.fn(),
    '<h2 style="margin-left: 64px; text-align: right; line-height: 2"><span style="font-size: 18px">Saved</span></h2>',
  );
  const editor = screen.getByRole('textbox', { name: 'Body' });
  expect(editor.querySelector('h2')).toHaveStyle({
    marginLeft: '64px',
    textAlign: 'right',
    lineHeight: '2',
  });
  expect(editor.querySelector('span')).toHaveStyle({ fontSize: '18px' });
});

it('retains the chosen font size when block formatting is applied before typing', async () => {
  const change = vi.fn();
  mount(vi.fn(), change);
  const user = userEvent.setup();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Font size' }), '24px');
  await user.click(screen.getByRole('button', { name: 'Increase indent' }));
  await user.click(screen.getByRole('button', { name: 'Align center' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Paragraph spacing' }), '2');
  screen.getByRole('textbox', { name: 'Body' }).focus();
  await user.type(screen.getByRole('textbox', { name: 'Body' }), 'Styled from the start', {
    skipClick: true,
  });
  expect(change.mock.lastCall?.[0]).toContain('font-size: 24px');
  expect(change.mock.lastCall?.[0]).toContain('margin-left: 32px');
});

it('shows configured limits and blocks an oversized file before uploading bytes', async () => {
  const fetch = vi.fn();
  mount(fetch, vi.fn(), vi.fn(), '', () => ({ maxFileBytes: 2 * 1024, maxImageBytes: 2 * 1024 }));
  expect(await screen.findByText(/Images up to 2 KB · files up to 2 KB/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Choose attachments'), {
    target: { files: [new File([new Uint8Array(2049)], 'too-big.pdf')] },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('maximum 2 KB per file');
  expect(fetch).not.toHaveBeenCalled();
});

it('refreshes a changed setting before upload and accepts the exact configured boundary', async () => {
  const fetch = vi.fn().mockResolvedValue({ data: { ...asset, sizeBytes: 3 } });
  let policy = { maxFileBytes: 2048, maxImageBytes: 2048 };
  mount(fetch, vi.fn(), vi.fn(), '', () => policy);
  await screen.findByText(/files up to 2 KB/);
  policy = { maxFileBytes: 3, maxImageBytes: 3 };
  fireEvent.change(screen.getByLabelText('Choose attachments'), {
    target: { files: [new File(['1234'], 'four.pdf')] },
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('maximum 3 B per file');
  expect(fetch).not.toHaveBeenCalled();
  expect(screen.getByText(/files up to 3 B/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Choose attachments'), {
    target: { files: [new File(['123'], 'three.pdf')] },
  });
  await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
  await waitFor(() =>
    expect(screen.getByRole('textbox', { name: 'Body' }).querySelector('a')).not.toBeNull(),
  );
});

it('disables uploads and permits retry when the policy cannot be loaded', async () => {
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new Error('Offline'))
    .mockResolvedValue({ data: defaultPolicy });
  render(
    <ApiClientProvider client={{ baseUrl: '', fetch }}>
      <RichTextEditor
        id="offline"
        label="Body"
        value=""
        onChange={vi.fn()}
        scope={{ mailboxId: 'mailbox' }}
      />
    </ApiClientProvider>,
  );
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load upload limits.');
  expect(screen.getByRole('button', { name: 'Upload attachment' })).toBeDisabled();
  expect(screen.queryByText(/files up to/)).toBeNull();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(/files up to 100 MB/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Upload attachment' })).toBeEnabled();
});
