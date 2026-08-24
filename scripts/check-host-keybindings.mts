/**
 * The host-keybinding static gate (plan §22): Host BUSINESS code must not
 * reintroduce physical shortcuts. The gate scans the host input path for
 * `matchesKey(data, 'ctrl+…' / 'alt+…' / 'shift+…')` chord checks and
 * fails on any NEW one.
 *
 * Allowlist (focused-component / protocol seams — the plan's sanctioned
 * exceptions):
 * - the read-only subagent viewer guard (Esc + Ctrl+O pass through);
 * - the Ctrl+C exit-chord discriminator (the chord is Ctrl+C-specific);
 * - the approval dialog's own keys (a capturing overlay component).
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

/** The scanned host business files. */
const SCANNED_FILES = ['src/tui-app.ts']

/** The chord pattern: a matchesKey call with a ctrl/alt/shift modifier. */
const CHORD_PATTERN = /matchesKey\(\s*data\s*,\s*'(?:ctrl|alt|shift)\+/

/** The sanctioned seams (matched by trimmed line content). */
const ALLOWLIST = [
  // The read-only viewer guard: only Esc (exit) and Ctrl+O (fold) pass.
  "if (!matchesKey(data, 'escape') && !matchesKey(data, 'ctrl+o')) {",
  // The exit-chord discriminator: Ctrl+C keeps the clear-then-exit chord.
  "if (matchesKey(data, 'ctrl+c')) {",
  // The replacement-editor Enter seam (P1-10): a plugin editor receives
  // editor-routed input; Enter is forwarded to the hidden host editor and
  // Shift+Enter stays with the plugin (its own multiline editing).
  "&& matchesKey(data, 'enter') && !matchesKey(data, 'shift+enter')) {",
  // The replacement-editor DECLINED-event retry (Enter submits through the
  // normal host path after the plugin editor handed the event back).
  "if (matchesKey(data, 'enter') && !matchesKey(data, 'shift+enter')) {",
  // The continuable viewer's Enter submit (the CHILD is the target).
  "} else if (matchesKey(data, 'enter') && !matchesKey(data, 'shift+enter')) {",
  // The approval dialog's own keys (a capturing overlay component).
  "else if (matchesKey(data, 'ctrl+c')) this.settleApproval(pending, 'cancelled')",
]

let failures = 0
for (const file of SCANNED_FILES) {
  const path = join(process.cwd(), file)
  const lines = readFileSync(path, 'utf8').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (!CHORD_PATTERN.test(line)) continue
    if (ALLOWLIST.includes(line.trim())) continue
    failures += 1
    console.error(`check-host-keybindings: ${file}:${index + 1}: physical host shortcut — route through the keymap instead:\n  ${line.trim()}`)
  }
}

if (failures > 0) {
  console.error(`check-host-keybindings: ${failures} physical host shortcut(s) found (see docs/keybinding-architecture.md)`)
  process.exit(1)
}
console.log('check-host-keybindings: ok')
