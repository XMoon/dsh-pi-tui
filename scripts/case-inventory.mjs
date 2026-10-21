#!/usr/bin/env node
/**
 * The CASE INVENTORY: the machine-readable list of every case a lane runs.
 *
 * The title policy (see `docs/guides/testing.md`) is about the names a CI
 * reporter SHOWS — the full title of every case, not the file it lives in.
 * Judging those names needs the real list, with the real describe-chain,
 * the real result and the real source location.
 *
 * A TEXT SCAN of the test tree cannot produce that list:
 *
 *   - `it.each` / table-driven cases build their titles at RUN time, so a
 *     regex sees the template, not the case;
 *   - a `describe()` chain contributes to the title the reader sees, and a
 *     regex loses it;
 *   - a skipped case is a case, and a regex cannot tell it from a comment.
 *
 * So the inventory is collected from the RUN: the lane's own reporter emits
 * one JSONL record per case, and this script resolves those records into
 * the inventory. The runner is the authority, exactly as the plan requires.
 *
 * The inventory is a REPORT, not a manifest: it is written where the caller
 * asks for it, and nothing in the repository depends on its content.
 *
 * Usage:
 *   node scripts/case-inventory.mjs --lane product --out inventory.json
 *   node scripts/case-inventory.mjs --lane product --print
 * @module @xmoon76/dsh-pi-tui/scripts/case-inventory
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveLane } from './test-discovery.mjs'
import { LANES } from './test-lanes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TEST_ROOT = join(ROOT, 'test')
const REPORTER = join(ROOT, 'scripts', 'test-case-reporter.mjs')

/**
 * Run one lane and collect its case records.
 *
 * The lane is executed by the SAME runner the repository uses
 * (`scripts/run-test-lane.mjs`), so the collected list is the list the
 * qualification lane really runs — not a re-derived approximation.
 */
async function collect(laneName) {
  const lane = LANES[laneName]
  if (lane === undefined) {
    throw new Error(`unknown test lane: ${laneName}\nlanes: ${Object.keys(LANES).join(', ')}`)
  }
  const files = resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])
  const relativeFiles = files.map(rel => join('test', rel))

  // The run's disposable temp root, and SEPARATELY the file the reporter
  // writes its records to.
  //
  // They must not be the same directory: the temp root is handed to the
  // tests as their TMPDIR, and some of them run a NESTED test lane inside
  // it. A nested run inherits the reporter's destination variable and would
  // write its own records into this run's file.
  const root = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-inventory-'))
  const recordRoot = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-inventory-records-'))
  const jsonl = join(recordRoot, 'cases.jsonl')
  const child = spawn(
    process.execPath,
    ['--test', `--test-reporter=${REPORTER}`, ...relativeFiles],
    {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: false,
      env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root, DSH_TEST_JSONL: jsonl },
    },
  )
  const code = await new Promise((resolve_) => {
    child.on('close', exitCode => resolve_(exitCode ?? 1))
  })
  const records = readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  rmSync(root, { recursive: true, force: true })
  rmSync(recordRoot, { recursive: true, force: true })
  if (code !== 0) {
    throw new Error(`the ${laneName} lane exited ${code}; the inventory is not a measurement`)
  }
  return { lane: laneName, files, records }
}

async function main() {
  const args = process.argv.slice(2)
  const laneIndex = args.indexOf('--lane')
  const outIndex = args.indexOf('--out')
  const laneName = laneIndex === -1 ? 'product' : args[laneIndex + 1]
  const print = args.includes('--print')

  const { files, records } = await collect(laneName)
  // A FILE is reported as one case whose name is the file's own path. The
  // inventory separates it from the cases inside the file, so the case count
  // matches the reporter's own `tests` count.
  const fileEntries = records.filter(record => record.name === record.file)
  const cases = records.filter(record => record.name !== record.file)
  const suites = cases.filter(record => record.nesting > 0)

  const inventory = {
    lane: laneName,
    fileCount: files.length,
    fileEntryCount: fileEntries.length,
    caseCount: cases.length,
    suiteCount: suites.length,
    files,
    cases,
  }

  if (outIndex !== -1) {
    writeFileSync(args[outIndex + 1], `${JSON.stringify(inventory, null, 2)}\n`)
  }
  if (print || outIndex === -1) {
    console.log(JSON.stringify(inventory, null, 2))
  }
}

await main()
