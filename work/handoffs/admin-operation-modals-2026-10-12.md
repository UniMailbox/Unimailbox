# Administrator operation modals — 2026-10-12

## Scope

Administration pages present resource lists or saved configuration. Operations open
on demand through the existing bounded Radix/shadcn EditorDialog and AlertDialog.

- Users: creation with initial full-access mailbox assignments; per-user mailbox
  permission editing; reset/deactivate/reactivate confirmation. Create/reset show
  the initial password inside the same modal. Closing clears its transient state
  and releases mutation data (`gcTime: 0`).
- Domains: add in a modal; configure outbound connection and confirm inbound routing
  inside a domain modal. Selecting a connection does not write; Save does. The
  existing revision and idempotency API contract remains in use. Delete confirmation
  retains its protected flow and restores focus to Add domain when the row disappears.
- General settings and AI: saved-value summaries with an explicit Edit modal.
  Read-only operators see summaries without edit controls. Existing conflict refresh,
  validation, credential omission/replacement/removal and authorization remain.
- Connections: audited reveal confirmation followed by one-time display in a modal.
  A chained-dialog focus reference returns the keyboard to the original reveal button.
- Role/signature CRUD and existing delete dialogs already use modals and were retained.
  Read-only filters and pagination remain on their list pages.

Cancellation discards unsaved form values; failed writes retain values and error
feedback inside their modal. In-flight writes prevent accidental dismissal and
repeat submissions. Long forms scroll within the viewport. A failed settings
conflict refresh keeps editing disabled, while allowing the operator to close.
Backend permissions, mail operations, ownership, schema and API shapes are unchanged.

## Local evidence

Source commit: `409ab7d`.

- `pnpm verify` passed doctor 14/14, generated types, lint, TypeScript, builds,
  1,326 non-Worker tests, 980 Worker tests and 24 migration fixtures: 2,330 total.
  This first full run preceded the final focus/cache/cancel corrections.
- Final focused admin suite: 69/69 across users, assignments, domains, settings, AI,
  connections, roles and signatures. Settings/connection follow-up: 22/22;
  assignment/one-time cache follow-up: 6/6. The canonical release reruns the entire gate.
- Browser observations used synthetic local HTTP fixtures: create and password
  transition/close; permission modal; domain connection select/save; settings and
  AI editor opening/cancellation; audited simulated reveal/display/hide.
- Desktop and 390 x 844 mobile permission modals fit without horizontal overflow:
  document client/scroll width 390; dialog client/scroll width 356. Screenshots
  remain private in `.tmp/admin-modal-desktop.png` and `.tmp/admin-modal-mobile.png`.
- Scoped staged Gitleaks scan passed. Self-review only, no independent agent review.

## Delivery boundary

Staging deployment is the next authorized step. No real-account business mutation
was used for local browser verification; the fixture does not grant real permissions
or disclose real credentials. Production, source push and PR publication are outside
this update. The staging QA record will own the exact release and live smoke evidence.
