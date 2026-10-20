/**
 * The design-language machine checks (`docs/architecture/design-language.md` §11.3.1).
 *
 * Two things are cheap enough to enforce and expensive to get wrong:
 *
 * 1. **Width safety.** Every glyph the design language introduces as chrome must
 *    measure ONE cell under the fork's `visibleWidth()` AND carry an
 *    East-Asian-Width class that CJK-width terminals (VTE/WezTerm
 *    `cjk-ambiguous-width`) also paint as one cell. The icon registry already
 *    guards its own glyphs (`test/domain/icons.test.ts`); this file guards the chrome
 *    inventory (cursor, active brackets, status marker, disclosure, notice
 *    prefixes). The precondition is real, not theoretical: an ambiguous glyph
 *    measures 1 and paints 2, which silently shifts every right-aligned group.
 * 2. **One glyph, one meaning.** A canonical chrome glyph must not also be an
 *    icon-registry glyph, unless the design language deliberately assigns both
 *    roles to it (only the disclosure pair). This is the check that would have
 *    caught the status marker being drawn with the transcript's assistant
 *    bullet.
 *
 * The glyphs the design language GRANDFATHERS (already painted across the
 * chrome before v1, see §4.3) are listed here as exempt so the exemption is
 * explicit rather than accidental.
 * @module @xmoon76/dsh-pi-tui/design-language.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { eastAsianWidthType } from 'get-east-asian-width'
import { ALL_ICON_SEMANTICS, type IconStyle } from '../../src/domain/display/icons.ts'
import { iconFor } from '../../src/tui/icons.ts'
import { assertBodyFloor, assertOneActiveDevice, type PaintedFrame } from '../support/design-language-frames.ts'

/** The EAW classes that are safe under CJK-width terminals (same set the icon
 *  registry gate uses). */
const SAFE_EAW: ReadonlySet<string> = new Set(['neutral', 'narrow', 'halfwidth'])

/** The chrome glyph inventory of `docs/architecture/design-language.md` §4.4 that MUST be
 *  width-safe. The current-value arrow `←` is deliberately NOT here: it is
 *  ambiguous and grandfathered (§4.3). The three `← current` marks were retired
 *  by the Settings and picker PRs, but the glyph is still painted in TWO places
 *  — the question flow's chrome hints and the keybindings UI's `←→: edit` hint
 *  (§11.4) — and for those hints every neutral substitute either collides with
 *  another role or reads as something else. */
const CANONICAL_CHROME_GLYPHS: ReadonlyArray<readonly [role: string, glyph: string]> = [
  ['navigation cursor', '>'],
  ['active/current label brackets', '['],
  ['active/current label brackets', ']'],
  ['status marker', '‣'],
  ['disclosure collapsed', '▸'],
  ['disclosure expanded', '▾'],
  ['notice info prefix', 'ℹ'],
  ['notice error prefix', '✗'],
]

/** The roles the design language deliberately shares with the icon registry:
 *  the same disclosure semantic paints the same glyph in a card and in chrome. */
const SHARED_WITH_ICON_REGISTRY: ReadonlySet<string> = new Set(['▸', '▾'])

/** Glyphs the design language GRANDFATHERS: already painted across the chrome
 *  before v1 (so they are outside its "no new ambiguous glyph" rule), measured
 *  in §4.3. They are listed so the exemption cannot be widened silently. */
const GRANDFATHERED_AMBIGUOUS: ReadonlyArray<readonly [glyph: string, where: string]> = [
  ['─', 'every rule and the editor border'],
  ['·', 'the fact/hint separator'],
  ['↗', 'the Job command affordance'],
  ['←', 'the question flow chrome hints and the keybindings UI `←→: edit` hint (the `← current` marks were retired by PR5)'],
  ['▼', 'the hardcoded sub-call/workflow disclosure'],
  ['▶', 'the hardcoded sub-call/workflow disclosure'],
  ['◆', 'the footer configurator move-mode marker'],
  ['▏', 'the footer configurator text-edit cursor'],
  ['⇧', 'the task browser Tab hint'],
  ['×', 'the task browser failure glyph'],
  ['○', 'per-status glyphs'],
  ['◐', 'per-status glyphs'],
  ['●', 'per-status glyphs'],
]

/** Per-status glyphs that are EAW-**ambiguous**: they measure 1 and paint 2
 *  under `cjk-ambiguous-width`, which is one of the two reasons the design
 *  language allows exactly one status marker (D5+D7). */
const WIDTH_UNSAFE_STATUS_GLYPHS: readonly string[] = ['●', '○', '◐', '×', '⏳']

/** Per-status glyphs that are width-SAFE and are rejected anyway, because a
 *  second glyph vocabulary makes the shape — not the written word — the thing a
 *  reader learns (D5+D7). Kept as data so the rule stays falsifiable and so the
 *  reason does not get "simplified" into a width claim it cannot support. */
const WIDTH_SAFE_BUT_REJECTED_STATUS_GLYPHS: readonly string[] = ['✓', '✕', '⊘']

test('the ambiguous per-status glyphs really are unsafe, and the one shared marker is not among them', () => {
  for (const glyph of WIDTH_UNSAFE_STATUS_GLYPHS) {
    const type = eastAsianWidthType(glyph.codePointAt(0)!)
    assert.ok(!SAFE_EAW.has(type),
      `rejected status glyph ${JSON.stringify(glyph)} is now EAW ${type}; revisit decision D5/D7 before using it`)
  }
  assert.ok(!WIDTH_UNSAFE_STATUS_GLYPHS.includes('‣'),
    'the one shared status marker must never be listed as a rejected per-status glyph')
})

test('the width-safe per-status glyphs are still excluded from the chrome inventory', () => {
  for (const glyph of WIDTH_SAFE_BUT_REJECTED_STATUS_GLYPHS) {
    const type = eastAsianWidthType(glyph.codePointAt(0)!)
    assert.ok(SAFE_EAW.has(type),
      `${JSON.stringify(glyph)} is now EAW ${type}: move it to the ambiguous list (the width argument changed)`)
    assert.ok(!CANONICAL_CHROME_GLYPHS.some(([, entry]) => entry === glyph),
      `${JSON.stringify(glyph)} is width-safe but must not be adopted as a per-status marker (D5+D7)`)
  }
  assert.deepEqual(
    [...WIDTH_UNSAFE_STATUS_GLYPHS, ...WIDTH_SAFE_BUT_REJECTED_STATUS_GLYPHS].sort(),
    ['×', '✓', '✕', '⊘', '○', '◐', '●', '⏳'].sort(),
    'the rejected-status-glyph sets changed: update docs/architecture/design-language.md §4.1 in the same PR',
  )
})

test('every canonical chrome glyph is one cell and safe under CJK-ambiguous width', () => {
  for (const [role, glyph] of CANONICAL_CHROME_GLYPHS) {
    assert.equal(visibleWidth(glyph), 1, `${role} glyph ${JSON.stringify(glyph)} must measure 1 cell`)
    const type = eastAsianWidthType(glyph.codePointAt(0)!)
    assert.ok(SAFE_EAW.has(type),
      `${role} glyph ${JSON.stringify(glyph)} must be EAW neutral/narrow/halfwidth (got ${type}); `
      + 'an ambiguous glyph measures 1 cell and paints 2 under cjk-ambiguous-width')
  }
})

test('the canonical chrome inventory uses one glyph per meaning', () => {
  const seen = new Map<string, string>()
  for (const [role, glyph] of CANONICAL_CHROME_GLYPHS) {
    const previous = seen.get(glyph)
    assert.ok(previous === undefined || previous === role,
      `glyph ${JSON.stringify(glyph)} is assigned to both ${previous} and ${role}`)
    seen.set(glyph, role)
  }
})

test('no canonical chrome glyph is also an icon-registry glyph (except the shared disclosure)', () => {
  const styles: readonly IconStyle[] = ['emoji', 'symbols', 'minimal']
  for (const [role, glyph] of CANONICAL_CHROME_GLYPHS) {
    if (SHARED_WITH_ICON_REGISTRY.has(glyph)) continue
    for (const style of styles) {
      for (const semantic of ALL_ICON_SEMANTICS) {
        if (iconFor(semantic, style) !== glyph) continue
        assert.fail(`chrome glyph ${JSON.stringify(glyph)} (${role}) is also the ${style} icon for `
          + `${semantic}; one glyph must not carry two meanings in one family`)
      }
    }
  }
})

test('the grandfathered ambiguous list is stable', () => {
  // The list is documentation-as-data: it must not silently grow, and every
  // entry must really be ambiguous (otherwise it belongs in the canonical set).
  for (const [glyph] of GRANDFATHERED_AMBIGUOUS) {
    const type = eastAsianWidthType(glyph.codePointAt(0)!)
    assert.ok(!SAFE_EAW.has(type), `grandfathered glyph ${JSON.stringify(glyph)} is EAW ${type}: move it to the canonical set`)
  }
  assert.equal(GRANDFATHERED_AMBIGUOUS.length, 13,
    'the grandfathered list changed: update docs/architecture/design-language.md §4.3 in the same PR')
  assert.ok(!CANONICAL_CHROME_GLYPHS.some(([, glyph]) => GRANDFATHERED_AMBIGUOUS.some(([other]) => other === glyph)),
    'a glyph cannot be both canonical (must be safe) and grandfathered (may be ambiguous)')
})

// ── §11.3.2 frame-helper controls (pure synthetic rows, no harness) ─────────
//
// The matrix tests call these two helpers on REAL painted frames; these controls
// pin the helpers' own proof scope so a future "simplification" cannot turn them
// back into a shape classifier or an index-only check and stay green.

/** The ink the synthetic frames paint the active device with. */
const PRIMARY = 0x11_22_33
const WARNING = 0x44_55_66

/** A synthetic frame whose `readColor` is an explicit `row:col` → ink map. */
function syntheticFrame(rows: readonly string[], colors: ReadonlyMap<string, number>): PaintedFrame {
  return {
    rows,
    readColor: (row, col) => colors.get(`${row}:${col}`),
    primaryRgb: PRIMARY,
  }
}

test('assertOneActiveDevice counts only the declared chrome label, never a primary key badge or a body bracket', () => {
  for (const affordance of ['Copy All [Enter]', 'Copy All [Ctrl+F]']) {
    const rows = [
      '[Output]  Command ─────',
      affordance,
      '[Error] host bracket text',
    ]
    const badgeAt = rows[1]!.indexOf('[')
    const colors = new Map<string, number>([
      ['0:0', PRIMARY],           // the active `[Output]` device
      [`1:${badgeAt}`, PRIMARY],  // the key badge is legitimately primary inside the affordance (§7.1)
      ['2:0', WARNING],           // Host body text carries its own colour
    ])
    const device = assertOneActiveDevice(syntheticFrame(rows, colors), {
      rows: [0, 1],               // chrome rows only: the body row is NOT scanned
      labelPrefixes: ['[Output]', '[Command]'],
    })
    assert.deepEqual(device, ['[Output]'],
      `the affordance ${JSON.stringify(affordance)} must not become a second active device`)
  }
})

test('assertOneActiveDevice rejects a second DECLARED chrome device painted primary', () => {
  const rows = ['[Output]  [Command] ─────', '↑↓ select · Esc close']
  const commandAt = rows[0]!.indexOf('[Command]')
  const colors = new Map<string, number>([['0:0', PRIMARY], [`0:${commandAt}`, PRIMARY]])
  assert.throws(
    () => assertOneActiveDevice(syntheticFrame(rows, colors), { rows: [0], labelPrefixes: ['[Output]', '[Command]'] }),
    /at most ONE chrome active device/,
    'two declared chrome labels painted primary must fail the invariant',
  )
})

test('assertOneActiveDevice counts PAINTED devices: the same label painted twice is two', () => {
  // A layout regression that paints the active label twice — `[Output]  [Output]` —
  // breaks §11.3.2 exactly like two different labels do. Counting distinct NAMES, or
  // reading only the first occurrence, silently accepts it.
  const rows = ['[Output]  [Output] ─────', '↑↓ select · Esc close']
  const secondAt = rows[0]!.indexOf('[Output]', 1)
  assert.ok(secondAt > 0, 'the fixture really paints the label twice')
  const colors = new Map<string, number>([['0:0', PRIMARY], [`0:${secondAt}`, PRIMARY]])
  assert.throws(
    () => assertOneActiveDevice(syntheticFrame(rows, colors), { rows: [0], labelPrefixes: ['[Output]', '[Command]'] }),
    /at most ONE chrome active device/,
    'the same active label painted twice is two active devices',
  )
})

test('assertOneActiveDevice counts a label nested in a longer prefix ONCE', () => {
  // The compact and non-compact label prefixes overlap by construction
  // (`[Out` ⊂ `[Output]`): one painted device must be one occurrence, not two.
  const rows = ['[Output]  Command ─────', '↑↓ select · Esc close']
  const colors = new Map<string, number>([['0:0', PRIMARY]])
  const device = assertOneActiveDevice(syntheticFrame(rows, colors), {
    rows: [0],
    labelPrefixes: ['[Output]', '[Out', '[Command]', '[Cmd'],
  })
  assert.deepEqual(device, ['[Output]'], 'a nested prefix must not double-count one device')
})

test('assertBodyFloor requires real body content, not just in-range indexes', () => {
  const isSettingsBody = (line: string): boolean => /^> \S/.test(line)
  const blank = ['Settings · Categories', '', '↑↓ select · Enter open · Esc close']
  assert.throws(
    () => assertBodyFloor(blank, [1], isSettingsBody, 'Settings synthetic'),
    /must carry real body content/,
    'an in-range, above-the-bar row with no real content must fail the body floor',
  )
  // Positive control: the SAME shape with real content passes.
  const real = ['Settings · Categories', '> Appearance', '↑↓ select · Enter open · Esc close']
  assertBodyFloor(real, [1], isSettingsBody, 'Settings synthetic')
})
