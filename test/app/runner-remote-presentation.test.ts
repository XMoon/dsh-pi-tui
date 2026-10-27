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
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as toolTodo from '@deepseek-ai/dsh-tool-todo'
import { Config as TuiConfigSchema } from '../../src/index.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../../src/app/bootstrap.ts'
import type { RemoteApplicationOverride } from '../../src/app/application-runtime.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import { createRemoteApplicationRuntime } from '../../src/app/remote/runtime.ts'
import { testPromptSerializer, waitFor } from '../support/remote-application-fixture.ts'
import { appendHistoryRecord, historyFilePath, loadHistoryRecords } from '../../src/client/history/store.ts'
import { dshHome } from '../../src/runtime/process/diagnostics.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'

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

  /** Hold every subsequent turn open; returns the release. */
  hold(): () => void {
    this.gate = new Promise<void>(resolve => { this.openGate = resolve })
    return () => {
      const open = this.openGate
      this.gate = undefined
      this.openGate = undefined
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
    if (gate !== undefined) {
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
  options: { readonly llmAdapter?: LlmAdapter } = {},
) {
  const { createRemoteApplicationHostFixture } = await import('../support/remote-application-fixture.ts')
  // The streaming stand-in rides the shared fixture's `smoke` route; the
  // official projection rows (TokenMeter/tool-todo) mount after the base.
  const base = await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: options.llmAdapter ?? new StubStreamingLlmAdapter(),
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
    beforeRunnerMount?: (presentation: RemoteApplicationOverride['presentation']) => void
    /** Mount the production TSP renderer over the scripted pane instead of PiTui. */
    renderer?: 'pi-tui' | 'tsp'
    /** Advertise native image + blobs when the TSP renderer is selected. */
    nativeImages?: boolean
    /** Advertise the native chart kind when the TSP renderer is selected. */
    nativeChart?: boolean
  } = {},
): Promise<RemoteRunnerFixture> {
  const presetId = options.presetId ?? 'm3-4-pr2-preset'
  const host = options.host ?? await mountRemotePresentationHost(life, presetId, {
    ...options.llmAdapter === undefined ? {} : { llmAdapter: options.llmAdapter },
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

  const vt = new VirtualTerminal(100, 30)
  let pane: TspPane | undefined
  if (options.renderer === 'tsp') {
    pane = installTspPane({ nativeImages: options.nativeImages, nativeChart: options.nativeChart })
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
    shippedPresetRoot: host.workRoot,
  })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
    extensionService: aggregate.clientUi.extensionService,
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
  options.beforeRunnerMount?.(override.presentation)
  const runnerFiber = runnerCtx.plugin(pluginCtx => {
    applyRunnerWithRuntime(pluginCtx, TuiConfigSchema({ fullscreen: 'off', sessionId: options.resumeSessionId } as never), override)
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
  const append = (type: string, data: unknown, options?: { surfaceOp?: 'append' }): void => {
    (session.append as (t: string, d: unknown, o?: { surfaceOp?: 'append' }) => void)(type, data, options)
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
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  await waitFor('transcript hydration', () => {
    const text = fixture.vt.getViewport().join('\n')
    return text.includes('hello remote') && text.includes('remote answer one')
  }, 20_000)
  const frame = fixture.vt.getViewport().join('\n')
  // The durable rows are the OFFICIAL window's rows — one hydration, no
  // duplicate identity (the local-echo ledger never ran: no submit happened).
  assert.equal(frame.includes('hello remote'), true, 'the resumed user row is rendered')
  assert.equal(frame.includes('remote answer one'), true, 'the resumed assistant row is rendered')
})

test('the resumed Remote startup keeps input accepted while its hydration read is held', async (t) => {
  // The Remote startup resume awaits `remote.read` AFTER the terminal is already
  // accepting input. A submission accepted in that window is owned by the
  // resumed Session, and its own persistence is ordered behind the hydration
  // continuation — so the reseed provably reads a snapshot WITHOUT it. The
  // editor-recall scope must keep it, while the submission that did persist is
  // never doubled, and the late row must land under the SAME Session.
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-remote-startup-window'
  const hostPreset = 'm3-4-pr2-preset'
  const host = await mountRemotePresentationHost(life, hostPreset)
  await host.harness.create(SessionId(mainId), undefined, { cwd: host.anchorDir })
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
  const fixture = await mountRemoteRunner(life, {
    presetId: hostPreset,
    resumeSessionId: mainId,
    host,
    productionSerializer: true,
    beforeRunnerMount: (presentation) => {
      // The boot recall reads the CLIENT cwd's history file (the launch cwd), not
      // the Host workspace's: a FOREIGN Session's row is already there, and a live
      // owner IS current (the resume published before this mount), so ↑ must never
      // be seeded with other Sessions' rows.
      appendHistoryRecord(
        historyFilePath(dshHome(process.env), process.cwd()),
        { v: 2, content: 'foreign client-cwd prompt', cwd: process.cwd(), ts: Date.now(), sessionId: 'session-foreign-earlier' },
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
        // production awaits); the gate then holds its RESULT, so releasing it
        // resumes the hydration continuation immediately — the same
        // "hydration still pending while the terminal accepts input" window a
        // slow production read produces.
        const captured = await real.call(reader, sessionId, signal)
        readEntered = true
        await readGate
        return captured
      }
    },
  })
  // Bounded readiness: a startup read that never runs (or a first persist that
  // never lands) fails this test instead of parking it.
  await waitFor('the held startup read to be entered', () => readEntered, 20_000)
  const editor = fixture.runnerApp() as unknown as {
    setDraft(text: string): void
    submitDraft(): void
    getDraft(): string
    getInputHistory(): readonly string[]
    resetInputHistory(entries: readonly string[], owner?: string): void
  }
  // Capture what the resumed Session's hydration reseed commits.
  assert.ok(!editor.getInputHistory().includes('foreign client-cwd prompt'),
    `the boot recall of the client cwd must not back a live owner: ${JSON.stringify(editor.getInputHistory())}`)
  const commits: { readonly entries: readonly string[]; readonly recall: readonly string[] }[] = []
  const originalReset = editor.resetInputHistory.bind(editor)
  editor.resetInputHistory = ((entries: readonly string[], owner?: string) => {
    originalReset(entries, owner)
    // The recall EXACTLY as this commit left it: the decisive moment, before
    // any later append can repair it.
    commits.push({ entries: [...entries], recall: [...editor.getInputHistory()] })
  }) as typeof editor.resetInputHistory
  const historyFile = historyFilePath(host.workRoot, host.anchorDir)
  const ownersOf = (text: string): readonly (string | undefined)[] => loadHistoryRecords(historyFile)
    .filter(row => row.content === text).map(row => row.sessionId)
  try {

  // The first submission persists BEFORE the held hydration commits.
  editor.setDraft('first remote prompt')
  editor.submitDraft()
  await waitFor('the first submission persisted under the resumed Session', () =>
    ownersOf('first remote prompt').includes(mainId), 20_000)

  // Release the hydration and accept the second submission in the SAME
  // synchronous stack: its persistence continuation is queued BEHIND the
  // released hydration continuation.
  releaseRead()
  editor.setDraft('pending remote prompt')
  editor.submitDraft()
  await waitFor('the resumed hydration committed', () => commits.length > 0, 20_000)
  // The reseed that commits while the second submission's row is still absent
  // from the file: its snapshot carries the persisted submission only …
  const first = commits[0]!
  assert.deepEqual(first.entries, ['first remote prompt'],
    `the snapshot carries the persisted submission only: ${JSON.stringify(first.entries)}`)
  assert.equal(first.entries.includes('pending remote prompt'), false,
    'the accepted-but-unpersisted submission is NOT in the snapshot')
  // … and the recall it commits still holds that input, at its submission rank.
  assert.deepEqual(first.recall, ['pending remote prompt', 'first remote prompt'],
    `the hydration reconcile keeps the pending submission: ${JSON.stringify(first.recall)}`)
  assert.deepEqual([...editor.getInputHistory()], ['pending remote prompt', 'first remote prompt'],
    'the hydration reconcile keeps the pending submission and never doubles the persisted one')

  // The late append lands under the SAME Session after the reseed, and the
  // recall is unchanged by it (its occurrence is already represented).
  await waitFor('the pending submission persists after the reseed', () =>
    ownersOf('pending remote prompt').includes(mainId), 20_000)
  assert.deepEqual([...editor.getInputHistory()], ['pending remote prompt', 'first remote prompt'],
    'the late append never re-adds an already-recalled occurrence')

  // The REAL ↑ sink recalls the input accepted during the held read.
  fixture.vt.sendInput('\x1b[A')
  await waitFor('↑ recalls the input accepted during the held read', () =>
    editor.getDraft() === 'pending remote prompt', 5_000)
  } finally {
    // Never leave the startup hydration parked, whatever failed above.
    releaseRead()
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

test('the official pendingSubmissions echo drives the pending-presentation join (user-visible rows)', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-pending'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  const app = await waitForApp(fixture)
  // Baseline: the join renders nothing pending.
  assert.deepEqual(app.pendingInputForTest().queued, [])
  assert.deepEqual(app.pendingInputForTest().tail, [])
  // The OFFICIAL optimistic echo: the real Client's beginSubmission on the
  // retained binding — the exact gesture the official composer makes (PR2
  // proves the READ/presentation side; no prompt dispatch happens).
  const binding = fixture.aggregate.wire.client.sessions.binding(SessionId(mainId) as never) as {
    session: { beginSubmission(input: { mode: 'queue' | 'steer'; text: string; attachments: readonly [] }): { requestId: string } }
  } | undefined
  assert.ok(binding !== undefined, 'the retained binding serves the official beginSubmission')
  const submission = binding.session.beginSubmission({ mode: 'queue', text: 'official echo drives the pane', attachments: [] })
  await waitFor('official snapshot carries the echo', () => {
    return (fixture.override.presentation.submissionPresentation.snapshot(mainId) ?? []).length > 0
  }, 5_000)
  // The official snapshot now carries the echo; the surface refresh joins it
  // into the rendered rows (the queue pane for a queued placement when
  // running; the tail lane otherwise — both are user-visible pending rows).
  await waitFor('official echo joined into the pending rows', () => {
    const pending = app.pendingInputForTest()
    return pending.queued.length + pending.tail.length > 0
  }, 15_000)
  const pending = app.pendingInputForTest()
  const rows = [...pending.queued, ...pending.tail] as Array<{ row?: { text?: string }; text?: string }>
  const joined = rows.some(row => (row.row?.text ?? row.text) === 'official echo drives the pane')
  assert.equal(joined, true, 'the OFFICIAL echo text is rendered through the pending-presentation join')
  void submission
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

test('the Remote branch OMITS the Host-derived access section when the permission projection carries no value (no sandbox fact is painted)', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-access'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  // A Host sandbox service that answers WITHOUT a session (the exact hole the
  // plan's §6.6 forbids on Remote): `resolve(undefined)` yields a mode. The
  // fixture now mounts the OFFICIAL `sandboxPolicy` service (the Remote
  // composition's workspace-file prerequisite needs it), so the hole is
  // reproduced by overriding that live service — a second `provide` would
  // collide with the already-registered service.
  const sandbox = seedHost.ctx.get('sandboxPolicy') as unknown as {
    resolve(session?: unknown): { readonly mode: string }
  }
  sandbox.resolve = () => ({ mode: 'danger-full-access' })
  await seedHost.harness.create(SessionId(mainId), undefined, { cwd: seedHost.anchorDir })
  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host: seedHost })
  const app = await waitForApp(fixture)
  // The committed STATUS projection is what every access-rendering item reads
  // (permission-preset / sandbox-mode / approval-policy): assert the section
  // itself is absent, not just whether a particular layout paints it.
  const accessOf = (): unknown => (app as unknown as {
    statusStore: { snapshot(): { access?: { sandbox?: unknown; permissionPreset?: unknown; approval?: unknown } } }
  }).statusStore.snapshot().access
  await new Promise(resolve => setTimeout(resolve, 300))
  const access = accessOf() as { sandbox?: unknown; permissionPreset?: unknown; approval?: unknown } | undefined
  assert.equal(access?.sandbox, undefined,
    'the Remote status must not carry a Host-derived sandbox mode (§6.6)')
  assert.equal(access?.permissionPreset, undefined)
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
    header: { readonly parentSession?: string }
  }).header
  assert.equal(String(childHeader.parentSession), sessionA,
    'the child carries the official fork lineage to the parent')
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

test('pending: queued -> queue pane, steering -> tail lane, and the echo -> authoritative identity handoff', async (t) => {
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
      getSnapshot(): { readonly running: boolean }
      prompt(
        content: readonly { readonly type: 'text'; readonly text: string }[],
        mode: 'queue' | 'steer',
        signal?: AbortSignal,
        requestId?: unknown,
      ): Promise<unknown>
      beginSubmission(input: {
        readonly mode: 'queue' | 'steer'
        readonly text: string
        readonly attachments: readonly unknown[]
      }): { readonly requestId: unknown }
    }
  }
  assert.ok(binding !== undefined, 'the retained binding serves the official prompt/echo faces')
  // Hold one real turn OPEN so the session is officially `running`: the
  // placement of every echo below is the official `running ? queued/steering :
  // transcript` rule, computed by the Client itself.
  const release = adapter.hold()
  await binding.session.prompt([{ type: 'text', text: 'hold the turn open' }], 'queue')
  await waitFor('session running', () => binding.session.getSnapshot().running, 15_000)

  // QUEUED: a queue-mode echo on a running session lands in the QUEUE pane.
  const queued = binding.session.beginSubmission({ mode: 'queue', text: 'queued echo body', attachments: [] })
  await waitFor('queued row in the queue pane', () => {
    return app.pendingInputForTest().queued.some(row => (row as { text?: string }).text === 'queued echo body')
  }, 15_000)
  assert.equal(app.pendingInputForTest().tail.some(row => row.row?.text === 'queued echo body'), false,
    'a queued echo never rides the transcript tail lane')

  // STEERING: a steer-mode echo on the running session lands in the tail lane.
  binding.session.beginSubmission({ mode: 'steer', text: 'steering echo body', attachments: [] })
  await waitFor('steering row in the tail lane', () => {
    return app.pendingInputForTest().tail.some(row => row.row?.text === 'steering echo body' && row.row?.status === 'steering')
  }, 15_000)
  assert.equal(app.pendingInputForTest().queued.some(row => (row as { text?: string }).text === 'steering echo body'), false,
    'a steering echo never rides the queue pane')

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

  // HANDOFF: the identified prompt carries the echo's OWN requestId; once the
  // Host admits the durable user message the echo retires by IDENTITY and the
  // authoritative row takes its place (never a text-based dedupe).
  await binding.session.prompt([{ type: 'text', text: 'queued echo body' }], 'queue', undefined, queued.requestId)
  release()
  await waitFor('echo retired into the durable row', () => {
    const pending = app.pendingInputForTest()
    return pending.queued.every(row => (row as { text?: string }).text !== 'queued echo body')
  }, 20_000)
  await waitFor('durable user row painted', () => {
    return fixture.vt.getViewport().join('\n').includes('queued echo body')
  }, 20_000)
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
  const tools = await import('@deepseek-ai/dsh-tools')
  host.ctx.tools.register(tools.defineContentToolFixture({
    name: 'pr4_live_fixture',
    description: 'the live lifecycle fixture tool',
    parameters: {},
    execute: async () => [{ type: 'text', text: 'LIVE-TOOL-RESULT' }],
  }))
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  const fixture = await mountRemoteRunner(life, { presetId: hostPreset, resumeSessionId: mainId, host, productionSerializer: true })
  const app = await waitForApp(fixture)
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
  const skillSummary = {
    name: 'pr4-skill', description: 'the fixture skill',
    invocation: { userInvocable: true, modelInvocable: false },
  }
  host.ctx.provide('skills', {
    list: async () => [skillSummary],
    snapshot: async () => ({ skills: [skillSummary], complete: true }),
    get: async (name: string) => name === 'pr4-skill'
      ? { ...skillSummary, provider: 'fixture', content: BODY_MARKER }
      : undefined,
  } as never)
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
    if (/Input tokens\s+5035/u.test(panelView)
      && /TTFB \(recent\)\s+0\.[1-9]\d*s/u.test(panelView)) break
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
test('C3 Remote proof: official projections → the About controller view → the exact report', async (t) => {
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
test('C3 Remote production lane: /settings → real About panel → [Copy All] click → OSC 52 payload', async (t) => {
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
    // runtime's reads (the official Remote projections).
    await waitFor('the About facts paint from the official projections', () => {
      const frame = mountedFixture.vt.getViewport().map((line: string) => line).join('\n')
      return frame.includes('Session ID') && frame.includes('Turns') && frame.includes('R5 tokens/sec')
    }, 15_000)
    const frameText = mountedFixture.vt.getViewport().map((line: string) => line).join('\n')
    assert.ok(frameText.includes('c3-prod-remote'), 'the OFFICIAL session id paints')
    assert.ok(frameText.includes('Backend') && frameText.includes('Remote'), 'the Remote backend fact paints')
    // THE OFFICIAL CWD, verbatim: the projection's list-row cwd of THIS session.
    assert.ok(frameText.includes(seedHost.anchorDir), `the official cwd paints: ${frameText.match(/CWD.*/)?.[0]}`)
    // The official lifetime fold of the seeded turn.
    assert.ok(/Turns\s+1\b/.test(frameText), `the lifetime turns paint: ${frameText.match(/Turns.*/)?.[0]}`)
    assert.ok(/Steps\s+1\b/.test(frameText), 'the lifetime steps paint')
    // The Host piTuiPerformance projection's MEASURED figures paint (the
    // seeded real sample: a real TTFB in the 0.1s-0.4s class and real rates).
    assert.ok(/TTFB \(recent\)\s+0\.[1-3]/.test(frameText), `the seeded TTFB paints: ${frameText.match(/TTFB.*/)?.[0]}`)
    assert.ok(/R5 tokens\/sec\s+[1-9]/.test(frameText), 'the seeded R5 rate paints non-zero')
    assert.ok(/All tokens\/sec\s+[1-9]/.test(frameText), 'the seeded All rate paints non-zero')

    // ── THE REAL COPY: SGR press/release on the painted [Copy All C]. ──
    // The action row paints BELOW the fold at 100×30: the About-local End
    // key jumps the offset to the bottom (the same keyboard a user drives).
    // Each step waits for the FRAME it causes (a state barrier, never a
    // fixed delay): Enter hands the keyboard to the content — the action
    // bar's hint text flips to the About verbs; PageDown scrolls the rows.
    mountedFixture.vt.sendInput('\r') // Enter: the rail hands the keyboard to the content.
    await waitFor('the content focus took the keyboard', () =>
      mountedFixture.vt.getViewport().join('\n').includes('c copy fact'), 15_000)
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
test('C3 Remote negative: the sample-less performance/context groups word Unavailable through the production route (tokenUsage stays the authoritative zero)', async (t) => {
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
      return /Turns\s+1\b/.test(frame)
    }, 15_000)
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
