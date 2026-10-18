/**
 * Diagnose the stored Kimi web token against the membership gateway.
 * Decrypts the DPAPI file locally, decodes JWT claims (no values printed), and
 * tries request variants. Never prints the token. Response bodies may include
 * account metadata; review output before sharing it publicly.
 *
 * Run: node tools/probe-kimi-web.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const tokenFile = process.env.DSHPS_KIMI_TOKEN_FILE || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dshps', 'kimi-token.dat')
if (!existsSync(tokenFile)) {
  console.log('token file not found:', tokenFile)
  process.exit(1)
}

function decryptToken() {
  const script = `$s = ConvertTo-SecureString -String (Get-Content -Raw -LiteralPath '${tokenFile.replace(/'/g, "''")}') -ErrorAction Stop; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); [Runtime.InteropServices.Marshal]::PtrToStringAuto($b)`
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim()
}

function jwtPayload(token) {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return undefined
  }
}

const token = decryptToken()
console.log('token length:', token.length, 'looksLikeJwt:', token.split('.').length === 3)
const payload = jwtPayload(token)
if (payload) {
  console.log('jwt claims:', Object.keys(payload).join(','))
  if (typeof payload.exp === 'number') {
    console.log('exp:', new Date(payload.exp * 1000).toISOString(), 'expired:', Date.now() > payload.exp * 1000)
  }
  if (typeof payload.ssid === 'string') console.log('has ssid: yes')
  if (typeof payload.sub === 'string') console.log('has sub: yes')
  if (typeof payload.device_id === 'string') console.log('has device_id: yes')
}

const url = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats'

function headersFor(variant) {
  const base = {
    Authorization: `Bearer ${token}`,
    Cookie: `kimi-auth=${token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
  if (variant === 'minimal') return base
  const headers = {
    ...base,
    Origin: 'https://www.kimi.com',
    Referer: 'https://www.kimi.com/code/console',
    'connect-protocol-version': '1',
    'x-msh-platform': 'web',
  }
  if (payload) {
    if (typeof payload.device_id === 'string' && payload.device_id) headers['x-msh-device-id'] = payload.device_id
    if (typeof payload.ssid === 'string' && payload.ssid) headers['x-msh-session-id'] = payload.ssid
    if (typeof payload.sub === 'string' && payload.sub) headers['x-traffic-id'] = payload.sub
  }
  return headers
}

for (const variant of ['full', 'minimal']) {
  const response = await fetch(url, { method: 'POST', headers: headersFor(variant), body: '{}', redirect: 'error' })
  const text = await response.text()
  console.log(`\n=== ${variant} -> ${response.status}`)
  console.log(text.slice(0, 800))
}

// Also try the older GetSubscription endpoint for reference.
const subUrl = 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription'
const subResponse = await fetch(subUrl, { method: 'POST', headers: headersFor('full'), body: '{}', redirect: 'error' })
console.log(`\n=== subscription -> ${subResponse.status}`)
console.log((await subResponse.text()).slice(0, 800))
