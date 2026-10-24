/**
 * Headless tests for the /image command end to end (plan M2): the handler
 * is sessionless, stages into the shared store, and prunes drafts deleted
 * while the async intake was in flight (review finding 2 follow-up).
 * @module @xmoon76/dsh-pi-tui/image-command.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { registerTuiCommands, type TuiCommandRunner } from '../../src/commands.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { DraftFileStore } from '../../src/client/media/attachment/file-draft.ts'
import { consumeDraftAttachments, pruneUnreferencedDraftAttachments } from '../../src/client/media/draft-attachments.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'
import { createSubmissionController, type SubmissionControllerDeps } from '../../src/app/submission/controller.ts'
import { bindSubmissionRuntime } from '../../src/app/submission/runtime.ts'
import { createSessionOwnershipCore } from '../../src/app/session/ownership-core.ts'
import { createSessionScopeAuthority } from '../../src/app/session/scope.ts'
import { mergeDraft } from '../../src/app/submission/steer.ts'
import type { SubmissionComposerPort } from '../../src/app/submission/composer-port.ts'
import type { ClientCommandExecution } from '../../src/app/command/client-command-registry.ts'
import { checkImageLimits } from '../../src/client/media/image/intake.ts'
import { TSP_B2A_RESULT_NOTICE_COMMANDS, tspBuiltinAvailability } from '../../src/app/command/tsp-capability.ts'
import { classifyCommandLine } from '../../src/domain/command/policy.ts'
import { prepareUserMessage } from '../../src/app/submission/direct-message-preparation.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp started in this file is
 * stopped after each test — the process's single-live-TUI slot (the
 * vendored keybindings are process-global) is held only by LIVE surfaces
 * (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

/** A tiny PNG (1×1) byte header. */
function pngBytes(): Buffer {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

/** A fake commands service capturing the registered /image handler. */
function fakeCommands(): { commands: { register: (def: { name: string; handler?: unknown }) => () => void; list: () => { name: string }[] }; defs: { name: string; handler?: unknown }[] } {
  const defs: { name: string; handler?: unknown }[] = []
  const commands = {
    register: (def: { name: string; handler?: unknown }): (() => void) => {
      defs.push(def)
      return () => {}
    },
    list: () => [],
  }
  return { commands, defs }
}

function setup(options: { cwd?: string; sessionCwd?: string; signal?: AbortSignal; transitionPending?: () => boolean } = {}): {
  app: TuiApp
  runner: TuiCommandRunner
  imageStore: DraftImageStore
  fileStore: DraftFileStore
  imageHandler: (invocation: { rawInput: string; signal?: AbortSignal }) => unknown
  attachHandler: (invocation: { rawInput: string; signal?: AbortSignal }) => unknown
} {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const ctx = new Context()
  const services = fakeCommands()
  ctx.provide('commands', services.commands as never)
  const store = new DraftImageStore()
  const fileStore = new DraftFileStore()
  const clientCwd = options.cwd ?? '/ws'
  const sessionCwd = options.sessionCwd ?? '/ws'
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    ...sessionScopeFacts(() => undefined, () => 0),
    currentSessionId: undefined,
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: undefined,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined,
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as import('../../src/commands.ts').CommandRegistryLike | undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostFile: new DirectHostFilePort(() => undefined),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
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
    sessionWriter: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: clientCwd,
    sessionCwd: () => sessionCwd,
    fileStore,
    imageStore: store,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: (text) => app.insertIntoEditor(text),
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: options.signal ?? new AbortController().signal,
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    get defaultIntentOutcome() { return undefined },
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {},
    setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, openPluginManager: () => {}, createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: options.transitionPending ?? (() => false),
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
  registerTuiCommandsWithDirectSeams(runner)
  const image = services.defs.find(def => def.name === 'image')
  const attach = services.defs.find(def => def.name === 'attach')
  assert.ok(image !== undefined, '/image registered')
  assert.ok(attach !== undefined, '/attach registered')
  return {
    app,
    runner,
    imageStore: store,
    fileStore,
    imageHandler: image.handler as (p: { rawInput: string; signal?: AbortSignal }) => unknown,
    attachHandler: attach.handler as (p: { rawInput: string; signal?: AbortSignal }) => unknown,
  }
}

/** Poll until the predicate holds (bounded) — never a fixed sleep, which
 * would make the async-intake tests timing-sensitive (AGENTS.md trap). */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the intake')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('/image stages the file into the draft store and inserts its placeholder', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-image-command-')
  const file = join(dir, 'shot.png')
  writeFileSync(file, pngBytes())
  const { app, imageStore, imageHandler } = setup()
  const result = await imageHandler({ rawInput: file })
  assert.deepEqual(result, { kind: 'success' })
  await waitFor(() => imageStore.size() === 1)
  assert.equal(imageStore.size(), 1)
  const draft = imageStore.values()[0]!
  assert.equal(draft.placeholder, '[image #1 (1×1)]')
  assert.ok(app.getDraft().includes(draft.placeholder), 'placeholder inserted into the editor')
})

test('/attach stages a generic file from the Client cwd, not the session cwd', async (t) => {
  const life = testLifecycle(t)
  const client = life.tempDir('dsh-attach-client-')
  const session = life.tempDir('dsh-attach-session-')
  const file = join(client, 'report.pdf')
  writeFileSync(file, Buffer.from('%PDF-1.7 report'))
  const { app, fileStore, attachHandler } = setup({ cwd: client, sessionCwd: session })
  const result = await attachHandler({ rawInput: 'report.pdf' })
  assert.deepEqual(result, { kind: 'success' })
  await waitFor(() => fileStore.values().length === 1)
  const draft = fileStore.values()[0]!
  assert.equal(draft.name, 'report.pdf')
  assert.ok(app.getDraft().includes(draft.placeholder), 'generic placeholder inserted into the editor')
})

test('/attach drops intake that finishes during a session transition', async (t) => {
  const life = testLifecycle(t)
  const client = life.tempDir('dsh-attach-transition-')
  writeFileSync(join(client, 'report.pdf'), Buffer.from('%PDF-1.7 report'))
  let transitionChecks = 0
  const { app, fileStore, attachHandler } = setup({
    cwd: client,
    transitionPending: () => ++transitionChecks >= 2,
  })
  assert.deepEqual(await attachHandler({ rawInput: 'report.pdf' }), { kind: 'success' })
  await waitFor(() => transitionChecks >= 2)
  assert.equal(fileStore.values().length, 0)
  assert.equal(app.getDraft(), '')
})

test('/attach accepts a sparse generic file larger than the image resident cap', async (t) => {
  const life = testLifecycle(t)
  const client = life.tempDir('dsh-attach-large-')
  const file = join(client, 'large.tar')
  writeFileSync(file, '')
  truncateSync(file, 64 * 1024 * 1024 + 1)
  const { fileStore, attachHandler } = setup({ cwd: client, sessionCwd: '/different-session' })
  assert.deepEqual(await attachHandler({ rawInput: 'large.tar' }), { kind: 'success' })
  await waitFor(() => fileStore.values().length === 1)
  assert.equal(fileStore.values()[0]!.byteLength, 64 * 1024 * 1024 + 1)
})

test('/attach drops late intake after lifecycle teardown aborts', async (t) => {
  const life = testLifecycle(t)
  const client = life.tempDir('dsh-attach-abort-')
  writeFileSync(join(client, 'report.pdf'), Buffer.from('%PDF-1.7 report'))
  const controller = new AbortController()
  const requestController = new AbortController()
  const { app, fileStore, attachHandler } = setup({ cwd: client, signal: controller.signal })
  const pending = attachHandler({ rawInput: 'report.pdf', signal: requestController.signal })
  controller.abort()
  await pending
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fileStore.values().length, 0)
  assert.equal(app.getDraft(), '')
})

test('/image prunes drafts whose placeholder left the editor while the intake was in flight', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-image-command-')
  const file = join(dir, 'new.png')
  writeFileSync(file, pngBytes())
  const { app, imageStore, imageHandler } = setup()
  // A stale draft whose placeholder is still in the editor text.
  const stale = imageStore.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1 })
  app.setDraft(`look at ${stale.placeholder}`)
  const pending = imageHandler({ rawInput: file })
  // While the async intake reads the file, the user Ctrl+C-clears the
  // editor: the stale draft's placeholder is gone from the text. The
  // post-read prune must remove the stale draft; only the new attach
  // survives (predicate waits for the PRUNE, not just size — the store
  // already holds the stale draft when the intake starts).
  app.setEditorText('')
  await pending
  await waitFor(() => imageStore.get(stale.id) === undefined)
  assert.equal(imageStore.get(stale.id), undefined, 'the deleted placeholder\'s draft is pruned after the read')
  assert.equal(imageStore.size(), 1, 'only the new attach remains')
  assert.equal(imageStore.values()[0]!.source.type, 'path', 'the new attach is the path intake')
})


test('failed submission restores BEFORE unpinning: placeholders keep their backing draft through concurrent attaches (review finding)', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-image-race-')
  const file2 = join(dir, 'second.png')
  writeFileSync(file2, pngBytes())
  const { app, imageStore, imageHandler } = setup()
  // Stage image #1 and submit a multimodal draft (the editor text).
  const draft1 = imageStore.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1 })
  const submitted = `look at ${draft1.placeholder}`
  app.setEditorText(submitted)
  // The submission pins SYNCHRONOUSLY (same call stack that left the
  // editor) and the editor clears.
  const release = imageStore.pinReferenced(submitted)
  app.setEditorText('')
  // While the async prepare is blocked, the user attaches a SECOND
  // image: its attach-time prunes (pre/post-read) see the empty editor
  // but must keep the PINNED in-flight draft #1.
  const result = await imageHandler({ rawInput: file2 })
  assert.deepEqual(result, { kind: 'success' })
  await waitFor(() => imageStore.size() >= 2)
  assert.equal(imageStore.get(draft1.id), draft1, 'the in-flight draft survives the concurrent attach')
  // The submission FAILS: the task catch restores the editor BEFORE the
  // pin releases (the exact ordering this fix enforces).
  restoreIntoEditor(app, submitted)
  assert.ok(app.getDraft().includes(draft1.placeholder), 'the restored editor references draft #1')
  release()
  assert.equal(imageStore.isPinned(draft1.id), false, 'the pin released after the restore')
  // A later /image runs a post-read prune against the RESTORED editor:
  // draft #1 is referenced by the text, so it survives the prune even
  // though its pin is gone.
  await imageHandler({ rawInput: file2 })
  await waitFor(() => imageStore.size() >= 3)
  assert.equal(imageStore.get(draft1.id), draft1, 'the restored placeholder keeps its backing draft')
  assert.ok(app.getDraft().includes(draft1.placeholder), 'the placeholder stays in the editor')
})

/** The restore half of the failure path (restoreSubmissionDraft semantics). */
function restoreIntoEditor(app: TuiApp, draft: string): void {
  app.setEditorText([app.getDraft(), draft].filter(part => part.trim() !== '').join('\n\n') || draft)
}

test('orchestration: a real submit flow restores BEFORE unpin and survives a concurrent /image prune', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-image-orch-')
  const file2 = join(dir, 'second.png')
  writeFileSync(file2, pngBytes())
  const { app, imageStore, imageHandler } = setup()
  const { runReservedSubmit } = await import('../../src/app/submission/submit-flow.ts')
  // Stage #1; the user submits a multimodal draft (the editor carries
  // the text).
  const draft1 = imageStore.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1 })
  const submitted = `look at ${draft1.placeholder}`
  app.setEditorText(submitted)
  // The REAL submit flow: reserve synchronously (same call stack) →
  // async run → on failure restore → release. The run body mirrors the
  // dispatchViaSession shape; the simulated async admission lets the
  // concurrent /image attach interleave.
  const failing = runReservedSubmit({
    reserve: (t) => imageStore.pinReferenced(t),
    run: async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
      throw new Error('admission failed (simulated)')
    },
    restore: (t) => {
      app.setEditorText([app.getDraft(), t].filter(part => part.trim() !== '').join('\n\n') || t)
    },
  }, submitted)
  // Attach the rejection assertion IMMEDIATELY: the async run settles on a
  // 10ms timer, and under full-suite load a later handler leaves an
  // unhandled-rejection window (the observed flake) — assert.rejects is
  // awaited at the end, but its handler is live from here on.
  const rejection = assert.rejects(failing, /admission failed/)
  // The editor was cleared before dispatch (submit semantics); while the
  // async run is blocked, the user attaches a second image — its prunes
  // see the empty editor but must keep the PINNED draft #1.
  app.setEditorText('')
  const attachResult = imageHandler({ rawInput: file2 })
  assert.deepEqual(attachResult, { kind: 'success' })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(imageStore.get(draft1.id), draft1, 'the in-flight draft survives the concurrent attach')
  // The submission fails: the flow restores the editor BEFORE releasing
  // the reservation (the ordering contract under test).
  await rejection
  assert.equal(imageStore.isPinned(draft1.id), false, 'the reservation released after the restore')
  assert.ok(app.getDraft().includes(draft1.placeholder), 'the restored editor references draft #1')
  // The concurrent attach settles (its post-read prune sees the restored
  // editor): draft #1 stays referenced and alive.
  await waitFor(() => imageStore.size() >= 2)
  assert.equal(imageStore.get(draft1.id), draft1, 'the restored placeholder keeps its backing draft after the prune')
})

test('command fallback SUCCESS: the handoff pin transfers and releases exactly once', async () => {
  const { app, imageStore } = setup()
  const { runReservedSubmit } = await import('../../src/app/submission/submit-flow.ts')
  const draft = imageStore.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1 })
  const text = `look at ${draft.placeholder}`
  // The handoff pin is acquired synchronously BEFORE commands.execute()
  // launches (the outer submission pin releases when its task returns).
  const handoff = imageStore.pinReferenced(text)
  // The nested flow TRANSFERS that reservation — a second pin here would
  // leak the handoff forever (review finding).
  await runReservedSubmit({
    reserve: () => handoff,
    run: async () => { consumeDraftAttachments(text, imageStore) },
    restore: () => {},
  }, text)
  assert.equal(imageStore.isPinned(draft.id), false, 'the handoff pin is released after the nested submit')
  assert.equal(imageStore.get(draft.id), undefined, 'the consumed draft is gone')
})

test('command fallback FAILURE: restore keeps the draft; the pin releases; prune can collect it after the placeholder leaves', async () => {
  const { app, imageStore } = setup()
  const { runReservedSubmit } = await import('../../src/app/submission/submit-flow.ts')
  const draft = imageStore.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1 })
  const text = `look at ${draft.placeholder}`
  const handoff = imageStore.pinReferenced(text)
  await assert.rejects(() => runReservedSubmit({
    reserve: () => handoff,
    run: async () => { throw new Error('admission failed (simulated)') },
    restore: () => { app.setEditorText(text) },
  }, text), /admission failed/)
  // Restored draft survives (referenced by the editor) and the pin is gone.
  assert.equal(imageStore.isPinned(draft.id), false, 'the handoff pin released after the failure')
  assert.equal(imageStore.get(draft.id), draft, 'the restored draft is still backed')
  // The user deletes the placeholder: prune can now collect it (no stale
  // pin holds it forever).
  app.setEditorText('')
  pruneUnreferencedDraftAttachments('', imageStore)
  assert.equal(imageStore.get(draft.id), undefined, 'the released draft is prunable after the placeholder leaves')
})

// ── The mounted-composer (no PiTui app) route ──────────────────────────────

/** A minimal renderer composer: the port the TSP renderer supplies in place of
 *  a `TuiApp`. It records every notice and holds a REAL caret. */
function mountedComposer(initial = ''): SubmissionComposerPort & {
  readonly notices: { text: string; kind: 'info' | 'error' | undefined }[]
  caretAt(index: number): void
} {
  let text = initial
  let caret = initial.length
  const notices: { text: string; kind: 'info' | 'error' | undefined }[] = []
  return {
    notices,
    getDraft: () => text,
    setDraft: (next) => { text = next; caret = next.length },
    setEditorText: (next) => { text = next; caret = next.length },
    insertIntoEditor: (value) => {
      text = `${text.slice(0, caret)}${value}${text.slice(caret)}`
      caret += value.length
    },
    notify: (message, kind) => { notices.push({ text: message, kind }) },
    setSubmitPending: () => {},
    clearSettledLocalMessages: () => {},
    caretAt: (index) => { caret = index },
  }
}

interface MountedHarness {
  /** The REAL Client command registry the submission owner executes from. */
  readonly clientCommands: ReturnType<typeof createClientCommandRegistry>
  readonly composer: ReturnType<typeof mountedComposer>
  readonly imageStore: DraftImageStore
  readonly fileStore: DraftFileStore
  readonly notices: { text: string; kind: 'info' | 'error' | undefined }[]
  readonly reads: string[]
  bumpGeneration(): void
  replaceComposer(next: ReturnType<typeof mountedComposer>): void
  setImageLimits(limits: Parameters<typeof checkImageLimits>[2] | undefined): void
  /** Execute one line through the REAL Client registry (the TSP route). */
  execute(line: string): Promise<ClientCommandExecution | undefined>
  /**
   * The READ WITNESS: how many times the intake's own file-read call evaluated
   * its `runner.cwd` argument. Both intake legs pass it as a direct argument of
   * `readImageFile`/`probeAttachment`, so the counter moves exactly when a read
   * is actually attempted — a store/notice assertion cannot see that.
   */
  cwdReads(): number
  /**
   * Resolves when the intake reached its POST-READ session-scope fence. The
   * fence is a real production call issued only after the file read settled,
   * so this is an authoritative "the read finished" signal — needed where the
   * seat is deliberately silent and no notice can be observed.
   */
  postRead(): Promise<void>
}

/**
 * The mounted TSP-shaped composition: a REAL `registerTuiCommands` pass with
 * `app: undefined` (no PiTui surface) and the internal composer presentation
 * seam the production `createCommandSurface` supplies. Commands execute through
 * the SAME Client registry object the submission owner consumes.
 */
function mountedHarness(options: { cwd: string; sessionCwd?: string; composer?: ReturnType<typeof mountedComposer> }): MountedHarness {
  const ctx = new Context()
  const services = fakeCommands()
  ctx.provide('commands', services.commands as never)
  const imageStore = new DraftImageStore()
  const fileStore = new DraftFileStore()
  const notices: { text: string; kind: 'info' | 'error' | undefined }[] = []
  const reads: string[] = []
  const seat: { current: ReturnType<typeof mountedComposer> } = { current: options.composer ?? mountedComposer() }
  let generation = 0
  let limits: Parameters<typeof checkImageLimits>[2] | undefined
  let markPostRead!: () => void
  const postRead = new Promise<void>(resolve => { markPostRead = resolve })
  let cwdReads = 0
  const scopeFacts = sessionScopeFacts(() => undefined, () => generation)
  const runner: TuiCommandRunner = {
    ctx,
    // The TSP renderer mounts no TuiApp: every PiTui-only member is absent.
    app: undefined,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    ...scopeFacts,
    // The recorder wraps the REAL scope authority: the intake's post-read
    // fence still decides exactly as production does, and its occurrence is
    // the deterministic "the file read settled" signal.
    isSessionScopeCurrent: (scope) => {
      markPostRead()
      return scopeFacts.isSessionScopeCurrent(scope)
    },
    currentSessionId: undefined,
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: undefined,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined,
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as import('../../src/commands.ts').CommandRegistryLike | undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostFile: new DirectHostFilePort(() => undefined),
    hostShellCompletion: false,
    transcriptExportAvailable: false,
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
    sessionWriter: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    // A GETTER, not a value: `readImageFile`/`probeAttachment` receive this as a
    // direct call argument, so every access is one real read attempt.
    get cwd() { cwdReads += 1; return options.cwd },
    sessionCwd: () => options.sessionCwd ?? options.cwd,
    fileStore,
    imageStore,
    copyToClipboard: async () => true,
    imageLimits: () => limits,
    // The PiTui-only legacy insertion seam: it must stay UNREACHED on this
    // renderer (its no-op is exactly the bug the composer seam replaces).
    insertIntoEditor: (text) => { reads.push(`legacy-insert:${text}`) },
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    get defaultIntentOutcome() { return undefined },
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {},
    setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, openPluginManager: () => {}, createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
  // The REAL registration pass with the internal presentation seams the
  // production `createCommandSurface` supplies. The fake Host service holds no
  // global-layer commands, so the Direct catalog seam is empty.
  registerTuiCommands(runner, undefined, { listGlobalCommands: () => [] }, undefined, undefined, {
    notify: (text, kind) => { notices.push({ text, kind }) },
    titleRefusalNoticeOwner: 'result-card',
    titleSuccessNoticeVisible: false,
    composer: () => seat.current,
  })
  return {
    clientCommands: runner.clientCommands,
    composer: seat.current,
    imageStore,
    fileStore,
    notices,
    reads,
    bumpGeneration: () => { generation += 1 },
    replaceComposer: (next) => { seat.current = next },
    setImageLimits: (next) => { limits = next },
    execute: line => runner.clientCommands.execute({ line, signal: new AbortController().signal }),
    postRead: () => postRead,
    cwdReads: () => cwdReads,
  }
}

test('a TSP-mounted image command stages bytes and inserts the canonical image token into its composer', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-tsp-image-')
  const file = join(dir, 'shot.png')
  writeFileSync(file, pngBytes())
  const h = mountedHarness({ cwd: dir })

  const execution = await h.execute(`/image ${file}`)
  assert.deepEqual(execution?.result, { kind: 'success' }, 'the real Client registry accepted and ran /image')
  await waitFor(() => h.imageStore.size() === 1)
  const draft = h.imageStore.values()[0]!
  assert.equal(draft.placeholder, '[image #1 (1×1)]')
  assert.equal(draft.source.type, 'path')
  assert.equal(h.composer.getDraft(), `${draft.placeholder} `, 'the canonical token is in the mounted composer')
  // One IO, one success message: the message comes from the composer AFTER the
  // bytes and the token were committed — never from the command result.
  await waitFor(() => h.composer.notices.length === 1)
  assert.deepEqual(h.composer.notices, [{ text: `attached ${draft.placeholder} — Enter to send`, kind: undefined }],
    'exactly one success notice, published by the composer')
  assert.deepEqual(h.notices, [], 'the PiTui command-card notice sink stayed silent on this renderer')
  assert.deepEqual(h.reads, [], 'the PiTui-only insertIntoEditor seam was never used')
})

test('a TSP-mounted attach command stages a regular file into the file store and inserts its canonical token', async (t) => {
  const life = testLifecycle(t)
  const client = life.tempDir('dsh-tsp-attach-client-')
  const session = life.tempDir('dsh-tsp-attach-session-')
  writeFileSync(join(client, 'report.pdf'), Buffer.from('%PDF-1.7 report'))
  const h = mountedHarness({ cwd: client, sessionCwd: session })

  const execution = await h.execute('/attach report.pdf')
  assert.deepEqual(execution?.result, { kind: 'success' })
  await waitFor(() => h.fileStore.values().length === 1)
  const draft = h.fileStore.values()[0]!
  assert.equal(draft.name, 'report.pdf')
  assert.equal(h.imageStore.size(), 0, 'a generic file never enters the image store')
  assert.equal(h.composer.getDraft(), `${draft.placeholder} `, 'the file token is in the mounted composer')
  await waitFor(() => h.composer.notices.length === 1)
  assert.deepEqual(h.composer.notices, [{ text: `attached ${draft.placeholder} — Enter to send`, kind: undefined }])
})

test('a TSP-mounted attach command accepts an image through the same image intake path', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-tsp-attach-image-')
  const file = join(dir, 'photo.png')
  writeFileSync(file, pngBytes())
  const h = mountedHarness({ cwd: dir })

  const execution = await h.execute(`/attach ${file}`)
  assert.deepEqual(execution?.result, { kind: 'success' })
  await waitFor(() => h.imageStore.size() === 1)
  const draft = h.imageStore.values()[0]!
  assert.equal(draft.source.type, 'path')
  assert.equal(h.fileStore.values().length, 0, 'an image never enters the generic file store')
  assert.equal(h.composer.getDraft(), `${draft.placeholder} `, 'the image branch of /attach uses the ONE image intake')
})

test('an absent composer refuses image and attach before any intake, staging or token', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-tsp-no-composer-')
  const png = join(dir, 'shot.png')
  writeFileSync(png, pngBytes())
  writeFileSync(join(dir, 'report.pdf'), Buffer.from('%PDF-1.7 report'))

  // CONTROL: with a composer mounted the very same inputs read AND stage. This
  // proves both that the files are readable and that the read witness below
  // really moves when an intake runs (a witness that can never move would make
  // the refusal assertion vacuous).
  const control = mountedHarness({ cwd: dir })
  const controlReadsBefore = control.cwdReads()
  assert.deepEqual((await control.execute(`/image ${png}`))?.result, { kind: 'success' })
  await waitFor(() => control.imageStore.size() === 1)
  assert.deepEqual((await control.execute('/attach report.pdf'))?.result, { kind: 'success' })
  await waitFor(() => control.fileStore.values().length === 1)
  assert.ok(control.cwdReads() > controlReadsBefore,
    'the read witness moves when a real intake reads the Client cwd')

  const h = mountedHarness({ cwd: dir })
  h.replaceComposer(undefined as never)
  const readsBefore = h.cwdReads()
  for (const line of [`/image ${png}`, '/attach report.pdf']) {
    const execution = await h.clientCommands.execute({ line, signal: new AbortController().signal })
    // `{kind:'error'}` (never `success`) is the discriminating fact: accepting
    // an intake is the ONLY way this handler reads a file.
    assert.equal(execution?.result.kind, 'error', `${line} is refused synchronously without a composer`)
    assert.equal((execution?.result as { text: string }).text, 'the draft composer is unavailable on this renderer')
  }
  // Give any (non-existent) detached task a chance to run before the read
  // witness is trusted: a spawn-then-refuse implementation would read here.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.cwdReads(), readsBefore,
    'the refusal evaluated no read argument: no image read and no attachment probe were attempted')
  assert.equal(h.imageStore.size(), 0)
  assert.equal(h.fileStore.values().length, 0)
  assert.deepEqual(h.reads, [], 'the PiTui-only insertIntoEditor seam was never used')
})

test('a command intake completing after a session generation change never writes the replacement composer', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-tsp-stale-intake-')
  const file = join(dir, 'shot.png')
  writeFileSync(file, pngBytes())
  const h = mountedHarness({ cwd: dir })
  const execution = await h.execute(`/image ${file}`)
  assert.deepEqual(execution?.result, { kind: 'success' }, 'the intent was accepted before the switch')
  // The surface moves on while the async read is in flight: the test resumes
  // from the command settle (a microtask) before the file I/O can complete.
  const replacement = mountedComposer()
  h.replaceComposer(replacement)
  h.bumpGeneration()

  // The CAPTURED seat is no longer the live seat, so it receives NOTHING —
  // not even the explanatory session-fence refusal (a retired renderer's dock
  // is not a place to publish). The control below shows the same fence DOES
  // report when only the session moved and the seat is still live.
  await h.postRead()
  assert.deepEqual(h.composer.notices, [], 'a replaced seat never receives the stale intake notice')
  assert.equal(h.imageStore.size(), 0, 'the stale intake stages no bytes')
  assert.equal(replacement.getDraft(), '', 'no stale token is written into the replacement composer')
  assert.deepEqual(replacement.notices, [], 'no stale notice is published to the replacement composer')
})

test('a session change on the SAME seat still explains the refusal to the user', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-tsp-same-seat-stale-')
  const file = join(dir, 'shot.png')
  writeFileSync(file, pngBytes())
  const h = mountedHarness({ cwd: dir })
  assert.deepEqual((await h.execute(`/image ${file}`))?.result, { kind: 'success' })
  // Only the ownership generation moves: the mounted seat is untouched, so the
  // user must learn why nothing was attached.
  h.bumpGeneration()

  await waitFor(() => h.composer.notices.length === 1)
  assert.deepEqual(h.composer.notices, [{ text: 'the session changed while reading the image — try again', kind: 'error' }],
    'the live seat explains the session fence exactly once')
  assert.equal(h.imageStore.size(), 0)
  assert.equal(h.composer.getDraft(), '')
})

test('an invalid path or rejected image limit leaves both stores and the composer draft unchanged', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-tsp-bad-intake-')
  writeFileSync(join(dir, 'shot.png'), pngBytes())
  const h = mountedHarness({ cwd: dir })
  h.setImageLimits({
    maxImageBytes: 8,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 1024,
    maxImagePixels: 64,
    maxImageDimension: 32,
    mediaTypes: ['image/png'],
  })

  await h.execute(`/image ${join(dir, 'shot.png')}`)
  await waitFor(() => h.composer.notices.length === 1)
  assert.equal(h.composer.notices[0]!.kind, 'error', 'the byte-limit rejection is reported as an error')
  await h.execute('/image /nonexistent/path.png')
  await waitFor(() => h.composer.notices.length === 2)
  assert.equal(h.composer.notices[1]!.kind, 'error')
  assert.equal(h.imageStore.size(), 0, 'neither rejection staged an image')
  assert.equal(h.fileStore.values().length, 0)
  assert.equal(h.composer.getDraft(), '', 'no false placeholder reached the draft')
})

test('an asynchronously staged attachment reports success only after bytes and its token are committed', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-tsp-order-')
  const file = join(dir, 'shot.png')
  writeFileSync(file, pngBytes())
  const h = mountedHarness({ cwd: dir })

  // The result-notice scope is ERROR-ONLY, so the returned
  // `CommandResult.success` announces nothing on the card-less route even
  // though `/image` is a member of that scope.
  assert.ok(TSP_B2A_RESULT_NOTICE_COMMANDS.has('image'),
    'the command keeps its synchronous error visible on the card-less route')
  const execution = await h.execute(`/image ${file}`)
  assert.deepEqual(execution?.result, { kind: 'success' }, 'the synchronous result only accepts the intent')
  assert.deepEqual(h.composer.notices, [], 'the accepted intent alone publishes nothing')
  assert.equal(h.composer.getDraft(), '', 'no token exists before the bytes are staged')

  await waitFor(() => h.imageStore.size() === 1)
  const draft = h.imageStore.values()[0]!
  assert.ok(h.composer.getDraft().includes(draft.placeholder), 'the token exists once the bytes are staged')
  await waitFor(() => h.composer.notices.length === 1)
  assert.equal(h.composer.notices.length, 1, 'exactly one success message, after the commit')
})


// ── The cross-layer source→decision→sink chain ─────────────────────────────

test('the authoritative classifier, the TSP capability gate and the real handler carry one /image line to a staged token', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-tsp-chain-')
  const file = join(dir, 'shot.png')
  writeFileSync(file, pngBytes())
  const h = mountedHarness({ cwd: dir })
  const line = `/image ${file}`
  const parsed = parseCommand(line)
  assert.ok(parsed !== undefined, 'the official parser accepts the line')

  // 1. The LIVE Client registration claims the exact line (the classifier's
  //    ownership source — never a static name list).
  const claims = h.clientCommands.claimsLine(parsed)
  assert.equal(claims, true, 'the registered /image claims its argued line')

  // 2. The authoritative classifier turns those live facts into the winner.
  const classification = classifyCommandLine({
    hostOriginClaim: undefined,
    tuiCommand: claims,
    extensionCommand: false,
    skillInvocation: false,
  })
  assert.deepEqual(classification, { kind: 'client-command', source: 'tui' })

  // 3. The renderer-capability gate ADMITS the winner on the TSP mount.
  assert.deepEqual(tspBuiltinAvailability(classification, parsed.name, {}, parsed.rawInput), { kind: 'available' })

  // 4. The REAL handler runs through the same Client registry ownership uses.
  const execution = await h.clientCommands.execute({ line, signal: new AbortController().signal })
  assert.deepEqual(execution?.result, { kind: 'success' })
  await waitFor(() => h.imageStore.size() === 1)
  const draft = h.imageStore.values()[0]!

  // 5. The canonical placeholder is in the mounted composer and an ordinary
  //    submission preparation consumes exactly that store + token.
  const composerDraft = h.composer.getDraft()
  assert.equal(composerDraft, `${draft.placeholder} `)
  const message = await prepareUserMessage(composerDraft, h.imageStore, {
    attachments: {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 200 * 1024 * 1024,
        maxImagePixels: 64_000_000,
        maxImageDimension: 8192,
        mediaTypes: ['image/png'],
      },
      saveImages: async inputs => inputs.map((input, index) => ({
        attachmentId: `att-${index + 1}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        name: input.name,
      })),
    },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } as never,
    currentModel: () => ({ provider: 'provider', model: 'model' }),
    canonicalizeMentions: async text => text,
  })
  const imageBlocks = message.content.filter(block => block.type === 'image')
  assert.equal(imageBlocks.length, 1, 'the submission preparation consumes exactly the staged image')
  assert.equal((imageBlocks[0] as { attachment: { bytes: number } }).attachment.bytes, 33,
    'the admitted block carries the SAME bytes the clipboard/file intake staged')
  assert.ok(!message.content.some(block => block.type === 'text' && block.text.includes(draft.placeholder)),
    'the canonical token is resolved into the image block, never sent as literal text')
})

// ── The REAL card-less submission route (Remote, no command card) ───────────

/**
 * A REMOTE-shaped controller: `liveAgent()` returns the transport-neutral
 * projection (no `inbox`), which is what makes the TUI-owned route execute
 * through the Client registry — the card-less branch whose ONLY visible
 * owner is the error-result notice scope. The composer is the mounted
 * renderer seat; the command registry is the REAL one the production
 * `registerTuiCommands` pass filled.
 */
function cardlessController(options: {
  readonly composer: ReturnType<typeof mountedComposer>
  readonly clientCommands: ReturnType<typeof createClientCommandRegistry>
  readonly images: DraftImageStore
  readonly files: DraftFileStore
}) {
  const notices: { text: string; kind: 'info' | 'error' | undefined }[] = []
  const modelPrompts: string[] = []
  const core = createSessionOwnershipCore({ isSurfaceDisposed: () => false, resetForGeneration: () => {} })
  core.setCurrentOwner({} as never, 'session-remote')
  const scopeAuthority = createSessionScopeAuthority({
    current: () => {
      const subject = core.subject()
      if (subject === undefined) throw new Error('fixture: the owner is not published')
      return { sessionId: 'session-remote', generation: core.generation(), subject }
    },
    isSubjectCurrent: (subject) => core.isSubjectCurrent(subject),
  })
  const command = {
    wasAdvertisedClaim: () => false,
    hostClaimOf: () => undefined,
    hostOriginClaimOf: () => undefined,
    hostCatalogResolves: () => false,
    clientClaimsLine: (parsed: { name: string; rawInput?: string } | undefined) => options.clientCommands.claimsLine(parsed),
    isSkillWrapperName: () => false,
    isSkillInvocation: () => false,
    withCommandDelivery: <T>(_delivery: unknown, run: () => T): T => run(),
    takeCommandDraftDisposition: () => undefined,
    clientCommands: options.clientCommands,
  }
  const submissionRuntime = bindSubmissionRuntime({
    surface: {
      withWriter: async <T>(_scope: unknown, task: () => Promise<T> | T) => task(),
      withPromptAdmission: async <T>(_line: string, task: () => Promise<T> | T) => task(),
      isDisposed: () => false,
      isScopeCurrent: () => true,
      mergeDraftIntoEditor: (text: string) => { options.composer.setEditorText(mergeDraft(options.composer.getDraft(), text)); return true },
      restoreStaleDraftIntoEditor: () => 'merged-verbatim' as const,
      consumeDraftAttachments: () => {},
      markDispatch: () => {},
      beginLocalSubmission: () => {},
      settleLocalSubmission: () => {},
      settleSubmitAck: () => {},
      notify: (message: string, kind?: 'info' | 'error') => { notices.push({ text: message, kind }) },
      refuseByTransitionFence: () => {},
      prepareMessage: async () => ({ message: {}, attachments: [] }),
      prompt: async (_sessionId: string, message: unknown) => {
        modelPrompts.push(JSON.stringify(message))
        return { kind: 'committed' as const, value: undefined }
      },
    } as never,
  })
  interface AgentLike {
    readonly status: string
    readonly session: { readonly id: string }
    readonly options: Record<string, unknown>
    readonly inbox: Record<string, unknown>
  }
  // Deliberately NO `inbox`-bearing graph at the COMPILE level? The Remote
  // projection carries one structurally-typed object here so the generic
  // constraint is satisfied; the RUNTIME discriminator (`'inbox' in agent`) is
  // what selects the card-less Client-registry branch, so this value must NOT
  // carry an `inbox` property.
  const agent = { status: 'idle', session: { id: 'session-remote' } } as unknown as AgentLike
  const controller = createSubmissionController<AgentLike>({
    app: () => options.composer,
    diag: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, dispose: () => {} },
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
    commandPlane: { available: () => false, execute: async () => undefined, findHandler: () => undefined },
    // REMOTE: the TUI-owned route executes through the Client registry.
    backendKind: 'remote',
    backend: {
      hostFile: { canonicalizeMentions: async (_scope: unknown, text: string) => text } as never,
      pendingInputReader: { snapshot: () => undefined },
      sessionWriter: { prompt: async () => ({ kind: 'committed', value: undefined }) } as never,
      hostCommand: { execute: async () => ({ kind: 'committed', matched: false }) } as never,
    },
    drafts: { images: options.images, files: options.files },
    status: { sessionCwd: () => '/ws' },
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
    supportsLocalShellCards: false,
    // The TSP renderer: no PiTui builtin UI.
    supportsTuiBuiltinUi: false,
    retainsStaleDraftRestore: false,
    model: { selected: { get current() { return undefined } } },
    image: { attachments: () => undefined as never, llm: () => undefined as never },
    tuiSettings: undefined,
    captureMatches: (subject) => core.isSubjectCurrent(subject as never),
    ownerWasReplaced: () => false,
    direct: { withPromptAdmission: async (_agent, _hasImages, task) => task() },
    requestExit: () => {},
    isPlanActive: () => false,
  })
  return { controller, notices, modelPrompts }
}

test('a card-less Remote /image with no argument publishes exactly one Usage error and starts no intake', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-cardless-usage-')
  const png = join(dir, 'shot.png')
  writeFileSync(png, pngBytes())
  const h = mountedHarness({ cwd: dir })
  const { controller, notices, modelPrompts } = cardlessController({
    composer: h.composer,
    clientCommands: h.clientCommands,
    images: h.imageStore,
    files: h.fileStore,
  })

  // The user types the bare command (no path): the handler refuses BEFORE any
  // read, and this route has no command card — the composer notice below is
  // the ONLY place the refusal can become visible.
  controller.submit('/image', 'enter')
  await waitFor(() => h.composer.notices.length === 1)

  assert.deepEqual(h.composer.notices, [{ text: 'Usage: /image <path>', kind: 'error' }],
    'the synchronous refusal is published exactly once on the card-less route')
  assert.equal(h.imageStore.size(), 0, 'no intake was accepted, so nothing was staged')
  // The existing refusal contract hands the line back so the user can fix it;
  // what matters here is that it is still PLAIN TEXT, not a staged token.
  assert.equal(h.composer.getDraft(), '/image', 'the refused line returns to the editor, never a token')
  assert.deepEqual(notices, [], 'no second (submission-level) notice duplicates the refusal')
  assert.deepEqual(modelPrompts, [], 'the line never reached the model as a prompt')
})

test('a card-less Remote /attach with no argument publishes exactly one Usage error and starts no intake', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-cardless-attach-usage-')
  writeFileSync(join(dir, 'report.pdf'), Buffer.from('%PDF-1.7 report'))
  const h = mountedHarness({ cwd: dir })
  const { controller, notices, modelPrompts } = cardlessController({
    composer: h.composer,
    clientCommands: h.clientCommands,
    images: h.imageStore,
    files: h.fileStore,
  })

  controller.submit('/attach', 'enter')
  await waitFor(() => h.composer.notices.length === 1)

  assert.deepEqual(h.composer.notices, [{ text: 'Usage: /attach <path>', kind: 'error' }],
    'the synchronous refusal is published exactly once on the card-less route')
  assert.equal(h.fileStore.values().length, 0)
  assert.equal(h.imageStore.size(), 0)
  assert.equal(h.composer.getDraft(), '/attach', 'the refused line returns to the editor, never a token')
  assert.deepEqual(notices, [], 'no second (submission-level) notice duplicates the refusal')
  assert.deepEqual(modelPrompts, [])
})

test('a card-less Remote /image with a real path reaches the mounted composer through the REAL controller', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-cardless-intake-')
  const png = join(dir, 'shot.png')
  writeFileSync(png, pngBytes())
  const h = mountedHarness({ cwd: dir })
  const { controller, notices, modelPrompts } = cardlessController({
    composer: h.composer,
    clientCommands: h.clientCommands,
    images: h.imageStore,
    files: h.fileStore,
  })

  controller.submit(`/image ${png}`, 'enter')
  await waitFor(() => h.imageStore.size() === 1)
  const draft = h.imageStore.values()[0]!
  await waitFor(() => h.composer.notices.length === 1)

  // The whole chain, through the production consumer: the sync result
  // announces NOTHING (the scope is error-only), the composer publishes the
  // single success AFTER the bytes and the token exist, and the line never
  // becomes a model prompt.
  assert.deepEqual(h.composer.notices, [{ text: `attached ${draft.placeholder} — Enter to send`, kind: undefined }],
    'the ONLY success message is the composer notice published after the commit')
  const composerDraft = h.composer.getDraft()
  assert.equal(composerDraft, `${draft.placeholder} `)
  assert.deepEqual(notices, [], 'the error-only result scope published nothing for a successful intake')
  assert.deepEqual(modelPrompts, [], 'the line never reached the model as a prompt')

  // The SAME chain's sink: the draft and store THIS controller just produced
  // are consumed by the existing submission-preparation pipeline. (The plan's
  // C1 requires one continuous positive chain — this is not a separate case.)
  const message = await prepareUserMessage(composerDraft, h.imageStore, {
    attachments: {
      imageLimits: {
        maxImageBytes: 20 * 1024 * 1024,
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 200 * 1024 * 1024,
        maxImagePixels: 64_000_000,
        maxImageDimension: 8192,
        mediaTypes: ['image/png'],
      },
      saveImages: async inputs => inputs.map((input, index) => ({
        attachmentId: `att-${index + 1}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 1,
        height: 1,
        name: input.name,
      })),
    },
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } as never,
    currentModel: () => ({ provider: 'provider', model: 'model' }),
    canonicalizeMentions: async text => text,
  })
  const imageBlocks = message.content.filter(block => block.type === 'image')
  assert.equal(imageBlocks.length, 1, 'the existing preparation consumes exactly the token the controller produced')
  assert.equal((imageBlocks[0] as { attachment: { bytes: number } }).attachment.bytes, 33,
    'the admitted block carries the SAME bytes the intake staged')
  assert.ok(!message.content.some(block => block.type === 'text' && block.text.includes(draft.placeholder)),
    'the canonical token is resolved into the image block, never sent as literal text')
})
