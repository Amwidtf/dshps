/**
 * dshp-net — Host half.
 *
 * A loopback-only routing proxy for DSH: it accepts `CONNECT host:port` tunnels
 * and absolute-form plain HTTP requests, decides the egress route for every
 * target hostname (provider-derived host → provider extra domain → default
 * proxy → direct), and forwards bytes without buffering so LLM SSE responses
 * pass through untouched. Each upstream proxy may be `http://` or `https://`
 * with a Basic `Proxy-Authorization` credential.
 *
 * It also keeps a bounded audit ring + counters, runs periodic CONNECT health
 * checks, and can rewrite the DSH `.env` proxy variables
 * (`HTTP_PROXY`/`HTTPS_PROXY`) to point at the router, backing up the previous
 * values so the change can be reverted. Router token and proxy passwords live
 * in DSH credential records and never appear in config or RPC output.
 */

import crypto from 'node:crypto'
import { promises as fsp } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { homedir } from 'node:os'
import { dirname, join as joinPath } from 'node:path'
import tls from 'node:tls'
import z from '@deepseek-ai/schemastery'

const NAME = 'dshp-net'
const NS = 'dshp-net'
const CHANNEL = '/dshp-net'

const ROUTER_USER = 'dshps'
const ROUTER_TOKEN_KEY = 'dshp-net/router-token'
const PASSWORD_KEY_PREFIX = 'dshp-net/'

const DEFAULT_PORT = 17890
const PORT_FALLBACK_ATTEMPTS = 10

/**
 * Ports to try when binding the local gateway: the configured port first, then
 * the next few ports, and finally an OS-assigned ephemeral port. Keeping the
 * configured port first preserves the documented default (17890); the fallback
 * keeps the gateway usable when that port is already taken by another app.
 * @param configured - configured listen port (0 requests an ephemeral port)
 * @returns the ordered candidate ports
 */
export function portCandidates(configured) {
  const base = Number.isInteger(configured) && configured > 0 ? configured : 0
  if (base === 0) return [0]
  const candidates = [base]
  for (let offset = 1; offset <= PORT_FALLBACK_ATTEMPTS; offset += 1) {
    const port = base + offset
    if (port <= 65535) candidates.push(port)
  }
  candidates.push(0)
  return candidates
}
const CONNECT_TIMEOUT_MS = 20_000
const ROUTE_CACHE_TTL_MS = 3_000
const MAX_PROXY_RESPONSE_BYTES = 64 * 1024
const MAX_PROXIES = 64
const MAX_PROVIDER_RULES = 128
const MAX_DOMAINS_PER_PROVIDER = 64
const MAX_PASSWORD_LENGTH = 1_024
const FETCH_TIMEOUT_MS = 15_000
const EGRESS_EVIDENCE_WAIT_MS = 2_000

const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_ACCOUNT_HOSTS = ['platform.deepseek.com', 'api.deepseek.com']

const PROXY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const DOMAIN_PATTERN = /^(?:\*\.)?[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

const DEFAULT_MONITOR = {
  enabled: true,
  maxLogs: 500,
  healthIntervalSeconds: 60,
  healthUrl: 'https://www.gstatic.com/generate_204',
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

const ProxyConfig = z.object({
  label: z.string().default(''),
  url: z.string().default(''),
  username: z.string().default(''),
  enabled: z.boolean().default(true),
})

const ProviderRuleConfig = z.object({
  proxy: z.string().default('direct'),
  domains: z.array(z.string()).default([]),
})

const MonitorConfig = z.object({
  enabled: z.boolean().default(true),
  maxLogs: z.natural().min(50).max(5000).default(500),
  healthIntervalSeconds: z.natural().min(0).max(3600).default(60),
  healthUrl: z.string().default('https://www.gstatic.com/generate_204'),
})

const Config = z.object({
  port: z.natural().min(1024).max(65535).default(17890).volatile(),
  defaultProxy: z.string().default('direct').volatile(),
  proxies: z.dict(ProxyConfig).default({}).volatile(),
  providers: z.dict(ProviderRuleConfig).default({}).volatile(),
  monitor: MonitorConfig.default({ ...DEFAULT_MONITOR }).volatile(),
})

// ---------------------------------------------------------------------------
// generic helpers
// ---------------------------------------------------------------------------

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

function errorCodeOf(error) {
  if (isRecord(error) && typeof error.code === 'string' && error.code.length > 0) return error.code
  return messageOf(error).slice(0, 200)
}

function netError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function clampInteger(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function normalizePort(value) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return DEFAULT_PORT
  if (parsed === 0) return 0
  if (parsed < 1 || parsed > 65535) return DEFAULT_PORT
  return parsed
}

function hostOf(url) {
  if (typeof url !== 'string' || url.length === 0) return ''
  try {
    const parsed = new URL(url)
    return parsed.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  } catch {
    return ''
  }
}

function formatHostPort(host, port) {
  const text = String(host || '')
  const wrapped = text.includes(':') && !text.startsWith('[') ? `[${text}]` : text
  return `${wrapped}:${port}`
}

function basicAuthHeader(username, password) {
  return `Basic ${Buffer.from(`${username || ''}:${password || ''}`, 'utf8').toString('base64')}`
}

function timingSafeEqualText(left, right) {
  const a = Buffer.from(typeof left === 'string' ? left : '', 'utf8')
  const b = Buffer.from(typeof right === 'string' ? right : '', 'utf8')
  if (a.length !== b.length || b.length === 0) return false
  try {
    return crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    timer.unref?.()
  })
}

/** Unwrap Schemastery live-config references (`config.proxies.get()`) into plain values. */
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
  const output = {}
  for (const [key, entry] of Object.entries(value)) output[key] = plainConfigLike(entry, depth + 1)
  return output
}

function normalizeProxyEntry(value) {
  const source = isRecord(value) ? value : {}
  return {
    label: typeof source.label === 'string' ? source.label.slice(0, 160) : '',
    url: typeof source.url === 'string' ? source.url.trim() : '',
    username: typeof source.username === 'string' ? source.username : '',
    enabled: source.enabled !== false,
  }
}

function normalizeProxies(value) {
  const output = {}
  if (!isRecord(value)) return output
  for (const [rawId, rawEntry] of Object.entries(value)) {
    const id = typeof rawId === 'string' ? rawId.trim() : ''
    if (!PROXY_ID_PATTERN.test(id)) continue
    output[id] = normalizeProxyEntry(rawEntry)
  }
  return output
}

function normalizeProviders(value) {
  const output = {}
  if (!isRecord(value)) return output
  for (const [rawId, rawRule] of Object.entries(value)) {
    const id = typeof rawId === 'string' ? rawId.trim() : ''
    if (id.length === 0) continue
    const rule = isRecord(rawRule) ? rawRule : {}
    const domains = []
    if (Array.isArray(rule.domains)) {
      for (const domain of rule.domains) {
        if (typeof domain !== 'string') continue
        const normalized = domain.trim().toLowerCase()
        if (normalized.length > 0 && !domains.includes(normalized)) domains.push(normalized)
      }
    }
    output[id] = {
      proxy: typeof rule.proxy === 'string' && rule.proxy.trim().length > 0 ? rule.proxy.trim() : 'direct',
      domains,
    }
  }
  return output
}

function normalizeMonitor(value) {
  const source = isRecord(value) ? value : {}
  return {
    enabled: source.enabled !== false,
    maxLogs: clampInteger(source.maxLogs, DEFAULT_MONITOR.maxLogs, 50, 5000),
    healthIntervalSeconds: clampInteger(source.healthIntervalSeconds, DEFAULT_MONITOR.healthIntervalSeconds, 0, 3600),
    healthUrl: typeof source.healthUrl === 'string' && source.healthUrl.length > 0
      ? source.healthUrl
      : DEFAULT_MONITOR.healthUrl,
  }
}

/** Plain normalized view of the live (volatile) plugin configuration. */
function cfgOf(value) {
  const plain = plainConfigLike(value)
  const source = isRecord(plain) ? plain : {}
  return {
    port: normalizePort(source.port),
    defaultProxy: typeof source.defaultProxy === 'string' && source.defaultProxy.trim().length > 0
      ? source.defaultProxy.trim()
      : 'direct',
    proxies: normalizeProxies(source.proxies),
    providers: normalizeProviders(source.providers),
    monitor: normalizeMonitor(source.monitor),
  }
}

// ---------------------------------------------------------------------------
// pure helpers (exported for offline tests)
// ---------------------------------------------------------------------------

/**
 * Parse a proxy URL of the form `http://host:port` / `https://host:port`.
 * Credentials are not allowed in the URL (they live in a credential record).
 *
 * @returns {{ ok: true, scheme: 'http'|'https', host: string, port: number } | { ok: false, error: string }}
 */
export function parseProxyUrl(url) {
  if (typeof url !== 'string') return { ok: false, error: 'proxy URL must be a string' }
  const text = url.trim()
  if (text.length === 0) return { ok: false, error: 'proxy URL is empty' }
  let parsed
  try {
    parsed = new URL(text)
  } catch {
    return { ok: false, error: 'proxy URL is not a valid URL' }
  }
  const protocol = parsed.protocol.toLowerCase()
  const scheme = protocol === 'http:' ? 'http' : protocol === 'https:' ? 'https' : ''
  if (scheme === '') {
    return { ok: false, error: `unsupported proxy scheme "${protocol.replace(/:$/, '')}"; expected http or https` }
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, error: 'proxy URL must not embed a username or password; use the username field and the password credential' }
  }
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (host.length === 0) return { ok: false, error: 'proxy URL has no host' }
  if (!/^[a-z0-9._:%-]+$/.test(host)) return { ok: false, error: 'proxy URL host contains unsupported characters' }
  const port = parsed.port ? Number(parsed.port) : scheme === 'https' ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: 'proxy URL has an invalid port' }
  if (parsed.pathname !== '/' && parsed.pathname !== '') return { ok: false, error: 'proxy URL must not include a path' }
  if (parsed.search.length > 0 || parsed.hash.length > 0) return { ok: false, error: 'proxy URL must not include a query or fragment' }
  return { scheme, host, port, ok: true }
}

/** Mask the password portion of any URL that carries userinfo. */
export function redactProxyUrl(url) {
  if (typeof url !== 'string') return ''
  if (url.length === 0) return ''
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#@\s]*):([^/?#@\s]*)@/i, '$1$2:***@')
}

/** Human readable byte count, e.g. `512 B`, `1.2 KB`, `3.4 MB`. */
export function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let amount = bytes
  let index = 0
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024
    index += 1
  }
  const text = amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)
  return `${text.replace(/\.0$/, '')} ${units[index]}`
}

function parseEnvLine(line) {
  const match = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(String(line))
  if (!match) return undefined
  return { prefix: match[1], key: match[2], raw: match[3] }
}

function envValueOf(raw) {
  let value = String(raw).trim()
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) return value.slice(1, -1)
  }
  const comment = /\s+#/.exec(value)
  if (comment) value = value.slice(0, comment.index).trim()
  return value
}

function formatEnvAssignment(key, value) {
  const text = String(value)
  if (/[\s"'#]/.test(text)) {
    return `${key}="${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return `${key}=${text}`
}

/**
 * Rewrite the managed keys of a `.env` text while preserving every unrelated
 * line and comment. `entries` maps `KEY` to a new value (a line is replaced, or
 * appended when missing) or to `null` (all lines for that key are removed).
 */
export function mergeEnvFile(text, entries) {
  const source = typeof text === 'string' ? text : ''
  const changes = isRecord(entries) ? entries : {}
  const keys = Object.keys(changes)
  if (keys.length === 0) return source
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const hadFinalNewline = source.length > 0 && /(\r?\n)$/.test(source)
  const lines = source.length > 0 ? source.split(/\r?\n/) : []
  if (hadFinalNewline && lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const output = []
  const applied = new Set()
  for (const line of lines) {
    const parsed = parseEnvLine(line)
    if (!parsed || !Object.prototype.hasOwnProperty.call(changes, parsed.key)) {
      output.push(line)
      continue
    }
    const value = changes[parsed.key]
    if (value === null || value === undefined) continue
    if (applied.has(parsed.key)) continue
    applied.add(parsed.key)
    output.push(`${parsed.prefix}${formatEnvAssignment(parsed.key, value)}`)
  }
  let appended = false
  for (const key of keys) {
    const value = changes[key]
    if (value === null || value === undefined) continue
    if (applied.has(key)) continue
    applied.add(key)
    output.push(formatEnvAssignment(key, value))
    appended = true
  }
  if (output.length === 0) return ''
  const joined = output.join(eol)
  if (hadFinalNewline || source.length === 0 || appended) return `${joined}${eol}`
  return joined
}

function normalizeHostname(value) {
  let host = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (host.length === 0) return ''
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    if (end > 0) return host.slice(1, end)
  }
  const colon = host.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) host = host.slice(0, colon)
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

function domainBaseOf(pattern) {
  let value = normalizeHostname(pattern)
  if (value.startsWith('*.')) value = value.slice(2)
  else if (value.startsWith('.')) value = value.slice(1)
  return value
}

function entryProxy(entry, fallback) {
  return isRecord(entry) && typeof entry.proxy === 'string' && entry.proxy.length > 0 ? entry.proxy : fallback
}

/**
 * Resolve a target hostname against a route table
 * `{ entries: [{ provider, hosts, domains, proxy }], defaultProxy }`.
 * Exact provider-derived hosts win over wildcard extra domains, and the longest
 * matching extra domain wins. Returns `{ proxy, provider }`.
 */
export function matchRoute(table, host) {
  const fallbackProxy = isRecord(table) && typeof table.defaultProxy === 'string' && table.defaultProxy.length > 0
    ? table.defaultProxy
    : 'direct'
  const fallback = { proxy: fallbackProxy, provider: null }
  const target = normalizeHostname(host)
  if (target.length === 0) return fallback
  const entries = isRecord(table) && Array.isArray(table.entries) ? table.entries : []
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.hosts)) continue
    for (const candidate of entry.hosts) {
      if (normalizeHostname(candidate) !== target) continue
      return {
        proxy: entryProxy(entry, fallbackProxy),
        provider: typeof entry.provider === 'string' ? entry.provider : null,
      }
    }
  }
  let best
  for (const entry of entries) {
    if (!isRecord(entry) || !Array.isArray(entry.domains)) continue
    for (const pattern of entry.domains) {
      const base = domainBaseOf(pattern)
      if (base.length === 0) continue
      const matched = target === base || target.endsWith(`.${base}`)
      if (!matched) continue
      if (!best || base.length > best.length) {
        best = {
          length: base.length,
          proxy: entryProxy(entry, fallbackProxy),
          provider: typeof entry.provider === 'string' ? entry.provider : null,
        }
      }
    }
  }
  if (best) return { proxy: best.proxy, provider: best.provider }
  return fallback
}

// ---------------------------------------------------------------------------
// .env bootstrap helpers (paths are resolved per call, never cached at import)
// ---------------------------------------------------------------------------

function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim()
  return joinPath(homedir(), '.dsh')
}

function envPaths() {
  const home = dshHome()
  return {
    home,
    envFile: joinPath(home, '.env'),
    stateDir: joinPath(home, 'dshps'),
    stateFile: joinPath(home, 'dshps', 'net-env.json'),
  }
}

async function readTextFile(file) {
  return await fsp.readFile(file, 'utf8')
}

/** Read an optional file: a missing file is not an error and reads as empty. */
async function readOptionalTextFile(file) {
  try {
    return { text: await fsp.readFile(file, 'utf8'), error: null }
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return { text: '', error: null }
    return { text: '', error }
  }
}

async function writeTextFileAtomic(file, text, mode = 0o600) {
  const directory = dirname(file)
  await fsp.mkdir(directory, { recursive: true })
  const temporary = joinPath(
    directory,
    `.${process.pid}-${crypto.randomBytes(4).toString('hex')}.dshps-net.tmp`,
  )
  await fsp.writeFile(temporary, text, { encoding: 'utf8', mode })
  try {
    await fsp.rename(temporary, file)
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function parseEnvAssignments(text) {
  const assignments = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    assignments.set(parsed.key, envValueOf(parsed.raw))
  }
  return assignments
}

function envMapValue(assignments, key) {
  if (!(assignments instanceof Map)) return undefined
  if (assignments.has(key)) return assignments.get(key)
  const lower = key.toLowerCase()
  if (assignments.has(lower)) return assignments.get(lower)
  return undefined
}

function processEnvValue(key) {
  const upper = process.env[key]
  if (typeof upper === 'string' && upper.length > 0) return upper
  const lower = process.env[key.toLowerCase()]
  if (typeof lower === 'string' && lower.length > 0) return lower
  return undefined
}

function matchesNoProxy(host, noProxy) {
  if (typeof host !== 'string' || host.length === 0) return false
  if (typeof noProxy !== 'string' || noProxy.trim().length === 0) return false
  const target = normalizeHostname(host)
  for (const rawPiece of noProxy.split(',')) {
    let piece = rawPiece.trim().toLowerCase()
    if (piece.length === 0) continue
    if (piece === '*') return true
    if (piece.includes('://')) piece = hostOf(piece) || piece
    const colon = piece.lastIndexOf(':')
    if (colon > 0 && /^\d+$/.test(piece.slice(colon + 1))) piece = piece.slice(0, colon)
    if (piece.startsWith('*.')) piece = piece.slice(2)
    else if (piece.startsWith('.')) piece = piece.slice(1)
    if (piece.length === 0) continue
    if (target === piece || target.endsWith(`.${piece}`)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// provider mapping (live DSH services → routing table rows)
// ---------------------------------------------------------------------------

function readSettingsDescriptors(ctx) {
  try {
    const rows = ctx.settings?.describe?.()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function readCatalogEntries(ctx) {
  try {
    const rows = ctx.llm?.listConfigurableProviders?.()
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function pickPiAiDescriptor(descriptors) {
  const list = descriptors.filter(isRecord)
  const exact = list.find((entry) => entry.ns === 'llm-pi-ai')
  if (exact) return exact
  const named = list.find((entry) => typeof entry.ns === 'string' && /(^|[-_/])llm-pi-ai($|[-_/])/i.test(entry.ns))
  if (named) return named
  return list.find((entry) => entry.ns !== NS && isRecord(plainConfigLike(entry.value)?.providers))
}

function pickDeepseekDescriptor(descriptors) {
  const list = descriptors.filter(isRecord)
  const exact = list.find((entry) => entry.ns === 'llm-deepseek')
  if (exact) return exact
  return list.find((entry) => typeof entry.ns === 'string' && /llm-deepseek|deepseek-api-key/i.test(entry.ns))
}

function addHost(hosts, url) {
  const host = hostOf(url)
  if (host.length > 0 && !hosts.includes(host)) hosts.push(host)
}

function providerRuleOf(cfg, id) {
  const raw = isRecord(cfg.providers) && isRecord(cfg.providers[id]) ? cfg.providers[id] : undefined
  let proxy = raw && typeof raw.proxy === 'string' && raw.proxy.length > 0 ? raw.proxy : cfg.defaultProxy
  const known = (candidate) => candidate === 'direct' || (isRecord(cfg.proxies) && isRecord(cfg.proxies[candidate]))
  if (!known(proxy)) proxy = cfg.defaultProxy
  if (!known(proxy)) proxy = 'direct'
  const domains = raw && Array.isArray(raw.domains)
    ? raw.domains.filter((domain) => typeof domain === 'string' && domain.trim().length > 0).map((domain) => domain.trim().toLowerCase())
    : []
  return { proxy, domains }
}

/**
 * Join the configurable-provider catalog with the settings mirror and the
 * pseudo DeepSeek account provider into the public provider mapping.
 * Order follows the catalog (DSH Settings → Models order), not vendor names.
 */
function collectProviderMapping(ctx, cfg) {
  const descriptors = readSettingsDescriptors(ctx)
  const catalog = readCatalogEntries(ctx)
  const piAi = pickPiAiDescriptor(descriptors)
  const piValue = plainConfigLike(piAi?.value)
  const piProfiles = isRecord(piValue?.providers) ? piValue.providers : {}
  const mapping = []
  const index = new Map()
  const append = (entry) => {
    index.set(entry.id, mapping.length)
    mapping.push(entry)
  }
  for (const item of catalog) {
    if (!isRecord(item) || typeof item.provider !== 'string' || item.provider.length === 0) continue
    const id = item.provider
    if (index.has(id)) continue
    const profile = isRecord(piProfiles[id]) ? piProfiles[id] : {}
    const hosts = []
    addHost(hosts, typeof profile.baseURL === 'string' ? profile.baseURL : '')
    addHost(hosts, typeof item.defaultBaseURL === 'string' ? item.defaultBaseURL : '')
    const rule = providerRuleOf(cfg, id)
    append({
      id,
      label: typeof item.displayName === 'string' && item.displayName.length > 0 ? item.displayName : id,
      hosts,
      proxy: rule.proxy,
      domains: rule.domains,
      sources: ['llm-pi-ai'],
    })
  }
  // The official DeepSeek API-key route comes from the llm-deepseek settings ns,
  // not from the pi-ai catalog; merge it into the catalog row when both exist.
  const deepseekDescriptor = pickDeepseekDescriptor(descriptors)
  const deepseekValue = plainConfigLike(deepseekDescriptor?.value)
  const officialBaseURL = typeof deepseekValue?.baseURL === 'string' && deepseekValue.baseURL.length > 0
    ? deepseekValue.baseURL
    : DEEPSEEK_DEFAULT_BASE_URL
  const officialHost = hostOf(officialBaseURL)
  if (index.has('deepseek')) {
    const entry = mapping[index.get('deepseek')]
    if (officialHost.length > 0 && !entry.hosts.includes(officialHost)) entry.hosts.push(officialHost)
    if (!entry.sources.includes('llm-deepseek')) entry.sources.push('llm-deepseek')
  } else if (deepseekDescriptor) {
    const rule = providerRuleOf(cfg, 'deepseek')
    append({
      id: 'deepseek',
      label: 'DeepSeek',
      hosts: officialHost.length > 0 ? [officialHost] : [],
      proxy: rule.proxy,
      domains: rule.domains,
      sources: ['llm-deepseek'],
    })
  }
  // Provider rules configured for ids that are not in the catalog still matter
  // for wildcard domains; surface them so the settings UI can edit them.
  for (const [id] of Object.entries(cfg.providers)) {
    if (index.has(id)) continue
    const rule = providerRuleOf(cfg, id)
    append({ id, label: id, hosts: [], proxy: rule.proxy, domains: rule.domains, sources: ['config'] })
  }
  // Pseudo provider: the signed-in DeepSeek account talks to the platform and
  // API hosts; users may route it like any other provider.
  if (!index.has('deepseek-account')) {
    const rule = providerRuleOf(cfg, 'deepseek-account')
    append({
      id: 'deepseek-account',
      label: 'DeepSeek account',
      hosts: [...DEEPSEEK_ACCOUNT_HOSTS],
      proxy: rule.proxy,
      domains: rule.domains,
      sources: ['deepseek-account'],
    })
  }
  return mapping
}

function providerHostsOf(mapping) {
  const hosts = []
  for (const provider of mapping) {
    for (const host of provider.hosts) if (!hosts.includes(host)) hosts.push(host)
  }
  return hosts
}

// ---------------------------------------------------------------------------
// network helpers
// ---------------------------------------------------------------------------

function parseAuthority(authority, defaultPort) {
  const text = String(authority || '').trim()
  if (text.length === 0) return undefined
  let host
  let portText
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 0) return undefined
    host = text.slice(1, end)
    const rest = text.slice(end + 1)
    if (rest.length > 0) {
      if (!rest.startsWith(':')) return undefined
      portText = rest.slice(1)
    }
  } else {
    const colon = text.lastIndexOf(':')
    if (colon > 0 && /^\d+$/.test(text.slice(colon + 1))) {
      host = text.slice(0, colon)
      portText = text.slice(colon + 1)
    } else {
      host = text
    }
  }
  if (!host || !/^[A-Za-z0-9._:%-]+$/.test(host)) return undefined
  const port = portText === undefined ? defaultPort : Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { host: host.toLowerCase(), port }
}

function parseHttpTarget(req) {
  const raw = typeof req.url === 'string' ? req.url : ''
  if (/^https?:\/\//i.test(raw)) {
    let parsed
    try {
      parsed = new URL(raw)
    } catch {
      return undefined
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.username.length > 0 || parsed.password.length > 0) return undefined
    const scheme = parsed.protocol.slice(0, -1)
    const port = parsed.port ? Number(parsed.port) : scheme === 'https' ? 443 : 80
    const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
    if (host.length === 0) return undefined
    const path = `${parsed.pathname || '/'}${parsed.search || ''}`
    return { scheme, host, port, path, url: `${parsed.protocol}//${parsed.host}${path}` }
  }
  if (!raw.startsWith('/')) return undefined
  const hostHeader = req.headers && req.headers.host
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return undefined
  const authority = parseAuthority(hostHeader, 80)
  if (!authority) return undefined
  return {
    scheme: 'http',
    host: authority.host,
    port: authority.port,
    path: raw,
    url: `http://${formatHostPort(authority.host, authority.port)}${raw}`,
  }
}

function healthTargetOf(healthUrl) {
  if (typeof healthUrl !== 'string' || healthUrl.length === 0) return undefined
  let parsed
  try {
    parsed = new URL(healthUrl)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  if (host.length === 0) return undefined
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { host, port }
}

function buildForwardHeaders(headers, target) {
  const output = {}
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key) || key === 'host') continue
    if (Array.isArray(value)) output[key] = value.map((entry) => String(entry))
    else if (value !== undefined) output[key] = String(value)
  }
  output.host = formatHostPort(target.host, target.port)
  return output
}

function buildResponseHeaders(headers) {
  const output = {}
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(key)) continue
    if (value === undefined) continue
    output[key] = value
  }
  return output
}

function openTcp(host, port, deadline) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    let settled = false
    socket.on('error', () => {})
    const timer = setTimeout(() => {
      finish(netError('timeout', `connect timeout after ${CONNECT_TIMEOUT_MS} ms`))
    }, Math.max(1, deadline - Date.now()))
    timer.unref?.()
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('connect', onConnect)
      socket.removeListener('error', onError)
      if (error) {
        try { socket.destroy() } catch { /* already gone */ }
        reject(error)
      } else {
        try { socket.setNoDelay?.(true) } catch { /* optional */ }
        resolve(socket)
      }
    }
    function onConnect() {
      finish()
    }
    function onError(error) {
      finish(error)
    }
    socket.once('connect', onConnect)
    socket.once('error', onError)
  })
}

function openTls(host, port, deadline) {
  return new Promise((resolve, reject) => {
    let socket
    try {
      socket = tls.connect({
        host,
        port,
        servername: net.isIP(host) ? undefined : host,
        rejectUnauthorized: true,
      })
    } catch (error) {
      reject(error)
      return
    }
    let settled = false
    socket.on('error', () => {})
    const timer = setTimeout(() => {
      finish(netError('timeout', `TLS handshake timeout after ${CONNECT_TIMEOUT_MS} ms`))
    }, Math.max(1, deadline - Date.now()))
    timer.unref?.()
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('secureConnect', onSecure)
      socket.removeListener('error', onError)
      if (error) {
        try { socket.destroy() } catch { /* already gone */ }
        reject(error)
      } else {
        try { socket.setNoDelay?.(true) } catch { /* optional */ }
        resolve(socket)
      }
    }
    function onSecure() {
      finish()
    }
    function onError(error) {
      finish(error)
    }
    socket.once('secureConnect', onSecure)
    socket.once('error', onError)
  })
}

function expectConnectResponse(socket, deadline) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    let settled = false
    const timer = setTimeout(() => {
      finish(netError('timeout', 'upstream proxy CONNECT response timeout'))
    }, Math.max(1, deadline - Date.now()))
    timer.unref?.()
    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      try { socket.pause() } catch { /* optional */ }
      if (error) {
        try { socket.destroy() } catch { /* already gone */ }
        reject(error)
      } else {
        resolve()
      }
    }
    function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_PROXY_RESPONSE_BYTES) {
        finish(netError('proxy-protocol', 'upstream proxy response is too large'))
        return
      }
      const index = buffer.indexOf('\r\n\r\n')
      if (index < 0) return
      const head = buffer.subarray(0, index).toString('latin1')
      const rest = buffer.subarray(index + 4)
      const firstLine = head.split(/\r?\n/, 1)[0] || ''
      const match = /^HTTP\/1\.[01]\s+(\d{3})/.exec(firstLine)
      if (!match) {
        finish(netError('proxy-protocol', 'malformed upstream proxy response'))
        return
      }
      const status = Number(match[1])
      if (status < 200 || status > 299) {
        finish(netError('proxy-rejected', `upstream proxy returned HTTP ${status}`))
        return
      }
      try { socket.pause() } catch { /* optional */ }
      if (rest.length > 0) {
        try { socket.unshift(rest) } catch { /* optional */ }
      }
      finish()
    }
    function onError(error) {
      finish(error)
    }
    function onClose() {
      finish(netError('proxy-closed', 'upstream proxy closed the CONNECT tunnel'))
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    try { socket.resume() } catch { /* optional */ }
  })
}

function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer))
}

function auditCopy(entry) {
  const copy = {
    id: entry.id,
    at: entry.at,
    method: entry.method,
    host: entry.host,
    port: entry.port,
    provider: entry.provider,
    proxy: entry.proxy,
    direct: entry.direct === true,
    ok: entry.ok === true,
    pending: entry.pending === true,
    ms: entry.ms,
    bytesIn: entry.bytesIn,
    bytesOut: entry.bytesOut,
  }
  if (typeof entry.error === 'string' && entry.error.length > 0) copy.error = entry.error
  return copy
}

function createStats() {
  return {
    total: 0,
    active: 0,
    failed: 0,
    bytesIn: 0,
    bytesOut: 0,
    byProxy: Object.create(null),
    byProvider: Object.create(null),
  }
}

function statsSnapshot(stats) {
  const total = stats.total
  const failed = stats.failed
  const successRate = total > 0 ? Math.round(((total - failed) / total) * 10_000) / 10_000 : 1
  return {
    total,
    active: stats.active,
    failed,
    bytesIn: stats.bytesIn,
    bytesOut: stats.bytesOut,
    byProxy: { ...stats.byProxy },
    byProvider: { ...stats.byProvider },
    successRate,
  }
}

function passwordKey(proxyId) {
  return `${PASSWORD_KEY_PREFIX}${proxyId}`
}

/**
 * Success envelope. The Connection client surfaces `handlerResult.value` as the
 * `value` of the transport result, so the data envelope itself carries an
 * `ok: true` marker next to the payload (same shape as the other dshp-* hosts:
 * the client checks `envelope.value.ok` and then reads the data fields).
 */
function ok(value) {
  const data = isRecord(value) ? value : {}
  return { ok: true, value: { ok: true, ...data } }
}

function fail(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

// ---------------------------------------------------------------------------
// service
// ---------------------------------------------------------------------------

function makeService(ctx, config) {
  const state = {
    server: null,
    running: false,
    listeningPort: null,
    portFallback: null,
    startedAt: null,
    routerError: null,
    routerToken: '',
    startPromise: null,
    stopped: false,
    sockets: new Set(),
    upstreams: new Set(),
    health: new Map(),
    healthTimer: null,
    audit: [],
    auditSeq: 0,
    stats: createStats(),
    passwordCache: new Map(),
    routeCache: null,
  }

  // ---- settings / config view -------------------------------------------------

  function settingsOwn() {
    try {
      const rows = ctx.settings?.describe?.()
      if (!Array.isArray(rows)) return undefined
      return rows.find((entry) => isRecord(entry) && entry.ns === NS)
    } catch {
      return undefined
    }
  }

  /**
   * Current config with the live settings mirror applied when available, plus
   * optional overrides for the response right after a settings write (the live
   * volatile projection may lag by one tick there).
   */
  function configView(overrides) {
    const base = cfgOf(config)
    const own = settingsOwn()
    const value = own ? plainConfigLike(own.value) : undefined
    const merged = { ...base }
    if (isRecord(value)) {
      for (const key of ['port', 'defaultProxy', 'proxies', 'providers', 'monitor']) {
        if (value[key] !== undefined) merged[key] = value[key]
      }
    }
    if (isRecord(overrides)) {
      for (const [key, entry] of Object.entries(overrides)) merged[key] = entry
    }
    return cfgOf(merged)
  }

  function settingsRevision() {
    const own = settingsOwn()
    return own && typeof own.revision === 'number' ? own.revision : undefined
  }

  function invalidateRouteCache() {
    state.routeCache = null
  }

  // ---- router token / proxy passwords ----------------------------------------

  async function ensureRouterToken() {
    const credentials = ctx.credentials
    if (credentials && typeof credentials.readRecord === 'function') {
      try {
        const record = await credentials.readRecord(ROUTER_TOKEN_KEY)
        if (record && record.kind === 'api-key' && typeof record.key === 'string' && record.key.length > 0) {
          return record.key
        }
      } catch {
        /* fall through to create */
      }
    }
    const generated = crypto.randomBytes(32).toString('hex')
    if (credentials && typeof credentials.modifyRecord === 'function') {
      try {
        await credentials.modifyRecord(ROUTER_TOKEN_KEY, async (current) => {
          if (current && current.kind === 'api-key' && typeof current.key === 'string' && current.key.length > 0) return current
          return { kind: 'api-key', key: generated }
        })
        if (typeof credentials.readRecord === 'function') {
          const record = await credentials.readRecord(ROUTER_TOKEN_KEY)
          if (record && record.kind === 'api-key' && typeof record.key === 'string' && record.key.length > 0) {
            return record.key
          }
        }
      } catch (error) {
        ctx.logger?.warn?.('dshp-net: could not persist the router token: %s', messageOf(error))
      }
    }
    return generated
  }

  async function readPasswordRecord(proxyId) {
    const credentials = ctx.credentials
    if (!credentials || typeof credentials.readRecord !== 'function') return undefined
    try {
      const record = await credentials.readRecord(passwordKey(proxyId))
      if (record && record.kind === 'api-key' && typeof record.key === 'string' && record.key.length > 0) return record.key
    } catch {
      /* credential store unavailable */
    }
    return undefined
  }

  async function loadPassword(proxyId) {
    if (state.passwordCache.has(proxyId)) return state.passwordCache.get(proxyId)
    const value = await readPasswordRecord(proxyId)
    state.passwordCache.set(proxyId, value)
    return value
  }

  async function refreshPasswordCache(cfg) {
    for (const id of Object.keys(cfg.proxies)) {
      const value = await readPasswordRecord(id)
      state.passwordCache.set(id, value)
    }
    for (const id of [...state.passwordCache.keys()]) {
      if (!Object.prototype.hasOwnProperty.call(cfg.proxies, id)) state.passwordCache.delete(id)
    }
  }

  // ---- lifecycle --------------------------------------------------------------

  function start() {
    if (state.startPromise) return state.startPromise
    state.startPromise = (async () => {
      try {
        state.routerToken = await ensureRouterToken()
      } catch (error) {
        ctx.logger?.warn?.('dshp-net: router token unavailable, using a volatile token: %s', messageOf(error))
        state.routerToken = crypto.randomBytes(32).toString('hex')
      }
      if (state.stopped) return
      if (process.env.DSHPS_DISABLE_ROUTER === '1') {
        state.routerError = 'router disabled by DSHPS_DISABLE_ROUTER'
        return
      }
      const cfg = configView()
      const makeServer = () => {
        const server = http.createServer()
        server.on('request', (req, res) => {
          void handleRequest(req, res)
        })
        server.on('connect', (req, socket, head) => {
          try {
            handleConnect(req, socket, head)
          } catch (error) {
            try { socket.destroy() } catch { /* already gone */ }
            ctx.logger?.warn?.('dshp-net: CONNECT handler failed: %s', messageOf(error))
          }
        })
        server.on('upgrade', (req, socket) => {
          try { socket.destroy() } catch { /* already gone */ }
        })
        server.on('clientError', (error, socket) => {
          try {
            if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
            else socket?.destroy?.()
          } catch {
            try { socket?.destroy?.() } catch { /* already gone */ }
          }
        })
        server.on('connection', (socket) => {
          state.sockets.add(socket)
          socket.on('close', () => state.sockets.delete(socket))
          socket.on('error', () => {})
        })
        return server
      }
      let lastError
      for (const candidate of portCandidates(cfg.port)) {
        if (state.stopped) break
        const server = makeServer()
        state.server = server
        const outcome = await new Promise((resolve) => {
          let settled = false
          const finish = (value) => {
            if (settled) return
            settled = true
            resolve(value)
          }
          server.once('error', (error) => {
            finish({ ok: false, error })
          })
          server.once('listening', () => {
            server.removeAllListeners('error')
            server.on('error', (error) => {
              state.routerError = `${errorCodeOf(error)}: ${messageOf(error)}`
              state.running = false
              ctx.logger?.warn?.('dshp-net: router error: %s', messageOf(error))
            })
            const address = server.address()
            finish({ ok: true, port: address && typeof address === 'object' ? address.port : candidate })
          })
          try {
            server.listen({ host: '127.0.0.1', port: candidate })
          } catch (error) {
            finish({ ok: false, error })
          }
        })
        if (outcome.ok === true) {
          state.listeningPort = outcome.port
          state.portFallback = cfg.port > 0 && outcome.port !== cfg.port
            ? { configuredPort: cfg.port, actualPort: outcome.port, at: Date.now() }
            : null
          state.startedAt = Date.now()
          state.routerError = null
          state.running = true
          try { server.unref?.() } catch { /* optional */ }
          if (state.portFallback) {
            ctx.logger?.warn?.(
              'dshp-net: port %s is unavailable, router listening on 127.0.0.1:%s instead',
              cfg.port,
              outcome.port,
            )
          } else {
            ctx.logger?.info?.('dshp-net: router listening on 127.0.0.1:%s', outcome.port)
          }
          scheduleHealth()
          return
        }
        lastError = outcome.error
        try { server.close() } catch { /* already closed */ }
        const code = errorCodeOf(outcome.error)
        if (code !== 'EADDRINUSE' && code !== 'EACCES') break
      }
      state.running = false
      state.server = null
      state.portFallback = null
      state.routerError = `${errorCodeOf(lastError)}: ${messageOf(lastError)}`
      ctx.logger?.warn?.(
        'dshp-net: router failed to listen on 127.0.0.1:%s: %s',
        cfg.port,
        messageOf(lastError),
      )
    })()
    return state.startPromise
  }

  function stop() {
    state.stopped = true
    if (state.healthTimer) {
      clearTimeout(state.healthTimer)
      state.healthTimer = null
    }
    for (const socket of state.sockets) {
      try { socket.destroy() } catch { /* already gone */ }
    }
    state.sockets.clear()
    for (const upstream of state.upstreams) {
      try { upstream.destroy() } catch { /* already gone */ }
    }
    state.upstreams.clear()
    if (state.server) {
      try { state.server.close() } catch { /* already closed */ }
      state.server = null
    }
    state.running = false
  }

  // ---- routing ---------------------------------------------------------------

  function routeTable(cfg) {
    const cached = state.routeCache
    if (cached && Date.now() - cached.at < ROUTE_CACHE_TTL_MS) return cached.table
    const mapping = collectProviderMapping(ctx, cfg)
    const table = {
      entries: mapping.map((provider) => ({
        provider: provider.id,
        hosts: provider.hosts,
        domains: provider.domains,
        proxy: provider.proxy,
      })),
      defaultProxy: cfg.defaultProxy,
    }
    state.routeCache = { at: Date.now(), table }
    return table
  }

  function resolveRoute(cfg, host) {
    const match = matchRoute(routeTable(cfg), host)
    let proxy = typeof match.proxy === 'string' && match.proxy.length > 0 ? match.proxy : 'direct'
    if (proxy !== 'direct' && !isRecord(cfg.proxies[proxy])) {
      proxy = cfg.defaultProxy
      if (proxy !== 'direct' && !isRecord(cfg.proxies[proxy])) proxy = 'direct'
    }
    return { proxy, provider: match.provider }
  }

  // ---- audit -----------------------------------------------------------------

  function beginAudit(method, host, port, route) {
    const entry = {
      id: ++state.auditSeq,
      at: Date.now(),
      method,
      host,
      port,
      provider: route && typeof route.provider === 'string' ? route.provider : null,
      proxy: route && typeof route.proxy === 'string' ? route.proxy : 'direct',
      direct: !route || route.proxy === 'direct',
      ok: null,
      pending: true,
      ms: 0,
      bytesIn: 0,
      bytesOut: 0,
    }
    state.stats.total += 1
    state.stats.active += 1
    state.stats.byProxy[entry.proxy] = (state.stats.byProxy[entry.proxy] || 0) + 1
    const providerKey = entry.provider || 'unmapped'
    state.stats.byProvider[providerKey] = (state.stats.byProvider[providerKey] || 0) + 1
    const cfg = configView()
    if (cfg.monitor.enabled) {
      state.audit.push(entry)
      while (state.audit.length > cfg.monitor.maxLogs) state.audit.shift()
    }
    return entry
  }

  function settleAudit(entry, success, error) {
    if (!entry || entry.settled) return
    entry.settled = true
    entry.pending = false
    entry.ok = success === true
    entry.ms = Math.max(0, Date.now() - entry.at)
    if (!entry.ok) {
      entry.error = typeof error === 'string' && error.length > 0 ? error : 'failed'
      state.stats.failed += 1
    }
    state.stats.active = Math.max(0, state.stats.active - 1)
  }

  function addBytes(entry, input, output) {
    if (!entry) return
    if (input > 0) {
      entry.bytesIn += input
      state.stats.bytesIn += input
    }
    if (output > 0) {
      entry.bytesOut += output
      state.stats.bytesOut += output
    }
  }

  // ---- auth ------------------------------------------------------------------

  function isAuthorized(req) {
    const header = req.headers ? req.headers['proxy-authorization'] : undefined
    if (typeof header !== 'string' || header.length === 0) return false
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim())
    if (!match) return false
    let decoded
    try {
      decoded = Buffer.from(match[1], 'base64').toString('utf8')
    } catch {
      return false
    }
    const separator = decoded.indexOf(':')
    if (separator < 0) return false
    if (decoded.slice(0, separator) !== ROUTER_USER) return false
    return timingSafeEqualText(decoded.slice(separator + 1), state.routerToken)
  }

  function respondHttpAuth(res) {
    try {
      res.writeHead(407, {
        'proxy-authenticate': 'Basic realm="dshps"',
        'content-length': '0',
        'cache-control': 'no-store',
        connection: 'close',
      })
      res.end()
    } catch {
      try { res.destroy() } catch { /* already gone */ }
    }
  }

  function respondPlain(res, status, message) {
    try {
      if (res.destroyed) return
      if (res.headersSent) {
        res.destroy()
        return
      }
      const body = String(message || '')
      res.writeHead(status, {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': Buffer.byteLength(body).toString(),
        'cache-control': 'no-store',
        connection: 'close',
      })
      res.end(body)
    } catch {
      try { res.destroy() } catch { /* already gone */ }
    }
  }

  function respondSocketAuth(socket) {
    try {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="dshps"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
    } catch {
      try { socket.destroy() } catch { /* already gone */ }
    }
  }

  function respondSocketPlain(socket, status, message) {
    const labels = { 400: 'Bad Request', 502: 'Bad Gateway', 504: 'Gateway Timeout' }
    const body = String(message || '')
    try {
      socket.end(`HTTP/1.1 ${status} ${labels[status] || 'Error'}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`)
    } catch {
      try { socket.destroy() } catch { /* already gone */ }
    }
  }

  // ---- CONNECT tunnels -------------------------------------------------------

  function handleConnect(req, clientSocket, head) {
    clientSocket.on('error', () => {})
    if (!isAuthorized(req)) {
      respondSocketAuth(clientSocket)
      return
    }
    const target = parseAuthority(req.url, 443)
    if (!target) {
      respondSocketPlain(clientSocket, 400, 'dshps-net: malformed CONNECT target')
      return
    }
    void establishTunnel(target, clientSocket, head)
  }

  async function establishTunnel(target, clientSocket, head) {
    const cfg = configView()
    const route = resolveRoute(cfg, target.host)
    const entry = beginAudit('CONNECT', target.host, target.port, route)
    let upstream
    try {
      upstream = await dialTunnel(cfg, route.proxy, target.host, target.port)
    } catch (error) {
      settleAudit(entry, false, errorCodeOf(error))
      respondSocketPlain(clientSocket, 502, `dshps-net: ${messageOf(error)}`)
      return
    }
    if (clientSocket.destroyed) {
      try { upstream.destroy() } catch { /* already gone */ }
      settleAudit(entry, false, 'client-closed')
      return
    }
    try {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: dshps-net\r\n\r\n')
      if (head && head.length > 0) {
        addBytes(entry, 0, head.length)
        upstream.write(head)
      }
    } catch (error) {
      settleAudit(entry, false, errorCodeOf(error))
      try { upstream.destroy() } catch { /* already gone */ }
      try { clientSocket.destroy() } catch { /* already gone */ }
      return
    }
    state.upstreams.add(upstream)
    let finished = false
    const finish = (success, error) => {
      if (finished) return
      finished = true
      settleAudit(entry, success, error)
      state.upstreams.delete(upstream)
    }
    try { upstream.setNoDelay?.(true) } catch { /* optional */ }
    try { clientSocket.setNoDelay?.(true) } catch { /* optional */ }
    clientSocket.on('data', (chunk) => addBytes(entry, 0, chunk.length))
    upstream.on('data', (chunk) => addBytes(entry, chunk.length, 0))
    clientSocket.on('error', (error) => {
      finish(false, errorCodeOf(error))
      try { upstream.destroy() } catch { /* already gone */ }
    })
    upstream.on('error', (error) => {
      finish(false, errorCodeOf(error))
      try { clientSocket.destroy() } catch { /* already gone */ }
    })
    clientSocket.on('close', () => {
      finish(true)
      try { upstream.end() } catch { /* already gone */ }
    })
    upstream.on('close', () => {
      finish(true)
      try { clientSocket.end() } catch { /* already gone */ }
    })
    clientSocket.pipe(upstream)
    upstream.pipe(clientSocket)
  }

  // ---- plain HTTP forwarding -------------------------------------------------

  async function handleRequest(req, res) {
    try {
      req.on('error', () => {})
      res.on('error', () => {})
      if (!isAuthorized(req)) {
        respondHttpAuth(res)
        return
      }
      const target = parseHttpTarget(req)
      if (!target) {
        respondPlain(res, 400, 'dshps-net: malformed proxy request target')
        return
      }
      const cfg = configView()
      const route = resolveRoute(cfg, target.host)
      if (target.scheme === 'https' && route.proxy !== 'direct') {
        const entry = beginAudit('HTTP', target.host, target.port, route)
        settleAudit(entry, false, 'connect-required')
        respondPlain(res, 502, 'dshps-net: HTTPS through an upstream proxy must use CONNECT')
        return
      }
      const proxyDef = route.proxy !== 'direct' ? cfg.proxies[route.proxy] : undefined
      let parsedProxy
      if (route.proxy !== 'direct' && !proxyDef) {
        const entry = beginAudit('HTTP', target.host, target.port, route)
        settleAudit(entry, false, 'proxy-missing')
        respondPlain(res, 502, `dshps-net: upstream proxy "${route.proxy}" is not configured`)
        return
      }
      if (proxyDef) {
        if (proxyDef.enabled === false) {
          const entry = beginAudit('HTTP', target.host, target.port, route)
          settleAudit(entry, false, 'proxy-disabled')
          respondPlain(res, 502, `dshps-net: upstream proxy "${route.proxy}" is disabled`)
          return
        }
        parsedProxy = parseProxyUrl(proxyDef.url)
        if (!parsedProxy.ok) {
          const entry = beginAudit('HTTP', target.host, target.port, route)
          settleAudit(entry, false, 'proxy-invalid-url')
          respondPlain(res, 502, `dshps-net: upstream proxy "${route.proxy}" has an invalid URL`)
          return
        }
      }
      const entry = beginAudit('HTTP', target.host, target.port, route)
      let upstreamReq
      try {
        const headers = buildForwardHeaders(req.headers, target)
        if (proxyDef) {
          const password = await loadPassword(route.proxy)
          if (password !== undefined) headers['proxy-authorization'] = basicAuthHeader(proxyDef.username, password)
        }
        const options = { method: req.method || 'GET', headers, agent: false }
        let transport
        if (proxyDef) {
          transport = parsedProxy.scheme === 'https' ? https : http
          options.host = parsedProxy.host
          options.port = parsedProxy.port
          options.path = target.url
          if (parsedProxy.scheme === 'https') options.servername = parsedProxy.host
        } else {
          transport = target.scheme === 'https' ? https : http
          options.host = target.host
          options.port = target.port
          options.path = target.path
          if (target.scheme === 'https') options.servername = target.host
        }
        upstreamReq = transport.request(options)
      } catch (error) {
        settleAudit(entry, false, errorCodeOf(error))
        respondPlain(res, 502, `dshps-net: ${messageOf(error)}`)
        return
      }
      const releaseUpstream = () => state.upstreams.delete(upstreamReq)
      state.upstreams.add(upstreamReq)
      upstreamReq.on('close', releaseUpstream)
      const connectTimer = setTimeout(() => {
        try { upstreamReq.destroy(netError('timeout', 'upstream connect timeout')) } catch { /* already gone */ }
      }, CONNECT_TIMEOUT_MS)
      connectTimer.unref?.()
      let responded = false
      upstreamReq.on('response', (upstreamRes) => {
        responded = true
        clearTimeout(connectTimer)
        try {
          const status = typeof upstreamRes.statusCode === 'number' ? upstreamRes.statusCode : 502
          res.writeHead(status, buildResponseHeaders(upstreamRes.headers))
          if (typeof res.flushHeaders === 'function') res.flushHeaders()
          if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true)
          upstreamRes.on('data', (chunk) => addBytes(entry, chunk.length, 0))
          upstreamRes.on('error', () => {
            try { res.destroy() } catch { /* already gone */ }
          })
          upstreamRes.pipe(res)
          res.on('close', () => {
            try { upstreamRes.destroy() } catch { /* already gone */ }
            settleAudit(entry, true)
          })
        } catch (error) {
          settleAudit(entry, false, errorCodeOf(error))
          try { res.destroy() } catch { /* already gone */ }
        }
      })
      req.on('data', (chunk) => addBytes(entry, 0, chunk.length))
      req.pipe(upstreamReq)
      req.on('error', () => {
        try { upstreamReq.destroy() } catch { /* already gone */ }
      })
      res.on('close', () => {
        if (responded) return
        try { upstreamReq.destroy() } catch { /* already gone */ }
        settleAudit(entry, false, 'client-closed')
      })
      upstreamReq.on('error', (error) => {
        clearTimeout(connectTimer)
        if (responded) {
          try { res.destroy() } catch { /* already gone */ }
          return
        }
        settleAudit(entry, false, errorCodeOf(error))
        const status = errorCodeOf(error) === 'timeout' ? 504 : 502
        respondPlain(res, status, `dshps-net: ${messageOf(error)}`)
      })
    } catch (error) {
      settleAudit(undefined, false, errorCodeOf(error))
      respondPlain(res, 502, `dshps-net: ${messageOf(error)}`)
    }
  }

  // ---- upstream dialing ------------------------------------------------------

  async function dialTunnel(cfg, proxyId, host, port) {
    const definition = proxyId !== 'direct' ? cfg.proxies[proxyId] : undefined
    const deadline = Date.now() + CONNECT_TIMEOUT_MS
    if (proxyId !== 'direct' && !definition) {
      throw netError('proxy-missing', `upstream proxy "${proxyId}" is not configured`)
    }
    if (!definition) return await openTcp(host, port, deadline)
    if (definition.enabled === false) throw netError('proxy-disabled', `upstream proxy "${proxyId}" is disabled`)
    const parsed = parseProxyUrl(definition.url)
    if (!parsed.ok) throw netError('proxy-invalid-url', `upstream proxy "${proxyId}": ${parsed.error}`)
    const password = await loadPassword(proxyId)
    let socket
    try {
      socket = parsed.scheme === 'https'
        ? await openTls(parsed.host, parsed.port, deadline)
        : await openTcp(parsed.host, parsed.port, deadline)
      const authority = formatHostPort(host, port)
      const lines = [
        `CONNECT ${authority} HTTP/1.1`,
        `Host: ${authority}`,
      ]
      if (password !== undefined) lines.push(`Proxy-Authorization: ${basicAuthHeader(definition.username, password)}`)
      lines.push('Proxy-Connection: keep-alive', '', '')
      socket.write(lines.join('\r\n'))
      await expectConnectResponse(socket, deadline)
      return socket
    } catch (error) {
      try { socket?.destroy?.() } catch { /* already gone */ }
      throw error
    }
  }

  // ---- health checks ---------------------------------------------------------

  function scheduleHealth() {
    if (state.stopped) return
    if (state.healthTimer) {
      clearTimeout(state.healthTimer)
      state.healthTimer = null
    }
    const cfg = configView()
    if (!cfg.monitor.enabled) return
    const seconds = cfg.monitor.healthIntervalSeconds
    if (seconds <= 0) return
    state.healthTimer = setTimeout(async () => {
      try {
        const current = configView()
        for (const id of Object.keys(current.proxies)) {
          try { await testProxy(id) } catch { /* keep the monitor alive */ }
        }
      } catch {
        /* keep the monitor alive */
      }
      scheduleHealth()
    }, seconds * 1000)
    state.healthTimer.unref?.()
  }

  async function testProxy(id) {
    const cfg = configView()
    const target = healthTargetOf(cfg.monitor.healthUrl)
    const at = Date.now()
    if (!target) {
      const health = { ok: false, ms: 0, at, error: 'invalid monitor.healthUrl' }
      state.health.set(id, health)
      return health
    }
    const started = Date.now()
    if (id === 'direct') {
      let health
      try {
        const socket = await openTcp(target.host, target.port, Date.now() + CONNECT_TIMEOUT_MS)
        try { socket.destroy() } catch { /* already gone */ }
        health = { ok: true, ms: Date.now() - started, at }
      } catch (error) {
        health = { ok: false, ms: Date.now() - started, at, error: errorCodeOf(error) }
      }
      state.health.set('direct', health)
      return health
    }
    if (!isRecord(cfg.proxies[id])) {
      const health = { ok: false, ms: 0, at, error: `unknown proxy "${id}"` }
      state.health.set(id, health)
      return health
    }
    let health
    try {
      const socket = await dialTunnel(cfg, id, target.host, target.port)
      try { socket.destroy() } catch { /* already gone */ }
      health = { ok: true, ms: Date.now() - started, at }
    } catch (error) {
      health = { ok: false, ms: Date.now() - started, at, error: errorCodeOf(error) }
    }
    state.health.set(id, health)
    return health
  }

  // ---- env bootstrap ---------------------------------------------------------

  function routerUrl(port) {
    return `http://${ROUTER_USER}:${state.routerToken}@127.0.0.1:${port}`
  }

  /**
   * Port written into the managed proxy URL. The configured port is used so the
   * file stays correct across a restart; an ephemeral `port: 0` (tests only)
   * falls back to the actually bound port.
   */
  function envRouterPort(cfg) {
    if (
      typeof state.listeningPort === 'number' &&
      state.listeningPort > 0 &&
      state.portFallback &&
      state.portFallback.configuredPort === cfg.port
    ) {
      return state.listeningPort
    }
    if (cfg.port === 0 && typeof state.listeningPort === 'number' && state.listeningPort > 0) {
      return state.listeningPort
    }
    return cfg.port
  }

  function envRouterPortOf(value) {
    if (typeof value !== 'string' || value.length === 0) return undefined
    try {
      const parsed = new URL(value)
      if (parsed.username !== ROUTER_USER) return undefined
      if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return undefined
      return parsed.port ? Number(parsed.port) : 80
    } catch {
      return undefined
    }
  }

  async function envStatus(cfg, mapping) {
    const paths = envPaths()
    const envRead = await readOptionalTextFile(paths.envFile)
    const text = envRead.text
    const envReadError = envRead.error ? messageOf(envRead.error) : null
    let backup = undefined
    try {
      const raw = await readTextFile(paths.stateFile)
      if (raw.trim().length > 0) backup = JSON.parse(raw)
    } catch {
      backup = undefined
    }
    const fileValues = parseEnvAssignments(text)
    const routerPort = envRouterPort(cfg)
    const compiledUrl = routerUrl(routerPort)
    const fileHttp = envMapValue(fileValues, 'HTTP_PROXY')
    const fileHttps = envMapValue(fileValues, 'HTTPS_PROXY')
    const processHttp = processEnvValue('HTTP_PROXY')
    const processHttps = processEnvValue('HTTPS_PROXY')
    const noProxy = envMapValue(fileValues, 'NO_PROXY') ?? processEnvValue('NO_PROXY') ?? ''
    const allProxy = envMapValue(fileValues, 'ALL_PROXY') ?? processEnvValue('ALL_PROXY') ?? ''
    const applied = fileHttp === compiledUrl && fileHttps === compiledUrl
    const effective = processHttp === compiledUrl && processHttps === compiledUrl
    const pendingRestart = applied && !effective
    const warnings = []
    const warningCodes = []
    if (state.portFallback) {
      warnings.push(`Configured port ${state.portFallback.configuredPort} is busy; the gateway is listening on ${state.portFallback.actualPort}. Set the port to ${state.portFallback.actualPort} and apply the environment again so .env matches after a restart.`)
      warningCodes.push({
        code: 'port-fallback',
        params: { configured: state.portFallback.configuredPort, actual: state.portFallback.actualPort },
      })
    }
    if (allProxy.length > 0 && allProxy !== compiledUrl) {
      warnings.push('ALL_PROXY is set and may override HTTP_PROXY/HTTPS_PROXY, so traffic may bypass the router.')
      warningCodes.push({ code: 'all-proxy-override' })
    }
    if (!applied && fileValues.has('http_proxy') && !fileValues.has('HTTP_PROXY')) {
      warnings.push('The .env file sets lowercase http_proxy but the router manages uppercase HTTP_PROXY.')
      warningCodes.push({ code: 'lowercase-http-proxy' })
    }
    if (pendingRestart) {
      warnings.push('The router URL is written to .env but the running process still uses the previous proxy environment; restart DSH (not only the plugin) to apply it.')
      warningCodes.push({ code: 'restart-required' })
    }
    const fileRouterPort = envRouterPortOf(fileHttp)
    if (fileRouterPort !== undefined && fileRouterPort !== routerPort) {
      warnings.push(`The .env router URL points at port ${fileRouterPort} but the configured port is ${routerPort}; apply the environment again after the port change.`)
      warningCodes.push({ code: 'port-mismatch', params: { file: fileRouterPort, router: routerPort } })
    }
    if (!state.running) {
      warnings.push('The local router is not running; requests sent to the proxy URL will fail.')
      warningCodes.push({ code: 'router-not-running' })
    }
    const mapped = mapping || collectProviderMapping(ctx, cfg)
    if (noProxy.length > 0) {
      const bypassed = providerHostsOf(mapped).filter((host) => matchesNoProxy(host, noProxy))
      if (bypassed.length > 0) {
        warnings.push(`NO_PROXY bypasses mapped provider host(s): ${bypassed.slice(0, 5).join(', ')}.`)
        warningCodes.push({ code: 'no-proxy-bypass', params: { hosts: bypassed.slice(0, 5) } })
      }
    }
    return {
      envFile: paths.envFile,
      stateFile: paths.stateFile,
      routerUrlMasked: redactProxyUrl(compiledUrl),
      fileHttpProxy: fileHttp === undefined ? null : redactProxyUrl(fileHttp),
      fileHttpsProxy: fileHttps === undefined ? null : redactProxyUrl(fileHttps),
      processHttpProxy: processHttp === undefined ? null : redactProxyUrl(processHttp),
      processHttpsProxy: processHttps === undefined ? null : redactProxyUrl(processHttps),
      noProxy: noProxy.length > 0 ? noProxy : null,
      applied,
      effective,
      pendingRestart,
      backupExists: isRecord(backup) && isRecord(backup.keys),
      warning: warnings.length > 0 ? warnings.join(' ') : null,
      warnings,
      warningCodes,
      envReadError,
    }
  }

  async function envApply() {
    await start()
    let cfg = configView()
    // A fallback port is only safe once it also becomes the configured port:
    // otherwise the next restart may bind the old configured port while .env
    // still points at the fallback. Adopt the actual port before writing .env.
    let adoptedPort
    let adoptedFrom
    const fallback = state.portFallback
    if (fallback && fallback.configuredPort === cfg.port && fallback.actualPort !== cfg.port) {
      const mutate = ctx.settings?.mutate
      if (typeof mutate !== 'function') {
        return fail('settings-unavailable', 'the settings service is not available')
      }
      try {
        await mutate.call(ctx.settings, NS, [{ op: 'set', path: ['port'], value: fallback.actualPort }])
      } catch (error) {
        return fail('port-adopt-failed', messageOf(error), { port: fallback.actualPort })
      }
      adoptedPort = fallback.actualPort
      adoptedFrom = fallback.configuredPort
      state.portFallback = null
      cfg = { ...cfg, port: fallback.actualPort }
    }
    const paths = envPaths()
    const compiledUrl = routerUrl(envRouterPort(cfg))
    const envRead = await readOptionalTextFile(paths.envFile)
    if (envRead.error) return fail('env-read-failed', messageOf(envRead.error), { path: paths.envFile })
    const text = envRead.text
    const before = parseEnvAssignments(text)
    let backup
    try {
      backup = JSON.parse(await readTextFile(paths.stateFile))
    } catch {
      backup = undefined
    }
    if (!isRecord(backup) || !isRecord(backup.keys)) {
      backup = {
        version: 1,
        at: Date.now(),
        envFile: paths.envFile,
        keys: {
          HTTP_PROXY: envMapValue(before, 'HTTP_PROXY') ?? null,
          HTTPS_PROXY: envMapValue(before, 'HTTPS_PROXY') ?? null,
          ALL_PROXY: envMapValue(before, 'ALL_PROXY') ?? null,
          NO_PROXY: envMapValue(before, 'NO_PROXY') ?? null,
        },
      }
    }
    let next = mergeEnvFile(text, { HTTP_PROXY: compiledUrl, HTTPS_PROXY: compiledUrl })
    if (next.length > 0 && !next.endsWith('\n')) next = `${next}\n`
    try {
      await writeTextFileAtomic(paths.envFile, next)
      await writeTextFileAtomic(paths.stateFile, `${JSON.stringify(backup, null, 2)}\n`)
    } catch (error) {
      return fail('env-write-failed', messageOf(error), { path: paths.envFile })
    }
    return ok({
      env: await envStatus(cfg),
      ...(adoptedPort ? { adoptedPort, adoptedFrom } : {}),
    })
  }

  async function envRevert() {
    await start()
    const cfg = configView()
    const paths = envPaths()
    const envRead = await readOptionalTextFile(paths.envFile)
    if (envRead.error) return fail('env-read-failed', messageOf(envRead.error), { path: paths.envFile })
    const text = envRead.text
    const current = parseEnvAssignments(text)
    let backup
    try {
      backup = JSON.parse(await readTextFile(paths.stateFile))
    } catch {
      backup = undefined
    }
    let reverted = false
    if (isRecord(backup) && isRecord(backup.keys)) {
      const restore = {
        HTTP_PROXY: backup.keys.HTTP_PROXY ?? null,
        HTTPS_PROXY: backup.keys.HTTPS_PROXY ?? null,
        ALL_PROXY: backup.keys.ALL_PROXY ?? null,
        NO_PROXY: backup.keys.NO_PROXY ?? null,
      }
      let next = mergeEnvFile(text, restore)
      if (next.length > 0 && !next.endsWith('\n')) next = `${next}\n`
      try {
        await writeTextFileAtomic(paths.envFile, next)
        await fsp.rm(paths.stateFile, { force: true })
      } catch (error) {
        return fail('env-write-failed', messageOf(error), { path: paths.envFile })
      }
      reverted = true
    } else {
      const compiledUrl = routerUrl(envRouterPort(cfg))
      const removals = {}
      if (envMapValue(current, 'HTTP_PROXY') === compiledUrl) removals.HTTP_PROXY = null
      if (envMapValue(current, 'HTTPS_PROXY') === compiledUrl) removals.HTTPS_PROXY = null
      if (Object.keys(removals).length > 0) {
        let next = mergeEnvFile(text, removals)
        if (next.length > 0 && !next.endsWith('\n')) next = `${next}\n`
        try {
          await writeTextFileAtomic(paths.envFile, next)
        } catch (error) {
          return fail('env-write-failed', messageOf(error), { path: paths.envFile })
        }
        reverted = true
      }
    }
    const env = await envStatus(cfg)
    env.reverted = reverted
    return ok({ env })
  }

  // ---- settings write --------------------------------------------------------

  function targetKnown(proxyId, proxies) {
    return proxyId === 'direct' || Object.prototype.hasOwnProperty.call(proxies, proxyId)
  }

  async function applySecretChanges(previousIds, nextProxies, passwordOps) {
    const warnings = []
    const credentials = ctx.credentials
    const removed = new Set(previousIds.filter((id) => !Object.prototype.hasOwnProperty.call(nextProxies, id)))
    for (const operation of passwordOps) {
      if (operation.password.length === 0) {
        removed.add(operation.id)
        continue
      }
      if (!credentials || typeof credentials.modifyRecord !== 'function') {
        warnings.push(`Credential store unavailable; the password for "${operation.id}" was not saved.`)
        continue
      }
      try {
        await credentials.modifyRecord(passwordKey(operation.id), async () => ({
          kind: 'api-key',
          key: operation.password,
        }))
        state.passwordCache.set(operation.id, operation.password)
      } catch (error) {
        warnings.push(`Could not save the password for "${operation.id}": ${messageOf(error)}`)
      }
    }
    for (const id of removed) {
      state.passwordCache.delete(id)
      state.health.delete(id)
      if (!credentials || typeof credentials.deleteRecord !== 'function') continue
      try {
        await credentials.deleteRecord(passwordKey(id))
      } catch {
        /* the record may not exist */
      }
    }
    return warnings
  }

  async function configWrite(payload) {
    const request = isRecord(payload) ? payload : {}
    const input = request.config
    if (!isRecord(input)) return fail('bad-request', 'config-write requires a config object', { field: 'config' })
    const currentView = configView()
    const requestedPort = input.port === undefined ? currentView.port : input.port
    if (input.port !== undefined && (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535)) {
      return fail('bad-request', 'config.port must be an integer between 1024 and 65535', { field: 'port' })
    }
    const portChanged = requestedPort !== currentView.port
    // Capture the managed .env URL before the settings mutation so a port
    // change can rewrite it atomically below.
    const oldEnvUrl = routerUrl(envRouterPort(currentView))
    let envTextBefore = ''
    let envManaged = false
    let envRewriteError
    if (portChanged) {
      const envRead = await readOptionalTextFile(envPaths().envFile)
      if (envRead.error) {
        envRewriteError = messageOf(envRead.error)
      } else {
        envTextBefore = envRead.text
        const envValues = parseEnvAssignments(envTextBefore)
        envManaged = envMapValue(envValues, 'HTTP_PROXY') === oldEnvUrl
          && envMapValue(envValues, 'HTTPS_PROXY') === oldEnvUrl
      }
    }
    // Omitted sections keep their current value; provided sections are full replacements.
    const rawProxies = input.proxies === undefined
      ? Object.entries(currentView.proxies).map(([id, entry]) => ({ id, ...entry }))
      : input.proxies
    if (!Array.isArray(rawProxies)) return fail('bad-request', 'config.proxies must be an array', { field: 'proxies' })
    if (rawProxies.length > MAX_PROXIES) return fail('bad-request', `too many proxies (max ${MAX_PROXIES})`, { field: 'proxies' })
    const proxies = {}
    const passwordOps = []
    for (const item of rawProxies) {
      if (!isRecord(item)) return fail('bad-request', 'each proxy must be an object', { field: 'proxies' })
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      if (!PROXY_ID_PATTERN.test(id)) {
        return fail('bad-request', `invalid proxy id "${String(item.id)}"`, { field: 'proxies', id: String(item.id) })
      }
      if (Object.prototype.hasOwnProperty.call(proxies, id)) {
        return fail('bad-request', `duplicate proxy id "${id}"`, { field: 'proxies', id })
      }
      const url = typeof item.url === 'string' ? item.url.trim() : ''
      if (url.length > 0) {
        const parsed = parseProxyUrl(url)
        if (!parsed.ok) return fail('bad-request', `proxy "${id}": ${parsed.error}`, { field: 'proxies', id })
      }
      const username = typeof item.username === 'string' ? item.username.trim().slice(0, 200) : ''
      if (username.length > 0 && url.length === 0) {
        return fail('bad-request', `proxy "${id}": a username requires a URL`, { field: 'proxies', id })
      }
      proxies[id] = {
        label: typeof item.label === 'string' ? item.label.trim().slice(0, 120) : '',
        url,
        username,
        enabled: item.enabled !== false,
      }
      if (Object.prototype.hasOwnProperty.call(item, 'password') && item.password !== null) {
        if (typeof item.password !== 'string') {
          return fail('bad-request', `proxy "${id}": password must be a string`, { field: 'proxies', id })
        }
        if (item.password.length > MAX_PASSWORD_LENGTH) {
          return fail('bad-request', `proxy "${id}": password is too long`, { field: 'proxies', id })
        }
        passwordOps.push({ id, password: item.password })
      }
    }
    const defaultProxy = typeof input.defaultProxy === 'string' && input.defaultProxy.trim().length > 0
      ? input.defaultProxy.trim()
      : input.defaultProxy === undefined ? currentView.defaultProxy : 'direct'
    if (!targetKnown(defaultProxy, proxies)) {
      return fail('bad-request', `defaultProxy "${defaultProxy}" is not a configured proxy`, { field: 'defaultProxy' })
    }
    const rawProviders = input.providers === undefined ? currentView.providers : input.providers
    if (rawProviders !== undefined && !isRecord(rawProviders)) {
      return fail('bad-request', 'config.providers must be an object', { field: 'providers' })
    }
    const providerEntries = isRecord(rawProviders) ? Object.entries(rawProviders) : []
    if (providerEntries.length > MAX_PROVIDER_RULES) {
      return fail('bad-request', `too many provider rules (max ${MAX_PROVIDER_RULES})`, { field: 'providers' })
    }
    const providers = {}
    for (const [rawId, rawRule] of providerEntries) {
      const id = String(rawId).trim()
      if (!PROXY_ID_PATTERN.test(id)) return fail('bad-request', `invalid provider id "${String(rawId)}"`, { field: 'providers', id: String(rawId) })
      const rule = isRecord(rawRule) ? rawRule : {}
      const proxy = typeof rule.proxy === 'string' && rule.proxy.trim().length > 0 ? rule.proxy.trim() : 'direct'
      if (!targetKnown(proxy, proxies)) {
        return fail('bad-request', `provider "${id}": proxy "${proxy}" is not configured`, { field: 'providers', id })
      }
      const domains = []
      const rawDomains = Array.isArray(rule.domains) ? rule.domains : []
      for (const domain of rawDomains) {
        if (typeof domain !== 'string') continue
        let normalized = domain.trim().toLowerCase()
        if (normalized.startsWith('.')) normalized = normalized.slice(1)
        if (normalized.length === 0) continue
        if (normalized.length > 253 || !DOMAIN_PATTERN.test(normalized)) {
          return fail('bad-request', `provider "${id}": invalid domain pattern "${domain}"`, { field: 'providers', id })
        }
        if (!domains.includes(normalized)) domains.push(normalized)
        if (domains.length > MAX_DOMAINS_PER_PROVIDER) {
          return fail('bad-request', `provider "${id}": too many domains`, { field: 'providers', id })
        }
      }
      providers[id] = { proxy, domains }
    }
    let revision
    if (typeof request.revision === 'number' && Number.isInteger(request.revision) && request.revision >= 0) {
      revision = request.revision
    }
    const mutate = ctx.settings?.mutate
    if (typeof mutate !== 'function') {
      return fail('settings-unavailable', 'the settings service is not available')
    }
    const previousIds = Object.keys(currentView.proxies)
    const ops = [
      { op: 'set', path: ['defaultProxy'], value: defaultProxy },
      { op: 'set', path: ['proxies'], value: proxies },
      { op: 'set', path: ['providers'], value: providers },
      ...(input.port === undefined ? [] : [{ op: 'set', path: ['port'], value: requestedPort }]),
    ]
    try {
      await mutate.call(ctx.settings, NS, ops, revision)
    } catch (error) {
      const message = messageOf(error)
      if (/conflict|stale|revision|version/i.test(message)) {
        return fail('settings-conflict', message, { ns: NS })
      }
      return fail('settings-rejected', message, { ns: NS })
    }
    invalidateRouteCache()
    const warnings = await applySecretChanges(previousIds, proxies, passwordOps)
    let envRewritten = false
    if (portChanged) {
      state.portFallback = null
      if (envManaged && state.routerToken.length > 0) {
        const newUrl = routerUrl(requestedPort)
        try {
          let next = mergeEnvFile(envTextBefore, { HTTP_PROXY: newUrl, HTTPS_PROXY: newUrl })
          if (next.length > 0 && !next.endsWith('\n')) next = `${next}\n`
          await writeTextFileAtomic(envPaths().envFile, next)
          envRewritten = true
        } catch (error) {
          envRewriteError = messageOf(error)
        }
      } else if (envManaged && state.routerToken.length === 0) {
        envRewriteError = 'router token unavailable'
      }
    }
    const nextSnapshot = await snapshot({ defaultProxy, proxies, providers, port: requestedPort })
    return ok({
      snapshot: nextSnapshot,
      warnings,
      portChanged,
      ...(envRewritten ? { envRewritten: true } : {}),
      ...(envRewriteError ? { envRewriteError } : {}),
    })
  }

  // ---- egress proof ----------------------------------------------------------

  async function egressTest() {
    const cfg = configView()
    const healthUrl = typeof cfg.monitor.healthUrl === 'string' && cfg.monitor.healthUrl.length > 0
      ? cfg.monitor.healthUrl
      : DEFAULT_MONITOR.healthUrl
    const target = healthTargetOf(healthUrl)
    const startedAt = Date.now()
    const since = startedAt - 250
    let fetchError = null
    try {
      const response = await fetchWithTimeout(healthUrl, FETCH_TIMEOUT_MS)
      try { await response.arrayBuffer() } catch { /* the probe body is irrelevant */ }
    } catch (error) {
      fetchError = messageOf(error)
    }
    let evidence = null
    if (target) {
      const deadline = Date.now() + EGRESS_EVIDENCE_WAIT_MS
      while (Date.now() <= deadline) {
        evidence = state.audit.find((entry) => entry.at >= since
          && entry.host === target.host
          && entry.port === target.port) || null
        if (evidence) break
        await sleep(100)
      }
    }
    const effective = evidence !== null
    let error
    if (!effective) {
      if (fetchError) error = fetchError
      else if (!state.running) error = 'The local router is not running.'
      else error = 'The router did not observe the process fetch; the process-wide proxy environment is probably not active (restart DSH after env-apply).'
    }
    return ok({
      effective,
      evidence: evidence ? auditCopy(evidence) : null,
      fetchedAt: startedAt,
      ...(error ? { error } : {}),
    })
  }

  // ---- snapshots / diagnostics ----------------------------------------------

  async function snapshot(overrides) {
    const cfg = configView(overrides)
    const mapping = collectProviderMapping(ctx, cfg)
    const environment = await envStatus(cfg, mapping)
    await refreshPasswordCache(cfg)
    const proxies = Object.keys(cfg.proxies).map((id) => {
      const definition = normalizeProxyEntry(cfg.proxies[id])
      return {
        id,
        label: definition.label,
        url: definition.url,
        username: definition.username,
        hasPassword: state.passwordCache.get(id) !== undefined,
        enabled: definition.enabled,
        health: state.health.get(id) || null,
      }
    })
    return {
      router: {
        running: state.running,
        port: state.listeningPort,
        configPort: cfg.port,
        portFallback: state.portFallback,
        error: state.routerError,
        startedAt: state.startedAt,
        restartRequired: state.running && cfg.port > 0 && state.listeningPort !== cfg.port
          && !(state.portFallback && state.portFallback.configuredPort === cfg.port),
      },
      env: environment,
      config: {
        port: cfg.port,
        defaultProxy: cfg.defaultProxy,
        proxies,
        providers: mapping,
        monitor: cfg.monitor,
        revision: settingsRevision(),
      },
      stats: statsSnapshot(state.stats),
      recent: state.audit.slice().reverse().map(auditCopy),
      now: Date.now(),
    }
  }

  async function diag() {
    const cfg = configView()
    const mapping = collectProviderMapping(ctx, cfg)
    const environment = await envStatus(cfg, mapping)
    await refreshPasswordCache(cfg)
    const paths = envPaths()
    return ok({
      diag: {
        channel: CHANNEL,
        plugin: NAME,
        now: Date.now(),
        router: {
          running: state.running,
          port: state.listeningPort,
          configPort: cfg.port,
          portFallback: state.portFallback,
          restartRequired: state.running && cfg.port > 0 && state.listeningPort !== cfg.port
            && !(state.portFallback && state.portFallback.configuredPort === cfg.port),
          startedAt: state.startedAt,
          error: state.routerError,
          tokenConfigured: state.routerToken.length > 0,
          urlMasked: redactProxyUrl(routerUrl(envRouterPort(cfg))),
          openClientSockets: state.sockets.size,
          openUpstreams: state.upstreams.size,
        },
        config: {
          ns: NS,
          revision: settingsRevision(),
          port: cfg.port,
          defaultProxy: cfg.defaultProxy,
          monitor: cfg.monitor,
          proxies: Object.keys(cfg.proxies).map((id) => {
            const definition = normalizeProxyEntry(cfg.proxies[id])
            return {
              id,
              label: definition.label,
              url: definition.url,
              username: definition.username,
              enabled: definition.enabled,
              hasPassword: state.passwordCache.get(id) !== undefined,
              health: state.health.get(id) || null,
            }
          }),
          providers: mapping,
        },
        routing: {
          defaultProxy: cfg.defaultProxy,
          entries: mapping.map((provider) => ({
            provider: provider.id,
            hosts: provider.hosts,
            domains: provider.domains,
            proxy: provider.proxy,
          })),
        },
        env: environment,
        credentials: {
          routerToken: state.routerToken.length > 0 ? 'set' : 'missing',
          proxyPasswords: Object.fromEntries(Object.keys(cfg.proxies).map((id) => [id, state.passwordCache.get(id) !== undefined])),
        },
        files: { envFile: paths.envFile, stateFile: paths.stateFile },
        audit: { size: state.audit.length, capacity: cfg.monitor.maxLogs, nextId: state.auditSeq },
        stats: statsSnapshot(state.stats),
        process: { platform: process.platform, node: process.version },
      },
    })
  }

  async function proxyTest(payload) {
    const id = isRecord(payload) && typeof payload.id === 'string' ? payload.id.trim() : ''
    if (id.length === 0) return fail('bad-request', 'proxy-test requires a proxy id', { field: 'id' })
    await start()
    const cfg = configView()
    if (id !== 'direct' && !isRecord(cfg.proxies[id])) {
      const health = { ok: false, ms: 0, at: Date.now(), error: `unknown proxy "${id}"` }
      return ok({ health })
    }
    const health = await testProxy(id)
    return ok({ health })
  }

  function logsClear() {
    const cleared = state.audit.length
    state.audit.length = 0
    return ok({ cleared })
  }

  return {
    start,
    stop,
    snapshot,
    diag,
    configWrite,
    proxyTest,
    egressTest,
    envApply,
    envRevert,
    logsClear,
    envStatus,
  }
}

// ---------------------------------------------------------------------------
// RPC dispatch
// ---------------------------------------------------------------------------

async function dispatch(service, endpoint, payload) {
  try {
    if (endpoint === 'snapshot') return ok({ snapshot: await service.snapshot() })
    if (endpoint === 'config-write') return await service.configWrite(payload)
    if (endpoint === 'proxy-test') return await service.proxyTest(payload)
    if (endpoint === 'egress-test') return await service.egressTest()
    if (endpoint === 'env-apply') return await service.envApply()
    if (endpoint === 'env-revert') return await service.envRevert()
    if (endpoint === 'logs-clear') return service.logsClear()
    if (endpoint === 'diag') return await service.diag()
    return fail('bad-request', `unknown endpoint: ${String(endpoint)}`, { endpoint: String(endpoint) })
  } catch (error) {
    return fail('operation-error', messageOf(error))
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * Fallback transport when `ctx.connection.rpc.handle` is unavailable.
 *
 * Some compositions expose the connection service without a usable RPC route
 * registry; the client half only needs a POST endpoint at
 * `<channel>/<endpoint>` speaking the Connection envelope. This route
 * authenticates every request through `ctx.connection.admit` before dispatch,
 * exactly like the shared channel would.
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

export const inject = ['connection', 'settings', 'llm', 'credentials']

export function apply(ctx, config) {
  const service = makeService(ctx, config)
  if (typeof ctx?.effect === 'function') {
    ctx.effect(() => () => service.stop(), 'dshp-net: router + health monitor')
  }
  let disposeRpc
  try {
    const handle = ctx?.connection?.rpc?.handle
    if (typeof handle === 'function') {
      disposeRpc = handle.call(ctx.connection.rpc, CHANNEL, (endpoint, payload) => dispatch(service, endpoint, payload))
    }
  } catch (error) {
    ctx?.logger?.warn?.('dshp-net: connection.rpc.handle is unavailable: %s', messageOf(error))
  }
  if (typeof disposeRpc !== 'function') {
    try {
      disposeRpc = registerOwnRpcRoute(ctx, service)
    } catch (error) {
      ctx?.logger?.warn?.('dshp-net: fallback RPC route registration failed: %s', messageOf(error))
    }
  }
  if (typeof disposeRpc === 'function' && typeof ctx?.effect === 'function') {
    ctx.effect(() => disposeRpc, 'dshp-net: rpc channel')
  }
  void service.start().catch((error) => {
    ctx?.logger?.warn?.('dshp-net: router startup failed: %s', messageOf(error))
  })
}

export { Config }
export const name = NAME
