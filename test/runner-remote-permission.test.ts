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

  // 1. The cycle gesture on A — the /permission execution now HOLDS.
  const cycle = (app as unknown as { events: { onCyclePermission?: () => void } }).events.onCyclePermission
  assert.ok(cycle !== undefined)
  cycle!()
  await waitFor('the gated /permission dispatch started', () => gatedLines.length === 1, 10_000)

  // 2. SWITCH to B while A's apply is still in flight (the real /resume
  //    submit gesture through the mounted surface).
  const mounted = app as unknown as { setDraft(text: string): void; submitDraft(): void }
  mounted.setDraft(`/resume ${sessionB}`)
  mounted.submitDraft()
  await waitFor('B\'s projection preset rendered (B is the current subject)', () => {
    const current = app.statusStore.snapshot().access?.permissionPreset?.id
    return current !== undefined
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
