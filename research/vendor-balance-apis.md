# 四家 AI 供应商「余额 / 额度 / 订阅 / 团队版」查询 API 调研

> 面向 DSH Web UI 侧边栏「账户余额面板」插件。
> 目标：给定 DSH 中已配置的 `baseURL + API key`（或 provider 记录），判断是哪家供应商、调用哪个查询接口、返回什么字段、如何展示订阅与团队形态。
> 调研时间：2026-10-18。所有密钥均为占位符，未使用真实 key。
>
> **可信度分级（全文统一）**
> - **【官方】** 供应商官方文档/官方 FAQ 明确写出（含官方 curl 示例）。
> - **【社区实测】** 非官方文档，但被多个独立开源项目实际调用并给出真实响应样例/测试；可能随版本变化。
> - **【无法确认】** 仅单一来源提及、或来源互相矛盾、或未找到任何可靠证据；**插件不应依赖**，只能作为可选探测或直接降级。

---

## 0. 结论速览

| 供应商 | 识别域名（主要） | 余额（真钱）接口 | 订阅/套餐额度接口 | 团队版 | 可信度 |
|---|---|---|---|---|---|
| DeepSeek | `api.deepseek.com` | `GET /user/balance`（根路径，无 `/v1`） | 无（官方明确暂无分级套餐） | 无团队/组织账户概念 | 官方 |
| MiniMax | `api.minimax.cn` / `api.minimaxi.com` / `www.minimax.cn`（国内）；`api.minimax.io` / `www.minimax.io`（国际） | 无公开官方接口（按量付费余额） | `GET /v1/token_plan/remains`（M Plan 订阅额度，官方 FAQ 有 curl） | 企业「主账号+子账号」，无公开团队查询 API | 订阅额度=官方；余额=无法确认 |
| 智谱 GLM | `open.bigmodel.cn`（国内）/ `api.z.ai`（国际） | 社区逆向：`GET /api/biz/account/query-customer-account-report` | 社区逆向：`GET /api/monitor/usage/quota/limit`（Coding Plan 5h/周额度） | GLM Coding Plan 团队版（席位制，Key 独立）；额度接口需组织/项目上下文 | 官方只确认「有团队版产品」；接口均为社区 |
| Kimi / Moonshot | `api.moonshot.cn`（国内）/ `api.moonshot.ai`（国际）/ `api.kimi.com/coding`（Kimi Code） | `GET /v1/users/me/balance` | `GET https://api.kimi.com/coding/v1/usages`（Kimi Code/Coding Plan，未公开文档） | 开放平台企业组织共享账户余额；无团队查询 API | 余额=官方；订阅用量=社区实测 |

一句话给实现者：
- **DeepSeek**：只有余额，没有订阅/团队，最简单。
- **MiniMax**：真正的「订阅额度」有官方接口（Token Plan/M Plan），但**按量付费余额没有公开接口**；Key 前缀能区分订阅 Key（`sk-cp-`）与按量 Key（`sk-api-`，社区观察）。
- **智谱**：余额与 Coding Plan 额度都有**社区逆向接口**，可用但需容错；**团队版额度查询需要额外上下文头**（`bigmodel-organization` / `bigmodel-project` / `?type=2`），无法只靠 API Key 完成，必须引导用户填写或降级。
- **Kimi**：官方余额接口稳定；Coding Plan 用量接口未公开文档但已被多个项目实测（含会员等级、5h/周窗口、加速包月消费）。

---

## 1. 如何仅凭 DSH 已配置信息识别供应商

DSH 的 `llm-pi-ai` 适配器里每个 provider 路由通常包含：`displayName`、`baseURL`、`api`、`apiKeyEnv`（凭据引用）、`models`。因此识别顺序建议：

1. **优先看 provider 路由名 / displayName**（最可靠）
   常见名：`deepseek`、`moonshot`、`kimi`、`kimi-coding`、`kimi-for-coding`、`zai`、`zhipu`、`zhipu-coding`、`minimax`、`minimax-cn` 等（不同 DSH/pi-ai 版本命名可能不同）。
2. **再看 baseURL 的 host（忽略路径/端口/协议）**
   路径可能是 `/v1`、`/anthropic`、`/beta`、`/api/paas/v4`、`/coding`……**不能只看路径判断产品**，只看 host。
3. **再看 API Key 前缀/形态（仅作提示，不作强判据）**
   - `sk-cp-…` → MiniMax 订阅 Key（M Plan/Token Plan）【社区实测】
   - `sk-api-…` → MiniMax 按量付费 Key【社区实测】
   - `sk-kimi-…` → Kimi Code / Coding Plan Key【社区实测】
   - `id.secret`（点号分隔两段）→ 智谱传统 API Key 形态（可作提示）
   - 其他 `sk-…` 无法区分厂商，不要据此判定。
4. **baseURL 缺失时**：pi-ai 目录条目有 catalog 默认 endpoint（如 `deepseek` 路由默认 `https://api.deepseek.com`），需要从 provider 元数据/catalog 拿默认 baseURL 再匹配 host。
5. **中转站/自定义网关**（OpenRouter、New API、One API、公司代理）：host 不在白名单 → 不要发厂商查询；可选支持 New API 通用账单接口或让用户手填提取规则。

### 域名 → 供应商映射（建议作为白名单）

| host（含子域） | 供应商/产品 | 备注 |
|---|---|---|
| `api.deepseek.com` | DeepSeek | 另有 `/anthropic` 兼容端；余额不带 `/v1` |
| `www.minimax.cn`, `api.minimax.cn`, `platform.minimax.cn` | MiniMax 国内 | `api.minimax.cn/v1` 为 OpenAI 兼容；`/anthropic` 为 Anthropic 兼容 |
| `www.minimaxi.com`, `api.minimaxi.com`, `platform.minimaxi.com` | MiniMax 国内（旧域名族） | `token_plan/remains` 社区常用 `api.minimaxi.com` |
| `www.minimax.io`, `api.minimax.io`, `platform.minimax.io` | MiniMax 国际 | 官方 FAQ 的 curl 用 `www.minimax.io` |
| `api.minimax.chat` | MiniMax 旧国内域名 | 历史域名，识别为 MiniMax，接口以现行文档为准 |
| `open.bigmodel.cn` | 智谱国内 | 余额/额度接口均为该 host |
| `api.z.ai`, `platform.z.ai` | 智谱国际（Z.ai） | 与国内同路径，鉴权细节有差异 |
| `api.moonshot.cn` | Kimi/Moonshot 国内 | 余额单位 CNY |
| `api.moonshot.ai` | Kimi/Moonshot 国际 | 余额单位 USD；Key 与国内站不通用 |
| `api.kimi.com` | Kimi Code（Coding Plan） | 路径 `/coding`、`/coding/v1`；订阅 Key/OAuth |
| `auth.kimi.com` | Kimi Code OAuth | 仅用于登录刷新，不是查询接口 |

> 安全约束：只有 host 命中白名单才发送对应 API Key；未知 host 一律不发（避免把密钥发给任意中转站/代理）。

---

## 2. DeepSeek

### 2.1 识别特征
- baseURL host：`api.deepseek.com`（DSH 里也可能配成 `https://api.deepseek.com/anthropic`、`https://api.deepseek.com/v1`，host 相同）。
- Key 形态：`sk-…`（不具唯一性，不能单独判厂商）。
- 鉴权：`Authorization: Bearer <DEEPSEEK_API_KEY>`。

### 2.2 余额接口（官方确认）
- 端点：`GET https://api.deepseek.com/user/balance` —— **注意没有 `/v1`**
- 官方文档：[Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/)（英文）/ [查询余额](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)（中文）

```bash
curl -s https://api.deepseek.com/user/balance \
  -H "Authorization: Bearer $DEEPSEEK_API_KEY" \
  -H "Accept: application/json"
```

响应示例（**按官方 schema 构造**，字段名/类型来自官方文档）：

```json
{
  "is_available": true,
  "balance_infos": [
    {
      "currency": "CNY",
      "total_balance": "110.00",
      "granted_balance": "10.00",
      "topped_up_balance": "100.00"
    }
  ]
}
```

字段说明（官方）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `is_available` | boolean | 余额是否足以继续调用 API |
| `balance_infos` | array | 按币种返回的余额列表；`currency` 可能为 `CNY` / `USD` |
| `balance_infos[].currency` | string | `CNY` 或 `USD` |
| `balance_infos[].total_balance` | string | 总可用余额 = 赠送余额 + 充值余额 |
| `balance_infos[].granted_balance` | string | 未过期的赠送余额合计 |
| `balance_infos[].topped_up_balance` | string | 充值余额合计 |

注意：余额字段是**字符串**，不是数字；解析需 `Number(...)` 并校验有限值。多币种时不要直接相加。

### 2.3 订阅 / 团队版
- **无订阅套餐、无团队版**。官方 FAQ 明确：「目前我们实行统一的 API 收费标准，暂无分级套餐」；「个人认证账号与企业认证账号在用户权益和产品功能上目前无差异」，企业认证只影响对公汇款/发票等财务流程。
- 所以 DeepSeek 面板只展示 `kind = balance`，`plan/team` 恒为空；不要显示“订阅/团队”占位。

来源（官方）：
- DeepSeek FAQ「API相关」：<https://static.deepseek.com/faq/index.html?lang=zh#/category/4>（含「是否有限速更高的套餐」「个人认证与企业实名认证有什么区别」）

### 2.4 其他可查接口
- 除余额外，DeepSeek 没有其他公开账单/订阅接口：`/models`、Files、FIM、Search/Fetch 等都不含额度信息。余额一次查询即可覆盖全部展示需求（更新频率建议 ≥60s，避免无意义轮询）。

---

## 3. MiniMax

### 3.1 识别特征与站点差异（重要）
MiniMax 有**国内站 / 国际站两套账号与后端**，Key 不通用；同一账号体系内又区分**订阅 Key（M Plan/Token Plan）**与**按量付费 API Key**：

| 维度 | 国内 | 国际 |
|---|---|---|
| 控制台/文档 | `platform.minimax.cn` | `platform.minimax.io` |
| 推理 API base | `https://api.minimax.cn/v1`（OpenAI 兼容）/ `https://api.minimax.cn/anthropic` | `https://api.minimax.io/v1` 等 |
| 订阅额度查询 host | `https://www.minimax.cn`（官方 FAQ）/ `https://api.minimaxi.com`（社区常用） | `https://www.minimax.io`（官方 FAQ）/ `https://api.minimax.io`（社区） |
| Key | 订阅 Key 与按量 Key 相互独立 | 同上 |
| 计费单位 | 积分/额度，账户余额人民币 | 积分/额度，账户余额美元 |

官方证据（CN）：[M Plan 常见问题](https://platform.minimax.cn/docs/m-plan/faq)「如何查看 M Plan 用量 → 方式三：使用 API 接口查询」给出 curl：
```bash
curl --location 'https://www.minimax.cn/v1/token_plan/remains' \
--header 'Authorization: Bearer <API Key>' \
--header 'Content-Type: application/json'
```
官方证据（INTL）：[M Plan FAQ](https://platform.minimax.io/docs/m-plan/faq) 同样给出 `https://www.minimax.io/v1/token_plan/remains` 的 curl。

> 两个站点的套餐倍率文案目前不一致（EN 文档 Build=7.5x，CN 文档 Build=12x），说明国内/国际产品策略独立；展示套餐名/倍率时应以接口返回值或用户手填为准，不要硬编码。

### 3.2 订阅额度接口（官方）：M Plan / Token Plan remains
- 端点：`GET https://www.minimax.cn/v1/token_plan/remains`（国内）
- 端点：`GET https://www.minimax.io/v1/token_plan/remains`（国际）
- 鉴权：`Authorization: Bearer <订阅 Key>`；`Content-Type: application/json`（官方 curl 附带）
- 社区常用等价 host：`https://api.minimaxi.com/v1/token_plan/remains`、`https://api.minimax.io/v1/token_plan/remains`【社区实测】
- 旧路径（DSH 生态插件在用）：`GET https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains`【社区实测，历史 Token Plan 接口；新 M Plan 建议优先 `token_plan/remains`】

```bash
# 国内 M Plan
curl -s 'https://www.minimax.cn/v1/token_plan/remains' \
  -H "Authorization: Bearer $MINIMAX_SUBSCRIPTION_KEY" \
  -H "Content-Type: application/json"
```

响应示例（**真实响应样例**，来自 tokmesh 项目对 `token_plan/remains` 的样本；字段与 ai-usagebar 对线上接口的抓取一致）：

```json
{
  "model_remains": [
    {
      "start_time": 1781834400000,
      "end_time": 1781852400000,
      "remains_time": 16640796,
      "model_name": "general",
      "current_interval_status": 1,
      "current_interval_remaining_percent": 98,
      "current_weekly_status": 1,
      "current_weekly_remaining_percent": 67,
      "weekly_start_time": 1781452800000,
      "weekly_end_time": 1782057600000,
      "weekly_remains_time": 221840796,
      "weekly_boost_permille": 1500
    },
    {
      "start_time": 1781798400000,
      "end_time": 1781884800000,
      "remains_time": 49040796,
      "model_name": "video",
      "current_interval_remaining_percent": 100,
      "current_weekly_status": 1,
      "current_weekly_remaining_percent": 100,
      "weekly_end_time": 1782057600000
    }
  ],
  "base_resp": { "status_code": 0, "status_msg": "success" }
}
```

字段/语义（多来源一致）：

| 字段 | 说明 |
|---|---|
| `base_resp.status_code` | **业务状态码；HTTP 恒为 200**。`0` 成功；`1004` 未带 Key；`2049` Key 无效或与站点不匹配；`2062` 无有效 Token Plan/M Plan（来自另一实现，见下） |
| `base_resp.status_msg` | 业务错误信息 |
| `model_remains[]` | 按模型桶返回（`general` = 文本/编程；`video` = 视频） |
| `model_name` | 桶名 |
| `current_interval_remaining_percent` | **剩余**百分比（0–100），不是已用；已用 = 100 − 该值 |
| `current_interval_status` | 当前 5h/interval 窗口状态（1=active；其它值表示无效，需跳过） |
| `end_time` / `remains_time` | 窗口重置的 epoch **毫秒** / 剩余毫秒 |
| `start_time` + `end_time` | 窗口长度（不同桶不同：`general` 约 5h，`video` 约 24h），不要写死 5h |
| `current_weekly_status` | 周窗口状态；`0` 时应**忽略**周窗口（老套餐无周额度） |
| `current_weekly_remaining_percent` | 周窗口**剩余**百分比 |
| `weekly_end_time` / `weekly_remains_time` | 周窗口重置 epoch 毫秒 / 剩余毫秒 |
| 可选套餐字段 | 部分响应/实现出现 `current_subscribe_title` / `plan_name` / `plan`；样本中不稳定，按可选处理 |

实现要点：
- 一律按 `model_name` 选桶（通常取 `general` 作为主展示；`video` 可折叠展示），不要假设数组顺序。
- 百分比是**剩余**；UI 进度条建议统一转成「已用%」或直接显示剩余%，但不要混用口径。
- 无周窗口（`current_weekly_status === 0`）时不要渲染 `0%` 周进度，否则会误读为“已用满”。
- 业务错误必须读 `base_resp`，不能只看 HTTP 200。

### 3.3 按量付费余额：官方无公开接口（无法确认）
- 官方文档（[About Account](https://platform.minimax.io/docs/faq/about-account)、[充值/余额控制台](https://platform.minimax.io/user-center/payment/balance)）只说明控制台查看余额、余额预警、自动充值；**未提供“API Key 查询按量付费余额”的公开接口**。
- 社区有一处提及：按量付费 Key（`sk-api-…`）走的是另一条 `…/account/query_balance` 类接口，与订阅 Key 授权的端点不同【无法确认，仅单一来源提及，且未给出完整 host/路径/响应】。
- 因此面板对 MiniMax 按量账户应显示“余额接口不可用（仅控制台）”，而不是猜测端点；若用户提供了正确的按量 Key，则订阅额度接口会返回业务错误（如 2062），正好作为区分信号。

### 3.4 订阅 / 团队版
- **M Plan（原 Token Plan）**：个人订阅，档位 Go / Explore / Build（CN 与 EN 倍率文案不一致，见上）。订阅 Key 与按量 API Key 相互独立、不能混用（官方 FAQ）。
- 用量窗口：非视频模型受 **5 小时窗口 + 周窗口** 控制；视频模型仅受周窗口控制；未用完额度不结转（官方 [Usage](https://platform.minimax.io/docs/m-plan/usage-rules)）。
- **团队/企业**：官方「前置准备」文档写明企业团队注册采用**主账号 + 子账号**形式，子账号与主账号共享用量与速率限制、统一结算，子账号无支付权限；也可「使用团队分配给您的资源」。但**没有公开的团队/席位/子账号额度查询 API**，团队资源管理只在控制台。
- 结论：MiniMax 面板展示「余额（不可用则占位） + 订阅窗口（若 Key 为订阅 Key）」，`team` 标记为 `unknown`，不要虚构团队字段。

### 3.5 第三方社区实现的端点汇总（供交叉验证）
- `@mzzsfy/dsh-usage-panel`（DSH 双端插件，README 与源码均已公开）：`minimax` 类型 = `https://api.minimaxi.com` + `GET /v1/api/openplatform/coding_plan/remains`，`Authorization: Bearer key`；解析 `model_remains[].current_interval_remaining_percent` 等（源码 `src/parsers.mjs`）。
- `dsh-plugin-balance-panel`：MiniMax 未列余额适配器（其表格只列 DeepSeek/Moonshot/智谱/OpenRouter/OpenCode Go），侧面印证 MiniMax 按量余额无公开接口。
- `pi-show-minimax-quota`（pi 扩展）：国际/国内均用 `token_plan/remains`，并指出「按量付费 Key 授权的是不同端点」。
- `minimax-remaining-mcp`（PyPI，MCP 服务）：声称 5h/周数据来自网页接口且**不接受 Bearer Key，需要网页 cookie**，并给出 `2062 "no active token plan"` —— 与上面多个项目使用 Bearer 订阅 Key 成功的结论**冲突**。合理解释：该实现针对的是「网页 Token Plan 面板」接口（带 `GroupId`），或使用了错误类型的 Key。**以官方 FAQ 的 Bearer curl 为准**；插件仍应对 2062/1004/2049 做专门的用户提示。

---

## 4. 智谱 GLM（Zhipu / BigModel / Z.ai）

### 4.1 识别特征
- 国内：baseURL host `open.bigmodel.cn`，常见路径 `https://open.bigmodel.cn/api/paas/v4`（标准 API）、`https://open.bigmodel.cn/api/coding/paas/v4`（Coding Plan）、`https://open.bigmodel.cn/api/anthropic`（Claude Code 兼容）。
- 国际：host `api.z.ai`，同构路径 `/api/paas/v4`、`/api/coding/paas/v4`。
- 控制台：`open.bigmodel.cn` / `bigmodel.cn`（国内），`z.ai`（国际）；文档：`docs.bigmodel.cn` / `docs.z.ai`。
- 鉴权方式（官方 [HTTP API 调用](https://docs.bigmodel.cn/cn/guide/develop/http/introduction)）：
  - **API Key 鉴权**（推荐）：`Authorization: Bearer YOUR_API_KEY`，最简单。
  - **JWT Token 鉴权**（适合更高安全性场景）：智谱 API Key 形如 `id.secret`，取点号前为 `id`、后为 `secret`，用 `secret` 做 HS256 签名生成 JWT，payload 为 `{ api_key: id, exp: 毫秒时间戳, timestamp: 毫秒时间戳 }`，header 为 `{ alg: "HS256", sign_type: "SIGN" }`，再以 `Authorization: Bearer <jwt>` 发送（官方文档附 PyJWT 示例）。
  - **Coding Plan Key / 团队套餐 Key / 标准 API Key 三类 Key 分开管理、互不通用**（官方 [API Key 分类管理说明](https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management)）；使用 Coding Plan 时 Base URL 必须换成专属 Coding 端点（标准 `https://open.bigmodel.cn/api/paas/v4` → Coding `https://open.bigmodel.cn/api/coding/paas/v4`），否则套餐额度不生效、会扣账户余额。

### 4.2 Coding Plan 额度接口（社区逆向，官方未公开）
> 来源：[OpenTokenUsage zai.md](https://raw.githubusercontent.com/PowerUserZ/OpenTokenUsage/main/docs/providers/zai.md)、[glm-for-copilot usage.ts](https://raw.githubusercontent.com/KiwiGaze/glm-for-copilot/main/src/client/usage.ts)、[pi-glm-quota README](https://github.com/focksor/pi-glm-quota)、[Whale Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)（issue #180/#181 修复记录）。
> 这些项目均注明：**接口未出现在官方公开 API Reference，是订阅管理页面内部使用的接口**，随套餐改版可能变化。

- 端点：`GET https://open.bigmodel.cn/api/monitor/usage/quota/limit`（国内）
- 端点：`GET https://api.z.ai/api/monitor/usage/quota/limit`（国际）
- 关键请求要素（2026-07-30 积分制套餐改版后，来自 pi-glm-quota 实测记录）：
  - `Authorization: <API Key>` —— **裸 Key，不带 `Bearer`**（国内；国际多数实现用 `Bearer`）
  - query `?type=2` —— 团队套餐=2；个人新版疑似=1（该来源标注“未验证”）
  - `bigmodel-organization: org-xxx` —— 组织上下文，**团队套餐必需**
  - `bigmodel-project: proj_xxx` —— 项目上下文，**团队套餐必需**
  - 缺 `type` → 业务报错「当前用户不存在coding plan」；缺 org/project 头 → 返回空 `data:{}`（社区实测）
- 注意：**个人 Coding Plan 的旧实现**（只发裸 Key、无 org/project/type）在部分账号上仍可用，所以会出现“有的插件能用、有的不能”的分裂现象；团队套餐几乎必须带上下文。

```bash
# 个人/旧版（社区常见写法，国内裸 Key）
curl -s 'https://open.bigmodel.cn/api/monitor/usage/quota/limit' \
  -H "Authorization: $ZHIPU_API_KEY" \
  -H 'Accept: application/json'

# 团队套餐（社区实测要求；org/project 需用户从浏览器 DevTools 获取）
curl -s 'https://open.bigmodel.cn/api/monitor/usage/quota/limit?type=2' \
  -H "Authorization: $ZHIPU_API_KEY" \
  -H "bigmodel-organization: $ZHIPU_ORG_ID" \
  -H "bigmodel-project: $ZHIPU_PROJECT_ID" \
  -H 'Accept: application/json'
```

响应示例（真实结构，来自 OpenTokenUsage 文档；额度为**积分制**）：

```json
{
  "code": 200,
  "data": {
    "limits": [
      {
        "type": "TOKENS_LIMIT",
        "unit": 3,
        "number": 5,
        "usage": 800000000,
        "currentValue": 127694464,
        "remaining": 672305536,
        "percentage": 15,
        "nextResetTime": 1770648402389
      },
      {
        "type": "TIME_LIMIT",
        "unit": 5,
        "number": 1,
        "usage": 4000,
        "currentValue": 1828,
        "remaining": 2172,
        "percentage": 45,
        "usageDetails": [
          { "modelCode": "search-prime", "usage": 1433 },
          { "modelCode": "web-reader", "usage": 462 },
          { "modelCode": "zread", "usage": 0 }
        ]
      }
    ]
  },
  "success": true
}
```

字段说明（社区一致）：

| 字段 | 说明 |
|---|---|
| `success` / `code` | 业务状态；`success:false` 或 `code != 200` 视为错误；`data:{}` 通常=缺 org/project 上下文 |
| `data.limits[]` | 额度条目数组（**不要假设顺序**；`type` 是条目里的值，不是数组下标） |
| `type` | `TOKENS_LIMIT` / `CREDIT_LIMIT`（积分制，二者语义同类，需都兼容）；`TIME_LIMIT` 为工具/搜索调用次数 |
| `unit` + `number` | `unit=3` → 小时窗口（`number=5` 即 5 小时）；`unit=6` → 周窗口 |
| `percentage` | **已用**百分比（0–100） |
| `usage` | 总额度（积分/token/次数） |
| `currentValue` | 已用量 |
| `remaining` | 剩余量 |
| `nextResetTime` | 下次重置 epoch **毫秒**（`TIME_LIMIT` 可能缺失，按每月 1 日 UTC 估算） |
| `usageDetails[]` | `TIME_LIMIT` 的分工具明细（`modelCode` / `usage`） |
| `data.level` | 套餐档位（部分账号/旧响应中出现；不要强依赖） |

### 4.3 订阅信息接口（社区逆向）
- 端点：`GET https://open.bigmodel.cn/api/biz/subscription/list`（国内） / `GET https://api.z.ai/api/biz/subscription/list`（国际）
- 鉴权：`Authorization: Bearer <API Key>`（社区；国内是否裸 Key 有实现不一致，建议 Bearer 失败后回退裸 Key）
- 用途：拿套餐名 `productName`（如 “GLM Coding Max”）、状态、续费时间 `nextRenewTime`、价格/周期。

响应示例（社区真实抓包结构）：

```json
{
  "code": 200,
  "data": [
    {
      "id": "169359",
      "productName": "GLM Coding Max",
      "description": "-All Pro plan benefits...",
      "status": "VALID",
      "purchaseTime": "2026-01-12 16:55:13",
      "valid": "2026-02-12 16:55:13-2026-03-12 16:55:13",
      "autoRenew": 1,
      "initialPrice": 30.0,
      "actualPrice": 30.0,
      "currentPeriod": 2,
      "nextRenewTime": "2026-02-12",
      "billingCycle": "monthly",
      "inCurrentPeriod": true
    }
  ],
  "success": true
}
```

### 4.4 标准 API（按量付费）余额接口（社区逆向）
> 来源：[glm-for-copilot `src/consts.ts` / `usage.ts`](https://github.com/KiwiGaze/glm-for-copilot)。同样注明为非公开引用，内部账单网关接口。

- 现金账户报表：`GET https://open.bigmodel.cn/api/biz/account/query-customer-account-report`（国际把 host 换成 `https://api.z.ai`）
  - 响应 `data`: `balance`、`availableBalance`、`rechargeAmount`、`giveAmount`、`totalSpendAmount`、`frozenBalance`
- 资源包（Token 包）列表：`GET https://open.bigmodel.cn/api/biz/tokenAccounts/list/my?pageNum=1&pageSize=100`
  - 响应 `rows[]`: `tokenBalance`、`tokensMagnitude`、`status`（`EFFECTIVE` 等）、`resourcePackageName`、`suitableModel`
- 鉴权：`Authorization: Bearer <API Key>`（社区实现；国内实际可能也是裸 Key，见 4.5 的矛盾点）

> ⚠️ 反例：npm 包 `dsh-plugin-balance-panel` 的 README 声称智谱余额接口是 `GET /api/paas/v4/balance`。该路径**未被任何其他来源证实**，也不符合智谱把账单接口放在 `/api/biz/*` 的既有规律；本调研判定为**不可信**，插件不要实现该端点。

### 4.5 团队版 / 企业版
- 官方产品确认：**GLM Coding Plan 团队版**存在，面向企业自助订阅：
  - 席位制，2 席位起购，无上限；个人/团队/标准 API 三类 Key 互不通用；主管理员默认不占席位。
  - 团队标准版 5h/周积分额度 15,000 / 66,000；团队高级版 35,000 / 155,000（积分制，非 token 直接计价）。
  - 团队管理、成员用量监测、超额按量付费、预算控制、发票等能力在控制台；**官方未提供公开的团队管理/团队额度 API**。
  - 官方文档：[团队版权益](https://docs.bigmodel.cn/cn/coding-plan/team)、[套餐常见问题](https://docs.bigmodel.cn/cn/coding-plan/faq)。
- 探测团队形态的现实做法（结合社区实测）：
  1. 若用户 Key 是团队套餐 Key：额度接口必须带 `type=2` + `bigmodel-organization` + `bigmodel-project`，否则报错或空数据；
  2. `subscription/list` 的 `productName` 可能包含「团队/Team」字样（推测，未经证实）；
  3. 面板提供「组织 ID / 项目 ID / 套餐类型」可选配置项，并给出从浏览器 DevTools 获取的指引；
  4. 无法证明时 `team = unknown`，只展示已确认的窗口/套餐名。

### 4.6 鉴权矛盾点（必须在实现里容错）
| 来源 | 国内 monitor/quota | 国际 monitor/quota | 说明 |
|---|---|---|---|
| glm-for-copilot | 裸 Key | `Bearer` | 代码按 host 含 `bigmodel.cn` 判裸 Key |
| Whale Widget | 裸 Key | 裸 Key（其注释如此） | 与上冲突 |
| OpenTokenUsage | —（只做 z.ai） | `Bearer` | 注明“未公开文档” |
| pi-glm-quota | 裸 Key + org/project/type | — | 团队套餐实测 |
| mzzsfy/dsh-usage-panel | 裸 Key | — | 实现为 `rawAuth: true` |

建议：**同一 host 先按 `Bearer` 试，401/无效再试裸 Key**（或反之），并缓存成功方式；不要因为一次 401 就判定 Key 无效。请求头顺序/回退逻辑写进适配器，便于以后按实测修正。

---

## 5. 月之暗面 Kimi / Moonshot

### 5.1 识别特征
| 站点 | API host | 控制台/文档 | 币种 |
|---|---|---|---|
| 国内 | `api.moonshot.cn` | `platform.kimi.com`（原 platform.moonshot.cn 已迁移/跳转） | CNY |
| 国际 | `api.moonshot.ai` | `platform.kimi.ai` | USD |
| Kimi Code（Coding Plan） | `api.kimi.com`（base `https://api.kimi.com/coding`） | `platform.kimi.com` / `platform.kimi.ai` 的订阅入口 | CNY / 依套餐 |

- 官方明确提示：`platform.kimi.com`（国内站）与 `platform.kimi.ai`（国际站）申请的 API Key **完全独立**，混用返回 401；端点必须与 Key 所属平台一致。
- Key 形态：Moonshot API Key `sk-…`；Kimi Code/Coding Plan Key 常见 `sk-kimi-…`【社区实测】。

### 5.2 余额接口（官方确认）
- 端点：`GET https://api.moonshot.cn/v1/users/me/balance`（国内，人民币）
- 端点：`GET https://api.moonshot.ai/v1/users/me/balance`（国际，美元）
- 官方文档：[查询余额（CN）](https://platform.kimi.com/docs/api/balance) / [Check Balance（INTL）](https://platform.kimi.ai/docs/api/balance)
- 帮助中心（官方）：[余额消耗查询](https://www.kimi.com/help/kimi-api/api-balance-and-usage) 同样说明可通过 API 查询余额（含 `voucher_balance` 等字段）。

```bash
curl -s https://api.moonshot.cn/v1/users/me/balance \
  -H "Authorization: Bearer $MOONSHOT_API_KEY"
```

响应示例（**官方文档原文**，国内站单位人民币元；国际站单位美元）：

```json
{
  "code": 0,
  "data": {
    "available_balance": 49.58894,
    "voucher_balance": 46.58893,
    "cash_balance": 3.00001
  },
  "scode": "0x0",
  "status": true
}
```

字段说明（官方）：

| 字段 | 说明 |
|---|---|
| `code` | 响应码，`0` 成功 |
| `data.available_balance` | 可用余额 = 现金余额 + 代金券余额；**≤0 时无法调用推理 API** |
| `data.voucher_balance` | 代金券余额，不可为负 |
| `data.cash_balance` | 现金余额，可为负（欠费）；为负时 `available_balance` 等于 `voucher_balance` |
| `status` / `scode` | 请求状态 / 状态码 |

### 5.3 Kimi Code / Coding Plan 用量接口（未公开文档，社区实测）
- 端点：`GET https://api.kimi.com/coding/v1/usages`
- 鉴权：`Authorization: Bearer <Kimi Code Key 或 OAuth access_token>`；`Accept: application/json`
- 来源：
  - [OpenTokenUsage kimi.md](https://raw.githubusercontent.com/PowerUserZ/OpenTokenUsage/main/docs/providers/kimi.md)（标注 “Reverse-engineered, undocumented API”，并记录 OAuth 流程 `https://auth.kimi.com/api/oauth/token`）
  - [hermes-agent PR #74424](https://github.com/NousResearch/hermes-agent/pull/74424)（2026-07 对线上接口验证过响应结构，并加测试）
  - [pi-kimi-code-usage](https://www.npmjs.com/package/pi-kimi-code-usage)（对真实接口实测，`Bearer sk-kimi-...`）
- 触发条件：仅当 baseURL 是**Kimi Code 精确端点**（`https://api.kimi.com/coding` 或 `/coding/v1`）时才应查询；`api.moonshot.ai/v1`、`api.moonshot.cn/v1` 与自定义代理都应视为非订阅路由（社区实现普遍这样判定）。

```bash
curl -s https://api.kimi.com/coding/v1/usages \
  -H "Authorization: Bearer $KIMI_CODE_KEY" \
  -H "Accept: application/json"
```

响应示例（社区实测结构）：

```json
{
  "usage": {
    "limit": "100",
    "remaining": "74",
    "resetTime": "2026-02-11T17:32:50.757941Z"
  },
  "limits": [
    {
      "window": { "duration": 300, "timeUnit": "TIME_UNIT_MINUTE" },
      "detail": {
        "limit": "100",
        "remaining": "85",
        "used": "15",
        "resetTime": "2026-02-07T12:32:50.757941Z"
      }
    }
  ],
  "user": { "membership": { "level": "LEVEL_INTERMEDIATE" } },
  "parallel": { "limit": "30" },
  "boosterWallet": {
    "monthlyUsed": 1234,
    "monthlyChargeLimit": 5000
  }
}
```

字段/语义（多来源一致）：

| 字段 | 说明 |
|---|---|
| `usage.limit` / `used` / `remaining` / `resetTime` | **周配额**（订阅周期 7 天刷新），字符串数字；已用% = used/limit |
| `limits[]` | 滚动窗口列表；`window.duration` + `window.timeUnit`（`TIME_UNIT_MINUTE`）表达窗口长度（常见 300 分钟=5h） |
| `limits[].detail.{limit,used,remaining,resetTime}` | 该滚动窗口的配额与重置时间 |
| `user.membership.level` | Kimi Code 会员等级（如 `LEVEL_INTERMEDIATE`、`LEVEL_ADVANCED`），可映射为套餐档位标签 |
| `parallel.limit` | 并发上限（展示用） |
| `boosterWallet.monthlyUsed` / `monthlyChargeLimit` | 加速包月消费/上限（单位：分，CNY；社区实测口径） |

注意：该接口**未在官方 API Reference 中公开**，Kimi CLI/会员产品内部使用；结构可能随版本变化，必须容错并按字段存在性渲染。

### 5.4 订阅会员 / 团队版
- **三种“会员”不是一回事**，不要混：
  1. **Kimi Code / Coding Plan**（面向编程工具的 API 订阅）→ 唯一有 API 可查的订阅形态（5.3）。
  2. **Kimi 消费端会员**（kimi.com 网页/App 会员）→ 与 API 无关，无公开查询 API。
  3. **Kimi Business / 企业订阅**（`kimi.com/membership/pricing?...open=business`）→ 面向企业协作产品，无公开 API。
- **开放平台组织/团队**：官方《建立并认证你的组织》说明组织下的所有项目**共享组织账户余额**；企业认证可管理成员/项目/Key、项目预算与消费提醒。因此：
  - `balance` 接口返回的是**组织级共享余额**（企业账号下即为团队余额），但响应**没有 team/org 字段**，无法从 API 判断“是否团队”；
  - 没有公开的团队席位/成员/组织账单查询 API（仅控制台）；
  - 面板可展示「账户余额（组织共享）」提示，但 `team` 只能标 `unknown`。
- 官方文档：[组织管理最佳实践](https://platform.kimi.com/docs/guide/org-best-practice)。

---

## 6. 建议的统一数据模型

建议 host 侧按「每个 provider 一份快照」缓存并投影给 client；client 只负责渲染，不接触 Key。

```ts
type VendorId =
  | 'deepseek'
  | 'kimi'            // Moonshot 开放平台余额（CN/INTL 由 host 区分）
  | 'kimi-code'       // Kimi Code / Coding Plan 订阅
  | 'zhipu'           // 智谱标准 API（余额）
  | 'zhipu-coding'    // 智谱 Coding Plan（额度/订阅）
  | 'minimax'         // 按量付费（暂无可用余额接口）
  | 'minimax-plan'    // MiniMax M Plan/Token Plan 订阅
  | 'unknown';

type DetectionSource = 'providerId' | 'displayName' | 'host' | 'keyPrefix' | 'userOverride' | 'probe';

interface QuotaWindow {
  key: 'interval' | '5h' | 'weekly' | '7d' | 'monthly';
  label?: string;                 // 展示名，如 “5小时” / “每周”
  usedPercent?: number;           // 统一口径：已用 0-100（缺失时用 limit/used 推导）
  remainingPercent?: number;      // 若上游只给剩余
  limit?: number;
  used?: number;
  remaining?: number;
  resetsAt?: number;              // epoch ms（统一毫秒，便于倒计时）
  unitHint?: 'tokens' | 'credits' | 'prompts' | 'calls' | 'percent';
  details?: Array<{ name: string; usage: number }>; // 如智谱 TIME_LIMIT 的工具明细
}

interface MoneyBalance {
  currency: string;               // 'CNY' | 'USD' | ...
  total?: number;
  available?: number;
  used?: number;
  granted?: number;               // 赠送
  toppedUp?: number;              // 充值
  cash?: number;                  // Kimi 现金
  voucher?: number;               // Kimi 代金券
  frozen?: number;                // 智谱冻结
}

interface BalanceSnapshot {
  vendor: VendorId;
  detectedBy: DetectionSource;
  kind: 'balance' | 'quota' | 'mixed';
  balances: MoneyBalance[];
  windows: QuotaWindow[];
  plan?: {
    name?: string;                // 如 “GLM Coding Max”、“M Plan”
    tier?: string;                // 如 “Go / Explore / Build”、“团队标准版”
    membershipLevel?: string;     // Kimi LEVEL_xxx
    renewalAt?: number;           // epoch ms（nextRenewTime 等）
    source: 'api' | 'inferred' | 'manual';
  };
  team: {
    isTeam: boolean | 'unknown';
    orgId?: string;               // 仅当用户显式配置/接口确认
    projectId?: string;
    evidence?: string;
  };
  availability?: boolean;         // DeepSeek is_available / Kimi available_balance>0
  status: 'ok' | 'stale' | 'error' | 'unsupported' | 'need-config';
  error?: {
    httpStatus?: number;
    vendorCode?: string | number;
    category?: 'auth' | 'no-plan' | 'endpoint-gone' | 'need-context' | 'network' | 'parse';
    message: string;
  };
  fetchedAt: number;
  ttlMs: number;
}
```

展示规则建议：
- `kind = balance` → 金额 + 币种；多币种分行，不做汇率换算。
- `kind = quota` → 窗口进度条（已用% 或剩余% 固定一种口径并标注）+ 重置倒计时 + 套餐名/档位徽章。
- `kind = mixed` → 分区展示（如智谱：额度在上、现金余额在下）。
- 负余额（Kimi `cash_balance < 0`）用告警色显示“欠费”。
- `team.isTeam` 只有证据充分时才显示团队徽章；`unknown` 不显示或显示“团队：未知”。
- 数据 `stale` 时保留上次数据并标注“可能已过期”（比整块报错体验好）。

---

## 7. 探测与降级策略（插件实现建议）

### 7.1 每家的探测顺序（cascade）
| 供应商 | 顺序 | 判定成功 | 失败含义 |
|---|---|---|---|
| DeepSeek | `GET /user/balance` | 有 `balance_infos` 数组 | 401=Key 无效；其他=服务故障 |
| Kimi（余额） | `GET /v1/users/me/balance`（CN 或 INTL 由 baseURL host 决定） | `code===0` 且 `data` 存在 | 401=Key 与站点不匹配/失效 |
| Kimi Code | `GET https://api.kimi.com/coding/v1/usages` | 有 `usage` 或 `limits` | 401/403=非 Coding Plan Key；404=端点变更 |
| MiniMax M Plan | `GET {cn:www.minimax.cn, intl:www.minimax.io}/v1/token_plan/remains` → 回退 `api.minimaxi.com` / `api.minimax.io` → 回退旧路径 `/v1/api/openplatform/coding_plan/remains` | `base_resp.status_code===0` 且 `model_remains` 非空 | `1004/2049`=Key 无效/站点不匹配；`2062`=无有效套餐；空数组=无套餐数据 |
| MiniMax 按量 | 不探测（无公开接口） | — | 直接显示“余额仅控制台可查” |
| 智谱 Coding Plan | `monitor/usage/quota/limit`：先不带上下文，失败后按配置带 `?type` + org/project 头；Bearer/裸 Key 两种鉴权都试 | `data.limits` 非空 | `success:false`=Key/套餐错误；`data:{}`=缺组织上下文或非套餐 Key |
| 智谱订阅名 | `GET /api/biz/subscription/list` | `data[0].productName` | 失败仅降级套餐徽章，不影响额度 |
| 智谱标准余额 | `query-customer-account-report` →（可选）`tokenAccounts/list/my` | 有 `data` | 404/401=未开放给该 Key 类型 |
| 未知 host | 不发请求 | — | 显示“未识别供应商”+ 手动配置入口 |

### 7.2 HTTP / 业务错误降级
1. **401 / 403**
   - 先怀疑 **Key 类型或站点不匹配**（Kimi CN/INTL、MiniMax 订阅/按量、智谱三类 Key、DSH 代理 Key）。
   - 提示具体原因模板：
     - Kimi：`Key 与当前站点（国内 api.moonshot.cn / 国际 api.moonshot.ai）不匹配`
     - MiniMax：`订阅 Key（sk-cp-）才能查 M Plan 用量；按量 Key（sk-api-）无公开余额接口`
     - 智谱：`Coding Plan Key 与标准 API Key 不通用`
   - 401 不要立刻换端点重试（避免无意义请求）；仅当同厂商存在鉴权形态差异（智谱裸 Key/Bearer）时才切换重试一次。
2. **404 / 405 / 410**
   - 视为“端点下线/变更”：依次尝试 Cascade 中的备用路径；
   - 全部失败 → `status='unsupported'`，展示“该供应商暂无可用查询接口（可在设置中手动记录余额）”。
   - 参考教训：硅基流动 `/user/info` 官方公告 2026-08-14 停止服务（410），社区插件改为“无余额接口 + /v1/models 探活”——说明必须有“接口被官方下线”的降级路径。
3. **HTTP 200 + 业务错误**
   - MiniMax：读 `base_resp.status_code`，非 0 一律按错误处理；`2062` 归类 `no-plan`，`1004/2049` 归类 `auth`。
   - 智谱：`success === false` 或 `code !== 200`；`data` 为空对象 → `need-context`。
   - Kimi：`code !== 0` 或 `status !== true` → 错误；`401` 错误体 `{error:{message,type,code}}` 可用于提示。
   - DeepSeek：响应顶层可能出现 `{error:{message,type}}`，优先展示。
4. **空数据 / 无订阅**
   - `200` 但 `windows=[]`（如 MiniMax 无 `general` 桶、智谱无 `CREDENTIAL/TOKENS_LIMIT`）→ 显示“未检测到订阅套餐/额度窗口”，而不是 0%。
   - `weekly_status=0` 时隐藏周窗口（MiniMax）；智谱无 `TIME_LIMIT` 时隐藏工具用量。
5. **超时 / 网络错误**
   - 单请求超时 8–10s；失败进入指数退避（基期 60s，×2 封顶 ~8min），成功即恢复。
   - 面板保留上次成功快照并标 `stale`；从未成功过才显示错误。
6. **限流与轮询**
   - 页面可见时最小刷新间隔建议 60s（订阅额度类 ≥120s），隐藏时暂停；多窗口/多卡并发用 single-flight 去重；启动时加 0–2s 抖动，避免同时打上游。
7. **多币种/单位**
   - 币种未知时只显示数字 + 原始单位，不做换算；金额字段字符串先 trim，空串/null 不要当 0（社区插件踩过 `Number('')===0` 的坑）。
8. **安全**
   - Key 只在 host 进程使用；任何 HTTP 响应/日志/前端状态都不回传 Key（只回传 `hasKey`）。
   - 仅对白名单 host 发请求；baseURL 被用户改成未知中转站时，**不要**把厂商 Key 发过去（除非用户明确为该中转站配置了查询规则）。
   - 自定义/未知端点走“用户手填 URL + 字段路径”模式（参考 `@mzzsfy/dsh-usage-panel` 的 custom extract 设计），不要内置猜测定点。

### 7.3 建议的“探测顺序”伪代码

```ts
async function probe(providerCfg, key): Promise<BalanceSnapshot> {
  const vendor = identify(providerCfg);            // providerId / displayName / host / keyPrefix
  switch (vendor) {
    case 'deepseek':
      return deepseekBalance(baseOf(providerCfg, 'https://api.deepseek.com'), key);
    case 'kimi':
      return kimiBalance(hostIsIntl(providerCfg) ? 'https://api.moonshot.ai' : 'https://api.moonshot.cn', key);
    case 'kimi-code':
      return kimiUsages('https://api.kimi.com/coding', key);   // 非该精确 host 时不调用
    case 'minimax-plan':
      return firstOk([
        () => minimaxRemains(cnHost(providerCfg), key),
        () => minimaxRemains(intlHost(providerCfg), key),      // 仅当 host 属国际站
        () => minimaxLegacyCodingPlan(providerCfg, key),
      ]);
    case 'zhipu-coding':
      return firstOk([
        () => zhipuQuota(providerCfg, key, { auth: 'bearer' }),
        () => zhipuQuota(providerCfg, key, { auth: 'raw' }),
        () => zhipuQuota(providerCfg, key, { auth: 'raw', type: 2, org, project }), // 用户配置团队上下文后
      ]);
    case 'zhipu':
      return firstOk([() => zhipuAccountReport(providerCfg, key), () => zhipuTokenAccounts(providerCfg, key)]);
    default:
      return { status: 'unsupported', ... };                     // 不发送 Key
  }
}
```

---

## 8. 来源与可信度清单

### 官方来源（【官方】）
| 供应商 | 链接 | 确认内容 |
|---|---|---|
| DeepSeek | [Get User Balance](https://api-docs.deepseek.com/api/get-user-balance/) · [中文](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/) | `GET /user/balance`、响应字段与类型 |
| DeepSeek | [官方 FAQ「API相关」](https://static.deepseek.com/faq/index.html?lang=zh#/category/4) | 无分级套餐；个人/企业认证功能无差异 |
| MiniMax | [M Plan 常见问题（CN）](https://platform.minimax.cn/docs/m-plan/faq) | `www.minimax.cn/v1/token_plan/remains` curl；订阅 Key 与按量 Key 独立；5h/周窗口 |
| MiniMax | [M Plan FAQ（INTL）](https://platform.minimax.io/docs/m-plan/faq) | `www.minimax.io/v1/token_plan/remains` curl；M Plan 档位 Go/Explore/Build |
| MiniMax | [Usage Rules（INTL）](https://platform.minimax.io/docs/m-plan/usage-rules) | 5h 窗口从首次使用开始、周窗口、不结转 |
| MiniMax | [前置准备（CN）](https://platform.minimax.cn/docs/guides/quickstart-preparation) | 企业团队=主账号+子账号；子账号共享消耗/结算；无支付权限 |
| MiniMax | [About Account（INTL）](https://platform.minimax.io/docs/faq/about-account) | 余额仅在控制台查看/预警/自动充值 |
| 智谱 | [团队版权益](https://docs.bigmodel.cn/cn/coding-plan/team) | 团队版存在、席位制、三套 Key 不通用、5h/周积分额度 |
| 智谱 | [Coding Plan 常见问题](https://docs.bigmodel.cn/cn/coding-plan/faq) | 套餐在官方工具内使用、不支持共享、Base URL 分类 |
| 智谱 | [API Key 分类管理说明](https://docs.bigmodel.cn/cn/coding-plan/notice/api-key-management) | 三类 Key 分开管理 |
| Kimi | [查询余额（CN）](https://platform.kimi.com/docs/api/balance) · [Check Balance（INTL）](https://platform.kimi.ai/docs/api/balance) | `GET /v1/users/me/balance`、字段、币种、Key 站点独立 |
| Kimi | [余额消耗查询（帮助中心）](https://www.kimi.com/help/kimi-api/api-balance-and-usage) | 余额查询接口存在、控制台 fee-detail、项目日预算 |
| Kimi | [组织管理最佳实践](https://platform.kimi.com/docs/guide/org-best-practice) | 组织下所有项目共享账户余额、组织级 IP 白名单/成员/项目预算 |

### 社区来源（【社区实测】/【社区逆向】）
| 来源 | 项目/链接 | 用途 |
|---|---|---|
| DSH 用量面板 | [@mzzsfy/dsh-usage-panel（README/源码）](https://www.npmjs.com/package/@mzzsfy/dsh-usage-panel) · [GitHub](https://github.com/mzzsfy/dsh-plugin) | 四家端点/解析/鉴权的 DSH 生态先例（DeepSeek/Kimi/Zhipu/MiniMax） |
| DSH 余额面板 | [dsh-plugin-balance-panel](https://registry.npmjs.org/dsh-plugin-balance-panel) | DeepSeek/Moonshot/智谱余额端点先例；其中智谱 `/api/paas/v4/balance` 判为不可信 |
| 鲸鱼余额挂件 | [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) · [issue #180](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/issues/180) | 智谱额度字段/团队上下文修复记录；MiniMax/OpenCode/Kimi 模板 |
| GLM 客户端 | [glm-for-copilot](https://github.com/KiwiGaze/glm-for-copilot)（`src/consts.ts`、`src/client/usage.ts`） | 智谱 monitor/subscription/余额路径、裸 Key vs Bearer 差异 |
| 多厂商用量 | [OpenTokenUsage](https://github.com/PowerUserZ/OpenTokenUsage)（`docs/providers/*.md`） | MiniMax token_plan 字段、Z.ai monitor/subscription 真实响应、Kimi usages 结构与 OAuth |
| 智谱额度 | [pi-glm-quota](https://github.com/focksor/pi-glm-quota) | 2026-07-30 改版后团队套餐必需 `type`/`bigmodel-organization`/`bigmodel-project` |
| Kimi 用量 | [pi-kimi-code-usage](https://www.npmjs.com/package/pi-kimi-code-usage) · [hermes-agent PR #74424](https://github.com/NousResearch/hermes-agent/pull/74424) | `/coding/v1/usages` 实测结构（usage/limits/membership/boosterWallet） |
| MiniMax 订阅 | [pi-show-minimax-quota](https://www.npmjs.com/package/pi-show-minimax-quota) · [pi-show-provider-quota](https://www.npmjs.com/package/pi-show-provider-quota) | token_plan 端点、Key 前缀、错误码 1004/2049、按量 Key 走不同端点 |
| MiniMax/额度 | [tokmesh minimax_tokenplan.rs](https://docs.rs/tokmesh-cli/0.1.3/src/tokmesh_cli/commands/usage/minimax_tokenplan.rs.html) · [ai-usagebar minimax types](https://docs.rs/ai-usagebar/latest/ai_usagebar/minimax/types/) | 真实响应样例、HTTP 200 恒真、百分比=剩余、毫秒时间戳 |
| 多厂商余额 | [check_balance](https://github.com/hanmumuHL/check_balance) | DeepSeek/Moonshot/MiniMax token_plan 可直接查；智谱只有配额 |
| MiniMax 反例 | [minimax-remaining-mcp](https://pypi.org/project/minimax-remaining-mcp/) | 声称需网页 cookie、2062 错误；与本调研的 Bearer 结论冲突，已记录 |

### 明确【无法确认】
1. MiniMax **按量付费余额**接口（社区仅提及 `…/account/query_balance` 形态，无完整 host/路径/响应，官方无文档）。
2. 智谱 `/api/paas/v4/balance`（仅一个 DSH 插件 README 提及，无反证；判定不可信）。
3. 智谱 team 套餐的 `subscription/list` 是否会标出「团队」、`type=1` 是否对应个人新版（pi-glm-quota 自标“未验证”）。
4. 智谱 `data.level` 的稳定存在性（部分账号/旧响应有，新响应样例无）。
5. Kimi Code `usages` 接口的官方承诺（未公开文档；当前靠社区实测，可能变更）。
6. MiniMax `token_plan/remains` 中套餐名字段（`current_subscribe_title` 等）的稳定返回（样本未出现）。
7. DeepSeek 是否存在未公开的团队/组织用量接口（官方 FAQ 表明无分级套餐/无权益差异，按“无”处理）。

---

## 9. 给插件的落地建议（TL;DR）

1. **识别**：provider 路由名 → host 白名单 → Key 前缀提示 → 用户覆盖；未知 host 绝不发 Key。
2. **实现四类适配器**：
   - `deepseek`：余额（最简单，必须做）。
   - `kimi` / `kimi-code`：官方余额 + 未公开的 Coding Plan 用量（做好容错）。
   - `zhipu` / `zhipu-coding`：余额与额度均为逆向接口，需鉴权回退 + 团队上下文可选配置。
   - `minimax-plan`：官方 M Plan 额度；按量余额明确标注“不可查询”。
3. **统一模型**：`kind(balance/quota/mixed)` + `balances[]` + `windows[]` + `plan` + `team(unknown)` + `status/error`；client 端只渲染。
4. **降级优先于报错**：404/401/业务错误分别归类提示；保留 stale 数据；未知/不支持时显示“手动记录余额”入口而不是空白或假数据。
5. **别信单一来源**：本文件里每条结论都带可信度；实现时把「接口路径/鉴权方式/字段路径」做成可配置适配器表，便于官方改版后一天内修正。
