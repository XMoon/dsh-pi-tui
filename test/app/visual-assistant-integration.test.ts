/**
 * Production-equivalent visual Assistant integration.
 *
 * The real DSH AgentLoop / SessionQuery / ToolRuntime execute the production
 * `dsh_pi_tui_chart`, `dsh_pi_tui_svg` and `present_visual` tools. Their
 * committed events then flow through a real `TranscriptFolder`, the real
 * `SurfaceRuntime` repaint commit and the PiTui `TuiApp` mounted on a
 * `VirtualTerminal`. The runtime reads the exact live Session through the same
 * read-only snapshot seam the composition root injects in production.
 *
 * NOT covered here: a physical terminal, a Remote log (deliberately absent),
 * and the native TSP renderer (PR3).
 * @module @xmoon76/dsh-pi-tui/app/visual-assistant-integration.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  ToolCallId,
  createUserMessage,
  type ContentBlock,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import { apply as applyVisualTools } from '../../src/app/host/visual-tools.ts'
import { createSurfaceRuntime, type SurfaceEventRoutingSource, type SurfaceViewedChildPresentation } from '../../src/app/surface/runtime.ts'
import { createVisualEventSnapshotProvider } from '../../src/app/bootstrap/visual-snapshot.ts'
import { createPresentationBridge } from '../../src/app/bootstrap/presentation-bridge.ts'
import { installVirtualProcessTerminal } from '../support/runner-harness.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { TranscriptFolder, type TranscriptMessage } from '../../src/transcript.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { asVisualSessionEvents, collectPublishedVisuals } from '../../src/domain/visual/publication.ts'
import { assistantVisualPresentation, type VisualEventSnapshot } from '../../src/domain/visual/presentation.ts'
import { createViewerRuntime, type ViewerChildSource, type ViewerChildView, type ViewerRuntimeDeps } from '../../src/app/surface/viewer-runtime.ts'
import type { SessionPresentationEvent } from '../../src/app/surface/session-presentation.ts'
import type { SurfaceRuntime } from '../../src/app/surface/runtime.ts'
import { toolSummaryKeys } from '../../src/tui/transcript/tool-presentation.ts'
import { displaySeamStub } from '../support/display-seam-stub.ts'
import { readFileSync } from 'node:fs'
import { CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME } from '../../src/domain/visual/tools.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/>'
  + '<text x="4" y="20" font-size="12" fill="#ffffff">Gateway</text></svg>'

const CHART = {
  kind: 'bars',
  title: 'Request latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 70 }],
}
const CHART_B = {
  kind: 'bars',
  title: 'Other session latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 11 }],
}
const SVG = { title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }

interface ScriptedCall {
  readonly callId: string
  readonly name: string
  readonly args: unknown
}

type CallsPlan = readonly ScriptedCall[] | ((prompt: string) => readonly ScriptedCall[])
type StepPlan =
  | { readonly calls: CallsPlan }
  | { readonly text: string | ((prompt: string) => string) }

class ScriptedAdapter extends LlmAdapter {
  readonly prompts: string[] = []
  plans: StepPlan[] = []

  override providerInfo(provider: string): { id: string; name: string } { return { id: provider, name: provider } }
  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider, id: 'm', name: 'M' }])
  }
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = JSON.stringify(options.messages ?? [])
    this.prompts.push(prompt)
    const plan = this.plans[this.prompts.length - 1]
    if (plan !== undefined && 'calls' in plan) {
      const calls = typeof plan.calls === 'function' ? plan.calls(prompt) : plan.calls
      for (const [index, call] of calls.entries()) {
        const args = JSON.stringify(call.args)
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id: ToolCallId(call.callId), name: call.name, argumentsDelta: args }
        yield { type: 'block-end', index, block: { type: 'tool-call', id: ToolCallId(call.callId), name: call.name, arguments: args } }
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = plan !== undefined && 'text' in plan
      ? (typeof plan.text === 'function' ? plan.text(prompt) : plan.text)
      : 'done'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function refsInPrompt(prompt: string): string[] {
  return [...prompt.matchAll(/visual-ref-v1:(sv1_[0-9a-f]{20})/gu)].map(match => match[1] as string)
}

function marker(ref: string): string {
  return `[dsh-visual-${ref}]: <#>`
}

interface RealSession {
  readonly sessionId: string
  /** The exact live Agent object (viewer identity / snapshot owner). */
  readonly agent: object
  readonly session: {
    readonly id: string
    readonly seq: number
    snapshotEvents(): readonly SessionEvent[]
  }
  readonly adapter: ScriptedAdapter
  run(steps: readonly StepPlan[]): Promise<void>
  /** Flip the ONE profile-wide Visual tools switch for a historical replay. */
  setEnabled(next: boolean): void
}

async function bootRealSession(life: TestLifecycle, label: string): Promise<RealSession> {
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, {})
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
  let enabled = true
  applyVisualTools(ctx, { enabled: { get: () => enabled } } as never)
  const sessionId = `${label}-${Math.random().toString(36).slice(2, 10)}`
  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter([`visual-assistant-${label}`], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId) as never,
    agentOptions: { provider: `visual-assistant-${label}`, model: 'm' },
    setup: () => {},
  })
  const agent = handle.agent as unknown as {
    followup(message: unknown): void
    whenIdle(): Promise<void>
    session: RealSession['session']
  }
  return {
    sessionId,
    agent: agent as object,
    session: agent.session,
    adapter,
    async run(steps: readonly StepPlan[]): Promise<void> {
      adapter.plans = [...steps]
      adapter.prompts.length = 0
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
    setEnabled(next: boolean): void {
      enabled = next
      ctx.emit('loader/volatile-update', [['enabled']])
    },
  }
}

interface SnapshotSource {
  readonly session: object
  readonly sessionId: string
  readonly seq: number
  readonly events: readonly SessionEvent[]
}

function snapshotOf(session: RealSession): SnapshotSource {
  return {
    session: session.session,
    sessionId: session.sessionId,
    seq: session.session.seq,
    events: session.session.snapshotEvents(),
  }
}

interface SurfaceHarness {
  readonly surface: ReturnType<typeof createSurfaceRuntime<SessionEvent>>
  readonly vt: VirtualTerminal
  setMain(sessionId: string, folder: TranscriptFolder): void
  setViewedChild(sessionId: string, folder: TranscriptFolder): void
  clearViewedChild(): void
  repaint(): Promise<void>
  dispose(): void
}

function mountSurface(
  snapshots: ReadonlyMap<string, SnapshotSource>,
  initialSessionId: string,
  initialFolder: TranscriptFolder,
  options: {
    readonly visualEventSnapshotFor?: (subject: {
      readonly subjectKind: 'main' | 'viewed-child'
      readonly subjectId: string | undefined
    }) => SnapshotSource | undefined
    readonly visualEventSnapshot?: (subject: {
      readonly subjectKind: 'main' | 'viewed-child'
      readonly subjectId: string | undefined
    }) => VisualEventSnapshot | undefined
    readonly viewedChildAgent?: () => object | undefined
    readonly viewedChildId?: () => string | undefined
    readonly viewedChildPresentation?: () => SurfaceViewedChildPresentation<SessionEvent>
    readonly viewedChildFolder?: () => TranscriptFolder
  } = {},
): SurfaceHarness {
  const vt = new VirtualTerminal(120, 100)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  const controller = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 })
  let mainSessionId = initialSessionId
  let mainFolder = initialFolder
  let viewed: { id: string; folder: TranscriptFolder; window: TranscriptWindowController } | undefined
  const stats = { apply: () => {} }
  const previews = new Map()
  const mainPresentation = {
    folder: { apply: (events: readonly SessionEvent[]) => mainFolder.apply(events) },
    stats,
    get window() { return controller },
    previews,
    applyToolPreview: () => {},
    refreshRecentPerformanceAvailability: () => {},
  }
  const childPresentation = () => ({
    id: viewed!.id,
    folder: { apply: (events: readonly SessionEvent[]) => viewed!.folder.apply(events) },
    stats,
    window: viewed!.window,
    previews,
    applyToolPreview: () => {},
    beginTurn: () => {},
    endTurn: () => {},
    refreshFooter: () => {},
  })
  const source: SurfaceEventRoutingSource<SessionEvent> = {
    isCleanedUp: () => false,
    isAttachedSession: session => session.id === mainSessionId || (viewed !== undefined && session.id === viewed.id),
    currentSessionId: () => mainSessionId,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => mainPresentation,
    viewedChildId: options.viewedChildId ?? (() => viewed?.id),
    viewedChild: options.viewedChildPresentation ?? (() => childPresentation()),
    mainFolder: () => mainFolder,
    viewedChildFolder: options.viewedChildFolder ?? (() => viewed!.folder),
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
    exitView: () => { viewed = undefined },
    refreshStatusCheap: () => {},
    refreshStatusAndWelcome: () => {},
    refreshWorkspaceFacts: () => {},
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
    registeredAgentIs: () => false,
    isCurrentOwnerAgent: () => false,
    viewedChildAgent: options.viewedChildAgent ?? (() => undefined),
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: input => viewed!.folder.applyLiveInput(input),
    applyMainAssistantInput: input => mainFolder.applyLiveInput(input),
  }
  const surface = createSurfaceRuntime<SessionEvent>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: {
      handleFocusReport: () => {},
      markFocused: () => {},
      focusState: () => 'focused' as const,
      notify: () => {},
      enableFocusReporting: () => {},
      disableFocusReporting: () => {},
    },
    notificationMode: undefined,
    notificationMethod: undefined,
    terminalProgress: undefined,
    mainProgressAuthority: 'local-events',
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
    visualEventSnapshotFor: subject => {
      if (options.visualEventSnapshot !== undefined) return options.visualEventSnapshot(subject)
      const snapshot = options.visualEventSnapshotFor === undefined
        ? (subject.subjectId === undefined ? undefined : snapshots.get(subject.subjectId))
        : options.visualEventSnapshotFor(subject)
      if (snapshot === undefined) return undefined
      return {
        session: snapshot.session,
        sessionId: snapshot.sessionId,
        seq: snapshot.seq,
        events: asVisualSessionEvents(snapshot.events),
      }
    },
  })
  surface.attachEventRouting(source)
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'full' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId: mainSessionId, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  })
  return {
    surface,
    vt,
    setMain(sessionId, folder) {
      mainSessionId = sessionId
      mainFolder = folder
      controller.setTurns(folder.groupedTurns())
    },
    setViewedChild(sessionId, folder) {
      viewed = { id: sessionId, folder, window: new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 }) }
    },
    clearViewedChild() {
      viewed = undefined
    },
    async repaint() {
      surface.repaint()
      await vt.waitForRender()
    },
    dispose() {
      surface.dispose()
      restoreTerminal()
    },
  }
}

/** Replay a committed log one event at a time through the production folder
 * and the production surface commit (the live-shaped path). */
async function replayIncrementally(
  harness: SurfaceHarness,
  folder: TranscriptFolder,
  events: readonly SessionEvent[],
): Promise<void> {
  for (const event of events) {
    folder.apply([event])
    await harness.repaint()
  }
}

function bulletRows(view: string): string[] {
  return view.split('\n').filter(line => line.trimStart().startsWith('🐋') && !line.includes('dsh-pi-tui'))
}

function eventsOf(session: RealSession): readonly SessionEvent[] {
  return session.session.snapshotEvents()
}

/** A final text plan whose marker uses the first reference the model received. */
function markerAnswer(before: string, after: string): (prompt: string) => string {
  return prompt => {
    const ref = refsInPrompt(prompt)[0]
    assert.ok(ref !== undefined, 'the model received the visual reference')
    return `${before}\n\n${marker(ref)}\n\n${after}`
  }
}

/** Run one published-chart answer through the real loop and return its session. */
async function runChartAnswer(
  session: RealSession,
  chart: unknown,
  before: string,
  after: string,
): Promise<void> {
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: chart }] },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
      }],
    },
    { text: markerAnswer(before, after) },
  ])
}

// ── the positive production chain ────────────────────────────────────────

test('a real chart publication is inserted at its final-answer marker in the production surface', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'chart')
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
      }],
    },
    { text: markerAnswer('Before figure.', 'After figure.') },
  ])
  const publications = collectPublishedVisuals(session.sessionId, asVisualSessionEvents(eventsOf(session)))
  assert.equal(publications.length, 1, 'the real publication was accepted')
  assert.equal(publications[0]?.source.type, 'chart')

  const folder = new TranscriptFolder()
  const harness = mountSurface(new Map([[session.sessionId, snapshotOf(session)]]), session.sessionId, folder)
  try {
    await replayIncrementally(harness, folder, eventsOf(session))
    const view = harness.vt.getViewport().join('\n')
    assert.ok(view.includes('Before figure.') && view.includes('After figure.'), `answer text visible:\n${view}`)
    assert.ok(!view.includes('[dsh-visual-'), 'the marker line never paints')
    assert.ok(view.includes('Request latency') && view.includes('42 ms'), `inline chart painted:\n${view}`)
    const inlineChart = view.indexOf('Request latency', view.indexOf('Before figure.'))
    assert.ok(inlineChart > view.indexOf('Before figure.') && inlineChart < view.indexOf('After figure.'),
    `the chart is inline between the two paragraphs:\n${view}`)
    assert.equal(bulletRows(view).length, 1)
    // The same committed seq repaints as a no-op: no new structural commit and
    // no dirty block, so the sidecar revision stayed stable.
    const before = harness.surface.app.transcriptPresentationDiagnosticsForTest()
    await harness.repaint()
    const after = harness.surface.app.transcriptPresentationDiagnosticsForTest()
    assert.equal(after.structuralCommits, before.structuralCommits)
    assert.equal(after.noopCommits, before.noopCommits + 1)
  } finally {
    harness.dispose()
  }
})

test('the real published turn yields the display /copy payload through the Direct bridge', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'display-copy')
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
      }],
    },
    { text: markerAnswer('BEFORE-COPY', 'AFTER-COPY') },
  ])
  const events = eventsOf(session)
  const publications = collectPublishedVisuals(session.sessionId, asVisualSessionEvents(events))
  assert.equal(publications.length, 1, 'the real publication was accepted')
  const folder = new TranscriptFolder()
  folder.apply(events)
  // The bridge reads the EXACT live Session object through its official
  // `eventAt`/`snapshotEvents` surface and the SAME Folder the surface folds.
  const bridge = createPresentationBridge({
    remoteSources: undefined,
    currentSessionId: () => session.sessionId,
    currentDirectAgent: () => session.agent as { session: { id: string; snapshotEvents(): readonly unknown[] } },
    assistantStreamBaselineFor: () => [],
    // TEST STAND-IN for the official `Session.eventAt`: it slices the SAME
    // committed snapshot; production reads the Session's own accessor.
    directSessionFor: () => ({
      seq: session.session.seq,
      snapshotEvents: () => session.session.snapshotEvents(),
      eventAt: (seq: number) => session.session.snapshotEvents()[seq],
    }),
    mainFolder: () => folder,
    currentGeneration: () => 1,
  })
  const copy = bridge.directLastAssistantText(session.sessionId)
  assert.equal(copy, 'BEFORE-COPY\n\n\n\nAFTER-COPY',
    'the consumed marker line is gone; the surrounding newlines stay exactly as written')
  const latest = events.filter(event => event.type === 'assistant/message').at(-1)
  assert.ok(latest !== undefined)
  const raw = latest.data.message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
  assert.ok(raw.includes('[dsh-visual-'), 'the durable official body keeps its machine marker')
  assert.equal(raw.includes('visual-v1:'), false, 'the answer text itself carries no machine fact')
})

test('a chart generated without present_visual stays only in the tool card', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'unpublished')
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    { text: markerAnswer('Before.', 'After.') },
  ])
  assert.deepEqual(collectPublishedVisuals(session.sessionId, asVisualSessionEvents(eventsOf(session))), [])
  const folder = new TranscriptFolder()
  const harness = mountSurface(new Map([[session.sessionId, snapshotOf(session)]]), session.sessionId, folder)
  try {
    folder.apply(eventsOf(session))
    await harness.repaint()
    const view = harness.vt.getViewport().join('\n')
    assert.ok(view.includes('Before.') && view.includes('After.'))
    // The tool card paints the chart BEFORE the final answer row; the answer
    // itself has no inline figure.
    assert.ok(view.indexOf('Request latency') < view.indexOf('Before.'),
      `the chart stays in the Work card:\n${view}`)
    assert.equal(view.indexOf('Request latency', view.indexOf('Before.')), -1,
      `no inline figure appears after the answer starts:\n${view}`)
    assert.ok(!view.includes('[dsh-visual-'))
  } finally {
    harness.dispose()
  }
})

test('a real publication whose final marker names another ref is tailed after the answer', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'marker-replaced')
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
      }],
    },
    {
      text: () => `Before.\n\n${marker('sv1_ffffffffffffffffffff')}\n\nAfter.`,
    },
  ])
  assert.equal(collectPublishedVisuals(session.sessionId, asVisualSessionEvents(eventsOf(session))).length, 1)
  const folder = new TranscriptFolder()
  const harness = mountSurface(new Map([[session.sessionId, snapshotOf(session)]]), session.sessionId, folder)
  try {
    folder.apply(eventsOf(session))
    await harness.repaint()
    const view = harness.vt.getViewport().join('\n')
    assert.ok(view.includes('Before.') && view.includes('After.'))
    assert.ok(view.indexOf('Before.') < view.indexOf('After.'))
    const tailChart = view.indexOf('Request latency', view.indexOf('After.'))
    assert.ok(tailChart > view.indexOf('After.'),
      `the unconsumed published visual tails the body:\n${view}`)
    assert.ok(!view.includes('[dsh-visual-'))
  } finally {
    harness.dispose()
  }
})

test('two real figures (chart and SVG) keep their two inline marker positions', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'two-figures')
  await session.run([
    {
      calls: [
        { callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART },
        { callId: 'call-svg', name: SVG_TOOL_NAME, args: SVG },
      ],
    },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: refsInPrompt(prompt).map(ref => ({ ref })) },
      }],
    },
    {
      text: prompt => {
        const refs = refsInPrompt(prompt)
        assert.equal(refs.length, 2)
        return `Before chart.\n\n${marker(refs[0] as string)}\n\nBetween figures.\n\n${marker(refs[1] as string)}\n\nAfter SVG.`
      },
    },
  ])
  const publications = collectPublishedVisuals(session.sessionId, asVisualSessionEvents(eventsOf(session)))
  assert.deepEqual(publications.map(entry => entry.source.type), ['chart', 'svg'])
  const folder = new TranscriptFolder()
  const harness = mountSurface(new Map([[session.sessionId, snapshotOf(session)]]), session.sessionId, folder)
  try {
    folder.apply(eventsOf(session))
    await harness.repaint()
    const view = harness.vt.getViewport().join('\n')
    const before = view.indexOf('Before chart.')
    const chart = view.indexOf('Request latency', before)
    const between = view.indexOf('Between figures.')
    const svg = view.indexOf('Service topology', between)
    const after = view.indexOf('After SVG.')
    assert.ok(before >= 0 && chart > before && between > chart && svg > between && after > svg,
      `both figures stay at their own marker positions:\n${view}`)
    assert.ok(view.includes('Gateway -> App -> Database'), 'SVG description visible')
    assert.equal(bulletRows(view).length, 1)
  } finally {
    harness.dispose()
  }
})

test('a cold replay of the same committed log paints the same inline chart', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'cold')
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
      }],
    },
    { text: markerAnswer('Cold before.', 'Cold after.') },
  ])
  const folder = new TranscriptFolder()
  folder.apply(eventsOf(session))
  const harness = mountSurface(new Map([[session.sessionId, snapshotOf(session)]]), session.sessionId, folder)
  try {
    await harness.repaint()
    const view = harness.vt.getViewport().join('\n')
    const inline = view.indexOf('Request latency', view.indexOf('Cold before.'))
    assert.ok(view.indexOf('Cold before.') < inline && inline < view.indexOf('Cold after.'),
      `cold replay inline chart:\n${view}`)
  } finally {
    harness.dispose()
  }
})

test('switching main subjects A -> B -> A never revives the other session visual', async (t) => {
  const life = testLifecycle(t)
  const first = await bootRealSession(life, 'subject-a')
  const second = await bootRealSession(life, 'subject-b')
  const runOne = async (session: RealSession, chart: unknown, before: string, after: string): Promise<void> => {
    await session.run([
      { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: chart }] },
      {
        calls: prompt => [{
          callId: 'call-present',
          name: PRESENT_VISUAL_TOOL_NAME,
          args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
        }],
      },
      { text: markerAnswer(before, after) },
    ])
  }
  await runOne(first, CHART, 'First before.', 'First after.')
  await runOne(second, CHART_B, 'Second before.', 'Second after.')
  const firstFolder = new TranscriptFolder()
  const secondFolder = new TranscriptFolder()
  firstFolder.apply(eventsOf(first))
  secondFolder.apply(eventsOf(second))
  const snapshots = new Map([
    [first.sessionId, snapshotOf(first)],
    [second.sessionId, snapshotOf(second)],
  ])
  const harness = mountSurface(snapshots, first.sessionId, firstFolder)
  try {
    await harness.repaint()
    const firstView = harness.vt.getViewport().join('\n')
    assert.ok(firstView.includes('Request latency'))
    assert.ok(!firstView.includes('Other session latency'))

    harness.setMain(second.sessionId, secondFolder)
    await harness.repaint()
    const secondView = harness.vt.getViewport().join('\n')
    assert.ok(secondView.includes('Other session latency'))
    assert.ok(!secondView.includes('Request latency'), `the first session visual never leaks:\n${secondView}`)

    harness.setMain(first.sessionId, firstFolder)
    await harness.repaint()
    const backView = harness.vt.getViewport().join('\n')
    assert.ok(backView.includes('Request latency'))
    assert.ok(!backView.includes('Other session latency'), `A -> B -> A restores only A:\n${backView}`)
    assert.ok(backView.includes('First before.') && backView.includes('First after.'))
  } finally {
    harness.dispose()
  }
})

test('a mounted viewed-child subject uses the child Session and never the parent visual', async (t) => {
  const life = testLifecycle(t)
  const parent = await bootRealSession(life, 'parent')
  const child = await bootRealSession(life, 'child')
  await parent.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
      }],
    },
    { text: markerAnswer('Parent before.', 'Parent after.') },
  ])
  await child.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART_B }] },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
      }],
    },
    { text: markerAnswer('Child before.', 'Child after.') },
  ])
  const parentFolder = new TranscriptFolder()
  const childFolder = new TranscriptFolder()
  parentFolder.apply(eventsOf(parent))
  childFolder.apply(eventsOf(child))
  const snapshots = new Map([
    [parent.sessionId, snapshotOf(parent)],
    [child.sessionId, snapshotOf(child)],
  ])
  const harness = mountSurface(snapshots, parent.sessionId, parentFolder)
  try {
    await harness.repaint()
    assert.ok(harness.vt.getViewport().join('\n').includes('Request latency'))
    harness.setViewedChild(child.sessionId, childFolder)
    await harness.repaint()
    const childView = harness.vt.getViewport().join('\n')
    assert.ok(childView.includes('Other session latency'), `the child visual is derived from the child log:\n${childView}`)
    assert.ok(!childView.includes('Request latency'), `the parent visual never leaks into the child:\n${childView}`)
    harness.clearViewedChild()
    await harness.repaint()
    assert.ok(harness.vt.getViewport().join('\n').includes('Request latency'))
  } finally {
    harness.dispose()
  }
})

test('a subject whose Session cannot be read paints no inline figure', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'no-session')
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
      }],
    },
    { text: markerAnswer('No read before.', 'No read after.') },
  ])
  const folder = new TranscriptFolder()
  folder.apply(eventsOf(session))
  // The snapshot supply deliberately knows nothing about this subject (the
  // Remote / unavailable-complete-log shape).
  const harness = mountSurface(new Map(), session.sessionId, folder)
  try {
    await harness.repaint()
    const view = harness.vt.getViewport().join('\n')
    assert.ok(view.includes('No read before.') && view.includes('No read after.'))
    assert.ok(view.indexOf('Request latency') < view.indexOf('No read before.'))
    assert.equal(view.indexOf('Request latency', view.indexOf('No read before.')), -1,
      `no trustworthy Session read means no inline visual:\n${view}`)
  } finally {
    harness.dispose()
  }
})


test('three generated figures with only two published inline/tail exactly those two', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'three-to-two')
  const publishedChart = { ...CHART, title: 'Published chart' }
  const unpublishedChart = { ...CHART, title: 'Unpublished chart' }
  await session.run([
    {
      calls: [
        { callId: 'call-chart-a', name: CHART_TOOL_NAME, args: publishedChart },
        { callId: 'call-svg-a', name: SVG_TOOL_NAME, args: SVG },
        { callId: 'call-chart-c', name: CHART_TOOL_NAME, args: unpublishedChart },
      ],
    },
    {
      calls: prompt => {
        const refs = refsInPrompt(prompt)
        assert.equal(refs.length, 3)
        return [{
          callId: 'call-present',
          name: PRESENT_VISUAL_TOOL_NAME,
          args: { visuals: [{ ref: refs[0] }, { ref: refs[1] }] },
        }]
      },
    },
    {
      text: prompt => {
        const refs = refsInPrompt(prompt)
        assert.equal(refs.length, 3)
        return `Before.\n\n${marker(refs[0] as string)}\n\nAfter.`
      },
    },
  ])
  const publications = collectPublishedVisuals(session.sessionId, asVisualSessionEvents(eventsOf(session)))
  assert.equal(publications.length, 2, 'the third figure is never published')
  const folder = new TranscriptFolder()
  const harness = mountSurface(new Map([[session.sessionId, snapshotOf(session)]]), session.sessionId, folder)
  try {
    folder.apply(eventsOf(session))
    await harness.repaint()
    const view = harness.vt.getViewport().join('\n')
    const answerStart = view.indexOf('Before.')
    assert.ok(answerStart >= 0)
    const inline = view.indexOf('Published chart', answerStart)
    const tail = view.indexOf('Service topology', answerStart)
    assert.ok(inline > answerStart && tail > inline, `published chart inline then the SVG tail:\n${view}`)
    assert.equal(view.indexOf('Unpublished chart', answerStart), -1,
      `the unpublished figure never enters the answer:\n${view}`)
  } finally {
    harness.dispose()
  }
})

test('a historical session keeps its published inline figure after Visual tools are switched Off', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'tools-off-replay')
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
      }],
    },
    { text: markerAnswer('Historical before.', 'Historical after.') },
  ])
  session.setEnabled(false)
  const folder = new TranscriptFolder()
  const harness = mountSurface(new Map([[session.sessionId, snapshotOf(session)]]), session.sessionId, folder)
  try {
    folder.apply(eventsOf(session))
    await harness.repaint()
    const view = harness.vt.getViewport().join('\n')
    const inline = view.indexOf('Request latency', view.indexOf('Historical before.'))
    assert.ok(inline > view.indexOf('Historical before.') && inline < view.indexOf('Historical after.'),
      `the historical publication replays independently of the current switch:\n${view}`)
  } finally {
    harness.dispose()
  }
})

test('a same-id Session replacement (resume-shaped new instance) re-derives the same visual', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'resume-same-id')
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
      }],
    },
    { text: markerAnswer('Resume before.', 'Resume after.') },
  ])
  const events = eventsOf(session)
  const replacement = {
    session: {
      id: session.sessionId,
      seq: session.session.seq,
      snapshotEvents: () => events,
    },
    sessionId: session.sessionId,
    seq: session.session.seq,
    events,
  }
  const folder = new TranscriptFolder()
  folder.apply(events)
  const harness = mountSurface(new Map([[session.sessionId, replacement]]), session.sessionId, folder)
  try {
    await harness.repaint()
    const view = harness.vt.getViewport().join('\n')
    const inline = view.indexOf('Request latency', view.indexOf('Resume before.'))
    assert.ok(inline > view.indexOf('Resume before.') && inline < view.indexOf('Resume after.'),
      `a new same-id Session instance re-derives the projection:\n${view}`)
  } finally {
    harness.dispose()
  }
})


test('a synchronous subject switch inside setTranscript discards the old visual and commits the successor', async (t) => {
  const life = testLifecycle(t)
  const first = await bootRealSession(life, 'commit-switch-a')
  const second = await bootRealSession(life, 'commit-switch-b')
  await runChartAnswer(first, { ...CHART, title: 'Commit chart A' }, 'A before.', 'A after.')
  await runChartAnswer(second, { ...CHART, title: 'Commit chart B' }, 'B before.', 'B after.')
  const firstFolder = new TranscriptFolder()
  const secondFolder = new TranscriptFolder()
  firstFolder.apply(eventsOf(first))
  secondFolder.apply(eventsOf(second))
  const firstAssistant = firstFolder.messages().find(
    (message): message is Extract<TranscriptMessage, { kind: 'assistant' }> => message.kind === 'assistant',
  )
  assert.ok(firstAssistant !== undefined)
  const snapshots = new Map([
    [first.sessionId, snapshotOf(first)],
    [second.sessionId, snapshotOf(second)],
  ])
  const harness = mountSurface(snapshots, first.sessionId, firstFolder)
  try {
    await harness.repaint()
    assert.ok(harness.vt.getViewport().join('\n').includes('Commit chart A'))
    assert.ok(assistantVisualPresentation(firstAssistant) !== undefined, 'precondition: A has an inline visual sidecar')
    // The display seam commits A, then SYNCHRONOUSLY hands the surface to B in
    // the same call. The runtime must drop A's sidecar and commit B now.
    const app = harness.surface.app
    const prototype = Object.getPrototypeOf(app) as { setTranscript: typeof app.setTranscript }
    const original = prototype.setTranscript
    let switched = false
    app.setTranscript = (...args: Parameters<typeof app.setTranscript>) => {
      const result = original.call(app, ...args)
      if (!switched) {
        switched = true
        harness.setMain(second.sessionId, secondFolder)
      }
      return result
    }
    await harness.repaint()
    const view = harness.vt.getViewport().join('\n')
    assert.ok(view.includes('B before.') && view.includes('B after.'), `the successor frame is committed:\n${view}`)
    const inline = view.indexOf('Commit chart B', view.indexOf('B before.'))
    assert.ok(inline > view.indexOf('B before.') && inline < view.indexOf('B after.'),
      `the successor visual is inline:\n${view}`)
    assert.equal(assistantVisualPresentation(firstAssistant), undefined,
      'the pre-commit visual sidecar on the old row was discarded')
  } finally {
    harness.dispose()
  }
})

test('the real ViewerRuntime folder/selection and production snapshot provider drive the visual surface', async (t) => {
  const life = testLifecycle(t)
  const parent = await bootRealSession(life, 'viewer-parent')
  const child = await bootRealSession(life, 'viewer-child')
  await runChartAnswer(child, { ...CHART, title: 'Child viewer chart' }, 'Child before.', 'Child after.')
  const parentFolder = new TranscriptFolder()
  const childEvents = eventsOf(child)
  const childView: ViewerChildView<SessionPresentationEvent> = {
    childSessionId: child.sessionId,
    parentSessionId: parent.sessionId,
    snapshot: {
      durableEvents: childEvents as unknown as SessionPresentationEvent[],
      liveInputs: [],
      activity: 'inactive',
      cwd: '',
      revision: undefined,
    },
    viewAgent: child.agent,
    rehydrate: async () => undefined,
    loadOlder: async () => {},
    currentActivity: () => 'inactive',
    subscribe: () => undefined,
    release: () => {},
  }
  const childSource: ViewerChildSource<SessionPresentationEvent> = {
    open: async () => childView,
    childWriterSubject: () => undefined,
  }
  const viewerSurface = {
    routeSessionEvent: () => {},
    repaint: () => {},
    refreshPendingInput: () => {},
    display: displaySeamStub(),
    app: {
      enterFocusViewerScope: () => {},
      exitFocusViewerScope: () => {},
      discardFocusViewerScope: () => {},
      setViewerMode: () => {},
      clearLocalMessages: () => {},
      clearNotify: () => {},
      getViewerGeneration: () => 0,
      notify: () => {},
      getDraft: () => '',
      setEditorText: () => {},
      restoreSubagentDraft: () => {},
    },
  } as unknown as SurfaceRuntime<SessionPresentationEvent>
  const viewer = createViewerRuntime<SessionPresentationEvent>({
    surface: viewerSurface,
    isCleanedUp: () => false,
    summaryKeys: toolSummaryKeys,
    currentSessionId: () => parent.sessionId,
    liveParentSessionId: () => parent.sessionId,
    childView: childSource,
    refreshStatus: () => {},
    restoreMainTranscriptAnchor: () => {},
    runDetached: () => {},
  } satisfies ViewerRuntimeDeps<SessionPresentationEvent>)
  await viewer.enterView(child.sessionId, 'child', 'one-shot', parent.sessionId, 'inactive')
  assert.ok(viewer.viewedChildAgent() !== undefined, 'the real viewer owns the exact child Agent identity')
  const read = viewer.read()
  assert.ok(read !== undefined, 'the real viewer owns the child folder/selection')

  // The PRODUCTION selector closure is executed, not re-implemented here.
  const provider = createVisualEventSnapshotProvider({
    isRemote: () => false,
    mainAgent: () => parent.agent,
    viewedChildAgent: () => viewer.viewedChildAgent(),
  })
  const mainSnapshot = provider({ subjectKind: 'main', subjectId: parent.sessionId })
  assert.equal(mainSnapshot?.sessionId, parent.sessionId, 'main selection returns the main Session')
  const childSnapshot = provider({ subjectKind: 'viewed-child', subjectId: child.sessionId })
  assert.equal(childSnapshot?.sessionId, child.sessionId, 'viewed-child selection returns the child Session')
  assert.equal(provider({ subjectKind: 'viewed-child', subjectId: 'wrong-subject' }), undefined,
    'a mismatched subject id is refused')
  const remoteProvider = createVisualEventSnapshotProvider({
    isRemote: () => true,
    mainAgent: () => parent.agent,
    viewedChildAgent: () => viewer.viewedChildAgent(),
  })
  assert.equal(remoteProvider({ subjectKind: 'main', subjectId: parent.sessionId }), undefined,
    'Remote fails closed instead of inventing a log')

  const harness = mountSurface(
    new Map([
      [parent.sessionId, snapshotOf(parent)],
      [child.sessionId, snapshotOf(child)],
    ]),
    parent.sessionId,
    parentFolder,
    {
      viewedChildId: () => viewer.isViewing() ? child.sessionId : undefined,
      viewedChildPresentation: () => viewer.presentation(),
      viewedChildFolder: () => {
        const current = viewer.read()
        assert.ok(current !== undefined, 'the routing source reads the CURRENT viewer folder')
        return current.folder
      },
      viewedChildAgent: () => viewer.viewedChildAgent(),
      visualEventSnapshot: subject => provider(subject),
    },
  )
  try {
    await harness.repaint()
    const childFrame = harness.vt.getViewport().join('\n')
    const inline = childFrame.indexOf('Child viewer chart', childFrame.indexOf('Child before.'))
    assert.ok(inline > childFrame.indexOf('Child before.') && inline < childFrame.indexOf('Child after.'),
      `the viewer-owned folder paints the child's inline visual:\n${childFrame}`)

    // Exit the viewer: the main surface must not retain the child visual.
    assert.equal(viewer.exitView(), true)
    await harness.repaint()
    const mainFrame = harness.vt.getViewport().join('\n')
    assert.equal(mainFrame.indexOf('Child viewer chart'), -1, `the child visual does not survive viewer exit:\n${mainFrame}`)

    // Re-enter the SAME viewer: enterView mints a NEW TranscriptFolder, so the
    // routing source must follow viewer.read() dynamically; a stale folder
    // reference would make this assertion pass against the old projection.
    await viewer.enterView(child.sessionId, 'child', 'one-shot', parent.sessionId, 'inactive')
    const reenteredRead = viewer.read()
    assert.ok(reenteredRead !== undefined)
    assert.notEqual(reenteredRead.folder, read.folder, 're-entering a viewer owns a new folder instance')
    await harness.repaint()
    const reentered = harness.vt.getViewport().join('\n')
    assert.ok(reentered.includes('Child viewer chart'), `re-entering re-derives the child visual from the new folder:\n${reentered}`)
  } finally {
    harness.dispose()
    viewer.dispose()
  }
})

test('the bootstrap visual snapshot provider is wired to the production selector', () => {
  const bootstrap = readFileSync(new URL('../../src/app/bootstrap.ts', import.meta.url), 'utf8')
  assert.match(bootstrap, /createVisualEventSnapshotProvider\(/)
  assert.match(bootstrap, /isRemote: \(\) => remoteSources !== undefined/)
  assert.match(bootstrap, /mainAgent: \(\) => agentNow\(\)/)
  assert.match(bootstrap, /viewedChildAgent: \(\) => viewerRef\?\.viewedChildAgent\(\)/)
  const helper = readFileSync(new URL('../../src/app/bootstrap/visual-snapshot.ts', import.meta.url), 'utf8')
  assert.match(helper, /if \(options\.isRemote\(\)\) return undefined/)
  assert.match(helper, /subject\.subjectId !== undefined && session\.id !== subject\.subjectId/)
  assert.match(helper, /asVisualSessionEvents\(session\.snapshotEvents\(\)\)/)
})
