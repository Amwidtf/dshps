/**
 * Fetch a GET path from the running Web GUI with a browser-session cookie minted
 * from the local Connection signing secret. Prints status and a short body
 * excerpt; never prints the cookie or secret.
 *
 * Usage: node tools/fetch-authed.mjs <path> [containsText]
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

const path = process.argv[2] || '/'
const needle = process.argv[3] || ''
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
  const lines = readFileSync(credentialsPath(), 'utf8').split(/\r?\n/)
  let inRecord = false
  let inPayload = false
  for (const line of lines) {
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

const response = await fetch(`${origin}${path}`, {
  headers: { cookie: `${cookieName(authority)}=v1.${body}.${signature}` },
})
const text = await response.text()
if (process.argv[4] === '--out') {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.argv[5], text)
  console.log(`status=${response.status} bytes=${text.length} -> ${process.argv[5]}`)
  process.exit(response.ok ? 0 : 1)
}
console.log(`status=${response.status} bytes=${text.length} type=${response.headers.get('content-type') || ''}`)
if (needle) console.log(`contains(${JSON.stringify(needle)})=${text.includes(needle)}`)
console.log(text.slice(0, 900))
