/**
 * Static audit for the host-keybinding gate (`scripts/check-host-keybindings.mts`,
 * plan §22/§18): the real production tree must satisfy both scans, the scanning
 * OWNER set must follow the host-interaction owner that TS5 moved out of the
 * facade, and the scans must be discriminating — a NEW hard-coded chord inside a
 * scanned interaction owner fails while the sanctioned focused-component /
 * approval fixed keys stay accepted. The gate is the enforcement; this test
 * guards its rule set and its coverage policy against regressions.
 * @module @xmoon76/dsh-pi-tui/host-keybindings-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOST_INTERACTION_FILES,
  SCOPED_STRING_ALLOWLIST,
  findHostChordViolations,
  findStringLabelViolations,
  scanHostKeybindingViolations,
  scannedStringFiles,
} from '../scripts/check-host-keybindings.mts'

const ROOT = process.cwd()

/** The host-interaction owner TS5 extracted out of the TuiApp facade. */
const APPROVAL_RUNTIME = 'src/tui/interaction/approval-runtime.ts'
const APPROVAL_RUNTIME_SOURCE = readFileSync(join(ROOT, APPROVAL_RUNTIME), 'utf8')

/** The TS4 approval panel (a focused-component fixed-key owner, NOT scanned). */
const APPROVAL_DIALOG = 'src/tui/panels/approval-dialog.ts'
const APPROVAL_DIALOG_SOURCE = readFileSync(join(ROOT, APPROVAL_DIALOG), 'utf8')

test('host-keybindings: the real production tree passes both scans', () => {
  const violations = scanHostKeybindingViolations(ROOT)
  assert.deepEqual(
    violations,
    [],
    `host-keybinding violation(s) — route the key through the keymap or record a sanctioned seam:\n${violations
      .map(v => `${v.file}:${v.line} [${v.kind}] ${v.text}`)
      .join('\n')}`,
  )
})

test('host-keybindings: the scanned owner set follows the moved interaction owner', () => {
  // The pre-TS5 set was the facade only. If the approval input owner left the
  // facade without joining the scanned set, its host chords would escape the
  // gate exactly as plan §18.1 forbids.
  assert.ok(
    HOST_INTERACTION_FILES.includes(APPROVAL_RUNTIME),
    `the approval interaction owner must be scanned: ${HOST_INTERACTION_FILES.join(', ')}`,
  )
  assert.ok(HOST_INTERACTION_FILES.includes('src/tui-app.ts'), 'the TuiApp facade remainder stays scanned')
})

test('host-keybindings: a NEW host chord in the moved owner FAILS (mutation control)', () => {
  const mutated = `${APPROVAL_RUNTIME_SOURCE}if (matchesKey(data, 'ctrl+x')) return { consume: true }\n`
  const violations = findHostChordViolations(APPROVAL_RUNTIME, mutated)
  assert.equal(violations.length, 1, 'the new ctrl+x host chord must be reported')
  assert.equal(violations[0].kind, 'host-chord')
  assert.match(violations[0].text, /matchesKey\(data, 'ctrl\+x'\)/)
  // The violation really points at the injected line, not an existing one.
  const injectedLine = mutated.split('\n').findIndex(line => line.includes("'ctrl+x'")) + 1
  assert.equal(violations[0].line, injectedLine)
})

test('host-keybindings: the sanctioned approval fixed keys stay accepted', () => {
  assert.deepEqual(
    findHostChordViolations(APPROVAL_RUNTIME, APPROVAL_RUNTIME_SOURCE),
    [],
    'the approval y/n/Esc/Ctrl+C fixed keys are a capturing-overlay contract, not host business shortcuts',
  )
})

test('host-keybindings: a focused component outside the owner set is not scanned', () => {
  // The question flow owns Ctrl+C while it is the seat occupant (the focused
  // component contract). Its chord is REAL, so the raw predicate flags it; the
  // gate only applies that predicate to the host-interaction owner set, so the
  // fixed key is accepted.
  const question = 'src/tui/interaction/question.ts'
  const source = readFileSync(join(ROOT, question), 'utf8')
  assert.ok(
    findHostChordViolations(question, source).length > 0,
    'the focused component really does carry a fixed chord',
  )
  assert.ok(!HOST_INTERACTION_FILES.includes(question))
  assert.deepEqual(
    scanHostKeybindingViolations(ROOT).filter(v => v.file === question),
    [],
    'the gate must not report a focused component’s own fixed key',
  )
})

test('host-keybindings: a hard-coded chord label in a user-facing string fails', () => {
  const violations = findStringLabelViolations('src/tui/interaction/question.ts', "const hint = 'Ctrl+O to fold'\n")
  assert.equal(violations.length, 1)
  assert.equal(violations[0].kind, 'string-label')
  assert.equal(violations[0].line, 1)
})

test('host-keybindings: the approval panel label seam stays accepted', () => {
  assert.deepEqual(findStringLabelViolations(APPROVAL_DIALOG, APPROVAL_DIALOG_SOURCE), [])
})

test('host-keybindings: the string scan enumerates every src/tui module (no file exemption)', () => {
  const files = scannedStringFiles(ROOT)
  // TS5 §18.1: the keybinding authority (incl. its recorder UI and the action
  // table) is enumerated like every other TUI module. There is no file- or
  // subtree-level exemption anywhere under `src/tui/**`.
  for (const covered of [
    'src/tui/keybindings/definitions.ts',
    'src/tui/keybindings/key-identity.ts',
    'src/tui/keybindings/hints.ts',
    'src/tui/keybindings/home-end-mode.ts',
    'src/tui/keybindings/config.ts',
    'src/tui/keybindings/ui/recorder.ts',
    'src/tui/keybindings/ui/list.ts',
    'src/tui/keybindings/ui/action-editor.ts',
    'src/tui/interaction/question.ts',
    'src/tui/footer/composer.ts',
  ]) {
    assert.ok(files.includes(covered), `${covered} must be string-scanned`)
  }
  assert.deepEqual(scannedStringFiles(ROOT).filter(f => !files.includes(f)), [])
})

test('host-keybindings: a NEW label anywhere in the authority tree FAILS', () => {
  // The authority files are scanned now, so a fresh hard-coded label there is
  // caught — including one on a line that is not a sanctioned machine row.
  const fresh = [
    'src/tui/keybindings/key-identity.ts',
    'src/tui/keybindings/ui/list.ts',
  ]
  for (const file of fresh) {
    const violations = findStringLabelViolations(file, "const hint = 'Ctrl+O to fold'\n")
    assert.equal(violations.length, 1, `${file}: a fresh chord label must be reported`)
    assert.equal(violations[0].kind, 'string-label')
  }
})

test('host-keybindings: the TS5 exceptions are owner- and line-scoped (fail closed)', () => {
  // Every TS5 row must be LIVE in its owning file (a stale row would be dead
  // weight) and must stay accepted there...
  assert.ok(SCOPED_STRING_ALLOWLIST.length > 0)
  for (const row of SCOPED_STRING_ALLOWLIST) {
    assert.ok(row.file.startsWith('src/tui/keybindings/'), `${row.file} must be a keybinding-authority owner`)
    assert.ok(scannedStringFiles(ROOT).includes(row.file), `${row.file} must be scanned`)
    const lines = readFileSync(join(ROOT, row.file), 'utf8').split('\n')
    assert.ok(lines.some(line => line.trim() === row.line), `${row.file}: the row must name a real line — ${row.line}`)
    assert.deepEqual(findStringLabelViolations(row.file, `${row.line}\n`), [], `${row.file}: the sanctioned row itself stays accepted`)
  }
  // ...while the SAME fragment stops matching as soon as the line changes: an
  // appended remappable label, an edited line, and the fragment copied into
  // another owner must all be re-flagged (the reviewer's discriminating controls).
  const first = SCOPED_STRING_ALLOWLIST[0]
  const last = SCOPED_STRING_ALLOWLIST[SCOPED_STRING_ALLOWLIST.length - 1]
  for (const row of [first, last]) {
    const appended = findStringLabelViolations(row.file, `${row.line} const hint = 'Ctrl+O to fold'\n`)
    assert.equal(appended.length, 1, `${row.file}: an appended remappable label must be re-flagged`)
    const edited = findStringLabelViolations(row.file, `${row.line} // edited\n`)
    assert.equal(edited.length, 1, `${row.file}: an edited exempted line must be re-flagged`)
  }
  // The exempted fragment in ANOTHER owner (inside the same keybinding tree and
  // outside it) is not covered: the exception names one file, not a substring.
  assert.equal(findStringLabelViolations('src/tui/keybindings/ui/list.ts', `${first.line}\n`).length, 1)
  assert.equal(findStringLabelViolations('src/tui/keybindings/ui/list.ts', `${last.line}\n`).length, 1)
  assert.equal(findStringLabelViolations('src/tui/footer/composer.ts', `${last.line}\n`).length, 1)
  // The mixed-content escape the reviewer probed (an exempted diagnostic line
  // with an ADDITIONAL remappable label appended) is no longer a bypass.
  assert.equal(
    findStringLabelViolations(
      'src/tui/keybindings/ui/recorder.ts',
      "return { key: undefined, message: 'Shift+Enter is reserved for inserting a newline. Ctrl+O to fold' }\n",
    ).length,
    1,
  )
})
