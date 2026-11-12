/**
 * PR3 — Fullscreen root-Footer click navigation on the REAL production path.
 *
 * The composition is the production one: the real `createSurfaceRuntime`
 * (which binds `onFooterModelOpen`/`onFooterTasksOpen` to its OWN
 * `openModelPicker` option and its OWN TaskRuntime), the real registered
 * CommandSurface `/model` route (`registerTuiCommands` through
 * `createCommandSurface`), and the real PiTui ModelPicker/Task Center
 * presenters over a mounted TuiApp. Only the Host services (llm/default-model
 * catalog, jobs registry) are stand-ins. The mounted `TuiApp` on a
 * `VirtualTerminal` receives REAL SGR press/release cells; the app resolves
 * them against the composer projection committed with the painted frame
 * (`getPaintedBox`).
 *
 * Negative cases pin the failure classes the plan enumerates: stale frames,
 * geometry changes, child subjects, unavailable capability, modal blocking,
 * separators and non-builtin items.
 * @module @xmoon76/dsh-pi-tui/app/footer-fullscreen-mouse-navigation.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { createSurfaceRuntime } from '../../src/app/surface/runtime.ts'
import { createCommandSurface } from '../../src/app/command/surface.ts'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { unavailableWebAccess } from '../support/web-access-fake.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { installVirtualProcessTerminal } from '../support/runner-harness.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { ExtensionLedger } from '../../src/extension/internal/ledger.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import type { TaskBrowserJobInput } from '../../src/domain/task/browser.ts'
import type { FooterLayoutV1 } from '../../src/domain/footer/layout.ts'
import type { SessionSubject } from '../../src/app/session/subject.ts'
import type { JobObservationPort } from '../../src/runtime/job-observation-port.ts'
import type { TuiApp } from '../../src/tui-app.ts'
import type { StatusSnapshot } from '../../src/domain/status/types.ts'
import type { SurfaceCommandSummary } from '../../src/domain/catalog/surface.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

const strip = (row: string): string => stripTerminalSequences(row)
const rows = (vt: VirtualTerminal): string[] => vt.getViewport().map(strip)
const screen = (vt: VirtualTerminal): string => rows(vt).join('\n')

const press = (vt: VirtualTerminal, x: number, y: number): void => { vt.sendInput(`\x1b[<0;${x + 1};${y + 1}M`) }
const release = (vt: VirtualTerminal, x: number, y: number): void => { vt.sendInput(`\x1b[<0;${x + 1};${y + 1}m`) }
const click = (vt: VirtualTerminal, x: number, y: number): void => { press(vt, x, y); release(vt, x, y) }

/** The painted cell of one known footer text, searched from the bottom. */
function cellOf(vt: VirtualTerminal, needle: string): { row: number; x: number } | undefined {
  const lines = rows(vt)
  for (let row = lines.length - 1; row >= 0; row -= 1) {
    const index = lines[row]!.indexOf(needle)
    if (index >= 0) return { row, x: index + 1 }
  }
  return undefined
}

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

const DIRECTORY = {
  default: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  routableProviders: ['deepseek'],
  groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] }],
  failures: [],
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  /** A commit into the surface's own StatusStore (main vs child subject). */
  readonly commitStatus: (patch: Partial<Pick<StatusSnapshot, 'view'>>) => void
  /** The registered `/model` command's own read owner: how many directory
   * reads the real handler started. */
  readonly loads: () => readonly string[]
  /** Whether the REAL `/model` registration is live (the release path's
   * availability fact). */
  readonly modelRegistered: () => boolean
  /** Revoke/restore the task runtime's session source between press and
   * release — openTasksBrowser's own admission declines. */
  readonly revokeTaskSource: () => void
  readonly restoreTaskSource: () => void
  /** Bump the task count 2 → 3 through the REAL runtime feed (roster +
   * refreshTasks): a SAME-LENGTH footer text change that leaves the model
   * placement's painted geometry byte-identical. */
  readonly bumpTaskCount: () => void
  /** Mouse PR4: the REAL command surface (the Tasks UI entry's owner). */
  readonly command: ReturnType<typeof createCommandSurface>
  /** Every notice the command surface published. */
  readonly notices: readonly string[]
  /** How many times the registered `/tasks` handler reached its opener. */
  readonly tasksOpens: readonly number[]
  /** Replace the LIVE Direct Host catalog the next refresh reads. */
  readonly setCatalogCommands: (rows: readonly SurfaceCommandSummary[]) => void
  readonly dispose: () => void
}

/**
 * The production composition: `createSurfaceRuntime` mounts the TuiApp; a real
 * `createCommandSurface` + `registerTuiCommands` installs `/model`; the
 * surface's late-bound `openModelPicker` option is EXACTLY the entry the
 * footer callbacks call. Host services (llm / agentDefaultModel / jobs) are
 * structural stand-ins.
 */
async function startHarness(options: {
  jobs?: TaskBrowserJobInput[]
  childSubject?: boolean
  withCommandRegistration?: boolean
  rows?: number
  draft?: string
  /** An Unstable raw capture that CONSUMES the given chunks (Esc / wheel)
   * before the Host key ladder sees them. */
  rawCapture?: 'esc' | 'wheel'
  /** Mouse PR4: the rows the Direct Host catalog read returns on the next
   *  coordinator refresh — a genuine Host command of a name this surface also
   *  registers is how the live Host-origin authority changes after startup. */
  catalogCommands?: readonly SurfaceCommandSummary[]
  /** Mouse PR4: advertise the mounted pane's Task Center capability. */
  taskCenterCapability?: boolean
} = {}): Promise<Harness> {
  const vt = new VirtualTerminal(100, options.rows ?? 30)
  const restoreTerminal = installVirtualProcessTerminal(vt)
  const ctx = new Context()
  const loads: string[] = []
  // Mouse PR4: the LIVE Host catalog this harness's coordinator reads, and the
  // notices the command surface published (its refusal path states itself).
  const catalogRows: { rows: readonly SurfaceCommandSummary[] } = { rows: options.catalogCommands ?? [] }
  const notices: string[] = []
  const tasksOpens: number[] = []
  // Structural Host stand-ins: the llm + agentDefaultModel services the real
  // DirectModelCatalog reads (the /model handler's own read owner).
  const llm = {
    listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
    listModels: async () => [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
    resolveModelInfo: async () => ({}),
    resolveCallConfig: async (config: { provider: string; model: string }) => config,
    discoverModels: async () => [],
    listConfigurableProviders: () => [],
  }
  let defaultSelection: { provider: string; model: string } | undefined
  const agentDefaultModel = {
    currentSelection: () => defaultSelection,
    saveSelection: async (next: { provider: string; model: string }) => {
      defaultSelection = next
      return undefined
    },
  }
  ;(ctx as unknown as { provide: (name: string, value: unknown) => void }).provide('llm', llm)
  ;(ctx as unknown as { provide: (name: string, value: unknown) => void }).provide('agentDefaultModel', agentDefaultModel)
  // Availability fencing: a disabled service makes the REAL catalog read
  // unavailable exactly like a Host without the model service.
  const liveCtx = {
    get: (name: string) => {
      if (name === 'llm') return llm
      if (name === 'agentDefaultModel') return agentDefaultModel
      return undefined
    },
  } as never

  let openCount = 0
  const surface = createSurfaceRuntime({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation as never,
    notificationMode: undefined,
    notificationMethod: undefined,
    terminalProgress: undefined,
    mainProgressAuthority: 'local-events',
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
    // The composition root's exact late-bound entries (bootstrap.ts): the
    // surface option IS the registered command's body.
    openModelPicker: entry => {
      openCount += 1
      assert.equal(entry, 'models', 'the footer entry opens the full models panel')
      void command.openModelPicker(entry)
    },
    modelPickerAvailable: () => command.modelPickerAvailable(),
  })
  // The real event routing minimum (the mount needs a current session).
  surface.attachEventRouting({
    isCleanedUp: () => false,
    isAttachedSession: () => true,
    currentSessionId: () => 'sess-main',
    hasLiveAgent: () => true,
    completionOwnerId: () => undefined,
    observeMainEvent: () => ({ refreshAgents: false }),
    appendOpeningViewerEvent: () => false,
    main: () => { throw new Error('not exercised') },
    viewedChildId: () => undefined,
    viewedChild: () => { throw new Error('not exercised') },
    mainFolder: () => { throw new Error('not exercised') },
    viewedChildFolder: () => { throw new Error('not exercised') },
    pendingSubjectId: () => undefined,
    pendingSnapshot: () => undefined,
    submissionEchoes: () => undefined,
    queueTextOf: () => '',
    exitView: () => {},
    refreshStatusCheap: () => {},
    refreshStatusAndWelcome: () => {},
    applyGoalChange: () => {},
    sessionTitleOf: () => undefined,
    extendLoadedHistory: () => false,
    settleLocalSubmitAck: () => {},
    markSubmitLatency: () => {},
    observeDurableSubmission: () => {},
    markContextDirty: () => {},
    refreshContextMeasurement: () => {},
    currentWorkingFromLog: () => false,
    flushTurn: () => {},
    registeredAgentIs: () => true,
    isCurrentOwnerAgent: () => true,
    viewedChildAgent: () => undefined,
    setViewedChildAgent: () => {},
    setViewedQueueAgent: () => {},
    agentForSession: () => undefined,
    applyViewedChildAssistantInput: () => {},
    applyMainAssistantInput: () => {},
  } as never)
  if (options.rawCapture !== undefined) {
    // The Unstable raw stage is wired through the REAL extension host seam
    // (surface.attachExtensionHost): a minimal first-party fake service whose
    // unstable route consumes the named chunks before the Host key ladder.
    surface.attachExtensionHost({
      _ledger: () => new ExtensionLedger(),
      setThemeUnloadedHook: () => () => {},
      detachSurface: () => {},
      _unstableInputsLive: () => true,
      _unstableInputsRevision: () => 1,
      _unstableEmergencyRelease: () => {},
      _advancedInputRoute: () => ({ action: 'passed' }),
      pluginActionFor: () => undefined,
      pluginActionIdFor: () => undefined,
      _unstableInputRoute: (data: string) => {
        const isEsc = data === '\x1b'
        const isWheel = data.startsWith('\x1b[<64;') || data.startsWith('\x1b[<65;')
        const captured = options.rawCapture === 'esc' ? isEsc : isWheel
        return captured ? { action: 'consume' } : { action: 'pass' }
      },
    } as never)
  }
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'full' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId: 'sess-main', isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: (text: string) => text,
  } as never)
  const app = surface.app
  startedApps.add(app)
  // The real TaskRuntime feeds through the surface's own attachTasks.
  const roster: { rows: TaskBrowserJobInput[] } = { rows: [...(options.jobs ?? [{ id: 'j1', kind: 'bash', label: 'build the project', status: 'running', startedAt: 1_000 }])] }
  const subject = {} as SessionSubject
  const taskSessionId: { current: string | undefined } = { current: 'sess-main' }
  surface.attachTasks({
    sessionId: () => taskSessionId.current,
    captureSubject: () => subject,
    subjectMatches: (candidate: unknown) => candidate === subject,
    enterView: async () => {},
    interruptSubagent: async () => ({ kind: 'committed' } as never),
    rowSelectionDisposition: () => 'close',
    subagentJobTranscriptId: () => undefined,
    subagentJobViewHint: (status: string) => status,
    jobObservation: { open: () => () => {}, stop: async () => ({ kind: 'requested' }) } as unknown as JobObservationPort,
    jobs: { list: () => roster.rows, subscribe: () => () => {} },
  } as never, {
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    isCleanedUp: () => false,
  } as never)
  surface.refreshTasks()

  // The REAL command surface + /model registration, built exactly like
  // bootstrap.ts: a TuiCommandRunner facade over the same minimal seams the
  // command-catalog suite uses, then registerTuiCommands through the surface.
  const scopeFacts = sessionScopeFacts(() => undefined, () => 0)
  const tuiSettings = {
    get: () => ({ theme: 'auto', footer: 'full', fullscreen: 'on', busyEnter: 'queue', localShellSandbox: 'bypass', history: {} }) as never,
    replace: () => undefined,
  }
  const runnerBase: TuiCommandRunner = {
    webAccess: unavailableWebAccess(),
    beginClientWrite: () => () => {},
    deliveredFilesSnapshot: () => undefined,
    ctx: liveCtx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    ...scopeFacts,
    currentSessionId: 'sess-main',
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } as never },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: tuiSettings as never,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined, sessionStatus: () => undefined,
    } as never,
    catalog: new DirectCatalogPort(liveCtx, () => undefined),
    config: new DirectConfigPort(liveCtx as never, undefined, () => undefined),
    commandRegistry: undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostFile: new DirectHostFilePort(() => undefined),
    hostShellCompletion: { pathAuthority: 'host' as const, complete: async () => ({ kind: 'unavailable' as const, reason: 'test Host unavailable' }) },
    interaction: {
      questions: {
        onRequest: () => true, subscribe: () => undefined, snapshot: () => undefined,
        claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const,
      },
      onApprovalRequest: () => {}, setApprovalPolicy: () => true,
    } as never,
    sessionWriter: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
    } as never,
    cwd: '/tmp',
    sessionCwd: () => '/tmp',
    imageStore: undefined as never,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text: string) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() } as never
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
    progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto',
    setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, openScheduleWorkspace: () => ({ kind: 'success' } as const), createPluginManagerPage: () => undefined,
    requireLiveSessionScope: async () => ({}) as never,
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  } as never
  const command = createCommandSurface({
    ctx: liveCtx,
    logError: () => {},
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    signal: new AbortController().signal,
    app: () => app,
    notify: (text: string) => { notices.push(String(text)) },
    liveAgent: () => undefined,
    sessionScope: {
      capture: () => scopeFacts.captureSessionScope(),
      captureLive: () => undefined,
      isCurrent: (scope: unknown) => scopeFacts.isSessionScopeCurrent(scope as never),
    },
    ownership: { generation: () => 0, currentSessionId: () => 'sess-main' },
    transition: { pending: () => false, run: async (task: () => unknown) => task() },
    commandsRegistry: () => undefined,
    clientCommands: runnerBase.clientCommands,
    direct: {
      listScopedCommands: () => [],
      sessionStats: async () => undefined,
      lastAssistantText: async () => undefined,
      promptAdmission: async (_agent: unknown, _hasImages: boolean, task: () => unknown) => task(),
    },
    directCatalog: {
      readSurfaceCatalog: async () => ({ commands: catalogRows.rows, scopedCommands: [], skills: [], issues: [] }),
      listGlobalCommands: () => [],
    },
    catalog: runnerBase.catalog as never,
    toCatalogAgent: (agent: unknown) => agent as never,
    presets: {
      launch: undefined,
      pending: () => undefined,
      setPending: () => {},
      current: () => undefined,
      blank: () => undefined,
    },
    clientCwd: '/tmp',
    surface: {
      setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto',
      setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
      openJobView: () => {},
      openTasksBrowser: () => { tasksOpens.push(1) },
      openScheduleWorkspace: () => ({ kind: 'success' } as const),
      composer: () => app,
      deliveredFilesSnapshot: () => undefined,
      installTspCommandCompletions: () => {},
      installTspInlineAttachmentStager: () => {},
      tspCommandPickerCapabilities: () => (options.taskCenterCapability === true ? { taskCenter: true } : {}),
    },
    backend: {
      kind: 'direct',
      sessionReader: runnerBase.sessionReader,
      sessionWorkspaceFacts: scopeFacts.sessionWorkspaceFacts,
      hostDirectoryBrowse: scopeFacts.hostDirectoryBrowse,
      sessionWriter: runnerBase.sessionWriter,
      interaction: runnerBase.interaction,
      catalog: runnerBase.catalog,
      config: runnerBase.config,
      hostFile: runnerBase.hostFile,
      webAccess: runnerBase.webAccess,
      hostShellCompletion: { pathAuthority: 'host' as const, complete: async () => ({ kind: 'unavailable' as const, reason: 'test Host unavailable' }) },
    },
    session: {
      ensureSession: () => runnerBase.ensureSession(),
      withWriter: async (_scope: unknown, task: () => unknown) => task(),
      switchSession: async () => undefined,
      forkSession: async () => ({ kind: 'committed' as const, value: undefined }) as never,
      isNavigationCurrent: () => false,
      transitionTo: runnerBase.transitionTo,
    },
    status: {
      forceContextMeasurement: () => undefined,
      forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
      sessionCwd: () => '/tmp',
      refresh: () => {},
      updateWelcomeCard: () => {},
      subscribeSessionScopeInvalidation: () => () => {},
    },
    settings: {
      applyFooterSettings: () => {},
      setDisplayPreset: () => ({ applied: true }) as never,
    },
    model: {
      selected: runnerBase.selected,
      defaultIntent: { intent: undefined, record: undefined, outcome: undefined },
      currentDefault: () => undefined,
      setPending: () => {},
      reconcileDefaultIntent: () => {},
      setDefaultIntent: () => {},
      settleIntent: () => {},
      awaitPendingDefaultWrite: async () => {},
      trackDefaultWrite: () => {},
    } as never,
    viewer: { enterView: async () => {} },
    drafts: {
      images: undefined as never,
      files: { pin: () => {}, unpin: () => {}, clearUnpinned: () => {}, attach: () => {} } as never,
    },
    extensions: { current: () => undefined, recordError: () => {}, clearError: () => {} },
    pluginManager: { page: () => undefined },
    client: { runCopyCommand: undefined as never, copyEnv: undefined as never },
    submission: { beginClientWrite: () => () => {}, prepareDeps: () => ({}) as never, settleQueueRecalls: () => {} },
    promptState: {
      progressUpdates: runnerBase.progressUpdatesState,
      responseStyle: runnerBase.responseStyleState,
      gitAttribution: runnerBase.gitAttributionState,
    },
    tuiSettings: tuiSettings as never,
    displayState: { preset: 'full' } as never,
    agents: runnerBase.agents,
    imageLimits: runnerBase.imageLimits,
    openRewindPicker: () => {},
    requestExit: () => {},
    exit: () => {},
  } as never)
  // buildRunner + register install the REAL /model command (the same members
  // bootstrap.ts wires: openModelPicker comes from registerTuiCommands). A
  // composition that never registers keeps the footer entry inert — exactly
  // the production `modelPickerAvailable() === false` fact.
  if (options.withCommandRegistration !== false) {
    command.buildRunner(runnerBase)
    command.register()
    assert.equal(command.modelPickerAvailable(), true, 'the real /model registration is live')
  }

  // The footer status: rich model + workspace through the surface's real
  // commitStatus (StatusPatch + legacy facts), exactly like the composition
  // root's own commits; the task badge comes from the TaskRuntime refresh
  // above (setTaskSummary → the app's own activity projection).
  if (options.draft !== undefined) app.setDraft(options.draft)
  surface.commitStatus(
    options.childSubject === true
      ? {
        view: { subject: { kind: 'subagent', id: 'child-1', mode: 'continuable' } },
        composition: { model: { provider: 'deepseek', id: 'deepseek-v4-flash', displayName: 'deepseek-v4-flash' } },
      }
      : {},
    {
      model: 'deepseek/deepseek-v4-flash',
      cwd: '/home/xmoon/project/dsh-pi-tui',
      branch: 'feat/footer-click',
      turns: 12,
      steps: 34,
      usage: { tokens: { input: 1200, output: 3400, cacheRead: 0, cacheWrite: 0 }, performance: { llmMs: 0 }, turns: 12, steps: 34 },
    },
    undefined,
  )
  app.setFullscreen(true)
  await vt.waitForRender()
  await vt.waitForRender()
  // Count the real handler's reads by wrapping the catalog's loadDirectory
  // (the command's own read owner) AFTER registration — late binding means
  // the handler calls the same member every time.
  const catalog = runnerBase.catalog as DirectCatalogPort
  const originalLoad = catalog.models.loadDirectory.bind(catalog.models)
  const reads: string[] = [...loads]
  catalog.models.loadDirectory = async (signal?: AbortSignal) => {
    reads.push('loadDirectory')
    return originalLoad(signal)
  }
  return {
    vt,
    app,
    commitStatus: (patch: Record<string, unknown>) => { surface.commitStatus(patch as never, {}, undefined) },
    loads: () => [...reads],
    /** Whether the REAL `/model` registration is live (the release path's
     * availability fact). */
    modelRegistered: () => command.modelPickerAvailable(),
    /** Revoke/restore the task runtime's session source between press and
     * release — openTasksBrowser's own admission declines. */
    revokeTaskSource: () => { taskSessionId.current = undefined },
    restoreTaskSource: () => { taskSessionId.current = 'sess-main' },
    bumpTaskCount: () => {
      roster.rows = [...roster.rows, { id: `j${roster.rows.length + 1}`, kind: 'bash', label: `job ${roster.rows.length + 1}`, status: 'running', startedAt: 1_000 }]
      surface.refreshTasks()
    },
    command,
    notices,
    tasksOpens,
    setCatalogCommands: (rows) => { catalogRows.rows = rows },
    dispose: () => {
      command.disposeCatalog()
      surface.dispose()
      restoreTerminal()
      void (ctx as unknown as { dispose?: () => unknown }).dispose?.()
    },
  }
}

test('a footer model click travels the real surface→command→picker chain', async () => {
  const h = await startHarness()
  try {
    const cell = cellOf(h.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell, `the model placement must be painted:\n${screen(h.vt)}`)
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    const view = screen(h.vt)
    assert.ok(view.includes('Models'), `the real ModelPicker must be open:\n${view}`)
    assert.ok(view.includes('DeepSeek V4 Flash'), `the picker hydrates from the real command read owner:\n${view}`)
    assert.deepEqual(h.loads(), ['loadDirectory'], 'exactly ONE directory read ran through the registered handler')
    assert.equal(h.app.isFullscreen(), true, 'the footer click does not leave fullscreen')
  } finally {
    h.dispose()
  }
})

test('model footer hits are inert for a child subject, an unregistered /model and a separator', async () => {
  const child = await startHarness({ childSubject: true })
  try {
    const childCell = cellOf(child.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(childCell, `the child footer still paints its model:\n${screen(child.vt)}`)
    click(child.vt, childCell.x, childCell.row)
    await child.vt.waitForRender()
    assert.equal(child.loads().length, 0, 'a child-subject model placement never opens the main picker')
    assert.ok(!screen(child.vt).includes('Models'), 'no picker on the child subject')
  } finally {
    child.dispose()
  }

  // Unregistered /model: the painted badge stays, but the composition never
  // installed the command, so footerModelAvailable is false and the release
  // path's registration re-check keeps it inert.
  const unregistered = await startHarness({ withCommandRegistration: false })
  try {
    assert.equal(unregistered.modelRegistered(), false, 'the composition installed no /model registration')
    const cell = cellOf(unregistered.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell, `the model badge still paints without the registration:\n${screen(unregistered.vt)}`)
    click(unregistered.vt, cell.x, cell.row)
    await unregistered.vt.waitForRender()
    assert.equal(unregistered.loads().length, 0, 'an unregistered /model stays inert')
    assert.ok(!screen(unregistered.vt).includes('Models'), 'no picker opened')
  } finally {
    unregistered.dispose()
  }

  const separator = await startHarness()
  try {
    const sepCell = cellOf(separator.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(sepCell)
    // Separator: the two spaces after the model placement.
    press(separator.vt, sepCell.x + 27, sepCell.row)
    release(separator.vt, sepCell.x + 27, sepCell.row)
    await separator.vt.waitForRender()
    assert.equal(separator.loads().length, 0, 'a separator cell is inert')
    // Mismatched release: press model, release on the tasks cell.
    press(separator.vt, sepCell.x, sepCell.row)
    release(separator.vt, sepCell.x + 31, sepCell.row)
    await separator.vt.waitForRender()
    assert.equal(separator.loads().length, 0, 'the release must be the pressed cell')
  } finally {
    separator.dispose()
  }
})

test('a footer press is dropped by a keyboard key, a changed composition, a resize and a box move; fresh clicks work', async () => {
  const h = await startHarness()
  try {
    const first = cellOf(h.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(first)

    // A real key between press and release retires the press.
    press(h.vt, first.x, first.row)
    h.vt.sendInput('\x1b')
    release(h.vt, first.x, first.row)
    await h.vt.waitForRender()
    assert.equal(h.loads().length, 0, 'a keyboard key retires the pending footer press')

    // A repaint that changes the model text retires the old press.
    press(h.vt, first.x, first.row)
    h.app.setStatus({ model: 'deepseek/deepseek-v4-pro' })
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    release(h.vt, first.x, first.row)
    await h.vt.waitForRender()
    assert.equal(h.loads().length, 0, 'a changed footer composition invalidates the old press')
    const fresh = cellOf(h.vt, '[deepseek/deepseek-v4-pro]')
    assert.ok(fresh, `the new model placement is painted:\n${screen(h.vt)}`)
    click(h.vt, fresh.x, fresh.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.equal(h.loads().length, 1, 'a fresh press/release on the new frame opens the picker')
    // Close the picker (Esc) so later probes start from the base frame.
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
    await h.vt.waitForRender()
  } finally {
    h.dispose()
  }

  // A box move (painted chrome growth between press and release): with the
  // bottom-anchored fullscreen layout a real box change moves the absolute
  // hit row whenever the hit is still painted, and drops the item otherwise —
  // the box fence and the absolute-hit fence retire the press together.
  // A box move between press and release (plan §9.1 stale frame): in the
  // tight layout (a 4-line draft fills the editor seat, so the todo panel's
  // rows push the footer) the todo growth moves the painted box (y 11→12,
  // height 2→1) and the placement with it. The stale release — on the NEW
  // cell of the SAME still-painted placement — is retired by the press-frame
  // fence (the pressed absolute row/revision no longer match); a naive
  // implementation with no fencing would accept it. The painted box itself
  // is a pure function of the terminal geometry and the composed line count,
  // so no separate box latch exists — see FooterPressGesture.
  const box = await startHarness({ rows: 13, draft: 'line one of a deliberately long draft\nline two\nline three\nline four' })
  try {
    box.app.setTodoSummary([
      { content: 'probe the box fence', status: 'in_progress' },
      { content: 'second item', status: 'pending' },
      { content: 'third item', status: 'pending' },
    ])
    await box.vt.waitForRender()
    await box.vt.waitForRender()
    const cell = cellOf(box.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell)
    press(box.vt, cell.x, cell.row)
    box.app.toggleTodoPanel()
    await box.vt.waitForRender()
    await box.vt.waitForRender()
    const moved = cellOf(box.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(moved, 'the placement is still painted in the tighter frame')
    assert.notEqual(moved.row, cell.row, `the box must actually move (before=${cell.row} after=${moved.row})`)
    // Release on the PRESSED cell (still a real same-cell click for the
    // fork, but the placement has moved off it): the press-frame fence must
    // retire the gesture — the current frame has no matching hit there.
    release(box.vt, cell.x, cell.row)
    await box.vt.waitForRender()
    assert.equal(box.loads().length, 0, 'a stale release after a painted-box move never acts')
  } finally {
    box.dispose()
  }

  const resized = await startHarness()
  try {
    const cell = cellOf(resized.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell)
    press(resized.vt, cell.x, cell.row)
    resized.vt.resize(90, 30)
    release(resized.vt, cell.x, cell.row)
    await resized.vt.waitForRender()
    assert.equal(resized.loads().length, 0, 'a resize between press and release never acts on a stale frame')
  } finally {
    resized.dispose()
  }
})

test('a same-geometry footer content change retires the release through the revision fence', async () => {
  const h = await startHarness()
  try {
    const cell = cellOf(h.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell)
    press(h.vt, cell.x, cell.row)
    // 2 -> 3 tasks: the composed footer text CHANGES (the tasks badge) while
    // the model placement's painted cell span stays byte-identical (it sits
    // before the badge and the badge grows by one same-width character).
    h.bumpTaskCount()
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    const after = cellOf(h.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(after, 'the model placement is still painted')
    assert.deepEqual(after, cell, 'the model hit geometry must be unchanged — only the text/revision changed')
    // Release on the SAME cell the fork will synthesize as a click: only the
    // press-frame revision fence can retire it (the current-hit lookup still
    // matches the same geometry).
    release(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    assert.equal(h.loads().length, 0, 'a changed composition retires the pending release even when the hit geometry is identical')
    // A fresh click on the still-valid placement acts. A different word of
    // the same placement: the fork treats a same-word repeat as a double-click
    // selection, not a disclosure click.
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.equal(h.loads().length, 1, 'the fresh click on the unchanged placement opens the picker')
  } finally {
    h.dispose()
  }
})

test('a second click while the picker is up opens no second panel', async () => {
  const h = await startHarness()
  try {
    const cell = cellOf(h.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell)
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.equal(h.loads().length, 1)
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    assert.equal(h.loads().length, 1, 'the modal picker owns the pointer; no second read ran')
  } finally {
    h.dispose()
  }
})

test('a footer tasks click opens the Full Task Center through the surface runtime, not Task Quick', async () => {
  const h = await startHarness()
  try {
    const cell = cellOf(h.vt, 'task')
    assert.ok(cell, `the tasks placement must be painted:\n${screen(h.vt)}`)
    let browserOpened = 0
    const original = h.app.openTaskBrowser.bind(h.app)
    h.app.openTaskBrowser = ((items: unknown, onSelect: unknown, onClose: unknown, options2: unknown) => {
      browserOpened += 1
      return original(items as never, onSelect as never, onClose as never, options2 as never)
    }) as typeof h.app.openTaskBrowser
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    const view = screen(h.vt)
    assert.equal(browserOpened, 1, 'the surface TaskRuntime opened the Full browser exactly once')
    assert.ok(view.includes('build the project'), `the real Task Browser painted its row:\n${view}`)
    assert.equal(h.app.taskQuickFocusedForTest(), false, 'the click never enters Task Quick')
  } finally {
    h.dispose()
  }
})

test('the task admission is re-checked on release: a runtime that lost its source between press and release stays inert', async () => {
  const h = await startHarness()
  try {
    const cell = cellOf(h.vt, 'task')
    assert.ok(cell)
    // Positive control first: the runtime admits the open while its source
    // is live.
    press(h.vt, cell.x, cell.row)
    release(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(screen(h.vt).includes('build the project'), 'the first click opened the browser')
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(!screen(h.vt).includes('build the project'), 'Esc closed the browser for the stale probe')
    // A press whose release lands on a DIFFERENT footer cell is inert: the
    // fork never synthesizes that click, so nothing dispatches.
    press(h.vt, cell.x, cell.row)
    release(h.vt, cell.x + 4, cell.row)
    await h.vt.waitForRender()
    assert.ok(!screen(h.vt).includes('build the project'), 'a mismatched release cannot open the browser')


    // The REVOCATION case: detach the runtime's session source between press
    // and release — openTasksBrowser's own admission (sessionId === undefined)
    // declines, and the release must observe that CURRENT fact, never the
    // press-time one.
    press(h.vt, cell.x, cell.row)
    h.revokeTaskSource()
    release(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(!screen(h.vt).includes('build the project'), 'a runtime whose source left between press and release never opens the browser')

    // Restore the source: a fresh click acts again.
    h.restoreTaskSource()
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(screen(h.vt).includes('build the project'), 'a fresh click after the source returns opens the browser')
  } finally {
    h.dispose()
  }
})

test('an approval seat and the passthrough search box block background footer clicks', async () => {
  const h = await startHarness()
  try {
    const cell = cellOf(h.vt, 'task')
    assert.ok(cell)
    const approval = h.app.showApprovalPrompt({ toolName: 'shell', reason: 'run the build' })
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(screen(h.vt).length > 0)
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    assert.ok(!screen(h.vt).includes('build the project'), 'the background footer is inert behind the approval sheet')
    void approval.catch(() => {})
  } finally {
    h.dispose()
  }

  const search = await startHarness()
  try {
    const cell = cellOf(search.vt, 'task')
    assert.ok(cell)
    search.app.startTranscriptSearch()
    await search.vt.waitForRender()
    await search.vt.waitForRender()
    assert.equal(search.app.isSearching(), true, 'the search overlay is up')
    click(search.vt, cell.x, cell.row)
    await search.vt.waitForRender()
    assert.ok(!screen(search.vt).includes('build the project'),
      'the search passthrough exception belongs to transcript inspection only')
  } finally {
    search.dispose()
  }
})

test('a synchronous recompose retires the release before the next repaint', async () => {
  const h = await startHarness()
  try {
    const cell = cellOf(h.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell)
    press(h.vt, cell.x, cell.row)
    // A SAME-GEOMETRY content change committed synchronously (store notify →
    // renderFooter): the pending projection advances but NO repaint happened
    // yet — the painted projection still carries the old frame.
    h.bumpTaskCount()
    release(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.equal(h.loads().length, 0, 'a pending recompose retires the release before any repaint')
    // After the repaint the same placement is still there: a fresh click
    // acts — the completed footer release consumed the fork's click history,
    // so the immediate next press is a plain single click, not a word
    // selection.
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.equal(h.loads().length, 1, 'the fresh click after the repaint opens the picker')
  } finally {
    h.dispose()
  }

  const cmd = await startHarness()
  try {
    const cell = cellOf(cmd.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell)
    press(cmd.vt, cell.x, cell.row)
    // The whole-footer command surface replaces the native footer
    // synchronously; the release arrives before the repaint.
    cmd.app.setFooterCommandRows(['[deepseek/deepseek-v4-flash]  [2 tasks running]'])
    release(cmd.vt, cell.x, cell.row)
    await cmd.vt.waitForRender()
    await cmd.vt.waitForRender()
    const view = screen(cmd.vt)
    assert.equal(cmd.loads().length, 0, 'a command-mode switch retires the release before any repaint')
    assert.ok(!view.includes('Models'), 'no picker opened from the stale release')
  } finally {
    cmd.dispose()
  }
})

test('the fork-supported button=3 release completes a footer navigation exactly once', async () => {
  const h = await startHarness()
  try {
    const cell = cellOf(h.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell)
    press(h.vt, cell.x, cell.row)
    release(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(screen(h.vt).includes('Models'), 'the primary-button release opens the picker (control)')
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(!screen(h.vt).includes('Models'), 'Esc closed the picker')
    // Several terminals encode the release of the pressed button as button 3
    // — the fork's click synthesis accepts it, so the footer gesture must
    // complete (never retire) on it.
    press(h.vt, cell.x, cell.row)
    h.vt.sendInput(`\x1b[<3;${cell.x + 1};${cell.row + 1}m`)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(screen(h.vt).includes('Models'), 'the button=3 release opens the picker')
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(!screen(h.vt).includes('Models'), 'Esc closed the picker again')
    // A secondary-button PRESS is a different gesture: the gesture retires.
    press(h.vt, cell.x, cell.row)
    h.vt.sendInput(`\x1b[<2;${cell.x + 1};${cell.row + 1}M`)
    release(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    assert.ok(!screen(h.vt).includes('Models'), 'a right-button press retires the pending gesture')
  } finally {
    h.dispose()
  }
})

test('a raw-captured key or wheel still retires the pending footer press', async () => {
  // The Unstable raw capture CONSUMES Esc before the Host key ladder: the
  // retirement must have happened EARLIER (handleInput, pre-raw-stage), or a
  // same-cell release after the captured key would still act.
  const esc = await startHarness({ rawCapture: 'esc' })
  try {
    const cell = cellOf(esc.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell)
    press(esc.vt, cell.x, cell.row)
    esc.vt.sendInput('\x1b') // consumed by the fake plugin capture
    release(esc.vt, cell.x, cell.row)
    await esc.vt.waitForRender()
    assert.equal(esc.loads().length, 0, 'a raw-captured key still retires the pending press')
    // A NON-captured key passes through and retires the same way.
    press(esc.vt, cell.x, cell.row)
    esc.vt.sendInput('x')
    release(esc.vt, cell.x, cell.row)
    await esc.vt.waitForRender()
    assert.equal(esc.loads().length, 0, 'a passed-through key retires the pending press')
  } finally {
    esc.dispose()
  }

  const wheel = await startHarness({ rawCapture: 'wheel' })
  try {
    const cell = cellOf(wheel.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell)
    press(wheel.vt, cell.x, cell.row)
    wheel.vt.sendInput('\x1b[<64;50;20M') // consumed by the fake plugin capture
    release(wheel.vt, cell.x, cell.row)
    await wheel.vt.waitForRender()
    assert.equal(wheel.loads().length, 0, 'a raw-captured wheel still retires the pending press')
  } finally {
    wheel.dispose()
  }
})

test('closing the picker and immediately re-clicking the same footer model cell reopens it', async () => {
  const h = await startHarness()
  try {
    const cell = cellOf(h.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell)
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(screen(h.vt).includes('Models'), 'the first click opened the picker')
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(!screen(h.vt).includes('Models'), 'Esc closed the picker')
    // NO wait: the fork's 500 ms double-click window must not swallow the
    // navigation control's own reopen — the completed footer release
    // consumed the click history.
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(screen(h.vt).includes('Models'), 'the immediate re-click reopens the picker')
  } finally {
    h.dispose()
  }
})

test('closing the Task Center and immediately re-clicking the footer tasks cell reopens it', async () => {
  const h = await startHarness()
  try {
    const cell = cellOf(h.vt, 'task')
    assert.ok(cell)
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(screen(h.vt).includes('build the project'), 'the first click opened the browser')
    h.vt.sendInput('\x1b')
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(!screen(h.vt).includes('build the project'), 'Esc closed the browser')
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(screen(h.vt).includes('build the project'), 'the immediate re-click reopens the browser')
  } finally {
    h.dispose()
  }
})

test('an aborted footer gesture never poisons the immediately following valid click', async () => {
  const tasks = await startHarness()
  try {
    const cell = cellOf(tasks.vt, 'task')
    assert.ok(cell)
    // Press the tasks cell, release on a DIFFERENT cell: the fork never
    // synthesizes that click, yet its press armed the multi-click counter.
    press(tasks.vt, cell.x, cell.row)
    release(tasks.vt, cell.x + 4, cell.row)
    await tasks.vt.waitForRender()
    assert.ok(!screen(tasks.vt).includes('build the project'), 'the aborted gesture opened nothing')
    // No compensation click: the very next valid same-cell click must be a
    // single click and open the browser.
    click(tasks.vt, cell.x, cell.row)
    await tasks.vt.waitForRender()
    await tasks.vt.waitForRender()
    assert.ok(screen(tasks.vt).includes('build the project'), 'the next valid click opens the browser immediately')
  } finally {
    tasks.dispose()
  }

  const model = await startHarness()
  try {
    const cell = cellOf(model.vt, '[deepseek/deepseek-v4-flash]')
    assert.ok(cell)
    press(model.vt, cell.x, cell.row)
    release(model.vt, cell.x + 20, cell.row)
    await model.vt.waitForRender()
    assert.ok(!screen(model.vt).includes('Models'), 'the aborted gesture opened nothing')
    click(model.vt, cell.x, cell.row)
    await model.vt.waitForRender()
    await model.vt.waitForRender()
    assert.ok(screen(model.vt).includes('Models'), 'the next valid click opens the picker immediately')
  } finally {
    model.dispose()
  }
})

test('a custom layout places model in the RIGHT zone and the full chain still navigates', async () => {
  const h = await startHarness()
  try {
    // A CUSTOM layout whose model placement rides the right zone: the
    // composer provenance, the painted Text, the SGR click and the real
    // business entry must all hold off the default preset.
    h.app.setFooterLayout({
      schemaVersion: 1,
      rows: [{ left: [{ id: 'turns-steps' }], right: [{ id: 'model', format: 'plain' }, { id: 'tasks' }] }],
    } as FooterLayoutV1)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    const cell = cellOf(h.vt, 'deepseek/deepseek-v4-flash')
    assert.ok(cell, `the right-zone model placement must be painted:\n${screen(h.vt)}`)
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.ok(screen(h.vt).includes('Models'), `the right-zone click opens the real picker:\n${screen(h.vt)}`)
    assert.deepEqual(h.loads(), ['loadDirectory'], 'the real command read owner ran once')
  } finally {
    h.dispose()
  }
})

test('the focused Task Quick band sits BELOW the footer and blocks footer clicks', async () => {
  const h = await startHarness()
  try {
    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
    await h.vt.waitForRender()
    assert.equal(h.app.taskQuickFocusedForTest(), true, `the production ↓ route enters Quick:\n${screen(h.vt)}`)
    const lines = rows(h.vt)
    const quickRow = lines.findIndex(line => line.startsWith('Task Quick'))
    assert.ok(quickRow > 0, `Quick paints its identity band:\n${screen(h.vt)}`)
    const cell = cellOf(h.vt, 'task')
    assert.ok(cell, `the footer badge is still painted above the band:\n${screen(h.vt)}`)
    assert.ok(cell.row < quickRow, 'the footer is painted ABOVE the Quick band (the real getPaintedBox row)')
    click(h.vt, cell.x, cell.row)
    await h.vt.waitForRender()
    assert.equal(h.app.taskQuickFocusedForTest(), true, 'the click does not steal Quick focus')
  } finally {
    h.dispose()
  }
})

// ── Mouse PR4: the Tasks UI entry obeys the LIVE Host-origin authority ──────
//
// The startup registration fact is not the whole answer: an Agent-scoped Host
// command installed LATER owns the name, and the typed `/tasks` line then runs
// the Host handler (`classifyCommandLine` prefers the genuine Host-origin
// claim). The status-line entry must follow that authority in the same window,
// or the mouse would be a second, TUI-only route.

test('the Tasks UI entry follows the LIVE Host-origin authority, not the startup registration fact', async () => {
  const h = await startHarness({ taskCenterCapability: true })
  try {
    assert.equal(h.command.tasksBrowserUiAvailable(), true,
      'a clean startup installs the real registered entry')
    const refresh = async (): Promise<string> => {
      const outcome = await h.command.requestCatalogRefresh({
        source: 'invalidation',
        target: { kind: 'agent', key: 0 },
        agent: {} as never,
      })
      return outcome.kind
    }

    // 1. A genuine Host /tasks becomes the WINNER after startup.
    h.setCatalogCommands([{ name: 'tasks', description: 'a genuine Host command' }])
    assert.equal(await refresh(), 'applied', 'the Host catalog really committed')
    assert.equal(h.command.tasksBrowserUiAvailable(), false,
      'the entry loses the action while the Host owns /tasks')
    const admitted = h.tasksOpens.length
    h.command.openTasksBrowserUi()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(h.tasksOpens.length, admitted,
      'the TUI handler never runs for a Host-owned name')
    assert.ok(h.notices.some(text => text.includes('served by the Host')),
      `the refusal states the real owner: ${h.notices.join(' | ')}`)

    // 2. The registered ALIAS is covered by the same authority.
    h.setCatalogCommands([{ name: 'subagents', description: 'a genuine Host alias command' }])
    assert.equal(await refresh(), 'applied')
    assert.equal(h.command.tasksBrowserUiAvailable(), false,
      'a Host-owned /subagents alias disables the entry too')

    // 3. The Host withdraws: the SAME registered handler is reachable again.
    h.setCatalogCommands([])
    assert.equal(await refresh(), 'applied')
    assert.equal(h.command.tasksBrowserUiAvailable(), true,
      'the entry returns with the command authority')
    h.command.openTasksBrowserUi()
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(h.tasksOpens.length, admitted + 1,
      'the admitted call runs the registered /tasks opener exactly once')
  } finally {
    h.dispose()
  }
})
