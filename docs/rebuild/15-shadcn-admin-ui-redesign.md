# Unimailbox UI redesign — 2026-10-06

## Task contract and audited baseline

User requests a systematic audit, one shared adaptation strategy, and successive fixes using **satnaing/shadcn-admin** layouts and suitable components. Existing business APIs, permissions, session storage, draft recovery, attachment authentication, pagination and mail delivery remain authoritative. Current worktree was backed up under `.tmp/ui-redesign-20261006/baseline/`; unrelated work is preserved.

| Priority | Verified problem | Source / reproduction | Adaptation |
| --- | --- | --- | --- |
| P1 | Reference mismatch; existing work adopts marmelab palette/table rather than the requested project | `13-shadcn-admin-kit-adoption.md`, `styles/admin-kit-theme.css`, `ui/Table.tsx` | Pin satnaing source and license; adopt actual Sidebar, Sheet and primitives |
| P1 | Duplicate administration navigation and sign-out; header changes between routes | layouts plus mailbox page headers; staging mailbox snapshot has two Application navs | One authenticated shell owns navigation/session actions; pages own content only |
| P1 | Sidebar does not expose current mailbox folders; mobile navigation takes page space | `MailboxLayout.tsx`; staging 390px and inbox snapshots | Upstream collapsible Sidebar and modal mobile Sheet; contextual folder navigation |
| P1 | Confirmation is an inline panel despite claiming modal semantics | `ui/AlertDialog.tsx` | Radix-backed upstream AlertDialog portal, backdrop, focus management |
| P2 | Deep-link mailbox heading exposes UUID after reload | `InboxListPage.tsx` non-subscribing cache lookup | Subscribe to existing mailbox list query; neutral fallback until resolved |
| P2 | Mixed primitives and style rules; forms/lists/actions lack shared hierarchy | `tokens.css`, all admin and mailbox feature pages | Upstream Button/Input/Card/Label/Table/Alert, semantic row/card patterns and consistent page headers |
| P2 | Automatic dark palette has no user override | root prefers-color-scheme in `tokens.css` | Persistent Light/Dark/System selector shared by authenticated and auth surfaces |
| P2 | Authentication/setup are generic forms with weak orientation | `LoginPage.tsx`, `ChangePasswordPage.tsx`, `setup-layout.tsx` | Reference split auth layout, password visibility, vertical setup progress with mobile adaptation |
| P2 | Management forms dominate lists; overview is a plain link list | admin pages, `AdminLandingPage.tsx` | Compact resource overview, consistent forms/action rows, readable responsive resource cards/table |

Staging baseline: https://staging.unimailbox.tech. Screenshots: `.tmp/ui-redesign-20261006/before-{mailboxes,inbox,mobile}.png`. These are real UI observations, separate from local test evidence.

## Reference and provenance

- Repository: https://github.com/satnaing/shadcn-admin
- Pinned commit: `e16c87f213a5ba5e45964e9b67c792105ec74d26` (2.2.1).
- License: MIT, Copyright (c) 2024 Sat Naing; retained in `licenses/shadcn-admin-MIT.txt`.
- Adopt: `src/components/ui/{button,input,textarea,label,card,table,alert,alert-dialog,sidebar,sheet,separator,skeleton,tooltip,dropdown-menu,avatar,badge,select,switch,checkbox,dialog}.tsx`, `src/hooks/use-mobile.tsx`, `src/styles/theme.css`.
- Adapt: `src/components/layout/{authenticated-layout,app-sidebar,header,main,nav-group,nav-user}.tsx`, `src/components/{theme-switch,password-input}.tsx`, auth split-layout pattern. Actual Unimailbox routes/session/mailboxes replace demo teams/user data.
- Reject: demo dashboard statistics, charts, billing, fake profiles, chat/task/Clerk routes, unsupported global search. No placeholder controls are introduced. Radix Select/Switch/Checkbox retain existing controlled values and business contracts; custom backend pagination is retained.
- Minimal source support: Tailwind 4 + Vite plugin, tw-animate-css, CVA, clsx/tailwind-merge, Lucide, and Radix primitives required by adopted components. React/router/query/form versions stay as-is.

Compatibility wrappers keep current component APIs and test IDs while using actual upstream primitives. Product styling moves to one token palette; existing feature selectors only describe domain-specific structures. Desktop navigation collapses; mobile navigation opens as an accessible modal and closes on route selection. Management tables use stacked labeled rows on narrow screens. No horizontal page overflow is masked.

## Verification and completion

Local verification: 462 Web tests across 59 files, full workspace TypeScript, focused Web ESLint and production Web build pass. Build: CSS 97.08 kB (gzip 16.60), initial application JS 428.81 kB (gzip 127.27), separate React vendor 185.69 kB (gzip 58.64); heavy routes load on demand. The historical 674.50 kB main bundle included route code now split into separate chunks, so this is not a claim that total downloaded JavaScript decreased. Current staging Worker version: `5899903e-51d7-4391-a1b2-8f275fa75214`. Final browser matrix and save-flow evidence are tracked in the matching QA report; the original 175-case acceptance plan remains separate.

## 2026-10-07 — configuration page follow-through

Real staging inspection reproduced unadapted native fields on General settings: text/number controls were 24px high with zero border; numeric widths were 35–85px. Settings, roles and domain selectors had raw controls despite the shared shell migration. The settings runtime `<dl>` had grouped children inconsistent with its grid styling. Role and signature pages displayed all editors at once and obscured the resource list.

Fixes: grouped Settings sections with labeled upstream Inputs, real Switch/Checkbox/Select, compact environment/save metadata, sticky save actions; domain connection selector with explicit autosave hint; role/signature lists show summaries, and open the actual form in a bounded Radix Dialog only on New/Edit. Cancel resets row edits; successful saves return to the list. HTML signature source remains inert. Schema validation, read-only settings, version-conflict refresh, server permission denial and destructive confirmation remain in place. Dependencies added are the exact Radix Select/Switch/Checkbox versions used by the pinned reference. No unsupported policy enforcement is claimed.

A real long-lived signature form returned 401 after the 15-minute access token expired. Protected application requests now share one cookie-backed refresh and replay once with the same body and Idempotency-Key; auth/setup credentials and 403 responses are excluded. Recovery checks the original in-memory session before installing a token or replaying a save, so logout cannot revive the operation. Eight behavior tests cover replay identity, concurrency, exclusions, second 401, logout during refresh and refresh failure.

The live audit page also exposed one malformed staging-only audit action written by the earlier password-work-factor setup helper. The original record was backed up and corrected to `user.password_reset` with the affected administrator user id; id, timestamp and original metadata were preserved, and originalAction/operation/correction details added. No audit row was removed, no validator loosened, and no production data changed. Audit filters now use the same Select and compact responsive grid.

## Content hierarchy and routine page copy

The shared header contains navigation and account controls; the page owns its
visible title. Routine mailbox/admin pages omit introductions that restate their
title or describe an obvious list. Mailbox address appears beneath the folder
title, while list cards start with their contents. Empty mail folders show one
icon and one status sentence instead of a nested card with repeated explanations.

All mailboxes is available in the top-left mailbox switcher, without a duplicate
folder-menu item. On the mailbox list page, folder navigation still targets the
resolved default mailbox. Folder active state follows the actual route.

Login retains its form and controls without repeated sign-in instructions or a
sign-in footer. Quick settings hides its persistent-save description visually
while retaining it for assistive technology. Field labels, upload limits,
permission/read-only explanations, delivery/configuration limitations, destructive
confirmation, errors/retry and save/send feedback remain visible when relevant.
The existing English/Chinese localization and account preferences are unchanged.

## Loading feedback

Initial content fetches use non-interactive skeletons shaped for lists, settings
forms, overview statistics, message details and compose. The shell uses the same
page shape while route chunks load. Authentication/routing waits use a centered
spinner. Cached lists stay visible during background refresh; message refresh
failures keep the cached message and show an inline retry.

Use the shared Button `loading` property for short submit/pagination operations:
it adds a decorative spinner, preserves the accessible action label, marks the
button busy and blocks repeated clicks. Personal settings waits for server
preferences before showing choices; saving and file uploads keep their content
visible with an inline spinner. Loading labels follow the current language and
skeleton motion respects reduced-motion preferences.
