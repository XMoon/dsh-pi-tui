/**
 * Focus Mode fullscreen ANCHORED disclosure tests (plan §8): clicking a
 * collapsed Thought expands it and anchors the viewport at the Thought
 * header (never the tail), with follow-end disabled; clicking the
 * expanded turn's ordinary rows collapses the OWNER turn (attachment
 * hit areas win first); and resize keeps the click map aligned.
 * @module @xmoon76/dsh-pi-tui/focus-anchor.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

const T0 = Date.now() - 60_000

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

/** A settled turn whose tool result is LONG (100+ rendered rows), so the
 * expanded Thought's content far exceeds the viewport. */
function longThoughtTurn(seqBase: number): SessionEvent[] {
  const lines = Array.from({ length: 120 }, (_, i) => `result line ${i}`).join('\n')
  return [
    eventAt('turn/start', { turn: 1 }, T0, seqBase),
    eventAt('user/message', {
      id: { id: 'u1' }, role: 'user',
      content: [{ type: 'text', text: 'make it big' }],
      source: { kind: 'user' },
    }, T0 + 1, seqBase + 1),
    eventAt('tool/call', { turn: 1, step: 0, callId: CallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'seq 1 120' }) }, T0 + 2, seqBase + 2),
    eventAt('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: lines }] }],
        source: { kind: 'tool', callId: CallId('c1') },
      },
    }, T0 + 3, seqBase + 3),
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 4, seqBase + 4),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 5, seqBase + 5),
  ]
}

function show(app: TuiApp, folder: TranscriptFolder): void {
  app.setTranscript(folder.messages(), folder.turnActivities())
}

function findRow(view: readonly string[], needle: string): number {
  return view.findIndex(line => line.includes(needle))
}

function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

test('expanding a collapsed Thought in fullscreen ANCHORS the header, not the tail (plan §8.6)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(longThoughtTurn(0))
  app.setFocusMode(true)
  app.setWorking(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Scroll to the very end first: the collapsed Thought + the final answer
  // are the only rows, so the header is near the bottom.
  app.scrollToBottom()
  await vt.waitForRender()
  let view = vt.getViewport()
  const headerY = findRow(view, '▸ Thought')
  assert.ok(headerY >= 0, `collapsed Thought header missing:\n${view.join('\n')}`)
  const scroll = app.fullscreenScrollForTest()
  assert.ok(scroll !== undefined, 'fullscreen scroll must exist')
  assert.equal(scroll.isFollowingEnd, true, 'precondition: following the end')
  // Click the collapsed header.
  click(vt, 3, headerY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('▾ Thought'), `expanded symbol missing:\n${joined}`)
  // The header must be VISIBLE near the top of the viewport, and the
  // viewport must NOT be pinned to the 120-line result tail.
  const newHeaderY = findRow(view, '▾ Thought')
  assert.ok(newHeaderY >= 0 && newHeaderY < 6, `header must be near the top, at ${newHeaderY}:\n${joined}`)
  assert.ok(!joined.includes('result line 119'), `the result tail must NOT be the anchor:\n${joined}`)
  const after = app.fullscreenScrollForTest()
  assert.equal(after?.isFollowingEnd, false, 'anchor must exit follow-end (plan §8.7)')
  // The anchor must NOT be the content max: the 120-line result tail is
  // far below the header, so a max-scrolled viewport would show the tail.
  assert.ok(after !== undefined, 'scroll geometry must exist')
  assert.ok(after.scrollTop < after.maxScrollTop,
    `anchored viewport must not sit at the max (scrollTop ${after.scrollTop} >= max ${after.maxScrollTop})`)
  app.setFullscreen(false)
  app.stop()
})

test('clicking the expanded turn BODY collapses the owner Thought and keeps it visible (plan §8.8)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(longThoughtTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand by clicking the header.
  let view = vt.getViewport()
  const headerY = findRow(view, '▸ Thought')
  click(vt, 3, headerY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('▾ Thought'), 'must be expanded before the body click')
  // Click an ordinary process row of the expanded turn (a tool result
  // line, NOT an attachment).
  const bodyY = findRow(view, 'result line 2')
  assert.ok(bodyY >= 0, `expanded body row missing:\n${view.join('\n')}`)
  click(vt, 10, bodyY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('▸ Thought'), 'body click must collapse the owner turn')
  assert.ok(!joined.includes('result line 2'), `the expanded body must be gone:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

// --- attachment precedence (plan §8.3): an attachment's OWN hit area wins
// over the expanded-turn collapse ---

const IMAGE_REF = {
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 33,
  width: 800,
  height: 100,
  name: 'shot.png',
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

test('an attachment click inside an EXPANDED Thought toggles ONLY the attachment (plan §8.3/R5)', async () => {
  const { resetCapabilitiesCache, setCapabilities } = await import('@xmoon76/pi-tui')
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const vt = new VirtualTerminal(100, 30)
  const { ImageLoader } = await import('../src/image/loader.ts')
  const loader = new ImageLoader(async () => ({ ref: {}, data: pngBytes() }))
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text) => text },
  })
  app.start()
  /** The alt screen treats a fast repeat at the same cell as a double-click
   * (word selection) — pause between attachment clicks like the existing
   * collapse test. */
  const settleClick = async (): Promise<void> => {
    await new Promise(resolve => setTimeout(resolve, 600))
    await vt.waitForRender()
  }
  /** The attachment collapse state (probe — the info bar is CONSTANT, so
   * the rendered text cannot prove the image rows' state; the occurrence
   * set is the semantic truth). A COLLAPSED attachment is any set holding
   * image index 0 — an EMPTY set in the map means expanded (the map keeps
   * the message key, only the indices change). */
  const collapsedCount = (): number => {
    let total = 0
    for (const indices of (app as unknown as { collapsedOccurrences: Map<unknown, Set<number>> }).collapsedOccurrences.values()) {
      total += indices.size
    }
    return total
  }
  // A turn whose USER message carries an image (the attachment lives INSIDE
  // the turn's projected content).
  const folder = new TranscriptFolder()
  folder.apply([
    eventAt('turn/start', { turn: 2 }, T0, 100),
    eventAt('user/message', {
      id: { id: 'u2' }, role: 'user',
      content: [
        { type: 'text', text: 'look at this' },
        { type: 'image', attachment: IMAGE_REF },
      ],
      source: { kind: 'user' },
    }, T0 + 1, 101),
    eventAt('assistant/chunk', { turn: 2, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'inspecting…' } }, T0 + 2, 102),
    eventAt('tool/call', { turn: 2, step: 0, callId: CallId('c2'), name: 'read', arguments: JSON.stringify({ path: 'src/x.ts' }) }, T0 + 3, 103),
  ])
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the turn.
  let view = vt.getViewport()
  const headerY = findRow(view, '◐ Thought')
  assert.ok(headerY >= 0, `Thought header missing:\n${view.join('\n')}`)
  click(vt, 3, headerY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('▾ Thought'), 'turn must be expanded')
  // The image INFO BAR row (the attachment's own hit area) is inside the
  // expanded content: clicking it must toggle the attachment collapse,
  // NOT the whole Thought. Match the info bar (dimensions + bytes), never
  // the user bubble's inline `shot.png` text marker.
  const imageY = findRow(view, '· 800×100 · 33 B')
  assert.ok(imageY >= 0, `attachment info bar missing:\n${joined}`)
  assert.equal(collapsedCount(), 0, 'precondition: the attachment starts expanded')
  click(vt, 10, imageY + 1)
  await settleClick()
  view = vt.getViewport()
  const after = view.join('\n')
  assert.ok(after.includes('▾ Thought'), `the Thought must stay expanded after an attachment click:\n${after}`)
  assert.equal(collapsedCount(), 1, `the attachment must collapse (its own toggle):\n${after}`)
  // Click again: the attachment expands back, the Thought still expanded.
  click(vt, 10, imageY + 1)
  await settleClick()
  view = vt.getViewport()
  assert.equal(collapsedCount(), 0, `attachment must expand back:\n${view.join('\n')}`)
  assert.ok(view.join('\n').includes('▾ Thought'), `Thought must survive the second attachment click:\n${view.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('clicking the USER message or the FINAL assistant inside an expanded Thought does NOT collapse it (review P2)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  // A SHORT settled turn: the user row, the Thought, the tool result and
  // the final assistant all fit the 30-row viewport, so no scrolling is
  // needed to reach any of them.
  folder.apply([
    eventAt('turn/start', { turn: 3 }, T0, 200),
    eventAt('user/message', {
      id: { id: 'u3' }, role: 'user',
      content: [{ type: 'text', text: 'make it big' }],
      source: { kind: 'user' },
    }, T0 + 1, 201),
    eventAt('tool/call', { turn: 3, step: 0, callId: CallId('c3'), name: 'bash', arguments: JSON.stringify({ command: 'seq 1 3' }) }, T0 + 2, 202),
    eventAt('tool/result', {
      turn: 3, step: 0,
      message: {
        id: MessageId('r3'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: CallId('c3'), content: [{ type: 'text', text: '1\n2\n3' }] }],
        source: { kind: 'tool', callId: CallId('c3') },
      },
    }, T0 + 3, 203),
    eventAt('assistant/message', {
      turn: 3, step: 1,
      message: {
        id: MessageId('a3'), role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 4, 204),
    eventAt('turn/end', { turn: 3, reason: { kind: 'completed' } }, T0 + 5, 205),
  ])
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand by clicking the header.
  let view = vt.getViewport()
  const headerY = findRow(view, '▸ Thought')
  assert.ok(headerY >= 0, `Thought header missing:\n${view.join('\n')}`)
  click(vt, 3, headerY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('▾ Thought'), 'must be expanded before the body clicks')
  // The USER's own prompt is rendered before the Thought: clicking it must
  // keep the Thought expanded (it is the user's row, not revealed process
  // content).
  const userY = findRow(view, 'make it big')
  assert.ok(userY >= 0, `user row missing:\n${view.join('\n')}`)
  click(vt, 10, userY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('▾ Thought'),
    `clicking the user's own message must NOT collapse the Thought:\n${view.join('\n')}`)
  // The FINAL assistant answer is rendered after the process rows:
  // clicking it must also keep the Thought expanded.
  const finalY = findRow(view, 'Done.')
  assert.ok(finalY >= 0, `final assistant row missing:\n${view.join('\n')}`)
  click(vt, 10, finalY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('▾ Thought'),
    `clicking the final assistant must NOT collapse the Thought:\n${joined}`)
  // Sanity: clicking a real process row (a tool result line) STILL
  // collapses the owner.
  const bodyY = findRow(view, '1')
  assert.ok(bodyY >= 0, `expanded body row missing:\n${joined}`)
  click(vt, 10, bodyY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('▸ Thought'), 'a process-row click must still collapse the owner')
  app.setFullscreen(false)
  app.stop()
})
