#!/usr/bin/env node
/**
 * Populate the local `node_modules` shims needed by the offline tests.
 *
 * The Host half imports `@deepseek-ai/schemastery` (provided by DSH at runtime).
 * To run `node tools/test-host.mjs` from a clean clone without installing the
 * whole DSH stack, extract those packages from a DSH installation's `app.asar`.
 *
 * Usage:
 *   DSH_ASAR=<path to app.asar> node tools/setup-test-deps.mjs
 *   DSH_ASAR=<path to app.asar> DSH_ASAR_PREFIX= node tools/setup-test-deps.mjs
 *
 * `DSH_ASAR_PREFIX` defaults to `dsh`, i.e. packages are read from
 * `dsh/node_modules/...` inside the archive. Set it to an empty string when the
 * archive root already is the app directory.
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const asar = process.env.DSH_ASAR
if (!asar) {
  console.error('DSH_ASAR is required, for example:')
  console.error('  DSH_ASAR="/path/to/Harness/resources/app.asar" node tools/setup-test-deps.mjs')
  process.exit(2)
}
if (!existsSync(asar)) {
  console.error('DSH_ASAR does not exist:', asar)
  process.exit(2)
}

const prefix = process.env.DSH_ASAR_PREFIX ?? 'dsh'
const packages = [
  ['node_modules/@deepseek-ai/schemastery', 'node_modules/@deepseek-ai/schemastery'],
  ['node_modules/@deepseek-ai/cosmokit', 'node_modules/@deepseek-ai/cosmokit'],
  ['node_modules/@standard-schema/spec', 'node_modules/@standard-schema/spec'],
]

for (const [internal, destination] of packages) {
  const archivePath = prefix ? `${prefix}/${internal}` : internal
  const result = spawnSync(process.execPath, ['tools/asar.mjs', 'extract-tree', asar, archivePath, destination], {
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    console.error(`failed to extract ${archivePath}; set DSH_ASAR_PREFIX correctly?`)
    process.exit(result.status ?? 1)
  }
}

console.log('test dependencies ready; run: node tools/test-host.mjs && node tools/test-client.mjs')
