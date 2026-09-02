/**
 * Regression tests for the subagent viewer content boundary: a fork
 * provider seeds the child session with the PARENT's completed-turn
 * history (session/end-seed marker), and the viewer must never render
 * that parent history — its subagent completion notices included — as
 * the child's transcript.
 * @module @xmoon76/dsh-pi-tui/child-view.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { childOwnEvents, TranscriptFolder } from '../src/transcript.ts'

function event(seq: number, type: string, data: Record<string, unknown> = {}): SessionEvent {
  return { type, seq, time: 1, data } as SessionEvent
}

/** A parent-history settlement notice (must never reach the viewer). */
const parentNotice = event(5, 'user/message', {
  content: [{ type: 'text', text: 'Background subagent parent-child finished and will do no further work' }],
  source: { kind: 'subagent-settled', form: 'notice', summary: 'Background subagent parent-child finished', senderSessionId: 'session-parent-child' },
})

test('childOwnEvents drops the seeded parent history after the last end-seed', () => {
  const log = [
    event(0, 'user/message', { content: [{ type: 'text', text: 'parent prompt' }], source: { kind: 'user' } }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'parent reply' }] } }),
    parentNotice,
    event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(7, 'session/end-seed', {}),
    event(8, 'user/message', { content: [{ type: 'text', text: 'child prompt' }], source: { kind: 'user' } }),
    event(9, 'turn/start', { turn: 1 }),
    event(10, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] } }),
  ]
  const own = childOwnEvents(log)
  assert.equal(own.length, 3, 'only the child events after the seed marker survive')
  assert.ok(!own.some(e => e.seq <= 7), 'no seeded parent event may survive')
  assert.equal(own[0]!.seq, 8)
  assert.equal(own[2]!.seq, 10)
})

test('childOwnEvents keeps everything for an unseeded (spawned) child', () => {
  const log = [
    event(0, 'user/message', { content: [{ type: 'text', text: 'child prompt' }], source: { kind: 'user' } }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] } }),
  ]
  assert.equal(childOwnEvents(log), log, 'no seed marker means everything is the child\'s own')
})

test('childOwnEvents uses the LAST marker when the child itself was resumed', () => {
  const log = [
    event(0, 'user/message', { content: [{ type: 'text', text: 'parent prompt' }], source: { kind: 'user' } }),
    event(1, 'session/end-seed', {}),
    event(2, 'user/message', { content: [{ type: 'text', text: 'child first turn' }], source: { kind: 'user' } }),
    event(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(4, 'session/end-seed', {}), // the child's stored log became a new seed on resume
    event(5, 'user/message', { content: [{ type: 'text', text: 'child resumed turn' }], source: { kind: 'user' } }),
  ]
  const own = childOwnEvents(log)
  assert.equal(own.length, 1)
  assert.equal(own[0]!.seq, 5, 'only the post-resume events are the child\'s own')
})

test('the viewer transcript never shows a seeded parent completion notice', () => {
  // The full child log AS PERSISTED: the fork seed (parent history, with
  // the parent's own subagent-settled notice) + the marker + child events.
  const log = [
    event(0, 'user/message', { content: [{ type: 'text', text: 'parent prompt' }], source: { kind: 'user' } }),
    parentNotice,
    event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(7, 'session/end-seed', {}),
    event(8, 'user/message', { content: [{ type: 'text', text: 'child prompt' }], source: { kind: 'user' } }),
    event(9, 'turn/start', { turn: 1 }),
    event(10, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] } }),
  ]
  const folder = new TranscriptFolder()
  folder.apply(childOwnEvents(log))
  const messages = folder.messages()
  const text = messages.map(m => 'text' in m ? m.text : '').join('\n')
  assert.ok(text.includes('child prompt'), `the child's own message must show:\n${text}`)
  assert.ok(!text.includes('subagent-settled'), `the parent's completion notice must NOT render in the viewer:\n${text}`)
  assert.ok(!text.includes('Background subagent parent-child'), `the notice body must not leak:\n${text}`)
})

// ── viewer content isolation (TuiApp level) ──────────────────────────────

import { TuiApp } from '../src/tui-app.ts'
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

test('entering the viewer clears the main session local cards', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  // A main-session `!` shell card exists before the viewer opens.
  app.pushLocalMessage({ kind: 'tool', turn: 0, name: 'bash', args: '!ls', result: 'done', status: 'ok' })
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('!ls'), `the local card must render before the viewer:\n${view}`)

  app.setViewerMode({ parentSessionId: 'session-main', childSessionId: 'session-child', label: 'child', mode: 'one-shot', activity: 'inactive' })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('!ls'), `the main session local card must not leak into the viewer:\n${view}`)

  // Exiting restores the main transcript; the cleared local cards stay gone
  // (the runner repaints the main folder on exit).
  app.setViewerMode(undefined)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('!ls'), `the local card must not reappear after the viewer:\n${view}`)
  app.stop()
})
