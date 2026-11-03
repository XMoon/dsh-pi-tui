/**
 * The submission controller's fail-closed gate for a terminal pasted image
 * path whose attachment read is still in flight.
 *
 * The editor/Composer pre-clear admissions are the normal refusal; this is the
 * LAST defence for a caller that bypassed them. The gate must refuse BEFORE
 * any history row, session creation, queue/inbox write or Host prompt, restore
 * the user's draft and post the ONE retry notice — while any prompt that does
 * not carry the pending path keeps flowing (the positive control at the end).
 * @module @xmoon76/dsh-pi-tui/submission-controller-pasted-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { createSubmissionController } from '../../src/app/submission/controller.ts'
import { PASTE_PENDING_NOTICE } from '../../src/app/surface/pasted-image-intake.ts'
import type { SubmissionComposerPort } from '../../src/app/submission/composer-port.ts'

const PENDING_PATH = '/tmp/shot.png'

/** A real composer port over one editable draft buffer. */
class Composer implements SubmissionComposerPort {
  text = ''
  readonly notices: { readonly message: string; readonly kind: string }[] = []
  getDraft(): string { return this.text }
  setDraft(text: string): void { this.text = text }
  setEditorText(text: string): void { this.text = text }
  insertIntoEditor(text: string): void { this.text += text }
  notify(message: string, kind: 'info' | 'error' = 'info'): void { this.notices.push({ message, kind }) }
  setSubmitPending(): void {}
  clearSettledLocalMessages(): void {}
}

interface Counters {
  history: number
  ensureSession: number
  submitPrompt: number
  writer: number
  ack: number
}

function mount(): { controller: ReturnType<typeof createSubmissionController>; composer: Composer; counters: Counters; pending: { path: string | undefined } } {
  const composer = new Composer()
  const counters: Counters = { history: 0, ensureSession: 0, submitPrompt: 0, writer: 0, ack: 0 }
  const pending: { path: string | undefined } = { path: PENDING_PATH }
  const lifetime = new AbortController()
  // A callable deep-inert stub for the deps a refused gesture must never
  // reach; the exercised members are supplied explicitly below.
  const deepInert: unknown = new Proxy(function inert(): void {}, {
    get: (_target, key) => (key === 'then' ? undefined : deepInert),
    apply: () => undefined,
  })
  const deps: Record<string, unknown> = {
    app: () => composer,
    diag: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} },
    signal: lifetime.signal,
    isCleanedUp: () => false,
    logError: () => {},
    liveAgent: () => undefined,
    ownership: {
      generation: () => 1,
      captureSubject: () => undefined,
      transitionPending: () => false,
    },
    scope: {
      captureLive: () => undefined,
      isCurrent: () => false,
      requireLive: () => { throw new Error('the gate must refuse before any scope capture') },
    },
    session: {
      ensureSession: async () => { counters.ensureSession += 1 },
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
    },
    submissionRuntime: {
      withWriter: async (_scope: unknown, task: () => Promise<unknown>) => task(),
      submitPrompt: async () => { counters.submitPrompt += 1 },
      deferQueueRecall: () => {},
      hasUnsettledClientWrite: () => false,
    },
    command: deepInert,
    commandPlane: { available: () => false, execute: async () => undefined },
    backendKind: 'direct',
    backend: {
      hostFile: deepInert,
      pendingInputReader: { snapshot: () => undefined },
      sessionWriter: {
        prompt: async () => { counters.writer += 1; return { kind: 'committed', value: undefined } },
      },
      hostCommand: deepInert,
    },
    history: {
      persist: () => { counters.history += 1 },
      persistAfterSession: async (
        resolveSession: () => Promise<string | undefined>,
        persist: (sessionId: string | undefined) => void,
      ) => {
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
    supportsLocalShellCards: true,
    supportsTuiBuiltinUi: true,
    retainsStaleDraftRestore: true,
    ownerWasReplaced: () => false,
    captureMatches: () => false,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined, llm: () => undefined },
    tuiSettings: undefined,
    // The ONE read-only admission under test.
    pendingPastedPath: (text: string) => pending.path !== undefined && text.includes(pending.path),
  }
  const controller = createSubmissionController(new Proxy(deps, {
    get: (target, key) => (key in target ? target[key as string] : deepInert),
  }) as never)
  return { controller, composer, counters, pending }
}

test('a submit carrying a still-attaching pasted image path writes nothing and restores the draft', async () => {
  const { controller, composer, counters } = mount()
  controller.submit(`${PENDING_PATH} `, 'enter')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(counters, { history: 0, ensureSession: 0, submitPrompt: 0, writer: 0, ack: 0 },
    'zero Host writer/queue/history/ack work before the refusal')
  assert.deepEqual(composer.notices, [{ message: PASTE_PENDING_NOTICE, kind: 'info' }],
    'the ONE actionable retry notice is shown')
  assert.ok(composer.getDraft().includes(PENDING_PATH), 'the user draft is handed back for a retry')
})

test('a steer carrying the still-attaching path is refused before any consume/persist', async () => {
  const { controller, composer, counters } = mount()
  composer.text = 'resting draft'
  controller.steer(`${PENDING_PATH} `)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(counters, { history: 0, ensureSession: 0, submitPrompt: 0, writer: 0, ack: 0 })
  assert.equal(composer.notices.length, 1)
  assert.ok(composer.getDraft().includes(PENDING_PATH), 'the steered text is merged back, never dropped')
  assert.ok(composer.getDraft().includes('resting draft'), 'the live draft before the steer survives')
})

test('control: a prompt that does not carry the pending path passes the gate', async () => {
  const { controller, composer } = mount()
  controller.submit('plain prompt', 'enter')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(composer.notices, [], 'the pending paste never refuses an unrelated prompt')
  assert.equal(composer.getDraft(), '', 'the admitted prompt is not merged back as a refusal')
})
