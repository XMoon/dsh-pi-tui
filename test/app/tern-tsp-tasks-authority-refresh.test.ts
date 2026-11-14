/**
 * Mouse PR4 / F2: a catalog commit that changes the COMMAND AUTHORITY must
 * repaint the TSP statusline by itself.
 *
 * The dock's Tasks click affordance is admitted by the live Host-origin
 * authority. That authority changes inside the command layer's catalog commit
 * (a genuine Agent-scoped Host `/tasks`/`/subagents` taking the name over, or
 * releasing it), and the commit reaches the renderer through the ONE
 * `installTspCommandCompletions` seam. A closed completion seat repaints
 * nothing on its own, so the mount must paint ONE frame per commit — otherwise
 * the badge keeps a click affordance that the live gate then silently refuses
 * (or keeps hiding one that is already valid again).
 *
 * This suite drives the REAL chain the production composition builds:
 * `CatalogRefreshCoordinator` (CommandSurface) → `registerTuiCommands` →
 * `installTspCommandCompletions` → the mounted TSP renderer. The status
 * snapshot is committed ONCE, before the first assertion; the authority flips
 * afterwards must be visible WITHOUT any further `commitStatus()`.
 *
 * @module @xmoon76/dsh-pi-tui/app/tern-tsp-tasks-authority-refresh.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { connect as sdkConnect } from '@stencil-hq/tern'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createSurfaceRuntime, type SurfaceRuntime, type SurfaceRendererMount } from '../../src/app/surface/runtime.ts'
import { createCommandSurface } from '../../src/app/command/surface.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { createPluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import type { SurfaceCommandSummary } from '../../src/domain/catalog/surface.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { wireNodes } from '../support/tsp-picker-wire.ts'
import { waitUntil } from '../support/tsp-runner-harness.ts'

const TASKS_ACTION = 'dsh.footer.tasks.open'
const SESSION_ID = 'sess-authority-refresh'

const nullPresentation = {
  handleFocusReport: () => {},
  markFocused: () => {},
  focusState: () => 'focused' as const,
  notify: () => {},
  enableFocusReporting: () => {},
  disableFocusReporting: () => {},
}

interface Chain {
  readonly pane: TspPane
  readonly surface: SurfaceRuntime<SessionEvent>
  readonly command: ReturnType<typeof createCommandSurface>
  /** The live Direct Host catalog the next coordinator refresh reads. */
  setHostCommands(rows: readonly SurfaceCommandSummary[]): void
  /** The Tasks badge's click action on the CURRENT committed frame. */
  tasksActionId(): string | undefined
  /** How many times the registered `/tasks` handler reached its opener. */
  readonly tasksOpens: readonly number[]
  dispose(): Promise<void>
}

async function mountChain(): Promise<Chain> {
  const pane = installTspPane({ sessionBrowser: true, workDetails: true })
  const session = await sdkConnect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane must connect through the shipped SDK')

  const ctx = new Context()
  const hostRows: { rows: readonly SurfaceCommandSummary[] } = { rows: [] }
  const tasksOpens: number[] = []
  const notices: string[] = []
  let mounted: TspRenderer | undefined
  let commandRef: ReturnType<typeof createCommandSurface> | undefined
  let runnerSessionId: string | undefined

  const surface = createSurfaceRuntime<SessionEvent>({
    tuiVersion: '0.0.0-test',
    notificationPresentation: nullPresentation,
    notificationMode: undefined,
    notificationMethod: undefined,
    mainProgressAuthority: 'local-events',
    terminalProgress: undefined,
    createPluginManagerPanel: createPluginManagerWorkspacePanel,
    // The production composition's late-bound business entry: the SAME closures
    // `src/app/bootstrap.ts` installs, reading the REAL CommandSurface.
    openTasksBrowserUi: () => { commandRef?.openTasksBrowserUi() },
    tasksBrowserUiAvailable: () => commandRef?.tasksBrowserUiAvailable() ?? false,
  })

  const renderer: SurfaceRendererMount = {
    mount: (binding, statusReader) => {
      mounted = mountTspRenderer(session, {
        copyVisual: async () => false,
        requestExit: () => {},
      })
      mounted.bindStatusReader(statusReader)
      mounted.bindImages(binding)
      return mounted
    },
    releaseUnmounted: async () => { await mounted?.dispose() },
  }
  surface.start({
    events: { onSubmit: () => {}, onExit: () => {} },
    renderer,
    workspaceRoot: '/tmp',
    iconStyle: 'emoji',
    displayState: { preset: 'compact' },
    historySearchSource: { search: () => Promise.reject(new Error('not exercised')) },
    readImage: () => Promise.reject(new Error('not exercised')),
    imageScope: () => undefined,
    present: { call: () => undefined, result: () => undefined },
    sessionCwd: () => '/tmp',
    captureHistoryScope: () => ({ sessionId: SESSION_ID, isCurrent: () => true }),
    onTerminalResize: () => {},
    copySelection: async () => false,
    deliveredFiles: { snapshot: () => undefined, isCurrent: () => false },
    openExternalUrl: () => {},
    readClipboardText: async () => undefined,
    imageFallbackColor: text => text,
  })

  // The runner facade the CommandSurface registers into: the same Direct-shaped
  // proxy the other TSP composition suites use (only the members registration
  // touches are real).
  const inert = (): undefined => undefined
  const base: Record<string, unknown> = {
    ctx,
    app: undefined,
    diag: createDiag({ stderrLevel: 'off' }),
    get currentSessionId() { return runnerSessionId },
    cwd: '/tmp',
    sessionCwd: () => '/tmp',
    signal: new AbortController().signal,
    commandRegistry: undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    listScopedCommands: () => (runnerSessionId === undefined ? [] : hostRows.rows),
    requireLiveSessionScope: async () => ({}) as never,
    openTasksBrowser: () => { tasksOpens.push(1) },
    ensureSession: async () => {},
    exit: () => {},
    requestExit: () => {},
  }
  const runner = new Proxy(base, {
    get: (target, key) => (key in target ? target[key as string] : inert),
  })

  const command = createCommandSurface({
    ctx,
    logError: () => {},
    diag: createDiag({ stderrLevel: 'off' }),
    signal: new AbortController().signal,
    app: () => undefined,
    notify: (text: string) => { notices.push(String(text)) },
    liveAgent: () => undefined,
    sessionScope: { capture: () => undefined, captureLive: () => undefined, isCurrent: () => true },
    ownership: { generation: () => 0, currentSessionId: () => runnerSessionId ?? SESSION_ID },
    transition: { pending: () => false, run: async (task: () => unknown) => task() },
    commandsRegistry: () => undefined,
    clientCommands: (base.clientCommands as never),
    direct: {
      listScopedCommands: () => [],
      sessionStats: async () => undefined,
      lastAssistantText: async () => undefined,
      promptAdmission: async (_agent: unknown, _hasImages: boolean, task: () => unknown) => task(),
    },
    directCatalog: {
      readSurfaceCatalog: async () => ({ commands: hostRows.rows, scopedCommands: [], skills: [], issues: [] }),
      listGlobalCommands: () => [],
    },
    catalog: { skills: { onSkillsChange: () => () => {}, standing: async () => ({ catalog: { skills: [], complete: true } }) } } as never,
    toCatalogAgent: (agent: unknown) => agent as never,
    presets: { launch: undefined, pending: () => undefined, setPending: () => {}, current: () => undefined, blank: () => undefined },
    clientCwd: '/tmp',
    surface: {
      setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto',
      setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
      openJobView: () => {},
      openTasksBrowser: () => { tasksOpens.push(1) },
      openScheduleWorkspace: () => ({ kind: 'success' } as const),
      composer: () => ({ getDraft: () => '', setDraft: () => {}, clearDraft: () => {} }) as never,
      deliveredFilesSnapshot: () => undefined,
      // The ONE seam that carries a catalog commit to the mounted renderer.
      installTspCommandCompletions: (installation: Parameters<typeof surface.installTspCommandCompletions>[0]) => { surface.installTspCommandCompletions(installation) },
      installTspInlineAttachmentStager: () => {},
      tspCommandPickerCapabilities: () => ({ taskCenter: surface.display.supportsTaskCenter }),
    },
    backend: {
      kind: 'direct',
      sessionReader: {
        list: async () => [],
        search: async () => ({ items: [], hasMore: false }),
        projectionBatch: async () => new Map(),
        blank: () => undefined,
        measureContext: () => undefined,
        turnOutline: () => undefined,
        sessionStatus: () => undefined,
      } as never,
      sessionWorkspaceFacts: {} as never,
      hostDirectoryBrowse: {} as never,
      sessionWriter: {
        prompt: async () => ({ kind: 'committed' as const, value: undefined }),
        updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
        cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      } as never,
      interaction: {
        questions: { onRequest: () => true, subscribe: () => undefined, snapshot: () => undefined, claimTimedWait: async () => undefined, answerContinued: async () => 'not-continued' as const },
        onApprovalRequest: () => {},
      } as never,
      catalog: { models: { available: () => false } } as never,
      config: { configReadiness: () => 'ready' } as never,
      hostFile: {} as never,
      webAccess: undefined as never,
      acpAccess: undefined as never,
      hostShellCompletion: { pathAuthority: 'host' as const, complete: async () => ({ kind: 'unavailable' as const, reason: 'test Host unavailable' }) },
    },
    session: {
      ensureSession: async () => {},
      withWriter: async (_scope: unknown, task: () => unknown) => task(),
      switchSession: async () => undefined,
      forkSession: async () => ({ kind: 'committed' as const, value: undefined }) as never,
      isNavigationCurrent: () => false,
      transitionTo: async (steps: { create: () => Promise<unknown> }) => ({ ok: true, next: await steps.create() }) as never,
    },
    status: {
      forceContextMeasurement: () => undefined,
      forceContextMeasurementResult: () => ({ value: undefined, observation: 'unavailable' as const }),
      sessionCwd: () => '/tmp',
      refresh: () => {},
      updateWelcomeCard: () => {},
      subscribeSessionScopeInvalidation: () => () => {},
    },
    settings: { applyFooterSettings: () => {}, setDisplayPreset: () => ({ applied: true }) as never },
    model: {
      selected: undefined,
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
      progressUpdates: { mode: 'milestones' },
      responseStyle: { style: 'default' },
      gitAttribution: { mode: 'off' },
    },
    tuiSettings: undefined,
    displayState: { preset: 'compact' } as never,
    agents: {} as never,
    imageLimits: () => undefined,
    openRewindPicker: () => {},
    requestExit: () => {},
    exit: () => {},
  } as never)

  command.buildRunner(runner as never)
  command.register()
  commandRef = command
  surface.bindRendererInput()

  // ONE status commit for the whole case: a main subject with a live Task
  // roster, so the attention badge (and therefore its action) has a fact.
  // A `view` in the patch re-derives the activity section from the surface's
  // machine mirror, so the fact is committed as an activity section on its own
  // — exactly what the surface's own activity publisher does.
  surface.commitStatus({
    activity: { phase: 'working', busy: true, queuedCount: 0, taskCount: 2, taskTotalCount: 3, childAgentCount: 0, todoCount: 0 },
  } as never, {}, undefined)

  const tasksActionId = (): string | undefined => wireNodes({ frames: () => pane.frames() })
    .find(node => node.k === 'seg'
      && (node.p['actions'] as { readonly click?: unknown } | undefined)?.click === TASKS_ACTION)?.id

  return {
    pane,
    surface,
    command,
    setHostCommands: rows => { hostRows.rows = rows },
    tasksActionId,
    tasksOpens,
    async dispose() {
      try {
        command.disposeCatalog()
        surface.dispose()
        await surface.whenRendererReleased()
      } finally {
        pane.restore()
      }
    },
    // exposed for the assertions on the refusal text
    ...{ notices },
  } as Chain
}

test('F2: a Host command takeover repaints the badge by itself, and the withdrawal restores it', async () => {
  const chain = await mountChain()
  try {
    await waitUntil('the badge paints its click action', () => chain.tasksActionId() !== undefined)
    const paintedId = chain.tasksActionId()!
    assert.equal(chain.command.tasksBrowserUiAvailable(), true,
      'a clean registration + a capable pane admits the entry')

    // 1. A genuine Agent-scoped Host /tasks becomes the winner. The catalog
    //    refresh runs the REAL coordinator -> CommandSurface -> renderer chain;
    //    NO status commit follows it.
    chain.setHostCommands([{ name: 'tasks', description: 'a genuine Host command' }])
    const taken = await chain.command.requestCatalogRefresh({
      source: 'invalidation',
      target: { kind: 'agent', key: 0 },
      agent: {} as never,
    })
    assert.equal(taken.kind, 'applied', 'the Host catalog committed')
    assert.equal(chain.command.tasksBrowserUiAvailable(), false, 'the live authority flipped')
    await waitUntil('the committed frame retracts the badge action by itself', () => chain.tasksActionId() === undefined)

    // The stale click on the retired id is refused (F1's live gate).
    chain.pane.event({ ev: 'action', sf: 's1', id: paintedId, act: TASKS_ACTION })
    await new Promise(resolve => setTimeout(resolve, 30)) // window: a wrong admission would open here
    assert.deepEqual(chain.tasksOpens, [], 'a stale badge click never runs the TUI handler')

    // 2. The Host releases the name: the SAME catalog path repaints the action.
    chain.setHostCommands([])
    const released = await chain.command.requestCatalogRefresh({
      source: 'invalidation',
      target: { kind: 'agent', key: 0 },
      agent: {} as never,
    })
    assert.equal(released.kind, 'applied')
    assert.equal(chain.command.tasksBrowserUiAvailable(), true)
    await waitUntil('the committed frame restores the badge action by itself', () => chain.tasksActionId() !== undefined)

    // 3. The restored action runs the registered handler exactly once.
    const sf = chain.pane.frames().at(-1)!.sf
    chain.pane.event({ ev: 'action', sf, id: chain.tasksActionId()!, act: TASKS_ACTION })
    await waitUntil('the registered /tasks opener ran', () => chain.tasksOpens.length === 1)
  } finally {
    await chain.dispose()
  }
})
