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
  harness.app.dispose()
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
  focusCase.app.dispose()

  // Press -> the page's own filter edit -> release must not open Details.
  const filterCase = await open({ columns: 120, rows: 24 })
  await selectCard(filterCase, 'bundle:@vendor/foo')
  const filterRow = rowOf(filterCase, '> @vendor/foo')
  press(filterCase, filterRow, 30)
  filterCase.vt.sendInput('\t')
  await filterCase.settle()
  release(filterCase, filterRow, 30)
  await filterCase.settle()
  assert.equal(filterCase.panel.currentView(), 'list', 'a filter edit between press and release refuses the old release')
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
  categoryCase.app.dispose()

  // Press -> external parent close -> release must not write the Host.
  const disposed = await open({ columns: 80, rows: 10 })
  await openRemoveConfirm(disposed)
  const disposeRow = rowOf(disposed, '> Remove')
  press(disposed, disposeRow, 5)
  disposed.settings.close()
  release(disposed, disposeRow, 5)
  assert.deepEqual(disposed.removeBundle, [], 'an externally closed workspace never dispatches the old release')
  disposed.app.dispose()
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
