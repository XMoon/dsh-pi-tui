/**
 * The headless driver's OWN teardown contract.
 *
 * `scripts/tern-pane-drive.mjs` runs `tern serve` as a DIRECT child and owns its
 * lifetime. A signal, a normal finish, a throwing flow and a startup failure
 * must all wait for that child's ChildProcess `close` before the driver exits,
 * and the run's own evidence directory must survive every one of them.
 *
 * The Tern client is not required: the driver is exercised against a fake CLI,
 * so this file needs neither Tern nor a display. The signal paths run against a
 * fake `serve` that stays alive, which is what the real server does.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, join as joinPath } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  killStillExecuting, readPidRecords, startTimeOf, waitForNoExecuting, waitForPidRecords,
} from '../support/pid-records.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = joinPath(here, '../..')
const driver = joinPath(repo, 'scripts', 'tern-pane-drive.mjs')

/**
 * A fake Tern CLI: the `serve` invocation stays alive (it is the process the
 * driver owns), and every control command answers the shape the driver reads.
 */
function writeFakeTern(dir) {
  const log = joinPath(dir, 'calls.log')
  const script = `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
const reply = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0) }
// A long-lived serve process RECORDS its identity so teardown is checked
// against THIS process: a bare PID would confuse a zombie or a reused PID with
// a survivor.
const startTime = () => {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '-'
  } catch { return '-' }
}
const recordPid = (kind) => appendFileSync(${JSON.stringify(log)}.replace('calls.log', 'pids.log'), kind + ' ' + process.pid + ' ' + startTime() + '\\n')
if (args[0] === '--version') { process.stdout.write('tern 0.0.0-fake\\n'); process.exit(0) }
if (args[0] === 'serve') {
  // FAKE_STDIO_HOLD=1 makes a GRANDCHILD inherit this serve process's
  // stdout/stderr and keep them open until the test releases it. The driver's
  // ChildProcess close event cannot arrive while that pipe is open, which is
  // what proves the teardown waits for the child instead of only signalling it.
  // The holder's PID is recorded BEFORE the serve record, so a test that sees
  // the record can already reach the holder.
  if (process.env.FAKE_STDIO_HOLD === '1') {
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30); process.on("SIGUSR1", () => process.exit(0))'], { stdio: 'inherit' })
    writeFileSync(${JSON.stringify(join(log, '..'))} + '/holder.pid', String(holder.pid))
  }
  recordPid('serve')
  // FAKE_SERVE_EXITS=1 models a server that died before it answered.
  if (process.env.FAKE_SERVE_EXITS === '1') process.exit(0)
  setInterval(() => {}, 1 << 30)
}
if (args[0] !== 'ctl') process.exit(0)
// FAKE_CTL_FAIL=1 makes every control command unacknowledged: the driver can
// never reach "ready" and must fail rather than wait forever.
if (process.env.FAKE_CTL_FAIL === '1') process.exit(1)
const rest = args.slice(2)
const command = rest[1] ?? 'unknown'
if (command === 'stats') reply({ ok: true, viewport: [1280, 800], pointer: [0, 0], frames: 1, nodes: 1 })
if (command === 'tree') reply({ ok: true, tree: [] })
reply({ ok: true })`

  const file = joinPath(dir, 'fake-tern.mjs')
  writeFileSync(file, script)
  const launcher = joinPath(dir, 'fake-tern')
  writeFileSync(launcher, `#!/bin/sh
exec ${process.execPath} "$(dirname "$0")/fake-tern.mjs" "$@"
`)
  chmodSync(launcher, 0o755)
  return { log, file: launcher }
}

/** A flow that finishes immediately; the run's exit code then means what it says. */
const CHECKED_FLOW = 'export default async function (h) { h.check("the flow ran", true) }\n'
/** A flow that throws: a red run, not a missing one. */
const THROWING_FLOW = 'export default async function () { throw new Error("the flow failed") }\n'
/** A flow that parks forever: the test needs a LIVE driver to signal. */
const PARKED_FLOW = 'export default async function () { await new Promise(() => {}) }\n'

/**
 * Run one driver whose flow finishes on its own and assert the run left no
 * `serve` process executing and did NOT delete the run's evidence directory.
 */
async function assertFinishedRunTearsDown(t, prefix, { flow, env = {}, expectedStatus, expectedStderr }) {
  const life = testLifecycle(t)
  const dir = life.tempDir(prefix)
  const fake = writeFakeTern(dir)
  const flowPath = joinPath(dir, 'flow.mjs')
  writeFileSync(flowPath, flow)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flowPath, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, ...env },
  })
  assert.equal(result.status, expectedStatus, result.stdout + result.stderr)
  if (expectedStderr !== undefined) assert.match(result.stderr, expectedStderr)

  const records = readPidRecords(joinPath(dir, 'pids.log'))
  assert.equal(records.length, 1, `the run started one serve process: ${JSON.stringify(records)}`)
  const survivors = await waitForNoExecuting(records, 5_000)
  assert.deepEqual(survivors, [], `the serve process does not outlive the driver: ${JSON.stringify(survivors)}`)
  // The headless driver KEEPS its run directory: unlike the GUI's temporary
  // socket directory, this is the run's evidence and no teardown may delete it.
  assert.ok(existsSync(joinPath(out, 'run.log')), 'the run directory is preserved')
  return { out, result }
}

/**
 * Start the driver, wait until its `serve` recorded its identity, then deliver
 * `signal` and assert the run's final state.
 */
async function assertSignalTearDown(t, prefix, signal) {
  const life = testLifecycle(t)
  const dir = life.tempDir(prefix)
  const fake = writeFakeTern(dir)
  const flowPath = joinPath(dir, 'flow.mjs')
  writeFileSync(flowPath, PARKED_FLOW)
  const out = joinPath(dir, 'out')
  const pidsFile = joinPath(dir, 'pids.log')
  const child = spawn(process.execPath, [driver, flowPath, '--out', out], {
    env: { ...process.env, TERN_BIN: fake.file },
    stdio: 'ignore',
  })
  // The test's OWN cleanup runs in `t.after`, i.e. only AFTER the assertions:
  // it must never stop the serve process first and then claim the driver did.
  life.defer(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } })
  life.defer(() => { killStillExecuting(readPidRecords(pidsFile)) })

  // Deadline reason: the fixture records its identity synchronously at
  // startup; this only bounds a broken fixture, it is not a settle window.
  const records = await waitForPidRecords(pidsFile, 1, 30_000)
  const exited = new Promise((resolve) => child.on('exit', (code, exitSignal) => resolve({ code, signal: exitSignal })))
  child.kill(signal)
  const exit = await exited
  // A cancelled run keeps its interruption status: a teardown must not turn it
  // into a clean exit 0.
  assert.equal(exit.signal, signal, `the driver exits BY the signal, got ${JSON.stringify(exit)}`)

  const survivors = await waitForNoExecuting(records, 5_000)
  assert.deepEqual(survivors, [], `the serve process was torn down before the driver exited: ${JSON.stringify(survivors)}`)
  assert.ok(existsSync(joinPath(out, 'run.log')), 'a cancelled run keeps its evidence')
}

test('a normal headless run tears down its serve process and keeps the run directory', async (t) => {
  await assertFinishedRunTearsDown(t, 'tern-pane-normal-', { flow: CHECKED_FLOW, expectedStatus: 0 })
})

test('a flow that throws still tears down its serve process before the driver exits', async (t) => {
  const { out } = await assertFinishedRunTearsDown(t, 'tern-pane-throws-', {
    flow: THROWING_FLOW,
    expectedStatus: 1,
  })
  const ledger = JSON.parse(readFileSync(joinPath(out, 'assertions.json'), 'utf8'))
  assert.equal(ledger.failed, 1, 'the throwing flow is a red run, not a missing one')
})

test('a serve that exits during startup fails the startup after teardown', async (t) => {
  await assertFinishedRunTearsDown(t, 'tern-pane-startup-', {
    flow: CHECKED_FLOW,
    env: { FAKE_SERVE_EXITS: '1', FAKE_CTL_FAIL: '1' },
    expectedStatus: 2,
    expectedStderr: /exited before it answered the control socket/,
  })
})

test('a SIGTERM to the headless driver tears down the serve process', async (t) => {
  await assertSignalTearDown(t, 'tern-pane-sigterm-', 'SIGTERM')
})

test('a SIGINT to the headless driver tears down the serve process', async (t) => {
  await assertSignalTearDown(t, 'tern-pane-sigint-', 'SIGINT')
})

test('the headless driver does not exit while its serve process still holds stdio open', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-pane-stdio-')
  const fake = writeFakeTern(dir)
  const flowPath = joinPath(dir, 'flow.mjs')
  writeFileSync(flowPath, PARKED_FLOW)
  const out = joinPath(dir, 'out')
  const pidsFile = joinPath(dir, 'pids.log')
  const child = spawn(process.execPath, [driver, flowPath, '--out', out], {
    env: { ...process.env, TERN_BIN: fake.file, FAKE_STDIO_HOLD: '1' },
    stdio: 'ignore',
  })
  life.defer(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } })
  life.defer(() => { killStillExecuting(readPidRecords(pidsFile)) })

  const records = await waitForPidRecords(pidsFile, 1, 30_000)
  const holderPid = Number(readFileSync(joinPath(dir, 'holder.pid'), 'utf8'))
  life.defer(() => { killStillExecuting([{ kind: 'holder', pid: holderPid, startTime: startTimeOf(holderPid) }]) })

  let exitedEarly = false
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => {
    exitedEarly = true
    resolve({ code, signal })
  }))
  child.kill('SIGTERM')
  // reason: a bounded observation of a NEGATIVE fact — the teardown must not finish while the child holds stdio.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(exitedEarly, false, 'the driver exited before its serve process reached close')

  // Release the pipe: only NOW can the serve process's `close` arrive.
  process.kill(holderPid, 'SIGUSR1')
  const exit = await exited
  assert.equal(exit.signal, 'SIGTERM', `the driver exits BY the signal, got ${JSON.stringify(exit)}`)

  const survivors = await waitForNoExecuting(records, 5_000)
  assert.deepEqual(survivors, [], `the serve process was torn down: ${JSON.stringify(survivors)}`)
})
