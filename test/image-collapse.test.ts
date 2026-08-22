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
import test from 'node:test'
import { resetCapabilitiesCache, setCapabilities } from '@xmoon76/pi-tui'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { ImageLoader } from '../src/image/loader.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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
  const view = await viewport(vt)
  const index = view.split('\n').findIndex(line => line.includes(needle))
  assert.ok(index !== -1, `${label}: row ${JSON.stringify(needle)} missing:\n${view}`)
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
    { type: 'tool/call', seq: 1, time: 1, data: { callId: 'call-1', name: 'screenshot_tool', arguments: [] } } as never,
    { type: 'tool/result', seq: 2, time: 2, data: { callId: 'call-1', message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: [
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
