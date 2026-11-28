/**
 * M3-4 PR2 L6 Remote main-Session read/presentation qualification: the REAL
 * runner (`applyRunnerWithRuntime` with a pre-selected Remote aggregate)
 * over a REAL rc.2 Host Context → the official in-process carrier → a real
 * official Client → the real Remote application runtime — the same-Host
 * composition the M3-3A smoke proves, now driving the TUI surface.
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - the real rc.2 Host services (the shared `remote-application-fixture`:
 *   persistence, storage, credentials, jobs + controller, gateway, loader,
 *   presets, userQuestions, workspace, filesystem, agent loop) plus the
 *   official projection rows the status/presentation reads consume
 *   (TokenMeter, tool-todo — the same rows the M3-3A smoke mounts)
 * - the official Client/Gateway path over the real in-process carrier
 * - the REAL runner composition root (`app/bootstrap.ts`) through the
 *   production selection seam (a pre-selected aggregate — the seam's
 *   `preselected` input), consuming the same presentation-source bundle
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - prompt serializer: the DEFAULT is an unsupported test double (the cases that
 *   only read echoes never serialize); the cases that submit a REAL Remote
 *   prompt (the writer-held PR5 cases, the pending handoff case and the
 *   request-zone L5 case) pass `productionSerializer: true` and therefore run
 *   the PRODUCTION Remote submission serializer, the real official
 *   `SessionFace.prompt()` and the real Host Session Controller
 * - `StubStreamingLlmAdapter`: a scripted real `LlmAdapter` whose `stream`
 *   yields one real text turn — the Host emits REAL `agent/assistant-stream`
 *   frames, the wire forwards them, and the Client eventSource produces REAL
 *   transient entries; the adapter is the LLM endpoint stand-in only
 * - the request-zone L5 case controls ONLY the Client runtime's reported zone:
 *   a no-argument `Intl.DateTimeFormat` construction reports the Client zone
 *   while the Host process zone and every explicit-`timeZone` construction stay
 *   real (the Host side never sees a stand-in)
 * - hand-provided `agentDefaultModel`/`attachments`/`webServer`: the minimal
 *   readiness inputs (identical to the shared fixture manifest)
 *
 * DELIBERATELY ABSENT
 * - a separate Host PROCESS/timezone and a real network transport: the official
 *   in-process carrier is this product's Remote path today, so the Host and the
 *   Client share one process; the Client-vs-Host zone control is therefore
 *   forged at the Client's `Intl` source (above), never by moving the Host
 * - a real single-tty terminal / Tern GUI: the painted result is read from the
 *   `VirtualTerminal`
 * - command catalog refresh / tool cards / permission cycle / rewind
 *   (the M3-4 command PR's ownership)
 * - secondary surfaces (Task Center rows, subagent viewer, Plugin Manager —
 *   M3-5)
 *
 * USER-REACHABLE SURFACES EXERCISED: transcript cold history + live
 * assistant output, footer/status facts (model/preset/cwd/todos/context),
 * pending-input presentation join, history paging (loadOlder), session
 * switch, teardown.
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-presentation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as toolTodo from '@deepseek-ai/dsh-tool-todo'
import { Config as TuiConfigSchema } from '../../src/index.ts'
import { createInputMemoryRecall } from '../../src/client/history/memory-recall.ts'
import { bundleVersion } from '../../src/client/launcher/version.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../../src/app/bootstrap.ts'
import type { LaunchWorkspaceVerdict } from '../../src/app/remote-process/local-workspace-equivalence.ts'
import { statSync } from 'node:fs'
import type { ClientReloadRequestResult, RemoteApplicationOverride, RunnerStartupSettlement } from '../../src/app/application-runtime.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import { createRemoteApplicationRuntime } from '../support/m3-inprocess/application-runtime.ts'
import { testPromptSerializer, waitFor } from '../support/remote-application-fixture.ts'
import { appendHistoryRecord, historyFilePath, loadHistoryRecords } from '../../src/client/history/store.ts'
import { FileHistorySearchSource } from '../../src/client/history/search.ts'
import { dshHome } from '../../src/runtime/process/diagnostics.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/** One scripted provider turn: a single text block with a finish. */
function* scriptedTextTurn(text: string): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** The LLM endpoint stand-in: a real adapter whose stream yields real text.
 *  `hold()` keeps the turn OPEN (the Host agent stays `running`) until the
 *  returned release runs — the busy/queued/steering evidence needs a running
 *  session. */
class StubStreamingLlmAdapter extends LlmAdapter {
  private gate: Promise<void> | undefined
  private openGate: (() => void) | undefined
  private heldSessionId: string | undefined
  private heldStreams = 0

  /** How many model requests actually ENTERED the held gate (a witness that a
   *  test asserting a held step is not merely observing `step/start`, which the
   *  Agent can append before the model request is issued). */
  get heldStreamCount(): number {
    return this.heldStreams
  }

  /** Hold every subsequent turn open, or only one exact Session when named. */
  hold(sessionId?: string): () => void {
    this.gate = new Promise<void>(resolve => { this.openGate = resolve })
    this.heldSessionId = sessionId
    return () => {
      const open = this.openGate
      this.gate = undefined
      this.openGate = undefined
      this.heldSessionId = undefined
      open?.()
    }
  }

  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    // The model CONTRACT is the shared fixture's: the Host default selection
    // is `smoke/smoke` (agentDefaultModel below), so the streaming catalog
    // must expose `smoke` — a divergent id here surfaces as a first-turn
    // model resolution failure, not a completion list. The SECOND row
    // (`smoke-alt`) exists for the PR5 picker tests: a directory model whose
    // name never matches the `current` badge text, so a marker assertion
    // cannot pass on the model name alone.
    return Promise.resolve([
      { provider, id: 'smoke', name: 'Smoke Model' },
      { provider, id: 'smoke-alt', name: 'Alt Model' },
    ])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    // HOLD before the FIRST frame: the Host turn stays OPEN (the agent
    // officially `running`) with no output until the test releases it — a
    // hold after `block-end` would already have let the runtime settle the
    // step. The held gate honors the CALLER's cancellation (the production
    // LLM contract): an aborted request wakes with the abort reason instead
    // of parking the Host teardown's whenIdle() forever.
    const gate = this.gate
    if (gate !== undefined && (this.heldSessionId === undefined || String(options.sessionId) === this.heldSessionId)) {
      this.heldStreams += 1
      const signal = options.signal
      if (signal === undefined) {
        await gate
      } else {
        await new Promise<void>((resolve, reject) => {
          const onAbort = (): void => {
            cleanup()
            reject(signal.reason instanceof Error ? signal.reason : new Error('LLM stream aborted'))
          }
          const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
          signal.addEventListener('abort', onAbort, { once: true })
          gate.then(() => { cleanup(); resolve() }, error => { cleanup(); reject(error) })
        })
      }
    }
    options.signal?.throwIfAborted()
    yield* scriptedTextTurn('remote reply')
  }
}

interface RemoteRunnerFixture {
  host: Awaited<ReturnType<typeof mountRemotePresentationHost>>
  runnerFiber: Fiber
  vt: VirtualTerminal
  pane?: TspPane
  runnerApp(): unknown
  override: RemoteApplicationOverride
  aggregate: Awaited<ReturnType<typeof createRemoteApplicationRuntime>>
  dispose(): Promise<void>
}

/** The Host fixture: the shared rc.2 base plus the projection rows PR2 reads. */
export async function mountRemotePresentationHost(
  life: TestLifecycle,
  presetId: string,
  options: { readonly llmAdapter?: LlmAdapter; readonly pluginManagerProfile?: boolean } = {},
) {
  const { createRemoteApplicationHostFixture } = await import('../support/remote-application-fixture.ts')
  // The streaming stand-in rides the shared fixture's `smoke` route; the
  // official projection rows (TokenMeter/tool-todo) mount after the base.
  const base = await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: options.llmAdapter ?? new StubStreamingLlmAdapter(),
    ...(options.pluginManagerProfile === true ? { pluginManagerProfile: true } : {}),
  })
  await base.ctx.plugin(TokenMeter)
  await base.ctx.plugin(toolTodo, { allowParallelInProgress: false })
  // The `title` and `goal` projection units: the CURRENT-VALUE facts a bounded
  // window cannot own (their source events may precede the window), so the L6
  // fixture mounts the official rows that produce them.
  const title = await import('@deepseek-ai/dsh-session-title')
  await base.ctx.plugin(title.default as never, {
    fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80,
  } as never)
  const goalUnit = await import('@deepseek-ai/dsh-goal')
  await base.ctx.plugin(goalUnit.default as never, { defaultMaxGoalRounds: 5 } as never)
  // PR4 §4/§3: the whole-log turnOutline + sessionStats projection rows —
  // the Remote /rewind picker and /status lifetime authorities. The same
  // official rows the production base patch mounts.
  const turnOutline = await import('@deepseek-ai/dsh-session-turn-outline')
  await base.ctx.plugin(turnOutline)
  const sessionStats = await import('@deepseek-ai/dsh-session-stats')
  await base.ctx.plugin(sessionStats)
  return base
}

/**
 * Mount the REAL runner with a pre-selected Remote aggregate over the real
 * Host. The runner consumes only the aggregate's selected core + the
 * presentation-source bundle — no Direct graph is ever constructed.
 */
/** An in-process VERIFIED launch proof for composition tests. The REAL
 * classifier's evidence is validated by its own unit contract and the packed
 * OS lane; this fixture only needs a legal sessionless Workspace target. */
function launchProof(cwd: string): LaunchWorkspaceVerdict {
  const evidence = statSync(cwd, { bigint: true })
  return {
    kind: 'verified',
    launchCwd: cwd,
    instanceId: 'in-process-fixture-host',
    hostPid: process.pid,
    device: evidence.dev.toString(),
    inode: evidence.ino.toString(),
    revalidate: async () => true,
  }
}

export async function mountRemoteRunner(
  life: TestLifecycle,
  options: {
    presetId?: string
    resumeSessionId?: string
    cwd?: string
    /** A pre-seeded host fixture (the resume tests seed BEFORE the aggregate). */
    host?: Awaited<ReturnType<typeof mountRemotePresentationHost>>
    /** A test-provided LLM endpoint (e.g. one that can hold a turn open). */
    llmAdapter?: LlmAdapter
    /** Use the PRODUCTION prompt serializer (a live turn must actually
     *  submit — the default test stand-in refuses serialization). */
    productionSerializer?: boolean
    /** PR5 §3.5: the launch `--preset` the startup service carries beside
     *  `--session` (the resume launch-preset apply path). */
    launchPresetId?: string
    /** Extra preset ids registered on the Host roster (PR5 §3.5 needs a
     *  second selectable preset). */
    extraPresetIds?: readonly string[]
    /** Invoked with the Remote presentation bundle BEFORE the runner fiber
     *  mounts: a suite that must hold the startup hydration wraps the
     *  presentation reader here (the runner reads it lazily at call time). */
    beforeRunnerMount?: (
      presentation: RemoteApplicationOverride['presentation'],
      aggregate: Awaited<ReturnType<typeof createRemoteApplicationRuntime>>,
    ) => void
    /** Mount the production TSP renderer over the scripted pane instead of PiTui. */
    renderer?: 'pi-tui' | 'tsp'
    /** Advertise the TSP Session Browser presenter (for /sessions and /resume). */
    sessionBrowser?: boolean
    /** Advertise native image + blobs when the TSP renderer is selected. */
    nativeImages?: boolean
    /** Advertise the native chart kind when the TSP renderer is selected. */
    nativeChart?: boolean
    /** M4 PR4: the split Client's internal process startup settlement (the
     *  ONE process-owned manual-reload capability). Absent keeps the Direct
     *  pending behavior. */
    startupSettlement?: RunnerStartupSettlement
    /** M6 compatible-cross-build UX: the process-local daemon administration
     *  port. A pure connection notice must never call it; a counting fake can
     *  witness that. */
    profileDaemonAdmin?: RemoteApplicationOverride['profileDaemonAdmin']
    /** PR2: the public CLI Session launch intent carried by `tuiStartup`. */
    sessionLaunch?: { readonly kind: 'lookup' | 'browse' | 'continue'; readonly query?: string }
    /** Mount the official profile/credentials prerequisite (Owner peer). */
    readonly hostPluginManagerProfile?: boolean
  } = {},
): Promise<RemoteRunnerFixture> {
  const presetId = options.presetId ?? 'm3-4-pr2-preset'
  const host = options.host ?? await mountRemotePresentationHost(life, presetId, {
    ...options.llmAdapter === undefined ? {} : { llmAdapter: options.llmAdapter },
    ...(options.hostPluginManagerProfile === true ? { pluginManagerProfile: true } : {}),
  })
  for (const extra of options.extraPresetIds ?? []) {
    await host.ctx.get('agentPresets')!.register({ id: extra, name: `preset ${extra}`, plugins: [] })
  }
  const cwd = options.cwd ?? host.anchorDir
  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    ...(options.productionSerializer === true ? {} : { promptSerializer: testPromptSerializer }),
    // The runner receives the same startup facts (M3-6 PR1): the exact
    // `--session`/`--preset` copy the Host runner tuiStartup carries.
    clientUiStartup: {
      ...(options.resumeSessionId === undefined ? {} : { sessionId: options.resumeSessionId }),
      ...(options.launchPresetId === undefined ? {} : { presetId: options.launchPresetId }),
    },
  })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))
  if (options.sessionLaunch !== undefined) {
    // The split Client process mounts and awaits its official Client domains
    // BEFORE the runner starts; this in-process fixture creates the aggregate
    // asynchronously, so wait for the SAME official Client session-list baseline
    // before handing the runner the CLI launch intent. This is fixture setup,
    // not a second read: the adapter's own `list()` below still performs the
    // one production read under the runner's lifecycle signal.
    const deadline = Date.now() + 20_000
    for (;;) {
      const rows = await aggregate.selected.backend.sessionReader.list(undefined)
      if (rows !== undefined) break
      if (Date.now() > deadline) throw new Error('timed out waiting for the official Client session-list baseline')
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    }
  }

  const vt = new VirtualTerminal(100, 30)
  let pane: TspPane | undefined
  const previousRenderer = process.env.DSH_PI_TUI_RENDERER
  life.defer(() => {
    if (previousRenderer === undefined) delete process.env.DSH_PI_TUI_RENDERER
    else process.env.DSH_PI_TUI_RENDERER = previousRenderer
  })
  if (options.renderer === 'tsp') {
    pane = installTspPane({
      nativeImages: options.nativeImages,
      nativeChart: options.nativeChart,
      sessionBrowser: options.sessionBrowser,
    })
    life.defer(() => pane?.restore())
    process.env.DSH_PI_TUI_RENDERER = 'tsp'
  } else {
    const restoreTerminal = await import('../support/runner-harness.ts').then(m => m.installVirtualProcessTerminal(vt))
    life.defer(restoreTerminal)
  }

  // The runner mounts on the SAME Host Context (the production shape: the
  // TUI is a Host plugin row; the Remote graph composes beside it in this
  // same process). A separate Context would starve the runner of the Host
  // services its startup consumes (agents/sessions/commands/loader).
  const runnerCtx = host.ctx
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = host.workRoot
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  runnerCtx.provide('appExit', (code: number) => { void code })
  runnerCtx.provide(TUI_STARTUP_SERVICE, {
    sessionId: options.resumeSessionId,
    ...(options.launchPresetId === undefined ? {} : { presetId: options.launchPresetId }),
    ...(options.sessionLaunch === undefined ? {} : { sessionLaunch: options.sessionLaunch }),
    shippedPresetRoot: host.workRoot,
  })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
    extensionService: aggregate.clientUi.extensionService,
    inputRecall: createInputMemoryRecall(),
    ...(options.profileDaemonAdmin === undefined ? {} : { profileDaemonAdmin: options.profileDaemonAdmin }),
  }
  const aggregateRef = aggregate
  // The mounted TuiApp instance, captured exactly like the Direct runner
  // suites' probe (a `start()` patch pushing `this`) — installed BEFORE the
  // runner fiber so the surface's `startProcessTui` call lands inside it.
  const apps: unknown[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: unknown) {
    apps.push(this)
    return originalStart.call(this)
  }
  life.defer(() => { TuiApp.prototype.start = originalStart })
  options.beforeRunnerMount?.(override.presentation, aggregate)
  const runnerFiber = runnerCtx.plugin(pluginCtx => {
    applyRunnerWithRuntime(
      pluginCtx,
      TuiConfigSchema({ fullscreen: 'off', sessionId: options.resumeSessionId } as never),
      override,
      options.startupSettlement,
      // The REAL classifier is proven by its own unit contract and the packed
      // OS lane; this in-process composition only needs a sessionless first
      // create to have a legal Host Workspace target.
      launchProof(process.cwd()),
    )
  })
  await runnerFiber
  // Let the startup composition settle (mount + initial hydration).
  await waitFor('remote runner mount', () => pane === undefined
    ? vt.getViewport().join('').length > 0
    : pane.frameCount() > 0, 20_000)
  const dispose = async (): Promise<void> => {
    await runnerFiber.dispose()
  }
  life.defer(dispose)
  return {
    host,
    runnerFiber,
    vt,
    ...(pane === undefined ? {} : { pane }),
    runnerApp: (): unknown => apps.at(-1),
    override,
    /** The Remote application aggregate (the official Client faces for
     *  test-driven official gestures, e.g. beginSubmission). */
    aggregate: aggregateRef,
    dispose,
  }
}

function testGate(): { readonly promise: Promise<void>; readonly open: () => void; readonly entered: () => boolean } {
  let settled = false
  let open!: () => void
  const promise = new Promise<void>(resolve => {
    open = () => {
      if (settled) return
      settled = true
      resolve()
    }
  })
  return { promise, open, entered: () => settled }
}

async function waitForGate(gate: ReturnType<typeof testGate>, label: string): Promise<void> {
  await waitFor(label, () => gate.entered(), 20_000)
}

/** Observe the REAL official unary carrier after the Host has produced its
 * response. Tests may withhold that actual response; they never replace the
 * Host result with a fabricated Session identity. */
function observeSharedFetch(
  life: TestLifecycle,
  observe: (pathname: string, response: Response) => Promise<Response>,
): void {
  const original = HostConnectionService.prototype.createSharedFetchHandler
  HostConnectionService.prototype.createSharedFetchHandler = function patched(channel: '/api') {
    const shared = original.call(this, channel)
    return {
      ...shared,
      async fetch(request: Request, peer: never): Promise<Response> {
        const response = await shared.fetch(request, peer)
        return await observe(new URL(request.url).pathname, response)
      },
    }
  }
  life.defer(() => { HostConnectionService.prototype.createSharedFetchHandler = original })
}

async function seedBlankWorkspaceSessions(
  host: Awaited<ReturnType<typeof mountRemotePresentationHost>>,
  sessionIds: readonly string[],
): Promise<void> {
  const registry = host.ctx.get('workspaceRegistry') as unknown as {
    create(path: string): Promise<{ attachSession(id: unknown): Promise<void> }>
  }
  const workspace = await registry.create(host.anchorDir)
  for (const sessionId of sessionIds) {
    await host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke-model' } as never, { cwd: host.anchorDir })
    await workspace.attachSession(SessionId(sessionId))
  }
}

async function mountOfficialPeer(
  life: TestLifecycle,
  fixture: RemoteRunnerFixture,
): Promise<Awaited<ReturnType<(typeof import('../support/m3-inprocess/client-runtime.ts'))['createRemoteClientRuntime']>>> {
  const { createRemoteClientRuntime } = await import('../support/m3-inprocess/client-runtime.ts')
  const peer = await createRemoteClientRuntime({ carrier: fixture.aggregate.wire.host.carrier })
  life.defer(() => peer.dispose())
  return peer
}

async function retainPeerSession(
  peer: Awaited<ReturnType<(typeof import('../support/m3-inprocess/client-runtime.ts'))['createRemoteClientRuntime']>>,
  sessionId: string,
) {
  const reference = peer.sessions.retain(SessionId(sessionId), { source: 'controllerOperation' })
  await reference.ready
  const binding = peer.sessions.binding(SessionId(sessionId))
  if (binding === undefined) throw new Error(`the official peer binding for ${sessionId} is absent`)
  return { reference, binding }
}

function hostEventTexts(
  host: Awaited<ReturnType<typeof mountRemotePresentationHost>>,
  sessionId: string,
  type: string,
): string[] {
  const session = host.ctx.sessions.get(SessionId(sessionId)) as unknown as {
    snapshotEvents(): readonly { readonly type: string; readonly data?: unknown }[]
  }
  return session.snapshotEvents().filter(event => event.type === type).map(event => JSON.stringify(event.data ?? {}))
}

async function waitForHostText(
  host: Awaited<ReturnType<typeof mountRemotePresentationHost>>,
  sessionId: string,
  type: string,
  text: string,
): Promise<void> {
  await waitFor(`the official Host ${type} for ${text}`, () =>
    hostEventTexts(host, sessionId, type).some(value => value.includes(text)), 20_000)
}

function countOfficialSessionCalls(life: TestLifecycle, fixture: RemoteRunnerFixture): {
  readonly creates: unknown[]
  readonly retains: unknown[]
  readonly createFailures: unknown[]
} {
  const sessions = fixture.aggregate.wire.client.sessions as unknown as {
    create(options?: unknown): Promise<string>
    retain(target: unknown, options: unknown): unknown
  }
  const creates: unknown[] = []
  const retains: unknown[] = []
  const createFailures: unknown[] = []
  const originalCreate = sessions.create
  const originalRetain = sessions.retain
  sessions.create = function countedCreate(this: unknown, options?: unknown): Promise<string> {
    creates.push(options)
    return originalCreate.call(this, options).catch(error => {
      createFailures.push(error)
      throw error
    })
  }
  sessions.retain = function countedRetain(this: unknown, target: unknown, options: unknown): unknown {
    retains.push({ target, options })
    return originalRetain.call(this, target, options)
  }
  life.defer(() => {
    sessions.create = originalCreate
    sessions.retain = originalRetain
  })
  return { creates, retains, createFailures }
}

function mountedEditor(fixture: RemoteRunnerFixture): {
  setDraft(text: string): void
  getDraft(): string
  getInputHistory(): readonly string[]
  submitDraft(request?: 'enter'): void
  notifyTextForTest(): string
} {
  return fixture.runnerApp() as unknown as ReturnType<typeof mountedEditor>
}

async function openCurrentWorkspace(fixture: RemoteRunnerFixture, draft: string): Promise<void> {
  const editor = mountedEditor(fixture)
  editor.setDraft('/sessions')
  editor.submitDraft()
  await waitFor('the real Session Workspace opens', () =>
    fixture.vt.getViewport().join('\n').includes('Sessions ·'), 20_000)
  editor.setDraft(draft)
  await fixture.vt.waitForRender()
}

async function activateCurrentFolderNew(fixture: RemoteRunnerFixture): Promise<void> {
  fixture.vt.sendInput('\x1b[H')
  await fixture.vt.waitForRender()
  fixture.vt.sendInput('\x1b[B')
  await fixture.vt.waitForRender()
  fixture.vt.sendInput('\x1b[C')
  await fixture.vt.waitForRender()
  fixture.vt.sendInput('\r')
  await fixture.vt.waitForRender()
}

/** Seed one completed durable turn on the REAL Host session. */
function seedTurn(
  fixture: RemoteRunnerFixture,
  sessionId: string,
  turn: number,
  prompt: string,
  response: string,
): void {
  const session = fixture.host.ctx.sessions.get(SessionId(sessionId))
  if (session === undefined) throw new Error(`seedTurn: no Host session ${sessionId}`)
  // rc.2 gives `Session.append` an additional array overload; the single-event
  // fixture seam therefore goes through `unknown` rather than claiming the two
  // signatures overlap.
  const append = (type: string, data: unknown, options?: { surfaceOp?: 'append' }): void => {
    (session.append as unknown as (t: string, d: unknown, o?: { surfaceOp?: 'append' }) => void)(type, data, options)
  }
  append('turn/start', { turn })
  append('step/start', { turn, step: 1 })
  append('user/message', {
    id: `u-${sessionId}-${turn}`,
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'user' },
  })
  append('assistant/message', {
    turn,
    step: 1,
    message: {
      id: `a-${sessionId}-${turn}`,
      role: 'assistant',
      content: [{ type: 'text', text: response }],
      source: { kind: 'model', provider: 'smoke', model: 'smoke' },
    },
    stream: [],
    usage: { inputTokens: 10, outputTokens: 5 },
  })
  append('step/end', { turn, step: 1 })
  append('turn/end', { turn, reason: { kind: 'completed' } })
}

test('a Remote resumed session hydrates the real transcript and status through the official window', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-main'
  const hostPreset = 'm3-4-pr2-preset'
  // Seed the durable session BEFORE the Remote aggregate + runner mount
  // (the resume path re-opens it through the official Client).
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  {
    const host = seedHost
    void host
    const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
    }
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', {
      id: 'u-1', role: 'user', content: [{ type: 'text', text: 'hello remote' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'a-1', role: 'assistant',
        content: [{ type: 'text', text: 'remote answer one' }],
        source: { kind: 'model', provider: 'smoke', model: 'smoke' },
      },
      stream: [], usage: { inputTokens: 10, outputTokens: 5 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  let officialHasMore: boolean | undefined
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host: seedHost,
    beforeRunnerMount: presentation => {
      // Keep the official Remote reader and its real event rows, while controlling
      // the one authoritative page-boundary bit for this coverage qualification.
      const reader = presentation.presentationReader as {
        read(sessionId: string, signal?: AbortSignal): Promise<{ readonly hasMore: boolean; readonly coverage: string } | undefined>
      }
      const originalRead = reader.read
      reader.read = async function controlledBoundary(sessionId: string, signal?: AbortSignal) {
        const snapshot = await originalRead.call(reader, sessionId, signal)
        if (snapshot === undefined) return undefined
        officialHasMore = snapshot.hasMore
        return { ...snapshot, hasMore: true, coverage: 'bounded' }
      }
    },
  })
  await waitFor('transcript hydration', () => {
    const text = fixture.vt.getViewport().join('\n')
    return text.includes('hello remote') && text.includes('remote answer one')
  }, 20_000)
  const frame = fixture.vt.getViewport().join('\n')
  // The durable rows are the OFFICIAL window's rows — one hydration, no
  // duplicate identity (the local-echo ledger never ran: no submit happened).
  assert.equal(frame.includes('hello remote'), true, 'the resumed user row is rendered')
  assert.equal(frame.includes('remote answer one'), true, 'the resumed assistant row is rendered')
  assert.equal(officialHasMore, false, 'the fixture captures the official Reader boundary before controlling the positive')
  const app = fixture.runnerApp() as TuiApp
  await waitFor('Remote search coverage commit', () => app.transcriptSearchCoverageForTest() === 'loaded-history-with-more', 5_000)
  app.startTranscriptSearch('full')
  await waitFor('honest Remote Full coverage label', () => fixture.vt.getViewport().join('\n').includes('Older not searched'), 5_000)
  assert.ok(!fixture.vt.getViewport().join('\n').includes('Entire session'),
    'Remote never describes the loaded query scope as a complete Session')
})

test('a Remote Full Find with the official complete window says only Loaded history', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-search-complete-window'
  const hostPreset = 'm3-4-pr2-preset'
  const host = await mountRemotePresentationHost(life, hostPreset)
  await host.harness.create(SessionId(mainId), undefined, { cwd: host.anchorDir })
  const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    id: 'u-complete-search',
    role: 'user',
    content: [{ type: 'text', text: 'complete remote reader window' }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a-complete-search',
      role: 'assistant',
      content: [{ type: 'text', text: 'remote response' }],
      source: { kind: 'model', provider: 'smoke', model: 'smoke' },
    },
    stream: [],
    usage: { inputTokens: 4, outputTokens: 2 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

  let officialHasMore: boolean | undefined
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host,
    beforeRunnerMount: presentation => {
      // Observe and return the official Reader value unchanged: the test covers
      // the production hasMore=false projection all the way to the Search hint.
      const reader = presentation.presentationReader as {
        read(sessionId: string, signal?: AbortSignal): Promise<{ readonly hasMore: boolean; readonly coverage: string } | undefined>
      }
      const originalRead = reader.read
      reader.read = async function observedOfficialBoundary(sessionId: string, signal?: AbortSignal) {
        const snapshot = await originalRead.call(reader, sessionId, signal)
        if (snapshot !== undefined) officialHasMore = snapshot.hasMore
        return snapshot
      }
    },
  })
  await waitFor('complete Remote hydration', () => fixture.vt.getViewport().join('\n').includes('complete remote reader window'), 20_000)
  assert.equal(officialHasMore, false, 'the real official Reader snapshot proves this window is complete')
  const app = fixture.runnerApp() as TuiApp
  await waitFor('complete-window coverage commit', () => app.transcriptSearchCoverageForTest() === 'loaded-history', 5_000)
  fixture.vt.resize(200, 30)
  await fixture.vt.waitForRender()

  app.startTranscriptSearch('full')
  await waitFor('Remote loaded-history label', () => fixture.vt.getViewport().join('\n').includes('Loaded history'), 5_000)
  const frame = fixture.vt.getViewport().join('\n')
  assert.ok(!frame.includes('Entire session'), 'a bounded Remote Reader never claims a complete Session corpus')
  assert.ok(!frame.includes('earlier history not searched'), 'hasMore=false adds no earlier-history suffix')
})

test('the resumed Remote startup accepts and recalls an input while its hydration read is held', async (t) => {
  // The Remote startup resume awaits `remote.read` AFTER the terminal already
  // accepts input. Feature History PR2-A makes that window harmless for ↑/↓:
  // the ACCEPTED submission is committed to the Client process memory, and the
  // hydration commit never reseeds it from a history file — the same-text disk
  // row written by the legacy Ctrl+R writer is not a recall source.
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-remote-startup-window'
  const hostPreset = 'm3-4-pr2-preset'
  const host = await mountRemotePresentationHost(life, hostPreset, { pluginManagerProfile: true })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  {
    const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
    }
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', {
      id: 'u-1', role: 'user', content: [{ type: 'text', text: 'earlier remote turn' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'a-1', role: 'assistant',
        content: [{ type: 'text', text: 'earlier remote answer' }],
        source: { kind: 'model', provider: 'smoke', model: 'smoke' },
      },
      stream: [], usage: { inputTokens: 4, outputTokens: 2 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  let readEntered = false
  let releaseRead!: () => void
  const readGate = new Promise<void>(resolve => { releaseRead = resolve })
  let gated = false
  // Negative control: the Split Client never executes the Direct cold
  // cross-cwd recall read — at boot, at hydration, or from the settlement.
  const coldReads: string[] = []
  const realHistoryRead = FileHistorySearchSource.prototype.readSessionRecall
  FileHistorySearchSource.prototype.readSessionRecall = async function countedColdRead(
    this: FileHistorySearchSource,
    sessionId: string,
    signal?: AbortSignal,
  ) {
    coldReads.push(sessionId)
    return realHistoryRead.call(this, sessionId, signal)
  }
  life.defer(() => { FileHistorySearchSource.prototype.readSessionRecall = realHistoryRead })
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host,
    productionSerializer: true,
    beforeRunnerMount: (presentation) => {
      // The legacy Ctrl+R writer's data for this exact Session already exists
      // on disk; the process recall must not import it.
      appendHistoryRecord(
        historyFilePath(dshHome(process.env), process.cwd()),
        { v: 2, content: 'disk-only client-cwd prompt', cwd: process.cwd(), ts: Date.now(), sessionId: mainId },
        undefined,
      )
      const reader = presentation.presentationReader as unknown as {
        read(sessionId: string, signal?: AbortSignal): Promise<unknown>
      }
      const real = reader.read
      reader.read = async function gatedRead(sessionId: string, signal?: AbortSignal): Promise<unknown> {
        if (gated) return real.call(reader, sessionId, signal)
        gated = true
        // The REAL read completes first (its wire round trip is exactly what
        // production awaits); the gate then holds its RESULT, so the terminal
        // keeps accepting input while the hydration continuation is pending.
        const captured = await real.call(reader, sessionId, signal)
        readEntered = true
        await readGate
        return captured
      }
    },
  })
  // Bounded readiness: a startup read that never runs fails this test instead
  // of parking it.
  await waitFor('the held startup read to be entered', () => readEntered, 20_000)
  const editor = fixture.runnerApp() as unknown as {
    getDraft(): string
    getInputHistory(): readonly string[]
  }
  const diskFile = historyFilePath(dshHome(process.env), process.cwd())
  const diskBefore = readFileSync(diskFile)
  try {
    assert.deepEqual([...editor.getInputHistory()], [],
      'a new Client process recall starts empty even though a disk row exists')

    // A REAL keyboard submission while the hydration read is still held.
    fixture.vt.sendInput('first remote prompt')
    await fixture.vt.waitForRender()
    fixture.vt.sendInput('\r')
    await waitFor('the accepted input is recalled from the process memory', () =>
      [...editor.getInputHistory()].includes('first remote prompt'), 20_000)
    assert.ok(readFileSync(diskFile).equals(diskBefore),
      'the Remote submission wrote no Client history file (Feature History PR2-B)')

    // Release the official read: the hydration commits the transcript and must
    // NOT reseed or clear the recall list.
    releaseRead()
    await waitFor('the resumed hydration committed the transcript', () =>
      fixture.vt.getViewport().join('').includes('earlier remote answer'), 20_000)
    // PR2-C: the resumed hydration schedules the Host recall seed of THIS
    // Session. The local acceptance stays first; the accepted remote turn is
    // merged from the official Host corpus (never from a Client history file).
    await waitFor('the Host seed commits the resumed Session recall', () =>
      [...editor.getInputHistory()].includes('earlier remote turn'), 20_000)
    assert.deepEqual([...editor.getInputHistory()], ['first remote prompt', 'earlier remote turn'],
      'local accepted input first, then the Host seed; no Client file row')
    assert.deepEqual(coldReads, [], 'the Split Client never runs the Direct cold cross-cwd recall read')

    // The REAL ↑ sink recalls the acceptance-boundary input.
    fixture.vt.sendInput('\x1b[A')
    await waitFor('the real ↑ sink recalls the accepted input', () =>
      editor.getDraft() === 'first remote prompt', 5_000)
  } finally {
    releaseRead()
    FileHistorySearchSource.prototype.readSessionRecall = realHistoryRead
    await fixture.dispose()
  }
})

test('a resumed Remote Session recalls only this process\'s accepted inputs, never disk rows', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-r11-process-pitui'
  const otherId = 'm3-4-r11-process-pitui-b'
  const presetId = 'm3-4-r11-process-pitui-preset'
  const host = await mountRemotePresentationHost(life, presetId, { pluginManagerProfile: true })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  await host.harness.create(SessionId(otherId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const appendOf = (id: string) => host.ctx.sessions.get(SessionId(id)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }
  seedTurns(appendOf(mainId), 1, 1, 'resume')
  seedTurns(appendOf(otherId), 1, 1, 'switch')
  // The OLD cold-seed data: rows for the SAME Session in two cwds. A resumed
  // Session used to import these; the process recall must not.
  const currentFile = historyFilePath(host.workRoot, host.anchorDir)
  mkdirSync(dirname(currentFile), { recursive: true })
  appendHistoryRecord(currentFile, { v: 2, content: 'current cwd disk row', cwd: host.anchorDir, ts: 10, sessionId: mainId }, undefined)
  const otherFile = historyFilePath(host.workRoot, '/client-other-cwd')
  mkdirSync(dirname(otherFile), { recursive: true })
  appendHistoryRecord(otherFile, { v: 2, content: 'other cwd disk row', cwd: '/client-other-cwd', ts: 20, sessionId: mainId }, undefined)
  const coldReads: string[] = []
  const realHistoryRead = FileHistorySearchSource.prototype.readSessionRecall
  FileHistorySearchSource.prototype.readSessionRecall = async function countedColdRead(
    this: FileHistorySearchSource,
    sessionId: string,
    signal?: AbortSignal,
  ) {
    coldReads.push(sessionId)
    return realHistoryRead.call(this, sessionId, signal)
  }
  life.defer(() => { FileHistorySearchSource.prototype.readSessionRecall = realHistoryRead })
  const fixture = await mountRemoteRunner(life, { presetId, resumeSessionId: mainId, host, productionSerializer: true })
  const editor = fixture.runnerApp() as unknown as {
    setDraft(text: string): void
    submitDraft(): void
    getDraft(): string
    getInputHistory(): readonly string[]
  }
  const viewport = (): string => fixture.vt.getViewport().join('\n')
  const userRowsFor = (sessionId: string, text: string): number => appendOf(sessionId).snapshotEvents()
    .filter(event => event.type === 'user/message' && JSON.stringify(event.data).includes(text)).length
  try {
    await waitFor('the resumed Session hydrated', () => viewport().includes('resume answer 1'), 20_000)
    await waitFor('the Host seed commits the resumed Session recall', () =>
      [...editor.getInputHistory()].includes('resume prompt 1'), 20_000)
    assert.deepEqual([...editor.getInputHistory()], ['resume prompt 1'],
      'the resumed Session seeds ITS OWN accepted Host history, never a Client file row')
    assert.deepEqual(coldReads, [], 'the Split Client never runs the Direct cold cross-cwd recall read')

    // The official Host seed reaches the REAL ↑ sink before any local entry.
    fixture.vt.sendInput('\x1b[A')
    await waitFor('↑ recalls the Host-seeded row', () => editor.getDraft() === 'resume prompt 1', 5_000)
    fixture.vt.sendInput('\x1b[B')
    await waitFor('↓ returns to the empty bookmarked draft', () => editor.getDraft() === '', 5_000)

    // A REAL keyboard submission into the resumed Session (the production
    // admission/writer path, never a store seed).
    const submitted = 'live process prompt'
    fixture.vt.sendInput(submitted)
    await fixture.vt.waitForRender()
    fixture.vt.sendInput('\r')
    await waitFor('the accepted input is recalled from the process memory', () =>
      [...editor.getInputHistory()].includes(submitted), 20_000)
    assert.equal(editor.getDraft(), '', 'the accepted commit cleared the composer')

    await waitFor('the accepted prompt reaches the Host durable log', () =>
      userRowsFor(mainId, submitted) === 1, 20_000)
    // ↑ recalls the text into the composer and NEVER submits it.
    fixture.vt.sendInput('\x1b[A')
    await waitFor('↑ recalls the process input', () => editor.getDraft() === submitted, 5_000)
    assert.equal(userRowsFor(mainId, submitted), 1, 'a recalled draft is never submitted by ↑')
    fixture.vt.sendInput('\x1b[B')
    await waitFor('↓ restores the empty draft before the carrier rollover', () => editor.getDraft() === '', 5_000)

    // DECISIVE source → sink chain: the accepted submission is durable in the
    // Host with an official request correlation; a reconnect DISCARDS the local
    // copy and re-seeds the SAME text through the private Host recall read.
    const acceptedRpcId = appendOf(mainId).snapshotEvents()
      .flatMap(event => event.type === 'agent/inbox/spliced'
        ? ((event.data as { inserted?: Array<{ source?: { rpcId?: string } }> }).inserted ?? [])
        : [])
      .map(message => message.source?.rpcId)
      .filter((rpcId): rpcId is string => typeof rpcId === 'string' && rpcId !== '')
      .at(-1)
    assert.equal(typeof acceptedRpcId, 'string', 'the accepted Host occurrence carries the official rpcId')
    const connection = fixture.aggregate.wire.client.connection as unknown as { reconnect(): void }
    connection.reconnect()
    await waitFor('the reconnect re-seeds the accepted input from the Host', () =>
      [...editor.getInputHistory()].includes(submitted), 20_000)
    assert.deepEqual([...editor.getInputHistory()], [submitted, 'resume prompt 1'],
      'the local copy was discarded; the Host seed supplies the accepted occurrence once, newest first')
    fixture.vt.sendInput('\x1b[A')
    await waitFor('↑ recalls the re-seeded Host occurrence', () => editor.getDraft() === submitted, 5_000)
    fixture.vt.sendInput('\x1b[B')
    await waitFor('↓ returns to the empty bookmarked draft', () => editor.getDraft() === '', 5_000)

    // A real Session switch through the mounted command registry: the process
    // list survives, and the outgoing draft/bookmark is not restored into the
    // new Session.
    editor.setDraft(`/resume ${otherId}`)
    editor.submitDraft()
    await waitFor('Session B hydrated', () => viewport().includes('switch answer 1'), 20_000)
    await waitFor('Session B Host seed replaces A\'s scope', () =>
      [...editor.getInputHistory()].includes('switch prompt 1'), 20_000)
    const afterSwitch = [...editor.getInputHistory()]
    assert.deepEqual(afterSwitch, ['switch prompt 1'],
      'after publication only B\'s local/Host scope remains: A\'s list and the sessionless switch command are not imported')
    assert.equal(afterSwitch.includes(submitted), false, 'A input never paints in B')
    assert.equal(afterSwitch.includes(`/resume ${otherId}`), false, 'a sessionless command is not imported into B')
    assert.equal(afterSwitch.includes('current cwd disk row'), false, 'no disk row ever joins the list')
    assert.equal(afterSwitch.includes('other cwd disk row'), false, 'no other-cwd disk row either')
    assert.equal(editor.getDraft(), '', 'no old draft is restored into the new Session')

    // A reconnect on Session B is a NEW carrier: B's scope clears and re-seeds
    // from the SAME trusted Host history, never from A and never from a file.
    connection.reconnect()
    await waitFor('the reconnect re-hydrated Session B', () => viewport().includes('switch answer 1'), 20_000)
    await waitFor('the new carrier re-seeds the same Session', () =>
      [...editor.getInputHistory()].includes('switch prompt 1'), 20_000)
    assert.deepEqual([...editor.getInputHistory()], afterSwitch,
      'a reconnect on the SAME Session re-seeds the same trusted Host history')
    fixture.vt.sendInput('\x1b[A')
    await waitFor('↑ still recalls B\'s accepted input after the reconnect', () =>
      editor.getDraft() === 'switch prompt 1', 5_000)
    assert.deepEqual(coldReads, [], 'no reconnect path reads a history file for recall')
  } finally {
    FileHistorySearchSource.prototype.readSessionRecall = realHistoryRead
    await fixture.dispose()
  }
})

test('the mounted Client namespace carries the recall descriptor end-to-end with official correlation', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2c-l5-recall'
  const presetId = 'm3-4-pr2c-l5-recall-preset'
  const host = await mountRemotePresentationHost(life, presetId, { pluginManagerProfile: true })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountRemoteRunner(life, { presetId, resumeSessionId: mainId, host, productionSerializer: true })
  const namespace = (fixture.aggregate.wire.client.remote as unknown as {
    readonly piTuiHistorySearch: {
      readSessionRecall(
        request: { readonly sessionId: string },
        signal?: AbortSignal,
      ): Promise<{ readonly ok: boolean; readonly value?: unknown; readonly error?: unknown }>
    }
  }).piTuiHistorySearch
  try {
    await waitFor('the resumed Session hydrated', () => fixture.vt.getViewport().join('').length > 0, 20_000)
    // ONE official Host admission carrying the real requestId the Client sent.
    await host.ctx.sessionController.prompt({
      requestId: 'req-l5-recall' as never,
      sessionId: SessionId(mainId),
      mode: 'queue',
      content: [{ type: 'text', text: 'l5 recall official correlation' }] as never,
    }, new AbortController().signal)
    let answer: { readonly ok: boolean; readonly value?: unknown; readonly error?: unknown } | undefined
    const started = Date.now()
    while (Date.now() - started < 20_000) {
      answer = await namespace.readSessionRecall({ sessionId: mainId })
      if (answer.ok && (answer.value as { kind?: string }).kind === 'ready') break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(answer?.ok, true, `the real Client wire must answer: ${JSON.stringify(answer?.error)}`)
    const value = answer?.value as {
      kind: string
      sessionId: string
      items: Array<{ messageId: string; rpcId?: string; text: string }>
    }
    assert.equal(value.kind, 'ready', JSON.stringify(value))
    assert.equal(value.sessionId, mainId)
    assert.deepEqual(value.items.map(item => [item.text, item.rpcId]), [
      ['l5 recall official correlation', 'req-l5-recall'],
    ], 'the mounted Client namespace carries the exact official rpcId and original text')
  } finally {
    await fixture.dispose()
  }
})

test('a Host seed for A released after B publication never appends A to the current scope', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2c-late-seed-a'
  const otherId = 'm3-4-pr2c-late-seed-b'
  const presetId = 'm3-4-pr2c-late-seed-preset'
  const host = await mountRemotePresentationHost(life, presetId, { pluginManagerProfile: true })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  await host.harness.create(SessionId(otherId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const appendOf = (id: string) => host.ctx.sessions.get(SessionId(id)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  seedTurns(appendOf(mainId), 1, 1, 'late-a')
  seedTurns(appendOf(otherId), 1, 1, 'late-b')
  let seedReadEntered = false
  let releaseSeed!: () => void
  const seedGate = new Promise<void>(resolve => { releaseSeed = resolve })
  const fixture = await mountRemoteRunner(life, {
    presetId,
    resumeSessionId: mainId,
    host,
    productionSerializer: true,
    beforeRunnerMount: (presentation) => {
      const port = presentation.historySearch as unknown as {
        readSessionRecall(request: { readonly sessionId: string }, signal: AbortSignal): Promise<unknown>
      }
      const real = port.readSessionRecall
      port.readSessionRecall = async function heldSeed(
        this: unknown,
        request: { readonly sessionId: string },
        signal: AbortSignal,
      ): Promise<unknown> {
        const answer = await real.call(this, request, signal)
        if (request.sessionId !== mainId) return answer
        seedReadEntered = true
        await seedGate
        return answer
      }
    },
  })
  const editor = fixture.runnerApp() as unknown as {
    setDraft(text: string): void
    submitDraft(): void
    getInputHistory(): readonly string[]
  }
  try {
    await waitFor('A\'s seed read is held', () => seedReadEntered, 20_000)
    assert.deepEqual([...editor.getInputHistory()], [], 'the held read is not visible yet')

    // A REAL publication A → B. B's own seed commits while A's answer is held.
    editor.setDraft(`/resume ${otherId}`)
    editor.submitDraft()
    await waitFor('B\'s Host seed commits', () =>
      [...editor.getInputHistory()].includes('late-b prompt 1'), 20_000)
    assert.deepEqual([...editor.getInputHistory()], ['late-b prompt 1'])

    // Release the OLD carrier/Session answer. It must not append A's rows.
    releaseSeed()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual([...editor.getInputHistory()], ['late-b prompt 1'],
      'a late A seed cannot mutate the current B scope')
    assert.equal([...editor.getInputHistory()].includes('late-a prompt 1'), false)
  } finally {
    releaseSeed()
    await fixture.dispose()
  }
})

test('an unavailable recall read leaves the current local recall intact', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2c-unavailable-recall'
  const presetId = 'm3-4-pr2c-unavailable-recall-preset'
  const host = await mountRemotePresentationHost(life, presetId, { pluginManagerProfile: true })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  seedTurns(host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }, 1, 1, 'unavailable')
  const fixture = await mountRemoteRunner(life, {
    presetId,
    resumeSessionId: mainId,
    host,
    productionSerializer: true,
    beforeRunnerMount: (presentation) => {
      const port = presentation.historySearch as unknown as {
        readSessionRecall(request: { readonly sessionId: string }, signal: AbortSignal): Promise<unknown>
      }
      port.readSessionRecall = async () => ({ kind: 'unavailable', reason: 'service-missing' })
    },
  })
  const editor = fixture.runnerApp() as unknown as {
    getDraft(): string
    getInputHistory(): readonly string[]
  }
  try {
    await waitFor('the resumed Session hydrated', () => fixture.vt.getViewport().join('').length > 0, 20_000)
    const submitted = 'local survives an unavailable seed'
    fixture.vt.sendInput(submitted)
    await fixture.vt.waitForRender()
    fixture.vt.sendInput('\r')
    await waitFor('the local accepted input is recalled despite the unavailable seed', () =>
      [...editor.getInputHistory()].includes(submitted), 20_000)
    assert.deepEqual([...editor.getInputHistory()], [submitted],
      'the unavailable Host read contributes nothing and never clears the local list')
    fixture.vt.sendInput('\x1b[A')
    await waitFor('↑ recalls the local input', () => editor.getDraft() === submitted, 5_000)
  } finally {
    await fixture.dispose()
  }
})

test('a carrier rollover retires the outgoing recall mirror before an unavailable new seed', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2c-rollover-clear'
  const presetId = 'm3-4-pr2c-rollover-clear-preset'
  const host = await mountRemotePresentationHost(life, presetId, { pluginManagerProfile: true })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  seedTurns(host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }, 1, 1, 'rollover')
  let unavailable = false
  let recallPort: {
    readSessionRecall(request: { readonly sessionId: string }, signal: AbortSignal): Promise<unknown>
  } | undefined
  const fixture = await mountRemoteRunner(life, {
    presetId,
    resumeSessionId: mainId,
    host,
    productionSerializer: true,
    beforeRunnerMount: (presentation) => {
      const port = presentation.historySearch as unknown as NonNullable<typeof recallPort>
      const real = port.readSessionRecall
      recallPort = port
      port.readSessionRecall = async function heldScope(
        this: unknown,
        request: { readonly sessionId: string },
        signal: AbortSignal,
      ): Promise<unknown> {
        if (unavailable) return { kind: 'unavailable', reason: 'service-missing' }
        return await real.call(this, request, signal)
      }
    },
  })
  const editor = fixture.runnerApp() as unknown as {
    getDraft(): string
    getInputHistory(): readonly string[]
  }
  const viewport = (): string => fixture.vt.getViewport().join('\n')
  try {
    await waitFor('the original carrier seeded its Session', () =>
      [...editor.getInputHistory()].includes('rollover prompt 1'), 20_000)
    fixture.vt.sendInput('\x1b[A')
    await waitFor('the original mirror recalls its Host row', () =>
      editor.getDraft() === 'rollover prompt 1', 5_000)
    fixture.vt.sendInput('\x1b[B')
    await waitFor('the original browse returns to the empty draft', () => editor.getDraft() === '', 5_000)

    // The NEW carrier's read is unavailable: the root scope clears at the
    // generation/init boundary, and the mounted editor must follow at once.
    assert.ok(recallPort !== undefined)
    unavailable = true
    const connection = fixture.aggregate.wire.client.connection as unknown as { reconnect(): void }
    connection.reconnect()
    await waitFor('the root recall scope cleared', () => editor.getInputHistory().length === 0, 20_000)
    await waitFor('the replacement carrier re-hydrated the Session', () =>
      viewport().includes('rollover answer 1'), 20_000)
    fixture.vt.sendInput('\x1b[A')
    await fixture.vt.waitForRender()
    assert.equal(editor.getDraft(), '',
      'the old carrier row must be gone from the REAL ↑ sink even when the new seed is unavailable')
    assert.deepEqual([...editor.getInputHistory()], [])
  } finally {
    await fixture.dispose()
  }
})

test('a resumed Remote TSP composer recalls only this process\'s accepted inputs, never disk rows', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-r11-process-tsp'
  const presetId = 'm3-4-r11-process-tsp-preset'
  const host = await mountRemotePresentationHost(life, presetId, { pluginManagerProfile: true })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const otherId = 'm3-4-r11-process-tsp-b'
  const otherCwd = `${host.anchorDir}-b`
  mkdirSync(otherCwd, { recursive: true })
  await host.harness.create(SessionId(otherId), { provider: 'smoke', model: 'smoke' }, { cwd: otherCwd })
  const appendOf = (id: string) => host.ctx.sessions.get(SessionId(id)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }
  // Session A is deliberately assistant-only: the fresh-composer ↑ negative
  // below needs a resumed scope with NO eligible Host seed row.
  appendOf(mainId).append('turn/start', { turn: 1 })
  appendOf(mainId).append('step/start', { turn: 1, step: 1 })
  appendOf(mainId).append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a-tsp-resume-1', role: 'assistant',
      content: [{ type: 'text', text: 'tsp-resume answer 1' }],
      source: { kind: 'model', provider: 'smoke', model: 'smoke' },
    },
    stream: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }, { surfaceOp: 'append' })
  appendOf(mainId).append('step/end', { turn: 1, step: 1 })
  appendOf(mainId).append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  seedTurns(appendOf(otherId), 1, 1, 'tsp-b')
  const currentFile = historyFilePath(host.workRoot, host.anchorDir)
  mkdirSync(dirname(currentFile), { recursive: true })
  appendHistoryRecord(currentFile, { v: 2, content: 'current cwd disk row', cwd: host.anchorDir, ts: 10, sessionId: mainId }, undefined)
  const otherFile = historyFilePath(host.workRoot, '/client-other-cwd')
  mkdirSync(dirname(otherFile), { recursive: true })
  appendHistoryRecord(otherFile, { v: 2, content: 'other cwd disk row', cwd: '/client-other-cwd', ts: 20, sessionId: mainId }, undefined)
  const coldReads: string[] = []
  const realHistoryRead = FileHistorySearchSource.prototype.readSessionRecall
  FileHistorySearchSource.prototype.readSessionRecall = async function countedColdRead(
    this: FileHistorySearchSource,
    sessionId: string,
    signal?: AbortSignal,
  ) {
    coldReads.push(sessionId)
    return realHistoryRead.call(this, sessionId, signal)
  }
  life.defer(() => { FileHistorySearchSource.prototype.readSessionRecall = realHistoryRead })
  const fixture = await mountRemoteRunner(life, {
    presetId,
    resumeSessionId: mainId,
    host,
    renderer: 'tsp',
    sessionBrowser: true,
    productionSerializer: true,
  })
  const pane = fixture.pane
  assert.ok(pane, 'the Remote TSP pane must be mounted')
  const composerText = (): string => {
    const node = wireNodes({ frames: () => pane.frames() }).find(candidate => candidate.id === 'dock.composer')
    return typeof node?.p.text === 'string' ? node.p.text : ''
  }
  /** The exact official Host user texts (never a substring match: a disk-seeded
   * composer draft would append to the typed marker and must be caught). */
  const hostTextsOf = (id: string): string[] => appendOf(id).snapshotEvents()
    .filter(event => event.type === 'user/message')
    .map(event => {
      const data = event.data as { content?: Array<{ type?: string; text?: string }> }
      return (data.content ?? [])
        .filter(part => part.type === 'text')
        .map(part => part.text ?? '')
        .join('')
    })
  try {
    await waitFor('the TSP composer is painted', () =>
      wireNodes({ frames: () => pane.frames() }).some(candidate => candidate.id === 'dock.composer'), 20_000)
    assert.equal(composerText(), '', 'a new process recall paints no recalled draft')
    assert.deepEqual(coldReads, [], 'the Split Client never runs the Direct cold cross-cwd recall read')

    // DECISIVE fresh-draft negative: the isolated launch-cwd files already hold
    // disk rows. A real TSP ↑ on the empty composer must be a no-op; the typed
    // marker then reaches the Host EXACTLY as typed. A disk-seeded list would
    // have appended the disk row to this draft.
    const submitted = 'tsp live process prompt'
    pane.input.type('\x1b[A')
    pane.input.type(submitted)
    await waitFor('the composer carries the typed draft after ↑', () => composerText() === submitted, 5_000)
    pane.input.type('\r')
    await waitFor('the accepted TSP input is the EXACT typed text', () =>
      hostTextsOf(mainId).filter(text => text === submitted).length === 1, 20_000)
    assert.equal(hostTextsOf(mainId).filter(text => text === submitted).length, 1,
      'a disk-only ↑ seed would have appended to the typed marker')
    // The accepted settle clears the composer; ↑ then recalls the same text.
    await waitFor('the accepted commit cleared the TSP composer', () => composerText() === '', 5_000)
    pane.input.type('\x1b[A')
    await waitFor('the TSP ↑ recalls the process input', () => composerText() === submitted, 5_000)
    assert.equal(hostTextsOf(mainId).filter(text => text === submitted).length, 1,
      'a recalled draft is never submitted by ↑')

    // ↓ returns from the recalled row to the bookmarked empty draft (real key
    // sink), so the switch command starts from a genuinely empty composer.
    pane.input.type('\x1b[B')
    await waitFor('↓ returns to the empty bookmarked draft', () => composerText() === '', 5_000)
    // A REAL owner publication A → B (different cwd) through the TSP key sink.
    // The process snapshot survives, while the outgoing draft/bookmark is not
    // restored into B.
    pane.input.type(`/sessions ${otherId}\r`)
    await waitFor('the TSP Session Browser opened', () =>
      JSON.stringify(pane.frames()).includes('session-browser-picker'), 20_000)
    pane.input.type('\r')
    await waitFor('Session B authoritative baseline is painted', () =>
      JSON.stringify(pane.frames()).includes('tsp-b answer 1'), 20_000)
    assert.equal(composerText(), '', 'the owner publication restores no old draft/bookmark into B')
    // PR2-C: A's local input and the sessionless switch command are NOT
    // imported; B seeds its OWN accepted Host history after the publication.
    // The real TSP key sink reaches B's own seeded row; ↓ returns to the empty
    // bookmarked draft. Repeated ↑ stays on that ONE row: A's marker and the
    // sessionless switch command are not in B's scope.
    pane.input.type('\x1b[A')
    await waitFor('↑ after the publication recalls B\'s own Host seed', () =>
      composerText() === 'tsp-b prompt 1', 20_000)
    pane.input.type('\x1b[A')
    pane.input.type('\x1b[A')
    await waitFor('repeated ↑ never reaches an imported A row', () => composerText() === 'tsp-b prompt 1', 5_000)
    pane.input.type('\x1b[B')
    await waitFor('↓ returns to the empty bookmarked draft', () => composerText() === '', 5_000)
    await waitFor('the old Session A input never reaches Session B', () =>
      hostTextsOf(otherId).filter(text => text === submitted).length === 0, 5_000)
    assert.equal(hostTextsOf(otherId).filter(text => text === submitted).length, 0,
      'the old Session A input never leaks into Session B')
    assert.deepEqual(coldReads, [], 'no hydration path read a history file for recall')
  } finally {
    FileHistorySearchSource.prototype.readSessionRecall = realHistoryRead
    await fixture.dispose()
  }
})

test('Remote A: Ctrl+R reads the Host accepted history, leaves the legacy JSONL untouched and never seeds the process recall', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-r11-remote-ctrlr'
  const presetId = 'm3-4-r11-remote-ctrlr-preset'
  const host = await mountRemotePresentationHost(life, presetId, { pluginManagerProfile: true })
  const agent = await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const currentFile = historyFilePath(host.workRoot, host.anchorDir)
  const historyDirectory = dirname(currentFile)
  mkdirSync(historyDirectory, { recursive: true })
  const sentinel = 'legacy jsonl sentinel never a remote ctrl r row'
  appendHistoryRecord(currentFile, {
    v: 2, content: sentinel, cwd: host.anchorDir, ts: 10, sessionId: mainId,
  }, undefined)
  const sentinelBytes = readFileSync(currentFile)
  const sentinelStat = statSync(currentFile)
  const filesBefore = readdirSync(historyDirectory).sort()
  const fixture = await mountRemoteRunner(life, {
    presetId,
    resumeSessionId: mainId,
    host,
    productionSerializer: true,
  })
  const edited = fixture.runnerApp() as unknown as {
    getDraft(): string
    getInputHistory(): readonly string[]
    historySearchSource?: unknown
    historySearchRead?: unknown
    captureHistoryScope?: () => unknown
  }
  const viewport = (): string => fixture.vt.getViewport().join('\n')
  const hostUserTexts = (): string[] => {
    const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ type: string; data: unknown }>
    }
    return session.snapshotEvents()
      .filter(event => event.type === 'user/message')
      .map(event => {
        const data = event.data as { content?: Array<{ type?: string; text?: string }> }
        return (data.content ?? [])
          .filter(part => part.type === 'text')
          .map(part => part.text ?? '')
          .join('')
      })
  }
  const historyResultLines = (): string[] => {
    const lines = fixture.vt.getViewport()
    const start = lines.findIndex(line => line.includes('Results ·') || line.includes('No matches'))
    if (start < 0) return []
    const end = lines.findIndex((line, index) => index > start && line.trimStart().startsWith('Preview'))
    return lines.slice(start + 1, end < 0 ? undefined : end)
  }
  const remoteView = (): {
    query: string
    status: string
    rows: readonly unknown[]
    body: { kind: string }
  } | undefined => (edited as unknown as {
    historyPanel?: { remote?: { view(): { query: string; status: string; rows: readonly unknown[]; body: { kind: string } } } }
  }).historyPanel?.remote?.view()
  const assertLegacyFileUntouched = (): void => {
    assert.ok(readFileSync(currentFile).equals(sentinelBytes), 'the legacy JSONL bytes changed')
    const after = statSync(currentFile)
    assert.equal(after.ino, sentinelStat.ino, 'the legacy JSONL inode was replaced')
    assert.equal(after.mtimeMs, sentinelStat.mtimeMs, 'the legacy JSONL was rewritten')
    assert.deepEqual(readdirSync(historyDirectory).sort(), filesBefore,
      'the Remote Client created or removed a user-history file')
  }
  try {
    assert.equal((edited as unknown as { historySearchSource?: unknown }).historySearchSource, undefined,
      'the Remote Client constructs no Client-local file source')
    assert.deepEqual([...edited.getInputHistory()], [],
      'the resumed Split Client starts with an empty process recall')

    const marker = 'host accepted ctrl r remote'
    fixture.vt.sendInput(marker)
    await fixture.vt.waitForRender()
    fixture.vt.sendInput('\r')
    await waitFor('the accepted prompt is recalled from the process memory', () =>
      [...edited.getInputHistory()].includes(marker), 20_000)
    await waitFor('the accepted marker reached the official Host log', () =>
      hostUserTexts().filter(text => text === marker).length === 1, 20_000)
    const hostSubmitsBefore = hostUserTexts()
    assertLegacyFileUntouched()
    const memoryBefore = [...edited.getInputHistory()]

    // The Remote seat reads the Host accepted row through the private service:
    // the legacy JSONL sentinel is absent and the real accepted prompt restores.
    fixture.vt.sendInput('\x12')
    await waitFor('the Remote History seat opened', () => viewport().includes('Input History'), 15_000)
    fixture.vt.sendInput('host accepted ctrl r remote')
    await waitFor('the filtered Host query and its exact body committed', () => {
      const view = remoteView()
      return view?.query === 'host accepted ctrl r remote' && view.status === 'ready' && view.body.kind === 'ready'
    }, 20_000)
    await fixture.vt.waitForRender()
    assert.ok(historyResultLines().some(line => line.includes(marker)),
      'the Host accepted marker is the committed result row')
    assert.ok(!historyResultLines().some(line => line.includes(sentinel)),
      'the legacy JSONL sentinel is not a Host result')
    await waitFor('the exact Host body is ready for the action bar', () =>
      !viewport().includes('Loading full text'), 20_000)
    fixture.vt.sendInput('\r')
    await fixture.vt.waitForRender()
    assert.equal(edited.getDraft(), marker, 'Ctrl+R restores the exact Host accepted text into the editor')
    assert.ok(!viewport().includes('Input History'), 'the seat closed on the real accept boundary')
    assert.deepEqual(hostUserTexts(), hostSubmitsBefore,
      'restoring the accepted prompt from Ctrl+R dispatches no submission')
    assert.deepEqual([...edited.getInputHistory()], memoryBefore,
      'Ctrl+R restore never changes the process recall')
    assertLegacyFileUntouched()
    // The restore itself never submitted. A LATER Enter is the one submit.
    const afterAcceptCount = hostUserTexts().length
    fixture.vt.sendInput('\r')
    await waitFor('the deliberate second Enter submits the restored text', () =>
      hostUserTexts().length === afterAcceptCount + 1, 20_000)
    assert.equal(edited.getDraft(), '', 'the submit clears the restored draft')
    const hostSubmitsAfterAccept = hostUserTexts()

    // A JSONL-only row is NOT a Remote Ctrl+R result; the seat answers the
    // authoritative empty Host page (No matches), never a legacy-file fallback.
    fixture.vt.sendInput('\x12')
    await waitFor('the Remote History seat reopened for the sentinel query', () =>
      viewport().includes('Input History'), 15_000)
    fixture.vt.sendInput('legacy jsonl sentinel')
    await waitFor('the Host answers an authoritative empty page', () => {
      const view = remoteView()
      return view?.query === 'legacy jsonl sentinel' && view.status === 'ready' && view.rows.length === 0
    }, 20_000)
    await fixture.vt.waitForRender()
    assert.ok(viewport().includes('No matches'))
    assert.ok(!historyResultLines().some(line => line.includes(sentinel)))
    fixture.vt.sendInput('\x1b')
    await fixture.vt.waitForRender()
    assertLegacyFileUntouched()
    assert.deepEqual(hostUserTexts(), hostSubmitsAfterAccept,
      'an empty Host search dispatches no submission')

    // The active-scope face revokes the open seat when the Host working
    // directory changes, even though no Client file was ever involved.
    const cwdB = join(host.anchorDir, 'cwd-b')
    mkdirSync(cwdB, { recursive: true })
    fixture.vt.sendInput('\x12')
    await waitFor('the Remote History seat opened before the cwd change', () =>
      viewport().includes('Input History'), 15_000)
    await host.ctx.workingDirectory.set(agent, cwdB)
    await waitFor('the active-scope change retired the Remote History seat', () =>
      !viewport().includes('Input History'), 20_000)
    assertLegacyFileUntouched()
  } finally {
    await fixture.dispose()
  }
})

test('the Remote branch performs zero Direct graph construction', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountRemoteRunner(life, {})
  // The Direct factory is unreachable on the Remote selection: the selected
  // core is the aggregate's own; asserting kind + backend identity is the
  // composition proof (the selection suite locks the source shape).
  assert.equal(fixture.override.selected.kind, 'remote')
  assert.equal(fixture.override.selected.backend.kind, 'remote')
  assert.equal(fixture.override.presentation.presentationReader !== undefined, true)
  assert.equal(fixture.override.presentation.submissionPresentation !== undefined, true)
})

test('sessionStatus serves the retained session facts and stays absent for unretained ids', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-status'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    id: 'u-s', role: 'user', content: [{ type: 'text', text: 'status probe' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: { id: 'a-s', role: 'assistant', content: [{ type: 'text', text: 'status answer' }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
    stream: [], usage: { inputTokens: 21, outputTokens: 9 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  await waitFor('status facts retained', () => {
    return fixture.override.presentation.sessionFacts.sessionStatus(mainId) !== undefined
  }, 15_000)
  const facts = fixture.override.presentation.sessionFacts.sessionStatus(mainId)
  assert.ok(facts !== undefined)
  assert.equal(facts.sessionId, mainId)
  assert.equal(facts.cwd, seedHost.anchorDir, 'the official list-row cwd of THIS session')
  assert.ok(facts.usage !== undefined, 'the official tokenUsage projection is served')
  assert.equal(facts.usage!.uncachedInputTokens, 21)
  assert.equal(facts.usage!.outputTokens, 9)
  // Absent-field discipline: an unretained id never fabricates facts.
  assert.equal(fixture.override.presentation.sessionFacts.sessionStatus('no-such-session'), undefined,
    'an unretained session has no facts — never a guessed value')
  // USER-VISIBLE status: the RENDERED footer carries the official session
  // workspace cwd (the footer cwd item's rendered text), so the status facts
  // are proven through the surface, not only through the data-source DTO.
  const app = fixture.runnerApp() as { footerRenderRowsForTest(): readonly string[] }
  await waitFor('rendered footer shows the official cwd', () => {
    return app.footerRenderRowsForTest().join('\n').includes(seedHost.anchorDir)
      || app.footerRenderRowsForTest().join('\n').includes('anchor')
  }, 15_000)
  // The pending-presentation source reads the OFFICIAL echoes: with no
  // submission begun, the official snapshot is EMPTY (an authoritative empty
  // list for the retained session, undefined only for unretained ids).
  const pending = fixture.override.presentation.submissionPresentation.snapshot(mainId)
  assert.ok(pending !== undefined, 'the official pendingSubmissions source serves the retained session')
  assert.equal(pending.length, 0, 'no submission begun ⇒ the official echo list is authoritatively empty')
  assert.equal(fixture.override.presentation.submissionPresentation.snapshot('no-such-session'), undefined)
})

test('a Remote resume and live change follow the effective Host working directory while the creation cwd and Workspace membership stay put', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm6-remote-effective-cwd'
  const hostPreset = 'm6-remote-effective-cwd-preset'
  const host = await mountRemotePresentationHost(life, hostPreset)
  // Three distinct absolute directories inside the ONE fixture private root:
  // A = the Session's immutable creation directory, B = the effective cwd the
  // Runner must first resume into, C = the same Session's later live cwd.
  const creationCwd = join(host.anchorDir, 'cwd-alpha')
  const firstEffectiveCwd = join(host.anchorDir, 'cwd-beta')
  const liveEffectiveCwd = join(host.anchorDir, 'cwd-gamma')
  for (const directory of [creationCwd, firstEffectiveCwd, liveEffectiveCwd]) mkdirSync(directory, { recursive: true })
  const agent = await host.harness.create(SessionId(mainId), undefined, { cwd: creationCwd })
  // The official Workspace MEMBERSHIP is seeded at the creation path A — the
  // effective directory B/C must never replace it.
  const registry = host.ctx.get('workspaceRegistry') as {
    create(path: string): Promise<{
      attachSession(id: unknown): Promise<void>
      readonly sessionIds: readonly unknown[]
    }>
  }
  const workspace = await registry.create(creationCwd)
  await workspace.attachSession(SessionId(mainId))
  // Commit B through the REAL Host working-directory service BEFORE the
  // Remote runner first resumes: the first status/footer/OSC 0 read is the
  // official projection, not a list-row/header re-read at mount time.
  await host.ctx.workingDirectory.set(agent, firstEffectiveCwd)
  assert.equal(agent.session.header.cwd, creationCwd, 'the durable Session header keeps the creation directory A')
  assert.equal(host.ctx.workingDirectory.get(agent.session), firstEffectiveCwd)

  const osc0Frames: string[] = []
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const originalWrite = Object.getOwnPropertyDescriptor(process.stdout, 'write')
  // `setTerminalTitle` writes OSC 0 to process.stdout and is a no-op off a
  // TTY: the capture exists only for this protected window and restores the
  // original descriptors below.
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  Object.defineProperty(process.stdout, 'write', {
    configurable: true,
    value: (data: string | Uint8Array): boolean => {
      if (typeof data === 'string' && data.includes('\x1b]0;')) osc0Frames.push(data)
      return true
    },
  })
  let fixture: Awaited<ReturnType<typeof mountRemoteRunner>> | undefined
  try {
    fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host })
    const mounted = fixture
    const footer = (): string => (mounted.runnerApp() as { footerRenderRowsForTest(): readonly string[] })
      .footerRenderRowsForTest().join('\n')
    const lastOsc0Title = (): string | undefined => {
      const frame = osc0Frames.at(-1)
      if (frame === undefined) return undefined
      return /\x1b\]0;([^\x07]*)\x07/u.exec(frame)?.[1]
    }

    // FIRST REMOTE RESUME: the official `workingDirectory` projection B is the
    // status/footer fact and the session-title-less OSC 0 identity fallback.
    await waitFor('first resume status reports the effective cwd B', () =>
      mounted.override.presentation.sessionFacts.sessionStatus(mainId)?.cwd === firstEffectiveCwd, 20_000)
    await waitFor('first resume footer reports B', () => footer().includes('anchor/cwd-beta'), 20_000)
    await waitFor('first resume OSC 0 fallback is B', () =>
      lastOsc0Title() === 'dsh · anchor/cwd-beta', 20_000)

    // The creation fact and Workspace membership are NOT overwritten at any
    // stage: the official list row still reports A.
    const firstRows = await mounted.aggregate.selected.backend.sessionReader.list(undefined)
    assert.equal(firstRows?.find(row => row.id === mainId)?.cwd, creationCwd,
      'SessionReader.list keeps the creation directory A')
    assert.ok(workspace.sessionIds.map(String).includes(mainId),
      'official Workspace membership still contains the Session at the creation path')

    // An UNRELATED projection (token usage) refreshes the status but must not
    // rewrite OSC 0: only the `workingDirectory` key owns that refresh. The
    // check runs on the settled initial batch (no cwd change is in flight).
    await new Promise<void>(resolve => setImmediate(resolve))
    const osc0BeforeTokenChange = osc0Frames.length
    {
      const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
        append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
      }
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      session.append('assistant/message', {
        turn: 1, step: 1,
        message: {
          id: 'a-token-only', role: 'assistant',
          content: [{ type: 'text', text: 'token projection only' }],
          source: { kind: 'model', provider: 'smoke', model: 'smoke' },
        },
        stream: [], usage: { inputTokens: 10, outputTokens: 5 },
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }
    await waitFor('the unrelated tokenUsage projection landed', () =>
      mounted.override.presentation.sessionFacts.sessionStatus(mainId)?.usage?.outputTokens === 5, 20_000)
    // One event-loop turn flushes the coalesced projection microtask (a
    // microtask is guaranteed to run before a macrotask).
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(osc0Frames.length, osc0BeforeTokenChange,
      'an unrelated tokenUsage/context projection notification never rewrites OSC 0')

    // LIVE CHANGE in the SAME resumed Session: commit C through the real Host
    // service; the official Client projection drives status/footer/OSC 0.
    await host.ctx.workingDirectory.set(agent, liveEffectiveCwd)
    await waitFor('live status reports the effective cwd C', () =>
      mounted.override.presentation.sessionFacts.sessionStatus(mainId)?.cwd === liveEffectiveCwd, 20_000)
    await waitFor('live footer reports C', () => footer().includes('anchor/cwd-gamma'), 20_000)
    await waitFor('live OSC 0 fallback is C', () =>
      lastOsc0Title() === 'dsh · anchor/cwd-gamma', 20_000)
    assert.equal(agent.session.header.cwd, creationCwd, 'the header stays A after the live change')
    assert.equal(host.ctx.workingDirectory.get(agent.session), liveEffectiveCwd)
    const liveRows = await mounted.aggregate.selected.backend.sessionReader.list(undefined)
    assert.equal(liveRows?.find(row => row.id === mainId)?.cwd, creationCwd,
      'the list row stays the creation directory A after the live change')
    assert.ok(workspace.sessionIds.map(String).includes(mainId),
      'Workspace membership is unchanged by the live effective-directory change')
  } finally {
    if (originalWrite === undefined) delete (process.stdout as { write?: unknown }).write
    else Object.defineProperty(process.stdout, 'write', originalWrite)
    if (originalIsTTY === undefined) delete (process.stdout as { isTTY?: unknown }).isTTY
    else Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    await fixture?.dispose()
  }
})

test('live assistant transient output streams through the official eventSource ingress', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-live'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  const agent = await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  // An OPEN turn the live attempt belongs to.
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  await waitFor('transient live text', () => {
    // The live transient text renders before any durable settlement.
    return false
  }, 1).catch(() => {/* seeded below */})
  // Emit REAL Host-side assistant-stream frames: the session-controller
  // history relay forwards them onto the official wire as transient entries.
  const emitLiveStream = (frame: unknown): void => {
    ;(seedHost.ctx as unknown as { emit(name: string, payload: unknown): void }).emit('agent/assistant-stream', { agent, frame })
  }
  emitLiveStream({ type: 'start', attemptId: 'live-1', revision: 1, turn: 1, step: 1 })
  emitLiveStream({ type: 'chunk', attemptId: 'live-1', revision: 2, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: 'streaming remote text' } })
  await waitFor('live chunk painted', () => {
    return fixture.vt.getViewport().join('\n').includes('streaming remote text')
  }, 15_000)
})

test('history paging (loadOlder) extends the loaded window without replacing the subject', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-page'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  // Seed enough turns that the official opening window cannot hold them all.
  for (let turn = 1; turn <= 80; turn++) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', {
      id: `u-${turn}`, role: 'user', content: [{ type: 'text', text: `prompt ${turn}` }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn, step: 1,
      message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
      stream: [], usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  await waitFor('initial window hydration', () => {
    const text = fixture.vt.getViewport().join('\n')
    return text.includes('answer 80') || text.includes('prompt 80')
  }, 20_000)
  // USER-VISIBLE REACHABILITY: the transcript boundary gesture's own seam
  // (the routing-source member `transcriptMoveOlder` falls through to at the
  // loaded floor) drives the official older-page load — the same entry the
  // fullscreen wheel/page gesture invokes, not a direct reader call.
  const app = fixture.runnerApp()
  assert.ok(app !== undefined, 'the mounted TuiApp must exist after startup')
  // Evidence split (plan §13: L5/L6 honesty): THIS test drives the official
  // loader over the real wire (the extension engine). The GESTURE→SEAM chain
  // (PageUp at the loaded floor → surface transcriptMoveOlder fall-through →
  // routing().extendLoadedHistory()) is locked separately over the real
  // TuiApp in test/app/transcript-history-extension.test.ts — driving the
  // virtual window turn-by-turn to its floor inside this L6 mount is
  // impractical, and a half-driven gesture would prove less than the two
  // targeted layers.
  const reader = fixture.override.presentation.presentationReader
  const before = await reader.read(mainId)
  assert.ok(before !== undefined, 'the reader serves the retained session')
  if (before.hasMore) {
    // PR5 (plan §3.2) L6: the truncated window's recent figures are UNKNOWN
    // — the footer's stats line omits TTFB/tok-s (the seed's assistant
    // messages carry no valid samples, so a numeric `TTFB 0s · 0 tok/s`
    // stand-in must NOT paint while hasMore is true).
    const footerOf = (): string => {
      const app = fixture.runnerApp() as unknown as { footerRenderRowsForTest(): readonly string[] }
      return app.footerRenderRowsForTest().join('\n')
    }
    await waitFor('the truncated window omits the recent metrics', () => {
      const footer = footerOf()
      return footer.length > 0 && !footer.includes('TTFB')
    }, 15_000)
    const after = await reader.loadOlder(mainId)
    assert.ok(after !== undefined)
    assert.equal(after.durableEvents.length > before.durableEvents.length, true,
      'the official loadOlder extended the durable window')
    assert.equal(after.coverage, 'bounded')
    assert.equal(after.sessionId, mainId, 'the CURRENT subject is unchanged (no replacement)')
    assert.equal(after.durableEvents[0]!.seq < before.durableEvents[0]!.seq, true,
      'the durable window front extended toward older history')
  }
})

test('the real boundary gesture extends the loaded official history through the mounted surface', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-gesture'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  // A DETERMINISTIC truncating history: 30 short turns (60 messages) — the
  // official opening window pages at the 50-message/2-turn minimum, so the
  // initial load holds only the newest turns and hasMore MUST be true. The
  // virtual window (20 turns live) then reaches its loaded floor after a
  // few PageUps.
  for (let turn = 1; turn <= 30; turn++) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', {
      id: `u-g${turn}`, role: 'user', content: [{ type: 'text', text: `gesture prompt ${turn}` }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn, step: 1,
      message: { id: `a-g${turn}`, role: 'assistant', content: [{ type: 'text', text: `gesture answer ${turn} — history line for turn ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
      stream: [], usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  await waitFor('initial hydration', () => {
    return fixture.vt.getViewport().join('').includes('gesture answer')
  }, 20_000)
  const reader = fixture.override.presentation.presentationReader
  const before = await reader.read(mainId)
  assert.ok(before !== undefined)
  assert.equal(before.hasMore, true,
    'the 30-turn history must truncate the official opening window (a non-truncating window means the fixture stopped proving the paging chain)')
  // Baseline: the OLDEST turn is not yet paintable (its rows are not in the
  // loaded window), so the post-extension observation below proves the
  // extension actually changed what the surface can render.
  assert.equal(fixture.vt.getViewport().join('').includes('gesture prompt 1'), false,
    'the oldest turn must be absent before the boundary gesture (the window truncates)')
  const app = fixture.runnerApp() as unknown as {
    setFullscreen(on: boolean): void
    scrollToTop(options?: { disableFollow?: boolean }): void
  }
  // The REAL user gesture: fullscreen + scroll toward the loaded floor,
  // PageUp-ing until the floor is reached (the virtual window pages in
  // steps; the fall-through fires at the loaded floor).
  app.setFullscreen(true)
  await new Promise(resolve => setTimeout(resolve, 50))
  const started = Date.now()
  for (;;) {
    const after = await reader.read(mainId)
    if (after !== undefined && after.durableEvents.length > before.durableEvents.length) break
    if (Date.now() - started > 15_000) throw new Error('the boundary gesture did not extend the loaded official history')
    app.scrollToTop({ disableFollow: true })
    await new Promise(resolve => setTimeout(resolve, 30))
    fixture.vt.sendInput('\x1b[57421u') // PageUp at the top = the older boundary gesture
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  const after = await reader.read(mainId)
  assert.ok(after !== undefined)
  assert.equal(after.sessionId, mainId, 'the CURRENT subject is unchanged (no replacement)')
  assert.equal(after.durableEvents[0]!.seq < before.durableEvents[0]!.seq, true,
    'the loaded window front extended toward older official history')
  // The USER-VISIBLE outcome: a newly loaded OLDER row is actually paintable
  // through the re-hydrated presentation (the viewport is at the history
  // floor; scroll within the loaded transcript until an oldest row shows).
  await waitFor('oldest row paintable', () => {
    const text = fixture.vt.getViewport().join('\n')
    return text.includes('gesture prompt 1') || text.includes('gesture answer 1')
  }, 15_000)
})

test('accepted-only: a registered submission is invisible until Host acceptance, then joins by requestId', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-pending'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  // The agent needs its route, else the accepted turn errors before the
  // durable user message exists (and the test would time out for the wrong
  // reason).
  await seedHost.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' } as never, { cwd: seedHost.anchorDir })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  const app = await waitForApp(fixture)
  // Baseline: the join renders nothing pending.
  assert.deepEqual(app.pendingInputForTest().queued, [])
  assert.deepEqual(app.pendingInputForTest().tail, [])
  const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId) as never) as {
    session: {
      getSnapshot(): { readonly pendingSubmissions: readonly { readonly requestId: string }[] }
      beginSubmission(input: {
        readonly mode: 'queue' | 'steer'
        readonly text: string
        readonly attachments: readonly []
        readonly onAccept?: () => void
      }): { readonly requestId: string }
      prompt(
        content: readonly { readonly type: 'text'; readonly text: string }[],
        mode: 'queue' | 'steer',
        signal?: AbortSignal,
        requestId?: string,
      ): Promise<{ readonly ok: boolean }>
    }
  } | undefined
  assert.ok(binding !== undefined, 'the retained binding serves the official beginSubmission/prompt faces')

  // 1. REGISTER ONLY. rc.1 publishes a submission echo only after Host
  //    acceptance, so the pre-accept snapshot and the product join stay empty.
  const text = 'accepted-only submission drives the pane'
  let accepts = 0
  let acceptedSnapshot: { readonly pendingSubmissions: readonly { readonly requestId: string }[] } | undefined
  const submission = binding.session.beginSubmission({
    mode: 'queue',
    text,
    attachments: [],
    onAccept: () => {
      accepts += 1
      acceptedSnapshot = binding.session.getSnapshot()
    },
  })
  assert.equal(accepts, 0, 'registration alone never claims acceptance')
  assert.equal(binding.session.getSnapshot().pendingSubmissions.some(entry => entry.requestId === submission.requestId), false,
    'the official snapshot must not publish an unaccepted submission')
  assert.equal(
    (fixture.override.presentation.submissionPresentation.snapshot(mainId) ?? [])
      .some(entry => entry.requestId === submission.requestId),
    false,
    'the product pending source projects no unaccepted submission',
  )
  assert.deepEqual(app.pendingInputForTest().queued, [], 'no unaccepted echo may appear in the queue pane')
  assert.deepEqual(app.pendingInputForTest().tail, [], 'no unaccepted echo may appear in the tail lane')

  // 2. The IDENTIFIED prompt carries the registered requestId. Acceptance
  //    fires onAccept exactly once and publishes the echo in the SAME update;
  //    the idle prompt may reach durable admission immediately, so no fixed
  //    transient echo window is assumed.
  const accepted = await binding.session.prompt([{ type: 'text', text }], 'queue', undefined, submission.requestId)
  assert.equal(accepted.ok, true, 'the identified Host prompt must be accepted')
  assert.equal(accepts, 1, 'onAccept fires exactly once')
  assert.ok(acceptedSnapshot !== undefined, 'onAccept observes the accepted snapshot synchronously')
  assert.ok(acceptedSnapshot.pendingSubmissions.some(entry => entry.requestId === submission.requestId),
    'the accepted snapshot already publishes the submission echo')

  // 3. DURABLE correlation: exactly ONE Host user/message carries the SAME
  //    requestId, and its content is the submitted text.
  type HostUserMessage = {
    readonly source: { readonly kind?: string; readonly rpcId?: unknown }
    readonly content: readonly { readonly type?: string; readonly text?: string }[]
  }
  const hostUserMessages = (): readonly HostUserMessage[] => {
    const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): ReadonlyArray<{ type: string; data: unknown }>
    }
    return session.snapshotEvents()
      .filter(event => event.type === 'user/message')
      .map(event => event.data as HostUserMessage)
      .filter(message => message.source.kind === 'user')
  }
  await waitFor('the identified Host user message is durable', () =>
    hostUserMessages().some(message => message.source.rpcId === submission.requestId), 20_000)
  const identified = hostUserMessages().filter(message => message.source.rpcId === submission.requestId)
  assert.equal(identified.length, 1, 'exactly one durable message carries the submission requestId')
  assert.equal(identified[0]!.content.filter(part => part.type === 'text').map(part => part.text).join(''), text,
    'the durable message content is the submitted text')
  await waitFor('the durable row is painted', () => fixture.vt.getViewport().join('\n').includes(text), 20_000)
  assert.equal(fixture.vt.getViewport().join('\n').split('\n').filter(line => line.includes(text)).length, 1,
    'the user text appears exactly once (never a pending echo plus its durable replacement)')

  // 4. A TRULY failed identified prompt manufactures no committed/durable
  //    display: the Host refuses empty content, the official Client retires the
  //    echo and onAccept never fires.
  const durableBefore = hostUserMessages().length
  let failedAccepts = 0
  const failed = binding.session.beginSubmission({
    mode: 'queue',
    text: '   ',
    attachments: [],
    onAccept: () => { failedAccepts += 1 },
  })
  const rejected = await binding.session.prompt([{ type: 'text', text: '   ' }], 'queue', undefined, failed.requestId)
  assert.equal(rejected.ok, false, 'the Host must refuse an empty prompt')
  assert.equal(failedAccepts, 0, 'a rejected prompt never fires onAccept')
  assert.equal(binding.session.getSnapshot().pendingSubmissions.some(entry => entry.requestId === failed.requestId), false,
    'a rejected prompt never publishes an accepted echo')
  assert.equal(hostUserMessages().length, durableBefore, 'a rejected prompt commits no durable message')
})

test('an external inbox projection update re-joins the queue pane without a durable session event', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-inbox-face'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  // The Agent route is required for the PRIMING turn to reach the adapter.
  await seedHost.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke-model' } as never, { cwd: seedHost.anchorDir })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  const app = await waitForApp(fixture)
  const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId) as never) as {
    session: {
      getSnapshot(): { readonly running: boolean }
      prompt(content: readonly { readonly type: 'text'; readonly text: string }[], mode: 'queue' | 'steer'): Promise<unknown>
      readonly projections: {
        apply(key: string, value: unknown, seq: number): void
        seqOf(key: string): number | undefined
        faceOf(key: string): { getSnapshot(): unknown }
      }
    }
  } | undefined
  assert.ok(binding !== undefined, 'the retained binding serves the official inbox projection face')
  // Readiness gate: a REAL primed turn must be PAINTED through the live
  // ingress. That proves the per-session projection faces are subscribed
  // before the projection-only change below (the ingress installs them).
  await binding.session.prompt([{ type: 'text', text: 'prime the live ingress' }], 'queue')
  await waitFor('the live ingress paints the real answer', () => {
    return fixture.vt.getViewport().join('\n').includes('remote reply')
  }, 20_000)
  // The Host inbox has drained and the projection caught up: no late frame can
  // overwrite the injected value below (the session is idle and has no pending
  // input, so no further inbox mutation is produced).
  await waitFor('the primed turn settled and the Host inbox drained', () => {
    if (binding.session.getSnapshot().running) return false
    const inbox = binding.session.projections.faceOf('inbox').getSnapshot() as {
      readonly 'next-turn': readonly unknown[]
      readonly 'next-step': readonly unknown[]
    } | undefined
    return inbox !== undefined && inbox['next-turn'].length === 0 && inbox['next-step'].length === 0
  }, 20_000)
  assert.deepEqual(app.pendingInputForTest().queued, [], 'the primed turn leaves no queued row')
  assert.deepEqual(app.pendingInputForTest().tail, [], 'the primed turn leaves no tail row')
  // The OFFICIAL Host frame path for ANOTHER Client's mutation: the whole
  // inbox projection value is delivered to the retained Client store. No
  // durable `agent/inbox/spliced` event, no local echo, no keyboard input —
  // the projection notification is the ONLY possible trigger.
  const occurrence = {
    id: 'm3-4-pr2-external-inbox',
    role: 'user',
    content: [{ type: 'text', text: 'queued by another client' }],
    source: { kind: 'user', rpcId: 'm3-4-pr2-external-rpc' },
  }
  binding.session.projections.apply('inbox', {
    'next-turn': [occurrence],
    'next-step': [],
  }, (binding.session.projections.seqOf('inbox') ?? 0) + 1)
  await waitFor('the external inbox occurrence joins the queue pane', () => {
    return app.pendingInputForTest().queued.some(row => row.text === 'queued by another client')
  }, 15_000)
  assert.equal(
    app.pendingInputForTest().tail.some(row => row.row?.text === 'queued by another client'),
    false,
    'a queued occurrence never rides the transcript tail lane',
  )
  // The occurrence exists ONLY in the projection: the durable Host window has
  // no matching user message (a projection frame is the sole trigger).
  const read = await fixture.override.presentation.presentationReader.read(mainId)
  assert.ok(read !== undefined, 'the presentation reader serves the retained session')
  assert.equal(JSON.stringify(read.durableEvents).includes('queued by another client'), false,
    'the projection-only occurrence must not appear as a durable Host event')
})

async function waitForApp(fixture: RemoteRunnerFixture): Promise<{
  pendingInputForTest(): {
    queued: Array<{ text?: string }>
    tail: Array<{ kind: 'user' | 'context'; row?: { text?: string; status?: 'steering' | 'sending' } }>
  }
}> {
  for (let i = 0; i < 600; i++) {
    const app = fixture.runnerApp() as { pendingInputForTest?: () => unknown } | undefined
    if (app !== undefined && typeof app.pendingInputForTest === 'function') {
      return app as never
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the mounted TuiApp never exposed pendingInputForTest')
}

test('an edit tool card renders from RAW durable call/result facts (no Host presenter)', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-toolcard'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const appendOf = (id: string) => seedHost.ctx.sessions.get(SessionId(id)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  // Three plain turns through the file's OWN proven seeding helper, then a
  // fourth turn carrying the edit tool call/result — the card must be
  // derived by the CLIENT presenter from those raw facts (the Remote branch
  // never consults the Host tool registry).
  seedTurns(appendOf(mainId), 1, 3, 'card')
  const session = appendOf(mainId)
  session.append('turn/start', { turn: 4 })
  session.append('step/start', { turn: 4, step: 1 })
  session.append('user/message', {
    id: 'u-toolcard', role: 'user', content: [{ type: 'text', text: 'please edit the file' }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('tool/call', {
    turn: 4, step: 1, callId: 'call-toolcard', name: 'edit',
    arguments: JSON.stringify({ path: 'src/toolcard-target.ts', old_string: 'before', new_string: 'after' }),
  })
  session.append('tool/result', {
    turn: 4, step: 1,
    // The OFFICIAL durable tool-result message (its `source.callId` is the
    // pairing the client session ingest reads — a hand-rolled `toolCallId`
    // field fails the official invariant and kills the session window).
    message: createToolResultMessage({
      callId: ToolCallId('call-toolcard'),
      content: [{ type: 'text', text: 'updated' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 4, step: 1,
    message: { id: 'a-toolcard', role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
    stream: [], usage: { inputTokens: 1, outputTokens: 1 },
  }, { surfaceOp: 'append' })
  // A SECOND tool call in the same turn: an UNKNOWN/custom tool. Its card
  // must use the bounded generic fallback (name + raw args), never nothing.
  session.append('tool/call', {
    turn: 4, step: 1, callId: 'call-custom', name: 'pr4_custom_tool',
    arguments: JSON.stringify({ marker: 'CUSTOM-ARGS-MARKER' }),
  })
  session.append('tool/result', {
    turn: 4, step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('call-custom'),
      content: [{ type: 'text', text: 'CUSTOM-RESULT-MARKER' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 4, step: 1 })
  session.append('turn/end', { turn: 4, reason: { kind: 'completed' } })

  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  const app = await waitForApp(fixture)
  assert.ok(app instanceof TuiApp)
  // This case verifies individual card bodies, not Work disclosure.
  app.setDisplayPreset('full')
  // The transcript renders (the proven baseline) …
  // The transcript renders (the proven baseline) …
  await waitFor('the seeded conversation rendered', () =>
    fixture.vt.getViewport().join('').includes('card answer 3'), 20_000)
  // … and the edit card contributes the raw-fact path.
  await waitFor('the edit card rendered with its raw-fact path', () =>
    fixture.vt.getViewport().join('').includes('toolcard-target.ts'), 20_000)
  const view = fixture.vt.getViewport().join('')
  assert.ok(/Edit|edit/u.test(view),
    'the Client presenter derived the edit card header from the raw call arguments')
  assert.equal(view.includes('updated'), true,
    'the settled result text rendered through the existing Client result derivations')
  // The unknown/custom tool keeps its bounded generic card: the name and its
  // raw argument marker are visible (never a silent drop, never a Host lookup).
  assert.equal(view.includes('pr4_custom_tool'), true,
    'the unknown tool name renders through the bounded generic fallback')
  assert.equal(view.includes('CUSTOM-ARGS-MARKER'), true,
    'the bounded raw args render for an unknown tool')
  assert.equal(view.includes('CUSTOM-RESULT-MARKER'), true,
    'the settled result text renders for an unknown tool')
})

test('the Remote branch derives sandbox/approval from the EXACT Session policy and still omits a projection-less preset (M6-1 F8)', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-access'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  // The AGENTLESS sandbox default (the retired §6.6 hole) answers a different
  // mode: an F8 read passes the exact live Session, so this default must never
  // reach the footer. The fixture mounts the official `sandboxPolicy` service,
  // so the discrimination is a patched resolve that special-cases a missing
  // request — never a second service.
  const sandbox = seedHost.ctx.get('sandboxPolicy') as unknown as {
    resolve(request?: { readonly session?: unknown }): { readonly mode: string }
  }
  const originalResolve = sandbox.resolve.bind(sandbox)
  sandbox.resolve = request => (request?.session === undefined ? { mode: 'danger-full-access' } : originalResolve(request))
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  const app = await waitForApp(fixture)
  // The committed STATUS projection is what every access-rendering item reads
  // (permission-preset / sandbox-mode / approval-policy).
  const accessOf = (): unknown => (app as unknown as {
    statusStore: { snapshot(): { access?: { sandbox?: { mode?: string }; permissionPreset?: unknown; approval?: unknown } } }
  }).statusStore.snapshot().access
  // The policy read is an async authoritative read: wait for its commit.
  await waitFor('the observed sandbox fact rendered on Remote', () => accessOf() !== undefined
    && (accessOf() as { sandbox?: unknown }).sandbox !== undefined, 20_000)
  const access = accessOf() as { sandbox?: { mode?: string }; permissionPreset?: unknown; approval?: unknown } | undefined
  const session = seedHost.ctx.sessions.get(SessionId(mainId))
  assert.equal(access?.sandbox?.mode, originalResolve({ session }).mode,
    'the Remote sandbox fact is the SESSION-scoped policy')
  assert.notEqual(access?.sandbox?.mode, 'danger-full-access',
    'the agentless sandbox default never stands in for the exact Session policy')
  // The permission PRESET still needs the official projection: with none, the
  // preset row stays omitted (a projection-less window is not "no permission").
  assert.equal(access?.permissionPreset, undefined)
  // This fixture mounts no approval service: that side is a definite
  // unavailable fact and stays absent, never a guessed `ask`.
  assert.equal(access?.approval, undefined)
})

test('current-value facts whose SOURCE EVENTS precede the bounded window still render (title/goal/lifetime usage)', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-outside-window'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  // The facts whose SOURCE events sit at the very START of a long session: the
  // official title and an active goal. The official opening window pages at
  // >=2 turn starts, so a 30-turn session truncates and NEITHER event is inside
  // the window — only the projections can render them.
  session.append('session/title', { title: 'the long session title' })
  const goalChangeVersion = (await import('@deepseek-ai/dsh-goal')).GOAL_CHANGE_VERSION
  session.append('goal/change', {
    kind: 'goal/change',
    version: goalChangeVersion,
    operation: 'create',
    goal: { id: 'g-1', revision: 1, objective: 'land the outside-window fact', phase: 'active', maxGoalRounds: 5 },
    roundsStarted: 0,
    createdAt: 1,
    updatedAt: 1,
  })
  for (let turn = 1; turn <= 30; turn++) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', {
      id: `u-${turn}`, role: 'user', content: [{ type: 'text', text: `outside prompt ${turn}` }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn, step: 1,
      message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text: `outside answer ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
      stream: [], usage: { inputTokens: 3, outputTokens: 2 },
    }, { surfaceOp: 'append' })
    if (turn === 30) {
      // The STANDING todo list belongs to the LAST turn. The official window
      // always contains the last two turns (its paging rule), so this part is
      // a rendering check of the projection path, NOT a window-divergence
      // proof: the list is legitimately cleared by the NEXT turn/start, so it
      // can never be older than the window.
      session.append('todo/write', { todos: [{ content: 'standing todo', status: 'in_progress' }] })
    }
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  await waitFor('resume hydration', () => {
    return fixture.vt.getViewport().join('').includes('outside answer')
  }, 20_000)
  const reader = fixture.override.presentation.presentationReader
  const openStarted = Date.now()
  for (;;) {
    const probe = await reader.read(mainId)
    if (probe?.openState === 'open') break
    if (Date.now() - openStarted > 15_000) throw new Error(`the official window never opened (openState ${probe?.openState})`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const window = await reader.read(mainId)
  assert.ok(window !== undefined)
  assert.equal(window.hasMore, true,
    'the opening window must be TRUNCATED for this proof (otherwise the fold could see the facts)')
  const firstSeq = window.durableEvents[0]!.seq
  assert.equal(firstSeq > 2, true, `the window must start after the seeded facts (first seq ${firstSeq})`)
  assert.equal(
    window.durableEvents.some(event => event.type === 'session/title'),
    false,
    'the title event is OUTSIDE the window: only the projection can supply it',
  )

  const app = fixture.runnerApp() as unknown as {
    getSessionTitle(): string
    statusStore: { snapshot(): { usage?: { tokens?: { input?: number; output?: number } }; goal?: string } }
  }
  await waitFor('official current facts painted', () => {
    return app.getSessionTitle().includes('the long session title')
  }, 15_000)
  assert.equal(app.getSessionTitle().includes('the long session title'), true,
    'the OFFICIAL title projection renders even though its event precedes the window')
  // Lifetime usage from the official tokenUsage projection (30 x 3 / 30 x 2),
  // never the truncated window's partial fold (the window holds ~15 turns).
  const status = app.statusStore.snapshot()
  assert.equal(status.usage?.tokens?.input, 90,
    'lifetime input tokens come from the official tokenUsage projection (30 x 3), not the window fold')
  assert.equal(status.usage?.tokens?.output, 60,
    'lifetime output tokens come from the official tokenUsage projection (30 x 2)')
  const viewport = fixture.vt.getViewport().join('\n')
  assert.equal(status.goal?.includes('land the outside') === true || viewport.includes('land the outside'), true,
    'the official goal projection renders (goal badge)')
  assert.equal(viewport.includes('standing todo'), true,
    'the standing todo list renders (the projection path feeds the dock summary)')
})

/** Seed N short completed turns on a Host session (transcript rows). */
function seedTurns(
  session: { append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void },
  from: number,
  to: number,
  label: string,
): void {
  for (let turn = from; turn <= to; turn++) {
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', {
      id: `u-${label}-${turn}`, role: 'user', content: [{ type: 'text', text: `${label} prompt ${turn}` }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn, step: 1,
      message: { id: `a-${label}-${turn}`, role: 'assistant', content: [{ type: 'text', text: `${label} answer ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
      stream: [], usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
}

test('a failed/fence-dropped hydrate under a LIVE generation retries once (behavioral witness)', async (t) => {
  // RFL-002 behavioral seam — the IMMEDIATE retry branch, not the
  // transport-absent listener: the official Connection generation IS live here
  // (the fixture's wire is mounted), the FIRST cold read answers undefined, so
  // `initLiveRemoteSession` returns undefined and the composition root's
  // identity-change retry runs once under that generation. The separate
  // transport-absent `armRemoteInitRetry` channel listener is covered by its
  // source lock only, and the same-id owner-commit cancellation of an armed
  // listener is static fence review — neither is exercised here.
  const life = testLifecycle(t)
  const presetId = 'm3-4-pr2-preset'
  const sessionId = 'm3-4-pr2-s3r0-retry'
  const host = await mountRemotePresentationHost(life, presetId)
  await host.harness.create(SessionId(sessionId), undefined, { cwd: host.anchorDir })
  const append = host.ctx.sessions.get(SessionId(sessionId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  seedTurns(append, 1, 1, 'retry')
  let failFirstRead = true
  let liveSubscriptions = 0
  const fixture = await mountRemoteRunner(life, {
    presetId,
    resumeSessionId: sessionId,
    host,
    beforeRunnerMount: (presentation) => {
      // Count the LIVE ingress subscriptions this composition installs.
      const ingress = presentation.liveIngress as unknown as {
        subscribe: (...args: never[]) => unknown
      }
      const realSubscribe = ingress.subscribe
      ingress.subscribe = function countedSubscribe(this: unknown, ...args: never[]) {
        liveSubscriptions += 1
        return (realSubscribe as (...a: never[]) => unknown).apply(this, args)
      }
      life.defer(() => { ingress.subscribe = realSubscribe })
      // The first cold read deliberately returns undefined at the reader
      // boundary (no real transport fence is triggered here) while the Connection
      // generation REMAINS live: the identity-change retry branch.
      const reader = presentation.presentationReader as unknown as {
        read: (id: string, signal?: AbortSignal) => Promise<unknown>
      }
      const realRead = reader.read
      reader.read = function failingOnce(this: unknown, id: string, signal?: AbortSignal) {
        if (failFirstRead) {
          failFirstRead = false
          return Promise.resolve(undefined)
        }
        return realRead.call(this, id, signal)
      }
      life.defer(() => { reader.read = realRead })
    },
  })
  await waitFor('the recovered transcript is painted', () => fixture.vt.getViewport().join('').includes('retry answer 1'), 20_000)
  assert.equal(failFirstRead, false, 'the first hydrate really failed (the identity-change retry ran)')
  assert.equal(liveSubscriptions, 1,
    'exactly ONE ingress subscription exists after the retry (the failed attempt installed none)')
  fixture.dispose()
})

test('navigation: switch, same-id rollover and reconnect re-init the presentation without leaking the old subject', async (t) => {
  const life = testLifecycle(t)
  const sessionA = 'm3-4-pr2-nav-a'
  const sessionB = 'm3-4-pr2-nav-b'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(sessionA), undefined, { cwd: seedHost.anchorDir })
  await seedHost.harness.create(SessionId(sessionB), undefined, { cwd: seedHost.anchorDir })
  const appendOf = (id: string) => seedHost.ctx.sessions.get(SessionId(id)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  seedTurns(appendOf(sessionA), 1, 3, 'alpha')
  seedTurns(appendOf(sessionB), 1, 3, 'beta')
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: sessionA, host: seedHost })
  const app = await waitForApp(fixture) as unknown as { footerRenderRowsForTest(): readonly string[] }
  const viewport = (): string => fixture.vt.getViewport().join('\n')
  await waitFor('session A hydrated', () => viewport().includes('alpha answer 3'), 20_000)
  assert.equal(viewport().includes('beta answer 3'), false, 'session B is not mounted yet')
  const bindingOf = (id: string): unknown =>
    fixture.aggregate.wire.client.sessions.binding(SessionId(id))
  const bindingAFirst = bindingOf(sessionA)
  assert.ok(bindingAFirst !== undefined, 'A is retained while it is the current subject')

  // PR4 §1.2: the TUI no longer registers its callbacks into the Host
  // commands service on the Remote branch, so /resume and /fork are driven
  // the way a real user drives them — a submit gesture through the MOUNTED
  // surface (the Client command registry executes the TUI built-in).
  const execute = (line: string): void => {
    const mounted = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void }
    mounted.setDraft(line)
    mounted.submitDraft()
  }

  // ── SWITCH A -> B: the same transition seam /resume uses.
  await execute(`/resume ${sessionB}`)
  await waitFor('session B hydrated', () => viewport().includes('beta answer 3'), 20_000)
  await waitFor('session A rows retired', () => viewport().includes('alpha answer 3') === false, 10_000)
  assert.equal(viewport().includes('alpha answer 3'), false,
    'the replaced subject must not leak its transcript rows into the new one')

  // ── SAME-ID ROLLOVER B: away and back — the same id, a NEW binding OBJECT.
  // The identity claim is asserted on the official binding, never inferred from
  // the test's own steps: the binding captured while A was current must be a
  // DIFFERENT object when the same id is retained again.
  await execute(`/resume ${sessionA}`)
  await waitFor('session A re-hydrated', () => viewport().includes('alpha answer 3'), 20_000)
  assert.equal(viewport().includes('beta answer 3'), false, 'B rows retired after the rollover back to A')
  const bindingASecond = bindingOf(sessionA)
  assert.ok(bindingASecond !== undefined, 'A is retained again after the rollover')
  assert.notStrictEqual(bindingASecond, bindingAFirst,
    'the same session id must come back as a REPLACED exact binding object (the identity the fences key on)')
  // A duplicate render would double the rendered row count for the last turn.
  const rowsForLastTurn = viewport().split('\n').filter(line => line.includes('alpha answer 3')).length
  assert.equal(rowsForLastTurn, 1, 'exactly ONE row for the last turn (no stale/duplicate frame)')

  // ── RECONNECT: NOT "the old screen stayed". The new facts are committed
  // SYNCHRONOUSLY after `reconnect()` aborted the previous generation and
  // before the next one can attach, so the dead generation could not have
  // delivered them: only the NEW generation's authoritative baseline (its
  // durable window AND its projection values) can put them on screen.
  const connection = fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const generationBefore = connection.generation.getSnapshot()?.id
  connection.reconnect()
  seedTurns(appendOf(sessionA), 4, 4, 'offline')
  appendOf(sessionA).append('model/selection', { provider: 'smoke', model: 'offline-model' })
  assert.equal(viewport().includes('offline answer 4'), false,
    'the aborted generation never delivered the new turn')
  await waitFor('reconnected on a NEW generation', () => {
    const id = connection.generation.getSnapshot()?.id
    return id !== undefined && id !== generationBefore
  }, 20_000)
  await waitFor('the authoritative baseline re-hydrated', () => viewport().includes('offline answer 4'), 20_000)
  assert.equal(viewport().includes('offline answer 4'), true,
    'the reconnect re-hydrated the new authoritative baseline (not a stale frame that merely survived)')
  assert.equal(viewport().includes('beta answer 3'), false, 'no other subject appears after the reconnect')
  await waitFor('the new generation projection value landed', () => {
    return (app as unknown as {
      statusStore: { snapshot(): { composition?: { model?: { id?: string } } } }
    }).statusStore.snapshot().composition?.model?.id === 'offline-model'
  }, 20_000)
  // History PR2-C supersedes the PR2-A process-global recall claim: the recall
  // list is now scoped to the current carrier+Session (proved by the dedicated
  // recall cases above), so this navigation case asserts only presentation.

  // ── /fork: the Host forks the current session at its latest completed
  // prefix and the TUI ADOPTS the child. The inherited prefix alone cannot
  // prove adoption, so the child is identified from the Host list and then
  // discriminated by a turn committed ONLY to the child (and a parent-only
  // turn that must NOT appear).
  const hostIdsBefore = new Set(seedHost.ctx.sessions.list().map(session => String(session.id)))
  await execute('/fork')
  await waitFor('a new Host session appeared', () => {
    return seedHost.ctx.sessions.list().some(session => !hostIdsBefore.has(String(session.id)))
  }, 20_000)
  const childId = seedHost.ctx.sessions.list()
    .map(session => String(session.id))
    .find(id => !hostIdsBefore.has(id))
  assert.ok(childId !== undefined, 'the fork created a child session')
  assert.notEqual(childId, sessionA, 'the child is a DIFFERENT session')
  const childHeader = (seedHost.ctx.sessions.get(SessionId(childId!)) as unknown as {
    header: { readonly parentSession?: string; readonly isSeeded?: boolean }
  }).header
  assert.equal(childHeader.parentSession, undefined,
    'rc.1 ordinary fork children are independent Sessions with no parent lineage')
  assert.equal(childHeader.isSeeded, true, 'the fork child must be seeded')
  assert.ok(bindingOf(childId!) !== undefined, 'the Client retained the adopted child')
  await waitFor('forked child hydrated', () => viewport().includes('alpha answer 3'), 20_000)
  assert.equal(viewport().includes('beta answer 3'), false,
    'the forked child carries only its own inherited prefix')
  assert.equal(viewport().split('\n').filter(line => line.includes('alpha answer 3')).length, 1,
    'the adoption paints the inherited rows exactly once')
  // The discriminator: a child-only turn must appear, and a parent-only turn
  // must NOT (a surface stuck on the parent would show the opposite).
  seedTurns(appendOf(childId!), 90, 90, 'child')
  await waitFor('the child-only turn painted', () => viewport().includes('child answer 90'), 20_000)
  seedTurns(appendOf(sessionA), 91, 91, 'parent')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(viewport().includes('child answer 90'), true,
    'the presentation belongs to the ADOPTED CHILD (its own turn is live)')
  assert.equal(viewport().includes('parent answer 91'), false,
    'a turn committed to the PARENT must not reach the adopted child surface')

  // ── /new: a fresh Remote session (the semantic lifecycle create); the
  // surface re-initializes onto the new subject with no rows carried over.
  await execute('/new')
  await waitFor('new session surface', () => viewport().includes('alpha answer 3') === false, 20_000)
  assert.equal(viewport().includes('alpha answer 3'), false, 'the previous subject retires on /new')
  assert.equal(viewport().includes('beta answer 3'), false, 'and no older subject reappears')
  void app
})

test('a real Remote /new leaves the running old turn alive while it commits the fresh Session', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'm3-4-pr2-preset'
  const mainId = 'm3-4-pr2-navigation-detach'
  const adapter = new StubStreamingLlmAdapter()
  const seedHost = await mountRemotePresentationHost(life, presetId, { llmAdapter: adapter })
  await seedHost.harness.create(
    SessionId(mainId),
    { provider: 'smoke', model: 'smoke-model' } as never,
    { cwd: seedHost.anchorDir },
  )
  const fixture = await mountRemoteRunner(life, { presetId, resumeSessionId: mainId, host: seedHost })
  const app = await waitForApp(fixture)
  const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId)) as unknown as {
    session: {
      getSnapshot(): { readonly running: boolean }
      prompt(
        content: readonly { readonly type: 'text'; readonly text: string }[],
        mode: 'queue' | 'steer',
        signal?: AbortSignal,
        requestId?: unknown,
      ): Promise<unknown>
    }
  }
  assert.ok(binding !== undefined, 'the resumed session is retained through the official Client')
  // Hold a REAL Host turn open. Only a cancellation can end it: the release is
  // registered for teardown and is never called by the assertion path.
  const release = adapter.hold()
  life.defer(release)
  await binding.session.prompt([{ type: 'text', text: 'hold the old turn open' }], 'queue')
  await waitFor('the old Host turn running', () => binding.session.getSnapshot().running, 20_000)
  const agents = seedHost.ctx.get('agents') as unknown as {
    get(id: SessionId): { readonly status: string } | undefined
  }
  const oldAgent = agents.get(SessionId(mainId))
  assert.ok(oldAgent !== undefined, 'the old Host Agent is live')
  assert.equal(oldAgent.status, 'running')
  const oldSession = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): readonly { type: string; data?: unknown }[]
  }
  // Wait for the real STEP and, decisively, for the MODEL REQUEST itself to
  // enter the held gate: `step/start` can be appended before the request is
  // issued, so only the adapter's own counter proves the held-model case. The
  // hold is never released by the assertions.
  await waitFor('the old Host step started', () => {
    return oldSession.snapshotEvents().some(event => event.type === 'step/start')
  }, 20_000)
  await waitFor('the held model request entered its gate', () => adapter.heldStreamCount >= 1, 20_000)
  const hostIdsBefore = new Set(seedHost.ctx.sessions.list().map(session => String(session.id)))

  // The REAL user gesture: a /new typed into the mounted Remote composer.
  const retainCount = (): number =>
    fixture.aggregate.wire.client.sessions.retainInfo(SessionId(mainId)).getSnapshot().referenceCount
  const refsBefore = retainCount()
  const mounted = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void }
  mounted.setDraft('/new')
  mounted.submitDraft()

  // 1. Exactly ONE fresh Host Session is created and becomes the current Remote
  //    owner: the /new transaction COMMITTED while the old Turn was still held.
  await waitFor('exactly one fresh Host session', () => {
    return seedHost.ctx.sessions.list().filter(session => !hostIdsBefore.has(String(session.id))).length === 1
  }, 20_000)
  const createdIds = seedHost.ctx.sessions.list()
    .map(session => String(session.id))
    .filter(id => !hostIdsBefore.has(id))
  assert.equal(createdIds.length, 1, 'one /new creates exactly one fresh Session')
  const freshId = createdIds[0]!
  await waitFor('the fresh Remote owner is retained', () => {
    return fixture.aggregate.wire.client.sessions.binding(SessionId(freshId)) !== undefined
  }, 20_000)

  // 2. The navigation left the old Host Turn RUNNING: no Host cancel was
  //    dispatched. The no-cancel proof is the AGENT STATE plus the durable log:
  //    the old Agent still reports `running` after the fresh owner committed,
  //    and the old Session carries no `turn/end` at all — only a cancellation
  //    could have ended the held step (this test never releases the hold).
  //    The adapter counter is cumulative, so it only proves WHICH model
  //    request was held before the navigation; it is not a live-state probe.
  assert.equal(oldAgent.status, 'running', 'the old Host Agent kept running across the navigation')
  assert.ok(adapter.heldStreamCount >= 1, 'the held model request had entered its gate before the navigation')
  assert.equal(oldSession.snapshotEvents().some(event => event.type === 'turn/end'), false,
    'the old Turn wrote no durable end: the navigation must not cancel it')
  assert.ok(oldSession.snapshotEvents().some(event => event.type === 'step/start'),
    'the held step is the model request the navigation left alone')

  // 3. The Client detached from the old owner: its reference count dropped and
  //    the surface re-initialized onto the fresh Session, while the old
  //    Session stays persisted.
  await waitFor('the navigation released the old Client reference', () => retainCount() < refsBefore, 20_000)
  await waitFor('the fresh Session owns the surface', () => {
    return !fixture.vt.getViewport().join('\n').includes('hold the old turn open')
  }, 20_000)
  assert.ok(seedHost.ctx.sessions.list().some(session => String(session.id) === mainId),
    'the old Session remains persisted (a Client detach is not a delete)')
  void app
})

test('explicit Remote New dispatches one Host create and keeps the current exact blank binding', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'rbs-1-same-binding-preset'
  const sessionId = 'rbs-1-same-binding-blank'
  const host = await mountRemotePresentationHost(life, presetId)
  await host.harness.create(SessionId(sessionId), { provider: 'smoke', model: 'smoke-model' } as never, { cwd: host.anchorDir })
  const registry = host.ctx.get('workspaceRegistry') as unknown as {
    create(path: string): Promise<{ attachSession(id: unknown): Promise<void> }>
  }
  const workspace = await registry.create(host.anchorDir)
  await workspace.attachSession(SessionId(sessionId))
  const listEntered = testGate()
  const listRelease = testGate()
  life.defer(listRelease.open)
  let holdList = false
  observeSharedFetch(life, async (pathname, response) => {
    if (holdList && pathname.endsWith('/session/list')) {
      holdList = false
      listEntered.open()
      await listRelease.promise
    }
    return response
  })
  const fixture = await mountRemoteRunner(life, { presetId, resumeSessionId: sessionId, host, productionSerializer: true })
  const sessions = fixture.aggregate.wire.client.sessions
  const bindingBefore = sessions.binding(SessionId(sessionId))
  assert.ok(bindingBefore !== undefined, 'the current blank Session has one official exact binding')
  const refsBefore = sessions.retainInfo(SessionId(sessionId)).getSnapshot().referenceCount
  const calls = countOfficialSessionCalls(life, fixture)
  const reader = fixture.override.presentation.presentationReader as unknown as {
    read(id: string, signal?: AbortSignal): Promise<unknown>
  }
  const originalRead = reader.read
  let hydrateReads = 0
  reader.read = function countedRead(this: unknown, id: string, signal?: AbortSignal): Promise<unknown> {
    hydrateReads += 1
    return originalRead.call(this, id, signal)
  }
  life.defer(() => { reader.read = originalRead })
  const editor = mountedEditor(fixture)
  const app = fixture.runnerApp() as unknown as {
    draftImageStoreForTest?: {
      add(input: { readonly recalledRef: { readonly attachmentId: string; readonly mediaType: 'image/png'; readonly bytes: number; readonly width: number; readonly height: number }; readonly mediaType: 'image/png'; readonly width: number; readonly height: number }): { readonly id: number; readonly placeholder: string }
      values(): readonly unknown[]
      remove(id: number): boolean
    }
    draftFileStoreForTest?: {
      add(input: { readonly name: string; readonly byteLength: number; readonly source: { readonly type: 'recalled'; readonly ref: { readonly attachmentId: string; readonly name: string; readonly bytes: number } } }): { readonly id: number; readonly placeholder: string }
      values(): readonly unknown[]
      remove(id: number): boolean
    }
  }
  assert.ok(app.draftImageStoreForTest !== undefined && app.draftFileStoreForTest !== undefined)
  const image = app.draftImageStoreForTest.add({
    recalledRef: { attachmentId: 'rbs-same-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
    mediaType: 'image/png', width: 1, height: 1,
  })
  const file = app.draftFileStoreForTest.add({
    name: 'rbs-same.txt', byteLength: 3,
    source: { type: 'recalled', ref: { attachmentId: 'rbs-same-file', name: 'rbs-same.txt', bytes: 3 } },
  })
  const stagedDraft = `draft survives same-binding New ${image.placeholder} ${file.placeholder}`

  await openCurrentWorkspace(fixture, '')
  const recallBefore = editor.getInputHistory()
  holdList = true
  await activateCurrentFolderNew(fixture)
  await waitForGate(listEntered, 'the same-binding raw list response')
  editor.setDraft(stagedDraft)
  listRelease.open()
  try {
    await waitFor('same-binding New closes the Browser', () =>
      fixture.vt.getViewport().join('\n').includes('Sessions ·') === false, 20_000)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nlast frame:\n${fixture.vt.getViewport().join('\n')}`)
  }

  assert.equal(calls.creates.length, 1, 'same exact binding still goes through exactly one Host create')
  assert.equal(calls.retains.length, 1, 'the Host result is retained exactly once for the main surface')
  assert.equal(hydrateReads, 0, 'same owner performs no ordinary reset or hydrate')
  assert.strictEqual(sessions.binding(SessionId(sessionId)), bindingBefore, 'the official binding object is unchanged')
  assert.equal(sessions.retainInfo(SessionId(sessionId)).getSnapshot().referenceCount, refsBefore)
  assert.equal(editor.getDraft(), stagedDraft, 'the active draft stays byte-identical')
  assert.strictEqual(app.draftImageStoreForTest.values()[0], image, 'the staged image reference survives same-owner New')
  assert.strictEqual(app.draftFileStoreForTest.values()[0], file, 'the staged file reference survives same-owner New')
  assert.deepEqual(editor.getInputHistory(), recallBefore, 'the same recall scope is not reset')
  await waitFor('the same-owner live catalog is ready after official create', () =>
    fixture.aggregate.presentation.sessionFacts.sessionStatus(sessionId)?.preset === presetId, 20_000)

  app.draftImageStoreForTest.remove(image.id)
  app.draftFileStoreForTest.remove(file.id)
  editor.setDraft('next prompt on same binding')
  editor.submitDraft()
  await waitForHostText(host, sessionId, 'user/message', 'next prompt on same binding')
  assert.equal(hostEventTexts(host, sessionId, 'user/message').filter(value => value.includes('next prompt on same binding')).length, 1,
    'the mounted composer submits through the reused owner exactly once')
})

test('sessionless explicit Remote New commits the first actual owner through the mounted composer', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'rbs-1-first-owner-preset'
  const host = await mountRemotePresentationHost(life, presetId)
  const fixture = await mountRemoteRunner(life, { presetId, host, productionSerializer: true })
  await waitFor('the sessionless composer is mounted', () => fixture.vt.getViewport().join('\n').includes('❯'), 20_000)
  const sessions = fixture.aggregate.wire.client.sessions
  const calls = countOfficialSessionCalls(life, fixture)
  const editor = mountedEditor(fixture)
  const app = fixture.runnerApp() as unknown as {
    draftImageStoreForTest?: {
      add(input: { readonly recalledRef: { readonly attachmentId: string; readonly mediaType: 'image/png'; readonly bytes: number; readonly width: number; readonly height: number }; readonly mediaType: 'image/png'; readonly width: number; readonly height: number }): { readonly id: number; readonly placeholder: string }
      values(): readonly unknown[]
    }
    draftFileStoreForTest?: {
      add(input: { readonly name: string; readonly byteLength: number; readonly source: { readonly type: 'recalled'; readonly ref: { readonly attachmentId: string; readonly name: string; readonly bytes: number } } }): { readonly id: number; readonly placeholder: string }
      values(): readonly unknown[]
    }
  }
  assert.ok(app.draftImageStoreForTest !== undefined && app.draftFileStoreForTest !== undefined)
  const image = app.draftImageStoreForTest.add({
    recalledRef: { attachmentId: 'rbs-first-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 },
    mediaType: 'image/png', width: 1, height: 1,
  })
  const file = app.draftFileStoreForTest.add({
    name: 'rbs-first.txt', byteLength: 3,
    source: { type: 'recalled', ref: { attachmentId: 'rbs-first-file', name: 'rbs-first.txt', bytes: 3 } },
  })
  const before = new Set(host.ctx.sessions.list().map(session => String(session.id)))
  editor.setDraft('/new')
  editor.submitDraft()
  let actualId: string | undefined
  await waitFor('the first actual Session is mounted', () => {
    const created = host.ctx.sessions.list().map(session => String(session.id)).find(id => !before.has(id))
    if (created === undefined) return false
    actualId = created
    return sessions.binding(SessionId(created)) !== undefined
      && fixture.aggregate.presentation.sessionFacts.sessionStatus(created)?.preset === presetId
  }, 20_000)
  assert.ok(actualId !== undefined)
  assert.equal(calls.creates.length, 1)
  assert.equal(calls.creates[0]?.sessionId, undefined, 'a sessionless first owner creates without a fabricated candidate id')
  assert.equal(sessions.retainInfo(SessionId(actualId)).getSnapshot().referenceCount, 1)
  assert.strictEqual(app.draftImageStoreForTest.values()[0], image, 'first-owner New preserves the staged image reference')
  assert.strictEqual(app.draftFileStoreForTest.values()[0], file, 'first-owner New preserves the staged file reference')
  assert.equal(editor.getInputHistory().includes('/new'), false, 'the sessionless New command is not imported into Session recall')

  app.draftImageStoreForTest.remove(image.id)
  app.draftFileStoreForTest.remove(file.id)
  await waitFor('the first actual owner composer is ready', () =>
    fixture.vt.getViewport().join('\n').includes('❯')
    && !fixture.vt.getViewport().join('\n').includes('type a message to start a session'), 20_000)
  editor.setDraft('first owner composer prompt')
  editor.submitDraft()
  await waitForHostText(host, actualId, 'user/message', 'first owner composer prompt')
  assert.equal(hostEventTexts(host, actualId, 'user/message').filter(value => value.includes('first owner composer prompt')).length, 1)
})

test('explicit Remote New adopts the actual Host id and closes pre-retain and hydrate-to-ingress gaps exactly once', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'rbs-1-actual-id-preset'
  const oldId = 'rbs-1-actual-id-old'
  const candidateId = 'rbs-1-actual-id-candidate'
  const adapter = new StubStreamingLlmAdapter()
  const host = await mountRemotePresentationHost(life, presetId, { llmAdapter: adapter })
  await host.harness.create(SessionId(oldId), { provider: 'smoke', model: 'smoke-model' } as never, { cwd: host.anchorDir })
  await host.harness.create(SessionId(candidateId), { provider: 'smoke', model: 'smoke-model' } as never, { cwd: host.anchorDir })
  const registry = host.ctx.get('workspaceRegistry') as unknown as {
    create(path: string): Promise<{ attachSession(id: unknown): Promise<void> }>
  }
  const workspace = await registry.create(host.anchorDir)
  await workspace.attachSession(SessionId(oldId))
  await workspace.attachSession(SessionId(candidateId))

  const listEntered = testGate()
  const listRelease = testGate()
  const createEntered = testGate()
  const createRelease = testGate()
  const hydrateEntered = testGate()
  const hydrateRelease = testGate()
  life.defer(listRelease.open)
  life.defer(createRelease.open)
  life.defer(hydrateRelease.open)
  let armList = false
  let armCreate = false
  let actualId: string | undefined
  observeSharedFetch(life, async (pathname, response) => {
    if (armList && pathname.endsWith('/session/list')) {
      armList = false
      listEntered.open()
      await listRelease.promise
    }
    if (armCreate && pathname.endsWith('/session/create')) {
      armCreate = false
      const envelope = await response.clone().json() as {
        readonly result?: { readonly ok?: boolean; readonly value?: { readonly sessionId?: unknown } }
      }
      const published = envelope.result?.value?.sessionId
      if (envelope.result?.ok !== true || typeof published !== 'string' || published === '') {
        throw new Error('the real session/create response did not name its published Session')
      }
      actualId = published
      createEntered.open()
      await createRelease.promise
    }
    return response
  })

  let hydrateTarget: string | undefined
  let hydrateArmed = false
  const fixture = await mountRemoteRunner(life, {
    presetId,
    resumeSessionId: oldId,
    host,
    productionSerializer: true,
    beforeRunnerMount: presentation => {
      const reader = presentation.presentationReader as unknown as {
        read(id: string, signal?: AbortSignal): Promise<unknown>
      }
      const realRead = reader.read
      reader.read = async function heldHydrate(this: unknown, id: string, signal?: AbortSignal): Promise<unknown> {
        const snapshot = await realRead.call(this, id, signal)
        if (hydrateArmed && id === hydrateTarget) {
          hydrateArmed = false
          hydrateEntered.open()
          await hydrateRelease.promise
        }
        return snapshot
      }
      life.defer(() => { reader.read = realRead })
    },
  })
  await waitFor('the old owner is mounted', () => fixture.vt.getViewport().join('\n').includes('❯'), 20_000)
  const sessions = fixture.aggregate.wire.client.sessions
  const oldBinding = sessions.binding(SessionId(oldId)) as unknown as {
    session: {
      getSnapshot(): { readonly running: boolean }
      prompt(content: readonly { readonly type: 'text'; readonly text: string }[], mode: 'queue' | 'steer'): Promise<unknown>
    }
  }
  assert.ok(oldBinding !== undefined)
  const releaseOldTurn = adapter.hold(oldId)
  life.defer(releaseOldTurn)
  await oldBinding.session.prompt([{ type: 'text', text: 'old turn stays busy' }], 'queue')
  await waitFor('the old Host turn is running', () => oldBinding.session.getSnapshot().running, 20_000)
  await waitFor('the old model request entered the selective hold', () => adapter.heldStreamCount >= 1, 20_000)

  const peer = await mountOfficialPeer(life, fixture)
  const calls = countOfficialSessionCalls(life, fixture)
  armList = true
  armCreate = true
  const editor = mountedEditor(fixture)
  editor.setDraft('/new')
  editor.submitDraft()

  await waitForGate(listEntered, 'the real raw list response before candidate dispatch')
  const candidateReference = await retainPeerSession(peer, candidateId)
  const candidatePrompt = await candidateReference.binding.session.prompt([{ type: 'text', text: 'candidate started after selection' }], 'queue')
  assert.equal((candidatePrompt as { readonly ok?: boolean }).ok, true, `the live blank candidate refused its peer prompt: ${JSON.stringify(candidatePrompt)}`)
  await waitForHostText(host, candidateId, 'user/message', 'candidate started after selection')
  listRelease.open()

  await waitForGate(createEntered, 'the real session/create response before main retain')
  assert.ok(actualId !== undefined)
  const publishedId = actualId
  assert.notEqual(publishedId, candidateId, 'the Host declined the now-started candidate and published another actual id')
  hydrateTarget = publishedId
  hydrateArmed = true
  const actualReference = await retainPeerSession(peer, publishedId)
  await actualReference.binding.session.prompt([{ type: 'text', text: 'peer event before main retain' }], 'queue')
  await waitForHostText(host, publishedId, 'user/message', 'peer event before main retain')
  await waitFor('the pre-retain peer turn settles', () =>
    actualReference.binding.session.getSnapshot().running === false, 20_000)
  createRelease.open()

  await waitFor('the actual Host id is retained by the main Client', () =>
    sessions.binding(SessionId(publishedId)) !== undefined, 20_000)
  await waitForGate(hydrateEntered, 'the actual-id hydrate snapshot before ingress subscription')
  await actualReference.binding.session.prompt([{ type: 'text', text: 'peer event during hydrate gap' }], 'queue')
  await waitForHostText(host, publishedId, 'user/message', 'peer event during hydrate gap')
  await waitFor('the hydrate-gap peer turn settles', () =>
    actualReference.binding.session.getSnapshot().running === false, 20_000)
  hydrateRelease.open()

  const renderedCount = (text: string): number => fixture.vt.getViewport().join('\n').split('\n')
    .filter(line => line.trimStart().startsWith('❯ ') && line.includes(text)).length
  await waitFor('the pre-retain event paints', () => renderedCount('peer event before main retain') >= 1, 20_000)
  await waitFor('the hydrate-gap event paints', () => renderedCount('peer event during hydrate gap') >= 1, 20_000)
  assert.equal(renderedCount('peer event before main retain'), 1,
    `the pre-retain event is rendered exactly once\n${fixture.vt.getViewport().join('\n')}`)
  assert.equal(renderedCount('peer event during hydrate gap'), 1,
    `the hydrate-gap event is rendered exactly once\n${fixture.vt.getViewport().join('\n')}`)
  assert.equal(hostEventTexts(host, publishedId, 'user/message').filter(value => value.includes('peer event before main retain')).length, 1,
    'the pre-retain peer event is durable exactly once')
  assert.equal(hostEventTexts(host, publishedId, 'user/message').filter(value => value.includes('peer event during hydrate gap')).length, 1,
    'the hydrate-gap peer event is durable exactly once')
  assert.equal(calls.creates.length, 1, 'the real Host decision comes from exactly one create dispatch')
  assert.deepEqual(calls.creates[0], { workspaceId: expectWorkspaceId(host, oldId), sessionId: candidateId, agentPreset: presetId })
  assert.equal(sessions.retainInfo(SessionId(oldId)).getSnapshot().referenceCount, 0,
    'the old Client reference is released only after the actual child commits')
  assert.equal(sessions.retainInfo(SessionId(publishedId)).getSnapshot().referenceCount, 1,
    'the main Client owns one reference to the actual id')
  assert.equal(peer.sessions.retainInfo(SessionId(publishedId)).getSnapshot().referenceCount, 1,
    'the independent official peer owns its separate reference to the actual id')
  assert.equal((host.ctx.get('agents') as unknown as { get(id: unknown): { status: string } | undefined }).get(SessionId(oldId))?.status, 'running',
    'the busy old Host owner is never cancelled')
  assert.equal(hostEventTexts(host, oldId, 'turn/end').length, 0, 'the old Host turn has no durable end')

  candidateReference.reference.release()
  actualReference.reference.release()
  editor.setDraft('next prompt on actual id')
  editor.submitDraft()
  await waitForHostText(host, publishedId, 'user/message', 'next prompt on actual id')
  assert.equal(hostEventTexts(host, publishedId, 'user/message').filter(value => value.includes('next prompt on actual id')).length, 1)
})

test('a generation rollover after retain but before owner mapping releases the actual-id acquisition without adoption', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'rbs-1-post-retain-rollover-preset'
  const oldId = 'rbs-1-post-retain-old'
  const candidateId = 'rbs-1-post-retain-candidate'
  const host = await mountRemotePresentationHost(life, presetId)
  await host.harness.create(SessionId(oldId), undefined, { cwd: host.anchorDir })
  await seedBlankWorkspaceSessions(host, [candidateId])
  const oldSession = host.ctx.sessions.get(SessionId(oldId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  seedTurns(oldSession, 1, 1, 'old owner remains after rollover')
  const registry = host.ctx.get('workspaceRegistry') as unknown as {
    create(path: string): Promise<{ attachSession(id: unknown): Promise<void> }>
  }
  const workspace = await registry.create(host.anchorDir)
  await workspace.attachSession(SessionId(oldId))
  await workspace.attachSession(SessionId(candidateId))
  const fixture = await mountRemoteRunner(life, { presetId, resumeSessionId: oldId, host, productionSerializer: true })
  await waitFor('the old owner hydrates before the controlled rollover', () =>
    fixture.vt.getViewport().join('\n').includes('old owner remains after rollover'), 20_000)
  const sessions = fixture.aggregate.wire.client.sessions
  const calls = countOfficialSessionCalls(life, fixture)
  const connection = fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const owners = fixture.aggregate.selected.owners
  const originalFromHandle = owners.fromHandle
  let armRollover = false
  let rolled = false
  owners.fromHandle = function countedFromHandle(this: unknown, handle: Parameters<typeof originalFromHandle>[0]): ReturnType<typeof originalFromHandle> {
    const owner = originalFromHandle.call(this, handle)
    if (armRollover && handle.session.id === candidateId) {
      armRollover = false
      connection.reconnect()
      rolled = true
    }
    return owner
  }
  life.defer(() => { owners.fromHandle = originalFromHandle })
  const generationBefore = connection.generation.getSnapshot()?.id
  const editor = mountedEditor(fixture)
  armRollover = true
  editor.setDraft('/new')
  editor.submitDraft()
  await waitFor('the official Client generation rolls over after retain', () => {
    const id = connection.generation.getSnapshot()?.id
    return rolled && id !== undefined && id !== generationBefore
  }, 20_000)
  await waitFor('the uncommitted actual-id reference is released', () =>
    sessions.retainInfo(SessionId(candidateId)).getSnapshot().referenceCount === 0, 20_000)
  assert.equal(calls.creates.length, 1)
  assert.deepEqual(calls.creates[0], { workspaceId: expectWorkspaceId(host, oldId), sessionId: candidateId, agentPreset: presetId })
  assert.equal(calls.retains.length, 1)
  assert.ok(sessions.binding(SessionId(oldId)) !== undefined, 'the prior exact owner remains the mounted Client owner')
  assert.ok(fixture.vt.getViewport().join('\n').includes('old owner remains after rollover'), 'no stale actual-id adoption replaces the visible owner')
})

test('a real raw Session-list response loss cannot authorize create from the ready Client snapshot', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'rbs-1-raw-list-failure-preset'
  const oldId = 'rbs-1-raw-list-failure-old'
  const blankId = 'rbs-1-raw-list-failure-blank'
  const host = await mountRemotePresentationHost(life, presetId)
  await host.harness.create(SessionId(oldId), undefined, { cwd: host.anchorDir })
  const append = host.ctx.sessions.get(SessionId(oldId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  seedTurns(append, 1, 1, 'old raw-list owner')
  await seedBlankWorkspaceSessions(host, [blankId])
  const registry = host.ctx.get('workspaceRegistry') as unknown as {
    create(path: string): Promise<{ attachSession(id: unknown): Promise<void> }>
  }
  const workspace = await registry.create(host.anchorDir)
  await workspace.attachSession(SessionId(oldId))

  let failList = false
  observeSharedFetch(life, async (pathname, response) => {
    if (failList && pathname.endsWith('/session/list')) {
      failList = false
      throw new Error('controlled raw Session-list response loss after the Host answered')
    }
    return response
  })
  const fixture = await mountRemoteRunner(life, { presetId, resumeSessionId: oldId, host, productionSerializer: true })
  await waitFor('the old owner hydrates before the raw-read negative', () =>
    fixture.vt.getViewport().join('\n').includes('old raw-list owner answer 1'), 20_000)
  const sessions = fixture.aggregate.wire.client.sessions
  const oldBinding = sessions.binding(SessionId(oldId))
  const calls = countOfficialSessionCalls(life, fixture)
  const editor = mountedEditor(fixture)

  failList = true
  await openCurrentWorkspace(fixture, 'draft survives raw-list failure')
  await activateCurrentFolderNew(fixture)
  await waitFor('the real raw-list failure is visible', () =>
    fixture.vt.getViewport().join('\n').includes('Host Session list is unavailable'), 20_000)
  assert.equal(calls.creates.length, 0, 'a cached ready list never authorizes create after the raw read fails')
  assert.strictEqual(sessions.binding(SessionId(oldId)), oldBinding, 'the prior exact owner remains current')
  assert.equal(editor.getDraft(), 'draft survives raw-list failure')
  assert.ok(fixture.vt.getViewport().join('\n').includes('Sessions ·'), 'the failed Folder New leaves the Browser open')

  const connection = fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const generationBefore = connection.generation.getSnapshot()?.id
  connection.reconnect()
  await waitFor('the Client reaches a fresh generation', () => {
    const id = connection.generation.getSnapshot()?.id
    return id !== undefined && id !== generationBefore
  }, 20_000)
  await waitFor('the official Client list is ready again', () =>
    sessions.list.getSnapshot().phase === 'ready', 20_000)
  await openCurrentWorkspace(fixture, '')
  await activateCurrentFolderNew(fixture)
  try {
    await waitFor('the fresh user gesture adopts the eligible blank', () =>
      sessions.binding(SessionId(blankId)) !== undefined, 20_000)
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\ncreates=${JSON.stringify(calls.creates)}\nnotice=${editor.notifyTextForTest()}\nlast frame:\n${fixture.vt.getViewport().join('\n')}`)
  }
  assert.equal(calls.creates.length, 1, 'only the deliberate post-reconnect gesture dispatches create')
  assert.deepEqual(calls.creates[0], { workspaceId: expectWorkspaceId(host, oldId), sessionId: blankId, agentPreset: presetId })
})

test('a controlled create response loss is indeterminate, never replayed on reconnect, and a new gesture may reuse the published blank', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'rbs-1-create-response-loss-preset'
  const oldId = 'rbs-1-create-response-loss-old'
  const blankId = 'rbs-1-create-response-loss-blank'
  const host = await mountRemotePresentationHost(life, presetId)
  await host.harness.create(SessionId(oldId), undefined, { cwd: host.anchorDir })
  const append = host.ctx.sessions.get(SessionId(oldId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  seedTurns(append, 1, 1, 'old response-loss owner')
  await seedBlankWorkspaceSessions(host, [blankId])
  const registry = host.ctx.get('workspaceRegistry') as unknown as {
    create(path: string): Promise<{ attachSession(id: unknown): Promise<void> }>
  }
  const workspace = await registry.create(host.anchorDir)
  await workspace.attachSession(SessionId(oldId))

  let loseCreateResponse = false
  let publishedWitness: string | undefined
  observeSharedFetch(life, async (pathname, response) => {
    if (loseCreateResponse && pathname.endsWith('/session/create')) {
      loseCreateResponse = false
      const envelope = await response.clone().json() as {
        readonly result?: { readonly ok?: boolean; readonly value?: { readonly sessionId?: unknown } }
      }
      const published = envelope.result?.value?.sessionId
      if (envelope.result?.ok !== true || typeof published !== 'string' || published === '') {
        throw new Error('the real session/create response did not name its published Session')
      }
      publishedWitness = published
      throw new Error('controlled create response loss after Host publication')
    }
    return response
  })
  const fixture = await mountRemoteRunner(life, { presetId, resumeSessionId: oldId, host, productionSerializer: true })
  await waitFor('the old owner hydrates before the create-loss negative', () =>
    fixture.vt.getViewport().join('\n').includes('old response-loss owner answer 1'), 20_000)
  const sessions = fixture.aggregate.wire.client.sessions
  const oldBinding = sessions.binding(SessionId(oldId))
  const calls = countOfficialSessionCalls(life, fixture)
  const editor = mountedEditor(fixture)

  await waitFor('the real New command is installed', () =>
    (editor as unknown as { commandCompletionsForTest(): readonly { readonly name?: string }[] }).commandCompletionsForTest()
      .some(command => command.name === 'new'), 20_000)
  loseCreateResponse = true
  editor.setDraft('/new')
  editor.submitDraft()
  await waitFor('the official Client create rejects after the controlled response loss', () =>
    calls.createFailures.length === 1, 20_000)
  assert.match(String(calls.createFailures[0]), /controlled create response loss after Host publication/u)
  assert.equal(publishedWitness, blankId, 'the real Host published/reused the requested blank before its reply was lost')
  assert.equal(calls.creates.length, 1, 'the lost reply causes no automatic second create')
  assert.strictEqual(sessions.binding(SessionId(oldId)), oldBinding, 'the prior owner is not replaced by an unproven result')
  assert.equal(sessions.binding(SessionId(blankId)), undefined, 'the Client never guesses adoption from the Host-side witness')
  assert.ok(host.ctx.sessions.get(SessionId(blankId)) !== undefined, 'the authoritative Host Session really exists')

  const connection = fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const generationBefore = connection.generation.getSnapshot()?.id
  connection.reconnect()
  await waitFor('the Client reaches a fresh generation after the lost reply', () => {
    const id = connection.generation.getSnapshot()?.id
    return id !== undefined && id !== generationBefore
  }, 20_000)
  await waitFor('the official Client list is ready after reconnect', () =>
    sessions.list.getSnapshot().phase === 'ready', 20_000)
  assert.equal(calls.creates.length, 1, 'reconnect alone never replays the indeterminate create')

  await waitFor('the main composer is ready for the deliberate retry', () =>
    fixture.vt.getViewport().join('\n').includes('❯'), 20_000)
  editor.setDraft('/new')
  editor.submitDraft()
  await waitFor('a new user gesture adopts the already-published blank', () =>
    sessions.binding(SessionId(blankId)) !== undefined, 20_000)
  assert.equal(calls.creates.length, 2, 'the second dispatch belongs only to the deliberate new gesture')
  assert.deepEqual(calls.creates[1], { workspaceId: expectWorkspaceId(host, oldId), sessionId: blankId, agentPreset: presetId })
  const recoveredRows = await fixture.aggregate.selected.backend.sessionReader.list(undefined)
  assert.ok(recoveredRows !== undefined)
  assert.equal(recoveredRows.filter(row => row.id === blankId).length, 1,
    'the recovered blank is one official row, not a duplicate Session')
})

function expectWorkspaceId(host: Awaited<ReturnType<typeof mountRemotePresentationHost>>, sessionId: string): string {
  const registry = host.ctx.get('workspaceRegistry') as unknown as {
    list(): readonly { readonly id?: unknown; readonly sessionIds: readonly unknown[] }[]
  }
  const workspace = registry.list().find(item => item.sessionIds.some(id => String(id) === sessionId))
  assert.ok(workspace !== undefined, `the official Workspace containing ${sessionId} exists`)
  return String(workspace.id)
}

test('pending: accepted queued -> queue pane, accepted steering -> official status, and the echo -> durable identity handoff', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-pending-running'
  const hostPreset = 'm3-4-pr2-preset'
  const adapter = new StubStreamingLlmAdapter()
  const seedHost = await mountRemotePresentationHost(life, hostPreset, { llmAdapter: adapter })
  // The agent must carry its route, else the turn fails before the adapter
  // (and the session never becomes `running`).
  const hostAgent = await seedHost.harness.create(
    SessionId(mainId),
    { provider: 'smoke', model: 'smoke-model' } as never,
    { cwd: seedHost.anchorDir },
  )
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  const app = await waitForApp(fixture)
  const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId)) as unknown as {
    session: {
      getSnapshot(): {
        readonly running: boolean
        readonly pendingSubmissions: readonly {
          readonly requestId: string
          readonly placement: 'queued' | 'steering' | 'transcript'
        }[]
      }
      projections: { faceOf(key: string): { getSnapshot(): unknown } }
      prompt(
        content: readonly { readonly type: 'text'; readonly text: string }[],
        mode: 'queue' | 'steer',
        signal?: AbortSignal,
        requestId?: string,
      ): Promise<{ readonly ok: boolean }>
      beginSubmission(input: {
        readonly mode: 'queue' | 'steer'
        readonly text: string
        readonly attachments: readonly unknown[]
        readonly onAccept?: () => void
      }): { readonly requestId: string }
    }
  }
  assert.ok(binding !== undefined, 'the retained binding serves the official prompt/echo faces')
  const inboxNextTurnOf = (): readonly { readonly source?: { readonly rpcId?: unknown } }[] => {
    const inbox = binding.session.projections.faceOf('inbox').getSnapshot() as
      | { readonly 'next-turn'?: readonly { readonly source?: { readonly rpcId?: unknown } }[] }
      | undefined
    return inbox?.['next-turn'] ?? []
  }
  // Hold one real turn OPEN so the session is officially `running`: the
  // placement of every accepted submission below is the official
  // `running ? queued/steering : transcript` rule, computed by the Client.
  const release = adapter.hold()
  await binding.session.prompt([{ type: 'text', text: 'hold the turn open' }], 'queue')
  await waitFor('session running', () => binding.session.getSnapshot().running, 15_000)

  // QUEUED: registration alone is invisible; the identified prompt reaches the
  // running Host, the Inbox carries the SAME requestId, and the accepted echo
  // joins the real Host row into exactly ONE queue-pane row.
  const queuedText = 'queued echo body'
  const queued = binding.session.beginSubmission({ mode: 'queue', text: queuedText, attachments: [] })
  assert.equal(app.pendingInputForTest().queued.some(row => (row as { text?: string }).text === queuedText), false,
    'a registered-but-unaccepted queued submission is never painted')
  const queuedAccepted = await binding.session.prompt([{ type: 'text', text: queuedText }], 'queue', undefined, queued.requestId)
  assert.equal(queuedAccepted.ok, true, 'the identified queued prompt is accepted')
  await waitFor('the Host Inbox carries the queued requestId', () =>
    inboxNextTurnOf().some(item => item.source?.rpcId === queued.requestId), 15_000)
  await waitFor('exactly one joined queued row', () =>
    app.pendingInputForTest().queued.filter(row => (row as { text?: string }).text === queuedText).length === 1, 15_000)
  assert.equal(app.pendingInputForTest().tail.some(row => row.row?.text === queuedText), false,
    'a queued occurrence never rides the transcript tail lane')

  // STEERING: the identified steer prompt is accepted by the Host; the official
  // onAccept snapshot is the observable status row (placement `steering`). The
  // steer interrupts the held turn, so no fixed transient echo window is
  // assumed — the durable identity proof below is the settlement.
  const steeringText = 'steering echo body'
  let steeringAccepts = 0
  let steeringAcceptedSnapshot: ReturnType<typeof binding.session.getSnapshot> | undefined
  const steering = binding.session.beginSubmission({
    mode: 'steer',
    text: steeringText,
    attachments: [],
    onAccept: () => {
      steeringAccepts += 1
      steeringAcceptedSnapshot = binding.session.getSnapshot()
    },
  })
  assert.equal(app.pendingInputForTest().tail.some(row => row.row?.text === steeringText), false,
    'a registered-but-unaccepted steering submission is never painted')
  const steeringAccepted = await binding.session.prompt([{ type: 'text', text: steeringText }], 'steer', undefined, steering.requestId)
  assert.equal(steeringAccepted.ok, true, 'the identified steer prompt is accepted')
  assert.equal(steeringAccepts, 1, 'steering onAccept fires exactly once')
  assert.ok(steeringAcceptedSnapshot !== undefined, 'the steering acceptance snapshot is observable')
  assert.ok(steeringAcceptedSnapshot.pendingSubmissions.some(entry =>
    entry.requestId === steering.requestId && entry.placement === 'steering'),
  'the accepted steering submission carries the official steering status')
  assert.equal(app.pendingInputForTest().queued.some(row => (row as { text?: string }).text === steeringText), false,
    'a steering occurrence never rides the queue pane')
  assert.ok(app.pendingInputForTest().tail.filter(row => row.row?.text === steeringText).length <= 1,
    'the steering occurrence is never duplicated across the tail lane')

  // CONTEXT: a NON-user `next-step` inbox message (here a goal-injected one)
  // is the official CONTEXT placement — it rides the generic tail row, never
  // the user/steering lane.
  ;(hostAgent as unknown as {
    inbox: { append(target: 'next-step', message: unknown): void }
  }).inbox.append('next-step', {
    id: 'goal-note-1',
    role: 'user',
    content: [{ type: 'text', text: 'goal-injected context note' }],
    source: { kind: 'goal', goalId: 'g-1', revision: 1, round: 1 },
  })
  await waitFor('context row in the tail lane', () => {
    return app.pendingInputForTest().tail.some(row => row.kind === 'context' && row.row?.text === 'goal-injected context note')
  }, 15_000)
  assert.equal(
    app.pendingInputForTest().tail.some(row => row.kind === 'user' && row.row?.text === 'goal-injected context note'),
    false,
    'a non-user occurrence never rides the user/steering lane',
  )

  // HANDOFF: both accepted submissions keep their OWN requestId; the durable
  // Host user/messages carry exactly those ids, the queued echo retires by
  // IDENTITY (never by text), and each text paints once.
  release()
  await waitFor('the queued echo retired into the durable row', () => {
    const pending = app.pendingInputForTest()
    return pending.queued.every(row => (row as { text?: string }).text !== queuedText)
  }, 20_000)
  type HostUserMessage = {
    readonly source: { readonly kind?: string; readonly rpcId?: unknown }
    readonly content: readonly { readonly type?: string; readonly text?: string }[]
  }
  const hostUserMessages = (): readonly HostUserMessage[] => {
    const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): ReadonlyArray<{ type: string; data: unknown }>
    }
    return session.snapshotEvents()
      .filter(event => event.type === 'user/message')
      .map(event => event.data as HostUserMessage)
      .filter(message => message.source.kind === 'user')
  }
  await waitFor('both identified durable rows landed', () =>
    [queued.requestId, steering.requestId].every(requestId =>
      hostUserMessages().some(message => message.source.rpcId === requestId)), 20_000)
  for (const [requestId, expectedText] of [
    [queued.requestId, queuedText],
    [steering.requestId, steeringText],
  ] as const) {
    const identified = hostUserMessages().filter(message => message.source.rpcId === requestId)
    assert.equal(identified.length, 1, `exactly one durable message carries requestId ${requestId}`)
    assert.equal(identified[0]!.content.filter(part => part.type === 'text').map(part => part.text).join(''), expectedText,
      'the durable identity carries the submitted content')
  }
  await waitFor('both durable user rows painted', () =>
    fixture.vt.getViewport().join('\n').includes(queuedText) && fixture.vt.getViewport().join('\n').includes(steeringText), 20_000)
  const painted = fixture.vt.getViewport().join('\n').split('\n')
  assert.equal(painted.filter(line => line.includes(queuedText)).length, 1,
    'the queued text paints exactly once (no echo plus durable duplicate)')
  assert.equal(painted.filter(line => line.includes(steeringText)).length, 1,
    'the steering text paints exactly once (no echo plus durable duplicate)')
})

test('a real Remote ordinary submit carries the Client-sampled request zone — not the Host zone — into the Host source and its time-context injection', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-request-zone'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset, { llmAdapter: new StubStreamingLlmAdapter() })
  await seedHost.harness.create(
    SessionId(mainId),
    { provider: 'smoke', model: 'smoke-model' } as never,
    { cwd: seedHost.anchorDir },
  )
  // The HOST side carries its own zone: the process zone is Amsterdam and the
  // official request-clock row is mounted with an explicit New York display
  // fallback (the Host-owned fallback the request zone must outrank).
  const previousTz = process.env.TZ
  process.env.TZ = 'Europe/Amsterdam'
  life.defer(() => {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  })
  const timeContext = await import('@deepseek-ai/dsh-time-context')
  await seedHost.ctx.plugin(timeContext as never, { timeZone: 'America/New_York' } as never)
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host: seedHost,
    productionSerializer: true,
  })
  // The CLIENT side is independently controlled: the official
  // `resolvedClientTimeZone()` samples `new Intl.DateTimeFormat()` with no
  // arguments, so a no-argument construction reports the Client runtime's zone
  // (Paris) while every explicit-`timeZone` construction — the Host's own
  // canonicalization and the plugin's formatters — keeps the real behaviour.
  const originalDateTimeFormat = Intl.DateTimeFormat
  let clientZone: string | undefined = 'Europe/Paris'
  const patched = function patchedDateTimeFormat(
    this: unknown,
    ...args: unknown[]
  ): Intl.DateTimeFormat {
    const formatter = Reflect.construct(originalDateTimeFormat, args) as Intl.DateTimeFormat
    if (args.length === 0 && clientZone !== undefined) {
      const resolved = formatter.resolvedOptions.bind(formatter)
      formatter.resolvedOptions = () => ({ ...resolved(), timeZone: clientZone! })
    }
    return formatter
  }
  // Keep the real prototype/static surface (instanceof and
  // `supportedLocalesOf` still resolve) — only the no-argument zone is replaced.
  patched.prototype = originalDateTimeFormat.prototype
  Object.setPrototypeOf(patched, originalDateTimeFormat)
  ;(Intl as { DateTimeFormat: unknown }).DateTimeFormat = patched
  life.defer(() => { (Intl as { DateTimeFormat: unknown }).DateTimeFormat = originalDateTimeFormat })
  const app = await waitForApp(fixture)
  const editor = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void }
  // The Host's authoritative log for the resumed Session (the JSONL projection
  // flushes on retirement, so the live log is the readback that exists during
  // the turn — it is the same event stream persistence stores).
  const hostUsers = (): readonly {
    readonly source: { readonly kind?: string; readonly rpcId?: unknown; readonly clientTimeZone?: unknown }
    readonly content: readonly { readonly text?: string }[]
  }[] => {
    const agent = seedHost.ctx.agents.get(SessionId(mainId)) as unknown as {
      session: { snapshotEvents(): ReadonlyArray<{ type: string; data: unknown }> }
    }
    return agent.session.snapshotEvents()
      .filter(event => event.type === 'user/message')
      .map(event => event.data as never)
  }
  const humanMessages = (): ReturnType<typeof hostUsers> => hostUsers().filter(message => message.source.kind === 'user')
  const baseline = humanMessages().length
  try {
    assert.equal(new Intl.DateTimeFormat().resolvedOptions().timeZone, 'Europe/Paris',
      'the Client runtime must report the controlled zone while the Host process zone stays Amsterdam')
    editor.setDraft('remote request zone')
    editor.submitDraft()
    assert.ok(app !== undefined)
    await waitFor('the Remote turn to complete on the Host', () =>
      fixture.vt.getViewport().join('\n').includes('remote reply'), 25_000)
    await waitFor('the Host user message', () => humanMessages().length === baseline + 1, 20_000)

    const human = humanMessages()
    assert.equal(typeof human[baseline]!.source.rpcId, 'string', 'the official identified prompt kept its request id')
    assert.equal(human[baseline]!.source.clientTimeZone, 'Europe/Paris',
      'the CLIENT zone crossed the official SessionFace → generated Remote → Host source (never the Host zone)')
    const injected = hostUsers().filter(message => message.source.kind === 'time-context')
    assert.equal(injected.length, 1, 'the mounted official plugin injected one request-clock snapshot')
    const text = injected[0]!.content.map(part => part.text ?? '').join('\n')
    assert.match(text, /Browser time zone for this request: Europe\/Paris\./u,
      'the model-visible request zone is the Client value, not the Host process zone or the configured fallback')
    assert.equal(text.includes('Amsterdam'), false, 'the Host process zone must never appear as the request zone')
    assert.equal(text.includes('New_York'), false, 'the Host display fallback must never appear as the request zone')

    // L6: the SAME durable reading reaches the mounted surface through the
    // selected Remote Application → official Client event source →
    // RemoteLiveIngress → SessionPresentation → TranscriptFolder path — not by
    // handing Host events to the folder directly. The Context card's producer
    // badge is the row identity; the body carries the request-zone policy.
    const painted = (): string => fixture.vt.getViewport()
      .map(line => line.replace(/\x1b\[[0-9;]*m/gu, '')).join('\n')
    // The ambient card is collapsed by default, so the PAINTED identity is the
    // header/badge; the folded body is read from the same app transcript.
    await waitFor('the time-context Context card paints through the live ingress', () =>
      painted().includes('Context') && painted().includes('time-context'), 20_000)
    const foldedContext = ((app as unknown as {
      messages?: readonly {
        kind?: string
        text?: string
        contextPresentation?: { sourceKind?: string }
      }[]
    }).messages ?? []).filter(message =>
      message.kind === 'system' && message.contextPresentation?.sourceKind === 'time-context')
    assert.equal(foldedContext.length, 1,
      'exactly one time-context row reached the presentation through the live ingress')
    assert.match(foldedContext[0]!.text ?? '',
      /Browser time zone for this request: Europe\/Paris\./u,
      'the folded Context body is the official durable reading, not a rebuilt value')

    // Per-submit sampling: the NEXT send samples the Client runtime again, and it
    // never rewrites the earlier message's stored zone.
    clientZone = 'UTC'
    editor.setDraft('second request zone')
    editor.submitDraft()
    await waitFor('the second Host user message', () => humanMessages().length === baseline + 2, 20_000)
    assert.deepEqual(humanMessages().map(message => message.source.clientTimeZone).slice(baseline),
      ['Europe/Paris', 'UTC'],
      'each human submit carries the zone sampled at ITS OWN send point')
  } finally {
    await fixture.dispose()
  }
})

test('a projection-owned value changed by ANOTHER writer reaches the surface through the official projection channel', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-projection-live'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(
    SessionId(mainId),
    { provider: 'smoke', model: 'smoke-model' } as never,
    { cwd: seedHost.anchorDir },
  )
  const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  seedTurns(session, 1, 2, 'live')
  // The initial model is the OFFICIAL modelSelection projection's value.
  session.append('model/selection', { provider: 'smoke', model: 'first-model' })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  const app = await waitForApp(fixture)
  const modelOf = (): string | undefined => (app as unknown as {
    statusStore: { snapshot(): { composition?: { model?: { id?: string } } } }
  }).statusStore.snapshot().composition?.model?.id
  await waitFor('the projection model painted', () => modelOf() === 'first-model', 20_000)

  // ANOTHER writer changes it (a Host-side durable selection; the same shape a
  // second Client's selection lands in). The Session snapshot never carries
  // projection values, and the Remote event routing for `model/selection` is a
  // no-op (no live Direct agent), so ONLY the official projection channel can
  // refresh this surface — no unrelated event is emitted here.
  session.append('model/selection', { provider: 'smoke', model: 'second-model' })
  await waitFor('the new model reached the surface', () => modelOf() === 'second-model', 20_000)
  assert.equal(modelOf(), 'second-model',
    'the live projection channel refreshed the current-value fact (a stale footer would still say first-model)')
})

test('ONE real Host event updates MULTIPLE Client projection faces, and the reconnect baseline reverts a poisoned value', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-projection-multikey'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(
    SessionId(mainId),
    { provider: 'smoke', model: 'smoke' } as never,
    { cwd: seedHost.anchorDir },
  )
  const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  seedTurns(session, 1, 2, 'multi')
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  const app = await waitForApp(fixture)
  const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId) as never) as {
    session: {
      readonly projections: {
        faceOf(key: string): { getSnapshot(): unknown }
        apply(key: string, value: unknown, seq: number): void
        seqOf(key: string): number | undefined
      }
    }
  } | undefined
  assert.ok(binding !== undefined, 'the retained binding serves the official projection faces')
  const statusStore = (app as unknown as {
    statusStore: { snapshot(): { usage?: { tokens?: { input?: number; output?: number } } } }
  }).statusStore
  /** The official Host projection registry: its per-event change listener is
   *  the SAME change set the wire frame carries (the Client's control frame is
   *  `{seq, changes[]}`), so the keys/seq below are observed, never invented. */
  const projections = seedHost.ctx.get('sessionProjections') as unknown as {
    onEventChanged(listener: (session: unknown, changes: readonly { readonly key: string }[], seq: unknown) => void): () => void
    snapshot(session: unknown, keys: readonly string[]): { readonly values: Readonly<Record<string, unknown>> }
  }
  const frames: Array<{ readonly keys: string[]; readonly seq: number }> = []
  const unsubscribe = projections.onEventChanged((changedSession, changes, seq) => {
    if (changedSession !== session) return
    frames.push({ keys: changes.map(change => change.key), seq: Number(seq) })
  })
  life.defer(unsubscribe)
  // The baseline painted the seeded lifetime usage (2 turns x 1 token) through
  // the official tokenUsage projection — the consumer state a stale frame must
  // not survive.
  await waitFor('the seeded tokenUsage baseline painted', () => {
    const tokens = statusStore.snapshot().usage?.tokens
    return tokens?.input === 2 && tokens?.output === 2
  }, 20_000)

  // ONE real committed event that changes MULTIPLE client-visible units. The
  // exact key set comes from the Host's own per-event change listener.
  session.append('assistant/message', {
    turn: 3,
    step: 0,
    message: {
      id: 'multi-key-assistant',
      role: 'assistant',
      content: [{ type: 'text', text: 'multi-key answer' }],
      source: { kind: 'model', provider: 'smoke', model: 'smoke' },
    },
    stream: [{ type: 'chunk', time: Date.now() - 1, chunk: { type: 'text-delta', index: 0, text: 'x' } }],
    usage: { inputTokens: 7, outputTokens: 11 },
  }, { surfaceOp: 'append' })
  await waitFor('a real MULTI-KEY Host projection frame', () =>
    frames.some(frame => frame.keys.length >= 2 && frame.keys.includes('tokenUsage')), 20_000)
  const frame = frames.find(entry => entry.keys.length >= 2 && entry.keys.includes('tokenUsage'))!
  const frameTruth = projections.snapshot(session, frame.keys)
  const facesMatch = (truth: Readonly<Record<string, unknown>>): boolean =>
    frame.keys.every(key => isDeepStrictEqual(binding.session.projections.faceOf(key).getSnapshot(), truth[key]))
  await waitFor('every changed key of the frame crossed the wire', () => facesMatch(frameTruth.values), 20_000)
  for (const key of frame.keys) {
    assert.deepEqual(binding.session.projections.faceOf(key).getSnapshot(), frameTruth.values[key],
      `the Client faceOf(${key}) equals the official session/projections readback in the SAME frame`)
  }
  const usageTruth = frameTruth.values.tokenUsage as {
    readonly uncachedInputTokens: number
    readonly outputTokens: number
  }
  await waitFor('the mounted consumer repaints the new tokenUsage truth', () => {
    const tokens = statusStore.snapshot().usage?.tokens
    return tokens?.input === usageTruth.uncachedInputTokens && tokens?.output === usageTruth.outputTokens
  }, 20_000)

  // POISON the pre-reconnect generation's Client store for one changed key: a
  // value the Host never produced, at a higher seq than the live frame.
  const poison = { uncachedInputTokens: 999_999, outputTokens: 888_888, cacheReadTokens: 0, cacheWriteTokens: 0 }
  binding.session.projections.apply('tokenUsage', poison, (binding.session.projections.seqOf('tokenUsage') ?? 0) + 1_000)
  assert.deepEqual(binding.session.projections.faceOf('tokenUsage').getSnapshot(), poison,
    'the pre-reconnect Client store now holds the poisoned value')

  // RECONNECT: the new generation's authoritative baseline must REVERT the
  // poisoned value and re-establish every key of the observed frame.
  const connection = fixture.aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const generationBefore = connection.generation.getSnapshot()?.id
  connection.reconnect()
  await waitFor('reconnected on a NEW generation', () => {
    const id = connection.generation.getSnapshot()?.id
    return id !== undefined && id !== generationBefore
  }, 20_000)
  await waitFor('the reconnect baseline reverts the poisoned tokenUsage face', () =>
    isDeepStrictEqual(binding.session.projections.faceOf('tokenUsage').getSnapshot(), frameTruth.values.tokenUsage), 20_000)
  await waitFor('the mounted consumer repaints the authoritative usage', () => {
    const tokens = statusStore.snapshot().usage?.tokens
    return tokens?.input === usageTruth.uncachedInputTokens && tokens?.output === usageTruth.outputTokens
  }, 20_000)
  const truthAfterReconnect = projections.snapshot(session, frame.keys)
  for (const key of frame.keys) {
    assert.deepEqual(binding.session.projections.faceOf(key).getSnapshot(), truthAfterReconnect.values[key],
      `the reconnect baseline re-established the official ${key} value`)
  }
})

/* ───────────── §7.4-10/11 LIVE tool lifecycle (review F8) ───────────── */

/** The LIVE tool-call LLM script: one turn that requests the fixture tool
 *  (finish `tool-calls`), then one turn of plain text — the Host executes
 *  the tool between them and the durable call/result rows land on the
 *  official wire while the surface is MOUNTED. */
class ToolCallLlmAdapter extends StubStreamingLlmAdapter {
  private turn = 0

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.turn += 1
    if (this.turn === 1) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'using the tool' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'using the tool' } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 1, id: ToolCallId('live-call-1'), name: 'pr4_live_fixture', argumentsDelta: '{"marker":"LIVE-TOOL-ARGS"}' }
      yield {
        type: 'block-end', index: 1,
        block: { type: 'tool-call', id: ToolCallId('live-call-1'), name: 'pr4_live_fixture', arguments: '{"marker":"LIVE-TOOL-ARGS"}' },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* scriptedTextTurn('tool turn complete')
  }
}

test('LIVE: a mounted Remote surface renders the tool call as it executes on the Host, then settles from the durable result', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-tool-live'
  const hostPreset = 'm3-4-pr2-preset'
  const host = await mountRemotePresentationHost(life, hostPreset, {
    llmAdapter: new ToolCallLlmAdapter(),
  })
  // A REAL Host-registered fixture tool the scripted model turn requests.
  // It is deliberately NOT one of the Client presenter's known names: the
  // mounted card must ride the bounded generic fallback (§7.4-11's mounted
  // proof), while the live→settled convergence (§7.4-10's live proof) is
  // the Host executing this very call through the official loop.
  const testkit = await import('@deepseek-ai/dsh-tool-testkit')
  host.ctx.tools.register(testkit.defineContentToolFixture({
    name: 'pr4_live_fixture',
    description: 'the live lifecycle fixture tool',
    parameters: {},
    execute: async () => [{ type: 'text', text: 'LIVE-TOOL-RESULT' }],
  }))
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host, productionSerializer: true })
  const app = await waitForApp(fixture)
  assert.ok(app instanceof TuiApp)
  // Observe individual live and settled cards rather than the Work preview.
  app.setDisplayPreset('full')
  const editor = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void; getDraft(): string }
  const eventsOf = (): Array<{ type: string; data: unknown }> => (host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }).snapshotEvents()

  // The REAL submit gesture starts the turn; the Host runs the scripted
  // model turn, executes the tool, then settles the follow-up turn.
  editor.setDraft('run the fixture tool please')
  editor.submitDraft()

  // LIVE phase: the in-flight call card appears while the turn is open —
  // derived from the transient/live facts, never a Host presenter. (The
  // generous window absorbs a first-run cold fixture startup.)
  await waitFor('the live tool name rendered', () =>
    fixture.vt.getViewport().join('').includes('pr4_live_fixture'), 40_000)
  // SETTLED phase: the durable result lands through the official eventSource
  // ingress and the card settles with the executed result text.
  await waitFor('the settled result rendered', () =>
    fixture.vt.getViewport().join('').includes('LIVE-TOOL-RESULT'), 20_000)
  // The turn completes end-to-end on the Host (the durable rows exist).
  await waitFor('the durable tool rows landed', () => {
    const kinds = eventsOf().map(event => event.type)
    return kinds.includes('tool/call') && kinds.includes('tool/result')
  }, 20_000)
  const callRow = eventsOf().find(event => event.type === 'tool/call')
  assert.equal((callRow?.data as { name?: string } | undefined)?.name, 'pr4_live_fixture',
    'the durable call row names the fixture tool (the Host executed it for real)')
  await waitFor('the follow-up turn settled', () =>
    fixture.vt.getViewport().join('').includes('tool turn complete'), 20_000)
  // The bounded generic fallback keeps the raw args visible (the mounted
  // unknown-tool contract; a Host presenter would never be consulted).
  const view = fixture.vt.getViewport().join('')
  assert.equal(view.includes('LIVE-TOOL-ARGS'), true,
    'the unknown tool\'s raw arguments render through the bounded generic fallback')
})

/* ───────── §7.4-10 KNOWN tool LIVE lifecycle (review F8 round 2) ─────── */

/** The KNOWN-tool live script: turn 1 requests an EDIT of a pre-seeded file
 *  (the Client presenter's known diff-card family). The tool's EXECUTION is
 *  held open by gating the model's SECOND turn — the durable call/result
 *  settle while the live phase is provably in flight. */
class EditToolLlmAdapter extends StubStreamingLlmAdapter {
  private turn = 0
  /** The test's OWN gate (the inherited base gate is consumed inside the base
   *  stream this override replaces): held between the live frames and the
   *  finish, so the live phase is provable and nothing can settle early. */
  private holdGate: Promise<void> | undefined
  private releaseHold: (() => void) | undefined

  hold(): () => void {
    this.holdGate = new Promise<void>(resolve => { this.releaseHold = resolve })
    return () => {
      const open = this.releaseHold
      this.holdGate = undefined
      this.releaseHold = undefined
      open?.()
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.turn += 1
    if (this.turn === 1) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'editing now' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'editing now' } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 1, id: ToolCallId('live-edit-1'), name: 'edit', argumentsDelta: JSON.stringify({ file_path: 'known-live-target.txt', old_string: 'LIVE-OLD', new_string: 'LIVE-NEW' }).slice(1, -1) }
      yield {
        type: 'block-end', index: 1,
        block: { type: 'tool-call', id: ToolCallId('live-edit-1'), name: 'edit', arguments: JSON.stringify({ file_path: 'known-live-target.txt', old_string: 'LIVE-OLD', new_string: 'LIVE-NEW' }) },
      }
      // HOLD here: the live frames above are observable, the turn is OPEN and
      // the Host cannot execute the tool (no finish) until the test releases.
      const gate = this.holdGate
      if (gate !== undefined) await gate
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* scriptedTextTurn('edit turn complete')
  }
}

test('KNOWN tool LIVE: an in-flight edit renders the Client diff card BEFORE the result settles, then settles from the durable facts', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-tool-known-live'
  const hostPreset = 'm3-4-pr2-preset'
  const adapter = new EditToolLlmAdapter()
  const host = await mountRemotePresentationHost(life, hostPreset, { llmAdapter: adapter })
  // The REAL filesystem tool suite (the known `edit` the Client presenter
  // derives its diff card from) over the fixture's real local fs.
  const toolFs = await import('@deepseek-ai/dsh-tool-fs')
  await host.ctx.plugin(toolFs)
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  writeFileSync(join(host.anchorDir, 'known-live-target.txt'), 'LIVE-OLD\n')
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host, productionSerializer: true })
  const editor = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void }

  // Gate the model turn BETWEEN the live frames and the finish: the card is
  // observable while the turn is provably open and NO durable tool row can
  // have landed (the Host executes the tool only after the finish).
  const release = adapter.hold()
  editor.setDraft('please edit the target file')
  editor.submitDraft()

  const durableOf = (): Array<{ type: string; data: unknown }> => (host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }).snapshotEvents()

  // LIVE phase, PROVABLY in-flight: the transient tool-call frames render
  // the KNOWN tool's SPECIALIZED Preparing card — evidence only that
  // derivation can produce: the `Preparing Edit known-live-target.txt` row
  // (the edit variant's design title + its `file_path` summary key), never
  // the prompt text (which says neither `Preparing` nor the file name) and
  // never a generic card (which carries no edit-specific title/path row).
  // The durable `tool/call`/`tool/result` rows are ABSENT (the turn cannot
  // settle while held — a settled-phase pass is impossible by construction,
  // not by timing luck).
  await waitFor('the known live edit preview rendered', () => {
    const view = fixture.vt.getViewport().join('')
    const durable = durableOf().map(event => event.type)
    return view.includes('Preparing Edit known-live-target.txt')
      && !durable.includes('tool/call') && !durable.includes('tool/result')
  }, 40_000)
  // COUNTERFACTUAL (review F8 round 4): the held row must come from the
  // edit-specialized summary derivation (title + `file_path` key), never
  // from a generic fallback — the edit summary keys pick `file_path` over
  // every other string arg, so the old/new strings (`LIVE-OLD`/`LIVE-NEW`)
  // CANNOT appear in the held view, while the generic raw-args fallback
  // would carry them. Removing the known-tool summary derivation is exactly
  // what makes these assertions fail.
  const heldView = fixture.vt.getViewport().join('')
  assert.ok(!heldView.includes('LIVE-OLD') && !heldView.includes('LIVE-NEW'),
    `the held card must be the specialized Preparing row, not a generic/raw-args fallback:\n${heldView}`)
  release()
  // The durable rows land only after the release.
  await waitFor('the durable edit rows landed', () => {
    const kinds = durableOf().map(event => event.type)
    return kinds.includes('tool/call') && kinds.includes('tool/result')
  }, 40_000)
  await waitFor('the settled edit card rendered', () => {
    const view = fixture.vt.getViewport().join('')
    return view.includes('known-live-target.txt')
  }, 40_000)
  await waitFor('the turn settled', () =>
    fixture.vt.getViewport().join('').includes('edit turn complete'), 40_000)
  // The durable execution really happened: the file carries the edit.
  const { readFileSync } = await import('node:fs')
  assert.equal(readFileSync(join(host.anchorDir, 'known-live-target.txt'), 'utf8'), 'LIVE-NEW\n',
    'the Host executed the edit for real (the known-tool card is not a mock)')
})

/* ───────── §7.4-5 literal skill gesture + Host pre-step (review F8) ────── */

test('literal skill gesture over a mounted Remote surface: the Client delivers the ORIGINAL line, the HOST pre-step injects the body', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-skill-gesture'
  const hostPreset = 'm3-4-pr2-preset'
  const BODY_MARKER = 'PR4-HOST-INJECTED-SKILL-BODY'
  const host = await mountRemotePresentationHost(life, hostPreset)
  // The Host-side skill authority the official `dsh-tool-skill` pre-step
  // reads. The Client NEVER loads a body on this branch (its semantic
  // resolveSkill is explicitly unavailable), so the marker can only come
  // from the Host pre-step.
  // The fixture Host mounts the REAL official Skill registry; the fixture
  // skill is a real runtime contribution on it (the Host pre-step reads the
  // same authority a filesystem provider would supply).
  host.ctx.skills.register({
    name: 'pr4-skill',
    description: 'the fixture skill',
    content: BODY_MARKER,
    source: 'runtime',
    invocation: { userInvocable: true, modelInvocable: false },
  })
  const toolSkill = await import('@deepseek-ai/dsh-tool-skill')
  await host.ctx.plugin(toolSkill as never, undefined as never)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host, productionSerializer: true })
  const editor = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void; getDraft(): string }
  const eventsOf = (): Array<{ type: string; data: unknown }> => (host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }).snapshotEvents()

  // Refresh the catalog explicitly (production `/reload`): installs the
  // snapshot that registers the skill wrapper for the gesture.
  editor.setDraft('/reload')
  editor.submitDraft()
  await waitFor('the catalog refresh applied with the skill', () =>
    fixture.vt.getViewport().join('').includes('skills'), 30_000)

  editor.setDraft('/pr4-skill do the thing')
  editor.submitDraft()

  // The gesture line travels VERBATIM as one ordinary user message (the SAME
  // transport-aware prepared-prompt pipeline an ordinary prompt uses) …
  await waitFor('the literal gesture line landed durably', () => eventsOf().some(event =>
    event.type === 'user/message' && JSON.stringify(event.data).includes('/pr4-skill do the thing')), 40_000)
  // … and the HOST pre-step injects the body.
  await waitFor('the Host pre-step injected the skill body', () => eventsOf().some(event =>
    event.type === 'user/message' && JSON.stringify(event.data).includes(BODY_MARKER)), 40_000)
  const literals = eventsOf().filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes('/pr4-skill do the thing'))
  assert.equal(literals.length, 1, 'EXACTLY ONE literal user gesture (never duplicated)')
  const injected = eventsOf().filter(event => event.type === 'user/message'
    && JSON.stringify(event.data).includes(BODY_MARKER))
  assert.equal(injected.length, 1, 'exactly one injected body message')
  assert.ok(JSON.stringify(injected[0]!.data).includes('skill-invocation'),
    'the injection rides the official skill-invocation source kind')
})

/* ───────── §7.4-7 mounted /status alias over a paged performance window ──── */

test('mounted /status (the /settings alias): lifetime totals and the RECENT figures come from the official projections', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-status-paged'
  const hostPreset = 'm3-4-pr2-preset'
  const host = await mountRemotePresentationHost(life, hostPreset)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  // The seeded committed turns carry the recent-sample evidence, folded by the
  // Session's OWN Host `piTuiPerformance` projection (TPS plan PR-2: the Client
  // no longer folds its bounded window, and the recent figures no longer
  // depend on how much history that window holds). CLOCK CONTRACT (round-5
  // hardening, review F8.2; wording corrected by TPS plan PR-3): the
  // projection's TTFB takes its first-token evidence from the FIRST visible
  // STREAM CHUNK time minus the `step/start` EVENT time (an earlier
  // `assistant/attempt` stream may supply that chunk time; this fixture
  // appends no attempt, so the `assistant/message` stream does), and its
  // per-step model span is the `assistant/message` EVENT time minus the
  // `step/start` EVENT time — both event times are the official Session's real
  // wall clock (append assigns Date.now()), while the stream chunk times are
  // fixture-controlled. So a legal non-zero sample needs the chunk times
  // anchored slightly after the step start AND a real wait before the
  // `assistant/message` append. The seeded span is ~100ms TTFB and ~400ms
  // model wall per sampled turn (settlement lands ≈anchor+400 after the real
  // wait), i.e. 200 tokens over ~0.4s ≈ 500 tok/s: a `TTFB 0.1s`-class and
  // bounded three-digit `tok/s` rendering — asserted as a REQUIRED MATCH
  // (assert.match throws on failure; the previous `exec() !== undefined` form
  // was vacuously true because exec returns null, not undefined).
  for (let turn = 1; turn <= 5; turn += 1) {
    const anchor = Date.now()
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', {
      id: `u-paged-${turn}`, role: 'user', content: [{ type: 'text', text: `paged prompt ${turn}` }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    // The assistant/message must land at a WALL time after the step start for
    // the model span to be observable: wait past the whole seeded chunk window
    // BEFORE appending the settlement (the event time is the Session's real
    // Date.now(), the chunk times are the fixture's).
    await new Promise(resolve => setTimeout(resolve, 400))
    session.append('assistant/message', {
      turn, step: 1,
      message: { id: `a-paged-${turn}`, role: 'assistant', content: [{ type: 'text', text: `paged answer ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
      usage: { inputTokens: 1_000, outputTokens: 200 },
      stream: [
        { type: 'chunk', time: anchor + 100, chunk: { type: 'text-delta', index: 0, text: 'a' } },
        { type: 'chunk', time: anchor + 300, chunk: { type: 'text-delta', index: 0, text: 'b' } },
      ],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // Newer empty-stream turns (their events sit inside the newest window).
  seedTurns(session, 6, 40, 'paged-newer')

  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host, productionSerializer: true })
  const editor = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void }
  editor.setDraft('/status')
  editor.submitDraft()
  // `/status` is the `/settings` alias: the mounted Client registry executes
  // the ONE Settings handler and the real workspace paints About.
  await waitFor('the mounted /status alias opened Settings About', () =>
    fixture.vt.getViewport().join('\n').includes('About'), 30_000)
  // Wait for the About controller's scoped read to paint the Session facts
  // (the same barrier the C3 production lane uses) before driving the page.
  await waitFor('the About session facts painted', () => {
    const frame = fixture.vt.getViewport().join('\n')
    return frame.includes('Session ID') || frame.includes('Turns') || frame.includes('R5 tokens/sec')
  }, 30_000)
  // The About content is taller than this frame, so hand the keyboard to the
  // content and page through it — the same keys a user drives. The rows carry
  // the official lifetime stats and the Session's own `piTuiPerformance`
  // projection; the exact integer token totals prove a bounded-window read
  // could not be the source.
  fixture.vt.sendInput('\r')
  await waitFor('the About content took the keyboard', () =>
    fixture.vt.getViewport().join('\n').includes('c copy fact'), 15_000)
  let panelView = ''
  for (let page = 0; page < 6; page += 1) {
    panelView += `\n${fixture.vt.getViewport().join('\n')}`
    // Stop only once EVERY figure this case asserts is actually painted in the
    // collected pages: a long private root wraps the CWD fact over more rows,
    // so TTFB can be the last visible row of a page while R5 is the next one.
    if (/Input tokens\s+5035/u.test(panelView)
      && /TTFB \(recent\)\s+0\.[1-9]\d*s/u.test(panelView)
      && /R5 tokens\/sec\s+[1-9]\d*(?:\.\d)? tok\/s/u.test(panelView)) break
    fixture.vt.sendInput('\x1b[6~') // PageDown: scroll the painted About rows.
    await fixture.vt.waitForRender()
  }
  assert.match(panelView, /Input tokens\s+5035/u,
    `the About lifetime input total is the projection value:\n${panelView}`)
  assert.match(panelView, /Output tokens\s+1035/u,
    `the About lifetime output total is the projection value:\n${panelView}`)
  // RECENT evidence (TPS plan PR-2): the measured performance values come
  // from the SESSION's own Host `piTuiPerformance` projection, which folds
  // the SAME committed turns regardless of how much history the Client's
  // bounded window happens to hold — no `loadOlder()` and no window fold can
  // influence them. REQUIRED MATCHES: the seeded first chunk lands ~100ms
  // after `step/start` → a `0.1s`-class TTFB; the rate is 200 tokens over the
  // ~400ms request wall → a non-zero tok/s figure.
  assert.match(panelView, /TTFB \(recent\)\s+0\.[1-9]\d*s/u,
    `the About report must show the seeded non-zero TTFB:\n${panelView}`)
  assert.match(panelView, /R5 tokens\/sec\s+[1-9]\d*(?:\.\d)? tok\/s/u,
    `the About report must show the seeded non-zero R5 rate:\n${panelView}`)
  // FOOTER consistency: the footer reads the SAME status facts as About, so
  // it shows the same Host-projection figures — never the no-sample zeros.
  const footerRows = (fixture.runnerApp() as unknown as {
    footerRenderRowsForTest(): readonly string[]
  }).footerRenderRowsForTest()
  const footerText = footerRows.join(' ')
  assert.match(footerText, /TTFB 0\.[1-9]\d*s/u,
    `the footer's recent figures are the Host projection's:\n${footerText}`)
  // TPS plan PR-3: the DEFAULT footer layout shows the combined pair — the
  // real Host → Client → Footer chain must deliver BOTH scopes to the
  // rendered footer row, with the singular `tok/s` unit. Each scope keeps its
  // own decimal policy (see `displayRate`): the assertion must not encode an
  // integer-only assumption the load-dependent wall time can break.
  assert.match(footerText, /R5 [1-9]\d*(?:\.\d)? · All [1-9]\d*(?:\.\d)? tok\/s/u,
    `the footer must render the default R5 + All pair from the Host projection:\n${footerText}`)
})

/* ─────────── PR5 §12 Slice E: real-holder writer-held recovery ─────────── */

/** The two-process Session-writer holder (see test/support). */
const SESSION_WRITER_HOLDER = fileURLToPath(new URL('../support/session-writer-holder.mjs', import.meta.url))

interface WriterHolder {
  /** SIGKILL the holder and await its exit (idempotent). */
  kill(): Promise<void>
}

/** Start the holder against the fixture Host's shared persistence root and wait
 *  until it reports `holding`. */
async function startWriterHolder(
  life: TestLifecycle,
  host: Awaited<ReturnType<typeof mountRemotePresentationHost>>,
  sessionId: string,
): Promise<WriterHolder> {
  const child = spawn(process.execPath, [
    SESSION_WRITER_HOLDER,
    join(host.workRoot, 'persistence'),
    sessionId,
    host.anchorDir,
  ], { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise<void>(resolve => { child.once('exit', () => { resolve() }) })
  const kill = async (): Promise<void> => {
    if (child.exitCode === null) child.kill('SIGKILL')
    await exited
  }
  life.defer(kill)
  await once(child.stdout!, 'data')
  return { kill }
}

/** Read the durable events straight off the Host persistence root. */
async function readDurableEvents(
  host: Awaited<ReturnType<typeof mountRemotePresentationHost>>,
  sessionId: string,
): Promise<readonly { readonly type: string; readonly data?: unknown }[]> {
  const persistence = (host.ctx as unknown as {
    sessionPersistence: {
      open(id: unknown, mode: 'read'): Promise<{
        read(): Promise<{ events: readonly { type: string; data?: unknown }[] }>
        close(): Promise<void>
      }>
    }
  }).sessionPersistence
  const handle = await persistence.open(SessionId(sessionId), 'read')
  try {
    const read = await handle.read()
    return read.events
  } finally {
    await handle.close()
  }
}

/** Read the durable event types straight off the Host persistence root. */
async function readDurableEventTypes(
  host: Awaited<ReturnType<typeof mountRemotePresentationHost>>,
  sessionId: string,
): Promise<readonly string[]> {
  return (await readDurableEvents(host, sessionId)).map(event => event.type)
}

test('a REAL two-process writer-held Remote Session — prompt, /title and /preset recover structurally, and an explicit retry commits after the holder exits', async (t) => {
  const life = testLifecycle(t)
  const heldId = 'm3-5-pr5-writer-held'
  const hostPreset = 'm3-4-pr2-preset'
  const altPreset = 'm3-5-pr5-alt-preset'
  const promptText = 'a prompt against a held writer'
  const host = await mountRemotePresentationHost(life, hostPreset)
  // FAIL-CLOSED PRECONDITION: another process owns the kernel write lease.
  const holder = await startWriterHolder(life, host, heldId)
  // The runner resumes the EXTERNALLY persisted cold Session: the read/open is
  // allowed, the write lease is not.
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: heldId,
    host,
    productionSerializer: true,
    extraPresetIds: [altPreset],
  })
  const editor = fixture.runnerApp() as unknown as {
    setDraft(text: string): void
    submitDraft(): void
    getDraft(): string
  }
  const viewport = (): string => fixture.vt.getViewport().join('')
  /** The displayed/current Session preset authority the runner reads on Remote
   *  (`SessionReader.sessionStatus(id).preset` — the same read `/preset status`
   *  and the picker's "← current" mark consume). */
  const displayedPreset = (sessionId: string): string | undefined =>
    fixture.aggregate.presentation.sessionFacts.sessionStatus(sessionId)?.preset
  /** The RENDERED welcome-card preset row — the real user-visible sink fed by
   *  `updateWelcomeCard()`/`app.setWelcomeCard(...)`. The box layout pads the
   *  label, so a restored `/preset <id>` editor line (one space) never matches. */
  const renderedPresetRow = (): string | undefined =>
    fixture.vt.getViewport().find(row => /\bpreset\s{2,}\S/u.test(row))

  // ---- E2: ordinary prompt source -> decision -> sink --------------------
  editor.setDraft(promptText)
  editor.submitDraft()
  await waitFor('the writer-held guidance rendered for the prompt', () =>
    viewport().includes('already in use'), 40_000)
  assert.equal(editor.getDraft(), promptText,
    'the human draft is restored EXACTLY once (a double restore would append it twice)')
  assert.ok(!viewport().includes('Submitting'), 'the optimistic submit row is terminally settled')
  assert.ok(!viewport().includes('submission failed'),
    'a proven refusal never takes the generic submission-failure path')
  assert.deepEqual(await readDurableEventTypes(host, heldId), ['turn/start', 'turn/end'],
    'the refused prompt appended NO durable user/message')
  assert.equal(host.ctx.agents.get(SessionId(heldId)), undefined,
    'the refused write never activated a Host Agent')

  // ---- E3: /title <name> (secondary surface) -----------------------------
  editor.setDraft('/title held-title')
  editor.submitDraft()
  await waitFor('the held /title restores the command with the guidance', () =>
    editor.getDraft() === '/title held-title' && viewport().includes('already in use'), 40_000)
  assert.ok(!viewport().includes('title set:'),
    'no fake title success notice on a refused rename')
  assert.deepEqual(await readDurableEventTypes(host, heldId), ['turn/start', 'turn/end'],
    'the refused rename mutated no durable title state')

  // ---- E4: /preset <id> (secondary surface) ------------------------------
  // The displayed/current preset baseline BEFORE the refused switch (an
  // intentionally ABSENT value is a real baseline here: the externally created
  // Session carries no preset row, so the guard is "it never becomes the
  // requested alternate"; the durable-log assertion below is the authoritative
  // proof that the switch never committed). BOTH the render-visible welcome
  // row and the projection read are compared before/after.
  const heldDisplayBefore = displayedPreset(heldId)
  const heldRenderedBefore = renderedPresetRow()
  assert.notEqual(heldDisplayBefore, altPreset,
    'the held Session must not already display the requested alternate preset')
  assert.ok(!(heldRenderedBefore ?? '').includes(altPreset),
    'the rendered welcome card must not already show the requested alternate preset')
  editor.setDraft(`/preset ${altPreset}`)
  editor.submitDraft()
  await waitFor('the held /preset restores the command with the guidance', () =>
    editor.getDraft() === `/preset ${altPreset}` && viewport().includes('already in use'), 40_000)
  assert.ok(!viewport().includes('preset switched to'),
    'no optimistic preset selection on a refused switch')
  assert.deepEqual(await readDurableEventTypes(host, heldId), ['turn/start', 'turn/end'],
    'the refused preset switch appended no agent-preset/selected')
  assert.equal(displayedPreset(heldId), heldDisplayBefore,
    'the refused switch did not repaint the displayed Session preset')
  assert.equal(renderedPresetRow(), heldRenderedBefore,
    'the refused switch did not repaint the rendered welcome-card preset row')

  // ---- D4: explicit recovery positive control ----------------------------
  await holder.kill()
  editor.setDraft('/title recovered-title')
  editor.submitDraft()
  const recoveredTitleRow = (): { readonly type: string; readonly data: unknown } | undefined =>
    (host.ctx.sessions.get(SessionId(heldId)) as unknown as {
      snapshotEvents(): Array<{ readonly type: string; readonly data: unknown }>
    } | undefined)?.snapshotEvents().find(event => event.type === 'session/title'
      && (event.data as { readonly title?: unknown } | undefined)?.title === 'recovered-title')
  await waitFor('the explicit retry commits the exact recovered title', () =>
    recoveredTitleRow() !== undefined, 40_000)
  assert.equal((recoveredTitleRow()!.data as { readonly source?: { readonly kind?: string } }).source?.kind, 'user',
    'the committed title is the real user rename, never a generated one')
  assert.notEqual(displayedPreset(heldId), altPreset,
    'the explicit recovery must not surface the refused alternate preset')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(editor.getDraft(), '',
    'the settled successful /title command is consumed, not restored')
})

test('a TRUE indeterminate Remote /preset <id> is consumed by the outer settlement and never restored', async (t) => {
  // The fact under test is the APPLICATION draft disposition after a genuine
  // indeterminate result, not Host writer ownership (plan §12 E5). The Remote
  // preset operation result is therefore controlled at the adapter port; the
  // handler, the command settlement owner and the TUI surface stay real, and
  // the gesture is driven through the real editor (`submitDraft`), never by
  // calling the handler directly.
  const life = testLifecycle(t)
  const mainId = 'm3-5-pr5-preset-indeterminate'
  const hostPreset = 'm3-4-pr2-preset'
  const committedPreset = 'm3-5-pr5-preset-a'
  const altPreset = 'm3-5-pr5-preset-b'
  const host = await mountRemotePresentationHost(life, hostPreset)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host,
    productionSerializer: true,
    extraPresetIds: [committedPreset, altPreset],
  })
  const editor = fixture.runnerApp() as unknown as {
    setDraft(text: string): void
    submitDraft(): void
    getDraft(): string
  }
  const sessionEvents = (): Array<{ readonly type: string }> =>
    (host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ readonly type: string }>
    }).snapshotEvents()
  /** The displayed/current Session preset authority (`/preset status`, the
   *  picker's "← current" mark). */
  const displayedPreset = (): string | undefined =>
    fixture.aggregate.presentation.sessionFacts.sessionStatus(mainId)?.preset
  /** The RENDERED welcome-card preset row — the real user-visible sink fed by
   *  `updateWelcomeCard()`/`app.setWelcomeCard(...)`, independently of the
   *  projection read above. */
  const renderedPresetRow = (): string | undefined =>
    fixture.vt.getViewport().find(row => /\bpreset\s{2,}\S/u.test(row))
  const viewport = (): string => fixture.vt.getViewport().join('')

  // A REAL, committed switch first: it gives the displayed/current preset a
  // DEFINED authoritative baseline (the guard below is then non-trivial) AND
  // makes the rendered welcome-card preset row observable.
  editor.setDraft(`/preset ${committedPreset}`)
  editor.submitDraft()
  await waitFor('the real preset switch commits', () => displayedPreset() === committedPreset, 40_000)
  await waitFor('the rendered welcome card shows the committed preset', () =>
    (renderedPresetRow() ?? '').includes(committedPreset), 30_000)
  const baselinePreset = displayedPreset()
  assert.equal(baselinePreset, committedPreset,
    'the live Session displays its authoritative committed preset before the indeterminate switch')
  assert.ok((renderedPresetRow() ?? '').includes(committedPreset),
    'the rendered welcome card is the authoritative baseline before the indeterminate switch')
  const commitsBefore = sessionEvents().filter(event => event.type === 'agent-preset/selected').length
  assert.equal(commitsBefore, 1, 'the real baseline switch committed exactly one durable selection')

  // Only now replace the Remote preset operation result with a TRUE
  // indeterminate one: the fact under test is the application draft
  // disposition, not Host writer ownership.
  const presets = fixture.aggregate.selected.backend.catalog.presets
  let dispatches = 0
  Object.assign(fixture.aggregate.selected.backend.catalog, {
    presets: {
      available: () => presets.available(),
      roster: (signal?: AbortSignal) => presets.roster(signal),
      resolve: (id?: string, signal?: AbortSignal) => presets.resolve(id, signal),
      defaultId: () => presets.defaultId(),
      selectSessionPreset: async () => {
        dispatches += 1
        return {
          ownership: 'current' as const,
          outcome: {
            kind: 'indeterminate' as const,
            error: { code: 'agent-preset/select-indeterminate', message: 'the recompose ran but the durable append failed' },
          },
        }
      },
    },
  })

  editor.setDraft(`/preset ${altPreset}`)
  editor.submitDraft()
  await waitFor('the indeterminate preset notice rendered', () =>
    fixture.vt.getViewport().join('').includes('do not retry'), 30_000)
  assert.equal(dispatches, 1, 'the switch dispatched exactly once — no automatic retry')
  assert.equal(editor.getDraft(), '',
    'a true indeterminate result must NOT restore the typed command as retry-ready intent')
  assert.ok(!fixture.vt.getViewport().join('').includes('preset switched to'),
    'no optimistic preset selection is presented')
  assert.equal(displayedPreset(), baselinePreset,
    'an indeterminate switch leaves the displayed/current Session preset at its authoritative value')
  assert.ok((renderedPresetRow() ?? '').includes(committedPreset),
    'the rendered welcome-card preset row still shows the authoritative preset')
  assert.ok(!viewport().includes(altPreset),
    'the requested alternate preset never reaches the rendered surface (the suppressed draft is empty)')
  assert.equal(sessionEvents().filter(event => event.type === 'agent-preset/selected').length, commitsBefore,
    'an indeterminate switch commits no durable preset selection')
})

test('a TRUE indeterminate Remote /title <name> is consumed by the outer settlement and surfaces the no-retry notice', async (t) => {
  // External review F5: the `/title` indeterminate branch suppresses the draft
  // disposition, but the Remote Client-owned command path renders no command
  // card either — so without its own notice the user saw the command vanish
  // with no explanation. As in the `/preset` E5 case, the fact under test is
  // the APPLICATION disposition/presentation, so only the Remote operation
  // result is controlled; the handler, the command settlement owner, the TUI
  // surface and the editor gesture stay real.
  const life = testLifecycle(t)
  const mainId = 'm3-5-pr5-title-indeterminate'
  const hostPreset = 'm3-4-pr2-preset'
  const host = await mountRemotePresentationHost(life, hostPreset)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host,
    productionSerializer: true,
  })
  const editor = fixture.runnerApp() as unknown as {
    setDraft(text: string): void
    submitDraft(): void
    getDraft(): string
  }
  const sessionEvents = (): Array<{ readonly type: string }> =>
    (host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ readonly type: string }>
    }).snapshotEvents()

  // The COMPOSED Remote session writer is the /title handler's business owner:
  // replace only its operation result with a post-dispatch uncertainty.
  const writer = fixture.aggregate.selected.backend.sessionWriter
  let renames = 0
  Object.assign(writer, {
    rename: async () => {
      renames += 1
      return {
        kind: 'indeterminate' as const,
        error: { code: 'gateway/internal', message: 'the rename may have committed' },
      }
    },
  })

  editor.setDraft('/title indeterminate-title')
  editor.submitDraft()
  await waitFor('the indeterminate title notice is rendered', () =>
    fixture.vt.getViewport().join('').includes('do not retry'), 30_000)
  assert.equal(renames, 1, 'the rename dispatched exactly once — no automatic retry')
  assert.equal(editor.getDraft(), '',
    'an indeterminate title write must NOT restore the typed command as retry-ready intent')
  assert.ok(fixture.vt.getViewport().join('').includes('session title result is indeterminate'),
    'the user-visible notice names the indeterminate title settlement')
  assert.ok(!sessionEvents().some(event => event.type === 'session/title'),
    'the indeterminate rename committed no durable title row')
})

// ── C3 (Phase 3C): the Remote About source→sink proof ─────────────────────
//
// The OFFICIAL Remote projections (the retained binding's sessionStatus +
// sessionStats + tokenUsage + contextWindow, read through the production
// session-facts composer) feed the REAL AboutStatusController ops — the
// same bootstrap composition (sessionStatus direct, stats through
// composeRemoteSessionStats over the transport fence) — and the settled
// view serializes the OFFICIAL figures. This is the Remote half of the
// plan §3.3 proof 2: absent projections stay absent, no bounded-window
// fold ever stands in for a session total.
test('Remote proof: official projections → the About controller view → the exact report', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'c3-about-remote'
  const hostPreset = 'c3-about-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  {
    const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
      append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
    }
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', {
      id: 'u-c3', role: 'user', content: [{ type: 'text', text: 'about probe' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'a-c3', role: 'assistant',
        content: [{ type: 'text', text: 'about answer' }],
        source: { kind: 'model', provider: 'smoke', model: 'smoke' },
      },
      stream: [], usage: { inputTokens: 10, outputTokens: 5 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  try {
    // The OFFICIAL projection face reads settle (the same wait the status
    // test uses — the retained binding serves the projections).
    await waitFor('official sessionStatus retained', () =>
      fixture.override.presentation.sessionFacts.sessionStatus(mainId) !== undefined, 15_000)
    const status = fixture.override.presentation.sessionFacts.sessionStatus(mainId)
    assert.ok(status !== undefined)
    assert.equal(status.usage?.uncachedInputTokens, 10, 'the official tokenUsage projection of the seeded turn')

    // The controller ops are the BOOTSTRAP composition, reduced to the same
    // official inputs (sessionStatus direct; stats through
    // composeRemoteSessionStats over the transport fence).
    const fenceOf = (sessionId: string): { isCurrent(): boolean } => {
      const token = fixture.override.presentation.sessionFacts.captureTransportToken(sessionId)
      return {
        isCurrent: () => fixture.override.presentation.sessionFacts.isTransportTokenCurrent(sessionId, token),
      }
    }
    const { composeRemoteSessionStats } = await import('../../src/app/remote/session-facts-compose.ts')
    const { AboutStatusController } = await import('../../src/app/command/about-status.ts')
    const { createDiag } = await import('../../src/runtime/process/diagnostics.ts')
    const controller = new AboutStatusController({
      backendKind: 'remote',
      captureLiveSessionScope: () =>
        ({ sessionId: mainId, subject: { owner: { id: mainId } }, generation: 1 }) as never,
      isSessionScopeCurrent: (scope) => (scope as { readonly sessionId?: string }).sessionId === mainId,
      currentSessionStats: async (scope) => {
        const sessionId = (scope as { readonly sessionId: string }).sessionId
        const statusNow = fixture.override.presentation.sessionFacts.sessionStatus(sessionId)
        return composeRemoteSessionStats({
          sessionId,
          fence: fenceOf(sessionId),
          facts: {
            sessionStats: fixture.override.presentation.sessionFacts.sessionStatsProjection(sessionId),
            usage: statusNow?.usage,
            contextWindow: statusNow?.context?.contextWindow,
            performance: statusNow?.performance,
          },
        })
      },
      readSessionStatus: (sessionId) => fixture.override.presentation.sessionFacts.sessionStatus(sessionId),
      sessionStatusFailed: () => false,
      forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' }),
      versionFacts: { tui: 'test', dsh: undefined },
      subscribeSessionScopeInvalidation: () => () => {},
      diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    })
    controller.enter()
    for (let at = 0; at < 20 && controller.snapshotView().session.kind === 'loading'; at += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
    const view = controller.snapshotView()
    assert.equal(view.session.kind, 'ready', `the Remote view settles: ${JSON.stringify(view.session)}`)
    if (view.session.kind !== 'ready') return
    assert.equal(view.session.sessionId, mainId)
    assert.equal(view.session.cwd, seedHost.anchorDir, 'the OFFICIAL list-row cwd of THIS session')
    assert.ok(view.session.stats?.tokens !== undefined, 'the official tokenUsage group survives')
    assert.equal(view.session.stats.tokens.input, 10, 'the uncached input total is the projection value')
    assert.equal(view.session.stats.tokens.output, 5, 'the output total is the projection value')
    // The serialization is the COPY All contract over OFFICIAL facts.
    const { serializeAboutStatus } = await import('../../src/domain/status/about.ts')
    const report = serializeAboutStatus(view)
    assert.match(report, new RegExp(`Session ID: ${mainId}`, 'u'))
    assert.match(report, new RegExp(`CWD: ${seedHost.anchorDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'))
    assert.match(report, /Input tokens: 10/u)
    assert.match(report, /Output tokens: 5/u)
    assert.match(report, /Backend: Remote/u)
    assert.ok(!report.includes('unmeasured'), 'no legacy unmeasured word rides the report')
  } finally {
    await fixture.dispose()
  }
})

/**
 * The painted About `CWD` value, re-assembled from its OWN physical rows: the
 * fact head owns the first row, a wrapped value continues under the SAME value
 * column, and anything else ends the group. The label must be unique and the
 * value non-empty — a missing or duplicated CWD fact is a failure, never an
 * absent assertion.
 *
 * `complete` requires the NEXT semantic fact row to be painted inside the
 * About content area. The full-screen Settings surface pins its action bar as
 * the LAST frame row, so a group whose final row is the content bottom is
 * followed by that bar — a clipped value, never a complete one. In that case
 * the raw facts and the Copy All payload own the untouched value.
 */
function aboutCwdPaintedValue(rows: readonly string[]): { readonly value: string; readonly complete: boolean } {
  const head = 'CWD  '
  const starts = rows.flatMap((row, index) => row.includes(head) ? [index] : [])
  assert.equal(starts.length, 1, `exactly one painted CWD fact row:\n${rows.join('\n')}`)
  const first = starts[0]!
  const valueStart = rows[first]!.indexOf(head) + head.length
  const contentX = valueStart - 7
  // The frame pads every physical row to the panel width; the declared CWD is
  // a padding-free absolute path, so only that trailing fill is removed.
  const parts = [rows[first]!.slice(valueStart).trimEnd()]
  let next = first + 1
  // A wrapped value continues the fact under marker + head (7 columns): the
  // continuation is exactly that indentation, with content after it.
  while (next < rows.length
    && rows[next]!.startsWith(' '.repeat(7), contentX)
    && rows[next]!.length > valueStart) {
    parts.push(rows[next]!.slice(valueStart).trimEnd())
    next += 1
  }
  const value = parts.join('')
  assert.ok(value !== '', `the painted CWD fact carries a value:\n${rows.join('\n')}`)
  // Everything before the pinned bar is the About content area. Only a
  // DIFFERENT semantic fact painted after the group proves the value ended: a
  // clipped group is followed by the bar (or the frame bottom), never by a
  // fact row.
  const nextRow = next < rows.length - 1 ? rows[next]! : undefined
  const marker = nextRow?.slice(contentX, contentX + 2)
  const complete = nextRow !== undefined
    && (marker === '  ' || marker === '> ')
    && /^[A-Za-z]/.test(nextRow.slice(contentX + 2))
  return { value, complete }
}

// ── M6 Client identity: the Remote runner's ONE DSH version source ────────
test('Remote runner: the injected DSH install anchor is the version for Welcome/header/footer/About and stays stable after a Session opens', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('remote-runner-dsh-anchor-')
  const anchor = join(root, 'package.json')
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.2-anchor-b' }))
  const previousMode = process.env.SPLIT_PROCESS_CLIENT_MODE
  const previousAnchor = process.env.SPLIT_PROCESS_DSH_ANCHOR
  life.defer(() => {
    if (previousMode === undefined) delete process.env.SPLIT_PROCESS_CLIENT_MODE
    else process.env.SPLIT_PROCESS_CLIENT_MODE = previousMode
    if (previousAnchor === undefined) delete process.env.SPLIT_PROCESS_DSH_ANCHOR
    else process.env.SPLIT_PROCESS_DSH_ANCHOR = previousAnchor
  })
  process.env.SPLIT_PROCESS_CLIENT_MODE = 'surface'
  process.env.SPLIT_PROCESS_DSH_ANCHOR = anchor

  const fixture = await mountRemoteRunner(life, { presetId: 'm3-4-pr2-preset' })
  const expectedDsh = '0.2.2-anchor-b'
  const expectedTui = bundleVersion()
  assert.notEqual(expectedDsh, expectedTui, 'the test pins deliberately different DSH and TUI versions')
  const viewport = (): string => fixture.vt.getViewport().join('\n')
  const app = fixture.runnerApp() as unknown as {
    setFooterLayout(layout: unknown): void
    footerRenderRowsForTest(): readonly string[]
    headerRenderRowsForTest(): readonly string[]
    setDraft(text: string): void
    submitDraft(): void
  }
  await waitFor('the Remote Welcome paints the injected DSH and true TUI versions', () =>
    viewport().includes(`dsh-${expectedDsh} · tui-v${expectedTui}`), 20_000)
  assert.ok(app.headerRenderRowsForTest().join('\n').includes(`dsh-${expectedDsh} · tui-v${expectedTui}`),
    'the real header badge reads the same Client DSH identity')

  // The footer's three formats read StatusSnapshot.host.{dshVersion,tuiVersion}.
  app.setFooterLayout({
    schemaVersion: 1,
    rows: [{
      left: [
        { id: 'version', format: 'tui' },
        { id: 'version', format: 'dsh' },
        { id: 'version', format: 'both' },
      ],
      right: [],
    }],
  })
  await waitFor('the footer version formats read the same status facts', () => {
    const footer = app.footerRenderRowsForTest().join(' ')
    return footer.includes(`v${expectedTui}`)
      && footer.includes(`dsh-${expectedDsh}`)
      && footer.includes(`dsh-${expectedDsh}/tui-${expectedTui}`)
  }, 20_000)

  const execute = (line: string): void => {
    app.setDraft(line)
    app.submitDraft()
  }
  // Open a Session: the version is the Client process's install identity, so
  // it must not change with Session ownership.
  const before = (await fixture.aggregate.selected.backend.sessionReader.list(undefined)) ?? []
  const beforeIds = new Set(before.map(row => String(row.id)))
  execute('/new')
  const deadline = Date.now() + 20_000
  for (;;) {
    const rows = (await fixture.aggregate.selected.backend.sessionReader.list(undefined)) ?? []
    if (rows.some(row => !beforeIds.has(String(row.id)))) break
    if (Date.now() > deadline) throw new Error('timed out waiting for /new to create a Host Session')
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  await waitFor('the header still reports the same DSH identity after a Session opens', () =>
    app.headerRenderRowsForTest().join('\n').includes(`dsh-${expectedDsh} · tui-v${expectedTui}`), 20_000)

  // About reads the SAME Client version facts through the real Settings
  // command factory (`aboutVersionFacts`) and AboutStatusController.
  execute('/settings')
  await waitFor('the About runtime facts paint the injected DSH version', () => {
    const frame = viewport()
    return frame.includes('DSH') && frame.includes(expectedDsh)
  }, 20_000)
  assert.equal(viewport().includes('Unknown'), false,
    'a proven install anchor never paints Unknown/0.0.0 in the Remote version surfaces')
})

// ── C3 (Phase 3C): the PRODUCTION-RUNNER Remote source→sink proof ─────────
//
// The plan §3.3 Remote positive through the REAL production composition: the
// real mounted runner (PiTui branch over the real rc.2 Host) serves /settings
// through the REAL submit gesture (the Client command registry executes the
// TUI built-in), the REAL SettingsWorkspacePanel paints the About rows from
// the real command-runtime reads, and a REAL SGR click on the painted
// [Copy All C] button drives the production clipboard policy — the OSC 52
// sequence lands in the virtual terminal's captured stdout writes and its
// base64 payload decodes to the exact report (official projection facts,
// Backend: Remote). A second session seeded WITHOUT the performance/usage
// projection rows is the absent-authority negative: the report words the
// gap, never a fabricated figure.
test('Remote production lane: /settings → real About panel → [Copy All] click → OSC 52 payload', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'c3-prod-remote'
  const hostPreset = 'c3-prod-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  {
    const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
      append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
    }
    // The turn's wall time is REAL (the assistant settlement lands after the
    // step start) and the streamed chunk carries its own timing, so the Host
    // `piTuiPerformance` projection folds a REAL sample: a non-zero TTFB and
    // non-zero rates — never a fabricated figure.
    const anchor = Date.now()
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', {
      id: 'u-p1', role: 'user', content: [{ type: 'text', text: 'prod probe' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    // The Host performance fold needs a REAL positive wall-clock span between
    // step/start and the assistant settlement; this time window IS the
    // contract and no observable signal can stand in for it — Reason stated.
    await new Promise(resolve => setTimeout(resolve, 400))
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: 'a-p1', role: 'assistant',
        content: [{ type: 'text', text: 'prod answer' }],
        source: { kind: 'model', provider: 'smoke', model: 'smoke' },
      },
      usage: { inputTokens: 33, outputTokens: 7 },
      stream: [
        { type: 'chunk', time: anchor + 100, chunk: { type: 'text-delta', index: 0, text: 'a' } },
      ],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  // The clipboard-isolation window opens BEFORE the runner mounts: the
  // composition constructs `ClientActions` DURING `mountRemoteRunner` and
  // captures `process.platform` by value at that moment, so the platform
  // stub MUST be in place first (a post-mount overwrite arrives too late —
  // the captured `copyEnv.platform` would still say darwin/win32 and the
  // helper leg would spawn pbcopy/clip on those hosts). With the stub in
  // place before the capture, `copyEnv.platform` reads a family with no
  // helper chain; the tmux/desktop env facts are cleared for the live
  // `process.env` references; and the stdout capture observes the production
  // OSC 52 emission. The stubs restore the ORIGINAL descriptors in the
  // finally below.
  const oscWrites: string[] = []
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const originalWrite = Object.getOwnPropertyDescriptor(process.stdout, 'write')
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalEnvTMUX = process.env.TMUX
  const originalEnvDISPLAY = process.env.DISPLAY
  const originalEnvWAYLAND = process.env.WAYLAND_DISPLAY
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  Object.defineProperty(process.stdout, 'write', {
    configurable: true,
    value: (data: string | Uint8Array): boolean => {
      if (typeof data === 'string' && data.includes('\x1b]52;c;')) oscWrites.push(data)
      return true
    },
  })
  Object.defineProperty(process, 'platform', { configurable: true, value: 'browser' })
  delete process.env.TMUX
  delete process.env.DISPLAY
  delete process.env.WAYLAND_DISPLAY
  // THE PROTECTED WINDOW covers setup, mount AND test body: even a mount
  // failure cannot leak the stubbed globals past this test. The fixture slot
  // is declared OUTSIDE the try so the finally can dispose a mounted fixture
  // and skip cleanly when the mount itself failed.
  let fixture: Awaited<ReturnType<typeof mountRemoteRunner>> | undefined
  try {
    fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
    assert.ok(fixture !== undefined, 'the runner mount must succeed for this lane')
    const mountedFixture = fixture
    await waitFor('official facts retained', () =>
      mountedFixture.override.presentation.sessionFacts.sessionStatus(mainId) !== undefined, 15_000)

    // ── THE REAL GESTURE: submit /settings through the mounted editor. ──
    const execute = (line: string): void => {
      const editorApp = mountedFixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void }
      editorApp.setDraft(line)
      editorApp.submitDraft()
    }
    execute('/settings')
    await waitFor('the Settings workspace leased the screen', () =>
      mountedFixture.vt.getViewport().join('\n').includes('dsh-pi-tui'), 15_000)

    // The About home paints the semantic fact rows from the REAL command
    // runtime's reads (the official Remote projections). Only the labels that
    // are ALWAYS above the value wrap (Session ID and the CWD fact's own head)
    // are required here: a long private root wraps the CWD value over more
    // physical rows and pushes the lower groups below the frame, so those are
    // asserted on the SCROLLED frame below.
    await waitFor('the About facts paint from the official projections', () => {
      const frame = mountedFixture.vt.getViewport().join('\n')
      return frame.includes('Session ID') && frame.includes('CWD  ')
    }, 15_000)
    const frameText = mountedFixture.vt.getViewport().map((line: string) => line).join('\n')
    assert.ok(frameText.includes('c3-prod-remote'), 'the OFFICIAL session id paints')
    assert.ok(frameText.includes('Backend') && frameText.includes('Remote'), 'the Remote backend fact paints')
    // THE OFFICIAL CWD, from the PHYSICAL rows of its own fact: a long private
    // root wraps the value under the fact column, so the raw path can never be
    // required as one contiguous frame substring. When the frame ends inside
    // the group the visible value is the correct prefix; the untouched full
    // path stays proven by the raw facts and the Copy All payload.
    const cwdPainted = aboutCwdPaintedValue(mountedFixture.vt.getViewport())
    if (cwdPainted.complete) {
      assert.equal(cwdPainted.value, seedHost.anchorDir,
        `the official cwd paints every cell of its own fact:\n${frameText}`)
    } else {
      assert.ok(seedHost.anchorDir.startsWith(cwdPainted.value),
        `the visible cwd prefix is the official value: ${JSON.stringify(cwdPainted.value)}`)
    }

    // ── THE REAL COPY: SGR press/release on the painted [Copy All C]. ──
    // The action row paints BELOW the fold at 100×30: the About-local End
    // key jumps the offset to the bottom (the same keyboard a user drives).
    // Each step waits for the FRAME it causes (a state barrier, never a
    // fixed delay): Enter hands the keyboard to the content — the action
    // bar's hint text flips to the About verbs; PageDown scrolls the rows.
    mountedFixture.vt.sendInput('\r') // Enter: the rail hands the keyboard to the content.
    await waitFor('the content focus took the keyboard', () =>
      mountedFixture.vt.getViewport().join('\n').includes('c copy fact'), 15_000)

    // NEGATIVE CONTROL for the completion rule: a short 100×12 frame makes the
    // CWD fact's FIRST row the last row of the About content area, so its value
    // is clipped while the pinned action bar still paints as the last row. A
    // bar row after the group must never be read as "the value ended".
    mountedFixture.vt.resize(100, 12)
    await waitFor('the short About frame paints the clipped CWD fact', () =>
      mountedFixture.vt.getViewport().join('\n').includes('CWD  '), 15_000)
    const clippedCwd = mountedFixture.vt.getViewport()
    const clipped = aboutCwdPaintedValue(clippedCwd)
    assert.equal(clipped.complete, false,
      `a CWD group clipped by the content bottom is never complete:\n${clippedCwd.join('\n')}`)
    assert.ok(clipped.value !== '' && seedHost.anchorDir.startsWith(clipped.value),
      `the clipped CWD paints a non-empty prefix of the official value: ${JSON.stringify(clipped.value)}`)
    // Restore the production 100×30 surface the rest of the lane drives.
    mountedFixture.vt.resize(100, 30)
    await waitFor('the full-size About frame is restored', () =>
      /Turns\s+1/.test(mountedFixture.vt.getViewport().join('\n')), 15_000)

    mountedFixture.vt.sendInput('\x1b[6~') // PageDown: scroll the painted rows to the bottom.
    await waitFor('the scrolled frame settled', () => {
      const view = mountedFixture.vt.getViewport().join('\n')
      return view.includes('Copy All [') || view.includes('Refresh context [')
    }, 15_000)
    const rows = mountedFixture.vt.getViewport()
    const actionRowIndex = rows.findIndex((line: string) => line.includes('Copy All ['))
    if (actionRowIndex === -1) {
      throw new Error(`POST-END FRAME:\n${rows.map((line: string, at: number) => `${String(at).padStart(2)}|${line}`).join('\n')}`)
    }
    void rows
    const actionRow = rows[actionRowIndex]!
    // The lifetime fold and the Host piTuiPerformance figures sit BELOW the
    // initial fold once the CWD fact wraps over several physical rows for a
    // long private root: assert them on the SCROLLED frame where they really
    // are visible. The Copy All payload below independently proves the same
    // values byte-for-byte.
    const scrolledText = rows.join('\n')
    assert.ok(/Turns\s+1\b/.test(scrolledText), `the lifetime turns paint: ${scrolledText.match(/Turns.*/)?.[0]}`)
    assert.ok(/Steps\s+1\b/.test(scrolledText), 'the lifetime steps paint')
    assert.ok(/TTFB \(recent\)\s+0\.[1-3]/.test(scrolledText), `the seeded TTFB paints: ${scrolledText.match(/TTFB.*/)?.[0]}`)
    assert.ok(/R5 tokens\/sec\s+[1-9]/.test(scrolledText), 'the seeded R5 rate paints non-zero')
    assert.ok(/All tokens\/sec\s+[1-9]/.test(scrolledText), 'the seeded All rate paints non-zero')
    const copyAllCol = actionRow.indexOf('Copy All [')
    mountedFixture.vt.sendInput(`\x1b[<0;${copyAllCol + 3};${actionRowIndex + 1}M`)
    mountedFixture.vt.sendInput(`\x1b[<0;${copyAllCol + 3};${actionRowIndex + 1}m`)
    await waitFor('the OSC 52 copy payload landed in the captured stdout', () => oscWrites.length > 0, 15_000)
    // THE EXACT PAYLOAD: decode the production OSC 52 payload and compare it
    // with the report the plan freezes — serialized from the SAME view the
    // panel painted.
    assert.ok(oscWrites.length > 0, 'the production copy policy emitted the OSC 52 leg')
    const osc = oscWrites[0]!
    const payload = /(?:\x1b\]52;c;)([^\x07]+)\x07/.exec(osc)?.[1]
    assert.ok(payload !== undefined, `the OSC 52 payload is present: ${JSON.stringify(osc.slice(0, 80))}`)
    const decoded = Buffer.from(payload!, 'base64').toString('utf8')
    const lines = decoded.split('\n')
    assert.equal(lines[0], 'dsh-pi-tui Status')
    assert.ok(lines.includes(`Session ID: ${mainId}`), `the official session id rides the payload: ${lines.slice(0, 8)}`)
    // THE EXACT official cwd (not just any line).
    assert.ok(lines.includes(`CWD: ${seedHost.anchorDir}`), `the official cwd rides the payload: ${lines.filter(l => l.startsWith('CWD'))}`)
    assert.match(decoded, /Backend: Remote/u)
    // The official lifetime + token groups of the seeded turn.
    assert.ok(lines.includes('Turns: 1'), `the lifetime rides the payload: ${lines.filter(l => /^(Turns|Steps|LLM)/.test(l))}`)
    assert.ok(lines.includes('Steps: 1'))
    assert.ok(lines.some(line => /^LLM wall: \d+(\.\d+)?s \(\d+ ms\)$/.test(line)), 'the LLM wall pair rides the payload')
    assert.match(decoded, /Input tokens: 33/u, 'the official tokenUsage total rides the payload')
    assert.match(decoded, /Output tokens: 7/u)
    // The MEASURED performance group of the seeded real sample.
    assert.match(
      decoded,
      /TTFB \(recent\): 0\.[1-3]s \(\d+(?:\.\d+)? ms\)/u,
      `the seeded TTFB display AND exact ms ride the payload: ${lines.filter(l => l.startsWith('TTFB'))}`,
    )
    assert.match(decoded, /R5 tokens\/sec: [1-9]/u, 'the seeded R5 rate rides the payload')
    assert.match(decoded, /All tokens\/sec: [1-9]/u, 'the seeded All rate rides the payload')

    // ── THE STRICT PAYLOAD EQUALITY (the owner's Q2 ruling): the ACTUAL
    // clipboard output of a SECOND Copy All on the SAME captured view — this
    // time through the keyboard `C` verb, a different gesture over the
    // unchanged view — must be byte-for-byte the report the first (mouse)
    // copy emitted. No re-serialization shortcut: both sides are the real
    // clipboard payloads the policy wrote.
    const oscWritesBeforeSecond = oscWrites.length
    mountedFixture.vt.sendInput('C')
    await waitFor('the keyboard Copy All payload landed', () => oscWrites.length > oscWritesBeforeSecond, 15_000)
    const osc2 = oscWrites[oscWritesBeforeSecond]!
    const payload2 = /(?:\x1b\]52;c;)([^\x07]+)\x07/.exec(osc2)?.[1]
    assert.ok(payload2 !== undefined)
    const decoded2 = Buffer.from(payload2!, 'base64').toString('utf8')
    assert.equal(decoded2, decoded, 'the SAME view copies the byte-identical report through two gestures (mouse click + keyboard C)')
  } finally {
    // Restore the ORIGINAL descriptors/identity (never a bound copy).
    if (originalWrite === undefined) {
      delete (process.stdout as { write?: unknown }).write
    } else {
      Object.defineProperty(process.stdout, 'write', originalWrite)
    }
    if (originalIsTTY === undefined) {
      delete (process.stdout as { isTTY?: unknown }).isTTY
    } else {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    }
    if (originalPlatform === undefined) {
      delete (process as { platform?: unknown }).platform
    } else {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (originalEnvTMUX === undefined) delete process.env.TMUX
    else process.env.TMUX = originalEnvTMUX
    if (originalEnvDISPLAY === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = originalEnvDISPLAY
    if (originalEnvWAYLAND === undefined) delete process.env.WAYLAND_DISPLAY
    else process.env.WAYLAND_DISPLAY = originalEnvWAYLAND
    await fixture?.dispose()
  }
})

// ── C3 (Phase 3C): the absent-authority negative through the SAME production
// runner route. The production Remote host-runtime mounts the lifetime rows
// unconditionally (that IS the reachable shape), so the ABSENT authority here
// is the measured-performance group (plus the context-pressure face): this
// session commits a completed turn with NO streamed settlement, so the Host
// piTuiPerformance projection has NO eligible sample and its rate face
// answers nothing, while the lifetime fold and the tokenUsage projection
// still hold their own authoritative values (the tokenUsage face publishes
// the AUTHORITATIVE ZERO for the usage-free log — an authoritative 0, never
// an absence). The About route must word the sample-less groups Unavailable,
// keep the authoritative ones (including the honest zero), and never fill a
// gap from a bounded-window fold.
test('Remote negative: the sample-less performance/context groups word Unavailable through the production route (tokenUsage stays the authoritative zero)', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'c3-absent-remote'
  const hostPreset = 'c3-absent-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  {
    const session = seedHost.ctx.sessions.get(SessionId(mainId)) as unknown as {
      append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
    }
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', {
      id: 'u-absent', role: 'user', content: [{ type: 'text', text: 'absent probe' }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  // The SAME pre-mount clipboard-isolation window as the positive lane: the
  // platform/env stubs MUST be in force before `mountRemoteRunner` captures
  // `copyEnv.platform`, and the TTY fact + stdout capture must be live before
  // the click (each test's finally restores the ORIGINAL descriptors — the
  // two lanes are sequential, so each re-opens its own window).
  const oscWrites: string[] = []
  const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY')
  const originalWrite = Object.getOwnPropertyDescriptor(process.stdout, 'write')
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const originalEnvTMUX = process.env.TMUX
  const originalEnvDISPLAY = process.env.DISPLAY
  const originalEnvWAYLAND = process.env.WAYLAND_DISPLAY
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  Object.defineProperty(process.stdout, 'write', {
    configurable: true,
    value: (data: string | Uint8Array): boolean => {
      if (typeof data === 'string' && data.includes('\x1b]52;c;')) oscWrites.push(data)
      return true
    },
  })
  Object.defineProperty(process, 'platform', { configurable: true, value: 'browser' })
  delete process.env.TMUX
  delete process.env.DISPLAY
  delete process.env.WAYLAND_DISPLAY
  // THE PROTECTED WINDOW covers setup, mount AND test body: even a mount
  // failure cannot leak the stubbed globals past this test. The fixture slot
  // is declared OUTSIDE the try so the finally can dispose a mounted fixture
  // and skip cleanly when the mount itself failed.
  let fixture: Awaited<ReturnType<typeof mountRemoteRunner>> | undefined
  try {
    fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
    assert.ok(fixture !== undefined, 'the runner mount must succeed for this lane')
    const mountedFixture = fixture
    await waitFor('official facts retained', () =>
      mountedFixture.override.presentation.sessionFacts.sessionStatus(mainId) !== undefined, 15_000)
    const execute = (line: string): void => {
      const editorApp = mountedFixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(): void }
      editorApp.setDraft(line)
      editorApp.submitDraft()
    }
    execute('/settings')
    await waitFor('the Settings workspace opened on the absent fixture', () =>
      mountedFixture.vt.getViewport().join('\n').includes('dsh-pi-tui'), 15_000)
    await waitFor('the authoritative lifetime group paints', () => {
      const frame = mountedFixture.vt.getViewport().join('\n')
      return frame.includes('Session ID') && frame.includes('CWD  ')
    }, 15_000)
    // The About content is taller than this frame once the CWD fact wraps over
    // several physical rows for a long private root: hand the keyboard to the
    // content and page to the pinned action row exactly like the positive lane
    // before clicking it. The lifetime values stay proven by the payload below.
    mountedFixture.vt.sendInput('\r')
    await waitFor('the About content took the keyboard', () =>
      mountedFixture.vt.getViewport().join('\n').includes('c copy fact'), 15_000)
    mountedFixture.vt.sendInput('\x1b[6~')
    await waitFor('the scrolled action row paints', () =>
      mountedFixture.vt.getViewport().join('\n').includes('Copy All ['), 15_000)
    const rows = mountedFixture.vt.getViewport()
    const actionRowIndex = rows.findIndex((line: string) => line.includes('Copy All ['))
    assert.ok(actionRowIndex !== -1, `the action row paints:\n${rows.join('\n')}`)
    const copyAllCol = rows[actionRowIndex]!.indexOf('Copy All [')
    // The clipboard-isolation window opened BEFORE this fixture mounted (see
    // the window above): the platform/env stubs are already in force and the
    // OUTER stdout capture is live — this click needs no further patching
    // (an inner re-patch would shadow the outer original descriptors and
    // leak the stub past the test).
    mountedFixture.vt.sendInput(`\x1b[<0;${copyAllCol + 3};${actionRowIndex + 1}M`)
    mountedFixture.vt.sendInput(`\x1b[<0;${copyAllCol + 3};${actionRowIndex + 1}m`)
    await waitFor('the absent-fixture OSC 52 payload landed', () => oscWrites.length > 0, 15_000)
    const osc = oscWrites[0]!
    const payload = /(?:\x1b]52;c;)([^\x07]+)\x07/.exec(osc)?.[1]
    assert.ok(payload !== undefined)
    const decoded = Buffer.from(payload!, 'base64').toString('utf8')
    // THE AUTHORITATIVE LIFETIME fold survives (one completed turn → its
    // own values), plus the identity/backend facts.
    assert.ok(decoded.includes(`Session ID: ${mainId}`))
    assert.ok(decoded.includes(`CWD: ${seedHost.anchorDir}`))
    assert.match(decoded, /Backend: Remote/u)
    assert.match(decoded, /Turns: 1/u, 'the authoritative lifetime fold rides the payload')
    assert.match(decoded, /Steps: 1/u)
    // THE ABSENT AUTHORITIES word the gap — never a fabricated figure.
    // The tokenUsage projection PUBLISHED its all-zero total (the official
    // face answers a usage-free durable log with the AUTHORITATIVE ZERO —
    // an honest 0, explicitly NOT an absence and never a window fold); the
    // measured performance group has NO eligible sample (no streamed
    // settlement), so its three lines word Unavailable — never a
    // fabricated rate.
    assert.match(decoded, /Input tokens: 0/u, 'the tokenUsage face publishes the authoritative zero for the usage-free log')
    assert.match(decoded, /Output tokens: 0/u)
    assert.match(decoded, /TTFB \(recent\): Unavailable/u, 'the sample-less performance group words Unavailable')
    assert.match(decoded, /R5 tokens\/sec: Unavailable/u)
    assert.match(decoded, /All tokens\/sec: Unavailable/u)
    assert.match(decoded, /Used tokens: Unavailable/u, 'the absent context pressure words Unavailable')
  } finally {
    // THE RESTORE covers the whole window — setup, mount AND test body — so
    // even a mount failure cannot leak the stubbed globals past this test.
    if (originalWrite === undefined) {
      delete (process.stdout as { write?: unknown }).write
    } else {
      Object.defineProperty(process.stdout, 'write', originalWrite)
    }
    if (originalIsTTY === undefined) {
      delete (process.stdout as { isTTY?: unknown }).isTTY
    } else {
      Object.defineProperty(process.stdout, 'isTTY', originalIsTTY)
    }
    if (originalPlatform === undefined) {
      delete (process as { platform?: unknown }).platform
    } else {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    if (originalEnvTMUX === undefined) delete process.env.TMUX
    else process.env.TMUX = originalEnvTMUX
    if (originalEnvDISPLAY === undefined) delete process.env.DISPLAY
    else process.env.DISPLAY = originalEnvDISPLAY
    if (originalEnvWAYLAND === undefined) delete process.env.WAYLAND_DISPLAY
    else process.env.WAYLAND_DISPLAY = originalEnvWAYLAND
    await fixture?.dispose()
  }
})

test('a Remote TSP /resume failure is visible once and an indeterminate outcome never restores the command', async (t) => {
  const life = testLifecycle(t)
  const presetId = 'prc-remote-resume-preset'
  const host = await mountRemotePresentationHost(life, presetId)
  await host.harness.create(SessionId('prc-current'), undefined, { cwd: host.anchorDir })
  await host.harness.create(SessionId('prc-target'), undefined, { cwd: host.anchorDir })
  const fixture = await mountRemoteRunner(life, {
    host,
    presetId,
    resumeSessionId: 'prc-current',
    renderer: 'tsp',
    sessionBrowser: true,
  })
  const pane = fixture.pane
  assert.ok(pane, 'the Remote TSP pane must be mounted')
  const composerText = (): string | undefined => {
    const composer = wireNodes({ frames: () => pane.frames() }).find(node => node.id === 'dock.composer')
    return typeof composer?.p === 'object' && composer.p !== null && typeof (composer.p as { text?: unknown }).text === 'string'
      ? (composer.p as { text: string }).text
      : undefined
  }
  const clearComposer = async (): Promise<void> => {
    for (let index = 0; index < (composerText() ?? '').length; index += 1) pane.input.type('\x7f')
    await waitFor('the composer to clear', () => (composerText() ?? '') === '', 15_000)
  }
  const submit = async (line: string): Promise<void> => {
    pane.input.type(line)
    await waitFor(`the composer to hold ${line}`, () => composerText() === line, 15_000)
    pane.input.type('\r')
  }
  const lifecycle = fixture.override.selected.backend.sessionLifecycle as unknown as {
    open: (...args: never[]) => Promise<unknown>
  }
  const originalOpen = lifecycle.open
  life.defer(() => { lifecycle.open = originalOpen })
  try {
    lifecycle.open = async () => ({
      ownership: 'current',
      outcome: { kind: 'unavailable', message: 'session "prc-target" is lease-held' },
    })
    await submit('/resume prc-target')
    await waitFor('the Remote failure notice', () => pane.output.text().includes('lease-held'), 25_000)
    assert.equal(pane.output.text().split('lease-held').length - 1, 1,
      'the card-less Remote route publishes the /resume failure exactly once')
    assert.equal(composerText(), '/resume prc-target',
      'a real failure keeps the command draft retryable')
    await clearComposer()

    lifecycle.open = async () => ({
      ownership: 'superseded',
      outcome: { kind: 'opened', handle: { session: { id: 'prc-target' } } },
    })
    await submit('/resume prc-target')
    await waitFor('the Remote indeterminate notice', () => pane.output.text().includes('do not retry automatically'), 25_000)
    assert.equal(pane.output.text().split('do not retry automatically').length - 1, 1,
      'the indeterminate result is visible exactly once')
    assert.equal(composerText(), '',
      'an indeterminate open is not restored as a retryable command')
  } finally {
    lifecycle.open = originalOpen
  }
})

// ── M4 PR4: the manual Client reload across the real composition ────────────

/** An LLM endpoint that counts REAL model requests (the negative witness). */
class CountingLlmAdapter extends StubStreamingLlmAdapter {
  streams = 0
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.streams += 1
    yield* super.stream(options)
  }
}

/**
 * The `/reload-client` command must ride the REAL production chain:
 * TuiApp input → the SubmissionController's existing line classifier → the
 * live Client registry → the composition root's Client-local safety gate →
 * the ONE process-owned capability injected through the internal startup
 * settlement. This suite proves the accepted and refused process decisions are
 * each reached EXACTLY once per bare command, that the fixed refusal notice is
 * the ONE visible outcome, and that neither path becomes a model prompt. The
 * Client-local safety reasons themselves are proven by the owner-level suites;
 * the real PTY/install/reload process proof is the two-package upgrade smoke
 * (U08).
 */
test('the live /reload-client command reaches the ONE process capability with its fixed notice', async (t) => {
  const life = testLifecycle(t)
  const results: ClientReloadRequestResult[] = []
  let next: ClientReloadRequestResult = { kind: 'accepted' }
  const adapter = new CountingLlmAdapter()
  const fixture = await mountRemoteRunner(life, {
    llmAdapter: adapter,
    // The argued-line control below is an ORDINARY submission (a real Host
    // turn), so this suite mounts the production prompt serializer.
    productionSerializer: true,
    startupSettlement: {
      surfaceReady: () => {},
      surfaceFailed: () => {},
      requestClientReload: () => {
        results.push(next)
        return next
      },
    },
  })
  try {
    const app = fixture.runnerApp() as unknown as { setDraft(text: string): void; submitDraft(request?: 'enter'): void }
    await waitFor('sessionless Remote surface', () => fixture.vt.getViewport().join('').length > 0, 20_000)
    const refusalNotice = 'Client reload failed: the installed replacement Client is unavailable or incompatible.'

    // 1. ACCEPTED: the live registry executes the bare command and the process
    //    capability is called exactly ONCE — with no duplicate notice and no
    //    model prompt.
    app.setDraft('/reload-client')
    app.submitDraft()
    await waitFor('accepted reload request', () => results.length === 1, 20_000)
    assert.deepEqual(results, [{ kind: 'accepted' }])
    assert.equal(adapter.streams, 0, 'the reload command became a model prompt')
    assert.doesNotMatch(fixture.vt.getViewport().join('\n'), /Client reload (blocked|failed|skipped)/u,
      'an accepted request published a redundant notice')

    // 2. REFUSED: the process decision's fixed notice is the ONE visible
    //    outcome and the same surface keeps accepting commands.
    next = { kind: 'refused', reason: 'target-invalid' }
    app.setDraft('/reload-client')
    app.submitDraft()
    await waitFor('refused reload request', () => results.length === 2, 20_000)
    await waitFor('refusal notice', () => fixture.vt.getViewport().join('\n').includes(refusalNotice), 20_000)
    assert.equal(fixture.vt.getViewport().join('\n').split(refusalNotice).length - 1, 1,
      'the refusal notice must be published exactly once')
    assert.equal(adapter.streams, 0, 'a refused reload became a model prompt')

    // 3. The ARGUED line is not an invocation: it never reaches the Client
    //    registry's reload handler (or the process capability) — it follows the
    //    ordinary submission route instead.
    app.setDraft('/reload-client anything')
    app.submitDraft()
    await waitFor('argued line became an ordinary submission', () => adapter.streams === 1, 20_000)
    assert.equal(results.length, 2, 'an argued /reload-client line reached the reload handler')
  } finally {
    await fixture.dispose()
  }
})

/** Seed one completed durable turn on a pre-mounted Host fixture. */
async function seedHostCompletedTurn(
  host: Awaited<ReturnType<typeof mountRemotePresentationHost>>,
  sessionId: string,
  prompt: string,
  response: string,
  cwd: string = host.anchorDir,
): Promise<void> {
  await host.harness.create(SessionId(sessionId), undefined, { cwd })
  const session = host.ctx.sessions.get(SessionId(sessionId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', {
    id: `u-${sessionId}`, role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1, step: 1,
    message: {
      id: `a-${sessionId}`, role: 'assistant',
      content: [{ type: 'text', text: response }],
      source: { kind: 'model', provider: 'smoke', model: 'smoke' },
    },
    stream: [], usage: { inputTokens: 10, outputTokens: 5 },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

test('a preselected Remote runner resolves a unique prefix through the official Client roster and publishes the resumed owner', async (t) => {
  const life = testLifecycle(t)
  const hostPreset = 'm3-4-pr2-preset'
  const target = 'abcdef12-remote-cli-target'
  const host = await mountRemotePresentationHost(life, hostPreset)
  await seedHostCompletedTurn(host, target, 'remote cli prompt', 'remote cli resumed answer')
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    host,
    sessionLaunch: { kind: 'lookup', query: 'abcdef12' },
  })
  await waitFor('Remote CLI unique-prefix resume', () => fixture.vt.getViewport().join('\n').includes('remote cli resumed answer'), 20_000)
  const frame = fixture.vt.getViewport().join('\n')
  assert.ok(!frame.includes('type a message to start a session'), 'a resumed Session replaces the sessionless Welcome')
  assert.ok(!frame.includes('Back [Esc]'), 'a pre-mount resume never opens the Session Browser')
})

test('a Remote generation replacement between the Workspace baseline and the roster abandons -c', async (t) => {
  const life = testLifecycle(t)
  const hostPreset = 'm3-4-pr2-preset'
  const target = 'remote-cli-generation-target'
  const host = await mountRemotePresentationHost(life, hostPreset)
  await seedHostCompletedTurn(host, target, 'remote generation prompt', 'remote generation answer', process.cwd())
  const registry = host.ctx.get('workspaceRegistry') as {
    create(path: string): Promise<{ attachSession(id: unknown): Promise<void>; detachSession(id: unknown): Promise<void> }>
  }
  const workspace = await registry.create(process.cwd())
  await workspace.attachSession(SessionId(target))

  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    host,
    sessionLaunch: { kind: 'continue' },
    beforeRunnerMount: (_presentation, aggregate) => {
      const backend = aggregate.selected.backend as unknown as {
        sessionReader: { list(...args: unknown[]): Promise<unknown> }
      }
      const originalList = backend.sessionReader.list.bind(backend.sessionReader)
      let reconnected = false
      backend.sessionReader.list = async (...args: unknown[]) => {
        if (!reconnected) {
          reconnected = true
          const connection = aggregate.wire.client.connection as unknown as {
            generation: { getSnapshot(): { readonly id: number } | undefined }
            reconnect(): void
          }
          const before = connection.generation.getSnapshot()?.id
          connection.reconnect()
          await waitFor('a new Remote generation before the roster', () => {
            const id = connection.generation.getSnapshot()?.id
            return id !== undefined && id !== before
          }, 20_000)
          // The membership changes under the NEW generation: only a stale
          // baseline would still contain this Session, so pairing it with the
          // new roster would fabricate a candidate.
          await workspace.detachSession(SessionId(target))
        }
        return originalList(...args)
      }
    },
  })

  await waitFor('continue connection-change notice', () => fixture.vt.getViewport().join('\n')
    .includes('the Host connection changed while reading the workspace'), 20_000)
  const frame = fixture.vt.getViewport().join('\n')
  assert.ok(frame.includes('type a message to start a session'), 'the generation change keeps the sessionless Welcome')
  assert.ok(!frame.includes('Back [Esc]'), '-c never opens the Browser on a generation change')
  assert.ok(!frame.includes('remote generation answer'), 'no stale-membership owner was published')
})

test('a preselected Remote runner continues the confirmed Workspace member selected by the official Workspace facts', async (t) => {
  const life = testLifecycle(t)
  const hostPreset = 'm3-4-pr2-preset'
  const target = 'remote-cli-continue-target'
  const host = await mountRemotePresentationHost(life, hostPreset)
  await seedHostCompletedTurn(host, target, 'remote continue prompt', 'remote continue answer', process.cwd())
  // The Host Workspace membership is a Host fact: seed the official registry
  // row the same way the Host controller would for a Session created there.
  const registry = host.ctx.get('workspaceRegistry') as {
    create(path: string): Promise<{ attachSession(id: unknown): Promise<void> }>
  }
  const workspace = await registry.create(process.cwd())
  await workspace.attachSession(SessionId(target))
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    host,
    sessionLaunch: { kind: 'continue' },
  })
  await waitFor('Remote CLI continue resume', () => fixture.vt.getViewport().join('\n').includes('remote continue answer'), 20_000)
  const frame = fixture.vt.getViewport().join('\n')
  assert.ok(!frame.includes('No readable sessions in this Host workspace'), 'the official membership contains the seeded Session')
  assert.ok(!frame.includes('Back [Esc]'), '-c never opens the Session Browser')
})

// --- M6 compatible-cross-build client UX -----------------------------------

const COMPATIBLE_OTHER_BUILD_NOTICE =
  'Connected to a compatible Host with a different PiTui build. To use the installed Host build, run `daemon restart` when work is idle.'

/** A counting daemon-administration port: a pure connection notice must never
 *  invoke a Host management verb. */
function countingDaemonAdmin(): {
  readonly port: NonNullable<RemoteApplicationOverride['profileDaemonAdmin']>
  readonly calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    port: {
      profile: 'pi-tui',
      async run(verb) {
        calls.push(verb)
        return { code: 0, stdout: '', stderr: '' }
      },
    },
  }
}

/** The visible viewport with line wraps normalized to single spaces. */
function viewportText(fixture: RemoteRunnerFixture): string {
  return fixture.vt.getViewport().join(' ').replace(/\s+/gu, ' ')
}

test('M6 compatible cross-build: the initial PiTui surface shows ONE info notice and never touches Host management', async (t) => {
  const life = testLifecycle(t)
  const admin = countingDaemonAdmin()
  const fixture = await mountRemoteRunner(life, {
    profileDaemonAdmin: admin.port,
    startupSettlement: {
      surfaceReady: () => {},
      surfaceFailed: () => {},
      authenticatedBuilds: {
        clientBuildId: 'client-build-a',
        hostBuildId: 'host-build-b',
        initialSurface: true,
      },
    },
  })
  try {
    await waitFor('compatible-build info notice', () => viewportText(fixture).includes(COMPATIBLE_OTHER_BUILD_NOTICE), 20_000)
    const app = fixture.runnerApp() as unknown as { notifyTextForTest(): string }
    assert.equal(app.notifyTextForTest(), COMPATIBLE_OTHER_BUILD_NOTICE, 'the ONE existing notify slot carries the fixed text')
    const wide = fixture.vt.getViewport().join('\n')
    assert.match(wide, /ℹ Connected to a compatible Host/u, 'the notice paints in the existing info role')
    assert.doesNotMatch(wide, /✗ Connected to a compatible Host/u, 'it is never an error notice')
    // Narrow 72x24 keeps the same non-blocking notice readable.
    fixture.vt.resize(72, 24)
    await waitFor('narrow compatible-build repaint', () => viewportText(fixture).includes(COMPATIBLE_OTHER_BUILD_NOTICE), 20_000)
    assert.deepEqual(admin.calls, [], 'a pure connection notice never invokes a Host management verb')
  } finally {
    await fixture.dispose()
  }
})

test('M6 compatible cross-build: the TSP Dock shows the same info notice and never touches Host management', async (t) => {
  const life = testLifecycle(t)
  const admin = countingDaemonAdmin()
  const fixture = await mountRemoteRunner(life, {
    renderer: 'tsp',
    profileDaemonAdmin: admin.port,
    startupSettlement: {
      surfaceReady: () => {},
      surfaceFailed: () => {},
      authenticatedBuilds: {
        clientBuildId: 'client-build-a',
        hostBuildId: 'host-build-b',
        initialSurface: true,
      },
    },
  })
  try {
    const pane = fixture.pane
    assert.ok(pane, 'the Remote TSP pane must be mounted')
    await waitFor('TSP dock compatible-build notice',
      () => wireNodes(pane).some(node => node.p.text === COMPATIBLE_OTHER_BUILD_NOTICE), 20_000)
    const notices = wireNodes(pane).filter(node => node.k === 'text' && String(node.p.text ?? '') === COMPATIBLE_OTHER_BUILD_NOTICE)
    assert.equal(notices.length, 1, 'the existing dock notice queue carries the message exactly once')
    assert.ok(notices.every(node => !String(node.p.text ?? '').startsWith('! ')), 'it is an info notice, never an error')
    assert.deepEqual(admin.calls, [], 'a pure connection notice never invokes a Host management verb')
  } finally {
    await fixture.dispose()
  }
})

test('M6 compatible cross-build: the same build keeps the surface quiet', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountRemoteRunner(life, {
    // A real resume failure is emitted AFTER the compatibility slot, so this
    // proves the startup reached the notice stage without painting it.
    resumeSessionId: 'missing-compatible-same-build',
    startupSettlement: {
      surfaceReady: () => {},
      surfaceFailed: () => {},
      authenticatedBuilds: {
        clientBuildId: 'same-build-id',
        hostBuildId: 'same-build-id',
        initialSurface: true,
      },
    },
  })
  try {
    await waitFor('the real resume error notice', () => fixture.vt.getViewport().join('\n').includes('could not be resumed'), 20_000)
    const app = fixture.runnerApp() as unknown as { notifyTextForTest(): string }
    assert.match(app.notifyTextForTest(), /could not be resumed/u)
    assert.ok(!fixture.vt.writes.join('').includes(COMPATIBLE_OTHER_BUILD_NOTICE),
      'a same-build connection never paints the compatible-build notice')
  } finally {
    await fixture.dispose()
  }
})

test('M6 compatible cross-build: absent identity facts keep the surface quiet', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountRemoteRunner(life, {
    resumeSessionId: 'missing-compatible-no-facts',
  })
  try {
    await waitFor('the real resume error notice', () => fixture.vt.getViewport().join('\n').includes('could not be resumed'), 20_000)
    const app = fixture.runnerApp() as unknown as { notifyTextForTest(): string }
    assert.match(app.notifyTextForTest(), /could not be resumed/u)
    assert.ok(!fixture.vt.writes.join('').includes(COMPATIBLE_OTHER_BUILD_NOTICE),
      'a composition without the authenticated pair never paints the compatible-build notice')
  } finally {
    await fixture.dispose()
  }
})

test('M6 compatible cross-build: an HMR replacement Surface does not repeat the notice', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountRemoteRunner(life, {
    resumeSessionId: 'missing-compatible-hmr',
    startupSettlement: {
      surfaceReady: () => {},
      surfaceFailed: () => {},
      authenticatedBuilds: {
        clientBuildId: 'client-build-a',
        hostBuildId: 'host-build-b',
        initialSurface: false,
      },
    },
  })
  try {
    await waitFor('the real resume error notice', () => fixture.vt.getViewport().join('\n').includes('could not be resumed'), 20_000)
    assert.ok(!fixture.vt.writes.join('').includes(COMPATIBLE_OTHER_BUILD_NOTICE),
      'only the initial physical Surface mount may project the notice')
  } finally {
    await fixture.dispose()
  }
})

test('M6 compatible cross-build: a real startup resume failure keeps priority over the info notice', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountRemoteRunner(life, {
    resumeSessionId: 'missing-compatible-priority',
    startupSettlement: {
      surfaceReady: () => {},
      surfaceFailed: () => {},
      authenticatedBuilds: {
        clientBuildId: 'client-build-a',
        hostBuildId: 'host-build-b',
        initialSurface: true,
      },
    },
  })
  try {
    await waitFor('the real resume error notice', () => fixture.vt.getViewport().join('\n').includes('could not be resumed'), 20_000)
    const app = fixture.runnerApp() as unknown as { notifyTextForTest(): string }
    assert.match(app.notifyTextForTest(), /could not be resumed/u,
      'the later real startup error owns the visible notify line')
    assert.match(fixture.vt.getViewport().join('\n'), /✗ session missing-compatible-priority could not be resumed/u,
      'the error paints in the error role')
  } finally {
    await fixture.dispose()
  }
})

test('M6 compatible cross-build: a startup Session Browser refusal keeps priority over the info notice', async (t) => {
  const life = testLifecycle(t)
  // A real PiTui fullscreen-lease refusal: the Workspace opener throws
  // synchronously, exactly like a blocking modal / foreign workspace owning
  // the one fullscreen lease, so the CLI startup Browser admission returns a
  // real error result.
  const originalOpenWorkspace = TuiApp.prototype.openSessionWorkspace
  TuiApp.prototype.openSessionWorkspace = function patchedOpenSessionWorkspace(): never {
    throw new Error('a blocking workspace owns the surface')
  }
  life.defer(() => { TuiApp.prototype.openSessionWorkspace = originalOpenWorkspace })
  const fixture = await mountRemoteRunner(life, {
    sessionLaunch: { kind: 'browse' },
    startupSettlement: {
      surfaceReady: () => {},
      surfaceFailed: () => {},
      authenticatedBuilds: {
        clientBuildId: 'client-build-a',
        hostBuildId: 'host-build-b',
        initialSurface: true,
      },
    },
  })
  try {
    await waitFor('the startup browser refusal notice',
      () => fixture.vt.getViewport().join('\n').includes('session browser unavailable'), 20_000)
    const app = fixture.runnerApp() as unknown as { notifyTextForTest(): string }
    assert.match(app.notifyTextForTest(), /session browser unavailable: session workspace unavailable: a blocking workspace owns the surface/u,
      'the browser refusal remains the visible single notify line')
    assert.doesNotMatch(app.notifyTextForTest(), /compatible Host with a different PiTui build/u,
      'the compatible-build info must be emitted before the browser refusal, not after it')
    assert.match(fixture.vt.getViewport().join('\n'), /✗ session browser unavailable: session workspace unavailable/u,
      'the refusal paints in the error role')
  } finally {
    await fixture.dispose()
  }
})
