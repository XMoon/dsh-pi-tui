/**
 * M3-4 PR4 L6 whole-log rewind (plan §7.4 scenario 9 / §4): the target turn
 * sits OUTSIDE the initial presentation event window; the picker still lists
 * it through the official whole-log `turnOutline` projection (before any
 * history paging); selecting it runs the OFFICIAL `loadThrough(seq)` jump and
 * forks at the exact predecessor boundary; the restored editor text is the
 * FULL prompt, never the outline's bounded preview.
 *
 * PRODUCTION PREREQUISITES REPRODUCED (the shared PR2/PR4 remote fixture):
 * - the real rc.2 Host services incl. the official `session-turn-outline`
 *   and `session-stats` projection rows
 * - the official Client/Gateway path over the real in-process carrier
 * - the REAL runner composition root (applyRunnerWithRuntime) with the
 *   production prompt serializer
 *
 * TEST STAND-INS: the scripted streaming LLM adapter only (same as every
 * PR2/PR3 L6 suite).
 *
 * DELIBERATELY ABSENT: none — this is the plan's mandatory Remote /rewind
 * positive (stale-picker counterfactuals live in the navigation suites).
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-rewind.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { Config as TuiConfigSchema } from '../src/index.ts'
import { TuiApp } from '../src/tui-app.ts'
import { applyRunnerWithRuntime } from '../src/app/bootstrap.ts'
import type { RemoteApplicationOverride } from '../src/app/application-runtime.ts'
import { createRemoteApplicationRuntime } from '../src/app/remote/runtime.ts'
import { waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''

/** The streaming stand-in (same shape as the presentation fixture's). */
class StubStreamingLlmAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke', name: 'Smoke Model' }])
  }

  override async *stream(): AsyncGenerator<never> {}
}

/** The PR4 presentation host: the PR2 rows + the whole-log projection rows. */
async function mountPr4Host(life: TestLifecycle, presetId: string) {
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  const base = await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: new StubStreamingLlmAdapter(),
  })
  const TokenMeter = (await import('@deepseek-ai/dsh-token-meter')).default
  const toolTodo = await import('@deepseek-ai/dsh-tool-todo')
  await base.ctx.plugin(TokenMeter)
  await base.ctx.plugin(toolTodo, { allowParallelInProgress: false })
  const turnOutline = await import('@deepseek-ai/dsh-session-turn-outline')
  await base.ctx.plugin(turnOutline)
  const sessionStats = await import('@deepseek-ai/dsh-session-stats')
  await base.ctx.plugin(sessionStats)
  return base
}

test('L6 §7.4-9: Remote /rewind lists an out-of-window turn from turnOutline, then loadThrough + fork restores the FULL prompt', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-rewind'
  const presetId = 'm3-4-pr4-preset'
  const host = await mountPr4Host(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const appendOf = () => host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  // Seed MANY completed turns; the LONG prompt of the OLDEST rewindable turn
  // is the discriminator (the outline preview clips it; the restored editor
  // text must be the full text).
  const longPrompt = `deep rewind target ${'x'.repeat(300)}`
  const seedTurn = (turn: number, prompt: string): void => {
    const session = appendOf()
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', {
      id: `u-pr4-${turn}`, role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn, step: 1,
      message: { id: `a-pr4-${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
      stream: [], usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  for (let turn = 1; turn <= 12; turn += 1) {
    seedTurn(turn, turn === 2 ? longPrompt : `pr4 prompt ${turn}`)
  }

  // The production Remote aggregate (NO serializer stub).
  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
  })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))

  const vt = new VirtualTerminal(110, 32)
  const restoreTerminal = await import('./support/runner-harness.ts').then(m => m.installVirtualProcessTerminal(vt))
  life.defer(restoreTerminal)

  const runnerCtx = host.ctx
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = host.workRoot
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  runnerCtx.provide('appExit', (code: number) => { void code })
  const { TUI_STARTUP_SERVICE } = await import('../src/startup.ts')
  runnerCtx.provide(TUI_STARTUP_SERVICE, {
    sessionId: mainId,
    shippedPresetRoot: host.workRoot,
  })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
  }
  const apps: unknown[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: unknown) {
    apps.push(this)
    return originalStart.call(this)
  }
  life.defer(() => { TuiApp.prototype.start = originalStart })
  const runnerFiber = runnerCtx.plugin(pluginCtx => {
    applyRunnerWithRuntime(pluginCtx, TuiConfigSchema({ fullscreen: 'off', sessionId: mainId } as never), override)
  })
  await runnerFiber
  life.defer(() => { runnerFiber.dispose() })
  await waitFor('remote runner mount', () => vt.getViewport().join('').length > 0, 20_000)

  const app = await (async () => {
    for (let i = 0; i < 600; i++) {
      const candidate = apps.at(-1) as unknown as {
        setDraft(text: string): void
        submitDraft(): void
        getDraft(): string
        tui: { handleTerminalInput(data: string): void }
      } | undefined
      if (candidate !== undefined && typeof candidate.setDraft === 'function') return candidate
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the mounted app never exposed the draft surface')
  })()

  // The official whole-log outline sees every turn — including the oldest
  // rewindable one (turn 2) whose events sit far outside the initial
  // presentation window.
  await waitFor('outline projection served', () => {
    const binding = aggregate.wire.client.sessions.binding(SessionId(mainId) as never) as {
      session: { projections: { faceOf(key: string): { getSnapshot(): unknown } } }
    } | undefined
    const outline = binding?.session.projections.faceOf('turnOutline').getSnapshot() as
      Array<{ turn: number }> | undefined
    return Array.isArray(outline) && outline.length >= 12
  }, 20_000)

  // Open the picker through the REAL /rewind submit gesture. The row
  // for the out-of-window turn 2 must appear from the WHOLE-LOG outline —
  // before any history paging (the initial window cannot cover 12 turns).
  app.setDraft('/rewind')
  app.submitDraft()
  await waitFor('picker open', () =>
    vt.getViewport().join('').includes('Rewind conversation'), 15_000)
  // Navigate DOWN to the LAST row (the OLDEST rewindable turn — 2, the
  // out-of-window target) and select it. The row count is deterministic
  // (12 seeded turns - 1 excluded first entry = 11 rows), so the cursor
  // target is fixed: 10 down-arrow presses from the first row.
  for (let i = 0; i < 10; i += 1) app.tui.handleTerminalInput('\x1b[B')
  await new Promise(resolve => setTimeout(resolve, 100))
  app.tui.handleTerminalInput('\r')

  // The fork must create a child on the Host and adopt it; the editor gets
  // the FULL prompt of turn 2.
  const hostIdsBefore = new Set(host.ctx.sessions.list().map(session => String(session.id)))
  await waitFor('forked child created on the Host', () => {
    return host.ctx.sessions.list().some(session => !hostIdsBefore.has(String(session.id)))
  }, 20_000)
  await waitFor('editor restored the FULL prompt', () => app.getDraft() === longPrompt, 20_000)
  const childId = host.ctx.sessions.list()
    .map(session => String(session.id))
    .find(id => !hostIdsBefore.has(id))!
  // The child carries the exact predecessor boundary prefix (turn 1
  // complete; the turn-2 events are NOT in the child — they were rewound).
  const child = host.ctx.sessions.get(SessionId(childId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }
  const childTurns = child.snapshotEvents().filter(event => event.type === 'turn/end')
  assert.equal(childTurns.length, 1, 'the child inherits exactly the predecessor completed turn (turn 1)')
  await waitFor('rewind success notice', () => vt.getViewport().join('').includes('rewound to turn 2'), 15_000)
})

test('L6 §7.4-15 stale rewind: select A\'s old turn → switch away mid-loadThrough → the old selection never forks', async (t) => {
  // The race §2.2/§16/§4.3 fence: the picker selection for A starts the
  // official loadThrough jump, the surface switches to B while it is in
  // flight, and the release must NOT fork anything — no child session on
  // the Host, no draft install, and the truthful "session changed" notice.
  const life = testLifecycle(t)
  const sessionA = 'm3-4-pr4-rewind-stale-a'
  const sessionB = 'm3-4-pr4-rewind-stale-b'
  const presetId = 'm3-4-pr4-preset'
  const host = await mountPr4Host(life, presetId)
  await host.harness.create(SessionId(sessionA), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  await host.harness.create(SessionId(sessionB), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const appendOf = (id: string) => host.ctx.sessions.get(SessionId(id)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  const seedTurn = (id: string, turn: number, prompt: string): void => {
    const session = appendOf(id)
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', {
      id: `u-${id}-${turn}`, role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn, step: 1,
      message: { id: `a-${id}-${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
      stream: [], usage: { inputTokens: 1, outputTokens: 1 },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // A carries the rewindable turns; B exists as the switch target.
  for (let turn = 1; turn <= 6; turn += 1) seedTurn(sessionA, turn, `stale prompt ${turn}`)

  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
  })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))

  // GATE the REAL loadThrough read the mounted rewind path consumes (the
  // production object, wrapped so the original still runs inside).
  let releaseLoad: (() => void) | undefined
  const loadGate = new Promise<void>(resolve => { releaseLoad = resolve })
  const reader = aggregate.presentation.presentationReader as {
    loadThrough(sessionId: string, seq: number, signal?: AbortSignal): Promise<unknown>
  }
  const originalLoadThrough = reader.loadThrough.bind(reader)
  let gatedLoads = 0
  reader.loadThrough = async (sessionId, seq, signal) => {
    gatedLoads += 1
    await loadGate
    return originalLoadThrough(sessionId, seq, signal)
  }

  const vt = new VirtualTerminal(110, 32)
  const restoreTerminal = await import('./support/runner-harness.ts').then(m => m.installVirtualProcessTerminal(vt))
  life.defer(restoreTerminal)

  const runnerCtx = host.ctx
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = host.workRoot
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  runnerCtx.provide('appExit', (code: number) => { void code })
  const { TUI_STARTUP_SERVICE } = await import('../src/startup.ts')
  runnerCtx.provide(TUI_STARTUP_SERVICE, {
    sessionId: sessionA,
    shippedPresetRoot: host.workRoot,
  })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
  }
  const apps: unknown[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: unknown) {
    apps.push(this)
    return originalStart.call(this)
  }
  life.defer(() => { TuiApp.prototype.start = originalStart })
  const runnerFiber = runnerCtx.plugin(pluginCtx => {
    applyRunnerWithRuntime(pluginCtx, TuiConfigSchema({ fullscreen: 'off', sessionId: sessionA } as never), override)
  })
  await runnerFiber
  life.defer(() => runnerFiber.dispose())
  await waitFor('remote runner mount', () => vt.getViewport().join('').length > 0, 20_000)

  const app = await (async () => {
    for (let i = 0; i < 600; i += 1) {
      const candidate = apps.at(-1) as unknown as {
        setDraft(text: string): void
        submitDraft(): void
        getDraft(): string
        tui: { handleTerminalInput(data: string): void }
      } | undefined
      if (candidate !== undefined && typeof candidate.setDraft === 'function') return candidate
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the mounted app never exposed the draft surface')
  })()
  await waitFor('A hydrated', () => vt.getViewport().join('').includes('stale prompt 6') || vt.getViewport().join('').includes('answer 6'), 20_000)

  // Open the picker on A and select the OLDEST rewindable turn (turn 2 —
  // the last row of 5; 4 down-arrow presses).
  app.setDraft('/rewind')
  app.submitDraft()
  await waitFor('picker open', () => vt.getViewport().join('').includes('Rewind conversation'), 15_000)
  for (let i = 0; i < 4; i += 1) app.tui.handleTerminalInput('\x1b[B')
  await new Promise(resolve => setTimeout(resolve, 100))
  app.tui.handleTerminalInput('\r')
  await waitFor('the gated loadThrough started', () => gatedLoads === 1, 10_000)

  // SWITCH to B while A's loadThrough is still held.
  const hostIdsBefore = new Set(host.ctx.sessions.list().map(session => String(session.id)))
  app.setDraft(`/resume ${sessionB}`)
  app.submitDraft()
  await waitFor('B is the current subject', () =>
    vt.getViewport().join('').includes('answer 6') === false, 20_000)

  // Release: the stale selection must NOT fork — no new child session, no
  // draft install, and the truthful notice on the CURRENT surface.
  releaseLoad?.()
  await waitFor('the truthful stale notice rendered', () =>
    vt.getViewport().join('').includes('the session changed while rewinding'), 15_000)
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.deepEqual(host.ctx.sessions.list().map(session => String(session.id)).filter(id => !hostIdsBefore.has(id)), [],
    'the stale selection never forked a replacement session (zero children)')
  assert.equal(app.getDraft(), '', 'the stale selection never installed its editor text')
})


test('PR5 R7-4: a rewind pre-admission LOAD failure follows the PICKER identity (Remote async read)', async (t) => {
  // §3C-4: a throw from the PRE-ADMISSION region — the `loadThrough` detail
  // read, which on the Remote branch is a real async transport read (the Direct
  // adapter's is synchronous by construction, so the window is only expressible
  // here) — belongs to the PICKER identity: superseded => suppressed, current =>
  // published. Both halves run against ONE mounted surface so the only
  // difference is the navigation.
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-rewind-load'
  const targetId = 'm3-4-pr4-rewind-load-target'
  const presetId = 'm3-4-pr4-preset'
  const host = await mountPr4Host(life, presetId)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  await host.harness.create(SessionId(targetId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  const seed = (id: string, label: string): void => {
    const session = host.ctx.sessions.get(SessionId(id)) as unknown as { append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void }
    for (let turn = 1; turn <= 2; turn += 1) {
      session.append('turn/start', { turn })
      session.append('step/start', { turn, step: 1 })
      session.append('user/message', { id: `u-${label}-${turn}`, role: 'user', content: [{ type: 'text', text: `${label} prompt ${turn}` }], source: { kind: 'user' } }, { surfaceOp: 'append' })
      session.append('assistant/message', {
        turn, step: 1,
        message: { id: `a-${label}-${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }], source: { kind: 'model', provider: 'smoke', model: 'smoke' } },
        stream: [], usage: { inputTokens: 1, outputTokens: 1 },
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step: 1 })
      session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
  }
  seed(mainId, 'load')
  seed(targetId, 'target')

  const aggregate = await createRemoteApplicationRuntime({ hostContext: host.ctx, waitForHostPrerequisites: async () => {} })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))
  const vt = new VirtualTerminal(110, 32)
  const restoreTerminal = await import('./support/runner-harness.ts').then(m => m.installVirtualProcessTerminal(vt))
  life.defer(restoreTerminal)
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = host.workRoot
  life.defer(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })
  host.ctx.provide('appExit', (code: number) => { void code })
  const { TUI_STARTUP_SERVICE } = await import('../src/startup.ts')
  host.ctx.provide(TUI_STARTUP_SERVICE, { sessionId: mainId, shippedPresetRoot: host.workRoot })
  const override: RemoteApplicationOverride = { selected: aggregate.selected, presentation: aggregate.presentation }
  const apps: unknown[] = []
  const originalStart = TuiApp.prototype.start
  TuiApp.prototype.start = function patchedStart(this: unknown) { apps.push(this); return originalStart.call(this) }
  life.defer(() => { TuiApp.prototype.start = originalStart })
  const runnerFiber = host.ctx.plugin(pluginCtx => {
    applyRunnerWithRuntime(pluginCtx, TuiConfigSchema({ fullscreen: 'off', sessionId: mainId } as never), override)
  })
  await runnerFiber
  life.defer(() => { runnerFiber.dispose() })
  await waitFor('remote runner mount', () => vt.getViewport().join('').length > 0, 20_000)
  const app = await (async () => {
    for (let i = 0; i < 600; i++) {
      const candidate = apps.at(-1) as unknown as { setDraft(text: string): void; submitDraft(): void; tui: { handleTerminalInput(data: string): void } } | undefined
      if (candidate !== undefined && typeof candidate.setDraft === 'function') return candidate
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the mounted app never exposed the draft surface')
  })()

  // Park the selection's detail read (the test owns this injected port object).
  const reader = aggregate.presentation.presentationReader as unknown as {
    loadThrough(sessionId: string, seq: number, signal?: AbortSignal): Promise<unknown>
  }
  const originalLoad = reader.loadThrough.bind(reader)
  let releaseLoad: (() => void) | undefined
  let parked = false
  life.defer(() => { releaseLoad?.() })
  life.defer(() => { reader.loadThrough = originalLoad })
  reader.loadThrough = async (sessionId, seq, signal) => {
    if (!parked) {
      parked = true
      await new Promise<void>(resolve => { releaseLoad = resolve })
      throw new Error('rewind load failed (fixture)')
    }
    return originalLoad(sessionId, seq, signal)
  }

  // PHASE 1 (stale): pick a turn, move the navigation with a REAL /resume, then
  // let the read fail. A picker identity that has been superseded must not
  // publish the failure.
  app.setDraft('/rewind')
  app.submitDraft()
  await waitFor('picker open (phase 1)', () => vt.getViewport().join('').includes('Rewind conversation'), 15_000)
  app.tui.handleTerminalInput('\x1b[B')
  app.tui.handleTerminalInput('\r')
  await waitFor('the parked load read was entered (phase 1)', () => parked, 10_000)
  app.setDraft(`/resume ${targetId}`)
  app.submitDraft()
  await new Promise(resolve => setTimeout(resolve, 400))
  releaseLoad?.()
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(vt.getViewport().join('').includes('rewind load failed (fixture)'), false,
    'a superseded pre-admission load failure must not be published to the replacement surface')

  // PHASE 2 (positive control): the SAME failure on a current picker identity
  // must be published — so phase 1's silence cannot be a vacuous "nothing ran".
  parked = false
  app.setDraft('/rewind')
  app.submitDraft()
  await waitFor('picker open (phase 2)', () => vt.getViewport().join('').includes('Rewind conversation'), 15_000)
  app.tui.handleTerminalInput('\x1b[B')
  app.tui.handleTerminalInput('\r')
  await waitFor('the parked load read was entered (phase 2)', () => parked, 10_000)
  releaseLoad?.()
  await waitFor('the current load failure is published', () => vt.getViewport().join('').includes('rewind load failed (fixture)'), 10_000)
})
