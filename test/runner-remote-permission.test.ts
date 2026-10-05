/**
 * M3-4 PR4 L6 permission cycle (plan §7.4 scenario 12): the REAL Remote
 * composition with the official `dsh-permission-presets` service mounted —
 * the current value renders from the `permissions` projection, Shift+Tab
 * dispatches exactly one semantic permission apply through the wire
 * (ConfigPort → the official `/permission` command), and the PUSHED
 * projection repaints the new value (never an optimistic local install).
 *
 * PRODUCTION PREREQUISITES REPRODUCED: the real rc.2 Host services (the
 * PR2/PR4 fixture rows + the official permission-presets service over a
 * minimal confining shell double), the official Client/Gateway path, the
 * REAL runner composition root with the production serializer.
 *
 * TEST STAND-INS: the scripted LLM adapter + the shell sandboxMode double
 * (the service only reads the confine fact; no shell execution happens).
 *
 * @module @xmoon76/dsh-pi-tui/runner-remote-permission.test
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

class StubStreamingLlmAdapter extends LlmAdapter {
  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke', name: 'Smoke Model' }])
  }

  override async *stream(): AsyncGenerator<never> {}
}

test('L6 §7.4-12: Remote permission cycle — projection current, one semantic apply, pushed projection repaints', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr4-perm'
  const presetId = 'm3-4-pr4-preset'
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  const host = await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: new StubStreamingLlmAdapter(),
  })
  // The official permission-presets service: the real preset table, the real
  // `permissions` Session projection, the real `/permission` command. Its
  // shell inject reads only the confine fact (sandboxMode).
  host.ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  const { PermissionPresetService } = await import('@deepseek-ai/dsh-permission-presets')
  await host.ctx.plugin(PermissionPresetService as never, undefined as never)
  // The approval service the preset switch writes through.
  const approval = await import('@deepseek-ai/dsh-user-approval')
  await host.ctx.plugin((approval as unknown as { default: new (ctx: never, config?: never) => unknown }).default as never, undefined as never)
  const turnOutline = await import('@deepseek-ai/dsh-session-turn-outline')
  await host.ctx.plugin(turnOutline)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    // The runner receives the same startup facts (M3-6 PR1: the Client UI
    // subtree mounts under the exact detached sessionId/presetId copy).
    clientUiStartup: { sessionId: mainId },
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
  runnerCtx.provide(TUI_STARTUP_SERVICE, { sessionId: mainId, shippedPresetRoot: host.workRoot })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
    extensionService: aggregate.clientUi.extensionService,
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
        statusStore: { snapshot(): { access?: { permissionPreset?: { id?: string }; sandbox?: unknown; approval?: unknown } } }
      } | undefined
      if (candidate !== undefined && candidate.statusStore !== undefined) return candidate
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the mounted app never exposed the status store')
  })()

  // 1. The current value renders from the PROJECTION (the service pins the
  //    initial permission on session create; the pushed baseline carries it).
  const store = app as unknown as { statusStore: { subscribe(l: (s: unknown) => void): () => void; revision(): number } }
  const timeline: string[] = []
  const unsubscribe = store.statusStore.subscribe(snapshot => {
    timeline.push(`rev=${store.statusStore.revision()} access=${JSON.stringify((snapshot as { access?: unknown }).access)}`)
  })
  try {
    await waitFor('projection-backed preset rendered', () =>
      app.statusStore.snapshot().access?.permissionPreset?.id !== undefined, 20_000)
  } catch (error) {
    console.error('[perm-l6-timeline]\n' + timeline.join('\n'))
    throw error
  } finally {
    unsubscribe()
  }
  const before = app.statusStore.snapshot().access!.permissionPreset!.id!
  assert.equal(app.statusStore.snapshot().access?.sandbox, undefined,
    'the sandbox fact stays omitted on Remote (§6.6)')
  assert.equal(app.statusStore.snapshot().access?.approval, undefined,
    'the approval fact stays omitted on Remote (§6.6)')

  // 2. The REAL cycle action (the keybinding's production callback —
  //    exactly ONE semantic apply through the wire: ConfigPort → the
  //    official /permission command).
  const cycle = (app as unknown as { events: { onCyclePermission?: () => void } }).events.onCyclePermission
  assert.ok(cycle !== undefined, 'the mounted app exposes the production cycle action')
  cycle!()

  // 3. The PUSHED projection repaints the next value (never a local
  //    install — the store only sees projection-driven refreshes).
  await waitFor('the pushed projection repainted the next preset', () => {
    const current = app.statusStore.snapshot().access?.permissionPreset?.id
    return current !== undefined && current !== before
  }, 20_000)
  const after = app.statusStore.snapshot().access!.permissionPreset!.id!
  const names = [...aggregate.selected.backend.config.permissions.presetNames()]
  assert.equal(after, names[(names.indexOf(before) + 1) % names.length]!,
    'the cycle followed the ConfigPort catalog order')

  // 4. §7.4-12's "exactly one apply": the durable `command/run` rows of the
  //    official /permission executor (the authoritative once-only evidence,
  //    the same negative-fact probe the command-plane L6 uses — never a
  //    test-internal flag).
  await waitFor('the official /permission lifecycle rows landed', () => {
    const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ type: string; data: unknown }>
    }
    const kinds = session.snapshotEvents().map(event => event.type)
    return kinds.includes('command/run') && kinds.includes('command/done')
  }, 15_000)
  const permissionRuns = (host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }).snapshotEvents().filter(event => event.type === 'command/run')
  assert.equal(permissionRuns.length, 1,
    'the cycle dispatched EXACTLY ONE official /permission command (no retry, no duplicate)')
})

test('L6 §7.4-13 stale permission: apply A → switch B before settle → NO B contamination', async (t) => {
  // The race the fences exist for: the /permission apply for A is still
  // executing when the surface switches to B. The stale gesture's notice
  // must NEVER surface on B's surface, and B's pushed projection value
  // must remain its OWN baseline (the write may have committed on A — that
  // is A's business, never B's footer).
  const life = testLifecycle(t)
  const sessionA = 'm3-4-pr4-perm-stale-a'
  const sessionB = 'm3-4-pr4-perm-stale-b'
  const presetId = 'm3-4-pr4-preset'
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  const host = await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: new StubStreamingLlmAdapter(),
  })
  host.ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  const { PermissionPresetService } = await import('@deepseek-ai/dsh-permission-presets')
  await host.ctx.plugin(PermissionPresetService as never, undefined as never)
  const approval = await import('@deepseek-ai/dsh-user-approval')
  await host.ctx.plugin((approval as unknown as { default: new (ctx: never, config?: never) => unknown }).default as never, undefined as never)
  const turnOutline = await import('@deepseek-ai/dsh-session-turn-outline')
  await host.ctx.plugin(turnOutline)
  await host.harness.create(SessionId(sessionA), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })
  await host.harness.create(SessionId(sessionB), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  // HOLD the OFFICIAL /permission execution for A: the real executor is
  // wrapped (the original still runs inside), gated on a test promise. The
  // gate is installed BEFORE the runner mounts so the cycle's dispatch
  // hits it deterministically.
  let releasePermission: (() => void) | undefined
  const permissionGate = new Promise<void>(resolve => { releasePermission = resolve })
  const commands = host.ctx.get('commands') as {
    execute(agent: unknown, line: string, attachments?: readonly unknown[], signal?: AbortSignal): Promise<unknown>
  }
  const originalExecute = commands.execute.bind(commands)
  const gatedLines: string[] = []
  const gatedExecute: typeof commands.execute = async (agent, line, attachments, signal) => {
    if (line.includes('/permission') && gatedLines.length === 0) {
      gatedLines.push(line)
      await permissionGate
    }
    return originalExecute(agent, line, attachments, signal)
  }
  commands.execute = gatedExecute

  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    clientUiStartup: { sessionId: sessionA },
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
  runnerCtx.provide(TUI_STARTUP_SERVICE, { sessionId: sessionA, shippedPresetRoot: host.workRoot })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
    extensionService: aggregate.clientUi.extensionService,
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
        statusStore: { snapshot(): { access?: { permissionPreset?: { id?: string } } } }
      } | undefined
      if (candidate !== undefined && candidate.statusStore !== undefined) return candidate
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the mounted app never exposed the status store')
  })()
  await waitFor('A\'s projection preset rendered', () =>
    app.statusStore.snapshot().access?.permissionPreset?.id !== undefined, 20_000)
  const aPreset = app.statusStore.snapshot().access!.permissionPreset!.id!

  // Capture every notice B's surface could show (the contamination channel).
  const notices: string[] = []
  const originalNotify = (app as unknown as { notify(message: string, kind?: string): void }).notify.bind(app)
  ;(app as unknown as { notify(message: string, kind?: string): void }).notify = (message, kind) => {
    notices.push(message)
    originalNotify(message, kind)
  }

  // 1. The cycle gesture on A — the /permission execution now HOLDS. A
  //    failure past this point must still release the gate (the runOwned
  //    settlement waits on it during teardown).
  life.defer(() => releasePermission?.())
  const cycle = (app as unknown as { events: { onCyclePermission?: () => void } }).events.onCyclePermission
  assert.ok(cycle !== undefined)
  cycle!()
  await waitFor('the gated /permission dispatch started', () => gatedLines.length === 1, 10_000)

  // 2. SWITCH to B while A's apply is still in flight (the real /resume
  //    submit gesture through the mounted surface). A and B carry
  //    DISTINCT conversation rows, so the current subject is proven by the
  //    AUTHORITY the surface renders from: B's own rows visible AND A's
  //    rows retired — never by a predicate A already satisfies.
  const appendOf = (id: string) => host.ctx.sessions.get(SessionId(id)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  for (const [id, label] of [[sessionA, 'alpha-perm'] as const, [sessionB, 'beta-perm'] as const]) {
    const session = appendOf(id)
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', {
      id: `u-${label}`, role: 'user', content: [{ type: 'text', text: `${label} probe row` }], source: { kind: 'user' },
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  const mounted = app as unknown as { setDraft(text: string): void; submitDraft(): void }
  mounted.setDraft(`/resume ${sessionB}`)
  mounted.submitDraft()
  await waitFor('B is the committed current subject (B rows rendered, A rows retired)', () => {
    const view = vt.getViewport().join('')
    return view.includes('beta-perm probe row') && !view.includes('alpha-perm probe row')
  }, 20_000)
  await waitFor('B\'s projection preset rendered', () => {
    return app.statusStore.snapshot().access?.permissionPreset?.id !== undefined
  }, 20_000)
  const bPreset = app.statusStore.snapshot().access!.permissionPreset!.id!

  // 3. Release A's held apply: the write may commit on A, but B's surface
  //    must show NOTHING of it — no stale notice, no footer repaint.
  releasePermission?.()
  await new Promise(resolve => setTimeout(resolve, 300))
  const permissionNotices = notices.filter(text => text.includes('permission'))
  assert.deepEqual(permissionNotices, [],
    `the stale A gesture must notify NOTHING on B's surface: ${JSON.stringify(notices)}`)
  assert.equal(app.statusStore.snapshot().access?.permissionPreset?.id, bPreset,
    'B\'s footer keeps B\'s own projection value (A\'s committed switch never repaints B)')
  // A's write landed on A's session only (the official rows exist there,
  // and B's durable log carries no /permission row at all).
  await waitFor('A\'s official /permission rows landed', () => {
    const kinds = (host.ctx.sessions.get(SessionId(sessionA)) as unknown as {
      snapshotEvents(): Array<{ type: string }>
    }).snapshotEvents().map(event => event.type)
    return kinds.includes('command/run') && kinds.includes('command/done')
  }, 15_000)
  const bRows = (host.ctx.sessions.get(SessionId(sessionB)) as unknown as {
    snapshotEvents(): Array<{ type: string }>
  }).snapshotEvents().map(event => event.type)
  assert.equal(bRows.includes('command/run'), false,
    'B\'s durable log carries no /permission execution (zero contamination)')
  assert.notEqual(aPreset, undefined)
})

test('L6 PR5 §1D: /yolo on a Remote live session reaches the semantic permission apply with NO Direct-Agent prerequisite', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-4-pr5-yolo'
  const presetId = 'm3-4-pr4-preset'
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  const host = await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: new StubStreamingLlmAdapter(),
  })
  host.ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  const { PermissionPresetService } = await import('@deepseek-ai/dsh-permission-presets')
  await host.ctx.plugin(PermissionPresetService as never, undefined as never)
  const approval = await import('@deepseek-ai/dsh-user-approval')
  await host.ctx.plugin((approval as unknown as { default: new (ctx: never, config?: never) => unknown }).default as never, undefined as never)
  const turnOutline = await import('@deepseek-ai/dsh-session-turn-outline')
  await host.ctx.plugin(turnOutline)
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    clientUiStartup: { sessionId: mainId },
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
  runnerCtx.provide(TUI_STARTUP_SERVICE, { sessionId: mainId, shippedPresetRoot: host.workRoot })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
    extensionService: aggregate.clientUi.extensionService,
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
    for (let i = 0; i < 600; i += 1) {
      const candidate = apps.at(-1) as unknown as {
        statusStore: { snapshot(): { access?: { permissionPreset?: { id?: string } } } }
        setDraft(text: string): void
        submitDraft(request?: string): void
      } | undefined
      if (candidate !== undefined && candidate.statusStore !== undefined) return candidate
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the mounted app never exposed the status store')
  })()

  await waitFor('the baseline preset rendered', () =>
    app.statusStore.snapshot().access?.permissionPreset?.id !== undefined, 20_000)
  const before = app.statusStore.snapshot().access!.permissionPreset!.id!
  assert.notEqual(before, 'danger-full-access', 'the fixture starts OFF danger-full-access')

  // THE REAL COMMAND: /yolo submits through the mounted editor. No Direct
  // Agent exists on this branch — the removed `agentForLiveScope` gate was
  // the only Direct-object prerequisite in the path.
  app.setDraft('/yolo')
  app.submitDraft()

  // The committed permission projection owns the display.
  await waitFor('the committed projection shows danger-full-access', () =>
    app.statusStore.snapshot().access?.permissionPreset?.id === 'danger-full-access', 20_000)

  // Exactly ONE official /permission execution (no retry, no duplicate) and
  // no OTHER Host command rows for the line.
  await waitFor('the official /permission lifecycle rows landed', () => {
    const session = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
      snapshotEvents(): Array<{ type: string; data: unknown }>
    }
    return session.snapshotEvents().some(event => event.type === 'command/done')
  }, 15_000)
  const events = (host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    snapshotEvents(): Array<{ type: string; data: unknown }>
  }).snapshotEvents()
  assert.equal(events.filter(event => event.type === 'command/run').length, 1,
    'exactly ONE official /permission command ran (never retried, never duplicated)')
})

test('L6 M3-6 PR2 §14.9: a real pending Remote Question survives reconnect — the same flow answers exactly once, no duplicate overlay, no answer replay', async (t) => {
  const life = testLifecycle(t)
  const mainId = 'm3-6-pr2-q'
  const presetId = 'm3-4-pr4-preset'
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  const host = await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: new StubStreamingLlmAdapter(),
  })
  // The live Agent the official userQuestions service scopes its waterfall to
  // (the same live-root identity the production ask path requires).
  const agent = await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    clientUiStartup: { sessionId: mainId },
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
  runnerCtx.provide(TUI_STARTUP_SERVICE, { sessionId: mainId, shippedPresetRoot: host.workRoot })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
    extensionService: aggregate.clientUi.extensionService,
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
    for (let i = 0; i < 600; i += 1) {
      const candidate = apps.at(-1) as unknown as {
        overlayGraphState(): { handles: number }
      } | undefined
      if (candidate !== undefined && candidate.overlayGraphState !== undefined) return candidate as never
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the mounted app never exposed the overlay graph')
  })()
  const view = (): string => vt.getViewport().join('\n')

  // ── A REAL Host Question becomes pending: the official service's live
  // waterfall (the exact path a tool call takes), forwarded over the wire to
  // the mounted TUI's question surface.
  const service = host.ctx.get('userQuestions') as unknown as {
    ask(request: { questions: readonly unknown[]; agent: unknown }): Promise<{ answers: Array<{ id: string; selected: string[] }> }>
  }
  const questions = [{ id: 'q1', question: 'Proceed with the reconnect probe?', options: [{ label: 'yes' }, { label: 'no' }] }]
  const askSettled = service.ask({ questions, agent })
  let askOutcome: { kind: 'fulfilled'; value: unknown } | { kind: 'rejected'; reason: unknown } | undefined
  const outcomeKind = (): string | undefined => askOutcome?.kind
  askSettled.then(
    value => { askOutcome = { kind: 'fulfilled', value } },
    reason => { askOutcome = { kind: 'rejected', reason } },
  )
  await waitFor('the question surface is visible', () => view().includes('Proceed with the reconnect probe?'), 20_000)
  const handlesBefore = (app as unknown as { overlayGraphState(): { handles: number } }).overlayGraphState().handles

  // ── reconnect A -> B (the same official carrier the sibling suites use).
  const connection = aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const generationBefore = connection.generation.getSnapshot()?.id
  connection.reconnect()
  await waitFor('a NEW DEFINED Connection generation is established', () => {
    const current = connection.generation.getSnapshot()?.id
    return current !== undefined && current !== generationBefore
  }, 20_000)

  // The SAME question flow remains mounted and answerable after B: exactly
  // one overlay (no duplicate question surface), the Host ask still pending
  // (no fabricated settlement, no error surfaced by the transport rollover).
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(view().includes('Proceed with the reconnect probe?'), true,
    'the same question remains visible after the reconnect')
  assert.equal((app as unknown as { overlayGraphState(): { handles: number } }).overlayGraphState().handles, handlesBefore,
    'no duplicate question overlay was created by the reconnect')
  assert.equal(askOutcome, undefined,
    'the Host ask is still pending after the reconnect (no transport-driven settlement)')

  // ── Answer through the MOUNTED question flow (the real single-select key
  // + submit): exactly one answer reaches the Host.
  vt.sendInput('1')
  await new Promise(resolve => setTimeout(resolve, 300))
  await waitFor('the review page rendered', () => view().includes('Submit'), 10_000)
  vt.sendInput('\r')
  const settled = await askSettled
  assert.deepEqual(settled.answers, [{ id: 'q1', selected: ['yes'] }],
    'the mounted answer reached the official Host ask exactly as submitted')
  assert.equal(outcomeKind(), 'fulfilled',
    'the ask settled exactly once (fulfilled, never rejected by the reconnect)')
  await waitFor('the question overlay retired after the answer', () =>
    view().includes('Proceed with the reconnect probe?') === false, 10_000)
  // No answer replay: the settled ask produced exactly ONE fulfillment and
  // the overlay never re-armed.
  assert.equal((app as unknown as { overlayGraphState(): { handles: number } }).overlayGraphState().handles, 0,
    'the question surface fully retired after the single answer')
})

test('L6 M3-6 PR2 (review follow-up): a dispatched continued-answer settlement stays real across reconnect — classified from the Host result, never replayed', async (t) => {
  // The §16.3 write-settlement window the live-waterfall case cannot reach:
  // the answer is dispatched through `answerContinued()` on generation A,
  // the Connection reconnects while the settlement is in flight, and the
  // PROVEN Host settlement (`ok: true` — the reply was accepted and queued)
  // must be reported truthfully (never reinterpreted as a transport
  // supersession), with exactly one Host answer admission and no replay.
  const life = testLifecycle(t)
  const mainId = 'm3-6-pr2-q2'
  const presetId = 'm3-4-pr4-preset'
  const { createRemoteApplicationHostFixture } = await import('./support/remote-application-fixture.ts')
  const host = await createRemoteApplicationHostFixture(life, presetId, {
    llmAdapter: new StubStreamingLlmAdapter(),
  })
  await host.harness.create(SessionId(mainId), { provider: 'smoke', model: 'smoke' }, { cwd: host.anchorDir })

  // ── Seed a DURABLE continued question: request/header declares the timed
  // ask_user_question tool, the tool call carries the questions, and the
  // tool result is PENDING — the exact fold the official projection uses to
  // mark a call `continued`.
  const seed = host.ctx.sessions.get(SessionId(mainId)) as unknown as {
    append(type: string, data: unknown, options?: { surfaceOp?: 'append' }): void
  }
  seed.append('request/header', {
    header: {
      config: { provider: 'smoke', model: 'smoke' },
      tools: [{ name: 'ask_user_question', description: 'ask', parameters: { type: 'object', properties: { timeout: { type: 'number' }, questions: { type: 'array' } } } }],
    },
  })
  seed.append('turn/start', { turn: 1 })
  seed.append('step/start', { turn: 1, step: 1 })
  seed.append('tool/call', {
    turn: 1, step: 1, callId: 'call-q2',
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ id: 'q1', question: 'Ship the recovery?', options: [{ label: 'yes' }, { label: 'no' }] }], timeout: 30000 }),
  })
  seed.append('tool/result', {
    turn: 1, step: 1,
    message: {
      id: 'msg-q2-result', role: 'tool', toolCallId: 'call-q2',
      content: [{ type: 'text', text: JSON.stringify({ pending: true }) }],
      source: { kind: 'tool', callId: 'call-q2' },
    },
  }, { surfaceOp: 'append' })

  const aggregate = await createRemoteApplicationRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
    clientUiStartup: { sessionId: mainId },
  })
  life.defer(() => aggregate.selected.disposeTransport().catch(() => {}))

  // HOLD the wire-level answer settlement: the Host-side service has
  // accepted the reply by the time the promise resolves, but the Client
  // sees it only on release (the in-flight window the reconnect lands in).
  // The wrap lands on the UNWRAPPED Host service implementation (the Cordis
  // traceable proxy refuses `set`; the unwrap discipline is the one the
  // extension-service identity probes use). Holding the Host-side answer
  // holds the typert settlement the Client awaits — the write is dispatched
  // and the Host has accepted the reply before the gate opens.
  const { symbols } = await import('@deepseek-ai/cordis')
  const hostServiceProxy = host.ctx.get('userQuestions') as unknown as Record<symbol, unknown> & {
    answer(agent: unknown, callId: unknown, answer: unknown): boolean | Promise<boolean>
  }
  const hostService = (hostServiceProxy[symbols.original] ?? hostServiceProxy) as typeof hostServiceProxy
  let answerDispatches = 0
  let releaseSettlement: (() => void) | undefined
  const settlementGate = new Promise<void>(resolve => { releaseSettlement = resolve })
  const originalAnswer = hostService.answer.bind(hostService)
  hostService.answer = async (agent: unknown, callId: unknown, answer: unknown): Promise<boolean> => {
    answerDispatches += 1
    const accepted = originalAnswer(agent, callId, answer)
    // The Host-side admission is already real (synchronously accepted); the
    // gate holds only the wire settlement the Client — and the adapter —
    // await. Awaiting INSIDE the exported method holds the typert call.
    await settlementGate
    return accepted
  }
  life.defer(() => releaseSettlement?.())

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
  runnerCtx.provide(TUI_STARTUP_SERVICE, { sessionId: mainId, shippedPresetRoot: host.workRoot })
  const override: RemoteApplicationOverride = {
    selected: aggregate.selected,
    presentation: aggregate.presentation,
    extensionService: aggregate.clientUi.extensionService,
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
    for (let i = 0; i < 600; i += 1) {
      const candidate = apps.at(-1) as unknown as {
        notifyTextForTest(): string
      } | undefined
      if (candidate !== undefined && candidate.notifyTextForTest !== undefined) return candidate as never
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw new Error('the mounted app never exposed the notice probe')
  })()
  const view = (): string => vt.getViewport().join('\n')
  const notices = (): string => (app as unknown as { notifyTextForTest(): string }).notifyTextForTest()

  // ── Open the continued question: the empty-editor ↓ affordance (active
  // question attention makes tasks active) → the attention row → Enter
  // reopens the SAME controller entry as a visible form.
  // The FULL Task Center (/tasks) is the proven Enter-opens-row surface the
  // job-viewer suite drives; the question attention row renders under
  // "Needs attention" with Enter wired to the controller's reopen.
  const submitLine = (line: string): void => {
    (app as unknown as { setDraft(text: string): void; submitDraft(): void }).setDraft(line)
    ;(app as unknown as { submitDraft(): void }).submitDraft()
  }
  submitLine('/tasks')
  await waitFor('the task browser listed the question row', () =>
    view().includes('Ship the recovery?'), 20_000)
  for (let step = 0; step <= 8; step += 1) {
    if (view().split('\n').some(line => line.includes('→') && line.includes('Ship the recovery?'))) break
    vt.sendInput('\x1b[B')
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  vt.sendInput('\r')
  try {
    await waitFor('the continued question form mounted', () =>
      view().includes('Ship the recovery?') && view().includes('yes'), 20_000)
  } catch (error) {
    console.error('[q2-dump] enter-press viewport:\n' + view())
    throw error
  }

  // ── Submit the answer on generation A: the write dispatches and its
  // settlement is HELD in flight.
  vt.sendInput('1')
  await new Promise(resolve => setTimeout(resolve, 300))
  await waitFor('the review page rendered', () => view().includes('Submit'), 10_000)
  vt.sendInput('\r')
  await waitFor('the answer write dispatched on generation A', () => answerDispatches === 1, 15_000)

  // ── reconnect A -> B while the settlement is in flight.
  const connection = aggregate.wire.client.connection as unknown as {
    generation: { getSnapshot(): { readonly id: number } | undefined }
    reconnect(): void
  }
  const generationBefore = connection.generation.getSnapshot()?.id
  connection.reconnect()
  await waitFor('a NEW DEFINED Connection generation is established', () => {
    const current = connection.generation.getSnapshot()?.id
    return current !== undefined && current !== generationBefore
  }, 20_000)

  // ── Release the proven settlement: it must be reported TRUTHFULLY (the
  // queued notice), never reinterpreted as a supersession.
  releaseSettlement?.()
  await waitFor('the proven settlement was reported truthfully', () =>
    notices().includes('Answer queued'), 20_000)
  // Exactly ONE Host answer admission across the whole reconnect; no replay.
  await new Promise(resolve => setTimeout(resolve, 800))
  assert.equal(answerDispatches, 1,
    'exactly one answer admission — the settlement was never retried or replayed across the reconnect')
  // The entry retires through the settlement (the form is spent): the FORM
  // (its option rows) disappears. The question TEXT itself legitimately
  // stays on screen — the durable transcript card carries the call — so the
  // witness is the interactive form, not the text.
  await waitFor('the question form retired after the truthful settlement', () =>
    view().includes('yes') === false, 10_000)
})
