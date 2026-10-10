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

interface Recorded {
  readonly editor: string[]
  readonly notices: string[]
}

/** One controller-consumer scenario over the real controller + real core. */
async function runQueuedSubmitAcrossOwnerChange(options: {
  /** How the ownership slot changes while the submit is parked. */
  readonly change: 'replaced-owner' | 'same-owner-bump'
  /** The renderer's stale-restore policy (TSP false / PiTui true). */
  readonly retainsStaleDraftRestore: boolean
}): Promise<Recorded> {
  const { createSubmissionController } = await import('../src/app/submission/controller.ts')
  const { createSessionOwnershipCore } = await import('../src/app/session/ownership-core.ts')
  const { DraftImageStore } = await import('../src/client/media/image/draft-store.ts')
  const { DraftFileStore } = await import('../src/client/media/attachment/file-draft.ts')

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
        // The parked window: the owner change lands while this awaits.
        await historyGate
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
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(editorText, '', 'fixture check: the submit cleared the editor before the parking window')

  // The owner change lands INSIDE the awaited window (the real core).
  if (options.change === 'replaced-owner') {
    core.bumpGeneration()
    core.setCurrentOwner(ownerB, 'session-b')
  } else {
    // A same-owner invalidation: only the generation moves.
    core.bumpGeneration()
  }

  releaseHistory()
  await new Promise(resolve => setTimeout(resolve, 200))

  return recorded
}

test('round10 F1: a REPLACED owner on a switch-dropping renderer (TSP) never reseeds the new composer', async () => {
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

test('round10 F1: the SAME-OWNER invalidation still restores (a failed switch kept the owner)', async () => {
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

test('round10 F1: a retaining renderer (PiTui) restores even on a genuinely replaced owner', async () => {
  const recorded = await runQueuedSubmitAcrossOwnerChange({
    change: 'replaced-owner',
    retainsStaleDraftRestore: true,
  })
  assert.ok(recorded.editor.some(entry => entry === 'editor:queued from A' || entry === 'draft:queued from A'),
    `PiTui keeps its cross-session restore: ${JSON.stringify(recorded.editor)}`)
  assert.ok(recorded.notices.some(note => note.includes('try again')),
    `the PiTui notice promises the restored retry: ${JSON.stringify(recorded.notices)}`)
})
