# Integration Boundaries

## Provider plugin interface

```typescript
// packages/contracts/src/provider-plugin.ts

export interface ProviderPlugin {
  outbound: OutboundProviderAdapter
  webhook?: WebhookProviderAdapter
  sync?: SyncProviderAdapter
  connectionSchema: z.ZodType<unknown>
}

export interface OutboundProviderAdapter {
  readonly key: ProviderKey
  validateConnection(ctx: ProviderRuntimeContext): Promise<void>
  send(
    ctx: ProviderRuntimeContext,
    msg: SendProviderMessage,
  ): Promise<ProviderSendResult>
}

export interface WebhookProviderAdapter {
  readonly key: ProviderKey
  verifyWebhook(
    req: ProviderWebhookRequest,
    ctx: ProviderRuntimeContext,
  ): Promise<ProviderEvent>
}

export interface SyncProviderAdapter {
  readonly key: ProviderKey
  getMessage(
    ctx: ProviderRuntimeContext,
    providerMessageId: string,
  ): Promise<ProviderMessageDetail>
  listMessages(
    ctx: ProviderRuntimeContext,
    cursor?: string,
  ): Promise<ProviderMessagePage>
}

export type ProviderKey = string & { readonly __brand: 'ProviderKey' }
```

## Provider registry

```typescript
// apps/worker/src/integrations/providers/provider-registry.ts

export class ProviderRegistry {
  constructor(
    private readonly providers: ReadonlyMap<ProviderKey, ProviderPlugin>,
  ) {}

  get(key: ProviderKey): ProviderPlugin {
    const plugin = this.providers.get(key)
    if (!plugin) {
      throw new DomainError(
        'PROVIDER_NOT_REGISTERED',
        `Provider ${key} is not registered`,
        400,
      )
    }
    return plugin
  }

  outbound(key: ProviderKey): OutboundProviderAdapter {
    return this.get(key).outbound
  }
}
```

Composition root:

```typescript
export function buildProviderRegistry(): ProviderRegistry {
  return new ProviderRegistry(new Map([
    [parseProviderKey('brevo'), createBrevoPlugin()],
  ]))
}
```

## Provider-neutral DTO

The `SendProviderMessage` is provider-neutral:

```typescript
export interface SendProviderMessage {
  idempotencyKey: string
  from: MailAddress
  to: MailAddress[]
  bcc: MailAddress[]
  cc: MailAddress[]
  subject: string
  html: string
  text: string
  messageId?: string
  inReplyTo?: string
  references?: string
  attachments: ProviderAttachment[]
}

export interface ProviderAttachment {
  filename: string | null
  contentType: string
  disposition: 'attachment' | 'inline'
  contentId?: string
  content: ArrayBuffer
}

export interface ProviderSendResult {
  providerMessageId: string
  acceptedAt: string
}

export interface ProviderEvent {
  providerKey: ProviderKey
  connectionId: string
  eventKey: string
  providerMessageId: string
  status: MessageStatus
  occurredAt: Date
  recipient?: string
  error?: SafeProviderError
}
```

## Adapters own SDK details

Each adapter lives in `integrations/providers/{key}/`:

```text
integrations/providers/brevo/
├── index.ts              # exports createBrevoPlugin()
├── outbound-adapter.ts
├── webhook-adapter.ts
├── sync-adapter.ts
├── email-content.ts      # Brevo-specific payload shaping
└── error-mapping.ts      # classify Brevo errors
```

The adapter:

1. Imports the provider SDK (e.g., `@getbrevo/brevo`).
2. Translates `SendProviderMessage` → provider-specific payload.
3. Calls the provider API.
4. Translates the response → `ProviderSendResult` or `SafeProviderError`.

Use cases never see the provider SDK.

## Webhook verification

Each webhook adapter's `verifyWebhook` runs **before** JSON parse:

```typescript
// integrations/providers/brevo/webhook-adapter.ts
export const brevoWebhookAdapter: WebhookProviderAdapter = {
  key: BREVO_PROVIDER_KEY,
  async verifyWebhook(req, ctx) {
    // 1. Read raw body
    const raw = await req.text()

    // 2. Verify signature using connection secret (constant-time)
    const headerSig = req.headers.get('x-brevo-signature') ?? ''
    const expected = await hmacSha256(ctx.secrets.webhookSecret, raw)
    if (!timingSafeEqual(headerSig, expected)) {
      throw new DomainError('WEBHOOK_SIGNATURE_INVALID', '...', 401)
    }

    // 3. Parse JSON
    const payload = JSON.parse(raw)

    // 4. Map to ProviderEvent
    return mapBrevoEvent(payload)
  },
}
```

## Failure classification

Each adapter classifies its own errors:

```typescript
export function classifyBrevoError(e: unknown): SafeProviderError {
  if (e instanceof BrevoResponseError) {
    if (e.status === 401 || e.status === 403) {
      return { code: 'PROVIDER_AUTH', retryable: false, message: 'auth failed' }
    }
    if (e.status === 429) {
      return { code: 'PROVIDER_RATE_LIMIT', retryable: true, message: 'rate limit' }
    }
    if (e.status >= 500) {
      return { code: 'PROVIDER_UNAVAILABLE', retryable: true, message: '...' }
    }
    return { code: 'PROVIDER_INVALID_PAYLOAD', retryable: false, message: e.message }
  }
  return { code: 'PROVIDER_UNKNOWN', retryable: true, message: String(e) }
}
```

The use case never sees provider-specific exception types.

## Adding a new provider

1. Create `integration/providers/{key}/` folder.
2. Implement `OutboundProviderAdapter` (and optionally webhook, sync).
4. Define `connectionSchema` (zod) for the connection form.
5. Map provider events to `MessageStatus`.
6. Register in `buildProviderRegistry()`.
7. Add contract tests.

No business code changes.