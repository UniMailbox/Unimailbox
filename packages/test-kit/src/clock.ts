/**
 * @unimailbox/test-kit — fake clock.
 *
 * Implements the `Clock` contract used by domain code in apps/worker. The
 * shape mirrors `apps/worker/src/platform/clock.ts` so any consumer expecting
 * `Clock` accepts the fake without an explicit import cycle between the test
 * package and the worker.
 *
 * Determinism rule (.claude/rules/testing.md §Determinism): tests drive time
 * by calling `.advance(ms)`. There is no `sleep` anywhere in tests; if the
 * code under test schedules a callback for "later", the test advances the
 * clock instead of waiting.
 */
export interface FakeClock {
  /** Returns the current seed (or advanced) time as a Date. */
  now(): Date;
  /** Returns the current seed (or advanced) time as Unix milliseconds. */
  unixMs(): number;
  /** Move the clock forward by `ms` milliseconds. Idempotent ordering matters. */
  advance(ms: number): void;
}

export function fakeClock(initial: Date): FakeClock {
  if (!Number.isFinite(initial.getTime())) {
    throw new Error('fakeClock: initial date must be a valid Date');
  }
  let currentMs = initial.getTime();
  return {
    now: (): Date => new Date(currentMs),
    unixMs: (): number => currentMs,
    advance: (ms: number): void => {
      if (!Number.isFinite(ms)) {
        throw new Error('fakeClock.advance: ms must be a finite number');
      }
      currentMs += ms;
    },
  };
}
