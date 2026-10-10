import { describe, expect, it } from 'vitest';
import { setRolePolicyRequestSchema } from './role-policy';

describe('setRolePolicyRequestSchema — CAP-036 boundaries', () => {
  it('accepts exactly 500 patterns per collection', () => {
    const result = setRolePolicyRequestSchema.safeParse({
      banEmail: Array.from({ length: 500 }, (_, index) => `user${index}@example.com`),
      availDomain: Array.from({ length: 500 }, (_, index) => `@domain${index}.example`),
    });

    expect(result.success).toBe(true);
  });

  it('rejects 501 patterns in either collection', () => {
    expect(
      setRolePolicyRequestSchema.safeParse({
        banEmail: Array.from({ length: 501 }, (_, index) => `user${index}@example.com`),
        availDomain: [],
      }).success,
    ).toBe(false);
    expect(
      setRolePolicyRequestSchema.safeParse({
        banEmail: [],
        availDomain: Array.from({ length: 501 }, (_, index) => `@domain${index}.example`),
      }).success,
    ).toBe(false);
  });

  it('rejects duplicates after pattern normalization', () => {
    const banDuplicate = setRolePolicyRequestSchema.safeParse({
      banEmail: ['duplicate@example.com', ' duplicate@example.com '],
      availDomain: [],
    });
    const domainDuplicate = setRolePolicyRequestSchema.safeParse({
      banEmail: [],
      availDomain: ['@Example.com', '@example.com'],
    });

    expect(banDuplicate.success).toBe(false);
    expect(domainDuplicate.success).toBe(false);
  });
});
