import { afterEach, describe, expect, it, vi } from 'vitest';
import { outboundMessageFixture } from '@unimailbox/test-kit';
import {
  outboundAttemptTag,
  RetryableProviderError,
  UnknownProviderOutcomeError,
} from '@unimailbox/contracts';
import { brevoAdapter } from './brevo';

const CTX = { env: { PROVIDER_API_KEY: 'synthetic-provider-key' }, timeoutMs: 1000 };
function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
afterEach(() => vi.restoreAllMocks());

describe('R-OUTBOUND-013/015 bounded Brevo submission and positive evidence', () => {
  it('uses the documented idempotency key and attempt-specific header/tag correlation', async () => {
    const send = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(json({ messageId: '<accepted@example.test>' }));
    const message = outboundMessageFixture();
    await brevoAdapter.send(CTX, message);
    const request = send.mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body)) as {
      headers: Record<string, string>;
      tags: string[];
    };
    expect(body.headers.idempotencyKey).toBe(message.idempotencyKey);
    expect(body.headers['Idempotency-Key']).toBeUndefined();
    expect(body.headers['X-Mailin-custom']).toBe(outboundAttemptTag(message.attemptId ?? ''));
    expect(body.tags).toEqual([outboundAttemptTag(message.attemptId ?? '')]);
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([408, 500, 503, 504])(
    'treats HTTP %s as unknown rather than replay-safe rejection',
    async (status) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ message: 'upstream' }, status));
      await expect(brevoAdapter.send(CTX, outboundMessageFixture())).rejects.toBeInstanceOf(
        UnknownProviderOutcomeError,
      );
    },
  );

  it.each(['duplicate_parameter', 'duplicate_request'])(
    'treats %s as evidence requiring reconciliation',
    async (code) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        json({ code, message: 'already accepted' }, 400),
      );
      await expect(brevoAdapter.send(CTX, outboundMessageFixture())).rejects.toBeInstanceOf(
        UnknownProviderOutcomeError,
      );
    },
  );

  it.each(['600', 'Thu, 15 Oct 2026 12:10:00 GMT'])(
    'preserves Retry-After %s for a definite 429 rejection',
    async (value) => {
      vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-15T12:00:00Z'));
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        json({ message: 'throttled' }, 429, { 'Retry-After': value }),
      );
      try {
        await brevoAdapter.send(CTX, outboundMessageFixture());
        throw new Error('Expected 429');
      } catch (error) {
        expect(error).toBeInstanceOf(RetryableProviderError);
        expect((error as RetryableProviderError).retryAfterSeconds).toBe(600);
      }
    },
  );

  it.each([json({}), new Response('{broken'), new Response('x'.repeat(65_537))])(
    'retains unknown status for an unreadable or incomplete 2xx acceptance',
    async (response) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
      await expect(brevoAdapter.send(CTX, outboundMessageFixture())).rejects.toBeInstanceOf(
        UnknownProviderOutcomeError,
      );
    },
  );

  it('finds acceptance only from an exact attempt tag and a valid dated provider event', async () => {
    const message = outboundMessageFixture();
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        events: [
          {
            tag: 'another-attempt',
            messageId: '<wrong@example.test>',
            date: '2026-10-15T12:00:00Z',
          },
          {
            tag: outboundAttemptTag(message.attemptId ?? ''),
            messageId: '<accepted@example.test>',
            date: '2026-10-15T12:00:01Z',
          },
        ],
      }),
    );
    expect(await brevoAdapter.findSubmission?.(CTX, message.attemptId ?? '')).toEqual({
      providerMessageId: '<accepted@example.test>',
      acceptedAt: '2026-10-15T12:00:01Z',
    });
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/v3/smtp/statistics/events');
    expect(JSON.parse(url.searchParams.get('tags') ?? '')).toEqual([
      outboundAttemptTag(message.attemptId ?? ''),
    ]);
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.search).not.toContain('synthetic-provider-key');
  });

  it.each(['empty', 'untagged', 'invalid-time', 'conflicting'])(
    'never interprets %s lookup results as permission to resubmit',
    async (mode) => {
      const message = outboundMessageFixture();
      const event = {
        tag: outboundAttemptTag(message.attemptId ?? ''),
        messageId: '<accepted@example.test>',
        date: '2026-10-15T12:00:00Z',
      };
      const events =
        mode === 'empty'
          ? []
          : mode === 'untagged'
            ? [{ ...event, tag: 'other' }]
            : mode === 'invalid-time'
              ? [{ ...event, date: '2026-10-15 12:00:00' }]
              : [event, { ...event, messageId: '<second@example.test>' }];
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ events }));
      expect(await brevoAdapter.findSubmission?.(CTX, message.attemptId ?? '')).toBeNull();
    },
  );
});
