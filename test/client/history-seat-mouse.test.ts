/**
 * Phase 3B / B3-A — the History seat POINTER preflight and its regressions.
 *
 * A0 (the plan's mandatory preflight): the pinned `TuiAltScreen` must deliver
 * press / release / wheel / drag to the History component INSIDE the editor
 * seat through the EXISTING consumer dispatch — no parallel parser, no second
 * listener, no vendored-fork change. Every case here drives the REAL `TuiApp` +
 * `VirtualTerminal` + native SGR bytes; the panel is reached the same way a user
 * reaches it (Ctrl+R), and the assertions read the PAINTED frame.
 *
 * A0 ALSO pins the negative half of the contract: the regular main screen must
 * gain NO application mouse. Opening/closing History there writes no
 * mouse-enable sequence, and the panel refuses every pointer event.
 *
 * @module @xmoon76/dsh-pi-tui/test/history-seat-mouse
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import type { HistorySearchResult, HistorySearchSource } from '../../src/client/history/search.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const rawView = (vt: VirtualTerminal): string[] => vt.getViewport().map(stripTerminalSequences)
const view = (vt: VirtualTerminal): string => rawView(vt).join('\n')
const rowOf = (vt: VirtualTerminal, needle: string): number =>
  rawView(vt).findIndex(line => line.includes(needle))

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

/** One native SGR left-button gesture (1-based terminal cells). */
const press = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}M`)
}
const drag = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<32;${col + 1};${row + 1}M`)
}
const release = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<0;${col + 1};${row + 1}m`)
}
const wheelUp = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<64;${col + 1};${row + 1}M`)
}
const wheelDown = (vt: VirtualTerminal, row: number, col: number): void => {
  vt.sendInput(`\x1b[<65;${col + 1};${row + 1}M`)
}

function row(content: string, ts: number, cwd = '/work/a', id = content): HistorySearchResult {
  return { id, content, cwd, ts, sourceFile: '/a/h.jsonl', sourceByteOffset: 0 }
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly copied: string[]
  readonly notices: string[]
  /** The MUTABLE live result page the injected source returns. */
  readonly rows: HistorySearchResult[]
  /** EVERY terminal write chunk, in order (the mode-sequence witness). */
  readonly writes: string[]
}

/** The REAL app with a recording clipboard capability and an owned runner that
 *  really executes (so the payload chain stays real). The search source reads a
 *  mutable page, so a test can commit a DIFFERENT result set under the same
 *  painted cells. */
function startApp(rows: HistorySearchResult[], columns = 100, terminalRows = 30): Harness {
  const vt = new VirtualTerminal(columns, terminalRows)
  // Record the PHYSICAL byte stream the surface writes: the regular-root
  // negative must prove that no mouse mode was ever enabled, and the viewport
  // text alone cannot witness that.
  const writes: string[] = []
  const originalWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    writes.push(data)
    originalWrite(data)
  }
  const copied: string[] = []
  const notices: string[] = []
  const page = [...rows]
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: (_label, task, options) => {
      void Promise.resolve()
        .then(() => task())
        .then(result => options.onResult?.(result), error => options.onError?.(error))
    },
  }, {
    historySearchSource: { search: async () => ({ results: [...page], exhausted: true }) } satisfies HistorySearchSource,
    historySearchCwd: () => '/work/a',
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => true }),
    copySelection: async (text: string) => {
      copied.push(text)
      return true
    },
  })
  app.start()
  startedApps.add(app)
  const originalNotify = app.notify.bind(app)
  app.notify = (text: string, kind?: 'info' | 'error'): void => {
    notices.push(text)
    originalNotify(text, kind)
  }
  return { vt, app, copied, notices, rows: page, writes }
}

/** Trigger one more debounced search over the CURRENT page (the tests use the
 *  real keystroke path, never a private hook). `settleMs` covers the panel's
 *  75ms debounce plus the file-read turn. */
async function research(h: Harness, settleMs = 150): Promise<void> {
  h.vt.sendInput('x')
  await new Promise<void>(resolve => setTimeout(resolve, settleMs))
  await h.vt.waitForRender()
  await flush(2)
}

/** The painted column of the first occurrence of `needle` on one row. */
const colOf = (vt: VirtualTerminal, row: number, needle: string): number => {
  const index = rawView(vt)[row]?.indexOf(needle) ?? -1
  return index
}

/** Enter Transcript Fullscreen and open History through the real Ctrl+R. */
async function openFullscreenHistory(h: Harness): Promise<void> {
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  h.vt.sendInput('\x12')
  await h.vt.waitForRender()
  await flush(2)
}

test('A0 fullscreen seat preflight: the alt screen delivers press/click to a History result row (select only)', async () => {
  const h = startApp([row('alpha prompt', 3, '/work/a', 'id-a'), row('beta prompt', 2, '/work/a', 'id-b')])
  await openFullscreenHistory(h)
  const betaRow = rowOf(h.vt, 'beta prompt')
  assert.ok(betaRow >= 0, `the seat must paint the History results:\n${view(h.vt)}`)
  const betaCol = rawView(h.vt)[betaRow]!.indexOf('beta prompt')
  press(h.vt, betaRow, betaCol)
  release(h.vt, betaRow, betaCol)
  await h.vt.waitForRender()
  await flush(2)
  // ONE click selects and repaints the Preview; it NEVER accepts (no draft
  // write, no close).
  assert.ok(rawView(h.vt).some(line => line.startsWith('> ') && line.includes('beta prompt')),
    `the clicked row must become the selection:\n${view(h.vt)}`)
  assert.equal(h.app.getDraft(), '', 'a result click must never accept the entry into the editor')
  assert.ok(rowOf(h.vt, 'Preview') >= 0, 'the Preview must be painted')
})

test('A0 fullscreen seat preflight: wheel scrolls the region under the pointer only', async () => {
  const long = Array.from({ length: 200 }, (_, index) => `source line ${index}`).join('\n')
  const h = startApp([
    ...Array.from({ length: 20 }, (_, index) => row(`entry ${index}`, 30 - index, '/work/a', `id-${index}`)),
    row(long, 1, '/work/a', 'long'),
  ])
  await openFullscreenHistory(h)
  // Select the long entry through the list.
  const longRow = rowOf(h.vt, 'entry 0')
  assert.ok(longRow >= 0, `the list must paint:\n${view(h.vt)}`)
  h.vt.sendInput('\x1b[A') // up wraps to the LAST result (the long prompt)
  await h.vt.waitForRender()
  await flush(2)
  const headingBefore = rawView(h.vt).find(line => line.includes('Preview ') && line.includes('/')) ?? ''
  assert.ok(headingBefore.includes('1-'), `the Preview starts at its first row: ${headingBefore}`)
  // The FIRST Preview CONTENT row: the row directly under the painted heading
  // (the selected entry's own first line also appears in the list label, so the
  // row is located from the frame rather than by content).
  const previewRow = rowOf(h.vt, 'Preview ') + 1
  const listRow = rawView(h.vt).findIndex(line => /entry \d+/.test(line) && !line.startsWith('> '))
  assert.ok(rowOf(h.vt, 'source line 0') >= 0, `the Preview content must paint:\n${view(h.vt)}`)
  assert.ok(listRow >= 0, `the results list must paint:\n${view(h.vt)}`)
  const listSelectionBefore = rawView(h.vt).find(line => line.startsWith('> ')) ?? ''
  // Wheel over the PREVIEW scrolls only the Preview…
  wheelDown(h.vt, previewRow, 4)
  await h.vt.waitForRender()
  await flush(2)
  const headingAfter = rawView(h.vt).find(line => line.includes('Preview ') && line.includes('/')) ?? ''
  assert.notEqual(headingAfter, headingBefore, 'the Preview wheel must move the Preview viewport')
  assert.equal(rawView(h.vt).find(line => line.startsWith('> ')) ?? '', listSelectionBefore,
    'the Preview wheel must not move the results selection')
  // …and the wheel over the LIST moves only the selection.
  const previewAfterListWheel = rawView(h.vt).find(line => line.includes('Preview ') && line.includes('/')) ?? ''
  wheelDown(h.vt, listRow, 4)
  await h.vt.waitForRender()
  await flush(2)
  assert.notEqual(rawView(h.vt).find(line => line.startsWith('> ')) ?? '', listSelectionBefore,
    'the list wheel must move the results selection')
  assert.notEqual(rawView(h.vt).find(line => line.includes('Preview ') && line.includes('/')) ?? '',
    previewAfterListWheel, 'a NEW selected result resets the Preview to its top')
})

test('A0 fullscreen seat preflight: the Preview drag copies the exact original substring', async () => {
  const prompt = 'first line\nsecond line with trailing  \nthird'
  const h = startApp([row(prompt, 1, '/work/a', 'p1')])
  await openFullscreenHistory(h)
  // The row directly under the painted Preview heading.
  const first = rowOf(h.vt, 'Preview ') + 1
  assert.ok(rowOf(h.vt, 'first line') >= 0, `the Preview must paint the source:\n${view(h.vt)}`)
  // Drag from column 0 of the first source row to the end of "second" on the
  // next painted Preview row.
  press(h.vt, first, 0)
  drag(h.vt, first + 1, 5)
  release(h.vt, first + 1, 5)
  await h.vt.waitForRender()
  await flush(4)
  assert.deepEqual(h.copied, ['first line\nsecond'], 'the drag must copy the EXACT original substring')
  // The pointer gesture must not cost the tenant its keyboard ownership: the
  // panel is still the physical focus owner after a press/drag/release.
  h.vt.sendInput('z')
  await h.vt.waitForRender()
  await flush(2)
  assert.ok(rawView(h.vt).some(line => line.includes('Search: > z')),
    `the seat must keep the keyboard after a pointer gesture:\n${view(h.vt)}`)
})

test('A0 fullscreen seat preflight: a release after a resize never accepts (last-painted geometry fence)', async () => {
  const h = startApp([row('result A', 1, '/work/a', 'id-a')])
  await openFullscreenHistory(h)
  const rowA = rowOf(h.vt, 'result A')
  assert.ok(rowA >= 0, `result A must paint:\n${view(h.vt)}`)
  press(h.vt, rowA, 3)
  await h.vt.waitForRender()
  // A resize between press and release invalidates the painted frame entirely.
  h.vt.resize(90, 30)
  await h.vt.waitForRender()
  const newRowA = rowOf(h.vt, 'result A')
  assert.ok(newRowA >= 0, `result A must still paint after the resize:\n${view(h.vt)}`)
  release(h.vt, newRowA, 3)
  await h.vt.waitForRender()
  await flush(2)
  assert.equal(h.app.getDraft(), '', 'a release across a resize must never accept')
  assert.ok(rowOf(h.vt, 'Input History') >= 0, 'the seat stays open (no action fired)')
})

test('A0 fullscreen seat preflight: a result press resolves by ID, and a page that moved under it never transfers the selection', async () => {
  // press A → an async search replaces the page so the PRESSED CELL now holds B
  // (A moved to another row and stays selected by its stable id) → release+click
  // must not move the selection to B, and must not accept anything.
  const h = startApp([row('alpha prompt', 1, '/work/a', 'id-a'), row('extra prompt', 2, '/work/a', 'id-x')])
  await openFullscreenHistory(h)
  const pressedRow = rowOf(h.vt, 'alpha prompt')
  assert.ok(pressedRow >= 0, `alpha must paint:\n${view(h.vt)}`)
  press(h.vt, pressedRow, 4)
  await h.vt.waitForRender()
  assert.ok(rawView(h.vt).some(line => line.startsWith('> ') && line.includes('alpha prompt')),
    'the press selects the pressed result')
  // The page is REPLACED: BETA takes the pressed cells, alpha moves below it.
  h.rows.length = 0
  h.rows.push(row('BETA prompt', 9, '/work/a', 'id-b'), row('alpha prompt', 1, '/work/a', 'id-a'))
  await research(h)
  const betaRow = rowOf(h.vt, 'BETA prompt')
  const alphaRow = rowOf(h.vt, 'alpha prompt')
  assert.ok(betaRow >= 0 && alphaRow >= 0 && alphaRow > betaRow,
    `the replacement page must paint BETA above alpha:\n${view(h.vt)}`)
  const marker = (): string => rawView(h.vt).find(line => line.startsWith('> ')) ?? ''
  assert.ok(marker().includes('alpha prompt'), 'the stable id keeps the pressed result selected')
  // release + the synthesized click land on the SAME painted cell, now BETA.
  release(h.vt, betaRow, 4)
  await h.vt.waitForRender()
  await flush(2)
  assert.ok(marker().includes('alpha prompt'),
    `the click must not transfer the selection to whatever moved into the pressed cell:\n${view(h.vt)}`)
  assert.equal(h.app.getDraft(), '', 'a result click never accepts')
})

test('A0 negative: the regular main screen writes no mouse mode and honors no pointer action (H3A-16)', async () => {
  // TWO rows, so a pointer action that WERE interpreted would visibly move the
  // selection to the second one.
  const h = startApp([
    row('alpha prompt', 3, '/work/a', 'id-a'),
    row('beta prompt', 2, '/work/a', 'id-b'),
  ], 80, 24)
  await h.vt.waitForRender()
  h.writes.length = 0 // only the regular-root History section is asserted
  h.vt.sendInput('\x12')
  await h.vt.waitForRender()
  await flush(2)
  const alphaRow = rowOf(h.vt, 'alpha prompt')
  const betaRow = rowOf(h.vt, 'beta prompt')
  assert.ok(alphaRow >= 0 && betaRow >= 0, `History must open in the regular root:\n${view(h.vt)}`)
  // The seat is keyboard-only here: no mouse buttons, and the ordinary footer
  // region stays reachable.
  assert.equal(rowOf(h.vt, 'Copy all'), -1, 'the regular root must not paint fullscreen-only mouse buttons')
  const markerBefore = rawView(h.vt).find(line => line.startsWith('> ')) ?? ''
  assert.ok(markerBefore.includes('alpha prompt'), 'the first result is selected')
  // Send a REAL SGR press/click on the OTHER row: with no application mouse it
  // must change nothing at all.
  press(h.vt, betaRow, 4)
  release(h.vt, betaRow, 4)
  await h.vt.waitForRender()
  await flush(2)
  assert.equal(rawView(h.vt).find(line => line.startsWith('> ')) ?? '', markerBefore,
    'a regular-root SGR click must not move the History selection')
  assert.ok(rowOf(h.vt, 'Input History') >= 0, 'the click must not close the seat')
  assert.equal(h.app.getDraft(), '', 'a regular-root press must never accept')
  // NO application mouse mode was ever enabled (1000/1002/1003/1006), and the
  // regular root never entered the alternate screen: the terminal keeps its own
  // selection/scrollback and its native mouse reporting.
  const mouseMode = /\x1b\[\?100[0236][hl]/
  const altScreen = /\x1b\[\?1049[hl]/
  const offending = h.writes.filter(chunk => mouseMode.test(chunk) || altScreen.test(chunk))
  assert.deepEqual(offending, [],
    `the regular root must write no mouse/alternate-screen mode:\n${JSON.stringify(offending)}`)
  // Keyboard actions still work in the same section.
  h.vt.sendInput('a')
  await h.vt.waitForRender()
  assert.ok(rawView(h.vt).some(line => line.includes('Search: > a')),
    `the regular-root History stays fully keyboard-driven:\n${view(h.vt)}`)
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.ok(rowOf(h.vt, 'Input History') < 0, 'Esc must still close the regular-root History')
})

test('A0 fullscreen actions: Copy All [Alt+C] copies the EXACT entry bytes (newline/CJK/trailing spaces)', async () => {
  const prompt = '  leading\n中文行 with trailing  \nlast'
  const h = startApp([row(prompt, 1, '/work/a', 'p1')])
  await openFullscreenHistory(h)
  const headingRow = rowOf(h.vt, 'Copy All [Alt+C]')
  assert.ok(headingRow >= 0, `the action heading must paint:\n${view(h.vt)}`)
  const col = colOf(h.vt, headingRow, 'Copy All [Alt+C]')
  press(h.vt, headingRow, col + 1)
  release(h.vt, headingRow, col + 1)
  await h.vt.waitForRender()
  await flush(4)
  assert.deepEqual(h.copied, [prompt], 'Copy All sends the ORIGINAL stored prompt byte for byte')
  assert.equal(h.notices.at(-1), 'Copy sent')
  assert.equal(h.app.getDraft(), '', 'a copy must never accept into the editor')
})

test('A0 fullscreen actions: Use Selected [Enter] accepts the pressed entry; a page that moved under it refuses', async () => {
  const h = startApp([row('result A', 1, '/work/a', 'id-a')])
  await openFullscreenHistory(h)
  const headingRow = rowOf(h.vt, 'Use Selected [Enter]')
  const col = colOf(h.vt, headingRow, 'Use Selected [Enter]')
  assert.ok(headingRow >= 0 && col >= 0, `the Use action must paint:\n${view(h.vt)}`)
  press(h.vt, headingRow, col + 1)
  await h.vt.waitForRender()
  // The page is replaced under the SAME painted cells before the release.
  h.rows.length = 0
  h.rows.push(row('result B', 2, '/work/a', 'id-b'))
  await research(h)
  assert.ok(rowOf(h.vt, 'result B') >= 0, `the replacement page must paint:\n${view(h.vt)}`)
  release(h.vt, headingRow, col + 1)
  await h.vt.waitForRender()
  await flush(4)
  assert.equal(h.app.getDraft(), '', 'a button pressed for A must never accept B')

  // Positive control on the SAME panel: the freshly painted button accepts.
  const freshRow = rowOf(h.vt, 'Use Selected [Enter]')
  const freshCol = colOf(h.vt, freshRow, 'Use Selected [Enter]')
  press(h.vt, freshRow, freshCol + 1)
  release(h.vt, freshRow, freshCol + 1)
  await h.vt.waitForRender()
  await flush(2)
  assert.equal(h.app.getDraft(), 'result B', 'the same-action press+click accepts the pressed entry')
  assert.ok(rowOf(h.vt, 'Copy All [Alt+C]') < 0, 'accepting closes the History seat')
})

test('A0 fullscreen cancellation: Esc closes the seat without exiting or interrupting', async () => {
  let exits = 0
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => { exits += 1 } }, {
    historySearchSource: { search: async () => ({ results: [row('alpha prompt', 1)], exhausted: true }) },
    captureHistoryScope: () => ({ sessionId: undefined, isCurrent: () => true }),
  })
  app.start()
  startedApps.add(app)
  app.setDraft('my draft')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  vt.sendInput('\x12')
  await vt.waitForRender()
  await flush(2)
  assert.ok(rawView(vt).some(line => line.includes('alpha prompt')), `History must open:\n${view(vt)}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  await flush(2)
  assert.ok(!rawView(vt).some(line => line.includes('Input History')),
    `Esc must close the History seat:\n${view(vt)}`)
  assert.equal(exits, 0, 'Esc while History owns the seat must never reach the exit/quit admission')
  assert.equal(app.getDraft(), 'my draft', 'Esc must leave the draft untouched')
})

test('A0 fullscreen cancellation: a Question parks the seat and the SAME History returns with its query', async () => {
  const h = startApp([row('alpha prompt', 1, '/work/a', 'id-a')])
  await openFullscreenHistory(h)
  h.vt.sendInput('alp')
  await h.vt.waitForRender()
  await flush(2)
  const question = h.app.askQuestions([{ id: 'q1', question: 'park the history?', options: [{ label: 'Yes' }] }])
  await h.vt.waitForRender()
  assert.ok(view(h.vt).includes('park the history?'), 'the blocking owner takes the seat')
  assert.ok(!view(h.vt).includes('Input History'), 'the parked History is not painted')
  h.vt.sendInput('\r')
  h.vt.sendInput('\r')
  await question
  await h.vt.waitForRender()
  await flush(2)
  assert.ok(view(h.vt).includes('Input History'), 'the SAME History tenant is restored')
  assert.ok(view(h.vt).includes('Search: > alp'), 'the query survives the park/restore round trip')
})

test('A0 fullscreen cancellation: a fullscreen swap keeps the SAME panel and drops the stale gesture', async () => {
  const h = startApp([row('alpha prompt', 1, '/work/a', 'id-a'), row('beta prompt', 2, '/work/a', 'id-b')])
  await openFullscreenHistory(h)
  h.vt.sendInput('\x1b[B') // select beta
  await h.vt.waitForRender()
  await flush(2)
  const betaRow = rowOf(h.vt, 'beta prompt')
  press(h.vt, betaRow, colOf(h.vt, betaRow, 'beta') + 1)
  await h.vt.waitForRender()
  h.app.setFullscreen(false)
  await h.vt.waitForRender()
  h.app.setFullscreen(true)
  await h.vt.waitForRender()
  await flush(2)
  assert.ok(view(h.vt).includes('Input History'), 'the SAME panel survives the round trip')
  const restoredRow = rowOf(h.vt, 'beta prompt')
  assert.ok(restoredRow >= 0, `the selected result must still paint:\n${view(h.vt)}`)
  release(h.vt, restoredRow, colOf(h.vt, restoredRow, 'beta') + 1)
  await h.vt.waitForRender()
  await flush(2)
  assert.equal(h.app.getDraft(), '', 'a gesture straddling a screen swap must never accept')
})

test('A0 fullscreen actions: an action pressed before a resize never fires at the stale geometry', async () => {
  const h = startApp([row('alpha prompt', 1, '/work/a', 'id-a')], 120, 40)
  await openFullscreenHistory(h)
  const headingRow = rowOf(h.vt, 'Use Selected [Enter]')
  const col = colOf(h.vt, headingRow, 'Use Selected [Enter]')
  assert.ok(headingRow >= 0 && col >= 0, `the Use action must paint:\n${view(h.vt)}`)
  press(h.vt, headingRow, col + 1)
  await h.vt.waitForRender()
  // The terminal grows; the stale painted cell must not fire the action (and the
  // alt screen's own liveness/placement fences reject the retargeted click).
  h.vt.resize(120, 41)
  release(h.vt, headingRow, col + 1)
  await h.vt.waitForRender()
  await flush(4)
  assert.equal(h.app.getDraft(), '', 'an action taken against a stale frame must never accept')
  assert.ok(rowOf(h.vt, 'Input History') >= 0, 'the seat stays open')
})

test('A0 cancellation: a pointer press does not survive a Question park/restore round trip', async () => {
  const h = startApp([row('alpha prompt', 1, '/work/a', 'id-a')])
  await openFullscreenHistory(h)
  const headingRow = rowOf(h.vt, 'Use Selected [Enter]')
  const col = colOf(h.vt, headingRow, 'Use Selected [Enter]')
  assert.ok(headingRow >= 0 && col >= 0, `the Use action must paint:\n${view(h.vt)}`)
  press(h.vt, headingRow, col + 1)
  await h.vt.waitForRender()
  const question = h.app.askQuestions([{ id: 'q1', question: 'park the pointer gesture?', options: [{ label: 'Yes' }] }])
  await h.vt.waitForRender()
  assert.ok(!view(h.vt).includes('Input History'), 'the Question parks the History seat')
  h.vt.sendInput('\r')
  h.vt.sendInput('\r')
  await question
  await h.vt.waitForRender()
  await flush(2)
  assert.ok(view(h.vt).includes('Input History'), 'the SAME History seat returns after the settle')
  // The press belonged to a frame the parked seat never kept: its release/click
  // must not act.
  release(h.vt, headingRow, col + 1)
  await h.vt.waitForRender()
  await flush(4)
  assert.equal(h.app.getDraft(), '', 'a gesture taken before the park must never accept after it')
  assert.ok(rowOf(h.vt, 'Input History') >= 0, 'the restored seat stays open')
})

test('A0 fullscreen mouse: a right or middle SGR button can never select, drag or activate', async () => {
  const h = startApp([
    row('alpha prompt', 3, '/work/a', 'id-a'),
    row('beta prompt', 2, '/work/a', 'id-b'),
  ])
  await openFullscreenHistory(h)
  const alphaRow = rowOf(h.vt, 'alpha prompt')
  const betaRow = rowOf(h.vt, 'beta prompt')
  const actionRow = rowOf(h.vt, 'Use Selected [Enter]')
  assert.ok(alphaRow >= 0 && betaRow >= 0 && actionRow >= 0,
    `the frame must paint results and actions:\n${view(h.vt)}`)
  const marker = (): string => rawView(h.vt).find(line => line.startsWith('> ')) ?? ''
  const markerBefore = marker()
  assert.ok(markerBefore.includes('alpha prompt'), 'the first result is selected')
  // SGR button codes: 1 = middle, 2 = right (lowercase `m` = release).
  for (const button of [1, 2] as const) {
    h.vt.sendInput(`\x1b[<${button};5;${betaRow + 1}M`)
    h.vt.sendInput(`\x1b[<${button};5;${betaRow + 1}m`)
    h.vt.sendInput(`\x1b[<${button};5;${actionRow + 1}M`)
    h.vt.sendInput(`\x1b[<${button};5;${actionRow + 1}m`)
    await h.vt.waitForRender()
    await flush(2)
    assert.equal(marker(), markerBefore, `button ${button} must not move the result selection`)
    assert.equal(h.app.getDraft(), '', `button ${button} must never accept`)
    assert.ok(rowOf(h.vt, 'Input History') >= 0, `button ${button} must not close the seat`)
  }
  // The LEFT button is unaffected in the same frame.
  const betaCol = colOf(h.vt, betaRow, 'beta')
  press(h.vt, betaRow, betaCol + 1)
  release(h.vt, betaRow, betaCol + 1)
  await h.vt.waitForRender()
  await flush(2)
  assert.ok(marker().includes('beta prompt'), 'the left button still selects')
})

test('A0 fullscreen mouse: the drag copies through the RELEASE cell, not the last motion cell', async () => {
  const h = startApp([row('abc\ndefghij', 1, '/work/a', 'p1')])
  await openFullscreenHistory(h)
  const headingRow = rowOf(h.vt, 'Preview ')
  const firstRow = headingRow + 1
  assert.ok(headingRow >= 0, `the Preview heading must paint:\n${view(h.vt)}`)
  // press (row 0, col 0) → drag (row 1, col 1) → release (row 1, col 3).
  press(h.vt, firstRow, 0)
  drag(h.vt, firstRow + 1, 1)
  release(h.vt, firstRow + 1, 3)
  await h.vt.waitForRender()
  await flush(4)
  assert.deepEqual(h.copied, ['abc\ndefg'],
    'the release position finalizes the copied range (through the released cell)')
})

test('A0 fullscreen actions: the LAST painted cell of each item is inside its hit range (no bracket device)', async () => {
  const h = startApp([row('alpha prompt', 3, '/work/a', 'id-a')])
  await openFullscreenHistory(h)
  const copyRow = rowOf(h.vt, 'Copy All [Alt+C]')
  assert.ok(copyRow >= 0, `the bracket-less Copy All item must be painted:\n${view(h.vt)}`)
  const copyStart = rawView(h.vt)[copyRow]!.indexOf('Copy All [Alt+C]')
  const copyLast = copyStart + 'Copy All [Alt+C]'.length - 1
  press(h.vt, copyRow, copyLast)
  release(h.vt, copyRow, copyLast)
  await h.vt.waitForRender()
  await flush(2)
  assert.deepEqual(h.copied, ['alpha prompt'], 'the last painted cell of Copy All is inside its hit range')

  const useRow = rowOf(h.vt, 'Use Selected [Enter]')
  const useStart = rawView(h.vt)[useRow]!.indexOf('Use Selected [Enter]')
  const useLast = useStart + 'Use Selected [Enter]'.length - 1
  press(h.vt, useRow, useLast)
  release(h.vt, useRow, useLast)
  await h.vt.waitForRender()
  await flush(2)
  assert.equal(h.app.getDraft(), 'alpha prompt', 'the last painted cell of Use Selected accepts the entry')
  assert.ok(rowOf(h.vt, 'Input History') < 0, 'accepting closes the History seat')
})
