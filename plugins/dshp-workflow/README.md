<!-- markdownlint-disable MD033 MD041 -->
# dshp-workflow：工作流增强

[English](README.en.md) | **简体中文**

属于 [dshps 插件栈](../../README.md)。在 DSH 里提供一套可保存、可观察、可恢复的动态工作流：模型写一份 JavaScript 编排脚本，脚本扇出子代理、只读观察工作区、按白名单执行确定性命令，并返回一份最终 JSON。它把 Claude Code「Dynamic Workflows」的产品化部分（命名工作流、模型工具、运行历史、复用）和 ZCode「Dynamic Workflows」的工程控制（结构化返回、`world.run` 确定性门、journal、resume/amend、执行白名单、预算上限）合并到同一个插件里。

`dshp-workflow` **不替换** DSH 内置的 `workflow` 工具和 `ctx.workflowEngine`。它注册自己的 `workflow_plus` 模型工具、`/workflow` 命令和 `/dshp-workflow` RPC 通道，运行自己的扩展运行时；两套工作流可以同时存在。内置 `workflow` 适合一次性的轻量扇出，`workflow_plus` 适合需要保存、观察、命令门控和恢复的场景。

## 能力一览

- **工作流库**：全局（`$DSH_HOME/dshps/workflow/workflows/`）和项目（工作区 `.dshps/workflows/`）两级；设置页可浏览、预览、删除全局工作流。
- **模型工具**：`workflow_plus`（名称可配置）运行已保存工作流或临时脚本。
- **命令**：`/workflow list|show|run|save|delete|runs|status|resume|amend|cancel|help`。
- **扩展 hooks**：`agent` / `parallel` / `pipeline` / `phase` / `log` / `args` / `report` / `artifact` / `files` / `git` / `world.run`。
- **可恢复**：运行 journal 落盘；`resume` 复用已完成的子代理调用，`amend` 复用未改动前缀。
- **安全门**：只读观察、命令执行、临时脚本执行分别有开关和白名单；执行能力默认关闭。
- **预算**：并发、子代理总数、单次条数、墙钟、`world.run` 次数、报告条数都有上限。
- **设置页**：`设置 → DSH 插件栈 → 工作流` 管理引擎、限制、安全、工作流库和运行历史。

## 安装与启用

安装整个 `dshps` bundle 后，`dshp-workflow` 行默认启用（行被停用时工具、命令和 RPC 一起停用）。

1. 按根 README 安装 bundle。
2. 确认 `dshp-workflow` 行处于激活状态。
3. 刷新 Harness 页面；「设置 → DSH 插件栈」出现「工作流」标签页。
4. 在设置页确认 `enabled` 打开、`toolName`（默认 `workflow_plus`）没有和已有工具重名。

执行类能力默认全部关闭：`allowObserve` 默认开，`allowExecute`、`allowAdHocExecute` 默认关。需要跑命令时再在设置页显式打开，并配置 `executeAllowlist` / `allowedCommands`。

## 快速开始

默认只接受**已保存的工作流**；临时脚本（模型直接写脚本运行）需要显式开启 `allowAdHocScripts`，因为脚本在 Host 进程内执行，等价于受信代码。

先保存一个可复用工作流：在工作区新建 `.dshps/workflows/review-changed.js`：

```js
/* @dshp-workflow
{
  "name": "Review changed files",
  "description": "Review every changed file and cross-check each finding.",
  "whenToUse": "PR-sized review with independent verification.",
  "capabilities": ["orchestrate", "observe"]
}
*/
phase("收集改动文件")
const changed = await git.changedFiles("origin/main")

phase("逐文件评审并复核")
const findings = await pipeline(changed, async (file) => {
  const found = await agent(`只读评审 ${file} 的安全问题，只报告有证据的问题。`, {
    label: `review:${file}`,
    schema: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: { issue: { type: "string" }, severity: { type: "string" } },
            required: ["issue", "severity"],
            additionalProperties: false
          }
        }
      },
      required: ["findings"],
      additionalProperties: false
    }
  })
  return { file, findings: found?.findings ?? [] }
})

return { conclusion: `评审了 ${changed.length} 个文件`, findings }
```

然后：

```text
/workflow run review-changed
```

或在设置页「工作流库」里预览/删除它。保存也可以直接来自工作区文件：`/workflow save review-changed .dshps/workflows/review-changed.js`。

## 工作流文档格式

工作流文件是普通的 JavaScript 文件，第一段必须是静态 JSON 注释块：

```js
/* @dshp-workflow
{
  "id": "review-changed",
  "name": "Review changed files",
  "description": "...",
  "whenToUse": "...",
  "capabilities": ["orchestrate", "observe"],
  "phases": [{ "title": "...", "detail": "..." }]
}
*/
```

- `id` 可省略，省略时由文件名或工具参数推断；格式 `[a-z][a-z0-9-]{0,63}`。
- `name`、`description` 必填；`whenToUse`、`phases` 可选，`phases` 只用于文档。
- `capabilities` 取值：`orchestrate`（隐含）、`observe`、`execute`。声明 `observe` 才能用 `files` / `git`；声明 `execute` 才能用 `world.run`。
- 正文是纯 JavaScript，支持顶层 `await` 和最终 `return`。没有 `import`、`require`、`process`、`fetch`、定时器或 Node API。
- 脚本 `return` 的值必须是可无损 JSON 序列化的数据（不能是函数、Symbol、BigInt、undefined、循环引用）。

## 脚本 hooks

| Hook | 说明 |
|---|---|
| `agent(prompt, opts?)` | 启动一个子代理并等待结果。`opts.schema` 传入 JSON Schema 时返回结构化对象，否则返回文本。普通子代理失败返回 `null`。`opts` 支持 `label`、`phase`、`schema`、`provider`、`model`、`reasoningEffort`、`maxTokens`、`preset`、`cwd`。 |
| `parallel(thunks)` | 并发执行零参函数并等待全部；抛错的项返回 `null`。 |
| `pipeline(items, ...stages)` | 每个 item 依次跑各 stage（`(prev, item, index)`）；stage 抛错时该 item 变为 `null` 并跳过后续 stage；item 之间无屏障。 |
| `phase(title)` / `log(message)` | 记录运行阶段/日志，可在设置页运行详情里查看。 |
| `args` | 工具或命令传入的 `args`，已冻结。 |
| `report(item, tag?)` | 发布中间结果，最多 64 条，会进入工具结果和运行记录。 |
| `artifact.markdown(name, content)` / `artifact.table(name, columns, rows)` / `artifact.file(name, path)` | 发布交付物；运行结束后落在运行目录 `artifacts/` 下。 |
| `files.glob(pattern)` / `files.read(path)` / `files.grep(pattern)` | 只读观察，限定在会话工作区；超过上限直接报错，不静默截断。 |
| `git.status()` / `git.diff(path?, base?)` / `git.changedFiles(base?)` / `git.log(limit?)` | 只读 git，工作区必须是 git 仓库。 |
| `world.run(command, argsArray?, opts?)` | 按 argv 精确执行一条白名单命令，不经过 shell 字符串拼接；返回 `{ exitCode, signal, timedOut, aborted, stdout, stderr }`。非零退出码是正常返回值。 |

## 安全模型

- **能力分级**：`orchestrate` 始终可用；`observe` 需要 `allowObserve`；`execute` 需要 `allowExecute`。
- **临时脚本默认关闭**：`allowAdHocScripts` 默认关；打开后模型可以直接写脚本经工具运行，脚本在 Host 进程内执行，视为受信代码，不构成沙箱。
- **执行授权绑定内容**：已保存工作流要在 `executeAllowlist` 里出现，格式 `id@sha256`；工作流内容一旦变化，旧授权自动失效。
- **命令白名单**：`allowedCommands` 默认为空，按需添加；`world.run` 的命令 basename 必须在允许列表且不在 `blockedCommands`。允许 `node`/`python`/`npm` 等命令等价于允许执行任意代码，只应添加你信任的命令。
- **工作区边界**：`files.*`、`git.*`、`artifact.file` 和 `cwd` 解析都限制在会话工作区内，越界直接报错。
- **命令执行路径**：通过 `ctx.shell` + `ctx.sandboxPolicy` 执行，继承当前会话的沙箱模式；无法读取会话策略时回退到设置里的 `sandboxMode`。
- **子代理权限**：`observe`/`execute` 只限制脚本 hooks，不限制子代理自己的工具。工作流子代理默认跟随会话 preset；建议为观察型工作流把 `childPreset` 指向只读 preset，否则子代理仍可能修改文件或执行命令。
- **VM 不是安全边界**：脚本在 `node:vm` 中运行并移除了 Node/web 全局，但这不是隔离机制；真正的安全来自能力门、路径边界、命令白名单与显式授权。不要运行不可信脚本。
- **不主动读取凭据，但不做脱敏**：插件不读取/写入 DSH 凭据；但运行记录会保存脚本、args、命令输出和子代理结果，可能包含工作区里的密钥或敏感内容。请把运行记录与 artifact 当作工作区敏感数据保护，不要公开分享。

## 运行、journal 与恢复

运行记录在 `$DSH_HOME/dshps/workflow/runs/<runId>/`：

- `run.json`：状态、阶段、日志、报告、子代理调用、观察记录、artifact 元数据和最终值；每完成一个子代理调用/观察都会原子更新。
- `artifacts/<id>.md`：markdown/table/file 交付物。

恢复语义是保守的：

| 原运行能力 | `resume` / `amend` 缓存 |
|---|---|
| 只有 `orchestrate` | 复用已完成的子代理调用 |
| 含 `observe` | 额外复用文件/git 观察结果 |
| 含 `execute` | 不允许 resume/amend（命令可能有副作用，需重新发起新运行） |
| `amend` | 从第一个与旧脚本不同的调用开始重新执行，之后的调用不再命中缓存 |

`resume` 只能在同一会话内恢复该会话发起的运行；`amend` 会创建新的 run，并记录 `amendOf` 关系。`execute` 运行的 `resume`/`amend` 会直接拒绝。

## 设置页

`设置 → DSH 插件栈 → 工作流`：

| 分组 | 字段 |
|---|---|
| 引擎 | `enabled`、`toolName`、`autoTrigger`、`subagentProvider`、`childPreset` |
| 限制 | `maxConcurrentAgents`、`maxAgentsPerRun`、`maxItemsPerCall`、`maxRunSeconds`、`maxWorldRuns`、`maxReportItems`、`runRetentionDays`、`maxSavedWorkflows` |
| 安全 | `allowObserve`、`allowExecute`、`allowAdHocExecute`、`allowAdHocScripts`、`executeAllowlist`（`id@sha256`）、`allowedCommands`（默认空）、`blockedCommands`、`sandboxMode` |
| 工作流库 | 全局工作流列表（含内容哈希）、预览、删除 |
| 运行历史 | 运行状态、阶段、日志、报告、子代理缓存标记、artifact 预览、取消 |

`autoTrigger` 控制提示词里的触发建议：`off` 不提示，`suggest` 只在用户明确要求工作流时提示，`auto` 对可分解的复杂任务主动建议使用 `workflow_plus`。它只是提示，不改变权限。

字段旁带 `?` 的提示可以悬停查看。几个容易混的英文词：

### provider 和 preset 从哪来

这两个不是 `dshp-workflow` 自带的配置，而是 DSH 运行时注册表里的名字。设置页的下拉框直接读取当前 profile 的列表，所以你不需要手输 id。

| 名称 | 从哪来 | 怎么配 |
|---|---|---|
| `spawn` | DSH 内置的子代理后端，默认值 | 不用配，子代理在 DSH 进程内运行，上下文独立 |
| `fork` | DSH 内置的子代理后端 | 继承父会话上下文；不支持固定 preset |
| `codex` / `claude-code` | profile 里安装的 subagent 插件注册 | 先在 DSH 里安装并启用对应插件；外部 CLI 可能不支持结构化返回和固定 preset |
| `standard` / `ptc` / `minimal` / `cordis` | DSH profile 的 Agent 预设，也就是新建会话时选的「模式」 | 由 profile 的 preset 声明注册，不是本插件创建；`childPreset` 固定后优先于脚本 |

下拉框里出现哪些值，取决于当前 profile 装了什么。某个 provider 缺少工作流需要的结构化返回、固定 preset 等能力时，设置页会显示警告；换 provider 前先看那条提示。

| 词 | 在这里指什么 |
|---|---|
| `provider` | 启动子代理的 DSH 后端。默认 `spawn` 在当前 DSH 进程内运行；换 provider 需要有对应后端。 |
| `preset` | DSH 的 Agent 组合预设，决定子代理带哪些工具和提示词。固定 `childPreset` 后，脚本不能再改。 |
| `capability` / `observe` / `execute` | 脚本能力档位。`orchestrate` 只调度子代理；`observe` 额外允许只读文件和 git；`execute` 再允许 `world.run` 命令。 |
| `allowlist` / `id@sha256` | 只放行明确列出的对象。执行授权把工作流 id 和内容哈希绑在一起，改内容就失效。 |
| `basename` | 命令名的最后一段，例如 `/usr/bin/git` 的 basename 是 `git`。白名单按它匹配，路径形式的命令会被拒绝。 |
| `world.run` | 脚本里的确定性命令执行：传命令名和参数数组，不经过 shell 字符串拼接。 |
| `journal` / `resume` / `amend` | 运行记录；从上次记录恢复；基于旧记录改脚本重跑。execute 运行不允许 resume/amend。 |
| `artifact` / `report` | 交付物和中间结果。artifact 落在运行目录，report 进入工具结果和运行记录。 |

## 命令与 RPC

`/workflow`：

| 子命令 | 作用 |
|---|---|
| `list [global\|project]` | 列出工作流 |
| `show <id>` | 查看工作流源码 |
| `run <id> [jsonArgs]` | 运行已保存工作流 |
| `save <id> <path>` | 把工作区内脚本保存到全局库 |
| `delete <id> [global\|project]` | 删除工作流 |
| `runs` / `status [runId]` | 查看最近运行/运行详情 |
| `resume <runId>` | 恢复运行 |
| `amend <runId> <id> [jsonArgs]` | 修订运行 |
| `cancel <runId>` | 取消本进程内运行 |

RPC 通道 `/dshp-workflow`：`snapshot`、`settings`、`settings-write`、`workflows-list`、`workflow-read`、`workflow-save`、`workflow-delete`、`runs-list`、`run-read`、`run-cancel`、`artifact-read`。客户端使用现有的认证 Connection RPC。

## 已知限制

- 没有 token 预算，只有并发/次数/墙钟/条数上限；子代理 token 不计入运行总账。
- 运行中不能插入用户指令；需要阶段签字请拆成多次运行。
- 设置页只管理全局库和运行历史，发起运行仍走 `/workflow run` 或模型工具。
- 临时脚本默认关闭；开启后在 Host 进程内执行，不是安全沙箱。
- 项目级工作流可以被模型写入，因此模型工具启动 `scope: "project"` 工作流时也要求 `allowAdHocScripts`；用户用 `/workflow run` 显式启动不受该工具门限制。
- 不做 TypeScript 编译/类型检查；结构化返回依靠显式 JSON Schema。
- `observe`/`execute` 只限制脚本 hooks，不限制子代理工具；需要严格只读时请配置只读 `childPreset`。
- 允许的命令（尤其 `node`/`python`/包管理器）本身可执行任意代码，白名单只表达“用户信任这些命令”。
- 设置页 RPC 没有会话身份：同一 profile 里任何已认证浏览器都能读取本机运行历史/取消运行；适合单用户本地使用，不要把该 RPC 暴露给不可信网络。
- `toolName` 与工具注册时捕获的 `maxRunSeconds`（工具超时）只在插件行重新加载后生效；运行时实际执行仍读取实时设置。
- Windows 下 `world.run` 通过 pwsh 单引号拼接 argv；允许的命令必须按受信代码对待。
- 没有并行的 Tower 式 worktree/审阅/合并协议；该能力不在本插件范围内。

## 开发与测试

```bash
node --check plugins/dshp-workflow/host.js
node --check plugins/dshp-workflow/lib/runtime.js
node tools/test-workflow.mjs   # runtime/meta/store 离线测试
node tools/test-host.mjs       # host 插件/RPC/工具/命令测试
node tools/test-client.mjs     # 设置页渲染测试
```

测试全部离线，使用临时 `DSH_HOME` 和假服务，不访问网络、不写真实 profile。

## 隐私

运行记录保存脚本、args、执行元数据、报告和 artifact；插件不主动读取凭据，但**不做凭据脱敏**：命令输出、子代理结果、脚本内容或 args 可能包含工作区中的密钥/敏感数据。请把运行记录与 artifact 当作工作区敏感数据保护，不要公开分享。工具和 RPC 不会主动返回 DSH 凭据。

## 许可

[MIT](../../LICENSE) © 2026 dshps contributors
