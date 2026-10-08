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

function startApp(width = 100, height = 24): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
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
  assert.ok(!view.join('\n').includes('‹ parent'), `main fullscreen must have no subject bar:\n${view.join('\n')}`)

  enterChildDisplaySubject(app, { ...CHILD })
  view = await rows(vt)
  const barRows = view.filter(row => row.includes('‹ parent'))
  assert.equal(barRows.length, 1, `the child bar must be exactly one physical line:\n${view.join('\n')}`)
  assert.equal(view.findIndex(row => row.includes('‹ parent')), 1,
    `the bar must sit directly under the header:\n${view.join('\n')}`)

  exitChildDisplaySubject(app)
  view = await rows(vt)
  assert.ok(!view.join('\n').includes('‹ parent'), `exiting must clear the bar with no ghost row:\n${view.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('a fullscreen click on the bar never reaches the transcript; the first transcript row click does', async () => {
  const { vt, app } = startApp()
  app.setTranscript(longUserMessage().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  let view = await rows(vt)
  assert.equal(compactMarkerCount(view), 1, `precondition: the long user bubble is collapsed:\n${view.join('\n')}`)
  const barY = view.findIndex(row => row.includes('‹ parent'))
  assert.ok(barY >= 0, `the subject bar must be visible:\n${view.join('\n')}`)

  // The bar row is chrome, NOT transcript row 0: a click there is inert.
  clickCell(vt, 10, barY)
  view = await rows(vt)
  assert.equal(compactMarkerCount(view), 1, `a bar click must not toggle the transcript:\n${view.join('\n')}`)

  // The row directly under the bar IS transcript row 0: the click toggles it.
  clickCell(vt, 10, barY + 1)
  view = await rows(vt)
  assert.equal(compactMarkerCount(view), 0, `the first transcript row click must toggle the bubble:\n${view.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('wheel scrolling never moves the pinned subject bar', async () => {
  const { vt, app } = startApp()
  app.setTranscript(tallTranscript().messages())
  enterChildDisplaySubject(app, { ...CHILD })
  app.setFullscreen(true)
  await rows(vt)
  const barYBefore = (await rows(vt)).findIndex(row => row.includes('‹ parent'))
  const transcriptBefore = (await rows(vt)).join('\n')
  for (let i = 0; i < 4; i += 1) {
    vt.sendInput('\x1b[<64;10;5M')
    await rows(vt)
  }
  const after = await rows(vt)
  assert.notEqual(after.join('\n'), transcriptBefore, 'the wheel input must scroll the transcript')
  assert.equal(after.findIndex(row => row.includes('‹ parent')), barYBefore,
    `the bar must stay pinned while the transcript scrolls:\n${after.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('a Question-owned modal inspection uses the SAME bar-inclusive transcript offset', async () => {
  const { vt, app } = startApp()
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
  const barY = view.findIndex(row => row.includes('‹ parent'))
  assert.ok(barY >= 0, `the subject bar must stay visible under the question:\n${view.join('\n')}`)

  clickCell(vt, 10, barY)
  view = await rows(vt)
  assert.equal(compactMarkerCount(view), 1, `a bar click must stay inert during the question:\n${view.join('\n')}`)

  clickCell(vt, 10, barY + 1)
  view = await rows(vt)
  assert.equal(compactMarkerCount(view), 0, `the question-modal inspection must toggle the first transcript row:\n${view.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})
