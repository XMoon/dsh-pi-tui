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
const SURFACE_DECISIONS_DOC = new URL('../docs/surface-decisions.md', import.meta.url)
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
    ['D2 closure smoke', 'smoke:remote-d2-closure'],
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
})

test('M3-5 PR6 stage closure and the final M3 closure record', () => {
  const migration = readFileSync(MIGRATION_DOC, 'utf8')
  const surface = readFileSync(SURFACE_DECISIONS_DOC, 'utf8')

  // Stage closure. The canonical `### Migration stage pointer` block AND the
  // top status header must both record the FINAL M3 DONE / M4 NOT STARTED
  // state; duplicate summary markers elsewhere must not satisfy this lock.
  const pointerMatch = migration.match(/### Migration stage pointer\n+```text\n([\s\S]*?)```/u)
  assert.ok(pointerMatch !== null, 'the canonical Migration stage pointer block must exist')
  const pointer = pointerMatch[1]
  assert.match(pointer, /^M3-5 = DONE\b/mu, 'the stage pointer must record M3-5 DONE')
  assert.match(pointer, /^M3-6 = DONE\b/mu, 'the stage pointer must record M3-6 DONE')
  assert.match(pointer, /^M4\s+= NOT STARTED\b/mu, 'the stage pointer must record M4 NOT STARTED')
  assert.doesNotMatch(pointer, /^M3-6 = IN PROGRESS\b/mu, 'the stage pointer must not keep M3-6 in progress')
  assert.doesNotMatch(pointer, /^M3-5 = IN PROGRESS\b/mu, 'the stage pointer must not regress M3-5 to IN PROGRESS')
  assert.match(migration, /^M3-5 DONE\b/mu, 'the status header must record M3-5 DONE')
  assert.match(migration, /^M3-6 PR4 DONE\b/mu, 'the status header must record the landed PR4')
  assert.match(migration, /^M3-6 DONE\b/mu, 'the status header must record M3-6 DONE')
  assert.match(migration, /^M3 DONE\b/mu, 'the status header must record M3 DONE')
  assert.doesNotMatch(migration, /^M3-5 IN PROGRESS\b/mu, 'the status header must not regress M3-5')
  assert.doesNotMatch(migration, /^M3-6 IN PROGRESS\b/mu, 'the stale M3-6 IN PROGRESS marker must be gone')
  assert.doesNotMatch(migration, /^M3-6 PR\d = NEXT\b/mu, 'no M3-6 PR may remain NEXT once M3 is closed')

  // The M3 closure record: the four axes, the delivered implementation, the
  // unchanged production backend, the intentional leftovers and the Next state.
  const closureMatch = migration.match(/## M3 closure\n+```text\n([\s\S]*?)```/u)
  assert.ok(closureMatch !== null, 'the M3 closure record must exist')
  const record = closureMatch[1]
  for (const axis of ['Contract', 'Implementation', 'Qualification', 'Surface / Reachability']) {
    assert.match(record, new RegExp(`^${axis}$`, 'mu'), `the closure record must carry the ${axis} axis`)
  }
  assert.match(record, /M3-1\.\.M3-6 delivered/u, 'the closure record names the delivered stages')
  assert.match(record, /production backend: Direct/u, 'Direct stays the production backend')
  assert.match(record, /experimental backend: in-process official wire/u, 'the wire stays experimental')
  assert.match(record, /no M4 IPC\/TCP/u, 'no M4 IPC/TCP may exist yet')
  assert.match(record, /no public external attach/u, 'external attach is still unsupported')
  assert.match(record, /no production backend flip/u, 'the production backend never flipped')
  assert.match(record, /Intentional leftovers/u, 'remaining obligations carry explicit owners')
  for (const id of ['R6', 'U2', 'U12', 'U13']) {
    assert.match(record, new RegExp(`${id}\\b`, 'u'), `the closure record disposes ${id}`)
  }
  assert.match(record, /^Next\n  M4 NOT STARTED$/mu, 'the closure record ends with M4 NOT STARTED')

  // M4-M8 remain NOT STARTED in the top status header.
  for (const stage of ['M4', 'M5', 'M6', 'M7', 'M8']) {
    assert.match(migration, new RegExp(`^${stage}\\s+NOT STARTED`, 'mu'), `${stage} must remain NOT STARTED`)
  }

  // The PR1 migration section records the Client Context extension owner, the
  // absent Host fallback, and the reconnect work that followed it.
  const pr1Section = migration.slice(migration.indexOf('### M3-6 PR1 — Client UI / Extension locality (DONE)'))
  assert.ok(pr1Section.length > 0 && pr1Section.length < migration.length, 'the M3-6 PR1 section must exist')
  assert.match(pr1Section, /PiTuiExtensionService/, 'the PR1 section names the extension service')
  assert.match(pr1Section, /never evaluates the Host lookup/u,
    'the PR1 section records the absent Host fallback on the Remote branch')
  assert.doesNotMatch(pr1Section, /M3-6 PR2 = NEXT/u, 'the PR1 tail must not read as an open NEXT marker')
  assert.match(pr1Section, /full-surface reconnect recovery/u, 'the PR1 section records the reconnect work')

  // Merged-PR bookkeeping: the merged PR3/PR5 must never read as still open.
  for (const line of migration.split('\n')) {
    if (/\bPR3\b/u.test(line) || /\bPR5\b/u.test(line)) {
      assert.doesNotMatch(line, /PR open/iu, `a merged M3-5 PR still reads as open: ${line.trim()}`)
    }
  }

  // The stale PR5 tail must record the delivered/requalified child image.
  assert.doesNotMatch(migration, /finish the child durable[- ]image/iu,
    'the stale "finish the child durable image" PR5 tail must be corrected')
  assert.match(migration, /already delivered by PR2/iu, 'child durable image: delivered-by-PR2 record')
  assert.match(migration, /requalified by PR6/iu, 'child durable image: PR6 requalification record')

  // Queue per-occurrence UI is a CURRENT PRODUCT GAP owned by Post-M3 Q1; the
  // stale "expected, not a gap" framing is gone.
  assert.match(surface, /CURRENT PRODUCT GAP/u, 'queue per-occurrence UI must be a current product gap')
  assert.match(surface, /Post-M3 Q1/u, 'the queue gap must carry its Post-M3 Q1 owner')
  assert.doesNotMatch(surface, /expected, not a gap/iu, 'the stale "expected, not a gap" wording must be removed')
  assert.doesNotMatch(migration, /expected, not a gap/iu, 'the stale wording must be absent from the migration doc too')
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
