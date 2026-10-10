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
 * - prompt serializer (unsupported test double): PR2 owns no production
 *   Remote submission serializer (the M3-4 submission PR's ownership); no
 *   proof below submits a Remote prompt
 * - `StubStreamingLlmAdapter`: a scripted real `LlmAdapter` whose `stream`
 *   yields one real text turn — the Host emits REAL `agent/assistant-stream`
 *   frames, the wire forwards them, and the Client eventSource produces REAL
 *   transient entries; the adapter is the LLM endpoint stand-in only
 * - hand-provided `agentDefaultModel`/`attachments`/`webServer`: the minimal
 *   readiness inputs (identical to the shared fixture manifest)
 *
 * DELIBERATELY ABSENT
 * - production Remote submission (prompt/queue/steer — the M3-4 PR3 domain);
 *   the pending-submission UI proofs read official Client echoes through
 *   `RemoteSubmissionPresentation`, never a TUI-minted Remote ledger
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
import { Config as TuiConfigSchema } from '../src/index.ts'
import { TuiApp } from '../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../src/app/bootstrap.ts'
import type { RemoteApplicationOverride } from '../src/app/application-runtime.ts'
import { TUI_STARTUP_SERVICE } from '../src/startup.ts'
import { createRemoteApplicationRuntime } from '../src/app/remote/runtime.ts'
import { testPromptSerializer, waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
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
  const restoreTerminal = await import('./support/runner-harness.ts').then(m => m.installVirtualProcessTerminal(vt))
  life.defer(restoreTerminal)

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
  const runnerFiber = runnerCtx.plugin(pluginCtx => {
    applyRunnerWithRuntime(pluginCtx, TuiConfigSchema({ fullscreen: 'off', sessionId: options.resumeSessionId } as never), override)
  })
  await runnerFiber
  // Let the startup composition settle (mount + initial hydration).
  await waitFor('remote runner mount', () => vt.getViewport().join('').length > 0, 20_000)
  const dispose = async (): Promise<void> => {
    await runnerFiber.dispose()
  }
  life.defer(dispose)
  return {
    host,
    runnerFiber,
    vt,
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

test('L6: a Remote resumed session hydrates the real transcript and status through the official window', async (t) => {
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

test('L6: the Remote branch performs zero Direct graph construction', async (t) => {
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

test('L6: sessionStatus serves the retained session facts and stays absent for unretained ids', async (t) => {
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

test('L6: live assistant transient output streams through the official eventSource ingress', async (t) => {
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

test('L6: history paging (loadOlder) extends the loaded window without replacing the subject', async (t) => {
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
  // TuiApp in test/transcript-history-extension.test.ts — driving the
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

test('L6 (SURFACE_REACHABLE): the real boundary gesture extends the loaded official history through the mounted surface', async (t) => {
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

test('L6: the official pendingSubmissions echo drives the pending-presentation join (user-visible rows)', async (t) => {
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

test('L6 §7.4-10/11 an edit tool card renders from RAW durable call/result facts (no Host presenter)', async (t) => {
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

test('L6 §6.6: the Remote branch OMITS the Host-derived access section when the permission projection carries no value (no sandbox fact is painted)', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr2-access'
  const hostPreset = 'm3-4-pr2-preset'
  const seedHost = await mountRemotePresentationHost(life, hostPreset)
  // A Host sandbox service that answers WITHOUT a session (the exact hole the
  // plan's §6.6 forbids on Remote): `resolve(undefined)` yields a mode.
  seedHost.ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) } as never)
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

test('L6: current-value facts whose SOURCE EVENTS precede the bounded window still render (title/goal/lifetime usage)', async (t) => {
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

test('L6 navigation: switch, same-id rollover and reconnect re-init the presentation without leaking the old subject', async (t) => {
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

test('L6 pending: queued -> queue pane, steering -> tail lane, and the echo -> authoritative identity handoff', async (t) => {
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

test('L6: a projection-owned value changed by ANOTHER writer reaches the surface through the official projection channel', async (t) => {
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

test('L6 §7.4-10/11 LIVE: a mounted Remote surface renders the tool call as it executes on the Host, then settles from the durable result', async (t) => {
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

test('L6 §7.4-10 KNOWN tool LIVE: an in-flight edit renders the Client diff card BEFORE the result settles, then settles from the durable facts', async (t) => {
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

test('L6 §7.4-5 literal skill gesture over a mounted Remote surface: the Client delivers the ORIGINAL line, the HOST pre-step injects the body', async (t) => {
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

/* ───────── §7.4-7 mounted /status over a paged performance window (F8) ──── */

test('L6 §7.4-7 mounted /status: lifetime totals render from the projections; the RECENT figures come from the Session\'s own Host projection', async (t) => {
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
  // `assistant/message` append. The seeded span is ~100ms TTFB and ~300ms
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
  // The command executes through the mounted Client registry and opens the
  // official status panel.
  await waitFor('the mounted /status panel opened', () =>
    fixture.vt.getViewport().join('').includes('Stats'), 30_000)
  // LIFETIME totals: their source events include the oldest turns, so a
  // bounded-window read could not produce them — the projections must.
  await waitFor('the projection-backed lifetime totals rendered', () =>
    /↑[0-9.]+k/u.test(fixture.vt.getViewport().join('')), 20_000)
  // RECENT evidence (TPS plan PR-2): the measured performance values come
  // from the SESSION's own Host `piTuiPerformance` projection, which folds
  // the SAME committed turns regardless of how much history the Client's
  // bounded window happens to hold — no `loadOlder()` and no window fold can
  // influence them. The seeded turns are REAL committed events, so the Host
  // projection carries their samples.
  await waitFor('the projection-backed lifetime totals rendered', () =>
    /↑[0-9.]+k/u.test(fixture.vt.getViewport().join('')), 20_000)
  // ROUND-5 hardening — REQUIRED MATCHES on the RENDERED row (assert.match
  // throws when the pattern does not match; the round-4 `exec() !== undefined`
  // guards were vacuously true — exec returns null). The seeded first chunk
  // lands ~100ms after `step/start` → a `0.1s`-class TTFB rendering (a broken
  // wiring that renders 0 fails: `0.0s`/`0s` does not match); the rate is
  // 200 tokens over the ~400ms request wall → a non-zero tok/s figure. The
  // upper bound keeps the match honest against the seeded arithmetic.
  await waitFor('the panel rendered the exact lifetime totals', () =>
    fixture.vt.getViewport().join('').includes('↑5.0k ↓1.0k'), 20_000)
  // The RENDERED status surface of this fixture is the footer row: the
  // /status panel keeps its formatted facts in each row's DESCRIPTION, which
  // the overlay does not paint for an unfocused row (observed with a probe —
  // the Stats row renders label-only while its description carries the
  // figures). The footer and the panel read the SAME status facts, so this
  // assertion still proves the Host-projection figures reach a rendered
  // surface; the panel row's own formatting is covered by
  // `test/footer-items.test.ts` / `test/status-semantics.test.ts`.
  const panelView = fixture.vt.getViewport().join('')
  assert.match(panelView, /TTFB 0\.[1-9]\d*s/u,
    `the rendered status must show the seeded non-zero TTFB:\n${panelView}`)
  assert.match(panelView, /([1-9]\d{1,3}) tok\/s/u,
    `the rendered status must show a seeded non-zero rate:\n${panelView}`)
  // FOOTER consistency: the footer reads the SAME status facts, so it shows
  // the same Host-projection figures — never the no-sample zeros.
  const footerRows = (fixture.runnerApp() as unknown as {
    footerRenderRowsForTest(): readonly string[]
  }).footerRenderRowsForTest()
  const footerText = footerRows.join(' ')
  assert.match(footerText, /TTFB 0\.[1-9]\d*s/u,
    `the footer's recent figures are the Host projection's:\n${footerText}`)
  // TPS plan PR-3: the DEFAULT footer layout shows the combined pair — the
  // real Host → Client → Footer chain must deliver BOTH scopes to the
  // rendered footer row, with the singular `tok/s` unit.
  assert.match(footerText, /R5 [1-9]\d* · All [1-9]\d* tok\/s/u,
    `the footer must render the default R5 + All pair from the Host projection:\n${footerText}`)
})

/* ─────────── PR5 §12 Slice E: real-holder writer-held recovery ─────────── */

/** The two-process Session-writer holder (see test/support). */
const SESSION_WRITER_HOLDER = fileURLToPath(new URL('./support/session-writer-holder.mjs', import.meta.url))

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

/** Read the durable event types straight off the Host persistence root. */
async function readDurableEventTypes(
  host: Awaited<ReturnType<typeof mountRemotePresentationHost>>,
  sessionId: string,
): Promise<readonly string[]> {
  const persistence = (host.ctx as unknown as {
    sessionPersistence: {
      open(id: unknown, mode: 'read'): Promise<{
        read(): Promise<{ events: readonly { type: string }[] }>
        close(): Promise<void>
      }>
    }
  }).sessionPersistence
  const handle = await persistence.open(SessionId(sessionId), 'read')
  try {
    const read = await handle.read()
    return read.events.map(event => event.type)
  } finally {
    await handle.close()
  }
}

test('L6 PR5: a REAL two-process writer-held Remote Session — prompt, /title and /preset recover structurally, and an explicit retry commits after the holder exits', async (t) => {
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

test('L6 PR5: a TRUE indeterminate Remote /preset <id> is consumed by the outer settlement and never restored', async (t) => {
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

test('L6 PR5: a TRUE indeterminate Remote /title <name> is consumed by the outer settlement and surfaces the no-retry notice', async (t) => {
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
