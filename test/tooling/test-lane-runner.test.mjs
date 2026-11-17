/**
 * The lane runner must launch a discovered test set of arbitrary size with
 * bounded argv while keeping Node-native shard, concurrency, reporter, cwd,
 * and process-tree signal/cleanup contracts.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/test-lane-runner.test
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { parseConcurrency, sanitizeTestEnvironment } from '../../scripts/run-test-lane.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  isExecuting, killStillExecuting, readPidRecords, startTimeOf, waitForNoExecuting,
} from '../support/pid-records.ts'
import { waitForFileLine } from '../support/wait-for-file.ts'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const SIGNAL_TREE_DESCENDANT = join(ROOT, 'test', 'fixtures', 'signal-tree', 'descendant.mjs')
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
 * Register the test's OWN teardown for one lane-wrapper case BEFORE its first
 * wait.
 *
 * A still-running wrapper first receives the NORMAL interruption, so only its
 * production signal path may settle the worker tree and release the root. The
 * recorded close observer is attached at spawn; when it does not settle within
 * the bound, only the recorded DIRECT child may be SIGKILLed — the numeric
 * PGID is never signalled without the production module's ownership proof. The
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

/** Copy the production lane sources into a test-owned fixture repository. */
function copyLaneRunnerSources(scripts) {
  mkdirSync(join(scripts, 'lib'), { recursive: true })
  for (const name of ['run-test-lane.mjs', 'test-discovery.mjs', 'test-case-reporter.mjs']) {
    writeFileSync(join(scripts, name), readFileSync(join(ROOT, 'scripts', name)))
  }
  writeFileSync(join(scripts, 'lib', 'owned-process-group.mjs'),
    readFileSync(join(ROOT, 'scripts', 'lib', 'owned-process-group.mjs')))
  // The runner imports the shared kernel-identity seam for process-group
  // teardown, so a fixture repository must carry those modules too — otherwise
  // the fixture runner dies at import and no readiness line ever appears.
  const fixtureRoot = join(scripts, '..')
  const nativeProcess = join(fixtureRoot, 'src', 'runtime', 'native-process')
  mkdirSync(nativeProcess, { recursive: true })
  for (const name of ['identity.ts', 'darwin.ts']) {
    writeFileSync(join(nativeProcess, name), readFileSync(join(ROOT, 'src', 'runtime', 'native-process', name)))
  }
  // The identity seam imports node-koffi LAZILY; the sanitized lane child has
  // no NODE_PATH, so the copied repository must resolve the REAL devDependency
  // itself (a koffi resolved from an ambient global path could be another
  // version entirely). The symlink keeps the fixture hermetic.
  mkdirSync(join(fixtureRoot, 'node_modules'), { recursive: true })
  symlinkSync(join(ROOT, 'node_modules', 'koffi'), join(fixtureRoot, 'node_modules', 'koffi'), 'dir')
}

const WINDOWS_COMMAND_LINE_LIMIT = 32_767

test('the real lane starts above the Windows argv budget with complete shard and reporter evidence', (t) => {
  const fixture = testLifecycle(t).tempDir('dsh-lane-argv-')
  const scripts = join(fixture, 'scripts')
  copyLaneRunnerSources(scripts)
  writeFileSync(join(scripts, 'test-lanes.mjs'), `export const LANES = {
  probe: { description: 'long argv probe', patterns: ['probe/**'], suffixes: ['.test.mjs'] },
}\n`)
  const probe = join(fixture, 'test', 'probe')
  mkdirSync(probe, { recursive: true })
  const filenames = []
  for (let index = 0; index < 400; index += 1) {
    const filename = `${String(index).padStart(3, '0')}-${'x'.repeat(80)}.test.mjs`
    filenames.push(filename)
    writeFileSync(join(probe, filename), `import test from 'node:test'
test('probe ${index}', () => {
  if (process.cwd() !== process.env.PROBE_ROOT) throw new Error('wrong test cwd')
  if (process.env.DSH_TEST_JSONL !== undefined) throw new Error('reporter destination leaked to a worker')
})
`)
  }
  const hypotheticalOldArgv = filenames.map(name => win32.join('test', 'probe', name)).join(' ').length
  assert.ok(hypotheticalOldArgv > WINDOWS_COMMAND_LINE_LIMIT,
    `the fixture must exceed the old Windows argv limit: ${hypotheticalOldArgv}`)

  const diagnostics = join(fixture, 'diagnostics')
  mkdirSync(diagnostics, { recursive: true })
  const casesPath = join(diagnostics, 'cases.jsonl')
  const effectivePath = join(diagnostics, 'effective-params.json')
  const result = spawnSync(process.execPath, [
    join(scripts, 'run-test-lane.mjs'), 'probe', '--shard=1/128', '--test-concurrency=2',
  ], {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, DSH_TEST_JSONL: casesPath,
      DSH_TEST_EFFECTIVE_JSON: effectivePath, PROBE_ROOT: fixture },
  })
  assert.equal(result.status, 0, result.stderr ?? result.error?.message)
  const applied = JSON.parse(readFileSync(effectivePath, 'utf8'))
  assert.equal(applied.laneFileCount, 400)
  assert.equal(applied.shard, '1/128')
  assert.equal(applied.testConcurrency, 2)
  assert.ok(applied.argvPrefix.join(' ').length < WINDOWS_COMMAND_LINE_LIMIT,
    'the child invocation must not grow with the discovered file set')

  const records = readFileSync(casesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.equal(records.filter(record => record.name === record.file).length, 4,
    'Node native shard 1/128 must run four of 400 files')
  assert.equal(records.filter(record => record.name.startsWith('probe ')).length, 4,
    'the reporter must record the four real test cases')
  assert.ok(records.every(record => record.result === 'pass'))

  // A failing worker must still fail the outer lane; the programmatic API
  // does not set process.exitCode for us. Exercise the reporter-free path too.
  writeFileSync(join(probe, filenames[0]), `import test from 'node:test'
test('failure propagation', () => { throw new Error('expected failure') })
`)
  const failed = spawnSync(process.execPath, [
    join(scripts, 'run-test-lane.mjs'), 'probe', '--shard=1/128', '--test-concurrency=2',
  ], {
    cwd: fixture,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined,
      DSH_TEST_JSONL: undefined, DSH_TEST_EFFECTIVE_JSON: undefined },
  })
  assert.equal(failed.status, 1, failed.stderr ?? failed.error?.message)
  assert.match(failed.stdout, /failure propagation/u)
})

// ---------------------------------------------------------------------------
// The CONCURRENCY argument.
//
// The regression this protects: the runner used to take `--test-concurrency`
// from the command line, IGNORE it, and run the lane at Node's default
// anyway. Nothing failed — the lane was green, the report was complete, and
// only the TIMING was wrong. A concurrency measurement that silently ran at
// the default level is worse than no measurement: it produces five
// identical samples and calls them a comparison.
//
// So these cases assert the runner's ARGUMENT PARSING directly, and the
// forwarding is proved by the BEHAVIOUR: Node's own concurrency is visible
// in the child process tree.
// ---------------------------------------------------------------------------

test('the concurrency argument is parsed into a Node flag', () => {
  assert.equal(parseConcurrency(['--test-concurrency=1']), '--test-concurrency=1')
  assert.equal(parseConcurrency(['--test-concurrency=8']), '--test-concurrency=8')
})

test('the DEFAULT concurrency is expressed by NOT passing a flag', () => {
  // Node's default is `os.availableParallelism()`. A runner that spelled the
  // default as a NUMBER would freeze the measurement to one machine's CPU
  // count, which is exactly the assumption the measurement must not make.
  assert.equal(parseConcurrency([]), undefined)
  assert.equal(parseConcurrency(['--test-concurrency=default']), undefined)
})

test('a malformed concurrency is a FAILURE, not a silent default', () => {
  // A silently ignored concurrency would make the measurement meaningless,
  // so an unreadable one must stop the run.
  assert.throws(() => parseConcurrency(['--test-concurrency=zero']), /whole number/u)
  assert.throws(() => parseConcurrency(['--test-concurrency=0']), /at least 1/u)
  assert.throws(() => parseConcurrency(['--test-concurrency=-1']), /whole number/u)
})

test('the lane child never inherits the developer terminal identity or ambient module paths', () => {
  const sanitized = sanitizeTestEnvironment({
    PATH: '/bin',
    HOME: '/home/dev',
    NODE_PATH: '/home/dev/.local/share/mise/installs/npm-deepseek-ai-dsh/0.2.1-rc.5/node_modules/.mise/node_modules',
    TERM_PROGRAM: 'tern',
    TERM_PROGRAM_VERSION: '0.9.5',
    KITTY_WINDOW_ID: '3',
    KITTY_PID: '556',
    ZELLIJ: '0',
    ZELLIJ_PANE_ID: '0',
    ZELLIJ_SESSION_NAME: 'main',
    _ZL_MATCH_MODE: '1',
    TMUX: '/tmp/tmux,1,0',
    TMUX_PANE: '%1',
    STY: '123.pts-0.host',
    TERN_ACP: '',
    TERN_BLOB_DIR: '/home/dev/.cache/tern/blobs',
    TERN_COMPLETE: '1',
    TERN_IDENTITY: '{}',
    TERN_LENSES: '1',
    TERN_PANE: '1',
    TERN_PANE_SOCKET: '/run/tern.sock',
    TERN_WINDOW_SOCKET: '/run/window.sock',
    PI_IMAGE_PROTOCOL: 'kitty',
    PI_TUI_TMUX_KITTY_IMAGES: '1',
    PI_TUI_TMUX_KITTY_PLACEHOLDERS: '1',
  })
  assert.deepEqual(sanitized, { PATH: '/bin', HOME: '/home/dev' },
    'only the developer terminal identity and ambient module paths are removed; ordinary environment stays')
  assert.deepEqual(sanitizeTestEnvironment({ PATH: '/bin' }), { PATH: '/bin' })
})

test('the lane runner actually applies concurrency to real test workers', (t) => {
  // The 400ms window is the measured concurrency contract: four workers
  // require roughly 1.6s serially and can overlap at concurrency 4.
  const fixture = testLifecycle(t).tempDir('dsh-lane-concurrency-')
  const scripts = join(fixture, 'scripts')
  copyLaneRunnerSources(scripts)
  writeFileSync(join(scripts, 'test-lanes.mjs'), `export const LANES = {
  probe: { description: 'concurrency probe', patterns: ['probe/**'], suffixes: ['.test.mjs'] },
}\n`)
  const probe = join(fixture, 'test', 'probe')
  mkdirSync(probe, { recursive: true })
  for (let index = 0; index < 4; index += 1) {
    writeFileSync(join(probe, `hold-${index}.test.mjs`),
      `import test from 'node:test'
// reason: the 400ms hold is the measured concurrency window, not a settlement delay.
test('hold ${index}', async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
`)
  }
  const timeAt = (level) => {
    const start = Date.now()
    const result = spawnSync(process.execPath, [
      join(scripts, 'run-test-lane.mjs'), 'probe', `--test-concurrency=${level}`,
    ], {
      cwd: fixture,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined,
        DSH_TEST_JSONL: undefined, DSH_TEST_EFFECTIVE_JSON: undefined },
    })
    assert.equal(result.status, 0, result.stderr ?? result.error?.message)
    assert.match(result.stdout, /hold 3/u, 'the fourth test must run')
    return Date.now() - start
  }
  const serial = timeAt(1)
  const parallel = timeAt(4)
  assert.ok(serial >= 1_400, `the serial run must hold all four files: ${serial}ms`)
  assert.ok(parallel < serial - 600,
    `the parallel run must overlap test workers: ${parallel}ms vs ${serial}ms`)
})

// ---------------------------------------------------------------------------
// The SIGNAL contract.
//
// The regression this protects: the runner forwarded a signal to the `node
// --test` LEADER only. A worker and its own descendants kept running, and the
// disposable temp root — their TMPDIR — was removed at the leader's close.
// ---------------------------------------------------------------------------

async function assertSignalReachesWorkerTree(t, signal) {
  const life = testLifecycle(t)
  const fixture = life.tempDir('dsh-lane-group-')
  const marker = join(fixture, 'evidence.log')
  // The lane runner resolves its lanes and its test root from its OWN location,
  // so a fixture REPOSITORY is the way to give it a lane that runs one known
  // file. The runner and the discovery rule are the PRODUCTION files, read at
  // run time — a change to their signal handling changes what this case
  // exercises. The probe itself runs in a real `node --test` WORKER and starts
  // a descendant that ignores every forwarded signal.
  const scripts = join(fixture, 'scripts')
  copyLaneRunnerSources(scripts)
  writeFileSync(join(scripts, 'test-lanes.mjs'), `export const LANES = {
  probe: { description: 'the wrapper signal probe', patterns: ['probe/**'], suffixes: ['.test.mjs'] },
}
`)
  const probeDir = join(fixture, 'test', 'probe')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(join(probeDir, 'descendants.test.mjs'), `import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import test from 'node:test'

test('holds a signal-ignoring descendant', async () => {
  const marker = process.env.PROBE_MARKER
  appendFileSync(marker, \`worker \${process.pid}\\n\`)
  const descendant = spawn(process.execPath, [process.env.PROBE_DESCENDANT], { stdio: 'ignore', env: process.env })
  // The worker must be able to FINISH: an referenced child handle would keep
  // its event loop alive until the descendant ends.
  descendant.unref()
  appendFileSync(marker, \`descendant \${descendant.pid}\\n\`)
  await new Promise(() => {})
})
`)
  const child = spawn(process.execPath, [join(scripts, 'run-test-lane.mjs'), 'probe'], {
    env: {
      ...process.env,
      PROBE_MARKER: marker,
      PROBE_DESCENDANT: SIGNAL_TREE_DESCENDANT,
      // The OUTER run's lane context must not leak into the fixture lane: the
      // reporter/effective-json paths belong to the real repository, and an
      // inherited test-run context would stop the probe's `node --test` from
      // executing anything at all.
      DSH_TEST_JSONL: undefined,
      DSH_TEST_EFFECTIVE_JSON: undefined,
      DSH_TEST_KEEP_TMP: undefined,
      NODE_TEST_CONTEXT: undefined,
    },
    stdio: 'ignore',
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const closed = new Promise((resolve) => child.once('close', resolve))
  // The test's OWN cleanup runs in `t.after`, i.e. only AFTER its assertions;
  // it is registered before the readiness wait so an early failure still stops
  // what this lane started. The probe worker spawns a descendant, so an
  // ambiguous spawn window must fail rather than pass as "nothing started".
  deferWrapperCleanup(life, { child, closed, marker, descendantFixture: true })

  const ready = await waitForFileLine(marker, /ready tmpdir=/u, 20_000)
  const [, rawPid, , tmpdirField] = ready.split(' ')
  const descendant = { kind: 'descendant', pid: Number(rawPid), startTime: startTimeOf(Number(rawPid)) }
  const tmpRoot = tmpdirField.slice('tmpdir='.length)

  child.kill(signal)
  const result = await exited
  // An interrupted lane must not report the child's own status: the wrapper
  // reports the signal it received.
  assert.equal(result.code, { SIGTERM: 143, SIGINT: 130 }[signal],
    `the received signal owns the runner's status, got ${JSON.stringify(result)}`)

  const log = readFileSync(marker, 'utf8')
  // The signal reached the DESCENDANT of the worker, not only the leader ...
  assert.match(log, new RegExp(`descendant ${descendant.pid} ignored ${signal}`, 'u'),
    'the forwarded signal must reach the node --test worker tree, not only the leader')
  // ... and the temp root was still the child's while that descendant lived.
  assert.match(log, new RegExp(`descendant ${descendant.pid} tmpdir ok`, 'u'),
    'the temp root must outlive the leader while a descendant still uses it')

  const survivors = await waitForNoExecuting([descendant], 5_000)
  assert.deepEqual(survivors, [], `the SIGKILL escalation ended the descendant: ${JSON.stringify(survivors)}`)
  assert.equal(existsSync(tmpRoot), false, 'the temp root is removed once the group is provably gone')
}

// Both interruption signals run the same contract: the receiver forwards the
// signal it got to the whole tree it owns.
for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`a ${signal} to the lane runner reaches the worker tree, not only the leader`, { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
    await assertSignalReachesWorkerTree(t, signal)
  })
}

test('a lane whose leader handles SIGTERM and exits 0 still yields the interruption status', { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
  const life = testLifecycle(t)
  const fixture = life.tempDir('dsh-lane-handled-')
  const marker = join(fixture, 'evidence.log')
  const scripts = join(fixture, 'scripts')
  copyLaneRunnerSources(scripts)
  writeFileSync(join(scripts, 'test-lanes.mjs'), `export const LANES = {
  probe: { description: 'the wrapper handled-signal probe', patterns: ['probe/**'], suffixes: ['.test.mjs'] },
}
`)
  const probeDir = join(fixture, 'test', 'probe')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(join(probeDir, 'alive.test.mjs'), `import { appendFileSync } from 'node:fs'
import test from 'node:test'

test('stays alive until the interruption', async () => {
  appendFileSync(process.env.PROBE_MARKER, 'worker ' + process.pid + ' ready tmpdir=' + process.env.TMPDIR + '\\n')
  await new Promise(() => {})
})
`)
  // NODE_OPTIONS loads this hook in every Node process. Only the real lane
  // child is the wrapper's direct child (it carries --lane-child in argv).
  writeFileSync(join(fixture, 'signal-hook.cjs'), 'if (process.argv[2] === "--lane-child") {\n'
    + '  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => process.exit(0))\n'
    + '}\n')
  const child = spawn(process.execPath, [join(scripts, 'run-test-lane.mjs'), 'probe'], {
    env: {
      ...process.env,
      PROBE_MARKER: marker,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require=${join(fixture, 'signal-hook.cjs')}`.trim(),
      DSH_TEST_JSONL: undefined,
      DSH_TEST_EFFECTIVE_JSON: undefined,
      DSH_TEST_KEEP_TMP: undefined,
      NODE_TEST_CONTEXT: undefined,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const closed = new Promise((resolve) => child.once('close', resolve))
  deferWrapperCleanup(life, { child, closed, marker })

  const ready = await waitForFileLine(marker, /ready tmpdir=/u, 20_000)
  const [, , tmpdirField] = ready.split(' ')
  const tmpRoot = tmpdirField.slice('tmpdir='.length)

  child.kill('SIGTERM')
  const result = await exited
  // The leader exited 0, but the wrapper was interrupted: the signal owns the
  // status, and the settled group releases its root.
  assert.equal(result.code, 143, `the received signal owns the runner's status, got ${JSON.stringify(result)}`)
  assert.doesNotMatch(stderr, /cleanup unproven/u)
  assert.equal(existsSync(tmpRoot), false, 'a settled group releases its root')
})

test('a lane whose worker leaves a running descendant keeps its temp root', { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
  const life = testLifecycle(t)
  const fixture = life.tempDir('dsh-lane-lingering-')
  const marker = join(fixture, 'evidence.log')
  // A fixture repository whose probe test starts a descendant and RETURNS:
  // `node --test` finishes normally while the descendant keeps the group alive.
  const scripts = join(fixture, 'scripts')
  copyLaneRunnerSources(scripts)
  writeFileSync(join(scripts, 'test-lanes.mjs'), `export const LANES = {
  probe: { description: 'the wrapper lingering probe', patterns: ['probe/**'], suffixes: ['.test.mjs'] },
}
`)
  const probeDir = join(fixture, 'test', 'probe')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(join(probeDir, 'lingering.test.mjs'), `import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import test from 'node:test'

test('starts a descendant that outlives the worker', () => {
  const marker = process.env.PROBE_MARKER
  // The PRE-SPAWN witness is what makes "empty marker means no spawn" sound: a
  // cleanup that runs after an early worker death can distinguish "never
  // reached the spawn" from "spawned but has not announced itself yet".
  appendFileSync(marker, 'worker ' + process.pid + '\\n')
  const descendant = spawn(process.execPath, [process.env.PROBE_DESCENDANT], { stdio: 'ignore', env: process.env })
  // The worker must be able to FINISH: an referenced child handle would keep
  // its event loop alive until the descendant ends.
  descendant.unref()
  appendFileSync(marker, \`descendant \${descendant.pid}\\n\`)
})
`)
  const child = spawn(process.execPath, [join(scripts, 'run-test-lane.mjs'), 'probe'], {
    env: {
      ...process.env,
      PROBE_MARKER: marker,
      PROBE_DESCENDANT: SIGNAL_TREE_DESCENDANT,
      DSH_TEST_JSONL: undefined,
      DSH_TEST_EFFECTIVE_JSON: undefined,
      DSH_TEST_KEEP_TMP: undefined,
      NODE_TEST_CONTEXT: undefined,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const closed = new Promise((resolve) => child.once('close', resolve))
  // The worker leaves a running descendant: an ambiguous spawn window fails
  // loudly instead of being reported as "nothing started".
  deferWrapperCleanup(life, { child, closed, marker, descendantFixture: true })

  const ready = await waitForFileLine(marker, /ready tmpdir=/u, 20_000)
  const [, rawPid, , tmpdirField] = ready.split(' ')
  const descendant = { kind: 'descendant', pid: Number(rawPid), startTime: startTimeOf(Number(rawPid)) }
  const tmpRoot = tmpdirField.slice('tmpdir='.length)

  const result = await exited
  // The lane's tests passed, but its owned group is still alive: an unproven
  // cleanup is a non-zero run, not a pass. The child's status stays diagnostic.
  assert.equal(result.code, 1, `an unproven cleanup is a non-zero run, got ${JSON.stringify(result)}`)
  assert.match(stderr, /cleanup unproven: keeping .*still has live members after the direct child exited \(the direct child exited 0\)/u)
  assert.equal(existsSync(tmpRoot), true, 'the lane root outlives a worker descendant')
  assert.equal(isExecuting(descendant), true, 'the descendant keeps running, untouched by the runner')
})
