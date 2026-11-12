/**
 * M5-U-C — the cross-layer Session Workspace lifecycle: the real command
 * registrar, the ONE `SessionBrowserReadOwner`, the ONE fullscreen physical
 * lease and the ONE per-open official Workspace follow.
 *
 * These cases own the L6 owner/physical-lease contract: the real `/sessions`
 * dispatch opens a leased screen (never the retired picker), Current is proved
 * only from official Workspace membership, the global search ignores the browse
 * scope, a resume only succeeds on the runtime's `committed`, and every close
 * path disposes the follow generation exactly once. The presentation contract
 * lives in `test/tui/session-workspace-panel.test.ts`; the two fail for
 * different reasons on purpose.
 * @module @xmoon76/dsh-pi-tui/session-workspace-lifecycle.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { CommandId, parseCommand } from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { createSessionCommands } from '../../src/tui/commands/sessions.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp, type EditorWorkspaceEntryControl, type SubagentViewerTarget } from '../../src/tui-app.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import type { SessionContentSearchPage, SessionReader, SessionSummary } from '../../src/runtime/session-reader-port.ts'
import type {
  SessionActivityFact,
  SessionWorkspaceFact,
  SessionWorkspaceFactsPort,
  WorkspaceFactsFrame,
  WorkspaceFactsHandle,
} from '../../src/runtime/session-workspace-facts-port.ts'
import type {
  SessionBrowserAnswerEligibility,
  SessionBrowserPresentation,
  SessionBrowserReadSnapshot,
} from '../../src/app/command/session-browser-presentation.ts'
import type { SessionSwitchOutcome } from '../../src/app/session/runtime.ts'
import type { SessionScope } from '../../src/app/session/scope.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { cancellationError } from '../../src/runtime/process/tasks.ts'
import { EditorRegistry } from '../../src/extension/internal/editor-registry.ts'
import { AdvancedInputRegistry } from '../../src/extension/internal/advanced-input.ts'
import { normalizeInputEvent } from '../../src/extension/internal/input-events.ts'
import type { HistoryOpenScope } from '../../src/tui-app.ts'
import type { HistorySearchSource } from '../../src/client/history/search.ts'
import type { SettingsWorkspaceSource } from '../../src/tui/panels/settings-workspace-panel.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { createWorkspaceNextIntentOwner } from '../../src/app/session/workspace-next-intent.ts'
import { LifecycleError, WorkspaceSelectionError } from '../../src/runtime/session-lifecycle-port.ts'
import type { HostDirectoryBrowseOutcome } from '../../src/runtime/host-directory-browse-port.ts'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { unavailableWebAccess } from '../support/web-access-fake.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started, disposeAll } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeAll()
})

const CURRENT = 'session-current-session'
const OTHER = 'session-other-session'
const THIRD = 'session-third-session'

async function waitUntil(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error(`${label}: waitUntil timed out after ${timeoutMs}ms`)
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }
}

/** A caller-held Workspace follow whose frames are delivered explicitly, so a
 *  case can prove WHEN a frame really reaches (or cannot reach) the UI. */
class ControlledFactsHandle implements WorkspaceFactsHandle {
  disposed = 0
  private readonly queue: WorkspaceFactsFrame[] = []
  private resolveNext: ((result: IteratorResult<WorkspaceFactsFrame>) => void) | undefined
  private rejectNext: ((error: unknown) => void) | undefined
  private done = false
  private readonly signal: AbortSignal | undefined

  constructor(signal: AbortSignal | undefined) {
    this.signal = signal
  }

  push(frame: WorkspaceFactsFrame): void {
    if (this.done || this.signal?.aborted === true) return
    const resolve = this.resolveNext
    if (resolve !== undefined) {
      this.resolveNext = undefined
      resolve({ done: false, value: frame })
      return
    }
    this.queue.push(frame)
  }

  /** The official stream ENDS normally (no error): the membership proof is
   *  gone even though nothing threw. */
  finish(): void {
    if (this.done) return
    this.done = true
    const resolve = this.resolveNext
    this.resolveNext = undefined
    this.rejectNext = undefined
    resolve?.({ done: true, value: undefined })
  }

  /** The official stream fails with a real generation/transport error. */
  fail(error: unknown): void {
    if (this.done) return
    this.done = true
    const reject = this.rejectNext
    this.resolveNext = undefined
    this.rejectNext = undefined
    reject?.(error)
  }

  dispose(): void {
    this.disposed += 1
    this.done = true
    const resolve = this.resolveNext
    this.resolveNext = undefined
    this.rejectNext = undefined
    resolve?.({ done: true, value: undefined })
  }

  async *[Symbol.asyncIterator](): AsyncIterator<WorkspaceFactsFrame> {
    while (!this.done) {
      if (this.signal?.aborted === true) return
      const queued = this.queue.shift()
      if (queued !== undefined) {
        yield queued
        continue
      }
      const next = await new Promise<IteratorResult<WorkspaceFactsFrame>>((resolve, reject) => {
        this.resolveNext = resolve
        this.rejectNext = reject
      })
      if (next.done === true) return
      yield next.value
    }
  }
}

interface FactsSource {
  readonly port: SessionWorkspaceFactsPort
  readonly handles: ControlledFactsHandle[]
  readonly followCalls: number
  /** Every official Activity sample the workspace requested, in order. */
  readonly reads: Array<{ readonly rows: readonly SessionSummary[]; readonly signal: AbortSignal | undefined }>
  setFacts(facts: readonly SessionActivityFact[]): void
  failNext(error: Error): void
  /** Hold the NEXT sample open until `releaseHeld()`. */
  holdNext(): void
  releaseHeld(): void
}

function factsSource(initial: readonly SessionActivityFact[] = []): FactsSource {
  const handles: ControlledFactsHandle[] = []
  const reads: Array<{ rows: readonly SessionSummary[]; signal: AbortSignal | undefined }> = []
  const state = {
    followCalls: 0,
    facts: initial,
    failNext: undefined as Error | undefined,
    hold: false,
    held: [] as Array<() => void>,
  }
  const port: SessionWorkspaceFactsPort = {
    readActivity: (rows, signal) => {
      reads.push({ rows, signal })
      const failure = state.failNext
      if (failure !== undefined) {
        state.failNext = undefined
        return Promise.reject(failure)
      }
      const facts = state.facts
      if (!state.hold) return Promise.resolve(facts)
      return new Promise((resolve, reject) => {
        state.held.push(() => resolve(facts))
        signal?.addEventListener('abort', () => reject(new Error('activity read aborted')), { once: true })
      })
    },
    followWorkspaces: (signal) => {
      state.followCalls += 1
      const handle = new ControlledFactsHandle(signal)
      handles.push(handle)
      return handle
    },
  }
  return {
    port,
    handles,
    reads,
    get followCalls() { return state.followCalls },
    setFacts: (facts) => { state.facts = facts },
    failNext: (error) => { state.failNext = error },
    holdNext: () => { state.hold = true },
    releaseHeld: () => {
      state.hold = false
      const held = state.held.splice(0)
      for (const release of held) release()
    },
  }
}

function row(id: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
  return { id, updatedAt, createdAt: updatedAt, cwd: '/ws', live: false, ...extra }
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly runner: TuiCommandRunner
  readonly facts: FactsSource
  readonly switchCalls: Array<{ readonly id: string; readonly scope: SessionScope | undefined }>
  readonly pickerCalls: number
  /** Every official roster read this open performed (initial + refreshes). */
  readonly listCalls: number
  readonly notices: Array<{ readonly text: string; readonly kind: string }>
  /** Fire the Client-root eligibility invalidation the delivery owner emits. */
  notifyEligibility(): void
  settleSwitch(outcome: SessionSwitchOutcome): void
  runSessions(rawInput?: string): Promise<{ kind: 'success' } | { kind: 'error'; text: string }>
  /** Run any command registered by this harness (e.g. `/search`). */
  runCommand(name: string, rawInput?: string): Promise<{ kind: 'success' } | { kind: 'error'; text: string }>
  /** The Opened `/sessions` UI body, exactly as the CommandSurface calls it. */
  openSessionBrowser(scope?: 'current' | 'all' | { readonly scope?: 'current' | 'all'; readonly addDirectory?: boolean }): Promise<{ kind: 'success' } | { kind: 'error'; text: string }>
  /** Install/replace/clear the ONE Host Editor `←←` control, as bootstrap does. */
  installControl(control?: EditorWorkspaceEntryControl): void
  /** ONE raw terminal Left press through the real input listener. */
  pressLeft(): void
  /** Final disposal of THIS harness's TuiApp (the process slot is global). */
  close(): void
  view(): string
  setAgent(id: string | undefined): void
}

function harness(options: {
  readonly currentSessionId?: string
  readonly rows?: readonly SessionSummary[]
  readonly list?: () => Promise<readonly SessionSummary[]>
  readonly search?: (query: string, signal?: AbortSignal) => Promise<SessionContentSearchPage | undefined>
  readonly nativePresentation?: SessionBrowserPresentation
  /** The Client-root forwarded-answer eligibility read view (G567). Absent on
   *  the Direct/TSP composition. */
  readonly eligibility?: () => readonly SessionBrowserAnswerEligibility[]
  readonly initialFacts?: readonly SessionActivityFact[]
  /** Replace the one projection batch reader (the default resolves titles). */
  readonly projection?: () => Promise<Map<string, { readonly title?: string; readonly preset?: string }>>
  /** The real `/sessions` registration's own availability fact (E-L9). */
  readonly browserAvailable?: () => boolean
  /** A mounted TuiApp WITHOUT the composition control (the PiTUI window
   *  before the post-registration install, E-L10). */
  readonly installControl?: false
  /** A real extension editor registry, installed BEFORE the surface starts
   *  (the replacement-editor seat, E-L6). */
  readonly editorRegistry?: EditorRegistry
  /** The real History-seat search source and scope capture (E-L6). */
  readonly historySearchSource?: HistorySearchSource
  readonly historySearchCwd?: () => string
  readonly captureHistoryScope?: () => HistoryOpenScope
  /** A staged image-only draft fact (the runner's `events.isImageDraft`). */
  readonly isImageDraft?: () => boolean
  /** The Unstable raw interception stage (E-L8 consume/rewrite). */
  readonly unstableInputRoute?: (data: string) => import('../../src/extension/internal/unstable-input.ts').UnstableRawRouteResult
  /** The real Advanced input capture registry route (E-L13). */
  readonly advancedInputRoute?: (data: string) => 'consumed' | 'passed'
  /** The ONE Agents port seam the Folder-New transaction calls. */
  readonly agents?: Partial<TuiCommandRunner['agents']>
  /** The ONE transition seam the Folder-New transaction calls. */
  readonly transitionTo?: TuiCommandRunner['transitionTo']
  /** The runner's lifetime signal (cancellation tests). */
  readonly signal?: AbortSignal
  /** PR3: the ONE Host directory browse seam this harness composes. */
  readonly hostDirectoryBrowse?: TuiCommandRunner['hostDirectoryBrowse']
  /** The physical frame size this mount paints (default 100x30). */
  readonly frameColumns?: number
  readonly frameRows?: number
  /** PR3: the intent owner whose commit ordering the case asserts. */
  readonly workspaceNextIntent?: TuiCommandRunner['workspaceNextIntent']
  /** F5-B: the Host-file port the runner's `@` completion consumes (a spy in
   *  the review-P1 identity-rule case). */
  readonly hostFile?: TuiCommandRunner['hostFile']
  /** F5-B review EXT-P2: the create-side AUTO evidence check (`/new`). */
  readonly validateAutoWorkspace?: () => boolean
  /** F5-B review EXT-P2: the FINAL default-write wait before a create. */
  readonly awaitPendingDefaultWrite?: (signal: AbortSignal) => Promise<void>
}): Harness {
  const vt = new VirtualTerminal(options.frameColumns ?? 100, options.frameRows ?? 30)
  const app = new TuiApp(
    vt,
    {
      onSubmit: () => {},
      onExit: () => {},
      ...(options.isImageDraft === undefined ? {} : { isImageDraft: options.isImageDraft }),
    },
    {
      notifyDurationMs: 60_000,
      ...(options.unstableInputRoute === undefined ? {} : {
        unstableInputRoute: (data: string) => options.unstableInputRoute!(data),
        unstableInputsLive: () => true,
      }),
      ...(options.advancedInputRoute === undefined ? {} : { advancedInputRoute: options.advancedInputRoute }),
      ...(options.editorRegistry === undefined ? {} : { editorRegistry: options.editorRegistry }),
      ...(options.historySearchSource === undefined ? {} : { historySearchSource: options.historySearchSource }),
      ...(options.historySearchCwd === undefined ? {} : { historySearchCwd: options.historySearchCwd }),
      ...(options.captureHistoryScope === undefined ? {} : { captureHistoryScope: options.captureHistoryScope }),
    },
  )
  app.start()
  started.add(app)
  const facts = factsSource(options.initialFacts ?? [])
  const eligibilityListeners = new Set<() => void>()
  const notices: Array<{ text: string; kind: string }> = []
  const originalNotify = app.notify.bind(app)
  app.notify = (text, kind = 'info') => {
    notices.push({ text, kind })
    originalNotify(text, kind)
  }
  const picker = { calls: 0 }
  const originalOpenPicker = app.openPicker.bind(app)
  app.openPicker = ((...args: never[]) => {
    picker.calls += 1
    return (originalOpenPicker as (...inner: never[]) => unknown)(...args)
  }) as typeof app.openPicker

  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (def: { name: string; handler?: unknown }): (() => void) => {
      defs.push(def)
      return () => {}
    },
    list: () => [],
    find: () => undefined,
    execute: async () => undefined,
  }
  const ctx = new Context()
  ctx.provide('commands', commands as never)
  const state: { agent: Agent | undefined } = {
    agent: options.currentSessionId === undefined
      ? undefined
      : { session: { id: options.currentSessionId } } as unknown as Agent,
  }
  const switchCalls: Array<{ id: string; scope: SessionScope | undefined }> = []
  let pendingSwitch: ((outcome: SessionSwitchOutcome) => void) | undefined
  const rows = options.rows ?? [
    row(CURRENT, 3_000),
    row(OTHER, 2_000),
    row(THIRD, 1_000),
  ]
  const listCalls = { value: 0 }
  const sessionReader: SessionReader = {
    list: options.list === undefined
      ? async () => { listCalls.value += 1; return rows.map(entry => ({ ...entry })) }
      : async () => { listCalls.value += 1; return (await options.list!()).map(entry => ({ ...entry })) },
    projectionBatch: options.projection ?? (async () => new Map([
      [CURRENT, { title: 'Current session' }],
      [OTHER, { title: 'Other session' }],
      [THIRD, { title: 'Third session' }],
    ])),
    search: options.search ?? (async () => ({ items: [], hasMore: false })),
    blank: () => undefined,
    measureContext: () => undefined,
    turnOutline: () => undefined,
    sessionStatus: () => undefined,
  }
  const runner: TuiCommandRunner = {
    webAccess: unavailableWebAccess(),
    beginClientWrite: () => () => {},
    deliveredFilesSnapshot: () => undefined,
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get defaultIntentOutcome() { return undefined },
    openScheduleWorkspace: () => ({ kind: 'success' } as const),
    ...sessionScopeFacts(() => state.agent, () => 1),
    sessionWorkspaceFacts: facts.port,
    ...(options.hostDirectoryBrowse === undefined ? {} : { hostDirectoryBrowse: options.hostDirectoryBrowse }),
    ...(options.workspaceNextIntent === undefined ? {} : { workspaceNextIntent: options.workspaceNextIntent }),
    ...(options.validateAutoWorkspace === undefined ? {} : { validateAutoWorkspace: options.validateAutoWorkspace }),
    ...(options.nativePresentation === undefined ? {} : { sessionBrowserPresentation: options.nativePresentation }),
    ...(options.eligibility === undefined ? {} : {
      forwardedAnswerEligibility: options.eligibility,
      subscribeForwardedAnswerEligibility: (listener: () => void) => {
        eligibilityListeners.add(listener)
        return () => { eligibilityListeners.delete(listener) }
      },
    }),
    get currentSessionId() { return state.agent?.session.id },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: undefined,
    agents: { ...(options.agents ?? {}) } as never,
    sessionReader,
    sessionWriter: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    interaction: {
      questions: {
        onRequest: () => true,
        subscribe: () => undefined,
        snapshot: () => undefined,
        claimTimedWait: async () => undefined,
        answerContinued: async () => 'not-continued' as const,
      },
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as never,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostFile: options.hostFile ?? new DirectHostFilePort(() => undefined),
    hostShellCompletion: { pathAuthority: 'client', complete: async () => ({ kind: 'ok', candidates: [] }) },
    requestExit: () => {},
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: options.signal ?? new AbortController().signal,
    switchSession: async () => undefined,
    switchSessionOutcome: async (id: string, scope?: SessionScope): Promise<SessionSwitchOutcome> => {
      switchCalls.push({ id, scope })
      return new Promise<SessionSwitchOutcome>((resolve) => { pendingSwitch = resolve })
    },
    transitionTo: options.transitionTo ?? (async <T>(steps: { create: () => Promise<T> }) => ({ ok: true, next: await steps.create() })),
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    awaitPendingDefaultWrite: options.awaitPendingDefaultWrite ?? (async () => {}),
    trackDefaultWrite: () => {},
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    applyFooterSettings: () => {},
    progressUpdatesState: { mode: 'milestones' },
    responseStyleState: { style: 'default' },
    gitAttributionState: { mode: 'off' },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {},
    currentNotificationMode: () => 'unfocused',
    currentNotificationMethod: () => 'auto',
    setTerminalProgressMode: () => {},
    setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    extensions: undefined,
    exit: () => {},
  }
  const installed = registerTuiCommandsWithDirectSeams(runner)
  const def = defs.find(entry => entry.name === 'sessions')
  assert.ok(def?.handler !== undefined, 'the sessions command must register')
  type CommandOutcome = { kind: 'success' } | { kind: 'error'; text: string }
  const invokeDefinition = (target: { handler?: unknown }, rawInput: string): Promise<CommandOutcome> =>
    (target.handler as (inv: { commandId: ReturnType<typeof CommandId>; agent: never; rawInput: string; signal: AbortSignal }) => Promise<CommandOutcome>)({
      commandId: CommandId('cmd-workspace-test'),
      agent: undefined as never,
      rawInput,
      signal: new AbortController().signal,
    })
  const invoke = (rawInput: string): Promise<CommandOutcome> => invokeDefinition(def!, rawInput)
  const openSessionBrowser = (scope?: 'current' | 'all' | { readonly scope?: 'current' | 'all'; readonly addDirectory?: boolean }): Promise<CommandOutcome> => {
    const opened = installed.openSessionBrowser
    assert.ok(opened !== undefined, 'the registered /sessions UI body must exist')
    const result = opened(scope)
    // The CommandSurface's own observer: a command error is ONE notice and
    // never an unhandled rejection (the production entry does exactly this).
    void result.then((outcome) => {
      if (outcome.kind === 'error' && outcome.text !== '') app.notify(outcome.text, 'error')
    }, (error: unknown) => { app.notify(`session browser UI entry failed: ${String(error)}`, 'error') })
    return result
  }
  const installControl = (control?: EditorWorkspaceEntryControl): void => {
    app.setEditorWorkspaceEntry(control === undefined ? undefined : {
      available: control.available,
      captureIsCurrent: () => {
        const token = runner.captureSessionScope()
        return () => runner.isSessionScopeCurrent(token)
      },
      openAll: control.openAll,
    })
  }
  // The production bootstrap installs this control after the `/sessions`
  // registration settled, on every PiTUI mount (Direct and Split).
  if (options.installControl !== false) {
    installControl({
      available: options.browserAvailable ?? (() => true),
      captureIsCurrent: () => () => true,
      openAll: () => { void openSessionBrowser('all') },
    })
  }
  return {
    vt,
    app,
    runner,
    facts,
    switchCalls,
    get pickerCalls() { return picker.calls },
    get listCalls() { return listCalls.value },
    notices,
    notifyEligibility: () => { for (const listener of [...eligibilityListeners]) listener() },
    settleSwitch: (outcome) => { assert.ok(pendingSwitch !== undefined, 'no accepted resume is pending'); pendingSwitch(outcome) },
    runSessions: invoke,
    runCommand: (name, rawInput = '') => {
      const command = defs.find(entry => entry.name === name)
      assert.ok(command?.handler !== undefined, `the ${name} command must register`)
      return invokeDefinition(command!, rawInput)
    },
    openSessionBrowser,
    installControl,
    pressLeft: () => { vt.sendInput('\x1b[D') },
    close: () => {
      started.delete(app)
      app.dispose()
    },
    view: () => vt.getViewport().map(stripTerminalSequences).join('\n'),
    setAgent: (id) => { state.agent = id === undefined ? undefined : { session: { id } } as unknown as Agent },
  }
}

const baseline = (...items: readonly SessionWorkspaceFact[]): WorkspaceFactsFrame => ({ type: 'baseline', items })

test('/sessions opens the ONE fullscreen lease and lists sibling official Workspace folders', async () => {
  let resolveList!: (rows: SessionSummary[]) => void
  const h = harness({
    currentSessionId: CURRENT,
    list: () => new Promise<readonly SessionSummary[]>(resolve => { resolveList = resolve }),
  })
  await h.runSessions('')
  await h.vt.waitForRender()
  const opened = h.view()
  assert.ok(opened.includes('Sessions'), `the fullscreen workspace is the physical owner:\n${opened}`)
  assert.ok(opened.includes('Loading sessions…'), 'the input-first loading frame paints before the Host list settles')
  assert.equal(h.pickerCalls, 0, 'the retired PiTUI picker must never open')
  assert.equal(h.facts.followCalls, 1, 'exactly ONE per-open Workspace follow starts after the lease')

  // Two Workspaces share the same cwd text; only official sessionIds prove membership.
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] },
    { workspaceId: 'ws-b', path: '/ws', title: 'project-b', sessionIds: [OTHER, THIRD] },
  ))
  resolveList([row(CURRENT, 3_000), row(OTHER, 2_000), row(THIRD, 1_000)])
  await waitUntil(() => h.view().includes('project-b · 2'), 'the official baseline resolves the tree')
  const scoped = h.view()
  assert.ok(/^[ >]*[▾▸] project-a · 1 · Current/m.test(scoped), `Current is the captured Session's official Folder:\n${scoped}`)
  assert.ok(scoped.includes('Current session'), 'the current Workspace member paints')
  assert.ok(scoped.includes('project-b · 2'), `a sibling Workspace Folder remains available:\n${scoped}`)
  assert.ok(!scoped.includes('Other session') && !scoped.includes('Third session'), 'non-current ordinary history remains behind its Show more watermark')

  // All restores every listed row; the App current Session and the switch route
  // are untouched by a UI scope change.
  h.vt.sendInput('w')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Search: w'), 'w is ordinary global query text, not a Workspace selector')
  assert.deepEqual(h.switchCalls, [], 'typing a query never changes Workspace or Session')
})

test('global search remains a flat union and Host-only hits still paint', async () => {
  const h = harness({
    currentSessionId: CURRENT,
    search: async () => ({ items: [{ sessionId: OTHER, snippet: 'host excerpt without the literal term' }], hasMore: false }),
  })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] },
    { workspaceId: 'ws-b', path: '/other', title: 'project-b', sessionIds: [OTHER] },
  ))
  await waitUntil(() => h.view().includes('project-a · 1'), 'the official baseline is proved')
  h.vt.sendInput('/')
  await h.vt.waitForRender()
  h.vt.sendInput('needle')
  await waitUntil(() => h.view().includes('host excerpt without the literal term'), 'the global Host hit paints')
  const view = h.view()
  assert.ok(view.includes('Search all workspaces'))
  assert.ok(view.includes('Other session'), 'a Host-only result from another Workspace paints')
  assert.ok(!view.includes('· needle'), 'the query is never appended to the Host result')
})

test('an interactive resume is successful only on the runtime committed outcome and closes the workspace once', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT, OTHER] },
  ))
  await waitUntil(() => h.view().includes('project-a · 2'), 'the official baseline is proved')
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await waitUntil(() => h.view().includes('Opening session…'), 'the accepted intent is pending, never a success')
  assert.equal(h.switchCalls.length, 1)
  assert.equal(h.switchCalls[0]!.id, OTHER)
  assert.equal(h.switchCalls[0]!.scope?.sessionId, CURRENT, 'the switch carries the captured pre-open SessionScope')

  // The runtime commits: the captured subject is retired BEFORE the settle, so
  // no stale screen may remain and no automatic retry may follow.
  h.setAgent(OTHER)
  h.settleSwitch({ kind: 'committed', sessionId: OTHER })
  await waitUntil(() => !h.view().includes('Opening session…'), 'the committed switch settles')
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'the workspace closes exactly once on the real committed outcome')
  assert.equal(h.switchCalls.length, 1, 'a committed switch is never retried')
  assert.equal(h.facts.handles[0]!.disposed, 1, 'the per-open Workspace follow is disposed once')
})
test('the current Session Return closes the real lease once with zero switch and an untouched draft', async () => {
  const h = harness({ currentSessionId: CURRENT })
  h.app.setDraft('draft stays byte-identical')
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] },
  ))
  await waitUntil(() => h.view().includes('project-a · 1'), 'the official baseline is proved')
  assert.ok(/^> {3}● current-/m.test(h.view()), `the current Session is the initial cursor:\n${h.view()}`)
  assert.ok(h.view().includes('Return [Enter]'), `the real screen advertises the Return verb:\n${h.view()}`)

  h.vt.sendInput('\r')
  await waitUntil(() => !h.view().includes('Sessions'), 'Return retires the fullscreen lease')
  await h.vt.waitForRender()
  assert.equal(h.app.isFullscreen(), false, 'the ONE fullscreen lease is gone')
  assert.deepEqual(h.switchCalls, [], 'Return never starts a Session switch')
  assert.equal(h.facts.handles[0]!.disposed, 1, 'the per-open Workspace follow is disposed exactly once')
  assert.equal(h.app.getDraft(), 'draft stays byte-identical', 'the draft is byte-identical after Return')
  assert.equal(h.runner.currentSessionId, CURRENT, 'the current Agent/Session identity is unchanged')
  assert.equal(h.listCalls, 1, 'Return performs no second roster read')

  // A late frame from the closed open can never repaint or reopen a Browser.
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] },
  ))
  h.facts.handles[0]!.finish()
  await new Promise<void>(resolve => setImmediate(resolve))
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'the retired open cannot paint a late frame')

  // Reopening starts ONE fresh Workspace follow; the old identity stays inert.
  await h.runSessions('')
  await h.vt.waitForRender()
  assert.equal(h.facts.followCalls, 2, 'the new open owns its own per-open follow')
  h.facts.handles[1]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] },
  ))
  await waitUntil(() => h.view().includes('project-a · 1'), 'the newer Browser proves its own baseline')
  assert.equal(h.facts.handles[1]!.disposed, 0, 'the newer follow stays live')
  assert.equal(h.facts.handles[0]!.disposed, 1, 'the old follow is still disposed exactly once')
  h.vt.sendInput('\r')
  await waitUntil(() => !h.view().includes('Sessions'), 'the newer Browser has its own Return')
  assert.equal(h.facts.handles[1]!.disposed, 1, 'the newer follow retires once with its own Return')
  assert.deepEqual(h.switchCalls, [], 'neither Return starts a Session switch')
})

test('a failed interactive resume keeps the workspace and never reports success or retries', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT, OTHER] },
  ))
  await waitUntil(() => h.view().includes('project-a · 2'), 'the official baseline is proved')
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await waitUntil(() => h.view().includes('Opening session…'), 'the intent is pending')
  h.settleSwitch({ kind: 'failed', message: 'switch refused by the Host' })
  await waitUntil(() => h.view().includes('switch refused by the Host'), 'the sanitized refusal is visible on the panel')
  const after = h.view()
  assert.ok(after.includes('Sessions'), 'a failed switch keeps the SAME workspace')
  assert.ok(!after.includes('Opening session…'), 'the pending state is cleared')
  // A failed/intermediate outcome must not schedule a retry: one event-loop
  // turn is enough for any synchronous or microtask continuation to dispatch.
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.switchCalls.length, 1, 'a failed switch is never retried automatically')
})

test('an indeterminate interactive resume is visible, stays open and never retries', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT, OTHER] },
  ))
  await waitUntil(() => h.view().includes('project-a · 2'), 'the official baseline is proved')
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await waitUntil(() => h.view().includes('Opening session…'), 'the intent is pending')
  h.settleSwitch({ kind: 'indeterminate', message: 'outcome unknown — do not retry automatically' })
  await waitUntil(() => h.view().includes('do not retry automatically'), 'the indeterminate result is visible')
  assert.ok(h.view().includes('Sessions'), 'the workspace stays as the authoritative current reading')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.switchCalls.length, 1, 'an indeterminate switch is never retried automatically')
})

test('the Folder New row hands the official workspaceId to the real command transaction and retires after commit', async () => {
  const resolutions: unknown[] = []
  const creates: Array<{ sessionId: string; workspaceId: string }> = []
  let resolveCreate!: (agent: unknown) => void
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async (intent: unknown) => {
        resolutions.push(intent)
        return { workspaceId: 'ws-a', path: '/ws' }
      }) as never,
      create: (async (input: { sessionId: string; workspaceId: string }) => {
        creates.push({ sessionId: input.sessionId, workspaceId: input.workspaceId })
        return await new Promise<unknown>((resolve) => { resolveCreate = resolve })
      }) as never,
    },
  })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] },
  ))
  await waitUntil(() => h.view().includes('project-a · 1'), 'the official baseline is proved')
  // Root Add -> the current Folder -> its first-child New row.
  h.vt.sendInput('\x1b[H')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await waitUntil(() => creates.length === 1, 'the Folder New reaches the real create transaction')
  assert.deepEqual(resolutions, [{ kind: 'workspace-id', workspaceId: 'ws-a' }],
    'the panel handed the OFFICIAL Workspace id, never a cwd')
  assert.equal(creates[0]!.workspaceId, 'ws-a', 'the Host receives the official Workspace identity')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Starting session…'), 'the pending state is painted until the real commit')
  resolveCreate({ session: { id: creates[0]!.sessionId } })
  await waitUntil(() => !h.view().includes('Sessions'), 'the committed switch retires the Browser')
  assert.equal(h.facts.handles[0]!.disposed, 1, 'the per-open Workspace follow is disposed once')
  assert.equal(creates.length, 1, 'a committed Folder New is never retried')
})

test('a command-refused Folder New keeps the Browser and releases the pending lock for a retry', async () => {
  let attempts = 0
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async () => {
        attempts += 1
        throw new Error('workspace refused by the Host')
      }) as never,
    },
  })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] }))
  await waitUntil(() => h.view().includes('project-a · 1'), 'the official baseline is proved')
  h.vt.sendInput('\x1b[H')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await waitUntil(() => h.notices.some(notice => notice.text.includes('workspace refused by the Host')),
    'the real command refusal is the ONE visible error')
  const after = h.view()
  assert.ok(after.includes('Sessions'), 'a refused create keeps the Browser open')
  assert.ok(!after.includes('Starting session…'), 'the refusal settles the pending operation')
  assert.ok(after.split('\n').at(-1)!.includes('Enter New session'), 'the failed New is immediately retryable')
  h.vt.sendInput('\r')
  await waitUntil(() => attempts === 2, 'a deliberate retry reaches the command transaction once')
  assert.equal(h.facts.handles[0]!.disposed, 0, 'a refused create never retires the Workspace follow')
})

test('a silent superseded Folder New is not mistaken for a commit', async () => {
  const { LifecycleError } = await import('../../src/runtime/session-lifecycle-port.ts')
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async () => ({ workspaceId: 'ws-a', path: '/ws' })) as never,
    },
    transitionTo: (async () => ({
      ok: false,
      error: new LifecycleError('superseded', 'superseded', 'the local surface was superseded'),
    })) as never,
  })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] }))
  await waitUntil(() => h.view().includes('project-a · 1'), 'the official baseline is proved')
  h.vt.sendInput('\x1b[H')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await waitUntil(() => !h.view().includes('Starting session…'), 'the superseded operation is released')
  const after = h.view()
  assert.ok(after.includes('Sessions'), 'a silent superseded result never closes the Browser')
  assert.ok(!after.includes('Starting session…'), 'the superseded operation is released, not left pending')
  assert.equal(h.notices.some(notice => notice.text.includes('superseded')), false,
    'a silent supersession produces no success or fabricated failure notice')
})

test('a cancelled Folder New releases the live pending operation without a guessed outcome', async () => {
  let rejectCreate: ((error: unknown) => void) | undefined
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async () => ({ workspaceId: 'ws-a', path: '/ws' })) as never,
      create: (async () => await new Promise((_, reject) => { rejectCreate = reject })) as never,
    },
  })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] }))
  await waitUntil(() => h.view().includes('project-a · 1'), 'the official baseline is proved')
  h.vt.sendInput('\x1b[H')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await waitUntil(() => h.view().includes('Starting session…'), 'the create is pending')
  rejectCreate!(cancellationError('cancelled by the owner'))
  await waitUntil(() => !h.view().includes('Starting session…'), 'cancellation releases the pending lock')
  assert.ok(h.view().includes('Sessions'), 'the cancelled create never closes the Browser')
  assert.equal(h.facts.handles[0]!.disposed, 0, 'the follow stays alive for the next deliberate operation')
})

test('a cancelled Folder New during Workspace resolution is a cancellation, not a failure', async () => {
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async () => { throw cancellationError('cancelled during resolution') }) as never,
    },
  })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] }))
  await waitUntil(() => h.view().includes('project-a · 1'), 'the official baseline is proved')
  h.vt.sendInput('\x1b[H')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[C')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await waitUntil(() => !h.view().includes('Starting session…'), 'the cancelled resolution releases the pending lock')
  assert.ok(h.view().includes('Sessions'), 'a cancelled resolution keeps the Browser open')
  assert.equal(h.notices.some(notice => notice.kind === 'error'), false,
    'a cancelled resolution is never a user-visible failure')
  assert.equal(h.facts.handles[0]!.disposed, 0, 'the follow stays alive after the cancellation')
})

test('a blocking Question pre-empts the workspace, and a refused lease leaves no hidden reader', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Sessions'))

  const questions = h.app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await h.vt.waitForRender()
  assert.ok(h.view().includes('proceed?'), 'the blocking owner mounts on the restored surface')
  assert.ok(!h.view().includes('Sessions'), 'the workspace is closed BEFORE the question claims the seat')
  assert.equal(h.facts.handles[0]!.disposed, 1, 'the per-open follow is released exactly once')

  const refused = await h.runSessions('')
  assert.equal(refused.kind, 'error', 'a new lease while a blocking owner owns the seat is refused')
  assert.match(refused.kind === 'error' ? refused.text : '', /session workspace unavailable/u)
  assert.equal(h.facts.followCalls, 1, 'a refused lease never starts a Workspace follow')
  assert.equal(h.pickerCalls, 0, 'a refused lease never falls back to the retired picker')

  h.vt.sendInput('\x1b')
  await questions.catch(() => {})
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'the refused workspace never resurrects')
})

test('a normally ended official Workspace stream drops the membership annotation', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] },
    { workspaceId: 'ws-b', path: '/other', title: 'b', sessionIds: [OTHER] },
  ))
  await waitUntil(() => h.view().includes('a · 1'), 'the official baseline is proved')
  // The official Remote handle may end iterating after a valid baseline without
  // throwing; the proof is still gone.
  h.facts.handles[0]!.finish()
  await waitUntil(() => h.view().includes('Workspace membership unavailable'), 'the ended stream is visible')
  const after = h.view()
  assert.ok(after.includes('Workspace membership unavailable'), 'an ended stream paints the ONE unavailable membership fact')
  assert.ok(!after.includes('project'), 'the ended stream paints no folder claim')
  assert.ok(after.includes('Other session'), 'All restores every listed row')
})

test('missing Current membership does not filter the Workspace-first browser and stream end replaces its annotation', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-b', path: '/other', title: 'b', sessionIds: [OTHER] }))
  await waitUntil(() => h.view().includes('Current workspace unavailable — showing all workspaces'), 'unproven Current membership is stated once')
  assert.ok(h.view().includes('b · 1'), `the official other Workspace Folder stays in the same browser:\n${h.view()}`)
  h.facts.handles[0]!.finish()
  await waitUntil(() => h.view().includes('Workspace membership unavailable'), 'the ended stream is visible')
  const after = h.view()
  assert.ok(after.includes('Workspace membership unavailable'))
  assert.equal(after.split('\n').filter(line => line.includes('Current workspace unavailable')).length, 0)
  assert.equal(after.split('\n').filter(line => line.includes('Workspace membership unavailable')).length, 1)
})

test('a failed official Workspace stream keeps the roster usable without membership claims', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] }))
  await waitUntil(() => h.view().includes('a · 1'), 'the official baseline is proved')
  h.facts.handles[0]!.fail(new Error('workspace generation superseded'))
  await waitUntil(() => h.view().includes('Workspace membership unavailable'), 'the failed stream is visible')
  assert.ok(h.view().includes('Workspace membership unavailable'), 'a failed stream removes the folder authority')
  assert.ok(h.view().includes('Current session'), 'the retained flat session roster remains navigable')
})

test('an active close owns the stream end and paints no stale scope failure', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] }))
  await waitUntil(() => h.view().includes('a · 1'), 'the official baseline is proved')
  h.vt.sendInput('\x1b') // the user closes the workspace
  await h.vt.waitForRender()
  assert.equal(h.facts.handles[0]!.disposed, 1, 'the active close disposes the follow exactly once')
  h.facts.handles[0]!.finish() // a late normal end after the close
  await h.vt.waitForRender()
  assert.equal(
    h.notices.some(notice => notice.text.includes('Workspace information unavailable')),
    false,
    'an active close never paints a stale scope failure',
  )
})

test('stop/dispose closes the lease and the Workspace stream exactly once', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Sessions'))
  h.app.stop()
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.facts.handles[0]!.disposed, 1, 'stopping the surface disposes the follow exactly once')
})

test('the native TSP presenter consumes the shared Browser Workspace facts once', async () => {
  const opens: SessionBrowserReadSnapshot[] = []
  const presentation: SessionBrowserPresentation = {
    open: (request) => {
      void opens
      return {
        isDisposed: () => false,
        setSnapshot: () => {},
        close: () => { request.onClose() },
      }
    },
    notify: () => {},
  }
  const h = harness({ currentSessionId: CURRENT, nativePresentation: presentation })
  await h.runSessions('')
  await h.vt.waitForRender()
  assert.equal(h.facts.followCalls, 1, 'the shared Browser read owner opens exactly one Workspace follow')
  assert.equal(h.facts.reads.length, 1, 'the shared Browser read owner samples Activity once')
  assert.equal(h.pickerCalls, 0)
})

// ── M5-U-D: the ONE Activity sample, its fences and the eligibility gate ─────

function activityFact(sessionId: string, extra: Partial<SessionActivityFact> = {}): SessionActivityFact {
  return {
    sessionId,
    running: undefined,
    pendingKinds: undefined,
    continuedQuestionCallIds: undefined,
    attention: 'unknown',
    attentionSourceState: 'unknown',
    ...extra,
  }
}

function questionFact(sessionId: string): SessionActivityFact {
  return activityFact(sessionId, {
    running: false,
    pendingKinds: ['question'],
    continuedQuestionCallIds: [],
    attention: 'question',
    attentionSourceState: 'known',
  })
}

test('the workspace samples Activity ONCE per accepted roster revision, on the read owner roster', async () => {
  const h = harness({
    currentSessionId: CURRENT,
    initialFacts: [questionFact(CURRENT)],
    eligibility: () => [{ sessionId: CURRENT, kind: 'question', live: true }],
  })
  await h.runSessions('')
  await waitUntil(() => h.view().includes('Needs attention'), 'the proved need paints')
  assert.equal(h.facts.reads.length, 1, 'one accepted roster revision = exactly ONE Activity sample')
  assert.deepEqual(
    h.facts.reads[0]!.rows.map(entry => entry.id),
    [CURRENT, OTHER, THIRD],
    'the sample consumes the ORIGINAL roster array the read owner listed',
  )
  assert.deepEqual(h.switchCalls, [], 'sampling never switches, opens or answers a Session')
  // The progressive projection batch repaints titles: a repaint must never
  // re-read the same batch.
  await waitUntil(() => h.view().includes('Current session'), 'the projection titles land')
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(h.facts.reads.length, 1, 'a projection repaint never re-samples Activity')
})

test('an eligibility loss drops the Needs row immediately and asks for ONE early roster refresh', async () => {
  let eligible: readonly SessionBrowserAnswerEligibility[] = [{ sessionId: CURRENT, kind: 'question', live: true }]
  const h = harness({
    currentSessionId: CURRENT,
    initialFacts: [questionFact(CURRENT)],
    eligibility: () => eligible,
  })
  await h.runSessions('')
  await waitUntil(() => h.view().includes('Needs attention'), 'the proved need paints')
  const listCalls = h.listCalls
  // The user is ACTIVELY browsing (a fresh keyboard gesture) when another
  // Client wins the official request. The Needs group must drop in the SAME
  // frame of the invalidation: a revocation is a fact, not an animation.
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.facts.holdNext()
  h.facts.setFacts([activityFact(CURRENT, { attention: 'none', attentionSourceState: 'known' })])
  eligible = []
  h.notifyEligibility()
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Needs attention'),
    `a revoked need never survives a busy cursor:\n${h.view()}`)
  assert.equal(h.listCalls, listCalls + 1, 'the early refresh goes through the ONE read owner generation')
  await waitUntil(() => h.facts.reads.length === 2, 'the refreshed roster triggers its own Activity sample')
  h.facts.releaseHeld()
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Needs attention'), 'the refreshed sample confirms no proved need')
})

test('closing the workspace aborts the in-flight Activity sample and publishes nothing', async () => {
  const h = harness({ currentSessionId: CURRENT })
  h.facts.holdNext()
  await h.runSessions('')
  await waitUntil(() => h.facts.reads.length === 1, 'the Activity sample starts')
  const signal = h.facts.reads[0]!.signal
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.equal(signal?.aborted, true, 'the physical lease close aborts the in-flight sample')
  assert.equal(h.facts.handles[0]!.disposed, 1, 'the per-open Workspace follow is disposed once')
  h.facts.releaseHeld()
  await new Promise<void>(resolve => setImmediate(resolve))
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'a late sample result never resurrects the closed workspace')
})

test('a newer accepted roster revision supersedes the in-flight sample', async () => {
  const h = harness({ currentSessionId: CURRENT, eligibility: () => [] })
  h.facts.holdNext()
  await h.runSessions('')
  await waitUntil(() => h.facts.reads.length === 1, 'the first Activity sample starts')
  const first = h.facts.reads[0]!.signal
  h.notifyEligibility()
  await waitUntil(() => h.facts.reads.length === 2, 'the refreshed roster samples again')
  assert.equal(first?.aborted, true, 'the superseded sample is aborted')
  h.facts.releaseHeld()
  await new Promise<void>(resolve => setImmediate(resolve))
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Activity unavailable'), 'an aborted sample is a cancellation, never a visible failure')
  assert.ok(h.view().includes('Current session'), 'the roster survives the superseded sample')
})

test('a failed Activity sample is ONE nonfatal line and keeps the roster and a Resume usable', async () => {
  const h = harness({ currentSessionId: CURRENT })
  h.facts.failNext(new Error('activity read exploded'))
  await h.runSessions('')
  await waitUntil(() => h.view().includes('Activity unavailable: activity read exploded'),
    'the sample failure is visible as one nonfatal line')
  assert.ok(h.view().includes('Current session'), 'the roster is never emptied by a failed sample')
  h.vt.sendInput('\x1b[B')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await waitUntil(() => h.switchCalls.length === 1, 'a Resume still reaches the runtime after a failed sample')
  h.settleSwitch({ kind: 'failed', message: 'refused by the Host' })
})

test('a newer accepted roster revision never paints the previous sample as a Needs promise', async () => {
  const h = harness({
    currentSessionId: CURRENT,
    initialFacts: [questionFact(CURRENT)],
    eligibility: () => [{ sessionId: CURRENT, kind: 'question', live: true }],
  })
  await h.runSessions('')
  await waitUntil(() => h.view().includes('Needs attention'), 'the first revision sample paints')
  // The next roster revision's sample is held. The previous sample belongs to
  // the OLD roster: an old positive Pending is not a current promise.
  h.facts.holdNext()
  h.notifyEligibility()
  await waitUntil(() => h.facts.reads.length === 2, 'the refreshed roster starts its OWN sample')
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Needs attention'),
    `the previous revision needs survived into the new roster:\n${h.view()}`)
  h.facts.releaseHeld()
  await waitUntil(() => h.view().includes('Needs attention'), 'the new revision sample re-proves the need')
})

test('a stale projection batch never enriches a newer accepted roster', async () => {
  const pending: Array<(projections: Map<string, { readonly title?: string; readonly preset?: string }>) => void> = []
  const h = harness({
    currentSessionId: CURRENT,
    eligibility: () => [],
    projection: () => new Promise(resolve => { pending.push(resolve) }),
  })
  await h.runSessions('')
  await waitUntil(() => pending.length === 1, 'the first projection batch starts')
  h.notifyEligibility() // the ONE early roster refresh
  await waitUntil(() => pending.length === 2, 'the newer roster starts its own projection batch')
  pending[0]!(new Map([[CURRENT, { title: 'Stale title' }]]))
  await new Promise<void>(resolve => setImmediate(resolve))
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Stale title'),
    `a batch read from the superseded roster never enriched the new one:\n${h.view()}`)
  pending[1]!(new Map([[CURRENT, { title: 'Fresh title' }]]))
  await waitUntil(() => h.view().includes('Fresh title'), 'the current roster batch enriches the rows')
})

test('a roster refresh drops search results for removed Sessions before the next Host search', async () => {
  let listed: readonly SessionSummary[] = [row(CURRENT, 3_000), row(OTHER, 2_000)]
  let searchCalls = 0
  const heldSearches: Array<() => void> = []
  const h = harness({
    currentSessionId: CURRENT,
    eligibility: () => [],
    list: async () => listed,
    // The projection batch is held FOREVER: no later enrichment may filter the
    // search results for us, so only the accepted roster can close them.
    projection: () => new Promise(() => {}),
    search: async () => {
      searchCalls += 1
      if (searchCalls === 1) {
        return { items: [{ sessionId: OTHER, snippet: 'needle in other' }], hasMore: false }
      }
      // The refreshed Host search is HELD: only the accepted roster can close
      // the stale result in this window.
      await new Promise<void>(resolve => heldSearches.push(resolve))
      return { items: [], hasMore: false }
    },
  })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.vt.sendInput('/')
  await h.vt.waitForRender()
  h.vt.sendInput('needle')
  await waitUntil(() => h.view().includes('needle in other'), 'the real Host content hit paints')
  await h.vt.waitForRender()
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  h.vt.sendInput(' ')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Peek · other-se'), `the search Peek is open:\n${h.view()}`)

  // Another Client removes that Session: the next accepted roster no longer
  // lists it, while the refreshed Host search is still pending.
  listed = [row(CURRENT, 3_000)]
  const listCalls = h.listCalls
  h.notifyEligibility() // the ONE early roster refresh
  await waitUntil(() => h.listCalls > listCalls, 'the refreshed roster was accepted')
  await h.vt.waitForRender()
  const view = h.view()
  assert.ok(!view.includes('Peek ·'),
    `a removed Session never stays peekable through the search refresh window:\n${view}`)
  assert.ok(!view.includes('needle in other'),
    `the stale Host hit disappears with its roster row, before the next search:\n${view}`)
  assert.ok(view.includes('needle'), 'the user query is preserved')
  assert.equal(heldSearches.length <= 1, true, 'the refreshed Host search is still pending')
})

// ── M5-U-E: the Host Editor `←←` Session Workspace gesture ───────────────────

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** The complete Kitty arrow-event forms (flag 2): press / repeat / release. */
const KITTY_LEFT_PRESS = '\x1b[1;1D'
const KITTY_LEFT_REPEAT = '\x1b[1;1:2D'
const KITTY_LEFT_RELEASE = '\x1b[1;1:3D'

function viewerTarget(mode: 'one-shot' | 'continuable'): SubagentViewerTarget {
  return {
    parentSessionId: CURRENT,
    childSessionId: 'child-1',
    label: 'research',
    mode,
    activity: 'inactive',
  }
}

/** The minimal read-only Settings projection the Settings-workspace lease
 *  needs; the real `/settings` builder is exercised by its own suite. */
function settingsWorkspaceSource(): SettingsWorkspaceSource {
  return {
    readSnapshot: () => ({
      configReadiness: 'ready',
      capturedAt: Date.now(),
      rows: [
        { id: 'theme', category: 'appearance', label: 'Configured theme', summary: 'auto', value: 'auto', scope: 'TUI settings document', freshness: 'ready', description: 'palette' },
      ],
    }),
  }
}

/** The minimal Save-Location deps: the prompt only has to MOUNT and own the
 *  seat; Esc cancels it (no filesystem fixture is needed for the seat gate). */
function saveLocationDeps(): import('../../src/tui/interaction/save-location.ts').SaveLocationDeps {
  return {
    resolveDirectory: () => '/ws',
    isDirectory: () => false,
    targetExists: () => false,
    complete: async () => null,
  }
}

test('E-L1: the FIRST unclaimed Left is delivered to the host editor and opens nothing', async () => {
  const h = harness({ currentSessionId: CURRENT })
  h.pressLeft()
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), `a single Left never opens the workspace:\n${h.view()}`)
  assert.equal(h.facts.followCalls, 0, 'no Workspace follow starts')
  assert.equal(h.listCalls, 0, 'no roster read starts')
  assert.equal(h.pickerCalls, 0, 'the retired picker never opens')
  assert.equal(h.app.getDraft(), '')
  assert.deepEqual(h.switchCalls, [])
})

test('E-L2: the second Left within the window opens the ONE All-scope workspace; Esc restores the same editor', async () => {
  const h = harness({ currentSessionId: CURRENT })
  h.pressLeft()
  h.pressLeft()
  await waitUntil(() => h.facts.followCalls === 1, 'the second Left opens the ONE physical workspace')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Sessions'), `the fullscreen workspace owns the screen:\n${h.view()}`)
  assert.equal(h.listCalls, 1, 'exactly ONE roster read owner')
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT, OTHER] },
  ))
  await waitUntil(() => h.view().includes('project-a · 2'), 'the gesture opens the full Workspace tree')
  const all = h.view()
  assert.ok(all.includes('project-a · 2'), `the official current Workspace folder remains first:\n${all}`)
  assert.ok(all.includes('other'), `the same Browse keeps the sibling Workspace folder available:\n${all}`)
  assert.ok(!all.includes('Workspace information unavailable'), 'the official baseline remains usable')
  assert.deepEqual(h.switchCalls, [], 'the gesture itself never switches a Session')

  // Esc: the SAME main screen, draft, Session and editor focus — no stop/submit.
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Workspace:'), 'Esc closes the workspace')
  assert.equal(h.app.getDraft(), '', 'the draft is byte-identical')
  assert.equal(h.app.focusSeatForTest(), 'editor', 'the editor owns the seat again')
  assert.equal(h.app.isFullscreen(), false)
  assert.deepEqual(h.switchCalls, [], 'closing never switches, stops or submits')
  assert.equal(h.facts.handles[0]!.disposed, 1, 'the per-open follow is disposed once')
  assert.equal(h.listCalls, 1)
})

test('E-L3: an expired first press never opens; the late press restarts the window', async () => {
  const h = harness({ currentSessionId: CURRENT })
  h.pressLeft()
  // The contract IS the 600ms window: wait deliberately PAST its deadline.
  await sleep(700)
  h.pressLeft()
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), `the expired gesture never opens:\n${h.view()}`)
  assert.equal(h.listCalls, 0)
  // The expired second press became a NEW first press: the very next press
  // inside its own window completes the gesture.
  h.pressLeft()
  await waitUntil(() => h.view().includes('Sessions'), 'the new pair opens')
  assert.equal(h.listCalls, 1)
})

test('E-L4: text, whitespace, multiline or image-only drafts never open; edits invalidate an armed press', async () => {
  const h = harness({ currentSessionId: CURRENT })
  for (const draft of ['x', '   ', 'a\nb']) {
    h.app.setEditorText(draft)
    await h.vt.waitForRender()
    h.pressLeft()
    h.pressLeft()
    await h.vt.waitForRender()
    assert.ok(!h.view().includes('Sessions'), `draft ${JSON.stringify(draft)} must not open:\n${h.view()}`)
    assert.equal(h.app.getDraft(), draft, 'the draft is untouched')
  }
  assert.equal(h.listCalls, 0)
  h.close()

  // A staged image-only draft is a payload even when the text is empty.
  const hi = harness({ currentSessionId: CURRENT, isImageDraft: () => true })
  hi.pressLeft()
  hi.pressLeft()
  await hi.vt.waitForRender()
  assert.ok(!hi.view().includes('Sessions'), 'an image-only draft must not open')
  assert.equal(hi.listCalls, 0)
  hi.close()

  // A document mutation between the presses (the programmatic restore below
  // fires onChange) invalidates the latch even when the text returns to empty.
  const hm = harness({ currentSessionId: CURRENT })
  hm.pressLeft()
  hm.app.setEditorText('')
  await hm.vt.waitForRender()
  hm.pressLeft()
  await hm.vt.waitForRender()
  assert.ok(!hm.view().includes('Sessions'), 'an editor mutation invalidates the armed first press')
  assert.equal(hm.listCalls, 0)
  hm.close()
})

test('E-L5: an intervening key/seat/focus/keymap/Session change restarts the gesture; resize alone does not', async () => {
  const h = harness({ currentSessionId: CURRENT })
  // Right is a real intervening key AND the reset between the sub-cases: a
  // single verification press below stays a FIRST press.
  const reset = (): void => { h.vt.sendInput('\x1b[C') }
  // An ordinary intervening key.
  h.pressLeft()
  h.vt.sendInput('\x1b[C')
  h.pressLeft()
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'a key between the presses invalidates the gesture')
  assert.equal(h.listCalls, 0)
  // The press after the intervening key became the new first press.
  h.pressLeft()
  await waitUntil(() => h.view().includes('Sessions'), 'the next pair opens')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  reset()

  // A focus change (the transcript-search overlay owns the keyboard).
  h.pressLeft()
  h.app.startTranscriptSearch()
  await h.vt.waitForRender()
  h.app.closeTranscriptSearch()
  await h.vt.waitForRender()
  h.pressLeft()
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'a focus change invalidates the gesture')
  reset()

  // A keymap rebuild.
  h.pressLeft()
  h.app.applyUserKeybindings({}, () => {})
  h.pressLeft()
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'a keymap rebuild invalidates the gesture')
  reset()

  // The captured Session scope is no longer current (owner swap between the
  // presses): the stale arm is never accepted, and the press restarts the
  // window on the NEW owner.
  h.pressLeft()
  h.setAgent(OTHER)
  h.pressLeft()
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'a stale captured Session scope never opens')
  h.pressLeft()
  await waitUntil(() => h.view().includes('Sessions'), 'two fresh presses open on the new owner')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  h.setAgent(CURRENT)
  await h.vt.waitForRender()
  reset()

  // Resize alone is NOT an owner change: the same real physical editor stays
  // the keyboard owner, so the pair still opens (no invented Session fact).
  h.pressLeft()
  h.vt.resize(120, 40)
  h.pressLeft()
  await waitUntil(() => h.view().includes('Sessions'), 'resize alone keeps the pair valid')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  h.close()
})

test('E-L6: every higher seat keeps its own input; two Lefts never open the workspace', async () => {
  // Question.
  const hq = harness({ currentSessionId: CURRENT })
  const question = hq.app.askQuestions([{ id: 'q1', question: 'proceed?', options: [{ label: 'yes' }] }])
  await hq.vt.waitForRender()
  hq.pressLeft()
  hq.pressLeft()
  await hq.vt.waitForRender()
  assert.ok(hq.view().includes('proceed?'), 'the Question still owns the seat')
  assert.ok(!hq.view().includes('Sessions'))
  assert.equal(hq.listCalls, 0)
  hq.vt.sendInput('\x1b')
  await question.catch(() => {})
  hq.close()

  // Approval.
  const ha = harness({ currentSessionId: CURRENT })
  const approval = ha.app.showApprovalPrompt({ toolName: 'bash', reason: 'run a command?' })
  await ha.vt.waitForRender()
  ha.pressLeft()
  ha.pressLeft()
  await ha.vt.waitForRender()
  assert.ok(ha.view().includes('run a command?'), 'the Approval still owns the seat')
  assert.ok(!ha.view().includes('Sessions'))
  assert.equal(ha.listCalls, 0)
  ha.vt.sendInput('y')
  assert.equal(await approval, 'allowed-once')
  ha.close()

  // Save Location.
  const hs = harness({ currentSessionId: CURRENT })
  const save = hs.app.askSaveLocation(
    { title: 'Save session archive', filename: 'dsh-session-session-abc.zip', initialDirectory: './' },
    saveLocationDeps(),
  )
  await hs.vt.waitForRender()
  hs.pressLeft()
  hs.pressLeft()
  await hs.vt.waitForRender()
  assert.ok(hs.view().includes('Save session archive'), 'the Save Location prompt still owns the seat')
  assert.ok(!hs.view().includes('Sessions'))
  hs.vt.sendInput('\x1b')
  assert.deepEqual(await save, { kind: 'cancelled' })
  hs.close()

  // Task Quick.
  const ht = harness({ currentSessionId: CURRENT })
  ht.app.setQuickTaskItems([{ value: 'job:bash-1', label: 'pnpm build', status: 'running', source: 'job' }])
  ht.app.setTasks([{ id: 'bash-1', label: 'pnpm build', status: 'running', kind: 'bash' }])
  await ht.vt.waitForRender()
  ht.vt.sendInput('\x1b[B') // Down enters Quick
  await ht.vt.waitForRender()
  assert.equal(ht.app.taskQuickFocusedForTest(), true, 'the Quick owns the focused seat')
  ht.pressLeft()
  ht.pressLeft()
  await ht.vt.waitForRender()
  assert.ok(!ht.view().includes('Sessions'))
  assert.equal(ht.listCalls, 0)
  ht.close()

  // Read-only and continuable subagent viewers.
  const hv = harness({ currentSessionId: CURRENT })
  hv.app.setViewerMode(viewerTarget('one-shot'))
  await hv.vt.waitForRender()
  hv.pressLeft()
  hv.pressLeft()
  await hv.vt.waitForRender()
  assert.ok(!hv.view().includes('Sessions'), 'the read-only viewer consumes both Lefts')
  hv.vt.sendInput('\x1b')
  hv.app.setViewerMode(viewerTarget('continuable'))
  await hv.vt.waitForRender()
  hv.pressLeft()
  hv.pressLeft()
  await hv.vt.waitForRender()
  assert.ok(!hv.view().includes('Sessions'), 'the continuable viewer routes the child editor')
  assert.equal(hv.listCalls, 0)
  hv.close()

  // Shell editor mode.
  const hh = harness({ currentSessionId: CURRENT })
  hh.vt.sendInput('!')
  await hh.vt.waitForRender()
  assert.equal(hh.app.inputModeForTest(), 'shell-context')
  hh.pressLeft()
  hh.pressLeft()
  await hh.vt.waitForRender()
  assert.ok(!hh.view().includes('Sessions'))
  assert.equal(hh.listCalls, 0)
  hh.close()

  // Autocomplete dropdown.
  const hc = harness({ currentSessionId: CURRENT })
  hc.app.setCommandCompletions([{ name: 'help', description: 'Show help' }], '/ws', null)
  hc.vt.sendInput('/')
  await hc.vt.waitForRender()
  assert.equal(hc.app.isShowingAutocompleteForTest(), true, 'the completion dropdown is open')
  hc.pressLeft()
  hc.pressLeft()
  await hc.vt.waitForRender()
  assert.ok(!hc.view().includes('Sessions'))
  assert.equal(hc.listCalls, 0)
  hc.close()

  // Transcript search overlay.
  const hsearch = harness({ currentSessionId: CURRENT })
  hsearch.app.startTranscriptSearch()
  await hsearch.vt.waitForRender()
  assert.equal(hsearch.app.isSearching(), true)
  hsearch.pressLeft()
  hsearch.pressLeft()
  await hsearch.vt.waitForRender()
  assert.ok(!hsearch.view().includes('Sessions'))
  assert.equal(hsearch.listCalls, 0)
  hsearch.close()

  // Settings fullscreen (its workspace lease owns the physical screen).
  const hset = harness({ currentSessionId: CURRENT })
  const settingsHandle = hset.app.openSettingsWorkspace(settingsWorkspaceSource(), {
    aboutVersionFacts: { tui: '0.0.0-test', dsh: undefined },
  })
  await hset.vt.waitForRender()
  assert.ok(hset.view().includes('Settings ·'), `the Settings workspace owns the screen:\n${hset.view()}`)
  hset.pressLeft()
  hset.pressLeft()
  await hset.vt.waitForRender()
  assert.ok(!hset.view().includes('Sessions'))
  assert.ok(hset.view().includes('Settings ·'), 'the Settings workspace still owns the screen')
  assert.equal(hset.listCalls, 0)
  settingsHandle.close()
  hset.close()

  // History optional seat (the Ctrl+R tenant replaces the editor seat).
  const hhist = harness({
    currentSessionId: CURRENT,
    historySearchSource: { search: async () => ({ results: [], exhausted: true }) },
    historySearchCwd: () => '/ws',
    captureHistoryScope: () => ({ sessionId: CURRENT, isCurrent: () => true }),
  })
  hhist.app.openHistorySearch()
  await hhist.vt.waitForRender()
  assert.ok(hhist.view().includes('Input History'), `the History seat owns the editor seat:\n${hhist.view()}`)
  hhist.pressLeft()
  hhist.pressLeft()
  await hhist.vt.waitForRender()
  assert.ok(!hhist.view().includes('Sessions'))
  assert.ok(hhist.view().includes('Input History'), 'the History seat still owns the editor seat')
  assert.equal(hhist.listCalls, 0)
  hhist.close()

  // A replacement (plugin) editor owns the seat: the HOST editor is not the
  // physical owner, so the gesture cannot run — the editor keeps both Lefts.
  const registry = new EditorRegistry()
  const hplug = harness({ currentSessionId: CURRENT, editorRegistry: registry })
  let pluginLefts = 0
  const pluginHandle = registry.register({
    id: 'ue-replacement-editor',
    priority: 0,
    create: () => ({
      component: { kind: 'text', spans: [{ text: '' }] },
      getText: () => '',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      get focused() { return false },
      borderColor: (text: string) => text,
      handleInput: (event) => {
        if (event.kind === 'key' && event.key.key === 'left'
          && !event.key.ctrl && !event.key.alt && !event.key.shift && !event.key.super) {
          pluginLefts += 1
        }
        return true
      },
      dispose: () => {},
    }),
  }, 'plugin')
  hplug.app.reconcileEditorNow()
  await hplug.vt.waitForRender()
  assert.equal(hplug.app.seatEditorForTest().id, 'ue-replacement-editor', 'the replacement editor owns the seat')
  hplug.pressLeft()
  hplug.pressLeft()
  await hplug.vt.waitForRender()
  assert.equal(pluginLefts, 2, 'the replacement editor receives both Left presses')
  assert.ok(!hplug.view().includes('Sessions'))
  assert.equal(hplug.listCalls, 0)
  pluginHandle.dispose()
  hplug.close()
})

test('E-L7: Kitty repeat/release never complete the gesture; a second independent Press does', async () => {
  const h = harness({ currentSessionId: CURRENT })
  h.vt.sendInput(KITTY_LEFT_PRESS)
  h.vt.sendInput(KITTY_LEFT_REPEAT)
  h.vt.sendInput(KITTY_LEFT_RELEASE)
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'one physical press cannot open through its repeat/release')
  assert.equal(h.listCalls, 0)
  // Only a SEPARATE press inside the same window completes the gesture.
  h.vt.sendInput(KITTY_LEFT_PRESS)
  await waitUntil(() => h.view().includes('Sessions'), 'a second independent Press opens')
  assert.equal(h.listCalls, 1)
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()

  // The same artifact stream, then an EXPIRED press: the repeat/release were
  // never counted as the second press.
  h.vt.sendInput(KITTY_LEFT_PRESS)
  h.vt.sendInput(KITTY_LEFT_REPEAT)
  h.vt.sendInput(KITTY_LEFT_RELEASE)
  // The 600ms window is the contract: wait past its deadline on purpose.
  await sleep(700)
  h.vt.sendInput(KITTY_LEFT_PRESS)
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'the expired press is a new first press, not a completion')
})

test('E-L8: bracketed paste and Unstable consume/rewrite never synthesize the gesture', async () => {
  // A paste whose CONTENT carries a literal Left sequence byte stays content.
  const hp = harness({ currentSessionId: CURRENT })
  hp.vt.sendInput('\x1b[200~left bytes \x1b[D inside the paste\x1b[201~')
  await hp.vt.waitForRender()
  hp.pressLeft()
  hp.pressLeft()
  await hp.vt.waitForRender()
  assert.ok(!hp.view().includes('Sessions'), 'a paste body never drives the gesture')
  assert.notEqual(hp.app.getDraft(), '', 'the pasted content is owned by the editor')
  assert.equal(hp.listCalls, 0)
  hp.close()

  // A paste marker split across chunks is still the paste owner.
  const hs = harness({ currentSessionId: CURRENT })
  hs.vt.sendInput('\x1b[200~')
  hs.vt.sendInput('abc')
  hs.vt.sendInput('\x1b[201~')
  await hs.vt.waitForRender()
  hs.pressLeft()
  hs.pressLeft()
  await hs.vt.waitForRender()
  assert.ok(!hs.view().includes('Sessions'))
  assert.equal(hs.listCalls, 0)
  hs.close()

  // The Unstable raw stage CONSUMES both Lefts: they never become a press.
  const hc = harness({
    currentSessionId: CURRENT,
    unstableInputRoute: (data) => data === '\x1b[D' ? { action: 'consume' } : { action: 'pass' },
  })
  hc.pressLeft()
  hc.pressLeft()
  await hc.vt.waitForRender()
  assert.ok(!hc.view().includes('Sessions'), 'a consumed raw Left is not a physical press')
  assert.equal(hc.listCalls, 0)
  hc.close()

  // The Unstable raw stage REWRITES a Right into a Left: synthesized chunks
  // never enter the gesture.
  const hr = harness({
    currentSessionId: CURRENT,
    unstableInputRoute: (data) => data === '\x1b[C' ? { action: 'rewrite', data: '\x1b[D' } : { action: 'pass' },
  })
  hr.vt.sendInput('\x1b[C')
  hr.vt.sendInput('\x1b[C')
  await hr.vt.waitForRender()
  assert.ok(!hr.view().includes('Sessions'), 'a rewritten Left is not a real physical Left')
  assert.equal(hr.listCalls, 0)
  hr.close()
})

test('E-L9: an unavailable entry or a Host user remap never gets pre-empted', async () => {
  const h = harness({ currentSessionId: CURRENT, browserAvailable: () => false })
  h.pressLeft()
  h.pressLeft()
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'an unavailable entry opens nothing')
  assert.equal(h.listCalls, 0)
  assert.equal(h.facts.followCalls, 0)
  assert.equal(h.pickerCalls, 0)
  assert.equal(h.notices.length, 0, 'no fake availability prompt')
  h.close()

  // A Host user remap of Left keeps its OWN route: the host action consumes
  // both presses before the editor gesture is ever consulted.
  const hr = harness({ currentSessionId: CURRENT })
  hr.app.applyUserKeybindings({ bindings: { 'app.transcript.search': 'left' } }, () => {})
  hr.pressLeft()
  await hr.vt.waitForRender()
  assert.equal(hr.app.isSearching(), true, 'the user remap keeps its meaningful route')
  hr.pressLeft()
  await hr.vt.waitForRender()
  assert.ok(!hr.view().includes('Sessions'), 'a remapped Left never opens the workspace')
  assert.equal(hr.listCalls, 0)
  hr.app.closeTranscriptSearch()
  hr.close()
})

test('E-L10: a PiTUI mount without the installed control keeps both Lefts native; the argument-free entry stays Current', async () => {
  // The window between `TuiApp.start()` and the post-registration control
  // install (bootstrap). The TSP mount has NO TuiApp at all; its production
  // proof lives in `test/app/tern-tsp-live-mount.test.ts` (the runtime bridge
  // is inert there).
  const h = harness({ currentSessionId: CURRENT, installControl: false })
  h.pressLeft()
  h.pressLeft()
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'no control means no gesture')
  assert.equal(h.listCalls, 0)

  // The registered UI body with no scope still browses the ONE global tree.
  h.openSessionBrowser()
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Sessions'), 'the registered UI entry still opens the ONE workspace')
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] },
    { workspaceId: 'ws-b', path: '/other', title: 'project-b', sessionIds: [OTHER] },
  ))
  await waitUntil(() => h.view().includes('project-a · 1'), 'the argument-free entry states the global tree')
  assert.ok(!h.view().includes('Other session'), 'Current never lists an unproved Workspace row')
  h.close()
})

test('E-L11: every entry browses the full Workspace tree; typed entries keep the Current intent, only the gesture asks All', async () => {
  const h = harness({ currentSessionId: CURRENT })
  const typed = h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles.at(-1)!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] },
    { workspaceId: 'ws-b', path: '/other', title: 'project-b', sessionIds: [OTHER] },
  ))
  await waitUntil(() => h.view().includes('project-a · 1'), 'the global tree is stated')
  assert.ok(h.view().includes('project-a') && h.view().includes('project-b'),
    `the typed command lists the complete official tree, not one scope:\n${h.view()}`)
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  await typed

  // The argument-free UI entry is the SAME Browser body.
  const welcome = h.openSessionBrowser()
  await h.vt.waitForRender()
  h.facts.handles.at(-1)!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] },
    { workspaceId: 'ws-b', path: '/other', title: 'project-b', sessionIds: [OTHER] },
  ))
  await waitUntil(() => h.view().includes('project-b'), 'the argument-free entry lists the same tree')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  await welcome

  // ONLY the Host Editor gesture carries the All browse intent: with a baseline
  // that does not prove the current Session's membership it never announces a
  // Current fallback (that is the typed/Current entry's one-time notice).
  h.pressLeft()
  h.pressLeft()
  await h.vt.waitForRender()
  h.facts.handles.at(-1)!.push(baseline({ workspaceId: 'ws-b', path: '/other', title: 'project-b', sessionIds: [OTHER] }))
  await waitUntil(() => h.view().includes('project-b'), 'All opens the official sibling folder')
  assert.ok(!h.view().includes('Current workspace unavailable'), 'an All open never announces a Current fallback')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()

  const typedMissing = h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles.at(-1)!.push(baseline({ workspaceId: 'ws-b', path: '/other', title: 'project-b', sessionIds: [OTHER] }))
  await waitUntil(() => h.view().includes('Current workspace unavailable — showing all workspaces'),
    'the typed Current intent states the one fallback notice')
  assert.ok(h.view().includes('project-b'), 'the typed entry still lists every official folder')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  await typedMissing

  // `/sessions <query>` / `/search <query>` keep the GLOBAL content search.
  const query = h.runSessions('needle')
  await waitUntil(() => h.view().includes('Search all workspaces'), 'a query keeps the global content search')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  await query
  const search = h.runCommand('search', 'needle')
  await waitUntil(() => h.view().includes('Search all workspaces'), '/search keeps the global content search')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()
  await search

  // `/resume <id>` keeps its direct match and its committed switch settlement.
  const resumed = h.runCommand('resume', OTHER)
  await waitUntil(() => h.switchCalls.length === 1, 'the direct match reaches the runtime')
  assert.equal(h.switchCalls[0]!.id, OTHER)
  h.setAgent(OTHER)
  h.settleSwitch({ kind: 'committed', sessionId: OTHER })
  const outcome = await resumed
  assert.equal(outcome.kind, 'success')
  h.setAgent(CURRENT)
  h.close()
})

test('E-L12: a refused open leaves no hidden reader and consumes only that second press', async () => {
  const h = harness({ currentSessionId: CURRENT })
  // A synchronous lease refusal from the real command body: the opener's own
  // error notice is the ONE report, and no read/follow/screen survives it.
  const original = h.app.openSessionWorkspace.bind(h.app)
  h.app.openSessionWorkspace = (() => { throw new Error('another workspace screen is already leased') }) as typeof h.app.openSessionWorkspace
  h.pressLeft()
  h.pressLeft()
  await waitUntil(() => h.notices.some(notice => notice.text.includes('session workspace unavailable')),
    'the refusal reaches the existing notice sink')
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'a refused lease paints no workspace')
  assert.equal(h.facts.followCalls, 0, 'a refused lease starts no Workspace follow')
  assert.equal(h.listCalls, 0, 'a refused lease starts no roster read')
  assert.equal(h.notices.filter(notice => notice.text.includes('session workspace unavailable')).length, 1,
    'the refusal is reported exactly once')
  h.app.openSessionWorkspace = original

  // A throwing control is reported once too, and never leaves an implicit
  // second Browser behind.
  h.installControl({
    available: () => true,
    captureIsCurrent: () => () => true,
    openAll: () => { throw new Error('control refused') },
  })
  h.pressLeft()
  h.pressLeft()
  await waitUntil(() => h.notices.some(notice => notice.text.includes('Could not open sessions')),
    'a synchronous control failure is reported once')
  assert.ok(!h.view().includes('Sessions'))
  assert.equal(h.facts.followCalls, 0)

  // The refused second press was CONSUMED (never typed into the draft), and
  // the NEXT pair starts from a clean latch and opens the real workspace.
  assert.equal(h.app.getDraft(), '')
  h.installControl(undefined)
  h.installControl({
    available: () => true,
    captureIsCurrent: () => () => true,
    openAll: () => { void h.openSessionBrowser('all') },
  })
  h.pressLeft()
  h.pressLeft()
  await waitUntil(() => h.view().includes('Sessions'), 'the next clean pair opens normally')
  h.vt.sendInput('\x1b')
  await h.vt.waitForRender()

  // After an Esc close, the stale latch is gone: a single Left does not reopen.
  h.pressLeft()
  await h.vt.waitForRender()
  assert.ok(!h.view().includes('Sessions'), 'an Esc close leaves no armed latch')
})

test('E-L13: a Left consumed by an Advanced capture invalidates the pair; only a fresh pair opens', async () => {
  const registry = new AdvancedInputRegistry()
  let captureLeft = false
  const capture = registry.register({
    id: 'ue-consume-left',
    priority: 0,
    mode: 'capture',
    handle: (event) => captureLeft && event.kind === 'key'
      && event.key.key === 'left'
      && !event.key.ctrl && !event.key.alt && !event.key.shift && !event.key.super,
  }, 'ue-owner')
  const h = harness({
    currentSessionId: CURRENT,
    advancedInputRoute: (data) => registry.route(data, normalizeInputEvent),
  })
  try {
    // The first eligible Left reaches the Host editor and arms the window.
    h.pressLeft()
    // The Advanced capture now owns the NEXT Left: it never reaches the editor.
    captureLeft = true
    h.pressLeft()
    await h.vt.waitForRender()
    assert.ok(!h.view().includes('Sessions'), 'a captured second Left never opens')
    assert.equal(h.listCalls, 0)
    // The capture releases the key. The first editor Left and THIS editor Left
    // are not a consecutive pair — the captured Left is an intervening input.
    captureLeft = false
    h.pressLeft()
    await h.vt.waitForRender()
    assert.ok(!h.view().includes('Sessions'), 'a captured Left between the pair must not be stitched over')
    assert.equal(h.listCalls, 0)
    // This third editor Left became the NEW first press: the next one opens.
    h.pressLeft()
    await waitUntil(() => h.view().includes('Sessions'), 'a fresh consecutive pair opens')
    assert.equal(h.listCalls, 1)
  } finally {
    capture.dispose()
    h.close()
  }
})

// ── PR3: the ONE Host browse seam through the real command chain ────────────

const PR3_HOME = '/host/home'

function pr3Listing(path: string, names: readonly string[], truncated = false): DirectoryListing {
  return {
    path,
    home: PR3_HOME,
    crumbs: [],
    entries: names.map(name => ({ name, path: `${path.endsWith('/') ? path : `${path}/`}${name}`, hidden: false })),
    truncated,
  }
}

function pr3Ready(listing: DirectoryListing): HostDirectoryBrowseOutcome {
  return { kind: 'ready', listing }
}

test('PR3 D13: the real /sessions Add browses the Host, commits only on Enter and never creates a Session', async () => {
  const nextIntent = createWorkspaceNextIntentOwner('/ws')
  const listCalls: Array<string | undefined> = []
  const resolveCalls: unknown[] = []
  let releaseResolve!: (value: { workspaceId: string; path: string }) => void
  let resolveGate: Promise<{ workspaceId: string; path: string }> | undefined
  const h = harness({
    workspaceNextIntent: nextIntent,
    hostDirectoryBrowse: {
      list: async (path) => {
        listCalls.push(path)
        if (path === undefined) return pr3Ready(pr3Listing(PR3_HOME, ['project-a', 'project-b']))
        if (path === '/host/home/project-b/') return pr3Ready(pr3Listing(path, ['child']))
        return pr3Ready(pr3Listing(path, []))
      },
    },
    agents: {
      resolveWorkspace: ((intent: unknown) => {
        resolveCalls.push(intent)
        resolveGate = new Promise(resolve => { releaseResolve = resolve })
        return resolveGate
      }) as never,
    },
  })
  try {
    await h.runSessions('')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b[H')
    await h.vt.waitForRender()
    h.vt.sendInput('\r')
    await h.vt.waitForRender()
    await waitUntil(() => h.view().includes('project-a/'), 'the Home read reaches the PiTUI editor')
    assert.deepEqual(listCalls, [undefined], 'the ONE Host home read feeds the first level')
    const revisionBefore = nextIntent.snapshot().revision

    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
    h.vt.sendInput('\t')
    await h.vt.waitForRender()
    await waitUntil(() => h.view().includes('Host directory: /host/home/project-b/'), 'Tab writes the official path')
    assert.deepEqual(resolveCalls, [], 'Tab never reaches the Workspace resolver')
    assert.equal(nextIntent.snapshot().revision, revisionBefore, 'completion does not commit the next-create intent')

    h.vt.sendInput('\r')
    await h.vt.waitForRender()
    await waitUntil(() => resolveCalls.length === 1, 'Enter dispatches exactly ONE Host resolve')
    assert.equal(nextIntent.snapshot().status, 'verifying', 'the intent is verifying before the Host answer')
    assert.equal(nextIntent.snapshot().revision, revisionBefore, 'beginPathVerification alone never commits the intent')
    assert.deepEqual(listCalls, [undefined, '/host/home/project-b/'], 'only read-only Host browse requests were issued')
    releaseResolve({ workspaceId: 'ws-new', path: '/host/home/project-b' })
    await waitUntil(() => nextIntent.snapshot().status === 'confirmed', 'the committed Workspace becomes the next-create intent')
    assert.notEqual(nextIntent.snapshot().revision, revisionBefore, 'the commit advances the intent revision')
    assert.equal(resolveCalls.length, 1, 'the Host resolve was issued exactly once')
    assert.deepEqual(h.switchCalls, [], 'Add never switches a Session')
    await waitUntil(() => h.view().includes('Directory added: /host/home/project-b'),
      'the registered canonical path is the painted outcome')
    assert.ok(h.view().includes('Sessions'), 'ordinary Add returns to the same Browser')
  } finally {
    h.close()
  }
})

test('PR3 D13: the Sessionless chooser verifies a Host path and returns to Welcome without creating a Session', async () => {
  const nextIntent = createWorkspaceNextIntentOwner('/ws')
  let resolveCalls = 0
  const h = harness({
    workspaceNextIntent: nextIntent,
    hostDirectoryBrowse: {
      list: async (path) => path === undefined
        ? pr3Ready(pr3Listing(PR3_HOME, ['chosen']))
        : pr3Ready(pr3Listing(path, [])),
    },
    agents: {
      resolveWorkspace: (async () => {
        resolveCalls += 1
        return { workspaceId: 'ws-choose', path: `${PR3_HOME}/chosen` }
      }) as never,
    },
  })
  try {
    await h.openSessionBrowser({ scope: 'all', addDirectory: true })
    await h.vt.waitForRender()
    assert.ok(h.view().includes('Choose workspace'), 'the Welcome chooser owns its own title')
    h.vt.sendInput('\x1b[H')
    await h.vt.waitForRender()
    h.vt.sendInput('\r')
    await h.vt.waitForRender()
    await waitUntil(() => h.view().includes('Host directory: /host/home/'), 'the Add editor prefills the Host home')
    h.vt.sendInput('\r')
    await waitUntil(() => nextIntent.snapshot().status === 'confirmed', 'the Host resolve commits the next-create intent')
    await waitUntil(() => h.app.isFullscreen() === false, 'a successful chooser returns to the Welcome')
    assert.equal(resolveCalls, 1)
    assert.deepEqual(h.switchCalls, [], 'choosing a directory never creates or switches a Session')
  } finally {
    h.close()
  }
})

test('PR3: the native presentation never receives the Host browse seam and issues no Host list', async () => {
  const listCalls: Array<string | undefined> = []
  const requests: Array<Parameters<SessionBrowserPresentation['open']>[0]> = []
  const nativePresentation: SessionBrowserPresentation = {
    open: (request) => {
      requests.push(request)
      return {
        isDisposed: () => false,
        setSnapshot: () => {},
        close: () => {},
      }
    },
    notify: () => {},
  }
  const h = harness({
    nativePresentation,
    hostDirectoryBrowse: {
      list: async (path) => { listCalls.push(path); return pr3Ready(pr3Listing(PR3_HOME, ['host-only'])) },
    },
  })
  try {
    await h.runSessions('')
    await h.vt.waitForRender()
    assert.equal(requests.length, 1, 'the native presentation owns the one open')
    assert.equal(requests[0]!.onListDirectory, undefined,
      'the PiTUI-only Host browse callback must not cross into the native presentation')
    assert.deepEqual(listCalls, [], 'no Host directory read is issued for the native picker')
    assert.ok(!h.view().includes('Host directory:'), 'no PiTUI suggestion layer is mounted')
    assert.equal(h.app.isFullscreen(), false, 'the native picker keeps its own screen and no second layer')
  } finally {
    h.close()
  }
})

test('a refused /new Host pre-selection opens the full Workspace tree without creating or stopping anything', async () => {
  const resolutions: unknown[] = []
  const creates: unknown[] = []
  let transitions = 0
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async (intent: unknown) => {
        resolutions.push(intent)
        throw new WorkspaceSelectionError('refused', 'the Host refused the proposed workspace directory', 'workspace/invalid-path')
      }) as never,
      create: (async (input: unknown) => {
        creates.push(input)
        return { session: { id: 'recovered-new' } }
      }) as never,
    },
    transitionTo: (async (steps: { create: () => Promise<unknown> }) => {
      transitions += 1
      return { ok: true, next: await steps.create() }
    }) as never,
  })
  try {
    h.app.setDraft('draft kept across the refusal')
    const result = await h.runCommand('new')
    assert.equal(result.kind, 'success', 'the recovery navigation is the command outcome, not a second error card')
    assert.deepEqual(resolutions, [{ kind: 'source-session', sessionId: CURRENT }],
      'the live /new asks for the captured Session membership, never a cwd')
    assert.equal(transitions, 0, 'the refused pre-selection never enters the transition')
    assert.deepEqual(creates, [], 'the refusal dispatches no Session create and no old-owner stop')
    assert.equal(h.app.getDraft(), 'draft kept across the refusal', 'the old editor draft is untouched')
    await h.vt.waitForRender()
    const frame = h.view()
    assert.ok(frame.includes('Sessions ·'), 'the ONE full Workspace Browser owns the screen')
    assert.ok(frame.includes('Sessions'), 'the shared Session Browser opened')
    assert.ok(frame.includes('Add directory'), 'the recovery is the full tree, not the inline Add editor')
    assert.ok(!frame.includes('Host directory:'), 'a /new recovery never starts in the path editor')
    assert.equal(h.notices.filter(notice => notice.text.includes('fresh session creation failed')).length, 1,
      'the originating refusal is stated exactly once')
  } finally {
    h.close()
  }
})

test('Esc on a /new recovery Browser leaves the old Session, draft and next-create intent unchanged', async () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  const creates: unknown[] = []
  const h = harness({
    workspaceNextIntent: owner,
    agents: {
      resolveWorkspace: (async () => {
        throw new WorkspaceSelectionError('refused', 'the Host refused the proposed workspace directory', 'workspace/not-found')
      }) as never,
      create: (async (input: unknown) => {
        creates.push(input)
        return { session: { id: 'unused' } }
      }) as never,
    },
  })
  try {
    const before = owner.snapshot()
    await h.runCommand('new')
    await h.vt.waitForRender()
    assert.ok(h.view().includes('Sessions ·'), 'the refused /new opened the recovery Browser')
    h.vt.sendInput('\x1b')
    await waitUntil(() => !h.view().includes('Sessions ·'), 'Esc closes only the Browser')
    assert.deepEqual(owner.snapshot().intent, before.intent, 'the next-create intent is unchanged')
    assert.equal(owner.snapshot().revision, before.revision, 'a cancelled recovery invents no revision')
    assert.deepEqual(creates, [], 'no Session was created')
    assert.deepEqual(h.switchCalls, [], 'no Session was switched')
  } finally {
    h.close()
  }
})

test('a Sessionless /new refusal lets Add register the Host directory before an explicit Folder New creates', async () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  const resolutions: unknown[] = []
  const creates: Array<{ workspaceId: string }> = []
  const h = harness({
    workspaceNextIntent: owner,
    agents: {
      resolveWorkspace: (async (intent: { kind: string; path?: string }) => {
        resolutions.push(intent)
        if (intent.kind === 'host-path' && intent.path === '/launch') {
          throw new WorkspaceSelectionError('refused', 'the Host refused the proposed workspace directory', 'workspace/invalid-path')
        }
        return { workspaceId: 'ws-recovered', path: intent.path ?? '/host/recovered' }
      }) as never,
      create: (async (input: { workspaceId: string }) => {
        creates.push(input)
        return { session: { id: 'session-recovered' } }
      }) as never,
    },
  })
  try {
    await h.runCommand('new')
    await h.vt.waitForRender()
    assert.ok(h.view().includes('Add directory'), 'the Sessionless recovery tree carries the root Add row')
    h.facts.handles[0]!.push(baseline(
      { workspaceId: 'ws-other', path: '/ws/other', title: 'other', sessionIds: [] },
    ))
    await waitUntil(() => h.view().includes('other'), 'the official baseline is proved')
    h.vt.sendInput('\x1b[H')
    await h.vt.waitForRender()
    h.vt.sendInput('\r')
    await h.vt.waitForRender()
    h.vt.sendInput('/host/recovered')
    await h.vt.waitForRender()
    h.vt.sendInput('\r')
    await waitUntil(() => owner.snapshot().status === 'confirmed', 'the Host resolve commits the next-create intent')
    assert.equal(creates.length, 0, 'Add only registers the Host Workspace and never creates a Session')
    await waitUntil(() => h.view().includes('Directory added: /host/recovered'),
      'the registered directory fact returns to the same Browser')
    h.facts.handles[0]!.push(baseline(
      { workspaceId: 'ws-recovered', path: '/host/recovered', title: 'recovered', sessionIds: [] },
      { workspaceId: 'ws-other', path: '/ws/other', title: 'other', sessionIds: [] },
    ))
    await waitUntil(() => h.view().includes('New session'),
      'the official Workspace follow lists the new Folder as the expanded next-create group')
    h.vt.sendInput('\x1b[H')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b[C')
    await h.vt.waitForRender()
    h.vt.sendInput('\r')
    await waitUntil(() => creates.length === 1, 'only the explicit Folder New dispatches the create')
    assert.equal(creates[0]!.workspaceId, 'ws-recovered', 'the create names the verified official Workspace')
    await waitUntil(() => !h.view().includes('Sessions ·'), 'the committed Folder New retires the Browser')
  } finally {
    h.close()
  }
})

test('a Browse full-tree /new recovery creates exactly one Session on the chosen Folder New and closes once', async () => {
  const resolutions: unknown[] = []
  const creates: Array<{ workspaceId: string }> = []
  let transitions = 0
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async (intent: { kind: string; workspaceId?: string }) => {
        resolutions.push(intent)
        if (intent.kind === 'source-session') {
          throw new WorkspaceSelectionError('refused', 'the Host refused the proposed workspace directory', 'workspace/invalid-path')
        }
        return { workspaceId: intent.workspaceId ?? 'ws-a', path: '/ws' }
      }) as never,
      create: (async (input: { workspaceId: string }) => {
        creates.push(input)
        return { session: { id: 'session-b' } }
      }) as never,
    },
    transitionTo: (async (steps: { create: () => Promise<unknown> }) => {
      transitions += 1
      return { ok: true, next: await steps.create() }
    }) as never,
  })
  const originalOpen = TuiApp.prototype.openSessionWorkspace
  let opens = 0
  TuiApp.prototype.openSessionWorkspace = function (this: TuiApp, options) {
    opens += 1
    return originalOpen.call(this, options)
  }
  try {
    await h.runCommand('new')
    await h.vt.waitForRender()
    h.facts.handles[0]!.push(baseline(
      { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] },
      { workspaceId: 'ws-b', path: '/ws/b', title: 'project-b', sessionIds: [] },
    ))
    await waitUntil(() => h.view().includes('project-b'), 'the official sibling Workspace is listed')
    // Home selects the root Add row; Down selects the current Folder; Right
    // enters its first visible child (`+ New session`); Enter is the explicit
    // create.
    h.vt.sendInput('\x1b[H')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b[C')
    await h.vt.waitForRender()
    h.vt.sendInput('\r')
    await waitUntil(() => creates.length === 1, 'the explicit Folder New dispatches the ONE create')
    assert.deepEqual(resolutions, [
      { kind: 'source-session', sessionId: CURRENT },
      { kind: 'workspace-id', workspaceId: 'ws-a' },
    ], 'the recovery re-resolves the chosen official Workspace id, never a cwd')
    assert.equal(transitions, 1, 'the create enters the ONE existing transition')
    assert.equal(creates[0]!.workspaceId, 'ws-a', 'the Host receives the official Workspace id')
    await waitUntil(() => !h.view().includes('Sessions ·'), 'the committed create retires the Browser')
    assert.equal(opens, 1, 'the refusal opened the Browser exactly once; Folder New does not open a second one')
    assert.equal(h.facts.handles[0]!.disposed, 1, 'the per-open Workspace follow is released exactly once')
  } finally {
    TuiApp.prototype.openSessionWorkspace = originalOpen
    h.close()
  }
})

test('an unavailable selection or an unknown refusal code keeps the original /new error and opens nothing', async () => {
  for (const failure of [
    new WorkspaceSelectionError('unavailable', 'the Host Workspace registry is unavailable'),
    new WorkspaceSelectionError('refused', 'the Host refused for an unknown reason', 'workspace/quota'),
  ]) {
    const h = harness({
      currentSessionId: CURRENT,
      agents: {
        resolveWorkspace: (async () => { throw failure }) as never,
      },
    })
    try {
      const result = await h.runCommand('new')
      assert.equal(result.kind, 'error', `${failure.message}: the command keeps its own error result`)
      await h.vt.waitForRender()
      assert.ok(!h.view().includes('Sessions ·'), `${failure.message}: no recovery Browser opens`)
      assert.equal(h.notices.some(notice => notice.text.includes('fresh session creation failed')), false,
        `${failure.message}: the command result is the ONE visible owner`)
    } finally {
      h.close()
    }
  }
})

test('a /new preselection whose sessionless next intent changed settles silently and opens nothing', async () => {
  const owner = createWorkspaceNextIntentOwner('/launch')
  let rejectResolve!: (error: unknown) => void
  let resolveCalls = 0
  const h = harness({
    workspaceNextIntent: owner,
    agents: {
      resolveWorkspace: (async () => {
        resolveCalls += 1
        return await new Promise<never>((_, reject) => { rejectResolve = reject })
      }) as never,
    },
  })
  try {
    const running = h.runCommand('new')
    await waitUntil(() => resolveCalls === 1, 'the /new pre-selection is dispatched')
    owner.proposeHostPath('/chosen/during/selection')
    rejectResolve(new WorkspaceSelectionError('refused', 'the Host refused the stale proposal', 'workspace/not-found'))
    const result = await running
    assert.equal(result.kind, 'success', 'the stale refusal owns no visible outcome')
    await h.vt.waitForRender()
    assert.ok(!h.view().includes('Sessions ·'), 'the stale refusal opens no Browser')
    assert.deepEqual(owner.snapshot().intent, { kind: 'host-path', path: '/chosen/during/selection' },
      'the newer next-create choice is unchanged')
  } finally {
    h.close()
  }
})

test('a second synchronous /new is refused while the first pre-selection is pending and the settled create releases it', async () => {
  let resolveFirst!: (value: { workspaceId: string; path: string }) => void
  const resolutions: unknown[] = []
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: ((intent: unknown) => {
        resolutions.push(intent)
        return new Promise<{ workspaceId: string; path: string }>((resolve) => { resolveFirst = resolve })
      }) as never,
      create: (async () => ({ session: { id: 'single-flight-' + String(resolutions.length) } })) as never,
    },
  })
  try {
    const first = h.runCommand('new')
    await waitUntil(() => resolutions.length === 1, 'the first /new reaches its preselection')
    const second = await h.runCommand('new')
    assert.equal(second.kind, 'error', 'the second synchronous /new is refused before any Host dispatch')
    assert.match(second.kind === 'error' ? second.text : '', /a fresh session is already starting/u)
    assert.equal(resolutions.length, 1, 'the second /new dispatches no second Host resolve')
    resolveFirst({ workspaceId: 'ws-a', path: '/ws' })
    await first
    // The refused pre-selection released the single-flight: a later /new can
    // dispatch its own Host resolve.
    const third = h.runCommand('new')
    await waitUntil(() => resolutions.length === 2, 'the released single-flight accepts the next /new')
    resolveFirst({ workspaceId: 'ws-a', path: '/ws' })
    await third
  } finally {
    h.close()
  }
})

test('a refused Folder New inside the /new recovery Browser settles there and opens no second Browser', async () => {
  let attempts = 0
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async (intent: { kind: string }) => {
        if (intent.kind === 'source-session') {
          throw new WorkspaceSelectionError('refused', 'the Host refused the proposed workspace directory', 'workspace/invalid-path')
        }
        return { workspaceId: 'ws-a', path: '/ws' }
      }) as never,
      create: (async () => {
        attempts += 1
        throw new Error('the Host create was refused')
      }) as never,
    },
  })
  const originalOpen = TuiApp.prototype.openSessionWorkspace
  let opens = 0
  TuiApp.prototype.openSessionWorkspace = function (this: TuiApp, options) {
    opens += 1
    return originalOpen.call(this, options)
  }
  try {
    await h.runCommand('new')
    await h.vt.waitForRender()
    h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] }))
    await waitUntil(() => h.view().includes('project-a · 1'), 'the official baseline is proved')
    h.vt.sendInput('\x1b[H')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b[C')
    await h.vt.waitForRender()
    h.vt.sendInput('\r')
    await waitUntil(() => attempts === 1 && h.notices.some(notice => notice.text.includes('the Host create was refused')),
      'the Folder New refusal is reported inside the same Browser')
    await h.vt.waitForRender()
    assert.ok(h.view().includes('Sessions ·'), 'a refused create keeps the recovery Browser open')
    assert.equal(opens, 1, 'no second Browser is opened from inside the first one')
    assert.equal(h.facts.handles[0]!.disposed, 0, 'a refused create never retires the Workspace follow')
    h.vt.sendInput('\r')
    await waitUntil(() => attempts === 2, 'the failed Folder New is immediately retryable')
  } finally {
    TuiApp.prototype.openSessionWorkspace = originalOpen
    h.close()
  }
})

test('a post-selection create failure reports the existing error and never opens recovery navigation', async () => {
  const creates: unknown[] = []
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async () => ({ workspaceId: 'ws-a', path: '/ws' })) as never,
      create: (async (input: unknown) => { creates.push(input); return { session: { id: 'unused' } } }) as never,
    },
    transitionTo: (async () => ({
      ok: false,
      error: new LifecycleError('published-with-error', 'current', 'the Session was published but the Workspace attach failed'),
    })) as never,
  })
  try {
    const result = await h.runCommand('new')
    assert.equal(result.kind, 'error', 'the post-create failure keeps its error result')
    await h.vt.waitForRender()
    assert.ok(!h.view().includes('Sessions ·'), 'an uncertain post-create failure never opens recovery navigation')
    assert.deepEqual(creates, [], 'the transition owns the create; the command never dispatches a second one')
    assert.equal(h.notices.some(notice => notice.text.includes('fresh session creation failed')), false,
      'the command result remains the ONE visible owner')
  } finally {
    h.close()
  }
})

test('a blocking owner refuses the /new recovery Browser without starting a hidden Workspace reader', async () => {
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async () => {
        throw new WorkspaceSelectionError('refused', 'the Host refused the proposed workspace directory', 'workspace/invalid-path')
      }) as never,
    },
  })
  try {
    const questions = h.app.askQuestions([{ id: 'q-recovery', question: 'proceed?', options: [{ label: 'yes' }] }])
    await h.vt.waitForRender()
    const result = await h.runCommand('new')
    assert.equal(result.kind, 'error', 'the refused Browser lease is a real command error')
    assert.match(result.kind === 'error' ? result.text : '', /session workspace unavailable/u)
    await h.vt.waitForRender()
    assert.ok(!h.view().includes('Sessions ·'), 'the blocking owner keeps the seat')
    assert.equal(h.facts.followCalls, 0, 'a refused lease starts no Workspace follow')
    h.vt.sendInput('\x1b')
    await questions.catch(() => {})
  } finally {
    h.close()
  }
})

test('a Folder New pre-selection refusal inside the /new recovery Browser stays there and remains retryable', async () => {
  let folderResolutions = 0
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async (intent: { kind: string }) => {
        if (intent.kind === 'source-session') {
          throw new WorkspaceSelectionError('refused', 'the Host refused the proposed workspace directory', 'workspace/invalid-path')
        }
        folderResolutions += 1
        throw new WorkspaceSelectionError('refused', 'the Host refused the chosen Workspace', 'workspace/not-found')
      }) as never,
      create: (async () => { throw new Error('a refused pre-selection must never create') }) as never,
    },
  })
  const originalOpen = TuiApp.prototype.openSessionWorkspace
  let opens = 0
  TuiApp.prototype.openSessionWorkspace = function (this: TuiApp, options) {
    opens += 1
    return originalOpen.call(this, options)
  }
  try {
    await h.runCommand('new')
    await h.vt.waitForRender()
    h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT] }))
    await waitUntil(() => h.view().includes('project-a · 1'), 'the official baseline is proved')
    h.vt.sendInput('\x1b[H')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b[B')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b[C')
    await h.vt.waitForRender()
    h.vt.sendInput('\r')
    await waitUntil(() => folderResolutions === 1
      && h.notices.some(notice => notice.text.includes('fresh session creation failed')),
    'the Folder New preselection refusal is reported inside the same Browser')
    await h.vt.waitForRender()
    assert.ok(h.view().includes('Sessions ·'), 'a typed pre-selection refusal keeps the recovery Browser open')
    assert.equal(opens, 1, 'no second Browser is opened from inside the recovery Browser')
    assert.equal(h.facts.handles[0]!.disposed, 0, 'the refusal never retires the Workspace follow')
    h.vt.sendInput('\r')
    await waitUntil(() => folderResolutions === 2, 'the refused Folder New is immediately retryable')
  } finally {
    TuiApp.prototype.openSessionWorkspace = originalOpen
    h.close()
  }
})

test('a /new refusal on a renderer without a Browser presenter keeps the command error and opens nothing', async () => {
  const h = harness({
    currentSessionId: CURRENT,
    agents: {
      resolveWorkspace: (async () => {
        throw new WorkspaceSelectionError('refused', 'the Host refused the proposed workspace directory', 'workspace/invalid-path')
      }) as never,
    },
  })
  const definitions: Array<{ name: string; handler?: (...args: never[]) => unknown }> = []
  try {
    const registrars = createSessionCommands({
      runner: h.runner,
      // The native renderer has no PiTUI app: the recovery must NOT fall back
      // to the PiTUI presentation.
      app: undefined as never,
      registerOne: ((definition: { name: string; handler?: (...args: never[]) => unknown }) => {
        definitions.push(definition)
      }) as never,
      registerTuiCommand: (() => {}) as never,
      recordCommandDraftDisposition: () => {},
      newSessionId: (() => 'session-native') as never,
      notify: (text, kind) => h.notices.push({ text, kind: kind ?? 'info' }),
      notifyTitleRefusal: () => {},
      notifyTitleSuccess: () => {},
    })
    registrars.registerNew()
    const definition = definitions.find(entry => entry.name === 'new')
    assert.ok(definition?.handler !== undefined, 'the /new handler must register')
    const result = await (definition.handler as () => Promise<{ kind: string; text?: string }>)()
    assert.equal(result.kind, 'error', 'the original refusal stays the command result')
    assert.match(result.text ?? '', /fresh session creation failed/u)
    assert.equal(h.notices.length, 0, 'the command result is the ONE visible owner; no PiTUI fallback notice')
  } finally {
    h.close()
  }
})

test('the /new recovery entry keeps the full tree at 120x40 and 80x24 and only executable verbs at 80x3/2', async () => {
  for (const [columns, rows] of [[120, 40], [80, 24], [80, 3], [80, 2]] as const) {
    const h = harness({
      currentSessionId: CURRENT,
      frameColumns: columns,
      frameRows: rows,
      agents: {
        resolveWorkspace: (async () => {
          throw new WorkspaceSelectionError('refused', 'the Host refused the proposed workspace directory', 'workspace/invalid-path')
        }) as never,
      },
    })
    try {
      const result = await h.runCommand('new')
      assert.equal(result.kind, 'success', `${columns}x${rows}: the recovery entry still navigates`)
      await h.vt.waitForRender()
      const lines = h.view().split('\n')
      const frame = lines.join('\n')
      assert.ok(frame.includes('Sessions'), `${columns}x${rows}: the shared Browser header is painted`)
      assert.ok(!frame.includes('Host directory:'), `${columns}x${rows}: the recovery never starts in the inline editor`)
      if (rows >= 24) {
        assert.ok(frame.includes('Add directory'), `${columns}x${rows}: the full tree offers the registration row`)
        assert.ok(lines.at(-1)!.includes('Close [Esc]'), `${columns}x${rows}: the ONE action bar closes the Browser`)
      } else {
        assert.ok(!frame.includes('Add directory'), `${columns}x${rows}: a clipped row is not advertised`)
        assert.ok(lines.at(-1)!.includes('Close [Esc]'), `${columns}x${rows}: Esc remains the one executable verb`)
        h.vt.sendInput('\x1b')
        await h.vt.waitForRender()
        assert.ok(!h.view().includes('Sessions'), `${columns}x${rows}: Esc really closes the Browser`)
      }
    } finally {
      h.close()
    }
  }
})

// ── M6-1/F5-B review P1: a refused Add must not disable the still-confirmed
//    Workspace's `@file` discovery (the real /sessions Add entry → the real
//    completion scope consumer) ─────────────────────────────────────────────

test('review P1: after a REFUSED Add of another directory, @file still discovers the confirmed Workspace', async (t) => {
  const nextIntent = createWorkspaceNextIntentOwner(undefined)
  nextIntent.setResolvedWorkspace('workspace-a', '/host/a')
  assert.equal(nextIntent.snapshot().status, 'confirmed')
  const revisionBefore = nextIntent.snapshot().revision

  // The Host-file port the runner's `@` completion consumes: a spy recording
  // the scopes the REAL completionScope closure resolves.
  const scopes: import('../../src/runtime/host-file-port.ts').HostFileScope[] = []
  const hostFile: TuiCommandRunner['hostFile'] = {
    listReferences: async (scope) => {
      scopes.push(scope)
      return { kind: 'ok', items: [{ path: 'alpha.ts', kind: 'file' }] }
    },
    resolveReference: async () => ({ kind: 'unavailable', reason: 'not under test' }),
    canonicalizeMentions: async (_scope, text) => text,
  }
  const h = harness({
    workspaceNextIntent: nextIntent,
    hostFile,
    hostDirectoryBrowse: {
      list: async (path) => path === undefined
        ? pr3Ready(pr3Listing(PR3_HOME, ['project-b']))
        : pr3Ready(pr3Listing(path, [])),
    },
    agents: {
      resolveWorkspace: (async () => {
        throw new Error('the Host refused the proposed workspace directory')
      }) as never,
    },
  })
  try {
    // The REAL Add entry: /sessions → Add → type B → Enter → Host REFUSES.
    await h.runSessions('')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b[H')
    await h.vt.waitForRender()
    h.vt.sendInput('\r')
    await h.vt.waitForRender()
    await waitUntil(() => h.view().includes('project-b/'), 'the Add editor lists the Host level')
    h.vt.sendInput('\r')
    await waitUntil(() => nextIntent.snapshot().status === 'rejected',
      'the refused verification marks the status rejected')
    assert.equal(nextIntent.snapshot().revision, revisionBefore, 'a refusal commits nothing')
    // THE IDENTITY RULE under review: the create target is still Workspace A.
    assert.deepEqual(nextIntent.capture()?.intent, { kind: 'workspace-id', workspaceId: 'workspace-a' },
      'the refused Add must not replace or disable the confirmed target')

    // Back to the editor: the refused Add leaves the Browser's inline editor
    // open (the two-layer Esc ladder: suggestions → editor → Browser). Walk
    // the ladder until the editor surface is really back, then the REAL
    // completion consumer types an `@` mention.
    for (let escapes = 0; escapes < 5; escapes += 1) {
      const view = h.view()
      if (!view.includes('Sessions ·') && !view.includes('Add directory')) break
      h.vt.sendInput('\x1b')
      await h.vt.waitForRender()
    }
    h.vt.sendInput('@alpha')
    try {
      await waitUntil(() => scopes.length > 0, 'the @ mention reached the Host-file port', 6_000)
    } catch (error) {
      process.stderr.write(`[p1-frame]\n${h.view()}\n[/p1-frame]\nfull=${String(h.app.isFullscreen())}\n`)
      throw error
    }
    const scope = scopes.at(-1)!
    assert.deepEqual(scope, { kind: 'workspace', workspaceId: 'workspace-a', selectionRevision: revisionBefore },
      'the still-confirmed Workspace answers @file despite the rejected Add (status is transient)')
  } finally {
    h.close()
  }
})

test('review P1: a SUCCESSFUL Add replaces the target; the pre-Add target stops answering', async (t) => {
  const nextIntent = createWorkspaceNextIntentOwner(undefined)
  nextIntent.setResolvedWorkspace('workspace-a', '/host/a')
  const revisionBefore = nextIntent.snapshot().revision
  const scopes: import('../../src/runtime/host-file-port.ts').HostFileScope[] = []
  const hostFile: TuiCommandRunner['hostFile'] = {
    listReferences: async (scope) => {
      scopes.push(scope)
      return { kind: 'ok', items: [{ path: 'beta.ts', kind: 'file' }] }
    },
    resolveReference: async () => ({ kind: 'unavailable', reason: 'not under test' }),
    canonicalizeMentions: async (_scope, text) => text,
  }
  const h = harness({
    workspaceNextIntent: nextIntent,
    hostFile,
    hostDirectoryBrowse: {
      list: async (path) => path === undefined
        ? pr3Ready(pr3Listing(PR3_HOME, ['project-b']))
        : pr3Ready(pr3Listing(path, [])),
    },
    agents: {
      resolveWorkspace: (async () => ({ workspaceId: 'workspace-b', path: '/host/b' })) as never,
    },
  })
  try {
    await h.runSessions('')
    await h.vt.waitForRender()
    h.vt.sendInput('\x1b[H')
    await h.vt.waitForRender()
    h.vt.sendInput('\r')
    await h.vt.waitForRender()
    await waitUntil(() => h.view().includes('project-b/'), 'the Add editor lists the Host level')
    h.vt.sendInput('\r')
    await waitUntil(() => nextIntent.snapshot().status === 'confirmed'
      && nextIntent.snapshot().revision > revisionBefore, 'the verified Add commits Workspace B')
    assert.deepEqual(nextIntent.capture()?.intent, { kind: 'workspace-id', workspaceId: 'workspace-b' })

    // Ordinary Add returns to the same Browser: close it back to the editor.
    for (let escapes = 0; escapes < 5; escapes += 1) {
      const view = h.view()
      if (!view.includes('Sessions ·') && !view.includes('Add directory')) break
      h.vt.sendInput('\x1b')
      await h.vt.waitForRender()
    }
    h.vt.sendInput('@beta')
    await waitUntil(() => scopes.length > 0, 'the @ mention reached the Host-file port', 6_000)
    const scope = scopes.at(-1)!
    assert.deepEqual(scope, { kind: 'workspace', workspaceId: 'workspace-b', selectionRevision: nextIntent.snapshot().revision },
      'the committed replacement owns the completion scope')
  } finally {
    h.close()
  }
})

test('review EXT-P1 sibling: the real Browser open keeps the confirmed Workspace identity after a REFUSED Add', async () => {
  const nextIntent = createWorkspaceNextIntentOwner(undefined)
  nextIntent.setResolvedWorkspace('workspace-a', '/host/a')
  // Spy the REAL production consumer: TuiApp.openSessionWorkspace receives the
  // command surface's captured subject (currentWorkspaceId → nextCreateWorkspaceId).
  const opens: Array<string | undefined> = []
  const original = TuiApp.prototype.openSessionWorkspace
  TuiApp.prototype.openSessionWorkspace = function recordedOpen(this: TuiApp, options) {
    opens.push((options as { readonly currentWorkspaceId?: string }).currentWorkspaceId)
    return original.call(this, options)
  } as typeof original
  const h = harness({
    workspaceNextIntent: nextIntent,
    hostDirectoryBrowse: {
      list: async (path) => path === undefined
        ? pr3Ready(pr3Listing(PR3_HOME, ['project-b']))
        : pr3Ready(pr3Listing(path, [])),
    },
    agents: {
      resolveWorkspace: (async () => {
        throw new Error('the Host refused the proposed workspace directory')
      }) as never,
    },
  })
  try {
    // Baseline: the first Browser open carries A's identity.
    await h.runSessions('')
    await h.vt.waitForRender()
    assert.deepEqual(opens, ['workspace-a'], 'the first open carries the confirmed Workspace identity')

    // The REAL refused Add of B.
    h.vt.sendInput('\x1b[H')
    await h.vt.waitForRender()
    h.vt.sendInput('\r')
    await h.vt.waitForRender()
    await waitUntil(() => h.view().includes('project-b/'), 'the Add editor lists the Host level')
    h.vt.sendInput('\r')
    await waitUntil(() => nextIntent.snapshot().status === 'rejected', 'the refused verification painted')
    for (let escapes = 0; escapes < 5; escapes += 1) {
      if (!h.view().includes('Sessions ·') && !h.view().includes('Add directory')) break
      h.vt.sendInput('\x1b')
      await h.vt.waitForRender()
    }
    opens.length = 0

    // Reopen: the subject must STILL carry A (identity, not transient status).
    await h.runSessions('')
    await h.vt.waitForRender()
    assert.deepEqual(opens, ['workspace-a'],
      'a refused Add must not clear the Browser/TSP next-create Workspace identity')
  } finally {
    TuiApp.prototype.openSessionWorkspace = original
    h.close()
  }
})

test('review EXT-P2 (/new): the final pre-dispatch gate cancels a sessionless /new whose auto proof expired during the last wait', async () => {
  const owner = createWorkspaceNextIntentOwner('/client/cwd', 'auto')
  // Model the mount preflight's confirmed auto candidate.
  const preflight = owner.beginPathVerification()
  owner.commitVerifiedPath(preflight, 'workspace-auto', '/host/cwd')
  assert.equal(owner.snapshot().status, 'confirmed')
  assert.equal(owner.snapshot().provenance, 'auto')

  let current = true
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const enteredGate = new Promise<void>(resolve => { entered = resolve })
  const creates: unknown[] = []
  const h = harness({
    workspaceNextIntent: owner,
    validateAutoWorkspace: () => current,
    awaitPendingDefaultWrite: async () => {
      entered()
      await hold
    },
    agents: {
      resolveWorkspace: (async () => ({ workspaceId: 'workspace-auto', path: '/host/cwd' })) as never,
      create: (async (input: unknown) => {
        creates.push(input)
        return { session: { id: 'must-not-exist' } }
      }) as never,
    },
    transitionTo: (async (steps: { create: () => Promise<unknown> }) => ({ ok: true, next: await steps.create() })) as never,
  })
  try {
    const pending = h.runCommand('new')
    await enteredGate
    // The launch directory object is replaced DURING the final default-write
    // wait — after the entry check, immediately before the Host dispatch.
    current = false
    release()
    const result = await pending
    assert.equal(result.kind, 'error')
    assert.match(result.kind === 'error' ? result.text : '', /verified local workspace changed/u)
    assert.deepEqual(creates, [],
      'the final gate must cancel the Session create when the auto proof expires during the last wait')
    assert.equal(owner.snapshot().status, 'unselected')
  } finally {
    h.close()
  }
})

test('review EXT-P1 (manual precedence): a Folder New into a VALID Workspace succeeds while the leftover auto proof is stale', async () => {
  const owner = createWorkspaceNextIntentOwner('/client/cwd', 'auto')
  const preflight = owner.beginPathVerification()
  owner.commitVerifiedPath(preflight, 'workspace-a', '/host/a')
  assert.equal(owner.snapshot().provenance, 'auto')

  const resolutions: unknown[] = []
  const creates: unknown[] = []
  const h = harness({
    workspaceNextIntent: owner,
    // The AUTO candidate's local proof has expired; an explicit manual choice
    // must NOT inherit this veto.
    validateAutoWorkspace: () => false,
    agents: {
      resolveWorkspace: (async (intent: unknown) => {
        resolutions.push(intent)
        return { workspaceId: 'workspace-b', path: '/host/b' }
      }) as never,
      create: (async (input: unknown) => {
        creates.push(input)
        return { session: { id: 'session-from-b' } }
      }) as never,
    },
    transitionTo: (async (steps: { create: () => Promise<unknown> }) => ({ ok: true, next: await steps.create() })) as never,
  })
  // Capture the REAL Folder-New callback the PiTUI Browser panel receives.
  let folderNew: ((workspaceId: string, settle?: unknown) => void) | undefined
  const originalOpen = TuiApp.prototype.openSessionWorkspace
  TuiApp.prototype.openSessionWorkspace = function recordedOpen(this: TuiApp, options) {
    const candidate = (options as { readonly onNewSession?: typeof folderNew }).onNewSession
    if (candidate !== undefined) folderNew = candidate
    return originalOpen.call(this, options)
  } as typeof originalOpen
  try {
    await h.openSessionBrowser({ scope: 'all' })
    await h.vt.waitForRender()
    assert.ok(folderNew !== undefined, 'the real Folder New callback reached the PiTUI panel')
    assert.equal(h.runner.currentSessionId, undefined, 'the manual-precedence case is SESSIONLESS')
    // THE REAL ENTRY: the Folder New action dispatches exactly this callback.
    folderNew('workspace-b', () => {})
    await waitUntil(() => creates.length === 1, 'the explicit Folder New dispatches the ONE create', 10_000)
    assert.deepEqual(resolutions, [{ kind: 'workspace-id', workspaceId: 'workspace-b' }],
      'the Folder New target is the chosen WorkspaceId, never the stale auto candidate')
    assert.equal((creates[0] as { workspaceId: string }).workspaceId, 'workspace-b',
      'a stale AUTO proof must not veto an explicit manual choice')
  } finally {
    TuiApp.prototype.openSessionWorkspace = originalOpen
    h.close()
  }
})
