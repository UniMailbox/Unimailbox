import { Spinner } from '../ui/Spinner';
import { Skeleton } from '../ui/shadcn/skeleton';
import { useT } from '../../infrastructure/i18n/locale';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  editorUploadPolicyKey,
  fetchEditorUploadPolicy,
  formatEditorUploadLimit,
} from './upload-policy';
import type { Editor } from '@tiptap/core';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TextStyle, FontSize } from '@tiptap/extension-text-style';
import { MailBlockFormat } from './mail-block-format';
import Image from '@tiptap/extension-image';
import DOMPurify from 'dompurify';
import {
  Bold,
  IndentIncrease,
  IndentDecrease,
  AlignLeft,
  AlignCenter,
  AlignRight,
  RemoveFormatting,
  Italic,
  Underline,
  List,
  ListOrdered,
  Link2,
  ImagePlus,
  Paperclip,
  Undo2,
  Redo2,
} from 'lucide-react';
import { EDITOR_BODY_MAX_BYTES, editorAssetDescriptorSchema } from '@unimailbox/contracts';
import { useApiClient } from '../../infrastructure/api/client-provider';
import { Button } from '../ui/shadcn/button';
import { Input } from '../ui/shadcn/input';

export type EditorScope = { mailboxId: string } | { domainId: string };
export function textToHtml(text: string): string {
  return text
    ? `<p>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`
    : '';
}
function uploadSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
function safeContent(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p',
      'span',
      'h1',
      'h2',
      'h3',
      'br',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'ul',
      'ol',
      'li',
      'blockquote',
      'a',
      'img',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'style'],
    ALLOWED_URI_REGEXP: /^(?:https:|mailto:)/i,
  });
}
function editorPlainText(instance: Editor): string {
  const links = new Map<string, string>();
  instance.state.doc.descendants((node) => {
    if (node.type.name === 'image' && typeof node.attrs['src'] === 'string')
      links.set(node.attrs['src'], String(node.attrs['alt'] || 'Image'));
    for (const mark of node.marks)
      if (mark.type.name === 'link' && typeof mark.attrs['href'] === 'string')
        links.set(mark.attrs['href'], node.textContent || 'Link');
  });
  const text = instance.getText({ blockSeparator: '\n' });
  return (
    text +
    (links.size ? '\n\n' + Array.from(links, ([url, name]) => `${name}: ${url}`).join('\n') : '')
  );
}
export function RichTextEditor({
  id,
  label,
  value,
  onChange,
  scope,
  disabled = false,
  onBusyChange,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (html: string, text: string) => void;
  scope?: EditorScope;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  error?: string | undefined;
}): ReactElement {
  const t = useT();
  const api = useApiClient();
  const queryClient = useQueryClient();
  const policy = useQuery({
    queryKey: editorUploadPolicyKey,
    queryFn: ({ signal }) => fetchEditorUploadPolicy(api, signal),
    enabled: Boolean(scope),
    staleTime: 0,
  });
  const images = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const uploadLock = useRef(false);
  const uploadController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [link, setLink] = useState('');
  const lastEmitted = useRef<string | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const latestScope = useRef(scope);
  latestScope.current = scope;
  const uploadRef = useRef<(files: File[], mode: 'image' | 'file' | 'auto') => Promise<void>>(
    async () => {},
  );
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        codeBlock: false,
        code: false,
        horizontalRule: false,
        link: {
          openOnClick: false,
          protocols: ['https', 'mailto'],
          HTMLAttributes: { target: null, rel: null },
        },
      }),
      TextStyle,
      FontSize,
      MailBlockFormat,
      Image.configure({
        allowBase64: false,
        HTMLAttributes: { style: 'max-width:100%;height:auto;' },
      }),
    ],
    content: safeContent(value),
    editable: !disabled,
    shouldRerenderOnTransaction: true,
    editorProps: {
      attributes: {
        id,
        role: 'textbox',
        'aria-label': label,
        'aria-multiline': 'true',
        'aria-invalid': String(Boolean(error)),
        'data-testid': id,
        class: 'email-editor-content',
      },
      transformPastedHTML: safeContent,
      handlePaste: (_view, event) => {
        const selected = Array.from(event.clipboardData?.files ?? []);
        if (!selected.length) return false;
        event.preventDefault();
        void uploadRef.current(selected, 'auto');
        return true;
      },
      handleDrop: (_view, event, _slice, moved) => {
        const selected = Array.from(event.dataTransfer?.files ?? []);
        if (moved || !selected.length) return false;
        event.preventDefault();
        void uploadRef.current(selected, 'auto');
        return true;
      },
    },
    onUpdate: ({ editor: instance }) => {
      const html = instance.isEmpty ? '' : instance.getHTML();
      lastEmitted.current = html;
      change.current(html, editorPlainText(instance));
    },
  });
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      uploadController.current?.abort();
    };
  }, []);
  useEffect(() => {
    editor?.setEditable(!disabled && !busy, false);
  }, [editor, disabled, busy]);
  useEffect(() => {
    if (
      editor &&
      value !== lastEmitted.current &&
      (editor.isEmpty ? '' : editor.getHTML()) !== value
    )
      editor.commands.setContent(safeContent(value), { emitUpdate: false });
  }, [editor, value]);
  uploadRef.current = async (selected, mode) => {
    if (!editor || disabled || uploadLock.current) return;
    const target = latestScope.current;
    if (!target || ('domainId' in target && !target.domainId)) {
      setUploadError(t('Choose a domain before uploading.'));
      return;
    }
    uploadLock.current = true;
    const controller = new AbortController();
    uploadController.current = controller;
    setBusy(true);
    onBusyChange?.(true);
    setUploadError(null);
    try {
      // Re-read at upload time as another administrator may have changed the limit.
      const currentPolicy = await fetchEditorUploadPolicy(api, controller.signal);
      queryClient.setQueryData(editorUploadPolicyKey, currentPolicy);
      for (const file of selected) {
        const kind =
          mode === 'image' ||
          (mode === 'auto' &&
            ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type))
            ? 'image'
            : 'file';
        const maximum = kind === 'image' ? currentPolicy.maxImageBytes : currentPolicy.maxFileBytes;
        if (!file.size || file.size > maximum)
          throw new Error(
            t('{name}: maximum {size} per {kind}.', {
              name: file.name,
              size: formatEditorUploadLimit(maximum),
              kind: t(kind),
            }),
          );
        if (
          kind === 'image' &&
          !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(file.type)
        )
          throw new Error(t('Use a PNG, JPEG, GIF or WebP image.'));
        const path =
          'mailboxId' in target
            ? `/api/v1/mailboxes/${encodeURIComponent(target.mailboxId)}/editor-assets`
            : `/api/v1/admin/domains/${encodeURIComponent(target.domainId)}/editor-assets`;
        const response = await api.fetch<{ data: unknown }>(path, {
          method: 'POST',
          body: file,
          signal: controller.signal,
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
            'X-Filename': encodeURIComponent(file.name),
            'X-Asset-Kind': kind,
            'X-File-Size': String(file.size),
          },
        });
        const asset = editorAssetDescriptorSchema.parse(response.data);
        if (
          !alive.current ||
          editor.isDestroyed ||
          JSON.stringify(latestScope.current) !== JSON.stringify(target)
        )
          break;
        // Insertion is allowed while editable=false: uploads freeze typing, not commands.
        if (asset.kind === 'image')
          editor
            .chain()
            .insertContentAt(editor.state.selection.to, [
              { type: 'image', attrs: { src: asset.url, alt: asset.filename } },
              { type: 'paragraph' },
            ])
            .run();
        else
          editor
            .chain()
            .insertContentAt(editor.state.selection.to, [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: `${asset.filename} (${uploadSizeLabel(asset.sizeBytes)})`,
                    marks: [{ type: 'link', attrs: { href: asset.url } }],
                  },
                ],
              },
              { type: 'paragraph' },
            ])
            .run();
      }
    } catch (cause) {
      if (alive.current)
        setUploadError(
          controller.signal.aborted
            ? t('Upload canceled.')
            : cause instanceof Error
              ? cause.message
              : t('Upload failed. Try again.'),
        );
    } finally {
      uploadLock.current = false;
      if (alive.current) {
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  };
  function changeIndent(direction: number): void {
    if (!editor) return;
    if (editor.isActive('listItem')) {
      if (direction > 0) editor.chain().focus().sinkListItem('listItem').run();
      else editor.chain().focus().liftListItem('listItem').run();
      return;
    }
    const marks = editor.state.storedMarks ?? editor.state.selection.$from.marks();
    editor
      .chain()
      .focus()
      .command(({ tr, state }) => {
        state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
          if (node.type.name === 'paragraph' || node.type.name === 'heading') {
            const indent = Math.min(5, Math.max(0, Number(node.attrs['indent'] ?? 0) + direction));
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent });
          }
        });
        tr.ensureMarks(marks);
        return true;
      })
      .run();
  }
  function updateBlock(attributes: Record<string, string>): void {
    if (!editor) return;
    const marks = editor.state.storedMarks ?? editor.state.selection.$from.marks();
    editor
      .chain()
      .focus()
      .updateAttributes('paragraph', attributes)
      .updateAttributes('heading', attributes)
      .command(({ tr }) => {
        tr.ensureMarks(marks);
        return true;
      })
      .run();
  }
  const buttons = [
    {
      label: 'Bold',
      icon: Bold,
      active: editor?.isActive('bold'),
      run: () => editor?.chain().focus().toggleBold().run(),
    },
    {
      label: 'Italic',
      icon: Italic,
      active: editor?.isActive('italic'),
      run: () => editor?.chain().focus().toggleItalic().run(),
    },
    {
      label: 'Underline',
      icon: Underline,
      active: editor?.isActive('underline'),
      run: () => editor?.chain().focus().toggleUnderline().run(),
    },
    {
      label: 'Bullet list',
      icon: List,
      active: editor?.isActive('bulletList'),
      run: () => editor?.chain().focus().toggleBulletList().run(),
    },
    {
      label: 'Numbered list',
      icon: ListOrdered,
      active: editor?.isActive('orderedList'),
      run: () => editor?.chain().focus().toggleOrderedList().run(),
    },
    { label: 'Increase indent', icon: IndentIncrease, run: () => changeIndent(1) },
    { label: 'Decrease indent', icon: IndentDecrease, run: () => changeIndent(-1) },
    { label: 'Align left', icon: AlignLeft, run: () => updateBlock({ textAlign: 'left' }) },
    { label: 'Align center', icon: AlignCenter, run: () => updateBlock({ textAlign: 'center' }) },
    { label: 'Align right', icon: AlignRight, run: () => updateBlock({ textAlign: 'right' }) },
    {
      label: 'Clear formatting',
      icon: RemoveFormatting,
      run: () =>
        editor
          ?.chain()
          .focus()
          .unsetAllMarks()
          .clearNodes()
          .resetAttributes('paragraph', ['indent', 'textAlign', 'lineHeight'])
          .run(),
    },
    { label: 'Undo', icon: Undo2, run: () => editor?.chain().focus().undo().run() },
    { label: 'Redo', icon: Redo2, run: () => editor?.chain().focus().redo().run() },
  ];
  const tooLarge = new TextEncoder().encode(value).byteLength > EDITOR_BODY_MAX_BYTES;
  return (
    <div className="email-editor-field">
      <label className="input-label" htmlFor={id}>
        {label}
      </label>
      <div className="email-editor rounded-md border bg-background">
        <div
          role="toolbar"
          aria-label={t('{label} formatting', { label })}
          className="flex flex-wrap items-center gap-0.5 border-b p-1"
        >
          <select
            aria-label={t('Paragraph style')}
            className="email-editor-select"
            disabled={disabled || busy || !editor}
            value={
              editor?.isActive('heading')
                ? `h${String(editor.getAttributes('heading')['level'])}`
                : editor?.isActive('blockquote')
                  ? 'quote'
                  : 'paragraph'
            }
            onChange={(event) => {
              const value = event.target.value;
              if (editor?.isActive('blockquote')) editor.chain().focus().unsetBlockquote().run();
              if (value === 'quote') editor?.chain().focus().setParagraph().setBlockquote().run();
              else if (value === 'paragraph') editor?.chain().focus().setParagraph().run();
              else
                editor
                  ?.chain()
                  .focus()
                  .setHeading({ level: Number(value.slice(1)) as 1 | 2 | 3 })
                  .run();
            }}
          >
            <option value="paragraph">{t('Paragraph')}</option>
            <option value="h1">{t('Heading 1')}</option>
            <option value="h2">{t('Heading 2')}</option>
            <option value="h3">{t('Heading 3')}</option>
            <option value="quote">{t('Quote')}</option>
          </select>
          <select
            aria-label={t('Font size')}
            className="email-editor-select"
            disabled={disabled || busy || !editor}
            value={String(editor?.getAttributes('textStyle')['fontSize'] ?? '')}
            onChange={(event) =>
              event.target.value
                ? editor?.chain().focus().setFontSize(event.target.value).run()
                : editor?.chain().focus().unsetFontSize().run()
            }
          >
            <option value="">{t('Size')}</option>
            {[12, 14, 16, 18, 24, 32].map((size) => (
              <option key={size} value={`${size}px`}>
                {size}
              </option>
            ))}
          </select>
          <select
            aria-label={t('Paragraph spacing')}
            className="email-editor-select"
            disabled={disabled || busy || !editor}
            value={String(
              editor?.getAttributes(editor.isActive('heading') ? 'heading' : 'paragraph')[
                'lineHeight'
              ] ?? '1.5',
            )}
            onChange={(event) => updateBlock({ lineHeight: event.target.value })}
          >
            <option value="1">{t('Compact')}</option>
            <option value="1.5">{t('Normal')}</option>
            <option value="2">{t('Spacious')}</option>
          </select>
          {buttons.map((item) => (
            <Button
              key={item.label}
              type="button"
              variant="ghost"
              size="icon"
              className="size-8"
              title={t(item.label)}
              aria-label={t(item.label)}
              aria-pressed={item.active}
              disabled={disabled || busy || !editor}
              onClick={item.run}
            >
              <item.icon className="size-4" />
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t('Add link')}
            title={t('Add link')}
            disabled={disabled || busy}
            onClick={() => {
              setLink((editor?.getAttributes('link')['href'] as string) ?? '');
              setLinkOpen(!linkOpen);
            }}
          >
            <Link2 className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t('Upload image')}
            title={t('Upload image')}
            disabled={
              disabled || busy || !policy.data || !scope || ('domainId' in scope && !scope.domainId)
            }
            onClick={() => images.current?.click()}
          >
            <ImagePlus className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8"
            aria-label={t('Upload attachment')}
            title={t('Upload attachment')}
            disabled={
              disabled || busy || !policy.data || !scope || ('domainId' in scope && !scope.domainId)
            }
            onClick={() => files.current?.click()}
          >
            <Paperclip className="size-4" />
          </Button>
        </div>
        {linkOpen ? (
          <div className="flex flex-wrap gap-2 border-b p-2">
            <Input
              aria-label={t('Link URL')}
              type="url"
              placeholder="https://…"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              className="min-w-0 flex-1"
            />
            <Button
              type="button"
              size="sm"
              onClick={() => {
                if (/^(https:\/\/|mailto:)/i.test(link)) {
                  editor?.chain().focus().extendMarkRange('link').setLink({ href: link }).run();
                  setLinkOpen(false);
                } else if (!link) {
                  editor?.chain().focus().extendMarkRange('link').unsetLink().run();
                  setLinkOpen(false);
                } else setUploadError(t('Use an https:// or mailto: link.'));
              }}
            >
              {t('Apply')}
            </Button>
          </div>
        ) : null}
        <EditorContent editor={editor} className="email-editor-surface" />
      </div>
      <input
        ref={images}
        type="file"
        hidden
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp"
        aria-label={t('Choose images')}
        onChange={(event) => {
          void uploadRef.current(Array.from(event.target.files ?? []), 'image');
          event.target.value = '';
        }}
      />
      <input
        ref={files}
        type="file"
        hidden
        multiple
        aria-label={t('Choose attachments')}
        onChange={(event) => {
          void uploadRef.current(Array.from(event.target.files ?? []), 'file');
          event.target.value = '';
        }}
      />
      <p className="text-xs text-muted-foreground">
        {policy.data
          ? t('Images up to {images} · files up to {files}. ', {
              images: formatEditorUploadLimit(policy.data.maxImageBytes),
              files: formatEditorUploadLimit(policy.data.maxFileBytes),
            })
          : ''}
        {t(
          'Files appear in the attachment list at the end of the email. Anyone with a download link can open it. ',
        )}
      </p>
      {scope && policy.isPending ? (
        <div role="status" aria-label={t('Loading upload limits…')} aria-busy="true">
          <Skeleton className="h-3 w-56 max-w-full" />
        </div>
      ) : null}
      {scope && policy.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t('Could not load upload limits. ')}
          <Button type="button" variant="ghost" size="sm" onClick={() => void policy.refetch()}>
            {t('Retry')}
          </Button>
        </p>
      ) : null}
      {busy ? (
        <div className="flex items-center gap-2">
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner decorative />
            {t('Uploading…')}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => uploadController.current?.abort()}
          >
            {t('Cancel upload')}
          </Button>
        </div>
      ) : null}
      {uploadError || error || tooLarge ? (
        <p role="alert" className="text-sm text-destructive">
          {uploadError ||
            error ||
            t('Content is too large. Upload files instead of embedding them.')}
        </p>
      ) : null}
    </div>
  );
}
