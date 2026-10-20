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

/**
 * The file-relative production references a test file makes.
 *
 * Every FORM the tree actually uses is covered:
 *
 *   - `new URL('…', import.meta.url)` — the single-quoted source read;
 *   - `new URL(\`…\`, import.meta.url)` — the TEMPLATE source read (the
 *     literal prefix before the interpolation is the part that resolves);
 *   - `from '…'` and `from "…"` — the import clause, both quote styles.
 *
 * A form this extractor does not recognise would make the check report a
 * FALSE assurance, so the extractor also COUNTS the production references
 * it saw in a DIFFERENT way and the caller compares the two counts: a
 * reference the extractor missed shows up as a count difference.
 */
export function productionReferences(source) {
  const refs = []
  // A reference inside a plain string literal is a source-lock assertion
  // or a test fixture (many architecture guards assert on the exact text of
  // a production import), NOT a reference of this file.
  const add = (spec, index) => {
    if (isInsideStringLiteral(source, index)) return
    refs.push(spec)
  }
  for (const match of source.matchAll(/new URL\(\s*'(\.\.\/[^']*)'\s*,\s*import\.meta\.url\s*\)/gu)) {
    add(match[1], match.index)
  }
  for (const match of source.matchAll(/new URL\(\s*`(\.\.\/[^`$]*)\$\{/gu)) {
    add(match[1], match.index)
  }
  for (const match of source.matchAll(/new URL\(\s*"(\.\.\/[^"]*)"\s*,\s*import\.meta\.url\s*\)/gu)) {
    add(match[1], match.index)
  }
  for (const match of source.matchAll(/\bfrom\s+'(\.\.\/[^']*)'/gu)) {
    add(match[1], match.index)
  }
  for (const match of source.matchAll(/\bfrom\s+"(\.\.\/[^"]*)"/gu)) {
    add(match[1], match.index)
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*'(\.\.\/[^']*)'/gu)) {
    add(match[1], match.index)
  }
  for (const match of source.matchAll(/\bimport\s*\(\s*`(\.\.\/[^`$]*)\$\{/gu)) {
    add(match[1], match.index)
  }
  for (const match of source.matchAll(/^\s*import\s+'(\.\.\/[^']*)'/gmu)) {
    add(match[1], match.index)
  }
  for (const match of source.matchAll(/^\s*import\s+"(\.\.\/[^"]*)"/gmu)) {
    add(match[1], match.index)
  }
  return refs
}

/**
 * How many production references the source mentions, counted WITHOUT
 * knowing the forms.
 *
 * The comparison with {@link productionReferences} is the coverage proof:
 * a form the extractor does not recognise makes the two counts differ, and
 * the caller reports it instead of reporting a false assurance.
 *
 * A reference inside a plain string literal is NOT a reference of this
 * file: it is a source-lock assertion or a test fixture (many architecture
 * guards assert on the exact text of a production import). Those are
 * counted separately, so the comparison is exact rather than approximate.
 */
export function productionReferenceCount(source) {
  let count = 0
  for (const match of source.matchAll(/(?:new URL\(\s*|^\s*import\s+|\bfrom\s+|\bimport\s*\(\s*)['"`](\.\.\/[^'"`$]*)/gmu)) {
    if (isInsideStringLiteral(source, match.index)) continue
    count += 1
  }
  return count
}

/** Whether the offset falls inside a string literal. */
function isInsideStringLiteral(source, offset) {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  const line = source.slice(lineStart, offset)
  let quote = undefined
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '\\') {
      index += 1
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'" || char === '`') quote = char
  }
  return quote !== undefined
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
  // The COVERAGE proof: a reference form the extractor does not recognise
  // would make the check report a false assurance. The extractor's count is
  // compared against an independent, form-agnostic count; a difference is
  // REPORTED, not silently accepted.
  const uncovered = []

  for (const rel of files) {
    const source = readFileSync(resolve(TEST_ROOT, rel), 'utf8')
    const before = baseSource(rel)
    if (before === undefined) continue
    const beforeRefs = productionReferences(before)
    const afterRefs = productionReferences(source)
    if (beforeRefs.length === 0) continue
    compared += 1

    // The form-agnostic count must not exceed the extractor's count by
    // more than the source-lock strings the extractor deliberately skips
    // (a `from '…'` inside a plain string literal). A larger gap means
    // the extractor missed a form.
    const beforeRaw = productionReferenceCount(before)
    const afterRaw = productionReferenceCount(source)
    if (beforeRaw !== beforeRefs.length || afterRaw !== afterRefs.length) {
      uncovered.push(`${rel}: the extractor saw ${afterRefs.length} reference(s) but the source mentions ${afterRaw}`)
    }

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
  console.log(`files with a reference form the extractor did NOT recognise: ${uncovered.length}`)
  for (const entry of uncovered) console.log(`  ${entry}`)
  if (problems.length === 0) {
    console.log('\nno test now reads a DIFFERENT production file than before the move')
  } else {
    console.log('')
    for (const problem of problems) {
      console.log(`${problem.rel}`)
      for (const target of problem.removed) console.log(`  - ${target}`)
      for (const target of problem.added) console.log(`  + ${target}`)
    }
  }
  if (problems.length > 0 || uncovered.length > 0) process.exitCode = 1
}

// The module is importable: the extractor is proved by
// `test/tooling/migration-semantics.test.mjs`, which imports it directly.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
