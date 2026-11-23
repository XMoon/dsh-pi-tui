/**
 * Shared `/preset` command-plane harness: the REAL TUI command registration and
 * the REAL PiTui overlay slot over a Direct-shaped catalog/config fake.
 *
 * The fixture is deliberately the same one the command-surface suite used before
 * the UX redesign: only the Host/Config seams are scripted, while the command
 * handler, the presentation seam, the roster read owner and the panel are the
 * production code. Both the command suite and the PiTui presentation suite use
 * it so the two never drift into different fakes.
 * @module @xmoon76/dsh-pi-tui/test/support/preset-command-harness
 */

import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Context } from '@deepseek-ai/cordis'
import { CommandId, parseCommand, type CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import {
  registerTuiCommands,
  type TuiCommandRunner,
  type TuiSettingsLike,
} from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import type { PresetCatalog } from '../../src/runtime/catalog-port.ts'
import type { PresetPresentation } from '../../src/app/command/preset-presentation.ts'
import type { CatalogRefreshOutcome, CatalogRefreshRequest } from '../../src/app/command/catalog-refresh.ts'
import type { SurfaceCommandSummary } from '../../src/domain/catalog/surface.ts'
import { SettingsRegistry } from '../../src/extension/internal/settings-registry.ts'
import { ThemeRegistry } from '../../src/extension/internal/theme-registry.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { createAppLifecycleGuard } from './app-lifecycle-guard.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { fakeAgentModel } from './agent-model-double.ts'
import { registerTuiCommandsWithDirectSeams } from './register-tui-commands.ts'
import { sessionScopeFacts } from './session-scope-facts.ts'
import { unconfiguredPolicyObservation, unconfiguredSessionPolicyPort } from './session-policy-fake.ts'
import { unavailableAcpAccess, unavailableMcpServers, unavailableWebAccess } from './web-access-fake.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Every TuiApp this harness starts is stopped/disposed by the OWNING test
 *  file's `afterEach` through this guard (the process TUI slot is exclusive). */
const { started: startedApps, disposeAll: disposeHarnessApps } = createAppLifecycleGuard<TuiApp>()
export { disposeHarnessApps }

// themeOptOut() skips terminal queries under NO_COLOR / FORCE_COLOR=0 /
// CI=true — clear all three so the render paths under test stay live.
process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** A blank or started fake agent. */
export function fakeAgent(sessionId: string, events: readonly { type: string }[] = []): Agent {
  // The alpha.4 Session shape: the log is served through the snapshot reads.
  return {
    session: {
      id: sessionId,
      header: { cwd: '/ws' },
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      snapshotEvents: () => events,
    },
    ctx: { on: () => () => {} },
    options: { provider: 'p', model: 'm' },
    // DSH 0.2.2: the Agent owns its model selection (`AgentModel`).
    model: fakeAgentModel(undefined, { provider: 'p', model: 'm' }),
  } as unknown as Agent
}

/** The four shipped rows WITH Chinese metadata, exactly as the dsh install's
 * agent-presets package ships them in its official shipped root. */
/** The 0.1.7 shipped declarations publish no name/description of their
 * own (the official built-in classification); the TUI's fixed English copy
 * supplies the picker text. */
export const SHIPPED_ROWS = [
  { id: 'standard' },
  { id: 'ptc' },
  { id: 'minimal' },
  { id: 'cordis' },
]

function presetService(
  rows: { id: string; name?: string; description?: string; trust?: string }[],
  defaultPresetId = 'standard',
  selectFailure?: unknown,
  /** Scripted Host lock state; true = locked, false/undefined = unlocked. The
   *  double never derives blankness from the fake transcript. */
  selectLocked?: boolean,
  /** Per-call official roster projection override (broken/odd-row tests). */
  rosterOverride?: () => Promise<unknown>,
  /** Explicit resolve override (subject-drift windows). */
  resolveOverride?: (id?: string) => Promise<{ readonly id: string; broken?: string }>,
  /** Runs inside the official Host select BEFORE it settles (transition drift). */
  selectHook?: () => void,
) {
  const resolved: string[] = []
  const selected: string[] = []
  return {
    resolved,
    selected,
    service: {
      defaultId: defaultPresetId,
      // The PUBLIC official roster projection (the @Remote('list') method).
      remoteExportList: async () => rosterOverride !== undefined
        ? await rosterOverride()
        : {
            presets: rows.map(row => ({
              id: row.id,
              isDefault: row.id === defaultPresetId,
              ...row.name === undefined ? {} : { name: row.name },
              ...row.description === undefined ? {} : { description: row.description },
            })),
          },
      resolve: async (id?: string) => {
        if (resolveOverride !== undefined) return resolveOverride(id)
        // Real-registry semantics: an omitted id resolves the deployment
        // default; an unknown id (explicit OR default) is refused.
        const wanted = id ?? defaultPresetId
        resolved.push(wanted)
        const row = rows.find(candidate => candidate.id === wanted)
        if (row === undefined) throw new Error(`agent-presets: preset "${wanted}" not found (available: standard)`)
        return { id: row.id, trust: row.trust ?? 'system', path: `/presets/${row.id}` }
      },
      // The official blank-session select: re-checks the session's turn
      // boundary and refuses a started one with agent-preset/locked.
      select: async (agent: unknown, id: string) => {
        selectHook?.()
        if (selectFailure !== undefined) throw selectFailure
        const row = rows.find(candidate => candidate.id === id)
        if (row === undefined) throw Object.assign(new Error(`agent-presets: preset "${id}" not found (available: standard)`), { code: 'agent-preset/not-found' })
        if (selectLocked === true) {
          throw Object.assign(new Error('session has already started; its agent preset is fixed'), { code: 'agent-preset/locked' })
        }
        void agent
        selected.push(id)
        return id
      },
      composedPreset: () => undefined,
    },
  }
}

/** A fake commands service recording the registered definitions. With
 * `registered` the effective list returns the recorded definitions too — the
 * real official service lists what the TUI registered (`/preset` included),
 * which the candidate-visibility tests must observe. `presetOverride` models a
 * scoped preset/plugin command that SHADOWS the TUI's `/preset` with its own
 * descriptor (same name, its OWN definitionId). */
function fakeCommands(
  registered = false,
  presetOverride?: { name: string; definitionId?: string; description?: string },
) {
  const defs: { name: string; definitionId?: string; description?: string; input?: { hint: string }; handler?: unknown }[] = []
  return {
    defs,
    service: {
      register: (def: { name: string; definitionId?: string; description?: string; input?: { hint: string }; handler?: unknown }): (() => void) => {
        defs.push(def)
        return () => {}
      },
      list: () => {
        const entries = registered
          ? defs.map(def => ({
              name: def.name,
              ...def.definitionId === undefined ? {} : { definitionId: def.definitionId },
              description: def.description ?? '',
              ...def.input === undefined ? {} : { input: def.input },
            }))
          : []
        const shadowed = presetOverride === undefined
          ? entries
          : entries.map(entry => entry.name === 'preset' ? { ...presetOverride } : entry)
        return [...shadowed, { name: 'builtin', description: 'a builtin', input: { hint: '' } }]
      },
      find: () => undefined,
      execute: async () => undefined,
    },
  }
}

/** A stub runner with a MUTABLE pending preset and a scripted Host blank read.
 * `refreshCatalog` records every request and resolves a scripted outcome
 * (a failed outcome by default, so a test that does not care about the
 * refresh still sees the preset change succeed). */
function stubRunner(options: {
  ctx: Context
  app: TuiApp
  agent: Agent | undefined
  /** A mutable live-Session holder (agent + generation) for stale tests. */
  state?: { agent: Agent | undefined; generation: number }
  sessionBlank?: boolean
  refreshCatalog?: (request: CatalogRefreshRequest) => Promise<CatalogRefreshOutcome>
  ensureCalls?: string[]
  tuiSettings?: TuiSettingsLike
  applyFooterSettings?: () => void
  extensions?: TuiCommandRunner['extensions']
  agents?: TuiCommandRunner['agents']
  sessionReader?: Partial<TuiCommandRunner['sessionReader']>
  effectivePresetId?: string
  recordExtensionError?: (ref: { slot: string; id: string; owner: string }, error: unknown) => void
  clearExtensionError?: (ref: { slot: string; id: string; owner: string }) => void
  /** Defaults to a pass-through capture (the test themes use id === name). */
  captureExtensionHealthRef?: (slot: string, id: string) => { slot: string; id: string; owner: string } | undefined
  /** The runner's displayed/current Session preset read (`/preset status`, the
   *  picker's "[current]" state chip). Absent = undefined (no live subject). */
  currentPreset?: () => string | undefined
  /** Replace the preset catalog sub-domain with a scripted port (the /preset
   *  handler's only business authority). Used by the command-settlement
   *  family to script exact `WriteOutcome`s without a Host. */
  presetsPort?: PresetCatalog
}): { runner: TuiCommandRunner; pending: { value: string | undefined }; refreshes: CatalogRefreshRequest[] } {
  const pending = { value: undefined as string | undefined }
  const refreshes: CatalogRefreshRequest[] = []
  const catalog = new DirectCatalogPort(options.ctx as never, (sessionId) => {
    const live = options.state !== undefined ? options.state.agent : options.agent
    return live?.session.id === sessionId ? live : undefined
  })
  if (options.presetsPort !== undefined) Object.assign(catalog, { presets: options.presetsPort })
  const runner: TuiCommandRunner = {
    webAccess: unavailableWebAccess(),
    acpAccess: unavailableAcpAccess(),
    mcpServers: unavailableMcpServers(),
    beginClientWrite: () => () => {},
    deliveredFilesSnapshot: () => undefined,
    ctx: options.ctx,
    app: options.app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    ...sessionScopeFacts(
      () => options.state !== undefined ? options.state.agent : options.agent,
      () => options.state?.generation ?? 0,
    ),
    sessionPolicy: unconfiguredSessionPolicyPort(),
    sessionMarkdown: { read: async () => ({ kind: 'unavailable' }) },
    policy: unconfiguredPolicyObservation(),
    // The collision baseline reads the FAKE registry through the scoped-command
    // facade, exactly like the production provider.
    listScopedCommands: () => (options.ctx.get('commands') as unknown as { list(): readonly SurfaceCommandSummary[] }).list(),
    get currentSessionId() { return (options.state !== undefined ? options.state.agent : options.agent)?.session.id },
    ensureSession: async () => { options.ensureCalls?.push('ensureSession') },
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    get defaultIntentOutcome() { return undefined },
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => options.sessionBlank,
    tuiSettings: options.tuiSettings,
    applyFooterSettings: () => {},
    agents: options.agents ?? {
      resolveWorkspace: async () => ({ workspaceId: 'ws-a', path: '/ws' }),
      create: async () => ({}) as never,
      open: async () => ({}) as never,
    },
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined,
       ...options.sessionReader,
    },
    catalog,
    config: new DirectConfigPort(options.ctx as never, undefined, () => undefined),
    commandRegistry: options.ctx.get('commands') as import('../../src/commands.ts').CommandRegistryLike | undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostFile: new DirectHostFilePort(() => undefined),
    hostShellCompletion: { pathAuthority: 'client', complete: async () => ({ kind: 'ok', candidates: [] }) },
    interaction: {
      questions: {
        onRequest: () => true,
        subscribe: () => undefined,
        snapshot: () => undefined,
        claimTimedWait: async () => undefined,
        answerContinued: async () => 'not-continued' as const,
      },
      onApprovalRequest: () => {},
      },
    sessionWriter: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => options.currentPreset?.(),
    get pendingPreset() { return pending.value },
    set pendingPreset(id: string | undefined) { pending.value = id },
    get effectivePresetId() { return pending.value ?? options.effectivePresetId },
    refreshSessionCatalog: async (_scope, source) => {
      const agent = options.state !== undefined ? options.state.agent : options.agent
      const request: CatalogRefreshRequest = {
        source,
        target: { kind: 'agent', key: options.state?.generation ?? 0 },
        agent,
      }
      refreshes.push(request)
      return options.refreshCatalog?.(request) ?? { kind: 'failed', error: 'not wired in tests' }
    },
    refreshStandingCatalog: async (presetId, source) => {
      const request: CatalogRefreshRequest = { source, target: { kind: 'preset', presetId } }
      refreshes.push(request)
      return options.refreshCatalog?.(request) ?? { kind: 'failed', error: 'not wired in tests' }
    },
    refreshStatus: () => {},
    progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto',
    setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, openScheduleWorkspace: () => ({ kind: 'success' } as const), createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: (options.extensions ?? { themes: new ThemeRegistry(), settings: new SettingsRegistry() }) as never,
    captureExtensionHealthRef: options.captureExtensionHealthRef
      ?? ((slot, id) => {
        // Real-service semantics: only a REGISTERED plugin theme resolves
        // (a custom-file name must not produce a health ref).
        if (slot === 'theme') {
          const themes = options.extensions?.themes as { paletteForSelectable?: (value: string) => unknown } | undefined
          if (themes?.paletteForSelectable?.(id) === undefined) return undefined
          // Real-service semantics: the ref carries the CONTRIBUTION id
          // (the value `plugin:<owner>/<id>` maps to `<id>`).
          return { slot, id: id.startsWith('plugin:') ? id.slice(id.lastIndexOf('/') + 1) : id, owner: 'test-owner' }
        }
        return { slot, id, owner: 'test-owner' }
      }),
    recordExtensionError: options.recordExtensionError,
    clearExtensionError: options.clearExtensionError,
    exit: () => {},
  }
  return { runner, pending, refreshes }
}

function invoke(rawInput: string): CommandInvocation {
  return {
    commandId: CommandId('cmd-test-1'),
    agent: undefined as unknown as Agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }
}

/** Register the TUI commands and return the /preset surface under test. */
export function setup(options: {
  rows?: { id: string; name?: string; description?: string; trust?: string }[]
  agent?: Agent
  state?: { agent: Agent | undefined; generation: number }
  sessionBlank?: boolean
  selectFailure?: unknown
  selectLocked?: boolean
  /** Per-call official roster override (see presetService). */
  roster?: () => Promise<unknown>
  /** Explicit resolve override (see presetService). */
  resolve?: (id?: string) => Promise<{ readonly id: string; broken?: string }>
  /** Runs inside the official Host select before it settles (see presetService). */
  selectHook?: () => void
  refreshCatalog?: (request: CatalogRefreshRequest) => Promise<CatalogRefreshOutcome>
  settings?: { get(ns: string): unknown; mutate(ns: string, patch: unknown[]): Promise<unknown> }
  tuiSettings?: TuiSettingsLike
  extensions?: TuiCommandRunner['extensions']
  defaultPresetId?: string
  agents?: TuiCommandRunner['agents']
  sessionReader?: Partial<TuiCommandRunner['sessionReader']>
  effectivePresetId?: string
  recordExtensionError?: (ref: { slot: string; id: string; owner: string }, error: unknown) => void
  clearExtensionError?: (ref: { slot: string; id: string; owner: string }) => void
  captureExtensionHealthRef?: (slot: string, id: string) => { slot: string; id: string; owner: string } | undefined
  /** Make the fake commands service list what was registered (the real
   * service's behavior; required to observe `/preset` in the candidates). */
  commandsListRegistered?: boolean
  /** A scoped same-name `/preset` descriptor that shadows the TUI's own
   * (its OWN definitionId — never the TUI identity). */
  commandsPresetOverride?: { name: string; definitionId?: string; description?: string }
  /** Omit the `agentPresets` service (a rosterless deployment). */
  noPresets?: boolean
  /** Replace the preset catalog sub-domain with a scripted port. */
  presetsPort?: PresetCatalog
  /** The runner's displayed/current Session preset read. */
  currentPreset?: () => string | undefined
  /** Replace the mounted PiTui Preset presenter (mount-window command fencing). */
  presetPresentation?: PresetPresentation
  width?: number
  /** Viewport height. */
  height?: number
}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(options.width ?? 100, options.height ?? 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const commands = fakeCommands(options.commandsListRegistered === true, options.commandsPresetOverride)
  ctx.provide('commands', commands.service as never)
  if (options.settings === undefined) ctx.provide('settings', { describe: () => [{ ns: 'pi-tui-preferences', user: {} }] } as never)
  const presets = presetService(options.rows ?? SHIPPED_ROWS, options.defaultPresetId, options.selectFailure, options.selectLocked, options.roster, options.resolve, options.selectHook)
  if (options.noPresets !== true) ctx.provide('agentPresets', presets.service as never)
  if (options.settings !== undefined) ctx.provide('settings', options.settings as never)
  const ensureCalls: string[] = []
  const { runner, pending, refreshes } = stubRunner({
    ctx,
    app,
    agent: options.agent,
    state: options.state,
    sessionBlank: options.sessionBlank,
    refreshCatalog: options.refreshCatalog,
    ensureCalls,
    tuiSettings: options.tuiSettings,
    applyFooterSettings: () => {},
    extensions: (options.extensions ?? { themes: new ThemeRegistry(), settings: new SettingsRegistry() }) as never,
    agents: options.agents,
    sessionReader: options.sessionReader,
    effectivePresetId: options.effectivePresetId,
    captureExtensionHealthRef: options.captureExtensionHealthRef
      ?? ((slot, id) => {
        // Real-service semantics: only a REGISTERED plugin theme resolves
        // (a custom-file name must not produce a health ref).
        if (slot === 'theme') {
          const themes = options.extensions?.themes as { paletteForSelectable?: (value: string) => unknown } | undefined
          if (themes?.paletteForSelectable?.(id) === undefined) return undefined
          // Real-service semantics: the ref carries the CONTRIBUTION id
          // (the value `plugin:<owner>/<id>` maps to `<id>`).
          return { slot, id: id.startsWith('plugin:') ? id.slice(id.lastIndexOf('/') + 1) : id, owner: 'test-owner' }
        }
        return { slot, id, owner: 'test-owner' }
      }),
    recordExtensionError: options.recordExtensionError,
    clearExtensionError: options.clearExtensionError,
    presetsPort: options.presetsPort,
    currentPreset: options.currentPreset,
  })
  const surface = registerTuiCommandsWithDirectSeams(runner, undefined, options.presetPresentation)
  const def = commands.defs.find(entry => entry.name === 'preset')
  assert.ok(def?.handler !== undefined, 'preset handler missing')
  const run = async (rawInput: string): Promise<unknown> =>
    (def!.handler as (inv: CommandInvocation) => unknown)(invoke(rawInput))
  const runCommand = async (name: string, rawInput = ''): Promise<unknown> => {
    const found = commands.defs.find(entry => entry.name === name)
    assert.ok(found?.handler !== undefined, `${name} handler missing`)
    return (found!.handler as (inv: CommandInvocation) => unknown)(invoke(rawInput))
  }
  /** Invoke one registered handler as the outer command plane would: the
   *  execution's command id is the disposition correlation key. */
  const invokeCommand = async (name: string, commandId: string, rawInput: string): Promise<unknown> => {
    const found = commands.defs.find(entry => entry.name === name)
    assert.ok(found?.handler !== undefined, `${name} handler missing`)
    return (found!.handler as (inv: CommandInvocation) => unknown)({ ...invoke(rawInput), commandId: CommandId(commandId) })
  }
  const view = async (): Promise<string> => {
    await vt.waitForRender()
    return vt.getViewport().join('\n')
  }
  return { vt, app, run, runCommand, invokeCommand, view, pending, presets, ensureCalls, refreshes, surface }
}
