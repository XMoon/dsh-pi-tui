/**
 * The host-keybinding static gate (plan §22): Host BUSINESS code must not
 * reintroduce physical shortcuts. The gate scans the host input path for
 * `matchesKey(data, 'ctrl+…' / 'alt+…' / 'shift+…')` chord checks and
 * fails on any NEW one; it also scans USER-FACING string literals for
 * hard-coded chord labels (a remap would make the string lie — key labels
 * must come from the keymap's keyHint/keysFor).
 *
 * The user-facing string scan enumerates EVERY production module under
 * `src/tui/**` recursively and exempts only individual POSITIONS: the
 * keybinding authority's machine-readable key vocabulary (the KeyId grammar
 * tables, the canonical label map, the pi-tui binding presets, the shared
 * terminal-ambiguous inventory) and the diagnostics that NAME a fixed key.
 * Those rows are scoped to their owning FILE and their EXACT trimmed line, and
 * they fail closed: editing the line, appending a label to it, or reusing the
 * fragment in another owner all drop the exemption and re-flag it.
 *
 * Allowlist (focused-component / protocol seams — the plan's sanctioned
 * exceptions):
 * - the read-only subagent viewer guard (Esc + Ctrl+O pass through);
 * - the approval dialog's own keys (a capturing overlay component);
 * - the replacement-editor Enter seams (a plugin editor owns Shift+Enter);
 * - `Ctrl+Home/End` in the Home/End settings row (fork editor-level keys,
 *   not Host actions — they do not follow the keymap).
 *
 * The vendored fork's editor, the InputRouter's precedence checks, the
 * focused components (question/tasks — now routed through the component
 * keymap) and the leader machine are NOT host business shortcuts.
 *
 * Usage: `node scripts/check-host-keybindings.mjs` (built by tsdown) or
 * `node --import tsx/esm scripts/check-host-keybindings.mts`.
 * @module @xmoon76/dsh-pi-tui/check-host-keybindings
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { listSourceFilesUnder } from './application-architecture-gate.mjs'

/** The scanned host business files: the facade remainder plus the interaction
 * owners that moved out of it in TS5. The set follows the OWNER — a new
 * host-business chord inside `src/tui/interaction/**` must still fail — while
 * focused components (their own fixed keys) stay governed by the component
 * contract and are deliberately NOT scanned wholesale. The InputRouter's
 * precedence fallbacks are likewise not host business shortcuts. */
export const HOST_INTERACTION_FILES = [
  'src/tui-app.ts',
  'src/tui/interaction/approval-runtime.ts',
]

/**
 * The application composition zone's user-facing strings (TS2 §21): the facade
 * plus EVERY source file RECURSIVELY under `src/app/bootstrap/` — the whole
 * `src/app/bootstrap/**` zone, over the same four production extensions the
 * architecture gate scans. The shared recursive enumeration is deterministic
 * (sorted), so a user-facing string (or a hard-coded chord) that lands in a
 * NESTED composition helper stays covered instead of silently escaping the
 * chord-label gate.
 */
const BOOTSTRAP_ZONE = 'src/app/bootstrap'

/** The chord pattern: a matchesKey call with a ctrl/alt/shift modifier. */
const CHORD_PATTERN = /matchesKey\(\s*data\s*,\s*'(?:ctrl|alt|shift)\+/

/** A chord label inside a quoted string literal (user-facing text).
 * Matches BOTH casing styles ('Ctrl+O' and 'ctrl+o' — the fold hints
 * used the lowercase form and slipped past the gate once) and ALL THREE
 * quote styles (single, double, backtick — convergence §14: a remap lies
 * whichever quoting the string uses). */
const STRING_CHORD_PATTERN = /(?:'[^'\\]*|"[^"\\]*|`[^`\\]*)(?:(?:Ctrl|Alt|Shift)|(?:ctrl|alt|shift))\+/

/** The sanctioned seams (matched by trimmed line content). */
const ALLOWLIST = [
  // The read-only viewer guard: only Esc (exit) and Ctrl+O (fold) pass.
  "if (!matchesKey(data, 'escape') && !matchesKey(data, 'ctrl+o')) {",
  // The replacement-editor Enter seam (P1-10): a plugin editor receives
  // editor-routed input; Enter is forwarded to the hidden host editor and
  // Shift+Enter stays with the plugin (its own multiline editing).
  "&& matchesKey(data, 'enter') && !matchesKey(data, 'shift+enter')) {",
  // The replacement-editor DECLINED-event retry (Enter submits through the
  // normal host path after the plugin editor handed the event back).
  "if (matchesKey(data, 'enter') && !matchesKey(data, 'shift+enter')) {",
  // The continuable viewer's Enter submit (the CHILD is the target).
  "} else if (matchesKey(data, 'enter') && !matchesKey(data, 'shift+enter')) {",
  // The approval runtime's own keys (a capturing-overlay component contract,
  // TS5 §8.3 moved them out of the facade with their owner).
  "else if (matchesKey(data, 'ctrl+c')) this.settle(pending, 'cancelled')",
  // The SAME approval-overlay seam reached through the modal-inspection
  // precedence check (`ownsFixedKey`, which must beat a conflicting
  // inspection remap). Its `y`/`n`/`escape` checks carry no chord and are not
  // scanned; the bare continuation is the overlay's own Ctrl+C.
  "|| matchesKey(data, 'ctrl+c')",
  // The effective-submit mirror (PR review): the host-owned seams exclude
  // Shift+Enter (the fork editor's newline) from the submit-key check —
  // an editor-level key, not a Host action.
  "if (matchesKey(data, 'shift+enter')) return false",
]

/** The sanctioned hard-coded key labels in user-facing strings: fork
 * editor-level keys and capturing-overlay fixed keys that do not follow
 * the Host keymap. */
/** The PRE-TS5 substring exceptions: matched against the trimmed line in ANY
 *  file (a documented legacy seam — fork editor-level keys, capturing-overlay
 *  fixed keys, semantic key-id comparisons). These rows pre-date TS5 and are
 *  kept verbatim; a NEW exception must NOT use this global form. */
const STRING_ALLOWLIST = [
  // The Home/End settings row describes the fork EDITOR's Ctrl+Home/End —
  // an editor-level key, not a Host action (does not follow the keymap).
  'Ctrl+Home/End',
  // The approval dialog's own fixed keys (a capturing overlay component
  // that owns y/n/Esc/Ctrl+C while it is up — never resolved by the
  // keymap).
  '[esc/ctrl+c] cancel',
  // The exit path's key-id comparison is semantic behavior, not UI copy.
  "clearsDraft: key === 'ctrl+c'",
  // The default Ctrl+D editor-ownership branch is semantic routing, not UI copy.
  "key === 'ctrl+d'",
  // Dynamic exit-confirmation labels are intentionally not allowlisted.
]

/**
 * TS5 §18.1 exceptions for the keybinding AUTHORITY tree (now enumerated
 * recursively with every other `src/tui/**` module): the machine-readable key
 * vocabulary and the diagnostics that NAME a fixed key — never a rendered
 * label. Each row is scoped to its OWNING FILE and the EXACT trimmed source
 * line, so an edited line (an appended remappable label included), a
 * whitespace/quote change, or the same fragment appearing in another owner
 * stops matching and is re-flagged. The classifier keeps scanning every other
 * literal on every other line.
 */
export const SCOPED_STRING_ALLOWLIST: ReadonlyArray<{ readonly file: string; readonly line: string }> = [
  // (1) The canonical KeyId GRAMMAR tables (`key-identity.ts`): the machine key
  // inventories the resolver/decoder switch on.
  { file: 'src/tui/keybindings/key-identity.ts', line: "'up', 'down', 'left', 'right', 'ctrl+b', 'ctrl+f'," },
  { file: 'src/tui/keybindings/key-identity.ts', line: "'alt+left', 'ctrl+left', 'alt+b', 'alt+right', 'ctrl+right', 'alt+f'," },
  { file: 'src/tui/keybindings/key-identity.ts', line: "'home', 'ctrl+home', 'ctrl+a', 'end', 'ctrl+end', 'ctrl+e'," },
  { file: 'src/tui/keybindings/key-identity.ts', line: "'pageUp', 'ctrl+pageUp', 'pageDown', 'ctrl+pageDown'," },
  { file: 'src/tui/keybindings/key-identity.ts', line: "'ctrl+]', 'ctrl+alt+]'," },
  { file: 'src/tui/keybindings/key-identity.ts', line: "'backspace', 'shift+backspace', 'delete', 'shift+delete', 'ctrl+d'," },
  { file: 'src/tui/keybindings/key-identity.ts', line: "'ctrl+w', 'alt+backspace', 'alt+d', 'alt+delete'," },
  { file: 'src/tui/keybindings/key-identity.ts', line: "'ctrl+u', 'ctrl+k', 'ctrl+y', 'alt+y', 'ctrl+-'," },
  { file: 'src/tui/keybindings/key-identity.ts', line: "'shift+enter', 'ctrl+j', 'enter', 'tab', 'escape', 'ctrl+c'," },
  { file: 'src/tui/keybindings/key-identity.ts', line: "['up', 'down', 'left', 'right', 'ctrl+b', 'ctrl+f'," },
  { file: 'src/tui/keybindings/key-identity.ts', line: "'pageUp', 'ctrl+pageUp', 'pageDown', 'ctrl+pageDown'," },
  { file: 'src/tui/keybindings/key-identity.ts', line: "'ctrl+]', 'ctrl+alt+]', 'enter', 'escape']" },
  // (2) The shared terminal-ambiguous key INVENTORY (`config.ts`) the parser
  // canonicalizes (`TERMINAL_AMBIGUOUS_KEY_IDS`): machine tokens, never rendered.
  { file: 'src/tui/keybindings/config.ts', line: "['ctrl+[', 'ctrl+j', 'ctrl+m', 'ctrl+i', 'ctrl+h', 'ctrl+_', 'ctrl+-', 'ctrl+backspace'].map(key => canonicalizeKeyId(key as KeyId))," },
  // (3) Semantic pre-submit comparisons over a FIXED editor key (`config.ts`).
  { file: 'src/tui/keybindings/config.ts', line: "if (actionId === 'app.input.submit' && canonicalEntry === 'shift+enter') {" },
  // (4) User-facing diagnostics that NAME fixed terminal/editor keys (the same
  // sanctioned category as the approval dialog's `[esc/ctrl+c] cancel`): the copy
  // explains a fixed key instead of rendering a remappable binding label.
  { file: 'src/tui/keybindings/config.ts', line: "diagnostics.push('keybindings: \"app.input.submit\" cannot bind Shift+Enter — it is the editor newline key — ignored')" },
  { file: 'src/tui/keybindings/config.ts', line: "diagnostics.push(`keybindings: \"${actionId}\" cannot bind \"${entry}\" — it collides with a fixed key on legacy terminals (Ctrl+[ is Esc; Ctrl+J/M is Enter; Ctrl+I/H are Tab/Backspace; Ctrl+_ and Ctrl+- are one key; Ctrl+Backspace is Backspace on legacy, Ctrl+Backspace on Windows Terminal) — ignored`)" },
  // (5) The KeyId → human label map (`hints.ts`): the label AUTHORITY itself —
  // it IS what `keyHint()` renders, so its own spelling cannot be a stale copy.
  { file: 'src/tui/keybindings/hints.ts', line: "'ctrl+[': 'Ctrl+['," },
  // (6) The pi-tui viewport binding PRESETS (`home-end-mode.ts`): machine binding
  // values, not rendered copy.
  { file: 'src/tui/keybindings/home-end-mode.ts', line: "'tui.altScreen.top': mode === 'input' ? 'ctrl+home' : 'home'," },
  { file: 'src/tui/keybindings/home-end-mode.ts', line: "'tui.altScreen.bottom': mode === 'input' ? 'ctrl+end' : 'end'," },
  // (7) The keybinding editor recorder (`ui/recorder.ts`): the fixed-editor-key
  // comparison and the message it returns for that one key.
  { file: 'src/tui/keybindings/ui/recorder.ts', line: "if (key === 'shift+enter') {" },
  { file: 'src/tui/keybindings/ui/recorder.ts', line: "return { key: undefined, message: 'Shift+Enter is reserved for inserting a newline.' }" },
]

/** One detected violation (a host chord or a hard-coded label). */
export interface KeybindingViolation {
  readonly file: string
  readonly line: number
  readonly text: string
  readonly kind: 'host-chord' | 'string-label'
}

/**
 * The host-business chord violations in one source file: a `matchesKey` call
 * with a ctrl/alt/shift modifier that is not one of the sanctioned seams. This
 * is the part-A scan; it is NOT applied to focused components' fixed keys.
 * @param file - the src-relative path (for reporting).
 * @param source - the file contents.
 */
export function findHostChordViolations(file: string, source: string): KeybindingViolation[] {
  const out: KeybindingViolation[] = []
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!CHORD_PATTERN.test(line)) continue
    if (ALLOWLIST.includes(line.trim())) continue
    out.push({ file, line: index + 1, text: line.trim(), kind: 'host-chord' })
  }
  return out
}

/**
 * The hard-coded user-facing chord-label violations in one source file. This is
 * the part-B scan: a chord label inside a quoted string literal lies as soon as
 * the user remaps it (the label must come from keyHint/keysFor).
 * @param file - the src-relative path (for reporting).
 * @param source - the file contents.
 */
export function findStringLabelViolations(file: string, source: string): KeybindingViolation[] {
  const out: KeybindingViolation[] = []
  const lines = source.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    // Skip comment-only lines (comments are covered by the convention in
    // docs/keybinding-architecture.md, not by this mechanical check).
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue
    // The keybinding table's `defaultKeys` arrays are the machine-readable
    // source of truth (not user-facing copy) — a hard-coded chord there
    // is the DEFINITION, not a lie. Only the table's `description`
    // strings are user-facing and must stay key-neutral.
    if (trimmed.startsWith('defaultKeys:')) continue
    // Strip matchesKey CALLS (key-matching code, not user-facing copy) — a
    // hard-coded chord string elsewhere on the SAME line must still be
    // caught (a whole-line skip could hide it).
    const stripped = line.replace(/matchesKey\(\s*data\s*,\s*'[^']*'\)/g, '')
    if (!STRING_CHORD_PATTERN.test(stripped)) continue
    if (STRING_ALLOWLIST.some(label => line.includes(label))) continue
    // TS5 rows are scoped to the owning file AND the exact trimmed line.
    if (SCOPED_STRING_ALLOWLIST.some(entry => entry.file === file && entry.line === trimmed)) continue
    out.push({ file, line: index + 1, text: trimmed, kind: 'string-label' })
  }
  return out
}

/**
 * The checked user-facing string files for one repository root.
 *
 * The TUI scan is RECURSIVE over `src/tui/**` (TS4 §44, extended by TS5 §18.1 to
 * the whole tree, including every module TS5 moved under it): a user-facing
 * string (or a hard-coded chord) that lands in a moved panel/picker/leaf/
 * interaction/keybinding/footer/notification module stays covered instead of
 * silently escaping the chord-label gate. `src/tui/commands/**` is subsumed and
 * NOT re-added, and there is NO file- or subtree-level exemption: the machine
 * vocabulary and the fixed-key diagnostics inside the keybinding authority are
 * exempted POSITION by POSITION in `STRING_ALLOWLIST`.
 */
export function scannedStringFiles(root: string = process.cwd()): string[] {
  const tui = listSourceFilesUnder(join(root, 'src/tui'))
    .map(rel => `src/tui/${rel}`)
  const bootstrap = [
    `${BOOTSTRAP_ZONE}.ts`,
    ...listSourceFilesUnder(join(root, BOOTSTRAP_ZONE)).map(rel => `${BOOTSTRAP_ZONE}/${rel}`),
  ]
  return [
    'src/index.ts',
    ...bootstrap,
    'src/commands.ts',
    ...tui,
    'src/tui-app.ts',
    'src/local-shell-card.ts',
    // TS5 moved the footer's user-facing instruction text under `src/tui/**`,
    // which `TUI_STRING_FILES` already enumerates recursively, so the explicit
    // old footer path is retired.
  ]
}

/** Scan one repository root for every host-keybinding violation. */
export function scanHostKeybindingViolations(root: string = process.cwd()): KeybindingViolation[] {
  const out: KeybindingViolation[] = []
  for (const file of HOST_INTERACTION_FILES) {
    out.push(...findHostChordViolations(file, readFileSync(join(root, file), 'utf8')))
  }
  for (const file of scannedStringFiles(root)) {
    out.push(...findStringLabelViolations(file, readFileSync(join(root, file), 'utf8')))
  }
  return out
}

function main(): void {
  const violations = scanHostKeybindingViolations()
  for (const v of violations) {
    if (v.kind === 'host-chord') {
      console.error(`check-host-keybindings: ${v.file}:${v.line}: physical host shortcut — route through the keymap instead:\n  ${v.text}`)
    } else {
      console.error(`check-host-keybindings: ${v.file}:${v.line}: hard-coded key label in a user-facing string — use keyHint()/keysFor() instead:\n  ${v.text}`)
    }
  }
  if (violations.length > 0) {
    console.error(`check-host-keybindings: ${violations.length} violation(s) found (see docs/keybinding-architecture.md)`)
    process.exit(1)
  }
  console.log('check-host-keybindings: ok')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
