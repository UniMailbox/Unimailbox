import { describe, expect, it } from 'vitest';
import { brevoWebhookAdapter } from './brevo-webhook';
import { DomainError } from '../../platform/errors';

const secret = 'webhook-test-secret';
const receivedAtMs = Date.parse('2026-10-04T12:00:00.000Z');

async function sign(rawBody: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, rawBody));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function bytes(body: string): Uint8Array {
  return new TextEncoder().encode(body);
}

async function parse(body: string, signatureHeader?: string) {
  const rawBody = bytes(body);
  return brevoWebhookAdapter.verifyAndParse({
    rawBody,
    signatureHeader: signatureHeader ?? (await sign(rawBody)),
    secret,
    receivedAtMs,
  });
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
  }
}

describe('Brevo webhook adapter', () => {
  it('authenticates the documented Bearer callback and correlates the actual Brevo message-id', async () => {
    const body = JSON.stringify({
      event: 'delivered',
      'message-id': '<provider-1@smtp-relay.mailin.fr>',
      ts: 1_700_000_000,
      ts_event: 1_700_000_020,
    });
    expect(await parse(body, `Bearer ${secret}`)).toMatchObject({
      providerMessageId: '<provider-1@smtp-relay.mailin.fr>',
      eventTimeMs: 1_700_000_020_000,
      eventTimeSource: 'provider',
      status: 'delivered',
    });
    await expectCode(parse('{bad json', 'Bearer incorrect'), 'WEBHOOK_SIGNATURE_INVALID');
    await expectCode(parse(body, 'Bearer '), 'WEBHOOK_SIGNATURE_INVALID');
  });

  it('authenticates the original bytes and preserves the verified payload text', async () => {
    const body = ' { "event" : "delivered", "messageId" : "provider-1" } ';
    const event = await parse(body);
    expect(event).toEqual({
      eventType: 'delivered',
      providerMessageId: 'provider-1',
      status: 'delivered',
      eventTimeMs: receivedAtMs,
      eventTimeSource: 'server',
      rawPayload: body,
    });
    await expectCode(
      parse(body.replace('delivered', 'bounce'), await sign(bytes(body))),
      'WEBHOOK_SIGNATURE_INVALID',
    );
  });

  it('rejects missing or incorrect signatures before interpreting malformed JSON', async () => {
    const rawBody = bytes('{"event":');
    await expectCode(
      brevoWebhookAdapter.verifyAndParse({ rawBody, signatureHeader: null, secret, receivedAtMs }),
      'WEBHOOK_SIGNATURE_MISSING',
    );
    await expectCode(
      brevoWebhookAdapter.verifyAndParse({ rawBody, signatureHeader: 'bad', secret, receivedAtMs }),
      'WEBHOOK_SIGNATURE_INVALID',
    );
    await expectCode(parse('{"event":'), 'INVALID_JSON');
  });

  it('rejects signed non-object JSON and invalid UTF-8', async () => {
    await expectCode(parse('[]'), 'INVALID_JSON');
    const rawBody = new Uint8Array([0xff, 0xfe]);
    await expectCode(
      brevoWebhookAdapter.verifyAndParse({
        rawBody,
        signatureHeader: await sign(rawBody),
        secret,
        receivedAtMs,
      }),
      'INVALID_JSON',
    );
  });

  it('keeps unknown events for audit without advancing message status', async () => {
    expect(await parse('{"event":"new_provider_event","messageId":"provider-1"}')).toMatchObject({
      eventType: 'new_provider_event',
      providerMessageId: 'provider-1',
      status: null,
    });
    expect(await parse('{"event":null,"messageId":42}')).toMatchObject({
      eventType: 'unknown',
      providerMessageId: null,
      status: null,
    });
  });

  it.each([
    ['delivered', 'delivered'],
    ['bounce', 'bounced'],
    ['hard_bounce', 'bounced'],
    ['soft_bounce', 'bounced'],
    ['complaint', 'complained'],
    ['spam', 'complained'],
    ['delayed', 'delayed'],
    ['blocked', 'delayed'],
  ] as const)('maps Brevo %s to %s', async (name, status) => {
    expect((await parse(JSON.stringify({ event: name }))).status).toBe(status);
  });

  it.each([
    [1_700_000_000, 1_700_000_000_000],
    [1_700_000_000_000, 1_700_000_000_000],
    ['2026-08-15T12:00:00.000Z', Date.parse('2026-08-15T12:00:00.000Z')],
    ['2026-08-15T20:00:00+08:00', Date.parse('2026-08-15T12:00:00.000Z')],
  ] as const)('normalizes provider time %s to UTC milliseconds', async (value, expected) => {
    expect(await parse(JSON.stringify({ event: 'delivered', ts: value }))).toMatchObject({
      eventTimeMs: expected,
      eventTimeSource: 'provider',
    });
  });

  it.each([0, -1, 1_700_000_000.5, true, null, 'not-a-date', '2026-08-15T12:00:00', {}])(
    'falls back to server time for invalid provider time %s',
    async (value) => {
      expect(await parse(JSON.stringify({ event: 'delivered', ts: value }))).toMatchObject({
        eventTimeMs: receivedAtMs,
        eventTimeSource: 'server',
      });
    },
  );
});
