import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TuiApp } from '../src/tui-app.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import type { AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/**
 * Regression: the fullscreen row-map refresh must be MEASUREMENT-ONLY.
 *
 * `refreshMessageRows()` used to call `renderTranscriptBlocks()`, which projects
 * a second transcript component batch through `componentForMessage()`. When the
 * live message had advanced since the mount, that cache path disposed the OLD
 * component — the one still referenced by `messagesView` — and a paint landing
 * before the next rebuild rendered the disposed live-assistant container as zero
 * rows (fullscreen Focus transient collapse: presentationRows 51 -> 24 -> 51).
 *
 * The invariant: refreshing the row map keeps the MOUNTED batch, its component
 * identities and their lifecycle untouched; only the measurement is renewed.
 */

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
  return { kind: 'start', sessionId: 'mounted-batch', attemptId: 'attempt-1', turn: 1, step: 1 }
}

function liveText(text: string): AssistantLiveInput {
  return {
    kind: 'chunk',
    sessionId: 'mounted-batch',
    attemptId: 'attempt-1',
    turn: 1,
    step: 1,
    time: T0 + text.length,
    chunk: { type: 'text-delta', index: 0, text },
  }
}

function show(app: TuiApp, folder: TranscriptFolder): void {
  app.setTranscript(folder.messages(), folder.turnActivities(), undefined, [])
}

/** The inner components of the mounted transcript gutters, in mount order. */
function mountedTranscriptComponents(app: TuiApp): unknown[] {
  const host = app as unknown as {
    messagesView: { children: Array<{ constructor: { name: string }; child?: unknown }> }
  }
  return host.messagesView.children
    .filter(child => child.constructor.name === 'TranscriptGutterComponent')
    .map(child => child.child)
}

interface BatchEntry {
  block: { kind: string; message?: { kind: string; turn?: number; text?: string } }
  component: unknown
}

/**
 * The batch `rebuildMessages()` published as mounted, when the source supports
 * it. On the unfixed tree the field does not exist, and the test must still run
 * far enough to fail on the REAL defect (a refresh disposing the mounted
 * component) instead of a missing-field TypeError.
 */
function mountedBatch(app: TuiApp): BatchEntry[] | undefined {
  return (app as unknown as { mountedTranscriptBlocks?: BatchEntry[] }).mountedTranscriptBlocks
}

/**
 * Identify the live assistant block: by SEMANTIC IDENTITY when the published
 * batch exists (never by screen position, because `rebuildMessages()` also
 * appends gutter rows for the transcript window hint and for notices), and by
 * the legacy last-gutter heuristic only as the pre-fix fallback so the real
 * assertion can still fire.
 */
function liveAssistantComponent(app: TuiApp): unknown {
  const batch = mountedBatch(app)
  if (batch === undefined) {
    const mounted = mountedTranscriptComponents(app)
    assert.ok(mounted.length >= 2, 'the live turn must be mounted')
    return mounted[mounted.length - 1]
  }
  const assistant = batch.filter(
    entry => entry.block.kind === 'message' && entry.block.message?.kind === 'assistant',
  )
  assert.ok(assistant.length > 0, 'the assistant block must be in the mounted batch')
  return assistant[assistant.length - 1]!.component
}

/** The components of the published batch that are actually mounted as gutters. */
function mountedBatchComponents(app: TuiApp): unknown[] {
  const batch = mountedBatch(app)
  assert.ok(batch !== undefined, 'the mounted batch must be published')
  const mounted = mountedTranscriptComponents(app)
  return batch!.map(entry => entry.component).filter(component => mounted.includes(component))
}

test('fullscreen row-map refresh never rebuilds or disposes the mounted transcript batch', async () => {
  const { vt, app } = startApp(22, 29)
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 1 }, 1),
    eventAt('user/message', {
      id: MessageId('mounted-batch-user'),
      role: 'user',
      content: [{ type: 'text', text: 'ANCHOR-ONE\nANCHOR-TWO\nANCHOR-THREE\nANCHOR-FOUR' }],
      source: { kind: 'user' },
    }, 2),
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

    folder.applyLiveInput(liveText('STREAM-ONE\nSTREAM-TWO\nSTREAM-THREE\n'))
    show(app, folder)
    await vt.waitForRender()

    const mountedBefore = mountedTranscriptComponents(app)
    assert.ok(mountedBefore.length >= 2, 'the live turn must be mounted')
    // Identify the live block by identity, not by position (window-hint and
    // notify gutters are appended after it).
    const live = liveAssistantComponent(app) as { dispose?: () => void; render(width: number): string[] }
    assert.ok(
      mountedBefore.includes(live),
      'the live assistant block from the published batch must be mounted as a gutter',
    )
    assert.equal(live.render(22).length > 0, true, 'the live block starts with a positive height')
    // Contract (post-fix only): the batch components that are mounted ARE the
    // mounted gutters. Skipped on the unfixed tree, where no batch is published.
    if (mountedBatch(app) !== undefined) {
      assert.deepEqual(
        mountedBatchComponents(app),
        mountedBefore,
        'the published mounted batch must be exactly what the gutter tree holds',
      )
    }

    let disposals = 0
    const originalDispose = live.dispose?.bind(live)
    live.dispose = (): void => {
      disposals += 1
      originalDispose?.()
    }

    // The folder advances while the mounted batch still holds the previous
    // component — exactly the state the old refresh path tripped over.
    folder.applyLiveInput(liveText('STREAM-FOUR\nSTREAM-FIVE\n'))

    // Real public path that reaches refreshMessageRows().
    const anchor = app.captureTranscriptViewportAnchor()
    assert.ok(anchor !== undefined, 'a fullscreen viewport must yield a transcript anchor')
    app.restoreTranscriptViewportAnchor(anchor)

    assert.equal(disposals, 0, 'row-map refresh must not dispose the mounted component')
    assert.deepEqual(
      mountedTranscriptComponents(app),
      mountedBefore,
      'row-map refresh must not replace the mounted transcript batch',
    )
    assert.ok(
      mountedTranscriptComponents(app).includes(live),
      'row-map refresh must keep the same live component instance mounted',
    )

    // The next real rebuild may replace the batch, and the live block must stay
    // positive in every frame it produces.
    show(app, folder)
    await vt.waitForRender()
    const liveAfter = liveAssistantComponent(app) as { render(width: number): string[] }
    assert.equal(
      liveAfter.render(22).length > 0,
      true,
      'the live block must never render as zero rows after a rebuild',
    )
    if (mountedBatch(app) !== undefined) {
      assert.deepEqual(
        mountedBatchComponents(app),
        mountedTranscriptComponents(app),
        'after the rebuild the published batch must again match the mounted gutters',
      )
    }
  } finally {
    app.dispose()
    startedApps.delete(app)
  }
})
