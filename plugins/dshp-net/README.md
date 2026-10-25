# dshp-net — 本地网络路由代理

`dshp-net` 是 `dshps` 插件栈的 Host 半插件（无独立 Web 客户端），在 `127.0.0.1`
上启动一个仅回环可达的 HTTP(S) 路由代理：按 **供应商 / 域名** 把每个请求分配到直连
或某个上游代理，并把 DSH 进程的 `HTTP_PROXY` / `HTTPS_PROXY` 指向它，从而让 DSH 里
所有模型请求（包括 SSE 流式响应）走统一、可观测、可回滚的出口。

它解决的是「同一台机器上，不同供应商需要不同出口」的问题：例如模型 A 走公司代理、
模型 B 直连、认证域名走另一条线路，同时保留一份可查看的流量与失败记录。

## 功能

- **CONNECT 隧道 + 明文 HTTP 转发**：接受 `CONNECT host:port` 与 absolute-form
  （`GET http://host/path`）请求，字节级双向管道，不缓冲、不改写，LLM SSE 原样透传。
- **每请求路由**：精确 host → 供应商附加域名（通配后缀）→ `defaultProxy` → 直连。
- **多上游代理**：`http://` 与 `https://` 上游均可；需要认证时自动附加
  `Proxy-Authorization: Basic`（密码保存在 DSH 凭据记录中，不进配置、不进 RPC）。
- **严格本地鉴权**：只接受 `Proxy-Authorization: Basic base64('dshps:'+router-token)`，
  否则返回 407，且响应中不回显期望的 token。
- **审计与统计**：有界审计环 + `total/active/failed/bytesIn/bytesOut/byProxy/byProvider`
  计数器，并计算成功率。
- **健康检查**：周期性地通过每个上游代理 CONNECT 到 `monitor.healthUrl` 测速；
  也可手动 `proxy-test`。`egress-test` 会实际发起一次进程内 `fetch`，并检查路由器是否
  观察到对应请求，用于证明「进程流量确实走了路由器」。
- **`.env` 代理接管**：备份旧值后原子改写 `$DSH_HOME/.env` 中的两个托管行，可一键回滚。

## 启用方式

插件以 bundle patch 行挂载：`id: dshp-net`，`name: dshps/plugins/dshp-net`。
它是 Host-only 子路径插件；界面位于插件栈的设置页中，实时监控和审计日志通过 dshps 悬浮球的卫星球打开独立悬浮窗查看（不与额度面板并排）。

## 配置

`Config` 为 Schemastery schema，以下字段均为 `.volatile()`，可在设置页即时修改
（`port` 例外：保存端口改动时会自动重写已接管的 `.env`，需要完整重启 DSH 才会在新端口监听）。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `17890` | 监听端口（1024–65535），仅绑定 `127.0.0.1`；可在设置页修改，被占用时自动依次尝试后续端口，最后退回系统临时端口，实际端口见设置页状态 |

发生端口避让后点「写入 .env」时，插件会把配置端口自动改成实际端口再写入，
避免"下次重启端口又变回去、`.env` 指向旧端口"的错配；之后仍需完整重启 DSH 生效。
如果 `.env` 已指向网关但端口发生变化，设置页会提示端口不匹配，需要重新写入并重启。
| `defaultProxy` | `'direct'` | 未命中任何规则时的出口：`'direct'` 或 `proxies` 中的 id |
| `proxies` | `{}` | 字典 `id → { label, url, username, enabled }`；密码不放这里 |
| `providers` | `{}` | 字典 `providerId → { proxy, domains: [] }` |
| `monitor.enabled` | `true` | 关闭后不再写入审计环，但计数器继续累计 |
| `monitor.maxLogs` | `500` | 审计环上限（50–5000） |
| `monitor.healthIntervalSeconds` | `60` | 周期健康检查间隔（0 表示关闭） |
| `monitor.healthUrl` | `https://www.gstatic.com/generate_204` | 健康检查与 egress 探测目标 |

设置页按"代理优先"组织分流：每个代理一行，行内用标签列出走该代理的供应商；
没出现在任何代理标签里的供应商默认直连。添加供应商时从可搜索列表选择，已属于其他
代理的供应商会自动移动；点供应商标签可补充认证/回调域名，× 取消分流（改为直连）。
默认出口在代理列表顶部独立选择，未匹配供应商规则的流量才使用它。

**密码与 token 不在配置里**：

- 每个上游代理的密码保存在凭据记录 `dshp-net/<proxyId>` 中，形状为
  `{ kind: 'api-key', key: '<password>' }`；
- 路由器 token 是首次 `apply` 时生成的 32 字节随机十六进制串，保存在
  `dshp-net/router-token`，跨重启复用；
- 快照只返回 `hasPassword: boolean` 与掩码后的 URL（`http://dshps:***@127.0.0.1:<port>`）。

## 路由规则

每个请求按目标 **hostname** 依次匹配：

1. 供应商目录派生的精确 host（catalog / 设置里的 `baseURL`，以及内置 DeepSeek 路由）；
2. 供应商规则里的附加域名（`providers.<id>.domains`）。`*.example.com` 与
   `example.com` 都匹配子域，最长的匹配后缀优先；
3. `defaultProxy`；
4. `direct`。

上游代理连接方式：`http://` 上游用明文 TCP 请求，`https://` 上游先 TLS 到代理；随后
发送 `CONNECT target:port`，存在密码记录时附加 Basic 凭据。直连路线直接 TCP 到目标。

行为约定：

- 命中上游代理但代理被禁用或 URL 无效时，请求以 `502` 失败（**fail closed**，不会静默
  改为直连，避免流量意外泄露到本地出口）；快照的 `health` 与审计错误会给出原因。
- 路由表包含伪供应商 `deepseek-account`（`platform.deepseek.com`、`api.deepseek.com`），
  排序遵循 DSH 设置 → 模型中的供应商顺序，不按厂商名重排。
- 明文 HTTP 支持 absolute-form，也兼容 origin-form + `Host`；管理上游代理时
  `https://` 目标必须使用 `CONNECT`（代理客户端均如此）。

## 本地鉴权

- 只监听 `127.0.0.1`，不对外网开放。
- 要求 `Proxy-Authorization: Basic base64("dshps:" + token)`，常量时间比较。
- 认证失败返回 `407 Proxy Authentication Required`，不泄露 token。
- token 与代理密码不会出现在日志、快照、`diag` 或 README 中。

## `.env` 接管与回滚

DSH 进程在启动时把 `$DSH_HOME/.env` 中的代理变量注入进程环境，因此在 DSH 内发起的
请求可以通过这个文件统一指向本地路由器。

- 环境文件：`$DSH_HOME/.env`（未设置 `DSH_HOME` 时回退到 `~/.dsh/.env`）。
- 备份文件：`$DSH_HOME/dshps/net-env.json`（权限 0600），首次 apply 时记录
  `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` 的旧值；该文件可能包含旧的
  代理凭据，撤销成功后会删除。
- apply（`env-apply`）：只重写 `HTTP_PROXY` / `HTTPS_PROXY` 两个托管行，值为
  `http://dshps:<router-token>@127.0.0.1:<port>`；其它行与注释原样保留，重复行去重；
  使用临时文件 + rename 原子写入。
- **必须完整重启 DSH 才生效**：插件重载只会重启 Host 插件，进程环境变量是启动时注入
  的。快照里 `env.pendingRestart: true` 表示「文件已写入，但当前进程还没使用它」。
- revert（`env-revert`）：有备份时恢复上述四个键的旧值（原本不存在的键删除对应行）并
  删除备份文件；没有备份时只删除与当前路由 URL 完全相同的托管行。
- 已知干扰项（快照 `env.warnings` 会提示）：
  - `ALL_PROXY` 可能优先于 `HTTP_PROXY`/`HTTPS_PROXY`，导致进程流量绕过路由器；
  - `NO_PROXY` 若命中某个已映射的供应商 host，该供应商流量会绕过路由器；
  - 只写了小写 `http_proxy` 的旧 `.env` 不会被托管，建议改成大写或留空；
  - 修改 `port` 后，保存会自动重写已接管的 `.env` 并提示完整重启 DSH；重启前网关仍监听旧端口，重启后使用新端口。

> 禁用或卸载本插件前，请先执行 `env-revert`。否则 `.env` 仍然指向一个已停止的路由器，
> DSH 的模型请求会全部失败（参见 [AGENTS.md](../../AGENTS.md) 的网络变更规则）。

## 审计与统计

审计环最多保留 `monitor.maxLogs` 条记录，最新的在前。单条记录：

```json
{ "id": 12, "at": 1700000000000, "method": "CONNECT", "host": "api.example.com",
  "port": 443, "provider": "example", "proxy": "office", "direct": false,
  "ok": true, "ms": 431, "bytesIn": 20480, "bytesOut": 1024 }
```

计数器：`total`、`active`、`failed`、`bytesIn`（上游→客户端）、`bytesOut`（客户端→上游）、
`byProxy`（按出口计数）、`byProvider`（按供应商计数）与 `successRate`（0–1）。
`monitor.enabled: false` 只关闭审计环记录，计数器仍累计；`logs-clear` 只清空审计环。

健康检查结果按代理记录 `{ ok, ms, at, error? }`，在快照的
`config.proxies[].health` 中返回；`proxy-test` 可对单个代理（或 `id: "direct"`）即时检查。

## RPC 端点

通道 `/dshp-net`，返回统一信封 `{ ok: true, value }` / `{ ok: false, error: { code, message, details } }`。
成功响应的 `value` 形如 `{ ok: true, snapshot, … }`（`ok` 与数据字段同级，与
`dshp-quota` / `dshp-models` 及 Web 客户端的读取方式一致）；失败响应的 `code` /
`message` / `details` 始终齐全。

| 端点 | 入参 | 返回 |
| --- | --- | --- |
| `snapshot` | `{}` | `{ snapshot }` |
| `config-write` | `{ config, revision? }` | `{ snapshot, warnings }` |
| `proxy-test` | `{ id }` | `{ health }` |
| `egress-test` | `{}` | `{ effective, evidence, error? }` |
| `env-apply` | `{}` | `{ env }` |
| `env-revert` | `{}` | `{ env }` |
| `logs-clear` | `{}` | `{ cleared }` |
| `diag` | `{}` | `{ diag }` |

`config-write` 约定：

- `config.proxies` 为 **全量替换**；`password` 字段：省略表示保持现有密码，非空字符串
  表示写入/覆盖，空字符串表示删除该代理的密码记录；被移除的代理会顺带清理密码记录。
- `config.providers` 为 **全量替换**，`proxy` 必须是 `'direct'` 或本次 `proxies` 中的 id。
- `defaultProxy` / `proxies` / `providers` 任一字段省略时保持当前值（提供时才按全量替换）。
- `revision` 取自 `snapshot.config.revision`；不匹配时返回 `settings-conflict`，
  其余写入失败返回 `settings-rejected`，入参校验失败返回 `bad-request`。

快照主要字段：

```jsonc
{
  "router": { "running": true, "port": 17890, "configPort": 17890, "error": null,
              "startedAt": 1700000000000, "restartRequired": false },
  "env": { "envFile": "$DSH_HOME/.env", "routerUrlMasked": "http://dshps:***@127.0.0.1:17890",
           "fileHttpProxy": "...", "processHttpProxy": "...", "noProxy": null,
           "applied": true, "effective": false, "pendingRestart": true,
           "warning": "…", "warnings": ["…"] },
  "config": { "port": 17890, "defaultProxy": "direct",
              "proxies": [{ "id": "office", "label": "Office", "url": "http://127.0.0.1:7890",
                            "username": "", "hasPassword": true, "enabled": true,
                            "health": { "ok": true, "ms": 220, "at": 1700000000000 } }],
              "providers": [{ "id": "kimi-coding", "label": "Kimi Code",
                              "hosts": ["api.kimi.com"], "proxy": "office",
                              "domains": ["*.kimi.com"], "sources": ["llm-pi-ai"] }],
              "monitor": { "enabled": true, "maxLogs": 500,
                           "healthIntervalSeconds": 60, "healthUrl": "https://…" },
              "revision": 3 },
  "stats": { "total": 40, "active": 1, "failed": 0, "bytesIn": 0, "bytesOut": 0,
             "byProxy": { "office": 12, "direct": 28 },
             "byProvider": { "kimi-coding": 12, "unmapped": 28 },
             "successRate": 1 },
  "recent": [ /* 审计记录，最新在前 */ ],
  "now": 1700000000000
}
```

`egress-test` 的结果含义：`effective: true` 表示路由器在本次探测窗口内记录到了这次
进程 `fetch`；`false` 表示进程没有经过路由器（通常是 `.env` 已写入但尚未重启 DSH，
或 `ALL_PROXY`/系统代理覆盖了变量），`error` 会给出原因。

## 限制与注意事项

- 不支持 SOCKS5 / PAC；上游 `https://` 代理使用系统 CA 校验证书，不提供跳过校验选项。
- 明文 HTTP 请求的内容会经过本进程；审计只记录元数据（host/端口/字节数/耗时），
  不记录请求内容、鉴权头或 token。
- 端口被占用时不会崩溃：快照 `router.error` 显示监听失败原因，修复后重载插件。
- 同一时间只支持一个 DSH 实例占用该端口。
- `egress-test` 依赖当前进程的全局 `fetch`；若宿主环境不支持 Node `fetch`，该端点返回
  明确的 `error`，不影响代理本身。
- 本插件不会修改项目目录中的任何文件，只写 `$DSH_HOME/.env` 与 `$DSH_HOME/dshps/` 下的
  备份/状态文件。

## 开发与测试

- 纯函数导出（供离线测试）：`parseProxyUrl`、`mergeEnvFile`、`matchRoute`、
  `redactProxyUrl`、`formatBytes`，以及 `Config`、`inject`、`apply`、`name`。
- 语法检查：`node --check plugins/dshp-net/host.js`。
- 离线测试使用 mock ctx + 临时 `DSH_HOME`，不要触碰真实 DSH 数据；设置
  `DSHPS_DISABLE_ROUTER=1` 可跳过真实监听（仅供测试）。
- 不新增运行时依赖：只用 Node 内置模块与 `@deepseek-ai/schemastery`。

## 相关文档

- [插件栈总览](../../README.md)
- [安全说明](../../SECURITY.md)
- [开发规范](../../AGENTS.md)
