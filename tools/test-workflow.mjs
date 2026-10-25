/**
 * Offline tests for the `dshp-workflow` core: document metadata parsing, the
 * filesystem store and the sandboxed script runtime. Fake services stand in for
 * DSH so nothing here starts a child agent, spawns a process or touches the
 * network; the store and file hooks use temporary directories only.
 *
 * Run: node tools/test-workflow.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  WorkflowSpecError,
  assertCapabilities,
  buildDocument,
  isWorkflowId,
  normalizeMeta,
  parseWorkflowDocument,
} from '../plugins/dshp-workflow/lib/meta.js'
import { WorkflowStoreError, createWorkflowStore, resolveHomeDir } from '../plugins/dshp-workflow/lib/store.js'
import {
  WorkflowRunError,
  callKey,
  canonicalJson,
  executeWorkflow,
  isJsonValue,
} from '../plugins/dshp-workflow/lib/runtime.js'

let passed = 0
let failed = 0
const failures = []
const tempDirs = []

async function test(label, fn) {
  try {
    await fn()
    passed++
    console.log(`PASS  ${label}`)
  } catch (error) {
    failed++
    failures.push({ label, error })
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function makeTempDir(prefix = 'dshps-workflow-test-') {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

/** Assert that an async call rejects with a typed error code. */
async function throwsCode(fn, code) {
  try {
    await fn()
  } catch (error) {
    const actual = error !== null && typeof error === 'object' ? error.code : undefined
    assert.equal(actual, code, `expected error code ${code}, got ${String(actual)} (${error instanceof Error ? error.message : String(error)})`)
    return error
  }
  assert.fail(`expected a failure with code ${code}`)
}

function assertRunError(result, code) {
  assert.equal(result.stopReason, 'error', `expected an error run, got ${result.stopReason}`)
  assert.equal(result.error?.code, code, `expected run error ${code}, got ${result.error?.code} (${result.error?.message})`)
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

async function makeWorkspace() {
  const dir = await makeTempDir('dshps-workflow-ws-')
  await mkdir(join(dir, 'notes'), { recursive: true })
  await mkdir(join(dir, 'nested', 'deep'), { recursive: true })
  await writeFile(join(dir, 'README.md'), '# test workspace\nhello world\nsecond line\n')
  await writeFile(join(dir, 'notes', 'a.txt'), 'alpha grep-me\nbeta\n')
  await writeFile(join(dir, 'notes', 'b.txt'), 'gamma grep-me\n')
  await writeFile(join(dir, 'nested', 'deep', 'c.txt'), 'deep grep-me\n')
  return dir
}

/**
 * Fake DSH services. File services operate on a real temporary workspace;
 * agent and command services are scripted by the caller.
 */
function createFakeServices(workspaceRoot, options = {}) {
  const calls = { agents: [], commands: [], reads: [], lists: [], stats: [] }
  const services = {
    workspaceRoot,
    sessionId: 'test-session',
    calls,
    async startAgent(spec) {
      calls.agents.push(spec)
      if (typeof options.startAgent === 'function') return options.startAgent(spec, services)
      return { stopReason: 'completed', text: `text:${spec.prompt}`, childId: `child-${calls.agents.length}` }
    },
    async runCommand(spec) {
      calls.commands.push(spec)
      if (typeof options.runCommand === 'function') return options.runCommand(spec, services)
      return { exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: '', stderr: '' }
    },
    resolvePath(input) {
      if (typeof input !== 'string' || input.length === 0) throw new WorkflowRunError('WF_ARGUMENT_INVALID', 'path must be a non-empty string')
      const absolute = resolve(workspaceRoot, input)
      const relativePath = relative(workspaceRoot, absolute)
      if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
        throw new WorkflowRunError('WF_PATH_OUTSIDE', `path is outside the workspace: ${input}`)
      }
      return absolute
    },
    async readTextFile(filePath) {
      calls.reads.push(filePath)
      return readFile(filePath, 'utf8')
    },
    async listDir(directory) {
      calls.lists.push(directory)
      const entries = await readdir(directory, { withFileTypes: true })
      return entries.map((entry) => ({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }))
    },
    async statFile(filePath) {
      calls.stats.push(filePath)
      try {
        const info = await stat(filePath)
        return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined
        throw error
      }
    },
    logger: { info() {}, warn() {} },
  }
  return services
}

function makeCallbacks() {
  const events = []
  const agentCalls = []
  const observations = []
  return {
    events,
    agentCalls,
    observations,
    async onEvent(event) {
      await Promise.resolve()
      events.push(event)
    },
    async onAgentCall(record) {
      await Promise.resolve()
      agentCalls.push(record)
    },
    async onObservation(record) {
      await Promise.resolve()
      observations.push(record)
    },
  }
}

/**
 * Run one ad-hoc document through the runtime with fake services.
 * @returns {Promise<{ result: object, callbacks: object, services: object, workspace: string }>}
 */
async function runDoc(meta, body, options = {}) {
  const workspace = options.workspace ?? await makeWorkspace()
  const services = options.services ?? createFakeServices(workspace, options.serviceOptions)
  const callbacks = options.callbacks ?? makeCallbacks()
  const document = buildDocument({
    id: 'test-flow',
    name: 'Test flow',
    description: 'Offline test workflow',
    ...meta,
  }, body)
  const result = await executeWorkflow({
    document,
    args: options.args,
    config: options.config ?? {},
    services,
    cache: options.cache,
    cachePolicy: options.cachePolicy ?? 'none',
    signal: options.signal,
    onEvent: callbacks.onEvent,
    onAgentCall: callbacks.onAgentCall,
    onObservation: callbacks.onObservation,
  })
  return { result, callbacks, services, workspace }
}

function eventTypes(callbacks) {
  return callbacks.events.map((event) => event.type)
}

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

await test('meta: parseWorkflowDocument strips the block and normalises meta', async () => {
  const text = `/* @dshp-workflow
{
  "id": "review-changed",
  "name": "Review changed files",
  "description": "Review every changed file.",
  "whenToUse": "Use for a PR-sized review.",
  "capabilities": ["orchestrate", "observe"],
  "phases": [{ "title": "Collect changed files" }, { "title": "Review", "detail": "one agent per file" }]
}
*/
phase("Collect changed files")
return { ok: true }
`
  const { meta, body } = parseWorkflowDocument(text)
  assert.deepEqual(meta, {
    id: 'review-changed',
    name: 'Review changed files',
    description: 'Review every changed file.',
    whenToUse: 'Use for a PR-sized review.',
    capabilities: ['orchestrate', 'observe'],
    phases: [{ title: 'Collect changed files' }, { title: 'Review', detail: 'one agent per file' }],
  })
  assert.ok(body.startsWith('phase("Collect changed files")'))
  assert.ok(!body.includes('@dshp-workflow'))
})

await test('meta: orchestrate is implied and capability order is canonical', async () => {
  const meta = normalizeMeta({ id: 'test-flow', name: 'Flow', description: 'Desc', capabilities: ['execute', 'observe', 'observe'] })
  assert.deepEqual(meta.capabilities, ['orchestrate', 'observe', 'execute'])
  assert.deepEqual(meta.phases, [])
  assert.equal(isWorkflowId(meta.id), true)
})

await test('meta: id falls back to the saved filename stem', async () => {
  const text = '/* @dshp-workflow\n{ "name": "Flow", "description": "Desc" }\n*/\nreturn 1\n'
  const { meta } = parseWorkflowDocument(text, 'saved-flow')
  assert.equal(meta.id, 'saved-flow')
  await throwsCode(() => Promise.resolve(parseWorkflowDocument(text)), 'WF_META_INVALID')
  await throwsCode(() => Promise.resolve(parseWorkflowDocument(text, 'Bad Id')), 'WF_META_INVALID')
})

await test('meta: a document without the metadata block is rejected', async () => {
  const error = await throwsCode(() => Promise.resolve(parseWorkflowDocument('return { ok: true }\n')), 'WF_META_INVALID')
  assert.ok(error instanceof WorkflowSpecError)
})

await test('meta: malformed metadata JSON is WF_META_JSON', async () => {
  await throwsCode(() => Promise.resolve(parseWorkflowDocument('/* @dshp-workflow\n{ nope }\n*/\nreturn 1\n')), 'WF_META_JSON')
})

await test('meta: unknown capabilities and metadata fields are rejected', async () => {
  const text = (meta) => `/* @dshp-workflow\n${JSON.stringify(meta)}\n*/\nreturn 1\n`
  const base = { id: 'test-flow', name: 'Flow', description: 'Desc' }
  await throwsCode(() => Promise.resolve(parseWorkflowDocument(text({ ...base, capabilities: ['root'] }))), 'WF_CAPABILITY_INVALID')
  await throwsCode(() => Promise.resolve(parseWorkflowDocument(text({ ...base, capabilities: 'observe' }))), 'WF_CAPABILITY_INVALID')
  await throwsCode(() => Promise.resolve(parseWorkflowDocument(text({ ...base, unknown: true }))), 'WF_META_INVALID')
  await throwsCode(() => Promise.resolve(parseWorkflowDocument(text({ id: 'Bad_Id', name: 'Flow', description: 'Desc' }))), 'WF_META_INVALID')
  await throwsCode(() => Promise.resolve(parseWorkflowDocument(text({ id: 'test-flow', name: '', description: 'Desc' }))), 'WF_META_INVALID')
  await throwsCode(() => Promise.resolve(parseWorkflowDocument(text({ id: 'test-flow', name: 'Flow', description: 'Desc', phases: [{ title: 'x', provider: 'p' }] }))), 'WF_META_INVALID')
})

await test('meta: buildDocument normalises ad-hoc metadata and rejects bad bodies', async () => {
  const document = buildDocument({ id: 'adhoc-flow', name: 'Ad hoc', description: 'desc', capabilities: ['observe'] }, 'return args\n')
  assert.equal(document.meta.id, 'adhoc-flow')
  assert.deepEqual(document.meta.capabilities, ['orchestrate', 'observe'])
  assert.equal(document.body, 'return args\n')
  await throwsCode(() => Promise.resolve(buildDocument({ name: 'Ad hoc', description: 'desc' }, 'return 1\n')), 'WF_META_INVALID')
  await throwsCode(() => Promise.resolve(buildDocument({ id: 'adhoc-flow', name: 'Ad hoc', description: 'desc' }, '   ')), 'WF_META_INVALID')
})

await test('meta: assertCapabilities gates observe and execute', async () => {
  const observeMeta = normalizeMeta({ id: 'test-flow', name: 'Flow', description: 'Desc', capabilities: ['observe'] })
  assertCapabilities(observeMeta, { allowObserve: true })
  await throwsCode(() => Promise.resolve(assertCapabilities(observeMeta, { allowObserve: false })), 'WF_CAPABILITY_DENIED')
  await throwsCode(() => Promise.resolve(assertCapabilities(observeMeta, {})), 'WF_CAPABILITY_DENIED')
  const executeMeta = normalizeMeta({ id: 'test-flow', name: 'Flow', description: 'Desc', capabilities: ['execute'] })
  assertCapabilities(executeMeta, { allowExecute: true })
  await throwsCode(() => Promise.resolve(assertCapabilities(executeMeta, { allowObserve: true })), 'WF_CAPABILITY_DENIED')
  const orchestrateMeta = normalizeMeta({ id: 'test-flow', name: 'Flow', description: 'Desc' })
  assertCapabilities(orchestrateMeta, {})
})

/* ------------------------------------------------------------------ */
/* Store                                                               */
/* ------------------------------------------------------------------ */

const FLOW_DOC = `/* @dshp-workflow
{ "id": "saved-flow", "name": "Saved flow", "description": "A saved test workflow", "capabilities": ["orchestrate"] }
*/
return { ok: true }
`

await test('store: resolveHomeDir honours DSH_HOME and falls back to ~/.dsh', async () => {
  const configured = resolveHomeDir({ DSH_HOME: join(tmpdir(), 'fake-dsh-home') })
  assert.equal(configured, resolve(join(tmpdir(), 'fake-dsh-home')))
  const fallback = resolveHomeDir({})
  assert.equal(fallback.endsWith(join('.dsh')), true)
})

await test('store: paths and ensure create the documented layout', async () => {
  const homeDir = await makeTempDir()
  const store = createWorkflowStore({ homeDir })
  const paths = store.paths()
  assert.equal(paths.rootDir, join(homeDir, 'dshps', 'workflow'))
  assert.equal(paths.workflowsDir, join(paths.rootDir, 'workflows'))
  assert.equal(paths.runsDir, join(paths.rootDir, 'runs'))
  await store.ensure()
  assert.equal((await stat(paths.workflowsDir)).isDirectory(), true)
  assert.equal((await stat(paths.runsDir)).isDirectory(), true)
  assert.deepEqual(await store.listWorkflows(), [])
})

await test('store: save/list/read/delete a global workflow', async () => {
  const homeDir = await makeTempDir()
  const store = createWorkflowStore({ homeDir })
  const saved = await store.saveWorkflow({ id: 'saved-flow', text: FLOW_DOC })
  assert.deepEqual(saved, { id: 'saved-flow', scope: 'global' })
  const listed = await store.listWorkflows()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].id, 'saved-flow')
  assert.equal(listed[0].scope, 'global')
  assert.equal(listed[0].name, 'Saved flow')
  assert.deepEqual(listed[0].capabilities, ['orchestrate'])
  assert.equal(typeof listed[0].updatedAt, 'number')
  assert.ok(listed[0].bytes > 0)
  const read = await store.readWorkflow({ id: 'saved-flow' })
  assert.equal(read.scope, 'global')
  assert.equal(read.text, FLOW_DOC)
  assert.equal(read.meta.name, 'Saved flow')
  assert.deepEqual(await store.deleteWorkflow({ id: 'saved-flow' }), { deleted: true })
  assert.deepEqual(await store.deleteWorkflow({ id: 'saved-flow' }), { deleted: false })
  await throwsCode(() => store.readWorkflow({ id: 'saved-flow' }), 'WF_WORKFLOW_NOT_FOUND')
})

await test('store: project workflows shadow global workflows with the same id', async () => {
  const homeDir = await makeTempDir()
  const projectRoot = await makeTempDir('dshps-workflow-project-')
  const projectDir = join(projectRoot, '.dshps', 'workflows')
  const store = createWorkflowStore({ homeDir })
  const globalDoc = FLOW_DOC
  const projectDoc = `/* @dshp-workflow
{ "id": "saved-flow", "name": "Project flow", "description": "Project copy", "capabilities": ["orchestrate", "observe"] }
*/
return { project: true }
`
  await store.saveWorkflow({ id: 'saved-flow', text: globalDoc })
  await store.saveWorkflow({ id: 'saved-flow', scope: 'project', projectDir, text: projectDoc })
  assert.equal((await stat(join(projectDir, 'saved-flow.js'))).isFile(), true)
  const listed = await store.listWorkflows({ projectDir })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].scope, 'project')
  assert.equal(listed[0].name, 'Project flow')
  const readGlobal = await store.readWorkflow({ id: 'saved-flow' })
  assert.equal(readGlobal.meta.name, 'Saved flow')
  const readProject = await store.readWorkflow({ id: 'saved-flow', scope: 'project', projectDir })
  assert.equal(readProject.meta.name, 'Project flow')
  assert.deepEqual(await store.deleteWorkflow({ id: 'saved-flow', scope: 'project', projectDir }), { deleted: true })
  const after = await store.listWorkflows({ projectDir })
  assert.equal(after.length, 1)
  assert.equal(after[0].scope, 'global')
})

await test('store: invalid ids, scopes and documents are rejected on save', async () => {
  const homeDir = await makeTempDir()
  const store = createWorkflowStore({ homeDir })
  const invalidId = await throwsCode(() => store.saveWorkflow({ id: 'Bad_Id', text: FLOW_DOC }), 'WF_ID_INVALID')
  assert.ok(invalidId instanceof WorkflowStoreError)
  await throwsCode(() => store.saveWorkflow({ id: 'saved-flow', scope: 'galaxy', text: FLOW_DOC }), 'WF_SCOPE_INVALID')
  await throwsCode(() => store.saveWorkflow({ id: 'saved-flow', scope: 'project', text: FLOW_DOC }), 'WF_PROJECT_REQUIRED')
  await throwsCode(() => store.saveWorkflow({ id: 'saved-flow', text: 'return 1\n' }), 'WF_META_INVALID')
  const mismatched = FLOW_DOC.replaceAll('saved-flow', 'other-flow')
  await throwsCode(() => store.saveWorkflow({ id: 'saved-flow', text: mismatched }), 'WF_META_INVALID')
  assert.equal((await store.listWorkflows()).length, 0)
})

await test('store: run records are created and patched atomically', async () => {
  const homeDir = await makeTempDir()
  const store = createWorkflowStore({ homeDir })
  const run = await store.createRun({
    workflowId: 'saved-flow',
    scope: 'global',
    name: 'Saved flow',
    meta: { id: 'saved-flow', name: 'Saved flow' },
    scriptHash: 'deadbeef',
    args: { files: ['a'] },
    sessionId: 'session-test',
    cwd: join(homeDir, 'workspace'),
  })
  assert.match(run.id, /^wf-[a-z0-9]+-[0-9a-f]{6}$/)
  assert.equal(run.status, 'running')
  assert.equal(run.scriptHash, 'deadbeef')
  assert.deepEqual(run.args, { files: ['a'] })
  assert.deepEqual(run.usage, { agents: 0, worldRuns: 0, durationMs: 0 })
  assert.deepEqual(run.phases, [])
  assert.deepEqual(run.agents, [])
  const updated = await store.updateRun(run.id, {
    status: 'completed',
    stopReason: 'completed',
    endedAt: run.startedAt + 5,
    usage: { agents: 1, worldRuns: 0, durationMs: 5 },
  })
  assert.equal(updated.status, 'completed')
  assert.equal(updated.startedAt, run.startedAt)
  const reread = await store.readRun(run.id)
  assert.equal(reread.status, 'completed')
  assert.deepEqual(reread.usage, { agents: 1, worldRuns: 0, durationMs: 5 })
  const runDir = join(store.paths().runsDir, run.id)
  const files = await readdir(runDir)
  assert.deepEqual(files.sort(), ['run.json'])
  assert.equal(JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8')).status, 'completed')
  await throwsCode(() => store.updateRun('wf-nope-abcdef', { status: 'completed' }), 'WF_RUN_NOT_FOUND')
  await throwsCode(() => store.readRun('not-a-run-id'), 'WF_ID_INVALID')
})

await test('store: artifacts are written, listed and read back', async () => {
  const homeDir = await makeTempDir()
  const store = createWorkflowStore({ homeDir })
  const run = await store.createRun({ workflowId: 'saved-flow', name: 'Saved flow' })
  const markdown = await store.addArtifact(run.id, { name: 'Summary', kind: 'markdown', content: '# summary\n' })
  assert.match(markdown.id, /^art-[a-z0-9]+-[0-9a-f]{6}$/)
  assert.ok(markdown.path.endsWith('.md'))
  assert.equal(markdown.name, 'Summary')
  assert.equal(markdown.kind, 'markdown')
  const plain = await store.addArtifact(run.id, { name: 'Raw copy', kind: 'file', content: 'raw text' })
  assert.ok(plain.path.endsWith('.txt'))
  assert.equal(plain.kind, 'file')
  const read = await store.readArtifact(run.id, markdown.id)
  assert.equal(read.name, 'Summary')
  assert.equal(read.kind, 'markdown')
  assert.equal(read.content, '# summary\n')
  assert.equal(read.path, markdown.path)
  const record = await store.readRun(run.id)
  assert.equal(record.artifacts.length, 2)
  assert.equal(record.artifacts[0].name, 'Summary')
  assert.equal(record.artifacts[0].bytes, 10)
  // A caller that projects only `{ id, path }` back into the run record must
  // still be able to read file-kind artifacts (extension probing fallback).
  await store.updateRun(run.id, { artifacts: [{ id: plain.id }] })
  const probed = await store.readArtifact(run.id, plain.id)
  assert.equal(probed.kind, 'file')
  assert.equal(probed.content, 'raw text')
  await throwsCode(() => store.addArtifact(run.id, { name: 'Bad', kind: 'binary', content: 'x' }), 'WF_ARTIFACT_INVALID')
  await throwsCode(() => store.readArtifact(run.id, 'art-nope-abcdef'), 'WF_ARTIFACT_NOT_FOUND')
})

await test('store: listRuns is newest-first and pruneRuns skips running runs', async () => {
  const homeDir = await makeTempDir()
  const clock = { value: 1000 }
  const store = createWorkflowStore({ homeDir, now: () => clock.value })
  const older = await store.createRun({ workflowId: 'saved-flow', name: 'Older' })
  clock.value = 2000
  const newer = await store.createRun({ workflowId: 'saved-flow', name: 'Newer' })
  clock.value = 2001
  const running = await store.createRun({ workflowId: 'saved-flow', name: 'Running' })
  let runs = await store.listRuns()
  assert.deepEqual(runs.map((run) => run.id), [running.id, newer.id, older.id])
  assert.equal(runs[0].status, 'running')
  assert.equal(runs[0].agents, 0)
  await store.updateRun(older.id, { status: 'completed', endedAt: 1001, agents: [{ seq: 1, status: 'completed', cached: false }] })
  await store.updateRun(newer.id, { status: 'failed', endedAt: 2002 })
  runs = await store.listRuns()
  assert.equal(runs.find((run) => run.id === older.id).agentsStarted, 1)
  assert.equal(runs.find((run) => run.id === older.id).agents, 1)
  clock.value = 1_000_000
  const deleted = await store.pruneRuns({ olderThanMs: 500 })
  assert.equal(deleted, 2)
  runs = await store.listRuns()
  assert.deepEqual(runs.map((run) => run.id), [running.id])
  await throwsCode(() => store.pruneRuns({ olderThanMs: 0 }), 'WF_STORE_INVALID')
})

/* ------------------------------------------------------------------ */
/* Runtime helpers                                                     */
/* ------------------------------------------------------------------ */

await test('runtime: canonicalJson is stable and callKey hashes canonical calls', async () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, 4] } }), '{"a":{"c":[3,4],"d":2},"b":1}')
  assert.equal(callKey({ prompt: 'same' }), callKey({ prompt: 'same', provider: undefined }))
  assert.notEqual(callKey({ prompt: 'same' }), callKey({ prompt: 'same', model: 'm' }))
  assert.notEqual(callKey({ prompt: 'same' }), callKey({ prompt: 'same', reasoningEffort: 'high' }))
  assert.notEqual(callKey({ prompt: 'same' }), callKey({ prompt: 'same', maxTokens: 100 }))
  assert.equal(callKey({ prompt: 'same', reasoningEffort: 'high', maxTokens: 100 }), callKey({ prompt: 'same', maxTokens: 100, reasoningEffort: 'high' }))
  assert.notEqual(callKey({ prompt: 'same', args: { x: 1 } }), callKey({ prompt: 'same', args: { x: 2 } }))
  assert.match(callKey({ prompt: 'same' }), /^[0-9a-f]{64}$/)
  await throwsCode(() => Promise.resolve(callKey({ prompt: '' })), 'WF_ARGUMENT_INVALID')
})

await test('runtime: cache keys include run args and effective child defaults', async () => {
  const body = `await agent('same prompt')\nreturn 1\n`
  const first = await runDoc({ capabilities: ['orchestrate'] }, body, { args: { mode: 'a' }, config: { defaultModel: 'model-a' } })
  const second = await runDoc({ capabilities: ['orchestrate'] }, body, { args: { mode: 'b' }, config: { defaultModel: 'model-a' } })
  const third = await runDoc({ capabilities: ['orchestrate'] }, body, { args: { mode: 'a' }, config: { defaultModel: 'model-b' } })
  const keyOf = (run) => run.callbacks.agentCalls[0].key
  assert.notEqual(keyOf(first), keyOf(second), 'args are part of the replay key')
  assert.notEqual(keyOf(first), keyOf(third), 'effective default model is part of the replay key')
})

await test('runtime: isJsonValue rejects lossy values but accepts plain JSON', async () => {
  assert.equal(isJsonValue({ a: [1, 'x', null, true] }), true)
  assert.equal(isJsonValue(null), true)
  assert.equal(isJsonValue(1), true)
  assert.equal(isJsonValue(undefined), false)
  assert.equal(isJsonValue(Number.NaN), false)
  assert.equal(isJsonValue(Number.POSITIVE_INFINITY), false)
  assert.equal(isJsonValue(-0), false)
  assert.equal(isJsonValue(1n), false)
  assert.equal(isJsonValue(Symbol('token')), false)
  assert.equal(isJsonValue({ nested: undefined }), false)
  assert.equal(isJsonValue({ fn() {} }), false)
  assert.equal(isJsonValue(new Date()), false)
  const cyclic = {}
  cyclic.self = cyclic
  assert.equal(isJsonValue(cyclic), false)
  assert.equal(isJsonValue([, 1]), false)
  const symbolKeyed = { a: 1 }
  symbolKeyed[Symbol('hidden')] = 2
  assert.equal(isJsonValue(symbolKeyed), false)
  let getterRead = false
  const withGetter = {}
  Object.defineProperty(withGetter, 'value', {
    enumerable: true,
    get() {
      getterRead = true
      return 1
    },
  })
  assert.equal(isJsonValue(withGetter), false)
  assert.equal(getterRead, false, 'validation inspects descriptors instead of invoking getters')
  assert.equal(isJsonValue(Object.assign(Object.create({ inherited: true }), { own: 1 })), false)
})

/* ------------------------------------------------------------------ */
/* Runtime: agents and combinators                                     */
/* ------------------------------------------------------------------ */

await test('runtime: agent returns child text and journals each call', async () => {
  const body = `const first = await agent('first task')
const second = await agent('second task', { label: 'Second', provider: 'test-provider', model: 'test-model' })
return { first, second }
`
  const { result, callbacks, services } = await runDoc({ capabilities: ['orchestrate'] }, body)
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value, { first: 'text:first task', second: 'text:second task' })
  assert.equal(result.agentsStarted, 2)
  assert.equal(result.usage.agents, 2)
  assert.equal(result.usage.worldRuns, 0)
  assert.equal(typeof result.usage.durationMs, 'number')
  assert.equal(services.calls.agents.length, 2)
  assert.equal(callbacks.agentCalls.length, 2)
  const [first, second] = callbacks.agentCalls
  assert.equal(first.seq, 1)
  assert.equal(first.key, callKey({ prompt: 'first task', args: null, sessionId: 'test-session', cwd: services.workspaceRoot }))
  assert.equal(first.status, 'completed')
  assert.equal(first.outputText, 'text:first task')
  assert.equal(first.cached, false)
  assert.equal(second.seq, 2)
  assert.equal(second.key, callKey({
    prompt: 'second task',
    args: null,
    sessionId: 'test-session',
    cwd: services.workspaceRoot,
    provider: 'test-provider',
    model: 'test-model',
  }))
  assert.equal(typeof first.startedAt, 'number')
  assert.equal(typeof first.endedAt, 'number')
  assert.deepEqual(eventTypes(callbacks), ['agent-start', 'agent-end', 'agent-start', 'agent-end'])
  assert.equal(callbacks.events[1].status, 'completed')
  assert.equal(callbacks.events[1].cached, false)
})

await test('runtime: agent returns a validated structured value when a schema is set', async () => {
  const schema = {
    type: 'object',
    properties: {
      count: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['count', 'tags'],
    additionalProperties: false,
  }
  const body = `const value = await agent('count things', { schema: ${JSON.stringify(schema)} })
return { value }
`
  const { result, callbacks } = await runDoc({ capabilities: ['orchestrate'] }, body, {
    serviceOptions: {
      startAgent: async (spec) => ({ stopReason: 'completed', text: 'ignored', structured: { count: 2, tags: ['a', 'b'] }, childId: 'child-structured' }),
    },
  })
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value, { value: { count: 2, tags: ['a', 'b'] } })
  assert.deepEqual(callbacks.agentCalls[0].structured, { count: 2, tags: ['a', 'b'] })
  assert.equal(callbacks.agentCalls[0].childId, 'child-structured')
})

await test('runtime: ordinary child failure resolves agent() to null', async () => {
  const body = `const value = await agent('failing child')
return { value }
`
  const { result, callbacks } = await runDoc({ capabilities: ['orchestrate'] }, body, {
    serviceOptions: {
      startAgent: async () => ({ stopReason: 'failed', text: 'partial output', childId: 'child-failed' }),
    },
  })
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value, { value: null })
  assert.equal(result.agentsStarted, 0)
  assert.equal(callbacks.agentCalls[0].status, 'failed')
  assert.equal(callbacks.events[1].status, 'failed')
})

await test('runtime: a schema outside the subset fails before any child starts', async () => {
  const body = `await agent('bad schema', { schema: { type: 'object', properties: { when: { type: 'date' } } } })
return 1
`
  const { result, services } = await runDoc({ capabilities: ['orchestrate'] }, body)
  assertRunError(result, 'WF_SCHEMA_INVALID')
  assert.equal(services.calls.agents.length, 0)
  assert.equal(result.agentsStarted, 0)
})

await test('runtime: unknown agent options fail loudly', async () => {
  const { result } = await runDoc({ capabilities: ['orchestrate'] }, `await agent('x', { effort: 'high' })\nreturn 1\n`)
  assertRunError(result, 'WF_ARGUMENT_INVALID')
})

await test('runtime: parallel maps throwing thunks to null', async () => {
  const body = `const values = await parallel([
  async () => 1,
  async () => { throw new Error('boom') },
  () => 3,
])
return { values }
`
  const { result } = await runDoc({ capabilities: ['orchestrate'] }, body)
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value, { values: [1, null, 3] })
})

await test('runtime: pipeline drops failing items and skips remaining stages', async () => {
  const body = `const values = await pipeline([1, 2, 3],
  async (value) => { if (value === 2) throw new Error('skip'); return value * 10 },
  async (value) => value + 1,
)
return values
`
  const { result } = await runDoc({ capabilities: ['orchestrate'] }, body)
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value, [11, null, 31])
})

await test('runtime: combinators propagate fatal hook misuse instead of nulling the item', async () => {
  const body = `const values = await parallel([async () => { await agent('') }])
return values
`
  const { result, services } = await runDoc({ capabilities: ['orchestrate'] }, body)
  assertRunError(result, 'WF_ARGUMENT_INVALID')
  assert.equal(services.calls.agents.length, 0)
})

/* ------------------------------------------------------------------ */
/* Runtime: phases, logs, reports, artifacts                           */
/* ------------------------------------------------------------------ */

await test('runtime: phase, log, report and artifact hooks are journaled', async () => {
  const body = `phase('Collect')
log('starting')
await agent('one')
report({ step: 1 }, 'progress')
artifact.markdown('Summary', '# hello')
artifact.table('Rows', ['name', 'value'], [['alpha', 1], ['beta', 2]])
await artifact.file('Copy', 'notes/a.txt')
return { done: true }
`
  const { result, callbacks } = await runDoc({ capabilities: ['orchestrate', 'observe'] }, body)
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value, { done: true })
  const types = eventTypes(callbacks)
  assert.ok(types.includes('phase'))
  assert.ok(types.includes('log'))
  assert.ok(types.includes('report'))
  assert.equal(types.filter((type) => type === 'artifact').length, 3)
  const phaseEvent = callbacks.events.find((event) => event.type === 'phase')
  assert.equal(phaseEvent.title, 'Collect')
  assert.equal(typeof phaseEvent.at, 'number')
  const logEvent = callbacks.events.find((event) => event.type === 'log')
  assert.equal(logEvent.message, 'starting')
  assert.deepEqual(result.reports, [{ item: { step: 1 }, tag: 'progress', seq: 1 }])
  assert.equal(result.artifacts.length, 3)
  assert.deepEqual(result.artifacts[0], { name: 'Summary', kind: 'markdown', content: '# hello' })
  const table = result.artifacts[1]
  assert.equal(table.kind, 'table')
  assert.ok(table.content.startsWith('| name | value |'))
  assert.ok(table.content.includes('| alpha | 1 |'))
  assert.deepEqual(result.artifacts[2], { name: 'Copy', kind: 'file', content: 'alpha grep-me\nbeta\n' })
  const artifactEvent = callbacks.events.find((event) => event.type === 'artifact')
  assert.equal(artifactEvent.seq, 1)
  assert.equal(artifactEvent.name, 'Summary')
})

await test('runtime: artifact hooks return provisional handles', async () => {
  const body = `const handle = artifact.markdown('Summary', 'body')
return handle
`
  const { result } = await runDoc({ capabilities: ['orchestrate'] }, body)
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.value.id, 'pending-1')
  assert.equal(result.value.path, '')
})

/* ------------------------------------------------------------------ */
/* Runtime: file and git observations                                  */
/* ------------------------------------------------------------------ */

await test('runtime: files.glob, files.read and files.grep are workspace-bound', async () => {
  const body = `const globbed = await files.glob('**/*.txt')
const read = await files.read('README.md', { offset: 1, limit: 2 })
const matches = await files.grep('grep-me', { glob: 'notes/*.txt' })
return { globbed, read, matches }
`
  const { result, callbacks } = await runDoc({ capabilities: ['orchestrate', 'observe'] }, body)
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value.globbed, ['nested/deep/c.txt', 'notes/a.txt', 'notes/b.txt'])
  assert.equal(result.value.read, 'hello world\nsecond line')
  assert.deepEqual(result.value.matches, [
    { path: 'notes/a.txt', line: 1, text: 'alpha grep-me' },
    { path: 'notes/b.txt', line: 1, text: 'gamma grep-me' },
  ])
  assert.equal(callbacks.observations.length, 3)
  assert.deepEqual(callbacks.observations.map((record) => record.kind), ['files.glob', 'files.read', 'files.grep'])
  assert.match(callbacks.observations[0].key, /^[0-9a-f]{64}$/)
  assert.equal(typeof callbacks.observations[0].at, 'number')
})

await test('runtime: file hooks fail outside the workspace', async () => {
  const readOutside = await runDoc({ capabilities: ['observe'] }, `await files.read('../escape.txt')\nreturn 1\n`)
  assertRunError(readOutside.result, 'WF_PATH_OUTSIDE')
  const globOutside = await runDoc({ capabilities: ['observe'] }, `await files.glob('../*.txt')\nreturn 1\n`)
  assertRunError(globOutside.result, 'WF_PATH_OUTSIDE')
})

await test('runtime: git hooks run read-only git in the workspace root', async () => {
  const services = () => createFakeServices('/tmp/fake-workspace', {
    runCommand: async (spec) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      stdout: spec.argv[1] === 'status' ? ' M notes/a.txt\n' : 'notes/a.txt\nnotes/b.txt\n',
      stderr: '',
    }),
  })
  const body = `const status = await git.status()
const changed = await git.changedFiles('origin/main')
return { status, changed }
`
  const { result, services: fake } = await runDoc({ capabilities: ['orchestrate', 'observe'] }, body, { services: services() })
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value, { status: ' M notes/a.txt', changed: ['notes/a.txt', 'notes/b.txt'] })
  assert.equal(fake.calls.commands.length, 2)
  assert.deepEqual(fake.calls.commands[0].argv, ['git', 'status', '--porcelain=v1'])
  assert.deepEqual(fake.calls.commands[1].argv, ['git', 'diff', '--name-only', 'origin/main', '--'])
  assert.equal(fake.calls.commands[0].cwd, '/tmp/fake-workspace')
})

await test('runtime: git failures fail the hook loudly', async () => {
  const { result } = await runDoc({ capabilities: ['observe'] }, `await git.status()\nreturn 1\n`, {
    serviceOptions: {
      runCommand: async () => ({ exitCode: 128, signal: null, timedOut: false, aborted: false, stdout: '', stderr: 'not a git repository' }),
    },
  })
  assertRunError(result, 'WF_SCRIPT_ERROR')
  assert.ok(result.error.message.includes('not a git repository'))
})

await test('runtime: git ref arguments cannot be parsed as git options', async () => {
  const diff = await runDoc({ capabilities: ['observe'] }, `await git.diff(undefined, '--output=/tmp/pwn')\nreturn 1\n`)
  assertRunError(diff.result, 'WF_ARGUMENT_INVALID')
  const changed = await runDoc({ capabilities: ['observe'] }, `await git.changedFiles('-c core.pager=cat')\nreturn 1\n`)
  assertRunError(changed.result, 'WF_ARGUMENT_INVALID')
})

await test('runtime: scripts cannot forge host WF_ error codes', async () => {
  const { result } = await runDoc({ capabilities: ['orchestrate'] }, `throw { code: 'WF_CANCELLED', message: 'forged' }\n`)
  assert.equal(result.stopReason, 'error')
  assert.equal(result.error.code, 'WF_SCRIPT_ERROR')
})

/* ------------------------------------------------------------------ */
/* Runtime: capabilities and world.run                                 */
/* ------------------------------------------------------------------ */

await test('runtime: hooks that need a missing capability are denied', async () => {
  const filesDenied = await runDoc({ capabilities: ['orchestrate'] }, `await files.glob('**/*')\nreturn 1\n`)
  assertRunError(filesDenied.result, 'WF_CAPABILITY_DENIED')
  const worldDenied = await runDoc({ capabilities: ['orchestrate'] }, `await world.run('git', ['status'])\nreturn 1\n`)
  assertRunError(worldDenied.result, 'WF_CAPABILITY_DENIED')
})

await test('runtime: world.run enforces the command allowlist and blockedCommands', async () => {
  const denied = await runDoc(
    { capabilities: ['execute'] },
    `await world.run('node', ['-v'])\nreturn 1\n`,
    { config: { allowedCommands: ['git'] } },
  )
  assertRunError(denied.result, 'WF_COMMAND_DENIED')
  const blocked = await runDoc(
    { capabilities: ['execute'] },
    `await world.run('git', ['status'])\nreturn 1\n`,
    { config: { allowedCommands: ['git'], blockedCommands: ['git'] } },
  )
  assertRunError(blocked.result, 'WF_COMMAND_DENIED')
  const outside = await runDoc(
    { capabilities: ['execute'] },
    `await world.run('git', [], { cwd: '../outside' })\nreturn 1\n`,
    { config: { allowedCommands: ['git'] } },
  )
  assertRunError(outside.result, 'WF_PATH_OUTSIDE')
})

await test('runtime: fatal command denial inside a combinator propagates instead of nulling', async () => {
  const { result } = await runDoc(
    { capabilities: ['execute'] },
    `const values = await parallel([async () => world.run('git', ['status'])])
return { values }
`,
    { config: { allowedCommands: [] } },
  )
  assertRunError(result, 'WF_COMMAND_DENIED')
})

await test('runtime: world.run spawns the exact argv and normalises the result', async () => {
  const body = `const result = await world.run('git', ['status', '--short'])
return result
`
  const { result, services } = await runDoc({ capabilities: ['execute'] }, body, {
    config: { allowedCommands: ['git'] },
    serviceOptions: {
      runCommand: async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        stdout: 'M notes/a.txt\n',
        stderr: 'warning: test\n',
      }),
    },
  })
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value, {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    stdout: 'M notes/a.txt\n',
    stderr: 'warning: test\n',
  })
  assert.equal(services.calls.commands.length, 1)
  const spec = services.calls.commands[0]
  assert.deepEqual(spec.argv, ['git', 'status', '--short'])
  assert.equal(spec.cwd, services.workspaceRoot)
  assert.equal(spec.timeoutMs, 300000)
  assert.equal(spec.maxBytes, 65536)
  assert.ok(spec.signal instanceof AbortSignal)
  assert.equal(result.usage.worldRuns, 1)
})

await test('runtime: maxWorldRuns 0 denies every world.run', async () => {
  const { result } = await runDoc(
    { capabilities: ['execute'] },
    `await world.run('git', ['status'])\nreturn 1\n`,
    { config: { allowedCommands: ['git'], maxWorldRuns: 0 } },
  )
  assertRunError(result, 'WF_LIMIT')
})

await test('runtime: world.run output above the byte cap is truncated', async () => {
  const { result } = await runDoc({ capabilities: ['execute'] }, `return await world.run('git', [])\n`, {
    config: { allowedCommands: ['git'] },
    serviceOptions: {
      runCommand: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: 'x'.repeat(100000), stderr: '' }),
    },
  })
  assert.equal(result.stopReason, 'completed')
  assert.ok(result.value.stdout.length < 100000)
  assert.ok(result.value.stdout.includes('[truncated]'))
})

/* ------------------------------------------------------------------ */
/* Runtime: budgets, cancellation, JSON rejection                      */
/* ------------------------------------------------------------------ */

await test('runtime: the per-run agent budget trips with WF_BUDGET_EXCEEDED', async () => {
  const { result } = await runDoc(
    { capabilities: ['orchestrate'] },
    `await agent('one')\nawait agent('two')\nreturn 1\n`,
    { config: { maxAgentsPerRun: 1 } },
  )
  assertRunError(result, 'WF_BUDGET_EXCEEDED')
})

await test('runtime: the per-call item budget trips with WF_LIMIT', async () => {
  const { result } = await runDoc(
    { capabilities: ['orchestrate'] },
    `await parallel([1, 2, 3].map((value) => async () => value))\nreturn 1\n`,
    { config: { maxItemsPerCall: 2 } },
  )
  assertRunError(result, 'WF_LIMIT')
})

await test('runtime: the report count budget trips with WF_LIMIT', async () => {
  const { result } = await runDoc(
    { capabilities: ['orchestrate'] },
    `report(1)\nreport(2)\nreturn 1\n`,
    { config: { maxReportItems: 1 } },
  )
  assertRunError(result, 'WF_LIMIT')
})

await test('runtime: maxRunSeconds aborts the run with WF_BUDGET_EXCEEDED', async () => {
  let sawAbort = false
  const { result } = await runDoc(
    { capabilities: ['orchestrate'] },
    `await agent('slow child')\nreturn 1\n`,
    {
      config: { maxRunSeconds: 0.05 },
      serviceOptions: {
        startAgent: (spec) => new Promise((resolveAgent) => {
          spec.signal.addEventListener('abort', () => {
            sawAbort = true
            resolveAgent({ stopReason: 'cancelled', text: '' })
          }, { once: true })
        }),
      },
    },
  )
  assertRunError(result, 'WF_BUDGET_EXCEEDED')
  assert.equal(sawAbort, true)
  assert.equal(result.value, null)
})

await test('runtime: cancellation resolves stopReason cancelled without rejecting', async () => {
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(), 20)
  try {
    const { result } = await runDoc(
      { capabilities: ['orchestrate'] },
      `await agent('slow child')\nreturn 'finished'\n`,
      {
        signal: controller.signal,
        serviceOptions: {
          startAgent: (spec) => new Promise((resolveAgent) => {
            spec.signal.addEventListener('abort', () => resolveAgent({ stopReason: 'cancelled', text: '' }), { once: true })
          }),
        },
      },
    )
    assert.equal(result.stopReason, 'cancelled')
    assert.equal(result.error.code, 'WF_CANCELLED')
    assert.equal(result.value, null)
  } finally {
    clearTimeout(abortTimer)
  }
})

await test('runtime: an already-aborted signal cancels before the script runs', async () => {
  const controller = new AbortController()
  controller.abort()
  const { result, services } = await runDoc({ capabilities: ['orchestrate'] }, `await agent('x')\nreturn 1\n`, { signal: controller.signal })
  assert.equal(result.stopReason, 'cancelled')
  assert.equal(services.calls.agents.length, 0)
})

await test('runtime: cancellation aborts pending child starts and leaves no active activations', async () => {
  const controller = new AbortController()
  const active = new Set()
  const signals = []
  let started = 0
  const running = runDoc(
    { capabilities: ['orchestrate'] },
    `await parallel([async () => agent('one'), async () => agent('two')])
return 1
`,
    {
      signal: controller.signal,
      config: { maxConcurrentAgents: 2 },
      serviceOptions: {
        startAgent: (spec) => {
          started += 1
          active.add(spec)
          signals.push(spec.signal)
          return new Promise((resolve) => {
            spec.signal.addEventListener('abort', () => {
              active.delete(spec)
              resolve({ stopReason: 'cancelled', text: '' })
            }, { once: true })
          })
        },
      },
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.equal(started, 2, 'both children started before cancellation')
  controller.abort()
  const { result } = await running
  assert.equal(result.stopReason, 'cancelled')
  assert.equal(active.size, 0, 'the abort signal disposed every pending activation')
  assert.equal(signals.length, 2)
  assert.equal(signals.every((signal) => signal.aborted), true)
})

await test('runtime: cancellation aborts a live world.run shell', async () => {
  const controller = new AbortController()
  let commandSignal
  const running = runDoc(
    { capabilities: ['execute'] },
    `await world.run('git', ['status'])\nreturn 1\n`,
    {
      signal: controller.signal,
      config: { allowedCommands: ['git'] },
      serviceOptions: {
        runCommand: (spec) => {
          commandSignal = spec.signal
          return new Promise((resolve) => {
            spec.signal.addEventListener('abort', () => resolve({
              exitCode: null,
              signal: 'SIGTERM',
              timedOut: false,
              aborted: true,
              stdout: '',
              stderr: '',
            }), { once: true })
          })
        },
      },
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  controller.abort()
  const { result } = await running
  assert.equal(result.stopReason, 'cancelled')
  assert.equal(commandSignal.aborted, true, 'the shell received an aborted signal')
})

await test('runtime: a dropped child call cannot outlive a completed run', async () => {
  const active = new Set()
  let spec
  const { result, callbacks } = await runDoc(
    { capabilities: ['orchestrate'] },
    `agent('fire and forget')
for (let index = 0; index < 10; index++) await Promise.resolve()
return { ok: true }
`,
    {
      serviceOptions: {
        startAgent: (request) => {
          spec = request
          active.add(request)
          return new Promise((resolve) => {
            request.signal.addEventListener('abort', () => {
              active.delete(request)
              resolve({ stopReason: 'cancelled', text: '' })
            }, { once: true })
          })
        },
      },
    },
  )
  assert.equal(result.stopReason, 'completed')
  assert.ok(spec, 'the dropped child call reached the service')
  assert.equal(spec.signal.aborted, true, 'settling the run aborted the dropped child')
  assert.equal(active.size, 0)
  assert.equal(callbacks.agentCalls.length, 0, 'no journal record is written after settlement')
})

await test('runtime: a non-JSON return value fails with WF_RESULT_INVALID', async () => {
  const cases = [
    `return { bad: () => 1 }`,
    `return { nested: undefined }`,
    `return undefined`,
    `const value = {}; value.self = value; return value`,
    `return { count: Number.NaN }`,
  ]
  for (const script of cases) {
    const { result } = await runDoc({ capabilities: ['orchestrate'] }, `${script}\n`)
    assertRunError(result, 'WF_RESULT_INVALID')
    assert.equal(result.value, null)
  }
})

await test('runtime: strict pure-data validation covers results, reports and args', async () => {
  const getterResult = await runDoc(
    { capabilities: ['orchestrate'] },
    `const value = {}
Object.defineProperty(value, 'hidden', { enumerable: true, get() { return 1 } })
return value
`,
  )
  assertRunError(getterResult.result, 'WF_RESULT_INVALID')

  const bigintResult = await runDoc({ capabilities: ['orchestrate'] }, `return { big: 1n }\n`)
  assertRunError(bigintResult.result, 'WF_RESULT_INVALID')

  const getterReport = await runDoc(
    { capabilities: ['orchestrate'] },
    `const value = {}
Object.defineProperty(value, 'hidden', { enumerable: true, get() { return 1 } })
report(value)
return 1
`,
  )
  assertRunError(getterReport.result, 'WF_ARGUMENT_INVALID')

  const getterArgs = {}
  Object.defineProperty(getterArgs, 'hidden', { enumerable: true, get() { return 1 } })
  const badArgs = await runDoc({ capabilities: ['orchestrate'] }, `return args\n`, { args: getterArgs })
  assertRunError(badArgs.result, 'WF_ARGUMENT_INVALID')

  const symbolResult = await runDoc({ capabilities: ['orchestrate'] }, `return { value: Symbol('x') }\n`)
  assertRunError(symbolResult.result, 'WF_RESULT_INVALID')
})

await test('runtime: artifact and report/log byte caps fail the run with WF_LIMIT', async () => {
  const artifactCount = await runDoc(
    { capabilities: ['orchestrate'] },
    `artifact.markdown('a', 'one')
artifact.markdown('b', 'two')
artifact.markdown('c', 'three')
return 1
`,
    { config: { maxArtifacts: 2 } },
  )
  assertRunError(artifactCount.result, 'WF_LIMIT')

  const artifactSize = await runDoc(
    { capabilities: ['orchestrate'] },
    `artifact.markdown('big', '0123456789')
return 1
`,
    { config: { maxArtifactBytes: 5 } },
  )
  assertRunError(artifactSize.result, 'WF_LIMIT')

  const artifactTotal = await runDoc(
    { capabilities: ['orchestrate'] },
    `artifact.markdown('a', '12345678')
artifact.markdown('b', '12345678')
return 1
`,
    { config: { maxArtifactTotalBytes: 10 } },
  )
  assertRunError(artifactTotal.result, 'WF_LIMIT')

  const reportBytes = await runDoc(
    { capabilities: ['orchestrate'] },
    `report({ value: 'aaaaaaaaaa' })
report({ value: 'bbbbbbbbbb' })
return 1
`,
    { config: { maxReportBytes: 20 } },
  )
  assertRunError(reportBytes.result, 'WF_LIMIT')

  const logBytes = await runDoc(
    { capabilities: ['orchestrate'] },
    `log('0123456789')
log('abcdefghij')
return 1
`,
    { config: { maxLogBytes: 15 } },
  )
  assertRunError(logBytes.result, 'WF_LIMIT')
})

await test('runtime: a script throw becomes a typed error, not a rejection', async () => {
  const { result } = await runDoc({ capabilities: ['orchestrate'] }, `throw new Error('script exploded')\n`)
  assertRunError(result, 'WF_SCRIPT_ERROR')
  assert.ok(result.error.message.includes('script exploded'))
})

await test('runtime: a parse error and a synchronous timeout become WF_SCRIPT_ERROR', async () => {
  const parseFailure = await runDoc({ capabilities: ['orchestrate'] }, `const = broken\n`)
  assertRunError(parseFailure.result, 'WF_SCRIPT_ERROR')
  const timeoutFailure = await runDoc({ capabilities: ['orchestrate'] }, `while (true) {}\n`, { config: { syncTimeoutMs: 30 } })
  assertRunError(timeoutFailure.result, 'WF_SCRIPT_ERROR')
})

await test('runtime: args are exposed verbatim and frozen', async () => {
  const { result } = await runDoc(
    { capabilities: ['orchestrate'] },
    `const before = args
let threw = false
try { args.mutated = true } catch { threw = true }
return { received: before, threw }
`,
    { args: { files: ['a', 'b'] } },
  )
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.value.received, { files: ['a', 'b'] })
  assert.equal(result.value.threw, true)
})

await test('runtime: missing services or a bad request resolve to an error result', async () => {
  const missing = await executeWorkflow({})
  assertRunError(missing, 'WF_ARGUMENT_INVALID')
  assert.equal(missing.value, null)
  const badServices = await executeWorkflow({
    document: buildDocument({ id: 'test-flow', name: 'Flow', description: 'Desc' }, 'return 1\n'),
    services: { workspaceRoot: '/tmp/fake' },
  })
  assertRunError(badServices, 'WF_ARGUMENT_INVALID')
  assert.equal(badServices.value, null)
})

/* ------------------------------------------------------------------ */
/* Runtime: resume / amend cache                                       */
/* ------------------------------------------------------------------ */

await test('runtime: resume reuses cached agent calls and observations', async () => {
  const workspace = await makeWorkspace()
  const cache = { agents: new Map(), observations: new Map() }
  const meta = { id: 'test-flow', capabilities: ['orchestrate', 'observe'] }
  const body = `const answer = await agent('cached question')
const text = await files.read('notes/a.txt')
return { answer, text }
`
  const first = await runDoc(meta, body, { workspace, cache, cachePolicy: 'resume' })
  assert.equal(first.result.stopReason, 'completed')
  assert.equal(first.services.calls.agents.length, 1)
  assert.equal(first.services.calls.reads.length, 1)
  assert.equal(cache.agents.size, 1)
  assert.equal(cache.observations.size, 1)

  const second = await runDoc(meta, body, { workspace, cache, cachePolicy: 'resume' })
  assert.equal(second.result.stopReason, 'completed')
  assert.deepEqual(second.result.value, first.result.value)
  assert.equal(second.services.calls.agents.length, 0)
  assert.equal(second.services.calls.reads.length, 0)
  assert.equal(second.callbacks.agentCalls.length, 1)
  assert.equal(second.callbacks.agentCalls[0].cached, true)
  assert.equal(second.callbacks.events[1].cached, true)
  assert.equal(second.callbacks.observations.length, 1)
})

await test('runtime: cachePolicy none ignores a populated cache', async () => {
  const workspace = await makeWorkspace()
  const cache = { agents: new Map(), observations: new Map() }
  const meta = { id: 'test-flow', capabilities: ['orchestrate', 'observe'] }
  const body = `return { answer: await agent('cached question') }\n`
  await runDoc(meta, body, { workspace, cache, cachePolicy: 'resume' })
  const fresh = await runDoc(meta, body, { workspace, cache, cachePolicy: 'none' })
  assert.equal(fresh.services.calls.agents.length, 1)
  assert.equal(fresh.callbacks.agentCalls[0].cached, false)
})

await test('runtime: amend replays until the first cache miss, then runs live', async () => {  const workspace = await makeWorkspace()
  const cache = { agents: new Map(), observations: new Map() }
  const meta = { id: 'test-flow', capabilities: ['orchestrate'] }
  const firstBody = `await agent('alpha')
await agent('beta')
await agent('gamma')
return 1
`
  await runDoc(meta, firstBody, { workspace, cache, cachePolicy: 'resume' })
  assert.equal(cache.agents.size, 3)

  const amendedBody = `await agent('alpha')
await agent('changed')
await agent('gamma')
return 2
`
  const amended = await runDoc(meta, amendedBody, { workspace, cache, cachePolicy: 'amend' })
  assert.equal(amended.result.stopReason, 'completed')
  assert.deepEqual(amended.callbacks.agentCalls.map((record) => record.cached), [true, false, false])
  assert.deepEqual(amended.services.calls.agents.map((spec) => spec.prompt), ['changed', 'gamma'])
  assert.equal(amended.callbacks.agentCalls[0].outputText, 'text:alpha')
})

await test('runtime: amend does not reuse reordered calls', async () => {
  const workspace = await makeWorkspace()
  const meta = { id: 'test-flow', capabilities: ['orchestrate'] }
  const body = `await agent('alpha')\nawait agent('beta')\nreturn 1\n`
  const first = await runDoc(meta, body, { workspace, cachePolicy: 'none' })
  const keys = first.callbacks.agentCalls.map((record) => record.key)
  assert.equal(keys.length, 2)
  const cache = {
    agents: new Map([
      [keys[0], { stopReason: 'completed', text: 'text:alpha' }],
      [keys[1], { stopReason: 'completed', text: 'text:beta' }],
    ]),
    observations: new Map(),
    agentOrder: [keys[1], keys[0]],
    observationOrder: [],
  }
  const amended = await runDoc(meta, body, { workspace, cache, cachePolicy: 'amend' })
  assert.deepEqual(amended.callbacks.agentCalls.map((record) => record.cached), [false, false])
  assert.equal(amended.services.calls.agents.length, 2)
})

await test('runtime: fatal startAgent errors fail the run instead of becoming null', async () => {
  const workspace = await makeWorkspace()
  const { result } = await runDoc({ capabilities: ['orchestrate'] }, `return { value: await agent('escape') }\n`, {
    workspace,
    serviceOptions: {
      startAgent: async () => { throw new WorkflowRunError('WF_PATH_OUTSIDE', 'child cwd escaped the workspace') },
    },
  })
  assert.equal(result.stopReason, 'error')
  assert.equal(result.error.code, 'WF_PATH_OUTSIDE')
})

await test('runtime: JSON copies preserve a legal __proto__ key without probing Object.prototype', async () => {
  const workspace = await makeWorkspace()
  const args = JSON.parse('{"__proto__":{"polluted":true},"x":1}')
  const { result } = await runDoc({ capabilities: ['orchestrate'] }, `return { args, keys: Object.keys(args) }\n`, { workspace, args })
  assert.equal(result.stopReason, 'completed')
  assert.equal(Object.prototype.hasOwnProperty.call(result.value.args, '__proto__'), true)
  assert.equal(Object.getPrototypeOf(result.value.args), Object.prototype)
  assert.equal({}.polluted, undefined)
  assert.deepEqual(result.value.keys, ['__proto__', 'x'])
})

await test('runtime: changing agent reasoning options misses the resume cache', async () => {
  const workspace = await makeWorkspace()
  const cache = { agents: new Map(), observations: new Map() }
  const meta = { id: 'test-flow', capabilities: ['orchestrate'] }
  await runDoc(meta, `return { value: await agent('same prompt') }\n`, { workspace, cache, cachePolicy: 'resume' })
  assert.equal(cache.agents.size, 1)
  const varied = await runDoc(
    meta,
    `return { value: await agent('same prompt', { reasoningEffort: 'high', maxTokens: 128 }) }\n`,
    { workspace, cache, cachePolicy: 'resume' },
  )
  assert.equal(varied.services.calls.agents.length, 1)
  assert.equal(varied.services.calls.agents[0].reasoningEffort, 'high')
  assert.equal(varied.services.calls.agents[0].maxTokens, 128)
  assert.equal(varied.callbacks.agentCalls[0].cached, false)
})

await test('runtime: a live world.run disables later cache reuse', async () => {
  const workspace = await makeWorkspace()
  const cache = { agents: new Map(), observations: new Map() }
  const seedMeta = { id: 'test-flow', capabilities: ['orchestrate'] }
  await runDoc(seedMeta, `return { value: await agent('shared question') }\n`, { workspace, cache, cachePolicy: 'resume' })
  assert.equal(cache.agents.size, 1)

  const executeMeta = { id: 'test-flow', capabilities: ['orchestrate', 'execute'] }
  const body = `await world.run('git', ['status'])
const value = await agent('shared question')
return { value }
`
  const executed = await runDoc(executeMeta, body, {
    workspace,
    cache,
    cachePolicy: 'resume',
    config: { allowedCommands: ['git'] },
    serviceOptions: {
      runCommand: async () => ({ exitCode: 0, signal: null, timedOut: false, aborted: false, stdout: 'clean\n', stderr: '' }),
    },
  })
  assert.equal(executed.result.stopReason, 'completed')
  assert.equal(executed.services.calls.agents.length, 1)
  assert.equal(executed.callbacks.agentCalls[0].cached, false)
  const cacheNotice = executed.callbacks.events.find((event) => event.type === 'log' && event.message.includes('cache reuse disabled'))
  assert.ok(cacheNotice, 'a log event reports the disabled cache reuse')
})

/* ------------------------------------------------------------------ */
/* Cleanup + summary                                                   */
/* ------------------------------------------------------------------ */

for (const dir of tempDirs) {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) {
    console.error(`  ${failure.label}: ${failure.error instanceof Error ? failure.error.stack : String(failure.error)}`)
  }
  process.exitCode = 1
}
