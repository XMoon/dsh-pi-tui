#!/usr/bin/env node
/**
 * The per-file CASE-COUNT reconciliation between two trees.
 *
 * The migration moved test files between lanes and added new guards. The
 * case count of a lane therefore changes for three reasons, and each must
 * be EXPLAINED:
 *
 *   1. a file MOVED out of the lane (its cases left);
 *   2. a file MOVED into the lane (its cases arrived);
 *   3. a file's case count CHANGED (a test was added, merged or retired).
 *
 * This report produces that reconciliation from the two trees' JUnit-style
 * output, so the number in the delivery report is derived, not asserted.
 *
 * Usage: node scripts/reconcile-case-counts.mjs <before-junit> <after-junit>
 * @module @xmoon76/dsh-pi-tui/scripts/reconcile-case-counts
 */

import { readFileSync } from 'node:fs'

/** The per-file case count of a JUnit XML report. */
function countsFromJunit(xml) {
  const counts = new Map()
  // The JUnit shape: one `<testcase … file="…"/>` per case.
  for (const match of xml.matchAll(/<testcase\b[^>]*\bfile="([^"]*)"/gu)) {
    const file = comparableKey(match[1])
    counts.set(file, (counts.get(file) ?? 0) + 1)
  }
  if (counts.size > 0) return counts
  // The `<testsuite name=… tests=…>` shape.
  for (const match of xml.matchAll(/<testsuite\b[^>]*\bname="([^"]*)"[^>]*\btests="(\d+)"/gu)) {
    counts.set(comparableKey(match[1]), Number(match[2]))
  }
  if (counts.size > 0) return counts
  // The TAP shape: a `file` line, then its `# tests N` summary.
  let current = undefined
  for (const line of xml.split('\n')) {
    const file = /^# ([\w./-]+\.(?:test\.)?(?:ts|mjs))\s*$/u.exec(line)
    if (file !== null) {
      current = file[1]
      continue
    }
    const tests = /^# tests (\d+)$/u.exec(line)
    if (tests !== null && current !== undefined) {
      counts.set(current, Number(tests[1]))
      current = undefined
    }
  }
  return counts
}

/**
 * The comparable key of a report path: the path relative to the test root,
 * so two trees in different directories can be compared.
 */
function comparableKey(path) {
  const normalized = path.split('\\').join('/')
  const marker = '/test/'
  const index = normalized.lastIndexOf(marker)
  return index === -1 ? normalized : normalized.slice(index + marker.length)
}

function main() {
  const [beforePath, afterPath] = process.argv.slice(2)
  if (beforePath === undefined || afterPath === undefined) {
    console.error('usage: node scripts/reconcile-case-counts.mjs <before> <after>')
    process.exit(2)
  }
  const before = countsFromJunit(readFileSync(beforePath, 'utf8'))
  const after = countsFromJunit(readFileSync(afterPath, 'utf8'))
  const beforeTotal = [...before.values()].reduce((a, b) => a + b, 0)
  const afterTotal = [...after.values()].reduce((a, b) => a + b, 0)

  const movedOut = []
  const movedIn = []
  const changed = []
  for (const [file, count] of before) {
    if (!after.has(file)) movedOut.push([file, count])
  }
  for (const [file, count] of after) {
    if (!before.has(file)) movedIn.push([file, count])
  }
  for (const [file, count] of before) {
    if (!after.has(file)) continue
    if (after.get(file) !== count) changed.push([file, count, after.get(file)])
  }

  console.log(`before: ${before.size} files, ${beforeTotal} cases`)
  console.log(`after:  ${after.size} files, ${afterTotal} cases`)
  console.log(`delta:  ${afterTotal - beforeTotal} cases\n`)

  console.log(`=== moved OUT (${movedOut.length}) ===`)
  for (const [file, count] of movedOut) console.log(`  -${String(count).padStart(4)}  ${file}`)
  console.log(`\n=== moved IN (${movedIn.length}) ===`)
  for (const [file, count] of movedIn) console.log(`  +${String(count).padStart(4)}  ${file}`)
  console.log(`\n=== case count CHANGED (${changed.length}) ===`)
  for (const [file, from, to] of changed) console.log(`  ${String(from).padStart(4)} -> ${String(to).padStart(4)}  ${file}`)

  const explained = -movedOut.reduce((a, [, c]) => a + c, 0)
    + movedIn.reduce((a, [, c]) => a + c, 0)
    + changed.reduce((a, [, from, to]) => a + (to - from), 0)
  console.log(`\nexplained delta: ${explained} (measured ${afterTotal - beforeTotal})`)
  if (explained !== afterTotal - beforeTotal) {
    console.error('the reconciliation does NOT add up')
    process.exitCode = 1
  }
}

main()
