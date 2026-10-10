// preflight use case — POST /api/v1/setup/preflight.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// Verifies every Cloudflare binding is present and the database schema is migrated.
// Returns a report of each binding's existence and the current schema version.
// This is the operator's "is the deployment healthy?" check during setup.
//
// CAP-041 preflight hotfix: when every binding is present AND the schema version
// matches the contracts package's CURRENT_SCHEMA_VERSION, the use case atomically
// advances `installation_state.current_step` from `'preflight'` to `'administrator'`
// in the SAME D1 batch as the `setup.preflight.complete` audit_events INSERT
// (R-WORKFLOW-002 + R-AUDIT-001). Both statements live in one `db.batch([...])`
// call; the audit row uses `INSERT ... SELECT FROM installation_state WHERE
// current_step = 'preflight'` so when the conditional UPDATE matches zero rows
// (state already advanced) the audit INSERT also inserts zero rows — re-running
// preflight is a safe no-op and never double-counts.

import type { Database } from '../../platform/database';
import type { SetupSessionStore, Cache } from '../../platform/cache';
import type { ObjectStore } from '../../platform/object-store';
import type { SecretLike } from '../../platform/secrets';
import { readSecret } from '../../platform/secrets';
import type { Clock } from '../../platform/clock';
import type { IdGenerator } from '../../platform/ids';
import { CURRENT_SCHEMA_VERSION } from '@unimailbox/contracts';
import { prepareConditionalUpdateInstallationStep } from './installation-state-repository';

/**
 * Narrow port for the bindings preflight inspects. Deliberately NOT the full
 * Cloudflare Env — modules must not import Env (architecture.md §Forbidden).
 * The route handler passes `c.env`, which is structurally compatible.
 *
 * Application-owned authentication uses the D1 users/sessions tables. The
 * old Better Auth secret is intentionally absent from preflight; it is not a
 * deployed binding and must not block setup health checks.
 */
export interface PreflightBindings {
  readonly DB: Database;
  readonly ATTACHMENTS: ObjectStore;
  readonly SETUP_SESSION: SetupSessionStore;
  readonly CACHE: Cache;
  readonly OUTBOUND: Queue;
  readonly INSTALLATION_TOKEN: SecretLike;
  readonly CREDENTIAL_ENCRYPTION_KEY: SecretLike;
}

export interface PreflightResult {
  readonly bindings: Readonly<Record<string, boolean>>;
  readonly schemaVersion: string;
  // CAP-041 preflight hotfix: true iff this call atomically advanced
  // installation_state.current_step from 'preflight' to 'administrator'
  // in the same D1 batch as the audit row. Re-running preflight when
  // already past 'preflight' yields `false` (conditional UPDATE matches
  // zero rows; no audit row is emitted). Server-internal — never leaks
  // into the response envelope.
  readonly advanced: boolean;
}

/**
 * Checks a secret binding's accessibility. Returns true if the secret can be read,
 * false otherwise. Used for INSTALLATION_TOKEN and CREDENTIAL_ENCRYPTION_KEY.
 */
async function checkSecret(secret: SecretLike): Promise<boolean> {
  try {
    await readSecret(secret);
    return true;
  } catch (err) {
    // Log the reason — this is a diagnostic endpoint; swallowing the error
    // would leave the operator with no context. Matches setup-gate.ts pattern.
    // TODO: replace with structured logger (D-CAP-006-B).
    console.warn('[preflight] secret read failed', err);
    return false;
  }
}

/**
 * Runs preflight checks: verifies all bindings exist and reads the schema version
 * from the d1_migrations table. On a clean deployment (every binding present AND
 * the schema matches `CURRENT_SCHEMA_VERSION`), atomically advances
 * `installation_state.current_step` to `'administrator'` and emits one
 * `setup.preflight.complete` audit row (R-WORKFLOW-002 + R-AUDIT-001).
 *
 * Note: the 5 object-binding checks (DB, ATTACHMENTS, SETUP_SESSION, CACHE,
 * OUTBOUND) are existence-only — they verify the binding object is declared,
 * not that the backing resource is reachable. A `true` result means "the binding
 * is wired in wrangler.jsonc," not "the database is healthy." Deep health checks
 * are a future concern. Secrets get a real accessibility read via readSecret.
 *
 * @param input.db D1 binding the preflight runs against.
 * @param input.env Bindings the preflight inspects (narrow port — see `PreflightBindings`).
 * @param input.requestId The request-id middleware-stamped UUID for the call.
 *   Threaded onto the audit row so R-AUDIT-001's correlation invariant holds
 *   for the preflight → administrator transition (matches the /claim and
 *   /complete pattern).
 * @returns A report with binding presence, schema version, and whether this
 *   call performed the state advance.
 */
export async function runPreflight(
  input: {
    readonly db: Database;
    readonly env: PreflightBindings;
    readonly requestId: string | null;
  },
  deps: { clock: Clock; ids: IdGenerator },
): Promise<PreflightResult> {
  // Check each binding's existence
  // Application-owned authentication has no external identity secret to
  // inspect; D1 users/sessions are the authority.
  const bindings: Record<string, boolean> = {
    DB: !!input.env.DB,
    ATTACHMENTS: !!input.env.ATTACHMENTS,
    SETUP_SESSION: !!input.env.SETUP_SESSION,
    CACHE: !!input.env.CACHE,
    OUTBOUND: !!input.env.OUTBOUND,
    // For secrets, check the value is accessible
    INSTALLATION_TOKEN: await checkSecret(input.env.INSTALLATION_TOKEN),
    CREDENTIAL_ENCRYPTION_KEY: await checkSecret(input.env.CREDENTIAL_ENCRYPTION_KEY),
  };

  // Read schema version from d1_migrations. If the table doesn't exist
  // (migrations never ran), the query throws — catch and report 'unknown'.
  let schemaVersion = 'unknown';
  try {
    const row = await input.db
      .prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')
      .first<{ name: string }>();
    // Extract the numeric prefix (e.g., '0001_initial.sql' → '0001')
    schemaVersion = row?.name?.replace(/\.sql$/, '').split('_')[0] ?? 'unknown';
  } catch (err) {
    // d1_migrations table missing — migrations haven't been applied.
    console.warn('[preflight] d1_migrations read failed', err);
  }

  // CAP-041 preflight hotfix: gate the advance on every binding being
  // present AND the schema version matching CURRENT_SCHEMA_VERSION. Either
  // failure short-circuits — the existing setup wizard surfaces the
  // diagnostic to the operator and the operator re-runs after fixing.
  const allBindingsPresent = Object.values(bindings).every((present) => present);
  const schemaMatches = schemaVersion === CURRENT_SCHEMA_VERSION;

  let advanced = false;
  if (allBindingsPresent && schemaMatches) {
    // R-WORKFLOW-002 + R-AUDIT-001: the conditional UPDATE and the
    // matching `setup.preflight.complete` audit_events INSERT must land
    // in ONE D1 batch. The audit row is a `INSERT ... SELECT FROM
    // installation_state WHERE id = 1 AND current_step = 'preflight'`,
    // so when the conditional UPDATE matches zero rows (state already
    // advanced) the SELECT also yields zero rows and no audit event is
    // inserted — re-running preflight is a safe no-op and never
    // double-counts.
    //
    // Statement order in the batch matters: D1 runs statements
    // sequentially within a single transaction, so the audit INSERT's
    // SELECT runs BEFORE the UPDATE mutates the row. If the row was
    // already past 'preflight', the SELECT yields zero rows and the
    // UPDATE's `WHERE current_step = 'preflight'` predicate matches
    // zero rows too — both are no-ops, the batch commits, no audit row.
    const now = deps.clock.now().toISOString().slice(0, 19).replace('T', ' ');
    const auditId = deps.ids.uuid();
    const auditInsert = input.db
      .prepare(
        `INSERT INTO audit_events
           (id, actor_user_id, action, resource_type, resource_id,
            request_id, metadata, created_at)
         SELECT ?, NULL, ?, ?, NULL, ?, NULL, ?
           FROM installation_state
           WHERE id = 1 AND current_step = ?`,
      )
      .bind(auditId, 'setup.preflight.complete', 'system', input.requestId, now, 'preflight');
    const advanceStmt = prepareConditionalUpdateInstallationStep(
      input.db,
      'preflight',
      'administrator',
      now,
    );
    await input.db.batch([auditInsert, advanceStmt]);
    // Both statements ran atomically. The advance flag reflects whether
    // the conditional UPDATE actually matched a row — we re-read the
    // current step to avoid relying on undocumented per-statement batch
    // metadata. The re-read is cheap and matches the architecture rule
    // that domain logic uses prepared statements + parameterised queries
    // (no string-concatenated SQL).
    const after = await input.db
      .prepare('SELECT current_step FROM installation_state WHERE id = 1')
      .first<{ current_step: string }>();
    advanced = after?.current_step === 'administrator';
  }

  return { bindings, schemaVersion, advanced };
}
