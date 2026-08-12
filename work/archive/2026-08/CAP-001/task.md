# CAP-001 — Monorepo scaffold + toolchain

**Phase:** 0 · **Status:** In Progress · **Started:** 2026-08-12

## Goal

A clean checkout of this repo runs `pnpm install`, then `pnpm build`, `pnpm lint`, `pnpm typecheck` and exits 0 against a Worker entrypoint that binds D1/R2/KV/Queue/Secrets Store, plus a React client that builds with Vite — with zero business code written.

## Scope

- pnpm workspace (`pnpm-workspace.yaml`) covering:
  - `apps/worker` — Hono app on Cloudflare Workers. Four entrypoint shells: `http.ts`, `inbound-email.ts`, `queue.ts`, `scheduled.ts`. `app-context.ts` composition root. Module skeletons (no business logic) with empty `index.ts` re-exports per `.claude/rules/architecture.md` §Shape.
  - `apps/web` — React + Vite client. Router (`/`, `/setup`, `*`), TanStack Query provider, design-token CSS variables, no feature pages beyond a stub `/setup` placeholder.
  - `packages/contracts` — zod schemas + TS types. One sample schema to prove the pipeline.
  - `packages/email-core` — pure RFC 5322 module skeleton (no I/O, no `Date.now()`).
  - `packages/config` — shared config types.
  - `packages/test-kit` — fixture / helper skeleton.
  - `migrations/` — empty directory with a `.gitkeep`. (CAP-004 writes the first migration.)
  - `scripts/` — empty placeholder for scaffold / migration scripts. (CAP-003 owns `scaffold doctor`.)
- Root `package.json` with the full set of `pnpm` scripts:
  - `pnpm install` — workspace install, no warnings about missing peer deps
  - `pnpm build` — builds worker (`wrangler deploy --dry-run`) and web (`vite build`)
  - `pnpm lint` — ESLint flat config across the workspace
  - `pnpm typecheck` — `tsc --build` for the whole workspace with strict mode
  - `pnpm dev:worker`, `pnpm dev:web` — local dev servers
  - `pnpm test:unit`, `pnpm test:worker` — stubs that exit 0 (real configuration lands in CAP-002)
- Wrangler config (`apps/worker/wrangler.jsonc`) with **auto-provisioning** for:
  - `[[d1_databases]]` binding `DB`
  - `[[r2_buckets]]` binding `ATTACHMENTS`
  - `[[kv_namespaces]]` binding `SETUP_SESSION` and `CACHE`
  - `[[queues.producers]]` binding `OUTBOUND`
  - `[[secrets_store_secrets]]` binding `INSTALLATION_TOKEN`, `CREDENTIAL_ENCRYPTION_KEY`
  - Version pin: `wrangler` dev dep ≥ `4.39.0`
- TypeScript root `tsconfig.json` with project references for every workspace package/app.
- ESLint flat config + Prettier config with shared rules.
- `.editorconfig`, `README.md` (project-level, distinct from `CLAUDE.md`).
- A `packages/test-kit/src/index.ts` that exports one placeholder helper, so the test harness can import from it.

## Out of scope

- Any business rule, business code, or production behaviour. CAP-001 lays rails; nothing more.
- The first real D1 migration. (CAP-004.)
- `pnpm scaffold doctor` and the rest of the `scripts/` commands. (CAP-003.)
- Real test suites for routes and modules. (CAP-002.)
- Setup-route guard, `/setup/*` handlers, `installation_state` repository. (CAP-006–CAP-009.)
- Provider adapters. (Phase 1.)
- CI workflows. (Not in any Phase 0 capability.)
- A second web client, a desktop app, or any non-Cloudflare deploy target.

## Business rules

No business rules are *implemented* by CAP-001. The capability's job is to ensure the toolchain enforces the rules we will implement later. The wiring must support, but does not yet enforce:

| Rule ID | What CAP-001 must enable for this rule |
|---|---|
| `R-DATA-004` | `PRAGMA foreign_keys = ON` must be settable from the platform/database module. `apps/worker/wrangler.jsonc` must declare the D1 binding so it is testable. |
| `R-SECRET-*` | `secrets_store_secrets` declarations exist in `wrangler.jsonc`; the Worker can read them via `env.INSTALLATION_TOKEN` and `env.CREDENTIAL_ENCRYPTION_KEY`. |
| (testing) | Vitest and `@cloudflare/vitest-pool-workers` are installed and a config file exists at `apps/worker/vitest.config.ts`. They run no real tests yet — that is CAP-002. |

The architectural constraints in `.claude/rules/architecture.md` (dependency direction, no `any`, one writer per file) apply to the scaffolded module skeletons. Empty `index.ts` re-exports only; no `export * from './internal'` to bypass the public surface.

## Acceptance criteria

- [ ] 1. `pnpm install` from a clean checkout completes with no `ERR_*` and no peer-dependency errors.
- [ ] 2. `pnpm typecheck` exits 0 across the workspace (zero errors, zero new `@ts-expect-error`).
- [ ] 3. `pnpm lint` exits 0 across the workspace.
- [ ] 4. `pnpm build` produces both `apps/worker/dist/` (Worker bundle) and `apps/web/dist/` (Vite output).
- [ ] 5. `apps/worker/wrangler.jsonc` declares D1, R2, two KV namespaces, a Queue producer, and two Secrets Store secrets with the exact binding names listed in Scope.
- [ ] 6. The four Worker entrypoints (`http.ts`, `inbound-email.ts`, `queue.ts`, `scheduled.ts`) exist and each exports a `fetch`/`email`/`queue`/`scheduled` handler that returns a 200 from a smoke request against a stub route.
- [ ] 7. The web client builds; running `pnpm dev:web` serves `/` and `/setup` stubs returning HTTP 200.
- [ ] 8. Every module under `apps/worker/src/modules/` has a single `index.ts` that re-exports its public surface; no module has any code outside its `index.ts` that imports another module.
- [ ] 9. `pnpm test:unit` and `pnpm test:worker` exit 0 (stubbed — see Out of scope).
- [ ] 10. No file at the repo root except `CLAUDE.md`, `README.md`, and build/config files (per `.claude/rules/documentation.md` §Root directory).
- [ ] 11. `wrangler deploy --dry-run` from `apps/worker/` exits 0 against the local config.

## Vertical slice

Layers this touches, in dependency order:

- [x] workspace config — `pnpm-workspace.yaml`, root `package.json`, root `tsconfig.json`
- [x] platform skeletons — `apps/worker/src/platform/{config,database,object-store,cache,crypto,logger,clock,ids,errors}.ts` (each a placeholder export, no business logic)
- [x] module skeletons — `apps/worker/src/modules/{identity,onboarding,tenancy,messages,inbound-mail,outbound-mail,provider-sync,attachments,signatures,admin,installation,maintenance}/index.ts`
- [x] entrypoint skeletons — `apps/worker/src/entrypoints/{http,inbound-email,queue,scheduled}.ts`, `apps/worker/src/app-context.ts`, `apps/worker/src/http/router.ts`, `apps/worker/src/http/middleware/{authn,authz,error,request-id}.ts`, `apps/worker/src/http/errors.ts`
- [x] integration skeletons — `apps/worker/src/integrations/providers/{provider-registry,brevo,resend,cf-sendmail}.ts`, `apps/worker/src/integrations/cloudflare/{control-plane,oauth}.ts`
- [x] web app — `apps/web/src/{main.tsx,App.tsx,app/router.tsx,infrastructure/api/client.ts}`
- [x] packages — `packages/{contracts,email-core,config,test-kit}/src/index.ts` + per-package `tsconfig.json` and `package.json`
- [x] tooling — `apps/worker/wrangler.jsonc`, `apps/worker/vitest.config.ts`, root `eslint.config.js`, root `prettier.config.js`, root `.editorconfig`

New module dependency edges introduced: none (all skeletons are independent; the dependency direction rule is documented but unused at this stage).

## File ownership

One writer for this capability.

| Agent | Owns |
|---|---|
| implementer-1 | Everything in Scope, top to bottom. Single slice — no second agent. |

The file count is large but the work is mechanical. If the slice turns out to need splitting, the orchestrator splits it before delegation, not after.

## Reading list

Exactly what the implementer reads:

- `CLAUDE.md` — the entry point
- this file
- `.claude/agents/implementer.md`
- `.claude/rules/coding.md` (TS strict, no `any`, naming, error model)
- `.claude/rules/architecture.md` (workspace shape, dependency direction, module map)
- `.claude/rules/git.md` (commit conventions — the orchestrator commits at capability close, not the implementer)
- `docs/rebuild/05-target-architecture/architecture.md` — module map (Section "Module map")
- `docs/rebuild/05-target-architecture/module-boundaries.md` — module dependency table
- `docs/rebuild/05-target-architecture/integration-boundaries.md` — provider adapter interface (the `index.ts` re-export shape)
- `docs/rebuild/05-target-architecture/data-model.md` — to confirm `installation_state` is one of the first tables (CAP-004 owns the actual SQL)
- `docs/rebuild/08-roadmap/phase-0-foundation.md` — the 11 acceptance criteria this slice feeds into

The implementer does **not** read `docs/` outside this list. If something is missing, the implementer stops and reports it.

## Dependencies

- Requires: — (none — this is the first capability)
- Blocks: CAP-002, CAP-003, CAP-004, CAP-005

## Decisions made during this capability

Open decisions to resolve before or during implementation. The implementer proposes; the orchestrator decides.

| Decision | Options | Default if no answer |
|---|---|---|
| TypeScript version | `5.5.x` (stable) vs newer `5.x` | pin `5.5.4` |
| ESLint config | flat config (`eslint.config.js`, ESLint 9) vs legacy `.eslintrc` | flat config (ESLint 9) |
| Web router | TanStack Router vs React Router | TanStack Router |
| Web build | Vite vs Next.js | Vite |
| Web UI primitives | shadcn/ui-style components | shadcn/ui |
| Logger | pino vs consola vs native `console` | native `console` wrapped in `platform/logger.ts` with structured-JSON output (CAP-016 will swap if needed) |
| Drizzle usage in skeletons | no — schemas land in CAP-004 | none |
| Wrangler config format | `wrangler.jsonc` vs `wrangler.toml` | `wrangler.jsonc` |

## Open questions

Blockers needing the operator.

1. Are we OK with `wrangler dev` using the auto-provisioned local SQLite for D1, or do we need a real D1 instance from day one? Default: local SQLite.
2. Is there a Cloudflare account ID / zone to point at, or should `wrangler.jsonc` ship with placeholder `account_id`? Default: placeholder, fail loudly at deploy time.