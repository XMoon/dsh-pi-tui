/**
 * Regression tests for the disposable temp-root runner: exit-code and
 * signal passthrough, TMPDIR containment, glob expansion (the child is
 * spawned without a shell), keep-mode, root removal, and the POSIX signal
 * teardown that must reach a TERM-ignoring descendant before it deletes the
 * root that descendant is using.
 * @module @xmoon76/dsh-pi-tui/run-with-temp-root.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  isExecuting, killStillExecuting, readPidRecords, startTimeOf, waitForNoExecuting,
} from '../support/pid-records.ts'
import { waitForFileLine } from '../support/wait-for-file.ts'
import { buildSpawnPlan } from '../../scripts/run-with-temp-root.mjs'

const RUNNER = fileURLToPath(new URL('../../scripts/run-with-temp-root.mjs', import.meta.url))
const HOLDER = fileURLToPath(new URL('../fixtures/signal-tree/holder.mjs', import.meta.url))
const LINGERING_HOLDER = fileURLToPath(new URL('../fixtures/signal-tree/lingering-holder.mjs', import.meta.url))
const EXIT_ZERO_HOLDER = fileURLToPath(new URL('../fixtures/signal-tree/exit-zero-on-signal.mjs', import.meta.url))
const POSIX_ONLY = process.platform === 'win32' ? 'signal forwarding to a process group is POSIX-only' : false

/** Whether `promise` settles within `deadlineMs`; the timer never outlives the wait. */
async function settlesWithin(promise, deadlineMs) {
  let timer
  const timedOut = new Promise((resolve) => { timer = setTimeout(() => resolve(false), deadlineMs) })
  const result = await Promise.race([promise.then(() => true), timedOut])
  clearTimeout(timer)
  return result
}

/**
 * The exact disposable TMPDIR this run's own startup marker names, or undefined
 * while the marker has no `tmpdir=` line. Only the wrapper's own root prefix is
 * accepted, so cleanup never removes an arbitrary path.
 */
function recordedTmpRoot(marker) {
  let content
  try { content = readFileSync(marker, 'utf8') } catch { return undefined }
  const line = content.split('\n').find((entry) => entry.includes(' tmpdir='))
  if (line === undefined) return undefined
  const root = line.slice(line.lastIndexOf(' tmpdir=') + ' tmpdir='.length).trim()
  if (root === '') return undefined
  if (!basename(root).startsWith('dsh-pi-tui-test-run-')) {
    throw new Error(`this run's recorded TMPDIR is not the wrapper's own root: ${root}`)
  }
  return root
}

/**
 * The descendant PID this run's own startup marker ANNOUNCED, if any. The
 * fixture writes the bare announcement immediately after spawning the
 * descendant and BEFORE the descendant publishes its own identity record.
 */
function announcedDescendant(marker) {
  if (!existsSync(marker)) return undefined
  const match = /^descendant (\d+)$/mu.exec(readFileSync(marker, 'utf8'))
  return match === null ? undefined : Number(match[1])
}

/**
 * Register the test's OWN teardown for one wrapper case BEFORE its first wait.
 *
 * A still-running wrapper first receives the NORMAL interruption, so only its
 * production signal path may settle the owned group and release the root. The
 * recorded close observer is attached at spawn; when it does not settle within
 * the bound, only the recorded DIRECT child may be SIGKILLed — the numeric PGID
 * is never signalled without the production module's ownership proof. The
 * descendants the fixture recorded in `pids.log` are then stopped by their own
 * identity and observed.
 *
 * An EMPTY record is not proof that nothing started: an announced descendant
 * whose self-record has not been published yet is awaited, and an unprovable
 * spawn window (`descendantFixture` with a non-empty marker but no descendant
 * announcement) fails loudly. The disposable TMPDIR is removed only when the
 * cleanup has no open problem and no recorded survivor.
 */
function deferWrapperCleanup(life, { child, closed, marker, descendantFixture = false }) {
  life.defer(async () => {
    const problems = []
    // reason: the bound covers the production group grace + settle (2 s + 2 s)
    // plus scheduling margin; the close observer itself is attached at spawn.
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    if (!await settlesWithin(closed, 10_000)) {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      problems.push(`the wrapper did not reach close before the test-owned cleanup deadline (pid=${child.pid ?? 'not-spawned'})`)
    }
    const pidsFile = join(dirname(marker), 'pids.log')
    const markerText = existsSync(marker) ? readFileSync(marker, 'utf8') : ''
    const announced = announcedDescendant(marker)
    let records = readPidRecords(pidsFile)
    if (announced !== undefined
      && !records.some((record) => record.kind === 'descendant' && record.pid === announced)) {
      // The fixture announced a descendant whose identity is not published yet:
      // wait for THAT record (the file content is the authority), then stop it.
      try {
        await waitForFileLine(pidsFile, new RegExp(`^descendant ${announced} \\S+$`, 'u'), 10_000)
      } catch (error) {
        problems.push(`the announced descendant ${announced} never published its identity: ${error.message}`)
      }
      records = readPidRecords(pidsFile)
    } else if (descendantFixture && announced === undefined && markerText !== '') {
      // The marker proves the fixture STARTED, but no descendant was announced:
      // the launcher may have been stopped inside the spawn -> announcement
      // window. A descendant that DID start publishes its own identity record;
      // wait for that (file content is the authority) and stop it. When no
      // identity ever arrives the state is unprovable and fails loudly — never
      // a guessed PID/PGID.
      try {
        await waitForFileLine(pidsFile, /^descendant \d+ \S+$/u, 10_000)
      } catch (error) {
        problems.push(`the fixture started but no descendant identity was published: ${error.message}`)
      }
      records = readPidRecords(pidsFile)
    }
    killStillExecuting(records)
    const survivors = await waitForNoExecuting(records, 5_000)
    if (survivors.length > 0) {
      problems.push(`the test-owned wrapper cleanup left recorded descendants executing: ${JSON.stringify(survivors)}`)
    }
    // The root WAS a live descendant's TMPDIR: remove it only once every recorded
    // identity is observed stopped, for this run's own path, and with no open
    // cleanup problem (a timed-out wrapper may still be using it).
    const root = recordedTmpRoot(marker)
    if (root !== undefined && survivors.length === 0 && problems.length === 0) {
      rmSync(root, { recursive: true, force: true })
    }
    if (problems.length > 0) throw new Error(problems.join('; '))
  })
}

function run(args, options = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', ...options })
}

test('the runner passes the child exit code through and removes its root', async (t) => {
  const life = testLifecycle(t)
  // The runner's TMPDIR is isolated for THIS case. A global count of
  // `dsh-pi-tui-test-run-*` roots would race with every other runner a
  // PARALLEL test file starts (the lane runner uses the same prefix), and the
  // assertion must name this run's own evidence, not shared global state.
  const isolatedTmp = life.tempDir('dsh-runner-exit-')
  const env = { ...process.env, TMPDIR: isolatedTmp, TMP: isolatedTmp, TEMP: isolatedTmp }
  const ok = run(['node', '-e', 'process.exit(0)'], { env })
  assert.equal(ok.status, 0)
  const failed = run(['node', '-e', 'process.exit(5)'], { env })
  assert.equal(failed.status, 5)
  assert.deepEqual(readdirSync(isolatedTmp), [], 'a normal run must not leave a runner root behind')
})

test('a child killed by a signal maps to 128+signo', () => {
  const result = run(['node', '-e', "process.kill(process.pid, 'SIGTERM')"])
  assert.equal(result.status, 143)
})

// Both interruption signals run the same contract: the wrapper forwards the
// signal it RECEIVED to the tree, and the root outlives the tree.
async function assertSignalReachesDescendant(t, signal) {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-runner-descendants-')
  const marker = join(dir, 'evidence.log')
  // The runner's DIRECT child is a holder that starts a descendant which
  // IGNORES the forwarded signals: only a whole-group SIGKILL can end it.
  const child = spawn(process.execPath, [RUNNER, process.execPath, HOLDER], {
    // The case proves the DELETE path; a developer's keep-mode toggle must not
    // turn its root-removal assertion into a different contract.
    env: { ...process.env, PROBE_MARKER: marker, DSH_TEST_KEEP_TMP: undefined },
    stdio: 'ignore',
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const closed = new Promise((resolve) => child.once('close', resolve))
  // The test's OWN cleanup runs in `t.after`, i.e. only AFTER its assertions;
  // it is registered before the readiness wait so an early failure still stops
  // what this run started. The holder fixture spawns a descendant, so an
  // ambiguous spawn window must fail rather than pass as "nothing started".
  deferWrapperCleanup(life, { child, closed, marker, descendantFixture: true })

  const ready = await waitForFileLine(marker, /ready tmpdir=/u, 20_000)
  const [, rawPid, , tmpdirField] = ready.split(' ')
  const descendant = { kind: 'descendant', pid: Number(rawPid), startTime: startTimeOf(Number(rawPid)) }
  const tmpRoot = tmpdirField.slice('tmpdir='.length)

  child.kill(signal)
  const result = await exited
  // The leader died BY the forwarded signal, and the runner reports it.
  const expectedExit = { SIGTERM: 143, SIGINT: 130 }[signal]
  assert.equal(result.code, expectedExit, `the runner reports the child's signal exit, got ${JSON.stringify(result)}`)

  const log = readFileSync(marker, 'utf8')
  // The signal reached the DESCENDANT, not only the leader ...
  assert.match(log, new RegExp(`descendant ${descendant.pid} ignored ${signal}`, 'u'),
    'the forwarded signal must reach the whole process group')
  // ... and the root was still the child's while that descendant was alive.
  assert.match(log, new RegExp(`descendant ${descendant.pid} tmpdir ok`, 'u'),
    'the temp root must not be removed while a descendant still uses it')

  const survivors = await waitForNoExecuting([descendant], 5_000)
  assert.deepEqual(survivors, [], `the SIGKILL escalation ended the descendant: ${JSON.stringify(survivors)}`)
  assert.equal(existsSync(tmpRoot), false, 'the temp root is removed once the group is provably gone')
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`a ${signal} reaches a TERM-ignoring descendant, and the root outlives it`, { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
    await assertSignalReachesDescendant(t, signal)
  })
}

// A child that handles the interruption itself and exits 0 must not turn the
// run into a success: the first received signal owns the wrapper's status.
for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`a child that handles ${signal} and exits 0 still yields the interruption status`, { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
    const life = testLifecycle(t)
    const dir = life.tempDir('dsh-runner-handled-')
    const marker = join(dir, 'evidence.log')
    const child = spawn(process.execPath, [RUNNER, process.execPath, EXIT_ZERO_HOLDER], {
      env: { ...process.env, PROBE_MARKER: marker, DSH_TEST_KEEP_TMP: undefined },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const exited = new Promise((resolve) => child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal })))
    const closed = new Promise((resolve) => child.once('close', resolve))
    deferWrapperCleanup(life, { child, closed, marker })

    const ready = await waitForFileLine(marker, /ready tmpdir=/u, 20_000)
    const [, , tmpdirField] = ready.split(' ')
    const tmpRoot = tmpdirField.slice('tmpdir='.length)

    child.kill(signal)
    const result = await exited
    assert.equal(result.code, { SIGTERM: 143, SIGINT: 130 }[signal],
      `the received signal owns the runner's status, got ${JSON.stringify(result)}`)
    // The child exited 0 and the group settled, so this is not a cleanup
    // failure: the root is removed.
    assert.doesNotMatch(stderr, /cleanup unproven/u)
    assert.equal(existsSync(tmpRoot), false, 'a settled group releases its root')
  })
}

test('a direct child that exits normally leaves the root to a live descendant', { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-runner-lingering-')
  const marker = join(dir, 'evidence.log')
  // The leader exits 0 ON ITS OWN while the descendant it started keeps
  // running: the leader's close is NOT the group's end.
  const child = spawn(process.execPath, [RUNNER, process.execPath, LINGERING_HOLDER], {
    env: { ...process.env, PROBE_MARKER: marker, DSH_TEST_KEEP_TMP: undefined },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const closed = new Promise((resolve) => child.once('close', resolve))
  // The lingering holder SPAWNS a descendant: an ambiguous spawn window fails
  // loudly instead of being reported as "nothing started".
  deferWrapperCleanup(life, { child, closed, marker, descendantFixture: true })

  const ready = await waitForFileLine(marker, /ready tmpdir=/u, 20_000)
  const [, rawPid, , tmpdirField] = ready.split(' ')
  const descendant = { kind: 'descendant', pid: Number(rawPid), startTime: startTimeOf(Number(rawPid)) }
  const tmpRoot = tmpdirField.slice('tmpdir='.length)

  const result = await exited
  // The child SUCCEEDED, but the wrapper cannot prove its group is gone: that
  // is a cleanup failure, not a pass. The child's status stays diagnostic.
  assert.equal(result.code, 1, `an unproven cleanup is a non-zero run, got ${JSON.stringify(result)}`)
  assert.match(stderr, /cleanup unproven: keeping .*still has live members after the direct child exited \(the direct child exited 0\)/u)
  // The root it left behind is NOT deleted while the descendant lives.
  assert.equal(existsSync(tmpRoot), true, 'the root outlives a normally-exiting leader while a descendant uses it')
  assert.equal(isExecuting(descendant), true, 'the descendant keeps running, untouched by the wrapper')
})

test('a command that does not exist reports the spawn failure and removes its root', async (t) => {
  const life = testLifecycle(t)
  const isolatedTmp = life.tempDir('dsh-runner-spawn-fail-')
  const result = run(['definitely-not-a-command-xyz'], {
    env: { ...process.env, TMPDIR: isolatedTmp, TMP: isolatedTmp, TEMP: isolatedTmp },
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /failed to spawn definitely-not-a-command-xyz/u)
  assert.deepEqual(readdirSync(isolatedTmp), [], 'a failed spawn must not leave its root behind')
})

test('the child sees TMPDIR/TMP/TEMP pointed at the disposable root', () => {
  const result = run(['node', '-e', "console.log(process.env.TMPDIR + '|' + process.env.TMP + '|' + process.env.TEMP)"])
  assert.equal(result.status, 0)
  const [tmpdirValue, tmpValue, tempValue] = result.stdout.trim().split('|')
  assert.match(tmpdirValue, /dsh-pi-tui-test-run-/u)
  assert.equal(tmpValue, tmpdirValue)
  assert.equal(tempValue, tmpdirValue)
})

test('glob arguments are expanded by the runner (no shell involved)', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-runner-glob-')
  writeFileSync(join(dir, 'a.test.ts'), '')
  writeFileSync(join(dir, 'b.test.ts'), '')
  writeFileSync(join(dir, 'notes.md'), '')
  const pattern = join(dir, '*.test.ts')
  const result = run(['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', pattern])
  assert.equal(result.status, 0)
  const received = JSON.parse(result.stdout.trim())
  assert.deepEqual(received, [join(dir, 'a.test.ts'), join(dir, 'b.test.ts')])
})

test('a glob with no matches passes through literally for the command to report', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-runner-nomatch-')
  const pattern = join(dir, '*.missing')
  const result = run(['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', pattern])
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout.trim()), [pattern])
})

test('DSH_TEST_KEEP_TMP=1 keeps and prints the run root', async (t) => {
  const life = testLifecycle(t)
  const result = run(['node', '-e', 'process.exit(0)'], { env: { ...process.env, DSH_TEST_KEEP_TMP: '1' } })
  assert.equal(result.status, 0)
  const match = result.stderr.match(/keeping (\S+) \(DSH_TEST_KEEP_TMP=1\)/u)
  assert.ok(match !== null, `keep mode must print the root, got: ${result.stderr}`)
  const kept = match[1]
  assert.ok(existsSync(kept), 'keep mode must retain the root')
  rmSync(kept, { recursive: true, force: true })
})


// ── Windows spawn-plan resolution (unit-tested from any host) ──────────────

const WIN = { platform: 'win32', comspec: 'C:\\Windows\\System32\\cmd.exe', pathEnv: 'C:\\tools;C:\\Windows\\System32', pathextEnv: '.COM;.EXE;.BAT;.CMD' }

test('buildSpawnPlan runs commands directly on POSIX', () => {
  const plan = buildSpawnPlan(['node', '--test', 'a.test.ts'])
  assert.deepEqual(plan, { command: 'node', args: ['--test', 'a.test.ts'], shell: false })
})

test('buildSpawnPlan delegates a resolved .cmd shim to cmd.exe with a cmd-safe quoted line', async (t) => {
  const life = testLifecycle(t)
  const tools = life.tempDir('dsh-runner-win-')
  // A path WITH SPACES: cmd /d /s /c strips the first and last quote of
  // the command line, so the line must carry an outer quote pair for the
  // inner per-argument quotes to survive.
  const spaced = join(tools, 'with space')
  mkdirSync(spaced)
  writeFileSync(join(spaced, 'pnpm.cmd'), '@echo off\r\n')
  const plan = buildSpawnPlan(['pnpm', '--dir', 'packages/pi-tui', 'test'], {
    ...WIN,
    pathEnv: `${spaced};C:\\Windows\\System32`,
  })
  assert.equal(plan.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(plan.shell, false)
  assert.equal(plan.args[0], '/d')
  assert.equal(plan.args[1], '/s')
  assert.equal(plan.args[2], '/c')
  const line = plan.args[3]
  assert.ok(line.startsWith('"') && line.endsWith('"'), `the line must carry an outer quote pair: ${line}`)
  assert.ok(line.includes(`"${join(spaced, 'pnpm.cmd')}"`), `the shim must be quoted: ${line}`)
  assert.ok(line.includes('"--dir"'), `args must be quoted: ${line}`)
  assert.ok(line.includes('"packages/pi-tui"'), `args must be quoted: ${line}`)
})

test('buildSpawnPlan quotes embedded double quotes with cmd doubling', async (t) => {
  const life = testLifecycle(t)
  const tools = life.tempDir('dsh-runner-winquote-')
  writeFileSync(join(tools, 'pnpm.cmd'), '@echo off\r\n')
  const plan = buildSpawnPlan(['pnpm', 'a"b'], { ...WIN, pathEnv: `${tools};C:\\Windows\\System32` })
  const line = plan.args[3]
  assert.ok(line.startsWith('"') && line.endsWith('"'), `the line must carry an outer quote pair: ${line}`)
  assert.ok(line.includes('"a""b"'), `embedded quotes must be doubled: ${line}`)
})

test('buildSpawnPlan runs a resolved real executable directly on Windows', async (t) => {
  const life = testLifecycle(t)
  const tools = life.tempDir('dsh-runner-winexe-')
  writeFileSync(join(tools, 'node.exe'), 'MZ')
  const plan = buildSpawnPlan(['node', '--version'], { ...WIN, pathEnv: `${tools};C:\\Windows\\System32` })
  assert.equal(plan.command, join(tools, 'node.exe'))
  assert.deepEqual(plan.args, ['--version'])
  assert.equal(plan.shell, false)
})

test('buildSpawnPlan passes an unresolvable command through on Windows', () => {
  const plan = buildSpawnPlan(['definitely-not-a-command', 'x'], { ...WIN, pathEnv: 'C:\\empty' })
  assert.deepEqual(plan, { command: 'definitely-not-a-command', args: ['x'], shell: false })
})

test('buildSpawnPlan honors an empty PATH entry as the current directory', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-runner-winpath-')
  writeFileSync(join(cwd, 'pnpm.cmd'), '@echo off\r\n')
  // PATH starts with an empty component (current directory on Windows).
  const plan = buildSpawnPlan(['pnpm', '--version'], { ...WIN, pathEnv: ';C:\\Windows\\System32', cwd })
  assert.equal(plan.command, 'C:\\Windows\\System32\\cmd.exe')
  const line = plan.args[3]
  assert.ok(line.includes(`"${join(cwd, 'pnpm.cmd')}"`), `the cwd shim must be resolved: ${line}`)
})
