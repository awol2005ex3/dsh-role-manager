# AGENTS.md — dsh-role-manager

DeepSeek Harness（`dsh`）角色管理插件。每个"角色"预设一份系统提示词，用户通过 Web 界面切换当前角色；宿主端按规则把活动角色注入系统提示词（对话未开始 → 替换；已进行 → 追加分节）。角色与选中状态持久化在 `~/.dsh/roles.yaml`。

本插件是**独立项目**（不进入 harness monorepo），采用 `tsc` 编译 + `scripts/wrap-client.mjs` 闭包工厂打包的"独立构建"工作流。任何改动都应遵循本文件约定，并优先参照 `.opencode/skills/dsh-plugin-dev/SKILL.md`。

---

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `src/index.ts` | **宿主半**（Node）。注册 `systemPrompt` 分节 + `connection.rpc.handle('/rpc', ...)` 端点。导出 `name / inject / Config / apply`。 |
| `src/store.ts` | `RoleStore`：读写 `~/.dsh/roles.yaml`（纯同步、无外部依赖，保证注入顺序可预测）。 |
| `src/client.ts` | **浏览器半**。自包含 bundle（**刻意无任何 import/export**），渲染角色面板，通过 `connection.rpc.call` 调用宿主。末尾 `module.exports = { name, inject, apply }`。 |
| `scripts/wrap-client.mjs` | 把 `lib/client.js` 包成 `window.__ModuleLoader__.load({ id, factory })` 惰性 CJS bundle。 |
| `cordis.patch.yml` | 把插件行 `id: role-manager / name: dsh-role-manager` 插入 profile 配置树。 |
| `package.json` | `dsh.bundle.patch` 指向 patch；`dsh.client.inject: ["@deepseek-ai/dsh-client-connection"]`；`exports["./client"]` 与 `exports["./package.json"]` 必填。 |
| `README.md` | 面向用户的安装 / 配置 / 使用说明。 |

---

## 常用命令

```bash
npm install                                   # 安装依赖（yaml / cordis / schemastery / typescript）
npm run build                                 # tsc -p tsconfig.json && node scripts/wrap-client.mjs
npm run typecheck                             # tsc --noEmit
npx @deepseek-ai/dsh plugin --profile web add .   # 链接进 web profile（link: 依赖）
npx @deepseek-ai/dsh --profile web --dump-config  # 校验插件树是否成功加载（修复 loader 错误后先看这个）
```

> **改任何源码后必须重启 host。** 插件集在 boot 时扫描并缓存。

---

## 核心约定（违反即破坏构建/运行）

1. **两半分离、独立构建。** 宿主逻辑只在 `src/index.ts`，浏览器逻辑只在 `src/client.ts`。两者不共享模块——`client.ts` 不能 `import` 宿主代码或任何 npm 包（打包器只传 `module` / `exports` 语义），因此**所需类型在两侧各自重复声明**（如 `RpcResult`、角色类型在 `client.ts` 内联定义）。
2. **`client.ts` 必须是纯脚本。** 不能有 `import` / `export` 语句（结尾的 `module.exports =` 由 wrap 脚本的 intro/footer 提供语义）。一旦出现 ESM 语法，`plain tsc` 产物会附带 `export {}`，破坏 classic-script 解析。
3. **所有注册可逆。** 用 `ctx.effect(() => () => {...})` / `ctx.on` 管理副作用与清理，便于 HMR / 卸载。
4. **插件元数据用具名导出。** `name` / `inject` / `Config` / `apply` 均为具名导出，禁止 `export default`（会丢失 `inject` 元数据）。
5. **不臆造 API。** 任何 harness 服务签名以 `.opencode/skills/dsh-plugin-dev/SKILL.md` 与 `../deepseek-harness/packages/...` 源码为准。

---

## API 契约速查

### 宿主 RPC（注册处理端）
```ts
ctx.connection.rpc.handle(
  '/rpc',
  (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult>,
  { authority: 'loopback' },          // 浏览器来源固定 loopback
) => disposer: () => Promise<void>     // 注意：直接返回 disposer 函数，不是 Promise<disposer>
```
- 请求信封：`payload` 形如 `{ args: Record<string, unknown> }`（客户端用 `call('/rpc','role-manager/<ep>',{args})`）。
- 响应信封：`RpcResult = { ok: boolean; value?: unknown; error?: { message: string } }`。
- 本插件端点前缀 `role-manager/`：`list` / `get` / `create` / `update` / `delete` / `switch`。

### 浏览器 RPC（发起调用）
```ts
ctx.connection.rpc.call('/rpc', `role-manager/${endpoint}`, { args }, signal?) => Promise<RpcResult>
```
客户端 `inject` 必须为 `['connection']`（在 `package.json` 的 `dsh.client.inject` 声明，且宿主 `inject: ['systemPrompt','connection']`）。

### 系统提示词注入
```ts
ctx.systemPrompt.section({ name, order, text, ...(complete ? { complete: true } : {}) })
// text 可以是函数：() => store.getActive()?.prompt ?? ''
```
- `complete: true` → 替换整段系统提示词；省略 → 作为分节**追加**。
- 本插件：对话未开始（`replaceBeforeStart` 且 `!conversationStarted`）用 `complete`，否则追加。`conversationStarted` 由 `agent/request` 事件置位（waterfall 钩子须 `return next()` 或短路）。

### 侧边栏挂载（Web）
- 稳定锚点：每个 slot 渲染站点都会包一层 `[data-slot="<key>"]` 的 `display:contents` 容器（见 harness `packages/client/ui-renderer/.../scoped-slots.tsx`）。本插件挂入 `sidebar.footer.action`。
- 用 `MutationObserver`（观察 `document.documentElement` `childList+subtree`）在 React 重渲染把节点挤出时重新挂回。
- 找不到该锚点时**回退为左下角浮动按钮**，功能不受影响。
- **不能**注册 React 形式的 slot 组件（独立 tsc 构建无 React/JSX），侧边栏只能通过稳定的 `data-slot` DOM 锚点注入。

---

## 如何扩展：新增一个 RPC 端点

1. 在 `src/index.ts` 的 `handler` 的 `switch` 中加一个 `case '<name>'`，从 `args` 取值、调用 `store`，`return { ok:true, value }`（失败 `try/catch` 已统一包裹）。
2. 在 `src/store.ts` 增加对应方法（保持纯同步、写完调用 `save()`）。
3. 在 `src/client.ts` 用 `callRpc(conn, '<name>', { ... })` 调用，并在面板 UI 绑定按钮 / 表单。
4. `npm run build` → 重启 host → 浏览器验证。

---

## 已知坑（踩过）

- `ctx.connection.handle(...)` **不存在** → 正确是 `ctx.connection.rpc.handle(...)`（`HostConnectionHandle.rpc: HostConnectionRpc`）。
- `rpc.handle` 返回值是 **disposer 函数** `() => Promise<void>`，不是 `Promise<disposer>`。原代码用 `.then(remove => ...)` 会失败。
- 浏览器 bundle 必须是惰性 CJS 闭包工厂；`exports["./package.json"]` 缺失会导致 Web 按钮静默 404（host 用 `require.resolve` 读元数据）。
- Web 端的 RPC 连通性与侧边栏挂载**只能在真实浏览器里验证**；本环境无法运行浏览器，相关改动需用户侧确认。
- patch 按 `id` **整体替换** `config`，不会深合并；改 `cordis.patch.yml` 时确保保留整行。

---

## 参考

- 插件开发技能：`.opencode/skills/dsh-plugin-dev/SKILL.md`（API 契约、模板、反模式权威来源）。
- harness 源码（只读参考，不要改）：`../deepseek-harness/packages/`
  - 客户端连接 RPC：`packages/client/connection/src/{rpc.ts,rpc-host.ts}`
  - 系统提示词服务：`packages/core/system-prompt/src/index.ts`
  - slot 渲染契约：`packages/client/ui-renderer/src/client/scoped-slots.tsx`（稳定 `data-slot` 锚点）
  - 侧边栏结构：`packages/client/ui-sidebar/src/client/SidebarRoot.tsx`
- 参考插件（同类独立构建）：`../dsh-md-table-export`
