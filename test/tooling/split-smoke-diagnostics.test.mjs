/**
 * Split-smoke input qualification and failure diagnostics guard for the two
 * split-process lanes.
 *
 * The two real lanes — the split-process lane (`scripts/split-process-smoke.mjs`,
 * inventory T01-T60) and the split-upgrade lane (`scripts/split-process-upgrade-smoke.mjs`,
 * inventory U01-U09) — install packaged artifacts into an
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
import { chmodSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { npmDshVersion } from '../../scripts/lib/dsh-distribution.mjs'
import {
  classifyHandoffRejection,
  FAILURE_CATEGORIES,
  forensicErrorText,
  formatFailureSummary,
  LANE_ERROR_CODES,
  emitInputFailure,
  isLaneSourceFile,
  LANE_SOURCE_FILES,
  laneAssertionSite,
  safeFailureSummary,
  SplitSmokeAssertionError,
  writeFailureReport,
  classifyReloadNoticeLine,
  classifyReloadNotices,
  createSmokeDiagnostics,
  projectFailureReport,
  requireExactSmokeDshPin,
  smokeArtifactIdentity,
  SplitSmokeInputError,
  SplitSmokeWaitError,
} from '../../scripts/lib/split-smoke-diagnostics.mjs'
import { waitForAcceptedHandoff, waitForReloadNotice, writeRequestedEvidence } from '../../scripts/split-process-upgrade-smoke.mjs'
import { waitForAnyReady, waitForC1WorkEvent, waitForHostSessionEvent, waitForSurfaceStatus } from '../../scripts/split-process-smoke.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UPGRADE_SCRIPT = join(ROOT, 'scripts', 'split-process-upgrade-smoke.mjs')
const PROCESS_SCRIPT = join(ROOT, 'scripts', 'split-process-smoke.mjs')
const LIB = join(ROOT, 'scripts', 'lib', 'split-smoke-diagnostics.mjs')
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
  'schemaVersion', 'lane', 'status', 'category', 'reason', 'checkpoint', 'assertion', 'waitLabel',
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

test('the report holds only the whitelisted fields inside its fixed budgets', (t) => {
  const privateTmp = testLifecycle(t).tempDir('split-smoke-report-root-')
  process.env.TMPDIR = privateTmp
  t.after(() => { delete process.env.TMPDIR })
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

test('the default report and stderr summary never carry payload', (t) => {
  const privateTmp = testLifecycle(t).tempDir('split-smoke-report-root-')
  process.env.TMPDIR = privateTmp
  t.after(() => { delete process.env.TMPDIR })
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

test('waitForReloadNotice PASSES only on the painted fixed notice row', async () => {
  const client = fakeClient({ painted: ['some row', `✗ ${ALREADY_CURRENT}`, 'another row'] })
  assert.equal(await waitForReloadNotice(client, ALREADY_CURRENT, 'U08 already-current notice', 0, SHORT_WAIT_MS),
    'ALREADY_CURRENT')
  // The info-marked form of the same fixed notice is equally real evidence.
  assert.equal(await waitForReloadNotice(
    fakeClient({ painted: [`ℹ ${ALREADY_CURRENT}`] }), ALREADY_CURRENT, 'U08 already-current notice', 0, SHORT_WAIT_MS),
    'ALREADY_CURRENT')
})

test('user text that repeats the notice wording can neither pass nor refuse the wait', async () => {
  // The same bytes as the notice, on a row the product never paints as a notice:
  // a prompt echo, an indented transcript row, a longer sentence that merely
  // contains the notice, and the attachments wording inside the composer. None
  // of them is a `✗`/`ℹ Client reload …` row, so the wait must run to its own
  // deadline and report the timeout with nothing observed.
  for (const painted of [
    [`❯ ${ALREADY_CURRENT}`],
    [`  ${ALREADY_CURRENT}`],
    [`✗ Client reload skipped: this Client already runs the installed build, plus ${ALREADY_CURRENT}`],
    ['u08-reload-client-hold', `echo ${ALREADY_CURRENT}`],
    [`❯ ${ATTACHMENTS}`],
  ]) {
    const error = await rejection(() => waitForReloadNotice(
      fakeClient({ painted }), ALREADY_CURRENT, 'U08 already-current notice', 0, SHORT_WAIT_MS,
    ))
    assert.equal(error.category, 'WAIT_TIMEOUT', `a non-notice row must not decide the wait: ${painted.join('|')}`)
    assert.equal(error.expected, 'ALREADY_CURRENT')
    assert.equal(error.observed, undefined, `a non-notice row must not be reported as observed: ${painted.join('|')}`)
  }
  // The real row still classifies, so this is a shape rule, not a ban.
  const refused = await rejection(() => waitForReloadNotice(
    fakeClient({ painted: [`✗ ${ATTACHMENTS}`] }), ALREADY_CURRENT, 'U08 already-current notice', 0, SHORT_WAIT_MS,
  ))
  assert.equal(refused.category, 'UNEXPECTED_RELOAD_REFUSAL')
  assert.equal(refused.observed, 'ATTACHMENTS')
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

// ── The default output never carries foreign text ───────────────────────────

test('the default final line is the fixed classification, never an Error.message', () => {
  const foreign = new Error(`COOKIE_SENTINEL token=TOKEN_SENTINEL https://secret.invalid/mux `
    + `at /home/operator/private/xmoon76-dsh-pi-tui-0.5.5.tgz records=[{"m4a0":"ready"}]`)
  assert.equal(safeFailureSummary(foreign), 'INFRA_FAILURE')
  assert.equal(safeFailureSummary(new Error('ASSERTION_FAILED: the Host did not publish the old buildId')), 'ASSERTION_FAILED')
  assert.equal(safeFailureSummary(new SplitSmokeInputError('INPUT_DSH_PIN_MISMATCH', 'private text', { role: 'old' })),
    'INPUT_UNQUALIFIED: INPUT_DSH_PIN_MISMATCH')
  const wait = new SplitSmokeWaitError('UNEXPECTED_RELOAD_REFUSAL', {
    code: 'PROCESS_REFUSED_RELOAD',
    waitLabel: 'U08 already-current notice',
    processRole: 'surface-client',
    elapsedMs: 83,
    expected: 'ALREADY_CURRENT',
    observed: 'TARGET_INVALID_DSH_PIN_MISMATCH',
  })
  assert.equal(safeFailureSummary(wait), 'UNEXPECTED_RELOAD_REFUSAL: PROCESS_REFUSED_RELOAD')
  // The forensic projection is a separate call the lanes take only under KEEP.
  assert.match(forensicErrorText(foreign), /COOKIE_SENTINEL/u)
  assert.equal(forensicErrorText(undefined), '(no detail)')
})

test('a failure before the diagnostics collector still leaves one safe report', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-upgrade-preflight-failure-')
  const evidence = join(dir, 'evidence.json')
  const result = runLane(UPGRADE_SCRIPT, [
    '--old', join(dir, 'missing-old.tgz'),
    '--new', join(dir, 'missing-new.tgz'),
    '--evidence', evidence,
  ], dir)
  assert.notEqual(result.status, 0)
  assert.equal(result.signal, null, 'the lane must fail by itself inside the budget')
  assert.match(result.stderr, /SPLIT_PROCESS_UPGRADE_SMOKE_FAILURE/u)
  assert.match(result.stderr, /category: INFRA_FAILURE/u)
  // The artifact path is the operator's own input, but the default projection
  // stays field-shaped and never echoes it as free text.
  for (const path of [join(dir, 'missing-old.tgz'), join(dir, 'missing-new.tgz')]) {
    assert.ok(!result.stderr.includes(path), `the raw artifact path must not be echoed:\n${result.stderr}`)
  }
  assertNoLaneSetup(dir, 'dsh-split-upgrade-')
  const report = JSON.parse(readFileSync(evidence, 'utf8'))
  assert.equal(report.status, 'FAIL')
  assert.equal(report.category, 'INFRA_FAILURE')
  assert.equal(report.lane, 'split-upgrade')
  assert.equal(report.artifacts, undefined, 'no artifact identity may be invented')
  assert.equal(report.processes, undefined, 'no process may be invented')
})

test('an unreadable artifact reports the category without tar or parser text', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-upgrade-unreadable-')
  writeFileSync(join(dir, 'junk-old.tgz'), 'not a gzip stream at all\n')
  const result = runLane(UPGRADE_SCRIPT, [
    '--old', join(dir, 'junk-old.tgz'),
    '--new', syntheticTarball(dir, 'new', manifestOf('0.5.5', TARGET_PIN)),
  ], dir)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /category: INFRA_FAILURE/u)
  assert.ok(!/gzip|tar:|invalid|JSON/u.test(result.stderr), `foreign tool text leaked:\n${result.stderr}`)
})

test('KEEP is the only mode that prints the raw error text', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-upgrade-forensics-')
  const args = [
    '--old', syntheticTarball(dir, 'old', manifestOf('0.5.5-old.1', OTHER_PIN)),
    '--new', syntheticTarball(dir, 'new', manifestOf('0.5.5', TARGET_PIN)),
  ]
  const quiet = runLane(UPGRADE_SCRIPT, args, dir)
  assert.ok(!quiet.stderr.includes('FORENSICS'), `a default run must not print forensics:\n${quiet.stderr}`)
  const started = Date.now()
  const kept = spawnSync(process.execPath, [UPGRADE_SCRIPT, ...args], {
    encoding: 'utf8',
    timeout: 5_000,
    env: { ...process.env, TMPDIR: dir, SPLIT_UPGRADE_KEEP: '1' },
  })
  assert.notEqual(kept.status, 0)
  assert.ok(Date.now() - started < 5_000)
  assert.match(kept.stderr, /SPLIT_PROCESS_UPGRADE_SMOKE_FORENSICS: SplitSmokeInputError: INPUT_UNQUALIFIED/u)
})

test('an existing --evidence file is replaced on a private inode, never rewritten in place', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-upgrade-evidence-mode-')
  const evidence = join(dir, 'evidence.json')
  writeFileSync(evidence, '{}\n')
  chmodSync(evidence, 0o644)
  assert.equal(statSync(evidence).mode & 0o777, 0o644, 'the fixture must start group/world readable')
  const result = runLane(UPGRADE_SCRIPT, [
    '--old', syntheticTarball(dir, 'old', manifestOf('0.5.5-old.1', OTHER_PIN)),
    '--new', syntheticTarball(dir, 'new', manifestOf('0.5.5', TARGET_PIN)),
    '--evidence', evidence,
  ], dir)
  assert.notEqual(result.status, 0)
  assert.equal(statSync(evidence).mode & 0o777, 0o600, 'the FAIL twin must land private')
  assert.equal(JSON.parse(readFileSync(evidence, 'utf8')).category, 'INPUT_UNQUALIFIED')
  assert.deepEqual(readdirSync(dir).filter(name => name.includes('.tmp')), [], 'no temp file may survive')
})

test('every default lane output line is either a fixed marker or a whitelisted field', () => {
  // The failpoint cleanup proof is a qualification-only diagnostic path: it must
  // report the leftover count and the Seat verdict, never the thrown message.
  const tSource = readFileSync(PROCESS_SCRIPT, 'utf8')
  assert.match(tSource, /console\.error\(`FAILPOINT_SEAT_FAILURE seat=\$\{boundedName\(seatName\)\} the Seat stayed owned/u)
  assert.doesNotMatch(tSource, /FAILPOINT_SEAT_FAILURE: \$\{error/u)
  assert.match(tSource, /console\.error\(`FAILPOINT_CLEANUP leftovers=/u)
  // And the two default failure lines stay fixed-shape for both lanes.
  for (const source of [tSource, readFileSync(UPGRADE_SCRIPT, 'utf8')]) {
    assert.match(source, /SMOKE_FAILURE: \$\{safeFailureSummary\(error\)\}/u)
    assert.match(source, /SMOKE_FORENSICS: \$\{forensicErrorText\(error\)\}/u)
  }
})

test('one real lane failure leaves exactly one report and one evidence twin', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-smoke-report-count-')
  const evidence = join(dir, 'evidence.json')
  const result = runLane(UPGRADE_SCRIPT, [
    '--old', syntheticTarball(dir, 'old', manifestOf('0.5.5-old.1', OTHER_PIN)),
    '--new', syntheticTarball(dir, 'new', manifestOf('0.5.5', TARGET_PIN)),
    '--evidence', evidence,
  ], dir)
  assert.notEqual(result.status, 0)
  const reports = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('dsh-pi-tui-smoke-failure-'))
  assert.equal(reports.length, 1, `one failure must leave one report directory: ${String(reports.length)}`)
  const reportPath = join(dir, reports[0].name, 'failure.json')
  assert.deepEqual(
    readdirSync(join(dir, reports[0].name)),
    ['failure.json'],
    'the private report directory holds the report and nothing else',
  )
  // The twin is a real second file on the operator's path with the same fields.
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.deepEqual(JSON.parse(readFileSync(evidence, 'utf8')), report)
  assert.notEqual(realpathSync(evidence), realpathSync(reportPath),
    'the twin must live on the operator path, not inside the report directory')
  assert.equal(readdirSync(dir).filter(name => name.includes('.tmp')).length, 0, 'no temp file may survive')
})

test('an unknown error code is never reported, and never changes the category', () => {
  const foreign = Object.assign(new Error('a parser or library message'), {
    code: 'COOKIE_SENTINEL https://secret.invalid/x TOKEN_SENTINEL',
  })
  assert.equal(safeFailureSummary(foreign), 'INFRA_FAILURE')
  const report = projectFailureReport({ lane: 'split-upgrade', category: 'INFRA_FAILURE', reason: foreign.code })
  assert.equal(report.reason, undefined, 'an unknown code must not become reported text')
  assert.equal(projectFailureReport({ lane: 'split-upgrade', reason: 'MADE_UP_REASON' }).reason, undefined)
  // Declared codes survive, and every code the lanes actually use is declared.
  assert.equal(safeFailureSummary(Object.assign(new Error('x'), { code: 'FRAME_WAIT_TIMEOUT' })),
    'INFRA_FAILURE: FRAME_WAIT_TIMEOUT')
  // Every code the lanes can raise must be declared, or it silently disappears
  // from the report. Each scan targets an actual RAISE site shape, and the same
  // scan collects the raised set used by the reverse check below.
  const declared = new Set(LANE_ERROR_CODES)
  const raised = new Set()
  for (const [name, source] of [
    ['split-process', readFileSync(PROCESS_SCRIPT, 'utf8')],
    ['split-upgrade', readFileSync(UPGRADE_SCRIPT, 'utf8')],
    ['the shared module', readFileSync(LIB, 'utf8')],
  ]) {
    // A waiter failure site: fail('<category>', '<code>') or, where the read must
    // happen first, settleOrFail('<category>', '<code>').
    for (const match of source.matchAll(/\b(?:fail|settleOrFail)\(\s*'([A-Z_]+)'\s*,\s*'([A-Z0-9_]+)'/gu)) {
      assert.ok(FAILURE_CATEGORIES.includes(match[1]), `${name} raises an undeclared category: ${match[1]}`)
      assert.ok(declared.has(match[2]), `${name} raises an undeclared code: ${match[2]}`)
      raised.add(match[2])
    }
    // A direct waiter construction: the facts object names its code beside its label.
    for (const match of source.matchAll(/code: '([A-Z0-9_]+)',\s*\n\s*waitLabel:/gu)) {
      assert.ok(declared.has(match[1]), `${name} reports an undeclared code: ${match[1]}`)
      raised.add(match[1])
    }
    // The input guard's own constructor call.
    for (const match of source.matchAll(/new SplitSmokeInputError\(\s*'([A-Z0-9_]+)'/gu)) {
      assert.ok(declared.has(match[1]), `${name} throws an undeclared input code: ${match[1]}`)
      raised.add(match[1])
    }
    // A thrown classified object: category and code are set together.
    for (const match of source.matchAll(/category: '([A-Z_]+)',\s*\n?\s*code: '([A-Z0-9_]+)'/gu)) {
      assert.ok(FAILURE_CATEGORIES.includes(match[1]), `${name} throws an undeclared category: ${match[1]}`)
      assert.ok(declared.has(match[2]), `${name} throws an undeclared code: ${match[2]}`)
      raised.add(match[2])
    }
  }
  assert.ok(raised.size >= 14, `the raise-site scan found only ${String(raised.size)} codes; the guard went vacuous`)
  // The other direction, over the SAME collected raise sites: a declared code
  // with no raise site is dead vocabulary. The declaration list itself is never
  // accepted as evidence that anything raises a code.
  assert.deepEqual(
    LANE_ERROR_CODES.filter(code => !raised.has(code)),
    [],
    'every declared code must have a scanned raise site',
  )
})

test('a PASS that cannot land its requested evidence document fails instead', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-upgrade-evidence-unwritable-')
  const readOnly = join(dir, 'read-only')
  mkdirSync(readOnly, { mode: 0o500 })
  try {
    const stderr = captureStderr(() => assert.throws(
      () => writeRequestedEvidence(join(readOnly, 'evidence.json'), { status: 'PASS' }),
      error => error.category === 'INFRA_FAILURE' && error.code === 'EVIDENCE_WRITE_FAILED',
    ))
    assert.match(stderr, /DIAGNOSTIC_WRITE_FAILURE/u, 'the write failure is still announced')
    assert.ok(!stderr.includes(readOnly), `the path must not be echoed:\n${stderr}`)
  } finally {
    chmodSync(readOnly, 0o700)
  }
  // And the announcement order makes it impossible to print PASS first.
  const source = readFileSync(UPGRADE_SCRIPT, 'utf8')
  assert.ok(source.indexOf('writeRequestedEvidence(options.evidence, evidence)') < source.indexOf("'SPLIT_UPGRADE_SMOKE_PASS"),
    'the PASS marker may only be written after the requested evidence document landed')
})

// ── Round 8: the reviewer's four P2 findings ────────────────────────────────

test('an event value outside the official names is omitted, never truncated into the report', () => {
  const report = projectFailureReport({
    lane: 'split-process',
    category: 'ASSERTION_FAILED',
    processes: [{
      role: 'host',
      exited: false,
      records: [
        { m4a0: 'COOKIE_SENTINEL', m4r: 'https://secret.invalid/x', m4b2s: 'TOKEN_SENTINEL' },
        { m4a0: 'ready', m4r: 'handoff-request-rejected', m4b2s: 'surface-status' },
      ],
    }],
  })
  const text = JSON.stringify(report)
  for (const sentinel of ['COOKIE_SENTINEL', 'TOKEN_SENTINEL', 'secret.invalid']) {
    assert.ok(!text.includes(sentinel), `an unknown event value must never be reported: ${sentinel}`)
  }
  assert.deepEqual(report.processes[0].events, [
    { m4a0: 'ready', m4r: 'handoff-request-rejected', m4b2s: 'surface-status' },
  ], 'official names survive; the record carrying only unknown names is dropped')
  // The same rule holds on stderr, not only in the JSON.
  const written = writeFailureReport(report)
  const stderr = captureStderr(() => {
    process.stderr.write(`${formatFailureSummary(report, written)}\n`)
  })
  assert.ok(!/SENTINEL|secret\.invalid/u.test(stderr), `stderr leaked an event value:\n${stderr}`)
  rmSync(dirname(written), { recursive: true, force: true })
})

test('a reexec is attributed to the NEWEST Client identity in the same record stream', () => {
  const stream = [
    { m4a0: 'ready', pid: 1000 },
    { m4a0: 'client-started', pid: 2000 },
  ]
  const beforeReplacementReady = projectFailureReport({
    processes: [{ role: 'surface-client', exited: false, records: stream }],
  })
  assert.equal(beforeReplacementReady.processes[0].pid, 2000,
    'the replacement Client is named as soon as it starts; the handed-off PID is not')
  const afterReplacementReady = projectFailureReport({
    processes: [{ role: 'surface-client', exited: false, records: [...stream, { m4a0: 'ready', pid: 2000 }] }],
  })
  assert.equal(afterReplacementReady.processes[0].pid, 2000)
  const noReexec = projectFailureReport({
    processes: [{ role: 'surface-client', exited: false, records: [{ m4a0: 'ready', pid: 1000 }, { m4a0: 'status' }] }],
  })
  assert.equal(noReexec.processes[0].pid, 1000, 'a single-Client stream still reports its own PID')
})

/** This test file as the trusted source set, so the locator mechanism is observable here. */
const SELF_SOURCE = new Set(['split-smoke-diagnostics.test.mjs'])

/** Shaped exactly like a lane's assert helper chain. */
function laneAssert(condition, message, sources) {
  if (!condition) throw new SplitSmokeAssertionError(message, { sources })
}
function laneAssertEqual(actual, expected, message, sources) {
  laneAssert(actual === expected, message ?? `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`, sources)
}

test('an assertion failure is locatable without quoting its message', () => {
  const error = (() => {
    try {
      laneAssertEqual(1, 2, 'COOKIE_SENTINEL host role mismatch https://secret.invalid/x', SELF_SOURCE)
    } catch (caught) {
      return caught
    }
    return assert.fail('the assertion must fail')
  })()
  assert.equal(error.category, 'ASSERTION_FAILED')
  // The site is this call's line, not the helper frames above it.
  assert.match(String(error.assertion), /^split-smoke-diagnostics\.test\.mjs:\d+$/u)
  const reportedLine = Number(error.assertion.split(':')[1])
  assert.ok(reportedLine > 0 && reportedLine <= readFileSync(import.meta.filename, 'utf8').split('\n').length)
  // The extractor proved the mechanism above; the PUBLISHED report only accepts
  // a locator from a trusted lane source, so the reporting half uses one.
  const published = 'split-process-smoke.mjs:4321'
  const report = projectFailureReport({ lane: 'split-process', category: error.category, assertion: published })
  assert.equal(report.assertion, published, 'the report keeps a trusted locator')
  const stderr = captureStderr(() => {
    process.stderr.write(`${formatFailureSummary(report, '/tmp/none')}\n`)
    process.stderr.write(`SPLIT_PROCESS_SMOKE_FAILURE: ${safeFailureSummary(Object.assign(
      new SplitSmokeAssertionError('x'), { assertion: published },
    ))}\n`)
  })
  assert.match(stderr, /assertion: split-process-smoke\.mjs:4321/u)
  assert.match(stderr, /ASSERTION_FAILED at split-process-smoke\.mjs:4321/u)
  // Locating the check must not smuggle the assertion text back into the output.
  for (const sentinel of ['COOKIE_SENTINEL', 'secret.invalid', 'host role mismatch']) {
    assert.ok(!stderr.includes(sentinel), `the default output leaked the assertion text: ${sentinel}`)
  }
})

test('the locator trusts only the lane sources and fails closed otherwise', () => {
  const attempt = (sources) => {
    try {
      laneAssert(false, 'a plain check', sources)
    } catch (caught) {
      return caught
    }
    return assert.fail('the assertion must fail')
  }
  // Default trust set = the two lane scripts; this test file is NOT one of them.
  assert.equal(attempt(undefined).assertion, undefined,
    'a frame outside the trusted lane sources must not become a locator')
  assert.deepEqual([...LANE_SOURCE_FILES].sort(), ['split-process-smoke.mjs', 'split-process-upgrade-smoke.mjs'])
  // The default trust set is data, not a Set a caller can widen.
  assert.ok(Object.isFrozen(LANE_SOURCE_FILES), 'the exported list must be frozen')
  assert.equal(typeof LANE_SOURCE_FILES.add, 'undefined', 'there must be no mutator to widen the trust set')
  assert.equal(isLaneSourceFile('split-process-smoke.mjs'), true)
  assert.equal(isLaneSourceFile('foreign.mjs'), false)
  // Both real lanes are trusted by their own basenames.
  for (const lane of ['split-process-smoke.mjs', 'split-process-upgrade-smoke.mjs']) {
    assert.ok(isLaneSourceFile(basename(lane)))
  }
  // An empty trust set and a trust set naming something else both fail closed.
  assert.equal(attempt(new Set()).assertion, undefined)
  assert.equal(attempt(new Set(['some-other-script.mjs'])).assertion, undefined)
  // Called straight from a trusted file, the REAL caller line wins — and it is
  // the helper functions' own lines that never become the site.
  const direct = laneAssertionSite(undefined, SELF_SOURCE)
  assert.match(String(direct), /^split-smoke-diagnostics\.test\.mjs:\d+$/u,
    'a direct call from a trusted file resolves to the caller')
  const helperLines = [...readFileSync(import.meta.filename, 'utf8').matchAll(/^function laneAssert(?:Equal)?\(/gmu)]
    .map(match => readFileSync(import.meta.filename, 'utf8').slice(0, match.index).split('\n').length)
  assert.ok(!helperLines.includes(Number(String(direct).split(':')[1])),
    'a helper frame must never be reported as the assertion site')
})

test('a forged or unusable frame never becomes a locator', () => {
  // The locator is derived from the REAL stack, so a forged `at …` line in the
  // message must not influence it.
  const forged = (() => {
    try {
      laneAssert(false, 'at assert (split-process-smoke.mjs:999:1)', SELF_SOURCE)
    } catch (caught) {
      return caught
    }
    return assert.fail('the assertion must fail')
  })()
  assert.match(String(forged.assertion), /^split-smoke-diagnostics\.test\.mjs:\d+$/u,
    'the site comes from the stack, never from the message')
  assert.ok(!String(forged.assertion).includes(':999:'), 'a message-supplied line must not be adopted')
  // An unusable shape is rejected by the report projection as well.
  for (const bad of [
    'process.cwd()',                                   // no basename shape
    '/abs/path/scripts/split-process-smoke.mjs:12',    // absolute path
    'C:\\Users\\me\\lane.mjs:12',                    // Windows path
    'split-process-smoke.mjs:0',                       // invalid line
    'split-process-smoke.mjs:12:3',                    // frame, not a site
    '%73plit-process-smoke.mjs:12',                    // encoded
    'split-process-smoke.mjs:'.padEnd(90, '9'),        // over-long
  ]) {
    assert.equal(projectFailureReport({ lane: 'split-process', assertion: bad }).assertion, undefined,
      `the projection must refuse ${JSON.stringify(bad)}`)
  }
})

test('the report only accepts a locator from a trusted lane source', (t) => {
  // `reportFailure` writes a report under TMPDIR; keep it in this test's root.
  const privateTmp = testLifecycle(t).tempDir('split-smoke-locator-')
  const previousTmp = process.env.TMPDIR
  process.env.TMPDIR = privateTmp
  t.after(() => {
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
  })
  // A real lane file is accepted (shape + source).
  assert.equal(projectFailureReport({ lane: 'split-process', assertion: 'split-process-smoke.mjs:12' }).assertion,
    'split-process-smoke.mjs:12')
  assert.equal(projectFailureReport({ lane: 'split-upgrade', assertion: 'split-process-upgrade-smoke.mjs:99' }).assertion,
    'split-process-upgrade-smoke.mjs:99')
  // A well-shaped locator naming anything else is refused by the PROJECTION,
  // not only by the stack extractor: an error that merely carries an
  // `assertion` property must not smuggle a foreign file into the report.
  for (const foreign of ['foreign.mjs:123', 'split-smoke-diagnostics.test.mjs:7', 'another-lane.mjs:1']) {
    assert.equal(projectFailureReport({ lane: 'split-process', assertion: foreign }).assertion, undefined,
      `the projection must refuse ${foreign}`)
  }
  // And the summary line respects the same rule.
  assert.ok(!safeFailureSummary(Object.assign(new Error('x'), {
    category: 'ASSERTION_FAILED', assertion: 'foreign.mjs:123',
  })).includes('foreign.mjs'))
  // Production reporting ignores an `.assertion` property unless the locator was
  // derived by the assertion class itself.
  const forged = Object.assign(new Error('forged'), { category: 'ASSERTION_FAILED', assertion: 'split-process-smoke.mjs:42' })
  const diagnostics = createSmokeDiagnostics({ lane: 'split-process', heading: 'SPLIT_PROCESS_SMOKE', marker: 'T' })
  const report = diagnostics.reportFailure(forged)
  assert.equal(report.assertion, undefined, 'an arbitrary error may not contribute a locator')
})

test('the raw assertion property has exactly ONE reader in the shared module', () => {
  // The producer rule has been missed at three output paths (collector,
  // pre-collector, summary). The containment is structural: `publishedAssertionOf`
  // is the only reader of an error's `assertion`, and every consumer goes through
  // it. Parsed with the TypeScript AST so alias, destructure and bracket forms are
  // covered, not just `error.assertion`.
  const source = readFileSync(LIB, 'utf8')
  const file = ts.createSourceFile('diagnostics.mjs', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  const insideReader = (node) => {
    // Ascend to the nearest function declaration; the reader is the only allowed owner.
    for (let cursor = node.parent; cursor !== undefined; cursor = cursor.parent) {
      if (ts.isFunctionDeclaration(cursor) && cursor.name?.text === 'publishedAssertionOf') return true
    }
    return false
  }
  /** A consumer of an ALREADY-VALIDATED site, not a read of a raw error property. */
  const isSafeObject = (node) => node.kind === ts.SyntaxKind.ThisKeyword
    || (ts.isIdentifier(node) && ['report', 'input', 'extra'].includes(node.text))
  /** A WRITE defines the property; only reads can leak a forged value. */
  const isAssignmentTarget = (node) => ts.isBinaryExpression(node.parent)
    && node.parent.left === node
    && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  const offenders = []
  const visit = (node) => {
    if (insideReader(node)) return
    // error.assertion
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name) && node.name.text === 'assertion'
      && !isSafeObject(node.expression) && !isAssignmentTarget(node)) {
      offenders.push(`dot access at ${String(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)}`)
    }
    // error['assertion'] / error["assertion"]
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
      && node.argumentExpression.text === 'assertion') {
      offenders.push(`bracket access at ${String(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)}`)
    }
    // const { assertion } = error / const { assertion: site } = error
    if (ts.isObjectBindingPattern(node)) {
      for (const element of node.elements) {
        const name = element.propertyName ?? element.name
        if (ts.isIdentifier(name) && name.text === 'assertion') {
          offenders.push(`destructure at ${String(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1)}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  assert.deepEqual(offenders, [],
    `every assertion read must go through publishedAssertionOf; found: ${offenders.join(', ')}`)
  // The reader itself must still exist, or the check above is trivially satisfied.
  assert.match(source, /function publishedAssertionOf\(error\) \{/u)
})

test('a forged locator on a plain error never reaches the summary or the report', (t) => {
  const privateTmp = testLifecycle(t).tempDir('split-smoke-forged-')
  const previousTmp = process.env.TMPDIR
  process.env.TMPDIR = privateTmp
  t.after(() => {
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
  })
  // A TRUSTED-LOOKING site: the shape AND the source are legitimate, so only the
  // producer rule can reject it. The earlier case used a foreign filename, which
  // the projection already refused — that proved the wrong thing.
  const forged = Object.assign(new Error('forged'), {
    category: 'ASSERTION_FAILED',
    assertion: 'split-process-smoke.mjs:42',
  })
  assert.equal(safeFailureSummary(forged), 'ASSERTION_FAILED', 'the summary must not carry the site')
  assert.ok(!safeFailureSummary(forged).includes('split-process-smoke.mjs:42'))
  const reported = projectFailureReport({ lane: 'split-process', category: 'ASSERTION_FAILED' })
  assert.equal(reported.assertion, undefined)
  const diagnostics = createSmokeDiagnostics({ lane: 'split-process', heading: 'SPLIT_PROCESS_SMOKE', marker: 'T' })
  assert.equal(diagnostics.reportFailure(forged).assertion, undefined)
  const stderr = captureStderr(() => {
    const report = emitInputFailure({ lane: 'split-process', heading: 'SPLIT_PROCESS_SMOKE', error: forged })
    assert.equal(report.assertion, undefined, 'the pre-collector path must refuse it too')
    process.stderr.write(`SPLIT_PROCESS_SMOKE_FAILURE: ${safeFailureSummary(forged)}\n`)
  })
  assert.ok(!stderr.includes('split-process-smoke.mjs:42'), `a forged trusted-looking site leaked:\n${stderr}`)
  // The genuine class still publishes everywhere.
  const genuine = Object.assign(new SplitSmokeAssertionError('x'), { assertion: 'split-process-smoke.mjs:4321' })
  assert.equal(safeFailureSummary(genuine), 'ASSERTION_FAILED at split-process-smoke.mjs:4321')
})

test('a pre-collector failure cannot publish a forged assertion locator', (t) => {
  // The report is written under TMPDIR; keep this test's artifacts in its own root.
  const privateTmp = testLifecycle(t).tempDir('split-smoke-precollector-')
  const previousTmp = process.env.TMPDIR
  process.env.TMPDIR = privateTmp
  t.after(() => {
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
  })
  // Same producer rule as the collector, on the path used when the failure
  // happens before the diagnostics object exists.
  const forged = Object.assign(new Error('forged pre-collector failure'), {
    category: 'INFRA_FAILURE',
    assertion: 'split-process-smoke.mjs:42',
  })
  const stderr = captureStderr(() => {
    const report = emitInputFailure({ lane: 'split-process', heading: 'SPLIT_PROCESS_SMOKE', error: forged })
    assert.equal(report.assertion, undefined, 'a plain error may not contribute a locator')
    assert.ok(!JSON.stringify(report).includes('split-process-smoke.mjs:42'))
  })
  assert.ok(!stderr.includes('split-process-smoke.mjs:42'), `the summary leaked the forged site:\n${stderr}`)
  // The real class still publishes on that path.
  const genuine = new SplitSmokeAssertionError('a real pre-collector assertion')
  if (genuine.assertion === undefined) return // not a lane source: nothing to publish
  const report = emitInputFailure({ lane: 'split-process', heading: 'SPLIT_PROCESS_SMOKE', error: genuine })
  assert.equal(report.assertion, genuine.assertion)
})

test('both lanes raise locatable assertions through the shared class', () => {
  for (const file of [PROCESS_SCRIPT, UPGRADE_SCRIPT]) {
    assert.match(readFileSync(file, 'utf8'),
      /function assert\(condition, message\) \{\n\s*if \(!condition\) throw new SplitSmokeAssertionError\(message\)\n\}/u,
      `${basename(file)} must raise locatable assertions`)
  }
})

test('a setup failure is reported and leaves no half-created scene behind', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('split-smoke-setup-failure-')
  const source = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  // A candidate that PASSES the pin preflight, so the failure lands in setup.
  const candidate = syntheticTarball(dir, 'candidate', manifestOf(source.version, TARGET_PIN))
  const locked = join(dir, 'locked-tmp')
  mkdirSync(locked, { mode: 0o500 })
  const started = Date.now()
  let result
  try {
    result = spawnSync(process.execPath, [PROCESS_SCRIPT, candidate], {
      encoding: 'utf8', timeout: 10_000, env: { ...process.env, TMPDIR: locked },
    })
  } finally {
    chmodSync(locked, 0o700)
  }
  assert.equal(result.signal, null, `the lane must fail by itself: ${result.error?.message}`)
  assert.notEqual(result.status, 0)
  assert.ok(Date.now() - started < 10_000)
  // The report write also cannot land, and that is announced as an errno only —
  // the failure itself never turns into silence or into a payload dump.
  assert.match(result.stderr, /SPLIT_PROCESS_SMOKE_FAILURE\n/u, `the fixed block must print:\n${result.stderr}`)
  assert.match(result.stderr, /category: INFRA_FAILURE/u)
  assert.match(result.stderr, /DIAGNOSTIC_WRITE_FAILURE: E[A-Z]+/u)
  assert.match(result.stderr, /SPLIT_PROCESS_SMOKE_FAILURE: INFRA_FAILURE$/mu)
  assert.ok(!/ENOENT|EACCES: |syscall|errno:/.test(result.stderr), `a system error text leaked:\n${result.stderr}`)
  assert.deepEqual(readdirSync(locked), [], 'no work root may survive the setup failure')
})

// ── Round 12: every bounded wait must classify itself ───────────────────────

test('the fixture and session waits classify their timeout instead of INFRA_FAILURE', async (t) => {
  // An empty work root: the wait can only time out, which is the point.
  const life = testLifecycle(t)
  const empty = life.tempDir('split-smoke-wait-')
  mkdirSync(empty, { recursive: true })
  const workProof = await rejection(() => waitForC1WorkEvent(empty, () => false, 'a fixture proof', 120))
  assert.equal(workProof.category, 'WAIT_TIMEOUT')
  assert.equal(workProof.code, 'WORK_PROOF_WAIT_TIMEOUT')
  assert.equal(workProof.waitLabel, 'a fixture proof')
  assert.ok(workProof.elapsedMs >= 120, `the timeout reports the real elapsed time, got ${String(workProof.elapsedMs)}`)
  assert.ok(workProof.elapsedMs < 5_000, 'and not an unrelated budget')
  const session = await rejection(() => waitForHostSessionEvent(empty, 'session-x', () => false, 'a Session event', 120))
  assert.equal(session.category, 'WAIT_TIMEOUT')
  assert.equal(session.code, 'SESSION_EVENT_WAIT_TIMEOUT')
  assert.equal(session.waitLabel, 'a Session event')
  assert.ok(session.elapsedMs >= 120 && session.elapsedMs < 5_000)
})

test('the surface-status wait classifies its timeout against the Client', async () => {
  /** A contract-shaped SurfaceEntryProcess: the poller's own read is injectable. */
  const fakeSurface = ({ records = [], exited = false, lateRead }) => ({
    role: 'surface-client',
    records,
    exited,
    finalRecordRead(label) {
      // Mirrors the real contract: one synchronous read of the complete tail.
      if (lateRead !== undefined) lateRead(this, label)
      return undefined
    },
  })
  const client = fakeSurface({})
  const error = await rejection(() => waitForSurfaceStatus(client, () => false, 'a surface status', 120))
  assert.equal(error.category, 'WAIT_TIMEOUT')
  assert.equal(error.code, 'SURFACE_STATUS_WAIT_TIMEOUT')
  assert.equal(error.processRole, 'surface-client')
  assert.equal(error.waitLabel, 'a surface status')
  assert.ok(error.elapsedMs >= 120 && error.elapsedMs < 5_000)
  // A Client that died while the status never arrived fails fast and by its own
  // category: reporting `timeoutMs` here would hide the early exit.
  const dead = fakeSurface({ exited: true })
  const exited = await rejection(() => waitForSurfaceStatus(dead, () => false, 'a surface status', 5_000))
  assert.equal(exited.category, 'PROCESS_EXITED')
  assert.equal(exited.code, 'PROCESS_EXITED_BEFORE_STATUS')
  assert.ok(exited.elapsedMs < 1_000,
    `an early exit must not consume the whole budget, got ${String(exited.elapsedMs)}`)
})

test('a status written just before the close is read, not reported missing', async () => {
  // The poller stops on close, so the LAST line may still be unread when the
  // Client exits: the wait must take the final synchronous read before it
  // concludes the status never arrived.
  const late = { m4b2s: 'surface-status', sessionOpen: true }
  const client = {
    role: 'surface-client',
    records: [],
    exited: true,
    finalRecordRead() {
      this.records = [late]
      return undefined
    },
  }
  const status = await waitForSurfaceStatus(client, record => record.sessionOpen === true, 'a surface status', 5_000)
  assert.equal(status, late, 'the late-written status must satisfy the wait')
})

test('a final record read that fails is an infrastructure failure, not a timeout', async () => {
  const client = {
    role: 'surface-client',
    records: [],
    exited: true,
    finalRecordRead(label) {
      return new SplitSmokeWaitError('INFRA_FAILURE', {
        code: 'RECORD_READ_FAILED',
        waitLabel: label,
        processRole: this.role,
      })
    },
  }
  const error = await rejection(() => waitForSurfaceStatus(client, () => false, 'a surface status', 5_000))
  assert.equal(error.category, 'INFRA_FAILURE')
  assert.equal(error.code, 'RECORD_READ_FAILED')
})

test('the ready race separates an early exit from a timeout', async () => {
  // Every contender already exited: that is PROCESS_EXITED, not a timeout.
  const exited = [{
    role: 'host-1',
    exited: true,
    records: [{ m4a0: 'failure', code: 'HOST_START_TIMEOUT' }],
    exitResult: { code: 1, signal: null },
  }]
  const exitedError = await rejection(() => waitForAnyReady(exited, 'a ready contender', 5_000))
  assert.equal(exitedError.category, 'PROCESS_EXITED')
  assert.equal(exitedError.code, 'READY_RACE_EXITED')
  assert.equal(exitedError.waitLabel, 'a ready contender')
  assert.ok(Number.isInteger(exitedError.elapsedMs), 'the exit category still carries an elapsed time')
  assert.ok(exitedError.elapsedMs < 5_000, 'measured, not the budget')
  // A live-but-never-ready contender is a genuine timeout.
  const live = [{ role: 'host-2', exited: false, records: [], exitResult: undefined }]
  const timeoutError = await rejection(() => waitForAnyReady(live, 'a ready contender', 120))
  assert.equal(timeoutError.category, 'WAIT_TIMEOUT')
  assert.equal(timeoutError.code, 'READY_RACE_TIMEOUT')
  assert.ok(timeoutError.elapsedMs >= 120 && timeoutError.elapsedMs < 5_000)
})

test('a ready race that lost every contender reports EVERY one of them', async (t) => {
  // The REAL T08 topology: sixteen processes whose role is `host` and which never
  // publish `ready`. A projection that folds on `(role, pid)` would then merge all
  // of them into a single summary — hiding fifteen failures.
  const privateTmp = testLifecycle(t).tempDir('split-smoke-ready-race-')
  const previousTmp = process.env.TMPDIR
  process.env.TMPDIR = privateTmp
  t.after(() => {
    if (previousTmp === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmp
  })
  const contenders = Array.from({ length: 10 }, (_unused, index) => ({
    role: 'host',
    exited: true,
    // No `ready` record at all: the handle has NO discoverable PID.
    records: [{ m4a0: 'failure', code: 'HOST_START_TIMEOUT' }],
    // Distinguishable so a collapse is visible as a wrong count, not a coincidence.
    exitResult: { code: 20 + index, signal: null },
  }))
  const error = await rejection(() => waitForAnyReady(contenders, 'T08 16-host race', 50))
  assert.equal(error.category, 'PROCESS_EXITED')
  // Go through the REAL reporting path, not the projection in isolation.
  const diagnostics = createSmokeDiagnostics({
    lane: 'split-process', heading: 'SPLIT_PROCESS_SMOKE', marker: 'T',
  })
  const stderr = captureStderr(() => diagnostics.reportFailure(error))
  const reportPath = stderr.match(/report: (\S+)/u)?.[1]
  assert.ok(reportPath !== undefined, `the summary must print the report path:\n${stderr}`)
  const written = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.equal(written.processes.length, 8, 'the cap keeps 8 summaries, not 1')
  const codes = written.processes.map(handle => handle.exitCode).sort((a, b) => a - b)
  assert.deepEqual(codes, [22, 23, 24, 25, 26, 27, 28, 29],
    `each kept summary must be a DIFFERENT process (last 8 of 20..29), got ${JSON.stringify(codes)}`)
  for (const handle of written.processes) {
    assert.equal(handle.role, 'host')
    assert.equal(handle.exited, true)
    assert.equal(handle.pid, undefined, 'a contender that never published ready has no PID')
    assert.deepEqual(handle.events, [{ m4a0: 'failure' }], 'only official event names')
  }
  // Privacy: the record payload must not ride along with the summaries.
  assert.ok(!readFileSync(reportPath, 'utf8').includes('HOST_START_TIMEOUT'))
  assert.ok(!stderr.includes('HOST_START_TIMEOUT'))
})

test('the SAME handle passed twice is one process, with or without a PID', () => {
  const withoutPid = { role: 'host', exited: true, records: [{ m4a0: 'failure' }], exitResult: { code: 3, signal: null } }
  const once = projectFailureReport({ lane: 'split-process', processes: [withoutPid] })
  const twice = projectFailureReport({ lane: 'split-process', processes: [withoutPid, withoutPid] })
  assert.equal(once.processes.length, 1)
  assert.equal(twice.processes.length, 1, 'the same handle must not be counted twice just for lacking a PID')
  // Two DIFFERENT handles of the same role without a PID are two processes.
  const sibling = { role: 'host', exited: true, records: [{ m4a0: 'failure' }], exitResult: { code: 4, signal: null } }
  const both = projectFailureReport({ lane: 'split-process', processes: [withoutPid, sibling] })
  assert.equal(both.processes.length, 2)
  assert.deepEqual(both.processes.map(handle => handle.exitCode), [3, 4])
  // A KNOWN pid still identifies the same process across two distinct wrappers.
  const withPidA = { role: 'surface-client', exited: false, records: [{ m4a0: 'ready', pid: 4242 }] }
  const withPidB = { role: 'surface-client', exited: true, records: [{ m4a0: 'ready', pid: 4242 }], exitResult: { code: 0, signal: null } }
  const merged = projectFailureReport({ lane: 'split-process', processes: [withPidA, withPidB] })
  assert.equal(merged.processes.length, 1, 'one PID is one process')
  assert.equal(merged.processes[0].exited, true, 'the exit fact from either wrapper survives')
})

test('no bounded wait in either lane still throws a bare Error', () => {
  // A bare Error is classified INFRA_FAILURE with no label, which turns a real
  // wait timeout into an "infrastructure" report. Scanned per waiter FUNCTION so
  // the artifact-preflight throws (which are legitimately INFRA_FAILURE) are not
  // mistaken for waits.
  for (const [name, file] of [['split-process', PROCESS_SCRIPT], ['split-upgrade', UPGRADE_SCRIPT]]) {
    const source = readFileSync(file, 'utf8')
    const waiters = [...source.matchAll(/^(?:export )?async function (wait\w+)\([\s\S]*?^\}/gmu)]
    assert.ok(waiters.length >= 4, `${name} exposes fewer waits than expected: ${String(waiters.length)}`)
    for (const [body, fn] of waiters.map(match => [match[0], match[1]])) {
      // `waitForOutcome` only delegates to another (already classified) waiter.
      if (fn === 'waitForOutcome') continue
      const bare = body.match(/throw new Error\(/u)
      assert.equal(bare, null, `${name}.${fn} still throws a bare Error from a bounded wait`)
    }
  }
})
