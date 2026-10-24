/**
 * PR1 lifecycle L01/L04 at the REAL consumer level: terminal Editor input →
 * TuiApp events → the REAL `createSubmissionController` → the REAL
 * `bindSubmissionRuntime` → the REAL draft-attachment pin/consume path →
 * `preparePrompt` → the outgoing writer sink.
 *
 * Why this file exists (PR #394 closure plan §9 anti-cheat): the preview
 * integration suite drives TuiApp with a fixture `onSubmit`; that proves the
 * surface but not the submit handoff. Here the business owner is production
 * code, and the assertions are taken at the takeover boundaries:
 * - L01: every submitted image is pinned BEFORE the editor clear; the bridge is
 *   gone once the synchronous dispatch returns; the writer receives all nine
 *   real image segments; the business pin survives until the write settles.
 * - L04: an async writer rejection restores the draft BEFORE the business pin
 *   releases, so the restored placeholders still resolve to real bytes.
 * @module @xmoon76/dsh-pi-tui/draft-image-submit-lifecycle.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { resetCapabilitiesCache, setCapabilities } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { consumeDraftAttachments, pinDraftAttachments } from '../../src/client/media/draft-attachments.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { createSubmissionController, type SubmissionControllerDeps } from '../../src/app/submission/controller.ts'
import { bindSubmissionRuntime } from '../../src/app/submission/runtime.ts'
import { mergeDraft } from '../../src/app/submission/steer.ts'
import { preparePrompt } from '../../src/app/submission/prepared-prompt.ts'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import { createSessionScopeAuthority } from '../../src/app/session/scope.ts'
import type { PreparedMessage, WriteOutcome } from '../../src/runtime/session-writer-port.ts'
import type { SubmissionRuntimeSurface } from '../../src/app/submission/runtime.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.writeUInt32BE(800, 16)
  bytes.writeUInt32BE(100, 20)
  return bytes
}

function addImage(store: DraftImageStore) {
  return store.add({ bytes: pngBytes(), mediaType: 'image/png', width: 800, height: 100, name: 'shot.png' })
}

/** The outgoing-sink control: one pending writer promise the test resolves. */
interface WriteControl {
  readonly writes: { readonly sessionId: string; readonly message: PreparedMessage }[]
}

interface Harness {
  readonly vt: VirtualTerminal
  readonly app: TuiApp
  readonly store: DraftImageStore
  readonly bridge: {
    acquired: number
    released: number
    active: number
    /** The editor draft as it still stood when the bridge was acquired. */
    preClearDrafts: string[]
  }
  /** Pin counts observed at each restore merge (restore-before-release proof). */
  readonly restoreProbes: { readonly pinned: number }[]
  readonly write: WriteControl
  /** Resolve the next outgoing write with `outcome`. */
  finishWrite(outcome: WriteOutcome): void
}

function startHarness(options: { failSessionCreate?: boolean } = {}): Harness {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const vt = new VirtualTerminal(100, 32)
  const store = new DraftImageStore()
  const files = new DraftFileStore()
  const bridge = { acquired: 0, released: 0, active: 0, preClearDrafts: [] as string[] }
  const restoreProbes: { pinned: number }[] = []
  const writes: { sessionId: string; message: PreparedMessage }[] = []
  const writeResolvers: ((outcome: WriteOutcome) => void)[] = []

  let app!: TuiApp
  const composer = {
    getDraft: () => app.getDraft(),
    setDraft: (text: string) => { app.setDraft(text) },
    setEditorText: (text: string) => {
      // The controller's own deferred-failure restore goes through this port:
      // record the pin count at the moment the draft comes back.
      if (text.includes('[image #')) {
        restoreProbes.push({ pinned: store.values().filter(image => store.isPinned(image.id)).length })
      }
      app.setEditorText(text)
    },
    insertIntoEditor: (text: string) => { app.insertIntoEditor(text) },
    notify: (message: string) => { notices.push(message) },
    setSubmitPending: () => {},
    clearSettledLocalMessages: () => {},
  }
  const notices: string[] = []

  interface AgentLike {
    readonly status: string
    readonly session: { readonly id: string }
    readonly options: Record<string, unknown>
    readonly inbox: Record<string, unknown>
  }
  const agent: AgentLike = { status: 'idle', session: { id: 'session-a' }, options: {}, inbox: {} }
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner({} as never, 'session-a')
  // The REAL scope authority mints the live scope the writer admission fences.
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
      // The runtime restores BEFORE it releases its reserved-submit pin: record
      // the pin count at this exact moment so the ordering is provable.
      restoreProbes.push({ pinned: store.values().filter(image => store.isPinned(image.id)).length })
      const merged = mergeDraft(app.getDraft(), text)
      app.setEditorText(merged)
      return merged === text
    },
    restoreStaleDraftIntoEditor: (text) => {
      const merged = mergeDraft(app.getDraft(), text)
      app.setEditorText(merged)
      return merged === text ? 'merged-verbatim' : 'merged'
    },
    consumeDraftAttachments: (text) => { consumeDraftAttachments(text, store, files) },
    markDispatch: () => {},
    beginLocalSubmission: () => {},
    settleLocalSubmission: () => {},
    settleSubmitAck: () => {},
    notify: (message) => { notices.push(message) },
    refuseByTransitionFence: (text) => { app.setEditorText(mergeDraft(app.getDraft(), text)) },
    prepareMessage: async (text, requestId) => preparePrompt('session-a', text, { images: store, files }, requestId),
    prompt: (sessionId, message) => new Promise<WriteOutcome>((resolve) => {
      writes.push({ sessionId, message })
      writeResolvers.push(resolve)
    }),
  }
  const submissionRuntime = bindSubmissionRuntime({ surface: runtimeSurface })

  const command = {
    wasAdvertisedClaim: () => false,
    hostClaimOf: () => undefined,
    hostOriginClaimOf: () => undefined,
    hostCatalogResolves: () => false,
    clientClaimsLine: () => false,
    isSkillWrapperName: () => false,
    isSkillInvocation: () => false,
    withCommandDelivery: <T>(_delivery: unknown, run: () => T): T => run(),
    takeCommandDraftDisposition: () => undefined,
    clientCommands: {
      get: () => undefined,
      execute: async () => undefined,
    },
  }
  const diag = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} }

  const deps: SubmissionControllerDeps<AgentLike> = {
    app: () => composer,
    diag,
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
        if (live === undefined) throw new Error('the fixture owner is not live')
        return live
      },
    },
    session: {
      ensureSession: async () => {
        if (options.failSessionCreate === true) throw new Error('deferred session creation failed')
      },
      beginCommandSettlement: () => {},
      abortCommandSettlement: () => {},
      settleCommandSettlement: () => {},
      trackSettlementWork: () => {},
    },
    submissionRuntime,
    command: command as unknown as SubmissionControllerDeps<AgentLike>['command'],
    commandPlane: { available: () => false, execute: async () => undefined, findHandler: () => undefined },
    backendKind: 'direct',
    backend: {
      hostFile: { canonicalizeMentions: async (_scope: unknown, text: string) => text } as never,
      pendingInputReader: { snapshot: () => undefined },
      sessionWriter: { prompt: async () => ({ kind: 'committed', value: undefined }) } as never,
      hostCommand: { execute: async () => ({ kind: 'committed', matched: false }) } as never,
    },
    drafts: { images: store, files },
    status: { sessionCwd: () => '/tmp' },
    surface: { refreshPendingInput: () => {} },
    history: {
      persist: () => {},
      persistAfterSession: async (resolveSession, persist) => {
        const sessionId = await resolveSession()
        persist(sessionId)
      },
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
    supportsLocalShellCards: false,
    supportsTuiBuiltinUi: false,
    retainsStaleDraftRestore: true,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined as never, llm: () => undefined as never },
    tuiSettings: undefined,
    captureMatches: (subject) => core.isSubjectCurrent(subject as never),
    ownerWasReplaced: (subject) => core.subjectAuthority.ownerReplaced(subject as never),
    direct: { withPromptAdmission: async (_agent, _hasImages, task) => task() },
    requestExit: () => {},
    isPlanActive: () => false,
    prepareTransport: async (text, requestId) => preparePrompt('session-a', text, { images: store, files }, requestId),
  }
  const controller = createSubmissionController<AgentLike>(deps)

  app = new TuiApp(vt, {
    onSubmit: (text, request, scopeToken) => { controller.submit(text, request, scopeToken) },
    onExit: () => {},
  }, {
    draftImagePreviewSource: { values: () => store.values() },
    draftImagePreviewLiveDraft: read => store.setLiveDraftTextSource(read),
    draftImagePreviewReserve: (text) => {
      bridge.preClearDrafts.push(app.getDraft())
      const release = store.pinReferenced(text)
      bridge.acquired += 1
      bridge.active += 1
      let done = false
      return () => {
        if (done) return
        done = true
        bridge.released += 1
        bridge.active -= 1
        release()
      }
    },
    draftImagePreviewUndo: {
      registerUndoOwner: (owner, retireDraftImage) => store.registerUndoOwner(owner, retireDraftImage),
      releaseUndoForOwner: (owner) => store.releaseUndoForOwner(owner),
      reconcileUndoOwner: (owner, placeholders) => store.reconcileUndoOwner(owner, placeholders),
    },
    imageTheme: { fallbackColor: text => text },
  })
  app.start()
  startedApps.add(app)

  return {
    vt,
    app,
    store,
    bridge,
    restoreProbes,
    write: { writes },
    finishWrite: (outcome) => {
      const resolve = writeResolvers.shift()
      assert.ok(resolve !== undefined, 'no outgoing write is pending')
      resolve(outcome)
    },
  }
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.fail(`timed out waiting for ${label}`)
}

test('L01: Enter hands all nine pinned images to the REAL controller/sink', async () => {
  const harness = startHarness()
  const { vt, app, store, bridge } = harness
  const images = Array.from({ length: 9 }, () => addImage(store))
  const draft = images.map(image => image.placeholder).join(' ')
  app.setDraft(draft)
  await vt.waitForRender()
  // A real edit pushes the undo snapshot that makes all nine genuinely undoable.
  vt.sendInput('!')
  await vt.waitForRender()

  vt.sendInput('\r')
  await vt.waitForRender()
  // The synchronous dispatch is over: the scoped bridge must be gone, while the
  // REAL controller/runtime already holds its own attachment pin.
  assert.equal(bridge.acquired, 1)
  assert.equal(bridge.preClearDrafts.length, 1)
  const preClear = bridge.preClearDrafts[0]!
  for (const image of images) {
    assert.ok(preClear.includes(image.placeholder),
      `the bridge was acquired BEFORE the clear: #${image.id} was still in the editor`)
  }
  assert.equal(bridge.active, 0, 'the bridge is released at the end of the synchronous dispatch')
  await waitFor(() => harness.write.writes.length === 1, 'the outgoing write')
  for (const image of images) {
    assert.equal(store.isPinned(image.id), true, `image #${image.id} is business-pinned while the write is in flight`)
    assert.ok(store.get(image.id) !== undefined, `image #${image.id} still resolves`)
  }
  const outgoing = harness.write.writes[0]!
  const prepared = outgoing.message as unknown as ReturnType<typeof preparePrompt>
  assert.equal(prepared.segments.filter(segment => segment.type === 'image').length, 9,
    'the outgoing message carries all nine REAL image segments')

  harness.finishWrite({ kind: 'committed', value: undefined })
  await waitFor(() => store.size() === 0, 'the committed consume')
  assert.equal(bridge.active, 0)
  app.stop()
})

test('L02: the accelerated submitDraft path hands the same nine pinned images to the sink', async () => {
  const harness = startHarness()
  const { vt, app, store, bridge } = harness
  const images = Array.from({ length: 9 }, () => addImage(store))
  const draft = images.map(image => image.placeholder).join(' ')
  app.setDraft(draft)
  await vt.waitForRender()
  vt.sendInput('!')
  await vt.waitForRender()

  app.submitDraft('accelerated')
  await vt.waitForRender()
  assert.equal(bridge.acquired, 1)
  assert.equal(bridge.active, 0, 'the scoped bridge ended with the synchronous dispatch')
  await waitFor(() => harness.write.writes.length === 1, 'the outgoing write')
  const prepared = harness.write.writes[0]!.message as unknown as ReturnType<typeof preparePrompt>
  assert.equal(prepared.segments.filter(segment => segment.type === 'image').length, 9)
  harness.finishWrite({ kind: 'committed', value: undefined })
  await waitFor(() => store.size() === 0, 'the committed consume')
  app.stop()
})

test('L04b: a deferred session-create failure restores the draft BEFORE the business pin releases', async () => {
  const harness = startHarness({ failSessionCreate: true })
  const { vt, app, store, bridge } = harness
  const images = Array.from({ length: 9 }, () => addImage(store))
  const draft = images.map(image => image.placeholder).join(' ')
  app.setDraft(draft)
  await vt.waitForRender()
  vt.sendInput('!')
  await vt.waitForRender()

  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(bridge.active, 0, 'the bridge ended with the synchronous dispatch')
  await waitFor(() => app.getDraft().includes(images[0]!.placeholder), 'the failure restore')
  assert.equal(harness.write.writes.length, 0, 'the failed session creation never reached the writer')
  assert.equal(harness.restoreProbes.length, 1)
  assert.equal(harness.restoreProbes[0]!.pinned, 9,
    'the restore ran while all nine business pins were still held')
  assert.equal(preparedImageCount(app.getDraft(), store), 9, 'the restored draft resolves every image')
  app.stop()
})

test('L04: an async writer rejection restores the draft BEFORE the business pin releases', async () => {
  const harness = startHarness()
  const { vt, app, store, bridge } = harness
  const images = Array.from({ length: 9 }, () => addImage(store))
  const draft = images.map(image => image.placeholder).join(' ')
  app.setDraft(draft)
  await vt.waitForRender()
  vt.sendInput('!')
  await vt.waitForRender()

  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(bridge.active, 0, 'the bridge is already gone while the write is in flight')
  await waitFor(() => harness.write.writes.length === 1, 'the outgoing write')
  assert.equal(store.size(), 9)

  // The writer REJECTS. The runtime merges the submitted draft back FIRST and
  // only then releases its reserved-submit pin.
  harness.finishWrite({
    kind: 'rejected',
    error: { code: 'test/rejected', message: 'the writer refused the write' },
  })
  await waitFor(() => app.getDraft().includes(images[0]!.placeholder), 'the restored draft')
  assert.equal(harness.restoreProbes.length, 1)
  assert.equal(harness.restoreProbes[0]!.pinned, 9,
    'the restore ran while all nine business pins were still held')
  const restored = app.getDraft()
  assert.equal(preparedImageCount(restored, store), 9, 'the restored draft still resolves all nine images')
  for (const image of images) {
    assert.ok(store.get(image.id) !== undefined, `image #${image.id} survived the rejection restore`)
  }
  assert.ok(harness.write.writes.length === 1)
  app.stop()
})

function preparedImageCount(text: string, store: DraftImageStore): number {
  return preparePrompt('session-check', text, { images: store }).segments
    .filter(segment => segment.type === 'image').length
}
