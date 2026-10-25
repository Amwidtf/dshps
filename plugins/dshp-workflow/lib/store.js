/**
 * Filesystem store for `dshp-workflow`: the saved-workflow library (global and
 * project scope) plus the per-run journal and artifact files.
 *
 * Layout (design doc section 6):
 *
 *   <homeDir>/dshps/workflow/workflows/<id>.js
 *   <homeDir>/dshps/workflow/runs/<runId>/run.json
 *   <homeDir>/dshps/workflow/runs/<runId>/artifacts/<artifactId>.(md|txt)
 *   <projectWorkflowDir>/<id>.js          (host: <workspace>/.dshps/workflows)
 *
 * Every write is atomic (temp file + rename) and ids are validated before they
 * ever reach a path, so a caller-supplied id can never escape its directory.
 * @module dshp-workflow/lib/store
 */
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { WorkflowSpecError, isWorkflowId, parseWorkflowDocument } from './meta.js'

const WORKFLOW_EXT = '.js'
const RUN_ID_RE = /^wf-[a-z0-9]{1,13}-[0-9a-f]{6}$/
const ARTIFACT_ID_RE = /^art-[a-z0-9]{1,13}-[0-9a-f]{6}$/
const ARTIFACT_KINDS = ['markdown', 'table', 'file']
const MAX_ARTIFACT_NAME = 200

/** Fields a caller may merge into a run journal; identity fields stay fixed. */
const RUN_PATCH_KEYS = new Set([
  'status',
  'stopReason',
  'error',
  'endedAt',
  'value',
  'phases',
  'logs',
  'reports',
  'artifacts',
  'agents',
  'observations',
  'usage',
  'script',
])

/**
 * Typed store error. `code` is a stable machine-routable string such as
 * `WF_ID_INVALID`, `WF_SCOPE_INVALID`, `WF_PROJECT_REQUIRED`,
 * `WF_WORKFLOW_NOT_FOUND`, `WF_RUN_NOT_FOUND`, `WF_ARTIFACT_NOT_FOUND`,
 * `WF_ARTIFACT_INVALID`, `WF_STORE_INVALID` or `WF_IO_ERROR`.
 */
export class WorkflowStoreError extends Error {
  /**
   * @param {string} code stable failure class
   * @param {string} message human-readable message
   */
  constructor(code, message) {
    super(String(message ?? ''))
    this.name = 'WorkflowStoreError'
    this.code = String(code)
  }
}

function storeError(code, message) {
  return new WorkflowStoreError(code, message)
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function wrapIoError(error, action) {
  return storeError('WF_IO_ERROR', `${action}: ${errorText(error)}`)
}

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

function assertRunId(runId) {
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) {
    throw storeError('WF_ID_INVALID', 'workflow run id must match wf-<base36 time>-<6 hex>')
  }
}

function assertArtifactId(artifactId) {
  if (typeof artifactId !== 'string' || !ARTIFACT_ID_RE.test(artifactId)) {
    throw storeError('WF_ID_INVALID', 'artifact id must match art-<base36 time>-<6 hex>')
  }
}

/** Normalise a workflow scope; omitted scope defaults to global. */
function normalizeScope(scope) {
  if (scope === undefined || scope === null || scope === '') return 'global'
  if (scope === 'global' || scope === 'project') return scope
  throw storeError('WF_SCOPE_INVALID', `unknown workflow scope "${scope}" (supported: global, project)`)
}

/** Resolve `$DSH_HOME` (or `~/.dsh`), following the repo-wide convention. */
export function resolveHomeDir(env = process.env) {
  const configured = env !== null && typeof env === 'object' ? env.DSH_HOME : undefined
  if (typeof configured === 'string' && configured.trim().length > 0) return resolve(configured.trim())
  return join(homedir(), '.dsh')
}

/** Atomic UTF-8 text write: temp file in the target directory, then rename. */
async function writeFileAtomic(filePath, content) {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true })
  const tempPath = join(directory, `.${basename(filePath)}.${randomBytes(4).toString('hex')}.tmp`)
  try {
    await writeFile(tempPath, content, 'utf8')
    await rename(tempPath, filePath)
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

/** Atomic JSON write: never leaves a partially-written `run.json` behind. */
async function writeJsonAtomic(filePath, value) {
  await writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

/**
 * Create the workflow store.
 *
 * @param {{ homeDir?: string, now?: () => number }} [options] `homeDir` defaults
 *   to {@link resolveHomeDir}; `now` is injectable for tests.
 */
export function createWorkflowStore(options = {}) {
  const homeDir = typeof options.homeDir === 'string' && options.homeDir.trim().length > 0
    ? resolve(options.homeDir.trim())
    : resolveHomeDir()
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const rootDir = join(homeDir, 'dshps', 'workflow')
  const workflowsDir = join(rootDir, 'workflows')
  const runsDir = join(rootDir, 'runs')
  const runLocks = new Map()

  function paths() {
    return { rootDir, workflowsDir, runsDir }
  }

  async function ensure() {
    await mkdir(workflowsDir, { recursive: true })
    await mkdir(runsDir, { recursive: true })
  }

  /**
   * Resolve the project workflow directory. The host computes this from the
   * session working directory and `config.projectWorkflowDir`, so the argument
   * is the directory that holds project workflow files (for the default config
   * that is `<workspace>/.dshps/workflows`).
   */
  function projectWorkflowsDir(projectDir) {
    if (typeof projectDir !== 'string' || projectDir.trim().length === 0) {
      throw storeError('WF_PROJECT_REQUIRED', 'a project workflow directory is required for project-scoped workflows')
    }
    return resolve(projectDir.trim())
  }

  function workflowPath(id, scope, projectDir) {
    if (!isWorkflowId(id)) {
      throw storeError('WF_ID_INVALID', 'workflow id must match [a-z][a-z0-9-]{0,63}')
    }
    const baseDir = scope === 'project' ? projectWorkflowsDir(projectDir) : workflowsDir
    return join(baseDir, `${id}${WORKFLOW_EXT}`)
  }

  /** Serialise run-record mutations per run id, so journal updates never race. */
  function withRunLock(runId, task) {
    const previous = runLocks.get(runId) ?? Promise.resolve()
    const run = previous.catch(() => {}).then(task)
    const tail = run.catch(() => {})
    runLocks.set(runId, tail)
    tail.then(() => {
      if (runLocks.get(runId) === tail) runLocks.delete(runId)
    })
    return run
  }

  async function readRunRecord(runId) {
    assertRunId(runId)
    const filePath = join(runsDir, runId, 'run.json')
    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        throw storeError('WF_RUN_NOT_FOUND', `workflow run "${runId}" was not found`)
      }
      throw wrapIoError(error, `could not read workflow run "${runId}"`)
    }
    let record
    try {
      record = JSON.parse(text)
    } catch (error) {
      throw storeError('WF_IO_ERROR', `workflow run "${runId}" journal is not valid JSON: ${errorText(error)}`)
    }
    if (!isPlainObject(record)) {
      throw storeError('WF_IO_ERROR', `workflow run "${runId}" journal must be a JSON object`)
    }
    return record
  }

  async function listWorkflowDir(directory, scope) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
      throw wrapIoError(error, `could not list ${scope} workflows`)
    }
    const workflows = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(WORKFLOW_EXT)) continue
      const id = entry.name.slice(0, -WORKFLOW_EXT.length)
      if (!isWorkflowId(id)) continue
      const filePath = join(directory, entry.name)
      let text
      let fileStat
      try {
        text = await readFile(filePath, 'utf8')
        fileStat = await stat(filePath)
      } catch (error) {
        // Surface an unreadable file as an invalid entry instead of silently
        // omitting a workflow the user expects to see.
        workflows.push({
          id,
          scope,
          name: id,
          description: '',
          capabilities: ['orchestrate'],
          updatedAt: 0,
          bytes: 0,
          invalid: true,
          error: errorText(error),
        })
        continue
      }
      const updatedAt = Math.trunc(fileStat.mtimeMs)
      const bytes = fileStat.size
      try {
        const { meta } = parseWorkflowDocument(text, id)
        if (meta.id !== id) throw new WorkflowSpecError('WF_META_INVALID', `document id "${meta.id}" does not match its file id "${id}"`)
        workflows.push({
          id,
          scope,
          name: meta.name,
          description: meta.description,
          capabilities: meta.capabilities,
          updatedAt,
          bytes,
        })
      } catch (error) {
        workflows.push({
          id,
          scope,
          name: id,
          description: '',
          capabilities: ['orchestrate'],
          updatedAt,
          bytes,
          invalid: true,
          error: errorText(error),
        })
      }
    }
    workflows.sort((left, right) => left.id.localeCompare(right.id))
    return workflows
  }

  /**
   * List saved workflows: global entries first, then project entries; a project
   * workflow shadows a global workflow with the same id.
   *
   * @param {{ projectDir?: string }} [options]
   * @returns {Promise<Array<{ id: string, scope: 'global'|'project', name: string, description: string, capabilities: string[], updatedAt: number, bytes: number, invalid?: boolean, error?: string }>>}
   */
  async function listWorkflows(options = {}) {
    await ensure()
    const projectDir = options !== null && typeof options === 'object' ? options.projectDir : undefined
    const globalWorkflows = await listWorkflowDir(workflowsDir, 'global')
    const projectWorkflows = projectDir === undefined || projectDir === null ? [] : await listWorkflowDir(projectWorkflowsDir(projectDir), 'project')
    const projectIds = new Set(projectWorkflows.map((workflow) => workflow.id))
    return [...globalWorkflows.filter((workflow) => !projectIds.has(workflow.id)), ...projectWorkflows]
  }

  /**
   * Read and parse one saved workflow.
   *
   * @param {{ id: string, scope?: 'global'|'project', projectDir?: string }} input
   * @returns {Promise<{ id: string, scope: 'global'|'project', text: string, meta: object }>}
   */
  async function readWorkflow(input = {}) {
    const scope = normalizeScope(input.scope)
    const id = input.id
    const filePath = workflowPath(id, scope, input.projectDir)
    let text
    try {
      text = await readFile(filePath, 'utf8')
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
        throw storeError('WF_WORKFLOW_NOT_FOUND', `workflow "${id}" was not found in the ${scope} scope`)
      }
      throw wrapIoError(error, `could not read workflow "${id}"`)
    }
    const { meta } = parseWorkflowDocument(text, id)
    if (meta.id !== id) {
      throw new WorkflowSpecError('WF_META_INVALID', `workflow document id "${meta.id}" does not match its file id "${id}"`)
    }
    return { id, scope, text, meta }
  }

  /**
   * Validate and save one workflow document. The host enforces
   * `maxSavedWorkflows` before calling this; the store only validates content
   * and ids. The document's own `id` (or the file id fallback) must match.
   *
   * @param {{ id: string, scope?: 'global'|'project', projectDir?: string, text: string }} input
   * @returns {Promise<{ id: string, scope: 'global'|'project' }>}
   */
  async function saveWorkflow(input = {}) {
    const scope = normalizeScope(input.scope)
    const id = input.id
    if (!isWorkflowId(id)) {
      throw storeError('WF_ID_INVALID', 'workflow id must match [a-z][a-z0-9-]{0,63}')
    }
    if (typeof input.text !== 'string') {
      throw storeError('WF_STORE_INVALID', 'workflow text must be a string')
    }
    const { meta } = parseWorkflowDocument(input.text, id)
    if (meta.id !== id) {
      throw new WorkflowSpecError('WF_META_INVALID', `workflow document id "${meta.id}" does not match the target id "${id}"`)
    }
    const filePath = workflowPath(id, scope, input.projectDir)
    try {
      await writeFileAtomic(filePath, input.text)
    } catch (error) {
      throw wrapIoError(error, `could not save workflow "${id}"`)
    }
    return { id, scope }
  }

  /**
   * Delete one saved workflow; a missing file is not an error.
   *
   * @param {{ id: string, scope?: 'global'|'project', projectDir?: string }} input
   * @returns {Promise<{ deleted: boolean }>}
   */
  async function deleteWorkflow(input = {}) {
    const scope = normalizeScope(input.scope)
    const filePath = workflowPath(input.id, scope, input.projectDir)
    try {
      await unlink(filePath)
      return { deleted: true }
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return { deleted: false }
      throw wrapIoError(error, `could not delete workflow "${input.id}"`)
    }
  }

  /**
   * Allocate a fresh run directory and write the initial `run.json`.
   *
   * @param {{
   *   workflowId: string,
   *   scope?: string,
   *   name?: string,
   *   meta?: object,
   *   scriptHash?: string,
   *   args?: unknown,
   *   sessionId?: string,
   *   cwd?: string,
   * }} input
   * @returns {Promise<object>} the full run record
   */
  async function createRun(input = {}) {
    if (!isPlainObject(input)) throw storeError('WF_STORE_INVALID', 'run input must be a plain object')
    await ensure()
    const meta = isPlainObject(input.meta) ? input.meta : {}
    const workflowId = typeof input.workflowId === 'string' && input.workflowId.length > 0 ? input.workflowId : meta.id
    if (typeof workflowId !== 'string' || workflowId.length === 0) {
      throw storeError('WF_STORE_INVALID', 'a workflow id is required to create a run')
    }
    const name = typeof input.name === 'string' && input.name.length > 0 ? input.name : (typeof meta.name === 'string' ? meta.name : workflowId)
    const startedAt = now()
    let runId
    let runDir
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = `wf-${startedAt.toString(36)}-${randomBytes(3).toString('hex')}`
      try {
        await mkdir(join(runsDir, candidate))
        runId = candidate
        runDir = join(runsDir, candidate)
        break
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'EEXIST') continue
        throw wrapIoError(error, 'could not create the workflow run directory')
      }
    }
    if (runId === undefined) throw storeError('WF_IO_ERROR', 'could not allocate a unique workflow run id')
    const record = {
      id: runId,
      workflowId,
      scope: typeof input.scope === 'string' && input.scope.length > 0 ? input.scope : 'global',
      name,
      meta,
      scriptHash: typeof input.scriptHash === 'string' ? input.scriptHash : '',
      args: input.args === undefined ? null : input.args,
      sessionId: typeof input.sessionId === 'string' ? input.sessionId : null,
      cwd: typeof input.cwd === 'string' ? input.cwd : null,
      status: 'running',
      startedAt,
      phases: [],
      logs: [],
      reports: [],
      artifacts: [],
      agents: [],
      observations: [],
      usage: { agents: 0, worldRuns: 0, durationMs: 0 },
    }
    try {
      await writeJsonAtomic(join(runDir, 'run.json'), record)
    } catch (error) {
      throw wrapIoError(error, `could not write the journal for run "${runId}"`)
    }
    return record
  }

  /**
   * Merge a patch into `run.json` atomically. The patch is shallow: callers
   * that update `usage` pass the complete usage object.
   *
   * @param {string} runId
   * @param {object} patch
   * @returns {Promise<object>} the updated run record
   */
  async function updateRun(runId, patch) {
    assertRunId(runId)
    if (!isPlainObject(patch)) throw storeError('WF_STORE_INVALID', 'a run patch must be a plain object')
    for (const key of Object.keys(patch)) {
      if (!RUN_PATCH_KEYS.has(key)) {
        throw storeError('WF_STORE_INVALID', `run patch field "${key}" is not writable`)
      }
    }
    return withRunLock(runId, async () => {
      const record = await readRunRecord(runId)
      const next = { ...record, ...patch }
      try {
        await writeJsonAtomic(join(runsDir, runId, 'run.json'), next)
      } catch (error) {
        throw wrapIoError(error, `could not update workflow run "${runId}"`)
      }
      return next
    })
  }

  /**
   * Read one full run record.
   *
   * @param {string} runId
   * @returns {Promise<object>}
   */
  async function readRun(runId) {
    assertRunId(runId)
    return readRunRecord(runId)
  }

  /**
   * List recent run summaries, newest first.
   *
   * @param {{ limit?: number }} [options]
   * @returns {Promise<Array<object>>}
   */
  async function listRuns(options = {}) {
    const requested = options !== null && typeof options === 'object' ? options.limit : undefined
    let limit = 50
    if (typeof requested === 'number' && Number.isFinite(requested) && requested >= 1) limit = Math.min(500, Math.floor(requested))
    let entries
    try {
      entries = await readdir(runsDir, { withFileTypes: true })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return []
      throw wrapIoError(error, 'could not list workflow runs')
    }
    const runs = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue
      let record
      try {
        record = await readRunRecord(entry.name)
      } catch {
        continue
      }
      runs.push({
        id: record.id,
        workflowId: record.workflowId,
        scope: record.scope,
        name: record.name,
        status: record.status,
        ...(record.stopReason === undefined ? {} : { stopReason: record.stopReason }),
        startedAt: record.startedAt,
        ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
        ...(record.error === undefined ? {} : { error: record.error }),
        usage: record.usage ?? { agents: 0, worldRuns: 0, durationMs: 0 },
        agents: Array.isArray(record.agents) ? record.agents.length : 0,
        agentsStarted: Array.isArray(record.agents) ? record.agents.length : 0,
        phases: Array.isArray(record.phases) ? record.phases.length : 0,
        logs: Array.isArray(record.logs) ? record.logs.length : 0,
        reports: Array.isArray(record.reports) ? record.reports.length : 0,
        artifacts: Array.isArray(record.artifacts) ? record.artifacts.length : 0,
      })
    }
    runs.sort((left, right) => right.startedAt - left.startedAt || right.id.localeCompare(left.id))
    return runs.slice(0, limit)
  }

  /**
   * Persist one artifact file and append its summary to the run record.
   *
   * @param {string} runId
   * @param {{ name: string, kind: 'markdown'|'table'|'file', content: string }} input
   * @returns {Promise<{ id: string, path: string, name: string, kind: string, bytes: number, createdAt: number }>}
   */
  async function addArtifact(runId, input = {}) {
    assertRunId(runId)
    if (!isPlainObject(input)) throw storeError('WF_ARTIFACT_INVALID', 'artifact input must be a plain object')
    const kind = input.kind
    if (!ARTIFACT_KINDS.includes(kind)) {
      throw storeError('WF_ARTIFACT_INVALID', `unknown artifact kind "${kind}" (supported: ${ARTIFACT_KINDS.join(', ')})`)
    }
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name.length === 0 || name.length > MAX_ARTIFACT_NAME) {
      throw storeError('WF_ARTIFACT_INVALID', `artifact name must be a non-empty string of at most ${MAX_ARTIFACT_NAME} characters`)
    }
    if (typeof input.content !== 'string') throw storeError('WF_ARTIFACT_INVALID', 'artifact content must be a string')
    return withRunLock(runId, async () => {
      const record = await readRunRecord(runId)
      const artifactId = `art-${now().toString(36)}-${randomBytes(3).toString('hex')}`
      const extension = kind === 'file' ? '.txt' : '.md'
      const filePath = join(runsDir, runId, 'artifacts', `${artifactId}${extension}`)
      try {
        await writeFileAtomic(filePath, input.content)
      } catch (error) {
        throw wrapIoError(error, `could not write artifact "${artifactId}" for run "${runId}"`)
      }
      const entry = { id: artifactId, name, kind, bytes: Buffer.byteLength(input.content, 'utf8'), createdAt: now() }
      const artifacts = Array.isArray(record.artifacts) ? [...record.artifacts, entry] : [entry]
      try {
        await writeJsonAtomic(join(runsDir, runId, 'run.json'), { ...record, artifacts })
      } catch (error) {
        await rm(filePath, { force: true }).catch(() => {})
        throw wrapIoError(error, `could not update the journal for run "${runId}"`)
      }
      // The extra fields are a superset of the documented `{ id, path }` so a
      // caller that projects artifacts back into the run record keeps the
      // name/kind metadata `readArtifact` needs.
      return { id: artifactId, path: filePath, name, kind, bytes: entry.bytes, createdAt: entry.createdAt }
    })
  }

  /**
   * Read one artifact's metadata and content.
   *
   * @param {string} runId
   * @param {string} artifactId
   * @returns {Promise<{ id: string, name: string, kind: string, content: string, path: string }>}
   */
  async function readArtifact(runId, artifactId) {
    assertRunId(runId)
    assertArtifactId(artifactId)
    const record = await readRunRecord(runId)
    const artifacts = Array.isArray(record.artifacts) ? record.artifacts : []
    const entry = artifacts.find((candidate) => candidate !== null && typeof candidate === 'object' && candidate.id === artifactId)
    if (entry === undefined) {
      throw storeError('WF_ARTIFACT_NOT_FOUND', `artifact "${artifactId}" is not recorded in run "${runId}"`)
    }
    const artifactFile = (kind) => join(runsDir, runId, 'artifacts', `${artifactId}${kind === 'file' ? '.txt' : '.md'}`)
    // Prefer the recorded kind; if a run record kept only `{ id, path }`, fall
    // back to probing both extensions so file-kind artifacts stay readable.
    const candidates = entry?.kind === 'file' || entry?.kind === 'markdown' || entry?.kind === 'table'
      ? [entry.kind]
      : ['markdown', 'file']
    let content
    let filePath
    for (const kind of candidates) {
      const candidatePath = artifactFile(kind)
      try {
        content = await readFile(candidatePath, 'utf8')
        filePath = candidatePath
        return { id: artifactId, name: typeof entry?.name === 'string' ? entry.name : artifactId, kind, content, path: filePath }
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'ENOENT') continue
        throw wrapIoError(error, `could not read artifact "${artifactId}"`)
      }
    }
    throw storeError('WF_ARTIFACT_NOT_FOUND', `artifact "${artifactId}" was not found in run "${runId}"`)
  }

  /**
   * Delete settled runs older than `olderThanMs`. A run is aged by its
   * `endedAt` when present, otherwise by `startedAt`; running runs are kept.
   *
   * @param {{ olderThanMs: number }} input
   * @returns {Promise<number>} number of deleted runs
   */
  async function pruneRuns(input = {}) {
    const olderThanMs = input !== null && typeof input === 'object' ? input.olderThanMs : undefined
    if (typeof olderThanMs !== 'number' || !Number.isFinite(olderThanMs) || olderThanMs <= 0) {
      throw storeError('WF_STORE_INVALID', 'pruneRuns requires a positive olderThanMs value')
    }
    const cutoff = now() - olderThanMs
    let entries
    try {
      entries = await readdir(runsDir, { withFileTypes: true })
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return 0
      throw wrapIoError(error, 'could not list workflow runs for pruning')
    }
    let deleted = 0
    for (const entry of entries) {
      if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue
      const runId = entry.name
      const removed = await withRunLock(runId, async () => {
        let record
        try {
          record = await readRunRecord(runId)
        } catch {
          return false
        }
        if (record.status === 'running') return false
        const endedAt = typeof record.endedAt === 'number' ? record.endedAt : record.startedAt
        if (typeof endedAt !== 'number' || endedAt >= cutoff) return false
        try {
          await rm(join(runsDir, runId), { recursive: true, force: true })
          return true
        } catch {
          // Best effort: a locked run is retried on the next prune pass.
          return false
        }
      }).catch(() => false)
      if (removed) deleted += 1
    }
    return deleted
  }

  return {
    paths,
    ensure,
    listWorkflows,
    readWorkflow,
    saveWorkflow,
    deleteWorkflow,
    createRun,
    updateRun,
    readRun,
    listRuns,
    addArtifact,
    readArtifact,
    pruneRuns,
  }
}
