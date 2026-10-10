# CAP-001 — Architecture Review

**Reviewer:** `.claude/agents/architecture-reviewer.md` · **Date:** 2026-08-12 · **Base:** working tree, no commits (entire workspace is new)

**Status:** ACCEPT WITH FIXES

## Summary

The parts CAP-001 was mainly judged on are clean: twelve module skeletons with zero imports, six
integration files that import nothing, no DI container, no event bus, no god-object config, no
string-built SQL, no second authorization source. The dependency table has no edges to violate
because no edge exists yet.

The drift is in the *rails*, which is exactly where a scaffold capability can do lasting damage.
Three things: (1) three of the four entrypoints are not wired into the deployed Worker at all —
the built bundle exports `fetch` and nothing else, so the "One Worker, multiple entrypoints"
shape in `.claude/rules/architecture.md` §Shape is asserted in comments but not realized;
(2) the Cloudflare `Env` type is declared *inside* an entrypoint and imported downward by
`platform/*`, inverting the dependency direction at the lowest layer of the system; and
(3) `eslint-plugin-import` is installed and registered with **zero** import rules enabled, so
nothing mechanically enforces the module boundary table that `task.md:52` says this capability
exists to enforce. The single most important fix is (3) — every future boundary violation is
cheap to catch now and expensive to catch in Phase 3.

## Acceptance criteria — QA reviews only

Not applicable — architecture review. See `work/reviews/CAP-001-qa-review.md`. One note for the QA
reviewer: criterion 6 ("each exports a `fetch`/`email`/`queue`/`scheduled` handler") cannot be met
as built; see B1 for the evidence.

## BLOCKER

### B1 — Three of the four Worker entrypoints are unreachable dead code; the deployed bundle has only a `fetch` handler

- **Where:** `apps/worker/wrangler.jsonc:7` (`"main": "src/entrypoints/http.ts"`),
  `apps/worker/wrangler.jsonc:18-20` (the comment), `apps/worker/src/entrypoints/inbound-email.ts:5`,
  `apps/worker/src/entrypoints/queue.ts:5`, `apps/worker/src/entrypoints/scheduled.ts:5`
- **Violates:** `.claude/rules/architecture.md` §Shape — "**One Worker, multiple entrypoints.**";
  `docs/rebuild/05-target-architecture/architecture.md:59-63`
- **Failure scenario:** A Cloudflare Worker has exactly one entry module; `email`, `queue`, and
  `scheduled` must be exported from *that* module's default export. `wrangler.jsonc:7` names only
  `src/entrypoints/http.ts`, whose default export is a Hono app carrying `fetch` alone. The comment
  at `wrangler.jsonc:18-20` — "inbound-email.ts, queue.ts, and scheduled.ts are exported as named-entry
  workers so Cloudflare routes the right trigger to the right handler" — describes a Cloudflare
  feature that does not exist. Verified against the actual build output: `apps/worker/dist/http.js`
  ends with `export { http_default as default }` and the bundle contains no `email`, `queue`, or
  `scheduled` symbol. Concretely, on deploy: (a) `wrangler.jsonc:64-71` declares a **queue consumer**
  for `unimailbox-outbound` against a Worker with no `queue()` export — every message enqueued in
  Phase 1 fails delivery and drains to `unimailbox-outbound-dlq` after `max_retries: 5`, and the
  outbound loop looks like a provider bug rather than a wiring bug; (b) binding Email Routing to this
  Worker hits no `email()` handler and inbound mail bounces; (c) no `"triggers": { "crons": [...] }`
  key exists at all, so `scheduled.ts` can never fire even once a body is written. The architectural
  cost is that CAP-006+ implementers will read four entrypoint files, assume the shape works, and
  build against a composition that was never proven.
- **Fix:** Make the entry module a real composition point. Have `src/entrypoints/http.ts` (or a new
  `src/worker.ts` set as `main`) default-export a single object merging all four handlers —
  `{ fetch: app.fetch, ...emailEntry, ...queueEntry, ...scheduledEntry }` — keeping each handler body
  in its own file per §Shape. Add a `triggers.crons` entry, or drop the queue `consumers` block until
  a `queue()` handler exists rather than declaring a consumer that cannot consume. Delete the
  "named-entry workers" comment; it will be cited as fact by the next agent that reads it.

## HIGH

### H1 — The Cloudflare `Env` type is declared inside an entrypoint and imported downward by `platform/*`, inverting the dependency direction

- **Where:** `apps/worker/src/entrypoints/http.ts:5` (declaration), imported at
  `apps/worker/src/platform/database.ts:3`, `platform/cache.ts:3`, `platform/config.ts:3`,
  `platform/object-store.ts:3`, `apps/worker/src/app-context.ts:4`, `apps/worker/src/http/router.ts:6`
- **Violates:** `.claude/rules/architecture.md` §Dependency direction —
  `entrypoints ──▶ modules ──▶ domain`; `docs/rebuild/05-target-architecture/architecture.md:126-131`
  and rule 3 ("Domain never imports infrastructure"). The spec's own composition root signature is
  `buildAppContext(env: Env, ...)` with `Env` unqualified
  (`docs/rebuild/05-target-architecture/module-boundaries.md:41`), not a type owned by the HTTP shell.
- **Failure scenario:** `platform/` is the lowest layer — every module is permitted to depend on it
  (`.claude/rules/architecture.md` §Dependency direction, "Every module may additionally depend on
  `platform/*`"). By sourcing `Bindings` from `entrypoints/http.ts`, every one of those modules now
  has a compile-time path *up* into the entrypoint layer, and specifically into the file that
  imports Hono and constructs `new Hono()` at module scope (`entrypoints/http.ts:3,16`). That is the
  exact edge `.claude/rules/architecture.md` §Forbidden names first ("A module importing Hono, a
  Cloudflare `Request`/`Env` object"), reached transitively rather than directly — so a reviewer
  scanning a module's own import list will not see it. Today all six imports are `import type` and
  `verbatimModuleSyntax: true` (`tsconfig.json:16`) erases them, so there is no runtime cycle *yet*;
  the cycle becomes real the moment `entrypoints/http.ts` imports `buildAppContext` from
  `app-context.ts` at CAP-006, since `app-context.ts:4` imports back into it. Splitting the file
  later means touching every `platform/*` file plus the composition root at the point where real
  wiring is landing.
- **Fix:** Move the `Bindings` declaration to a layer nothing depends *up* into — `platform/env.ts`
  (or `packages/config`, which already owns shared config types) — and have
  `entrypoints/http.ts`, `http/router.ts`, and `app-context.ts` import it downward. Rename to `Env`
  to match `module-boundaries.md:41`. This is a six-line change now.

### H2 — `AppContext` re-exports the raw Cloudflare `Env`, creating a sanctioned bypass around every platform accessor

- **Where:** `apps/worker/src/app-context.ts:6-8` (`readonly env: Bindings`)
- **Violates:** `.claude/rules/architecture.md` §Forbidden ("A module importing … a Cloudflare
  `Request`/`Env` object"); `.claude/rules/security.md` §Secrets ADR-007
- **Failure scenario:** `AppContext` is the object every use case will receive. Exposing `env` on it
  means `ctx.env.DB.prepare('...')` inside a module typechecks, lints, and passes tests — bypassing
  `platform/database.ts` and, with it, `PRAGMA foreign_keys = ON` (`R-DATA-004`), which
  `task.md:56` names as the one thing the D1 binding exists to make testable. Worse for secrets:
  `ctx.env.CREDENTIAL_ENCRYPTION_KEY` becomes reachable from any use case, so the ADR-007 constraint
  that decrypted credentials are cached "for the lifetime of one request only" has no chokepoint to
  be enforced at. The spec's `buildAppContext`
  (`docs/rebuild/05-target-architecture/module-boundaries.md:41-77`) deliberately returns *named
  collaborators* — `db, objectStore, cache, clock, ids, logger, …` — and never `env`. Once one
  use case reads `ctx.env`, the pattern is copied.
- **Fix:** Drop `env` from the `AppContext` interface. Have `buildAppContext(env)` consume `env`
  and return the collaborators it builds — for CAP-001 that can be as little as
  `{ db: getDatabase(env), objectStore: getObjectStore(env), cache: getCache(env), clock: systemClock,
  ids: systemIds, logger, config: loadConfig(env) }`, which uses the platform accessors already
  written and left unreferenced.

### H3 — `eslint-plugin-import` is installed and registered with no rules; the module dependency table is enforced by nothing

- **Where:** `eslint.config.js:4,76-78` (plugin registered), `eslint.config.js:85-101` (rules block —
  no `import/*` rule present), `package.json:31` (dependency)
- **Violates:** `work/active/CAP-001-monorepo-scaffold/task.md:52` verbatim — "The capability's job is
  to ensure the toolchain enforces the rules we will implement later"; `.claude/rules/coding.md`
  §Dependencies ("Adding a runtime dependency requires: a named concrete need")
- **Failure scenario:** The plugin's presence with zero rules is the tell — the intent was recorded
  and not executed. Concretely, in Phase 1 an implementer writes
  `import { MailboxRepository } from '../tenancy/infrastructure/mailbox-repository'` inside
  `modules/messages`. `pnpm lint` exits 0, `pnpm typecheck` exits 0, `pnpm test` exits 0 — and two
  rules are broken silently: the public-surface rule (`.claude/rules/architecture.md` §Forbidden,
  "Importing anything but a module's `index.ts`") and, if the target is `outbound-mail` rather than
  `tenancy`, the reverse-direction rule (`module-boundaries.md:31-32`). With twelve modules and a
  dependency table that permits roughly twenty of the 132 possible edges, this is not a hypothetical;
  it is the default outcome of unenforced boundaries, and it is the specific failure that produced
  the legacy system this rebuild exists to replace. Detection is then a human reviewer noticing one
  import line in a large diff.
- **Fix:** Enable, at minimum, `import/no-cycle` (`{ maxDepth: Infinity }`) and
  `import/no-restricted-paths` with zones encoding the three hard edges: `integrations/*` may not
  import `modules/*`; `modules/*` may not import `entrypoints/*`, `http/*`, or `hono`;
  `modules/<a>` may not import `modules/<b>/**` except `modules/<b>/index.ts`. Three zones catch the
  large majority of §Forbidden. If the full table is too much for CAP-001's scope, land the three
  zones here and record the remainder as a CAP-003 (`scaffold doctor`) item in the ledger — but do
  not leave a registered plugin with no rules, because it reads as "already handled" to the next
  agent.

## MEDIUM

### M1 — `http/router.ts` is dead; the entrypoint owns its own Hono app and duplicates `/healthz`, and no middleware is composed anywhere

- **Where:** `apps/worker/src/http/router.ts:10-14` (`buildRouter()` — called by nothing),
  `apps/worker/src/entrypoints/http.ts:16-19` (second Hono app, second `/healthz`),
  `apps/worker/src/http/middleware/{authn,authz,error,request-id}.ts` (exported, never mounted)
- **Violates:** `.claude/rules/architecture.md` §Shape — `entrypoints/` are "thin shells";
  `docs/rebuild/05-target-architecture/architecture.md:64-66` ("router.ts # route composition")
- **Failure scenario:** Two route surfaces exist and only one is reachable. A CAP-007 implementer
  reading `architecture.md:65` adds `/setup/status` to `buildRouter()` — the correct place — and it
  returns 404, because `entrypoints/http.ts` never mounts the router. Debugging that costs an hour
  and the likely "fix" is to add the route to the entrypoint instead, which is how the entrypoint
  stops being a thin shell. Separately, `requestId` is never mounted, so the `requestId` field that
  `.claude/rules/security.md` §Logging requires on every log line and `§API conventions` requires in
  every error envelope has no producer.
- **Fix:** Have `entrypoints/http.ts` do only `const app = buildRouter(); app.onError(errorMiddleware);
  export default app;` and move the `/healthz` route into `router.ts`. Mount `requestId` in
  `buildRouter()` now even as a no-op, so the composition order is established before there are
  routes to break.

### M2 — `inbound-email.ts` performs a hardcoded external side effect in a capability whose scope is "zero business code"

- **Where:** `apps/worker/src/entrypoints/inbound-email.ts:8` —
  `await message.forward('devnull@unimailbox.local')`
- **Violates:** `work/active/CAP-001-monorepo-scaffold/task.md:41` — "Any business rule, business
  code, or production behaviour. CAP-001 lays rails; nothing more."
- **Failure scenario:** This is latent only because B1 leaves the handler unbundled — fixing B1
  activates it. Once wired, every inbound message is forwarded to a domain that does not resolve;
  Email Routing surfaces a forwarding failure per message, and the message is *consumed* rather than
  rejected, so there is no bounce back to the sender carrying a usable reason. The correct inbound
  refusal primitive is `message.setReject(reason)` — the same primitive `R-INBOUND-005` (blocklist
  rejection) will need. A hardcoded address in an entrypoint is also a configuration value in code,
  which is the shape the legacy settings god-object grew from.
- **Fix:** Make the stub inert — an empty handler body, or `message.setReject('not yet accepting
  mail')` with a comment naming the capability that replaces it.

### M3 — `packages/config` is unreferenced and `platform/config.ts` re-declares a weaker version of its type

- **Where:** `packages/config/src/index.ts:10,14-17` (`EnvironmentName`, `SharedConfig` — imported by
  no file in the workspace), `apps/worker/src/platform/config.ts:5-7`
  (`PlatformConfig { environment: string }`), `apps/worker/package.json:15` (dependency declared,
  never imported)
- **Violates:** `.claude/rules/documentation.md` §One fact, one home; `.claude/rules/architecture.md`
  §Shape (`packages/config/` — "shared config types")
- **Failure scenario:** Two homes for the same fact, and the reachable one is the weaker. Because
  `PlatformConfig.environment` is `string` rather than the `'local' | 'preview' | 'staging' |
  'production'` union that already exists one package over, a later
  `if (config.environment === 'production') { /* enable strict cookie flags */ }` silently evaluates
  false against a typo or an unexpected `vars.ENVIRONMENT` value — `wrangler.jsonc:90` sets it to a
  free-form string with no validation. The failure is a security-relevant branch that never runs, and
  it typechecks.
- **Fix:** Have `platform/config.ts` import `EnvironmentName` and `SharedConfig` from
  `@unimailbox/config` and narrow `env.ENVIRONMENT` through a check rather than `?? 'local'`. This
  also gives the workspace one real cross-package import, which is what the package boundary is
  supposed to be proving in this capability.

## LOW

### L1 — Provider adapters are flat files where the target architecture specifies directories

- **Where:** `apps/worker/src/integrations/providers/{brevo,resend,cf-sendmail}.ts` vs
  `docs/rebuild/05-target-architecture/architecture.md:84-86` (`brevo/`, `resend/`, `cf-sendmail/`)
- **Note:** `task.md:84` explicitly specifies the flat `.ts` form and the contract is authoritative,
  so this is not a defect in the implementation — it is a divergence the orchestrator should resolve
  deliberately. `docs/rebuild/05-target-architecture/integration-boundaries.md:8-13` shows each
  provider supplying a `ProviderPlugin` with up to three adapters (`outbound`, `webhook`, `sync`);
  one file per provider will exceed the ~150-line guidance in `.claude/rules/coding.md` §Structure by
  the time Brevo has all three. Either amend the contract or accept that Phase 1 converts these to
  directories.

## Not verified

- **Runtime behaviour of any handler.** I did not run `wrangler dev` or issue a request. B1's claim
  rests on reading `wrangler.jsonc:7` and the built artifact `apps/worker/dist/http.js`, whose final
  statement is `export { http_default as default }` with no `email`/`queue`/`scheduled` symbol
  anywhere in the bundle. That is strong evidence for "the handlers are not deployed" and does not
  by itself prove Cloudflare's behaviour on receiving a queue message for a Worker with no consumer
  handler — I am asserting that from the platform contract, not from an observed failure.
- **Whether `wrangler deploy --dry-run` warns about the consumer/handler mismatch.** It may already
  be emitting a warning that was not treated as failing since the command still exits 0. Worth
  checking when B1 is fixed.
- **Provider adapter conformance to `OutboundProviderAdapter`.** All four provider files are
  `export {}`, so there is nothing to check. Note that `OutboundProviderAdapter` is not yet declared
  in `packages/contracts` — `.claude/rules/architecture.md` §Forbidden says that is its home. Out of
  scope for CAP-001 per `task.md:46`; flagging so Phase 1 does not declare it in `integrations/`.
- **Legacy anti-pattern sweep — result: none present, as expected.** No god-object settings table
  (no tables at all), no plaintext secret in config (`wrangler.jsonc:75-86` correctly references
  Secrets Store bindings only, and the placeholder IDs are not credentials), no string-built SQL, no
  JSON-in-text column, no second authorization source (`authz.ts` is a single no-op), no second web
  client, no Zustand-as-event-bus (Zustand is not installed), no `document.execCommand`. No DI
  container, no `BaseService`, no config-driven provider branching, no Kafka/NATS/CQRS/plugin system.
  I confirmed these by reading every source file in `apps/worker/src`, `apps/web/src`, and
  `packages/*/src` — 44 files, all listed above or trivially `export {}`.
- **Module skeleton cleanliness — result: clean.** All twelve `modules/*/index.ts` contain only a
  comment block and `export {}`. Zero imports of Hono, `Env`, a provider SDK, or another module.
  All six `integrations/*` files likewise import nothing, so the `integrations → modules` reverse
  edge does not exist. No module has any file outside its `index.ts`, so the public-surface rule
  cannot currently be violated. `platform/clock.ts:9` and `platform/ids.ts:9` correctly confine
  `Date.now()` and `crypto.randomUUID()` behind injectable wrappers, which is the point of
  `.claude/rules/testing.md` §Determinism — that part is right.

## Required fixes

1. **B1** — Make one entry module export all four handlers; add `triggers.crons` or remove the
   orphaned queue consumer; delete the false "named-entry workers" comment.
2. **H1** — Move `Bindings` out of `entrypoints/http.ts` into `platform/` (or `packages/config`) and
   rename to `Env`.
3. **H2** — Remove `env` from the `AppContext` interface; return named collaborators instead.
4. **H3** — Enable `import/no-cycle` plus three `import/no-restricted-paths` zones, or record the
   deferral in the ledger with a named owner.
5. **M1** — Mount `buildRouter()` from the entrypoint; move `/healthz` into the router; mount
   `requestId`.
6. **M2** — Make the inbound-email stub inert.
7. **M3** — Consume `@unimailbox/config`'s `EnvironmentName` from `platform/config.ts`.
8. **L1** — Orchestrator decision only: reconcile flat-file vs directory provider layout between
   `task.md:84` and `architecture.md:84-86`.
