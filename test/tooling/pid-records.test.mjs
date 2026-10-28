/**
 * The shared PID-record observer: the record FILE is the authority and a file
 * event only notifies a re-read.
 *
 * These cases pin the contract the tooling owners rely on: records that already
 * exist settle without an event, records written after the wait starts wake
 * it, a fixture that never reaches the count fails at its deadline instead of
 * hanging, and a settled observation releases its deadline timer instead of
 * surviving until it fires. The watcher close itself is source-reviewed (a
 * closed FSWatcher has no event to observe); the child here proves the timer.
 *
 * The narrow "record written between the first read and the watcher
 * registration" window has no deterministic external trigger; it is closed by
 * the post-registration re-read in `pid-records.ts` and reviewed there.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/pid-records.test
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { waitForPidRecords } from '../support/pid-records.ts'

const repo = join(import.meta.dirname, '..', '..')
const record = (kind, pid) => `${kind} ${pid} -\n`

function tempDir(t) {
  return testLifecycle(t).tempDir('pid-records-')
}

test('records that already exist settle without waiting for a file event', async (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'pids.log')
  writeFileSync(file, record('daemon', 101) + record('window', 102))
  const records = await waitForPidRecords(file, 2, 30_000)
  assert.deepEqual(records.map((entry) => entry.kind), ['daemon', 'window'])
})

test('a record written after the wait starts resolves it from the file event', async (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'pids.log')
  writeFileSync(file, record('daemon', 201))
  // The watcher is armed synchronously by the call, so this later write is a
  // real event, not the registration-window race.
  const pending = waitForPidRecords(file, 2, 30_000)
  appendFileSync(file, record('window', 202))
  const records = await pending
  assert.deepEqual(records.map((entry) => entry.kind), ['daemon', 'window'])
})

test('a fixture that never reaches the count fails at its deadline with the observed records', async (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'pids.log')
  writeFileSync(file, record('daemon', 301))
  // The 100ms bound is the failure limit the helper itself owns; the contract
  // under test is the REJECTION and its message, not a settle window.
  await assert.rejects(
    waitForPidRecords(file, 2, 100),
    /the fixture wrote 1 PID record\(s\) within 100ms/u,
  )
})

test('a settled wait releases its deadline instead of waiting it out', async (t) => {
  const dir = tempDir(t)
  const file = join(dir, 'pids.log')
  // A CHILD owns the observation so the release is observable: a surviving
  // deadline timer would keep it alive until the 60s deadline fires.
  const runner = join(dir, 'runner.mjs')
  writeFileSync(runner, `import { appendFileSync } from 'node:fs'
import { waitForPidRecords } from ${JSON.stringify(pathToFileURL(join(repo, 'test', 'support', 'pid-records.ts')).href)}
const file = process.argv[2]
const pending = waitForPidRecords(file, 1, 60_000)
appendFileSync(file, 'daemon 401 -\\n')
const records = await pending
if (records.length !== 1) process.exit(9)
// A LATE write after the settlement must not keep a pending observation alive.
appendFileSync(file, 'window 402 -\\n')
process.stdout.write('settled')
`)
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', runner, file], {
    cwd: repo,
    encoding: 'utf8',
    // Far below the child's own 60s deadline: only a RELEASED timer can finish
    // this run, so a leak fails here instead of passing on a short wait.
    timeout: 10_000,
  })
  assert.equal(result.error, undefined,
    `the settled wait must release its deadline: ${result.error?.message ?? ''}`)
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.equal(result.stdout, 'settled')
})
