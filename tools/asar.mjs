#!/usr/bin/env node
// Minimal Electron ASAR reader: list / extract specific files without unpacking the whole archive.
// Usage:
//   node tools/asar.mjs list <asar> [prefix]
//   node tools/asar.mjs extract <asar> <internalPath> <outFile>
//   node tools/asar.mjs extract-tree <asar> <internalPrefix> <outDir>
import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2];
const ASAR = process.argv[3];

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(4);
  const jsonSize = head.readUInt32LE(12);
  const jsonBuf = Buffer.alloc(jsonSize);
  fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
  const header = JSON.parse(jsonBuf.toString('utf8'));
  const baseOffset = 8 + headerSize;
  fs.closeSync(fd);
  return { header, baseOffset };
}

function walk(node, prefix, out) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const p = prefix ? `${prefix}/${name}` : name;
    if (child.files) walk(child, p, out);
    else out.push({ path: p, size: child.size, offset: child.offset, unpacked: !!child.unpacked });
  }
}

const { header, baseOffset } = readHeader(ASAR);

if (mode === 'list') {
  const filter = process.argv[4] || '';
  const files = [];
  walk(header, '', files);
  for (const f of files) if (f.path.startsWith(filter)) console.log(`${f.path}\t${f.size}`);
  process.exit(0);
}

if (mode === 'extract') {
  const internal = process.argv[4];
  const outFile = process.argv[5];
  const parts = internal.split('/').filter(Boolean);
  let node = header;
  for (const part of parts) {
    node = node.files?.[part];
    if (!node) { console.error(`Not found: ${internal}`); process.exit(2); }
  }
  if (node.files) { console.error(`Is a directory: ${internal}`); process.exit(2); }
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  const buf = Buffer.alloc(node.size);
  const fd = fs.openSync(ASAR, 'r');
  fs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset));
  fs.closeSync(fd);
  fs.writeFileSync(outFile, buf);
  console.log(`extracted ${internal} -> ${outFile} (${node.size} bytes)`);
  process.exit(0);
}

if (mode === 'extract-tree') {
  const internalPrefix = (process.argv[4] || '').replace(/\/+$/, '');
  const outDir = process.argv[5];
  const files = [];
  walk(header, '', files);
  const fd = fs.openSync(ASAR, 'r');
  let n = 0;
  for (const f of files) {
    const rel = internalPrefix ? f.path.slice(internalPrefix.length + 1) : f.path;
    if (internalPrefix && !f.path.startsWith(internalPrefix + '/')) continue;
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (f.unpacked) continue; // caller can handle unpacked separately
    const buf = Buffer.alloc(f.size);
    fs.readSync(fd, buf, 0, f.size, baseOffset + Number(f.offset));
    fs.writeFileSync(dest, buf);
    n++;
  }
  fs.closeSync(fd);
  console.log(`extracted ${n} files under ${internalPrefix || '.'} -> ${outDir}`);
  process.exit(0);
}

console.error('Usage: node tools/asar.mjs list|extract|extract-tree ...');
process.exit(1);
