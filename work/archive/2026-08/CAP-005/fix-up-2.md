# CAP-005 — Fix-up pass 2 (post-review)

Consolidated from code review (REJECT), security review (ACCEPT WITH FIXES), and
architecture review (ACCEPT WITH NOTES).

## BLOCKER fixes

### F1 (B1) — Dry-run must not persist state or flip secret flags

**Problem:** `saveResourceState(state)` runs unconditionally (F3 from fix-up 1).
In dry-run, provisioners write `<dry-run-id>` into state, and `setSecrets` flips
`installationToken: true` / `credentialEncryptionKey: true` outside the `if (dryRun)`
guard. The state file on disk now says "secrets already set" with fake IDs. The next
real deploy reads this, skips secret creation entirely, and tries to use fake IDs.

**Fix:**

1. In `main()`, gate `saveResourceState(state)` on `!dryRun`:
   ```ts
   if (!dryRun) {
     saveResourceState(state);
   }
   ```

2. In `setSecrets`, move the flag flips inside the `!dryRun` blocks. The flag should
   only be set to `true` when the secret was actually written to the store:
   ```ts
   if (!secrets.installationToken) {
     if (dryRun) {
       console.log('  [dry-run] Would set INSTALLATION_TOKEN');
     } else {
       // ... wrangler call ...
       secrets.installationToken = true;  // ← only here
     }
   }
   ```
   Do NOT flip the flag in the dry-run branch.

### F2 (B2) — Secrets via stdin instead of --value CLI flag

**Problem:** Secrets passed as `--value <token>` are visible in process lists. Wrangler's
own help says this flag is "Only for testing. Not secure."

**Fix:** Remove the `--value` flag. Instead, omit it and pipe the secret via stdin so
wrangler's interactive prompt reads it from the pipe. Create a separate wrangler wrapper
for secret commands that uses `input` and does NOT set `CI: '1'` (CI mode may suppress
the prompt):

```ts
const wranglerSecret = (subargs: string[], secret: string): { status: number | null; stdout: string } => {
  const result = spawnSync(
    'pnpm',
    ['exec', 'wrangler', ...subargs],
    {
      cwd: WORKER_DIR,
      input: `${secret}\n`,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },  // no CI=1 — let the prompt fire
    },
  );
  const stdout = result.stdout?.toString('utf-8') ?? '';
  const stderr = result.stderr?.toString('utf-8') ?? '';
  return { status: result.status, stdout: stdout + stderr };
};
```

Use this for both `secret create` and `secret update` calls.

## HIGH fixes

### F3 (H1) — D1 create: parse text output, not --json; use uuid field

**Problem:** `wrangler d1 create` does not document `--json`. The D1 payload uses the
field name `uuid`, not `id`.

**Fix:**

1. Remove `--json` from `wrangler d1 create`. Parse the text output for the database ID.
   The output format is:
   ```
   ✅ Successfully created DB 'unimailbox-db'
   [[d1_databases]]
   binding = "DB"
   database_name = "unimailbox-db"
   database_id = "<uuid>"
   ```
   Extract with: `output.match(/database_id\s*=\s*"([a-f0-9-]+)"/)`.

2. For `d1 list --json`: the response items use `uuid` as the identifier field, not `id`.
   Update the `D1Database` interface:
   ```ts
   interface D1Database { uuid: string; name: string }
   ```
   And use `db.uuid` instead of `db.id`.

3. If `--json` is not supported by `d1 list`, fall back to text parsing or skip the
   find-existing step with a warning (see F4).

### F4 (H2) — Parse failures must be visible, not silently swallowed

**Problem:** When `parseWranglerList` returns `{ ok: false }`, every provisioner silently
skips the find-existing step and falls through to `create`. This breaks idempotency: a
re-deploy tries to recreate existing resources and fails with a confusing error.

**Fix:** When `parseWranglerList` returns `{ ok: false }` in a provisioner, print a
warning to stderr:
```
Warning: could not parse wrangler list output for <source> (<error>). Proceeding to create.
If the resource already exists, create will fail — delete .cloudflare-resources.json and re-run.
```

Also add the first 200 chars of stdout to the error message in `parseWranglerList` and
`parseWranglerSingle`, matching `db-migrate.ts`'s diagnostic pattern.

### F5 (H3) — Confirmation prompt for --force-secrets

**Problem:** `--force-secrets` overwrites CREDENTIAL_ENCRYPTION_KEY without confirmation.
If encrypted credentials exist, they become permanently undecryptable.

**Fix:** At the start of `main()`, if `forceSecrets` is true, prompt:

```
WARNING: --force-secrets will overwrite INSTALLATION_TOKEN and CREDENTIAL_ENCRYPTION_KEY.
If CREDENTIAL_ENCRYPTION_KEY is overwritten, all encrypted credentials in the database
will become permanently undecryptable (ADR-007). A re-encryption maintenance job does
not yet exist.

Type 'yes' to continue: 
```

Use `readline.createInterface({ input: process.stdin, output: process.stdout })`. If the
response is not `'yes'`, exit 0 with "Aborted."

Skip the prompt in `--dry-run` mode.

## MEDIUM fixes

### F6 — Reuse db-migrate migration filename regex

**Problem:** `deploy.ts:515` filters migration files with a looser regex than the one
`db-migrate.ts` deliberately established for defense-in-depth.

**Fix:** Extract the regex to a shared constant or import it. Use the same pattern:
```ts
const MIGRATION_FILE = /^\d{4}_[A-Za-z0-9_-]+\.sql$/;
```
Exclude `.verify.sql` files by pattern match (they don't match this regex, so it's
automatic).

### F7 — Healthz: add timeout, parse JSON, document limitation

**Problem:** `fetch()` has no timeout. Body assertion is a fragile substring match.
Under `workers_dev: false`, the URL regex never matches so healthz is dead code.

**Fix:**

1. Add `AbortSignal.timeout(10000)` to the fetch call (10s timeout).
2. `JSON.parse` the body and check `body.ok === true`.
3. In the runbook, add a prominent note that healthz verification only runs when the
   worker has a `*.workers.dev` URL (`workers_dev: true`) or a custom domain. With the
   default config (`workers_dev: false`), the operator must verify manually after
   configuring a route.

### F8 — Test coverage for setSecrets branching

**Problem:** The create/update/skip logic is the most error-prone code and has no tests.
F1's BLOCKER (dry-run flag flip) would have been caught.

**Fix:** Refactor `setSecrets` to accept its dependencies as parameters:
```ts
export const computeSecretAction = (
  secretExists: boolean,
  forceSecrets: boolean,
  dryRun: boolean,
): 'create' | 'update' | 'skip' => { ... };
```

Export and test this pure function with cases:
- Not set, no force → create
- Not set, force → create (force is irrelevant when not set)
- Set, no force → skip
- Set, force → update
- Not set, dry-run → create (but flagged as dry-run)
- Set, dry-run, force → update (but flagged as dry-run)
- Set, dry-run, no force → skip

### F9 — Runbook updates

Add to `docs/operations/deploy.md`:

1. **Rotation warning**: CREDENTIAL_ENCRYPTION_KEY rotation will permanently corrupt
   encrypted credentials. Do NOT rotate until the re-encryption maintenance job exists
   (future capability). Reference ADR-007.
2. **Shared-machine risk**: The deploy command passes secrets to wrangler. On shared
   machines (CI runners, shared dev servers), other users with process-list access may
   observe wrangler's behavior. Use an isolated environment for production deploys.
3. **Healthz limitation**: With `workers_dev: false`, the healthz check is skipped. The
   operator must verify manually after configuring a route.
4. **Multi-account**: On a multi-account Cloudflare login, set `CLOUDFLARE_ACCOUNT_ID`
   to target the correct account.

## LOW fixes (apply if quick)

### F10 — R2 detection: use exact name match

Replace `listResult.stdout.includes('unimailbox-attachments')` with a `--json` parse
and exact `name` field match, consistent with other provisioners. If `--json` parsing
fails, fall back to the substring match with a warning.

### F11 — Main guard: use pathToFileURL

Replace `import.meta.url === \`file://${process.argv[1]}\`` with
`pathToFileURL(process.argv[1]).href === import.meta.url`.

### F12 — Exit codes: propagate wrangler status

Where deploy.ts uses `process.exit(1)` on wrangler failures, use
`process.exit(result.status ?? 1)` to match db-migrate.ts.

### F13 — Docs drift

- `docs/operations/deploy.md:8`: change ">= 4.39.0" to ">= 4.121.0" (the pinned version).
- Troubleshooting entry: change the message to match the actual script output.

### F14 — Remove source-grep test

Remove or replace the `generateSecret.toString()` source-grep test. It tests
implementation text, not behavior, and will break under any refactor.

## Files to change

| File | Fixes |
|---|---|
| `scripts/deploy.ts` | F1–F8, F10–F12 |
| `scripts/deploy.test.ts` | F8, F14 |
| `docs/operations/deploy.md` | F7, F9, F13 |

## Quality gates after fix-up

```
pnpm scaffold doctor      # exits 0
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:worker
pnpm build
```
