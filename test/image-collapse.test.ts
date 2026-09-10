/**
 * Headless tests for the fullscreen attachment collapse toggle: on image-
 * capable terminals a thumbnail renders its CONSTANT info bar plus the
 * image rows; a fullscreen click on the attachment (info bar or image)
 * collapses the image rows back to the info bar, and a second click
 * expands them again. The info bar (`🖼️ name · W×H · bytes`) never
 * disappears — the attachment's identity stays in every state.
 * @module @xmoon76/dsh-pi-tui/image-collapse.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { resetCapabilitiesCache, setCapabilities } from '@xmoon76/pi-tui'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { ImageLoader } from '../src/image/loader.ts'
import type { AssistantLiveChunk } from '../src/runtime/assistant-stream-port.ts'
import { VirtualTerminal } from './virtual-terminal.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** A wide-and-short image: its rendered rows (≈5 at 100 columns) are far
 * below the 12-row cap, so several attachments fit the headless viewport. */
const IMAGE_REF = {
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 33,
  width: 800,
  height: 100,
  name: 'shot.png',
}

const IMAGE_REF_2 = {
  attachmentId: 'att-2',
  mediaType: 'image/png',
  bytes: 33,
  width: 800,
  height: 100,
  name: 'second.png',
}

function pngBytes(): Buffer {
  const bytes = Buffer.alloc(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  bytes.writeUInt32BE(1, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const loader = new ImageLoader(async () => ({ ref: {}, data: pngBytes() }))
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text) => text },
  })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

/** Wait for a repaint and settle the loader's async read, then return the
 * viewport as one string. */
async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  await new Promise(resolve => setTimeout(resolve, 30))
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

/** The 1-based row of the first line containing the needle (asserts on
 * failure), so assertions compare RELATIVE positions — the exact image row
 * count never enters the math. */
async function rowOf(vt: VirtualTerminal, needle: string, label: string): Promise<number> {
  return rowOfNth(vt, needle, 0, label)
}

/** The 1-based row of the NTH line containing the needle (0-based n) —
 * needed when two identical attachment info bars sit in one transcript. */
async function rowOfNth(vt: VirtualTerminal, needle: string, n: number, label: string): Promise<number> {
  const view = await viewport(vt)
  let seen = 0
  const index = view.split('\n').findIndex(line => {
    if (!line.includes(needle)) return false
    if (seen === n) return true
    seen += 1
    return false
  })
  assert.ok(index !== -1, `${label}: occurrence #${n + 1} of ${JSON.stringify(needle)} missing:\n${view}`)
  return index + 1
}

function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

/** The alt screen treats a fast repeat at the same cell as a double-click
 * (word selection, like a native terminal) — mirror the existing card
 * toggle test's pause. */
async function settleClick(vt: VirtualTerminal): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 600))
  await vt.waitForRender()
}

test('a fullscreen click on the attachment collapses the image rows and a second click expands them', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'user/message', seq: 1, time: 1, data: { content: [
      { type: 'text', text: 'check' },
      { type: 'image', attachment: IMAGE_REF },
    ], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [
      { type: 'text', text: 'NEXT' },
    ], source: { kind: 'user' } } },
  ] as never[])
  app.setTranscript(folder.messages())
  // Expanded: the image rows push the NEXT message down.
  const expandedRow = await rowOf(vt, 'NEXT', 'expanded layout')
  const view = await viewport(vt)
  assert.ok(view.includes('🖼️ shot.png · 800×100 · 33 B'), `info bar constant:\n${view}`)
  // Click the attachment's info bar at its CURRENT row (header(1) +
  // bubble(2) + spacer(3) → 1-based y=4 while expanded).
  const infoRow = await rowOf(vt, '🖼️ shot.png · 800×100', 'info bar row')
  click(vt, 4, infoRow)
  await settleClick(vt)
  // Collapsed: only the info bar remains; the NEXT message moves UP.
  const collapsedRow = await rowOf(vt, 'NEXT', 'collapsed layout')
  assert.ok(collapsedRow < expandedRow, `collapse must shrink the message (${collapsedRow} < ${expandedRow})`)
  assert.ok((await viewport(vt)).includes('🖼️ shot.png · 800×100 · 33 B'), 'the info bar stays after collapse')
  // A second click on the same info bar (it moved UP with the collapse)
  // expands the image again.
  const collapsedInfoRow = await rowOf(vt, '🖼️ shot.png · 800×100', 'collapsed info bar row')
  click(vt, 4, collapsedInfoRow)
  await settleClick(vt)
  const reExpandedRow = await rowOf(vt, 'NEXT', 're-expanded layout')
  assert.equal(reExpandedRow, expandedRow, 're-expand must restore the layout')
  app.setFullscreen(false)
  app.stop()
})

test('collapsing one attachment never touches the other', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'user/message', seq: 1, time: 1, data: { content: [
      { type: 'text', text: 'first' },
      { type: 'image', attachment: IMAGE_REF },
      { type: 'text', text: 'second' },
      { type: 'image', attachment: IMAGE_REF_2 },
    ], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [
      { type: 'text', text: 'NEXT' },
    ], source: { kind: 'user' } } },
  ] as never)
  app.setTranscript(folder.messages())
  const before = await rowOf(vt, 'NEXT', 'both expanded')
  // Collapse the FIRST attachment at its info bar; the SECOND attachment
  // stays expanded, so the NEXT message moves up by only the first image's
  // rows.
  const firstInfo = await rowOf(vt, '🖼️ shot.png · 800×100', 'first info bar')
  click(vt, 4, firstInfo)
  await settleClick(vt)
  const afterFirst = await rowOf(vt, 'NEXT', 'first collapsed')
  assert.ok(afterFirst < before, 'the first image collapsed')
  assert.ok((await viewport(vt)).includes('🖼️ second.png · 800×100 · 33 B'), 'the second info bar stays')
  // Collapse the SECOND attachment: its info bar is now above NEXT.
  const secondInfo = await rowOf(vt, 'second.png · 800×100', 'second info bar')
  click(vt, 4, secondInfo)
  await settleClick(vt)
  const afterSecond = await rowOf(vt, 'NEXT', 'second collapsed')
  assert.ok(afterSecond < afterFirst, 'the second image collapsed too')
  // Expand the FIRST attachment again (its info bar is still the top row
  // of the message): NEXT moves back down by EXACTLY the first image's
  // rows (before - afterFirst) — never the second image's, which stays
  // collapsed. Delta math only: the exact image row count never enters.
  const firstInfoAgain = await rowOf(vt, '🖼️ shot.png · 800×100', 'first info bar again')
  click(vt, 4, firstInfoAgain)
  await settleClick(vt)
  const reExpanded = await rowOf(vt, 'NEXT', 'first re-expanded')
  assert.equal(reExpanded, afterSecond + (before - afterFirst), 'only the first image re-expanded (its own rows came back)')
  app.setFullscreen(false)
  app.stop()
})

test('collapsed state is session-scoped: clearSessionOverrides re-expands', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'user/message', seq: 1, time: 1, data: { content: [
      { type: 'text', text: 'check' },
      { type: 'image', attachment: IMAGE_REF },
    ], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [
      { type: 'text', text: 'NEXT' },
    ], source: { kind: 'user' } } },
  ] as never)
  app.setTranscript(folder.messages())
  const expandedRow = await rowOf(vt, 'NEXT', 'expanded')
  const infoRow = await rowOf(vt, '🖼️ shot.png · 800×100', 'info bar row')
  click(vt, 4, infoRow)
  await settleClick(vt)
  const collapsedRow = await rowOf(vt, 'NEXT', 'collapsed')
  assert.ok(collapsedRow < expandedRow, 'click collapsed the image')
  // A session switch clears every click override and pushes the NEW
  // session's transcript (the runner's switch flow): the attachment
  // expands again.
  app.clearSessionOverrides()
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const resetRow = await rowOf(vt, 'NEXT', 'after clearSessionOverrides')
  assert.equal(resetRow, expandedRow, 'the click state must not leak across sessions')
  app.setFullscreen(false)
  app.stop()
})

test('a tool-card image row still toggles the CARD — never swallowed by an attachment collapse', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  // Tool-card images are NOT collapse targets (the host wires a
  // collapsedRef only for message attachments): their rows must keep the
  // card's own click surface, so a click on the image folds the card.
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 0, step: 0, callId: 'call-1', name: 'screenshot_tool', arguments: [] } } as never,
    { type: 'tool/result', seq: 2, time: 2, data: { turn: 0, step: 0, callId: 'call-1', message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [
      { type: 'text', text: 'caption' },
      { type: 'image', attachment: IMAGE_REF },
    ] }] } } } as never,
  ])
  app.setTranscript(folder.messages())
  // Folded: only the header. Click it to expand the card (per-message
  // override on).
  const headerRow = await rowOf(vt, 'screenshot_tool', 'tool header')
  click(vt, 4, headerRow)
  await settleClick(vt)
  const expandedView = await viewport(vt)
  assert.ok(expandedView.includes('caption'), 'expanded card shows its body')
  assert.ok(expandedView.includes('🖼️ shot.png · 800×100 · 33 B'), 'expanded card shows the image info bar')
  // Click the IMAGE ROW: the card folds (the click belongs to the card's
  // own surface — an attachment toggle must never intercept it).
  const imageRow = await rowOf(vt, '🖼️ shot.png · 800×100', 'tool image info bar')
  click(vt, 4, imageRow)
  await settleClick(vt)
  const foldedView = await viewport(vt)
  // The folded header keeps its summary line ('— caption'), so the body
  // signal is the IMAGE row disappearing: the click folded the card
  // instead of being swallowed by an attachment toggle.
  assert.ok(!foldedView.includes('🖼️ shot.png · 800×100'), `the image-row click folds the tool card (image body gone):\n${foldedView}`)
  app.setFullscreen(false)
  app.stop()
})


test('the SAME attachment in two messages collapses per occurrence, never together', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  // The SAME durable ref (att-1) is displayed twice — message A and
  // message B. Clicking A's picture must fold A's image rows only; the
  // old attachmentId-keyed state collapsed both.
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'user/message', seq: 1, time: 1, data: { content: [
      { type: 'text', text: 'first' },
      { type: 'image', attachment: IMAGE_REF },
    ], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [
      { type: 'text', text: 'second' },
      { type: 'image', attachment: IMAGE_REF },
    ], source: { kind: 'user' } } },
    { type: 'user/message', seq: 3, time: 3, data: { content: [
      { type: 'text', text: 'NEXT' },
    ], source: { kind: 'user' } } },
  ] as never)
  app.setTranscript(folder.messages())
  const before = await rowOf(vt, 'NEXT', 'both occurrences expanded')
  // The FIRST info bar — both messages' info bars are byte-identical.
  const firstInfo = await rowOf(vt, '🖼️ shot.png · 800×100', 'first info bar')
  click(vt, 4, firstInfo)
  await settleClick(vt)
  const afterFirst = await rowOf(vt, 'NEXT', 'after the first occurrence collapsed')
  assert.ok(afterFirst < before, 'the clicked occurrence collapsed')
  // Re-expanding the first occurrence restores the FULL layout — had the
  // second occurrence collapsed along, NEXT would stay short of `before`.
  const firstInfoAgain = await rowOf(vt, '🖼️ shot.png · 800×100', 'first info bar again')
  click(vt, 4, firstInfoAgain)
  await settleClick(vt)
  const reExpanded = await rowOf(vt, 'NEXT', 'after re-expand')
  assert.equal(reExpanded, before, 'only the clicked occurrence toggled; the repeated attachment stayed expanded')
  app.setFullscreen(false)
  app.stop()
})

test('the same attachment twice in ONE message collapses per block index', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'user/message', seq: 1, time: 1, data: { content: [
      { type: 'text', text: 'both' },
      { type: 'image', attachment: IMAGE_REF },
      { type: 'text', text: 'and' },
      { type: 'image', attachment: IMAGE_REF },
    ], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [
      { type: 'text', text: 'NEXT' },
    ], source: { kind: 'user' } } },
  ] as never)
  app.setTranscript(folder.messages())
  const before = await rowOf(vt, 'NEXT', 'both blocks expanded')
  // Two identical attachment occurrences inside ONE message: each block
  // index is its own occurrence.
  const firstInfo = await rowOfNth(vt, '🖼️ shot.png · 800×100', 0, 'first info bar')
  click(vt, 4, firstInfo)
  await settleClick(vt)
  const afterFirst = await rowOf(vt, 'NEXT', 'after the first block collapsed')
  assert.ok(afterFirst < before, 'the first block collapsed')
  // The SECOND block is still expanded — clicking its info bar collapses
  // it too (NEXT moves up again). Under the old attachmentId-keyed state
  // the first click had folded BOTH blocks, and this click would EXPAND
  // the second instead (NEXT would move back DOWN).
  const secondInfo = await rowOfNth(vt, '🖼️ shot.png · 800×100', 1, 'second info bar')
  click(vt, 4, secondInfo)
  await settleClick(vt)
  const afterSecond = await rowOf(vt, 'NEXT', 'after the second block collapsed')
  assert.ok(afterSecond < afterFirst, 'the second block collapsed independently (its own rows left)')
  // Re-expand the FIRST block: NEXT returns by exactly the first block's
  // rows — the second stays collapsed (delta math only).
  const firstInfoAgain = await rowOfNth(vt, '🖼️ shot.png · 800×100', 0, 'first info bar again')
  click(vt, 4, firstInfoAgain)
  await settleClick(vt)
  const reExpanded = await rowOf(vt, 'NEXT', 'after re-expanding the first block')
  assert.equal(reExpanded, afterSecond + (before - afterFirst), 'only the first block re-expanded')
  app.setFullscreen(false)
  app.stop()
})

test('an attachment press cannot transfer to a sibling after an async image growth (mouse parity)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const vt = new VirtualTerminal(100, 24)
  const pending: Array<() => void> = []
  const loader = new ImageLoader(() => new Promise(resolve => { pending.push(() => resolve({ ref: {}, data: pngBytes() })) }))
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text) => text },
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'user/message', seq: 1, time: 1, data: { content: [
      { type: 'text', text: 'check' },
      { type: 'image', attachment: IMAGE_REF },
      { type: 'image', attachment: IMAGE_REF_2 },
    ], source: { kind: 'user' } } },
  ] as never[])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  // Both images are still loading (info bar only).
  const bRow = await rowOf(vt, '🖼️ second.png · 800×100', 'B info bar row')
  // Press B's info bar (no release): the press identity is
  // attachment:<token>:1.
  vt.sendInput(`\x1b[<0;4;${bRow}M`)
  await vt.waitForRender()
  // Image A loads and grows: the SAME message object is unchanged, A's
  // rows insert below A, and the old B cell falls inside A's range. The
  // loader settle only invalidates the thumbnail (it does not schedule a
  // frame), so the test waits for the settle notification and drives the
  // repaint explicitly.
  const settled = new Promise<void>(resolve => {
    const unsubscribe = loader.subscribe(IMAGE_REF.attachmentId, () => { unsubscribe(); resolve() })
  })
  pending[0]!()
  await settled
  app.requestRender()
  await vt.waitForRender()
  const after = await viewport(vt)
  const aInfo = await rowOf(vt, '🖼️ shot.png · 800×100', 'A info bar row')
  assert.ok(aInfo < bRow, `A's growth must push B down:\n${after}`)
  // Release on the old cell: the click must NOT toggle A (the press
  // identity is B's attachment).
  vt.sendInput(`\x1b[<0;4;${bRow}m`)
  await vt.waitForRender()
  const collapsed = (app as unknown as { collapsedOccurrences: Map<unknown, Set<number>> }).collapsedOccurrences
  assert.equal(collapsed.size, 0, `the stale attachment press must not toggle a sibling:\n${vt.getViewport().join('\n')}`)
  app.stop()
})

test('an async image load that settles between frames repaints automatically (host load-notify gap)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const vt = new VirtualTerminal(100, 24)
  const pending: Array<() => void> = []
  const loader = new ImageLoader(() => new Promise(resolve => { pending.push(() => resolve({ ref: {}, data: pngBytes() })) }))
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text) => text },
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'user/message', seq: 1, time: 1, data: { content: [
      { type: 'text', text: 'check' },
      { type: 'image', attachment: IMAGE_REF },
    ], source: { kind: 'user' } } },
    { type: 'user/message', seq: 2, time: 2, data: { content: [
      { type: 'text', text: 'NEXT' },
    ], source: { kind: 'user' } } },
  ] as never[])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  // The image is still loading (info bar only): the NEXT message sits
  // right below it.
  const before = await rowOf(vt, 'NEXT', 'loading layout')
  // The deferred read resolves BETWEEN frames: the loader settle only
  // invalidates the thumbnail — the thumbnail's own requestRender must
  // schedule the repaint with the resolved bytes (no explicit
  // app.requestRender in this test).
  pending[0]!()
  await vt.waitForRender()
  const after = await viewport(vt)
  const afterRow = await rowOf(vt, 'NEXT', 'grown layout')
  assert.ok(afterRow > before, `the image growth must repaint automatically:\n${after}`)
  app.stop()
})

test('a live out-of-order image close cannot transfer collapse state to the earlier occurrence', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 0, step: 0 } },
  ] as never[])
  const input = (chunk: AssistantLiveChunk, time: number): void => folder.applyLiveInput({
    kind: 'chunk', sessionId: 'test', attemptId: 'attempt', turn: 0, step: 0, time, chunk,
  })
  // Block 0 (image A) starts and stays OPEN while block 1 (image B) starts
  // AND closes first — the DSH stream invariant allows out-of-order closes.
  input({ type: 'block-start', index: 0, blockType: 'image' }, 3)
  input({ type: 'block-start', index: 1, blockType: 'image' }, 4)
  input({ type: 'block-end', index: 1, block: { type: 'image', attachment: IMAGE_REF_2 } }, 5)
  folder.apply([
    { type: 'user/message', seq: 2, time: 6, data: { content: [
      { type: 'text', text: 'NEXT' },
    ], source: { kind: 'user' } } },
  ] as never[])
  app.setTranscript(folder.messages())
  // B renders as the FIRST thumbnail (A is still an open opaque row): the
  // old ordinal identity would give B index 0.
  const bInfo = await rowOf(vt, '🖼️ second.png · 800×100', 'B info bar')
  click(vt, 4, bInfo)
  await settleClick(vt)
  // A closes AFTER B was collapsed: A must NOT inherit B's collapse state.
  input({ type: 'block-end', index: 0, block: { type: 'image', attachment: IMAGE_REF } }, 7)
  app.setTranscript(folder.messages())
  const view = await viewport(vt)
  const aInfo = await rowOf(vt, '🖼️ shot.png · 800×100', 'A info bar')
  const bInfoAfter = await rowOf(vt, '🖼️ second.png · 800×100', 'B info bar after A closes')
  const nextRow = await rowOf(vt, 'NEXT', 'NEXT row')
  // A is expanded: its image rows sit between the two info bars.
  assert.ok(bInfoAfter - aInfo > 1, `A must stay expanded (its image rows sit between the info bars):\n${view}`)
  // B is collapsed: only the trailing spacer separates B's info bar from NEXT.
  assert.equal(nextRow - bInfoAfter, 2, `B must stay collapsed (only the spacer between B and NEXT):\n${view}`)
  app.setFullscreen(false)
  app.stop()
})

test('a live out-of-order image close cannot transfer a press to the earlier occurrence', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const vt = new VirtualTerminal(100, 24)
  const pending: Array<() => void> = []
  // Only A's load defers: B resolves immediately, so `pending[0]` is A's
  // read (the same single-deferred pattern as the sibling growth test).
  const loader = new ImageLoader((ref) => ref.attachmentId === IMAGE_REF.attachmentId
    ? new Promise(resolve => { pending.push(() => resolve({ ref: {}, data: pngBytes() })) })
    : Promise.resolve({ ref: {}, data: pngBytes() }))
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text) => text },
  })
  app.start()
  startedApps.add(app)
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 0, step: 0 } },
  ] as never[])
  const input = (chunk: AssistantLiveChunk, time: number): void => folder.applyLiveInput({
    kind: 'chunk', sessionId: 'test', attemptId: 'attempt', turn: 0, step: 0, time, chunk,
  })
  input({ type: 'block-start', index: 0, blockType: 'image' }, 3)
  input({ type: 'block-start', index: 1, blockType: 'image' }, 4)
  input({ type: 'block-end', index: 1, block: { type: 'image', attachment: IMAGE_REF_2 } }, 5)
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  // B is the first rendered thumbnail (A is still an open opaque row) and
  // still loading (info bar only).
  const bRow = await rowOf(vt, '🖼️ second.png · 800×100', 'B info bar row')
  // Press B's info bar (no release): the press identity is B's occurrence.
  vt.sendInput(`\x1b[<0;4;${bRow}M`)
  await vt.waitForRender()
  // A closes and grows: the old B cell falls inside A's range. The loader
  // settle only invalidates the thumbnail (it does not schedule a frame),
  // so the test waits for the settle notification and drives the repaint
  // explicitly.
  input({ type: 'block-end', index: 0, block: { type: 'image', attachment: IMAGE_REF } }, 6)
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const settled = new Promise<void>(resolve => {
    const unsubscribe = loader.subscribe(IMAGE_REF.attachmentId, () => { unsubscribe(); resolve() })
  })
  pending[0]!()
  await settled
  app.requestRender()
  await vt.waitForRender()
  const after = await viewport(vt)
  const aInfo = await rowOf(vt, '🖼️ shot.png · 800×100', 'A info bar row')
  assert.ok(aInfo < bRow, `A's growth must push B down past the old cell:\n${after}`)
  // Release on the old cell: the click must NOT toggle A (the press
  // identity is B's occurrence, not the ordinal that A now owns).
  vt.sendInput(`\x1b[<0;4;${bRow}m`)
  await vt.waitForRender()
  const collapsed = (app as unknown as { collapsedOccurrences: Map<unknown, Set<number>> }).collapsedOccurrences
  assert.equal(collapsed.size, 0, `the stale live press must not toggle the earlier occurrence:\n${vt.getViewport().join('\n')}`)
  app.stop()
})

test('a later first-seen lower-index image cannot inherit an earlier occurrence\'s collapse', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 0, step: 0 } },
  ] as never[])
  const input = (chunk: AssistantLiveChunk, time: number): void => folder.applyLiveInput({
    kind: 'chunk', sessionId: 'test', attemptId: 'attempt', turn: 0, step: 0, time, chunk,
  })
  // index 1 (image B) is FIRST-SEEN and closes before index 0 (image A)
  // ever appears: the canonical DSH BlockAssembler order is first-seen
  // stream order, so B is occurrence 0 and stays occurrence 0.
  input({ type: 'block-start', index: 1, blockType: 'image' }, 3)
  input({ type: 'block-end', index: 1, block: { type: 'image', attachment: IMAGE_REF_2 } }, 4)
  folder.apply([
    { type: 'user/message', seq: 2, time: 5, data: { content: [
      { type: 'text', text: 'NEXT' },
    ], source: { kind: 'user' } } },
  ] as never[])
  app.setTranscript(folder.messages())
  const bInfo = await rowOf(vt, '🖼️ second.png · 800×100', 'B info bar')
  click(vt, 4, bInfo)
  await settleClick(vt)
  // A first-seen AFTER B was collapsed: A must NOT inherit B's collapse.
  input({ type: 'block-start', index: 0, blockType: 'image' }, 6)
  input({ type: 'block-end', index: 0, block: { type: 'image', attachment: IMAGE_REF } }, 7)
  app.setTranscript(folder.messages())
  const view = await viewport(vt)
  const aInfo = await rowOf(vt, '🖼️ shot.png · 800×100', 'A info bar')
  const bInfoAfter = await rowOf(vt, '🖼️ second.png · 800×100', 'B info bar after A first-seen')
  const nextRow = await rowOf(vt, 'NEXT', 'NEXT row')
  // B stays the FIRST block (first-seen order) and stays collapsed (only
  // the info bar, A right below it).
  assert.ok(bInfoAfter < aInfo, `B must stay the first block (first-seen order):\n${view}`)
  assert.equal(aInfo - bInfoAfter, 1, `B must stay collapsed (only the info bar above A):\n${view}`)
  // A is expanded: its image rows sit between A's info bar and NEXT.
  assert.ok(nextRow - aInfo > 2, `A must stay expanded (its image rows sit between A and NEXT):\n${view}`)
  app.setFullscreen(false)
  app.stop()
})

test('a later first-seen lower-index image cannot receive a stale press', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 0 } },
    { type: 'step/start', seq: 1, time: 2, data: { turn: 0, step: 0 } },
  ] as never[])
  const input = (chunk: AssistantLiveChunk, time: number): void => folder.applyLiveInput({
    kind: 'chunk', sessionId: 'test', attemptId: 'attempt', turn: 0, step: 0, time, chunk,
  })
  input({ type: 'block-start', index: 1, blockType: 'image' }, 3)
  input({ type: 'block-end', index: 1, block: { type: 'image', attachment: IMAGE_REF_2 } }, 4)
  folder.apply([
    { type: 'user/message', seq: 2, time: 5, data: { content: [
      { type: 'text', text: 'NEXT' },
    ], source: { kind: 'user' } } },
  ] as never[])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const bRow = await rowOf(vt, '🖼️ second.png · 800×100', 'B info bar row')
  // Press B's info bar (no release): the press identity is B's occurrence.
  vt.sendInput(`\x1b[<0;4;${bRow}M`)
  await vt.waitForRender()
  // A first-seen + closes: B stays the first block (first-seen order), so
  // the old cell is still B's — the release must act on B, never on A.
  input({ type: 'block-start', index: 0, blockType: 'image' }, 6)
  input({ type: 'block-end', index: 0, block: { type: 'image', attachment: IMAGE_REF } }, 7)
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  vt.sendInput(`\x1b[<0;4;${bRow}m`)
  await vt.waitForRender()
  const view = await viewport(vt)
  const aInfo = await rowOf(vt, '🖼️ shot.png · 800×100', 'A info bar')
  const bInfoAfter = await rowOf(vt, '🖼️ second.png · 800×100', 'B info bar after release')
  const nextRow = await rowOf(vt, 'NEXT', 'NEXT row')
  // The release collapsed B (the pressed target), never A: B is the first
  // block and collapsed; A is expanded below it.
  assert.ok(bInfoAfter < aInfo, `B must stay the first block (first-seen order):\n${view}`)
  assert.equal(aInfo - bInfoAfter, 1, `the release must collapse B (only the info bar above A):\n${view}`)
  assert.ok(nextRow - aInfo > 2, `A must stay expanded (its image rows sit between A and NEXT):\n${view}`)
  app.setFullscreen(false)
  app.stop()
})
