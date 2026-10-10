// Demonstrative unit test — apps/worker/src/platform/outbound-adapter.test.ts.
// Exercises the stubOutboundAdapter against the spec-shaped
// OutboundProviderAdapter: key, validateConnection(ctx), send(ctx, msg).
// Per the architecture review (M2) — codifying the contract now prevents
// the stub diverging from the spec before real adapters land.
import { describe, expect, it } from 'vitest';
import { stubOutboundAdapter } from '@unimailbox/test-kit';
import type {
  OutboundProviderAdapter,
  ProviderRuntimeContext,
  SendProviderMessage,
} from '@unimailbox/contracts';

const ctx: ProviderRuntimeContext = { env: { ENVIRONMENT: 'local' } };
const msg: SendProviderMessage = {
  idempotencyKey: 'idem-1',
  from: { address: 'sender@example.test' },
  to: [{ address: 'rcpt@example.test' }],
  cc: [],
  bcc: [],
  subject: 'subject',
  html: '<p>html</p>',
  text: 'text',
  attachments: [],
};

describe('stubOutboundAdapter (OutboundProviderAdapter contract)', () => {
  it('declares the spec-shaped key', () => {
    const adapter = stubOutboundAdapter('brevo');
    expect(adapter.key).toBe('brevo');
  });

  it('satisfies the OutboundProviderAdapter interface at compile time', () => {
    const adapter: OutboundProviderAdapter = stubOutboundAdapter('stub');
    expect(typeof adapter.validateConnection).toBe('function');
    expect(typeof adapter.send).toBe('function');
  });

  it('validateConnection resolves without throwing', async () => {
    const adapter = stubOutboundAdapter();
    await expect(adapter.validateConnection(ctx)).resolves.toBeUndefined();
  });

  it('send returns a deterministic ProviderSendResult', async () => {
    const adapter = stubOutboundAdapter();
    const result = await adapter.send(ctx, msg);
    expect(result.providerMessageId).toBe('stub-provider-message-1');
    expect(result.acceptedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('records each call with a 0-based sequence index', async () => {
    const adapter = stubOutboundAdapter();
    await adapter.send(ctx, msg);
    await adapter.send(ctx, msg);
    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]?.sequence).toBe(0);
    expect(adapter.calls[1]?.sequence).toBe(1);
  });

  it('honours setNextProviderMessageId override', async () => {
    const adapter = stubOutboundAdapter();
    adapter.setNextProviderMessageId('custom-id');
    const result = await adapter.send(ctx, msg);
    expect(result.providerMessageId).toBe('custom-id');
  });
});
