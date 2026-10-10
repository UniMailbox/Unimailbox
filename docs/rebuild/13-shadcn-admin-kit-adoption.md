# shadcn-admin-kit 采用说明

> **历史方案，已于 2026-10-06 替换。** 用户指定的当前 UI 基座为 [satnaing/shadcn-admin](https://github.com/satnaing/shadcn-admin)，实施范围和验证见 [15-shadcn-admin-ui-redesign.md](15-shadcn-admin-ui-redesign.md)，源码来源见 [shadcn-admin-source-manifest.json](shadcn-admin-source-manifest.json)。以下保留旧方案及许可证溯源，不代表当前组件实现。

**状态：** 已批准直接作为 Unimailbox 的 Web UI 基座；固定版本的目标源码与依赖已审查，本地 shell 已接入生产路由，上游配色及 Table primitive 已按 MIT 许可导入，UTC → local time 展示组件已接入。后续 UI 组件按上游源码迁移，保留 MIT 版权并逐项记录改动。\
**上游：** [`marmelab/shadcn-admin-kit`](https://github.com/marmelab/shadcn-admin-kit)  ️\
**固定 commit：** `78e32b93174937f0871877b3ddaf2ddd4d71ea16`\
**许可证：** MIT，Copyright © 2025 marmelab。

## 采用范围

直接采用上游的视觉语言、组件源码和可复用界面结构：

- design tokens、主题切换和基础 CSS 变量；
- 应用 shell、侧边栏、顶部栏、响应式导航和页面容器；
- 表格、分页、表单、Dialog/AlertDialog、Toast、空状态、加载和错误状态；
- 图标、间距、焦点环、键盘导航和窄屏行为。

以下内容继续由 Unimailbox 自己负责：

- D1 session、密码、admin capability 和 mailbox membership；
- `/api/v1` contracts、TanStack Query key、错误 envelope 和缓存隔离；
- 邮箱列表、线程、草稿、附件、Brevo/provider 状态和审计；
- Worker/Vite/TanStack Router 组装、Cloudflare bindings、mock data 和部署配置。

## 迁移边界

同一个 Worker 和 React 工程中保留两个明确的产品表面：

| 表面 | 路由 | 布局 | 主要导航 |
| --- | --- | --- | --- |
| 管理端 | `/admin/*` | `AdminLayout` | 用户、域名、邮箱、membership、provider、webhook、审计、设置 |
| 邮箱端 | `/mailbox/*` | `MailboxLayout` | 邮箱选择、文件夹、收件箱、线程、写信、草稿、附件 |

两个布局共享 primitives 和 tokens，但不共享权限上下文、业务导航或查询 key。`/admin/*`
进入前使用 `/auth/me` 的 D1 权限提示决定是否展示管理壳层；普通用户直达管理深链会返回
邮箱端。服务端每次请求仍重新验证具体权限；界面中的链接和菜单只负责展示，不构成授权。

## 固定版本源码审查（2026-10-04）

`git ls-remote` 与隔离检出的 `HEAD` 均为上述 commit。已核对上游 `LICENSE`、
`package.json`、`src/index.css` 和下表源码；这是一轮**目标组件审查**，不表示已审完
仓库的全部 664 个文件。当前已导入下表所列的配色源码片段。

| 上游文件 | 可采用的部分 | 接入约束 |
| --- | --- | --- |
| `src/index.css` | OKLCH light/dark tokens、sidebar 色阶、focus ring、圆角 | 使用 Tailwind CSS 4 的 `@theme`；先映射至现有语义变量，不能原样覆盖 `tokens.css` |
| `src/components/ui/{button,card,input,table,dialog,sidebar,sheet,tooltip,skeleton}.tsx` | 按钮、容器、表格、对话框、响应式侧栏及反馈组件 | `button`/`sidebar` 等依赖 Base UI、CVA、Lucide、Tailwind 4；逐个移植并保存 MIT 来源清单 |
| `src/components/admin/{layout,app-sidebar}.tsx` | 悬浮可折叠侧栏、移动抽屉、顶部工具区、加载/错误边界的结构 | `layout`/`app-sidebar` 使用 Ra-Core 的资源、权限与 React Router 上下文；按现有 TanStack Router 和 D1 权限重写连接层 |
| `src/components/admin/data-table.tsx` | 表格密度、选择状态、排序/列操作的交互设计 | 实现依赖 `ra-core` 的 DataTableBase、resource store 和翻译上下文；业务分页仍使用现有 HMAC cursor API |

上游 `package.json` 使用 React 19、React Router 7、Ra-Core 5、Tailwind CSS 4、
Base UI 1.6 和 Vite 8；本项目使用 React 19、TanStack Router、已有 Query/contracts、
普通 CSS tokens 和 Vite 6。导入上游 `Admin`/`Resource` 根组件会引入第二套路由、
数据与授权事实来源，因此 UI 组件与视觉结构是直接采用的边界，业务层继续由 Unimailbox
承接。迁移时先引入 Tailwind/组件所需的最小依赖并测量 CSS 与主 bundle，再替换本地
shell 和页面控件。不得仅因套用模板改用 Ra-Core 的 authProvider 或 DataProvider。

**源码复制清单：**

| 上游固定版本 | 本地位置 | 改动原因与应用范围 |
| --- | --- | --- |
| `src/index.css` light/dark palette | `apps/web/src/styles/admin-kit-theme.css` | 改为 `.app-layout` 作用域及系统暗色模式，避免覆盖安装和登录流程；管理端与邮箱端 shell 使用。 |
| `src/components/ui/table.tsx` | `apps/web/src/components/ui/Table.tsx` + `apps/web/src/styles/tokens.css` | 保留语义 table、组合 slots 和横向滚动容器；将 Tailwind utilities 映射到现有 CSS tokens，不引入 Ra-Core 或 Tailwind。`/admin/users` 已采用，并为窄屏滚动区加键盘焦点。 |

MIT 全文已保存在 `docs/rebuild/licenses/shadcn-admin-kit-MIT.txt`，复制文件顶部保留版权来源。下一步迁移 `button`、`card`、`dialog`、
`sidebar`、`sheet`、`tooltip`、`skeleton` 及其最小依赖；每项追加“上游路径 → 本地路径 →
修改原因”，并将上游 MIT 许可证与版权声明随复制文件保留在仓库中。

**当前构建快照（2026-10-04）：** Web CSS 29.05 kB（gzip 4.71 kB）、主 JS 674.50 kB
（gzip 199.62 kB）；Vite 保留既有的 500 kB chunk 提示。该快照可供后续组件迁移比较，
不是迁移前后差值，也不是浏览器性能验收。

## 分步实施

1. **来源冻结。** 固定 commit 与 MIT 已核对；在首次复制前确定具体文件、依赖版本和来源清单。
2. **基础层。** 将经过审查的 tokens/primitives 导入 `apps/web/src/components/ui/` 和
   `apps/web/src/styles/`，保留现有无障碍属性、测试 ID、错误契约和 UTC formatter。
3. **布局层。** 已新建 `apps/web/src/components/layouts/AdminLayout.tsx` 与
   `MailboxLayout.tsx` 并接入现有 admin/mailbox 路由；只替换 shell，现有路由、API 和权限
   测试继续通过。
4. **管理端迁移。** `/admin/users` 已使用源自上游的 Table primitive，保留账号创建、一次性
   初始密码、重置、停用/恢复、403、网络失败和游标分页行为。继续迁移其他 `/admin/*` 表格、表单、确认框和反馈状态。
5. **邮箱端迁移。** 再迁移全局 inbox、单邮箱、线程、compose、草稿恢复和附件工作区；列表
   时间由 UTC API 值在前端转换为 local time，不把格式化字符串写回服务端或用于 cursor。
   当前 `LocalDateTime` 已覆盖 inbox、线程、详情、成员、用户、域名、连接、审计和 webhook
   页面；无时区的 D1 值显式按 UTC 解析，`If-Match`/cursor 继续使用原始值。
6. **验收。** 完成桌面/窄屏/暗色/键盘浏览器检查，确认 admin 与 mailbox Query cache 不串，
   主 bundle/CSS 与迁移前基线可比较，并在来源清单中记录所有复制文件的 MIT 声明。

## 明确禁止

- 不复制上游认证、示例业务、mock 数据、router 或部署配置；
- 不重新引入 Cloudflare Access、邀请注册或前端持久化 access token；
- 不为了套用模板把管理操作放进普通邮箱流程；
- 不在 UI 迁移阶段改变邮件 API、provider 状态机、D1 schema 或 Durable Object 边界。

## CAP-A2 退出证据

- 固定 commit、MIT 许可证和复制文件清单可追溯；
- `/admin/*` 与 `/mailbox/*` 各自有路由、权限、loading、403 和错误测试；
- 浏览器通过桌面、窄屏、暗色和键盘场景；
- 无跨用户/跨邮箱缓存泄漏、无明文 token 持久化、无业务 API 越权；
- `pnpm typecheck`、`pnpm lint`、`pnpm build:web` 和聚焦 UI 测试通过。
