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

test('childOwnEvents cuts seeded parent history after the inherited ownership marker', () => {
  const log = [
    event(0, 'user/message', { content: [{ type: 'text', text: 'parent prompt' }], source: { kind: 'user' } }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'parent reply' }] } }),
    parentNotice,
    event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(7, 'session/end-seed', { inherited: true }),
    event(8, 'user/message', { content: [{ type: 'text', text: 'child prompt' }], source: { kind: 'user' } }),
    event(9, 'turn/start', { turn: 1 }),
    event(10, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] } }),
  ]
  const own = childOwnEvents(log)
  assert.deepEqual(own.map(candidate => candidate.seq), [8, 9, 10], 'only events after the ownership marker survive')
  assert.ok(!own.some(candidate => JSON.stringify(candidate.data).includes('parent')), 'parent content must not survive')
})

test('childOwnEvents keeps everything for an unseeded (spawned) child', () => {
  const log = [
    event(0, 'user/message', { content: [{ type: 'text', text: 'child prompt' }], source: { kind: 'user' } }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] } }),
    event(3, 'session/end-seed', {}),
  ]
  assert.equal(childOwnEvents(log), log, 'without an inherited marker every event is the child\'s own')
})

test('childOwnEvents keeps child history across every untagged resume marker', () => {
  const log = [
    event(0, 'user/message', { content: [{ type: 'text', text: 'parent prompt' }], source: { kind: 'user' } }),
    event(1, 'session/end-seed', { inherited: true }),
    event(2, 'user/message', { content: [{ type: 'text', text: 'child first turn' }], source: { kind: 'user' } }),
    event(3, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child first reply' }] } }),
    event(4, 'session/end-seed', {}),
    event(5, 'user/message', { content: [{ type: 'text', text: 'child resumed turn' }], source: { kind: 'user' } }),
    event(6, 'assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child resumed reply' }] } }),
    event(7, 'session/end-seed', {}),
    event(8, 'user/message', { content: [{ type: 'text', text: 'child third turn' }], source: { kind: 'user' } }),
  ]
  const own = childOwnEvents(log)
  assert.deepEqual(own.map(candidate => candidate.seq), [2, 3, 4, 5, 6, 7, 8])
  const text = own.map(candidate => JSON.stringify(candidate.data)).join('\n')
  assert.ok(text.includes('child first turn'))
  assert.ok(text.includes('child first reply'))
  assert.ok(text.includes('child resumed turn'))
  assert.ok(text.includes('child resumed reply'))
  assert.ok(text.includes('child third turn'))
  assert.ok(!text.includes('parent prompt'))
})

test('childOwnEvents uses the LAST inherited marker for nested fork history', () => {
  const log = [
    event(0, 'user/message', { content: [{ type: 'text', text: 'ancestor prompt' }], source: { kind: 'user' } }),
    event(1, 'session/end-seed', { inherited: true }),
    event(2, 'user/message', { content: [{ type: 'text', text: 'parent child prompt' }], source: { kind: 'user' } }),
    event(3, 'session/end-seed', { inherited: true }),
    event(4, 'user/message', { content: [{ type: 'text', text: 'current child prompt' }], source: { kind: 'user' } }),
  ]
  const own = childOwnEvents(log)
  assert.deepEqual(own.map(candidate => candidate.seq), [4])
  assert.ok(JSON.stringify(own[0]!.data).includes('current child prompt'))
  assert.ok(!JSON.stringify(own[0]!.data).includes('parent child prompt'))
})

test('the viewer transcript never shows a seeded parent completion notice', () => {
  // The full child log AS PERSISTED: the fork seed (parent history, with
  // the parent's own subagent-settled notice) + the marker + child events.
  const log = [
    event(0, 'user/message', { content: [{ type: 'text', text: 'parent prompt' }], source: { kind: 'user' } }),
    parentNotice,
    event(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    event(7, 'session/end-seed', { inherited: true }),
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

test('the child viewer keeps the child full assistant surface (never text-only)', () => {
  // 0.1.6's parent settlement notice projects only the child's closing TEXT
  // blocks; that filtering belongs to the Host and must never shrink the
  // CHILD viewer's own transcript. The child's tool cards survive alongside
  // the text, so the viewer is not a text-only projection.
  const log = [
    event(0, 'user/message', { content: [{ type: 'text', text: 'child prompt' }], source: { kind: 'user' } }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] } }),
    event(3, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }),
    event(4, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'msg-4',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'TOOL OUTPUT' }] }],
        source: { kind: 'tool', callId: 'call-1' },
      },
    }),
    event(5, 'assistant/message', { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'text', text: 'child closing' }] } }),
  ]
  const folder = new TranscriptFolder()
  folder.apply(log)
  const messages = folder.messages()
  const kinds = messages.map(message => message.kind)
  assert.ok(kinds.includes('assistant'), `the child's assistant text must survive:\n${JSON.stringify(kinds)}`)
  assert.ok(kinds.includes('tool'), `the child's tool card must survive (never trimmed to text-only):\n${JSON.stringify(kinds)}`)
  const text = messages.map(message => 'text' in message ? message.text : '').join('\n')
  assert.ok(text.includes('child reply'), `first reply missing:\n${text}`)
  assert.ok(text.includes('child closing'), `closing reply missing:\n${text}`)
})

test('a parent settlement notice never alters the child viewer surface', () => {
  // The parent's subagent-settled notice is seeded BEFORE the ownership
  // marker; the child's OWN folded surface must be byte-identical with and
  // without it (the parent projection must not shrink the child's output).
  const childLog = [
    event(8, 'user/message', { content: [{ type: 'text', text: 'child prompt' }], source: { kind: 'user' } }),
    event(9, 'turn/start', { turn: 1 }),
    event(10, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] } }),
    event(11, 'tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }),
    event(12, 'tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'msg-12',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: 'TOOL OUTPUT' }] }],
        source: { kind: 'tool', callId: 'call-1' },
      },
    }),
  ]
  const withParent = new TranscriptFolder()
  withParent.apply(childOwnEvents([parentNotice, event(7, 'session/end-seed', { inherited: true }), ...childLog]))
  const withoutParent = new TranscriptFolder()
  withoutParent.apply(childLog)
  assert.deepEqual(withParent.messages(), withoutParent.messages(),
    'the parent settlement projection must not change the child viewer surface')
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

test('B04: a child log with a descriptor keeps its viewer identity without a fake Subagent card', async () => {
  // Post-PR166 convergence: `subagent/descriptor` is child identity METADATA
  // and materializes no TranscriptMessage. The viewer's authoritative
  // chrome/footer state (label, mode) still identifies the child, proving we
  // removed the duplicate identity CARD rather than the identity itself.
  const log = [
    event(0, 'subagent/descriptor', { version: 2, mode: 'continuable', provider: 'in-process', label: 'scout-child', agentModel: 'deepseek-chat' }),
    event(1, 'turn/start', { turn: 1 }),
    event(2, 'user/message', { content: [{ type: 'text', text: 'child prompt' }], source: { kind: 'user' }, turn: 1 }),
    event(3, 'assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }], source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }),
    event(4, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const folder = new TranscriptFolder()
  folder.apply(childOwnEvents(log))
  const messages = folder.messages()
  assert.deepEqual(messages.map(message => message.kind).sort(), ['assistant', 'user'],
    'the descriptor row is absent while the child content survives')

  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  app.setViewerMode({ parentSessionId: 'session-main', childSessionId: 'session-child', label: 'scout-child', mode: 'continuable', activity: 'running' })
  // The runner's viewer-open footer commit: the identity block renders the
  // badge (mode), the label and the activity from the AUTHORITATIVE viewer
  // state — the exact identity the descriptor card used to duplicate.
  app.setViewerFooter({
    label: 'scout-child', childSessionId: 'session-child', mode: 'continuable', activity: 'running',
    cwd: '', turns: 1, steps: 1, statsLine: '',
  })
  app.setTranscript(messages, folder.turnActivities())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('child prompt'), `the child transcript body renders:\n${view}`)
  assert.ok(view.includes('scout-child'), `the viewer chrome keeps the authoritative child label:\n${view}`)
  assert.ok(view.includes('[subagent · continuable]'), `the mode identity stays in the viewer footer:\n${view}`)
  assert.ok(view.includes('running'), `the child activity stays in the viewer footer:\n${view}`)
  assert.ok(!view.includes('mode: continuable'), `no fake Subagent identity card renders:\n${view}`)
  assert.ok(!view.toLowerCase().includes('deepseek-chat'), `the descriptor metadata never renders:\n${view}`)
  app.stop()
})
