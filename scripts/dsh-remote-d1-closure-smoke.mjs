#!/usr/bin/env node
/**
 * Bounded D1 read-capability closure gate. Lower-level same-Host proof scripts
 * own their fixtures and assertions; this script aggregates their results into
 * the explicit read-gap ledger without duplicating that logic.
 *
 * @module dsh-remote-d1-closure-smoke
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KNOWN_SKIPS = Object.freeze([
  'session.createdAt',
  'session.live',
  'session.measureContext',
  'subagent.descendantTree',
  'presentation.leadingTurnCompleteness',
])

function runProof(name, script, parse) {
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', resolve(ROOT, script)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
  })
  if (result.error !== undefined) throw new Error(`${name} failed to start: ${result.error.message}`)
  if (result.status !== 0) {
    const detail = `${result.stdout}${result.stderr}`.trim().slice(-2_000)
    throw new Error(`${name} failed (exit ${String(result.status)}): ${detail}`)
  }
  return parse(result.stdout)
}

function parseJsonProof(name, output) {
  const line = output.trim().split('\n').at(-1)
  assert.ok(line !== undefined && line.length > 0, `${name} emitted no result`)
  const report = JSON.parse(line)
  assert.equal(report.status, 'passed', `${name} did not pass`)
  assert.equal(report.comparable, true, `${name} was not comparable`)
  assert.equal(report.mismatchCount, 0, `${name} reported mismatches`)
  return {
    status: report.status,
    comparable: report.comparable,
    mismatchCount: report.mismatchCount,
    skipped: report.skipped,
  }
}

function parseTextProof(name, expected, output, skipped) {
  assert.match(output, expected, `${name} did not emit its success marker`)
  return { status: 'passed', comparable: true, mismatchCount: 0, skipped }
}

function main() {
  const session = runProof(
    'session read parity',
    'scripts/dsh-remote-session-read-parity-smoke.mjs',
    output => parseTextProof('session read parity', /same-Host remote session parity smoke passed/, output, [
      'session.createdAt',
      'session.live',
      'session.measureContext',
    ]),
  )
  const surfaceAuthority = runProof(
    'surface authority parity',
    'scripts/dsh-remote-surface-authority-parity-smoke.mjs',
    output => parseTextProof('surface authority parity', /same-Host surface authority parity smoke passed/, output, []),
  )
  const task = runProof(
    'task read parity',
    'scripts/dsh-remote-task-read-parity-smoke.mjs',
    output => parseJsonProof('task read parity', output),
  )
  const presentation = runProof(
    'presentation parity',
    'scripts/dsh-remote-presentation-parity-smoke.mjs',
    output => parseJsonProof('presentation parity', output),
  )

  const domains = {
    session,
    surfaceAuthority,
    taskDirectCatalog: task,
    jobs: { ...task, skipped: [] },
    presentationHistory: presentation,
    presentationFocus: presentation,
  }
  const skipped = [...new Set(Object.values(domains).flatMap(report => report.skipped))]
  assert.deepEqual(skipped, KNOWN_SKIPS)
  assert.equal(Object.values(domains).every(report => report.status === 'passed' && report.comparable && report.mismatchCount === 0), true)
  console.log(JSON.stringify({
    status: 'passed',
    comparable: true,
    mismatchCount: 0,
    skipped,
    domains,
  }))
}

main()
