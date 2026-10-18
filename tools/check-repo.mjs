#!/usr/bin/env node
/**
 * Repository hygiene check for CI / local use.
 *
 * Fails when tracked source files contain personal paths or things that look
 * like real credentials. Documentation placeholders such as `sk-…` or
 * `Bearer YOUR_API_KEY` are intentionally allowed; the patterns here target
 * full-length secret shapes.
 *
 * Usage: node tools/check-repo.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = process.cwd()
const skipDirs = new Set(['node_modules', '.git', '.tmp', 'dist', 'coverage'])
const allowedExtensions = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.svg', '.txt', '.html', '.css', '.sh',
])

const patterns = [
  { name: 'Windows personal home path', test: /C:\\Users\\[^\\\s]+/u },
  { name: 'macOS personal home path', test: /\/Users\/[A-Z][^/\s]*\//u },
  { name: 'developer workspace path', test: /(Workspace|DevelopUtils)[\\/]/u },
  { name: 'GitHub token', test: /\bghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/u },
  { name: 'AWS access key', test: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: 'private key block', test: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { name: 'JWT-looking token', test: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/u },
  { name: 'full-length sk- key', test: /\bsk-[A-Za-z0-9]{32,}\b/u },
]

const violations = []
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) {
      if (!skipDirs.has(entry)) walk(full)
      continue
    }
    const ext = entry.slice(entry.lastIndexOf('.'))
    if (!allowedExtensions.has(ext)) continue
    const rel = relative(root, full).replaceAll('\\', '/')
    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }
    for (const pattern of patterns) {
      const match = text.match(pattern.test)
      if (match) violations.push(`${rel}: ${pattern.name} (${match[0].slice(0, 24)}…)`)
    }
  }
}

walk(root)

if (violations.length > 0) {
  console.error('Repository hygiene check failed:')
  for (const line of violations) console.error('  ' + line)
  process.exit(1)
}
console.log('repository hygiene check passed')
