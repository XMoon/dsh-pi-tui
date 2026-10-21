#!/usr/bin/env node
/**
 * The title DISPOSITION list: every case title and what was done to it.
 *
 * The plan's N-PR4 asks for a REVIEWABLE account of the whole title
 * population, not a count. This produces it: every case title of every
 * lane, with the disposition the policy gives it — kept as it is, or
 * rewritten, or flagged for a reviewer's judgement.
 *
 * The disposition is derived from the CURRENT title, so the list is a
 * statement about the tree as it stands.
 *
 * Usage:
 *   node scripts/case-title-disposition.mjs --out disposition.json
 *   node scripts/case-title-disposition.mjs --out disposition.json --print
 * @module @xmoon76/dsh-pi-tui/scripts/case-title-disposition
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasLeadingCodePrefix } from './case-title-label.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A title that names a SUBJECT without naming a RESULT.
 *
 * A HINT for the reviewer, not a verdict: the same shapes the audit
 * reports.
 */
const TOPIC_ONLY = [
  /^tests?\s+/u,
  /^checks?\s+/u,
  /^verif(?:y|ies|ication)\s+/u,
  /^handles?\s+/u,
  /^covers?\s+/u,
  /^regression[:\s]/u,
  /^basic\b/u,
]

/** The disposition of one title. */
function disposition(name) {
  if (hasLeadingCodePrefix(name)) return 'CODE_PREFIX'
  if (TOPIC_ONLY.some(pattern => pattern.test(name))) return 'TOPIC_ONLY'
  return 'KEPT'
}

function main() {
  const args = process.argv.slice(2)
  const outIndex = args.indexOf('--out')
  const print = args.includes('--print')
  const lanes = ['product', 'tooling']

  const cases = []
  for (const lane of lanes) {
    const path = join(ROOT, 'temp', `case-inventory-${lane}.json`)
    const result = spawnSync(
      process.execPath,
      [join(ROOT, 'scripts', 'case-inventory.mjs'), '--lane', lane, '--out', path],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
    )
    if (result.status !== 0) {
      console.error(`the ${lane} case inventory could not be collected`)
      process.exit(1)
    }
    const inventory = JSON.parse(readFileSync(path, 'utf8'))
    for (const record of inventory.cases) {
      cases.push({
        lane,
        file: record.file,
        line: record.line,
        title: record.name,
        disposition: disposition(record.name),
      })
    }
  }

  const byDisposition = {}
  for (const entry of cases) {
    byDisposition[entry.disposition] = (byDisposition[entry.disposition] ?? 0) + 1
  }

  const report = {
    totals: {
      cases: cases.length,
      byDisposition,
    },
    cases,
  }
  if (outIndex !== -1) {
    writeFileSync(resolve(args[outIndex + 1]), `${JSON.stringify(report, null, 2)}\n`)
  }
  if (print) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`cases            ${cases.length}`)
    console.log(`by disposition   ${JSON.stringify(byDisposition)}`)
  }
}

main()
