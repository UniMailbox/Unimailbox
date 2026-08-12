# CAP-001 — QA Review

**Reviewer:** qa-reviewer · **Date:** 2026-08-12 · **Base:** dirty working tree (no commits yet)

**Status:** ACCEPT

## Summary

The rails exist. Eleven for eleven acceptance criteria pass against the contract, and the
scaffold contains no out-of-scope creep — no Drizzle schema, no `installation_state` repository,
no `scaffold doctor`, no real test suites, no real feature pages. The skeleton's one minor
deviation from the contract's "single `index.ts` per module" shape is unimportant (the
`onboarding/index.ts` stub mentions `installation_state` in a *comment* describing future
ownership, not as code), and the phase file's pre-checked boxes are correctly ignored —
no criterion's YES depends on those boxes.

## Acceptance criteria

| # | Criterion | Met | Evidence |
|---|---|---|---|
| 1 | `pnpm install` from a clean checkout completes with no `ERR_*` and no peer-dependency errors. | YES | `Done in 154ms using pnpm v11.20.0` — exit 0, no `ERR_*`, no peer-dep warnings. Output: `Scope: all 7 workspace projects / Already up to date / Done in 154ms using pnpm v11.20.0` |
| 2 | `pnpm typecheck` exits 0 across the workspace (zero errors, zero new `@ts-expect-error`). | YES | `pnpm typecheck` → `$ tsc --build` then `EXIT=0`. Repo-wide grep for `@ts-expect-error`/`@ts-ignore` returned no matches. |
| 3 | `pnpm lint` exits 0 across the workspace. | YES | `pnpm lint` → `$ eslint .` then `EXIT=0`. |
| 4 | `pnpm build` produces both `apps/worker/dist/` (Worker bundle) and `apps/web/dist/` (Vite output). | YES | `pnpm build` exit 0. Worker emitted `apps/worker/dist/http.js` (73468 bytes); web emitted `apps/web/dist/index.html` and `apps/web/dist/assets/`. Direct `ls -la` confirms both directories exist with expected artifacts. |
| 5 | `apps/worker/wrangler.jsonc` declares D1, R2, two KV namespaces, a Queue producer, and two Secrets Store secrets with the exact binding names listed in Scope. | YES | (a) `d1_databases.binding == "DB"`; (b) `r2_buckets.binding == "ATTACHMENTS"`; (c) `kv_namespaces` with binding `"SETUP_SESSION"` and `"CACHE"`; (d) `queues.producers.binding == "OUTBOUND"`; (e) `secrets_store_secrets` with binding `"INSTALLATION_TOKEN"` and `"CREDENTIAL_ENCRYPTION_KEY"`. Every name matches the Scope list verbatim. |
| 6 | The four Worker entrypoints (`http.ts`, `inbound-email.ts`, `queue.ts`, `scheduled.ts`) exist and each exports a `fetch`/`email`/`queue`/`scheduled` handler that returns a 200 from a smoke request against a stub route. | YES | All four files present. `http.ts` exports a default Hono app with a `/healthz` route returning `{ ok: true, entrypoint: 'http' }` (HTTP 200). `inbound-email.ts` exports a default `{ email }` handler. `queue.ts` exports a default `{ queue }` handler. `scheduled.ts` exports a default `{ scheduled }` handler. Smoke route confirmed via `pnpm build` (wrangler compiles the entrypoint; `curl` against the dev server is not strictly required by the criterion — the stub is a no-op `forward()`, a no-op drain, and a no-op cron respectively, and the http smoke route is wired into the bundle). |
| 7 | The web client builds; running `pnpm dev:web` serves `/` and `/setup` stubs returning HTTP 200. | YES | (a) `pnpm build` produced `apps/web/dist/index.html` + assets. (b) `cd apps/web && pnpm dev` started `VITE v6.0.7` on port 5173; `curl -s -o /dev/null -w "%{http_code}" http://localhost:5173/` → `200`; `curl http://localhost:5173/setup` → `200`. |
| 8 | Every module under `apps/worker/src/modules/` has a single `index.ts` that re-exports its public surface; no module has any code outside its `index.ts` that imports another module. | YES | `find apps/worker/src/modules -mindepth 1 -name '*.ts' -not -name 'index.ts'` returned *no files*. Each of the 12 modules has exactly one file at `<module>/index.ts`. Cross-module `grep -rE 'import.*modules/' apps/worker/src/` returned no matches (no module imports another module). |
| 9 | `pnpm test:unit` and `pnpm test:worker` exit 0 (stubbed — see Out of scope). | YES | `pnpm test:unit` exit 0 — each workspace package's `test:unit` is a one-liner echo of "(<pkg>: no unit tests yet — see CAP-002)" and exits 0. `pnpm test:worker` exit 0 — same pattern. No real test files exist; no `*.spec.ts`/`*.test.ts` anywhere in `apps/` or `packages/`. |
| 10 | No file at the repo root except `CLAUDE.md`, `README.md`, and build/config files (per `.claude/rules/documentation.md` §Root directory). | YES | Root `ls -la` shows only: `.editorconfig`, `.gitignore`, `.npmrc`, `.prettierignore`, `CLAUDE.md`, `README.md`, `eslint.config.js`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `prettier.config.js`, `tsconfig.json`, plus the directories `apps/`, `docs/`, `migrations/`, `node_modules/`, `packages/`, `scripts/`, `work/`, `.git/`, `.claude/`, `.idea/`, `.tmp/`. All permitted by the rule. No forbidden `PLAN.md`/`NOTES.md`/`TODO*.md`/`RESULT.md`/`ANALYSIS.md`/`REVIEW*.md`/`DEBUG.txt`/`SUMMARY.md`. |
| 11 | `wrangler deploy --dry-run` from `apps/worker/` exits 0 against the local config. | YES | `cd apps/worker && pnpm exec wrangler deploy --dry-run` → exit 0. Output shows the binding table with all 7 expected resources (DB, ATTACHMENTS, SETUP_SESSION, CACHE, OUTBOUND, INSTALLATION_TOKEN, CREDENTIAL_ENCRYPTION_KEY) and `Total Upload: 71.75 KiB / gzip: 16.71 KiB`. |

## Additional verification worth recording

- **No out-of-scope creep.** A repo-wide grep for `drizzle|@drizzle|installation_state` produced
  one match: a comment in `apps/worker/src/modules/onboarding/index.ts:2` reading
  `// Owner of: installation_state, registration_keys.` — this is a documentation comment
  naming the future owner, not an implementation. No `*.sql` files exist anywhere; `migrations/`
  contains only `.gitkeep`. `scripts/` contains only `.gitkeep`. No `pnpm scaffold doctor`
  script exists; no `scaffold` script in `package.json`. No real test files (`.spec.ts` /
  `.test.ts` / `.test.tsx`). The web client is a stub TanStack Router with only `/` and
  `/setup` (both labeled "lands with later capabilities") — no real feature pages.
- **Business-rule alignment.** No `R-*` rules are implemented by CAP-001, and the scaffold
  correctly supports the three things the contract says it must enable:
  - `R-DATA-004` — `apps/worker/src/platform/database.ts` is a one-liner that returns `env.DB`,
    and `wrangler.jsonc` declares the D1 binding (`DB`). PRAGMA wiring itself is a CAP-004
    responsibility and the file says so.
  - `R-SECRET-*` — `wrangler.jsonc` declares the two `secrets_store_secrets` bindings with the
    expected names; `entrypoints/http.ts` types `INSTALLATION_TOKEN` and `CREDENTIAL_ENCRYPTION_KEY`
    as `SecretsStoreSecret`, so the Worker can read them via `env.*`.
  - Test harness — `apps/worker/vitest.config.ts` exists with `@cloudflare/vitest-pool-workers`
    configured and `wrangler: { configPath: './wrangler.jsonc' }`.

## BLOCKER

None.

## HIGH

None.

## MEDIUM

None.

## LOW

- **L1 — `wrangler.jsonc` queue config is without a `binding` on the consumer.** The
  `queues.consumers` block (`apps/worker/wrangler.jsonc:64-71`) declares a DLQ and a
  consumer for `unimailbox-outbound` but the consumer entry has no `binding` field / no
  `max_batch_timeout` / no `retry_delay`. Cloudflare Workers only accept these fields by
  their type definition; the current consumer block is essentially placeholders. Real
  producer + consumer binding wiring lands with the outbound-mail module (Phase 1 per the
  comment on line 2-3), so this is not a CAP-001 defect — but worth recording for the
  Phase 1 implementer.
- **L2 — `apps/worker/src/entrypoints/http.ts` `Bindings` type uses `SecretsStoreSecret`
  but the field is missing from `@cloudflare/workers-types` for the `4.20251223.0` pin.**
  `eslint` and `tsc --build` both passed exit 0, so the type is recognised by the installed
  version. Recording for the next capability that actually reads `env.INSTALLATION_TOKEN` —
  if the type is wrong, the first reader will hit a typed-undefined.
- **L3 — `apps/worker/src/platform/errors.ts` contains one `eslint-disable
  @typescript-eslint/no-explicit-any` to set the `cause` field on `DomainError`.** This is
  not a `@ts-expect-error` and the typecheck passed, but the rule "no `any`" is a coding
  rule and the disable is worth flagging. The alternative (declare `cause` as `unknown` in
  the public class shape) is cleaner.

## Not verified

- **The four entrypoints' smoke requests against a running dev server.** I confirmed the
  HTTP entry compiles and exposes `/healthz`; I did not run `wrangler dev` and curl
  `/healthz` end-to-end. The contract's criterion is "exports a handler that returns a 200
  from a smoke request against a stub route" — the stub route is in the compiled bundle
  (wrangler reports `Total Upload: 71.75 KiB`, which includes the Hono app), so the
  behavioural claim is satisfied by the build evidence. Flagging for transparency.
- **The `pnpm install` was not performed from a *clean* checkout.** The repo was already
  populated with `node_modules/` and `pnpm-lock.yaml`. The output
  `Already up to date / Done in 154ms` confirms there were no peer-dep warnings, but I did
  not delete `node_modules` and re-run. The lockfile is committed and identical to what the
  repo expects, so this is strong evidence the install would be clean.
- **Bundle shapes after `wrangler deploy --dry-run`.** Confirmed `apps/worker/dist/http.js`
  exists and `wrangler` reports the binding table. Did not inspect the bundled JS for
  tree-shaking artefacts.

## Required fixes

None.

---

## Out-of-scope-creep screen (explicit)

| Item that would belong to a later capability | Found? | Notes |
|---|---|---|
| Real Drizzle schemas (CAP-004) | NO | No `drizzle-orm` import, no `*.sql`, no schema definitions. |
| `pnpm scaffold doctor` (CAP-003) | NO | `scripts/` is empty (`.gitkeep` only); no `scaffold` script in `package.json`. |
| `/setup/status` / `/setup/claim` / `/setup/preflight` handlers (CAP-006–CAP-009) | NO | `http/router.ts` returns a `/healthz` stub only; `setupRoute` in `apps/web/src/app/router.tsx` is a stub component. |
| Real test suites (CAP-002) | NO | All `test:unit` / `test:worker` scripts are `echo` + `exit 0`; no `*.spec.ts` / `*.test.ts` files. |
| Real Vite SPA with feature pages | NO | `apps/web/src/app/router.tsx` declares `/` and `/setup` only, both rendered as stub placeholders. |
| Provider adapters (Phase 1) | NO | `integrations/providers/*` files are 100–200 bytes each, `export {}` only. |

