/**
 * M4 PR4 — the accepted business-write lifetime of `/reload-client` safety.
 *
 * `SubmissionController.hasUnsettledClientWrite()` must be a REAL read of the
 * owning lifecycles, not a display flag:
 *
 * - a submitted prompt keeps it true from the synchronous acceptance (the
 *   composer is already cleared) until the writer settles;
 * - a steer keeps it true for the same window;
 * - the `!` shell gesture keeps it true until the REAL user-shell owner
 *   settles, including the context-mode Session write of its output;
 * - an Alt+Up queue mutation keeps it true until its queue write settles;
 * - the `/reload-client` control command itself is NOT a business write (it
 *   would otherwise make the reload refuse itself).
 *
 * EVIDENCE LEVEL: unit / composition over the REAL `createSubmissionController`,
 * `bindSubmissionRuntime`, `createUserShell` and `pullBackQueue` owners. The
 * same owner → bootstrap safety → process sink chain is exercised by the
 * mounted-Remote runner suite.
 *
 * @module @xmoon76/dsh-pi-tui/client-reload-write-lifetime.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { createSubmissionController, type SubmissionController, type SubmissionControllerDeps } from '../../src/app/submission/controller.ts'
import {
  bindSubmissionRuntime,
  pullBackQueue,
  type SubmissionRuntimeSurface,
} from '../../src/app/submission/runtime.ts'
import { preparePrompt } from '../../src/app/submission/prepared-prompt.ts'
import { mergeDraft } from '../../src/app/submission/steer.ts'
import { createUserShell } from '../../src/app/submission/user-shell.ts'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import { createSessionScopeAuthority } from '../../src/app/session/scope.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { HostUserShellOutcomeUnknownError } from '../../src/runtime/host-user-shell-port.ts'
import type { HostUserShellOutcome, HostUserShellResult } from '../../src/runtime/host-user-shell-port.ts'
import type { WriteOutcome } from '../../src/runtime/session-writer-port.ts'

const DIAG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

interface AgentLike {
  status: string
  readonly session: { readonly id: string }
  readonly options: Record<string, unknown>
  cancel(): void
}

interface Harness {
  readonly controller: ReturnType<typeof createSubmissionController<AgentLike>>
  readonly writes: { readonly sessionId: string; readonly message: unknown }[]
  /** Resolve the next held Session write with `outcome`. */
  finishWrite(outcome: WriteOutcome): void
  /** The `/reload-client` client-registry executions that reached the fake. */
  readonly clientCommandCalls: number
  readonly agent: AgentLike
  readonly notices: string[]
}

function startHarness(): Harness {
  let draft = ''
  const notices: string[] = []
  const writes: { sessionId: string; message: unknown }[] = []
  const writeResolvers: ((outcome: WriteOutcome) => void)[] = []
  const composer = {
    getDraft: () => draft,
    setDraft: (text: string) => { draft = text },
    setEditorText: (text: string) => { draft = text },
    insertIntoEditor: (text: string) => { draft += text },
    notify: (message: string) => { notices.push(message) },
    setSubmitPending: () => {},
    clearSettledLocalMessages: () => {},
  }
  const agent: AgentLike = { status: 'idle', session: { id: 'session-a' }, options: {}, cancel: () => {} }
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner({} as never, 'session-a')
  const scopeAuthority = createSessionScopeAuthority({
    current: () => {
      const subject = core.subject()
      if (subject === undefined) throw new Error('fixture: the owner is not published')
      return { sessionId: 'session-a', generation: core.generation(), subject }
    },
    isSubjectCurrent: (subject) => core.isSubjectCurrent(subject),
  })
  const runtimeSurface: SubmissionRuntimeSurface = {
    withWriter: async (_scope, task) => task(),
    withPromptAdmission: async (_scope, _line, task) => task(),
    isDisposed: () => false,
    isScopeCurrent: () => true,
    mergeDraftIntoEditor: (text) => {
      const merged = mergeDraft(draft, text)
      draft = merged
      return merged === text
    },
    restoreStaleDraftIntoEditor: (text) => {
      const merged = mergeDraft(draft, text)
      draft = merged
      return merged === text ? 'merged-verbatim' : 'merged'
    },
    consumeDraftAttachments: () => {},
    markDispatch: () => {},
    beginLocalSubmission: () => {},
    settleLocalSubmission: () => {},
    settleSubmitAck: () => {},
    notify: (message) => { notices.push(message) },
    refuseByTransitionFence: (text) => { draft = mergeDraft(draft, text) },
    prepareMessage: async (text, requestId) => preparePrompt('session-a', text, { images, files }, requestId),
    prompt: (sessionId, message) => new Promise<WriteOutcome>((resolve) => {
      writes.push({ sessionId, message })
      writeResolvers.push(resolve)
    }),
  }
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const submissionRuntime = bindSubmissionRuntime({ surface: runtimeSurface })
  let clientCommandCalls = 0
  const command = {
    wasAdvertisedClaim: () => false,
    hostClaimOf: () => undefined,
    hostOriginClaimOf: () => undefined,
    hostCatalogResolves: () => false,
    // `/reload-client` is a LIVE Client-owned local command in this harness.
    clientClaimsLine: (parsed: { name: string } | undefined) => parsed?.name === 'reload-client',
    isSkillWrapperName: () => false,
    isSkillInvocation: () => false,
    withCommandDelivery: <T,>(_delivery: unknown, run: () => T): T => run(),
    takeCommandDraftDisposition: () => undefined,
    clientCommands: {
      get: () => undefined,
      execute: async () => {
        clientCommandCalls += 1
        return { commandId: 'cmd-client-reload', result: { kind: 'success' as const } }
      },
    },
  }
  const deps: SubmissionControllerDeps<AgentLike> = {
    app: () => composer,
    diag: DIAG,
    signal: new AbortController().signal,
    isCleanedUp: () => false,
    logError: () => {},
    liveAgent: () => agent,
    ownership: {
      generation: () => core.generation(),
      captureSubject: () => core.subject(),
      transitionPending: () => false,
      awaitTransitionSettled: async () => {},
      beginNavigationIntent: () => () => {},
      soleNavigationIntentPending: () => false,
    },
    scope: {
      captureLive: () => scopeAuthority.captureLive(),
      isCurrent: (scope) => scopeAuthority.isCurrent(scope),
      requireLive: () => {
        const live = scopeAuthority.captureLive()
        if (live === undefined) throw new Error('fixture: the owner is not live')
        return live
      },
    },
    session: {
      ensureSession: async () => {},
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
    },
    submissionRuntime,
    command: command as unknown as SubmissionControllerDeps<AgentLike>['command'],
    commandPlane: { available: () => true, execute: async () => undefined, findHandler: () => undefined },
    backendKind: 'remote',
    backend: {
      hostFile: { canonicalizeMentions: async (_scope: unknown, text: string) => text } as never,
      // A live, empty semantic queue projection (the steer read).
      pendingInputReader: { snapshot: () => ({ running: true, items: [] }) },
      // Steer writes go through the session writer directly.
      sessionWriter: {
        prompt: (sessionId: string, message: unknown) => new Promise<WriteOutcome>((resolve) => {
          writes.push({ sessionId, message })
          writeResolvers.push(resolve)
        }),
        updateQueue: async () => ({ kind: 'committed', value: undefined }),
      } as never,
      hostCommand: { execute: async () => ({ kind: 'committed', matched: false }) } as never,
    },
    drafts: { images, files },
    status: { sessionCwd: () => '/tmp' },
    surface: { refreshPendingInput: () => {} },
    history: {
      persist: () => {},
      persistAfterSession: async (resolveSession, persist) => { persist(await resolveSession()) },
    },
    viewer: { isViewing: () => false },
    extensions: {
      findContribution: () => undefined,
      handlerFor: () => undefined,
      commandIdFor: () => undefined,
      recordHealthRef: () => undefined,
      recordError: () => {},
      clearError: () => {},
    },
    artifacts: { start: () => {} },
    shell: { capturePlacement: () => ({ anchor: undefined, turn: undefined, target: 'beginning' as const, acceptedOrder: 0 }), run: () => {}, interrupt: () => {}, cancelRun: () => false },
    supportsLocalShellCards: true,
    supportsTuiBuiltinUi: true,
    retainsStaleDraftRestore: true,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined as never, llm: () => undefined as never },
    tuiSettings: undefined,
    captureMatches: (subject) => core.isSubjectCurrent(subject as never),
    ownerWasReplaced: (subject) => core.subjectAuthority.ownerReplaced(subject as never),
    direct: { withPromptAdmission: async (_agent, _hasImages, task) => task() },
    requestExit: () => {},
    isPlanActive: () => false,
    prepareTransport: async (text, requestId) => preparePrompt('session-a', text, { images, files }, requestId),
  }
  const controller = createSubmissionController<AgentLike>(deps)
  return {
    controller,
    writes,
    finishWrite: (outcome) => {
      const resolve = writeResolvers.shift()
      assert.ok(resolve !== undefined, 'no Session write is pending')
      resolve(outcome)
    },
    get clientCommandCalls() { return clientCommandCalls },
    agent,
    notices,
  }
}

/** Drain the microtask chain of the submission owner (no fixed timer). */
async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 80; index += 1) await Promise.resolve()
}

test('a submitted prompt keeps the Client write unsettled until its writer settles', async () => {
  const harness = startHarness()
  harness.controller.submit('hello')
  assert.equal(harness.controller.hasUnsettledClientWrite(), true,
    'the composer was cleared at this synchronous acceptance — the write is unsettled')
  await drainMicrotasks()
  assert.equal(harness.writes.length, 1, 'the prompt reached the writer')
  assert.equal(harness.controller.hasUnsettledClientWrite(), true,
    'an in-flight Session write is unsettled until its terminal outcome')
  harness.finishWrite({ kind: 'committed', value: undefined })
  await drainMicrotasks()
  assert.equal(harness.controller.hasUnsettledClientWrite(), false,
    'the committed write releases the lifetime exactly once')
})

test('a steered draft keeps the Client write unsettled until its writer settles', async () => {
  const harness = startHarness()
  harness.agent.status = 'running'
  harness.controller.steer('more context')
  assert.equal(harness.controller.hasUnsettledClientWrite(), true,
    'the steer gesture is accepted synchronously, before its async preparation')
  await drainMicrotasks()
  assert.equal(harness.writes.length, 1, 'the steer reached the writer')
  assert.equal(harness.controller.hasUnsettledClientWrite(), true)
  harness.finishWrite({ kind: 'committed', value: undefined })
  await drainMicrotasks()
  assert.equal(harness.controller.hasUnsettledClientWrite(), false)
})

test('the /reload-client control command itself is not counted as a business write', async () => {
  const harness = startHarness()
  harness.agent.status = 'running'
  harness.controller.submit('/reload-client')
  assert.equal(harness.controller.hasUnsettledClientWrite(), false,
    'a local control command must never make the reload refuse itself')
  await drainMicrotasks()
  assert.equal(harness.clientCommandCalls, 1, 'the live Client registry executed the command')
  assert.equal(harness.writes.length, 0, 'the reload line never became a model prompt')
  assert.equal(harness.controller.hasUnsettledClientWrite(), false)
})

/**
 * A REAL `SubmissionController` + REAL `createUserShell` composition whose
 * Session writer is HELD by the test: the accepted `!` gesture's context-mode
 * output write is therefore provably in flight while the assertion runs.
 */
interface ShellHarness {
  readonly controller: SubmissionController
  readonly writes: { readonly sessionId: string; readonly message: unknown }[]
  finishWrite(outcome: WriteOutcome): void
  finishShell(result: HostUserShellResult): void
  failShell(error: unknown): void
  readonly agent: AgentLike
  readonly card: () => { readonly result?: string; readonly status?: string } | undefined
  /** Every currently owned local card (identity-targeted removal witness). */
  readonly cards: () => { readonly args?: string; readonly result?: string; readonly status?: string; readonly submission?: { readonly kind: string; readonly reason: string } }[]
  /** Queue the placement values a subsequent capture returns. */
  queuePlacements(values: readonly unknown[]): void
  readonly captureCalls: () => number
  readonly pushedPlacement: () => unknown
  /** Hold the next ensureSession() until released. */
  armEnsureGate(): void
  releaseEnsureGate(): void
  readonly executions: number
}

function shellOk(stdout = ''): HostUserShellResult {
  return {
    exit: { kind: 'exit', code: 0 },
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
    sandboxDenied: false,
    aborted: false,
    timedOut: false,
  }
}

function startShellHarness(composerOverride?: unknown): ShellHarness {
  let draft = ''
  const notices: string[] = []
  const writes: { sessionId: string; message: unknown }[] = []
  const writeResolvers: ((outcome: WriteOutcome) => void)[] = []
  const shellResolvers: ((result: HostUserShellResult) => void)[] = []
  const shellFailures: ((error: unknown) => void)[] = []
  let lastCard: { args?: string; result?: string; status?: string; submission?: { kind: string; reason: string } } | undefined
  let cards: { args?: string; result?: string; status?: string; submission?: { kind: string; reason: string } }[] = []
  let executions = 0
  let captureCalls = 0
  let queuedPlacements: unknown[] = []
  let lastPlacement: unknown
  let ensureGate: Promise<void> | undefined
  let releaseEnsure: (() => void) | undefined
  const composer: any = composerOverride ?? {
    getDraft: () => draft,
    setDraft: (text: string) => { draft = text },
    setEditorText: (text: string) => { draft = text },
    insertIntoEditor: (text: string) => { draft += text },
    notify: (message: string) => { notices.push(message) },
    setSubmitPending: () => {},
    clearSettledLocalMessages: () => {},
    captureLocalShellPlacement: () => {
      captureCalls += 1
      return (queuedPlacements.shift() ?? { anchor: undefined, turn: undefined, target: 'beginning' as const, acceptedOrder: 0 }) as never
    },
    pushLocalMessage: (message: unknown, placement: unknown) => {
      lastPlacement = placement
      lastCard = message as { args?: string; result?: string; status?: string }
      cards.push(lastCard)
      return message
    },
    updateLocalMessage: (current: unknown, message: unknown) => {
      lastCard = message as { args?: string; result?: string; status?: string }
      const index = cards.indexOf(current as { args?: string })
      if (index !== -1) cards[index] = lastCard
      return message
    },
    removeLocalMessage: (message: unknown) => {
      const index = cards.indexOf(message as { args?: string })
      if (index === -1) return false
      cards = cards.filter((_card, cardIndex) => cardIndex !== index)
      if (lastCard === message) lastCard = cards.at(-1)
      return true
    },
    setLocalShellSubmissionState: (message: unknown, state: { kind: string; reason: string }) => {
      const card = cards.find(candidate => candidate === message as { args?: string })
      if (card === undefined) return false
      card.submission = state
      return true
    },
  }
  const agent: AgentLike = { status: 'idle', session: { id: 'session-a' }, options: {}, cancel: () => {} }
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner({} as never, 'session-a')
  const scopeAuthority = createSessionScopeAuthority({
    current: () => {
      const subject = core.subject()
      if (subject === undefined) throw new Error('fixture: the owner is not published')
      return { sessionId: 'session-a', generation: core.generation(), subject }
    },
    isSubjectCurrent: (subject) => core.isSubjectCurrent(subject),
  })
  const sessionWriter = {
    prompt: (sessionId: string, message: unknown) => new Promise<WriteOutcome>((resolve) => {
      writes.push({ sessionId, message })
      writeResolvers.push(resolve)
    }),
    updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
  }
  const runtimeSurface: SubmissionRuntimeSurface = {
    withWriter: async (_scope, task) => task(),
    withPromptAdmission: async (_scope, _line, task) => task(),
    isDisposed: () => false,
    isScopeCurrent: () => true,
    mergeDraftIntoEditor: (text) => {
      const merged = mergeDraft(draft, text)
      draft = merged
      return merged === text
    },
    restoreStaleDraftIntoEditor: (text) => {
      const merged = mergeDraft(draft, text)
      draft = merged
      return merged === text ? 'merged-verbatim' : 'merged'
    },
    consumeDraftAttachments: () => {},
    markDispatch: () => {},
    beginLocalSubmission: () => {},
    settleLocalSubmission: () => {},
    settleSubmitAck: () => {},
    notify: (message) => { notices.push(message) },
    refuseByTransitionFence: (text) => { draft = mergeDraft(draft, text) },
    prepareMessage: async (text, requestId) => preparePrompt('session-a', text, { images, files }, requestId),
    prompt: sessionWriter.prompt,
  }
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const submissionRuntime = bindSubmissionRuntime({ surface: runtimeSurface })
  let controller: ReturnType<typeof createSubmissionController<AgentLike>> | undefined
  const shell = createUserShell<AgentLike>({
    app: () => composer as never,
    notify: () => {},
    diag: DIAG,
    isCleanedUp: () => false,
    liveAgent: () => agent,
    ownership: { generation: () => core.generation() },
    session: {
      withWriter: async (_scope, task) => task(),
      interrupt: async () => ({ kind: 'committed', value: undefined }),
    },
    requireLiveScope: () => {
      const live = scopeAuthority.captureLive()
      if (live === undefined) throw new Error('fixture: the owner is not live')
      return live
    },
    captureLiveScope: () => scopeAuthority.captureLive(),
    isLiveScopeCurrent: scope => scopeAuthority.isCurrent(scope),
    // The REAL SessionRuntime writer admission for the captured shell scope.
    writerSection: async (scope, task) => {
      if (controller === undefined) throw new Error('fixture: the controller is not built')
      return await controller.withShellWriterSection(scope, task)
    },
    writer: sessionWriter as never,
    status: { sessionCwd: () => '/tmp' },
    tuiSettings: undefined,
    shell: {
      availability: () => ({ supported: true, policies: ['bypass'] }),
      execute: async (): Promise<HostUserShellOutcome> => {
        executions += 1
        return await new Promise<HostUserShellOutcome>((resolve, reject) => {
          shellResolvers.push(result => resolve({ kind: 'settled', result }))
          shellFailures.push(reject)
        })
      },
    } as never,
    submission: {
      settleAck: (reason, options) => { controller?.settleLocalSubmitAck(reason, options) },
      markDispatch: (sessionId) => { controller?.markDispatch(sessionId) },
    },
  })
  const command = {
    wasAdvertisedClaim: () => false,
    hostClaimOf: () => undefined,
    hostOriginClaimOf: () => undefined,
    hostCatalogResolves: () => false,
    clientClaimsLine: () => false,
    isSkillWrapperName: () => false,
    isSkillInvocation: () => false,
    withCommandDelivery: <T,>(_delivery: unknown, run: () => T): T => run(),
    takeCommandDraftDisposition: () => undefined,
    clientCommands: { get: () => undefined, execute: async () => undefined },
  }
  const deps: SubmissionControllerDeps<AgentLike> = {
    app: () => composer,
    diag: DIAG,
    signal: new AbortController().signal,
    isCleanedUp: () => false,
    logError: () => {},
    liveAgent: () => agent,
    ownership: {
      generation: () => core.generation(),
      captureSubject: () => core.subject(),
      transitionPending: () => false,
      awaitTransitionSettled: async () => {},
      beginNavigationIntent: () => () => {},
      soleNavigationIntentPending: () => false,
    },
    scope: {
      captureLive: () => scopeAuthority.captureLive(),
      isCurrent: (scope) => scopeAuthority.isCurrent(scope),
      requireLive: () => {
        const live = scopeAuthority.captureLive()
        if (live === undefined) throw new Error('fixture: the owner is not live')
        return live
      },
    },
    session: {
      ensureSession: () => ensureGate ?? Promise.resolve(),
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
    },
    submissionRuntime,
    command: command as unknown as SubmissionControllerDeps<AgentLike>['command'],
    commandPlane: { available: () => true, execute: async () => undefined, findHandler: () => undefined },
    backendKind: 'remote',
    backend: {
      hostFile: { canonicalizeMentions: async (_scope: unknown, text: string) => text } as never,
      pendingInputReader: { snapshot: () => ({ running: true, items: [] }) },
      sessionWriter: sessionWriter as never,
      hostCommand: { execute: async () => ({ kind: 'committed', matched: false }) } as never,
    },
    drafts: { images, files },
    status: { sessionCwd: () => '/tmp' },
    surface: { refreshPendingInput: () => {} },
    history: {
      persist: () => {},
      persistAfterSession: async (resolveSession, persist) => { persist(await resolveSession()) },
    },
    viewer: { isViewing: () => false },
    extensions: {
      findContribution: () => undefined,
      handlerFor: () => undefined,
      commandIdFor: () => undefined,
      recordHealthRef: () => undefined,
      recordError: () => {},
      clearError: () => {},
    },
    artifacts: { start: () => {} },
    shell: { capturePlacement: () => shell.capturePlacement(), run: (text, ackToken, endWrite, placement) => shell.run(text, ackToken, endWrite, placement), interrupt: () => shell.interrupt(), cancelRun: () => shell.cancelRun() },
    supportsLocalShellCards: true,
    supportsTuiBuiltinUi: true,
    retainsStaleDraftRestore: true,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined as never, llm: () => undefined as never },
    tuiSettings: undefined,
    captureMatches: (subject) => core.isSubjectCurrent(subject as never),
    ownerWasReplaced: (subject) => core.subjectAuthority.ownerReplaced(subject as never),
    direct: { withPromptAdmission: async (_agent, _hasImages, task) => task() },
    requestExit: () => {},
    isPlanActive: () => false,
    prepareTransport: async (text, requestId) => preparePrompt('session-a', text, { images, files }, requestId),
  }
  controller = createSubmissionController<AgentLike>(deps)
  return {
    controller,
    writes,
    finishWrite: (outcome) => {
      const resolve = writeResolvers.shift()
      assert.ok(resolve !== undefined, 'no Session write is pending')
      resolve(outcome)
    },
    finishShell: (result) => {
      const resolve = shellResolvers.shift()
      assert.ok(resolve !== undefined, 'no Host shell execution is pending')
      // Each execution pushed BOTH a resolver and a rejecter; consume the
      // sibling so the next failShell settles the NEXT execution.
      shellFailures.shift()
      resolve(result)
    },
    failShell: (error) => {
      const reject = shellFailures.shift()
      assert.ok(reject !== undefined, 'no Host shell execution is pending')
      shellResolvers.shift()
      reject(error)
    },
    agent,
    card: () => lastCard,
    cards: () => cards,
    queuePlacements: values => { queuedPlacements = [...values] },
    captureCalls: () => captureCalls,
    pushedPlacement: () => lastPlacement,
    armEnsureGate: () => {
      ensureGate = new Promise<void>(resolve => { releaseEnsure = resolve })
    },
    releaseEnsureGate: () => {
      releaseEnsure?.()
      releaseEnsure = undefined
      ensureGate = undefined
    },
    get executions() { return executions },
  }
}

test('the ! context-mode output write keeps the lifetime until the REAL Session writer settles', async () => {
  const harness = startShellHarness()
  harness.controller.submit('! echo hi')
  assert.equal(harness.controller.hasUnsettledClientWrite(), true,
    'the ! gesture is accepted synchronously, before any write starts')
  await drainMicrotasks()
  assert.equal(harness.executions, 1, 'the real user-shell owner admitted the Host execution')
  assert.equal(harness.controller.hasUnsettledClientWrite(), true, 'a running ! shell is unsettled')

  // The Host shell execution settles (the card result is now known), which
  // starts the context-mode `!` output write through the REAL Session writer.
  harness.finishShell(shellOk())
  await drainMicrotasks()
  assert.equal(harness.writes.length, 1,
    'the settled ! result reached the Session writer (the card already settled)')
  assert.equal(harness.writes[0]!.sessionId, 'session-a',
    'the ! result is written to the EXACT captured Session scope once')
  assert.equal(harness.controller.hasUnsettledClientWrite(), true,
    'the lifetime stays open while the REAL context-mode output write is in flight')

  // The writer's terminal settlement is the ONE release point.
  harness.finishWrite({ kind: 'committed', value: undefined })
  await drainMicrotasks()
  assert.equal(harness.controller.hasUnsettledClientWrite(), false,
    'the Session write terminal settlement releases the lifetime exactly once')

  // A second gesture is still counted normally and released: no latch, no
  // underflow from the first release.
  harness.controller.submit('! echo again')
  await drainMicrotasks()
  assert.equal(harness.executions, 2)
  assert.equal(harness.controller.hasUnsettledClientWrite(), true)
  harness.finishShell(shellOk())
  await drainMicrotasks()
  assert.equal(harness.writes.length, 2)
  assert.equal(harness.controller.hasUnsettledClientWrite(), true)
  harness.finishWrite({ kind: 'committed', value: undefined })
  await drainMicrotasks()
  assert.equal(harness.controller.hasUnsettledClientWrite(), false)
})

test('!! paints its bounded output on the card and never writes the Session', async () => {
  const harness = startShellHarness()
  harness.controller.submit('!! echo hi')
  await drainMicrotasks()
  assert.equal(harness.executions, 1, 'the Host execution was admitted')
  assert.equal(harness.controller.hasUnsettledClientWrite(), true, 'a running !! shell keeps the reload blocked')
  harness.finishShell({
    ...shellOk(),
    stdout: { text: 'card-only-output\n', truncated: false },
  })
  await drainMicrotasks()
  assert.equal(harness.writes.length, 0, '!! never writes to the Session')
  assert.match(harness.card()?.result ?? '', /card-only-output/u,
    '!! keeps the completed output on its card')
  assert.match(harness.card()?.result ?? '', /\[exit 0\]/u, '!! keeps the real exit fact on its card')
  assert.equal(harness.controller.hasUnsettledClientWrite(), false,
    "the !! card's settlement is the terminal path")
})

test('an unknown ! outcome writes no Session result and is never replayed', async () => {
  const harness = startShellHarness()
  harness.controller.submit('! echo lost')
  await drainMicrotasks()
  assert.equal(harness.executions, 1, 'the ! gesture made exactly one Host execution request')
  harness.failShell(new HostUserShellOutcomeUnknownError('Host shell execution could not be verified'))
  await drainMicrotasks()
  assert.equal(harness.writes.length, 0, 'an unknown Host outcome is never written to the Session')
  assert.match(harness.card()?.result ?? '', /Host shell execution could not be verified/u)
  assert.match(harness.card()?.result ?? '', /may have executed/u)
  assert.match(harness.card()?.result ?? '', /do not retry automatically/u)
  assert.equal(harness.controller.hasUnsettledClientWrite(), false,
    'the unknown ! outcome still settles the gesture lifetime')
})

test('an Alt+Up queue mutation keeps the write lifetime until its queue write settles', async () => {
  let finishRemoval!: (outcome: WriteOutcome) => void
  const removal = new Promise<WriteOutcome>(resolve => { finishRemoval = resolve })
  let ended = 0
  const writes: { readonly kind: 'remove'; readonly id: string }[] = []
  pullBackQueue({
    isDisposed: () => false,
    isViewing: () => false,
    currentAgent: () => ({ session: { id: 'session-a' } }),
    captureOwnerToken: () => ({}),
    isOwnerTokenCurrent: () => true,
    requireLiveScope: () => ({ sessionId: 'session-a' } as never),
    readPullableQueue: () => [{ id: 'message-1', content: [{ type: 'text', text: 'queued text' }] }],
    isTransitionPending: () => false,
    withWriter: async (_scope, task) => task(),
    updateQueue: async (_sessionId, messageId, operation) => {
      writes.push({ kind: operation.kind, id: messageId })
      return await removal
    },
    deferQueueRecall: () => {},
    stageRecalledImage: () => ({ id: 1, placeholder: '[image #1]' }),
    stageRecalledFile: () => ({ id: 1, placeholder: '[file #1]' }),
    discardStagedDraft: () => {},
    pinRecalledDrafts: () => () => {},
    readDraft: () => '',
    writeDraft: () => {},
    notify: () => {},
    refreshPendingInput: () => {},
    diag: DIAG,
    beginClientWrite: () => {
      let released = false
      return () => {
        if (released) return
        released = true
        ended += 1
      }
    },
  })
  await drainMicrotasks()
  assert.deepEqual(writes, [{ kind: 'remove', id: 'message-1' }], 'the queue removal was admitted')
  assert.equal(ended, 0, 'the mutation is unsettled while the writer is in flight')
  finishRemoval({ kind: 'committed', value: undefined })
  await drainMicrotasks()
  assert.equal(ended, 1, 'the queue mutation releases at its terminal settlement')
})

test('a committed ! removes only its own card, while !! and sibling submits keep theirs', async () => {
  const harness = startShellHarness()
  harness.controller.submit('!! echo A')
  await drainMicrotasks()
  harness.finishShell(shellOk('A-OUT'))
  await drainMicrotasks()
  assert.equal(harness.writes.length, 0, '!! never writes the Session')
  assert.deepEqual(harness.cards().map(card => card.args), ['echo A'])

  harness.controller.submit('! echo B')
  await drainMicrotasks()
  harness.finishShell(shellOk('B-OUT'))
  await drainMicrotasks()
  assert.equal(harness.writes.length, 1, 'the ! result started its context write')
  harness.finishWrite({ kind: 'committed', value: undefined })
  await drainMicrotasks()
  const remaining = harness.cards()
  assert.deepEqual(remaining.map(card => card.args), ['echo A'], 'only the committed ! card is removed')
  assert.equal(remaining[0]!.submission, undefined, 'a committed ! card is removed, not marked')
  assert.equal(remaining[0]!.status, 'ok', 'the settled !! card stays visible')

  // A normal prompt and a Ctrl+S steer never dismiss the retained !! card.
  harness.controller.submit('hello')
  await drainMicrotasks()
  harness.finishWrite({ kind: 'committed', value: undefined })
  await drainMicrotasks()
  assert.deepEqual(harness.cards().map(card => card.args), ['echo A'], 'an ordinary prompt keeps !!')
  harness.agent.status = 'running'
  harness.controller.steer('more context')
  await drainMicrotasks()
  harness.finishWrite({ kind: 'committed', value: undefined })
  await drainMicrotasks()
  assert.deepEqual(harness.cards().map(card => card.args), ['echo A'], 'a steer keeps !!')
})

test('a rejected or indeterminate ! write keeps its own card and every other !!', async () => {
  const harness = startShellHarness()
  harness.controller.submit('!! echo A')
  await drainMicrotasks()
  harness.finishShell(shellOk('A-OUT'))
  await drainMicrotasks()

  harness.controller.submit('! echo B')
  await drainMicrotasks()
  harness.finishShell(shellOk('B-OUT'))
  await drainMicrotasks()
  harness.finishWrite({ kind: 'rejected', error: { code: 'busy', message: 'writer refused' } })
  await drainMicrotasks()
  const rejectedCards = harness.cards()
  assert.deepEqual(rejectedCards.map(card => card.args), ['echo A', 'echo B'],
    'a rejected ! write keeps its diagnostic card beside the settled !!')
  assert.equal(rejectedCards[1]!.submission?.kind, 'not-submitted', 'the rejected card keeps a persistent failure state')
  assert.match(rejectedCards[1]!.submission?.reason ?? '', /writer refused/u, 'the writer reason stays on the card')

  harness.controller.submit('! echo C')
  await drainMicrotasks()
  harness.finishShell(shellOk('C-OUT'))
  await drainMicrotasks()
  harness.finishWrite({ kind: 'indeterminate', error: { code: 'transport/unknown', message: 'unknown' } })
  await drainMicrotasks()
  const indeterminateCards = harness.cards()
  assert.deepEqual(indeterminateCards.map(card => card.args), ['echo A', 'echo B', 'echo C'],
    'an indeterminate ! write never removes the card')
  assert.equal(indeterminateCards[2]!.submission?.kind, 'uncertain', 'the indeterminate write is persistently marked uncertain')
  assert.match(indeterminateCards[2]!.submission?.reason ?? '', /do not retry automatically/u,
    'the no-retry warning stays on the card')

  harness.controller.submit('!! echo D')
  await drainMicrotasks()
  harness.failShell(new HostUserShellOutcomeUnknownError('Host shell result was lost'))
  await drainMicrotasks()
  const cards = harness.cards()
  assert.deepEqual(cards.map(card => card.args), ['echo A', 'echo B', 'echo C', 'echo D'])
  assert.equal(cards.at(-1)!.status, 'error', 'the UNKNOWN Host outcome stays as a diagnostic card')
  assert.equal(harness.writes.length, 2, 'no UNKNOWN outcome was written to the Session')
  assert.match(cards.at(-1)!.result ?? '', /do not retry automatically/u)
})

test('the shell placement is captured synchronously at submit and reaches push after the async session create', async () => {
  const harness = startShellHarness()
  const first = { anchor: { kind: 'assistant', turn: 1, text: 'anchor-A' }, turn: 1, target: 'anchored', acceptedOrder: 1 }
  const second = { anchor: { kind: 'assistant', turn: 2, text: 'anchor-B' }, turn: 2, target: 'anchored', acceptedOrder: 2 }
  harness.queuePlacements([first, second])
  harness.controller.submit('!! echo A')
  assert.equal(harness.captureCalls(), 1, 'the accepted gesture captures its placement synchronously')
  await drainMicrotasks()
  harness.finishShell(shellOk('A-OUT'))
  await drainMicrotasks()
  assert.strictEqual(harness.pushedPlacement(), first,
    'the card receives the gesture-time placement, never a later re-capture')
})

test('a real TuiApp + controller shell gesture keeps its gesture-time transcript anchor across a gated ensure', async () => {
  const vt = new VirtualTerminal(80, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  try {
    const harness = startShellHarness(app)
    const anchor = { kind: 'assistant' as const, turn: 0, text: 'ANCHOR_MESSAGE' }
    const later = { kind: 'assistant' as const, turn: 1, text: 'LATER_MESSAGE' }
    app.setTranscript([anchor])
    await vt.waitForRender()

    harness.armEnsureGate()
    harness.controller.submit("!!printf 'SHELL_E2E\\n'")
    // The accepted gesture must have captured ANCHOR (the current tail) NOW,
    // before ensureSession resolves. Simulate later Agent content arriving
    // while the session create is still gated.
    app.setTranscript([anchor, later])
    await vt.waitForRender()
    harness.releaseEnsureGate()
    await drainMicrotasks()
    assert.equal(harness.executions, 1, 'the gated ensure eventually admitted the Host execution')
    harness.finishShell(shellOk('SHELL_E2E'))
    await drainMicrotasks()
    await vt.waitForRender()

    const view = vt.getViewport().join('\n')
    const anchorRow = view.split('\n').findIndex(line => line.includes('ANCHOR_MESSAGE'))
    const shellRow = view.split('\n').findIndex(line => line.includes("Shell printf 'SHELL_E2E"))
    const laterRow = view.split('\n').findIndex(line => line.includes('LATER_MESSAGE'))
    assert.ok(anchorRow >= 0 && shellRow >= 0 && laterRow >= 0, `rendered rows missing:\n${view}`)
    assert.ok(anchorRow < shellRow && shellRow < laterRow,
      `the shell must stay at its gesture-time anchor, before later content:\n${view}`)
    assert.equal(harness.writes.length, 0, '!! never writes the Session')
  } finally {
    app.dispose()
  }
})
