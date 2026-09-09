/**
 * Unit tests for the Host-owned SearchablePicker (migrated from the
 * vendored SelectList fork divergences X001/X002/X041 and the SelectList
 * side of X042): search, canonical query state, selection preservation,
 * groups, page keys, the responsive row budget, and search-Input focus
 * forwarding.
 * @module @xmoon76/dsh-pi-tui/searchable-picker.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CURSOR_MARKER, TuiAltScreen } from '@xmoon76/pi-tui'
import {
  SearchablePicker,
  type SearchablePickerTheme,
} from '../src/searchable-picker.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const testTheme: SearchablePickerTheme = {
  selectedPrefix: (text: string) => text,
  selectedText: (text: string) => text,
  description: (text: string) => text,
  scrollInfo: (text: string) => text,
  noMatch: (text: string) => text,
}

test('search filters labels by case-insensitive substring', () => {
  const items = [
    { value: 'session-a', label: 'alpha', description: 'first' },
    { value: 'session-b', label: 'zulu', description: 'second' },
    { value: 'session-c', label: 'mike', description: 'third' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true, header: 'sessions' })

  let rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('sessions')), 'header missing')
  assert.ok(rendered.some((line) => line.includes('> ')), 'search input missing')

  picker.handleInput('a')
  rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('alpha')), "alpha should match 'a'")
  assert.ok(!rendered.some((line) => line.includes('zulu')), "zulu should not match 'a'")

  // Case-insensitive: 'Z' matches 'zulu'
  picker.handleInput('\b')
  picker.handleInput('Z')
  rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('zulu')), "zulu should match 'Z'")
  assert.ok(!rendered.some((line) => line.includes('alpha')), "alpha should not match 'Z'")
})

test('search matches description and value text', () => {
  const items = [
    { value: 'session-abc-111', label: 'one', description: 'rewrite footer' },
    { value: 'session-xyz-222', label: 'two', description: 'add search' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true })

  picker.handleInput('rewrite')
  let rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('one')), 'description match missed')

  for (let i = 0; i < 7; i++) picker.handleInput('\b')
  picker.handleInput('xyz')
  rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('two')), 'value match missed')
})

test('search selects the filtered item on Enter', () => {
  const items = [
    { value: 'a', label: 'alpha' },
    { value: 'b', label: 'beta' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true })
  const selected: string[] = []
  picker.onSelect = (item) => { selected.push(item.value) }

  picker.handleInput('b')
  picker.handleInput('\r')
  assert.deepEqual(selected, ['b'])
})

test('initialQuery prefills the search box and filters on open', () => {
  const items = [
    { value: 'session-a', label: 'alpha' },
    { value: 'session-b', label: 'zulu' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true, initialQuery: 'zu' })
  assert.equal(picker.getFilter(), 'zu')
  const rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('zulu')), 'prefilled query must filter')
  assert.ok(!rendered.some((line) => line.includes('alpha')), 'non-matching row must be hidden')
})

test('no match renders the no-match message and keeps the search input usable', () => {
  const picker = new SearchablePicker(
    [{ value: 'a', label: 'alpha' }],
    5,
    testTheme,
    {},
    { enableSearch: true, noMatchText: 'nothing here' },
  )
  picker.handleInput('zzz')
  const rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('nothing here')), 'no-match text missing')
  // Typing still refines the query after a no-match state.
  picker.handleInput('\b')
  picker.handleInput('a')
  assert.equal(picker.getFilter(), 'zza')
})

test('setFilter updates getFilter() and the rendered search box', () => {
  const items = [
    { value: 'session-a', label: 'alpha', description: 'first' },
    { value: 'session-b', label: 'zulu', description: 'second' },
    { value: 'session-c', label: 'mike', description: 'third' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true })
  picker.setFilter('al')

  assert.equal(picker.getFilter(), 'al', 'getFilter must reflect the programmatic filter')
  const rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('al')), 'search box must show the programmatic query')
  assert.equal(picker.getSelectedItem()?.value, 'session-a')
})

test('user typing APPENDS to a programmatic filter instead of replacing it', () => {
  const items = [
    { value: 'session-a', label: 'alpha', description: 'first' },
    { value: 'session-b', label: 'zulu', description: 'second' },
    { value: 'session-c', label: 'mike', description: 'third' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true })
  picker.setFilter('alp')
  picker.handleInput('h')

  assert.equal(picker.getFilter(), 'alph', 'the typed char must extend the programmatic query')
  assert.equal(picker.getSelectedItem()?.value, 'session-a')
})

test('a programmatic filter survives setItems() refreshes', () => {
  const items = [
    { value: 'session-a', label: 'alpha', description: 'first' },
    { value: 'session-b', label: 'zulu', description: 'second' },
    { value: 'session-c', label: 'mike', description: 'third' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true })
  picker.setFilter('zu')
  picker.setItems(items.map((item) => ({ ...item, description: 'refreshed' })))

  assert.equal(picker.getFilter(), 'zu', 'setItems must re-apply the canonical query')
  assert.equal(picker.getSelectedItem()?.value, 'session-b')
})

test('getFilter() reports the programmatic query with search disabled too', () => {
  const items = [
    { value: 'session-a', label: 'alpha', description: 'first' },
    { value: 'session-b', label: 'zulu', description: 'second' },
    { value: 'session-c', label: 'mike', description: 'third' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme)
  picker.setFilter('mi')

  assert.equal(picker.getFilter(), 'mi')
  assert.equal(picker.getSelectedItem()?.value, 'session-c')
})

test('initialQuery prefill leaves the cursor at the end (typing appends)', () => {
  const items = [
    { value: 'session-a', label: 'alpha', description: 'first' },
    { value: 'session-b', label: 'zulu', description: 'second' },
    { value: 'session-c', label: 'mike', description: 'third' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true, initialQuery: 'al' })
  assert.equal(picker.getFilter(), 'al')
  picker.handleInput('p')

  assert.equal(picker.getFilter(), 'alp', 'the first keystroke must append, not prepend')
  assert.equal(picker.getSelectedItem()?.value, 'session-a')
})

test('re-applies the active query when items are replaced', () => {
  const picker = new SearchablePicker([{ value: 'a', label: 'alpha' }], 5, testTheme, {}, { enableSearch: true })
  picker.handleInput('beta')
  let rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('No matching')), 'expected no-match before setItems')

  picker.setItems([
    { value: 'a', label: 'alpha' },
    { value: 'b', label: 'beta' },
  ])
  rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('beta')), 'setItems did not re-filter')
  assert.ok(!rendered.some((line) => line.includes('alpha')), 'setItems kept non-matching item')
})

test('keeps the selected row (by value) when setItems refreshes the list', () => {
  const items = [
    { value: 'a', label: 'alpha' },
    { value: 'b', label: 'beta' },
    { value: 'c', label: 'gamma' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true })
  picker.handleInput('\x1b[B') // down to beta
  picker.handleInput('\x1b[B') // down to gamma
  // Background title enrichment arrives: fresh objects, same values.
  picker.setItems(items.map(item => ({ ...item, description: 'enriched' })))
  const selected = picker.getSelectedItem()
  assert.ok(selected !== null && selected.value === 'c', 'selection must survive setItems')
  // A query change still resets to the top.
  picker.handleInput('a')
  const afterFilter = picker.getSelectedItem()
  assert.ok(afterFilter !== null && afterFilter.value === 'a', 'new query resets selection')
})

test('falls back to the top when the selected value is removed by setItems', () => {
  const picker = new SearchablePicker(
    [
      { value: 'a', label: 'alpha' },
      { value: 'b', label: 'beta' },
      { value: 'c', label: 'gamma' },
    ],
    5,
    testTheme,
  )
  picker.handleInput('\x1b[B') // down to beta
  picker.handleInput('\x1b[B') // down to gamma
  // The selected row disappears from the refreshed list.
  picker.setItems([
    { value: 'a', label: 'alpha' },
    { value: 'b', label: 'beta' },
  ])
  assert.equal(picker.getSelectedItem()?.value, 'a', 'selection must fall back to the top')
})

test('up/down wrap within the filtered list', () => {
  const items = [
    { value: 'a', label: 'alpha' },
    { value: 'b', label: 'beta' },
    { value: 'c', label: 'gamma' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme)
  picker.handleInput('\x1b[A') // up wraps to the bottom
  assert.equal(picker.getSelectedItem()?.value, 'c')
  picker.handleInput('\x1b[B') // down wraps to the top
  assert.equal(picker.getSelectedItem()?.value, 'a')
})

test('pageDown/pageUp move the selection by one visible page', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: `item-${i}` }))
  const picker = new SearchablePicker(items, 5, testTheme)
  picker.handleInput('\x1b[6~') // pageDown
  assert.equal(picker.getSelectedItem()?.value, '5')
  picker.handleInput('\x1b[6~')
  assert.equal(picker.getSelectedItem()?.value, '10')
  picker.handleInput('\x1b[5~') // pageUp
  assert.equal(picker.getSelectedItem()?.value, '5')
})

test('navigation is a no-op with zero matches and recovers after a matching filter', () => {
  const items = [
    { value: 'session-a', label: 'alpha' },
    { value: 'session-b', label: 'beta' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme)
  picker.setFilter('zzz') // zero matches
  assert.equal(picker.getSelectedItem(), null)
  assert.equal(picker.getSelectedIndex(), 0, 'selection must start at 0 on an empty list')
  // Every navigation key must be a no-op: the selection index stays 0 (a
  // wrap on the empty list would otherwise push it to -1/1 and break the
  // invariant), and confirm stays inert. Each key is asserted immediately
  // after the keystroke so a mutant dropping any single guard branch is
  // caught (pageUp from index 0 is additionally clamped to 0 by
  // max(0, ...), so its guard is defense-in-depth).
  picker.handleInput('\x1b[A') // up
  assert.equal(picker.getSelectedIndex(), 0, 'up must be a no-op on an empty list')
  picker.handleInput('\x1b[B') // down
  assert.equal(picker.getSelectedIndex(), 0, 'down must be a no-op on an empty list')
  picker.handleInput('\x1b[5~') // pageUp
  assert.equal(picker.getSelectedIndex(), 0, 'pageUp must be a no-op on an empty list')
  picker.handleInput('\x1b[6~') // pageDown
  assert.equal(picker.getSelectedIndex(), 0, 'pageDown must be a no-op on an empty list')
  assert.equal(picker.getSelectedItem(), null, 'confirm must stay inert on an empty list')
  // A later filter that matches again must restore navigation from the top.
  picker.setFilter('session-')
  assert.equal(picker.getSelectedItem()?.value, 'session-a')
  picker.handleInput('\x1b[B')
  assert.equal(picker.getSelectedItem()?.value, 'session-b')
})

test('navigates and selects within the filtered list only (search disabled)', () => {
  const items = [
    { value: 'session-a', label: 'alpha' },
    { value: 'session-b', label: 'beta' },
    { value: 'session-c', label: 'gamma' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme)
  let selected = ''
  picker.onSelect = (item) => {
    selected = item.value
  }

  // Filter to the last row only: Up/Down/Enter must never walk into the
  // invisible rows (regression: navigation used the raw items while render
  // drew the filtered list).
  picker.setFilter('gamma')
  assert.equal(picker.getSelectedItem()?.value, 'session-c')
  picker.handleInput('\x1b[A') // up wraps within the filtered list
  assert.equal(picker.getSelectedItem()?.value, 'session-c')
  picker.handleInput('\x1b[B') // down wraps within the filtered list
  assert.equal(picker.getSelectedItem()?.value, 'session-c')
  picker.handleInput('\r') // confirm
  assert.equal(selected, 'session-c')
})

test('keeps selection within bounds after narrowing to a middle row', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ value: String(i), label: `item-${i}` }))
  const picker = new SearchablePicker(items, 5, testTheme)
  picker.setSelectedIndex(9)
  picker.setFilter('7')
  // Only item-7 survives; the selected index must clamp to it.
  assert.equal(picker.getSelectedItem()?.value, '7')
  picker.handleInput('\x1b[6~') // pageDown
  assert.equal(picker.getSelectedItem()?.value, '7')
  picker.handleInput('\x1b[A') // up
  assert.equal(picker.getSelectedItem()?.value, '7')
})

test('renders a header with the group count before each group', () => {
  const items = [
    { value: 'a', label: 'alpha', group: 'me/dsh-pi-tui' },
    { value: 'b', label: 'beta', group: 'me/dsh-pi-tui' },
    { value: 'c', label: 'gamma', group: 'work/atlasx' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme)
  const rendered = picker.render(80)
  const header1 = rendered.findIndex((line) => line.includes('me/dsh-pi-tui'))
  const header2 = rendered.findIndex((line) => line.includes('work/atlasx'))
  assert.notEqual(header1, -1, 'first group header missing')
  assert.notEqual(header2, -1, 'second group header missing')
  assert.ok(rendered[header1]!.includes('· 2'), `first group count missing: ${rendered[header1]}`)
  assert.ok(rendered[header2]!.includes('· 1'), `second group count missing: ${rendered[header2]}`)
  assert.ok(header1 < rendered.findIndex((line) => line.includes('alpha')), 'header after its items')
  assert.ok(rendered.findIndex((line) => line.includes('alpha')) < header2, 'header before next group')
})

test('uses the groupHeader theme when provided', () => {
  const styled: string[] = []
  const themeWithGroup: SearchablePickerTheme = {
    ...testTheme,
    groupHeader: (text: string) => { styled.push(text); return text },
  }
  const picker = new SearchablePicker([{ value: 'a', label: 'alpha', group: 'g' }], 5, themeWithGroup)
  picker.render(80)
  assert.equal(styled.length, 1)
  assert.ok(styled[0]!.includes('g'))
})

test('mixed grouped/ungrouped rows never inherit a stale group header', () => {
  const items = [
    { value: 'a', label: 'alpha', group: 'g1' },
    { value: 'b', label: 'beta' },
    { value: 'c', label: 'gamma', group: 'g2' },
  ]
  const picker = new SearchablePicker(items, 5, testTheme)
  const rendered = picker.render(80)
  const alphaIndex = rendered.findIndex((line) => line.includes('alpha'))
  const betaIndex = rendered.findIndex((line) => line.includes('beta'))
  const gammaIndex = rendered.findIndex((line) => line.includes('gamma'))
  // The ungrouped row sits between the two groups with no header of its
  // own, and the second group still gets its header.
  assert.ok(rendered[betaIndex]!.includes('beta'), 'ungrouped row missing')
  assert.ok(!rendered[betaIndex]!.includes('g1'), 'ungrouped row must not inherit the previous group')
  assert.ok(rendered[gammaIndex - 1]!.includes('g2'), 'second group header must render after the ungrouped row')
  assert.ok(alphaIndex < betaIndex && betaIndex < gammaIndex, 'row order must be preserved')
})

test('shows filtered/total counts in the header', () => {
  const picker = new SearchablePicker(
    [{ value: 'a', label: 'alpha' }, { value: 'b', label: 'zulu' }, { value: 'c', label: 'mike' }],
    5,
    testTheme,
    {},
    { enableSearch: true, header: 'sessions' },
  )
  picker.handleInput('z')
  const rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('1/3')), `counts missing: ${JSON.stringify(rendered)}`)
})

test('renders a hint footer when search is enabled', () => {
  const picker = new SearchablePicker([{ value: 'a', label: 'alpha' }], 5, testTheme, {}, { enableSearch: true })
  const rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('type to filter')), 'hint missing')
})

test('keeps the compact height without hints for inline usage', () => {
  const picker = new SearchablePicker([{ value: 'a', label: 'alpha' }], 5, testTheme)
  const rendered = picker.render(80)
  assert.ok(!rendered.some((line) => line.includes('navigate')), 'hint must not render by default')
})

test('reflows to a live row budget without losing selection or hint', () => {
  const picker = new SearchablePicker(
    Array.from({ length: 12 }, (_, index) => ({ value: `v${index}`, label: `item ${index}` })),
    10,
    testTheme,
    {},
    { header: 'items', showHint: true },
  )
  for (let index = 0; index < 8; index++) picker.handleInput('\x1b[B')
  picker.setMaxRows(8)
  const rendered = picker.render(80)
  assert.ok(rendered.some((line) => line.includes('item 8')), 'selected item must remain visible')
  assert.ok(rendered.some((line) => line.includes('esc close')), 'hint must remain visible')
  assert.ok(rendered.length <= 8, 'list must fit the live row budget')
})

test('keeps the hint when a grouped window exceeds a small row budget', () => {
  const items = Array.from({ length: 9 }, (_, index) => ({
    value: `v${index}`,
    label: `item ${index}`,
    group: index < 3 ? 'alpha' : index < 6 ? 'beta' : 'gamma',
  }))
  const picker = new SearchablePicker(items, 10, testTheme, {}, { header: 'items', showHint: true })
  // 6-row grant: header(2) + hint(2) + indicator(1) + group(1)
  // leaves a zero item budget; the render must still fit the grant
  // and keep the hint plus the selected row.
  picker.setMaxRows(6)
  picker.handleInput('\x1b[B') // select item 1 (still alpha)
  const rendered = picker.render(80)
  assert.ok(rendered.length <= 6, `grouped list must fit the grant (${rendered.length})`)
  assert.ok(rendered.some((line) => line.includes('esc close')), 'hint must remain visible')
  assert.ok(rendered.some((line) => line.includes('item 1')), 'selected item must remain visible')
})

test('restores the full window after a selection move (no render-time ratchet)', () => {
  // Runs: a[0,1], b[2-6], c[7,8], d[9-11]. At selection 0 the
  // window straddles a/b and shrinks; moving into the b run must
  // restore the full 4-item window — the render-time shrink is a
  // LOCAL adjustment, never a persistent maxVisible ratchet.
  const groups = ['a', 'a', 'b', 'b', 'b', 'b', 'b', 'c', 'c', 'd', 'd', 'd']
  const items = groups.map((group, index) => ({ value: `v${index}`, label: `item ${index}`, group }))
  const picker = new SearchablePicker(items, 10, testTheme, {}, { header: 'items', showHint: true })
  picker.setMaxRows(10) // budget: header 2 + hint 2 + indicator 1 + group 1 -> 4
  const first = picker.render(80)
  assert.ok(first.some((line) => line.includes('item 1')), 'first window must show the selected region')
  for (let index = 0; index < 4; index++) picker.handleInput('\x1b[B') // -> item 4
  const second = picker.render(80)
  assert.ok(second.some((line) => line.includes('item 2')),
    `the full 4-item window must return inside the b run (${JSON.stringify(second)})`)
  assert.ok(second.some((line) => line.includes('item 5')), 'the window must reach item 5')
})

test('fits the no-match state to the row grant, keeping the message and hint', () => {
  const picker = new SearchablePicker(
    [{ value: 'a', label: 'alpha' }, { value: 'b', label: 'beta' }],
    10,
    testTheme,
    {},
    { header: 'items', enableSearch: true },
  )
  picker.setMaxRows(6) // header 2 + search 2 + message 1 + hint 2 = 7 > 6
  picker.handleInput('zzz') // no match
  const rendered = picker.render(80)
  assert.ok(rendered.length <= 6, `no-match must fit the grant (${rendered.length})`)
  assert.ok(rendered.some((line) => line.includes('No matching')), 'message must survive')
  assert.ok(rendered.some((line) => line.includes('esc close')), 'hint must survive')
})

test('keeps the message over the header on an extreme no-match grant', () => {
  const picker = new SearchablePicker(
    [{ value: 'a', label: 'alpha' }],
    10,
    testTheme,
    {},
    { header: 'items', enableSearch: true },
  )
  picker.setMaxRows(2) // compact rows: header/search/message/hint = 4 > 2
  picker.handleInput('zzz') // no match
  const rendered = picker.render(80)
  assert.ok(rendered.length <= 2, `extreme no-match must fit the grant (${rendered.length})`)
  assert.ok(rendered.some((line) => line.includes('No matching')),
    'the no-match message must beat the header')
  assert.ok(!rendered.some((line) => line.includes('items')), 'the header must yield')
})

test('focused=true reaches the search Input (cursor marker)', () => {
  const picker = new SearchablePicker([{ value: 'a', label: 'alpha' }], 5, testTheme, {}, { enableSearch: true })
  picker.focused = true
  const focused = picker.render(80)
  assert.ok(focused.some((line) => line.includes(CURSOR_MARKER)), 'focused picker must emit the cursor marker')
  picker.focused = false
  const unfocused = picker.render(80)
  assert.ok(!unfocused.some((line) => line.includes(CURSOR_MARKER)), 'unfocused picker must not emit the marker')
})

test('focused=true is inert without a search input', () => {
  const picker = new SearchablePicker([{ value: 'a', label: 'alpha' }], 5, testTheme)
  picker.focused = true
  const rendered = picker.render(80)
  assert.ok(!rendered.some((line) => line.includes(CURSOR_MARKER)), 'no search input means no marker')
})

/** A minimal mouse event for direct component tests. */
function mouse(
  type: 'press' | 'click' | 'wheel',
  x: number,
  y: number,
  width = 80,
  height = 10,
  wheelDelta?: number,
): import('@xmoon76/pi-tui').TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
    ...(type === 'wheel' ? { wheelDelta: wheelDelta ?? 1 } : {}),
  }
}

const plainItems = [
  { value: 'a', label: 'alpha' },
  { value: 'b', label: 'bravo' },
  { value: 'c', label: 'charlie' },
]

test('mouse press selects a row and click activates the pressed value (mouse parity)', () => {
  const selected: string[] = []
  const activated: string[] = []
  const picker = new SearchablePicker(plainItems, 5, testTheme, {}, { enableSearch: true })
  picker.onSelectionChange = (item) => { selected.push(item.value) }
  picker.onSelect = (item) => { activated.push(item.value) }
  picker.render(80)
  // Rows: 0=search, 1=blank, 2=alpha, 3=bravo, 4=charlie.
  const press = picker.handleMouse(mouse('press', 5, 3, 80, 10))
  assert.ok(press?.handled, 'press on an item row must be handled')
  assert.equal(press?.focus, true, 'press must request focus')
  assert.equal(picker.getSelectedIndex(), 1, 'press must select the pressed row')
  assert.deepEqual(selected, ['b'], 'press must fire onSelectionChange on a real change')
  picker.handleMouse(mouse('click', 5, 3, 80, 10))
  assert.deepEqual(activated, ['b'], 'click must activate the pressed value')
})

test('async setItems between press and click cannot transfer activation (mouse parity)', () => {
  const activated: string[] = []
  const picker = new SearchablePicker(plainItems, 5, testTheme, {}, { enableSearch: true })
  picker.onSelect = (item) => { activated.push(item.value) }
  picker.render(80)
  picker.handleMouse(mouse('press', 5, 2, 80, 10)) // press 'a'
  // Async refresh: a different item moves into the same physical row.
  picker.setItems([
    { value: 'x', label: 'xray' },
    { value: 'b', label: 'bravo' },
    { value: 'c', label: 'charlie' },
  ])
  picker.render(80)
  picker.handleMouse(mouse('click', 5, 2, 80, 10)) // click the same physical row
  assert.deepEqual(activated, [], 'activation must not transfer to the new item')
})

test('group headers, scroll indicator, and hint are inert (mouse parity)', () => {
  const items = [
    { value: 'a', label: 'alpha', group: 'g1' },
    { value: 'b', label: 'bravo', group: 'g1' },
    { value: 'c', label: 'charlie', group: 'g2' },
  ]
  const picker = new SearchablePicker(items, 2, testTheme, {}, { enableSearch: true })
  const rendered = picker.render(80)
  const headerRow = rendered.findIndex(line => line.includes('g1'))
  const hintRow = rendered.findIndex(line => line.includes('navigate'))
  const scrollRow = rendered.findIndex(line => line.includes('(') && line.includes('/'))
  assert.ok(headerRow >= 0 && hintRow >= 0 && scrollRow >= 0, `chrome rows missing:\n${rendered.join('\n')}`)
  assert.equal(picker.handleMouse(mouse('press', 5, headerRow, 80, 10)), undefined, 'group header must be inert')
  assert.equal(picker.handleMouse(mouse('press', 5, hintRow, 80, 10)), undefined, 'hint must be inert')
  assert.equal(picker.handleMouse(mouse('press', 5, scrollRow, 80, 10)), undefined, 'scroll indicator must be inert')
})

test('wheel moves filtered selection (mouse parity)', () => {
  const picker = new SearchablePicker(plainItems, 5, testTheme, {}, { enableSearch: true })
  picker.render(80)
  // Wheel up (negative delta) wraps to the last item like the keyboard.
  const up = picker.handleMouse(mouse('wheel', 5, 2, 80, 10, -1))
  assert.ok(up?.handled, 'wheel must be handled')
  assert.equal(picker.getSelectedIndex(), 2, 'wheel up must wrap to the last item')
  picker.handleMouse(mouse('wheel', 5, 2, 80, 10, 1))
  assert.equal(picker.getSelectedIndex(), 0, 'wheel down must wrap to the first item')
})

test('search Input click repositions the search cursor (mouse parity)', () => {
  const picker = new SearchablePicker(plainItems, 5, testTheme, {}, { enableSearch: true })
  picker.render(80)
  picker.handleInput('ab')
  picker.render(80)
  // Click between a and b: the search row is y=0 and the Input prompt
  // "> " is 2 columns, so value column 1 is at x=3.
  const result = picker.handleMouse(mouse('press', 3, 0, 80, 10))
  assert.ok(result?.handled, 'press on the search row must be handled')
  picker.handleInput('X')
  const rendered = picker.render(80).map(line => line.replace(/\x1b\[[0-9;]*m/gu, ''))
  assert.ok(rendered.some(line => line.includes('aXb')), 'typing after the click must insert at the clicked filter column')
})

test('tiny-budget sliced rows keep hit-map alignment (mouse parity)', () => {
  const items = Array.from({ length: 6 }, (_, index) => ({ value: `v${index}`, label: `item ${index}` }))
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true })
  picker.setMaxRows(4)
  const rendered = picker.render(80)
  assert.ok(rendered.length <= 4, `tiny budget must cap rows: ${rendered.length}`)
  // The first visible row is an item (the tail slice keeps item + chrome).
  const press = picker.handleMouse(mouse('press', 5, 0, 80, 4))
  assert.ok(press?.handled, 'the sliced item row must still be clickable')
  assert.equal(picker.getSelectedIndex(), 0, 'the sliced hit map must select the visible item')
  // The hint (last row) stays inert.
  const hintRow = rendered.findIndex(line => line.includes('navigate'))
  if (hintRow >= 0) {
    assert.equal(picker.handleMouse(mouse('press', 5, hintRow, 80, 4)), undefined, 'sliced hint must be inert')
  }
})

test('delegated search press replaces the stale pressed value (mouse parity)', () => {
  const items = Array.from({ length: 6 }, (_, index) => ({ value: `v${index}`, label: `item ${index}` }))
  const activated: string[] = []
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true })
  picker.onSelect = (item) => { activated.push(item.value) }
  picker.render(80)
  // Rows: 0=search, 1=blank, 2=v0 ... 6=v4.
  // 1. Press v4: the gesture latch is 'v4'.
  picker.handleMouse(mouse('press', 5, 6, 80, 10))
  // 2. Press the search row: the Input handles it (handled+focus, target
  //    rewritten to the picker), but the parent's gesture identity must
  //    be REPLACED — a delegated press is a fresh gesture, not a
  //    continuation of the item press.
  picker.handleMouse(mouse('press', 5, 0, 80, 10))
  // 3. The terminal shrinks between press and release: the tail slice
  //    drops the search box and v4 (the selected row) moves to row 0.
  picker.setMaxRows(4)
  picker.render(80)
  // 4. Release on the same physical cell: the synthesized click must
  //    NOT activate v4 — the stale latch was replaced by the search press.
  picker.handleMouse(mouse('click', 5, 0, 80, 4))
  assert.deepEqual(activated, [], 'the stale pressed value must not activate the moved item')
})

test('TUI click synthesis cannot activate a stale pressed value after a delegated search press (mouse parity)', async () => {
  const terminal = new VirtualTerminal(20, 10)
  const tui = new TuiAltScreen(terminal)
  const items = Array.from({ length: 6 }, (_, index) => ({ value: `v${index}`, label: `item ${index}` }))
  const picker = new SearchablePicker(items, 5, testTheme, {}, { enableSearch: true })
  const activated: string[] = []
  picker.onSelect = (item) => { activated.push(item.value) }
  tui.start()
  tui.showOverlay(picker, { anchor: 'top-left', width: 20 })
  await terminal.waitForRender()
  // 1. Press v4 (row 6): the TUI saves the picker as the press target.
  terminal.sendInput('\x1b[<0;1;7M')
  await terminal.waitForRender()
  // 2. Move away and release on a DIFFERENT cell: no click is
  //    synthesized and the gesture (and its pressed value) is abandoned.
  terminal.sendInput('\x1b[<0;1;8m')
  await terminal.waitForRender()
  // 3. Press the search row (row 0): a FRESH gesture — handled, target
  //    rewritten to the picker — so the old pressed value must be
  //    replaced.
  terminal.sendInput('\x1b[<0;1;1M')
  await terminal.waitForRender()
  // 4. Shrink + repaint: the tail slice drops the search box and v4
  //    (the selected row) moves to row 0.
  picker.setMaxRows(4)
  tui.requestRender()
  await terminal.waitForRender()
  // 5. Release on the same physical cell: the synthesized click must
  //    not activate v4 — the stale latch was replaced by the search press.
  terminal.sendInput('\x1b[<0;1;1m')
  await terminal.waitForRender()
  assert.deepEqual(activated, [], 'the stale pressed value must not activate the moved item')
  tui.stop()
})

test('stale-width events are rejected (mouse parity)', () => {
  const picker = new SearchablePicker(plainItems, 5, testTheme, {}, { enableSearch: true })
  picker.render(80)
  // A resize that has not been repainted must not dispatch against the
  // old hit map.
  assert.equal(picker.handleMouse(mouse('press', 5, 2, 60, 10)), undefined, 'stale-width press must be rejected')
})

test('async setItems WITHOUT a repaint between press and click cannot transfer activation (mouse parity)', () => {
  const activated: string[] = []
  const picker = new SearchablePicker(plainItems, 5, testTheme, {}, { enableSearch: true })
  picker.onSelect = (item) => { activated.push(item.value) }
  picker.render(80)
  picker.handleMouse(mouse('press', 5, 2, 80, 10)) // press 'a'
  // Async refresh WITHOUT a repaint: the hit map is still last-painted
  // geometry, but the CURRENT filtered list has a different item at the
  // same index. The click must resolve by the pressed VALUE, not the
  // stale index.
  picker.setItems([
    { value: 'x', label: 'xray' },
    { value: 'b', label: 'bravo' },
    { value: 'c', label: 'charlie' },
  ])
  picker.handleMouse(mouse('click', 5, 2, 80, 10)) // click the same physical row
  assert.deepEqual(activated, [], 'activation must not transfer to the replacement at the stale index')
})

test('async setItems WITHOUT a repaint between paint and press cannot select the replacement (mouse parity)', () => {
  const selected: string[] = []
  const picker = new SearchablePicker(plainItems, 5, testTheme, {}, { enableSearch: true })
  picker.onSelectionChange = (item) => { selected.push(item.value) }
  picker.render(80)
  // Async refresh WITHOUT a repaint: the hit map is still last-painted
  // geometry, but the CURRENT filtered list has a different item at the
  // same index. The press must resolve by the pressed VALUE, not the
  // stale index.
  picker.setItems([
    { value: 'x', label: 'xray' },
    { value: 'b', label: 'bravo' },
    { value: 'c', label: 'charlie' },
  ])
  const press = picker.handleMouse(mouse('press', 5, 2, 80, 10)) // press the old 'a' row
  assert.equal(press, undefined, 'a press on a row whose value no longer exists must be rejected')
  assert.deepEqual(selected, [], 'the press must not select the replacement at the stale index')
})
