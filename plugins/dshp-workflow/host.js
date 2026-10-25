/**
 * dshp-workflow — Host half.
 *
 * A workflow library plus an extended dynamic-workflow runtime for dshps. The
 * plugin merges the productised parts of Claude Code's dynamic workflows
 * (saved named workflows, a model tool, run history) with the engineering
 * controls of ZCode's dynamic workflows (typed structured results, read-only
 * file/git observation, deterministic `world.run` gates, a run journal,
 * resume/amend cache reuse, explicit execute gates and budget caps).
 *
 * The plugin never replaces the shipped `workflow` tool or `ctx.workflowEngine`:
 * it registers its own `workflow_plus` tool, `/workflow` command and
 * `/dshp-workflow` RPC channel, and executes scripts through its own runtime in
 * `lib/runtime.js`. Saved workflows and run journals live under
 * `$DSH_HOME/dshps/workflow`.
 */

import { createHash } from 'node:crypto'
import { isAbsolute, join as joinPath } from 'node:path'
import z from '@deepseek-ai/schemastery'
import {
  WorkflowSpecError,
  assertCapabilities,
  buildDocument,
  parseWorkflowDocument,
} from './lib/meta.js'
import { createWorkflowStore, resolveHomeDir } from './lib/store.js'
import { WorkflowRunError, executeWorkflow } from './lib/runtime.js'

const CHANNEL = '/dshp-workflow'
const SETTINGS_NS = 'dshp-workflow'
const MAX_SCRIPT_BYTES = 512 * 1024
const MAX_ARGS_BYTES = 256 * 1024
const MAX_BODY_BYTES = 256 * 1024
const MAX_LOG_ENTRIES = 200
const MAX_LOG_CHARS = 100 * 1024
const MAX_RESULT_CHARS = 200 * 1024

const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']
const AUTO_TRIGGERS = ['off', 'suggest', 'auto']

/** Field ranges used by settings writes and tool/command argument validation. */
const NUMBER_FIELDS = {
  maxConcurrentAgents: { min: 1, max: 32 },
  maxAgentsPerRun: { min: 1, max: 256 },
  maxItemsPerCall: { min: 1, max: 1024 },
  maxRunSeconds: { min: 30, max: 86400 },
  maxWorldRuns: { min: 0, max: 256 },
  maxReportItems: { min: 1, max: 256 },
  runRetentionDays: { min: 1, max: 365 },
  maxSavedWorkflows: { min: 1, max: 1000 },
}

const ARRAY_FIELDS = new Set(['executeAllowlist', 'allowedCommands', 'blockedCommands'])

/**
 * Plugin configuration. Every field is volatile so the dshps settings page can
 * edit it live through the harness settings document.
 */
const Config = z.object({
  enabled: z.boolean().default(true).description('启用 dshp-workflow（工具、命令与 RPC）').volatile(),
  toolName: z.string().default('workflow_plus').description('模型侧工作流工具名').volatile(),
  autoTrigger: z.string().default('suggest')
    .description('触发策略：off 关闭提示，suggest 提示可用，auto 对大型任务主动建议').volatile(),
  subagentProvider: z.string().default('spawn').description('子代理 provider 名称').volatile(),
  maxConcurrentAgents: z.natural().min(1).max(32).default(4).description('单次运行并发子代理上限').volatile(),
  maxAgentsPerRun: z.natural().min(1).max(256).default(64).description('单次运行子代理总数上限').volatile(),
  maxItemsPerCall: z.natural().min(1).max(1024).default(128).description('单次 parallel/pipeline 处理条数上限').volatile(),
  maxRunSeconds: z.natural().min(30).max(86400).default(1800).description('单次运行墙钟上限（秒）').volatile(),
  maxWorldRuns: z.natural().min(0).max(256).default(32).description('单次运行 world.run 次数上限').volatile(),
  maxReportItems: z.natural().min(1).max(256).default(64).description('单次运行 report 条目上限').volatile(),
  allowObserve: z.boolean().default(true).description('允许 files/git 只读观察能力').volatile(),
  allowExecute: z.boolean().default(false).description('允许 world.run 执行能力（高危，默认关闭）').volatile(),
  allowAdHocExecute: z.boolean().default(false).description('允许临时脚本文档使用 execute 能力').volatile(),
  allowAdHocScripts: z.boolean().default(false)
    .description('允许模型用临时脚本直接运行（脚本在 Host 进程内执行，视为受信代码；默认关闭）').volatile(),
  childPreset: z.string().default('').description('子代理固定 preset id（留空跟随会话；观察型工作流建议只读 preset）').volatile(),
  executeAllowlist: z.array(z.string()).default([])
    .description('允许执行命令的工作流授权，格式 id@sha256（工作流内容变化即失效）').volatile(),
  allowedCommands: z.array(z.string()).default([])
    .description('world.run 允许的命令名（basename）；默认为空，显式按需添加；允许的命令等价受信代码').volatile(),
  blockedCommands: z.array(z.string()).default([]).description('world.run 禁止的命令名（优先于允许列表）').volatile(),
  sandboxMode: z.string().default('workspace-write').description('无法读取会话沙箱策略时的回退模式').volatile(),
  journalEnabled: z.boolean().default(true)
    .description('是否在 run.json 保留脚本正文；关闭后无法 resume/amend，但运行记录仍会写入').volatile(),
  runRetentionDays: z.natural().min(1).max(365).default(30).description('运行记录保留天数').volatile(),
  maxSavedWorkflows: z.natural().min(1).max(1000).default(100).description('全局保存的工作流数量上限').volatile(),
  projectWorkflowDir: z.string().default('.dshps/workflows').description('工作区内的项目级工作流目录（相对路径）').volatile(),
  defaultProvider: z.string().default('').description('子代理默认 LLM provider（留空跟随会话）').volatile(),
  defaultModel: z.string().default('').description('子代理默认模型（留空跟随会话）').volatile(),
}).description('dshps 工作流增强插件配置')

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function failure(code, message) {
  return { ok: false, error: { code, message } }
}

/** A host-facing error with a stable machine code. */
class HostError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'HostError'
    this.code = code
  }
}

/** Unwrap Schemastery live-config references (`config.foo.get()`) into plain values. */
function plainConfigLike(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((entry) => plainConfigLike(entry, depth + 1))
  if (typeof value.get === 'function') {
    try {
      return plainConfigLike(value.get(), depth + 1)
    } catch {
      return undefined
    }
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) out[key] = plainConfigLike(entry, depth + 1)
  return out
}

function defaultConfig() {
  return {
    enabled: true,
    toolName: 'workflow_plus',
    autoTrigger: 'suggest',
    subagentProvider: 'spawn',
    maxConcurrentAgents: 4,
    maxAgentsPerRun: 64,
    maxItemsPerCall: 128,
    maxRunSeconds: 1800,
    maxWorldRuns: 32,
    maxReportItems: 64,
    allowObserve: true,
    allowExecute: false,
    allowAdHocExecute: false,
    allowAdHocScripts: false,
    childPreset: '',
    executeAllowlist: [],
    allowedCommands: [],
    blockedCommands: [],
    sandboxMode: 'workspace-write',
    journalEnabled: true,
    runRetentionDays: 30,
    maxSavedWorkflows: 100,
    projectWorkflowDir: '.dshps/workflows',
    defaultProvider: '',
    defaultModel: '',
  }
}

/** Current plain plugin config (volatile config refs resolved), defaults applied. */
function readConfig(config) {
  const plain = plainConfigLike(config)
  const base = defaultConfig()
  if (!isRecord(plain)) return base
  for (const [key, value] of Object.entries(plain)) {
    if (value === undefined) continue
    base[key] = value
  }
  if (!Number.isFinite(base.maxConcurrentAgents) || base.maxConcurrentAgents < 1) base.maxConcurrentAgents = 4
  if (!Array.isArray(base.executeAllowlist)) base.executeAllowlist = []
  if (!Array.isArray(base.allowedCommands)) base.allowedCommands = []
  if (!Array.isArray(base.blockedCommands)) base.blockedCommands = []
  if (!SANDBOX_MODES.includes(base.sandboxMode)) base.sandboxMode = 'workspace-write'
  if (!AUTO_TRIGGERS.includes(base.autoTrigger)) base.autoTrigger = 'suggest'
  return base
}

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

function byteLength(text) {
  return Buffer.byteLength(String(text), 'utf8')
}

function quoteArgv(argv) {
  // `ctx.shell` on Windows is the pwsh-sandbox provider and on POSIX the
  // bash-sandbox provider. PowerShell needs the call operator before a quoted
  // command token; POSIX resolves the quoted argv[0] directly.
  const quote = process.platform === 'win32'
    ? (part) => `'${String(part).replace(/'/g, "''")}'`
    : (part) => `'${String(part).replace(/'/g, "'\\''")}'`
  return (process.platform === 'win32' ? '& ' : '') + argv.map(quote).join(' ')
}

function textBlocks(output) {
  if (!Array.isArray(output)) return ''
  return output
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function boundedJson(value, maxChars) {
  try {
    const text = JSON.stringify(value)
    if (typeof text !== 'string') return null
    return text.length > maxChars ? { truncated: true, text: text.slice(0, maxChars) } : { truncated: false, value }
  } catch {
    return null
  }
}

function runSummary(run) {
  return {
    id: run.id,
    workflowId: run.workflowId,
    name: run.name,
    scope: run.scope,
    status: run.status,
    stopReason: run.stopReason,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    agentsStarted: typeof run.agentsStarted === 'number'
      ? run.agentsStarted
      : Array.isArray(run.agents) ? run.agents.length : 0,
    usage: isRecord(run.usage) ? run.usage : { agents: 0, worldRuns: 0, durationMs: 0 },
  }
}

/** Public projection of a run record: no script body, no journal keys. */
function publicRun(run) {
  if (!isRecord(run)) return null
  return {
    id: run.id,
    workflowId: run.workflowId,
    name: run.name,
    scope: run.scope,
    meta: run.meta,
    args: run.args,
    cwd: run.cwd,
    status: run.status,
    stopReason: run.stopReason,
    error: run.error,
    value: run.value,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    phases: Array.isArray(run.phases) ? run.phases : [],
    logs: Array.isArray(run.logs) ? run.logs : [],
    reports: Array.isArray(run.reports) ? run.reports : [],
    artifacts: Array.isArray(run.artifacts) ? run.artifacts : [],
    agents: Array.isArray(run.agents)
      ? run.agents.map((entry) => ({
        seq: entry.seq,
        label: entry.label,
        status: entry.status,
        provider: entry.provider,
        model: entry.model,
        preset: entry.preset,
        cached: entry.cached === true,
        startedAt: entry.startedAt,
        endedAt: entry.endedAt,
        childId: entry.childId,
      }))
      : [],
    usage: isRecord(run.usage) ? run.usage : { agents: 0, worldRuns: 0, durationMs: 0 },
  }
}

function errorPayload(error) {
  const code = typeof error?.code === 'string' ? error.code : 'operation-error'
  return { code, message: messageOf(error) }
}

// ---------------------------------------------------------------------------
// settings helpers
// ---------------------------------------------------------------------------

function normalizeArrayField(value) {
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\n,]+/)
      : []
  const seen = new Set()
  const out = []
  for (const part of parts) {
    const text = String(part ?? '').trim()
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    out.push(text.slice(0, 200))
    if (out.length >= 200) break
  }
  return out
}

/** Normalize one settings value; throws HostError on invalid input. */
function normalizeSetting(field, value) {
  if (ARRAY_FIELDS.has(field)) return normalizeArrayField(value)
  if (field === 'enabled' || field === 'allowObserve' || field === 'allowExecute'
    || field === 'allowAdHocExecute' || field === 'allowAdHocScripts'
    || field === 'journalEnabled') {
    if (typeof value !== 'boolean') throw new HostError('bad-request', `${field} 必须是布尔值`)
    return value
  }
  if (field === 'childPreset') {
    const text = String(value ?? '').trim()
    if (text.length > 0 && !/^[a-z][a-z0-9-]{0,63}$/.test(text)) throw new HostError('bad-request', 'childPreset 不合法')
    return text
  }
  if (field === 'toolName') {
    const text = String(value ?? '').trim()
    if (!TOOL_NAME_PATTERN.test(text)) throw new HostError('bad-request', 'toolName 不合法')
    return text
  }
  if (field === 'autoTrigger') {
    const text = String(value ?? '').trim()
    if (!AUTO_TRIGGERS.includes(text)) throw new HostError('bad-request', 'autoTrigger 不合法')
    return text
  }
  if (field === 'sandboxMode') {
    const text = String(value ?? '').trim()
    if (!SANDBOX_MODES.includes(text)) throw new HostError('bad-request', 'sandboxMode 不合法')
    return text
  }
  if (field in NUMBER_FIELDS) {
    const number = Number(value)
    if (!Number.isFinite(number)) throw new HostError('bad-request', `${field} 必须是数字`)
    const range = NUMBER_FIELDS[field]
    return Math.min(range.max, Math.max(range.min, Math.round(number)))
  }
  if (field === 'subagentProvider') {
    const text = String(value ?? '').trim()
    if (text.length === 0 || text.length > 120) throw new HostError('bad-request', 'subagentProvider 不合法')
    return text
  }
  if (field === 'projectWorkflowDir') {
    const text = String(value ?? '').trim().replace(/[\\/]+$/, '')
    if (text.length === 0 || isAbsolute(text) || text.split(/[\\/]/).includes('..')) {
      throw new HostError('bad-request', 'projectWorkflowDir 必须是工作区内的相对路径')
    }
    return text
  }
  if (field === 'defaultProvider' || field === 'defaultModel') {
    return String(value ?? '').trim().slice(0, 200)
  }
  throw new HostError('bad-request', `未知配置字段：${field}`)
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

/**
 * Build the runtime service object. One service instance serves every session in
 * the Host process; runs are tracked in-process for cancellation and liveness.
 */
function makeService(ctx, rawConfig) {
  const config = () => readConfig(rawConfig)
  const homeDir = resolveHomeDir(process.env)
  const store = createWorkflowStore({ homeDir })
  const activeRuns = new Map()
  const started = { pruned: false }

  function effectiveSettings() {
    const cfg = config()
    try {
      const descriptors = ctx.settings?.describe?.()
      const list = Array.isArray(descriptors) ? descriptors : []
      const own = list.find((entry) => isRecord(entry) && entry.ns === SETTINGS_NS)
      const value = isRecord(own?.value) ? own.value : {}
      return { available: own !== undefined, revision: own?.revision, value: { ...cfg, ...value }, config: cfg }
    } catch (error) {
      return { available: false, revision: undefined, value: cfg, config: cfg, error: messageOf(error) }
    }
  }

  function settingsDocument() {
    const doc = effectiveSettings()
    return {
      ok: true,
      available: doc.available,
      ns: SETTINGS_NS,
      revision: doc.revision,
      value: doc.value,
      config: doc.config,
      ...(doc.error ? { error: doc.error } : {}),
    }
  }

  async function writeSettings(ops, expectedRevision) {
    if (!ctx.settings || typeof ctx.settings.mutate !== 'function') {
      return failure('settings-unavailable', '设置服务不可用')
    }
    const clean = []
    for (const op of Array.isArray(ops) ? ops : []) {
      if (!isRecord(op) || !Array.isArray(op.path) || op.path.length !== 1) continue
      const field = String(op.path[0])
      if (!(field in defaultConfig())) continue
      if (op.op === 'unset') {
        clean.push({ op: 'unset', path: [field] })
        continue
      }
      if (op.op !== 'set') continue
      try {
        clean.push({ op: 'set', path: [field], value: normalizeSetting(field, op.value) })
      } catch (error) {
        return failure(error?.code || 'bad-request', messageOf(error))
      }
    }
    if (clean.length === 0) return failure('bad-request', '没有可写入的配置项')
    try {
      await ctx.settings.mutate(SETTINGS_NS, clean, typeof expectedRevision === 'number' ? expectedRevision : undefined)
      return settingsDocument()
    } catch (error) {
      const message = messageOf(error)
      return failure(/conflict|stale|revision/i.test(message) ? 'settings-conflict' : 'settings-rejected', message)
    }
  }

  function sessionOf(agent) {
    if (!agent) return undefined
    try {
      return ctx.sessions?.get?.(agent.id)
    } catch {
      return undefined
    }
  }

  function agentCwd(agent) {
    const session = sessionOf(agent)
    try {
      if (session && typeof ctx.workingDirectory?.get === 'function') {
        const dir = ctx.workingDirectory.get(session)
        if (typeof dir === 'string' && dir.length > 0) return dir
      }
      if (typeof ctx.workingDirectory?.defaultDirectory === 'string') return ctx.workingDirectory.defaultDirectory
    } catch {
      /* fall through */
    }
    return process.cwd()
  }

  function projectDirFor(cwd, cfg = config()) {
    const configured = typeof cfg.projectWorkflowDir === 'string' ? cfg.projectWorkflowDir.trim() : ''
    const safe = configured.length > 0
      && !isAbsolute(configured)
      && !configured.split(/[\\/]/).includes('..')
      ? configured
      : '.dshps/workflows'
    return joinPath(cwd, safe)
  }

  function ensureEnabled() {
    const cfg = config()
    if (!cfg.enabled) throw new HostError('workflow-disabled', 'dshp-workflow 已在设置中关闭')
    return cfg
  }

  async function ensureStore() {
    await store.ensure()
    if (!started.pruned) {
      started.pruned = true
      try {
        const retentionMs = config().runRetentionDays * 24 * 60 * 60 * 1000
        await store.pruneRuns({ olderThanMs: retentionMs })
      } catch {
        /* retention is best effort */
      }
    }
  }

  function assertExecuteGate(doc, workflowId, cfg, sourceHash) {
    const capabilities = Array.isArray(doc?.meta?.capabilities) ? doc.meta.capabilities : []
    assertCapabilities(doc.meta, cfg)
    if (!capabilities.includes('execute')) return
    if (workflowId) {
      const entry = `${workflowId}@${sourceHash}`
      if (!cfg.executeAllowlist.includes(entry)) {
        throw new HostError(
          'execute-not-allowed',
          `工作流 ${workflowId} 未获准执行；在设置页加入 ${entry}（内容变化后需重新授权）`,
        )
      }
    } else if (!cfg.allowAdHocExecute) {
      throw new HostError('execute-not-allowed', '临时脚本使用 execute 能力需要开启 allowAdHocExecute')
    }
  }

  async function resolveDocument({ workflowId, scope, script, meta, cwd, cfg }) {
    if (workflowId) {
      const found = await store.readWorkflow({
        id: workflowId,
        scope: scope || 'global',
        projectDir: projectDirFor(cwd, cfg),
      })
      const parsed = parseWorkflowDocument(found.text, workflowId)
      return {
        document: parsed,
        workflowId,
        scope: found.scope,
        sourceText: found.text,
        sourceHash: sha256(found.text),
      }
    }
    if (typeof script !== 'string' || script.trim().length === 0) {
      throw new HostError('bad-request', '必须提供 name 或 script')
    }
    if (!cfg.allowAdHocScripts) {
      throw new HostError(
        'ad-hoc-disabled',
        '临时脚本默认关闭（脚本在 Host 进程内执行，视为受信代码）；请先保存为工作流，或在设置中开启 allowAdHocScripts',
      )
    }
    if (!isRecord(meta)) throw new HostError('bad-request', '临时脚本必须提供 meta 对象')
    if (byteLength(script) > MAX_SCRIPT_BYTES) throw new HostError('bad-request', '脚本超过 512 KB 上限')
    const fallbackId = 'adhoc-' + sha256(script).slice(0, 12)
    const document = buildDocument(meta, script, fallbackId)
    const sourceText = `/* @dshp-workflow ${JSON.stringify(document.meta)} */\n${document.body}`
    return {
      document,
      workflowId: null,
      scope: 'ad-hoc',
      sourceText,
      sourceHash: sha256(sourceText),
    }
  }

  function buildCache(prior) {
    const agents = new Map()
    const observations = new Map()
    const agentOrder = []
    const observationOrder = []
    if (!isRecord(prior)) return { agents, observations, agentOrder, observationOrder }
    for (const entry of Array.isArray(prior.agents) ? prior.agents : []) {
      if (!isRecord(entry) || typeof entry.key !== 'string') continue
      agentOrder.push(entry.key)
      if (entry.status !== 'completed') continue
      agents.set(entry.key, {
        stopReason: 'completed',
        text: typeof entry.outputText === 'string' ? entry.outputText : '',
        structured: entry.structured,
      })
    }
    for (const entry of Array.isArray(prior.observations) ? prior.observations : []) {
      if (!isRecord(entry) || typeof entry.key !== 'string') continue
      observationOrder.push(entry.key)
      observations.set(entry.key, entry.value)
    }
    return { agents, observations, agentOrder, observationOrder }
  }

  function makeRuntimeServices({ agent, cwd, cfg }) {
    const session = sessionOf(agent)
    let rootTarget

    async function fsRoot() {
      if (!rootTarget) rootTarget = await ctx.fs.resolve(cwd)
      return rootTarget
    }

    async function resolveTarget(path) {
      const target = await ctx.fs.resolve(String(path), { cwd })
      const root = await fsRoot()
      let inside = false
      try {
        inside = ctx.fs.contains(root, target)
      } catch {
        inside = false
      }
      if (!inside) throw new WorkflowRunError('WF_PATH_OUTSIDE', `路径不在工作区内：${path}`)
      return target
    }

    return {
      workspaceRoot: cwd,
      sessionId: String(agent.id),
      logger: ctx.logger,
      async startAgent(spec) {
        const request = {
          prompt: [{ type: 'text', text: String(spec.prompt ?? '') }],
          parent: agent,
          maxDepth: 1,
        }
        if (spec.schema) request.outputSchema = spec.schema
        // A fixed deployment restriction wins over a script-provided preset.
        const preset = cfg.childPreset || spec.preset
        if (preset) request.agentPreset = preset
        if (typeof spec.cwd === 'string' && spec.cwd.length > 0) {
          const target = await resolveTarget(spec.cwd)
          request.cwd = ctx.fs.processPath(target)
        }
        const agentOptions = {}
        const provider = spec.provider || cfg.defaultProvider
        const model = spec.model || cfg.defaultModel
        if (provider) agentOptions.provider = provider
        if (model) agentOptions.model = model
        if (spec.reasoningEffort) agentOptions.reasoningEffort = spec.reasoningEffort
        if (spec.maxTokens) agentOptions.maxTokens = spec.maxTokens
        if (Object.keys(agentOptions).length > 0) request.agentOptions = agentOptions
        const activation = await ctx.subagents.startActivation({
          provider: cfg.subagentProvider || 'spawn',
          label: spec.label || 'workflow-agent',
          request,
          signal: spec.signal,
          delivery: 'caller',
        })
        let disposed = false
        const disposeActivation = async () => {
          if (disposed) return
          disposed = true
          try {
            await activation.dispose?.()
          } catch {
            /* cleanup is best effort */
          }
        }
        let removeAbortListener
        try {
          // The caller signal only cancels an unpublished start. Once the
          // activation is published, abort must dispose it explicitly.
          let aborted
          if (spec.signal) {
            aborted = new Promise((resolve) => {
              if (spec.signal.aborted) {
                resolve({ cancelled: true })
                return
              }
              const onAbort = () => resolve({ cancelled: true })
              spec.signal.addEventListener('abort', onAbort, { once: true })
              removeAbortListener = () => spec.signal.removeEventListener('abort', onAbort)
            })
          }
          const outcome = aborted === undefined
            ? { value: await activation.result }
            : await Promise.race([
              activation.result.then((value) => ({ value })),
              aborted,
            ])
          if (outcome.cancelled === true) {
            return {
              stopReason: 'cancelled',
              text: '',
              structured: undefined,
              childId: activation.childId === undefined ? undefined : String(activation.childId),
            }
          }
          return {
            stopReason: outcome.value?.stopReason || 'error',
            text: textBlocks(outcome.value?.output),
            structured: outcome.value?.structured,
            childId: activation.childId === undefined ? undefined : String(activation.childId),
          }
        } finally {
          if (removeAbortListener) removeAbortListener()
          await disposeActivation()
        }
      },
      async runCommand(spec) {
        let sandboxPolicy
        try {
          sandboxPolicy = ctx.sandboxPolicy.resolve({ session })
        } catch {
          // Fail closed: a missing session policy must never widen access.
          sandboxPolicy = { mode: 'read-only', workspaceRoot: cwd }
        }
        let workdir = cwd
        if (spec.cwd) {
          const target = await resolveTarget(spec.cwd)
          workdir = ctx.fs.processPath(target)
        }
        const request = {
          command: quoteArgv(spec.argv),
          workdir,
          timeoutMs: spec.timeoutMs || 300000,
          onExpiry: 'kill',
          stdoutMaxBytes: spec.maxBytes || 65536,
          signal: spec.signal,
          sandboxPolicy,
        }
        const shellSpec = ctx.shell.resolve(request)
        const execution = await ctx.shell.execute(shellSpec)
        const result = await execution.result()
        return {
          exitCode: result?.exitCode ?? null,
          signal: result?.signal ?? null,
          timedOut: result?.timedOut === true,
          aborted: result?.aborted === true,
          stdout: typeof result?.stdout?.text === 'string' ? result.stdout.text : '',
          stderr: typeof result?.stderr?.text === 'string' ? result.stderr.text : '',
          sandbox: result?.sandbox,
        }
      },
      async readTextFile(path) {
        const target = await resolveTarget(path)
        const text = await ctx.fs.readText(target)
        if (byteLength(text) > 512 * 1024) throw new WorkflowRunError('WF_LIMIT', `文件超过 512 KB 上限：${path}`)
        return text
      },
      async listDir(path) {
        const target = await resolveTarget(path)
        const entries = await ctx.fs.listDir(target)
        return (Array.isArray(entries) ? entries : []).map((entry) => ({
          name: String(entry?.name ?? ''),
          type: entry?.type === 'directory' ? 'directory' : entry?.type === 'file' ? 'file' : 'other',
          size: typeof entry?.size === 'number' ? entry.size : undefined,
        }))
      },
      async statFile(path) {
        const target = await resolveTarget(path)
        const info = await ctx.fs.stat(target)
        if (!info) return undefined
        return { type: info.type, size: info.size }
      },
      async resolvePath(path) {
        const target = await resolveTarget(path)
        return ctx.fs.processPath(target)
      },
    }
  }

  async function runRequest({ agent, workflowId, scope, script, meta, args, resumeOf, amendOf, signal }) {
    const cfg = ensureEnabled()
    if (!agent) throw new HostError('agent-required', '工作流运行需要一个发起 Agent')
    if (!ctx.subagents || typeof ctx.subagents.startActivation !== 'function') {
      throw new HostError('subagent-unavailable', '子代理服务不可用，无法运行工作流')
    }
    if (args !== undefined && args !== null) {
      const bytes = byteLength(JSON.stringify(args))
      if (bytes > MAX_ARGS_BYTES) throw new HostError('bad-request', 'args 超过 256 KB 上限')
    }
    if (byteLength(JSON.stringify(meta ?? {})) > MAX_ARGS_BYTES) {
      throw new HostError('bad-request', 'meta 超过 256 KB 上限')
    }

    await ensureStore()
    const cwd = agentCwd(agent)
    let priorRun
    let resolved
    if (resumeOf) {
      priorRun = await store.readRun(resumeOf)
      if (!priorRun) throw new HostError('run-not-found', `找不到运行记录：${resumeOf}`)
      if (priorRun.status === 'running') throw new HostError('run-active', '该运行仍在进行中')
      if (priorRun.sessionId !== String(agent.id)) throw new HostError('run-session-mismatch', '只能在发起该运行的会话中 resume')
      if (typeof priorRun.script !== 'string') throw new HostError('run-corrupt', '运行记录缺少脚本，无法 resume')
      resolved = {
        document: parseWorkflowDocument(priorRun.script),
        workflowId: priorRun.workflowId || null,
        scope: priorRun.scope || 'global',
        sourceText: priorRun.script,
        sourceHash: sha256(priorRun.script),
      }
      args = args === undefined ? priorRun.args : args
    } else if (amendOf) {
      priorRun = await store.readRun(amendOf)
      if (!priorRun) throw new HostError('run-not-found', `找不到运行记录：${amendOf}`)
      if (priorRun.sessionId !== String(agent.id)) throw new HostError('run-session-mismatch', '只能在发起该运行的会话中 amend')
      resolved = await resolveDocument({
        workflowId: workflowId || priorRun.workflowId || undefined,
        scope: scope || priorRun.scope,
        script,
        meta,
        cwd,
        cfg,
      })
      args = args === undefined ? priorRun.args : args
    } else {
      resolved = await resolveDocument({ workflowId, scope, script, meta, cwd, cfg })
    }

    const { document } = resolved
    const effectiveWorkflowId = resolved.workflowId || null
    const sourceHash = typeof resolved.sourceHash === 'string' ? resolved.sourceHash : sha256(resolved.sourceText || '')
    const priorCapabilities = Array.isArray(priorRun?.meta?.capabilities) ? priorRun.meta.capabilities : []
    if (priorRun && priorCapabilities.includes('execute')) {
      throw new HostError(
        'execute-resume-unsupported',
        'execute 运行不支持自动 resume/amend：命令可能有副作用，请重新发起一次新的运行并人工确认',
      )
    }
    assertExecuteGate(document, effectiveWorkflowId, cfg, sourceHash)

    const capabilities = Array.isArray(document.meta.capabilities) ? document.meta.capabilities : []
    const isExecute = capabilities.includes('execute')
    let cachePolicy = resumeOf ? 'resume' : amendOf ? 'amend' : 'none'
    if (isExecute) cachePolicy = 'none'
    if (cachePolicy !== 'none' && !priorRun) cachePolicy = 'none'
    const cache = cachePolicy === 'none' ? { agents: new Map(), observations: new Map() } : buildCache(priorRun)

    const scriptText = `/* @dshp-workflow ${JSON.stringify(document.meta)} */\n${document.body}`
    if (byteLength(scriptText) > MAX_SCRIPT_BYTES) throw new HostError('bad-request', '脚本超过 512 KB 上限')

    const run = await store.createRun({
      workflowId: effectiveWorkflowId,
      scope: resolved.scope,
      name: document.meta.name,
      meta: document.meta,
      scriptHash: sourceHash,
      args,
      sessionId: String(agent.id),
      cwd,
    })
    run.script = scriptText
    if (cfg.journalEnabled) await store.updateRun(run.id, { script: scriptText })

    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', abortFromCaller, { once: true })
    }
    activeRuns.set(run.id, {
      controller,
      startedAt: run.startedAt,
      workflowId: effectiveWorkflowId,
      sessionId: String(agent.id),
    })

    const startedAt = Date.now()
    const artifacts = []
    let flushTimer = null
    let flushChain = Promise.resolve()
    let finished = false

    const scheduleFlush = () => {
      if (finished || flushTimer) return
      flushTimer = setTimeout(() => {
        flushTimer = null
        const patch = {
          phases: run.phases,
          logs: run.logs,
          reports: run.reports,
          agents: run.agents,
          observations: run.observations,
          usage: run.usage,
        }
        flushChain = flushChain.then(() => store.updateRun(run.id, patch)).catch((error) => {
          ctx.logger?.warn?.('dshp-workflow: journal flush failed: %s', messageOf(error))
        })
      }, 200)
    }

    const services = makeRuntimeServices({ agent, cwd, cfg })
    let outcome
    try {
      outcome = await executeWorkflow({
        document,
        args,
        config: cfg,
        services,
        runId: run.id,
        signal: controller.signal,
        cache,
        cachePolicy,
        onEvent(event) {
          if (!isRecord(event)) return
          if (event.type === 'phase') run.phases.push({ title: event.title, at: event.at })
          else if (event.type === 'log') {
            run.logs.push({ message: String(event.message ?? '').slice(0, 4000), at: event.at })
            if (run.logs.length > MAX_LOG_ENTRIES) run.logs.splice(0, run.logs.length - MAX_LOG_ENTRIES)
            const joined = run.logs.map((entry) => entry.message).join('\n')
            if (joined.length > MAX_LOG_CHARS) run.logs.splice(0, Math.ceil(run.logs.length / 2))
          } else if (event.type === 'report') {
            run.reports.push({
              item: event.item,
              tag: event.tag,
              seq: event.seq,
              at: event.at,
            })
          }
          scheduleFlush()
        },
        async onAgentCall(record) {
          run.agents.push(record)
          run.usage.agents = run.agents.length
          scheduleFlush()
        },
        async onObservation(record) {
          run.observations.push(record)
          scheduleFlush()
        },
      })
    } catch (error) {
      outcome = {
        value: null,
        stopReason: 'error',
        error: error instanceof WorkflowRunError ? error : new HostError('workflow-failed', messageOf(error)),
        reports: [],
        artifacts: [],
        usage: { agents: 0, worldRuns: 0, durationMs: Date.now() - startedAt },
      }
    } finally {
      finished = true
      if (flushTimer) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      activeRuns.delete(run.id)
      if (signal) signal.removeEventListener?.('abort', abortFromCaller)
    }
    await flushChain.catch(() => {})

    const endedAt = Date.now()
    const stopReason = outcome.stopReason === 'completed' ? 'completed' : outcome.stopReason === 'cancelled' ? 'cancelled' : 'error'
    const status = stopReason === 'completed' ? 'completed' : stopReason === 'cancelled' ? 'cancelled' : 'failed'
    const error = stopReason === 'error'
      ? { code: typeof outcome.error?.code === 'string' ? outcome.error.code : 'workflow-failed', message: messageOf(outcome.error) }
      : undefined
    const valueInfo = boundedJson(outcome.value ?? null, MAX_RESULT_CHARS)
    if (valueInfo && valueInfo.truncated) {
      run.value = { truncated: true, text: valueInfo.text }
    } else {
      run.value = valueInfo ? valueInfo.value : null
    }
    const artifactWrites = []
    for (const artifact of Array.isArray(outcome.artifacts) ? outcome.artifacts : []) {
      artifactWrites.push(
        store.addArtifact(run.id, {
          name: String(artifact.name ?? 'artifact'),
          kind: String(artifact.kind ?? 'markdown'),
          content: String(artifact.content ?? ''),
        }).then((created) => {
          artifacts.push(created)
          run.artifacts = artifacts
        }).catch((artifactError) => {
          ctx.logger?.warn?.('dshp-workflow: artifact write failed: %s', messageOf(artifactError))
        }),
      )
    }
    await Promise.allSettled(artifactWrites)

    run.status = status
    run.stopReason = stopReason
    run.error = error
    run.endedAt = endedAt
    run.usage = {
      agents: Number.isFinite(outcome.usage?.agents) ? outcome.usage.agents : run.agents.length,
      worldRuns: Number(outcome.usage?.worldRuns ?? 0),
      durationMs: endedAt - startedAt,
      calls: run.agents.length,
    }
    run.phases = run.phases.slice(0, 512)
    run.reports = run.reports.slice(0, 512)
    const finalPatch = {
      status: run.status,
      stopReason: run.stopReason,
      error: run.error,
      endedAt: run.endedAt,
      value: run.value,
      phases: run.phases,
      logs: run.logs,
      reports: run.reports,
      artifacts: run.artifacts,
      agents: run.agents,
      observations: run.observations,
      usage: run.usage,
    }
    if (cfg.journalEnabled) finalPatch.script = scriptText
    try {
      await store.updateRun(run.id, finalPatch)
    } catch (error) {
      // Never leave a finished run stuck as `running` because the rich final
      // patch could not be written; fall back to a status-only update.
      ctx.logger?.warn?.('dshp-workflow: final journal write failed: %s', messageOf(error))
      try {
        await store.updateRun(run.id, {
          status: run.status,
          stopReason: run.stopReason,
          error: run.error,
          endedAt: run.endedAt,
          usage: run.usage,
        })
      } catch (fallbackError) {
        ctx.logger?.warn?.('dshp-workflow: status-only journal fallback failed: %s', messageOf(fallbackError))
      }
    }

    return {
      runId: run.id,
      stopReason,
      status,
      value: run.value,
      error,
      reports: run.reports,
      artifacts: run.artifacts,
      usage: run.usage,
    }
  }

  // ---- library / RPC views -------------------------------------------------

  /** Live provider/preset choices for the settings pickers. */
  async function runtimeOptions() {
    const providers = []
    try {
      const names = typeof ctx.subagents?.list === 'function' ? ctx.subagents.list() : []
      for (const name of Array.isArray(names) ? names : []) {
        let provider
        try {
          provider = typeof ctx.subagents?.getProvider === 'function' ? ctx.subagents.getProvider(name) : undefined
        } catch {
          provider = undefined
        }
        providers.push({
          id: String(name),
          inheritsParentContext: provider?.inheritsParentContext === true,
          capabilities: isRecord(provider?.capabilities) ? provider.capabilities : {},
        })
      }
    } catch (error) {
      ctx.logger?.warn?.('dshp-workflow: provider list failed: %s', messageOf(error))
    }
    const presets = []
    try {
      if (typeof ctx.agentPresets?.list === 'function') {
        const listed = await ctx.agentPresets.list()
        for (const preset of Array.isArray(listed) ? listed : []) {
          if (!isRecord(preset) || typeof preset.id !== 'string') continue
          presets.push({
            id: preset.id,
            name: typeof preset.name === 'string' ? preset.name : '',
            description: typeof preset.description === 'string' ? preset.description : '',
            broken: typeof preset.broken === 'string' ? preset.broken : '',
          })
        }
      }
    } catch (error) {
      ctx.logger?.warn?.('dshp-workflow: preset list failed: %s', messageOf(error))
    }
    return { providers, presets }
  }

  async function listGlobalWorkflows() {
    await ensureStore()
    const listed = await store.listWorkflows({})
    const out = []
    for (const entry of listed) {
      const item = { ...entry }
      if (!entry.invalid) {
        try {
          const found = await store.readWorkflow({ id: entry.id, scope: entry.scope })
          item.hash = sha256(found.text)
        } catch {
          /* keep the list entry readable even if the file changed under us */
        }
      }
      out.push(item)
    }
    return out
  }

  async function snapshot() {
    const cfg = config()
    const settings = effectiveSettings()
    let workflows = []
    let runs = []
    try {
      workflows = await listGlobalWorkflows()
    } catch (error) {
      ctx.logger?.warn?.('dshp-workflow: workflow list failed: %s', messageOf(error))
    }
    try {
      runs = (await store.listRuns({ limit: 30 })).map(runSummary)
    } catch (error) {
      ctx.logger?.warn?.('dshp-workflow: run list failed: %s', messageOf(error))
    }
    const runtime = await runtimeOptions()
    return {
      ok: true,
      settings: settings.value,
      revision: settings.revision,
      workflows,
      runs,
      activeRuns: [...activeRuns.keys()],
      providers: runtime.providers,
      presets: runtime.presets,
    }
  }

  async function workflowsList(payload) {
    if (isRecord(payload) && payload.scope === 'project') {
      return failure('scope-requires-agent', '项目作用域只能在 /workflow 命令或模型工具里访问')
    }
    return { ok: true, workflows: await listGlobalWorkflows() }
  }

  async function workflowRead(payload) {
    if (!isRecord(payload) || typeof payload.id !== 'string') return failure('bad-request', '缺少工作流 id')
    if (payload.scope === 'project') return failure('scope-requires-agent', '项目作用域只能在 /workflow 命令或模型工具里访问')
    const found = await store.readWorkflow({ id: payload.id, scope: 'global' })
    return { ok: true, document: found.text, meta: found.meta, hash: sha256(found.text) }
  }

  async function workflowSave(payload) {
    if (!isRecord(payload)) return failure('bad-request', '缺少请求体')
    ensureEnabled()
    if (payload.scope === 'project') return failure('scope-requires-agent', '项目作用域只能在 /workflow 命令或模型工具里访问')
    const scope = 'global'
    const id = typeof payload.id === 'string' ? payload.id : ''
    if (!ID_PATTERN.test(id)) return failure('bad-request', '工作流 id 不合法')
    const text = String(payload.text ?? '')
    if (byteLength(text) > MAX_SCRIPT_BYTES) return failure('bad-request', '脚本超过 512 KB 上限')
    parseWorkflowDocument(text, id)
    const existing = await store.listWorkflows({})
    const globalCount = existing.filter((entry) => entry.scope === 'global').length
    const isOverwrite = existing.some((entry) => entry.scope === 'global' && entry.id === id)
    const cfg = config()
    if (!isOverwrite && globalCount >= cfg.maxSavedWorkflows) {
      return failure('limit-reached', `全局工作流数量已达上限 ${cfg.maxSavedWorkflows}`)
    }
    const saved = await store.saveWorkflow({ id, scope, text })
    return { ok: true, workflow: saved }
  }

  async function workflowDelete(payload) {
    ensureEnabled()
    if (!isRecord(payload) || typeof payload.id !== 'string') return failure('bad-request', '缺少工作流 id')
    if (payload.scope === 'project') return failure('scope-requires-agent', '项目作用域只能在 /workflow 命令或模型工具里访问')
    const deleted = await store.deleteWorkflow({ id: payload.id, scope: 'global' })
    return { ok: true, deleted }
  }

  async function runsList(payload) {
    const limit = isRecord(payload) && Number.isFinite(payload.limit) ? Math.max(1, Math.min(200, Math.round(payload.limit))) : 50
    const runs = (await store.listRuns({ limit })).map(runSummary)
    return { ok: true, runs }
  }

  async function runRead(payload) {
    if (!isRecord(payload) || typeof payload.runId !== 'string') return failure('bad-request', '缺少 runId')
    const run = await store.readRun(payload.runId)
    if (!run) return failure('run-not-found', `找不到运行记录：${payload.runId}`)
    return { ok: true, run: publicRun(run) }
  }

  async function runCancel(payload) {
    if (!isRecord(payload) || typeof payload.runId !== 'string') return failure('bad-request', '缺少 runId')
    const active = activeRuns.get(payload.runId)
    if (!active) return failure('run-not-active', '该运行不在本进程的活跃列表中')
    active.controller.abort(new Error('cancelled from settings'))
    return { ok: true, cancelled: true }
  }

  async function artifactRead(payload) {
    if (!isRecord(payload) || typeof payload.runId !== 'string' || typeof payload.artifactId !== 'string') {
      return failure('bad-request', '缺少 runId 或 artifactId')
    }
    const artifact = await store.readArtifact(payload.runId, payload.artifactId)
    return { ok: true, artifact }
  }

  function canonicalWorkflowId(payload) {
    if (!isRecord(payload)) return undefined
    if (typeof payload.name === 'string' && payload.name.length > 0) return payload.name
    if (typeof payload.workflowId === 'string' && payload.workflowId.length > 0) return payload.workflowId
    return undefined
  }

  // ---- model tool ----------------------------------------------------------

  const toolParameters = {
    type: 'object',
    properties: {
      name: { type: 'string', description: '已保存工作流 id（全局或项目）；与 script 二选一' },
      scope: { type: 'string', enum: ['global', 'project'], description: '已保存工作流的作用域，默认 global' },
      script: { type: 'string', description: '临时脚本正文（需要同时提供 meta）；与 name 二选一' },
      meta: { type: 'object', description: '临时脚本的 meta：name、description、capabilities 等' },
      args: { type: 'object', description: '传给脚本 args 全局的 JSON 对象' },
      resumeOf: { type: 'string', description: '可选：从该运行记录 resume（复用已完成子代理调用）' },
      amendOf: { type: 'string', description: '可选：以该运行记录为缓存基线运行修订版脚本' },
    },
    additionalProperties: false,
  }

  const toolOutput = {
    schema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        status: { type: 'string' },
        stopReason: { type: 'string' },
        value: {},
        reports: { type: 'array' },
        artifacts: { type: 'array' },
        usage: { type: 'object' },
        error: { type: 'object' },
      },
      required: ['runId', 'status', 'stopReason'],
    },
    render(_args, value) {
      if (!isRecord(value)) return [{ type: 'text', text: 'dshp-workflow: empty result' }]
      const lines = [
        `dshp-workflow "${String(value.runId ?? '')}" ${String(value.status ?? '')} (${String(value.stopReason ?? '')}).`,
      ]
      if (isRecord(value.usage)) {
        lines.push(`agents=${value.usage.agents ?? 0} worldRuns=${value.usage.worldRuns ?? 0} durationMs=${value.usage.durationMs ?? 0}`)
      }
      if (value.error) lines.push(`error: ${value.error.code || 'error'}: ${value.error.message || ''}`)
      const result = boundedJson(value.value, 20000)
      if (result) {
        lines.push('Return value:')
        lines.push(result.truncated ? result.text : JSON.stringify(result.value, null, 2))
      }
      const artifacts = Array.isArray(value.artifacts) ? value.artifacts : []
      if (artifacts.length > 0) lines.push(`artifacts: ${artifacts.map((entry) => `${entry.id}:${entry.name}`).join(', ')}`)
      return [{ type: 'text', text: lines.join('\n') }]
    },
  }

  const toolDefinition = {
    name: config().toolName,
    description: [
      'Run a JavaScript workflow script that orchestrates many subagents at scale.',
      'Use ONLY when the user explicitly asks for a workflow or large multi-agent orchestration,',
      'or when a task clearly needs fan-out plus independent cross-checking (audit many files,',
      'migrations, multi-angle research). Prefer plain subagent calls for one or two delegations.',
      '',
      'Script hooks: agent(prompt, opts?), parallel(thunks), pipeline(items, ...stages),',
      'phase(title), log(message), args, report(item, tag?), artifact.markdown/table/file.',
      'With meta.capabilities including "observe": files.glob/read/grep and git.status/diff/',
      'changedFiles/log. With "execute": world.run(command, args, opts?) executing an allowlisted',
      'argv without a shell. Run `name` (saved workflow) or pass script+meta (ad-hoc; only when',
      'the user enabled allowAdHocScripts; runs in-process as trusted code, not a sandbox).',
      'The plugin settings page manages saved workflows and run history.',
    ].join('\n'),
    parameters: toolParameters,
    output: toolOutput,
    timeoutMs: Math.max(60, config().maxRunSeconds + 60) * 1000,
    async execute(rawArgs, exec) {
      const cfg = ensureEnabled()
      if (!isRecord(rawArgs)) throw new HostError('bad-request', '参数必须是对象')
      const hasName = typeof rawArgs.name === 'string' && rawArgs.name.length > 0
      const hasScript = typeof rawArgs.script === 'string' && rawArgs.script.length > 0
      if (hasName === hasScript) throw new HostError('bad-request', 'name 与 script 必须且只能提供一个')
      if (!exec.agent) throw new HostError('agent-required', '工作流工具需要一个发起 Agent')
      if (hasName && rawArgs.scope === 'project' && !cfg.allowAdHocScripts) {
        throw new HostError(
          'project-workflow-gated',
          '项目级工作流可由模型写入，工具启动时按临时脚本处理；需要开启 allowAdHocScripts，或由用户用 /workflow run 启动',
        )
      }
      if (rawArgs.args !== undefined && !isRecord(rawArgs.args)) throw new HostError('bad-request', 'args 必须是对象')
      const outcome = await runRequest({
        agent: exec.agent,
        workflowId: hasName ? rawArgs.name : undefined,
        scope: typeof rawArgs.scope === 'string' ? rawArgs.scope : undefined,
        script: hasScript ? rawArgs.script : undefined,
        meta: isRecord(rawArgs.meta) ? rawArgs.meta : undefined,
        args: rawArgs.args,
        resumeOf: typeof rawArgs.resumeOf === 'string' ? rawArgs.resumeOf : undefined,
        amendOf: typeof rawArgs.amendOf === 'string' ? rawArgs.amendOf : undefined,
        signal: exec.signal,
      })
      const output = {
        runId: outcome.runId,
        status: outcome.status,
        stopReason: outcome.stopReason,
        value: outcome.value,
        reports: outcome.reports.slice(0, 20),
        artifacts: outcome.artifacts,
        usage: outcome.usage,
      }
      if (outcome.error) output.error = outcome.error
      if (outcome.reports.length > 20) {
        output.note = `truncated ${outcome.reports.length - 20} reports; see the run detail in settings`
      }
      return output
    },
    presentCall(args) {
      const title = isRecord(args) && typeof args.name === 'string'
        ? `workflow: ${args.name}`
        : isRecord(args) && isRecord(args.meta) && typeof args.meta.name === 'string'
          ? `workflow: ${args.meta.name}`
          : 'workflow'
      return { card: 'generic', title, rawInput: args }
    },
  }

  // ---- command -------------------------------------------------------------

  function formatRun(run) {
    const lines = [
      `${run.id} · ${run.name || run.workflowId || 'ad-hoc'} · ${run.status || run.stopReason || 'unknown'}`,
      `started=${new Date(run.startedAt || Date.now()).toISOString()} agents=${Array.isArray(run.agents) ? run.agents.length : 0} durationMs=${run.usage?.durationMs ?? 0}`,
    ]
    if (run.error) lines.push(`error: ${run.error.code}: ${run.error.message}`)
    return lines.join('\n')
  }

  async function handleCommand(agent, rawInput, signal) {
    const cfg = ensureEnabled()
    const input = String(rawInput ?? '').trim()
    const [command, ...restParts] = input.split(/\s+/)
    const rest = input.slice(command.length).trim()
    try {
      if (!command || command === 'help') {
        return { kind: 'success', text: [
          '用法：',
          '/workflow list [global|project] — 列出已保存工作流',
          '/workflow show <id> — 查看工作流脚本',
          '/workflow run <id> [jsonArgs] — 运行已保存工作流',
          '/workflow save <id> <path> — 把工作区脚本保存到全局库',
          '/workflow delete <id> [global|project] — 删除工作流',
          '/workflow runs — 最近运行记录',
          '/workflow status [runId] — 查看运行状态',
          '/workflow resume <runId> — 从中断的运行恢复（复用已完成子代理调用）',
          '/workflow amend <runId> <id> [jsonArgs] — 修订运行（复用未改动前缀）',
          '/workflow cancel <runId> — 取消本进程内运行中的工作流',
        ].join('\n') }
      }
      if (command === 'list') {
        const scope = rest === 'project' ? 'project' : 'global'
        const all = await store.listWorkflows({
          projectDir: projectDirFor(agentCwd(agent), cfg),
        })
        const rows = all.filter((entry) => entry.scope === scope)
        if (rows.length === 0) return { kind: 'success', text: `没有 ${scope} 工作流` }
        return { kind: 'success', text: rows.map((entry) => `${entry.id}  [${entry.capabilities.join(',')}]  ${entry.name}`).join('\n') }
      }
      if (command === 'show') {
        const id = rest.split(/\s+/)[0]
        if (!id) return { kind: 'error', text: '缺少工作流 id' }
        let found
        try {
          found = await store.readWorkflow({ id, scope: 'global', projectDir: projectDirFor(agentCwd(agent), cfg) })
        } catch (error) {
          if (error?.code !== 'WF_WORKFLOW_NOT_FOUND') throw error
          found = await store.readWorkflow({ id, scope: 'project', projectDir: projectDirFor(agentCwd(agent), cfg) })
        }
        const text = found.text.length > 12000 ? `${found.text.slice(0, 12000)}\n… [truncated]` : found.text
        return { kind: 'success', text }
      }
      if (command === 'run') {
        const match = rest.match(/^(\S+)(?:\s+([\s\S]*))?$/)
        if (!match) return { kind: 'error', text: '用法：/workflow run <id> [jsonArgs]' }
        const id = match[1]
        let args
        if (match[2] && match[2].trim().length > 0) {
          try {
            args = JSON.parse(match[2])
          } catch {
            return { kind: 'error', text: '参数不是合法 JSON' }
          }
        }
        let outcome
        try {
          outcome = await runRequest({ agent, workflowId: id, scope: 'global', args, signal })
        } catch (error) {
          if (error?.code !== 'WF_WORKFLOW_NOT_FOUND') throw error
          outcome = await runRequest({ agent, workflowId: id, scope: 'project', args, signal })
        }
        const preview = boundedJson(outcome.value, 4000)
        return {
          kind: 'success',
          text: [
            `工作流已结束：${outcome.runId} · ${outcome.status} (${outcome.stopReason})`,
            `agents=${outcome.usage.agents} worldRuns=${outcome.usage.worldRuns} durationMs=${outcome.usage.durationMs}`,
            ...(outcome.error ? [`error: ${outcome.error.code}: ${outcome.error.message}`] : []),
            ...(preview ? ['Return value:', preview.truncated ? preview.text : JSON.stringify(preview.value, null, 2)] : []),
          ].join('\n'),
        }
      }
      if (command === 'save') {
        const match = rest.match(/^(\S+)\s+(.+)$/)
        if (!match) return { kind: 'error', text: '用法：/workflow save <id> <path>' }
        const id = match[1]
        if (!ID_PATTERN.test(id)) return { kind: 'error', text: 'id 不合法' }
        const session = sessionOf(agent)
        const cwd = agentCwd(agent)
        const target = await ctx.fs.resolve(match[2].trim(), { cwd })
        const root = await ctx.fs.resolve(cwd)
        if (!ctx.fs.contains(root, target)) return { kind: 'error', text: '只能保存工作区内的脚本' }
        const text = await ctx.fs.readText(target)
        if (byteLength(text) > MAX_SCRIPT_BYTES) return { kind: 'error', text: '脚本超过 512 KB 上限' }
        parseWorkflowDocument(text, id)
        await store.saveWorkflow({ id, scope: 'global', projectDir: projectDirFor(cwd, cfg), text })
        return { kind: 'success', text: `已保存全局工作流 ${id}（${session ? cwd : cwd}）` }
      }
      if (command === 'delete') {
        const match = rest.match(/^(\S+)(?:\s+(global|project))?$/)
        if (!match) return { kind: 'error', text: '用法：/workflow delete <id> [global|project]' }
        const deleted = await store.deleteWorkflow({
          id: match[1],
          scope: match[2] === 'project' ? 'project' : 'global',
          projectDir: projectDirFor(agentCwd(agent), cfg),
        })
        return deleted.deleted
          ? { kind: 'success', text: `已删除 ${match[1]}` }
          : { kind: 'error', text: `找不到 ${match[1]}` }
      }
      if (command === 'runs') {
        const runs = await store.listRuns({ limit: 10 })
        if (runs.length === 0) return { kind: 'success', text: '还没有运行记录' }
        return { kind: 'success', text: runs.map((run) => `${run.id} · ${run.name} · ${run.status} · agents=${run.agentsStarted}`).join('\n') }
      }
      if (command === 'status') {
        const id = rest.split(/\s+/)[0]
        if (!id) {
          const runs = await store.listRuns({ limit: 1 })
          if (runs.length === 0) return { kind: 'success', text: '还没有运行记录' }
          const run = await store.readRun(runs[0].id)
          return { kind: 'success', text: run ? formatRun(run) : '找不到运行记录' }
        }
        const run = await store.readRun(id)
        return run ? { kind: 'success', text: formatRun(run) } : { kind: 'error', text: `找不到运行记录 ${id}` }
      }
      if (command === 'resume') {
        const id = rest.split(/\s+/)[0]
        if (!id) return { kind: 'error', text: '用法：/workflow resume <runId>' }
        const outcome = await runRequest({ agent, resumeOf: id, signal })
        return { kind: 'success', text: `resume 完成：${outcome.runId} · ${outcome.status}` }
      }
      if (command === 'amend') {
        const match = rest.match(/^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/)
        if (!match) return { kind: 'error', text: '用法：/workflow amend <runId> <id> [jsonArgs]' }
        let args
        if (match[3] && match[3].trim().length > 0) {
          try {
            args = JSON.parse(match[3])
          } catch {
            return { kind: 'error', text: '参数不是合法 JSON' }
          }
        }
        const outcome = await runRequest({ agent, amendOf: match[1], workflowId: match[2], scope: 'global', args, signal })
        return { kind: 'success', text: `amend 完成：${outcome.runId} · ${outcome.status}` }
      }
      if (command === 'cancel') {
        const id = rest.split(/\s+/)[0]
        if (!id) return { kind: 'error', text: '用法：/workflow cancel <runId>' }
        const active = activeRuns.get(id)
        if (!active) return { kind: 'error', text: `运行 ${id} 不在本进程的活跃列表中` }
        active.controller.abort(new Error('cancelled by command'))
        return { kind: 'success', text: `已请求取消 ${id}` }
      }
      return { kind: 'error', text: `未知子命令：${command}` }
    } catch (error) {
      return { kind: 'error', text: messageOf(error) }
    }
  }

  // ---- dispatch ------------------------------------------------------------

  async function dispatch(endpoint, payload, signal) {
    try {
      if (endpoint === 'snapshot') return await snapshot()
      if (endpoint === 'runtime-options') return { ok: true, ...(await runtimeOptions()) }
      if (endpoint === 'settings') return settingsDocument()
      if (endpoint === 'settings-write') {
        if (!isRecord(payload)) return failure('bad-request', '缺少请求体')
        return await writeSettings(payload.ops, typeof payload.revision === 'number' ? payload.revision : undefined)
      }
      if (endpoint === 'workflows-list') return await workflowsList(payload)
      if (endpoint === 'workflow-read') return await workflowRead(payload)
      if (endpoint === 'workflow-save') return await workflowSave(payload)
      if (endpoint === 'workflow-delete') return await workflowDelete(payload)
      if (endpoint === 'runs-list') return await runsList(payload)
      if (endpoint === 'run-read') return await runRead(payload)
      if (endpoint === 'run-cancel') return await runCancel(payload)
      if (endpoint === 'artifact-read') return await artifactRead(payload)
      return failure('bad-request', `未知端点：${String(endpoint)}`)
    } catch (error) {
      return failure(error?.code || 'operation-error', messageOf(error))
    }
  }

  function disposeAll() {
    for (const [, active] of activeRuns) {
      try {
        active.controller.abort(new Error('plugin disposed'))
      } catch {
        /* ignore */
      }
    }
    activeRuns.clear()
  }

  return {
    dispatch,
    handleCommand,
    runRequest,
    settings: { document: settingsDocument, write: writeSettings },
    tool: toolDefinition,
    disposeAll,
    activeRunIds: () => [...activeRuns.keys()],
    paths: () => store.paths(),
  }
}

// ---------------------------------------------------------------------------
// fallback RPC route (same pattern as dshp-quota / dshps root)
// ---------------------------------------------------------------------------

function registerOwnRpcRoute(ctx, service) {
  const webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined
  if (!webServer || typeof webServer.register !== 'function') return undefined
  if (typeof ctx?.connection?.admit !== 'function') return undefined
  return webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const admission = ctx.connection.admit(req)
      if (isRecord(admission) && 'rejection' in admission) {
        const status = admission.rejection === 403 ? 403 : 401
        res.writeHead(status)
        res.end(status === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end('method not allowed')
        return
      }
      const pathname = new URL(req.url || '/', 'http://localhost').pathname
      const endpoint = pathname === CHANNEL ? '' : pathname.startsWith(`${CHANNEL}/`) ? pathname.slice(CHANNEL.length + 1) : ''
      if (!/^[A-Za-z0-9_$.-]+$/.test(endpoint)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      const chunks = []
      let size = 0
      let tooLarge = false
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          tooLarge = true
          break
        }
        chunks.push(chunk)
      }
      if (tooLarge) {
        res.writeHead(413)
        res.end('payload too large')
        return
      }
      let message
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      const rpcId = isRecord(message) && typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const result = await service.dispatch(endpoint, isRecord(message) ? message.payload : undefined, undefined)
      const ok = result.ok === true
      const envelope = {
        type: 'server-response',
        rpcId,
        result: ok
          ? { ok: true, value: result }
          : { ok: false, error: { code: result.error?.code || 'operation-error', message: result.error?.message || 'failed', details: {} } },
      }
      const body = JSON.stringify(envelope)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    },
  })
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export const inject = [
  'connection',
  'settings',
  'subagents',
  'shell',
  'sandboxPolicy',
  'fs',
  'workingDirectory',
  'sessions',
  'tools',
  'commands',
  'systemPrompt',
  'agentPresets',
]

export function apply(ctx, rawConfig) {
  const service = makeService(ctx, rawConfig)
  const disposers = []

  let rpcDispose
  try {
    if (typeof ctx.connection?.rpc?.handle === 'function') {
      rpcDispose = ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload, signal) => {
        const result = await service.dispatch(endpoint, payload, signal)
        if (result.ok === true) return { ok: true, value: result }
        return {
          ok: false,
          error: {
            code: typeof result.error?.code === 'string' ? result.error.code : 'operation-error',
            message: typeof result.error?.message === 'string' ? result.error.message : 'workflow request failed',
            details: {},
          },
        }
      })
    }
  } catch (error) {
    ctx.logger?.warn?.('dshp-workflow: connection.rpc.handle 不可用，改用插件自有路由：%s', messageOf(error))
  }
  if (typeof rpcDispose !== 'function') {
    try {
      rpcDispose = registerOwnRpcRoute(ctx, service)
    } catch (error) {
      ctx.logger?.warn?.('dshp-workflow: 回退 RPC 路由注册失败：%s', messageOf(error))
    }
  }
  if (typeof rpcDispose === 'function') disposers.push(rpcDispose)

  if (typeof ctx.systemPrompt?.section === 'function') {
    try {
      disposers.push(ctx.systemPrompt.section({
        name: 'dshp-workflow',
        order: 900,
        text: () => {
          const cfg = readConfig(rawConfig)
          if (!cfg.enabled || cfg.autoTrigger === 'off') return ''
          const mode = cfg.autoTrigger === 'auto'
            ? 'For substantive multi-step tasks that decompose into independent pieces, prefer writing a workflow script instead of delegating turn by turn.'
            : 'A workflow orchestration tool is available when the user explicitly asks for a workflow or large multi-agent orchestration.'
          return [
            `dshp-workflow: you can use the \`${cfg.toolName}\` tool to run a JavaScript orchestration script.`,
            mode,
            'Prefer plain subagent calls for one or two delegations. Scripts may use agent/parallel/pipeline/phase/log/args/report/artifact;',
            'files/git observation and world.run command gates are only available when the workflow meta declares those capabilities and the plugin settings allow them.',
          ].join(' ')
        },
      }))
    } catch (error) {
      ctx.logger?.warn?.('dshp-workflow: 提示段注册失败：%s', messageOf(error))
    }
  }

  if (typeof ctx.tools?.register === 'function') {
    try {
      disposers.push(ctx.tools.register(service.tool))
    } catch (error) {
      ctx.logger?.warn?.('dshp-workflow: 工具注册失败（%s）：%s', service.tool.name, messageOf(error))
    }
  }

  if (typeof ctx.commands?.register === 'function') {
    try {
      disposers.push(ctx.commands.register({
        name: 'workflow',
        description: 'dshps workflow: list/show/run/save/delete/runs/status/resume/amend/cancel',
        input: { hint: '<subcommand> [args]' },
        handler: (invocation) => service.handleCommand(invocation.agent, invocation.rawInput, invocation.signal),
      }))
    } catch (error) {
      ctx.logger?.warn?.('dshp-workflow: 命令注册失败：%s', messageOf(error))
    }
  }

  try {
    ctx.effect?.(() => {
      return () => {
        try {
          service.disposeAll()
        } catch {
          /* ignore */
        }
        for (const dispose of disposers) {
          try {
            if (typeof dispose === 'function') dispose()
          } catch {
            /* already withdrawn */
          }
        }
      }
    }, 'dshp-workflow: rpc/tool/command')
  } catch (error) {
    ctx.logger?.warn?.('dshp-workflow: 清理注册失败：%s', messageOf(error))
  }

  ctx.logger?.info?.('dshp-workflow: 已注册 /dshp-workflow 通道与 workflow 工具（%s）', service.paths().rootDir)
}

export { Config }
export const name = 'dshp-workflow'
