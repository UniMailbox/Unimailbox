// secrets.test.ts — unit tests for readSecret.
// Covers both the string (test) and SecretsStoreSecret-like (production) branches.
import { describe, expect, it } from 'vitest';
import { readSecret } from './secrets';

describe('readSecret', () => {
  it('returns a plain string directly', async () => {
    const result = await readSecret('my-secret-value');
    expect(result).toBe('my-secret-value');
  });

  it('calls .get() on a SecretsStoreSecret-like object', async () => {
    let called = false;
    const secretLike = {
      get: async () => {
        called = true;
        return 'secret-from-store';
      },
    };
    const result = await readSecret(secretLike);
    expect(called).toBe(true);
    expect(result).toBe('secret-from-store');
  });

  it('returns empty string when the secret is empty', async () => {
    const result = await readSecret('');
    expect(result).toBe('');
  });
});
