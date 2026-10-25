# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository.
Read [README.md](README.md), [SECURITY.md](SECURITY.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) first; this file only adds the rules that are
easy to get wrong.

Working name: **`dshps`** (DSH plugin stack, display name 「DSH 插件栈」). Display/brand
name may change; keep package exports stable until a rename migration is completed.

## What this project is

A DSH (DeepSeek Harness) plugin stack that hosts `dshp-*` plugins. Today it ships
four plugins plus a stack settings page:

- `dshp-quota` — sidebar balance/quota panel for DeepSeek, Kimi, MiniMax and
  Zhipu GLM.
- `dshp-net` — loopback routing proxy: multiple upstream proxies, per-provider /
  per-domain routing, one-time `$DSH_HOME/.env` bootstrap, audit log and
  statistics; its monitor/audit surfaces live in the dshps floating windows
  (never as extra sidebar footer rows).
- `dshp-models` — model sign-in: the official Sign in with ChatGPT OAuth flow
  wired to the `llm-pi-ai/openai` credential record, plus UI for the
  authorization flows DSH already registers.
- `dshp-workflow` — extended dynamic workflows: saved/global + project workflow
  library, `workflow_plus` model tool, `/workflow` command, `/dshp-workflow`
  RPC, extended runtime (`agent`/`parallel`/`pipeline`/`phase`/`log`/`args` +
  `files`/`git`/`report`/`artifact`/`world.run`), journal/resume/amend, execute
  gates and budget caps.

The shared Web client also owns the **dshps floating layer** (`shell.overlay`):
a draggable ball whose ring opens satellites for the network-monitor, audit-log,
quota-overview and sign-in-status floating windows. Windows can be dragged,
resized, collapsed, locked, raised and closed; geometry, collapse/lock/stack
state and switches persist in `$DSH_HOME/dshps/floating-ui.json`.

Architecture:

- `package.json` — bundle manifest: `dsh.bundle.patch`, single `dsh.client`,
  subpath `exports`.
- `cordis.patch.yml` — inserts one root row (`dshp-collection`, bare package
  name, mounts the shared Web client) and one subpath row per Host plugin.
- `index.js` — root Host half: mounts the shared Web client and owns the
  floating-layer state service (validation, atomic writes, `/dshp-shell` RPC).
- `client.js` — the *only* Web client bundle. Registers every `dshp-*` UI
  (sidebar panels, settings tabs, `shell.overlay` floating layer) and talks to
  Host halves over the authenticated Connection RPC.
- `plugins/dshp-quota/host.js` — Host half: provider discovery, credential
  resolution, vendor queries, RPC endpoints, Schemastery `Config`.
- `plugins/dshp-net/host.js` — Host half: loopback CONNECT/HTTP routing proxy,
  proxy/provider routing, `.env` apply/revert, audit ring + stats, health
  checks, RPC endpoints.
- `plugins/dshp-models/host.js` — Host half: official ChatGPT OAuth (PKCE +
  device UUID + loopback callback), pi-ai-compatible grant record writes,
  authorization-flow bridge, RPC endpoints.
- `plugins/dshp-workflow/host.js` — Host half: workflow library, settings, RPC,
  `workflow_plus` tool, `/workflow` command, execute/budget gates.
- `plugins/dshp-workflow/lib/{meta,store,runtime}.js` — workflow document
  validation, filesystem library + run journal, and the injectable extended
  runtime (vm script, hooks, cache/resume/amend).
- `locale/` + `plugins/*/locale/` + `icon.svg` — display metadata.
- `tools/` — offline tests, local probes, ASAR helper, repo hygiene and docs checks.
- `research/` — historical API/DSH notes; not needed to install the plugin.
- Docs are split: root `README.md` / `README.en.md` cover the stack; each plugin
  owns `plugins/dshp-*/README.md` (+ `README.en.md`) for its behaviour and options.

## Golden rules

1. **Never commit secrets or personal data.** No API keys, cookies, session
   tokens, Kimi `refresh_token`, account names, emails, screenshots with real
   balances, or personal absolute paths. Test fixtures must be obviously fake
   (`test-*`, `fake-*`). Run `npm run hygiene` before finishing.
2. **Secrets stay in the Host process.** The Web client must never receive
   credentials; it only gets normalized balances/quotas. Do not log tokens or
   cookies.
3. **Preserve the bundle contract.** One root row + one `./client`; subpath
   plugins are Host-only. Do not add a second client bundle, reorder exports, or
   rename package subpaths without a migration plan (DSH profile patch rows
   resolve them by name).
4. **Do not break installed profiles.** Package name, `exports` keys and patch
   row `name` values are install identities. If a rename is required, update
   README/AGENTS, reinstall the bundle, and verify the sidebar panel + settings
   page after a page refresh.
5. **Keep zh/en in sync.** UI strings live in the `ZH` / `EN` dictionaries in
   `client.js`; plugin metadata lives in `locale/*.json`. Add both languages.
6. **Respect provider ordering.** Panel rows and detail tabs follow the order of
   providers in DSH Settings → Models; never sort by vendor.
7. **No new runtime dependencies** unless unavoidable; the bundle relies on DSH
   supplying React/Cordis. Host-side tests may need local shims (see below).
8. **Non-public vendor endpoints are best-effort.** Keep failure classification
   (auth / need-config / network / http / parse / no-plan / need-context) and the
   stale-snapshot fallback intact.
9. **Network egress changes are explicit and reversible.** `dshp-net` may write
   `HTTP_PROXY` / `HTTPS_PROXY` only into `$DSH_HOME/.env` (never project files),
   must back up prior values, and must restore them on revert. It binds
   `127.0.0.1` only and validates its local token. Disabling/uninstalling the
   plugin while `.env` still points at the gateway breaks egress — keep the
   revert path working and documented.
10. **ChatGPT sign-in uses the official documented flow.** Keep the parameters
    aligned with `@earendil-works/pi-ai` (`dynamic_agent_client`,
    `ext_agent_host_id`, loopback callback, `resource`/scopes) and write the
    grant in pi-ai's own credential shape to `llm-pi-ai/openai`. Never register a
    second authorization flow for that key, and never return tokens/device IDs
    over RPC.
11. **Floating-layer state is Host-owned UI state.** Only the root Host half
    writes `$DSH_HOME/dshps/floating-ui.json` (atomic writes, schema
    validation/clamping, revision conflict detection). It contains geometry and
    switches only — never credentials. Windows default to unlocked (reset
    restores that); the browser reads/writes the state through `/dshp-shell`.
    Keep positions clamped inside the viewport (a collapsed window keeps its
    title bar visible), remember the ball by its center ratio, and never let a
    client-supplied value bypass validation.
12. **Workflow execution is trusted-code execution, not a sandbox.**
    `dshp-workflow` scripts run in-process; the VM removes Node/web globals but
    is not a security boundary. Keep `allowAdHocScripts`, `allowExecute` and
    `allowAdHocExecute` off by default. Execute grants are per workflow content
    (`id@sha256`) and must be re-granted after any edit; `allowedCommands` is a
    trust statement (allowing `node`/package managers allows arbitrary code) and
    defaults to empty. `execute` runs never resume/amend. Capability gates
    constrain script hooks, not a child agent's own tools — document that and
    use a read-only `childPreset` when strict observation is required. Run
    records/artifacts may contain workspace content; never add credentials and
    do not treat them as safe to publish.

## Commands

```bash
DSH_ASAR=/path/to/Harness/resources/app.asar npm run setup:test-deps
npm run check      # syntax checks
npm run hygiene    # personal paths / real-looking secrets scan
npm run docs:check # README links and anchors
npm test           # host + workflow + client offline fixtures
```

Local development against a running DSH:

- Install/update the bundle through DSH's bundle installer (do not hand-edit the
  profile's `package.json` / `cordis.patch.yml`).
- Toggle the plugin row to reload code; refresh the Harness page for client
  bundle changes.
- `tools/probe-rpc.mjs` / `tools/fetch-authed.mjs` use the local DSH credential
  file to mint a browser-session cookie; set `DSH_WEB_ORIGIN` if the GUI is not
  on `http://127.0.0.1:62512`. Never paste their output with secrets into issues.
- `tools/probe-vendors.mjs` and `tools/probe-kimi-web.mjs` hit vendor endpoints
  with local credentials; use only on your own machine.

## Code conventions

- Node ESM, 2-space indent, single quotes, no semicolons (match existing files).
- Host RPC envelope: `{ ok: true, value }` / `{ ok: false, error: { code, message } }`;
  `code` must be a string.
- Host config: export Schemastery `Config`; fields editable in the settings page
  should be `.volatile()`.
- Client: register slots in `apply(ctx)` with `ctx.effect(...)` cleanup; never
  crash the whole slot (wrap risky UI in the existing error boundary).
- Vendor adapters must normalize into the existing provider shape
  (`balances`, `windows`, `plan`, `totalUsage`, `team`, `note`, `error`) rather
  than leaking raw responses.
- Kimi web token: `refresh_token` only (≈90 days, rotates). Access tokens (15 min)
  are not a supported long-term configuration. Storage is Windows DPAPI
  (`%USERPROFILE%\.dsh\dshps\kimi-token.dat`) with a DSH credential fallback; never
  write it into the repo or plugin config.
- Proxy passwords, the router token, ChatGPT OAuth grants and device IDs live in
  DSH credential records or the Host process only; plugin `Config`, logs and RPC
  payloads never carry them.
- `dshp-net` reads `$DSH_HOME` from `process.env.DSH_HOME` and falls back to
  `~/.dsh`; tests must set a temporary `DSH_HOME` and never touch the real one.
- `dshp-workflow/lib/runtime.js` must stay dependency-injected: no DSH imports,
  no security-isolation claims in comments, and all host capabilities reached
  through the injected `services` object. Keep `lib/meta.js` and `lib/store.js`
  free of network/DSH imports, and keep the run journal under
  `$DSH_HOME/dshps/workflow` atomic.
- `dshp-workflow` execute authorization is content-bound (`id@sha256`); never
  weaken it to a bare workflow id, never allow `execute` resume/amend, and keep
  the default settings safe (`allowAdHocScripts=false`, `allowExecute=false`,
  `allowedCommands=[]`).

## Testing expectations

- Every new provider/endpoint parser gets a `tools/test-host.mjs` fixture test,
  including the failure path.
- `dshp-net` / `dshp-models` pure helpers (routing match, `.env` merge, proxy URL
  parsing, PKCE/authorize URL/callback parsing, credential shaping) get offline
  unit tests; RPC smoke tests use a mock ctx and a temporary `DSH_HOME`.
- UI changes get a `tools/test-client.mjs` render assertion (slot registration,
  compact row, overview, detail, settings tabs, floating ball/satellites/windows,
  collapse and viewport clamping, error boundary).
- Floating-layer host changes get a `tools/test-host.mjs` fixture test for state
  validation/clamping, persistence, revision conflicts and the authenticated
  fallback route, using a temporary `DSH_HOME`.
- `dshp-workflow` runtime/library changes get `tools/test-workflow.mjs` tests
  (hooks, budgets, cancellation, structured results, resume/amend cache,
  capability and command gates). Host plugin/RPC/tool/command changes get a
  `tools/test-host.mjs` test, including the ad-hoc-script default, the
  `id@sha256` execute grant and its invalidation after an edit. UI changes get
  workflow-tab render assertions in `tools/test-client.mjs`.
- Tests must not hit the network; use the fixture fetch mocks.
- Before finishing: `npm run check && npm run hygiene && npm test`.

## Review checklist

- [ ] No secrets / personal paths / real account data added
- [ ] Bundle exports and patch rows unchanged (or migration documented)
- [ ] zh + en strings updated
- [ ] Provider order preserved
- [ ] Host RPC input validated; no credentials sent to the client
- [ ] Failure states still degrade to stale snapshot + classified error
- [ ] README / locale metadata updated if user-visible behaviour changed; plugin
      details go in `plugins/dshp-*/README.md`, stack details in the root README
- [ ] Floating-layer state keeps its documented file path, atomic write, schema
      validation and viewport clamping; no credentials enter it
- [ ] Workflow defaults stay safe (`allowAdHocScripts`/`allowExecute`/
      `allowAdHocExecute` off, `allowedCommands` empty), execute grants stay
      content-bound, and no docs/comments claim the VM is a sandbox
- [ ] Workflow run records/journal pick up no credentials and the tests use a
      temporary `DSH_HOME`
- [ ] `npm run check`, `npm run hygiene`, `npm run docs:check`, `npm test` pass
