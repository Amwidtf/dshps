/**
 * Direct vendor-endpoint probe for adapter development.
 * Reads provider routes + credential refs from the running dshps Host, resolves
 * keys from the local credential file, and prints upstream responses with all
 * secrets masked. Never prints a key.
 *
 * Usage: node tools/probe-vendors.mjs [kimi|minimax|glm|all]
 */
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

function credentialsPath() {
  if (process.env.DSH_CREDENTIALS_PATH) return process.env.DSH_CREDENTIALS_PATH
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.credentials.yaml')
}

const target = process.argv[2] || 'all'

function readRefs() {
  const refs = {}
  const lines = readFileSync(credentialsPath(), 'utf8').split(/\r?\n/)
  let inRefs = false
  for (const line of lines) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (inRefs) {
      const match = line.match(/^\s{2}([A-Za-z0-9_]+):\s*(.+?)\s*$/)
      if (match) { refs[match[1]] = match[2]; continue }
      if (/^\S/.test(line)) break
    }
  }
  return refs
}

function readSources() {
  const raw = execFileSync(process.execPath, ['tools/probe-rpc.mjs', 'diag', '{}', '--json'], { encoding: 'utf8' })
  return JSON.parse(raw).result.value.diag.sources
}

function mask(value) {
  if (typeof value !== 'string') return value
  return value.replace(/[A-Za-z0-9_-]{20,}/g, (match) => `${match.slice(0, 4)}…(${match.length})`)
}

async function get(url, headers) {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json', ...headers }, redirect: 'error' })
    const text = await response.text()
    return { status: response.status, ok: response.ok, text }
  } catch (error) {
    return { status: 0, ok: false, text: `network: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const refs = readRefs()
const sources = readSources()
const byId = new Map(sources.map((source) => [source.providerId || source.id, source]))

const KIMI = byId.get('kimi-coding')
const MINIMAX = byId.get('minimax-cn')
const GLM = byId.get('zai-coding-cn')

async function probeKimi() {
  if (!KIMI) { console.log('kimi-coding: not configured'); return }
  const key = refs[KIMI.apiKeyEnv]
  if (!key) { console.log('kimi-coding: key missing', KIMI.apiKeyEnv); return }
  const urls = [
    'https://api.kimi.com/coding/v1/usages',
    'https://api.kimi.com/coding/v1/usage',
    'https://api.kimi.com/coding/v1/subscription',
    'https://api.kimi.com/coding/v1/membership',
    'https://api.kimi.com/coding/v1/users/me/balance',
  ]
  for (const url of urls) {
    const result = await get(url, { Authorization: `Bearer ${key}` })
    console.log(`\n=== KIMI ${url} -> ${result.status}`)
    console.log(mask(result.text).slice(0, 6000))
  }
}

async function probeMinimax() {
  if (!MINIMAX) { console.log('minimax-cn: not configured'); return }
  const key = refs[MINIMAX.apiKeyEnv]
  if (!key) { console.log('minimax-cn: key missing', MINIMAX.apiKeyEnv); return }
  const hosts = ['https://www.minimax.cn', 'https://api.minimaxi.com', 'https://api.minimax.chat']
  const paths = ['/v1/token_plan/remains', '/v1/api/openplatform/coding_plan/remains', '/v1/coding_plan/remains']
  for (const host of hosts) {
    for (const path of paths) {
      const result = await get(host + path, { Authorization: `Bearer ${key}` })
      if (result.status === 404 || result.status === 405) continue
      console.log(`\n=== MINIMAX ${host}${path} -> ${result.status}`)
      console.log(mask(result.text).slice(0, 6000))
    }
  }
}

async function probeGlm() {
  if (!GLM) { console.log('zai-coding-cn: not configured'); return }
  const key = refs[GLM.apiKeyEnv]
  if (!key) { console.log('zai-coding-cn: key missing', GLM.apiKeyEnv); return }
  const headersVariants = [
    { label: 'bearer', value: { Authorization: `Bearer ${key}` } },
    { label: 'raw', value: { Authorization: key } },
    { label: 'x-api-key', value: { 'x-api-key': key } },
  ]
  const paths = [
    '/api/monitor/usage/quota/limit',
    '/api/monitor/usage/quota/limit?type=2',
    '/api/biz/subscription/list',
    '/api/biz/account/query-customer-account-report',
    '/api/biz/tokenAccounts/list/my',
  ]
  for (const variant of headersVariants) {
    for (const path of paths) {
      const result = await get('https://open.bigmodel.cn' + path, variant.value)
      if (result.status === 404 || result.status === 405) continue
      console.log(`\n=== GLM [${variant.label}] ${path} -> ${result.status}`)
      console.log(mask(result.text).slice(0, 6000))
    }
  }
}

if (target === 'kimi' || target === 'all') await probeKimi()
if (target === 'minimax' || target === 'all') await probeMinimax()
if (target === 'glm' || target === 'all') await probeGlm()
