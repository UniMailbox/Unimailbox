# UI 调整与 staging 配置页实测 — 2026-10-07

入口：[staging.unimailbox.tech](https://staging.unimailbox.tech)。基于当前未提交工作目录，HEAD `cf5acfdcdcaff2b6b752acf6b8536fa9d93473b6` 不代表部署源码快照。主要参考为 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)，固定版本、许可证和适配清单见 [UI 调整记录](../rebuild/15-shadcn-admin-ui-redesign.md) 与 [源码来源清单](../rebuild/shadcn-admin-source-manifest.json)。

## 本轮发现与修复

| 问题 | 修复 |
| --- | --- |
| 配置字段仍是默认原生外观，数字框窄至 35–85px；运行信息排版错位 | 标准 Input、Switch、Checkbox、Select；分为 General、Mail flow、Limits、Retention；环境与保存时间合并为简洁信息行 |
| 角色、签名列表同时展开全部编辑表单 | 紧凑资源列表；New/Edit 按需打开有界 Dialog，权限默认折叠展示数量 |
| 取消编辑后遗留草稿，保存后仍显示旧创建提示 | 取消恢复原值，保存关闭编辑器；成功提示对应最近一次操作 |
| 未保存的默认设置时间显示 1970 年 | 显示 Not saved yet；真实保存后展示本地时间 |
| 签名后台缓存刷新后可能覆盖另一写入者的版本 | If-Match 使用打开编辑器时捕获的版本；409 保留表单和错误 |
| 长时间编辑后保存直接返回 401 | 共享一次 HttpOnly-cookie 续期并重试，保留 body 和 Idempotency-Key；403、auth/setup 排除；登出期间不恢复操作 |
| 审计页 AUDIT_ROW_INVALID | 备份并校正此前 staging 密码调整留下的单条非合同动作，保留原动作、说明、ID、时间；未删除日志或放松校验；筛选改为标准 Select 与响应式网格 |

## 分层证据

- Web：462 个测试、59 个文件；workspace TypeScript、Web ESLint、生产构建通过。覆盖只读控件、原始字段值、取消与焦点、版本冲突、续期并发和幂等、登出竞态。
- 浏览器：settings、domains、connections、roles、signatures、users、webhook-events、audit-events 共 8 页，在 1440px 和 390px 下数据加载成功；16 次文档宽度均等于视口宽度。矩阵及截图位于 `.tmp/ui-redesign-20261007/final/`。
- 设置：通过 UI 保存当前值，PATCH 200；重载后值保持一致且保存时间更新。Inbound/outbound 保持开启，未改变现有投递策略。
- 角色：创建未分配的临时角色，POST 201；编辑取消后恢复原值，Esc 后焦点返回 Edit；PATCH 200；删除确认默认焦点在 Cancel，取消不删除，确认后清理。D1 只读确认无残留。
- 签名：创建时始终禁用；更新 PATCH 200，删除 DELETE 200，恢复无签名初始状态。删除确认的 Shift+Tab 保持焦点在模态内。
- 自然过期：签名表单从 23:43 UTC 保留至 23:59 UTC，超过 15 分钟。保存产生真实 POST 401 → `/auth/refresh` 200 → POST 201；表单内容完整保留，没有重新填写。请求序号 `22021.153/154/155`。状态码日志在 `.tmp/ui-redesign-20261007/signature-expiry-requests.txt` 和 `refresh-requests.txt`；未提取浏览器凭据。

最终 Worker version：`5899903e-51d7-4391-a1b2-8f275fa75214`。源码/构建文件 SHA-256 在 `.tmp/ui-redesign-20261007/deployment-source-sha256.json`，部署日志 `deploy-complete.log`。构建为 initial main 428.81 kB + React 185.69 kB；CSS 97.08 kB。主包拆分不等于总下载量降低。

暗色偏好重载后保留；1440px/390px 无横向溢出。审计 Select 使用 End/Enter 选中 `settings.updated`，点击 Apply 后真实查询 200 并返回设置保存事件；当次自然过期的 GET 401 也成功续期恢复。最终版本的桌面暗色设置页已加载并记录在 `.tmp/ui-redesign-20261007/final-dark/settings-1440.png`。额外的全页暗色复查随后因自动化浏览器回到 `about:blank` 中断，未标为全量暗色通过；之前的 8 页桌面/移动端矩阵、暗色设置/审计与键盘验证分别保留。

## 验证范围与限制

本轮以 UI 与真实配置 CRUD 为主；没有重新执行整个 Worker 套件或 175 个验收项。此前真实邮件、附件、Queue/Brevo/Email Routing 证据见 [staging 实测记录](staging-2026-10-06.md)。域名 Verification 仍是操作员确认；部分设置只保存策略，尚未被运行服务执行，页面明确说明。没有修改现有 outbound connection 或账户级邮件设置。未提交或推送代码。

一次最终 Web 全量运行发生约 17 分钟的进程停顿，出现多个测试超时和 8 个 worker 启动失败，原日志保留在 `.tmp/ui-redesign-20261007/tests-complete.log`。后续受控两 worker 全量复测 462/462，通过耗时 18.18 秒，结果记录在 `tests-verified.log`，不得把失败运行隐去。

自动审批拒绝通过读取浏览器会话凭据主动制造失效的测试方式；已采用自然过期场景完成实际验证，无需人工授权。

最终两页补查：在新测试浏览器中加载版本 `5899903e` 的角色和签名页，1440px/390px 四次检查均成功，实际 main 资源为 `index-Cr6Yzigi.js`，无横向溢出。证据在 `.tmp/ui-redesign-20261007/last-pages/` 和 `browser-last-pages.log`。
