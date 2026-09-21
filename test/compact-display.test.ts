/**
 * Compact display headless UI tests (PR3/F4 Core): Work span rendering and
 * disclosure, ambient Context clustering across presets, form-aware Context
 * rows, work boundaries, search reveal, and the content-refresh contract.
 * @module @xmoon76/dsh-pi-tui/compact-display.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'
import type { AssistantLiveChunk, AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import { TuiApp } from '../src/tui-app.ts'
import type { DisplayState } from '../src/display-preset.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const T0 = Date.now() - 60_000

function startApp(preset: DisplayState['preset']): { vt: VirtualTerminal; app: TuiApp; displayState: DisplayState } {
  const displayState: DisplayState = { preset }
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState })
  app.start()
  startedApps.add(app)
  return { vt, app, displayState }
}

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

interface LiveFoldable {
  apply(events: readonly SessionEvent[]): void
  applyLiveInput(input: AssistantLiveInput): void
}

function applyMixed(folder: LiveFoldable, events: readonly SessionEvent[]): void {
  for (const event of events) {
    const kind = event.type as string
    if (kind === 'assistant/chunk') {
      const data = event.data as { turn: number; step: number; chunk: AssistantLiveChunk }
      folder.applyLiveInput({ kind: 'chunk', sessionId: 'test', attemptId: 'attempt-1', turn: data.turn, step: data.step, time: event.time, chunk: data.chunk })
    } else {
      folder.apply([event])
    }
  }
}

function show(app: TuiApp, folder: TranscriptFolder): void {
  app.setTranscript(folder.messages(), folder.turnActivities())
}

function contextEvent(id: string, source: Record<string, unknown>, text: string, time: number, seq: number): SessionEvent {
  return eventAt('user/message', {
    id: MessageId(id), role: 'user',
    content: [{ type: 'text', text }],
    source,
  }, time, seq)
}

/** Turn 1: user, reasoning, one tool, intermediate assistant, more reasoning,
 * tool, final — the Compact Work chronology fixture. */
function workFixture(): SessionEvent[] {
  return [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('user/message', {
      id: MessageId('u1'), role: 'user',
      content: [{ type: 'text', text: 'check the transcript' }],
      source: { kind: 'user' },
    }, T0 + 1, 1),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'verifying upstream wake semantics...' } }, T0 + 2, 2),
    eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: JSON.stringify({ path: 'src/tui-app.ts' }) }, T0 + 3, 3),
    eventAt('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: 'ok' }] }],
        source: { kind: 'tool', callId: ToolCallId('c1') },
      },
    }, T0 + 4, 4),
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'I found where the stale viewport identity is introduced.' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, T0 + 5, 5),
    eventAt('assistant/chunk', { turn: 1, step: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'checking the current mount transaction...' } }, T0 + 6, 6),
    eventAt('tool/call', { turn: 1, step: 2, callId: ToolCallId('c2'), name: 'bash', arguments: JSON.stringify({ command: 'pnpm test transcript-search' }) }, T0 + 7, 7),
    eventAt('assistant/message', {
      turn: 1, step: 3,
      message: { id: MessageId('a2'), role: 'assistant', content: [{ type: 'text', text: 'final answer' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, T0 + 8, 8),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 9000, 9),
  ]
}

function workHeaders(view: string, expanded?: boolean): string[] {
  const glyph = expanded === undefined ? '(?:▸|▾)' : expanded ? '▾' : '▸'
  return view.split('\n').filter(line => new RegExp(`^\\s*${glyph} Work(?: ·|$)`).test(line))
}

function clusterHeaders(view: string, expanded?: boolean): string[] {
  const glyph = expanded === undefined ? '(?:▸|▾)' : expanded ? '▾' : '▸'
  return view.split('\n').filter(line => new RegExp(`^\\s*${glyph} Context ·`).test(line))
}

function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

function rowOf(view: readonly string[], pattern: RegExp): number {
  return view.findIndex(line => pattern.test(line))
}

test('Compact renders Work headers with Think/Tool previews and no Message slot', async () => {
  const { vt, app } = startApp('compact')
  const folder = new TranscriptFolder()
  applyMixed(folder, workFixture())
  show(app, folder)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')

  assert.equal(workHeaders(view).length, 2, `expected two contiguous Work spans:\n${view}`)
  assert.match(view, /▸ Work · 1 tool · thinking/)
  assert.match(view, /▸ Work · 1 tool · thinking/)
  assert.match(view, /Think:\s+verifying upstream wake semantics/)
  assert.match(view, /Tool:\s+✓ Read src\/tui-app\.ts/)
  assert.match(view, /Think:\s+checking the current mount transaction/)
  assert.match(view, /Tool:\s+Bash pnpm test transcript-search/)
  assert.ok(view.includes('I found where the stale viewport identity is introduced.'),
    'the assistant intermediate narration stays visible in chronology')
  assert.ok(view.includes('final answer'))
  assert.ok(!view.includes('Message:'), 'Compact Work has no Message slot')
})

test('a Work header click expands its member rows and collapses again', async () => {
  const { vt, app } = startApp('compact')
  const folder = new TranscriptFolder()
  applyMixed(folder, workFixture())
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport()
  const headerRow = rowOf(view, /▸ Work · 1 tool · thinking/)
  assert.ok(headerRow >= 0, 'precondition: the first Work header is visible')
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0)

  click(vt, 3, headerRow + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 1, 'the header click opens exactly its own span')
  assert.equal(workHeaders(view.join('\n'), true).length, 1, 'the opened span renders the expanded glyph')
  assert.equal(workHeaders(view.join('\n'), false).length, 1, 'the other span stays collapsed')

  const expandedRow = rowOf(view, /▾ Work · 1 tool · thinking/)
  // A different column avoids the fork's double-click word-selection gesture.
  click(vt, 5, expandedRow + 1)
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0, `a second click collapses the span:\n${vt.getViewport().join('\n')}`)
})

test('Ctrl+O owns the Compact Work-span bulk in both directions', async () => {
  const { vt, app } = startApp('compact')
  const folder = new TranscriptFolder()
  applyMixed(folder, workFixture())
  show(app, folder)
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0)
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 2, 'Ctrl+O expands the recent Work spans')
  assert.equal(workHeaders(vt.getViewport().join('\n'), true).length, 2)
  vt.sendInput('\x0f')
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0, 'Ctrl+O collapses every open Work span')
})

test('a search reveal temporarily opens the owning Work span and restores it on dismiss', async () => {
  const { vt, app } = startApp('compact')
  const folder = new TranscriptFolder()
  applyMixed(folder, workFixture())
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const hiddenThinking = folder.messages().find(message => message.kind === 'thinking' && message.text.includes('checking the current mount'))
  assert.ok(hiddenThinking !== undefined, 'fixture: the second Work reasoning row exists')
  assert.equal(workHeaders(vt.getViewport().join('\n'), true).length, 0,
    'precondition: the hidden member is not rendered while the span is collapsed')

  app.setTranscriptSearchTarget({
    query: 'checking the current mount',
    match: { id: 0, turn: 1, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: hiddenThinking,
  })
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0, 'the temporary reveal never writes the manual state')
  assert.equal(workHeaders(vt.getViewport().join('\n'), true).length, 1, 'exactly the owning span opens')
  assert.ok(vt.getViewport().join('\n').includes('Thinking'), 'the revealed member renders its own card')

  app.setTranscriptSearchTarget(undefined)
  await vt.waitForRender()
  assert.equal(workHeaders(vt.getViewport().join('\n'), true).length, 0, 'dismissing the search restores the collapsed span')
})

test('a Work span opened only by the search reveal collapses by revoking the reveal', async () => {
  const { vt, app } = startApp('compact')
  const folder = new TranscriptFolder()
  applyMixed(folder, workFixture())
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const hiddenThinking = folder.messages().find(message => message.kind === 'thinking' && message.text.includes('checking the current mount'))
  assert.ok(hiddenThinking !== undefined)
  app.setTranscriptSearchTarget({
    query: 'checking the current mount',
    match: { id: 0, turn: 1, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: hiddenThinking,
  })
  await vt.waitForRender()
  const revealedRow = rowOf(vt.getViewport(), /▾ Work · 1 tool · thinking/)
  assert.ok(revealedRow >= 0, 'precondition: the granted reveal opened the owning span')
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0)

  // An explicit click on a reveal-only span must COLLAPSE it (revoke the
  // temporary reveal), never write a manual owner that outlives the search.
  click(vt, 5, revealedRow + 1)
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0,
    'collapsing a reveal-only span must not promote it to a manual disclosure')
  assert.equal(workHeaders(vt.getViewport().join('\n'), true).length, 0, 'the reveal is revoked')

  // The semantic target survives the revocation; dismissal keeps it collapsed.
  app.setTranscriptSearchTarget(undefined)
  await vt.waitForRender()
  assert.equal(workHeaders(vt.getViewport().join('\n'), true).length, 0, 'dismissal never resurrects the revoked reveal')
})

test('the live Preparing state belongs only to the newest Work span of a turn', async () => {
  const { vt, app } = startApp('compact')
  app.setTranscript([
    { kind: 'thinking', turn: 1, text: 'first reasoning' },
    { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'ok', status: 'ok' },
    { kind: 'assistant', turn: 1, text: 'between the spans' },
    { kind: 'thinking', turn: 1, text: 'second reasoning' },
  ], new Map(), undefined, [
    { callId: 'preparing-1', argumentBytes: 3, turn: 1, step: 0, index: 0, name: 'bash', summary: 'pnpm test' },
  ])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.equal(workHeaders(view).length, 2, `expected two Work spans:\n${view}`)
  assert.equal(view.split('\n').filter(line => line.includes('Preparing')).length, 1,
    `the preparing call must render exactly once (no duplicate Tool row):\n${view}`)
})

test('a Work header stays inspectable while a Question owns the modal', async () => {
  const { vt, app } = startApp('compact')
  const folder = new TranscriptFolder()
  applyMixed(folder, workFixture())
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const promise = app.askQuestions([{ id: 'q1', question: 'Inspect context?', options: [{ label: 'Continue' }] }])
  await vt.waitForRender()
  const row = rowOf(vt.getViewport(), /▸ Work · 1 tool · thinking/)
  assert.ok(row >= 0, `collapsed Work header missing behind the Question:\n${vt.getViewport().join('\n')}`)

  click(vt, 5, row + 1)
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 1, 'the read-only Work disclosure must work behind a Question')
  assert.ok(workHeaders(vt.getViewport().join('\n'), true).length === 1)
  assert.ok(vt.getViewport().join('\n').includes('Inspect context?'), 'the Question must remain mounted after the disclosure')

  vt.sendInput('1')
  await vt.waitForRender()
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Continue'] }])
})

test('a Work row is a semantic viewport anchor and survives its own toggle', async () => {
  const { vt, app } = startApp('compact')
  const folder = new TranscriptFolder()
  applyMixed(folder, [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'only reasoning' } }, T0 + 1, 1),
    eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: '{}' }, T0 + 2, 2),
  ])
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  app.scrollToTop()
  await vt.waitForRender()
  const anchor = app.captureTranscriptViewportAnchor()
  assert.equal(anchor?.top?.rowKind, 'work',
    `the first visible transcript row is the Work span and must be a semantic anchor:\n${vt.getViewport().join('\n')}`)
  const owner = anchor?.top?.workOwner
  assert.ok(owner !== undefined, 'the Work anchor carries its stable owner identity')

  app.toggleWorkSpan(owner)
  await vt.waitForRender()
  assert.equal(app.restoreTranscriptViewportAnchor(anchor!, 'top'), true,
    'the anchored Work row must still resolve after its own disclosure toggle')
})

test('a live reasoning tail inside a Work span uses a content refresh, not a structural rebuild', async () => {
  const { app } = startApp('compact')
  const folder = new TranscriptFolder()
  applyMixed(folder, workFixture().slice(0, 3))
  show(app, folder)
  app.resetTranscriptPresentationDiagnosticsForTest()
  const before = app.transcriptPresentationDiagnosticsForTest()
  // A live reasoning delta mutates the SAME thinking object in place: the
  // Work topology is unchanged, so the commit must be content-only.
  folder.applyLiveInput({ kind: 'chunk', sessionId: 'test', attemptId: 'attempt-1', turn: 1, step: 0, time: T0 + 100, chunk: { type: 'reasoning-delta', index: 0, text: ' tail' } })
  show(app, folder)
  const after = app.transcriptPresentationDiagnosticsForTest()
  assert.equal(after.structuralCommits - before.structuralCommits, 0,
    'a live reasoning tail must not rebuild the whole transcript structurally')
  assert.equal(after.contentCommits - before.contentCommits, 1)
})

test('raw-adjacent ambient Context clusters in Compact, Focus, and Full', async () => {
  for (const preset of ['compact', 'focus', 'full'] as const) {
    const { vt, app } = startApp(preset)
    const folder = new TranscriptFolder()
    applyMixed(folder, [
      eventAt('turn/start', { turn: 1 }, T0, 0),
      eventAt('user/message', { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, T0 + 1, 1),
      contextEvent('ctx-a', { kind: 'plugin', form: 'instructions', plugin: 'agent-instructions', changes: [{ path: 'AGENTS.md' }] }, 'instructions body', T0 + 2, 2),
      contextEvent('ctx-b', { kind: 'plugin', form: 'catalog', plugin: 'skill-catalog' }, 'catalog body', T0 + 3, 3),
      eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'reasoning' } }, T0 + 4, 4),
      eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: '{}' }, T0 + 5, 5),
    ])
    show(app, folder)
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.equal(clusterHeaders(view).length, 1, `${preset}: the ambient pair must cluster once:\n${view}`)
    assert.match(view, /Context · 2 injections/)
    assert.match(view, /agent-instructions · skill-catalog/)
    app.dispose()
    startedApps.delete(app)
  }
})

test('hidden Process rows never merge two Context rows into a false cluster', async () => {
  const { vt, app } = startApp('focus')
  const folder = new TranscriptFolder()
  applyMixed(folder, [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('user/message', { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, T0 + 1, 1),
    contextEvent('ctx-a', { kind: 'plugin', form: 'instructions', plugin: 'agent-instructions' }, 'instructions A', T0 + 2, 2),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'hidden reasoning' } }, T0 + 3, 3),
    eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: '{}' }, T0 + 4, 4),
    contextEvent('ctx-b', { kind: 'plugin', form: 'catalog', plugin: 'skill-catalog' }, 'catalog B', T0 + 5, 5),
  ])
  show(app, folder)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.equal(clusterHeaders(view).length, 0, 'a Process row between the rows forbids grouping')
  assert.ok(view.includes('Context injection agent-instructions'))
  assert.ok(view.includes('Context injection skill-catalog'))
})

test('an ambient cluster expands into every member row and collapses again', async () => {
  const { vt, app } = startApp('compact')
  const folder = new TranscriptFolder()
  applyMixed(folder, [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    contextEvent('ctx-a', { kind: 'plugin', form: 'instructions', plugin: 'agent-instructions', changes: [{ path: 'AGENTS.md' }] }, 'instructions body', T0 + 1, 1),
    contextEvent('ctx-b', { kind: 'plugin', form: 'catalog', plugin: 'skill-catalog' }, 'catalog body', T0 + 2, 2),
  ])
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  const headerRow = rowOf(vt.getViewport(), /▸ Context · 2 injections/)
  assert.ok(headerRow >= 0, 'precondition: the cluster header is visible')
  click(vt, 3, headerRow + 1)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.equal(app.compactExpandedClustersForTest().size, 1)
  assert.equal(clusterHeaders(view, true).length, 1)
  assert.ok(view.includes('Context injection agent-instructions'), 'every member row renders when open')
  assert.ok(view.includes('Context injection skill-catalog'))
})

test('expanded Focus restores the opening ambient burst above the Thought and the mid-turn burst in place', async () => {
  const { vt, app } = startApp('focus')
  const folder = new TranscriptFolder()
  applyMixed(folder, [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('user/message', { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, T0 + 1, 1),
    contextEvent('ctx-a', { kind: 'plugin', form: 'instructions', plugin: 'agent-instructions' }, 'A', T0 + 2, 2),
    contextEvent('ctx-b', { kind: 'plugin', form: 'catalog', plugin: 'skill-catalog' }, 'B', T0 + 3, 3),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'reasoning' } }, T0 + 4, 4),
    eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: '{}' }, T0 + 5, 5),
    contextEvent('ctx-c', { kind: 'plugin', form: 'instructions', plugin: 'agent-instructions' }, 'C', T0 + 6, 6),
    contextEvent('ctx-d', { kind: 'plugin', form: 'snapshot', plugin: 'runtime-context' }, 'D', T0 + 7, 7),
    eventAt('assistant/message', { turn: 1, step: 1, message: { id: MessageId('a1'), role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } } }, T0 + 8, 8),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 9, 9),
  ])
  show(app, folder)
  await vt.waitForRender()
  assert.equal(clusterHeaders(vt.getViewport().join('\n')).length, 2, 'collapsed Focus surfaces both clusters')

  app.setFullscreen(true)
  app.toggleFocusTurn(1)
  await vt.waitForRender()
  const view = vt.getViewport()
  const joined = view.join('\n')
  assert.equal(clusterHeaders(joined).length, 2, 'both clusters survive the expansion')
  const thoughtRow = rowOf(view, /Working|Turn complete|▾ 🐳|🐳/)
  const firstCluster = rowOf(view, /Context · 2 injections/)
  const toolRow = rowOf(view, /Tool\|Read|Read\b/)
  assert.ok(firstCluster >= 0 && thoughtRow >= 0, `expected a Thought and an opening cluster:\n${joined}`)
  // The opening burst stays above the Thought; the mid-turn burst follows the process.
  const clusterRows = view.flatMap((line, index) => /Context · 2 injections/.test(line) ? [index] : [])
  assert.equal(clusterRows.length, 2)
  assert.ok(clusterRows[0]! < thoughtRow, 'the opening ambient burst stays above the Thought')
  assert.ok(clusterRows[1]! > (toolRow >= 0 ? toolRow : thoughtRow), 'the mid-turn burst keeps its chronological position')
})

test('notice, relay, and recall are standalone Context rows and never enter Work or a cluster', async () => {
  const { vt, app } = startApp('compact')
  const folder = new TranscriptFolder()
  applyMixed(folder, [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'reasoning one' } }, T0 + 1, 1),
    eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: '{}' }, T0 + 2, 2),
    contextEvent('notice', { kind: 'subagent-settled', form: 'notice', summary: 'child completed with two findings', senderSessionId: 'child-9' }, 'notice payload', T0 + 3, 3),
    contextEvent('relay', { kind: 'agent-message', form: 'relay', senderSessionId: 'child-2' }, 'There are two need-fix issues in the search restoration path.', T0 + 4, 4),
    contextEvent('recall', { kind: 'session-reference', form: 'recall', references: [{ label: 'prior work' }] }, 'recalled payload', T0 + 5, 5),
    eventAt('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'reasoning two' } }, T0 + 6, 6),
    eventAt('tool/call', { turn: 1, step: 1, callId: ToolCallId('c2'), name: 'bash', arguments: '{}' }, T0 + 7, 7),
  ])
  show(app, folder)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.equal(clusterHeaders(view).length, 0, 'notice/relay/recall never cluster')
  assert.equal(workHeaders(view).length, 2, 'each standalone Context row is a Work boundary')
  assert.ok(view.includes('child completed with two findings'), 'the notice summary is visible while collapsed')
  assert.ok(view.includes('Agent message · child-2'), 'the relay names its sender')
  assert.ok(view.includes('There are two need-fix issues in the search restoration path.'), 'the relay body is visible by default')
  assert.ok(view.includes('Session recall · prior work'), 'the recall names its labels')
  assert.ok(!view.includes('Context injection subagent-settled'), 'a known notice is never generic Context copy')
  assert.ok(!view.includes('Context injection agent-message'), 'a known relay is never generic Context copy')
})

test('Context rows never occupy the Focus slots or counts', async () => {
  const { vt, app } = startApp('focus')
  const folder = new TranscriptFolder()
  applyMixed(folder, [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    eventAt('user/message', { id: MessageId('u1'), role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }, T0 + 1, 1),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'the real reasoning' } }, T0 + 2, 2),
    eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'read', arguments: JSON.stringify({ path: 'src/index.ts' }) }, T0 + 3, 3),
    contextEvent('notice', { kind: 'subagent-settled', form: 'notice', summary: 'child settled summary', senderSessionId: 'child-9' }, 'notice payload', T0 + 4, 4),
    contextEvent('relay', { kind: 'agent-message', form: 'relay', senderSessionId: 'child-2' }, 'relay body text', T0 + 5, 5),
  ])
  show(app, folder)
  await vt.waitForRender()
  assert.equal(folder.turnActivity(1)?.toolCalls, 1, 'Context rows never count as tools')
  assert.equal(folder.turnActivity(1)?.think?.text, 'the real reasoning', 'Context never owns the Think slot')
  const view = vt.getViewport().join('\n')
  assert.match(view, /1 tool/, 'the header count describes the real tool only')
  assert.match(view, /Think:\s+the real reasoning/)
  assert.ok(view.includes('child settled summary'))
  assert.ok(view.includes('Agent message · child-2'))
})

test('form-aware Context rows are render-time width-aware, not width-baked', async () => {
  const { app } = startApp('full')
  const folder = new TranscriptFolder()
  applyMixed(folder, [
    eventAt('turn/start', { turn: 1 }, T0, 0),
    contextEvent('notice', { kind: 'subagent-settled', form: 'notice', summary: 'a summary', senderSessionId: 'child-9' }, 'notice payload', T0 + 1, 1),
    contextEvent('relay', { kind: 'agent-message', form: 'relay', senderSessionId: 'child-2' }, 'a relay body', T0 + 2, 2),
    contextEvent('legacy', { kind: 'plugin', plugin: 'legacy-injector' }, 'generic body', T0 + 3, 3),
  ])
  show(app, folder)
  const messages = folder.messages()
  const notice = messages.find(message => message.kind === 'system' && message.contextPresentation?.form === 'notice')
  const relay = messages.find(message => message.kind === 'system' && message.contextPresentation?.form === 'relay')
  const legacy = messages.find(message => message.kind === 'system' && message.contextPresentation?.form === undefined)
  assert.ok(notice !== undefined && relay !== undefined && legacy !== undefined)
  // The collapsed fold boundary: nothing is auto-expanded.
  const collapsedBoundary = Number.POSITIVE_INFINITY
  assert.equal(app.messageCacheEntryForTest(notice, collapsedBoundary)?.builtWidth, undefined, 'the notice summary re-wraps at render time')
  assert.equal(app.messageCacheEntryForTest(relay, collapsedBoundary)?.builtWidth, undefined, 'the relay body re-wraps at render time')
  assert.notEqual(app.messageCacheEntryForTest(legacy, collapsedBoundary)?.builtWidth, undefined, 'a generic folded Context row still bakes its one-line width')
})
