# dshp-net — local network router

`dshp-net` is the Host half of the `dshps` stack (it has no Web client bundle of
its own). It starts a loopback-only HTTP(S) routing proxy on `127.0.0.1`, assigns
every request to a direct connection or to one of several upstream proxies based
on the **provider / hostname**, and optionally points DSH's process-wide
`HTTP_PROXY` / `HTTPS_PROXY` at it. All model traffic from DSH — including
streamed SSE responses — then uses one observable, reversible egress path.

It solves the "different providers need different egress" problem: model A goes
through the office proxy, model B connects directly, an auth domain uses another
route, and every request leaves an audit footprint.

## Features

- **CONNECT tunnels + plain HTTP forwarding**: accepts `CONNECT host:port` and
  absolute-form requests (`GET http://host/path`). Bytes are piped both ways
  without buffering or rewriting, so LLM SSE responses pass through untouched.
- **Per-request routing**: exact host → provider extra domains (wildcard
  suffixes) → `defaultProxy` → direct.
- **Multiple upstream proxies**: `http://` and `https://` upstreams, with
  `Proxy-Authorization: Basic` derived from a DSH credential record when needed
  (passwords never enter Config, logs or RPC output).
- **Strict local auth**: only `Proxy-Authorization: Basic base64('dshps:'+token)`
  is accepted; anything else gets `407` without leaking the expected token.
- **Audit + statistics**: bounded audit ring plus
  `total/active/failed/bytesIn/bytesOut/byProxy/byProvider` counters and a
  success rate.
- **Health checks**: periodic CONNECT probes through every upstream proxy to
  `monitor.healthUrl`, an on-demand `proxy-test`, and an `egress-test` that makes
  a real process `fetch` and checks whether the router actually observed it.
- **`.env` bootstrap**: backs up the previous proxy variables, atomically
  rewrites the two managed lines in `$DSH_HOME/.env`, and supports a clean revert.

## How it is mounted

The plugin is a Host-only subpath of the bundle: patch row `id: dshp-net`,
`name: dshps/plugins/dshp-net`. Its UI lives in the stack settings page; the live
network monitor and audit log open as dshps floating windows via the ball's
satellite ring (they do not share the quota panel's row).

## Configuration

`Config` is a Schemastery schema. All fields are volatile and can be edited from
the settings page without reloading the plugin — except `port`: saving a port
change rewrites a managed `.env` and needs a full DSH restart to rebind.

| Field | Default | Meaning |
| --- | --- | --- |
| `port` | `17890` | Listen port (1024–65535), bound to `127.0.0.1` only; editable in Settings. When occupied the gateway tries the following ports and finally an OS-assigned port — the actual port is shown in Settings |

When a fallback port is in use, “Apply .env” first adopts the actual port as the
configured port and then writes `.env`, so the next restart cannot bind the old
port while `.env` points at the fallback. A full DSH restart is still required.
If `.env` points at the gateway but the port changed, Settings warns about the
mismatch; apply again and restart.
| `defaultProxy` | `'direct'` | Egress when no rule matches: `'direct'` or a `proxies` id |
| `proxies` | `{}` | Dict `id → { label, url, username, enabled }`; passwords are not stored here |
| `providers` | `{}` | Dict `providerId → { proxy, domains: [] }` |
| `monitor.enabled` | `true` | When false the audit ring stops recording but counters keep counting |
| `monitor.maxLogs` | `500` | Audit ring capacity (50–5000) |
| `monitor.healthIntervalSeconds` | `60` | Periodic health-check interval (0 disables) |
| `monitor.healthUrl` | `https://www.gstatic.com/generate_204` | Health-check and egress probe target |

The settings page is organized proxy-first: one row per proxy with provider tags
showing which providers use it; providers in no proxy tag stay direct. “Add
provider” opens a searchable picker and moves a provider from any other proxy.
Click a provider tag to add auth/callback domains; × removes the routing
(back to direct). The default egress is selected at the top of the list and only
handles traffic that matches no provider rule.

**Passwords and tokens are never part of Config**:

- Each upstream proxy password lives in the credential record
  `dshp-net/<proxyId>` as `{ kind: 'api-key', key: '<password>' }`.
- The router token is a 32-byte random hex string created on the first `apply`
  and stored in `dshp-net/router-token`, so it survives restarts.
- Snapshots only expose `hasPassword: boolean` and masked URLs such as
  `http://dshps:***@127.0.0.1:<port>`.

## Routing rules

Each request is matched by target **hostname** in this order:

1. exact provider-derived hosts (catalog / settings `baseURL`, plus the built-in
   DeepSeek routes);
2. provider extra domains (`providers.<id>.domains`); both `*.example.com` and
   `example.com` match subdomains, and the longest matching suffix wins;
3. `defaultProxy`;
4. `direct`.

Upstream dialing: an `http://` proxy gets a plain TCP request, an `https://`
proxy gets a TLS connection first; then `CONNECT target:port` is sent with Basic
credentials when a password record exists. The direct route is a plain TCP
connection to the target.

Behaviour guarantees:

- If a request matches an upstream proxy that is disabled or has an invalid URL,
  it fails with `502` (**fail closed** — traffic is never silently re-routed
  direct, which could leak it to the local egress). The snapshot `health` and the
  audit error explain why.
- The routing table includes the pseudo provider `deepseek-account`
  (`platform.deepseek.com`, `api.deepseek.com`), and the provider order follows
  DSH Settings → Models; it is never re-sorted by vendor name.
- Plain HTTP accepts absolute-form (and origin-form with a `Host` header);
  `https://` targets must use `CONNECT` when an upstream proxy is configured
  (which is what real proxy clients do).

## Local authentication

- Binds `127.0.0.1` only — never exposed to the network.
- Requires `Proxy-Authorization: Basic base64("dshps:" + token)` with a
  constant-time comparison.
- Failures return `407 Proxy Authentication Required` without echoing the token.
- Tokens and proxy passwords never appear in logs, snapshots, `diag` or docs.

## `.env` bootstrap and revert

DSH reads `$DSH_HOME/.env` at launch and injects those proxy variables into the
process environment, which is how in-process requests can be sent to the router.

- Environment file: `$DSH_HOME/.env` (falls back to `~/.dsh/.env` when
  `DSH_HOME` is unset).
- Backup file: `$DSH_HOME/dshps/net-env.json` (mode 0600). The first apply
  records the previous values of `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and
  `NO_PROXY`. This backup can contain old proxy credentials; it is deleted after
  a successful revert.
- apply (`env-apply`): rewrites only the two managed lines `HTTP_PROXY` and
  `HTTPS_PROXY` to `http://dshps:<router-token>@127.0.0.1:<port>`. Every other
  line and comment is preserved, duplicate proxy lines are collapsed, and the
  write is atomic (temp file + rename).
- **A full DSH restart is required**: reloading the plugin only restarts the Host
  plugin, while the process environment is injected at launch.
  `env.pendingRestart: true` in the snapshot means "written to the file, not yet
  used by this process".
- revert (`env-revert`): with a backup, restores the previous four keys (deleting
  lines for keys that did not exist) and removes the backup file; without a
  backup it only removes managed lines whose value is exactly the current router
  URL.
- Known interferences. `env.warnings` is an English fallback; `env.warningCodes`
  is a stable `{ code, params }` list localized by the client:
  - `ALL_PROXY` can take precedence over `HTTP_PROXY`/`HTTPS_PROXY` and make
    process traffic bypass the router;
  - `NO_PROXY` entries that match a mapped provider host bypass the router for
    that provider;
  - a legacy lowercase `http_proxy` is not managed by the plugin;
  - port fallback (`port-fallback`) or a `.env` port that differs from the actual
    port (`port-mismatch`);
  - `.env` written but DSH not fully restarted (`restart-required`);
  - after changing `port`, saving rewrites a managed `.env` automatically and
    asks for a full DSH restart; the gateway keeps the old port until then.

> Revert the environment before disabling or uninstalling the plugin. Otherwise
> `.env` still points at a stopped router and all DSH model requests fail (see
> the network-change rule in [AGENTS.md](../../AGENTS.md)).

## Audit and statistics

The ring keeps at most `monitor.maxLogs` entries, newest first. One entry:

```json
{ "id": 12, "at": 1700000000000, "method": "CONNECT", "host": "api.example.com",
  "port": 443, "provider": "example", "proxy": "office", "direct": false,
  "ok": true, "ms": 431, "bytesIn": 20480, "bytesOut": 1024 }
```

Counters: `total`, `active`, `failed`, `bytesIn` (upstream → client),
`bytesOut` (client → upstream), `byProxy` (per egress), `byProvider` (per
provider) and `successRate` (0–1). `monitor.enabled: false` disables only ring
recording; counters keep counting. `logs-clear` clears the ring only.

Health results are stored per proxy as `{ ok, ms, at, error? }` and returned in
`config.proxies[].health`; `proxy-test` checks a single proxy on demand (use
`id: "direct"` to check the direct egress).

## RPC endpoints

Channel `/dshp-net`, envelope `{ ok: true, value }` /
`{ ok: false, error: { code, message, details } }`. A successful `value` looks
like `{ ok: true, snapshot, … }` — the `ok` marker sits next to the data fields,
matching how the `dshp-quota` / `dshp-models` hosts and the Web client read
results. Failure responses always carry all of `code` / `message` / `details`.

| Endpoint | Payload | Result |
| --- | --- | --- |
| `snapshot` | `{}` | `{ snapshot }` |
| `config-write` | `{ config, revision? }` | `{ snapshot, warnings, portChanged, envRewritten?, envRewriteError? }` |
| `proxy-test` | `{ id }` | `{ health }` |
| `egress-test` | `{}` | `{ effective, evidence, error? }` |
| `env-apply` | `{}` | `{ env, adoptedPort?, adoptedFrom? }` |
| `env-revert` | `{}` | `{ env }` |
| `logs-clear` | `{}` | `{ cleared }` |
| `diag` | `{}` | `{ diag }` |

`config-write` semantics:

- `config.proxies` is a **full replacement**. For the `password` field: omit it to
  keep the stored password, send a non-empty string to set/overwrite it, send an
  empty string to delete it. Removed proxies also have their password records
  cleaned up.
- `config.providers` is a **full replacement**; `proxy` must be `'direct'` or an
  id present in the submitted `proxies`.
- Any of `defaultProxy` / `proxies` / `providers` may be omitted to keep its
  current value; a supplied section is treated as a full replacement.
- `config.port` (1024–65535) is optional: omit it to keep the port. A provided
  change returns `portChanged: true`; when `.env` currently manages the old URL,
  `HTTP_PROXY`/`HTTPS_PROXY` are rewritten atomically and `envRewritten: true` is
  returned. A write failure returns `envRewriteError`. The new port only starts
  listening after a full DSH restart.
- When `.env` is applied while a fallback port is active, the actual port is
  adopted as the configured port and `adoptedPort` / `adoptedFrom` are returned,
  so a later restart cannot point `.env` at a different port.
- `revision` comes from `snapshot.config.revision`; a mismatch returns
  `settings-conflict`. Other write failures return `settings-rejected`; input
  validation failures return `bad-request`.

Main snapshot fields:

```jsonc
{
  "router": { "running": true, "port": 17890, "configPort": 17890, "portFallback": null,
              "error": null, "startedAt": 1700000000000, "restartRequired": false },
  "env": { "envFile": "$DSH_HOME/.env", "routerUrlMasked": "http://dshps:***@127.0.0.1:17890",
           "fileHttpProxy": "...", "processHttpProxy": "...", "noProxy": null,
           "applied": true, "effective": false, "pendingRestart": true,
           "warning": "…", "warnings": ["…"],
           "warningCodes": [{ "code": "restart-required" }] },
  "config": { "port": 17890, "defaultProxy": "direct",
              "proxies": [{ "id": "office", "label": "Office", "url": "http://127.0.0.1:7890",
                            "username": "", "hasPassword": true, "enabled": true,
                            "health": { "ok": true, "ms": 220, "at": 1700000000000 } }],
              "providers": [{ "id": "kimi-coding", "label": "Kimi Code",
                              "hosts": ["api.kimi.com"], "proxy": "office",
                              "domains": ["*.kimi.com"], "sources": ["llm-pi-ai"] }],
              "monitor": { "enabled": true, "maxLogs": 500,
                           "healthIntervalSeconds": 60, "healthUrl": "https://…" },
              "revision": 3 },
  "stats": { "total": 40, "active": 1, "failed": 0, "bytesIn": 0, "bytesOut": 0,
             "byProxy": { "office": 12, "direct": 28 },
             "byProvider": { "kimi-coding": 12, "unmapped": 28 },
             "successRate": 1 },
  "recent": [ /* audit entries, newest first */ ],
  "now": 1700000000000
}
```

`egress-test` semantics: `effective: true` means the router observed the probe
`fetch` during the measurement window; `false` means process traffic did not go
through the router (usually `.env` was applied but DSH was not restarted, or
`ALL_PROXY` / OS proxy settings take precedence). `error` explains the cause.

## Limitations and caveats

- No SOCKS5 or PAC support. Upstream `https://` proxies are verified with the
  system CA; there is no insecure-skip option.
- Plain HTTP payloads pass through this process. The audit records metadata only
  (host/port/bytes/duration), never request contents, auth headers or tokens.
- If the port is taken, the plugin does not crash: `router.error` reports the
  listen failure; fix it and reload the plugin.
- Only one DSH instance can own the port at a time.
- `egress-test` relies on the host's global `fetch`; when unavailable the
  endpoint returns an explicit `error` and the proxy itself is unaffected.
- The plugin never writes project files — only `$DSH_HOME/.env` and the backup /
  state files under `$DSH_HOME/dshps/`.

## Development and tests

- Pure helpers exported for offline tests: `parseProxyUrl`, `mergeEnvFile`,
  `matchRoute`, `redactProxyUrl`, `formatBytes`, plus `Config`, `inject`,
  `apply`, `name`.
- Syntax check: `node --check plugins/dshp-net/host.js`.
- Offline tests run against a mock ctx and a temporary `DSH_HOME`; never touch
  real DSH data. `DSHPS_DISABLE_ROUTER=1` skips the real listen (tests only).
- No new runtime dependencies: Node builtins plus `@deepseek-ai/schemastery`.

## See also

- [Stack overview](../../README.en.md)
- [Security notes](../../SECURITY.md)
- [Development rules](../../AGENTS.md)
