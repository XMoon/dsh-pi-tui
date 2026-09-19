import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TuiApp, type StreamingToolPreview } from '../src/tui-app.ts'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'
import type { AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
const T0 = Date.now() - 60_000

afterEach(() => {
  for (const app of startedApps) {
    startedApps.delete(app)
    if (!app.isDisposed()) app.dispose()
  }
})

function startApp(columns = 80, rows = 30): { app: TuiApp; terminal: VirtualTerminal } {
  const terminal = new VirtualTerminal(columns, rows)
  const app = new TuiApp(terminal, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { app, terminal }
}

function assistant(turn: number, text: string): Extract<TranscriptMessage, { kind: 'assistant' }> {
  return { kind: 'assistant', turn, text }
}

function eventAt(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq, time: T0 + seq, data } as SessionEvent
}

function liveStart(turn = 1): AssistantLiveInput {
  return { kind: 'start', sessionId: 'render-perf', attemptId: 'attempt-1', turn, step: 0 }
}

function liveText(text: string, turn = 1): AssistantLiveInput {
  return {
    kind: 'chunk',
    sessionId: 'render-perf',
    attemptId: 'attempt-1',
    turn,
    step: 0,
    time: T0 + text.length,
    chunk: { type: 'text-delta', index: 0, text },
  }
}

function liveReasoning(text: string, turn = 1): AssistantLiveInput {
  return {
    kind: 'chunk',
    sessionId: 'render-perf',
    attemptId: 'attempt-1',
    turn,
    step: 0,
    time: T0 + text.length,
    chunk: { type: 'reasoning-delta', index: 0, text },
  }
}

function startLiveFolder(): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1),
    eventAt('user/message', {
      id: 'render-perf-user',
      role: 'user',
      content: [{ type: 'text', text: 'render performance user prompt' }],
      source: { kind: 'user' },
    }, 2),
  ])
  folder.applyLiveInput(liveStart())
  folder.applyLiveInput(liveText('seed line'))
  return folder
}

function showFolder(app: TuiApp, folder: TranscriptFolder): void {
  app.setTranscript(folder.messages(), folder.turnActivities(), undefined, [])
}

function diagnostics(app: TuiApp) {
  return app.transcriptPresentationDiagnosticsForTest()
}

function mountedComponents(app: TuiApp): unknown[] {
  const host = app as unknown as {
    messagesView: { children: Array<{ constructor: { name: string }; child?: unknown }> }
  }
  return host.messagesView.children
    .filter(child => child.constructor.name === 'TranscriptGutterComponent')
    .map(child => child.child)
}

test('identical indexed projections are no-op and equivalent summaries reuse the mount', () => {
  const { app } = startApp()
  const firstSummary = { kind: 'summary' as const, text: '… 4 earlier turns — window 20 turns' }
  const secondSummary = { kind: 'summary' as const, text: firstSummary.text }
  const answer = assistant(5, 'stable answer')
  app.setTranscript([firstSummary, answer])
  app.resetTranscriptPresentationDiagnosticsForTest()

  app.setTranscript([secondSummary, answer])
  const diag = diagnostics(app)
  assert.equal(diag.structuralCommits, 0)
  assert.equal(diag.contentCommits, 0)
  assert.equal(diag.noopCommits, 1)
  assert.equal(mountedComponents(app).length, 2)
  const published = (app as unknown as {
    mountedTranscriptBlocks: Array<{ block: { message?: unknown } }>
  }).mountedTranscriptBlocks
  assert.equal(published[0]?.block.message, secondSummary, 'a no-op must publish fresh equivalent block metadata')
})

test('streaming preview turn movement is structural in regular mode', () => {
  const { app } = startApp()
  const preview = (turn: number): StreamingToolPreview => ({
    callId: 'preview-call',
    argumentBytes: 1,
    turn,
    step: 0,
    index: 0,
    name: 'read',
    summary: 'src/file.ts',
  })
  app.setTranscript([], undefined, undefined, [preview(1)])
  app.resetTranscriptPresentationDiagnosticsForTest()

  app.setTranscript([], undefined, undefined, [preview(2)])
  const diag = diagnostics(app)
  assert.equal(diag.structuralCommits, 1)
  assert.equal(diag.contentCommits, 0)
  assert.equal(diag.mountReplacements, 0)
})

test('setTranscript applies window and previews before Focus timing observation', () => {
  const { app } = startApp()
  const host = app as unknown as {
    observeFocusTiming: () => boolean
    streamingToolPreviews: readonly StreamingToolPreview[]
    transcriptWindow: unknown
  }
  const originalObserve = host.observeFocusTiming
  const previews: readonly StreamingToolPreview[] = [{
    callId: 'ordering-preview',
    argumentBytes: 1,
    turn: 1,
    step: 0,
    index: 0,
    name: 'read',
  }]
  const window = { mode: 'history' as const, endTurn: 1, firstTurn: 1, lastTurn: 1, hasNewer: false }
  let observed: { previews: readonly StreamingToolPreview[]; window: unknown } | undefined
  try {
    host.observeFocusTiming = () => {
      observed = { previews: host.streamingToolPreviews, window: host.transcriptWindow }
      return false
    }
    app.setTranscript([], undefined, window, previews)
  } finally {
    host.observeFocusTiming = originalObserve
  }
  assert.ok(observed)
  assert.equal(observed.window, window)
  assert.equal(observed.previews[0], previews[0])
})

test('ordinary assistant streaming replaces only the dirty mounted block', async () => {
  const { app, terminal } = startApp()
  const folder = startLiveFolder()
  showFolder(app, folder)
  await terminal.waitForRender()
  const before = mountedComponents(app)
  app.resetTranscriptPresentationDiagnosticsForTest()

  folder.applyLiveInput(liveText(' changed content'))
  showFolder(app, folder)
  await terminal.waitForRender()
  const after = mountedComponents(app)
  const diag = diagnostics(app)
  assert.equal(diag.structuralCommits, 0)
  assert.equal(diag.contentCommits, 1)
  assert.equal(diag.dirtyBlocks, 1)
  assert.equal(diag.mountReplacements, 1)
  assert.equal(diag.rowMapRefreshes, 1)
  assert.equal(after.length, before.length)
  assert.notEqual(after[after.length - 1], before[before.length - 1])
  assert.ok(terminal.getViewport().some(line => line.includes('changed content')))
  const published = (app as unknown as {
    mountedTranscriptBlocks: Array<{ block: { kind: string }; component: unknown }>
  }).mountedTranscriptBlocks
  assert.deepEqual(
    published.map(entry => entry.component),
    after,
    'the published batch must point at the physical mounted children after replacement',
  )
})

test('repeated identical live projection is no-op after the content commit', () => {
  const { app } = startApp()
  const folder = startLiveFolder()
  showFolder(app, folder)
  app.resetTranscriptPresentationDiagnosticsForTest()

  showFolder(app, folder)
  const diag = diagnostics(app)
  assert.equal(diag.structuralCommits, 0)
  assert.equal(diag.contentCommits, 0)
  assert.equal(diag.noopCommits, 1)
})

test('Focus collapsed and expanded streaming stays on the content path', () => {
  const { app } = startApp()
  const folder = startLiveFolder()
  app.setFocusMode(true)
  showFolder(app, folder)
  app.resetTranscriptPresentationDiagnosticsForTest()

  folder.applyLiveInput(liveReasoning('reasoning update'))
  showFolder(app, folder)
  let diag = diagnostics(app)
  assert.equal(diag.structuralCommits, 0)
  assert.equal(diag.contentCommits, 1)

  app.toggleFocusTurn(1)
  app.resetTranscriptPresentationDiagnosticsForTest()
  folder.applyLiveInput(liveReasoning('expanded reasoning update'))
  showFolder(app, folder)
  diag = diagnostics(app)
  assert.equal(diag.structuralCommits, 0)
  assert.equal(diag.contentCommits, 1)
})

test('live turn finalization is structural when Focus projection shape changes', () => {
  const { app } = startApp()
  const folder = startLiveFolder()
  app.setFocusMode(true)
  showFolder(app, folder)
  app.resetTranscriptPresentationDiagnosticsForTest()

  folder.applyLiveInput({
    kind: 'end',
    sessionId: 'render-perf',
    attemptId: 'attempt-1',
    turn: 1,
    step: 0,
    status: 'committed',
    settlement: 'attempt',
  })
  folder.apply([eventAt('assistant/message', {
    turn: 1,
    step: 1,
    stream: [],
    message: {
      id: 'render-perf-final',
      role: 'assistant',
      content: [{ type: 'text', text: 'final answer' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  }, 3)])
  folder.apply([eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4)])
  showFolder(app, folder)
  const diag = diagnostics(app)
  assert.equal(diag.structuralCommits, 1)
  assert.equal(diag.contentCommits, 0)
})

test('read-group reflow is structural when grouped card topology changes', () => {
  const { app } = startApp()
  const folder = new TranscriptFolder()
  const readResult = (seq: number, callId: string, text: string): SessionEvent => eventAt('tool/result', {
    turn: 0,
    step: 0,
    message: {
      id: `read-${seq}`,
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }] }],
      source: { kind: 'tool', callId },
    },
  }, seq)
  folder.apply([
    eventAt('turn/start', { turn: 0 }, 1),
    eventAt('tool/call', { turn: 0, step: 0, callId: 'r1', name: 'read', arguments: '{}' }, 2),
    readResult(3, 'r1', 'first'),
    eventAt('tool/call', { turn: 0, step: 0, callId: 'r2', name: 'read', arguments: '{}' }, 4),
    eventAt('turn/start', { turn: 1 }, 5),
    eventAt('user/message', {
      id: 'reflow-user', role: 'user', content: [{ type: 'text', text: 'next turn' }], source: { kind: 'user' },
    }, 6),
  ])
  app.setTranscript(folder.messages(), folder.turnActivities())
  app.resetTranscriptPresentationDiagnosticsForTest()

  folder.apply([readResult(7, 'r2', 'second')])
  app.setTranscript(folder.messages(), folder.turnActivities())
  const diag = diagnostics(app)
  assert.equal(diag.structuralCommits, 1)
  assert.equal(diag.contentCommits, 0)
})

test('append and window navigation are structural commits', () => {
  const { app } = startApp()
  const initial = [assistant(1, 'first')]
  app.setTranscript(initial)
  app.resetTranscriptPresentationDiagnosticsForTest()

  app.setTranscript([...initial, assistant(1, 'second')])
  let diag = diagnostics(app)
  assert.equal(diag.structuralCommits, 1)
  assert.equal(diag.contentCommits, 0)

  const messages = Array.from({ length: 25 }, (_, turn) => assistant(turn, `turn ${turn}`))
  app.setTranscript(messages, undefined, { mode: 'latest', firstTurn: 5, lastTurn: 24 })
  app.resetTranscriptPresentationDiagnosticsForTest()
  app.setTranscript(messages, undefined, { mode: 'history', endTurn: 10, firstTurn: 0, lastTurn: 10 })
  diag = diagnostics(app)
  assert.equal(diag.structuralCommits, 1)
  assert.equal(diag.structuralFallbacks, 0)
})

test('zero-height mount transitions fall back structurally', () => {
  const { app } = startApp()
  const message = assistant(1, '')
  app.setTranscript([message])
  app.resetTranscriptPresentationDiagnosticsForTest()

  message.text = 'visible after the zero-height state'
  app.setTranscript([message])
  let diag = diagnostics(app)
  assert.equal(diag.structuralFallbacks, 1)
  assert.equal(diag.structuralCommits, 1)
  assert.equal(diag.contentCommits, 0)

  app.resetTranscriptPresentationDiagnosticsForTest()
  message.text = ''
  app.setTranscript([message])
  diag = diagnostics(app)
  assert.equal(diag.structuralFallbacks, 1)
  assert.equal(diag.structuralCommits, 1)
  assert.equal(diag.contentCommits, 0)
})

test('structural fallback diagnostics retain partial dirty work', () => {
  const { app } = startApp()
  const first = assistant(1, 'a')
  const second = assistant(1, '')
  app.setTranscript([first, second])
  app.resetTranscriptPresentationDiagnosticsForTest()

  first.text = 'changed'
  second.text = 'now visible'
  app.setTranscript([first, second])
  const diag = diagnostics(app)
  assert.equal(diag.structuralFallbacks, 1)
  assert.equal(diag.structuralCommits, 1)
  assert.equal(diag.dirtyBlocks, 1)
  assert.equal(diag.mountReplacements, 1)
  assert.equal(diag.contentCommits, 0)
})

test('active search content change falls back to one structural rebuild', () => {
  const { app } = startApp()
  const message = assistant(1, 'needle before')
  app.setTranscript([message])
  app.setTranscriptSearchTarget({
    query: 'needle',
    match: {
      id: 1,
      turn: 1,
      occurrence: 0,
      source: { kind: 'message' },
      sourceOccurrence: 0,
    },
    message,
  })
  app.resetTranscriptPresentationDiagnosticsForTest()
  message.text = 'needle after' // the live folder mutates the same entry in place
  app.setTranscript([message])
  const diag = diagnostics(app)
  assert.equal(diag.structuralFallbacks, 1)
  assert.equal(diag.structuralCommits, 1)
  assert.equal(diag.contentCommits, 0)
})

test('fullscreen content refresh updates geometry without remounting unchanged blocks', async () => {
  const { app, terminal } = startApp(50, 24)
  const folder = startLiveFolder()
  app.setFullscreen(true)
  showFolder(app, folder)
  await terminal.waitForRender()
  const beforeHeight = app.transcriptContentHeightForTest()
  const before = mountedComponents(app)
  app.resetTranscriptPresentationDiagnosticsForTest()

  folder.applyLiveInput(liveText('\nsecond line that changes the row height'))
  showFolder(app, folder)
  await terminal.waitForRender()
  const after = mountedComponents(app)
  const diag = diagnostics(app)
  assert.equal(diag.structuralCommits, 0)
  assert.equal(diag.contentCommits, 1)
  assert.ok(app.transcriptContentHeightForTest() > beforeHeight)
  assert.equal(after.length, before.length)
})
