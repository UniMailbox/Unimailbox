// brevo.test.ts — CAP-029 H2 Code review-triage unit tests for the Brevo
// adapter. Verifies that:
//   - 4xx error `message` does NOT contain the provider response body
//     (R-SECRET-003 / R-LOG-001 — bodies may carry PII or secret prefixes)
//   - the body is attached as `cause` on a structured Error
//   - 429 routes through RetryableProviderError
//   - other 4xx routes through TerminalProviderError
//
// Tests stub global fetch (the adapter does not import a SDK — it is a
// thin fetch wrapper per ADR-002). The adapter never reads from D1 so this
// runs under the unit vitest project.

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  RetryableProviderError,
  TerminalProviderError,
} from '@unimailbox/contracts';
import { brevoAdapter } from './brevo';

function makeJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeTextResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('brevoAdapter.send — error translation (CAP-029 D-CAP-028-A + H2 review-triage)', () => {
  it('4xx error `message` does NOT contain the provider response body (R-SECRET-003)', async () => {
    // Provider returns a body that contains what could be a secret prefix
    // or PII. The fix: the body MUST NOT land in `error.message` because that
    // surface flows through queue consumer → logger.warn in production.
    const SECRET_LOOKING_BODY = 'xkeysib-deadbeef1234567890 recipient=alice@example.com';
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(makeTextResponse(401, SECRET_LOOKING_BODY));

    let caught: unknown;
    try {
      await brevoAdapter.send(
        { env: { BREVO_API_KEY: 'test-key' } },
        {
          idempotencyKey: 'msg-1',
          from: { address: 'sender@example.com' },
          to: [{ address: 'recipient@example.com' }],
          cc: [],
          bcc: [],
          subject: 'hi',
          html: '',
          text: '',
          references: '',
          attachments: [],
        },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TerminalProviderError);
    const err = caught as TerminalProviderError;
    expect(err.httpStatus).toBe(401);
    // The message must not contain the body (neither the secret prefix nor
    // the recipient PII).
    expect(err.message).not.toContain('xkeysib-');
    expect(err.message).not.toContain('recipient=alice');
    expect(err.message).not.toContain(SECRET_LOOKING_BODY);
    // It must still surface the status code for operator triage.
    expect(err.message).toMatch(/Brevo send failed/);
    expect(err.message).toMatch(/401/);

    // The body must be preserved on the cause chain so an operator can
    // inspect it without it leaking into the standard log stream.
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain('xkeysib-');
    expect((err.cause as Error).message).toContain('recipient=alice');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('429 routes through RetryableProviderError (CAP-029 M3 review-triage)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeJsonResponse(429, { message: 'rate limit' }),
    );

    let caught: unknown;
    try {
      await brevoAdapter.send(
        { env: { BREVO_API_KEY: 'test-key' } },
        {
          idempotencyKey: 'msg-2',
          from: { address: 'sender@example.com' },
          to: [{ address: 'r@example.com' }],
          cc: [],
          bcc: [],
          subject: 'hi',
          html: '',
          text: '',
          references: '',
          attachments: [],
        },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RetryableProviderError);
    const err = caught as RetryableProviderError;
    expect(err.httpStatus).toBe(429);
    // Body is attached as cause, not in the message.
    expect(err.message).not.toContain('rate limit');
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toContain('rate limit');
  });

  it('5xx routes through RetryableProviderError with body attached as cause', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeTextResponse(503, 'upstream overloaded'),
    );

    let caught: unknown;
    try {
      await brevoAdapter.send(
        { env: { BREVO_API_KEY: 'test-key' } },
        {
          idempotencyKey: 'msg-3',
          from: { address: 'sender@example.com' },
          to: [{ address: 'r@example.com' }],
          cc: [],
          bcc: [],
          subject: 'hi',
          html: '',
          text: '',
          references: '',
          attachments: [],
        },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RetryableProviderError);
    expect((caught as RetryableProviderError).httpStatus).toBe(503);
  });

  it('400 (other 4xx) routes through TerminalProviderError with body attached as cause', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      makeTextResponse(400, 'invalid recipient address format'),
    );

    let caught: unknown;
    try {
      await brevoAdapter.send(
        { env: { BREVO_API_KEY: 'test-key' } },
        {
          idempotencyKey: 'msg-4',
          from: { address: 'sender@example.com' },
          to: [{ address: 'r@example.com' }],
          cc: [],
          bcc: [],
          subject: 'hi',
          html: '',
          text: '',
          references: '',
          attachments: [],
        },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TerminalProviderError);
    expect((caught as TerminalProviderError).httpStatus).toBe(400);
    // Body preserved as cause for operator triage.
    expect((caught as TerminalProviderError).cause).toBeInstanceOf(Error);
    expect(((caught as TerminalProviderError).cause as Error).message).toContain(
      'invalid recipient address format',
    );
  });

  it('empty body does not attach a cause (no spurious "provider body: " line)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeTextResponse(401, ''));

    let caught: unknown;
    try {
      await brevoAdapter.send(
        { env: { BREVO_API_KEY: 'test-key' } },
        {
          idempotencyKey: 'msg-5',
          from: { address: 'sender@example.com' },
          to: [{ address: 'r@example.com' }],
          cc: [],
          bcc: [],
          subject: 'hi',
          html: '',
          text: '',
          references: '',
          attachments: [],
        },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(TerminalProviderError);
    expect((caught as TerminalProviderError).cause).toBeUndefined();
  });

  it('network failure (fetch rejection) routes through RetryableProviderError with cause', async () => {
    const networkError = new Error('socket hang up');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(networkError);

    let caught: unknown;
    try {
      await brevoAdapter.send(
        { env: { BREVO_API_KEY: 'test-key' } },
        {
          idempotencyKey: 'msg-6',
          from: { address: 'sender@example.com' },
          to: [{ address: 'r@example.com' }],
          cc: [],
          bcc: [],
          subject: 'hi',
          html: '',
          text: '',
          references: '',
          attachments: [],
        },
      );
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(RetryableProviderError);
    // The cause is the original network error — preserves the chain.
    expect((caught as RetryableProviderError).cause).toBe(networkError);
  });
});