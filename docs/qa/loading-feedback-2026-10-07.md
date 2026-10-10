# Loading feedback acceptance — 2026-10-07

Scope: CAP-A2 loading presentation for the existing web routes. Staging Worker
version `8255eaef-5ce3-4392-aacc-0244df482f8f`; no API, schema or storage changes.

## Implemented

- Initial admin lists/forms/overview, mailbox lists, inbox, message detail/thread,
  draft recovery and compose use skeletons. Route-chunk fallbacks match page type.
- Session/routing waits use a centered spinner. Submit, pagination, confirmation,
  preference saving and uploads show a spinner without removing action text.
- Busy buttons prevent duplicate submissions. Preferences do not show selectable
  fallback values before the server response. Cached message refresh errors keep
  the message visible with inline retry.
- Skeletons have no interactive controls, expose translated loading status and
  respect reduced motion. Mail skeleton rows do not receive hover feedback.

## Local verification

95 test files / 1,283 unit tests pass. New deferred-response cases cover settings
skeleton-to-form transition, busy saves retaining entered values and blocking a
second write, and personal-preference choices appearing only after loading.
Existing pending/error/retry, cached-data and mail/auth tests pass. Workspace
TypeScript, ESLint, changed-source Prettier, web build and doctor (14/14) pass.
ESLint excludes generated `.tmp` artifacts. Worker tests were not rerun for this
presentation-only change.

## Staging browser verification

Selected real staging response-body reads were delayed by 10 seconds in the QA
browser. Responses and persisted data were not replaced. The delay was disabled
and the browser reloaded afterward.

| Scenario | Observed result |
| --- | --- |
| Settings and users first load | Skeletons and localized busy status; no usable form or false empty state; actual content replaces placeholders after HTTP 200 responses. |
| Cached inbox refresh | Three existing messages stay visible instead of returning to the initial skeleton. |
| Empty archive/trash first load | Five placeholder rows; empty state appears only after the real response; skeleton disappears. |
| Message in reading pane | Detail placeholders appear while the inbox stays visible; real message and thread render afterward. An already-read message was used. |
| 390px viewport, reduced motion | No horizontal overflow; animation name is `none`; final deployed rows have `pointer-events: none` and no hover fill. |
| Quick settings and compose | Existing account preferences render; fullscreen editor and labeled Send action open normally. Empty local composer discarded. |

Final deployed entry asset: `index-B8USO41v.js`. `/healthz` returns 200;
unauthenticated admin settings returns 401 `AUTHENTICATION_REQUIRED` (route/auth
boundary only). Authenticated browser reads above provide the positive UI
verification. This is not a mail-delivery or full integration acceptance run.

Cleanup: browser-only latency instrumentation was removed by reload; the QA
account was signed out and its temporary auth-vault profile and browser session
were removed. No account preferences, system settings, uploads or email writes
were performed during this UI acceptance.
