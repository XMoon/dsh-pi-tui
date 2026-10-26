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
import { DeliveredFilesPanel } from '../../src/tui/deliverables/delivered-files-panel.ts'

/** Friendly key names → the real terminal bytes the component matches. */
const KEY = {
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  esc: '\x1b',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  tab: '\t',
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
    // The production chain: the overlay's maxHeight is min(24, rows - 2) and
    // the frame grants the panel its content rows (maxHeight - 2 borders).
    const maxHeight = Math.min(24, Math.max(1, height - 2))
    panel.setMaxRows(Math.max(1, maxHeight - 2))
    return panel.render(width - 4)
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
  assert.ok(rows.at(-1)!.includes('C Copy path'), `the action bar names the real key: ${rows.at(-1)}`)
  assert.ok(rows.at(-1)!.includes('Esc Back'))
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
  assert.equal(first.length, 22, 'the panel fills its granted rows (24-row overlay cap minus borders)')
  assert.ok(!first.join('\n').includes('file-200.md'), 'older rows are not painted')
  for (let press = 0; press < 40; press += 1) h.type('pageDown')
  const last = h.rows()
  assert.ok(last.join('\n').includes('file-200.md'), 'PageDown reaches the last file')
  assert.equal(h.rows().length, 22)
})

test('40x16, 72x24, 100x30 and 140x40 stay inside their box and keep the exit visible', () => {
  const h = harness(snapshotOf([{ turn: 7, files: ['/ws/a.md', '/ws/b.md', '/ws/c.md'] }]))
  for (const [columns, rows] of [[40, 16], [64, 16], [72, 24], [100, 30], [140, 40]] as const) {
    h.setSize(columns, rows)
    const painted = h.rows()
    assert.equal(painted.length, Math.min(22, rows - 4), `${columns}x${rows}: the panel fills its granted rows`)
    assertNoOverflow(painted, columns - 4)
    assert.match(painted[0]!, /Delivered files · Turn 7/)
    assert.ok(painted.at(-1)!.includes('Esc Close'), `${columns}x${rows}: the exit hint stays visible`)
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

test('a wide pane shows the declared metadata without any Host read', () => {
  const h = harness(snapshotOf([{
    turn: 2,
    files: [{ path: '/ws/docs/report.md', description: 'Final analysis report' }],
  }]))
  h.setSize(140, 40)
  const rows = h.rows()
  const text = rows.join('\n')
  assert.ok(text.includes('/ws/docs/report.md'), text)
  assert.ok(text.includes('Final analysis report'), text)
  assert.ok(text.includes('No Host read in PR1'), 'PR1 never claims a preview')
})

test('a list click SELECTS and only the painted Details verb opens the page', () => {
  const h = harness(ONE_TURN)
  h.setSize(100, 30)
  const rows = h.rows()
  const secondRow = rows.findIndex(row => row.includes('report-final.md'))
  assert.ok(secondRow > 0)
  // A list click (left of the verb) selects without opening.
  h.panel.handleMouse({
    type: 'click', button: 'left', x: 4, y: secondRow, screenX: 4, screenY: secondRow,
    width: 96, height: rows.length, shift: false, alt: false, ctrl: false,
  })
  assert.equal(h.panel.currentPage(), 'files')
  assert.deepEqual(h.panel.selection(), { turn: 24, path: '/ws/output/report-final.md' })

  // The painted `Details` verb opens THAT row.
  const verbColumn = rows[secondRow]!.lastIndexOf('Details') + 2
  const handled = h.panel.handleMouse({
    type: 'click', button: 'left', x: verbColumn, y: secondRow, screenX: verbColumn, screenY: secondRow,
    width: 96, height: rows.length, shift: false, alt: false, ctrl: false,
  })
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
  const rejected = h.panel.handleMouse({
    type: 'click', button: 'left', x: 4, y: secondRow, screenX: 4, screenY: secondRow,
    width: 76, height: 20, shift: false, alt: false, ctrl: false,
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
