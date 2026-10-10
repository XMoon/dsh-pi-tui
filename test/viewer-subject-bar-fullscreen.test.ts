/**
 * Fullscreen viewer-subject-bar geometry (viewer UX plan §7): the bar is
 * pinned chrome between the header and the transcript ScrollView, so the
 * fullscreen hit-map offset must include it. These tests drive the REAL
 * fullscreen paint snapshot through observable click/wheel behaviour —
 * never a hand-injected height.
 * @module @xmoon76/dsh-pi-tui/viewer-subject-bar-fullscreen.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { enterChildDisplaySubject, exitChildDisplaySubject } from './support/display-subject.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(
  width = 100,
  height = 24,
  onSingleEscape?: () => boolean | void,
): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    ...(onSingleEscape === undefined ? {} : { onSingleEscape }),
  })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

/** One durable text-only user message long enough to fold: head + `rows
 *  compacted` marker + tail while collapsed. */
function longUserMessage(): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply([{
    type: 'user/message', seq: 0, time: Date.now(), data: {
      content: [{ type: 'text', text: Array.from({ length: 24 }, (_, index) => `u-line-${index + 1}`).join('\n') }],
      source: { kind: 'user' },
    },
  }] as never[])
  return folder
}

/** A transcript taller than the viewport, for the pinned-scroll assertion. */
function tallTranscript(): TranscriptFolder {
  const folder = new TranscriptFolder()
  const events: unknown[] = []
  let seq = 0
  for (let turn = 0; turn < 12; turn += 1) {
    events.push({ type: 'turn/start', seq: seq++, time: turn * 10, data: { turn } })
    events.push({
      type: 'user/message', seq: seq++, time: turn * 10 + 1, data: {
        content: [{ type: 'text', text: `prompt ${turn}` }], source: { kind: 'user' },
      },
    })
    events.push({
      type: 'assistant/message', seq: seq++, time: turn * 10 + 2, data: {
        turn, step: 0,
        message: { id: `m${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }], source: { kind: 'assistant' } },
      },
    })
    events.push({ type: 'turn/end', seq: seq++, time: turn * 10 + 3, data: { turn, reason: { kind: 'completed' } } })
  }
  folder.apply(events as never[])
  return folder
}

/** Several folded user bubbles (head + `rows compacted` + tail), each with a
 *  distinct `M<k>-` line prefix, so the fullscreen viewport overflows and the
 *  identity of the bottom-most visible row is unambiguous. */
function foldedMessages(count: number): TranscriptFolder {
  const folder = new TranscriptFolder()
  const events: unknown[] = []
  let seq = 0
  for (let k = 0; k < count; k += 1) {
    events.push({ type: 'turn/start', seq: seq++, time: k * 10, data: { turn: k } })
    events.push({
      type: 'user/message', seq: seq++, time: k * 10 + 1, data: {
        content: [{ type: 'text', text: Array.from({ length: 30 }, (_, i) => `M${k}-${i + 1}`).join('\n') }],
        source: { kind: 'user' },
      },
    })
    events.push({ type: 'turn/end', seq: seq++, time: k * 10 + 2, data: { turn: k, reason: { kind: 'completed' } } })
  }
  folder.apply(events as never[])
  return folder
}

async function rows(vt: VirtualTerminal): Promise<string[]> {
  await vt.waitForRender()
  return vt.getViewport().map(line => stripTerminalSequences(line).trimEnd())
}

function clickCell(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`)
  vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`)
}

function compactMarkerCount(view: readonly string[]): number {
  return view.filter(row => row.includes('rows compacted')).length
}

const CHILD = {
  id: 'child-1', label: 'research', mode: 'continuable', activity: 'running',
  cwd: '/child', turns: 1, steps: 1,
} as const

test('the subject bar is exactly one pinned row under the header in fullscreen, zero on main', async () => {
  const { vt, app } = startApp()
  app.setTranscript(longUserMessage().messages())
  app.setFullscreen(true)
  let view = await rows(vt)
  assert.ok(!view.join('\n').includes('‹ back'), `main fullscreen must have no subject bar:\n${view.join('\n')}`)

  enterChildDisplaySubject(app, { ...CHILD })
  view = await rows(vt)
  const barRows = view.filter(row => row.includes('‹ back'))
  assert.equal(barRows.length, 1, `the child bar must be exactly one physical line:\n${view.join('\n')}`)
  assert.equal(view.findIndex(row => row.includes('‹ back')), 1,
    `the bar must sit directly under the header:\n${view.join('\n')}`)

  exitChildDisplaySubject(app)
  view = await rows(vt)
  assert.ok(!view.join('\n').includes('‹ back'), `exiting must clear the bar with no ghost row:\n${view.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('the navigation glyph cells exit through the Esc route; the rest of the bar is inert', async () => {
  const escapes: number[] = []
  const { vt, app } = startApp(100, 24, () => { escapes.push(1); return true })
  app.setTranscript(longUserMessage().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  let view = await rows(vt)
  assert.equal(compactMarkerCount(view), 1, `precondition: the long user bubble is collapsed:\n${view.join('\n')}`)
  const barY = view.findIndex(row => row.includes('‹ back'))
  assert.ok(barY >= 0, `the subject bar must be visible:\n${view.join('\n')}`)

  // The label/model/padding cells are inert — the bar is chrome, not a target.
  clickCell(vt, 10, barY)
  view = await rows(vt)
  assert.equal(escapes.length, 0, 'a label cell must not exit the viewer')
  assert.equal(compactMarkerCount(view), 1, `a bar click must not toggle the transcript:\n${view.join('\n')}`)
  clickCell(vt, 60, barY)
  await rows(vt)
  assert.equal(escapes.length, 0, 'a model/padding cell must not exit the viewer')

  // The `‹ back` glyph itself runs the ORIGINAL viewer Esc route exactly once.
  clickCell(vt, 1, barY)
  view = await rows(vt)
  assert.equal(escapes.length, 1, `the glyph click must call the viewer Esc route once:\n${view.join('\n')}`)
  assert.equal(compactMarkerCount(view), 1, `the glyph click must not touch the transcript:\n${view.join('\n')}`)

  // The row directly under the bar IS transcript row 0: the click toggles it.
  clickCell(vt, 10, barY + 1)
  view = await rows(vt)
  assert.equal(compactMarkerCount(view), 0, `the first transcript row click must toggle the bubble:\n${view.join('\n')}`)
  assert.equal(escapes.length, 1, 'the transcript click must not exit the viewer')
  app.setFullscreen(false)
  app.stop()
})

test('a one-shot (readonly) child exposes the same glyph exit route', async () => {
  const escapes: number[] = []
  const { vt, app } = startApp(100, 24, () => { escapes.push(1); return true })
  app.setTranscript(longUserMessage().messages())
  enterChildDisplaySubject(app, { ...CHILD, mode: 'one-shot', access: undefined, activity: 'inactive' } as never)
  app.setFullscreen(true)
  const view = await rows(vt)
  const barY = view.findIndex(row => row.includes('‹ back'))
  assert.ok(barY >= 0, `the one-shot bar must render the navigation:\n${view.join('\n')}`)
  clickCell(vt, 1, barY)
  await rows(vt)
  assert.equal(escapes.length, 1, 'the readonly child must use the same exit callback')
  app.setFullscreen(false)
  app.stop()
})

test('a glyph press released on a DIFFERENT child never exits', async () => {
  const escapes: number[] = []
  const { vt, app } = startApp(100, 24, () => { escapes.push(1); return true })
  app.setTranscript(longUserMessage().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  const view = await rows(vt)
  const barY = view.findIndex(row => row.includes('‹ back'))
  assert.ok(barY >= 0, `the subject bar must be visible:\n${view.join('\n')}`)
  // Press the glyph of child A, switch to child B, then release on the same
  // cell: the press-time generation no longer describes the displayed viewer.
  vt.sendInput(`\x1b[<0;2;${barY + 1}M`)
  await rows(vt)
  enterChildDisplaySubject(app, { ...CHILD, id: 'child-2', label: 'child B' })
  await rows(vt)
  vt.sendInput(`\x1b[<0;2;${barY + 1}m`)
  await rows(vt)
  assert.equal(escapes.length, 0, 'a child switch must invalidate the back gesture')
  app.setFullscreen(false)
  app.stop()
})

test('a glyph press released after a resize never exits', async () => {
  const escapes: number[] = []
  const { vt, app } = startApp(100, 24, () => { escapes.push(1); return true })
  app.setTranscript(longUserMessage().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  const view = await rows(vt)
  const barY = view.findIndex(row => row.includes('‹ back'))
  assert.ok(barY >= 0, `the subject bar must be visible:\n${view.join('\n')}`)
  vt.sendInput(`\x1b[<0;2;${barY + 1}M`)
  await rows(vt)
  vt.resize(100, 20)
  await rows(vt)
  vt.sendInput(`\x1b[<0;2;${barY + 1}m`)
  await rows(vt)
  assert.equal(escapes.length, 0, 'a resize between press and release must invalidate the gesture')
  app.setFullscreen(false)
  app.stop()
})

test('a glyph press then a Question modal never exits through the bar', async () => {
  const escapes: number[] = []
  const { vt, app } = startApp(100, 24, () => { escapes.push(1); return true })
  app.setTranscript(longUserMessage().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  const view = await rows(vt)
  const barY = view.findIndex(row => row.includes('‹ back'))
  assert.ok(barY >= 0, `the subject bar must be visible:\n${view.join('\n')}`)
  vt.sendInput(`\x1b[<0;2;${barY + 1}M`)
  await rows(vt)
  // The question owns the modal front after the press: the release must be
  // consumed by the modal front, never by the stale back lure.
  app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }]).catch(() => {})
  await rows(vt)
  vt.sendInput(`\x1b[<0;2;${barY + 1}m`)
  await rows(vt)
  assert.equal(escapes.length, 0, 'a modal taking the front must invalidate the gesture')
  app.setFullscreen(false)
  app.stop()
})

test('the passthrough search box owns the bar cells it actually covers', async () => {
  const escapes: number[] = []
  // 24 columns: the top-right search box (min width 24 clamped to the margin)
  // covers the bar row from column 1 on, so it overlaps most of the `‹ back`
  // glyph band but NOT column 0.
  const { vt, app } = startApp(24, 24, () => { escapes.push(1); return true })
  app.setTranscript(longUserMessage().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  await rows(vt)
  app.startTranscriptSearch()
  await rows(vt)
  const view = await rows(vt)
  assert.ok(view.join('\n').includes('Find transcript'),
    `precondition: the search box must be visible:\n${view.join('\n')}`)
  const barY = view.findIndex(row => row.includes('‹'))
  assert.ok(barY >= 0, `the subject bar must be visible:\n${view.join('\n')}`)

  // A covered glyph cell belongs to the box: the bar must not act under it.
  clickCell(vt, 2, barY)
  await rows(vt)
  assert.equal(escapes.length, 0, 'a cell covered by the search box must not exit')
  // Column 0 is outside the box (its margin): the passthrough keeps it live.
  clickCell(vt, 0, barY)
  await rows(vt)
  assert.equal(escapes.length, 1, 'the uncovered glyph cell must keep working under the box')
  app.setFullscreen(false)
  app.stop()
})

test('wheel scrolling never moves the pinned subject bar', async () => {
  const { vt, app } = startApp()
  app.setTranscript(tallTranscript().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  await rows(vt)
  const barYBefore = (await rows(vt)).findIndex(row => row.includes('‹ back'))
  const transcriptBefore = (await rows(vt)).join('\n')
  for (let i = 0; i < 4; i += 1) {
    vt.sendInput('\x1b[<64;10;5M')
    await rows(vt)
  }
  const after = await rows(vt)
  assert.notEqual(after.join('\n'), transcriptBefore, 'the wheel input must scroll the transcript')
  assert.equal(after.findIndex(row => row.includes('‹ back')), barYBefore,
    `the bar must stay pinned while the transcript scrolls:\n${after.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('a Question-owned modal inspection uses the SAME bar-inclusive transcript offset', async () => {
  const escapes: number[] = []
  const { vt, app } = startApp(100, 24, () => { escapes.push(1); return true })
  app.setTranscript(longUserMessage().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  // The question owns the modal front; clicks outside its frame inspect the
  // read-only transcript through the SAME paint snapshot. The promise only
  // settles at teardown (the stop cancels the flow) — its rejection is
  // expected and swallowed here.
  app.askQuestions([{ id: 'q1', question: 'Proceed?', options: [{ label: 'yes' }, { label: 'no' }] }]).catch(() => {})
  await rows(vt)
  let view = await rows(vt)
  assert.equal(compactMarkerCount(view), 1, `precondition: the user bubble is collapsed:\n${view.join('\n')}`)
  const barY = view.findIndex(row => row.includes('‹ back'))
  assert.ok(barY >= 0, `the subject bar must stay visible under the question:\n${view.join('\n')}`)

  clickCell(vt, 10, barY)
  view = await rows(vt)
  assert.equal(compactMarkerCount(view), 1, `a bar click must stay inert during the question:\n${view.join('\n')}`)
  // The `‹ back` GLYPH cells are equally inert while the question owns the
  // modal front: the Back affordance must never pierce a capturing modal.
  clickCell(vt, 1, barY)
  view = await rows(vt)
  assert.equal(escapes.length, 0, 'the glyph must not exit through the question modal')
  assert.equal(compactMarkerCount(view), 1, `a glyph click must stay inert during the question:\n${view.join('\n')}`)

  clickCell(vt, 10, barY + 1)
  view = await rows(vt)
  assert.equal(compactMarkerCount(view), 0, `the question-modal inspection must toggle the first transcript row:\n${view.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('PageUp scrolls the transcript while the subject bar stays pinned', async () => {
  const { vt, app } = startApp()
  app.setTranscript(tallTranscript().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  await rows(vt)
  const before = (await rows(vt)).join('\n')
  vt.sendInput('\x1b[5~') // PageUp
  await rows(vt)
  const after = await rows(vt)
  assert.notEqual(after.join('\n'), before, 'PageUp must scroll the transcript')
  assert.equal(after.findIndex(row => row.includes('‹ back')), 1,
    `the bar must stay pinned across PageUp:\n${after.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('the transcript search overlay keeps the bar pinned through a reveal', async () => {
  const { vt, app } = startApp()
  app.setTranscript(tallTranscript().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  await rows(vt)
  vt.sendInput('\x06') // Ctrl+F opens the transcript search
  await rows(vt)
  assert.equal((await rows(vt)).findIndex(row => row.includes('‹ back')), 1,
    'the bar must stay pinned with the search overlay open')
  vt.sendInput('prompt 3')
  await rows(vt)
  vt.sendInput('\r') // reveal the match
  await rows(vt)
  const revealed = await rows(vt)
  assert.equal(revealed.findIndex(row => row.includes('‹ back')), 1,
    `the bar must stay pinned across the search reveal:\n${revealed.join('\n')}`)
  assert.ok(revealed.some(row => row.includes('prompt 3')),
    `the revealed match must be visible in the viewport:\n${revealed.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('a transcript press is fenced when a resize lands before the release', async () => {
  const { vt, app } = startApp()
  app.setTranscript(longUserMessage().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  let view = await rows(vt)
  assert.equal(compactMarkerCount(view), 1, `precondition: the bubble is collapsed:\n${view.join('\n')}`)
  const y = view.findIndex(row => row.includes('‹ back')) + 1
  vt.sendInput(`\x1b[<0;10;${y + 1}M`) // press the first transcript row
  vt.resize(100, 20) // a resize lands before the release
  await rows(vt)
  vt.sendInput(`\x1b[<0;10;${y + 1}m`) // release at the same cell
  await rows(vt)
  view = await rows(vt)
  assert.equal(compactMarkerCount(view), 1,
    `a release after a resize must be rejected by the stale-frame fence:\n${view.join('\n')}`)
  // Let the double-click detector settle, then prove the CURRENT geometry
  // still resolves the first transcript row correctly.
  await new Promise(resolve => setTimeout(resolve, 600))
  view = await rows(vt)
  const barY = view.findIndex(row => row.includes('‹ back'))
  clickCell(vt, 10, barY + 1)
  view = await rows(vt)
  assert.equal(compactMarkerCount(view), 0,
    `the fresh click at the current geometry must toggle the first transcript row:\n${view.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('the LAST visible transcript row maps to its own bubble with the bar present', async () => {
  const { vt, app } = startApp()
  app.setTranscript(foldedMessages(8).messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  const view = await rows(vt)
  const barY = view.findIndex(row => row.includes('‹ back'))
  assert.equal(barY, 1, `the bar is pinned under the header:\n${view.join('\n')}`)
  // The bottom-most VISIBLE row that belongs to a transcript bubble.
  let lastY = -1
  let owner = ''
  for (let index = view.length - 1; index > barY; index -= 1) {
    const match = /M(\d)-\d+/u.exec(view[index]!)
    if (match !== null) { lastY = index; owner = match[1]!; break }
  }
  assert.ok(lastY > barY && owner !== '', `a transcript bubble row must be visible:\n${view.join('\n')}`)
  // Ownership evidence keyed to the clicked bubble's OWN hidden text, not a
  // visible-row count (other bubbles expanding or a scrollTop shift could
  // change a count without this row owning the click).
  const hidden = `M${owner}-25`
  assert.ok(!view.some(row => row.includes(hidden)),
    `precondition: the owner's body line must be folded:\n${view.join('\n')}`)
  clickCell(vt, 10, lastY)
  const after = await rows(vt)
  assert.ok(after.some(row => row.includes(hidden)),
    `the clicked last-visible row must expand its OWN bubble (${hidden} must become visible):\nBEFORE:\n${view.join('\n')}\nAFTER:\n${after.join('\n')}`)
  assert.equal(after.findIndex(row => row.includes('‹ back')), 1,
    `the bar stays pinned after the bottom-row click:\n${after.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('a very long main session title never pushes the bar or editor out of a short fullscreen', async () => {
  // The PR restores the MAIN session title in the header while a child is
  // viewed. A long title must not let the header eat the whole viewport and
  // push the pinned subject bar / editor out (external review P2).
  const { vt, app } = startApp(20, 10)
  app.setSessionTitle('L'.repeat(200))
  app.setStatus({ model: 'p/m', cwd: '/w', turns: 1, steps: 1 })
  await rows(vt)
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  await rows(vt)
  const lines = vt.getViewport()
  const plain = lines.map(line => stripTerminalSequences(line).trimEnd())
  // At 20 columns the bar degrades to the `‹` marker; the header must stay
  // ONE physical row so the bar sits directly under it.
  const barY = plain.findIndex(line => line.includes('‹'))
  assert.equal(barY, 1, `the subject bar must be the row under the header:\n${plain.join('\n')}`)
  assert.ok(plain[barY]!.includes('resea'), `the bar must keep an identifiable child label:\n${plain.join('\n')}`)
  const editorTop = lines.findIndex(line => line.includes('─'.repeat(10)))
  assert.ok(editorTop !== -1, `the editor top border must survive:\n${plain.join('\n')}`)
  assert.ok(lines.slice(editorTop + 1).some(line => line.includes('─'.repeat(10))),
    `the editor bottom border must survive:\n${plain.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})
