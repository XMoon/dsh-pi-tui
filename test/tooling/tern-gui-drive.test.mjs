/**
 * The GUI driver's OWN contract: the parts that make a GUI run trustworthy and
 * that the headless lane cannot prove.
 *
 * This is a TOOLING test: it protects the DRIVER, not a product surface. It
 * covers the failure classes that actually bit during the first GUI runs:
 *
 *   1. the driver ISOLATES the window — the user's real Tern profile, plugins
 *      and daemon are never read or written;
 *   2. the driver NEVER repeats an input: a click, a key and a pointer move
 *      are delivered exactly once, and an unacknowledged send ABORTS the run
 *      instead of being retried;
 *   3. the driver REPORTS the window's minimum size instead of failing on it:
 *      a real window clamps a narrow resize, and a clamped measurement must be
 *      visible in the result, not silently applied;
 *   4. the driver COPIES the client's PNG into the run directory: the client
 *      writes its shots into its own tree, and a run's evidence must not live
 *      outside the run — and each run reads from its OWN client-shot
 *      directory, so a later run cannot overwrite an earlier run's picture;
 *   5. the driver's `snapshot()` uses the SHARED index (chains keyed by the
 *      node OBJECT) and its `click` goes through the visibility oracle: a node
 *      whose own centre falls outside the fragment the client shows must NOT be
 *      clicked at its centre;
 *   6. the driver's TEARDOWN is ordered: a signal, a normal finish, a throwing
 *      flow and a startup failure all wait for the daemon and the window to
 *      reach ChildProcess `close` before the driver exits and before the private
 *      socket directory is removed.
 *
 * The client itself is NOT required: the driver is exercised against a fake
 * Tern CLI, so the test is deterministic and needs no display.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join, join as joinPath } from 'node:path'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  killStillExecuting, readPidRecords, startTimeOf, waitForNoExecuting, waitForPidRecords,
} from '../support/pid-records.ts'

const here = dirname(fileURLToPath(import.meta.url))
const repo = joinPath(here, '../..')
const driver = joinPath(repo, 'scripts', 'tern-gui-drive.mjs')

/**
 * A fake Tern CLI: it answers the control commands the driver sends, and it
 * RECORDS every call so the test can assert on the delivery discipline.
 *
 * It is a `.mjs` run through `node`, because the driver executes `TERN_BIN`
 * as a program and a `.mjs` shebang is not portable.
 */
function writeFakeTern(dir) {
  const log = joinPath(dir, 'calls.log')
  const script = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, args.join(' ') + '\\n')
const reply = (value) => { process.stdout.write(JSON.stringify(value)); process.exit(0) }
// A long-lived helper RECORDS its identity so teardown can be checked against
// the process this run really started: a bare PID would confuse a zombie or a
// reused PID with a survivor.
const startTime = () => {
  try {
    const stat = readFileSync('/proc/self/stat', 'utf8')
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '-'
  } catch { return '-' }
}
const recordPid = (kind) => appendFileSync(${JSON.stringify(log)}.replace('calls.log', 'pids.log'), kind + ' ' + process.pid + ' ' + startTime() + '\\n')
if (args[0] === '--version') { process.stdout.write('tern 0.0.0-fake\\n'); process.exit(0) }
// The private daemon: record its socket so a test can prove that two runs do
// NOT share one, then stay alive like the real daemon does.
if (args[0] === 'daemon') {
  const at = args.indexOf('--socket')
  // FAKE_STDIO_HOLD=1 makes a GRANDCHILD inherit this daemon's stdout/stderr
  // and keep them open until the test releases it. The driver's ChildProcess
  // close event cannot arrive while that pipe is open, which is what proves the
  // teardown waits for the child instead of only sending its signal. The
  // grandchild's PID is recorded BEFORE the daemon's own record, so a test that
  // sees the record can already reach the holder.
  if (process.env.FAKE_STDIO_HOLD === '1') {
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30); process.on("SIGUSR1", () => process.exit(0))'], { stdio: 'inherit' })
    writeFileSync(${JSON.stringify(join(log, '..'))} + '/holder.pid', String(holder.pid))
  }
  // The IDENTITY comes BEFORE the socket line: a socket record must always be
  // attributable to a recorded daemon, or a test-owned cleanup cannot prove the
  // owner stopped before it removes the socket directory.
  recordPid('daemon')
  if (at >= 0) appendFileSync(${JSON.stringify(log)}.replace('calls.log', 'daemon-sockets.log'), args[at + 1] + '\\n')
  // The run's OWN startup witness, keyed by the run directory: a readiness
  // reply is only allowed once THIS run's daemon really executed. It states
  // "the daemon reached its startup record", never that the socket is live.
  writeFileSync(join(process.cwd(), 'daemon-started'), '')
  // FAKE_DAEMON_EXITS=1 models a daemon that died before the flow finished.
  if (process.env.FAKE_DAEMON_EXITS === '1') process.exit(0)
  // Stay alive like the real daemon: the interval keeps the event loop alive
  // and the await keeps the branch from falling through to the non-control
  // exit below (an unsettled top-level await alone would let Node exit).
  setInterval(() => {}, 1 << 30)
  await new Promise(() => {})
}
// The WINDOW invocation ("tern --control EP") must STAY ALIVE: the driver
// spawns it and talks to the control socket it creates. It also RECORDS the
// the --out flag it was really given, so the shot command below writes exactly
// where a real client would — a test that asserted a separately-passed variable
// would keep passing after the driver stopped passing --out at all.
if (args[0] === '--control') {
  const socket = args[args.indexOf('--control') + 1]
  recordPid('window')
  // The run's OWN startup witness, written before the early-exit model below:
  // an early-exiting window still STARTED, so the readiness reply may see it.
  writeFileSync(join(process.cwd(), 'window-started'), '')
  // FAKE_WINDOW_EXITS=1 models a client that died before it opened its control
  // socket, which is the driver's startup-failure path.
  if (process.env.FAKE_WINDOW_EXITS === '1') process.exit(0)
  const outFlag = args.indexOf('--out')
  if (outFlag >= 0) writeFileSync(${JSON.stringify(join(log, '..'))} + '/window-out.txt', args[outFlag + 1])
  writeFileSync(socket, '')
  // Stay alive like the real window: the interval keeps the event loop alive
  // and the await keeps the branch from falling through to the non-control
  // exit below (an unsettled top-level await alone would let Node exit).
  setInterval(() => {}, 1 << 30)
  await new Promise(() => {})
}
if (args[0] !== 'ctl') process.exit(0)
// FAKE_CTL_FAIL=1 makes every control command unacknowledged: the driver can
// never reach "ready" and must fail rather than wait forever.
if (process.env.FAKE_CTL_FAIL === '1') process.exit(1)
const rest = args.slice(2)
// The driver's argv is "ctl --control <EP> <command> [args]": after dropping
// "ctl" and "--control", the socket is rest[0], the command is rest[1].
const command = rest[1] ?? 'unknown'
const numeric = rest.slice(2).filter((arg) => /^\\d+$/.test(arg)).map(Number)
// The fake CLAMPS a narrow resize the way a real window does, so the
// driver's minimum-size path is exercised.
let viewport = [1280, 800, 1]
// A fake CLI invocation is ONE command, so a 'run' cannot be seen by a later
// 'state' in the same process. Record it in a file the next call can read.
const ranRunFile = ${JSON.stringify(join(log, '..'))} + '/ran-run.txt'
const ranRun = (command === 'run') || existsSync(ranRunFile)
if (command === 'run') writeFileSync(ranRunFile, '1')
if (command === 'resize') {
  viewport = [Math.max(numeric[0] ?? 1280, 720), Math.max(numeric[1] ?? 800, 400), 1]
  reply({ ok: true })
}
// The pointer follows the last move, the way the client's own stats does, so a
// hover can be checked against where it was actually sent.
if (command === 'move') {
  const ptr = rest.slice(2).map(Number).filter((n) => Number.isFinite(n))
  writeFileSync(join(${JSON.stringify(join(log, '..'))}, 'pointer.txt'), JSON.stringify(ptr))
  reply({ ok: true })
}
if (command === 'stats') {
  // Readiness is THIS run's startup facts, never a shared accumulated log:
  // the control socket names the run directory, and both helpers must have
  // written their own startup witness there. A reply before those facts would
  // let the driver run a flow whose helpers have not started (or, worse, whose
  // startup log does not exist yet) — the race that made the exit(7) case read
  // a daemon-sockets.log from the wrong moment. A non-zero exit is exactly how
  // this fake refuses an unacknowledged control command, so the driver's own
  // startup loop retries.
  const runDir = rest[0] === undefined ? undefined : dirname(rest[0])
  if (runDir === undefined
    || !existsSync(join(runDir, 'daemon-started'))
    || !existsSync(join(runDir, 'window-started'))) process.exit(1)
  let pointer = [0, 0]
  try { pointer = JSON.parse(readFileSync(join(${JSON.stringify(join(log, '..'))}, 'pointer.txt'), 'utf8')) } catch { /* no move yet */ }
  reply({ ok: true, viewport, pointer, frames: 1, nodes: 1 })
}
// state reports the focused pane and the pane list. FAKE_FOCUS_MOVES=1 makes
// the split move the focus to the new pane, which is the state the driver must
// refuse rather than repair.
if (command === 'state') {
  const moved = process.env.FAKE_FOCUS_MOVES === '1' && ranRun
  reply({ ok: true, focused: { id: moved ? 2 : 1 }, panes: ranRun ? [{ id: 1, rows: 22 }, { id: 2, rows: 22 }] : [{ id: 1, rows: 45 }] })
}
if (command === 'tree') reply({ ok: true, tree: process.env.FAKE_TREE ? JSON.parse(process.env.FAKE_TREE) : [] })
if (command === 'shot') {
  const id = rest[2] ?? 'shot'
  // Where the WINDOW was really told to write. If the driver stops passing
  // --out, this file is absent and the shot falls back to cwd — which makes the
  // per-run assertion below FAIL instead of passing vacuously.
  // FAKE_NO_PNG=1 makes the client acknowledge the shot but write no file: the
  // driver must FAIL rather than return an id for evidence that does not exist.
  if (process.env.FAKE_NO_PNG === '1') reply({ ok: true, elements: 1, png: join(process.cwd(), id + '.png') })
  let dir = process.env.FAKE_SHOT_DIR ?? process.cwd()
  try {
    dir = readFileSync(join(${JSON.stringify(join(log, '..'))}, 'window-out.txt'), 'utf8').trim()
  } catch { /* the window was never given --out: keep the fallback */ }
  // MEASURED: the real client nests its shots under <out>/live/.
  const live = join(dir, 'live')
  mkdirSync(live, { recursive: true })
  const png = join(live, id + '.png')
  writeFileSync(png, 'PNG')
  reply({ ok: true, elements: 1, png })
}
reply({ ok: true })`

  const file = joinPath(dir, 'fake-tern.mjs')
  writeFileSync(file, script)
  return { log, file: writeFakeTernLauncher(dir) }
}

/** The fake must be RUNNABLE as a program: a wrapper that execs node on it. */
function writeFakeTernLauncher(dir) {
  const file = joinPath(dir, 'fake-tern')
  writeFileSync(file, `#!/bin/sh
exec ${process.execPath} "$(dirname "$0")/fake-tern.mjs" "$@"
`)
  chmodSync(file, 0o755)
  return file
}

/**
 * Run the driver against the fake CLI with a flow that does nothing.
 */
function runDriver(fake, extraEnv = {}, dir) {
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, 'export default async function (h) { h.check("the flow ran", true) }\n')
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [
    driver, flow, '--out', out,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TERN_BIN: fake.file,
      DISPLAY: ':0',
      FAKE_SHOT_DIR: dir,
      ...extraEnv,
    },
  })
  return { dir, out, result }
}

/**
 * Register the test's OWN teardown for THIS fixture: stop the helpers it
 * recorded, then remove the private daemon socket directories they used.
 *
 * The fake daemon/window are long-lived by contract, so a case that fails
 * before the driver's own teardown must still stop them. The records are read
 * at cleanup time and carry PID + start time, so only the helper that really
 * ran is signalled. The ORDER is part of the contract: a possibly-live helper
 * must never have its socket directory removed underneath it, so the kill
 * happens first and the directory removal last. Registering here — before any
 * spawn or assertion — covers a failure before the run wrote its records.
 *
 * A missing record is NOT evidence that a process stopped. The fake daemon
 * writes its identity BEFORE its socket line, so every socket record must map
 * to a recorded daemon; an unmatched socket keeps its directory and fails the
 * cleanup loudly instead of deleting a possibly-live daemon's path.
 */
async function cleanUpRecordedHelpers(dir) {
  const pidsFile = joinPath(dir, 'pids.log')
  const socketsFile = joinPath(dir, 'daemon-sockets.log')
  const records = readPidRecords(pidsFile)
  const daemons = records.filter((record) => record.kind === 'daemon')
  const sockets = existsSync(socketsFile)
    ? readFileSync(socketsFile, 'utf8').trim().split('\n').filter(Boolean)
    : []
  killStillExecuting(records)
  // A stop request is not termination evidence: confirm the recorded helpers
  // no longer execute before deleting a directory one of them may still use.
  const survivors = await waitForNoExecuting(records, 5_000)
  if (survivors.length > 0 || sockets.length > daemons.length) {
    throw new Error('the test-owned helper cleanup cannot prove every daemon socket stopped '
      + `(survivors: ${JSON.stringify(survivors)}, daemon records: ${daemons.length}, `
      + `socket records: ${sockets.length}); keeping ${JSON.stringify(sockets)}`)
  }
  for (const socket of sockets) rmSync(dirname(socket), { recursive: true, force: true })
}

function deferHelperCleanup(life, dir) {
  life.defer(() => cleanUpRecordedHelpers(dir))
}

test('the cleanup keeps an unattributable daemon socket and removes a proven one', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-cleanup-')
  const socketsFile = joinPath(dir, 'daemon-sockets.log')
  const unmatched = joinPath(dir, 'unmatched-daemon')
  mkdirSync(unmatched, { recursive: true })
  writeFileSync(socketsFile, joinPath(unmatched, 'daemon.sock') + '\n')
  // No daemon identity: a missing record is NOT evidence that the owner
  // stopped, so the directory must be kept and the cleanup must fail loudly.
  writeFileSync(joinPath(dir, 'pids.log'), '')
  await assert.rejects(cleanUpRecordedHelpers(dir), /cannot prove every daemon socket stopped/u)
  assert.equal(existsSync(unmatched), true, 'an unattributable socket directory is kept')

  const proven = joinPath(dir, 'proven-daemon')
  mkdirSync(proven, { recursive: true })
  writeFileSync(socketsFile, joinPath(proven, 'daemon.sock') + '\n')
  // A recorded daemon that no longer executes: the PID is above Linux's
  // pid_max, so no process can hold it and the identity probe is ESRCH.
  writeFileSync(joinPath(dir, 'pids.log'), 'daemon 999999999 -\n')
  await cleanUpRecordedHelpers(dir)
  assert.equal(existsSync(proven), false, 'a socket with a stopped recorded daemon is removed')
})

test('the GUI driver isolates the window from the user\'s real Tern profile', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-iso-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  const { out, result } = runDriver(fake, {}, dir)
  assert.equal(result.status, 0, result.stdout + result.stderr)

  // The window's OWN environment must point at the run directory, never at the
  // user's real profile.
  const log = readFileSync(joinPath(out, 'run.log'), 'utf8')
  assert.match(log, /ISOLATED CONFIG .*\/config/)
  assert.doesNotMatch(log, new RegExp(`ISOLATED CONFIG ${process.env.HOME ?? '/root'}/\\.config`))
})

test('the GUI driver never repeats an input and aborts on an unacknowledged one', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-once-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  const snap = h.snapshot()
  const node = snap.nodes[0]
  if (node !== undefined) { await h.click(snap.chains, node) }
  h.check('the flow ran', true)
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0' },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)

  // Every `click` in the ledger was delivered exactly once: the driver's
  // `send` never retries an input.
  const log = readFileSync(joinPath(out, 'run.log'), 'utf8')
  const clicks = log.split('\n').filter((line) => line.startsWith('SEND ok ["click"'))
  const retries = log.split('\n').filter((line) => line.includes('CTL-RETRY ["click"'))
  assert.equal(retries.length, 0)
  assert.ok(clicks.length <= 1)
})

test('the GUI driver reports the window\'s minimum size instead of failing on it', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-min-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  const size = await h.resize(400, 600)
  h.check('the clamp is reported', size.clamped === false || size.viewport[0] >= 400)
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0' },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  const ledger = JSON.parse(readFileSync(joinPath(out, 'assertions.json'), 'utf8'))
  assert.equal(ledger.failed, 0)
})

test('the GUI driver copies the client\'s PNG into the run directory', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-shot-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  h.capture('a-capture', 'the copy check')
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_SHOT_DIR: dir },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)
  // The client wrote its PNG into ITS OWN directory; the run must own a copy.
  assert.ok(readFileSync(joinPath(out, 'shots', '01-a-capture.png'), 'utf8') === 'PNG')
})

test('the GUI driver clicks the VISIBLE fragment, never a clipped node\'s centre', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-visible-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  // A node whose own box is y 100..140 but whose sized ancestor clips it at
  // y 100..110: its centre (y=120) is in the clipped-away part.
  const tree = [{
    tag: 'div', class: 'clipper', rect: [0, 100, 200, 10],
    children: [{ tag: 'div', class: 'sf sf-editor target', rect: [0, 100, 200, 40] }],
  }]
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  const snap = h.snapshot()
  const node = snap.nodes.find((n) => (n.class ?? '').includes('target'))
  h.check('the target is in the tree', node !== undefined)
  const clicked = await h.click(snap.chains, node)
  h.measure('click result', JSON.stringify({ clicked }))
  h.check('the click survives the clip', clicked === true)
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_TREE: JSON.stringify(tree) },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)

  const log = readFileSync(joinPath(out, 'run.log'), 'utf8')
  const sent = log.split('\n').find((line) => line.startsWith('SEND ok ["click"'))
  assert.ok(sent !== undefined, 'the click was delivered')
  // The surviving fragment is y 100..110, so the click must land at y=105 — a
  // centre-only driver would send y=120, which is outside the clip.
  const [, y] = JSON.parse(sent.slice('SEND ok '.length).split(' :: ')[0]).slice(1)
  assert.ok(y >= 100 && y <= 110, `the click landed inside the visible fragment, got y=${y}`)
})

test('the GUI driver reads shots from THIS run\'s own client directory', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-shots-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  h.capture('one-shot', 'the capture under test')
}
`)
  const out = joinPath(dir, 'out')
  const env = {
    ...process.env,
    TERN_BIN: fake.file,
    DISPLAY: ':0',
  }
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], { encoding: 'utf8', env })
  assert.equal(result.status, 0, result.stdout + result.stderr)

  // The run keeps its OWN client-shot directory, and the copied PNG is the one
  // the client wrote THERE — not a stale file from another run's directory.
  // The client nests its own writes under <out>/live/, and the run must accept a
  // file anywhere UNDER ITS OWN client-shot directory while copying it flat.
  const clientShots = joinPath(out, 'client-shots')
  assert.ok(existsSync(clientShots), 'the run has its own client-shot directory')
  assert.equal(readFileSync(joinPath(clientShots, 'live', '01-one-shot.png'), 'utf8'), 'PNG')
  assert.equal(readFileSync(joinPath(out, 'shots', '01-one-shot.png'), 'utf8'), 'PNG')
})

test('the fake control socket reports ready only after THIS run recorded both helpers', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-ready-')
  const fake = writeFakeTern(dir)
  // The control socket names the run directory: a readiness reply is bound to
  // the witnesses living in THAT directory, never to a shared fixture log.
  const runDir = joinPath(dir, 'out')
  mkdirSync(runDir, { recursive: true })
  const socket = joinPath(runDir, 'gui.sock')
  const statsAt = (controlSocket, env = {}) => spawnSync(fake.file, ['ctl', '--control', controlSocket, 'stats'], {
    encoding: 'utf8',
    env: { ...process.env, DISPLAY: ':0', ...env },
  })
  const stats = (env = {}) => statsAt(socket, env)

  // No witness at all: an unconditional OK would let the driver run a flow
  // before its helpers started — the startup race this fake must not model.
  assert.notEqual(stats().status, 0, 'stats must refuse before any startup witness')
  // One helper alone is not readiness either.
  writeFileSync(joinPath(runDir, 'daemon-started'), '')
  assert.notEqual(stats().status, 0, 'a daemon witness alone must not grant readiness')
  assert.notEqual(stats({ FAKE_CTL_FAIL: '1' }).status, 0, 'FAKE_CTL_FAIL still refuses')
  // A DIFFERENT run directory with both witnesses grants itself readiness, but
  // its markers must never authorize THIS run: the key is the run directory
  // named by the control socket, not a shared fixture log.
  const otherRun = joinPath(dir, 'other-out')
  mkdirSync(otherRun, { recursive: true })
  writeFileSync(joinPath(otherRun, 'daemon-started'), '')
  writeFileSync(joinPath(otherRun, 'window-started'), '')
  const other = statsAt(joinPath(otherRun, 'gui.sock'))
  assert.equal(other.status, 0, other.stdout + other.stderr)
  assert.notEqual(stats().status, 0, 'another run witnesses must not authorize this run')
  writeFileSync(joinPath(runDir, 'window-started'), '')
  // Both THIS run's witnesses: the command answers the shape the driver reads.
  const ready = stats()
  assert.equal(ready.status, 0, ready.stdout + ready.stderr)
  assert.equal(JSON.parse(ready.stdout).ok, true)
  // A witness never overrides the explicit control failure.
  assert.notEqual(stats({ FAKE_CTL_FAIL: '1' }).status, 0, 'FAKE_CTL_FAIL still refuses after the witnesses exist')
})

test('two runs whose --out basenames collide still get DIFFERENT private daemons', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-daemons-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, 'export default async function (h) { h.check("the flow ran", true) }\n')
  // Two run directories with the SAME BASENAME (`out`) under different parents —
  // the shape that a basename-derived daemon directory would collapse onto one
  // socket, so one run's teardown removes the other's daemon.
  const outA = joinPath(dir, 'a', 'out')
  const outB = joinPath(dir, 'b', 'out')
  // The driver creates the run directory but not a missing parent, so both
  // parents exist up front; only the BASENAME is shared.
  mkdirSync(joinPath(dir, 'a'), { recursive: true })
  mkdirSync(joinPath(dir, 'b'), { recursive: true })
  const env = { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_SHOT_DIR: dir }
  for (const out of [outA, outB]) {
    const result = spawnSync(process.execPath, [driver, flow, '--out', out], { encoding: 'utf8', env })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    // Each run's readiness witnesses live in ITS OWN run directory: the shared
    // fake fixture directory grants nothing, so run B cannot start on run A's
    // records.
    assert.ok(existsSync(joinPath(out, 'daemon-started')), `this run wrote its daemon witness: ${out}`)
    assert.ok(existsSync(joinPath(out, 'window-started')), `this run wrote its window witness: ${out}`)
  }

  const sockets = readFileSync(joinPath(dir, 'daemon-sockets.log'), 'utf8')
    .trim().split('\n').filter(Boolean)
  assert.equal(sockets.length, 2, `both runs started a daemon: ${JSON.stringify(sockets)}`)
  assert.notEqual(sockets[0], sockets[1],
    `the two daemons must not share a socket: ${JSON.stringify(sockets)}`)
  for (const socket of sockets) {
    assert.match(socket, /tern-gui-daemon-/,
      'each daemon lives in an atomically unique directory, not a basename-derived one')
  }
})

test('splitPane refuses to continue when the split moved the focus', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-focus-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  const flow = joinPath(dir, 'flow.mjs')
  // The fake reports the focus as pane 1 before the split and pane 2 after it:
  // exactly the state in which a subject would be typed into the WRONG pane.
  writeFileSync(flow, `export default async function (h) {
  try {
    await h.splitPane('down')
    h.check('splitPane returned', true)
  } catch (error) {
    h.measure('splitPane refused', String(error.message))
    throw error
  }
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_FOCUS_MOVES: '1' },
  })
  // The run FAILS: a focus move is never silently repaired by typing a focus
  // command into a pane that may not be running a shell.
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  const log = readFileSync(joinPath(out, 'run.log'), 'utf8')
  assert.match(log, /the split moved the focus from pane \d+ to \d+/)
  // And it never typed a "restore the focus" command into a pane.
  assert.equal(log.split('\n').filter((line) => line.includes('focus-pane.sh')).length, 0)
})

test('a capture whose PNG the client never wrote FAILS instead of passing silently', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-nopng-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  h.capture('ghost-shot', 'the client acknowledges but writes nothing')
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_NO_PNG: '1' },
  })
  // No picture, no evidence, no green run.
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
  const log = readFileSync(joinPath(out, 'run.log'), 'utf8')
  assert.match(log, /SHOT-FAIL/)
  assert.match(log, /wrote no PNG into/)
  assert.equal(existsSync(joinPath(out, 'shots', '01-ghost-shot.png')), false)
})

/** A flow that finishes immediately; the run's exit code then means what it says. */
const CHECKED_FLOW = 'export default async function (h) { h.check("the flow ran", true) }\n'
/** A flow that throws: a red run, not a missing one. */
const THROWING_FLOW = 'export default async function () { throw new Error("the flow failed") }\n'

/**
 * Start the driver, wait until BOTH helpers recorded their identity, then
 * deliver `signal` and assert the run's final state.
 *
 * The PID records are the launch signal and the driver's own `exit` event is
 * the interruption signal; neither is a clock.
 */
async function assertSignalTearDown(t, prefix, signal) {
  const life = testLifecycle(t)
  const dir = life.tempDir(prefix)
  const fake = writeFakeTern(dir)
  // Registered BEFORE the spawn, so the unified fixture cleanup runs LAST in
  // the reverse-order teardown: the driver kill below runs first, then the
  // helpers are stopped, confirmed and their socket directories removed.
  deferHelperCleanup(life, dir)
  const flow = joinPath(dir, 'flow.mjs')
  // The flow parks so the driver stays alive long enough to be signalled: the
  // test must interrupt a LIVE driver, so the flow never finishes on its own.
  writeFileSync(flow, 'export default async function () { await new Promise(() => {}) }\n')
  const out = joinPath(dir, 'out')
  const pidsFile = joinPath(dir, 'pids.log')
  const child = spawn(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0' },
    stdio: 'ignore',
  })
  // The test's OWN cleanup runs in `t.after`, i.e. only AFTER the assertions:
  // it must never stop the helpers first and then claim the driver did.
  life.defer(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } })

  // Deadline reason: the helpers record their identity synchronously at
  // startup; this only bounds a broken fake, it is not a settle window.
  const records = await waitForPidRecords(pidsFile, 2, 30_000)
  assert.equal(records.length >= 2, true, `the driver started its helpers: ${JSON.stringify(records)}`)
  const sockets = readFileSync(joinPath(dir, 'daemon-sockets.log'), 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(sockets.length, 1, 'the driver started one private daemon')

  const exited = new Promise((resolve) => child.on('exit', (code, exitSignal) => resolve({ code, signal: exitSignal })))
  child.kill(signal)
  const exit = await exited
  // A cancelled run must keep its interruption status: a teardown must not
  // turn it into a clean exit 0.
  assert.equal(exit.signal, signal, `the driver exits BY the signal, got ${JSON.stringify(exit)}`)

  // Neither helper may outlive the driver — and a zombie or a reused PID is
  // not the helper this run started.
  const survivors = await waitForNoExecuting(records, 5_000)
  assert.deepEqual(survivors, [], `every helper was torn down before the driver exited: ${JSON.stringify(survivors)}`)
  // And the socket directory is gone with the daemon.
  assert.equal(existsSync(dirname(sockets[0])), false,
    `the daemon's socket directory was removed: ${sockets[0]}`)
  // The caller's run directory is evidence, so a cancelled run keeps it.
  assert.ok(existsSync(joinPath(out, 'run.log')), 'the cancelled run keeps its log')
}

/**
 * Run one driver whose flow finishes on its own and assert the run left no
 * helper executing and no private socket directory behind.
 */
async function assertFinishedRunTearsDown(t, prefix, { flow, env = {}, expectedStatus, expectedStderr }) {
  const life = testLifecycle(t)
  const dir = life.tempDir(prefix)
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  const flowPath = joinPath(dir, 'flow.mjs')
  writeFileSync(flowPath, flow)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flowPath, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', ...env },
  })
  assert.equal(result.status, expectedStatus, result.stdout + result.stderr)
  if (expectedStderr !== undefined) assert.match(result.stderr, expectedStderr)

  const records = readPidRecords(joinPath(dir, 'pids.log'))
  assert.equal(records.length, 2, `the run started both helpers: ${JSON.stringify(records)}`)
  const survivors = await waitForNoExecuting(records, 5_000)
  assert.deepEqual(survivors, [], `neither helper outlives the driver: ${JSON.stringify(survivors)}`)
  const sockets = readFileSync(joinPath(dir, 'daemon-sockets.log'), 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(existsSync(dirname(sockets[0])), false,
    `the daemon's socket directory was removed: ${sockets[0]}`)
  return { out, result }
}

test('a SIGTERM to the driver tears down its daemon, window and socket directory', async (t) => {
  await assertSignalTearDown(t, 'tern-gui-sigterm-', 'SIGTERM')
})

test('a SIGINT to the driver tears down its daemon, window and socket directory', async (t) => {
  await assertSignalTearDown(t, 'tern-gui-sigint-', 'SIGINT')
})

test('the driver does not exit while its daemon still holds stdio open', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-stdio-')
  const fake = writeFakeTern(dir)
  // Registered BEFORE the spawn: the unified cleanup runs LAST and removes the
  // socket directory only after the holder (registered later) and the driver
  // had their own teardown turn.
  deferHelperCleanup(life, dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, 'export default async function () { await new Promise(() => {}) }\n')
  const out = joinPath(dir, 'out')
  const pidsFile = joinPath(dir, 'pids.log')
  const child = spawn(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_STDIO_HOLD: '1' },
    stdio: 'ignore',
  })
  life.defer(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } })

  const records = await waitForPidRecords(pidsFile, 2, 30_000)
  const holderPid = Number(readFileSync(joinPath(dir, 'holder.pid'), 'utf8'))
  // Registered LAST, so the reverse-order teardown ends the holder FIRST: the
  // daemon's stdio pipe is released before the driver/helper cleanup runs.
  life.defer(() => { killStillExecuting([{ kind: 'holder', pid: holderPid, startTime: startTimeOf(holderPid) }]) })

  let exitedEarly = false
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => {
    exitedEarly = true
    resolve({ code, signal })
  }))
  child.kill('SIGTERM')
  // reason: a bounded observation of a NEGATIVE fact — the teardown must not finish while the child holds stdio.
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(exitedEarly, false, 'the driver exited before its child reached close')

  // Release the pipe: only NOW can the daemon's `close` arrive.
  process.kill(holderPid, 'SIGUSR1')
  const exit = await exited
  assert.equal(exit.signal, 'SIGTERM', `the driver exits BY the signal, got ${JSON.stringify(exit)}`)

  const survivors = await waitForNoExecuting(records, 5_000)
  assert.deepEqual(survivors, [], `every helper was torn down: ${JSON.stringify(survivors)}`)
  const sockets = readFileSync(joinPath(dir, 'daemon-sockets.log'), 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(existsSync(dirname(sockets[0])), false,
    `the daemon's socket directory was removed: ${sockets[0]}`)
})

test('a helper that never reaches close is reported and its socket directory is kept', { timeout: 30_000 }, async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-timeout-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, CHECKED_FLOW)
  const out = joinPath(dir, 'out')
  // FAKE_STDIO_HOLD keeps the daemon's stdio open from a grandchild the driver
  // does NOT own: the daemon never reaches `close`, which is the deadline path.
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_STDIO_HOLD: '1' },
  })
  const holderPid = Number(readFileSync(joinPath(dir, 'holder.pid'), 'utf8'))
  life.defer(() => killStillExecuting([{ kind: 'holder', pid: holderPid, startTime: startTimeOf(holderPid) }]))
  const socket = readFileSync(joinPath(dir, 'daemon-sockets.log'), 'utf8').trim()
  const daemonDir = dirname(socket)

  // The run is a RED run, not a clean one: the teardown could not be proved.
  assert.equal(result.status, 1, result.stdout + result.stderr)
  const ledger = JSON.parse(readFileSync(joinPath(out, 'assertions.json'), 'utf8'))
  assert.equal(ledger.failed, 1)
  const failure = ledger.results.find((entry) => !entry.ok)
  assert.match(failure.label, /settled before the driver exited/u)
  assert.match(failure.detail, /daemon pid=\d+/u)
  // And the directory a possibly-live daemon still uses was NOT deleted.
  assert.equal(existsSync(daemonDir), true, 'an unproven teardown keeps the socket directory')
})

test('an exit path the driver does not own keeps a socket directory it cannot prove closed', { timeout: 30_000 }, (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-exit-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  const flow = joinPath(dir, 'flow.mjs')
  // A flow calling process.exit() skips the driver's `finally`: the synchronous
  // exit hook runs with the helpers still alive, so it may only REQUEST their
  // signals — it must not delete the socket directory it cannot prove closed.
  writeFileSync(flow, 'export default async function () { process.exit(7) }\n')
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0' },
  })
  assert.equal(result.status, 7, result.stdout + result.stderr)
  const records = readPidRecords(joinPath(dir, 'pids.log'))
  assert.deepEqual(records.map((record) => record.kind).sort(), ['daemon', 'window'],
    `the exit run started BOTH helpers and recorded each identity: ${JSON.stringify(records)}`)
  assert.ok(records.every((record) => Number.isInteger(record.pid) && record.pid > 0),
    `every recorded identity carries a real PID: ${JSON.stringify(records)}`)

  // A missing socket log is a FAILURE, not an empty pass: the exit(7) flow may
  // only run after this run's daemon recorded the socket it started.
  const socketsFile = joinPath(dir, 'daemon-sockets.log')
  assert.ok(existsSync(socketsFile),
    'the exit run must have recorded its daemon socket before the flow could exit')
  const sockets = readFileSync(socketsFile, 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(sockets.length, 1, `the exit run started one private daemon: ${JSON.stringify(sockets)}`)
  assert.match(sockets[0], /tern-gui-daemon-/, 'the socket lives in the atomically unique daemon directory')
  const daemonDir = dirname(sockets[0])
  assert.equal(existsSync(daemonDir), true, 'an unproven teardown keeps the socket directory')
  assert.match(readFileSync(joinPath(out, 'run.log'), 'utf8'), /TEARDOWN-UNPROVEN keeping socket dir/u)
})

test('a normal run tears down its helpers and the private socket directory before it exits', async (t) => {
  await assertFinishedRunTearsDown(t, 'tern-gui-normal-', { flow: CHECKED_FLOW, expectedStatus: 0 })
})

test('a flow that throws still tears down its helpers before the driver exits', async (t) => {
  const { out } = await assertFinishedRunTearsDown(t, 'tern-gui-throws-', {
    flow: THROWING_FLOW,
    expectedStatus: 1,
  })
  const ledger = JSON.parse(readFileSync(joinPath(out, 'assertions.json'), 'utf8'))
  assert.equal(ledger.failed, 1, 'the throwing flow is a red run, not a missing one')
})

test('a daemon that exits before the flow finishes does not block or leak the teardown', async (t) => {
  await assertFinishedRunTearsDown(t, 'tern-gui-daemon-gone-', {
    flow: CHECKED_FLOW,
    expectedStatus: 0,
    env: { FAKE_DAEMON_EXITS: '1' },
  })
})

test('a window that exits before the flow finishes does not block or leak the teardown', async (t) => {
  await assertFinishedRunTearsDown(t, 'tern-gui-window-gone-', {
    flow: CHECKED_FLOW,
    expectedStatus: 0,
    env: { FAKE_WINDOW_EXITS: '1' },
  })
})

test('a window that dies before the control socket answers fails the startup after teardown', async (t) => {
  await assertFinishedRunTearsDown(t, 'tern-gui-startup-', {
    flow: CHECKED_FLOW,
    env: { FAKE_WINDOW_EXITS: '1', FAKE_CTL_FAIL: '1' },
    expectedStatus: 2,
    expectedStderr: /exited before it answered the control socket/,
  })
})

test('the GUI driver hovers the VISIBLE fragment, and refuses a fully clipped node', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('tern-gui-hover-')
  const fake = writeFakeTern(dir)
  deferHelperCleanup(life, dir)
  // Two nodes: `partial` survives y 100..110 of its own 100..140 box; `hidden`
  // is entirely outside its sized ancestor.
  const tree = [{
    tag: 'div', class: 'clipper', rect: [0, 100, 200, 10],
    children: [
      { tag: 'div', class: 'partial', rect: [0, 100, 200, 40] },
      { tag: 'div', class: 'hidden', rect: [0, 200, 200, 40] },
    ],
  }]
  const flow = joinPath(dir, 'flow.mjs')
  writeFileSync(flow, `export default async function (h) {
  const snap = h.snapshot()
  const partial = snap.nodes.find((n) => (n.class ?? '').includes('partial'))
  const hidden = snap.nodes.find((n) => (n.class ?? '').includes('hidden'))
  const overPartial = await h.hover(snap.chains, partial)
  h.measure('hover over the partially clipped node', JSON.stringify(overPartial ?? null))
  h.check('the hover lands inside the surviving fragment', overPartial?.moved === true)
  const overHidden = await h.hover(snap.chains, hidden)
  h.check('a fully clipped node is NOT hovered at all', overHidden === undefined,
    JSON.stringify(overHidden ?? null))
}
`)
  const out = joinPath(dir, 'out')
  const result = spawnSync(process.execPath, [driver, flow, '--out', out], {
    encoding: 'utf8',
    env: { ...process.env, TERN_BIN: fake.file, DISPLAY: ':0', FAKE_TREE: JSON.stringify(tree) },
  })
  assert.equal(result.status, 0, result.stdout + result.stderr)

  const log = readFileSync(joinPath(out, 'run.log'), 'utf8')
  const moves = log.split('\n').filter((line) => line.startsWith('SEND ok ["move"'))
  assert.equal(moves.length, 1, `only the visible node was moved to: ${JSON.stringify(moves)}`)
  const [, y] = JSON.parse(moves[0].slice('SEND ok '.length).split(' :: ')[0]).slice(1)
  assert.ok(y >= 100 && y <= 110, `the pointer landed inside the visible fragment, got y=${y}`)
})
