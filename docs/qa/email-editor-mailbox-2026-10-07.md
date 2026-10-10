# 富文本编辑器与默认邮箱验收 — 2026-10-07

入口：[staging.unimailbox.tech](https://staging.unimailbox.tech)。最终 Worker version：`24ed9c99-03e7-482e-baca-e45d28e96533`，schema `0029`。部署使用当前工作目录，HEAD `cf5acfdcdcaff2b6b752acf6b8536fa9d93473b6` 包含大量原有及本轮未提交修改，HEAD 不能代表实际部署源码。本轮未提交、推送或修改 production。

选型、限制与存储约定见 [编辑器与 R2 方案](../rebuild/16-email-editor-storage.md)。采用 Tiptap MIT 开源核心，复用 shadcn 控件；写信与域名签名共用编辑器。

## 本地验证

| 层次 | 结果 | 本机证据 `.tmp/editor-mailbox-20261007/` |
| --- | --- | --- |
| TypeScript / ESLint / Prettier | 通过；lint 排除生成的 `.tmp` bundle，格式检查排除既有参考 manifest | `typecheck-verified.log`、`lint-verified.log`、`format-scoped-verified.log` |
| Web | 61 文件，474 项通过；最后签名提示文案修改后相关 5 项再次通过 | `web-final-evidence.log`、`signature-final-copy.log` |
| 非 Web 单元、contracts、email-core、config、test-kit、scripts | 30 文件，781 项通过 | `nonweb-verified.log` |
| Workers 真实本地 D1/R2 绑定 | 53 文件，875 项通过 | `workers-full-final.log` |
| test-kit Workers / migrations | 18 项通过 | `workers-full-final.log` |
| Web 构建 | 通过；编辑器独立 lazy chunk 418.40 kB，gzip 132.95 kB | `web-build-verified.log` |
| 远程 schema | 0029 五个结构断言均 pass=1：表、持久引用 FK、索引、配额触发器、迁移跟踪行 | `migration-assertions.json` |

相关用例覆盖上传授权、内容长度/图片类型、流式写入、幂等回放与冲突、待发布配额、引用发布及清理、HTML 清洗、Brevo 大小预算、邮箱默认选择、编辑器图片后插入文件、取消上传、重置与路由。

初次完整 Worker 测试与 Web build 并行，build 清理静态目录导致两个 pool 启动失败；改为顺序执行后完整通过。补充 doctor 检查发现新迁移验证 SQL 缺少 assertion/pass 列、signatures → editor-assets 未登记；补齐后 781 项非 Web 测试通过。

doctor 最终 14/14。全目录 Prettier 检查另发现本轮之前已有的 `docs/rebuild/shadcn-admin-source-manifest.json` 格式问题；保留其内容，排除后其余受检查文件通过。未把整个 dirty checkout 的格式检查描述为无例外通过。

## Staging 浏览器与真实邮件

| 场景 | 实测 |
| --- | --- |
| 登录入口 | 登录直接进入默认邮箱 Inbox；重新打开根路径恢复最后有效邮箱，不再先出现选择页 |
| 左上角切换 | 两个授权邮箱间切换成功；当前邮箱勾选；All mailboxes 打开 `/mailboxes`；admin 页面也可使用 |
| 失效授权 | 移除临时成员权限后，根路径回到可用的管理员邮箱，列表仅显示一个授权邮箱 |
| 手机端 | 390 × 844 下切换邮箱后关闭侧栏；写信与签名工具栏换行，无文档横向溢出 |
| 签名 | 创建并保存加粗文本与 R2 图片；两次关闭/重开编辑框，文本和图片正确回显 |
| 编辑器生命周期 | 修复访问未挂载 editor.view.dom 的偶发崩溃；连续三次 Compose → Inbox → Compose 成功，无错误提示 |
| 图片再上传文件 | 修复选中图片时文件插入替换图片；回归用例先失败后通过，真实浏览器保留一张正文图片和一个文件链接 |
| 发送后重置 | 真正点击 Send，出现 Message queued 后正文、图片与链接清空，无旧内容回填 |

第一封邮件 `ddd85f5a-72c9-4e6e-9ce5-8aa0138d0070`：`staging-admin@unimailbox.tech` → `staging-one@unimailbox.tech`，Cc `staging-two@unimailbox.tech`。真实 Queue → Brevo → Cloudflare Email Routing → 收件邮箱完成，状态 **delivered**，To 和 Cc 均收到。

- 正文保留富文本、正文图片及签名图片；签名只追加一次。
- 上传文件 **22,020,096 字节（21 MiB）** 存 R2，以下载链接发送；HTML 749 字节，无 base64，无该文件的 MIME 附件。
- 原始下载链接强制 attachment；下载字节数与 SHA-256 均匹配上传文件。
- Brevo 重写图片/下载链接并增加追踪像素。验证实际收件 HTML 中的重写链接：两张内容图片与原图字节一致，文件下载 22,020,096 字节且 SHA-256 一致。不能仅靠原 URL 是否仍出现在收件 HTML 判断失败。
- 证据：`email-evidence.json`。`receivedImageCount` 是原始 HTML 正则计数，包含 provider 生成的标记；内容图片通过 HTMLParser 和实际字节校验判定。

第二封 `e716a4e4-ee31-40cf-b108-c4d963672c4f` 验证最终编辑器生命周期修复、先图片再文件、签名和发送后重置，**delivered** 且收件入库。证据 `final-email-evidence.json`。随后最终部署仅更新签名页说明文案，浏览器已确认新文案、清理后的签名列表及 mailbox switcher。

截图：`compose-final-desktop.png`、`editor-fixed-mobile.png`、`signature-final-mobile.png`、`mailboxes-mobile.png`。截图与运行日志在本机临时目录，不包含在 tracked 文档内。

## 操作与验收边界

- Wrangler 部署前已导出 staging D1 至 `staging-before.sql`（0600），随后应用 0029。现有 R2、Queue、Cron 和域名配置复用，无新增 S3 key、公共 bucket 或 CORS 配置。
- 临时域名签名与管理员对 staging-one 的临时 sender 授权已删除，原签名数量恢复；测试邮件保留作为证据。历史邮件引用的 R2 文件继续保留，未发布上传按 7 天策略清理。
- 上传文件以持有链接即可访问的方式提供给收件人；页面已明确说明。既有私有收件附件继续使用原鉴权下载。
- 7 天自然过期、长期公开链接可用性、其他外部邮件供应商送达率未做时间跨度验收；本轮不将完整 175 项验收计划标为全部通过。无需用户人工处理 Cloudflare/DNS/Brevo 配置。
