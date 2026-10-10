# Compose window acceptance — 2026-10-07

> Follow-up: the dock position is now bottom-right and editor upload limits follow system settings. See [right-dock and configured-limit acceptance](compose-settings-2026-10-07.md) for the later deployment and evidence. The results below describe the preceding version.

Environment: https://staging.unimailbox.tech, Worker `unimailbox-staging`, final version `4e6c1f92-1284-4c60-a6e5-cfe710b77497`. Existing D1 schema 0029, R2, queue, secrets and domain bindings; no new infrastructure or manual configuration required. Working branch `cap/CAP-065-mailbox-sharing-ui`; unrelated dirty work preserved, no commit/push.

## Delivered behavior

- A single prominent Compose button sits below the mailbox switcher, above the left navigation. The inbox header and folder menu do not duplicate it.
- Compose opens fullscreen. Top-left Zoom out docks the same window at the bottom-left; Zoom in restores fullscreen. The mounted editor, recipients and uploads survive zoom, hide/reopen and mailbox/folder navigation. From remains pinned to the original draft mailbox. Hide keeps the unsent draft in memory; discard requires an explicit inline decision. Successful send releases the draft and shows a short confirmation, so the next compose/reply starts fresh. Leaving the authenticated app/reloading does not autosave this in-memory window to the server.
- To contains Cc/Bcc reveal buttons. Both optional fields start hidden and validate before send. Back to inbox is removed.
- Toolbar adds paragraph/headings/quote, six font sizes, indentation, alignment, paragraph line spacing and clear formatting, alongside existing lists, links, images, attachments, undo/redo. Inline styles survive sanitization and actual delivery. Choosing a font before adjusting blocks now retains the chosen font for subsequent typing.
- Bcc addresses are stored separately and sent exclusively in Brevo's Bcc envelope. Existing read projections continue exposing only To/Cc. Attachments retain the existing >10 MB R2 footer policy. Tiny uploaded file labels now show bytes rather than 0.0 MiB.

Official references: [Tiptap FontSize](https://tiptap.dev/docs/editor/extensions/functionality/fontsize), [TextStyle](https://tiptap.dev/docs/editor/extensions/marks/text-style), [extension attributes](https://tiptap.dev/docs/editor/extensions/custom-extensions/create-new/extension), [Brevo Bcc contract](https://developers.brevo.com/reference/send-transac-email). Added only MIT `@tiptap/extension-text-style@3.31.4`; StarterKit/core provide the remaining block operations.

## Local validation

- Final non-Worker suite: **1270 tests / 93 files passed**.
- Full Worker suite: **879 tests / 53 files passed**; test-kit Worker **18 tests passed**. Real D1/R2/KV/queue bindings, provider HTTP mocked at the boundary.
- Focused compose/attachments/outbound/read suite: **139 passed**. New regression coverage checks persisted Bcc, separate provider envelope, no read projection leakage, hidden recipient fields/validation, safe formatting, persistent window/editor identity, account changes and fresh compose after send.
- TypeScript, source ESLint, source Prettier, doctor **14/14**, production Web build and staging deploy passed. Lint excludes generated `**/.tmp/**`; format excludes the pre-existing `docs/rebuild/shadcn-admin-source-manifest.json` issue. Full Worker output contained transient native network-connection messages but no failed test or Vitest unhandled-error summary.
- jsdom-only geometry shims support ProseMirror selection tests; runtime code is unchanged by the shims.

Logs: `.tmp/compose-window-20261007/{nonworker-final,worker-full,focused-worker,final-editor-window,typecheck,lint,format-check,doctor,build-web,deploy-final}.log`.

## Browser evidence

Actual Chromium at 1440×900 and 390×844:

- Single sidebar Compose entry; fullscreen bounds match viewport; Cc/Bcc hidden initially and appear through the To buttons; no Back to inbox.
- Docked bounds: desktop left 16 px, bottom 900 px, width 576 px; mobile left 8 px, bottom 844 px. Zoom/hide/reopen preserve the same editor DOM node, recipients, body and two uploaded file links.
- Hide → Sent navigation → reopen retains the draft and correct From. Zoomed windows overlay the background; hide makes covered navigation available. Sending closes the window and leaves an announced confirmation.
- Final source verifies font retained after indent/alignment/spacing, the editor fills available height, and Send stays at the bottom-left. Fullscreen and docked mobile have no horizontal document overflow.
- The final 14 B upload label is correct. Owned QA profile was deleted and the owned browser session signed out/closed.

Screenshots: `.tmp/compose-window-20261007/fullscreen-final-desktop.png`, `docked-final-desktop.png`, `fullscreen-final-mobile.png`, `docked-mobile.png`.

## Real delivery and recipient privacy

First browser send: `c350cc4a-a24b-4b7c-abf3-189f5307bed6`, status **delivered**. To `staging-one@unimailbox.tech`, Cc `staging-admin@unimailbox.tech`, Bcc `staging-two@unimailbox.tech`. Included a hosted PNG, 21 MiB file and 14 B file, with font size/indent/center alignment/spacing.

Received IDs: To `87f59663-26a1-4c00-a169-763ece5f4144`; Cc `33c018e0-38ea-4de7-94f8-8f662142eade`; Bcc `03931bb7-af0d-44dc-922a-689128b67e63`. Real received HTML retains all four formatting properties, hosted image and one final large-attachment list. Raw MIME has **zero binary attachments**. Raw To/Cc copies have no Bcc header/address. The Bcc copy's header contains only its own address; its visible To/Cc and the app's projection exclude Bcc. This separate-copy behavior is allowed by [RFC 5322 §3.6.3](https://www.rfc-editor.org/rfc/rfc5322#section-3.6.3).

Final-version browser smoke: `0838deac-9067-41e2-98db-67d27cb0c47a`, **delivered**, same To/Cc/Bcc roles, correctly styled text and 14 B hosted attachment. Received To `e8ab5d40-da89-47b5-886f-381208ef18da`, Bcc `f4fc990b-0881-4db7-af99-7f3574d4d0a7`; both retain formatting/footer and exclude Bcc from visible recipients.

Recipient download verification followed actual Brevo-rewritten links: both recipients resolve each file to the same R2 object; forced download, original Content-Length and byte prefix match. The 14 B files also pass full SHA-256 comparison. Full 21 MiB recipient transfers stalled through the local network proxy and were stopped; this run does **not** claim a fresh full-file SHA-256 download for that file. Previous full large-file download evidence remains in [large attachment acceptance](large-attachments-2026-10-07.md). This change does not alter file storage or download handling.

Safe evidence JSON: `.tmp/compose-window-20261007/{live-evidence,final-smoke-evidence,raw-privacy-evidence,download-evidence}.json`. Raw synthetic MIME copies remain private mode 0600; no credentials or capability URLs are included here. Test messages remain as evidence; no signature, permissions or domain configuration was modified.
