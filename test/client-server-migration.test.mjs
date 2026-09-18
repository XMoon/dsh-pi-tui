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
} from '../scripts/check-no-session-events.mjs'
import { testLifecycle } from './support/temp-lifecycle.ts'

const MIGRATION_DOC = new URL('../docs/client-server-migration.md', import.meta.url)
const CI_WORKFLOW = new URL('../.github/workflows/ci.yml', import.meta.url)
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GATE_SCRIPT = join(REPO_ROOT, 'scripts', 'check-no-session-events.mjs')

test('migration status records the completed D1 and D2 parity gates', () => {
  const document = readFileSync(MIGRATION_DOC, 'utf8')
  assert.match(document, /M2\s+DONE\s+\(D1 COMPLETE:[^\n]*D1\.3[^\n]*D2\.1 DONE:[^\n]*D2\.2 DONE:[^\n]*D2\.3 DONE:[^\n]*D2\.4 DONE:[^\n]*D2 COMPLETE[^\n]*\)/u)
  assert.match(document, /D1\.1 is the first M2 slice\. It is complete for the experimental read surface/u)
  assert.match(document, /D1\.2 is complete for the experimental live-session authority read shadow/u)
  assert.match(document, /## D1\.3 status — Task and presentation read parity/u)
  assert.match(document, /session\.createdAt.*session\.live.*session\.measureContext.*subagent\.descendantTree/us)
  assert.doesNotMatch(document, /D1\.1 IN PROGRESS/u)
  assert.doesNotMatch(document, /D1\.1 is now in progress/iu)
})

test('D1.2 authority smoke is restricted to the Source Mode lane', () => {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8')
  assert.match(
    workflow,
    /- name: Remote command\/skill authority parity smoke\n\s+if: env\.DSH_MODE == 'source'\n\s+run: pnpm smoke:remote-surface-authority-parity/u,
  )
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

test('D1-D2 task, presentation, and closure smokes are Source Mode gates', () => {
  const workflow = readFileSync(CI_WORKFLOW, 'utf8')
  for (const [name, command] of [
    ['Remote task read parity smoke', 'smoke:remote-task-read-parity'],
    ['Remote presentation/history parity smoke', 'smoke:remote-presentation-parity'],
    ['D1 closure gate', 'smoke:remote-d1-closure'],
    ['Remote D2.2 ordinary-write same-Host smoke', 'smoke:remote-d2-write'],
    ['D2 closure smoke', 'smoke:remote-d2-closure'],
  ]) {
    assert.match(
      workflow,
      new RegExp(`- name: ${name}\\n\\s+if: env\\.DSH_MODE == 'source'\\n\\s+run: pnpm ${command}`),
    )
  }
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
  const { root, path } = syntheticSource(life, 'gate-swap-', 'src/transcript.ts', 'export const events = session.snapshotEvents()\n')
  const offenders = scanDeprecatedReaders([path], { root })
  const { unallowed, stale } = classifyDeprecatedReaders(offenders)
  assert.equal(unallowed.length, 1, 'a renamed/moved call site must not be excused')
  assert.ok(stale.some(entry => entry.file === 'src/transcript.ts'), 'the original allowance is now stale')
})

test('the exact allowlisted call site is accepted and leaves no stale allowance', (t) => {
  const life = testLifecycle(t)
  const allowance = DEPRECATED_READER_ALLOWLIST.find(entry => entry.file === 'src/transcript.ts')
  assert.ok(allowance !== undefined)
  const { root, path } = syntheticSource(life, 'gate-allow-', allowance.file, `${allowance.site}\n`)
  const offenders = scanDeprecatedReaders([path], { root })
  const { unallowed, stale } = classifyDeprecatedReaders(offenders, [allowance])
  assert.deepEqual(unallowed, [])
  assert.deepEqual(stale, [])
})
