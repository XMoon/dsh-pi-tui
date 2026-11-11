/**
 * M6 PR-C: command submission with FILE receipts.
 *
 * Evidence level: unit/composition over the REAL `createSubmissionController`,
 * the REAL draft stores and the REAL attachment snapshot/serializer, with the
 * `HostCommandPort` as the observed seam: this suite proves the application's
 * snapshot → preflight → ordered staging → single dispatch → settlement
 * contract. The genuine Host-origin claim input is supplied as a fixture
 * descriptor catalog (the same `{leadingInput, attachments}` declaration the
 * Host catalog exposes); the real catalog/registry routing is covered by the
 * mounted runner suite (`submit-hot-path.test.ts`).
 *
 * @module @xmoon76/dsh-pi-tui/host-command-attachment-submit.test
 */

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createSubmissionController, type SubmissionControllerDeps } from '../../src/app/submission/controller.ts'
import { bindSubmissionRuntime, type SubmissionRuntimeSurface } from '../../src/app/submission/runtime.ts'
import { preparePrompt } from '../../src/app/submission/prepared-prompt.ts'
import { mergeDraft } from '../../src/app/submission/steer.ts'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import { createSessionScopeAuthority } from '../../src/app/session/scope.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { probeAttachment } from '../../src/client/media/attachment/intake.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import type { HostCommandClaim } from '../../src/commands.ts'
import type { HostCommandFileStageRequest, HostCommandOutcome } from '../../src/runtime/host-command-port.ts'
import type { PreparedFile } from '../../src/runtime/prepared-prompt.ts'

const DIAG = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

interface AgentLike {
  status: string
  readonly session: { readonly id: string }
  readonly options: Record<string, unknown>
  cancel(): void
}

/** One genuine Host-origin descriptor fact (the catalog declaration). */
interface HostDescriptor {
  readonly leadingInput: boolean
  readonly attachments?: boolean
}

interface StageRecord {
  readonly sessionId: string
  readonly file: PreparedFile
  readonly bytes: number
}

interface Harness {
  readonly controller: ReturnType<typeof createSubmissionController<AgentLike>>
  readonly images: DraftImageStore
  readonly files: DraftFileStore
  readonly stages: StageRecord[]
  readonly executes: { readonly sessionId: string; readonly line: string; readonly attachments: readonly unknown[] }[]
  readonly notices: string[]
  readonly consumeCount: () => number
  readonly prompts: string[]
  /** The editor draft right now (the submit path clears it like the editor). */
  draftText(): string
  /** Submit one line with the editor's OWN pre-clear (TuiApp contract). */
  submit(text: string): void
  readonly ensureCalls: () => number
  readonly descriptors: Map<string, HostDescriptor>
  /** The live scope the controller captures (`undefined` = sessionless). */
  setSession(sessionId: string | undefined): void
  /** Replace the live scope generation (a stale capture). */
  invalidateScope(): void
  /** Hold `ensureSession()` open until `releaseEnsure()`. */
  holdEnsure(): void
  releaseEnsure(): void
  /** Hold the NEXT stage call open until `releaseStage()`. */
  holdStage(): void
  releaseStage(): void
  setStageError(error: Error | undefined): void
  setExecuteOutcome(outcome: HostCommandOutcome): void
  /** Resolve after the controller's owned workflow settles. */
  settled(): Promise<void>
}

function startHarness(options: { readonly sessionId?: string } = {}): Harness {
  let draft = ''
  const notices: string[] = []
  const stages: StageRecord[] = []
  const executes: Harness['executes'][number][] = []
  const prompts: string[] = []
  let consumed = 0
  let ensureCalls = 0
  let ensureGate: Promise<void> | undefined
  let releaseEnsureGate: (() => void) | undefined
  let stageGate: Promise<void> | undefined
  let releaseStageGate: (() => void) | undefined
  let stageError: Error | undefined
  let executeOutcome: HostCommandOutcome = {
    kind: 'committed',
    matched: true,
    execution: { result: { kind: 'success' } },
  }

  const composer = {
    getDraft: () => draft,
    setDraft: (text: string) => { draft = text },
    setEditorText: (text: string) => { draft = text },
    insertIntoEditor: (text: string) => { draft += text },
    notify: (message: string) => { notices.push(message) },
    setSubmitPending: () => {},
    clearSettledLocalMessages: () => {},
  }
  let agent: AgentLike | undefined = options.sessionId === undefined
    ? undefined
    : { status: 'idle', session: { id: options.sessionId }, options: {}, cancel: () => {} }
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  if (agent !== undefined) core.setCurrentOwner({} as never, agent.session.id)
  const scopeAuthority = createSessionScopeAuthority({
    current: () => agent === undefined
      ? { subject: undefined, sessionId: undefined, generation: core.generation() }
      : { sessionId: agent.session.id, generation: core.generation(), subject: core.subject() as never },
    isSubjectCurrent: subject => core.isSubjectCurrent(subject),
  })
  const images = new DraftImageStore()
  const files = new DraftFileStore()
  const descriptors = new Map<string, HostDescriptor>()
  const consumeAttachments = (text: string): void => {
    consumed += 1
    const current = {
      images: [...images.values()].filter(image => text.includes(image.placeholder)),
      files: [...files.values()].filter(file => text.includes(file.placeholder)),
    }
    for (const image of current.images) images.remove(image.id)
    for (const file of current.files) files.remove(file.id)
  }
  const runtimeSurface: SubmissionRuntimeSurface = {
    withWriter: async (_scope, task) => task(),
    withPromptAdmission: async (_scope, _line, task) => task(),
    isDisposed: () => false,
    isScopeCurrent: scope => scopeAuthority.isCurrent(scope),
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
    consumeDraftAttachments: consumeAttachments,
    markDispatch: () => {},
    beginLocalSubmission: () => {},
    settleLocalSubmission: () => {},
    settleSubmitAck: () => {},
    notify: (message) => { notices.push(message) },
    refuseByTransitionFence: (text) => { draft = mergeDraft(draft, text) },
    prepareMessage: async (text, requestId) => preparePrompt(agent?.session.id ?? 'unbound', text, { images, files }, requestId),
    prompt: async (sessionId: string) => {
      prompts.push(sessionId)
      return { kind: 'committed', value: undefined }
    },
  }
  const submissionRuntime = bindSubmissionRuntime({ surface: runtimeSurface })
  const claimOf = (parsed: { name: string; rawInput?: string }): HostCommandClaim | undefined => {
    const descriptor = descriptors.get(parsed.name)
    if (descriptor === undefined) return undefined
    if (!descriptor.leadingInput && (parsed.rawInput?.trim() ?? '') !== '') return { claimed: false }
    return { claimed: true, attachments: descriptor.attachments === true }
  }
  const hostCommand = {
    async stageFileReceipt(request: HostCommandFileStageRequest): Promise<{ readonly receiptId: string }> {
      if (stageGate !== undefined) await stageGate
      if (stageError !== undefined) throw stageError
      let bytes = 0
      for await (const chunk of request.file.source.kind === 'client-stream'
        ? request.file.source.open(request.signal)
        : []) {
        bytes += chunk.byteLength
      }
      stages.push({ sessionId: request.sessionId, file: request.file, bytes })
      return { receiptId: `receipt-${stages.length}` }
    },
    async execute(request: { readonly sessionId: string; readonly line: string; readonly attachments: readonly unknown[] }) {
      executes.push({ sessionId: request.sessionId, line: request.line, attachments: request.attachments })
      // Mirror the official executor: an unresolved name is a committed
      // `matched:false` (the caller's advertised-miss / prompt-fallback
      // authority), never a synthetic success.
      const name = request.line.trim().replace(/^\/+/, '').split(/\s+/)[0] ?? ''
      return descriptors.has(name) ? executeOutcome : { kind: 'committed', matched: false } as const
    },
  }
  const command = {
    wasAdvertisedClaim: (name: string) => descriptors.has(name),
    hostClaimOf: claimOf,
    hostOriginClaimOf: claimOf,
    hostCatalogResolves: (name: string) => descriptors.has(name),
    clientClaimsLine: () => false,
    isSkillWrapperName: () => false,
    isSkillInvocation: () => false,
    withCommandDelivery: <T,>(_delivery: unknown, run: () => T): T => run(),
    takeCommandDraftDisposition: () => undefined,
    clientCommands: {
      get: () => undefined,
      execute: async () => undefined,
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
      isCurrent: scope => scopeAuthority.isCurrent(scope),
      requireLive: () => {
        const live = scopeAuthority.captureLive()
        if (live === undefined) throw new Error('fixture: the owner is not live')
        return live
      },
    },
    session: {
      ensureSession: async () => {
        ensureCalls += 1
        if (ensureGate !== undefined) await ensureGate
        if (agent === undefined) {
          agent = { status: 'idle', session: { id: 'session-created' }, options: {}, cancel: () => {} }
          core.setCurrentOwner({} as never, agent.session.id)
        }
      },
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
      pendingInputReader: { snapshot: () => ({ running: false, items: [] }) },
      sessionWriter: {
        prompt: async (sessionId: string) => {
      prompts.push(sessionId)
      return { kind: 'committed', value: undefined }
    },
        updateQueue: async () => ({ kind: 'committed', value: undefined }),
      } as never,
      hostCommand: hostCommand as never,
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
    shell: {
      capturePlacement: () => ({ anchor: undefined, turn: undefined, target: 'beginning' as const, acceptedOrder: 0 }),
      run: () => {},
      interrupt: () => {},
      cancelRun: () => false,
    },
    supportsLocalShellCards: true,
    supportsTuiBuiltinUi: true,
    retainsStaleDraftRestore: true,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined as never, llm: () => undefined as never },
    tuiSettings: undefined,
    captureMatches: subject => core.isSubjectCurrent(subject as never),
    ownerWasReplaced: subject => core.subjectAuthority.ownerReplaced(subject as never),
    direct: { withPromptAdmission: async (_agent, _hasImages, task) => task() },
    requestExit: () => {},
    isPlanActive: () => false,
    prepareTransport: async (text, requestId) => preparePrompt(agent?.session.id ?? 'unbound', text, { images, files }, requestId),
  }
  const controller = createSubmissionController<AgentLike>(deps)
  return {
    controller,
    images,
    files,
    stages,
    executes,
    notices,
    consumeCount: () => consumed,
    prompts,
    draftText: () => draft,
    submit: (text: string) => {
      draft = text
      controller.submit(text)
      draft = ''
    },
    ensureCalls: () => ensureCalls,
    descriptors,
    setSession: (sessionId) => {
      if (sessionId === undefined) {
        agent = undefined
        return
      }
      if (agent === undefined) agent = { status: 'idle', session: { id: sessionId }, options: {}, cancel: () => {} }
      core.setCurrentOwner({} as never, sessionId)
    },
    invalidateScope: () => { core.bumpGeneration() },
    holdEnsure: () => {
      ensureGate = new Promise<void>(resolve => { releaseEnsureGate = resolve })
    },
    releaseEnsure: () => {
      const release = releaseEnsureGate
      releaseEnsureGate = undefined
      ensureGate = undefined
      release?.()
    },
    holdStage: () => {
      stageGate = new Promise<void>(resolve => { releaseStageGate = resolve })
    },
    releaseStage: () => {
      const release = releaseStageGate
      releaseStageGate = undefined
      stageGate = undefined
      release?.()
    },
    setStageError: (error) => { stageError = error },
    setExecuteOutcome: (outcome) => { executeOutcome = outcome },
    settled: async () => {
      // Bounded observation window over the OWNED workflow: the real file
      // source performs fs I/O, so microtasks alone are not a settlement
      // signal. `setImmediate` rounds let the pool callbacks run; 400 of them
      // is a negative-fact observation window, not a timer guess.
      for (let index = 0; index < 400; index += 1) {
        await new Promise<void>(resolve => setImmediate(resolve))
      }
    },
  }
}

/** Stage one real generic file draft and return its placeholder. */
async function addFileDraft(
  life: import('../support/temp-lifecycle.ts').TestLifecycle,
  files: DraftFileStore,
  name: string,
  bytes: Buffer,
): Promise<{ readonly placeholder: string; readonly path: string }> {
  const root = life.tempDir('dsh-command-file-')
  const path = join(root, name)
  await writeFile(path, bytes)
  const probe = await probeAttachment(path, root)
  assert.equal(probe.kind, 'file')
  if (probe.kind !== 'file') throw new Error('unreachable')
  const file = files.add({
    name: probe.name,
    byteLength: probe.byteLength,
    source: { type: 'path', path: probe.path, fingerprint: probe.fingerprint },
  })
  return { placeholder: file.placeholder, path }
}

function declareHost(harness: Harness, name: string, descriptor: HostDescriptor): void {
  harness.descriptors.set(name, descriptor)
}

test('a genuine declared Host command stages each FILE once and consumes only the submitted drafts on success', async (t) => {
  const life = testLifecycle(t)
  const harness = startHarness({ sessionId: 'session-a' })
  declareHost(harness, 'files', { leadingInput: true, attachments: true })
  const staged = await addFileDraft(life, harness.files, 'report.bin', Buffer.from([1, 2, 3, 4]))
  const line = `/files inspect ${staged.placeholder}`
  harness.submit(line)
  await harness.settled()
  assert.deepEqual(harness.stages.map(stage => ({ sessionId: stage.sessionId, name: stage.file.name, bytes: stage.bytes })), [
    { sessionId: 'session-a', name: 'report.bin', bytes: 4 },
  ], `the actual session receives exactly the one staged receipt (executes=${JSON.stringify(harness.executes)} notices=${JSON.stringify(harness.notices)})`)
  assert.equal(harness.executes.length, 1, 'the command is dispatched exactly once')
  assert.deepEqual(harness.executes[0]?.attachments, [{ type: 'file', receiptId: 'receipt-1' }])
  assert.equal(harness.files.values().length, 0, 'handler success consumes the submitted FILE draft')
  assert.equal(harness.draftText(), '', 'success restores nothing into the editor')
})

test('an IMAGE → FILE → IMAGE → FILE submission keeps its exact wire order and encoded image bytes', async (t) => {
  const life = testLifecycle(t)
  const harness = startHarness({ sessionId: 'session-a' })
  declareHost(harness, 'files', { leadingInput: true, attachments: true })
  const image = harness.images.add({ bytes: new Uint8Array([9, 8]), mediaType: 'image/png', width: 1, height: 1 })
  const first = await addFileDraft(life, harness.files, 'first.pdf', Buffer.from('%PDF-1'))
  const image2 = harness.images.add({ bytes: new Uint8Array([7]), mediaType: 'image/png', width: 1, height: 1 })
  const second = await addFileDraft(life, harness.files, 'empty.bin', Buffer.alloc(0))
  harness.submit(`/files ${image.placeholder} ${first.placeholder} ${image2.placeholder} ${second.placeholder}`)
  await harness.settled()
  assert.deepEqual(harness.stages.map(stage => [stage.file.name, stage.bytes]), [
    ['first.pdf', 6],
    ['empty.bin', 0],
  ], 'FILEs stage in their original order, including a strictly empty file')
  assert.deepEqual(harness.executes[0]?.attachments, [
    { type: 'image', mediaType: 'image/png', data: Buffer.from([9, 8]).toString('base64') },
    { type: 'file', receiptId: 'receipt-1' },
    { type: 'image', mediaType: 'image/png', data: Buffer.from([7]).toString('base64') },
    { type: 'file', receiptId: 'receipt-2' },
  ], 'the command wire preserves IMAGE/FILE interleaving exactly')
})

test('a changed second FILE aborts before dispatch, keeps every draft and stages nothing more', async (t) => {
  const life = testLifecycle(t)
  const harness = startHarness({ sessionId: 'session-a' })
  declareHost(harness, 'files', { leadingInput: true, attachments: true })
  const first = await addFileDraft(life, harness.files, 'first.pdf', Buffer.from('%PDF-1'))
  const second = await addFileDraft(life, harness.files, 'second.pdf', Buffer.from('%PDF-2'))
  // The source changes AFTER the submit-time snapshot was taken.
  await writeFile(second.path, Buffer.from('changed'), { mode: 0o600 })
  const line = `/files ${first.placeholder} ${second.placeholder}`
  harness.submit(line)
  await harness.settled()
  assert.equal(harness.stages.length, 1, 'only the first (valid) file stages; the changed one stops the loop')
  assert.equal(harness.executes.length, 0, 'a staging failure proves no command was dispatched')
  assert.equal(harness.draftText(), line, 'the complete submitted line is restored for correction')
  assert.match(harness.notices.join('\n'), /File changed since it was attached/, 'the actionable refusal is surfaced')
  assert.equal(harness.files.values().length, 2, 'both FILE drafts stay available')
})

test('a recalled file or a recalled image without local bytes refuses with zero uploads', async (t) => {
  const harness = startHarness({ sessionId: 'session-a' })
  declareHost(harness, 'files', { leadingInput: true, attachments: true })
  const recalledFile = harness.files.add({
    name: 'stored.pdf',
    byteLength: 4,
    source: { type: 'recalled', ref: { attachmentId: 'sha256:stored', name: 'stored.pdf', bytes: 4 } },
  })
  harness.submit(`/files ${recalledFile.placeholder}`)
  await harness.settled()
  assert.equal(harness.stages.length, 0, 'a recalled FILE preflights to zero upload')
  assert.equal(harness.executes.length, 0, 'and dispatches no command')
  assert.match(harness.notices.join('\n'), /stored files cannot be re-uploaded/)

  const recalledImage = harness.images.add({
    mediaType: 'image/png',
    width: 1,
    height: 1,
    recalledRef: { attachmentId: 'sha256:image', mediaType: 'image/png', bytes: 4, width: 1, height: 1 },
  })
  harness.files.clear()
  harness.submit(`/files ${recalledImage.placeholder}`)
  await harness.settled()
  assert.equal(harness.stages.length, 0, 'the recalled image adds no upload either')
  assert.equal(harness.executes.length, 0)
  assert.match(harness.notices.join('\n'), /recalled image cannot be attached to a command/)
})

test('an argued line of an execute-kind Host command stages nothing and falls back to the prompt', async (t) => {
  const life = testLifecycle(t)
  const harness = startHarness({ sessionId: 'session-a' })
  declareHost(harness, 'files', { leadingInput: false, attachments: true })
  const staged = await addFileDraft(life, harness.files, 'report.bin', Buffer.from([1]))
  harness.submit(`/files ${staged.placeholder}`)
  await harness.settled()
  assert.equal(harness.stages.length, 0, 'a non-invocation is never an upload trigger')
  assert.equal(harness.executes.length, 0, 'the line is not handed to the command plane')
  assert.equal(harness.prompts.length, 1, 'the argued line reaches the ordinary prompt path')
  assert.equal(harness.consumeCount(), 1, 'the ordinary prompt writer owns its own draft consumption')
  assert.equal(harness.files.values().length, 0, 'the ordinary prompt writer owns its own draft settlement')
})

test('the submit-time snapshot survives a concurrent draft-store change and binds the created Session id', async (t) => {
  const life = testLifecycle(t)
  const harness = startHarness()
  declareHost(harness, 'files', { leadingInput: true, attachments: true })
  const staged = await addFileDraft(life, harness.files, 'original.bin', Buffer.from([4, 5, 6]))
  harness.holdEnsure()
  harness.submit(`/files ${staged.placeholder}`)
  // The deferred session creation is in flight: the draft store changes.
  assert.equal(harness.stages.length, 0, 'nothing is staged before the real Session exists')
  harness.files.clear()
  await addFileDraft(life, harness.files, 'replacement.bin', Buffer.from([9, 9, 9, 9, 9]))
  harness.releaseEnsure()
  await harness.settled()
  assert.equal(harness.ensureCalls(), 1)
  assert.deepEqual(harness.stages.map(stage => ({ sessionId: stage.sessionId, name: stage.file.name, bytes: stage.bytes })), [
    { sessionId: 'session-created', name: 'original.bin', bytes: 3 },
  ], 'the frozen gesture snapshot uploads the ORIGINAL source into the ACTUAL created Session')
})

test('a scope replaced during staging dispatches no command and mutates no draft', async (t) => {
  const life = testLifecycle(t)
  const harness = startHarness({ sessionId: 'session-a' })
  declareHost(harness, 'files', { leadingInput: true, attachments: true })
  const staged = await addFileDraft(life, harness.files, 'report.bin', Buffer.from([1, 2]))
  harness.holdStage()
  harness.submit(`/files ${staged.placeholder}`)
  await harness.settled()
  assert.equal(harness.stages.length, 0, 'the first stage is in flight')
  assert.equal(harness.controller.hasUnsettledClientWrite(), true,
    'the accepted Client write lifetime stays unsettled while the receipt is staged')
  harness.invalidateScope()
  harness.releaseStage()
  await harness.settled()
  assert.equal(harness.controller.hasUnsettledClientWrite(), false,
    'the stale exit releases the accepted write lifetime exactly once')
  assert.equal(harness.executes.length, 0, 'a stale captured scope must never dispatch the command')
  assert.equal(harness.draftText(), '', 'no draft is restored into the replacement surface')
  assert.equal(harness.files.values().length, 1, 'no draft is consumed on the replacement surface')
  assert.deepEqual(harness.notices, [], 'no notice is published on the replacement surface')
})

test('a handler error keeps the draft while an indeterminate result never retries', async (t) => {
  const life = testLifecycle(t)
  const harness = startHarness({ sessionId: 'session-a' })
  declareHost(harness, 'files', { leadingInput: true, attachments: true })
  const first = await addFileDraft(life, harness.files, 'first.bin', Buffer.from([1]))
  harness.setExecuteOutcome({
    kind: 'committed',
    matched: true,
    execution: { result: { kind: 'error', text: 'cannot inspect' } },
  })
  harness.submit(`/files ${first.placeholder}`)
  await harness.settled()
  assert.equal(harness.executes.length, 1)
  assert.equal(harness.draftText(), `/files ${first.placeholder}`, 'an error result restores the complete line')
  assert.equal(harness.files.values().length, 1, 'the FILE draft stays for correction')

  const second = await addFileDraft(life, harness.files, 'second.bin', Buffer.from([2]))
  harness.setExecuteOutcome({
    kind: 'indeterminate',
    error: { code: 'session/write-indeterminate', message: 'ACK lost' },
  })
  harness.submit(`/files ${second.placeholder}`)
  await harness.settled()
  assert.equal(harness.executes.length, 2, 'the indeterminate command is attempted once')
  assert.equal(harness.draftText(), '', 'an indeterminate result is never auto-restored for a retry')
  assert.equal(harness.files.values().length, 2, 'an indeterminate result never consumes')
  assert.match(harness.notices.join('\n'), /indeterminate/)
})

test('an advertised command missing from the created session restores the line without consuming attachments', async (t) => {
  const life = testLifecycle(t)
  const harness = startHarness({ sessionId: 'session-a' })
  declareHost(harness, 'files', { leadingInput: true, attachments: true })
  const staged = await addFileDraft(life, harness.files, 'report.bin', Buffer.from([1]))
  harness.setExecuteOutcome({ kind: 'committed', matched: false })
  harness.submit(`/files ${staged.placeholder}`)
  await harness.settled()
  assert.equal(harness.executes.length, 1, 'the plane attempted the advertised command once')
  assert.equal(harness.draftText(), `/files ${staged.placeholder}`, 'the advertised miss restores the complete line')
  assert.equal(harness.files.values().length, 1, 'the attachment is never consumed by a miss')
  assert.match(harness.notices.join('\n'), /is not available in the created session/)
})

test('a non-advertised unmatched command falls back to ONE ordinary prompt', async (t) => {
  const harness = startHarness({ sessionId: 'session-a' })
  harness.submit('/files inspect plain')
  await harness.settled()
  assert.equal(harness.executes.length, 1, 'the plane was asked once and answered unmatched')
  assert.equal(harness.stages.length, 0, 'an unmatched line never stages a file')
  assert.equal(harness.prompts.length, 1, 'the line falls back to exactly ONE ordinary prompt')
})

test('the same FILE placeholder twice stages two ordered receipts', async (t) => {
  const life = testLifecycle(t)
  const harness = startHarness({ sessionId: 'session-a' })
  declareHost(harness, 'files', { leadingInput: true, attachments: true })
  const staged = await addFileDraft(life, harness.files, 'report.bin', Buffer.from([1, 2]))
  harness.submit(`/files ${staged.placeholder} and ${staged.placeholder}`)
  await harness.settled()
  assert.equal(harness.stages.length, 2, 'each attachment OCCURRENCE stages its own receipt')
  assert.deepEqual(harness.executes[0]?.attachments, [
    { type: 'file', receiptId: 'receipt-1' },
    { type: 'file', receiptId: 'receipt-2' },
  ])
})

test('an unknown handler result kind is never consumed as success', async (t) => {
  const life = testLifecycle(t)
  const harness = startHarness({ sessionId: 'session-a' })
  declareHost(harness, 'files', { leadingInput: true, attachments: true })
  const staged = await addFileDraft(life, harness.files, 'report.bin', Buffer.from([1]))
  harness.setExecuteOutcome({
    kind: 'committed',
    matched: true,
    execution: { result: { kind: 'future' } },
  })
  harness.submit(`/files ${staged.placeholder}`)
  await harness.settled()
  assert.equal(harness.draftText(), `/files ${staged.placeholder}`, 'the illegal result restores the line')
  assert.equal(harness.files.values().length, 1, 'the draft survives the illegal result')
  assert.match(harness.notices.join('\n'), /unknown result kind/)
})
