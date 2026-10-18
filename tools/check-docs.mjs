#!/usr/bin/env node
/**
 * Validate Markdown links and anchors across the README files.
 * Anchors follow GitHub's slugger: lowercase, remove punctuation, one hyphen per space.
 *
 * Usage: node tools/check-docs.mjs
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = process.cwd()
const docs = ['README.md', 'README.en.md']
for (const entry of readdirSync(join(root, 'plugins'), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  for (const name of ['README.md', 'README.en.md']) {
    const rel = join('plugins', entry.name, name)
    if (existsSync(join(root, rel))) docs.push(rel.split('\\').join('/'))
  }
}

function slug(text) {
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\- ]/gu, '')
    .replace(/ /g, '-')
}

const anchorsByFile = new Map()
for (const file of docs) {
  const text = readFileSync(join(root, file), 'utf8')
  const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1].trim()))
  anchorsByFile.set(file, new Set(headings))
}

let failed = 0
for (const file of docs) {
  const text = readFileSync(join(root, file), 'utf8')
  const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1])
  const dir = dirname(join(root, file))
  for (const raw of links) {
    if (/^[a-z]+:/i.test(raw)) continue
    const [target, anchor] = raw.split('#')
    let targetFile = file
    if (target) {
      const absolute = resolve(dir, target)
      if (!existsSync(absolute)) {
        console.log(`${file}: missing link target ${raw}`)
        failed++
        continue
      }
      if (statSync(absolute).isDirectory()) continue
      targetFile = relative(root, absolute).split('\\').join('/')
      if (!anchorsByFile.has(targetFile) && targetFile.endsWith('.md')) {
        const headings = [...readFileSync(absolute, 'utf8').matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slug(match[1].trim()))
        anchorsByFile.set(targetFile, new Set(headings))
      }
    }
    if (anchor && anchorsByFile.has(targetFile) && !anchorsByFile.get(targetFile).has(anchor)) {
      console.log(`${file}: broken anchor ${raw}`)
      failed++
    }
  }
  console.log(`${file}: ${links.length} links checked`)
}

if (failed > 0) {
  console.log(`FAILED: ${failed} issue(s)`)
  process.exit(1)
}
console.log('README links and anchors OK')
