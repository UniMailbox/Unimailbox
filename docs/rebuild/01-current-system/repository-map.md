# 01 — Current System Map

## 1. Repository layout

```
cloud-mail/
├── mail-worker/          # Cloudflare Worker backend (JS, Hono, D1, R2, KV)
├── mail-vue/             # Vue 3 + Element Plus legacy web client
├── mail-react/           # React 19 + shadcn/ui in-progress replacement
├── doc/                  # Architecture and feature planning docs
│   ├── rebuild-blueprint.md      # Greenfield TS rebuild specification
│   └── pop3-implementation-plan.md
├── DESIGN.md             # Visual design tokens
├── PRODUCT.md            # Product overview
├── README.md / README-en.md
└── LICENSE
```

## 2. Worker runtime (mail-worker)

**Entry point:** `src/index.js` exposes one Worker with three behaviors:

- `fetch(req, env, ctx)` — HTTP. Delegates to Hono router for `/api/*`, otherwise static assets.
- `email(message, env, ctx)` — Cloudflare Email Routing inbound handler.
- `scheduled(c, env, ctx)` — Cron. Half-hourly for analysis cache; daily for cleanup.

**Hono router:** `src/hono/hono.js` registers global error handler. `src/hono/webs.js` (the actual `app`) wires up all `api-*.js` files via `app.route(...)`. Each api file is its own `Hono()` instance.

**Authorization:** `src/security/security.js` registers one global middleware that:

1. Checks `exclude[]` for public paths.
2. Verifies JWT + KV session.
3. Matches `requirePerms[]` against path prefix.
4. Looks up permission keys; admin email-list bypasses.
5. Caches `user` on context.

## 3. Database schema

Schema is bootstrapped via `src/init/init.js` (`/api/init/:secret`), which runs a sequence of `intDB → v1_1DB → v1_2DB → ... → v3_8DB` migration steps. Each step adds columns, indexes, or seed data.

Tables (current state):

```
users              → identity
account            → mailbox metadata (legacy term: "account")
account_member     → shared mailbox membership
role, perm, role_perm → RBAC
email              → canonical message (inbound + outbound + drafts)
attachments        → attachment metadata + R2 key
star               → per-user star (legacy single-user model)
signature          → per-domain signature
oauth              → LinuxDo OAuth binding
reg_key            → invite codes
setting            → 57-column god-object
verify_record      → Turnstile / IP attempt counter
webhook_event      → webhook audit log
provider_email_state → provider message linkage
webhook_delivery   → webhook idempotency
```

## 4. Service layer

28 service files under `src/service/` mirror the API layer but own business logic. Notable:

- `email-service.js` — 1400+ lines. Orchestrates send/receive/provider/on-site-delivery.
- `account-service.js` — mailbox CRUD + cascade.
- `user-service.js` — user CRUD + auth.
- `login-service.js` — register, login, refresh, logout.
- `provider-webhook-state-service.js` — webhook dedup + status application.
- `brevo-service.js` — Brevo inbound + back-sync.
- `resend-service.js` — Resend inbound + back-sync.
- `provider-sync-service.js` — fan-out sync.
- `ai-service.js` — Workers AI code extraction.
- `telegram-service.js` — Telegram bot forward.
- `turnstile-service.js` — Cloudflare Turnstile verification.

## 5. API layer

21 files under `src/api/`. Each is a Hono router that validates input via zod-light hand-rolled checks, calls one or more services, and returns `{ code, data, message }`.

## 6. Frontend — Vue (mail-vue)

- Vue 3.5 + Vite + Pinia + Element Plus + TinyMCE (loaded outside npm) + Dexie.
- Routes in `src/router/`; perm-key gate via `v-perm` directive.
- 17 views: inbox, content, send, draft, star, setting, my-mailbox, login, all-email, analysis, user, role, reg-key, signature, sys-setting, webhook-event, 404.
- Stores act as event buses across list components (legacy workaround for missing query cache).
- IndexedDB schema: drafts + attachments, scoped per logged-in email.

## 7. Frontend — React (mail-react)

- React 19 + Vite + Zustand + axios + shadcn/ui (Radix) + Tailwind + Dexie.
- Most views ported (16/17) but `webhook-event` view missing; `tiptap-editor` is actually `execCommand` stub; no TanStack Query.
- Design tokens align with `DESIGN.md` (OKLCH palette, Geist font, mono numerics).
- Stores include the same event-bus hack (`useEmailStore.deleteIds`, `cancelStarEmailId`).

## 8. Bindings

| Binding | Source | Notes |
|---|---|---|
| `db` | D1 | Required |
| `r2` | R2 | Required |
| `kv` | KV | Required (sessions) |
| `assets` | Assets | Vue build output |
| `ai` | Workers AI | llama-3.1-8b-instruct |
| `email` | Email binding (CF) | Optional |

## 9. Wrangler / build

- `wrangler.toml` — production
- `wrangler-dev.toml` — local dev
- `wrangler-test.toml` — `pnpm test` (mislabeled; actually deploys)
- `wrangler-action.toml` — GitHub Actions
- `wrangler-vitest.toml` — Vitest pool
- Build: `pnpm --prefix ../mail-vue install && pnpm --prefix ../mail-vue run build` → `dist/`.

## 10. Tests

- `test/` directory has 21 sub-dirs, but `pnpm test` runs `wrangler deploy --config wrangler-test.toml`.
- Vitest is a devDep but never wired into `package.json`'s scripts.

## 11. Configuration

- `wrangler.toml` `vars` block (commented): `ai_model`, `analysis_cache`, `orm_log`, `domain`, `admin`, `jwt_secret`, `resend_webhook_secret`, `brevo_api_key`, `brevo_webhook_secret`.
- `setting` table is the runtime configuration store.
- Per-deployment secrets + per-deployment vars. No `.env` is shipped.

## 12. Cron

```
0 16 * * *       daily (China time midnight)
*/30 * * * *     half-hourly (analysis cache refresh)
```

## 13. External integrations

| Integration | Where | Purpose |
|---|---|---|
| Cloudflare Email Routing | `email/email.js` (inbound) | Receive |
| Cloudflare Email binding | `email-service.sendByCloudflareEmail` (outbound) | Send |
| Resend | `resend-service.js`, `email-service.sendByResend` | Send |
| Brevo | `brevo-service.js`, `email-service.sendByBrevo` | Send |
| Workers AI | `ai-service.js` | Code extraction |
| Cloudflare Turnstile | `turnstile-service.js` | CAPTCHA |
| Telegram | `telegram-service.js` | Notification |
| linux.do OAuth | `oauth-service.js` | User auth |
| AWS S3 | `s3-service.js` | Optional storage backend |
