// Demonstrative unit test — apps/worker/src/platform/ids.test.ts.
// Proves the test harness can drive an `IdGenerator` deterministically via
// `fixedIds` from `@unimailbox/test-kit`. Per the determinism rule in
// .claude/rules/testing.md, IDs come from the fixture, not from the
// runtime UUID generator.
import { describe, expect, it } from 'vitest';
import { fixedIds } from '@unimailbox/test-kit';
import type { IdGenerator } from './ids';

describe('fixedIds (IdGenerator contract)', () => {
  it('satisfies the platform IdGenerator interface', () => {
    const i: IdGenerator = fixedIds('id-1');
    expect(i.uuid()).toBe('id-1');
  });

  it('returns the next value from the supplied list in order', () => {
    const ids = fixedIds('user-1', 'user-2', 'user-3');

    expect(ids.uuid()).toBe('user-1');
    expect(ids.uuid()).toBe('user-2');
    expect(ids.uuid()).toBe('user-3');
  });

  it('throws when exhausted so the test cannot silently fall back to random UUIDs', () => {
    const ids = fixedIds('only-one');

    ids.uuid();
    expect(() => ids.uuid()).toThrow(/exhausted/);
  });

  it('throws when constructed with an empty list', () => {
    expect(() => fixedIds()).toThrow(/at least one ID/);
  });

  it('rejects empty-string values', () => {
    expect(() => fixedIds('ok', '')).toThrow(/non-empty string/);
  });
});
