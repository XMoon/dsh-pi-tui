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
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '@xmoon76/pi-tui'
import { currentPalette, setTheme } from '../../src/tui/theme/runtime.ts'
import type { PluginChangeFact } from '../../src/runtime/plugin-manager-port.ts'
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
  // §8.2 mandates BOTH heights for every listed width and all three stages.
  for (const height of [24, 40] as const) {
  for (const width of widths) {
    const harness = await open({ columns: width, rows: height })
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
      assert.equal(columnOf(harness, rowOf(harness, 'Search: /'), 'Search: /'), 24, `${width}x${height}: the preview body starts at x=24`)
    }
    harness.app.dispose()
  }
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

// ── T09: stale gestures, body floor and the mouse currentness fence ────────

/** One native SGR left-button gesture (1-based terminal cells). */
function press(harness: WorkspaceHarness, row: number, column: number): void {
  harness.vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
}
function release(harness: WorkspaceHarness, row: number, column: number): void {
  harness.vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
}
function click(harness: WorkspaceHarness, row: number, column: number): void {
  press(harness, row, column)
  release(harness, row, column)
}

/** The terminal row of one Categories rail entry (rail cells only). */
function railRow(harness: WorkspaceHarness, label: string): number {
  const row = frameRows(harness).findIndex(line => {
    const rail = line.slice(0, 22).trimEnd()
    return rail === `> ${label}` || rail === `  ${label}`
  })
  assert.ok(row >= 0, `the rail must paint the ${label} row:\n${harness.view()}`)
  return row
}

/** Click a FRESH screen cell (never the just-pressed one) and settle. The fork
 *  withholds a same-cell click inside its multi-click window, so a control must
 *  either move to another cell or use the keyboard. */
async function clickCell(harness: WorkspaceHarness, row: number, column: number): Promise<void> {
  click(harness, row, column)
  await harness.settle()
}

async function selectCard(harness: WorkspaceHarness, value: string): Promise<void> {
  for (let step = 0; step < 30; step += 1) {
    if (harness.panel.selectedCardValue() === value) return
    harness.vt.sendInput('\x1b[B')
    await harness.settle()
  }
  assert.fail(`card ${value} was not selectable`)
}

/** Open Details on the disabled third-party bundle. */
async function openDetails(harness: WorkspaceHarness): Promise<void> {
  await selectCard(harness, 'bundle:@vendor/foo')
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'details', 'Details must be open')
}

/** Open the removal confirmation with the dangerous primary selected. */
async function openRemoveConfirm(harness: WorkspaceHarness): Promise<void> {
  await openDetails(harness)
  harness.vt.sendInput('\x1b[B') // Enable… -> Remove…
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'confirm', 'the Remove confirmation must be open')
  harness.vt.sendInput('\x1b[A') // Cancel -> Remove
  await harness.settle()
  assert.match(harness.view(), /^> Remove\s*$/mu, 'the dangerous primary must be selected and painted')
}

/** Open the install editor from the last (official missing) card. */
async function openInstall(harness: WorkspaceHarness): Promise<void> {
  harness.vt.sendInput('\x1b[F') // End: the last card is the official Claude Code entry
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  for (let attempt = 0; attempt < 3 && harness.panel.currentView() === 'details'; attempt += 1) {
    harness.vt.sendInput('\r')
    await harness.settle()
  }
  assert.equal(harness.panel.currentView(), 'install', 'the install editor must be open')
}

test('T09 below the body floor only the REAL Esc is admitted and advertised', async () => {
  const harness = await open({ columns: 120, rows: 24 })
  harness.vt.resize(120, 2)
  await harness.settle()
  const zero = harness.view()
  assert.equal(bar(harness).trim(), 'Esc back', 'the 2-row frame advertises only the real Esc destination')
  // Every key the page advertises on a full frame is inert here: none may open
  // a hidden body, start a Host read or change the filter.
  for (const key of ['/', 'i', 'd', 'r', '\t'] as const) {
    harness.vt.sendInput(key)
    await harness.settle()
    assert.equal(harness.panel.currentView(), 'list', `${JSON.stringify(key)} cannot open a hidden page`)
    assert.equal(harness.view(), zero, `${JSON.stringify(key)} leaves the zero-row frame untouched`)
  }
  assert.equal(harness.snapshotCalls(), 1, 'r never read the Host inventory below the body floor')
  // Restore: the same keys act on a full frame (positive control), and none of
  // the hidden keys left state behind (the List root owns the bar, the filter
  // still shows the disabled card).
  harness.vt.resize(120, 24)
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'list')
  assert.match(bar(harness), /Enter details/u, 'the restored List root keeps its own bar')
  assert.match(harness.view(), /@vendor\/foo/u, 'the zero-row Tab did not cycle the filter')
  harness.vt.sendInput('d')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'diagnostics', 'the same diagnostics key really acts on a full frame')
  harness.app.dispose()
})

test('T09 a zero-row search edit drops the apply and keeps only the real Esc', async () => {
  const harness = await open({ columns: 140, rows: 40 })
  harness.vt.sendInput('/')
  await harness.settle()
  for (const character of 'foo') harness.vt.sendInput(character)
  await harness.settle()
  assert.match(harness.view(), /Search: foo/u, 'the query was typed on the full frame')
  harness.vt.resize(80, 2)
  await harness.settle()
  assert.equal(bar(harness).trim(), 'Esc clear search', 'the zero-row search bar names the real Esc effect only')
  harness.vt.sendInput('x')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  harness.vt.resize(140, 40)
  await harness.settle()
  assert.match(harness.view(), /Search: foo/u, 'the zero-row typing never reached the search input')
  assert.match(bar(harness), /Enter apply/u, 'the zero-row Enter never applied the search')
  // The real Esc is still executable on a zero-row frame: it clears the search.
  harness.vt.resize(80, 2)
  await harness.settle()
  harness.vt.sendInput('\x1b')
  await harness.settle()
  harness.vt.resize(140, 40)
  await harness.settle()
  assert.doesNotMatch(harness.view(), /Search: foo/u, 'Esc cleared the query')
  assert.doesNotMatch(bar(harness), /Enter apply/u, 'Esc left the search editor')
  harness.app.dispose()
})

test('T09 a same-category rail click never steals a plugin sub-view Esc gradient', async () => {
  // Details is the ONE plugin sub-view that paints the Categories rail beside
  // the content; install/confirm/diagnostics own the full width by contract, so
  // the rail click is not physically reachable there (asserted below).
  const details = await open({ columns: 120, rows: 24 })
  await openDetails(details)
  click(details, railRow(details, 'Plugins'), 3)
  await details.settle()
  assert.equal(details.panel.currentView(), 'details', 'the rail click cannot leave Details')
  assert.equal(details.panel.focused, true, 'the page keeps the ONE input focus')
  assert.match(bar(details), /Esc back/u, 'the page keeps the last-row bar')
  details.vt.sendInput('\x1b')
  await details.settle()
  assert.equal(details.panel.currentView(), 'list', 'Esc runs the page gradient first')
  assert.match(details.view(), /Settings · Plugins/u, 'the Settings lease stays open')
  details.app.dispose()

  const fullWidth = await open({ columns: 120, rows: 24 })
  await openRemoveConfirm(fullWidth)
  assert.doesNotMatch(fullWidth.view(), /Categories \(8\)/u, 'the confirmation paints no Categories rail to click')
  assert.equal(fullWidth.panel.focused, true)
  fullWidth.vt.sendInput('\x1b')
  await fullWidth.settle()
  assert.equal(fullWidth.panel.currentView(), 'details', 'Esc cancels the confirmation, not the workspace')
  fullWidth.app.dispose()

  const install = await open({ columns: 120, rows: 24 })
  await openInstall(install)
  assert.doesNotMatch(install.view(), /Categories \(8\)/u, 'the install view paints no Categories rail to click')
  assert.equal(install.panel.focused, true)
  // The page's own Esc gradient (edit -> hide) runs first and never closes the
  // Settings lease: the same sub-view safety the rail click must not bypass.
  install.vt.sendInput('\x1b')
  await install.settle()
  install.vt.sendInput('\x1b')
  await install.settle()
  assert.equal(install.panel.currentView(), 'list', 'the second Esc hides the install view')
  assert.match(install.view(), /Settings · Plugins/u, 'the install Esc gradient never closes the workspace')
  install.app.dispose()

  // Positive control: from the untouched List root the SAME rail click really
  // yields the keyboard to the rail (the §3.3 hand-off, not a refusal).
  const root = await open({ columns: 120, rows: 24 })
  click(root, railRow(root, 'Plugins'), 3)
  await root.settle()
  assert.equal(root.panel.focused, false, 'the List root yields to the rail')
  assert.equal(root.panel.currentView(), 'list', 'the yield keeps the page view')
  assert.match(bar(root), /Esc close/u, 'the rail now owns the last-row bar')
  root.app.dispose()
})

test('T09 the dual wheel routes by the pointer pane and the pair gutter is inert', async () => {
  const harness = await open({ columns: 120, rows: 12 })
  const split = harness.panel.contentLayout()
  assert.equal(split.dual, true, '120x12 keeps the List|Details pair')
  const listOf = (frame: readonly string[]): string[] => frame.map(line => line.slice(24, 24 + split.leftWidth))
  const detailOf = (frame: readonly string[]): string[] => frame.map(line => line.slice(24 + split.leftWidth + 2))
  const before = frameRows(harness)
  // Both cells of the 2-cell pair gutter belong to neither pane.
  wheel(harness, 5, 24 + split.leftWidth)
  await harness.settle()
  assert.deepEqual(frameRows(harness), before, 'the left pair-gutter cell owns no scroll')
  wheel(harness, 5, 24 + split.leftWidth + 1)
  await harness.settle()
  assert.deepEqual(frameRows(harness), before, 'the right pair-gutter cell owns no scroll')

  wheel(harness, 5, 24 + 5)
  await harness.settle()
  const afterList = frameRows(harness)
  assert.notDeepEqual(listOf(afterList), listOf(before), 'the List column scrolled under the pointer')
  assert.deepEqual(detailOf(afterList), detailOf(before), 'the Details column did not move')
  wheel(harness, 5, 24 + split.leftWidth + 2 + 5)
  await harness.settle()
  const afterDetail = frameRows(harness)
  assert.deepEqual(listOf(afterDetail), listOf(afterList), 'the List column did not move')
  assert.notDeepEqual(detailOf(afterDetail), detailOf(afterList), 'the pointer Details column scrolled')

  // Details view paints the SAME pair: the pointer column still decides.
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'details')
  const detailsFrame = frameRows(harness)
  // The list window sits one row down from the section header; the wheel is
  // still routed by the pointer: an UP wheel over the List column must move
  // the List (and never the Details), even while Details owns the keyboard.
  wheel(harness, 5, 24 + 5, false)
  await harness.settle()
  const listHover = frameRows(harness)
  assert.notDeepEqual(listOf(listHover), listOf(detailsFrame), 'the List column under the pointer scrolled in Details view')
  assert.deepEqual(detailOf(listHover), detailOf(detailsFrame), 'Details did not scroll from a List-column wheel')
  wheel(harness, 5, 24 + split.leftWidth + 2 + 5)
  await harness.settle()
  const detailHover = frameRows(harness)
  assert.deepEqual(listOf(detailHover), listOf(listHover), 'the List column did not move')
  assert.notDeepEqual(detailOf(detailHover), detailOf(listHover), 'the Details column scrolled under the pointer')
  harness.app.dispose()
})

test('T09 an App notice between press and release refuses the Host mutation', async () => {
  // 80x10: the notice takes a row, the risk no longer fits and the REPAINTED
  // frame withholds Remove; the stale release must not write before it.
  const stale = await open({ columns: 80, rows: 10 })
  await openRemoveConfirm(stale)
  const removeRow = rowOf(stale, '> Remove')
  assert.match(bar(stale), /Enter confirm/u, 'the primary is admitted while its full risk is painted')
  press(stale, removeRow, 5)
  stale.app.notify('notice reduces risk viewport', 'error')
  release(stale, removeRow, 5)
  await stale.settle()
  assert.deepEqual(stale.removeBundle, [], 'a press whose root chrome moved before the release never dispatches')
  assert.doesNotMatch(stale.view(), /^> Remove\s*$/mu, 'the repainted frame really withholds the primary')
  assert.match(stale.view(), /withheld/u)
  stale.app.dispose()

  // Positive control: the SAME painted gesture without the notice dispatches.
  const fresh = await open({ columns: 80, rows: 10 })
  await openRemoveConfirm(fresh)
  press(fresh, rowOf(fresh, '> Remove'), 5)
  release(fresh, rowOf(fresh, '> Remove'), 5)
  await fresh.settle()
  assert.deepEqual(fresh.removeBundle, ['@vendor/foo'], 'the same painted gesture really dispatches')
  fresh.app.dispose()

  // 120x24: the single-row Details view — the notice moves the content box and
  // shrinks the child grant; the stale Enable release must not toggle.
  const toggle = await open({ columns: 120, rows: 24 })
  await selectCard(toggle, 'bundle:@vendor/foo')
  toggle.vt.sendInput('\r')
  await toggle.settle()
  toggle.vt.sendInput('\x1b[B') // reveal the second Detail action…
  await toggle.settle()
  toggle.vt.sendInput('\x1b[A') // …then reveal/select Enable…
  await toggle.settle()
  const enableRow = rowOf(toggle, '> Enable…')
  press(toggle, enableRow, 70)
  toggle.app.notify('notice reduces risk viewport', 'error')
  release(toggle, enableRow, 70)
  await toggle.settle()
  assert.deepEqual(toggle.setBundle, [], 'the stale Enable release never writes the Host')
  toggle.app.dispose()

  const toggleFresh = await open({ columns: 120, rows: 24 })
  await selectCard(toggleFresh, 'bundle:@vendor/foo')
  toggleFresh.vt.sendInput('\r')
  await toggleFresh.settle()
  toggleFresh.vt.sendInput('\x1b[B')
  await toggleFresh.settle()
  toggleFresh.vt.sendInput('\x1b[A')
  await toggleFresh.settle()
  press(toggleFresh, rowOf(toggleFresh, '> Enable…'), 70)
  release(toggleFresh, rowOf(toggleFresh, '> Enable…'), 70)
  await toggleFresh.settle()
  assert.deepEqual(toggleFresh.setBundle, [{ name: '@vendor/foo', enabled: true }], 'the same painted Enable button really dispatches')
  toggleFresh.app.dispose()

  // A rail wheel in the unrepainted window must not scroll with the old pane
  // geometry; after the repaint the same wheel really scrolls the rail. 120x8
  // keeps the rail viewport at three rows before AND after the notice, so the
  // only variable is whether the stale wheel was admitted.
  const railWheel = await open({ columns: 120, rows: 8 })
  await yieldToRail(railWheel)
  const railLabels = ['About', 'Models', 'Account', 'Appearance', 'Display', 'Tools', 'Plugins', 'Other settings']
  const visibleRail = (): string[] => frameRows(railWheel)
    .map(line => line.slice(0, 22).trim())
    .map(cell => cell.replace(/^> /u, ''))
    .filter(cell => railLabels.includes(cell))
  const railBefore = visibleRail()
  assert.ok(railBefore.length > 0, `the rail must be painted:\n${railWheel.view()}`)
  railWheel.app.notify('notice moves the rail geometry', 'error')
  wheel(railWheel, 6, 2)
  await railWheel.settle()
  assert.deepEqual(visibleRail(), railBefore, 'a rail wheel in the unrepainted chrome window owns no scroll')
  wheel(railWheel, 6, 2)
  await railWheel.settle()
  assert.notDeepEqual(visibleRail(), railBefore, 'the repainted rail still scrolls under the pointer')
  railWheel.app.dispose()
  // The shortest interleaving: a chrome-changing REPAINT alone crosses the
  // gesture boundary — no wheel or second press ever samples a stale gate. At
  // 120x8 the notice takes the rule row while contentTop/contentRows and the
  // pressed rail target stay identical, so only the paint-time boundary
  // prevents the release from completing the pre-repaint click.
  const repainted = await open({ columns: 120, rows: 8 })
  await yieldToRail(repainted)
  press(repainted, railRow(repainted, 'Display'), 3)
  repainted.app.notify('notice repaints before the release', 'error')
  await repainted.settle()
  assert.match(repainted.view(), /notice repaints before the release/u, 'the notice really repainted')
  release(repainted, railRow(repainted, 'Display'), 3)
  await repainted.settle()
  assert.match(repainted.view(), /^> Plugins\b/mu, 'the release after a chrome-changing repaint never switches category')
  assert.doesNotMatch(repainted.view(), /Scope: Display/u)
  // Positive control on a fresh cell: the panel still admits a new gesture.
  click(repainted, railRow(repainted, 'Tools'), 3)
  await repainted.settle()
  assert.match(repainted.view(), /Scope: TUI preferences/u, 'a fresh rail gesture still switches category')
  repainted.app.dispose()

  // The other half of the contract: a repaint that keeps the SAME row
  // allocation is benign and must NOT drop an accepted press.
  const benign = await open({ columns: 120, rows: 8 })
  await yieldToRail(benign)
  press(benign, railRow(benign, 'Display'), 3)
  benign.app.requestRender()
  await benign.settle()
  release(benign, railRow(benign, 'Display'), 3)
  await benign.settle()
  assert.match(benign.view(), /^> Display\b/mu, 'a same-plan repaint keeps the pending press alive')
  assert.match(benign.view(), /Scope: TUI preferences/u, 'the preserved press really switched to Display')
  benign.app.dispose()

  // The interleaving that neither single case covers: a pending rail press, a
  // refused wheel in the unrepainted window, then a release after the repaint.
  // 120x8 keeps contentTop/contentRows (and the pressed target's row) identical
  // across the notice, so only the revoked press prevents the category change.
  const interleaved = await open({ columns: 120, rows: 8 })
  await yieldToRail(interleaved)
  const displayRow = railRow(interleaved, 'Display')
  press(interleaved, displayRow, 3)
  interleaved.app.notify('notice between press and wheel', 'error')
  wheel(interleaved, 6, 2)
  await interleaved.settle()
  release(interleaved, railRow(interleaved, 'Display'), 3)
  await interleaved.settle()
  assert.match(interleaved.view(), /^> Plugins\b/mu, 'the category is still Plugins after the stale release')
  assert.doesNotMatch(interleaved.view(), /Scope: Display/u, 'the release after a refused stale wheel never switches category')
  assert.equal(interleaved.panel.focused, false, 'the rail still owns the keyboard after the repaint')
  // Positive control on a DIFFERENT rail row: the fork withholds a click whose
  // press lands on the same cell inside its multi-click window, so reusing the
  // Display cell here would prove the fork's double-click rule rather than the
  // panel's admission. The neighboring Tools row is a fresh cell and switches.
  click(interleaved, railRow(interleaved, 'Tools'), 3)
  await interleaved.settle()
  assert.match(interleaved.view(), /Scope: TUI preferences/u, 'a fresh rail gesture still switches category')
  interleaved.app.dispose()

  // The same notice moves the ROOT-owned rail hit map. A press on the old About
  // row must not become a category change (which would dispose the List page)
  // after the notice took a row.
  const railCase = await open({ columns: 120, rows: 24 })
  await selectCard(railCase, 'bundle:@vendor/foo')
  const aboutRow = railRow(railCase, 'About')
  press(railCase, aboutRow, 3)
  railCase.app.notify('notice moves the rail hit map', 'error')
  release(railCase, aboutRow, 3)
  await railCase.settle()
  assert.match(railCase.view(), /Settings · Plugins/u, 'the stale rail release never changes the category')
  assert.equal(railCase.panel.currentView(), 'list', 'the stale rail release never disposes the plugin page')
  // Positive control: the repainted frame promotes the SAME rail target at its
  // NEW row (one row lower) and really switches category.
  click(railCase, railRow(railCase, 'About'), 3)
  await railCase.settle()
  assert.match(railCase.view(), /Scope: About/u, 'the fresh rail frame still switches category')
  railCase.app.dispose()
})

test('T09 a Controller install-phase change between press and release refuses the old action', async () => {
  const harness = await open({
    columns: 120,
    rows: 24,
    installImpl: async () => ({
      changed: true,
      application: 'failed',
      stage: 'install',
      target: 'x',
      pendingBuilds: ['evil-pkg'],
    }),
  })
  await openInstall(harness)
  // Drive the explicit Inspect -> Install path through the page keys until the
  // attempt settles as failed with its approval risk painted.
  for (let attempt = 0; attempt < 3 && harness.controller.installView()?.phase !== 'failed'; attempt += 1) {
    harness.vt.sendInput('\r')
    await harness.settle()
  }
  assert.equal(harness.controller.installView()?.phase, 'failed')
  assert.equal(harness.installCalls.length, 1)
  const approveRow = rowOf(harness, 'Approve and retry')
  press(harness, approveRow, 5)
  // A Controller phase change under the press (a new manual attempt) must
  // invalidate the old approve target before its release.
  assert.equal(harness.controller.beginManualInstall(), true, 'a new manual attempt is admitted')
  release(harness, approveRow, 5)
  await harness.settle()
  assert.equal(harness.installCalls.length, 1, 'the stale approve release never dispatches a second install')
  assert.equal(harness.controller.installView()?.phase, 'editing', 'the new attempt stays in its own phase')
  // Control: the settled editing frame keeps the SAME request identity AND
  // admits a real POINTER click on its painted Inspect action.
  const editingBefore = harness.controller.installView()?.requestId
  assert.equal(harness.controller.installView()?.requestId, editingBefore, 'the request identity is unchanged')
  // The editing frame needs a spec before Inspect is admitted.
  for (const character of 'pkg') harness.vt.sendInput(character)
  await harness.settle()
  const inspectRow = rowOf(harness, 'Inspect')
  await clickCell(harness, inspectRow, 5)
  assert.notEqual(harness.controller.installView()?.phase, 'editing',
    'the fresh editing frame admits a pointer click on its own Inspect action')
  assert.equal(harness.controller.installView()?.requestId, editingBefore,
    'the pointer-driven Inspect keeps the ONE request identity')
  harness.app.dispose()
})

test('T09 a real Port invalidation while the press is held refuses the old release', async () => {
  // The harness wires the PRODUCTION `PluginManagerPort.subscribeInvalidation`
  // subscription: `invalidate()` is the Host's own invalidation signal, which
  // makes the Controller reread the authoritative inventory.
  const harness = await open({ columns: 120, rows: 24 })
  await selectCard(harness, 'bundle:@vendor/foo')
  const cardRow = rowOf(harness, '> @vendor/foo')
  const readsBefore = harness.snapshotCalls()
  press(harness, cardRow, 30)
  harness.invalidate()
  await harness.settle()
  assert.ok(harness.snapshotCalls() > readsBefore, 'the Port invalidation really reread the inventory')
  release(harness, cardRow, 30)
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'list', 'a Port invalidation held across the press refuses the release')
  assert.equal(harness.panel.selectedCardValue(), 'bundle:@vendor/foo', 'the press never re-selected a card')
  // Positive control on another card row (the fork withholds a same-cell click in
  // its multi-click window, so reusing the pressed cell would test the fork).
  const otherRow = rowOf(harness, '@deepseek-ai/dsh-base')
  press(harness, otherRow, 30)
  release(harness, otherRow, 30)
  await harness.settle()
  assert.equal(harness.panel.selectedCardValue(), 'bundle:@deepseek-ai/dsh-base', 'the settled frame admits a fresh selection')
  harness.app.dispose()
})

test('T09 a plugin sub-view change under a held rail press refuses the old release', async () => {
  // §3.4/§4.4: a Plugin sub-view change (Details -> List via the page's own Esc)
  // must invalidate a root gesture recorded against the rail. The wide
  // projection and the content box are UNCHANGED across that transition, so the
  // root revision must be bumped for the old release to be refused.
  const harness = await open({ columns: 120, rows: 24 })
  await openDetails(harness)
  assert.equal(harness.panel.currentView(), 'details')

  // Hold a press on another category's rail row while the page owns the content.
  const aboutRow = railRow(harness, 'About')
  press(harness, aboutRow, 3)
  assert.equal(harness.panel.currentView(), 'details', 'the rail press never activates immediately')

  // The PAGE consumes Esc: Details -> List. The projection is unchanged, so a
  // release that only compares the root revision and the target identity would
  // still match the old rail hit.
  harness.vt.sendInput('\x1b')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'list', 'the page Esc ran its own gradient')

  release(harness, aboutRow, 3)
  await harness.settle()
  assert.match(harness.view(), /Settings · Plugins/u, 'the stale rail release never switches category')
  assert.doesNotMatch(harness.view(), /Scope: About/u)
  assert.equal(harness.panel.currentView(), 'list', 'the plugin page survives the stale release')

  // Positive control on the settled frame: a fresh rail click on ANOTHER row
  // really switches category. (The About cell was just released, so clicking it
  // again would land inside the fork's multi-click window.)
  click(harness, railRow(harness, 'Models'), 3)
  await harness.settle()
  assert.match(harness.view(), /^> Models\b/mu, 'the fresh rail click selects the Models category')
  assert.equal(harness.panel.currentView(), 'list', 'the switched-away plugin page released its view')
  harness.app.dispose()
})

test('T09 a same-view filter or selection change under a held rail press refuses the old release', async () => {
  // §3.4: the fence must cover child changes INSIDE the same view — the page
  // stays `list`, keeps its yield status, and its projection/rail targets do not
  // move, but its filter and selection (and therefore its own hit map) changed.
  for (const change of ['filter', 'selection'] as const) {
    const harness = await open({ columns: 120, rows: 24 })
    await selectCard(harness, 'bundle:@vendor/foo')
    assert.equal(harness.panel.currentView(), 'list')
    const before = harness.panel.gestureRevision()

    const aboutRow = railRow(harness, 'About')
    press(harness, aboutRow, 3)
    // A key the ROOT forwards into the page: Tab cycles the status filter, Down
    // moves the selected card. Both keep view/yield unchanged.
    harness.vt.sendInput(change === 'filter' ? '\t' : '\x1b[B')
    await harness.settle()
    assert.equal(harness.panel.currentView(), 'list', `${change}: the page stayed on the List view`)
    assert.ok(harness.panel.gestureRevision() > before, `${change}: the page's own gesture revision advanced`)

    release(harness, aboutRow, 3)
    await harness.settle()
    assert.match(harness.view(), /Settings · Plugins/u, `${change}: the stale rail release never switches category`)
    assert.doesNotMatch(harness.view(), /Scope: About/u)
    assert.equal(harness.panel.currentView(), 'list', `${change}: the plugin page survives the stale release`)

    // Positive control on a fresh rail row: the settled frame still switches.
    click(harness, railRow(harness, 'Models'), 3)
    await harness.settle()
    assert.match(harness.view(), /^> Models\b/mu, `${change}: the fresh rail click still switches category`)
    harness.app.dispose()
  }
})

test('T09 the 119<->120 and 75<->76 width boundaries refuse a straddling gesture', async () => {
  // 119 -> 120: the rail APPEARS, so the plugin content starts at x=24 instead
  // of x=0 while the pressed screen cell keeps the same number.
  const toWide = await open({ columns: 119, rows: 24 })
  await selectCard(toWide, 'bundle:@vendor/foo')
  // 76..119 with the content focused is the adjacent pair WITHOUT the rail, so
  // the same screen cell changes meaning across the boundary.
  assert.doesNotMatch(toWide.view(), /Categories \(8\)/u, '119 content focus paints no Categories rail')
  assert.match(toWide.view(), /\[Plugins\]/u, '119 paints the shared pane header')
  const wideRow = rowOf(toWide, '> @vendor/foo')
  press(toWide, wideRow, 6)
  toWide.vt.resize(120, 24)
  release(toWide, wideRow, 6)
  await toWide.settle()
  assert.equal(toWide.panel.currentView(), 'list', 'the 119->120 straddle never opens Details')
  const wideFresh = rowOf(toWide, '> @vendor/foo')
  press(toWide, wideFresh, 30)
  release(toWide, wideFresh, 30)
  await toWide.settle()
  assert.equal(toWide.panel.currentView(), 'details', 'the settled 120 frame admits the click')
  toWide.app.dispose()

  // 120 -> 119: the rail disappears and the content takes x=0.
  const toMedium = await open({ columns: 120, rows: 24 })
  await selectCard(toMedium, 'bundle:@vendor/foo')
  const mediumRow = rowOf(toMedium, '> @vendor/foo')
  press(toMedium, mediumRow, 30)
  toMedium.vt.resize(119, 24)
  release(toMedium, mediumRow, 30)
  await toMedium.settle()
  assert.equal(toMedium.panel.currentView(), 'list', 'the 120->119 straddle never opens Details')
  const mediumFresh = rowOf(toMedium, '> @vendor/foo')
  press(toMedium, mediumFresh, 6)
  release(toMedium, mediumFresh, 6)
  await toMedium.settle()
  assert.equal(toMedium.panel.currentView(), 'details', 'the settled 119 frame admits the click at its own x')
  toMedium.app.dispose()

  // 75 -> 76: the rail/content projection switches from ONE column to the
  // adjacent pair, and the page is mounted on that transition.
  const narrow = await open({ columns: 75, rows: 24 })
  await selectCard(narrow, 'bundle:@vendor/foo')
  const narrowRow = rowOf(narrow, '> @vendor/foo')
  press(narrow, narrowRow, 6)
  narrow.vt.resize(76, 24)
  release(narrow, narrowRow, 6)
  await narrow.settle()
  assert.equal(narrow.panel.currentView(), 'list', 'the 75->76 straddle never opens Details')
  const narrowFresh = rowOf(narrow, '> @vendor/foo')
  press(narrow, narrowFresh, 6)
  release(narrow, narrowFresh, 6)
  await narrow.settle()
  assert.equal(narrow.panel.currentView(), 'details', 'the settled 76 frame admits the click')
  narrow.app.dispose()

  // 76 -> 75: the pair collapses back to one column.
  const collapse = await open({ columns: 76, rows: 24 })
  await selectCard(collapse, 'bundle:@vendor/foo')
  const collapseRow = rowOf(collapse, '> @vendor/foo')
  press(collapse, collapseRow, 40)
  collapse.vt.resize(75, 24)
  release(collapse, collapseRow, 40)
  await collapse.settle()
  assert.equal(collapse.panel.currentView(), 'list', 'the 76->75 straddle never opens Details')
  const collapseFresh = rowOf(collapse, '> @vendor/foo')
  press(collapse, collapseFresh, 6)
  release(collapse, collapseFresh, 6)
  await collapse.settle()
  assert.equal(collapse.panel.currentView(), 'details', 'the settled 75 frame admits the click')
  collapse.app.dispose()
})

test('T09 resize, focus yield, filter edit and external disposal refuse the old release', async () => {
  // Press -> resize (120x8 -> 120x7 keeps the child grant but moves the box
  // top) -> release.
  const resizeCase = await open({ columns: 120, rows: 8 })
  await selectCard(resizeCase, 'bundle:@vendor/foo')
  const cardRow = rowOf(resizeCase, '> @vendor/foo')
  press(resizeCase, cardRow, 30)
  resizeCase.vt.resize(120, 7)
  release(resizeCase, cardRow, 30)
  await resizeCase.settle()
  assert.equal(resizeCase.panel.currentView(), 'list', 'a resize before the release never opens Details')
  const movedRow = rowOf(resizeCase, '> @vendor/foo')
  assert.equal(movedRow, cardRow - 1, 'the same child grant really moved the painted box top')
  press(resizeCase, movedRow, 30)
  release(resizeCase, movedRow, 30)
  await resizeCase.settle()
  assert.equal(resizeCase.panel.currentView(), 'details', 'the fresh frame admits the same click')
  resizeCase.app.dispose()

  // Resize -> press/release before the repaint.
  const preRepaint = await open({ columns: 140, rows: 24 })
  await selectCard(preRepaint, 'bundle:@vendor/foo')
  const staleRow = rowOf(preRepaint, '> @vendor/foo')
  preRepaint.vt.resize(80, 24)
  press(preRepaint, staleRow, 30)
  release(preRepaint, staleRow, 30)
  await preRepaint.settle()
  assert.equal(preRepaint.panel.currentView(), 'list', 'a press before the resize repaint is refused')
  const newRow = rowOf(preRepaint, '> @vendor/foo')
  press(preRepaint, newRow, 5)
  release(preRepaint, newRow, 5)
  await preRepaint.settle()
  assert.equal(preRepaint.panel.currentView(), 'details', 'the repainted medium frame admits the same click')
  preRepaint.app.dispose()

  // Press -> focus yield (Shift+Tab) -> release must not open Details.
  const focusCase = await open({ columns: 120, rows: 24 })
  await selectCard(focusCase, 'bundle:@vendor/foo')
  const focusRow = rowOf(focusCase, '> @vendor/foo')
  press(focusCase, focusRow, 30)
  focusCase.vt.sendInput('\x1b[Z')
  await focusCase.settle()
  assert.equal(focusCase.panel.focused, false, 'the List root really yielded')
  release(focusCase, focusRow, 30)
  await focusCase.settle()
  assert.equal(focusCase.panel.currentView(), 'list', 'the focus yield drops the press')
  assert.match(bar(focusCase), /Esc close/u)
  // §8 T09 wants a MOUSE control on the next frame: re-focus the List through
  // the rail, then click a DIFFERENT card's painted cell (not the pressed one).
  focusCase.vt.sendInput('\r')
  await focusCase.settle()
  assert.equal(focusCase.panel.focused, true, 'the fresh rail Enter re-focuses the plugin List')
  const otherCell = rowOf(focusCase, '@deepseek-ai/dsh-base')
  await clickCell(focusCase, otherCell, 30)
  assert.equal(focusCase.panel.selectedCardValue(), 'bundle:@deepseek-ai/dsh-base',
    'the fresh frame admits a real pointer selection on another card')
  assert.equal(focusCase.panel.currentView(), 'list', 'a first click on an unselected card only selects')
  // One pointer control is the requirement; a second same-cell click would land
  // inside the fork's multi-click window (word select) rather than test admission.
  focusCase.app.dispose()

  // Press -> an in-page key that changes the page's own presentation -> release
  // must not open Details. `Tab` cycles the STATUS FILTER, which hides the
  // disabled card under test, so the witness uses the page's own search row:
  // opening the editor repaints and moves the pointer target set while the
  // pressed card stays visible.
  const filterCase = await open({ columns: 120, rows: 24 })
  await selectCard(filterCase, 'bundle:@vendor/foo')
  const filterRow = rowOf(filterCase, '> @vendor/foo')
  press(filterCase, filterRow, 30)
  filterCase.vt.sendInput('/')
  await filterCase.settle()
  assert.match(bar(filterCase), /Enter apply/u, 'the search editor really opened under the press')
  release(filterCase, filterRow, 30)
  await filterCase.settle()
  assert.equal(filterCase.panel.currentView(), 'list', 'an in-page edit between press and release refuses the old release')
  // Control: after Esc leaves the editor, a POINTER click on another card acts.
  filterCase.vt.sendInput('\x1b')
  await filterCase.settle()
  await clickCell(filterCase, rowOf(filterCase, '@deepseek-ai/dsh-base'), 30)
  assert.equal(filterCase.panel.selectedCardValue(), 'bundle:@deepseek-ai/dsh-base',
    'the fresh frame admits a pointer selection after the in-page edit')
  filterCase.app.dispose()

  // Press -> the page's own Host notice change -> release.
  const noticeCase = await open({ columns: 120, rows: 24 })
  await selectCard(noticeCase, 'bundle:@vendor/foo')
  const noticeRow = rowOf(noticeCase, '> @vendor/foo')
  press(noticeCase, noticeRow, 30)
  noticeCase.controller.explain('the inventory changed under the press')
  release(noticeCase, noticeRow, 30)
  await noticeCase.settle()
  assert.equal(noticeCase.panel.currentView(), 'list', 'a Host-notice change between press and release refuses the old release')
  // Control: after the notice settles, a POINTER click on another card acts.
  await clickCell(noticeCase, rowOf(noticeCase, '@deepseek-ai/dsh-base'), 30)
  assert.equal(noticeCase.panel.selectedCardValue(), 'bundle:@deepseek-ai/dsh-base',
    'the settled frame admits a pointer selection after the notice')
  noticeCase.app.dispose()

  // Press -> a real category change -> the original release must not act on the
  // disposed plugin page.
  const categoryCase = await open({ columns: 120, rows: 24 })
  await selectCard(categoryCase, 'bundle:@vendor/foo')
  const categoryRow = rowOf(categoryCase, '> @vendor/foo')
  press(categoryCase, categoryRow, 30)
  click(categoryCase, railRow(categoryCase, 'About'), 3)
  await categoryCase.settle()
  assert.match(categoryCase.view(), /Scope: About/u, 'the category change really happened')
  assert.match(categoryCase.view(), /^> About\b/mu, 'the rail selects About')
  assert.equal(categoryCase.panel.focused, false, 'the disposed plugin page released the input focus')
  release(categoryCase, categoryRow, 30)
  await categoryCase.settle()
  assert.equal(categoryCase.panel.currentView(), 'list', 'the old release never opens Details on the disposed page')
  assert.deepEqual(categoryCase.removeBundle, [])
  assert.deepEqual(categoryCase.setBundle, [])
  // Control AFTER the stale release: return to Plugins and click a fresh cell.
  for (let step = 0; step < 12; step += 1) {
    if (/^> Plugins\b/mu.test(categoryCase.view())) break
    categoryCase.vt.sendInput('\x1b[B')
    await categoryCase.settle()
  }
  assert.match(categoryCase.view(), /^> Plugins\b/mu, 'the rail re-selects the Plugins category')
  // Rail Enter hands the keyboard to the List without cycling the page's own
  // status filter (Tab inside the content is the page's filter key).
  categoryCase.vt.sendInput('\r')
  await categoryCase.settle()
  assert.equal(categoryCase.panel.focused, true, 'the fresh Plugins frame admits the rail focus key')
  await clickCell(categoryCase, rowOf(categoryCase, '@deepseek-ai/dsh-base'), 30)
  assert.equal(categoryCase.panel.selectedCardValue(), 'bundle:@deepseek-ai/dsh-base',
    'the fresh Plugins frame admits a real pointer selection')
  categoryCase.app.dispose()

  // Press -> external parent close -> release must not write the Host.
  const disposed = await open({ columns: 80, rows: 10 })
  await openRemoveConfirm(disposed)
  const disposeRow = rowOf(disposed, '> Remove')
  press(disposed, disposeRow, 5)
  disposed.settings.close()
  release(disposed, disposeRow, 5)
  assert.deepEqual(disposed.removeBundle, [], 'an externally closed workspace never dispatches the old release')

  // Control on the SAME app/runtime: the closed lease is re-opened and its page
  // admits a real pointer gesture (no phantom owner or stale claim survives).
  // PRODUCTION SEMANTICS: `PluginManagerRuntime.page()` calls
  // `controller.open()` on every successful page creation, so the re-mount
  // starts a NEW inventory read (read generation advances) and the page must be
  // current again before its hit map may act.
  const readsBeforeReopen = disposed.snapshotCalls()
  const generationBeforeReopen = disposed.controller.readGeneration()
  await disposed.reopen()
  assert.match(disposed.view(), /Settings · Plugins/u, 'the SAME app re-opened the Settings lease')
  assert.equal(disposed.snapshotCalls(), readsBeforeReopen + 1,
    'the re-mounted page started exactly ONE new inventory read')
  assert.equal(disposed.controller.readGeneration(), generationBeforeReopen + 1,
    'the re-mount advanced the read generation')
  // The first frame after the re-open may still be loading; wait for the NEW
  // authoritative inventory before the pointer control. (80x10 keeps a one-row
  // list window, so the readiness witness is a visible card, not the target.)
  for (let attempt = 0; attempt < 40 && !disposed.view().includes('Official DSH'); attempt += 1) {
    await disposed.settle()
  }
  assert.match(disposed.view(), /@deepseek-ai\/dsh-base/u, 'the re-mounted page settled on the new inventory')
  assert.doesNotMatch(disposed.view(), /Loading plugins/u, 'the re-mounted page left its loading state')
  // 80x10 keeps a one-row list window: select the target with the page's own keys
  // first, then prove the POINTER still hits the painted selection row.
  for (let step = 0; step < 30 && disposed.panel.selectedCardValue() !== 'bundle:@vendor/foo'; step += 1) {
    disposed.vt.sendInput('\x1b[B')
    await disposed.settle()
  }
  assert.equal(disposed.panel.selectedCardValue(), 'bundle:@vendor/foo', 'the re-opened page selected the card')
  await clickCell(disposed, rowOf(disposed, '> @vendor/foo'), 30)
  assert.equal(disposed.panel.currentView(), 'details', 'the re-opened page admits a real pointer click')
  disposed.app.dispose()
})

test('T03 a 75-column production page mounts lazily from the Categories rail', async () => {
  // §8.1 T03: below 76 columns the Settings lease opens on the rail; merely
  // SELECTING Plugins must not build the page or read the Host inventory. The
  // FIRST production-page mount happens when the content takes the keyboard.
  const harness = await open({ columns: 75, rows: 20, startOn: 'rail' })
  assert.equal(harness.panelInstance(), undefined, 'the rail selection mounts no page')
  assert.equal(harness.snapshotCalls(), 0, 'the rail selection reads no inventory')
  assert.doesNotMatch(harness.view(), /Search: \//u, 'the narrow rail paints no plugin content')

  // Walk the rail to Plugins with the real keys: the category is now selected,
  // and the content column still does not exist at this width.
  for (let step = 0; step < 12; step += 1) {
    if (/^> Plugins\b/mu.test(harness.view())) break
    harness.vt.sendInput('\x1b[B')
    await harness.settle()
  }
  assert.match(harness.view(), /^> Plugins\b/mu, 'the rail selects Plugins')
  assert.equal(harness.panelInstance(), undefined, 'selecting the category still mounts nothing')
  assert.equal(harness.snapshotCalls(), 0, 'selecting the category still reads nothing')

  // Enter takes the content: the page is built ONCE and reads the inventory once.
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.ok(harness.panelInstance() !== undefined, 'the first focus transfer mounts the page')
  assert.equal(harness.snapshotCalls(), 1, 'the mount reads the inventory exactly once')
  assert.match(harness.view(), /Search: \//u, 'the narrow content paints its local Search row')
  assert.match(bar(harness), /Esc back/u)

  // Esc yields back to the rail and keeps the SAME page (no re-read, no dispose).
  const page = harness.panel
  harness.vt.sendInput('\x1b')
  await harness.settle()
  assert.equal(harness.panelInstance(), page, 'the yield keeps the one page instance')
  assert.equal(harness.snapshotCalls(), 1, 'the yield never re-reads the inventory')
  assert.match(harness.view(), /> Plugins/u, 'the rail owns the frame again')

  // Re-entering reuses the page: still ONE instance and ONE read.
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.equal(harness.panelInstance(), page, 're-entering reuses the page')
  assert.equal(harness.snapshotCalls(), 1)

  // §8.1 T03 tail: from the re-entered List, Esc yields to the rail and the
  // NEXT Esc closes the SAME Settings lease.
  harness.vt.sendInput('\x1b')
  await harness.settle()
  assert.match(harness.view(), /Settings · Categories/u, 'the List Esc yields to the rail')
  assert.equal(harness.panelInstance(), page, 'the yield keeps the page')
  harness.vt.sendInput('\x1b')
  await harness.settle()
  assert.doesNotMatch(harness.view(), /Settings · /u, 'the second Esc closed the SAME Settings lease')
  harness.app.dispose()
})

test('T07 Tab never crosses levels from Confirm, Install or Diagnostics', async () => {
  // §3.3: every non-List sub-state keeps its own local keys; Tab/Shift+Tab must
  // never climb back to the Categories rail.
  const confirm = await open({ columns: 120, rows: 24 })
  await openRemoveConfirm(confirm)
  confirm.vt.sendInput('\t')
  await confirm.settle()
  assert.equal(confirm.panel.currentView(), 'confirm', 'Tab inside the confirmation never leaves it')
  assert.equal(confirm.panel.focused, true, 'the confirmation keeps the ONE input owner')
  confirm.vt.sendInput('\x1b[Z')
  await confirm.settle()
  assert.equal(confirm.panel.currentView(), 'confirm', 'Shift+Tab inside the confirmation never leaves it')
  assert.match(bar(confirm), /Esc cancel/u, 'the confirmation keeps its own bar')
  confirm.app.dispose()

  const install = await open({ columns: 120, rows: 24 })
  await openInstall(install)
  const installBar = bar(install)
  install.vt.sendInput('\t')
  await install.settle()
  assert.equal(install.panel.currentView(), 'install', 'Tab inside the install view never leaves it')
  assert.equal(install.panel.focused, true)
  install.vt.sendInput('\x1b[Z')
  await install.settle()
  assert.equal(install.panel.currentView(), 'install', 'Shift+Tab inside the install view never leaves it')
  assert.equal(install.panel.focused, true)
  assert.equal(bar(install), installBar, 'the install bar is unchanged by the region keys')
  install.app.dispose()

  const diagnostics = await open({ columns: 120, rows: 24 })
  diagnostics.vt.sendInput('d')
  await diagnostics.settle()
  assert.equal(diagnostics.panel.currentView(), 'diagnostics')
  diagnostics.vt.sendInput('\t')
  await diagnostics.settle()
  diagnostics.vt.sendInput('\x1b[Z')
  await diagnostics.settle()
  assert.equal(diagnostics.panel.currentView(), 'diagnostics', 'neither region key leaves Diagnostics')
  assert.equal(diagnostics.panel.focused, true, 'Diagnostics keeps the ONE input owner')
  assert.match(bar(diagnostics), /Esc back/u, 'Diagnostics keeps its own Esc')
  diagnostics.app.dispose()
})

test('T08 the 76..119 Categories+List preview reprojects the mouse after the focus switch', async () => {
  // §3.3/§3.4: with the rail focused at 76..119 the projection is
  // Categories | List and the content starts at x=24. Enter/Tab/a preview click
  // move the keyboard into the List, and the NEXT frame is List | Details with
  // the content at x=0 — so the same screen cell changes meaning.
  const harness = await open({ columns: 100, rows: 24 })
  await yieldToRail(harness)
  assert.match(harness.view(), /Categories \(8\)/u, 'the rail-focused medium frame paints the Categories column')
  assert.equal(columnOf(harness, rowOf(harness, 'Search: /'), 'Search: /'), 24, 'the preview starts after the rail')
  const previewCard = rowOf(harness, '@vendor/foo')
  assert.ok(previewCard >= 0, `the preview paints the third-party card:
${harness.view()}`)
  const before = harness.panel.selectedCardValue()

  // A preview click selects the card and transfers the keyboard — it must never
  // dispatch a Host mutation or open Details.
  click(harness, previewCard, 30)
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'list', 'a preview click only selects; it never opens Details')
  assert.equal(harness.panel.focused, true, 'the preview click transferred the keyboard into the List')
  assert.equal(harness.panel.selectedCardValue(), 'bundle:@vendor/foo', 'the clicked card became the selection')
  assert.notEqual(before, harness.panel.selectedCardValue(), 'the click really changed the selection')
  assert.deepEqual(harness.setBundle, [], 'a preview click never writes the Host')
  assert.deepEqual(harness.removeBundle, [])

  // The focus switch changed the projection: the content column is now x=0.
  assert.equal(columnOf(harness, rowOf(harness, 'Search: /'), 'Search: /'), 0, 'the content took the leading column')
  assert.doesNotMatch(harness.view(), /Categories \(8\)/u, 'the rail is gone while the content owns the keys')

  // A click at the NEW coordinate on the SELECTED card opens Details.
  const reprojected = rowOf(harness, '> @vendor/foo')
  click(harness, reprojected, 6)
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'details', 'the reprojected cell opens Details on the focused card')
  harness.app.dispose()
})

test('T09 a Host invalidation before the repaint refuses the held rail press', async () => {
  // §3.4 Press -> Host invalidate: the Controller's read generation and state
  // change BEFORE the queued repaint runs, so the page's synchronous revision is
  // still old. The root fence must use the page's LIVE currentness.
  const harness = await open({ columns: 120, rows: 24 })
  await selectCard(harness, 'bundle:@vendor/foo')
  const aboutRow = railRow(harness, 'About')
  press(harness, aboutRow, 3)
  harness.invalidate()
  // NO settle: the page has not repainted, and `gestureRevision()` may be old.
  // The invalidation really moved the LIVE Controller state (a re-read is in
  // flight), which is what a boolean currentness could not distinguish.
  assert.match(harness.panel.liveIdentity(), /loading/, 'the invalidation moved the live Controller state')
  release(harness, aboutRow, 3)
  await harness.settle()
  assert.match(harness.view(), /Settings · Plugins/u, 'the stale rail release never switches category')
  assert.equal(harness.panel.currentView(), 'list', 'the plugin page survives the stale release')
  // Positive control on a fresh rail row once the frame is current again.
  click(harness, railRow(harness, 'Models'), 3)
  await harness.settle()
  assert.match(harness.view(), /^> Models\b/mu, 'the fresh rail click still switches category')
  harness.app.dispose()
})

test('T09 a no-op wheel never cancels a legal rail click', async () => {
  // RFL-012: a wheel that cannot move the window must not bump the page's
  // gesture revision, or a legitimate rail press would be refused with no
  // visible change to justify it.
  const harness = await open({ columns: 120, rows: 12 })
  await selectCard(harness, 'bundle:@vendor/foo')
  const listRow = rowOf(harness, 'Search: /')
  const before = harness.panel.gestureRevision()
  // An UP wheel over the List at offset 0 cannot move it.
  wheel(harness, listRow + 1, 30, false)
  await harness.settle()
  assert.equal(harness.panel.gestureRevision(), before, 'a no-op List wheel does not bump the revision')

  // A rail press held across that no-op wheel must still be admitted.
  const aboutRow = railRow(harness, 'About')
  press(harness, aboutRow, 3)
  wheel(harness, listRow + 1, 30, false)
  await harness.settle()
  release(harness, aboutRow, 3)
  await harness.settle()
  assert.match(harness.view(), /^> About\b/mu, 'the legal rail press survives an immaterial wheel')
  harness.app.dispose()
})

test('T09 a SECOND invalidation while already stale still refuses the held rail press', async () => {
  // RFL-011 follow-up: a boolean "is the frame current?" cannot tell two stale
  // states apart. The comparable live identity must change with each read.
  const harness = await open({ columns: 120, rows: 24 })
  await selectCard(harness, 'bundle:@vendor/foo')
  // Make the page stale FIRST, then press, then invalidate AGAIN.
  harness.invalidate()
  const staleBefore = harness.panel.liveIdentity()
  const aboutRow = railRow(harness, 'About')
  press(harness, aboutRow, 3)
  harness.invalidate()
  assert.notEqual(harness.panel.liveIdentity(), staleBefore,
    'the second invalidation changed the live identity even though both states are stale')
  release(harness, aboutRow, 3)
  await harness.settle()
  assert.match(harness.view(), /Settings · Plugins/u, 'the stale-then-invalidated rail release never switches category')
  assert.equal(harness.panel.currentView(), 'list', 'the plugin page survives')
  // Positive control once the frame is current again.
  click(harness, railRow(harness, 'Models'), 3)
  await harness.settle()
  assert.match(harness.view(), /^> Models\b/mu, 'the fresh rail click still switches category')
  harness.app.dispose()
})

test('T09 a wheel at the END of a scroll window never cancels a legal rail click', async () => {
  // RFL-012 follow-up: the lower bound was guarded, but the END of the window
  // still bumped (the paint clamps the offset back), so a held rail click was
  // refused with no visible movement.
  const harness = await open({ columns: 120, rows: 12 })
  await selectCard(harness, 'bundle:@vendor/foo')
  const listRow = rowOf(harness, 'Search: /')
  // Walk the List to its END with Down until the view stops changing.
  let previous = harness.view()
  for (let step = 0; step < 60; step += 1) {
    harness.vt.sendInput('\x1b[F') // End: the last painted card
    await harness.settle()
    if (harness.view() === previous) break
    previous = harness.view()
  }
  const before = harness.panel.gestureRevision()
  wheel(harness, listRow + 1, 30, true) // further DOWN at the end of the window
  await harness.settle()
  assert.equal(harness.panel.gestureRevision(), before, 'a wheel past the end of the List does not bump')

  // A rail press held across that immaterial wheel must still be admitted.
  const aboutRow = railRow(harness, 'About')
  press(harness, aboutRow, 3)
  wheel(harness, listRow + 1, 30, true)
  await harness.settle()
  release(harness, aboutRow, 3)
  await harness.settle()
  assert.match(harness.view(), /^> About\b/mu, 'the legal rail press survives a wheel past the List end')
  harness.app.dispose()
})

test('T09 a catch-up repaint of state that was already live keeps a held rail press valid', async () => {
  // RFL-011 follow-up: the identity must be SEMANTIC. A repaint that only catches
  // up with a change made BEFORE the press must not invalidate it, or the user's
  // legitimate rail click is lost for no visible reason.
  const harness = await open({ columns: 120, rows: 24 })
  await selectCard(harness, 'bundle:@vendor/foo')
  // Change the page's own state (filter) and DO NOT let the frame catch up.
  harness.vt.sendInput('\t')
  const identityBeforePress = harness.panel.liveIdentity()
  const aboutRow = railRow(harness, 'About')
  press(harness, aboutRow, 3)
  // The pending repaint now catches up with state that was ALREADY live at press.
  await harness.settle()
  assert.equal(harness.panel.liveIdentity(), identityBeforePress,
    'the catch-up repaint of pre-press state leaves the semantic identity unchanged')
  release(harness, aboutRow, 3)
  await harness.settle()
  assert.match(harness.view(), /^> About\b/mu, 'the legal rail press survives the catch-up repaint')
  harness.app.dispose()
})

test('T09 the Detail wheel reaches the real bottom produced by the painter', async () => {
  // RFL-013: the wheel bound must come from the SAME painter the frame uses, or
  // the last facts/actions can never be scrolled into view. Drive the page's own
  // pointer entry directly so the assertion is about the bound, not about which
  // column an SGR cell happens to map to.
  const harness = await open({ columns: 120, rows: 24 })
  await openDetails(harness)
  const layout = harness.panel.contentLayout()
  assert.equal(layout.dual, true, 'the wide Details view keeps the pair')
  const wheelDown: TuiMouseEvent = {
    type: 'wheel',
    button: 'none',
    x: layout.leftWidth + 4,
    y: 3,
    screenX: layout.leftWidth + 4,
    screenY: 3,
    width: layout.rightWidth,
    height: 20,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: 3,
  }
  // Scroll far past the end.
  for (let step = 0; step < 40; step += 1) harness.panel.handleMouse(wheelDown)
  await harness.settle()
  // The bound is where the offset stops moving: wheel until the offset is
  // unchanged across a settled frame, then assert one MORE wheel is a no-op.
  let previousIdentity = harness.panel.liveIdentity()
  for (let step = 0; step < 10; step += 1) {
    harness.panel.handleMouse(wheelDown)
    await harness.settle()
    const current = harness.panel.liveIdentity()
    if (current === previousIdentity) break
    previousIdentity = current
  }
  const atEnd = harness.panel.liveIdentity()
  harness.panel.handleMouse(wheelDown)
  await harness.settle()
  assert.equal(harness.panel.liveIdentity(), atEnd, 'a wheel past the real bottom does not move or bump')
  // And the real bottom includes the LAST painter line (the final action row).
  const rows = frameRows(harness)
  const detailColumn = rows.map(line => line.slice(24 + layout.leftWidth + 2))
  assert.ok(detailColumn.some(line => /Remove…/u.test(line)),
    `the final Detail action is reachable:\n${detailColumn.join('\n')}`)
  harness.app.dispose()
})

test('T09 a change-and-revert under a held rail press still refuses the old release', async () => {
  // RFL-011 follow-up: comparing the semantic VALUE at press and release misses a
  // change that reverts (Down then Up restores the same selection). The monotonic
  // semantic generation must catch it.
  const harness = await open({ columns: 120, rows: 24 })
  await selectCard(harness, 'bundle:@vendor/foo')
  const aboutRow = railRow(harness, 'About')
  const identityBefore = harness.panel.liveIdentity()
  const generationBefore = harness.panel.semanticGeneration()
  press(harness, aboutRow, 3)
  harness.vt.sendInput('\x1b[B') // Down: select another card
  await harness.settle()
  harness.vt.sendInput('\x1b[A') // Up: restore the previous selection
  await harness.settle()
  assert.equal(harness.panel.selectedCardValue(), 'bundle:@vendor/foo', 'the selection really reverted')
  assert.ok(harness.panel.semanticGeneration() > generationBefore,
    'the semantic generation advanced even though the value snapshot returned to its original state')
  assert.notEqual(harness.panel.liveIdentity(), identityBefore, 'the identity must not look unchanged after a revert')
  release(harness, aboutRow, 3)
  await harness.settle()
  assert.match(harness.view(), /Settings · Plugins/u, 'the stale rail release never switches category')
  assert.equal(harness.panel.currentView(), 'list', 'the plugin page survives')
  click(harness, railRow(harness, 'Models'), 3)
  await harness.settle()
  assert.match(harness.view(), /^> Models\b/mu, 'the fresh rail click still switches category')
  harness.app.dispose()
})

test('T09 a Confirmation selection key at either end never bumps', async () => {
  // RFL-012: Up on the first choice (or Down on the last) must not bump, or a
  // held pointer action on the confirmation is revoked with no visible change.
  const harness = await open({ columns: 120, rows: 24 })
  // `openRemoveConfirm` leaves the cursor on the FIRST choice (Remove), so Up is
  // the no-op direction there...
  await openRemoveConfirm(harness)
  const before = harness.panel.semanticGeneration()
  harness.vt.sendInput('\x1b[A')
  await harness.settle()
  assert.equal(harness.panel.semanticGeneration(), before, 'Up at the first choice does not bump')
  // ... and Down really moves to Cancel (a real change), after which Down/Tab at
  // the LAST choice are the no-ops.
  harness.vt.sendInput('\x1b[B')
  await harness.settle()
  const afterMove = harness.panel.semanticGeneration()
  assert.ok(afterMove > before, 'moving to the last choice is a real change')
  harness.vt.sendInput('\x1b[B')
  await harness.settle()
  harness.vt.sendInput('\t')
  await harness.settle()
  assert.equal(harness.panel.semanticGeneration(), afterMove, 'Down/Tab at the last choice do not bump')
  assert.equal(harness.panel.currentView(), 'confirm', 'the confirmation is still open')
  harness.app.dispose()
})

test('T09 a background install phase round-trip under a held rail press refuses the release', async () => {
  // RFL-011 follow-up: an ASYNC Controller transition that RETURNS to the same
  // phase value must still fence the gesture. No local key was pressed, so the
  // Controller's monotonic transition count is the only term that can see it.
  const harness = await open({ columns: 120, rows: 24 })
  // The OFFICIAL catalog card is the one whose install really dispatches (a
  // manual `i` editor has no requestId, so Host events would be ignored).
  harness.vt.sendInput('\x1b[F')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  for (let attempt = 0; attempt < 4 && harness.installCalls.length === 0; attempt += 1) {
    harness.vt.sendInput('\r')
    await harness.settle()
  }
  assert.equal(harness.installCalls.length, 1, 'the official install was really dispatched')
  const requestId = harness.controller.installView()!.requestId
  assert.ok(requestId !== undefined, 'the dispatched attempt has a real request id')
  // Esc hides the running install and returns to the List, which may yield.
  harness.vt.sendInput('\x1b')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'list')
  assert.equal(harness.panel.canYieldFocusToNavigation(), true, 'the background install lets the List yield')

  // Round-trip between two REAL Host phases and back: `installing -> applying ->
  // installing` leaves the phase VALUE exactly where it started.
  harness.emit({ kind: 'phase', phase: { requestId, phase: 'installing' } })
  await harness.settle()
  const settledPhase = harness.controller.installView()?.phase
  assert.equal(settledPhase, 'installing', 'the attempt settled on installing')
  const aboutRow = railRow(harness, 'About')
  press(harness, aboutRow, 3)
  const identityAtPress = harness.panel.liveIdentity()
  const transitionsAtPress = harness.controller.semanticTransitionsCount()
  harness.emit({ kind: 'phase', phase: { requestId, phase: 'applying' } })
  await harness.settle()
  harness.emit({ kind: 'phase', phase: { requestId, phase: 'installing' } })
  await harness.settle()
  assert.equal(harness.controller.installView()?.phase, settledPhase,
    'the phase really returned to the value it had at press time')
  assert.ok(harness.controller.semanticTransitionsCount() > transitionsAtPress,
    'the Controller transition count advanced across the round trip')
  assert.notEqual(harness.panel.liveIdentity(), identityAtPress,
    'the identity changed even though every compared VALUE is back to its press-time state')
  release(harness, aboutRow, 3)
  await harness.settle()
  assert.match(harness.view(), /Settings · Plugins/u, 'the stale rail release never switches category')
  assert.equal(harness.panel.currentView(), 'list', 'the plugin page survives')
  harness.app.dispose()
})

test("T09 editing the install spec revokes the page's own held Inspect action", async () => {
  // RFL-014/RFL-015: the editor field values decide what Inspect dispatches, so an
  // edit under a held press must make the PAGE's own release gate refuse it. The
  // witness really presses Inspect, edits, then releases, and asserts nothing was
  // dispatched.
  const harness = await open({ columns: 120, rows: 24 })
  // Open the manual editor through its own entry and type BEFORE any Inspect.
  for (let step = 0; step < 30 && harness.panel.selectedCardValue() === undefined; step += 1) {
    harness.vt.sendInput('\x1b[B')
    await harness.settle()
  }
  harness.vt.sendInput('i')
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'install', 'i opens the install editor')
  assert.equal(harness.controller.installView()?.phase, 'editing', 'the editor is in its editing phase')
  for (const character of 'pkg') harness.vt.sendInput(character)
  await harness.settle()

  // Hold a press on the painted Inspect action, edit the spec, then release.
  const inspectRow = rowOf(harness, 'Inspect')
  const generationBefore = harness.panel.semanticGeneration()
  press(harness, inspectRow, 5)
  harness.vt.sendInput('x')
  await harness.settle()
  assert.ok(harness.panel.semanticGeneration() > generationBefore,
    'a real edit advances the page semantic generation')
  release(harness, inspectRow, 5)
  await harness.settle()
  assert.equal(harness.controller.installView()?.phase, 'editing',
    'the stale Inspect release never dispatched with the newer spec')

  // Positive control: the SAME painted action really can be activated on the
  // settled frame. The keyboard is used because a same-cell click inside the
  // fork's multi-click window becomes a word selection, not a click.
  harness.vt.sendInput('\r')
  await harness.settle()
  assert.notEqual(harness.controller.installView()?.phase, 'editing',
    'a fresh activation of the same action really inspects')
  harness.app.dispose()
})

test('T09 an immaterial install wheel never advances the semantic generation', async () => {
  // RFL-012: the install wheel bump must depend on the window really moving.
  const harness = await open({ columns: 120, rows: 24 })
  // The editor's own body row (Spec/Registry form) is the wheel target; an UP
  // wheel at the top of an already-at-top editor cannot move anything.
  harness.vt.sendInput('i')
  await harness.settle()
  assert.equal(harness.controller.installView()?.phase, 'editing', 'the editor is in its editing phase')
  const before = harness.panel.semanticGeneration()
  const bodyRow = rowOf(harness, 'Spec')
  wheel(harness, bodyRow, 5, false)
  await harness.settle()
  assert.equal(harness.panel.semanticGeneration(), before, 'an immaterial install wheel does not advance the generation')
  harness.app.dispose()
})

test('T09 a blank Host log chunk never advances the Controller generation', async () => {
  // RFL-012 follow-up: an empty/blank log chunk is not a presentation change, so
  // it must not advance the monotonic transition count and revoke a held gesture.
  const harness = await open({ columns: 120, rows: 24 })
  harness.vt.sendInput('\x1b[F')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  for (let attempt = 0; attempt < 4 && harness.installCalls.length === 0; attempt += 1) {
    harness.vt.sendInput('\r')
    await harness.settle()
  }
  assert.equal(harness.installCalls.length, 1, 'the official install was dispatched')
  const requestId = harness.controller.installView()!.requestId
  assert.ok(requestId !== undefined, 'the attempt has a real request id')

  const before = harness.controller.semanticTransitionsCount()
  harness.emit({ kind: 'log', log: { requestId, jobId: 'j', stream: 'stdout', text: '' } })
  await harness.settle()
  harness.emit({ kind: 'log', log: { requestId, jobId: 'j', stream: 'stdout', text: '\n\n' } })
  await harness.settle()
  assert.equal(harness.controller.semanticTransitionsCount(), before,
    'blank log chunks never advance the transition count')

  // A REAL chunk does advance it (positive control).
  harness.emit({ kind: 'log', log: { requestId, jobId: 'j', stream: 'stdout', text: 'real output\n' } })
  await harness.settle()
  assert.ok(harness.controller.semanticTransitionsCount() > before,
    'a real log chunk still advances it')
  harness.app.dispose()
})

test('T09 a phase round-trip under a held Install action refuses the page release', async () => {
  // RFL-016: the ROOT fence compares the Controller's monotonic transitions, but
  // the PAGE's own press/release gate compared only the painted frame. A phase
  // round trip that returns to its press-time value and does not repaint must
  // still refuse the page's own held action.
  //
  // The witness uses the `Hide install view` action: it has an immediate, local,
  // observable effect (the page returns to its List), so "nothing happened" really
  // means the gate refused. `Stop` would dispatch a Host cancel whose fake result
  // is indistinguishable from a refused press.
  const harness = await open({ columns: 120, rows: 24 })
  harness.vt.sendInput('\x1b[F')
  await harness.settle()
  harness.vt.sendInput('\r')
  await harness.settle()
  for (let attempt = 0; attempt < 4 && harness.installCalls.length === 0; attempt += 1) {
    harness.vt.sendInput('\r')
    await harness.settle()
  }
  assert.equal(harness.installCalls.length, 1, 'the official install was dispatched')
  const requestId = harness.controller.installView()!.requestId
  assert.ok(requestId !== undefined)
  harness.emit({ kind: 'phase', phase: { requestId, phase: 'installing' } })
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'install', 'the install view is showing')
  const hideRow = rowOf(harness, 'Hide install view')
  press(harness, hideRow, 5)
  const transitionsAtPress = harness.controller.semanticTransitionsCount()
  // A phase round trip that RETURNS to `installing`, with no paint in between.
  harness.emit({ kind: 'phase', phase: { requestId, phase: 'applying' } })
  harness.emit({ kind: 'phase', phase: { requestId, phase: 'installing' } })
  assert.equal(harness.controller.installView()?.phase, 'installing', 'the phase returned to its press-time value')
  assert.ok(harness.controller.semanticTransitionsCount() > transitionsAtPress,
    'the Controller transition count advanced across the round trip')
  release(harness, hideRow, 5)
  await harness.settle()
  assert.equal(harness.panel.currentView(), 'install',
    'the stale page release never ran the Hide action (the page is still on the install view)')

  // Positive control: the SAME painted action really runs on the settled frame.
  // The keyboard is used because a same-cell click inside the fork's multi-click
  // window becomes a word selection instead of a click.
  // Walk the CURRENT install action list and activate the first enabled action;
  // any real dispatch leaves the Install view or changes its phase, which is the
  // property the refused release did not have.
  const phaseBefore = harness.controller.installView()?.phase
  for (let step = 0; step < 8 && harness.panel.currentView() === 'install'; step += 1) {
    const before = harness.panel.currentView()
    harness.vt.sendInput('\r')
    await harness.settle()
    if (harness.panel.currentView() !== before) break
    harness.vt.sendInput('\x1b[B')
    await harness.settle()
  }
  assert.ok(
    harness.panel.currentView() !== 'install' || harness.controller.installView()?.phase !== phaseBefore,
    `a fresh activation really dispatched:\n${harness.view()}`,
  )
  harness.app.dispose()
})

test('T09 a page action is refused until the changed grant really paints', async () => {
  // RFL-017 / §4.2: `setViewport` revokes the previous frame's grants, so until
  // the frame that installs the NEW grant paints, only the real Esc may act.
  //
  // The grant really changes in the MEDIUM band: with the rail focused the page is
  // granted `Categories | List` (width 76, allowDual false); the focus transfer
  // gives it `List | Details` (width 100, allowDual true). At >=120 the rail stays
  // put and the grant is identical, so there is no such window there.
  const harness = await open({ columns: 100, rows: 24 })
  await selectCard(harness, 'bundle:@vendor/foo')
  await yieldToRail(harness)
  const readsBefore = harness.snapshotCalls()
  // Two keys in ONE burst — the ordering a single stdin chunk produces, because
  // the render is deferred to nextTick while the sequences are emitted in a
  // synchronous loop.
  harness.vt.sendInput('\t')
  harness.vt.sendInput('r')
  await harness.settle()
  assert.equal(harness.snapshotCalls(), readsBefore,
    'a body action forwarded before the changed grant paints never reads the Host')

  // Positive control: once that frame has painted, the same key really refreshes.
  const afterPaint = harness.snapshotCalls()
  harness.vt.sendInput('r')
  await harness.settle()
  assert.ok(harness.snapshotCalls() > afterPaint,
    'the same key really refreshes after the new grant paints')
  harness.app.dispose()
})

test('T09 rail keys are refused until the yield paints the new projection', async () => {
  // RFL-017: yielding out of the plugin content changes the direct page's
  // projection at 76..119 columns. Until the frame for it paints, a rail key must
  // not move or activate a category the user cannot see yet.
  const harness = await open({ columns: 100, rows: 24 })
  await selectCard(harness, 'bundle:@vendor/foo')
  await contentFocus(harness)
  const rootPanel = (harness.app as never as { settingsWorkspace?: { panel: Record<string, unknown> } })
    .settingsWorkspace!.panel
  const categoryBefore = rootPanel['categoryId']
  // One burst: the page Esc yields to the rail (installing the new grant), then a
  // rail key arrives before that projection paints.
  harness.vt.sendInput('\x1b')
  harness.vt.sendInput('\x1b[B') // Down on the rail
  assert.equal(harness.panel.grantAwaitingPaint(), true, 'the yield installed the new grant and awaits its paint')
  assert.equal(rootPanel['categoryId'], categoryBefore,
    'the rail Down did not move the category before the new projection painted')
  await harness.settle()
  // Positive control: on the painted frame the same rail key really moves.
  harness.vt.sendInput('\x1b[B')
  await harness.settle()
  assert.notEqual(rootPanel['categoryId'], categoryBefore,
    'the same rail key moves the category once the projection has painted')
  harness.app.dispose()
})

test('T09 narrow rail keys and Backspace wait for the destination frame', async () => {
  // RFL-017: at narrow widths a yield leaves NO page grant to arm (`syncPluginFrame`
  // returns early because the page is not painted in that projection), yet the
  // Categories frame has not painted either — so the ROOT needs its own guard.
  const narrow = await open({ columns: 72, rows: 24 })
  const rootPanel = (narrow.app as never as { settingsWorkspace?: { panel: Record<string, unknown> } })
    .settingsWorkspace!.panel
  // `/plugins` lands with the content already focused; Esc yields to the rail,
  // then Enter takes the content again (narrow paints one region at a time).
  assert.equal(rootPanel['focus'], 'content', 'the deep link starts on the plugin content')
  narrow.vt.sendInput('\x1b')
  await narrow.settle()
  assert.equal(rootPanel['focus'], 'categories', 'Esc yielded to the rail')
  narrow.vt.sendInput('\r')
  await narrow.settle()
  assert.equal(rootPanel['focus'], 'content', 'the narrow content owns the keyboard again')
  const categoryBefore = rootPanel['categoryId']

  // One burst: Esc yields back to the rail, then a rail key arrives before the
  // Categories frame paints. No page grant exists here, so this is the root guard.
  // Plugins is the LAST category, so `Up` is the direction that can really move.
  narrow.vt.sendInput('\x1b')
  narrow.vt.sendInput('\x1b[A')
  await narrow.settle()
  assert.equal(rootPanel['categoryId'], categoryBefore,
    'the rail key did not move the category before the Categories frame painted')
  // Positive control: on the painted frame the same key really moves.
  narrow.vt.sendInput('\x1b[A')
  await narrow.settle()
  assert.notEqual(rootPanel['categoryId'], categoryBefore,
    'the same rail key moves the category once the frame has painted')
  narrow.app.dispose()

  // §4.2 admits only the REAL Esc while the frame is stale: Backspace must not act.
  const bs = await open({ columns: 100, rows: 24 })
  await selectCard(bs, 'bundle:@vendor/foo')
  await contentFocus(bs)
  const bsRoot = (bs.app as never as { settingsWorkspace?: { panel: Record<string, unknown> } })
    .settingsWorkspace!.panel
  bs.vt.sendInput('\x1b') // yield; the changed grant awaits its paint
  bs.vt.sendInput('\x7f') // Backspace in the same window
  await bs.settle()
  assert.match(bs.view(), /Settings · /u, 'the stale Backspace did not close the workspace')
  assert.equal(bsRoot['categoryId'], 'plugins', 'the stale Backspace did not change the category')
  bs.app.dispose()
})

test('T09 narrow rail -> content refuses page keys until the content frame paints', async () => {
  // RFL-017 reverse direction: at narrow widths the page stays mounted while the
  // rail has the focus, and its local grant can be IDENTICAL across the transfer,
  // so the page's own query stays false. The root must fence the keys it would
  // dispatch into the new focus until the content frame paints.
  const harness = await open({ columns: 72, rows: 24 })
  const rootPanel = (harness.app as never as { settingsWorkspace?: { panel: Record<string, unknown> } })
    .settingsWorkspace!.panel
  assert.equal(rootPanel['focus'], 'content', 'the deep link starts on the content')
  harness.vt.sendInput('\x1b') // yield to the rail
  await harness.settle()
  assert.equal(rootPanel['focus'], 'categories')

  // ONE burst: Enter takes the content, then a body key arrives before that frame.
  const readsBefore = harness.snapshotCalls()
  harness.vt.sendInput('\r')
  harness.vt.sendInput('r')
  await harness.settle()
  assert.equal(harness.snapshotCalls(), readsBefore,
    'the body key forwarded in the rail -> content window never read the Host')

  // Positive control: on the painted content frame the same key really refreshes.
  const afterPaint = harness.snapshotCalls()
  harness.vt.sendInput('r')
  await harness.settle()
  assert.ok(harness.snapshotCalls() > afterPaint,
    'the same key really refreshes once the content frame has painted')
  harness.app.dispose()
})

test('T09 Shift+Tab does not yield while a changed grant awaits its paint', async () => {
  // §4.2 covers the key the ROOT intercepts itself, not only the keys it forwards:
  // the root's Shift+Tab handler runs before `syncPluginFrame()` and would
  // otherwise bypass the page's prepaint gate.
  const harness = await open({ columns: 100, rows: 24 })
  await selectCard(harness, 'bundle:@vendor/foo')
  await yieldToRail(harness)
  const rootPanel = (harness.app as never as { settingsWorkspace?: { panel: Record<string, unknown> } })
    .settingsWorkspace!.panel
  // ONE burst: focus transfer -> body key -> Shift+Tab, all before the frame that
  // shows the new focus. The root's projection guard refuses the body key first
  // (the page's grant is never even synchronized), so the observable property is
  // that no Host read happened and the focus did not yield.
  const readsBeforeBurst = harness.snapshotCalls()
  harness.vt.sendInput('\t')
  harness.vt.sendInput('r')
  harness.vt.sendInput('\x1b[Z')
  await harness.settle()
  assert.equal(harness.snapshotCalls(), readsBeforeBurst,
    'the body key in the prepaint window never read the Host')
  assert.equal(rootPanel['focus'], 'content',
    'Shift+Tab did not yield to the rail while the transfer frame was pending')
  assert.equal(rootPanel['focus'], 'content',
    'Shift+Tab did not yield to the rail while the grant awaited its paint')
  await harness.settle()
  assert.equal(rootPanel['focus'], 'content', 'the focus stays in the content after the paint too')
  // The legal direction still works once the frame is current.
  harness.vt.sendInput('\x1b[Z')
  await harness.settle()
  assert.equal(rootPanel['focus'], 'categories', 'Shift+Tab still yields on a painted frame')
  harness.app.dispose()
})

// ── T10: notices, palette and CJK identities ────────────────────────────────

test('T15 a pending Host mutation settling after the Settings parent close never renders the disposed page', async () => {
  // §8.3 T15: the REAL Settings lease is closed while the official install is
  // still in flight; the late settlement must not repaint the disposed page.
  let settleInstall!: (fact: PluginChangeFact) => void
  const harness = await open({
    columns: 120,
    rows: 24,
    installImpl: () => new Promise<PluginChangeFact>(resolve => { settleInstall = resolve }),
    waitImpl: async () => null,
  })
  const page = harness.panel
  await openInstall(harness)
  // Drive the explicit Inspect -> Install path until the Host dispatch is in flight.
  for (let attempt = 0; attempt < 4 && harness.installCalls.length === 0; attempt += 1) {
    harness.vt.sendInput('\r')
    await harness.settle()
  }
  assert.equal(harness.installCalls.length, 1, 'the official install was dispatched exactly once')
  assert.equal(harness.controller.installView()?.phase, 'starting', 'the Host operation is still in flight')

  // Recorder on the PRODUCTION page instance: after the parent close it must
  // never be asked to paint again.
  let renders = 0
  const originalRender = page.render.bind(page)
  page.render = (width: number): string[] => { renders += 1; return originalRender(width) }

  // The REAL Settings lease closes (the same external teardown a blocking owner
  // or a screen replacement performs).
  harness.settings.close()
  await harness.settle()
  assert.doesNotMatch(harness.view(), /Settings · /u, 'the Settings parent really closed')
  const rendersAtClose = renders

  // The late Host settlement arrives after the close.
  settleInstall({ changed: true, application: 'applied', stage: 'install', target: 'pkg', version: '1.0.0' })
  await harness.settle()
  assert.equal(renders, rendersAtClose, 'the late settlement never repaints the disposed page')
  assert.doesNotMatch(harness.view(), /Settings · /u, 'the closed workspace stays closed')
  assert.equal(harness.installCalls.length, 1, 'the settlement never dispatches a second install')
  harness.app.dispose()
})

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
