// Demonstrative unit test — apps/worker/src/platform/clock.test.ts.
// Proves the test harness can drive a `Clock` deterministically via the
// `fakeClock` exported by `@unimailbox/test-kit`. Per the determinism
// rule in .claude/rules/testing.md, this file uses no wall-clock nor
// timer-based waits.
//
// Runs under the `unit` vitest project (node pool). Real-binding tests live
// under the `workers` project.
import { describe, expect, it } from 'vitest';
import { fakeClock } from '@unimailbox/test-kit';
import type { Clock } from './clock';

describe('fakeClock (Clock contract)', () => {
  it('satisfies the platform Clock interface', () => {
    const c: Clock = fakeClock(new Date(0));
    expect(c.unixMs()).toBe(0);
  });

  it('seeds now() and unixMs() to the initial date', () => {
    const initial = new Date('2026-02-15T12:34:56.789Z');
    const clock = fakeClock(initial);

    expect(clock.now().toISOString()).toBe('2026-02-15T12:34:56.789Z');
    expect(clock.unixMs()).toBe(initial.getTime());
  });

  it('returns a fresh Date instance each call (mutating it does not move the clock)', () => {
    const clock = fakeClock(new Date('2026-01-01T00:00:00.000Z'));

    const first = clock.now();
    first.setUTCFullYear(1999);

    expect(clock.now().toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('advance() moves both now() and unixMs() forward by the delta', () => {
    const clock = fakeClock(new Date('2026-01-01T00:00:00.000Z'));

    clock.advance(60_000);

    expect(clock.unixMs()).toBe(new Date('2026-01-01T00:01:00.000Z').getTime());
    expect(clock.now().toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('advance() composes across multiple calls', () => {
    const clock = fakeClock(new Date('2026-01-01T00:00:00.000Z'));

    clock.advance(1_000);
    clock.advance(2_000);
    clock.advance(3_000);

    expect(clock.unixMs()).toBe(new Date('2026-01-01T00:00:06.000Z').getTime());
  });

  it('throws when constructed with a non-finite initial date', () => {
    expect(() => fakeClock(new Date('not-a-date'))).toThrow(/fakeClock/);
  });

  it('throws when advance() receives a non-finite delta', () => {
    const clock = fakeClock(new Date('2026-01-01T00:00:00.000Z'));
    expect(() => clock.advance(Number.NaN)).toThrow(/advance/);
  });
});
