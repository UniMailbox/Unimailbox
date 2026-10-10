# UniMailbox 项目验收测试用例

**编制日期：2026-10-06。交付物类型：测试设计与执行模板；本次未执行应用验收。**

基于当前工作区代码、路由、contracts、迁移和整合计划编写。基线分支为
`cap/CAP-065-mailbox-sharing-ui`，HEAD 为 `cf5acfdcdcaff2b6b752acf6b8536fa9d93473b6`，
**包含大量未提交实现，单独记录这个 commit 不足以重建验收版本**。执行前须记录实际工件、工作树快照或补丁摘要。
当前 schema 为 **0028**。历史测试通过次数不属于本轮验收结果。

- [执行记录 CSV](./acceptance-execution.csv)：与本文用例一一对应，初始结果全部为“未执行”。UTF-8 BOM，可导入 Excel。
- [当前整合计划](../rebuild/12-cloud-mail-agentic-inbox-integration-plan.md)
- [UI 基座方案](../rebuild/13-shadcn-admin-kit-adoption.md)
- [Durable Object ADR](../rebuild/14-durable-object-mailbox-adr.md)

## 1. 范围、原则与执行顺序

### 1.1 本轮业务边界

- Cloudflare Worker 同时提供 API 和 Web 静态资源；D1 为用户/授权/邮件状态权威存储，R2 保存字节，Queue 异步发信。
- Cloudflare Email Routing 收信，Brevo 首个发信 adapter；后续 SMTP/provider 扩展单列，不宣称已实现。
- 自建用户和 session，admin 创建账号；无公开注册、邀请码或 Cloudflare Access 身份依赖。
- 管理端 `/admin/*` 与邮箱端 `/mailbox/*` 分区。全局管理员不自动获得邮箱正文权限。
- UTC 存储，前端按浏览器时区展示；不验收旧 Cloud Mail 的历史发送时间修复。
- DO 主存储不在 V1 范围；已有 D1/R2/Queue 方案需要真实环境闭环。

本文既含已有实现的回归用例，也含目标验收和已知缺口。**预期结果是判定标准，不是已验证结论**。
发现代码与预期不符时记录失败/缺口，不能为了通过测试改写预期。范围如有调整，记录负责人、日期和理由。

### 1.2 标记说明

| 标记 | 意义 |
| --- | --- |
| P0 | 发布关键：权限、身份、数据完整性、正常收发或重复发送风险 |
| P1 | 核心功能、可恢复错误、兼容性、管理闭环与主要体验 |
| P2 | 后续扩展或本轮明确非主线能力 |
| 已有代码，可测 | 源码存在该测试入口；不表示实现无缺陷 |
| 已有代码，需真实环境 | 必须有独立 preview/provider/browser 证据，本地通过不能替代 |
| 待实测风险 | 需要实验确认或产品标准，按预期实测后记录结论 |
| 已知缺口，待补齐 | 尚无完整闭环，当前不得标通过；允许先测已有部分 |
| L | 本地隔离 Worker/workerd、D1/R2/KV/Queue 夹具，允许故障/时钟注入 |
| A | HTTP API 测试，使用当前 contracts 和真实权限上下文 |
| B | 实际浏览器测试；组件单测不能替代 |
| P | 独立 Cloudflare preview + 受控外部邮箱/真实 Brevo |

组合如 `L+P` 表示两层都要留证。标记 `B+A` 的用例在本地先执行，发布前关键用例再在 P 重跑。
参数化用例的每个数据变体须有独立结果；CSV 可复制该行并填写“变体”，保持原用例 ID。

### 1.3 建议轮次

1. 冻结版本，完成环境/迁移和基线自动检查。
2. 执行第 6 节冒烟；任一 P0 失败先定位，阻塞相关批次。
3. 浏览器正常流程 → API 边界/权限 → 本地故障/并发 → preview 集成。
4. 对已知缺口形成待修复清单；补齐后执行对应 GAP 和相关模块回归。
5. 整理通过率、缺陷、阻塞、证据和范围差异，按第 7 节签署结论。

## 2. 环境、证据和执行前提

### 2.1 每轮必填

| 字段 | 填写内容 |
| --- | --- |
| RUN_ID | 例如 `qa-20261006-01`，每封主题使用 `[RUN_ID][用例ID][变体]` |
| 构建 | commit + 未提交快照摘要 + Worker/Web 工件标识 + 部署时间 UTC |
| 环境 | base URL、Cloudflare 测试资源标识、schema、Queue/Cron、配置摘要 |
| 外部依赖 | Brevo 连接代号及配置版本、DNS/Email Routing 目标；只记代号，不记 secret |
| 客户端 | OS、浏览器版本、视口、语言、主题、时区、网络档位 |
| 人员与时间 | 执行人、开始/结束 UTC、复核人 |

### 2.2 进入标准

- 独立测试部署已指定，D1/R2/KV/Queue 与生产分开，Email Routing 指向正确 Worker。
- 安装、加密、游标签名等秘密由环境负责人配置；没有把 secret 写入用例表、HAR 或普通日志。
- 至少两个受控测试域、两个可区分 Brevo connection、两个外部测试收件箱；如果只提供一套资源，对应多域/多连接项标“阻塞”，不能省略为通过。
- 测试人员有最小所需日志/只读数据检查权限。故障注入和直接改 D1 仅用于独立夹具/副本；不能靠修改生产数据制造测试状态。
- 可恢复备份、测试数据归属和清理方法明确。真实邮件只发至受控地址，bounce/complaint 采用 provider 支持的安全测试方法。

### 2.3 证据规范

建议证据目录：`work/reviews/QA-<RUN_ID>/<case-id>/<variant>/`。该路径是保存约定，本文没有创建或收集运行证据。
敏感证据保存在受控存储，不提交仓库。每例至少保留：

1. 操作前后截图或请求/响应（状态码、业务 code、requestId、资源 ID）。
2. 涉及写入时的 D1 前后摘要；附件保留大小和 SHA-256，失败记录实际错误。
3. 真实邮件项保留外部 `.eml`、Cloudflare invocation、Queue/job、Brevo 日志及 webhook 对应关系。
4. 变体、实际结果、缺陷号和复测版本；凭据、私人正文、Cookie、Authorization 必须脱敏。

时间统一记录 UTC。邮件“API 202 已受理”“provider accepted/sent”“外部收到”“webhook delivered”是四个不同证据节点。
缺其中一环就标明缺失，不能互相代替。

## 3. 账号、资源和权限矩阵

### 3.1 资源矩阵

以下 `.test` 地址仅用于本地 fixture。P 测试必须替换成实际掌控域名，不能向示例地址发真实邮件。

| 代号 | 准备方法 / 用途 |
| --- | --- |
| ADMIN | setup 创建的管理员，有管理权限；默认不是 M1/M2 成员 |
| U1 / U2 | admin 创建的普通用户，分别是 M1/M2 owner，已改密 |
| UNEW | 新建/重置后未改密；用完可重新创建独立变体 |
| VIEWER / SENDER / MADMIN | 三个独立 active 用户，分别对 MSH 持 viewer/sender/admin grant |
| READADMIN | 用本地受控夹具授予 user.read、settings.read 等只读权限；无 manage |
| SHAREADMIN | 仅用于成员管理边界：全局 mailbox.share，无 M1 content grant |
| BANNED / DELETED | 独立账号生命周期夹具，不复用 ADMIN |
| D1A / D1B | 域名代号，**不是 D1 数据库名**；本地 `qa-a.test` / `qa-b.test`；P 用真实测试域 |
| C1 / C2 | 可区分、可观察的 Brevo connections；D1A→C1，D1B→C2 |
| M1 / M2 / MSH | `qa-one@D1A`（U1）、`qa-two@D1B`（U2）、`qa-shared@D1A`（U1） |
| EXT1 / EXT2 | 两个外部受控收件箱；用来收信、回复、验证 Cc/Bcc 与原始头 |

使用管理员账号建用户，再分别以 U1/U2 身份 API 建邮箱（当前请求以 actor 为 owner）。
角色赋权、inactive 域、超时 job 等没有产品入口的状态，只能由明确标记的测试夹具准备。
**夹具可测不等于该管理产品流程已经实现。**

### 3.2 当前实际权限规则

| 操作 | owner | viewer | sender | mailbox admin | 仅全局管理员，无 grant |
| --- | --- | --- | --- | --- | --- |
| 读内容/线程/附件 | 是* | 是* | 是* | 是* | 否 |
| 改自己的已读/星标/个人软删除 | 是* | 是* | 是* | 是* | 否 |
| 发信/上传/创建修改发送草稿 | 是† | 否 | 是† | 是† | 否 |
| 实际 HTTP 成员管理 | 是 | 否‡ | 否‡ | 否‡ | 持全局 mailbox.share 时可管理 |
| 永久删除邮箱/全局消息 | 当前未提供完整产品入口，不能依据 authorizer 枚举判定已实现 | — | — | — | — |

\* 还须具有全局 `message.read`；† 还须具有全局 `message.send`。
‡ 如果同时具有全局 `mailbox.share`，实际成员管理服务允许操作，与邮箱内容读权限独立。
`mailbox-member-service.ts` 使用“owner 或全局 mailbox.share”，不能直接复制 `authorizer.ts` 的 manage_members 注释当 HTTP 行为。
成员管理权可改变谁有 grant，须单独评审其范围、审计及首次改密限制（QA-ACL-009、QA-SEC-007）。
正文读取的“不自动授权”不表示管理员无法通过受审计的成员管理再授予权限。

## 4. 样本与边界数据

| 样本代号 | 构造内容 |
| --- | --- |
| T-TEXT | 中文/英文/emoji 主题、Unicode 显示名、换行纯文本；主题带 RUN_ID |
| T-MIME | mixed 包含 alternative(text/plain + text/html)、related PNG CID、PDF、同名文件；base64/QP、折叠头、缺头/坏边界各独立 `.eml` |
| T-ENVELOPE | 同一 MIME：To=M2、Cc=外部；分别注入 envelope to=M1/M2；另制仅 Bcc 的 envelope；别把 MIME To 当传输收件人 |
| T-XSS | `<script>`, `<img src=x onerror=...>`, `javascript:` 链接、iframe/form/svg/style、remote/srcset/data/blob 图片；只用受控回连域 |
| T-FILE | 0/1/5242880/5242881 字节；PNG/JPEG/GIF/WebP/PDF/TXT/HTML/SVG；文件名 1/255/256 字符、空白、中文、CR/LF/NUL |
| T-TIME | SQL 裸 UTC、ISO Z、带 offset、缺失/坏时间；跨日/跨年、2026-11-01 洛杉矶 DST 回拨；固定服务端 clock |
| T-PAGES | 每列表至少 55 条，含同 createdAt 不同 ID；性能样本为 1 万封邮件、50 用户、10 域 |
| T-FAIL | D1 batch/audit 失败、R2 get/put/delete 失败、KV 失败、Queue publish 丢失、Brevo 429/4xx/5xx/超时、客户端丢响应 |

每个样本保存生成说明、字节大小及 SHA-256。固定时间的清理边界用 L 夹具注入 clock；真实 R2 `uploaded` 时间不能靠改 D1 时间模拟，P 使用自然老化对象。
多 part、重名和 CID 样本要先在普通邮件客户端核对原文，避免把坏 fixture 当产品 bug。

### 4.1 已确认的当前限制

| 项目 | 当前契约 / 注意点 |
| --- | --- |
| 普通 JSON API body | 总计 1 MiB；按字节，中文与转义会增大 payload |
| 上传附件 | 每个 **1 字节至 5 MiB**；staging TTL 一小时 |
| compose 附件 | 最多 10 个 uploadId、禁止重复；并非 UI 已有上传按钮 |
| compose 主题/正文 | API 主题≤998 字符且允许空；UI 要求非空主题；text/html 各≤1000000 字符，仍受总请求上限 |
| 草稿 | subject≤998、body_text≤65536、body_html≤131072；To/Cc/Bcc 各≤50 个字符串地址 |
| 新密码 | 当前 6–30 字符；此为现状，不代表已经完成密码强度/登录限流验收 |
| Queue lease / orphan | 60 秒 / queued 超 5 分钟；Cron 每两分钟，实际执行时间可有平台延迟 |
| 入站孤儿扫描 | raw-mime 与 inbound-attachment 各最多100个/轮；严格超过24小时且无 D1 引用才删除 |
| 设置页面 | byte 上限契约可到64 MiB，但当前上传仍固定5 MiB；policy 持久化不证明运行时执行 |

### 4.2 API 执行定位

统一 API 前缀为 `/api/v1`。业务请求使用应用自己签发的 Bearer；有幂等要求的写操作传
`Idempotency-Key: <每次逻辑操作唯一 UUID>`。测试重放时保持相同 raw body 和 key；新逻辑操作使用新 key。
`If-Match` 必须使用读取返回的当前版本，草稿是 `updated_at`，域名/签名/设置为对应 `updatedAt`。
认证、setup、webhook 各有独立规则，不机械添加业务 Bearer 替代其验证。

| 入口 | 用途 |
| --- | --- |
| POST /auth/login、/refresh、/change-password；GET /auth/me；POST /auth/logout | 自建会话 |
| GET/POST /admin/users；POST /admin/users/:id/password-reset；PATCH /admin/users/:id/status | 用户生命周期 |
| GET/POST /mailboxes；GET/POST /mailboxes/:mailboxId/members；DELETE /mailboxes/:mailboxId/members/:userId | 邮箱与共享 |
| GET /mailboxes/:mailboxId/messages?folder=inbox；GET /mailboxes/:mailboxId/messages/:messageId；GET 同路径/thread | 邮件列表/详情/线程 |
| PATCH /mailboxes/:mailboxId/messages/:messageId/read、/star；DELETE /mailboxes/:mailboxId/messages/:messageId | 个人状态 |
| POST /mailboxes/:mailboxId/messages/send | 普通 compose |
| POST /mailboxes/:mailboxId/drafts；GET/PATCH /drafts/:draftId；POST /drafts/:draftId/send | 草稿 |
| POST /mailboxes/:mailboxId/attachments/uploads；GET /mailboxes/:mailboxId/attachments/:attachmentId/download | binary 上传/下载 |
| GET/POST /admin/domains；POST /admin/domains/:id/verify；PATCH /admin/domains/:id/outbound-connection；DELETE /admin/domains/:id | 域及连接绑定 |
| /admin/roles、/admin/signatures、/admin/settings、/admin/audit-events、/admin/connections、/admin/webhook-events | 管理资源；按源码已定义 method 调用 |
| /admin/blocklist、/admin/roles/:id/policy | 仅 API 的入站策略管理 |
| POST /webhooks/:providerKey/:connectionId | adapter 验签；本地自签样本不能证明真实 Brevo 兼容 |

示例数据结构（只用于准备请求；替换 ID 后在指定测试环境执行）：

```json
{
  "localPart": "qa-one",
  "domainId": "<D1A 的 UUID>",
  "displayName": "QA mailbox"
}
```

```json
{
  "to": [{ "address": "<受控外部收件地址>" }],
  "cc": [],
  "subject": "[RUN_ID][QA-SEND-001]",
  "textBody": "QA message",
  "attachmentUploadIds": []
}
```

```json
{
  "subject": "[RUN_ID][QA-DRAFT-001]",
  "body_text": "draft text",
  "to": [],
  "cc": [],
  "bcc": []
}
```

上传为原始二进制请求体，使用 `X-Filename`、`Content-Type`、可选 `X-Attachment-Disposition`，不是 multipart 表单。
具体必填字段、返回 code 和边界以每模块源码链接及当前 contracts 为依据；不要用旧邀请/Access 文档准备身份。

## 5. 完整用例

每例的模块前置条件继承第 2–4 节；局部“前置”是在此基础上的补充。每例留证要求为该模块共用要求，CSV 已展开至每一行。

**用例总数：175；模块：18；P0：110，P1：63，P2：2。**

| 模块 | 数量 |
| --- | --- |
| [ENV — 环境、安装与迁移](#module-env) | 10 |
| [AUTH — 登录、会话与首次改密](#module-auth) | 11 |
| [USER — 管理员管理账号](#module-user) | 8 |
| [ACL — 多用户、多邮箱与权限隔离](#module-acl) | 10 |
| [DOMAIN — 域名与发信连接](#module-domain) | 8 |
| [ADMIN — 角色、签名、系统设置与审计](#module-admin) | 10 |
| [IN — Cloudflare 收信与 MIME 解析](#module-in) | 11 |
| [MAIL — 邮箱列表、详情、线程与个人状态](#module-mail) | 9 |
| [SEND — 写信与回复](#module-send) | 9 |
| [DRAFT — 服务端草稿与本地恢复](#module-draft) | 9 |
| [ATT — 附件上传、消费、下载与 CID](#module-att) | 10 |
| [OUT — Queue、Brevo 与发送可靠性](#module-out) | 9 |
| [HOOK — Webhook 验签、状态与事件回放](#module-hook) | 10 |
| [DATA — UTC、数据持久性与定时清理](#module-data) | 9 |
| [SEC — 安全与接口异常](#module-sec) | 9 |
| [UX — 界面、浏览器、可访问性与性能](#module-ux) | 9 |
| [OPS — 端到端验收、运维与恢复](#module-ops) | 6 |
| [GAP — 尚未闭合的产品能力与专项验收](#module-gap) | 18 |

实现状态统计：已有代码，需真实环境 36；已有代码，可测 107；待实测风险 15；已知缺口，待补齐 17。

<a id="module-env"></a>

### ENV — 环境、安装与迁移

**源码依据：** [wrangler.jsonc](../../apps/worker/wrangler.jsonc)、[setup.ts](../../apps/worker/src/http/routes/setup.ts)、[schema-version.ts](../../apps/worker/src/database/schema-version.ts)、[deploy.ts](../../scripts/deploy.ts)、[router.tsx](../../apps/web/src/app/router.tsx)

**留证要求：** 构建/迁移记录、绑定清单、页面截图、脱敏请求响应；preview 项另附部署版本。

#### QA-ENV-001 · 全新环境和重复迁移

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / L+P
- **前置条件：** 空的独立测试 D1，构建版本已冻结
- **步骤：** 1) 应用 0001–0028 迁移及对应验证；2) 再执行 pending-only 迁移；3) 比较 schema 和业务数据。
- **预期结果：** schema 为 0028；第二次无重复 ALTER/重置数据；迁移账本只记录一次；失败时不得报告部署成功。

#### QA-ENV-002 · 从旧 schema 升级

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / L+P
- **前置条件：** 旧版本 D1 副本，含用户、会话、邮件和 webhook 数据
- **步骤：** 1) 备份；2) 升级到 0028；3) 对比数量、关键关联和旧 webhook 投影；4) 读取旧邮件。
- **预期结果：** 原数据及授权保留；0026–0028 新字段/表可用；旧事件回填符合迁移定义；无孤立引用或不可读邮件。

#### QA-ENV-003 · Worker 资源绑定

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / P
- **前置条件：** 独立 preview 域名和资源
- **步骤：** 1) 核对 DB、ATTACHMENTS、CACHE、SETUP_SESSION、OUTBOUND、ASSETS 和三个 secret binding；2) 请求 /healthz；3) 核对 Queue consumer 和每两分钟 Cron。
- **预期结果：** 绑定均指向测试资源；healthz 返回 ok；生产凭据和资源不混入；无需 Cloudflare Access 或 DO mailbox binding。

#### QA-ENV-004 · 首次安装完整流程

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / B+P
- **前置条件：** 新部署，安装令牌有效，外部测试收件箱可用
- **步骤：** 1) 依次执行 claim、preflight、administrator、domain、cloudflare-verify、inbound-smoke、brevo、outbound-smoke、complete；2) 保存每步真实响应。
- **预期结果：** 状态推进与实际检查一致；收/发 smoke 有外部邮件证据；完成后进入登录/邮箱；无邀请或 Access 登录步骤。

#### QA-ENV-005 · 安装令牌与会话边界

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L+A
- **前置条件：** 另一个全新本地安装
- **步骤：** 1) 错误令牌 claim；2) 缺失、伪造、过期 setup session 调用后续步骤；3) 比较 D1。
- **预期结果：** 请求被拒绝且不产生管理员/域名/连接；错误不包含安装令牌；有效会话才能推进安装。

#### QA-ENV-006 · 安装重载、重复提交和跳过

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+L
- **前置条件：** 安装到中间步骤
- **步骤：** 1) 刷新、后退、重新进入当前步骤；2) 同一幂等键重复提交；3) 走页面允许的跳过流程。
- **预期结果：** 可恢复真实步骤；无重复账号/域名或重复 smoke 发送；跳过与实测成功可区分，不能据此把收发验收标成通过。

#### QA-ENV-007 · 安装完成后封闭初始化入口

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / A+P
- **前置条件：** 已完成安装
- **步骤：** 1) 重放旧 setup session 和旧 claim；2) 尝试创建第二个初始管理员或改写安装配置。
- **预期结果：** 初始化写入口不再允许接管部署；已有用户、密钥、域名保持原值。

#### QA-ENV-008 · 静态资源与深链接

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / B+P
- **前置条件：** 已登录且存在邮箱、详情、草稿
- **步骤：** 1) 直接打开并刷新 /admin/users、邮箱详情、草稿路径；2) 检查 JS/CSS；3) 打开不存在的 /api/v1 路径。
- **预期结果：** 深链接正常渲染；构建 hash 资源无 404；未知 API 为错误响应，不能返回 SPA HTML 或 200 假成功。

#### QA-ENV-009 · 本地质量门禁

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / L
- **前置条件：** 冻结当前工作树快照，依赖已安装
- **步骤：** 1) 按第 8 节依次运行类型、单元、Worker、构建检查；2) 记录失败文件和数量；3) 核对 package scripts。
- **预期结果：** 所有要求的门禁有本次日志；不得引用历史 1222/868 数字充当本次执行；构建告警单独记录。

#### QA-ENV-010 · 升级后二次部署

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，需真实环境 / B+P
- **前置条件：** preview 已有用户、邮件、附件
- **步骤：** 1) 保存资源及数据摘要；2) 部署同一版本；3) 登录、收信、读取旧附件。
- **预期结果：** 无 schema 重放破坏、账号重置或附件丢失；资源绑定和客户端资源版本匹配。

<a id="module-auth"></a>

### AUTH — 登录、会话与首次改密

**源码依据：** [auth.ts](../../apps/worker/src/http/routes/auth.ts)、[authn.ts](../../apps/worker/src/http/middleware/authn.ts)、[authz.ts](../../apps/worker/src/http/middleware/authz.ts)、[auth-queries.ts](../../apps/web/src/features/auth/auth-queries.ts)、[ChangePasswordPage.tsx](../../apps/web/src/features/auth/ChangePasswordPage.tsx)

**留证要求：** 页面状态、脱敏 HAR、D1 session 状态；不得保存密码、Bearer 或 refresh cookie 原文。

#### QA-AUTH-001 · 登录及硬刷新恢复

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / B+P
- **前置条件：** U1 为 active 且已改密
- **步骤：** 1) 登录；2) 硬刷新邮箱详情；3) 新标签页打开同站点。
- **预期结果：** 页面恢复 U1 身份；刷新流程取得新 Bearer 后再读 /me；无无限重定向或空白页面。

#### QA-AUTH-002 · 错误登录和缺少认证

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** 不存在账号、错误密码、无 token
- **步骤：** 1) 分别尝试登录；2) 无凭据请求邮箱/管理接口。
- **预期结果：** 登录失败不返回用户秘密；受保护接口为 401；页面可重新登录，无业务写入。

#### QA-AUTH-003 · 首次登录强制改密

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** 管理员新建 UNEW，使用一次性初始密码
- **步骤：** 1) 登录；2) 直接访问邮箱、管理写 API；3) 完成改密。
- **预期结果：** 改密前进入 /change-password，业务访问被阻止；改密成功后才能进入授权区域。

#### QA-AUTH-004 · 密码边界与错误旧密码

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** UNEW 的首次改密页面
- **步骤：** 1) 测 5、6、30、31 字符新密码；2) 使用错误 currentPassword；3) 再用合法密码。
- **预期结果：** 6–30 字符符合当前契约；越界或旧密码错误不修改密码；不得误清除 mustChangePassword。

#### QA-AUTH-005 · KV token 必须绑定 D1 session

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 本地构造缺 sessionId、错误 userId、过期及撤销 session 的 token
- **步骤：** 1) 分别请求 /auth/me、邮件详情及附件下载；2) 保留一个有效对照 token。
- **预期结果：** 四种无效 token 均不可读取业务；只有归属匹配、有效且用户 active 的 session 可用。

#### QA-AUTH-006 · 忽略外部身份声明

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 无自建 session
- **步骤：** 1) 仅带 CF-Access-Jwt-Assertion、Cf-Access-Authenticated-User-Email 或旧 Better Auth cookie 请求；2) 用 U1 token 加伪造 admin header 重试。
- **预期结果：** 外部头/cookie 不能登录、提权或改变 U1 身份；Cloudflare Access 不成为身份来源。

#### QA-AUTH-007 · refresh cookie 属性与存储

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / B+P
- **前置条件：** HTTPS preview
- **步骤：** 1) 登录检查 Set-Cookie；2) 检查 JS、localStorage、sessionStorage、IndexedDB；3) 在无 cookie/过期 cookie 下刷新。
- **预期结果：** refresh cookie 有 HttpOnly，HTTPS 下有 Secure 和合适 SameSite/Path；Bearer 不落浏览器持久存储；失败可回登录，不泄漏 token。

#### QA-AUTH-008 · 退出和账号切换

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** U1 在邮箱、详情及草稿页有缓存
- **步骤：** 1) 退出；2) 后退、硬刷新并重放旧 refresh；3) 同浏览器登录 U2。
- **预期结果：** 旧 session 不能恢复；U2 不看到 U1 的邮箱、附件或草稿缓存；退出页面无假成功后仍可认证的情况。

#### QA-AUTH-009 · 登录与 refresh 幂等

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / A+L
- **前置条件：** 同一请求体和固定幂等键
- **步骤：** 1) 缺键请求；2) 同键同体重复；3) 同键改 body；4) 并发 refresh。
- **预期结果：** 缺键有明确错误；同键请求按认证专用重放规则处理，不泄漏持久保存的凭据；不同 body 冲突；不会给不同用户复用 session。

#### QA-AUTH-010 · 公开注册和邀请关闭

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** 已安装，admin 与匿名两种身份
- **步骤：** 1) 打开 /register；2) POST /auth/register；3) GET/POST /admin/invite-codes。
- **预期结果：** 注册页告知由管理员创建；注册 API 返回 REGISTRATION_DISABLED；邀请接口拒绝；不能创建用户或邀请码。

#### QA-AUTH-011 · 登录失效和并发请求恢复

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，需真实环境 / B+P
- **前置条件：** 同时打开列表、详情和附件请求
- **步骤：** 1) 使访问凭据过期；2) 同时刷新页面数据；3) 再撤销 session。
- **预期结果：** 合法 refresh 后请求使用当前 token；撤销后回登录；无重试风暴、重复写入或继续展示另一个用户的数据。

<a id="module-user"></a>

### USER — 管理员管理账号

**源码依据：** [admin-users.ts](../../apps/worker/src/http/routes/admin-users.ts)、[UsersPage.tsx](../../apps/web/src/features/admin/UsersPage.tsx)、[admin-user-lifecycle.worker.test.ts](../../apps/worker/src/http/routes/admin-user-lifecycle.worker.test.ts)

**留证要求：** 账号页面、脱敏响应、用户/session/审计/幂等记录前后对比。

#### QA-USER-001 · 创建用户及一次性密码

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** ADMIN 登录 /admin/users
- **步骤：** 1) 创建唯一邮箱 UNEW；2) 保存一次性密码至测试密钥管理器；3) 刷新列表并重放创建请求。
- **预期结果：** 仅一个用户；初始密码只在首次成功响应展示；列表、审计和幂等重放不包含密码/哈希；UNEW 必须改密。

#### QA-USER-002 · 用户输入与重复创建

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** 已有 U1
- **步骤：** 1) 提交无效邮箱、超长 displayName；2) 提交 U1 的大小写变体；3) 同时提交相同新邮箱。
- **预期结果：** 非法值不入库；邮箱规范化后不重复；并发最多创建一个账号，失败可恢复表单。

#### QA-USER-003 · 重置密码撤销旧会话

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** U1 在两个浏览器会话登录
- **步骤：** 1) ADMIN 重置 U1 密码；2) 两会话刷新/发请求；3) 使用旧密码及新初始密码登录。
- **预期结果：** 旧 session 和旧密码失效；新密码触发强制改密；列表和审计无密码原文。

#### QA-USER-004 · 停用与恢复用户

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** U1 为 active，有邮箱和邮件
- **步骤：** 1) 停用 U1；2) 重放已有 token/refresh 并尝试登录；3) 恢复 active 并重新登录。
- **预期结果：** 停用后不可使用旧会话或登录；恢复需重新认证；邮箱、邮件和授权不因停用误删。

#### QA-USER-005 · 软删除与管理员自保护

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** ADMIN、U1，保存初始状态
- **步骤：** 1) 把 U1 标为 deleted；2) 尝试访问；3) ADMIN 尝试 banned/deleted 自己。
- **预期结果：** U1 不可认证；管理列表显示真实状态；当前管理员自停用/自删除被拒绝。

#### QA-USER-006 · 账号变更原子性

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 本地 D1 故障注入夹具
- **步骤：** 1) 对创建、重置、状态变更分别让审计 INSERT 失败；2) 比较用户、session、幂等及审计记录。
- **预期结果：** 整个相关 batch 回滚；不会产生已改密码/状态但无审计的部分成功；重试可恢复。

#### QA-USER-007 · 用户列表分页与安全投影

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** 至少 55 个测试账号，含 banned/deleted
- **步骤：** 1) 翻页；2) 篡改游标并选择重新开始；3) 检查响应字段。
- **预期结果：** 顺序稳定、无重复或遗漏；坏游标有恢复路径；不返回密码哈希、salt、session 或 token。

#### QA-USER-008 · 用户管理权限隔离

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** U1 无 user.manage；READADMIN 只有 user.read
- **步骤：** 1) 分别读用户列表；2) 直接请求创建、重置和状态修改。
- **预期结果：** 普通用户无管理读权限；只读管理员可读但不能写；前端隐藏按钮不能替代后端拒绝。

<a id="module-acl"></a>

### ACL — 多用户、多邮箱与权限隔离

**源码依据：** [authorizer.ts](../../apps/worker/src/modules/tenancy/authorizer.ts)、[mailboxes.ts](../../apps/worker/src/http/routes/mailboxes.ts)、[messages.ts](../../apps/worker/src/http/routes/messages.ts)、[attachments.ts](../../apps/worker/src/http/routes/attachments.ts)、[MailboxMembersPage.tsx](../../apps/web/src/features/mailbox/MailboxMembersPage.tsx)

**留证要求：** 每个角色的请求矩阵、授权行、列表截图及失败响应；记录被测试的 mailboxId/messageId。

#### QA-ACL-001 · 跨域邮箱创建与规范化

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** D1A/D1B active；U1 有 mailbox.create
- **步骤：** 1) API 在两域各建 qa-one；2) 同域重复大小写地址；3) 无权限用户及 inactive 域重试。
- **预期结果：** 同 localPart 不同域可并存；同域不得重复；无权限/无效域被拒；owner 为当前用户，不能由 body 冒充。

#### QA-ACL-002 · 仅列出拥有或被授权的邮箱

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** U1 有 M1，U2 有 M2，MSH 共享给 U1
- **步骤：** 1) U1/U2/ADMIN 分别打开邮箱列表；2) 请求列表 API。
- **预期结果：** 各自仅看到 owner/member 邮箱；全局管理员没有默认内容访问权。

#### QA-ACL-003 · 邮箱角色权限矩阵

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** MSH 配 OWNER、VIEWER、SENDER、MADMIN；全局权限按第 3 节准备
- **步骤：** 1) 按权限表逐一读邮件/附件、发信、读写草稿、管理成员；2) 对比 D1。
- **预期结果：** viewer 可读内容及改个人状态；sender/admin 可发；读写邮件仍需全局 read/send。实际成员接口仅 owner 或全局 mailbox.share 可管理，mailbox admin 单独不足。

#### QA-ACL-004 · 全局管理员不得越权读邮箱

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+B
- **前置条件：** ADMIN 不是 M1 owner/member
- **步骤：** 1) 直接访问 M1 列表、详情、线程、草稿、下载和 send URL；2) 加 grant 后再试；3) 撤销 grant 后再试。
- **预期结果：** 无 grant 全部拒绝；grant 后只开放对应能力；撤销后立即按 D1 拒绝，不能靠旧前端缓存继续取数据。

#### QA-ACL-005 · 交换路径 ID 防越权

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** U1 仅授权 M1；M2 有邮件、附件、草稿
- **步骤：** 1) 将 M2 的 messageId/attachmentId 放进 M1 URL；2) 反向交换 mailboxId；3) 修改 draftId。
- **预期结果：** 不得返回他人正文、元数据、字节或可用下载链接；无越权写入；错误不暴露内容。

#### QA-ACL-006 · 新增既有用户共享

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** OWNER 打开 MSH 成员管理
- **步骤：** 1) 输入 U2 邮箱并选择 viewer/sender/admin 分别测试；2) U2 重新请求列表；3) 删除 grant。
- **预期结果：** 授权用户可见共享邮箱且权限匹配；删除后服务端访问失效；成员响应无凭据。

#### QA-ACL-007 · 成员输入和重复操作

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** MSH owner 登录
- **步骤：** 1) 测无效/不存在用户、重复成员、owner 自加入或自移除；2) 取消删除确认；3) 模拟请求失败。
- **预期结果：** 不产生多余成员行或破坏 owner；取消不发送删除；失败保留行/输入并可重试，不显示虚假成功。

#### QA-ACL-008 · 个人已读、星标和软删除隔离

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+B
- **前置条件：** U1/U2 都可读 MSH 同一封邮件
- **步骤：** 1) U1 标已读、加星并删除；2) U2 查看；3) U1 再取正文/附件。
- **预期结果：** U2 状态和内容不受影响；U1 软删除后普通详情/下载不可继续取；不是全邮箱永久删除。

#### QA-ACL-009 · 全局权限和成员管理例外

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 准备缺 message.read/send 的成员，以及非成员 SHAREADMIN 持 mailbox.share
- **步骤：** 1) 测内容读写；2) SHAREADMIN 管理 M1 成员；3) 再直接读 M1 内容；4) 查审计。
- **预期结果：** 内容读写需全局权限加 grant；SHAREADMIN 可管理成员但无直接内容权限；授权行为完整审计。此为成员服务的独立规则，不套用 authorizer 注释。

#### QA-ACL-010 · 撤销授权时的在途请求

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** SENDER 正在 MSH 写信/保存草稿，另会话撤销 grant
- **步骤：** 1) 撤销后提交/上传；2) 切换到 U2；3) 检查缓存及响应。
- **预期结果：** 后续请求重新鉴权并拒绝；错误可见且不误报已发送；账号切换不暴露前用户草稿/附件。

<a id="module-domain"></a>

### DOMAIN — 域名与发信连接

**源码依据：** [admin-domains.ts](../../apps/worker/src/http/routes/admin-domains.ts)、[domain-administration-service.ts](../../apps/worker/src/modules/admin/domain-administration-service.ts)、[connection-resolver.ts](../../apps/worker/src/modules/outbound-mail/connection-resolver.ts)、[ConnectionsPage.tsx](../../apps/web/src/features/admin/ConnectionsPage.tsx)

**留证要求：** 域名与连接脱敏配置、版本条件、投递日志、D1 关联及审计记录。

#### QA-DOMAIN-001 · 域名新增和输入校验

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** ADMIN 管理域名
- **步骤：** 1) 新增两个测试域；2) 提交大写/空格变体、重复域、URL/含路径/无效域；3) 刷新。
- **预期结果：** 合法域规范化存储且不重复；无效格式不写入；成功/失败提示与响应一致。

#### QA-DOMAIN-002 · 域名人工确认与实际验证区分

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / B+P
- **前置条件：** 一个配置正确域、一个 DNS/Email Routing 不完整域
- **步骤：** 1) 分别执行域名页确认；2) 核对返回 verified 和审计事件；3) 核对 DNS、目标 Worker 和真实收信。
- **预期结果：** 当前接口只记录 operator confirmation，不能当作自动 DNS/provider 检查通过；两者证据独立记录；未配置域的人工确认不得用于签署真实收信通过。

#### QA-DOMAIN-003 · 域名绑定各自连接

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** D1A→C1、D1B→C2，两连接 active
- **步骤：** 1) 绑定并刷新；2) 各域创建 compose/draft job；3) 对比 outbound_jobs.connection_id。
- **预期结果：** 各域使用自己的连接；不会选择第一个 active connection；修改有审计。

#### QA-DOMAIN-004 · 连接绑定非法对象

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 不存在、inactive 域/连接和未注册 provider 夹具
- **步骤：** 1) 依次尝试绑定；2) 构造已有 job 指向失效连接；3) 触发消费。
- **预期结果：** 非法绑定拒绝或不可发送；无效/未注册连接的 job 终止并留错误；不偷换至其他域的连接。

#### QA-DOMAIN-005 · 域名绑定并发控制

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** 两会话持有相同 updatedAt
- **步骤：** 1) A 保存 C1；2) B 用旧 If-Match 保存 C2；3) B 刷新后重试。
- **预期结果：** 旧版本返回冲突，不能覆盖 A；界面可刷新并保留可解释状态；同键重试无重复副作用。

#### QA-DOMAIN-006 · 删除域名的依赖保护

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** 无引用域、仅含签名的域、有邮箱引用的域各一个
- **步骤：** 1) 取消删除；2) 删除前两类；3) 尝试删除有邮箱域。
- **预期结果：** 取消无请求；无邮箱域可删，关联签名按 FK 级联清除；有邮箱引用时拒绝；无悬空邮箱/签名。

#### QA-DOMAIN-007 · 连接列表与密钥展示

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** ADMIN、无管理权限 U1
- **步骤：** 1) 读取 /admin/connections；2) ADMIN 确认 reveal webhook secret；3) 隐藏/切页；4) U1 直接调用 reveal。
- **预期结果：** 列表没有明文秘密；显式 reveal 才显示且有审计，隐藏后移除；未授权请求拒绝；API key 不泄漏。

#### QA-DOMAIN-008 · 多域真实独立投递

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / P
- **前置条件：** D1A/C1 与 D1B/C2 都完成 DNS/Brevo 配置
- **步骤：** 1) 两域同时向 EXT1 发不同标识邮件；2) 外部回复；3) 核对收件和 provider 日志。
- **预期结果：** From、域名、连接和 mailbox 正确对应；两域收发互不串用；外部原始头可验证 SPF/DKIM/DMARC 配置。

<a id="module-admin"></a>

### ADMIN — 角色、签名、系统设置与审计

**源码依据：** [admin-roles.ts](../../apps/worker/src/http/routes/admin-roles.ts)、[admin-signatures.ts](../../apps/worker/src/http/routes/admin-signatures.ts)、[admin-settings.ts](../../apps/worker/src/http/routes/admin-settings.ts)、[admin-blocklist.ts](../../apps/worker/src/http/routes/admin-blocklist.ts)、[admin-role-policies.ts](../../apps/worker/src/http/routes/admin-role-policies.ts)、[SettingsPage.tsx](../../apps/web/src/features/admin/SettingsPage.tsx)

**留证要求：** 管理页面、脱敏 API、D1 修订号和审计事件；策略另留入站拒绝证据。

#### QA-ADMIN-001 · 自定义角色增改删

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** ADMIN；无用户引用的 QA 角色
- **步骤：** 1) 新建名称/描述/权限集；2) 修改后刷新；3) 取消、确认删除。
- **预期结果：** 定义和权限列表准确持久化；取消不删除；真实删除同步列表；未知/重复权限键或越界值被拒绝。

#### QA-ADMIN-002 · 系统角色和已引用角色保护

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+B
- **前置条件：** 系统角色及已有用户引用的自定义角色
- **步骤：** 1) 尝试改写/删除受保护系统角色；2) 删除已引用自定义角色。
- **预期结果：** 服务端按约束拒绝；不造成现有用户失去必要系统权限或悬空 role 引用；前端说明失败原因。

#### QA-ADMIN-003 · 角色策略与黑名单接口

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** ADMIN；角色分配由测试夹具准备
- **步骤：** 1) 通过 API 添加 exact-email、@domain、* banEmail 与 availDomain；2) 加/删 blocklist；3) 发送命中和不命中的入站样本。
- **预期结果：** 保存值与读取一致；策略按 envelope sender/收件域执行；非法/重复规则拒绝；移除规则后正常恢复。

#### QA-ADMIN-004 · 域名签名 CRUD 和净化

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** D1A active
- **步骤：** 1) 创建纯文本+HTML 签名；2) 更新/禁用；3) 重复创建同域签名；4) 删除。
- **预期结果：** 每域签名唯一；HTML 被净化；启停/删除持久化且有审计；此例不证明自动追加到发信正文。

#### QA-ADMIN-005 · 签名跨域和并发保护

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+B
- **前置条件：** 两个域的签名及旧 updatedAt
- **步骤：** 1) 修改另一 signatureId/domainId；2) 用旧 If-Match 修改；3) 以只读账号写入。
- **预期结果：** 非法归属、过期版本和无写权限请求被拒绝；不覆盖其他域签名。

#### QA-ADMIN-006 · 系统设置保存与契约边界

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** ADMIN；记录原设置
- **步骤：** 1) 修改 siteTitle 和合法数值并刷新；2) 测 mailbox 0/1/100/101、attachment count 0/1/10/11、byte 0/1/67108864/67108865；3) 恢复原值。
- **预期结果：** 合法范围可保存，越界被拒绝；只允许已定义字段；这是持久化验收，运行时效果另见 GAP。

#### QA-ADMIN-007 · 设置保留期、并发和只读

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / A+B
- **前置条件：** READADMIN 有 settings.read；两 ADMIN 会话
- **步骤：** 1) 测 retention days 0/1/3650/3651、hours 0/1/168/169；2) 两会话用相同版本保存；3) READADMIN 写入。
- **预期结果：** 范围校验一致；旧版本返回 412 STALE_IF_MATCH，可刷新；只读不可写；错误不抹去当前编辑。

#### QA-ADMIN-008 · 设置不能重开公开注册

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** ADMIN 请求 registrationEnabled=true，并附未知 secret 字段
- **步骤：** 1) 单独测试 true 值；2) 再测试未知字段；3) 调用注册 API。
- **预期结果：** 注册仍关闭，读取为 false；未知字段被拒；不能借设置接口读写 provider secret。

#### QA-ADMIN-009 · 审计过滤和稳定分页

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** 至少 55 条不同 actor/resource/action 审计
- **步骤：** 1) 单项及组合过滤；2) 前后翻页；3) 篡改游标并恢复；4) 模拟后台刷新失败。
- **预期结果：** 结果满足过滤且顺序稳定；无重复漏页；错误保留已有数据并可重新开始；不泄漏其他未授权面板数据。

#### QA-ADMIN-010 · 审计关联、脱敏与重放

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 完成用户、域名、角色、签名、设置各一次变更
- **步骤：** 1) 按 requestId 查审计；2) 同键重放；3) 对关键写入注入审计失败。
- **预期结果：** actor/action/resource 可追踪；审计无凭据；同键无重复业务写入；声明原子操作的写入与审计一起回滚。

<a id="module-in"></a>

### IN — Cloudflare 收信与 MIME 解析

**源码依据：** [inbound-email.ts](../../apps/worker/src/entrypoints/inbound-email.ts)、[index.ts](../../packages/email-core/src/index.ts)、[inbound-attachment-repository.ts](../../apps/worker/src/modules/messages/inbound-attachment-repository.ts)、[inbound-email.worker.test.ts](../../apps/worker/src/entrypoints/inbound-email.worker.test.ts)

**留证要求：** 原始 .eml 样本及 SHA-256、envelope 参数、Worker 日志、D1/R2 记录、收件截图。

#### QA-IN-001 · 真实纯文本和 HTML 入站

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / P+B
- **前置条件：** D1A 路由到 preview；M1 active
- **步骤：** 1) EXT1 发中文主题、emoji、纯文本一封；2) 发 HTML 一封；3) 在 M1 查读。
- **预期结果：** 两封均经 Cloudflare Email Routing 入库；主题、正文、From/To/Cc 无乱码；仅相应授权用户可读。

#### QA-IN-002 · 按 envelope recipient 投递

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L+A
- **前置条件：** M1/M2 都是本地邮箱；夹具 envelope to=M1、MIME To=M2
- **步骤：** 1) 注入该邮件；2) 查两邮箱关联；3) 再以 envelope to=M2 独立投递。
- **预期结果：** 第一次仅 M1 收到；MIME To 不能添加 M2 关联；第二次按它自身 envelope 路由。

#### QA-IN-003 · Bcc 信封收件人

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / L+P
- **前置条件：** M1 不出现在 MIME To/Cc，但 envelope 指向 M1
- **步骤：** 1) 通过外部邮件客户端 Bcc M1；2) 对比正文头和邮箱关联。
- **预期结果：** M1 能收到；系统不因 To/Cc 缺失而丢弃；不将其他隐藏收件人额外暴露。

#### QA-IN-004 · 未知及不可用收件人

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / L+P
- **前置条件：** 未知地址、非 active 域/邮箱夹具、正常 M1
- **步骤：** 1) 对各地址发信；2) 对比拒收结果与 D1/R2；3) 正常地址作对照。
- **预期结果：** 未知/不可用收件人不产生可读业务邮件；默认明确拒收；正常邮箱不受影响；store 未知收件策略另列缺口。

#### QA-IN-005 · 策略使用 envelope sender

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L+A
- **前置条件：** envelope sender 被禁，MIME From 伪装为允许地址；再交换二者
- **步骤：** 1) 注入两种样本；2) 查询 policy 决策及 D1 写入。
- **预期结果：** 按 envelope sender 判定；不能利用 MIME From 绕过 banEmail/blocklist；拒绝路径无业务写入。

#### QA-IN-006 · 嵌套 MIME 和编码

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / L+B
- **前置条件：** T-MIME 样本集合
- **步骤：** 1) 导入 multipart/mixed+alternative+related、base64、quoted-printable、中英文编码头；2) 打开详情及附件。
- **预期结果：** 文本/HTML 正确选择和解码；附件边界无串入正文；文件名、类型、字节和 content-id 可对应原样本。

#### QA-IN-007 · 原始邮件和附件完整性

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / L+P
- **前置条件：** 含 PNG/PDF/零字节附件及重名附件样本
- **步骤：** 1) 收信；2) 对比 raw-mime 和 inbound-attachment 对象；3) 下载后逐个校验 SHA-256。
- **预期结果：** 原始 MIME 按原字节保存；解码附件各有独立 ID/元数据；合法零字节入站附件不因上传限制被误判；无重名覆盖。

#### QA-IN-008 · 重复 Message-ID 与重投

- **优先级 / 实现状态 / 执行环境：** P1 / 待实测风险 / L+A
- **前置条件：** 同一原始邮件两次回调，另有同 Message-ID 不同内容样本
- **步骤：** 1) 同 envelope 重投；2) 分别投到两邮箱；3) 统计消息、关联和对象。
- **预期结果：** 不得跨用户混信或覆盖原文；记录当前重复策略及计数；若形成重复收件且无定义的去重策略，登记缺陷/待决策，不能凭一次投递通过。

#### QA-IN-009 · 线程关联与缺失头

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / L+B
- **前置条件：** 同 mailbox 的 root/reply、缺 Message-ID、引用不存在及跨邮箱 root 样本
- **步骤：** 1) 依次入站；2) 查看 thread API；3) 直接打开每封。
- **预期结果：** 正常回复能关联；缺失/未知头仍可独立读；跨邮箱不可泄漏其他邮件；线程顺序稳定。

#### QA-IN-010 · 入站存储失败

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L
- **前置条件：** 本地故障夹具，分别模拟 R2 put、D1 batch 失败
- **步骤：** 1) 触发入站；2) 检查调用返回/日志；3) 查询 messages、关联、附件与 R2。
- **预期结果：** 失败被抛出，不能报告成功并丢信；无对用户可见的半条邮件；无法立即回滚的对象可由孤儿清理回收。

#### QA-IN-011 · 畸形 MIME 和容量边界

- **优先级 / 实现状态 / 执行环境：** P1 / 待实测风险 / L+P
- **前置条件：** 受控大小递增与损坏 MIME 样本，不向第三方泛发
- **步骤：** 1) 测断边界、坏编码、超多 part、长头及超大邮件；2) 记录平台/应用拒绝点、耗时和内存。
- **预期结果：** 不越权、不产生损坏可见邮件或无限处理；失败可追踪；可接受上限须形成文档，不能把 5 MiB 上传限制当成入站限制。

<a id="module-mail"></a>

### MAIL — 邮箱列表、详情、线程与个人状态

**源码依据：** [InboxListPage.tsx](../../apps/web/src/features/mailbox/InboxListPage.tsx)、[MessageDetailPage.tsx](../../apps/web/src/features/mailbox/MessageDetailPage.tsx)、[messages.ts](../../apps/worker/src/http/routes/messages.ts)、[message-read-repository.ts](../../apps/worker/src/modules/messages/message-read-repository.ts)

**留证要求：** 页面截图、消息列表/详情响应、message_states 前后值、游标和网络记录。

#### QA-MAIL-001 · 列表、空状态与多页

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** M1 至少 55 封邮件，其中两封相同时间；另有空邮箱
- **步骤：** 1) 查看空邮箱；2) M1 加载全部页；3) 与 D1 可见集比较。
- **预期结果：** 空态不报错；默认 inbox；顺序和游标稳定；重复时间邮件不遗漏/重复；摘要和未读/星标准确。

#### QA-MAIL-002 · 文件夹视图与隔离

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** 为 inbox/sent/drafts/archive/trash 准备已有数据
- **步骤：** 1) 依次切换 folder；2) 刷新；3) 用其他 folder 的 cursor 请求。
- **预期结果：** 只显示当前用户该文件夹可见数据；跨 folder 游标不可复用；有视图不代表归档、恢复或永久删除操作已完成。

#### QA-MAIL-003 · 详情字段和 Cc

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B
- **前置条件：** 含多个 To/Cc、HTML/纯文本、附件的入站邮件
- **步骤：** 1) 打开详情；2) 展开 headers；3) 对照原始邮件。
- **预期结果：** 主题、From、To、Cc、正文与时间准确；Cc 位于收件信息处，无 Cc 时不显示假值；头默认折叠且仅安全文本展示。

#### QA-MAIL-004 · 打开邮件标已读

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** U1 的未读邮件，U2 也可读
- **步骤：** 1) 打开详情、重渲染、返回列表再进入；2) U2 查看。
- **预期结果：** 首次标记成功后列表/详情同步；重开不反复写入；U2 未读状态保持；写失败不抹去可读正文。

#### QA-MAIL-005 · 星标和失败回滚

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** 同一邮件两个用户
- **步骤：** 1) U1 加星/取消；2) 模拟请求失败；3) U2 查看；4) 刷新 U1。
- **预期结果：** U1 状态按成功响应更新，失败可重试；不会误改 U2；刷新与服务端一致。

#### QA-MAIL-006 · 个人删除及 Trash

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** U1 已读且加星的一封邮件，U2 同时可读
- **步骤：** 1) 取消删除确认；2) 确认删除；3) 刷新 inbox/trash；4) 请求详情/附件。
- **预期结果：** 取消无写入；成功 204 空 body 被客户端正确处理；U1 进 Trash 且保留个人状态；普通正文/下载受删除状态保护；U2 可见性不变。

#### QA-MAIL-007 · 线程顺序及跳转

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** M1 内含三封同线程邮件及无关邮件
- **步骤：** 1) 打开中间一封；2) 点击前后成员；3) 使 thread 请求失败。
- **预期结果：** 线程从旧到新、当前项高亮；跳转正确且各自标读；线程失败仍能读正文并单独重试。

#### QA-MAIL-008 · 列表后台错误恢复

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** 已有两页缓存
- **步骤：** 1) 后台刷新/加载更多返回 500；2) 恢复网络重试；3) 篡改 cursor 后点 Start over。
- **预期结果：** 原有列表保留且错误可见；重试成功；坏游标清空旧分页链后从首页重新开始，无死循环。

#### QA-MAIL-009 · 详情不存在、删除及伪造响应

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** 缺失 messageId；已删除邮件；返回与请求 ID 不符的测试响应
- **步骤：** 1) 分别加载；2) 切换另一个 mailboxId；3) 检查旧正文残留。
- **预期结果：** 明确错误/不可用状态；不展示错邮件或上一封缓存正文；无非授权元数据残留。

<a id="module-send"></a>

### SEND — 写信与回复

**源码依据：** [ComposeEmail.tsx](../../apps/web/src/features/mailbox/ComposeEmail.tsx)、[compose.ts](../../apps/worker/src/http/routes/compose.ts)、[index.ts](../../packages/contracts/src/index.ts)、[brevo.ts](../../apps/worker/src/integrations/providers/brevo.ts)

**留证要求：** 表单截图、请求/202 响应、message/job ID、D1 记录；真实项另附外部 .eml 和 provider 日志。

#### QA-SEND-001 · 正常写信到外部邮箱

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / B+P
- **前置条件：** U1 有 M1 send 权限，C1 有效
- **步骤：** 1) 填 To/Cc、主题、纯文本；2) 发送；3) 跟踪 Queue/Brevo/EXT1；4) 刷新 Sent。
- **预期结果：** 只创建一条逻辑消息；202 只表示 queued；provider 接受与外部实际收到分别有证据；收件内容和 From 正确。

#### QA-SEND-002 · To/Cc 解析和非法地址

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** 写信页
- **步骤：** 1) 测缺 To、混入非法地址、大小写、尾逗号和连续逗号；2) 修正后提交。
- **预期结果：** 无效值阻止提交并定位字段；合法地址规范化；分隔符不形成空收件人；Cc 不被丢失。

#### QA-SEND-003 · 主题与正文边界

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** 本地表单和 API 夹具
- **步骤：** 1) UI 测空/空白主题、998/999 字符、空正文及 1000001 字符正文；2) API 测总 JSON 1 MiB 边界及多字节中文。
- **预期结果：** UI 主题非空且不超 998；空正文允许；超限被拒；API 总字节上限可先于字段字符上限触发。API 允许空主题的差异需记录。

#### QA-SEND-004 · 连续点击及重试

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** 延迟发送响应
- **步骤：** 1) 快速点击两次；2) 明确拒绝一次后重试；3) 对比幂等键及 job 数。
- **预期结果：** pending 期间只提交一次；明确失败保留内容；手动重试为新尝试；无误报成功。响应丢失的重复风险另测 OUT。

#### QA-SEND-005 · compose 幂等与并发

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 相同 user/mailbox/body、固定 Idempotency-Key
- **步骤：** 1) 串行及并发提交相同请求；2) 同键修改收件人或主题；3) 检查 message/job/audit。
- **预期结果：** 同键同体返回相同 messageId 且只有一套业务记录；同键不同体冲突；不重复发出队列业务。

#### QA-SEND-006 · 发件人不可伪造

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** U1 仅能 send M1
- **步骤：** 1) 请求添加伪造 from/owner/connection 字段；2) 改成 M2 mailboxId；3) 对照实际 job 和 provider payload。
- **预期结果：** 身份、发件地址和连接由授权邮箱解析；不能按客户端字段冒用他人邮箱或其他连接。

#### QA-SEND-007 · 回复及 RFC 线程头

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / B+P
- **前置条件：** M1 有来自 EXT1 的邮件
- **步骤：** 1) 点 Reply；2) 检查 To、主题、引用正文；3) 发送并读取外部原始头。
- **预期结果：** 回复指向正确发件人；In-Reply-To/References 对应父邮件；无非授权父邮件内容；真实外部线程可关联。

#### QA-SEND-008 · 回复错误与上下文清理

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** 回复页已填写内容
- **步骤：** 1) 让父邮件后台读取失败；2) 首次发送失败后重试；3) 成功后直接写第二封新邮件。
- **预期结果：** 后台错误/失败重试保留正文和回复头；成功后第二封不带上一封 threading headers。

#### QA-SEND-009 · D1 提交与 Queue 发布失败

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 本地分别注入 D1 batch 失败、Queue send 失败
- **步骤：** 1) 请求 compose；2) 查 message/recipients/job/idempotency；3) 恢复 Queue 并触发回收。
- **预期结果：** D1 失败整体回滚；D1 已提交而 Queue 失败时 durable job 不丢失，可恢复；不产生无 job 的已接受邮件。

<a id="module-draft"></a>

### DRAFT — 服务端草稿与本地恢复

**源码依据：** [drafts.ts](../../apps/worker/src/http/routes/drafts.ts)、[DraftRecoveryPage.tsx](../../apps/web/src/features/mailbox/DraftRecoveryPage.tsx)、[draft-cache.ts](../../apps/web/src/lib/draft-cache.ts)、[index.ts](../../packages/contracts/src/index.ts)

**留证要求：** draft API、If-Match 版本、编辑状态、脱敏 IndexedDB 和 job 对照；离线步骤记录断网时点。

#### QA-DRAFT-001 · 创建草稿并打开编辑

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+B
- **前置条件：** U1 有 M1 send 权限
- **步骤：** 1) POST drafts 创建空 to、subject、body_text；2) 保存 draftId；3) 打开 /mailbox/M1/draft/draftId。
- **预期结果：** 服务端 status=draft；页面 To/Cc/Bcc/主题/正文可编辑；创建入口当前通过 API，不能假定 compose 有保存按钮。

#### QA-DRAFT-002 · 草稿字段边界

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / A+L
- **前置条件：** 使用 create/update contracts
- **步骤：** 1) 测 subject 998/999、text 65536/65537、HTML 131072/131073；2) 每类收件人 50/51；3) 空 to 与未知字段。
- **预期结果：** 边界内草稿可存，超限/未知字段拒绝；允许暂时无 To；不能套用 compose 的对象收件人结构，草稿为字符串数组。

#### QA-DRAFT-003 · 自动保存防抖与顺序

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** 已有服务端草稿
- **步骤：** 1) 连续快速编辑；2) 延迟首次 PATCH 并继续输入；3) 刷新。
- **预期结果：** 保存使用最近文本，写入串行；下一次 If-Match 基于上一响应；刷新为最后成功版本，无旧响应覆盖新输入。

#### QA-DRAFT-004 · 双标签页版本冲突

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** 两个窗口打开同一 draft 版本
- **步骤：** 1) A 保存；2) B 提交旧 If-Match；3) B 选择载入服务端版本。
- **预期结果：** B 收到 412 STALE_IF_MATCH；本地输入不被静默覆盖；加载新版本成功后才丢弃冲突副本。

#### QA-DRAFT-005 · 断网及保存失败恢复

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B
- **前置条件：** 草稿已有本地副本
- **步骤：** 1) 修改并断网触发保存；2) 恢复网络点击重试；3) 刷新草稿。
- **预期结果：** 失败可见，编辑值保留；重试保存当前内容；失败不能显示 Saved；可恢复副本按服务器版本比较。

#### QA-DRAFT-006 · 本地副本取舍与账号隔离

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B
- **前置条件：** 本地分别准备领先/落后/相同版本副本；另有 U2 数据
- **步骤：** 1) 重开草稿；2) 选择恢复本地或载入服务器；3) 退出后登录 U2。
- **预期结果：** 提示与版本关系一致；只有明确选择才覆盖编辑；U2 不看到 U1 副本；本地副本无 auth headers/token。

#### QA-DRAFT-007 · 草稿发送一次性与 Bcc

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** API 草稿含 To/Cc/Bcc，send 权限有效
- **步骤：** 1) POST draft send；2) 重放同键及换键再发送；3) 查看 provider payload 和消息状态。
- **预期结果：** 同一草稿仅转 queued 一次；重复不创建新逻辑邮件；Bcc 正确给 provider 且不出现在其他收件人的公开头；真实外部证据另执行预览。

#### QA-DRAFT-008 · 草稿跨邮箱和授权回收

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+B
- **前置条件：** M1 草稿且 U1 随后失去 grant
- **步骤：** 1) 在 M2 路径放 M1 draftId；2) 撤销后读、PATCH、send；3) 回页。
- **预期结果：** 所有错归属/无权限访问拒绝；不展示错草稿；旧本地内容不成为绕过服务端授权的依据。

#### QA-DRAFT-009 · 离页与损坏本地存储

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B
- **前置条件：** 编辑有未触发防抖；IndexedDB 不可用夹具
- **步骤：** 1) 编辑后立即切页；2) 返回；3) 用不可用/损坏本地存储再保存。
- **预期结果：** 离页取消待执行防抖且不写入另一草稿；明确显示最后成功保存版本；本地同步失败可见，服务器成功不被误判为丢失。

<a id="module-att"></a>

### ATT — 附件上传、消费、下载与 CID

**源码依据：** [attachments.ts](../../packages/contracts/src/attachments.ts)、[attachments.ts](../../apps/worker/src/http/routes/attachments.ts)、[download-attachment.ts](../../apps/worker/src/modules/attachments/download-attachment.ts)、[MessageAttachments.tsx](../../apps/web/src/features/mailbox/MessageAttachments.tsx)、[use-inline-attachment-urls.ts](../../apps/web/src/features/mailbox/use-inline-attachment-urls.ts)

**留证要求：** 二进制 SHA-256、附件元数据、脱敏请求响应头、R2/上传生命周期、浏览器网络记录。

#### QA-ATT-001 · 上传和元数据校验

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** M1 send 用户；T-FILE 样本
- **步骤：** 1) binary POST attachments/uploads；2) 检查 uploadId、mailboxId、size、expiresAt；3) 测缺失/非法 X-Filename、Content-Type、disposition。
- **预期结果：** 合法上传有匹配元数据；文件名 1–255 且无 NUL/CR/LF；媒体类型/枚举合法；失败不留可消费的虚假上传。

#### QA-ATT-002 · 上传大小与伪造长度

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 0、1、5242880、5242881 字节文件
- **步骤：** 1) 分别上传；2) 伪造 Content-Length 或省略；3) 检查实际字节。
- **预期结果：** 上传必须非空且不超过 5 MiB；同时校验实际长度，不能靠伪造头绕过；该限制不等同入站附件限制。

#### QA-ATT-003 · 附件数量和重复 ID

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 准备 11 个有效上传
- **步骤：** 1) compose 使用 10 个；2) 使用 11 个；3) 同 uploadId 重复两次。
- **预期结果：** 10 个符合当前契约；11 个/重复 ID 拒绝且不部分消费；设置页更大 byte 值不改变 5 MiB 上传硬限制。

#### QA-ATT-004 · 附件归属、到期和缺失

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 外用户、外邮箱、超过一小时、已消费、KV 缺失 uploadId
- **步骤：** 1) 分别用于 compose/send；2) 对比错误和消息表。
- **预期结果：** 都不可被未授权消费；失败有统一安全错误，不泄漏真实归属；不得产生部分邮件或消费其他有效附件。

#### QA-ATT-005 · 同一上传竞争消费

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** 两个并发 compose 使用同一 uploadId、不同幂等键
- **步骤：** 1) 同时发送；2) 查关联、upload status、job；3) 下载成功方附件。
- **预期结果：** 最多一封消费成功；失败方不遗留可发送半成品；成功方字节完整。

#### QA-ATT-006 · 消费后 R2 持久性

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / A+P
- **前置条件：** 成功发送的附件已拷到 R2
- **步骤：** 1) 等上传 TTL 过期并清理 staging；2) 下载；3) 在独立故障环境模拟 Queue 重试读取。
- **预期结果：** 已关联附件继续可下载和供发送使用；不会因一小时 KV 到期丢失；R2 字节与原文件哈希一致。

#### QA-ATT-007 · 浏览器鉴权下载

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / B+P
- **前置条件：** U1 有包含附件的邮件，Bearer 只在内存
- **步骤：** 1) 点击下载；2) 检查请求 Authorization；3) 核对保存文件；4) 未登录直接打开下载 URL。
- **预期结果：** 经授权 binary fetch 下载成功；直接 URL 无凭据不可读；token 不放查询参数；文件名/字节正确。

#### QA-ATT-008 · 下载响应隔离与坏对象

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** HTML/SVG/正常 PDF，缺失或长度不符 R2 对象
- **步骤：** 1) 请求下载查看响应头；2) 测坏对象。
- **预期结果：** Content-Disposition 为 attachment，有 nosniff、private no-store、CSP sandbox；缺失/长度异常明确失败，不返回截断成功文件或内联执行 HTML。

#### QA-ATT-009 · CID 内联图片

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / B+P
- **前置条件：** 同邮件带合法 raster CID、SVG CID、未匹配 CID、外部/data/blob 图片
- **步骤：** 1) 打开详情；2) 查看图片和网络；3) 导航到其他邮件。
- **预期结果：** 仅授权附件中的允许 raster CID 可形成页面生成的 Blob URL；其余不加载；没有第三方追踪请求。

#### QA-ATT-010 · CID 错误、撤销和资源释放

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B
- **前置条件：** 延迟附件 fetch、缺失 CID 对象、切换账号
- **步骤：** 1) 加载时离页或切邮件；2) 再返回；3) 退出切账号；4) 观察 URL 回收。
- **预期结果：** 晚到结果不注入另一封邮件；旧 object URL 在切换/卸载撤销；失败不影响安全正文；不把前用户图片留给后用户。

<a id="module-out"></a>

### OUT — Queue、Brevo 与发送可靠性

**源码依据：** [queue.ts](../../apps/worker/src/entrypoints/queue.ts)、[process-outbound-job.ts](../../apps/worker/src/modules/outbound-mail/process-outbound-job.ts)、[reclaim-stale-jobs.ts](../../apps/worker/src/modules/outbound-mail/reclaim-stale-jobs.ts)、[outbox-config.ts](../../apps/worker/src/platform/outbox-config.ts)、[brevo.ts](../../apps/worker/src/integrations/providers/brevo.ts)

**留证要求：** job 状态/attempts/lease/lock、provider 请求摘要及日志；重复发送必须有外部收件计数。

#### QA-OUT-001 · 消费成功与重复投递

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / L+P
- **前置条件：** 一个 queued job，绑定 C1
- **步骤：** 1) 触发消费；2) 重投同一 Queue 消息；3) 查 provider 调用和 job。
- **预期结果：** job/message 正确前进并保存 provider ID；已 sent/terminal 的 job 不重新发送；真实预览确认外部仅一封。

#### QA-OUT-002 · 并发 claim 和旧 worker 回写

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L
- **前置条件：** 同 job 两 consumer；可控延迟 provider
- **步骤：** 1) 同时 claim；2) 让第一 worker lease 过期被回收；3) 第一 worker 晚到成功。
- **预期结果：** 有效 lease 只由一个 worker 持有；旧 lock 不能覆盖新状态；重复外部副作用仍需 provider 幂等实测。

#### QA-OUT-003 · 临时失败和终止失败分类

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L
- **前置条件：** provider 夹具返回 429/500/网络断开/401/400
- **步骤：** 1) 对每个新 job 注入一种结果；2) 消费；3) 恢复后重试。
- **预期结果：** 429/5xx/网络问题按预算重试；永久 4xx 首次终止；attempts 和错误码可解释；没有无限重试。

#### QA-OUT-004 · 重试预算耗尽

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / L
- **前置条件：** job.max_attempts 已知，provider 一直失败
- **步骤：** 1) 重复消费至预算；2) 再投相同任务。
- **预期结果：** 到 job 预算即 failed 并停止 provider 调用；区分 D1 业务预算与 Queue max_retries=5，不能混作一次计数。

#### QA-OUT-005 · 超时 lease 与孤立 queued 恢复

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / L+P
- **前置条件：** sending 超过 60 秒；queued 超过 5 分钟，各有新鲜对照项
- **步骤：** 1) 触发 Cron；2) 恢复 Queue；3) 跟踪完成。
- **预期结果：** 过期项重新排队；新鲜 lease/queued 不被抢占；最终状态可追踪，真实重复投递无重复邮件。

#### QA-OUT-006 · provider 成功后 D1 写失败

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / L+P
- **前置条件：** 故障环境及专用外部收件箱
- **步骤：** 1) Brevo 接受后模拟本地成功回写失败；2) 回收并重试；3) 对比同一 message 的 provider 幂等键与外部数量。
- **预期结果：** 重试沿用 canonical message ID 对应的相同键；D1 最终收敛；必须用真实 provider 证据证明不重复，mock 调用次数不够。

#### QA-OUT-007 · 解密和附件读取失败

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L
- **前置条件：** 错误加密 key、缺失/损坏已消费附件的独立夹具
- **步骤：** 1) 消费 job；2) 检查 provider 是否被调用；3) 修复后重试。
- **预期结果：** 不能用错误凭据或缺附件发送残缺邮件；失败进入可追踪重试/终止状态；日志无 secret/正文泄漏。

#### QA-OUT-008 · 发送响应丢失后的手动重试

- **优先级 / 实现状态 / 执行环境：** P0 / 待实测风险 / B+P
- **前置条件：** 客户端到 API 的响应可被代理丢弃，服务端已创建 job
- **步骤：** 1) 提交后丢弃响应；2) UI 手动重试；3) 对比两个请求键、D1 和 EXT1 数量。
- **预期结果：** 目标是不能因结果不明静默重发；当前 UI 新键重试可能产生第二封，必须记录实际结果并提缺陷，不能当作同键后端幂等已覆盖。

#### QA-OUT-009 · 排队后连接配置变化

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，需真实环境 / L+P
- **前置条件：** job 已固定 C1，随后域改绑 C2；另准备 C1 停用
- **步骤：** 1) 延迟消费后改绑；2) 消费旧/新 job；3) 停用 C1 后再消费其 job。
- **预期结果：** 旧 job 仍按自身连接解析，新 job 用新绑定；停用连接按终止规则处理，不静默迁移到其他账号。

<a id="module-hook"></a>

### HOOK — Webhook 验签、状态与事件回放

**源码依据：** [webhooks.ts](../../apps/worker/src/http/routes/webhooks.ts)、[brevo-webhook.ts](../../apps/worker/src/integrations/providers/brevo-webhook.ts)、[webhook-processor.ts](../../apps/worker/src/modules/outbound-mail/webhook-processor.ts)、[reconcile-webhook-deliveries.ts](../../apps/worker/src/modules/outbound-mail/reconcile-webhook-deliveries.ts)、[WebhookEventsPage.tsx](../../apps/web/src/features/admin/WebhookEventsPage.tsx)

**留证要求：** 签名已脱敏的原始字节样本、webhook delivery、message/job/audit 前后状态和 provider 实际事件。

#### QA-HOOK-001 · 验签必须基于原始字节

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L+A
- **前置条件：** 测试 secret 和合法 JSON body，仅本地夹具
- **步骤：** 1) 按原字节生成 HMAC-SHA256 hex，放 X-Webhook-Signature；2) 去头、改签名、改空白字节后重投。
- **预期结果：** 合法签名才可处理；缺失/无效为 401；JSON 等价但字节不同也拒绝；非法请求不能推进邮件状态。

#### QA-HOOK-002 · 真实 Brevo webhook 契约

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / P
- **前置条件：** 真实 C1 的测试事件和回调配置
- **步骤：** 1) 触发真实 delivered/受控 bounce；2) 捕获实际头和 body；3) 对照 adapter 接口。
- **预期结果：** 真实事件能够合法验签、解析并关联消息；若 provider 不提供当前预期签名或字段，记阻塞缺陷，不能自签一份 JSON 代替证明。

#### QA-HOOK-003 · 跨连接和 provider 隔离

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L+A
- **前置条件：** C1/C2 使用不同 secret，有相同 provider message ID 的夹具
- **步骤：** 1) C1 签名发到 C2 URL；2) 错 providerKey；3) 正确组合重试。
- **预期结果：** 错误组合拒绝或不推进目标消息；查找包含 connection/provider 约束，不能仅凭 provider message ID 修改别的邮箱。

#### QA-HOOK-004 · 格式错误与未知事件

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / L+A
- **前置条件：** 合法签名的坏 UTF-8、坏 JSON、数组、缺 messageId、unknown event
- **步骤：** 1) 逐一提交；2) 查 delivery 和消息状态。
- **预期结果：** 错误结构受控拒绝；未知/不完整事件按实现留存或忽略，但不误推进消息；错误响应无堆栈/secret。

#### QA-HOOK-005 · 事件映射和不倒退

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L+A
- **前置条件：** 每个样本使用独立 message；另一个测试乱序
- **步骤：** 1) 投 delivered、bounce/hard_bounce/soft_bounce、spam/complaint、delayed/blocked；2) 按逆序重投状态。
- **预期结果：** 映射到 delivered/bounced/complained/delayed；按状态机允许边推进；旧/低优先事件不能把已确认终态退回 queued/sending。

#### QA-HOOK-006 · 早到事件及旧数据回放

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L+A
- **前置条件：** webhook 早于 provider ID 回写；含 0027 迁移旧行
- **步骤：** 1) 先处理事件；2) 回写 job provider ID；3) 执行 reconcile；4) 再执行一次。
- **预期结果：** 事件持久可匹配并恢复状态；使用通用 provider ID/status 投影；重复回放不导致状态倒退或跨连接关联。

#### QA-HOOK-007 · Webhook 写入原子性

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L
- **前置条件：** 有可推进状态事件，本地注入 audit/delivery 写失败
- **步骤：** 1) 处理事件；2) 比较 message 状态、delivery、audit；3) 重试。
- **预期结果：** 状态、投递记录、审计同批成功或回滚；失败不留下无证据的状态推进。

#### QA-HOOK-008 · UTC 事件时间与来源

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / L+A
- **前置条件：** ts 为秒/毫秒、带时区字符串、缺失/非法/无时区时间
- **步骤：** 1) 处理各事件；2) 查看 event time 和 source；3) 对照接收时刻。
- **预期结果：** 合法 provider 时间归一 UTC；无法识别时标记 source=server，不能伪称 provider 时间；事件时间与接收时间含义独立。

#### QA-HOOK-009 · Webhook 列表查看和分页

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B+A
- **前置条件：** 多连接、多事件、超过一页数据
- **步骤：** 1) 打开管理列表并翻页；2) 使后续页失败；3) 用普通用户直接读 API。
- **预期结果：** 状态/连接/时间可核对；加载失败保留已有页并可重试；未授权拒绝；不展示 signing secret。

#### QA-HOOK-010 · 完全相同事件重投

- **优先级 / 实现状态 / 执行环境：** P0 / 待实测风险 / L+P
- **前置条件：** 记录一份可验证的真实 event 样本和 ID
- **步骤：** 1) 串行和并发投递同一事件三次；2) 比较状态、审计、delivery 行数。
- **预期结果：** 目标为事件级去重且状态不倒退；当前事件级幂等仍有缺口，分别记录状态幂等与事件行去重，不能只看最终状态正确。

<a id="module-data"></a>

### DATA — UTC、数据持久性与定时清理

**源码依据：** [LocalDateTime.tsx](../../apps/web/src/components/ui/LocalDateTime.tsx)、[scheduled.ts](../../apps/worker/src/entrypoints/scheduled.ts)、[expire-attachments.ts](../../apps/worker/src/modules/attachments/expire-attachments.ts)、[sweep-inbound-objects.ts](../../apps/worker/src/modules/messages/sweep-inbound-objects.ts)、[inbound-object-repository.ts](../../apps/worker/src/modules/messages/inbound-object-repository.ts)

**留证要求：** UTC D1 行、浏览器时区截图、Cron requestId、清理前后对象清单/哈希和扫描游标。

#### QA-DATA-001 · UTC 存储与本地显示

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+A
- **前置条件：** 同一瞬间 2026-10-06T00:30:00Z；浏览器 UTC/上海/洛杉矶
- **步骤：** 1) 创建/读取邮件与审计；2) 更换时区；3) 比对 API/D1 与 time[datetime]。
- **预期结果：** D1/API 表示同一 UTC 瞬间；上海显示 08:30，洛杉矶为前日 17:30；UI 变时区不改数据库，不双加 8 小时。

#### QA-DATA-002 · 时间格式、跨年和夏令时

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B
- **前置条件：** 裸 UTC SQL 时间、Z、明确 offset；2026-11-01T08:30Z/09:30Z
- **步骤：** 1) 在洛杉矶展示两次 01:30；2) 测跨年、日期值与非法/空值。
- **预期结果：** 不同瞬间保持各自 UTC datetime 和顺序；无时区 SQL 值按 UTC 解释；非法值不导致崩溃；无历史发送时间回填依赖。

#### QA-DATA-003 · 过期未消费上传清理

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / L+P
- **前置条件：** 超过一小时的 uploaded 行，另有未过期和 consumed 对照
- **步骤：** 1) 触发 Cron；2) 查 KV/R2/D1/审计；3) 再执行。
- **预期结果：** 仅过期未消费上传变 expired，字节清除；已消费不删；重复执行不重复业务审计。

#### QA-DATA-004 · 上传清理故障可重试

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L
- **前置条件：** 分别让 D1/audit 和 KV/R2 delete 失败
- **步骤：** 1) 执行 expire；2) 恢复故障后再执行；3) 比较字节和状态。
- **预期结果：** D1 失败不先删字节；字节删除失败可后续重试；不把 consumed 附件作为过期 staging 删除。

#### QA-DATA-005 · 入站孤儿对象 24 小时保护

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / L+P
- **前置条件：** 两前缀各有 23h59m、恰好24h、24h以上对象，含 D1 引用对照
- **步骤：** 1) 固定本地时钟执行；2) preview 使用自然老化对象验证；3) 查结果。
- **预期结果：** 仅严格超过 24h 且无 D1 引用对象删除；恰好24h、新对象、有引用对象保留；soft delete 不是物理删除引用。

#### QA-DATA-006 · 有界扫描与跨页游标

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，需真实环境 / L+P
- **前置条件：** raw-mime 与 inbound-attachment 各 205 个对象，混入其他前缀
- **步骤：** 1) 连续触发多次 Cron；2) 记录每轮 list 和 KV startAfter；3) 扫到末尾后重新扫描。
- **预期结果：** 每轮每个前缀最多 100 个；游标推进且周期结束可重扫；其他前缀不删；最终没有永久漏页。

#### QA-DATA-007 · 孤儿清理 D1 与 R2 故障

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L
- **前置条件：** 超过 24h 的引用/无引用对象
- **步骤：** 1) D1 引用查询失败；2) 单对象 delete 失败；3) KV 游标读写失败；4) 恢复重跑。
- **预期结果：** 无法查引用时不删除；单对象失败可在后续循环重试；游标故障不得扩大删除范围；失败可观测，保留有引用对象。

#### QA-DATA-008 · 数据重启/重部署后可读

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / L+P
- **前置条件：** M1 有 inbound raw、附件、草稿和 sent
- **步骤：** 1) 重启/重部署；2) 清浏览器缓存再登录；3) 核对数量与哈希。
- **预期结果：** D1/R2 权威数据仍在；不依赖某次 Worker 内存或某浏览器缓存才能读邮件。

#### QA-DATA-009 · Cron 子任务失败的连带影响

- **优先级 / 实现状态 / 执行环境：** P1 / 待实测风险 / L+P
- **前置条件：** 分别让 reclaim、expire、sweep 出错
- **步骤：** 1) 触发同一轮 scheduled；2) 观察后续任务是否执行；3) 恢复后再次触发。
- **预期结果：** 失败必须被发现并最终恢复；记录当前顺序执行下是否阻断后续任务及最长积压；不能把单任务本地通过当作整轮可用。

<a id="module-sec"></a>

### SEC — 安全与接口异常

**源码依据：** [sanitize-message-html.ts](../../apps/web/src/features/mailbox/sanitize-message-html.ts)、[body-size.ts](../../apps/worker/src/http/middleware/body-size.ts)、[idempotency.ts](../../apps/worker/src/http/middleware/idempotency.ts)、[authz.ts](../../apps/worker/src/http/middleware/authz.ts)、[crypto.ts](../../apps/worker/src/platform/crypto.ts)

**留证要求：** 无敏感值的攻击样本、响应状态/请求关联号、浏览器网络与存储观察；仅在隔离环境使用。

#### QA-SEC-001 · 邮件正文与管理文本 XSS

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B
- **前置条件：** T-XSS：script、onerror、javascript 链接、iframe/form/svg/style；用户/域名/签名恶意文本
- **步骤：** 1) 保存/接收夹具；2) 列表和详情渲染；3) 点击允许链接。
- **预期结果：** 脚本和危险 DOM 不执行；用户文本不变 HTML；危险 URL 不导航；允许 http/https/mailto 链接仍可用且外链防 opener 劫持。

#### QA-SEC-002 · 远程追踪及令牌外泄

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / B+P
- **前置条件：** 邮件中 remote img/srcset/CSS url/data/blob/伪 CID
- **步骤：** 1) 打开并滚动详情；2) 查看全部网络请求；3) 点击普通外部链接。
- **预期结果：** 不自动请求追踪资源；授权头只发送给应用受信 API；URL、Referer 和错误日志中没有 access token。

#### QA-SEC-003 · API 无效输入与未知字段

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** JSON API、ID、cursor、If-Match、文件名测试集合
- **步骤：** 1) 发送坏 JSON/非法 UUID/过期签名 cursor/缺键/未知字段；2) 检查响应及 D1。
- **预期结果：** 稳定 4xx 和可追踪 requestId；不执行拼接注入，不泄漏 SQL/堆栈；被拒写入无副作用；未知字段按各契约 strict/strip 规则处理。

#### QA-SEC-004 · 跨用户幂等键与游标签名

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / A+L
- **前置条件：** U1/U2 使用同 key；M1/M2 和不同列表游标
- **步骤：** 1) 跨用户、操作、邮箱重用 key；2) 篡改 cursor payload；3) 跨列表使用 cursor。
- **预期结果：** 重放作用域不泄漏另一用户结果；游标签名/资源作用域校验；不把 A 的写结果当成 B 成功。

#### QA-SEC-005 · 跨站请求与 CORS

- **优先级 / 实现状态 / 执行环境：** P0 / 待实测风险 / A+P
- **前置条件：** 第二个受控测试 origin，已登录 U1
- **步骤：** 1) 从外站尝试 refresh/logout 和业务 POST；2) 请求带 credentials；3) 检查 OPTIONS、SameSite 与返回可读性。
- **预期结果：** 外站不能读取凭据/邮件或完成未授权业务写入；Cookie 行为与 CORS 共同满足隔离；异常需作为安全缺陷，不预设已有防护。

#### QA-SEC-006 · 秘密加密和脱敏

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，可测 / L+A
- **前置条件：** 配置测试 provider key，触发一次成功和一次失败
- **步骤：** 1) 查看 connections、settings、users、audit API；2) 检查 D1 credential 存储和日志；3) 错 key 解密。
- **预期结果：** 密码按哈希存储、provider credential 不为明文；列表和日志不暴露秘密；错误 key 受控失败；显式 reveal 单独授权审计。

#### QA-SEC-007 · 强制改密覆盖所有写入口

- **优先级 / 实现状态 / 执行环境：** P0 / 待实测风险 / A+L
- **前置条件：** mustChangePassword 用户拥有邮箱或被测试夹具授予 mailbox.share
- **步骤：** 1) 不改密直接发信/保存/上传；2) 直接新增、删除 mailbox member；3) 比较 D1。
- **预期结果：** 所有业务写入都应被阻止；成员接口走独立鉴权，必须单测，若绕过则登记 P0 缺陷。

#### QA-SEC-008 · 登录滥用与请求资源控制

- **优先级 / 实现状态 / 执行环境：** P1 / 待实测风险 / A+P
- **前置条件：** 约定小规模限流阈值、受控 preview 账号
- **步骤：** 1) 固定次数错误登录和并发请求；2) 逐步增大 body/上传；3) 检查延迟、429/4xx、日志。
- **预期结果：** 有可观测的滥用控制或明确发布前缺口；大 body 受控拒绝；普通用户不被无限重试拖垮；禁止无上限压测。

#### QA-SEC-009 · 邮件头注入和恶意文件名

- **优先级 / 实现状态 / 执行环境：** P0 / 待实测风险 / A+L
- **前置条件：** subject、displayName、inReplyTo/references 含 CR/LF 的输入；路径样式附件名
- **步骤：** 1) 逐字段调用 compose/draft/upload；2) 捕获 adapter payload 或原始 MIME；3) 检查实际收件列表和下载响应。
- **预期结果：** 输入被拒或安全编码，不能注入额外 Bcc/From/头字段；文件名不能形成响应头注入或越界写路径；无额外收件人。

<a id="module-ux"></a>

### UX — 界面、浏览器、可访问性与性能

**源码依据：** [AdminLayout.tsx](../../apps/web/src/components/layouts/AdminLayout.tsx)、[MailboxLayout.tsx](../../apps/web/src/components/layouts/MailboxLayout.tsx)、[Table.tsx](../../apps/web/src/components/ui/Table.tsx)、[admin-kit-theme.css](../../apps/web/src/styles/admin-kit-theme.css)、[router.tsx](../../apps/web/src/app/router.tsx)、[13-shadcn-admin-kit-adoption.md](../../docs/rebuild/13-shadcn-admin-kit-adoption.md)

**留证要求：** 浏览器/版本/视口/主题/时区、截图、键盘记录、网络性能和控制台错误；性能保存样本数及分位数。

#### QA-UX-001 · 管理端与邮箱端分区

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / B+P
- **前置条件：** ADMIN/U1/READADMIN 三种账号
- **步骤：** 1) 访问 /admin 与 /mailbox；2) 直接打开受限子路由；3) 切换账号。
- **预期结果：** 两套布局和导航清楚；U1 不进入管理内容；只读权限与可操作项一致；浏览器 guard 与 API 权限共同生效。

#### QA-UX-002 · 桌面与窄屏完整操作

- **优先级 / 实现状态 / 执行环境：** P1 / 待实测风险 / B
- **前置条件：** 1440、1024、768、390、320 px；邮件主题/邮箱/文件名很长
- **步骤：** 1) 遍历管理列表、详情、写信、草稿、成员页；2) 执行主要操作；3) 检查溢出。
- **预期结果：** 无页面级横向溢出/裁剪；主要按钮可点且长文本可辨；窄屏优先多行卡片和换行动作；当前表格局部滚动应记录为设计迁移差异。

#### QA-UX-003 · 浅色、深色与主题保持

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B
- **前置条件：** 管理/邮箱所有路由
- **步骤：** 1) 切换主题并刷新；2) 检查表格、输入、错误、disabled、邮件正文。
- **预期结果：** 主题一致并按已有设置保持；文字/焦点/错误可辨；邮件 HTML 不覆盖应用样式或使内容不可读。

#### QA-UX-004 · 键盘、焦点和读屏

- **优先级 / 实现状态 / 执行环境：** P1 / 待实测风险 / B
- **前置条件：** 仅键盘及 VoiceOver/NVDA 可用
- **步骤：** 1) Tab 完成登录、写信和确认弹窗；2) 触发字段错误；3) 操作局部滚动表格；4) 200% 缩放。
- **预期结果：** 焦点可见、顺序合理、不困住；弹窗关闭回原触发点；label/错误可读；缩放后操作和信息不丢失。

#### QA-UX-005 · 浏览器兼容

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，需真实环境 / B+P
- **前置条件：** 当前稳定 Chrome、Edge、Firefox、Safari，iOS Safari/Android Chrome
- **步骤：** 1) 各执行第 6 节核心流程；2) 检查 cookie、草稿 IndexedDB、Blob 下载和 CID；3) 记录版本。
- **预期结果：** 核心流程可完成；不支持的能力有可恢复提示；无未处理 JS 错误或只在某浏览器失效的认证。

#### QA-UX-006 · 加载、空、错、重试、会话过期

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B
- **前置条件：** 列表/详情/管理/成员/草稿各一页，模拟慢网和 4xx/5xx
- **步骤：** 1) 逐一进入；2) 后台刷新失败；3) 重新登录/重试。
- **预期结果：** 加载不显示假空态；空态有解释；错误能恢复；已有数据在后台失败时保留；403 不误当无数据。

#### QA-UX-007 · 操作反馈和确认

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，可测 / B
- **前置条件：** 删除用户状态/域名/角色/签名/成员/邮件等现有操作
- **步骤：** 1) 取消确认；2) 双击提交；3) 注入失败；4) 成功后刷新。
- **预期结果：** 取消不写入；pending 避免重复；失败保留状态/输入；成功后列表同步，不要求靠刷新才能确认。

#### QA-UX-008 · 性能建议基线

- **优先级 / 实现状态 / 执行环境：** P1 / 待实测风险 / B+P
- **前置条件：** 1 万封 M1、50 个测试用户、10 个域；预热后 20 并发读，先经环境负责人约定
- **步骤：** 1) 采集 100 次列表/详情请求；2) 记录 p50/p95/错误率；3) 浏览器 4G 档测首屏和翻页。
- **预期结果：** 建议 API p95≤1s、非注入错误率<1%、首屏可操作≤3s、翻页≤1s；超标记性能待评估；这些是建议门槛，非既有 SLA。

#### QA-UX-009 · 大邮件和长列表渲染

- **优先级 / 实现状态 / 执行环境：** P1 / 待实测风险 / B+P
- **前置条件：** 大正文、20 条线程、50 条当前页、多个 CID
- **步骤：** 1) 打开和来回切换 30 次；2) 观察交互、内存及网络；3) 关闭页面。
- **预期结果：** 无持续明显卡死、泄漏增长或重复无限下载；敏感字节随对象 URL 生命周期释放；记录实际耗时，不用构建包大小代替体验证据。

<a id="module-ops"></a>

### OPS — 端到端验收、运维与恢复

**源码依据：** [worker.ts](../../apps/worker/src/worker.ts)、[scheduled.ts](../../apps/worker/src/entrypoints/scheduled.ts)、[12-cloud-mail-agentic-inbox-integration-plan.md](../../docs/rebuild/12-cloud-mail-agentic-inbox-integration-plan.md)、[deploy.ts](../../scripts/deploy.ts)

**留证要求：** 本轮执行清单、外部 .eml、D1/R2 摘要、Queue/Cron/provider/浏览器证据与缺陷清单；记录 UTC 起止。

#### QA-OPS-001 · 完整邮件往返闭环

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / P+B
- **前置条件：** ADMIN 建 U1；U1 改密；测试域 C1 已就绪
- **步骤：** 1) API 为 U1 建 M1；2) EXT1→M1 含 Cc/CID/PDF；3) U1 读、下载并回复；4) EXT1 回信；5) 查看线程及状态。
- **预期结果：** 账号、权限、Email Routing、R2、UI、Queue、Brevo、webhook 全链路有同一邮件标识；外部收到和内部状态均可核验；UI 缺口另列不能隐藏。

#### QA-OPS-002 · 多用户多域并行闭环

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / P+B
- **前置条件：** U1/M1/D1A/C1 与 U2/M2/D1B/C2，MSH grant 夹具
- **步骤：** 1) 两用户并行收发；2) 在 MSH 共享读写；3) 撤销 U2 grant；4) 反查所有关联。
- **预期结果：** 域名/连接/用户不串用；授权后能力正确、撤销后阻断；个人状态不互相覆盖；没有跨邮箱附件暴露。

#### QA-OPS-003 · 监控与故障定位

- **优先级 / 实现状态 / 执行环境：** P0 / 已有代码，需真实环境 / P
- **前置条件：** 一个受控 provider 失败 job 和一个 R2 读失败样本
- **步骤：** 1) 从 UI 错误记录 requestId/messageId；2) 关联 Worker、D1、Queue 和审计；3) 执行已定义恢复路径。
- **预期结果：** 能定位到唯一资源及失败阶段；无秘密泄漏；恢复后有闭环结果；缺告警或无恢复入口须记运维缺口。

#### QA-OPS-004 · 备份恢复演练

- **优先级 / 实现状态 / 执行环境：** P0 / 待实测风险 / L+P
- **前置条件：** 独立恢复环境；D1、R2 和加密密钥恢复方案已准备
- **步骤：** 1) 记录源数据/hash；2) 备份并恢复到独立资源；3) 校验授权、邮件、附件、待发 job；4) 测试连接。
- **预期结果：** 可恢复完整业务数据及解密能力；不会恢复后向真实用户重复发信；记录 RPO/RTO，未约定前建议 RPO≤24h、RTO≤4h 待确认。

#### QA-OPS-005 · 发布与回滚演练

- **优先级 / 实现状态 / 执行环境：** P0 / 待实测风险 / P
- **前置条件：** 发布工件、兼容性说明和数据库备份
- **步骤：** 1) 部署冻结版本；2) 验证核心流程；3) 按前向 schema 兼容策略回退 worker/web；4) 再验收。
- **预期结果：** 不盲目回退 D1 schema；旧/新代码兼容性有证据；数据和队列未丢失；无法回滚须提前明确替代恢复方法。

#### QA-OPS-006 · 测试清理与资源核销

- **优先级 / 实现状态 / 执行环境：** P1 / 已有代码，需真实环境 / L+P
- **前置条件：** 执行结束，证据已脱敏留存
- **步骤：** 1) 仅删除 RUN_ID 对应测试账号/域/对象；2) 撤销测试 token；3) 恢复临时配置；4) 查待发队列。
- **预期结果：** 不影响其他测试批次；无误投待发邮件和遗留临时凭据；有引用对象不直接当孤儿删除；保留可重现证据。

<a id="module-gap"></a>

### GAP — 尚未闭合的产品能力与专项验收

**源码依据：** [12-cloud-mail-agentic-inbox-integration-plan.md](../../docs/rebuild/12-cloud-mail-agentic-inbox-integration-plan.md)、[13-shadcn-admin-kit-adoption.md](../../docs/rebuild/13-shadcn-admin-kit-adoption.md)、[14-durable-object-mailbox-adr.md](../../docs/rebuild/14-durable-object-mailbox-adr.md)、[ComposeEmail.tsx](../../apps/web/src/features/mailbox/ComposeEmail.tsx)、[DraftRecoveryPage.tsx](../../apps/web/src/features/mailbox/DraftRecoveryPage.tsx)、[SettingsPage.tsx](../../apps/web/src/features/admin/SettingsPage.tsx)、[provider-registry.ts](../../apps/worker/src/integrations/providers/provider-registry.ts)

**留证要求：** 补齐前登记关联缺口/需求，不填写通过；补齐后保存 UI/API/真实环境证据，并回归对应主模块。

#### QA-GAP-001 · 邮箱创建、重命名和删除的产品入口

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / B+A
- **前置条件：** 当前列表已有，创建为 API；完整生命周期 UI 未闭合
- **步骤：** 补齐后：1) admin/获权用户在界面创建两域邮箱；2) 改名；3) 删除有数据邮箱前确认影响并执行定义的策略。
- **预期结果：** 管理员统一管理和授权的流程可由产品界面完成；不要求用户输入内部 UUID；删除保留/清理策略明确且不损害其他邮箱。

#### QA-GAP-002 · 普通写信页上传附件与 Bcc

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / B+A+P
- **前置条件：** 上传/发送附件后端已有；compose UI 未接
- **步骤：** 补齐后：1) UI 添加/移除文件及 Bcc；2) 测上传失败、过期、重试和数量上限；3) 外部核对附件哈希及 Bcc 私密性。
- **预期结果：** 前端闭环与 ATT 契约一致；未上传成功不能假装带附件发送；其他收件人看不到 Bcc。

#### QA-GAP-003 · 写信保存草稿与草稿发送 UI

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / B+A
- **前置条件：** 草稿 API 和编辑恢复页已有；compose 创建/草稿发送按钮未闭合
- **步骤：** 补齐后：1) 写信保存；2) 刷新从 Drafts 继续；3) 点发送并检查一次性转换。
- **预期结果：** 无需 API 夹具完成创建→保存→恢复→发送；失败保留内容，成功消除可重复发送的草稿入口。

#### QA-GAP-004 · Reply-all 与 Forward

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / B+P
- **前置条件：** 当前 UI 只有基本 Reply
- **步骤：** 补齐后：1) 用多 To/Cc 邮件回复全部，移除自己并去重；2) 转发正文、附件、CID；3) 外部对照。
- **预期结果：** 收件范围可见且无隐含 Bcc 泄漏；转发内容与附件授权正确；不继承不应存在的回复线程头。

#### QA-GAP-005 · 统一收件箱与搜索

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / B+A
- **前置条件：** 当前单邮箱分页，未见完整全局搜索入口/API
- **步骤：** 补齐后：1) 按发件人、收件人、主题、正文和域名查找；2) 在多个共享邮箱中查相同词；3) 撤销 grant 后再查。
- **预期结果：** 结果仅含当前授权及未删除范围；条件/分页可恢复；不存在跨用户搜索泄漏。搜索范围须在实现时明确。

#### QA-GAP-006 · 归档、恢复与永久删除操作

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / B+A
- **前置条件：** 已有 folder 视图和个人软删除；完整变更动作未见
- **步骤：** 补齐后：1) 归档再恢复；2) Trash 恢复；3) 按明确策略永久删除；4) U2 对照。
- **预期结果：** 操作有确认/恢复提示；状态与文件夹一致；个人与全局删除边界清楚，不误删共享邮件和 R2 引用。

#### QA-GAP-007 · 角色分配与管理员账号管理闭环

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / B+A
- **前置条件：** 角色定义 CRUD 已有，用户角色分配 UI/API 未闭合
- **步骤：** 补齐后：1) ADMIN 分配/撤销自定义角色；2) 旧 session 再请求；3) 测最后管理员保护与并发。
- **预期结果：** 权限变动在后续请求生效且有审计；不能因并发/误操作失去所有管理员；测试夹具赋权不能替代产品交付。

#### QA-GAP-008 · 黑名单与角色策略管理 UI

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / B+A
- **前置条件：** API 已有，无独立可见管理页面
- **步骤：** 补齐后：1) UI 新增/移除规则；2) 测重复和错误格式；3) 注入 envelope 命中/不命中样本。
- **预期结果：** 规则可管理和解释，实际拒收与设置一致；无邀请流程回流。

#### QA-GAP-009 · 域名签名自动用于发送

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / B+A+P
- **前置条件：** 签名 CRUD 已有，compose/draft/send 路径未见调用 findEnabledSignature
- **步骤：** 补齐后：1) 启用域 A 签名后普通发信/回复/草稿发送；2) 域 B 对照；3) 禁用后再发。
- **预期结果：** 只附相应域启用的净化签名，最多一次；正文/API/provider/外部原文一致；CRUD 通过不能替代此项。

#### QA-GAP-010 · 系统开关和限额实际生效

- **优先级 / 实现状态 / 执行环境：** P0 / 已知缺口，待补齐 / A+P
- **前置条件：** 设置页明确仅存储 policy；运行时读取未闭合
- **步骤：** 补齐后：1) 分别关闭 inbound/outbound；2) 降低 mailbox/附件数量和字节限额；3) 执行边界业务；4) 恢复设置。
- **预期结果：** 关闭确实阻止对应新业务，既有 queued 如何处理有定义；限额在服务端执行；保存成功不能当成限制已生效。

#### QA-GAP-011 · 未知收件策略和 retention 执行

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / A+P
- **前置条件：** unknownRecipientPolicy=store、audit/idempotency retention 仅有设置
- **步骤：** 补齐后：1) 切 store/reject 并发未知收件；2) 固定时钟跨 retention；3) 触发清理并复查。
- **预期结果：** store 目标和授权明确，不能投进随机邮箱；清理按期限且保留必要审计/重放保护；关闭公开注册不受该设置影响。

#### QA-GAP-012 · Webhook 事件级幂等

- **优先级 / 实现状态 / 执行环境：** P0 / 已知缺口，待补齐 / L+P
- **前置条件：** 真实 provider 事件 ID 及契约待确认
- **步骤：** 补齐后：1) 用同一真实事件 ID 串行/并发重投；2) 用不同 ID 同状态事件对照；3) 故障回放。
- **预期结果：** 同事件只产生一次业务效果和定义的去重记录；不同合法事件不误去重；跨连接 ID 不冲突；与 HOOK-010 联验。

#### QA-GAP-013 · 邮件来源证据和伪造标记

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / L+P
- **前置条件：** 当前策略用 envelope，但来源/Authentication-Results 持久化与 UI 未闭合
- **步骤：** 补齐后：1) 收正常和伪造 From 样本；2) 比较 envelope、Return-Path、认证结果；3) UI 查看风险。
- **预期结果：** 声明 From 与可信来源分开；原始来源可审计；不把邮件自带伪造 Authentication-Results 当可信认证结论。

#### QA-GAP-014 · 已关联对象的删除与保留策略

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / A+P
- **前置条件：** 孤儿扫描已有，已关联 raw/附件保留未形成完整策略
- **步骤：** 补齐后：1) 个人软删、全体删除、账号删除及超保留期分别执行；2) 扫描；3) 验证其他用户仍引用的对象。
- **预期结果：** 只有达到约定物理删除条件才删；共享引用不丢失；raw 与解码附件生命周期一致可追踪；孤儿24h规则不能代替邮件保留策略。

#### QA-GAP-015 · 连接生命周期、同步和健康状态

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / B+A+P
- **前置条件：** 当前连接列表/reveal、setup Brevo 与域绑定已有；完整新增/轮换/停用/健康 UI 未闭合
- **步骤：** 补齐后：1) 建第二连接；2) 轮换凭据；3) provider 不可用再恢复；4) 查看在途 job 行为。
- **预期结果：** 无需修改数据库完成常规运维；健康不误报；在途任务绑定规则可解释；旧秘密不再可用且新秘密不泄漏。

#### QA-GAP-016 · 第二个 SMTP/provider adapter

- **优先级 / 实现状态 / 执行环境：** P2 / 已知缺口，待补齐 / L+A+P
- **前置条件：** V1 先 Brevo；SMTP adapter 尚未注册，后续扩展验收
- **步骤：** 实现后：1) 注册第二 adapter 并按域绑定；2) 验证 TLS、认证、收件、附件及错误归类；3) 并发与重试；4) 回归 Brevo。
- **预期结果：** 通过通用 provider 契约接入；不将 SMTP 凭据传给 Brevo；SMTP 无天然幂等时必须给出重复投递处理方案；本轮不要求伪装已支持。

#### QA-GAP-017 · 完整 UI 基座与中英文体验

- **优先级 / 实现状态 / 执行环境：** P1 / 已知缺口，待补齐 / B
- **前置条件：** 当前 shell/token/部分 Table 采用 shadcn-admin-kit，广泛原语/文案迁移未完成
- **步骤：** 补齐后：1) 遍历全部页面控件；2) 切语言、主题、窄屏；3) 核对 upstream 许可留存。
- **预期结果：** 管理与邮箱操作风格统一；若交付中英文则所有业务文案完整；移动端按多行卡片/换行动作验收；基础 token 接入不等于完整 UI 完成。

#### QA-GAP-018 · Durable Object 架构边界

- **优先级 / 实现状态 / 执行环境：** P2 / 已有代码，可测 / L+P
- **前置条件：** 当前版本按 ADR 以 D1/R2/Queue 为主
- **步骤：** 1) 检查绑定、代码路径与运行数据；2) 确认无每邮箱 DO 主存储依赖；3) 如提案启用 DO，另提供容量/实时性证据。
- **预期结果：** 当前验收不要求创建 mailbox DO；DO 仅未来协调/实时连接候选，启用必须另做设计和迁移验收，不能当成本版缺失邮箱存储。

## 6. 首轮冒烟清单

按以下顺序执行。破坏性和失效测试使用独立账号/邮件，避免影响下一项。

| 顺序 | 用例 | 首轮要证明什么 |
| --- | --- | --- |
| 1 | QA-ENV-001、003、008 | schema/绑定/静态资源可用 |
| 2 | QA-ENV-004 | 新部署完成真实安装；已有部署另起空环境测试 |
| 3 | QA-USER-001、QA-AUTH-003、001、008 | admin 建号、首次改密、刷新恢复、退出 |
| 4 | QA-ACL-001、002、004、005 | 多域建邮箱、列表和跨邮箱隔离 |
| 5 | QA-DOMAIN-003、008 | 两域绑定不同连接并真实投递 |
| 6 | QA-IN-001、002、003、007 | 真实入站、envelope、Bcc、MIME 字节 |
| 7 | QA-MAIL-003、004、006、QA-ACL-008 | 详情、个人状态和共享用户隔离 |
| 8 | QA-ATT-007、009、QA-SEC-001、002 | 鉴权下载、CID 与恶意内容隔离 |
| 9 | QA-SEND-001、007、QA-OUT-001 | 发信、回复和队列去重 |
| 10 | QA-HOOK-002、003、006 | 真实事件契约、跨连接、早到回放 |
| 11 | QA-DRAFT-001、003、004、007 | API 建草稿、编辑、冲突、一次发送 |
| 12 | QA-DATA-001、005、QA-USER-004、QA-SEC-007 | UTC、对象保护、禁用和强制改密边界 |
| 13 | QA-OPS-001、002 | 双用户双域的完整邮件往返 |

任何关联 P0 失败时，该业务闭环不能标通过。即使冒烟全部通过，完整功能、异常和 GAP 用例仍需执行或明确范围处理。

## 7. 执行记录、缺陷与验收判定

### 7.1 执行结果

CSV 已带：用例 ID、模块、标题、优先级、实现状态、方式/环境、前置、步骤、预期、证据要求、源码，以及
**RUN_ID、变体、构建版本、环境地址、执行人、执行时间UTC、执行结果、实际结果、证据链接、缺陷编号、复测结果、备注**。

| 结果 | 使用条件 |
| --- | --- |
| 未执行 | 尚未运行；本文件初始全部如此 |
| 通过 | 所有适用变体满足预期，要求的层级证据齐全 |
| 失败 | 实际行为不满足预期；包含可复现的当前未实现功能 |
| 阻塞 | 缺账号、域、凭据、环境、上游能力或前置功能，当前无法执行 |
| 不适用 | 明确属于本轮范围之外，写明依据、负责人及日期；不能用于隐藏未完成功能 |

不要把“mock 通过、preview 未执行”合并成“通过”；拆变体记录。
通过率计算为 `通过 / (通过 + 失败)`，同时报告计划总数、未执行数、阻塞数、不适用数及范围依据。
只报通过率可能掩盖大量未执行或缺口，因此不单独用于发布判断。

### 7.2 缺陷记录模板

```text
缺陷编号 / 标题：
严重度 / 对应用例 ID / 变体：
RUN_ID / 构建 / 环境 / 浏览器：
用户角色 / mailboxId / messageId / requestId（不填 secret）：
前置与最小复现步骤：
预期结果：
实际结果 / 发生次数与总尝试次数：
影响范围 / 是否阻塞收发或造成数据泄漏、丢失、重复投递：
证据链接：
修复负责人 / 修复版本：
复测结果 / 相关回归用例 / 复核人：
```

严重度与用例优先级分开：S0=跨用户数据泄漏/广泛丢失/系统不可用；S1=核心收发、身份、恢复失败或重复发送；
S2=有替代路径的功能问题；S3=不影响业务的展示问题。安全或数据问题不能因低复现率降低严重度。

### 7.3 退出标准

- 本轮适用 P0/P1 全部执行；P0 全过，无未关闭 S0/S1；其他问题有明确修复或有记录的范围决定。
- 正常身份、双用户双域权限、真实 Email Routing→R2→浏览器→Queue→Brevo→外部邮箱/webhook 全链路具备本轮证据。
- 权限撤销、附件安全、幂等/重复发送、时间及数据清理的关键边界通过；依赖凭据缺失不属于功能通过。
- GAP 中 P0/P1 属于完整邮箱交付的待闭合项。没有补齐或正式调整范围时，只能出“阶段验收”，不能给“整个项目已完成”的结论。
- SMTP 后续 adapter 与 DO 主存储不作为 V1 必须实现项；分别按扩展计划和已确认 ADR 记录。
- 备份恢复/发布回退有可执行方案及演练证据；性能门槛和上线容量由项目负责人记录确认，本文建议值不是承诺。

### 7.4 验收报告模板

```text
版本 / RUN_ID / 时间范围：
本轮范围 / 经确认的排除项：
计划用例数 / 变体数：
通过 / 失败 / 阻塞 / 未执行 / 不适用：
P0 结果 / 未关闭 S0-S1：
本地自动检查证据：
本地浏览器证据：
真实 Cloudflare/Brevo/外部邮件证据：
关键缺陷与 GAP 关闭情况：
恢复/回退与性能结果：
结论：可发布 / 阶段通过但不可发布 / 不通过
遗留项、负责人、目标版本与复核人：
```

## 8. 自动检查与手工验收的衔接

以下为仓库现有命令入口，**本次编写用例没有运行这些应用检查**。在冻结版本和隔离环境中逐步执行，记录实际日志；
需要本机端口/worker runtime 权限时应按真实执行结果注明阻塞。

```sh
pnpm typecheck
pnpm test:unit
pnpm test:worker
pnpm lint
pnpm format:check
pnpm build
```

`test:worker` 包括 Worker 和 test-kit Worker 项目；构建包含 Worker dry-run，不是部署成功证据。
类型与构建顺序执行，避免并发修改构建输出。慢环境单测超时可记录后调整超时重跑，不能把超时日志当作通过。

模块下的源码链接用于寻找对应 `*.test.ts` / `*.worker.test.ts` / `*.test.tsx` 自动化入口：

- 认证、权限、CRUD、契约与原子性适合 Worker/API 自动化。
- 幂等、Queue lease、Cron 和存储故障使用可控时钟/故障夹具；不以真实生产资源注入故障。
- 布局、焦点、cookie、Blob/CID、IndexedDB 恢复必须保留真实浏览器证据。
- DNS、Email Routing、provider payload/幂等、webhook 格式和外部真实到达必须在 preview 独立确认。

旧 `CAP-045-preview-runbook.md` 仍含 Better Auth、邀请和历史安装步骤，不能直接照抄为本轮环境步骤；
以本文路由、当前配置和整合计划为准。
