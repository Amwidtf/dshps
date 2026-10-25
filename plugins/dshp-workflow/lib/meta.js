/**
 * Workflow document metadata for `dshp-workflow`.
 *
 * Saved workflows are plain JavaScript files whose first block is a static
 * `/* @dshp-workflow { ... } *\/` metadata comment. The block is parsed as
 * JSON and never evaluated. Ad-hoc tool calls supply the same meta as a JSON
 * argument instead, so this module exposes two entry points:
 *
 * - {@link parseWorkflowDocument} for saved files (the block is required)
 * - {@link buildDocument} for ad-hoc calls (meta supplied separately)
 *
 * Everything here is pure validation/normalisation; filesystem access lives in
 * `store.js` and execution lives in `runtime.js`.
 * @module dshp-workflow/lib/meta
 */
/**
 * Typed workflow-document error. `code` is a stable machine-routable string
 * (`WF_META_INVALID`, `WF_META_JSON`, `WF_CAPABILITY_INVALID`,
 * `WF_CAPABILITY_DENIED`) distinct from the human-readable message.
 */
export class WorkflowSpecError extends Error {
  /**
   * @param {string} code stable failure class
   * @param {string} message human-readable message
   */
  constructor(code, message) {
    super(String(message ?? ''))
    this.name = 'WorkflowSpecError'
    this.code = String(code)
  }
}

/** Saved workflow ids: kebab-case, starting with a letter, max 64 chars. */
export const WORKFLOW_ID_RE = /^[a-z][a-z0-9-]{0,63}$/

/** Declared capabilities. `orchestrate` is implied and always present. */
export const WORKFLOW_CAPABILITIES = ['orchestrate', 'observe', 'execute']

const DOC_BLOCK_RE = /^\s*\/\*[ \t]*@dshp-workflow\b([\s\S]*?)\*\//

const META_KEYS = new Set(['id', 'name', 'description', 'whenToUse', 'capabilities', 'phases'])
const PHASE_KEYS = new Set(['title', 'detail'])

const MAX_NAME = 200
const MAX_DESCRIPTION = 2000
const MAX_WHEN_TO_USE = 2000
const MAX_PHASE_TITLE = 120
const MAX_PHASE_DETAIL = 2000

const META_KEYS_TEXT = 'id, name, description, whenToUse, capabilities, phases'

/** Whether a value is a plain data object (cross-realm plain objects included). */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  try {
    const proto = Object.getPrototypeOf(value)
    return proto === null || Object.getPrototypeOf(proto) === null
  } catch {
    return false
  }
}

/** Whether `value` is a valid saved-workflow id. */
export function isWorkflowId(value) {
  return typeof value === 'string' && WORKFLOW_ID_RE.test(value)
}

function metaError(message) {
  return new WorkflowSpecError('WF_META_INVALID', message)
}

function capabilityError(message) {
  return new WorkflowSpecError('WF_CAPABILITY_INVALID', message)
}

function readTrimmedString(value, path, { max, required = false, allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw metaError(`${path} is required`)
    return undefined
  }
  if (typeof value !== 'string') throw metaError(`${path} must be a string`)
  const text = value.trim()
  if (text.length === 0 && !allowEmpty) {
    if (required) throw metaError(`${path} must not be empty`)
    return undefined
  }
  if (max !== undefined && text.length > max) throw metaError(`${path} is longer than ${max} characters`)
  return text
}

/** Normalise the declared capability list; `orchestrate` is always implied. */
function normaliseCapabilities(input) {
  if (input === undefined) return ['orchestrate']
  if (!Array.isArray(input)) throw capabilityError('capabilities must be an array of "orchestrate", "observe" and/or "execute"')
  const declared = new Set()
  for (const [index, entry] of input.entries()) {
    if (typeof entry !== 'string') throw capabilityError(`capabilities[${index}] must be a string`)
    const capability = entry.trim()
    if (!WORKFLOW_CAPABILITIES.includes(capability)) {
      throw capabilityError(`unknown capability "${entry}" (supported: ${WORKFLOW_CAPABILITIES.join(', ')})`)
    }
    declared.add(capability)
  }
  declared.add('orchestrate')
  return WORKFLOW_CAPABILITIES.filter((capability) => declared.has(capability))
}

/** Normalise the optional documentation-only phase list. */
function normalisePhases(input) {
  if (input === undefined) return []
  if (!Array.isArray(input)) throw metaError('phases must be an array of { title, detail? } objects')
  const phases = []
  for (const [index, entry] of input.entries()) {
    if (!isPlainObject(entry)) throw metaError(`phases[${index}] must be an object`)
    for (const key of Object.keys(entry)) {
      if (!PHASE_KEYS.has(key)) throw metaError(`phases[${index}].${key} is not a supported phase field (supported: title, detail)`)
    }
    const title = readTrimmedString(entry.title, `phases[${index}].title`, { max: MAX_PHASE_TITLE, required: true })
    const detail = readTrimmedString(entry.detail, `phases[${index}].detail`, { max: MAX_PHASE_DETAIL })
    phases.push(detail === undefined ? { title } : { title, detail })
  }
  return phases
}

/**
 * Validate and normalise workflow metadata.
 *
 * @param {unknown} input caller-supplied metadata (parsed JSON or tool argument)
 * @param {string} [fallbackId] id to use when the metadata omits `id` (saved file stem)
 * @returns {{ id: string, name: string, description: string, whenToUse?: string, capabilities: string[], phases: Array<{ title: string, detail?: string }> }}
 * @throws {WorkflowSpecError} `WF_META_INVALID` / `WF_CAPABILITY_INVALID`
 */
export function normalizeMeta(input, fallbackId) {
  if (!isPlainObject(input)) throw metaError('workflow metadata must be a plain object')
  for (const key of Object.keys(input)) {
    if (!META_KEYS.has(key)) {
      throw metaError(`workflow metadata field "${key}" is not supported (supported: ${META_KEYS_TEXT})`)
    }
  }

  const rawId = input.id === undefined || input.id === null ? fallbackId : input.id
  if (rawId === undefined || rawId === null || rawId === '') throw metaError('workflow id is required (or pass a fallback id from the file name)')
  if (typeof rawId !== 'string') throw metaError('workflow id must be a string')
  const id = rawId.trim()
  if (!isWorkflowId(id)) throw metaError(`workflow id "${id}" must match [a-z][a-z0-9-]{0,63}`)

  const name = readTrimmedString(input.name, 'name', { max: MAX_NAME, required: true })
  const description = readTrimmedString(input.description, 'description', { max: MAX_DESCRIPTION, required: true })
  const whenToUse = readTrimmedString(input.whenToUse, 'whenToUse', { max: MAX_WHEN_TO_USE })
  const capabilities = normaliseCapabilities(input.capabilities)
  const phases = normalisePhases(input.phases)

  return {
    id,
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    capabilities,
    phases,
  }
}

function assertBody(body) {
  if (typeof body !== 'string') throw metaError('workflow body must be a string')
  if (body.trim().length === 0) throw metaError('workflow body must not be empty')
}

/**
 * Parse a saved workflow document: a leading `/* @dshp-workflow {...} *\/`
 * JSON block, then the JavaScript body.
 *
 * @param {string} text workflow file contents
 * @param {string} [fallbackId] id used when the metadata omits `id` (file stem)
 * @returns {{ meta: object, body: string }}
 * @throws {WorkflowSpecError} `WF_META_INVALID` / `WF_META_JSON` / `WF_CAPABILITY_INVALID`
 */
export function parseWorkflowDocument(text, fallbackId) {
  if (typeof text !== 'string') throw metaError('workflow document must be a string')
  const match = DOC_BLOCK_RE.exec(text)
  if (match === null) {
    throw metaError('workflow document must start with a /* @dshp-workflow { ... } */ metadata block')
  }
  const jsonText = match[1].trim()
  if (jsonText.length === 0) throw new WorkflowSpecError('WF_META_JSON', 'workflow metadata block is empty')
  let raw
  try {
    raw = JSON.parse(jsonText)
  } catch (error) {
    throw new WorkflowSpecError('WF_META_JSON', `workflow metadata block is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const meta = normalizeMeta(raw, fallbackId)
  let body = text.slice(match[0].length)
  body = body.replace(/^\r?\n/, '')
  assertBody(body)
  return { meta, body }
}

/**
 * Build an ad-hoc workflow document from a caller-supplied meta and script
 * body (the model tool path). No metadata block is required or produced.
 *
 * @param {unknown} metaInput caller-supplied metadata
 * @param {string} body plain JavaScript body
 * @param {string} [fallbackId] id used when the metadata omits `id`
 * @returns {{ meta: object, body: string }}
 * @throws {WorkflowSpecError}
 */
export function buildDocument(metaInput, body, fallbackId) {
  assertBody(body)
  return { meta: normalizeMeta(metaInput, fallbackId), body }
}

/**
 * Pre-run capability gate: a workflow that declares `observe` needs
 * `config.allowObserve`; one that declares `execute` needs `config.allowExecute`.
 * `orchestrate` is always permitted.
 *
 * @param {{ capabilities?: string[] }} meta normalised metadata
 * @param {{ allowObserve?: boolean, allowExecute?: boolean }} [config]
 * @throws {WorkflowSpecError} `WF_CAPABILITY_DENIED` / `WF_CAPABILITY_INVALID`
 */
export function assertCapabilities(meta, config = {}) {
  const capabilities = meta !== null && typeof meta === 'object' ? meta.capabilities : undefined
  if (!Array.isArray(capabilities)) throw capabilityError('workflow metadata capabilities must be an array')
  for (const [index, capability] of capabilities.entries()) {
    if (typeof capability !== 'string' || !WORKFLOW_CAPABILITIES.includes(capability)) {
      throw capabilityError(`workflow capability at index ${index} is not one of ${WORKFLOW_CAPABILITIES.join(', ')}`)
    }
  }
  const declared = new Set(capabilities)
  if (declared.has('observe') && config.allowObserve !== true) {
    throw new WorkflowSpecError('WF_CAPABILITY_DENIED', 'this workflow declares the observe capability but the plugin config has allowObserve disabled')
  }
  if (declared.has('execute') && config.allowExecute !== true) {
    throw new WorkflowSpecError('WF_CAPABILITY_DENIED', 'this workflow declares the execute capability but the plugin config has allowExecute disabled')
  }
}
