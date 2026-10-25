# dshp-workflow design & API contract (P1–P3 merged)

Status: implementation contract for the long-running build. This document is the
single source of truth for module boundaries, runtime semantics and the RPC
surface. If code and this file disagree, fix one deliberately and update this
file in the same change.

## 1. Goal

Ship `dshp-workflow`, a dshps subpath Host plugin plus Web-client settings/run UI,
that merges Claude Code "Dynamic Workflows" productisation with ZCode
"Dynamic Workflows" engineering controls:

- P1 — workflow library (global + project), `/workflow` command, model tool,
  RPC, settings page, run history, pre-run safety gates.
- P2 — extended hooks (`files`, `git`, `report`, `artifact`), journal, resume,
  observe capability, result/artifact persistence.
- P3 — `world.run` deterministic gates, execute capability allowlist, budget
  caps, amend cache reuse, conservative invalidation rules.

Non-goals for this delivery: Kimi-Tower worktree/reviewer/merge protocol,
distributed runs, PTY interaction, live streaming inside the Web transcript,
auto-generated TypeScript types. These stay documented as future work.

## 2. Files and ownership

| Path | Owner | Purpose |
| --- | --- | --- |
| `plugins/dshp-workflow/host.js` | Lead | Cordis plugin entry, `Config`, RPC, tool, command, service adapters |
| `plugins/dshp-workflow/lib/meta.js` | runtime-dev | Workflow document parsing/validation |
| `plugins/dshp-workflow/lib/store.js` | runtime-dev | Filesystem library + run journal persistence |
| `plugins/dshp-workflow/lib/runtime.js` | runtime-dev | Sandboxed script execution and hooks |
| `tools/test-workflow.mjs` | runtime-dev | Offline runtime/store/meta tests |
| `client.js` | client-dev | Settings tab, library list, run history/detail |
| `tools/test-client.mjs` | client-dev | Client render assertions |
| `package.json`, `cordis.patch.yml`, root `locale/*.json`, `icon.svg`, READMEs, `AGENTS.md` | Lead | Bundle wiring + docs |
| `plugins/dshp-workflow/README.md`, `README.en.md`, `locale/*.json`, `icon.svg` | Lead | Plugin docs/metadata |

Do not edit files outside your scope. `client.js` is a single writer file.
`index.js` is not expected to change.

## 3. Workflow document format

Saved workflows are plain JavaScript files. The first block is a static metadata
comment (parsed as JSON, never evaluated):

```js
/* @dshp-workflow
{
  "id": "review-changed",
  "name": "Review changed files",
  "description": "Review every changed file and cross-check the findings.",
  "whenToUse": "Use for a PR-sized review with independent verification.",
  "capabilities": ["orchestrate", "observe"],
  "phases": [{ "title": "Collect changed files" }, { "title": "Review", "detail": "one agent per file" }]
}
*/
phase("Collect changed files")
const changed = await git.changedFiles("origin/main")
// ...
return { conclusion: "...", findings: [] }
```

Rules:

- `id`: `[a-z][a-z0-9-]{0,63}`; defaults to the filename stem when absent.
- `name`, `description`: required non-empty strings (max 200 / 2000 chars).
- `capabilities`: subset of `orchestrate | observe | execute`; `orchestrate` is
  implied. `observe` gates `files.*` and `git.*`; `execute` gates `world.run`.
- `phases`: optional static list used for documentation only; runtime `phase()`
  calls may use any title.
- The body is plain JavaScript with top-level `await` and a final `return`.
  No `import`, `require`, `process`, `fetch`, timers, `Date.now` or
  `Math.random` (the VM wrapper removes Node/web globals; `Date`/`Math` are not
  disabled, but scripts must stay replay-friendly — document it).
- Ad-hoc tool calls pass `meta` as a JSON argument; saved files carry the block
  above. `parseWorkflowDocument()` strips the block before execution.

## 4. Script hooks

| Hook | Contract |
| --- | --- |
| `agent(prompt, opts?)` | Start one child agent, await result. Resolves text, or the validated structured value when `opts.schema` is set. Resolves `null` for an ordinary child failure. Options: `label`, `phase`, `schema`, `provider`, `model`, `reasoningEffort`, `maxTokens`, `preset`, `cwd`, `cache` (`true`/`false`, default true for reuse recording). |
| `parallel(thunks)` | Run zero-arg functions concurrently, await all; a throwing thunk resolves `null`. |
| `pipeline(items, ...stages)` | Per item, run stages in order (`(prev, item, index)`); a stage throw drops that item to `null` and skips its remaining stages; no barrier between items. |
| `phase(title)` | Non-empty string, max 120 chars; appended to the run's phase list. |
| `log(message)` | Appended to run logs; max 4000 chars per call, bounded total. |
| `args` | The tool/command `args` value, verbatim. |
| `report(item, tag?)` | Publish an intermediate JSON item (max 256 items, 32 KB serialized each). Included in the tool result and run record. |
| `artifact.markdown(name, content)` | Store a markdown artifact; returns `{ id, path }`. |
| `artifact.table(name, columns, rows)` | Store a markdown table artifact. |
| `artifact.file(name, path)` | Read a workspace file (observe gate) and store it as an artifact. |
| `files.glob(pattern, opts?)` | Workspace-bound; max 2000 paths; over-limit throws `WF_LIMIT` (never truncates). |
| `files.read(path, opts?)` | UTF-8 text read with optional `offset`/`limit` lines; max 256 KB. |
| `files.grep(pattern, opts?)` | Regex text search with optional `glob`; max 2000 matches / 256 KB output. |
| `git.status()` / `git.diff(path?, base?)` / `git.changedFiles(base?)` / `git.log(limit?)` | Read-only git commands, workspace repo only. |
| `world.run(command, argsArray?, opts?)` | Execute capability only. Spawns the exact argv (no shell string), returns `{ exitCode, signal, timedOut, aborted, stdout, stderr }`. Command basename must pass `allowedCommands` / not match `blockedCommands`; max 32 calls; max 64 KB stdout/stderr each; default timeout 300 s. |

Structured schemas use the same object-rooted JSON Schema subset as the shipped
`workflow` tool (`type`, `properties`, `required`, `additionalProperties`,
`items`, `enum`, `const`, `oneOf`). Invalid schemas fail before any child starts.

## 5. Runtime semantics

- The script runs in a `node:vm` context with only the hooks above and standard
  ECMAScript globals. `codeGeneration` strings/wasm are disabled; `require`,
  `process`, `fetch`, timers and Node APIs are absent. VM is not a security
  boundary: the plugin still restricts file access to the session workspace and
  `world.run` to the command allowlist.
- A run starts only after document/meta validation and a capability gate. The
  parent agent owns every child (`delivery: 'caller'`, result collected by the
  runtime, never posted into the parent model's inbox as a subagent notice).
- Child agents are started with `ctx.subagents.startActivation` using
  `provider: config.subagentProvider` (default `spawn`). Options map onto
  `SubagentStartRequest`: prompt text block, parent agent, abort signal,
  `outputSchema`, `agentOptions` (`provider`, `model`, `reasoningEffort`,
  `maxTokens`), optional `preset`, optional `cwd`, `maxDepth: 0`.
- Concurrency is limited by `maxConcurrentAgents`; total children by
  `maxAgentsPerRun`; items per `parallel`/`pipeline` call by `maxItemsPerCall`;
  wall clock by `maxRunSeconds`. Exceeding a cap aborts the run with a typed
  `WorkflowRunError` (`code: WF_BUDGET_EXCEEDED` / `WF_LIMIT`).
- Cancellation: parent signal aborts pending child activations, kills live
  `world.run` shells, disposes activations and resolves `stopReason:
  'cancelled'`. Cancellation never rejects `run.result`.
- Result: `{ value, stopReason: 'completed' | 'cancelled' | 'error', error?,
  agentsStarted, usage: { agents, worldRuns, durationMs }, reports, artifacts }`.
  `value` must be lossless JSON; other values fail with `WF_RESULT_INVALID`.
- Every child failure is ordinary: `agent()` returns `null`; the script decides.
  Hook misuse (bad argument types, unknown option, invalid schema, tripped cap,
  blocked command) fails the run loudly with a typed error.
- File access boundary: `resolveWorkspaceRoot()` uses the parent session's
  effective directory. All `files.*`/`git.*`/`artifact.file` paths resolve under
  that root; absolute paths outside it are rejected.
- `world.run` uses `ctx.shell.resolve/execute` with
  `sandboxPolicy: ctx.sandboxPolicy.resolve({ session })` when the session is
  available, otherwise `{ mode: config.sandboxMode, workspaceRoot }`. `onExpiry:
  'kill'`, fresh env (PATH + platform essentials), `stdin: 'ignore'`.
  Non-zero exit is a normal return value.
- Execute gate: `execute` documents run only when (a) config `allowExecute` is
  true, (b) for saved workflows the id is in `executeAllowlist`, and (c) for
  ad-hoc tool calls `allowAdHocExecute` is true. Violations fail before any
  child or command runs.

### Journal, resume, amend

- The run record is written after each phase/log/report/artifact, each completed
  child call and each observation (atomic temp file + rename).
- Every `agent()` call records `{ seq, key, label, provider, model, preset, cwd,
  status, outputText | structured, childId, startedAt, endedAt }`.
  `key = sha256(canonical JSON of { prompt, schema, provider, model, preset,
  cwd })`.
- Every observation (`files.*`, `git.*`) records `{ seq, kind, key, value }`.
- `resume(runId)` reruns the same script + args with a cache built from the
  prior journal. Cache reuse policy (conservative):
  - `orchestrate` only: reuse completed agent calls.
  - `observe`: reuse completed agent calls and observations.
  - `execute`: reuse nothing by default (`cacheExecute` config can opt in), and
    any live `world.run` marks the run dirty so later cache entries cannot be
    trusted.
- `amend(runId, newDocument)`: new run id, cache built from the old journal with
  the same policy; the first changed call key and everything after it is not
  served from cache (replay stops at the first mismatch). Link `amendOf`.
- `resume`/`amend` of an `execute` run always re-confirms the execute gate and
  never replays `world.run` from a cache.

## 6. Persistence layout

```
$DSH_HOME/dshps/workflow/
  workflows/<id>.js                    # global saved workflows
  runs/<runId>/run.json                # journal + result + metadata
  runs/<runId>/artifacts/<artifactId>.md
<workspace>/.dshps/workflows/<id>.js   # project saved workflows
```

- `$DSH_HOME` = `process.env.DSH_HOME` or `~/.dsh` (repo-wide convention).
- Atomic writes only; ids sanitized; ids never reused across scopes.
- Run retention: prune runs older than `runRetentionDays` on plugin apply and on
  each new run (best effort, never deletes a running run).
- No secrets in run records. Artifacts are user content, not credentials.

## 7. Host surface

### Config (Schemastery, volatile fields)

```
enabled true | toolName "workflow_plus" | autoTrigger "off"|"suggest"|"auto"
subagentProvider "spawn" | childPreset ""
maxConcurrentAgents 4 | maxAgentsPerRun 64
maxItemsPerCall 128 | maxRunSeconds 1800 | maxWorldRuns 32 | maxReportItems 64
allowObserve true | allowExecute false | allowAdHocExecute false
allowAdHocScripts false | executeAllowlist [] (entries "id@sha256")
allowedCommands [] | blockedCommands [] | journalEnabled true
runRetentionDays 30 | maxSavedWorkflows 100 | projectWorkflowDir ".dshps/workflows"
defaultProvider "" | defaultModel "" | sandboxMode "workspace-write"
```

`executeAllowlist` entries bind to the workflow content hash (`id@sha256`), so
replacing a workflow's content revokes its previous execute grant. Ad-hoc
scripts are disabled unless `allowAdHocScripts` is on; when on they execute in
the Host process and are treated as trusted code, not as a sandbox.

### Tool

`ctx.tools.register({ name: config.toolName, description, parameters, output,
execute })`. Input: `{ name?, scope?, script?, meta?, args?, resumeOf?,
amendOf? }`; exactly one of `name` or `script`. Returns
`{ runId, stopReason, result, reports, artifacts, usage }` as JSON; render a
readable summary. Tool guidance is part of the description (no prompt section in
v1). The shipped `workflow` tool stays untouched.

### Command

`/workflow` with subcommands: `list`, `show <id>`, `run <id> [jsonArgs]`,
`save <id> <path>`, `delete <id>`, `runs`, `status [runId]`, `resume <runId>`,
`amend <runId> <id> [jsonArgs]`, `cancel <runId>`, `help`. Returns
`{ kind: 'success' | 'error', text }`.

### RPC channel `/dshp-workflow`

| Endpoint | Payload | Returns |
| --- | --- | --- |
| `snapshot` | `{}` | `{ settings, workflows, runs, activeRuns, providers, presets }` |
| `runtime-options` | `{}` | `{ providers, presets }` from the live subagent/preset registries |
| `settings` | `{}` | `{ available, revision, value }` |
| `settings-write` | `{ ops, revision }` | settings document or `{ code }` error |
| `workflows-list` | `{ scope? }` | `{ workflows }` |
| `workflow-read` | `{ id, scope }` | `{ document, meta }` |
| `workflow-save` | `{ id, scope, text }` | `{ workflow }` |
| `workflow-delete` | `{ id, scope }` | `{ ok: true }` |
| `runs-list` | `{ limit? }` | `{ runs }` |
| `run-read` | `{ runId }` | `{ run }` |
| `run-cancel` | `{ runId }` | `{ ok: true }` |
| `artifact-read` | `{ runId, artifactId }` | `{ artifact }` |

RPC reuses `ctx.connection.rpc.handle(CHANNEL, handler)` with the same
authenticated fallback route pattern as `dshp-quota`. Errors use the repo Host
envelope `{ ok: false, error: { code, message } }` internally; RPC returns
`{ ok: true, value }` / `{ ok: false, error }`.

## 8. Client UI

Add a "Workflow" tab inside the existing dshps settings section (same tab strip
as quota/network/models/floating), with:

- Engine: enabled, tool name, auto trigger, subagent provider.
- Limits: concurrency, agents/run, items/call, seconds, world.run count, reports.
- Safety: observe, execute, ad-hoc execute, execute allowlist (comma list),
  allowed/blocked commands, default sandbox mode.
- Provider and preset are pickers fed by the live Host registries
  (`ctx.subagents.list()` + `ctx.agentPresets.list()`), not free text; the UI
  explains that they come from the DSH profile and warns when a provider lacks
  structured results, a fixed preset, model options or a depth limit.
- All settings fields carry a `?` hover tip; labels keep the Chinese name with
  the English config key in parentheses where the key matters.
- Library: global/project workflow cards with run/show/delete actions.
- Runs: newest-first list with status/agents/duration, detail panel showing
  phases, logs, reports, artifacts, and cached-call count.
- All strings in the `ZH`/`EN` dictionaries in `client.js`; ids from
  `locale/*.json` unchanged.

The client only manages library/settings and reads runs. Starting a run stays on
the agent surface (`/workflow run` or the `workflow_plus` tool) so every run has
a parent Agent.

## 9. Testing contract

- `tools/test-workflow.mjs` (new; wired into `npm test`):
  - meta parsing/normalisation, capability parsing and rejection;
  - store save/list/read/delete with a temporary `DSH_HOME`, atomic run journal,
    retention pruning;
  - runtime against fake services: text/structured results, parallel/pipeline
    null semantics, phase/log/report/artifact collection, budget trips,
    cancellation, lossless-JSON rejection, JSON-schema argument failure;
  - capabilities: observe/execute denial, command allowlist, workspace boundary;
  - resume cache reuse and conservative invalidation, amend stop-at-first-change.
- `tools/test-host.mjs`: plugin shape/`Config` defaults, RPC dispatch
  (snapshot/workflows-list/settings/settings-write/run-read), tool registration
  shape with a mock `ctx.tools`, command registration with a mock `ctx.commands`.
- `tools/test-client.mjs`: settings tab renders workflow sections, library and
  run cards; error boundary still catches.
- No network. Tests must set `DSH_HOME` to a temp directory and clean up.

## 10. Acceptance gates

1. `npm run check && npm run hygiene && npm run docs:check && npm test` pass.
2. `plugin_manager install_bundle` on the repo dir reports `applied`; the new
   row appears in `Config.listConfigs` and the bundle stays selected.
3. `cordis_inspect_query` `Tool.listTools` shows the registered tool (or the row
   is inspectable) after install; `/dshp-workflow` RPC answers an authenticated
   `snapshot` through the repo's probe helper.
4. A tiny real workflow (`orchestrate` only, 1 agent) completes through the
   installed tool with a run record on disk; execute path is refused until
   explicitly enabled.
5. External review: `subagent_codex` design review, `mcode` and `glm-5.3`
   independent code audits; findings triaged and fixed or documented.
6. Existing dshps tests (quota/net/models/floating) still pass unchanged.

## 11. Hardening after external review

An external architecture review (codex) returned NO-GO on the first contract.
The following changes were made before delivery; the remaining items are
explicit residual risks, not claims of security isolation.

Resolved in code and tests:

- **VM is not a boundary**: the contract and docs now state that scripts are
  trusted code. Ad-hoc scripts are disabled by default (`allowAdHocScripts`), so
  the model cannot write and execute a script without an explicit setting; saved
  workflows require an explicit user save. Project-scope workflows can be
  written by the model, so the model tool requires `allowAdHocScripts` to start
  a `scope: "project"` workflow; an explicit user `/workflow run` is not gated
  by that tool setting. A separate-process runner is the next step for real
  isolation and is not claimed here.
- **Subagent permissions**: `childPreset` was added to compose workflow children
  under a restricted preset; docs state that capability gates constrain script
  hooks only, never a child's own tools.
- **Command allowlist trust**: `allowedCommands` now defaults to empty; docs
  state that allowing `node`/`python`/package managers equals allowing arbitrary
  code, and only trusted commands should be added.
- **Execute grants bind to content**: `executeAllowlist` entries are `id@sha256`;
  overwriting a workflow revokes its grant. `workflows-list` / `workflow-read`
  expose the content hash.
- **Execute runs cannot resume/amend**: they are refused because replay could
  repeat command side effects.
- **RPC scope**: the settings RPC is global-only; project-scope access requires
  an Agent and is available only through the command/tool path.
- **CWD boundary**: child `cwd` is resolved through the composed filesystem and
  checked with `contains()` before being passed to the subagent.

Documented residual risks / deferred work:

- The in-process VM can be escaped by a deliberately malicious script. Only run
  scripts the user trusts; a process/OS-sandboxed runner is future work.
- Child agents keep their own tools; use a read-only preset if strict
  observation is required.
- Command allowlists cannot distinguish a benign `git` from a `git` that runs a
  hook/diff driver; the allowlist is a trust statement, not a sandbox.
- Symlink/race hardening is best-effort through `ctx.fs.resolve/contains`; the
  `world.run` command runs under the current sandbox policy but the plugin does
  not add a second OS sandbox.
- Journal/resume caches are conservative but not a full deterministic replay
  system; execute runs are excluded from reuse.
- Credential redaction is not implemented; run records may contain workspace
  content (including secrets) and must be treated as workspace data. The plugin
  does not read DSH credentials itself, but it does not scrub scripts, args,
  command output or child results.
- The settings RPC has no session identity; it is scoped to a local single-user
  profile and exposes run history/cancel to any authenticated browser in that
  profile.
- `toolName` and the tool timeout derived from `maxRunSeconds` are captured at
  tool registration; change them by reloading the plugin row.
- On Windows, `world.run` executes through the pwsh shell provider with
  single-quote argv joining; the command allowlist is a trust statement, not a
  sandbox.

## 12. Safety & repo rules

- One root row + one `./client`; new Host plugin is a subpath export only.
- No new runtime dependencies. `node:vm`, `node:fs`, `node:crypto`,
  `node:path` are standard library.
- No secrets/personal paths in code, tests, docs or run records; fixtures use
  `test-*`/`fake-*`.
- zh/en strings updated together.
- Existing profile rows and install identities stay unchanged; only additive
  exports/patch rows.
