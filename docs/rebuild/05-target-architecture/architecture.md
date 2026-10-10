# Target Architecture (Reference)

> Original target-design detail. Current module ownership and transport contracts
> are in [module boundaries](module-boundaries.md) and [API conventions](api-design.md).
> Concrete tables/bindings come from the source and numbered migrations; future
> provider examples and class sketches below are not claims of shipped behavior.


See `../G-target-architecture.md` for the full architecture. This document is a quick-reference diagram + module map.

## Architecture diagram

```text
                        ┌─────────────────────────────┐
                        │       Browser (React)       │
                        │  /setup  /inbox  /admin/... │
                        └──────────┬──────────────────┘
                                   │ HTTPS
                                   ▼
                        ┌─────────────────────────────┐
                        │   Cloudflare Worker entry   │
                        │   Hono + TanStack-Query-ish │
                        │   shaped client contracts   │
                        └──────────┬──────────────────┘
                                   │
        ┌──────────────┬───────────┼───────────┬──────────────┐
        │              │           │           │              │
        ▼              ▼           ▼           ▼              ▼
   HTTP routes    Email route   Cron route  Queue route   Assets
        │              │           │           │
        │              │           │           │
        ▼              ▼           ▼           ▼
   ┌─────────────────────────────────────────────────────┐
   │   Application Layer (use cases, command/query bus)  │
   └──────────────────────────┬──────────────────────────┘
                              │
        ┌─────────┬────────────┼────────────┬─────────┐
        │         │            │            │         │
        ▼         ▼            ▼            ▼         ▼
   identity    tenancy     messages     inbound   outbound
                              │
                              ▼
   ┌──────────────────────────────────────────────────┐
   │   Domain Layer (entities, value objects, FSMs)  │
   └──────────────────────────┬───────────────────────┘
                              │
        ┌─────────┬────────────┼────────────┬─────────┐
        │         │            │            │         │
        ▼         ▼            ▼            ▼         ▼
   Drizzle    Drizzle    Drizzle    Provider   Secrets
   (Users)    (Mailbox)  (Messages) (Brevo,    (AES-GCM,
                                     Resend,    Secrets
                                     CF)        Store)
                              │
                              ▼
   ┌──────────────────────────────────────────────────┐
   │   Infrastructure: D1, R2, KV, Queue, AI, Email   │
   └──────────────────────────────────────────────────┘
```

## Module map

```
apps/worker/src/
  entrypoints/
    http.ts                # Hono app
    inbound-email.ts       # Email Routing handler
    queue.ts               # Outbound job consumer
    scheduled.ts           # Cron triggers
  http/
    router.ts              # route composition
    middleware/            # authn, authz, error, request-id
    errors.ts              # DomainError → HTTP
  modules/
    identity/
    onboarding/
    tenancy/
    messages/
    inbound-mail/
    outbound-mail/
    provider-sync/
    attachments/
    signatures/
    admin/
    installation/
    maintenance/
  integrations/
    providers/
      provider-registry.ts
      brevo/
      resend/
      cf-sendmail/
    cloudflare/
      control-plane.ts
      oauth.ts
  platform/
    config.ts
    database.ts
    object-store.ts
    cache.ts
    crypto.ts
    logger.ts
    clock.ts
    ids.ts
    errors.ts
  app-context.ts           # composition root
apps/web/src/
  app/                     # router + providers
  features/                # one folder per capability
    setup/
    auth/
    inbox/
    compose/
    mailboxes/
    admin/
  components/ui/           # shadcn primitives
  infrastructure/
    api/
    indexed-db/
    i18n/
  lib/                     # feature-agnostic helpers
packages/
  contracts/               # shared types + zod schemas
  email-core/              # pure RFC 5322 functions
  config/                  # shared config types
  test-kit/                # test fixtures
```

## Dependency rules

```
entrypoints ─▶ modules ─▶ domain
                          ▲
                          │
integrations ─────────────┘
       │
       └──▶ modules (read-only)
```

Rules:

1. Modules never import Hono, Cloudflare request objects, or provider SDKs.
2. Integrations never import from modules.
3. Domain never imports infrastructure.
4. Route handlers validate input and call one use case.
5. Use cases orchestrate; they may call repositories, domain services, integrations via interfaces.
6. Only `index.ts` of a module is public.
7. Shared contracts are the only types crossing module boundaries.