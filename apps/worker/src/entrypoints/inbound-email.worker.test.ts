// Demonstrative worker-pool test — apps/worker/src/entrypoints/inbound-email.test.ts.
// Proves the harness can invoke the email handler with a synthetic
// ForwardableEmailMessage and observe `setReject` being called.
import { describe, expect, it, vi } from 'vitest';
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import inboundEmail from './inbound-email';

function makeMessage(overrides: Partial<ForwardableEmailMessage> = {}): ForwardableEmailMessage {
  const setReject = vi.fn((_reason: string): void => {});
  const forward = vi.fn(
    async (_rcptTo: string, _headers?: Headers): Promise<unknown> => ({}),
  );
  const message = {
    from: 'sender@example.com',
    to: 'recipient@example.com',
    raw: new ReadableStream<Uint8Array>(),
    rawSize: 0,
    setReject,
    forward,
    headers: new Headers(),
    replyTo: undefined,
    subject: undefined,
    ...overrides,
  } as unknown as ForwardableEmailMessage;
  return message;
}

describe('inbound-email handler (CAP-001 stub)', () => {
  it('invokes setReject with the documented reason string', async () => {
    const message = makeMessage();

    await inboundEmail.email(message);

    expect(message.setReject).toHaveBeenCalledTimes(1);
    const reason = (message.setReject as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(typeof reason).toBe('string');
    expect(reason).toMatch(/CAP-001/);
  });

  it('does not invoke forward() — the stub is a sink, not a relay', async () => {
    const message = makeMessage();

    await inboundEmail.email(message);

    expect(message.forward).not.toHaveBeenCalled();
  });
});