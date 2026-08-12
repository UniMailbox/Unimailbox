# ADR-002 — Provider Registry Pattern

## Status

Accepted.

## Context

The legacy `email-service.send` function calls three providers inline:

```js
if (provider === 'cf') { ... }
else if (provider === 'resend') { ... }
else if (provider === 'brevo') { ... }
```

Adding a fourth provider requires editing the orchestrator. Provider SDK types and error shapes leak into the application layer.

## Decision

We adopt a **Provider Plugin Registry** pattern. Each provider implements `ProviderPlugin` (outbound + optional webhook + optional sync + connection schema). Use cases call `provider.outbound.send(payload)` — never the SDK directly.

```typescript
interface OutboundProviderAdapter {
  readonly key: ProviderKey
  validateConnection(ctx: ProviderRuntimeContext): Promise<void>
  send(ctx: ProviderRuntimeContext, msg: SendProviderMessage): Promise<ProviderSendResult>
}

class ProviderRegistry {
  get(key: ProviderKey): ProviderPlugin
  outbound(key: ProviderKey): OutboundProviderAdapter
}
```

## Consequences

### Positive

- Adding a provider requires only: new file in `integrations/providers/{key}/`, registry entry, schema.
- Application code never branches on `providerKey`.
- Provider-specific error classification lives in the adapter.
- Provider contract tests prevent regressions.

### Negative

- Indirection: developers must learn the registry pattern.
- Adapter interface must be designed carefully (not too narrow, not too wide).

### Mitigations

- The interface is documented in `packages/contracts/`.
- Each adapter has contract tests that exercise every method.

## Alternatives considered

- **Strategy pattern with `if/else`**: rejected. Same problem as legacy.
- **Plugin system with dynamic loading**: rejected. Cloudflare Workers cannot dynamically load modules.
- **One Worker per provider**: rejected. Adds deployment complexity without benefit.