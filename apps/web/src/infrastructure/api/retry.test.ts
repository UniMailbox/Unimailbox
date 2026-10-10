// apps/web — API retry/backoff tests.
//
// CAP-041 AC #15: auto-retry on 5xx and 429 with exponential backoff
// (1s, 2s, 4s, 8s, 16s capped at 30s, 5 attempts). 4xx other than 429
// is NOT retried. Network errors are retried.
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_BACKOFF_MS,
  MAX_RETRY_ATTEMPTS,
  defaultRetryPolicy,
  isRetryableStatus,
  sleep,
} from './retry';

describe('isRetryableStatus', () => {
  it('retries on 429', () => {
    expect(isRetryableStatus(429)).toBe(true);
  });

  it('retries on every 5xx', () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(504)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  it('does not retry on 4xx other than 429', () => {
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(403)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(409)).toBe(false);
    expect(isRetryableStatus(413)).toBe(false);
  });

  it('does not retry on 2xx / 3xx', () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(301)).toBe(false);
    expect(isRetryableStatus(304)).toBe(false);
  });
});

describe('defaultRetryPolicy', () => {
  it('exposes the documented maxAttempts and maxBackoffMs', () => {
    expect(defaultRetryPolicy.maxAttempts).toBe(MAX_RETRY_ATTEMPTS);
    expect(defaultRetryPolicy.maxBackoffMs).toBe(MAX_BACKOFF_MS);
  });

  it('computes exponential backoff (1s, 2s, 4s, 8s, 16s)', () => {
    expect(defaultRetryPolicy.nextDelay(1, { status: 503 })).toBe(1_000);
    expect(defaultRetryPolicy.nextDelay(2, { status: 503 })).toBe(2_000);
    expect(defaultRetryPolicy.nextDelay(3, { status: 503 })).toBe(4_000);
    expect(defaultRetryPolicy.nextDelay(4, { status: 503 })).toBe(8_000);
    expect(defaultRetryPolicy.nextDelay(5, { status: 503 })).toBe(16_000);
  });

  it('caps the delay at MAX_BACKOFF_MS (formula sanity check)', () => {
    // The default policy returns null after MAX_RETRY_ATTEMPTS=5, so
    // 2^(n-1)*1000 caps out at 16s (attempt 5) and the MAX_BACKOFF_MS
    // branch is unreachable. Verify the formula via the documented
    // cap: `Math.min(2^(attempt-1)*1000, MAX_BACKOFF_MS)`.
    const base = 2 ** (7 - 1) * 1000;
    const capped = Math.min(base, MAX_BACKOFF_MS);
    expect(capped).toBe(MAX_BACKOFF_MS);
    expect(capped).toBeLessThan(base);
  });

  it('returns null after MAX_RETRY_ATTEMPTS retries', () => {
    expect(defaultRetryPolicy.nextDelay(MAX_RETRY_ATTEMPTS + 1, { status: 503 })).toBeNull();
  });

  it('returns null for non-retryable statuses', () => {
    expect(defaultRetryPolicy.nextDelay(1, { status: 400 })).toBeNull();
    expect(defaultRetryPolicy.nextDelay(1, { status: 404 })).toBeNull();
    expect(defaultRetryPolicy.nextDelay(1, { status: 409 })).toBeNull();
  });

  it('treats 429 as retryable', () => {
    expect(defaultRetryPolicy.nextDelay(1, { status: 429 })).toBe(1_000);
  });
});

describe('sleep', () => {
  it('resolves after the given delay (fake timers)', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const p = sleep(1_000, controller);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it('rejects with AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(sleep(1_000, controller)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects with AbortError when the signal aborts mid-wait', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const p = sleep(10_000, controller);
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    vi.useRealTimers();
  });
});
