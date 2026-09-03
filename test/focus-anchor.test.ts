/**
 * Focus Mode fullscreen disclosure tests (plan §8 + the secondary-
 * disclosure supplement): expanding a collapsed Thought in fullscreen
 * FOLLOWS THE END (the default view after expansion is the latest
 * content), the process timeline defaults to COMPACT secondaries with
 * nearest-owner click semantics (attachment > secondary > outer Thought),
 * root Collapse All resets the descendants, and resize keeps the click
 * map aligned.
 * @module @xmoon76/dsh-pi-tui/focus-anchor.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ToolCallId, MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
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

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

const T0 = Date.now() - 60_000

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

/** A settled turn whose tool result is LONG (100+ rendered rows), with an
 * intermediate assistant between the tool and the final — the tool card is
 * a SECONDARY disclosure, the intermediate assistant is a NON-secondary
 * process row. */
function longThoughtTurn(seqBase: number): SessionEvent[] {
  const lines = Array.from({ length: 120 }, (_, i) => `result line ${i}`).join('\n')
  return [
    eventAt('turn/start', { turn: 1 }, T0, seqBase),
    eventAt('user/message', {
      id: { id: 'u1' }, role: 'user',
      content: [{ type: 'text', text: 'make it big' }],
      source: { kind: 'user' },
    }, T0 + 1, seqBase + 1),
    eventAt('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'checking the projection…' } }, T0 + 2, seqBase + 2),
    eventAt('tool/call', { turn: 1, step: 0, callId: ToolCallId('c1'), name: 'bash', arguments: JSON.stringify({ command: 'seq 1 120' }) }, T0 + 3, seqBase + 3),
    eventAt('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('r1'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('c1'), content: [{ type: 'text', text: lines }] }],
        source: { kind: 'tool', callId: ToolCallId('c1') },
      },
    }, T0 + 4, seqBase + 4),
    eventAt('assistant/message', {
      turn: 1, step: 1,
      message: {
        id: MessageId('a1'), role: 'assistant',
        content: [{ type: 'text', text: 'intermediate step' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 5, seqBase + 5),
    eventAt('assistant/message', {
      turn: 1, step: 2,
      message: {
        id: MessageId('a2'), role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 6, seqBase + 6),
    eventAt('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 7, seqBase + 7),
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

test('expanding a collapsed SETTLED Thought preserves the viewport (plan 2026-08-25)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(longThoughtTurn(0))
  app.setFocusMode(true)
  app.setWorking(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // The collapsed turn is short: the header is visible at the bottom.
  app.scrollToBottom()
  await vt.waitForRender()
  let view = vt.getViewport()
  const headerY = findRow(view, '🐋 Thought')
  assert.ok(headerY >= 0, `collapsed Thought header missing:\n${view.join('\n')}`)
  const before = app.fullscreenScrollForTest()
  assert.equal(before?.isFollowingEnd, true, 'precondition: following the end')
  // Click the collapsed header: the settled Thought's expansion PRESERVES
  // the viewport (a completed Thought has no live output to chase — plan
  // 2026-08-25 §4.2) instead of jumping to the end.
  click(vt, 3, headerY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('🐳 Thought'), `expanded symbol missing:\n${joined}`)
  const after = app.fullscreenScrollForTest()
  assert.ok(after !== undefined)
  assert.equal(after.isFollowingEnd, false, 'a settled Thought expansion must disable follow-end')
  // The process timeline is COMPACT: the 120-line result stays hidden.
  assert.ok(!joined.includes('result line 50'), `the long result must stay hidden (compact secondary):\n${joined}`)
  // Full-reveal the Bash secondary, then scroll to the bottom: the result
  // TAIL is what the end of the transcript shows.
  const bashY = findRow(view, 'Bash seq 1 120')
  assert.ok(bashY >= 0, `compact Bash card missing:\n${view.join('\n')}`)
  click(vt, 10, bashY + 1)
  await vt.waitForRender()
  app.scrollToBottom()
  await vt.waitForRender()
  view = vt.getViewport()
  const expanded = view.join('\n')
  assert.ok(expanded.includes('result line 119'), `the result tail must be visible at the bottom:\n${expanded}`)
  const final = app.fullscreenScrollForTest()
  assert.equal(final?.isFollowingEnd, true, 'manual scroll to the bottom re-enables follow-end')
  app.setFullscreen(false)
  app.stop()
})

test('clicking an expanded SECONDARY body collapses only the secondary (plan §36)', async () => {
  const vt = new VirtualTerminal(100, 60)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const folder = new TranscriptFolder()
  folder.apply(longThoughtTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root.
  let view = vt.getViewport()
  let y = findRow(view, '🐋 Thought')
  assert.ok(y >= 0, `Thought header missing:\n${view.join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  // The process timeline is COMPACT: the 120-line result is NOT visible.
  assert.ok(!view.join('\n').includes('result line 50'), 'the long result must stay hidden (compact secondary)')
  // Click the compact Bash card: full reveal.
  const bashY = findRow(view, 'Bash seq 1 120')
  assert.ok(bashY >= 0, `compact Bash card missing:\n${view.join('\n')}`)
  click(vt, 10, bashY + 1)
  await vt.waitForRender()
  // The settled Thought preserved the viewport, so after the full reveal
  // scroll to the bottom: the result TAIL is what the end shows (the
  // consumer scrolls; the viewport policy never guesses — plan 2026-08-25).
  app.scrollToBottom()
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  // The viewport now shows the result TAIL — the Thought header is scrolled
  // out of view, which is the intended end-of-transcript view.
  assert.ok(joined.includes('result line 99'), `the full result must appear (tail visible):\n${joined}`)
  // Click a result line: ONLY the secondary collapses.
  const bodyY = findRow(view, 'result line 99')
  assert.ok(bodyY >= 0, `result line 99 missing:\n${view.join('\n')}`)
  click(vt, 10, bodyY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const after = view.join('\n')
  assert.ok(after.includes('🐳 Thought'), 'the root must stay open after a secondary body click')
  assert.ok(!after.includes('result line 99'), `the secondary must collapse:\n${after}`)
  assert.ok(after.includes('Bash seq 1 120'), 'the compact Bash card must remain visible')
  app.setFullscreen(false)
  app.stop()
})

test('clicking a NON-secondary process row collapses the owner Thought (plan §38)', async () => {
  const { vt, app } = startApp()
  const folder = new TranscriptFolder()
  folder.apply(longThoughtTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root.
  let view = vt.getViewport()
  let y = findRow(view, '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('🐳 Thought'), 'must be expanded before the body click')
  // The intermediate assistant is a NON-secondary process row: clicking it
  // collapses the OWNER Thought (the old body-click-collapse capability).
  const bodyY = findRow(view, 'intermediate step')
  assert.ok(bodyY >= 0, `intermediate assistant row missing:\n${view.join('\n')}`)
  click(vt, 10, bodyY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('🐋 Thought'), 'a non-secondary process row must collapse the owner Thought')
  // The process rows are gone (the collapsed card's previews are not the
  // process timeline — the compact cards' hints only exist there).
  assert.ok(!joined.includes('to expand'), `the expanded body must be gone:\n${joined}`)
  app.setFullscreen(false)
  app.stop()
})

test('root Collapse All clears the secondary expansions (plan §6/§37)', async () => {
  const vt = new VirtualTerminal(100, 60)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const folder = new TranscriptFolder()
  folder.apply(longThoughtTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root.
  let view = vt.getViewport()
  let y = findRow(view, '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  // The Thinking card is compact by default: expand BOTH secondaries
  // (Thinking + Bash) via their per-card clicks.
  view = vt.getViewport()
  const thinkingY = findRow(view, 'checking the projection')
  assert.ok(thinkingY >= 0, `compact Thinking card missing:\n${view.join('\n')}`)
  click(vt, 10, thinkingY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const bashY = findRow(view, 'Bash seq 1 120')
  click(vt, 10, bashY + 1)
  await vt.waitForRender()
  // The settled Thought preserved the viewport: scroll to the bottom to
  // SEE the full result tail (the viewport policy never auto-follows on a
  // settled expansion — plan 2026-08-25).
  app.scrollToBottom()
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('result line 99'), 'precondition: the Bash secondary is full (tail visible)')
  // Scroll back to the header before the Collapse All click.
  app.scrollToTop()
  await vt.waitForRender()
  view = vt.getViewport()
  // Click the Thought header: Collapse All.
  y = findRow(view, '🐳 Thought')
  assert.ok(y >= 0, `Thought header missing after scroll-to-top:\n${view.join('\n')}`)
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('🐋 Thought'), 'the root must collapse')
  // Reopen: the secondaries must be COMPACT again (no restored long
  // output). The reopen click lands on a DIFFERENT cell of the header row
  // (the whole row is the hit area) — the alt screen treats a fast repeat
  // at the same cell as a double-click word selection, and a fixed sleep
  // would be timing-sensitive.
  y = findRow(view, '🐋 Thought')
  click(vt, 20, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('🐳 Thought'), 'the root must reopen')
  assert.ok(!joined.includes('result line 99'), `the Bash secondary must be compact again:\n${joined}`)
  assert.ok(joined.includes('Bash seq 1 120'), 'the compact Bash card must be visible')
  assert.ok(joined.includes('(click to expand)'), 'the reopened Thinking card must be compact again (no stale override)')
  app.setFullscreen(false)
  app.stop()
})

// --- attachment precedence (plan §8.3/R5): an attachment's OWN hit area wins
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
  startedApps.add(app)
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
    eventAt('tool/call', { turn: 2, step: 0, callId: ToolCallId('c2'), name: 'read', arguments: JSON.stringify({ path: 'src/x.ts' }) }, T0 + 3, 103),
  ])
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the turn.
  let view = vt.getViewport()
  const headerY = findRow(view, '🐋 Thought')
  assert.ok(headerY >= 0, `Thought header missing:\n${view.join('\n')}`)
  click(vt, 3, headerY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('🐳 Thought'), 'turn must be expanded')
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
  assert.ok(after.includes('🐳 Thought'), `the Thought must stay expanded after an attachment click:\n${after}`)
  assert.equal(collapsedCount(), 1, `the attachment must collapse (its own toggle):\n${after}`)
  // Click again: the attachment expands back, the Thought still expanded.
  click(vt, 10, imageY + 1)
  await settleClick()
  view = vt.getViewport()
  assert.equal(collapsedCount(), 0, `attachment must expand back:\n${view.join('\n')}`)
  assert.ok(view.join('\n').includes('🐳 Thought'), `Thought must survive the second attachment click:\n${view.join('\n')}`)
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
    eventAt('tool/call', { turn: 3, step: 0, callId: ToolCallId('c3'), name: 'bash', arguments: JSON.stringify({ command: 'seq 1 3' }) }, T0 + 2, 202),
    eventAt('tool/result', {
      turn: 3, step: 0,
      message: {
        id: MessageId('r3'), role: 'user',
        content: [{ type: 'tool-result', toolCallId: ToolCallId('c3'), content: [{ type: 'text', text: '1\n2\n3' }] }],
        source: { kind: 'tool', callId: ToolCallId('c3') },
      },
    }, T0 + 3, 203),
    eventAt('assistant/message', {
      turn: 3, step: 1,
      message: {
        id: MessageId('a3'), role: 'assistant',
        content: [{ type: 'text', text: 'intermediate step' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 4, 204),
    eventAt('assistant/message', {
      turn: 3, step: 2,
      message: {
        id: MessageId('a4'), role: 'assistant',
        content: [{ type: 'text', text: 'Done.' }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      },
    }, T0 + 5, 205),
    eventAt('turn/end', { turn: 3, reason: { kind: 'completed' } }, T0 + 6, 206),
  ])
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand by clicking the header.
  let view = vt.getViewport()
  const headerY = findRow(view, '🐋 Thought')
  assert.ok(headerY >= 0, `Thought header missing:\n${view.join('\n')}`)
  click(vt, 3, headerY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('🐳 Thought'), 'must be expanded before the body clicks')
  // The USER's own prompt is rendered before the Thought: clicking it must
  // keep the Thought expanded (it is the user's row, not revealed process
  // content).
  const userY = findRow(view, 'make it big')
  assert.ok(userY >= 0, `user row missing:\n${view.join('\n')}`)
  click(vt, 10, userY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('🐳 Thought'),
    `clicking the user's own message must NOT collapse the Thought:\n${view.join('\n')}`)
  // The FINAL assistant answer is rendered after the process rows:
  // clicking it must also keep the Thought expanded.
  const finalY = findRow(view, 'Done.')
  assert.ok(finalY >= 0, `final assistant row missing:\n${view.join('\n')}`)
  click(vt, 10, finalY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const joined = view.join('\n')
  assert.ok(joined.includes('🐳 Thought'),
    `clicking the final assistant must NOT collapse the Thought:\n${joined}`)
  // Sanity: clicking a NON-secondary process row (the intermediate
  // assistant) STILL collapses the owner.
  const bodyY = findRow(view, 'intermediate step')
  assert.ok(bodyY >= 0, `intermediate assistant row missing:\n${joined}`)
  click(vt, 10, bodyY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('🐋 Thought'), 'a non-secondary process-row click must still collapse the owner')
  app.setFullscreen(false)
  app.stop()
})

test('resize keeps the click map aligned: secondary closes first, then the root (plan §43)', async () => {
  const vt = new VirtualTerminal(100, 60)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const folder = new TranscriptFolder()
  folder.apply(longThoughtTurn(0))
  app.setFocusMode(true)
  show(app, folder)
  app.setFullscreen(true)
  await vt.waitForRender()
  // Expand the root, then the Bash secondary.
  let view = vt.getViewport()
  let y = findRow(view, '🐋 Thought')
  click(vt, 3, y + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const bashY = findRow(view, 'Bash seq 1 120')
  click(vt, 10, bashY + 1)
  await vt.waitForRender()
  // The settled Thought preserved the viewport: scroll to the bottom to
  // SEE the full result tail before the resize resequence.
  app.scrollToBottom()
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('result line 99'), 'precondition: the Bash secondary is full (tail visible)')
  // Resize narrower: the rows re-wrap and the hit map must stay aligned.
  vt.resize(60, 40)
  await vt.waitForRender()
  view = vt.getViewport()
  const bodyY = findRow(view, 'result line 99')
  assert.ok(bodyY >= 0, `result line 99 missing after resize:\n${view.join('\n')}`)
  click(vt, 10, bodyY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  const after = view.join('\n')
  assert.ok(after.includes('🐳 Thought'), 'the secondary body click must close only the secondary after resize')
  assert.ok(!after.includes('result line 99'), `the secondary must collapse:\n${after}`)
  // A non-secondary process row still closes the root.
  const midY = findRow(view, 'intermediate step')
  assert.ok(midY >= 0, `intermediate assistant row missing:\n${after}`)
  click(vt, 10, midY + 1)
  await vt.waitForRender()
  view = vt.getViewport()
  assert.ok(view.join('\n').includes('🐋 Thought'), 'the non-secondary row must close the root after resize')
  app.setFullscreen(false)
  app.stop()
})
