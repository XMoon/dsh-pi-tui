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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { npmDshVersion } from '../../scripts/lib/dsh-distribution.mjs'
import { requireExactSmokeDshPin, SplitSmokeInputError } from '../../scripts/lib/split-smoke-diagnostics.mjs'

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
  assertNoLaneSetup(dir, 'dsh-split-process-')
})
