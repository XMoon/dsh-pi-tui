/**
 * The design-language machine checks (`docs/tui-design-language.md` §11.3.1).
 *
 * Two things are cheap enough to enforce and expensive to get wrong:
 *
 * 1. **Width safety.** Every glyph the design language introduces as chrome must
 *    measure ONE cell under the fork's `visibleWidth()` AND carry an
 *    East-Asian-Width class that CJK-width terminals (VTE/WezTerm
 *    `cjk-ambiguous-width`) also paint as one cell. The icon registry already
 *    guards its own glyphs (`test/icons.test.ts`); this file guards the chrome
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
import { ALL_ICON_SEMANTICS, type IconStyle } from '../src/domain/display/icons.ts'
import { iconFor } from '../src/tui/icons.ts'

/** The EAW classes that are safe under CJK-width terminals (same set the icon
 *  registry gate uses). */
const SAFE_EAW: ReadonlySet<string> = new Set(['neutral', 'narrow', 'halfwidth'])

/** The chrome glyph inventory of `docs/tui-design-language.md` §4.4 that MUST be
 *  width-safe. The current-value arrow `←` is deliberately NOT here: it is
 *  ambiguous and grandfathered (§4.3), because it already ships in two surfaces
 *  and every neutral substitute either collides with another role or reads as
 *  something else. */
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
  ['←', 'the current-value suffix and the read-gutter joins'],
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
    'the rejected-status-glyph sets changed: update docs/tui-design-language.md §4.1 in the same PR',
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
    'the grandfathered list changed: update docs/tui-design-language.md §4.3 in the same PR')
  assert.ok(!CANONICAL_CHROME_GLYPHS.some(([, glyph]) => GRANDFATHERED_AMBIGUOUS.some(([other]) => other === glyph)),
    'a glyph cannot be both canonical (must be safe) and grandfathered (may be ambiguous)')
})
