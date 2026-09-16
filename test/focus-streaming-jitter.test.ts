import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TuiApp, type QueueItem, type StreamingToolPreview } from '../src/tui-app.ts'
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

const QUEUE_STEER_ITEM: QueueItem = { id: 'queue-1', text: 'queued occurrence', mode: 'steer' }

/** One running, expanded fullscreen Focus turn with a scrollable transcript
 * and an established live high-water floor. */
async function runningFullscreenFocus(columns: number, rows: number): Promise<{
  vt: VirtualTerminal
  app: TuiApp
  folder: TranscriptFolder
}> {
  const { vt, app } = startApp(columns, rows)
  const folder = new TranscriptFolder()
  const body = Array.from({ length: 40 }, (_, index) => `QUEUE-LINE-${index}`).join('\n')
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 90),
    eventAt('user/message', {
      id: MessageId('queue-viewport-user'),
      role: 'user',
      content: [{ type: 'text', text: body }],
      source: { kind: 'user' },
    }, 91),
  ])
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
  // Establish a live high-water floor: grow with streaming previews, then
  // shrink; the Focus padding holds the taller geometry.
  show(app, folder, [0, 1, 2, 3, 4].map(index => ({
    callId: `queue-growth-${index}`, turn: 1, step: 1, index, name: 'edit', argumentBytes: 900,
  })))
  await vt.waitForRender()
  const floor = height(app)
  show(app, folder)
  await vt.waitForRender()
  assert.equal(height(app), floor, 'live high-water floor should hold after the shrink')
  return { vt, app, folder }
}

test('semantic queue pane removal preserves historical wheel intent across fullscreen viewport growth', async () => {
  const { vt, app, folder } = await runningFullscreenFocus(40, 18)
  try {
    const base = frame(app)
    assert.equal(base[3], true, `setup should follow the end (frame ${JSON.stringify(base)})`)
    assert.ok(base[0] - base[1] >= 1, `setup needs a scrollable transcript (frame ${JSON.stringify(base)})`)

    // A queued occurrence appears: the pinned queue pane takes three rows
    // (border + item + hint) out of the fullscreen transcript viewport.
    app.setQueueItems([QUEUE_STEER_ITEM], true)
    await vt.waitForRender()
    const withQueue = frame(app)
    assert.equal(withQueue[3], true, `a queue pane while following must stay at the tail (frame ${JSON.stringify(withQueue)})`)
    assert.equal(withQueue[1], base[1] - 3, `queue pane should shrink viewportHeight by three rows (frames ${JSON.stringify(base)} -> ${JSON.stringify(withQueue)})`)

    // Wheel-up one row leaves follow-end exactly one row above the maximum.
    vt.sendInput('\x1b[<64;50;10M')
    await vt.waitForRender()
    const scrolled = frame(app)
    assert.equal(scrolled[3], false, `wheel-up must leave follow-end (frame ${JSON.stringify(scrolled)})`)
    assert.equal(scrolled[2], scrolled[0] - scrolled[1] - 1, `wheel-up should sit one row above max (frame ${JSON.stringify(scrolled)})`)

    // The queued occurrence is consumed: the queue pane disappears and the
    // transcript viewport GROWS, so maxScrollTop shrinks. This is the second
    // geometry path (viewport growth) that PR130's content high-water cannot
    // absorb: the user never returned to the tail and must not be re-armed.
    app.setQueueItems([])
    await vt.waitForRender()
    const removed = frame(app)
    assert.equal(removed[1], base[1], `emptied queue pane should restore viewportHeight (frame ${JSON.stringify(removed)})`)
    assert.equal(removed[3], false, `queue pane removal must not re-arm follow-end (frame ${JSON.stringify(removed)})`)

    // A passive repaint at the SAME geometry with NO content change (a queue
    // hint / footer / working repaint) must not re-arm follow either.
    show(app, folder)
    await vt.waitForRender()
    assert.equal(frame(app)[3], false, `passive same-geometry repaint must keep the historical view (frame ${JSON.stringify(frame(app))})`)

    // A later passive live delta must not pull the historical view back either.
    folder.applyLiveInput(liveText(' '))
    show(app, folder)
    await vt.waitForRender()
    assert.equal(frame(app)[3], false, `passive live delta after queue removal must keep the historical view (frame ${JSON.stringify(frame(app))})`)
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})

test('queue running-hint update keeps the fullscreen viewport and Focus floor unchanged', async () => {
  const { vt, app } = await runningFullscreenFocus(40, 18)
  try {
    app.setQueueItems([QUEUE_STEER_ITEM], true)
    await vt.waitForRender()
    const running = frame(app)

    // Only the running hint text changes: the physical queue rows, the
    // viewport, the Focus floor and the scroll position must all stay put.
    app.setQueueItems([QUEUE_STEER_ITEM], false)
    await vt.waitForRender()
    assert.deepEqual(frame(app), running)
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})

test('queue pane removal keeps a same-frame wheel-up off the tail', async () => {
  const { vt, app, folder } = await runningFullscreenFocus(40, 18)
  try {
    app.setQueueItems([QUEUE_STEER_ITEM], true)
    await vt.waitForRender()
    const withQueue = frame(app)
    assert.equal(withQueue[3], true, `a queue pane while following stays at the tail (frame ${JSON.stringify(withQueue)})`)

    // The queued occurrence is consumed while the user is STILL following, and
    // the user wheel-up's away from the tail in the SAME frame, before the
    // repaint. The queue removal then grows the viewport and re-arms follow:
    // the wheel-up intent must still win.
    app.setQueueItems([])
    vt.sendInput('\x1b[<64;50;10M')
    await vt.waitForRender()
    const race = frame(app)
    assert.equal(race[1], withQueue[1] + 3, `emptied queue pane should restore viewportHeight (frame ${JSON.stringify(race)})`)
    assert.equal(race[3], false, `same-frame wheel-up must not be re-armed by queue pane removal (frame ${JSON.stringify(race)})`)

    folder.applyLiveInput(liveText(' '))
    show(app, folder)
    await vt.waitForRender()
    assert.equal(frame(app)[3], false, `passive live delta must keep the historical view (frame ${JSON.stringify(frame(app))})`)
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})

test('queue pane removal does not undo an explicit same-frame follow-end request', async () => {
  const { vt, app } = await runningFullscreenFocus(40, 18)
  try {
    app.setQueueItems([QUEUE_STEER_ITEM], true)
    await vt.waitForRender()
    vt.sendInput('\x1b[<64;50;10M')
    await vt.waitForRender()
    const historical = frame(app)
    assert.equal(historical[3], false, `wheel-up should be historical (frame ${JSON.stringify(historical)})`)

    // The queued occurrence is consumed and the user explicitly jumps to the
    // tail in the SAME frame: the viewport clamp must not undo that request.
    app.setQueueItems([])
    app.scrollToBottom()
    await vt.waitForRender()
    const followed = frame(app)
    assert.equal(followed[1], historical[1] + 3, `emptied queue pane should restore viewportHeight (frame ${JSON.stringify(followed)})`)
    assert.equal(followed[3], true, `explicit scrollToBottom must keep follow-end (frame ${JSON.stringify(followed)})`)
    assert.equal(followed[2], followed[0] - followed[1], `explicit scrollToBottom must land at the tail (frame ${JSON.stringify(followed)})`)
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})

test('a wheel-up on a non-scrolling transcript does not arm the clamp correction', async () => {
  const { vt, app } = startApp(40, 40)
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 95),
    eventAt('user/message', {
      id: MessageId('short-queue-user'),
      role: 'user',
      content: [{ type: 'text', text: 'SHORT' }],
      source: { kind: 'user' },
    }, 96),
  ])
  try {
    app.setFocusMode(true)
    app.setFullscreen(true)
    app.setWorking(true)
    folder.applyLiveInput(liveStart())
    show(app, folder)
    await vt.waitForRender()
    app.toggleFocusTurn(1)
    await vt.waitForRender()
    const short = frame(app)
    assert.ok(short[0] <= short[1], `setup needs a non-scrolling transcript (frame ${JSON.stringify(short)})`)
    assert.equal(short[3], true, `a short transcript stays at the end (frame ${JSON.stringify(short)})`)

    // The wheel cannot scroll anything, so it never left follow-end; the queue
    // pane's later removal must not disable follow on a short transcript.
    app.setQueueItems([QUEUE_STEER_ITEM], true)
    await vt.waitForRender()
    vt.sendInput('\x1b[<64;50;10M')
    app.setQueueItems([])
    await vt.waitForRender()
    assert.equal(frame(app)[3], true, `a no-op wheel on short content must not disable follow (frame ${JSON.stringify(frame(app))})`)
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})

test('fullscreen re-entry after stop/start ignores an unconsumed historical intent', async () => {
  const { vt, app, folder } = await runningFullscreenFocus(40, 18)
  try {
    app.setQueueItems([QUEUE_STEER_ITEM], true)
    await vt.waitForRender()
    // Arm a historical frame WITHOUT any intervening paint: the wheel and the
    // queue mutation are never consumed by a paint, so the torn-down surface
    // leaves an unconsumed historical intent AND a stale paint snapshot. The
    // fresh fullscreen epoch must ignore both (the entry path drops the
    // snapshot, and the correction only ever pairs a frame with its
    // predecessor).
    vt.sendInput('\x1b[<64;50;10M')
    app.setQueueItems([])
    app.stop()
    app.start()
    app.setFocusMode(true)
    app.setFullscreen(true)
    show(app, folder)
    await vt.waitForRender()
    const fresh = frame(app)
    assert.equal(fresh[3], true, `a fresh fullscreen surface must follow the end (frame ${JSON.stringify(fresh)})`)
    // "At the tail" means scrollTop sits at the clamp: the fresh surface no
    // longer inherits the live high-water floor, and the long user prompt now
    // renders compact, so the fresh content can be shorter than the viewport
    // (scrollTop 0) instead of exactly contentHeight - viewportHeight.
    assert.equal(fresh[2], Math.max(0, fresh[0] - fresh[1]), `a fresh fullscreen surface must start at the tail (frame ${JSON.stringify(fresh)})`)
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})
