# 第一方 MCP 服务实施详细规划

> 配套 `email-mcp-implementation-plan.md`（高层做什么 / 为什么）。本文回答**具体怎么做**：每个文件写什么、关键代码骨架、测试名、灰度闸门、回滚命令。
>
> worktree：`feat/email-mcp-server`，分支基于 `main@1de76a6`。
>
> 命名约定：所有 Mtime / hash 用 `apps/web/src/lib/id.ts::ulid()`；PBKDF2 用 `apps/worker/src/modules/identity/index.ts::PasswordService` 同一份实现。

---

## 0. 全局坐标

```
apps/worker/src/entrypoints/mcp.ts          ← 新增：Streamable HTTP 入口
apps/worker/src/modules/mcp/                ← 新增：MCP 服务领域逻辑
  ├─ auth.ts                                ← token 校验、scope 派生
  ├─ audit.ts                               ← 审计事件写入
  ├─ pii.ts                                 ← HTML 清理 / 截断 / regex 脱敏
  ├─ rate-limit.ts                          ← KV 限流计数器
  ├─ confirmation.ts                        ← 两阶段 send 的 token store
  ├─ idempotency.ts                         ← 复用 + 适配 admin-idempotency
  ├─ context.ts                             ← 把 requireAuth 适配到 MCP 请求
  ├─ resources.ts                           ← 5 个 Resources
  ├─ tools/                                 ← 每个 tool 一个文件
  │   ├─ list-messages.ts
  │   ├─ search-messages.ts
  │   ├─ get-message.ts
  │   ├─ list-threads.ts
  │   ├─ send-message.ts
  │   ├─ draft-message.ts
  │   ├─ reply-message.ts
  │   ├─ forward-message.ts
  │   ├─ mark-read.ts
  │   ├─ move-message.ts
  │   ├─ trash-message.ts
  │   ├─ schedule-message.ts
  │   ├─ cancel-scheduled.ts
  │   ├─ list-attachments.ts
  │   └─ download-attachment.ts
  ├─ errors.ts                              ← MCP 标准错误码映射
  └─ schema.ts                              ← Zod schema 集中导出（被 tools 复用）
apps/worker/src/modules/agent/              ← 阶段 2-3 新增
  ├─ gateway.ts                             ← AI Gateway wrapper
  ├─ embed.ts
  ├─ summarize.ts
  ├─ classify.ts
  ├─ extract-actions.ts
  ├─ indexer.ts                             ← 消费 INBOX_INDEX_QUEUE
  └─ mailbox-agent-do.ts                    ← 阶段 3
apps/worker/test/mcp/                       ← 新增：MCP 测试
  ├─ auth.test.ts
  ├─ pii.test.ts
  ├─ confirmation.test.ts
  ├─ idempotency.test.ts
  ├─ resources.test.ts
  ├─ tools/…
  └─ integration/http.test.ts
migrations/0010_agent_tokens.sql            ← 新增
migrations/0011_message_embeddings.sql      ← 新增
scripts/dev/vectorize-bootstrap.mjs         ← 新增
apps/worker/src/index.ts                    ← 修改：注册 mcp entrypoint
apps/worker/src/platform/config.ts          ← 修改：扩展 Env
apps/worker/src/app-context.ts              ← 修改：注入 mcp 模块
packages/contracts/src/domain/index.ts      ← 修改：新增 3 个 permission key
packages/contracts/src/api/mcp.ts           ← 新增：tools / resources 类型定义
wrangler.jsonc + wrangler.r2.jsonc          ← 修改：bindings + queues
docs/runbooks/mcp-server.md                 ← 新增
apps/web/src/routes/settings/integrations/mcp.tsx  ← 阶段 4 UI
```

---

## 1. 阶段 0：基础设施（2-3 天）

### 1.1 wrangler bindings

`wrangler.jsonc` 与 `wrangler.r2.jsonc` 两份配置同步加：

```jsonc
"ai": { "binding": "AI" },
"vectorize": { "binding": "VECTORIZE", "index_name": "unimailbox-messages" },
"ai_gateway": { "binding": "AI_GATEWAY", "gateway_id": "unimailbox-mcp" },
"queues": {
  "producers": [
    { "binding": "OUTBOUND_QUEUE", "queue": "unimailbox-outbound" },
    { "binding": "INBOX_INDEX_QUEUE", "queue": "unimailbox-inbox-index" }
  ],
  "consumers": [
    { "queue": "unimailbox-outbound", "max_batch_size": 10, "max_retries": 5 },
    { "queue": "unimailbox-inbox-index", "max_batch_size": 25, "max_retries": 5 }
  ]
},
"durable_objects": {
  "bindings": [
    { "name": "MAILBOX_AGENT", "class_name": "MailboxAgent" }
  ]
},
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["MailboxAgent"] }
]
```

Preview 命名规则：`unimailbox-preview-*`。`scripts/dev/vectorize-bootstrap.mjs` 用 `wrangler vectorize create` 幂等创建：

```js
// scripts/dev/vectorize-bootstrap.mjs
import { execSync } from "node:child_process";
const idx = process.env.VECTORIZE_INDEX ?? "unimailbox-messages";
try {
  execSync(
    `wrangler vectorize create ${idx} --dimensions 768 --metric cosine`,
    { stdio: "inherit" },
  );
} catch (e) {
  if (!/already exists/i.test(String(e))) throw e;
}
```

### 1.2 迁移 0010 — agent_tokens

```sql
-- migrations/0010_agent_tokens.sql
CREATE TABLE agent_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,            -- PBKDF2(passwordIterations)
  scopes TEXT NOT NULL,                -- JSON array of PERMISSION_KEYS
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_agent_tokens_user ON agent_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_agent_tokens_hash ON agent_tokens(token_hash);
```

### 1.3 迁移 0011 — message_embeddings（Vectorize 索引表）

Vectorize 本身存向量；D1 这里只存 message ↔ vector_id 的映射与元数据：

```sql
-- migrations/0011_message_embeddings.sql
CREATE TABLE message_embeddings (
  message_id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  vector_id TEXT NOT NULL,            -- Vectorize 返回的 id
  model TEXT NOT NULL,                -- '@cf/baai/bge-base-en-v1.5'
  dim INTEGER NOT NULL,
  embedded_at INTEGER NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);
CREATE INDEX idx_message_embeddings_mailbox ON message_embeddings(mailbox_id);
CREATE INDEX idx_message_embeddings_embedded_at ON message_embeddings(embedded_at);
```

### 1.4 Permission keys

`packages/contracts/src/domain/index.ts` 新增：

```ts
export const PERMISSION_KEYS = [
  // … 现有 22 个不动 …
  "ai.read", // summarize / classify / extract
  "ai.write", // 内部使用，不暴露给 member
  "schedule.write", // schedule_message / cancel_scheduled
] as const;
export const MEMBER_PERMISSIONS = [
  // … 现有 7 个不动 …
  // 不给 member 默认 ai.read 与 schedule.write；管理员可在 role 表里单独授
];
export const ADMINISTRATOR_PERMISSIONS = [
  // … 现有 22 个 …
  "ai.read",
  "ai.write",
  "schedule.write",
];
```

`scripts/check-permissions.mjs`（如果项目里有）需通过新断言。

### 1.5 Env 扩展

`apps/worker/src/platform/config.ts` 加：

```ts
import type { VectorizeIndex } from "@cloudflare/workers-types";
export interface Env {
  // … 现有 …
  AI: Ai;
  AI_GATEWAY: { run: Ai["run"]; getUrl?: () => string };
  VECTORIZE: VectorizeIndex;
  INBOX_INDEX_QUEUE: Queue<{ mailbox_id: string; message_id: string }>;
  MAILBOX_AGENT: DurableObjectNamespace;
}
```

> `pnpm cf:typegen` 必须跑一次让 `worker-configuration.d.ts` 同步。

### 1.6 测试 fixture

`apps/worker/test/integration/env-fixture.ts` 加：

```ts
AI: {
  async run(model: string, inputs: unknown) {
    // 确定性 mock：embed → 返回 768 维全 0.1；generate → 返回 canned JSON
  },
},
VECTORIZE: { async upsert() { return { mutationId: 'mock' }; }, async query() { return { matches: [] }; } },
AI_GATEWAY: { async run(model: string, inputs: unknown) { return this.run; }, getUrl: () => 'mock://gateway' },
INBOX_INDEX_QUEUE: { async send() {}, async sendBatch() {} },
```

### 1.7 阶段 0 验收 / 回滚

- **Gate**：`pnpm verify` 全过；`pnpm cf:typegen` 无 diff；preview 环境 Vectorize 已建。
- **回滚**：所有新增 binding / migration 都在本分支，未合入 main，无需特别回滚；如果只想临时下线，feature flag `mcp_enabled=0` 即可（阶段 1 才用到）。

---

## 2. 阶段 1：MCP MVP（1 周）

### 2.1 入口：`apps/worker/src/entrypoints/mcp.ts`

骨架（**待真实 SDK 类型化**，先按 Cloudflare 文档现行 API 写）：

```ts
import { createMcpHandler } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/server";
import { appContext } from "../app-context";
import { buildMcpServer } from "../modules/mcp/server";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (!env.MCP_ENABLED) return new Response("disabled", { status: 404 });
    const ctx2 = await appContext(env, ctx);
    const server = buildMcpServer(ctx2);
    return createMcpHandler(server)(request, env, ctx);
  },
};
```

`apps/worker/src/index.ts` 注册（与现有 entrypoint 平级）：

```ts
import mcp from "./entrypoints/mcp";
export default {
  fetch: http.fetch,
  email: inboundEmail.email,
  queue: queueHandler.queue,
  scheduled: scheduled.scheduled,
  // 注册 MCP：在 HTTP 路由前优先匹配 /mcp
  ...(process.env.MCP_ROLLOUT ? {} : {}),
};
```

> 实现策略：把 `/mcp` 作为子路由挂在 `apps/worker/src/http/router.ts` 之前——而不是另起 fetch。这样 `requireAuth()` 可复用。

### 2.2 模块骨架

`apps/worker/src/modules/mcp/server.ts` 暴露 `buildMcpServer(ctx)`：

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { listMessagesTool } from "./tools/list-messages";
import { sendMessageTool } from "./tools/send-message";
// …

export function buildMcpServer(ctx: AppContext) {
  const s = new McpServer({ name: "unimailbox", version: "0.1.0" });
  s.resource("mailbox", "unimailbox://mailboxes", listMailboxesHandler(ctx));
  s.resource(
    "messages",
    "unimailbox://messages/{messageId}",
    getMessageResource(ctx),
  );
  // …5 个 resources …

  s.tool("list_messages", listMessagesTool(ctx));
  s.tool("search_messages", searchMessagesTool(ctx));
  s.tool("get_message", getMessageTool(ctx));
  s.tool("list_threads", listThreadsTool(ctx));
  s.tool("send_message", sendMessageTool(ctx));
  s.tool("draft_message", draftMessageTool(ctx));
  s.tool("reply_message", replyMessageTool(ctx));
  s.tool("forward_message", forwardMessageTool(ctx));
  s.tool("mark_as_read", markReadTool(ctx));
  s.tool("mark_as_starred", markStarredTool(ctx));
  s.tool("move_message", moveMessageTool(ctx));
  s.tool("archive_message", archiveMessageTool(ctx));
  s.tool("trash_message", trashMessageTool(ctx));
  s.tool("schedule_message", scheduleMessageTool(ctx));
  s.tool("cancel_scheduled", cancelScheduledTool(ctx));
  s.tool("list_attachments", listAttachmentsTool(ctx));
  s.tool("download_attachment", downloadAttachmentTool(ctx));
  return s;
}
```

### 2.3 Tool 实现样板

每个 tool 是一个工厂 `(ctx) => ToolDef`。以 `send-message.ts` 为例（最复杂）：

```ts
import { z } from "zod";
import { idempotencyForMcp } from "../idempotency";
import { requireConfirmation, createConfirmation } from "../confirmation";
import { redactMessage } from "../pii";
import { auditMcpCall } from "../audit";
import { checkRateLimit } from "../rate-limit";
import { McpToolError } from "../errors";

const SendInput = z.object({
  mailbox_id: z.string().ulid(),
  to: z.array(z.string().email()).min(1).max(50),
  cc: z.array(z.string().email()).max(50).default([]),
  bcc: z.array(z.string().email()).max(50).default([]),
  subject: z.string().max(998),
  text_body: z.string().max(1_000_000),
  html_body: z.string().max(2_000_000).optional(),
  attachments: z
    .array(
      z.object({
        file_id: z.string().ulid(),
        name: z.string().max(255),
      }),
    )
    .max(25)
    .default([]),
  scheduled_at: z.string().datetime().optional(),
  confirmation_token: z.string().optional(), // 二阶段
  idempotency_key: z.string().min(8).max(255),
});

export const sendMessageTool = (ctx: AppContext) => ({
  name: "send_message",
  description:
    "Send an email. Two-stage: omit confirmation_token first, pass it back to actually deliver.",
  inputSchema: SendInput,
  async handler(
    args: z.infer<typeof SendInput>,
    principal: Principal,
    requestId: string,
  ) {
    const parsed = SendInput.parse(args);
    await checkRateLimit(ctx, principal, "write", 10);
    await auditMcpCall(ctx, {
      tool: "send_message",
      principal,
      args: parsed,
      requestId,
      phase: "enter",
    });

    if (!parsed.confirmation_token) {
      const preview = await previewSend(ctx, principal, parsed);
      const token = await createConfirmation(ctx, principal, parsed, 5 * 60);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              confirmation_required: true,
              preview,
              confirmation_token: token,
            }),
          },
        ],
      };
    }

    const ok = await requireConfirmation(
      ctx,
      principal,
      parsed.confirmation_token,
      parsed,
    );
    if (!ok)
      throw new McpToolError(
        "confirmation_invalid",
        "Token expired or already used",
      );
    if (parsed.scheduled_at) {
      return scheduleOutbound(ctx, principal, parsed);
    }
    const result = await ctx.modules.messages.send(principal, parsed);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
});
```

`reply-message.ts` / `forward-message.ts` 类似但需要 In-Reply-To 头：

```ts
const result = await ctx.modules.messages.reply(principal, {
  ...parsed,
  in_reply_to: source.headers["message-id"],
  references: [source.headers["references"], source.headers["message-id"]]
    .filter(Boolean)
    .join(" "),
});
```

### 2.4 鉴权：`auth.ts`

```ts
import type { Principal } from "@unimailbox/contracts/domain";

export async function authenticate(
  ctx: AppContext,
  req: Request,
): Promise<Principal> {
  const auth = req.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) throw new McpToolError("unauthorized");
  const token = auth.slice(7);

  // 1. 优先 agent_token
  const agent = await ctx.modules.agentTokens.verify(token);
  if (agent)
    return {
      userId: agent.user_id,
      email: agent.email,
      permissions: new Set(agent.scopes),
    };

  // 2. 回退到 JWT
  return ctx.modules.identity.verifyAccessToken(token);
}

export function assertScope(principal: Principal, required: PermissionKey[]) {
  for (const k of required)
    if (!principal.permissions.has(k)) throw new McpToolError("forbidden", k);
}
```

### 2.5 Confirmation store：`confirmation.ts`

```ts
const KEY = (id: string) => `mcp:confirm:${id}`;
const TTL_SEC = 300;
export async function createConfirmation(
  ctx,
  principal,
  payload,
  ttl = TTL_SEC,
) {
  const id = ulid();
  await ctx.env.KV.put(
    KEY(id),
    JSON.stringify({ principal_id: principal.userId, payload, used: 0 }),
    { expirationTtl: ttl },
  );
  return id;
}
export async function requireConfirmation(ctx, principal, id, expected) {
  const raw = await ctx.env.KV.get(KEY(id));
  if (!raw) return false;
  const v = JSON.parse(raw);
  if (v.used || v.principal_id !== principal.userId) return false;
  if (JSON.stringify(v.payload) !== JSON.stringify(expected)) return false;
  await ctx.env.KV.put(KEY(id), JSON.stringify({ ...v, used: 1 }), {
    expirationTtl: 60,
  }); // 保留 60s 防双花
  return true;
}
```

### 2.6 PII 脱敏：`pii.ts`

```ts
const PATTERNS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]"],
  [/\b1[3-9]\d{9}\b/g, "[phone-cn]"],
  [/\b\d{16,19}\b/g, (m) => (luhnValid(m) ? "[card]" : m)],
  [/\b\d{17}[\dXx]\b/g, "[id-cn]"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]"],
];

export function redactText(s: string, allow: string[] = []): string {
  return PATTERNS.reduce(
    (acc, [re, sub]) => acc.replace(re, (m) => (allow.includes(m) ? m : sub)),
    s,
  );
}

export function wrapUntrustedEmail(body: string): string {
  return `BEGIN_UNTRUSTED_EMAIL\n${body}\nEND_UNTRUSTED_EMAIL`;
}
```

### 2.7 Rate-limit：`rate-limit.ts`

```ts
const LIMITS = {
  read: { per_min: 60, per_hour: 1000 },
  write: { per_min: 10, per_hour: 100 },
  ai: { per_min: 20, per_hour: 200 },
} as const;

export async function checkRateLimit(
  ctx,
  principal,
  kind: "read" | "write" | "ai" | "send",
  customPerMin?: number,
) {
  const cfg = LIMITS[kind] ?? { per_min: customPerMin };
  const min = await ctx.env.KV.get(
    `rate:mcp:${kind}:${principal.userId}:${Math.floor(Date.now() / 60000)}`,
  );
  const cur = Number(min ?? 0);
  if (cur + 1 > cfg.per_min) throw new McpToolError("rate_limited");
  await ctx.env.KV.put(
    `rate:mcp:${kind}:${principal.userId}:${Math.floor(Date.now() / 60000)}`,
    String(cur + 1),
    { expirationTtl: 120 },
  );
}
```

### 2.8 Idempotency：`idempotency.ts`

```ts
export async function idempotencyForMcp(ctx, principal, key, payload) {
  // 复用 admin-idempotency，但 namespace 前缀 mcp:
  return ctx.modules.adminIdempotency.check(
    `mcp:${principal.userId}:${key}`,
    payload,
  );
}
```

### 2.9 Resources 样板

`resources.ts`：

```ts
export const listMailboxesResource = (ctx) => ({
  uri: "unimailbox://mailboxes",
  async read(principal) {
    const list = await ctx.modules.mailboxes.listForPrincipal(principal);
    return {
      contents: [
        {
          uri: "unimailbox://mailboxes",
          text: JSON.stringify(
            list.map((m) => ({ id: m.id, address: m.address, role: m.role })),
          ),
        },
      ],
    };
  },
});
// 单封 message resource 类似，preview ≤ 2KB，PII 脱敏
```

### 2.10 测试矩阵（阶段 1）

| 文件                                | 用例                                                            |
| ----------------------------------- | --------------------------------------------------------------- |
| `test/mcp/auth.test.ts`             | agent_token 命中、JWT 回退、scope 不足 throw `forbidden`        |
| `test/mcp/pii.test.ts`              | 5 类正则命中、白名单例外、Luhn 校验、嵌套替换稳定               |
| `test/mcp/confirmation.test.ts`     | 创建 / 校验 / 单次使用 / 跨用户不可用 / TTL 过期                |
| `test/mcp/idempotency.test.ts`      | 相同 key 二次调用返回 cached；不同 key 正常执行                 |
| `test/mcp/rate-limit.test.ts`       | 60/min read 触发；10/min write 触发；不串扰                     |
| `test/mcp/tools/*.test.ts`          | 每个 tool 至少 3 用例（正常 / 鉴权失败 / 参数错误）             |
| `test/mcp/integration/http.test.ts` | Streamable HTTP 完整 `initialize` → `tools/list` → `tools/call` |
| `e2e/mcp.spec.ts`                   | Playwright 跑 `mcp-client` Node SDK                             |

### 2.11 阶段 1 验收 / 回滚

- **Gate**：
  - `pnpm test:unit && pnpm test:integration && pnpm test:e2e` 全过
  - `pnpm cf:typegen` 无 diff
  - Preview 环境 `https://preview.unimailbox.app/mcp` 用 `npx @modelcontextprotocol/inspector` 验证 `tools/list` 返回 16 个 tools、`resources/list` 返回 7 条
  - PII 抽样测试：5 类已知 PII 输入，preview 实测 preview 中无明文
- **回滚**：
  - feature flag `mcp_enabled=0` → entrypoint 直接 404
  - 数据无副作用（agent_tokens / audit_events 是新增表，不影响其他路径）
  - revert commit 单 PR 即可

---

## 3. 阶段 2：AI 读路径（1-2 周）

### 3.1 队列消费：`apps/worker/src/modules/agent/indexer.ts`

```ts
export async function handleIndexBatch(
  batch: MessageBatch<{ mailbox_id: string; message_id: string }>,
  env: Env,
) {
  for (const msg of batch.messages) {
    const { mailbox_id, message_id } = msg.body;
    const message = await env.DB.prepare(
      "SELECT subject, text_body, from_address FROM messages WHERE id = ?",
    )
      .bind(message_id)
      .first();
    if (!message) {
      msg.ack();
      continue;
    }
    const text = `${message.subject}\n${redactText(message.text_body ?? "")}`;
    const { data } = await env.AI.run("@cf/baai/bge-base-en-v1.5", {
      text: [text],
    });
    const vec = data[0];
    const vid = `${mailbox_id}:${message_id}`;
    await env.VECTORIZE.upsert([
      { id: vid, namespace: mailbox_id, values: vec },
    ]);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO message_embeddings (message_id, mailbox_id, vector_id, model, dim, embedded_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(
        message_id,
        mailbox_id,
        vid,
        "@cf/baai/bge-base-en-v1.5",
        768,
        Date.now(),
      )
      .run();
    msg.ack();
  }
}
```

### 3.2 AI Gateway 包装：`apps/worker/src/modules/agent/gateway.ts`

```ts
export async function aiRun<T = unknown>(
  env: Env,
  model: string,
  inputs: unknown,
): Promise<T> {
  if (env.AI_GATEWAY?.run) {
    return env.AI_GATEWAY.run(model, inputs) as Promise<T>;
  }
  return env.AI.run(model, inputs) as Promise<T>;
}
```

### 3.3 Tool 挂载（阶段 1 已占位，阶段 2 实现 handler）

- `summarize_thread`：取 thread 内所有消息 → 拼成 <8K context → 调 `llama-3.1-8b-instruct`，返回 ≤300 字总结。
- `classify_message`：单封 → 调 8B → 输出 `{ labels: string[], confidence: number }`，候选标签硬约束。
- `extract_action_items`：单封 → 调 8B with JSON mode → 校验 schema → 返回结构化数组。
- `search_messages` 升级：先 LIKE/GLOB，miss 后回退 vectorize query，merge top-K。

### 3.4 阶段 2 验收 / 回滚

- **Gate**：新邮件入库 → 60s 内被 `search_messages` 语义查询命中；`summarize_thread` P95 < 3s。
- **回滚**：队列 DLQ 在；feature flag `mcp_ai_enabled=0` 即关闭所有 ai.\* tools。

---

## 4. 阶段 3：AI 写路径 + MailboxAgent DO（2 周）

### 4.1 DO 骨架

```ts
// apps/worker/src/modules/agent/mailbox-agent-do.ts
import { DurableObject } from "cloudflare:workers";

export class MailboxAgent extends DurableObject<Env> {
  conversations = new Map<
    string,
    Array<{ role: "user" | "assistant"; text: string }>
  >();
  pending_actions: PendingAction[] = [];
  subscriptions = new Set<WebSocket>();

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      this.subscriptions.add(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    // … JSON-RPC over HTTP for control plane …
  }

  async webSocketMessage(ws: WebSocket, message: string) {
    // 处理 incoming 消息
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ) {
    this.subscriptions.delete(ws);
    try {
      ws.close(code, reason);
    } catch {}
  }
}
```

### 4.2 调度联动

`schedule_message` tool 直接写 `outbound_jobs`（`created_via_schedule=1`，`available_at = scheduled_at`），复用现有 Cron 调度。DO 只持有"等用户确认"的待办，不重复实现调度逻辑。

### 4.3 `resources/subscribe`

阶段 3 让 DO 暴露 WebSocket；MCP server 在 `resources/subscribe` 时把客户端 socket 与 DO 的 WebSocket 桥接。**注意**：spec 2026-07-28 的 subscriptions 是 GA 但实现复杂度高，建议 v1 简化为"轮询 + `Last-Event-ID`"。

### 4.4 阶段 3 验收 / 回滚

- **Gate**：单 mailbox 100 并发 WS 连接稳定 1 小时；schedule_message × N 批量成功；DO 单实例 CPU < 50%。
- **回滚**：DO 无外部依赖，删除 binding 即可；feature flag `mcp_do_enabled=0` 禁用所有 DO 路径。

---

## 5. 阶段 4：发布与生态（1 周）

### 5.1 `.well-known/*` 端点

挂在现有 `apps/worker/src/http/router.ts`：

```ts
app.get("/.well-known/oauth-protected-resource", (c) =>
  c.json({
    resource: `${new URL(c.req.url).origin}/mcp`,
    authorization_servers: [`${new URL(c.req.url).origin}/oauth`],
    scopes_supported: PERMISSION_KEYS,
  }),
);

app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: new URL(c.req.url).origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    code_challenge_methods_supported: ["S256"],
    // …
  }),
);
```

> v1 不实现完整 OAuth server；这两个端点先返回声明，标注 `status: "experimental"`。

### 5.2 UI：agent_token 管理

`apps/web/src/routes/settings/integrations/mcp.tsx`：

- 列表：每个 token 显示 `name, scopes, created_at, last_used_at, expires_at`
- 操作：撤销（软删）+ 重发（生成新 plaintext，仅展示一次）
- 创建表单：选择 scopes 子集 + 过期时间

复用现有 TanStack Form + Query 模式（`apps/web/src/lib/api/transport.ts`）。

### 5.3 阶段 4 验收 / 回滚

- **Gate**：
  - `/.well-known/*` 端点 curl 返回合规 JSON
  - UI 中可创建 / 撤销 token；撤销后旧 token 立即失效（verify 时 check `revoked_at IS NULL`）
- **回滚**：UI 是新增路由，不影响其他；`.well-known/*` 端点关掉即可（无副作用）。

---

## 6. 跨阶段不变项

### 6.1 Feature flags

`system_settings` 行新增：

```sql
UPDATE system_settings SET mcp_enabled = 0, mcp_ai_enabled = 0, mcp_send_confirm_required = 1;
```

entrypoint 入口检查 `mcp_enabled`；tool 工厂检查 `mcp_ai_enabled` 与 `mcp_send_confirm_required`。所有 flag 默认关闭，逐阶段打开。

### 6.2 观测

`apps/worker/src/platform/heartbeat.ts` 增：

- `mcp.tool_calls.total{tool,decision}`
- `mcp.errors.total{tool,code}`
- `mcp.confirmation.created.total`
- `mcp.ai.llm.tokens{in,out,model}`（从 AI Gateway 拿）

`/health` 增 `mcp` 段（仅 feature flag 开启时报告）。

### 6.3 必须通过的 CI

- `pnpm verify` = typecheck + lint + unit + integration + e2e + workflow-security
- `scripts/frontend-contract-check.mjs` 自动覆盖新增的 endpoints.ts
- `scripts/config-parity.mjs` 校验 wrangler 两个 config 与 preview env 一致

---

## 7. PR 拆分建议（便于 review）

| PR  | 标题                                                           | 内容                                                                    |
| --- | -------------------------------------------------------------- | ----------------------------------------------------------------------- |
| #1  | chore(mcp): foundation bindings + migrations + permission keys | 阶段 0 全部，**不引入 entrypoint**，仅 prep                             |
| #2  | feat(mcp): streamable http + auth + idempotency scaffolding    | entrypoint + auth + idempotency + 一个 hello tool                       |
| #3  | feat(mcp): resources + read tools                              | 5 resources + 4 read tools + tests                                      |
| #4  | feat(mcp): write tools + confirmation flow                     | send/draft/reply/forward + mark\_\* + move/archive/trash + confirmation |
| #5  | feat(mcp): schedule + attachments                              | schedule_message / cancel + attachment tools                            |
| #6  | feat(ai): workers ai + vectorize pipeline                      | indexer + embed + summarize/classify/extract + search upgrade           |
| #7  | feat(agent): mailbox agent durable object + schedule 联动      | DO + WebSocket + write-path AI                                          |
| #8  | feat(mcp): discovery + ui + docs                               | `.well-known/*` + agent_token UI + runbook                              |

每个 PR 单独 reviewable、单独可回滚、独立走完 `pnpm verify`。

---

## 8. 当前待确认 / 待补决策

> 这些不在本 PR 直接决策，但实施中需要确认。

1. **OAuth provider 实现方式**：阶段 4 是否要 full OAuth 2.1，还是只 `/.well-known/*` 占位？默认占位。
2. **DO 命名空间是否分片**：单 mailbox 一实例 vs hash 分片？默认单 mailbox，监控到位再分。
3. **Agent token 是否可由管理员代用户创建**：默认否，仅用户本人创建。
4. **`send_message` 是否允许 `from` 字段**：默认否，从 `users.email` 派生；别名支持在阶段 4 之后再讨论。
5. **附件 MCP 行为**：v1 默认白名单 = 当前 user 上传过的 MIME；不允许 agent 上传新二进制。需用户在前端单独勾选"允许 agent 下载附件"。
