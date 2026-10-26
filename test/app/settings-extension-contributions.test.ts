/**
 * C2-R6 L6 evidence: the LIVE extension-settings path end to end.
 *
 * Fixture manifest (production-equivalent): a real Cordis fiber calls the public
 * `ExtensionService.registerSetting()`; the service owns the production
 * `SettingsRegistry`; the real `/settings` command projects it through
 * `readSettingsWorkspaceSnapshot`; the Settings workspace panel is driven by a
 * `VirtualTerminal` (real Tab/Enter/confirm input); the command's
 * `commitSettingsWorkspaceField` calls `SettingsRegistry.applyDetailed`; the
 * fiber's own `onChange` runs; and the result is read back from the registry,
 * the service health ledger and the painted Detail.
 *
 * NOT faked: grouping, registration, candidate values, the writer decision, the
 * registration token, the captured health ref or the frame hit grant. The
 * ConfigPort document is an unrelated counting fake (these settings are
 * runtime-only and must never write it), and the session/About seams answer the
 * sessionless composition.
 *
 * @module @xmoon76/dsh-pi-tui/settings-extension-contributions.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { TuiApp, type TuiAppEvents } from '../../src/tui-app.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { ThemeRegistry } from '../../src/extension/internal/theme-registry.ts'
import type { SettingsRegistry } from '../../src/extension/internal/settings-registry.ts'
import { apply as applyExtensionHost, PI_TUI_EXTENSIONS_SERVICE } from '../../src/extensions.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import type { TuiSettingsDoc } from '../../src/runtime/config-port.ts'
import type { ContributionHealth } from '../../src/extension/public-types.ts'
import type { TuiCommandRunner } from '../../src/commands.ts'

/** The concrete extension service members this case drives (the public
 *  registration path plus the internal health ledger the runner reads). */
interface ExtensionServiceLike {
  registerSetting(contribution: {
    readonly id: string
    readonly label: string
    readonly description?: string
    readonly currentValue: string
    readonly values?: readonly string[]
    readonly order?: number
    readonly onChange?: (value: string) => boolean | void | Promise<boolean | void>
  }): { readonly id: string; setValue(value: string): void; dispose(): void }
  readonly settings: SettingsRegistry
  attachSurface(
    bridge: { subscribe(listener: (state: unknown) => void): () => void },
    capabilities: ReadonlySet<string>,
    surfaceId: string,
    requestRender?: (force?: boolean) => void,
  ): void
  detachSurface(surfaceId?: string): void
  _ledger(): { healthSnapshot(): readonly ContributionHealth[] }
  _recordRegistryError(ref: { slot: string; id: string; owner: string }, error: unknown): void
  _clearRegistryError(ref: { slot: string; id: string; owner: string }): void
}

interface Harness {
  readonly ctx: Context
  readonly service: ExtensionServiceLike
  readonly registry: SettingsRegistry
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  /** How many TUI-settings document writes the composition dispatched. */
  readonly documentWrites: () => number
  readonly view: () => string
  readonly lines: () => readonly string[]
  readonly header: () => string
  /** Every `diag.warn` the command path recorded. */
  readonly warnings: () => readonly { readonly message: string; readonly fields?: Record<string, unknown> }[]
  /** The LIVE extension health snapshot (failed/active per contribution). */
  readonly health: () => readonly ContributionHealth[]
  readonly key: (data: string) => Promise<void>
  readonly drain: () => Promise<void>
  /** Open `/settings` (the About home) on the real command path. */
  readonly open: () => Promise<void>
  readonly dispose: () => Promise<void>
}

/** One captured registration handle of the public service API. */
type SettingHandle = ReturnType<ExtensionServiceLike['registerSetting']>

async function setupEnvironment(): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(Loader)
  const startupFiber = ctx.plugin((c) => { c.provide(TUI_STARTUP_SERVICE, {}) })
  await startupFiber
  const hostFiber = ctx.plugin(applyExtensionHost)
  await hostFiber
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as unknown as ExtensionServiceLike
  assert.ok(service !== undefined, 'the real extension service is provided by the host')

  const vt = new VirtualTerminal(120, 40)
  const warnings: { message: string; fields?: Record<string, unknown> }[] = []
  const doc: TuiSettingsDoc = {
    theme: 'auto',
    iconStyle: 'emoji',
    footer: 'default',
    fullscreen: 'off',
    busyEnter: 'queue',
    localShellSandbox: 'bypass',
    homeEndKeys: 'input',
    wheelScrollLines: '1',
    notificationMode: 'unfocused',
    notificationMethod: 'auto',
    terminalProgress: 'on',
  }
  let documentWrites = 0
  let disposed = false
  const events: TuiAppEvents = {
    onSubmit: () => {},
    onExit: () => {},
    // The REAL owned-task entry the Settings writer runs through.
    runOwned: (_label, task, options) => {
      void Promise.resolve()
        .then(() => task())
        .then(
          result => { if (!disposed) options.onResult?.(result) },
          error => { if (!disposed) options.onError?.(error) },
        )
    },
  }
  const app = new TuiApp(vt, events)
  app.start()

  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => { defs.push(definition); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  const commandCtx = new Context()
  commandCtx.provide('commands', commands as never)
  commandCtx.provide('skills', {
    list: async () => [],
    get: async () => undefined,
    find: () => undefined,
    execute: async () => undefined,
  } as never)
  const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })
  const base: Record<string, unknown> = {
    ctx: commandCtx,
    app,
    diag: {
      ...diag,
      warn: (message: string, fields?: Record<string, unknown>) => {
        warnings.push({ message, ...fields === undefined ? {} : { fields } })
        diag.warn(message, fields)
      },
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    progressUpdatesState: { mode: 'milestones' as const },
    responseStyleState: { style: 'default' as const },
    gitAttributionState: { mode: 'off' as const },
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands: createClientCommandRegistry(parseCommand),
    // The captured-REF health bridge the production runner exposes: both
    // settlements land on the REAL owner-scoped ledger.
    recordExtensionError: (ref: { slot: string; id: string; owner: string }, error: unknown) => {
      service._recordRegistryError(ref, error)
    },
    clearExtensionError: (ref: { slot: string; id: string; owner: string }) => {
      service._clearRegistryError(ref)
    },
    // Sessionless surface: the About page reports unavailable facts and the
    // approval row is withheld; no Session is created or read.
    currentSessionId: undefined,
    captureLiveSessionScope: () => undefined,
    isSessionScopeCurrent: () => false,
    currentSessionStats: async () => undefined,
    sessionReader: {
      measureContext: () => undefined,
      sessionStatus: () => undefined,
      sessionStatusFailed: () => false,
    },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    backendKind: 'direct' as const,
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    displayPreset: () => app.displayPreset(),
    focusEnabled: () => false,
    setDisplayPreset: (preset: string) => ({ kind: 'unchanged' as const, preset }),
    copyToClipboard: async () => true,
    refreshStatus: () => {},
    // The live notification/terminal-progress owners the snapshot reads. The
    // extension cases never change them, but the static rows must still paint
    // their REAL facts (an undefined summary would be a broken row, not a test
    // detail).
    currentNotificationMode: () => 'unfocused',
    currentNotificationMethod: () => 'auto',
    setNotificationMode: () => {},
    setNotificationMethod: () => {},
    setTerminalProgressMode: () => {},
    currentApprovalOverride: () => undefined,
    setSessionApprovalPolicy: () => 'superseded' as const,
    tuiSettings: {
      get: () => doc,
      replace: async (next: TuiSettingsDoc) => {
        documentWrites += 1
        Object.assign(doc, next)
      },
    },
    // The composition's LIVE registry owner (never a test copy).
    extensions: { themes: new ThemeRegistry(), settings: service.settings },
    createPluginManagerPage: () => undefined,
    config: {
      configReadiness: () => 'ready' as const,
      visualTools: { read: () => undefined },
      footerCustomItems: { rawForPersistence: () => ({ kind: 'available' as const, value: undefined }) },
      permissions: {
        presetNames: () => [],
        defaultPreset: () => undefined,
        approvalOverrideAvailable: () => false,
      },
      subagentModelSelection: { available: () => false },
      web: { available: () => false },
      credentials: { available: () => false },
      providers: { available: () => false },
      authorization: { available: () => false },
      account: { available: () => false },
    },
    catalog: { models: { available: () => false } },
    applyFooterSettings: () => {},
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  // The service's InvalidateBatcher flushes into THIS surface, exactly like the
  // production SurfaceHost attachment.
  service.attachSurface(
    { subscribe: () => () => {} },
    new Set(),
    'c2-r6-l6-surface',
    () => { if (!disposed) app.requestRender() },
  )

  const invoke = (name = 'settings'): unknown => {
    const definition = defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `/${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  const key = async (data: string): Promise<void> => {
    vt.sendInput(data)
    await vt.waitForRender()
  }
  const drain = async (): Promise<void> => {
    for (let round = 0; round < 8; round += 1) {
      await Promise.resolve()
      await vt.waitForRender()
    }
  }
  const open = async (): Promise<void> => {
    invoke('settings')
    await vt.waitForRender()
  }
  const lines = (): readonly string[] => vt.getViewport().map(stripTerminalSequences)
  const header = (): string => lines()[0] ?? ''
  const dispose = async (): Promise<void> => {
    disposed = true
    service.detachSurface('c2-r6-l6-surface')
    if (!app.isDisposed()) app.dispose()
    for (const runtime of [...ctx.registry.values()]) {
      for (const fiber of runtime.fibers) await Promise.resolve(fiber.dispose())
    }
  }
  return {
    ctx,
    service,
    registry: service.settings,
    vt,
    app,
    documentWrites: () => documentWrites,
    view: () => lines().join('\n'),
    lines,
    header,
    warnings: () => warnings,
    health: () => service._ledger().healthSnapshot(),
    key,
    drain,
    open,
    dispose,
  }
}

/** The real service as a plugin fiber sees it through the public Cordis
 *  injection — never a test-owned registry copy. */
function serviceOf(pluginCtx: Context): ExtensionServiceLike {
  return pluginCtx.get(PI_TUI_EXTENSIONS_SERVICE) as unknown as ExtensionServiceLike
}

/** One real plugin fiber registering contributions through the PUBLIC API. */
async function registerFiber(
  ctx: Context,
  register: (service: ExtensionServiceLike) => void,
): Promise<{ readonly fiber: { dispose(): Promise<unknown> | void }; readonly handles: readonly SettingHandle[] }> {
  const handles: SettingHandle[] = []
  const fiber = ctx.plugin((pluginCtx) => {
    const service = serviceOf(pluginCtx)
    const proxy = new Proxy(service, {
      get: (target, property) => {
        if (property !== 'registerSetting') return Reflect.get(target, property)
        return (contribution: Parameters<ExtensionServiceLike['registerSetting']>[0]) => {
          const handle = target.registerSetting(contribution)
          handles.push(handle)
          return handle
        }
      },
    })
    register(proxy)
  })
  await fiber
  return { fiber, handles }
}

/** Open `Settings → Extensions → Rows` with the real keys. */
async function openExtensionsRows(h: Harness): Promise<void> {
  await h.open()
  await selectSettingsCategory(h.vt, 'Extensions')
  await h.key('\r')
}

test('a real fiber registration commits from the second group through the registry', async () => {
  const h = await setupEnvironment()
  try {
    const calls: string[] = []
    // Fiber A: a1 (order 0) and a2 (order 2). Fiber B: b1 (order 1). The global
    // registry order is A1, B1, A2 — the group order must be A, B.
    await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'a1', label: 'Alpha level', currentValue: 'on', values: ['on', 'off'], order: 0,
        onChange: (value) => { calls.push(`a1:${value}`); return true },
      })
      service.registerSetting({
        id: 'a2', label: 'Alpha timeout', currentValue: '5', values: ['5', '10'], order: 2,
        onChange: (value) => { calls.push(`a2:${value}`); return true },
      })
    })
    await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'b1', label: 'Beta level', currentValue: 'verbose', values: ['verbose', 'debug'], order: 1,
        onChange: (value) => { calls.push(`b1:${value}`); return true },
      })
    })
    await h.vt.waitForRender()

    await openExtensionsRows(h)
    assert.match(h.header(), /Settings · Extensions \[1\/2\]/u,
      `the header states the first owner group:\n${h.view()}`)
    assert.match(h.view(), /Rows \(2\) · /u, 'the first group contributes two rows')
    assert.match(h.view(), /Alpha level/u)
    assert.match(h.view(), /Alpha timeout/u)
    assert.doesNotMatch(h.view(), /Beta level/u, 'the second owner group is not painted')

    // Tab switches the page to the SECOND group; Enter opens its native choice.
    await h.key('\t')
    assert.match(h.header(), /Settings · Extensions \[2\/2\]/u)
    assert.match(h.view(), /> Beta level/u, 'the target group first row is selected')
    await h.key('\r')
    await h.key('\u001b[B') // verbose -> debug
    await h.key('\r') // explicit Confirm
    await h.drain()

    assert.deepEqual(calls, ['b1:debug'], 'ONLY the second group callback ran, exactly once')
    assert.equal(h.registry.rows().find(row => row.id === 'b1')?.currentValue, 'debug',
      'the LIVE registry holds the confirmed raw value')
    assert.match(h.view(), /Verified/u, 'the Detail reports the registry readback')
    assert.equal(h.documentWrites(), 0, 'a runtime-only extension setting never writes the TUI document')
    assert.equal(h.health().some(record => record.state === 'failed'), false,
      'an accepted change records no failure')
    const b1 = h.registry.rows().find(row => row.id === 'b1')
    assert.ok(b1 !== undefined)
    assert.equal(h.header().includes('Extensions'), true, 'the SAME Settings lease still owns the frame')
  } finally {
    await h.dispose()
  }
})

test('a rejected second-group change stays Not saved and records only that owner health', async () => {
  const h = await setupEnvironment()
  try {
    const calls: string[] = []
    await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'a1', label: 'Alpha level', currentValue: 'on', values: ['on', 'off'], order: 0,
        onChange: () => true,
      })
    })
    await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'b1', label: 'Beta level', currentValue: 'on', values: ['on', 'off'], order: 1,
        onChange: (value) => { calls.push(value); return false },
      })
    })
    await h.vt.waitForRender()

    await openExtensionsRows(h)
    await h.key('\t') // the beta group
    await h.key('\r') // Detail + choice (`on`)
    await h.key('\u001b[B') // off
    await h.key('\r') // Confirm: the plugin refuses
    await h.drain()

    assert.deepEqual(calls, ['off'], 'the refusing callback ran exactly once with the raw value')
    assert.equal(h.registry.rows().find(row => row.id === 'b1')?.currentValue, 'on',
      'a refusal keeps the previous registry value')
    assert.equal(h.registry.rows().find(row => row.id === 'a1')?.currentValue, 'on',
      'the other group value is untouched')
    assert.match(h.view(), /Not saved/u, 'the Detail reports the refusal')
    const health = h.health()
    const failed = health.filter(record => record.state === 'failed')
    assert.deepEqual(failed.map(record => record.id), ['b1'], 'ONLY the refusing owner is marked failed')
    assert.match(failed[0]?.lastError ?? '', /setting rejected/u)
    assert.equal(health.find(record => record.id === 'a1')?.state, 'active', 'the other owner stays clean')
    assert.equal(h.documentWrites(), 0)
    assert.equal(
      h.warnings().some(entry => entry.fields?.field === 'ext-setting:b1'),
      true,
      'the write owner keeps one diagnosable refusal',
    )
  } finally {
    await h.dispose()
  }
})

test('unloading the selected group lands on the remaining group and then retracts Extensions', async () => {
  const h = await setupEnvironment()
  try {
    const calls: string[] = []
    const alpha = await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'a1', label: 'Alpha level', currentValue: 'on', values: ['on', 'off'], order: 0,
        onChange: (value) => { calls.push(`alpha:${value}`); return true },
      })
    })
    const beta = await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'b1', label: 'Beta level', currentValue: 'on', values: ['on', 'off'], order: 1,
        onChange: (value) => { calls.push(`beta:${value}`); return true },
      })
    })
    await h.vt.waitForRender()
    await openExtensionsRows(h)
    await h.key('\t')
    assert.match(h.header(), /\[2\/2\]/u)

    // The B fiber unloads while its page is selected. The gesture that
    // DISCOVERS the change is refused; the next frame lands on the A group.
    await beta.fiber.dispose()
    h.vt.sendInput('\r')
    await h.vt.waitForRender()
    assert.match(h.header(), /Settings · Extensions \[1\/1\]/u,
      `the remaining group takes the page:\n${h.view()}`)
    assert.match(h.view(), /> Alpha level/u, 'the remaining group first row is selected')
    assert.deepEqual(calls, [], 'no plugin callback ran during the recovery')

    // N -> 0: the conditional category retracts and the rail owns the
    // keyboard again on the stable `Plugins` neighbour. (The rail pixels of the
    // plugin-page composition are pinned by the Settings visual suite; THIS
    // composition mounts no Plugin Manager page, so the header + the absence of
    // the Extensions page is the L6 witness.)
    await alpha.fiber.dispose()
    await h.vt.waitForRender()
    assert.match(h.header(), /Settings · Categories/u, 'the empty directory returns the keyboard to the rail')
    assert.doesNotMatch(h.view(), /Extensions \[|Alpha level|Beta level/u,
      'no empty Extensions page row holds the frame')
    // Esc still has its legal close: the surface was never left in a dead page.
    await h.key('\u001b')
    assert.match(h.view(), /❯/u, 'the editor seat is restored')
  } finally {
    await h.dispose()
  }
})

test('a replaced same-id registration never receives the old handle or a late settlement', async () => {
  const h = await setupEnvironment()
  try {
    let releaseChange!: (accepted: boolean) => void
    const changeGate = new Promise<boolean>(resolve => { releaseChange = resolve })
    const oldCalls: string[] = []
    const alpha = await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'same', label: 'Same setting', currentValue: 'on', values: ['on', 'off'], order: 0,
        onChange: (value) => { oldCalls.push(value); return changeGate },
      })
    })
    await h.vt.waitForRender()
    await openExtensionsRows(h)
    await h.key('\r') // Detail + choice
    await h.key('\u001b[B') // off
    await h.key('\r') // Confirm -> the callback is in flight
    assert.match(h.view(), /Saving…/u)

    // HMR: the SAME id is unloaded and re-registered under a new fiber while the
    // old callback is still in flight.
    const [oldHandle] = alpha.handles
    assert.ok(oldHandle !== undefined)
    await alpha.fiber.dispose()
    await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'same', label: 'Same setting', currentValue: 'off', values: ['on', 'off'], order: 0,
        onChange: (value) => { oldCalls.push(`new:${value}`); return true },
      })
    })
    await h.vt.waitForRender()
    assert.doesNotMatch(h.view(), /Saving…/u, 'the replacement inherits no pending presentation')
    assert.match(h.view(), /Value\s+off/u, 'the replacement current value is painted')

    // The OLD fiber's late handle calls are inert for the replacement…
    oldHandle.setValue('stale')
    oldHandle.dispose()
    assert.equal(h.registry.rows().length, 1, 'the replacement stays registered')
    assert.equal(h.registry.rows()[0]?.currentValue, 'off', 'the replacement value is untouched')

    // …and the old in-flight settlement cannot claim the new registration.
    releaseChange(true)
    await h.drain()
    assert.doesNotMatch(h.view(), /Verified|Not saved|Retry save/u,
      'the late settlement never paints on the replacement')
    assert.equal(h.registry.rows()[0]?.currentValue, 'off')
    assert.deepEqual(oldCalls, ['off'], 'the OLD callback settled exactly once; the NEW one never ran')
  } finally {
    await h.dispose()
  }
})
