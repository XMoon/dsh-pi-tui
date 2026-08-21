/**
 * Headless tests for the compaction progress/completion surface
 * (requirement 5): the transcript card (start → summary → end folding),
 * the working-row "Compacting context…" label, and the firehose state
 * pairing (a stale compaction/end never clears a newer compaction).
 * @module @xmoon76/dsh-pi-tui/compaction.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { busyAfterTurnBoundary, compactingFromLog, foldCompactionEvent, type CompactionFold } from '../src/index.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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
  assert.deepEqual(start, { id: 'c1', active: true, clear: false, notify: undefined })
  state.id = start.id

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
