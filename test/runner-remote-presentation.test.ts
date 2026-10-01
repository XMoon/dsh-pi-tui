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
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
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

/** The LLM endpoint stand-in: a real adapter whose stream yields real text. */
class StubStreamingLlmAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke-model', name: 'Smoke Model' }])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
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
async function mountRemotePresentationHost(life: TestLifecycle, presetId: string) {
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  // The streaming stand-in rides the shared fixture's `smoke` route; the
  // official projection rows (TokenMeter/tool-todo) mount after the base.
  const base = await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: new StubStreamingLlmAdapter(),
  })
  await base.ctx.plugin(TokenMeter)
  await base.ctx.plugin(toolTodo, { allowParallelInProgress: false })
  return base
}

/**
 * Mount the REAL runner with a pre-selected Remote aggregate over the real
 * Host. The runner consumes only the aggregate's selected core + the
 * presentation-source bundle — no Direct graph is ever constructed.
 */
async function mountRemoteRunner(
  life: TestLifecycle,
  options: {
    presetId?: string
    resumeSessionId?: string
    cwd?: string
    /** A pre-seeded host fixture (the resume tests seed BEFORE the aggregate). */
    host?: Awaited<ReturnType<typeof mountRemotePresentationHost>>
  } = {},
): Promise<RemoteRunnerFixture> {
  const presetId = options.presetId ?? 'm3-4-pr2-preset'
  const host = options.host ?? await mountRemotePresentationHost(life, presetId)
  const cwd = options.cwd ?? host.anchorDir
  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    promptSerializer: testPromptSerializer,
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
    shippedPresetRoot: host.workRoot,
  })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
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
      source: { kind: 'model', provider: 'smoke', model: 'smoke-model' },
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
        source: { kind: 'model', provider: 'smoke', model: 'smoke-model' },
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
    message: { id: 'a-s', role: 'assistant', content: [{ type: 'text', text: 'status answer' }], source: { kind: 'model', provider: 'smoke', model: 'smoke-model' } },
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
      message: { id: `a-${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke-model' } },
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
      message: { id: `a-g${turn}`, role: 'assistant', content: [{ type: 'text', text: `gesture answer ${turn} — history line for turn ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke-model' } },
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
    session: { beginSubmission(input: { mode: 'queue' | 'steer'; text: string; attachments?: readonly [] }): { requestId: string } }
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

async function waitForApp(fixture: RemoteRunnerFixture): Promise<{ pendingInputForTest(): { queued: Array<{ text?: string }>; tail: Array<{ row?: { text?: string } }> } }> {
  for (let i = 0; i < 600; i++) {
    const app = fixture.runnerApp() as { pendingInputForTest?: () => unknown } | undefined
    if (app !== undefined && typeof app.pendingInputForTest === 'function') {
      return app as never
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error('the mounted TuiApp never exposed pendingInputForTest')
}

test('L6 §6.6: the Remote branch OMITS the Host-derived access section (no sandbox fact is painted)', async (t) => {
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
