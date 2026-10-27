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
  assert.ok(rows.at(-1)!.includes('Shift+C Copy path'), `the action bar names the real shifted chord: ${rows.at(-1)}`)
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
    assert.equal(painted.length, Math.min(22, rows - 4), `${label}: fills the granted rows`)
    assertNoOverflow(painted, columns - 4)
    // The action bar IS the last painted row of the panel.
    const bar = painted.at(-1)!
    assert.ok(bar.includes('Esc'), `${label}: the action bar is the last row: ${JSON.stringify(bar)}`)
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
  const listWidth = Math.max(24, Math.floor(((140 - 4) - 3) * 0.58))
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
  const click = (x: number) => h.panel.handleMouse({
    type: 'click', button: 'left', x, y: row, screenX: x, screenY: row,
    width: painted.length, height: raw.length, shift: false, alt: false, ctrl: false,
  })
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
  const handled = h.panel.handleMouse({
    type: 'click', button: 'left', x: verbStart + 1, y: firstRow, screenX: verbStart + 1, screenY: firstRow,
    width: raw[firstRow]!.length, height: raw.length, shift: false, alt: false, ctrl: false,
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
  h.panel.handleMouse({
    type: 'click', button: 'left', x: freshVerb + 1, y: row, screenX: freshVerb + 1, screenY: row,
    width: repainted[row]!.length, height: repainted.length, shift: false, alt: false, ctrl: false,
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
  const handled = h.panel.handleMouse({
    type: 'click', button: 'left', x: verbStart + 1, y: row, screenX: verbStart + 1, screenY: row,
    width: raw[row]!.length, height: raw.length, shift: false, alt: false, ctrl: false,
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
  let statCount = 0
  const readCalls: { offset: number; limit: number }[] = []
  const diagnostics: string[] = []
  const pendingStats: Array<{ resolve(stat: DeliveredFileStat): void; reject(error: unknown): void }> = []
  const pendingReads: Array<{ resolve(page: DeliveredFilePage): void; reject(error: unknown): void }> = []
  const panel = new DeliveredFilesPanel({
    snapshot,
    ...(options.initial === undefined ? {} : { initial: options.initial }),
    pointerActions: options.pointerActions === true,
    requestRender: () => { renderCount += 1 },
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
  // Honor `setSize` exactly like the plain harness: the production chain grants
  // `min(24, rows - 2) - 2` content rows and the frame renders `columns - 4`.
  let width = 100
  let height = 30
  const paint = (): readonly string[] => {
    const maxHeight = Math.min(24, Math.max(1, height - 2))
    panel.setMaxRows(Math.max(1, maxHeight - 2))
    return panel.render(width - 4)
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
  }
}

const settlePreview = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

test('Enter Preview stats first, then reads exactly ONE 120-line page', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/report.md'] }]))
  h.type('enter')
  assert.equal(h.preview().kind, 'loading-stat', 'the FIRST Host call is the stat')
  assert.deepEqual(h.readCalls(), [], 'nothing is read before the metadata lands')
  assert.ok(h.rows().some(row => row.includes('Loading…')))

  h.resolveStat({ version: 'v1', bytes: 42 })
  await settlePreview()
  assert.deepEqual(h.readCalls(), [{ offset: 1, limit: 120 }], 'one page, the fixed window')
  assert.equal(h.preview().kind, 'loading-page')

  h.resolveRead({
    stat: { version: 'v1', bytes: 42 }, offset: 1, limit: 120,
    text: 'first line\nsecond line', lines: 2, eof: false,
  })
  await settlePreview()
  const rows = h.rows().join('\n')
  assert.ok(rows.includes('first line') && rows.includes('second line'), rows)
  assert.ok(rows.includes('/ws/report.md'), 'the declared Host path stays visible')
})

test('a known binary suffix shows metadata only and never reads', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/chart.png'] }]))
  h.type('enter')
  h.resolveStat({ version: 'v1', bytes: 900 })
  await settlePreview()
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
    await settlePreview()
    const rows = h.rows().join('\n')
    assert.ok(rows.includes(text), `${code}: ${rows}`)
    assert.ok(rows.includes('Shift+C Copy path'), `${code}: Copy stays available`)
    assert.equal(h.diagnostics().length, 0, `${code}: a classified refusal is not a diagnostic`)
  }
})

test('an unclassified failure is generic AND reported to diagnostics', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/report.md'] }]))
  h.type('enter')
  h.rejectStat(new Error('weird transport'))
  await settlePreview()
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
  await settlePreview()
  assert.equal(h.preview().kind, 'loading-stat',
    'the stale reply never becomes the state (only the CURRENT stat may paint)')
  assert.deepEqual(h.readCalls(), [], 'a stale metadata reply cannot start a read')
})

test('a changed version restarts the preview instead of splicing pages', async () => {
  const snapshot = snapshotOf([{ turn: 1, files: ['/ws/long.md'] }])
  const h = previewHarness(snapshot)
  h.type('enter')
  h.resolveStat({ version: 'v1', bytes: 10 })
  await settlePreview()
  h.resolveRead({ stat: { version: 'v1', bytes: 10 }, offset: 1, limit: 120, text: 'one', lines: 1, eof: false })
  await settlePreview()
  // Ask for the next page; the Host reports a NEW version for it.
  h.type('pageDown')
  h.type('pageDown')
  assert.deepEqual(h.readCalls().at(-1), { offset: 121, limit: 120 })
  h.resolveRead({ stat: { version: 'v2', bytes: 12 }, offset: 121, limit: 120, text: 'two', lines: 1, eof: true })
  await settlePreview()
  const rows = h.rows().join('\n')
  assert.ok(rows.includes('File changed; preview restarted'), rows)
  assert.ok(!rows.includes('two'), 'the other version is never spliced in')
})

test('an EOF page is a definite end, never a retry loop', async () => {
  const h = previewHarness(snapshotOf([{ turn: 1, files: ['/ws/short.md'] }]))
  h.type('enter')
  h.resolveStat({ version: 'v1' })
  await settlePreview()
  h.resolveRead({ stat: { version: 'v1' }, offset: 1, limit: 120, text: '', lines: 0, eof: true })
  await settlePreview()
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
  // A foreign pointer event is never claimed either.
  const handled = panel.handleMouse({
    type: 'click', button: 'left', x: 90, y: rows.findIndex(row => row.includes('a.md')),
    screenX: 90, screenY: 4, width: 96, height: rows.length,
    shift: false, alt: false, ctrl: false,
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
  await new Promise(resolve => setTimeout(resolve, 10))
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
  await new Promise(resolve => setTimeout(resolve, 20))
  interface WrapProbe { readonly wrappedSourceLines: number }
  const probe = (): number => (h.panel as unknown as WrapProbe).wrappedSourceLines

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

  // The rows really advanced: the viewport moved down within the wrapped line.
  const pageUp = h.rows()
  assert.ok(pageUp.length > 0)
  // A width change invalidates the cache (one fresh wrap of the same line).
  h.setSize(64, 16)
  h.rows()
  assert.equal(probe(), 1, 'a width change re-derives exactly one wrapped line')
})
