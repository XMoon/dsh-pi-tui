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
  assert.equal(m.state().homeCursor, 1)
  assert.equal(m.state().rowIndex, 0, 'the selector cursor never moves rowIndex')
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

test('the Add picker: search, add, the definition remains addable, Esc clears then back', () => {
  const m = model()
  m.activate()
  m.startAdd()
  assert.equal(m.state().addQuery, '')
  assert.equal(m.state().addSide, 'left', 'an item-side cursor opens the picker on the left')
  // Label hit, case-insensitive.
  m.text('AGENT PRESET')
  assert.deepEqual(m.addMatches(), ['agent-preset'])
  // id hit. The catalog lists EVERY definition now, so the description
  // substring 'cache' also matches the placed stats-line — search with the
  // label instead.
  for (let i = 0; i < 12; i += 1) m.backspace()
  assert.equal(m.state().addQuery, '')
  m.text('cache hit')
  assert.deepEqual(m.addMatches(), ['cache-hit'])
  m.activate()
  // The placement joined the layout (the picker's side); the DEFINITION
  // stays addable for another placement; a SUCCESSFUL add closes the
  // picker (ccstatusline parity — the cursor lands on the added item).
  assert.ok(m.state().layout.rows[0]!.left.some(ref => ref.id === 'cache-hit'))
  assert.ok(m.addMatches().includes('cache-hit'))
  assert.equal(m.state().mode, 'row')
  assert.equal(idAtCursor(m), 'cache-hit', 'the cursor lands on the added item')
  // Description hit ("throughput" matches Performance AND the placed
  // stats-line — the catalog is unfiltered) — the picker reopens with a
  // FRESH query.
  m.startAdd()
  assert.equal(m.state().addQuery, '')
  m.text('throughput')
  assert.deepEqual(m.addMatches(), ['stats-line', 'performance'])
  // Esc: clear the search first, then return to the row.
  assert.ok(m.cancel())
  assert.equal(m.state().addQuery, '')
  assert.equal(m.state().mode, 'add')
  m.cancel()
  assert.equal(m.state().mode, 'row')
})

test('duplicate placements: the same id appends independent, separately styled refs', () => {
  const m = model()
  m.activate()
  m.startAdd()
  m.text('performance')
  assert.deepEqual(m.addMatches(), ['performance'])
  m.activate() // first performance placement (the cursor lands on it)
  assert.equal(m.state().mode, 'row')
  // Second Add: the picker still offers performance.
  m.startAdd()
  m.text('performance')
  assert.ok(m.addMatches().includes('performance'), 'a placed definition remains addable')
  m.activate() // second performance placement (the cursor lands on it)
  const refs = () => m.state().layout.rows[0]!.left.filter(ref => ref.id === 'performance')
  assert.equal(refs().length, 2, 'two performance placements exist')
  // The cursor sits on the second placement: style it Speed (full → speed).
  m.cycleFormat()
  assert.equal(refs()[1]!.format, 'speed', 'the second placement styles Speed')
  // Walk back onto the first placement and style it Latency (full → speed
  // → latency; a third cycle would return to the default and drop the
  // override again).
  while (m.state().cursor !== m.state().layout.rows[0]!.left.indexOf(refs()[0]!)) m.moveUp()
  m.cycleFormat()
  m.cycleFormat()
  assert.equal(refs()[0]!.format, 'latency', 'the first placement styles Latency')
  // One placement's style never leaks into the other.
  assert.equal(refs()[1]!.format, 'speed')
  // A third placement can live in the other zone (the first moves right).
  m.moveZone('right')
  const rightRefs = () => m.state().layout.rows[0]!.right.filter(ref => ref.id === 'performance')
  assert.equal(rightRefs().length, 1, 'the moved placement lives in the right zone')
  assert.equal(rightRefs()[0]!.format, 'latency', 'the moved placement keeps its own style')
  assert.equal(refs().length, 1, 'one placement remains on the left')
  assert.equal(refs()[0]!.format, 'speed', 'the left placement keeps its own style')
  // The 32-item row cap is unchanged (independent of duplicate ids).
  const padded = Array.from({ length: 32 }, (_, index) => ({ id: `pad-${index}` }))
  const m2 = new FooterConfiguratorModel({ schemaVersion: 1, rows: [{ left: padded, right: [] }] }, registry)
  assert.equal(m2.addAvailable('performance', 'left'), false, 'the row cap still refuses the 33rd placement')
})

test('the add side follows the cursor item (right zone)', () => {
  const m = model()
  m.activate()
  walkTo(m, 'ext:*')
  m.moveZone('right')
  m.startAdd()
  assert.equal(m.state().addSide, 'right')
  // The unfiltered query's first match is permission-preset — ALREADY
  // placed in the left zone, so this is a live second placement.
  m.activate()
  assert.ok(m.state().layout.rows[0]!.right.some(ref => ref.id === 'permission-preset'))
  assert.ok(m.state().layout.rows[0]!.left.some(ref => ref.id === 'permission-preset')
    , 'the left placement is untouched')
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
  walkTo(m, 'context') // formats: bar + percent + full
  m.cycleFormat()
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, 'percent')
  m.cycleFormat()
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, 'full')
  m.cycleFormat()
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, undefined)
})

test('the Item Editor shows Style for multi-format items and hides it for single-format items', () => {
  const m = model()
  m.activate()
  walkTo(m, 'context') // formats: bar + percent + full
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

  // A single-format item (stats-line) has no Style row: Enter on the
  // FIRST menu row opens the Tone picker directly.
  const single = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'stats-line' }], right: [] }],
  }, registry)
  single.activate()
  single.activate()
  assert.equal(single.state().mode, 'item')
  single.activate()
  assert.equal(single.state().mode, 'tone')
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
  m.moveDown() // Percent
  m.moveDown() // Full
  m.activate()
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, 'full')
  assert.equal(m.state().mode, 'item')
  // Inline ←→ cycles without opening the picker: full → percent → bar.
  m.moveZone('left')
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, 'percent')
  m.moveZone('left')
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, undefined)
  // → cycles to percent, then full.
  m.moveZone('right')
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, 'percent')
  m.moveZone('right')
  assert.equal(m.state().layout.rows[0]!.left.find(ref => ref.id === 'context')!.format, 'full')
})

test('format changes preserve item ids, zones, and order', () => {
  const m = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{
      left: [{ id: 'model' }, { id: 'context' }, { id: 'turns-steps' }],
      right: [{ id: 'git-branch' }],
    }],
  }, registry)
  m.activate()
  walkTo(m, 'context')
  const before = m.state().layout.rows[0]!
  const beforeLeftIds = before.left.map(ref => ref.id)
  const beforeRightIds = before.right.map(ref => ref.id)
  const beforeModel = before.left[0]!
  const beforeTurns = before.left[2]!
  const beforeBranch = before.right[0]!

  m.cycleFormat() // context: bar → percent

  const after = m.state().layout.rows[0]!
  assert.deepEqual(after.left.map(ref => ref.id), beforeLeftIds)
  assert.deepEqual(after.right.map(ref => ref.id), beforeRightIds)
  assert.deepEqual(after.left[0], beforeModel)
  assert.deepEqual(after.left[2], beforeTurns)
  assert.deepEqual(after.right[0], beforeBranch)
  assert.equal(after.left[1]!.format, 'percent')
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
  // Advanced is the LAST menu row (model now has Style, Tone, Advanced).
  m.moveDown()
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
  assert.equal(m.state().itemCursor, 2, 'the menu cursor still sits on Advanced')
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
  m.moveDown() // Tone
  m.moveDown() // Advanced (model menu: Style, Tone, Advanced)
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

/* ─── PR E: explicit save flow + unsaved-exit guard ──────────────────── */

import { FooterCustomItemCatalog } from '../src/footer/custom-items.ts'

/** A model over a one-row layout that PLACES one custom definition, with
 * a fresh registry (the model wires the draft catalog into it). */
function customModel(): { m: FooterConfiguratorModel; catalog: FooterCustomItemCatalog } {
  const catalog = new FooterCustomItemCatalog([
    { schemaVersion: 1, id: 'user:env', kind: 'text', text: 'PROD', tone: 'auto' },
  ])
  const layout = { schemaVersion: 1 as const, rows: [{ left: [{ id: 'model' }, { id: 'user:env' }], right: [] }] }
  return { m: new FooterConfiguratorModel(layout, createBuiltinFooterRegistry(), catalog), catalog }
}

/** Walk the flat cursor onto the named item of the edited row (clamps at
 * the row end). */
function walkToId(m: FooterConfiguratorModel, id: string): void {
  for (let i = 0; i < 64; i += 1) {
    const row = m.state().layout.rows[m.state().rowIndex]!
    const flat = m.state().cursor
    const ref = flat < row.left.length ? row.left[flat] : row.right[flat - row.left.length]
    if (ref?.id === id) return
    if (flat >= row.left.length + row.right.length - 1) {
      while (m.state().cursor > 0) m.moveUp()
      return
    }
    m.moveDown()
  }
  assert.fail(`cursor never reached "${id}"`)
}

/** Open the item editor on the named item of row 1. */
function openItemMenu(m: FooterConfiguratorModel, id: string): void {
  m.activate() // rows → row
  walkToId(m, id)
  m.activate() // row → item
}

test('PR E: isDirty starts clean on open', () => {
  assert.equal(model().isDirty(), false)
  assert.equal(customModel().m.isDirty(), false, 'a placed custom definition does not read as dirty')
})

test('PR E: removing an item is dirty; re-adding it at the same slot is clean', () => {
  const layout = { schemaVersion: 1 as const, rows: [{ left: [{ id: 'model' }], right: [] }] }
  const m = new FooterConfiguratorModel(layout, createBuiltinFooterRegistry())
  m.activate()
  m.removeActive()
  assert.equal(m.isDirty(), true, 'removal is dirty')
  m.startAdd() // empty row → the Left default side
  assert.ok(m.addMatches().includes('model'), 'the removed item returns to the pool')
  let guard = 0
  while (m.addMatches()[Math.min(m.state().pickerIndex, m.addMatches().length - 1)] !== 'model' && guard < 64) {
    m.moveDown()
    guard += 1
  }
  m.activate() // add it back — appended to the (empty) left zone
  assert.equal(m.state().mode, 'row')
  assert.equal(m.isDirty(), false, 'the restored layout matches the baseline')
})

test('PR E: item order is dirty; the order round-trip is clean (Move Mode)', () => {
  const m = model()
  m.activate()
  m.startMove()
  m.moveDown()
  assert.equal(m.isDirty(), true, 'reorder is dirty')
  m.moveUp()
  assert.equal(m.isDirty(), false, 'reorder back is clean')
})

test('PR E: a zone round-trip of the last left item restores clean', () => {
  const m = model()
  m.activate()
  walkToId(m, 'ext:*') // the right zone starts empty; ext:* is the last left ref
  m.moveZone('right')
  assert.equal(m.isDirty(), true, 'the zone move is dirty')
  m.moveZone('left')
  assert.equal(m.isDirty(), false, 'moving back re-appends at the original slot')
})

test('PR E: an explicit auto tone normalizes against an absent tone', () => {
  const layout = { schemaVersion: 1 as const, rows: [{ left: [{ id: 'model', tone: 'auto' as const }], right: [] }] }
  const m = new FooterConfiguratorModel(layout, createBuiltinFooterRegistry())
  assert.equal(m.isDirty(), false, 'tone:auto baseline is clean')
  m.activate() // row
  m.activate() // item (cursor 0 = model)
  m.moveDown() // menu: Style → Tone
  m.activate() // tone picker (opens on the current choice)
  m.activate() // apply Auto — the draft deletes the field
  assert.equal(m.isDirty(), false, 'auto → absent is the same fact')
})

test('PR E: an explicit DEFAULT format is the same fact as no format', () => {
  const reg = createBuiltinFooterRegistry()
  const def = reg.get('model')
  assert.ok(def !== undefined && def.formats.includes(def.defaultFormat))
  const layout = { schemaVersion: 1 as const, rows: [{ left: [{ id: 'model', format: def.defaultFormat }], right: [] }] }
  const m = new FooterConfiguratorModel(layout, reg)
  assert.equal(m.isDirty(), false, 'explicit-default-format baseline is clean')
  // The Style picker's NO-OP round-trip (review round 3): the picker opens
  // on the current choice; Enter applies the SAME format — applyFormat
  // canonicalizes the draft by DELETING the field. That must not read as
  // dirty against the explicit-default baseline.
  m.activate() // row
  m.activate() // item (cursor 0 = model)
  m.activate() // style picker (opens on the current format)
  m.activate() // apply the same format → the draft drops the field
  assert.equal(m.isDirty(), false, 'a no-op Style Enter must not read as dirty')
})

test('PR E: empty-string prefix/suffix are the same fact as absent', () => {
  const layout = { schemaVersion: 1 as const, rows: [{ left: [{ id: 'model', prefix: '', suffix: '' }], right: [] }] }
  const m = new FooterConfiguratorModel(layout, createBuiltinFooterRegistry())
  assert.equal(m.isDirty(), false, 'empty-string baseline is clean')
  // The Advanced editor's NO-OP commit: an empty buffer DELETES the
  // field — that canonicalization must not read as dirty either.
  m.activate() // row
  m.activate() // item (cursor 0 = model)
  m.moveDown() // menu: Style → Tone
  m.moveDown() // Tone → Advanced
  m.activate() // advanced page (Prefix selected)
  m.activate() // open the inline editor (seeds '')
  m.activate() // commit the empty buffer → the field is deleted
  assert.equal(m.isDirty(), false, 'a no-op Advanced commit must not read as dirty')
})

test('PR E: custom definition text and tone edits dirty; restores clean', () => {
  const { m } = customModel()
  openItemMenu(m, 'user:env')
  assert.equal(m.state().mode, 'item')

  // Text (menu entry 0): edit → dirty; restore → clean.
  m.activate()
  assert.equal(m.state().mode, 'custom-text')
  m.text('X')
  m.activate() // commit
  assert.equal(m.isDirty(), true, 'text edit is dirty')
  m.activate() // custom-text again
  m.backspace()
  m.activate() // commit
  assert.equal(m.isDirty(), false, 'text restore is clean')

  // Definition tone (menu entry 1): change → dirty; restore → clean.
  m.moveDown()
  m.activate() // custom-tone picker (opens on Auto)
  assert.equal(m.state().mode, 'custom-tone')
  m.moveDown()
  m.activate() // apply Primary
  assert.equal(m.isDirty(), true, 'definition tone is dirty')
  m.activate() // picker again
  m.moveUp()
  m.activate() // apply Auto
  assert.equal(m.isDirty(), false, 'definition tone restore is clean')
})

test('PR E: rename and delete of a custom definition count as dirty', () => {
  const { m } = customModel()
  openItemMenu(m, 'user:env')
  // Menu: 0 Text, 1 Default tone, 2 Tone, 3 Advanced, 4 Rename, 5 Delete.
  m.moveDown()
  m.moveDown()
  m.moveDown()
  m.moveDown()
  m.activate() // custom-name (buffer seeded with the current name)
  assert.equal(m.state().mode, 'custom-name')
  m.text('2')
  m.activate() // commit the rename
  assert.equal(m.isDirty(), true, 'rename is dirty')
  m.activate() // custom-name again
  m.backspace()
  m.activate() // rename back
  assert.equal(m.isDirty(), false, 'rename back is clean')

  m.moveDown() // menu entry 5 = Delete definition
  m.activate() // delete page
  m.activate() // confirm
  assert.equal(m.state().mode, 'row', 'delete returns to the row page')
  assert.equal(m.isDirty(), true, 'delete is dirty')
})

test('a custom definition placed MULTIPLE times: rename and delete update every ref', () => {
  const { m, catalog } = customModel()
  m.activate() // → row
  m.startAdd()
  m.text('env')
  assert.ok(m.addMatches().includes('user:env'), 'a placed custom definition remains addable')
  m.activate() // second placement — the cursor lands on it
  const refs = () => [
    ...m.state().layout.rows[0]!.left,
    ...m.state().layout.rows[0]!.right,
  ].filter(ref => ref.id.startsWith('user:'))
  assert.equal(refs().length, 2, 'two placements of the same custom definition')

  // Give the SECOND placement (the cursor is on it) its own tone override.
  m.activate() // → item editor (menu: 0 Text, 1 Default tone, 2 Tone…)
  m.moveDown()
  m.moveDown()
  m.activate() // tone picker
  m.moveDown() // Primary
  m.activate() // applies to THIS placement only
  m.cancel() // → row
  assert.ok(refs().some(ref => ref.tone === 'primary'), 'one placement is toned')
  assert.ok(refs().some(ref => ref.tone === undefined), 'the other placement stays default')

  // Rename the definition: every duplicate ref follows the new id and the
  // per-placement overrides survive.
  m.activate() // item editor (still on the second placement)
  for (let i = 0; i < 4; i += 1) m.moveDown() // 4 Rename definition
  m.activate() // custom-name
  m.text('2')
  m.activate() // commit user:env → user:env2
  assert.equal(catalog.get('user:env2')?.kind, 'text')
  assert.equal(catalog.has('user:env'), false)
  assert.deepEqual(refs().map(ref => ref.id), ['user:env2', 'user:env2'], 'every duplicate ref renames')
  assert.ok(refs().some(ref => ref.tone === 'primary'), 'the toned placement keeps its override')
  assert.ok(refs().some(ref => ref.tone === undefined), 'the default placement keeps its absence')

  // Delete the definition: every duplicate ref goes in one action.
  m.moveDown() // 5 Delete definition
  m.activate() // delete page
  m.activate() // confirm
  assert.equal(refs().length, 0, 'no dangling duplicate refs survive the delete')
  assert.equal(catalog.has('user:env2'), false, 'the definition itself is gone')
})

test('PR E: the home selection covers rows plus the Save action', () => {
  const m = model()
  assert.deepEqual(m.homeSelection(), { kind: 'row', rowIndex: 0 })
  m.moveDown()
  assert.deepEqual(m.homeSelection(), { kind: 'row', rowIndex: 1 })
  m.moveDown()
  assert.deepEqual(m.homeSelection(), { kind: 'save' })
  m.moveDown()
  assert.deepEqual(m.homeSelection(), { kind: 'save' }, 'the save entry is the clamp')
  m.activate()
  assert.equal(m.state().mode, 'rows', 'model-activate on the Save entry is a no-op (the panel owns persistence)')
  m.moveUp()
  assert.deepEqual(m.homeSelection(), { kind: 'row', rowIndex: 1 })
})

test('PR E: addRow shifts the Save entry; removeRow reanchors the home cursor', () => {
  const layout = { schemaVersion: 1 as const, rows: [{ left: [{ id: 'model' }], right: [] }] }
  const m = new FooterConfiguratorModel(layout, createBuiltinFooterRegistry())
  m.moveDown() // → Save (the only entry after row 1)
  assert.deepEqual(m.homeSelection(), { kind: 'save' })
  m.addRow()
  assert.equal(m.state().layout.rows.length, 2)
  assert.deepEqual(m.homeSelection(), { kind: 'row', rowIndex: 1 }, 'the save entry moved one line down')
  m.moveDown()
  assert.deepEqual(m.homeSelection(), { kind: 'save' })
  m.removeRow() // row identity change → reanchor
  assert.equal(m.state().homeCursor, 0)
  assert.deepEqual(m.homeSelection(), { kind: 'row', rowIndex: 0 })
})

test('PR E: a dirty selector Esc opens exit-confirm; a clean one closes', () => {
  const m = model()
  assert.equal(m.cancel(), false, 'clean → close')
  assert.equal(m.state().mode, 'rows')
  m.activate()
  m.removeActive()
  m.cancel() // → rows
  assert.equal(m.isDirty(), true)
  assert.equal(m.cancel(), true, 'dirty → the guard opens')
  assert.equal(m.state().mode, 'exit-confirm')
  assert.equal(m.state().exitConfirmCursor, 0)
  assert.equal(m.cancel(), true, 'Esc inside the guard is Keep Editing')
  assert.equal(m.state().mode, 'rows')
  assert.equal(m.isDirty(), true, 'the draft is preserved')
})

test('PR E: exit-confirm actions route save/discard/keep', () => {
  const m = model()
  m.activate()
  m.removeActive()
  m.cancel() // row → rows
  m.cancel() // dirty → exit-confirm
  assert.equal(m.exitConfirmAction(), 'save')
  assert.equal(m.state().mode, 'exit-confirm', 'save keeps the page — the save outcome decides what comes next')
  m.moveDown()
  assert.equal(m.exitConfirmAction(), 'discard')
  assert.equal(m.state().mode, 'exit-confirm', 'discard keeps the mode; the panel closes without writing')
  m.moveDown()
  assert.equal(m.exitConfirmAction(), 'keep')
  assert.equal(m.state().mode, 'rows', 'keep returns to the selector')
  assert.equal(m.exitConfirmAction(), 'keep', 'outside the guard it is a plain keep')
})

test('PR E: the saving flag gates Esc-close until the save settles', () => {
  const m = model()
  m.activate()
  m.removeActive()
  m.cancel() // row → rows
  m.cancel() // dirty → exit-confirm
  m.beginSave()
  assert.equal(m.state().saving, true)
  assert.equal(m.cancel(), true, 'Esc during a save is swallowed')
  assert.equal(m.state().mode, 'exit-confirm', 'no mode escape mid-save')
  m.endSave()
  assert.equal(m.state().saving, false)
  assert.equal(m.cancel(), true, 'after a failure the guard works again (Esc = Keep Editing)')
  assert.equal(m.state().mode, 'rows')
})

test('PR E: create then delete of a NEW custom item returns to clean', () => {
  const m = model()
  m.activate() // → row 1
  m.startAdd()
  m.text('zz-no-match')
  assert.equal(m.addMatches().length, 0, 'the filter isolates the create action')
  assert.ok(m.isCreateOption())
  m.activate() // → create-name
  m.text('Temp')
  m.activate() // → create-text
  m.text('TMP')
  m.activate() // → create-tone
  m.activate() // create with Auto — the definition is created AND placed
  assert.equal(m.isDirty(), true, 'the created definition + its placement are dirty')
  m.activate() // item editor (the cursor landed on the new item)
  // Menu: 0 Text, 1 Default tone, 2 Tone, 3 Advanced, 4 Rename, 5 Delete.
  for (let i = 0; i < 5; i += 1) m.moveDown()
  m.activate() // delete page
  m.activate() // confirm — removes the definition and every reference
  assert.equal(m.state().mode, 'row')
  assert.equal(m.isDirty(), false, 'create + delete of the new item restores the baseline exactly')
})

// ── PR D: custom command item model flows ────────────────────────────────

const CLOCK = { schemaVersion: 1 as const, id: 'user:clock', kind: 'command' as const, command: 'date +%H:%M' }

/** A model with one placed command definition. */
function commandModel(catalog = new FooterCustomItemCatalog([CLOCK])): FooterConfiguratorModel {
  return new FooterConfiguratorModel(
    { schemaVersion: 1, rows: [{ left: [{ id: 'user:clock' }], right: [] }] },
    registry,
    catalog,
  )
}

/** Create a command item through the Add picker's second create action. */
function createCommand(m: FooterConfiguratorModel, name: string, command: string): void {
  m.activate() // rows -> row
  m.startAdd()
  m.text('no-match')
  m.moveDown() // the second trailing action: Create Custom Command
  m.activate() // add -> create-name
  m.text(name)
  m.activate() // create-name -> create-command
  m.text(command)
  m.activate() // create-command -> create-refresh
  m.activate() // create-refresh -> create-timeout (default 5s)
  m.activate() // create-timeout -> create-tone (default 300ms)
  m.activate() // create-tone -> row (Auto tone)
}

test('PR D: the Add picker exposes BOTH create actions and the command flow creates a command item', () => {
  const m = model()
  m.activate() // row
  m.startAdd()
  m.text('no-match')
  assert.equal(m.addOptionCount(), 2, 'two trailing create actions')
  assert.equal(m.createActionKind(), 'text', 'the first create action is Custom Text')
  m.moveDown()
  assert.equal(m.createActionKind(), 'command', 'the second create action is Custom Command')
  m.activate() // create-name
  assert.equal(m.state().customKind, 'command')
  m.text('Clock')
  m.activate() // create-command
  assert.equal(m.state().mode, 'create-command')
  m.text('date +%H:%M')
  m.activate() // create-refresh
  assert.equal(m.state().mode, 'create-refresh')
  m.activate() // create-timeout (5s default)
  assert.equal(m.state().mode, 'create-timeout')
  m.activate() // create-tone (300ms default)
  assert.equal(m.state().mode, 'create-tone')
  m.activate() // create with Auto
  assert.equal(m.state().mode, 'row')
  const created = m.customItem('user:Clock')
  assert.equal(created?.kind, 'command')
  assert.equal(created?.kind === 'command' ? created.command : undefined, 'date +%H:%M')
  assert.equal(created?.kind === 'command' ? created.refreshIntervalMs : undefined, 5000)
  assert.equal(created?.kind === 'command' ? created.timeoutMs : undefined, 300)
  assert.ok(m.state().layout.rows[0]!.left.some(ref => ref.id === 'user:Clock'))
})

test('PR D: the command create flow validates the command and cancels back to the picker', () => {
  const m = model()
  m.activate() // row
  m.startAdd()
  m.text('no-match')
  m.moveDown()
  m.activate() // create-name
  m.text('Clock')
  m.activate() // create-command
  m.activate() // empty command -> error
  assert.match(m.state().customError, /required/)
  assert.equal(m.state().mode, 'create-command')
  m.cancel() // Esc -> add picker
  assert.equal(m.state().mode, 'add')
  assert.equal(m.customItem('user:Clock'), undefined, 'cancelling the flow must not create anything')
})

test('PR D: the item editor edits command, refresh, timeout and definition tone', () => {
  const m = commandModel()
  m.activate() // row
  m.activate() // item
  // Menu: 0 Command, 1 Refresh, 2 Timeout, 3 Default tone, 4 Tone,
  // 5 Advanced, 6 Rename, 7 Delete.
  m.activate() // Command inline editor
  assert.equal(m.state().mode, 'custom-command')
  m.text('!') // append
  m.activate() // commit
  const edited = m.customItem('user:clock')
  assert.equal(edited?.kind === 'command' ? edited.command : undefined, 'date +%H:%M!')

  m.moveDown() // Refresh
  m.activate()
  assert.equal(m.state().mode, 'custom-refresh')
  m.moveDown() // 10s
  m.activate()
  const refreshed = m.customItem('user:clock')
  assert.equal(refreshed?.kind === 'command' ? refreshed.refreshIntervalMs : undefined, 10000)

  m.moveDown() // Timeout
  m.activate()
  assert.equal(m.state().mode, 'custom-timeout')
  m.moveDown() // 500ms
  m.activate()
  const timed = m.customItem('user:clock')
  assert.equal(timed?.kind === 'command' ? timed.timeoutMs : undefined, 500)

  m.moveDown() // Default tone
  m.activate()
  m.moveDown() // Primary (the picker opens on Auto)
  m.activate()
  assert.equal(m.customItem('user:clock')?.tone, 'primary')
})

test('PR D: rename and delete of a command definition update every layout reference', () => {
  const m = commandModel()
  m.activate() // row
  m.activate() // item
  // Rename: menu index 6.
  for (let i = 0; i < 6; i += 1) m.moveDown()
  m.activate()
  for (let i = 0; i < 'clock'.length; i += 1) m.backspace()
  m.text('time')
  m.activate()
  assert.equal(m.customItem('user:time')?.kind, 'command')
  assert.equal(m.state().layout.rows[0]!.left[0]!.id, 'user:time')

  // Delete: menu index 7 (the renamed item's menu is the same length).
  m.moveDown()
  m.activate()
  assert.equal(m.state().mode, 'custom-delete')
  m.activate()
  assert.equal(m.state().mode, 'row')
  assert.deepEqual(m.state().layout.rows[0]!.left, [])
  assert.equal(m.customItem('user:time'), undefined)
})

test('PR D: command definition edits dirty and restore clean (command/refresh/timeout/tone)', () => {
  const m = commandModel()
  assert.equal(m.isDirty(), false)
  m.activate() // row
  m.activate() // item
  m.activate() // Command
  m.text('!')
  m.activate()
  assert.equal(m.isDirty(), true, 'a command change is dirty')
  m.activate()
  m.backspace()
  m.activate()
  assert.equal(m.isDirty(), false, 'restoring the command returns to clean')

  m.moveDown() // Refresh
  m.activate()
  m.moveDown() // 10s
  m.activate()
  assert.equal(m.isDirty(), true, 'a refresh change is dirty')
  m.moveDown() // Timeout
  m.activate()
  m.moveUp() // 300ms
  m.activate()
  assert.equal(m.isDirty(), true, 'a timeout change is dirty')
  m.moveDown() // Default tone
  m.activate()
  m.moveDown() // Accent
  m.activate()
  assert.equal(m.isDirty(), true, 'a definition tone change is dirty')
})

test('PR D: an explicit default refresh/timeout is the same fact as absent (no false dirty)', () => {
  const m = commandModel()
  m.activate() // row
  m.activate() // item
  // Re-pick the CURRENT effective values explicitly: the draft stores
  // refreshIntervalMs: 5000 / timeoutMs: 300, which must NOT read as dirty
  // against the absent-default baseline.
  m.moveDown() // Refresh
  m.activate()
  m.activate() // apply the current 5s
  m.moveDown() // Timeout
  m.activate()
  m.activate() // apply the current 300ms
  assert.equal(m.isDirty(), false, 'an explicit default must not read as dirty')
  const item = m.customItem('user:clock')
  assert.equal(item?.kind === 'command' ? item.refreshIntervalMs : undefined, 5000)
  assert.equal(item?.kind === 'command' ? item.timeoutMs : undefined, 300)
})

test('PR D: mixed text + command dirty detection is independent per definition', () => {
  const catalog = new FooterCustomItemCatalog([
    CLOCK,
    { schemaVersion: 1, id: 'user:env', kind: 'text', text: 'PROD' },
  ])
  const m = new FooterConfiguratorModel(
    { schemaVersion: 1, rows: [{ left: [{ id: 'user:clock' }, { id: 'user:env' }], right: [] }] },
    registry,
    catalog,
  )
  assert.equal(m.isDirty(), false)
  m.activate() // row
  m.activate() // item (user:clock)
  m.activate() // Command
  m.text('!')
  m.activate()
  assert.equal(m.isDirty(), true)
  m.activate()
  m.backspace()
  m.activate()
  assert.equal(m.isDirty(), false, 'restoring the command restores clean')
  // The text item's own edit still dirties independently.
  m.moveDown() // Refresh
  m.activate()
  m.moveDown()
  m.activate()
  assert.equal(m.isDirty(), true)
})

test('PR D: create then delete of a NEW command item returns to clean', () => {
  const m = model()
  createCommand(m, 'Temp', 'date')
  assert.equal(m.isDirty(), true)
  m.activate() // item editor (the cursor landed on the new item)
  // Menu: 0 Command, 1 Refresh, 2 Timeout, 3 Default tone, 4 Tone,
  // 5 Advanced, 6 Rename, 7 Delete.
  for (let i = 0; i < 7; i += 1) m.moveDown()
  m.activate() // delete page
  m.activate() // confirm
  assert.equal(m.state().mode, 'row')
  assert.equal(m.isDirty(), false, 'create + delete of the new command item restores the baseline')
})
