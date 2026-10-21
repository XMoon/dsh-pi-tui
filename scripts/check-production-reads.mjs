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
 * The test root is INJECTABLE, so the negative cases can be verified
 * against a DISPOSABLE root: a synthetic test file in the real test tree
 * would be discovered by a CONCURRENT runner (the product lane, the
 * benchmark, this guard itself) and would pollute the test set it
 * discovers. The cleanup that removes the file later cannot undo another
 * process's discovery.
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

/**
 * Check one test tree.
 *
 * `testRoot` is the tree whose test files are checked; `repoRoot` is the
 * tree the production files are resolved against. They differ when the
 * guard is exercised against a disposable fixture tree.
 */
export function checkProductionReads(testRoot, repoRoot = ROOT) {
  const files = discoverTestFiles(testRoot, ['.test.ts', '.test.mjs'])
  const missing = []
  const unresolved = []
  let readCount = 0
  for (const rel of files) {
    const depth = rel.split('/').length - 1
    const source = readFileSync(join(testRoot, rel), 'utf8')
    const { paths, unresolved: names } = productionReads(source, depth)
    readCount += paths.length
    for (const name of names) unresolved.push(`${rel}: ${name}`)
    for (const path of paths) {
      if (!existsSync(join(repoRoot, path))) missing.push(`${rel}: ${path}`)
    }
  }
  return { fileCount: files.length, readCount, missing, unresolved }
}

/** The report the gate prints. */
export function formatReport(result) {
  const lines = []
  lines.push(`test files checked: ${result.fileCount}`)
  lines.push(`production reads resolved: ${result.readCount}`)
  lines.push(`reads naming a file that does NOT exist: ${result.missing.length}`)
  for (const entry of result.missing) lines.push(`  ${entry}`)
  lines.push(`reads that could NOT be resolved statically: ${result.unresolved.length}`)
  for (const entry of result.unresolved) lines.push(`  ${entry}`)
  return lines.join('\n')
}

/** Whether the result passes the gate's contract. */
export function passes(result) {
  return result.missing.length === 0 && result.unresolved.length === 0
}

function main() {
  const result = checkProductionReads(join(ROOT, 'test'))
  console.log(formatReport(result))
  if (result.missing.length > 0) {
    console.error('\na test reads a production file that does not exist: the source lock points at nothing')
    process.exitCode = 1
  }
  if (result.unresolved.length > 0) {
    // A read the resolver could NOT follow is not covered by this gate: the
    // gate's contract is that EVERY production read is verified, so an
    // unresolvable one must fail it rather than pass quietly. A green gate
    // must mean "every production read was checked".
    console.error(
      '\n'
      + `${result.unresolved.length} production read(s) could NOT be resolved statically: the gate cannot claim they were verified.`,
    )
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
