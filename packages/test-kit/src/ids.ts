/**
 * @unimailbox/test-kit — deterministic ID generator.
 *
 * Implements the `IdGenerator` contract used by domain code in apps/worker.
 * Mirrors `apps/worker/src/platform/ids.ts` structurally so any consumer of
 * `IdGenerator` accepts the fake.
 *
 * The generator returns the next value from the supplied list on each call.
 * When the list is exhausted, it throws — this is the documented failure
 * mode so tests that forget to seed enough IDs surface the bug instead of
 * silently generating real UUIDs (which would break determinism).
 */
export interface FixedIdGenerator {
  uuid(): string;
}

export function fixedIds(...values: ReadonlyArray<string>): FixedIdGenerator {
  if (values.length === 0) {
    throw new Error('fixedIds: must supply at least one ID');
  }
  for (const v of values) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error('fixedIds: every value must be a non-empty string');
    }
  }
  let index = 0;
  return {
    uuid: (): string => {
      if (index >= values.length) {
        throw new Error(
          `fixedIds: exhausted after ${values.length} call(s); seed more values or reduce call sites`,
        );
      }
      const value = values[index];
      if (value === undefined) {
        // Unreachable: guarded by the length check above.
        throw new Error('fixedIds: unexpected undefined value');
      }
      index += 1;
      return value;
    },
  };
}
