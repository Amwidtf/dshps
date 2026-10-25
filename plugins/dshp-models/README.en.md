<!-- markdownlint-disable MD033 MD041 -->
# dshp-models: Model Sign-in

**English** | [简体中文](README.md)

Part of the [dshps plugin stack](../../README.en.md). Wires the official **Sign in with ChatGPT** OAuth flow into DSH's `openai` route, and surfaces the authorization flows DSH already registers (for example ChatGPT Codex, Kimi Coding, GitHub Copilot) under Settings → DSH Plugin Stack → Model sign-in.

After installing the stack the `dshp-models` row is enabled by default; the UI is the "Model sign-in" tab on the stack settings page. Credentials stay in the Host process; the page only sees sign-in status, expiry and the notices/questions of a running flow.

## Official Sign in with ChatGPT

The flow follows OpenAI's public-client protocol exactly as `@earendil-works/pi-ai`'s `openai-chatgpt.js` implements it:

- Authorization page: `https://auth.openai.com/api/accounts/authorize`
- Token endpoint: `https://auth.openai.com/api/accounts/oauth/token`
- Resource: `https://api.openai.com/v1`
- Scopes: `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`
- Client: `dynamic_agent_client`; OpenAI returns the issued `client_id` (`oaiapp_…`) in the callback and it is stored with the credential
- PKCE S256, random `state` and `nonce`, loopback callback `http://127.0.0.1:<port>/auth/callback`
- Installation identity: `ext_agent_host_id=urn:uuid:<device UUID>`; the UUID is generated on first sign-in and stored in the plugin configuration

Prerequisites and steps:

1. A ChatGPT Plus / Pro subscription that allows model access.
2. `llm-pi-ai` loaded in DSH (part of the default bundle).
3. Open Settings → DSH Plugin Stack → Model sign-in and press "Sign in with ChatGPT".
4. Finish authorization in the browser. The callback page confirms success; the panel shows "signed in" and the credential expiry.
5. Pick a model on the `openai` route under Settings → Models. No API key is needed.

The `openai` route:

- Before signing in the plugin makes sure `llm-pi-ai.providers.openai` exists, adding an empty profile only when it is absent (it never overwrites existing fields).
- The page also offers an explicit "Create openai route" button.
- If the route sets an API key (`apiKeyEnv`), that key overrides OAuth sign-in. The plugin warns about it and **does not** delete it; clear the key when OAuth should authenticate the route.
- The sign-in result is written to the DSH credential record `llm-pi-ai/openai` (`kind: grant`, payload exactly pi-ai's `{ type: 'oauth', access, refresh, expires, clientId, scopes }`); `llm-pi-ai` reads it on every request and refreshes it automatically.

Callback port:

- Default `1455`; configurable to 1024–65535.
- When the port is busy (for example the Codex CLI or an unfinished sign-in still holds it) the attempt does not fail: it falls back to **manual paste mode**. Finish the browser authorization, then paste the final redirect URL (`http://127.0.0.1:<port>/auth/callback?...`) into the "Submit callback URL" box.
- Manual paste also works while the callback server is listening; whichever arrives first wins.

Sign out:

- "Sign out" deletes the local `llm-pi-ai/openai` credential record, returning the route to an unsigned-in state.
- It only forgets the local credential; OpenAI is not told to revoke anything. The refresh token is rotated in place by the `llm-pi-ai` adapter.

## Request shape and quota limits

ChatGPT subscription tokens are not ordinary API keys. Their request shape is restricted by OpenAI, and `llm-pi-ai` already adapts to it:

- **Responses API only**: with an OAuth credential the `openai` route uses `https://api.openai.com/v1/responses`; classifier / Decisions models are filtered out.
- **Always streaming**: requests are fixed to `stream: true`; there is no non-streaming mode.
- **`store: false`**: subscription tokens reject stored responses, so no retrievable response object is created.
- **No sampling fields**: ChatGPT subscription tokens reject `temperature`, and pi-ai also omits `max_output_tokens` and the prompt-cache fields. Sampling settings and output caps from Settings → Models therefore **do not apply** to this route; that is an official limitation, not a plugin defect.
- **Usage is shared with the subscription**: requests count against the ChatGPT plan's rolling 5-hour window and weekly cap, shared with other apps using the subscription. Hitting the cap usually returns 429 (`subscription_sharing_usage_limit_exceeded`) — a usage limit, not an expired sign-in. Wait for the window to reset or upgrade the plan. pi-ai appends a link to the ChatGPT usage page to the error.
- **Model availability depends on the plan**: a model the plan or account may not use fails at request time; switch models or accounts.
- The dshp-quota panel shows API-key vendor balances/quotas; it **does not** read ChatGPT subscription windows.

## Other provider sign-ins (authorization bridge)

DSH's `authorization` service already registers flows for providers that ship a login. This plugin does not reimplement them; it only surfaces the UI:

- The list comes from `ctx.authorization.list()` and shows the flow label, its methods and whether an attempt is running.
- "Sign in" runs one attempt; `notify` messages (verification codes, authorization links) are shown one by one, and `prompt` questions render as text, secret or select inputs.
- One attempt at a time per flow; "Cancel" withdraws the attempt.
- Attempts live only in the current Host process; reloading the page means starting over.
- The plugin **does not** register another authorization flow for `llm-pi-ai/openai` (pi-ai already registers the API-key flow for that key, and a duplicate would fail); the official ChatGPT sign-in writes the same credential record directly.

## Configuration

Options live under Settings → DSH Plugin Stack → Model sign-in, or the plugin settings form:

| Field | Default | Meaning |
|---|---|---|
| `chatgpt.agentName` | `dshps` | `agent_name_hint` reported during sign-in; display only |
| `chatgpt.callbackPort` | `1455` | Loopback callback port, 1024–65535; a busy port falls back to manual paste |
| `chatgpt.deviceId` | empty | Stable installation UUID generated on first sign-in; do not edit by hand. RPC only reports whether it is configured |

## Security

- `access` / `refresh` / `id_token` exist only in the Host process and the DSH credential store (record key `llm-pi-ai/openai`); RPC returns derived facts such as `signedIn`, `recordKind` and expiry only.
- The authorization URL is safe to display: it carries no credential, only the one-time `state`, `nonce` and PKCE challenge.
- The callback server binds `127.0.0.1` only, verifies `state`, and compares the `id_token` `nonce` on a best-effort basis; token responses are validated for `access_token`, `refresh_token`, `id_token`, scope and lifetime.
- Tokens are never logged; error messages collapse whitespace and mask long token-shaped strings.
- The device UUID and plugin settings live in DSH-managed configuration under `$DSH_HOME`. Never commit DSH credential files, `state` values or authorization codes from callback URLs to the repository or a public issue.

## Debugging

The Host half registers the authenticated Connection RPC channel `/dshp-models`:

| Endpoint | Purpose |
|---|---|
| `snapshot` | Sign-in status, `openai` route status, other flows, configuration and service availability |
| `chatgpt-route-ensure` | Ensure/create the `llm-pi-ai.providers.openai` profile |
| `chatgpt-login-start` | Start one official sign-in and return the authorization link and callback mode |
| `chatgpt-login-submit` | Submit a manually pasted callback URL |
| `chatgpt-login-cancel` | Cancel the current sign-in |
| `chatgpt-logout` | Delete the local `llm-pi-ai/openai` credential record |
| `flow-start` | Start a registered authorization flow |
| `flow-poll` | Poll state, notices and pending questions (notices drain on read) |
| `flow-answer` | Answer one pending question |
| `flow-cancel` | Cancel a flow attempt |
| `diag` | Service/route/endpoint facts without tokens, authorization codes or the device UUID |

Use `tools/probe-rpc.mjs` locally; `DSH_WEB_ORIGIN` overrides the default GUI origin.

## Troubleshooting

**The panel says signed out and "Sign in with ChatGPT" waits forever**: check that the browser really opened the authorization page and that pop-ups were not blocked; the page also shows a copyable link.

**"Callback port is busy"**: close whatever holds the port (Codex CLI, an unfinished sign-in), or paste the final callback URL into the box; you can also change the port in the plugin configuration and reload the plugin.

**The browser came back but DSH did not change**: make sure the final redirect is `http://127.0.0.1:<port>/auth/callback?...`, then paste it into "Submit callback URL".

**Signed in but requests fail**: check whether the `openai` route sets `apiKeyEnv` (it overrides OAuth); check that the plan allows the selected model; watch the subscription's 5-hour/weekly usage caps.

**"Other provider sign-ins" is empty**: confirm `llm-pi-ai` is loaded and this DSH version registers authorization flows.

**Still signed in after a DSH restart**: the credential record persists in the DSH credential store. Use "Sign out" to remove it.

## Development and testing

- `tools/test-host.mjs`: pure helpers (PKCE, authorization URL, callback parsing, credential shaping) and RPC behaviour under a mock ctx.
- `tools/test-client.mjs`: render assertions for the model sign-in settings page.
- Tests never touch the network; the token flow is verified with a mocked `fetch`.
- Any change to the official flow parameters must be checked against `@earendil-works/pi-ai`'s `openai-chatgpt.js`, and the `llm-pi-ai/openai` record format must stay unchanged.

See [AGENTS.md](../../AGENTS.md) for repository rules.

## License

[MIT](../../LICENSE) © 2026 dshps contributors
