/**
 * FR3 L6 — the mounted `Settings · Tools · MCP servers` user loop.
 *
 * Drives the REAL `/settings` command, the REAL `TuiApp` Settings workspace
 * lease, the REAL `SettingsWorkspacePanel`, the REAL per-open
 * `McpServersController` and the REAL Direct MCP port/source adapters over a
 * controlled Host manager fixture. Only the Host service boundaries are fakes
 * (an in-process manager with a live watch/probe/restart, and the official
 * settings descriptor projection) — never a pre-computed UI DTO.
 *
 * The case proves: the page is reachable from Tools; `configured:true` is never
 * shown as Configured without the settings key evidence; a plugin entry and a
 * retained cleanup record are classified separately; Probe/Restart reach the
 * Host exactly once; Esc cancels a restart; the page writes no configuration;
 * and closing/reopening leaves ONE watch at a time.
 *
 * @module @xmoon76/dsh-pi-tui/mcp-settings-mounted.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
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
import { DirectMcpServerConfigurationConfig, DirectMcpServerSourcesConfig } from '../../src/runtime/direct/config-direct.ts'
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
  readonly settingsMutateCalls: string[]
  readonly invoke: (name: string, rawInput?: string) => Promise<unknown>
  readonly view: () => string
}

function setup(options: { readonly columns?: number; readonly rows?: number; readonly withManager?: boolean } = {}): Harness {
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
  const managerMounted = options.withManager !== false
  const settingsMutateCalls: string[] = []
  let settingsRevision = 3
  const alphaEntry = { transport: 'stdio', command: '/bin/echo', args: [], env: {}, cwd: '', enabled: true }
  const settingsCtx = {
    get: (name: string): unknown => name === 'settings'
      ? {
          describe: () => [{
            ns: 'mcp-manager',
            value: { servers: { alpha: alphaEntry } },
            base: { servers: {} },
            user: { servers: { alpha: alphaEntry } },
            revision: settingsRevision,
          }],
          mutate: async (ns: string, ops: readonly unknown[]) => {
            settingsMutateCalls.push(ns)
            if (ops.length === 0) return
            settingsRevision += 1
          },
        }
      : undefined,
  }
  // The REAL Direct adapters over the controlled Host services.
  const hostCtx: DirectMcpHostContextLike = {
    get: (name: string): unknown => (name === 'mcpManager' && managerMounted ? manager : undefined),
    on: ((_event: string, _listener: (name: string) => void) => () => {}) as unknown as DirectMcpHostContextLike['on'],
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
      subagentModelSelection: { available: () => false },
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
    settingsMutateCalls,
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
  assert.match(lastLine(h), /Keep editing · Esc/u)
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
