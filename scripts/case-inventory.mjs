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
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
 * The lane is executed by the REPOSITORY'S OWN RUNNER
 * (`scripts/run-test-lane.mjs`) — the same entry point `pnpm test:product`
 * uses — so the collected list is the list the qualification lane really
 * runs, with the runner's own discovery, temp-root contract, exit-code
 * handling and reporter wiring. The runner's job is to run a lane; the
 * inventory's job is to read the records that run produced.
 */
async function collect(laneName) {
  const lane = LANES[laneName]
  if (lane === undefined) {
    throw new Error(`unknown test lane: ${laneName}\nlanes: ${Object.keys(LANES).join(', ')}`)
  }
  // The run's disposable temp root, and SEPARATELY the file the reporter
  // writes its records to.
  //
  // They must not be the same directory: the temp root is handed to the
  // tests as their TMPDIR, and some of them run a NESTED test lane inside
  // it. A nested run inherits the reporter's destination variable and would
  // write its own records into this run's file.
  const recordRoot = mkdtempSync(join(tmpdir(), 'dsh-pi-tui-inventory-records-'))
  const jsonl = join(recordRoot, 'cases.jsonl')
  const child = spawn(
    process.execPath,
    [join(ROOT, 'scripts', 'run-test-lane.mjs'), laneName],
    {
      cwd: ROOT,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: false,
      env: { ...process.env, DSH_TEST_JSONL: jsonl },
    },
  )
  const code = await new Promise((resolve_) => {
    child.on('close', exitCode => resolve_(exitCode ?? 1))
  })
  const records = readFileSync(jsonl, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
  rmSync(recordRoot, { recursive: true, force: true })
  if (code !== 0) {
    throw new Error(`the ${laneName} lane exited ${code}; the inventory is not a measurement`)
  }
  const files = resolveLane(TEST_ROOT, lane.patterns, lane.suffixes, lane.exclude ?? [])
  return { lane: laneName, files, records }
}

async function main() {
  const args = process.argv.slice(2)
  const laneIndex = args.indexOf('--lane')
  const outIndex = args.indexOf('--out')
  const laneName = laneIndex === -1 ? 'product' : args[laneIndex + 1]
  const print = args.includes('--print')

  const { files, records } = await collect(laneName)
  // The entries are separated by Node's OWN type, not by a guess from the
  // name or the nesting depth.
  //
  // A `describe()` block is a SUITE, and a suite at the top level has
  // nesting 0 — exactly like a plain test — so the nesting depth cannot
  // tell them apart. Node reports the type on the completion, so that is
  // what is used.
  //
  // A FILE's own root entry is the one whose NAME is the file's own path;
  // Node reports it as a `test`, so the type alone cannot identify it
  // either.
  const fileEntries = records.filter(record => record.name === record.file)
  const suites = records.filter(record => record.type === 'suite' && record.name !== record.file)
  const cases = records.filter(record => record.type === 'test' && record.name !== record.file)

  const inventory = {
    lane: laneName,
    fileCount: files.length,
    fileEntryCount: fileEntries.length,
    caseCount: cases.length,
    suiteCount: suites.length,
    files,
    cases,
    suites,
  }

  if (outIndex !== -1) {
    // The destination's PARENT may not exist: the report goes to `temp/`,
    // and `temp/` is not tracked, so a clean checkout has no such
    // directory. Creating it here means the command works on its own,
    // instead of failing AFTER the whole lane has run.
    const destination = resolve(args[outIndex + 1])
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, `${JSON.stringify(inventory, null, 2)}\n`)
  }
  if (print || outIndex === -1) {
    console.log(JSON.stringify(inventory, null, 2))
  }
}

await main()
