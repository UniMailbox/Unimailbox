# CAP-037 — Port INVALID_JSON guard to admin-blocklist POST

## Goal

Resolves the deferred CAP-035 finding **L1**: malformed JSON sent to
`POST /api/v1/admin/blocklist` currently throws a raw `SyntaxError` from
`JSON.parse`, which the error middleware (`http/middleware/error.ts:31-41`)
maps to `400 VALIDATION_ERROR` — a generic code that conflates JSON parse
errors with zod schema validation failures, and fires with no audit log line.
Mirror the guard that already exists at `apps/worker/src/http/routes/admin-role-policies.ts:132-151`
so the blocklist endpoint returns a stable, dedicated `400 INVALID_JSON` and
emits a structured warn log with `actorUserId`.

This is a single-endpoint mechanical fix. **No other route is in scope.** Other
mutating routes with the same anti-pattern (`compose.ts:125`, `mailboxes.ts:94`,
`setup.ts:86/231/287/542`, `admin.ts:135`) are deferred to **CAP-031 — Request
validation + 1 MB body limit**, which is the proper Phase 2 capability for them
because they will also need a body-size limit and zod-first parsing.

## Reading list (paste-order for any agent working this contract)

- `apps/worker/src/http/routes/admin-blocklist.ts` — the route to fix
- `apps/worker/src/http/routes/admin-role-policies.ts:132-151` — the established
  guard pattern to mirror verbatim (lines 128-131 are the preceding comment block)
- `apps/worker/src/http/routes/admin-role-policies.worker.test.ts:670-693` —
  the established test pattern to mirror verbatim
- `apps/worker/src/http/routes/admin-blocklist.worker.test.ts` — where the new
  test lands (inside the existing `describe('POST /api/v1/admin/blocklist', …)`
  block)
- `apps/worker/src/platform/logger.ts` — confirms `logger.warn(event, ctx?)`
  signature
- `apps/worker/src/platform/errors.ts` — confirms `DomainError` shape
- `.claude/rules/{security,testing,coding,architecture}.md`

## File ownership (this slice)

Implementer owns:

- `apps/worker/src/http/routes/admin-blocklist.ts` (add the guard + the logger
  import)
- `apps/worker/src/http/routes/admin-blocklist.worker.test.ts` (add one test)

No other files. Do not edit `.claude/rules/`, `docs/rebuild/`, the ledger, the
log, or any other route file. The deletion of `blocklist.post` `JSON.parse` from
the "to-do" mental list across the other routes is *not* in scope — see the
goal note above.

## The fix

### Edit 1 — `apps/worker/src/http/routes/admin-blocklist.ts`

1. Add `import { logger } from '../../platform/logger';` to the existing
   import block (alphabetical/grouped by the file's current convention; role-policy
   imports it at line 27 — same depth, same path).
2. Replace the line:

   ```ts
   const body = createBlocklistEntryRequestSchema.parse(JSON.parse(rawBody));
   ```

   with the exact pattern from `admin-role-policies.ts:132-151`, with these
   substitutions:

   - The zod schema is `createBlocklistEntryRequestSchema`.
   - The log event is `'blocklist.post.invalid_json'`.
   - The second-arg context object is **omitted** (POST `/blocklist` has no
     path id; role-policy's `{ roleId }` is for the PUT endpoint).

   Required structure:

   ```ts
   // Security: JSON.parse throws SyntaxError on malformed bodies. Surface
   // a stable INVALID_JSON code (400) instead of letting the raw
   // SyntaxError reach the error middleware. zod still handles
   // structural validation below.
   let body: ReturnType<typeof createBlocklistEntryRequestSchema.parse>;
   try {
     body = createBlocklistEntryRequestSchema.parse(JSON.parse(rawBody));
   } catch (error) {
     if (error instanceof SyntaxError) {
       logger.warn(
         { event: 'blocklist.post.invalid_json', actorUserId: userId },
       );
       throw new DomainError({
         code: 'INVALID_JSON',
         message: 'Request body is not valid JSON',
         httpStatus: 400,
       });
     }
     throw error;
   }
   ```

   The `SyntaxError` instance check, the `logger.warn` call, and the
   `DomainError` shape must match `admin-role-policies.ts:132-151` character-for-character
   modulo the substitutions above. (`:135-150` would skip the `let body:` declaration.) The zod `ZodError` continues to fall through
   to the error middleware as before — that path already produces `400
   VALIDATION_ERROR` and is not affected.

### Edit 2 — `apps/worker/src/http/routes/admin-blocklist.worker.test.ts`

Inside the existing `describe('POST /api/v1/admin/blocklist', () => { … })`
block (lines 142-423), add a single test that mirrors
`admin-role-policies.worker.test.ts:672-693`. The body header comment must cite
`CAP-037` (not `CAP-035 Security M1` — this fix is its own capability).

Required shape:

```ts
// -----------------------------------------------------------------------
// CAP-037: malformed JSON must surface INVALID_JSON (400), not a raw
// SyntaxError. Mirrors admin-role-policies.ts:132-151.
// -----------------------------------------------------------------------
it('returns 400 INVALID_JSON when request body is not valid JSON', async () => {
  const response = await SELF.fetch('http://localhost/api/v1/admin/blocklist', {
    method: 'POST',
    body: '{not valid json',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${adminToken}`,
      'Idempotency-Key': 'blocklist-invalid-json-' + crypto.randomUUID(),
    },
  });

  expect(response.status).toBe(400);
  const body = await response.json();
  expect(body.error.code).toBe('INVALID_JSON');
});
```

The Idempotency-Key must be a fresh UUID per test run — the helper in the file
already uses this pattern (see `'blocklist-empty-' + crypto.randomUUID()` at
line 208).

## What the implementer must NOT do

- Do not change the success path (lines 90-138). The guard wraps only the
  `JSON.parse` + `schema.parse` line.
- Do not change the DELETE handler (lines 149-266) — it has no body to parse.
- Do not change `OPERATION_CREATE` or move the idempotency lookup.
- Do not add the guard to compose/mailboxes/setup/admin routes. Out of scope;
  deferred to CAP-031.
- Do not edit `apps/worker/src/http/routes/admin-role-policies.ts` — the
  pattern is being mirrored, not improved.
- Do not edit migrations, schemas, or `schema-version.ts`.
- Do not introduce a helper function for the try/catch — there is currently
  exactly one site per file, and the Rule of Three says don't abstract until
  three sites exist. (Two sites — admin-role-policies and admin-blocklist —
  remain a coincidence. The refactor is a separate decision, not this slice.)

## Constraints

- Strict TypeScript (`any` is a review finding — use `unknown` and narrow).
- Never log the request body, the Idempotency-Key, or any payload-derived value
  (R-SECRET-003, `.claude/rules/security.md` §Logging).
- Never mock D1/KV/Queue. The existing worker test already runs against real
  bindings — match that.
- Do not commit. Leave the working tree dirty; report exact changed paths.
- Run all gates, report verbatim pass/fail: `pnpm lint`, `pnpm typecheck`,
  `pnpm test:unit`, `pnpm test:worker`, `pnpm build`,
  `pnpm scaffold doctor`.

## Report

Handoff format per `.claude/rules/agent-collaboration.md`. Flag any place the
code contradicts this contract instead of improvising.
