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
import { TuiApp } from '../../src/tui-app.ts'
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
}): Harness {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { notifyDurationMs: 60_000 })
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
    hostShellCompletion: true,
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
  registerTuiCommandsWithDirectSeams(runner)
  const def = defs.find(entry => entry.name === 'sessions')
  assert.ok(def?.handler !== undefined, 'the sessions command must register')
  const invoke = (rawInput: string) =>
    (def!.handler as (inv: { commandId: ReturnType<typeof CommandId>; agent: never; rawInput: string; signal: AbortSignal }) => Promise<{ kind: 'success' } | { kind: 'error'; text: string }>)({
      commandId: CommandId('cmd-workspace-test'),
      agent: undefined as never,
      rawInput,
      signal: new AbortController().signal,
    })
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
    view: () => vt.getViewport().map(stripTerminalSequences).join('\n'),
    setAgent: (id) => { state.agent = id === undefined ? undefined : { session: { id } } as unknown as Agent },
  }
}

const baseline = (...items: readonly SessionWorkspaceFact[]): WorkspaceFactsFrame => ({ type: 'baseline', items })

test('/sessions opens the ONE fullscreen lease and proves Current only from official Workspace membership', async () => {
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
  await waitUntil(() => h.view().includes('Current workspace'), 'the official baseline resolves the scope')
  const scoped = h.view()
  assert.ok(scoped.includes('Current: curren'), `Current is the captured Session:\n${scoped}`)
  assert.ok(scoped.includes('Current session'), 'the proved member row paints')
  assert.ok(!scoped.includes('Other session') && !scoped.includes('Third session'),
    'a same-cwd Session in ANOTHER WorkspaceId never joins Current')

  // All restores every listed row; the App current Session and the switch route
  // are untouched by a UI scope change.
  h.vt.sendInput('w')
  await h.vt.waitForRender()
  h.vt.sendInput('\x1b[A')
  h.vt.sendInput('\r')
  await h.vt.waitForRender()
  assert.ok(h.view().includes('Workspace: All workspaces [w]'))
  assert.ok(h.view().includes('Other session') && h.view().includes('Third session'))
  assert.deepEqual(h.switchCalls, [], 'a browse scope change never switches a Session')
})

test('the global search ignores the browse scope and Host-only hits still paint', async () => {
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
  await waitUntil(() => h.view().includes('Current workspace'), 'Current is proved')
  h.vt.sendInput('/')
  await h.vt.waitForRender()
  h.vt.sendInput('needle')
  await waitUntil(() => h.view().includes('host excerpt without the literal term'), 'the global Host hit paints')
  const view = h.view()
  assert.ok(view.includes('Search all workspaces'))
  assert.ok(view.includes('Other session'), 'a Session outside the browse scope is still a global search hit')
  assert.ok(!view.includes('· needle'), 'the query is never appended to the Host result')
})

test('an interactive resume is successful only on the runtime committed outcome and closes the workspace once', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'project-a', sessionIds: [CURRENT, OTHER] },
  ))
  await waitUntil(() => h.view().includes('Current workspace'), 'Current is proved')
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
  await waitUntil(() => h.view().includes('Current workspace'), 'Current is proved')
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
  await waitUntil(() => h.view().includes('Current workspace'), 'Current is proved')
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

test('a normally ended official Workspace stream drops the proved Current scope', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline(
    { workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] },
    { workspaceId: 'ws-b', path: '/other', title: 'b', sessionIds: [OTHER] },
  ))
  await waitUntil(() => h.view().includes('Current workspace'), 'Current is proved')
  // The official Remote handle may end iterating after a valid baseline without
  // throwing; the proof is still gone.
  h.facts.handles[0]!.finish()
  await waitUntil(() => h.view().includes('Workspace scope unavailable'), 'the ended stream is visible')
  const after = h.view()
  assert.ok(after.includes('Workspace: All workspaces [w]'), 'an ended stream falls back to All')
  assert.ok(after.includes('Other session'), 'All restores every listed row')
})

test('a missing-Current fallback followed by a stream end paints ONE scope state', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  // The initial current intent cannot be proved by this baseline: the one-time
  // fallback line is painted. The stream then ends without a proof.
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-b', path: '/other', title: 'b', sessionIds: [OTHER] }))
  await waitUntil(() => h.view().includes('Current workspace unavailable'), 'the missing-Current fallback is painted')
  h.facts.handles[0]!.finish()
  await waitUntil(() => h.view().includes('Workspace scope unavailable'), 'the ended stream is visible')
  const after = h.view()
  assert.equal(
    after.split('\n').filter(line => line.includes('Current workspace unavailable')).length,
    0,
    `the superseded fallback must not survive beside the stream failure:\n${after}`,
  )
  assert.equal(
    after.split('\n').filter(line => line.includes('Workspace scope unavailable')).length,
    1,
    `the current scope fact is painted once:\n${after}`,
  )
})

test('a failed official Workspace stream drops the proved Current scope', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] }))
  await waitUntil(() => h.view().includes('Current workspace'), 'Current is proved')
  h.facts.handles[0]!.fail(new Error('workspace generation superseded'))
  await waitUntil(() => h.view().includes('Workspace scope unavailable'), 'the failed stream is visible')
  assert.ok(h.view().includes('Workspace: All workspaces [w]'), 'a failed stream falls back to All')
})

test('an active close owns the stream end and paints no stale scope failure', async () => {
  const h = harness({ currentSessionId: CURRENT })
  await h.runSessions('')
  await h.vt.waitForRender()
  h.facts.handles[0]!.push(baseline({ workspaceId: 'ws-a', path: '/ws', title: 'a', sessionIds: [CURRENT] }))
  await waitUntil(() => h.view().includes('Current workspace'), 'Current is proved')
  h.vt.sendInput('\x1b') // the user closes the workspace
  await h.vt.waitForRender()
  assert.equal(h.facts.handles[0]!.disposed, 1, 'the active close disposes the follow exactly once')
  h.facts.handles[0]!.finish() // a late normal end after the close
  await h.vt.waitForRender()
  assert.equal(
    h.notices.some(notice => notice.text.includes('Workspace scope unavailable')),
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

test('the native TSP presenter branch never subscribes to the PiTUI Workspace facts', async () => {
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
  assert.equal(h.facts.followCalls, 0, 'the native TSP branch must not subscribe to the PiTUI seam')
  assert.equal(h.facts.reads.length, 0, 'the native TSP branch never samples the PiTUI Activity seam')
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
  // Another Client wins the official request: the root drops the token. The
  // next Activity sample is held so the immediate drop can only come from the
  // eligibility invalidation itself.
  h.facts.holdNext()
  h.facts.setFacts([activityFact(CURRENT, { attention: 'none', attentionSourceState: 'known' })])
  eligible = []
  h.notifyEligibility()
  await waitUntil(() => !h.view().includes('Needs attention'), 'the stale Needs row is dropped immediately')
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
