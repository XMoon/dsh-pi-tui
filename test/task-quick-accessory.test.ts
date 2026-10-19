/**
 * Phase 3B / B4-A — the passive Task Quick accessory and its ONE projection.
 *
 * L1 coverage of the two pure owners the passive below-editor window is built
 * from:
 * - `planTaskQuickLayout` + `TaskQuickAccessory`: the grant ladder, the
 *   single-physical-row projection, the row-identity window anchor and the
 *   LAST-PAINTED wheel geometry;
 * - `quickTaskProjection`: the Quick active/ancestor/attention policy over the
 *   runtime's committed rows, with the modal-only promotion row removed.
 *
 * The real painted frame (mount, budget, editor/footer/transcript survival, an
 * SGR wheel over the live box) is the L6 suite's job — a component test never
 * substitutes for it.
 * @module @xmoon76/dsh-pi-tui/task-quick-accessory.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import type { TuiMouseEvent } from '@xmoon76/pi-tui'
import { eastAsianWidthType } from 'get-east-asian-width'
import { TaskQuickAccessory, TASK_QUICK_MAX_ROWS, planTaskQuickLayout, type TaskQuickLayout } from '../src/tui/panels/task-quick-accessory.ts'
import { quickTaskProjection } from '../src/app/surface/task-runtime.ts'
import { buildTaskRows } from '../src/domain/task/browser.ts'
import { color, setTheme } from '../src/tui/theme/runtime.ts'
import type { TaskPanelItem } from '../src/app/surface/task-presentation.ts'
import type { QuestionAttentionRow } from '../src/app/surface/question-controller.ts'

const SGR = /\x1b\[[0-9;]*m/g
const strip = (text: string): string => text.replace(SGR, '')

afterEach(() => setTheme('dark'))

/** The frozen B4-A grant ladder at chrome = 4 (a three-row editor seat plus the
 *  one-row footer — the ordinary surface's steady state). */
test('grant ladder: separator when everything fits, then header, then 1 row, then 0 (B4-B addendum)', () => {
  const at = (rows: number, total = 12): TaskQuickLayout => planTaskQuickLayout(80, rows, 4, total, 0)
  // 24 rows: the new ceiling — separator + identity + three task rows.
  assert.deepEqual(at(24), { width: 80, grant: 5, header: true, separator: true, itemRows: 3, start: 0, count: 3, total: 12 })
  // 20 rows (the 44-column matrix height): still the full window.
  assert.equal(at(20).grant, 5)
  assert.equal(at(20).separator, true)
  assert.equal(at(20).itemRows, 3)
  // 12 rows: identity + two task rows — the separator yields to task rows.
  assert.equal(at(12).grant, 3)
  assert.equal(at(12).header, true)
  assert.equal(at(12).separator, false)
  assert.equal(at(12).itemRows, 2)
  // 10 and 8 rows: the proportional share degrades to identity + ONE task row.
  assert.equal(at(10).grant, 2)
  assert.equal(at(10).separator, false)
  assert.equal(at(10).itemRows, 1)
  assert.equal(at(8).grant, 2)
  assert.equal(at(8).itemRows, 1)
  // 6 rows: a lone granted row is spent on content, never on a header.
  assert.equal(at(6).grant, 1)
  assert.equal(at(6).header, false)
  assert.equal(at(6).separator, false)
  assert.equal(at(6).itemRows, 1)
  // 4 rows: the editor seat and the footer alone consume the frame — 0 grant.
  assert.equal(at(4).grant, 0)
  assert.equal(at(4).count, 0)
  // The ceiling is the accessory's own budget, never a terminal-size threshold.
  assert.ok(at(200).grant <= TASK_QUICK_MAX_ROWS)
})

test('grant 0..5 × N=1/2/≥3 paints the exact addendum divider/header/task matrix', () => {
  const matrix = [
    { total: 1, actualGrants: [0, 1, 2, 3, 3, 3], separators: [false, false, false, true, true, true], taskRows: [0, 1, 1, 1, 1, 1] },
    { total: 2, actualGrants: [0, 1, 2, 3, 4, 4], separators: [false, false, false, false, true, true], taskRows: [0, 1, 1, 2, 2, 2] },
    { total: 4, actualGrants: [0, 1, 2, 3, 4, 5], separators: [false, false, false, false, false, true], taskRows: [0, 1, 1, 2, 3, 3] },
  ] as const

  for (const scenario of matrix) {
    for (let requestedGrant = 0; requestedGrant <= 5; requestedGrant += 1) {
      const terminalRows = 40
      const chromeRows = terminalRows - requestedGrant - 1
      const h = harness({ cols: 80, rows: terminalRows, chrome: chromeRows })
      const items = Array.from({ length: scenario.total }, (_, index) => item(`task-${scenario.total}-${index + 1}`))
      h.accessory.setItems(items)
      h.accessory.focused = true
      assert.ok(h.accessory.activate(), `N=${scenario.total}, requested grant=${requestedGrant}`)

      const layout = planTaskQuickLayout(80, terminalRows, chromeRows, scenario.total, 0)
      const expectedGrant = scenario.actualGrants[requestedGrant]!
      const expectedTaskRows = scenario.taskRows[requestedGrant]!
      const expectedSeparator = scenario.separators[requestedGrant]!
      assert.equal(layout.grant, expectedGrant, `N=${scenario.total}, room grant=${requestedGrant}`)
      assert.equal(layout.separator, expectedSeparator, `N=${scenario.total}, grant=${expectedGrant}`)
      assert.equal(layout.header, expectedGrant >= 2, `N=${scenario.total}, grant=${expectedGrant}`)
      assert.equal(layout.count, expectedTaskRows, `N=${scenario.total}, grant=${expectedGrant}`)

      const lines = h.accessory.render(80)
      assert.equal(lines.length, expectedGrant, `painted rows never exceed the grant; N=${scenario.total}, grant=${expectedGrant}`)
      let row = 0
      if (expectedSeparator) {
        assert.match(strip(lines[row]!), /^─+$/, 'the optional divider is the first painted row')
        row += 1
      }
      if (layout.header) {
        assert.match(strip(lines[row]!), /^Task Quick\s+showing 1-\d+\//, 'identity follows the optional divider')
        row += 1
      }
      const paintedTasks = lines.slice(row).map(strip)
      assert.equal(paintedTasks.length, expectedTaskRows)
      for (let index = 0; index < paintedTasks.length; index += 1) {
        assert.ok(paintedTasks[index]!.includes(`task-${scenario.total}-${index + 1}`),
          `task rows retain their order after divider/header: ${paintedTasks.join(' | ')}`)
      }
      if (paintedTasks.length > 0) assert.match(paintedTasks[0]!, /^> /, 'the active marker belongs to the first task row')
    }
  }
})

test('grant ladder: an empty projection paints no row at any size', () => {
  for (const rows of [200, 24, 10, 6]) {
    const layout = planTaskQuickLayout(80, rows, 4, 0, 0)
    assert.equal(layout.grant, 0)
    assert.equal(layout.count, 0)
    assert.equal(layout.total, 0)
  }
})

test('grant ladder: one real item never paints a header-only frame', () => {
  const one = planTaskQuickLayout(80, 24, 4, 1, 0)
  assert.equal(one.header, true)
  assert.equal(one.separator, true)
  assert.equal(one.itemRows, 1)
  assert.equal(one.count, 1)
  const short = planTaskQuickLayout(80, 6, 4, 1, 0)
  assert.equal(short.header, false)
  assert.equal(short.separator, false)
  assert.equal(short.count, 1)
})

test('the optional Full action joins navigation but never task totals or empty projections', () => {
  const withAction = planTaskQuickLayout(80, 40, 4, 1, 0, true)
  assert.deepEqual(withAction, {
    width: 80,
    grant: 4,
    header: true,
    separator: true,
    itemRows: 2,
    start: 0,
    count: 2,
    total: 1,
  })
  const withoutAction = planTaskQuickLayout(80, 40, 4, 1, 0)
  assert.equal(withoutAction.count, 1, 'absence of the callback preserves task-only navigation')
  const empty = planTaskQuickLayout(80, 40, 4, 0, 0, true)
  assert.equal(empty.grant, 0)
  assert.equal(empty.count, 0, 'the action never appears without a real task')
  assert.equal(empty.total, 0)
  const emptyProjection = harness({ openFull: true })
  emptyProjection.accessory.setItems([])
  assert.equal(emptyProjection.accessory.activate(), false, 'the action cannot focus an empty Quick')
  assert.deepEqual(emptyProjection.accessory.render(80), [])
})

test('the Full action is omitted without its callback', () => {
  const h = harness()
  focus(h, [item('job:a'), item('job:b')])
  const rows = h.accessory.render(80).map(strip)
  assert.ok(!rows.some(row => row.includes('Open Task Center…')))
  h.accessory.handleInput('\x1b[B')
  h.accessory.handleInput('\x1b[B')
  h.accessory.handleInput('\x1b[B')
  assert.equal(h.accessory.selected, 'job:b', 'task-only navigation clamps at the last real task')
  assert.equal(h.fullOpens(), 0)
})

test('the typed Full action follows all real tasks and never enters task selection routing', () => {
  const h = harness({ openFull: true })
  const tasks = [item('job:a'), item('job:b'), item('job:c'), item('job:d')]
  focus(h, tasks)
  assert.equal(h.accessory.getItems().length, 4)
  for (let index = 0; index < tasks.length; index += 1) h.accessory.handleInput('\x1b[B')

  const rows = h.accessory.render(80).map(strip)
  const actionRow = rows.find(row => row.includes('Open Task Center…'))
  assert.ok(actionRow?.startsWith('> ➜ Open Task Center…'), `the last navigation target is selected:
${rows.join('\n')}`)
  assert.equal(h.accessory.selected, undefined, 'the Full action is not exposed as a TaskPanelItem value')
  assert.deepEqual(h.activations(), [], 'navigating to the action cannot produce a fake task selection')
  h.accessory.handleInput('\x1b[B')
  h.accessory.handleInput('\r')
  assert.equal(h.fullOpens(), 1, 'Enter on the typed action invokes the Full callback')
  assert.deepEqual(h.activations(), [], 'the action never calls onActivate')
  h.accessory.handleInput('\x1b[A')
  assert.equal(h.accessory.selected, 'job:d', 'Up returns from open-full to the last real task')
})

test('PageDown uses the painted navigation window, including the action target', () => {
  const h = harness({ openFull: true })
  focus(h, [item('job:a'), item('job:b'), item('job:c'), item('job:d')])
  const initial = h.accessory.render(80)
  assert.equal(initial.length, 5, 'the painted window is divider + identity + three navigation rows')

  h.accessory.handleInput('\x1b[6~')
  assert.equal(h.accessory.selected, 'job:d', 'the first page advances by three painted navigation rows')
  h.accessory.handleInput('\x1b[6~')
  assert.equal(h.accessory.selected, undefined, 'the next page clamps to the appended Full action')
  const actionRow = h.accessory.render(80).map(strip).find(row => row.includes('Open Task Center…'))
  assert.ok(actionRow?.startsWith('> ➜ Open Task Center…'))
})

test('the action remains the final navigation target after 100 real task values', () => {
  const tasks = Array.from({ length: 100 }, (_, index) => item(`job:${index + 1}`))
  const h = harness({ openFull: true })
  focus(h, tasks)
  for (let index = 0; index < tasks.length; index += 1) h.accessory.handleInput('\x1b[B')

  const rows = h.accessory.render(80).map(strip)
  const actionRow = rows.find(row => row.includes('Open Task Center…'))
  assert.ok(actionRow?.startsWith('> ➜ Open Task Center…'))
  assert.equal(h.accessory.selected, undefined)
  assert.equal(h.accessory.getItems().length, 100)
  assert.equal(planTaskQuickLayout(80, 40, 4, 100, 100, true).total, 100)
})

test('open-full selection survives task insertion, reorder and status refresh', () => {
  const h = harness({ openFull: true })
  focus(h, [item('job:a'), item('job:b'), item('job:c')])
  h.accessory.render(80)
  for (let index = 0; index < 3; index += 1) h.accessory.handleInput('\x1b[B')
  assert.equal(h.accessory.selected, undefined)

  h.accessory.setItems([
    item('job:x'), item('job:c'), item('job:a', { status: 'failed' }), item('job:b'),
  ])
  assert.equal(h.accessory.selected, undefined, 'a surviving typed action remains selected after N changes')
  const rows = h.accessory.render(80).map(strip)
  const actionRow = rows.find(row => row.includes('Open Task Center…'))
  assert.ok(actionRow?.startsWith('> ➜ Open Task Center…'))
  assert.equal(h.accessory.getItems().length, 4)
  assert.match(rows[1]!, /showing 3-4\/4$/, 'the header still counts visible real task rows only')

  h.accessory.setItems([])
  assert.equal(h.exits(), 1, 'emptying real tasks still notifies the ACTIVE host')
  assert.equal(h.fullOpens(), 0, 'an action cannot keep an empty Quick active')
  h.accessory.deactivate()
  h.accessory.focused = false
  assert.deepEqual(h.accessory.render(80), [])
})

test('wheel reaches the action window without changing Enter before repaint', () => {
  const h = harness({ openFull: true })
  focus(h, [item('job:a'), item('job:b'), item('job:c'), item('job:d'), item('job:e')])
  h.accessory.render(80)
  for (let index = 0; index < 3; index += 1) h.accessory.handleMouse(wheel(1, 1))

  const scrolled = h.accessory.render(80).map(strip)
  assert.match(scrolled[1]!, /showing 4-5\/5$/, 'the task range ignores the visible action tail')
  assert.ok(scrolled.some(row => row.includes('➜ Open Task Center…')), 'wheel scrolling reaches the action row')
  assert.equal(h.accessory.selected, 'job:d', 'wheel paint clamps selection to the new visible task edge')
  h.accessory.handleInput('\x1b[B')
  h.accessory.handleInput('\x1b[B')
  const selectedAction = h.accessory.render(80).map(strip).find(row => row.includes('Open Task Center…'))
  assert.ok(selectedAction?.startsWith('> ➜ Open Task Center…'))

  const pending = harness({ openFull: true })
  focus(pending, [item('job:a'), item('job:b'), item('job:c'), item('job:d'), item('job:e')])
  pending.accessory.render(80)
  for (let index = 0; index < 3; index += 1) pending.accessory.handleMouse(wheel(1, 1))
  pending.accessory.handleInput('\r')
  assert.deepEqual(pending.activations(), ['job:a'], 'Enter before repaint keeps the last painted real task')
  assert.equal(pending.fullOpens(), 0, 'wheel-pending action visibility cannot synthesize an action selection')
})

test('the Full action keeps the real-task range and renders one clipped physical row', () => {
  for (const cols of [44, 80, 120]) {
    const h = harness({ cols, rows: 40, chrome: 4, openFull: true })
    focus(h, [item('job:a')])
    const before = h.accessory.render(cols)
    const plainBefore = before.map(strip)
    assert.match(plainBefore[1]!, /^Task Quick\s+showing 1-1\/1$/, 'the action is excluded from N')
    const unselected = before.find(row => strip(row).includes('Open Task Center…'))!
    assert.ok(strip(unselected).startsWith('  ➜ Open Task Center…'))
    assert.ok(unselected.includes(color.textMuted('➜ ')), 'the arrow remains textMuted')
    assert.ok(unselected.includes(color.textMuted('Open Task Center…')), 'the unselected label is textMuted')
    assert.equal(visibleWidth(unselected), cols)
    assert.equal(visibleWidth('➜'), 1)
    assert.equal(eastAsianWidthType('➜'.codePointAt(0)!), 'neutral')

    h.accessory.handleInput('\x1b[B')
    const selected = h.accessory.render(cols).find(row => strip(row).includes('Open Task Center…'))!
    assert.ok(strip(selected).startsWith('> ➜ Open Task Center…'))
    assert.ok(selected.includes(color.textMuted('➜ ')), 'selection does not recolor the arrow')
    assert.ok(selected.includes(color.textStrong('Open Task Center…')), 'the selected label is textStrong')
    assert.equal(visibleWidth(selected), cols)
  }
})

test('an action-only visible window has no fabricated task position', () => {
  const h = harness({ rows: 12, chrome: 9, openFull: true })
  focus(h, [item('job:a')])
  h.accessory.render(80)
  h.accessory.handleInput('\x1b[B')

  const rows = h.accessory.render(80).map(strip)
  assert.equal(rows.length, 2)
  assert.equal(rows[0]!.trimEnd(), 'Task Quick')
  assert.ok(!rows[0]!.includes('showing') && !rows[0]!.includes('/1'))
  assert.ok(rows[1]!.startsWith('> ➜ Open Task Center…'))
  assert.equal(h.accessory.anchoredValue, undefined, 'an action anchor is not a task value')
})

test('grant ladder: the transcript floor, the chrome and the accessory ceiling are all kept', () => {
  for (const rows of [200, 60, 40, 24, 20, 12, 10, 8, 6, 5, 4, 3]) {
    for (const chrome of [0, 1, 4, 8]) {
      const layout = planTaskQuickLayout(120, rows, chrome, 12, 5)
      assert.ok(layout.grant <= TASK_QUICK_MAX_ROWS, `ceiling: ${rows}/${chrome}`)
      assert.ok(layout.start >= 0 && layout.start + layout.count <= layout.total, `window: ${rows}/${chrome}`)
      if (layout.grant === 0) continue
      assert.ok(layout.count <= layout.itemRows, `capacity: ${rows}/${chrome}`)
      assert.ok(layout.count <= layout.grant, `grant: ${rows}/${chrome}`)
      assert.ok(layout.grant <= 12 + 1, `demand: ${rows}/${chrome}`)
      assert.ok(rows - chrome - layout.grant >= 1, `transcript floor: ${rows}/${chrome}`)
    }
  }
})

interface Harness {
  readonly accessory: TaskQuickAccessory
  readonly geometry: { cols: number; rows: number; chrome: number }
  /** The host-side exits the accessory requested (Up-at-first / Esc / empty). */
  exits(): number
  /** The typed selections the accessory committed (Enter / same-row click). */
  activations(): string[]
  /** Full Center callbacks, kept separate from real task selections. */
  fullOpens(): number
  renders(): number
}

function harness(initial: { cols?: number; rows?: number; chrome?: number; openFull?: boolean } = {}): Harness {
  const geometry = { cols: initial.cols ?? 80, rows: initial.rows ?? 24, chrome: initial.chrome ?? 4 }
  let renders = 0
  let exitCount = 0
  let fullOpenCount = 0
  const activated: string[] = []
  const accessory = new TaskQuickAccessory({
    geometry: {
      columns: () => geometry.cols,
      rows: () => geometry.rows,
      chromeRows: () => geometry.chrome,
    },
    onRequestRender: () => { renders += 1 },
    onExit: () => { exitCount += 1 },
    onActivate: (value) => { activated.push(value) },
    onOpenFull: initial.openFull === true ? () => { fullOpenCount += 1 } : undefined,
    onEmpty: () => { exitCount += 1 },
    onFirstPaint: () => {},
  })
  return {
    accessory,
    geometry,
    exits: () => exitCount,
    activations: () => [...activated],
    fullOpens: () => fullOpenCount,
    renders: () => renders,
  }
}

/** B4-B: the accessory paints only while focused — focus it like the host
 *  does (activate selects the first row, the TUI writes `focused`), the
 *  test-level equivalent of `enterTaskQuick`. */
function focus(h: ReturnType<typeof harness>, initial: readonly TaskPanelItem[]): void {
  h.accessory.setItems([...initial])
  assert.ok(h.accessory.activate(), 'the harness entry must find a row')
  h.accessory.focused = true
}

function item(value: string, patch: Partial<TaskPanelItem> = {}): TaskPanelItem {
  return { value, label: value, status: 'running', ...patch }
}

const WHEEL_BOX = { width: 80, height: 5 }

function wheel(delta: number, y: number, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
  return {
    type: 'wheel',
    button: 'none',
    x: 4,
    y,
    screenX: 4,
    screenY: y,
    width: WHEEL_BOX.width,
    height: WHEEL_BOX.height,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: delta,
    ...overrides,
  }
}

test('a painted frame is exactly its grant and every row is one physical row', () => {
  const { accessory } = harness()
  accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d')])
  accessory.focused = true
  assert.ok(accessory.activate())
  const lines = accessory.render(80)
  // B4-B addendum: separator + identity + three task rows (grant 5).
  assert.equal(lines.length, 5)
  assert.deepEqual(lines.map(line => visibleWidth(line)), [80, 80, 80, 80, 80])
  assert.match(strip(lines[0]!), /^─+$/, 'the separator is the FIRST painted row')
  assert.equal(strip(lines[0]!), '─'.repeat(80), 'the rule spans the component width exactly')
  assert.match(strip(lines[1]!), /^Task Quick\s+showing 1-3\/4$/)
  assert.match(strip(lines[2]!), /job:a\s+‣ Running$/)
  assert.match(strip(lines[3]!), /job:b\s+‣ Running$/)
  assert.match(strip(lines[4]!), /job:c\s+‣ Running$/)
})

test('a one-row grant spends the row on content and keeps the position at its tail', () => {
  const { accessory } = harness({ rows: 6 })
  accessory.setItems([item('job:a'), item('job:b'), item('job:c')])
  accessory.focused = true
  assert.ok(accessory.activate())
  const lines = accessory.render(80)
  assert.equal(lines.length, 1)
  assert.equal(visibleWidth(lines[0]!), 80)
  // B4-B: the ACTIVE one-row frame paints the selection marker on the only
  // (selected) row and keeps the compact position at the tail.
  assert.match(strip(lines[0]!), /^> job:a\s+‣ Running\s+1-1\/3$/)
})

test('the window shows the REAL N: the row total, never a pseudo row', () => {
  const { accessory, geometry } = harness()
  accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d')])
  accessory.focused = true
  assert.ok(accessory.activate())
  // Row 0 is the separator, row 1 the identity.
  assert.match(strip(accessory.render(80)[1]!), /showing 1-3\/4$/)
  geometry.rows = 12
  const degraded = accessory.render(80)
  // grant 3: no separator; the identity row is FIRST.
  assert.match(strip(degraded[0]!), /showing 1-2\/4$/)
})

test('an empty projection paints nothing and installs no hit geometry', () => {
  const { accessory } = harness()
  accessory.setItems([])
  assert.deepEqual(accessory.render(80), [])
  assert.equal(accessory.handleMouse(wheel(-1, 1)), undefined)
})

test('an emptied projection keeps its LAST PAINTED band until the blank frame is painted', () => {
  const { accessory } = harness()
  accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d')])
  accessory.focused = true
  assert.ok(accessory.activate())
  accessory.render(80)
  // The rows are still on screen: an in-band wheel must be consumed, not bubbled.
  accessory.setItems([])
  assert.deepEqual(accessory.handleMouse(wheel(1, 1)), { handled: true, render: false })
  assert.deepEqual(accessory.handleMouse(wheel(-1, 1)), { handled: true, render: false })
  assert.equal(accessory.anchoredValue, undefined, 'the anchor is dropped with the rows')
  // The blank paint is what retires the geometry…
  assert.deepEqual(accessory.render(80), [])
  assert.equal(accessory.handleMouse(wheel(1, 1)), undefined, 'after the blank frame nothing is owed the wheel')
  // …and re-populating paints a fresh frame the wheel resolves against again.
  accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d')])
  accessory.focused = true
  assert.ok(accessory.activate())
  accessory.render(80)
  assert.deepEqual(accessory.handleMouse(wheel(1, 1)), { handled: true, render: true })
})

test('a 0-grant frame paints nothing and refuses the wheel', () => {
  const { accessory, geometry } = harness({ rows: 4 })
  accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d')])
  accessory.focused = true
  assert.ok(accessory.activate())
  assert.deepEqual(accessory.render(80), [])
  assert.equal(accessory.handleMouse(wheel(1, 1)), undefined)
  geometry.rows = 24
  assert.equal(accessory.render(80).length, 5)
  assert.deepEqual(accessory.handleMouse(wheel(-1, 1)), { handled: true, render: false }, 'an upward wheel at the top is consumed without a repaint')
  assert.deepEqual(accessory.handleMouse(wheel(1, 1)), { handled: true, render: true }, 'the down wheel moves the window')
  assert.match(strip(accessory.render(80)[1]!), /showing 2-4\/4$/)
})

test('the wheel resolves only against the LAST PAINTED frame', () => {
  const { accessory, geometry } = harness()
  accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d'), item('job:e')])
  accessory.focused = true
  assert.ok(accessory.activate())
  accessory.render(80)
  // A stale box (a resize that has not been repainted) is CONSUMED in-band without
  // acting — refusing would fall through to the transcript behind the window.
  assert.deepEqual(accessory.handleMouse(wheel(1, 1, { width: 100 })), { handled: true, render: false })
  assert.deepEqual(accessory.handleMouse(wheel(1, 1, { height: 3 })), { handled: true, render: false })
  // A y outside the painted band is not ours (the alt screen cannot produce one,
  // but the guard is part of the hit contract): the transcript keeps that wheel.
  assert.equal(accessory.handleMouse(wheel(1, 9)), undefined)
  assert.equal(accessory.handleMouse(wheel(1, -1)), undefined)
  // B4-B: a press latches only a REAL row identity; a click without a
  // matching pressed gesture is consumed inertly — no focus is ever taken.
  // (y=1 is the identity row after the separator: inert chrome, consumed
  // without latching.)
  assert.deepEqual(accessory.handleMouse({ ...wheel(1, 1), type: 'press', button: 'left' }), { handled: true })
  assert.deepEqual(accessory.handleMouse({ ...wheel(1, 2), type: 'press', button: 'left' }), { handled: true, capture: true })
  // The REAL dispatcher sequence is press → release → synthesized click; the
  // release must keep the latch so the click can match it.
  assert.deepEqual(accessory.handleMouse({ ...wheel(1, 2), type: 'release', button: 'left' }), { handled: true })
  assert.deepEqual(accessory.handleMouse({ ...wheel(1, 2), type: 'click', button: 'left' }), { handled: true })
  const moved = accessory.handleMouse(wheel(1, 1))
  assert.deepEqual(moved, { handled: true, render: true })
  assert.ok(!('focus' in moved!), 'the wheel never requests focus')
  assert.match(strip(accessory.render(80)[1]!), /showing 2-4\/5$/)
  assert.deepEqual(accessory.handleMouse(wheel(1, 1)), { handled: true, render: true })
  assert.match(strip(accessory.render(80)[1]!), /showing 3-5\/5$/)
  // At the window boundary the wheel is CONSUMED with no repaint: the
  // transcript under the pointer never scrolls.
  assert.deepEqual(accessory.handleMouse(wheel(1, 1)), { handled: true, render: false })
  assert.match(strip(accessory.render(80)[1]!), /showing 3-5\/5$/)
  assert.deepEqual(accessory.handleMouse(wheel(-1, 1)), { handled: true, render: true })
  assert.match(strip(accessory.render(80)[1]!), /showing 2-4\/5$/)
  // A resize that has not been repainted is refused against the LIVE geometry —
  // the event's own dimensions come from the same stale layout cache and cannot
  // express the resize at all.
  geometry.rows = 6
  assert.deepEqual(accessory.handleMouse(wheel(-1, 1)), { handled: true, render: false },
    'a stale frame after a resize is consumed without acting')
  const shrunk = accessory.render(80)
  // A one-row grant paints ONE content row (no header) and keeps the selection visible.
  assert.equal(shrunk.length, 1)
  assert.match(strip(shrunk[0]!), /^> job:c\s+‣ Running\s+3-3\/5$/)
  assert.deepEqual(accessory.handleMouse(wheel(1, 0, { height: 1 })), { handled: true, render: true })
  assert.match(strip(accessory.render(80)[0]!), /^> job:d\s+‣ Running\s+4-4\/5$/)
  // A width resize is caught the same way.
  geometry.cols = 100
  assert.deepEqual(accessory.handleMouse(wheel(-1, 0, { height: 1 })), { handled: true, render: false },
    'a stale frame after a width change is consumed without acting')
  accessory.render(100)
  assert.deepEqual(accessory.handleMouse(wheel(-1, 0, { width: 100, height: 1 })), { handled: true, render: true })
})

test('wheel bursts keep Enter on the last-painted selection until the burst paints', () => {
  const rows = [item('job:a'), item('job:b'), item('job:c'), item('job:d'), item('job:e'), item('job:f')]
  const queued = harness()
  queued.accessory.setItems(rows)
  queued.accessory.focused = true
  assert.ok(queued.accessory.activate())
  assert.match(strip(queued.accessory.render(80)[2]!), /^> job:a/, 'A is selected in the current frame')

  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(queued.accessory.handleMouse(wheel(1, 1)), { handled: true, render: true })
  }
  assert.equal(queued.accessory.selected, 'job:a', 'wheel scroll intent does not change the selection before repaint')
  queued.accessory.handleInput('\r')
  assert.deepEqual(queued.activations(), ['job:a'], 'Enter still opens the item marked in the last-painted frame')

  const painted = harness()
  painted.accessory.setItems(rows)
  painted.accessory.focused = true
  assert.ok(painted.accessory.activate())
  painted.accessory.render(80)
  for (let i = 0; i < 3; i += 1) {
    assert.deepEqual(painted.accessory.handleMouse(wheel(1, 1)), { handled: true, render: true })
  }
  const after = painted.accessory.render(80)
  assert.match(strip(after[1]!), /showing 4-6\/6$/, 'all queued wheel movement reaches the painted window')
  assert.match(strip(after[2]!), /^> job:d/, 'the new painted window selects its visible leading row')
  painted.accessory.handleInput('\r')
  assert.deepEqual(painted.activations(), ['job:d'], 'Enter after paint opens the new visible selection')
})

test('a projection commit preserves a pending wheel window until paint', () => {
  const h = harness()
  h.accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d'), item('job:e'), item('job:f')])
  h.accessory.focused = true
  assert.ok(h.accessory.activate())
  h.accessory.render(80)
  for (let i = 0; i < 3; i += 1) h.accessory.handleMouse(wheel(1, 1))

  h.accessory.setItems([
    item('job:a'), item('job:b'), item('job:c'), item('job:x'), item('job:y'),
    item('job:d'), item('job:e'), item('job:f'),
  ])
  assert.equal(h.accessory.selected, 'job:a', 'the stable old-frame selection remains until the update paints')
  const after = h.accessory.render(80)
  assert.match(strip(after[1]!), /showing 6-8\/8$/, 'the rebased wheel anchor remains the target window')
  assert.match(strip(after[2]!), /^> job:d/, 'paint commits the leading row of the actual new window')
})

test('keyboard navigation supersedes a pending wheel window before repaint', () => {
  const h = harness()
  h.accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d'), item('job:e'), item('job:f')])
  h.accessory.focused = true
  assert.ok(h.accessory.activate())
  h.accessory.render(80)
  for (let i = 0; i < 3; i += 1) h.accessory.handleMouse(wheel(1, 1))

  h.accessory.handleInput('\x1b[B')
  const after = h.accessory.render(80)
  assert.match(strip(after[1]!), /showing 2-4\/6$/, 'keyboard selection takes precedence over the pending wheel target')
  assert.match(strip(after[2]!), /^> job:b/, 'the keyboard-selected identity paints')
})

test('tail Down cancels a pending wheel window before repaint', () => {
  const h = harness()
  h.accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d'), item('job:e'), item('job:f')])
  h.accessory.focused = true
  assert.ok(h.accessory.activate())
  for (let i = 0; i < 5; i += 1) h.accessory.handleInput('\x1b[B')
  const before = h.accessory.render(80)
  assert.match(strip(before[1]!), /showing 4-6\/6$/)
  assert.match(strip(before[4]!), /^> job:f/, 'the last global row is selected in the painted frame')

  assert.deepEqual(h.accessory.handleMouse(wheel(-1, 1)), { handled: true, render: true })
  assert.deepEqual(h.accessory.handleMouse(wheel(-1, 1)), { handled: true, render: true })
  h.accessory.handleInput('\x1b[B')

  const after = h.accessory.render(80)
  assert.equal(h.accessory.selected, 'job:f', 'Down at the global tail remains a selection no-op')
  assert.match(strip(after[1]!), /showing 4-6\/6$/, 'tail Down supersedes the queued upward wheel window')
  assert.match(strip(after[4]!), /^> job:f/, 'the visible tail selection remains marked')
})

test('a deleted selection fallback cannot open until it is painted', () => {
  const h = harness()
  h.accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d')])
  h.accessory.focused = true
  assert.ok(h.accessory.activate())
  h.accessory.render(80)
  h.accessory.handleInput('\x1b[B')
  h.accessory.render(80)
  assert.equal(h.accessory.selected, 'job:b')

  h.accessory.setItems([item('job:a'), item('job:c'), item('job:d')])
  assert.equal(h.accessory.selected, 'job:c', 'the existing successor fallback is retained')
  h.accessory.handleInput('\r')
  assert.deepEqual(h.activations(), [], 'Enter cannot open the unpainted deletion fallback')

  const after = h.accessory.render(80)
  assert.match(strip(after[3]!), /^> job:c/, 'the successor receives the painted selection marker')
  h.accessory.handleInput('\r')
  assert.deepEqual(h.activations(), ['job:c'], 'Enter opens the fallback after it is painted')
})

test('keyboard movement after a deleted fallback keeps immediate Enter semantics', () => {
  const h = harness()
  h.accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d')])
  h.accessory.focused = true
  assert.ok(h.accessory.activate())
  h.accessory.render(80)
  h.accessory.handleInput('\x1b[B')
  h.accessory.render(80)

  h.accessory.setItems([item('job:a'), item('job:c'), item('job:d')])
  h.accessory.handleInput('\x1b[B')
  assert.equal(h.accessory.selected, 'job:d')
  h.accessory.handleInput('\r')
  assert.deepEqual(h.activations(), ['job:d'], 'an explicit keyboard move still commits immediately')
})

test('a height-only repaint invalidates the pressed frame when component geometry is unchanged', () => {
  const h = harness({ rows: 24, chrome: 4 })
  focus(h, [item('job:a'), item('job:b'), item('job:c'), item('job:d')])
  const before = h.accessory.render(80)
  assert.equal(before.length, 5)
  assert.match(strip(before[2]!), /job:a/, 'the target row is inside the painted band')

  const row = 2
  assert.deepEqual(h.accessory.handleMouse({ ...wheel(0, row), type: 'press', button: 'left' }),
    { handled: true, capture: true })
  h.geometry.rows = 25
  const after = h.accessory.render(80)
  assert.equal(after.length, before.length, 'the Quick band keeps the same component height')
  assert.equal(strip(after[row]!), strip(before[row]!), 'the same task remains at the same local cell')

  // Direct component events isolate the terminal-row stamp from the fork
  // dispatcher's independent moved-pointer guard: all component geometry and
  // local coordinates are unchanged; only terminalRows differs.
  assert.deepEqual(h.accessory.handleMouse({ ...wheel(0, row), type: 'release', button: 'left' }), { handled: true })
  assert.deepEqual(h.accessory.handleMouse({ ...wheel(0, row), type: 'click', button: 'left' }), { handled: true })
  assert.deepEqual(h.activations(), [], 'a gesture from the old terminal-height frame is inert')

  assert.deepEqual(h.accessory.handleMouse({ ...wheel(0, row), type: 'press', button: 'left' }),
    { handled: true, capture: true })
  assert.deepEqual(h.accessory.handleMouse({ ...wheel(0, row), type: 'release', button: 'left' }), { handled: true })
  assert.deepEqual(h.accessory.handleMouse({ ...wheel(0, row), type: 'click', button: 'left' }), { handled: true })
  assert.deepEqual(h.activations(), ['job:a'], 'a fresh same-frame gesture remains valid')
})

test('Fullscreen Full-action clicks require a live matching target and painted frame', () => {
  const pointer = (height: number, type: 'press' | 'release' | 'click', y: number): TuiMouseEvent => ({
    ...wheel(0, y, { height }),
    type,
    button: 'left',
  })

  const positive = harness({ openFull: true })
  focus(positive, [item('job:a')])
  const painted = positive.accessory.render(80)
  const actionRow = painted.findIndex(line => strip(line).includes('Open Task Center…'))
  assert.ok(actionRow >= 0)
  assert.deepEqual(positive.accessory.handleMouse(pointer(painted.length, 'press', actionRow)),
    { handled: true, capture: true })
  assert.deepEqual(positive.accessory.handleMouse(pointer(painted.length, 'release', actionRow)), { handled: true })
  assert.deepEqual(positive.accessory.handleMouse(pointer(painted.length, 'click', actionRow)), { handled: true })
  assert.equal(positive.fullOpens(), 1)
  assert.deepEqual(positive.activations(), [], 'the action click never routes a TaskPanelItem')

  const moved = harness({ openFull: true })
  focus(moved, [item('job:a')])
  const movedRows = moved.accessory.render(80)
  const movedAction = movedRows.findIndex(line => strip(line).includes('Open Task Center…'))
  const taskRow = movedRows.findIndex(line => strip(line).includes('job:a'))
  moved.accessory.handleMouse(pointer(movedRows.length, 'press', movedAction))
  moved.accessory.handleMouse(pointer(movedRows.length, 'release', taskRow))
  moved.accessory.handleMouse(pointer(movedRows.length, 'click', taskRow))
  assert.equal(moved.fullOpens(), 0, 'pressing the action and releasing on a task cannot open Full')
  assert.deepEqual(moved.activations(), [])

  const repainted = harness({ openFull: true })
  focus(repainted, [item('job:a')])
  const oldRows = repainted.accessory.render(80)
  const oldAction = oldRows.findIndex(line => strip(line).includes('Open Task Center…'))
  repainted.accessory.handleMouse(pointer(oldRows.length, 'press', oldAction))
  repainted.accessory.render(80)
  repainted.accessory.handleMouse(pointer(oldRows.length, 'release', oldAction))
  repainted.accessory.handleMouse(pointer(oldRows.length, 'click', oldAction))
  assert.equal(repainted.fullOpens(), 0, 'any intervening paint retires the old action gesture')

  const emptied = harness({ openFull: true })
  focus(emptied, [item('job:a')])
  const emptyRows = emptied.accessory.render(80)
  const emptyAction = emptyRows.findIndex(line => strip(line).includes('Open Task Center…'))
  emptied.accessory.handleMouse(pointer(emptyRows.length, 'press', emptyAction))
  emptied.accessory.setItems([])
  emptied.accessory.handleMouse(pointer(emptyRows.length, 'release', emptyAction))
  emptied.accessory.handleMouse(pointer(emptyRows.length, 'click', emptyAction))
  assert.equal(emptied.fullOpens(), 0, 'an empty live projection cannot commit the old action')

  const blurred = harness({ openFull: true })
  focus(blurred, [item('job:a')])
  const blurRows = blurred.accessory.render(80)
  const blurAction = blurRows.findIndex(line => strip(line).includes('Open Task Center…'))
  blurred.accessory.handleMouse(pointer(blurRows.length, 'press', blurAction))
  blurred.accessory.deactivate()
  blurred.accessory.focused = false
  blurred.accessory.handleMouse(pointer(blurRows.length, 'release', blurAction))
  blurred.accessory.handleMouse(pointer(blurRows.length, 'click', blurAction))
  assert.equal(blurred.fullOpens(), 0, 'blurred Quick cannot execute a stale action hit')
})

test('the whole painted band owns the wheel, identity row included', () => {
  const { accessory } = harness()
  accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d')])
  accessory.focused = true
  assert.ok(accessory.activate())
  accessory.render(80)
  // y=0/1 are the separator/identity rows: the accessory still owns the whole
  // band, so the transcript never scrolls under a pointer that is on it.
  assert.deepEqual(accessory.handleMouse(wheel(1, 0)), { handled: true, render: true })
  assert.match(strip(accessory.render(80)[1]!), /showing 2-4\/4$/)
  // Nothing to scroll: consumed without a repaint, never bubbled.
  assert.deepEqual(accessory.handleMouse(wheel(1, 1)), { handled: true, render: false })
  assert.match(strip(accessory.render(80)[1]!), /showing 2-4\/4$/)
})

test('the window rebases on the first visible row ID, not on an index or a label', () => {
  const { accessory, geometry } = harness()
  accessory.setItems([item('job:a'), item('job:b'), item('job:c'), item('job:d'), item('job:e'), item('job:f')])
  accessory.focused = true
  assert.ok(accessory.activate())
  accessory.render(80)
  accessory.handleMouse(wheel(1, 1))
  accessory.render(80)
  // Row 0 = separator, row 1 = identity.
  assert.match(strip(accessory.render(80)[1]!), /showing 2-4\/6$/)
  assert.match(strip(accessory.render(80)[2]!), /job:b/)
  // A status update of the anchored row keeps the window exactly where it is.
  accessory.setItems([
    item('job:a'), item('job:b', { status: 'failed' }), item('job:c'),
    item('job:d'), item('job:e'), item('job:f'),
  ])
  const updated = accessory.render(80)
  assert.match(strip(updated[1]!), /showing 2-4\/6$/)
  assert.match(strip(updated[2]!), /job:b\s+‣ Failed$/)
  // An insertion ABOVE the anchor keeps the anchored row first.
  accessory.setItems([
    item('job:x'), item('job:a'), item('job:b'), item('job:c'),
    item('job:d'), item('job:e'), item('job:f'),
  ])
  const inserted = accessory.render(80)
  assert.match(strip(inserted[1]!), /showing 3-5\/7$/)
  assert.match(strip(inserted[2]!), /job:b/)
  // Removing the anchored row falls back to the BOUNDED previous index.
  accessory.setItems([
    item('job:x'), item('job:a'), item('job:c'), item('job:d'), item('job:e'), item('job:f'),
  ])
  const removed = accessory.render(80)
  assert.match(strip(removed[1]!), /showing 3-5\/6$/)
  assert.match(strip(removed[2]!), /job:c/, 'index 2 of the remaining rows')
  // A shrink keeps the anchored row visible…
  geometry.rows = 8
  const shrunk = accessory.render(80)
  assert.equal(shrunk.length, 2)
  assert.match(strip(shrunk[1]!), /^> job:c\s+‣ Running$/)
  assert.match(strip(shrunk[0]!), /showing 3-3\/6$/)
  // …and growing back does not jump the window.
  geometry.rows = 24
  assert.match(strip(accessory.render(80)[1]!), /showing 3-5\/6$/)
})

test('every rendered row is a single safe physical row, measured in terminal cells', () => {
  const { accessory } = harness()
  const hostile = '\x1b[31mevil\x1b[0m\nsecond\ttab\u0007' + '任务标签'.repeat(30)
  accessory.setItems([
    item('job:a', { label: hostile }),
    item('job:b', { label: '短', suffix: 'continuable' }),
    item('job:c', { label: 'c', suffix: 'one-shot' + 'x'.repeat(200) }),
  ])
  accessory.focused = true
  assert.ok(accessory.activate())
  const lines = accessory.render(80)
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80)
    assert.ok(!line.includes('\n') && !line.includes('\r') && !line.includes('\t'))
  }
  const first = strip(lines[2]!)
  assert.ok(!first.includes('[31m') && !first.includes('evil\x1b'), `the raw escape must not leak: ${JSON.stringify(first)}`)
  assert.ok(!first.includes('\u0007'), 'the control byte must not leak')
  assert.match(first, /…/, 'the long label truncates with the content ellipsis')
  assert.ok(first.startsWith('> '), 'the selected row keeps its marker')
  // The durable mode rides whole while an identifiable label cell survives.
  assert.match(strip(lines[3]!), /短 · continuable\s+‣ Running$/)
  // A mode longer than the row yields whole rather than being cut mid-word.
  const third = strip(lines[4]!)
  assert.match(third, /‣ Running$/)
  assert.ok(!third.includes('one-shot'), 'an unaffordable mode is dropped whole')
})

test('nesting is painted as indentation, never with an ambiguous box-drawing connector', () => {
  const { accessory } = harness()
  accessory.setItems([
    item('job:a', { label: 'build' }),
    item('agent:p', { label: 'subagent · parent', suffix: 'continuable', source: 'subagent', type: 'subagent', depth: 1 }),
    item('agent:c', {
      label: 'subagent · child', suffix: 'continuable', source: 'subagent', type: 'subagent',
      depth: 2, treePrefix: '  ├─ ',
    }),
  ])
  accessory.focused = true
  assert.ok(accessory.activate())
  const lines = accessory.render(80).map(strip)
  assert.ok(lines[0]!.startsWith('─'), 'the separator leads the ACTIVE frame')
  assert.ok(strip(lines[2]!).startsWith('> build'), `the selected root row carries the marker:\n${lines.join('\n')}`)
  assert.ok(strip(lines[3]!).startsWith('  subagent · parent'), `a depth-1 row is marker slot only: ${JSON.stringify(lines[3])}`)
  assert.ok(strip(lines[4]!).startsWith('    subagent · child'), `a depth-2 row is marker slot + one indent step: ${JSON.stringify(lines[4])}`)
  assert.equal(
    strip(lines[2]!).indexOf('build'),
    strip(lines[3]!).indexOf('subagent · parent'),
    'root Job and root Subagent labels must align',
  )
  // U+2500 is East-Asian-Width ambiguous: the modal panel's NESTING connector
  // must not be carried into the task rows (the placement is indentation, not
  // a glyph). The ONE rule at the top is the Owner-authorized Footer↔Quick
  // boundary (B4-B addendum) — role 15 `border`, not a nesting connector.
  assert.equal(/[\u2500-\u257f]/.test(lines.slice(2).join('')), false, 'no box-drawing glyph in the task rows')
})

test('an unknown or hostile remote status is projected to ONE safe physical row', () => {
  const { accessory } = harness()
  accessory.setItems([
    item('job:a', { status: 'failed\u001b[31m\ninjected\u0007' }),
    item('job:b', { status: 'weird_status' }),
  ])
  accessory.focused = true
  assert.ok(accessory.activate())
  const lines = accessory.render(80)
  for (const line of lines) {
    assert.equal(visibleWidth(line), 80)
    assert.ok(!line.includes('\n') && !line.includes('\r') && !line.includes('\t'))
  }
  const first = strip(lines[2]!)
  assert.ok(!first.includes('[31m') && !first.includes('\u001b'), `the raw status escape must not leak: ${JSON.stringify(first)}`)
  assert.ok(!first.includes('\u0007'), 'the control byte must not leak')
  assert.match(first, /^> job:a\s+‣ Failed injected$/)
  // An unknown status keeps its REAL word (Title-cased), never a renamed one.
  assert.match(strip(lines[3]!), /^  job:b\s+‣ Weird_status$/)
})

test('the ink follows a live theme switch without a re-construction', () => {
  const { accessory } = harness()
  accessory.setItems([item('job:a')])
  accessory.focused = true
  assert.ok(accessory.activate())
  const dark = accessory.render(80).join('\n')
  setTheme('light')
  const light = accessory.render(80).join('\n')
  assert.notEqual(dark, light, 'the same frame must repaint with the live palette')
  assert.equal(strip(dark), strip(light), 'only the ink changes, never the text')
})

test('a narrow frame degrades the position whole, never mid-word', () => {
  const render = (cols: number): string => {
    const { accessory } = harness({ cols })
    accessory.setItems([item('job:a'), item('job:b')])
    accessory.focused = true
    assert.ok(accessory.activate())
    const rows = accessory.render(cols)
    // Row 0 is the separator when the frame grants it; the identity row follows.
    return strip(rows.find(line => line.includes('Task Quick')) ?? rows[0]!)
  }
  assert.match(render(44), /^Task Quick\s+showing 1-2\/2$/)
  assert.equal(render(24), 'Task Quick showing 1-2/2')
  // The compact position replaces the verbose one before it is dropped whole.
  assert.equal(render(16), 'Task Quick 1-2/2')
  assert.equal(render(14), 'Task Quick    ')
})

test('the projection keeps the Quick policy and drops the modal-only promotion row', () => {
  const rows = buildTaskRows([
    { id: 'j1', label: 'build', status: 'running', kind: 'bash', startedAt: 0 },
    { id: 'j2', label: 'deploy', status: 'failed', kind: 'bash', startedAt: 0 },
  ], [])
  // Live work: the Active scope keeps the running job and leaves the terminal
  // failure as footer attention (not a Quick row).
  assert.deepEqual(quickTaskProjection(rows, []).map(row => row.value), ['job:j1'])
  // No live work: the unacknowledged failure surfaces, as the modal Quick does.
  const settled = buildTaskRows([
    { id: 'j2', label: 'deploy', status: 'failed', kind: 'bash', startedAt: 0 },
  ], [])
  assert.deepEqual(quickTaskProjection(settled, []).map(row => row.value), ['job:j2'])
  // Parked Question attention leads the rows and is never a Job.
  const attention: QuestionAttentionRow[] = [
    { sessionId: 's', callId: 'c', questions: [{ id: 'q1', question: 'Continue?' }], presentation: 'parked' },
    // A VISIBLE Question owns the editor seat: it never duplicates into Quick.
    { sessionId: 's', callId: 'v', questions: [{ id: 'q2', question: 'Answer me' }], presentation: 'visible' },
  ]
  const projected = quickTaskProjection(settled, attention)
  assert.equal(projected.length, 2)
  assert.match(projected[0]!.value, /^question:/)
  assert.equal(projected[0]!.source, 'question')
  assert.equal(projected[0]!.status, 'awaiting answer')
  assert.ok(projected.every(row => row.source !== undefined || row.value.startsWith('question:')))
})
