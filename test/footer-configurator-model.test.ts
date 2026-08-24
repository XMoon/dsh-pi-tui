/**
 * Headless tests for the footer configurator MODEL (plan §15.4/§15.8):
 * toggle, reorder, zone moves, row switching, format cycling, separator,
 * resets, and the 1..2 row bound.
 * @module @xmoon76/dsh-pi-tui/footer-configurator-model.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { FooterConfiguratorModel } from '../src/footer/configurator-model.ts'
import { createBuiltinFooterRegistry } from '../src/footer/builtin-items.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../src/footer/presets.ts'

const registry = createBuiltinFooterRegistry()

function model(): FooterConfiguratorModel {
  return new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, registry)
}

test('the model starts from the initial layout with the cursor at row 0 left', () => {
  const m = model()
  const state = m.state()
  assert.equal(state.activeRow, 0)
  assert.equal(state.activeZone, 'left')
  assert.equal(state.activeIndex, 0)
  assert.equal(state.layout.rows.length, 2)
  assert.equal(state.layout.rows[0]!.left[0]!.id, 'view-scope')
})

test('toggleActive removes the active item; the cursor clamps', () => {
  const m = model()
  m.toggleActive() // view-scope out
  const state = m.state()
  assert.ok(!state.layout.rows[0]!.left.some(ref => ref.id === 'view-scope'))
  assert.equal(state.activeIndex, 0)
  // The next item is now active.
  assert.equal(state.layout.rows[0]!.left[0]!.id, 'permission-preset')
})

test('moveToOtherZone moves the active item to the other zone', () => {
  const m = model()
  m.moveToOtherZone() // view-scope → right
  const state = m.state()
  assert.ok(!state.layout.rows[0]!.left.some(ref => ref.id === 'view-scope'))
  assert.equal(state.layout.rows[0]!.right.at(-1)!.id, 'view-scope')
})

test('moveUp/moveDown reorder within the active zone', () => {
  const m = model()
  m.moveDown() // view-scope down one
  let state = m.state()
  assert.equal(state.layout.rows[0]!.left[0]!.id, 'permission-preset')
  assert.equal(state.layout.rows[0]!.left[1]!.id, 'view-scope')
  assert.equal(state.activeIndex, 1)
  m.moveUp()
  state = m.state()
  assert.equal(state.layout.rows[0]!.left[0]!.id, 'view-scope')
  assert.equal(state.activeIndex, 0)
  // Bounds: moving up at the top is a no-op.
  m.moveUp()
  assert.equal(m.state().activeIndex, 0)
})

test('switchRow cycles rows; switchZone flips the zone', () => {
  const m = model()
  m.switchRow()
  assert.equal(m.state().activeRow, 1)
  m.switchRow()
  assert.equal(m.state().activeRow, 0)
  m.switchZone()
  assert.equal(m.state().activeZone, 'right')
  m.switchZone()
  assert.equal(m.state().activeZone, 'left')
})

test('cycleFormat cycles the active item\'s finite formatters', () => {
  const m = model()
  // Move the cursor onto the context item (formats: bar, full).
  while (m.state().layout.rows[0]!.left[m.state().activeIndex]!.id !== 'context') m.moveCursorDown()
  m.cycleFormat()
  const state = m.state()
  const context = state.layout.rows[0]!.left[state.activeIndex]!
  assert.equal(context.id, 'context')
  assert.equal(context.format, 'full')
  m.cycleFormat()
  // Wraps back to the default (the format field is removed).
  assert.equal(m.state().layout.rows[0]!.left[m.state().activeIndex]!.format, undefined)
})

test('moveCursorUp/Down select without reordering', () => {
  const m = model()
  m.moveCursorDown()
  m.moveCursorDown()
  assert.equal(m.state().activeIndex, 2)
  assert.equal(m.state().layout.rows[0]!.left[0]!.id, 'view-scope', 'selection must not reorder')
  m.moveCursorUp()
  assert.equal(m.state().activeIndex, 1)
  m.moveCursorUp()
  m.moveCursorUp() // bound: no-op
  assert.equal(m.state().activeIndex, 0)
})

test('setSeparator sets and clears the active row separator', () => {
  const m = model()
  m.setSeparator(' │ ')
  assert.equal(m.state().layout.rows[0]!.separator?.text, ' │ ')
  m.setSeparator('')
  assert.equal(m.state().layout.rows[0]!.separator, undefined)
})

test('resetDefault/resetCompact restore the builtin layouts', () => {
  const m = model()
  m.toggleActive()
  m.resetCompact()
  assert.equal(m.state().layout.rows.length, 1)
  m.resetDefault()
  assert.equal(m.state().layout.rows.length, 2)
  assert.equal(m.state().layout.rows[0]!.left[0]!.id, 'view-scope')
})

test('addRow/removeRow keep 1..2 rows', () => {
  const m = model()
  m.addRow()
  assert.equal(m.state().layout.rows.length, 2)
  m.removeRow()
  assert.equal(m.state().layout.rows.length, 1)
  m.removeRow() // bound: no-op
  assert.equal(m.state().layout.rows.length, 1)
})

test('the draft is a deep clone: mutations never touch the initial layout', () => {
  const initial = DEFAULT_FOOTER_LAYOUT
  const m = new FooterConfiguratorModel(initial, registry)
  m.toggleActive()
  m.setSeparator(' │ ')
  assert.ok(initial.rows[0]!.left.some(ref => ref.id === 'view-scope'), 'the initial layout must be untouched')
  assert.equal(initial.rows[0]!.separator, undefined)
})
