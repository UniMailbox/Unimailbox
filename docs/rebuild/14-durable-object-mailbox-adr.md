# ADR-014：邮箱是否使用 Durable Object 作为主存储

**日期：** 2026-10-04\
**状态：** Accepted — V1 不采用邮箱主存储 DO

## 背景

`agentic-inbox` 的 `MailboxDO` 将每个邮箱路由到一个 Durable Object，并在 DO SQLite
中保存邮件、线程、草稿和状态；附件字节仍在 R2。这个模型适合邮箱内强串行和实时连接，
但 Unimailbox 的目标还包括多用户、多域名、共享邮箱、全局收件箱、provider 状态和审计。
这些数据需要跨邮箱查询、D1 权限过滤、入站 fan-out 和 outbox 幂等。

当前 Unimailbox 没有 DO binding 或 DO migration。D1、R2、KV、Queue 已经组成事实拓扑：
D1 保存用户、域名、邮箱、membership、消息、投递状态、幂等和审计；已消费的出站附件
优先从 R2 读取，入站 raw MIME 和附件的 R2 持久化仍待完成；KV 只保存短 TTL
token/cache 与上传暂存；Queue 执行出站任务。

## 决策

V1 继续使用 **D1 + R2 + Queue**，不为每个邮箱增加 `MailboxDO` 主存储，也不把正文、
附件、权限、provider credential、最终 delivery status 或审计写入 DO。D1 是邮件和权限
事实来源；R2 是大对象字节来源；Queue 是异步发送边界。

DO 只保留为按需的 `MailboxCoordinatorDO` 候选，负责：

- 邮箱级短租约、竞争协调或顺序号；
- WebSocket subscriber/presence；
- D1 提交后的实时通知和 cache-invalidation cursor。

业务请求必须先经过 D1 session 与 mailbox membership 授权。D1 transaction/idempotency
提交成功后才通知 DO；DO 或 R2 通知失败不能回滚 D1 事实。

## 方案比较

| 方案 | 优点 | 主要代价 | 结论 |
| --- | --- | --- | --- |
| 每邮箱 `MailboxDO` 主存储 | 邮箱内串行、局部 SQLite 事务简单 | 全局 inbox 和跨邮箱搜索要 fan-out；D1 grants、目录、provider 状态双写；迁移、备份、删除和容量治理复杂 | V1 拒绝 |
| `MailboxCoordinatorDO` | 可增加实时推送和邮箱级协调，不改变 D1 查询模型 | 新 binding/migration、stub 故障和降级路径 | 有证据时再采用 |
| D1 + R2 + Queue | 跨邮箱查询和权限集中；入站/outbox 可用 D1 batch/idempotency | 高并发依赖 lease、索引和幂等；大字节必须转 R2 | V1 采用 |

## 采用门槛

只有同时具备以下证据，才新增 `MailboxCoordinatorDO`：

1. D1 lease 或实时刷新在目标负载下成为可重复观测的瓶颈；
2. 有按邮箱的并发、跨邮箱 fan-out、冷启动和重试基线；
3. 有 DO migration、备份/恢复、stub 失败和 D1-only 降级 runbook；
4. DO SQLite schema 只包含协调数据，并通过 `idFromName(mailboxId)` 分片；不使用全局单 DO，
   不依赖请求间内存状态。

未达到门槛前，保持 no-op coordinator 与 D1 lease 实现，避免引入第二个邮件事实来源。
