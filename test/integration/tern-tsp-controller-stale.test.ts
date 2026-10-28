/**
 * PR3-B §7.3 (B2 round 10 F1): the ORDINARY queued submit's async stale
 * exit — the controller-consumer regression the review's probe-982 shape
 * demanded.
 *
 * The shape under test: a plain submit is accepted while session A is live;
 * its history persist parks on a gate (the ONE async window between the
 * synchronous admission capture and the session write); the ownership core
 * REPLACES the owner (a committed A→B transition — a different owner ref,
 * published through the real `setCurrentOwner`); the gate releases; the
 * controller's own stale exit must NOT merge A's text into the current
 * composer on a switch-dropping renderer (TSP), while a same-owner
 * invalidation and a retaining renderer (PiTui) still merge.
 *
 * PR3-B §7.3 (B2 round 11 F1): the SAME parked window with the LIFETIME
 * ended (the real teardown pair — cleaned up + aborted) and the parked await
 * rejected as teardown does it. The async failure restore must write nothing
 * and announce nothing; the same rejection with a live lifetime stays the
 * positive control (the restoring failure path).
 *
 * Level: the REAL `createSubmissionController` over the REAL ownership
 * core/subject authority — the replacement fact is computed by the real
 * WeakMap-pinned authority, never a precomputed boolean. The service seams
 * (history/session/command plane) are recording stand-ins, the same level
 * the review's probe-982 accepted for this finding.
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-controller-stale.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { waitUntil } from '../support/tsp-runner-harness.ts'

interface Recorded {
  readonly editor: string[]
  readonly notices: string[]
  /** Editor writes recorded AFTER the lifetime ended (round 11 case). */
  readonly postLifetimeEditorWrites: string[]
}

/** One controller-consumer scenario over the real controller + real core. */
async function runQueuedSubmitAcrossOwnerChange(options: {
  /** How the ownership slot changes while the submit is parked. */
  readonly change?: 'replaced-owner' | 'same-owner-bump'
  /** The renderer's stale-restore policy (TSP false / PiTui true). */
  readonly retainsStaleDraftRestore: boolean
  /** End the controller's lifetime (abort + cleaned up, the real teardown
   * pair) while the submit is parked. */
  readonly endLifetime?: boolean
  /** Reject the parked history await (the async failure restore's window):
   * the teardown cancellation shape, or an ordinary async failure. */
  readonly historyRejects?: 'abort' | 'failure'
}): Promise<Recorded> {
  const { createSubmissionController } = await import('../../src/app/submission/controller.ts')
  const { createSessionOwnershipCore } = await import('../../src/app/session/ownership-core.ts')
  const { DraftImageStore } = await import('../../src/client/media/image/draft-store.ts')
  const { DraftFileStore } = await import('../../src/client/media/attachment/file-draft.ts')

  // The REAL ownership core (the subject authority lives here).
  const core = createSessionOwnershipCore({
    isSurfaceDisposed: () => false,
    resetForGeneration: () => {},
  })
  const ownerA = {} as never
  const ownerB = {} as never
  core.setCurrentOwner(ownerA, 'session-a')

  // The observable editor sink.
  let editorText = ''
  const recorded: { editor: string[]; notices: string[] } = { editor: [], notices: [] }
  const composer = {
    getDraft: () => editorText,
    setDraft: (text: string): void => { editorText = text; recorded.editor.push(`draft:${text}`) },
    setEditorText: (text: string): void => { editorText = text; recorded.editor.push(`editor:${text}`) },
    insertIntoEditor: (text: string): void => { editorText += text; recorded.editor.push(`insert:${text}`) },
    notify: (message: string): void => { recorded.notices.push(message) },
    setSubmitPending: (): void => {},
    clearSettledLocalMessages: (): void => {},
  }

  // The live agent A the submit admits against.
  const agentA = { session: { id: 'session-a' }, status: 'idle', inbox: { nextTurn: [], nextStep: [] } }

  // The gated history persist: the ONE async window between the admission
  // capture and the session write.
  let releaseHistory!: () => void
  const historyGate = new Promise<void>(resolve => { releaseHistory = resolve })
  /** Resolved when the submission REALLY reached the parked history write.
   *
   *  The editor is cleared synchronously by `submit()`, but the production path
   *  awaits `submitTurn.wait` BEFORE `persistAfterSession`
   *  (src/app/submission/controller.ts:954). Clearing alone therefore does not
   *  prove the write is parked, and switching the owner before that await lands
   *  would exercise a different (earlier) interleaving than the case names. */
  let historyEntered!: () => void
  const enteredHistory = new Promise<void>(resolve => { historyEntered = resolve })

  // The controller's LIFETIME (round 11): the real signal + cleaned-up pair
  // teardown sets, driven here independently of the ownership slot.
  const lifetime = new AbortController()
  let cleanedUp = false

  const diag = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }
  // A callable deep-inert stub: every nested member is itself (callable),
  // so any dep this scenario never exercises stays inert without a
  // 40-member hand-written mock. (Real values are supplied for every member
  // the queued-submit path actually reads.)
  const deepInert: unknown = new Proxy(function inert(): void {}, {
    get: (_target, key) => (key === 'then' ? undefined : deepInert),
    apply: () => undefined,
  })

  const deps: Record<string, unknown> = {
    app: () => composer,
    diag,
    signal: lifetime.signal,
    isCleanedUp: () => cleanedUp,
    logError: () => {},
    liveAgent: () => agentA,
    ownership: {
      generation: () => core.generation(),
      captureSubject: () => core.subject(),
      transitionPending: () => false,
    },
    scope: {
      captureLive: () => ({ sessionId: 'session-a', subject: {}, generation: core.generation() }),
      isCurrent: () => true,
      requireLive: () => ({ sessionId: 'session-a', subject: {}, generation: core.generation() }),
    },
    session: {
      ensureSession: async () => {},
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
    },
    submissionRuntime: {
      withWriter: async (_scope: unknown, task: () => Promise<unknown>) => task(),
      submitPrompt: async () => {},
      deferQueueRecall: () => {},
    },
    command: deepInert,
    commandPlane: { available: () => false, execute: async () => undefined },
    backendKind: 'direct',
    history: {
      persistAfterSession: async (
        resolveSession: () => Promise<string | undefined>,
        persist: (sessionId: string | undefined) => void,
      ) => {
        // The parked window: the owner change (or the lifetime end) lands
        // while this awaits. Announce that the submission is REALLY here.
        historyEntered()
        await historyGate
        if (options.historyRejects !== undefined) {
          // The REAL shapes the probe observed: the teardown cancellation (a
          // DOMException AbortError) and an ordinary async failure.
          throw options.historyRejects === 'abort'
            ? new DOMException('the submission was cancelled', 'AbortError')
            : new Error('the history write failed')
        }
        const sessionId = await resolveSession()
        if (sessionId !== undefined) persist(sessionId)
      },
    },
    drafts: { images: new DraftImageStore(), files: new DraftFileStore() },
    direct: { withPromptAdmission: async (_agent: unknown, _hasImages: boolean, task: () => Promise<unknown>) => task() },
    requestExit: () => {},
    viewer: { isViewing: () => false },
    artifacts: { start: () => {} },
    extensions: { findContribution: () => undefined, clearError: () => {}, recordError: () => {} },
    status: { sessionCwd: () => '/tmp' },
    surface: { refreshPendingInput: () => {} },
    backend: {
      hostFile: deepInert,
      pendingInputReader: { snapshot: () => undefined },
      sessionWriter: { prompt: async () => ({ kind: 'committed', value: undefined }) },
      hostCommand: deepInert,
    },
    supportsLocalShellCards: false,
    supportsTuiBuiltinUi: false,
    retainsStaleDraftRestore: options.retainsStaleDraftRestore,
    ownerWasReplaced: (subject: unknown) => core.subjectAuthority.ownerReplaced(subject as never),
    captureMatches: (subject: unknown) => core.isSubjectCurrent(subject as never),
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined, llm: () => undefined },
    tuiSettings: undefined,
  }
  // Any member this scenario never exercises stays deep-inert.
  const controllerDeps = new Proxy(deps, {
    get: (target, key) => (key in target ? target[key as string] : deepInert),
  })

  const controller = createSubmissionController(controllerDeps as never)

  // The submission: the editor text is captured and cleared synchronously,
  // then the history persist parks.
  controller.submit('queued from A', 'enter')
  assert.equal(editorText, '', 'fixture check: the submit cleared the editor synchronously')
  // Wait for the REAL parking point (see `enteredHistory`): the owner change
  // below must land while the history write is in flight, which is the race
  // this case exists to prove.
  await enteredHistory

  // The owner change (or the lifetime end) lands INSIDE the awaited window.
  let lifetimeEditorMark = -1
  if (options.endLifetime === true) {
    // The real teardown pair, in the production order (cleanup first, abort
    // in the same synchronous batch).
    cleanedUp = true
    lifetime.abort()
    lifetimeEditorMark = recorded.editor.length
  } else if (options.change === 'replaced-owner') {
    core.bumpGeneration()
    core.setCurrentOwner(ownerB, 'session-b')
  } else if (options.change === 'same-owner-bump') {
    // A same-owner invalidation: only the generation moves.
    core.bumpGeneration()
  }

  releaseHistory()
  // The ENDED-lifetime scenario is the ONE branch with NO positive sink: its
  // whole contract is that the continuation writes and announces NOTHING.
  //
  // The continuation after `persistAfterSession` is a pure synchronous chain —
  // `isCleanedUp()` / `captureMatches()` reads and the notice — with NO timer,
  // retry or detached task (src/app/submission/controller.ts). Draining the
  // microtask queue therefore reaches its end, and one macrotask turn proves no
  // later turn was scheduled behind it.
  //
  // Every LIVE branch of this scenario ends in a NOTICE (the replaced owner, the
  // same-owner invalidation and the retaining renderer all announce
  // themselves); this scenario never reaches a prompt write, so the notice is
  // its only sink. The ended-lifetime branch is the one with no sink at all.
  await drainContinuation()
  if (!options.endLifetime) {
    assert.ok(recorded.notices.length > 0,
      'a released LIVE submission must announce its outcome')
  }

  return {
    editor: recorded.editor,
    notices: recorded.notices,
    postLifetimeEditorWrites: lifetimeEditorMark < 0 ? [] : recorded.editor.slice(lifetimeEditorMark),
  }
}

/**
 * Drain one released continuation to its end.
 *
 * The released path's steps are microtask continuations with no timer behind
 * them (see the call site), so exhausting the microtask queue plus one
 * macrotask turn reaches the last observable step — a duration would only guess
 * how long the machine takes to run them.
 */
async function drainContinuation(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}

test('a REPLACED owner on a switch-dropping renderer (TSP) never reseeds the new composer', async () => {
  const recorded = await runQueuedSubmitAcrossOwnerChange({
    change: 'replaced-owner',
    retainsStaleDraftRestore: false,
  })
  assert.ok(recorded.notices.some(note => note.includes('the session changed while waiting for submission')),
    `the stale exit fired: ${JSON.stringify(recorded.notices)}`)
  assert.ok(recorded.notices.some(note => note.includes('the draft was cleared by the switch')),
    `the notice is the TRUTHFUL drop, never a retry promise: ${JSON.stringify(recorded.notices)}`)
  assert.deepEqual(recorded.editor.filter(entry => entry.includes('queued from A')), [],
    `the OLD session's text was never written into the current composer: ${JSON.stringify(recorded.editor)}`)
})

test('the SAME-OWNER invalidation still restores (a failed switch kept the owner)', async () => {
  const recorded = await runQueuedSubmitAcrossOwnerChange({
    change: 'same-owner-bump',
    retainsStaleDraftRestore: false,
  })
  assert.ok(recorded.notices.some(note => note.includes('the session changed while waiting for submission')),
    `the stale exit fired: ${JSON.stringify(recorded.notices)}`)
  assert.ok(recorded.notices.some(note => note.includes('try again')),
    `the notice promises the restored retry: ${JSON.stringify(recorded.notices)}`)
  assert.ok(recorded.editor.some(entry => entry === 'editor:queued from A' || entry === 'draft:queued from A'),
    `the same-owner stale restored the text: ${JSON.stringify(recorded.editor)}`)
})

test('a retaining renderer (PiTui) restores even on a genuinely replaced owner', async () => {
  const recorded = await runQueuedSubmitAcrossOwnerChange({
    change: 'replaced-owner',
    retainsStaleDraftRestore: true,
  })
  assert.ok(recorded.editor.some(entry => entry === 'editor:queued from A' || entry === 'draft:queued from A'),
    `PiTui keeps its cross-session restore: ${JSON.stringify(recorded.editor)}`)
  assert.ok(recorded.notices.some(note => note.includes('try again')),
    `the PiTui notice promises the restored retry: ${JSON.stringify(recorded.notices)}`)
})

test('the async failure restore with a LIVE lifetime stays the positive control', async () => {
  const recorded = await runQueuedSubmitAcrossOwnerChange({
    retainsStaleDraftRestore: true,
    historyRejects: 'failure',
  })
  assert.ok(recorded.editor.some(entry => entry.includes('queued from A')),
    `a live failure still restores the draft: ${JSON.stringify(recorded.editor)}`)
  assert.ok(recorded.notices.some(note => note.includes('submission failed')),
    `a live failure still reports itself: ${JSON.stringify(recorded.notices)}`)
})

test('an ENDED lifetime (abort + cleanup) writes and announces NOTHING', async () => {
  for (const rejection of ['abort', 'failure'] as const) {
    const recorded = await runQueuedSubmitAcrossOwnerChange({
      // The retaining renderer is the worst case: the owner policy never
      // suppresses PiTui, so only the lifetime fence can keep the dead editor
      // clean (the review's regression shape).
      retainsStaleDraftRestore: true,
      endLifetime: true,
      historyRejects: rejection,
    })
    assert.equal(recorded.postLifetimeEditorWrites.length, 0,
      `${rejection}: no editor write survives the lifetime: ${JSON.stringify(recorded.postLifetimeEditorWrites)}`)
    assert.equal(recorded.notices.length, 0,
      `${rejection}: a cancelled gesture announces nothing: ${JSON.stringify(recorded.notices)}`)
  }
})

/**
 * F5 (PR4-B2-A review): the card-less Client-command ERROR notice is emitted
 * inside the Client registry branch, but the Client execution can outlive the
 * Session it was admitted against (an async `/resume` publishes the replacement
 * while the handler still runs). The notice is fenced by the SAME captured
 * scope the settlement uses: a replaced owner never receives the old result.
 */
async function runClientCommandErrorAcrossOwnerChange(options: {
  readonly staleAtSettlement: boolean
}): Promise<{ readonly notices: readonly string[] }> {
  const { createSubmissionController } = await import('../../src/app/submission/controller.ts')
  const { createSessionOwnershipCore } = await import('../../src/app/session/ownership-core.ts')
  const { DraftImageStore } = await import('../../src/client/media/image/draft-store.ts')
  const { DraftFileStore } = await import('../../src/client/media/attachment/file-draft.ts')
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner({} as never, 'session-a')
  const notices: string[] = []
  let editorText = ''
  const composer = {
    getDraft: () => editorText,
    setDraft: (text: string): void => { editorText = text },
    setEditorText: (text: string): void => { editorText = text },
    insertIntoEditor: (text: string): void => { editorText += text },
    notify: (message: string): void => { notices.push(message) },
    setSubmitPending: (): void => {},
    clearSettledLocalMessages: (): void => {},
  }
  // The transport-neutral Remote projection: NO `inbox`, so the controller's
  // Direct-Agent discriminator selects the Client command registry route.
  const agentA = { session: { id: 'session-a' }, status: 'idle' } as never
  let scopeCurrent = true
  let releaseExecute!: () => void
  const executeGate = new Promise<void>(resolve => { releaseExecute = resolve })
  let enteredExecute!: () => void
  const entered = new Promise<void>(resolve => { enteredExecute = resolve })
  /** The command-settlement lifecycle the controller drives on EVERY route:
   *  the observable proof that the released execute's continuation ran (the
   *  notice decision happens inside it). */
  const settlementSinks: string[] = []
  const diag = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }
  const deepInert: unknown = new Proxy(function inert(): void {}, {
    get: (_target, key) => (key === 'then' ? undefined : deepInert),
    apply: () => undefined,
  })
  const deps: Record<string, unknown> = {
    app: () => composer,
    diag,
    signal: new AbortController().signal,
    isCleanedUp: () => false,
    logError: () => {},
    liveAgent: () => agentA,
    ownership: {
      generation: () => core.generation(),
      captureSubject: () => core.subject(),
      transitionPending: () => false,
    },
    scope: {
      captureLive: () => ({ sessionId: 'session-a', subject: {}, generation: core.generation() }),
      isCurrent: () => scopeCurrent,
      requireLive: () => ({ sessionId: 'session-a', subject: {}, generation: core.generation() }),
    },
    session: {
      ensureSession: async () => {},
      beginCommandSettlement: () => { settlementSinks.push('begin') },
      abortCommandSettlement: () => { settlementSinks.push('abort') },
      settleCommandSettlement: () => { settlementSinks.push('settle') },
      trackSettlementWork: () => {},
    },
    submissionRuntime: {
      withWriter: async (_scope: unknown, task: () => Promise<unknown>) => task(),
      submitPrompt: async () => {},
      deferQueueRecall: () => {},
    },
    command: {
      wasAdvertisedClaim: () => false,
      hostClaimOf: () => undefined,
      hostOriginClaimOf: () => undefined,
      hostCatalogResolves: () => false,
      clientClaimsLine: () => true,
      isSkillWrapperName: () => false,
      isSkillInvocation: () => false,
      withCommandDelivery: <T>(_delivery: unknown, run: () => T): T => run(),
      takeCommandDraftDisposition: () => undefined,
      clientCommands: {
        get: () => undefined,
        execute: async () => {
          enteredExecute()
          await executeGate
          return { commandId: 'cmd-client-f5', result: { kind: 'error', text: 'stale copy failure' } }
        },
      },
    },
    commandPlane: { available: () => false, execute: async () => undefined },
    backendKind: 'remote',
    history: {
      persist: () => {},
      persistAfterSession: async (
        resolveSession: () => Promise<string | undefined>,
        persist: (sessionId: string | undefined) => void,
      ) => {
        const sessionId = await resolveSession()
        persist(sessionId)
      },
    },
    drafts: { images: new DraftImageStore(), files: new DraftFileStore() },
    direct: { withPromptAdmission: async (_agent: unknown, _hasImages: boolean, task: () => Promise<unknown>) => task() },
    requestExit: () => {},
    viewer: { isViewing: () => false },
    artifacts: { start: () => {} },
    extensions: {
      findContribution: () => undefined,
      handlerFor: () => undefined,
      commandIdFor: () => undefined,
      recordHealthRef: () => ({}),
      recordError: () => {},
      clearError: () => {},
    },
    status: { sessionCwd: () => '/tmp' },
    surface: { refreshPendingInput: () => {} },
    backend: {
      hostFile: deepInert,
      pendingInputReader: { snapshot: () => undefined },
      sessionWriter: { prompt: async () => ({ kind: 'committed', value: undefined }) },
      hostCommand: deepInert,
    },
    supportsLocalShellCards: false,
    supportsTuiBuiltinUi: false,
    retainsStaleDraftRestore: false,
    ownerWasReplaced: (subject: unknown) => core.subjectAuthority.ownerReplaced(subject as never),
    captureMatches: (subject: unknown) => core.isSubjectCurrent(subject as never),
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined, llm: () => undefined },
    tuiSettings: undefined,
    isPlanActive: () => false,
  }
  const controllerDeps = new Proxy(deps, {
    get: (target, key) => (key in target ? target[key as string] : deepInert),
  })
  const controller = createSubmissionController(controllerDeps as never)
  controller.submit('/copy', 'enter')
  await entered
  // The owner is replaced while the Client command is still executing.
  if (options.staleAtSettlement) {
    core.bumpGeneration()
    core.setCurrentOwner({} as never, 'session-b')
    scopeCurrent = false
  }
  releaseExecute()
  // Wait for the continuation's OWN settlement sink (not a 120ms window): a
  // released execution always ends in exactly one abort/settle, and the notice
  // decision runs inside that path — so an absence asserted afterwards is an
  // absence after the code really reached it.
  await waitUntil('the released Client command to settle',
    () => settlementSinks.includes('abort') || settlementSinks.includes('settle'))
  return { notices }
}

test('a stale Client-command error is NOT announced on the replacement owner', async () => {
  const result = await runClientCommandErrorAcrossOwnerChange({ staleAtSettlement: true })
  assert.deepEqual(result.notices, [],
    'the captured scope was replaced, so the old failure must not reach the new surface')
})

test('the SAME-session Client-command error is announced exactly once', async () => {
  const result = await runClientCommandErrorAcrossOwnerChange({ staleAtSettlement: false })
  assert.deepEqual(result.notices, ['stale copy failure'],
    'a current owner receives the card-less failure exactly once')
})
