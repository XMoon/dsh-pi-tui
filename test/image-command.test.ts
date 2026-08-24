/**
 * Headless tests for the /image command end to end (plan M2): the handler
 * is sessionless, stages into the shared store, and prunes drafts deleted
 * while the async intake was in flight (review finding 2 follow-up).
 * @module @xmoon76/dsh-pi-tui/image-command.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { consumeDraftImages, pruneUnreferencedDrafts } from '../src/image/submit.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

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

function setup(): {
  app: TuiApp
  runner: TuiCommandRunner
  imageStore: DraftImageStore
  imageHandler: (invocation: { rawInput: string }) => unknown
} {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const ctx = new Context()
  const services = fakeCommands()
  ctx.provide('commands', services.commands as never)
  const store = new DraftImageStore()
  const runner: TuiCommandRunner = {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: undefined,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => [],
      titles: async () => new Map(),
      measureContext: () => undefined,
      readExportData: async () => ({ kind: 'none' }),
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
    hostFile: new DirectHostFilePort(() => undefined),
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: store,
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: (text) => app.insertIntoEditor(text),
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 1 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'locked' }),
    refreshStatus: () => {},
    focusEnabled: () => false,
    setFocusMode: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
  registerTuiCommands(runner)
  const image = services.defs.find(def => def.name === 'image')
  assert.ok(image !== undefined, '/image registered')
  return { app, runner, imageStore: store, imageHandler: image.handler as (p: { rawInput: string }) => unknown }
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

test('/image stages the file into the draft store and inserts its placeholder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-image-command-'))
  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('/image prunes drafts whose placeholder left the editor while the intake was in flight', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-image-command-'))
  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('failed submission restores BEFORE unpinning: placeholders keep their backing draft through concurrent attaches (review finding)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-image-race-'))
  try {
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
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The restore half of the failure path (restoreSubmissionDraft semantics). */
function restoreIntoEditor(app: TuiApp, draft: string): void {
  app.setEditorText([app.getDraft(), draft].filter(part => part.trim() !== '').join('\n\n') || draft)
}

test('orchestration: a real submit flow restores BEFORE unpin and survives a concurrent /image prune', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-image-orch-'))
  try {
    const file2 = join(dir, 'second.png')
    writeFileSync(file2, pngBytes())
    const { app, imageStore, imageHandler } = setup()
    const { runReservedSubmit } = await import('../src/image/submit-flow.ts')
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
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('command fallback SUCCESS: the handoff pin transfers and releases exactly once', async () => {
  const { app, imageStore } = setup()
  const { runReservedSubmit } = await import('../src/image/submit-flow.ts')
  const draft = imageStore.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1 })
  const text = `look at ${draft.placeholder}`
  // The handoff pin is acquired synchronously BEFORE commands.execute()
  // launches (the outer submission pin releases when its task returns).
  const handoff = imageStore.pinReferenced(text)
  // The nested flow TRANSFERS that reservation — a second pin here would
  // leak the handoff forever (review finding).
  await runReservedSubmit({
    reserve: () => handoff,
    run: async () => { consumeDraftImages(text, imageStore) },
    restore: () => {},
  }, text)
  assert.equal(imageStore.isPinned(draft.id), false, 'the handoff pin is released after the nested submit')
  assert.equal(imageStore.get(draft.id), undefined, 'the consumed draft is gone')
})

test('command fallback FAILURE: restore keeps the draft; the pin releases; prune can collect it after the placeholder leaves', async () => {
  const { app, imageStore } = setup()
  const { runReservedSubmit } = await import('../src/image/submit-flow.ts')
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
  pruneUnreferencedDrafts('', imageStore)
  assert.equal(imageStore.get(draft.id), undefined, 'the released draft is prunable after the placeholder leaves')
})
