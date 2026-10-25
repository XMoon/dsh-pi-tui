/**
 * The production `/settings → Tools → Visual tools` decision over the REAL
 * Direct configuration plane, with a real model request on each side.
 *
 * ```text
 * TuiApp / SettingsWorkspacePanel Confirm
 *   -> commitSettingsWorkspaceField -> DirectConfigPort.visualTools.setEnabled
 *   -> official SettingsForms.mutate -> real ConfigEditor/USER profile write
 *   -> real Loader volatile commit -> loader/volatile-update
 *   -> real Host ToolRuntime register/unregister
 *   -> the next real AgentLoop request's tool catalog / PTC SDK
 * ```
 *
 * FIXTURE MANIFEST
 * - REAL: TuiApp + VirtualTerminal + the registered `/settings` command, the
 *   production DirectConfigPort, the shared visual-tools profile plane (real
 *   Loader/ConfigEditor/SettingsForms/Host row/ToolRuntime), the real AgentLoop
 *   and an in-process recording LLM adapter (the only stand-in: the model
 *   endpoint itself).
 * - STAND-INS: application capabilities this command path never exercises
 *   (sessions/readers, clipboard, providers/account/authorization seams) are
 *   inert stubs, exactly like the established Settings visual harness; they
 *   answer no Host fact this case asserts.
 * - ABSENT: a physical terminal and a real user DSH_HOME.
 * @module @xmoon76/dsh-pi-tui/test/integration/visual-tools-settings-ui
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import {
  LlmAdapter,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { SessionId } from '@deepseek-ai/dsh-session'
import { renderToolsSdk, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import {
  CHART_TOOL_NAME,
  PRESENT_VISUAL_TOOL_NAME,
  SVG_TOOL_NAME,
} from '../../src/domain/visual/tools.ts'
import SessionQuerySqlite from '@deepseek-ai/dsh-session-query-sqlite'
import { TuiApp, type OwnedRunner, type TuiAppEvents } from '../../src/tui-app.ts'
import type { TuiCommandRunner } from '../../src/commands.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'
import { waitForFrame } from '../support/frame-wait.ts'
import { mountVisualToolsSettingsPlane } from '../support/visual-tools-plane.ts'
import { mountPermissionDefaultPlane } from '../support/permission-default-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

/** The PTC SDK rendering of the current Host registry (the same definitions a
 *  PTC-mode request presents). */
function ptcSdkOf(ctx: Context): string {
  const schemas = ctx.tools.schemas().flatMap((schema) => {
    const definition = ctx.tools.get(schema.name)
    return definition === undefined
      ? []
      : [{
          name: definition.name,
          description: definition.description,
          parameters: definition.parameters,
          output: definition.output.schema,
        }]
  })
  return renderToolsSdk(schemas)
}

/** The one substituted boundary: a recording model endpoint. */
class RecordingAdapter extends LlmAdapter {
  /** Every request's tool-name list, in request order. */
  readonly requests: string[][] = []

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
    this.requests.push(((options as unknown as { tools?: readonly { name: string }[] }).tools ?? []).map(tool => tool.name))
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Run one real AgentLoop request and answer the tool names it carried. */
async function requestTools(
  ctx: Context,
  provider: string,
  sessionId: string,
): Promise<string[]> {
  const adapter = new RecordingAdapter()
  ctx.llm.registerAdapter([provider], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId(sessionId) as never,
    agentOptions: { provider, model: 'm' },
  })
  const agent = handle.agent as unknown as {
    followup(message: unknown): void
    whenIdle(): Promise<void>
  }
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const request = adapter.requests[0]
  assert.ok(request !== undefined, 'the agent must issue at least one model request')
  return request
}

interface UiHarness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly invoke: (name?: string) => void
  dispose(): void
}

/** Mount the REAL `/settings` command over the production Direct config port.
 *  The inert stubs mirror the established Settings visual harness; this path
 *  never reads them for the Tools row. */
function mountSettingsUi(port: DirectConfigPort): UiHarness {
  const vt = new VirtualTerminal(120, 40)
  const owned: OwnedRunner = (_label, task, options) => {
    const run = (): void => {
      void Promise.resolve()
        .then(() => task())
        .then(result => options.onResult?.(result), error => options.onError?.(error))
    }
    run()
  }
  const events: TuiAppEvents = { onSubmit: () => {}, onExit: () => {}, runOwned: owned }
  const app = new TuiApp(vt, events, { copySelection: async () => true })
  app.start()
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  const clientCtx = new Context()
  clientCtx.provide('commands', commands as never)
  clientCtx.provide('skills', {
    list: async () => [],
    get: async () => undefined,
    find: () => undefined,
    execute: async () => undefined,
  } as never)
  const base: Record<string, unknown> = {
    ctx: clientCtx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    sessionCwd: () => '/ws',
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    // C2-R2: the completion controller's read-only facts. This composition's
    // Settings rows read them back; /settings itself stays the same surface.
    currentNotificationMode: () => 'unfocused' as const,
    currentNotificationMethod: () => 'auto' as const,
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    isSessionScopeCurrent: () => false,
    currentSessionStats: async () => undefined,
    sessionReader: { measureContext: () => undefined, sessionStatus: () => undefined },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    backendKind: 'direct' as const,
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => false,
    setDisplayPreset: (preset: string) => ({ kind: 'unchanged' as const, preset }),
    refreshStatus: () => {},
    copyToClipboard: async () => true,
    tuiSettings: undefined,
    extensions: undefined,
    createPluginManagerPage: () => undefined,
    config: port,
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  const invoke = (name = 'settings'): void => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `/${name} must be registered`)
    ;(definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  let disposed = false
  return {
    vt,
    app,
    invoke,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (!app.isDisposed()) app.dispose()
    },
  }
}

/** The REAL official permission plane's PREREQUISITES (the shell capability,
 *  the approval service and the turn-outline row the plugin injects). The
 *  `permission` service itself is mounted as a real profile ROW by
 *  `mountPermissionDefaultPlane`, because only a configurable plugin entry gets
 *  the `permission` settings namespace the default write targets. */
async function mountPermissionPrerequisites(ctx: Context): Promise<void> {
  ctx.provide('shell', { sandboxMode: 'workspace-write' } as never)
  const approval = await import('@deepseek-ai/dsh-user-approval')
  await ctx.plugin((approval as unknown as { default: unknown }).default as never, undefined as never)
  const turnOutline = await import('@deepseek-ai/dsh-session-turn-outline')
  await ctx.plugin(turnOutline as never, undefined as never)
}

test('a real Settings Confirm of the permission default is what the NEXT Session samples', async t => {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Loader)
  await mountPermissionPrerequisites(ctx)
  await mountPermissionDefaultPlane(ctx, life.tempDir('permission-default-plane-'))
  const port = new DirectConfigPort(ctx, undefined, () => undefined)
  const presets = ctx.get('permissionPresets') as unknown as {
    readonly names: readonly string[]
    readonly defaultPreset: string
    current(session: unknown): string
  }
  const approval = ctx.get('approval') as unknown as { overrideOf(session: unknown): 'ask' | 'never' | undefined }

  // The Host default is the shipped workspace-write before the UI runs.
  assert.deepEqual([...presets.names], ['workspace-write', 'danger-full-access'])
  assert.equal(presets.defaultPreset, 'workspace-write')

  const ui = mountSettingsUi(port)
  t.after(() => ui.dispose())
  ui.invoke('settings')
  await ui.vt.waitForRender()
  await selectSettingsCategory(ui.vt, 'Agent')
  // L0 -> L1. The approval row is absent (sessionless), so the FIRST Agent row
  // is the default-permission row already.
  ui.vt.sendInput('\r')
  await ui.vt.waitForRender()
  const rowsFrame = ui.vt.getViewport().join('\n')
  assert.match(rowsFrame, /Settings · Agent · Rows/u, 'the Agent rows level owns the frame')
  assert.match(rowsFrame, /> Default permission/u,
    'a sessionless composition opens on the default-permission row')
  // L1 -> L2 inline choice, then move to the OTHER preset and confirm.
  ui.vt.sendInput('\r')
  await ui.vt.waitForRender()
  assert.match(ui.vt.getViewport().join('\n'), /Choose value/u)
  ui.vt.sendInput('\x1b[B')
  await ui.vt.waitForRender()
  ui.vt.sendInput('\r')
  await waitForFrame(
    () => ui.vt.getViewport().join('\n'),
    frame => /Status\s+Verified/u.test(frame),
    () => ui.vt.waitForRender(),
    'the Settings Confirm must settle as Verified',
  )

  // The UI decision reached the REAL Host permission default.
  assert.equal(presets.defaultPreset, 'danger-full-access',
    'the official permission.defaultPreset mutation really committed')

  // SOURCE -> SINK: a Session created AFTER the confirm samples that default.
  const handle = await ctx.agents.create({ sessionId: SessionId('perm-default-after-confirm') as never })
  const session = (handle.agent as unknown as { session: unknown }).session
  assert.equal(presets.current(session), 'danger-full-access',
    'the NEW Session was pinned with the updated Host default')
  assert.equal(approval.overrideOf(session), 'never',
    'and the preset bundle it sampled carries the never-approval knob')
})

test('a real Settings Confirm drives the Host registry and the next model request', async t => {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  // The production visual row injects the official Session read service; this
  // suite proves the REGISTRY/catalog contract, so a stand-in that never serves
  // an observation is sufficient (no model turn publishes here).
  await ctx.plugin(SessionQuerySqlite, { path: ':memory:', openAt: 'never' })
  await ctx.plugin(Loader)
  await mountVisualToolsSettingsPlane(ctx, join(life.tempDir('visual-tools-ui-host-'), 'plane'))
  const port = new DirectConfigPort(ctx, undefined, () => undefined)

  // An unrelated resident tool proves the switch changes only the visual group.
  ctx.tools.register({
    name: 'probe_unrelated_tool',
    description: 'an unrelated Host tool',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute: async () => 'unrelated',
  } as unknown as ToolDefinition)

  assert.equal(port.visualTools.read()?.enabled, true)
  const before = await requestTools(ctx, 'ui-probe-before', 'ui-before')
  assert.ok(before.includes(CHART_TOOL_NAME))
  assert.ok(before.includes(SVG_TOOL_NAME))
  assert.ok(before.includes(PRESENT_VISUAL_TOOL_NAME), 'the NEXT request carries the publication tool')
  assert.ok(before.includes('probe_unrelated_tool'))

  const ui = mountSettingsUi(port)
  t.after(() => ui.dispose())
  ui.invoke('settings')
  await ui.vt.waitForRender()
  await selectSettingsCategory(ui.vt, 'Tools')

  // L0 -> L1 -> L2 inline choice; On is current, so Down selects Off.
  ui.vt.sendInput('\r')
  await ui.vt.waitForRender()
  ui.vt.sendInput('\r')
  await ui.vt.waitForRender()
  assert.match(ui.vt.getViewport().join('\n'), /Choose value/)
  ui.vt.sendInput('\x1b[B')
  await ui.vt.waitForRender()
  ui.vt.sendInput('\r')
  await waitForFrame(
    () => ui.vt.getViewport().join('\n'),
    frame => /Status\s+Verified/.test(frame),
    () => ui.vt.waitForRender(),
    'the Settings Confirm Off must settle as Verified',
  )

  // The UI decision reached the real Host configuration and registry.
  assert.equal(port.visualTools.read()?.enabled, false)
  assert.equal(port.visualTools.read()?.applied, false)
  assert.equal(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.equal(ctx.tools.get(PRESENT_VISUAL_TOOL_NAME), undefined)
  assert.notEqual(ctx.tools.get('probe_unrelated_tool'), undefined, 'the unrelated tool was untouched')
  assert.doesNotMatch(ptcSdkOf(ctx), /dsh_pi_tui_chart/u)
  assert.doesNotMatch(ptcSdkOf(ctx), /dsh_pi_tui_svg/u)
  assert.doesNotMatch(ptcSdkOf(ctx), /present_visual/u)
  assert.match(ptcSdkOf(ctx), /probe_unrelated_tool/u)
  const afterOff = await requestTools(ctx, 'ui-probe-off', 'ui-off')
  assert.equal(afterOff.includes(CHART_TOOL_NAME), false, 'the NEXT model request does not carry the chart tool')
  assert.equal(afterOff.includes(SVG_TOOL_NAME), false, 'the NEXT model request does not carry the SVG tool')
  assert.equal(afterOff.includes(PRESENT_VISUAL_TOOL_NAME), false, 'nor the publication tool')
  assert.ok(afterOff.includes('probe_unrelated_tool'), 'and unrelated tools stay in the request catalog')

  // Confirm On again through the SAME workspace and Host: both definitions
  // return, and the next request carries them exactly once.
  ui.vt.sendInput('\r') // reopen the settled row's choice
  await ui.vt.waitForRender()
  ui.vt.sendInput('\x1b[A') // Off -> On
  await ui.vt.waitForRender()
  ui.vt.sendInput('\r')
  await waitForFrame(
    () => ui.vt.getViewport().join('\n'),
    frame => /Status\s+Verified/.test(frame) && /On\b/.test(frame),
    () => ui.vt.waitForRender(),
    'the Settings Confirm On must settle as Verified',
  )
  assert.equal(port.visualTools.read()?.enabled, true)
  assert.equal(port.visualTools.read()?.applied, true)
  assert.notEqual(ctx.tools.get(CHART_TOOL_NAME), undefined)
  assert.notEqual(ctx.tools.get(SVG_TOOL_NAME), undefined)
  assert.notEqual(ctx.tools.get(PRESENT_VISUAL_TOOL_NAME), undefined)
  assert.match(ptcSdkOf(ctx), /dsh_pi_tui_chart/u)
  assert.match(ptcSdkOf(ctx), /dsh_pi_tui_svg/u)
  assert.match(ptcSdkOf(ctx), /present_visual/u)
  const afterOn = await requestTools(ctx, 'ui-probe-on', 'ui-on')
  assert.equal(afterOn.filter(name => name === CHART_TOOL_NAME).length, 1)
  assert.equal(afterOn.filter(name => name === SVG_TOOL_NAME).length, 1)
  assert.equal(afterOn.filter(name => name === PRESENT_VISUAL_TOOL_NAME).length, 1)
})
