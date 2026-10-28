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
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, join as joinPath } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  isExecuting, killStillExecuting, readPidRecords, waitForNoExecuting, waitForPidRecords,
} from '../support/pid-records.ts'
import { waitForFileLine } from '../support/wait-for-file.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = joinPath(here, '../..')
const driver = joinPath(repo, 'scripts', 'tern-pane-drive.mjs')

/**
 * A fake Tern CLI: the `serve` invocation stays alive (it is the process the
 * driver owns), and every control command answers the shape the driver reads.
 */
function writeFakeTern(dir) {
  const log = joinPath(dir, 'calls.log')
  // The holder INSTALLS its release handler and only THEN writes this fixture's
  // startup witness: the test waits for the witness before it may send SIGUSR1,
  // so the signal can never race the holder's own startup.
  const holderScript = `const { writeFileSync } = require('node:fs'); process.on('SIGUSR1', () => process.exit(0)); writeFileSync(${JSON.stringify(joinPath(dir, 'holder-ready'))}, ''); setInterval(() => {}, 1 << 30)`
  const script = `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
const startTimeOfPid = (pid) => {
  try {
    const stat = readFileSync('/proc/' + pid + '/stat', 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '-'
  } catch { return '-' }
}
const recordPid = (kind) => appendFileSync(${JSON.stringify(log)}.replace('calls.log', 'pids.log'), kind + ' ' + process.pid + ' ' + startTime() + '\\n')
const pidsFile = ${JSON.stringify(joinPath(dir, 'pids.log'))}
// Whether THIS run's recorded serve identity is still an EXECUTING process. A
// readiness reply must never come from a witness a server left before dying.
const serveIdentityExecuting = () => {
  if (!existsSync(pidsFile)) return false
  const record = readFileSync(pidsFile, 'utf8').split('\\n').find((line) => line.startsWith('serve '))
  if (record === undefined) return false
  const [, rawPid, rawStart] = record.split(' ')
  try {
    const stat = readFileSync('/proc/' + rawPid + '/stat', 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[0] !== 'Z' && (rawStart === '-' || fields[19] === rawStart)
  } catch {
    // Without /proc the recorded identity itself is the whole evidence.
    return rawStart === '-'
  }
}
if (args[0] === '--version') { process.stdout.write('tern 0.0.0-fake\\n'); process.exit(0) }
if (args[0] === 'serve') {
  // FAKE_STDIO_HOLD=1 makes a GRANDCHILD inherit this serve process's
  // stdout/stderr and keep them open until the test releases it. The driver's
  // ChildProcess close event cannot arrive while that pipe is open, which is
  // what proves the teardown waits for the child instead of only signalling it.
  // The holder's PID and start time are recorded BEFORE the serve record, so a
  // test that sees the record can already reach the holder by its identity.
  if (process.env.FAKE_STDIO_HOLD === '1') {
    const holder = spawn(process.execPath, ['-e', ${JSON.stringify(holderScript)}], { stdio: 'inherit' })
    writeFileSync(join(${JSON.stringify(join(log, '..'))}, 'holder.pid'), String(holder.pid) + ' ' + startTimeOfPid(holder.pid))
  }
  recordPid('serve')
  // FAKE_SERVE_EXITS=1 models a server that died before it answered: it is a
  // started process with an identity, but it never reaches its startup witness.
  if (process.env.FAKE_SERVE_EXITS === '1') process.exit(0)
  // The run's OWN startup witness, written by THIS process into the directory
  // the driver spawned it in. A readiness reply is authorized only by this
  // fact, so an early fake stats reply can never stand in for a serve that
  // really started.
  writeFileSync(join(process.cwd(), 'serve-started'), '')
  // Stay alive like the real server: the interval keeps the event loop alive
  // and the await keeps this branch from falling through to the non-control
  // exit below.
  setInterval(() => {}, 1 << 30)
  await new Promise(() => {})
}
if (args[0] !== 'ctl') process.exit(0)
// FAKE_CTL_FAIL=1 makes every control command unacknowledged: the driver can
// never reach "ready" and must fail rather than wait forever.
if (process.env.FAKE_CTL_FAIL === '1') process.exit(1)
const rest = args.slice(2)
const command = rest[1] ?? 'unknown'
if (command === 'stats') {
  // Readiness is THIS run's startup fact: the control socket names the run
  // directory, and the serve process writes its witness there. A shared fixture
  // log or an unconditional OK would let the driver run a flow whose server
  // never started (or has already exited). A nonzero exit is how this fake
  // refuses an unacknowledged control command, so the driver's startup loop
  // retries.
  if (rest[0] === undefined || !existsSync(join(dirname(rest[0]), 'serve-started'))) process.exit(1)
  // The witness must still describe an EXECUTING process: a stale witness from
  // a server that already died must not authorize a flow.
  if (!serveIdentityExecuting()) process.exit(1)
  reply({ ok: true, viewport: [1280, 800], pointer: [0, 0], frames: 1, nodes: 1 })
}
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

/** Read the stdio holder's recorded PID + start-time pair, if one was written. */
function readHolderIdentity(dir) {
  const holderFile = joinPath(dir, 'holder.pid')
  if (!existsSync(holderFile)) return undefined
  const [rawPid, rawStart] = readFileSync(holderFile, 'utf8').trim().split(/\s+/u)
  const pid = Number(rawPid)
  if (!Number.isInteger(pid) || pid <= 0) return undefined
  return { kind: 'holder', pid, startTime: rawStart === undefined || rawStart === '-' ? undefined : rawStart }
}

/** Whether `promise` settles within `deadlineMs`; the timer never outlives the wait. */
async function settlesWithin(promise, deadlineMs) {
  let timer
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), deadlineMs) })
  const result = await Promise.race([promise.then(() => true), timedOut])
  clearTimeout(timer)
  return result
}

/**
 * Register the test's OWN teardown for THIS fixture: stop the stdio holder the
 * fake recorded, then the `serve` processes it recorded, and fail loudly when a
 * recorded identity still executes.
 *
 * The fake's helpers are long-lived by contract, so a case that fails before the
 * driver's own teardown must still stop them. The records are read at cleanup
 * time and carry PID + start time, so only the helper that really started is
 * signalled; the holder goes first because it is what keeps the serve process's
 * stdio open. `testLifecycle` removes the fixture temp root afterwards, and no
 * run evidence (`--out`) or socket directory belongs to this test.
 *
 * An EMPTY record is not proof that no helper started. The driver creates
 * `<run>/shots` immediately before spawning `serve`, so a shots directory with
 * no serve record means the server may still be starting: wait for ITS own
 * identity record, and fail loudly instead of claiming a cleanup that was
 * never proven. The driver's direct-child stop runs FIRST (registered later,
 * LIFO) and waits for its exit, so by this point it cannot spawn anything new.
 */
function deferRecordedFixtureCleanup(life, dir) {
  life.defer(async () => {
    const pidsFile = joinPath(dir, 'pids.log')
    const problems = []
    let serveRecords = readPidRecords(pidsFile)
    if (serveRecords.length === 0 && existsSync(joinPath(dir, 'out', 'shots'))) {
      try {
        await waitForFileLine(pidsFile, /^serve \d+ \S+$/u, 10_000)
      } catch (error) {
        problems.push(`a serve may have started without publishing its identity: ${error.message}`)
      }
      serveRecords = readPidRecords(pidsFile)
    }
    const holder = readHolderIdentity(dir)
    if (holder !== undefined) killStillExecuting([holder])
    killStillExecuting(serveRecords)
    const survivors = await waitForNoExecuting(
      holder === undefined ? serveRecords : [...serveRecords, holder], 5_000)
    if (survivors.length > 0) {
      problems.push(`the test-owned fixture cleanup left helpers executing: ${JSON.stringify(survivors)}`)
    }
    if (problems.length > 0) throw new Error(problems.join('; '))
  })
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
  // Registered BEFORE the synchronous spawn: a failed wait or assertion below
  // must still stop the helpers THIS fixture started.
  deferRecordedFixtureCleanup(life, dir)
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
  // The test's OWN fixture cleanup runs in `t.after`, i.e. only AFTER the
  // assertions: it must never stop the serve process first and then claim the
  // driver did. It is registered before the spawn so an early failure still
  // stops whatever the fixture managed to start.
  deferRecordedFixtureCleanup(life, dir)
  const child = spawn(process.execPath, [driver, flowPath, '--out', out], {
    env: { ...process.env, TERN_BIN: fake.file },
    stdio: 'ignore',
  })
  // The child's terminal state is observed the moment it exists: the test must
  // not miss an exit that lands while it is still waiting for the PID record.
  const exited = new Promise((resolve) => child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal })))
  // The direct-child last resort is separate from the fixture-helper cleanup,
  // and registering it after that cleanup makes it run FIRST (LIFO). It WAITS
  // for the child's exit: only a settled launcher proves it cannot spawn a
  // helper while the fixture cleanup snapshots identities.
  life.defer(async () => {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    if (!await settlesWithin(exited, 5_000)) {
      assert.fail(`the driver did not reach exit before the test-owned cleanup deadline: pid=${child.pid ?? 'not-spawned'}`)
    }
  })

  // Deadline reason: the fixture records its identity synchronously at
  // startup; this only bounds a broken fixture, it is not a settle window.
  const records = await waitForPidRecords(pidsFile, 1, 30_000)
  // The harness writes its first run.log line only once the run is READY, and
  // that file is the evidence this case asserts afterwards. Interrupting before
  // it exists would race the driver's own startup instead of testing teardown.
  await waitForFileLine(joinPath(out, 'run.log'), /TERN /u, 30_000)
  // The signal must reach the RECORDED process while it executes, not merely a
  // PID a broken fixture left behind.
  assert.equal(isExecuting(records[0]), true, `the recorded serve process is executing before the signal: ${JSON.stringify(records[0])}`)
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
  const { out } = await assertFinishedRunTearsDown(t, 'tern-pane-normal-', { flow: CHECKED_FLOW, expectedStatus: 0 })
  // The run's OWN readiness fact: the serve process recorded its identity and
  // reached its startup witness inside this run's directory.
  assert.ok(existsSync(joinPath(out, 'serve-started')), 'the serve process wrote its own startup witness')
  // T1's RUNTIME execution evidence: the driver runs the flow only after a
  // successful `stats` reply, and the fake replies only while THIS run's
  // recorded serve identity is executing. A green flow therefore records an
  // execution observation made by the run itself, not a post-hoc inference.
  assert.match(readFileSync(joinPath(out, 'run.log'), 'utf8'), /ASSERT PASS the flow ran/u,
    'the flow ran only after the runtime readiness gate')
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
  const { out } = await assertFinishedRunTearsDown(t, 'tern-pane-startup-', {
    flow: CHECKED_FLOW,
    env: { FAKE_SERVE_EXITS: '1', FAKE_CTL_FAIL: '1' },
    expectedStatus: 2,
    expectedStderr: /exited before it answered the control socket/,
  })
  // It was a real spawn — the one record above — but it never claimed readiness.
  assert.equal(existsSync(joinPath(out, 'serve-started')), false,
    'a serve that exits during startup never writes a startup witness')
})

test('the fake control channel grants readiness only after THIS run\'s serve wrote its startup witness', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-pane-ready-')
  const fake = writeFakeTern(dir)
  // Registered before the spawn: a failed wait below must still stop the
  // fixture helper this case started.
  deferRecordedFixtureCleanup(life, dir)
  // The driver's run directory already exists when the real control command
  // runs, and the control socket names it.
  const out = joinPath(dir, 'out')
  mkdirSync(out, { recursive: true })
  const socket = joinPath(out, 'tern.sock')
  const stats = () => spawnSync(fake.file, ['ctl', '--control', socket, 'stats'], { encoding: 'utf8' })

  // No startup witness: a successful reply would let the driver run a flow
  // before its server started, which is the race this fake must not model.
  const refused = stats()
  assert.notEqual(refused.status, 0, 'stats must refuse before the serve startup witness exists')

  const serveStarted = joinPath(out, 'serve-started')
  // The witness waiter is armed BEFORE the serve process exists: a write that
  // lands during the waiter's own registration can never be missed.
  const witness = waitForFileLine(serveStarted, /^$/u, 20_000)
  const serve = spawn(fake.file, ['serve'], { cwd: out, stdio: 'ignore' })
  const exited = new Promise((resolve) => serve.once('exit', (code, signal) => resolve({ code, signal })))
  life.defer(async () => {
    try { serve.kill('SIGKILL') } catch { /* already gone */ }
    if (!await settlesWithin(exited, 5_000)) {
      assert.fail(`the fake serve did not reach exit before the test-owned cleanup deadline: pid=${serve.pid ?? 'not-spawned'}`)
    }
  })
  // The witness is written by the serve process AFTER its own identity record,
  // so awaiting it proves both the startup fact and its position in that order.
  await witness
  const records = readPidRecords(joinPath(dir, 'pids.log'))
  assert.equal(records.length, 1, `the serve process recorded its own identity: ${JSON.stringify(records)}`)
  assert.equal(isExecuting(records[0]), true, `the recorded serve process is executing: ${JSON.stringify(records[0])}`)

  // The SAME command and socket, now authorized by this run's own fact.
  const ready = stats()
  assert.equal(ready.status, 0, ready.stdout + ready.stderr)
  assert.equal(JSON.parse(ready.stdout).ok, true, `the ready reply has the driver's shape: ${ready.stdout}`)
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
  // Registered before the spawn so a failed wait still stops the holder and the
  // serve process; the direct-child stop below is a separate, later (and
  // therefore earlier-running) last resort.
  deferRecordedFixtureCleanup(life, dir)
  const child = spawn(process.execPath, [driver, flowPath, '--out', out], {
    env: { ...process.env, TERN_BIN: fake.file, FAKE_STDIO_HOLD: '1' },
    stdio: 'ignore',
  })
  // The child's terminal state is observed from the moment it exists, so an
  // early exit cannot land unobserved while the test still reads PID records.
  let exitedEarly = false
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => {
    exitedEarly = true
    resolve({ code, signal })
  }))
  // The direct-child stop WAITS for the driver's exit before the fixture cleanup
  // snapshots helper identities: a killed-but-not-settled launcher could still
  // be spawning them.
  life.defer(async () => {
    try { child.kill('SIGKILL') } catch { /* already gone */ }
    if (!await settlesWithin(exited, 5_000)) {
      assert.fail(`the driver did not reach exit before the test-owned cleanup deadline: pid=${child.pid ?? 'not-spawned'}`)
    }
  })

  const records = await waitForPidRecords(pidsFile, 1, 30_000)
  const holder = readHolderIdentity(dir)
  assert.ok(holder !== undefined, `the fixture recorded the holder identity: ${JSON.stringify(holder)}`)
  assert.equal(isExecuting(holder), true, `the stdio holder is executing before the driver is signalled: ${JSON.stringify(holder)}`)
  // The holder installs its SIGUSR1 handler BEFORE writing this startup witness:
  // waiting for it removes the release-signal race with the holder's own start.
  await waitForFileLine(joinPath(dir, 'holder-ready'), /^$/u, 20_000)

  child.kill('SIGTERM')
  // reason: a bounded observation of a NEGATIVE fact — the teardown must not finish while the child holds stdio.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(exitedEarly, false, 'the driver exited before its serve process reached close')

  // Release the pipe: only NOW can the serve process's `close` arrive. The
  // recorded holder identity is the only process this test may signal here.
  process.kill(holder.pid, 'SIGUSR1')
  const exit = await exited
  assert.equal(exit.signal, 'SIGTERM', `the driver exits BY the signal, got ${JSON.stringify(exit)}`)

  // T6: BOTH the holder and the serve process are observed stopped in the test
  // body itself, so the fixture cleanup cannot mask a surviving holder.
  const survivors = await waitForNoExecuting([...records, holder], 5_000)
  assert.deepEqual(survivors, [], `the holder and the serve process were torn down: ${JSON.stringify(survivors)}`)
})
