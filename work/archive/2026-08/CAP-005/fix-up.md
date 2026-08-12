# CAP-005 — Fix-up contract

## Fixes

### F1 (B1+B2) — Export pure functions from deploy.ts; rewrite tests to import them

**Problem:** `deploy.ts` exports nothing. The test file at `apps/worker/scripts/deploy.test.ts`
duplicates `resolveConfigTemplate`, `generateSecret`, and `checkEnvironmentGuard` as local
copies and tests those copies — not the real code.

**Fix:**

1. In `scripts/deploy.ts`, export these functions:
   - `resolveConfigTemplate(template: string, state: ResourceState): string`
   - `generateSecret(): string`
   - `checkEnvironmentGuard(env: string | undefined): { ok: boolean; error?: string }`
   - `loadResourceState(path: string): ResourceState`
   - `saveResourceState(path: string, state: ResourceState): void`
   - Also export the `ResourceState` interface.

2. Guard the main flow: wrap the imperative execution (everything from the ENVIRONMENT guard
   through `main()`) in:
   ```ts
   // Only run when executed directly, not when imported (e.g., by tests).
   if (import.meta.url === `file://${process.argv[1]}`) {
     // ... imperative flow ...
   }
   ```
   Or use a `main()` function called only at the bottom under that guard. The ENVIRONMENT
   guard must be inside this guard too, so that importing the module for tests does not
   call `process.exit(2)`.

3. Delete `apps/worker/scripts/deploy.test.ts`. Create `scripts/deploy.test.ts` at the
   repo root.

4. In the new `scripts/deploy.test.ts`, import the functions from `./deploy.ts`:
   ```ts
   import { resolveConfigTemplate, generateSecret, checkEnvironmentGuard,
            loadResourceState, saveResourceState, type ResourceState } from './deploy.ts';
   ```
   (Node 22 `--experimental-strip-types` handles `.ts` imports in test files via vitest's
   transformer.)

5. Test the **real** functions, not copies. The test cases from the old file are fine —
   keep the same assertions, just point them at the imports.

6. Remove the integration test that spawns the script with `ENVIRONMENT=preview --dry-run`
   unless it tests something meaningful. If kept, it should verify that dry-run generates
   the resolved config (see F3).

### F2 (H1) — Use `secret update` for existing secrets with `--force-secrets`

**Problem:** When a secret already exists and `--force-secrets` is passed, the script calls
`wrangler secrets-store secret create`, which will fail because the secret already exists.

**Fix:** In `setSecrets()`, when a secret already exists and `forceSecrets` is true, call
`wrangler secrets-store secret update <store-id> --name <name> --value <value> --scopes workers`
instead of `create`. Create is for first-time, update is for existing.

### F3 (H3) — Always generate resolved config; let each function gate on dryRun

**Problem:** `main()` wraps `resolveConfig()`, `runRemoteMigrations()`, and `deploy()` inside
`if (!dryRun)`. This means in dry-run mode:
- The resolved config is never written (operator can't inspect it)
- The internal `dryRun` checks in `runRemoteMigrations()` and `deploy()` are dead code

**Fix:** Remove the outer `if (!dryRun)` block. Call `resolveConfig(state)` unconditionally
(it's a local file write). Each function (`runRemoteMigrations`, `deploy`) already checks
`dryRun` internally — those checks now work as intended. `saveResourceState` should also
run unconditionally (resource state is local-only).

### F4 (H2) — Implement healthz check

**Problem:** The deploy function says "(Healthz check skipped in this version)".

**Fix:** After deploy, if a URL was extracted from `wrangler deploy` output, use `fetch()`
(available in Node 22) to GET `<url>/healthz`. Assert the response is 200 and the body
contains `"ok":true`. If the URL can't be extracted (e.g., `workers_dev: false` with no
custom domain), print a clear warning telling the operator to verify manually — do not
silently skip.

For preview/initial deploys where `workers_dev: false`, the deploy script should mention
that the operator needs to configure a route or custom domain, and that healthz verification
will be available once the route is configured.

### F5 (H4) — Delete misplaced test file

**Problem:** `apps/worker/scripts/deploy.test.ts` exists in the wrong directory.

**Fix:** Delete it. The replacement test file is at `scripts/deploy.test.ts` per F1.
If `apps/worker/scripts/` is now empty after deletion, remove the directory.

### F6 (M1) — Simplify setSecrets logic

**Problem:** The double-condition is inverted and hard to follow:
```ts
if (!secrets.installationToken || forceSecrets) {
  if (secrets.installationToken && !forceSecrets) {
    // skip
  } else {
    // create/update
  }
}
```

**Fix:** Rewrite as a clear three-way:
```ts
if (!secrets.installationToken) {
  // First time: create
} else if (forceSecrets) {
  // Existing + force: update (F2)
} else {
  // Existing + no force: skip with message
}
```

### F7 (M2) — Remove fragile lookahead from resolveConfig regex

**Problem:** The CACHE placeholder regex uses `(?=\s*\n)` to distinguish from SETUP_SESSION,
but the placeholder strings are already unique — the lookahead adds only fragility.

**Fix:** Remove the lookahead. The regex becomes:
```ts
resolved = resolved.replace(
  /"id":\s*"REPLACE_WITH_KV_CACHE_ID"/,
  `"id": "${state.kvCacheId ?? '<missing>'}"`,
);
```
The placeholder string is unique enough.

## Quality gates after fix-up

```
pnpm scaffold doctor      # exits 0
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:worker
pnpm build
```

The new `scripts/deploy.test.ts` must import from `./deploy.ts` and test the real functions.
No duplicated logic in the test file.

## Files to change

| File | Action |
|---|---|
| `scripts/deploy.ts` | **edit** — export pure functions, guard main flow, fix setSecrets (F1+F2+F3+F4+F6+F7) |
| `scripts/deploy.test.ts` | **create** — import from deploy.ts, test real functions (F1+F5) |
| `apps/worker/scripts/deploy.test.ts` | **delete** (F5) |

## Files NOT to change

- `docs/operations/deploy.md` — already good
- `scripts/scaffold.ts` — already good
- `.gitignore` — already good
- `apps/worker/wrangler.jsonc` — never modify
