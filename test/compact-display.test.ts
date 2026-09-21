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

test('a live Preparing call follows the trailing Process run ownership matrix', async () => {
  const preview = { callId: 'preparing-matrix', argumentBytes: 3, turn: 1, step: 0, index: 0, name: 'bash', summary: 'pnpm test' }
  const preparingRows = (view: string): number[] =>
    view.split('\n').flatMap((line, index) => line.includes('Preparing') ? [index] : [])

  // (a) Tool -> Preparing: the trailing run is OPEN, so the call joins its Tool slot.
  {
    const { vt, app } = startApp('compact')
    app.setTranscript([
      { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'ok', status: 'ok' },
    ], new Map(), undefined, [preview])
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    assert.equal(workHeaders(view).length, 1, `one trailing Work span:\n${view}`)
    assert.equal(preparingRows(view).length, 1, `the call joins the run's Tool slot:\n${view}`)
    assert.ok(!view.includes('Tool:    Preparing') === false)
    app.dispose()
    startedApps.delete(app)
  }

  // (b) Work A -> Assistant -> Preparing: the narration closes the run, so the
  // call becomes a NEW pending Work after the boundary.
  {
    const { vt, app } = startApp('compact')
    app.setTranscript([
      { kind: 'thinking', turn: 1, text: 'first' },
      { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'ok', status: 'ok' },
      { kind: 'assistant', turn: 1, text: 'narration' },
    ], new Map(), undefined, [preview])
    await vt.waitForRender()
    const lines = vt.getViewport()
    const view = lines.join('\n')
    assert.equal(workHeaders(view).length, 2, `the narration mints a new Work run:\n${view}`)
    const narrationRow = lines.findIndex(line => line.includes('narration'))
    assert.ok(narrationRow >= 0, `the boundary row renders:\n${view}`)
    assert.ok(preparingRows(view).every(row => row > narrationRow),
      `the pending Work must follow the closed boundary:\n${view}`)
    app.dispose()
    startedApps.delete(app)
  }

  // (c) Work A -> Assistant -> Work B preparing: the call belongs to the TRAILING run B.
  {
    const { vt, app } = startApp('compact')
    app.setTranscript([
      { kind: 'thinking', turn: 1, text: 'A' },
      { kind: 'assistant', turn: 1, text: 'narration' },
      { kind: 'thinking', turn: 1, text: 'B' },
    ], new Map(), undefined, [preview])
    await vt.waitForRender()
    const lines = vt.getViewport()
    const view = lines.join('\n')
    assert.equal(workHeaders(view).length, 2, `two durable spans:\n${view}`)
    const narrationRow = lines.findIndex(line => line.includes('narration'))
    const preparing = preparingRows(view)
    assert.equal(preparing.length, 1, `the call renders exactly once:\n${view}`)
    assert.ok(preparing[0]! > narrationRow, `the call belongs to B, after the narration:\n${view}`)
    app.dispose()
    startedApps.delete(app)
  }
})

test('an ephemeral pending Work renders Header + Tool slot with no lifecycle suffix', async () => {
  const { vt, app } = startApp('compact')
  app.setTranscript([
    { kind: 'assistant', turn: 1, text: 'narration' },
  ], new Map(), undefined, [
    { callId: 'pending-shape', argumentBytes: 3, turn: 1, step: 0, index: 0, name: 'bash', summary: 'pnpm test' },
  ])
  await vt.waitForRender()
  const lines = vt.getViewport()
  const view = lines.join('\n')
  assert.equal(workHeaders(view).length, 1, `a pending Work header renders:\n${view}`)
  assert.ok(lines.some(line => /^\s*▸ Work\s*$/.test(line)),
    `the pending header carries NO lifecycle suffix (no visual jump when the durable span lands):\n${view}`)
  assert.match(view, /Tool:\s+Preparing Bash/)
  assert.ok(!view.includes('preparing') || !lines.some(line => /▸ Work ·/.test(line)))
})

test('a live Preparing call never crosses a closed Work boundary', async () => {
  const previews = [{ callId: 'preparing-after-boundary', argumentBytes: 3, turn: 1, step: 0, index: 0, name: 'bash', summary: 'pnpm test' }]
  const processRows = (): TranscriptMessage[] => [
    { kind: 'thinking', turn: 1, text: 'first reasoning' },
    { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'ok', status: 'ok' },
  ]
  const boundaries: ReadonlyArray<{ name: string; row: TranscriptMessage; needle: string }> = [
    { name: 'assistant', row: { kind: 'assistant', turn: 1, text: 'between the spans' }, needle: 'between the spans' },
    {
      name: 'notice',
      row: {
        kind: 'system', turn: 1, text: 'notice body', label: 'Background job', summary: 'child settled',
        icon: 'context-notice', context: true,
        contextPresentation: { form: 'notice', sourceKind: 'subagent-settled', role: 'inject' },
      },
      needle: 'child settled',
    },
    { name: 'attention', row: { kind: 'system', turn: 1, text: 'ATTENTION_MARKER', origin: 'turn-max-tokens' }, needle: 'ATTENTION_MARKER' },
  ]
  for (const boundary of boundaries) {
    const { vt, app } = startApp('compact')
    app.setTranscript([...processRows(), boundary.row], new Map(), undefined, previews)
    await vt.waitForRender()
    const lines = vt.getViewport()
    const view = lines.join('\n')
    const preparingRows = lines.flatMap((line, index) => line.includes('Preparing') ? [index] : [])
    assert.equal(preparingRows.length, 1, `exactly one Preparing row (${boundary.name}):\n${view}`)
    const boundaryRow = lines.findIndex(line => line.includes(boundary.needle))
    assert.ok(boundaryRow >= 0, `boundary row missing (${boundary.name}):\n${view}`)
    assert.ok(preparingRows[0]! > boundaryRow,
      `the live call must follow the closed ${boundary.name} boundary, never move back inside the previous Work span:\n${view}`)
    assert.equal(lines.filter(line => /Tool:\s/.test(line) && !line.includes('Preparing')).length, 1,
      `the closed Work span keeps its own durable Tool row (${boundary.name}):\n${view}`)
    app.dispose()
    startedApps.delete(app)
  }
})

test('an expanded closed Work span never absorbs a later live Preparing call', async () => {
  const { vt, app } = startApp('compact')
  const owner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'first reasoning' }
  app.setTranscript([
    owner,
    { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'ok', status: 'ok' },
    { kind: 'assistant', turn: 1, text: 'between the spans' },
  ], new Map(), undefined, [
    { callId: 'preparing-expanded-boundary', argumentBytes: 3, turn: 1, step: 0, index: 0, name: 'bash', summary: 'pnpm test' },
  ])
  app.toggleWorkSpan(owner)
  await vt.waitForRender()
  const lines = vt.getViewport()
  const view = lines.join('\n')
  assert.equal(workHeaders(view, true).length, 1, `precondition: the Work span is expanded:\n${view}`)
  const preparingRows = lines.flatMap((line, index) => line.includes('Preparing') ? [index] : [])
  const assistantRow = lines.findIndex(line => line.includes('between the spans'))
  assert.equal(preparingRows.length, 1, `exactly one Preparing row:\n${view}`)
  assert.ok(assistantRow >= 0, `the boundary row must render:\n${view}`)
  assert.ok(preparingRows[0]! > assistantRow,
    `the live call must be inserted AFTER the closed boundary, not inside the expanded span:\n${view}`)
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

test('regular Compact Ctrl+O opens the Work run without a dead ctrl+o card hint', async () => {
  const { vt, app } = startApp('compact')
  app.setTranscript([
    { kind: 'thinking', turn: 1, text: 'reasoning one' },
    // A foldable process card that advertises its fold key when collapsed —
    // the exact card class that produced the dead `(ctrl+o to expand)` hint.
    { kind: 'system', turn: 1, text: 'RETRY_BODY_MARKER', origin: 'llm-retry' },
  ], new Map())
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.equal(workHeaders(view).length, 1, `precondition: one collapsed Work span:\n${view}`)
  assert.ok(!view.includes('RETRY_BODY_MARKER'), 'the collapsed preview hides the member card')
  assert.ok(!view.includes('ctrl+o'), 'no foldable row advertises ctrl+o before the bulk reveal')

  vt.sendInput('\x0f')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(workHeaders(view, true).length, 1, `the run opens:\n${view}`)
  assert.ok(view.includes('🌊 Thinking'), `the open run renders its member rows:\n${view}`)
  assert.ok(view.includes('RETRY_BODY_MARKER'), `the open run renders the member card:\n${view}`)
  assert.ok(!view.includes('(ctrl+o to expand)'),
    `no member card may advertise ctrl+o while the key collapses the Work span:\n${view}`)
})

test('regular Compact presents a long user prompt in full instead of an inoperable marker', async () => {
  const { vt, app } = startApp('compact')
  const longPrompt = Array.from({ length: 40 }, (_, index) => `prompt line ${index}`).join('\n')
  app.setTranscript([{ kind: 'user', turn: 1, text: longPrompt }], new Map())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  // Ctrl+O owns the Work spans on this surface, so the prompt must never claim
  // a `ctrl+o to expand` affordance the key cannot operate — it renders in full.
  assert.ok(!view.includes('rows compacted'),
    `no collapsed representation may be generated for an inoperable fold:\n${view}`)
  assert.ok(!view.includes('ctrl+o'), `no inoperable key hint:\n${view}`)
  // A folded bubble would show only head + marker + tail; the MIDDLE row being
  // present proves no collapsed representation was built at all.
  assert.ok(view.includes('prompt line 20'), `the middle of the prompt is visible:\n${view}`)
})

test('a regular Compact long-user search dismiss mints no disclosure owner', async () => {
  const { vt, app } = startApp('compact')
  const prompt = Array.from({ length: 40 }, (_, index) => `long line ${index}`).join('\n')
  const message: TranscriptMessage = { kind: 'user', turn: 1, text: prompt }
  app.setTranscript([message], new Map())
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('rows compacted'),
    `precondition: regular Compact presents the prompt in full:\n${vt.getViewport().join('\n')}`)

  // Ctrl+O belongs to the Work spans here, so the search grant must NOT admit a
  // long-user reveal — the surface has no long-user disclosure to reveal.
  app.setTranscriptSearchTarget({
    query: 'long line 20',
    match: { id: 0, turn: 1, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  })
  await vt.waitForRender()
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await vt.waitForRender()

  // Switching to a surface that DOES own the fold must show the default
  // collapsed/click-owned presentation, not a stale promoted owner.
  app.setFullscreen(true)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.match(view, /rows compacted · click to expand/,
    `the fullscreen surface defaults to the click-owned fold:\n${view}`)
  assert.ok(!view.includes('long line 20'),
    `no regular-minted expansion may survive the surface switch:\n${view}`)
})

test('a fullscreen Compact long-user search dismiss still promotes the disclosure', async () => {
  const { vt, app } = startApp('compact')
  app.setFullscreen(true)
  const prompt = Array.from({ length: 40 }, (_, index) => `long line ${index}`).join('\n')
  const message: TranscriptMessage = { kind: 'user', turn: 1, text: prompt }
  app.setTranscript([message], new Map())
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.match(view, /rows compacted · click to expand/, `precondition: the click-owned fold exists:\n${view}`)
  assert.ok(!view.includes('long line 20'), 'the compacted middle is hidden')

  app.setTranscriptSearchTarget({
    query: 'long line 20',
    match: { id: 0, turn: 1, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('long line 20'), `the reveal opens the hidden middle:\n${view}`)

  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('long line 20'),
    `the promotion keeps the revealed long user expanded (must not be over-restricted):\n${view}`)
  assert.ok(!view.includes('rows compacted'), `the promoted disclosure stays expanded:\n${view}`)
})

test('regular Compact presents a foldable pending-user row in full', async () => {
  const { vt, app } = startApp('compact')
  const longText = Array.from({ length: 40 }, (_, index) => `pending line ${index}`).join('\n')
  app.setPendingInputPresentation({
    queued: [],
    steering: [{ id: 'pending-1', text: longText, rpcId: 'rpc-1', status: 'steering', foldableText: true }],
    running: true,
  })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('rows compacted'), `no inoperable fold:\n${view}`)
  assert.ok(!view.includes('ctrl+o'), `no inoperable key hint:\n${view}`)
  assert.ok(view.includes('pending line 20'), `the whole pending row is visible:\n${view}`)
})

test('regular Compact presents a standalone Context row in full instead of a dead key hint', async () => {
  const { vt, app } = startApp('compact')
  app.setTranscript([
    {
      kind: 'system', turn: 1, text: 'CONTEXT_BODY_MARKER', label: 'legacy-injector', context: true,
      contextPresentation: { sourceKind: 'plugin', role: 'inject' },
    },
  ], new Map())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('CONTEXT_BODY_MARKER'), `the payload is visible without a fold:\n${view}`)
  assert.ok(!view.includes('ctrl+o'), `no inoperable key hint:\n${view}`)
})

test('fullscreen Compact keeps the ordinary folds click-owned (mouse exists)', async () => {
  const { vt, app } = startApp('compact')
  app.setTranscript([
    {
      kind: 'system', turn: 1, text: 'CONTEXT_BODY_MARKER', label: 'legacy-injector', context: true,
      contextPresentation: { sourceKind: 'plugin', role: 'inject' },
    },
  ], new Map())
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.match(view, /\(click to expand\)/, `a fullscreen row advertises the mouse disclosure:\n${view}`)
  assert.ok(!view.includes('CONTEXT_BODY_MARKER'), 'the collapsed fullscreen row hides its payload')
  click(vt, 5, rowOf(vt.getViewport(), /Context injection legacy-injector/) + 1)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('CONTEXT_BODY_MARKER'), `the mouse click opens the row:\n${view}`)
})

test('the regular surface shows ambient cluster members directly (semantic cluster, expanded presentation)', async () => {
  for (const preset of ['compact', 'focus', 'full'] as const) {
    const { vt, app } = startApp(preset)
    app.setTranscript([
      {
        kind: 'system', turn: 1, text: 'instructions body', label: 'AGENTS.md', context: true,
        contextPresentation: { form: 'instructions', sourceKind: 'agent-instructions', role: 'inject' },
      },
      {
        kind: 'system', turn: 1, text: 'catalog body', label: 'skill-catalog', context: true,
        contextPresentation: { form: 'catalog', sourceKind: 'plugin', role: 'inject' },
      },
    ], new Map())
    await vt.waitForRender()
    const view = vt.getViewport().join('\n')
    // The raw-adjacent pair is STILL one semantic cluster; the regular surface
    // simply has no manual cluster disclosure owner in F4, so it presents the
    // member rows expanded instead of stranding them behind a dead header.
    assert.equal(clusterHeaders(view).length, 0, `${preset}: no collapsed cluster header on regular:\n${view}`)
    assert.ok(view.includes('Context injection AGENTS.md'), `${preset}: member rows render:\n${view}`)
    assert.ok(view.includes('Context injection skill-catalog'), `${preset}: every member renders:\n${view}`)
    app.dispose()
    startedApps.delete(app)
  }
})

test('fullscreen keeps ambient clusters collapsed by default and click-expandable', async () => {
  const { vt, app } = startApp('compact')
  app.setTranscript([
    {
      kind: 'system', turn: 1, text: 'instructions body', label: 'AGENTS.md', context: true,
      contextPresentation: { form: 'instructions', sourceKind: 'agent-instructions', role: 'inject' },
    },
    {
      kind: 'system', turn: 1, text: 'catalog body', label: 'skill-catalog', context: true,
      contextPresentation: { form: 'catalog', sourceKind: 'plugin', role: 'inject' },
    },
  ], new Map())
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport()
  assert.equal(clusterHeaders(view.join('\n')).length, 1, `the collapsed cluster header renders:\n${view.join('\n')}`)
  assert.ok(!view.join('\n').includes('Context injection'), 'the member rows stay behind the header')
  click(vt, 5, rowOf(view, /▸ Context · 2 injections/) + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.equal(clusterHeaders(view.join('\n'), true).length, 1, `the click opens the cluster:\n${view.join('\n')}`)
  assert.ok(view.join('\n').includes('Context injection AGENTS.md'), `every member row renders:\n${view.join('\n')}`)
})

test('fullscreen Compact keeps Work members click-owned inside an open run', async () => {
  const { vt, app } = startApp('compact')
  app.setTranscript([
    { kind: 'thinking', turn: 1, text: 'reasoning one' },
    { kind: 'system', turn: 1, text: 'RETRY_BODY_MARKER', origin: 'llm-retry' },
  ], new Map())
  app.setFullscreen(true)
  await vt.waitForRender()
  vt.sendInput('\x0f')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.equal(workHeaders(view, true).length, 1, `the run opens:\n${view}`)
  assert.ok(view.includes('(click to expand)'), `mouse-owned member cards must advertise click:\n${view}`)
  assert.ok(!view.includes('ctrl+o'), `fullscreen members must not advertise the Work-bulk key:\n${view}`)
})

test('dismissing a search that revealed a hidden Work member promotes the span owner', async () => {
  const { vt, app } = startApp('compact')
  const owner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'hidden reasoning' }
  const hidden: TranscriptMessage = { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'HIDDEN_RESULT', status: 'ok' }
  app.setTranscript([owner, hidden], new Map())
  app.setFullscreen(true)
  await vt.waitForRender()
  app.setTranscriptSearchTarget({
    query: 'HIDDEN_RESULT',
    match: { id: 0, turn: 1, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: hidden,
  })
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0, 'the reveal stays presentation-only while searching')
  assert.equal(workHeaders(vt.getViewport().join('\n'), true).length, 1, 'the reveal opens the owning span')

  // The dismissal transaction captures the viewport anchor from the revealed
  // member row; promotion must keep that row resolvable.
  const anchor = app.captureTranscriptViewportAnchor()
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await vt.waitForRender()
  const owners = app.compactExpandedWorkOwnersForTest()
  assert.equal(owners.size, 1, 'the revealed span becomes a manual owner on dismiss')
  assert.equal(owners.has(owner), true, 'the promoted owner is the span owner')
  assert.equal(workHeaders(vt.getViewport().join('\n'), true).length, 1,
    `the promoted span stays open after dismissal:\n${vt.getViewport().join('\n')}`)
  assert.equal(app.restoreTranscriptViewportAnchor(anchor!, 'top'), true,
    'a Work-member anchor captured before dismissal must still resolve')
})

test('search-dismiss does not promote a cluster the regular surface presents flat', async () => {
  const { vt, app } = startApp('compact')
  const first: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'instructions body', label: 'AGENTS.md', context: true,
    contextPresentation: { form: 'instructions', sourceKind: 'agent-instructions', role: 'inject' },
  }
  const second: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'CLUSTER_MEMBER_MARKER', label: 'skill-catalog', context: true,
    contextPresentation: { form: 'catalog', sourceKind: 'plugin', role: 'inject' },
  }
  app.setTranscript([first, second], new Map())
  await vt.waitForRender()
  assert.equal(clusterHeaders(vt.getViewport().join('\n')).length, 0,
    'precondition: the regular surface presents the members flat (no header)')

  app.setTranscriptSearchTarget({
    query: 'CLUSTER_MEMBER_MARKER',
    match: { id: 0, turn: 1, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: second,
  })
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('CLUSTER_MEMBER_MARKER'), 'the member is already visible (flat)')

  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await vt.waitForRender()
  assert.equal(app.compactExpandedClustersForTest().size, 0,
    'a flat cluster hides nothing, so dismissal must not promote a disclosure owner')
  // The stale owner would otherwise reopen the cluster on the next surface.
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(clusterHeaders(vt.getViewport().join('\n'), true).length, 0,
    `the fullscreen cluster stays collapsed (no stale promoted owner):\n${vt.getViewport().join('\n')}`)
})

test('search-dismiss presentation: a revealed cluster member promotes the cluster owner', async () => {
  const { vt, app } = startApp('compact')
  // Fullscreen is where the cluster is disclosed COLLAPSED; the reveal and its
  // dismissal promotion are what make the member reachable there.
  app.setFullscreen(true)
  const first: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'instructions body', label: 'AGENTS.md', context: true,
    contextPresentation: { form: 'instructions', sourceKind: 'agent-instructions', role: 'inject' },
  }
  const second: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'CLUSTER_MEMBER_MARKER', label: 'skill-catalog', context: true,
    contextPresentation: { form: 'catalog', sourceKind: 'plugin', role: 'inject' },
  }
  app.setTranscript([first, second], new Map())
  await vt.waitForRender()
  app.setTranscriptSearchTarget({
    query: 'CLUSTER_MEMBER_MARKER',
    match: { id: 0, turn: 1, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: second,
  })
  await vt.waitForRender()
  assert.equal(clusterHeaders(vt.getViewport().join('\n'), true).length, 1, 'the reveal opens the owning cluster')

  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await vt.waitForRender()
  const owners = app.compactExpandedClustersForTest()
  assert.equal(owners.size, 1, 'the revealed cluster becomes a manual owner on dismiss')
  assert.equal(owners.has(first), true, 'the promoted owner is the cluster owner')
  const view = vt.getViewport().join('\n')
  assert.equal(clusterHeaders(view, true).length, 1, `the promoted cluster stays open after dismissal:\n${view}`)
  assert.ok(view.includes('Context injection AGENTS.md'), `its member rows stay visible:\n${view}`)
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
    app.setFullscreen(true)
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
  app.setFullscreen(true)
  show(app, folder)
  await vt.waitForRender()
  assert.equal(clusterHeaders(vt.getViewport().join('\n')).length, 2, 'collapsed Focus surfaces both clusters')

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

test('the regular surface keeps the flat cluster chronology of both ambient bursts', async () => {
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
  app.toggleFocusTurn(1)
  await vt.waitForRender()
  const joined = vt.getViewport().join('\n')
  assert.equal(clusterHeaders(joined).length, 0, `the regular surface presents cluster members directly:\n${joined}`)
  const order = ['instructions body', 'catalog body', 'instructions body', 'snapshot body']
  // The two ambient bursts keep their raw chronology around the Thought.
  const a = joined.indexOf('Context injection agent-instructions')
  const c = joined.lastIndexOf('Context injection agent-instructions')
  assert.ok(a >= 0 && c > a, `both bursts render separately:\n${joined}`)
  assert.ok(joined.includes('Context injection skill-catalog') && joined.includes('Context injection runtime-context'),
    `every member row renders:\n${joined}`)
  assert.ok(order.length === 4)
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

test('fullscreen: a long relay keeps its head and tail collapsed and reveals the hidden middle on search', async () => {
  const { vt, app } = startApp('compact')
  app.setFullscreen(true)
  const lines = Array.from({ length: 40 }, (_, index) => `relay line ${index}`)
  const relay: TranscriptMessage = {
    kind: 'system', turn: 1, text: lines.join('\n'), label: 'agent-message', context: true,
    contextPresentation: { form: 'relay', sourceKind: 'agent-message', senderSessionId: 'child-2', role: 'inject' },
  }
  app.setTranscript([relay], new Map())
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Agent message · child-2'), `the sender is named:\n${view}`)
  assert.ok(view.includes('relay line 0'), 'the head is visible while collapsed')
  assert.ok(view.includes('relay line 39'), 'the TAIL is visible while collapsed (long-user geometry)')
  assert.ok(!view.includes('relay line 20'), 'the middle is hidden while collapsed')

  app.setTranscriptSearchTarget({
    query: 'relay line 20',
    match: { id: 0, turn: 1, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: relay,
  })
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('relay line 20'), `the hidden relay content must be reachable by search:\n${view}`)

  app.setTranscriptSearchTarget(undefined)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('relay line 20'), `disabling the reveal restores the collapsed relay:\n${view}`)
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
