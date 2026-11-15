/**
 * Production Settings decisions over the REAL Direct configuration plane:
 * Visual tools and the two Subagent settings namespaces.
 *
 * ```text
 * TuiApp / SettingsWorkspacePanel
 *   -> /settings → Agent → Subagent settings (real keyboard)
 *   -> SubagentSettingsPage → SubagentSettingsController staged Save
 *   -> DirectConfigPort.subagentLimits / subagentModelSelection
 *   -> official SettingsForms.mutate → real ConfigEditor USER profile write
 *   -> real Loader volatile commit → the NEXT fresh Session's durable policy
 * ```
 *
 * Visual tools keeps its own regression chain:
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
 * EVIDENCE: the Subagent cases drive the production page through real terminal
 * input into the real official Loader/ConfigEditor/SettingsForms and the real
 * profile document; a fresh Session's durable `subagent/model-selection-policy`
 * event is the model-facing sink. The only substituted boundary is the model
 * endpoint in the visual-tools case.
 *
 * FIXTURE MANIFEST
 * - REAL: TuiApp + VirtualTerminal + the registered `/settings` command, the
 *   production DirectConfigPort, the real profile/bundle Loader,
 *   ConfigEditor/SettingsForms, the official `subagent` and
 *   `subagent-model-selection-settings` rows, the real AgentLoop/Agent creation
 *   and an in-process recording LLM adapter.
 * - STAND-INS: application capabilities these command paths never exercise
 *   (sessions/readers, clipboard, providers/account/authorization seams) are
 *   inert stubs, exactly like the established Settings visual harness; they
 *   answer no Host fact these cases assert.
 * - ABSENT: a physical terminal and a real user DSH_HOME.
 * @module @xmoon76/dsh-pi-tui/test/integration/visual-tools-settings-ui
 */

import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { join } from 'node:path'
import { Context, symbols } from '@deepseek-ai/cordis'
import type SettingsForms from '@deepseek-ai/dsh-settings'
import type { SectionRead } from '../../src/runtime/config-port.ts'
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
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { renderToolsSdk } from '@deepseek-ai/dsh-tool-executor-ptc'
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
import { visibleWidth, stripTerminalSequences } from '@xmoon76/pi-tui'
import { TuiApp, type OwnedRunner, type TuiAppEvents } from '../../src/tui-app.ts'
import type { TuiCommandRunner } from '../../src/commands.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'
import { waitForFrame } from '../support/frame-wait.ts'
import { mountVisualToolsSettingsPlane } from '../support/visual-tools-plane.ts'
import { mountPermissionDefaultPlane } from '../support/permission-default-fixture.ts'
import { mountSubagentSectionPlane } from '../support/subagent-section-fixture.ts'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as tool from '@deepseek-ai/dsh-tool-subagent'
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

/** One provider with one model, for the UI-driven allowlist catalog. */
class CatalogAdapterForUi extends LlmAdapter {
  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }

  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider, id: 'fast', name: 'Fast' }])
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
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
/** Optional live-session composition seams. A test that exercises a
 *  SESSION-SCOPED Agent row must present the captured scope as current (the
 *  production gate for that row), which a sessionless mount deliberately does
 *  not. */
interface LiveSessionSeams {
  readonly sessionId: string
  readonly approvalOverride: () => 'ask' | 'never' | undefined
  /** sessionId -> the live Agent the production interaction port resolves to. */
  readonly agentFor: (sessionId: string) => unknown
  /** The official approval service this composition really writes through. */
  readonly officialApproval: { setPolicy(agent: unknown, policy: 'ask' | 'never'): void }
}

function mountSettingsUi(port: DirectConfigPort, live?: LiveSessionSeams): UiHarness {
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
    currentSessionId: live?.sessionId,
    captureLiveSessionScope: () => live === undefined ? undefined : { sessionId: live.sessionId },
    isSessionScopeCurrent: (scope: { sessionId?: string } | undefined) =>
      live !== undefined && scope?.sessionId === live.sessionId,
    // M6-1 F8: the ONE session-policy observation owner (the approval row's
    // read source) + the transport-neutral async exact-session write. This
    // mirrors the production DirectSessionPolicyPort: the official service
    // reads the exact session override, the scope gate refuses a stale owner,
    // and the write returns the two independent axes.
    policy: {
      readSnapshot: (sessionId: string) => {
        if (live === undefined || sessionId !== live.sessionId) return { kind: 'checking' as const }
        const override = live.approvalOverride()
        return {
          kind: 'ready' as const,
          read: {
            kind: 'ready' as const,
            sessionId,
            approval: override === undefined
              ? { state: 'ready' as const, effective: 'ask' as const }
              : { state: 'ready' as const, effective: override, override },
            sandbox: { state: 'unavailable' as const, reason: 'service-not-installed' as const },
          },
        }
      },
      refresh: async (sessionId: string) => {
        if (live === undefined || sessionId !== live.sessionId) return { kind: 'checking' as const }
        const override = live.approvalOverride()
        return {
          kind: 'ready' as const,
          read: {
            kind: 'ready' as const,
            sessionId,
            approval: override === undefined
              ? { state: 'ready' as const, effective: 'ask' as const }
              : { state: 'ready' as const, effective: override, override },
            sandbox: { state: 'unavailable' as const, reason: 'service-not-installed' as const },
          },
        }
      },
      invalidate: () => {},
      subscribe: () => () => {},
      dispose: () => {},
    },
    setSessionApprovalPolicy: async (scope: { sessionId?: string } | undefined, value: 'ask' | 'never') => {
      if (live === undefined || scope?.sessionId !== live.sessionId) return { ownership: 'superseded' as const, outcome: undefined }
      const target = live.agentFor(scope.sessionId)
      if (target === undefined) return { ownership: 'superseded' as const, outcome: undefined }
      live.officialApproval.setPolicy(target, value)
      return { ownership: 'current' as const, outcome: { kind: 'applied' as const, sessionId: scope.sessionId } }
    },
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
    // The Agent category's delegation rows need the model catalog as well as the
    // official section; the section's own directory read is what the picker uses,
    // so this only has to REPORT availability.
    catalog: { models: { available: () => true, loadDirectory: async () => ({ default: { provider: 'alpha', model: 'fast' }, routableProviders: ['alpha'], groups: [{ id: 'alpha', name: 'alpha', models: [{ id: 'fast', name: 'Fast' }] }], failures: [] }) } },
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

/**
 * A transport whose first turn asks tool `r3_approval_probe` (so the ask happens
 * INSIDE an open turn, which the official approval audit requires), then closes
 * the turn with text. The tool body itself calls the official approval seat and
 * records the outcome the policy produced.
 */
class ApprovalProbeAdapter extends LlmAdapter {
  outcome: string | undefined
  private turns = 0
  private readonly toolName: string

  constructor(toolName = 'r3_approval_probe') {
    super()
    this.toolName = toolName
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }

  override listModels(provider: string): Promise<readonly { provider: string; id: string; name: string }[]> {
    return Promise.resolve([{ provider, id: 'm', name: 'M' }])
  }

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    this.turns += 1
    if (this.turns === 1) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: 'r3-approval-call' as never,
        name: this.toolName,
        argumentsDelta: '{}',
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id: 'r3-approval-call' as never, name: this.toolName, arguments: '{}' },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'turn complete' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'turn complete' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('a real Approval policy Confirm is what THAT Session\'s next approval request resolves under', async t => {
  // R3-02's authority is the PER-SESSION approval override captured with the live
  // Agent (NOT the Host `permission.defaultPreset`, which only seeds new Sessions).
  // So this drives the previous chain in the other direction: the approval row
  // writes `never` onto the CURRENT Session through the interaction port, and the
  // NEXT approval request of that SAME Session must consume it.
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(Loader)
  await mountPermissionPrerequisites(ctx)
  await mountPermissionDefaultPlane(ctx, life.tempDir('approval-policy-plane-'))
  const port = new DirectConfigPort(ctx, undefined, () => undefined)

  // A tool whose body IS the requested action, so "rejected" is observable as
  // "the body never ran": it asks the official seat first and only then acts.
  let bodyRuns = 0
  let requestOutcome: string | undefined
  const probeAdapter = new ApprovalProbeAdapter()
  ctx.tools.register({
    name: 'r3_approval_probe',
    description: 'asks the official approval seat before acting',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    execute: async (_args: unknown, toolCtx: { agent?: unknown }) => {
      const approval = ctx.get('approval') as unknown as { request(request: unknown): Promise<string> }
      requestOutcome = await approval.request({
        agent: toolCtx.agent,
        toolName: 'r3_approval_probe',
        reason: 'the R3-02 approval consumer probe',
      })
      if (requestOutcome === 'allowed-once') { bodyRuns += 1; return 'ran' }
      return 'refused'
    },
  } as never)

  // The LIVE Session, composed BEFORE the policy is changed — the override must
  // apply to THIS Session, exactly as the per-session row promises.
  ctx.llm.registerAdapter(['approval-probe'], probeAdapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId('r3-approval-consumer') as never,
    agentOptions: { provider: 'approval-probe', model: 'm' },
  })
  const agent = handle.agent as unknown as { session: unknown }
  const session = agent.session
  const approval = ctx.get('approval') as unknown as { overrideOf(session: unknown): 'ask' | 'never' | undefined }
  // The standing composition seeds its own override; what matters is that the UI
  // CHANGE lands on this exact Session and is what the request consumes.
  const beforeOverride = approval.overrideOf(session)
  assert.notEqual(beforeOverride, 'never', `the Session does not start at never (got ${String(beforeOverride)})`)

  // The REAL UI: /settings -> Agent -> Approval policy (this session) -> never.
  // A live Session makes this row the FIRST Agent row.
  const ui = mountSettingsUi(port, {
    sessionId: 'r3-approval-consumer',
    approvalOverride: () => approval.overrideOf(session),
    agentFor: (sessionId: string) => sessionId === 'r3-approval-consumer' ? handle.agent : undefined,
    officialApproval: approval as unknown as { setPolicy(agent: unknown, policy: 'ask' | 'never'): void },
  })
  t.after(() => ui.dispose())
  ui.invoke('settings')
  await ui.vt.waitForRender()
  await selectSettingsCategory(ui.vt, 'Agent')
  ui.vt.sendInput('\r')
  await ui.vt.waitForRender()
  assert.match(ui.vt.getViewport().join('\n'), /> Approval policy \(this session\)/u,
    `the session-scoped approval row is the one being edited:\n${ui.vt.getViewport().join('\n')}`)
  ui.vt.sendInput('\r')
  await ui.vt.waitForRender()
  assert.match(ui.vt.getViewport().join('\n'), /Choose value/u, 'the inline choice is open')
  // ask -> never (the candidate list starts on the current `ask`).
  ui.vt.sendInput('\x1b[B')
  await ui.vt.waitForRender()
  ui.vt.sendInput('\r')
  await waitForFrame(
    () => ui.vt.getViewport().join('\n'),
    frame => /Status\s+Verified/u.test(frame),
    () => ui.vt.waitForRender(),
    'the per-session Approval policy Confirm must settle as Verified',
  )
  assert.equal(approval.overrideOf(session), 'never',
    'the UI wrote the per-session override onto the CAPTURED Session')

  // SOURCE -> SINK: that SAME Session's next real turn asks the official seat.
  const asked: string[] = []
  ctx.on('approval/request' as never, (() => { asked.push('asked') }) as never)
  const liveAgent = handle.agent as unknown as {
    followup(message: unknown): void
    whenIdle(): Promise<void>
  }
  liveAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  await liveAgent.whenIdle()

  assert.equal(requestOutcome, 'rejected',
    'the SAME Session\'s next approval request consumed the per-session override')
  assert.equal(bodyRuns, 0, 'a rejected approval never runs the requested body')
  assert.equal(asked.length, 0,
    'under `never` no answerer-facing approval/request event is dispatched')
  const events = (session as unknown as {
    snapshotEvents(): readonly { readonly type: string }[]
  }).snapshotEvents()
  assert.ok(events.some(event => event.type === 'approval/asked'), 'the durable asked audit exists')
  assert.ok(events.some(event => event.type === 'approval/decided'), 'the durable decided audit exists')

  // NEGATIVE CONTROL: a DIFFERENT Session keeps its own policy — the override is
  // per-session, so the same probe there must still consult the answerer seat.
  const bystanderAdapter = new ApprovalProbeAdapter('r3_approval_probe_other')
  ctx.llm.registerAdapter(['approval-bystander'], bystanderAdapter)
  const other = await ctx.agents.create({
    sessionId: SessionId('r3-approval-bystander') as never,
    agentOptions: { provider: 'approval-bystander', model: 'm' },
  })
  const otherSession = (other.agent as unknown as { session: unknown }).session
  assert.notEqual(approval.overrideOf(otherSession), 'never',
    'the other Session was never given the override')
  let otherOutcome: string | undefined
  ctx.tools.register({
    name: 'r3_approval_probe_other',
    description: 'asks the official approval seat before acting',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: (_args: unknown, value: string) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => false,
    execute: async (_args: unknown, toolCtx: { agent?: unknown }) => {
      const seat = ctx.get('approval') as unknown as { request(request: unknown): Promise<string> }
      otherOutcome = await seat.request({ agent: toolCtx.agent, toolName: 'r3_approval_probe_other', reason: 'bystander' })
      return 'asked'
    },
  } as never)
  ;(other.agent as unknown as { followup(message: unknown): void }).followup(
    createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }),
  )
  await (other.agent as unknown as { whenIdle(): Promise<void> }).whenIdle()
  // The bystander's ask must NOT resolve the way the overridden Session's did:
  // it reaches the answerer waterfall instead of being refused by `never`.
  assert.notEqual(otherOutcome, 'rejected',
    `the per-session override did not leak to another Session (got ${String(otherOutcome)})`)
  assert.ok(otherOutcome !== undefined, 'the bystander really performed an approval ask')
})

function readySection<T extends object>(read: SectionRead<T>): Extract<SectionRead<T>, { kind: 'ready' }> {
  if (read.kind !== 'ready') assert.fail(`the official section must be ready: ${read.reason}`)
  return read
}

async function settingsKey(ui: UiHarness, data: string): Promise<void> {
  ui.vt.sendInput(data)
  await ui.vt.waitForRender()
}

async function openSubagentSettings(ui: UiHarness): Promise<void> {
  ui.invoke('settings')
  await ui.vt.waitForRender()
  await selectSettingsCategory(ui.vt, 'Agent')
  await settingsKey(ui, '\r')
  for (let step = 0; step < 6 && !/> Subagent settings/u.test(ui.vt.getViewport().join('\n')); step += 1) {
    await settingsKey(ui, '\x1b[B')
  }
  assert.match(ui.vt.getViewport().join('\n'), /> Subagent settings/u)
  await settingsKey(ui, '\r')
  await waitForFrame(
    () => ui.vt.getViewport().join('\n'),
    frame => /Settings · Agent · Subagent settings/u.test(frame) && /Limits · Ready/u.test(frame) && /Model selection · Ready/u.test(frame),
    () => ui.vt.waitForRender(),
    'the production Subagent page must finish its authoritative refresh',
  )
}

async function selectSubagentField(ui: UiHarness, label: string): Promise<void> {
  for (let step = 0; step < 4 && !ui.vt.getViewport().some(line => line.includes(`> ${label}`)); step += 1) {
    await settingsKey(ui, '\x1b[B')
  }
  assert.ok(ui.vt.getViewport().some(line => line.includes(`> ${label}`)), `field ${label} must be selected:\n${ui.vt.getViewport().join('\n')}`)
}

async function stageSubagentNumber(ui: UiHarness, label: string, value: string): Promise<void> {
  await selectSubagentField(ui, label)
  await settingsKey(ui, '\r')
  assert.match(ui.vt.getViewport().join('\n'), new RegExp(`Edit ${label}`, 'u'))
  await settingsKey(ui, '\x15')
  await settingsKey(ui, value)
  await settingsKey(ui, '\r')
}

async function clickPainted(ui: UiHarness, text: string, rowHint?: number): Promise<void> {
  const lines = ui.vt.getViewport().map(stripTerminalSequences)
  const row = rowHint ?? lines.findIndex(line => line.includes(text))
  assert.ok(row >= 0 && row < lines.length, `painted row ${JSON.stringify(text)} must exist:\n${lines.join('\n')}`)
  const line = lines[row]!
  const offset = line.indexOf(text)
  assert.ok(offset >= 0, `painted cell ${JSON.stringify(text)} must exist on row ${row}: ${line}`)
  const column = visibleWidth(line.slice(0, offset))
  ui.vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
  if (row !== lines.length - 1) await ui.vt.waitForRender()
  ui.vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
  await ui.vt.waitForRender()
}

async function clickSubagentFieldAction(ui: UiHarness, field: string, action: string): Promise<void> {
  const lines = ui.vt.getViewport().map(stripTerminalSequences)
  const fieldRow = lines.findIndex(line => line.includes(field))
  assert.ok(fieldRow >= 0, `field row ${field} must be painted:\n${lines.join('\n')}`)
  const detail = lines[fieldRow + 1]!
  const actionColumn = detail.lastIndexOf(action)
  assert.ok(actionColumn >= 0, `${action} must be painted beside ${field}: ${detail}`)
  const row = fieldRow + 1
  const column = visibleWidth(detail.slice(0, actionColumn))
  ui.vt.sendInput(`\x1b[<0;${column + 1};${row + 1}M`)
  await ui.vt.waitForRender()
  ui.vt.sendInput(`\x1b[<0;${column + 1};${row + 1}m`)
  await ui.vt.waitForRender()
}

function recordOfficialSubagentMutations(ctx: Context, t: TestContext) {
  const proxy = ctx.get('settings') as SettingsForms & { readonly [symbols.original]?: SettingsForms }
  const official = proxy[symbols.original] ?? proxy
  const original = official.mutate
  const calls: Array<{ ns: string; ops: Parameters<SettingsForms['mutate']>[1]; revision: number | undefined }> = []
  t.mock.method(official, 'mutate', function (this: SettingsForms, ...args: Parameters<SettingsForms['mutate']>) {
    calls.push({ ns: args[0], ops: structuredClone(args[1]), revision: args[2] })
    return original.apply(this, args)
  })
  return { official, calls }
}

test('Subagent settings Save persists both namespaces and only new top-level Sessions sample selection changes', async t => {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  const route = [{ provider: 'alpha', model: 'fast' }]
  const plane = await mountSubagentSectionPlane(ctx, life.tempDir('subagent-section-plane-'), {
    enabled: true, allowedModels: route,
  })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const port = new DirectConfigPort(ctx, undefined, () => undefined)
  const recorder = recordOfficialSubagentMutations(ctx, t)
  ctx.llm.registerAdapter(['alpha'], new CatalogAdapterForUi())
  const preset = createScope(ctx, { preset: 'subagent-settings' })
  await preset.ctx.plugin(tool, { provider: 'spawn', modelSelection: true, modelDiscovery: true })
  const createSession = async (id: string) => ctx.agents.create({
    sessionId: SessionId(id) as never,
    setup: agentCtx => { bindScopeParent(scopeOf(agentCtx)!, scopeOf(preset.ctx)!) },
  })
  const sampledPolicy = (agent: unknown): readonly { provider: string; model: string }[] => {
    const session = (agent as { session: { snapshotEvents(): readonly { type: string; data?: { allowedModels?: readonly { provider: string; model: string }[] } }[] } }).session
    return session.snapshotEvents().find(event => event.type === 'subagent/model-selection-policy')?.data?.allowedModels ?? []
  }
  const declaresRoutes = (agent: unknown): boolean => {
    const schema = ctx.tools.schemas(agent as never).find(candidate => candidate.name === 'subagent')
    const properties = (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
    return properties?.provider !== undefined && properties.model !== undefined
  }
  const before = await createSession('subagent-settings-before')
  assert.deepEqual(sampledPolicy(before.agent), route)
  assert.equal(declaresRoutes(before.agent), true)

  const ui = mountSettingsUi(port)
  life.defer(() => ui.dispose())
  await openSubagentSettings(ui)
  const limitsOpened = readySection(port.subagentLimits.read())
  const selectionOpened = readySection(port.subagentModelSelection.read())
  await selectSubagentField(ui, 'Enabled')
  await settingsKey(ui, '\r')
  await stageSubagentNumber(ui, 'Maximum recursion depth', '0')
  await stageSubagentNumber(ui, 'Subagent parallelism limit', '2')
  assert.equal(recorder.calls.length, 0, 'staging through real keyboard input writes neither namespace')
  assert.deepEqual(readySection(port.subagentLimits.read()).effective, { maxDepth: 1, maxActiveSubagents: 8 })
  assert.equal(readySection(port.subagentModelSelection.read()).effective.enabled, true)
  await settingsKey(ui, 's')
  await waitForFrame(
    () => ui.vt.getViewport().join('\n'),
    frame => /Limits: Verified/u.test(frame) && /Selection: Verified/u.test(frame),
    () => ui.vt.waitForRender(), 'both independent namespace writes must verify',
  )
  assert.deepEqual(recorder.calls, [
    { ns: 'subagent', ops: [
      { op: 'set', path: ['maxDepth'], value: 0 },
      { op: 'set', path: ['maxActiveSubagents'], value: 2 },
    ], revision: limitsOpened.revision },
    { ns: 'subagent-model-selection-settings', ops: [{ op: 'set', path: ['enabled'], value: false }], revision: selectionOpened.revision },
  ])
  assert.deepEqual(readySection(port.subagentLimits.read()).effective, { maxDepth: 0, maxActiveSubagents: 2 })
  assert.deepEqual(plane.userConfig('subagent'), { maxDepth: 0, maxActiveSubagents: 2 })
  const afterDisable = readySection(port.subagentModelSelection.read())
  assert.deepEqual(afterDisable.effective, { enabled: false, allowedModels: route })
  assert.deepEqual(plane.userConfig('subagent-model-selection-settings'), afterDisable.effective,
    'the real profile document preserves the untouched routes')
  const after = await createSession('subagent-settings-disabled')
  assert.deepEqual(sampledPolicy(after.agent), [])
  assert.deepEqual(sampledPolicy(before.agent), route, 'the existing Session retains its durable policy')
  assert.equal(declaresRoutes(after.agent), true, 'the tool schema stays static in the current official preset')

  await selectSubagentField(ui, 'Enabled')
  await settingsKey(ui, '\r')
  assert.equal(readySection(port.subagentModelSelection.read()).effective.enabled, false)
  await settingsKey(ui, 's')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Selection: Verified/u.test(frame),
    () => ui.vt.waitForRender(), 'the re-enable Save must verify')
  assert.deepEqual(readySection(port.subagentModelSelection.read()).effective, { enabled: true, allowedModels: route })
  const reEnabled = await createSession('subagent-settings-reenabled')
  assert.deepEqual(sampledPolicy(reEnabled.agent), route)
  assert.deepEqual(sampledPolicy(before.agent), route)
  assert.deepEqual(sampledPolicy(after.agent), [], 'a previously created disabled Session is never hot-rewritten')
  assert.deepEqual(readySection(port.subagentLimits.read()).effective, { maxDepth: 0, maxActiveSubagents: 2 },
    'a selection-only Save preserves both limits')
})

test('a Root pointer journey stages both namespaces, saves to Host, and discards before exit', async t => {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  const route = [{ provider: 'alpha', model: 'fast' }]
  const plane = await mountSubagentSectionPlane(ctx, life.tempDir('subagent-pointer-plane-'), {
    enabled: false, allowedModels: route,
    limits: { maxDepth: 1, maxActiveSubagents: 8 },
    userLimits: { maxDepth: 3, maxActiveSubagents: 5 },
  })
  const port = new DirectConfigPort(ctx, undefined, () => undefined)
  const { calls } = recordOfficialSubagentMutations(ctx, t)
  const openedLimits = readySection(port.subagentLimits.read())
  const openedSelection = readySection(port.subagentModelSelection.read())
  const ui = mountSettingsUi(port)
  life.defer(() => ui.dispose())

  ui.invoke('settings')
  await ui.vt.waitForRender()
  await selectSettingsCategory(ui.vt, 'Agent')
  await settingsKey(ui, '\r')
  await clickPainted(ui, 'Subagent settings')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Limits · Ready/u.test(frame) && /Model selection · Ready/u.test(frame),
    () => ui.vt.waitForRender(), 'a painted Root row click opens the real embedded page')

  // Pointer-open the numeric input, type its value, then use the painted Apply
  // action. Reset is a separate operation on the sibling capacity field.
  await clickPainted(ui, 'Maximum recursion depth')
  await settingsKey(ui, '\x15')
  await settingsKey(ui, '0')
  await clickPainted(ui, 'Apply [Enter]')
  await clickSubagentFieldAction(ui, 'Subagent parallelism limit', 'Reset')
  await clickSubagentFieldAction(ui, 'Allowed models', 'Manage…')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Fast/u.test(frame),
    () => ui.vt.waitForRender(), 'the current provider directory is painted')
  await clickPainted(ui, 'Search [/]', ui.vt.getViewport().length - 1)
  await settingsKey(ui, 'fast')
  await clickPainted(ui, 'Done [Enter]', ui.vt.getViewport().length - 1)
  assert.match(ui.vt.getViewport().join('\n'), /Fast/u, 'pointer-opened Search filters the painted directory')
  await clickPainted(ui, 'Fast')
  assert.equal(calls.length, 0, 'Root and directory clicks stage only; neither section mutates before Save')
  await clickPainted(ui, 'Back [Esc]')
  await clickPainted(ui, 'Save [S]')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Limits: Verified/u.test(frame) && /Selection: Verified/u.test(frame),
    () => ui.vt.waitForRender(), 'the painted Root Save settles both official sections')

  assert.deepEqual(calls, [
    { ns: 'subagent', ops: [
      { op: 'set', path: ['maxDepth'], value: 0 },
      { op: 'unset', path: ['maxActiveSubagents'] },
    ], revision: openedLimits.revision },
    { ns: 'subagent-model-selection-settings', ops: [
      { op: 'set', path: ['allowedModels'], value: [] },
    ], revision: openedSelection.revision },
  ])
  assert.deepEqual(readySection(port.subagentLimits.read()).effective, { maxDepth: 0, maxActiveSubagents: 8 })
  assert.deepEqual(plane.userConfig('subagent'), { maxDepth: 0, maxActiveSubagents: 8 })
  assert.deepEqual(readySection(port.subagentModelSelection.read()).effective, { enabled: false, allowedModels: [] })
  assert.deepEqual(plane.userConfig('subagent-model-selection-settings'), { enabled: false, allowedModels: [] })

  // Pointer-only exit: a second numeric edit is kept dirty until Back opens the
  // painted question, and only the explicit Discard returns to the Agent rows.
  await clickPainted(ui, 'Maximum recursion depth')
  await settingsKey(ui, '\x15')
  await settingsKey(ui, '1')
  await clickPainted(ui, 'Apply [Enter]')
  await clickPainted(ui, 'Back [Esc]')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Discard unsaved changes\? y\/N/u.test(frame),
    () => ui.vt.waitForRender(), 'Back exposes the dirty decision')
  await clickPainted(ui, 'Discard [Y]')
  assert.match(ui.vt.getViewport().join('\n'), /Settings · Agent · Rows/u)
  assert.equal(calls.length, 2, 'Discard does not issue another official mutation')
  assert.deepEqual(plane.userConfig('subagent'), { maxDepth: 0, maxActiveSubagents: 8 })
})

test('a Root pointer Save keeps an official partial result visible and lets the user Refresh and exit', async t => {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  const route = [{ provider: 'alpha', model: 'fast' }]
  const plane = await mountSubagentSectionPlane(ctx, life.tempDir('subagent-pointer-partial-plane-'), {
    enabled: false, allowedModels: route,
    limits: { maxDepth: 1, maxActiveSubagents: 8 },
    homeLimits: { maxDepth: 4, maxActiveSubagents: 8 },
  })
  const port = new DirectConfigPort(ctx, undefined, () => undefined)
  const { calls } = recordOfficialSubagentMutations(ctx, t)
  const openedLimits = readySection(port.subagentLimits.read())
  const openedSelection = readySection(port.subagentModelSelection.read())
  const ui = mountSettingsUi(port)
  life.defer(() => ui.dispose())
  await openSubagentSettings(ui)

  await selectSubagentField(ui, 'Enabled')
  await settingsKey(ui, '\r')
  await stageSubagentNumber(ui, 'Maximum recursion depth', '0')
  assert.equal(calls.length, 0, 'pointer Save remains the first Host mutation')
  await clickPainted(ui, 'Save [S]')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Limits: Outcome unconfirmed/u.test(frame) && /Selection: Verified/u.test(frame),
    () => ui.vt.waitForRender(), 'the Root bar must show each official section result independently')
  assert.deepEqual(calls, [
    { ns: 'subagent', ops: [{ op: 'set', path: ['maxDepth'], value: 0 }], revision: openedLimits.revision },
    { ns: 'subagent-model-selection-settings', ops: [{ op: 'set', path: ['enabled'], value: true }], revision: openedSelection.revision },
  ])
  assert.equal(plane.userConfig('subagent'), undefined, 'the home overlay leaves Limits unpersisted')
  assert.deepEqual(plane.userConfig('subagent-model-selection-settings'), { enabled: true, allowedModels: route },
    'the independent Selection write reaches the real profile despite the Limits refusal')
  assert.deepEqual(readySection(port.subagentLimits.read()).effective, { maxDepth: 4, maxActiveSubagents: 8 })
  assert.deepEqual(readySection(port.subagentModelSelection.read()).effective, { enabled: true, allowedModels: route })

  await clickPainted(ui, 'Refresh [R]')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Discard unsaved changes\? y\/N/u.test(frame),
    () => ui.vt.waitForRender(), 'Refresh from a partial Save requests explicit draft discard')
  // The second action is on the same cell; wait past PiTui's 500ms double-click window so it is a deliberate confirmation.
  await new Promise<void>(resolve => setTimeout(resolve, 550))
  await clickPainted(ui, 'Discard [Y]')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Limits · Ready/u.test(frame) && /Model selection · Ready/u.test(frame),
    () => ui.vt.waitForRender(), 'the painted Refresh action re-reads both official sections')
  await clickPainted(ui, 'Back [Esc]')
  assert.match(ui.vt.getViewport().join('\n'), /Settings · Agent · Rows/u, 'Back exits to the Agent rows after refresh')
  assert.equal(calls.length, 2, 'discard and refresh never replay either official mutation')
  assert.equal(plane.userConfig('subagent'), undefined)
})

test('Subagent Reset sends official unset at the captured revision and verifies effective inheritance with USER materialization', async t => {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  const baseRoutes = [{ provider: 'alpha', model: 'fast' }]
  const plane = await mountSubagentSectionPlane(ctx, life.tempDir('subagent-reset-plane-'), {
    enabled: false, allowedModels: baseRoutes,
    limits: { maxDepth: 3, maxActiveSubagents: 8 },
    userSelection: { enabled: true, allowedModels: [{ provider: 'saved', model: 'unlisted' }] },
    userLimits: { maxDepth: 5, maxActiveSubagents: 2 },
  })
  const port = new DirectConfigPort(ctx, undefined, () => undefined)
  const { official, calls } = recordOfficialSubagentMutations(ctx, t)
  const ui = mountSettingsUi(port)
  life.defer(() => ui.dispose())
  await openSubagentSettings(ui)
  const opened = readySection(port.subagentModelSelection.read())
  assert.deepEqual(opened.overridden, { enabled: true, allowedModels: true })
  await selectSubagentField(ui, 'Allowed models')
  await settingsKey(ui, 'x')
  assert.equal(calls.length, 0, 'Reset stages an operation rather than committing it')
  assert.deepEqual(readySection(port.subagentModelSelection.read()).effective.allowedModels, [{ provider: 'saved', model: 'unlisted' }])
  await settingsKey(ui, 's')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Selection: Verified/u.test(frame),
    () => ui.vt.waitForRender(), 'an accepted unset with authoritative readback must verify')
  assert.deepEqual(calls, [{ ns: 'subagent-model-selection-settings', ops: [{ op: 'unset', path: ['allowedModels'] }], revision: opened.revision }])
  const readback = readySection(port.subagentModelSelection.read())
  assert.deepEqual(readback.effective, { enabled: true, allowedModels: baseRoutes })
  assert.deepEqual(readback.overridden, { enabled: true, allowedModels: false }, 'Source compares effective values with inherited values')
  const descriptor = official.describe().find(row => row.ns === 'subagent-model-selection-settings')
  assert.deepEqual(descriptor?.user, { enabled: true, allowedModels: baseRoutes }, 'official USER readback may materialize the inherited array')
  assert.deepEqual(plane.userConfig('subagent-model-selection-settings'), descriptor?.user)
  assert.deepEqual(readySection(port.subagentLimits.read()).effective, { maxDepth: 5, maxActiveSubagents: 2 })

  const limitsOpened = readySection(port.subagentLimits.read())
  await selectSubagentField(ui, 'Maximum recursion depth')
  await settingsKey(ui, 'x')
  await settingsKey(ui, 's')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Limits: Verified/u.test(frame),
    () => ui.vt.waitForRender(), 'the limit Reset must verify through the same page')
  assert.deepEqual(calls[1], { ns: 'subagent', ops: [{ op: 'unset', path: ['maxDepth'] }], revision: limitsOpened.revision })
  assert.deepEqual(readySection(port.subagentLimits.read()).effective, { maxDepth: 3, maxActiveSubagents: 2 }, 'Reset preserves the sibling capacity override')
  assert.deepEqual(plane.userConfig('subagent'), { maxDepth: 3, maxActiveSubagents: 2 })
  assert.deepEqual(readySection(port.subagentModelSelection.read()).effective, readback.effective)

  const countBeforeInvalid = calls.length
  await stageSubagentNumber(ui, 'Subagent parallelism limit', '0')
  await settingsKey(ui, 's')
  assert.match(ui.vt.getViewport().join('\n'), /safe integer from 1/u)
  assert.equal(calls.length, countBeforeInvalid, 'capacity zero cannot cross the official mutation boundary')
  await stageSubagentNumber(ui, 'Subagent parallelism limit', String(Number.MAX_SAFE_INTEGER))
  await settingsKey(ui, 's')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Limits: Verified/u.test(frame),
    () => ui.vt.waitForRender(), 'a safe capacity endpoint must verify')
  assert.equal(readySection(port.subagentLimits.read()).effective.maxActiveSubagents, Number.MAX_SAFE_INTEGER)
})

test('a stale Subagent editor cannot overwrite a newer official profile revision', async t => {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  const plane = await mountSubagentSectionPlane(ctx, life.tempDir('subagent-conflict-plane-'), { enabled: false, allowedModels: [] })
  const port = new DirectConfigPort(ctx, undefined, () => undefined)
  const otherEditor = new DirectConfigPort(ctx, undefined, () => undefined)
  const { calls } = recordOfficialSubagentMutations(ctx, t)
  const ui = mountSettingsUi(port)
  life.defer(() => ui.dispose())
  await openSubagentSettings(ui)
  const opened = readySection(port.subagentLimits.read())
  await stageSubagentNumber(ui, 'Maximum recursion depth', '2')
  // TuiApp owns a process-global terminal slot, so the second editor here is
  // a separate production Direct port over the same real Settings service.
  const newer = readySection(otherEditor.subagentLimits.read())
  assert.deepEqual(await otherEditor.subagentLimits.mutate({ maxDepth: { kind: 'set', value: 0 } }, newer.revision, newer.generation), { kind: 'accepted' })
  const landedCalls = calls.length
  ui.app.requestRender()
  await ui.vt.waitForRender()
  assert.match(ui.vt.getViewport().join('\n'), /Last-known · read-only/u)
  await settingsKey(ui, 's')
  assert.equal(calls.length, landedCalls, 'the stale painted editor dispatches no save')
  const refused = await port.subagentLimits.mutate({ maxDepth: { kind: 'set', value: 2 } }, opened.revision, opened.generation)
  assert.equal(refused.kind, 'conflict', 'the official SettingsForms CAS also refuses direct stale dispatch')
  assert.deepEqual(calls.at(-1), { ns: 'subagent', ops: [{ op: 'set', path: ['maxDepth'], value: 2 }], revision: opened.revision })
  assert.equal(readySection(port.subagentLimits.read()).effective.maxDepth, 0)
  assert.deepEqual(plane.userConfig('subagent'), { maxDepth: 0, maxActiveSubagents: 8 })
})

test('a Subagent profile write blocked by a temporary home overlay stays unverified and preserves the document', async t => {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  const plane = await mountSubagentSectionPlane(ctx, life.tempDir('subagent-overlay-plane-'), {
    enabled: false, allowedModels: [], homeLimits: { maxDepth: 4, maxActiveSubagents: 8 },
  })
  const port = new DirectConfigPort(ctx, undefined, () => undefined)
  const { calls } = recordOfficialSubagentMutations(ctx, t)
  const ui = mountSettingsUi(port)
  life.defer(() => ui.dispose())
  await openSubagentSettings(ui)
  const opened = readySection(port.subagentLimits.read())
  assert.equal(opened.effective.maxDepth, 4)
  await stageSubagentNumber(ui, 'Maximum recursion depth', '0')
  await settingsKey(ui, 's')
  await waitForFrame(() => ui.vt.getViewport().join('\n'), frame => /Limits: Outcome unconfirmed/u.test(frame),
    () => ui.vt.waitForRender(), 'the official overlay refusal must never paint Verified')
  assert.deepEqual(calls, [{ ns: 'subagent', ops: [{ op: 'set', path: ['maxDepth'], value: 0 }], revision: opened.revision }])
  assert.equal(readySection(port.subagentLimits.read()).effective.maxDepth, 4)
  assert.equal(plane.userConfig('subagent'), undefined, 'the ConfigEditor refusal did not create a profile override')
  assert.match(ui.vt.getViewport().join('\n'), /home patch or command-line overlay/u)
  assert.doesNotMatch(ui.vt.getViewport().join('\n'), /Limits: Verified/u)
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
