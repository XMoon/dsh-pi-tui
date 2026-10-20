#!/usr/bin/env node
/**
 * The migration's SEMANTIC check: every production path a test reads must
 * still point at the SAME file it pointed at before the move.
 *
 * A path rewrite that resolves to a DIFFERENT production file is a silent
 * semantic change: the test would keep passing while proving a different
 * contract. This check compares the RESOLVED target of every
 * file-relative production reference against the base tree, by NAME
 * (the base tree's file and the current tree's file must be the same
 * production module).
 *
 * Usage: node scripts/verify-migration-semantics.mjs <base-sha>
 * @module @xmoon76/dsh-pi-tui/scripts/verify-migration-semantics
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverTestFiles } from './test-discovery.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = resolve(ROOT, 'test')

/** The file-relative production references a test file makes. */
function productionReferences(source) {
  const refs = []
  for (const match of source.matchAll(/new URL\(\s*'(\.\.\/[^']*)'\s*,\s*import\.meta\.url\s*\)/gu)) {
    refs.push(match[1])
  }
  for (const match of source.matchAll(/from\s+'(\.\.\/[^']*)'/gu)) {
    refs.push(match[1])
  }
  return refs
}

/**
 * The base tree's version of a file, or `undefined`.
 *
 * The base tree's file may be at the FLAT root (`test/<name>.test.ts`) or
 * already in a subdirectory, so the base lookup tries the current path
 * first and then the flat basename.
 */
function baseSource(rel) {
  const base = process.argv[2]
  const candidates = [rel, rel.split('/').pop()]
  for (const candidate of candidates) {
    try {
      return execFileSync('git', ['show', `${base}:test/${candidate}`], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      // Try the next candidate.
    }
  }
  return undefined
}

function main() {
  const base = process.argv[2]
  if (base === undefined) {
    console.error('usage: node scripts/verify-migration-semantics.mjs <base-sha>')
    process.exit(2)
  }
  const files = discoverTestFiles(TEST_ROOT, ['.test.ts', '.test.mjs'])
  let compared = 0
  let changed = 0
  const problems = []

  for (const rel of files) {
    const source = readFileSync(resolve(TEST_ROOT, rel), 'utf8')
    const before = baseSource(rel)
    if (before === undefined) continue
    const beforeRefs = productionReferences(before)
    const afterRefs = productionReferences(source)
    if (beforeRefs.length === 0) continue
    compared += 1

    // The RESOLVED target of every reference, as a path relative to the
    // repository root. The base and the current tree must resolve to the
    // SAME production file.
    //
    // The BASE file lives at the FLAT root, so its references resolve
    // against `test/`, while the current file resolves against its own
    // directory. Each side is resolved against ITS OWN location — that is
    // exactly what the migration had to preserve.
    const baseRel = rel.split('/').pop()
    const resolveAll = (text, fileRel) => productionReferences(text)
      .map(spec => relative(ROOT, resolve(dirname(resolve(TEST_ROOT, fileRel)), spec)))
      .filter(path => path.startsWith('src/') || path.startsWith('packages/'))
      .sort()
    const beforeTargets = resolveAll(before, baseRel)
    const afterTargets = resolveAll(source, rel)
    if (JSON.stringify(beforeTargets) === JSON.stringify(afterTargets)) continue
    changed += 1
    const removed = beforeTargets.filter(target => !afterTargets.includes(target))
    const added = afterTargets.filter(target => !beforeTargets.includes(target))
    if (removed.length === 0 && added.length === 0) continue
    problems.push({ rel, removed, added })
  }

  console.log(`test files with production references compared: ${compared}`)
  console.log(`files whose resolved production targets CHANGED: ${changed}`)
  if (problems.length === 0) {
    console.log('\nno test now reads a DIFFERENT production file than before the move')
    return
  }
  console.log('')
  for (const problem of problems) {
    console.log(`${problem.rel}`)
    for (const target of problem.removed) console.log(`  - ${target}`)
    for (const target of problem.added) console.log(`  + ${target}`)
  }
  process.exitCode = 1
}

main()
