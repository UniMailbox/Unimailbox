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
import { RetryableProviderError, TerminalProviderError } from '@unimailbox/contracts';
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
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeTextResponse(503, 'upstream overloaded'));

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

// ---------------------------------------------------------------------------
// CAP-054 R-OUTBOUND-004 — payload wire shape on the success path.
//
// Brevo's sendTransacEmail contract puts `headers` inside the JSON body, NOT in fetch
// RequestInit.headers. These tests parse the JSON body the adapter produces and assert
// that headers["Idempotency-Key"] === msg.idempotencyKey on every success path.
// Reference: https://developers.brevo.com/reference/sendtransacemail
// ---------------------------------------------------------------------------

interface BrevoSendPayload {
  readonly sender?: { email?: string; name?: string };
  readonly to?: ReadonlyArray<{ email?: string; name?: string }>;
  readonly cc?: ReadonlyArray<{ email?: string; name?: string }>;
  readonly bcc?: ReadonlyArray<{ email?: string; name?: string }>;
  readonly subject?: string;
  readonly htmlContent?: string;
  readonly textContent?: string;
  readonly headers?: Record<string, string | undefined>;
}

function parseBrevoSendBody(init: RequestInit | undefined): BrevoSendPayload {
  if (typeof init?.body !== 'string') {
    throw new Error('Expected fetch init body to be a JSON string');
  }
  return JSON.parse(init.body) as BrevoSendPayload;
}

function makeOkResponse(messageId: string): Response {
  return new Response(JSON.stringify({ messageId }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

describe('brevoAdapter.send — payload wire shape (CAP-054 R-OUTBOUND-004)', () => {
  it('headers["Idempotency-Key"] equals the supplied canonical message ID', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeOkResponse('brevo-1'));

    const result = await brevoAdapter.send(
      { env: { BREVO_API_KEY: 'test-key' } },
      {
        idempotencyKey: 'canonical-msg-id-uuid-1',
        from: { address: 'sender@example.com', displayName: 'Sender' },
        to: [{ address: 'recipient@example.com' }],
        cc: [],
        bcc: [],
        subject: 'hello',
        html: '<p>html body</p>',
        text: 'text body',
        references: '',
        attachments: [],
      },
    );

    expect(result.providerMessageId).toBe('brevo-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = parseBrevoSendBody(init);
    expect(body.headers?.['Idempotency-Key']).toBe('canonical-msg-id-uuid-1');

    // R-OUTBOUND-004: Idempotency-Key is in the JSON body, NOT in fetch HTTP headers.
    const requestHeaders = (init?.headers ?? {}) as Record<string, string>;
    expect(requestHeaders['Idempotency-Key']).toBeUndefined();
    expect(requestHeaders['idempotency-key']).toBeUndefined();
    expect(requestHeaders['X-Idempotency-Key']).toBeUndefined();

    // Standard Brevo auth + content-negotiation HTTP headers still present.
    expect(requestHeaders['api-key']).toBe('test-key');
    expect(requestHeaders['Content-Type']).toBe('application/json');
    expect(requestHeaders['Accept']).toBe('application/json');

    // JSON payload still carries sender, recipients, subject, content.
    expect(body.sender?.email).toBe('sender@example.com');
    expect(body.sender?.name).toBe('Sender');
    expect(body.to?.[0]?.email).toBe('recipient@example.com');
    expect(body.subject).toBe('hello');
    expect(body.htmlContent).toBe('<p>html body</p>');
    expect(body.textContent).toBe('text body');
  });

  it('Idempotency-Key remains present when msg.messageId is undefined', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeOkResponse('brevo-2'));

    await brevoAdapter.send(
      { env: { BREVO_API_KEY: 'test-key' } },
      {
        idempotencyKey: 'canonical-msg-id-no-message-id',
        from: { address: 'sender@example.com' },
        to: [{ address: 'r@example.com' }],
        cc: [],
        bcc: [],
        subject: 's',
        html: '',
        text: '',
        references: '',
        attachments: [],
        // messageId intentionally omitted.
      },
    );

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = parseBrevoSendBody(init);
    expect(body.headers?.['Idempotency-Key']).toBe('canonical-msg-id-no-message-id');
    // No Message-ID header in the JSON body when messageId is absent.
    expect(body.headers?.['Message-ID']).toBeUndefined();
  });

  it('Message-ID, In-Reply-To, References coexist with Idempotency-Key when supplied', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeOkResponse('brevo-3'));

    await brevoAdapter.send(
      { env: { BREVO_API_KEY: 'test-key' } },
      {
        idempotencyKey: 'canonical-msg-id-with-headers',
        from: { address: 'sender@example.com' },
        to: [{ address: 'r@example.com' }],
        cc: [],
        bcc: [],
        subject: 'reply',
        html: '',
        text: '',
        messageId: '<m1@example.com>',
        inReplyTo: '<m0@example.com>',
        references: '<m0@example.com>',
        attachments: [],
      },
    );

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = parseBrevoSendBody(init);
    expect(body.headers?.['Idempotency-Key']).toBe('canonical-msg-id-with-headers');
    expect(body.headers?.['Message-ID']).toBe('<m1@example.com>');
    expect(body.headers?.['In-Reply-To']).toBe('<m0@example.com>');
    expect(body.headers?.['References']).toBe('<m0@example.com>');
  });

  it('cc recipients serialize into the payload when present', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(makeOkResponse('brevo-4'));

    await brevoAdapter.send(
      { env: { BREVO_API_KEY: 'test-key' } },
      {
        idempotencyKey: 'canonical-msg-id-cc',
        from: { address: 'sender@example.com' },
        to: [{ address: 'to@example.com' }],
        cc: [{ address: 'cc@example.com' }],
        bcc: [],
        subject: 's',
        html: '',
        text: '',
        references: '',
        attachments: [],
      },
    );

    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = parseBrevoSendBody(init);
    expect(body.to?.[0]?.email).toBe('to@example.com');
    expect(body.cc?.[0]?.email).toBe('cc@example.com');
    expect(body.headers?.['Idempotency-Key']).toBe('canonical-msg-id-cc');
  });
});
