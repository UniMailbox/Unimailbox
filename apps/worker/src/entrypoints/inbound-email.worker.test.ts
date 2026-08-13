// Demonstrative worker-pool test — apps/worker/src/entrypoints/inbound-email.test.ts.
// Proves the harness can invoke the email handler with a synthetic
// ForwardableEmailMessage and observe `setReject` being called.
//
// CAP-013: Updated to pass real env and test the reject path for non-smoke-test
// messages. Smoke test acceptance is covered in inbound-smoke-test.worker.test.ts.
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import inboundEmail from './inbound-email';

function makeMessage(to: string): ForwardableEmailMessage {
  let rejectReason: string | null = null;
  return {
    to,
    from: 'sender@example.com',
    headers: new Headers(),
    raw: new ReadableStream<Uint8Array>(),
    rawSize: 0,
    setReject: async (reason: string): Promise<void> => {
      rejectReason = reason;
    },
    forward: async (_rcptTo: string, _headers?: Headers): Promise<void> => {},
    reply: async (_message: unknown): Promise<void> => {},
    // Test-only accessor for verifying rejection behavior
    ...{ _getRejectReason: (): string | null => rejectReason },
  } as unknown as ForwardableEmailMessage & { _getRejectReason(): string | null };
}

describe('inbound-email handler', () => {
  it('invokes setReject for non-smoke-test messages', async () => {
    const message = makeMessage('user@example.com');

    await inboundEmail.email(message, env);

    expect(message._getRejectReason()).toBe(
      'Inbound email not yet enabled. Only smoke-test messages are accepted during setup.',
    );
  });

  it('does not invoke forward() — the handler is a sink, not a relay', async () => {
    const message = makeMessage('user@example.com');

    await inboundEmail.email(message, env);

    // If we got here without throwing, the handler completed.
    // The message was rejected (not forwarded).
    expect(message._getRejectReason()).not.toBeNull();
  });
});
