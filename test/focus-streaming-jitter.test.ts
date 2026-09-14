import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TuiApp, type StreamingToolPreview } from '../src/tui-app.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import {
  removeStreamingToolPreview,
  streamingToolPreviewSnapshot,
  upsertStreamingToolPreview,
} from '../src/streaming-tool-preparing.ts'
import { RendererRegistry } from '../src/renderer-registry.ts'
import type { AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const T0 = Date.now() - 60_000
const startedApps = new Set<TuiApp>()

afterEach(() => {
  for (const app of startedApps) {
    startedApps.delete(app)
    if (!app.isDisposed()) app.dispose()
  }
})

function eventAt(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq, time: T0 + seq, data } as SessionEvent
}

function startApp(columns: number, rows: number): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(columns, rows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function liveStart(): AssistantLiveInput {
  return { kind: 'start', sessionId: 'jitter-test', attemptId: 'attempt-1', turn: 1, step: 1 }
}

function liveText(text: string): AssistantLiveInput {
  return {
    kind: 'chunk',
    sessionId: 'jitter-test',
    attemptId: 'attempt-1',
    turn: 1,
    step: 1,
    time: T0 + text.length,
    chunk: { type: 'text-delta', index: 0, text },
  }
}

function show(app: TuiApp, folder: TranscriptFolder, previews: readonly StreamingToolPreview[] = []): void {
  app.setTranscript(folder.messages(), folder.turnActivities(), undefined, previews)
}

function height(app: TuiApp): number {
  const scroll = app.fullscreenScrollForTest()
  assert.ok(scroll)
  return scroll.contentHeight
}

function messagesHeight(app: TuiApp, width: number): number {
  const host = app as unknown as { messagesView: { render(width: number): string[] } }
  return host.messagesView.render(width).length
}

function frame(app: TuiApp): [number, number, number, boolean] {
  const scroll = app.fullscreenScrollForTest()
  assert.ok(scroll)
  return [scroll.contentHeight, scroll.viewportHeight, scroll.scrollTop, scroll.isFollowingEnd]
}

const TABLE_PREFIX = '| one | two | three |\n| --- | --- | --- |\n| alpha | beta | gamma |\n| delta | eps'

test('expanded live Markdown preserves wheel intent across historical growth and shrink', async () => {
  const { vt, app } = startApp(22, 29)
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1),
    eventAt('user/message', {
      id: MessageId('jitter-user'),
      role: 'user',
      content: [{ type: 'text', text: 'STATIC-ONE\nSTATIC-TWO\nJITTER-ANCHOR\nSTATIC-FOUR' }],
      source: { kind: 'user' },
    }, 2),
  ])
  try {
    app.setFocusMode(true)
    app.setFullscreen(true)
    app.setWorking(true)
    show(app, folder)
    await vt.waitForRender()
    folder.applyLiveInput(liveStart())
    show(app, folder)
    await vt.waitForRender()
    app.toggleFocusTurn(1)
    await vt.waitForRender()

    let text = ''
    const frames: Array<[number, number, number, boolean]> = []
    for (const delta of [TABLE_PREFIX, 'i', 'l']) {
      text += delta
      folder.applyLiveInput(liveText(delta))
      show(app, folder)
      await vt.waitForRender()
      frames.push(frame(app))
    }
    assert.equal(text.length, 82)
    assert.deepEqual(frames.map(([content, viewport, scrollTop, following]) => [content, viewport, scrollTop, following]), [
      [21, 21, 0, true],
      [22, 21, 1, true],
      [22, 21, 1, true],
    ])
    app.setToolOutputExpanded(app.isToolOutputExpanded())
    await vt.waitForRender()
    assert.deepEqual(frame(app), [22, 21, 1, true])

    // A real one-line wheel-up must preserve the existing padding while
    // leaving follow-end, so ScrollView cannot re-arm follow at the new max.
    vt.sendInput('\x1b[<64;50;10M')
    await vt.waitForRender()
    assert.deepEqual(frame(app), [22, 21, 0, false])
    folder.applyLiveInput(liveText(' '))
    show(app, folder)
    await vt.waitForRender()
    assert.deepEqual(frame(app), [22, 21, 0, false])
    const growthPreviews = [0, 1, 2, 3, 4].map(index => ({
      callId: `growth-${index}`, turn: 1, step: 1, index, name: 'edit', argumentBytes: 900,
    }))
    show(app, folder, growthPreviews)
    await vt.waitForRender()
    assert.deepEqual(frame(app), [26, 21, 0, false])
    for (let i = 0; i < 4; i += 1) {
      vt.sendInput('\x1b[<65;50;10M')
      await vt.waitForRender()
    }
    assert.deepEqual(frame(app), [26, 21, 4, false])
    // A historical structural reset must rebaseline the running epoch before
    // the next passive shrink; it must not leave the turn unprotected.
    app.setToolOutputExpanded(!app.isToolOutputExpanded())
    await vt.waitForRender()
    assert.deepEqual(frame(app), [26, 21, 4, false])
    show(app, folder)
    await vt.waitForRender()
    assert.deepEqual(frame(app), [26, 21, 4, false])
    folder.applyLiveInput(liveText(' '))
    show(app, folder)
    await vt.waitForRender()
    assert.deepEqual(frame(app), [26, 21, 4, false])
    app.scrollToBottom()
    await vt.waitForRender()

    // Root disclosure is structural: it may release the previous expanded
    // floor rather than treating the collapse as passive live input.
    app.toggleFocusTurn(1)
    await vt.waitForRender()
    app.toggleFocusTurn(1)
    await vt.waitForRender()
    assert.ok(height(app) < 22)

    // Historical navigation keeps the current presentation geometry while
    // disabling follow; explicit structural changes above already reset it.
    app.scrollToTop({ disableFollow: true })
    await vt.waitForRender()
    show(app, folder)
    await vt.waitForRender()
    assert.deepEqual(frame(app), [20, 21, 0, false])
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})

async function runPreparingLifecycle(expanded: boolean): Promise<{
  initial: number
  created: number
  progressed: number
  cleared: number
  settled: number
}> {
  const { vt, app } = startApp(22, 14)
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 10),
    eventAt('user/message', {
      id: MessageId(`preparing-user-${expanded}`),
      role: 'user',
      content: [{ type: 'text', text: 'PREPARING-ONE\nPREPARING-TWO\nPREPARING-ANCHOR\nPREPARING-FOUR' }],
      source: { kind: 'user' },
    }, 11),
  ])
  folder.applyLiveInput(liveStart())
  try {
    app.setFocusMode(true)
    app.setFullscreen(true)
    app.setWorking(true)
    show(app, folder)
    await vt.waitForRender()
    if (expanded) {
      app.toggleFocusTurn(1)
      await vt.waitForRender()
    }
    const initial = height(app)
    const preview = (callId: string, argumentBytes: number): StreamingToolPreview => ({
      callId,
      turn: 1,
      step: 1,
      index: 0,
      name: 'edit',
      argumentBytes,
    })
    show(app, folder, [preview('', 900)])
    await vt.waitForRender()
    const created = height(app)
    show(app, folder, [preview('', 901)])
    await vt.waitForRender()
    const progressed = height(app)
    show(app, folder)
    await vt.waitForRender()
    const cleared = height(app)

    folder.apply([eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, 20)])
    app.setWorking(false)
    show(app, folder)
    await vt.waitForRender()
    const settled = height(app)
    return { initial, created, progressed, cleared, settled }
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
}

test('Preparing create/progress/clear holds the live high-water and settlement releases it', async () => {
  const collapsed = await runPreparingLifecycle(false)
  const expanded = await runPreparingLifecycle(true)
  assert.deepEqual(collapsed, { initial: 6, created: 7, progressed: 7, cleared: 7, settled: 6 })
  assert.deepEqual(expanded, { initial: 6, created: 8, progressed: 8, cleared: 8, settled: 6 })
})

test('formal Preparing handoff does not add a second blank row', async () => {
  for (const expanded of [false, true]) {
    const { vt, app } = startApp(22, 14)
    const folder = new TranscriptFolder()
    folder.apply([
      eventAt('turn/start', { turn: 1 }, expanded ? 25 : 24),
      eventAt('user/message', {
        id: MessageId(`formal-handoff-user-${expanded}`),
        role: 'user',
        content: [{ type: 'text', text: 'HANDOFF-ONE\nHANDOFF-TWO\nHANDOFF-ANCHOR\nHANDOFF-FOUR' }],
        source: { kind: 'user' },
      }, expanded ? 26 : 25),
    ])
    folder.applyLiveInput(liveStart())
    folder.applyLiveInput({
      kind: 'chunk', sessionId: 'jitter-test', attemptId: 'attempt-1', turn: 1, step: 1,
      time: T0 + 26,
      chunk: { type: 'block-start', index: 0, blockType: 'tool-call' },
    })
    try {
      app.setFocusMode(true)
      app.setFullscreen(true)
      app.setWorking(true)
      show(app, folder)
      await vt.waitForRender()
      if (expanded) {
        app.toggleFocusTurn(1)
        await vt.waitForRender()
      }

      const previews = new Map<string, StreamingToolPreview>()
      const delta: AssistantLiveInput = {
        kind: 'chunk', sessionId: 'jitter-test', attemptId: 'attempt-1', turn: 1, step: 1,
        time: T0 + 27,
        chunk: { type: 'tool-call-delta', index: 0, id: '', name: 'edit', argumentsDelta: 'x'.repeat(900) },
      }
      upsertStreamingToolPreview(previews, {
        callId: '', turn: 1, step: 1, index: 0, name: 'edit', argumentsDelta: 'x'.repeat(900),
      })
      folder.applyLiveInput(delta)
      show(app, folder, streamingToolPreviewSnapshot(previews))
      await vt.waitForRender()
      const created = height(app)

      const blockEnd: AssistantLiveInput = {
        kind: 'chunk', sessionId: 'jitter-test', attemptId: 'attempt-1', turn: 1, step: 1,
        time: T0 + 28,
        chunk: {
          type: 'block-end', index: 0,
          block: { type: 'tool-call', id: ToolCallId('formal-edit'), name: 'edit' },
        },
      }
      upsertStreamingToolPreview(previews, {
        callId: 'formal-edit', turn: 1, step: 1, index: 0, name: 'edit',
      })
      folder.applyLiveInput(blockEnd)
      show(app, folder, streamingToolPreviewSnapshot(previews))
      await vt.waitForRender()
      assert.equal(height(app), created)

      // The production handoff clears the migrated preview before the durable
      // tool/call repaint; the formal card must replace it at the same height.
      removeStreamingToolPreview(previews, 'formal-edit', 1, 1)
      folder.apply([eventAt('tool/call', {
        turn: 1,
        step: 1,
        callId: ToolCallId('formal-edit'),
        name: 'edit',
        arguments: '{}',
      }, 29)])
      show(app, folder, streamingToolPreviewSnapshot(previews))
      await vt.waitForRender()
      assert.equal(height(app), created)
    } finally {
      app.dispose()
      startedApps.delete(app)
    }
  }
})

test('automatic Workflow completion releases a running Focus presentation floor', async () => {
  const { vt, app } = startApp(80, 20)
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 30),
    eventAt('tool-workflow/run-start', { runId: 'run-1', name: 'audit' }, 31),
    eventAt('tool-workflow/agent-start', {
      runId: 'run-1', seq: 0, label: 'worker', childId: 'child-1',
    }, 32),
  ])
  try {
    app.setFocusMode(true)
    app.setFullscreen(true)
    show(app, folder)
    await vt.waitForRender()
    app.expandFocusTurn(1)
    await vt.waitForRender()
    const running = height(app)

    folder.apply([eventAt('tool-workflow/agent-end', {
      runId: 'run-1', seq: 0, outcome: 'completed',
    }, 33)])
    show(app, folder)
    await vt.waitForRender()
    const completed = height(app)
    assert.ok(completed < running, `completed Workflow should release its old floor (${running} -> ${completed})`)
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})

test('stop/start does not carry fullscreen live padding into regular Focus', async () => {
  const { vt, app } = startApp(22, 14)
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 40),
    eventAt('user/message', {
      id: MessageId('stop-start-user'),
      role: 'user',
      content: [{ type: 'text', text: 'STOP-START-ONE\nSTOP-START-TWO\nSTOP-START-ANCHOR\nSTOP-START-FOUR' }],
      source: { kind: 'user' },
    }, 41),
  ])
  try {
    app.setFocusMode(true)
    app.setFullscreen(true)
    show(app, folder)
    await vt.waitForRender()
    folder.applyLiveInput(liveStart())
    show(app, folder, [{ callId: '', turn: 1, step: 1, index: 0, name: 'edit', argumentBytes: 900 }])
    await vt.waitForRender()
    const liveHeight = height(app)
    assert.equal(liveHeight, 7)

    app.stop()
    app.start()
    show(app, folder)
    await vt.waitForRender()
    assert.equal(messagesHeight(app, 22), 6)
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})

test('icon-style changes release the previous live-height epoch', async () => {
  const { vt, app } = startApp(22, 14)
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 50),
    eventAt('user/message', {
      id: MessageId('icon-style-user'),
      role: 'user',
      content: [{ type: 'text', text: 'ICON-ONE\nICON-TWO\nICON-ANCHOR\nICON-FOUR' }],
      source: { kind: 'user' },
    }, 51),
  ])
  try {
    app.setFocusMode(true)
    app.setFullscreen(true)
    show(app, folder)
    await vt.waitForRender()
    folder.applyLiveInput(liveStart())
    const preview = [{ callId: '', turn: 1, step: 1, index: 0, name: 'edit', argumentBytes: 900 }]
    show(app, folder, preview)
    await vt.waitForRender()
    assert.equal(height(app), 7)
    show(app, folder)
    await vt.waitForRender()
    assert.equal(height(app), 7)
    if (app.currentIconStyle() === 'minimal') app.setIconStyle('emoji')
    app.setIconStyle('minimal')
    await vt.waitForRender()
    assert.equal(height(app), 6)
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})

test('renderer revision changes release the previous live-height epoch', async () => {
  const registry = new RendererRegistry()
  const vt = new VirtualTerminal(22, 14)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { renderers: registry })
  app.start()
  startedApps.add(app)
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 60),
    eventAt('user/message', {
      id: MessageId('renderer-revision-user'),
      role: 'user',
      content: [{ type: 'text', text: 'RENDERER-ONE\nRENDERER-TWO\nRENDERER-ANCHOR\nRENDERER-FOUR' }],
      source: { kind: 'user' },
    }, 61),
  ])
  try {
    app.setFocusMode(true)
    app.setFullscreen(true)
    show(app, folder)
    await vt.waitForRender()
    folder.applyLiveInput(liveStart())
    const preview = [{ callId: '', turn: 1, step: 1, index: 0, name: 'edit', argumentBytes: 900 }]
    show(app, folder, preview)
    await vt.waitForRender()
    assert.equal(height(app), 7)
    show(app, folder)
    await vt.waitForRender()
    assert.equal(height(app), 7)
    registry.registerToolRenderer({ id: 'jitter-noop', toolName: 'bash', render: () => undefined }, 'jitter-test')
    app.requestRender(true)
    await vt.waitForRender()
    assert.equal(height(app), 6)
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})

test('local-card removal releases the preceding running turn floor', async () => {
  const { vt, app } = startApp(22, 14)
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 70),
    eventAt('user/message', {
      id: MessageId('local-card-user'),
      role: 'user',
      content: [{ type: 'text', text: 'LOCAL-ONE\nLOCAL-TWO\nLOCAL-ANCHOR\nLOCAL-FOUR' }],
      source: { kind: 'user' },
    }, 71),
  ])
  try {
    app.setFocusMode(true)
    app.setFullscreen(true)
    show(app, folder)
    await vt.waitForRender()
    folder.applyLiveInput(liveStart())
    show(app, folder)
    await vt.waitForRender()
    const baseline = height(app)
    app.pushLocalMessage({
      kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
      args: 'done', result: '[exit 0]', status: 'ok',
    })
    await vt.waitForRender()
    app.clearSettledLocalMessages()
    await vt.waitForRender()
    assert.equal(height(app), baseline)
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})
