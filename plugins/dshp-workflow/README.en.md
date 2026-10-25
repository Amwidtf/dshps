<!-- markdownlint-disable MD033 MD041 -->
# dshp-workflow: workflow enhancements

[简体中文](README.md) | **English**

Part of the [dshps plugin stack](../../README.en.md). It adds saved, observable and resumable dynamic workflows to DSH: a model-written JavaScript orchestration script fans out subagents, observes the workspace read-only, runs allowlisted deterministic commands, and returns one final JSON value. It merges the productised parts of Claude Code Dynamic Workflows (named workflows, a model tool, run history, reuse) with the engineering controls of ZCode Dynamic Workflows (structured results, `world.run` gates, a journal, resume/amend, an execute allowlist and budget caps) into one plugin.

`dshp-workflow` **does not replace** the shipped `workflow` tool or `ctx.workflowEngine`. It registers its own `workflow_plus` model tool, `/workflow` command and `/dshp-workflow` RPC channel and executes through its own extended runtime; both systems can coexist. The shipped `workflow` is fine for one-off fan-out, while `workflow_plus` targets runs that need saving, observation, command gates and recovery.

## What you get

- **Workflow library**: global (`$DSH_HOME/dshps/workflow/workflows/`) and project (`.dshps/workflows/`) scopes; the settings page lists, previews and deletes global workflows.
- **Model tool**: `workflow_plus` (name configurable) runs a saved workflow or an ad-hoc script.
- **Command**: `/workflow list|show|run|save|delete|runs|status|resume|amend|cancel|help`.
- **Extended hooks**: `agent` / `parallel` / `pipeline` / `phase` / `log` / `args` / `report` / `artifact` / `files` / `git` / `world.run`.
- **Recovery**: a durable run journal; `resume` reuses completed child calls, `amend` reuses the unchanged prefix.
- **Safety gates**: observation, command execution and ad-hoc execution are separate switches plus allowlists; execute stays off by default.
- **Budgets**: concurrency, total children, items per call, wall clock, `world.run` count and report count are capped.
- **Settings**: Settings → DSH Plugin Stack → Workflow covers engine, limits, safety, library and run history.

## Install and enable

After installing the `dshps` bundle the `dshp-workflow` row is enabled by default; disabling the row turns the tool, command and RPC off together.

1. Install the bundle as described in the root README.
2. Confirm the `dshp-workflow` row is active.
3. Refresh the Harness page; Settings → DSH Plugin Stack now has a Workflow tab.
4. Keep `enabled` on and make sure `toolName` (default `workflow_plus`) does not collide with an existing tool.

Execution is off by default: `allowObserve` starts on, while `allowExecute` and `allowAdHocExecute` start off. Enable them explicitly and configure `executeAllowlist` / `allowedCommands` when you need command gates.

## Quick start

Only **saved workflows** run by default; an ad-hoc script (the model writing a script and running it immediately) needs `allowAdHocScripts` because the script executes inside the Host process and is treated as trusted code.

Save a reusable workflow at `.dshps/workflows/review-changed.js`:

```js
/* @dshp-workflow
{
  "name": "Review changed files",
  "description": "Review every changed file and cross-check each finding.",
  "whenToUse": "PR-sized review with independent verification.",
  "capabilities": ["orchestrate", "observe"]
}
*/
phase("Collect changed files")
const changed = await git.changedFiles("origin/main")

phase("Review and verify")
const findings = await pipeline(changed, async (file) => {
  const found = await agent(`Read-only security review of ${file}; report only evidenced issues.`, {
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

return { conclusion: `Reviewed ${changed.length} files`, findings }
```

Then run `/workflow run review-changed`, or preview/delete it from the Workflow library in Settings. A workspace file can also be saved directly with `/workflow save review-changed .dshps/workflows/review-changed.js`.

## Workflow document format

A workflow file is plain JavaScript whose first block is a static JSON comment:

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

- `id` is optional; it falls back to the file name or tool argument and must match `[a-z][a-z0-9-]{0,63}`.
- `name` and `description` are required; `whenToUse` and `phases` are optional documentation.
- `capabilities` accepts `orchestrate` (implied), `observe` and `execute`. `observe` enables `files` / `git`; `execute` enables `world.run`.
- The body is plain JavaScript with top-level `await` and a final `return`. No `import`, `require`, `process`, `fetch`, timers or Node APIs.
- The returned value must be lossless JSON (no functions, symbols, BigInt, undefined or cycles).

## Hooks

| Hook | Contract |
|---|---|
| `agent(prompt, opts?)` | Start one child and await it. With `opts.schema` it resolves a structured object; otherwise text. An ordinary child failure resolves `null`. Options: `label`, `phase`, `schema`, `provider`, `model`, `reasoningEffort`, `maxTokens`, `preset`, `cwd`. |
| `parallel(thunks)` | Run zero-arg functions concurrently; a throwing item resolves `null`. |
| `pipeline(items, ...stages)` | Run each item through stages in order (`(prev, item, index)`); a stage throw drops that item to `null` and skips its remaining stages; no barrier between items. |
| `phase(title)` / `log(message)` | Narrate the run; visible in the run detail. |
| `args` | The frozen tool/command args. |
| `report(item, tag?)` | Publish an intermediate result (at most 64), included in the tool result and the run record. |
| `artifact.markdown/table/file` | Publish deliverables under the run's `artifacts/` directory. |
| `files.glob/read/grep` | Workspace-bound read-only observation; over-limit requests fail instead of truncating. |
| `git.status/diff/changedFiles/log` | Read-only git in a workspace repository. |
| `world.run(command, argsArray?, opts?)` | Execute one allowlisted argv exactly, without shell-string interpolation; returns `{ exitCode, signal, timedOut, aborted, stdout, stderr }`. Non-zero exits are normal values. |

## Safety model

- **Capability tiers**: `orchestrate` is always allowed; `observe` needs `allowObserve`; `execute` needs `allowExecute`.
- **Ad-hoc scripts are off by default**: `allowAdHocScripts` must be enabled for the model to run a script directly; it executes in the Host process and is trusted code, not a sandbox.
- **Execute grants bind to content**: a saved workflow must appear in `executeAllowlist` as `id@sha256`; changing the workflow invalidates the grant.
- **Command allowlist**: `allowedCommands` is empty by default and filled on demand; the `world.run` basename must be allowed and not blocked. Allowing `node`/`python`/package managers is equivalent to allowing arbitrary code; only add commands you trust.
- **Workspace boundary**: `files.*`, `git.*`, `artifact.file` and `cwd` resolve inside the session workspace only; escapes fail.
- **Execution path**: `ctx.shell` + `ctx.sandboxPolicy` under the current session sandbox; when the session policy is unavailable it falls back to the configured `sandboxMode`.
- **Child permissions**: `observe`/`execute` constrain script hooks only, not a child agent's own tools. Children follow the session preset by default; point `childPreset` at a read-only preset for observation-only workflows, otherwise a child may still edit files or run commands.
- **The VM is not a security boundary**: the script runs with Node/web globals removed, but that is not isolation. The real protection is the capability gates, path boundary, command allowlist and explicit grants. Do not run untrusted scripts.
- **No credential reads, but no redaction**: the plugin does not read or write DSH credentials, but run records store scripts, args, command output and child results, which may contain workspace secrets or sensitive content. Treat run records and artifacts as workspace-sensitive data and do not share them.

## Runs, journal and recovery

Run data lives in `$DSH_HOME/dshps/workflow/runs/<runId>/`:

- `run.json`: status, phases, logs, reports, child-agent calls, observations, artifact metadata and the final value; updated atomically after each child call or observation.
- `artifacts/<id>.md`: markdown/table/file deliverables.

Recovery is conservative:

| Original run capabilities | `resume` / `amend` cache |
|---|---|
| `orchestrate` only | Reuse completed child calls |
| Includes `observe` | Also reuse file/git observations |
| Includes `execute` | `resume`/`amend` are refused (commands may have side effects; start a new run instead) |
| `amend` | Re-run from the first call whose key changed; later calls stop hitting the cache |

`resume` only works in the session that started the run; `amend` creates a new run and records `amendOf`. `resume`/`amend` of an execute run is rejected.

## Settings

Settings → DSH Plugin Stack → Workflow:

| Group | Fields |
|---|---|
| Engine | `enabled`, `toolName`, `autoTrigger`, `subagentProvider`, `childPreset` |
| Limits | `maxConcurrentAgents`, `maxAgentsPerRun`, `maxItemsPerCall`, `maxRunSeconds`, `maxWorldRuns`, `maxReportItems`, `runRetentionDays`, `maxSavedWorkflows` |
| Safety | `allowObserve`, `allowExecute`, `allowAdHocExecute`, `allowAdHocScripts`, `executeAllowlist` (`id@sha256`), `allowedCommands` (empty by default), `blockedCommands`, `sandboxMode` |
| Library | Global workflow list (including the content hash), read-only preview, delete |
| Runs | Status, phases, logs, reports, child cache flags, artifact preview, cancel |

`autoTrigger` only changes prompt guidance: `off` stays silent, `suggest` mentions the tool when the user explicitly asks for a workflow, and `auto` suggests it for substantive decomposable tasks. It never changes permissions.

Hover the `?` next to a field for its explanation. Terms that are easy to mix up:

### Where provider and preset come from

Neither is a `dshp-workflow` setting. They are names from DSH registries, and the settings pickers read the current profile directly, so you do not type ids by hand.

| Name | Where it comes from | How to configure it |
|---|---|---|
| `spawn` | DSH built-in child-agent backend, the default | Nothing to set; the child runs in the DSH process with independent context |
| `fork` | DSH built-in child-agent backend | Inherits the parent session context; does not support a fixed preset |
| `codex` / `claude-code` | Registered by subagent plugins installed in the profile | Install and enable those plugins in DSH first; external CLIs may not support structured results or a fixed preset |
| `standard` / `ptc` / `minimal` / `cordis` | Agent presets of the DSH profile — the "mode" picked for a new session | Declared by the profile's presets, not by this plugin; a fixed `childPreset` wins over the script |

The pickers only show what the current profile registered. When a provider lacks what workflows need (structured results, a fixed preset, model options), the settings page shows a warning; read it before switching.

| Term | What it means here |
|---|---|
| `provider` | The DSH backend that runs child agents. The default `spawn` runs them inside the current DSH process; switching requires that backend to exist. |
| `preset` | A DSH agent composition preset that decides which tools and prompt a child gets. A fixed `childPreset` cannot be overridden by the script. |
| `capability` / `observe` / `execute` | Script capability tiers. `orchestrate` only dispatches children; `observe` adds read-only files and git; `execute` adds `world.run` commands. |
| `allowlist` / `id@sha256` | Only explicitly listed items are allowed. Execute grants bind a workflow id to its content hash, so editing the content invalidates them. |
| `basename` | The last segment of a command name: the basename of `/usr/bin/git` is `git`. The allowlist matches on it, and path-qualified commands are rejected. |
| `world.run` | Deterministic command execution inside a script: pass a command name and an argument array, without shell-string interpolation. |
| `journal` / `resume` / `amend` | The run record; resuming from it; re-running a changed script against it. Execute runs cannot resume or amend. |
| `artifact` / `report` | Deliverables and intermediate results. Artifacts go to the run directory; reports enter the tool result and run record. |

## Commands and RPC

`/workflow`:

| Subcommand | Purpose |
|---|---|
| `list [global\|project]` | List workflows |
| `show <id>` | Print workflow source |
| `run <id> [jsonArgs]` | Run a saved workflow |
| `save <id> <path>` | Save a workspace script to the global library |
| `delete <id> [global\|project]` | Delete a workflow |
| `runs` / `status [runId]` | Recent runs / one run detail |
| `resume <runId>` | Resume a run |
| `amend <runId> <id> [jsonArgs]` | Amend a run |
| `cancel <runId>` | Cancel a live run in this process |

RPC channel `/dshp-workflow`: `snapshot`, `settings`, `settings-write`, `workflows-list`, `workflow-read`, `workflow-save`, `workflow-delete`, `runs-list`, `run-read`, `run-cancel`, `artifact-read`, over the existing authenticated Connection RPC.

## Known limitations

- No token budget; only concurrency/count/wall-clock/report caps. Child tokens are not accounted into a run total.
- No mid-run user input; split sign-off points into separate runs.
- The settings page manages the global library and run history only; runs start through `/workflow run` or the model tool.
- Ad-hoc scripts are off by default; when enabled they execute in the Host process and are not sandboxed.
- Project workflows can be written by the model, so the model tool also requires `allowAdHocScripts` to start a `scope: "project"` workflow; a user's explicit `/workflow run` is not gated by the tool setting.
- No TypeScript compilation/type checking; structured results use explicit JSON Schema.
- `observe`/`execute` constrain script hooks only, not child tools; configure a read-only `childPreset` for strict observation-only runs.
- Allowed commands (especially `node`/`python`/package managers) can execute arbitrary code; the allowlist only states which commands the user trusts.
- The settings RPC has no session identity: any authenticated browser in the same profile can read local run history or cancel a run. This fits single-user local use; do not expose the RPC to an untrusted network.
- `toolName` and the tool timeout captured from `maxRunSeconds` at registration only take effect after the plugin row reloads; actual execution still reads live settings.
- On Windows, `world.run` joins argv with pwsh single quotes; allowed commands must be treated as trusted code.
- No Kimi-Tower-style worktree/review/merge protocol; that is out of scope.

## Development and testing

```bash
node --check plugins/dshp-workflow/host.js
node --check plugins/dshp-workflow/lib/runtime.js
node tools/test-workflow.mjs   # runtime/meta/store offline tests
node tools/test-host.mjs       # host plugin/RPC/tool/command tests
node tools/test-client.mjs     # settings render tests
```

All tests are offline, use a temporary `DSH_HOME` and fake services, and never touch the network or the real profile.

## Privacy

Run records store scripts, args, execution metadata, reports and artifacts. The plugin does not actively read DSH credentials, but **it does not redact them**: command output, child results, scripts or args may contain workspace secrets or sensitive data. Treat run records and artifacts as workspace-sensitive data and do not share them. Tools and RPC never return DSH credentials.

## License

[MIT](../../LICENSE) © 2026 dshps contributors
