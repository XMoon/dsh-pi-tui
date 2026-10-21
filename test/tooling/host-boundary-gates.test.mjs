import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  classifyDeprecatedReaders,
  collectSourceFiles,
  DEPRECATED_READER_ALLOWLIST,
  scanDeprecatedReaders,
  scanSessionEvents,
} from '../../scripts/check-no-session-events.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const CI_WORKFLOW = new URL('../../.github/workflows/ci.yml', import.meta.url)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const GATE_SCRIPT = join(REPO_ROOT, 'scripts', 'check-no-session-events.mjs')
const PACKAGE_JSON = join(REPO_ROOT, 'package.json')

/** The repository's package scripts, as raw source text (the exact spelling
 *  of a script entry is what a CI step invokes). */
function packageScripts() {
  return readFileSync(PACKAGE_JSON, 'utf8')
}

test('the D1 closure smoke is the ONE Source Mode entry for the four parity proofs', () => {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8')
  // The D1 closure OWNS the four same-Host parity proofs: it spawns each of
  // them itself and aggregates their results into the explicit read-gap
  // ledger. A CI step that ran a proof standalone as well made the SAME proof
  // execute TWICE per Source Mode run.
  //
  // The contract this lock protects is the EXECUTION GRAPH, not the old step
  // strings: each parity proof is invoked exactly once in the Source Mode CI
  // run, and the closure is the only place that invokes it.
  assert.match(
    workflow,
    /- name: D1 closure gate\n\s+if: env\.DSH_MODE == 'source'\n\s+run: pnpm smoke:remote-d1-closure/u,
    'the D1 closure gate must remain a Source Mode step',
  )
  for (const command of [
    'smoke:remote-surface-authority-parity',
    'smoke:remote-task-read-parity',
    'smoke:remote-presentation-parity',
    'smoke:remote-session-read-parity',
  ]) {
    assert.doesNotMatch(
      workflow,
      new RegExp(`run: pnpm ${command}\\b`, 'u'),
      `${command} must not be a standalone CI step: the D1 closure runs it`,
    )
  }
  // The proof scripts themselves stay individually invocable (a developer can
  // still run one proof on its own while debugging).
  for (const command of [
    'smoke:remote-surface-authority-parity',
    'smoke:remote-task-read-parity',
    'smoke:remote-presentation-parity',
    'smoke:remote-session-read-parity',
  ]) {
    assert.ok(
      packageScripts().includes(`"${command}":`),
      `${command} must keep its own package script`,
    )
  }
})

test('the D1 closure still invokes all four parity proofs and keeps the known-skips contract', () => {
  const closure = readFileSync(new URL('../../scripts/dsh-remote-d1-closure-smoke.mjs', import.meta.url), 'utf8')
  for (const script of [
    'scripts/dsh-remote-session-read-parity-smoke.mjs',
    'scripts/dsh-remote-surface-authority-parity-smoke.mjs',
    'scripts/dsh-remote-task-read-parity-smoke.mjs',
    'scripts/dsh-remote-presentation-parity-smoke.mjs',
  ]) {
    assert.ok(closure.includes(script), `the D1 closure must invoke ${script}`)
  }
  // The closure's own contract: the aggregated known-skips set is asserted
  // EXACTLY, and every domain must be passed/comparable/mismatch-free. This
  // is the evidence the four standalone CI steps never added.
  assert.match(closure, /assert\.deepEqual\(skipped, KNOWN_SKIPS\)/u,
    'the closure must keep asserting the exact known-skips set')
  assert.match(closure, /mismatchCount === 0/u,
    'the closure must keep asserting a mismatch-free aggregate')
  assert.match(closure, /KNOWN_SKIPS = Object\.freeze\(\[\s*'session\.createdAt',\s*'session\.live',/u,
    'the known-skips set must stay exactly the two recorded session gaps')
  // A failing proof must not be swallowed by the aggregation layer.
  assert.match(closure, /if \(result\.status !== 0\) \{[\s\S]*?throw new Error/u,
    'a failing parity proof must fail the closure')
})

test('Source Mode parity smokes build the vendored pi-tui dist first', () => {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8')
  const build = workflow.indexOf('- name: Build vendored pi-tui before Source Mode smokes')
  const firstSmoke = workflow.indexOf('- name: Remote Session read fixture smoke')
  assert.ok(build >= 0, 'Source checks must build the private pi-tui export before importing projections')
  assert.ok(firstSmoke > build, 'the vendored pi-tui build must precede every Remote smoke')
  assert.match(
    workflow,
    /^      - name: Pi component compatibility contract\n        run: pnpm gate:pi-surface-compat$/mu,
    'the compatibility contract must remain a top-level Source checks step',
  )
})

test('task, presentation, and closure smokes are Source Mode gates', () => {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8')
  for (const [name, command] of [
    ['closure gate', 'smoke:remote-d1-closure'],
    ['closure smoke', 'smoke:remote-d2-closure'],
  ]) {
    assert.match(
      workflow,
      new RegExp(`- name: ${name}\\n\\s+if: env\\.DSH_MODE == 'source'\\n\\s+run: pnpm ${command}`),
    )
  }
  // The 0.1.6-era D2.2 ordinary-write harness was retired with replacement
  // coverage: its scenarios (queue/steer/edit/remove/cancel/rename through
  // the official SessionFace) are covered by the remote writer,
  // host-command, subagent-port, and pending-input reader unit suites, and
  // the D2 closure keeps proving fork/rewind parity through the current
  // d2.4 smoke.
  assert.doesNotMatch(workflow, /smoke:remote-d2-write/,
    'the retired D2.2 write harness must not remain a gate')
  // D2 stays an INDEPENDENT qualification: it must not be folded into the D1
  // closure, and the D2 closure keeps its own separate step.
  assert.doesNotMatch(workflow, /d2-closure[\s\S]*?d1-closure/u,
    'the D2 closure must stay a separate step from the D1 closure')
})

// ── deprecated synchronous Session history reader freeze (WP2) ─────────────

/** Write one synthetic source file under a temp root at `relPath`. */
function syntheticSource(life, label, relPath, content) {
  const root = life.tempDir(label)
  const path = join(root, relPath)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  return { root, path }
}

test('the real production tree passes the frozen deprecated-reader baseline', () => {
  const result = spawnSync(process.execPath, [GATE_SCRIPT], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stderr, /frozen deprecated-reader debt call site/u)
})

test('the gate scans production src/** only, never test fixtures', () => {
  const files = collectSourceFiles()
  assert.ok(files.length > 0)
  for (const path of files) {
    assert.ok(path.startsWith(join(REPO_ROOT, 'src') + sep), `scanned outside src: ${path}`)
    assert.ok(!path.includes(`${sep}test${sep}`), `scanned a test fixture: ${path}`)
  }
})

test('a NEW production deprecated-reader call is rejected (snapshotEvents / eventAt / ownEvents)', (t) => {
  const life = testLifecycle(t)
  for (const [call, line] of [
    ['snapshotEvents', 'export const events = session.snapshotEvents()\n'],
    ['eventAt', 'export const event = session.eventAt(seq)\n'],
    ['ownEvents', 'export const events = session.ownEvents()\n'],
  ]) {
    const { root, path } = syntheticSource(life, `gate-${call}-`, 'src/new-reader.ts', line)
    const offenders = scanDeprecatedReaders([path], { root })
    assert.equal(offenders.length, 1, `${call} must be detected`)
    assert.equal(offenders[0].call, call)
    const { unallowed, stale } = classifyDeprecatedReaders(offenders, [])
    assert.equal(unallowed.length, 1, `${call} must be rejected without an allowance`)
    assert.deepEqual(stale, [])
  }
})

test('a whitespace or newline form of a deprecated reader is still detected', (t) => {
  const life = testLifecycle(t)
  for (const [call, content] of [
    ['snapshotEvents', 'export const a = session.snapshotEvents ()\n'],
    ['eventAt', 'export const b = session.eventAt\n  (seq)\n'],
    ['ownEvents', 'export const c = session.ownEvents\t()\n'],
  ]) {
    const { root, path } = syntheticSource(life, `gate-ws-${call}-`, 'src/new-reader.ts', content)
    const offenders = scanDeprecatedReaders([path], { root })
    assert.equal(offenders.length, 1, `${call} whitespace form must be detected`)
    assert.equal(offenders[0].call, call)
    assert.equal(classifyDeprecatedReaders(offenders, []).unallowed.length, 1)
  }
})

test('a removed Session.events read is still rejected', (t) => {
  const life = testLifecycle(t)
  const { path } = syntheticSource(life, 'gate-events-', 'src/legacy.ts', 'export const events = session.events\n')
  const offenders = scanSessionEvents([path])
  assert.equal(offenders.length, 1)
  assert.equal(offenders[0].line, 1)
})

test('an allowlisted call cannot be swapped for a different call site in the same file', (t) => {
  const life = testLifecycle(t)
  // Same file as an allowance, DIFFERENT expression: a per-file count would
  // excuse it; the file + normalized call-site key must not.
  const { root, path } = syntheticSource(life, 'gate-swap-', 'src/client/artifact/transcript-markdown.ts', 'export const events = session.snapshotEvents()\n')
  const offenders = scanDeprecatedReaders([path], { root })
  const { unallowed, stale } = classifyDeprecatedReaders(offenders)
  assert.equal(unallowed.length, 1, 'a renamed/moved call site must not be excused')
  assert.ok(stale.some(entry => entry.file === 'src/client/artifact/transcript-markdown.ts'), 'the original allowance is now stale')
})

test('the exact allowlisted call site is accepted and leaves no stale allowance', (t) => {
  const life = testLifecycle(t)
  const allowance = DEPRECATED_READER_ALLOWLIST.find(entry => entry.file === 'src/client/artifact/transcript-markdown.ts')
  assert.ok(allowance !== undefined)
  const { root, path } = syntheticSource(life, 'gate-allow-', allowance.file, `${allowance.site}\n`)
  const offenders = scanDeprecatedReaders([path], { root })
  const { unallowed, stale } = classifyDeprecatedReaders(offenders, [allowance])
  assert.deepEqual(unallowed, [])
  assert.deepEqual(stale, [])
})
