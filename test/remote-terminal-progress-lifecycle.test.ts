/**
 * R2 L6 lifecycle suite: the REAL AgentLoop → production Host row → real
 * in-process wire → production Client source → REAL Surface → mounted TuiApp →
 * the OSC 7501 bytes a terminal would actually receive.
 *
 * ```text
 * AgentLoop turn/start + turn/end + agent/status   (real rc.2 loop)
 *   -> PiTuiTerminalProgressHostService.watch()     (production Host row)
 *   -> gateway.wireStream.open()                    (production carrier)
 *   -> createRemoteTerminalProgressSource()         (production Client source)
 *   -> Surface.applyRemoteMainProgress(fact, id)    (production Surface seam)
 *   -> TuiApp.setTerminalProgress()                 (OSC 9;4 + OSC 7501 bytes)
 * ```
 *
 * The Surface is mounted exactly like the production runner (`createSurfaceRuntime`
 * + `start()`); the consumer loop mirrors `app/bootstrap.ts`
 * `initRemoteLiveSurface` (feed every accepted fact of the ONE watch). No fact is
 * hand-built for the closed-loop proof.
 *
 * FIXTURE MANIFEST (plan §9.2)
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - `createRemoteApplicationHostFixture` (real AgentLoop harness) +
 *   `createRemoteHostRuntime` + `createRemoteClientRuntime` + the production
 *   `createRemoteTerminalProgressSource`
 * - the production `createSurfaceRuntime` with `mainProgressAuthority:
 *   'host-snapshot'`, the real event routing seam and the REAL mounted `TuiApp`
 * - the REAL injected `VirtualTerminal` sink (OSC 9;4 + OSC 7501 capture)
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - the LLM adapter is scripted (CompletedAdapter); the loop/events are real
 * - the routing source is the minimal structural stand-in the surface contract
 *   requires (no transcript/stats target is on the progress path)
 * - the notification presentation is a recording sink (the production TUI one
 *   writes terminal escape sequences that are irrelevant here)
 * - proofs 8/9 script the Host FRAME SEQUENCE through a fake wire handle while
 *   the production source + surface + TuiApp remain real
 *
 * DELIBERATELY ABSENT
 * - Ghostty/Tern GUI, a real WebSocket transport (the in-process carrier is the
 *   product's real Remote path today)
 *
 * @module @xmoon76/dsh-pi-tui/remote-terminal-progress-lifecycle.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserMessage, LlmAdapter, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { symbols } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { RemoteStreamHandle } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteMainProgressFact } from '../src/app/application-runtime.ts'
import { createRemoteClientRuntime, type RemoteClientRuntime } from '../src/app/remote/client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from '../src/app/remote/host-runtime.ts'
import {
  consumeRemoteTerminalProgress,
  createRemoteTerminalProgressSource,
  type RemoteTerminalProgressSource,
} from '../src/app/remote/terminal-progress-source.ts'
import { createSurfaceRuntime, type SurfaceRuntime } from '../src/app/surface/runtime.ts'
import type { SurfaceEventRoutingSource, RoutedSessionEvent } from '../src/app/surface/event-routing.ts'
import type { TerminalNotificationPresentation } from '../src/app/surface/notification-runtime.ts'
import type { TranscriptFolder } from '../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../src/domain/transcript/window.ts'
import type { PiTuiTerminalProgressFrame } from '../src/runtime/remote/pi-tui-terminal-progress-contract.ts'
import { createPluginManagerPanel } from '../src/tui/plugin-manager/panel.ts'
import type { TerminalProgressState } from '@xmoon76/pi-tui'
import { installVirtualProcessTerminal } from './support/runner-harness.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { createRemoteApplicationHostFixture, waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

const SESSION = 'r2-l6-main'
const IDLE = '\x1b]7501;state=idle:app=dsh-pi-tui\x1b\\'
const WORKING = '\x1b]7501;state=working:app=dsh-pi-tui\x1b\\'
const DONE = '\x1b]7501;state=done:app=dsh-pi-tui\x1b\\'
const CLEAR = '\x1b]7501;state=clear\x1b\\'

/** A short ordered-timeline label for one OSC 7501 record. */
function programTimelineLabel(sequence: string): string {
  const match = /^\x1b\]7501;state=([^:\x1b]*)(?::kind=([^:\x1b]*))?/.exec(sequence)
  if (match === null) return `7501:${sequence}`
  return match[2] === undefined ? `7501:${match[1]}` : `7501:${match[1]}:${match[2]}`
}

/** The scripted LLM endpoint: the loop and its events stay real. */
class CompletedAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

// ── the real Surface + mounted TuiApp over a VirtualTerminal ───────────────

interface NotificationPresentationProbe extends TerminalNotificationPresentation {
  readonly notifications: string[]
}

function recordingPresentation(): NotificationPresentationProbe {
  const notifications: string[] = []
  let focused = true
  return {
    notifications,
    handleFocusReport: (value: boolean) => { focused = value },
    markFocused: () => { focused = true },
    focusState: () => (focused ? 'focused' : 'unfocused'),
    notify: (method, title, body) => { notifications.push(`${method}:${title}:${body}`) },
    enableFocusReporting: () => {},
    disableFocusReporting: () => {},
  }
}

interface SurfaceProbe {
  readonly surface: SurfaceRuntime<RoutedSessionEvent>
  readonly app: unknown
  readonly vt: VirtualTerminal
  readonly programWrites: string[]
  readonly progressStates: TerminalProgressState[]
  readonly timeline: string[]
  readonly notifications: string[]
  dispose(): void
}

function minimalRoutingSource(
  sessionId: string,
  viewedChildId: () => string | undefined = () => undefined,
): SurfaceEventRoutingSource<never> {
  const emptyFolder = {
    apply: () => {},
    groupedTurns: () => [],
    turnActivities: () => [],
    searchRevision: () => 0,
    window: () => ({ messages: [], firstTurn: undefined, lastTurn: undefined, hasNewer: false }),
  } as unknown as TranscriptFolder
  const window = new TranscriptWindowController()
  const presentation = () => ({
    folder: emptyFolder,
    stats: { apply: () => {} },
    window,
    previews: new Map(),
    applyToolPreview: () => {},
    refreshRecentPerformanceAvailability: () => {},
  })
  return {
    isCleanedUp: () => false,
    isAttachedSession: () => true,
    currentSessionId: () => sessionId,
    hasLiveAgent: () => true,
    completionOwnerId: () => sessionId,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: presentation,
    viewedChildId,
    viewedChild: () => { throw new Error('no viewed-child presentation is routed in this suite') },
    mainFolder: () => emptyFolder,
    viewedChildFolder: () => emptyFolder,
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
    exitView: () => {},
    refreshStatusCheap: () => {},
    refreshStatusAndWelcome: () => {},
    applyGoalChange: () => {},
    sessionTitleOf: () => undefined,
    extendLoadedHistory: () => false,
    settleLocalSubmitAck: () => {},
    markSubmitLatency: () => {},
    observeDurableSubmission: () => {},
    markContextDirty: () => {},
    refreshContextMeasurement: () => {},
    currentWorkingFromLog: () => false,
    flushTurn: () => {},
    registeredAgentIs: () => true,
    isCurrentOwnerAgent: () => true,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: () => {},
    applyMainAssistantInput: () => {},
  } as unknown as SurfaceEventRoutingSource<never>
}

function mountSurfaceProbe(
  sessionId: string,
  notificationMode?: string,
  viewedChildId: () => string | undefined = () => undefined,
): SurfaceProbe {
  const vt = new VirtualTerminal(100, 30)
  const programWrites: string[] = []
  const progressStates: TerminalProgressState[] = []
  const timeline: string[] = []
  vt.setProgress = (active: boolean) => { timeline.push(active ? '9;4:active' : '9;4:clear') }
  vt.setProgressState = (state: TerminalProgressState) => { progressStates.push(state); timeline.push(`9;4:${state}`) }
  const passthroughWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    for (const match of data.matchAll(/\x1b\]7501;[^\x1b]*\x1b\\/g)) {
      programWrites.push(match[0])
      timeline.push(programTimelineLabel(match[0]))
    }
    passthroughWrite(data)
  }
  const restoreTerminal = installVirtualProcessTerminal(vt)
  const presentation = recordingPresentation()
  const surface = createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: presentation,
    notificationMode,
    notificationMethod: undefined,
    terminalProgress: undefined,
    mainProgressAuthority: 'host-snapshot',
    createPluginManagerPanel,
  })
  surface.attachEventRouting(minimalRoutingSource(sessionId, viewedChildId))
  surface.setCompletionOwner(sessionId)
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    sessionId: () => sessionId,
    onTerminalResize: () => {},
    copySelection: async () => false,
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: (text) => text,
  })
  let disposed = false
  return {
    surface,
    app: surface.app,
    vt,
    programWrites,
    progressStates,
    timeline,
    notifications: presentation.notifications,
    dispose: () => {
      if (disposed) return
      disposed = true
      surface.retireCompletionOwner()
      surface.dispose()
      restoreTerminal()
    },
  }
}

// ── the production closed loop ─────────────────────────────────────────────

interface RemoteLoop {
  readonly host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>
  readonly hostRuntime: RemoteHostRuntime
  readonly client: RemoteClientRuntime
  readonly source: RemoteTerminalProgressSource
  readonly surface: SurfaceProbe
  createAgent(): Promise<{ followup(message: unknown): void; whenIdle(): Promise<void> }>
  retain(): Promise<() => void>
  dispose(): Promise<void>
}

async function mountRemoteLoop(
  life: TestLifecycle,
  sessionId: string,
  viewedChildId: () => string | undefined = () => undefined,
): Promise<RemoteLoop> {
  const host = await createRemoteApplicationHostFixture(life, 'r2-l6-preset', { llmAdapter: new CompletedAdapter() })
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const source = createRemoteTerminalProgressSource({
    remote: client.remote,
    generation: client.connection.generation,
    binding: id => client.sessions.binding(id as never) as object | undefined,
  })
  const surface = mountSurfaceProbe(sessionId, 'unfocused', viewedChildId)
  let disposed = false
  return {
    host,
    hostRuntime,
    client,
    source,
    surface,
    createAgent: async () =>
      (await host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })) as unknown as {
        followup(message: unknown): void
        whenIdle(): Promise<void>
      },
    retain: async () => {
      const reference = client.sessions.retain(SessionId(sessionId), { source: 'tuiMainView' })
      await reference.ready
      return () => { reference.release() }
    },
    dispose: async () => {
      if (disposed) return
      disposed = true
      surface.dispose()
      await client.dispose()
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

// ── scripted source (proofs 8/9): real source + surface, fake wire frames ──

function fakeHandle(frames: readonly unknown[]): RemoteStreamHandle<PiTuiTerminalProgressFrame, never> {
  return {
    send: () => {},
    end: () => {},
    dispose: () => {},
    async *[Symbol.asyncIterator]() {
      for (const frame of frames) yield frame
    },
  } as RemoteStreamHandle<PiTuiTerminalProgressFrame, never>
}

function frameOf(overrides: Partial<PiTuiTerminalProgressFrame> = {}): PiTuiTerminalProgressFrame {
  return {
    kind: 'snapshot',
    sessionId: SESSION,
    hostEpoch: 'host-l6',
    agentEpoch: 1,
    revision: 1,
    running: false,
    outcome: 'idle',
    ...overrides,
  }
}

function scriptedSource(watches: ReadonlyArray<readonly unknown[]>): RemoteTerminalProgressSource {
  let index = 0
  const stableBinding: object = { retained: true }
  // ONE stable generation object: the source compares it per frame by identity.
  const stableGeneration: object = {}
  return createRemoteTerminalProgressSource({
    remote: { piTuiTerminalProgress: { watch: () => fakeHandle(watches[index++] ?? []) } },
    generation: { getSnapshot: () => stableGeneration },
    binding: () => stableBinding,
  })
}

/** The raw production Host row (its Cordis reflect read is a traceable proxy). */
function hostRowOf(ctx: { reflect: { get(key: string): unknown } }): {
  readonly records: Map<string, { readonly subscribers: Set<unknown> }>
} {
  const proxied = ctx.reflect.get('piTuiTerminalProgress') as { readonly [symbols.original]?: unknown }
  return (proxied[symbols.original] ?? proxied) as {
    readonly records: Map<string, { readonly subscribers: Set<unknown> }>
  }
}

/** Feed one whole watch into the production surface seam (bootstrap-shaped). */
async function feed(
  source: RemoteTerminalProgressSource,
  surface: SurfaceProbe,
  sessionId = SESSION,
): Promise<RemoteMainProgressFact[]> {
  const seen: RemoteMainProgressFact[] = []
  for await (const fact of source.open(sessionId, new AbortController().signal)) {
    seen.push(fact)
    surface.surface.applyRemoteMainProgress(fact, sessionId)
  }
  return seen
}

// ── PROOF 7 ────────────────────────────────────────────────────────────────

test('L6: a real turn drives the full Host -> wire -> source -> Surface -> OSC 7501 loop', async (t) => {
  const life = testLifecycle(t)
  const loop = await mountRemoteLoop(life, SESSION)
  try {
    const agent = await loop.createAgent()
    const release = await loop.retain()
    // The consumer mirrors `initRemoteLiveSurface`: apply every accepted fact.
    const controller = new AbortController()
    const facts: RemoteMainProgressFact[] = []
    const consume = (async (): Promise<void> => {
      for await (const fact of loop.source.open(SESSION, controller.signal)) {
        facts.push(fact)
        loop.surface.surface.applyRemoteMainProgress(fact, SESSION)
        if (fact.kind === 'update' && !fact.running) return
      }
    })()
    // The mount asserted the idle baseline.
    assert.deepEqual(loop.surface.programWrites, [IDLE], 'the mounted app asserts idle')
    // Wait for the opening snapshot BEFORE the turn, so the snapshot is the
    // idle baseline and the running edge is a real update.
    await waitFor('the opening snapshot', () => facts.length >= 1, 10_000)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await consume

    // The FIRST watch is a new lineage: snapshot.restart is true, and the real
    // turn's own updates are continuations of it.
    assert.equal(facts[0]!.kind, 'snapshot', 'the watch opens with a snapshot')
    assert.equal(facts[0]!.restart, true, 'a first watch snapshot restarts the lineage')
    assert.deepEqual(facts.map(fact => `${fact.kind}:${fact.restart}:${fact.running}:${fact.outcome}`),
      ['snapshot:true:false:idle', 'update:false:true:idle', 'update:false:false:done'],
      `the real loop drives snapshot -> working -> done with the lineage facts: ${JSON.stringify(facts)}`)

    // The terminal really emitted the bytes through the real Surface/TuiApp.
    assert.deepEqual(loop.surface.programWrites, [IDLE, WORKING, DONE],
      'the real loop settles OSC 7501 done exactly once')
    assert.deepEqual(loop.surface.timeline, [
      '9;4:clear', '7501:idle',
      '9;4:active', '7501:working',
      '9;4:clear', '7501:done',
    ], 'the merged timeline proves 9;4 precedes 7501 and no idle sits between working and done')
    release()
  } finally {
    await loop.dispose()
  }
})

// ── PROOF 8 ────────────────────────────────────────────────────────────────

test('L6: a displayed child viewer never takes over the main terminal root', async (t) => {
  const life = testLifecycle(t)
  const CHILD = 'r2-l6-child'
  // The surface is displaying a CHILD viewer while the main Agent runs (plan §7.4).
  const loop = await mountRemoteLoop(life, SESSION, () => CHILD)
  const controller = new AbortController()
  try {
    const createAgent = async (sessionId: string) => loop.host.ctx.agents.create({
      sessionId: SessionId(sessionId),
      agentOptions: { provider: 'smoke', model: 'smoke' },
      meta: { cwd: loop.host.anchorDir },
    })
    const handleMain = await createAgent(SESSION)
    const handleChild = await createAgent(CHILD)
    const reference = loop.client.sessions.retain(SessionId(SESSION), { source: 'tuiMainView' })
    await reference.ready
    const facts: RemoteMainProgressFact[] = []
    // Exactly the bootstrap shape: the ONE watch is the MAIN session's.
    const consumption = consumeRemoteTerminalProgress(loop.source, SESSION, controller.signal, {
      isCurrent: () => true,
      onFact: (fact) => { facts.push(fact); loop.surface.surface.applyRemoteMainProgress(fact, SESSION) },
    })
    await waitFor('the opening snapshot', () => facts.length >= 1, 10_000)
    assert.deepEqual(loop.surface.programWrites, [IDLE], 'the main root starts idle')

    // A CHILD turn while its viewer is displayed: it runs for real, but it owns no
    // terminal watch, so the main root must not move at all.
    handleChild.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'child' }], source: { kind: 'user' } }))
    await handleChild.agent.whenIdle()
    assert.deepEqual(loop.surface.programWrites, [IDLE],
      'a child run never writes the main terminal root')
    const hostRow = hostRowOf(loop.host.ctx)
    assert.equal(hostRow.records.get(CHILD)?.subscribers.size ?? 0, 0,
      'the child session holds NO terminal-progress subscriber')

    // The MAIN turn still drives the root while the child viewer stays displayed.
    handleMain.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'main' }], source: { kind: 'user' } }))
    await handleMain.agent.whenIdle()
    await waitFor('the main settle', () => loop.surface.programWrites.includes(DONE), 15_000)
    assert.deepEqual(loop.surface.programWrites, [IDLE, WORKING, DONE],
      'the main root keeps tracking the main Agent while a child viewer is displayed')

    controller.abort()
    await consumption
    await handleChild.dispose()
    await handleMain.dispose()
    reference.release()
  } finally {
    controller.abort()
    await loop.dispose()
  }
})

test('L6: a same-id Agent replacement re-establishes the watch and drives the new turn', async (t) => {
  const life = testLifecycle(t)
  const loop = await mountRemoteLoop(life, SESSION)
  const controller = new AbortController()
  try {
    const createAgent = async () => loop.host.ctx.agents.create({
      sessionId: SessionId(SESSION),
      agentOptions: { provider: 'smoke', model: 'smoke' },
      meta: { cwd: loop.host.anchorDir },
    })
    // The Client retains a session the Host already published (the reference
    // resolves through the official catalog), so the handle comes first.
    const handleA = await createAgent()
    const reference = loop.client.sessions.retain(SessionId(SESSION), { source: 'tuiMainView' })
    await reference.ready
    const facts: RemoteMainProgressFact[] = []
    // The PRODUCTION consumption policy (the same helper `bootstrap.ts` runs):
    // it re-establishes the authority when the Host retires the watch.
    let consumptionError: unknown
    const consumption = consumeRemoteTerminalProgress(loop.source, SESSION, controller.signal, {
      isCurrent: () => true,
      onFact: (fact) => { facts.push(fact); loop.surface.surface.applyRemoteMainProgress(fact, SESSION) },
    })
    void consumption.catch((error: unknown) => { consumptionError = error })
    await waitFor('the opening snapshot', () => facts.length >= 1, 10_000)
    handleA.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await handleA.agent.whenIdle()
    await waitFor('the first settle', () => loop.surface.programWrites.includes(DONE), 15_000)
    assert.deepEqual(loop.surface.programWrites, [IDLE, WORKING, DONE],
      'the first Agent lifetime drives the screen')

    // A REAL same-id replacement: rc.2 forbids a second Agent on the same id, so
    // the holder's `dispose()` (which emits `agent/disposed`) must run first. The
    // Host then retires the watch, and the consumption re-establishes it.
    await handleA.dispose()
    // The durable Session log survives the disposal, so the successor on the same
    // id is a RESUME (a fresh Agent and a fresh Session object) — exactly the
    // production replacement shape.
    const handleB = await loop.host.ctx.agents.resume({
      resumeSessionId: SessionId(SESSION),
      agentOptions: { provider: 'smoke', model: 'smoke' },
    })
    handleB.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } }))
    await handleB.agent.whenIdle()
    try {
      await waitFor('the replacement settles on the screen',
        () => loop.surface.programWrites.filter(entry => entry === DONE).length === 2, 15_000)
    } catch (error) {
      throw new Error(`${(error as Error).message} | facts=${JSON.stringify(facts)}`
        + ` | writes=${JSON.stringify(loop.surface.programWrites)}`
        + ` | consumptionError=${String(consumptionError)}`)
    }

    // The first lifetime's five frames are exact; the RE-OPENED segment is judged
    // order-independently: whether the Host retires the old watch before or after
    // the successor is published only decides whether the baseline snapshot
    // already carries the resumed epoch, so the invariant is the SHAPE, not the
    // position of the `restart` bit.
    assert.deepEqual(
      facts.slice(0, 3).map(fact => `${fact.kind}:${String(fact.restart)}:${String(fact.running)}:${fact.outcome}`),
      ['snapshot:true:false:idle', 'update:false:true:idle', 'update:false:false:done'],
      `the first lifetime drives the screen: ${JSON.stringify(facts)}`,
    )
    const reopened = facts.slice(3)
    assert.equal(reopened.length, 3, `the re-established watch delivers exactly three frames: ${JSON.stringify(facts)}`)
    assert.deepEqual(
      { kind: reopened[0]!.kind, restart: reopened[0]!.restart, running: reopened[0]!.running, outcome: reopened[0]!.outcome },
      { kind: 'snapshot', restart: true, running: false, outcome: 'idle' },
      'the re-established watch opens with an idle restart baseline',
    )
    const runningEdges = reopened.filter(fact => fact.kind === 'update' && fact.running)
    const settles = reopened.filter(fact => fact.kind === 'update' && !fact.running)
    assert.equal(runningEdges.length, 1, `exactly one running edge of the successor: ${JSON.stringify(reopened)}`)
    assert.deepEqual(
      settles.map(fact => `${String(fact.running)}:${fact.outcome}`),
      ['false:done'],
      `the successor settles done exactly once: ${JSON.stringify(reopened)}`,
    )
    assert.ok(reopened.some(fact => fact.restart),
      'the successor is marked as a NEW lineage on the edge that carries its epoch')
    assert.deepEqual(loop.surface.programWrites, [IDLE, WORKING, DONE, IDLE, WORKING, DONE],
      'the terminal keeps tracking the main Agent across the replacement')

    controller.abort()
    await consumption
    await handleB.dispose()
    reference.release()
  } finally {
    controller.abort()
    await loop.dispose()
  }
})

test('L6: opening/reconnect snapshots never notify; a real update running->idle notifies exactly once', async () => {
  const sessionId = 'r2-l6-notify'
  const surface = mountSurfaceProbe(sessionId, 'unfocused')
  try {
    surface.surface.handleTerminalFocus(false)
    // A watch that OPENS while the Host is running, disconnects, and re-opens on
    // the idle state: both frames are snapshots and must never notify.
    const snapshots = scriptedSource([
      [frameOf({ sessionId, running: true, outcome: 'idle', revision: 1 })],
      [frameOf({ sessionId, running: false, outcome: 'idle', revision: 2 })],
    ])
    await feed(snapshots, surface, sessionId)
    await feed(snapshots, surface, sessionId)
    assert.deepEqual(surface.notifications, [],
      'a running snapshot plus a reconnected idle snapshot can never fabricate a completion')

    // The control: a REAL update running->idle notifies exactly once.
    const real = scriptedSource([[
      frameOf({ sessionId, running: false, outcome: 'idle', revision: 1 }),
      frameOf({ sessionId, kind: 'update', running: true, outcome: 'idle', revision: 2 }),
      frameOf({ sessionId, kind: 'update', running: false, outcome: 'done', revision: 3 }),
    ]])
    await feed(real, surface, sessionId)
    assert.deepEqual(surface.notifications, ['auto:DSH:Turn complete'],
      'the real update pair notifies exactly once')
  } finally {
    surface.dispose()
  }
})

// ── PROOF 9 ────────────────────────────────────────────────────────────────

test('L6: the Remote feed honors the notification mode (disabled, then re-enabled)', async () => {
  const sessionId = 'r2-l6-mode'
  const surface = mountSurfaceProbe(sessionId, 'off')
  try {
    // `unfocused` mode notifies only while the terminal is NOT focused, so the
    // re-enabled half needs the same focus state the production path reports.
    surface.surface.handleTerminalFocus(false)
    const first = scriptedSource([[
      frameOf({ sessionId, running: false, outcome: 'idle', revision: 1 }),
      frameOf({ sessionId, kind: 'update', running: true, outcome: 'idle', revision: 2 }),
      frameOf({ sessionId, kind: 'update', running: false, outcome: 'done', revision: 3 }),
    ]])
    await feed(first, surface, sessionId)
    assert.deepEqual(surface.notifications, [],
      'a disabled completion notification suppresses the Remote settle too')

    // Re-enabled: the SAME feed now notifies exactly once, so the witness above
    // is the mode, not a missing edge.
    surface.surface.setNotificationMode('unfocused')
    const second = scriptedSource([[
      frameOf({ sessionId, running: false, outcome: 'idle', revision: 1 }),
      frameOf({ sessionId, kind: 'update', running: true, outcome: 'idle', revision: 2 }),
      frameOf({ sessionId, kind: 'update', running: false, outcome: 'done', revision: 3 }),
    ]])
    await feed(second, surface, sessionId)
    assert.deepEqual(surface.notifications, ['auto:DSH:Turn complete'],
      're-enabling the mode restores exactly one completion from the Remote feed')
  } finally {
    surface.dispose()
  }
})

test('L6: an owner switch re-baselines the controller so a late idle never notifies', async () => {
  const sessionId = 'r2-l6-owner'
  const surface = mountSurfaceProbe(sessionId, 'unfocused')
  try {
    surface.surface.handleTerminalFocus(false)
    const source = scriptedSource([
      // watch 1: the running edge is observed (seenRunning = true).
      [
        frameOf({ sessionId, running: false, outcome: 'idle', revision: 1 }),
        frameOf({ sessionId, kind: 'update', running: true, outcome: 'idle', revision: 2 }),
      ],
      // watch 2 (after the owner switch): continuing lineage, now idle.
      [
        frameOf({ sessionId, running: false, outcome: 'idle', revision: 3 }),
        frameOf({ sessionId, kind: 'update', running: false, outcome: 'idle', revision: 4 }),
      ],
    ])
    await feed(source, surface, sessionId)
    assert.deepEqual(surface.notifications, [], 'the running edge alone never notifies')
    // The production rebind every session switch / re-init performs.
    surface.surface.setCompletionOwner('another-session')
    await feed(source, surface, sessionId)
    assert.deepEqual(surface.notifications, [],
      'the switched-away lineage can never pair its running edge with a later idle')
  } finally {
    surface.dispose()
  }

  // The control: the SAME sequence without the switch notifies once (so the
  // witness above is discriminating, not vacuous). Mounted AFTER the first
  // surface is disposed (one process TUI slot).
  const control = mountSurfaceProbe('r2-l6-owner-control', 'unfocused')
  try {
    control.surface.handleTerminalFocus(false)
    const controlSource = scriptedSource([[
      frameOf({ sessionId: 'r2-l6-owner-control', running: false, outcome: 'idle', revision: 1 }),
      frameOf({ sessionId: 'r2-l6-owner-control', kind: 'update', running: true, outcome: 'idle', revision: 2 }),
      frameOf({ sessionId: 'r2-l6-owner-control', kind: 'update', running: false, outcome: 'done', revision: 3 }),
    ]])
    await feed(controlSource, control, 'r2-l6-owner-control')
    assert.deepEqual(control.notifications, ['auto:DSH:Turn complete'],
      'the control proves the running->idle pair notifies when the owner is unchanged')
  } finally {
    control.dispose()
  }
})

test('L6: a reconnect rebind resets seenRunning and final disposal retains a proven done', async () => {
  const sessionId = 'r2-l6-retention'
  const surface = mountSurfaceProbe(sessionId, 'unfocused')
  try {
    surface.surface.handleTerminalFocus(false)
    const source = scriptedSource([
      [
        frameOf({ sessionId, running: false, outcome: 'idle', revision: 1 }),
        frameOf({ sessionId, kind: 'update', running: true, outcome: 'idle', revision: 2 }),
      ],
      // After the rebind, the same lineage reports idle without a new running
      // edge: the reset seenRunning must keep it silent.
      [
        frameOf({ sessionId, running: false, outcome: 'idle', revision: 3 }),
        frameOf({ sessionId, kind: 'update', running: false, outcome: 'idle', revision: 4 }),
      ],
    ])
    await feed(source, surface, sessionId)
    surface.surface.setCompletionOwner(sessionId) // the re-init rebind (same id)
    await feed(source, surface, sessionId)
    assert.deepEqual(surface.notifications, [],
      'reconnecting into an idle state never notifies: seenRunning was reset')
  } finally {
    surface.dispose()
  }

  // A settled done survives the re-init and the final disposal (the retainable
  // retention contract) on a clean surface.
  const settled = mountSurfaceProbe('r2-l6-retention-settled', 'off')
  try {
    const settledSource = scriptedSource([[
      frameOf({ sessionId: 'r2-l6-retention-settled', running: false, outcome: 'idle', revision: 1 }),
      frameOf({ sessionId: 'r2-l6-retention-settled', kind: 'update', running: true, outcome: 'idle', revision: 2 }),
      frameOf({ sessionId: 'r2-l6-retention-settled', kind: 'update', running: false, outcome: 'done', revision: 3 }),
    ]])
    await feed(settledSource, settled, 'r2-l6-retention-settled')
    assert.deepEqual(settled.programWrites, [IDLE, WORKING, DONE],
      'the settled lineage reaches the terminal')
    settled.surface.retireCompletionOwner()
    assert.equal(settled.programWrites[settled.programWrites.length - 1], DONE,
      'the retire fold preserves the proven done')
    assert.ok(!settled.programWrites.includes(CLEAR), 'a retainable done is never cleared on the way out')
  } finally {
    settled.dispose()
  }
})
