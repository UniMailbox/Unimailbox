# G. Target Architecture

## G.1 System diagram

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
                                  (compose, send, deliver)
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

## G.2 Module structure

```
apps/
  worker/
    src/
      entrypoints/             # thin shells; no logic
        http.ts                # Hono app
        inbound-email.ts       # Email Routing handler
        queue.ts               # Outbound job consumer
        scheduled.ts           # Cron triggers
      http/
        router.ts              # route composition
        middleware/            # authn, authz, error, request-id
        errors.ts              # DomainError → HTTP
      modules/                 # one folder per bounded context
        identity/              # User, Session, Authentication
        onboarding/            # InstallationState, RegistrationKey
        tenancy/               # ManagedDomain, Mailbox, MailboxMember
        messages/              # Message, MailboxMessage, MessageUserState
        inbound-mail/          # parse, store, route
        outbound-mail/         # compose, enqueue, deliver
        provider-sync/         # back-import from providers
        attachments/           # upload, validate, serve
        signatures/            # per-domain signatures
        admin/                 # users, roles, audit, settings
        installation/          # setup wizard state machine
        maintenance/           # backfill jobs
      integrations/            # provider adapters live HERE, not in modules
        providers/
          provider-registry.ts
          brevo/
          resend/
          cf-sendmail/
        cloudflare/
          control-plane.ts
          oauth.ts
      platform/                # cross-cutting primitives
        config.ts              # runtime config schema
        database.ts            # D1 client + drizzle factory
        object-store.ts        # R2 + S3 facade
        cache.ts               # KV facade
        crypto.ts              # PBKDF2, AES-GCM, timing-safe eq
        logger.ts              # structured logger
        clock.ts               # injectable now()
        ids.ts                 # UUID v4 generator
        errors.ts              # DomainError base class
      app-context.ts           # composition root
    test/
  web/
    src/
      app/
      features/                # one folder per capability
        setup/
        auth/
        inbox/
        compose/
        mailboxes/
        admin/
      components/
        ui/                    # shadcn-style primitives
      infrastructure/
        api/                   # generated client + interceptor
        indexed-db/            # Dexie
        i18n/
      lib/                     # feature-agnostic helpers
    test/
packages/
  contracts/                   # shared types + zod schemas
    api/                       # request/response DTOs
    events/                    # cross-module events
    domain/                    # domain enums + value types
  email-core/                  # pure functions over RFC 5322
    parsing/
    composition/
    threading/
  config/                      # shared config types
  test-kit/                    # test fixtures + helpers
migrations/
  0001_initial.sql
  0001_initial.verify.sql
  0001_initial.md
  0002_*.sql
  ...
  meta/
scripts/
  scaffold.mjs                 # pnpm scaffold {init,doctor,db:migrate,...}
drizzle.config.ts
wrangler.jsonc
package.json
```

## G.3 Dependency rules

```
entrypoints ─▶ modules ─▶ domain
                          ▲
                          │
integrations ─────────────┘
       │
       └──▶ modules (read-only; modules never import integrations directly)
```

Rules:

1. **Modules never import Hono, Cloudflare request objects, or provider SDKs.**
2. **Integrations never import from `modules/*`.** They implement interfaces declared in `packages/contracts`.
3. **Domain never imports infrastructure.** Domain depends only on `platform/` and `packages/contracts/`.
4. **Route handlers validate input and call one use case.** They never call services directly.
5. **Use cases orchestrate.** They may call repositories, domain services, and integrations via interfaces.
6. **Only `index.ts` of a module is public.** Internal layout is private.
7. **Shared contracts are the only types crossing module boundaries.** No Drizzle row types leak across modules.

## G.4 Worker entrypoints

```typescript
// src/entrypoints/http.ts
import { Hono } from 'hono'
import { router } from '../http/router'

export const handleHttpRequest: ExportedHandlerFetchHandler<Env> = async (req, env, ctx) => {
  const app = new Hono()
  app.route('/', router(env, ctx))
  return app.fetch(req, env, ctx)
}

// src/entrypoints/inbound-email.ts
import { handleInbound } from '../modules/inbound-mail/entry'

export const handleInboundEmail: EmailExportedHandler<Env> = async (message, env, ctx) => {
  await handleInbound(message, env, ctx)
}

// src/entrypoints/queue.ts
import { processOutboundJob } from '../modules/outbound-mail/queue-consumer'

export const handleQueueBatch: QueueExportedHandler<Env> = async (batch, env, ctx) => {
  await Promise.all(batch.messages.map(m => processOutboundJob(m.body, env, ctx)))
}

// src/entrypoints/scheduled.ts
export const handleScheduledTask: ScheduledExportedHandler<Env> = async (c, env, ctx) => {
  switch (c.cron) {
    case '*/1 * * * *':  return recoverOutboundJobs(env, ctx)
    case '0 * * * *':    return cleanupUnusedUploads(env, ctx)
    case '0 0 * * *':    return dailyMaintenance(env, ctx)
  }
}
```

## G.5 Composition root

```typescript
// src/app-context.ts
export function buildAppContext(env: Env, ctx: ExecutionContext): AppContext {
  const db = drizzle(env.DB)
  const objectStore = new R2ObjectStore(env.ATTACHMENTS)
  const cache = new KVCache(env.KV)
  const clock = new SystemClock()
  const ids = new UuidV4Generator()
  const logger = new StructuredLogger(env)
  const providers = buildProviderRegistry()
  const credentials = new EncryptedCredentialStore(env, db, cache)

  return {
    db, objectStore, cache, clock, ids, logger, providers, credentials,
    users: new UserRepository(db),
    sessions: new SessionRepository(db, cache),
    mailboxes: new MailboxRepository(db),
    messages: new MessageRepository(db),
    mailboxMessages: new MailboxMessageRepository(db),
    messageUserState: new MessageUserStateRepository(db),
    attachments: new AttachmentRepository(db, objectStore),
    domains: new DomainRepository(db),
    signatures: new SignatureRepository(db),
    installation: new InstallationRepository(db, cache),
    keys: new RegistrationKeyRepository(db),
    roles: new RoleRepository(db),
    permissions: new PermissionRepository(db),
    audit: new AuditRepository(db),
    outboundJobs: new OutboundJobRepository(db),
    webhookDeliveries: new WebhookDeliveryRepository(db),
    providerMessageState: new ProviderMessageStateRepository(db),
    settings: new SystemSettingsRepository(db),
    maintenance: new MaintenanceRepository(db),
  }
}
```

## G.6 Use case pattern

```typescript
// modules/messages/application/send-message.ts
export class SendMessage {
  constructor(private readonly ctx: AppContext) {}

  async execute(
    principal: Principal,
    input: z.infer<typeof SendMessageSchema>,
    command: IdempotentCommand,
  ): Promise<{ messageId: MessageId; status: 'queued' | 'sent' }> {
    const replay = await this.ctx.messages.findIdempotentResult(
      principal.userId, 'message.send', command,
    )
    if (replay) return replay

    await assertPermission(this.ctx, principal, 'message.send')
    await this.ctx.mailboxes.assertCan(principal.userId, input.mailboxId, 'send')

    const mailbox = await this.ctx.mailboxes.requireActive(input.mailboxId)
    const domain = await this.ctx.domains.requireActive(mailbox.domainId)
    const recipients = normalizeRecipients(input.to, input.cc, input.bcc)
    const delivery = await this.ctx.mailboxes.partitionRecipients(recipients)

    const composed = composeMessage({
      mailbox, recipients, subject: input.subject,
      html: input.html, text: input.text,
      parentMessageId: input.parentMessageId,
      signature: await this.ctx.signatures.findEnabled(domain.id),
    })

    const messageId = this.ctx.ids.uuid()
    const jobId = delivery.external.length > 0 ? this.ctx.ids.uuid() : null

    await this.ctx.messages.createForDelivery({
      messageId, jobId, createdByUserId: principal.userId,
      mailbox, composed, attachments: input.attachmentIds,
      internalRecipients: delivery.internal,
      externalRecipients: delivery.external,
      idempotency: { actorUserId: principal.userId, operation: 'message.send', ...command },
    })

    if (jobId) {
      try { await this.ctx.outboundJobs.dispatch(jobId) }
      catch (e) {
        this.ctx.logger.warn('outbound.dispatch.deferred', { jobId, messageId, error: e })
      }
    }

    return { messageId, status: jobId ? 'queued' : 'sent' }
  }
}
```

## G.7 Provider registry

```typescript
// integrations/providers/provider-registry.ts
export class ProviderRegistry {
  constructor(private readonly providers: ReadonlyMap<ProviderKey, ProviderPlugin>) {}

  get(key: ProviderKey): ProviderPlugin {
    const plugin = this.providers.get(key)
    if (!plugin) throw new DomainError('PROVIDER_NOT_REGISTERED', `Provider ${key} is not registered`, 400)
    return plugin
  }

  outbound(key: ProviderKey): OutboundProviderAdapter {
    return this.get(key).outbound
  }
  webhook(key: ProviderKey): WebhookProviderAdapter | undefined {
    return this.get(key).webhook
  }
  sync(key: ProviderKey): SyncProviderAdapter | undefined {
    return this.get(key).sync
  }
}

// integrations/providers/brevo/index.ts
export function createBrevoPlugin(): ProviderPlugin {
  return {
    outbound: new BrevoOutboundAdapter(),
    webhook: new BrevoWebhookAdapter(),
    sync: new BrevoSyncAdapter(),
    connectionSchema: brevoConnectionSchema,
  }
}
```

## G.8 D1 transaction pattern

```typescript
async function createMessageGraph(db: D1Database, graph: NewMessageGraph): Promise<void> {
  const statements: D1PreparedStatement[] = [
    db.prepare(INSERT_MESSAGE).bind(...toMessageParams(graph.message)),
    ...graph.recipients.map(r => db.prepare(INSERT_RECIPIENT).bind(...toRecipientParams(r))),
    ...graph.mailboxMessages.map(m => db.prepare(INSERT_MAILBOX_MESSAGE).bind(...toMailboxMessageParams(m))),
    ...graph.attachments.map(a => db.prepare(INSERT_ATTACHMENT).bind(...toAttachmentParams(a))),
    ...(graph.outboundJob ? [db.prepare(INSERT_OUTBOUND_JOB).bind(graph.outboundJob.id, graph.outboundJob.messageId)] : []),
    ...(graph.idempotency ? [db.prepare(INSERT_IDEMPOTENCY_RECORD).bind(...toIdempotencyParams(graph.idempotency))] : []),
  ]
  await db.batch(statements)
}
```

## G.9 HTTP API

Base path: `/api/v1`.

### Authentication

| Method | Path | Purpose |
|---|---|---|
| POST | `/auth/register` | Register with optional invite key |
| POST | `/auth/login` | Create access + refresh tokens |
| POST | `/auth/refresh` | Rotate refresh token |
| POST | `/auth/logout` | Revoke current session |
| POST | `/auth/logout-all` | Revoke all sessions |
| POST | `/auth/password/reset` | Change password + revoke sessions |

### Mailboxes

| Method | Path | Required access |
|---|---|---|
| GET | `/mailboxes` | Authenticated |
| POST | `/mailboxes` | `mailbox.create` |
| GET | `/mailboxes/:id` | Mailbox read |
| PATCH | `/mailboxes/:id` | Mailbox rename (owner / admin) |
| DELETE | `/mailboxes/:id` | Mailbox owner |
| GET | `/mailboxes/:id/members` | Mailbox read |
| POST | `/mailboxes/:id/members` | Manage members |
| PATCH | `/mailboxes/:id/members/:userId` | Manage members |
| DELETE | `/mailboxes/:id/members/:userId` | Manage members or self |

### Messages

| Method | Path | Required access |
|---|---|---|
| GET | `/mailboxes/:id/messages` | Mailbox read |
| GET | `/messages/:id` | Read linked mailbox |
| POST | `/messages/send` | `message.send` + mailbox send |
| PATCH | `/messages/:id/read` | Read linked mailbox |
| PATCH | `/messages/:id/star` | Read linked mailbox |
| DELETE | `/messages/:id` | Delete linked mailbox message |

### Setup

| Method | Path | Purpose |
|---|---|---|
| GET | `/setup/status` | Next valid step |
| POST | `/setup/claim` | Exchange installation token |
| POST | `/setup/preflight` | Verify bindings + schema |
| POST | `/setup/administrator` | Create first admin |
| POST | `/setup/cloudflare/dashboard-link` | Allowlisted dashboard URL |
| POST | `/setup/cloudflare/verify` | Verify zone + Email Routing |
| POST | `/setup/domain` | Bind managed domain |
| POST | `/setup/inbound-smoke-test` | Run inbound test |
| POST | `/setup/brevo` | Encrypt + verify Brevo key |
| POST | `/setup/outbound-smoke-test` | Run outbound test |
| POST | `/setup/complete` | Lock setup |

### Provider webhooks

```
POST /api/v1/webhooks/:providerKey/:connectionId
```

The opaque `connectionId` selects the encrypted verification secret. Provider-specific `verifyWebhook` runs **before** JSON parse.

## G.10 Frontend architecture

The rebuild has **exactly one web client**: `apps/web/`. It is the in-progress `mail-react/` package, renamed and integrated into the monorepo. The legacy `mail-vue/` directory is **deleted** in Phase 0; there is no Vue build artifact, no Element Plus, no TinyMCE, no Pinia. There is no parallel client.

```
apps/web/src/
  app/
    App.tsx                     # Router + providers
  features/
    setup/
      pages/SetupPage.tsx
      api.ts
      hooks.ts
    auth/
      pages/LoginPage.tsx
      api.ts
    inbox/
      pages/InboxPage.tsx
      api.ts
      components/InboxList.tsx
      components/InboxItem.tsx
    compose/
      pages/ComposePage.tsx     # write drawer
      api.ts
    mailboxes/
      pages/MyMailboxesPage.tsx
      api.ts
    admin/
      pages/UsersPage.tsx
      pages/RolesPage.tsx
      pages/SettingsPage.tsx
      pages/WebhookEventsPage.tsx
      api.ts
  components/
    ui/                         # shadcn primitives
  infrastructure/
    api/
      http.ts                   # axios + interceptors
      generated/                # generated from contracts
    indexed-db/
      db.ts                     # Dexie
    i18n/
      en.ts
      zh.ts
  lib/
    auth.ts                     # token storage, refresh loop
    errors.ts
```

### State model

| Concern | Tool |
|---|---|
| Server data | **TanStack Query** (`@tanstack/react-query`) — caching, invalidation, retries |
| Mutations | TanStack Query `useMutation` + `Idempotency-Key` header |
| UI state | **Zustand** for transient state (open drawer, selected mailbox) |
| Form state | React Hook Form + Zod |
| Local drafts | **Dexie** (IndexedDB) |
| Rich text | **Tiptap** (real instance, not `execCommand`) |

### Server-state discipline

- TanStack Query owns server data; components consume via hooks.
- Zustand stores are **not** used as event buses. Cross-list sync uses query invalidation (`queryClient.invalidateQueries(['inbox'])`), not ad-hoc event ids.
- Local IndexedDB is the **only** crash-recovery layer for drafts; server drafts (Phase 3) are authoritative.

### Migration of the existing `mail-react/` package

The in-progress `mail-react/` package becomes `apps/web/`:

1. Move source files into `apps/web/src/`.
2. Replace the Element Plus-style admin pages with shadcn/ui (already done in `mail-react/`).
3. Replace `tiptap-editor/index.tsx` (which is `document.execCommand` despite the name) with a real Tiptap instance.
4. Replace Zustand store-as-event-bus hacks (`useEmailStore.deleteIds`, `cancelStarEmailId`, `addStarEmailId`) with TanStack Query invalidation.
5. Add `webhook-event` view (currently missing in `mail-react/`).
6. Delete `mail-vue/` directory.
7. Update `wrangler.toml [assets] directory` to `apps/web/dist`.
8. Remove all `mail-vue`-named docs, scripts, CI references.

## G.11 Persistence model (D1)

See `E-proposed-domain-model.md` for full schemas. Summary:

```text
identity      → users, sessions, idempotency_records
onboarding    → installation_state, registration_keys
tenancy       → managed_domains, signatures, mailboxes, mailbox_members
messages      → messages, message_recipients, mailbox_messages, message_user_state,
                message_attachments, attachment_uploads, drafts
outbound      → outbound_jobs, provider_connections, encrypted_credentials,
                webhook_deliveries, provider_message_state, webhook_events
admin         → roles, permissions, role_permissions, user_roles,
                system_settings, audit_events, maintenance_jobs
```

Drizzle owns typed schema; SQL migrations are the deployable artifacts.

## G.12 Cross-cutting concerns

### Authorization

Two layers:

1. Global permission (`RolePermission`) on routes via `requirePermission(permKey)` middleware.
2. Mailbox authorization in use cases via `mailboxes.assertCan(actor, mailboxId, op)`.

### Logging

Single JSON line per event. Required fields: `event`, `requestId`, `actorUserId?`, `durationMs`. Sensitive data is forbidden: passwords, refresh tokens, message bodies, attachment bytes, decrypted secrets.

### Errors

```typescript
class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}
```

HTTP mapping:

| DomainError status | HTTP status |
|---|---|
| 400 (validation) | 400 |
| 401 (authn) | 401 |
| 403 (authz) | 403 |
| 404 (not found) | 404 |
| 409 (state conflict, idempotency reused) | 409 |
| 413 (size limit) | 413 |
| 429 (rate limit) | 429 |
| 502 (provider failed) | 502 |
| 503 (lock contention) | 503 |

### Configuration

```typescript
const RuntimeConfigSchema = z.object({
  INSTALLATION_TOKEN: z.string().min(32),
  AUTH_SIGNING_KEY: z.string().min(32),
  CREDENTIAL_ENCRYPTION_KEY: z.string().min(32),
})

export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>
```

Secrets are read once at boot and cached. They are never logged.

### Idempotency

Every mutating endpoint accepts `Idempotency-Key` header. The handler:

1. Computes `requestHash = sha256(canonical JSON of request body)`.
2. Inserts a row into `idempotency_records` with `(actorUserId, operation, idempotencyKey, requestHash, responseStatus, responseJson)` in the same D1 batch as the business write.
3. On replay: returns the stored response.
4. On conflict (same key, different hash): returns `409 IDEMPOTENCY_KEY_REUSED`.

## G.13 Deployment model

```text
github.com/<owner>/cloud-mail
  → "Deploy to Cloudflare" button
  → Cloudflare provisions D1, R2, KV, Queue, Secrets Store bindings
  → Workers Builds runs migrations + deploys Worker
  → Worker first request redirects to /setup
```

CI:

1. Frozen dep install
2. Lint + typecheck
3. Unit tests + Worker tests
4. Migration verification (fresh D1 + previous-fixture upgrade)
5. Production build + Wrangler dry run
6. Preview deployment + smoke tests (when credentials available)

CD:

1. Preview branch → upload preview Worker version
2. Main branch → capture D1 Time Travel bookmark → run migrations → upload Worker version → smoke tests → promote

## G.14 What this architecture is **not**

- **Not** a microservices decomposition. One Worker, multiple entrypoints.
- **Not** an event-driven system. No Kafka, no NATS, no general event bus. State transitions are explicit.
- **Not** a CQRS system. We use cases, not separate read/write models. The same D1 schema serves both.
- **Not** a hexagonal architecture with infinite ports. We have **two** ports: `ProviderPlugin` and `EncryptedCredentialStore`. Everything else is straight calls.
- **Not** a domain-driven-design monolith with 40 bounded contexts. We have **seven** bounded contexts. If we ever need more, we will be too big for one Worker and the conversation changes.
