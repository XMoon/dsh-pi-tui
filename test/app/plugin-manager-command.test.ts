/**
 * `/plugins` entry tests (S4-D1 / PR2): the canonical sessionless deep link
 * takes the ONE Settings workspace lease, landing on the embedded Plugin List,
 * and opening `/settings` alone never builds the embedded page (and therefore
 * never reads the plugin inventory).
 *
 * The first Settings lease is the ONLY screen authority: a second lease (or a
 * second `/plugins`) is refused instead of stacking a screen, and the refusal
 * is the documented `{ kind: 'error' }` command result.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-command.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry, type ClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand, type CommandResult } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { createPluginManagerWorkspacePanel, type EmbeddedPluginPage } from '../../src/tui/plugin-manager/workspace.ts'
import { createPluginManagerRuntime } from '../../src/app/surface/plugin-manager-runtime.ts'
import type { PluginManagerPort } from '../../src/runtime/plugin-manager-port.ts'
import { bundle } from '../support/plugin-workspace-harness.ts'
import { settingsDirectPageConfig } from '../support/settings-direct-page-stubs.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

/** Every observable side effect the two entries must (not) have. */
interface CommandCounts {
  /** Embedded Plugin pages the Settings root really built. */
  pages: number
  /** Pages released through their own disposal path. */
  disposed: number
  /** Sessions created/opened by either command (must stay 0). */
  sessions: number
  /** About semantic entries (the About controller's ONE scoped capture). */
  aboutEntries: number
}

function plain(view: readonly string[]): string {
  return view.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
}

/** The minimal embedded page the Settings root can host: it paints a marker and
 *  implements the narrow `EmbeddedPluginPage` contract the root consumes. */
function embeddedPage(counts: CommandCounts): EmbeddedPluginPage {
  return {
    focused: false,
    render: (width: number) => ['PLUGIN PAGE'.padEnd(Math.max(1, width))],
    invalidate: () => {},
    dispose: () => { counts.disposed += 1 },
    setViewport: () => {},
    currentView: () => 'list',
    canYieldFocusToNavigation: () => true,
    pendingMutation: () => false,
    cancelPointer: () => {},
    handleInput: () => {},
    handleMouse: () => undefined,
    onCellPress: () => {},
    onCellClick: () => {},
    contentLayout: () => ({ dual: false, leftWidth: 1, rightWidth: 1 }),
  }
}

function fakeCommands(): { defs: { name: string; handler?: unknown }[]; commands: Record<string, unknown> } {
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (definition: { name: string; handler?: unknown }) => {
      defs.push(definition)
      return () => {}
    },
    list: () => defs.map(definition => ({ name: definition.name, description: '' })),
    find: () => undefined,
    execute: async () => undefined,
  }
  return { defs, commands }
}

function proxyRunner(
  ctx: Context,
  app: TuiApp,
  commands: Record<string, unknown>,
  clientCommands: ClientCommandRegistry,
  counts: CommandCounts,
): TuiCommandRunner {
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    signal: new AbortController().signal,
    commandRegistry: commands,
    clientCommands,
    recordExtensionError: () => {},
    clearExtensionError: () => {},
    captureExtensionHealthRef: () => () => {},
    // A sessionless surface: both entries must work before any Session exists.
    currentSessionId: undefined,
    agents: {
      create: async () => {
        counts.sessions += 1
        throw new Error('a sessionless entry must not create a Session')
      },
      open: async () => {
        counts.sessions += 1
        throw new Error('a sessionless entry must not open a Session')
      },
    },
    // The About controller's ONE semantic entry is a live-scope capture. The
    // `/plugins` deep link lands on the Plugin List, so it must never capture
    // (and therefore never read) the About page.
    captureLiveSessionScope: () => {
      counts.aboutEntries += 1
      return undefined
    },
    // C3 About seams: this fixture composes no StatusRuntime, so the
    // sessionless capture is the only reachable state (no scoped read can
    // start). The subscription STILL must return a real disposer: opening
    // `/settings` builds the About controller, its close calls `dispose()`,
    // and a non-function return would abort the TuiApp teardown and leak the
    // process slot into every later test.
    isSessionScopeCurrent: () => false,
    currentSessionStats: async () => undefined,
    sessionReader: { measureContext: () => undefined, sessionStatus: () => undefined },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    backendKind: 'direct' as const,
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    tuiSettings: undefined,
    extensions: undefined,
    // The Settings root builds the ONE embedded page lazily, only when its
    // content column is really painted.
    createPluginManagerPage: () => {
      counts.pages += 1
      return embeddedPage(counts)
    },
    config: {
      configReadiness: () => 'ready' as const,
      visualTools: {
        read: () => ({ enabled: true, revision: 1, userOverridden: false, applied: true }),
        setEnabled: async (_enabled: boolean, _revision: number) => {},
      },
      permissions: {
        presetNames: () => [],
        defaultPreset: () => undefined,
        approvalOverrideOf: () => undefined,
      },
      subagentModelSelection: { available: () => false },
      // The Web provider section is Host-only (S2/PR-B): this stub composes no
      // Host settings plane, so the section reports unavailable and offers no write.
      web: { available: () => false },
      // The credential STORE is not mounted either: the Web section's key row
      // reports unavailable instead of claiming "not configured".
      credentials: { available: () => false },
    },
    catalog: { models: { available: () => false } },
  }
  return new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
}

/** Prove the app holds the ONE Settings workspace lease: a second lease is
 *  refused before it can construct a panel or repaint anything. */
function expectSettingsLeaseHeld(app: TuiApp): void {
  assert.throws(
    () => app.openSettingsWorkspace(
      { readSnapshot: () => ({ configReadiness: 'ready', rows: [], capturedAt: 0 }) },
      { aboutVersionFacts: { tui: 'test-bundle', dsh: undefined }, onOpenLegacy: () => {} },
    ),
    /already leased/,
  )
}

function setup(): {
  invoke: (name: string) => unknown
  clientCommands: ClientCommandRegistry
  defs: { name: string; handler?: unknown }[]
  counts: CommandCounts
  app: TuiApp
  vt: VirtualTerminal
} {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeCommands()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const counts: CommandCounts = { pages: 0, disposed: 0, sessions: 0, aboutEntries: 0 }
  const clientCommands = createClientCommandRegistry(parseCommand)
  registerTuiCommandsWithDirectSeams(proxyRunner(ctx, app, services.commands, clientCommands, counts))
  const invoke = (name: string): unknown => {
    const definition = services.defs.find(candidate => candidate.name === name)
    assert.ok(definition?.handler !== undefined, `${name} must be registered`)
    return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput: '' })
  }
  return { invoke, clientCommands, defs: services.defs, counts, app, vt }
}

test('/plugins is registered by the real registrar and dispatches success into the ONE Settings lease', async () => {
  const { clientCommands, defs, counts, app, vt } = setup()
  // The REAL registrar installed the name into the Host registry AND the Client
  // command registry (the production dispatch surface).
  assert.ok(defs.some(definition => definition.name === 'plugins'))
  assert.ok(clientCommands.get('plugins') !== undefined, 'the registrar registers /plugins in the Client registry')
  // Dispatch through the REAL Client command registry, not the raw handler.
  const execution = await clientCommands.execute({ line: '/plugins', signal: new AbortController().signal })
  assert.ok(execution !== undefined, '/plugins must be an invocation of a registered Client command')
  assert.equal(execution.result.kind, 'success')

  // The app reports a Settings workspace lease: the ONE screen authority.
  expectSettingsLeaseHeld(app)
  await vt.waitForRender()
  assert.equal(counts.pages, 1, 'the deep link builds the embedded page exactly once')
  assert.equal(counts.disposed, 0)
  assert.equal(counts.aboutEntries, 0, 'the Plugins deep link never admits an About read')
  assert.equal(counts.sessions, 0, 'the deep link creates no Session')
  const view = plain(vt.getViewport())
  assert.match(view, /Settings · Plugins/, 'the ONE lease lands with the Plugin List focused')
  assert.match(view, /PLUGIN PAGE/, 'the embedded page is painted by the Settings content column')
})

test('T01 the real /plugins chain mounts the PRODUCTION page and reads the inventory exactly once', async () => {
  // §8.1 T01: the REAL Client command registry -> the REAL Settings lease ->
  // the REAL `createPluginManagerWorkspacePanel` over a real Controller and the
  // semantic PluginManagerPort. Only the Host port is a fixture; the page,
  // Controller and grant composition are production code.
  const ctx = new Context()
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const services = fakeCommands()
  ctx.provide('commands', services.commands as never)
  ctx.provide('skills', { list: async () => [], get: async () => undefined, find: () => undefined, execute: async () => undefined } as never)
  const clientCommands = createClientCommandRegistry(parseCommand)

  let snapshotCalls = 0
  let pages = 0
  const port: PluginManagerPort = {
    snapshot: async () => {
      snapshotCalls += 1
      return {
        bundles: [bundle({ name: '@vendor/foo', source: 'file:/tmp/foo', enabled: false })],
        plugins: [],
        registries: { registry: null, fallbackRegistries: [], resolved: null },
        exemptions: [],
        exemptionWarnings: [],
      }
    },
    inspect: async (spec: string) => ({ status: 'accepted', kind: 'registry', name: spec.split('@')[0] ?? spec, version: '1.0.0', bundle: true, registry: null }),
    setBundleEnabled: async () => ({ changed: true, application: 'applied', stage: 'enable', target: 'x' }),
    setPluginEnabled: async () => ({ changed: true, application: 'applied', stage: 'enable', target: 'x' }),
    removeBundle: async () => ({ changed: true, application: 'applied', stage: 'remove', target: 'x' }),
    startInstall: async () => ({ changed: true, application: 'applied', stage: 'install', target: 'x' }),
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: () => () => {},
    subscribeInvalidation: () => () => {},
  }
  // The PRODUCTION surface owner: ONE controller + the token-owned host claim +
  // the page factory, exactly what bootstrap attaches.
  const runtime = createPluginManagerRuntime({
    mounted: () => app,
    service: () => undefined,
    // The SAME factory bootstrap injects.
    createPanel: createPluginManagerWorkspacePanel,
  })
  const surface = runtime.attach({ port, diag: createDiag({ filePath: undefined, stderrLevel: 'off' }) })

  const counts: CommandCounts = { pages: 0, disposed: 0, sessions: 0, aboutEntries: 0 }
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    cwd: '/ws',
    signal: new AbortController().signal,
    commandRegistry: services.commands,
    clientCommands,
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
    tuiSettings: undefined,
    extensions: undefined,
    // The PRODUCTION composition factory (the same one bootstrap injects).
    createPluginManagerPage: (onYieldNavigation: () => void) => {
      pages += 1
      counts.pages += 1
      const page = surface.page(onYieldNavigation)
      return page as EmbeddedPluginPage | undefined
    },
    config: settingsDirectPageConfig({
      configReadiness: () => 'ready' as const,
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined },
      subagentModelSelection: { available: () => false },
      web: { available: () => false },
      credentials: { available: () => false },
    }),
    catalog: { models: { available: () => false } },
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)

  const execution = await clientCommands.execute({ line: '/plugins', signal: new AbortController().signal })
  assert.ok(execution !== undefined, '/plugins must be a registered Client command')
  assert.equal(execution.result.kind, 'success')
  await vt.waitForRender()

  assert.equal(pages, 1, 'the deep link mounts exactly ONE production page')
  assert.equal(snapshotCalls, 1, 'the Controller opened the semantic port exactly once')
  const view = plain(vt.getViewport())
  assert.match(view, /Settings · Plugins/u, 'the ONE Settings lease owns the frame')
  assert.match(view, /Search: \//u, 'the REAL embedded list paints its local Search row')
  assert.match(view, /@vendor\/foo/u, 'the REAL inventory facts reach the painted list')
  assert.match(view, /Enter details/u, 'the keyboard starts on the plugin List')
  assert.equal(counts.aboutEntries, 0, 'the deep link never admits an About read')
  assert.equal(counts.sessions, 0, 'the deep link creates no Session')

  // `i` enters the original install view through the REAL page keys.
  vt.sendInput('i')
  await vt.waitForRender()
  assert.match(view.length > 0 ? plain(vt.getViewport()) : '', /Plugins · Install/u, 'i opens the install view')
  assert.equal(pages, 1, 'the install view never builds a second page')
  assert.equal(snapshotCalls, 1, 'opening the install view never re-reads the inventory')
  app.dispose()
  runtime.dispose()
})

test('/settings renders lazily (no embedded Plugin page build, no plugin inventory read)', async () => {
  const { invoke, counts, app, vt } = setup()
  // `/settings` reads the Host Web provider facts before it leases the
  // workspace screen (S2/PR-B §B3.4), so its handler may be asynchronous.
  const result = await invoke('settings') as CommandResult
  assert.equal(result.kind, 'success')
  expectSettingsLeaseHeld(app)
  await vt.waitForRender()
  assert.equal(counts.pages, 0, 'opening /settings must not build the Plugin Manager page')
  assert.equal(counts.disposed, 0)
  assert.equal(counts.aboutEntries, 1, 'the About home is the ONE semantic About entry')
  assert.equal(counts.sessions, 0, 'opening /settings creates no Session')
  const view = plain(vt.getViewport())
  assert.match(view, /Settings/)
  assert.match(view, /Plugins/)
  assert.doesNotMatch(view, /PLUGIN PAGE/)
})

test('a refused Settings lease is the documented error result, not a second screen', async () => {
  const { invoke, counts, vt } = setup()
  await invoke('settings')
  await vt.waitForRender()
  const refused = await invoke('plugins') as CommandResult
  assert.equal(refused.kind, 'error')
  const text = refused.kind === 'error' ? refused.text : ''
  assert.match(text, /^could not open the settings workspace: /)
  assert.match(text, /already leased/)
  assert.equal(counts.pages, 0, 'the refusal never builds a second page')
  assert.equal(counts.aboutEntries, 1, 'the refused open never re-runs the About entry')
  // The existing Settings About screen is still the owner.
  assert.match(plain(vt.getViewport()), /Settings/)
})
