# Testing Rules

## Levels

| Level | Command | Scope | Where |
|---|---|---|---|
| Unit | `pnpm test:unit` | Domain logic, state machines, pure functions, `email-core` | vitest |
| Worker | `pnpm test:worker` | Routes, middleware, D1/R2/KV/Queue against real bindings | `@cloudflare/vitest-pool-workers` |
| Migration | migration verify | Each `NNNN_*.sql` has a `NNNN_*.verify.sql` | CI |
| Smoke | setup smoke tests | Real inbound + outbound round-trip on a preview deployment | manual/CI |

`pnpm test` must actually run tests. In the legacy system it ran `wrangler deploy`; that is the
single most-cited process defect in `docs/rebuild/04-legacy-review/`. Never wire a deploy into a
test script.

## What must be tested

A capability is not implementable without these. Reviewers block on absence:

1. **Every business invariant the capability touches** gets a test named after its rule ID, so
   `grep R-MESSAGE-011 test/` finds the proof.
2. **Every state machine transition** — including the *forbidden* ones. Assert that `failed → sending`
   throws, not just that `queued → sending` works. Terminal states must be provably terminal
   (`R-MESSAGE-012`).
3. **Every authorization decision** — one allowed case and one denied case per operation in the
   mailbox matrix. Plus an IDOR test: actor A cannot reach actor B's mailbox by ID.
4. **Idempotency** on every mutating endpoint: replay with same key+body returns the identical
   response; same key + different body returns 409.
5. **Failure paths** — provider error, lock contention, expired lock re-queue, out-of-order webhook.
   The happy path is the easy half.
6. **Boundary conditions** — empty result, single item, cursor pagination across a page edge,
   >1 MB body rejection.

## Mocking

- **Never mock D1, R2, KV, or Queue.** Worker tests run against real bindings via the Cloudflare
  vitest pool. A test that mocks the database tests the mock.
- **Do mock outbound provider HTTP** (Brevo, Resend, Cloudflare Email). External calls in tests are
  flaky and cost money. Mock at the `OutboundProviderAdapter` interface or the fetch boundary,
  never deeper.
- Never mock the code under test or its own module's internals.
- Fixtures and builders live in `packages/test-kit/`, not copy-pasted per test file.

## Determinism

Domain code takes `Clock` and `ids` from `platform/` precisely so tests can inject fixed values.
A test that calls `Date.now()` or sleeps is a test that will flake. No `sleep` in tests; drive the
queue consumer directly.

## Quality gates

A capability is not `Implemented` until all of these pass locally:

```
pnpm scaffold doctor      # exits 0
pnpm lint
pnpm typecheck            # zero errors, zero new @ts-expect-error
pnpm test:unit
pnpm test:worker
pnpm build
```

A capability is not `Verified` until its acceptance criteria in `task.md` are demonstrated
end-to-end and the evidence is recorded per `.claude/rules/documentation.md`.

## Honesty

Report test results exactly as they happened. If a test fails, say so and paste the output. If you
skipped a level, say which and why. Never mark a checkbox in the capability ledger based on a test
you did not run. A `.skip` or `xfail` requires an inline comment naming the condition under which it
is removed.
