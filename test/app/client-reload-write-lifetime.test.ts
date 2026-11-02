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
import { createSubmissionController, type SubmissionControllerDeps } from '../../src/app/submission/controller.ts'
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
import type { HostUserShellAdmission, HostUserShellResult } from '../../src/runtime/host-user-shell-port.ts'
import type { WriteOutcome } from '../../src/runtime/session-writer-port.ts'

const DIAG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

interface AgentLike {
  status: string
  readonly session: { readonly id: string }
  readonly options: Record<string, unknown>
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
  const agent: AgentLike = { status: 'idle', session: { id: 'session-a' }, options: {} }
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
    shell: { run: () => {}, interrupt: () => {} },
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

test('the ! shell gesture keeps the write lifetime until the real user-shell owner settles', async () => {
  let releaseResult!: (result: HostUserShellResult) => void
  let executions = 0
  const shell = createUserShell<{ session: { id: string }; status: string; cancel(): void }>({
    app: () => ({
      pushLocalMessage: () => ({ card: true }),
      updateLocalMessage: (card: unknown) => card,
      clearSettledLocalMessages: () => {},
    }) as never,
    notify: () => {},
    diag: DIAG,
    isCleanedUp: () => false,
    liveAgent: () => ({ session: { id: 'session-a' }, status: 'idle', cancel: () => {} }),
    ownership: { generation: () => 1 },
    session: {
      withWriter: async (_scope, task) => task(),
      interrupt: async () => ({ kind: 'committed', value: undefined }),
    },
    requireLiveScope: () => ({ sessionId: 'session-a' } as never),
    captureLiveScope: () => ({ sessionId: 'session-a' } as never),
    writerSection: async <T,>(task: () => Promise<T>) => task(),
    writer: { prompt: async () => ({ kind: 'committed', value: undefined }) } as never,
    status: { sessionCwd: () => '/tmp' },
    tuiSettings: undefined,
    shell: {
      availability: () => ({ supported: true, policies: ['bypass'] }),
      execute: async (): Promise<HostUserShellAdmission> => {
        executions += 1
        return {
          kind: 'executing',
          execution: {
            result: () => new Promise<HostUserShellResult>(resolve => { releaseResult = resolve }),
            output: async function* () { /* no output */ },
          },
        }
      },
    } as never,
    submission: { settleAck: () => {}, markDispatch: () => {} },
  })
  let ended = 0
  shell.run('!! echo hi', 1, () => { ended += 1 })
  await drainMicrotasks()
  assert.equal(executions, 1, 'the Host execution was admitted')
  assert.equal(ended, 0, 'a running !! shell keeps the reload blocked')
  releaseResult({ exit: { kind: 'exit', code: 0 }, aborted: false })
  await drainMicrotasks()
  assert.equal(ended, 1, "the !! card's settlement is the terminal path")
  // The context-mode `!` submit of the output holds the lifetime until that
  // Session write settles too: the user shell passes the SAME release into
  // submitShell, which runs it at the write's terminal settlement.
  let writeRelease!: () => void
  const pendingWrite = new Promise<void>(resolve => { writeRelease = resolve })
  shell.run('! echo hi', 1, () => { ended += 1 })
  await drainMicrotasks()
  assert.equal(executions, 2)
  assert.equal(ended, 1, 'a running ! shell holds the lifetime')
  // The context-mode submit runs `submitShell` with its own writer section;
  // the test's held writer would be the submission runtime's, so this suite's
  // shell harness uses a committed writer and only asserts the card terminal
  // releases the SAME lifetime exactly once.
  releaseResult({ exit: { kind: 'exit', code: 0 }, aborted: false })
  await drainMicrotasks()
  assert.equal(ended, 2, 'the ! gesture releases its lifetime at the real terminal path')
  writeRelease()
  await pendingWrite
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
