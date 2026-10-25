/**
 * dshp-models — Host half.
 *
 * Two capabilities, one authenticated Connection RPC channel (`/dshp-models`):
 *
 * 1. The official "Sign in with ChatGPT" OAuth flow for the `openai` route.
 *    It mirrors `@earendil-works/pi-ai`'s `openai-chatgpt.js`: PKCE S256, a
 *    dynamic public client, `ext_agent_host_id` (a stable per-installation
 *    UUID), a loopback callback on 127.0.0.1, optional manual paste, and a
 *    credential record written in pi-ai's own OAuth shape under
 *    `llm-pi-ai/openai` — the record `@deepseek-ai/dsh-llm-pi-ai` already
 *    reads. Tokens never leave this process and never appear in RPC payloads.
 *
 * 2. A bridge over DSH's existing authorization seam (`ctx.authorization`).
 *    The plugin registers no flow of its own: it lists the flows DSH already
 *    has, runs one attempt, and relays notices/prompts to the Web client. The
 *    attempt lives in this process; the client only sees ids and questions.
 *
 * The module is import-safe: no work happens at import time, every service is
 * resolved lazily, and `apply()` tolerates a composition without the optional
 * `llm` / `authorization` services (the status simply reports them absent).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import z from '@deepseek-ai/schemastery'

const CHANNEL = '/dshp-models'
const NS = 'dshp-models'
const PI_AI_NS = 'llm-pi-ai'
const OPENAI_ROUTE = 'openai'
const CREDENTIAL_KEY = 'llm-pi-ai/openai'

// The official Sign in with ChatGPT parameters (keep aligned with pi-ai).
const AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize'
const TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token'
const RESOURCE = 'https://api.openai.com/v1'
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
const DIRECT_TOKEN_SCOPE = 'chatgpt.tokens.use.direct'
const SCOPES = `openid profile email offline_access resource.invoke ${DIRECT_TOKEN_SCOPE}`
const CALLBACK_HOST = '127.0.0.1'
const CALLBACK_PATH = '/auth/callback'
const DEFAULT_CALLBACK_PORT = 1455
const DEFAULT_AGENT_NAME = 'dshps'
const EXPIRY_MARGIN_MS = 3 * 60 * 1000
const TOKEN_TIMEOUT_MS = 30_000
const LOGIN_START_TIMEOUT_MS = 15_000
const LOGIN_WAIT_TIMEOUT_MS = 10 * 60 * 1000
const LOGIN_SETTLE_WAIT_MS = 35_000
const LOGIN_CANCEL_WAIT_MS = 5_000
const FLOW_START_WAIT_MS = 1_500
const FLOW_ATTEMPT_TTL_MS = 30 * 60 * 1000
const FLOW_ATTEMPT_MAX = 12
const MAX_NOTICES_PER_ATTEMPT = 50
const MAX_PROMPT_VALUE = 16 * 1024
const MAX_MESSAGE_CHARS = 2_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ABORTED = Symbol('dshp-models-aborted')

/**
 * Plugin configuration. The `chatgpt` section is volatile, so the device UUID
 * is written live through the harness settings document on the first login and
 * later reads see it without a plugin reload.
 */
const Config = z.object({
  chatgpt: z.object({
    deviceId: z.string().default('').description('本机稳定设备 UUID（ext_agent_host_id）；首次登录时自动生成，请勿手工修改'),
    agentName: z.string().default(DEFAULT_AGENT_NAME).description('登录时上报的代理名称（agent_name_hint）'),
    callbackPort: z.natural().min(1024).max(65535).default(DEFAULT_CALLBACK_PORT).description('本地 OAuth 回调端口；被占用时自动退回手动粘贴回调地址'),
  }).default({ deviceId: '', agentName: DEFAULT_AGENT_NAME, callbackPort: DEFAULT_CALLBACK_PORT })
    .description('ChatGPT 登录配置')
    .volatile(),
}).description('dshps 模型登录插件配置')

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Unwrap Schemastery live-config references (`config.chatgpt.get()`) into plain values. */
function plainConfigLike(value, depth = 0) {
  if (depth > 8 || value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((entry) => plainConfigLike(entry, depth + 1))
  if (typeof value.get === 'function') {
    try {
      return plainConfigLike(value.get(), depth + 1)
    } catch {
      return undefined
    }
  }
  const out = {}
  for (const [key, entry] of Object.entries(value)) out[key] = plainConfigLike(entry, depth + 1)
  return out
}

/** A UUID in either case; the official flow needs one to identify this installation. */
export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

/** A usable loopback callback port; anything else falls back to the default. */
export function normalizeCallbackPort(value) {
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && value.trim().length > 0 ? Number(value) : Number.NaN)
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return DEFAULT_CALLBACK_PORT
  return parsed
}

/** base64url(SHA-256(verifier)) — the S256 PKCE challenge. */
export function pkceChallenge(verifier) {
  if (typeof verifier !== 'string' || verifier.length === 0) throw new Error('PKCE verifier must be a non-empty string')
  return createHash('sha256').update(verifier, 'utf8').digest('base64url')
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is required`)
  return value.trim()
}

function requireTokenString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OpenAI OAuth token response has invalid ${field}`)
  }
  return value
}

function normalizeAgentName(value) {
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : ''
  return text.length === 0 ? DEFAULT_AGENT_NAME : text.slice(0, 64)
}

function redirectUriFor(callbackPort) {
  return `http://${CALLBACK_HOST}:${normalizeCallbackPort(callbackPort)}${CALLBACK_PATH}`
}

/** One fresh random value (32 bytes, base64url) for `state` / `nonce` / the PKCE verifier. */
function randomToken() {
  return randomBytes(32).toString('base64url')
}

/**
 * Build the authorization URL from the exact official parameter set.
 * Contains no secret: the challenge is public by design, the verifier never
 * leaves the Host process.
 */
export function buildAuthorizeUrl(input = {}) {
  const options = isRecord(input) ? input : {}
  const deviceId = typeof options.deviceId === 'string' ? options.deviceId.trim() : ''
  if (!isUuid(deviceId)) throw new Error('Sign in with ChatGPT requires a device ID (UUID) for this installation')
  const state = requireNonEmptyString(options.state, 'OAuth state')
  const nonce = requireNonEmptyString(options.nonce, 'OAuth nonce')
  const challenge = requireNonEmptyString(options.challenge, 'PKCE challenge')
  const agentName = normalizeAgentName(options.agentName)
  const callbackPort = normalizeCallbackPort(options.callbackPort)
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    client_id: DYNAMIC_CLIENT_ID,
    agent_name_hint: agentName,
    ext_agent_host_id: `urn:uuid:${deviceId.toLowerCase()}`,
    response_type: 'code',
    redirect_uri: redirectUriFor(callbackPort),
    resource: RESOURCE,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    nonce,
  }).toString()
  return url.toString()
}

/**
 * Parse a browser callback URL (from the loopback server or the manual paste
 * box). Accepts any loopback port because the configured port is not part of
 * the helper's contract; the origin, path, state, error and issued client id
 * are all validated.
 */
export function parseCallbackUrl(input, expectedState) {
  const text = typeof input === 'string' ? input.trim() : ''
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('Paste the full callback URL from the browser')
  }
  if (url.protocol !== 'http:' || url.hostname !== CALLBACK_HOST || url.pathname !== CALLBACK_PATH) {
    throw new Error(`The callback URL must be http://${CALLBACK_HOST}:<port>${CALLBACK_PATH}`)
  }
  const error = url.searchParams.get('error')
  if (error) {
    const description = url.searchParams.get('error_description') || error
    throw new Error(`ChatGPT authorization failed: ${sanitizeMessage(description)}`)
  }
  const code = url.searchParams.get('code')
  if (!code) throw new Error('Missing authorization code')
  const state = url.searchParams.get('state')
  if (!state) throw new Error('Missing OAuth state')
  if (typeof expectedState === 'string' && expectedState.length > 0 && state !== expectedState) {
    throw new Error('OAuth state mismatch')
  }
  const clientId = (url.searchParams.get('client_id') || '').trim()
  if (!clientId) throw new Error('OpenAI OAuth registration callback did not contain an issued client ID')
  return { code, clientId }
}

/**
 * Shape a successful token response into pi-ai's OAuth credential:
 * `{ type: 'oauth', access, refresh, expires, clientId, scopes }`.
 * `expires` keeps a three-minute safety margin so a request never starts with
 * a token about to expire.
 */
export function buildCredential(input = {}) {
  const options = isRecord(input) ? input : {}
  const access = requireTokenString(options.access, 'access_token')
  const refresh = requireTokenString(options.refresh, 'refresh_token')
  const clientId = requireTokenString(options.clientId, 'client_id')
  const scope = requireTokenString(options.scope, 'scope')
  const expiresIn = typeof options.expiresIn === 'number' ? options.expiresIn : Number(options.expiresIn)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('OpenAI OAuth token response has invalid expires_in')
  }
  const scopes = scope.trim().split(/\s+/).filter(Boolean)
  if (!scopes.includes(DIRECT_TOKEN_SCOPE)) {
    throw new Error(`OpenAI OAuth grant did not include ${DIRECT_TOKEN_SCOPE}`)
  }
  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now()
  return {
    type: 'oauth',
    access,
    refresh,
    expires: now + expiresIn * 1000 - EXPIRY_MARGIN_MS,
    clientId,
    scopes,
  }
}

// ---------------------------------------------------------------------------
// misc helpers
// ---------------------------------------------------------------------------

function describeError(error) {
  if (error instanceof Error) return sanitizeMessage(error.message || error.name || 'unknown error')
  return sanitizeMessage(error === undefined ? 'unknown error' : String(error))
}

/** Collapse whitespace and mask token-shaped runs before a message reaches logs/RPC. */
function sanitizeMessage(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return text
    .replace(/[A-Za-z0-9_-]{40,}/g, '***')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_CHARS)
}

function errorCodeOf(error, fallback) {
  const code = error && typeof error === 'object' && typeof error.code === 'string' ? error.code.trim() : ''
  return code.length > 0 ? code : fallback
}

function taggedError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function failure(code, message, details) {
  return {
    ok: false,
    error: {
      code: typeof code === 'string' && code.length > 0 ? code : 'operation-error',
      message: sanitizeMessage(message) || '操作失败',
      details: isRecord(details) ? details : {},
    },
  }
}

function success(value) {
  return { ok: true, value }
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  // A deferred may be abandoned (a losing race, a cancelled attempt); never let
  // that turn into an unhandled rejection.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function startTimer(ms) {
  let timer
  const promise = new Promise((resolve) => {
    timer = setTimeout(resolve, ms)
  })
  if (typeof timer.unref === 'function') timer.unref()
  return {
    promise,
    cancel() {
      clearTimeout(timer)
    },
  }
}

/**
 * Combine a caller signal with a timeout. Node 20+ can compose signals; on an
 * older runtime the caller signal alone is used (the network layer still has
 * its own HTTP timeouts).
 */
function tokenSignal(parent) {
  const timeout = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    : undefined
  if (!parent) return timeout
  if (timeout && typeof AbortSignal.any === 'function') return AbortSignal.any([parent, timeout])
  return parent
}

function abortRace(signal) {
  if (!signal) return { promise: new Promise(() => {}), dispose() {} }
  if (signal.aborted) return { promise: Promise.resolve(ABORTED), dispose() {} }
  let onAbort
  const promise = new Promise((resolve) => {
    onAbort = () => resolve(ABORTED)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    dispose() {
      try {
        signal.removeEventListener('abort', onAbort)
      } catch {
        /* the signal may own a torn-down AbortController */
      }
    },
  }
}

function isAddressInUse(error) {
  return error !== null && typeof error === 'object' && error.code === 'EADDRINUSE'
}

function optionalService(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const hit = ctx.get(name)
      if (hit !== undefined) return hit
    }
  } catch {
    /* fall back to the direct property below */
  }
  try {
    return ctx?.[name]
  } catch {
    return undefined
  }
}

function classifySettingsError(error) {
  return /conflict|stale|revision/i.test(describeError(error)) ? 'settings-conflict' : 'settings-write-failed'
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const payload = JSON.parse(json)
    return isRecord(payload) ? payload : undefined
  } catch {
    return undefined
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** Self-contained success/error page (no external assets), bilingual copy. */
function callbackPage({ tone, heading, message, detail }) {
  const ok = tone === 'ok'
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#f5f6f8;color:#1b1d22;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans",sans-serif;text-align:center}
main{width:100%;max-width:520px;padding:34px 28px;border-radius:16px;background:#fff;box-shadow:0 12px 32px rgba(15,23,42,.09)}
.mark{width:56px;height:56px;margin:0 auto 18px;border-radius:50%;display:grid;place-items:center;color:#fff;font-size:26px;font-weight:700;background:${ok ? '#1f9d55' : '#d64545'}}
h1{margin:0 0 10px;font-size:22px;line-height:1.3;font-weight:650}
p{margin:0;color:#5b6270;font-size:15px;line-height:1.75}
.detail{margin-top:14px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12px;color:#8a909c;word-break:break-word}
@media (prefers-color-scheme:dark){body{background:#101216;color:#f2f4f8}main{background:#191c22;box-shadow:none}p{color:#a7adba}.detail{color:#8b919d}}
</style>
</head>
<body>
<main>
<div class="mark" aria-hidden="true">${ok ? '✓' : '✕'}</div>
<h1>${escapeHtml(heading)}</h1>
<p>${escapeHtml(message)}</p>
${detail ? `<div class="detail">${escapeHtml(detail)}</div>` : ''}
</main>
</body>
</html>`
}

function sendHtml(response, status, html) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  response.end(html)
}

// ---------------------------------------------------------------------------
// official flow: callback server + token exchange
// ---------------------------------------------------------------------------

/**
 * Start the loopback callback server for one attempt. Resolves with
 * `{ result, close }`; `result` resolves with `{ code, clientId }` on a valid
 * callback and rejects on an OAuth error. Binding failures reject before the
 * server accepts connections (`EADDRINUSE` is handled by the caller as
 * "manual paste mode").
 */
function openCallbackServer(port, expectedState) {
  return new Promise((resolve, reject) => {
    let settle
    let done = false
    const result = new Promise((res, rej) => {
      settle = { res, rej }
    })
    result.catch(() => {})
    const finish = (outcome) => {
      if (done) return
      done = true
      if (outcome.error) settle.rej(outcome.error)
      else settle.res(outcome.value)
    }
    let server
    try {
      server = createServer((request, response) => {
        try {
          const url = new URL(request.url || '/', `http://${CALLBACK_HOST}:${port}`)
          if (url.pathname !== CALLBACK_PATH) {
            sendHtml(response, 404, callbackPage({
              tone: 'error',
              heading: '回调地址无效',
              message: '这个地址不是 ChatGPT 登录回调。',
              detail: 'Not a ChatGPT OAuth callback.',
            }))
            return
          }
          const oauthError = url.searchParams.get('error')
          if (oauthError) {
            const description = url.searchParams.get('error_description') || oauthError
            const message = `ChatGPT 授权失败：${sanitizeMessage(description)}`
            sendHtml(response, 400, callbackPage({
              tone: 'error',
              heading: 'ChatGPT 登录失败',
              message,
              detail: 'OpenAI returned an authorization error.',
            }))
            finish({ error: taggedError('oauth-denied', message) })
            return
          }
          let parsed
          try {
            parsed = parseCallbackUrl(url.toString(), expectedState)
          } catch (error) {
            sendHtml(response, 400, callbackPage({
              tone: 'error',
              heading: 'ChatGPT 登录失败',
              message: describeError(error),
              detail: 'Still waiting for a valid callback; you can paste the redirect URL in DSH.',
            }))
            // Keep waiting: a stray/expired callback must not kill the attempt,
            // and the manual-paste path can still complete it.
            return
          }
          sendHtml(response, 200, callbackPage({
            tone: 'ok',
            heading: 'ChatGPT 登录成功',
            message: '已授权完成，可以关闭此页面回到 DSH。',
            detail: 'Signed in to ChatGPT — you can close this page and return to DSH.',
          }))
          finish({ value: parsed })
        } catch (error) {
          try {
            sendHtml(response, 500, callbackPage({
              tone: 'error',
              heading: '回调处理失败',
              message: describeError(error),
              detail: 'Callback handling failed.',
            }))
          } catch {
            /* the browser may have gone away */
          }
        }
      })
    } catch (error) {
      reject(error)
      return
    }
    const onListenError = (error) => {
      if (!done) reject(error)
    }
    server.once('error', onListenError)
    server.listen(port, CALLBACK_HOST, () => {
      server.removeListener('error', onListenError)
      server.on('error', (error) => finish({ error: taggedError('callback-error', describeError(error)) }))
      resolve({
        result,
        close() {
          try {
            server.close()
          } catch {
            /* already closed */
          }
          try {
            if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
          } catch {
            /* older runtime */
          }
          finish({ error: taggedError('login-cancelled', 'Login cancelled') })
        },
      })
    })
  })
}

async function requestToken(body, parentSignal) {
  let response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
      signal: tokenSignal(parentSignal),
    })
  } catch (error) {
    if (parentSignal?.aborted) throw taggedError('login-cancelled', '登录已取消。')
    throw taggedError('token-network', `无法连接 OpenAI 令牌端点：${describeError(error)}`)
  }
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw taggedError('token-rejected', `OpenAI 令牌端点返回 HTTP ${response.status}：${sanitizeMessage(text) || response.statusText}`)
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw taggedError('token-invalid', 'OpenAI 令牌端点返回了非 JSON 响应。')
  }
  if (!isRecord(data)) throw taggedError('token-invalid', 'OpenAI 令牌端点返回了无效响应。')
  return data
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

function makeService(ctx, config) {
  let localDeviceId = ''
  let disposed = false

  const login = {
    state: 'idle',
    starting: false,
    url: '',
    error: undefined,
    callbackAvailable: true,
    controller: undefined,
    manual: undefined,
    stateValue: '',
    settle: undefined,
    settled: undefined,
    startedAt: 0,
    port: DEFAULT_CALLBACK_PORT,
    timer: undefined,
    timedOut: false,
    resolveUrlReady: undefined,
    callback: undefined,
  }

  const attempts = new Map()
  const attemptsByKey = new Map()
  let attemptSeq = 0

  // ---- live configuration -------------------------------------------------

  function chatgptConfig() {
    const plain = plainConfigLike(config)
    const raw = isRecord(plain) && isRecord(plain.chatgpt) ? plain.chatgpt : {}
    return {
      deviceId: isUuid(raw.deviceId) ? raw.deviceId.toLowerCase() : '',
      agentName: normalizeAgentName(raw.agentName),
      callbackPort: normalizeCallbackPort(raw.callbackPort),
    }
  }

  function settingsList() {
    try {
      const rows = ctx.settings?.describe?.()
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  function findOwnDescriptor() {
    const rows = settingsList()
    const exact = rows.find((row) => isRecord(row) && row.ns === NS)
    if (exact) return exact
    return rows.find((row) => isRecord(row) && isRecord(row.value) && isRecord(row.value.chatgpt))
  }

  function findPiAiDescriptor() {
    const rows = settingsList()
    const exact = rows.find((row) => isRecord(row) && row.ns === PI_AI_NS && isRecord(row.value))
    if (exact) return exact
    return rows.find((row) => isRecord(row) && typeof row.ns === 'string'
      && row.ns.toLowerCase().includes('pi-ai')
      && isRecord(row.value)
      && isRecord(row.value.providers))
  }

  function readOpenAiRoute() {
    const descriptor = findPiAiDescriptor()
    const providers = isRecord(descriptor?.value?.providers) ? descriptor.value.providers : undefined
    const profile = isRecord(providers?.[OPENAI_ROUTE]) ? providers[OPENAI_ROUTE] : undefined
    const apiKeyEnv = typeof profile?.apiKeyEnv === 'string' ? profile.apiKeyEnv.trim() : ''
    return {
      configured: profile !== undefined,
      hasKeyOverride: apiKeyEnv.length > 0,
      ns: typeof descriptor?.ns === 'string' ? descriptor.ns : undefined,
    }
  }

  function readCatalogRoute() {
    const llm = optionalService(ctx, 'llm')
    try {
      const entries = typeof llm?.listConfigurableProviders === 'function' ? llm.listConfigurableProviders() : undefined
      if (!Array.isArray(entries)) return undefined
      return entries.find((entry) => isRecord(entry) && entry.provider === OPENAI_ROUTE)
    } catch {
      return undefined
    }
  }

  /** Create the `llm-pi-ai.providers.openai` profile only when it is absent. */
  async function ensureRoute() {
    const settings = ctx.settings
    if (!settings || typeof settings.mutate !== 'function') {
      return { ok: false, error: { code: 'settings-unavailable', message: '设置服务不可用，无法创建 openai 路由。' } }
    }
    const descriptor = findPiAiDescriptor()
    if (!descriptor) {
      return { ok: false, error: { code: 'route-namespace-missing', message: '未找到 llm-pi-ai 设置命名空间，无法创建 openai 路由。' } }
    }
    const providers = isRecord(descriptor.value?.providers) ? descriptor.value.providers : {}
    const existing = providers[OPENAI_ROUTE]
    if (isRecord(existing)) {
      const apiKeyEnv = typeof existing.apiKeyEnv === 'string' ? existing.apiKeyEnv.trim() : ''
      return { ok: true, created: false, ns: descriptor.ns, warning: apiKeyEnv.length > 0 ? 'route-key-override' : undefined }
    }
    const ns = typeof descriptor.ns === 'string' ? descriptor.ns : PI_AI_NS
    try {
      await settings.mutate(ns, [{ op: 'set', path: ['providers', OPENAI_ROUTE], value: {} }])
    } catch (error) {
      return {
        ok: false,
        error: { code: classifySettingsError(error), message: `创建 openai 路由失败：${describeError(error)}` },
      }
    }
    return { ok: true, created: true, ns }
  }

  /** Stable installation UUID: read from config, persisted there on first use. */
  async function ensureDeviceId() {
    const cfg = chatgptConfig()
    if (isUuid(cfg.deviceId)) {
      localDeviceId = cfg.deviceId
      return { ok: true, deviceId: cfg.deviceId }
    }
    if (isUuid(localDeviceId)) return { ok: true, deviceId: localDeviceId }
    if (!ctx.settings || typeof ctx.settings.mutate !== 'function') {
      return { ok: false, error: { code: 'settings-unavailable', message: '设置服务不可用，无法保存本机设备 ID。' } }
    }
    const deviceId = randomUUID()
    const own = findOwnDescriptor()
    const ns = typeof own?.ns === 'string' ? own.ns : NS
    try {
      await ctx.settings.mutate(ns, [{ op: 'set', path: ['chatgpt', 'deviceId'], value: deviceId }])
    } catch (error) {
      return {
        ok: false,
        error: { code: 'device-id-persist-failed', message: `无法保存本机设备 ID：${describeError(error)}` },
      }
    }
    localDeviceId = deviceId
    return { ok: true, deviceId }
  }

  async function readCredentialRecord() {
    const credentials = optionalService(ctx, 'credentials')
    if (!credentials || typeof credentials.readRecord !== 'function') return undefined
    try {
      return await credentials.readRecord(CREDENTIAL_KEY)
    } catch (error) {
      ctx.logger?.warn?.('dshp-models: 读取 OpenAI 凭据记录失败：%s', describeError(error))
      return undefined
    }
  }

  function summarizeCredential(record) {
    if (!isRecord(record)) {
      return { signedIn: false, recordKind: null, expiresAt: null, expiresInMs: null }
    }
    const recordKind = record.kind === 'grant' || record.kind === 'api-key' ? record.kind : null
    if (record.kind === 'grant' && isRecord(record.payload) && record.payload.type === 'oauth'
      && typeof record.payload.access === 'string' && record.payload.access.length > 0) {
      const expires = typeof record.payload.expires === 'number' && Number.isFinite(record.payload.expires)
        ? record.payload.expires
        : null
      return {
        signedIn: true,
        recordKind,
        expiresAt: expires,
        expiresInMs: expires === null ? null : expires - Date.now(),
      }
    }
    if (record.kind === 'api-key'
      && ((typeof record.key === 'string' && record.key.length > 0) || isRecord(record.env))) {
      // An API-key record authenticates the route but is not a ChatGPT
      // subscription sign-in; the panel keeps offering the OAuth flow.
      return { signedIn: false, recordKind, expiresAt: null, expiresInMs: null }
    }
    return { signedIn: false, recordKind, expiresAt: null, expiresInMs: null }
  }

  // ---- official login -----------------------------------------------------

  function resetLogin() {
    clearTimeout(login.timer)
    login.state = 'idle'
    login.url = ''
    login.error = undefined
    login.callbackAvailable = true
    login.controller = undefined
    login.manual = undefined
    login.stateValue = ''
    login.settle = undefined
    login.settled = undefined
    login.startedAt = 0
    login.timer = undefined
    login.timedOut = false
    login.resolveUrlReady = undefined
    login.callback = undefined
  }

  function closeLoginCallback() {
    const callback = login.callback
    login.callback = undefined
    if (callback) {
      try {
        callback.close()
      } catch {
        /* already closed */
      }
    }
  }

  function finishLogin() {
    clearTimeout(login.timer)
    login.timer = undefined
    closeLoginCallback()
    login.controller = undefined
    login.manual = undefined
    login.stateValue = ''
    login.callbackAvailable = true
    if (typeof login.settle === 'function') login.settle('settled')
    login.settle = undefined
  }

  async function runLogin(deviceId, cfg, signal, urlReady) {
    try {
      const verifier = randomToken()
      const challenge = pkceChallenge(verifier)
      const state = randomToken()
      const nonce = randomToken()
      try {
        login.callback = await openCallbackServer(cfg.callbackPort, state)
        login.callbackAvailable = true
      } catch (error) {
        if (isAddressInUse(error)) {
          login.callbackAvailable = false
        } else {
          throw taggedError('callback-unavailable', `无法启动本地回调服务：${describeError(error)}`)
        }
      }
      if (signal.aborted) throw taggedError('login-cancelled', '登录已取消。')
      login.port = cfg.callbackPort
      login.stateValue = state
      login.manual = createDeferred()
      login.url = buildAuthorizeUrl({ deviceId, agentName: cfg.agentName, callbackPort: cfg.callbackPort, state, nonce, challenge })
      if (typeof login.resolveUrlReady === 'function') login.resolveUrlReady()
      login.timer = setTimeout(() => {
        if (login.state !== 'waiting') return
        login.timedOut = true
        try {
          login.controller?.abort()
        } catch {
          /* already aborted */
        }
      }, LOGIN_WAIT_TIMEOUT_MS)
      if (typeof login.timer.unref === 'function') login.timer.unref()
      const abort = abortRace(signal)
      const sources = [login.manual.promise, abort.promise]
      if (login.callback) sources.push(login.callback.result)
      let result
      try {
        result = await Promise.race(sources)
      } finally {
        abort.dispose()
      }
      if (result === ABORTED) throw taggedError('login-cancelled', '登录已取消。')
      if (!isRecord(result) || typeof result.code !== 'string' || typeof result.clientId !== 'string') {
        throw taggedError('login-failed', '登录回调未返回授权码。')
      }
      login.state = 'exchanging'
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: result.clientId,
        code: result.code,
        code_verifier: verifier,
        redirect_uri: redirectUriFor(cfg.callbackPort),
        resource: RESOURCE,
      })
      const token = await requestToken(body, signal)
      requireTokenString(token.id_token, 'id_token')
      const idPayload = decodeJwtPayload(token.id_token)
      if (idPayload && typeof idPayload.nonce === 'string' && idPayload.nonce.length > 0 && idPayload.nonce !== nonce) {
        throw taggedError('nonce-mismatch', 'ID 令牌的 nonce 与本次登录请求不一致，登录已中止。')
      }
      const credential = buildCredential({
        access: token.access_token,
        refresh: token.refresh_token,
        scope: token.scope,
        expiresIn: token.expires_in,
        clientId: result.clientId,
      })
      if (signal.aborted) throw taggedError('login-cancelled', '登录已取消。')
      const credentials = optionalService(ctx, 'credentials')
      if (!credentials || typeof credentials.modifyRecord !== 'function') {
        throw taggedError('credentials-unavailable', '凭据服务不可用，无法保存登录结果。')
      }
      await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'grant', payload: credential }))
      login.state = 'done'
      login.url = ''
      login.error = undefined
    } catch (error) {
      if (login.state === 'done') return
      if (login.timedOut) {
        login.state = 'error'
        login.error = { code: 'login-timeout', message: '登录等待超时，请重新发起登录。' }
      } else if (signal.aborted || errorCodeOf(error, '') === 'login-cancelled') {
        login.state = 'cancelled'
        login.error = undefined
      } else {
        login.state = 'error'
        login.error = { code: errorCodeOf(error, 'login-failed'), message: describeError(error) }
      }
      login.url = ''
    } finally {
      finishLogin()
    }
  }

  async function waitForLoginSettled(ms) {
    if (!login.settled) return
    const timer = startTimer(ms)
    try {
      await Promise.race([login.settled, timer.promise])
    } finally {
      timer.cancel()
    }
  }

  function loginValue(snapshot) {
    const value = {
      ok: true,
      state: login.state,
      callbackAvailable: login.callbackAvailable,
      snapshot,
    }
    if (login.state === 'waiting' || login.state === 'exchanging') value.url = login.url
    return value
  }

  async function startLogin() {
    if (disposed) return failure('plugin-disposed', '插件已停用。')
    if (login.starting || login.state === 'waiting' || login.state === 'exchanging') {
      return failure('login-in-flight', '已有一次 ChatGPT 登录正在进行，请先在浏览器完成或取消。')
    }
    // The lock is taken before the first await: route/device preparation is
    // asynchronous, so without it two concurrent starts would each reset the
    // shared login state and leak a callback server.
    login.starting = true
    try {
      const cfg = chatgptConfig()
      const route = await ensureRoute()
      if (disposed) return failure('plugin-disposed', '插件已停用。')
      if (route.ok !== true) {
        ctx.logger?.warn?.('dshp-models: 预创建 openai 路由失败：%s', route.error?.message ?? '')
      } else if (route.warning === 'route-key-override') {
        ctx.logger?.warn?.('dshp-models: openai 路由设置了 apiKeyEnv，它会覆盖 ChatGPT OAuth 登录。')
      }
      const device = await ensureDeviceId()
      if (disposed) return failure('plugin-disposed', '插件已停用。')
      if (device.ok !== true) return failure(device.error.code, device.error.message)

      resetLogin()
      login.state = 'waiting'
      login.startedAt = Date.now()
      login.port = cfg.callbackPort
      login.controller = new AbortController()
      login.settled = new Promise((resolve) => {
        login.settle = resolve
      })
      const urlReady = createDeferred()
      login.resolveUrlReady = () => urlReady.resolve()
      void runLogin(device.deviceId, cfg, login.controller.signal, urlReady).catch((error) => {
        ctx.logger?.warn?.('dshp-models: ChatGPT 登录流程异常：%s', describeError(error))
      })

      const timer = startTimer(LOGIN_START_TIMEOUT_MS)
      try {
        await Promise.race([urlReady.promise, login.settled, timer.promise])
      } finally {
        timer.cancel()
      }
      if (login.state === 'error' && login.error) {
        return failure(login.error.code, login.error.message)
      }
      if (login.state === 'cancelled') return failure('login-cancelled', '登录已取消。')
      if (!login.url) {
        login.timedOut = true
        try {
          login.controller?.abort()
        } catch {
          /* already aborted */
        }
        return failure('login-start-timeout', '登录流程启动超时，请重试。')
      }
      return success(loginValue(await snapshotData()))
    } finally {
      login.starting = false
    }
  }

  async function submitLogin(payload) {
    const url = isRecord(payload) && typeof payload.url === 'string' ? payload.url.trim() : ''
    if (url.length === 0) return failure('bad-request', '缺少回调 URL。')
    if (login.state !== 'waiting' || !login.manual) {
      return failure('login-not-waiting', '当前没有等待回调的 ChatGPT 登录，请先发起登录。')
    }
    let parsed
    try {
      parsed = parseCallbackUrl(url, login.stateValue)
    } catch (error) {
      return failure('bad-callback', describeError(error))
    }
    const manual = login.manual
    login.manual = undefined
    manual.resolve(parsed)
    await waitForLoginSettled(LOGIN_SETTLE_WAIT_MS)
    return success(loginValue(await snapshotData()))
  }

  async function cancelLogin() {
    if (login.state === 'waiting' || login.state === 'exchanging') {
      if (login.manual) {
        try {
          login.manual.reject(taggedError('login-cancelled', '登录已取消。'))
        } catch {
          /* the attempt may already be gone */
        }
      }
      login.manual = undefined
      try {
        login.controller?.abort()
      } catch {
        /* already aborted */
      }
      await waitForLoginSettled(LOGIN_CANCEL_WAIT_MS)
      closeLoginCallback()
    }
    login.url = ''
    return success(loginValue(await snapshotData()))
  }

  async function logout() {
    if (login.state === 'waiting' || login.state === 'exchanging') {
      await cancelLogin()
    }
    const credentials = optionalService(ctx, 'credentials')
    if (credentials && typeof credentials.deleteRecord === 'function') {
      try {
        await credentials.deleteRecord(CREDENTIAL_KEY)
      } catch (error) {
        return failure('credential-delete-failed', `退出登录失败：${describeError(error)}`)
      }
    }
    if (login.state === 'error' || login.state === 'cancelled' || login.state === 'done') {
      login.state = 'idle'
      login.error = undefined
      login.url = ''
    }
    return success(loginValue(await snapshotData()))
  }

  // ---- authorization flow bridge -----------------------------------------

  function attemptIsActive(attempt) {
    return attempt !== undefined && (attempt.state === 'waiting')
  }

  function isActiveState(state) {
    return state === 'waiting'
  }

  function promptKind(prompt) {
    if (prompt.kind === 'select' || prompt.kind === 'secret' || prompt.kind === 'text') return prompt.kind
    if (prompt.type === 'select') return 'select'
    if (prompt.type === 'secret') return 'secret'
    return 'text'
  }

  function normalizePromptOptions(options) {
    if (!Array.isArray(options)) return undefined
    const out = []
    for (const option of options) {
      if (out.length >= 50) break
      if (typeof option === 'string' && option.length > 0) {
        out.push({ id: option, label: option })
        continue
      }
      if (!isRecord(option)) continue
      const value = option.value ?? option.id ?? option.key ?? option.label
      if (typeof value !== 'string' || value.length === 0) continue
      const label = typeof option.label === 'string' && option.label.length > 0 ? option.label : value
      out.push({ id: value, label })
    }
    return out.length > 0 ? out : undefined
  }

  function promptView(entry) {
    const view = { id: entry.id, kind: entry.kind, message: entry.message }
    if (entry.placeholder) view.placeholder = entry.placeholder
    if (entry.options) view.options = entry.options
    return view
  }

  function closePrompt(attempt, promptId, error) {
    const entry = attempt.prompts.get(promptId)
    if (!entry) return
    attempt.prompts.delete(promptId)
    try {
      entry.cleanup?.()
    } catch {
      /* listeners may already be gone */
    }
    try {
      entry.reject(error)
    } catch {
      /* reject after settle is a no-op */
    }
  }

  function closeAllPrompts(attempt, error) {
    for (const promptId of [...attempt.prompts.keys()]) closePrompt(attempt, promptId, error)
  }

  function createPrompt(attempt, prompt) {
    const source = isRecord(prompt) ? prompt : {}
    const promptId = `${attempt.id}-p${attempt.promptSeq += 1}`
    const entry = {
      id: promptId,
      kind: promptKind(source),
      message: typeof source.message === 'string' && source.message.trim().length > 0
        ? source.message.slice(0, MAX_MESSAGE_CHARS)
        : '请输入：',
      placeholder: typeof source.placeholder === 'string' ? source.placeholder.slice(0, 500) : undefined,
      options: normalizePromptOptions(source.options),
      resolve: undefined,
      reject: undefined,
      cleanup: undefined,
    }
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    promise.catch(() => {})
    const onAttemptAbort = () => closePrompt(attempt, promptId, taggedError('prompt-closed', '登录流程已取消。'))
    let onPromptAbort
    let promptSignal
    if (source.signal && typeof source.signal.addEventListener === 'function') {
      promptSignal = source.signal
      onPromptAbort = () => closePrompt(attempt, promptId, taggedError('prompt-closed', '这个问题已被当前流程撤回。'))
      promptSignal.addEventListener('abort', onPromptAbort, { once: true })
      if (promptSignal.aborted) {
        closePrompt(attempt, promptId, taggedError('prompt-closed', '这个问题已被当前流程撤回。'))
      }
    }
    attempt.controller.signal.addEventListener('abort', onAttemptAbort, { once: true })
    entry.cleanup = () => {
      try {
        attempt.controller.signal.removeEventListener('abort', onAttemptAbort)
      } catch {
        /* signal may be gone */
      }
      if (promptSignal && onPromptAbort) {
        try {
          promptSignal.removeEventListener('abort', onPromptAbort)
        } catch {
          /* signal may be gone */
        }
      }
    }
    attempt.prompts.set(promptId, entry)
    return { promise, view: promptView(entry) }
  }

  function normalizeNotice(notice) {
    if (!isRecord(notice)) return undefined
    const message = typeof notice.message === 'string' && notice.message.trim().length > 0
      ? notice.message.slice(0, MAX_MESSAGE_CHARS)
      : '正在登录…'
    const clean = { message }
    if (typeof notice.url === 'string' && /^https?:\/\//i.test(notice.url)) clean.url = notice.url.slice(0, 4_000)
    if (typeof notice.code === 'string' && notice.code.trim().length > 0) clean.code = notice.code.trim().slice(0, 200)
    return clean
  }

  function interaction(attempt) {
    return {
      notify(notice) {
        try {
          const clean = normalizeNotice(notice)
          if (!clean) return
          if (attempt.notices.length < MAX_NOTICES_PER_ATTEMPT) attempt.notices.push(clean)
          resolveGesture(attempt)
        } catch (error) {
          ctx.logger?.warn?.('dshp-models: 转交登录提示失败：%s', describeError(error))
        }
      },
      prompt(prompt) {
        try {
          const created = createPrompt(attempt, prompt)
          resolveGesture(attempt)
          return created.promise
        } catch (error) {
          ctx.logger?.warn?.('dshp-models: 创建登录输入提示失败：%s', describeError(error))
          const rejected = Promise.reject(error)
          rejected.catch(() => {})
          return rejected
        }
      },
    }
  }

  function resolveGesture(attempt) {
    if (attempt.sawGesture) return
    attempt.sawGesture = true
    try {
      attempt.gesture.resolve()
    } catch {
      /* resolve is idempotent */
    }
  }

  function finishAttempt(attempt) {
    attempt.finished = true
    attempt.updatedAt = Date.now()
    closeAllPrompts(attempt, taggedError('attempt-closed', '登录尝试已结束。'))
    if (attemptsByKey.get(attempt.key) === attempt) attemptsByKey.delete(attempt.key)
    resolveGesture(attempt)
    try {
      attempt.settle?.()
    } catch {
      /* settle is idempotent */
    }
    if (attempt.cleanupTimer) clearTimeout(attempt.cleanupTimer)
    attempt.cleanupTimer = setTimeout(() => {
      attempts.delete(attempt.id)
    }, FLOW_ATTEMPT_TTL_MS)
    if (typeof attempt.cleanupTimer.unref === 'function') attempt.cleanupTimer.unref()
  }

  function settleAttempt(attempt, outcome) {
    if (attempt.finished) return
    attempt.state = outcome?.status === 'cancelled' ? 'cancelled' : 'done'
    finishAttempt(attempt)
  }

  function failAttempt(attempt, error) {
    if (attempt.finished) return
    attempt.state = 'error'
    attempt.error = {
      code: errorCodeOf(error, 'flow-failed'),
      message: describeError(error),
    }
    finishAttempt(attempt)
  }

  function pruneAttempts() {
    const finished = [...attempts.values()].filter((attempt) => attempt.finished)
    while (attempts.size >= FLOW_ATTEMPT_MAX && finished.length > 0) {
      const oldest = finished.shift()
      if (oldest.cleanupTimer) clearTimeout(oldest.cleanupTimer)
      attempts.delete(oldest.id)
    }
  }

  function drainNotices(attempt) {
    return attempt.notices.splice(0, attempt.notices.length)
  }

  function promptViews(attempt) {
    return [...attempt.prompts.values()].map((entry) => promptView(entry))
  }

  function readFlows() {
    const authorization = optionalService(ctx, 'authorization')
    try {
      const list = typeof authorization?.list === 'function' ? authorization.list() : undefined
      if (!Array.isArray(list)) return []
      return list.filter(isRecord).map((flow) => ({
        key: typeof flow.key === 'string' ? flow.key : '',
        label: typeof flow.label === 'string' ? flow.label : '',
        inFlight: flow.inFlight === true,
        methods: Array.isArray(flow.methods)
          ? flow.methods.filter(isRecord).map((method) => ({
            id: typeof method.id === 'string' ? method.id : '',
            label: typeof method.label === 'string' ? method.label : (typeof method.id === 'string' ? method.id : ''),
          })).filter((method) => method.id.length > 0)
          : [],
      })).filter((flow) => flow.key.length > 0)
    } catch (error) {
      ctx.logger?.warn?.('dshp-models: 读取登录流程列表失败：%s', describeError(error))
      return []
    }
  }

  async function flowStart(payload) {
    if (!isRecord(payload) || typeof payload.key !== 'string' || payload.key.trim().length === 0) {
      return failure('bad-request', '缺少登录流程 key。')
    }
    const key = payload.key.trim()
    const method = typeof payload.method === 'string' && payload.method.trim().length > 0 ? payload.method.trim() : undefined
    const authorization = optionalService(ctx, 'authorization')
    if (!authorization || typeof authorization.begin !== 'function') {
      return failure('authorization-unavailable', 'DSH 登录授权服务不可用。')
    }
    let entry
    try {
      const flows = typeof authorization.list === 'function' ? authorization.list() : []
      entry = Array.isArray(flows) ? flows.find((flow) => isRecord(flow) && flow.key === key) : undefined
    } catch (error) {
      return failure('authorization-unavailable', `无法读取登录流程：${describeError(error)}`)
    }
    if (!entry) return failure('no-flow', `没有已注册的登录流程：${key}`)
    const methods = Array.isArray(entry.methods) ? entry.methods.filter(isRecord) : []
    if (method && methods.length > 0 && !methods.some((candidate) => candidate.id === method)) {
      return failure('unknown-method', `登录流程 ${key} 不提供方法 ${method}。`)
    }
    if (entry.inFlight === true) return failure('flow-in-flight', '该登录流程已在其他界面进行中。')
    const running = attemptsByKey.get(key)
    if (attemptIsActive(running)) return failure('flow-in-flight', '该登录流程已在其他界面进行中。')

    pruneAttempts()
    const attempt = {
      id: `flow-${Date.now().toString(36)}-${attemptSeq += 1}`,
      key,
      method,
      state: 'waiting',
      error: undefined,
      notices: [],
      prompts: new Map(),
      promptSeq: 0,
      controller: new AbortController(),
      gesture: createDeferred(),
      settledDeferred: createDeferred(),
      settle: undefined,
      finished: false,
      sawGesture: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cleanupTimer: undefined,
    }
    attempt.settle = () => attempt.settledDeferred.resolve()
    attempts.set(attempt.id, attempt)
    attemptsByKey.set(key, attempt)

    let beginPromise
    try {
      beginPromise = Promise.resolve(authorization.begin({
        key,
        method,
        interaction: interaction(attempt),
        signal: attempt.controller.signal,
      }))
    } catch (error) {
      beginPromise = Promise.reject(error)
    }
    beginPromise.then((outcome) => settleAttempt(attempt, outcome), (error) => failAttempt(attempt, error))

    const timer = startTimer(FLOW_START_WAIT_MS)
    try {
      await Promise.race([attempt.gesture.promise, attempt.settledDeferred.promise, timer.promise])
    } finally {
      timer.cancel()
    }
    if (attempt.state === 'error' && attempt.notices.length === 0 && attempt.prompts.size === 0 && !attempt.sawGesture) {
      attempts.delete(attempt.id)
      if (attemptsByKey.get(key) === attempt) attemptsByKey.delete(key)
      if (attempt.cleanupTimer) clearTimeout(attempt.cleanupTimer)
      return failure(attempt.error?.code ?? 'flow-failed', attempt.error?.message ?? '登录流程启动失败。')
    }
    const notices = drainNotices(attempt)
    const urlNotice = notices.find((notice) => typeof notice.url === 'string')
    const value = {
      ok: true,
      attemptId: attempt.id,
      notices,
      prompts: promptViews(attempt),
    }
    if (urlNotice) value.url = urlNotice.url
    return success(value)
  }

  function flowPoll(payload) {
    if (!isRecord(payload) || typeof payload.attemptId !== 'string') {
      return failure('bad-request', '缺少 attemptId。')
    }
    const attempt = attempts.get(payload.attemptId)
    if (!attempt) return failure('unknown-attempt', '登录尝试不存在或已过期，请重新开始。')
    const value = {
      ok: true,
      state: attempt.state,
      notices: drainNotices(attempt),
      prompts: promptViews(attempt),
    }
    if (attempt.error) {
      value.error = attempt.error.message
      value.errorCode = attempt.error.code
    }
    return success(value)
  }

  function flowAnswer(payload) {
    if (!isRecord(payload) || typeof payload.attemptId !== 'string' || typeof payload.promptId !== 'string') {
      return failure('bad-request', '缺少 attemptId 或 promptId。')
    }
    if (payload.value === undefined) return failure('bad-request', '缺少输入值。')
    const raw = payload.value
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') {
      return failure('bad-request', '输入值必须是字符串。')
    }
    const value = String(raw)
    if (value.length > MAX_PROMPT_VALUE) return failure('bad-request', '输入值过长。')
    const attempt = attempts.get(payload.attemptId)
    if (!attempt) return failure('unknown-attempt', '登录尝试不存在或已过期，请重新开始。')
    const entry = attempt.prompts.get(payload.promptId)
    if (!entry) return failure('unknown-prompt', '该输入提示已失效。')
    attempt.prompts.delete(payload.promptId)
    try {
      entry.cleanup?.()
    } catch {
      /* listeners may already be gone */
    }
    try {
      entry.resolve(value)
    } catch {
      /* the flow may have withdrawn the prompt */
    }
    return success({ ok: true })
  }

  function flowCancel(payload) {
    if (!isRecord(payload) || typeof payload.attemptId !== 'string') {
      return failure('bad-request', '缺少 attemptId。')
    }
    const attempt = attempts.get(payload.attemptId)
    if (!attempt) return failure('unknown-attempt', '登录尝试不存在或已过期，请重新开始。')
    if (isActiveState(attempt.state)) {
      try {
        attempt.controller.abort()
      } catch {
        /* already aborted */
      }
    }
    return success({ ok: true })
  }

  // ---- snapshot / diagnostics --------------------------------------------

  async function snapshotData() {
    const cfg = chatgptConfig()
    const credential = summarizeCredential(await readCredentialRecord())
    const route = readOpenAiRoute()
    const own = findOwnDescriptor()
    const busy = login.state === 'waiting' || login.state === 'exchanging'
    const loginView = {
      state: login.state,
      callbackAvailable: busy ? login.callbackAvailable : true,
    }
    if (busy && login.url) loginView.url = login.url
    if (login.error) loginView.error = login.error
    return {
      chatgpt: {
        signedIn: credential.signedIn,
        recordKind: credential.recordKind,
        expiresAt: credential.expiresAt,
        expiresInMs: credential.expiresInMs,
        routeConfigured: route.configured,
        routeHasKeyOverride: route.hasKeyOverride,
        deviceIdConfigured: isUuid(cfg.deviceId) || isUuid(localDeviceId),
        login: loginView,
      },
      flows: readFlows(),
      config: {
        agentName: cfg.agentName,
        callbackPort: cfg.callbackPort,
        ns: typeof own?.ns === 'string' ? own.ns : NS,
        revision: typeof own?.revision === 'number' ? own.revision : null,
      },
      services: {
        llm: optionalService(ctx, 'llm') !== undefined,
        authorization: optionalService(ctx, 'authorization') !== undefined,
      },
      now: Date.now(),
    }
  }

  async function snapshot() {
    return success({ ok: true, snapshot: await snapshotData() })
  }

  async function ensureRouteEnvelope() {
    const route = await ensureRoute()
    if (route.ok !== true) return failure(route.error.code, route.error.message)
    return success({
      ok: true,
      created: route.created === true,
      ...(route.warning ? { warning: route.warning } : {}),
      snapshot: await snapshotData(),
    })
  }

  async function diagnostics() {
    const cfg = chatgptConfig()
    const own = findOwnDescriptor()
    const piAi = findPiAiDescriptor()
    const route = readOpenAiRoute()
    const catalog = readCatalogRoute()
    let credentialDescription
    try {
      const credentials = optionalService(ctx, 'credentials')
      credentialDescription = credentials && typeof credentials.describeRecord === 'function'
        ? await credentials.describeRecord(CREDENTIAL_KEY)
        : undefined
    } catch (error) {
      credentialDescription = { error: describeError(error) }
    }
    const flows = readFlows()
    return success({
      ok: true,
      diag: {
        channel: CHANNEL,
        ns: typeof own?.ns === 'string' ? own.ns : NS,
        config: {
          agentName: cfg.agentName,
          callbackPort: cfg.callbackPort,
          deviceIdConfigured: isUuid(cfg.deviceId) || isUuid(localDeviceId),
        },
        credential: credentialDescription
          ? {
            configured: credentialDescription.configured === true,
            kind: typeof credentialDescription.kind === 'string' ? credentialDescription.kind : null,
            error: typeof credentialDescription.error === 'string' ? credentialDescription.error : undefined,
          }
          : { configured: false, kind: null },
        route: {
          configured: route.configured,
          hasKeyOverride: route.hasKeyOverride,
          settingsNs: route.ns ?? (typeof piAi?.ns === 'string' ? piAi.ns : null),
          catalog: isRecord(catalog)
            ? {
              provider: OPENAI_ROUTE,
              settingsNs: typeof catalog.settingsNs === 'string' ? catalog.settingsNs : null,
              declared: catalog.declared === true,
              defaultBaseURL: typeof catalog.defaultBaseURL === 'string' ? catalog.defaultBaseURL : null,
              nativeOauth: isRecord(catalog.nativeAuth) ? catalog.nativeAuth.oauth === true : undefined,
            }
          : null,
        },
        services: {
          llm: optionalService(ctx, 'llm') !== undefined,
          authorization: optionalService(ctx, 'authorization') !== undefined,
          credentials: optionalService(ctx, 'credentials') !== undefined,
        },
        login: {
          state: login.state,
          callbackAvailable: login.callbackAvailable,
          hasUrl: login.url.length > 0,
          activeForMs: login.startedAt > 0 ? Date.now() - login.startedAt : null,
        },
        flows: flows.map((flow) => ({
          key: flow.key,
          label: flow.label,
          inFlight: flow.inFlight,
          methods: flow.methods.map((method) => method.id),
        })),
        endpoints: {
          authorize: AUTHORIZE_URL,
          token: TOKEN_URL,
          resource: RESOURCE,
          callbackPath: CALLBACK_PATH,
        },
        clientId: DYNAMIC_CLIENT_ID,
        scopes: SCOPES.split(/\s+/),
        platform: process.platform,
        now: Date.now(),
      },
    })
  }

  function dispose() {
    disposed = true
    clearTimeout(login.timer)
    login.timer = undefined
    try {
      login.controller?.abort()
    } catch {
      /* already aborted */
    }
    closeLoginCallback()
    if (login.manual) {
      try {
        login.manual.reject(taggedError('plugin-disposed', '插件已停用。'))
      } catch {
        /* already settled */
      }
    }
    for (const attempt of attempts.values()) {
      try {
        attempt.controller.abort()
      } catch {
        /* already aborted */
      }
      if (attempt.cleanupTimer) clearTimeout(attempt.cleanupTimer)
    }
    attempts.clear()
    attemptsByKey.clear()
  }

  return {
    snapshot,
    ensureRouteEnvelope,
    startLogin,
    submitLogin,
    cancelLogin,
    logout,
    flowStart,
    flowPoll,
    flowAnswer,
    flowCancel,
    diagnostics,
    dispose,
  }
}

// ---------------------------------------------------------------------------
// RPC dispatch
// ---------------------------------------------------------------------------

/** Dispatch one endpoint. Every branch returns an envelope; business errors never throw. */
async function dispatch(service, endpoint, payload) {
  try {
    if (endpoint === 'snapshot') return await service.snapshot()
    if (endpoint === 'diag') return await service.diagnostics()
    if (endpoint === 'chatgpt-route-ensure') return await service.ensureRouteEnvelope()
    if (endpoint === 'chatgpt-login-start') return await service.startLogin()
    if (endpoint === 'chatgpt-login-submit') return await service.submitLogin(payload)
    if (endpoint === 'chatgpt-login-cancel') return await service.cancelLogin()
    if (endpoint === 'chatgpt-logout') return await service.logout()
    if (endpoint === 'flow-start') return await service.flowStart(payload)
    if (endpoint === 'flow-poll') return await service.flowPoll(payload)
    if (endpoint === 'flow-answer') return await service.flowAnswer(payload)
    if (endpoint === 'flow-cancel') return await service.flowCancel(payload)
    return failure('bad-request', `未知端点：${String(endpoint)}`)
  } catch (error) {
    return failure('operation-error', describeError(error))
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * Fallback transport when `ctx.connection.rpc.handle` is unavailable.
 *
 * The client half only needs a POST endpoint at `<channel>/<endpoint>`
 * speaking the Connection envelope; this route authenticates every request
 * through `ctx.connection.admit` before dispatch, exactly like the shared
 * channel would.
 */
function registerOwnRpcRoute(ctx, service) {
  const webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined
  if (!webServer || typeof webServer.register !== 'function') return undefined
  if (typeof ctx?.connection?.admit !== 'function') return undefined
  return webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const admission = ctx.connection.admit(req)
      if (isRecord(admission) && 'rejection' in admission) {
        const status = admission.rejection === 403 ? 403 : 401
        res.writeHead(status)
        res.end(status === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end('method not allowed')
        return
      }
      const pathname = new URL(req.url || '/', 'http://localhost').pathname
      const endpoint = pathname === CHANNEL ? '' : pathname.startsWith(`${CHANNEL}/`) ? pathname.slice(CHANNEL.length + 1) : ''
      if (!/^[A-Za-z0-9_$.-]+$/.test(endpoint)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 256 * 1024) {
          res.writeHead(413)
          res.end('payload too large')
          return
        }
        chunks.push(chunk)
      }
      let message
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      const rpcId = isRecord(message) && typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const payload = isRecord(message) ? message.payload : undefined
      const result = await dispatch(service, endpoint, payload)
      const envelope = result.ok === true
        ? { type: 'server-response', rpcId, result: { ok: true, value: result } }
        : {
          type: 'server-response',
          rpcId,
          result: {
            ok: false,
            error: {
              code: typeof result.error?.code === 'string' ? result.error.code : 'operation-error',
              message: typeof result.error?.message === 'string' ? result.error.message : 'failed',
              details: isRecord(result.error?.details) ? result.error.details : {},
            },
          },
        }
      const body = JSON.stringify(envelope)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    },
  })
}

export const inject = ['connection', 'settings', 'credentials']

export function apply(ctx, config) {
  const service = makeService(ctx, config)
  let disposeRpc
  try {
    if (!ctx?.connection?.rpc || typeof ctx.connection.rpc.handle !== 'function') {
      throw new Error('connection.rpc.handle 不可用')
    }
    disposeRpc = ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload) => {
      return await dispatch(service, endpoint, payload)
    })
  } catch (error) {
    ctx?.logger?.warn?.('dshp-models: 无法注册连接 RPC 通道：%s', describeError(error))
  }
  if (typeof disposeRpc !== 'function') {
    try {
      disposeRpc = registerOwnRpcRoute(ctx, service)
    } catch (error) {
      ctx?.logger?.warn?.('dshp-models: 无法注册回退 RPC 路由：%s', describeError(error))
    }
  }
  if (typeof ctx?.effect === 'function') {
    try {
      ctx.effect(() => () => {
        try {
          if (typeof disposeRpc === 'function') disposeRpc()
        } catch (error) {
          ctx.logger?.warn?.('dshp-models: 注销 RPC 通道失败：%s', describeError(error))
        }
        service.dispose()
      }, 'dshp-models: rpc endpoint and pending sign-ins')
    } catch (error) {
      ctx.logger?.warn?.('dshp-models: 注册清理回调失败：%s', describeError(error))
    }
  }
  ctx?.logger?.info?.('dshp-models: 已注册模型登录通道 %s', CHANNEL)
}

export { Config }
export const name = 'dshp-models'
