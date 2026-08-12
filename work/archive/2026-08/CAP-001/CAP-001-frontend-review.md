# CAP-001 — frontend review

> Location: `work/reviews/CAP-001-frontend-review.md`

**Reviewer:** frontend-reviewer (`general-purpose`) · **Date:** 2026-08-12 · **Base:** dirty working tree (no commits yet)
**Capability:** CAP-001 — Monorepo scaffold + toolchain
**Status:** ACCEPT WITH FIXES

## Summary

This slice is exactly what the contract asked for: a minimal React + Vite + TanStack Router + TanStack Query client with two static stub routes (`/`, `/setup`), one shadcn/ui-style `Button` primitive, a token-driven palette in light + dark mode, and an empty API client. Acceptance criterion 7 is met — `pnpm dev:web` (verified via `vite --port 8766`) returns HTTP 200 for `/` and `/setup` (and `/nope`, which is the SPA shell that TanStack Router's `notFoundComponent` then renders client-side as "404"). There is no scope creep — no `/inbox`, `/admin`, `/auth/*`, no Zustand/Jotai/Redux store, and no second client. The two substantive findings are: (1) no top-level React error boundary or TanStack `defaultErrorComponent`, so any runtime throw in a route renders a blank page, which violates the four-states contract for every screen that the role spec requires me to walk; and (2) the `Button` primitive's inline `style` props overwrite the user-agent `:disabled` styles, so a disabled button looks identical to an enabled one — a real accessibility barrier the moment any capability uses `<Button disabled>`.

## Screens reviewed

| Screen | States present (loading / empty / error / success) | Finding count |
|---|---|---|
| `/` (Unimailbox stub) | N/A / N/A / **missing** / OK | 1 (error boundary) |
| `/setup` (setup placeholder) | N/A / N/A / **missing** / OK | 1 (error boundary, inherited) |
| `*` (404 — `notFoundComponent`) | N/A / **partially** / N/A / OK | 1 (no link back home) |
| `Button` primitive (interactive element) | loading prop N/A · disabled state visible = **missing** · focus visible = browser default only | 2 (disabled visual, missing `:focus-visible` style) |

Notes on the "N/A" cells: `/` and `/setup` are static components with no async surface, so loading and empty states are not applicable in CAP-001. Success is trivially "you see the text". The four-state contract therefore reduces to error-handling for these stubs.

## Acceptance criteria — frontend-touching subset

| # | Criterion | Met | Evidence |
|---|---|---|---|
| 7 | `pnpm dev:web` serves `/` and `/setup` returning HTTP 200 | YES | `vite --port 8766` started in 67 ms; `curl http://localhost:8766/` → 200, `/setup` → 200, `/nope` → 200 (SPA shell, 404 rendered client-side) |
| (scope) | No business UI beyond the `/setup` stub | YES | Only `indexRoute` (`/`) and `setupRoute` (`/setup`); `notFoundComponent` is a literal `<h1>404</h1>`. No `features/`, no `pages/`, no `routes/` directory. `grep -E '(inbox\|admin\|messages\|mailbox\|login\|signin)' apps/web/src/` only hits the `.unimailbox-stub` CSS class name and CSS token names. |
| (arch) | No store-as-event-bus | YES | `apps/web/src/infrastructure/api/client.ts` is `{ baseUrl }` only; no `zustand`/`jotai`/`redux` dependency in `apps/web/package.json`; TanStack Query is the server-state owner in `App.tsx`. |
| (arch) | Token-driven palette | YES | `Button.tsx` references `hsl(var(--unimailbox-primary))` etc.; no hard-coded hex / rgb values in `apps/web/src/`. |

## BLOCKER

> None. No scope creep, no store-as-event-bus, no architecture-rule violation.

## HIGH

> Wrong under a realistic condition. Must be fixed before acceptance.

### H1 — No error boundary anywhere in the React tree

- **Where:** `apps/web/src/App.tsx` (no `<ErrorBoundary>` wrapper) · `apps/web/src/app/router.tsx:11` (no `defaultErrorComponent` on `createRootRoute`)
- **Violates:** Frontend-reviewer role spec §"Four states per screen and per async surface" → Error state; `.claude/rules/coding.md` §Errors (errors are typed and surfaced, never silent).
- **Failure scenario:** A user on a slow network navigates to `/setup`. The route component throws — for example, a future `useQuery` hook rejects because `setupStatus` is malformed JSON, or the future `useSetupStep` hook throws because the `installation_token` cookie is missing. React 19 unmounts the whole tree; the user sees a blank white page (the `<div id="root">` is emptied) with the browser tab title "Unimailbox" and no error message, no retry button, no way back. Today this is latent (no async surface exists), but the four-states contract applies from day one — the cost of adding the boundary now is one `defaultErrorComponent` + one `<ErrorBoundary>` and it prevents an entire class of "white screen of death" defects later. Per the role spec, "the user gets a message they can act on, not a stack trace, and not a silent failure" — and right now it is silent.
- **Fix:** Add a `defaultErrorComponent` to `createRootRoute` in `router.tsx` that renders a token-styled error card with a "Reload" button (which calls `router.invalidate()`), and wire `import { ErrorBoundary } from 'react-error-boundary'` (or a hand-rolled class component) around `<RouterProvider>` in `App.tsx` as a second net. Both are < 30 lines and reference the existing `.unimailbox-stub` class for visual consistency.

### H2 — `Button` does not visually indicate the `disabled` state

- **Where:** `apps/web/src/components/ui/Button.tsx:10-27`
- **Violates:** Frontend-reviewer role spec §"Accessibility bar, per interactive element" — state must be visually conveyed; `.claude/rules/coding.md` §Structure ("route handler: validate → call one use case → map result"; analogous discipline applies to primitives).
- **Failure scenario:** A future capability (CAP-007+ — `GET /setup/status` involves a "Continue" button that disables while a claim is in flight) renders `<Button disabled={isClaiming}>Continue</Button>`. The native `disabled` attribute suppresses clicks, but the inline `style` props — `backgroundColor: 'hsl(var(--unimailbox-primary))'`, `color: 'hsl(var(--unimailbox-primary-foreground))'`, `cursor: 'pointer'` — override the user-agent `:disabled` pseudo-class rules. The button keeps the active-state colours and pointer cursor, so a sighted user clicks it, nothing happens, and they click again. An assistive-tech user hears "button, Continue" with no indication that it is currently inert. Today no consumer uses `disabled`, but the primitive ships first and every future caller will hit this.
- **Fix:** Move the inline styles into a CSS class (`.btn` in `tokens.css` or a sibling `button.css`) so that `.btn:disabled`, `.btn:focus-visible`, `.btn:hover`, and `.btn:active` can be styled. At minimum, add a `:disabled` rule that sets `cursor: not-allowed` and `opacity: 0.6` (or a muted token). Drop `cursor: pointer` (the UA already provides it for `<button>`).

## MEDIUM

> Should fix. May be deferred if recorded in the capability ledger with a reason.

### M1 — No `defaultPendingComponent` on the router

- **Where:** `apps/web/src/app/router.tsx:11`
- **Failure scenario:** Once a route gains a lazy import or a `loader` (CAP-006+ for `/setup`), a navigation renders nothing for the duration of the chunk fetch on a slow connection. The user sees the previous screen freeze, with no spinner or skeleton, and double-clicks "Continue". Today routes are synchronous components, so the failure is latent — but adding `defaultPendingComponent: () => <main className="unimailbox-stub">Loading…</main>` is three lines and prevents a class of "frozen button" defects.

### M2 — `Button` does not set `type="button"`

- **Where:** `apps/web/src/components/ui/Button.tsx:12`
- **Failure scenario:** A future capability wraps the Button inside a `<form>` (the search bar in `/inbox`, the setup wizard in CAP-006). The HTML default for `<button>` is `type="submit"`, so pressing Enter in the form submits it instead of, e.g., focusing the next field. A user types a query, presses Enter to autocomplete, and submits the form — search fires unexpectedly. Fix: spread `type` default in the props destructure (`const { children, type = 'button', ...rest } = props`) or just hardcode `type="button"`.

### M3 — 404 page has no recovery path

- **Where:** `apps/web/src/app/router.tsx:13-18` (`notFoundComponent`)
- **Failure scenario:** A user mistypes a URL (`/inboxx`) or follows a stale link. They see "404 — Page not found." with no link back to `/`. The browser back button works but the affordance is not visible. Fix: add a `<Link to="/">Back to home</Link>` using `@tanstack/react-router`'s `Link`.

### M4 — No `<noscript>` fallback in `index.html`

- **Where:** `apps/web/index.html`
- **Failure scenario:** A user behind a corporate CSP, a proxy that strips JS, or with NoScript enabled lands on `/setup`. The `<div id="root">` is empty, the page is blank white, and the user has no idea what the site is or why it is broken. The HTML body should contain a `<noscript>` block: `<noscript><p>Unimailbox requires JavaScript. Please enable it and reload.</p></noscript>`.

## LOW

> Style, naming, minor duplication. Fix if cheap.

### L1 — Theme is bound to `prefers-color-scheme` only

- **Where:** `apps/web/src/styles/tokens.css:28-41`
- A future user preference (e.g. a "Dark mode" toggle in settings) cannot override the OS preference. CAP-006+ will likely need a `.dark` class or `[data-theme]` attribute strategy. Document the choice; do not block on it now.

### L2 — `body { font-family }` is hardcoded, not tokenised

- **Where:** `apps/web/src/styles/tokens.css:46-48`
- The font stack is inline rather than `--unimailbox-font-sans`. Minor inconsistency with the token-driven palette.

### L3 — No `:focus-visible` style is defined anywhere

- **Where:** `apps/web/src/styles/tokens.css` (absent)
- Browser default focus rings apply, but the inline `border: '1px solid transparent'` on `Button` competes with them visually in some browsers. Once the Button moves to a CSS class (per H2), add `.btn:focus-visible { outline: 2px solid hsl(var(--unimailbox-primary)); outline-offset: 2px; }`.

## Not verified

- **React 19 + TanStack Router 1.135.2 console warnings.** The dev server was only up for ~5 s; I did not capture the React DevTools console. If StrictMode + TanStack Router's `createRouter` emits a deprecation or hydration warning, it would not be visible in a static review.
- **Production build behaviour.** Acceptance criterion 4 (`pnpm build`) was not exercised; only `pnpm dev:web` was. A worker tests + build pass is the orchestrator's job, not mine.
- **Touch-device cursor behaviour.** I cannot test that `cursor: pointer` (inline) survives on mobile Safari — not relevant for the stub, but worth noting if the inline-style approach persists.
- **Reduced-motion / `prefers-reduced-motion` handling.** Not in CAP-001 scope; flagging only because the tokens file will eventually drive animations.

## Required fixes

1. H1 — Add `defaultErrorComponent` to `createRootRoute` and a top-level `<ErrorBoundary>` in `App.tsx`. Five-minute job.
2. H2 — Move `Button`'s inline styles into a CSS class; add `:disabled`, `:focus-visible`, and `:hover` rules.

Both are small, mechanical, and prevent an entire class of latent defects. CAP-002 (test harness) and CAP-006 (setup gate) will both rely on these primitives behaving correctly.