# Email editing and R2 assets

Tiptap 3.31.4 open-source core is the shared compose/signature editor. Headless controls reuse the project's shadcn buttons and inputs. Formatting: bold, italic, underline, lists, links, undo/redo; paste/drop images or files and upload pickers. HTML and a plain-text alternative are produced together. File links are included in both. The admin signature's plain-text alternative can be adjusted separately.

## Research

| Candidate | License | Fit |
| --- | --- | --- |
| [Tiptap](https://github.com/ueberdosis/tiptap) | MIT core/extensions used here | Headless React editor, HTML serialization, custom uploads; chosen for existing stack and shadcn integration. |
| [Lexical](https://lexical.dev/docs/intro) | [MIT](https://github.com/facebook/lexical/blob/main/LICENSE) | React-first, strong node model; would require additional image/file and HTML serialization integration. |
| [Quill](https://quilljs.com/docs/formats/) | [BSD-3-Clause](https://github.com/slab/quill/blob/main/LICENSE) | Mature formats and embedded images; less direct fit with current React/headless components. |

No Tiptap Pro or hosted service is required. Upload is application-owned, consistent with [Tiptap's upload callback model](https://tiptap.dev/docs/ui-components/node-components/image-upload-node).

## Storage and delivery

cloud-mail's R2 upload and linked-attachment flow is the source reference. This implementation uses the existing Worker R2 binding, so it needs no public bucket or additional S3 credentials. Raw binary goes through a bounded stream into R2, using incremental SHA-256; metadata/idempotency/audit are stored in D1. Images are rendered with a recipient capability URL; files are download links, not MIME attachments. Anyone with such a link can access that particular upload. Private incoming attachments keep their authenticated download flow.

- POST /api/v1/mailboxes/:mailboxId/editor-assets: message.send + mailbox send authorization.
- POST /api/v1/admin/domains/:domainId/editor-assets: signature.manage + managed-domain existence.
- Headers: X-Filename (URI-encoded UTF-8), X-Asset-Kind (image/file), X-File-Size, Content-Type, Idempotency-Key. Empty, incorrect-length or oversized bodies fail; same key/body replays, changed body conflicts.
- GET /api/v1/editor-assets/:id/:secret: unguessable capability, D1 hash check and pending expiry; no listing. Raster images inline, other files forced download with sandbox and nosniff.
- Migration 0029: editor_assets/editor_asset_usages. Successful send/signature save publishes references in the same D1 batch; cross-scope/pending-owner references fail. Pending files expire after 7 days; Cron removes unused D1/R2 data and paginates orphan cleanup. Durable usages protect historical mail; automatic removal of published links is intentionally excluded.
- Per-file caps: 5 MiB raster image, 64 MiB download file. Pending per actor: 100 files / 256 MiB. Body: 500,000 UTF-8 bytes. Paste sanitization removes executable tags and data/blob images; server re-sanitizes HTML using a parser.

[Brevo's official limit](https://help.brevo.com/hc/en-us/articles/4402811730962-Add-an-attachment-to-a-transactional-email) is **20 MB for content plus attachments** via API. Our composer sends hosted URLs rather than file bytes. Legacy binary attachments are still bounded by a conservative 18 MB email estimate before queueing and before provider serialization. No automatic provider retry can fix an oversized email.

### 10 MB 超大附件规则（2026-10-07）

发送时将正文、纯文本、主题、启用的域名签名、所有文件及旧附件接口的附件合并估算；附件计入 base64/MIME 开销。阈值为 **10,000,000 字节**，严格超过时，所有附件（包括小文件）统一使用 R2 下载链接。内嵌远程图片仍作为正文图片，不额外作为文件附件。

编辑器文件本身已在 R2；旧接口附件在鉴权和长度预检后写入 R2，发送事务为它们创建 recipient capability 及持久引用，复用同一对象，不复制二进制。message_attachments 和 consumed 状态保留，既有私有下载及消费唯一性约束不变。Queue 通过 editor-assets 的公开接口识别已托管附件，不读取其大文件内容，也不再将其 base64 发送给 Brevo；adapter 同样阻止超过 10 MB 的二进制附件消息绕过该策略。

所有托管文件链接从正文原位置移至域名签名之后的一个列表，包含原始文件名、大小与下载链接。HTML 和纯文本都使用“附件列表（超大附件）”；未超过阈值的编辑器托管文件使用“附件列表”。相同文件引用去重，正文普通链接和图片保留。旧接口未超过阈值的普通 MIME 附件继续正常发送。

## Mailbox entry

/mailbox opens a valid default inbox directly. /mailboxes opens the full list explicitly. Defaults are selected from the server-authorized active list: per-user last used, matching login address, first owned mailbox, first available. Stale/disabled selections are ignored. Only mailbox IDs are stored locally. The upper-left switcher is shared by mailbox/admin layouts and links to the full list.
