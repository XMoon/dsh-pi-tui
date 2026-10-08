/**
 * L5/L6 real-path proof (plan §6.4): the installed `@deepseek-ai/*@0.2.0-rc.2`
 * AgentLoop is run against a recording LLM adapter, and its REAL events are fed
 * through the REAL surface routing into the REAL terminal sink.
 *
 * This is deliberately not a fake-injection suite: the completion evidence the
 * terminal sees comes from actual `turn/start` / `turn/end(reason.kind)` and
 * `agent/status` emissions of the production loop, so the arrival order the
 * progress contract depends on (`turn/end` before the owning `agent/status
 * idle`) is asserted on the real source, not on a hand-built ordering.
 *
 * FIXTURE MANIFEST (plan §6.4 — which production prerequisites are real, which
 * are stand-ins, and which are intentionally absent):
 *
 * - REAL: the installed npm `@deepseek-ai/dsh-agent-loop` /
 *   `dsh-session` / `dsh-llm` / `dsh-tools` stack, the production
 *   `createSurfaceRuntime` + event routing + `TuiApp`, and the injected
 *   `VirtualTerminal` sink. The Agent/Session ids used by the routing fences
 *   are the REAL Agent/Session identities.
 * - STAND-IN: the `SurfaceEventRoutingSource` bundle is the minimal structural
 *   stand-in the surface contract requires — the transcript/stats/window
 *   targets and the Direct bookkeeping callbacks are no-ops, because none of
 *   them is on the terminal-progress evidence path (plan §4.3: the routing
 *   decision, the interval fold and the sink are the parts under test).
 * - NOT COVERED HERE: the official Client -> Gateway -> Host **Remote** wire.
 *   The Remote branch has no correlatable main `agent/status` input (the
 *   subscription is Direct-only), so this suite proves the Direct source ->
 *   routing -> fold -> sink chain only and makes NO Remote claim (plan §6.4
 *   STOP). Real GUI terminals (Ghostty/Tern) are likewise not covered here.
 * @module @xmoon76/dsh-pi-tui/terminal-progress-event-order.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createSurfaceRuntime } from '../src/app/surface/runtime.ts'
import type { SurfaceEventRoutingSource } from '../src/app/surface/event-routing.ts'
import type { TranscriptFolder } from '../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../src/domain/transcript/window.ts'
import { createPluginManagerPanel } from '../src/tui/plugin-manager/panel.ts'
import { installVirtualProcessTerminal } from './support/runner-harness.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

const MAIN = 'osc7501-event-order-main'
const IDLE = '\x1b]7501;state=idle:app=dsh-pi-tui\x1b\\'
const WORKING = '\x1b]7501;state=working:app=dsh-pi-tui\x1b\\'
const DONE = '\x1b]7501;state=done:app=dsh-pi-tui\x1b\\'
const ERROR = '\x1b]7501;state=error:app=dsh-pi-tui\x1b\\'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** Answers every request with one text response: the `completed` path. */
class CompletedAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(): AsyncIterable<StreamChunk> {
    for (const chunk of textResponse('ok')) yield chunk
  }
}

/** Fails the request with an official `LlmError`: the `error` path. */
class FailingAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(): AsyncIterable<StreamChunk> {
    throw new LlmError('probe failure', 'UNKNOWN')
  }
}

/** Blocks until the turn is cancelled: the `aborted` path. */
class AbortableAdapter extends LlmAdapter {
  readonly started: Promise<void>
  private signalStarted!: () => void
  constructor() {
    super()
    this.started = new Promise(resolve => { this.signalStarted = resolve })
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.signalStarted()
    await new Promise<never>((_resolve, reject) => {
      const signal = options.signal
      if (signal === undefined) {
        reject(new Error('the loop must pass an abort signal'))
        return
      }
      if (signal.aborted) {
        reject(signal.reason ?? new Error('aborted'))
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
    })
  }
}

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

interface Probe {
  readonly order: string[]
  readonly programWrites: string[]
  run(text: string): Promise<void>
  abortRun(text: string, adapter: AbortableAdapter): Promise<void>
  dispose(): void
}

/**
 * Mount the REAL rc.2 AgentLoop + the REAL surface routing over a recording
 * terminal, and subscribe the surface to the loop's OWN events (the same
 * delegation the production composition installs).
 */
async function createProbe(adapter: LlmAdapter): Promise<Probe> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['probe'], adapter)
  const agent = await ctx.agentLoop.create(SessionId(MAIN), { provider: 'probe', model: 'probe-model' })

  const vt = new VirtualTerminal(100, 30)
  const programWrites: string[] = []
  const passthroughWrite = vt.write.bind(vt)
  vt.write = (data: string) => {
    for (const match of data.matchAll(/\x1b\]7501;[^\x1b]*\x1b\\/g)) programWrites.push(match[0])
    passthroughWrite(data)
  }
  const restoreTerminal = installVirtualProcessTerminal(vt)

  const emptySink = { apply: () => {} }
  const emptyFolder = {
    apply: () => {},
    groupedTurns: () => [],
    turnActivities: () => [],
    searchRevision: () => 0,
    window: () => ({ messages: [], firstTurn: undefined, lastTurn: undefined, hasNewer: false }),
  } as unknown as TranscriptFolder
  const mainWindow = new TranscriptWindowController()
  const routingSource = {
    isCleanedUp: () => false,
    isAttachedSession: () => true,
    currentSessionId: () => MAIN,
    hasLiveAgent: () => true,
    completionOwnerId: () => agent.id,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => ({
      folder: emptyFolder, stats: emptySink, window: mainWindow, previews: new Map(),
      applyToolPreview: () => {}, refreshRecentPerformanceAvailability: () => {},
    }),
    viewedChildId: () => undefined,
    viewedChild: () => { throw new Error('no viewed child in this probe') },
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

  const surface = createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    terminalProgress: undefined,
    mainProgressAuthority: 'local-events',
    createPluginManagerPanel,
  })
  surface.attachEventRouting(routingSource)
  surface.setCompletionOwner(agent.id)
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised by this test')) },
    readImage: () => Promise.reject(new Error('not exercised by this test')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    sessionId: () => MAIN,
    onTerminalResize: () => {},
    copySelection: async () => false,
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: (text) => text,
  })

  // The production delegation, installed AFTER the mount exactly as the
  // composition root does: the surface consumes the loop's own events.
  const order: string[] = []
  ctx.on('session/event', (session, event) => {
    assert.equal(session.id, MAIN, 'every routed session event belongs to the main session')
    if (event.type === 'turn/start') order.push('turn/start')
    else if (event.type === 'turn/end') order.push(`turn/end:${(event.data as { reason: { kind: string } }).reason.kind}`)
    surface.routeSessionEvent(session, event)
  })
  ctx.on('agent/status', ({ agent: subject, status }) => {
    assert.equal(subject.id, agent.id, 'every routed status belongs to the live Agent')
    order.push(`status:${status}`)
    surface.routeAgentStatus(subject.id, status)
  })

  let disposed = false
  return {
    order,
    programWrites,
    run: async (text) => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      await agent.whenIdle()
    },
    abortRun: async (text, abortable) => {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      const idle = agent.whenIdle()
      await abortable.started
      agent.cancel({ kind: 'user' })
      await idle
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      surface.dispose()
      restoreTerminal()
    },
  }
}

/** Flush the routing microtasks/scheduled repaints. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

test('rc.2 completed: turn/end arrives before the owning agent/status idle and settles done', async () => {
  const probe = await createProbe(new CompletedAdapter())
  try {
    await settle()
    assert.deepEqual(probe.programWrites, [IDLE], 'the mount asserts idle')
    await probe.run('finish this turn')
    await settle()
    const order = probe.order
    const start = order.indexOf('turn/start')
    const end = order.indexOf('turn/end:completed')
    const idle = order.indexOf('status:idle')
    assert.ok(start >= 0, `the real turn/start was observed: ${order.join(', ')}`)
    assert.ok(end > start, 'turn/end arrives after its turn/start')
    assert.ok(idle > end, 'the owning agent/status idle arrives AFTER turn/end (the settle fence holds)')
    assert.deepEqual(probe.programWrites, [IDLE, WORKING, DONE],
      'the real loop settles OSC 7501 done exactly once')
  } finally {
    probe.dispose()
  }
})

test('rc.2 error: a failing request settles error, never done', async () => {
  const probe = await createProbe(new FailingAdapter())
  try {
    await settle()
    await probe.run('fail this turn')
    await settle()
    const order = probe.order
    const start = order.indexOf('turn/start')
    const end = order.indexOf('turn/end:error')
    const idle = order.indexOf('status:idle')
    assert.ok(start >= 0 && end > start, `the error turn/end follows its start: ${order.join(', ')}`)
    assert.ok(idle > end, 'the idle status arrives after the error turn/end')
    assert.deepEqual(probe.programWrites, [IDLE, WORKING, ERROR])
  } finally {
    probe.dispose()
  }
})

test('rc.2 aborted: a cancelled turn settles idle, never a fabricated completion', async () => {
  const adapter = new AbortableAdapter()
  const probe = await createProbe(adapter)
  try {
    await settle()
    await probe.abortRun('cancel this turn', adapter)
    await settle()
    const order = probe.order
    const start = order.indexOf('turn/start')
    const end = order.indexOf('turn/end:aborted')
    const idle = order.indexOf('status:idle')
    assert.ok(start >= 0 && end > start, `the aborted turn/end follows its start: ${order.join(', ')}`)
    assert.ok(idle > end, 'the idle status arrives after the aborted turn/end')
    assert.deepEqual(probe.programWrites, [IDLE, WORKING, IDLE],
      'an aborted turn is honestly idle — not done')
  } finally {
    probe.dispose()
  }
})
