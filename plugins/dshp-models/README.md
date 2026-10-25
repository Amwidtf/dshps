<!-- markdownlint-disable MD033 MD041 -->
# dshp-models：模型登录

[English](README.en.md) | **简体中文**

属于 [dshps 插件栈](../../README.md)。为 DSH 的 `openai` 路由接入官方 **Sign in with ChatGPT** OAuth 登录，并把 DSH 已注册的授权登录流程（例如 ChatGPT Codex、Kimi Coding、GitHub Copilot）集中到「设置 → DSH 插件栈 → 模型登录」。

安装整个栈后，`dshp-models` 行默认启用；入口是设置页的「模型登录」标签。凭据始终只存在于宿主进程，页面只看得到登录状态、到期时间和登录过程中的提示与问题。

## 官方 Sign in with ChatGPT

登录使用 OpenAI 官方公开客户端流程，与 `@earendil-works/pi-ai` 的 `openai-chatgpt.js` 保持一致：

- 授权页：`https://auth.openai.com/api/accounts/authorize`
- 令牌端点：`https://auth.openai.com/api/accounts/oauth/token`
- 资源：`https://api.openai.com/v1`
- 作用域：`openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`
- 客户端：`dynamic_agent_client`；OpenAI 在回调里下发实际 `client_id`（`oaiapp_…`）并随凭据保存
- PKCE S256、随机 `state` 与 `nonce`、本机回调 `http://127.0.0.1:<端口>/auth/callback`
- 安装标识：`ext_agent_host_id=urn:uuid:<设备 UUID>`，UUID 在首次登录时生成并保存到插件配置

使用条件与步骤：

1. 需要一个支持模型访问的 ChatGPT Plus / Pro 订阅账号。
2. DSH 中已加载 `llm-pi-ai`（默认 bundle 自带）。
3. 打开「设置 → DSH 插件栈 → 模型登录」，点「登录 ChatGPT」。
4. 在浏览器完成授权。回调成功后页面提示可以关闭，DSH 面板显示「已登录」和凭据到期时间。
5. 到「设置 → 模型」选择 `openai` 路由上的模型即可，不需要填写 API Key。

`openai` 路由：

- 登录前插件会自动确认 `llm-pi-ai.providers.openai` 配置存在；不存在时补一个空配置（不会覆盖已有字段）。
- 页面也可以手动点「创建 openai 路由」。
- 如果该路由设置了 API Key（`apiKeyEnv`），API Key 会覆盖 OAuth 登录。插件只显示警告，**不会**替你删除它；需要 OAuth 时请到设置里清空该 Key。
- 登录结果写入 DSH 凭据记录 `llm-pi-ai/openai`（`kind: grant`，负载是 pi-ai 原样的 `{ type: 'oauth', access, refresh, expires, clientId, scopes }`），`llm-pi-ai` 会在每次请求时读取并自动刷新。

回调端口：

- 默认 `1455`，可在插件配置中改为 1024–65535。
- 端口被占用时（例如 Codex CLI 或上一次未完成的登录还占着端口）不会失败，而是退回**手动模式**：完成浏览器授权后，把最终跳转地址（`http://127.0.0.1:<端口>/auth/callback?...`）粘贴到「提交回调地址」输入框。
- 手动模式同时兼容回调服务可用的情形；两种方式先到达者生效。

退出登录：

- 「退出登录」删除本机 `llm-pi-ai/openai` 凭据记录，然后路由回到未登录状态。
- 只会忘记本机凭据，不会通知 OpenAI 服务端撤销；刷新令牌由 `llm-pi-ai` 适配器在后台轮换。

## 请求形态与配额限制

ChatGPT 订阅令牌不是普通 API Key，它的请求形态由 OpenAI 限制，`llm-pi-ai` 已按官方行为适配：

- **只走 Responses API**：OAuth 凭据下 `openai` 路由只使用 `https://api.openai.com/v1/responses`；classifier / Decisions 类模型会被过滤掉。
- **始终流式**：请求固定 `stream: true`，不提供非流式调用。
- **`store: false`**：订阅令牌不接受存储式响应，也不会产生可检索的 response 对象。
- **不接受采样字段**：ChatGPT 订阅令牌会拒绝 `temperature`；pi-ai 还会同时省略 `max_output_tokens` 与 prompt cache 相关字段。因此「设置 → 模型」里的采样参数、输出上限对该路由**不生效**，这是官方限制而非插件缺陷。
- **与订阅共享用量**：用量计入 ChatGPT 套餐的滚动 5 小时窗口和每周上限，并与其他使用订阅的应用共享。触发上限时通常返回 429（`subscription_sharing_usage_limit_exceeded`），这是用量限制而不是登录失效；等待窗口重置或升级套餐即可。pi-ai 的错误信息会附带 ChatGPT 用量页链接。
- **模型可见性由套餐决定**：套餐或账号权限不允许的模型会直接报错，换一个模型或账号即可。
- dshp-quota 面板展示的是各 API Key 供应商的余额/额度，**不读取** ChatGPT 订阅窗口，两者不要混淆。

## 其他供应商登录（authorization 桥）

DSH 的 `authorization` 服务已经注册了若干带登录的供应商流程；本插件不重复实现，只把界面接出来：

- 列表来自 `ctx.authorization.list()`，显示流程名称、可用方法和是否正在进行。
- 「登录」会执行一次尝试；`notify` 消息（含验证码、授权链接）逐条显示，`prompt` 问题以文本、密钥、下拉选择形式显示。
- 同一流程同时只允许一次尝试；「取消」会中止该次尝试。
- 尝试只存在于当前宿主进程，页面刷新后需要重新开始。
- 插件**不会**为 `llm-pi-ai/openai` 再注册一个授权流程（pi-ai 已经注册了该 key 的 API Key 流程，重复注册会失败），官方 ChatGPT 登录直接写同一条凭据记录。

## 配置

配置项在「设置 → DSH 插件栈 → 模型登录」或插件设置表单中：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `chatgpt.agentName` | `dshps` | 登录时上报的 `agent_name_hint`，只影响授权页显示 |
| `chatgpt.callbackPort` | `1455` | 本机回调端口，1024–65535；被占用时自动退出手动粘贴 |
| `chatgpt.deviceId` | 空 | 首次登录自动生成的稳定设备 UUID；请勿手工修改，RPC 只返回是否已配置 |

## 安全

- `access` / `refresh` / `id_token` 只保存在宿主进程和 DSH 凭据库中（记录键 `llm-pi-ai/openai`）；RPC 只返回 `signedIn`、`recordKind`、到期时间等派生信息。
- 授权链接可以安全展示：它不含凭据，只有一次性的 `state`、`nonce` 与 PKCE challenge。
- 回调服务只监听 `127.0.0.1`，校验 `state`，并尽力解析 `id_token` 比较 `nonce`；令牌端点响应会校验 `access_token`、`refresh_token`、`id_token`、作用域和有效期。
- 令牌不写日志；错误信息会折叠空白并屏蔽长令牌样式字符串。
- 设备 UUID 与插件设置保存在 DSH 管理的配置文档中（位于 `$DSH_HOME` 下）；不要把 DSH 凭据文件、`state` 或回调 URL 中的授权码提交到仓库或公开 issue。

## 调试

Host 半注册了认证过的 Connection RPC 通道 `/dshp-models`：

| 端点 | 用途 |
|---|---|
| `snapshot` | 登录状态、`openai` 路由状态、其他流程列表、配置与服务可用性 |
| `chatgpt-route-ensure` | 确认/创建 `llm-pi-ai.providers.openai` 配置 |
| `chatgpt-login-start` | 开始一次官方登录，返回授权链接与回调模式 |
| `chatgpt-login-submit` | 提交手动粘贴的回调地址 |
| `chatgpt-login-cancel` | 取消当前登录 |
| `chatgpt-logout` | 删除本机 `llm-pi-ai/openai` 凭据记录 |
| `flow-start` | 开始一个已注册的 authorization 流程 |
| `flow-poll` | 拉取流程状态、提示与待回答问题（提示读取后清空） |
| `flow-answer` | 回答某个待回答问题 |
| `flow-cancel` | 取消流程尝试 |
| `diag` | 服务/路由/端点信息，不含令牌、授权码或设备 UUID |

本地可用 `tools/probe-rpc.mjs` 验证；`DSH_WEB_ORIGIN` 可覆盖默认的 GUI 地址。

## 排错

**面板显示未登录，但「登录 ChatGPT」后一直等待**：检查浏览器是否真的打开了授权页、是否被弹窗拦截；也可以复制页面上的授权链接手动打开。

**提示「回调端口被占用」**：关掉占用端口的程序（例如 Codex CLI 或另一次未完成的登录），或直接在输入框粘贴最终回调地址；也可以在插件配置里换一个端口后重载插件。

**授权页回调后 DSH 没有变化**：确认浏览器最终跳转地址是 `http://127.0.0.1:<端口>/auth/callback?...`，把它粘贴到「提交回调地址」。

**已登录但请求失败**：检查 `openai` 路由是否设置了 `apiKeyEnv`（它会覆盖 OAuth）；检查套餐是否支持所选模型；注意订阅的 5 小时/每周用量上限。

**「其他供应商登录」为空**：确认 `llm-pi-ai` 已加载，并且当前 DSH 版本注册了 authorization 流程。

**登录成功后重启 DSH 仍保持登录**：凭据记录持久化在 DSH 凭据库；如果希望彻底退出，使用「退出登录」。

## 开发与测试

- `tools/test-host.mjs`：纯函数（PKCE、授权 URL、回调解析、凭据构造）与 mock ctx 下的 RPC 行为。
- `tools/test-client.mjs`：模型登录设置页的渲染断言。
- 测试不访问网络；令牌流程通过 mock `fetch` 验证。
- 修改官方流程参数时必须同步检查 `@earendil-works/pi-ai` 的 `openai-chatgpt.js`，并保持 `llm-pi-ai/openai` 记录格式不变。

参见 [AGENTS.md](../../AGENTS.md) 了解仓库规则。

## 许可

[MIT](../../LICENSE) © 2026 dshps contributors
