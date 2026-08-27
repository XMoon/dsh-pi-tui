/**
 * Headless tests for the footer configurator MODEL (the hierarchical
 * editor): page navigation (Row Selector → Edit Row → Item Editor →
 * pickers), item operations (zone moves, remove, add, Move Mode, style
 * cycle, tone, advanced round-trip, reset), and the Add picker's search
 * (label/id/description, case-insensitive, Esc clears first).
 * @module @xmoon76/dsh-pi-tui/footer-configurator-model.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { FooterConfiguratorModel, flatPositionOf } from '../src/footer/configurator-model.ts'
import { createBuiltinFooterRegistry } from '../src/footer/builtin-items.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../src/footer/presets.ts'

const registry = createBuiltinFooterRegistry()

function model(): FooterConfiguratorModel {
  return new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, registry)
}

/** The id at the edited row's flat cursor. */
function idAtCursor(m: FooterConfiguratorModel): string | undefined {
  const state = m.state()
  const row = state.layout.rows[state.rowIndex]!
  const flat = state.cursor
  const ref = flat < row.left.length ? row.left[flat] : row.right[flat - row.left.length]
  return ref?.id
}

/** Walk the flat cursor onto the named item of the edited row (wrapping
 * at the row end). */
function walkTo(m: FooterConfiguratorModel, id: string): void {
  for (let i = 0; i < 128; i += 1) {
    if (idAtCursor(m) === id) return
    const row = m.state().layout.rows[m.state().rowIndex]!
    if (m.state().cursor >= row.left.length + row.right.length - 1) {
      while (m.state().cursor > 0) m.moveUp()
      if (idAtCursor(m) === id) return
    } else {
      m.moveDown()
    }
  }
  assert.fail(`cursor never reached "${id}"`)
}

test('the configurator opens on the Row Selector (row 0)', () => {
  const m = model()
  const state = m.state()
  assert.equal(state.mode, 'rows')
  assert.equal(state.rowIndex, 0)
  assert.equal(state.layout.rows.length, 2)
  assert.equal(state.layout.rows[0]!.left[0]!.id, 'view-scope')
})

test('navigation: Enter a row, Esc back, Esc closes', () => {
  const m = model()
  m.activate()
  assert.equal(m.state().mode, 'row')
  assert.equal(m.state().rowIndex, 0)
  assert.ok(m.cancel(), 'Esc from a row page is consumed')
  assert.equal(m.state().mode, 'rows')
  assert.equal(m.cancel(), false, 'Esc on the Row Selector closes the configurator')
})

test('the Row Selector moves between rows; Enter enters the highlighted row', () => {
  const m = model()
  m.moveDown()
  assert.equal(m.state().rowIndex, 1)
  m.activate()
  assert.equal(m.state().mode, 'row')
  assert.equal(m.state().rowIndex, 1)
  assert.equal(m.state().cursor, 0)
  // The default layout's second row has one item (stats-line).
  assert.equal(m.state().layout.rows[1]!.left[0]!.id, 'stats-line')
})

test('Available is reachable ONLY through the Add picker (no cursor section)', () => {
  const m = model()
  m.activate()
  // Walk down past every item: the cursor clamps inside the row's items —
  // it never enters an "available" section.
  for (let i = 0; i < 32; i += 1) m.moveDown()
  assert.equal(m.state().mode, 'row')
  assert.equal(m.state().cursor, 9, 'the cursor stays within the row items')
  m.startAdd()
  assert.equal(m.state().mode, 'add')
  assert.ok(m.addMatches().includes('cache-hit'), 'the picker pools the non-layout items')
})

test('the flat cursor spans Left then Right; ←/→ move between zones', () => {
  const m = model()
  m.activate()
  walkTo(m, 'ext:*') // the LAST left item (the right zone starts empty)
  m.moveDown()
  const leftCount = m.state().layout.rows[0]!.left.length
  assert.equal(m.state().cursor, leftCount - 1, 'the cursor clamps at the row end — no available section')
  m.moveZone('right')
  let state = m.state()
  assert.ok(!state.layout.rows[0]!.left.some(ref => ref.id === 'ext:*'))
  assert.equal(state.layout.rows[0]!.right.at(-1)!.id, 'ext:*')
  // The cursor followed the item into the right zone.
  assert.equal(state.cursor, state.layout.rows[0]!.left.length + state.layout.rows[0]!.right.length - 1)
  // ← moves it back to Left.
  m.moveZone('left')
  assert.ok(m.state().layout.rows[0]!.left.some(ref => ref.id === 'ext:*'))
  // ← on an already-left item is a no-op.
  const before = m.state().layout.rows[0]!.left.map(ref => ref.id)
  m.moveZone('left')
  assert.deepEqual(m.state().layout.rows[0]!.left.map(ref => ref.id), before)
})

test('Space removes the active item; it returns to the Add pool', () => {
  const m = model()
  m.activate()
  walkTo(m, 'context')
  m.removeActive()
  const state = m.state()
  assert.ok(!state.layout.rows[0]!.left.some(ref => ref.id === 'context'))
  assert.ok(m.availableIds().includes('context'), 'removed items return to Available')
  // The cursor clamped onto the next item.
  assert.equal(idAtCursor(m), 'turns-steps')
})

test('the Add picker: search, add, the item leaves the pool, Esc clears then back', () => {
  const m = model()
  m.activate()
  m.startAdd()
  assert.equal(m.state().addQuery, '')
  assert.equal(m.state().addSide, 'left', 'an item-side cursor opens the picker on the left')
  // Label hit, case-insensitive.
  m.text('AGENT PRESET')
  assert.deepEqual(m.addMatches(), ['agent-preset'])
  // id hit.
  for (let i = 0; i < 12; i += 1) m.backspace()
  assert.equal(m.state().addQuery, '')
  m.text('cache')
  assert.deepEqual(m.addMatches(), ['cache-hit'])
  m.activate()
  // The item joined the layout (the picker's side) and left the pool; a
  // SUCCESSFUL add closes the picker (ccstatusline parity — the cursor
  // lands on the added item).
  assert.ok(m.state().layout.rows[0]!.left.some(ref => ref.id === 'cache-hit'))
  assert.ok(!m.addMatches().includes('cache-hit'))
  assert.equal(m.state().mode, 'row')
  assert.equal(idAtCursor(m), 'cache-hit', 'the cursor lands on the added item')
  // Description hit ("wall time" matches the Performance description) —
  // the picker reopens with a FRESH query.
  m.startAdd()
  assert.equal(m.state().addQuery, '')
  m.text('wall time')
  assert.deepEqual(m.addMatches(), ['performance'])
  // Esc: clear the search first, then return to the row.
  assert.ok(m.cancel())
  assert.equal(m.state().addQuery, '')
  assert.equal(m.state().mode, 'add')
  m.cancel()
  assert.equal(m.state().mode, 'row')
})

test('the add side follows the cursor item (right zone)', () => {
  const m = model()
  m.activate()
  walkTo(m, 'ext:*')
  m.moveZone('right')
  m.startAdd()
  assert.equal(m.state().addSide, 'right')
  m.activate() // add the first match (agent-preset)
  assert.ok(m.state().layout.rows[0]!.right.some(ref => ref.id === 'agent-preset'))
  assert.ok(!m.state().layout.rows[0]!.left.some(ref => ref.id === 'agent-preset'))
})

test('Move Mode: M enters, ↑↓ reorder within the zone, Enter/Esc exits', () => {
  const m = model()
  m.activate()
  walkTo(m, 'model')
  m.startMove()
  assert.equal(m.state().mode, 'row-move')
  m.moveDown() // reorder: model swaps with tasks
  const left = m.state().layout.rows[0]!.left
  assert.equal(left[3]!.id, 'tasks')
  assert.equal(left[4]!.id, 'model')
  // Keep walking down: the item slides to the zone end, then stops.
  for (let i = 0; i < 12; i += 1) m.moveDown()
  const state = m.state()
  assert.equal(state.layout.rows[0]!.left.at(-1)!.id, 'model', 'the item stops at the zone end')
  assert.deepEqual(state.layout.rows[0]!.right.map(ref => ref.id), [], 'the right zone is untouched')
  m.activate()
  assert.equal(m.state().mode, 'row')
  // Esc exits Move Mode back to the row editor (the plan's "Enter/Esc
  // Done") — never straight to the Row Selector.
  m.startMove()
  m.cancel()
  assert.equal(m.state().mode, 'row')
  m.cancel()
  assert.equal(m.state().mode, 'rows', 'Esc from a row page returns to the Row Selector')
})

test('F cycles the finite format on the Edit Row page (default removes the override)', () => {
  const m = model()
  m.activate()
  walkTo(m, 'context')
  m.cycleFormat()
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, 'full')
  m.cycleFormat()
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, undefined)
})

test('the Item Editor opens with Style hidden for single-format items', () => {
  const m = model()
  m.activate()
  walkTo(m, 'context') // formats: bar + full
  m.activate()
  assert.equal(m.state().mode, 'item')
  // Style first for a multi-format item; ↓ reaches Tone.
  m.moveDown()
  m.activate()
  assert.equal(m.state().mode, 'tone')
  // The pickers hang off the ITEM EDITOR: Esc returns one level up.
  m.cancel()
  assert.equal(m.state().mode, 'item')
  m.cancel()
  assert.equal(m.state().mode, 'row')
  // A single-format item (model: badge only) has no Style row: Enter on
  // the FIRST menu row opens the Tone picker directly.
  walkTo(m, 'model')
  m.activate()
  assert.equal(m.state().mode, 'item')
  m.activate()
  assert.equal(m.state().mode, 'tone')
})

test('Esc walks the hierarchy ONE level at a time (row → item → picker → item → row)', () => {
  const m = model()
  m.activate()
  walkTo(m, 'context')
  m.activate()
  assert.equal(m.state().mode, 'item')
  m.activate() // Style
  assert.equal(m.state().mode, 'style')
  m.cancel()
  assert.equal(m.state().mode, 'item', 'Style Esc returns to the item editor')
  m.moveDown() // Tone
  m.activate()
  assert.equal(m.state().mode, 'tone')
  m.cancel()
  assert.equal(m.state().mode, 'item', 'Tone Esc returns to the item editor')
  m.moveDown() // Advanced…
  m.activate()
  assert.equal(m.state().mode, 'advanced')
  m.cancel()
  assert.equal(m.state().mode, 'item', 'Advanced Esc returns to the item editor')
  m.cancel()
  assert.equal(m.state().mode, 'row')
  m.cancel()
  assert.equal(m.state().mode, 'rows')
})

test('the Style picker applies a format; the inline ←→ change cycles too', () => {
  const m = model()
  m.activate()
  walkTo(m, 'context')
  m.activate() // item editor
  m.activate() // Style picker (opens on the current format: bar)
  assert.equal(m.state().mode, 'style')
  m.moveDown()
  m.activate()
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, 'full')
  assert.equal(m.state().mode, 'item')
  // Inline ←→ cycles without opening the picker: ← wraps back to bar.
  m.moveZone('left')
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, undefined)
  // → cycles to full again.
  m.moveZone('right')
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, 'full')
})

test('the Tone picker persists the semantic token; Auto removes the override', () => {
  const m = model()
  m.activate()
  walkTo(m, 'context')
  m.activate()
  m.moveDown() // Tone
  m.activate()
  assert.equal(m.state().mode, 'tone')
  m.moveDown() // Primary
  m.activate()
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.tone, 'primary')
  // Reopen: the picker opens on the current tone; Auto (index 0) removes it.
  m.activate() // tone picker again (menu cursor still on Tone)
  m.moveUp()
  m.moveUp()
  m.activate()
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.tone, undefined)
  assert.equal(m.state().mode, 'item')
})

test('Advanced: prefix/suffix/importance round-trip; empty removes the override', () => {
  const m = model()
  const ref = () => m.state().layout.rows[0]!.left.find(item => item.id === 'model')!
  m.activate()
  walkTo(m, 'model')
  m.activate() // item editor
  // Advanced is the LAST menu row (model has no Style entry).
  m.moveDown()
  m.activate()
  assert.equal(m.state().mode, 'advanced')
  assert.equal(m.state().advancedField, 'prefix')
  // Prefix: type and commit.
  m.activate() // open the inline editor
  assert.equal(m.state().editing, true)
  assert.equal(m.state().editBuffer, '')
  m.text('a')
  m.text('b')
  assert.equal(m.state().editBuffer, 'ab')
  m.activate() // commit
  assert.equal(m.state().editing, false)
  assert.equal(ref().prefix, 'ab')
  // Esc inside the edit cancels the edit, not the page.
  m.activate()
  m.text('X')
  assert.ok(m.cancel())
  assert.equal(m.state().editing, false)
  assert.equal(m.state().mode, 'advanced')
  assert.equal(ref().prefix, 'ab')
  // Esc on the (non-editing) Advanced page returns to the ITEM EDITOR —
  // the pickers hang off the item editor (row → item → advanced).
  m.cancel()
  assert.equal(m.state().mode, 'item')
  assert.equal(m.state().itemCursor, 1, 'the menu cursor still sits on Advanced')
  // Importance: digits only, bounds-checked.
  m.activate() // → the advanced editor (field resets to prefix)
  m.moveDown()
  m.moveDown()
  assert.equal(m.state().advancedField, 'importance')
  m.activate()
  m.text('12')
  m.activate()
  assert.equal(ref().importance, 12)
  // An empty commit removes the override.
  m.activate() // edit again (seeded with the current value)
  m.backspace()
  m.backspace()
  m.activate()
  assert.equal(ref().importance, undefined)
  // Out-of-range importance is refused (the parse gate would reject it).
  m.activate()
  m.text('1001')
  m.activate()
  assert.equal(ref().importance, undefined)
})

test('Advanced: Reset to default clears every ref override', () => {
  const m = model()
  m.activate()
  walkTo(m, 'context')
  m.cycleFormat()
  m.activate()
  m.moveDown() // Tone
  m.activate()
  m.moveDown() // Primary
  m.activate() // applied → back to the item editor
  m.moveDown() // Advanced (menu cursor rides from Tone to Advanced)
  m.activate()
  m.moveDown()
  m.moveDown()
  m.moveDown()
  assert.equal(m.state().advancedField, 'reset')
  m.activate()
  const ref = m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!
  assert.equal(ref.format, undefined)
  assert.equal(ref.tone, undefined)
  assert.equal(ref.prefix, undefined)
})

test('a zero-row draft normalizes to one empty row (no crash on the first transition)', () => {
  // The parser rejects zero-row layouts, but the model accepts any
  // FooterLayoutV1: every page transition must survive one.
  const m = new FooterConfiguratorModel({ schemaVersion: 1, rows: [] }, registry)
  assert.equal(m.state().layout.rows.length, 1)
  m.activate()
  assert.equal(m.state().mode, 'row')
  assert.equal(m.state().cursor, 0)
  // Every item op on an empty row is a safe no-op.
  m.moveDown()
  m.moveUp()
  m.removeActive()
  m.moveZone('right')
  m.reorderActive(1)
  m.cycleFormat()
  assert.equal(m.state().mode, 'row')
  assert.equal(m.state().cursor, 0)
  m.activate() // an empty row never opens an item editor
  assert.equal(m.state().mode, 'row')
  // The Add picker still works: the first pool item joins the empty row.
  m.startAdd()
  assert.equal(m.state().mode, 'add')
  m.activate()
  assert.ok(m.state().layout.rows[0]!.left.length === 1, 'the added item landed in the empty row')
})

test('flatPositionOf treats every out-of-range flat as undefined (negative included)', () => {
  const row = { left: [{ id: 'a' }], right: [{ id: 'b' }] }
  assert.deepEqual(flatPositionOf(0, row), { zone: 'left', index: 0 })
  assert.deepEqual(flatPositionOf(1, row), { zone: 'right', index: 0 })
  assert.equal(flatPositionOf(2, row), undefined)
  // A negative flat must never alias the row's TAIL ({zone:'right',
  // index:-1} — the exported helper's contract: out-of-range is
  // undefined).
  assert.equal(flatPositionOf(-1, row), undefined)
  assert.equal(flatPositionOf(-99, row), undefined)
  const emptyRow = { left: [], right: [] }
  assert.equal(flatPositionOf(0, emptyRow), undefined)
  assert.equal(flatPositionOf(-1, emptyRow), undefined)
})

test('the Add path refuses a 33rd item (the parser per-row cap)', () => {
  const row = Array.from({ length: 32 }, (_, index) => ({ id: `pad-${index}` }))
  const m = new FooterConfiguratorModel({ schemaVersion: 1, rows: [{ left: row, right: [] }] }, registry)
  assert.equal(m.addAvailable('cache-hit', 'left'), false, 'the cap refuses the 33rd item')
  assert.equal(m.preview().rows[0]!.left.length, 32, 'the layout is untouched at the cap')
  // One below the cap it still adds, and the next one is refused.
  const m2 = new FooterConfiguratorModel({ schemaVersion: 1, rows: [{ left: row.slice(0, 31), right: [] }] }, registry)
  assert.equal(m2.addAvailable('cache-hit', 'left'), true)
  assert.equal(m2.preview().rows[0]!.left.length, 32)
  assert.equal(m2.addAvailable('cache-hit', 'left'), false)
  assert.equal(m2.preview().rows[0]!.left.length, 32)
})

test('the editable text is sanitized and bounded (the draft must re-parse)', () => {
  const m = model()
  const ref = () => m.state().layout.rows[0]!.left.find(item => item.id === 'model')!
  m.activate()
  walkTo(m, 'model')
  m.activate()
  m.moveDown()
  m.activate() // Advanced
  m.activate() // edit prefix
  // Control characters never enter the buffer (the readable residue is
  // legal prefix text — the same sanitize contract as the display side).
  m.text('ok')
  m.text('\u001b[2J\u0007')
  assert.equal(m.state().editBuffer, 'ok[2J')
  // The cap is the parser's 16-char bound.
  for (let i = 0; i < 24; i += 1) m.text('z')
  m.activate()
  assert.ok((ref().prefix ?? '').length <= 16, 'prefix is capped at the parser bound')
})

test('the draft is a deep clone: mutations never touch the initial layout', () => {
  const initial = DEFAULT_FOOTER_LAYOUT
  const m = new FooterConfiguratorModel(initial, registry)
  m.activate()
  m.removeActive()
  assert.ok(initial.rows[0]!.left.some(ref => ref.id === 'view-scope'), 'the initial layout must be untouched')
})

test('preset resets re-anchor every page cursor (a stale buffer never survives)', () => {
  const m = model()
  m.activate() // row
  walkTo(m, 'model')
  m.activate() // item editor
  m.moveDown() // Advanced (model menu: Tone, Advanced)
  m.activate() // the advanced page
  m.activate() // editing the prefix (buffer seeded)
  m.text('STALE')
  assert.equal(m.state().editing, true)
  assert.equal(m.state().editBuffer, 'STALE')
  // A reset mid-edit must clear EVERY page state, not just the layout.
  m.resetDefault()
  const state = m.state()
  assert.equal(state.mode, 'rows')
  assert.equal(state.editing, false)
  assert.equal(state.editBuffer, '')
  assert.equal(state.addQuery, '')
  assert.equal(state.itemCursor, 0)
  assert.equal(state.pickerIndex, 0)
  assert.equal(state.advancedField, 'prefix')
  assert.equal(state.cursor, 0)
  // The post-reset flow starts from the selector: the stale buffer can
  // never be committed into the new layout's items.
  m.activate()
  assert.equal(m.state().mode, 'row')
  assert.equal(m.state().editBuffer, '')
  m.activate()
  m.activate()
  assert.equal(m.state().mode, 'tone', 'the fresh item editor opens its first menu row — not a stale advanced page')
})

test('removeRow re-anchors onto the Row Selector too', () => {
  const m = model()
  m.activate() // row 0
  m.addRow()
  m.moveDown() // → row 1
  m.activate() // editing row 2
  m.removeRow()
  const state = m.state()
  assert.equal(state.mode, 'rows')
  assert.equal(state.rowIndex, 0)
  assert.equal(state.editBuffer, '')
})

test('preset resets and the 1..2 row bound still work alongside the pages', () => {
  const m = model()
  m.addRow()
  assert.equal(m.state().layout.rows.length, 2)
  m.addRow()
  assert.equal(m.state().layout.rows.length, 2)
  m.removeRow()
  assert.equal(m.state().layout.rows.length, 1)
  m.removeRow()
  assert.equal(m.state().layout.rows.length, 1)
  m.resetDefault()
  assert.equal(m.state().layout.rows.length, 2)
  assert.equal(m.state().rowIndex, 0)
  assert.equal(m.state().cursor, 0)
})