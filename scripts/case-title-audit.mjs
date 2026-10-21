#!/usr/bin/env node
/**
 * The CASE TITLE AUDIT: report the case titles that still need work.
 *
 * The policy is in `docs/guides/testing.md` §7. This script does not
 * ENFORCE it — the judgement "is this title clear" belongs to the reviewer.
 * What it does is make the REVIEWABLE SET explicit: a title that leads with
 * a plan/milestone/review code, or a title that names a subject without
 * naming a result, is a candidate the reviewer must look at.
 *
 * It reads the inventory `scripts/case-inventory.mjs` collected from a real
 * lane run, so table-driven and `describe()`-nested cases are included with
 * their real titles.
 *
 * Usage:
 *   node scripts/case-title-audit.mjs --inventory inventory.json
 *   node scripts/case-title-audit.mjs --lane product
 * @module @xmoon76/dsh-pi-tui/scripts/case-title-audit
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { hasLeadingCodePrefix } from './strip-code-prefix.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Whether a title LED BY a code.
 *
 * The check calls the TRANSFORM's own predicate, so the audit and the
 * transform can never disagree about what a code is. An audit with its
 * own pattern can silently stop reporting the very titles the transform
 * would change, and a "no code-led titles" report based on a narrower
 * pattern is a false assurance.
 *
 * The code families are the ones this repository uses: `A5b`, `B4A-07`,
 * `PR5`, `M3-4`, `RFL-002`, `TS2`, `F1`, `S4-D2`, `RC2` …, the
 * plan-section markers (`§18.1`, `§1C-3`), and the compound forms
 * (`A06/Focus`, `B3 F6.1`, `PR D`, `E2–E5`).
 */
function ledByCode(title) {
  return hasLeadingCodePrefix(title)
}

/**
 * A title that names a SUBJECT without naming a RESULT.
 *
 * The heuristic is deliberately narrow: it fires only on the few shapes
 * that are unambiguously topic-only. A judgement about whether a title
 * "states the result" is a reviewer's, so this is a HINT, not a verdict.
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

/** The audit's verdict for one case. */
function classify(name) {
  if (ledByCode(name)) return 'CODE_PREFIX'
  if (TOPIC_ONLY.some(pattern => pattern.test(name))) return 'TOPIC_ONLY'
  return 'OK'
}

/**
 * Collect one lane's inventory.
 *
 * @param {string} lane - the lane name.
 * @returns {object} the inventory.
 */
function collectInventory(lane) {
  const path = join(ROOT, 'temp', `case-inventory-${lane}.json`)
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'scripts', 'case-inventory.mjs'), '--lane', lane, '--out', path],
    { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] },
  )
  if (result.status !== 0) {
    console.error(`the ${lane} case inventory could not be collected; the audit is not a measurement`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function main() {
  const args = process.argv.slice(2)
  const inventoryIndex = args.indexOf('--inventory')
  const laneIndex = args.indexOf('--lane')

  if (inventoryIndex !== -1) {
    report([JSON.parse(readFileSync(args[inventoryIndex + 1], 'utf8'))])
    return
  }
  // Without an explicit inventory, EVERY lane is audited: a report that
  // covered only the product lane would say nothing about the tooling
  // lane's titles, and a "no code-led titles" claim has to be true of the
  // whole tree.
  const lanes = laneIndex === -1 ? ['product', 'tooling'] : [args[laneIndex + 1]]
  report(lanes.map(collectInventory))
}

function report(inventories) {

  const findings = []
  for (const inventory of inventories) {
    for (const record of inventory.cases) {
      const verdict = classify(record.name)
      if (verdict !== 'OK') {
        findings.push({ lane: inventory.lane, verdict, file: record.file, line: record.line, name: record.name })
      }
    }
  }

  const byVerdict = {}
  for (const finding of findings) byVerdict[finding.verdict] = (byVerdict[finding.verdict] ?? 0) + 1

  for (const inventory of inventories) {
    console.log(`lane            ${inventory.lane}`)
    console.log(`files           ${inventory.fileCount}`)
    console.log(`cases           ${inventory.caseCount}`)
  }
  console.log(`candidates      ${findings.length}`)
  console.log(`by verdict      ${JSON.stringify(byVerdict)}`)
  console.log('')
  for (const finding of findings) {
    console.log(`${finding.verdict}\t${finding.lane}\t${finding.file}:${finding.line}\t${finding.name}`)
  }
}

main()
