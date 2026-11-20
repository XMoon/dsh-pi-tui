/**
 * M6 PR-C C3: the Split-Client presence prerequisite at prompt admission.
 *
 * A Client must hold a Host-ACKed view of the exact committed Session BEFORE
 * it starts its own new Turn. This suite pins the admission gate's refusal
 * semantics on BOTH admission paths (the ordinary/queued `submitPrompt` and
 * the busy/steer `steer` sweep): a refused or unconfirmed presence refuses
 * the submission truthfully, keeps the editable draft, settles the ack/echo
 * rows and NEVER dispatches or replays the prompt.
 *
 * @module @xmoon76/dsh-pi-tui/app/submission-presence-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeDraft } from '../../src/app/submission/steer.ts'
import { createSessionScopeAuthority } from '../../src/app/session/scope.ts'
import {
  bindSubmissionRuntime,
  steer,
  type PromptAttemptHooks,
  type PromptViewAck,
  type SteerSubmissionDeps,
  type SubmissionRuntimeSurface,
} from '../../src/app/submission/runtime.ts'
import { preparePrompt } from '../../src/app/submission/prepared-prompt.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import type { WriteOutcome } from '../../src/runtime/session-writer-port.ts'

const DIAG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

/** The recorded per-gesture settlement of one submission attempt. */
function attemptSink(): { hooks: PromptAttemptHooks; events: string[] } {
  const events: string[] = []
  return {
    events,
    hooks: {
      onAccepted: () => { events.push('accepted') },
      onRejected: () => { events.push('rejected') },
      onUnknown: () => { events.push('unknown') },
    },
  }
}

interface GateHarness {
  readonly notices: string[]
  readonly settledAcks: string[]
  readonly dispatched: string[]
  readonly draft: () => string
  submit(text: string): Promise<void>
  steerText(text: string): Promise<string[]>
}

/** One submission runtime over a surface whose presence gate answers `ack`. */
function gateHarness(options: { readonly ack?: () => Promise<PromptViewAck> } = {}): GateHarness {
  let draft = ''
  const notices: string[] = []
  const settledAcks: string[] = []
  const dispatched: string[] = []
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const scopeAuthority = createSessionScopeAuthority({
    current: () => ({ subject: {} as never, sessionId: 'session-gate', generation: 1 }),
    isSubjectCurrent: () => true,
  })
  const scope = scopeAuthority.captureLive()
  assert.notEqual(scope, undefined)
  const surface: SubmissionRuntimeSurface = {
    withWriter: async (_scope, task) => task(),
    withPromptAdmission: async (_scope, _line, task) => task(),
    ...(options.ack === undefined ? {} : { ackPromptView: () => options.ack!() }),
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
    settleSubmitAck: (reason) => { settledAcks.push(reason) },
    notify: (message) => { notices.push(message) },
    refuseByTransitionFence: (text) => { draft = mergeDraft(draft, text) },
    prepareMessage: async (text, requestId) => preparePrompt('session-gate', text, { images, files }, requestId),
    prompt: async (sessionId): Promise<WriteOutcome> => {
      dispatched.push(sessionId)
      return { kind: 'committed', value: undefined }
    },
  }
  const runtime = bindSubmissionRuntime({ surface })
  return {
    notices,
    settledAcks,
    dispatched,
    draft: () => draft,
    submit: (text) => runtime.submitPrompt({
      text,
      scope: scope as never,
      requestId: `req-${String(dispatched.length + settledAcks.length)}`,
      ackToken: 1,
      generation: 1,
      echoInstalled: true,
    }, {
      attempt: attemptSink().hooks,
    }),
    steerText: async (text) => {
      const attempt = attemptSink()
      const deps = steerDepsOf(surface, text, attempt.events)
      steer(deps, { text, attempt: attempt.hooks })
      // The steer flow is owned; let its async admission settle.
      await new Promise(resolveWait => setImmediate(resolveWait))
      await new Promise(resolveWait => setImmediate(resolveWait))
      return attempt.events
    },
  }
}

/** The minimal steer deps whose gate is under test; later members throw. */
function steerDepsOf(
  surface: SubmissionRuntimeSurface,
  text: string,
  _events: string[],
): SteerSubmissionDeps {
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const agent = { status: 'idle', session: { id: 'session-gate' }, options: {}, cancel: () => {} }
  const unreachable = (member: string): never => {
    throw new Error(`steer gate fixture: ${member} must not run after a presence refusal`)
  }
  return {
    isDisposed: () => false,
    composerHeld: () => false,
    isViewing: () => false,
    currentAgent: () => agent as never,
    currentGeneration: () => 1,
    captureOwnerToken: () => ({} as never),
    isOwnerTokenCurrent: () => true,
    readPendingInput: () => undefined,
    draftHasAttachments: () => false,
    draftHasImages: () => false,
    mergeDraftIntoEditor: (value) => {
      const merged = mergeDraft('', value)
      return merged === value
    },
    restoreStaleDraftIntoEditor: (value) => {
      mergeDraft('', value)
      return 'merged-verbatim'
    },
    notify: (message) => { surface.notify(message, 'error') },
    acceptSubmitAck: () => 2,
    settleLocalSubmission: () => surface.settleLocalSubmission('steer-req'),
    settleSubmitAck: (reason, ackOptions) => surface.settleSubmitAck(reason, ackOptions),
    beginLocalSteerEcho: () => {},
    takeSubmitTurn: () => ({ wait: Promise.resolve(), release: () => {} }),
    pinDraftAttachments: () => () => {},
    persistAfterSession: async (resolveSession, persist) => { persist(await resolveSession()) },
    ensureSession: () => Promise.resolve(),
    withPromptAdmission: async (_agent, _hasImages, task) => task(),
    ...(surface.ackPromptView === undefined ? {} : { ackPromptView: () => surface.ackPromptView!() }),
    prepareMessage: async (value, requestId) => preparePrompt('session-gate', value, { images, files }, requestId),
    markDispatch: () => unreachable('markDispatch'),
    restoreSubmissionDraft: (value) => { mergeDraft('', value) },
    notifySubmissionFailure: () => unreachable('notifySubmissionFailure'),
    consumeDraftAttachments: () => {},
    writerSection: (task) => task(),
    pendingInputReader: { snapshot: () => undefined } as never,
    writer: {
      prompt: () => unreachable('writer.prompt'),
      updateQueue: () => unreachable('writer.updateQueue'),
    } as never,
    diag: DIAG,
  }
}

test('a refused presence refuses the ordinary submission and never dispatches', async () => {
  const harness = gateHarness({ ack: () => Promise.resolve({ kind: 'refused' }) })
  await harness.submit('please run')
  assert.deepEqual(harness.dispatched, [], 'a refused presence must never dispatch the prompt')
  assert.equal(harness.draft(), 'please run', 'the editable draft is retained')
  assert.ok(harness.settledAcks.some(reason => reason.includes('session view refused')),
    'the submit-ack row settles with the truthful refusal reason')
  assert.ok(harness.notices.some(message => message.includes('refused this Client\'s session view')),
    'the user sees the truthful refusal notice')
})

test('an unconfirmed presence refuses the ordinary submission as an unknown outcome', async () => {
  const harness = gateHarness({ ack: () => Promise.resolve({ kind: 'unconfirmed' }) })
  await harness.submit('please run')
  assert.deepEqual(harness.dispatched, [], 'an unconfirmed presence must never dispatch the prompt')
  assert.equal(harness.draft(), 'please run', 'the editable draft is retained')
  assert.ok(harness.notices.some(message => message.includes('could not be confirmed')),
    'the user sees the truthful unconfirmed notice')
})

test('a confirmed presence admits the ordinary submission exactly once', async () => {
  const harness = gateHarness({ ack: () => Promise.resolve({ kind: 'confirmed' }) })
  await harness.submit('please run')
  assert.deepEqual(harness.dispatched, ['session-gate'], 'a confirmed presence admits the prompt')
})

test('a refused presence refuses the steer/queue admission and never dispatches', async () => {
  const harness = gateHarness({ ack: () => Promise.resolve({ kind: 'refused' }) })
  const events = await harness.steerText('steer me')
  assert.deepEqual(events, ['rejected'], 'the steer attempt settles as the proven pre-dispatch refusal')
  assert.ok(harness.notices.some(message => message.includes('refused this Client\'s session view')),
    'the user sees the truthful refusal notice on the steer path')
  assert.ok(harness.settledAcks.some(reason => reason.includes('steer session view refused')),
    'the steer submit-ack row settles with the truthful refusal reason')
})
