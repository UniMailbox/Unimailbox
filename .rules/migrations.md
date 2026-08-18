# Migration Rules

These rules apply to D1 schema migrations under `migrations/`, the
migration runner at `scripts/migration.mjs`, and shared helpers in
`scripts/_shared.mjs`. They govern every change that touches the shape,
ordering, or verification of production data.

They supplement the repository-wide rules in [README.md](./README.md)
and the front-end rules in [frontend-platform.md](./frontend-platform.md).

## 1. Scope

The rules below apply to:

- `scripts/migration.mjs` — the `new`, `migrate`, `status`, and `verify`
  commands, plus the `assertVerifySqlSafe` helper.
- `scripts/_shared.mjs` — `withSecureTemporaryText`,
  `assertMigrationSet`, `wranglerTargetArgs`, `readJson`, and `parseJsonc`
  when they participate in a migration command.
- `migrations/*.sql` — every committed D1 migration, in order.
- `migrations/meta/*.verify.sql` — every committed verification query.
- `migrations/meta/*.md` — operator-facing metadata for each migration.
- `migrations/meta/released-checksums.json` — the released-migration
  integrity manifest.
- `apps/worker/test/integration/migrations.test.ts` — the Cloudflare
  Test runtime that exercises the migration chain end-to-end.

These rules do **not** apply to ephemeral local fixtures or to ad-hoc
SQL run from a developer shell. They do apply to anything that ships to
preview or production.

## 2. Authoring rules

- Every `migrations/meta/*.verify.sql` file must start with a SQL
  statement on the first non-empty line. The line **must not** begin
  with a SQL line comment (`--`).
  - `wrangler d1 execute --file` accepts a leading comment, but the
    runner used to pass the SQL through `--command`, where
    `wrangler`'s CLI parser interprets a leading `--` as the
    end-of-options marker and fails with
    `Unknown argument: <text after the comment>`. The leading-line
    rule defends against that regression regardless of how the SQL is
    shipped.
- A verify file must return **exactly one row** for the first
  statement. That row's only column must be named
  `migration_verified` and must equal `1` when the migration is valid,
  or `0` when it is not.
- The pattern `SELECT CASE WHEN (...) THEN 1 ELSE 0 END AS
migration_verified;` is the canonical template.
- The last statement must be `PRAGMA foreign_key_check;`. No
  exception. It guarantees the runner sees a structural error in the
  same execution as the assertion.
- Verify SQL must inspect metadata (`pragma_table_info`,
  `sqlite_schema`, `PRAGMA foreign_key_check`, row counts, etc.).
  Do not let verify queries read or write production application data.
- Verify SQL must reference only tables and columns defined by the
  migration it ships with or by an earlier migration in the same
  chain. Do not import SQL from outside `migrations/`.
- Verify SQL must be deterministic. Do not use `datetime('now')`,
  `randomblob`, or other non-reproducible expressions inside an
  assertion row.

Prohibited:

- A verify file whose first non-empty line begins with `--` (rejected
  by `assertVerifySqlSafe` with exit code 9).
- A verify file that returns multiple rows or that names its column
  anything other than `migration_verified`.
- A verify file that ends without `PRAGMA foreign_key_check;`.
- A verify file that touches `users`, `messages`, or any other
  application row outside an aggregate count or metadata lookup.
- A verify file that requires parameters, environment variables, or
  Wrangler bindings beyond what `wrangler d1 execute DB --remote` (or
  `--local`) supplies.

## 3. Runner rules

- The runner is `scripts/migration.mjs`. `pnpm db:verify` and
  `pnpm release:production` invoke it; both must keep passing.
- `verify()` runs each migration's verification file through Wrangler
  with the `--file` flag and `--json`. The SQL is written to a
  short-lived file under `.wrangler/release/` via
  `withSecureTemporaryText` and removed before the next migration is
  processed.
- `--command` is intentionally not used. Any leading `--` line comment
  in the verify SQL is parsed as the end-of-options marker by
  `wrangler`, which would crash the verify step. The runner guards
  against that misconfiguration with `assertVerifySqlSafe`, which
  inspects the first non-empty line of every verify SQL and exits with
  code 9 if it starts with `--`.
- `assertVerifySqlSafe` is called from two places:
  1. `createMigration()` immediately after writing the new verify
     template, so authors see the rejection before committing.
  2. `verify()` for every file before invoking Wrangler, so an
     unfixed file still in the repository cannot slip past CI.
- `bootstrapRemoteInitialMigration()` continues to use `withSecureTemporaryText`
  for the bulk `CREATE TABLE … INSERT INTO d1_migrations` payload.
  Treat that pattern as the canonical reference for any future
  multi-statement remote execution path.
- `assertMigrationSet()` enforces numbering, pairing of
  `*.sql`/`*.verify.sql`/`*.md`, and the integrity of
  `released-checksums.json`. Any change that bypasses those checks
  is a release hazard.

Prohibited:

- Switching `verify()` back to `--command` without an upstream fix
  that lets `wrangler`'s CLI accept a leading `--` comment.
- Bypassing `assertVerifySqlSafe` for "one-off" or "temporary"
  verify files. The check is intentionally cheap and always on.
- Writing verify SQL into a path that outlives the
  `withSecureTemporaryText` callback.

## 4. Examples

### Positive example

`migrations/meta/0008_mailbox_attachment_read_permission.verify.sql`
starts with a `SELECT CASE` block, returns exactly one row whose only
column equals `1`, and ends with `PRAGMA foreign_key_check;`. Its
first non-empty line is the `SELECT CASE` statement, so
`assertVerifySqlSafe` accepts it.

```sql
SELECT CASE
  WHEN (
    SELECT COUNT(*) FROM permissions WHERE key = 'attachment.read'
  ) = 1
  AND (
    SELECT COUNT(*) FROM role_permissions
    WHERE permission_key = 'attachment.read'
      AND role_id IN (
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002'
      )
  ) = 2
  THEN 1
  ELSE 0
END AS mailbox_attachment_read_permission_valid;
PRAGMA foreign_key_check;
```

### Negative example (rejected by `assertVerifySqlSafe`)

The original `migrations/meta/0009_outbound_jobs_scheduled_origin.verify.sql`
began with a SQL line comment. `wrangler d1 execute --command` treated
the rest of the file as positional arguments and `release:production`
failed with:

```text
{"event":"migration.verify_command_failed","message":"✘ [ERROR] Unknown argument:  Return one row with value 1 when the migration is valid"}
```

```sql
-- Return one row with value 1 when the migration is valid.
SELECT 1 AS migration_verified;
PRAGMA foreign_key_check;
```

The replacement moves the documentation into the column comment of the
`SELECT CASE` so the first non-empty line is a real statement:

```sql
-- 0009 outbound_jobs_scheduled_origin: ensure the column was added with
-- NOT NULL, default 0, and the {0,1} CHECK constraint. Reject silently
-- (returning 0) if it is missing so the verify step surfaces a clean
-- migration_verified row in JSON.
SELECT CASE
  WHEN (
    SELECT COUNT(*)
    FROM pragma_table_info('outbound_jobs')
    WHERE name = 'created_via_schedule'
      AND "notnull" = 1
      AND "dflt_value" = '0'
      AND type = 'integer'
  ) = 1
  AND EXISTS(
    SELECT 1 FROM pragma_table_info('outbound_jobs')
    WHERE name = 'created_via_schedule'
  )
  THEN 1
  ELSE 0
END AS migration_verified;
PRAGMA foreign_key_check;
```

## 5. Enforcement

- `scripts/migration.mjs verify` and `scripts/migration.mjs new` both
  invoke `assertVerifySqlSafe`. Any leading `--` line in a verify file
  exits with code 9 and the
  `migration.verify_comment_prefix` event.
- `scripts/migration.test.mjs` covers the three runner paths:
  1. a verify file whose first non-empty line is `--` (exit 9);
  2. a multi-statement verify file with `SELECT … migration_verified`
     and `PRAGMA foreign_key_check;` (exit 0);
  3. a verify file that returns `migration_verified = 0` (exit 6,
     `migration.verify_assertion_failed`).
- `apps/worker/test/integration/migrations.test.ts` exercises the
  migration chain through Cloudflare's test runtime and asserts the
  post-upgrade schema state. It runs as part of `pnpm test:integration`.
- `pnpm release:production` invokes
  `node scripts/migration.mjs verify --target production` as a
  pre-flight gate. A non-zero exit blocks the release.
- `pnpm test:unit` exercises `scripts/migration.test.mjs` together
  with the contracts, configuration, and worker unit suites. It must
  pass before review.
