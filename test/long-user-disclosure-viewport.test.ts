/**
 * Long-user disclosure viewport contract: a disclosure mutation is
 * viewport-safe. A reader who was following the live tail keeps following
 * (never a historical browse), and a historical reader is restored to the
 * SAME semantic row at the same viewport offset — never a raw absolute
 * scrollTop that lands on different content after a 150→8 row shrink. The
 * ephemeral pending-user lane uses the same semantic anchor through its stable
 * pending key.
 * @module @xmoon76/dsh-pi-tui/long-user-disclosure-viewport.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import type { TranscriptMessage } from '../src/transcript.ts'
import { TuiApp, type TranscriptViewportAnchor } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(width = 100, height = 24): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

async function viewRows(vt: VirtualTerminal): Promise<string[]> {
  await vt.waitForRender()
  return vt.getViewport().map(line => stripTerminalSequences(line).replace(/[│┃█]$/, '').trimEnd())
}

function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, index) => `${prefix}${index + 1}`).join('\n')
}

function user(text: string, turn = 0): Extract<TranscriptMessage, { kind: 'user' }> {
  return { kind: 'user', turn, text }
}

function pageUp(vt: VirtualTerminal): void {
  vt.sendInput('\x1b[5~')
}

test('fullscreen: collapsing an expanded user while following the tail keeps following', async () => {
  const { vt, app } = startApp()
  app.setTranscript([user(lines(11, 'u-'), 0), { kind: 'assistant', turn: 0, text: lines(40, 'a-') }])
  app.setFullscreen(true)
  vt.sendInput('\x0f') // expand the recent user turn (the Ctrl+O master)
  await viewRows(vt)
  const expanded = app.fullscreenScrollForTest()
  assert.equal(expanded?.isFollowingEnd, true, 'precondition: the live tail is being followed')

  vt.sendInput('\x0f') // collapse the user
  const rows = await viewRows(vt)
  const after = app.fullscreenScrollForTest()
  assert.equal(after?.isFollowingEnd, true, 'a collapse must not turn the live tail into historical browsing')
  assert.ok(!rows.some(row => row.includes('↓ Latest')), 'no jump-to-latest indicator appears')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: a historical reader keeps the same semantic row across a collapse', async () => {
  const { vt, app } = startApp()
  app.setTranscript([user(lines(11, 'u-'), 0), { kind: 'assistant', turn: 0, text: lines(80, 'a-') }])
  app.setFullscreen(true)
  vt.sendInput('\x0f')
  await viewRows(vt)
  app.scrollToBottom()
  await viewRows(vt)
  pageUp(vt)
  let rows = await viewRows(vt)
  const before = app.fullscreenScrollForTest()!
  assert.equal(before.isFollowingEnd, false, 'precondition: historical browsing')
  const anchorRow = rows[1]!
  assert.ok(anchorRow.trim() !== '', `precondition: a real content row is at the top:\n${rows.join('\n')}`)
  assert.ok(!rows.some(row => row.includes('u-1')), 'precondition: the long user is above the viewport')

  vt.sendInput('\x0f') // collapse
  rows = await viewRows(vt)
  const after = app.fullscreenScrollForTest()!
  assert.equal(after.isFollowingEnd, false, 'historical browsing must stay historical')
  assert.equal(rows[1], anchorRow, `the same semantic row must stay anchored at the viewport top:\n${rows.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: a viewport inside a very long user is pulled back near its compact form', async () => {
  const { vt, app } = startApp()
  app.setTranscript([user(lines(60, 'u-'), 0), { kind: 'assistant', turn: 0, text: lines(60, 'a-') }])
  app.setFullscreen(true)
  vt.sendInput('\x0f')
  await viewRows(vt)
  app.scrollToBottom()
  await viewRows(vt)
  for (let i = 0; i < 5; i += 1) pageUp(vt)
  let rows = await viewRows(vt)
  assert.ok(rows.some(row => /u-\d+/.test(row)), `precondition: the viewport sits inside the user:\n${rows.join('\n')}`)
  assert.ok(!rows.some(row => row.includes('a-1')), 'precondition: the assistant is below the viewport')

  vt.sendInput('\x0f') // collapse
  rows = await viewRows(vt)
  const after = app.fullscreenScrollForTest()!
  assert.equal(after.isFollowingEnd, false, 'a historical viewport must not jump to the live tail')
  assert.ok(rows.some(row => row.includes('a-1')), `the viewport must return near the user's compact form:\n${rows.join('\n')}`)
  assert.ok(!rows.some(row => row.includes('a-30')), 'the viewport must not stay at the stale absolute offset')
  app.setFullscreen(false)
  app.stop()
})

test('fullscreen: the pending lane uses the stable pending key as its viewport anchor', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'assistant', turn: 0, text: lines(60, 'a-') }])
  app.setPendingInputPresentation({
    queued: [],
    steering: [{ id: 'p1', rpcId: 'r1', text: lines(60, 'p-'), status: 'steering', foldableText: true }],
    running: true,
  })
  app.setFullscreen(true)
  vt.sendInput('\x0f') // expand the pending row (the Ctrl+O master)
  await viewRows(vt)
  app.scrollToBottom()
  await viewRows(vt)
  for (let i = 0; i < 4; i += 1) pageUp(vt)
  let rows = await viewRows(vt)
  const before = app.fullscreenScrollForTest()!
  assert.equal(before.isFollowingEnd, false, 'precondition: historical browsing')
  assert.ok(rows.some(row => /p-\d+/.test(row)), `precondition: the viewport sits inside the pending row:\n${rows.join('\n')}`)
  const anchorRow = rows[1]!

  vt.sendInput('\x0f') // collapse
  rows = await viewRows(vt)
  const after = app.fullscreenScrollForTest()!
  assert.equal(after.isFollowingEnd, false, 'historical browsing must stay historical')
  assert.equal(rows[1], anchorRow, `the pending row must anchor the same semantic line:\n${rows.join('\n')}`)
  app.setFullscreen(false)
  app.stop()
})

test('an unresolved pending-user anchor never copies the pre-mutation absolute offset', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'assistant', turn: 0, text: lines(60, 'a-') }])
  app.setPendingInputPresentation({
    queued: [],
    steering: [{ id: 'p1', rpcId: 'gone', text: lines(20, 'p-'), status: 'steering', foldableText: true }],
    running: true,
  })
  app.setFullscreen(true)
  vt.sendInput('\x0f')
  await viewRows(vt)

  // The pending row leaves the lane (its durable message materialized), and
  // the live position moves far away from the captured absolute scrollTop.
  app.setPendingInputPresentation({ queued: [], steering: [], running: false })
  app.scrollToBottom()
  await viewRows(vt)
  const before = app.fullscreenScrollForTest()!
  assert.ok(before.maxScrollTop > 1, `precondition: a scrollable document away from the stale offset (${before.maxScrollTop})`)

  const stale: TranscriptViewportAnchor = {
    scrollTop: 1,
    top: { rowKind: 'pending-user', pendingKey: 'rpc:gone', occurrence: 0, rowOffset: 0, viewportOffset: 0 },
  }
  assert.equal(app.restoreTranscriptViewportAnchor(stale, 'top'), false, 'an unresolved pending anchor reports failure')
  const after = app.fullscreenScrollForTest()!
  assert.equal(after.scrollTop, before.scrollTop, 'the viewport must not jump to the stale absolute offset')
  app.setFullscreen(false)
  app.stop()
})
