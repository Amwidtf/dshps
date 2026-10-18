/**
 * dshp-quota — Host half.
 *
 * Reads the AI providers already configured in DSH (llm-pi-ai routes, the
 * official DeepSeek API-key route, and the signed-in DeepSeek account), resolves
 * their credentials through the harness credential seam, queries each vendor's
 * balance / subscription / team endpoint from this Host process, and exposes the
 * normalized snapshot to the Web client over the authenticated Connection RPC
 * channel `/dshp-quota`. Secrets never leave this process.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join as joinPath } from 'node:path'
import z from '@deepseek-ai/schemastery'

const CHANNEL = '/dshp-quota'
const DEFAULT_REFRESH_SECONDS = 60
const REQUEST_TIMEOUT_MS = 10_000
const HOST_VERSION = '0.1.1'

/**
 * Plugin configuration. Both sections are volatile, so Settings → dshps can
 * edit them live through the harness settings document without restarting the
 * plugin.
 */
const Config = z.object({
  team: z.object({
    zhipu: z.object({
      organization: z.string().default('').description('智谱 GLM 团队版组织 ID（bigmodel-organization）；留空表示只查询个人额度'),
      project: z.string().default('').description('智谱 GLM 团队版项目 ID（bigmodel-project）'),
      type: z.natural().default(2).description('团队额度查询的 type 参数，团队版通常为 2'),
    }).default({ organization: '', project: '', type: 2 }).description('智谱 GLM 团队版查询上下文').volatile(),
  }).default({ zhipu: { organization: '', project: '', type: 2 } }).description('各供应商团队版查询配置'),
  refreshIntervalSeconds: z.natural().min(15).max(3600).default(DEFAULT_REFRESH_SECONDS)
    .description('面板自动刷新间隔（秒，15–3600）').volatile(),
}).description('dshps 额度余额插件配置')

const VENDOR_LABELS = {
  deepseek: 'DeepSeek',
  minimax: 'MiniMax',
  zhipu: '智谱 GLM',
  kimi: 'Kimi',
  'kimi-code': 'Kimi Code',
}

const SUPPORTED_VENDORS = [
  { id: 'deepseek', label: VENDOR_LABELS.deepseek, capabilities: ['balance'] },
  { id: 'minimax', label: VENDOR_LABELS.minimax, capabilities: ['quota'] },
  { id: 'zhipu', label: VENDOR_LABELS.zhipu, capabilities: ['balance', 'quota', 'subscription', 'team'] },
  { id: 'kimi', label: VENDOR_LABELS.kimi, capabilities: ['balance', 'quota', 'subscription'] },
]

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse a money/quantity value that may arrive as a string. Empty/invalid is NOT zero. */
function num(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  if (text.length === 0) return undefined
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : undefined
}

function hostOf(url) {
  if (typeof url !== 'string' || url.length === 0) return ''
  try {
    return new URL(url).host.toLowerCase()
  } catch {
    return ''
  }
}

function originOf(url, fallback) {
  if (typeof url === 'string' && url.length > 0) {
    try {
      return new URL(url).origin
    } catch {
      /* fall through */
    }
  }
  return fallback
}

function mergeConfig(base, over) {
  if (!isRecord(base)) return isRecord(over) ? { ...over } : {}
  if (!isRecord(over)) return { ...base }
  const merged = { ...base }
  for (const [key, value] of Object.entries(over)) {
    merged[key] = isRecord(value) && isRecord(base[key]) ? mergeConfig(base[key], value) : value
  }
  return merged
}

/** Unwrap Schemastery live-config references (`config.providers.get()`) into plain values. */
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

/** The live resolved config of a loader entry, when the entry exposes one. */
function liveConfigOf(row) {
  try {
    return plainConfigLike(row?.entry?.fiber?.config)
  } catch {
    return undefined
  }
}

/** Current plain plugin config (volatile config refs resolved), always an object. */
function readConfig(config) {
  const plain = plainConfigLike(config)
  return isRecord(plain) ? plain : {}
}

function entryNameOf(entry) {
  return typeof entry?.options?.name === 'string' ? entry.options.name : ''
}

function timeoutSignal(parent) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), REQUEST_TIMEOUT_MS)
  const onAbort = () => controller.abort(parent?.reason)
  if (parent && typeof parent.addEventListener === 'function') {
    if (parent.aborted) controller.abort(parent.reason)
    else parent.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      if (parent && typeof parent.removeEventListener === 'function') parent.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * One GET returning `{ status, ok, json, text }`. Redirects are refused so a
 * vendor endpoint cannot bounce a bearer token to another origin.
 */
async function fetchJson(url, headers, parentSignal) {
  const gate = timeoutSignal(parentSignal)
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', ...headers },
      redirect: 'error',
      signal: gate.signal,
    })
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return { status: response.status, ok: response.ok, json, text: text.slice(0, 400) }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { status: 0, ok: false, json: undefined, text: message.slice(0, 400), networkError: true }
  } finally {
    gate.dispose()
  }
}

function failure(category, message, extra = {}) {
  return { error: { category, message, ...extra } }
}

function classifyHttp(response, label) {
  if (response.networkError) return failure('network', `${label} 请求失败：${response.text}`)
  if (response.status === 401 || response.status === 403) return failure('auth', `${label} 返回 ${response.status}，凭据无效或与站点不匹配`, { httpStatus: response.status })
  if (response.status === 404 || response.status === 405 || response.status === 410) return failure('endpoint-gone', `${label} 接口不可用（HTTP ${response.status}）`, { httpStatus: response.status })
  if (!response.ok) return failure('http', `${label} 返回 HTTP ${response.status}`, { httpStatus: response.status })
  return undefined
}

function currencySymbol(currency) {
  if (currency === 'CNY') return '¥'
  if (currency === 'USD') return '$'
  return typeof currency === 'string' ? `${currency} ` : ''
}

// ---------------------------------------------------------------------------
// vendor detection (provider id / display name / baseURL host only; key
// prefixes are used as a tie-breaker hint, never as the sole reason to send a key)
// ---------------------------------------------------------------------------

const HOST_RULES = [
  { test: (host) => host === 'api.deepseek.com' || host.endsWith('.deepseek.com'), vendor: 'deepseek' },
  { test: (host) => host.includes('minimax'), vendor: 'minimax' },
  { test: (host) => host.includes('bigmodel.cn') || host === 'api.z.ai' || host.endsWith('.z.ai') || host.includes('zhipu'), vendor: 'zhipu' },
  { test: (host) => host === 'api.kimi.com' || host.endsWith('.kimi.com'), vendor: 'kimi-code' },
  { test: (host) => host.includes('moonshot') || host.includes('kimi.ai'), vendor: 'kimi' },
]

function vendorFromHost(host) {
  for (const rule of HOST_RULES) if (rule.test(host)) return rule.vendor
  return undefined
}

function vendorFromId(text) {
  const id = String(text || '').toLowerCase()
  if (/^(deepseek|deepseek-(official|api|api-key))$/.test(id) || id.includes('deepseek')) return 'deepseek'
  if (id.includes('minimax')) return 'minimax'
  if (id.includes('kimi') && (id.includes('cod') || id.includes('coding'))) return 'kimi-code'
  if (id.includes('moonshot') || id.includes('kimi')) return 'kimi'
  if (id.includes('bigmodel') || id.includes('zhipu') || /(^|[-_])glm([-_]|$)/.test(id) || id === 'zai' || id === 'z-ai' || id.includes('zai-')) return 'zhipu'
  return undefined
}

function detectVendor(source, profile) {
  const byId = vendorFromId(source.providerId) || vendorFromId(profile?.displayName)
  const host = hostOf(source.baseURL)
  const byHost = vendorFromHost(host)
  const byPath = /\/coding(\/|$)/.test(String(source.baseURL || '')) ? (host.includes('kimi') ? 'kimi-code' : byHost === 'zhipu' ? 'zhipu' : undefined) : undefined
  if (byHost) {
    // A coding-plan baseURL on a known vendor host stays that vendor but is
    // queried through the matching plan endpoint.
    if (byHost === 'zhipu' && byPath) return { vendor: 'zhipu', detectedBy: 'host', coding: true }
    if (byHost === 'kimi-code') return { vendor: 'kimi-code', detectedBy: 'host', coding: true }
    return { vendor: byHost, detectedBy: 'host', coding: byPath === 'zhipu' }
  }
  if (byId) return { vendor: byId, detectedBy: 'providerId', coding: byId === 'kimi-code' }
  return { vendor: 'unknown', detectedBy: 'none', coding: false }
}

// ---------------------------------------------------------------------------
// discovery: reuse providers already configured in DSH
// ---------------------------------------------------------------------------

function readConfiguration(ctx) {
  try {
    const rows = ctx.configEditor?.configuration?.()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function readSettingsDescriptors(ctx) {
  try {
    const rows = ctx.settings?.describe?.()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function readCatalogDefaults(ctx) {
  const map = new Map()
  try {
    const entries = ctx.llm?.listConfigurableProviders?.()
    if (!Array.isArray(entries)) return map
    for (const entry of entries) {
      if (!isRecord(entry) || typeof entry.provider !== 'string') continue
      map.set(`${entry.settingsNs || ''}\u0000${entry.provider}`, entry)
    }
  } catch {
    /* catalog is optional */
  }
  return map
}

function readProviderRoutes(ctx) {
  try {
    const rows = ctx.llm?.listProviders?.()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

/** The derived key reference the Models page uses when a draft key has no explicit `apiKeyEnv`. */
function derivedKeyRef(providerId) {
  const id = String(providerId || '')
  const upper = id.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toUpperCase()
  return upper.length > 0 ? `${upper}_API_KEY` : undefined
}

function discover(ctx) {
  const rows = readConfiguration(ctx)
  const descriptors = readSettingsDescriptors(ctx)
  const descriptorByNs = new Map()
  for (const descriptor of descriptors) {
    if (isRecord(descriptor) && typeof descriptor.ns === 'string') descriptorByNs.set(descriptor.ns, descriptor)
  }
  const catalog = readCatalogDefaults(ctx)
  const routes = readProviderRoutes(ctx)
  const routeNames = new Set()
  for (const route of routes) {
    if (isRecord(route) && typeof route.provider === 'string') routeNames.add(route.provider)
  }

  const sources = []

  // 1) llm-pi-ai routes (Minimax / GLM / Kimi / any OpenAI-compatible route).
  const piAiRows = rows.filter((row) => entryNameOf(row?.entry).includes('dsh-llm-pi-ai'))
  const piAiIds = new Set(piAiRows.map((row) => row?.entry?.options?.id).filter((id) => typeof id === 'string'))
  const piAiValues = new Map()
  for (const ns of piAiIds) {
    const descriptor = descriptorByNs.get(ns)
    if (isRecord(descriptor?.value) && isRecord(descriptor.value.providers)) piAiValues.set(ns, descriptor.value.providers)
  }
  // Fallbacks when the settings mirror does not expose the pi-ai namespace:
  // first the entry's live resolved config, then the raw patch layers.
  for (const row of piAiRows) {
    const ns = row?.entry?.options?.id
    if (typeof ns !== 'string' || piAiValues.has(ns)) continue
    const live = liveConfigOf(row)
    if (isRecord(live) && isRecord(live.providers)) {
      piAiValues.set(ns, live.providers)
      continue
    }
    const inherited = isRecord(row.inherited) ? row.inherited : {}
    const override = isRecord(row.override) ? row.override : {}
    const own = isRecord(row?.entry?.options?.config) ? row.entry.options.config : {}
    const merged = mergeConfig(mergeConfig(inherited, own), override)
    if (isRecord(merged.providers)) piAiValues.set(ns, merged.providers)
  }
  for (const [ns, providers] of piAiValues) {
    for (const [providerId, rawProfile] of Object.entries(providers)) {
      if (!isRecord(rawProfile)) continue
      const catalogEntry = catalog.get(`${ns}\u0000${providerId}`)
      const baseURL = typeof rawProfile.baseURL === 'string' ? rawProfile.baseURL : catalogEntry?.defaultBaseURL
      const apiKeyEnv = typeof rawProfile.apiKeyEnv === 'string' ? rawProfile.apiKeyEnv : undefined
      const source = {
        id: `pi-ai:${providerId}`,
        mode: 'pi-ai',
        providerId,
        displayName: typeof rawProfile.displayName === 'string' ? rawProfile.displayName : providerId,
        baseURL: typeof baseURL === 'string' ? baseURL : undefined,
        api: typeof rawProfile.api === 'string' ? rawProfile.api : catalogEntry?.api,
        apiKeyEnv: apiKeyEnv || derivedKeyRef(providerId),
        headers: isRecord(rawProfile.headers) ? rawProfile.headers : undefined,
        settingsNs: ns,
        catalogEntry,
      }
      if (!routeNames.has(providerId) && catalogEntry === undefined) {
        // A dormant pi-ai route (kept in settings but not registered): still
        // worth showing, its balance API does not depend on model routing.
      }
      sources.push(source)
    }
  }

  // 2) The official DeepSeek API-key route.
  for (const row of rows) {
    if (entryNameOf(row?.entry) !== '@deepseek-ai/dsh-llm-deepseek-api-key') continue
    const ns = row?.entry?.options?.id
    const descriptor = typeof ns === 'string' ? descriptorByNs.get(ns) : undefined
    const inherited = isRecord(row.inherited) ? row.inherited : {}
    const override = isRecord(row.override) ? row.override : {}
    const own = isRecord(row?.entry?.options?.config) ? row.entry.options.config : {}
    const live = liveConfigOf(row)
    const value = isRecord(descriptor?.value)
      ? descriptor.value
      : isRecord(live)
        ? live
        : mergeConfig(mergeConfig(inherited, own), override)
    sources.push({
      id: 'deepseek-official',
      mode: 'deepseek-official',
      providerId: 'deepseek-official',
      displayName: 'DeepSeek API',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: typeof value.apiKeyEnv === 'string' && value.apiKeyEnv.length > 0 ? value.apiKeyEnv : 'DEEPSEEK_API_KEY',
      settingsNs: typeof ns === 'string' ? ns : undefined,
    })
  }

  // 3) The signed-in DeepSeek account (no API key involved).
  if (ctx.get && ctx.get('deepseekAccount')) {
    sources.push({
      id: 'deepseek-account',
      mode: 'deepseek-account',
      providerId: 'deepseek-account',
      displayName: 'DeepSeek 账户',
      baseURL: 'https://api.deepseek.com',
    })
  }

  // Drop duplicates (same provider route may surface through several entries).
  const seen = new Set()
  const unique = []
  for (const source of sources) {
    if (seen.has(source.id)) continue
    seen.add(source.id)
    unique.push(source)
  }
  return { sources: unique, rows, piAiIds: [...piAiIds], routes: [...routeNames] }
}

// ---------------------------------------------------------------------------
// credential resolution (never logged, never returned)
// ---------------------------------------------------------------------------

async function resolveApiKey(ctx, source) {
  if (source.mode === 'deepseek-account') return { account: true }
  if (typeof source.apiKeyEnv === 'string' && source.apiKeyEnv.length > 0) {
    try {
      const hit = await ctx.credentials?.resolve?.(source.apiKeyEnv)
      const value = typeof hit?.value === 'string' ? hit.value.trim() : ''
      if (value.length > 0) return { key: value, ref: source.apiKeyEnv }
    } catch {
      /* fall through to stored records */
    }
  }
  // A provider signed in through the Models page may keep its key in a record
  // in the `llm-pi-ai` scope rather than a reference.
  if (source.mode === 'pi-ai' && /^[a-z0-9][a-z0-9-]*$/.test(source.providerId)) {
    try {
      const record = await ctx.credentials?.readRecord?.(`llm-pi-ai/${source.providerId}`)
      if (isRecord(record) && record.kind === 'api-key' && typeof record.key === 'string' && record.key.length > 0) {
        return { key: record.key, ref: `llm-pi-ai/${source.providerId}` }
      }
    } catch {
      /* no record */
    }
  }
  return { missing: true, ref: source.apiKeyEnv }
}

// ---------------------------------------------------------------------------
// vendor adapters
// ---------------------------------------------------------------------------

function makeBalance(currency, fields) {
  const balance = { currency: currency || 'CNY' }
  for (const [key, raw] of Object.entries(fields)) {
    const parsed = num(raw)
    if (parsed !== undefined) balance[key] = parsed
  }
  return balance
}

async function queryDeepSeekApi(source, key, signal) {
  const origin = originOf(source.baseURL, 'https://api.deepseek.com')
  const response = await fetchJson(`${origin}/user/balance`, { Authorization: `Bearer ${key}` }, signal)
  const httpError = classifyHttp(response, 'DeepSeek 余额')
  if (httpError) return httpError
  const body = response.json
  if (!isRecord(body) || !Array.isArray(body.balance_infos)) {
    return failure('parse', 'DeepSeek 余额响应格式无法识别')
  }
  const balances = body.balance_infos
    .filter((info) => isRecord(info))
    .map((info) => makeBalance(info.currency, {
      total: info.total_balance,
      available: info.total_balance,
      granted: info.granted_balance,
      toppedUp: info.topped_up_balance,
    }))
  return {
    kind: 'balance',
    balances,
    availability: body.is_available === true,
    team: { isTeam: false, evidence: 'DeepSeek 无团队/订阅套餐' },
    source: { mode: source.mode, label: source.displayName, baseHost: hostOf(source.baseURL) },
  }
}

async function queryDeepSeekAccount(ctx, signal) {
  const service = ctx.get('deepseekAccount')
  if (!service) return failure('need-config', '当前配置未挂载 DeepSeek 账户服务')
  const client = {
    version: HOST_VERSION,
    locale: 'zh',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  }
  let state
  try {
    state = await service.getState()
  } catch (error) {
    return failure('http', `读取账户状态失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (state?.status === 'signed-out') return failure('need-config', '未登录 DeepSeek 账户')
  let result
  try {
    result = await service.getBalance(client)
  } catch (error) {
    return failure('http', `读取账户余额失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!result) return failure('need-config', '未登录 DeepSeek 账户')
  if (result.status === 'failed') return failure('http', 'DeepSeek 账户余额查询失败')
  const balances = []
  const wallets = Array.isArray(result.value) ? result.value : []
  for (const wallet of wallets) {
    if (!isRecord(wallet)) continue
    balances.push(makeBalance(wallet.currency, { total: wallet.balance, available: wallet.balance }))
  }
  const bonusWallets = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
  for (const wallet of bonusWallets) {
    if (!isRecord(wallet)) continue
    const amount = num(wallet.balance)
    if (amount === undefined || amount === 0) continue
    balances.push(makeBalance(wallet.currency, { granted: amount }))
  }
  return {
    kind: 'balance',
    balances,
    availability: balances.some((entry) => (entry.available ?? entry.total ?? 0) > 0),
    team: { isTeam: false, evidence: 'DeepSeek 无团队/订阅套餐' },
    note: '登录账户余额',
    source: { mode: 'deepseek-account', label: 'DeepSeek 账户', baseHost: 'platform.deepseek.com' },
  }
}

function kimiSite(source) {
  const host = hostOf(source.baseURL)
  if (host.includes('moonshot.ai') || host.includes('kimi.ai')) return { origin: 'https://api.moonshot.ai', currency: 'USD' }
  return { origin: 'https://api.moonshot.cn', currency: 'CNY' }
}

async function queryKimiBalance(source, key, signal) {
  const site = kimiSite(source)
  const response = await fetchJson(`${site.origin}/v1/users/me/balance`, { Authorization: `Bearer ${key}` }, signal)
  const httpError = classifyHttp(response, 'Kimi 余额')
  if (httpError) return httpError
  const body = response.json
  if (!isRecord(body) || (body.code !== undefined && body.code !== 0)) {
    return failure('http', `Kimi 余额返回业务错误（code=${body?.code ?? '?'}）`, { vendorCode: body?.code })
  }
  const data = isRecord(body.data) ? body.data : undefined
  if (!data) return failure('parse', 'Kimi 余额响应缺少 data')
  const available = num(data.available_balance)
  if (available === undefined) return failure('parse', 'Kimi 余额响应缺少 available_balance')
  return {
    kind: 'balance',
    balances: [makeBalance(site.currency, {
      total: available,
      available,
      cash: data.cash_balance,
      voucher: data.voucher_balance,
    })],
    availability: available > 0,
    team: { isTeam: 'unknown', evidence: '组织下项目共享账户余额，接口不区分团队' },
    note: '账户共享余额',
    source: { mode: source.mode, label: source.displayName, baseHost: hostOf(source.baseURL) || site.origin },
  }
}

function parseIsoTime(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}

/** Read a { currency, priceInCents } / { amount, unit } money object, or a plain amount. */
function moneyOf(value) {
  if (isRecord(value)) {
    const cents = num(value.priceInCents) ?? num(value.price_in_cents) ?? num(value.amount)
    if (cents !== undefined) {
      return {
        amount: cents / 100,
        currency: typeof value.currency === 'string' ? value.currency : undefined,
        rawCents: cents,
      }
    }
    return undefined
  }
  const amount = num(value)
  return amount === undefined ? undefined : { amount, currency: undefined }
}

function ratioPercent(value) {
  const ratio = num(value)
  if (ratio === undefined) return undefined
  return Math.min(100, Math.max(0, ratio * 100))
}

async function queryKimiCode(source, key, signal) {
  const response = await fetchJson('https://api.kimi.com/coding/v1/usages', { Authorization: `Bearer ${key}` }, signal)
  const httpError = classifyHttp(response, 'Kimi Code 用量')
  if (httpError) return httpError
  const body = response.json
  if (!isRecord(body)) return failure('parse', 'Kimi Code 用量响应格式无法识别')
  const windows = []
  const ratios = isRecord(body.usages) ? body.usages : {}

  // Weekly window: `usage` carries absolute numbers; `usages.limit_7d` may carry
  // only a used ratio on other plan revisions.
  const weekly = isRecord(body.usage) ? body.usage : undefined
  if (weekly) {
    const limit = num(weekly.limit)
    const remaining = num(weekly.remaining)
    const used = num(weekly.used) ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined)
    windows.push({
      key: 'weekly',
      label: '每周',
      limit,
      remaining,
      used,
      usedPercent: limit && used !== undefined ? Math.min(100, Math.max(0, (used / limit) * 100)) : ratioPercent(ratios.limit_7d?.used_ratio),
      resetsAt: parseIsoTime(weekly.resetTime),
      unitHint: 'percent',
    })
  } else if (isRecord(ratios.limit_7d)) {
    windows.push({
      key: 'weekly',
      label: '每周',
      usedPercent: ratioPercent(ratios.limit_7d.used_ratio),
      resetsAt: parseIsoTime(ratios.limit_7d.reset_time),
      unitHint: 'percent',
    })
  }

  // Rolling windows (5h on the current plan revision).
  const limits = Array.isArray(body.limits) ? body.limits : []
  for (const entry of limits) {
    if (!isRecord(entry)) continue
    const window = isRecord(entry.window) ? entry.window : undefined
    const detail = isRecord(entry.detail) ? entry.detail : undefined
    if (!detail) continue
    const limit = num(detail.limit)
    const remaining = num(detail.remaining)
    const used = num(detail.used) ?? (limit !== undefined && remaining !== undefined ? limit - remaining : undefined)
    const minutes = num(window?.duration)
    const label = window?.timeUnit === 'TIME_UNIT_MINUTE' && minutes ? `${Math.round(minutes / 60)} 小时` : '滚动窗口'
    windows.push({
      key: 'interval',
      label,
      limit,
      remaining,
      used,
      usedPercent: limit && used !== undefined ? Math.min(100, Math.max(0, (used / limit) * 100)) : ratioPercent(ratios.limit_5h?.used_ratio),
      resetsAt: parseIsoTime(detail.resetTime),
      unitHint: 'percent',
    })
  }
  if (windows.length === 0 && isRecord(ratios.limit_5h)) {
    windows.push({
      key: 'interval',
      label: '5 小时',
      usedPercent: ratioPercent(ratios.limit_5h.used_ratio),
      resetsAt: parseIsoTime(ratios.limit_5h.reset_time),
      unitHint: 'percent',
    })
  }

  const level = typeof body.user?.membership?.level === 'string'
    ? body.user.membership.level
    : typeof body.membership?.level === 'string'
      ? body.membership.level
      : undefined
  const planName = mapKimiLevel(level)

  // Booster wallet is a separate prepaid/accelerator system, NOT the monthly
  // quota — label it separately and never treat it as the monthly allowance.
  const booster = isRecord(body.booster_wallet) ? body.booster_wallet : isRecord(body.boosterWallet) ? body.boosterWallet : undefined
  const boosterLimit = moneyOf(booster?.monthlyChargeLimit ?? booster?.monthly_charge_limit)
  const boosterUsed = moneyOf(booster?.monthlyUsed ?? booster?.monthly_used)
  if (boosterLimit && boosterLimit.amount > 0) {
    const used = boosterUsed?.amount ?? 0
    windows.push({
      key: 'booster',
      label: '加速包',
      limit: boosterLimit.amount,
      used,
      usedPercent: Math.min(100, Math.max(0, (used / boosterLimit.amount) * 100)),
      money: boosterLimit.currency || 'CNY',
      unitHint: 'credits',
    })
  }
  const parallel = num(body.parallel?.limit)
  if (parallel !== undefined) windows.push({ key: 'parallel', label: '并发上限', limit: parallel, unitHint: 'calls' })
  if (windows.length === 0) return failure('no-plan', 'Kimi Code 未检测到订阅额度窗口')
  return {
    kind: 'quota',
    windows,
    plan: planName ? { name: planName, tier: level, source: 'api' } : { name: 'Kimi Code', source: 'inferred' },
    team: { isTeam: 'unknown' },
    note: '订阅用量',
    source: { mode: source.mode, label: source.displayName, baseHost: hostOf(source.baseURL) || 'api.kimi.com' },
  }
}

function mapKimiLevel(level) {
  if (typeof level !== 'string') return undefined
  const map = {
    LEVEL_BASIC: 'Kimi Code Basic',
    LEVEL_INTERMEDIATE: 'Kimi Code Intermediate',
    LEVEL_ADVANCED: 'Kimi Code Advanced',
    LEVEL_PRO: 'Kimi Code Pro',
  }
  return map[level] || level.replace(/^LEVEL_/, 'Kimi Code ')
}

// ---------------------------------------------------------------------------
// Kimi monthly allowance (web membership gateway; needs a web login token)
// ---------------------------------------------------------------------------

const KIMI_WEB_STATS_URL = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats'
const KIMI_WEB_SUBSCRIPTION_URL = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription'
const KIMI_WEB_REFRESH_URL = 'https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken'

/** Decode a JWT payload without verifying it (only used to mirror session headers). */
function jwtPayload(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return undefined
  try {
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
  } catch {
    return undefined
  }
}

/** Accept a bare JWT, `Bearer …`, `Authorization: …` or a `kimi-auth=` cookie value. */
function normalizeKimiWebToken(input) {
  let raw = typeof input === 'string' ? input.trim() : ''
  if (raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))) {
    raw = raw.slice(1, -1).trim()
  }
  if (raw.length === 0) return undefined
  const authAt = raw.toLowerCase().indexOf('authorization:')
  if (authAt >= 0) raw = raw.slice(authAt + 'authorization:'.length).trim()
  raw = raw.replace(/^bearer\s+/i, '').trim()
  const cookieAt = raw.toLowerCase().indexOf('kimi-auth=')
  if (cookieAt >= 0) raw = raw.slice(cookieAt + 'kimi-auth='.length).split(';')[0].trim()
  if (raw.length === 0 || /\s/.test(raw)) return undefined
  return raw
}

/**
 * Kimi web token storage: Windows DPAPI-encrypted file under the DSH profile
 * (only the current Windows user can decrypt it), with the DSH credential store
 * and process memory as fallbacks. The plain token never reaches the project or
 * the plugin configuration.
 */
/** Resolve the DPAPI token file lazily so tests/embedders can disable or override it. */
function kimiTokenFile() {
  if (process.env.DSHPS_DISABLE_TOKEN_FILE === '1') return undefined
  const override = process.env.DSHPS_KIMI_TOKEN_FILE
  if (typeof override === 'string' && override.length > 0) return override
  let home
  try {
    home = process.env.DSH_HOME || joinPath(homedir(), '.dsh')
  } catch {
    return undefined
  }
  if (typeof home !== 'string' || home.length === 0) return undefined
  return joinPath(home, 'dshps', 'kimi-token.dat')
}

function runPowerShell(script, extraEnv) {
  return new Promise((resolve) => {
    try {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { env: { ...process.env, ...(extraEnv || {}) }, windowsHide: true, timeout: 8000 },
        (error, stdout) => resolve(error ? undefined : String(stdout).trim()),
      )
    } catch {
      resolve(undefined)
    }
  })
}

async function writeEncryptedKimiToken(secret) {
  const file = kimiTokenFile()
  if (!file || process.platform !== 'win32') return false
  const encrypted = await runPowerShell(
    '$s = ConvertTo-SecureString -String $env:DSHPS_TOKEN -AsPlainText -Force; ConvertFrom-SecureString $s',
    { DSHPS_TOKEN: secret },
  )
  if (typeof encrypted !== 'string' || encrypted.length === 0) return false
  try {
    await fsp.mkdir(dirname(file), { recursive: true })
    await fsp.writeFile(file, encrypted, 'utf8')
    return true
  } catch {
    return false
  }
}

async function readEncryptedKimiToken() {
  const file = kimiTokenFile()
  if (!file || !existsSync(file)) return undefined
  const raw = await runPowerShell(
    `$s = ConvertTo-SecureString -String (Get-Content -Raw -LiteralPath '${file.replace(/'/g, "''")}') -ErrorAction Stop; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); [Runtime.InteropServices.Marshal]::PtrToStringAuto($b)`,
  )
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

function isJwtToken(token) {
  return typeof token === 'string' && token.split('.').length === 3
}

function jwtExpiryMs(token) {
  const payload = jwtPayload(token)
  return isRecord(payload) && typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
}

/** Parse the stored secret: JSON session record, bare JWT access token, or opaque refresh token. */
function parseKimiTokenRecord(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  try {
    const value = JSON.parse(raw)
    if (isRecord(value)) {
      return {
        refreshToken: typeof value.refreshToken === 'string' && value.refreshToken.length > 0 ? value.refreshToken : undefined,
        accessToken: typeof value.accessToken === 'string' && value.accessToken.length > 0 ? value.accessToken : undefined,
        accessExpiresAt: typeof value.accessExpiresAt === 'number' ? value.accessExpiresAt : undefined,
      }
    }
  } catch {
    /* not a JSON record */
  }
  const token = normalizeKimiWebToken(raw)
  if (!token) return undefined
  return isJwtToken(token) ? { accessToken: token, accessExpiresAt: jwtExpiryMs(token) } : { refreshToken: token }
}

/** Exchange a web refresh_token for a new access token (refresh token rotates). */
async function refreshKimiWebSession(refreshToken) {
  const gate = timeoutSignal(undefined)
  try {
    const response = await fetch(KIMI_WEB_REFRESH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Origin: 'https://www.kimi.com',
        Referer: 'https://www.kimi.com/code/console',
        'connect-protocol-version': '1',
        'x-msh-platform': 'web',
      },
      body: JSON.stringify({ refresh_token: refreshToken }),
      redirect: 'error',
      signal: gate.signal,
    })
    const text = await response.text()
    if (response.status === 401 || response.status === 403) {
      return { error: { category: 'auth', message: 'refresh_token 已失效，请重新登录 Kimi 网页后复制新的 refresh_token' } }
    }
    if (!response.ok) return { error: { category: 'http', message: `Kimi token 续期返回 HTTP ${response.status}` } }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      return { error: { category: 'parse', message: 'Kimi token 续期响应无法解析' } }
    }
    const root = isRecord(body?.data) ? body.data : body
    const pick = (names) => names.map((name) => root?.[name]).find((value) => typeof value === 'string' && value.length > 0)
    const accessToken = pick(['accessToken', 'access_token'])
    const nextRefresh = pick(['refreshToken', 'refresh_token'])
    if (!accessToken || !nextRefresh) {
      return { error: { category: 'parse', message: 'Kimi token 续期响应缺少 accessToken / refreshToken' } }
    }
    const expiresIn = num(root?.expires_in) ?? num(root?.expiresIn)
    const expiresAt = expiresIn !== undefined ? Date.now() + expiresIn * 1000 : jwtExpiryMs(accessToken) ?? Date.now() + 14 * 60_000
    return { accessToken, refreshToken: nextRefresh, expiresAt }
  } catch (error) {
    return { error: { category: 'network', message: `Kimi token 续期请求失败：${error instanceof Error ? error.message : String(error)}` } }
  } finally {
    gate.dispose()
  }
}

async function removeEncryptedKimiToken() {
  const file = kimiTokenFile()
  if (!file) return
  try {
    await fsp.rm(file, { force: true })
  } catch {
    /* optional */
  }
}

function kimiTokenFileExists() {
  try {
    const file = kimiTokenFile()
    return file !== undefined && existsSync(file)
  } catch {
    return false
  }
}

function kimiWebHeaders(token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Cookie: `kimi-auth=${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Origin: 'https://www.kimi.com',
    Referer: 'https://www.kimi.com/code/console',
    'connect-protocol-version': '1',
    'x-msh-platform': 'web',
  }
  const payload = jwtPayload(token)
  if (isRecord(payload)) {
    if (typeof payload.device_id === 'string' && payload.device_id.length > 0) headers['x-msh-device-id'] = payload.device_id
    if (typeof payload.ssid === 'string' && payload.ssid.length > 0) headers['x-msh-session-id'] = payload.ssid
    if (typeof payload.sub === 'string' && payload.sub.length > 0) headers['x-traffic-id'] = payload.sub
  }
  return headers
}

async function kimiWebPost(url, token, signal) {
  const gate = timeoutSignal(signal)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: kimiWebHeaders(token),
      body: '{}',
      redirect: 'error',
      signal: gate.signal,
    })
    const text = await response.text()
    let json
    try { json = JSON.parse(text) } catch {}
    return { status: response.status, ok: response.ok, json, text: text.slice(0, 300) }
  } catch (error) {
    return { status: 0, ok: false, networkError: true, text: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
  } finally {
    gate.dispose()
  }
}

/** Ratios arrive as fractions (≤1 → ×100) or already-percent values. */
function kimiRatioToPct(value) {
  const ratio = num(value)
  if (ratio === undefined) return undefined
  return ratio <= 1 ? ratio * 100 : ratio
}

/** Kimi monthly total allowance via the membership gateway (web session token). */
async function queryKimiMonthly(token, signal) {
  const response = await kimiWebPost(KIMI_WEB_STATS_URL, token, signal)
  if (response.networkError) return { error: { category: 'network', message: `Kimi 月额度请求失败：${response.text}` } }
  if (response.status === 401 || response.status === 403) return { error: { category: 'auth', message: 'Kimi 网页登录态无效或已过期（HTTP ' + response.status + '）' } }
  if (!response.ok) return { error: { category: response.status === 404 ? 'endpoint-gone' : 'http', message: `Kimi 月额度返回 HTTP ${response.status}` } }
  const body = response.json
  const root = isRecord(body?.data) ? body.data : body
  const balance = isRecord(root?.subscriptionBalance)
    ? root.subscriptionBalance
    : isRecord(root?.subscription_balance)
      ? root.subscription_balance
      : undefined
  if (!balance) return { error: { category: 'parse', message: '月额度响应缺少 subscriptionBalance' } }
  const feature = typeof balance.feature === 'string' ? balance.feature : ''
  const kind = typeof balance.type === 'string' ? balance.type : ''
  if ((feature.length > 0 && feature !== 'FEATURE_OMNI') || (kind.length > 0 && kind !== 'SUBSCRIPTION')) {
    return { error: { category: 'parse', message: `月额度响应类型不可信（feature=${feature || '-'}, type=${kind || '-'}）` } }
  }
  const totalRaw = kimiRatioToPct(balance.amountUsedRatio ?? balance.amount_used_ratio ?? balance.usedRatio ?? balance.used_ratio)
  if (totalRaw === undefined) return { error: { category: 'parse', message: '月额度响应缺少 amountUsedRatio' } }
  const codeRaw = kimiRatioToPct(balance.kimiCodeUsedRatio ?? balance.kimi_code_used_ratio) ?? 0
  const totalPct = Math.min(100, Math.max(0, totalRaw))
  const codePct = Math.min(100, Math.max(0, codeRaw))
  const resetRaw = balance.expireTime ?? balance.expire_time
  return {
    monthly: {
      totalPct,
      codePct,
      kimiPct: Math.max(0, totalPct - codePct),
      resetsAt: parseIsoTime(resetRaw),
    },
  }
}

/** Membership level from the web subscription endpoint (best effort). */
async function queryKimiMembership(token, signal) {
  const response = await kimiWebPost(KIMI_WEB_SUBSCRIPTION_URL, token, signal)
  if (!response.ok || !isRecord(response.json)) return undefined
  const root = isRecord(response.json.data) ? response.json.data : response.json
  const subscription = isRecord(root.subscription) ? root.subscription : undefined
  const goods = isRecord(subscription?.goods) ? subscription.goods : undefined
  const level = typeof goods?.membershipLevel === 'string'
    ? goods.membershipLevel
    : typeof goods?.membership_level === 'string'
      ? goods.membership_level
      : undefined
  if (level) return { level, title: typeof goods?.title === 'string' ? goods.title : undefined }
  if (typeof goods?.title === 'string' && goods.title.length > 0) return { level: undefined, title: goods.title }
  return undefined
}

function minimaxOrigins(source) {
  const host = hostOf(source.baseURL)
  if (host.includes('minimax.io')) return ['https://www.minimax.io', 'https://api.minimax.io']
  if (host.includes('minimax.cn') || host.includes('minimaxi.com') || host.includes('minimax.chat')) {
    return ['https://www.minimax.cn', 'https://api.minimaxi.com']
  }
  return ['https://www.minimax.cn', 'https://api.minimaxi.com', 'https://www.minimax.io', 'https://api.minimax.io']
}

function minimaxWindows(body) {
  const windows = []
  const remains = Array.isArray(body?.model_remains) ? body.model_remains : []
  for (const bucket of remains) {
    if (!isRecord(bucket)) continue
    const modelName = typeof bucket.model_name === 'string' ? bucket.model_name : 'general'
    const label = modelName === 'general' ? '文本' : modelName === 'video' ? '视频' : modelName
    const intervalRemaining = num(bucket.current_interval_remaining_percent)
    if (intervalRemaining !== undefined && bucket.current_interval_status !== 0) {
      const start = num(bucket.start_time)
      const end = num(bucket.end_time)
      const hours = start !== undefined && end !== undefined && end > start ? Math.round((end - start) / 3_600_000) : undefined
      windows.push({
        key: 'interval',
        label: hours ? `${label} ${hours} 小时` : `${label} 窗口`,
        remainingPercent: Math.min(100, Math.max(0, intervalRemaining)),
        unitHint: 'percent',
        resetsAt: end ?? undefined,
      })
    }
    const weeklyStatus = bucket.current_weekly_status
    const weeklyRemaining = num(bucket.current_weekly_remaining_percent)
    if (weeklyRemaining !== undefined && weeklyStatus !== 0) {
      windows.push({
        key: 'weekly',
        label: `${label} 每周`,
        remainingPercent: Math.min(100, Math.max(0, weeklyRemaining)),
        unitHint: 'percent',
        resetsAt: num(bucket.weekly_end_time) ?? undefined,
      })
    }
  }
  return windows
}

function minimaxPlanName(body) {
  const candidates = [body?.current_subscribe_title, body?.plan_name, body?.plan?.name, body?.subscribe_title]
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  return undefined
}

async function queryMinimaxPlan(source, key, signal) {
  const paths = ['/v1/token_plan/remains', '/v1/api/openplatform/coding_plan/remains']
  let lastError
  for (const origin of minimaxOrigins(source)) {
    for (const path of paths) {
      const response = await fetchJson(`${origin}${path}`, { Authorization: `Bearer ${key}` }, signal)
      if (response.networkError) { lastError = failure('network', `MiniMax 请求失败：${response.text}`); continue }
      if (response.status === 401 || response.status === 403) { lastError = failure('auth', 'MiniMax 鉴权失败（订阅 Key 与站点需匹配）', { httpStatus: response.status }); continue }
      if (!response.ok) { lastError = failure(response.status === 404 ? 'endpoint-gone' : 'http', `MiniMax 返回 HTTP ${response.status}`, { httpStatus: response.status }); continue }
      const body = response.json
      if (!isRecord(body)) { lastError = failure('parse', 'MiniMax 响应格式无法识别'); continue }
      const code = num(body.base_resp?.status_code)
      if (code !== undefined && code !== 0) {
        if (code === 2062) {
          lastError = failure('no-plan', 'MiniMax 未检测到有效 M Plan / Token Plan（该 Key 可能为按量付费 Key）', { vendorCode: code })
        } else if (code === 1004 || code === 2049) {
          lastError = failure('auth', `MiniMax 鉴权失败（code=${code}）`, { vendorCode: code })
        } else {
          lastError = failure('http', `MiniMax 业务错误（code=${code}：${body.base_resp?.status_msg || ''}）`, { vendorCode: code })
        }
        continue
      }
      const windows = minimaxWindows(body)
      if (windows.length === 0) { lastError = failure('no-plan', 'MiniMax 未返回套餐额度窗口'); continue }
      return {
        kind: 'quota',
        windows,
        plan: minimaxPlanName(body) ? { name: minimaxPlanName(body), source: 'api' } : undefined,
        team: { isTeam: 'unknown', evidence: '企业团队为主账号+子账号，无公开团队查询 API' },
        note: 'M Plan 订阅额度',
        source: { mode: source.mode, label: source.displayName, baseHost: hostOf(source.baseURL) || origin },
      }
    }
  }
  return lastError || failure('unsupported', 'MiniMax 暂无可用查询接口')
}

function zhipuOrigin(source) {
  const host = hostOf(source.baseURL)
  if (host === 'api.z.ai' || host.endsWith('.z.ai')) return 'https://api.z.ai'
  return 'https://open.bigmodel.cn'
}

function zhipuTeamContext(ctx, source, config) {
  const configured = config?.team?.zhipu
  const headers = isRecord(source.headers) ? source.headers : {}
  const pick = (name) => {
    const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name)
    return typeof entry?.[1] === 'string' ? entry[1] : undefined
  }
  const organization = typeof configured?.organization === 'string' && configured.organization.length > 0
    ? configured.organization
    : pick('bigmodel-organization')
  const project = typeof configured?.project === 'string' && configured.project.length > 0
    ? configured.project
    : pick('bigmodel-project')
  const type = configured?.type !== undefined ? String(configured.type) : undefined
  if (!organization && !project) return undefined
  return { organization, project, type: type || '2' }
}

function zhipuAuthVariants(key) {
  return [
    { label: 'bearer', headers: { Authorization: `Bearer ${key}` } },
    { label: 'raw', headers: { Authorization: key } },
  ]
}

async function zhipuGet(origin, path, variants, context, signal) {
  let last
  for (const variant of variants) {
    const url = `${origin}${path}${context ? `?type=${encodeURIComponent(context.type)}` : ''}`
    const headers = { ...variant.headers }
    if (context?.organization) headers['bigmodel-organization'] = context.organization
    if (context?.project) headers['bigmodel-project'] = context.project
    const response = await fetchJson(url, headers, signal)
    const httpError = classifyHttp(response, `智谱 ${path}`)
    if (httpError) { last = httpError; continue }
    const body = response.json
    if (!isRecord(body)) { last = failure('parse', `智谱 ${path} 响应格式无法识别`); continue }
    const code = num(body.code)
    if (body.success === false || (code !== undefined && code !== 200 && code !== 0)) {
      const message = typeof body.msg === 'string' && body.msg.length > 0 ? body.msg : typeof body.message === 'string' ? body.message : `code=${body.code ?? '?'}`
      last = failure('http', `智谱业务错误：${message}`, { vendorCode: body.code })
      continue
    }
    return { body, variant: variant.label, context: context ? 'team' : 'personal' }
  }
  return { error: last || failure('unsupported', `智谱 ${path} 不可用`) }
}

function zhipuWindows(limits) {
  const windows = []
  for (const limit of Array.isArray(limits) ? limits : []) {
    if (!isRecord(limit)) continue
    const type = limit.type
    const usedPercent = num(limit.percentage)
    if (type === 'TIME_LIMIT') {
      const details = Array.isArray(limit.usageDetails)
        ? limit.usageDetails.filter((entry) => isRecord(entry)).map((entry) => ({ name: String(entry.modelCode ?? ''), usage: num(entry.usage) ?? 0 }))
        : undefined
      windows.push({
        key: 'tools',
        label: '工具调用',
        limit: num(limit.usage),
        used: num(limit.currentValue),
        remaining: num(limit.remaining),
        usedPercent: usedPercent,
        resetsAt: num(limit.nextResetTime),
        unitHint: 'calls',
        details,
      })
      continue
    }
    if (type !== 'TOKENS_LIMIT' && type !== 'CREDIT_LIMIT') continue
    const unit = num(limit.unit)
    const count = num(limit.number)
    const label = unit === 3
      ? `${type === 'CREDIT_LIMIT' ? '5 小时额度' : `Token ${count || 5} 小时`}`
      : unit === 6
        ? `${type === 'CREDIT_LIMIT' ? '每周额度' : 'Token 每周'}`
        : '额度'
    const resetAt = num(limit.nextResetTime) ?? num(limit.resetTime) ?? num(limit.resetAt) ?? parseIsoTime(limit.nextResetTime ?? limit.resetTime ?? limit.resetAt)
    windows.push({
      key: unit === 6 ? 'weekly' : 'interval',
      label,
      limit: num(limit.usage),
      used: num(limit.currentValue),
      remaining: num(limit.remaining),
      usedPercent,
      resetsAt: resetAt,
      unitHint: type === 'CREDIT_LIMIT' ? 'credits' : 'tokens',
    })
  }
  return windows
}

/** Active prepaid token / call packages (they carry expiration and remaining units). */
async function zhipuTokenPackages(origin, variants, signal) {
  for (const variant of variants) {
    const response = await fetchJson(`${origin}/api/biz/tokenAccounts/list/my`, { ...variant.headers }, signal)
    if (!response.ok || !isRecord(response.json)) continue
    const rows = Array.isArray(response.json.rows) ? response.json.rows : []
    return rows.filter((row) => isRecord(row) && row.status !== 'EXPIRED' && (num(row.availableBalance) ?? 0) > 0)
  }
  return []
}

function zhipuPackageWindows(rows) {
  return rows.slice(0, 6).map((row) => {
    const total = num(row.tokenBalance) ?? num(row.availableBalance) ?? 0
    const remaining = num(row.availableBalance) ?? 0
    const used = Math.max(0, total - remaining)
    const name = typeof row.resourcePackageName === 'string' ? row.resourcePackageName : '资源包'
    return {
      key: 'package',
      label: `资源包 · ${name}`.slice(0, 46),
      limit: total,
      remaining,
      used,
      usedPercent: total > 0 ? Math.min(100, (used / total) * 100) : undefined,
      resetsAt: parseIsoTime(row.expirationTime),
      unitHint: row.consumeType === 'TIMES' ? 'calls' : 'tokens',
    }
  })
}

async function queryZhipu(source, key, ctx, config, signal) {
  const origin = zhipuOrigin(source)
  const teamContext = zhipuTeamContext(ctx, source, config)
  const variants = zhipuAuthVariants(key)
  // A coding-plan route only exposes quota; the cash wallet belongs to the
  // standard API route and must not be mixed into this card.
  const codingPlanSource = /\/coding(\/|$)/i.test(String(source.baseURL || '')) || /coding/i.test(String(source.providerId || ''))
  const result = { kind: 'mixed', windows: [], balances: [], plan: undefined, team: { isTeam: 'unknown' } }
  const errors = []
  const notes = []

  // Subscription name / renewal / explicit team flag.
  for (const variant of variants) {
    const response = await fetchJson(`${origin}/api/biz/subscription/list`, { ...variant.headers }, signal)
    if (!response.ok || !isRecord(response.json)) { errors.push(classifyHttp(response, '智谱订阅') || failure('http', '智谱订阅接口失败')); continue }
    const body = response.json
    const list = Array.isArray(body.data) ? body.data : []
    const active = list.find((entry) => isRecord(entry) && (entry.inCurrentPeriod === true || entry.status === 'VALID')) || list.find((entry) => isRecord(entry))
    if (active) {
      const productName = typeof active.productName === 'string' ? active.productName : undefined
      const renewalAt = typeof active.nextRenewTime === 'string' ? Date.parse(active.nextRenewTime) : undefined
      if (productName) {
        result.plan = { name: productName, tier: typeof active.billingCycle === 'string' ? active.billingCycle : undefined, renewalAt: Number.isFinite(renewalAt) ? renewalAt : undefined, source: 'api' }
        if (/团队|team/i.test(productName)) result.team = { isTeam: true, evidence: '订阅名称包含团队标识' }
      }
    }
    break
  }

  // Coding-plan quotas: try the configured team context first, then the
  // personal key. An empty team response falls through instead of claiming team.
  let quota
  let noCodingPlan = false
  const attempts = teamContext ? [teamContext, undefined] : [undefined]
  for (const context of attempts) {
    const attempt = await zhipuGet(origin, '/api/monitor/usage/quota/limit', variants, context, signal)
    if (attempt.error) {
      errors.push(attempt.error)
      if (/coding.?plan/i.test(attempt.error.error?.message || '')) noCodingPlan = true
      continue
    }
    const limits = attempt.body?.data?.limits
    if (Array.isArray(limits) && limits.length > 0) {
      quota = { ...attempt, team: context !== undefined }
      break
    }
    if (context !== undefined) notes.push('团队上下文未返回额度，请检查组织/项目')
  }
  if (quota) {
    result.windows = zhipuWindows(quota.body?.data?.limits)
    const data = isRecord(quota.body?.data) ? quota.body.data : undefined
    const planCandidates = [data?.planName, data?.productName, data?.subscribeTitle, data?.level, data?.plan?.name]
    const rawPlan = planCandidates.find((candidate) => typeof candidate === 'string' && candidate.trim().length > 0)
    if (rawPlan) result.plan = { name: normalizeZhipuPlan(rawPlan.trim()), source: 'api' }
    result.team = quota.team
      ? { isTeam: true, evidence: '组织/项目上下文查询成功' }
      : { isTeam: 'unknown' }
  }

  // Cash balance only for the standard API-key route.
  if (!codingPlanSource) {
    for (const variant of variants) {
      const response = await fetchJson(`${origin}/api/biz/account/query-customer-account-report`, { ...variant.headers }, signal)
      if (!response.ok || !isRecord(response.json)) { errors.push(classifyHttp(response, '智谱余额') || failure('http', '智谱余额接口失败')); continue }
      const data = isRecord(response.json.data) ? response.json.data : undefined
      if (data) {
        const balance = makeBalance('CNY', {
          total: data.balance,
          available: data.availableBalance,
          toppedUp: data.rechargeAmount,
          granted: data.giveAmount,
          used: data.totalSpendAmount,
          frozen: data.frozenBalance,
        })
        if (Object.keys(balance).length > 1) result.balances.push(balance)
      }
      break
    }
  }

  if (noCodingPlan) notes.push('未检测到 Coding Plan。团队版请在设置里填写组织/项目。')

  // Prepaid resource packages, only when no Coding Plan windows exist.
  if (result.windows.length === 0) {
    const packages = await zhipuTokenPackages(origin, variants, signal)
    if (packages.length > 0) result.windows = zhipuPackageWindows(packages)
  }

  if (result.windows.length === 0 && result.balances.length === 0 && !result.plan) {
    const authOnly = errors.length > 0 && errors.every((error) => error?.error?.category === 'auth')
    if (authOnly) return failure('auth', '智谱鉴权失败：Key 与套餐类型不匹配')
    if (codingPlanSource && noCodingPlan) {
      return failure('no-plan', '未检测到 Coding Plan；团队版请在设置里填写 GLM 组织/项目')
    }
    if (teamContext === undefined && noCodingPlan) {
      return failure('need-context', '未检测到 Coding Plan；团队版请在设置里填写 GLM 组织/项目')
    }
    return errors[0] || failure('unsupported', '智谱暂无可查询的数据')
  }
  if (result.windows.length > 0) result.kind = result.balances.length > 0 ? 'mixed' : 'quota'
  else if (result.balances.length > 0) result.kind = 'balance'
  else result.kind = 'mixed'
  if (notes.length > 0) result.note = notes.join('；')
  result.source = { mode: source.mode, label: source.displayName, baseHost: hostOf(source.baseURL) || origin }
  return result
}

/** Turn raw subscription/plan identifiers into a readable GLM Coding plan name. */
function normalizeZhipuPlan(name) {
  const trimmed = String(name).trim()
  const tier = trimmed.toLowerCase()
  if (/^(max|pro|lite|air|plus)$/.test(tier)) return `GLM Coding ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`
  if (/^glm/i.test(trimmed)) return trimmed
  return trimmed
}

// ---------------------------------------------------------------------------
// orchestration
// ---------------------------------------------------------------------------

function vendorOfNormalized(source) {
  if (source.mode === 'deepseek-account' || source.mode === 'deepseek-official') {
    return { vendor: 'deepseek', detectedBy: 'mode', coding: false }
  }
  return detectVendor(source, { displayName: source.displayName })
}

function providerLabel(vendor, displayName) {
  if (displayName && displayName.trim().length > 0) return displayName
  return VENDOR_LABELS[vendor] || '未知供应商'
}

async function queryOne(ctx, source, config, signal) {
  const detected = vendorOfNormalized(source)
  const vendor = detected.vendor
  const credentials = await resolveApiKey(ctx, source)
  const base = {
    id: source.id,
    vendor,
    vendorLabel: VENDOR_LABELS[vendor] || vendor,
    label: providerLabel(vendor, source.displayName),
    mode: source.mode,
    providerId: source.providerId,
    detectedBy: detected.detectedBy,
    fetchedAt: Date.now(),
  }
  if (source.mode === 'deepseek-account') {
    const result = await queryDeepSeekAccount(ctx, signal)
    return { ...base, ...normalizeResult(result, vendor) }
  }
  if (vendor === 'unknown') {
    return {
      ...base,
      status: 'unsupported',
      error: { category: 'unsupported', message: '未识别的供应商，未发送任何请求' },
      hasKey: !credentials.missing,
    }
  }
  if (credentials.missing) {
    return {
      ...base,
      status: 'need-config',
      hasKey: false,
      error: {
        category: 'need-config',
        message: `未找到 API Key（期望凭据引用 ${credentials.ref || '未知'}）；请在 设置 → 模型 中为该供应商填写 Key`,
      },
    }
  }
  const key = credentials.key
  let result
  try {
    if (vendor === 'deepseek') {
      result = source.mode === 'deepseek-official'
        ? await queryDeepSeekApi(source, key, signal)
        : await queryDeepSeekApi(source, key, signal)
    } else if (vendor === 'kimi-code') {
      result = await queryKimiCode(source, key, signal)
    } else if (vendor === 'kimi') {
      result = await queryKimiBalance(source, key, signal)
    } else if (vendor === 'minimax') {
      result = await queryMinimaxPlan(source, key, signal)
    } else if (vendor === 'zhipu') {
      result = await queryZhipu(source, key, ctx, config, signal)
    } else {
      result = failure('unsupported', '未实现该供应商的查询')
    }
  } catch (error) {
    result = failure('http', `查询异常：${error instanceof Error ? error.message : String(error)}`)
  }
  return { ...base, ...normalizeResult(result, vendor), hasKey: true }
}

function normalizeResult(result, vendor) {
  if (!result) return { status: 'error', error: { category: 'http', message: '无响应' }, balances: [], windows: [] }
  if (result.error) {
    return {
      status: result.error.category === 'need-config' ? 'need-config' : result.error.category === 'no-plan' ? 'ok' : 'error',
      error: result.error,
      balances: [],
      windows: [],
      kind: result.kind || 'unknown',
    }
  }
  return {
    status: 'ok',
    kind: result.kind || (Array.isArray(result.balances) && result.balances.length > 0 ? 'balance' : 'quota'),
    balances: Array.isArray(result.balances) ? result.balances : [],
    windows: Array.isArray(result.windows) ? result.windows : [],
    plan: result.plan,
    team: result.team || { isTeam: 'unknown' },
    availability: result.availability,
    note: result.note,
    source: result.source,
  }
}

function refreshMillis(cfg) {
  const seconds = num(cfg?.refreshIntervalSeconds) ?? DEFAULT_REFRESH_SECONDS
  return Math.max(15, Math.min(3600, Math.round(seconds))) * 1000
}

function makeService(ctx, config) {
  let cached
  let inflight
  // Kimi web session: a refresh_token (≈90 days, rotates on refresh) is stored
  // DPAPI-encrypted under the DSH home; a short-lived access_token (15 min) is
  // cached in memory and renewed automatically.
  let kimiAccess = { token: '', expiresAt: 0 }
  let kimiRefreshToken = ''
  let kimiTokenError

  async function loadKimiRecord() {
    let raw
    try {
      raw = await readEncryptedKimiToken()
    } catch {
      raw = undefined
    }
    let record = parseKimiTokenRecord(raw)
    if (!record) {
      try {
        const hit = await ctx.credentials?.resolve?.('KIMI_WEB_TOKEN')
        record = parseKimiTokenRecord(hit?.value)
      } catch {
        /* optional */
      }
    }
    if (!record) record = parseKimiTokenRecord(process.env.KIMI_WEB_TOKEN)
    return record
  }

  async function persistKimiRecord(record) {
    const secret = JSON.stringify(record)
    if (await writeEncryptedKimiToken(secret)) return 'dpapi-file'
    try {
      if (typeof ctx.credentials?.set === 'function') {
        await ctx.credentials.set('KIMI_WEB_TOKEN', record.refreshToken || record.accessToken || '')
        return 'credential-store'
      }
    } catch {
      /* optional */
    }
    return 'memory'
  }

  /** Returns a usable access token, refreshing it when needed. */
  async function ensureKimiWebToken() {
    if (kimiAccess.token && kimiAccess.expiresAt - Date.now() > 90_000) return kimiAccess.token
    const record = await loadKimiRecord()
    if (record?.refreshToken) {
      kimiRefreshToken = record.refreshToken
      const refreshed = await refreshKimiWebSession(record.refreshToken)
      if (refreshed.error) {
        kimiTokenError = refreshed.error
        return kimiAccess.token && kimiAccess.expiresAt > Date.now() ? kimiAccess.token : ''
      }
      kimiAccess = { token: refreshed.accessToken, expiresAt: refreshed.expiresAt }
      kimiRefreshToken = refreshed.refreshToken
      kimiTokenError = undefined
      await persistKimiRecord({ refreshToken: refreshed.refreshToken, accessToken: refreshed.accessToken, accessExpiresAt: refreshed.expiresAt })
      return kimiAccess.token
    }
    if (record?.accessToken) {
      const expiresAt = record.accessExpiresAt ?? jwtExpiryMs(record.accessToken) ?? 0
      if (expiresAt - Date.now() > 30_000) {
        kimiAccess = { token: record.accessToken, expiresAt }
        kimiTokenError = undefined
        return record.accessToken
      }
      // A JWT stored from the web console may in fact be the rotating refresh
      // token; try to exchange it before declaring it expired.
      const upgraded = await refreshKimiWebSession(record.accessToken)
      if (!upgraded.error) {
        kimiAccess = { token: upgraded.accessToken, expiresAt: upgraded.expiresAt }
        kimiRefreshToken = upgraded.refreshToken
        kimiTokenError = undefined
        await persistKimiRecord({ refreshToken: upgraded.refreshToken, accessToken: upgraded.accessToken, accessExpiresAt: upgraded.expiresAt })
        return kimiAccess.token
      }
      kimiTokenError = { category: 'auth', message: `网页 token 已失效：${upgraded.error.message}。请在 kimi.com 控制台复制 refresh_token` }
    }
    return ''
  }

  async function kimiTokenState() {
    let credentialPersisted = false
    try {
      const info = await ctx.credentials?.describe?.('KIMI_WEB_TOKEN')
      credentialPersisted = info?.configured === true
    } catch {
      /* optional */
    }
    const record = await loadKimiRecord()
    if (record?.refreshToken) kimiRefreshToken = kimiRefreshToken || record.refreshToken
    const filePersisted = kimiTokenFileExists()
    const accessExpiresAt = kimiAccess.expiresAt || record?.accessExpiresAt || (record?.accessToken ? jwtExpiryMs(record.accessToken) : undefined)
    const accessUsable = typeof accessExpiresAt === 'number' && accessExpiresAt - Date.now() > 30_000
    const hasRefresh = Boolean(kimiRefreshToken || record?.refreshToken)
    const usable = hasRefresh || accessUsable
    if (!usable && record?.accessToken && !kimiTokenError) {
      kimiTokenError = { category: 'auth', message: '网页 access token 已过期（仅 15 分钟）。请改填 refresh_token（约 90 天，会自动续期）' }
    }
    return {
      ok: true,
      kimiTokenSet: usable,
      persisted: filePersisted || credentialPersisted,
      storage: !usable && !filePersisted && !credentialPersisted ? 'none' : filePersisted ? 'dpapi-file' : credentialPersisted ? 'credential-store' : 'memory',
      kind: hasRefresh ? 'refresh' : accessUsable ? 'access' : 'none',
      expiresAt: accessExpiresAt || null,
      error: kimiTokenError ?? null,
    }
  }

  async function setKimiWebToken(input) {
    if (isRecord(input) && input.clear === true) {
      kimiAccess = { token: '', expiresAt: 0 }
      kimiRefreshToken = ''
      kimiTokenError = undefined
      cached = undefined
      await removeEncryptedKimiToken()
      try {
        await ctx.credentials?.unset?.('KIMI_WEB_TOKEN')
      } catch {
        /* optional */
      }
      return kimiTokenState()
    }
    const token = normalizeKimiWebToken(isRecord(input) ? input.token : undefined)
    if (!token) {
      return { ok: false, error: { code: 'bad-token', message: '无法识别该 token：请粘贴 refresh_token 或完整 cookie' } }
    }
    cached = undefined
    // Try the rotating refresh-token exchange first: a JWT copied from the web
    // console may be either the 15-minute access token or the long-lived refresh
    // token, and only the exchange endpoint can tell us for sure.
    const exchanged = await refreshKimiWebSession(token)
    if (!exchanged.error) {
      kimiAccess = { token: exchanged.accessToken, expiresAt: exchanged.expiresAt }
      kimiRefreshToken = exchanged.refreshToken
      kimiTokenError = undefined
      await persistKimiRecord({ refreshToken: exchanged.refreshToken, accessToken: exchanged.accessToken, accessExpiresAt: exchanged.expiresAt })
      const state = await kimiTokenState()
      return { ...state, kind: 'refresh' }
    }
    if (isJwtToken(token)) {
      const expiresAt = jwtExpiryMs(token)
      if (typeof expiresAt === 'number' && expiresAt - Date.now() < 60_000) {
        return {
          ok: false,
          error: { code: 'token-expired', message: `这个 token 已过期（${exchanged.error.message}）。请重新登录 kimi.com 后复制 refresh_token` },
        }
      }
      // Maybe it is a usable access token after all; verify with one quota call.
      const probe = await queryKimiMonthly(token, undefined)
      if (!probe.error || probe.error.category !== 'auth') {
        const accessExpiresAt = expiresAt ?? Date.now() + 10 * 60_000
        kimiAccess = { token, expiresAt: accessExpiresAt }
        kimiRefreshToken = ''
        kimiTokenError = undefined
        await persistKimiRecord({ accessToken: token, accessExpiresAt })
        const state = await kimiTokenState()
        return { ...state, kind: 'access', warning: '这是 access token（15 分钟有效）；要长期使用请复制 refresh_token' }
      }
      return { ok: false, error: { code: 'token-invalid', message: `token 无法用于月额度查询：${exchanged.error.message}` } }
    }
    return { ok: false, error: { code: exchanged.error.category || 'refresh-failed', message: exchanged.error.message } }
  }

  async function collect(signal) {
    const cfg = readConfig(config)
    const ttlMs = refreshMillis(cfg)
    const discovery = discover(ctx)
    const startedAt = Date.now()
    const settled = await Promise.all(discovery.sources.map(async (source) => {
      try {
        return await queryOne(ctx, source, cfg, signal)
      } catch (error) {
        return {
          id: source.id,
          vendor: 'unknown',
          label: source.displayName || source.id,
          mode: source.mode,
          status: 'error',
          providerId: source.providerId,
          error: { category: 'http', message: error instanceof Error ? error.message : String(error) },
          balances: [],
          windows: [],
          fetchedAt: Date.now(),
        }
      }
    }))
    // Kimi monthly "total usage" lives on the web membership page and needs a
    // web session token; booster wallet is deliberately NOT treated as it.
    const kimiProviders = settled.filter((provider) => provider.vendor === 'kimi-code')
    if (kimiProviders.length > 0) {
      const token = await ensureKimiWebToken()
      for (const provider of kimiProviders) {
        if (!token) {
          provider.totalUsage = kimiTokenError ? { error: kimiTokenError } : { unavailable: 'need-token' }
          continue
        }
        try {
          let monthly = await queryKimiMonthly(token, signal)
          // A 401 can mean the stored JWT is really a rotating refresh token, or
          // the short-lived access token expired: exchange it and retry once.
          if (monthly.error?.category === 'auth') {
            const candidate = kimiRefreshToken || token
            const refreshed = await refreshKimiWebSession(candidate)
            if (!refreshed.error) {
              kimiAccess = { token: refreshed.accessToken, expiresAt: refreshed.expiresAt }
              kimiRefreshToken = refreshed.refreshToken
              kimiTokenError = undefined
              await persistKimiRecord({ refreshToken: refreshed.refreshToken, accessToken: refreshed.accessToken, accessExpiresAt: refreshed.expiresAt })
              monthly = await queryKimiMonthly(kimiAccess.token, signal)
            } else {
              kimiTokenError = { category: 'auth', message: `Kimi 网页登录态失效：${refreshed.error.message}` }
            }
          }
          if (monthly.monthly) {
            provider.totalUsage = monthly.monthly
            const membership = await queryKimiMembership(kimiAccess.token || token, signal)
            if (membership) {
              provider.plan = {
                name: membership.title || mapKimiLevel(membership.level) || 'Kimi Code',
                tier: membership.level,
                source: 'web',
              }
            }
          } else {
            provider.totalUsage = { error: monthly.error }
          }
        } catch (error) {
          provider.totalUsage = { error: { category: 'http', message: error instanceof Error ? error.message : String(error) } }
        }
      }
    }
    // Discovery order IS the configured model order: panel rows must not be
    // re-sorted by vendor.
    return {
      generatedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      ttlMs,
      refreshIntervalSeconds: ttlMs / 1000,
      providers: settled,
      supportedVendors: SUPPORTED_VENDORS,
      configuredCount: settled.length,
      warnings: [],
    }
  }

  async function snapshot(force, signal) {
    const ttlMs = cached?.ttlMs ?? refreshMillis(readConfig(config))
    if (!force && cached && Date.now() - cached.generatedAt < ttlMs) {
      return { ok: true, cache: 'hit', snapshot: cached }
    }
    if (inflight) return inflight
    inflight = (async () => {
      try {
        const next = await collect(signal)
        cached = next
        return { ok: true, cache: force ? 'refreshed' : 'miss', snapshot: next }
      } catch (error) {
        return {
          ok: false,
          error: { category: 'http', message: error instanceof Error ? error.message : String(error) },
          snapshot: cached || null,
        }
      } finally {
        inflight = undefined
      }
    })()
    return inflight
  }

  async function diagnostics() {
    const discovery = discover(ctx)
    const cfg = readConfig(config)
    const kimiToken = await kimiTokenState()
    let settingsDescriptor
    try {
      const descriptors = ctx.settings?.describe?.()
      const list = Array.isArray(descriptors) ? descriptors : []
      const own = list.find((entry) => isRecord(entry) && entry.ns === 'dshp-quota')
      settingsDescriptor = own
        ? { present: true, revision: own.revision, value: own.value }
        : { present: false }
    } catch (error) {
      settingsDescriptor = { present: false, error: error instanceof Error ? error.message : String(error) }
    }
    return {
      ok: true,
      diag: {
        channel: CHANNEL,
        config: cfg,
        settingsDescriptor,
        kimiTokenSet: kimiToken.kimiTokenSet,
        kimiTokenPersisted: kimiToken.persisted,
        kimiTokenStorage: kimiToken.storage,
        kimiTokenKind: kimiToken.kind,
        kimiTokenError: kimiToken.error,
        kimiTokenFile: kimiTokenFile() || null,
        platform: process.platform,
        refreshIntervalSeconds: refreshMillis(cfg) / 1000,
        settingsEntries: discovery.rows.map((row) => ({
          id: row?.entry?.options?.id,
          name: entryNameOf(row?.entry),
        })).slice(0, 200),
        piAiNamespaces: discovery.piAiIds,
        providerRoutes: discovery.routes,
        sources: discovery.sources.map((source) => ({
          id: source.id,
          mode: source.mode,
          providerId: source.providerId,
          displayName: source.displayName,
          baseURL: source.baseURL,
          baseHost: hostOf(source.baseURL),
          apiKeyEnv: source.apiKeyEnv,
          settingsNs: source.settingsNs,
          detected: vendorOfNormalized(source),
        })),
        cachedAt: cached?.generatedAt || null,
        cacheAgeMs: cached ? Date.now() - cached.generatedAt : null,
      },
    }
  }

  /** Current settings-document view for this plugin (no secrets involved). */
  function settingsDocument() {
    try {
      const descriptors = ctx.settings?.describe?.()
      const list = Array.isArray(descriptors) ? descriptors : []
      const own = list.find((entry) => isRecord(entry) && entry.ns === 'dshp-quota')
      return {
        ok: true,
        settings: {
          available: own !== undefined,
          ns: 'dshp-quota',
          revision: own?.revision,
          value: own?.value ?? {},
          config: readConfig(config),
        },
      }
    } catch (error) {
      return { ok: false, error: { code: 'settings-unavailable', message: error instanceof Error ? error.message : String(error) } }
    }
  }

  /** Write plugin settings through the harness settings service (revision-checked). */
  async function writeSettings(ops, expectedRevision) {
    if (!ctx.settings || typeof ctx.settings.mutate !== 'function') {
      return { ok: false, error: { code: 'settings-unavailable', message: '设置服务不可用' } }
    }
    const clean = []
    for (const op of Array.isArray(ops) ? ops : []) {
      if (!isRecord(op) || !Array.isArray(op.path) || op.path.length === 0) continue
      const path = op.path.map((part) => String(part))
      if (op.op === 'unset') clean.push({ op: 'unset', path })
      else if (op.op === 'set') clean.push({ op: 'set', path, value: op.value })
    }
    if (clean.length === 0) return { ok: false, error: { code: 'bad-request', message: '没有可写入的配置项' } }
    try {
      await ctx.settings.mutate('dshp-quota', clean, typeof expectedRevision === 'number' ? expectedRevision : undefined)
      return settingsDocument()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: { code: /conflict|stale|revision/i.test(message) ? 'settings-conflict' : 'settings-rejected', message } }
    }
  }

  return { snapshot, diagnostics, settingsDocument, writeSettings, kimiTokenState, setKimiWebToken }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export const inject = ['connection', 'credentials', 'settings', 'llm', 'configEditor', 'webServer']

/** Dispatch one RPC endpoint. Every path returns a JSON-safe result payload. */
async function dispatch(service, endpoint, payload, signal) {
  try {
    if (endpoint === 'snapshot') {
      const force = isRecord(payload) && payload.force === true
      return await service.snapshot(force, signal)
    }
    if (endpoint === 'refresh') return await service.snapshot(true, signal)
    if (endpoint === 'diag') return service.diagnostics()
    if (endpoint === 'settings') return service.settingsDocument()
    if (endpoint === 'kimi-token') {
      if (isRecord(payload) && (typeof payload.token === 'string' || payload.clear === true)) return await service.setKimiWebToken(payload)
      return await service.kimiTokenState()
    }
    if (endpoint === 'settings-write') {
      const ops = isRecord(payload) ? payload.ops : undefined
      const revision = isRecord(payload) && typeof payload.revision === 'number' ? payload.revision : undefined
      return await service.writeSettings(ops, revision)
    }
    return { ok: false, error: { code: 'bad-request', message: `未知端点：${String(endpoint)}` } }
  } catch (error) {
    return { ok: false, error: { code: 'operation-error', message: error instanceof Error ? error.message : String(error) } }
  }
}

/**
 * Fallback transport when `ctx.connection.rpc.handle` is unavailable.
 *
 * The client half only needs a POST endpoint at `<channel>/<endpoint>` speaking
 * the Connection envelope; the route authenticates every request through
 * `ctx.connection.admit` (signed browser cookie / API peer) before dispatch.
 */
function registerOwnRpcRoute(ctx, service) {
  return ctx.webServer.register({
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
      let tooLarge = false
      for await (const chunk of req) {
        size += chunk.length
        if (size > 256 * 1024) { tooLarge = true; break }
        chunks.push(chunk)
      }
      if (tooLarge) {
        res.writeHead(413)
        res.end('payload too large')
        return
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
      const result = await dispatch(service, endpoint, payload, undefined)
      const ok = result.ok === true
      const envelope = {
        type: 'server-response',
        rpcId,
        result: ok ? { ok: true, value: result } : { ok: false, error: { code: result.error?.code || 'operation-error', message: result.error?.message || 'failed', details: {} } },
      }
      const body = JSON.stringify(envelope)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    },
  })
}

export function apply(ctx, config) {
  const service = makeService(ctx, config)
  let dispose
  try {
    dispose = ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload, signal) => {
      return await dispatch(service, endpoint, payload, signal)
    })
  } catch (error) {
    ctx.logger?.warn?.('dshp-quota: connection.rpc.handle 不可用，改用插件自有路由：%s', error instanceof Error ? error.message : String(error))
    dispose = registerOwnRpcRoute(ctx, service)
  }
  ctx.effect(() => dispose, 'dshp-quota: rpc endpoint')
  ctx.logger?.info?.('dshp-quota: 已注册余额查询通道 %s', CHANNEL)
}

export { Config }
export const name = 'dshp-quota'
