#!/usr/bin/env node
/**
 * The per-file CASE-COUNT reconciliation between two trees.
 *
 * A test-suite change must EXPLAIN every case-count change. The
 * reconciliation derives the explanation from the two trees' reports rather
 * than asserting it:
 *
 *   1. a file MOVED (its cases left one lane and arrived in another);
 *   2. a file was ADDED (its cases are new);
 *   3. a file was REMOVED (its cases are gone);
 *   4. a file's case count CHANGED (a test was added, merged or retired).
 *
 * A MOVE is claimed on a HEURISTIC: the file exists in the base tree under
 * one path and in the current tree under another, with the same basename and
 * the same case count, and the mapping is globally one-to-one. A report of
 * paths and counts CANNOT prove file identity, and the tool does not claim
 * to: the reconciliation's claim is "these cases moved from one path to
 * another", which is what the per-file counts support. An ambiguous pair is
 * reported as an ADDITION and a REMOVAL — never as a move.
 *
 * The report is VALIDATED against its own totals: a report whose parsed
 * case count disagrees with its declared total is REJECTED, so a partial
 * or truncated report can never produce a false reconciliation.
 *
 * Usage: node scripts/reconcile-case-counts.mjs <before-junit> <after-junit>
 * @module @xmoon76/dsh-pi-tui/scripts/reconcile-case-counts
 */

import { readFileSync } from 'node:fs'

/**
 * The declared totals of a JUnit report.
 *
 * `tests` is the report's own case count; `suites` is the number of
 * NESTED `<testsuite>` elements, each of which contributes one suite-level
 * entry to the report's total. The two together are what the parsed
 * per-file count is compared against.
 */
function declaredTotals(xml) {
  const totals = {}
  for (const match of xml.matchAll(/<!--\s*(tests|pass|fail|skipped|todo|suites)\s+(\d+)\s*-->/gu)) {
    totals[match[1]] = Number(match[2])
  }
  for (const match of xml.matchAll(/<testsuites\b[^>]*\btests="(\d+)"/gu)) {
    totals.tests ??= Number(match[1])
  }
  return totals
}

/**
 * The number of case entries in a report that carry NO `file` attribute,
 * plus the number of nested `<testsuite>` elements.
 *
 * Node's JUnit writer emits a `<testcase>` for every top-level `describe`
 * WITHOUT a `file` attribute, and a `<testsuite>` for every nested one.
 * Both are real report entries: the report's declared total counts them,
 * but neither can be attributed to a per-file count.
 */
function unattributedEntryCount(xml) {
  const withoutFile = [...xml.matchAll(/<testcase\b[^>]*>/gu)].filter(match => !match[0].includes('file=')).length
  const suites = [...xml.matchAll(/<testsuite\b[^>]*\bname="[^"]*"/gu)].length
  return withoutFile + suites
}

/**
 * The per-file case count of a JUnit XML report.
 *
 * The report is REJECTED when the parsed case count disagrees with the
 * report's own declared total: a partial report would otherwise produce
 * a false reconciliation.
 */
function countsFromJunit(xml, label) {
  const counts = new Map()
  // The JUnit shape: one `<testcase … file="…"/>` per case.
  for (const match of xml.matchAll(/<testcase\b[^>]*\bfile="([^"]*)"/gu)) {
    const file = comparableKey(match[1])
    counts.set(file, (counts.get(file) ?? 0) + 1)
  }
  if (counts.size > 0) {
    assertTotals(counts, xml, label)
    return counts
  }
  // The `<testsuite name=… tests=…>` shape.
  for (const match of xml.matchAll(/<testsuite\b[^>]*\bname="([^"]*)"[^>]*\btests="(\d+)"/gu)) {
    counts.set(comparableKey(match[1]), Number(match[2]))
  }
  if (counts.size > 0) {
    assertTotals(counts, xml, label)
    return counts
  }
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
  if (counts.size > 0) assertTotals(counts, xml, label)
  return counts
}

/** Reject a report whose parsed case count disagrees with its own total. */
function assertTotals(counts, xml, label) {
  const totals = declaredTotals(xml)
  if (totals.tests === undefined) return
  const parsed = [...counts.values()].reduce((a, b) => a + b, 0)
  // The report's total also includes the entries that carry no `file` and
  // the nested `<testsuite>` elements; the per-file count does not.
  const unattributed = unattributedEntryCount(xml)
  if (parsed + unattributed === totals.tests) return
  throw new Error(
    `the ${label} report is PARTIAL: it declares ${totals.tests} test(s) but only ${parsed} could be attributed to a file (${unattributed} unattributed entr(ies))`,
  )
}

/**
 * The report entries that carry NO file attribution.
 *
 * A report whose unattributed share is LARGE is a report whose per-file
 * counts cannot explain the lane: the case count is then not reconcilable
 * per file, and the tool must say so instead of reporting a tidy
 * reconciliation over the attributed part only.
 */
function unattributedShare(xml) {
  const totals = declaredTotals(xml)
  if (totals.tests === undefined || totals.tests === 0) return 0
  return unattributedEntryCount(xml) / totals.tests
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
  const beforeXml = readFileSync(beforePath, 'utf8')
  const afterXml = readFileSync(afterPath, 'utf8')
  const before = countsFromJunit(beforeXml, 'before')
  const after = countsFromJunit(afterXml, 'after')
  // The report's DECLARED totals are the authority for the lane's case
  // count; the per-file counts explain only the attributed part. If the
  // unattributed part CHANGES between the two reports, the per-file
  // reconciliation cannot explain the lane's delta, and the difference must
  // be shown as its own line — not absorbed into a file's count.
  const beforeDeclared = declaredTotals(beforeXml).tests
  const afterDeclared = declaredTotals(afterXml).tests
  const beforeUnattributed = unattributedEntryCount(beforeXml)
  const afterUnattributed = unattributedEntryCount(afterXml)
  if (beforeDeclared === undefined || afterDeclared === undefined) {
    throw new Error('a report without a declared total cannot be reconciled per file')
  }
  const beforeTotal = [...before.values()].reduce((a, b) => a + b, 0)
  const afterTotal = [...after.values()].reduce((a, b) => a + b, 0)
  const unattributedDelta = afterUnattributed - beforeUnattributed
  if (unattributedDelta !== 0) {
    throw new Error(
      `the two reports attribute a DIFFERENT number of cases to a file (${beforeUnattributed} vs ${afterUnattributed}): the per-file reconciliation cannot explain the lane's delta`,
    )
  }
  const beforeFiles = new Set(before.keys())
  const afterFiles = new Set(after.keys())
  // A MOVE is claimed only when the mapping is GLOBALLY ONE-TO-ONE: the
  // old path has exactly ONE candidate, AND that candidate is the only
  // old path that could claim it. An ambiguous pair (two old paths
  // competing for one new path, or one old path with two candidates) is
  // NOT a move — it is reported as a removal plus an addition.
  //
  // The candidate is matched by basename AND case count; that is a HEURISTIC,
  // and the report says so. A report that only knows paths and counts cannot
  // prove file identity, and does not pretend to: the reconciliation's claim
  // is "these cases moved from one path to another", which is what the
  // per-file counts support.
  const candidatesFor = new Map()
  for (const [beforePath_, count] of before) {
    if (afterFiles.has(beforePath_)) continue
    const base = beforePath_.split('/').pop()
    candidatesFor.set(beforePath_, [...afterFiles].filter(afterPath_ =>
      afterPath_.split('/').pop() === base && after.get(afterPath_) === count))
  }
  const claimedBy = new Map()
  for (const [beforePath_, candidates] of candidatesFor) {
    if (candidates.length !== 1) continue
    const [only] = candidates
    const claimants = [...candidatesFor].filter(([, list]) => list.includes(only))
    if (claimants.length !== 1) continue
    claimedBy.set(only, beforePath_)
  }
  const moves = new Map()
  for (const [beforePath_, candidates] of candidatesFor) {
    if (candidates.length !== 1) continue
    const [only] = candidates
    if (claimedBy.get(only) !== beforePath_) continue
    moves.set(beforePath_, only)
  }

  const movedOut = []
  const movedIn = []
  const added = []
  const removed = []
  const changed = []
  for (const [file, count] of before) {
    if (moves.has(file)) {
      movedOut.push([file, moves.get(file), count])
      continue
    }
    if (!afterFiles.has(file)) removed.push([file, count])
  }
  for (const [file, count] of after) {
    if ([...moves.values()].includes(file)) continue
    if (!beforeFiles.has(file)) added.push([file, count])
  }
  for (const [file, count] of before) {
    if (!afterFiles.has(file) || moves.has(file)) continue
    if (after.get(file) !== count) changed.push([file, count, after.get(file)])
  }

  // The LANE's totals are the reports' DECLARED counts; the per-file counts
  // explain the attributed part, and the unattributed remainder is shown
  // as its own line.
  console.log(`before: ${before.size} files, ${beforeDeclared} cases (${beforeTotal} attributed, ${beforeUnattributed} unattributed)`)
  console.log(`after:  ${after.size} files, ${afterDeclared} cases (${afterTotal} attributed, ${afterUnattributed} unattributed)`)
  console.log(`delta:  ${afterDeclared - beforeDeclared} cases\n`)

  console.log(`=== moved (${movedOut.length}) ===`)
  console.log('  (a move is a same-basename, same-case-count path match that is')
  console.log('   globally one-to-one; a report of paths and counts cannot prove')
  console.log('   file identity, and does not claim to)')
  for (const [from, to, count] of movedOut) console.log(`  ${String(count).padStart(4)}  ${from} -> ${to}`)
  console.log(`\n=== added (${added.length}) ===`)
  for (const [file, count] of added) console.log(`  +${String(count).padStart(4)}  ${file}`)
  console.log(`\n=== removed (${removed.length}) ===`)
  for (const [file, count] of removed) console.log(`  -${String(count).padStart(4)}  ${file}`)
  console.log(`\n=== case count CHANGED (${changed.length}) ===`)
  for (const [file, from, to] of changed) console.log(`  ${String(from).padStart(4)} -> ${String(to).padStart(4)}  ${file}`)

  // A MOVE contributes ZERO to the delta: the same cases left one path and
  // arrived at another. An ADDITION contributes its cases; a REMOVAL
  // subtracts them; a CHANGED count contributes the difference.
  const explained = added.reduce((a, [, count]) => a + count, 0)
    - removed.reduce((a, [, count]) => a + count, 0)
    + changed.reduce((a, [, from, to]) => a + (to - from), 0)
  console.log(`\nexplained delta: ${explained} (measured ${afterDeclared - beforeDeclared})`)
  if (explained !== afterDeclared - beforeDeclared) {
    console.error('the reconciliation does NOT add up')
    process.exitCode = 1
  }
}

main()
