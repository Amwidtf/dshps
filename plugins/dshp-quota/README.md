<!-- markdownlint-disable MD033 MD041 -->
# dshp-quota：额度余额

[English](README.en.md) | **简体中文**

属于 [dshps 插件栈](../../README.md)。在 DSH 侧边栏显示 DeepSeek、Kimi、MiniMax、智谱 GLM 的余额、额度窗口和订阅用量。

安装整个栈后，`dshp-quota` 行默认启用。界面入口有两个：

- 侧边栏底部、用户信息行上方的「额度余额」；
- 「设置 → DSH 插件栈」里的插件配置。

## 显示内容

| 供应商 | 卡片内容 | 数据来源 |
|---|---|---|
| DeepSeek 官方 API | 账户余额：可用、赠金、充值 | DSH 中配置的 DeepSeek API Key |
| DeepSeek 登录账户 | 登录账户钱包余额 | DSH 已登录账户（`deepseekAccount`） |
| Kimi Code | 5 小时、每周额度，加速包；网页「总使用量」 | Coding API Key + 可选网页 `refresh_token` |
| MiniMax | M Plan 文本、视频的 5 小时和每周额度 | MiniMax Key |
| 智谱 GLM | Coding Plan 的 5 小时和每周额度、资源包、套餐；标准 API 余额 | Coding Key 或标准 API Key，团队版另需组织/项目 ID |

几个容易混淆的地方：

- 面板上的百分比默认表示**剩余**。Kimi 的「总使用量」按订阅页口径显示**已用**百分比，并拆出 Kimi 和 Code 两部分。
- Kimi 的**加速包**是独立额度，不参与月额度计算，单独一行显示。
- 智谱走 Coding 路线时只显示额度，不再混入标准 API 的现金余额；标准 API Key 才显示余额。
- 团队标记只在接口明确给出团队信息时显示。

## 安装与启用

1. 按根 README 安装 `dshps` bundle。
2. 在 DSH 里确认 `dshp-quota` 行处于激活状态。
3. 刷新页面，侧边栏出现「额度余额」。

停用插件只需停用 `dshp-quota` 行，`dshps` 和其他插件不受影响。

## 配置

配置项都在「设置 → DSH 插件栈」：

### 智谱 GLM 团队版

- 组织 ID：`bigmodel-organization`
- 项目 ID：`bigmodel-project`
- `type`：团队版通常是 `2`

个人账号三项留空。团队版不填组织/项目时，插件会尝试个人上下文；接口返回空数据时会提示未检测到 Coding Plan，而不是显示错误。三个值只用于额度查询请求头。

### 自动刷新

- 范围 15–3600 秒，默认 60 秒。
- 详情顶部的「刷新」按钮随时手动查一次。
- 宿主返回的 `ttlMs` 会覆盖默认轮询间隔。

### Kimi 总使用量

Kimi 订阅页的「总使用量」只能通过网页会员接口查询，API Key 读不到。需要网页登录态里的 `refresh_token`，约 90 天有效；插件会自动续期并轮换。

获取方式：

1. 在浏览器打开 `kimi.com` 控制台并登录；
2. 按 `F12`，打开 Application → Local Storage，或看 Network 里的 `RefreshToken` 请求；
3. 复制 `refresh_token` 的值，粘贴到设置页后点「应用」。

不要粘贴 access token。access token 只有 15 分钟有效期，过期后接口返回 401。

存储：

- Windows 上使用 DPAPI 加密，文件是 `%USERPROFILE%\.dsh\dshps\kimi-token.dat`，只有当前 Windows 用户能解密；
- 加密文件不可用时回退到 DSH 本地凭据 `KIMI_WEB_TOKEN`，也可以用同名环境变量；
- token 不写入仓库、不写入插件配置；
- 设置页「清除」会删除本地加密文件和凭据记录；
- 查询返回 401 时，插件会用保存的 refresh_token 续期一次再重试，失败会在设置页或详情里写明原因。

## 面板与交互

折叠面板：

- 每家供应商一行，显示 `5h / 周 / 月` 剩余；有哪项显示哪项；
- 低于 10% 变色，用完显示「已用完」；
- 金额类供应商直接显示余额。

悬浮窗：

- 第一页是总览，每次打开都回到总览；列出每家的套餐、剩余和余额，点行进入详情；
- 详情按供应商分 tab，支持点击、鼠标滚轮和方向键切换；内容先滚动，滚到边缘才换供应商；
- 详情展示套餐名和等级、团队标记、余额明细、进度条、完整重置时间（`YYYY-MM-DD HH:mm` 加倒计时）和错误分类。

排序：行和 tab 都按「设置 → 模型」里的供应商顺序排列，不按厂商重排。

刷新失败：保留上次成功的数据并标记 stale，不把已有数据清空。

错误分类：`auth`、`need-config`、`network`、`http`、`gone`、`parse`、`no-plan`、`need-context`。

## 数据来源

接口都不公开，字段可能变化。主要请求：

- DeepSeek：`GET {origin}/user/balance`；登录账户走 DSH `deepseekAccount.getBalance`。
- Kimi：`GET /v1/users/me/balance`；`GET https://api.kimi.com/coding/v1/usages`；网页会员 `POST /apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats` 和 `GetSubscription`，续期 `POST https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken`。
- MiniMax：`GET /v1/token_plan/remains`。
- 智谱：`GET /api/monitor/usage/quota/limit`、`/api/biz/subscription/list`、`/api/biz/account/query-customer-account-report`、`/api/biz/tokenAccounts/list/my`。

## 调试

Host 半注册了认证 RPC 通道 `/dshp-quota`：

| endpoint | 用途 |
|---|---|
| `snapshot` | 读缓存快照 |
| `refresh` | 强制刷新 |
| `diag` | 发现结果与脱敏配置，不含 Key/token |
| `settings` | 读设置文档 |
| `settings-write` | 写设置（带 revision 冲突检测） |
| `kimi-token` | 设置、清除或查询 Kimi token 状态 |

本机可用 `tools/probe-rpc.mjs` 调用。`DSH_WEB_ORIGIN` 可覆盖默认的 `http://127.0.0.1:62512`。

## 隐私

- 凭据只从 DSH 凭据服务解析，留在 Host 进程；
- 浏览器只收到归一化后的余额、额度和错误分类；
- Kimi token 用 DPAPI 或 DSH 凭据服务保存，不进仓库；
- 调试工具会脱敏，不要把它们带真实账号的输出贴到公开 issue。

## 排错

**面板没出现**：检查 `dshp-quota` 行是否启用，刷新页面/重启 DSH。

**显示「缺少 API Key」**：到「设置 → 模型」给该供应商配置 Key。

**认证失败**：Key 可能和接口路线不匹配，例如拿标准 API Key 查 Coding Plan，或 Kimi Key 配错站点。

**GLM 显示未检测到 Coding Plan**：个人版或标准 API Key 没额度接口；团队版在设置页填组织/项目。

**Kimi 总使用量提示要 token 或 401**：重新复制 `refresh_token`；access token 不能用长期。

**设置页空白**：刷新后重开；错误边界会显示原因。

## 开发与测试

- `tools/test-host.mjs`：供应商发现、四家适配器、Kimi 总使用量与续期、缓存、脱敏、失败降级、认证 RPC。
- `tools/test-client.mjs`：折叠行、总览、详情、设置页、错误边界。
- 新增供应商或接口字段时，先补 Host 夹具测试，再补客户端渲染断言；测试不访问网络。

项目规则见 [AGENTS.md](../../AGENTS.md)。

## 许可

[MIT](../../LICENSE) © 2026 dshps contributors
