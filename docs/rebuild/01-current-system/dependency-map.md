# 03 — Dependency Map

This is a coarse dependency graph of the legacy system. Read alongside `D-major-architectural-problems.md` to see which dependencies are wrong.

## 1. Worker internal dependency graph

```text
index.js
   ├── hono/webs.js
   │      └── security/security.js
   │             ├── service/perm-service.js
   │             ├── service/setting-service.js
   │             ├── service/user-service.js
   │             ├── utils/jwt-utils.js
   │             └── const/kv-const.js
   ├── email/email.js
   │      ├── service/email-service.js  (receive)
   │      ├── service/account-service.js
   │      ├── service/setting-service.js
   │      ├── service/att-service.js
   │      ├── service/role-service.js
   │      ├── service/user-service.js
   │      ├── service/telegram-service.js
   │      ├── service/ai-service.js
   │      ├── utils/email-utils.js
   │      ├── utils/file-utils.js
   │      ├── const/constant.js
   │      └── const/entity-const.js
   └── scheduled()
          ├── service/analysis-service.js
          ├── service/verify-record-service.js
          ├── service/user-service.js
          ├── service/email-service.js (completeReceiveAll)
          ├── service/oauth-service.js
          └── (cron dispatch)

api/* (21 files, each imports 1–8 services)

service/email-service.js
   ├── Resend SDK (resend)
   ├── BrevoClient SDK (@getbrevo/brevo)
   ├── PostalMime (postal-mime)
   ├── linkedom (parseHTML)
   ├── dayjs
   ├── service/att-service.js
   ├── service/attachment-upload-service.js
   ├── service/setting-service.js
   ├── service/account-service.js
   ├── service/account-member-service.js
   ├── service/user-service.js
   ├── service/role-service.js
   ├── service/signature-service.js
   ├── service/star-service.js
   ├── service/telegram-service.js
   ├── service/r2-service.js
   ├── service/provider-webhook-state-service.js
   ├── utils/email-utils.js
   ├── utils/file-utils.js
   ├── utils/brevo-email-utils.js
   ├── utils/email-id-utils.js
   ├── utils/provider-webhook-utils.js
   ├── utils/attachment-email-utils.js
   ├── utils/domain-uitls.js
   ├── const/entity-const.js
   ├── const/kv-const.js
   └── entity/* (Drizzle)

service/setting-service.js
   ├── service/user-service.js (admin check)
   ├── service/role-service.js
   ├── service/r2-service.js (background image)
   └── (writes to D1 setting table + KV)

service/brevo-service.js
   ├── BrevoClient SDK
   ├── service/email-service.js (CRUD)
   ├── service/provider-webhook-state-service.js
   └── entity/* (Drizzle)

service/resend-service.js
   ├── Resend SDK
   ├── service/email-service.js
   └── entity/*

service/provider-webhook-state-service.js
   ├── utils/d1-schema-utils.js  (hand-rolled DDL)
   └── entity/*

service/ai-service.js
   ├── Workers AI binding (c.env.ai.run)
   └── utils/email-utils.js

service/telegram-service.js
   ├── fetch (api.telegram.org)
   └── utils/jwt-utils.js (token sign/verify)

service/turnstile-service.js
   └── fetch (challenges.cloudflare.com)

service/oauth-service.js
   └── fetch (connect.linux.do)
```

## 2. Circular dependencies observed

| Cycle | Severity |
|---|---|
| `email-service` ↔ `brevo-service` ↔ `provider-webhook-state-service` | medium — these three call each other freely |
| `email-service` ↔ `att-service` | low — one-way pull of helpers |
| `email-service` ↔ `setting-service` ↔ `user-service` | medium |
| `security.js` ↔ `setting-service.js` (admin check) | medium |

Cycles are not visible from imports alone (they happen at function call time), but they make refactoring risky.

## 3. External dependencies (worker)

| Package | Used by | Purpose |
|---|---|---|
| `hono` | routing | HTTP framework |
| `drizzle-orm` | entity/* | Type-safe SQL builder |
| `@getbrevo/brevo` | email-service, brevo-service | Brevo SDK |
| `resend` | email-service, resend-service | Resend SDK |
| `postal-mime` | email.js | MIME parser |
| `linkedom` | email-service, att-service | DOM parser (for HTML rewriting) |
| `dayjs` | multiple | Date manipulation |
| `uuid` | inline | (rarely used) |
| `@aws-sdk/client-s3` | s3-service | S3 client |
| `i18next` | inline | (rarely used in worker) |
| `ua-parser-js` | inline | User-agent parsing |
| `@cloudflare/vite-plugin` | build | Worker bundling |

## 4. Frontend dependencies (mail-vue)

```
Vue 3.5, Vue Router 4.5
Pinia 3 + pinia-plugin-persistedstate 4
Vite 7.1.5
Element Plus 2.13
@iconify/vue, VueUse 12/14
axios 1.15.2
dexie 4
echarts 5.6
vue-i18n 11
dayjs
lodash-es
nprogress
compressorjs
date-time-format-timezone

Dev:
@vitejs/plugin-vue
unplugin-auto-import
unplugin-vue-components
sass + less
terser
vite-plugin-pwa
```

**Smells:** `path@0.12.7` polyfill is unused; `sass` AND `less` are both configured; TinyMCE is loaded from CDN outside npm.

## 5. Frontend dependencies (mail-react)

```
React 19, React DOM 19
React Router 7
@tanstack/react-query (installed, not used)
zustand
@hookform/resolvers, react-hook-form
@radix-ui/* (25 primitives)
@tiptap/* (installed, not instantiated)
@iconify/react
echarts, echarts-for-react
react-i18next, i18next
dexie, dexie-react-hooks
axios
sonner
dayjs
clsx, class-variance-authority, tailwind-merge

Build:
vite
@vitejs/plugin-react
@cloudflare/vite-plugin
tailwindcss
postcss
@tailwindcss/typography
@tailwindcss/container-queries
tailwindcss-animate
```

**Smells:** TanStack Query is in deps but not used. Tiptap is in deps but `tiptap-editor` is `execCommand`.

## 6. Cross-cutting observations

- The Worker has **no** shared dependency-injection container. Services are imported as ES modules at the top of each file. Testability is poor.
- The frontend stores import each other for cross-component events (event-bus hack). Removing one store breaks N views.
- The build pipeline assumes Vue is the canonical client; switching to React requires `wrangler.toml [assets] directory` to point at `../mail-react/dist` and the React build output must be a Worker-Assets-compatible SPA.
