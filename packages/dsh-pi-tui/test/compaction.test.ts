/**
 * Headless tests for the compaction progress/completion surface
 * (requirement 5): the transcript card (start → summary → end folding),
 * the working-row "Compacting context…" label, and the firehose state
 * pairing (a stale compaction/end never clears a newer compaction).
 * @module @xmoon76/dsh-pi-tui/compaction.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { foldCompactionEvent, type CompactionFold } from '../src/index.ts'
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

test('a STALE compaction/end never clears a newer compaction', () => {
  const state = { id: 'c2' as string | undefined }
  const stale = foldCompactionEvent(state, { type: 'compaction/end', data: { compactionId: 'c1' } })
  assert.equal(stale.clear, false, 'a stale end must not clear the newer compaction')
  assert.equal(stale.id, 'c2', 'the newer compaction id survives')
  assert.ok(stale.notify !== undefined, 'the settle still notifies')
  // The newer compaction's own end clears it.
  const fresh = foldCompactionEvent(state, { type: 'compaction/end', data: { compactionId: 'c2' } })
  assert.equal(fresh.clear, true)
  assert.equal(fresh.id, undefined)
})

test('foldCompactionEvent ignores unrelated events', () => {
  const state = { id: 'c1' as string | undefined }
  const folded = foldCompactionEvent(state, { type: 'turn/end', data: {} })
  assert.deepEqual(folded, { id: 'c1', active: false, clear: false, notify: undefined } satisfies CompactionFold)
})
