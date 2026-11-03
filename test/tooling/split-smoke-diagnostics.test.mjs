/**
 * Split-smoke input qualification and failure diagnostics guard (T and U lanes).
 *
 * The two real lanes (`scripts/split-process-smoke.mjs` and
 * `scripts/split-process-upgrade-smoke.mjs`) install packaged artifacts into an
 * isolated profile and drive real Host/Client processes. Before any of that
 * happens they must reject an artifact whose own manifest declares a different
 * exact DSH runtime than the one this checkout pins: the production Client
 * reexec preflight refuses such a target, so a mismatched pairing would surface
 * as a product-looking timeout instead of an invalid test input.
 *
 * The synthetic tarballs here contain ONLY `package/package.json`. They exist to
 * prove the preflight fires before any work root, install or process exists —
 * they are never a qualification run and never replace the real PTY/process lane.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/split-smoke-diagnostics.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { npmDshVersion } from '../../scripts/lib/dsh-distribution.mjs'
import {
  classifyHandoffRejection,
  classifyReloadNoticeLine,
  classifyReloadNotices,
  createSmokeDiagnostics,
  projectFailureReport,
  requireExactSmokeDshPin,
  smokeArtifactIdentity,
  SplitSmokeInputError,
  SplitSmokeWaitError,
} from '../../scripts/lib/split-smoke-diagnostics.mjs'
import { waitForAcceptedHandoff, waitForReloadNotice } from '../../scripts/split-process-upgrade-smoke.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UPGRADE_SCRIPT = join(ROOT, 'scripts', 'split-process-upgrade-smoke.mjs')
const PROCESS_SCRIPT = join(ROOT, 'scripts', 'split-process-smoke.mjs')
const PACKAGE_NAME = '@xmoon76/dsh-pi-tui'
const DSH_AGENT = '@deepseek-ai/dsh-agent'
const TARGET_PIN = npmDshVersion()
/** Another published runtime: a real exact pin that is deliberately not the target. */
const OTHER_PIN = '0.2.1-rc.4'

function manifestOf(version, pin) {
  const manifest = { name: PACKAGE_NAME, version, devDependencies: {} }
  if (pin !== undefined) manifest.devDependencies[DSH_AGENT] = pin
  return manifest
}

/**
 * One fake packaged artifact holding ONLY the manifest the preflight reads. The
 * archive layout matches npm (`package/package.json`) so the lanes read it
 * through their real `tar` path.
 */
function syntheticTarball(root, name, manifest) {
  const stage = join(root, `${name}-stage`)
  mkdirSync(join(stage, 'package'), { recursive: true })
  writeFileSync(join(stage, 'package', 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const path = join(root, `${name}.tgz`)
  const packed = spawnSync('tar', ['-czf', path, '-C', stage, 'package'], { encoding: 'utf8' })
  assert.equal(packed.status, 0, `the synthetic fixture could not be packed: ${packed.stderr}`)
  return path
}

/** Run one real lane CLI with a private temp root, inside a hard time budget. */
function runLane(script, args, tmpRoot) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, TMPDIR: tmpRoot },
  })
  return { elapsedMs: Date.now() - started, ...result }
}

/**
 * A rejected input must never reach the lane's own setup: assert the private
 * temp root still holds no work root and no install transaction.
 */
function assertNoLaneSetup(tmpRoot, workPrefix) {
  const entries = readdirSync(tmpRoot, { withFileTypes: true })
  const workRoots = entries.filter(entry => entry.name.startsWith(workPrefix)).map(entry => entry.name)
  assert.deepEqual(workRoots, [], `no ${workPrefix}* work root may exist for a rejected input`)
  const installs = entries.filter(entry => entry.name === 'node_modules' || entry.name === 'pnpm-lock.yaml')
  assert.deepEqual(installs.map(entry => entry.name), [], 'a rejected input may not start an install transaction')
}

test('the exact-pin guard accepts only the lane target pin for every role', () => {
  for (const role of ['candidate', 'old', 'new']) {
    assert.equal(requireExactSmokeDshPin(role, manifestOf('1.2.3', TARGET_PIN), TARGET_PIN), TARGET_PIN)
  }
  // No range and no "compatible enough" reading: a caret/tilde/range form (or a
  // non-string) is not an exact pin, whatever the runtime would resolve.
  for (const pin of ['^0.2.1-rc.5', '>=0.2.1-rc.2', '', '   ', null, undefined, 42]) {
    assert.throws(
      () => requireExactSmokeDshPin('old', manifestOf('1.2.3', pin), TARGET_PIN),
      error => error.code === 'INPUT_DSH_PIN_MISSING_OR_INVALID' && error.role === 'old',
    )
  }
  // A well-formed pin of ANOTHER runtime is a mismatch, never a missing pin: the
  // two classifications stay distinct so the report can name the real reason.
  assert.throws(
    () => requireExactSmokeDshPin('old', manifestOf('1.2.3', '0.2.1'), TARGET_PIN),
    error => error.code === 'INPUT_DSH_PIN_MISMATCH' && error.artifactPin === '0.2.1',
  )
  assert.throws(() => requireExactSmokeDshPin('ancient', manifestOf('1.2.3', TARGET_PIN), TARGET_PIN), TypeError)
  assert.throws(() => requireExactSmokeDshPin('old', manifestOf('1.2.3', TARGET_PIN), '>=0.2.1'), TypeError)
})

test('a differently pinned artifact is an INPUT_UNQUALIFIED mismatch, never a product claim', () => {
  for (const role of ['candidate', 'old', 'new']) {
    let caught
    try {
      requireExactSmokeDshPin(role, manifestOf('1.2.3', OTHER_PIN), TARGET_PIN)
    } catch (error) {
      caught = error
    }
    assert.ok(caught instanceof SplitSmokeInputError, 'the mismatch must be the dedicated input error')
    assert.equal(caught.code, 'INPUT_DSH_PIN_MISMATCH')
    assert.equal(caught.role, role)
    assert.equal(caught.artifactPin, OTHER_PIN)
    assert.equal(caught.targetDshVersion, TARGET_PIN)
    assert.match(caught.message, /INPUT_UNQUALIFIED/u)
    assert.match(caught.message, /INVALID_TEST_PAIRING/u)
    assert.match(caught.message, /not a product regression/u)
    assert.ok(caught.message.includes(OTHER_PIN) && caught.message.includes(TARGET_PIN),
      'the message must state both exact versions so the operator can rebuild the right artifact')
  }
})

test('the guard never echoes an arbitrary manifest value', () => {
  const sentinel = 'COOKIE_SENTINEL https://secret.invalid/x ./evil-target.sh'
  for (const pin of [sentinel, `${sentinel}\n`, 42]) {
    const thrown = (() => {
      try {
        requireExactSmokeDshPin('old', manifestOf('1.2.3', pin), TARGET_PIN)
      } catch (error) {
        return error
      }
      assert.fail(`an invalid pin must be refused: ${String(pin)}`)
    })()
    assert.equal(thrown.code, 'INPUT_DSH_PIN_MISSING_OR_INVALID')
    assert.doesNotMatch(thrown.message, /COOKIE_SENTINEL|secret\.invalid|evil-target/u)
  }
})

test('the upgrade lane refuses a mismatched OLD artifact before any install', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-upgrade-input-guard-')
  const oldPath = syntheticTarball(dir, 'old', manifestOf('0.5.5-old.1', OTHER_PIN))
  const newPath = syntheticTarball(dir, 'new', manifestOf('0.5.5', TARGET_PIN))
  const result = runLane(UPGRADE_SCRIPT, ['--old', oldPath, '--new', newPath], dir)
  assert.notEqual(result.status, 0, 'a mismatched pairing must exit nonzero')
  assert.equal(result.signal, null, 'the lane must fail by itself inside the budget, not be killed by it')
  assert.match(result.stderr, /INPUT_UNQUALIFIED/u)
  assert.match(result.stderr, /INPUT_DSH_PIN_MISMATCH/u)
  assert.match(result.stderr, /\bold\b/u)
  assert.ok(result.stderr.includes(OTHER_PIN) && result.stderr.includes(TARGET_PIN),
    `both exact versions must be reported:\n${result.stderr}`)
  assert.ok(!result.stderr.includes('qualified=true'),
    `an unqualified pairing must never announce itself as qualified:\n${result.stderr}`)
  assertNoLaneSetup(dir, 'dsh-split-upgrade-')
})

test('the upgrade lane refuses a mismatched NEW artifact and a missing old pin separately', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-upgrade-input-guard-')
  const mismatchNew = runLane(UPGRADE_SCRIPT, [
    '--old', syntheticTarball(dir, 'good-old', manifestOf('0.5.5-old.1', TARGET_PIN)),
    '--new', syntheticTarball(dir, 'bad-new', manifestOf('0.5.5', OTHER_PIN)),
  ], dir)
  assert.notEqual(mismatchNew.status, 0)
  assert.match(mismatchNew.stderr, /INPUT_DSH_PIN_MISMATCH/u)
  assert.match(mismatchNew.stderr, /\bnew\b/u)

  const missingOld = runLane(UPGRADE_SCRIPT, [
    '--old', syntheticTarball(dir, 'unpinned-old', manifestOf('0.5.5-old.1', undefined)),
    '--new', syntheticTarball(dir, 'good-new', manifestOf('0.5.5', TARGET_PIN)),
  ], dir)
  assert.notEqual(missingOld.status, 0)
  assert.match(missingOld.stderr, /INPUT_DSH_PIN_MISSING_OR_INVALID/u)
  assert.match(missingOld.stderr, /\bold\b/u)
  assertNoLaneSetup(dir, 'dsh-split-upgrade-')
})

test('the process lane refuses a candidate with another exact pin before any install', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-process-input-guard-')
  const source = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  // The candidate identity check is the lane's own: name and version must match
  // this checkout, so only the DSH pin differs here.
  const candidate = syntheticTarball(dir, 'candidate', manifestOf(source.version, OTHER_PIN))
  const result = runLane(PROCESS_SCRIPT, [candidate], dir)
  assert.notEqual(result.status, 0, 'a mismatched candidate must exit nonzero')
  assert.equal(result.signal, null, 'the lane must fail by itself inside the budget, not be killed by it')
  assert.match(result.stderr, /INPUT_UNQUALIFIED/u)
  assert.match(result.stderr, /INPUT_DSH_PIN_MISMATCH/u)
  assert.match(result.stderr, /\bcandidate\b/u)
  assert.ok(result.stderr.includes(OTHER_PIN) && result.stderr.includes(TARGET_PIN),
    `both exact versions must be reported:\n${result.stderr}`)
  assert.ok(!result.stderr.includes('qualified=true'),
    `an unqualified candidate must never announce itself as qualified:\n${result.stderr}`)
  assertNoLaneSetup(dir, 'dsh-split-process-')
})

// ── The default failure report ──────────────────────────────────────────────

const REPORT_KEYS = [
  'schemaVersion', 'lane', 'status', 'category', 'reason', 'checkpoint', 'waitLabel',
  'elapsedMs', 'runtimeDshPin', 'artifacts', 'expected', 'observed', 'progress', 'processes',
]

/** Capture one function's stderr writes without losing the real stream. */
function captureStderr(run) {
  const original = process.stderr.write
  const chunks = []
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    run()
  } finally {
    process.stderr.write = original
  }
  return chunks.join('')
}

function failureHandles(count, records) {
  return Array.from({ length: count }, (_unused, index) => ({
    role: `host-${String(index)}`,
    exited: false,
    records: Array.from({ length: records }, (_u, line) => ({
      m4a0: 'ready',
      pid: 1000 + line,
      // Everything here is arbitrary payload and must never be reported.
      cookie: `COOKIE_SENTINEL-${String(line)}`,
      token: `TOKEN_SENTINEL-${String(line)}`,
      url: 'https://secret.invalid/launch',
      connectUrl: 'https://secret.invalid/mux?token=TOKEN_SENTINEL',
      user: 'the session user text must not leak',
      stderr: 'raw terminal bytes with COOKIE_SENTINEL',
    })),
    stderr: 'raw stderr COOKIE_SENTINEL',
    raw: 'raw pty bytes TOKEN_SENTINEL',
  }))
}

test('the report holds only the whitelisted fields inside its fixed budgets', () => {
  const diagnostics = createSmokeDiagnostics({
    lane: 'split-upgrade',
    heading: 'SPLIT_PROCESS_UPGRADE_SMOKE',
    marker: 'U',
    runtimeDshPin: TARGET_PIN,
    artifacts: [
      smokeArtifactIdentity('old', manifestOf('0.5.5-old.1', TARGET_PIN), 'a'.repeat(64)),
      smokeArtifactIdentity('new', manifestOf('0.5.5', TARGET_PIN), 'b'.repeat(64)),
    ],
  })
  // 30 boundaries, 10 processes, 12 records each: the caps are 24 / 8 / 8.
  for (let index = 0; index < 30; index += 1) diagnostics.checkpoint(`U08/phase-${String(index)}`)
  const stderr = captureStderr(() => diagnostics.reportFailure(
    new SplitSmokeWaitError('WAIT_TIMEOUT', { code: 'FRAME_WAIT_TIMEOUT', waitLabel: 'a fixed label', elapsedMs: 1234 }),
    { processes: failureHandles(10, 12) },
  ))
  assert.match(stderr, /SPLIT_PROCESS_UPGRADE_SMOKE_FAILURE/u)
  const report = projectFailureReport({
    lane: 'split-upgrade',
    category: 'WAIT_TIMEOUT',
    runtimeDshPin: TARGET_PIN,
    progress: diagnostics.progress(),
    processes: failureHandles(10, 12),
  })
  assert.deepEqual(Object.keys(report).filter(key => !REPORT_KEYS.includes(key)), [],
    'the report may not grow a field outside the fixed schema')
  assert.equal(report.progress.length, 24, 'a checkpoint ring keeps at most 24 boundaries')
  assert.equal(report.progress.at(-1).name, 'U08/phase-29', 'and it keeps the RECENT ones')
  assert.equal(report.processes.length, 8, 'at most 8 process summaries')
  for (const handle of report.processes) {
    assert.equal(handle.events.length, 8, 'at most 8 events per process')
    assert.deepEqual(Object.keys(handle.events[0]), ['m4a0'], 'only the official event names are projected')
  }
})

test('the default report and stderr summary never carry payload', () => {
  const diagnostics = createSmokeDiagnostics({
    lane: 'split-process',
    heading: 'SPLIT_PROCESS_SMOKE',
    marker: 'T',
    runtimeDshPin: TARGET_PIN,
    artifacts: [smokeArtifactIdentity('candidate', manifestOf('0.5.5', TARGET_PIN), 'c'.repeat(64))],
  })
  const stderr = captureStderr(() => diagnostics.reportFailure(
    new SplitSmokeWaitError('PROCESS_EXITED', {
      code: 'PROCESS_EXITED_BEFORE_RECORD',
      waitLabel: 'Host ready',
      processRole: 'host',
      elapsedMs: 500,
    }),
    { processes: failureHandles(3, 4) },
  ))
  for (const sentinel of ['COOKIE_SENTINEL', 'TOKEN_SENTINEL', 'secret.invalid', 'user text', 'raw terminal', 'raw pty', 'raw stderr']) {
    assert.ok(!stderr.includes(sentinel), `the stderr summary must not contain ${sentinel}`)
  }
  // The written report must say the same.
  const reported = stderr.match(/report: (\S+)/u)?.[1]
  assert.ok(reported !== undefined, `the summary must print the report path:\n${stderr}`)
  const content = readFileSync(reported, 'utf8')
  for (const sentinel of ['COOKIE_SENTINEL', 'TOKEN_SENTINEL', 'secret.invalid', 'user text', 'raw terminal', 'raw pty', 'raw stderr']) {
    assert.ok(!content.includes(sentinel), `the report must not contain ${sentinel}`)
  }
  const info = statSync(reported)
  assert.equal(info.mode & 0o777, 0o600, 'the report file is private')
  assert.equal(statSync(dirname(reported)).mode & 0o777, 0o700, 'the report directory is private')
  assert.equal(basename(reported), 'failure.json')
  rmSync(dirname(reported), { recursive: true, force: true })
})


test('a qualified run announces its identity and creates NO report artifact', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-smoke-passing-identity-')
  const script = `
    const lib = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'scripts', 'lib', 'split-smoke-diagnostics.mjs')).href)})
    const diagnostics = lib.createSmokeDiagnostics({
      lane: 'split-process',
      heading: 'SPLIT_PROCESS_SMOKE',
      marker: 'T',
      runtimeDshPin: ${JSON.stringify(TARGET_PIN)},
      artifacts: [lib.smokeArtifactIdentity('candidate', {
        name: ${JSON.stringify(PACKAGE_NAME)},
        version: '0.5.5',
        devDependencies: { ${JSON.stringify(DSH_AGENT)}: ${JSON.stringify(TARGET_PIN)} },
      }, 'd'.repeat(64))],
    })
    process.stderr.write(diagnostics.identityLine() + '\\n')
    diagnostics.checkpoint('preflight/candidate-input')
    diagnostics.checkpoint('t18')
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: dir },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /SPLIT_PROCESS_SMOKE_START candidate=@xmoon76\/dsh-pi-tui@0\.5\.5/u)
  assert.match(result.stderr, /pin=0\.2\.1-rc\.5/u)
  assert.match(result.stderr, /qualified=true$/mu)
  assert.match(result.stderr, /\[T checkpoint\] preflight\/candidate-input/u)
  assert.match(result.stderr, /\[T checkpoint\] t18/u, 'checkpoints are visible WITHOUT TRACE or KEEP')
  assert.deepEqual(
    readdirSync(dir).filter(name => name.startsWith('dsh-pi-tui-smoke-failure-')),
    [],
    'a passing run leaves no failure artifact behind',
  )
})

test('a real lane INPUT failure leaves one private report outside any work root and mirrors --evidence', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-upgrade-report-')
  const evidence = join(dir, 'evidence.json')
  const result = runLane(UPGRADE_SCRIPT, [
    '--old', syntheticTarball(dir, 'old', manifestOf('0.5.5-old.1', OTHER_PIN)),
    '--new', syntheticTarball(dir, 'new', manifestOf('0.5.5', TARGET_PIN)),
    '--evidence', evidence,
  ], dir)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /SPLIT_PROCESS_UPGRADE_SMOKE_FAILURE/u)
  const reported = result.stderr.match(/report: (\S+)/u)?.[1]
  assert.ok(reported !== undefined, `the summary must print the report path:\n${result.stderr}`)
  assert.ok(reported.startsWith(dir), 'the report lives under the lane-controlled temp root')
  assert.ok(!reported.includes('dsh-split-upgrade-'), 'the report is NOT inside the deletable work root')
  const report = JSON.parse(readFileSync(reported, 'utf8'))
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.status, 'FAIL')
  assert.equal(report.category, 'INPUT_UNQUALIFIED')
  assert.equal(report.reason, 'INPUT_DSH_PIN_MISMATCH')
  assert.equal(report.runtimeDshPin, TARGET_PIN)
  assert.deepEqual(report.artifacts.map(entry => [entry.role, entry.version, entry.dshPin]), [
    ['old', '0.5.5-old.1', OTHER_PIN],
    ['new', '0.5.5', TARGET_PIN],
  ])
  assert.equal(statSync(reported).mode & 0o777, 0o600)
  assert.equal(statSync(dirname(reported)).mode & 0o777, 0o700)
  // The `--evidence` FAIL twin holds the same safe fields, never the work root.
  assert.deepEqual(JSON.parse(readFileSync(evidence, 'utf8')), report)
  assert.equal(statSync(evidence).mode & 0o777, 0o600)
})

test('the reload notice and rejection classifiers only ever return fixed enums', () => {
  // A painted notice row is recognised only in the product's fixed shape.
  assert.equal(classifyReloadNoticeLine('✗ Client reload skipped: this Client already runs the installed build.'), 'ALREADY_CURRENT')
  assert.equal(classifyReloadNoticeLine('ℹ Client reload blocked: remove or submit the staged attachments first.'), 'ATTACHMENTS')
  assert.equal(classifyReloadNoticeLine('✗ Client reload failed: the installed replacement Client is unavailable or incompatible.'), 'TARGET_INVALID')
  // Anything else — including the same words inside user text — is NOT a notice.
  for (const line of [
    '❯ Client reload skipped: this Client already runs the installed build.',
    '✗ please run Client reload skipped: this Client already runs the installed build.',
    '✗ Client reload skipped: this Client already runs the installed build, plus COOKIE_SENTINEL',
    'https://secret.invalid/mux?token=TOKEN_SENTINEL',
    '',
  ]) {
    assert.equal(classifyReloadNoticeLine(line), undefined, `${line} must not classify`)
  }
  assert.deepEqual(
    classifyReloadNotices([
      '',
      '✗ Client reload skipped: this Client already runs the installed build.',
      '❯ Client reload skipped: this Client already runs the installed build.',
      '✗ Client reload skipped: this Client already runs the installed build.',
    ]),
    ['ALREADY_CURRENT'],
    'only fixed notice rows count, and each type is named once',
  )
  // The internal rejection field maps to a diagnostic enum and never echoes.
  assert.equal(classifyHandoffRejection('local client reexec: the target package is pinned to a different DSH runtime'),
    'TARGET_INVALID_DSH_PIN_MISMATCH')
  assert.equal(classifyHandoffRejection('local client reexec: the installed Client already runs this build'), 'ALREADY_CURRENT')
  assert.equal(classifyHandoffRejection('some arbitrary failure containing COOKIE_SENTINEL'), 'TARGET_INVALID_UNCLASSIFIED')
  assert.equal(classifyHandoffRejection(undefined), 'TARGET_INVALID_UNCLASSIFIED')
})

// ── The U reload waits: early FAIL, PTY-only PASS ───────────────────────────

const ALREADY_CURRENT = 'Client reload skipped: this Client already runs the installed build.'
const ATTACHMENTS = 'Client reload blocked: remove or submit the staged attachments first.'
const TARGET_INVALID = 'Client reload failed: the installed replacement Client is unavailable or incompatible.'
const PIN_REJECTION = 'local client reexec: the target package is pinned to a different DSH runtime'
const SHORT_WAIT_MS = 300

/** A contract-shaped Client view: the real waiters only use these members. */
function fakeClient({ records = [], painted = [], exited = false, recordError = undefined }) {
  return {
    role: 'surface-client',
    records,
    exited,
    recordError,
    async viewport() {
      return painted
    },
    finalRecordRead() {
      return undefined
    },
  }
}

async function rejection(run) {
  try {
    await run()
  } catch (error) {
    return error
  }
  assert.fail('the wait must fail')
}

test('waitForReloadNotice PASSES only on the painted notice', async () => {
  const client = fakeClient({ painted: ['some row', `✗ ${ALREADY_CURRENT}`, 'another row'] })
  assert.equal(await waitForReloadNotice(client, ALREADY_CURRENT, 'U08 already-current notice', 0, SHORT_WAIT_MS),
    'ALREADY_CURRENT')
})

test('waitForReloadNotice fails a refusal that can never paint the expected notice', async () => {
  // The recorded rejection of THIS action says pin mismatch; the wait expects
  // already-current. That is decisive, so it must not consume the 120s budget.
  const started = Date.now()
  const error = await rejection(() => waitForReloadNotice(
    fakeClient({ records: [{ m4r: 'handoff-request-rejected', error: PIN_REJECTION }] }),
    ALREADY_CURRENT, 'U08 already-current notice', 0,
  ))
  assert.equal(error.category, 'UNEXPECTED_RELOAD_REFUSAL')
  assert.equal(error.code, 'PROCESS_REFUSED_RELOAD')
  assert.equal(error.expected, 'ALREADY_CURRENT')
  assert.equal(error.observed, 'TARGET_INVALID_DSH_PIN_MISMATCH')
  assert.ok(Date.now() - started < 5_000, `the refusal must fail fast, took ${String(Date.now() - started)}ms`)
  // A DIFFERENT painted notice is equally decisive.
  const painted = await rejection(() => waitForReloadNotice(
    fakeClient({ painted: [`✗ ${ATTACHMENTS}`] }), ALREADY_CURRENT, 'U08 already-current notice', 0, SHORT_WAIT_MS,
  ))
  assert.equal(painted.category, 'UNEXPECTED_RELOAD_REFUSAL')
  assert.equal(painted.code, 'PAINTED_NOTICE_MISMATCH')
  assert.equal(painted.observed, 'ATTACHMENTS')
})

test('waitForReloadNotice never PASSES from telemetry alone', async () => {
  // An internal refusal that AGREES with the expectation still has to be
  // painted: without a rendered notice this wait times out, it does not pass.
  const error = await rejection(() => waitForReloadNotice(
    fakeClient({ records: [{ m4r: 'handoff-request-rejected', error: 'local client reexec: the installed Client already runs this build' }] }),
    ALREADY_CURRENT, 'U08 already-current notice', 0, SHORT_WAIT_MS,
  ))
  assert.equal(error.category, 'WAIT_TIMEOUT')
  assert.equal(error.expected, 'ALREADY_CURRENT')
})

test('waitForReloadNotice attributes only THIS action records to THIS action', async () => {
  // A refusal left BEFORE the boundary belongs to an earlier command, so it can
  // never decide the current wait: this one still runs to its own deadline.
  const stale = await rejection(() => waitForReloadNotice(
    fakeClient({ records: [{ m4r: 'handoff-request-rejected', error: PIN_REJECTION }] }),
    TARGET_INVALID, 'U08 target-invalid notice', 1, SHORT_WAIT_MS,
  ))
  assert.equal(stale.category, 'WAIT_TIMEOUT', 'a pre-boundary refusal must not decide the current wait')
  // The same slot, with a refusal that contradicts THIS expectation, is decisive.
  const decided = await rejection(() => waitForReloadNotice(
    fakeClient({ records: [{ m4r: 'handoff-request-ignored', reason: 'not-ready' }, { m4r: 'handoff-request-rejected', error: 'local client reexec: the installed Client already runs this build' }] }),
    TARGET_INVALID, 'U08 target-invalid notice', 1, SHORT_WAIT_MS,
  ))
  assert.equal(decided.category, 'UNEXPECTED_RELOAD_REFUSAL')
  assert.equal(decided.observed, 'ALREADY_CURRENT')
})

test('waitForReloadNotice reports a dead or unreadable Client by its own category', async () => {
  const dead = await rejection(() => waitForReloadNotice(
    fakeClient({ exited: true }), ALREADY_CURRENT, 'U08 already-current notice', 0, SHORT_WAIT_MS,
  ))
  assert.equal(dead.category, 'PROCESS_EXITED')
  const unreadable = await rejection(() => waitForReloadNotice(
    fakeClient({ recordError: new Error('malformed') }), ALREADY_CURRENT, 'U08 already-current notice', 0, SHORT_WAIT_MS,
  ))
  assert.equal(unreadable.category, 'INFRA_FAILURE')
})

test('waitForAcceptedHandoff requires this action request for this PID', async () => {
  const accepted = { m4r: 'handoff-requested', pid: 4242, source: 'user-command' }
  const client = fakeClient({ records: [accepted] })
  assert.equal(await waitForAcceptedHandoff(client, 4242, 'U08 accepted reload', 0, SHORT_WAIT_MS), accepted)
  // Another PID is not this Client's own request.
  const wrongPid = await rejection(() => waitForAcceptedHandoff(
    fakeClient({ records: [accepted] }), 9999, 'U08 accepted reload', 0, SHORT_WAIT_MS,
  ))
  assert.equal(wrongPid.category, 'WAIT_TIMEOUT')
  // A request left by the PREVIOUS command does not satisfy this one.
  const stale = await rejection(() => waitForAcceptedHandoff(
    fakeClient({ records: [accepted] }), 4242, 'U08 accepted reload', 1, SHORT_WAIT_MS,
  ))
  assert.equal(stale.category, 'WAIT_TIMEOUT')
})

test('waitForAcceptedHandoff reports the actual refusal of the same action', async () => {
  const rejected = await rejection(() => waitForAcceptedHandoff(
    fakeClient({ records: [{ m4r: 'handoff-request-rejected', error: PIN_REJECTION }] }), 4242, 'U08 accepted reload', 0,
  ))
  assert.equal(rejected.category, 'UNEXPECTED_RELOAD_REFUSAL')
  assert.equal(rejected.observed, 'TARGET_INVALID_DSH_PIN_MISMATCH')
  const ignored = await rejection(() => waitForAcceptedHandoff(
    fakeClient({ records: [{ m4r: 'handoff-request-ignored', reason: 'already-requested' }] }), 4242, 'U08 accepted reload', 0,
  ))
  assert.equal(ignored.code, 'PROCESS_IGNORED_RELOAD')
  assert.equal(ignored.observed, 'STOPPING')
})

test('a real process wait failure reports no terminal or record payload', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-smoke-wait-payload-')
  const entry = join(dir, 'silent-exit.mjs')
  writeFileSync(entry, 'process.exit(0)\n')
  const probe = `
    const { EntryProcess, SurfaceEntryProcess } = await import(${JSON.stringify(pathToFileURL(PROCESS_SCRIPT).href)})
    const options = {
      cwd: ${JSON.stringify(dir)},
      env: { ...process.env },
      anchor: ${JSON.stringify(join(dir, 'anchor.json'))},
      profile: 'pi-tui',
      scratch: ${JSON.stringify(dir)},
      workDir: ${JSON.stringify(dir)},
    }
    const failures = []
    const plain = new EntryProcess('probe-host', ${JSON.stringify(entry)}, options)
    try { await plain.waitFor(record => record.m4a0 === 'ready', 'probe Host ready', 10_000) }
    catch (error) { failures.push({ category: error.category, code: error.code, message: error.message }) }
    const surface = new SurfaceEntryProcess(${JSON.stringify(entry)}, options)
    try { await surface.waitForScreen('never painted', 'probe notice', 10_000) }
    catch (error) { failures.push({ category: error.category, code: error.code, message: error.message }) }
    process.stdout.write(JSON.stringify(failures))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    encoding: 'utf8',
    timeout: 60_000,
    cwd: dir,
  })
  assert.equal(result.status, 0, `the probe process failed:\n${result.stderr}`)
  const failures = JSON.parse(result.stdout)
  assert.equal(failures.length, 2, `both waiters must fail: ${result.stderr}`)
  for (const failure of failures) {
    assert.equal(failure.category, 'PROCESS_EXITED')
    // The reported context is bounded; the bytes stay where they belong: the
    // private JSONL under KEEP, never the default error line.
    assert.ok(!/records=|stderr=|raw=|viewport=/u.test(failure.message),
      `a waiter error must not carry a payload dump: ${failure.message}`)
    assert.ok(failure.message.length < 300, `a waiter error must stay short: ${failure.message}`)
  }
  assert.match(failures[0].message, /probe Host ready/u)
  assert.match(failures[1].message, /probe notice/u)
})
