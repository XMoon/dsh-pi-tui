#!/usr/bin/env node
/**
 * The CASE DISTRIBUTION: where the product lane's time actually goes.
 *
 * The JSONL the reporter writes records every case's duration, but a SUM of
 * the case durations is NOT a file's wall clock: a file pays for its
 * process start, its module loading and its teardown on top of its cases,
 * and the cases of one file may overlap in wall-clock terms with the
 * runner's other workers.
 *
 * So this report keeps the two apart:
 *
 *   - the CASE view: the slowest cases, ranked by their own duration;
 *   - the FILE view: the sum of a file's case durations, which is an upper
 *     bound on that file's own cost, and the case count it carries.
 *
 * A file whose case durations sum to far more than its share of the wall
 * clock is a candidate for a closer look (a long tail, a per-file
 * start-up cost, or a hanging handle); a file that is slow but has few
 * cases is a different story from a file with many cheap cases. The report
 * gives the numbers; the conclusion is a reviewer's.
 *
 * Usage:
 *   node scripts/case-distribution.mjs --jsonl cases.jsonl --out dist.json
 * @module @xmoon76/dsh-pi-tui/scripts/case-distribution
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** How many entries each ranked list carries. */
const TOP = 20

function main() {
  const args = process.argv.slice(2)
  const jsonlIndex = args.indexOf('--jsonl')
  const outIndex = args.indexOf('--out')
  if (jsonlIndex === -1) {
    console.error('usage: node scripts/case-distribution.mjs --jsonl <file> [--out <file>]')
    process.exit(2)
  }

  const records = readFileSync(args[jsonlIndex + 1], 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))

  // A FILE is reported as one case whose name is the file's own path.
  const fileEntries = records.filter(record => record.name === record.file)
  const cases = records.filter(record => record.name !== record.file)

  const byFile = new Map()
  for (const record of cases) {
    const entry = byFile.get(record.file) ?? { file: record.file, caseCount: 0, caseDurationMs: 0, fileDurationMs: 0 }
    entry.caseCount += 1
    entry.caseDurationMs += record.duration_ms ?? 0
    entry.fileDurationMs += record.duration_ms ?? 0
    byFile.set(record.file, entry)
  }

  const files = [...byFile.values()].sort((a, b) => b.caseDurationMs - a.caseDurationMs)
  const slowestCases = [...cases]
    .filter(record => typeof record.duration_ms === 'number')
    .sort((a, b) => b.duration_ms - a.duration_ms)

  const ownerOf = (file) => file.split('/')[1] ?? 'root'
  const byOwner = new Map()
  for (const entry of files) {
    const owner = ownerOf(entry.file)
    const aggregate = byOwner.get(owner) ?? { owner, fileCount: 0, caseCount: 0, caseDurationMs: 0 }
    aggregate.fileCount += 1
    aggregate.caseCount += entry.caseCount
    aggregate.caseDurationMs += entry.caseDurationMs
    byOwner.set(owner, aggregate)
  }

  const result = {
    totals: {
      files: files.length,
      cases: cases.length,
      caseDurationMs: cases.reduce((sum, record) => sum + (record.duration_ms ?? 0), 0),
      fileEntryDurationMs: fileEntries.reduce((sum, record) => sum + (record.duration_ms ?? 0), 0),
    },
    topSlowestFiles: files.slice(0, TOP),
    topSlowestCases: slowestCases.slice(0, TOP).map(record => ({
      file: record.file,
      line: record.line,
      name: record.name,
      duration_ms: record.duration_ms,
      result: record.result,
    })),
    byOwner: [...byOwner.values()].sort((a, b) => b.caseDurationMs - a.caseDurationMs),
  }

  if (outIndex !== -1) {
    writeFileSync(args[outIndex + 1], `${JSON.stringify(result, null, 2)}\n`)
  }
  console.log(JSON.stringify(result, null, 2))
}

main()
