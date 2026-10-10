# 10 MB 超大附件规则验收 — 2026-10-07

入口：[staging.unimailbox.tech](https://staging.unimailbox.tech)。最终 Worker version：`98ffb685-db84-4842-acd2-632e00b295f2`。沿用 schema 0029，无新迁移、bucket、密钥或 DNS 调整。基于当前含原有改动的工作目录构建；本轮没有 commit/push 或 production 操作。

## 规则

- 预计整封邮件严格超过 **10,000,000 字节** 时，所有附件都改为 R2 下载链接，包括小文件。估算计入正文、主题、纯文本、域名签名、最终附件列表及附件 base64/MIME 开销。
- 编辑器文件已经存 R2。旧附件接口的文件通过既有鉴权、长度与生命周期检查后持久化 R2；新能力链接及持久引用与 message/job/consume/idempotency 同批提交，复用 canonical object_key，不重复存储文件。
- 已托管附件在 Queue 中跳过二进制读取/发送；Brevo adapter 也阻止超过 10 MB 的 MIME 附件消息绕过该规则。低于阈值的旧接口普通附件仍支持 MIME。
- 文件链接统一位于正文和签名之后的“附件列表（超大附件）”，HTML、纯文本一致，包含文件名、大小和链接。重复引用去重，普通正文链接、内嵌图片保留。未超过阈值的编辑器托管文件使用“附件列表”。小文件显示 B/KiB，避免显示为 0.00 MiB。
- 收件页面将链接显示为带下划线的可点击文本，附件列表显示项目符号。方案详见 [编辑器/R2 文档](../rebuild/16-email-editor-storage.md)。

## 本地验证

证据目录：`.tmp/large-attachments-20261007/`。

| 验证 | 结果 | 日志 |
| --- | --- | --- |
| 非 Worker 全套 | 92 文件，1,259 项通过 | `nonworker-full.log` |
| Worker 全套 | 53 文件，877 项通过 | `workers-full.log` |
| test-kit / migrations | 18 项通过 | `test-kit-workers.log` |
| 最终边界与 compose 回归 | 2 文件，41 项通过，包含新增“附件列表使邮件越过 10 MB”用例 | `workers-verified.log` |
| 最终纯函数 / Brevo | 15 项通过，8 MiB 与 14 MiB 文件均在编码/provider 调用前拦截 | `unit-verified.log` |
| Typecheck / lint / format / doctor | 通过；doctor 14/14 | 同名 `.log` |
| Web build / Wrangler deploy | 通过 | `build-web-verified.log`、`deploy-final.log` |

lint 排除生成的 `.tmp` bundle，format 排除上一轮已经记录的 `shadcn-admin-source-manifest.json` 格式问题，未改写该参考文件。最终展示与边界修正后重跑相关用例；没有将全套旧结果冒充最终新增用例已在全套执行。

初次集成测试揭示 legacy consume trigger 要求 message_attachments 使用原 object_key；实现改为复用该 R2 对象和原有消费约束，随后测试通过。初轮测试数据中的签名表名和大小样本也已修正。回归覆盖普通附件发送、混合附件、全部托管、3 字节小文件、下载字节、幂等回放及最终列表开销。

## 真实平台验证

From/To/Cc 使用 `unimailbox.tech`。实测版本 `77b96f6e-110d-46c6-87b4-089fc19719b9`，最终版本补充链接/列表样式、小文件大小显示及临界值保护。

| 邮件 | 结果 |
| --- | --- |
| `be781447-f806-44d4-ba81-f025866ee8d6` | 5 MiB + 3 MiB + 3 B 的三个旧接口附件全部转链接；同 key 回放返回同一 ID；delivered，发信 HTML 767 字节，收件 MIME 附件 0 |
| `103eb65f-1627-40e1-9798-41056765ba08` | 21 MiB 编辑器文件 + 22 B 旧附件全部转链接；delivered，发信 HTML 528 字节，收件 MIME 附件 0 |

两封邮件的 HTML/纯文本都只有一个附件列表，位于正文末尾。所有原始下载链接及 Brevo 重写后的收件链接均实际下载，字节数和 SHA-256 匹配；原始链接强制 attachment 下载。证据 `live-state.json`、`live-evidence.json`、`live-send.log`、`live-verify-final.log`。以上 HTML 字节是发送端持久化正文，收件端会增加 Brevo 追踪标记。

最终版本 smoke 邮件 `66d06932-4ea7-4117-9e5e-9c236ec123ea` 复用已发布的 21 MiB 文件并加入新的 3 B 旧附件，真实 delivered 且收件入库，MIME 附件 0，正文后只有一个超大附件列表，小文件正确显示为 3 B。证据 `final-evidence.json`。

收件浏览器可见全部文件链接；390px 无横向溢出。最终 CSS 实际 computedStyle 验证链接 underline、列表 disc 均为 true。截图 `recipient-list-desktop-final.png`、`recipient-list-mobile-final.png`，最终邮件截图 `final-message-mobile.png`。临时浏览器会话已退出并删除其临时登录 profile。

## 边界

文件属于持有能力链接即可下载的收件人资产，现有页面已有说明；已有私有收件附件仍保留原鉴权。历史测试邮件保留，不更改用户原有签名或共享授权。7 天自然过期、长期可用性和其他外部邮件供应商仍不属于本轮时间跨度验收。
