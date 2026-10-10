// apps/web — API retry/backoff policy.
// CAP-041 AC #15: auto-retry on 5xx and 429 only, with exponential
// backoff (1s, 2s, 4s, 8s, 16s) capped at 30s, 5 attempts maximum.
// 4xx other than 409/429 is not retryable — those are deterministic
// outcomes the operator must fix manually.
/** Maximum wall-clock backoff between retries. */
export const MAX_BACKOFF_MS = 30_000;

/** Maximum number of retry attempts (excluding the initial fetch). */
export const MAX_RETRY_ATTEMPTS = 5;

export interface RetryPolicy {
  /** Maximum total attempts (initial + retries). RetryDecision policy
   * computes `attempt <= MAX_RETRY_ATTEMPTS`. */
  readonly maxAttempts: number;
  /** Cap on the per-attempt delay. */
  readonly maxBackoffMs: number;
  /** Pure function that decides whether to retry and how long to wait
   * given the attempt number, the response status, and an optional
   * thrown error. Returns `null` when the caller should NOT retry. */
  readonly nextDelay: (
    attempt: number,
    args: { status?: number; error?: unknown },
  ) => number | null;
}

/**
 * `defaultRetryPolicy` — the AC #15 policy encoded as a pure function.
 *
 * 1. `attempt` is 1-based (the first retry is `attempt = 1`).
 * 2. Backoff is `2^(attempt-1)` seconds, capped at `MAX_BACKOFF_MS`.
 * 3. Retryable statuses: 5xx and 429. 4xx other than 429 is NOT retried.
 * 4. Network errors (e.g. fetch threw) are retried.
 * 5. After `MAX_RETRY_ATTEMPTS` retries, returns `null`.
 */
export const defaultRetryPolicy: RetryPolicy = {
  maxAttempts: MAX_RETRY_ATTEMPTS,
  maxBackoffMs: MAX_BACKOFF_MS,
  nextDelay: (attempt, args) => {
    if (attempt > MAX_RETRY_ATTEMPTS) return null;
    const status = args.status;
    if (status !== undefined && !isRetryableStatus(status)) return null;
    const base = 2 ** (attempt - 1) * 1000;
    return Math.min(base, MAX_BACKOFF_MS);
  },
};

/**
 * Pure: is the status worth retrying? 5xx and 429 only. A 409 is a
 * conflict (e.g. `IDEMPOTENCY_KEY_REUSED`) — the operator must decide.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

/**
 * Sleep helper. Exposed for the API client to await between retries.
 * Extracted so tests can swap it for a deterministic clock.
 */
export function sleep(ms: number, controller: AbortController): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (controller.signal.aborted) {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    controller.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}
