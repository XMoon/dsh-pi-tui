#!/usr/bin/env node
/** Verify that a packed TUI candidate contains no source-mode state. */

import { existsSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

import { assertNoSourceLeak } from './lib/dsh-distribution.mjs'

function fail(message) {
  throw new Error(message)
}

function candidatePath(value) {
  if (typeof value !== 'string' || value.startsWith('--')) fail('usage: dsh-source-leak-gate.mjs <candidate.tgz> [--distribution path]')
  const path = resolve(value)
  if (!existsSync(path) || !lstatSync(path).isFile()) fail(`candidate tarball must be a regular file: ${value}`)
  return path
}

function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const candidate = candidatePath(args[0])
  const { values } = parseArgs({
    args: args.slice(1),
    options: { distribution: { type: 'string' }, source: { type: 'string' } },
    allowPositionals: false,
  })
  const distribution = values.distribution === undefined ? undefined : resolve(values.distribution)
  const source = values.source === undefined ? undefined : resolve(values.source)
  assertNoSourceLeak(candidate, {
    sourcePaths: source === undefined ? [] : [source],
    distributionPaths: distribution === undefined ? [] : [distribution],
  })
  console.log(`source leak gate passed — ${candidate}`)
}

try {
  main()
} catch (error) {
  console.error(`DSH_SOURCE_LEAK_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
