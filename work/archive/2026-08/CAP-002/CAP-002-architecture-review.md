# CAP-002 — Architecture Review

**Reviewer:** `.claude/agents/architecture-reviewer.md` · **Date:** 2026-08-12 · **Base:** dirty working tree on `master` (CAP-001 on `cap/CAP-001-monorepo-scaffold`, CAP-002 uncommitted)

**Status:** ACCEPT WITH FIXES

## Summary

The harness is structurally sound: `packages/test-kit` is acyclic with `apps/worker`, every co-located `apps/worker/src/platform/**` test imports only platform + test-kit + `cloudflare:test`, no provider SDK or Hono leaks into the wrong layer, and `pnpm test` / `test:unit` / `test:worker` all run real vitest invocations without any `wrangler deploy`. The single substantive defect is acceptance criterion #10, which is **structurally impossible as written** because the vitest-pool-workers runtime (workerd) does not provide `node:inspector/promises`, so `@vitest/coverage-v8` cannot attach to a workers-pool test. A second drift risk is that the declared `OutboundProviderAdapter` is materially simpler than the spec — the test stub now codifies the minimal shape and reconciling later will be a breaking change for everyone who imports it.

## Acceptance criteria — QA reviews only

Not applicable. This is the architecture reviewer.

## BLOCKER

> Ship-stopping: data loss, auth bypass, invariant violation, broken architecture rule.

None.

## HIGH

> Wrong under a realistic condition. Must be fixed before acceptance.

### H1 — Acceptance criterion #10 is structurally unachievable

- **Where:** `work/active/CAP-002-test-harness/task.md:87` (criterion #10) ↔ `apps/worker/vitest.workers.config.ts` (no `coverage` block) ↔ `@vitest/coverage-v8` peer.
- **Violates:** `.claude/rules/testing.md` §Quality gates ("A capability is not `Implemented` until … `pnpm build`" — implied: every acceptance criterion must be runnable) and the architecture reviewer's rule that an unverifiable claim is a process failure.
- **Failure scenario:** `pnpm exec vitest --project workers run --coverage --coverage.provider=v8` exits non-zero with `Error: No such module "node:inspector/promises". imported from "@vitest/coverage-v8/dist/index.js"`. The vitest-pool-workers runtime is `workerd`, which does not implement the V8 inspector hooks `@vitest/coverage-v8` depends on. The criterion cannot be satisfied against the workers project no matter what flag combination is used.
- **Fix:** Reword criterion #10 to run coverage against the unit project (where `apps/worker/vitest.unit.config.ts:24-49` already configures `provider: 'v8'`), or move coverage to `packages/email-core` only. Then rerun and paste evidence into the ledger. Alternatively, drop criterion #10 entirely and record in the ledger that worker-pool coverage is not supported and will be deferred to whatever instrumented coverage tool lands with Phase 6 (per the `docs/rebuild/08-roadmap/phase-6-optimization.md` place-holder).

## MEDIUM

> Should fix. May be deferred if recorded in the capability ledger with a reason.

### M1 — `coverage.thresholds.lines = 100` will gate the build, contradicting the stated "record-only" intent

- **Where:** `apps/worker/vitest.unit.config.ts:40-47` — the comment on line 41 says "Record-only — the build must not fail on these numbers. See task.md §Acceptance criteria #10, #13." Vitest's `coverage.thresholds` is gating by default (this is the documented behaviour; there is no flag that silently demotes thresholds to advisory). The build passes today because the four demonstrative platform tests cover 100% of the trivial primitives in `apps/worker/src/platform/{clock,ids,crypto,errors}.ts`.
- **Violates:** `.claude/rules/testing.md` §Quality gates (the harness is supposed to enable the rules, not introduce a new gating rule the contract did not authorise) and `.claude/rules/coding.md` §Abstraction discipline (a config knob whose comment describes behaviour the knob does not provide is a hidden contract).
- **Failure scenario:** As soon as a real capability lands `apps/worker/src/platform/{config,env,logger,object-store,database,cache,object-store}.ts` content beyond the stubs — which Phase 0 and Phase 1 will do — coverage on the unit project drops below 100% and `vitest run --coverage` exits 1. CI runs `pnpm build`; a passing test suite followed by a failing coverage gate is the failure mode.
- **Fix:** Remove the `thresholds:` block from `vitest.unit.config.ts` (or set `autoUpdate: true` with a documented baseline commit). Either way, fix the comment to match reality. Re-run `pnpm exec vitest --project unit run --coverage --coverage.provider=v8` and confirm it exits 0 without enforcing.

### M2 — `OutboundProviderAdapter` deviates from the spec; the test stub will lock in the divergence

- **Where:** `packages/contracts/src/index.ts:40-57` declares `providerKey: string` and `send(request: OutboundSendRequest): Promise<OutboundSendResult>`. `packages/test-kit/src/stubs.ts:38-65` implements exactly that shape. Compare against `docs/rebuild/05-target-architecture/integration-boundaries.md` (lines around the `OutboundProviderAdapter` block): spec uses `readonly key: ProviderKey` (a branded string), adds `validateConnection(ctx: ProviderRuntimeContext): Promise<void>`, and `send(ctx: ProviderRuntimeContext, msg: SendProviderMessage): Promise<ProviderSendResult>`.
- **Violates:** `.claude/agents/architecture-reviewer.md` §Type leakage (the cross-boundary type is now thinner than the architecture it is supposed to model; future modules will import the partial shape and codify it).
- **Failure scenario:** CAP-014 / CAP-023 land real adapters. To match the spec they must add `validateConnection` and a `ProviderRuntimeContext` parameter. Every consumer that has already imported the CAP-002 shape (`stubOutboundAdapter()` returns one, tests assert on `OutboundSendRequest`, modules may begin depending on `providerKey: string`) breaks. The fix is to add fields to the interface, not modify them, but the field rename `providerKey → key` and the param shape `request → (ctx, msg)` is a breaking change in TypeScript.
- **Fix:** Reconcile the declared interface with the spec now, before anything imports it. Either (a) lift the spec verbatim (`key: ProviderKey`, `validateConnection`, `send(ctx, msg)`) and stub the missing methods in `stubOutboundAdapter()`, or (b) record the deliberate deviation in `docs/rebuild/09-decisions/` as a new ADR and link it from the contract. Option (a) is cheaper; the runtime context is testable with a tiny fake.

## LOW

> Style, naming, minor duplication. Fix if cheap.

### L1 — `inbound-email.test.ts` runs in the workers pool but uses no bindings

- **Where:** `apps/worker/vitest.workers.config.ts:22` includes `src/entrypoints/inbound-email.test.ts`; the test (`apps/worker/src/entrypoints/inbound-email.test.ts:8-26`) builds its `ForwardableEmailMessage` with `vi.fn()` for `setReject` / `forward` and never touches `env`.
- **Fix:** Move the `include` entry for `inbound-email.test.ts` from `vitest.workers.config.ts` to `vitest.unit.config.ts` (and remove it from the workers exclude list). Saves a workerd boot per invocation; the test has nothing to gain from the pool.

### L2 — `apps/worker/test/setup.ts` declares `process` as a local const

- **Where:** `apps/worker/test/setup.ts:10` — `declare const process: { env: Record<string, string | undefined> };`. The file is excluded from `tsc` (`apps/worker/tsconfig.json:22` excludes `src/**/*.test.ts`; setup.ts is not under `src/` but also not in any include list), so this declaration has no type-check effect outside vitest.
- **Fix:** Drop the `declare` line. `process` is a Node global provided by `@types/node`, which is already in the resolver via `vitest`'s pool. The runtime assignment `process.env.ENVIRONMENT = 'local'` still works.

## Not verified

- **The peer-dep matrix between `@cloudflare/vitest-pool-workers@0.21.1` and `vitest@4.1.10`.** I did not consult the package's official compatibility table. Empirically: `pnpm install` emits no peer-dep warning, and `pnpm test:worker` boots workerd, binds all 7 wrangler.jsonc bindings, and runs 10 tests against real D1/KV — so the pairing works at runtime. Acceptance criterion #1 passes on evidence, but the reviewer cannot certify the package's published peer range.
- **Whether vitest 4's coverage report emits per-file rows.** `pnpm exec vitest --project unit run --coverage --coverage.provider=v8` exits 0 and reports an aggregate `100% (6/6)` with **no individual file rows** — possibly a v8 + vitest 4 reporting quirk. Not an architecture concern; flagging so the QA reviewer doesn't read the empty table as a bug.
- **`stubFetch` request matching semantics.** The handler lookup in `packages/test-kit/src/stubs.ts:106` is exact-string match on URL. A test that registers `https://api.example.test/v1/send?key=…` and requests the same URL with a different query order will throw "no handler registered." Probably fine for now (callers register and call in the same test), but worth knowing for Phase 1's first outbound adapter test.

## Required fixes

1. H1 — Make acceptance criterion #10 runnable (run coverage on the unit project, or drop it). Update the ledger evidence.
2. M1 — Remove or repair the `coverage.thresholds` block in `apps/worker/vitest.unit.config.ts:40-47` so the comment matches the behaviour.
3. M2 — Reconcile `OutboundProviderAdapter` with `docs/rebuild/05-target-architecture/integration-boundaries.md` before any module imports it.

---