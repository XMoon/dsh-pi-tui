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
import { EditorRegistry } from '../../src/extension/internal/editor-registry.ts'
import { AdvancedInputRegistry } from '../../src/extension/internal/advanced-input.ts'
import { normalizeInputEvent } from '../../src/extension/internal/input-events.ts'
import type { HistoryOpenScope } from '../../src/tui-app.ts'
import type { HistorySearchSource } from '../../src/client/history/search.ts'
import type { SettingsWorkspaceSource } from '../../src/tui/panels/settings-workspace-panel.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
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
  openSessionBrowser(scope?: 'current' | 'all'): Promise<{ kind: 'success' } | { kind: 'error'; text: string }>
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
}): Harness {
  const vt = new VirtualTerminal(100, 30)
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
    agents: {} as never,
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
    hostFile: new DirectHostFilePort(() => undefined),
    hostShellCompletion: { pathAuthority: 'client', complete: async () => ({ kind: 'ok', candidates: [] }) },
    requestExit: () => {},
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    switchSession: async () => undefined,
    switchSessionOutcome: async (id: string, scope?: SessionScope): Promise<SessionSwitchOutcome> => {
      switchCalls.push({ id, scope })
      return new Promise<SessionSwitchOutcome>((resolve) => { pendingSwitch = resolve })
    },
    transitionTo: async <T>(steps: { create: () => Promise<T> }) => ({ ok: true, next: await steps.create() }),
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    awaitPendingDefaultWrite: async () => {},
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
  const openSessionBrowser = (scope?: 'current' | 'all'): Promise<CommandOutcome> => {
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
  await waitUntil(() => !h.view().includes('Checking current workspace…'), 'the official baseline resolves the tree')
  const scoped = h.view()
  assert.ok(scoped.includes('Current: curren'), `Current is the captured Session:\n${scoped}`)
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
  await waitUntil(() => !h.view().includes('Checking current workspace…'), 'the official baseline is proved')
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
  await waitUntil(() => !h.view().includes('Checking current workspace…'), 'the official baseline is proved')
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

test('a failed interactive resume keeps the workspace and never reports success or retries', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT, OTHER] },
  ))
  await waitUntil(() => !h.view().includes('Checking current workspace…'), 'the official baseline is proved')
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
  await waitUntil(() => !h.view().includes('Checking current workspace…'), 'the official baseline is proved')
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
  await waitUntil(() => !h.view().includes('Checking current workspace…'), 'the official baseline is proved')
  // The official Remote handle may end iterating after a valid baseline without
  // throwing; the proof is still gone.
  h.facts.handles[0]!.finish()
  await waitUntil(() => h.view().includes('Workspace membership unavailable'), 'the ended stream is visible')
  const after = h.view()
  assert.ok(after.includes('Workspace: Information unavailable'), 'an ended stream paints the ONE unavailable membership annotation')
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
  assert.ok(after.includes('Workspace: Information unavailable'))
  assert.equal(after.split('\n').filter(line => line.includes('Current workspace unavailable')).length, 0)
  assert.equal(after.split('\n').filter(line => line.includes('Workspace membership unavailable')).length, 1)
})

test('a failed official Workspace stream keeps the roster usable without membership claims', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] }))
  await waitUntil(() => !h.view().includes('Checking current workspace…'), 'the official baseline is proved')
  h.facts.handles[0]!.fail(new Error('workspace generation superseded'))
  await waitUntil(() => h.view().includes('Workspace membership unavailable'), 'the failed stream is visible')
  assert.ok(h.view().includes('Workspace: Information unavailable'), 'a failed stream removes the folder authority')
  assert.ok(h.view().includes('Current session'), 'the retained flat session roster remains navigable')
})

test('an active close owns the stream end and paints no stale scope failure', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] }))
  await waitUntil(() => !h.view().includes('Checking current workspace…'), 'the official baseline is proved')
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
  await waitUntil(() => h.view().includes('Workspace: All workspaces'), 'the argument-free entry states the global tree')
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
  await waitUntil(() => h.view().includes('Workspace: All workspaces'), 'the global tree is stated')
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
