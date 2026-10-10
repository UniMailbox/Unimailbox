# 部署审查 — 2026-10-07

> 2026-10-08 后续修复及验收见 [deployment hardening QA](../qa/deployment-hardening-2026-10-08.md)。以下保留审查当时的代码和线上快照；现行操作以 [部署与恢复手册](deploy.md) 为准。

当前 staging 可用，已部署的资源也保持 staging 隔离；但通用 `pnpm scaffold deploy` 与实际 staging 发布路径分叉，存在环境复用、密钥命令失效、迁移失败后继续执行及校验被重试绕过等问题。建议先修复下列 P1，再将通用入口用于正式发布。

本次审查覆盖部署脚本、Wrangler 配置、构建与工具版本、迁移、密钥、静态资源、队列、Cron、健康检查和恢复流程。没有修改应用或部署配置，没有执行远端迁移、发布、密钥轮换或恢复操作。失败复现使用项目 `.tmp/` 下的独立副本及假 Wrangler 命令，未连接真实数据库。

## 已验证的 staging 状态

| 项目 | 本次证据 | 结论边界 |
| --- | --- | --- |
| 发布版本 | `8255eaef-5ce3-4392-aacc-0244df482f8f`，100% 流量，2026-10-07 13:40:11 UTC 发布 | 发布记录及版本资源来自只读 Wrangler 查询 |
| Worker 入口 | `fetch`、`email`、`queue`、`scheduled` 均存在 | 不代表邮件服务商或 Email Routing 的完整链路通过 |
| 资源隔离 | 线上 D1、R2、队列、KV、Secrets Store 绑定与 `wrangler.staging.jsonc` 对应 | 当前 staging 配置正确；通用脚本有另一套目标资源 |
| 数据库迁移 | 31 条记录，最新 `0031_user_preferences.sql`；与磁盘文件比较无 pending、无 ghost | 迁移记录一致，不等同于所有历史 schema 断言重新验收 |
| D1 恢复能力 | 成功读取当前 Time Travel bookmark | 没有执行恢复演练；没有据此推断账户保留期 |
| HTTP | `/healthz` 200；未登录访问 `/api/v1/admin/overview` 为 401；不存在的 `/api/v1/*` 为 JSON 404 | 401 只证明鉴权拦截，未验证登录后的业务响应 |
| 队列 | `unimailbox-staging-outbound` 各有一个 producer、consumer，均为 staging Worker | 未制造重试耗尽或服务商故障 |
| Cron | 2026-10-07 15:02:41 UTC 实际观察到 `*/2 * * * *` 调用，版本一致，`outcome: ok`，无异常 | 一次空闲执行成功；不代表有数据时的清理/补偿验收 |
| R2 生命周期 | 仅有未完成 multipart 上传 7 天后中止的默认规则 | 应用附件保留由业务清理负责；不应给全部邮件对象盲目设置 TTL |
| DNS | `unimailbox.tech` 的 MX 指向 Cloudflare，SPF 包含 Cloudflare，DMARC 为 `p=none` | 没有发送邮件或查询 Brevo 的当前域名验证状态 |

## 优先修复：P1

### D-01：切换 ENVIRONMENT 不会切换实际部署资源

证据：[共享状态路径](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:32)、[配置生成](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:910)、[固定模板入口](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:956)。脚本始终读取主模板，复用同一个 `.cloudflare-resources.json`，只替换 `vars.ENVIRONMENT`。Worker 名称、数据库、桶、队列和 secret 名称不随目标变化，也未验证状态文件的账户归属。

隔离运行 staging 与 production 两次，得到相同 Worker 名称 `unimailbox-worker` 和相同 D1 ID，只有环境变量不同。通用主模板还设置 `workers_dev: false`，却没有 route/custom domain；实际 staging 自定义域名配置不会被该入口采用。

影响：操作者以为选择了另一个环境，实际可能覆盖已有 Worker 或对同一数据库执行迁移。当前独立 staging 配置的正确隔离不能消除这个入口的问题。

建议：所有发布入口显式选择环境配置，并在任何远端写入前校验 account ID、Worker 名、域名及资源清单。状态按 account/environment 保存并校验归属。资源初始化与日常发布拆开，日常发布不得隐式创建资源。

### D-02：首次资源初始化和 Secrets Store 命令与锁定 CLI 不兼容

证据：[D1 创建结果解析](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:392)、[secret create](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:664)、[secret update](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:690)、[Store 查找](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:577)。已对照项目锁定 Wrangler 4.121.0 的帮助和实现：

- D1 创建输出根据 JSONC 配置生成 JSON 片段；脚本只匹配 TOML 的 `database_id = "..."`。模拟当前格式后，解析失败且退出码为 0，未继续发布。
- secret create/update 均未传 `--remote`。当前 CLI 默认操作本地 Secrets Store，不能据成功退出就把远端密钥标记为已设置。[Cloudflare 说明](https://developers.cloudflare.com/secrets-store/manage-secrets/)。
- secret update 要求 `--secret-id`；脚本传的是 `--name`，缺少必需参数。
- 当前账户已有 `default_secrets_store`，脚本却只查找 `unimailbox-secrets`，找不到后尝试新建。当前 Beta 每账户只允许一个 Store，应复用已有 Store，并用环境前缀隔离 secret 名称。

影响：通用首次部署无法可靠完成；本地状态可能与远端密钥不一致。实际 staging 已有可用绑定，不表示这条初始化路径可重现。

建议：对远端 Secret 使用明确的 `--remote` 和查询到的 secret ID；创建后重新读取远端元数据确认存在。资源 ID 从结构化查询获取，不解析人类可读输出。任何业务失败统一非零退出。

### D-03：无法读取迁移记录时，仍尝试执行全部迁移

证据：[readRemoteApplied](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:1032)。Wrangler 非零退出时直接返回空数组，把鉴权、网络和数据库不可用等错误都视为空库。JSON 解析失败时又使用 `process.exit(r.status ?? 1)`；当 CLI 状态为 0 时，失败也以 0 结束。

隔离复现：先让迁移记录查询失败，再让后续命令恢复成功，脚本仍执行 migration SQL 并发布；另一次返回无效 JSON，脚本没有部署却退出 0。现有包含 `ALTER TABLE` 的迁移不应被盲目重放；目前没有证据表明 staging 已发生重放或数据损坏。

建议：只有明确识别到 `d1_migrations` 不存在才能进入新库流程；其他读取、解析或执行错误一律停止。保留 stdout/stderr 的边界，统一失败退出码，并测试实际命令编排路径。

### D-04：迁移校验失败后，再次部署可以绕过校验

证据：[无 pending 提前返回](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:1113)、[仅校验本次 pending](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:1154)、[SQL 内记录已应用](/Users/john/Workspace/x/Unimailbox/migrations/0031_user_preferences.sql:16)。迁移 SQL 自行插入 `d1_migrations`，之后独立执行 companion 断言。断言失败不会删除已应用记录。

隔离复现：第一次 SQL 成功、companion 返回 `pass=0`，发布停止、退出 1；第二次读取到已应用记录后，跳过失败的断言并成功发布、退出 0。

建议：区分 applied 与 verified 状态；失败验证必须在重试时继续阻止发布。至少在发布前执行当前 schema 的必需断言，并对“SQL 成功、验证失败、再次执行”增加完整流程测试。不要通过自动重放已应用 DDL 解决这个问题。

### D-05：单一密钥轮换参数包含不能直接替换的加密密钥

证据：[统一 force 参数](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:626)、[重新生成凭据加密密钥](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:741)、[脚本自身的数据丢失提示](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:1238)、[runbook 的安装令牌轮换建议](/Users/john/Workspace/x/Unimailbox/docs/operations/deploy.md:117)。`--force-secrets` 同时处理三个 secret，runbook 却建议用它轮换 `INSTALLATION_TOKEN`。脚本已明确说明重加密任务不存在。

影响：D-02 的 CLI 问题修复后，这个参数会同时替换 `CREDENTIAL_ENCRYPTION_KEY`；没有旧密钥或重加密流程时，现存 provider 凭据无法解密。当前命令失效不能作为长期保护，也未发现本次发生密钥轮换。

建议：安装令牌、cursor key 按名称独立轮换；普通部署不轮换数据加密密钥。后者必须先实现保留旧 key、版本识别、重加密、验证及回退流程。同步修正 runbook。

## 发布可靠性与运维：P2

### D-06：发布入口不保证使用本次构建，也没有仓库内自动门禁

证据：[主流程](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:1281)、[dry-run](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:1185)、[构建脚本](/Users/john/Workspace/x/Unimailbox/package.json:12)、[现有 CI 描述](/Users/john/Workspace/x/Unimailbox/docs/operations/deploy.md:192)。发布前没有执行依赖锁定安装、类型检查、测试或前端构建。Wrangler 可重新打包 Worker，但静态资源直接取现有 `apps/web/dist`，可能出现新后端配旧前端。脚本的 `--dry-run` 也只是打印，不执行 Wrangler 构建检查。

仓库没有 `.github` 工作流；Cloudflare Builds 或其他外部流水线是否配置，本次未确认。当前线上版本元数据没有发布 tag/message，HTTP 也没有 release SHA/schema 信息。脚本没有并发发布锁。

建议：将资源 bootstrap 拆出后，使用一个发布入口串联 preflight → 校验/构建 → 迁移/验证 → deploy → smoke。正式发布从确定的 revision 构建，保存 revision、构建工具版本、Worker version、资源清单和迁移结果；同一环境串行发布。CI 使用锁文件安装和同一入口，不再维护另一套命令。

### D-07：自定义域名健康检查被跳过，healthz 不检查依赖

证据：[URL 提取与跳过分支](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:1198)、[healthz 实现](/Users/john/Workspace/x/Unimailbox/apps/worker/src/http/router.ts:71)。脚本只识别 `*.workers.dev`，自定义域名输出不会触发 HTTP 检查。runbook 声称支持 custom domain，与实现不同；隔离复现确认此路径仍以成功结束。

`/healthz` 仅返回固定 JSON，不能验证 D1、schema 或 secret 可用。当前实测 200 不应等同于完整部署验收。

建议：从已校验配置读取明确的部署 origin，无法确定时使发布失败。保留轻量 liveness，增加受限 readiness，检查 D1/schema 和必要 secret 可读性。发布 smoke 验证页面、JS、API 错误信封和受保护接口；登录后的业务及邮件链路独立验收。

### D-08：缺少与 schema、R2、密钥相配套的回滚流程

证据：[迁移先于 deploy](/Users/john/Workspace/x/Unimailbox/scripts/deploy.ts:1299)；现有部署 runbook 未给出回滚/恢复步骤。迁移执行时旧 Worker 仍可能处理流量，故 schema 必须兼容仍在线的版本。

本次确认 staging 能读取 D1 Time Travel bookmark，不能说“数据库没有备份”。需要补的是：发布记录中的恢复点、可接受的数据回退范围、Worker 与 schema 的兼容判断、R2/密钥恢复策略和实际恢复演练。Worker rollback 不会回退连接资源的数据。[Worker rollback 限制](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)；[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)。

建议：采用先扩展后收缩的兼容迁移；发布前记录上一 Worker version 和 D1 bookmark，失败后先判断能否只回退代码。数据库恢复属于单独的受控操作。R2 使用应用对象清单和可恢复删除策略，密钥保存可用旧版本；先在独立演练资源验证恢复步骤。

### D-09：静态资源发布缺少安全头、map 排除与缓存/404 策略

证据：[sourcemap 配置](/Users/john/Workspace/x/Unimailbox/apps/web/vite.config.ts:16)、[静态资源路由](/Users/john/Workspace/x/Unimailbox/apps/worker/wrangler.staging.jsonc:27)，以及本次真实 HTTP 响应：

- `/assets/index-B8USO41v.js.map` 返回 200、约 2.15 MB，包含 275 个 `sourcesContent`；完整前端源码可下载。本次没有据此认定服务端密钥泄露。
- `/login` 没有 CSP、frame 限制、`nosniff`、Referrer-Policy 或 HSTS。下载附件已有局部安全头，不能覆盖登录页和其他静态页面。
- 带 hash 的 JS 仍为 `max-age=0, must-revalidate`，每次使用都需要重新确认新鲜度。
- `/api` 和不存在的 `/assets/deployment-review-missing.js` 返回 200 HTML，API 边界和缺失 chunk 的状态不清晰。

建议：使用可复制进 dist 的 `_headers` 管理静态响应，Worker API 则单独设置响应头；CSP 先核对编辑器、图片及其他真实依赖。将 map 从公开 assets 排除，需要排障时单独上传到私有系统；仅设置 `sourcemap: hidden` 不会阻止 map 文件发布。对 hash 文件使用长期 immutable 缓存，HTML 保持重新验证；将 `/api` 纳入 Worker，缺失资源返回明确 404，并处理旧页面 chunk 加载失败。staging 可加 `noindex`。

上述缓存优化及静态/Worker 响应头分工与 [Cloudflare Headers 文档](https://developers.cloudflare.com/workers/static-assets/headers/)一致。

### D-10：队列缺少 DLQ，清理任务缺少整体结果监测

证据：[队列配置](/Users/john/Workspace/x/Unimailbox/apps/worker/wrangler.staging.jsonc:23)、[串行 Cron 任务](/Users/john/Workspace/x/Unimailbox/apps/worker/src/entrypoints/scheduled.ts:39)、[现有 outbox 补偿](/Users/john/Workspace/x/Unimailbox/apps/worker/src/modules/outbound-mail/reclaim-stale-jobs.ts:80)。队列设置 5 次重试，无 DLQ；重试耗尽后队列消息会被删除。[Cloudflare DLQ 文档](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)。

D1 outbox、lease 回收和孤儿 queued 任务补偿已实现，因此不能直接推断邮件丢失。欠缺的是异常消息保留、失败分类、重驱流程及持续故障告警。Cron 已有 `outbound.reclaim` 统计日志，本次也观察到成功调用；但前面任务抛错会阻止后续附件/头像/孤儿清理，缺少全部任务完成的统一结果。仓库未见告警定义，账户级告警是否存在未确认。

建议：配置独立 DLQ，并明确消费/保留/重驱策略；保持 D1 状态与重驱幂等性。按服务商限流和负载实测决定队列 batch/concurrency/retry delay。Cron 记录各任务的成功、失败、耗时及总结果，对安全独立的任务隔离失败；监测 backlog、最老 queued 时间、失败率和清理延迟。

## 工具与维护：D-11（P2）

证据：[Node engines](/Users/john/Workspace/x/Unimailbox/package.json:7)、[原生 TS 启动参数](/Users/john/Workspace/x/Unimailbox/package.json:27)、[运行兼容日期](/Users/john/Workspace/x/Unimailbox/apps/worker/wrangler.staging.jsonc:6)、[手写 Env](/Users/john/Workspace/x/Unimailbox/apps/worker/src/platform/env.ts:38)。

文档声明 Node >=20.11，但脚本使用 Node 22.6 才引入的 `--experimental-strip-types`，支持范围不一致。[Node 官方发布说明](https://nodejs.org/en/blog/release/v22.6.0)。本机根目录 `pnpm exec wrangler` 落到全局 4.147.0，Worker 包内执行为锁定的 4.121.0；裸命令不能保证一致。所有环境的 compatibility date 为 2025-09-23，已经超过一年；不应直接改日期而跳过回归。

建议：固定一个实际验证的 Node 22 版本、pnpm 11.20.0 和项目 Wrangler；所有操作通过 Worker workspace 执行。CI 增加 CLI 命令契约及新机器 bootstrap 验证；用 `wrangler types` 生成基础 bindings 类型，业务/测试扩展保持独立。兼容日期按计划升级并验收邮件、队列、Cron 和加密路径。同步修正文档中的两个 secret、错误 CLI 参数、custom domain 健康检查和轮换说明。

## 建议实施顺序与验收

1. 修复 D-01 至 D-05：目标隔离、远端 Secret 契约、失败退出、迁移读取和验证状态、独立轮换。先补失败路径的完整命令编排测试，再改生产入口。
2. 合并发布路径，加入构建门禁、可追溯版本、并发锁、自定义域名 smoke，以及明确的 rollback runbook。
3. 完成静态资源安全头/map/缓存/404、DLQ 和任务告警，再进行恢复及邮件服务商故障演练。

验收至少应包含：错误账户/环境在远端写入前被拒绝；查询失败不执行 SQL；CLI 格式变化非零退出；迁移验证失败在重试后仍阻止发布；单独轮换安装令牌不改变数据加密 key；前后端使用同一构建来源；自定义域名检查实际执行；代码回退与数据恢复分别验证。

## 本次验证与剩余边界

- `pnpm typecheck` 通过；项目锁定 Wrangler 对 staging 配置的真实 `deploy --dry-run` 通过，Worker gzip 约 233 KiB。该检查使用现有 web dist，没有声称重新构建了前端。
- `scripts/deploy.test.ts`、`scripts/scaffold.test.ts`：2 个文件、62 个测试通过。`pnpm scaffold doctor`：14/14 通过。现有测试通过仍未覆盖本次复现的命令编排失败。
- 六个隔离场景全部得到预期复现结果：staging/production 资源复用、自定义域名跳过 health、读取失败继续迁移、无效 JSON 退出 0、D1 JSON 输出解析失败退出 0、迁移验证失败后重试绕过。
- 读取了最新 Workers best practices、类型包 `5.20261007.1` 和项目 Wrangler schema；没有升级项目依赖。当前大文件编辑器上传使用流式写 R2，此处没有将旧版 5 MiB 附件缓冲路径误判为 100 MB 上传实现。
- 未验证：正式 production 的账户和资源、外部 CI/告警、登录后完整业务、Email Routing 规则及 Brevo 域名/回调的最新状态、真实收发信、大附件压力、DLQ 重驱、恢复演练与账户额度。需要这些证据才能进一步声明生产验收完成。

原始查询、日志和隔离复现脚本保存在 `.tmp/deployment-review-20261007/`，不作为永久文档或提交内容。以上发现以本次代码与线上快照为准。
