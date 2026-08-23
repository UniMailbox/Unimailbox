// preflight use case — POST /api/v1/setup/preflight.
// Owner: onboarding module. Private file — export through modules/onboarding/index.ts.
//
// Verifies every Cloudflare binding is present and the database schema is migrated.
// Returns a report of each binding's existence and the current schema version.
// This is the operator's "is the deployment healthy?" check during setup.

import type { Database } from '../../platform/database';
import type { SetupSessionStore, Cache } from '../../platform/cache';
import type { ObjectStore } from '../../platform/object-store';
import type { SecretLike } from '../../platform/secrets';
import { readSecret } from '../../platform/secrets';

/**
 * Narrow port for the bindings preflight inspects. Deliberately NOT the full
 * Cloudflare Env — modules must not import Env (architecture.md §Forbidden).
 * The route handler passes `c.env`, which is structurally compatible.
 *
 * CAP-042 (AC 11): BETTER_AUTH_SECRET is added so the preflight reports
 * eight binding/resource checks (was seven). readSecret() handles both the
 * SecretsStoreSecret (production) and plain string (test pool) forms.
 */
export interface PreflightBindings {
  readonly DB: Database;
  readonly ATTACHMENTS: ObjectStore;
  readonly SETUP_SESSION: SetupSessionStore;
  readonly CACHE: Cache;
  readonly OUTBOUND: Queue;
  readonly INSTALLATION_TOKEN: SecretLike;
  readonly CREDENTIAL_ENCRYPTION_KEY: SecretLike;
  readonly BETTER_AUTH_SECRET: SecretLike;
}

export interface PreflightResult {
  readonly bindings: Readonly<Record<string, boolean>>;
  readonly schemaVersion: string;
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
 * from the d1_migrations table.
 *
 * Note: the 5 object-binding checks (DB, ATTACHMENTS, SETUP_SESSION, CACHE,
 * OUTBOUND) are existence-only — they verify the binding object is declared,
 * not that the backing resource is reachable. A `true` result means "the binding
 * is wired in wrangler.jsonc," not "the database is healthy." Deep health checks
 * are a future concern. Secrets get a real accessibility read via readSecret.
 *
 * @returns A report with binding presence and schema version.
 */
export async function runPreflight(db: Database, env: PreflightBindings): Promise<PreflightResult> {
  // Check each binding's existence
  // CAP-042 (AC 11): eight binding/resource checks now that
  // BETTER_AUTH_SECRET is provisioned independently (ADR-008 §HTTP and
  // browser session contract). The secret is read via readSecret so the
  // diagnostic reports the same shape the runtime would see; a missing
  // or unreadable secret fails this check the same way a missing
  // KV namespace would.
  const bindings: Record<string, boolean> = {
    DB: !!env.DB,
    ATTACHMENTS: !!env.ATTACHMENTS,
    SETUP_SESSION: !!env.SETUP_SESSION,
    CACHE: !!env.CACHE,
    OUTBOUND: !!env.OUTBOUND,
    // For secrets, check the value is accessible
    INSTALLATION_TOKEN: await checkSecret(env.INSTALLATION_TOKEN),
    CREDENTIAL_ENCRYPTION_KEY: await checkSecret(env.CREDENTIAL_ENCRYPTION_KEY),
    BETTER_AUTH_SECRET: await checkSecret(env.BETTER_AUTH_SECRET),
  };

  // Read schema version from d1_migrations. If the table doesn't exist
  // (migrations never ran), the query throws — catch and report 'unknown'.
  let schemaVersion = 'unknown';
  try {
    const row = await db
      .prepare('SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1')
      .first<{ name: string }>();
    // Extract the numeric prefix (e.g., '0001_initial.sql' → '0001')
    schemaVersion = row?.name?.replace(/\.sql$/, '').split('_')[0] ?? 'unknown';
  } catch (err) {
    // d1_migrations table missing — migrations haven't been applied.
    console.warn('[preflight] d1_migrations read failed', err);
  }

  return { bindings, schemaVersion };
}
