/**
 * PR3 end-to-end: a REAL official DSH Session/AgentLoop composes the published
 * visuals through the REAL `SurfaceRuntime` into the REAL mounted TSP renderer
 * and the official SDK surface.
 *
 * The chain under test:
 *
 *     real AgentLoop + ToolRuntime (real `dsh_pi_tui_chart`,
 *     `dsh_pi_tui_svg`, `present_visual` tools)
 *       -> committed official Session events
 *       -> real `TranscriptFolder` + `SurfaceRuntime.repaintTarget`
 *       -> PR1 `collectPublishedVisuals` / PR2 `assistantVisualPresentation`
 *       -> the REAL TSP renderer's display seam
 *       -> PR2 `planVisualPlacement` -> the official SDK `Surface.render`
 *       -> the scripted pane's wire (frames, blobs) and the real input events
 *
 * PRODUCTION PREREQUISITES REPRODUCED: the real Host tool registry/tool bodies,
 * the real Session log, the real fold/window/currentness chain, the real TSP
 * renderer and the shipped SDK surface.
 *
 * TEST STAND-INS / DELIBERATELY ABSENT: the MODEL is a scripted streaming LLM
 * adapter; the TERN CLIENT is a scripted tty (not a physical pane); the
 * CLIENT-LOCAL clipboard is a recorder stand-in for `ClientActions` (that
 * adapter is qualified by its own suites). No Remote path, no physical GUI.
 * @module @xmoon76/dsh-pi-tui/integration/tern-tsp-visual-assistant.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ToolCallId, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import { connect as sdkConnect } from '@stencil-hq/tern'
import type { Op, TermInput, TermOutput } from '@stencil-hq/tern'
import { apply as applyVisualTools } from '../../src/app/host/visual-tools.ts'
import {
  createSurfaceRuntime,
  type SurfaceEventRoutingSource,
  type SurfaceRendererMount,
} from '../../src/app/surface/runtime.ts'
import { asVisualSessionEvents, collectPublishedVisuals } from '../../src/domain/visual/publication.ts'
import type { VisualEventSnapshot } from '../../src/domain/visual/presentation.ts'
import { TranscriptFolder, type TranscriptMessage } from '../../src/transcript.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { CHART_TOOL_NAME, PRESENT_VISUAL_TOOL_NAME, SVG_TOOL_NAME } from '../../src/domain/visual/tools.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

const CHART = {
  kind: 'bars',
  title: 'Request latency',
  unit: 'ms',
  series: [{ label: 'p50', value: 42 }, { label: 'p99', value: 71 }],
}

const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 32">'
  + '<rect width="64" height="32" fill="#3b82f6"/>'
  + '<text x="4" y="20" font-size="12" fill="#ffffff">Gateway</text></svg>'
const SVG = { title: 'Service topology', description: 'Gateway -> App -> Database', svg: SVG_SOURCE }

// ── The scripted Tern pane ──────────────────────────────────────────────────

class FakeInput extends EventEmitter implements TermInput {
  readonly isTTY = true
  isRaw = false
  setRawMode(mode: boolean): void {
    this.isRaw = mode
  }
  type(text: string): void {
    this.emit('data', ENCODER.encode(text))
  }
}

class FakeOutput implements TermOutput {
  readonly isTTY = true
  readonly columns = 120
  readonly chunks: Uint8Array[] = []
  onWrite: ((bytes: Uint8Array) => void) | undefined
  write(data: Uint8Array | string): boolean {
    const bytes = typeof data === 'string' ? ENCODER.encode(data) : data
    this.chunks.push(bytes)
    this.onWrite?.(bytes)
    return true
  }
}

const HELLO = {
  r: 'hello',
  v: 1,
  term: 'tern',
  ver: '0.9.5',
  kinds: ['col', 'row', 'card', 'section', 'md', 'code', 'badge', 'tool', 'text', 'image', 'chart'],
  features: ['flow', 'styles', 'blobs'],
  apc: 65536,
  credits: 4,
  cols: 120,
  cell: { w: 8, h: 17 },
  dark: true,
  reduceMotion: false,
  hour12: false,
}

interface WireFrame {
  readonly sf: string
  readonly s: number
  readonly ops: readonly Op[]
}

class ScriptedTern {
  readonly input = new FakeInput()
  readonly output = new FakeOutput()
  readonly frames: WireFrame[] = []
  readonly blobs: { id: string; mime: string | undefined }[] = []

  constructor() {
    this.output.onWrite = bytes => {
      const text = DECODER.decode(bytes)
      if (text.includes('\u001b[c')) {
        setTimeout(() => this.input.type(`\u001b_tsp;r;${JSON.stringify(HELLO)}\u001b\\\u001b[?62;52;c`), 1)
        return
      }
      for (const match of text.matchAll(/\u001b_tsp;b;id=([0-9a-f]+);(?:mime=([^;]+);)?/g)) {
        this.blobs.push({ id: match[1] as string, mime: match[2] })
      }
      for (const match of text.matchAll(/\u001b_tsp;f;([\s\S]*?)\u001b\\/g)) {
        const frame = JSON.parse(match[1] as string) as WireFrame
        this.frames.push(frame)
        setTimeout(() => this.input.type(
          `\u001b_tsp;e;${JSON.stringify({ ev: 'ack', sf: frame.sf, s: frame.s })}\u001b\\`,
        ), 0)
      }
    }
  }

  event(value: unknown): void {
    this.input.type(`\u001b_tsp;e;${JSON.stringify(value)}\u001b\\`)
  }

  key(sequence: string): void {
    this.input.type(sequence)
  }

  surfaceId(): string {
    const frame = this.frames[0]
    assert.ok(frame !== undefined, 'the mounted renderer drew at least one frame')
    return frame.sf
  }
}

interface LiveNode {
  readonly id: string
  readonly kind: string
  readonly props: Record<string, unknown>
  readonly children: LiveNode[]
}

function currentNodes(tern: ScriptedTern): LiveNode[] {
  const live = new Map<string, LiveNode>()
  const insert = (node: { id?: string; k?: string; p?: Record<string, unknown>; c?: readonly unknown[] }, parentId: string | undefined): void => {
    if (typeof node.id !== 'string') return
    const entry: LiveNode = { id: node.id, kind: node.k ?? '', props: { ...(node.p ?? {}) }, children: [] }
    live.set(node.id, entry)
    if (parentId !== undefined) live.get(parentId)?.children.push(entry)
    for (const child of node.c ?? []) insert(child as never, node.id)
  }
  const remove = (id: string): void => {
    const node = live.get(id)
    if (node === undefined) return
    for (const child of [...node.children]) remove(child.id)
    live.delete(id)
  }
  for (const frame of tern.frames) {
    for (const op of frame.ops) {
      if (op[0] === 'add') insert(op[4] as never, op[2] as string | undefined)
      else if (op[0] === 'set') {
        const node = live.get(op[1] as string)
        if (node !== undefined) Object.assign(node.props, op[2] as Record<string, unknown>)
      } else if (op[0] === 'text') {
        const node = live.get(op[1] as string)
        if (node === undefined) continue
        node.props.text = op[2] === 'append'
          ? `${String(node.props.text ?? '')}${String(op[3])}`
          : String(op[3])
      } else if (op[0] === 'del') remove(op[1] as string)
    }
  }
  return [...live.values()]
}

function nodesWhere(tern: ScriptedTern, predicate: (node: LiveNode) => boolean): LiveNode[] {
  return currentNodes(tern).filter(predicate)
}

function figureIds(tern: ScriptedTern): string[] {
  return nodesWhere(tern, node => node.kind === 'col' && node.props['role'] === 'dsh.visual.figure').map(node => node.id)
}

function copyButtonIds(tern: ScriptedTern): string[] {
  return nodesWhere(tern, node => node.kind === 'el' && node.props['role'] === 'dsh.visual.copy').map(node => node.id)
}

function textNodes(tern: ScriptedTern): string[] {
  return nodesWhere(tern, node => node.kind === 'text' && typeof node.props['text'] === 'string')
    .map(node => String(node.props['text']))
}

function badgeTexts(tern: ScriptedTern): string[] {
  return nodesWhere(tern, node => node.kind === 'badge' && typeof node.props['text'] === 'string')
    .map(node => String(node.props['text']))
}

function mdTexts(tern: ScriptedTern): string[] {
  return nodesWhere(tern, node => node.kind === 'md' && typeof node.props['text'] === 'string')
    .map(node => String(node.props['text']))
}

/** The kinds inside the Assistant figure wrappers only (never a Tool card). */
function figureDescendantKinds(tern: ScriptedTern, kind: string): LiveNode[] {
  const out: LiveNode[] = []
  const walk = (node: LiveNode): void => {
    if (node.kind === kind) out.push(node)
    for (const child of node.children) walk(child)
  }
  for (const figure of nodesWhere(tern, node => node.kind === 'col' && node.props['role'] === 'dsh.visual.figure')) walk(figure)
  return out
}

async function until(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${label}`)
}

// ── The real Session fixture ────────────────────────────────────────────────

interface ScriptedCall {
  readonly callId: string
  readonly name: string
  readonly args: unknown
}

type StepPlan =
  | { readonly calls: readonly ScriptedCall[] | ((prompt: string) => readonly ScriptedCall[]) }
  | { readonly text: string | ((prompt: string) => string) }

class ScriptedAdapter extends LlmAdapter {
  readonly prompts: string[] = []
  plans: StepPlan[] = []

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }
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
  readonly adapter: ScriptedAdapter
  readonly session: {
    readonly id: string
    readonly seq: number
    snapshotEvents(): readonly SessionEvent[]
  }
  run(steps: readonly StepPlan[]): Promise<void>
}

async function bootRealSession(life: TestLifecycle, label: string): Promise<RealSession> {
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, {})
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
  applyVisualTools(ctx, { enabled: { get: () => true } } as never)
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
    adapter,
    session: agent.session,
    async run(steps: readonly StepPlan[]): Promise<void> {
      adapter.plans = [...steps]
      adapter.prompts.length = 0
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
  }
}

// ── The real SurfaceRuntime over the TSP renderer ───────────────────────────

interface TspSurfaceHarness {
  readonly surface: ReturnType<typeof createSurfaceRuntime<SessionEvent>>
  readonly renderer: TspRenderer
  readonly tern: ScriptedTern
  readonly copies: string[]
  readonly fatalErrors: unknown[]
  repaint(): void
  dispose(): Promise<void>
}

async function mountTspSurface(session: RealSession, folder: TranscriptFolder): Promise<TspSurfaceHarness> {
  const tern = new ScriptedTern()
  const copies: string[] = []
  const fatalErrors: unknown[] = []
  const sdkSession = await sdkConnect({ env: {}, input: tern.input, output: tern.output, exitHooks: false, timeout: 500 })
  assert.ok(sdkSession !== null, 'the scripted pane is accepted by the shipped SDK')
  const renderer = mountTspRenderer(sdkSession, {
    requestExit: () => {},
    onFatal: (error) => { fatalErrors.push(error) },
    logError: () => {},
    copyVisual: async (text) => {
      copies.push(text)
      return true
    },
  })
  const rendererMount: SurfaceRendererMount = {
    mount: () => ({
      display: renderer.display,
      taskPresentation: renderer.taskPresentation,
      composer: renderer.composer,
      modelPresentation: renderer.modelPresentation,
      presetPresentation: renderer.presetPresentation,
      sessionBrowserPresentation: renderer.sessionBrowserPresentation,
      interaction: renderer.interaction,
      bindInput: handlers => renderer.bindInput(handlers),
      dispose: () => renderer.dispose(),
    }),
    releaseUnmounted: () => renderer.dispose(),
  }
  const controller = new TranscriptWindowController({ windowTurns: 20, stepTurns: 10 })
  const stats = { apply: () => {} }
  const previews = new Map()
  const presentation = {
    folder: { apply: (events: readonly SessionEvent[]) => folder.apply(events) },
    stats,
    window: controller,
    previews,
    applyToolPreview: () => {},
    refreshRecentPerformanceAvailability: () => {},
  }
  const source: SurfaceEventRoutingSource<SessionEvent> = {
    isCleanedUp: () => false,
    isAttachedSession: candidate => candidate.id === session.sessionId,
    currentSessionId: () => session.sessionId,
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => presentation,
    viewedChildId: () => undefined,
    viewedChild: () => undefined,
    mainFolder: () => folder,
    viewedChildFolder: () => undefined,
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
    exitView: () => {},
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
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: () => {},
    applyMainAssistantInput: () => {},
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
    visualEventSnapshotFor: (): VisualEventSnapshot => ({
      session: session.session,
      sessionId: session.sessionId,
      seq: session.session.seq,
      events: asVisualSessionEvents(session.session.snapshotEvents()),
    }),
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
    captureHistoryScope: () => ({ sessionId: session.sessionId, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
    renderer: rendererMount,
  })
  surface.bindRendererInput()
  return {
    surface,
    renderer,
    tern,
    copies,
    fatalErrors,
    repaint: () => { controller.setTurns(folder.groupedTurns()); surface.repaint() },
    dispose: async () => {
      surface.dispose()
      await surface.whenRendererReleased()
    },
  }
}

function replayEvents(harness: TspSurfaceHarness, folder: TranscriptFolder, events: readonly SessionEvent[]): void {
  for (const event of events) {
    folder.apply([event])
    harness.repaint()
  }
}

// ── The answer plans ────────────────────────────────────────────────────────

function markerAnswer(before: string, after: string): (prompt: string) => string {
  return prompt => {
    const refs = refsInPrompt(prompt)
    assert.ok(refs.length >= 1, 'the model received the visual reference')
    return `${before}\n\n${refs.map(ref => marker(ref)).join('\n\n')}\n\n${after}`
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

test('a real chart publication reaches the mounted TSP surface and its Copy control copies the final fact', async (t) => {
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
    { text: markerAnswer('Before figure.\n\n', '\n\nAfter figure.') },
  ])

  const folder = new TranscriptFolder()
  const harness = await mountTspSurface(session, folder)
  try {
    replayEvents(harness, folder, session.session.snapshotEvents())
    await until('the published chart figure', () => figureIds(harness.tern).length === 1)

    const buttons = copyButtonIds(harness.tern)
    assert.equal(buttons.length, 1, 'the figure painted exactly one Copy control')
    harness.tern.event({
      ev: 'action',
      sf: harness.tern.surfaceId(),
      id: buttons[0] as string,
      act: 'dsh-visual-copy',
    })
    await until('the clipboard write', () => harness.copies.length === 1)
    const payload = JSON.parse(harness.copies[0] as string) as unknown
    assert.deepEqual(payload, {
      version: 1,
      type: 'chart',
      ...CHART,
    })
    await until('the success notice', () => textNodes(harness.tern).includes('Copied chart data'))
    // The tool card is still present beside the Assistant figure.
    assert.equal(nodesWhere(harness.tern, node => node.kind === 'tool').length > 0, true)
    assert.equal(harness.fatalErrors.length, 0)
  } finally {
    await harness.dispose()
  }
})

test('a real chart and SVG publication compose in place with one content-addressed SVG blob', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'both')
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
    { text: markerAnswer('Latency:\n\n', '\n\nDone.') },
  ])

  const folder = new TranscriptFolder()
  const harness = await mountTspSurface(session, folder)
  try {
    replayEvents(harness, folder, session.session.snapshotEvents())
    await until('the two figures', () => figureIds(harness.tern).length === 2)
    assert.equal(figureDescendantKinds(harness.tern, 'chart').length, 1,
      'the chart figure paints one native chart')
    assert.equal(figureDescendantKinds(harness.tern, 'image').length, 1,
      'the SVG figure paints one native image')
    assert.equal(harness.tern.blobs.length, 1, 'one content-addressed SVG blob is sent')
    assert.equal(harness.tern.blobs[0]?.mime, 'image/svg+xml')

    // Alt+V selects the chart, Alt+C copies it through the same admission.
    harness.tern.key('\u001bv')
    await until('the selection badge', () => badgeTexts(harness.tern).includes('Selected · 1/2'))
    harness.tern.key('\u001bc')
    await until('the chart copy', () => harness.copies.length === 1)
    assert.deepEqual(JSON.parse(harness.copies[0] as string), { version: 1, type: 'chart', ...CHART })
    harness.tern.key('\u001bv')
    await until('the SVG selection', () => badgeTexts(harness.tern).includes('Selected · 2/2'))
    harness.tern.key('\u001bc')
    await until('the SVG copy', () => harness.copies.length === 2)
    assert.equal(harness.copies[1], SVG_SOURCE, 'the raw admitted SVG source is copied verbatim')
    assert.equal(harness.fatalErrors.length, 0)
  } finally {
    await harness.dispose()
  }
})

test('a generated but never published chart stays only in the tool card', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'unpublished')
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    { text: 'The chart is in the tool card.' },
  ])

  const folder = new TranscriptFolder()
  const harness = await mountTspSurface(session, folder)
  try {
    replayEvents(harness, folder, session.session.snapshotEvents())
    await until('the tool card frame', () => nodesWhere(harness.tern, node => node.kind === 'tool').length > 0)
    assert.equal(figureIds(harness.tern).length, 0, 'the Assistant owns no unpublished figure')
    assert.equal(copyButtonIds(harness.tern).length, 0)
    assert.equal(harness.tern.blobs.length, 0)
    // The generating result's own Tool card body still carries the drawing fact.
    assert.equal(nodesWhere(harness.tern, node => node.kind === 'chart').length, 1,
      'the tool card keeps its own native chart')
    assert.equal(figureDescendantKinds(harness.tern, 'chart').length, 0)
  } finally {
    await harness.dispose()
  }
})

test('a refused present_visual never reaches the Assistant body', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'refused')
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    {
      calls: () => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: `sv1_${'f'.repeat(20)}` }] },
      }],
    },
    { text: 'No figure was published.' },
  ])

  const folder = new TranscriptFolder()
  const harness = await mountTspSurface(session, folder)
  try {
    replayEvents(harness, folder, session.session.snapshotEvents())
    await until('the final answer', () => mdTexts(harness.tern).some(text => text.includes('No figure was published.')))
    assert.equal(figureIds(harness.tern).length, 0)
    assert.equal(copyButtonIds(harness.tern).length, 0)
    assert.equal(harness.tern.blobs.length, 0)
  } finally {
    await harness.dispose()
  }
})

test('the published refs are the SAME ones the real PR1 authority derives from the committed log', async (t) => {
  const life = testLifecycle(t)
  const session = await bootRealSession(life, 'authority')
  await session.run([
    { calls: [{ callId: 'call-chart', name: CHART_TOOL_NAME, args: CHART }] },
    {
      calls: prompt => [{
        callId: 'call-present',
        name: PRESENT_VISUAL_TOOL_NAME,
        args: { visuals: [{ ref: refsInPrompt(prompt)[0] }] },
      }],
    },
    { text: markerAnswer('', '') },
  ])
  const published = collectPublishedVisuals(
    session.sessionId,
    asVisualSessionEvents(session.session.snapshotEvents()),
  )
  assert.equal(published.length, 1, 'the real log qualifies exactly one publication')
  assert.equal(published[0]?.source.chart?.title, CHART.title)

  const folder = new TranscriptFolder()
  const harness = await mountTspSurface(session, folder)
  try {
    replayEvents(harness, folder, session.session.snapshotEvents())
    await until('the authority figure', () => figureIds(harness.tern).length === 1)
    const figureKey = nodesWhere(harness.tern, node => node.kind === 'col' && node.props['role'] === 'dsh.visual.figure')[0]?.props['key']
    assert.equal(figureKey, `body-visual-${published[0]?.ref}`,
      'the painted figure carries the exact authority ref')
  } finally {
    await harness.dispose()
  }
})
