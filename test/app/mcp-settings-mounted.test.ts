/**
 * The mounted `Settings · Tools · MCP servers` input and persistence paths.
 *
 * Drives the REAL `/settings` command, the REAL `TuiApp` Settings workspace
 * lease, the REAL `SettingsWorkspacePanel`, the REAL per-open
 * `McpServersController` and the Direct MCP page adapters. Routine cases use a
 * controlled Host manager/settings boundary; the Root-pointer persistence case
 * additionally mounts the official Loader, ConfigEditor and SettingsForms over
 * a disposable profile and reads its patch back. No real user profile, external
 * MCP server or physical terminal is used.
 *
 * The case proves: the page is reachable from Tools; `configured:true` is never
 * shown as Configured without the settings key evidence; a plugin entry and a
 * retained cleanup record are classified separately; Probe/Restart reach the
 * Host exactly once; Esc cancels a restart; only reviewed, explicit
 * confirmations write configuration; and reopening leaves ONE watch at a time.
 *
 * @module @xmoon76/dsh-pi-tui/mcp-settings-mounted.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { loadProfileDirectory, mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import type { TuiCommandRunner } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { createDirectSettingsFixture } from '../support/direct-settings-fixture.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { settingsDirectPageConfig } from '../support/settings-direct-page-stubs.ts'
import { selectSettingsCategory } from '../support/settings-rail.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { DirectMcpServerPort, type DirectMcpHostContextLike } from '../../src/runtime/direct/mcp-server-direct.ts'
import type { McpServersController } from '../../src/app/command/mcp-servers.ts'
import type { EmbeddedSpecialistPage } from '../../src/tui/panels/settings-workspace-panel.ts'
import { DirectMcpServerConfigurationConfig, DirectMcpServerSourcesConfig, type SettingsServiceLike, type SettingsMutationOp } from '../../src/runtime/direct/config-direct.ts'
import type { McpServerWatchEvent } from '../../src/runtime/mcp-server-port.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try {
      app.dispose()
    } catch {
      try { app.stop() } catch {}
    }
  }
})

/** The controlled Host MCP manager: a real watch stream, probe and restart. */
class FixtureManager {
  probes: string[] = []
  restarts: string[] = []
  activeWatches = 0
  watchSubscriptions = 0
  private readonly frames: unknown[][] = []
  private waiting: Array<() => void> = []
  private readonly list: unknown[]

  constructor(list: unknown[]) {
    this.list = list
  }

  push(): void {
    this.frames.push(this.list)
    const wake = this.waiting
    this.waiting = []
    for (const resolve of wake) resolve()
  }

  async *watch(signal: AbortSignal): AsyncIterable<unknown> {
    this.activeWatches += 1
    this.watchSubscriptions += 1
    this.frames.push(this.list)
    try {
      while (!signal.aborted) {
        if (this.frames.length === 0) {
          await new Promise<void>(resolve => {
            this.waiting.push(resolve)
            signal.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        const frame = this.frames.shift()
        if (frame !== undefined) yield frame
      }
    } finally {
      this.activeWatches -= 1
    }
  }

  async probe(name: string, _options?: { readonly signal?: AbortSignal }): Promise<unknown> {
    this.probes.push(name)
    return {
      ok: true,
      toolNames: ['echo'],
      truncated: false,
      durationMs: 5,
      closeConfirmed: true,
    }
  }

  async restart(name: string): Promise<void> {
    this.restarts.push(name)
  }
}

/** One managed list: a configured server, a plugin-registered server and a
 *  retained cleanup record (the official `configured` flag only says which). */
function managedList(): unknown[] {
  return [
    { name: 'alpha', configured: true, status: { state: 'connected', toolCount: 2, connectedAt: 1 } },
    { name: 'beta', configured: true, status: { state: 'disabled' } },
    { name: 'gamma', configured: false, status: { state: 'failed', reason: 'cleanup', result: { closeConfirmed: false, cleanupError: 'close timeout' } } },
  ]
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly manager: FixtureManager
  /** Replace the controlled Host manager through the Direct service event. */
  readonly replaceManager: () => FixtureManager
  /** The LIVE embedded MCP page of the open Settings workspace, when mounted. */
  readonly embeddedMcpPage: () => EmbeddedSpecialistPage | undefined
  /** The LIVE Settings workspace root (the ONE pointer owner of the frame). */
  readonly settingsPanel: () => {
    onCellPress(x: number, y: number): void
    onCellClick(x: number, y: number): void
  } | undefined
  readonly settingsMutateCalls: string[]
  /** How many times the page re-read the official descriptor (readback). */
  readonly settingsDescribeCalls: () => number
  /** Hold the NEXT mutation in flight (deferred settlement). */
  holdSettingsMutation: () => () => void
  readonly invoke: (name: string, rawInput?: string) => Promise<unknown>
  readonly view: () => string
}

function setup(options: {
  readonly columns?: number
  readonly rows?: number
  readonly withManager?: boolean
  readonly inheritedAlpha?: boolean
  /** The alpha entry comes from the base layer with ONE base-owned env key. */
  readonly inheritedAlphaEnv?: boolean
  readonly settingsService?: SettingsServiceLike
} = {}): Harness {
  const ctx = new Context()
  const vt = new VirtualTerminal(options.columns ?? 100, options.rows ?? 30)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    runOwned: ((_label: string, task: () => unknown, owned: {
      onResult?: (value: unknown) => void
      onError?: (error: unknown) => void
    }) => {
      Promise.resolve().then(task).then(
        value => owned.onResult?.(value),
        error => owned.onError?.(error),
      )
    }) as never,
  })
  app.start()
  startedApps.add(app)
  const defs: Array<{ readonly name: string; readonly handler?: (invocation: { rawInput: string }) => unknown }> = []
  ctx.provide('commands', {
    register: (definition: { readonly name: string }) => { defs.push(definition as never); return () => {} },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  } as never)

  const manager = new FixtureManager(managedList())
  let currentManager = manager
  const serviceListeners = new Set<(name: string) => void>()
  const managerMounted = options.withManager !== false
  const settingsMutateCalls: string[] = []
  let settingsDescribeCalls = 0
  let settingsHold: Promise<void> | undefined
  let settingsRevision = 3
  const baseEnv = options.inheritedAlphaEnv === true ? { BASE_KEY: 'base' } : {}
  const alphaEntry = { transport: 'stdio', command: '/bin/echo', args: [], env: baseEnv, cwd: '', enabled: true }
  const settingsCtx = {
    get: (name: string): unknown => name === 'settings'
      ? {
          describe: () => {
            settingsDescribeCalls += 1
            if (options.settingsService !== undefined) return options.settingsService.describe()
            return [{
              ns: 'mcp-manager',
              value: { servers: { alpha: alphaEntry } },
              base: { servers: options.inheritedAlpha === true
                ? { alpha: { ...alphaEntry, command: '/bin/true' } }
                : options.inheritedAlphaEnv === true
                  ? { alpha: { ...alphaEntry } }
                  : {} },
              user: { servers: { alpha: alphaEntry } },
              revision: settingsRevision,
            }]
          },
          mutate: async (ns: string, ops: readonly SettingsMutationOp[], expectedRevision?: number) => {
            settingsMutateCalls.push(ns)
            if (options.settingsService !== undefined) {
              return options.settingsService.mutate(ns, ops, expectedRevision)
            }
            if (ops.length === 0) return
            if (settingsHold !== undefined) await settingsHold
            settingsRevision += 1
          },
        }
      : undefined,
  }
  // The REAL Direct adapters over the controlled Host services.
  const hostCtx: DirectMcpHostContextLike = {
    get: (name: string): unknown => (name === 'mcpManager' && managerMounted ? currentManager : undefined),
    on: ((event: string, listener: (name: string) => void) => {
      if (event !== 'internal/service') return () => {}
      serviceListeners.add(listener)
      return () => { serviceListeners.delete(listener) }
    }) as unknown as DirectMcpHostContextLike['on'],
  }
  const mcpServers = new DirectMcpServerPort(hostCtx)
  // The source read shares the manager's OWN generation, so the page can prove
  // the key set and the roster belong to the same Host authority.
  const mcpServerSources = new DirectMcpServerSourcesConfig(settingsCtx, () => mcpServers.currentGeneration())
  const mcpServerConfiguration = new DirectMcpServerConfigurationConfig(settingsCtx, () => mcpServers.currentGeneration())

  const fixture = createDirectSettingsFixture({ footer: 'default' })
  const settings = fixture.settings
  const base: Record<string, unknown> = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    ...sessionScopeFacts(() => undefined, () => 0),
    currentSessionId: undefined,
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    get defaultIntentOutcome() { return undefined },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: settings,
    agents: {} as never,
    sessionReader: {
      list: async () => [], search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined, sessionStatus: () => undefined,
    },
    sessionWriter: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    interaction: {
      questions: {
        subscribe: () => undefined, onRequest: () => true, snapshot: () => undefined,
        claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const,
      },
      onApprovalRequest: () => {},
    },
    catalog: { models: { available: () => false } } as never,
    config: settingsDirectPageConfig({
      configReadiness: () => 'ready' as const,
      mcpServerSources,
      mcpServerConfiguration,
      footerCustomItems: { rawForPersistence: () => ({ kind: 'detached' as const, value: [] }) },
      permissions: { presetNames: () => [], defaultPreset: () => undefined, approvalOverrideOf: () => undefined },
      subagentLimits: {
        read: () => ({ kind: 'unavailable' as const, reason: 'not mounted' }),
        refresh: async () => {},
        mutate: async () => ({ kind: 'rejected' as const, reason: 'not mounted' }),
      },
      subagentModelSelection: {
        read: () => ({ kind: 'unavailable' as const, reason: 'not mounted' }),
        refresh: async () => {},
        mutate: async () => ({ kind: 'rejected' as const, reason: 'not mounted' }),
      },
      web: { available: () => false },
      credentials: { available: () => false },
    }) as never,
    mcpServers,
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    cwd: '/ws', sessionCwd: () => '/ws', imageStore: {} as never,
    copyToClipboard: async () => true, imageLimits: () => undefined, insertIntoEditor: () => {},
    prepareDraftMessage: async (text: string) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    focusEnabled: () => false, setFocusMode: () => {},
    setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused',
    currentNotificationMethod: () => 'auto', setNotificationMethod: () => {},
    setTerminalProgressMode: () => {}, updateWelcomeCard: () => {},
    openJobView: () => {}, openTasksBrowser: () => {}, createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {}, requestExit: () => {}, extensions: undefined, exit: () => {},
    applyFooterSettings: () => {},
    backendKind: 'direct' as const,
    hostShellCompletion: { pathAuthority: 'client', complete: async () => ({ kind: 'ok', candidates: [] }) },
    forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
    subscribeSessionScopeInvalidation: () => () => {},
    listScopedCommands: () => [],
    recordExtensionError: () => {}, clearExtensionError: () => {},
  }
  const runner = new Proxy(base, {
    get: (target, property) => property in target ? target[property as string] : () => undefined,
  }) as unknown as TuiCommandRunner
  registerTuiCommandsWithDirectSeams(runner)
  return {
    vt,
    app,
    manager,
    replaceManager: () => {
      currentManager = new FixtureManager(managedList())
      for (const listener of [...serviceListeners]) listener('mcpManager')
      return currentManager
    },
    embeddedMcpPage: () => {
      const lease = (app as unknown as { workspaceLease?: { kind?: string; panel?: unknown } }).workspaceLease
      if (lease === undefined || lease.kind !== 'settings') return undefined
      const panel = lease.panel as { specialistPage?: EmbeddedSpecialistPage } | undefined
      return panel?.specialistPage
    },
    settingsPanel: () => {
      const lease = (app as unknown as { workspaceLease?: { kind?: string; panel?: unknown } }).workspaceLease
      if (lease === undefined || lease.kind !== 'settings') return undefined
      const panel = lease.panel as { onCellPress?: unknown; onCellClick?: unknown } | undefined
      if (panel?.onCellPress === undefined || panel.onCellClick === undefined) return undefined
      return panel as { onCellPress(x: number, y: number): void; onCellClick(x: number, y: number): void }
    },
    settingsMutateCalls,
    settingsDescribeCalls: () => settingsDescribeCalls,
    holdSettingsMutation: () => {
      let release!: () => void
      settingsHold = new Promise<void>(resolve => { release = resolve })
      return () => { settingsHold = undefined; release() }
    },
    invoke: async (name, rawInput = '') => {
      const definition = defs.find(candidate => candidate.name === name)
      assert.ok(definition?.handler !== undefined, `${name} must be registered`)
      return (definition.handler as (invocation: { rawInput: string }) => unknown)({ rawInput })
    },
    view: () => vt.getViewport().map(stripTerminalSequences).join('\n'),
  }
}

async function frames(vt: VirtualTerminal, count = 1): Promise<void> {
  for (let frame = 0; frame < count; frame += 1) await vt.waitForRender()
}

async function press(vt: VirtualTerminal, data: string): Promise<void> {
  vt.sendInput(data)
  await vt.waitForRender()
}

/** Flush the owned promise chain plus the watch/source turns. */
async function flushOwnedTurns(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

/** Walk the rail from About to Tools, then to the MCP row. The category walk
 *  uses the SHARED rail helper (it knows the narrow layout opens on the About
 *  content and that Esc returns to the rail), and the Rows cursor is
 *  LABEL-driven because the visible row count differs per frozen size. */
async function openMcpPage(h: Harness): Promise<void> {
  h.invoke('settings')
  await frames(h.vt)
  await flushOwnedTurns()
  await selectSettingsCategory(h.vt, 'Tools')
  await frames(h.vt)
  await press(h.vt, '\r')
  // The Rows column paints its cursor mid-line (`… > MCP servers  <summary>`),
  // so the row cursor is matched WITHOUT a line-start anchor.
  const mcpRow = (): boolean => /\S\s+> MCP servers\b/u.test(h.view())
  for (let step = 0; step < 10 && !mcpRow(); step += 1) await press(h.vt, '\x1b[B')
  assert.ok(mcpRow(), `the MCP servers row must be selectable at this size:\n${h.view()}`)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
}

/** The physical last row. */
function lastLine(h: Harness): string {
  const lines = h.vt.getViewport().map(stripTerminalSequences)
  return lines[lines.length - 1] ?? ''
}

test('the Tools row opens the same-lease MCP page with real source classification and no config write', async () => {
  const h = setup()
  await openMcpPage(h)
  const frame = h.view()
  assert.match(frame, /Settings · Tools · MCP servers/u, 'the breadcrumb names the page')
  assert.equal(frame.split('\n').filter(line => line.startsWith('Settings · ')).length, 1,
    'exactly ONE Settings chrome is painted')
  assert.match(frame, /alpha/u)
  assert.match(frame, /beta/u)
  assert.match(frame, /gamma/u)
  // The config-source verdict comes from the settings key set: `alpha` is
  // configured, `beta` is a LIVE entry the settings do not hold (Plugin-owned),
  // and `gamma` is a retained cleanup record. `configured:true` alone must never
  // be shown as Configured.
  const plain = frame.split('\n').map(line => line.trim())
  const alphaLine = plain.find(line => line.startsWith('▸ alpha') || line.startsWith('alpha')) ?? ''
  const betaLine = plain.find(line => line.includes('beta')) ?? ''
  const gammaLine = plain.find(line => line.includes('gamma')) ?? ''
  assert.match(alphaLine, /Configured/u)
  assert.match(betaLine, /Plugin-owned/u)
  assert.doesNotMatch(betaLine, /Configured/u)
  assert.match(gammaLine, /Retained\/removed/u)
  // A retained cleanup failure is its OWN fact, not hidden.
  assert.match(frame, /Failed \(cleanup\)/u)
  assert.match(lastLine(h), /Back \[Esc\]/u)
  assert.deepEqual(h.settingsMutateCalls, [], 'opening/observing never writes the profile')
})

test('Probe reaches the Host once and Esc cancels a restart that y executes exactly once', async () => {
  const h = setup()
  await openMcpPage(h)
  // Enter the detail view (compact single column at 100 columns).
  await press(h.vt, '\r')
  assert.match(h.view(), /Transport: Not exposed/u)
  await press(h.vt, 'p')
  await frames(h.vt)
  await flushOwnedTurns()
  await frames(h.vt)
  assert.deepEqual(h.manager.probes, ['alpha'], 'exactly one official probe of the selected server')
  assert.match(h.view(), /Probe passed/u)
  // Restart asks for the ONE explicit confirmation; Esc never dispatches.
  await press(h.vt, 'x')
  assert.match(h.view(), /Restart alpha\? Live tools may be interrupted/u)
  await press(h.vt, '\x1b')
  assert.deepEqual(h.manager.restarts, [], 'Esc must never dispatch a restart')
  // y executes EXACTLY one official restart; a resolved RPC is not "connected".
  await press(h.vt, 'x')
  await press(h.vt, 'y')
  await frames(h.vt)
  await flushOwnedTurns()
  await frames(h.vt)
  assert.deepEqual(h.manager.restarts, ['alpha'])
  assert.match(h.view(), /Restart settled · awaiting connected status/u)
  assert.doesNotMatch(h.view(), /Connected · awaiting/u)
  assert.deepEqual(h.settingsMutateCalls, [])
})

test('closing and reopening the page leaves ONE active watch and starts a new one', async () => {
  const h = setup()
  await openMcpPage(h)
  assert.equal(h.manager.activeWatches, 1, 'the open page owns exactly one watch')
  const firstSubscriptions = h.manager.watchSubscriptions
  // Back to the list, then Esc closes the page (the workspace stays open).
  await press(h.vt, '\r')
  await press(h.vt, '\x1b')
  await press(h.vt, '\x1b')
  await frames(h.vt)
  await flushOwnedTurns()
  await frames(h.vt)
  assert.equal(h.manager.activeWatches, 0, 'closing the page retires its watcher')
  assert.doesNotMatch(h.view(), /Server: alpha/u, 'the retried page closed, not the workspace')
  // Reopening the row starts a FRESH observation (never a stale listener).
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt)
  assert.equal(h.manager.activeWatches, 1, 'reopening starts exactly one watch')
  assert.equal(h.manager.watchSubscriptions, firstSubscriptions + 1)
  assert.match(h.view(), /alpha/u)
})

test('a Host without the MCP manager is a truthful unavailable, never an empty list', async () => {
  const h = setup({ withManager: false })
  await openMcpPage(h)
  const frame = h.view()
  assert.match(frame, /UNAVAILABLE · Host MCP Manager is not mounted/u)
  assert.doesNotMatch(frame, /No managed MCP servers/u, 'an unavailable Host must not claim an empty fleet')
  // No executable action is offered: Enter opens the (empty) detail, and p
  // dispatches nothing because the port has no authority.
  await press(h.vt, '\r')
  await press(h.vt, 'p')
  await flushOwnedTurns()
  assert.deepEqual(h.manager.probes, [])
  assert.match(lastLine(h), /Back \[Esc\]/u)
})

/* ------------------------------------------------------------------------- *
 * FR4 L6 — the mounted `Settings · Tools · MCP servers` configuration loop.
 *
 * Drives the REAL `/settings` command, the REAL SettingsWorkspacePanel, the
 * REAL McpServersController, the REAL McpServersPage and the REAL Direct
 * config adapter; only the Host `settings`/`mcpManager` service boundaries are
 * controlled fakes (their official contract shapes), never a pre-computed DTO.
 * ------------------------------------------------------------------------- */

test('the mounted Add -> Save -> descriptor journey writes the official namespace once', async () => {
  const h = setup()
  await openMcpPage(h)
  // The config-owned `alpha` is the first row; `a` opens the Add form on the
  // list. Search is not active, so `a` is a real page action.
  await press(h.vt, 'a')
  await frames(h.vt)
  assert.match(h.view(), /Identity/u, 'the same-lease configuration form is painted')
  assert.match(h.view(), /Name/u)
  // Fill the name, then the command (the first two focusable rows).
  await press(h.vt, '\r') // activate Name
  for (const char of 'fr4-added') await h.vt.sendInput(char)
  await press(h.vt, '\r') // commit Name
  // Transport is row 1; Enabled row 2; Command row 3.
  await press(h.vt, '\x1b[B')
  await press(h.vt, '\x1b[B')
  await press(h.vt, '\x1b[B')
  await press(h.vt, '\r') // activate Command
  for (const char of '/bin/sleep') await h.vt.sendInput(char)
  await press(h.vt, '\r') // commit Command
  assert.match(h.view(), /Unsaved changes/u)
  await press(h.vt, 's')
  await frames(h.vt)
  // The Save first asks for the external-capability acknowledgement (a stdio
  // entry runs a command); only `y` writes.
  assert.match(h.view(), /Enabling this server can execute an external command/u,
    'a stdio Save must disclose the external command it enables')
  assert.deepEqual(h.settingsMutateCalls, [], 'the question itself writes nothing')
  await press(h.vt, 'y')
  await frames(h.vt)
  await flushOwnedTurns()
  await frames(h.vt)
  assert.deepEqual(h.settingsMutateCalls, ['mcp-manager'], 'exactly ONE official settings mutation')
  assert.match(h.view(), /Saved · waiting for Host reconcile/u)
  assert.doesNotMatch(h.view(), /Connected ·/u, 'a saved config is not a connection claim')
})

test('dirty Esc in the mounted form shows the discard confirmation and writes nothing', async () => {
  const h = setup()
  await openMcpPage(h)
  await press(h.vt, 'a')
  await frames(h.vt)
  await press(h.vt, '\r')
  await h.vt.sendInput('z')
  await press(h.vt, '\r')
  await press(h.vt, '\x1b')
  await frames(h.vt)
  assert.match(h.view(), /Discard changes\?/u)
  // The bar offers Keep editing AND Discard to a pointer, both with Esc.
  assert.match(lastLine(h), /Keep editing · Discard · Esc/u)
  // Keep editing (Enter), then a second Esc and an explicit `d` discard.
  await press(h.vt, '\r')
  await press(h.vt, '\x1b')
  await press(h.vt, 'd')
  await frames(h.vt)
  await flushOwnedTurns()
  assert.deepEqual(h.settingsMutateCalls, [], 'a discarded draft performs zero writes')
  assert.match(lastLine(h), /Back \[Esc\]/u)
})

test('the mounted Detail keeps the FR3 p/x actions beside the new CRUD actions', async () => {
  const h = setup()
  await openMcpPage(h)
  await press(h.vt, '\r') // open Detail at the compact 100-column layout
  await frames(h.vt)
  await flushOwnedTurns()
  await press(h.vt, '\r') // focus the Detail region
  await frames(h.vt)
  const bar = lastLine(h)
  assert.match(bar, /p probe/u)
  assert.match(bar, /x restart/u)
  assert.match(bar, /e edit/u)
  assert.match(bar, /t (toggle|enable\/disable)/u)
  assert.match(bar, /d delete/u)
  // The saved transport now comes from the same configuration descriptor.
  assert.match(h.view(), /Saved transport: stdio/u)
})

/* ------------------------------------------------------------------------- *
 * FR4 G8 — the frozen visual matrix over the mounted page.
 *
 * The REAL `/settings` workspace, the REAL controller/page and the REAL Direct
 * config adapter are painted at every frozen size (design-language §11.2/§8 plus
 * the 44×8 floor). This proves the FORM's reachability and no-wrap contract in
 * a headless VirtualTerminal; physical terminal / palette / CJK acceptance is
 * recorded separately and is NOT claimed here.
 * ------------------------------------------------------------------------- */

const G8_SIZES = [[200, 50], [120, 40], [100, 40], [80, 24], [80, 10], [72, 24], [44, 20], [44, 8]] as const

test('the configuration form keeps its identity, current field and Save/Esc reachable at every frozen size', async () => {
  for (const [columns, rows] of G8_SIZES) {
    const h = setup({ columns, rows })
    await openMcpPage(h)
    // Reach the Add form through the list action (present only when current).
    await press(h.vt, 'a')
    await frames(h.vt, 2)
    await flushOwnedTurns()
    await frames(h.vt, 2)
    const lines = h.vt.getViewport().map(stripTerminalSequences)
    const frame = lines.join('\n')
    assert.match(frame, /Identity/u, `${String(columns)}x${String(rows)}: the form identity group is painted`)
    assert.match(frame, /Name/u, `${String(columns)}x${String(rows)}: the current field is painted`)
    assert.match(frame, /s Save/u, `${String(columns)}x${String(rows)}: Save is reachable`)
    assert.match(frame, /Back \[Esc\]/u, `${String(columns)}x${String(rows)}: the Esc affordance is complete`)
    assert.match(lastLine(h), /(s Save|Back \[Esc\])/u,
      `${String(columns)}x${String(rows)}: the physical last row is the Action Bar`)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= columns, `${String(columns)}x${String(rows)}: no line may exceed the frame: ${line}`)
    }
    assert.equal(lines.length, rows, `${String(columns)}x${String(rows)}: the page fills its exact grant`)
    h.app.dispose()
    startedApps.delete(h.app)
  }
})

test('the list and detail states stay truthful at the frozen sizes with one active signal per region', async () => {
  for (const [columns, rows] of G8_SIZES) {
    const h = setup({ columns, rows })
    await openMcpPage(h)
    const listLines = h.vt.getViewport().map(stripTerminalSequences)
    const listFrame = listLines.join('\n')
    assert.match(listFrame, /alpha/u, `${String(columns)}x${String(rows)}: the list paints the selected server`)
    assert.match(listFrame, /Back \[Esc\]/u, `${String(columns)}x${String(rows)}: the list keeps Esc`)
    // The list must paint EXACTLY ONE selected-row marker (an "at most one"
    // assertion would also pass when the marker disappeared entirely).
    assert.equal(listLines.filter(line => line.includes('▸')).length, 1,
      `${String(columns)}x${String(rows)}: exactly ONE selected-row marker`)
    for (const line of listLines) assert.ok(visibleWidth(line) <= columns)
    assert.equal(listLines.length, rows)
    h.app.dispose()
    startedApps.delete(h.app)
  }
})

test('the form never paints a row twice and never loses the page chrome', async () => {
  // Regression guard for a real-terminal torn frame: the physical frame must
  // carry the page breadcrumb exactly once and each form row exactly once.
  const h = setup({ columns: 80, rows: 24 })
  await openMcpPage(h)
  await press(h.vt, 'a')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  await press(h.vt, '\r')
  for (const char of '/bin/sleep') await h.vt.sendInput(char)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  const lines = h.vt.getViewport().map(stripTerminalSequences)
  const frame = lines.join('\n')
  assert.equal(frame.split('Settings · Tools · MCP servers').length - 1, 1,
    `exactly ONE breadcrumb:\n${frame}`)
  for (const label of ['Name:', 'Transport:', 'Enabled:', 'Command:', 'Working dir:']) {
    assert.equal(frame.split(label).length - 1, 1, `${label} must be painted exactly once:\n${frame}`)
  }
  assert.equal(lines.length, 24)
  h.app.dispose()
  startedApps.delete(h.app)
})

test('Esc during an unsettled Save never offers a Discard that would imply cancellation', async () => {
  const h = setup()
  await openMcpPage(h)
  // A valid draft: Add a name and a command.
  await press(h.vt, 'a')
  await frames(h.vt, 2)
  await press(h.vt, '\r')
  for (const char of 'held-save') await h.vt.sendInput(char)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  for (let step = 0; step < 6; step += 1) {
    const focused = /▸ ([^:\n]+):/u.exec(h.view())
    if (focused !== null && (focused[1] ?? '').trim().startsWith('Command')) break
    await press(h.vt, '\x1b[B')
  }
  await press(h.vt, '\r')
  for (const char of '/bin/sleep') await h.vt.sendInput(char)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  // Ask to save and answer the disclosure: the mutation is now DISPATCHED but
  // the fixture holds it, so the page is really in the unsettled window.
  const release = h.holdSettingsMutation()
  await press(h.vt, 's')
  await frames(h.vt)
  assert.match(h.view(), /Enabling this server can execute an external command/u)
  await press(h.vt, 'y')
  await frames(h.vt, 3)
  // The write is in flight: the page says it is saving and offers no discard.
  assert.match(h.view(), /Saving configuration/u)
  assert.doesNotMatch(h.view(), /Discard changes\?/u)
  // Esc now must NOT open a discard prompt, and `d` must not drop the draft.
  await press(h.vt, '\x1b')
  await frames(h.vt, 2)
  assert.doesNotMatch(h.view(), /Discard changes\?/u,
    'a dispatched write must never offer a Discard prompt')
  assert.match(h.view(), /cannot be cancelled here/u,
    'the page states the write cannot be cancelled')
  await press(h.vt, 'd')
  await frames(h.vt, 2)
  assert.match(h.view(), /Saving configuration/u, 'the draft/write stays alive after `d`')
  assert.equal(h.settingsMutateCalls.length, 1, 'exactly ONE dispatched mutation')
  // Release the Host: the write settles and the form closes.
  release()
  await frames(h.vt, 3)
  await flushOwnedTurns()
  await frames(h.vt, 3)
  assert.match(h.view(), /Saved · waiting for Host reconcile/u)
  assert.equal(h.settingsMutateCalls.length, 1, 'no replay after settlement')
})

test('the Settings ROOT drives a real pointer click into the MCP page (and refuses a stale one)', async () => {
  const h = setup()
  await openMcpPage(h)
  const panel = h.settingsPanel()
  assert.ok(panel !== undefined, 'the Settings workspace root must be live')

  // The row/column come from the ACTUAL painted frame — the same cells the user
  // clicks. The Root resolves them against its own last-painted hit map.
  const locate = (label: string): { row: number; col: number } => {
    const lines = h.vt.getViewport().map(stripTerminalSequences)
    const row = lines.findIndex(line => line.includes(label))
    assert.ok(row >= 0, `missing ${label} in the painted frame:\n${lines.join('\n')}`)
    return { row, col: lines[row]!.indexOf(label) + 1 }
  }

  // 1) POSITIVE: Root press + release on the painted `a Add` opens the form.
  const add = locate('a Add')
  const before = h.view()
  panel.onCellPress(add.col, add.row)
  panel.onCellClick(add.col, add.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.notEqual(h.view(), before, 'the Root click must reach the page intent')
  assert.match(h.view(), /Identity/u, 'the Root click opened the configuration form')
  assert.deepEqual(h.settingsMutateCalls, [], 'a navigation intent never writes')

  // 2) NEGATIVE (stale gesture): a press whose frame repaints before the
  //    release must not activate anything — the Root revokes the gesture.
  // Leave the form: Esc asks to discard, `d` drops the untouched draft.
  await press(h.vt, '\x1b')
  await frames(h.vt, 2)
  await press(h.vt, 'd')
  await frames(h.vt, 2)
  // Dropping the draft returns to the Detail; the LIST is one Esc further back.
  await press(h.vt, '\x1b')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  const again = locate('a Add')
  panel.onCellPress(again.col, again.row)
  await press(h.vt, '\x1b[B') // repaint between press and release
  await frames(h.vt, 2)
  const stale = h.view()
  panel.onCellClick(again.col, again.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.equal(h.view(), stale, 'a stale release must not reach any page intent')
  assert.deepEqual(h.settingsMutateCalls, [], 'a refused gesture never writes')
})

test('a y that arrives inside the render window never commits an unpainted Save', async () => {
  const h = setup()
  await openMcpPage(h)
  // A valid draft: Add, name it, set a command.
  await press(h.vt, 'a')
  await frames(h.vt, 2)
  await press(h.vt, '\r')
  for (const char of 'window-save') await h.vt.sendInput(char)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  for (let step = 0; step < 6; step += 1) {
    const focused = /▸ ([^:\n]+):/u.exec(h.view())
    if (focused !== null && (focused[1] ?? '').trim().startsWith('Command')) break
    await press(h.vt, '\x1b[B')
  }
  await press(h.vt, '\r')
  for (const char of '/bin/sleep') await h.vt.sendInput(char)
  await press(h.vt, '\r')
  await frames(h.vt, 2)

  // `s` opens the question and `y` answers it BEFORE the question frame paints:
  // the answer must be refused, so no Host mutation happens.
  h.vt.sendInput('s')
  h.vt.sendInput('y')
  await frames(h.vt, 3)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.deepEqual(h.settingsMutateCalls, [], 'an unpainted question must never dispatch a write')
  // The question is still open and now painted: the answer is accepted.
  assert.match(h.view(), /can execute an external command/u)
  await press(h.vt, 'y')
  await frames(h.vt, 3)
  await flushOwnedTurns()
  await frames(h.vt, 3)
  assert.equal(h.settingsMutateCalls.length, 1, 'the painted question dispatches exactly one write')
})

test('Root pointer Save and Confirm persist through official SettingsForms and read back the profile', async t => {
  const life = testLifecycle(t)
  const root = life.tempDir('mcp-mouse-profile-')
  const profileDir = join(root, 'profile')
  const bundleDir = join(root, 'mcp-bundle')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const require = createRequire(import.meta.url)
  const anchor = join(process.cwd(), 'package.json')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(bundleDir)
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'mcp-mouse-profile', private: true,
    dsh: { profile: { bundles: ['mcp-mouse-bundle'], patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: 'mcp-mouse-bundle', version: '0.0.0', private: true,
    dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
  }))
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), `- insert:\n    - id: mcp-manager\n      name: ${JSON.stringify(require.resolve('@deepseek-ai/dsh-mcp-manager'))}\n      config:\n        servers: {}\n`)
  symlinkSync(bundleDir, join(profileDir, 'node_modules', 'mcp-mouse-bundle'), 'dir')
  writeFileSync(patchPath, '[]\n')
  const host = new Context()
  life.defer(() => host.fiber.dispose())
  host.provide('tools', { register: () => () => {}, unregister: () => {} } as never)
  host.provide('credentials', { get: () => undefined } as never)
  await host.plugin(Loader)
  host.provide('profileContext', {
    name: 'mcp-mouse-profile', dir: profileDir, patchPath, installAnchor: anchor,
    cwd: root, home: root, startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  } as never)
  await host.plugin(ConfigEditor)
  await host.plugin(SettingsForms)
  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  await mountRootInclude(host, patchPath,
    [...profile.layers.flatMap(layer => layer.patches), ...profile.patches], pathToFileURL(anchor).href, 'dsh')
  await host.loader.await()
  const settingsService = host.get('settings') as SettingsServiceLike
  const before = settingsService.describe()!.find(row => row.ns === 'mcp-manager')!
  const h = setup({ settingsService })
  life.defer(() => h.app.dispose())
  await openMcpPage(h)
  assert.ok(h.settingsPanel() !== undefined, 'the Settings workspace root must be live')
  /**
   * One REAL SGR click on the painted cell of `label`. `wordOffset` picks a
   * different word of the same span: the fork treats a rapid same-word repeat
   * as a double-click word selection, which withholds the host cell click.
   */
  const click = async (label: string, wordOffset = 0): Promise<void> => {
    const lines = h.vt.getViewport().map(stripTerminalSequences)
    const row = lines.findIndex(line => line.includes(label))
    assert.ok(row >= 0, `missing ${label} in the painted frame:\n${lines.join('\n')}`)
    const col = lines[row]!.indexOf(label) + wordOffset
    sgrMouse(h, 'press', col, row)
    sgrMouse(h, 'release', col, row)
    await frames(h.vt, 2)
    await flushOwnedTurns()
    await frames(h.vt, 2)
  }

  // 1) A real SGR click on `a Add` opens the form (needed to build a draft).
  await click('a Add')
  assert.match(h.view(), /Identity/u)
  // Text still arrives through the normal keyboard input; opening, applying,
  // saving and confirming all travel through the real SGR pointer cells.
  await click('Name:')
  for (const char of 'mouse-save') h.vt.sendInput(char)
  await frames(h.vt)
  await click('Enter apply')
  await click('Command:')
  for (const char of '/bin/sleep') h.vt.sendInput(char)
  await frames(h.vt)
  await click('Enter apply', 6)
  // 2) A draft argument row that is REMOVED by pointer before the Save: the
  // removed row must never reach the official namespace.
  await click('Arguments:')
  assert.equal(embeddedController(h).snapshot().editor?.args.length, 1)
  await click('Arg 1:')
  for (const char of '--keepme') h.vt.sendInput(char)
  await frames(h.vt)
  await click('Enter apply')
  await click('Arguments:', 11)
  assert.equal(embeddedController(h).snapshot().editor?.args.length, 2)
  await click('Arg 2:')
  for (const char of '--dropme') h.vt.sendInput(char)
  await frames(h.vt)
  await click('Enter apply', 6)
  assert.match(h.view(), /Remove \[Backspace\]/u, 'the focused removable row offers Remove')
  await click('Remove [Backspace]')
  assert.deepEqual(embeddedController(h).snapshot().editor?.args, ['--keepme'],
    'the removed argument row left the draft')
  await click('Enabled:') // toggle it off, so this fixture starts no process
  assert.match(h.view(), /Enabled: no/u)

  // 3) A real SGR click on `s Save` opens the visible question with its facts.
  await click('s Save')
  assert.match(h.view(), /can execute an external command/u, 'the question paints its safety fact')
  assert.match(h.view(), /Y confirm/u, 'the question offers the decision')
  assert.deepEqual(settingsService.describe()!.find(row => row.ns === 'mcp-manager')!.value, before.value,
    'asking the question does not mutate the official namespace')

  // 4) A real SGR click on `Y confirm` dispatches ONE official mutation…
  assert.deepEqual(h.settingsMutateCalls, [])
  await click('Y confirm')
  assert.deepEqual(h.settingsMutateCalls, ['mcp-manager'])
  assert.match(h.view(), /Saved · waiting for Host reconcile|Saved/u,
    `the saved verdict comes from the re-read descriptor: ${h.view()}`)
  const after = settingsService.describe()!.find(row => row.ns === 'mcp-manager')!
  assert.ok(after.revision! > before.revision!, 'the official namespace revision advanced')
  const servers = (after.value as { servers: Record<string, { command: string; enabled: boolean; args: string[] }> }).servers
  assert.equal(servers['mouse-save']!.command, '/bin/sleep')
  assert.equal(servers['mouse-save']!.enabled, false)
  assert.deepEqual(servers['mouse-save']!.args, ['--keepme'],
    'only the surviving draft argument reached the official namespace')
  const patch = readFileSync(patchPath, 'utf8')
  assert.match(patch, /mouse-save/u, 'ConfigEditor persisted the profile patch')
  assert.match(patch, /--keepme/u, 'the surviving argument was persisted')
  assert.doesNotMatch(patch, /--dropme/u, 'the removed argument never reached the patch')
  const controller = (h.embeddedMcpPage() as unknown as { controller: McpServersController }).controller
  const config = controller.snapshot().config!
  assert.equal(config.kind, 'ready')
  if (config.kind !== 'ready') assert.fail('the page must hold the official committed descriptor')
  assert.equal(config.revision, after.revision)
  const saved = config.entries.find(entry => entry.name === 'mouse-save')?.effective
  assert.equal(saved?.command, '/bin/sleep')
  assert.deepEqual(saved?.args, ['--keepme'], 'the readback matches the persisted draft')
})

test('a replacement manager cannot reuse the painted admission of an identical toggle question', async t => {
  const h = setup()
  await openMcpPage(h)
  await press(h.vt, '\r')
  await press(h.vt, 't')
  assert.match(h.view(), /Disable server alpha/u)
  const page = h.embeddedMcpPage()!
  const controller = (page as unknown as { controller: McpServersController }).controller
  const questionA = controller.snapshot().configConfirm!
  const configA = controller.snapshot().config!
  assert.equal(configA.kind, 'ready')

  // Hold only this production-created consumer's paint. Root input routing and
  // controller/Direct service events still run; the old question stays on screen.
  const render = page.render
  const oldFrame = render.call(page, h.vt.columns)
  page.render = () => oldFrame
  t.after(() => { page.render = render })

  const managerB = h.replaceManager()
  await flushOwnedTurns()
  assert.equal(controller.snapshot().configConfirm, undefined, 'A question retired on the real service event')
  h.vt.sendInput('r')
  await flushOwnedTurns()
  const configB = controller.snapshot().config!
  assert.equal(configB.kind, 'ready', 'B descriptor is current before asking a new question')
  if (configA.kind !== 'ready' || configB.kind !== 'ready') assert.fail('both descriptors must be ready')
  assert.notEqual(configA.generation, configB.generation)
  assert.equal(configA.revision, configB.revision, 'same revision is deliberate')
  h.vt.sendInput('t')
  const questionB = controller.snapshot().configConfirm!
  assert.equal(questionB.kind, questionA.kind)
  assert.equal(questionB.name, questionA.name)
  assert.equal(questionB.capturedRevision, questionA.capturedRevision)
  assert.notEqual(questionB.question, questionA.question, 'a replacement question is a fresh instance')

  // B has not painted. The old admitted A facts must authorise neither key nor
  // the Root's old Confirm cells, even though name/revision/consequence match.
  h.vt.sendInput('y')
  const lines = h.vt.getViewport().map(stripTerminalSequences)
  const row = lines.findIndex(line => line.includes('Y confirm'))
  assert.ok(row >= 0)
  const col = lines[row]!.indexOf('Y confirm') + 1
  const root = h.settingsPanel()!
  root.onCellPress(col, row)
  root.onCellClick(col, row)
  await flushOwnedTurns()
  assert.deepEqual(h.settingsMutateCalls, [])
  assert.equal(controller.snapshot().configConfirm?.question, questionB.question, 'B question still awaits review')
  assert.deepEqual(managerB.restarts, [])

  // Release paint. The same question becomes executable only after its facts
  // actually land in the Settings frame.
  page.render = render
  h.app.requestRender()
  await frames(h.vt, 2)
  assert.match(h.view(), /Disable server alpha/u)
  await press(h.vt, 'y')
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.deepEqual(h.settingsMutateCalls, ['mcp-manager'])
})

test('a discard reopened before repaint cannot reuse its previous admitted prompt', async () => {
  const h = setup()
  await openMcpPage(h)
  await press(h.vt, 'a')
  await press(h.vt, '\x1b')
  assert.match(h.view(), /Discard changes\?/u)
  const page = h.embeddedMcpPage()!
  const controller = (page as unknown as { controller: McpServersController }).controller
  const original = controller.snapshot().editor
  assert.ok(original !== undefined)
  // Keep editing, reopen, answer — synchronously, with no frame in between.
  h.vt.sendInput('\x1b')
  h.vt.sendInput('\x1b')
  h.vt.sendInput('d')
  assert.ok(controller.snapshot().editor !== undefined, 'the newly opened prompt has not been reviewed')
  assert.deepEqual(h.settingsMutateCalls, [])
  await frames(h.vt, 2)
  assert.match(h.view(), /Discard changes\?/u)
  await press(h.vt, 'd')
  assert.equal(controller.snapshot().editor, undefined, 'the freshly painted prompt may discard')
})

test('each Detail operation refuses an unpainted answer and accepts a freshly painted question', async t => {
  for (const key of ['t', 'd', 'u', 'x']) {
    await t.test(key, async () => {
      const h = setup({ inheritedAlpha: key === 'u' })
      await openMcpPage(h)
      await press(h.vt, '\r')
      h.vt.sendInput(key)
      h.vt.sendInput('y')
      await flushOwnedTurns()
      assert.deepEqual(h.settingsMutateCalls, [], 'no configuration write before the question paints')
      assert.deepEqual(h.manager.restarts, [], 'no restart before the question paints')
      await frames(h.vt, 2)
      assert.match(lastLine(h), /Y confirm/u)
      await press(h.vt, 'y')
      await flushOwnedTurns()
      if (key === 'x') assert.deepEqual(h.manager.restarts, ['alpha'])
      else assert.deepEqual(h.settingsMutateCalls, ['mcp-manager'])
    })
  }
})

test('a Settings frame with zero body rows removes Confirm and refuses its answer until resized', async () => {
  const h = setup()
  await openMcpPage(h)
  await press(h.vt, '\r')
  await press(h.vt, 't')
  assert.match(h.view(), /Disable server alpha/u)
  h.vt.resize(200, 2)
  await frames(h.vt, 2)
  assert.equal(h.vt.getViewport().length, 2)
  assert.doesNotMatch(h.view(), /Disable server alpha/u, 'Root painted no confirmation body')
  assert.match(lastLine(h), /Resize to review/u)
  assert.doesNotMatch(lastLine(h), /Y confirm/u)
  await press(h.vt, 'y')
  await flushOwnedTurns()
  assert.deepEqual(h.settingsMutateCalls, [])
  h.vt.resize(100, 30)
  await frames(h.vt, 2)
  assert.match(h.view(), /Disable server alpha/u)
  await press(h.vt, 'y')
  await flushOwnedTurns()
  assert.deepEqual(h.settingsMutateCalls, ['mcp-manager'])
})

test('zero-row Settings grants refuse every detail confirmation, including Restart', async t => {
  for (const key of ['t', 'd', 'u', 'x']) {
    await t.test(key, async () => {
      const h = setup({ inheritedAlpha: key === 'u' })
      await openMcpPage(h)
      await press(h.vt, '\r')
      await press(h.vt, key)
      await frames(h.vt, 2)
      h.vt.resize(200, 2)
      await frames(h.vt, 2)
      assert.doesNotMatch(h.view(), /Y confirm/u, 'zero body rows paint no affirmative action')
      assert.match(lastLine(h), /Resize to review/u)
      await press(h.vt, 'y')
      await flushOwnedTurns()
      assert.deepEqual(h.settingsMutateCalls, [], 'no configuration confirmation can dispatch')
      assert.deepEqual(h.manager.restarts, [], 'no restart can dispatch')
    })
  }
})

test('a zero-row discard body refuses `d` and preserves the draft', async () => {
  const h = setup()
  await openMcpPage(h)
  await press(h.vt, 'a')
  await press(h.vt, '\x1b')
  assert.match(h.view(), /nothing has been written yet/u)
  h.vt.resize(200, 2)
  await frames(h.vt, 2)
  assert.doesNotMatch(h.view(), /Y confirm|Discard \\[d\\]/u)
  assert.match(lastLine(h), /Resize to review/u)
  await press(h.vt, 'd')
  await flushOwnedTurns()
  const page = h.embeddedMcpPage()!
  const controller = (page as unknown as { controller: McpServersController }).controller
  assert.ok(controller.snapshot().editor !== undefined, 'the refused answer keeps the draft')
  assert.deepEqual(h.settingsMutateCalls, [])
})

/* ------------------------------------------------------------------------- *
 * PR-D pointer journeys over the REAL AltScreen event producer.
 *
 * Every case drives `vt.sendInput('\x1b[<…M' / '…m')` so the SGR parser, the
 * Settings Root physical last-row owner, the per-open Controller and the Direct
 * adapters all run; `settingsPanel().onCellPress/onCellClick` is never the
 * evidence here.
 * ------------------------------------------------------------------------- */

/** Send one real SGR left press/release at a 0-based viewport cell. */
function sgrMouse(h: Harness, kind: 'press' | 'release', col: number, row: number): void {
  h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}${kind === 'press' ? 'M' : 'm'}`)
}

/** Send one real SGR wheel at a 0-based viewport cell. */
function sgrWheel(h: Harness, direction: 'up' | 'down', col: number, row: number): void {
  h.vt.sendInput(`\x1b[<${direction === 'up' ? 64 : 65};${col + 1};${row + 1}M`)
}

/** Locate the first painted cell of `label` (0-based). */
function locateCell(h: Harness, label: string): { readonly row: number; readonly col: number } {
  const lines = h.vt.getViewport().map(stripTerminalSequences)
  const row = lines.findIndex(line => line.includes(label))
  assert.ok(row >= 0, `missing ${label} in the painted frame:\n${lines.join('\n')}`)
  return { row, col: lines[row]!.indexOf(label) }
}

/** One complete real SGR click on the painted cell of `label`. */
async function sgrClick(h: Harness, label: string): Promise<void> {
  const cell = locateCell(h, label)
  sgrMouse(h, 'press', cell.col, cell.row)
  sgrMouse(h, 'release', cell.col, cell.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
}

/** Wheel one step over a painted editor body row (the shared Settings chrome
 *  occupies the rows above the specialist box at short grants). */
async function wheelBody(h: Harness, direction: 'up' | 'down'): Promise<void> {
  const lines = h.vt.getViewport().map(stripTerminalSequences)
  const row = lines.findIndex(line => /▸ [^:\n]*:/u.test(line))
  assert.ok(row >= 0, `the editor body must be painted:\n${lines.join('\n')}`)
  sgrWheel(h, direction, 2, row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
}

/** The LIVE per-open controller of the mounted MCP page. */
function embeddedController(h: Harness): McpServersController {
  const page = h.embeddedMcpPage()
  assert.ok(page !== undefined, 'the MCP page must be mounted')
  return (page as unknown as { controller: McpServersController }).controller
}

/** The label the frame paints as the focused form row. */
function focusedLabel(h: Harness): string {
  const match = /▸ ([^:\n]+):/u.exec(h.view())
  assert.ok(match !== null, `no focused form row is painted:\n${h.view()}`)
  return (match[1] ?? '').trim()
}

test('a real SGR pointer journey completes the MCP search with zero Host writes', async () => {
  const h = setup()
  await openMcpPage(h)
  // 1) The painted `Search [/]` is a real pointer target for the `/` sink.
  await sgrClick(h, 'Search [/]')
  assert.match(h.view(), /search: \//u, 'the Search click opened the same search input')
  // 2) The query itself is keyboard text (never a mouse capability).
  await press(h.vt, 'a')
  assert.match(h.view(), /search: \/ a/u)
  // 3) A filtered result row click ONLY selects: the query stays, no intent runs.
  const betaRow = h.vt.getViewport().map(stripTerminalSequences).findIndex(line => line.includes('beta'))
  assert.ok(betaRow >= 0)
  sgrMouse(h, 'press', 1, betaRow)
  sgrMouse(h, 'release', 1, betaRow)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.match(h.view(), /▸ beta/u, 'the clicked result row is the selection')
  assert.match(h.view(), /search: \/ a/u, 'the search input and query stay open')
  // 4) `Done [Enter]` finishes through the SAME Enter commit.
  await sgrClick(h, 'Done [Enter]')
  assert.doesNotMatch(h.view(), /search: \//u, 'Done returned to the list')
  assert.match(h.view(), /▸ beta/u)
  // 5) The existing list/detail journey still works by pointer.
  await sgrClick(h, 'Enter details')
  assert.match(h.view(), /Server: beta/u)
  await sgrClick(h, 'Back [Esc]')
  assert.match(h.view(), /Search \[\/\]/u)
  assert.doesNotMatch(h.view(), /Server: beta/u)
  assert.deepEqual(h.manager.probes, [], 'search never probes')
  assert.deepEqual(h.manager.restarts, [], 'search never restarts')
  assert.deepEqual(h.settingsMutateCalls, [], 'search never writes the profile')
})

test('the Root Cancel [Esc] cancels only the search, and a held Done never survives a query edit', async () => {
  const h = setup()
  await openMcpPage(h)
  await sgrClick(h, 'Search [/]')
  await press(h.vt, 'b')
  assert.match(h.view(), /search: \/ b/u)
  // A held Done press whose query changed before the release never completes.
  const done = locateCell(h, 'Done [Enter]')
  sgrMouse(h, 'press', done.col, done.row)
  h.vt.sendInput('x')
  sgrMouse(h, 'release', done.col, done.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.match(h.view(), /search: \/ bx/u, 'the stale Done did not finish the search')
  // The ONE physical Root escape cancels the search only.
  await sgrClick(h, 'Cancel [Esc]')
  const after = h.view()
  assert.doesNotMatch(after, /search: /u, 'the query is cleared')
  assert.match(after, /Settings · Tools · MCP servers/u, 'the MCP page is still open')
  assert.match(after, /alpha/u, 'the unfiltered list is back')
  assert.deepEqual(h.settingsMutateCalls, [])
  assert.deepEqual(h.manager.probes, [])
})

test('a held probe press never completes against a replacement Host with the same roster', async () => {
  const h = setup()
  await openMcpPage(h)
  await press(h.vt, '\r') // the detail view hosts `p probe`
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  const probe = locateCell(h, 'p probe')
  sgrMouse(h, 'press', probe.col, probe.row)
  // Host B replaces Host A with the SAME names/statuses/count and selection.
  const managerB = h.replaceManager()
  await flushOwnedTurns()
  // Observe the new authority through the production controller method the `r`
  // key runs — WITHOUT a keyboard event, which the Root would use to revoke
  // every pointer owner and thereby mask the epoch fence under test.
  embeddedController(h).refresh()
  await flushOwnedTurns()
  await frames(h.vt, 2)
  sgrMouse(h, 'release', probe.col, probe.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.deepEqual(h.manager.probes, [], 'the pressed Host A was never probed')
  assert.deepEqual(managerB.probes, [], 'the stale release never probed Host B')
  // POSITIVE control: a fresh painted gesture on the SAME span (a different
  // word cell, because the alt screen treats a same-word rapid repeat as a
  // double-click word selection) operates B exactly once.
  const freshProbe = locateCell(h, 'p probe')
  sgrMouse(h, 'press', freshProbe.col + 2, freshProbe.row)
  sgrMouse(h, 'release', freshProbe.col + 2, freshProbe.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.deepEqual(managerB.probes, ['alpha'], 'a fresh gesture on B probes exactly once')
  assert.deepEqual(h.manager.probes, [])
})

test('a settled configuration read between press and release refuses the old action press', async () => {
  const h = setup()
  await openMcpPage(h)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  const controller = embeddedController(h)
  // Start ONE official toggle write and hold it: the page is `saving` and the
  // fixture emits NO roster frame while it settles.
  await press(h.vt, 't')
  assert.match(h.view(), /Disable server alpha/u)
  const releaseWrite = h.holdSettingsMutation()
  await press(h.vt, 'y')
  await frames(h.vt, 3)
  assert.equal(controller.snapshot().configStatus?.kind, 'saving', 'the write is unsettled')
  assert.doesNotMatch(h.view(), /e edit/u, 'an unsettled write removes the CRUD affordances')
  const probe = locateCell(h, 'p probe')
  sgrMouse(h, 'press', probe.col, probe.row)
  // The write settles: the saved readback moves the configuration revision and
  // read epoch with the SAME roster observation.
  releaseWrite()
  await frames(h.vt, 3)
  await flushOwnedTurns()
  await frames(h.vt, 3)
  sgrMouse(h, 'release', probe.col, probe.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.deepEqual(h.manager.probes, [],
    'the press from the previous configuration read never probed')
  // A fresh painted press (the `probe` word cell: a same-word rapid repeat is a
  // double-click word selection) probes exactly once.
  const freshProbe = locateCell(h, 'p probe')
  sgrMouse(h, 'press', freshProbe.col + 2, freshProbe.row)
  sgrMouse(h, 'release', freshProbe.col + 2, freshProbe.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.deepEqual(h.manager.probes, ['alpha'], 'a fresh gesture on the current read probes once')
  assert.deepEqual(h.settingsMutateCalls, ['mcp-manager'], 'only the held toggle write reached the Host')
})

test('the mounted editor wheel and Remove stay Client-local and the Save still uses the official namespace once', async () => {
  const h = setup()
  await openMcpPage(h)
  const controller = embeddedController(h)
  await sgrClick(h, 'a Add')
  assert.match(h.view(), /Identity/u)
  // Text is keyboard input; opening and applying the field are pointer cells.
  await sgrClick(h, 'Name:')
  for (const char of 'mouse-remove') await h.vt.sendInput(char)
  await frames(h.vt)
  await sgrClick(h, 'Enter apply')
  await sgrClick(h, 'Command:')
  for (const char of '/bin/sleep') await h.vt.sendInput(char)
  await frames(h.vt)
  await sgrClick(h, 'Enter apply')
  // `+ Add argument` inserts a draft row and focuses it.
  await sgrClick(h, 'Arguments:')
  assert.equal(controller.snapshot().editor?.args.length, 1)
  assert.match(h.view(), /Remove \[Backspace\]/u, 'the focused removable row advertises Remove')
  // The wheel moves ONLY the form focus: the hidden list selection stays put.
  const selection = controller.snapshot().selectedName
  const before = focusedLabel(h)
  const transportRow = locateCell(h, 'Transport:').row
  sgrWheel(h, 'down', 2, transportRow)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  assert.notEqual(focusedLabel(h), before, 'the wheel advanced the form focus')
  assert.doesNotMatch(h.view(), /Remove \[Backspace\]/u, 'a non-removable row offers no Remove')
  assert.equal(controller.snapshot().selectedName, selection, 'the hidden list selection never moves')
  sgrWheel(h, 'up', 2, transportRow)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  assert.match(h.view(), /Remove \[Backspace\]/u, 'the removable row offers Remove again')
  // Removing is Client-local: the draft shrinks and no Host write runs.
  await sgrClick(h, 'Remove [Backspace]')
  assert.equal(controller.snapshot().editor?.args.length, 0, 'only that draft row is removed')
  assert.equal(controller.snapshot().editor?.name, 'mouse-remove', 'the rest of the draft is intact')
  assert.deepEqual(h.settingsMutateCalls, [], 'the local removal writes nothing')
  // Save + Y still travel through the ONE official settings mutation.
  await sgrClick(h, 's Save')
  assert.match(h.view(), /can execute an external command/u)
  await sgrClick(h, 'Y confirm')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.deepEqual(h.settingsMutateCalls, ['mcp-manager'], 'exactly one official mutation')
  assert.match(h.view(), /Saved/u)
})

test('the wide editor wheel moves the form focus without selecting the hidden list row', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openMcpPage(h)
  const controller = embeddedController(h)
  await sgrClick(h, 'a Add')
  const selection = controller.snapshot().selectedName
  const first = focusedLabel(h)
  // The LEFT region (where the list column would live) and the RIGHT region
  // both move the FORM focus only.
  sgrWheel(h, 'down', 4, locateCell(h, 'Transport:').row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  const afterLeft = focusedLabel(h)
  assert.notEqual(afterLeft, first, 'the left-region wheel advanced the form focus')
  sgrWheel(h, 'down', 110, locateCell(h, 'Transport:').row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  assert.notEqual(focusedLabel(h), afterLeft, 'the right-region wheel advanced the form focus')
  assert.equal(controller.snapshot().selectedName, selection, 'the hidden list selection never moves')
})

test('an inherited env key paints no Remove while the user-added key beside it removes alone', async () => {
  const h = setup({ inheritedAlphaEnv: true })
  await openMcpPage(h)
  const controller = embeddedController(h)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await sgrClick(h, 'e edit')
  assert.match(h.view(), /Inherited · cannot remove here/u)
  // Add a user-owned env key through its own row.
  await sgrClick(h, 'Env:')
  assert.equal(controller.snapshot().editor?.env.length, 2, 'the draft has the base key plus the new one')
  // Walk the focus until the BASE-owned key row is focused: no Remove paints.
  for (let step = 0; step < 20 && !/▸ Env key: BASE_KEY · Inherited/u.test(h.view()); step += 1) {
    sgrWheel(h, 'down', 2, locateCell(h, 'Transport:').row)
    await frames(h.vt, 2)
    await flushOwnedTurns()
  }
  assert.match(h.view(), /▸ Env key: BASE_KEY · Inherited/u)
  assert.doesNotMatch(h.view(), /Remove \[Backspace\]/u, 'the inherited key never offers Remove')
  // Walk to the user-added key: Remove paints and deletes ONLY it.
  for (let step = 0; step < 20 && !/▸ Env key: KEY_2/u.test(h.view()); step += 1) {
    sgrWheel(h, 'down', 2, locateCell(h, 'Transport:').row)
    await frames(h.vt, 2)
    await flushOwnedTurns()
  }
  assert.match(h.view(), /▸ Env key: KEY_2/u)
  assert.match(h.view(), /Remove \[Backspace\]/u)
  await sgrClick(h, 'Remove [Backspace]')
  const env = controller.snapshot().editor?.env ?? []
  assert.deepEqual(env.map(entry => entry.key), ['BASE_KEY'], 'only the user-added key was removed')
  assert.deepEqual(h.settingsMutateCalls, [])
})

test('consecutive search keystrokes before the next frame are never dropped', async () => {
  const h = setup()
  await openMcpPage(h)
  await sgrClick(h, 'Search [/]')
  // A burst between two frames: every character must reach the query (a
  // pointer revocation may never gate the search's keyboard input).
  for (const char of 'alpha') h.vt.sendInput(char)
  await frames(h.vt, 2)
  assert.match(h.view(), /search: \/ alpha/u, `the whole burst must arrive:\n${h.view()}`)
})

test('a delegated bar press armed while the child paint is behind is refused', async () => {
  const h = setup()
  await openMcpPage(h)
  const controller = embeddedController(h)
  await sgrClick(h, 'a Add')
  // Two argument rows; the second insert focuses the new row. The second click
  // lands on a DIFFERENT word of the same row (a same-word rapid repeat is a
  // fork double-click word selection).
  await sgrClick(h, 'Arguments:')
  const argsRow = locateCell(h, 'Arguments:')
  sgrMouse(h, 'press', argsRow.col + 11, argsRow.row)
  sgrMouse(h, 'release', argsRow.col + 11, argsRow.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.equal(controller.snapshot().editor?.args.length, 2)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.match(h.view(), /▸ Arg 1:/u, 'the added row is the painted focus')
  const remove = locateCell(h, 'Remove [Backspace]')
  // The keyboard moves the live focus to Arg 2; the painted frame still shows
  // Arg 1 when the bar cell is pressed — send the key and the press BEFORE the
  // next frame paints.
  h.vt.sendInput('\x1b[B')
  sgrMouse(h, 'press', remove.col, remove.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  sgrMouse(h, 'release', remove.col, remove.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.equal(controller.snapshot().editor?.args.length, 2,
    'the press armed against the unpainted focus never removes')
  // A fresh complete press on the re-painted frame removes the focused Arg 2
  // (the `[Backspace]` word cell avoids the fork double-click word selection).
  const fresh = locateCell(h, 'Remove [Backspace]')
  sgrMouse(h, 'press', fresh.col + 7, fresh.row)
  sgrMouse(h, 'release', fresh.col + 7, fresh.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.equal(controller.snapshot().editor?.args.length, 1, 'the fresh gesture removes exactly one row')
})

test('a press armed against a stale painted bar frame is refused', async t => {
  const h = setup()
  await openMcpPage(h)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  const page = h.embeddedMcpPage()!
  const render = page.render
  // Keep the Host-A frame painted while the live state moves to Host B: no
  // paint is PENDING, the painted identity is simply already stale.
  const oldFrame = render.call(page, h.vt.columns)
  page.render = () => oldFrame
  t.after(() => { page.render = render })
  const probe = locateCell(h, 'p probe')
  const managerB = h.replaceManager()
  await flushOwnedTurns()
  embeddedController(h).refresh()
  await flushOwnedTurns()
  assert.equal((page as unknown as { pointerFrameCurrent: () => boolean }).pointerFrameCurrent(), false,
    'the painted frame is stale while B is already current')
  // A press on the OLD painted span must not be recorded at all.
  sgrMouse(h, 'press', probe.col, probe.row)
  // The paint catches up, then the release resolves: nothing may run.
  page.render = render
  h.app.requestRender()
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  sgrMouse(h, 'release', probe.col, probe.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.deepEqual(h.manager.probes, [], 'the stale press never probed Host A')
  assert.deepEqual(managerB.probes, [], 'the stale press never probed Host B')
  // Fresh positive: a press on the CURRENT painted frame operates B once (the
  // `probe` word cell avoids the fork double-click word selection).
  const fresh = locateCell(h, 'p probe')
  sgrMouse(h, 'press', fresh.col + 2, fresh.row)
  sgrMouse(h, 'release', fresh.col + 2, fresh.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.deepEqual(managerB.probes, ['alpha'], 'a fresh gesture on the current frame probes once')
})

test('a non-zero wheel on the physical Action Bar revokes a held body-row press', async () => {
  const h = setup()
  await openMcpPage(h)
  const controller = embeddedController(h)
  await sgrClick(h, 'a Add')
  assert.equal(controller.snapshot().editor?.enabled, true)
  // The body row press is held while a wheel fires on the SHARED last row,
  // which lies outside the hosted body box (the child never sees it).
  const enabled = locateCell(h, 'Enabled:')
  sgrMouse(h, 'press', enabled.col, enabled.row)
  const barRow = h.vt.getViewport().length - 1
  sgrWheel(h, 'down', enabled.col, barRow)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  sgrMouse(h, 'release', enabled.col, enabled.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.equal(controller.snapshot().editor?.enabled, true,
    'the wheel-revoked body press never toggled the draft')
  // A fresh complete body click still runs its own intent exactly once.
  const fresh = locateCell(h, 'Enabled:')
  sgrMouse(h, 'press', fresh.col + 9, fresh.row) // the `yes` word: avoids the fork's double-click
  sgrMouse(h, 'release', fresh.col + 9, fresh.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.equal(controller.snapshot().editor?.enabled, false)
})

test('a non-zero wheel on the physical Action Bar revokes a held search Done', async () => {
  const h = setup()
  await openMcpPage(h)
  await sgrClick(h, 'Search [/]')
  await press(h.vt, 'b')
  const done = locateCell(h, 'Done [Enter]')
  sgrMouse(h, 'press', done.col, done.row)
  sgrWheel(h, 'down', done.col, done.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  sgrMouse(h, 'release', done.col, done.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.match(h.view(), /search: \/ b/u, 'the bar wheel revoked the held Done')
  // A fresh complete click finishes the search once (a different word cell).
  const fresh = locateCell(h, 'Done [Enter]')
  sgrMouse(h, 'press', fresh.col + 5, fresh.row)
  sgrMouse(h, 'release', fresh.col + 5, fresh.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.doesNotMatch(h.view(), /search: \//u)
  assert.deepEqual(h.settingsMutateCalls, [])
})

test('a non-zero wheel on the physical Action Bar revokes a held dangerous confirmation', async () => {
  const h = setup()
  await openMcpPage(h)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  await press(h.vt, 't')
  assert.match(h.view(), /Disable server alpha/u)
  const confirm = locateCell(h, 'Y confirm')
  sgrMouse(h, 'press', confirm.col, confirm.row)
  sgrWheel(h, 'up', confirm.col, confirm.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  sgrMouse(h, 'release', confirm.col, confirm.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.deepEqual(h.settingsMutateCalls, [], 'the wheel-revoked confirmation wrote nothing')
  assert.match(h.view(), /Disable server alpha/u, 'the question is still open')
  // A fresh complete confirmation dispatches exactly one official write.
  const fresh = locateCell(h, 'Y confirm')
  sgrMouse(h, 'press', fresh.col + 2, fresh.row)
  sgrMouse(h, 'release', fresh.col + 2, fresh.row)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.deepEqual(h.settingsMutateCalls, ['mcp-manager'])
})

test('removing the last env/header key at a short grant keeps a focused field visible', async () => {
  for (const [columns, rows] of [[44, 8], [44, 20]] as const) {
    for (const field of ['env', 'headers'] as const) {
      const h = setup({ columns, rows })
      await openMcpPage(h)
      const controller = embeddedController(h)
      await sgrClick(h, 'a Add')
      if (field === 'headers') {
        // Streamable HTTP exposes the header rows instead of the env rows.
        for (let step = 0; step < 8 && !h.view().includes('Transport:'); step += 1) {
          await wheelBody(h, 'down')
        }
        await sgrClick(h, 'Transport:')
        await frames(h.vt, 2)
      }
      const addLabel = field === 'env' ? 'Env:' : 'Headers:'
      for (let step = 0; step < 12 && !h.view().includes(addLabel); step += 1) {
        await wheelBody(h, 'down')
      }
      await sgrClick(h, addLabel)
      const entries = field === 'env' ? controller.snapshot().editor?.env : controller.snapshot().editor?.headers
      assert.equal(entries?.length, 1, `${String(columns)}x${String(rows)} ${field}: the draft row was added`)
      const keyId = `${field === 'env' ? 'Env key' : 'Header key'}`
      for (let step = 0; step < 12 && !new RegExp(`▸ ${keyId}: KEY_1`, 'u').test(h.view()); step += 1) {
        await wheelBody(h, 'down')
      }
      assert.match(h.view(), new RegExp(`▸ ${keyId}: KEY_1`, 'u'))
      await sgrClick(h, 'Remove [Backspace]')
      const after = field === 'env' ? controller.snapshot().editor?.env : controller.snapshot().editor?.headers
      assert.deepEqual(after, [], `${String(columns)}x${String(rows)} ${field}: only row removed`)
      assert.match(h.view(), /▸ [^:\n]+:/u,
        `${String(columns)}x${String(rows)} ${field}: a focused field stays painted:\n${h.view()}`)
      h.app.dispose()
      startedApps.delete(h.app)
    }
  }
})
