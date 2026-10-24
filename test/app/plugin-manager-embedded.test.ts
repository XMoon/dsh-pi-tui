/**
 * PR2 — the Plugin Manager as an EMBEDDED child of the Settings workspace.
 *
 * These L6 cases drive the REAL composition (the real `TuiApp` Settings
 * lease, the real `SettingsWorkspacePanel` root and the real
 * `PluginManagerWorkspacePanel` over a fixture semantic port) through a real
 * `VirtualTerminal`. They own the frozen projection/height/focus/notice
 * matrix:
 *
 * - T05 breakpoint table: `<76` / `76..119` / `>=120` x list / details /
 *   categories preview, including the retired `96` column that must NOT turn
 *   a rail preview into a business pair;
 * - T06 height degradation: the same frames at 3/5/8/10 rows;
 * - T07 the input-focus matrix with REAL keys (Tab, Shift+Tab, Enter, Esc,
 *   search editing) and page-instance/inventory-read stability;
 * - T10 the plugin's own Host notice versus the ONE root App notice, the live
 *   palette token and long CJK identities.
 *
 * @module @xmoon76/dsh-pi-tui/plugin-manager-embedded.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { currentPalette, setTheme } from '../../src/tui/theme/runtime.ts'
import { bundle, openWorkspace, type WorkspaceHarness } from '../support/plugin-workspace-harness.ts'

const started: WorkspaceHarness[] = []
afterEach(() => {
  setTheme('dark')
  for (const harness of started.splice(0)) {
    try { harness.app.dispose() } catch {}
  }
})

async function open(options: Parameters<typeof openWorkspace>[0] = {}): Promise<WorkspaceHarness> {
  const harness = await openWorkspace(options)
  started.push(harness)
  return harness
}

const frameRows = (harness: WorkspaceHarness): string[] => harness.viewport().map(stripTerminalSequences)

function rowOf(harness: WorkspaceHarness, needle: string): number {
  const row = frameRows(harness).findIndex(line => line.includes(needle))
  assert.ok(row >= 0, `the frame must contain ${JSON.stringify(needle)}:\n${harness.view()}`)
  return row
}

function columnOf(harness: WorkspaceHarness, row: number, needle: string): number {
  const column = frameRows(harness)[row]!.indexOf(needle)
  assert.ok(column >= 0, `row ${row} must contain ${JSON.stringify(needle)}:\n${harness.view()}`)
  return column
}

const bar = (harness: WorkspaceHarness): string => frameRows(harness).at(-1)!

/** The plugin content owns the keyboard on the very first frame of `/plugins`. */
async function contentFocus(harness: WorkspaceHarness): Promise<void> {
  assert.match(bar(harness), /Enter details/u, 'the plugin List owns the keyboard')
}

/** Esc once: the List root yields to the Categories rail (page retained). */
async function yieldToRail(harness: WorkspaceHarness): Promise<void> {
  harness.vt.sendInput('\x1b')
  await harness.settle()
}

// ── T05: the frozen breakpoint table ────────────────────────────────────────

test('T05 every breakpoint projects the frozen plugin columns in all three stages', async () => {
  const widths = [44, 72, 75, 76, 80, 95, 96, 100, 107, 108, 119, 120, 140]
  for (const width of widths) {
    const harness = await open({ columns: width, rows: 24 })
    // ── plugin List (content focus) ──
    await contentFocus(harness)
    const listRows = frameRows(harness)
    assert.equal(visibleWidth(listRows.at(-1)!), width, `every painted row is exactly ${width} cells wide`)
    assert.match(bar(harness), /Esc back/u, `${width}: the List root yields, it never closes`)
    if (width < 76) {
      // ONE column: no pane header row and the page owns the full width.
      assert.equal(columnOf(harness, rowOf(harness, 'Search: /'), 'Search: /'), 0, `${width}: single-column list starts at x=0`)
      assert.doesNotMatch(harness.view(), /\[Plugins\]/u, `${width}: a narrow frame paints no pane header`)
    } else if (width < 120) {
      // Plugin content focus: `List | Details` (the rail is gone).
      const header = rowOf(harness, '[Plugins]')
      assert.equal(columnOf(harness, header, '[Plugins]'), 0, `${width}: the plugin list owns the leading column`)
      assert.match(listRows[header]!, /Details/u, `${width}: the pair keeps the Details column`)
      assert.equal(columnOf(harness, rowOf(harness, 'Search: /'), 'Search: /'), 0, `${width}: the list starts at x=0`)
    } else {
      // >=120: `Categories | List | Details`; the rail stays visible.
      const header = rowOf(harness, 'Categories (8)')
      assert.equal(columnOf(harness, header, 'Categories (8)'), 0, `${width}: the rail owns the leading column`)
      assert.equal(columnOf(harness, header, '[Plugins]'), 24, `${width}: the list starts after the rail + gutter`)
      assert.match(listRows[header]!, /Details/u, `${width}: the third column is painted`)
      assert.equal(columnOf(harness, rowOf(harness, 'Search: /'), 'Search: /'), 24, `${width}: the list body starts at x=24`)
    }

    // ── Plugin Details (Enter inside the List; still content focus) ──
    harness.vt.sendInput('\r')
    await harness.settle()
    assert.equal(harness.panel.currentView(), 'details', `${width}: Enter enters Details`)
    if (width < 76) {
      assert.match(bar(harness), /Esc back/u, `${width}: narrow Details keeps its own Esc`)
      assert.ok(
        !frameRows(harness).some(line => line.trimStart().startsWith('[Details]')),
        `${width}: a narrow frame paints no pane header:\n${harness.view()}`,
      )
    } else {
      const header = rowOf(harness, '[Details]')
      assert.ok(header >= 0, `${width}: Details owns the active device:\n${harness.view()}`)
    }

    // ── Esc back to the List, then the Categories rail preview ──
    harness.vt.sendInput('\x1b')
    await harness.settle()
    assert.equal(harness.panel.currentView(), 'list', `${width}: Esc from Details returns to the List`)
    const page = harness.panel
    await yieldToRail(harness)
    assert.equal(harness.panel, page, `${width}: the yield keeps the SAME page instance`)
    assert.match(bar(harness), /Esc close/u, `${width}: the rail owns the physical last row`)
    const railRows = frameRows(harness)
    if (width < 76) {
      // Narrow: the category list alone; the page is not painted.
      assert.doesNotMatch(harness.view(), /Search: \//u, `${width}: a narrow rail paints no plugin content`)
      assert.match(harness.view(), /> Plugins/u, `${width}: Plugins stays selected`)
    } else {
      const header = rowOf(harness, 'Categories (8)')
      assert.equal(columnOf(harness, header, '[Categories (8)]'), 0, `${width}: the rail is the ONE active device`)
      assert.equal(columnOf(harness, header, 'Plugins'), 24, `${width}: the preview starts after the rail`)
      if (width >= 120) {
        assert.match(railRows[header]!, /Details/u, `${width}: >=120 previews the Details column`)
      } else {
        assert.doesNotMatch(railRows[header]!, /Details/u, `${width}: 76..119 previews Categories+List only`)
      }
      assert.equal(columnOf(harness, rowOf(harness, 'Search: /'), 'Search: /'), 24, `${width}: the preview body starts at x=24`)
    }
    harness.app.dispose()
  }
})

// ── T06: vertical degradation ───────────────────────────────────────────────

test('T06 short frames keep the truthful last-row bar and drop the optional rows first', async () => {
  for (const [columns, rows] of [[80, 3], [80, 5], [80, 8], [80, 10], [120, 3], [120, 5], [120, 8], [120, 10]] as const) {
    const harness = await open({ columns, rows })
    await contentFocus(harness)
    const frame = frameRows(harness)
    assert.equal(frame.length, rows, `${columns}x${rows}: the frame paints exactly ${rows} rows`)
    assert.equal(visibleWidth(frame.at(-1)!), columns, `${columns}x${rows}: the last row is the full-width bar`)
    assert.match(bar(harness), /Esc back/u, `${columns}x${rows}: the bar always names the real Esc`)
    // The body always keeps at least one row once the header and the bar fit.
    const body = frame.slice(1, -1)
    assert.ok(body.length >= 1, `${columns}x${rows}: one real body row survives`)
    assert.ok(body.every(line => visibleWidth(line) === columns), `${columns}x${rows}: every body row is fitted`)
    // A frame that cannot carry the Search/Filters row never paints it; the
    // list body still starts with a section/identity row.
    if (body.length < 2) assert.doesNotMatch(harness.view(), /Search: \//u, `${columns}x${rows}: no invisible Search row`)
    harness.app.dispose()
  }
  // A zero-body frame grants only the header and the bar (2 rows), and no body
  // action survives it (the page's own actions are revoked). The page is
  // mounted first and then the terminal shrinks: a 2-row first frame would have
  // no visible content column and must never start a page.
  const harness = await open({ columns: 120, rows: 40 })
  harness.vt.resize(120, 2)
  await harness.vt.waitForRender()
  const frame = frameRows(harness)
  assert.equal(frame.length, 2, 'the 2-row frame keeps only the header and the bar')
  assert.match(frame.at(-1)!, /Esc back/u, 'the plugin content names its real Esc below the body floor')
  assert.doesNotMatch(harness.view(), /TUI & Extensions/u, 'no hidden list row is painted')
  harness.app.dispose()
})

// ── T07: the input-focus matrix ─────────────────────────────────────────────

test('T07 the focus matrix runs real keys and never rebuilds or re-reads the page', async () => {
  const harness = await open({ columns: 120, rows: 24 })
  const page = harness.panel
  const reads = harness.snapshotCalls()
  assert.equal(reads, 1, 'mounting the page reads the inventory exactly once')
  await contentFocus(harness)

  // Esc: List root -> Categories (same page, no re-read, no dispose).
  await yieldToRail(harness)
  assert.equal(harness.panel, page, 'the yield keeps the ONE page instance')
  assert.equal(harness.snapshotCalls(), 1, 'a yield never re-reads the inventory')
  assert.equal(harness.panel.focused, false, 'the rail owns the input focus')
  assert.match(bar(harness), /Enter\/Right focus/u, 'the rail advertises the real focus key')

  // Tab: only focuses the plugin List; the page keeps its instance/query.
  harness.vt.sendInput('\t')
  await harness.settle()
  assert.equal(harness.panel, page)
  assert.equal(harness.panel.focused, true, 'Tab hands the keyboard to the plugin List')
  assert.equal(harness.snapshotCalls(), 1, 'focus transfer never re-reads the inventory')
  assert.equal(harness.panel.currentView(), 'list', 'focus transfer never opens Details')

  // Tab INSIDE the list keeps the page's own filter cycle (no root action).
  harness.vt.sendInput('\t')
  await harness.settle()
  assert.doesNotMatch(harness.view(), /@vendor\/foo/u, 'the Enabled filter removed the disabled bundle')
  assert.match(harness.view(), /@xmoon76\/dsh-pi-tui/u, 'the enabled bundle stays listed')
  await contentFocus(harness)

  // Shift+Tab from the untouched List root returns to the rail (>=76 columns).
  harness.vt.sendInput('\x1b[Z')
  await harness.settle()
  assert.match(bar(harness), /Esc close/u, 'Shift+Tab yielded to the rail')
  assert.equal(harness.panel.focused, false)

  // Enter: only re-focuses the content; it never opens Details by itself.
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'list', 'rail Enter only focuses the List')
  assert.equal(harness.panel.focused, true)

  // Enter inside the list opens Details; Shift+Tab there never crosses levels.
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'details')
  assert.match(harness.view(), /\[Details\]/u, 'Details owns the ONE active device')
  harness.vt.sendInput('\x1b[Z')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'details', 'Shift+Tab never crosses out of Details')

  // Esc: Details -> List -> Categories; the page keeps its identity.
  harness.vt.sendInput('\x1b')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'list')
  assert.match(bar(harness), /Enter details/u)
  await yieldToRail(harness)
  assert.equal(harness.panel, page)
  assert.equal(harness.snapshotCalls(), 1)

  // Search editing owns the keys; Esc clears it and stays in the List.
  harness.vt.sendInput('\t')
  await harness.settle()
  harness.vt.sendInput('/')
  await harness.settle()
  assert.match(bar(harness), /Enter apply/u, 'the search editor owns the bar')
  harness.vt.sendInput('base')
  await harness.settle()
  assert.match(harness.view(), /@deepseek-ai\/dsh-base/u, 'the query narrowed the list')
  assert.doesNotMatch(harness.view(), /@xmoon76\/dsh-pi-tui/u, 'the non-matching card is gone')
  harness.vt.sendInput('\x1b')
  await harness.settle()
  assert.match(bar(harness), /Enter details/u, 'Esc left the search editor, not the page')

  // Esc on the List root yields; a second Esc closes the ONE Settings lease.
  await yieldToRail(harness)
  assert.match(bar(harness), /Esc close/u)
  harness.vt.sendInput('\x1b')
  await harness.settle()
  assert.doesNotMatch(harness.view(), /Settings ·/u, 'the final Esc closed the Settings workspace')
  harness.app.dispose()
})

/** One SGR wheel event at a terminal cell (button 65 = wheel down). */
function wheel(harness: WorkspaceHarness, row: number, column: number, down = true): void {
  harness.vt.sendInput(`\x1b[<${down ? 65 : 64};${column + 1};${row + 1}M`)
}

// ── T08: wheel routing ──────────────────────────────────────────────────────

test('T08 the wheel scrolls the pane under the pointer and header/bar/gutter are inert', async () => {
  const harness = await open({ columns: 120, rows: 12 })
  const split = harness.panel.contentLayout()
  assert.equal(split.dual, true, 'the 120x12 content focus paints the adjacent pair')
  const listOf = (frame: readonly string[]): string[] => frame.map(line => line.slice(24, 24 + split.leftWidth))
  const detailOf = (frame: readonly string[]): string[] => frame.map(line => line.slice(24 + split.leftWidth + 2))
  const selected = harness.panel.selectedCardValue()

  const initial = frameRows(harness)
  // The Content column starts at row 4 (header/metadata/rule/pane header) and
  // its local row 0 is the Search row; the list body starts at row 5.
  wheel(harness, 5, 30)
  await harness.settle()
  const afterList = frameRows(harness)
  assert.notDeepEqual(listOf(afterList), listOf(initial), 'the pointer-targeted List column scrolled')
  assert.deepEqual(detailOf(afterList), detailOf(initial), 'the Details column did not move')
  assert.equal(harness.panel.selectedCardValue(), selected, 'a wheel never changes the selected identity')

  wheel(harness, 5, 24 + split.leftWidth + 4)
  await harness.settle()
  const afterDetail = frameRows(harness)
  assert.deepEqual(listOf(afterDetail), listOf(afterList), 'the List column did not move')
  assert.notDeepEqual(detailOf(afterDetail), detailOf(afterList), 'the pointer-targeted Details column scrolled')

  // The pane header, the 2-cell rail/content gutter and the action bar are not
  // scroll owners: the frame is byte-identical after each event.
  const frozen = harness.view()
  wheel(harness, 3, 70)
  await harness.settle()
  assert.equal(harness.view(), frozen, 'the shared pane header is inert')
  wheel(harness, 6, 23)
  await harness.settle()
  assert.equal(harness.view(), frozen, 'the rail/content gutter is inert')
  wheel(harness, frameRows(harness).length - 1, 10)
  await harness.settle()
  assert.equal(harness.view(), frozen, 'the physical last-row bar is inert')
  harness.app.dispose()
})

test('T08 the wheel over the Categories rail scrolls the rail on a short frame', async () => {
  const harness = await open({ columns: 120, rows: 12 })
  await yieldToRail(harness)
  const railOf = (): string[] => frameRows(harness).slice(4, 11).map(line => line.slice(0, 22))
  const before = railOf()
  assert.ok(before.some(line => line.includes('About')), `the rail starts at About:\n${harness.view()}`)
  wheel(harness, 6, 2)
  await harness.settle()
  const after = railOf()
  assert.notDeepEqual(after, before, 'the rail scrolled under the pointer')
  assert.ok(!after.some(line => line.includes('About')), 'the rail window moved by one category')
  harness.app.dispose()
})

// ── T10: notices, palette and CJK identities ────────────────────────────────

test('T10 the plugin Host notice and the ONE root App notice never overwrite each other', async () => {
  const harness = await open({ columns: 120, rows: 24 })
  harness.controller.explain('plugin inventory is stale; the Host read failed')
  harness.app.notify('context measurement failed for this turn', 'error')
  await harness.settle()
  const frame = frameRows(harness)
  const appNoticeRow = rowOf(harness, 'context measurement failed')
  const hostNoticeRow = rowOf(harness, 'plugin inventory is stale')
  const headerRow = rowOf(harness, 'Settings · Plugins')
  const paneHeaderRow = rowOf(harness, 'Categories (8)')
  assert.ok(appNoticeRow > headerRow && appNoticeRow < paneHeaderRow, 'the App notice is ONE root row above the pane header')
  assert.ok(hostNoticeRow > paneHeaderRow, 'the plugin Host notice stays inside the business body')
  assert.equal(frame.filter(line => line.includes('context measurement failed')).length, 1, 'the App notice is painted exactly once')
  assert.equal(frame.filter(line => line.includes('plugin inventory is stale')).length, 1, 'the Host notice is painted exactly once')
  harness.app.dispose()
})

test('T10 the shared pane header follows the live palette and long CJK identities stay whole', async () => {
  setTheme('dark')
  const dark = await open({ columns: 100, rows: 24, bundles: [bundle({ name: '插件包-中文名称-超长测试包', source: 'file:/tmp/cjk', enabled: false })] })
  const darkPrimary = currentPalette.primary
  const darkRow = rowOf(dark, '[Plugins]')
  const darkColumn = columnOf(dark, darkRow, '[Plugins]')
  assert.equal(dark.vt.getCellFgRgb(darkRow, darkColumn + 1), hexToRgb(darkPrimary), 'the active device uses the live primary token')
  dark.app.dispose()

  setTheme('light')
  const light = await open({ columns: 100, rows: 24, bundles: [bundle({ name: '插件包-中文名称-超长测试包', source: 'file:/tmp/cjk', enabled: false })] })
  const lightRow = rowOf(light, '[Plugins]')
  const lightColumn = columnOf(light, lightRow, '[Plugins]')
  assert.equal(light.vt.getCellFgRgb(lightRow, lightColumn + 1), hexToRgb(currentPalette.primary), 'light theme repaints the same role')
  assert.notEqual(currentPalette.primary, darkPrimary, 'the light palette really differs')
  // The long CJK identity is fitted to its column and the whole state chip survives
  // on the SAME list row (the row is never cut mid-token).
  const cjkRow = frameRows(light).findIndex(line => line.includes('[disabled]'))
  assert.ok(cjkRow >= 0, `the CJK card row must paint its state chip:\n${light.view()}`)
  const line = frameRows(light)[cjkRow]!
  assert.equal(visibleWidth(line), 100, 'the CJK row is fitted to the terminal width')
  assert.match(line, /插件包-中文名称-超长测试包/u, 'the whole CJK identity fits its column')
  light.app.dispose()
})

/** Hex palette token to the terminal's packed RGB. */
function hexToRgb(hex: string): number {
  const value = Number.parseInt(hex.replace('#', ''), 16)
  return ((value >> 16) & 0xff) << 16 | ((value >> 8) & 0xff) << 8 | (value & 0xff)
}
