/**
 * PR2 composer submission attempt: the Client-local single-flight gate that
 * keeps the editor draft until the HOST accepts the prompt.
 *
 * `submitted != accepted != durable != execution_success`: the Host acceptance
 * (the writer's `onAccepted` latch — never the prompt Promise alone) is the
 * only normal authority that clears the committed draft; a proven
 * pre-acceptance refusal and an indeterminate outcome keep it editable.
 * @module @xmoon76/dsh-pi-tui/composer-submission-attempt.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { consumeDraftAttachments } from '../../src/client/media/draft-attachments.ts'
import { bindSubmissionRuntime, type SubmissionRuntimeSurface } from '../../src/app/submission/runtime.ts'
import { createSubmissionController } from '../../src/app/submission/controller.ts'
import type { SubmissionComposerPort } from '../../src/app/submission/composer-port.ts'
import type { WriteOutcome } from '../../src/runtime/write-outcome.ts'

interface ComposerCall {
  readonly kind: 'hold' | 'settle'
  readonly attemptId: string
  readonly result?: 'accepted' | 'not-accepted' | 'unknown'
}

/** A composer double that models the renderer-side document lifecycle. */
class Composer implements SubmissionComposerPort {
  text = ''
  readonly calls: ComposerCall[] = []
  held = false
  readonly notices: { readonly message: string; readonly kind: string }[] = []
  getDraft(): string { return this.text }
  setDraft(text: string): void { if (!this.held) this.text = text }
  setEditorText(text: string): void { if (!this.held) this.text = text }
  insertIntoEditor(text: string): void { if (!this.held) this.text += text }
  notify(message: string, kind: 'info' | 'error' = 'info'): void { this.notices.push({ message, kind }) }
  setSubmitPending(): void {}
  holdSubmission(attemptId: string): void {
    this.calls.push({ kind: 'hold', attemptId })
    this.held = true
  }
  settleSubmission(attemptId: string, result: 'accepted' | 'not-accepted' | 'unknown'): void {
    this.calls.push({ kind: 'settle', attemptId, result })
    this.held = false
    if (result === 'accepted') this.text = ''
  }
}

interface WriterCall {
  readonly mode: 'queue' | 'steer'
  readonly onAccepted: (() => void) | undefined
}

interface Mount {
  readonly controller: ReturnType<typeof createSubmissionController>
  readonly composer: Composer
  readonly writerCalls: WriterCall[]
  readonly historyRows: { text: string; sessionId: string | undefined }[]
  readonly consumes: string[]
  readonly images: DraftImageStore
  /** Configures the next writer outcome; `onAccepted` fires first when asked. */
  respond(outcome: WriteOutcome | 'throw', acceptedFirst: boolean): void
  /** Configures the final command plane: unmatched, an executed command that
   *  writes the corrected draft and records `restored`, or a late genuine
   *  claim that refuses the attachments. */
  setCommandBehavior(behavior: 'unmatched' | 'executed-error-restored' | 'late-claim-attachments-refused'): void
}

function mount(options: { readonly port?: SubmissionComposerPort } = {}): Mount {
  const composer = new Composer()
  const port = options.port ?? composer
  const writerCalls: WriterCall[] = []
  const historyRows: { text: string; sessionId: string | undefined }[] = []
  const files = new DraftFileStore()
  const consumes: string[] = []
  const images = new DraftImageStore()
  let next: { outcome: WriteOutcome | 'throw'; acceptedFirst: boolean } = {
    outcome: { kind: 'committed', value: undefined },
    acceptedFirst: true,
  }
  let commandBehavior: 'unmatched' | 'executed-error-restored' | 'late-claim-attachments-refused' = 'unmatched'
  let claimReads = 0
  const scope = { sessionId: 's1' }
  const surface: SubmissionRuntimeSurface = {
    withWriter: async (_scope, task) => task(),
    withPromptAdmission: async (_scope, _line, task) => task(),
    isDisposed: () => false,
    isScopeCurrent: () => true,
    composerHoldActive: () => controller.composerHoldActive(),
    mergeDraftIntoEditor: (text) => { port.setEditorText(port.getDraft() + text); return true },
    restoreStaleDraftIntoEditor: () => 'merged-verbatim',
    consumeDraftAttachments: (text) => {
      consumes.push(text)
      consumeDraftAttachments(text, images, files)
    },
    markDispatch: () => {},
    beginLocalSubmission: () => {},
    settleLocalSubmission: () => {},
    settleSubmitAck: () => {},
    notify: (message, kind) => port.notify(message, kind),
    refuseByTransitionFence: () => {},
    prepareMessage: async () => ({ prepared: true }),
    prompt: async (_sessionId, _message, options) => {
      writerCalls.push({ mode: 'queue', onAccepted: options?.onAccepted })
      if (next.acceptedFirst) options?.onAccepted?.()
      if (next.outcome === 'throw') throw new Error('writer exploded')
      return next.outcome
    },
  }
  const runtime = bindSubmissionRuntime({ surface })
  const agent = { status: 'idle', session: { id: 's1' }, options: {} }
  const inert: unknown = new Proxy(function inert(): void {}, {
    get: (_target, key) => (key === 'then' ? undefined : inert),
    apply: () => undefined,
  })
  const deps: Record<string, unknown> = {
    app: () => port,
    diag: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} },
    signal: new AbortController().signal,
    isCleanedUp: () => false,
    logError: () => {},
    liveAgent: () => agent,
    ownership: {
      generation: () => 1,
      captureSubject: () => ({ owner: 's1' }),
      transitionPending: () => false,
      awaitTransitionSettled: async () => {},
      beginNavigationIntent: () => () => {},
      soleNavigationIntentPending: () => false,
    },
    scope: { captureLive: () => scope, isCurrent: () => true, requireLive: () => scope },
    session: {
      ensureSession: async () => {},
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
    },
    submissionRuntime: {
      withWriter: (s: unknown, task: () => Promise<unknown>) => runtime.withWriter(s as never, task as never),
      submitPrompt: (submission: unknown, options?: unknown) => runtime.submitPrompt(submission as never, options as never),
      deferQueueRecall: () => {},
      settleQueueRecalls: () => {},
      hasUnsettledClientWrite: () => false,
    },
    command: {
      wasAdvertisedClaim: () => false,
      hostClaimOf: () => undefined,
      hostOriginClaimOf: (parsed: { name: string }) => {
        if (parsed.name === 'compact') return { claimed: true }
        // The late-claim behaviour: the standing view cannot classify the name
        // (the admission is an ordinary held prompt), the FINAL catalog does
        // (the invocation-time re-read refuses the attachments).
        if (parsed.name === 'late-command'
          && (commandBehavior === 'late-claim-attachments-refused' || commandBehavior === 'executed-error-restored')) {
          claimReads += 1
          // The standing view (admission + submit-time capture) cannot classify
          // the name; the LATE re-read at invocation does.
          return claimReads > 2
            ? { claimed: true, attachments: commandBehavior === 'executed-error-restored' }
            : undefined
        }
        return undefined
      },
      hostCatalogResolves: () => false,
      clientClaimsLine: () => false,
      isSkillWrapperName: () => false,
      isSkillInvocation: () => false,
      withCommandDelivery: (_delivery: unknown, run: () => unknown) => run(),
      takeCommandDraftDisposition: () =>
        commandBehavior === 'executed-error-restored' ? 'restored' : undefined,
      clientCommands: { get: () => undefined, execute: async () => undefined },
    },
    commandPlane: { available: () => false, execute: async () => undefined },
    backendKind: 'direct',
    backend: {
      hostFile: inert,
      pendingInputReader: { snapshot: () => ({ running: false, items: [] }) },
      sessionWriter: {
        prompt: async (_sessionId: string, _message: unknown, _mode: 'queue' | 'steer', options?: { onAccepted?: () => void }) => {
          writerCalls.push({ mode: 'queue', onAccepted: options?.onAccepted })
          if (next.acceptedFirst) options?.onAccepted?.()
          if (next.outcome === 'throw') throw new Error('writer exploded')
          return next.outcome
        },
        updateQueue: async () => ({ kind: 'committed', value: undefined }),
      },
      hostCommand: {
        execute: async () => {
          if (commandBehavior === 'executed-error-restored') {
            // The handler wrote its own authoritative retry draft before
            // settling an error (commands.ts' restored producer).
            port.setEditorText('corrected retry')
            return {
              kind: 'committed',
              matched: true,
              execution: { commandId: 'cmd-restored', result: { kind: 'error' } },
            }
          }
          return { kind: 'committed', matched: false }
        },
      },
    },
    history: {
      persist: (record: { text: string; sessionId: string | undefined }) => {
        historyRows.push({ text: record.text, sessionId: record.sessionId })
      },
      persistAfterSession: async (
        resolveSession: () => Promise<string | undefined>,
        persist: (sessionId: string | undefined) => void,
      ) => {
        persist(await resolveSession())
      },
    },
    drafts: { images, files },
    direct: { withPromptAdmission: async (_agent: unknown, _hasImages: boolean, task: () => Promise<unknown>) => task() },
    requestExit: () => {},
    viewer: { isViewing: () => false },
    artifacts: { start: () => {} },
    extensions: {
      findContribution: () => undefined,
      handlerFor: () => undefined,
      commandIdFor: () => undefined,
      recordHealthRef: () => undefined,
      clearError: () => {},
      recordError: () => {},
    },
    status: { sessionCwd: () => '/tmp' },
    surface: { refreshPendingInput: () => {} },
    supportsLocalShellCards: true,
    supportsTuiBuiltinUi: true,
    retainsStaleDraftRestore: true,
    ownerWasReplaced: () => false,
    captureMatches: () => true,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined, llm: () => undefined },
    tuiSettings: undefined,
    pendingPastedPath: () => false,
  }
  let controller!: ReturnType<typeof createSubmissionController>
  controller = createSubmissionController(new Proxy(deps, {
    get: (target, key) => (key in target ? target[key as string] : inert),
  }) as never)
  return {
    controller,
    composer,
    writerCalls,
    historyRows,
    consumes,
    images,
    respond: (outcome, acceptedFirst) => { next = { outcome, acceptedFirst } },
    setCommandBehavior: (behavior) => {
      commandBehavior = behavior
      claimReads = 0
    },
  }
}

const tick = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 10)) }

test('PR2: an ordinary prompt is HELD and the Host acceptance clears it exactly once', async () => {
  const h = mount()
  h.composer.text = 'hello world'
  assert.equal(h.controller.beginComposerSubmission('hello world', 'enter'), 'held')
  assert.equal(h.composer.calls[0]?.kind, 'hold', 'the renderer is frozen synchronously')
  assert.equal(h.composer.text, 'hello world', 'the draft never leaves the editor pre-acceptance')
  await tick()
  assert.equal(h.writerCalls.length, 1, 'the dispatch started inside the admission')
  assert.equal(typeof h.writerCalls[0]?.onAccepted, 'function', 'the writer carries the acceptance latch')
  assert.equal(h.composer.calls.filter(call => call.kind === 'settle').length, 1)
  assert.equal(h.composer.calls.find(call => call.kind === 'settle')?.result, 'accepted')
  assert.equal(h.composer.text, '', 'only the acceptance clears the committed draft')
  assert.equal(h.historyRows.length, 1, 'the history row completes at the acceptance boundary')
  assert.equal(h.historyRows[0]?.sessionId, 's1', 'the row carries the final session id')
  assert.deepEqual(h.consumes, ['hello world'], 'the accepted attachments are consumed once')
})

test('PR2: a second submit while sending is refused (single flight)', async () => {
  const h = mount()
  // The writer stays pending: never accept inside this gesture.
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  h.respond({ kind: 'committed', value: undefined }, false)
  const surfacePrompt = h.writerCalls.length
  assert.equal(surfacePrompt, 0)
  h.composer.text = 'first'
  assert.equal(h.controller.beginComposerSubmission('first', 'enter'), 'held')
  assert.equal(h.controller.beginComposerSubmission('first again', 'enter'), 'refused')
  await tick()
  assert.equal(h.writerCalls.length, 1, 'the refused gesture never reaches a writer')
  assert.equal(h.composer.calls.filter(call => call.kind === 'hold').length, 1)
  release()
  await pending
})

test('PR2: a proven pre-acceptance rejection keeps the draft and consumes nothing', async () => {
  const h = mount()
  h.respond({ kind: 'rejected', error: { code: 'session/writer-held', message: 'held by the Host' } }, false)
  h.composer.text = 'keep me'
  assert.equal(h.controller.beginComposerSubmission('keep me', 'enter'), 'held')
  await tick()
  const settle = h.composer.calls.find(call => call.kind === 'settle')
  assert.equal(settle?.result, 'not-accepted', 'the refusal unlocks the composer with the draft intact')
  assert.equal(h.composer.text, 'keep me', 'the refused draft is never cleared or duplicated')
  assert.deepEqual(h.consumes, [], 'a refused prompt consumes no attachment')
  assert.deepEqual(h.historyRows, [], 'a proven-unreceived prompt leaves no "sent" history row')
  assert.equal(h.controller.composerHoldActive(), false, 'the refusal releases the input lock')
})

test('PR2: an indeterminate outcome unlocks with the draft and reports uncertainty', async () => {
  const h = mount()
  h.respond({ kind: 'indeterminate', error: { code: 'session/write-indeterminate', message: 'carrier lost' } }, false)
  h.composer.text = 'maybe sent'
  assert.equal(h.controller.beginComposerSubmission('maybe sent', 'enter'), 'held')
  await tick()
  assert.equal(h.composer.calls.find(call => call.kind === 'settle')?.result, 'unknown')
  assert.equal(h.composer.text, 'maybe sent')
  assert.ok(h.composer.notices.some(notice => notice.message.includes('indeterminate')),
    'the outcome is reported as unknown, never as a success or a refusal')
  assert.equal(h.controller.composerHoldActive(), false)
})

test('PR2: an accepted prompt whose write later fails stays accepted and consumes once', async () => {
  const h = mount()
  h.respond({ kind: 'rejected', error: { code: 'session/agent-busy', message: 'busy' } }, true)
  h.composer.text = 'accepted then failed'
  assert.equal(h.controller.beginComposerSubmission('accepted then failed', 'enter'), 'held')
  await tick()
  const settles = h.composer.calls.filter(call => call.kind === 'settle')
  assert.deepEqual(settles.map(call => call.result), ['accepted'], 'the acceptance latch wins over the late error')
  assert.equal(h.composer.text, '', 'the accepted draft is not restored')
  assert.equal(h.historyRows.length, 1, 'the accepted row is persisted')
  assert.deepEqual(h.consumes, ['accepted then failed'],
    'an early acceptance still transfers the delivered attachments exactly once')
})

test('PR2: an early acceptance followed by an indeterminate result still consumes the attachments', async () => {
  const h = mount()
  h.respond({ kind: 'indeterminate', error: { code: 'session/write-indeterminate', message: 'carrier lost' } }, true)
  h.composer.text = 'accepted then unknown'
  assert.equal(h.controller.beginComposerSubmission('accepted then unknown', 'enter'), 'held')
  await tick()
  assert.equal(h.composer.calls.find(call => call.kind === 'settle')?.result, 'accepted')
  assert.deepEqual(h.consumes, ['accepted then unknown'], 'the acceptance is the ownership handoff')
  assert.deepEqual(h.historyRows.length, 1)
})

test('PR2: a committed write WITHOUT an acceptance callback is not an acceptance', async () => {
  const h = mount()
  h.respond({ kind: 'committed', value: undefined }, false)
  h.composer.text = 'no proof'
  assert.equal(h.controller.beginComposerSubmission('no proof', 'enter'), 'held')
  await tick()
  assert.equal(h.composer.calls.find(call => call.kind === 'settle')?.result, 'unknown',
    'the write result alone never clears the draft')
  assert.equal(h.composer.text, 'no proof', 'the draft stays editable')
  assert.deepEqual(h.consumes, [], 'no attachment transfer without Host acceptance')
  assert.deepEqual(h.historyRows, [], 'no "sent" history row without Host acceptance')
  assert.ok(h.composer.notices.some(notice => notice.message.includes('acceptance proof')))
})

test('PR2: a command line, a shell line and an empty draft keep the legacy contract', () => {
  const h = mount()
  h.composer.text = '/compact'
  assert.equal(h.controller.beginComposerSubmission('/compact', 'enter'), 'legacy',
    'a genuine Host command owns its own draft disposition')
  h.composer.text = '!ls'
  assert.equal(h.controller.beginComposerSubmission('!ls', 'enter'), 'legacy',
    'the user-shell family keeps its legacy lifecycle')
  h.composer.text = ''
  assert.equal(h.controller.beginComposerSubmission('', 'enter'), 'refused',
    'an empty wire form is a silent no-op')
  assert.deepEqual(h.composer.calls, [], 'no attempt was opened for a legacy/refused line')
})

test('PR2: the same text submitted twice creates two distinct attempts', async () => {
  const h = mount()
  h.composer.text = 'same text'
  assert.equal(h.controller.beginComposerSubmission('same text', 'enter'), 'held')
  await tick()
  assert.equal(h.controller.composerHoldActive(), false)
  h.composer.text = 'same text'
  assert.equal(h.controller.beginComposerSubmission('same text', 'enter'), 'held')
  await tick()
  const holds = h.composer.calls.filter(call => call.kind === 'hold')
  assert.equal(holds.length, 2)
  assert.notEqual(holds[0]?.attemptId, holds[1]?.attemptId, 'text is never the attempt identity')
  assert.equal(h.writerCalls.length, 2)
})

test('PR2: an argued host-command NON-invocation is an ordinary prompt; the claimed bare line is legacy', () => {
  const h = mount()
  // `/export foo` is the argued line of an execute-kind host command: the
  // submit-time non-invocation is sticky and stays an ordinary prompt.
  h.composer.text = '/export foo'
  assert.equal(h.controller.beginComposerSubmission('/export foo', 'enter'), 'held',
    'an argued non-invocation is an ordinary submission')
  assert.equal(h.composer.calls[0]?.kind, 'hold')
})

test('PR2: a busy steer gesture keeps its draft until the Host accepts it', async () => {
  const h = mount()
  // The explicit steer gesture routes to the draft-steer delivery
  // (`beginComposerSubmission(..., 'steer')`), whose draft prompt carries the
  // SAME acceptance hooks as the plain prompt.
  h.composer.text = 'steer this'
  assert.equal(h.controller.beginComposerSubmission('steer this', 'steer'), 'held')
  assert.equal(h.composer.calls[0]?.kind, 'hold')
  await tick()
  assert.equal(h.writerCalls.length, 1, 'the steer draft reached the writer once')
  assert.equal(typeof h.writerCalls[0]?.onAccepted, 'function')
  assert.equal(h.composer.text, '', 'the acceptance cleared the held steer draft')
  assert.equal(h.historyRows.length, 1, 'the steered history row completes at acceptance')
})

test('PR2: a held image draft keeps its lease on refusal and transfers it on acceptance', async () => {
  const h = mount()
  const staged = h.images.add({
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png',
    width: 4,
    height: 4,
  })
  h.composer.text = staged.placeholder
  // Pre-acceptance refusal: the attachment stays staged and the draft keeps
  // its exact placeholder (no consumption, no loss).
  h.respond({ kind: 'rejected', error: { code: 'session/writer-held', message: 'held' } }, false)
  assert.equal(h.controller.beginComposerSubmission(staged.placeholder, 'enter'), 'held')
  await tick()
  assert.equal(h.images.values().length, 1, 'a refused prompt never retires the staged image')
  assert.equal(h.composer.text, staged.placeholder, 'the placeholder stays in the editable draft')
  assert.deepEqual(h.consumes, [], 'no consume before the Host accepted')
  // A retry whose Host acceptance commits the same draft transfers the lease
  // exactly once.
  h.respond({ kind: 'committed', value: undefined }, true)
  assert.equal(h.controller.beginComposerSubmission(staged.placeholder, 'enter'), 'held')
  await tick()
  assert.equal(h.images.values().length, 0, 'the accepted prompt consumes exactly the referenced image')
  assert.deepEqual(h.consumes, [staged.placeholder])
  assert.equal(h.composer.text, '', 'the accepted draft is cleared')
})

test('PR2: a throwing renderer settlement never turns an accepted write into a refusal', async () => {
  const h = mount()
  // The renderer's clear/repaint throwing is a UI bug; the Host write already
  // committed and the acceptance fact must survive it.
  const originalSettle = h.composer.settleSubmission.bind(h.composer)
  h.composer.settleSubmission = (attemptId, result) => {
    originalSettle(attemptId, result)
    throw new Error('render IO exploded')
  }
  h.composer.text = 'accepted despite ui throw'
  assert.equal(h.controller.beginComposerSubmission('accepted despite ui throw', 'enter'), 'held')
  await tick()
  assert.equal(h.composer.calls.find(call => call.kind === 'settle')?.result, 'accepted',
    'the acceptance latched before the failing UI work')
  assert.equal(h.composer.text, '', 'the committed draft was cleared before the throw')
  assert.equal(h.historyRows.length, 1, 'the accepted history row still completed')
  assert.deepEqual(h.consumes, ['accepted despite ui throw'], 'the attachment transfer still ran')
})

test('PR2: a committed steer WITHOUT an acceptance callback is not an acceptance', async () => {
  const h = mount()
  h.respond({ kind: 'committed', value: undefined }, false)
  h.composer.text = 'steer without proof'
  assert.equal(h.controller.beginComposerSubmission('steer without proof', 'steer'), 'held')
  await tick()
  assert.equal(h.composer.calls.find(call => call.kind === 'settle')?.result, 'unknown')
  assert.equal(h.composer.text, 'steer without proof', 'the draft stays live')
  assert.deepEqual(h.consumes, [], 'the committed result alone never transfers the drafts')
})

test('PR2: an accepted steer whose write later rejects keeps the draft cleared and consumes once', async () => {
  const h = mount()
  const staged = h.images.add({
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png',
    width: 4,
    height: 4,
  })
  h.respond({ kind: 'rejected', error: { code: 'session/agent-busy', message: 'busy' } }, true)
  h.composer.text = staged.placeholder
  assert.equal(h.controller.beginComposerSubmission(staged.placeholder, 'steer'), 'held')
  await tick()
  assert.equal(h.composer.calls.find(call => call.kind === 'settle')?.result, 'accepted')
  assert.equal(h.composer.text, '', 'an accepted steer is never resurrected by the late refusal')
  assert.equal(h.images.values().length, 0, 'the accepted steer transfers its attachments exactly once')
})

test('PR2: an unknown slash line keeps its hold; no fabricate acceptance without the callback', async () => {
  const h = mount()
  // `/unknown ...` is plane-owned at the final catalog but matches NO command:
  // it must fall back to an ordinary prompt with the composer still held — the
  // handover belongs to an ACTUAL command execution, never to a pre-dispatch
  // prediction. A committed write WITHOUT the acceptance callback therefore
  // stays unknown (the draft is retained).
  h.respond({ kind: 'committed', value: undefined }, false)
  h.composer.text = '/unknown explain this'
  assert.equal(h.controller.beginComposerSubmission('/unknown explain this', 'enter'), 'held')
  assert.equal(h.composer.calls.find(call => call.kind === 'hold')?.attemptId !== undefined, true,
    'the ordinary slash line was admitted as an attempt')
  await tick()
  assert.equal(h.composer.calls.find(call => call.kind === 'settle')?.result, 'unknown',
    'no command executed, so only the acceptance callback could accept it')
  assert.equal(h.composer.text, '/unknown explain this', 'the draft is kept')
  assert.deepEqual(h.historyRows, [], 'no history row without acceptance')
})

test('PR2: a held line the final catalog runs as a command keeps the command-restored draft', async () => {
  const h = mount()
  h.setCommandBehavior('executed-error-restored')
  h.composer.text = '/late-command original'
  assert.equal(h.controller.beginComposerSubmission('/late-command original', 'enter'), 'held')
  await tick()
  assert.equal(h.composer.text, 'corrected retry',
    'the command handler’s authoritative restored draft is preserved (never cleared by the handover)')
  // The handover clears the composer through the port's accepted-clear BEFORE
  // the handler runs; that is NOT a prompt acceptance: no prompt history row
  // and no prompt attachment transfer may exist for a command-consumed line.
  assert.equal(h.composer.calls.find(call => call.kind === 'settle') !== undefined, true)
  // The LEGACY command contract still writes the line's history row at dispatch
  // (exactly one, the submitted line); the acceptance bookkeeping (ledger
  // publication, attachment transfer) is what a command-consumed line never gets.
  assert.deepEqual(h.historyRows.map(row => row.text), ['/late-command original'])
  assert.deepEqual(h.consumes, [], 'the command owns its attachment disposition')
  assert.equal(h.controller.composerHoldActive(), false)
  // The editor is editable again for the retry.
  h.composer.setEditorText('corrected retry + edit')
  assert.equal(h.composer.getDraft(), 'corrected retry + edit')
})

test('PR2: a held line whose FINAL command claim refuses the attachments unlocks again', async () => {
  const h = mount()
  h.setCommandBehavior('late-claim-attachments-refused')
  const staged = h.images.add({
    bytes: new Uint8Array([9, 9, 9]),
    mediaType: 'image/png',
    width: 2,
    height: 2,
  })
  h.composer.text = `/late-command ${staged.placeholder}`
  assert.equal(h.controller.beginComposerSubmission(h.composer.text, 'enter'), 'held')
  await tick()
  assert.equal(h.controller.composerHoldActive(), false,
    'the proven pre-dispatch command refusal must unlock the composer')
  assert.equal(h.composer.text, `/late-command ${staged.placeholder}`,
    'the draft and its attachment placeholder stay editable for the retry')
  assert.equal(h.images.values().length, 1, 'the refused attachment is not consumed')
  assert.ok(h.composer.notices.some(notice => notice.message.includes('does not accept attachments')))
  // The lock is really gone: the user edits the draft and a fresh ordinary
  // prompt is admitted again (the claimed command line itself is now LEGACY —
  // the catalog owns it, so it would be refused again until the attachment is
  // removed).
  h.composer.setEditorText('ordinary retry without the attachment')
  h.respond({ kind: 'committed', value: undefined }, true)
  assert.equal(h.controller.beginComposerSubmission('ordinary retry without the attachment', 'enter'), 'held')
  await tick()
  assert.equal(h.composer.text, '', 'the retry reaches the ordinary acceptance path')
})

test('PR2: a command-restored retry draft reaches the REAL PiTui composer (hold released before the handler)', async () => {
  const { TuiApp: TuiAppClass } = await import('../../src/tui-app.ts')
  const { VirtualTerminal } = await import('../support/virtual-terminal.ts')
  const { createAppLifecycleGuard } = await import('../support/app-lifecycle-guard.ts')
  const guard = createAppLifecycleGuard<InstanceType<typeof TuiAppClass>>()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiAppClass(vt, { onSubmit: () => {}, onExit: () => {}, onCancel: () => {} })
  app.start()
  guard.started.add(app)
  try {
    const h = mount({ port: app })
    h.setCommandBehavior('executed-error-restored')
    app.setDraft('/late-command original')
    assert.equal(h.controller.beginComposerSubmission('/late-command original', 'enter'), 'held',
      'the standing view admits the line as an ordinary held prompt')
    await tick()
    assert.equal(h.controller.composerHoldActive(), false,
      'the invocation-time claim hands the composer over BEFORE the handler runs')
    assert.equal(app.getDraft(), 'corrected retry',
      'the handler’s authoritative retry draft lands in the REAL composer (no hold fence)')
    // The general programmatic fence still applies to a held attempt elsewhere:
    // this assertion is covered by the pitui-composer-hold suite.
    assert.deepEqual(h.historyRows.map(row => row.text), ['/late-command original'],
      'the legacy command history row is written once')
  } finally {
    guard.disposeAll()
  }
})
