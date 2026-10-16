# CAP-072 — AI usage governance

Status: Implemented locally, 2026-10-16. One writer (main session), no delegation.

Goal: installation and per-user token admission, shared concurrency, durable
unknown outcomes, estimated costs and permission-scoped management/usage views.

Scope: contracts, migration 0042, AI-owned ledger/policy, adapters, composition,
mail reply integration, isolated governance routes/UI, regression tests and docs.
Keep existing strict AI response structures and unrelated personal MCP edit.
Out of scope: deployment, paid/provider calls, recovery tooling and general
release compatibility work beyond touched AI surfaces.

Rules: R-AUTHZ-003/004 use-case mailbox authorization; R-SECRET-003 no prompts,
keys or provider errors in telemetry; R-API-004 idempotent mutations;
R-AUDIT-001 atomic transition audit; R-DATA-004 foreign keys.

Acceptance: atomic user/install quota and concurrency competition; durable
pre-submit reservation and unknown holds; usage survives invalid content;
expiry does not allow another inference; all entrypoints share attribution;
policy CAS/idempotency/audit; own-user/admin isolation; zero/missing prices;
model profile required for enforcement; UI explains observe/enforce and stop
waiting versus cancel billing; local pnpm verify plus focused failures.

The default is observe mode for existing installations. Enforcement requires
operator evidence for a byte-token upper bound, protocol overhead/context and
output cap, pinned to the exact AI configuration revision. No unverified model
is silently certified. See INV-004; provider proof is external acceptance.

No copied external implementation. References: official D1 batch, Workers
lifecycle and token-counting docs linked in INV-004 (retrieved 2026-10-16).
Latest Workers type reference: @cloudflare/workers-types 5.20261016.1;
existing project runtime/config remains pinned to its lockfile.

Persistence uses normalized immutable policy versions and user-limit rows. The
ledger keeps its atomic admission/transition SQL and guarded audit together in
one private repository; policy serialization is isolated in policy-repository.
The browser operation cache is memory-only to preserve the auth/mailbox storage
guard; hard reload recovery relies on durable server holds, not browser tokens.

Validation: isolated pnpm verify passed 2,565 tests (1,431 non-Worker,
1,104 Worker, 30 migrations), doctor 14/14, bindings/lint/types/builds.
Self-review only; no live provider, browser runtime or deployment proof.
