<!-- markdownlint-disable MD033 MD041 -->
# dshp-quota: Balance & Quota

[简体中文](README.md) | **English**

Part of the [dshps plugin stack](../../README.en.md). Shows DeepSeek, Kimi, MiniMax and Zhipu GLM balances, quota windows and subscription usage in the DSH sidebar.

After installing the stack, the `dshp-quota` row is enabled by default. It has two UI entries:

- "Balance" above the sidebar user row;
- the plugin options under Settings → DSH Plugin Stack.

## What it shows

| Provider | Card content | Source |
|---|---|---|
| DeepSeek official API | Balance: available, granted, topped up | DeepSeek API key configured in DSH |
| DeepSeek signed-in account | Signed-in account wallet balance | DSH account session (`deepseekAccount`) |
| Kimi Code | 5-hour and weekly quota, booster wallet; web total usage | Coding API key plus optional web `refresh_token` |
| MiniMax | M Plan text and video 5-hour / weekly quotas | MiniMax key |
| Zhipu GLM | Coding Plan 5-hour / weekly quota, packages, plan; standard API balance | Coding key or standard API key; team plans also need org/project IDs |

Details that often cause confusion:

- Percentages on the panel mean **remaining**, except Kimi total usage, which follows the subscription page and means **used**. Kimi total usage is split into Kimi and Code.
- The Kimi **booster wallet** is separate; it is not part of the monthly quota and gets its own row.
- A Zhipu coding route shows quota only. The cash balance is shown for standard API-key routes.
- The team badge appears only when the API returns explicit team information.

## Install and enable

1. Install the `dshps` bundle as described in the root README.
2. Make sure the `dshp-quota` row is active in DSH.
3. Refresh the page. "Balance" appears in the sidebar.

Disabling the plugin only requires disabling the `dshp-quota` row; the stack and other plugins keep working.

## Configuration

All options live under Settings → DSH Plugin Stack.

### Zhipu GLM team

- Organisation ID: `bigmodel-organization`
- Project ID: `bigmodel-project`
- `type`: usually `2` for team plans

Leave all three empty for a personal account. Without team context the plugin falls back to the personal quota; an empty response becomes "no Coding Plan detected" instead of an error. The values are used only for quota request headers.

### Auto refresh

- 15 to 3600 seconds, default 60.
- The Refresh button in the detail popover triggers a query immediately.
- A `ttlMs` returned by the Host overrides the default polling interval.

### Kimi total usage

The Kimi subscription page's total usage is only available through the web membership API; an API key cannot read it. It needs a web `refresh_token` (about 90 days). The plugin renews and rotates it automatically.

How to get it:

1. Open the `kimi.com` console in a browser and sign in.
2. Press `F12`, open Application → Local Storage, or look at the `RefreshToken` request under Network.
3. Copy `refresh_token`, paste it into the settings page and press Apply.

Do not paste an access token. Access tokens last 15 minutes and return HTTP 401 after they expire.

Storage:

- On Windows the token is DPAPI-encrypted at `%USERPROFILE%\.dsh\dshps\kimi-token.dat`; only the current Windows user can decrypt it.
- If the encrypted file is unavailable, the plugin falls back to DSH's local credential store `KIMI_WEB_TOKEN`; the same environment variable also works.
- The token is never written to the repository or the plugin configuration.
- Clear deletes the local encrypted file and credential entry.
- On HTTP 401 the plugin refreshes once and retries. A failed refresh is reported in Settings or in the detail popover.

## Panel and interactions

Compact panel:

- One row per provider with `5h / week / month` remaining, whichever exists.
- Below 10% the row changes colour; exhausted windows say "used up".
- Balance-only providers show an amount.

Popover:

- The first tab is an overview and opens by default. It lists each provider's plan, remaining values and balance. Click a row to open that provider.
- Vendor tabs switch by click, wheel or arrow keys. Content scrolls first; switching starts at the edges.
- Detail shows the plan name and tier, team badge, balance breakdown, quota bars, full reset time (`YYYY-MM-DD HH:mm` plus countdown) and classified errors.

Ordering: rows and tabs follow the provider order in Settings → Models; the plugin does not re-sort by vendor.

Failed refresh: the last good snapshot is kept and marked stale instead of being cleared.

Error classes: `auth`, `need-config`, `network`, `http`, `gone`, `parse`, `no-plan`, `need-context`.

## Data sources

The vendor endpoints are non-public and may change. Main requests:

- DeepSeek: `GET {origin}/user/balance`; the signed-in account uses DSH's `deepseekAccount.getBalance`.
- Kimi: `GET /v1/users/me/balance`; `GET https://api.kimi.com/coding/v1/usages`; web membership `POST /apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats` and `GetSubscription`; refresh `POST https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken`.
- MiniMax: `GET /v1/token_plan/remains`.
- Zhipu: `GET /api/monitor/usage/quota/limit`, `/api/biz/subscription/list`, `/api/biz/account/query-customer-account-report`, `/api/biz/tokenAccounts/list/my`.

## Debugging

The Host half registers the authenticated RPC channel `/dshp-quota`:

| Endpoint | Purpose |
|---|---|
| `snapshot` | Cached snapshot |
| `refresh` | Force a refresh |
| `diag` | Discovered sources and redacted config, no keys or tokens |
| `settings` | Read the settings document |
| `settings-write` | Write settings with revision conflict detection |
| `kimi-token` | Set, clear or query the Kimi token state |

Use `tools/probe-rpc.mjs` locally. `DSH_WEB_ORIGIN` overrides the default `http://127.0.0.1:62512`.

## Privacy

- Credentials are resolved from DSH's credential service and stay in the Host process.
- The browser receives normalized balances, quotas and error classes only.
- The Kimi token is stored with DPAPI or DSH's credential service and never enters the repository.
- Probes mask secrets. Do not paste their real-account output into a public issue.

## Troubleshooting

**No panel**: check that the `dshp-quota` row is enabled, then refresh the page or restart DSH.

**"Missing API key"**: add the key for that provider under Settings → Models.

**Auth failure**: the key may not match the route, for example a standard API key used against a Coding Plan, or a Kimi key pointed at the wrong site.

**GLM says no Coding Plan**: a personal or standard API key has no quota endpoint. For team plans, fill in the organisation and project IDs in Settings.

**Kimi total usage asks for a token or returns 401**: copy `refresh_token` again; access tokens are not a long-term option.

**Settings page is blank**: refresh and reopen. The error boundary shows the reason if something breaks.

## Development and testing

- `tools/test-host.mjs`: provider discovery, four adapters, Kimi total usage and refresh rotation, caching, redaction, failure degradation, authenticated RPC.
- `tools/test-client.mjs`: compact rows, overview, detail, settings page, error boundary.
- When adding a provider or response field, add a Host fixture test first, then a client render assertion. Tests never touch the network.

See [AGENTS.md](../../AGENTS.md) for repository rules.

## License

[MIT](../../LICENSE) © 2026 dshps contributors
