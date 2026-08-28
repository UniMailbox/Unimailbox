# CAP-047 draft contract preflight

## Task

Implement only the shared input contracts needed to start CAP-047. This is a local preparatory
slice; it does not implement a route or close/unblock CAP-047.

## Scope

Allowed production/test files:

- `packages/contracts/src/index.ts`
- `packages/contracts/src/index.test.ts`

Add and export the three Zod schemas named by the archived CAP-047 contract:

- `createDraftSchema`: `subject` string max 998; `body_text` string max 65,536;
  optional `body_html` string max 131,072; `to`, `cc`, and `bcc` arrays of validated
  `EmailAddress` values, each max 50; `cc` and `bcc` may be omitted and should default to empty
  arrays if that matches the existing contract conventions.
- `updateDraftSchema`: the same fields, all optional, with no unknown fields accepted.
- `sendDraftSchema`: an empty object schema for the send operation body (the idempotency header is
  enforced by the HTTP middleware, not this body schema).

Export inferred TypeScript types alongside the schemas. Follow existing contracts conventions and
document that these are the CAP-047 wire names (`body_text`/`body_html`), not database Drizzle
names leaking across a boundary. Do not add aliases, route code, migrations, audit actions, or
dependencies.

## Verification

Add focused unit tests covering:

1. valid create input with recipient arrays and defaults;
2. subject/body/body_html boundary acceptance and one-over-limit rejection;
3. each recipient array's 50-item limit and invalid email rejection;
4. update accepts a partial payload but rejects an unknown field;
5. send accepts `{}` and rejects a non-empty body.

Run only:

```text
pnpm exec vitest run packages/contracts/src/index.test.ts
pnpm typecheck
pnpm exec prettier --check packages/contracts/src/index.ts packages/contracts/src/index.test.ts
git diff --check
```

Do not run migrations, deploy commands, secret access, Wrangler writes, or read `.dev.vars`. Do
not commit; the orchestrator owns acceptance and commit. Stop after the listed files and checks.

## Explicit non-goals

- no `apps/worker` or `apps/web` changes;
- no CAP-047 ledger/implementation-log update;
- no claim that CAP-054 preview verification or Phase 2 is complete;
- no remote resource changes (R2, KV, D1, Queue, Secrets Store).

## Completion handoff (2026-08-28)

- Claude Code implemented the two-file contract slice. Its first verification attempt was blocked
  by the local CLI Bash-approval policy; the orchestrator independently ran the checks and applied
  only the Grok-requested strictness/test-coverage cleanup after the follow-up Claude process
  became inactive.
- Grok final review: **PASS**, 0 blocker/high/medium/low findings.
- `pnpm exec vitest run packages/contracts/src/index.test.ts`: 358/358 passed.
- `pnpm typecheck`: passed.
- `pnpm exec prettier --check packages/contracts/src/index.ts packages/contracts/src/index.test.ts`:
  passed.
- `git diff --check`: passed.

This slice is complete and archived. It does not implement CAP-047 runtime routes, change the
capability ledger, or unblock CAP-047 dispatch / CAP-054 preview verification.
