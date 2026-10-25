/**
 * Workflow runtime for `dshp-workflow`.
 *
 * TRUSTED-CODE EXECUTION — NOT A SECURITY SANDBOX. The `node:vm` context hides
 * `require`, `process`, `fetch`, timers and other Node APIs, and string/wasm
 * code generation is disabled, but `vm` is explicitly not a security boundary:
 * workflow scripts are trusted code written by the parent agent or a saved file,
 * and a determined script can still reach host objects. The host must keep
 * enforcing the real controls it already owns (workspace-bounded file access,
 * the `world.run` command allowlist, sandbox policy and capability gates); the
 * runtime only adds guardrails, resource caps and journaling on top.
 *
 * `executeWorkflow()` runs a plain-JavaScript workflow body with only the
 * documented hooks (`agent`, `parallel`, `pipeline`, `phase`, `log`, `args`,
 * `report`, `artifact`, `files`, `git`, `world`) plus standard ECMAScript
 * globals.
 *
 * Everything the runtime touches outside the VM is injected through
 * `request.services`, so this module has no DSH imports and is unit-testable
 * with fakes.
 * @module dshp-workflow/lib/runtime
 */
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import vm from 'node:vm'
import { normalizeMeta } from './meta.js'

const DEFAULT_LIMITS = Object.freeze({
  maxConcurrentAgents: 4,
  maxAgentsPerRun: 64,
  maxItemsPerCall: 128,
  maxRunSeconds: 1800,
  maxWorldRuns: 32,
  maxReportItems: 64,
  // Total byte caps for journaled narration and stored artifacts. The host
  // separately caps the model-facing result text (reports are additionally
  // bounded per item).
  maxLogBytes: 100 * 1024,
  maxReportBytes: 256 * 1024,
  maxArtifacts: 64,
  maxArtifactBytes: 256 * 1024,
  maxArtifactTotalBytes: 1024 * 1024,
  syncTimeoutMs: 5000,
})

// Fail closed: `world.run` needs an explicit allowlist. The host supplies its
// configured list (which defaults to empty); a partial runtime config that omits
// `allowedCommands` therefore permits nothing.
const DEFAULT_ALLOWED_COMMANDS = Object.freeze([])
const AGENT_OPTION_NAMES = [
  'label', 'phase', 'schema', 'provider', 'model',
  'reasoningEffort', 'maxTokens', 'preset', 'cwd', 'cache',
]
const AGENT_OPTION_KEYS = new Set(AGENT_OPTION_NAMES)

const MAX_LOG_CHARS = 4000
const MAX_REPORT_ITEM_BYTES = 32 * 1024
const MAX_FILE_BYTES = 256 * 1024
const MAX_GLOB_PATHS = 2000
const MAX_GLOB_ENTRIES = 100000
const MAX_GREP_MATCHES = 2000
const MAX_GREP_BYTES = 256 * 1024
const MAX_WORLD_OUTPUT_BYTES = 64 * 1024
const DEFAULT_WORLD_TIMEOUT_MS = 300 * 1000
const GIT_TIMEOUT_MS = 60 * 1000
const MAX_TABLE_COLUMNS = 32
const MAX_ARTIFACT_NAME = 200
const MAX_PHASES = 512

const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const SCHEMA_CONSTRAINT_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const SCHEMA_ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples'])
const CACHE_POLICIES = ['none', 'resume', 'amend']

/**
 * Typed workflow-runtime error. `code` is a stable machine-routable string:
 * `WF_LIMIT`, `WF_BUDGET_EXCEEDED`, `WF_COMMAND_DENIED`, `WF_PATH_OUTSIDE`,
 * `WF_RESULT_INVALID`, `WF_SCHEMA_INVALID`, `WF_CANCELLED`,
 * `WF_ARGUMENT_INVALID`, `WF_SCRIPT_ERROR` and `WF_CAPABILITY_DENIED`.
 * `fatal` marks errors the combinators must propagate instead of turning the
 * item into `null` (hook misuse, caps and capability denials).
 */
export class WorkflowRunError extends Error {
  /**
   * @param {string} code stable failure class
   * @param {string} message human-readable message
   * @param {{ fatal?: boolean, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(String(message ?? ''), options !== null && typeof options === 'object' && options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'WorkflowRunError'
    this.code = String(code)
    this.fatal = options !== null && typeof options === 'object' && options.fatal === false ? false : true
  }
}

function runError(code, message) {
  return new WorkflowRunError(code, message)
}

function errorText(error) {
  if (error instanceof Error) return error.message
  if (error === undefined) return 'undefined'
  try {
    if (error !== null && typeof error === 'object' && typeof error.message === 'string') return error.message
    return String(error)
  } catch {
    return 'unknown error'
  }
}

/**
 * Whether a combinator (`parallel`/`pipeline`) must re-throw `error` instead
 * of mapping the item to `null`. The rule is deliberately explicit:
 *
 * - FATAL: hook misuse, capability denials, tripped caps, cancellation and
 *   command/path refusals — these are host-created `WorkflowRunError`s (a
 *   script cannot forge `instanceof`) and must kill the whole run, even inside
 *   a combinator, so typos and budget breaches never hide behind a null.
 * - ORDINARY: child-run failures (`agent()` already resolves `null` itself) and
 *   errors thrown by the script or its stages are per-item problems and become
 *   `null`.
 */
function isFatalWorkflowError(error) {
  return error instanceof WorkflowRunError && error.fatal !== false
}

/** Map any thrown value to a typed `{ code, message }` result error. */
function errorObject(error) {
  if (error instanceof WorkflowRunError) return { code: error.code, message: error.message }
  return { code: 'WF_SCRIPT_ERROR', message: errorText(error) }
}

/** Map any thrown value onto a WorkflowRunError without trusting forged codes. */
function toWorkflowRunError(error, fallbackCode = 'WF_SCRIPT_ERROR') {
  if (error instanceof WorkflowRunError) return error
  if (error !== null && typeof error === 'object' && error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
    return runError('WF_SCRIPT_ERROR', 'workflow script exceeded the synchronous execution time limit')
  }
  return runError(fallbackCode, errorText(error))
}

/** Clone a JSON cache value so scripts cannot mutate journal or replay state. */
function cloneJsonValue(value) {
  if (value === null || typeof value !== 'object') return value
  if (typeof structuredClone === 'function') return structuredClone(value)
  return JSON.parse(JSON.stringify(value))
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function sortJson(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((entry) => sortJson(entry))
  const sorted = {}
  for (const key of Object.keys(value).sort()) {
    Object.defineProperty(sorted, key, {
      value: sortJson(value[key]),
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  return sorted
}

/**
 * Stable canonical JSON: object keys sorted recursively, arrays preserved.
 * Used for cache call keys, so a semantically identical call hashes identically.
 *
 * @param {unknown} value JSON-shaped value
 * @returns {string}
 */
export function canonicalJson(value) {
  const text = JSON.stringify(sortJson(value))
  return text === undefined ? 'undefined' : text
}

class JsonCopyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'JsonCopyError'
  }
}

/**
 * The one strict pure-data walk used for every value crossing the script
 * boundary: args, results, report items, artifact table cells, agent options,
 * agent schemas and structured child results all go through
 * {@link materializeJson}. It rejects, rather than silently dropping or
 * invoking, anything `JSON.stringify` would lose or execute:
 *
 * - functions, symbols, bigints, `undefined`, non-finite numbers and `-0`
 * - sparse arrays and array/object properties JSON ignores (symbol keys, extra
 *   array props)
 * - non-plain prototypes (Date, Map, class instances, `Object.create({})`)
 * - circular references
 * - accessor (getter/setter) properties: descriptors are inspected instead of
 *   being invoked, so a hostile getter never runs during validation.
 *
 * It returns a detached host-realm copy of the data.
 */
function copyJsonValue(value, path, ancestors) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') {
    if (!Number.isFinite(value)) throw new JsonCopyError(`${path} contains a non-finite number`)
    if (Object.is(value, -0)) throw new JsonCopyError(`${path} contains negative zero, which JSON cannot round-trip`)
    return value
  }
  if (type !== 'object') throw new JsonCopyError(`${path} contains a ${type} value`)
  if (ancestors.has(value)) throw new JsonCopyError(`${path} contains a circular reference`)
  ancestors.add(value)
  try {
    const symbols = Object.getOwnPropertySymbols(value)
    if (symbols.length > 0) throw new JsonCopyError(`${path} has symbol-keyed properties, which JSON cannot represent`)
    if (Array.isArray(value)) {
      const out = []
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor === undefined) throw new JsonCopyError(`${path}[${index}] is a sparse array hole`)
        if (!Object.hasOwn(descriptor, 'value')) throw new JsonCopyError(`${path}[${index}] is an accessor property, not plain JSON data`)
        out.push(copyJsonValue(descriptor.value, `${path}[${index}]`, ancestors))
      }
      for (const key of Object.keys(value)) {
        if (!/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length) {
          throw new JsonCopyError(`${path}.${key} is an array property JSON ignores`)
        }
      }
      return out
    }
    const prototype = Object.getPrototypeOf(value)
    if (!(prototype === null || Object.getPrototypeOf(prototype) === null)) {
      throw new JsonCopyError(`${path} is not a plain object`)
    }
    const out = {}
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw new JsonCopyError(`${path}.${key} is an accessor property, not plain JSON data`)
      }
      // defineProperty (not assignment) so a legal "__proto__" key stays an
      // ordinary own data property instead of mutating the copy's prototype.
      Object.defineProperty(out, key, {
        value: copyJsonValue(descriptor.value, `${path}.${key}`, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return out
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Copy a value into plain host-realm JSON data, validating it first. `undefined`
 * is not JSON data and is rejected.
 *
 * @param {unknown} value candidate value
 * @param {string} [label] path label used in error messages
 * @param {string} [code] `WorkflowRunError` code for invalid values
 * @returns {unknown} a plain host-realm copy
 */
function materializeJson(value, label = 'value', code = 'WF_ARGUMENT_INVALID') {
  try {
    return copyJsonValue(value, label, new Set())
  } catch (error) {
    if (error instanceof JsonCopyError) throw runError(code, `${label} is not lossless JSON data — ${error.message}`)
    throw error
  }
}

/**
 * Whether a value survives a JSON round trip without loss: plain objects and
 * dense arrays of finite numbers (negative zero rejected), strings, booleans
 * and null; cycles, functions, symbols, bigints, undefined and exotic
 * prototypes are rejected.
 *
 * @param {unknown} value candidate value
 * @returns {boolean}
 */
export function isJsonValue(value) {
  try {
    materializeJson(value)
    return true
  } catch {
    return false
  }
}

/**
 * Stable cache key for one `agent()` call: the SHA-256 hex digest of the
 * canonical JSON of `{ prompt, schema, provider, model, reasoningEffort,
 * maxTokens, preset, cwd }` (undefined fields omitted). Every option that can
 * change the child's work must be part of the key, or resume/amend would replay
 * a different call.
 *
 * @param {{ prompt: string, schema?: unknown, provider?: string, model?: string, reasoningEffort?: string, maxTokens?: number, preset?: string, cwd?: string }} call
 * @returns {string}
 */
export function callKey(call = {}) {
  if (call === null || typeof call !== 'object') throw runError('WF_ARGUMENT_INVALID', 'callKey() requires a call object')
  if (typeof call.prompt !== 'string' || call.prompt.length === 0) throw runError('WF_ARGUMENT_INVALID', 'callKey() requires a non-empty prompt string')
  const input = { prompt: call.prompt }
  if (call.args !== undefined) input.args = call.args
  if (call.sessionId !== undefined) input.sessionId = call.sessionId
  if (call.schema !== undefined) input.schema = call.schema
  if (call.provider !== undefined) input.provider = call.provider
  if (call.model !== undefined) input.model = call.model
  if (call.reasoningEffort !== undefined) input.reasoningEffort = call.reasoningEffort
  if (call.maxTokens !== undefined) input.maxTokens = call.maxTokens
  if (call.preset !== undefined) input.preset = call.preset
  if (call.cwd !== undefined) input.cwd = call.cwd
  return sha256Hex(canonicalJson(input))
}

/** Whether a value is a plain data object (cross-realm plain objects included). */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === null || Object.getPrototypeOf(prototype) === null
  } catch {
    return false
  }
}

function truncateText(text, maxBytes) {
  if (typeof text !== 'string' || text.length === 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  // Cut on a UTF-8 boundary: drop a trailing partial character instead of
  // returning a replacement glyph.
  let end = maxBytes
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return `${buffer.subarray(0, end).toString('utf8')}\n… [truncated]`
}

function defaultLabel(prompt) {
  const firstLine = prompt.split(/\r?\n/, 1)[0] ?? ''
  const collapsed = firstLine.trim().replace(/\s+/g, ' ')
  return collapsed.length <= 48 ? collapsed : `${collapsed.slice(0, 47)}…`
}

/** Reject a git ref/rev that could be parsed as an option or break argv. */
function assertGitRef(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw runError('WF_ARGUMENT_INVALID', `${label} must be a non-empty string`)
  }
  if (value.startsWith('-') || /[\0\r\n\t ]/.test(value)) {
    throw runError('WF_ARGUMENT_INVALID', `${label} is not a valid git ref/rev`)
  }
  return value
}

function validateArtifactName(rawName) {
  if (typeof rawName !== 'string') throw runError('WF_ARGUMENT_INVALID', 'artifact names must be strings')
  const name = rawName.trim()
  if (name.length === 0 || name.length > MAX_ARTIFACT_NAME) {
    throw runError('WF_ARGUMENT_INVALID', `artifact names must be non-empty strings of at most ${MAX_ARTIFACT_NAME} characters`)
  }
  return name
}

function formatTableCell(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

function escapeTableCell(text) {
  return String(text).replaceAll('|', '\\|').replace(/\r?\n/g, ' ')
}

function buildMarkdownTable(columns, rows) {
  const header = `| ${columns.map((column) => escapeTableCell(column)).join(' | ')} |`
  const divider = `| ${columns.map(() => '---').join(' | ')} |`
  const lines = [header, divider]
  for (const row of rows) {
    const cells = []
    for (let index = 0; index < columns.length; index++) {
      cells.push(escapeTableCell(formatTableCell(index < row.length ? row[index] : null)))
    }
    lines.push(`| ${cells.join(' | ')} |`)
  }
  return `${lines.join('\n')}\n`
}

function toPosixPath(value) {
  return sep === '/' ? value : value.split(sep).join('/')
}

function escapeRegexChar(character) {
  return character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function segmentToRegex(segment) {
  let out = ''
  for (const character of segment) {
    if (character === '*') out += '[^/]*'
    else if (character === '?') out += '[^/]'
    else out += escapeRegexChar(character)
  }
  return out
}

/** Translate the supported glob subset (`**`, `*`, `?`) to a RegExp over POSIX paths. */
function globToRegExp(pattern) {
  const segments = pattern.replace(/^\.\//, '').split('/')
  let source = '^'
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]
    const last = index === segments.length - 1
    if (segment === '**') {
      source += last ? '.*' : '(?:[^/]+/)*'
      continue
    }
    source += segmentToRegex(segment)
    if (!last) source += '/'
  }
  return new RegExp(`${source}$`)
}

/** Reject glob patterns that could address anything outside the workspace. */
function assertWorkspacePattern(pattern) {
  const normalised = pattern.replaceAll('\\', '/')
  if (normalised.startsWith('/') || isAbsolute(pattern) || /^[A-Za-z]:/.test(normalised)) {
    throw runError('WF_PATH_OUTSIDE', 'glob patterns must be relative to the workspace')
  }
  if (normalised.split('/').includes('..')) {
    throw runError('WF_PATH_OUTSIDE', 'glob patterns must stay inside the workspace')
  }
}

function readPositiveInteger(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback
}

function readNonNegativeInteger(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback
}

function readPositiveNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function normalizeCommandName(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  // A path-qualified command would let an allowlisted basename execute an
  // arbitrary binary; only bare command names are accepted.
  if (trimmed.length === 0 || /[\\/:]/.test(trimmed)) return ''
  let name = basename(trimmed).toLowerCase()
  for (const suffix of ['.exe', '.cmd', '.bat']) {
    if (name.endsWith(suffix)) {
      name = name.slice(0, -suffix.length)
      break
    }
  }
  return name
}

function normalizeCommandList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const names = []
  for (const entry of value) {
    const name = normalizeCommandName(entry)
    if (name.length > 0 && !names.includes(name)) names.push(name)
  }
  return names
}

/** Read the budget config, filling in every documented default. */
function normalizeLimits(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  return {
    maxConcurrentAgents: readPositiveInteger(source.maxConcurrentAgents, DEFAULT_LIMITS.maxConcurrentAgents),
    maxAgentsPerRun: readPositiveInteger(source.maxAgentsPerRun, DEFAULT_LIMITS.maxAgentsPerRun),
    maxItemsPerCall: readPositiveInteger(source.maxItemsPerCall, DEFAULT_LIMITS.maxItemsPerCall),
    maxRunSeconds: readPositiveNumber(source.maxRunSeconds, DEFAULT_LIMITS.maxRunSeconds),
    maxWorldRuns: readNonNegativeInteger(source.maxWorldRuns, DEFAULT_LIMITS.maxWorldRuns),
    maxReportItems: readPositiveInteger(source.maxReportItems, DEFAULT_LIMITS.maxReportItems),
    // Total narration/storage budgets; all optional and safe by default so a
    // partial runtime config still gets bounded runs.
    maxLogBytes: readPositiveInteger(source.maxLogBytes, readPositiveInteger(source.maxResultChars, DEFAULT_LIMITS.maxLogBytes)),
    maxReportBytes: readPositiveInteger(source.maxReportBytes, DEFAULT_LIMITS.maxReportBytes),
    maxArtifacts: readPositiveInteger(source.maxArtifacts, DEFAULT_LIMITS.maxArtifacts),
    maxArtifactBytes: readPositiveInteger(source.maxArtifactBytes, DEFAULT_LIMITS.maxArtifactBytes),
    maxArtifactTotalBytes: readPositiveInteger(source.maxArtifactTotalBytes, DEFAULT_LIMITS.maxArtifactTotalBytes),
    syncTimeoutMs: readPositiveInteger(source.syncTimeoutMs, DEFAULT_LIMITS.syncTimeoutMs),
    // Effective child defaults are part of the replay key: changing a host
    // default model/preset must not replay an answer produced by the old one.
    defaultProvider: typeof source.defaultProvider === 'string' ? source.defaultProvider : '',
    defaultModel: typeof source.defaultModel === 'string' ? source.defaultModel : '',
    childPreset: typeof source.childPreset === 'string' ? source.childPreset : '',
    allowedCommands: normalizeCommandList(source.allowedCommands, DEFAULT_ALLOWED_COMMANDS),
    blockedCommands: normalizeCommandList(source.blockedCommands, []),
  }
}

/* ------------------------------------------------------------------ */
/* JSON-schema subset (object-rooted, same subset as the shipped tool) */
/* ------------------------------------------------------------------ */

function scalarMatchesType(type, value) {
  switch (type) {
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)
    case 'integer': return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && !Object.is(value, -0)
    case 'boolean': return typeof value === 'boolean'
    case 'null': return value === null
    default: return false
  }
}

function walkSchema(node, path, violations, ancestors) {
  if (!isPlainObject(node)) {
    violations.push(`${path} must be a schema object`)
    return
  }
  if (ancestors.has(node)) {
    violations.push(`${path} is circular`)
    return
  }
  ancestors.add(node)
  try {
    for (const key of Object.keys(node)) {
      if (!SCHEMA_CONSTRAINT_KEYS.has(key) && !SCHEMA_ANNOTATION_KEYS.has(key)) {
        violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const)`)
      }
    }
    for (const key of ['description', 'title']) {
      if (Object.hasOwn(node, key) && typeof node[key] !== 'string') violations.push(`${path}.${key} must be a string`)
    }
    const hasType = Object.hasOwn(node, 'type')
    const hasOneOf = Object.hasOwn(node, 'oneOf')
    if (hasType && hasOneOf) {
      violations.push(`${path} cannot declare both type and oneOf`)
      return
    }
    if (!hasType && !hasOneOf) {
      violations.push(`${path} must declare type or oneOf`)
      return
    }
    if (hasOneOf) {
      for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported beside oneOf`)
      }
      const oneOf = node.oneOf
      if (!Array.isArray(oneOf) || oneOf.length < 2) {
        violations.push(`${path}.oneOf must be an array of at least two schemas`)
      } else {
        for (const [index, branch] of oneOf.entries()) walkSchema(branch, `${path}.oneOf[${index}]`, violations, ancestors)
      }
      return
    }
    const type = node.type
    if (typeof type !== 'string' || !SCHEMA_TYPES.includes(type)) {
      violations.push(`${path}.type must be one of ${SCHEMA_TYPES.join('/')}`)
      return
    }
    if (type === 'object') {
      const properties = node.properties
      if (Object.hasOwn(node, 'properties')) {
        if (!isPlainObject(properties)) {
          violations.push(`${path}.properties must be an object of schemas`)
        } else {
          for (const key of Object.keys(properties)) walkSchema(properties[key], `${path}.properties.${key}`, violations, ancestors)
        }
      }
      if (Object.hasOwn(node, 'required')) {
        const required = node.required
        if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
          violations.push(`${path}.required must be an array of strings`)
        } else {
          const declared = isPlainObject(properties) ? properties : {}
          for (const key of required) {
            if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not declared in properties`)
          }
        }
      }
      if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
        violations.push(`${path}.additionalProperties must be a boolean`)
      }
      if (Object.hasOwn(node, 'items')) violations.push(`${path}.items is only supported on type "array"`)
      return
    }
    if (type === 'array') {
      for (const key of ['properties', 'required', 'additionalProperties', 'enum', 'const']) {
        if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported on type "array"`)
      }
      if (Object.hasOwn(node, 'items')) walkSchema(node.items, `${path}.items`, violations, ancestors)
      return
    }
    for (const key of ['properties', 'required', 'additionalProperties', 'items']) {
      if (Object.hasOwn(node, key)) violations.push(`${path}.${key} is not supported on type "${type}"`)
    }
    if (Object.hasOwn(node, 'enum')) {
      const allowed = node.enum
      if (!Array.isArray(allowed) || allowed.length === 0 || allowed.some((entry) => !scalarMatchesType(type, entry))) {
        violations.push(`${path}.enum must be a non-empty array of ${type} values`)
      }
    }
    if (Object.hasOwn(node, 'const')) {
      const constant = node.const
      if (!scalarMatchesType(type, constant)) {
        violations.push(`${path}.const must be a ${type} value`)
      } else if (Array.isArray(node.enum) && !node.enum.includes(constant)) {
        violations.push(`${path}.const must be one of ${path}.enum when both are declared`)
      }
    }
  } finally {
    ancestors.delete(node)
  }
}

/**
 * Validate the workflow structured-output schema subset and its object root.
 *
 * @param {unknown} schema caller-supplied schema
 * @returns {string[]} violations (empty when valid)
 */
function schemaViolations(schema) {
  const violations = []
  walkSchema(schema, 'schema', violations, new Set())
  if (violations.length === 0 && (!isPlainObject(schema) || schema.type !== 'object')) {
    violations.push('schema.type must be "object" (structured output is object-rooted)')
  }
  return violations
}

/** Validate one JSON value against the supported schema subset (used for child results). */
function matchesSchema(schema, value) {
  if (schema === null || typeof schema !== 'object') return false
  if (Array.isArray(schema.oneOf)) {
    let matched = 0
    for (const branch of schema.oneOf) if (matchesSchema(branch, value)) matched += 1
    return matched === 1
  }
  const type = schema.type
  if (type === 'object') {
    if (!isPlainObject(value)) return false
    const properties = isPlainObject(schema.properties) ? schema.properties : {}
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) if (!Object.hasOwn(value, key)) return false
    }
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!matchesSchema(properties[key], value[key])) return false
      } else if (schema.additionalProperties === false) {
        return false
      }
    }
    return true
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return false
    if (schema.items !== undefined) {
      for (const entry of value) if (!matchesSchema(schema.items, entry)) return false
    }
    return true
  }
  if (!scalarMatchesType(type, value)) return false
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) return false
  return true
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

class WorkflowExecution {
  constructor(options) {
    this.meta = options.meta
    this.body = options.body
    this.args = options.args
    this.runId = options.runId
    this.services = options.services
    this.limits = options.limits
    this.signal = options.signal
    this.onEvent = options.onEvent
    this.onAgentCall = options.onAgentCall
    this.onObservation = options.onObservation
    this.cache = options.cache
    this.cachePolicy = options.cachePolicy
    this.agentCache = this.cache !== null && this.cache.agents instanceof Map ? this.cache.agents : null
    this.observationCache = this.cache !== null && this.cache.observations instanceof Map ? this.cache.observations : null
    this.initialAgentKeys = new Set(this.agentCache === null ? [] : this.agentCache.keys())
    this.initialObservationKeys = new Set(this.observationCache === null ? [] : this.observationCache.keys())
    this.agentCacheOrder = this.cache !== null && Array.isArray(this.cache.agentOrder) ? this.cache.agentOrder : null
    this.observationCacheOrder = this.cache !== null && Array.isArray(this.cache.observationOrder) ? this.cache.observationOrder : null
    this.agentCacheCursor = 0
    this.observationCacheCursor = 0
    this.cacheReuse = this.cachePolicy === 'resume' || this.cachePolicy === 'amend'
    this.cacheDirtyReported = false
    this.cancelled = false
    this.settled = false
    this.stopError = null
    this.abort = new AbortController()
    this.timer = null
    this.abortListener = null
    this.startedAt = Date.now()
    this.agentCalls = 0
    this.agentsStarted = 0
    this.worldRuns = 0
    this.observationSeq = 0
    this.activeAgents = 0
    this.slotWaiters = []
    this.currentPhase = undefined
    this.phaseCount = 0
    this.reports = []
    this.artifacts = []
    this.reportBytes = 0
    this.artifactBytes = 0
    this.logBytes = 0
    this.callbackChain = Promise.resolve()
    this.context = null
    this.resolveTerminal = null
    this.terminal = new Promise((resolve) => {
      this.resolveTerminal = resolve
    })
  }

  /* -- lifecycle -------------------------------------------------- */

  start() {
    if (this.signal !== null) {
      if (this.signal.aborted === true) {
        this.cancelRun('cancelled', 'workflow run was cancelled before it started')
        return
      }
      this.abortListener = () => this.cancelRun('cancelled', 'workflow run was cancelled by its parent')
      try {
        this.signal.addEventListener('abort', this.abortListener, { once: true })
      } catch {
        this.abortListener = null
      }
    }
    const timerMs = this.limits.maxRunSeconds * 1000
    if (Number.isFinite(timerMs) && timerMs > 0 && timerMs <= 2147483647) {
      this.timer = setTimeout(() => this.cancelRun('timeout'), timerMs)
    }
  }

  /**
   * Release every run-scoped resource: timer, parent-signal listener and the
   * internal abort signal. Aborting on settle (not only on cancellation) kills
   * work a script started but never awaited, so no child activation or shell
   * outlives the settled run; queued slot waiters are rejected so no further
   * child can start after settlement.
   */
  settle() {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.signal !== null && this.abortListener !== null) {
      try {
        this.signal.removeEventListener('abort', this.abortListener)
      } catch {
        // The signal may already be gone; nothing left to detach.
      }
      this.abortListener = null
    }
    if (this.settled) return
    this.settled = true
    try {
      this.abort.abort()
    } catch {
      // AbortController.abort() does not throw in practice; never fail a run over it.
    }
    for (const waiter of this.slotWaiters.splice(0)) {
      waiter.reject(runError('WF_CANCELLED', 'workflow run has already settled'))
    }
  }

  cancelRun(kind, message) {
    if (this.settled || this.cancelled) return
    this.cancelled = true
    if (kind === 'timeout') {
      this.stopError = runError('WF_BUDGET_EXCEEDED', `this workflow exceeded its wall-clock cap (maxRunSeconds: ${this.limits.maxRunSeconds})`)
    } else {
      this.stopError = runError('WF_CANCELLED', message ?? 'workflow run was cancelled')
    }
    try {
      this.abort.abort()
    } catch {
      // AbortController.abort() does not throw in practice; never fail a run over it.
    }
    for (const waiter of this.slotWaiters.splice(0)) {
      waiter.reject(runError('WF_CANCELLED', 'workflow run was cancelled'))
    }
    if (this.resolveTerminal !== null) {
      this.resolveTerminal({ kind: 'terminal', stopReason: kind === 'timeout' ? 'error' : 'cancelled', error: this.stopError })
    }
  }

  throwIfStopped() {
    if (this.cancelled) throw this.stopError ?? runError('WF_CANCELLED', 'workflow run was cancelled')
    if (this.settled) throw runError('WF_CANCELLED', 'workflow run has already settled')
  }

  warn(message) {
    try {
      if (this.services.logger !== null && typeof this.services.logger?.warn === 'function') this.services.logger.warn(message)
    } catch {
      // Logging must never fail a run.
    }
  }

  /* -- journal callbacks ----------------------------------------- */

  enqueue(task) {
    const run = this.callbackChain.then(() => task())
    this.callbackChain = run.catch((error) => {
      this.warn(`workflow journal callback failed: ${errorText(error)}`)
    })
    return this.callbackChain
  }

  async flush() {
    try {
      await this.callbackChain
    } catch {
      // enqueue() already contains failures.
    }
  }

  emit(event) {
    const callback = this.onEvent
    if (callback === null) return Promise.resolve()
    return this.enqueue(() => callback(event))
  }

  journalAgent(record) {
    const callback = this.onAgentCall
    if (callback === null) return Promise.resolve()
    return this.enqueue(() => callback(record))
  }

  journalObservation(record) {
    const callback = this.onObservation
    if (callback === null) return Promise.resolve()
    return this.enqueue(() => callback(record))
  }

  /* -- cache ------------------------------------------------------ */

  lookupCache(map, initialKeys, key, kind = 'agents') {
    if (!this.cacheReuse || map === null) return { hit: false }
    const order = kind === 'agents' ? this.agentCacheOrder : this.observationCacheOrder
    if (order !== null) {
      // Replay in call order: a reordered or changed call stops reuse instead
      // of matching a key that happens to exist later in the journal.
      const cursorName = kind === 'agents' ? 'agentCacheCursor' : 'observationCacheCursor'
      const expected = order[this[cursorName]]
      if (expected !== key) {
        this.cacheReuse = false
        return { hit: false }
      }
      this[cursorName] += 1
      if (!map.has(key)) return { hit: false }
      return { hit: true, value: map.get(key) }
    }
    if (!initialKeys.has(key)) {
      if (this.cachePolicy !== 'none') this.cacheReuse = false
      return { hit: false }
    }
    return { hit: true, value: map.get(key) }
  }

  recordAgentCache(key, options, entry) {
    if (options.cache === false || this.agentCache === null) return
    this.agentCache.set(key, cloneJsonValue(entry))
  }

  markCacheDirty() {
    const wasReusing = this.cacheReuse
    this.cacheReuse = false
    if (!wasReusing || this.cacheDirtyReported) return
    this.cacheDirtyReported = true
    const message = 'cache reuse disabled: a live world.run command ran, so later cached entries cannot be trusted'
    this.warn(message)
    try {
      this.log(message)
    } catch {
      // Losing one narration line never fails the run.
    }
  }

  /* -- capabilities ---------------------------------------------- */

  requireCapability(capability, hook) {
    const capabilities = Array.isArray(this.meta?.capabilities) ? this.meta.capabilities : []
    if (!capabilities.includes(capability)) {
      throw runError('WF_CAPABILITY_DENIED', `${hook} requires the "${capability}" capability; this workflow declares: ${capabilities.join(', ') || 'none'}`)
    }
  }

  /* -- agent / combinators --------------------------------------- */

  contain(promise) {
    promise.catch(() => {})
    return promise
  }

  assertItemCap(length, hook) {
    if (length > this.limits.maxItemsPerCall) {
      throw runError('WF_LIMIT', `${hook} received ${length} items — over the per-call cap (maxItemsPerCall: ${this.limits.maxItemsPerCall})`)
    }
  }

  readAgentOptions(rawOptions) {
    if (rawOptions === undefined || rawOptions === null) return {}
    const options = materializeJson(rawOptions, 'agent() options')
    if (!isPlainObject(options)) throw runError('WF_ARGUMENT_INVALID', 'agent() options must be an object')
    for (const key of Object.keys(options)) {
      if (!AGENT_OPTION_KEYS.has(key)) {
        throw runError('WF_ARGUMENT_INVALID', `agent() option "${key}" is not supported (supported: ${AGENT_OPTION_NAMES.join(', ')})`)
      }
    }
    const readString = (key, max) => {
      const value = options[key]
      if (value === undefined) return undefined
      if (typeof value !== 'string' || value.trim().length === 0) throw runError('WF_ARGUMENT_INVALID', `agent() option "${key}" must be a non-empty string`)
      if (max !== undefined && value.length > max) throw runError('WF_ARGUMENT_INVALID', `agent() option "${key}" is longer than ${max} characters`)
      return value
    }
    const normalised = {}
    for (const key of ['label', 'phase', 'provider', 'model', 'preset', 'cwd']) {
      const value = readString(key, key === 'phase' ? 120 : key === 'label' ? 200 : undefined)
      if (value !== undefined) normalised[key] = value
    }
    const reasoningEffort = readString('reasoningEffort')
    if (reasoningEffort !== undefined) normalised.reasoningEffort = reasoningEffort
    if (options.maxTokens !== undefined) {
      if (typeof options.maxTokens !== 'number' || !Number.isFinite(options.maxTokens) || !Number.isInteger(options.maxTokens) || options.maxTokens < 1) {
        throw runError('WF_ARGUMENT_INVALID', 'agent() option "maxTokens" must be a positive integer')
      }
      normalised.maxTokens = options.maxTokens
    }
    if (options.cache !== undefined) {
      if (typeof options.cache !== 'boolean') throw runError('WF_ARGUMENT_INVALID', 'agent() option "cache" must be a boolean')
      normalised.cache = options.cache
    }
    if (options.schema !== undefined) {
      const schema = materializeJson(options.schema, 'agent() schema')
      const violations = schemaViolations(schema)
      if (violations.length > 0) {
        throw runError('WF_SCHEMA_INVALID', `agent() schema is outside the supported object-rooted subset — ${violations.join('; ')}`)
      }
      normalised.schema = schema
    }
    return normalised
  }

  acquireSlot() {
    this.throwIfStopped()
    if (this.activeAgents < this.limits.maxConcurrentAgents) {
      this.activeAgents += 1
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      this.slotWaiters.push({ resolve, reject })
    })
  }

  releaseSlot() {
    const next = this.slotWaiters.shift()
    if (next !== undefined) next.resolve()
    else this.activeAgents = Math.max(0, this.activeAgents - 1)
  }

  async agent(rawPrompt, rawOptions) {
    this.throwIfStopped()
    if (typeof rawPrompt !== 'string' || rawPrompt.length === 0) {
      throw runError('WF_ARGUMENT_INVALID', 'agent() requires a non-empty prompt string')
    }
    const options = this.readAgentOptions(rawOptions)
    if (this.agentCalls >= this.limits.maxAgentsPerRun) {
      throw runError('WF_BUDGET_EXCEEDED', `this run reached its agent cap (maxAgentsPerRun: ${this.limits.maxAgentsPerRun})`)
    }
    this.agentCalls += 1
    const seq = this.agentCalls
    const effectiveProvider = options.provider ?? (this.limits.defaultProvider || undefined)
    const effectiveModel = options.model ?? (this.limits.defaultModel || undefined)
    const effectivePreset = options.preset ?? (this.limits.childPreset || undefined)
    const key = callKey({
      prompt: rawPrompt,
      args: this.args,
      sessionId: this.services.sessionId,
      schema: options.schema,
      provider: effectiveProvider,
      model: effectiveModel,
      reasoningEffort: options.reasoningEffort,
      maxTokens: options.maxTokens,
      preset: effectivePreset,
      cwd: options.cwd ?? this.services.workspaceRoot,
    })
    const label = options.label ?? defaultLabel(rawPrompt)
    const phase = options.phase
    const recordBase = {
      seq,
      key,
      label,
      provider: options.provider,
      model: options.model,
      preset: options.preset,
      cwd: options.cwd,
    }

    const cached = options.cache === false
      ? { hit: false }
      : this.lookupCache(this.agentCache, this.initialAgentKeys, key, 'agents')
    const cachedSchemaOk = cached.hit && (options.schema === undefined
      || matchesSchema(options.schema, cached.value?.structured))
    if (cached.hit && cachedSchemaOk) {
      const entry = cloneJsonValue(cached.value !== null && typeof cached.value === 'object' ? cached.value : {})
      const status = entry.stopReason === 'completed' ? 'completed' : 'failed'
      await this.emit({ type: 'agent-start', seq, key, label })
      await this.emit({
        type: 'agent-end',
        seq,
        key,
        label,
        status,
        cached: true,
        ...(typeof entry.childId === 'string' ? { childId: entry.childId } : {}),
      })
      await this.journalAgent({
        ...recordBase,
        status,
        ...(typeof entry.text === 'string' ? { outputText: entry.text } : {}),
        ...(entry.structured === undefined ? {} : { structured: entry.structured }),
        ...(typeof entry.childId === 'string' ? { childId: entry.childId } : {}),
        startedAt: Date.now(),
        endedAt: Date.now(),
        cached: true,
      })
      if (entry.stopReason !== 'completed') return null
      if (options.schema !== undefined) return entry.structured === undefined ? null : entry.structured
      return typeof entry.text === 'string' ? entry.text : ''
    }

    await this.acquireSlot()
    try {
      this.throwIfStopped()
      await this.emit({ type: 'agent-start', seq, key, label })
      const startedAt = Date.now()
      let result
      try {
        result = await this.services.startAgent({
          prompt: rawPrompt,
          label,
          signal: this.abort.signal,
          ...(options.schema === undefined ? {} : { schema: options.schema }),
          ...(options.provider === undefined ? {} : { provider: options.provider }),
          ...(options.model === undefined ? {} : { model: options.model }),
          ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort }),
          ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
          ...(options.preset === undefined ? {} : { preset: options.preset }),
          ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
          ...(phase === undefined ? {} : { phase }),
        })
      } catch (error) {
        if (isFatalWorkflowError(error)) throw error
        const endedAt = Date.now()
        if (this.settled || this.cancelled) return null
        await this.emit({ type: 'agent-end', seq, key, label, status: 'failed', cached: false })
        await this.journalAgent({ ...recordBase, status: 'failed', startedAt, endedAt, cached: false, error: errorText(error) })
        this.warn(`agent() could not start a child: ${errorText(error)}`)
        return null
      }
      // The run may have settled while this (possibly un-awaited) child call was
      // in flight; cancellation aborts the child, and a settled run must not
      // journal, cache or observe anything afterwards.
      if (this.cancelled || this.settled) return null
      const endedAt = Date.now()
      const childId = result !== null && typeof result === 'object' && typeof result.childId === 'string' ? result.childId : undefined
      if (result === null || typeof result !== 'object' || result.stopReason !== 'completed') {
        const status = result !== null && typeof result === 'object' && result.stopReason === 'cancelled' ? 'cancelled' : 'failed'
        const text = result !== null && typeof result === 'object' && typeof result.text === 'string' ? result.text : undefined
        this.recordAgentCache(key, options, { stopReason: status, ...(text === undefined ? {} : { text }) })
        await this.emit({ type: 'agent-end', seq, key, label, status, cached: false, ...(childId === undefined ? {} : { childId }) })
        await this.journalAgent({ ...recordBase, status, startedAt, endedAt, cached: false, ...(childId === undefined ? {} : { childId }) })
        return null
      }
      this.agentsStarted += 1
      if (options.schema !== undefined) {
        let structured
        try {
          structured = materializeJson(result.structured, 'the child structured result')
        } catch {
          structured = undefined
        }
        if (structured === undefined || !matchesSchema(options.schema, structured)) {
          await this.emit({ type: 'agent-end', seq, key, label, status: 'failed', cached: false, ...(childId === undefined ? {} : { childId }) })
          await this.journalAgent({ ...recordBase, status: 'failed', startedAt, endedAt, cached: false, ...(childId === undefined ? {} : { childId }) })
          this.warn('agent() child returned a structured result that does not match its schema; treating the call as a child failure')
          return null
        }
        this.recordAgentCache(key, options, { stopReason: 'completed', structured })
        await this.emit({ type: 'agent-end', seq, key, label, status: 'completed', cached: false, ...(childId === undefined ? {} : { childId }) })
        await this.journalAgent({
          ...recordBase,
          status: 'completed',
          structured: cloneJsonValue(structured),
          startedAt,
          endedAt,
          cached: false,
          ...(childId === undefined ? {} : { childId }),
        })
        return cloneJsonValue(structured)
      }
      const outputText = typeof result.text === 'string' ? result.text : ''
      this.recordAgentCache(key, options, { stopReason: 'completed', text: outputText })
      await this.emit({ type: 'agent-end', seq, key, label, status: 'completed', cached: false, ...(childId === undefined ? {} : { childId }) })
      await this.journalAgent({
        ...recordBase,
        status: 'completed',
        outputText,
        startedAt,
        endedAt,
        cached: false,
        ...(childId === undefined ? {} : { childId }),
      })
      return outputText
    } finally {
      this.releaseSlot()
    }
  }

  async parallel(rawThunks) {
    this.throwIfStopped()
    if (!Array.isArray(rawThunks)) throw runError('WF_ARGUMENT_INVALID', 'parallel() requires an array of zero-argument functions')
    this.assertItemCap(rawThunks.length, 'parallel()')
    const thunks = rawThunks.map((thunk, index) => {
      if (typeof thunk !== 'function') throw runError('WF_ARGUMENT_INVALID', `parallel() item ${index} is not a function`)
      return thunk
    })
    return Promise.all(thunks.map(async (thunk) => {
      try {
        return await thunk()
      } catch (error) {
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  async pipeline(rawItems, rawStages) {
    this.throwIfStopped()
    if (!Array.isArray(rawItems)) throw runError('WF_ARGUMENT_INVALID', 'pipeline() requires an items array')
    this.assertItemCap(rawItems.length, 'pipeline()')
    if (!Array.isArray(rawStages) || rawStages.length === 0) throw runError('WF_ARGUMENT_INVALID', 'pipeline() requires at least one stage function')
    const stages = rawStages.map((stage, index) => {
      if (typeof stage !== 'function') throw runError('WF_ARGUMENT_INVALID', `pipeline() stage ${index} is not a function`)
      return stage
    })
    return Promise.all(rawItems.map(async (item, index) => {
      let value = item
      try {
        for (const stage of stages) value = await stage(value, item, index)
        return value
      } catch (error) {
        if (isFatalWorkflowError(error)) throw error
        return null
      }
    }))
  }

  /* -- phase / log / report -------------------------------------- */

  phase(rawTitle) {
    this.throwIfStopped()
    if (typeof rawTitle !== 'string' || rawTitle.trim().length === 0) throw runError('WF_ARGUMENT_INVALID', 'phase() requires a non-empty title string')
    const title = rawTitle.trim()
    if (title.length > 120) throw runError('WF_ARGUMENT_INVALID', 'phase() titles are limited to 120 characters')
    this.phaseCount += 1
    if (this.phaseCount > MAX_PHASES) throw runError('WF_LIMIT', `this run exceeded its phase cap (${MAX_PHASES})`)
    this.currentPhase = title
    const at = Date.now()
    this.enqueue(() => this.onEvent?.({ type: 'phase', title, at }))
  }

  log(rawMessage) {
    this.throwIfStopped()
    if (typeof rawMessage !== 'string') throw runError('WF_ARGUMENT_INVALID', 'log() requires a message string')
    if (rawMessage.length > MAX_LOG_CHARS) throw runError('WF_LIMIT', `log() messages are limited to ${MAX_LOG_CHARS} characters`)
    const bytes = Buffer.byteLength(rawMessage, 'utf8')
    if (this.logBytes + bytes > this.limits.maxLogBytes) {
      throw runError('WF_LIMIT', `run log narration exceeded its total budget (maxLogBytes: ${this.limits.maxLogBytes})`)
    }
    this.logBytes += bytes
    const at = Date.now()
    this.enqueue(() => this.onEvent?.({ type: 'log', message: rawMessage, at }))
  }

  report(rawItem, rawTag) {
    this.throwIfStopped()
    const item = materializeJson(rawItem, 'report() item')
    let tag
    if (rawTag !== undefined) {
      if (typeof rawTag !== 'string' || rawTag.trim().length === 0 || rawTag.length > 120) {
        throw runError('WF_ARGUMENT_INVALID', 'report() tag must be a non-empty string of at most 120 characters')
      }
      tag = rawTag.trim()
    }
    if (this.reports.length >= this.limits.maxReportItems) {
      throw runError('WF_LIMIT', `this run reached its report cap (maxReportItems: ${this.limits.maxReportItems})`)
    }
    const byteSize = Buffer.byteLength(JSON.stringify(item), 'utf8')
    if (byteSize > MAX_REPORT_ITEM_BYTES) {
      throw runError('WF_LIMIT', `report() items are limited to ${MAX_REPORT_ITEM_BYTES} serialized bytes`)
    }
    if (this.reportBytes + byteSize > this.limits.maxReportBytes) {
      throw runError('WF_LIMIT', `reports exceeded the run report budget (maxReportBytes: ${this.limits.maxReportBytes})`)
    }
    this.reportBytes += byteSize
    const seq = this.reports.length + 1
    const at = Date.now()
    this.reports.push({ item, tag, seq, at })
    this.enqueue(() => this.onEvent?.({ type: 'report', item, ...(tag === undefined ? {} : { tag }), seq, at }))
  }

  /* -- artifacts -------------------------------------------------- */

  pushArtifact(name, kind, content) {
    this.throwIfStopped()
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > this.limits.maxArtifactBytes) {
      throw runError('WF_LIMIT', `artifact content is limited to ${this.limits.maxArtifactBytes} bytes`)
    }
    if (this.artifacts.length >= this.limits.maxArtifacts) {
      throw runError('WF_LIMIT', `this run reached its artifact cap (maxArtifacts: ${this.limits.maxArtifacts})`)
    }
    if (this.artifactBytes + bytes > this.limits.maxArtifactTotalBytes) {
      throw runError('WF_LIMIT', `artifacts exceeded the run artifact budget (maxArtifactTotalBytes: ${this.limits.maxArtifactTotalBytes})`)
    }
    this.artifactBytes += bytes
    const seq = this.artifacts.length + 1
    const at = Date.now()
    this.artifacts.push({ name, kind, content, seq, at })
    this.enqueue(() => this.onEvent?.({ type: 'artifact', name, kind, content, seq, at }))
    return { id: `pending-${seq}`, path: '' }
  }

  artifactMarkdown(rawName, rawContent) {
    this.throwIfStopped()
    const name = validateArtifactName(rawName)
    if (typeof rawContent !== 'string') throw runError('WF_ARGUMENT_INVALID', 'artifact.markdown() content must be a string')
    return this.pushArtifact(name, 'markdown', rawContent)
  }

  artifactTable(rawName, rawColumns, rawRows) {
    this.throwIfStopped()
    const name = validateArtifactName(rawName)
    const columns = materializeJson(rawColumns, 'artifact.table() columns')
    if (!Array.isArray(columns) || columns.length === 0 || columns.length > MAX_TABLE_COLUMNS) {
      throw runError('WF_ARGUMENT_INVALID', `artifact.table() columns must be an array of 1-${MAX_TABLE_COLUMNS} column names`)
    }
    const normalisedColumns = columns.map((column, index) => {
      if (typeof column !== 'string' || column.trim().length === 0) {
        throw runError('WF_ARGUMENT_INVALID', `artifact.table() column ${index} must be a non-empty string`)
      }
      return column.trim()
    })
    const rows = materializeJson(rawRows, 'artifact.table() rows')
    if (!Array.isArray(rows)) throw runError('WF_ARGUMENT_INVALID', 'artifact.table() rows must be an array of cell arrays')
    for (const [index, row] of rows.entries()) {
      if (!Array.isArray(row)) throw runError('WF_ARGUMENT_INVALID', `artifact.table() row ${index} must be an array`)
      if (row.length > normalisedColumns.length) {
        throw runError('WF_ARGUMENT_INVALID', `artifact.table() row ${index} has more cells than columns`)
      }
    }
    return this.pushArtifact(name, 'table', buildMarkdownTable(normalisedColumns, rows))
  }

  async artifactFile(rawName, rawPath) {
    this.requireCapability('observe', 'artifact.file()')
    this.throwIfStopped()
    const name = validateArtifactName(rawName)
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) throw runError('WF_ARGUMENT_INVALID', 'artifact.file() requires a workspace path string')
    const resolved = await this.services.resolvePath(rawPath)
    const fileStat = await this.statSafe(resolved)
    if (fileStat !== undefined && fileStat !== null) {
      if (fileStat.type !== 'file') throw runError('WF_ARGUMENT_INVALID', `artifact.file() target is not a regular file: ${rawPath}`)
      if (typeof fileStat.size === 'number' && fileStat.size > MAX_FILE_BYTES) {
        throw runError('WF_LIMIT', `artifact.file() target is larger than ${MAX_FILE_BYTES} bytes: ${rawPath}`)
      }
    }
    const content = await this.readText(resolved, rawPath)
    return this.pushArtifact(name, 'file', content)
  }

  /* -- file / git observation helpers ----------------------------- */

  async statSafe(resolvedPath) {
    try {
      const value = await this.services.statFile(resolvedPath)
      return value === undefined ? undefined : value
    } catch (error) {
      throw toWorkflowRunError(error)
    }
  }

  async readText(resolvedPath, label) {
    let text
    try {
      text = await this.services.readTextFile(resolvedPath, { maxBytes: MAX_FILE_BYTES })
    } catch (error) {
      throw toWorkflowRunError(error, 'WF_SCRIPT_ERROR')
    }
    if (typeof text !== 'string') throw runError('WF_SCRIPT_ERROR', `readTextFile returned a non-string value for ${label}`)
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) {
      throw runError('WF_LIMIT', `file is larger than ${MAX_FILE_BYTES} bytes: ${label}`)
    }
    return text
  }

  async observe(kind, params, compute) {
    this.throwIfStopped()
    const key = sha256Hex(canonicalJson({ kind, params }))
    const cached = this.lookupCache(this.observationCache, this.initialObservationKeys, key, 'observations')
    if (cached.hit) {
      const value = cloneJsonValue(cached.value)
      this.observationSeq += 1
      const seq = this.observationSeq
      await this.journalObservation({ seq, kind, key, value: cloneJsonValue(value), at: Date.now() })
      return value
    }
    const value = await compute()
    this.throwIfStopped()
    const safeValue = cloneJsonValue(value)
    this.observationSeq += 1
    const seq = this.observationSeq
    await this.journalObservation({ seq, kind, key, value: cloneJsonValue(safeValue), at: Date.now() })
    if (this.observationCache !== null) this.observationCache.set(key, cloneJsonValue(safeValue))
    return cloneJsonValue(safeValue)
  }

  async listDirectory(directory) {
    let entries
    try {
      entries = await this.services.listDir(directory)
    } catch (error) {
      throw toWorkflowRunError(error, 'WF_SCRIPT_ERROR')
    }
    if (!Array.isArray(entries)) throw runError('WF_SCRIPT_ERROR', 'listDir returned a non-array value')
    return entries
  }

  async globWorkspace(searchRoot, pattern) {
    const matcher = globToRegExp(pattern)
    const results = []
    const stack = [searchRoot]
    const seenDirectories = new Set()
    let visited = 0
    while (stack.length > 0) {
      const directory = stack.pop()
      // Resolve the canonical directory identity so symlink cycles cannot
      // re-traverse the same tree until the entry cap.
      let canonical = directory
      try {
        canonical = await this.services.resolvePath(directory)
      } catch (error) {
        const mapped = toWorkflowRunError(error, 'WF_SCRIPT_ERROR')
        // A symlink pointing outside the workspace is skipped rather than
        // aborting the whole glob.
        if (mapped.code === 'WF_PATH_OUTSIDE') continue
      }
      if (seenDirectories.has(canonical)) continue
      seenDirectories.add(canonical)
      const entries = await this.listDirectory(directory)
      for (const entry of entries) {
        const name = entry !== null && typeof entry === 'object' ? entry.name : undefined
        if (typeof name !== 'string' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) continue
        if (name === '.git') continue
        const fullPath = join(directory, name)
        let type = entry.type
        if (type !== 'file' && type !== 'directory' && type !== 'other') {
          const fileStat = await this.statSafe(fullPath)
          type = fileStat !== undefined && fileStat !== null ? fileStat.type : 'other'
        }
        if (type === 'directory') {
          visited += 1
          if (visited > MAX_GLOB_ENTRIES) throw runError('WF_LIMIT', `files.glob() walked more than ${MAX_GLOB_ENTRIES} workspace entries`)
          stack.push(fullPath)
          continue
        }
        if (type !== 'file') continue
        const workspaceRelative = toPosixPath(relative(this.services.workspaceRoot, fullPath))
        if (!matcher.test(workspaceRelative)) continue
        results.push(workspaceRelative)
        if (results.length > MAX_GLOB_PATHS) {
          throw runError('WF_LIMIT', `files.glob() matched more than ${MAX_GLOB_PATHS} paths; refine the pattern`)
        }
      }
    }
    results.sort((left, right) => left.localeCompare(right))
    return results
  }

  async filesGlob(rawPattern, rawOptions) {
    this.requireCapability('observe', 'files.glob()')
    this.throwIfStopped()
    if (typeof rawPattern !== 'string' || rawPattern.trim().length === 0) throw runError('WF_ARGUMENT_INVALID', 'files.glob() requires a non-empty pattern string')
    let options = {}
    if (rawOptions !== undefined && rawOptions !== null) {
      options = materializeJson(rawOptions, 'files.glob() options')
      if (!isPlainObject(options)) throw runError('WF_ARGUMENT_INVALID', 'files.glob() options must be an object')
      for (const key of Object.keys(options)) {
        if (key !== 'cwd') throw runError('WF_ARGUMENT_INVALID', `files.glob() option "${key}" is not supported (supported: cwd)`)
      }
    }
    const pattern = rawPattern.replaceAll('\\', '/')
    assertWorkspacePattern(pattern)
    const cwd = options.cwd
    if (cwd !== undefined && (typeof cwd !== 'string' || cwd.trim().length === 0)) throw runError('WF_ARGUMENT_INVALID', 'files.glob() cwd must be a non-empty string')
    const params = { pattern: rawPattern, ...(cwd === undefined ? {} : { cwd }) }
    return this.observe('files.glob', params, async () => {
      const searchRoot = cwd === undefined ? this.services.workspaceRoot : await this.services.resolvePath(cwd)
      return this.globWorkspace(searchRoot, pattern)
    })
  }

  async filesRead(rawPath, rawOptions) {
    this.requireCapability('observe', 'files.read()')
    this.throwIfStopped()
    if (typeof rawPath !== 'string' || rawPath.length === 0) throw runError('WF_ARGUMENT_INVALID', 'files.read() requires a path string')
    let options = {}
    if (rawOptions !== undefined && rawOptions !== null) {
      options = materializeJson(rawOptions, 'files.read() options')
      if (!isPlainObject(options)) throw runError('WF_ARGUMENT_INVALID', 'files.read() options must be an object')
      for (const key of Object.keys(options)) {
        if (key !== 'offset' && key !== 'limit') throw runError('WF_ARGUMENT_INVALID', `files.read() option "${key}" is not supported (supported: offset, limit)`)
      }
    }
    const offset = options.offset
    const limit = options.limit
    for (const [key, value] of [['offset', offset], ['limit', limit]]) {
      if (value !== undefined && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
        throw runError('WF_ARGUMENT_INVALID', `files.read() ${key} must be a non-negative integer`)
      }
    }
    const params = { path: rawPath, ...(offset === undefined ? {} : { offset }), ...(limit === undefined ? {} : { limit }) }
    return this.observe('files.read', params, async () => {
      const resolved = await this.services.resolvePath(rawPath)
      const fileStat = await this.statSafe(resolved)
      if (fileStat !== undefined && fileStat !== null) {
        if (fileStat.type !== 'file') throw runError('WF_ARGUMENT_INVALID', `files.read() target is not a regular file: ${rawPath}`)
        if (typeof fileStat.size === 'number' && fileStat.size > MAX_FILE_BYTES) {
          throw runError('WF_LIMIT', `files.read() target is larger than ${MAX_FILE_BYTES} bytes: ${rawPath}`)
        }
      }
      let text = await this.readText(resolved, rawPath)
      if (offset !== undefined || limit !== undefined) {
        const lines = text.split(/\r?\n/)
        const start = offset ?? 0
        const end = limit === undefined ? undefined : start + limit
        text = lines.slice(start, end).join('\n')
      }
      return text
    })
  }

  async filesGrep(rawPattern, rawOptions) {
    this.requireCapability('observe', 'files.grep()')
    this.throwIfStopped()
    if (typeof rawPattern !== 'string' || rawPattern.length === 0) throw runError('WF_ARGUMENT_INVALID', 'files.grep() requires a regular expression string')
    let options = {}
    if (rawOptions !== undefined && rawOptions !== null) {
      options = materializeJson(rawOptions, 'files.grep() options')
      if (!isPlainObject(options)) throw runError('WF_ARGUMENT_INVALID', 'files.grep() options must be an object')
      for (const key of Object.keys(options)) {
        if (key !== 'glob') throw runError('WF_ARGUMENT_INVALID', `files.grep() option "${key}" is not supported (supported: glob)`)
      }
    }
    let matcher
    try {
      matcher = new RegExp(rawPattern)
    } catch (error) {
      throw runError('WF_ARGUMENT_INVALID', `files.grep() pattern is not a valid regular expression: ${errorText(error)}`)
    }
    const globPattern = options.glob ?? '**/*'
    if (typeof globPattern !== 'string' || globPattern.length === 0) throw runError('WF_ARGUMENT_INVALID', 'files.grep() glob must be a non-empty string')
    assertWorkspacePattern(globPattern)
    const params = { pattern: rawPattern, ...(options.glob === undefined ? {} : { glob: options.glob }) }
    return this.observe('files.grep', params, async () => {
      const files = await this.globWorkspace(this.services.workspaceRoot, globPattern)
      const matches = []
      let bytes = 0
      for (const relativePath of files) {
        const resolved = await this.services.resolvePath(relativePath)
        let text
        try {
          text = await this.services.readTextFile(resolved, { maxBytes: MAX_FILE_BYTES })
        } catch {
          continue
        }
        if (typeof text !== 'string') continue
        const lines = text.split(/\r?\n/)
        for (let index = 0; index < lines.length; index++) {
          const line = lines[index]
          // A caller-supplied /g or /y flag would otherwise keep lastIndex
          // between test() calls and silently skip matches.
          if (matcher.global || matcher.sticky) matcher.lastIndex = 0
          if (!matcher.test(line)) continue
          matches.push({ path: relativePath, line: index + 1, text: line })
          bytes += Buffer.byteLength(line, 'utf8') + Buffer.byteLength(relativePath, 'utf8')
          if (matches.length > MAX_GREP_MATCHES) {
            throw runError('WF_LIMIT', `files.grep() matched more than ${MAX_GREP_MATCHES} lines; narrow the search`)
          }
          if (bytes > MAX_GREP_BYTES) {
            throw runError('WF_LIMIT', `files.grep() output exceeds ${MAX_GREP_BYTES} bytes; narrow the search`)
          }
        }
      }
      return matches
    })
  }

  async runGit(args, label) {
    this.throwIfStopped()
    let result
    try {
      result = await this.services.runCommand({
        argv: ['git', ...args],
        cwd: this.services.workspaceRoot,
        timeoutMs: GIT_TIMEOUT_MS,
        maxBytes: MAX_WORLD_OUTPUT_BYTES,
        signal: this.abort.signal,
      })
    } catch (error) {
      throw toWorkflowRunError(error, 'WF_SCRIPT_ERROR')
    }
    if (this.cancelled) throw this.stopError ?? runError('WF_CANCELLED', 'workflow run was cancelled')
    const exitCode = result !== null && typeof result === 'object' && typeof result.exitCode === 'number' ? result.exitCode : null
    if (exitCode !== 0) {
      const stderr = result !== null && typeof result === 'object' ? truncateText(result.stderr ?? '', 2000).trim() : ''
      throw runError('WF_SCRIPT_ERROR', `${label} failed (exit code ${exitCode ?? 'unknown'})${stderr.length === 0 ? '' : `: ${stderr}`}`)
    }
    return result !== null && typeof result === 'object' && typeof result.stdout === 'string' ? result.stdout : ''
  }

  async gitStatus() {
    this.requireCapability('observe', 'git.status()')
    return this.observe('git.status', {}, async () => (await this.runGit(['status', '--porcelain=v1'], 'git status')).trimEnd())
  }

  async gitDiff(rawPath, rawBase) {
    this.requireCapability('observe', 'git.diff()')
    this.throwIfStopped()
    let pathArgument
    if (rawPath !== undefined && rawPath !== null) {
      if (typeof rawPath !== 'string' || rawPath.length === 0) throw runError('WF_ARGUMENT_INVALID', 'git.diff() path must be a non-empty string')
      pathArgument = rawPath
    }
    let base
    if (rawBase !== undefined && rawBase !== null) {
      base = assertGitRef(rawBase, 'git.diff() base')
    }
    if (pathArgument !== undefined) await this.services.resolvePath(pathArgument)
    const params = { ...(pathArgument === undefined ? {} : { path: pathArgument }), ...(base === undefined ? {} : { base }) }
    return this.observe('git.diff', params, async () => {
      const args = ['diff']
      if (base !== undefined) args.push(base)
      if (pathArgument !== undefined) args.push('--', pathArgument)
      return (await this.runGit(args, 'git diff')).trimEnd()
    })
  }

  async gitChangedFiles(rawBase) {
    this.requireCapability('observe', 'git.changedFiles()')
    this.throwIfStopped()
    let base = 'HEAD'
    if (rawBase !== undefined && rawBase !== null) {
      base = assertGitRef(rawBase, 'git.changedFiles() base')
    }
    return this.observe('git.changedFiles', { base }, async () => {
      const stdout = await this.runGit(['diff', '--name-only', base, '--'], 'git diff --name-only')
      const paths = []
      for (const line of stdout.split(/\r?\n/)) {
        const path = line.trim()
        if (path.length > 0 && !paths.includes(path)) paths.push(path)
      }
      return paths
    })
  }

  async gitLog(rawLimit) {
    this.requireCapability('observe', 'git.log()')
    this.throwIfStopped()
    let limit = 20
    if (rawLimit !== undefined && rawLimit !== null) {
      if (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) {
        throw runError('WF_ARGUMENT_INVALID', 'git.log() limit must be an integer between 1 and 200')
      }
      limit = rawLimit
    }
    return this.observe('git.log', { limit }, async () => (await this.runGit(['log', '--oneline', '-n', String(limit)], 'git log')).trimEnd())
  }

  /* -- world.run -------------------------------------------------- */

  async worldRun(rawCommand, rawArgs, rawOptions) {
    this.requireCapability('execute', 'world.run()')
    this.throwIfStopped()
    if (typeof rawCommand !== 'string' || rawCommand.trim().length === 0) throw runError('WF_ARGUMENT_INVALID', 'world.run() requires a non-empty command string')
    let argsArray = []
    if (rawArgs !== undefined && rawArgs !== null) {
      const materialised = materializeJson(rawArgs, 'world.run() arguments')
      if (!Array.isArray(materialised) || materialised.some((entry) => typeof entry !== 'string')) {
        throw runError('WF_ARGUMENT_INVALID', 'world.run() arguments must be an array of strings')
      }
      argsArray = materialised
    }
    let options = {}
    if (rawOptions !== undefined && rawOptions !== null) {
      options = materializeJson(rawOptions, 'world.run() options')
      if (!isPlainObject(options)) throw runError('WF_ARGUMENT_INVALID', 'world.run() options must be an object')
      for (const key of Object.keys(options)) {
        if (key !== 'cwd' && key !== 'timeoutMs') throw runError('WF_ARGUMENT_INVALID', `world.run() option "${key}" is not supported (supported: cwd, timeoutMs)`)
      }
    }
    const commandName = normalizeCommandName(rawCommand)
    if (commandName.length === 0) throw runError('WF_ARGUMENT_INVALID', 'world.run() requires a command with a file name')
    if (this.limits.blockedCommands.includes(commandName)) {
      throw runError('WF_COMMAND_DENIED', `world.run() command "${commandName}" is blocked by config.blockedCommands`)
    }
    if (!this.limits.allowedCommands.includes(commandName)) {
      throw runError('WF_COMMAND_DENIED', `world.run() command "${commandName}" is not in config.allowedCommands`)
    }
    let cwd = this.services.workspaceRoot
    if (options.cwd !== undefined) {
      if (typeof options.cwd !== 'string' || options.cwd.trim().length === 0) throw runError('WF_ARGUMENT_INVALID', 'world.run() cwd must be a non-empty string')
      cwd = await this.services.resolvePath(options.cwd)
    }
    let timeoutMs = DEFAULT_WORLD_TIMEOUT_MS
    if (options.timeoutMs !== undefined) {
      if (typeof options.timeoutMs !== 'number' || !Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        throw runError('WF_ARGUMENT_INVALID', 'world.run() timeoutMs must be a positive number')
      }
      timeoutMs = Math.min(options.timeoutMs, DEFAULT_WORLD_TIMEOUT_MS)
    }
    if (this.worldRuns >= this.limits.maxWorldRuns) {
      throw runError('WF_LIMIT', `this run reached its world.run cap (maxWorldRuns: ${this.limits.maxWorldRuns})`)
    }
    this.worldRuns += 1
    let result
    try {
      result = await this.services.runCommand({
        argv: [rawCommand, ...argsArray],
        cwd,
        timeoutMs,
        maxBytes: MAX_WORLD_OUTPUT_BYTES,
        signal: this.abort.signal,
      })
    } catch (error) {
      throw toWorkflowRunError(error, 'WF_SCRIPT_ERROR')
    }
    this.markCacheDirty()
    if (this.cancelled) throw this.stopError ?? runError('WF_CANCELLED', 'workflow run was cancelled')
    const normalised = result !== null && typeof result === 'object' ? result : {}
    return {
      exitCode: typeof normalised.exitCode === 'number' ? normalised.exitCode : null,
      signal: typeof normalised.signal === 'string' ? normalised.signal : null,
      timedOut: normalised.timedOut === true,
      aborted: normalised.aborted === true,
      stdout: truncateText(typeof normalised.stdout === 'string' ? normalised.stdout : '', MAX_WORLD_OUTPUT_BYTES),
      stderr: truncateText(typeof normalised.stderr === 'string' ? normalised.stderr : '', MAX_WORLD_OUTPUT_BYTES),
    }
  }

  /* -- context / drive ------------------------------------------- */

  buildHooks() {
    const artifact = Object.freeze({
      markdown: (name, content) => this.artifactMarkdown(name, content),
      table: (name, columns, rows) => this.artifactTable(name, columns, rows),
      file: (name, path) => this.contain(this.artifactFile(name, path)),
    })
    const files = Object.freeze({
      glob: (pattern, options) => this.contain(this.filesGlob(pattern, options)),
      read: (path, options) => this.contain(this.filesRead(path, options)),
      grep: (pattern, options) => this.contain(this.filesGrep(pattern, options)),
    })
    const git = Object.freeze({
      status: () => this.contain(this.gitStatus()),
      diff: (path, base) => this.contain(this.gitDiff(path, base)),
      changedFiles: (base) => this.contain(this.gitChangedFiles(base)),
      log: (limit) => this.contain(this.gitLog(limit)),
    })
    const world = Object.freeze({
      run: (command, args, options) => this.contain(this.worldRun(command, args, options)),
    })
    const hook = (fn) => Object.freeze(fn)
    const freezeJson = (value) => {
      if (value === null || typeof value !== 'object') return value
      if (Array.isArray(value)) {
        for (const entry of value) freezeJson(entry)
      } else {
        for (const key of Object.keys(value)) freezeJson(value[key])
      }
      return Object.freeze(value)
    }
    return {
      agent: hook((prompt, options) => this.contain(this.agent(prompt, options))),
      parallel: hook((thunks) => this.contain(this.parallel(thunks))),
      pipeline: hook((items, ...stages) => this.contain(this.pipeline(items, stages))),
      phase: hook((title) => this.phase(title)),
      log: hook((message) => this.log(message)),
      report: hook((item, tag) => this.report(item, tag)),
      artifact,
      files,
      git,
      world,
      args: freezeJson(this.args === undefined ? null : this.args),
    }
  }

  finish(stopReason, extra = {}) {
    this.settle()
    const usage = {
      agents: this.agentsStarted,
      worldRuns: this.worldRuns,
      durationMs: Math.max(0, Date.now() - this.startedAt),
    }
    const reports = this.reports.map((entry) => (entry.tag === undefined
      ? { item: entry.item, seq: entry.seq }
      : { item: entry.item, tag: entry.tag, seq: entry.seq }))
    const artifacts = this.artifacts.map((entry) => ({ name: entry.name, kind: entry.kind, content: entry.content }))
    return {
      value: stopReason === 'completed' ? (extra.value === undefined ? null : extra.value) : null,
      stopReason,
      ...(extra.error === undefined ? {} : { error: errorObject(extra.error) }),
      agentsStarted: this.agentsStarted,
      usage,
      reports,
      artifacts,
    }
  }

  async drive() {
    if (this.cancelled) {
      await this.flush()
      return this.finish(this.stopError?.code === 'WF_BUDGET_EXCEEDED' ? 'error' : 'cancelled', { error: this.stopError ?? undefined })
    }
    let compiled
    try {
      compiled = new vm.Script(`(async () => {\n'use strict';\n${this.body}\n})()`, {
        filename: `workflow:${this.meta.id}.js`,
      })
    } catch (error) {
      await this.flush()
      return this.finish('error', { error: runError('WF_SCRIPT_ERROR', `workflow script does not parse: ${errorText(error)}`) })
    }
    try {
      this.context = vm.createContext(this.buildHooks(), {
        name: `workflow:${this.meta.id}`,
        codeGeneration: { strings: false, wasm: false },
      })
    } catch (error) {
      await this.flush()
      return this.finish('error', { error: toWorkflowRunError(error, 'WF_SCRIPT_ERROR') })
    }
    let scriptOutcome
    try {
      const scriptPromise = compiled.runInContext(this.context, { timeout: this.limits.syncTimeoutMs })
      scriptOutcome = Promise.resolve(scriptPromise).then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      )
    } catch (error) {
      await this.flush()
      return this.finish('error', { error: toWorkflowRunError(error, 'WF_SCRIPT_ERROR') })
    }
    scriptOutcome.catch(() => {})
    const outcome = await Promise.race([scriptOutcome, this.terminal])
    // The script has settled: abort the internal signal now so any child call
    // the script started but never awaited cannot outlive the run.
    this.settle()
    if (outcome.kind === 'terminal') {
      scriptOutcome.catch(() => {})
      await this.flush()
      return this.finish(outcome.stopReason, { error: outcome.error })
    }
    if (this.cancelled) {
      await this.flush()
      return this.finish(this.stopError?.code === 'WF_BUDGET_EXCEEDED' ? 'error' : 'cancelled', { error: this.stopError ?? undefined })
    }
    if (!outcome.ok) {
      await this.flush()
      return this.finish('error', { error: toWorkflowRunError(outcome.error, 'WF_SCRIPT_ERROR') })
    }
    let value
    try {
      value = materializeJson(outcome.value, 'the workflow return value', 'WF_RESULT_INVALID')
    } catch (error) {
      await this.flush()
      return this.finish('error', { error: toWorkflowRunError(error, 'WF_RESULT_INVALID') })
    }
    await this.flush()
    return this.finish('completed', { value })
  }
}

const REQUIRED_SERVICE_FUNCTIONS = ['startAgent', 'runCommand', 'resolvePath', 'readTextFile', 'listDir', 'statFile']

function invalidRequest(message, startedAt) {
  return {
    value: null,
    stopReason: 'error',
    error: { code: 'WF_ARGUMENT_INVALID', message },
    agentsStarted: 0,
    usage: { agents: 0, worldRuns: 0, durationMs: Math.max(0, Date.now() - startedAt) },
    reports: [],
    artifacts: [],
  }
}

/**
 * Execute one workflow run.
 *
 * Never rejects: a script throw, a tripped budget, cancellation or an invalid
 * request all resolve to `{ value: null, stopReason, error? }`.
 *
 * @param {{
 *   document: { meta: object, body: string },
 *   args?: unknown,
 *   config?: object,
 *   services: {
 *     workspaceRoot: string,
 *     sessionId?: string,
 *     startAgent: Function,
 *     runCommand: Function,
 *     readTextFile: Function,
 *     listDir: Function,
 *     statFile: Function,
 *     resolvePath: Function,
 *     logger?: { warn?: Function, info?: Function },
 *   },
 *   runId?: string,
 *   signal?: AbortSignal,
 *   cache?: { agents?: Map<string, object>, observations?: Map<string, unknown> },
 *   cachePolicy?: 'none'|'resume'|'amend',
 *   onEvent?: Function,
 *   onAgentCall?: Function,
 *   onObservation?: Function,
 * }} request
 * @returns {Promise<{
 *   value: unknown,
 *   stopReason: 'completed'|'cancelled'|'error',
 *   error?: { code: string, message: string },
 *   agentsStarted: number,
 *   usage: { agents: number, worldRuns: number, durationMs: number },
 *   reports: Array<{ item: unknown, tag?: string, seq: number }>,
 *   artifacts: Array<{ name: string, kind: string, content: string }>,
 * }>}
 */
export async function executeWorkflow(request) {
  const startedAt = Date.now()
  try {
    if (request === null || typeof request !== 'object') return invalidRequest('executeWorkflow() requires a request object', startedAt)
    const document = request.document
    if (document === null || typeof document !== 'object') return invalidRequest('executeWorkflow() requires a document { meta, body }', startedAt)
    let meta
    try {
      meta = normalizeMeta(document.meta)
    } catch (error) {
      return {
        value: null,
        stopReason: 'error',
        error: errorObject(error),
        agentsStarted: 0,
        usage: { agents: 0, worldRuns: 0, durationMs: Math.max(0, Date.now() - startedAt) },
        reports: [],
        artifacts: [],
      }
    }
    if (typeof document.body !== 'string') return invalidRequest('workflow body must be a string', startedAt)
    const services = request.services
    if (services === null || typeof services !== 'object') return invalidRequest('executeWorkflow() requires injected services', startedAt)
    const missing = REQUIRED_SERVICE_FUNCTIONS.filter((name) => typeof services[name] !== 'function')
    if (typeof services.workspaceRoot !== 'string' || services.workspaceRoot.length === 0) missing.push('workspaceRoot')
    if (missing.length > 0) return invalidRequest(`executeWorkflow() services are missing: ${missing.join(', ')}`, startedAt)
    const cachePolicy = request.cachePolicy === undefined ? 'none' : request.cachePolicy
    if (!CACHE_POLICIES.includes(cachePolicy)) return invalidRequest(`unknown cachePolicy "${String(cachePolicy)}" (supported: ${CACHE_POLICIES.join(', ')})`, startedAt)
    let args = null
    if (request.args !== undefined) {
      try {
        args = materializeJson(request.args, 'workflow args')
      } catch (error) {
        return {
          value: null,
          stopReason: 'error',
          error: errorObject(error),
          agentsStarted: 0,
          usage: { agents: 0, worldRuns: 0, durationMs: Math.max(0, Date.now() - startedAt) },
          reports: [],
          artifacts: [],
        }
      }
    }
    const signal = request.signal === undefined || request.signal === null ? null : request.signal
    if (signal !== null && typeof signal.addEventListener !== 'function') return invalidRequest('request.signal must be an AbortSignal', startedAt)
    const cache = request.cache !== null && typeof request.cache === 'object' ? request.cache : null
    const execution = new WorkflowExecution({
      meta,
      body: document.body,
      args,
      runId: typeof request.runId === 'string' ? request.runId : null,
      services,
      limits: normalizeLimits(request.config),
      signal,
      onEvent: typeof request.onEvent === 'function' ? request.onEvent : null,
      onAgentCall: typeof request.onAgentCall === 'function' ? request.onAgentCall : null,
      onObservation: typeof request.onObservation === 'function' ? request.onObservation : null,
      cache,
      cachePolicy,
    })
    try {
      execution.start()
      return await execution.drive()
    } catch (error) {
      await execution.flush().catch(() => {})
      return execution.finish('error', { error: toWorkflowRunError(error, 'WF_SCRIPT_ERROR') })
    } finally {
      execution.settle()
    }
  } catch (error) {
    return {
      value: null,
      stopReason: 'error',
      error: errorObject(toWorkflowRunError(error, 'WF_SCRIPT_ERROR')),
      agentsStarted: 0,
      usage: { agents: 0, worldRuns: 0, durationMs: Math.max(0, Date.now() - startedAt) },
      reports: [],
      artifacts: [],
    }
  }
}
