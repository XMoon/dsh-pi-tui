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
})
