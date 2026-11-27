/**
 * The mounted `Settings · Tools · Computer Use` journeys (SUX-08).
 *
 * Drives the REAL `/settings` command, the REAL `TuiApp` Settings workspace
 * lease, the REAL `SettingsWorkspacePanel`, the REAL per-open
 * `CuaAccessSettingsController` and `ComputerUseSettingsPage`, plus the REAL
 * Root pointer/SGR route and the ONE physical Action Bar. The Host is a
 * controlled semantic-port fixture; no real macOS permission or user profile is
 * touched.
 *
 * Proves the two-mode contract end to end: the Overview is a Standard Detail
 * tenant with no CUA IO before the explicit mount, its first screen keeps the
 * real missing permission/action, the Applications workbench selects and
 * confirms through real pointer cells with exact sinks and a same-authority
 * readback, and the rail Back returns to the SAME mounted instance.
 *
 * @module @xmoon76/dsh-pi-tui/computer-use-settings-mounted.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
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
import type { CuaAccessPort, CuaApplicationState, CuaApplicationFact, CuaPtcConfiguration, CuaSystemStatus } from '../../src/runtime/cua-access-port.ts'
import type { PluginManagerPort } from '../../src/runtime/plugin-manager-port.ts'
import type { PresetDefaultConfig } from '../../src/runtime/config-port.ts'
import type { EmbeddedSpecialistPage } from '../../src/tui/panels/settings-workspace-panel.ts'

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

const SYSTEM: CuaSystemStatus = {
  platform: 'darwin',
  accessibility: true,
  screenRecording: false,
  helper: { pid: 7, name: 'DSH Computer Use', path: '/helper/dsh-cua-native' },
  parent: { pid: 1, path: '/sbin/launchd' },
  launchApplication: { name: 'DSH Computer Use.app', path: '/helper/DSH Computer Use.app' },
}
const PTC: CuaPtcConfiguration = { persistent: false, writable: true }

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly calls: string[]
  readonly requests: string[]
  readonly revokes: string[]
  readonly retries: string[]
  readonly presetWrites: string[]
  readonly applications: () => CuaApplicationState
  readonly page: () => EmbeddedSpecialistPage | undefined
  readonly invalidateObservation: () => void
  readonly settingsPanel: () => { onCellPress(x: number, y: number): void; onCellClick(x: number, y: number): void } | undefined
  readonly invoke: (name: string, rawInput?: string) => Promise<unknown>
  readonly view: () => string
}

function setup(options: {
  readonly columns?: number
  readonly rows?: number
  readonly applications?: CuaApplicationState
  /** F02: hold the accepted request so Waiting/Back refusal are observable. */
  readonly requestGate?: Promise<unknown>
} = {}): Harness {
  let applications: CuaApplicationState = options.applications ?? {
    allowedApps: [{ id: 'app-1', name: 'TextEdit', executablePath: '/Applications/TextEdit.app' }],
    blockedApps: [{ id: 'app-2', name: 'Example' }],
    persistentAvailable: true,
  }
  const calls: string[] = []
  const presetGeneration: object = {}
  const requests: string[] = []
  const observationListeners = new Set<() => void>()
  const revokes: string[] = []
  const retries: string[] = []
  const presetWrites: string[] = []
  const port: CuaAccessPort = {
    observation: {
      readSnapshot: () => 1,
      subscribe: (listener) => {
        observationListeners.add(listener)
        return () => { observationListeners.delete(listener) }
      },
    },
    readSystemStatus: async () => { calls.push('read:system'); return SYSTEM },
    readApplications: async () => { calls.push('read:applications'); return applications },
    readApplicationIcons: async () => { calls.push('read:icons'); return {} },
    readPtcConfiguration: async () => { calls.push('read:ptc'); return PTC },
    requestPermission: async (permission, locale) => {
      requests.push(`${permission}:${locale}`)
      if (options.requestGate !== undefined) await options.requestGate
      return SYSTEM
    },
    openSettings: async (permission, locale) => { calls.push(`open:${permission}:${locale}`) },
    enablePersistentPtc: async () => { calls.push('persist') },
    revoke: async (id) => {
      revokes.push(id)
      applications = { ...applications, allowedApps: applications.allowedApps.filter(app => app.id !== id) }
    },
    retryApproval: async (id) => {
      retries.push(id)
      applications = { ...applications, blockedApps: applications.blockedApps.filter(app => app.id !== id) }
    },
  }
  const pluginManager = {
    snapshot: async () => ({
      bundles: [{
        name: '@deepseek-ai/dsh-cua-bundle',
        official: true,
        availability: 'installation',
        enabled: true,
        installed: false,
        optional: true,
        removable: false,
        rows: [],
        overrides: [],
        version: '0.2.2-rc.5',
      }],
      plugins: [],
      registries: {},
      exemptions: [],
      exemptionWarnings: [],
    }),
    subscribeInvalidation: () => () => {},
  } as unknown as PluginManagerPort
  let presetValue = 'default'
  const presetDefault: PresetDefaultConfig = {
    available: () => true,
    get: () => presetValue,
    set: async () => {},
    readDecision: () => ({ generation: presetGeneration, revision: 1, value: presetValue }),
    setGuarded: async (id) => { presetWrites.push(id); presetValue = id; return { kind: 'accepted' } },
  }

  const ctx = new Context()
  const vt = new VirtualTerminal(options.columns ?? 120, options.rows ?? 40)
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
      presetDefault,
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
    cuaAccess: port,
    pluginManager,
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
    hostShellCompletion: { pathAuthority: 'client', pathLiteralDialect: 'bash', complete: async () => ({ kind: 'ok', candidates: [] }) },
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
    calls,
    requests,
    revokes,
    retries,
    presetWrites,
    applications: () => applications,
    invalidateObservation: () => {
      for (const listener of [...observationListeners]) listener()
    },
    page: () => {
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

async function flushOwnedTurns(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    for (let tick = 0; tick < 10; tick += 1) await Promise.resolve()
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

function sgrMouse(h: Harness, kind: 'press' | 'release', col: number, row: number): void {
  h.vt.sendInput(`\x1b[<0;${col + 1};${row + 1}${kind === 'press' ? 'M' : 'm'}`)
}

async function sgrWheel(h: Harness, direction: 'up' | 'down', col: number, row: number): Promise<void> {
  h.vt.sendInput(`\x1b[<${direction === 'up' ? 64 : 65};${col + 1};${row + 1}M`)
  await frames(h.vt)
  await flushOwnedTurns()
  await frames(h.vt)
}

async function sgrClick(h: Harness, label: string, wordOffset = 0): Promise<void> {
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

/** Open the Settings workspace and the Computer Use row through REAL input. */
async function openComputerUse(h: Harness): Promise<void> {
  h.invoke('settings')
  await frames(h.vt)
  await flushOwnedTurns()
  await selectSettingsCategory(h.vt, 'Tools')
  await frames(h.vt)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  for (let step = 0; step < 12; step += 1) {
    if (/\S\s+> Computer Use\b/u.test(h.view())) break
    await press(h.vt, '\x1b[B')
  }
  assert.match(h.view(), /\S\s+> Computer Use\b/u, `the CUA row must own the Rows selection:\n${h.view()}`)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
}

/** Wait until the REAL frame stops changing across two paint rounds, so the
 *  next SGR gesture is admitted against the settled frame (a click crossing a
 *  repaint is refused by the shared currentness rule). */
async function waitForStableView(h: Harness, rounds = 20): Promise<string> {
  let last = h.view()
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await frames(h.vt, 2)
    await flushOwnedTurns()
    const next = h.view()
    if (next === last) return next
    last = next
  }
  return last
}

async function waitForText(h: Harness, needle: string, attempts = 40): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (h.view().includes(needle)) return
    await frames(h.vt)
    await flushOwnedTurns()
  }
  assert.fail(`the workspace never painted ${needle}:\n${h.view()}`)
}

test('the Tools row selection performs no CUA IO; the explicit Open mounts ONE Overview read', async () => {
  const h = setup({ columns: 120, rows: 40 })
  h.invoke('settings')
  await frames(h.vt)
  await flushOwnedTurns()
  await selectSettingsCategory(h.vt, 'Tools')
  await frames(h.vt)
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  for (let step = 0; step < 12; step += 1) {
    if (/\S\s+> Computer Use\b/u.test(h.view())) break
    await press(h.vt, '\x1b[B')
  }
  assert.match(h.view(), /\S\s+> Computer Use\b/u)
  assert.equal(h.page(), undefined, 'selecting the row never mounts the page')
  assert.deepEqual(h.calls, [], 'selecting the row performs ZERO CUA IO')
  await press(h.vt, '\r')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.notEqual(h.page(), undefined, 'the explicit Open mounts the real page')
  await waitForText(h, 'Bundle: Enabled')
  const text = h.view()
  assert.match(text, /Accessibility: Allowed/u)
  assert.match(text, /Screen Recording: Not allowed/u)
  assert.match(text, /Request permission/u)
  assert.match(text, /Manage applications/u)
  assert.deepEqual(h.calls.filter(call => call === 'read:system'), ['read:system'], 'exactly ONE initial system read')
  assert.deepEqual(h.requests, [])
  await press(h.vt, '\x1b')
  await frames(h.vt, 2)
  assert.equal(h.page(), undefined, 'the page own Back retires the instance')
})

test('the real 44x8 frame keeps the first missing permission and its exact Request sink', async () => {
  const h = setup({ columns: 44, rows: 8 })
  await openComputerUse(h)
  await waitForText(h, 'Bundle: Enabled')
  const text = h.view()
  assert.match(text, /Host: macOS/u)
  assert.match(text, /Screen Recording: Not allowed/u)
  assert.match(text, /Request permission/u)
  assert.doesNotMatch(text, /Accessibility: Allowed/u, 'the short frame spends its rows on the missing permission')
  await sgrClick(h, 'Request permission')
  await waitForText(h, 'Action: Request sent')
  assert.deepEqual(h.requests, ['screenRecording:en-US'], 'the exact painted permission reaches the Host provider once')
  assert.match(h.view().replace(/\n/gu, ''), /does not grant permission/u, 'the receipt states the real effect')
  // The fresh observation stays the real denied permission (no optimistic paint).
  await press(h.vt, '\x1b[H')
  await frames(h.vt, 2)
  assert.match(h.view(), /Screen Recording: Not allowed/u)
})

test('a 44x8 pointer-only user walks Settings → Tools → Computer Use and requests the missing permission', async () => {
  const h = setup({ columns: 44, rows: 8 })
  h.invoke('settings')
  await frames(h.vt)
  await flushOwnedTurns()
  // The narrow first frame is the About CONTENT: its painted Esc affordance is
  // the pointer route back to the rail (no keyboard step).
  await sgrClick(h, 'Back [Esc]')
  await frames(h.vt, 2)
  // The rail is a real wheel-scrollable list: scroll it by pointer until Tools
  // is painted, then select it with a click (focus stays on the rail).
  for (let step = 0; step < 20 && !/\bTools\b/u.test(h.view()); step += 1) {
    await sgrWheel(h, 'down', 1, 3)
  }
  assert.match(h.view(), /\bTools\b/u, `the rail never scrolled to Tools:\n${h.view()}`)
  await sgrClick(h, 'Tools')
  await frames(h.vt, 2)
  // The painted rail forward affordance is the pointer analogue of Enter/Right.
  await sgrClick(h, 'Right open')
  await frames(h.vt, 2)
  // The Rows list is wheel-scrollable too; the row click only selects.
  for (let step = 0; step < 20 && !/\S\s+Computer Use\b/u.test(h.view()); step += 1) {
    await sgrWheel(h, 'down', 1, 3)
  }
  assert.match(h.view(), /\S\s+Computer Use\b/u, `the Rows never scrolled to Computer Use:\n${h.view()}`)
  await sgrClick(h, 'Computer Use')
  await frames(h.vt, 2)
  assert.equal(h.page(), undefined, 'the row click only selects')
  await sgrClick(h, 'Right open')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.notEqual(h.page(), undefined, 'the painted Rows forward hint mounts the page')
  await waitForText(h, 'Screen Recording: Not allowed')
  await sgrClick(h, 'Request permission')
  await waitForText(h, 'Action: Request sent')
  assert.deepEqual(h.requests, ['screenRecording:en-US'])
  await sgrClick(h, 'Back [Esc]')
  await frames(h.vt, 2)
  assert.equal(h.page(), undefined, 'the painted Back retires the page')
})

test('a zero-body Root frame paints only the safe CUA bar and starts no read', async () => {
  const h = setup({ columns: 44, rows: 20 })
  await openComputerUse(h)
  await waitForText(h, 'Screen Recording: Not allowed')
  const readsBefore = h.calls.filter(call => call.startsWith('read:')).length
  h.vt.resize(44, 2)
  await frames(h.vt)
  await flushOwnedTurns()
  await frames(h.vt)
  const lines = h.view().split('\n').map(line => line.trimEnd())
  const bar = lines[lines.length - 1] ?? ''
  assert.match(bar, /Back \[Esc\]/u, 'the zero-body frame keeps the real Back')
  assert.doesNotMatch(bar, /Refresh|Help|Enter open|Up\/Down|Enter activate/u,
    `no hidden body action is advertised without a body row:\n${h.view()}`)
  // Pointer: clicking any former bar cell must not start a Host read.
  for (const col of [20, 30, 40]) {
    sgrMouse(h, 'press', col, lines.length - 1)
    sgrMouse(h, 'release', col, lines.length - 1)
    await frames(h.vt)
    await flushOwnedTurns()
  }
  // Keyboard: r / Enter / Tab are inert on the same frame.
  await press(h.vt, 'r')
  await press(h.vt, '\r')
  await press(h.vt, '\t')
  assert.equal(h.calls.filter(call => call.startsWith('read:')).length, readsBefore,
    'a zero-body frame starts no Host read')
  assert.match(h.view(), /Back \[Esc\]/u, 'the safe bar stays painted')
  // The restored grant re-paints the SAME mounted instance with no fresh read.
  const page = h.page()
  assert.notEqual(page, undefined)
  h.vt.resize(44, 20)
  await frames(h.vt)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.equal(h.page(), page, 'resizing back never remounts the page')
  assert.match(h.view(), /Screen Recording: Not allowed/u)
  assert.equal(h.calls.filter(call => call.startsWith('read:')).length, readsBefore,
    'the whole zero-body round trip starts no read')
})

test('the Applications workbench completes a real pointer select → open → confirm → readback journey', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openComputerUse(h)
  await waitForText(h, 'Manage applications')
  const readsBefore = h.calls.filter(call => call === 'read:applications').length
  await sgrClick(h, 'Manage applications')
  await frames(h.vt, 3)
  const workbench = h.view()
  assert.match(workbench, /Categories \(/u, 'the workbench keeps the REAL Categories rail')
  assert.match(workbench, /Always allowed/u)
  assert.match(workbench, /TextEdit/u)
  assert.match(workbench, /Refused/u)
  assert.equal(h.calls.filter(call => call === 'read:applications').length, readsBefore,
    'the local workbench switch performs no extra read')
  // A row click only selects.
  await sgrClick(h, 'TextEdit')
  assert.deepEqual(h.revokes, [], 'selecting an application is never a write')
  // The explicit Open enters the Detail; the explicit verb is the next gate.
  await sgrClick(h, 'Enter open')
  await waitForText(h, 'Revoke access…')
  assert.match(h.view(), /Decision: Always allowed/u)
  // The dual projection's VISIBLE Detail verb must also be keyboard-admissible.
  await press(h.vt, '\r')
  await waitForText(h, 'Revoke this application decision?')
  await press(h.vt, '\x1b')
  await frames(h.vt, 2)
  await waitForText(h, 'Revoke access…')
  await sgrClick(h, 'Revoke access…')
  await waitForText(h, 'Revoke this application decision?')
  assert.match(h.view(), /Application: TextEdit · \/Applications\/TextEdit\.app/u)
  assert.match(h.view(), /Confirm \[Enter\]/u)
  assert.deepEqual(h.revokes, [], 'the confirmation is a review, not a write')
  await sgrClick(h, 'Confirm [Enter]')
  await frames(h.vt, 3)
  await flushOwnedTurns()
  await frames(h.vt, 3)
  assert.deepEqual(h.revokes, ['app-1'], 'ONE exact application decision is revoked')
  assert.equal(h.applications().allowedApps.length, 0)
  // The authoritative post-write read removes the decision from the page, and
  // the receipt stays visible in the ACTIVE workbench projection.
  await waitForText(h, 'Refused')
  assert.doesNotMatch(h.view(), /Decision: Always allowed/u)
  await waitForText(h, 'Application access revoked')
  assert.match(h.view(), /Target: Always allowed application: TextEdit/u)
  // Applications Help is REAL content in the same projection (Esc closes it
  // first, then the normal local Back ladder still runs).
  await press(h.vt, '?')
  await waitForText(h, 'Help and recovery')
  await press(h.vt, '\x1b')
  await frames(h.vt, 2)
  assert.doesNotMatch(h.view(), /Help and recovery/u)
  assert.match(h.view(), /Enter open|Enter activate|Back \[Esc\]/u)
  // Finish the ladder: Detail -> List -> the SAME Overview instance.
  await press(h.vt, '\x1b')
  await frames(h.vt, 2)
  assert.match(h.view(), /Always allowed/u, 'the receipt page returns to the List')
  await press(h.vt, '\x1b')
  await frames(h.vt, 3)
  assert.match(h.view(), /Bundle: Enabled/u, 'the local rail Back returns to the Overview')
  // The real page Back then retires THIS instance and returns to the Rows.
  await press(h.vt, '\x1b')
  await frames(h.vt, 3)
  assert.equal(h.page(), undefined, 'the real page Back exits the mounted instance')
})

test('a narrow Applications list never activates the hidden Detail verb (real SGR)', async () => {
  const h = setup({
    columns: 44,
    rows: 20,
    applications: {
      allowedApps: [{ id: 'app-a', name: 'A', executablePath: '/A.app' }],
      blockedApps: [{ id: 'app-b', name: 'B' }],
      persistentAvailable: true,
    },
  })
  await openComputerUse(h)
  // The Manage verb sits below the first 44x20 screen: scroll the SAME model.
  for (let step = 0; step < 40 && !/Manage applications/u.test(h.view()); step += 1) {
    await press(h.vt, '\x1b[6~')
  }
  await waitForText(h, 'Manage applications')
  // Select Manage in the real Overview, then Enter into the single-region list.
  for (let step = 0; step < 40; step += 1) {
    if (/> Manage applications/u.test(h.view())) break
    await press(h.vt, '\x1b[B')
  }
  await press(h.vt, '\r')
  await frames(h.vt, 3)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  const list = h.view()
  assert.match(list, /Always allowed/u)
  assert.doesNotMatch(list, /Revoke access…/u, 'the hidden Detail verb is not painted')
  // The hidden Detail build puts `Revoke access…` on page-local row 7; the page
  // body starts at terminal row 3, so this blank list cell is the old hidden
  // verb coordinate and must never write.
  sgrMouse(h, 'press', 3, 10)
  sgrMouse(h, 'release', 3, 10)
  await frames(h.vt, 2)
  await flushOwnedTurns()
  assert.doesNotMatch(h.view(), /Revoke this application decision\?/u)
  assert.deepEqual(h.revokes, [])
  // The painted bar Open is the explicit route; the visible verb is then real.
  await sgrClick(h, 'Enter open')
  await waitForText(h, 'Revoke access…')
  assert.match(h.view(), /Decision: Always allowed/u)
  // Symmetric: a hidden List row cell (page-local row 1) never acts from the Detail.
  sgrMouse(h, 'press', 3, 4)
  sgrMouse(h, 'release', 3, 4)
  await frames(h.vt, 2)
  assert.match(h.view(), /Decision: Always allowed/u, 'the Detail keeps the seat')
  assert.doesNotMatch(h.view(), /Enter open/u)
  await sgrClick(h, 'Revoke access…')
  await waitForText(h, 'Revoke this application decision?')
  await sgrClick(h, 'Confirm [Enter]')
  await frames(h.vt, 3)
  await flushOwnedTurns()
  assert.deepEqual(h.revokes, ['app-a'], 'the visible verb is the ONE write')
})

test('the dual Applications wheel follows the painted region and the gutter stays inert (real SGR)', async () => {
  const apps = Array.from({ length: 10 }, (_, index) => ({
    id: `app-${String(index + 1)}`,
    name: index === 0 ? 'A' : `App ${String(index + 1)}`,
    executablePath: index === 0
      ? `/Applications/${'Very Long Application Name/'.repeat(12)}A.app`
      : `/Applications/App ${String(index + 1)}.app`,
  }))
  const h = setup({
    columns: 120,
    rows: 40,
    applications: { allowedApps: apps, blockedApps: [], persistentAvailable: true },
  })
  await openComputerUse(h)
  await waitForText(h, 'Manage applications')
  await sgrClick(h, 'Manage applications')
  await frames(h.vt, 3)
  h.vt.resize(120, 12)
  await frames(h.vt)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  const before = h.view()
  // The two-cell gutter between the painted panes owns no scroll.
  // Categories rail + 34-cell List => the page-local 2-cell gutter is at x=58..59.
  await sgrWheel(h, 'down', 58, 5)
  assert.equal(h.view(), before, 'the gutter wheel changes nothing')
  // Over the List the List scrolls; the selected row may leave the viewport and
  // the Open hint must disappear with it.
  await sgrWheel(h, 'down', 30, 5)
  await frames(h.vt, 2)
  assert.notEqual(h.view(), before, 'the wheel over the List scrolls the List')
  // Keep scrolling the SAME region until the selected first row leaves the
  // painted viewport; the Open hint must disappear with it.
  for (let step = 0; step < 6 && /Enter open/u.test(h.view()); step += 1) {
    await sgrWheel(h, 'down', 30, 5)
    await frames(h.vt, 2)
  }
  assert.doesNotMatch(h.view(), /Enter open/u, 'an offscreen selection advertises no Open')
  for (let step = 0; step < 6 && !/> A\b/u.test(h.view()); step += 1) {
    await sgrWheel(h, 'up', 30, 5)
    await frames(h.vt, 2)
  }
  assert.match(h.view(), /Enter open/u, 'the restored visible selection advertises Open again')
  await frames(h.vt, 2)
  // Over the Detail the Detail scrolls (its long path exceeds the grant).
  const listFrame = h.view()
  await sgrWheel(h, 'down', 70, 5)
  await frames(h.vt, 2)
  assert.notEqual(h.view(), listFrame, 'the wheel over the Detail scrolls the Detail')
  assert.match(h.view(), /Categories \(/u, 'the workbench chrome stays painted')
})

test('a pending accepted action paints Waiting with no cancel, then shows its receipt and returns', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const h = setup({ columns: 44, rows: 20, requestGate: gate })
  await openComputerUse(h)
  await waitForText(h, 'Request permission')
  await sgrClick(h, 'Request permission')
  await waitForText(h, 'Waiting for the action to settle')
  assert.doesNotMatch(h.view(), /Back \[Esc\]/u, 'the accepted action paints no cancel')
  const page = h.page()
  // The Waiting frame advertises no cancel at all.
  assert.doesNotMatch(h.view(), /Back \[Esc\]/u)
  release()
  await waitForText(h, 'Action: Request sent')
  assert.deepEqual(h.requests, ['screenRecording:en-US'], 'the first missing permission is the exact sink')
  await frames(h.vt, 2)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.equal(h.page(), page, 'the settled page is still the SAME instance')
  await sgrClick(h, 'Back [Esc]')
  await frames(h.vt, 2)
  assert.equal(h.page(), undefined, 'the real painted Back retires the page after settlement')
})

test('an invalidated Overview risk retires before the next paint and the stale decision writes nothing', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openComputerUse(h)
  await waitForText(h, 'Persistent PTC mode…')
  for (let step = 0; step < 40; step += 1) {
    if (/> Persistent PTC mode…/u.test(h.view())) break
    await press(h.vt, '\x1b[B')
  }
  await press(h.vt, '\r')
  await waitForText(h, 'Enable persistent PTC mode?')
  assert.match(h.view(), /Confirm \[Enter\]/u)
  h.invalidateObservation()
  // The page retires the invalidated confirmation in its observation
  // subscription; the next NATURALLY scheduled frame is a coherent Overview.
  await frames(h.vt, 3)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.match(h.view(), /Bundle: Enabled/u, 'the next frame is the Overview tenant')
  assert.doesNotMatch(h.view(), /Confirm \[Enter\]/u)
  await waitForStableView(h)
  await press(h.vt, 'y')
  await frames(h.vt, 2)
  assert.ok(!h.calls.includes('persist'), 'the stale risk performed no write')
  // A fresh control remains usable on the same page. The cursor still sits on
  // the invalidated PTC action, so return to the first action before moving.
  await waitForText(h, 'Request permission')
  for (let step = 0; step < 40; step += 1) await press(h.vt, '\x1b[A')
  for (let step = 0; step < 40; step += 1) {
    if (/> .*Request permission/u.test(h.view())) break
    await press(h.vt, '\x1b[B')
  }
  await press(h.vt, '\r')
  await waitForText(h, 'Action: Request sent')
})

test('an invalidated Applications risk retires before the next paint and a fresh verb writes once', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openComputerUse(h)
  await waitForText(h, 'Manage applications')
  await sgrClick(h, 'Manage applications')
  await frames(h.vt, 3)
  await sgrClick(h, 'TextEdit')
  await sgrClick(h, 'Enter open')
  await waitForText(h, 'Revoke access…')
  await sgrClick(h, 'Revoke access…')
  await waitForText(h, 'Revoke this application decision?')
  h.invalidateObservation()
  await frames(h.vt, 3)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.match(h.view(), /Always allowed/u, 'the next frame is the normal Applications projection')
  assert.doesNotMatch(h.view(), /Confirm \[Enter\]/u)
  await waitForStableView(h)
  await press(h.vt, 'y')
  await frames(h.vt, 2)
  assert.deepEqual(h.revokes, [], 'the stale Applications risk performed no write')
  // The SAME Detail page remains usable with the fresh observation.
  await waitForText(h, 'Revoke access…')
  await waitForStableView(h)
  await press(h.vt, '\r')
  await waitForText(h, 'Revoke this application decision?')
  await press(h.vt, 'y')
  await frames(h.vt, 3)
  await flushOwnedTurns()
  assert.deepEqual(h.revokes, ['app-1'], 'the fresh risk dispatches exactly once')
})

test('the Applications rail Back returns to the SAME mounted Overview without a re-read', async () => {
  const h = setup({ columns: 120, rows: 40 })
  await openComputerUse(h)
  await waitForText(h, 'Manage applications')
  const page = h.page()
  assert.notEqual(page, undefined)
  await sgrClick(h, 'Manage applications')
  await frames(h.vt, 3)
  assert.match(h.view(), /Always allowed/u)
  const readsAfterOpen = h.calls.filter(call => call === 'read:system').length
  // The untouched child List yields to the REAL rail; the rail Esc is the
  // page's LOCAL return to the same Overview instance (no dispose/re-read).
  await press(h.vt, '\x1b[Z')
  await frames(h.vt, 2)
  await press(h.vt, '\x1b')
  await frames(h.vt, 3)
  await flushOwnedTurns()
  await frames(h.vt, 2)
  assert.equal(h.page(), page, 'the SAME page instance kept the seat')
  assert.match(h.view(), /Bundle: Enabled/u, 'the Overview is painted again in this lease')
  assert.equal(h.calls.filter(call => call === 'read:system').length, readsAfterOpen,
    'the local return performs no extra Host read')
})
