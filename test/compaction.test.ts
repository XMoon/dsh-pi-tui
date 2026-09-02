/**
 * Headless tests for the compaction progress/completion surface
 * (requirement 5): the transcript card (start → summary → end folding),
 * the working-row "Compacting context…" label, and the firehose state
 * pairing (a stale compaction/end never clears a newer compaction).
 * @module @xmoon76/dsh-pi-tui/compaction.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import {
  busyAfterTurnBoundary,
  compactingFromLog,
  foldCompactionEvent,
  settleCompactionSurface,
  type CompactionFold,
} from '../src/index.ts'
import { indeterminateProgressFrames } from '../src/progress.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { WorkingIndicator } from '../src/working.ts'
import { VirtualTerminal } from './virtual-terminal.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** A structural compaction event (dsh-compaction is not a peer). */
function compactionEvent(
  type: 'compaction/start' | 'compaction/summary' | 'compaction/end',
  data: Record<string, unknown>,
): never {
  return { type, seq: 1, time: 1, data } as never
}

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

test('the transcript folds compaction/start + summary + end into one card', () => {
  const folder = new TranscriptFolder()
  folder.apply([compactionEvent('compaction/start', { compactionId: 'c1', turn: null })])
  let messages = folder.messages()
  assert.equal(messages.length, 1)
  const running = messages[0]!
  assert.equal(running.kind, 'compaction')
  if (running.kind !== 'compaction') return
  assert.equal(running.running, true, 'the card starts in-progress')

  folder.apply([compactionEvent('compaction/summary', {
    compactionId: 'c1',
    summary: [{ type: 'text', text: 'the summary body' }],
    shadowedSeqs: [1, 2, 3],
    shadowedTokenCount: 4200,
  })])
  messages = folder.messages()
  const filled = messages[0]!
  assert.equal(filled.kind, 'compaction')
  if (filled.kind !== 'compaction') return
  assert.equal(filled.text, 'the summary body')
  assert.equal(filled.items, 3)
  assert.equal(filled.tokens, 4200)

  folder.apply([compactionEvent('compaction/end', { compactionId: 'c1', turn: null })])
  messages = folder.messages()
  const settled = messages[0]!
  assert.equal(settled.kind, 'compaction')
  if (settled.kind !== 'compaction') return
  assert.equal(settled.running, false, 'the end settles the card')
  assert.equal(settled.error, undefined)
})

test('a compaction/end with an error marks the card failed', () => {
  const folder = new TranscriptFolder()
  folder.apply([compactionEvent('compaction/start', { compactionId: 'c1', turn: null })])
  folder.apply([compactionEvent('compaction/end', { compactionId: 'c1', turn: null, error: 'llm failed' })])
  const card = folder.messages()[0]!
  assert.equal(card.kind, 'compaction')
  if (card.kind !== 'compaction') return
  assert.equal(card.error, 'llm failed')
})

test('the compaction card renders title, counts and expandable body', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setTranscript([{
    kind: 'compaction',
    turn: 0,
    text: 'the summary body',
    items: 3,
    tokens: 4200,
  }])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Context compacted'), `title missing:\n${view}`)
  assert.ok(view.includes('Compacted 3 history items (~4200 tokens)'), `counts missing:\n${view}`)

  // Expand (Ctrl+O) reveals the summary body.
  vt.sendInput('\x0f')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('the summary body'), `expanded body missing:\n${view}`)
  app.stop()
})

test('a failed compaction card renders the failure title', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setTranscript([{ kind: 'compaction', turn: 0, text: '', items: 0, tokens: 0, error: 'llm failed' }])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Compaction failed'), `failure title missing:\n${view}`)
  app.stop()
})

test('the working row shows "Working... · Compacting context…" while compacting', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setWorking(true)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Working...'), `working label missing:\n${view}`)
  assert.ok(!view.includes('Compacting'), `no compaction label before start:\n${view}`)

  app.setCompacting(true)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Working... · Compacting context…'), `unified label missing:\n${view}`)

  app.setCompacting(false)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Working...'), `label must return to plain Working...:\n${view}`)
  assert.ok(!view.includes('Compacting'), `compaction label must clear:\n${view}`)

  app.setWorking(false)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('Working'), `the row must hide when nothing runs:\n${view}`)
  app.stop()
})

test('a standalone compaction lights the working row and hides it on end', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setCompacting(true)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Compacting context…'), `standalone compaction must light the row:\n${view}`)
  app.setCompacting(false)
  app.setWorking(false)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('Compacting'), `the row must clear after the compaction:\n${view}`)
  app.stop()
})

test('foldCompactionEvent pairs start/end by id and notifies the settle', () => {
  const state = { id: undefined as string | undefined }
  const start = foldCompactionEvent(state, { type: 'compaction/start', data: { compactionId: 'c1' } })
  assert.deepEqual(start, { id: 'c1', active: true, clear: false, phase: 'summarizing', notify: undefined })
  state.id = start.id

  const summary = foldCompactionEvent(state, { type: 'compaction/summary', data: { compactionId: 'c1' } })
  assert.deepEqual(summary, { id: 'c1', active: false, clear: false, phase: 'applying', notify: undefined })

  const matched = foldCompactionEvent(state, { type: 'compaction/end', data: { compactionId: 'c1' } })
  assert.deepEqual(matched, {
    id: undefined,
    active: false,
    clear: true,
    notify: { text: 'Context compacted', kind: 'info' },
  })

  const errEnd = foldCompactionEvent({ id: 'c2' }, { type: 'compaction/end', data: { compactionId: 'c2', error: 'boom' } })
  assert.equal(errEnd.clear, true)
  assert.deepEqual(errEnd.notify, { text: 'Compaction failed: boom', kind: 'error' })
})

test('a STALE compaction/summary does not advance the phase', () => {
  const state = { id: 'c2' as string | undefined }
  const stale = foldCompactionEvent(state, { type: 'compaction/summary', data: { compactionId: 'c1' } })
  assert.equal(stale.phase, undefined, 'a stale summary must not flip the phase')
  assert.equal(stale.id, 'c2', 'the newer compaction id survives')
  assert.equal(stale.clear, false)
  // The current compaction's own summary advances to applying.
  const fresh = foldCompactionEvent(state, { type: 'compaction/summary', data: { compactionId: 'c2' } })
  assert.equal(fresh.phase, 'applying')
  // An id-less summary is a foreign event: no phase change.
  const orphan = foldCompactionEvent(state, { type: 'compaction/summary', data: {} })
  assert.equal(orphan.phase, undefined)
  assert.equal(orphan.id, 'c2')
})

test('a STALE compaction/end neither clears nor notifies', () => {
  const state = { id: 'c2' as string | undefined }
  const stale = foldCompactionEvent(state, { type: 'compaction/end', data: { compactionId: 'c1' } })
  assert.equal(stale.clear, false, 'a stale end must not clear the newer compaction')
  assert.equal(stale.id, 'c2', 'the newer compaction id survives')
  assert.equal(stale.notify, undefined, 'a stale end must not notify the settle')
  // The newer compaction's own end clears it and notifies.
  const fresh = foldCompactionEvent(state, { type: 'compaction/end', data: { compactionId: 'c2' } })
  assert.equal(fresh.clear, true)
  assert.equal(fresh.id, undefined)
  assert.ok(fresh.notify !== undefined)
})

test('an ID-LESS compaction/end never clears an active compaction', () => {
  const state = { id: 'c2' as string | undefined }
  const orphan = foldCompactionEvent(state, { type: 'compaction/end', data: {} })
  assert.equal(orphan.clear, false, 'an id-less end must not clear the active compaction')
  assert.equal(orphan.id, 'c2')
  assert.equal(orphan.notify, undefined)
  // With NO compaction active, an id-less end is a foreign event: no-op.
  const idle = foldCompactionEvent({ id: undefined }, { type: 'compaction/end', data: {} })
  assert.equal(idle.clear, false)
  assert.equal(idle.notify, undefined)
})

test('busyAfterTurnBoundary keeps busy while a compaction is in flight', () => {
  assert.equal(busyAfterTurnBoundary('turn/start', false), true)
  assert.equal(busyAfterTurnBoundary('turn/start', true), true)
  assert.equal(busyAfterTurnBoundary('turn/end', true), true, 'an interrupted turn must keep the compaction cancel armed')
  assert.equal(busyAfterTurnBoundary('turn/end', false), false)
})

test('compactingFromLog re-arms only a LIVE unclosed compaction', () => {
  const ev = (type: string, compactionId?: string): never =>
    ({ type, seq: 1, time: 1, data: compactionId === undefined ? {} : { compactionId } }) as never
  // Unclosed start in the live part: active.
  assert.deepEqual(compactingFromLog([ev('compaction/start', 'c1')]), { active: true, id: 'c1' })
  // Closed bracket: idle.
  assert.deepEqual(compactingFromLog([ev('compaction/start', 'c1'), ev('compaction/end', 'c1')]), { active: false, id: undefined })
  // An unclosed start BEFORE a session/end-seed boundary is STALE (the
  // upstream invariant): the seed's compaction never survives the seed.
  assert.deepEqual(
    compactingFromLog([ev('compaction/start', 'c1'), ev('session/end-seed')]),
    { active: false, id: undefined },
  )
  // A start AFTER the boundary stays live.
  assert.deepEqual(
    compactingFromLog([ev('session/end-seed'), ev('compaction/start', 'c2')]),
    { active: true, id: 'c2' },
  )
  // A start in the seed settled in the live part: idle.
  assert.deepEqual(
    compactingFromLog([ev('compaction/start', 'c1'), ev('session/end-seed'), ev('compaction/end', 'c1')]),
    { active: false, id: undefined },
  )
})

test('foldCompactionEvent ignores unrelated events', () => {
  const state = { id: 'c1' as string | undefined }
  const folded = foldCompactionEvent(state, { type: 'turn/end', data: {} })
  assert.deepEqual(folded, { id: 'c1', active: false, clear: false, notify: undefined } satisfies CompactionFold)
})

test('a session/end-seed settles stale open compaction cards', () => {
  const folder = new TranscriptFolder()
  // The seed's unclosed compaction/start, then the seed boundary: the
  // card must settle (never a forever-running "Compacting context…").
  folder.apply([compactionEvent('compaction/start', { compactionId: 'c1', turn: null })])
  folder.apply([{ type: 'session/end-seed', seq: 2, time: 1, data: {} } as never])
  const card = folder.messages()[0]!
  assert.equal(card.kind, 'compaction')
  if (card.kind !== 'compaction') return
  assert.equal(card.running, false, 'the seed-boundary must settle the stale card')
  assert.equal(card.error, undefined, 'a stale start is not a failure')
  // A compaction started AFTER the boundary stays live until its end.
  const folder2 = new TranscriptFolder()
  folder2.apply([compactionEvent('compaction/start', { compactionId: 'c1', turn: null })])
  folder2.apply([{ type: 'session/end-seed', seq: 2, time: 1, data: {} } as never])
  folder2.apply([compactionEvent('compaction/start', { compactionId: 'c2', turn: null })])
  const live = folder2.messages()
  assert.equal(live.length, 2, 'the live compaction adds its own card')
  const second = live[1]!
  assert.equal(second.kind, 'compaction')
  if (second.kind === 'compaction') assert.equal(second.running, true)
})

test('a turn end while compacting keeps the working row and label live', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setWorking(true)
  app.setCompacting(true)
  await vt.waitForRender()
  // An interrupted turn closes (turn/end) BEFORE the compaction settles:
  // the row must survive with the unified label (the busy flag stays
  // armed — busyAfterTurnBoundary covers the runner side).
  app.setWorking(false)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Working... · Compacting context…'), `the row must survive a turn end while compacting:\n${view}`)
  app.setCompacting(false)
  await vt.waitForRender()
  const after = vt.getViewport().join('\n')
  assert.ok(!after.includes('Compacting'), `the row must clear once the compaction settles:\n${after}`)
  app.stop()
})

test('indeterminateProgressFrames ping-pongs a block across the track', () => {
  const frames = indeterminateProgressFrames(12, 3)
  assert.equal(frames.length, 19, '0..9 then 8..0 (no tail-to-head jump)')
  assert.equal(frames[0], '[███░░░░░░░░░]')
  assert.equal(frames[1], '[░███░░░░░░░░]')
  assert.equal(frames[9], '[░░░░░░░░░███]')
  assert.equal(frames[10], '[░░░░░░░░███░]')
  assert.equal(frames[18], '[███░░░░░░░░░]')
  for (const frame of frames) {
    assert.equal(frame.length, 14, 'every frame is the bracketed track width')
    assert.ok(frame.startsWith('[') && frame.endsWith(']'), `frame must be bracketed: ${frame}`)
  }
  // Degenerate sizes stay valid (never an empty or negative track).
  assert.deepEqual(indeterminateProgressFrames(1, 1), ['[█]'])
  assert.deepEqual(indeterminateProgressFrames(4, 9), ['[████]'])
})

test('WorkingIndicator advances the suffix on its own tick (no second timer)', async () => {
  const renders: string[] = []
  const indicator = new WorkingIndicator(
    () => { renders.push(indicator.render(80).join('')) },
    { intervalMs: 20 },
  )
  indicator.setSuffixAnimation({ frames: ['[A]', '[B]'] })
  indicator.start()
  const seen = new Set<string>()
  for (let i = 0; i < 30 && seen.size < 2; i += 1) {
    const text = indicator.render(80).join('')
    if (text.includes('[A]')) seen.add('A')
    if (text.includes('[B]')) seen.add('B')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(seen.has('A') && seen.has('B'), `both suffix frames must appear, saw: ${[...seen].join(', ')}`)
  // Clearing the suffix stops the suffix motion (the leading frame keeps
  // animating on the same timer). Match the bracketed bar pattern, not a
  // bare '[' — the ANSI dim escape contains a literal '['.
  indicator.setSuffixAnimation(undefined)
  const cleared = indicator.render(80).join('')
  assert.ok(cleared.match(/\[[█░]+\]/) === null, `the suffix must clear:\n${cleared}`)
  indicator.dispose()
})

test('a compaction start shows the indeterminate progress bar', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setCompactionPhase('summarizing')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Working... · Compacting context…'), `unified label missing:\n${view}`)
  const workingLine = vt.getViewport().find(line => line.includes('Working'))
  assert.ok(workingLine !== undefined && workingLine.includes('[') && workingLine.includes(']'),
    `progress bar brackets missing on the working row:\n${view}`)
  assert.ok(workingLine.includes('█') && workingLine.includes('░'),
    `progress bar cells missing on the working row:\n${view}`)
  app.stop()
})

test('the progress bar advances on the working indicator tick', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { workingIntervalMs: 20 })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.setCompactionPhase('summarizing')
  await vt.waitForRender()
  const barOf = (): string | undefined =>
    vt.getViewport().find(line => line.includes('Working'))?.match(/\[[█░]+\]/)?.[0]
  const first = barOf()
  assert.ok(first !== undefined, `progress bar missing:\n${vt.getViewport().join('\n')}`)
  // Sample several ticks until the bar frame changes: the bar rides the
  // indicator's own 20ms timer — never a second repaint timer.
  let changed: string | undefined
  for (let i = 0; i < 30 && changed === undefined; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 20))
    const current = barOf()
    if (current !== undefined && current !== first) changed = current
  }
  assert.ok(changed !== undefined, 'the bar must advance on the indicator tick')
  app.stop()
})

test('a matched summary switches the phase to applying', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setCompactionPhase('summarizing')
  await vt.waitForRender()
  app.setCompactionPhase('applying')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Working... · Applying compacted context…'), `applying label missing:\n${view}`)
  const workingLine = vt.getViewport().find(line => line.includes('Working'))
  assert.ok(workingLine !== undefined && workingLine.includes('█'),
    `the bar must survive the phase switch:\n${view}`)
  app.stop()
})

test('a matched end clears the phase, the label and the bar', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setCompactionPhase('applying')
  await vt.waitForRender()
  app.setCompactionPhase('idle')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('Compacting'), `compaction label must clear:\n${view}`)
  assert.ok(!view.includes('Applying compacted'), `applying label must clear:\n${view}`)
  const workingLine = vt.getViewport().find(line => line.includes('Working'))
  assert.ok(workingLine === undefined || !workingLine.includes('['),
    `the bar must clear with the phase:\n${view}`)
  app.stop()
})

test('a turn-enclosed compaction restores the plain Working row on end', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setWorking(true)
  app.setCompactionPhase('summarizing')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Working... · Compacting context…'), `unified label missing:\n${view}`)
  app.setCompactionPhase('idle')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Working...'), `the turn animation must survive the settle:\n${view}`)
  assert.ok(!view.includes('Compacting'), `compaction label must clear:\n${view}`)
  assert.ok(!view.includes('Applying compacted'), `applying label must clear:\n${view}`)
  app.setWorking(false)
  app.stop()
})

test('the plugin working-message override survives the compaction phase', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.advancedHostState().setWorkingMessage('Reviewing...')
  app.setCompactionPhase('summarizing')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Reviewing... · Compacting context…'), `override + summarizing missing:\n${view}`)
  const workingLine = vt.getViewport().find(line => line.includes('Reviewing'))
  assert.ok(workingLine !== undefined && workingLine.includes('█'),
    `the bar must ride the override:\n${view}`)
  app.setCompactionPhase('applying')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Reviewing... · Applying compacted context…'), `override + applying missing:\n${view}`)
  app.setCompactionPhase('idle')
  app.advancedHostState().setWorkingMessage(undefined)
  app.stop()
})

test('a matched compaction settle clears the phase and refreshes the status once', async () => {
  const { vt, app } = startApp()
  await vt.waitForRender()
  app.setWorking(true)
  app.setCompactionPhase('applying')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Applying compacted context…'), `applying label missing:\n${view}`)
  // The runner's matched compaction/end path (work package A): clear the
  // phase, hand the row back to the turn state, and re-measure the
  // session surface IMMEDIATELY — the next step/start or turn/end must
  // not be required for the footer to reflect the compacted log.
  let refreshes = 0
  settleCompactionSurface(app, () => { refreshes += 1 }, true)
  await vt.waitForRender()
  assert.equal(refreshes, 1, 'a matched settle must refresh the status exactly once')
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Working...'), `the turn animation must survive the settle:\n${view}`)
  assert.ok(!view.includes('Compacting') && !view.includes('Applying compacted'),
    `the compaction surface must clear:\n${view}`)
  app.stop()
})

test('a stale compaction/end never reaches the settle refresh', () => {
  // The runner invokes settleCompactionSurface ONLY on compacted.clear;
  // a stale end folds to clear=false, so the status refresh cannot fire
  // for a foreign compaction's settle.
  const state = { id: 'c2' as string | undefined }
  const stale = foldCompactionEvent(state, { type: 'compaction/end', data: { compactionId: 'c1' } })
  assert.equal(stale.clear, false, 'a stale end must not reach the settle path')
  // The current compaction's own end (success OR error) is the only
  // clear=true fold — the refresh fires exactly for that settle.
  const fresh = foldCompactionEvent(state, { type: 'compaction/end', data: { compactionId: 'c2' } })
  assert.equal(fresh.clear, true)
  const errEnd = foldCompactionEvent({ id: 'c3' }, { type: 'compaction/end', data: { compactionId: 'c3', error: 'MAX_TOKENS' } })
  assert.equal(errEnd.clear, true, 'an error settle is still a matched settle: it must refresh too')
})
