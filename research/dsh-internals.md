# DSH 内部机制调研（task-2）

> 调研员：`dsh-internals`（子代理）。时间：2026-10-18。
> 目标：为 DSH Web UI 插件「侧边栏额度余额面板」（Host 半 + Client 半）确认侧边栏 slot、Host↔Client 契约、供应商配置/凭据读取、DeepSeek 账户余额、以及多插件 bundle 的官方约定。
> 环境：Windows；DSH 安装 `<DSH_ASAR>/dsh`（下文简称 `<ASAR>/…`，省略 `dsh/node_modules/@deepseek-ai/` 前缀时写作 `pkg:<name>/…`）；`DSH_HOME=<DSH_HOME>`，profile=`desktop`。
>
> **方法**：`read` 工具直接读取 asar 内文件；另用自写的纯 Node asar 解析器（仅解析 header + 单文件解出，见文末「复现方法」）把相关包解到临时目录后用 `Select-String` 全文检索；Host 侧用 `cordis_inspect_query`（Service/Tool/Config）核对运行时契约；`<DSH_HOME>` 下的真实配置文件直接读取。
> **限制**：Client Inspect（`Slots.listSubTree` / `Service.listService` / `Builtin.listBuiltins`）在本次调研期间**全部超时**（错误原文："Client inspect query … timed out after 10000ms. Open or reconnect the Harness page, then retry."），因此 slot 结论以已安装包源码 + `dsh-cordis-client-runner` 内置 slot 目录为准（后者正是 Client Inspect 的数据源，见 §1.4）。文中已标注不确定项。

---

## 0. 结论速览

1. **推荐落点：`sidebar.footer.action`**（`kind: "list"`, `scope: "root"`）。它是侧边栏底部 `footArea` 里 `settingsArea` **正上方**的常驻行容器，与「用户信息/账户」按钮（`settings.launcher` 的 `AccountMenu`）同属一个 foot 区。注册参数：`{ name, id, order, label }`；组件收到 ownerProps `{ wide: boolean }` + slot 标准 hooks（`useRemoteAccess`/`useResource`/`useSessions`/…）。官方已有占用者：`dsh-client-ui-cordis` 的 `CordisPanel`（id `cordis-panel`）。
2. **动态插件里的 `host.call` 不属于持久插件**。`host.call(method,args)` + `harness.handle(method,fn)` 是 `@deepseek-ai/dsh-cordis-client-runner` / `dsh-cordis-host-runner` 的「进程内动态 Cordis 包」契约：定义只存在于当前进程/会话，页面刷新即失效，本构建**没有**任何模型工具可以创建这种定义（Tool 目录无 `cordis_define`/`cordis_run`；`dsh-tool-cordis` 只有 2 个只读 inspect 工具）。持久插件（`plugin_manager install_bundle` 安装的 bundle）的 Client 半没有 `host.call`。
3. **持久插件的 Host↔Client 自定义 RPC，官方支持且鉴权完备**：Host 半 `ctx.connection.rpc.handle('/channel', handler)`；Client 半 `ctx.connection.rpc.call('/channel','endpoint',payload)`。返回契约是 JSON 的 `{ ok: true, value }` / `{ ok: false, error: { code, message, details } }`（**`code` 必须是 string、`details` 必须是对象**，否则浏览器侧解析直接抛 `invalid server-response failure`）。当前原型 `dshps` 正好用了这条通道，但有 3 处契约不符，见 §2.4。
4. **「已配置供应商」的唯一权威读法**：`ctx.configEditor.configuration()`（按 Loader entry 拿 `entry/inherited/override`）+ `ctx.settings.describe()`（按 entry id 拿 volatile 形式的当前值，pi-ai 即 `ns=='llm-pi-ai'` 的 `value.providers`）+ `ctx.llm.listConfigurableProviders()`（目录元数据：`settingsNs/settingsPath/declared/defaultBaseURL/baseURLEnv/nativeAuth`）+ `ctx.llm.listProviders()`（已注册的活路由）。**pi-ai 的 `providers` 字典是唯一配置面**，字段 `apiKeyEnv`（credential-ref）/`displayName`/`api`/`baseURL`/`models`；`apiKeyEnv` 只是凭据引用名，key 值用 `ctx.credentials.resolve(ref)` 取。持久化目标是 **profile 的 `cordis.patch.yml`**（不是 `settings.yaml`；旧的 `settings.yaml` 只会在启动时一次性导入并改名为 `settings.yaml.imported`）。
5. **DeepSeek 已登录账户余额可直接展示**：Host `ctx.deepseekAccount.getState()/getBalance(clientMetadata)`；Client `ctx.remote.account.getBalance({ version, locale, timezoneOffsetSeconds })`。`balance` 形状 `{ status:'ready', value:[{currency:'CNY'|'USD', balance:string}], bonusWallets:[同] } | { status:'failed' }`；这是 platform.deepseek.com 钱包（充值/赠金），与各 API-key 供应商余额是两套体系。账户 `profile` 只有 `{ id, avatarUrl, name, contact }`，**没有套餐/团队字段**——订阅/团队版只能走各厂商接口或 Platform 页面，见 task-1 文档。
6. **「一个项目多插件」官方约定**：一个 bundle 包 = `dsh.bundle.patch` + 一个 `dsh.client`（`platform/immediately/inject/external`）+ **恰好一个 `./client` 浏览器 bundle**（client-modules 以**包名**为 key，见 §5）。多插件靠 patch `insert` 多行：一行用**裸包名**（挂载 client 半，可顺带做 Host 行为），其余行用**子路径导出**（`pkg:name/plugins/foo`，纯 Host 插件）。子路径行不会被 client-modules 当成第二个 client 源（`locatePkgJson` 对裸子路径返回 undefined），因此不会触发 "resolves from multiple active Loader sources" 报错。子路径插件的展示元数据用 **父包** 的 `exports` 提供：`./<subpath>/locale/*.json`、`./<subpath>/icon`。当前原型 `dshps` 的结构（1 个根行 + 1 个 `dshps/plugins/dshp-quota` 子路径行 + 共享 `./client`）**符合官方约定**。

---

## 1. 侧边栏渲染结构、底部账户区、推荐 slot

### 1.1 侧边栏组件树（证据：`<ASAR>/dsh-client-ui-sidebar/lib/client.js`）

`SidebarRoot`（第 148–410 行）的底部结构（第 391–410 行，逐字摘录）：

```js
children: renderSlot("sidebar.workspaces", { wide, expandSidebar: ... })
...
(0, react_jsx_runtime.jsxs)("div", {
  className: SidebarRoot_module_css_default.footArea,
  children: [
    (0, react_jsx_runtime.jsx)("div", {
      className: SidebarRoot_module_css_default.footerActions,
      children: renderSlot("sidebar.footer.action", { wide })
    }),
    (0, react_jsx_runtime.jsx)("div", {
      className: SidebarRoot_module_css_default.settingsArea,
      children: renderSlot("sidebar.settings", { wide })
    })
  ]
})
```

即从上到下：

```
sidebar.footer.action      (list,  root)  ← 常驻、可多条、位于账户/设置行正上方
sidebar.settings           (single,root)  → SettingsRoot.triggerRow
   └─ settings.launcher    (single,root)  → AccountMenu（“用户信息/账户”按钮，ui-settings-account 注册）
   └─ settings.trigger     (single,root)  → 仅在 launcher 用 fallback 设置按钮时渲染其内容
```

`dsh-client-ui-sidebar/lib/client.js` 第 500–520 行声明（`ctx.slots.register({name:"sidebar", children:{…}})`）：

```js
"sidebar.panellist":       { kind: "list",   scope: "root" },
"sidebar.workspaces":      { kind: "single", scope: "root" },
"sidebar.settings":        { kind: "single", scope: "root" },
"sidebar.footer.action":   { kind: "list",   scope: "root" },
```

而「用户信息/账户」的组件是 `dsh-client-ui-settings-account` 的 **`AccountMenu`**：
- `dsh-client-ui-settings-account/lib/client.js` L4768：`ctx.slots.inject("settings.launcher", () => ctx.slots.register({ name:"settings.launcher", locale:"settings.account", inject:()=>operations }, AccountMenu))`
- `AccountMenu`（同文件 L1776+）注释原文：`/** Sidebar account launcher and locally authoritative sign-out action. */`；按钮 DOM：`button[aria-haspopup=menu]`，内含 `avatar`/`label`，菜单项 `settings / contact / signout|signin`。
- `dsh-client-ui-settings-general/lib/client.js` L1180–1265：`ctx.slots.inject("sidebar.settings", …)` 注册 `SettingsRoot`，并声明 children `settings.launcher`(single)/`settings.trigger`(single)/`settings.action`(list)/`settings.section`(list)…；`SettingsRoot`（L~330–460）渲染 `triggerRow`：
  ```js
  renderSlot("settings.launcher", { wide, settingsOpen: open, openSettings: actions.open,
    ...shortcut?.keys.length ? { settingsShortcut:{keys,aria} } : {},
    openOnboarding: (id) => { close(); setRequestedOnboarding(id) } },
    { fallback: <设置齿轮按钮，内容为 renderSlot("settings.trigger",{wide})> })
  ```
  因此 `settings.launcher` 有占用者时（=已安装 account UI 的桌面/Web 版），`settings.trigger` **不会渲染**。

### 1.2 候选落点对比

| slot | kind/scope | 渲染位置 | 是否常驻 | 结论 |
|---|---|---|---|---|
| **`sidebar.footer.action`** | list / root | `footArea > footerActions`，`settingsArea` 正上方 | 是（折叠态仍渲染，`wide=false`） | **推荐**：「用户信息上方」字面位置，追加式（不复用官方 id 就不会顶掉官方行） |
| `sidebar.panellist` | list / root | `logoRow` 下方的 `panelList`（顶部全局面板图标列表） | 是 | 不合适：离底部账户区远；且同 id 会要求 layout 的 `main` 有对应面板（`selectPanel` 找不到会抛错，见 ui-sidebar README L38） |
| `sidebar.workspaces.directoryFlow` | list / root，但由 `sidebar.workspaces` 占用者（ui-workspace）在其内部渲染 | 工作区/会话浏览器内部（目录选择器 flow） | 是（随 workspaces 常驻） | 备选：位置在滚动区内部，不保证贴底；语义属于目录选择流，不适合状态面板 |
| `sidebar.settings` | single / root | foot 最底部整行 | 是 | 不合适：会整体替换 `SettingsRoot`（含账户菜单），属于 `shadows-shipped-ui` 高风险替换 |
| `settings.launcher` | single / root | 账户菜单本身 | 是 | 不合适：替换账户按钮（`replaceRisk: shadows-shipped-ui`，官方占用者 `AccountMenu`） |
| `settings.trigger` | single / root | 设置触发按钮内容（launcher fallback 内） | **仅当 launcher 无占用者** | 不合适：有 account UI 时根本不渲染 |
| `settings.section` | list / root | 设置弹窗左侧导航 + 页面 | 否（设置打开时） | 备选：可做一个“额度”设置页，但不是常驻面板 |
| `shell.overlay` | — | 全屏 overlay（portal） | 否 | 只适合浮层（当前原型的展开详情可以继续用内部 popover，无需此 slot） |

### 1.3 推荐注册参数与可用 props

来源：`dsh-cordis-client-runner/lib/client.js` 内置 slot 目录（L5652–5700），这是 Client Inspect `Slots` 的原始数据：

```js
{
  key: "sidebar.footer.action",
  kind: "list", scope: "root",
  summary: "Optional actions beside Settings at the sidebar foot.",
  doc: "Optional actions beside Settings at the sidebar foot. Declared by this package's 'sidebar' entry; each action receives only the column state.",
  registerOptions: [
    { name: "id",    requirement: "required", type: "string", doc: "Your cell key. Use an id of your own: a fresh id is added beside the shipped entries, while reusing a shipped id puts you in THAT cell and replaces it. Owners that filter by id address you by it." },
    { name: "order", requirement: "optional", type: "number", doc: "Position among the entries, ascending (default 0)." },
    { name: "label", requirement: "optional", type: "string | (() => string)", doc: "Display text where the owner projects one (nav rows, tabs). A thunk is re-read on every projection, so localized text follows the active locale without re-registering." }
  ],
  ownerProps: ["export interface SidebarFooterActionOwnerProps { /** Whether the sidebar renders wide content (false = 56px rail). */ wide: boolean }"],
  declaredBy: "an entry in 'sidebar' (client-ui-sidebar), so it exists while that entry is mounted",
  occupants: ["client-ui-cordis CordisPanel id 'cordis-panel'"],
  replaceRisk: "none",
  example: "return { inject: ['slots'], apply(ctx) { ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(\n  { name: 'sidebar.footer.action', id: 'my-entry', order: 100, label: 'My entry' },\n  () => React.createElement('div', null, 'hello'),\n)) } }"
}
```

所有 slot 组件还会收到 slot 标准 hooks（同一目录的 `standardProps`）：`useRemoteAccess`、`useResource`、`useWorkspaces`、`usePanelInfo`、`useSessions`、`useSessionStatus`、`useSessionRetainInfo`、`useSessionAccess`、`useWorkspaceAccess`。组件在 `apply(ctx)` 闭包里可直接使用 `ctx`（当前原型即如此），因此 `ctx.connection.rpc`、`ctx.locale` 可用。

最小注册片段（与当前原型一致，见 `<repo>\client.js` L~580–595）：

```js
ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
  name: 'sidebar.footer.action',
  id: 'dshp-quota',
  order: 10,
  label: () => bound('title'),   // 可返回 thunk，随 locale 变化
  locale: 'dshp-quota',
}, (slotProps) => React.createElement(QuotaPanel, { ...slotProps, rpc })))
```

### 1.4 DOM / CSS（折叠态行为）

`dsh-client-ui-sidebar/lib/client.js` L~120–128 的 CSS 文本（内联 `data-plugin-css`）关键类名（hash 随版本变化，**不要依赖**，仅用于理解布局）：

- `._2H3hWW_footArea{flex-direction:column;flex:none;display:flex}`
- `._2H3hWW_settingsArea,._2H3hWW_footerActions{flex:none;width:100%;min-width:0}`；`footerActions{display:flex}`
- 折叠态（`._2H3hWW_collapsed`）`.footArea{align-items:center}`，两区 `justify-content:center;width:auto`；
- Windows titlebar 折叠态 `.footArea{display:none}`（`[data-windows-titlebar] .collapsed .footArea`）→ 折叠时该行会消失，符合预期；
- 注意：`sidebar.footer.action` 的占用者组件**必须自行适配 `wide=false`**（56px rail）；官方 `CordisPanel` 即按 `wide` 渲染 badge/图标。

> 不确定项：本次 Client Inspect 超时，未能在线核对当前桌面页的实际 slot 树/占用者；以上目录与源码均来自已安装包，若页面版本与 asar 不一致需重查。

---

## 2. Host ↔ Client 通信契约（核心）

### 2.1 先纠正前提：两套机制不要混用

| | **A. 持久 bundle（plugin_manager 安装）** | **B. 进程内动态 Cordis 包（cordis runner）** |
|---|---|---|
| Client 半格式 | `window.__ModuleLoader__.load({ id: '<包名>', factory(require){ … return {inject, apply(ctx)} } })`（`lib/client.js`，由 client-modules 作为站点 bundle 提供） | `define({ code: <Host 半源码>, clientCode: <浏览器半源码> })`：浏览器半是 **async 函数体**，参数为 `React, console, styles, host, harness, …traps`，**不是** ModuleLoader 格式 |
| Client 可用能力 | 正常浏览器环境 + Cordis Client ctx（`slots/locale/theme/remote/connection/configForms/…`）；`require('react')`、`require('@deepseek-ai/cordis')` | 固定符号面：`React/console/styles/host`（Builtin 目录还列了 `ctx`，但 evaluator 参数列表里没有 `ctx`，见 §7 不确定项）；`fetch/setTimeout/…` 被 teaching trap 替换成报错 |
| Host↔Client 调用 | `ctx.connection.rpc.handle/call`（§2.3）或既有 `ctx.remote.*` 命名空间 | `harness.handle(method, fn)` ↔ `host.call(method, args)` |
| 生命周期 | 持久（profile 级），HMR 热更，重启仍在 | 进程/会话内存，刷新页面需重新 run，重启消失；本构建无模型工具可创建 |
| 适用本任务 | ✅ 侧边栏常驻面板 | ❌ 仅适合临时演示 |

**证据（B 存在但不可持久/本构建无入口）**：
- `pkg:dsh-cordis-host-runner/README.md` L12/L28/L54/L59/L137：`"Host halves run in a node:vm realm; browser halves use the Client runner and approval UI. Definitions disappear on restart."`、`"The shipped Creator workflow uses installed bundles instead of this definition registry."`、`"Shipped model tools cannot create or update dynamic definitions."`
- `pkg:dsh-tool-cordis/README.md`：只暴露 `cordis_inspect_list` / `cordis_inspect_query` 两个只读工具；Host `Tool.listTools` 实测中无 `cordis_define`/`cordis_run`。
- `pkg:dsh-cordis-host-runner/lib/index.js` L516–531：`normalizeHandler(method, fn)`（`harness.handle`）：`"the handler name the package's browser half calls through host.call"`；`handler: async (args) => cloneJson(await rawHandler(args), …)`（仅 JSON）。
- `pkg:dsh-cordis-client-runner/lib/client.js` L147–220：evaluator 参数 `["React","console","styles","host","harness", …traps, "process","Buffer"]`；L6880–6910 的 `CLIENT_BUILTIN_INSPECTION`：`ctx`、`React`、`host`（`host.call(method: string, args?: JsonValue): Promise<JsonValue>`）、`styles.insert(css)`、`console`。
- `host.call` 的错误文案（同文件 L7281–7301）：`host.call("m") is not registered: the host half must declare it with harness.handle("m", fn).`；参数省略时 handler 收到 `null`；只允许 JSON。

> 若确实要写 B 类演示包：Host 半 `code` 形如 `async ({ harness }) => { … return { inject, apply(ctx){ harness.handle('balance', async (args)=>({ … })) } }`？——**具体签名本文未验证**（evaluator 把 `clientCode` 作为函数体、Host 半在 vm 里执行；本构建也没有可用的定义入口），不要按此实现。结论：走 A。

### 2.2 持久 bundle 的 Client 半实际能拿到什么

证据：`pkg:dsh-client-modules/README.md` L34/L50/L54/L72；`pkg:dsh-client-ui-settings-account/lib/client.js` L4415 `inject = ["slots","locale","remote","remote.account","remote.session","theme","configForms"]`；`pkg:dsh-client-connection/lib/client.browser.js` L1506 `const transport = globals.__DSH_TRANSPORT__` 与 `installConnection` 内 `ctx.provide("connection", handle)`。

- Factory 在**物化时**执行一次（`factory(require)` → exports，memoized），副作用应放进 `apply` 并用 `ctx.effect` 清理（`dsh-cordis-plugin-development/references/practices.md` L35–38：不要 `require('@deepseek-ai/dsh-client-ui-primitives')`，组件崩溃会清空你的 slot：console `slot entry crashed in '<slot>'`）。
- 已确认存在的 Client 服务/前缀：`slots`、`locale`、`theme`、`remote`（+ 各业务命名空间如 `remote.account`/`remote.session`/`remote.llm`/`remote.settings`/`remote.credentials`）、`connection`、`configForms`。
- **Client 侧可直接读的 Host Remote 命名空间（无需自定义 RPC）**：
  - `ctx.remote.llm.listProviders()` / `ctx.remote.llm.listConfigurableProviders()`：`dsh-client-ui-settings-models/lib/client.js` L1341–1342 原文使用。
  - `ctx.remote.settings.describe()`、`ctx.remote.settings.mutate(ns, ops, expectedRevision)`：Models 页写 provider 配置的真实路径（同文件 L1943、L2265、`NS$1='llm-pi-ai'`）。
  - `ctx.remote.credentials.describe({ refs: string[] })`（≤64）/ `ctx.remote.credentials.set(ref,value)` / `unset`：`pkg:dsh-api-settings-controller/lib/index.js` L148–160 的 `credentials.describe`；Remote 只回“是否配置/来源/可写”，**绝不回值**。
  - `ctx.remote.account.*`：登录、profile、余额、bonus、watch（§4）。

### 2.3 自定义 RPC（推荐给「Host 读 key 并查询余额」）

**Host 侧**（`pkg:dsh-client-connection/lib/index.js` L723–750, L888–940）：

```js
// Host service: ctx.connection（Host Service 目录亦可见：rpc / fetch / browserPeer / admit …）
get rpc() {
  const owner = this.ctx
  return { handle: (channel, handler) => this.register(owner, channel, handler),
           intercept: (channel, matches, handler) => this.registerInterceptor(owner, channel, matches, handler) }
}
get fetch() { return { register: (route) => this.registerFetchRoute(owner, route) } }
```

`register` 把通道挂成一个 webServer 前缀路由（`{kind:'prefix', path: channel}`），进入前先 `this.admit(req)`：**要求 loopback/Host-Origin fence + 已认证浏览器 cookie（或 API cookie）**，不是公开路由。`rpcFetchHandler`：

```js
async fetch(request, peer) {
  if (method !== 'POST' || content-type !== application/json) → 404/415;
  const envelope = clientRequestSchema.safeParse(body)   // { type:'client-request', rpcId, method, payload }
  if (message.method !== endpoint) → { ok:false, error:{ code:'gateway/bad-request', … } }
  try {
    const result = await handler(endpoint, message.payload, request.signal, peer)
    return fullResponse(message.rpcId, result)   // result.ok===true → success；否则 error
  } catch (e) { return new Response('handler failure: …', {status:500}) }
}
```

`channel` 规则：`CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/`（`/api` 保留，不能注册），endpoint 段 `[A-Za-z0-9_$.-]+`。

**Client 侧**（`pkg:dsh-client-connection/lib/client.browser.js` L1207–1240）：

```js
ctx.connection.rpc.call(channel, endpoint, payload, signal)
// POST `${channel}/${endpoint}`（相对当前页 origin，cookie 自动带上）
// 返回：{ ok: true, value } 或 { ok: false, error: { code, message, details } }
// rpcId 不匹配 / result 形状不合法 → 抛 TypeError
```

**最小可运行 Host 半**（bundle 根或子路径插件的 `index.js`）：

```js
/** @type {import('@deepseek-ai/cordis').Context} */
export const inject = ['connection']          // 只硬依赖 connection；其余用 ctx.get 软取
export function apply(ctx) {
  ctx.effect(() => ctx.connection.rpc.handle('/dshp-quota', async (endpoint, payload, signal, peer) => {
    if (endpoint === 'snapshot') {
      const snapshot = await buildSnapshot(ctx, { force: payload?.force === true, signal })
      return { ok: true, value: { snapshot } }        // ← 成功：{ ok:true, value:<任意 JSON> }
    }
    return { ok: false, error: { code: 'dshp-quota/bad-request',
                                 message: `unknown endpoint ${endpoint}`, details: {} } }
  }), 'dshp-quota: rpc channel')
}
```

**最小可运行 Client 半**：

```js
window.__ModuleLoader__.load({
  id: 'dshps',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        const rpc = ctx.get('connection')?.rpc
        const bound = ctx.locale.bind('dshp-quota')
        ctx.effect(() => ctx.locale.register('dshp-quota', { zh, en }), 'locale')
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
          { name: 'sidebar.footer.action', id: 'dshp-quota', order: 10, label: () => bound('title'), locale: 'dshp-quota' },
          (props) => h(Panel, { ...props, rpc }),
        ))
      },
    }
  },
})

async function load(rpc) {
  const result = await rpc.call('/dshp-quota', 'snapshot', { force: false })  // { ok, value?, error? }
  if (!result.ok) throw new Error(result.error.message)
  return result.value.snapshot
}
```

**错误处理规则（务必照做）**：
- 业务错误 **return** `{ ok: false, error: { code: '<string>', message: '<string>', details: {} } }`；浏览器 `parseConnectionResponse` 强制校验：`typeof error.code === 'string' && typeof error.message === 'string' && isRecord(error.details)`，任一不满足会抛 `TypeError: connection: invalid server-response failure`（客户端只能显示这条泛化错误）。
- **不要 throw**：handler 抛错时 Host 返回 HTTP 500 纯文本 `handler failure: …`，客户端得到 `transport failure for /ch/ep: HTTP 500`，丢失原始错误语义。
- 成功值必须放在 `value` 下；`fullResponse` 会把 `ok:true` 的结果原样放进 `result`，客户端只读 `value`（以及可选 `attachments`，二进制附件本文不涉及）。

**替代方案（不推荐，作为备选）**：
- `ctx.connection.fetch.register({ path: '/api/<...>', methods: ['POST'], requestBody: 'buffered', fetch(request) { return Response.json(...) } })`：精确 Fetch 路由（`assertFetchRoute` 要求路径能被 `endpointFromPath('/api', path)` 解析，即 `/api/…`），浏览器可直接 `fetch`；但需自己处理鉴权（该路由在 `createSharedFetchHandler` 中先按 pathname 命中，owner principal 校验由调用方 `fetch(request, peer)` 保证），且 Desktop `file://` 场景不等于 `connection.rpc` 的 transport 抽象。
- `ctx.webServer.register({ kind:'prefix', path:'/plugins/<my>/api', handler(req,res) })`：原生 node:http 路由，**无鉴权**（README 明确 "No server-wide authentication or origin policy — route owners enforce their own request policy"），不推荐。
- 依赖 `dsh-api-remotes` 生成新的 Typert Remote 命名空间：需要 TS 代码生成产物（`./typert` / `./remote`）并在 `@deepseek-ai/dsh-api-remotes` 构建期显式 import/mount，且 README 明确 "The capability set is fixed by explicit build-time value imports; the Client does not discover…"——纯 JS 第三方 bundle 不可行。

### 2.4 对当前原型 `dshps` 的契约校验（重要）

原型已选用正确通道（`plugins/dshp-quota/index.js` L1051 `ctx.connection.rpc.handle('/dshp-quota', …)`，`client.js` L~451 `rpc.call(CHANNEL, force?'refresh':'snapshot', {force})`）。但有 3 处会导致「客户端永远拿不到数据 / 只显示泛化错误」：

1. **成功包络缺 `value`**：Host handler `return await service.snapshot(force, signal)`，而 `snapshot()` 返回 `{ ok:true, cache, snapshot }`（L987–1013）。按 §2.3，`fullResponse` 只透传 result，客户端读的是 `envelope.value`，因此 `payload` 恒为 `undefined`，客户端走 `setRpcError('query failed')`。
   **修复**：handler 返回 `{ ok: true, value: await service.snapshot(force, signal) }`（客户端 `payload.ok/snapshot` 逻辑即可生效），或客户端改读 `envelope.snapshot`（不建议，偏离公共契约）。
2. **错误对象形状不合法**：`{ ok:false, error:{ category:'http', message } }` 缺 `code`（string）与 `details`（对象），浏览器解析抛 `invalid server-response failure`。
   **修复**：统一为 `{ ok:false, error:{ code:'dshp-quota/http', message, details:{} } }`（可另放 `category` 自定义字段，但 `code/message/details` 必须齐）。
3. **endpoint 名不一致**：客户端强制刷新发 `'refresh'`，Host 只处理 `'snapshot'`/`'diag'` → 收到 `bad-request`。**修复**：Host 接受 `'refresh'`（等价 `snapshot` + force），或客户端一律发 `'snapshot'` 用 payload.force 区分。

另两处建议（非阻塞）：
- Host `inject` 硬依赖 `webServer`（`plugins/dshp-quota/index.js` L1047），该服务只在 Web 组合存在；更稳的是 `inject:['connection']`，其余用 `ctx.get(...)` 软取（原型其余代码已是软取风格）。
- 客户端 `label: () => bound('title')` 合法（label 支持 thunk，见 §1.3）；样式请用 `document.createElement('style')` 挂 `data-plugin-css` 并在 `ctx.effect` 里移除，或使用主题 token（`--dsw-alias-*`），不要读别的插件 DOM。

---

## 3. 已配置供应商：存储、结构、枚举、凭据

### 3.1 持久化位置：profile 的 `cordis.patch.yml`（不是 settings.yaml）

- `pkg:dsh-settings/README.md` L12：`"Changes persist through the active profile’s Cordis patch."`；`pkg:dsh-settings/lib/index.js` L343–363：启动时把 `<DSH_HOME>/settings.yaml` 一次性导入后 `rename` 为 `settings.yaml.imported`（旧版本可能残留该文件，内容仅 `ui-onboarding/agent-default-model/ui-conversation/pet` 等旧 section）——**这是旧格式残留，不是现行存储**。
- 真实存储：`<DSH_HOME>\profiles\desktop\cordis.patch.yml`（用户 patch 层，存放 Settings/Models 页写入的个性化配置；具体值已省略）。另有更高优先级层 `<DSH_HOME>\cordis.patch.yml`（home 层，可包含用户级 MCP/插件 insert）。
- `pkg:dsh-config-editor/README.md` L12：`"Save plugin configuration in the active profile’s patch and apply it immediately."`；`dsh-settings` 与 `dsh-config-editor` 都要求 `profileContext`（非 profile 启动时不激活）。

### 3.2 pi-ai 的 `providers` 配置结构（唯一配置面）

运行时 Schema（`cordis_inspect_query Config.listConfigs`，entry `include:llm-pi-ai` → packageDir `<ASAR>/dsh-llm-pi-ai`；完整 schema 已存 spill，结构摘录）：

```jsonc
{
  "providers": {                       // x-cordis.volatile: true  ← Settings 表单可编辑/热更新
    "<route>": {                       // 请求时 GenerateOptions.provider 选中的路由名
      "apiKeyEnv": "MINIMAX_API_KEY",   // x-cordis.role: "credential-ref"（只是引用名，不是密钥）
      "displayName": "MiniMax",
      "api": "openai-completions" | "openai-responses" | "anthropic-messages",
      "baseURL": "https://api.minimax.io/anthropic",
      "models": [{ "id": "...", "name": "...", "contextWindow": 262144, "maxTokens": 32768,
                   "input": ["text","image"], "reasoningEfforts": { "off": ..., "high": "high" } }],
      "retryPolicy": { "mode": "normal", "maxRetries": 5, ... }
      // 另有 modelOverrides/compat/requestImage*/defaultContextWindow/defaultMaxTokens/headers/timeoutMs/...
    }
  }
}
```

文档（`pkg:dsh-llm-pi-ai/README.md` L28/L38/L75–89）：`"The `providers` dictionary is the whole configuration surface: each key is the provider route name…"`；`apiKeyEnv` 每请求经 credential seam 解析；缺失 → `MISSING_CREDENTIAL`。

本机现状：profile patch / home patch 均**没有** `llm-pi-ai` section；`agent-default-model.provider = deepseek-account`（即只有 DeepSeek 登录账户路由活跃，pi-ai 处于 README 所述 "dormant posture"：0 路由）。因此插件不能硬编码四家，必须运行时枚举；用户需先在「设置 → 模型」里添加供应商（Models 页写入 `llm-pi-ai.providers.<route>`，key 由 `credentials.set(ref,key)` 单独存）。

### 3.3 枚举已配置供应商的四条读法

**Host 侧（推荐，插件自己聚合一次）**：

```js
export const inject = ['settings', 'llm', 'credentials']   // configEditor 可软取
export function apply(ctx) {
  const piAiEntry = () => ctx.configEditor?.configuration?.()
    ?.find((row) => row?.entry?.options?.name === '@deepseek-ai/dsh-llm-pi-ai')
  const ns = () => piAiEntry()?.entry?.options?.id           // 期望 'llm-pi-ai'（见下「不确定项」）
  const descriptor = () => ctx.settings.describe().find((d) => d.ns === ns())
  const catalog = () => ctx.llm.listConfigurableProviders() // 目录元数据（含未配置的内置 provider）
  const active = () => ctx.llm.listProviders()              // 已注册的活路由

  function configuredProviders() {
    const providers = descriptor()?.value?.providers ?? {}  // ← Settings 镜像里的当前值
    const directory = catalog()
    const activeIds = new Set(active().map((p) => p.id))
    return Object.entries(providers).map(([route, profile]) => {
      const meta = directory.find((d) => d.provider === route)
      return {
        route,
        displayName: profile.displayName ?? meta?.displayName ?? route,
        baseURL: profile.baseURL ?? meta?.defaultBaseURL,     // 内置目录路由可省 baseURL
        api: profile.api,
        declared: meta?.declared === true,                    // true=手写路由（非内置 catalog）
        nativeAuth: meta?.nativeAuth,                          // { env: string[], oauth: boolean }
        apiKeyEnv: profile.apiKeyEnv,                          // credential ref 名（不是密钥）
        active: activeIds.has(route),
      }
    })
  }
}
```

字段来源证据：
- `ctx.settings.describe()`：`pkg:dsh-settings/lib/index.js` L409–464，返回 `[{ ns, schema, revision, applies:'live', value, base, user, autoGenerate, secrets? }]`；`value` 是 `entry.fiber.config` 的 volatile 投影，所以含 `providers`（`apiKeyEnv` 保留为引用字符串，`role:"secret"` 字段才会被 redact；对本地调用默认不 redact）。
- `ctx.llm.listConfigurableProviders()`：`pkg:dsh-llm-pi-ai/lib/index.js` L~750–790 `directoryEntries()` 构造：
  ```js
  { provider, displayName, settingsNs, settingsPath: ['providers', provider],
    declared: installed === void 0,
    ...providerDefaultsOf(installed),   // defaultBaseURL / baseURLEnv / nativeAuth:{env,oauth}
    ...error }
  ```
  `ctx.llm.listProviders()`：Host Service 目录签名 `@Remote listProviders(): LlmProviderInfo[]`（`LlmProviderInfo` ≈ `{ id, name }`，`joinProviderDirectory` 使用 `provider.id/provider.name`）。
- `ctx.configEditor.configuration()`：`pkg:dsh-config-editor/lib/index.js` L30–52，返回 `[{ entry, inherited, override }]`；`entry.options.id` 是 patch 行 id、`entry.options.name` 是模块名、`entry.options.config` 是本层原始 config。注意 `entries()` 只列父树是 `include` 的 Loader 行（L31），所以该 API 在 profile 组合里可用。

**Client 侧（如果不想全走 RPC）**：`ctx.remote.llm.listProviders()`、`ctx.remote.llm.listConfigurableProviders()`、`ctx.remote.settings.describe()`（Remote 版会 `redactSecrets:true`，`apiKeyEnv` 是 credential-ref 仍可见、secret 字段被替换为标记）、`ctx.remote.credentials.describe({ refs })`（只回 presence）。**但余额查询必须在 Host 做**（需要 key 明文 + 厂商 API 可能无 CORS；见 §4/§7）。

### 3.4 凭据读取（正确方式）

**存储**：`<DSH_HOME>\.credentials.yaml`（`pkg:dsh-credentials-local/lib/index.js` L33–60 注释：`$DSH_HOME/.credentials.yaml` **优先于** 进程环境、`<cwd>/.env`、`$DSH_HOME/.env`；文件 0600，Windows 跳过权限检查）。当前实际文件（密钥已脱敏，仅示意结构）：

```yaml
version: 1
refs:
  DEEPSEEK_API_KEY: sk-****                                   # ← apiKeyEnv 指向这里
records:
  client-connection/browser-session: { kind: grant, payload: { version: 1, secret: '****' } }
  deepseek-account-platform/device:   { kind: grant, payload: { id: '****' } }
  deepseek-account-platform/default:  { kind: grant, payload: { version: 1, token: '****', issuer: 'https://platform.deepseek.com' } }
```

**API**（`pkg:dsh-credentials/README.md` L48–81；签名来自 Host Service 目录）：

```js
// 引用（refs 空间，POSIX 标识符；运行时就是字符串，brand 只在 TS 类型层）
const hit = await ctx.credentials.resolve('DEEPSEEK_API_KEY') // → { value: string, source } | undefined
const info = await ctx.credentials.describe('DEEPSEEK_API_KEY') // → { configured, source?, writable }，永远不含 value
// 记录（records 空间，<owner>/<id>）
const rec = await ctx.credentials.readRecord('llm-pi-ai/minimax') // → undefined | { kind:'api-key', key?, env? } | { kind:'grant', payload }
const rows = await ctx.credentials.listRecords()                  // [{ key, kind }]（不到值）
```

- `credentialRef(name)` / `credentialKey(scope,id)` 是 brand 辅助函数：`pkg:dsh-credentials/lib/index.js` L17–71 只做正则校验后**返回原字符串**，因此 Host 纯 JS 插件可直接传字符串，无需 import。
- pi-ai 的 key 解析顺序（`pkg:dsh-llm-pi-ai/lib/index.js` L~820 `resolveApiKey`）：`apiKeyEnv` → `credentials.resolve(ref)`（失败回退 `launchEnvironmentOf(ctx).get(ref)`）；若路由未写 `apiKeyEnv`，走 pi-ai 登录记录 `llm-pi-ai/<provider>`（`credentialKey`，`toPiCredential`：`api-key` → `{key,env}`，`grant` → OAuth payload）。**插件要兼容这两种**：

```js
function deriveKeyRef(route) {  // 与 Models 页 CustomProviderCard 完全一致
  return `${route.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}
async function resolveProviderKey(ctx, route, profile) {
  const ref = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.length > 0
    ? profile.apiKeyEnv : deriveKeyRef(route)
  const hit = await ctx.credentials?.resolve?.(ref)
  if (hit?.value) return { key: hit.value, source: `ref:${ref}` }
  const rec = await ctx.credentials?.readRecord?.(`llm-pi-ai/${route}`)
  if (rec?.kind === 'api-key' && typeof rec.key === 'string') return { key: rec.key, source: 'record:api-key' }
  if (rec?.kind === 'grant') return { grant: rec.payload, source: 'record:grant' }  // OAuth：厂商余额接口多半用不了
  return { key: undefined, source: 'missing' }
}
```

证据：`deriveKeyRef` 见 `pkg:dsh-client-ui-settings-models/lib/client.js` L~1230（`UPPER.replace(/[^A-Z0-9]+/g,'_') + '_API_KEY'`，注释 `"storage under this derived reference and the profile records it as apiKeyEnv"`）。

### 3.5 四家候选的内置 provider 元数据（来自 pi-ai 生成的 `PROVIDER_DATA`）

`pkg:dsh-llm-pi-ai/lib/index.js` L~2600–2790（`provider-data.generated`，`"do not edit"`）：

| route | env（apiKeyEnv 常用值） | 默认 baseURL |
|---|---|---|
| `deepseek` | `DEEPSEEK_API_KEY` | `https://api.deepseek.com` |
| `minimax` | `MINIMAX_API_KEY` | `https://api.minimax.io/anthropic` |
| `minimax-cn` | `MINIMAX_CN_API_KEY` | `https://api.minimaxi.com/anthropic` |
| `kimi-coding` | `KIMI_API_KEY` | `https://api.kimi.com/coding` |
| `moonshotai` / `moonshotai-cn` | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` / `https://api.moonshot.cn/v1` |
| `zai`（智谱国际） | `ZAI_API_KEY` | `https://api.z.ai/api/coding/paas/v4` |
| `zai-coding-cn`（智谱 Coding CN） | `ZAI_CODING_CN_API_KEY` | `https://open.bigmodel.cn/api/coding/paas/v4` |

识别建议：**优先按 route id 识别**（用户添加供应商时 route 由用户命名，Models 页内置 catalog 默认 route 就是上表 key；手写路由 `declared:true`），其次按 `baseURL` host 白名单映射（task-1 文档已有域名→供应商表），最后再按 displayName 文本。当前原型 `dshp-quota/index.js` L17–30 的 `VENDOR_LABELS/SUPPORTED_VENDORS` 即按此思路，建议把 `api/baseURL` 也纳入识别条件。

---

## 4. `deepseekAccount`：已登录账户余额（可作为「DeepSeek 余额」直出）

### 4.1 服务与 Remote 契约

Host Service 目录（`cordis_inspect_query Service`，key `deepseekAccount`；`pkg:dsh-deepseek-account/README.md`）：

```
getState(): Promise<AccountView>
getProfile(client: AccountClientMetadata): Promise<AccountDetails['profile'] | null>
getBalance(client: AccountClientMetadata): Promise<AccountDetails['balance'] | null>
getUnnotifiedBonuses(client) / ackBonusNotified(accountId, orderId, client) / startSignIn / cancelSignIn / signOut / watch(signal, includeIdentityChanges?) / resolveToken(url) / getPlatformSession()
```

`AccountClientMetadata`（客户端构造，`pkg:dsh-client-ui-settings-account/lib/client.js` L2841）：

```js
{ version: '<DSH_CLIENT_VERSION>', locale: '<active locale>', timezoneOffsetSeconds: -(new Date()).getTimezoneOffset()*60 }
```

Client Remote（`pkg:dsh-api-account-controller/README.md` L23）：`ctx.remote.account.getState / getProfile / getBalance / getUnnotifiedBonuses / ackBonusNotified / startSignIn / cancelSignIn / signOut / watch / watchExpiry / hasRunningAccountTasks`；`getBalance` 等“到达 Platform 的操作”必须带上面的 metadata（Host 转成 5 个 Platform client headers）。Remote 结果仍是 `{ok,value}` / `{ok,error}`。

### 4.2 返回结构（余额）

`pkg:dsh-deepseek-account-platform/README.md` L39：`getProfile/getBalance` 发 `x-dsh-auth-token` 到 `GET /api/v0/users/get_user_summary`，Host 只投影 `normal_wallets / bonus_wallets` 的 `currency/balance` 字符串。`pkg:dsh-deepseek-account-platform/lib/index.js` L330–405：

```js
const wallet = z.object({ currency: z.enum(["CNY","USD"]),
                          balance: z.string().regex(/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i) })
queries.balance = { path: "/api/v0/users/get_user_summary",
  parse: (value) => ({ status: "ready", value: parsed.normal_wallets, bonusWallets: parsed.bonus_wallets }) }
```

因此 Host `getBalance()` 的值形如：

```jsonc
// 成功
{ "status": "ready",
  "value":       [ { "currency": "CNY", "balance": "123.45" } ],   // 充值余额（normal_wallets）
  "bonusWallets":[ { "currency": "CNY", "balance": "5.00"  } ] }   // 赠金余额
// 失败（请求超时/校验失败等，不会伪造 0）
{ "status": "failed" }
// 未登录
null
```

客户端展示参考（`pkg:dsh-client-ui-settings-account/lib/client.js` L2461–2630）：`details.balance.status==='ready'` → `details.balance.value`（`formatBalance(wallet.balance, wallet.currency==='CNY'?'¥':'$')`），赠金 `bonusWallets.filter(w=>Number(w.balance)>0)`；失败时渲染「前往 Platform 查看」链接。实际账户 UI 的形状是 Client 侧 `refresh()` 调 `ctx.remote.account.getBalance(client)` 得到 `{ok,value}` 后把 `value` 放进 `details.balance`（同文件 L~4500 区域）。

### 4.3 与 API-key provider 余额的区别

| | DeepSeek 登录账户（deepseek-account） | API-key 供应商（pi-ai 路由） |
|---|---|---|
| 凭据 | `.credentials.yaml` 的 `deepseek-account-platform/default` grant（x-dsh-auth-token，Platform 域） | `.credentials.yaml refs.<apiKeyEnv>` 或 `records.llm-pi-ai/<route>` |
| 查询方 | **Host 服务已内置**：`ctx.deepseekAccount.getBalance(meta)`；Client 直接 `ctx.remote.account.getBalance(meta)` | 需插件在 Host 进程自己发 HTTP（各家 `/user/balance` 等，见 task-1 文档） |
| 能显示的字段 | 充值余额、赠金余额、头像/名称/掩码手机或邮箱、bonus 通知、配额（`ACCOUNT_QUOTA`） | 取决于厂商接口：余额/额度/套餐/团队，通常没有统一 schema |
| 团队/订阅 | `getProfile` 只有 `{id, avatarUrl, name, contact}`，**无套餐/团队字段**；只能通过 Platform 嵌入页或厂商接口 | task-1 文档：智谱/GLM、Kimi、MiniMax 的订阅/团队接口多为社区逆向或不可确认 |
| 结论 | **可以且应该直接展示已登录账户余额**（零网络代码，Host/Client 都行；推荐 Client 直接 `ctx.remote.account.getBalance` 或 Host 聚合后随 RPC 返回） | 需要 Host 自定义 HTTP + 凭据解析，且必须容错（凭据无效/站点不匹配/接口下线） |

补充：账户 token 失效会发 `deepseek-account/session-expired`；配额不足会发 `ACCOUNT_QUOTA` 并落到 `shell.quota-notice` slot（`pkg:dsh-client-ui-settings-account/lib/client.js` L4746–4752 注册 `AccountQuotaNotice`）。插件若要“订阅/团队版展示”，账户侧只能显示 Platform 页面链接；真正的套餐/团队信息建议作为各厂商 capability 的 `unknown/unsupported` 状态处理（task-1 已给出可信度标注）。

---

## 5. 「一个项目多插件」：bundle / patch / subpath / dsh.client

### 5.1 官方约定（证据）

1. **bundle 清单**：`pkg:dsh-agent-preset/skills/cordis-plugin-development/references/host-plugin.md` L1/L20–27：
   ```yaml
   # package.json
   { "type":"module", "exports": { ".":"./index.js" },
     "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }
   # cordis.patch.yml
   - insert:
       - id: my-plugin
         name: '@local/my-plugin'
   ```
   安装：`plugin_manager action=install_bundle target=<包目录绝对路径>`（skill 规定；`pkg:dsh-plugin-manager/README.md` L31–64 说明安装/启停/`application`/`restart-required` 语义）。**不要**手写 profile 的 `package.json`/`cordis.patch.yml` 或跑 pnpm。
2. **patch `insert` 可多行 / 嵌套 group**：
   - `pkg:dsh-experimental-plugin-market-bundle/cordis.patch.yml`：一次 insert 两行（`plugin-market` + `ui-plugin-market`）。
   - `pkg:dsh-experimental-ralph-bundle/cordis.patch.yml`：`insert` 一个 `cordis:group`，其 `config` 内再插两行。
   - `pkg:dsh-base/cordis.patch.yml`：单次 insert 上百行（整个 base 组合）。
3. **subpath 插件真实样例**（同一包用子路径导出多个插件）：
   - `@deepseek-ai/dsh-plugin-manager/tools`（`pkg:dsh-base/cordis.patch.yml` 中 `tool-plugin-manager` 行）——`pkg:dsh-plugin-manager/package.json` exports 有 `"./tools"`、`"./tools/locale/*.json"`，`files` 含 `locale/tools/*.json`。
   - `@deepseek-ai/dsh-tool-subagent/model-selection-settings`（`pkg:dsh-web-app/cordis.patch.yml`）。
4. **`dsh.client` 是单对象**（`pkg:dsh-client-modules/lib/index.js` L58–75 `parseDshClient`）：只接受 `platform`(string)、`inject`(string[])、`external`(string[])、`immediately`(boolean)。实测包里没有 “多个 client 条目” 的写法；**一个包只能有一个 `./client`**（`clientExportOf(packageName, pkg.exports)`，缺失即报 `declares dsh.client but exports no "./client" bundle`）。
5. **client-modules 以“包名”为 key，且同一包只允许一个 client 源**（`pkg:dsh-client-modules/lib/index.js`）：
   - `resolveMeta(loaderName)` → `locatePkgJson`：裸子路径 specifier（`pkg/sub`）`expectedPackageName===undefined && !pathLike` → **直接 return undefined**（L~720–760）→ 子路径行不产生 client 源；
   - `reconcilePackage(packageName)` L~895：同一包出现 >1 个 source（例如根行 + 一个 **path 形式** 的同一包行）→ 抛 `client-modules: package X resolves from multiple active Loader sources … remove one entry`；
   - `this.table.set(packageName, …)` L~902：client bundle id = **包名**（`graphRow(packageName, …)`）。
   → 结论：**要挂 client 半，必须有一个以裸包名命名的 Loader 行**；其余插件只能做子路径行（纯 Host）。

### 5.2 推荐目录结构与清单（与当前 `dshps` 原型一致的官方形态）

```
dshps/                                  ← bundle 包（package.json name=dshps）
├─ package.json
├─ cordis.patch.yml                     ← insert: 1 根行 + N 子路径行
├─ index.js                             ← 根行 Host 半（可空 apply；作用：挂载 ./client）
├─ client.js                            ← 唯一浏览器半；注册所有 dshp-* 的 slot 入口
├─ icon.svg                             ← 包根图标（package.json 顶层 icon 优先）
├─ locale/{en,zh}.json                  ← 包根 meta.title/description
└─ plugins/
   ├─ dshp-quota/
   │  ├─ index.js                       ← Host 半（子路径插件，行名 dshps/plugins/dshp-quota）
   │  ├─ icon.svg                       ← 子路径图标（父包 exports "./plugins/dshp-quota/icon"）
   │  └─ locale/{en,zh}.json            ← 子路径 meta（父包 exports "./plugins/dshp-quota/locale/*.json"）
   └─ dshp-other/…
```

`package.json`（当前原型，已验证字段正确）：

```json
{
  "name": "dshps", "version": "0.1.0", "private": true, "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./plugins/dshp-quota": "./plugins/dshp-quota/index.js",
    "./plugins/dshp-quota/locale/*.json": "./plugins/dshp-quota/locale/*.json",
    "./plugins/dshp-quota/icon": "./plugins/dshp-quota/icon.svg"
  },
  "files": ["index.js","client.js","cordis.patch.yml","locale/*.json","icon.svg","plugins/**/*"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true,
                "inject": ["@deepseek-ai/dsh-client-connection","@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-sidebar"] }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: dshp-collection                 # 根行：裸包名，挂载 browser bundle
      name: dshps
    - id: dshp-quota                      # 子路径插件行：纯 Host 功能
      name: dshps/plugins/dshp-quota
      # config: { ... }                    # 若子路径 index.js 导出 Config 才需要
```

注意事项：
- 行 `name` 写 **包名/子路径**（安装后从 profile 的 `link:` 依赖解析）；`id` 是 profile patch 层用来覆盖的稳定 id。
- 根行 `index.js` 就算空 apply 也**必须存在**且可加载，否则整包与 client 半都不组合。
- `dsh.client.inject` 只做**激活顺序**声明（不是 import），可列已安装的 client 包名；`external` 仅用于非基线 import（本插件用 `require('react')` 不需要）。
- 新装/替换：`plugin_manager install_bundle`（路径安装是 `link:`，代码改动可直接生效但**新增/替换 JavaScript 模块代际**有时需要重启；结果字段 `application`/`nextStep` 为准）。**不要**手工写 profile。

### 5.3 子路径插件的展示元数据（locale/icon）导出约定

`references/host-plugin.md` L31–51 原文：
- 包根插件：`./locale/*.json` + `./icon`（或 package.json 顶层 `"icon": "./icon.svg"`，优先于 `./icon`）。`meta.title`、`meta.description` 必须写；locale 用 `{ "meta": { "title": "...", "description": "..." } }`（模板 `templates/decoration/locale/en.json` 逐字如此）。
- **子路径插件不是 package，不读自己的 package.json**：它从**父 bundle 包**的 exports 里取 `./<subpath>/locale/*.json` 与 `./<subpath>/icon`（例如 `plugin_manager/tools` 的 `./tools/locale/*.json`）。
- 图标：SVG/PNG/JPEG/WebP，≤256 KiB，路径必须在包内；绝对路径、URL、指向包外的 symlink 会被拒绝；缺失则用默认图。安装后在 Plugin Manager / Settings 插件清单核对标题/描述/图标（英文 + 用户语言）。

---

## 6. 其它官方样例（可抄）

1. **最小 bundle 模板**：`pkg:dsh-agent-preset/skills/cordis-plugin-development/templates/decoration/{package.json,cordis.patch.yml,index.js,client.js,locale/en.json,icon.svg}`——Host `index.js` 只有 `export function apply() {}`；client.js 即 `__ModuleLoader__.load` + `ctx.slots.inject('conversation.composer.dock', …)`。
2. **真实 `sidebar.footer.action` 占用者**：`pkg:dsh-client-ui-cordis/lib/client.js`（内置 CordisPanel），README L32：`"A sidebar.footer.action seat shows a badge counting what runs plus what waits; opening it lists every definition…"`——可作为「底部展开面板」的组件写法参考（但它是单包单 client 的官方包）。
3. **Client→Host 远程读样例**：`pkg:dsh-client-ui-settings-models/lib/client.js`（`ctx.remote.llm.*` / `ctx.remote.settings.*` / `ctx.remote.credentials.*` 全链路）；`pkg:dsh-client-ui-settings-account/lib/client.js`（`ctx.remote.account.*` + stream `ctx.remote.$stream({name:'account', open: …})`）。
4. **Host 侧聚合样例**：当前原型 `plugins/dshp-quota/index.js`（settings/llm/configEditor/credentials 四路读取 + 厂商 HTTP + RPC），修掉 §2.4 的 3 处即可作为最终实现基础。

---

## 7. 不确定项 / 风险

1. **Client Inspect 全部超时**：`Slots.listSubTree`、`Service.listService`、`Builtin.listBuiltins` 均 10s 超时（本次会话期间重复 3 次）。slot 结论以 asar 源码 + client-runner 内置目录为准；若页面版本与安装版本不一致，需在页面恢复后用 Client Inspect 复核。
2. **pi-ai settings namespace 的准确 id**：理论上 = `ctx.fiber.entry?.options.id`（`pkg:dsh-llm-pi-ai/lib/index.js` L~773 `const settingsNs = ctx.fiber.entry?.options.id ?? NS`），而在本 profile 的 Loader 投影里该 entry 的 **patchId=`llm-pi-ai`、Loader entry id=`include:llm-pi-ai`**（`Config.listConfigs` 实测）。`settings.describe()` 用的是 `entry.options.id`（=`llm-pi-ai`，与 base patch 行 id 一致），但**建议插件按 `entry.options.name === '@deepseek-ai/dsh-llm-pi-ai'` 反查 descriptor，而不是硬编码 ns 字符串**（当前原型已这样处理，稳妥）。
3. **动态包 Builtin 的 `ctx`**：`CLIENT_BUILTIN_INSPECTION` 列了 `ctx`，但 `evaluateClientHalf` 的参数里没有 `ctx`（只有 apply(ctx) 的 ctx）。可能文档滞后或另有注入路径，未验证；与持久插件无关。
4. **`ctx.remote.llm` 是否一定 mounted**：`dsh-api-remotes` 的 Client assembly 清单未显式列 llm，但 `dsh-client-ui-settings-models` 直接使用 `ctx.remote.llm.listProviders()`，且 Models 页是随 web-app 默认启用的，因此在本部署可用；其它部署需容错。
5. **`ctx.remote.settings.describe()` 的红字行为**：Remote 路径会 `redactSecrets:true`（`pkg:dsh-api-settings-controller/lib/index.js` L~271–292），`apiKeyEnv`（credential-ref）预计仍以引用名出现，但 secret 字段会被替换成标记；未在运行时验证。若客户端要在不查 Host 的情况下展示「是否配 Key」，用 `ctx.remote.credentials.describe({refs})` 更稳（只回 presence）。
6. **团队版/订阅展示**：DeepSeek 登录账户没有套餐/团队字段；四家 API-key 供应商的订阅/团队接口可信度见 `research/vendor-balance-apis.md`（task-1）。插件应把「无法确认」如实显示为 `unsupported/unknown`，不要伪造。
7. **Desktop `file://` 与 RPC**：`dsh-client-connection` 的 `connection.rpc` 通过页面 transport（`__DSH_TRANSPORT__`）抽象，浏览器用 cookie+HTTP、shell 载体可注入自己的 fetch/websocket；当前 GUI 是 `http://127.0.0.1:62512`，走 HTTP 路径没问题。若将来纯 `file://` 桌面壳未提供 transport.fetch，`connection.rpc` 仍由壳注入，行为需实测。
8. **原型 43KB Host 文件中厂商 HTTP 细节**未逐行审计（不在本任务范围）；task-1 文档已给出端点可信度分级，实现应以「超时 + 401/站点不匹配 + 接口下线」三类降级为准。

---

## 8. 复现方法与证据清单

- **读 asar**：`read` 工具可直接读 `<ASAR>/…` 内文件；shell/grep/node 不能直接读 asar 内路径。若需全文检索，可用纯 Node 解析 asar header（8 字节头，`u32@4`=header 区大小，JSON 起始于文件偏移 16；文件数据起始 = 8+header 区大小），或 `npx @electron/asar extract-file`（本机 npm cache 被沙箱拒绝 EPERM，未用）。
- 关键证据文件（路径省略 `dsh/node_modules/@deepseek-ai/`，均可用 `read` 直接读）：
  - `dsh-client-ui-sidebar/lib/client.js`（L129–536：footArea/footerActions/settingsArea 渲染、slot children 声明、CSS 文本）
  - `dsh-client-ui-settings-general/lib/client.js`（L300–460 `SettingsRoot.triggerRow`/renderSlot("settings.launcher")；L1180–1265 `sidebar.settings` 注册与 children）
  - `dsh-client-ui-settings-account/lib/client.js`（L1776–1935 `AccountMenu`；L4415 `inject`；L4460–4790 注册表；L2461–2630 余额展示；L2841 `accountClientMetadata`）
  - `dsh-cordis-client-runner/lib/client.js`（L40–250 evaluator/traps；L5056+ `settings.launcher` 文档；L5652+ `sidebar.footer.action` 文档；L6401+ `sidebar.settings`；L6880–6910 `CLIENT_BUILTIN_INSPECTION`；L7281–7301 host.call 错误教学）
  - `dsh-cordis-host-runner/lib/index.js`（L516–531 `normalizeHandler`/`harness.handle`）+ README
  - `dsh-tool-cordis/README.md`（只有 2 个只读工具）；`dsh-client-ui-cordis/README.md`（历史卡片/面板）
  - `dsh-client-modules/lib/index.js`（L58–75 `parseDshClient`；L~720–760 `locatePkgJson`；L~895 `reconcilePackage` 多源报错；L~902 `table.set(packageName)`）+ README
  - `dsh-client-connection/lib/index.js`（L~690–870 `HostConnectionService.rpc/fetch/admit/createSharedFetchHandler/registerFetchRoute/register`；L888–940 `rpcFetchHandler/fullResponse`）+ `lib/client.browser.js`（L1207–1240 `createWebConnectionRpc.call`；L1360–1510 `installConnection`/`ctx.provide("connection")`）+ README
  - `dsh-settings/lib/index.js`（L343–363 settings.yaml 导入；L409–464 `describe()` 返回形状）+ README
  - `dsh-config-editor/lib/index.js`（L24–122 `documentPath/entries/configuration/inherited/edit`）+ README
  - `dsh-llm-pi-ai/lib/index.js`（L~750–800 `directoryEntries`；L~820 `resolveApiKey`；L~2046–2105 credential record ↔ pi-ai；L~2600–2790 `PROVIDER_DATA`）+ README
  - `dsh-llm/lib/index.js`（L~1761–1970 `@Remote listProviders/listConfigurableProviders`；`typert.host.js`/`typert.remote-client.js`）
  - `dsh-credentials/README.md`、`lib/index.js`（credentialRef/credentialKey）; `dsh-credentials-local/lib/index.js`（L33–60 层级、L205–275 record 解析）
  - `dsh-deepseek-account-platform/lib/index.js`（L330–405 wallet 投影；L~640 `getBalance`）+ README；`dsh-api-account-controller/README.md`；`dsh-llm-deepseek-account/README.md`
  - `dsh-plugin-manager/README.md`（安装/启停/失败语义）+ `package.json`（subpath exports 示例）；`dsh-base/cordis.patch.yml`、`dsh-web-app/cordis.patch.yml`、`dsh-experimental-plugin-market-bundle/{package.json,cordis.patch.yml}`、`dsh-experimental-ralph-bundle/cordis.patch.yml`
  - `dsh-agent-preset/skills/cordis-plugin-development/references/{host-plugin.md,ui-plugin.md,practices.md}` 与 `templates/decoration/*`
- **DSH_HOME 实际文件**：`<DSH_HOME>\.credentials.yaml`（结构见 §3.4，密钥已脱敏）、`<DSH_HOME>\settings.yaml.imported`（旧格式）、`<DSH_HOME>\profiles\desktop\cordis.patch.yml`（现行设置层）、`<DSH_HOME>\cordis.patch.yml`（home 层，含 rea-mcp）、`<DSH_HOME>\profiles\desktop\package.json`（bundles 列表）。
- **当前原型对照**：`<repo>\{package.json,cordis.patch.yml,index.js,client.js,plugins/dshp-quota/host.js}`。结构与 slot 选择正确；需修复 §2.4 的 3 处 RPC 契约问题。
