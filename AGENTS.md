# AGENTS.md

Guidance for AI coding agents (and humans) working on this repository.
Read [README.md](README.md), [SECURITY.md](SECURITY.md) and
[CONTRIBUTING.md](CONTRIBUTING.md) first; this file only adds the rules that are
easy to get wrong.

Working name: **`dshps`** (DSH plugin stack, display name 「DSH 插件栈」). Display/brand
name may change; keep package exports stable until a rename migration is completed.

## What this project is

A DSH (DeepSeek Harness) plugin stack that hosts `dshp-*` plugins. Today it ships
`dshp-quota`: a sidebar balance/quota panel for DeepSeek, Kimi, MiniMax and
Zhipu GLM, plus a stack settings page.

Architecture:

- `package.json` — bundle manifest: `dsh.bundle.patch`, single `dsh.client`,
  subpath `exports`.
- `cordis.patch.yml` — inserts one root row (`dshp-collection`, bare package
  name, mounts the shared Web client) and one subpath row per Host plugin.
- `index.js` — no-op Host half for the root row.
- `client.js` — the *only* Web client bundle. Registers every `dshp-*` UI
  (sidebar panel, settings page) and talks to Host halves over the
  authenticated Connection RPC.
- `plugins/dshp-quota/host.js` — Host half: provider discovery, credential
  resolution, vendor queries, RPC endpoints, Schemastery `Config`.
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

## Commands

```bash
DSH_ASAR=/path/to/Harness/resources/app.asar npm run setup:test-deps
npm run check      # syntax checks
npm run hygiene    # personal paths / real-looking secrets scan
npm run docs:check # README links and anchors
npm test           # host 20 + client 7 (offline fixtures)
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

## Testing expectations

- Every new provider/endpoint parser gets a `tools/test-host.mjs` fixture test,
  including the failure path.
- UI changes get a `tools/test-client.mjs` render assertion (slot registration,
  compact row, overview, detail, settings, error boundary).
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
- [ ] `npm run check`, `npm run hygiene`, `npm run docs:check`, `npm test` pass
