/**
 * Runtime probe for the dshp-quota RPC endpoint.
 *
 * Mints a short-lived browser-session cookie from the local Connection signing
 * secret (the same secret the running page uses; it never leaves this process),
 * then POSTs a Connection RPC envelope to the running Web GUI. Prints status and
 * JSON only — never the cookie or the secret.
 *
 * Usage: node tools/probe-rpc.mjs [endpoint] [payloadJson]
 */
import { createHash, createHmac } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'

/** Local credentials file; never hardcodes a personal path. */
function credentialsPath() {
  if (process.env.DSH_CREDENTIALS_PATH) return process.env.DSH_CREDENTIALS_PATH
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, '.credentials.yaml')
}

const endpoint = process.argv[2] || 'snapshot'
const payload = process.argv[3] ? JSON.parse(process.argv[3]) : {}
const origin = (process.env.DSH_WEB_ORIGIN || 'http://127.0.0.1:62512').replace(/\/+$/u, '')
let authority
try {
  authority = new URL(origin).host
} catch {
  console.error('DSH_WEB_ORIGIN is not a valid URL:', origin)
  process.exit(2)
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function cookieName(authorityText) {
  return 'dsh-auth-' + base64url(createHash('sha256').update(authorityText).digest())
}

function readSecret() {
  const text = readFileSync(credentialsPath(), 'utf8')
  const lines = text.split(/\r?\n/)
  let inRecord = false
  let inPayload = false
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^\s+client-connection\/browser-session:/.test(line)) { inRecord = true; continue }
    if (inRecord && /^\s+payload:/.test(line)) { inPayload = true; continue }
    if (inPayload) {
      const match = line.match(/^\s+secret:\s*(\S+)\s*$/)
      if (match) return Buffer.from(match[1], 'base64url')
      if (/^\s{0,2}\S/.test(line)) break
    }
  }
  throw new Error('browser-session secret not found')
}

const secret = readSecret()
const issuedAt = Date.now()
const expiresAt = issuedAt + 30 * 24 * 60 * 60 * 1000
const body = base64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
const signature = base64url(createHmac('sha256', secret).update(body).digest())
const cookie = `${cookieName(authority)}=v1.${body}.${signature}`

const envelope = {
  type: 'client-request',
  rpcId: `probe-${issuedAt}`,
  method: endpoint,
  payload,
}

const response = await fetch(`${origin}/dshp-quota/${endpoint}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin,
    cookie,
  },
  body: JSON.stringify(envelope),
})
const text = await response.text()
if (process.argv[4] === '--json') {
  console.log(text)
  process.exit(response.ok ? 0 : 1)
}
console.log(JSON.stringify({ status: response.status, bytes: text.length }, null, 2))
try {
  const parsed = JSON.parse(text)
  console.log(JSON.stringify(parsed, null, 2).slice(0, 12000))
} catch {
  console.log(text.slice(0, 2000))
}
