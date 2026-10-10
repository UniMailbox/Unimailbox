// Strict CLI result parsing; stderr must remain separate from JSON stdout.
interface WranglerListResult<T> {
  success: boolean;
  result?: T[];
  error?: string;
}

export function parseWranglerList<T>(
  r: { status: number | null; stdout: string },
  source: string,
): { ok: true; data: T[] } | { ok: false; error: string } {
  if (r.status !== 0)
    return { ok: false, error: `${source}: command failed (exit ${r.status ?? 'unknown'})` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    // F4: Include first 200 chars of stdout in parse error for diagnostics
    return {
      ok: false,
      error: `JSON.parse failed: ${(e as Error).message}; first 200 chars: ${r.stdout.slice(0, 200)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `expected JSON array from wrangler, got ${typeof parsed}; first 200 chars: ${r.stdout.slice(0, 200)}`,
    };
  }
  // Current Wrangler list commands return a direct JSON array (for example,
  // `wrangler d1 list --json` returns `[ { uuid, name, ... } ]`). Keep
  // accepting the older `{ success, result }` wrapper used by earlier
  // versions so deploy remains compatible across Wrangler releases.
  if (parsed.length === 0) {
    return { ok: true, data: [] };
  }
  const firstValue = parsed[0];
  if (
    firstValue &&
    typeof firstValue === 'object' &&
    ('success' in firstValue || 'result' in firstValue || 'error' in firstValue)
  ) {
    // First element is the legacy batch wrapper.
    const batch = firstValue as WranglerListResult<T>;
    if (batch.success === false) {
      return {
        ok: false,
        error: `wrangler reported success=false: ${batch.error ?? 'unknown error'}`,
      };
    }
    if (!batch.result || !Array.isArray(batch.result)) {
      return {
        ok: false,
        error: `wrangler batch missing or invalid 'result' field (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}`,
      };
    }
    return { ok: true, data: batch.result };
  }

  if (!parsed.every((value) => value !== null && typeof value === 'object')) {
    return {
      ok: false,
      error: `expected list entries to be objects (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}`,
    };
  }
  return { ok: true, data: parsed as T[] };
}

// SELECT query output must use successful result batches. Failed batches,
// bulk import summaries and non-JSON progress output never satisfy a schema check.
function parseWranglerJson(
  r: { status: number | null; stdout: string },
  source: string,
): { ok: true; data: unknown } | { ok: false; error: string } {
  if (r.status !== 0)
    return { ok: false, error: `${source}: command failed (exit ${r.status ?? 'unknown'})` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch (e) {
    return {
      ok: false,
      error: `JSON.parse failed: ${(e as Error).message}; first 200 chars: ${r.stdout.slice(0, 200)}`,
    };
  }
  if (!Array.isArray(parsed)) {
    return {
      ok: false,
      error: `expected JSON array from wrangler, got ${typeof parsed}; first 200 chars: ${r.stdout.slice(0, 200)}`,
    };
  }
  for (const batch of parsed) {
    if (batch && typeof batch === 'object' && (batch as { success?: unknown }).success !== true) {
      const err = (batch as { error?: unknown }).error;
      return {
        ok: false,
        error: `wrangler batch reported success=false: ${typeof err === 'string' ? err : JSON.stringify(err)}`,
      };
    }
    if (!batch || typeof batch !== 'object' || !('results' in batch)) {
      return {
        ok: false,
        error: `wrangler batch missing 'results' key (source=${source}); first 200 chars: ${r.stdout.slice(0, 200)}`,
      };
    }
  }
  return { ok: true, data: parsed };
}

export interface MigrationVerificationAssertion {
  assertion: string;
  pass: number;
}

export type MigrationVerificationResult =
  | { ok: true; assertions: MigrationVerificationAssertion[] }
  | { ok: false; error: string };

/** Parse and enforce the `{ assertion, pass }` migration companion contract. */
export const parseMigrationVerificationOutput = (
  raw: string,
  source: string,
): MigrationVerificationResult => {
  const parsed = parseWranglerJson({ status: 0, stdout: raw }, source);
  if (!parsed.ok) return parsed;

  const assertions: MigrationVerificationAssertion[] = [];
  for (const batch of parsed.data as Array<{ results: unknown }>) {
    if (!Array.isArray(batch.results)) {
      return { ok: false, error: `${source}: Wrangler batch results must be an array` };
    }
    for (const row of batch.results) {
      if (!row || typeof row !== 'object') continue;
      const hasAssertion = 'assertion' in row;
      const hasPass = 'pass' in row;
      if (!hasAssertion && !hasPass) {
        return {
          ok: false,
          error: `${source}: unexpected non-assertion row ${JSON.stringify(row)}`,
        };
      }
      const candidate = row as { assertion?: unknown; pass?: unknown };
      if (typeof candidate.assertion !== 'string' || typeof candidate.pass !== 'number') {
        return {
          ok: false,
          error: `${source}: malformed assertion row ${JSON.stringify(row)}`,
        };
      }
      assertions.push({ assertion: candidate.assertion, pass: candidate.pass });
    }
  }

  if (assertions.length === 0) {
    return { ok: false, error: `${source}: zero assertion rows returned` };
  }
  const failed = assertions.filter((row) => row.pass !== 1);
  if (failed.length > 0) {
    return {
      ok: false,
      error: `${source}: failed assertion(s): ${failed
        .map((row) => `${row.assertion} (pass=${row.pass})`)
        .join(', ')}`,
    };
  }
  return { ok: true, assertions };
};

export interface PendingMigrationDecision {
  ghost: string[];
  pending: string[];
}
export const computePendingMigrations = (
  onDisk: readonly string[],
  applied: readonly string[],
): PendingMigrationDecision => {
  const onDiskSet = new Set(onDisk);
  const appliedSet = new Set(applied);
  const ghost: string[] = [];
  for (const a of applied) {
    if (!onDiskSet.has(a)) ghost.push(a);
  }
  const pending: string[] = [];
  for (const f of onDisk) {
    if (!appliedSet.has(f)) pending.push(f);
  }
  return { ghost, pending };
};

// CAP-039 — the no-op log line, exposed so scripts/deploy.test.ts can
// assert local and remote runners share the same dialect (AC #11). The
// string matches `scripts/db-migrate.ts:124` byte-for-byte.
export const NO_PENDING_LOG_FORMAT = 'No pending migrations';
