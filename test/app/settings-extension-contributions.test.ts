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

test('rejected false AND rejected throw both stay Not saved and record only their own owner health', async () => {
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
        onChange: (value) => { calls.push(`false:${value}`); return false },
      })
    })
    await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'c1', label: 'Gamma level', currentValue: 'on', values: ['on', 'off'], order: 2,
        onChange: (value) => { calls.push(`throw:${value}`); throw new Error('gamma refused the change') },
      })
    })
    await h.vt.waitForRender()

    await openExtensionsRows(h)
    await h.key('\t') // the beta group
    await h.key('\r') // Detail + choice (`on`)
    await h.key('\u001b[B') // off
    await h.key('\r') // Confirm: the plugin returns false
    await h.drain()
    assert.match(h.view(), /Not saved/u, 'the false refusal is painted')
    // The THIRD group refuses by THROWING: the same rejected mapping, its own
    // health record, never A's and never a success.
    await h.key('\u001b') // settled Detail -> Rows
    await h.key('\t') // gamma group
    await h.key('\r') // Detail + choice
    await h.key('\u001b[B') // off
    await h.key('\r') // Confirm: the plugin throws
    await h.drain()

    assert.deepEqual(calls, ['false:off', 'throw:off'],
      'each refusing callback ran exactly once with the raw value')
    for (const id of ['a1', 'b1', 'c1']) {
      assert.equal(h.registry.rows().find(row => row.id === id)?.currentValue, 'on',
        `a refusal keeps ${id}'s previous registry value`)
    }
    assert.match(h.view(), /Not saved/u)
    const health = h.health()
    const failed = health.filter(record => record.state === 'failed')
    assert.deepEqual(failed.map(record => record.id).sort(), ['b1', 'c1'],
      'ONLY the two refusing owners are marked failed')
    for (const record of failed) assert.match(record.lastError ?? '', /setting rejected/u)
    assert.equal(health.find(record => record.id === 'a1')?.state, 'active', 'the other owner stays clean')
    assert.equal(h.documentWrites(), 0)
    assert.equal(
      h.warnings().filter(entry => entry.fields?.outcome === 'not-saved'
        && String(entry.fields?.field).startsWith('ext-setting:')).length,
      2,
      'each refusal keeps exactly one diagnosable writer entry',
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
    // The old apply settled as GONE (an unloaded registration), never as a
    // plugin rejection: the writer keeps its diagnostic and records NO health.
    const goneWrite = h.warnings().find(entry => entry.fields?.field === 'ext-setting:same')
    assert.ok(goneWrite !== undefined, 'the settled write keeps a diagnosable outcome')
    assert.equal(goneWrite.fields?.outcome, 'not-saved')
    assert.match(String(goneWrite.fields?.reason), /unloaded or replaced/u,
      'a replaced registration is GONE, never a fabricated plugin refusal')
    assert.equal(h.health().some(record => record.state === 'failed'), false,
      'gone/stale bookkeeping never creates an owner health event')
    const sameHealth = h.health().filter(record => record.id === 'same')
    assert.equal(sameHealth.length, 1, 'the replacement owner is the ONE live health record')
    assert.equal(sameHealth[0]?.state, 'active',
      'the old owner health record was untracked on unload')
  } finally {
    await h.dispose()
  }
})

test('a real 0-value registration is read-only in the Detail and never reaches its callback', async () => {
  const h = await setupEnvironment()
  try {
    const calls: string[] = []
    await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'readonly', label: 'Readonly note', description: 'registered without selectable values',
        currentValue: 'plain text', values: [], order: 0,
        // The presence of onChange must NEVER be taken as licence to invent an
        // editor for a contribution that registered no selectable values.
        onChange: (value) => { calls.push(value); return true },
      })
    })
    await h.vt.waitForRender()
    await openExtensionsRows(h)
    assert.match(h.header(), /Settings · Extensions \[1\/1\]/u)
    assert.match(h.view(), /Readonly note/u, 'the read-only registration is still discoverable')
    await h.key('\r') // Rows -> Detail (a writable row would also open its choice)
    const detail = h.view()
    assert.match(detail, /Settings · Extensions · Readonly note/u)
    assert.match(detail, /Value\s+plain text/u)
    assert.match(detail, /Owner\s+\d+:.*:?/u)
    assert.match(detail, /ID\s+readonly/u)
    assert.match(detail, /No selectable values registered/u)
    assert.doesNotMatch(detail, /Choose value|Change…|\[Confirm\]|Retry save/u,
      'no choice/change/confirm/retry is invented from the onChange presence')
    // Enter on the browse Detail is inert: no choice, no callback, no write.
    await h.key('\r')
    assert.doesNotMatch(h.view(), /Choose value/u)
    assert.deepEqual(calls, [], 'the plugin onChange never runs for a read-only registration')
    assert.equal(h.documentWrites(), 0)
    assert.equal(h.health().some(record => record.state === 'failed'), false)
    assert.equal(h.registry.rows().find(row => row.id === 'readonly')?.currentValue, 'plain text')
  } finally {
    await h.dispose()
  }
})

test('two real fibers with the SAME name stay two distinct owner groups in the L6 composition', async () => {
  const h = await setupEnvironment()
  try {
    const calls: string[] = []
    // Cordis names both fibers `logger`; the owner identity appends the fiber
    // uid, so the two contributions must never merge into one page.
    const alpha = h.ctx.plugin(function logger(pluginCtx) {
      serviceOf(pluginCtx).registerSetting({
        id: 'l1', label: 'First log level', currentValue: 'info', values: ['info', 'debug'], order: 0,
        onChange: (value) => { calls.push(`l1:${value}`); return true },
      })
    })
    await alpha
    const beta = h.ctx.plugin(function logger(pluginCtx) {
      serviceOf(pluginCtx).registerSetting({
        id: 'l2', label: 'Second log level', currentValue: 'info', values: ['info', 'debug'], order: 1,
        onChange: (value) => { calls.push(`l2:${value}`); return true },
      })
    })
    await beta
    const owners = h.registry.rows().map(row => row.owner)
    assert.equal(new Set(owners).size, 2, 'the same fiber NAME is not an owner identity')
    for (const owner of owners) assert.match(owner, /^\d+:logger$/u)
    await h.vt.waitForRender()
    // Give the panel the fresh directory through the real render loop.
    await openExtensionsRows(h)
    assert.match(h.header(), /Settings · Extensions \[1\/2\] · logger · \d+ · Rows/u,
      'the header distinguishes the two same-named owners by uid')
    assert.match(h.view(), /First log level/u)
    assert.doesNotMatch(h.view(), /Second log level/u, 'the second owner page is not painted')
    await h.key('\t')
    assert.match(h.header(), /Settings · Extensions \[2\/2\] · logger · \d+ · Rows/u)
    assert.match(h.view(), /Second log level/u)
    assert.doesNotMatch(h.view(), /First log level/u)
    await h.key('\r') // Detail + choice on the second owner
    assert.match(h.view(), /Owner\s+\d+:logger/u, 'the Detail states the RAW owner')
    await h.key('\u001b[B') // info -> debug
    await h.key('\r') // explicit Confirm
    await h.drain()
    // The settled browse Detail keeps the full registration identity.
    assert.match(h.view(), /ID\s+l2/u)
    assert.deepEqual(calls, ['l2:debug'], 'only the second owner callback ran')
    assert.equal(h.registry.rows().find(row => row.id === 'l1')?.currentValue, 'info')
    assert.equal(h.registry.rows().find(row => row.id === 'l2')?.currentValue, 'debug')
    assert.equal(h.documentWrites(), 0)
  } finally {
    await h.dispose()
  }
})

test('a pending write whose owner group unloads settles GONE without claiming the surviving groups', async () => {
  const h = await setupEnvironment()
  try {
    let releaseChange!: (accepted: boolean) => void
    const changeGate = new Promise<boolean>(resolve => { releaseChange = resolve })
    const calls: string[] = []
    const alpha = await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'a1', label: 'Alpha level', currentValue: 'on', values: ['on', 'off'], order: 0,
        onChange: (value) => { calls.push(`alpha:${value}`); return changeGate },
      })
    })
    await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'b1', label: 'Beta level', currentValue: 'on', values: ['on', 'off'], order: 1,
        onChange: (value) => { calls.push(`beta:${value}`); return true },
      })
    })
    const gamma = await registerFiber(h.ctx, (service) => {
      service.registerSetting({
        id: 'c1', label: 'Gamma level', currentValue: 'on', values: ['on', 'off'], order: 2,
        onChange: (value) => { calls.push(`gamma:${value}`); return true },
      })
    })
    await h.vt.waitForRender()
    await openExtensionsRows(h)
    assert.match(h.header(), /\[1\/3\]/u)
    await h.key('\r') // Detail + choice on alpha
    await h.key('\r') // explicit Confirm -> the callback is held
    assert.match(h.view(), /Saving…/u)
    assert.deepEqual(calls, ['alpha:on'], 'the selected owner callback started')

    // The SELECTED owner unloads while its write is still pending; two other
    // groups remain, so the directory repair lands on the beta page.
    await alpha.fiber.dispose()
    await h.vt.waitForRender()
    assert.match(h.header(), /Settings · Extensions \[1\/2\] · root · \d+ · Rows/u,
      `the remaining first group takes the page:\n${h.view()}`)
    assert.match(h.view(), /> Beta level/u, 'the repaired page selects the surviving group first row')
    // The old task's UI lock and acknowledgement die with the vanished
    // selection: the app-owned write keeps settling, but the surviving page is
    // NOT shown as saving and is immediately operable.
    assert.doesNotMatch(h.view(), /Saving…/u, 'the vanished selection keeps no pending UI lock')
    assert.match(h.view(), /Tab next group/u, 'the surviving page advertises the real group switch')
    await h.key('\t') // beta -> gamma works while alpha's callback is still held
    assert.match(h.header(), /Settings · Extensions \[2\/2\] · root · \d+ · Rows/u)
    assert.match(h.view(), /> Gamma level/u)
    await h.key('\u001b[Z') // back to beta
    assert.match(h.header(), /Settings · Extensions \[1\/2\] · root · \d+ · Rows/u)
    // The surviving owner's row can be edited and confirmed while the old
    // callback is still in flight: one app-owned write at a time is a writer
    // rule, not a stale UI lock.
    await h.key('\r') // Detail + choice on beta
    await h.key('\u001b[B') // on -> off
    await h.key('\r') // explicit Confirm
    await h.drain()
    assert.deepEqual(calls, ['alpha:on', 'beta:off'],
      'the surviving owner committed while the old callback was still held')
    assert.equal(h.registry.rows().find(row => row.id === 'b1')?.currentValue, 'off')
    assert.match(h.view(), /Verified/u, 'the surviving write verifies on its own row')
    assert.equal(h.health().some(record => record.state === 'failed'), false,
      'no health failure while the old callback is still pending')

    // Release the old callback: the registration is gone, so the settlement is
    // a GONE write — never a rejection and never a claim on beta/gamma.
    releaseChange(true)
    await h.drain()
    assert.deepEqual(calls, ['alpha:on', 'beta:off'], 'no other callback ran')
    assert.equal(h.registry.rows().length, 2, 'only the surviving contributions remain')
    assert.equal(h.health().some(record => record.state === 'failed'), false,
      'gone records no owner health event')
    const settledFrame = h.view()
    assert.doesNotMatch(settledFrame, /Not saved|Retry save|Saving…/u,
      'the retired group settlement never paints on the new group')
    assert.match(settledFrame, /Verified/u, 'the surviving row keeps ITS settled status')
    assert.match(settledFrame, /Value\s+off/u, 'the surviving value is still the painted fact')
    const goneWrite = h.warnings().find(entry => entry.fields?.field === 'ext-setting:a1')
    assert.ok(goneWrite !== undefined)
    assert.equal(goneWrite.fields?.outcome, 'not-saved')
    assert.match(String(goneWrite.fields?.reason), /unloaded or replaced/u)
    assert.equal(gamma.handles.length, 1)
  } finally {
    await h.dispose()
  }
})
