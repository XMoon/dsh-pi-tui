/**
 * Image UX PR1 integration tests: the ONE-card composer draft preview inside
 * a REAL headless TuiApp (Owner revision 2026-10-23). The tests drive the
 * production draft path (store + canonical placeholders), the expanded-draft
 * projection and the fullscreen last-painted `x` gesture.
 * @module @xmoon76/dsh-pi-tui/draft-image-preview-tui.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { resetCapabilitiesCache, setCapabilities } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { consumeDraftAttachments, pruneUnreferencedDraftAttachments } from '../../src/client/media/draft-attachments.ts'
import { expandImagePlaceholders, selectDraftImageOccurrences } from '../../src/client/media/image/placeholder.ts'
import { preparePrompt } from '../../src/app/submission/prepared-prompt.ts'
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

/** The bridge probe: every acquire/release of the scoped pre-clear
 *  reservation is counted, so a leaked or missing bridge is observable. */
interface BridgeProbe {
  acquired: number
  released: number
  active: number
}

interface Harness {
  vt: VirtualTerminal
  app: TuiApp
  bridge: BridgeProbe
  /** The business reservations the simulated submission owner took during the
   *  synchronous onSubmit dispatch (the real controller's runReservedSubmit
   *  does this before its first await). */
  businessPins: (() => void)[]
}

function startApp(
  columns: number,
  rows: number,
  store: DraftImageStore,
  onSubmit: (text: string, harness: Omit<Harness, 'vt' | 'app'>) => void = () => {},
  onSteer: (text: string, harness: Omit<Harness, 'vt' | 'app'>) => void = () => {},
): Harness {
  const vt = new VirtualTerminal(columns, rows)
  const bridge: BridgeProbe = { acquired: 0, released: 0, active: 0 }
  const businessPins: (() => void)[] = []
  const probe = { bridge, businessPins }
  const app = new TuiApp(vt, {
    // The production controller classifies/validates the line synchronously
    // and takes its own attachment reservation inside this dispatch; the
    // fixture callback stands in for that business takeover.
    onSubmit: (text) => { onSubmit(text, probe) },
    onSteer: (text) => { onSteer(text, probe) },
    onExit: () => {},
  }, {
    draftImagePreviewSource: { values: () => store.values() },
    draftImagePreviewLiveDraft: read => store.setLiveDraftTextSource(read),
    draftImagePreviewReserve: (text) => {
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
  return { vt, app, ...probe }
}

function addImage(store: DraftImageStore) {
  return store.add({
    bytes: pngBytes(),
    mediaType: 'image/png',
    width: 800,
    height: 100,
    name: 'shot.png',
  })
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

/** The 1-based row of the first line containing the needle. */
async function rowOf(vt: VirtualTerminal, needle: string, label: string): Promise<number> {
  const view = await viewport(vt)
  const index = view.split('\n').findIndex(line => line.includes(needle))
  assert.ok(index !== -1, `${label}: ${JSON.stringify(needle)} missing:\n${view}`)
  return index + 1
}

function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

const pasted = Array.from({ length: 12 }, (_, index) => `real line ${index + 1}`).join('\n')

function pasteLarge(vt: VirtualTerminal, extra = ''): void {
  vt.sendInput(`\x1b[200~${pasted}${extra === '' ? '' : `\n${extra}`}\x1b[201~`)
}

test('the preview renders above the editor and follows the canonical placeholder', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft(`${image.placeholder} compare`)
  const view = await viewport(vt)
  assert.ok(view.includes('🖼️ #1/1 · 800×100 · 33 B'), `preview identity missing:\n${view}`)
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  const draftRow = await rowOf(vt, 'compare', 'editor draft')
  assert.ok(labelRow < draftRow, `preview must sit above the editor (${labelRow} < ${draftRow})`)
  app.setDraft('no image here')
  await vt.waitForRender()
  assert.ok(!(await viewport(vt)).includes('#1/1 · 800×100'), 'removing the token hides the preview')
  app.stop()
})

const storedUndoKey = '\x1b[45;5u'


test('fullscreen x removes the previewed occurrence and retains the draft for undo', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft(`${image.placeholder} hello`)
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'hello', 'the token and one adjacent separator are removed')
  assert.equal(store.size(), 1, 'the removed draft is retained for the editor undo-safe window')
  assert.ok(store.get(image.id) !== undefined, 'the retained draft still resolves')
  app.setFullscreen(false)
  app.stop()
})


test('undo after x restores a live image and the prepared prompt carries it', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'hello', 'the x edit removes the token')
  assert.equal(store.size(), 1, 'the removed draft is retained for undo')
  assert.ok(store.get(image.id) !== undefined, 'the retained draft still resolves')

  // The real tui.editor.undo keybinding: Ctrl+- (CSI-u, not Ctrl+Z).
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  const draft = app.getDraft()
  assert.ok(draft.includes(image.placeholder), `undo must restore the canonical placeholder: ${draft}`)
  assert.ok(expandImagePlaceholders(draft, store).some(segment => segment.type === 'image' && segment.image.id === image.id), 'the restored placeholder resolves to the retained image')
  const prepared = preparePrompt('session-undo', draft, { images: store })
  assert.ok(prepared.segments.some(segment => segment.type === 'image'), 'PreparedPrompt carries the restored image')
  assert.ok((await viewport(vt)).includes('#1/1 · 800×100'), 'the preview returns after undo')

  // Consecutive undo must not leave a token that no longer resolves either.
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  const afterSecondUndo = app.getDraft()
  assert.ok(
    expandImagePlaceholders(afterSecondUndo, store).every(segment => segment.type === 'image' || !segment.text.includes('[image #')),
    `repeated undo cannot leave a dead placeholder: ${afterSecondUndo}`,
  )
  assert.equal(store.size(), 1, 'the retained draft stays live for the session undo window')
  app.setFullscreen(false)
  app.stop()
})


test('undo after x on a duplicate occurrence restores both live placeholders', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(`${image.placeholder} + ${image.placeholder}`)
  vt.sendInput(' tail')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, `#${image.id}/2 · 800×100`, 'last duplicate identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  assert.ok(app.getDraft().includes(image.placeholder), 'the first occurrence remains after the x')
  assert.equal(store.size(), 1, 'the single shared draft is retained')
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  const draft = app.getDraft()
  assert.equal(selectDraftImageOccurrences(draft, store).length, 2, 'undo restores both duplicate occurrences')
  const prepared = preparePrompt('session-duplicate-undo', draft, { images: store })
  assert.equal(prepared.segments.filter(segment => segment.type === 'image').length, 2, 'PreparedPrompt carries both occurrences')
  app.setFullscreen(false)
  app.stop()
})


test('undo after x with a hidden paste marker keeps the paste content and a live hidden image', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const hidden = addImage(store)
  const visible = addImage(store)
  pasteLarge(vt, hidden.placeholder)
  await vt.waitForRender()
  app.insertIntoEditor(visible.placeholder)
  vt.sendInput(' tail')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, `#${visible.id}/2 · 800×100`, 'visible last identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  assert.equal(store.size(), 2, 'hidden draft + retained visible draft')
  assert.ok(store.get(hidden.id) !== undefined)
  assert.ok(store.get(visible.id) !== undefined, 'the removed visible draft is retained')
  const afterX = app.getDraft()
  assert.ok(afterX.includes('real line 12'), `the paste content survives the x: ${afterX}`)
  assert.ok(!afterX.includes('[paste #'), 'the x edit must not orphan the paste marker')

  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  const draft = app.getDraft()
  assert.ok(draft.includes('real line 12'), `the paste content survives the undo: ${draft}`)
  assert.ok(!draft.includes('[paste #'), 'the undo restores the paste registry, not orphan text')
  assert.equal(selectDraftImageOccurrences(draft, store).length, 2, 'the hidden occurrence and the visible undo both resolve')
  const prepared = preparePrompt('session-hidden-undo', draft, { images: store })
  assert.equal(prepared.segments.filter(segment => segment.type === 'image').length, 2, 'PreparedPrompt carries the hidden and restored visible images')
  app.setFullscreen(false)
  app.stop()
})


test('a removed draft survives the session switch and dies with the undo history at Enter', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app, bridge } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  assert.equal(store.size(), 1)

  pruneUnreferencedDraftAttachments('hello', store)
  assert.equal(store.size(), 1, 'the undo lease survives the attach/submit-time prune')

  // A session switch does NOT retire the host editor undo stack (clearHistory
  // is prompt recall only), so the lease must survive it; otherwise the undo
  // below would restore a dead token.
  app.clearSessionOverrides()
  app.beginInputHistoryScope('new-session')
  app.resetInputHistory([], 'new-session')
  store.clearUnpinned()
  assert.equal(store.size(), 1, 'the session switch keeps the undo-leased draft')
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  const sessionUndoDraft = app.getDraft()
  assert.ok(sessionUndoDraft.includes(image.placeholder), 'undo after the session switch still restores the placeholder')
  assert.ok(expandImagePlaceholders(sessionUndoDraft, store).some(segment => segment.type === 'image' && segment.image.id === image.id), 'the post-session undo resolves to the retained image')
  const prepared = preparePrompt('session-switch-undo', sessionUndoDraft, { images: store })
  assert.ok(prepared.segments.some(segment => segment.type === 'image'), 'PreparedPrompt carries the post-session image')
  assert.equal(store.size(), 1)

  // Enter retires the REAL undo history. The scoped bridge exists only for the
  // synchronous dispatch and has ended; no backend outcome is involved.
  assert.equal(bridge.active, 0, 'fixture check: no stale bridge before the submit')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(bridge.active, 0, 'the scoped bridge ends with the synchronous dispatch')
  assert.equal(bridge.acquired, bridge.released, 'every acquired bridge is released exactly once')
  pruneUnreferencedDraftAttachments('', store)
  assert.equal(store.size(), 0, 'Enter retired the only history that could restore the image')
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(!app.getDraft().includes(image.placeholder), 'undo cannot resurrect a dead token')
  app.setFullscreen(false)
  app.stop()
})


test('two consecutive x/undo cycles keep the retained draft live', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const firstRow = await rowOf(vt, '#1/1 · 800×100', 'first preview identity')
  click(vt, 100, firstRow)
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'hello')
  assert.equal(store.size(), 1)
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(app.getDraft().includes(image.placeholder))
  const secondRow = await rowOf(vt, '#1/1 · 800×100', 'returned preview identity')
  click(vt, 100, secondRow)
  await vt.waitForRender()
  const draft = app.getDraft()
  assert.ok(!draft.includes(image.placeholder), 'the second x removes the restored token')
  assert.equal(store.size(), 1, 'the removed draft stays retained')
  assert.ok(
    expandImagePlaceholders(draft, store).every(segment => segment.type === 'image' || !segment.text.includes('[image #')),
    'the second x leaves no dead placeholder text',
  )
  app.setFullscreen(false)
  app.stop()
})


test('a synchronous rejection restore keeps the removed draft live through the next prune', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = addImage(store)
  let app!: TuiApp
  const started = startApp(100, 32, store, () => {
    // The documented synchronous rejection restore: put the submitted draft
    // back inside the submit event dispatch.
    app.setDraft(image.placeholder)
  })
  app = started.app
  const { vt } = started
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(app.getDraft().includes(image.placeholder))

  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(app.getDraft().includes(image.placeholder), 'the synchronous restore keeps the placeholder in the editor')
  assert.equal(started.bridge.active, 0, 'the fork finally released the bridge despite the restore')
  assert.equal(store.size(), 1)
  // The restored draft is LIVE: an attach-time prune resolves it and keeps it.
  const draft = app.getDraft()
  pruneUnreferencedDraftAttachments(draft, store)
  assert.equal(store.size(), 1, 'the live restored placeholder survives the next attach prune')
  assert.ok(expandImagePlaceholders(draft, store).some(segment => segment.type === 'image' && segment.image.id === image.id))
  const prepared = preparePrompt('session-sync-rejection', draft, { images: store })
  assert.ok(prepared.segments.some(segment => segment.type === 'image'), 'PreparedPrompt carries the restored image')

  // The REAL committed-switch order: the outgoing active draft is dropped
  // first, then the unpinned per-session drafts. Dropping the draft pushes the
  // real history snapshot that contains the image, so the lease correctly
  // survives the switch and Undo still restores a REAL image.
  app.setDraft('')
  app.clearSessionOverrides()
  app.beginInputHistoryScope('new-session')
  app.resetInputHistory([], 'new-session')
  store.clearUnpinned()
  assert.equal(store.size(), 1, 'the switch keeps the undo-referenced image')
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  const switchedBack = app.getDraft()
  assert.ok(expandImagePlaceholders(switchedBack, store).some(segment => segment.type === 'image' && segment.image.id === image.id),
    'Undo after the switch restores a real image, never a dead token')
  app.setFullscreen(false)
  app.stop()
})


test('an async rejection restore survives the bridge release on the business pin alone', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app, bridge, businessPins } = startApp(100, 32, store, (text, probe) => {
    // The production controller's runReservedSubmit takes this reservation
    // inside the synchronous dispatch, before its first await.
    probe.businessPins.push(store.pinReferenced(text))
  })
  const image = addImage(store)
  // Type AFTER inserting the token so a real Undo snapshot can restore it.
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(app.getDraft().includes(image.placeholder))
  assert.ok(store.get(image.id) !== undefined)

  // Enter: the clear retires the undo history (so the undo lease ends), but
  // the business reservation taken inside the dispatch owns the bytes.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.getDraft(), '')
  assert.equal(bridge.active, 0, 'the bridge ended with the dispatch')
  assert.equal(businessPins.length, 1)
  assert.equal(store.size(), 1)
  pruneUnreferencedDraftAttachments('', store)
  assert.equal(store.size(), 1, 'the business submission pin keeps the bytes while the write is in flight')

  // The documented async rejection restores the draft FIRST, then the business
  // pin releases. The restored live placeholder resolves throughout.
  app.setDraft(image.placeholder)
  businessPins.pop()?.()
  pruneUnreferencedDraftAttachments(app.getDraft(), store)
  assert.equal(store.size(), 1, 'the restored live placeholder keeps its bytes after the release')
  const draft = app.getDraft()
  const prepared = preparePrompt('session-async-rejection', draft, { images: store })
  assert.ok(prepared.segments.some(segment => segment.type === 'image'), 'PreparedPrompt carries the async-restored image')

  // Drop the outgoing draft first (the committed-switch order), then the
  // per-session drafts: the drop pushes the snapshot that keeps the image
  // undoable, so the lease survives and Undo restores REAL bytes.
  app.setDraft('')
  app.clearSessionOverrides()
  app.beginInputHistoryScope('new-session')
  app.resetInputHistory([], 'new-session')
  store.clearUnpinned()
  assert.equal(store.size(), 1, 'the restored placeholder survives the session switch')
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(expandImagePlaceholders(app.getDraft(), store).some(segment => segment.type === 'image' && segment.image.id === image.id))
  app.setFullscreen(false)
  app.stop()
})


test('100 x/Undo cycles keep ONE (owner,image) undo lease', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  for (let cycle = 0; cycle < 100; cycle += 1) {
    const row = await rowOf(vt, '#1/1 · 800×100', `cycle ${cycle} identity`)
    click(vt, 100, row)
    await vt.waitForRender()
    vt.sendInput(storedUndoKey)
    await vt.waitForRender()
    // A fresh edit AFTER the undo pushes a snapshot that contains the token
    // again, so every cycle keeps the image genuinely restorable.
    vt.sendInput('z')
    await vt.waitForRender()
  }
  assert.ok(app.getDraft().includes(image.placeholder), 'the token is live after every cycle')
  const owners = (store as unknown as {
    undoOwners: Map<object, { ids: Set<number> }>
  }).undoOwners
  assert.equal(owners.size, 1, 'one stable owner')
  assert.deepEqual([...owners.values()][0]!.ids, new Set([image.id]),
    'exactly one lease for the (owner, image) pair after 100 cycles')
  app.setFullscreen(false)
  app.stop()
})


test("an earlier submission's end cannot release a newer draft's Undo lease", async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app, bridge, businessPins } = startApp(100, 32, store, (text, probe) => {
    probe.businessPins.push(store.pinReferenced(text))
  })
  const image = addImage(store)

  // A: a plain-text submission in flight (its clear already retired the old
  // undo history; only its business pin remains).
  vt.sendInput('first line')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(bridge.active, 0)
  assert.equal(businessPins.length, 1)

  // B: a newer draft removes an image by preview x and keeps its Undo history.
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' second')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(app.getDraft().includes(image.placeholder))

  // A ends (accepted or rejected — the Undo lease does not care). Its business
  // pin release must not touch B's editor-history lease.
  businessPins.pop()?.()
  pruneUnreferencedDraftAttachments(app.getDraft(), store)
  assert.equal(store.size(), 1, "A's end keeps B's live image")
  const restored = app.getDraft()
  assert.ok(expandImagePlaceholders(restored, store).some(segment => segment.type === 'image' && segment.image.id === image.id))
  app.setFullscreen(false)
  app.stop()
})


test('a hidden paste occurrence counts as LIVE and is never eviction-eligible', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.getDraft(), '')

  // The raw editor text is only a paste marker; the EXPANDED draft still has
  // a live occurrence. The live-draft authority is the expanded text, so the
  // image must count as ACTIVE (not retention-only) and stay out of eviction.
  pasteLarge(vt, image.placeholder)
  await vt.waitForRender()
  assert.equal(store.undoRetainedCount(), 0, 'the hidden occurrence is a live attachment')
  pruneUnreferencedDraftAttachments(app.getDraft(), store)
  assert.equal(store.size(), 1)
  const draft = app.getDraft()
  assert.ok(expandImagePlaceholders(draft, store).some(segment => segment.type === 'image' && segment.image.id === image.id))
  const prepared = preparePrompt('hidden-live', draft, { images: store })
  assert.ok(prepared.segments.some(segment => segment.type === 'image'), 'PreparedPrompt carries the hidden image')
  app.setFullscreen(false)
  app.stop()
})


test('after Enter retired the history, a newly pasted hidden token is live, then undo-referenced once edited', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  pruneUnreferencedDraftAttachments('', store)
  assert.equal(store.size(), 0, 'Enter retired the history and dropped the bytes')

  // Re-stage the same bytes under the same placeholder id, then paste a block
  // that hides the canonical token. The next edit pushes a snapshot whose
  // paste registry holds it: the image is now undo-restorable again.
  const again = addImage(store)
  assert.notEqual(again.id, image.id)
  pasteLarge(vt, again.placeholder)
  vt.sendInput('y')
  await vt.waitForRender()
  const owners = (store as unknown as { undoOwners: Map<object, { ids: Set<number> }> }).undoOwners
  assert.deepEqual([...owners.values()][0]!.ids, new Set([again.id]), 'the paste-body token is undo-referenced')
  assert.equal(store.undoRetainedCount(), 0, 'it is live, so it is ACTIVE not retention')
  app.setFullscreen(false)
  app.stop()
})


test('the retention eviction retires old undo snapshots and keeps the recent undo live', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore(16, 64 * 1024 * 1024, 1, 32 * 1024 * 1024)
  const { vt, app } = startApp(100, 32, store)
  const first = addImage(store)
  const second = addImage(store)
  app.setDraft(`${first.placeholder} ${second.placeholder}`)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()

  const secondRow = await rowOf(vt, '#2/2 · 800×100', 'preview identity')
  click(vt, 100, secondRow)
  await vt.waitForRender()
  assert.equal(app.getDraft(), `${first.placeholder} hello`)

  const firstRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, firstRow)
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'hello')
  assert.ok(store.get(first.id) !== undefined, 'the recent retention survives')
  assert.equal(store.get(second.id), undefined, 'the oldest retention was evicted')

  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  const undone = app.getDraft()
  assert.ok(undone.includes(first.placeholder), 'undo restores the recent retained image')
  assert.ok(!undone.includes(second.placeholder), 'the evicted image cannot return from an old undo snapshot')
  app.setFullscreen(false)
  app.stop()
})


test('an Undo-restored image counts as ACTIVE, not as retention-only', () => {
  const store = new DraftImageStore()
  const owner = {}
  const restored = addImage(store)
  let live = ''
  store.setLiveDraftTextSource(() => live)
  store.registerUndoOwner(owner, () => {})
  store.reconcileUndoOwner(owner, new Set([restored.placeholder]))
  assert.equal(store.activeSize(), 0, 'a removed image is retention-only while the draft omits it')
  assert.equal(store.undoRetainedCount(), 1)
  live = restored.placeholder
  store.reconcileUndoOwner(owner, new Set([restored.placeholder]))
  assert.equal(store.activeSize(), 1, 'Undo put the image back into the live draft')
  assert.equal(store.undoRetainedCount(), 0, 'a live image no longer occupies the retention budget')
  for (let index = 0; index < 15; index += 1) addImage(store)
  assert.equal(store.activeSize(), 16)
  assert.throws(() => addImage(store), /Too many staged images/, 'the restored image still consumes an active slot')
})


test('the retention budget re-converges once the removed occurrence leaves the draft', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore(16, 64 * 1024 * 1024, 1, 32 * 1024 * 1024)
  const { vt, app } = startApp(100, 32, store)
  const first = addImage(store)
  const second = addImage(store)
  app.setDraft(`${first.placeholder} ${second.placeholder}`)
  // A real edit pushes the undo snapshot that makes both images restorable.
  vt.sendInput('!')
  app.setFullscreen(true)
  await vt.waitForRender()

  // Remove the LAST image while the first is still live: the pin cannot be
  // retired yet, and the budget is not exceeded.
  const lastRow = await rowOf(vt, '#2/2 · 800×100', 'preview identity')
  click(vt, 100, lastRow)
  await vt.waitForRender()
  assert.equal(store.undoRetainedCount(), 1)

  // Removing the remaining image makes BOTH retention-only; the post-removal
  // reconciliation must retire the oldest one instead of leaving the budget
  // over its one-image limit.
  const firstRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, firstRow)
  await vt.waitForRender()
  assert.equal(store.undoRetainedCount(), 1, 'the budget is back within its limit after the draft changed')
  assert.ok(store.get(first.id) !== undefined, 'the newest retention survives')
  assert.equal(store.get(second.id), undefined, 'the oldest retention was evicted')
  app.setFullscreen(false)
  app.stop()
})


test('the bounded undo retention frees the active cap and retires the oldest', () => {
  const store = new DraftImageStore()
  store.setLiveDraftTextSource(() => '')
  const images = Array.from({ length: 16 }, () => addImage(store))
  const retired: string[] = []
  const owner = {}
  store.registerUndoOwner(owner, placeholder => { retired.push(placeholder) })
  store.reconcileUndoOwner(owner, new Set(images.map(image => image.placeholder)))
  assert.equal(store.undoRetainedCount(), 8, 'the retention budget stays at eight images')
  assert.equal(retired.length, 8, 'the oldest eight retention entries are retired')
  assert.equal(store.size(), 8)
  const added = addImage(store)
  assert.equal(store.activeSize(), 1, 'retained-but-removed drafts no longer consume the active cap')
  assert.ok(store.get(added.id) !== undefined, 'a new image can be staged after sixteen removals')
  for (const [index, image] of images.entries()) {
    assert.equal(store.get(image.id) !== undefined, index >= 8, 'only the recent retention survives')
  }
})


test('the accelerated submit retires the undo history and frees the bytes', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app, bridge } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(app.getDraft().includes(image.placeholder))

  app.submitDraft('accelerated')
  await vt.waitForRender()
  assert.equal(app.getDraft(), '', 'the accelerated submit cleared the draft')
  assert.equal(bridge.acquired, bridge.released, 'the scoped bridge was released exactly once')
  assert.equal(bridge.active, 0)
  assert.equal(store.size(), 1, 'no prune ran during the submit')
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(!app.getDraft().includes(image.placeholder), 'the accelerated submit retired the undo history')
  pruneUnreferencedDraftAttachments('', store)
  assert.equal(store.size(), 0, 'nothing can restore the image any more')
  app.setFullscreen(false)
  app.stop()
})


test('a replacement editor without the undo-retirement seam keeps the preview display-only', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  addImage(store)
  const holder = (app as unknown as {
    editorSeatHolder: { currentEditor(): unknown }
  }).editorSeatHolder
  const original = holder.currentEditor() as Record<string, unknown>
  holder.currentEditor = () => ({
    ...original,
    id: 'plugin',
    retireDraftImageFromUndo: undefined,
    clearDraftAfterSubmit: undefined,
  })
  app.setFullscreen(true)
  await vt.waitForRender()
  const image = store.values()[0]!
  app.setDraft(image.placeholder)
  await vt.waitForRender()
  const view = await viewport(vt)
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  const row = stripAnsi(view.split('\n')[labelRow - 1]!)
  assert.ok(!/\sx\s*$/.test(row), `a replacement editor must not offer the unsafe x: ${JSON.stringify(row)}`)
  app.setFullscreen(false)
  app.stop()
})


test('a replacement-seat submit keeps the host undo lease until the host seat is restored', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(app.getDraft().includes(image.placeholder))

  const holder = (app as unknown as {
    editorSeatHolder: { currentEditor(): unknown }
  }).editorSeatHolder
  const hostSeat = holder.currentEditor() as Record<string, unknown>
  holder.currentEditor = () => ({
    ...hostSeat,
    id: 'plugin',
    clearDraftAfterSubmit: undefined,
    retireDraftImageFromUndo: undefined,
  })

  app.submitDraft('accelerated')
  await vt.waitForRender()
  assert.equal(app.getDraft(), '', 'the fallback clear still empties the draft')
  assert.equal(store.size(), 1)
  // setText('') PUSHES an undo snapshot (it is not an undo-retiring clear), so
  // the host history still contains the image and its lease must stay.
  pruneUnreferencedDraftAttachments('', store)
  const owners = (store as unknown as { undoOwners: Map<object, { ids: Set<number> }> }).undoOwners
  assert.deepEqual([...owners.values()][0]!.ids, new Set([image.id]),
    'the non-undo-retiring seat cannot retire the host lease')

  holder.currentEditor = () => hostSeat
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  const restored = app.getDraft()
  assert.ok(restored.includes(image.placeholder), 'the handoff-back undo restores the placeholder')
  assert.ok(store.get(image.id) !== undefined, 'the restored placeholder still has real bytes')
  assert.ok(expandImagePlaceholders(restored, store).some(segment => segment.type === 'image' && segment.image.id === image.id))
  app.setFullscreen(false)
  app.stop()
})


test('overlapping submissions: ending an earlier one leaves the newer draft Undo lease intact', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app, businessPins } = startApp(100, 32, store, (text, probe) => {
    probe.businessPins.push(store.pinReferenced(text))
  })
  const image = addImage(store)

  // S1: a plain text submission in flight.
  vt.sendInput('first line')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()

  // S2 draft: image removed by x, restored through Undo.
  app.insertIntoEditor(image.placeholder)
  await vt.waitForRender()
  vt.sendInput(' second')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(app.getDraft().includes(image.placeholder))
  vt.sendInput('\r')
  await vt.waitForRender()

  // S1 ends FIRST. S2's business pin is still in flight; the editor-history
  // lease of the restored image must survive S1's end.
  businessPins[0]!()
  pruneUnreferencedDraftAttachments('', store)
  assert.equal(store.size(), 1, "S1's end cannot release S2's lease")

  // S2 is then rejected and restores its draft: the marker must still exist.
  app.setDraft(`${image.placeholder} second`)
  await vt.waitForRender()
  const restored = app.getDraft()
  assert.ok(restored.includes(image.placeholder))
  assert.ok(expandImagePlaceholders(restored, store).some(segment => segment.type === 'image' && segment.image.id === image.id))

  businessPins.pop()?.()
  const draft = app.getDraft()
  pruneUnreferencedDraftAttachments(draft, store)
  assert.equal(store.size(), 1, 'the live restored placeholder keeps its bytes')
  const prepared = preparePrompt('overlap', draft, { images: store })
  assert.ok(prepared.segments.some(segment => segment.type === 'image'), 'PreparedPrompt carries the overlapping image')

  // The real committed-switch order drops the outgoing draft first; that drop
  // pushes the snapshot containing the image, so the undo lease survives.
  app.setDraft('')
  app.clearSessionOverrides()
  app.beginInputHistoryScope('new-session')
  app.resetInputHistory([], 'new-session')
  store.clearUnpinned()
  assert.equal(store.size(), 1, 'the switch keeps the undo-referenced image')
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(expandImagePlaceholders(app.getDraft(), store).some(segment => segment.type === 'image' && segment.image.id === image.id))
  app.setFullscreen(false)
  app.stop()
})


test('two overlapping submissions each release their own business pin', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app, businessPins } = startApp(100, 32, store, (text, probe) => {
    probe.businessPins.push(store.pinReferenced(text))
  })
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()

  vt.sendInput('first line')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('second line')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(businessPins.length, 2, 'each gesture took its own synchronous pin')
  assert.equal(store.size(), 1, 'the live image is referenced by the second submit')
  businessPins[0]!()
  assert.equal(store.size(), 1, 'the first release does not touch the second pin')
  businessPins[1]!()
  pruneUnreferencedDraftAttachments('', store)
  assert.equal(store.size(), 0, 'after both business reservations end the image is prunable')
  app.setFullscreen(false)
  app.stop()
})


test('Enter pins all nine Undo-referenced images before the clear; the sink receives nine segments', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const images = Array.from({ length: 9 }, () => addImage(store))
  let sink: ReturnType<typeof preparePrompt> | undefined
  const { vt, app, bridge, businessPins } = startApp(100, 32, store, (text, probe) => {
    probe.businessPins.push(store.pinReferenced(text))
    sink = preparePrompt('session-nine', text, { images: store })
  })
  const draft = images.map(image => image.placeholder).join(' ')
  app.setDraft(draft)
  await vt.waitForRender()
  // A real edit pushes the snapshot that makes all nine genuinely undoable.
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(store.undoRetainedCount(), 0, 'live images are active, not retention')
  assert.equal((store as unknown as { undoOwners: Map<object, { ids: Set<number> }> }).undoOwners.size, 1)

  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(bridge.active, 0, 'the bridge ended with the synchronous dispatch')
  assert.equal(bridge.acquired, 1)
  assert.equal(businessPins.length, 1, 'the business owner took over inside the dispatch')
  assert.equal(store.size(), 9, 'no submitted image was evicted by the clear-triggered reconcile')
  assert.equal(sink!.segments.filter(segment => segment.type === 'image').length, 9, 'the sink received nine real image segments')
  businessPins.pop()?.()
  pruneUnreferencedDraftAttachments('', store)
  assert.equal(store.size(), 0)
  app.stop()
})


test('accelerated submit reserves all nine images before the clear too', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const images = Array.from({ length: 9 }, () => addImage(store))
  let sink: ReturnType<typeof preparePrompt> | undefined
  const { vt, app, bridge, businessPins } = startApp(100, 32, store, (text, probe) => {
    probe.businessPins.push(store.pinReferenced(text))
    sink = preparePrompt('session-nine-accelerated', text, { images: store })
  })
  const draft = images.map(image => image.placeholder).join(' ')
  app.setDraft(draft)
  vt.sendInput('!')
  await vt.waitForRender()
  app.submitDraft('accelerated')
  await vt.waitForRender()
  assert.equal(bridge.active, 0)
  assert.equal(bridge.acquired, 1)
  assert.equal(businessPins.length, 1)
  assert.equal(store.size(), 9, 'accelerated submit reserved every image before clearing')
  assert.equal(sink!.segments.filter(segment => segment.type === 'image').length, 9)
  businessPins.pop()?.()
  app.stop()
})


test('a throwing synchronous submit releases the scoped bridge exactly once (L12)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app, bridge } = startApp(100, 32, store, () => {
    throw new Error('synchronous submission failure')
  })
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  assert.equal(bridge.active, 0)

  assert.throws(() => vt.sendInput('\r'), /synchronous submission failure/)
  await vt.waitForRender()
  assert.equal(app.getDraft(), '', 'the fork clear ran before the throwing dispatch')
  assert.equal(bridge.acquired, 1)
  assert.equal(bridge.released, 1)
  assert.equal(bridge.active, 0, 'the bridge was released by the finally')
  // The throwing dispatch released no business pin (there is none) and the
  // image history was retired by the clear.
  pruneUnreferencedDraftAttachments('', store)
  assert.equal(store.size(), 0)
  app.stop()
})


test('a byte-cap rejection never evicts existing Undo retention (L09)', () => {
  // Tiny caps keep the test fast while exercising the real admission check:
  // the retention-only bytes must NOT count toward the active byte cap.
  const store = new DraftImageStore(16, 100 * 1024, 8, 30 * 1024)
  let live = ''
  store.setLiveDraftTextSource(() => live)
  const owner = {}
  store.registerUndoOwner(owner, () => {})
  const big = (size: number) => store.add({ bytes: new Uint8Array(size), mediaType: 'image/png', width: 800, height: 100 })
  const retained = big(20 * 1024)
  store.reconcileUndoOwner(owner, new Set([retained.placeholder]))
  assert.equal(store.undoRetainedCount(), 1)
  const first = big(90 * 1024)
  live = first.placeholder
  store.reconcileUndoOwner(owner, new Set([retained.placeholder]))
  assert.throws(() => big(20 * 1024), /image/i, 'the aggregate resident cap rejects the add')
  assert.ok(store.get(retained.id) !== undefined, 'the failed add kept the undo-retained bytes')
  assert.ok(store.get(first.id) !== undefined, 'the live image is intact')
  assert.equal(store.undoRetainedCount(), 1)
})

test('Ctrl+S steer reserves all nine images before the clear (L01 steer)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const images = Array.from({ length: 9 }, () => addImage(store))
  let steered = ''
  const steerPins: (() => void)[] = []
  const { vt, app, bridge } = startApp(100, 32, store, undefined, (text) => {
    steered = text
    steerPins.push(store.pinReferenced(text))
  })
  const draft = images.map(image => image.placeholder).join(' ')
  app.setDraft(draft)
  await vt.waitForRender()
  // A real edit makes all nine undo-referenced: the steer clear's reconcile
  // would evict the oldest under the 8-image retention budget without the
  // bridge, and the steered text would carry a literal placeholder.
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(store.size(), 9)

  vt.sendInput('\x13') // Ctrl+S -> app.input.steer
  await vt.waitForRender()
  assert.equal(app.getDraft(), '', 'the steer gesture cleared the draft')
  assert.equal(steered.includes(images[0]!.placeholder), true, 'the steer wire form is the submitted text')
  assert.equal(bridge.acquired, 1, 'the steer clear is bridged')
  assert.equal(bridge.active, 0, 'the bridge ended with the synchronous steer dispatch')
  assert.equal(steerPins.length, 1, 'the business steer took over inside the dispatch')
  assert.equal(store.size(), 9, 'no steered image was evicted by the clear')
  assert.equal(
    preparePrompt('steer', steered, { images: store }).segments.filter(segment => segment.type === 'image').length,
    9,
    'the steered message carries all nine real image segments',
  )
  steerPins.pop()?.()
  // The steer clear pushed a normal undo snapshot: the retained images stay
  // bounded by the 8-image retention budget once the business pin ends.
  assert.ok(store.undoRetainedCount() <= 8)
  app.stop()
})

test('x immediately after inserting an image is itself undoable (F1)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  // Only the PRE-INSERT snapshot exists: nothing else can mask a missing
  // snapshot for the x removal.
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  assert.equal(app.getDraft(), '', 'the x removed the only occurrence')
  assert.equal(store.size(), 1, 'the x edit itself is the snapshot that keeps the image undoable')
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(app.getDraft().includes(image.placeholder), `Undo restores exactly the removed image: ${app.getDraft()}`)
  assert.ok(
    expandImagePlaceholders(app.getDraft(), store).some(segment => segment.type === 'image' && segment.image.id === image.id),
    'the restored placeholder resolves to real bytes',
  )
  assert.ok((await viewport(vt)).includes('#1/1 · 800×100'), 'the preview returns after Undo')
  app.setFullscreen(false)
  app.stop()
})

test('a successful Ctrl+S steer retires the draft history (F3)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app, businessPins } = startApp(100, 32, store, undefined, (text, probe) => {
    // The business steer owner takes its synchronous pin, then a successful
    // write consumes the referenced drafts.
    probe.businessPins.push(store.pinReferenced(text))
    consumeDraftAttachments(text, store)
  })
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  assert.equal(store.size(), 1)

  vt.sendInput('\x13') // Ctrl+S
  await vt.waitForRender()
  assert.equal(app.getDraft(), '')
  assert.equal(store.size(), 0, 'the successful steer consumed the image')
  assert.equal(businessPins.length, 1)
  // The steer clear must retire the history like a successful submit: Undo
  // cannot resurrect a consumed image as a dead placeholder.
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(!app.getDraft().includes('[image #'), `Undo must not resurrect the consumed image: ${app.getDraft()}`)
  assert.equal(app.getDraft(), '')
  assert.equal(store.size(), 0)
  app.stop()
})

test('an empty Ctrl+S queue-steer keeps the editor undo history', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  app.setDraft('queued draft text')
  app.setDraft('')
  await vt.waitForRender()
  vt.sendInput('\x13') // Ctrl+S with an empty draft = queue-only steer-all
  await vt.waitForRender()
  assert.equal(app.getDraft(), '')
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'queued draft text', 'the editor history is not retired by a queue-only steer')
  app.stop()
})

test('a failed Ctrl+S steer restores the draft with real image bytes (F3b)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  let steered = ''
  const { vt, app, businessPins } = startApp(100, 32, store, undefined, (text, probe) => {
    steered = text
    probe.businessPins.push(store.pinReferenced(text))
  })
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()

  vt.sendInput('\x13')
  await vt.waitForRender()
  assert.equal(app.getDraft(), '')
  assert.equal(store.size(), 1, 'the business pin holds the bytes while the steer is in flight')

  // The documented failure order: restore the text FIRST, then release the
  // business pin. The restored draft resolves every image.
  app.setDraft(steered)
  businessPins.pop()?.()
  pruneUnreferencedDraftAttachments(app.getDraft(), store)
  assert.equal(store.size(), 1)
  const restored = app.getDraft()
  assert.ok(restored.includes(image.placeholder))
  assert.ok(
    expandImagePlaceholders(restored, store).some(segment => segment.type === 'image' && segment.image.id === image.id),
    'the restored steer draft resolves the image',
  )
  assert.equal(preparePrompt('steer-failure', restored, { images: store }).segments.filter(segment => segment.type === 'image').length, 1)
  app.stop()
})

test('a session switch keeps a LIVE staged image whose draft is retained (L11)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  // The insertion snapshot predates the token, so nothing can Undo the image
  // back: it is LIVE but carries no submission/undo pin.
  app.setDraft(image.placeholder)
  await vt.waitForRender()
  assert.equal(store.isPinned(image.id), false, 'fixture: a plain staged image carries no submission/undo pin')

  // The PiTui editor RETAINS the main draft across a committed session switch
  // (dropOutgoingActiveDraft is deliberately inert), so the switch must not
  // drop an image the retained draft still references.
  app.clearSessionOverrides()
  app.beginInputHistoryScope('new-session')
  app.resetInputHistory([], 'new-session')
  store.clearUnpinned()
  assert.ok(app.getDraft().includes(image.placeholder), 'fixture: the draft really survived the switch')
  assert.equal(store.size(), 1, 'the retained live draft keeps its image bytes')
  assert.ok(expandImagePlaceholders(app.getDraft(), store).some(segment => segment.type === 'image' && segment.image.id === image.id))
  app.stop()
})

test('a local-command Enter releases the bridge and leaves no long-lived reservation (L03)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const seen: string[] = []
  const { vt, app, bridge, businessPins } = startApp(100, 32, store, (_text, probe) => {
    // A local command takes no attachment reservation (this fixture only
    // records the dispatch, like the controller's local-command branch).
    void probe
  })
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  // Removing the image leaves a genuine undo lease...
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  vt.sendInput(storedUndoKey)
  await vt.waitForRender()
  assert.ok(app.getDraft().includes(image.placeholder))
  // ...then a local-command-style submit clears the draft: the undo history is
  // retired (real Enter behavior) and no bridge/business pin survives.
  app.setDraft('/status')
  vt.sendInput('\r')
  await vt.waitForRender()
  seen.push('entered')
  assert.equal(bridge.acquired, bridge.released)
  assert.equal(bridge.active, 0)
  assert.equal(businessPins.length, 0, 'a local command takes no attachment reservation')
  pruneUnreferencedDraftAttachments('', store)
  assert.equal(store.size(), 0, 'the retired history releases the removed image')
  assert.equal(seen.length, 1)
  app.setFullscreen(false)
  app.stop()
})

test('dispose releases the host editor undo leases (L11)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft('')
  app.insertIntoEditor(image.placeholder)
  vt.sendInput(' hello')
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  const owners = (store as unknown as { undoOwners: Map<object, { ids: Set<number> }> }).undoOwners
  assert.deepEqual([...owners.values()][0]!.ids, new Set([image.id]))
  app.dispose()
  assert.deepEqual([...owners.values()][0]!.ids, new Set(), 'dispose released the owner leases')
  startedApps.delete(app)
})

test('an image in a viewer-covered draft still counts as LIVE, not retention-only', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  // A one-image retention budget: a misclassification would evict immediately.
  const store = new DraftImageStore(16, 64 * 1024 * 1024, 1, 32 * 1024 * 1024)
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setViewerMode({
    parentSessionId: 'parent',
    childSessionId: 'child',
    label: 'child',
    mode: 'continuable',
    activity: 'inactive',
  })
  app.setEditorText(`${image.placeholder} ask`)
  vt.sendInput('!')
  await vt.waitForRender()
  assert.equal(store.undoRetainedCount(), 0, 'the viewer draft occurrence is a live attachment')
  assert.equal(store.activeSize(), 1)
  assert.ok(store.get(image.id) !== undefined)
  // The preview band stays hidden, but the bytes are not eviction-eligible.
  pruneUnreferencedDraftAttachments(app.getDraft(), store)
  assert.equal(store.size(), 1)
  app.setViewerMode(undefined)
  app.stop()
})

test('a failed add never evicts existing Undo retention', () => {
  const store = new DraftImageStore(2, 64 * 1024 * 1024, 8, 32 * 1024 * 1024)
  let live = ''
  store.setLiveDraftTextSource(() => live)
  const owner = {}
  store.registerUndoOwner(owner, () => {})
  // Two removed images held only by undo retention.
  const retained = [addImage(store), addImage(store)]
  store.reconcileUndoOwner(owner, new Set(retained.map(image => image.placeholder)))
  assert.equal(store.activeSize(), 0, 'retention-only images do not consume the active cap')
  // Two live draft images fill the active cap.
  const first = addImage(store)
  const second = addImage(store)
  live = `${first.placeholder} ${second.placeholder}`
  store.reconcileUndoOwner(owner, new Set(retained.map(image => image.placeholder)))
  assert.equal(store.activeSize(), 2)
  assert.throws(() => addImage(store), /Too many staged images/)
  assert.equal(store.undoRetainedCount(), 2, 'the failed add did not destroy Undo retention')
  assert.ok(store.get(retained[0]!.id) !== undefined)
  assert.ok(store.get(retained[1]!.id) !== undefined)
  assert.ok(store.get(first.id) !== undefined)
  assert.ok(store.get(second.id) !== undefined)
})


test('an ordinary draft edit re-converges the retention budget', () => {
  const store = new DraftImageStore(16, 64 * 1024 * 1024, 1, 32 * 1024 * 1024)
  let live = ''
  store.setLiveDraftTextSource(() => live)
  const owner = {}
  store.registerUndoOwner(owner, () => {})
  const first = addImage(store)
  const second = addImage(store)
  const both = new Set([first.placeholder, second.placeholder])

  // B is removed while A stays live: within the one-image budget.
  live = first.placeholder
  store.reconcileUndoOwner(owner, both)
  assert.equal(store.undoRetainedCount(), 1)
  assert.equal(store.get(second.id) !== undefined, true)

  // Undo restores A as a live image: no retention-only entry remains.
  live = both.values().next().value === first.placeholder ? `${first.placeholder} ${second.placeholder}` : ''
  store.reconcileUndoOwner(owner, both)
  assert.equal(store.undoRetainedCount(), 0, 'the restored images are active again')

  // An ordinary edit then removes BOTH from the live draft: the budget must
  // re-converge to one, retiring the image that became retention-only first.
  live = first.placeholder
  store.reconcileUndoOwner(owner, both)
  live = ''
  store.reconcileUndoOwner(owner, both)
  assert.equal(store.undoRetainedCount(), 1, 'the ordinary edit re-converged the budget')
  assert.equal(store.get(second.id), undefined, 'the oldest retention is retired')
  assert.ok(store.get(first.id) !== undefined, 'the newest retention survives')
})


test('the same placeholder twice: x previews and removes the LAST occurrence', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft(`${image.placeholder} and ${image.placeholder}`)
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/2 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  assert.equal(store.size(), 1, 'the remaining occurrence keeps the draft alive')
  assert.equal(app.getDraft(), `${image.placeholder} and`, 'the last occurrence was removed')
  app.setFullscreen(false)
  app.stop()
})


test('a draft edit between press and release drops the stale x gesture', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft(`${image.placeholder} hello`)
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  vt.sendInput(`\x1b[<0;100;${labelRow}M`)
  app.setDraft(`${image.placeholder} changed`)
  await vt.waitForRender()
  vt.sendInput(`\x1b[<0;100;${labelRow}m`)
  await vt.waitForRender()
  assert.equal(app.getDraft(), `${image.placeholder} changed`, 'the stale press must not remove the token')
  assert.equal(store.size(), 1, 'the draft stays staged')
  app.setFullscreen(false)
  app.stop()
})


test('the preview width ladder: summary under 50 columns, one card at 60/100', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  {
    const store = new DraftImageStore()
    const { vt, app } = startApp(38, 32, store)
    const image = addImage(store)
    app.setDraft(image.placeholder)
    const view = await viewport(vt)
    assert.ok(view.includes('1 image attached'), `narrow summary:\n${view}`)
    assert.ok(!view.includes('#1/1 · 800×100'), 'narrow band omits the card identity')
    disposeStartedApps()
  }
  for (const columns of [60, 100]) {
    const store = new DraftImageStore()
    const { vt, app } = startApp(columns, 32, store)
    const image = addImage(store)
    app.setDraft(image.placeholder)
    const view = await viewport(vt)
    assert.ok(view.includes('#1/1 · 800×100 · 33 B'), `${columns}-column card:\n${view}`)
    disposeStartedApps()
  }
})


test('the preview height ladder: card with 4 available rows, summary with 1–3', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  {
    const store = new DraftImageStore()
    const { vt, app } = startApp(100, 18, store)
    const image = addImage(store)
    app.setDraft(image.placeholder)
    const view = await viewport(vt)
    assert.ok(view.includes('1 image attached'), `three-row summary:\n${view}`)
    assert.ok(!view.includes('#1/1 · 800×100'), 'summary omits the card')
    disposeStartedApps()
  }
  for (const rows of [24, 40]) {
    const store = new DraftImageStore()
    const { vt, app } = startApp(100, rows, store)
    const image = addImage(store)
    app.setDraft(image.placeholder)
    const view = await viewport(vt)
    assert.ok(view.includes('#1/1 · 800×100 · 33 B'), `${rows}-row card:\n${view}`)
    assert.ok(view.includes('❯') && view.includes('full'), 'editor/footer stay visible')
    disposeStartedApps()
  }
  {
    const store = new DraftImageStore()
    const { vt, app } = startApp(100, 12, store)
    const image = addImage(store)
    app.setDraft(image.placeholder)
    const view = await viewport(vt)
    assert.ok(!view.includes('#1/1 · 800×100') && !view.includes('1 image attached'), `no safe space:\n${view}`)
    assert.ok(view.includes('❯') && view.includes('full'), 'editor/footer stay visible')
    disposeStartedApps()
  }
})


test('typing in a large-paste draft with no staged image never re-expands the paste', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  // Count the expanded-draft reads: with no staged image the band must return
  // before expanding paste bodies on the typing/render hot path.
  const appInternal = app as unknown as { draftPreviewText: () => string }
  const original = appInternal.draftPreviewText
  let expansions = 0
  appInternal.draftPreviewText = () => {
    expansions += 1
    return original.call(app)
  }
  pasteLarge(vt)
  await vt.waitForRender()
  const afterPaste = expansions
  vt.sendInput('abc')
  await vt.waitForRender()
  assert.equal(expansions, afterPaste, 'no staged image: typing never re-expands the large paste')
  app.stop()
})

test('no image reference renders no preview band at all', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  addImage(store)
  app.setDraft('plain text only')
  const view = await viewport(vt)
  assert.ok(!view.includes('images attached') && !view.includes('#1/1 ·'), `no preview band:\n${view}`)
  app.stop()
})


test('two images: the card is the LAST one and x removes only that occurrence', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const one = addImage(store)
  const two = store.add({
    bytes: pngBytes(),
    mediaType: 'image/png',
    width: 640,
    height: 480,
    name: 'second.png',
  })
  app.setDraft(`${one.placeholder} ${two.placeholder}`)
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, `#${two.id}/2 · 640×480`, 'last occurrence identity')
  const view = await viewport(vt)
  assert.ok(view.includes('+1'), 'remaining count shown')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  assert.equal(app.getDraft(), one.placeholder, 'only the last occurrence was removed')
  assert.equal(store.size(), 2, 'the first occurrence draft survives and the removed last is retained')
  assert.ok(store.get(one.id) !== undefined)
  assert.ok(store.get(two.id) !== undefined, 'the removed last is retained for undo')
  app.setFullscreen(false)
  app.stop()
})


test('a large paste keeps its marker and content through the visible x removal', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  pasteLarge(vt)
  await vt.waitForRender()
  app.insertIntoEditor(image.placeholder)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  const draft = app.getDraft()
  assert.ok(draft.includes('real line 12'), `the expanded paste content survives: ${draft}`)
  assert.ok(!draft.includes('[paste #'), 'the paste marker must not be orphaned by the x edit')
  assert.equal(store.size(), 1, 'the removed visible image is retained for undo')
  app.setFullscreen(false)
  app.stop()
})


test('a hidden LAST occurrence is shown but has no x (fullscreen, click inert)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const visible = addImage(store)
  const hidden = addImage(store)
  app.setDraft(`${visible.placeholder} `)
  pasteLarge(vt, hidden.placeholder)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const before = app.getDraft()
  const expandedOccurrences = selectDraftImageOccurrences(before, store)
  assert.equal(expandedOccurrences.length, 2, 'the hidden token is part of the submission text')
  const view = await viewport(vt)
  assert.ok(view.includes(`#${hidden.id}/2`), `the hidden last occurrence is shown:\n${view}`)
  const identityRow = await rowOf(vt, `#${hidden.id}/2`, 'hidden last identity')
  assert.ok(!stripAnsi(view.split('\n')[identityRow - 1]!).endsWith('x'), 'no x for a hidden occurrence')
  click(vt, 100, identityRow)
  await vt.waitForRender()
  assert.equal(app.getDraft(), before, 'a click on the would-be control cell is inert')
  assert.equal(store.size(), 2, 'no attachment is silently pruned without an x')
  app.setFullscreen(false)
  app.stop()
})


test('same image id hidden AFTER the visible one still has no x (hidden last)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft(`${image.placeholder} `)
  pasteLarge(vt, image.placeholder)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const before = app.getDraft()
  assert.equal(selectDraftImageOccurrences(before, store).length, 2, 'same-id hidden + visible occurrences')
  const identityRow = await rowOf(vt, `#${image.id}/2`, 'same-id hidden-last identity')
  const view = await viewport(vt)
  assert.ok(!stripAnsi(view.split('\n')[identityRow - 1]!).endsWith('x'), 'no x when the last occurrence is hidden')
  click(vt, 100, identityRow)
  await vt.waitForRender()
  assert.equal(app.getDraft(), before, 'the would-be control cell is inert')
  assert.equal(store.size(), 1, 'the shared draft survives')
  app.setFullscreen(false)
  app.stop()
})


test('same image id hidden BEFORE a visible last maps to the raw last and removes it', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  pasteLarge(vt, image.placeholder)
  await vt.waitForRender()
  app.insertIntoEditor(image.placeholder)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(selectDraftImageOccurrences(app.getDraft(), store).length, 2, 'hidden earlier + visible last')
  const identityRow = await rowOf(vt, `#${image.id}/2`, 'same-id visible-last identity')
  const view = await viewport(vt)
  assert.ok(stripAnsi(view.split('\n')[identityRow - 1]!).endsWith('x'), 'the visible previewed last has an x')
  click(vt, 100, identityRow)
  await vt.waitForRender()
  assert.equal(store.size(), 1, 'the hidden occurrence keeps the draft alive')
  const remaining = selectDraftImageOccurrences(app.getDraft(), store)
  assert.equal(remaining.length, 1, 'the hidden occurrence remains in the expanded submission text')
  assert.equal(remaining[0]!.image.id, image.id)
  app.setFullscreen(false)
  app.stop()
})


test('a hidden EARLIER occurrence survives removal of the visible LAST one (expanded prune)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const hidden = addImage(store)
  const visible = addImage(store)
  pasteLarge(vt, hidden.placeholder)
  await vt.waitForRender()
  app.insertIntoEditor(visible.placeholder)
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, `#${visible.id}/2`, 'visible last identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  assert.equal(store.size(), 2, 'the hidden occurrence keeps its draft alive and the removed visible is retained')
  assert.ok(store.get(hidden.id) !== undefined, 'hidden draft survives')
  assert.ok(store.get(visible.id) !== undefined, 'the visible draft is retained for undo')
  const remaining = selectDraftImageOccurrences(app.getDraft(), store)
  assert.equal(remaining.length, 1, 'the hidden occurrence remains in the expanded submission text')
  assert.equal(remaining[0]!.image.id, hidden.id)
  app.setFullscreen(false)
  app.stop()
})


test('an in-flight pinned draft survives the preview x removal', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft(image.placeholder)
  const release = store.pinReferenced(app.getDraft())
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  assert.equal(app.getDraft(), '', 'the token is removed from the editor')
  assert.equal(store.size(), 1, 'the in-flight pinned draft is not pruned')
  release()
  app.setFullscreen(false)
  app.stop()
})


test('the preview x preserves shell mode', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft(`!${image.placeholder} echo hi`)
  app.setFullscreen(true)
  await vt.waitForRender()
  const labelRow = await rowOf(vt, '#1/1 · 800×100', 'preview identity')
  click(vt, 100, labelRow)
  await vt.waitForRender()
  assert.equal(app.getDraft(), '!echo hi', 'the shell prefix survives the x edit')
  app.setFullscreen(false)
  app.stop()
})


test('session switch and dispose release the preview render caches', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const { vt, app } = startApp(100, 32, store)
  const image = addImage(store)
  app.setDraft(image.placeholder)
  await vt.waitForRender()
  const component = (app as unknown as {
    draftImagePreview: {
      imageCache: Map<string, unknown>
      base64Cache: Map<string, unknown>
    }
  }).draftImagePreview
  assert.ok(component.imageCache.size > 0, 'card image cached')
  assert.ok(component.base64Cache.size > 0, 'base64 cached')
  app.clearSessionOverrides()
  assert.equal(component.imageCache.size, 0, 'session switch releases the image cache')
  assert.equal(component.base64Cache.size, 0, 'session switch releases the base64 cache')
  app.requestRender()
  await vt.waitForRender()
  assert.ok(component.imageCache.size > 0, 'the live preview can repopulate')
  app.dispose()
  assert.equal(component.imageCache.size, 0, 'dispose releases the image cache')
  assert.equal(component.base64Cache.size, 0, 'dispose releases the base64 cache')
})


test('short/tall and narrow/wide combinations keep the editor and footer visible', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const combinations: ReadonlyArray<readonly [number, number]> = [
    [38, 12],
    [55, 18],
    [100, 24],
    [55, 40],
  ]
  for (const [columns, rows] of combinations) {
    const store = new DraftImageStore()
    const { vt, app } = startApp(columns, rows, store)
    const image = addImage(store)
    app.setDraft(`${image.placeholder} keep`)
    const view = await viewport(vt)
    assert.ok(view.includes('❯') && view.includes('keep'), `${columns}×${rows}: editor remains visible:\n${view}`)
    assert.ok(view.includes('full'), `${columns}×${rows}: footer remains visible:\n${view}`)
    const footerRow = await rowOf(vt, 'full', `${columns}×${rows} footer`)
    const editorRow = await rowOf(vt, 'keep', `${columns}×${rows} editor`)
    assert.ok(editorRow < footerRow, `${columns}×${rows}: editor stays above the footer`)
    disposeStartedApps()
  }
})
