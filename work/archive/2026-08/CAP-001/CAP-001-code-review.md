# CAP-001 — Code Review

> **Reviewer:** `typescript-code-reviewer` (general-purpose) · **Date:** 2026-08-12 · **Base:** pre-commit working tree (no commits yet)

**Status:** ACCEPT WITH FIXES

## Summary

The scaffold compiles, lints, and honours the module-skeleton shape. Three concrete defects block a clean "implemented" stamp: (1) `platform/errors.ts` introduces a new `any` to set `Error.cause` when `lib: ["ES2022"]` already gives `Error` a `cause`-accepting constructor; (2) the `Bindings` type lives in `entrypoints/http.ts` and the `platform/*` files import it from there, inverting the architecture's dependency direction (the platform/domain layer must not depend on an entrypoint); (3) `wrangler.jsonc` references a `dead_letter_queue` that is never declared. There are also a few small rule-of-three, naming, and lint-config nits.

## Acceptance criteria

Not a QA review — see the QA report for acceptance evidence. This review only owns code-level defects.

## BLOCKER

None.

## HIGH

### H1 — `any` introduced to set `Error.cause` instead of using `ErrorOptions`

- **Where:** `apps/worker/src/platform/errors.ts:28-29`
- **Violates:** `.claude/rules/coding.md` ("`any` is a review finding. Use `unknown` plus a narrowing check, or model the type properly.")
- **Failure scenario:** Codebase policy explicitly forbids new `any`. A future reviewer will see `(this as any).cause = options.cause;` and the `eslint-disable-next-line` and either (a) accept the violation because there is a precedent, or (b) churn the file. The fix is one line: `Error` in `lib: ["ES2022"]` already accepts `ErrorOptions = { cause?: unknown }` in its constructor, so the cast is unnecessary.
- **Fix:** drop the `any` and the disable comment; pass the cause through `super`:

  ```ts
  super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
  ```

  Or accept a single `ErrorOptions` object in the constructor and forward it.

### H2 — `Bindings` defined in the entrypoint; `platform/*` imports it from there (inverted dependency)

- **Where:**
  - defined in `apps/worker/src/entrypoints/http.ts:5-14`
  - imported by `apps/worker/src/platform/database.ts:3`, `platform/cache.ts:3`, `platform/object-store.ts:3`, `platform/config.ts:3`
  - also imported by `apps/worker/src/app-context.ts:4` and `apps/worker/src/http/router.ts:6`
- **Violates:** `.claude/rules/architecture.md` §Dependency direction — `entrypoints ──▶ modules ──▶ domain ◀── integrations`. `platform/*` is the domain layer; the entrypoint is a consumer of the domain, not its source of types. The type `Bindings` is the *interface* of the worker's environment, so it belongs to the platform layer (or to `packages/contracts` if other modules need to import it).
- **Failure scenario:** Today, `import type` is erased at runtime, so the build still passes. The failure is in layering: the moment a real repository or service in a `modules/*` package imports `platform/database` and `platform/database` re-exports the env shape, that module's transitive type graph now includes the HTTP entrypoint. A future agent asked to "move the platform layer to its own package" will find that the platform already depends on the entrypoint and either accepts the inversion or has to extract `Bindings` first — i.e., the layering defect is a hidden cost of CAP-001.
- **Fix:** move `Bindings` to `apps/worker/src/platform/config.ts` (or a new `apps/worker/src/platform/env.ts`); have `entrypoints/http.ts` re-export it as a thin pass-through so existing import sites do not break. Re-validate with `tsc --build`.

## MEDIUM

### M1 — `wrangler.jsonc` references a dead-letter queue that is never declared

- **Where:** `apps/worker/wrangler.jsonc:69` — `"dead_letter_queue": "unimailbox-outbound-dlq"` inside the consumer block, with no matching entry under `queues.producers` or anywhere else.
- **Failure scenario:** A failed outbound message will be routed to `unimailbox-outbound-dlq`; if the queue is not provisioned, the platform either silently drops the message or returns a binding error at runtime. Either way, the dead-letter handling advertised in the config is not actually present. `wrangler deploy --dry-run` is reported to exit 0, so this is not caught by the dry-run gate.
- **Fix:** add a `producers` entry for the DLQ, e.g.:

  ```jsonc
  "producers": [
    { "binding": "OUTBOUND", "queue": "unimailbox-outbound" },
    { "binding": "OUTBOUND_DLQ", "queue": "unimailbox-outbound-dlq" }
  ]
  ```

  (the binding name is up to the implementer; the point is that the queue name must be declared).

### M2 — `Brand<T, B>` is exported but has zero consumers in the repo

- **Where:** `packages/contracts/src/index.ts:30-32`
- **Violates:** `.claude/rules/coding.md` §Abstraction discipline — "Rule of Three — do not introduce a generic abstraction until three concrete use cases exist."
- **Failure scenario:** Today, `Brand` is dead code. Worse, it is exported from `@unimailbox/contracts`, which is the *only* type surface that crosses module boundaries. A future implementer will see it in the public API and may either (a) build a branded type on top of it before there are three real call sites, or (b) leave it unused, in which case it is permanent dead weight in a cross-boundary package.
- **Fix:** delete the `Brand` interface from CAP-001. Re-introduce it the first time a concrete branded type (e.g. `MessageId`, `MailboxId`) is needed and there are at least three call sites.

### M3 — `eslint.config.js` enables the `import` plugin with a resolver that is not installed

- **Where:** `eslint.config.js:77-84` — `plugins: { import: importPlugin }` and `settings: { 'import/resolver': { typescript: true, node: true } }`, with no `eslint-import-resolver-typescript` in `package.json` devDependencies.
- **Failure scenario:** The plugin is loaded but no `import/*` rules are turned on, so the missing resolver is invisible today. The moment a reviewer (or CAP-002 / CAP-003) adds `import/no-unresolved` or `import/order`, the lint will fail or behave incorrectly because the resolver is not installed. The `typescript: true` resolver is the one that walks the project's tsconfig paths; without it, import paths will not resolve to TS source, and the rule will be a noisy false-positive machine.
- **Fix:** add `eslint-import-resolver-typescript` to root `devDependencies`, or drop the resolver config until a rule that needs it is enabled. The current `import` plugin presence with no active rules and an unresolvable resolver is a trap, not a feature.

## LOW

### L1 — `throw new Error('Root element #root missing from index.html')` is a raw `Error`

- **Where:** `apps/web/src/main.tsx:10`
- **Failure scenario:** This is a bootstrap invariant — the `<div id="root">` element is required by `index.html`. The current `Error` is fine for a non-recoverable startup failure, but it loses the project's typed-error convention (`.claude/rules/coding.md` §Errors). It is a one-line, app-bounded exception, so the impact is small.
- **Fix:** acceptable as-is. If a typed-error surface is wanted on the web side, copy `DomainError` into a `apps/web/src/lib/errors.ts` and use it. Otherwise leave a code comment naming the invariant so the throw is not "magic".

### L2 — `await Promise.resolve(err);` is a dead await

- **Where:** `apps/worker/src/http/middleware/error.ts:7`
- **Failure scenario:** Cosmetic. `await Promise.resolve(err);` resolves a `Promise<typeof err>` and discards the value; it has no observable behaviour. It does not change the request flow because the next statement is the explicit `return c.json(...)`. Future maintainers reading the file may assume it is meaningful and reason about the wrong thing.
- **Fix:** delete the line.

### L3 — `console.info` is used for both `info` and `debug` levels

- **Where:** `apps/worker/src/platform/logger.ts:30-33` — the `else` branch calls `console.info` for `info` and `debug`.
- **Failure scenario:** Operators get `debug` lines on stdout even when `LOG_LEVEL=info`. The level is preserved in the JSON line, but consumers (Loki, Cloudflare Logpush) may not filter by it. The task defers log-level wiring to CAP-016, so this is known.
- **Fix:** either (a) add a cheap `if (level === 'debug' && !isDebug) return;` guard reading from `loadConfig` / env, or (b) add a `// TODO: CAP-016` comment so the deferred work is greppable.

### L4 — `LogContext` has no deny-list; secrets can be logged verbatim

- **Where:** `apps/worker/src/platform/logger.ts:7-9` — `LogContext = { readonly [key: string]: unknown }`.
- **Failure scenario:** `.claude/rules/security.md` §Logging forbids logging "passwords, password hashes, access or refresh tokens, message bodies, attachment bytes, decrypted secrets, provider API keys, `Idempotency-Key` values tied to a body." A caller can do `logger.info({ event: 'send' }, { token: 'Bearer ...' })` and the secret reaches stdout. The task defers hardening to CAP-016, but the call shape (open `Record<string, unknown>`) means every future caller is one keystroke away from a leak. The defence lives in the *type*, not the discipline of the caller.
- **Fix:** close the shape to known-safe fields (e.g. `readonly { mailboxId?: string; messageId?: string; durationMs?: number; }`), or add a redaction helper in the logger that strips `token`, `password`, `authorization`, `body`, `apiKey`, etc. before serialization. Deferring to CAP-016 is fine — flag it as a hard requirement on that capability.

### L5 — `cf-sendmail.ts` is hyphenated; peer adapter files are not

- **Where:** `apps/worker/src/integrations/providers/cf-sendmail.ts` vs `brevo.ts`, `resend.ts`.
- **Failure scenario:** Trivial inconsistency. Future adapters will either follow `cf-sendmail` (hyphen for "Cloudflare-…") or `brevo` (single word), and the codebase will end up with both. The `cloudflare/` directory already exists for CF-specific integrations, which suggests `cf-sendmail` is the *real* CF mail adapter (Cloudflare Email Sending), in which case `cloudflare-email-sending.ts` would be a more honest name.
- **Fix:** rename to `cloudflare-email-sending.ts` (or, if Cloudflare Email Routing is the intent, `cloudflare-email-routing.ts`) so the file name matches the provider it wraps. Acknowledge that this changes the public surface; if the registry is already keyed by filename, update the registry.

## Not verified

- I did not run `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, or `wrangler deploy --dry-run` myself. The task's acceptance criteria include these gates; the implementer reports them green, and a static reading of the source is consistent with that claim (root `tsconfig.json` has `strict: true`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`; per-package `tsconfig.json`s extend it without loosening). I did not independently confirm that the gates exit 0.
- I did not verify that `wrangler 4.39.0` accepts the `secrets_store_secrets` shape as written. The `dry-run` is reported to pass, so this is most likely fine.
- I did not walk the build artifacts in `apps/worker/dist/` and `apps/web/dist/` — they are generated and gitignored, but the structure suggests `tsc --build` ran without errors.
- I did not test the React app in a browser; visual regressions of the design tokens are out of scope for the code reviewer.
- I did not run a deep dependency analysis of every transitive `node_modules` entry; the focus was on authored source.

## Required fixes

1. H1 — replace `(this as any).cause = ...` in `apps/worker/src/platform/errors.ts` with the `super(message, { cause })` form.
2. H2 — relocate `Bindings` to the `platform/` layer (or `packages/contracts`); re-export from `entrypoints/http.ts` for compatibility.
3. M1 — declare `unimailbox-outbound-dlq` in `wrangler.jsonc` (producer binding + queue name).
