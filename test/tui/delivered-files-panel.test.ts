/**
 * Delivered files browser panel (Delivered files PR1 / M5): the ONE managed
 * overlay's page/seat state machine, keyboard ladder, pointer hit-testing from
 * the last painted frame, responsive layout, bounded scrolling and the raw-path
 * Copy feedback.
 *
 * The panel is exercised DIRECTLY (no app mount): it owns presentation-local
 * state only, and every byte it paints is derived from the captured snapshot.
 * @module @xmoon76/dsh-pi-tui/tui/delivered-files-panel.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import type { DeliveredFilesSnapshot } from '../../src/domain/deliverables/catalog.ts'
import {
  DeliveredFilesPanel,
  type DeliveredFilesPreviewState,
} from '../../src/tui/deliverables/delivered-files-panel.ts'
import {
  DELIVERED_FILE_PAGE_LINES,
  DeliveredFileReadError,
  type DeliveredFilePage,
  type DeliveredFileReadFailureCode,
  type DeliveredFileStat,
} from '../../src/runtime/deliverables-port.ts'
import { deliveredFilesOverlayGeometry } from '../../src/tui/deliverables/overlay-size.ts'

/** Friendly key names → the real terminal bytes the component matches. */
const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  esc: '\x1b',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  tab: '\t',
  C: 'C',
  T: 'T',
} as const

interface Harness {
  readonly panel: DeliveredFilesPanel
  /** The painted rows with terminal sequences stripped (text assertions). */
  readonly rows: () => readonly string[]
  readonly renders: () => number
  readonly closes: () => number
  readonly copied: () => readonly string[]
  readonly settleCopy: (ok: boolean) => void
  readonly setSize: (columns: number, rows: number) => void
  readonly paint: () => readonly string[]
  readonly type: (data: string) => void
}

/** A real panel over a real snapshot; copy resolves through `settleCopy`. */
function harness(
  snapshot: DeliveredFilesSnapshot,
  options: { initial?: { turn?: number; path?: string; page?: 'files' | 'details' }; copyResult?: boolean } = {},
): Harness {
  let renderCount = 0
  let closeCount = 0
  const copied: string[] = []
  let pendingSettle: ((ok: boolean) => void) | undefined
  let width = 100
  let height = 30
  const panel = new DeliveredFilesPanel({
    snapshot,
    ...(options.initial === undefined ? {} : { initial: options.initial }),
    // These fixtures exercise the POINTER geometry, so they opt in explicitly
    // (the production regular surface paints no verb).
    pointerActions: true,
    requestRender: () => { renderCount += 1 },
    close: () => { closeCount += 1 },
    copyPath: (path, settle) => {
      copied.push(path)
      if (options.copyResult !== undefined) {
        settle(options.copyResult)
        return
      }
      pendingSettle = settle
    },
  })
  const paint = (): readonly string[] => {
    // The production chain: the SAME geometry authority resolves the overlay
    // width/height cap, and the frame grants the panel its content rows
    // (maxHeight - 2 borders, width - 4 borders/padding).
    const geometry = deliveredFilesOverlayGeometry(width, height)
    panel.setMaxRows(Math.max(1, geometry.maxHeight - 2))
    return panel.render(Math.max(1, geometry.width - 4))
  }
  return {
    panel,
    rows: () => paint().map(row => stripTerminalSequences(row)),
    renders: () => renderCount,
    closes: () => closeCount,
    copied: () => copied,
    settleCopy: (ok) => {
      const settle = pendingSettle
      pendingSettle = undefined
      settle?.(ok)
    },
    setSize: (columns, nextRows) => {
      width = columns
      height = nextRows
    },
    paint,
    type: (data) => panel.handleInput(KEY[data as keyof typeof KEY] ?? data),
  }
}

type FileSpec = string | { path: string; description?: string }
type FileList = FileSpec | readonly FileSpec[]

function files(input: FileList): { path: string; description?: string }[] {
  const list = Array.isArray(input) ? input : [input as FileSpec]
  return list.map(entry => (typeof entry === 'string' ? { path: entry } : entry))
}

function snapshotOf(turns: readonly { turn: number; files: FileList }[]): DeliveredFilesSnapshot {
  return {
    subjectKind: 'main',
    sessionId: 'session-1',
    sourceIdentity: {},
    turns: turns.map(entry => ({ turn: entry.turn, files: files(entry.files) })),
  }
}

const ONE_TURN = snapshotOf([{ turn: 24, files: ['/ws/docs/report.md', '/ws/output/report-final.md', '/ws/results/report-index.json'] }])

function assertNoOverflow(rows: readonly string[], width: number): void {
  for (const row of rows) {
    assert.ok(visibleWidth(row) <= width, `row overflows ${width}: ${JSON.stringify(row)}`)
  }
}

/** Send one COMPLETE left gesture at a panel-relative cell (press + synthesized
 *  click). The fork only synthesizes a click after a press on the same cell, so
 *  a direct `click`-only fixture would bypass the panel's press-time fence. */
function clickAt(
  panel: DeliveredFilesPanel,
  cell: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
) {
  const base = {
    button: 'left' as const,
    x: cell.x,
    y: cell.y,
    screenX: cell.x,
    screenY: cell.y,
    width: cell.width,
    height: cell.height,
    shift: false,
    alt: false,
    ctrl: false,
  }
  panel.handleMouse({ ...base, type: 'press' })
  return panel.handleMouse({ ...base, type: 'click' })
}

/** The synthesized click half of an ALREADY-HELD press. */
function clickOnly(
  panel: DeliveredFilesPanel,
  cell: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
) {
  return panel.handleMouse({
    type: 'click',
    button: 'left',
    x: cell.x,
    y: cell.y,
    screenX: cell.x,
    screenY: cell.y,
    width: cell.width,
    height: cell.height,
    shift: false,
    alt: false,
    ctrl: false,
  })
}

/** The frame's granted CONTENT rows (outer cap minus its two borders). */
function contentRows(columns: number, rows: number): number {
  return Math.max(1, deliveredFilesOverlayGeometry(columns, rows).maxHeight - 2)
}

/** The frame's granted CONTENT width (outer width minus borders/padding). */
function contentWidth(columns: number, rows: number): number {
  return Math.max(1, deliveredFilesOverlayGeometry(columns, rows).width - 4)
}

test('the Files page opens on the newest Turn with the first file selected', () => {
  const h = harness(snapshotOf([
    { turn: 24, files: '/ws/docs/report.md' },
    { turn: 22, files: ['/ws/old.md'] },
  ]))
  const rows = h.rows()
  assert.match(rows[0]!, /Delivered files · Turn 24/)
  assert.match(rows[0]!, /1 file/)
  assert.ok(rows.some(row => row.startsWith('> report.md')), `the first file is selected:\n${rows.join('\n')}`)
  assert.deepEqual(h.panel.selection(), { turn: 24, path: '/ws/docs/report.md' })
})

test('Enter opens the selected file Details and Esc returns to the Files page', () => {
  const h = harness(ONE_TURN)
  h.type('enter')
  assert.equal(h.panel.currentPage(), 'details')
  const rows = h.rows()
  assert.match(rows[0]!, /report\.md · Details/)
  assert.ok(rows.some(row => row.includes('Host: ') && row.includes('/ws/docs/report.md')), rows.join('\n'))
  assert.ok(rows.at(-1)!.includes('[Copy path]'), `the action bar paints the real Copy button: ${rows.at(-1)}`)
  assert.ok(rows.at(-1)!.includes('[Back]'))
  h.type('esc')
  assert.equal(h.panel.currentPage(), 'files')
})

test('C copies the RAW declared path and reports the settled clipboard outcome', () => {
  const h = harness(ONE_TURN)
  h.type('enter')
  h.type('C')
  assert.deepEqual(h.copied(), ['/ws/docs/report.md'])
  assert.ok(!h.rows().at(-1)!.includes('Path copied'), 'no success before the clipboard settles')
  h.settleCopy(true)
  assert.ok(h.rows().at(-1)!.includes('Path copied'))
  // A failed write is reported honestly and never closes the page.
  h.type('C')
  h.settleCopy(false)
  assert.ok(h.rows().at(-1)!.includes('Could not copy path'))
  assert.equal(h.panel.currentPage(), 'details')
})

test('a stale copy settlement never paints over a different selection', () => {
  const h = harness(ONE_TURN)
  h.type('enter')
  h.type('C')
  h.type('esc')
  // Move to another file, then the FIRST copy settles.
  h.type('down')
  h.type('enter')
  h.settleCopy(true)
  assert.ok(!h.rows().at(-1)!.includes('Path copied'), 'the settlement belongs to the previous file/page')
})

test('the Esc ladder: filter clears the query, Details/Turns return to Files, Files closes', () => {
  const h = harness(ONE_TURN)
  h.type('T')
  assert.equal(h.panel.currentPage(), 'turns')
  h.type('esc')
  assert.equal(h.panel.currentPage(), 'files')
  assert.equal(h.closes(), 0)

  h.type('enter')
  assert.equal(h.panel.currentPage(), 'details')
  h.type('esc')
  assert.equal(h.panel.currentPage(), 'files')
  assert.equal(h.closes(), 0)

  h.type('/')
  h.type('rep')
  h.type('esc')
  assert.equal(h.closes(), 0, 'Esc in the filter clears the query and stays in the overlay')
  const rows = h.rows()
  assert.ok(rows.some(row => row.startsWith('> report.md')), `the cleared filter shows the whole list again:\n${rows.join('\n')}`)

  h.type('esc')
  assert.equal(h.closes(), 1, 'Esc on the Files list closes the ONE overlay')
})

test('the filter matches on typing, Enter keeps it, and an empty result has no selection', () => {
  const h = harness(ONE_TURN)
  h.type('/')
  for (const char of 'index') h.type(char)
  let rows = h.rows()
  assert.ok(rows.some(row => row.includes('Filter: ')), `the filter row is shown while it owns the keyboard:\n${rows.join('\n')}`)
  assert.ok(rows.some(row => row.startsWith('> report-index.json')), `the filtered first match is selected:\n${rows.join('\n')}`)
  h.type('enter')
  rows = h.rows()
  assert.ok(rows.some(row => row.includes('report-index.json')), 'Enter confirms the filtered list back on the Files page')

  h.type('/')
  for (const char of 'zzz') h.type('z')
  h.type('enter')
  rows = h.rows()
  assert.ok(!rows.some(row => row.includes('> ')), `an empty result has no selected row:\n${rows.join('\n')}`)
  const before = h.closes()
  h.type('enter')
  assert.equal(h.panel.currentPage(), 'files', 'Enter without a selection does not leave the page')
  h.type('esc')
  assert.equal(h.closes(), before + 1)
})

test('the Turns page lists the delivered Turns in snapshot order and Enter switches the list', () => {
  const h = harness(snapshotOf([
    { turn: 24, files: '/ws/c.md' },
    { turn: 18, files: ['/ws/d.md'] },
    { turn: 10, files: ['/ws/a.md', '/ws/b.md'] },
  ]))
  h.type('T')
  const rows = h.rows()
  assert.match(rows[0]!, /Delivered files · 3 Turns/)
  const listed = rows.filter(row => /^[> ] Turn \d+/.test(row))
  assert.deepEqual(listed.map(row => row.trim()), [
    '> Turn 24 · 1 file',
    'Turn 18 · 1 file',
    'Turn 10 · 2 files',
  ])
  h.type('down')
  h.type('enter')
  assert.equal(h.panel.currentPage(), 'files')
  assert.deepEqual(h.panel.selection(), { turn: 18, path: '/ws/d.md' })
  assert.match(h.rows()[0]!, /Turn 18/)
})

test('a Turns cursor move is not a commitment: Esc keeps the previous Turn', () => {
  const h = harness(snapshotOf([
    { turn: 24, files: ['/ws/b.md'] },
    { turn: 10, files: ['/ws/a.md'] },
  ]))
  h.type('T')
  h.type('down')
  h.type('esc')
  assert.match(h.rows()[0]!, /Turn 24/)
})

test('the same raw path in two Turns stays a DIFFERENT selection', () => {
  const snapshot = snapshotOf([
    { turn: 9, files: [{ path: '/ws/report.md', description: 'ninth turn' }] },
    { turn: 3, files: [{ path: '/ws/report.md', description: 'third turn' }] },
  ])
  const h = harness(snapshot)
  assert.deepEqual(h.panel.selection(), { turn: 9, path: '/ws/report.md' })
  h.type('enter')
  assert.ok(h.rows().some(row => row.includes('ninth turn')))
  h.type('esc')
  h.type('T')
  h.type('down')
  h.type('enter')
  assert.deepEqual(h.panel.selection(), { turn: 3, path: '/ws/report.md' })
  h.type('enter')
  assert.ok(h.rows().some(row => row.includes('third turn')), 'the Details metadata follows the Turn')
})

test('duplicate basenames across directories are disambiguated on the Files page', () => {
  const h = harness(snapshotOf([{
    turn: 1,
    files: ['/ws/docs/report.md', '/ws/output/report.md', '/ws/unique.md'],
  }]))
  const rows = h.rows()
  const text = rows.join('\n')
  assert.ok(text.includes('docs/report.md'), text)
  assert.ok(text.includes('output/report.md'), text)
  assert.ok(text.includes('unique.md'), text)
})

test('200 files keep only the viewport rows and the last item is reachable', () => {
  const many = Array.from({ length: 200 }, (_, index) => `/ws/file-${String(index + 1).padStart(3, '0')}.md`)
  const h = harness(snapshotOf([{ turn: 5, files: many }]))
  h.setSize(100, 30)
  const first = h.rows()
  const granted = contentRows(100, 30)
  assert.equal(first.length, granted, 'the panel fills its granted rows')
  assert.ok(!first.join('\n').includes('file-200.md'), 'older rows are not painted')
  for (let press = 0; press < 40; press += 1) h.type('pageDown')
  const last = h.rows()
  assert.ok(last.join('\n').includes('file-200.md'), 'PageDown reaches the last file')
  assert.equal(h.rows().length, granted)
})

test('40x16, 72x24, 100x30 and 140x40 stay inside their box and keep the exit visible', () => {
  const h = harness(snapshotOf([{ turn: 7, files: ['/ws/a.md', '/ws/b.md', '/ws/c.md'] }]))
  for (const [columns, rows] of [[40, 16], [64, 16], [72, 24], [100, 30], [140, 40]] as const) {
    h.setSize(columns, rows)
    const painted = h.rows()
    assert.equal(painted.length, contentRows(columns, rows), `${columns}x${rows}: the panel fills its granted rows`)
    assertNoOverflow(painted, contentWidth(columns, rows))
    assert.match(painted[0]!, /Delivered files · Turn 7/)
    assert.ok(painted.at(-1)!.includes('[Close]'), `${columns}x${rows}: the Close button stays visible`)
  }
})

test('a short screen hides the filter chrome but `/` still opens the query row', () => {
  const h = harness(ONE_TURN)
  h.setSize(72, 16)
  const short = h.rows()
  assert.ok(!short.some(row => row.includes('Filter: ')), `short screens drop the filter row:\n${short.join('\n')}`)
  h.type('/')
  h.type('r')
  const filtered = h.rows()
  assert.ok(filtered.some(row => row.includes('Filter: ')), 'the input seat paints its own query row')
  assert.ok(filtered.some(row => row.includes('Filter: r')))
})

test('a wide pane shows the declared metadata and never reads the Host', () => {
  const h = previewHarness(snapshotOf([{
    turn: 2,
    files: [{ path: '/ws/docs/report.md', description: 'Final analysis report' }],
  }]))
  h.setSize(140, 40)
  const rows = h.rows()
  const text = rows.join('\n')
  assert.ok(text.includes('/ws/docs/report.md'), text)
  assert.ok(text.includes('Final analysis report'), text)
  assert.ok(text.includes('Enter for Preview'), 'the side pane names the real next step')
  // Selecting rows on the Files page never touches the Host.
  h.type('down')
  h.rows()
  assert.equal(h.statCalls(), 0, 'the Files page issues no Host stat')
  assert.deepEqual(h.readCalls(), [], 'the Files page issues no Host read')
})

test('the frozen overlay geometry follows the percentage formula at every matrix size', () => {
  const cases: readonly [number, number, number, number][] = [
    [44, 20, 44, 15],
    [72, 24, 72, 18],
    [80, 24, 72, 18],
    [120, 40, 96, 30],
    [160, 50, 120, 37],
    [200, 50, 120, 37],
    [80, 10, 72, 8],
  ]
  for (const [columns, rows, width, maxHeight] of cases) {
    assert.deepEqual(deliveredFilesOverlayGeometry(columns, rows), { width, maxHeight },
      `${columns}x${rows}: centered percentage window`)
  }
  // Non-finite / negative input never produces an unusable frame.
  assert.deepEqual(deliveredFilesOverlayGeometry(Number.NaN, Number.POSITIVE_INFINITY), { width: 1, maxHeight: 1 })
  assert.deepEqual(deliveredFilesOverlayGeometry(-4, -1), { width: 1, maxHeight: 1 })
})

test('the action-bar buttons are real painted targets: press consumes, click runs', () => {
  const event = (h: Harness, type: 'press' | 'click', x: number, y: number) => h.panel.handleMouse({
    type, button: 'left', x, y, screenX: x, screenY: y,
    width: contentWidth(100, 30), height: contentRows(100, 30),
    shift: false, alt: false, ctrl: false,
  })
  const completeClick = (h: Harness, x: number, y: number) => {
    event(h, 'press', x, y)
    return event(h, 'click', x, y)
  }
  const clickButton = (h: Harness, label: string): void => {
    const rows = h.rows()
    const bar = rows.at(-1)!
    const column = bar.indexOf(label) + 2
    assert.ok(bar.includes(label), `fixture: the bar paints ${label}: ${bar}`)
    completeClick(h, column, rows.length - 1)
  }

  // PRESS consumes the button but never runs the action; the synthesized CLICK
  // is the one opener.
  const closed = harness(ONE_TURN)
  closed.setSize(100, 30)
  const closedRows = closed.rows()
  const closeColumn = closedRows.at(-1)!.indexOf('[Close]') + 2
  assert.equal(event(closed, 'press', closeColumn, closedRows.length - 1)?.handled, true)
  assert.equal(closed.closes(), 0, 'a press never closes the overlay')
  completeClick(closed, closeColumn, closedRows.length - 1)
  assert.equal(closed.closes(), 1, 'a complete click runs Close')

  const filter = harness(ONE_TURN)
  filter.setSize(100, 30)
  clickButton(filter, '[Filter]')
  assert.ok(filter.rows().some(row => row.includes('Filter: ')), 'Filter enters the real filter seat')
  assert.equal(filter.closes(), 0)

  const turns = harness(snapshotOf([
    { turn: 24, files: ['/ws/newest.md'] },
    { turn: 18, files: ['/ws/older.md'] },
  ]))
  turns.setSize(100, 30)
  clickButton(turns, '[Turns]')
  assert.match(turns.rows()[0]!, /Delivered files · 2 Turns/, 'Turns opens the real Turns page')
})

test('a painted Turns row opens THAT Turn on a complete click; [Back] restores the original', () => {
  const h = harness(snapshotOf([
    { turn: 24, files: ['/ws/newest.md'] },
    { turn: 18, files: ['/ws/older.md'] },
  ]))
  h.setSize(100, 30)
  h.type('T')
  let rows = h.rows()
  const olderRow = rows.findIndex(row => row.includes('Turn 18'))
  assert.ok(olderRow >= 0, rows.join('\n'))
  const click = (x: number, y: number) => clickAt(h.panel, {
    x, y, width: contentWidth(100, 30), height: contentRows(100, 30),
  })
  // A press only consumes the row.
  h.panel.handleMouse({
    type: 'press', button: 'left', x: 2, y: olderRow, screenX: 2, screenY: olderRow,
    width: contentWidth(100, 30), height: contentRows(100, 30),
    shift: false, alt: false, ctrl: false,
  })
  assert.equal(h.panel.currentPage(), 'turns', 'a press never opens a Turn')
  click(2, olderRow)
  assert.equal(h.panel.currentPage(), 'files')
  assert.deepEqual(h.panel.selection(), { turn: 18, path: '/ws/older.md' })

  // Back returns to the Turn the page was on BEFORE the visit, not the cursor.
  const back = harness(snapshotOf([
    { turn: 24, files: ['/ws/newest.md'] },
    { turn: 18, files: ['/ws/older.md'] },
  ]))
  back.setSize(100, 30)
  back.type('T')
  back.type('down')
  rows = back.rows()
  const backColumn = rows.at(-1)!.indexOf('[Back]') + 2
  assert.ok(rows.at(-1)!.includes('[Back]'))
  assert.ok(rows.some(row => row.trimStart().startsWith('> Turn 18')), 'fixture: the cursor moved')
  clickAt(back.panel, {
    x: backColumn, y: rows.length - 1, width: contentWidth(100, 30), height: contentRows(100, 30),
  })
  assert.equal(back.panel.currentPage(), 'files')
  assert.match(back.rows()[0]!, /Turn 24/, 'Back restores the original Turn')
})

test('Details [Copy path] really settles and [Back] stays a painted target', () => {
  const h = harness(ONE_TURN)
  h.setSize(100, 30)
  h.type('enter')
  let rows = h.rows()
  assert.match(rows[0]!, /report\.md · Details/)
  const click = (label: string) => {
    const bar = rows.at(-1)!
    assert.ok(bar.includes(label), `fixture: ${label} is painted: ${bar}`)
    const x = bar.indexOf(label) + 2
    clickAt(h.panel, { x, y: rows.length - 1, width: contentWidth(100, 30), height: contentRows(100, 30) })
  }
  click('[Copy path]')
  assert.deepEqual(h.copied(), ['/ws/docs/report.md'], 'the click copies the RAW path')
  assert.ok(!h.rows().at(-1)!.includes('Path copied'), 'no success is painted before the real settlement')
  h.settleCopy(true)
  rows = h.rows()
  assert.ok(rows.at(-1)!.includes('Path copied'), `the settled outcome is painted: ${rows.at(-1)}`)
  assert.ok(rows.at(-1)!.includes('[Back]'), 'Back stays a real target beside the notice')
  click('[Back]')
  assert.equal(h.panel.currentPage(), 'files')
})

test('a footer or page change retires the previous frame cells before the next paint', () => {
  const h = harness(ONE_TURN)
  h.setSize(100, 30)
  const rows = h.rows()
  const bar = rows.at(-1)!
  const closeColumn = bar.indexOf('[Close]') + 2
  // Enter opens Details and requests a frame; WITHOUT repainting, the old Files
  // footer cell belongs to a page that no longer exists.
  h.type('enter')
  assert.equal(h.panel.currentPage(), 'details')
  const stale = h.panel.handleMouse({
    type: 'click', button: 'left', x: closeColumn, y: rows.length - 1, screenX: closeColumn, screenY: rows.length - 1,
    width: contentWidth(100, 30), height: contentRows(100, 30),
    shift: false, alt: false, ctrl: false,
  })
  assert.equal(stale, undefined, 'the old Files footer is dead after the page change')
  assert.equal(h.closes(), 0)
  assert.equal(h.panel.currentPage(), 'details')
})

test('a list click SELECTS and only the painted Details verb opens the page', () => {
  const h = harness(ONE_TURN)
  h.setSize(100, 30)
  const rows = h.rows()
  const secondRow = rows.findIndex(row => row.includes('report-final.md'))
  assert.ok(secondRow > 0)
  const width = contentWidth(100, 30)
  // A list click (left of the verb) selects without opening.
  clickAt(h.panel, { x: 4, y: secondRow, width, height: rows.length })
  assert.equal(h.panel.currentPage(), 'files')
  assert.deepEqual(h.panel.selection(), { turn: 24, path: '/ws/output/report-final.md' })

  // The painted `Details` verb opens THAT row.
  const verbColumn = rows[secondRow]!.lastIndexOf('Details') + 2
  const handled = clickAt(h.panel, { x: verbColumn, y: secondRow, width, height: rows.length })
  assert.equal(handled?.handled, true)
  assert.equal(h.panel.currentPage(), 'details')
  assert.ok(h.rows().some(row => row.includes('/ws/output/report-final.md')))
})

test('a click at a stale painted size is rejected', () => {
  const h = harness(ONE_TURN)
  h.setSize(100, 30)
  const rows = h.rows()
  const secondRow = rows.findIndex(row => row.includes('report-final.md'))
  // The frame hands the event the geometry the NEXT paint would use; the panel
  // rejects it because the LAST PAINTED frame is a different size.
  const rejected = clickAt(h.panel, {
    x: 4, y: secondRow, width: contentWidth(80, 24), height: contentRows(80, 24),
  })
  assert.equal(rejected, undefined, 'a resize invalidates the recorded hit map')
})

test('inert chrome never acts: an ordinary key is swallowed, not forwarded', () => {
  const h = harness(ONE_TURN)
  const renders = h.renders()
  h.type('x')
  h.type('\t')
  assert.equal(h.renders(), renders, 'an unbound key changes nothing')
  assert.equal(h.panel.currentPage(), 'files')
  assert.equal(h.closes(), 0)
})

test('an empty Turn list is a construction error, never an empty overlay', () => {
  assert.throws(() => new DeliveredFilesPanel({
    snapshot: { subjectKind: 'main', sessionId: 's', sourceIdentity: {}, turns: [] },
    requestRender: () => {},
    close: () => {},
    copyPath: () => {},
  }), /at least one delivered turn/)
})

test('the design-language size matrix keeps one action bar, a body row and whole-segment drops', () => {
  const h = harness(snapshotOf([{
    turn: 8,
    files: ['/ws/a.md', '/ws/b.md', '/ws/c.md', '/ws/table-of-contents-with-a-long-name.md'],
  }]))
  // §11.2's frozen matrix (the rows the panel is granted follow the overlay
  // cap: maxHeight = min(24, rows - 2), then the frame's two borders).
  for (const [columns, rows] of [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20]] as const) {
    h.setSize(columns, rows)
    const painted = h.rows()
    const label = `${columns}x${rows}`
    assert.equal(painted.length, contentRows(columns, rows), `${label}: fills the granted rows`)
    assertNoOverflow(painted, contentWidth(columns, rows))
    // The action bar IS the last painted row of the panel.
    const bar = painted.at(-1)!
    assert.ok(bar.includes('[Close]'), `${label}: the action bar is the last row: ${JSON.stringify(bar)}`)
    // The body floor survives: at least one file row between header and bar.
    assert.ok(painted.some(row => row.includes('a.md')), `${label}: at least one result row`)
    // Whole-segment degradation only: a bar still painting more than one
    // segment never truncates mid-word.
    if (bar.split(' · ').length > 1) assert.ok(!bar.includes('…'), `${label}: no truncated segment`)
  }
})

test('long filenames that differ only at the end stay distinguishable in the list', () => {
  const long = 'report-2026-10-client-server-migration-final-version-'
  const h = harness(snapshotOf([{ turn: 1, files: [`/ws/docs/${long}alpha.md`, `/ws/docs/${long}beta.md`] }]))
  h.setSize(44, 20)
  const rows = h.rows()
  const listed = rows.filter(row => row.includes('report-2026-10'))
  assert.equal(listed.length, 2, `both rows are painted:\n${rows.join('\n')}`)
  assert.notEqual(listed[0]!.trim(), listed[1]!.trim(), 'the rows must differ')
  assert.ok(listed[0]!.includes('alpha.md'), `the distinguishing tail survives: ${listed[0]}`)
  assert.ok(listed[1]!.includes('beta.md'), `the distinguishing tail survives: ${listed[1]}`)
  assert.ok(listed[0]!.includes('…'), 'the clamp is visible, never silent')
})

test('the Details title carries the SAME unique label the list shows', () => {
  const h = harness(snapshotOf([{
    turn: 1,
    files: ['/a/report\u001b[31m', '/a/report\u001b[32m'],
  }]))
  h.setSize(100, 30)
  h.type('enter')
  assert.ok(h.rows()[0]!.includes('report · Details'), h.rows()[0]!)
  h.type('esc')
  h.type('down')
  h.type('enter')
  assert.ok(h.rows()[0]!.includes('report (2) · Details'),
    `the second declaration keeps its own title:\n${h.rows()[0]}`)
  // The HOST line still carries the safe projection of the RAW declared path.
  assert.ok(h.rows().some(row => row.includes('Host: ') && row.includes('/a/report')))
})

test('a middle-only discriminator stays visible in the list and the Details title', () => {
  const middle = (discriminator: string): string => `/ws/docs/report-${'a'.repeat(24)}${discriminator}${'b'.repeat(24)}.md`
  const h = harness(snapshotOf([{ turn: 1, files: [middle('X'), middle('Y')] }]))
  h.setSize(44, 20)
  const rows = h.rows()
  const listed = rows.filter(row => row.includes('report-'))
  assert.equal(listed.length, 2, `both rows are painted:\n${rows.join('\n')}`)
  assert.notEqual(listed[0]!.trim(), listed[1]!.trim(), 'the clamp must not collapse the two rows')

  // The Details title joins the same fitted labels, so it differs too.
  h.type('enter')
  const first = h.rows()[0]!
  h.type('esc')
  h.type('down')
  h.type('enter')
  const second = h.rows()[0]!
  assert.ok(first.includes(' · Details') && second.includes(' · Details'), `${first}\n${second}`)
  assert.notEqual(first, second, 'two different files must not have the same Details title')
  // The Details body carries the COMPLETE projected path (wrapped, never clipped).
  const body = h.rows().join('')
  assert.ok(body.includes('report-aaaaaaaa'), `the path head is visible:\n${body}`)
  assert.ok(body.includes('bbbbbbbb.md'), `the path tail is visible:\n${body}`)
})

test('a wrapped Host path preserves every projected character', () => {
  const path = '/ws/archive/a very long report name.md'
  const h = harness(snapshotOf([{ turn: 1, files: [path] }]))
  h.setSize(44, 20)
  h.type('enter')
  const rows = h.rows()
  const hostStart = rows.findIndex(row => row.startsWith('Host: '))
  assert.ok(hostStart >= 0, rows.join('\n'))
  const chunks: string[] = []
  for (let index = hostStart; index < rows.length; index += 1) {
    const row = rows[index]!
    if (index === hostStart) {
      chunks.push(row.slice('Host: '.length).trimEnd())
      continue
    }
    if (!row.startsWith('      ')) break
    chunks.push(row.slice(6).trimEnd())
  }
  assert.ok(chunks.length > 1, `the path really wraps at this width:\n${rows.join('\n')}`)
  assert.equal(chunks.join(''), path, `no character (including a space) may be lost:\n${rows.join('\n')}`)
})

test('the list, the side pane and the Details title paint the same fitted label', () => {
  const long = `report-${'x'.repeat(40)}-${'y'.repeat(20)}.md`
  const h = harness(snapshotOf([{ turn: 1, files: [{ path: `/ws/docs/${long}`, description: 'long one' }, '/ws/docs/other.md'] }]))
  h.setSize(140, 40)
  const rows = h.rows()
  const listRow = rows.find(row => row.startsWith('> report-'))
  assert.ok(listRow !== undefined, rows.join('\n'))
  // Two-column mode puts the side pane on the SAME row: the list cell ends at
  // its own `Details` verb.
  const listLabel = listRow.slice(2, listRow.lastIndexOf(' Details')).trimEnd()
  assert.ok(listLabel.includes('…'), `precondition: the list cell clamps the label: ${listLabel}`)

  // The wide side pane (right column) starts with the same label.
  const listWidth = Math.max(24, Math.floor((contentWidth(140, 40) - 3) * 0.58))
  const rightJoined = rows.map(row => row.slice(listWidth + 3)).join('')
  assert.ok(rightJoined.includes(listLabel), `the side pane must paint the same label:\n${rightJoined}`)

  // The Details title too.
  h.type('enter')
  const title = h.rows()[0]!.replace(/ · Details$/, '')
  assert.equal(title, listLabel, 'the Details title must reuse the list label')
})

test('a declared path carrying LF stays one physical row per painted line', () => {
  const path = '/ws/archive/line\nbreak.md'
  const h = harness(snapshotOf([{ turn: 1, files: [path] }]))
  h.setSize(44, 20)
  h.type('enter')
  const rows = h.rows()
  for (const row of rows) {
    assert.ok(!row.includes('\n'), `a returned row must never embed LF: ${JSON.stringify(row)}`)
  }
  const hostStart = rows.findIndex(row => row.startsWith('Host: '))
  assert.ok(hostStart >= 0, rows.join('\n'))
  const chunks: string[] = []
  for (let index = hostStart; index < rows.length; index += 1) {
    const row = rows[index]!
    if (index === hostStart) {
      chunks.push(row.slice('Host: '.length).trimEnd())
      continue
    }
    if (!row.startsWith('      ')) break
    chunks.push(row.slice(6).trimEnd())
  }
  // The LF is a row boundary: joining with LF reproduces the projected path.
  assert.equal(chunks.join('\n'), path, `the complete path stays readable across rows:\n${rows.join('\n')}`)
})

test('a declared path carrying LF stays one physical row in the wide side pane', () => {
  const path = '/ws/archive/line\nbreak.md'
  const h = harness(snapshotOf([{ turn: 1, files: [path, '/ws/archive/other.md'] }]))
  h.setSize(140, 40)
  const rows = h.rows()
  for (const row of rows) {
    assert.ok(!row.includes('\n'), `a returned row must never embed LF: ${JSON.stringify(row)}`)
  }
})

test('the Details hit cells are the cells the row really painted', () => {
  const h = harness(snapshotOf([{ turn: 1, files: ['/ws/a.md', '/ws/b.md'] }]))
  h.setSize(74, 24)
  const raw = h.paint().map(row => stripTerminalSequences(row))
  const row = raw.findIndex(line => line.includes('a.md') && line.includes('Details'))
  assert.ok(row >= 0, raw.join('\n'))
  const painted = raw[row]!
  const verbStart = painted.indexOf('Details')
  const verbEnd = verbStart + 'Details'.length
  const click = (x: number) => clickAt(h.panel, { x, y: row, width: painted.length, height: raw.length })
  // FIRST character, LAST character: both are inside the verb.
  for (const x of [verbStart, verbEnd - 1]) {
    assert.equal(click(x)?.handled, true, `column ${x} is the painted verb: ${JSON.stringify(painted)}`)
    assert.equal(h.panel.currentPage(), 'details')
    h.type('esc')
  }
  // The cells outside the verb never OPEN the page. A list cell may still
  // SELECT (that is the row's intended behaviour), but it must not enter
  // Details — which is exactly what a shifted hit range used to do.
  assert.equal(verbEnd, painted.length, 'fixture: the verb is right-aligned to the row end')
  for (const x of [2, verbStart - 1] as const) {
    click(x)
    assert.equal(h.panel.currentPage(), 'files', `column ${x} must not open Details`)
  }
})


test('filtering keeps the retained selection VISIBLE, not merely valid', () => {
  // Interleaved groups: filtering to `a-` RETAINS the selection but moves it to a
  // much smaller index, while the viewport is parked far below. A top that is
  // only clamped to the legal scroll range then leaves the marked row off screen.
  const files = Array.from({ length: 200 }, (_, index) => {
    const id = String(index + 1).padStart(3, '0')
    return [{ path: `/ws/a-${id}.md` }, { path: `/ws/b-${id}.md` }]
  }).flat()
  const h = harness(snapshotOf([{ turn: 5, files }]))
  h.setSize(100, 30)
  h.rows()
  // Park the selection on a-150 (unfiltered index 299): the viewport is far below.
  for (let step = 0; step < 299 && h.panel.selection().path !== '/ws/a-150.md'; step += 1) h.type('down')
  const parked = h.panel.selection().path!
  assert.equal(parked, '/ws/a-150.md', 'fixture: the selection sits deep in the list')

  h.type('/')
  for (const char of 'a-') h.type(char)
  h.type('enter')
  const filtered = h.rows()
  const marked = filtered.filter(row => row.startsWith('> '))
  assert.equal(marked.length, 1, `exactly one selected row is painted:\n${filtered.join('\n')}`)
  assert.ok(marked[0]!.includes('a-150.md'),
    `the RETAINED selection stays visible after the filter:\n${filtered.join('\n')}`)
  assert.equal(h.panel.selection().path, parked)
})

test('a click cannot resolve against the list the filter just replaced', () => {
  const h = harness(snapshotOf([{ turn: 1, files: ['/ws/a.md', '/ws/b.md', '/ws/c.md'] }]))
  h.setSize(74, 24)
  const raw = h.paint().map(row => stripTerminalSequences(row))
  const firstRow = raw.findIndex(row => row.includes('a.md') && row.includes('Details'))
  assert.ok(firstRow >= 0, raw.join('\n'))
  const verbStart = raw[firstRow]!.lastIndexOf('Details')

  // Commit a filter that REPLACES the first row's file (b.md now paints first)
  // and click immediately, before the next frame is painted.
  h.type('/')
  h.type('b')
  h.type('enter')
  const handled = clickAt(h.panel, {
    x: verbStart + 1, y: firstRow, width: raw[firstRow]!.length, height: raw.length,
  })
  assert.equal(handled, undefined, 'the stale frame has no hit targets any more')
  assert.equal(h.panel.currentPage(), 'files', 'no Details page opened from a frame that no longer exists')
  // Selection may have been normalized to the first filtered row already; the
  // decisive fact is that the STALE CELL opened nothing.
  assert.ok(!h.rows().some(line => line.includes('b.md · Details')), 'no Details page opened')

  // After the repaint the same cell is live again — and opens the NEW row.
  const repainted = h.rows()
  const row = repainted.findIndex(line => line.includes('b.md') && line.includes('Details'))
  const freshVerb = repainted[row]!.lastIndexOf('Details')
  clickAt(h.panel, {
    x: freshVerb + 1, y: row, width: repainted[row]!.length, height: repainted.length,
  })
  assert.equal(h.panel.currentPage(), 'details')
  assert.ok(h.rows().some(line => line.includes('/ws/b.md')), 'the fresh frame opens the file it paints')
})

test('a Turns switch invalidates the old hit frame too', () => {
  const h = harness(snapshotOf([
    { turn: 9, files: ['/ws/newest.md'] },
    { turn: 4, files: ['/ws/older.md'] },
  ]))
  h.setSize(74, 24)
  const raw = h.paint().map(row => stripTerminalSequences(row))
  const row = raw.findIndex(line => line.includes('older.md') === false && line.includes('Details'))
  assert.ok(row >= 0, raw.join('\n'))
  const verbStart = raw[row]!.lastIndexOf('Details')
  h.type('T')
  h.type('down')
  h.type('enter')
  const handled = clickAt(h.panel, {
    x: verbStart + 1, y: row, width: raw[row]!.length, height: raw.length,
  })
  assert.equal(handled, undefined, 'the pre-switch frame is dead')
  assert.equal(h.panel.currentPage(), 'files')
})

test('the Details page opens only on a COMPLETE click, never on a press', () => {
  const h = harness(snapshotOf([{ turn: 1, files: ['/ws/a.md', '/ws/b.md'] }]))
  h.setSize(74, 24)
  const raw = h.paint().map(row => stripTerminalSequences(row))
  const row = raw.findIndex(line => line.includes('a.md') && line.includes('Details'))
  const verbStart = raw[row]!.indexOf('Details')
  const event = (type: 'press' | 'click' | 'drag', x: number) => ({
    type, button: 'left' as const, x, y: row, screenX: x, screenY: row,
    width: raw[row]!.length, height: raw.length, shift: false, alt: false, ctrl: false,
  })
  // A PRESS ON THE VERB selects and consumes, and opens NOTHING: the gesture may
  // still turn into a drag.
  assert.equal(h.panel.handleMouse(event('press', verbStart + 1))?.handled, true)
  assert.equal(h.panel.currentPage(), 'files', 'a press must never open the page')
  // The synthetic click (same cell, no drag) is the ONE opener.
  assert.equal(h.panel.handleMouse(event('click', verbStart + 1))?.handled, true)
  assert.equal(h.panel.currentPage(), 'details')
  h.type('esc')
  assert.equal(h.panel.currentPage(), 'files')
  // A drag away then release: the panel receives no click at all, so nothing
  // opened — exactly the terminal layer's contract.
  h.panel.handleMouse(event('press', verbStart + 1))
  assert.equal(h.panel.currentPage(), 'files', 'press + drag away leaves the page closed')
})

test('shrinking the viewport keeps the selected file VISIBLE', () => {
  const files = Array.from({ length: 60 }, (_, index) => `/ws/f-${String(index + 1).padStart(3, '0')}.md`)
  const h = harness(snapshotOf([{ turn: 1, files }]))
  // Tall frame: the selection sits near the BOTTOM of a long viewport.
  h.setSize(100, 40)
  h.rows()
  for (let step = 0; step < 18; step += 1) h.type('down')
  const selected = h.panel.selection().path!
  assert.ok(h.rows().some(row => row.startsWith('> ') && row.includes(selected.slice(selected.lastIndexOf('/') + 1))),
    'precondition: the selection is visible in the tall frame')

  // Shrink: fewer granted rows than before.
  h.setSize(40, 16)
  const small = h.rows()
  const marked = small.filter(row => row.startsWith('> '))
  assert.equal(marked.length, 1, `exactly one selected row in the small frame:\n${small.join('\n')}`)
  assert.ok(marked[0]!.includes(selected.slice(selected.lastIndexOf('/') + 1)),
    `the selection stays visible after the shrink:\n${small.join('\n')}`)
  assert.equal(h.panel.selection().path, selected, 'the identity is unchanged')

  // Growing back keeps it visible too.
  h.setSize(100, 40)
  const large = h.rows()
  assert.ok(large.some(row => row.startsWith('> ') && row.includes(selected.slice(selected.lastIndexOf('/') + 1))))
  assert.equal(h.panel.selection().path, selected)
})

test('copy feedback belongs to the LATEST request and never outlives its page', () => {
  const pending: Array<(ok: boolean) => void> = []
  let renders = 0
  const panel = new DeliveredFilesPanel({
    snapshot: snapshotOf([{ turn: 1, files: ['/ws/a.md'] }]),
    requestRender: () => { renders += 1 },
    close: () => {},
    copyPath: (_path, settle) => { pending.push(settle) },
  })
  panel.setMaxRows(22)
  const rows = () => panel.render(96).map(row => stripTerminalSequences(row))
  panel.handleInput('\r')
  assert.equal(panel.currentPage(), 'details')
  rows()

  // Two copies in flight; the FIRST (slower) one settles last.
  panel.handleInput(KEY.C)
  panel.handleInput(KEY.C)
  assert.equal(pending.length, 2, 'both writes reached the clipboard')
  pending[1]!(false)
  pending[0]!(true)
  assert.ok(rows().at(-1)!.includes('Could not copy path'),
    `the LATEST settlement wins, not the slower earlier one:\n${rows().at(-1)}`)
  void renders

  // Leave the page, come back to the SAME file: the previous visit's pending
  // settlement must not paint on the new page.
  panel.handleInput(KEY.esc)
  rows()
  panel.handleInput('\r')
  rows()
  assert.ok(!rows().at(-1)!.includes('Path copied'), 'a fresh page starts with no feedback')
  panel.handleInput(KEY.C)
  const stale = pending.at(-1)!
  panel.handleInput(KEY.esc)
  rows()
  panel.handleInput('\r')
  rows()
  stale(true)
  assert.ok(!rows().at(-1)!.includes('Path copied'),
    `the abandoned visit's settlement cannot paint on the re-entered page:\n${rows().at(-1)}`)
})

test('PageUp walks back through the list instead of sticking (every step repaints)', () => {
  const files = Array.from({ length: 120 }, (_, index) => `/ws/f-${String(index + 1).padStart(3, '0')}.md`)
  const h = harness(snapshotOf([{ turn: 1, files }]))
  h.setSize(100, 30)
  const paint = () => h.rows()
  const rowsPerPage = 17
  const marked = (rows: readonly string[]): string => {
    const row = rows.find(line => line.startsWith('> '))
    assert.ok(row !== undefined, `a selected row is painted:\n${rows.join('\n')}`)
    // `> f-001.md   Details`
    return row.trim().split(/\s+/)[1]!
  }
  const pageDown = (): void => h.type('pageDown')
  const pageUp = (): void => h.type('pageUp')

  let rows = paint()
  assert.equal(marked(rows), 'f-001.md')
  // Deep enough that three backward pages cannot hit the top: three pages down.
  for (let step = 0; step < 3; step += 1) { pageDown(); rows = paint() }
  const deepIndex = files.findIndex(file => file.endsWith(`/${marked(rows)}`))
  assert.ok(deepIndex >= rowsPerPage * 2, `fixture: the selection is deep (${marked(rows)})`)

  // THREE pages back: every step must really move BACKWARDS and repaint, and the
  // marked row must always be inside the painted window.
  const indexes: number[] = [deepIndex]
  for (let step = 0; step < 3; step += 1) {
    pageUp()
    rows = paint()
    const label = marked(rows)
    const index = files.findIndex(file => file.endsWith(`/${label}`))
    assert.ok(index >= 0, `the marked row is a real file: ${label}`)
    assert.equal(rows.filter(line => line.startsWith('> ')).length, 1, 'exactly one selected row')
    assert.ok(rows.some(line => line.includes(label)), 'the selected row is painted')
    assert.ok(index < indexes.at(-1)!, `PageUp step ${step + 1} moved backwards: ${indexes.at(-1)} -> ${index}`)
    indexes.push(index)
  }
  // And the forward direction still walks the same way.
  const before = indexes.at(-1)!
  pageDown()
  const after = files.findIndex(file => file.endsWith(`/${marked(paint())}`))
  assert.ok(after > before, `PageDown moved forward again: ${before} -> ${after}`)
})

// ── Delivered files PR2: the Details PREVIEW ─────────────────────────────

interface PreviewHarness extends Harness {
  readonly statCalls: () => number
  readonly readCalls: () => readonly { offset: number; limit: number }[]
  readonly diagnostics: () => readonly string[]
  readonly resolveStat: (stat: DeliveredFileStat) => void
  readonly rejectStat: (error: unknown) => void
  readonly resolveRead: (page: DeliveredFilePage) => void
  readonly rejectRead: (error: unknown) => void
  readonly preview: () => DeliveredFilesPreviewState
  readonly waitForPreviewState: (kind: DeliveredFilesPreviewState['kind']) => Promise<void>
}

/** A real panel over a snapshot with a CONTROLLABLE Host read. */
function previewHarness(
  snapshot: DeliveredFilesSnapshot,
  options: {
    initial?: { turn?: number; path?: string; page?: 'files' | 'details' }
    preview?: boolean
    autoResolve?: DeliveredFilePage
    /** An EXTERNAL sink so a test can assert what reached diagnostics. */
    diagnostics?: string[]
    pointerActions?: boolean
  } = {},
): PreviewHarness {
  let renderCount = 0
  const renderWaiters = new Set<() => void>()
  let statCount = 0
  const readCalls: { offset: number; limit: number }[] = []
  const diagnostics: string[] = []
  const pendingStats: Array<{ resolve(stat: DeliveredFileStat): void; reject(error: unknown): void }> = []
  const pendingReads: Array<{ resolve(page: DeliveredFilePage): void; reject(error: unknown): void }> = []
  const panel = new DeliveredFilesPanel({
    snapshot,
    ...(options.initial === undefined ? {} : { initial: options.initial }),
    pointerActions: options.pointerActions === true,
    requestRender: () => {
      renderCount += 1
      for (const resolve of renderWaiters) resolve()
      renderWaiters.clear()
    },
    close: () => {},
    copyPath: (_path, settle) => settle(true),
    ...(options.preview === false ? {} : {
      preview: {
        stat: (_path, _signal) => {
          statCount += 1
          if (options.autoResolve !== undefined) {
            return Promise.resolve(options.autoResolve.stat)
          }
          return new Promise<DeliveredFileStat>((resolve, reject) => { pendingStats.push({ resolve, reject }) })
        },
        read: (path: string, offset: number, _signal: AbortSignal) => {
          // The panel never chooses a page size: the fixture records the PORT's.
          const limit = DELIVERED_FILE_PAGE_LINES
          readCalls.push({ offset, limit })
          if (options.autoResolve !== undefined) {
            return Promise.resolve({ ...options.autoResolve, offset, limit, text: options.autoResolve.text })
          }
          void path
          return new Promise<DeliveredFilePage>((resolve, reject) => { pendingReads.push({ resolve, reject }) })
        },
      },
    }),
    reportUnclassifiedFailure: (message) => {
      diagnostics.push(message)
      options.diagnostics?.push(message)
    },
  })
  // Honor `setSize` exactly like the plain harness: the SAME production
  // geometry resolves the cap, and the frame grants `maxHeight - 2` content
  // rows at `width - 4` cells.
  let width = 100
  let height = 30
  const paint = (): readonly string[] => {
    const geometry = deliveredFilesOverlayGeometry(width, height)
    panel.setMaxRows(Math.max(1, geometry.maxHeight - 2))
    return panel.render(Math.max(1, geometry.width - 4))
  }
  return {
    panel,
    rows: () => paint().map(row => stripTerminalSequences(row)),
    renders: () => renderCount,
    closes: () => 0,
    copied: () => [],
    settleCopy: () => {},
    setSize: (columns, rows) => { width = columns; height = rows },
    paint,
    type: (data) => panel.handleInput(KEY[data as keyof typeof KEY] ?? data),
    statCalls: () => statCount,
    readCalls: () => readCalls,
    diagnostics: () => diagnostics,
    resolveStat: (stat) => { pendingStats.shift()?.resolve(stat) },
    rejectStat: (error) => { pendingStats.shift()?.reject(error) },
    resolveRead: (page) => { pendingReads.shift()?.resolve(page) },
    rejectRead: (error) => { pendingReads.shift()?.reject(error) },
    preview: () => (panel as unknown as { preview: DeliveredFilesPreviewState }).preview,
    waitForPreviewState: async (kind) => {
      // The render waiter is the success signal; this deadline only fails a stuck test.
      const deadline = Date.now() + 15_000
      while ((panel as unknown as { preview: DeliveredFilesPreviewState }).preview.kind !== kind) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          const current = (panel as unknown as { preview: DeliveredFilesPreviewState }).preview.kind
          throw new Error(`timed out waiting for preview ${kind}; current state is ${current}`)
        }
        await new Promise<void>((resolve, reject) => {
          let timer: ReturnType<typeof setTimeout> | undefined
          let settled = false
          const onRender = (): void => {
            if (settled) return
            settled = true
            if (timer !== undefined) clearTimeout(timer)
            renderWaiters.delete(onRender)
            resolve()
          }
          timer = setTimeout(() => {
            if (settled) return
            settled = true
            renderWaiters.delete(onRender)
            const current = (panel as unknown as { preview: DeliveredFilesPreviewState }).preview.kind
            reject(new Error(`timed out waiting for preview ${kind}; current state is ${current}`))
          }, remaining)
          renderWaiters.add(onRender)
        })
      }
    },
  }
}

test('Enter Preview stats first, then reads exactly ONE 120-line page', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/report.md'] }]))
  h.type('enter')
  assert.equal(h.preview().kind, 'loading-stat', 'the FIRST Host call is the stat')
  assert.deepEqual(h.readCalls(), [], 'nothing is read before the metadata lands')
  assert.ok(h.rows().some(row => row.includes('Loading…')))

  h.resolveStat({ version: 'v1', bytes: 42 })
  await h.waitForPreviewState('loading-page')
  assert.deepEqual(h.readCalls(), [{ offset: 1, limit: 120 }], 'one page, the fixed window')
  assert.equal(h.preview().kind, 'loading-page')

  h.resolveRead({
    stat: { version: 'v1', bytes: 42 }, offset: 1, limit: 120,
    text: 'first line\nsecond line', lines: 2, eof: false,
  })
  await h.waitForPreviewState('text-page')
  const rows = h.rows().join('\n')
  assert.ok(rows.includes('first line') && rows.includes('second line'), rows)
  assert.ok(rows.includes('/ws/report.md'), 'the declared Host path stays visible')
})

test('a known binary suffix shows metadata only and never reads', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/chart.png'] }]))
  h.type('enter')
  h.resolveStat({ version: 'v1', bytes: 900 })
  await h.waitForPreviewState('metadata')
  assert.deepEqual(h.readCalls(), [], 'no bytes are read for a binary suffix')
  const rows = h.rows().join('\n')
  assert.ok(rows.includes('Preview unavailable for this file type'), rows)
  assert.ok(rows.includes('Size: 900 bytes'), rows)
})

test('every refusal paints its FIXED text and keeps the copy affordance', async () => {
  const cases: readonly [DeliveredFileReadFailureCode, string][] = [
    ['not-found', 'File no longer exists on Host'],
    ['not-text', 'Not a UTF-8 text file'],
    ['not-regular-file', 'File is no longer a regular file'],
    ['too-large', 'Text page exceeds Host read limit'],
    ['session-unavailable', 'Session file scope is unavailable'],
    ['service-unavailable', 'Host file preview is unavailable'],
  ]
  for (const [code, text] of cases) {
    const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/report.md'] }]))
    h.type('enter')
    h.rejectStat(new DeliveredFileReadError(code, 'refused'))
    await h.waitForPreviewState('failure')
    const rows = h.rows().join('\n')
    assert.ok(rows.includes(text), `${code}: ${rows}`)
    assert.ok(rows.includes('Shift+C Copy path'), `${code}: the keyboard Copy stays available`)
    assert.equal(h.diagnostics().length, 0, `${code}: a classified refusal is not a diagnostic`)
  }
})

test('an unclassified failure is generic AND reported to diagnostics', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/report.md'] }]))
  h.type('enter')
  h.rejectStat(new Error('weird transport'))
  await h.waitForPreviewState('failure')
  assert.ok(h.rows().join('\n').includes('Unable to preview file'))
  assert.deepEqual(h.diagnostics(), ['delivered file preview'], 'the cause reaches the diagnostic sink')
})

test('a superseded request never paints over the newer one', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/a.md', '/ws/b.md'] }]))
  h.type('enter')
  // Switch to the second file before the first stat lands: the FIRST reply must
  // be dropped (it no longer owns the page).
  h.type('esc')
  h.type('down')
  h.type('enter')
  h.resolveStat({ version: 'stale', bytes: 1 })
  const currentStat = h.waitForPreviewState('loading-page')
  h.resolveStat({ version: 'current', bytes: 2 })
  await currentStat
  assert.equal(h.preview().kind, 'loading-page',
    'the stale reply never becomes the state (only the CURRENT stat may paint)')
  assert.deepEqual(h.readCalls(), [{ offset: 1, limit: 120 }],
    'only the current metadata reply starts a read')
})

test('a changed version restarts the preview instead of splicing pages', async () => {
  const snapshot = snapshotOf([{ turn: 1, files: ['/ws/long.md'] }])
  const h = previewHarness(snapshot)
  h.type('enter')
  h.resolveStat({ version: 'v1', bytes: 10 })
  await h.waitForPreviewState('loading-page')
  h.resolveRead({ stat: { version: 'v1', bytes: 10 }, offset: 1, limit: 120, text: 'one', lines: 1, eof: false })
  await h.waitForPreviewState('text-page')
  // Ask for the next page; the Host reports a NEW version for it.
  h.type('pageDown')
  h.type('pageDown')
  assert.deepEqual(h.readCalls().at(-1), { offset: 121, limit: 120 })
  h.resolveRead({ stat: { version: 'v2', bytes: 12 }, offset: 121, limit: 120, text: 'two', lines: 1, eof: true })
  await h.waitForPreviewState('loading-stat')
  const rows = h.rows().join('\n')
  assert.ok(rows.includes('File changed; preview restarted'), rows)
  assert.ok(!rows.includes('two'), 'the other version is never spliced in')
})

test('an EOF page is a definite end, never a retry loop', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/short.md'] }]))
  h.type('enter')
  h.resolveStat({ version: 'v1' })
  await h.waitForPreviewState('loading-page')
  h.resolveRead({ stat: { version: 'v1' }, offset: 1, limit: 120, text: '', lines: 0, eof: true })
  await h.waitForPreviewState('text-page')
  assert.ok(h.rows().join('\n').includes('(end of file)'))
  const reads = h.readCalls().length
  h.type('pageDown')
  h.type('pageDown')
  assert.equal(h.readCalls().length, reads, 'an EOF page never requests another one')
})

test('a mount without the Host read paints the definite unavailable state', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/report.md'] }]), { preview: false })
  h.type('enter')
  assert.equal(h.preview().kind, 'failure')
  const rows = h.rows().join('\n')
  assert.ok(rows.includes('Host file preview is unavailable'), rows)
  assert.equal(h.statCalls(), 0)
})

test('a surface without a real pointer owner paints no dead Details verb', () => {
  const snapshot = snapshotOf([{ turn: 1, files: ['/ws/a.md', '/ws/b.md'] }])
  let renders = 0
  const panel = new DeliveredFilesPanel({
    snapshot,
    // No `pointerActions`: exactly the regular surface, where PiTui never
    // enables terminal mouse reporting.
    requestRender: () => { renders += 1 },
    close: () => {},
    copyPath: (_path, settle) => settle(true),
  })
  panel.setMaxRows(22)
  const rows = panel.render(96).map(row => stripTerminalSequences(row))
  const text = rows.join('\n')
  assert.ok(text.includes('a.md') && text.includes('b.md'), text)
  assert.ok(!text.includes('Details'), `no per-row verb may be painted: ${text}`)
  assert.ok(!text.includes('[Filter]') && !text.includes('[Turns]') && !text.includes('[Close]'),
    `a mouse-less surface paints no bracketed footer button: ${text}`)
  assert.ok(rows.at(-1)!.includes('Esc Close'), `the keyboard exit hint stays: ${rows.at(-1)}`)
  // A foreign pointer event is never claimed either.
  const handled = clickAt(panel, {
    x: 90, y: rows.findIndex(row => row.includes('a.md')), width: 96, height: rows.length,
  })
  assert.equal(handled, undefined, 'the panel claims nothing without a pointer owner')
  assert.equal(panel.currentPage(), 'files')
  void renders

  // The SAME snapshot with a real pointer owner does paint the verb.
  const pointerPanel = new DeliveredFilesPanel({
    snapshot, pointerActions: true,
    requestRender: () => {},
    close: () => {},
    copyPath: (_path, settle) => settle(true),
  })
  pointerPanel.setMaxRows(22)
  const pointerRows = pointerPanel.render(96).map(row => stripTerminalSequences(row))
  assert.ok(pointerRows.join('\n').includes('Details'), 'a fullscreen surface paints it')
})

test('a superseded read is discarded SILENTLY and ends in a neutral, recoverable state', async () => {
  const diagnostics: string[] = []
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/a.md'] }]), { diagnostics })
  h.setSize(100, 30)
  h.type('enter')
  assert.equal(h.preview().kind, 'loading-stat')
  h.rows()

  // The connection generation moves on while the request is in flight: the port
  // refuses with the UI-silent `SupersededReadError`.
  const { SupersededReadError } = await import('../../src/runtime/read-error.ts')
  h.rejectStat(new SupersededReadError('generation'))
  await h.waitForPreviewState('idle')
  const rows = h.rows()
  const text = rows.join('\n')
  // A neutral, NON-claiming state: no loading, no stale bytes, no failure claim.
  assert.ok(!text.includes('Loading'), `the loading state ends:\n${text}`)
  assert.ok(!text.includes('Unable to preview file'), `a superseded read is not a failure claim:\n${text}`)
  assert.ok(!text.includes('File no longer exists'), text)
  assert.equal(h.preview().kind, 'idle', 'the page falls back to its neutral body')
  assert.equal(diagnostics.length, 0, 'a UI-silent supersede is never reported as an error')
  // The page still shows the REAL declared metadata.
  assert.ok(text.includes('/ws/a.md'), text)
  assert.ok(rows.some(row => row.includes('· Details')), 'the page is still the Details page')

  // Recovery is the user's next explicit action: leave and re-enter re-requests.
  // The FIRST entry already counted one stat, so a bare `>= 1` would pass even if
  // the re-entry asked nothing: compare against the count taken right before.
  h.type('esc')
  h.rows()
  const statsBeforeReentry = h.statCalls()
  assert.equal(statsBeforeReentry, 1, 'the superseded attempt asked exactly once')
  h.type('enter')
  assert.equal(h.preview().kind, 'loading-stat', 're-entering issues a NEW request')
  assert.equal(h.statCalls(), statsBeforeReentry + 1, 'the re-entry really asked the Host again')
})

test('a near-limit single line is wrapped for the VIEWPORT, not re-wrapped per keystroke', async () => {
  // One legal UTF-8 line close to the Host's 2 MiB page bound, on a narrow
  // terminal: the full wrap is ~50k physical rows. Navigation must only
  // materialise what it shows.
  const longLine = 'x'.repeat(2 * 1024 * 1024 - 16)
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/huge.txt'] }]), {
    autoResolve: {
      stat: { version: 'v1', bytes: longLine.length },
      offset: 1,
      limit: DELIVERED_FILE_PAGE_LINES,
      text: longLine,
      lines: 1,
      eof: true,
    },
  })
  h.setSize(40, 16)
  h.type('enter')
  await h.waitForPreviewState('text-page')
  interface WrapProbe { readonly wrappedSourceLines: number; readonly wrappedPhysicalRows: number }
  const probe = (): number => (h.panel as unknown as WrapProbe).wrappedSourceLines
  const physical = (): number => (h.panel as unknown as WrapProbe).wrappedPhysicalRows

  // The first paint wraps the ONE source line at most once.
  h.rows()
  const afterOpen = probe()
  assert.ok(afterOpen <= 1, `opening wraps the source line once (${afterOpen})`)

  // Twenty consecutive scroll steps: each only extends the visible window, so
  // the counter stays at ONE source line — never 50k physical rows, never a
  // re-wrap of the whole page per keystroke.
  const started = Date.now()
  for (let step = 0; step < 20; step += 1) {
    h.type('down')
    h.rows()
  }
  const elapsed = Date.now() - started
  assert.equal(probe(), afterOpen, 'scrolling never re-wraps the source line')
  assert.ok(elapsed < 2_000, `twenty scroll steps stay responsive (${elapsed}ms)`)

  // The MATERIALISED PHYSICAL rows are viewport-bounded, not the ~50k a full
  // wrap of this line would produce.
  const rowsMaterialised = physical()
  assert.ok(rowsMaterialised <= 64,
    `only viewport-scale physical rows are built (${rowsMaterialised} of ~52k)`)

  // The rows really advanced: the viewport moved down within the wrapped line.
  const pageUp = h.rows()
  assert.ok(pageUp.length > 0)
  // A width change invalidates the cache (one fresh wrap of the same line).
  h.setSize(64, 16)
  h.rows()
  assert.equal(probe(), 1, 'a width change re-derives exactly one wrapped line')
})

test('a 12-column terminal wraps a near-limit line without blowing the stack', async () => {
  // 12 columns turns one ~2 MiB line into ~175k rows: spreading that array into
  // `push(...)` threw `RangeError: Maximum call stack size exceeded`.
  const longLine = 'y'.repeat(2 * 1024 * 1024 - 16)
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/narrow.txt'] }]), {
    autoResolve: {
      stat: { version: 'v1', bytes: longLine.length },
      offset: 1,
      limit: DELIVERED_FILE_PAGE_LINES,
      text: longLine,
      lines: 1,
      eof: true,
    },
  })
  h.setSize(16, 14)
  h.type('enter')
  await h.waitForPreviewState('text-page')
  interface WrapProbe { readonly wrappedPhysicalRows: number }
  const physical = (): number => (h.panel as unknown as WrapProbe).wrappedPhysicalRows
  // Opening at the narrowest usable width must NOT throw, and must not build the
  // whole 175k-row projection.
  const rows = h.rows()
  assert.ok(rows.length > 0, 'the page paints')
  assert.ok(physical() <= 64, `viewport-bounded physical rows (${physical()})`)
  // Scrolling stays bounded too.
  for (let step = 0; step < 10; step += 1) {
    h.type('down')
    h.rows()
  }
  assert.ok(physical() <= 128, `scrolling stays viewport-bounded (${physical()})`)
})

test('the restart notice survives the reloaded first page', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/report.md'] }]))
  h.setSize(100, 30)
  h.type('enter')
  // First page of version v1.
  h.resolveStat({ version: 'v1', bytes: 20 })
  await h.waitForPreviewState('loading-page')
  h.resolveRead({
    stat: { version: 'v1', bytes: 20 },
    offset: 1,
    limit: DELIVERED_FILE_PAGE_LINES,
    lines: 1,
    text: 'version one',
    eof: false,
  })
  await h.waitForPreviewState('text-page')
  assert.ok(h.rows().join('\n').includes('version one'))

  // PgDn at the page edge requests the next window; the Host reports a CHANGED
  // version, so the preview restarts from page one.
  h.type('pageDown')
  h.resolveRead({
    stat: { version: 'v2', bytes: 20 },
    offset: 2,
    limit: DELIVERED_FILE_PAGE_LINES,
    lines: 1,
    text: 'stale window',
    eof: true,
  })
  await h.waitForPreviewState('loading-stat')
  h.rows()
  // The restart itself asks for a fresh stat + first page.
  h.resolveStat({ version: 'v2', bytes: 20 })
  await h.waitForPreviewState('loading-page')
  h.resolveRead({
    stat: { version: 'v2', bytes: 20 },
    offset: 1,
    limit: DELIVERED_FILE_PAGE_LINES,
    lines: 1,
    text: 'version two',
    eof: true,
  })
  await h.waitForPreviewState('text-page')
  const painted = h.rows().join('\n')
  // The NEW page is painted AND the restart notice is still visible with it.
  assert.ok(painted.includes('version two'), `the reloaded page is painted:\n${painted}`)
  assert.ok(painted.includes('File changed; preview restarted'),
    `the restart notice survives the reloaded page:\n${painted}`)
  assert.ok(!painted.includes('stale window'), `no version is spliced:\n${painted}`)
})

test('a held Turns row cannot be retargeted by a keyboard scroll/repaint', () => {
  const turns = Array.from({ length: 30 }, (_, index) => ({ turn: 30 - index, files: [`/ws/f-${index + 1}.md`] }))
  const h = harness(snapshotOf(turns))
  h.setSize(100, 30)
  h.type('T')
  let rows = h.rows()
  const pressedRow = rows.findIndex(row => row.trimStart().startsWith('> Turn'))
  assert.ok(pressedRow >= 0, rows.join('\n'))
  const pressedTurnLabel = rows[pressedRow]!.trim()
  // Hold the pointer on the current row, then scroll the Turns list with the
  // keyboard; the same CELL now paints a different Turn.
  h.panel.handleMouse({
    type: 'press', button: 'left', x: 2, y: pressedRow, screenX: 2, screenY: pressedRow,
    width: contentWidth(100, 30), height: contentRows(100, 30),
    shift: false, alt: false, ctrl: false,
  })
  for (let step = 0; step < 25; step += 1) {
    h.type('down')
    h.rows()
  }
  rows = h.rows()
  assert.ok(!rows[pressedRow]!.trim().endsWith(pressedTurnLabel.replace(/^> /, '')),
    `fixture: the row was repainted with another Turn:\n${rows.join('\n')}`)
  const result = clickOnly(h.panel, {
    x: 2, y: pressedRow, width: contentWidth(100, 30), height: contentRows(100, 30),
  })
  assert.equal(result, undefined, 'the click cannot transfer to the row/ Turn painted after the press')
  assert.equal(h.panel.currentPage(), 'turns', 'the stale gesture opened no Turn')
})

test('a held Details verb cannot open the file a filter repainted under it', () => {
  const h = harness(ONE_TURN)
  h.setSize(100, 30)
  let rows = h.rows()
  const pressedRow = rows.findIndex(row => row.includes('report.md') && row.includes('Details'))
  assert.ok(pressedRow >= 0, rows.join('\n'))
  const column = rows[pressedRow]!.lastIndexOf('Details') + 2
  h.panel.handleMouse({
    type: 'press', button: 'left', x: column, y: pressedRow, screenX: column, screenY: pressedRow,
    width: contentWidth(100, 30), height: contentRows(100, 30),
    shift: false, alt: false, ctrl: false,
  })
  // Commit a filter that replaces the row with a DIFFERENT file at the same
  // painted Details cells.
  h.type('/')
  for (const char of 'index') h.type(char)
  h.type('enter')
  rows = h.rows()
  assert.ok(rows[pressedRow]!.includes('report-index.json'), `fixture: the row was retargeted:\n${rows.join('\n')}`)
  const result = clickOnly(h.panel, {
    x: column, y: pressedRow, width: contentWidth(100, 30), height: contentRows(100, 30),
  })
  assert.equal(result, undefined, 'the click cannot open the file painted after the press')
  assert.equal(h.panel.currentPage(), 'files')
  assert.deepEqual(h.panel.selection(), { turn: 24, path: '/ws/results/report-index.json' })
})

test('a held Details [Back] cannot retarget to the Files [Close] after a page change', () => {
  const h = harness(ONE_TURN)
  h.setSize(100, 30)
  h.type('enter')
  let rows = h.rows()
  const footerRow = rows.length - 1
  const backColumn = rows[footerRow]!.indexOf('[Back]') + 2
  assert.ok(rows[footerRow]!.includes('[Back]'), rows[footerRow]!)
  h.panel.handleMouse({
    type: 'press', button: 'left', x: backColumn, y: footerRow, screenX: backColumn, screenY: footerRow,
    width: contentWidth(100, 30), height: contentRows(100, 30),
    shift: false, alt: false, ctrl: false,
  })
  // Keyboard Esc is the same Back transition, then the Files footer paints
  // [Close] under the SAME right-aligned cells.
  h.type('esc')
  rows = h.rows()
  assert.equal(h.panel.currentPage(), 'files')
  assert.ok(rows[footerRow]!.includes('[Close]'), 'fixture: the Files footer paints Close at that edge')
  const result = clickOnly(h.panel, {
    x: backColumn, y: footerRow, width: contentWidth(100, 30), height: contentRows(100, 30),
  })
  assert.equal(result, undefined, 'the held Details Back must not run the Files Close')
  assert.equal(h.closes(), 0)
  assert.equal(h.panel.currentPage(), 'files')
})

test('a Files body press leaves the cell for overlay text selection; a button press stays owned', () => {
  const h = harness(ONE_TURN)
  h.setSize(100, 30)
  const rows = h.rows()
  const dataRow = rows.findIndex(row => row.includes('report-final.md'))
  assert.ok(dataRow > 0, rows.join('\n'))
  const width = contentWidth(100, 30)
  const height = contentRows(100, 30)
  const event = (type: 'press' | 'click', x: number, y: number) => h.panel.handleMouse({
    type, button: 'left', x, y, screenX: x, screenY: y, width, height,
    shift: false, alt: false, ctrl: false,
  })

  // The list BODY (left of the painted verb) does not consume the press: the
  // fork's opt-in turns it into a text selection clipped to the frame.
  assert.equal(event('press', 4, dataRow), undefined, 'a body press must reach the overlay opt-in')
  // The release-synthesized click still selects THAT row, so a normal click
  // keeps its PR A behavior.
  const click = event('click', 4, dataRow)
  assert.equal(click?.handled, true)
  assert.deepEqual(h.panel.selection(), { turn: 24, path: '/ws/output/report-final.md' })

  // Buttons keep owning their press: the painted `Details` verb and the action
  // bar both consume it, so no selection gesture can start on them.
  const verbColumn = rows[dataRow]!.lastIndexOf('Details') + 2
  assert.equal(event('press', verbColumn, dataRow)?.handled, true, 'the Details verb owns its press')
  const bar = rows.at(-1)!
  assert.equal(event('press', bar.indexOf('[Close]') + 2, rows.length - 1)?.handled, true,
    'an action-bar button owns its press')

  // A drag between press and release never completes the row click.
  event('press', 4, dataRow)
  h.panel.handleMouse({
    type: 'drag', button: 'left', x: 12, y: dataRow, screenX: 12, screenY: dataRow, width, height,
    shift: false, alt: false, ctrl: false,
  })
  assert.equal(h.panel.selection().path, '/ws/output/report-final.md',
    'fixture: the row was already selected by the click above')
  assert.equal(event('click', 12, dataRow), undefined, 'a dragged release is not a row click')
})

// ── wheel navigation (delivered-files wheel scroll follow-up) ──────────────

/** One wheel event at a panel-relative cell. The fork produces `button: 'none'`
 *  wheel events carrying the SIGNED `wheelDelta` (negative scrolls up). */
function wheelAt(
  panel: DeliveredFilesPanel,
  cell: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  wheelDelta: number,
) {
  return panel.handleMouse({
    type: 'wheel', button: 'none', wheelDelta,
    x: cell.x, y: cell.y, screenX: cell.x, screenY: cell.y,
    width: cell.width, height: cell.height,
    shift: false, alt: false, ctrl: false,
  })
}

const wheelCell = (x: number, y: number, columns = 100, rows = 30) => ({
  x, y, width: contentWidth(columns, rows), height: contentRows(columns, rows),
})

function manyFiles(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `/ws/dir/file-${String(index).padStart(3, '0')}.txt`)
}

function manyTurns(count: number): DeliveredFilesSnapshot {
  return snapshotOf(Array.from({ length: count }, (_, index) => ({ turn: 100 - index, files: [`/ws/turn-${100 - index}.md`] })))
}

const PAGED_TEXT = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join('\n')

test('Files wheel moves the selection inside the painted list and never reads the Host', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: manyFiles(200) }]), { pointerActions: true })
  h.setSize(100, 30)
  h.rows()
  const selectedRow = (): number => h.rows().findIndex(row => row.trimStart().startsWith('> file-'))
  assert.ok(selectedRow() > 0, 'fixture: the first file is selected')

  // One notch moves one entry, and a multi-line delta moves several at once.
  wheelAt(h.panel, wheelCell(4, selectedRow()), 1)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /file-001/)
  wheelAt(h.panel, wheelCell(4, selectedRow()), 3)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /file-004/)
  wheelAt(h.panel, wheelCell(4, selectedRow()), -2)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /file-002/)

  // A fast spin stays inside the list and keeps the selection VISIBLE.
  for (let step = 0; step < 20; step += 1) wheelAt(h.panel, wheelCell(4, 10), 6)
  const row = h.rows().find(row => row.trimStart().startsWith('> '))
  assert.match(row!, /file-12\d/, 'the selection moved far down the list')
  assert.ok(selectedRow() >= 0, 'the selection stayed visible after the spin')
  // Clamped at the last file, still visible.
  for (let step = 0; step < 30; step += 1) wheelAt(h.panel, wheelCell(4, 10), 6)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /file-199/)

  assert.deepEqual(h.readCalls(), [], 'a Files wheel never reads the Host')
  assert.equal(h.statCalls(), 0, 'a Files wheel never stats the Host')
})

test('a filtered wheel only moves the filtered selection; the query and seat stay', () => {
  const h = harness(ONE_TURN)
  h.setSize(100, 30)
  h.rows()
  h.type('/')
  h.type('report')
  const rows = h.rows()
  const filterRow = rows.findIndex(row => row.includes('Filter: report'))
  assert.ok(filterRow === 1, `fixture: the filter row is painted: ${rows.join('\n')}`)
  const firstMatch = rows.findIndex((row, y) => y > filterRow && row.trimStart().startsWith('> '))
  assert.ok(firstMatch > filterRow, rows.join('\n'))

  const wheelRow = rows.findIndex((row, y) => y > firstMatch && /report-(final|index)/.test(row))
  wheelAt(h.panel, wheelCell(4, wheelRow), 1)
  const after = h.rows()
  assert.ok(after[filterRow]!.includes('Filter: report'), 'the wheel never types into the query')
  assert.match(after.find(row => row.trimStart().startsWith('> '))!, /report-(final|index)/,
    'the wheel moved the filtered selection')
  // Back up, then Esc still clears the query.
  wheelAt(h.panel, wheelCell(4, wheelRow - 1), -1)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /report\.md/)
  h.type('esc')
  assert.ok(!h.rows().some(row => row.includes('Filter: report')), 'Esc still clears the query')
})

test('wide side-pane, header and footer wheels never move the Files selection', () => {
  const h = harness(snapshotOf([{ turn: 1, files: manyFiles(40) }]))
  h.setSize(160, 50)
  const rows = h.rows()
  const firstListRow = rows.findIndex(row => row.includes('file-000.txt'))
  assert.ok(firstListRow > 1, rows.join('\n'))
  assert.ok(firstListRow < rows.length - 1, 'fixture: painted list rows exist')
  // 160x50 grants a two-column frame: the list column ends before the side pane.
  const sideColumn = contentWidth(160, 50) - 20
  assert.ok(sideColumn > Math.floor((contentWidth(160, 50) - 3) * 0.58), 'fixture: the column is in the side pane')

  wheelAt(h.panel, wheelCell(sideColumn, firstListRow, 160, 50), 3)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /file-000/,
    'a side-pane wheel never moves the selection')
  wheelAt(h.panel, wheelCell(4, 0, 160, 50), 3)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /file-000/, 'the header is inert')
  wheelAt(h.panel, wheelCell(4, rows.length - 1, 160, 50), 3)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /file-000/, 'the footer is inert')

  // Positive control: the painted list column really scrolls.
  const result = wheelAt(h.panel, wheelCell(4, firstListRow, 160, 50), 1)
  assert.equal(result?.handled, true)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /file-001/)
})

test('Turns wheel moves the uncommitted cursor only; Enter commits and Esc restores', () => {
  const h = harness(manyTurns(30))
  h.setSize(100, 30)
  h.type('T')
  let rows = h.rows()
  const firstTurnRow = rows.findIndex(row => row.trimStart().startsWith('> Turn '))
  assert.ok(firstTurnRow > 0, rows.join('\n'))

  wheelAt(h.panel, wheelCell(2, firstTurnRow), 1)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /> Turn 99\b/)
  wheelAt(h.panel, wheelCell(2, firstTurnRow), 2)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /> Turn 97\b/)
  // Chrome and blank rows are consumed but inert.
  wheelAt(h.panel, wheelCell(2, 0), 3)
  wheelAt(h.panel, wheelCell(2, rows.length - 1), 3)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /> Turn 97\b/)

  // Enter commits; the wheel never did.
  h.type('enter')
  assert.equal(h.panel.currentPage(), 'files')
  assert.deepEqual(h.panel.selection(), { turn: 97, path: '/ws/turn-97.md' })

  // Esc returns the ORIGINAL Turn — a wheel cursor move is not a commitment.
  const esc = harness(manyTurns(30))
  esc.setSize(100, 30)
  esc.type('T')
  esc.rows()
  wheelAt(esc.panel, wheelCell(2, 2), 3)
  wheelAt(esc.panel, wheelCell(2, 3), 1)
  esc.type('esc')
  assert.equal(esc.panel.currentPage(), 'files')
  assert.deepEqual(esc.panel.selection(), { turn: 100, path: '/ws/turn-100.md' })

  // A short list clamps at both ends.
  const short = harness(snapshotOf([{ turn: 5, files: ['/ws/a.md'] }, { turn: 3, files: ['/ws/b.md'] }]))
  short.setSize(100, 30)
  short.type('T')
  short.rows()
  wheelAt(short.panel, wheelCell(2, 2), 5)
  assert.match(short.rows().find(row => row.trimStart().startsWith('> '))!, /> Turn 3\b/, 'clamped at the last Turn')
  wheelAt(short.panel, wheelCell(2, 2), -5)
  assert.match(short.rows().find(row => row.trimStart().startsWith('> '))!, /> Turn 5\b/, 'clamped at the first Turn')
})

test('Details wheel scrolls the wrapped body; title and footer are inert; metadata never reads', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/report.md'] }]), {
    pointerActions: true,
    autoResolve: {
      stat: { version: 'v1', bytes: 400 },
      offset: 1,
      limit: DELIVERED_FILE_PAGE_LINES,
      text: PAGED_TEXT(40, 'line'),
      lines: 40,
      eof: false,
    },
  })
  h.setSize(100, 30)
  h.type('enter')
  await h.waitForPreviewState('text-page')
  let rows = h.rows()
  // A fresh text page scrolls to the CONTENT (previewStart), so the visible
  // body starts at the first preview row; the prefix rows sit above it.
  assert.match(rows[1]!, /line 0/, 'fixture: the body starts at the preview content')
  const footerRow = rows.length - 1

  // Two wheel steps move the window over the physical (wrapped) rows.
  wheelAt(h.panel, wheelCell(4, 5), 2)
  rows = h.rows()
  assert.match(rows[1]!, /line 2/, 'the window advanced over the physical rows')
  assert.match(rows[2]!, /line 3/, 'the projection keeps every physical row in order')
  wheelAt(h.panel, wheelCell(4, 5), -2)
  assert.match(h.rows()[1]!, /line 0/, 'the wheel returned to the top')
  // Walking the prefix: two more wheels up reach the Host path; title and
  // footer never scroll.
  wheelAt(h.panel, wheelCell(4, 5), -1)
  wheelAt(h.panel, wheelCell(4, 5), -1)
  assert.match(h.rows()[1]!, /Host: \/ws\/report\.md/, 'the wheel walks the prefix rows')
  wheelAt(h.panel, wheelCell(4, 0), 2)
  wheelAt(h.panel, wheelCell(4, footerRow), 2)
  assert.match(h.rows()[1]!, /Host: \/ws\/report\.md/, 'title/footer wheels are inert')

  assert.deepEqual(h.readCalls(), [{ offset: 1, limit: DELIVERED_FILE_PAGE_LINES }],
    'in-window wheel scrolling never reads the Host again')

  // A metadata page scrolls nothing and reads nothing.
  const binary = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/pic.png'] }]), {
    pointerActions: true,
    autoResolve: { stat: { version: 'v1', bytes: 9 }, offset: 1, limit: DELIVERED_FILE_PAGE_LINES, text: '', lines: 0, eof: true },
  })
  binary.setSize(100, 30)
  binary.type('enter')
  await binary.waitForPreviewState('metadata')
  binary.rows()
  wheelAt(binary.panel, wheelCell(4, 5), 2)
  assert.deepEqual(binary.readCalls(), [], 'a metadata wheel never reads')
  assert.ok(binary.rows().some(row => row.includes('Preview unavailable')), 'the metadata page still paints')
})

test('a confirmed Details bottom wheel reads exactly ONE next page; pending and EOF never re-read', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/report.md'] }]), { pointerActions: true })
  h.setSize(100, 30)
  h.type('enter')
  h.resolveStat({ version: 'v1', bytes: 720 })
  await h.waitForPreviewState('loading-page')
  h.resolveRead({
    stat: { version: 'v1', bytes: 720 }, offset: 1, limit: DELIVERED_FILE_PAGE_LINES,
    text: PAGED_TEXT(120, 'row'), lines: 120, eof: false,
  })
  await h.waitForPreviewState('text-page')
  h.rows()

  // 100x30 grants 18 body rows and the fresh window starts at the 2-row
  // prefix: 102 rows to the edge, so 17 six-row wheels land ON the edge
  // (move, no read) and the NEXT wheel reads.
  for (let step = 0; step < 17; step += 1) wheelAt(h.panel, wheelCell(4, 5), 6)
  assert.deepEqual(h.readCalls().slice(1), [], 'landing on the edge only moves')
  const edge = wheelAt(h.panel, wheelCell(4, 5), 6)
  assert.equal(edge?.handled, true)
  assert.deepEqual(h.readCalls().slice(1), [{ offset: 1 + DELIVERED_FILE_PAGE_LINES, limit: DELIVERED_FILE_PAGE_LINES }],
    'the confirmed bottom reads the NEXT 120-line page exactly once')

  // A pending request swallows further wheels without a second read.
  wheelAt(h.panel, wheelCell(4, 5), 6)
  wheelAt(h.panel, wheelCell(4, 5), 6)
  assert.equal(h.readCalls().length, 2, 'a pending read never duplicates')

  // An EOF page is a definite end: wheels at its bottom stay silent.
  h.resolveRead({
    stat: { version: 'v1', bytes: 726 }, offset: 121, limit: DELIVERED_FILE_PAGE_LINES,
    text: 'tail', lines: 1, eof: true,
  })
  await h.waitForPreviewState('text-page')
  h.rows()
  for (let step = 0; step < 3; step += 1) wheelAt(h.panel, wheelCell(4, 5), 6)
  assert.equal(h.readCalls().length, 2, 'EOF wheels never re-read')
})

test('a Details wheel reads the previous page only from the very top; the first window never reads back', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/report.md'] }]), { pointerActions: true })
  h.setSize(100, 30)
  h.type('enter')
  h.resolveStat({ version: 'v1', bytes: 720 })
  await h.waitForPreviewState('loading-page')
  // The Host reply owns the truth: this mount presents the offset-121 window.
  h.resolveRead({
    stat: { version: 'v1', bytes: 720 }, offset: 121, limit: DELIVERED_FILE_PAGE_LINES,
    text: PAGED_TEXT(120, 'next'), lines: 120, eof: false,
  })
  await h.waitForPreviewState('text-page')
  h.rows()

  // From the window top the wheel first walks the painted prefix rows (Host
  // path, blank) — two local rows, no Host read.
  for (let step = 0; step < 2; step += 1) wheelAt(h.panel, wheelCell(4, 5), -1)
  assert.deepEqual(h.readCalls().slice(1), [], 'walking the prefix never reads')
  // At the VERY top, the previous page — exactly once.
  wheelAt(h.panel, wheelCell(4, 5), -1)
  assert.deepEqual(h.readCalls().slice(1), [{ offset: 1, limit: DELIVERED_FILE_PAGE_LINES }],
    'the confirmed top reads the previous page')
  // A pending read is not duplicated.
  wheelAt(h.panel, wheelCell(4, 5), -1)
  assert.equal(h.readCalls().length, 2, 'no duplicate while pending')
})

test('a next page that changed version restarts at the first window through the wheel', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/report.md'] }]), { pointerActions: true })
  h.setSize(100, 30)
  h.type('enter')
  h.resolveStat({ version: 'v1', bytes: 720 })
  await h.waitForPreviewState('loading-page')
  h.resolveRead({
    stat: { version: 'v1', bytes: 720 }, offset: 1, limit: DELIVERED_FILE_PAGE_LINES,
    text: PAGED_TEXT(120, 'v1row'), lines: 120, eof: false,
  })
  await h.waitForPreviewState('text-page')
  h.rows()
  for (let step = 0; step < 18; step += 1) wheelAt(h.panel, wheelCell(4, 5), 6)
  assert.deepEqual(h.readCalls().slice(1), [{ offset: 121, limit: DELIVERED_FILE_PAGE_LINES }])
  // The Host answers with a DIFFERENT version: restart, never splice.
  h.resolveRead({
    stat: { version: 'v2', bytes: 400 }, offset: 121, limit: DELIVERED_FILE_PAGE_LINES,
    text: PAGED_TEXT(120, 'v2row'), lines: 120, eof: false,
  })
  await h.waitForPreviewState('loading-stat')
  h.resolveStat({ version: 'v2', bytes: 400 })
  await h.waitForPreviewState('loading-page')
  h.resolveRead({
    stat: { version: 'v2', bytes: 400 }, offset: 1, limit: DELIVERED_FILE_PAGE_LINES,
    text: PAGED_TEXT(120, 'v2row'), lines: 120, eof: false,
  })
  await h.waitForPreviewState('text-page')
  assert.deepEqual(h.readCalls().slice(2), [{ offset: 1, limit: DELIVERED_FILE_PAGE_LINES }],
    'the restart re-reads the FIRST window')
  assert.equal(h.statCalls(), 2, 'the restart stats again through the same owner')
  const text = h.rows().join('\n')
  assert.ok(text.includes('File changed; preview restarted'), 'the restart notice is painted')
  assert.ok(!text.includes('v1row'), 'no v1 text splices into the v2 preview')
})

test('wheel steps on a near-limit line stay lazily wrapped at narrow widths', async () => {
  const longLine = 'x'.repeat(2 * 1024 * 1024 - 16)
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/huge.txt'] }]), {
    pointerActions: true,
    autoResolve: {
      stat: { version: 'v1', bytes: longLine.length },
      offset: 1, limit: DELIVERED_FILE_PAGE_LINES, text: longLine, lines: 1, eof: false,
    },
  })
  h.setSize(40, 16)
  h.type('enter')
  await h.waitForPreviewState('text-page')
  interface WrapProbe { readonly wrappedSourceLines: number; readonly wrappedPhysicalRows: number }
  const probe = (): number => (h.panel as unknown as WrapProbe).wrappedSourceLines
  const physical = (): number => (h.panel as unknown as WrapProbe).wrappedPhysicalRows
  h.rows()
  const afterOpen = probe()

  for (let step = 0; step < 20; step += 1) wheelAt(h.panel, wheelCell(4, 5, 40, 16), 3)
  assert.equal(probe(), afterOpen, 'wheeling never re-wraps the source line')
  assert.ok(physical() <= 128, `wheel materialisation stays viewport-bounded (${physical()})`)

  // A narrower terminal re-derives the wrap once and keeps wheeling bounded.
  h.setSize(16, 14)
  h.rows()
  for (let step = 0; step < 10; step += 1) wheelAt(h.panel, wheelCell(4, 5, 16, 14), 3)
  assert.equal(probe(), 1, 'the width change wrapped the line exactly once')
  assert.ok(physical() <= 256, `narrow wheeling stays bounded (${physical()})`)
  assert.deepEqual(h.readCalls(), [{ offset: 1, limit: 120 }], 'an unfinished wrapped line never triggers the next Host window')
})

test('a non-zero wheel revokes the held press; a zero wheel keeps the gesture', async () => {
  const cell = { ...wheelCell(4, 5) }

  // A held [Back] survives NOTHING but a zero wheel: any real wheel cancels it.
  const back = harness(ONE_TURN)
  back.setSize(100, 30)
  back.type('enter')
  const backRows = back.rows()
  const backCell = { x: backRows.at(-1)!.indexOf('[Back]') + 2, y: backRows.length - 1, width: cell.width, height: cell.height }
  back.panel.handleMouse({ type: 'press', button: 'left', x: backCell.x, y: backCell.y, screenX: backCell.x, screenY: backCell.y, width: backCell.width, height: backCell.height, shift: false, alt: false, ctrl: false })
  wheelAt(back.panel, wheelCell(4, 5), 1)
  assert.equal(clickOnly(back.panel, backCell), undefined, 'the revoked press cannot run [Back]')
  assert.equal(back.panel.currentPage(), 'details')

  // A ZERO wheel is a strict no-op: the gesture survives and the click runs.
  const zero = harness(ONE_TURN)
  zero.setSize(100, 30)
  zero.type('enter')
  const zeroRows = zero.rows()
  const zeroCell = { x: zeroRows.at(-1)!.indexOf('[Back]') + 2, y: zeroRows.length - 1, width: cell.width, height: cell.height }
  zero.panel.handleMouse({ type: 'press', button: 'left', x: zeroCell.x, y: zeroCell.y, screenX: zeroCell.x, screenY: zeroCell.y, width: zeroCell.width, height: zeroCell.height, shift: false, alt: false, ctrl: false })
  assert.equal(wheelAt(zero.panel, wheelCell(4, 5), 0), undefined, 'a zero wheel is unhandled')
  assert.equal(clickOnly(zero.panel, zeroCell)?.handled, true, 'the zero wheel kept the gesture')
  assert.equal(zero.panel.currentPage(), 'files', 'the preserved click really ran [Back]')

  // The same revocation covers a wheel over chrome and a boundary no-move.
  const chrome = harness(ONE_TURN)
  chrome.setSize(100, 30)
  chrome.rows()
  const verbRows = chrome.rows()
  const verbColumn = verbRows.find(row => row.includes('report-final.md'))!.lastIndexOf('Details') + 2
  const verbRow = verbRows.findIndex(row => row.includes('report-final.md'))
  chrome.panel.handleMouse({ type: 'press', button: 'left', x: verbColumn, y: verbRow, screenX: verbColumn, screenY: verbRow, width: cell.width, height: cell.height, shift: false, alt: false, ctrl: false })
  wheelAt(chrome.panel, wheelCell(4, verbRows.length - 1), 1) // footer wheel
  assert.equal(clickOnly(chrome.panel, { x: verbColumn, y: verbRow, width: cell.width, height: cell.height }), undefined,
    'a chrome wheel also revokes the held verb press')
  assert.equal(chrome.panel.currentPage(), 'files')

  // A held Turns row cannot commit across a wheel; a FRESH click still works.
  const turns = harness(manyTurns(4))
  turns.setSize(100, 30)
  turns.type('T')
  const turnRows = turns.rows()
  const turnRow = turnRows.findIndex(row => row.includes('Turn 99'))
  turns.panel.handleMouse({ type: 'press', button: 'left', x: 2, y: turnRow, screenX: 2, screenY: turnRow, width: cell.width, height: cell.height, shift: false, alt: false, ctrl: false })
  wheelAt(turns.panel, wheelCell(4, 5), 1)
  assert.equal(clickOnly(turns.panel, { x: 2, y: turnRow, width: cell.width, height: cell.height }), undefined,
    'the revoked press cannot commit the Turn')
  assert.equal(turns.panel.currentPage(), 'turns')
  const fresh = clickAt(turns.panel, { x: 2, y: turnRow, width: cell.width, height: cell.height })
  assert.equal(fresh?.handled, true, 'a fresh press/click after the wheel still works')
  assert.deepEqual(turns.panel.selection(), { turn: 99, path: '/ws/turn-99.md' })

  // A fresh [Close] after a revoking wheel still closes.
  const close = harness(ONE_TURN)
  close.setSize(100, 30)
  const closeRows = close.rows()
  const closeCell = { x: closeRows.at(-1)!.indexOf('[Close]') + 2, y: closeRows.length - 1, width: cell.width, height: cell.height }
  close.panel.handleMouse({ type: 'press', button: 'left', x: closeCell.x, y: closeCell.y, screenX: closeCell.x, screenY: closeCell.y, width: closeCell.width, height: closeCell.height, shift: false, alt: false, ctrl: false })
  wheelAt(close.panel, wheelCell(4, 5), -1)
  assert.equal(clickOnly(close.panel, closeCell), undefined)
  assert.equal(clickAt(close.panel, closeCell)?.handled, true)
  assert.equal(close.closes(), 1, 'the fresh click closed the overlay')
})

test('stale frames, disposed panels and surfaces without the pointer never scroll', async () => {
  const h = harness(snapshotOf([{ turn: 1, files: manyFiles(10) }]))
  h.setSize(100, 30)
  h.rows()
  // A wheel carrying the geometry of a DIFFERENT painted size is dead.
  assert.equal(wheelAt(h.panel, { x: 4, y: 2, width: contentWidth(80, 24), height: contentRows(80, 24) }, 1), undefined)
  assert.match(h.rows().find(row => row.trimStart().startsWith('> '))!, /file-000/, 'the stale wheel scrolled nothing')

  const disposed = harness(ONE_TURN)
  disposed.setSize(100, 30)
  disposed.rows()
  disposed.panel.dispose()
  assert.equal(wheelAt(disposed.panel, wheelCell(4, 2), 1), undefined, 'a disposed panel never scrolls')

  const unowned = previewHarness(snapshotOf([{ turn: 1, files: manyFiles(10) }]), { pointerActions: false })
  unowned.setSize(100, 30)
  unowned.rows()
  assert.equal(wheelAt(unowned.panel, wheelCell(4, 2), 1), undefined, 'no pointer owner, no wheel claim')
  assert.deepEqual(unowned.readCalls(), [], 'and no Host read')
})

test('wheel magnitude rounds up and caps at the painted body; empty filters keep no selection', () => {
  const h = harness(snapshotOf([{ turn: 1, files: manyFiles(200) }]))
  const rows = h.rows()
  wheelAt(h.panel, wheelCell(4, 2), 1.2)
  assert.equal(h.panel.selection().path, manyFiles(3)[2])
  wheelAt(h.panel, wheelCell(4, 2), 10_000)
  assert.equal(h.panel.selection().path, manyFiles(200)[2 + rows.length - 3], 'one event cannot move beyond the body budget')
  h.type('/')
  h.type('no-match')
  h.rows()
  wheelAt(h.panel, wheelCell(4, 2), 3)
  assert.equal(h.panel.selection().path, undefined)
  assert.ok(h.rows()[1]!.includes('no-match'), 'the query and filter seat stay unchanged')
})

test('all held actions cancel on inert, boundary and stale wheels, then accept a fresh click', () => {
  for (const label of ['[Close]', 'Details', '[Back]', '[Copy path]', 'Turn 99']) {
    for (const location of ['header', 'boundary', 'stale']) {
      const h = harness(label === 'Turn 99' ? manyTurns(4) : ONE_TURN)
      if (label === '[Back]' || label === '[Copy path]') h.type('enter')
      if (label === 'Turn 99') h.type('T')
      const rows = h.rows()
      const y = rows.findIndex(row => row.includes(label))
      assert.ok(y >= 0, `${label} is painted`)
      const cell = wheelCell(rows[y]!.indexOf(label) + 2, y)
      h.panel.handleMouse({ ...cell, screenX: cell.x, screenY: y, type: 'press', button: 'left', shift: false, alt: false, ctrl: false })
      const page = h.panel.currentPage()
      const wheel = location === 'stale' ? { ...wheelCell(4, 2), width: cell.width + 1 }
        : wheelCell(4, location === 'header' ? 0 : 2)
      wheelAt(h.panel, wheel, -1)
      assert.equal(clickOnly(h.panel, cell), undefined, `${label}: ${location} cancels the old click`)
      assert.equal(h.panel.currentPage(), page)
      assert.equal(h.closes(), 0)
      assert.deepEqual(h.copied(), [])
      assert.equal(clickAt(h.panel, cell)?.handled, true, `${label}: a fresh gesture still works`)
    }
  }
})

test('Details wheel advances wrapped physical rows rather than source lines', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/wrapped.txt'] }]), {
    pointerActions: true,
    autoResolve: { stat: { version: 'v1' }, offset: 1, limit: 120,
      text: `alpha-${'a'.repeat(1000)}\nbeta`, lines: 2, eof: true },
  })
  h.setSize(40, 16)
  h.type('enter')
  await h.waitForPreviewState('text-page')
  assert.match(h.rows()[1]!, /^alpha-/)
  wheelAt(h.panel, wheelCell(4, 3, 40, 16), 1)
  assert.match(h.rows()[1]!, /^a+$/, 'one wheel moves inside the first wrapped source line')
  wheelAt(h.panel, wheelCell(4, 3, 40, 16), -1)
  assert.match(h.rows()[1]!, /^alpha-/)
  assert.equal(h.readCalls().length, 1)
})

test('loading, metadata, failure and idle wheels scroll local metadata without reading', async () => {
  const { SupersededReadError } = await import('../../src/runtime/read-error.ts')
  for (const kind of ['loading-stat', 'loading-page', 'metadata', 'failure', 'idle'] as const) {
    const h = previewHarness(snapshotOf([{ turn: 1, files: [{
      path: kind === 'metadata' ? '/ws/report.png' : '/ws/report.md',
      description: PAGED_TEXT(40, 'metadata'),
    }] }]), { pointerActions: true })
    h.type('enter')
    if (kind === 'loading-page' || kind === 'metadata') h.resolveStat({ version: 'v1' })
    if (kind === 'failure') h.rejectStat(new DeliveredFileReadError('not-found', 'refused'))
    if (kind === 'idle') h.rejectStat(new SupersededReadError('generation'))
    await h.waitForPreviewState(kind)
    const before = h.rows()
    const reads = h.readCalls().length
    for (let notch = 0; notch < 8; notch += 1) wheelAt(h.panel, wheelCell(4, 3), 4)
    assert.notDeepEqual(h.rows(), before, `${kind}: local metadata really scrolls`)
    assert.equal(h.readCalls().length, reads, `${kind}: no additional Host read`)
    assert.equal(h.preview().kind, kind)
    h.panel.dispose()
  }
})

test('an empty EOF first window ignores wheels in both directions', async () => {
  const h = previewHarness(ONE_TURN, {
    pointerActions: true,
    autoResolve: { stat: { version: 'v1' }, offset: 1, limit: 120, text: '', lines: 0, eof: true },
  })
  h.type('enter')
  await h.waitForPreviewState('text-page')
  h.rows()
  for (const direction of [1, -1, 1, -1]) wheelAt(h.panel, wheelCell(4, 3), direction * 100)
  assert.deepEqual(h.readCalls(), [{ offset: 1, limit: 120 }])
  assert.ok(h.rows().some(row => row.includes('(end of file)')))
})
