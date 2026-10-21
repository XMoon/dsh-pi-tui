#!/usr/bin/env node
/**
 * The production-read GUARD: every production file a test reads must
 * EXIST.
 *
 * A test that reads a production module by path is a SOURCE LOCK: it
 * asserts on the exact text of that module. If the module is renamed,
 * moved or removed, the read silently starts pointing at a DIFFERENT file
 * (or at nothing), and the test keeps passing while proving a different
 * contract — or fails with a confusing ENOENT instead of a clear one.
 *
 * The guard resolves the production reads of every test file
 * (`scripts/production-reads.mjs`) and checks that each one names a file
 * that EXISTS. It is a permanent guard, not a migration instrument: it
 * holds for any future change to the test tree.
 *
 * A read that cannot be resolved statically is REPORTED, never ignored: a
 * reference the resolver cannot follow must not be counted as covered.
 *
 * Usage: node scripts/check-production-reads.mjs
 * @module @xmoon76/dsh-pi-tui/scripts/check-production-reads
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverTestFiles } from './test-discovery.mjs'
import { productionReads } from './production-reads.mjs'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')

function main() {
  const files = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  const missing = []
  const unresolved = []
  let readCount = 0
  for (const rel of files) {
    const depth = rel.split('/').length - 1
    const source = readFileSync(join(TEST_ROOT, rel), 'utf8')
    const { paths, unresolved: names } = productionReads(source, depth)
    readCount += paths.length
    for (const name of names) unresolved.push(`${rel}: ${name}`)
    for (const path of paths) {
      if (!existsSync(join(ROOT, path))) missing.push(`${rel}: ${path}`)
    }
  }
  console.log(`test files checked: ${files.length}`)
  console.log(`production reads resolved: ${readCount}`)
  console.log(`reads naming a file that does NOT exist: ${missing.length}`)
  for (const entry of missing) console.log(`  ${entry}`)
  console.log(`reads that could NOT be resolved statically: ${unresolved.length}`)
  for (const entry of unresolved) console.log(`  ${entry}`)
  if (missing.length > 0) {
    console.error('\na test reads a production file that does not exist: the source lock points at nothing')
    process.exitCode = 1
  }
  if (unresolved.length > 0) {
    // A read the resolver could NOT follow is not covered by this gate: the
    // gate's contract is that EVERY production read is verified, so an
    // unresolvable one must fail it rather than pass quietly. A green
    // gate must mean "every production read was checked".
    console.error(
      '\n'
      + `${unresolved.length} production read(s) could NOT be resolved statically: the gate cannot claim they were verified.`,
    )
    process.exitCode = 1
  }
}

main()
