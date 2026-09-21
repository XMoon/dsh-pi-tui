/**
 * PR4/F4 hardening: restored / windowed transcripts.
 *
 * A window projection only ever clusters and folds the rows it actually
 * contains: it never invents an off-window member, never merges across the
 * window-summary marker, and a page change refreshes the container owner
 * instead of re-applying stale disclosure state.
 * @module @xmoon76/dsh-pi-tui/compact-window-hardening.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { projectCompact } from '../src/compact-projection.ts'
import { clusterAdjacentAmbientContext } from '../src/context-presentation.ts'
import type { TranscriptMessage } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

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
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset: 'compact' } })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

const noOptions = { expandedWorkOwners: new Set<TranscriptMessage>(), expandedClusters: new Set<TranscriptMessage>(), forcedExpanded: new Set<TranscriptMessage>() }
const summaryRow = (text: string): TranscriptMessage => ({ kind: 'summary', text })
const thinking = (turn: number, text: string): TranscriptMessage => ({ kind: 'thinking', turn, text, running: false })
const tool = (turn: number, text: string): TranscriptMessage => ({ kind: 'tool', turn, name: 'read', args: '{}', result: text, status: 'ok' })
const ambient = (turn: number, label: string): TranscriptMessage => ({
  kind: 'system', turn, text: `${label} body`, label, context: true,
  contextPresentation: { form: 'instructions', sourceKind: 'plugin', role: 'inject' },
})

// --- 9.1 cluster at the window edge ---------------------------------------

test('9.1 a window clusters only the visible raw members and never invents an off-window owner', () => {
  // The original run had four ambient rows; this window starts at the third.
  const c = ambient(1, 'ctx-c')
  const d = ambient(1, 'ctx-d')
  const { clusters } = clusterAdjacentAmbientContext([c, d])
  assert.equal(clusters.length, 1)
  assert.deepEqual(clusters[0]!.members, [c, d], 'only the visible members cluster')
  assert.equal(clusters[0]!.owner, c, 'the owner is the first VISIBLE member, not the off-window one')
  assert.ok(!clusters[0]!.members.some(member => member.kind === 'system' && (member.label === 'ctx-a' || member.label === 'ctx-b')))
})

test('9.1 the window-summary marker never merges or joins an ambient run', () => {
  const a = ambient(1, 'ctx-a')
  const b = ambient(1, 'ctx-b')
  const before = clusterAdjacentAmbientContext([summaryRow('… 4 older turns'), a, b])
  assert.equal(before.clusters.length, 1, 'the summary before the run does not break the visible pair')
  assert.deepEqual(before.clusters[0]!.members, [a, b])

  const after = clusterAdjacentAmbientContext([a, summaryRow('… 4 newer turns'), b])
  assert.equal(after.clusters.length, 0, 'the summary marker ends the run: no cross-marker merge')
})

test('9.1 a page change refreshes the container owner and drops the old disclosure state', async () => {
  const { vt, app } = startApp()
  const a = ambient(1, 'ctx-a')
  const b = ambient(1, 'ctx-b')
  app.setTranscript([a, b], new Map(), { mode: 'history', endTurn: 1, firstTurn: 1, lastTurn: 1 })
  app.setFullscreen(true)
  await vt.waitForRender()
  app.toggleContextCluster(a)
  await vt.waitForRender()
  assert.equal(app.compactExpandedClustersForTest().has(a), true, 'precondition: the window-1 cluster is manually open')

  // A different page: the ambient run now starts at a fresh owner.
  const c = ambient(9, 'ctx-c')
  const d = ambient(9, 'ctx-d')
  app.setTranscript([c, d], new Map(), { mode: 'history', endTurn: 9, firstTurn: 9, lastTurn: 9 })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('▸ ') && view.includes('Context · 2 injections'),
    `the new window's cluster keeps its default collapsed presentation:\n${view}`)
  assert.ok(!app.compactExpandedClustersForTest().has(c),
    'the new owner is not pre-expanded by the stale window-1 state')
})

// --- 9.2 Work at the window edge ------------------------------------------

test('9.2 a window beginning mid-Process folds only the visible rows', () => {
  const messages = [thinking(2, 'mid-run reasoning'), tool(2, 'RESULT_MID')]
  const blocks = projectCompact(messages, noOptions)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]!.kind, 'work')
  const span = blocks[0]!.kind === 'work' ? blocks[0]!.span : undefined
  assert.deepEqual(span?.members, messages, 'the span describes exactly the projected rows')
  assert.equal(span?.owner, messages[0], 'the first visible Process row owns the span')
})

test('9.2 a window ending mid-Process keeps the single trailing row and no off-window member', () => {
  const messages = [tool(2, 'RESULT_END')]
  const blocks = projectCompact(messages, noOptions)
  const span = blocks[0]!.kind === 'work' ? blocks[0]!.span : undefined
  assert.deepEqual(span?.members, [messages[0]])
  assert.equal(span?.owner, messages[0])
})

test('9.2 a window-summary before Process never joins the Work span', () => {
  const messages = [summaryRow('… 4 older turns'), thinking(2, 'run'), tool(2, 'ok')]
  const blocks = projectCompact(messages, noOptions)
  assert.deepEqual(blocks.map(block => block.kind), ['message', 'work'])
  const span = blocks[1]!.kind === 'work' ? blocks[1]!.span : undefined
  assert.deepEqual(span?.members, [messages[1], messages[2]], 'the summary never becomes a Work member')
})

test('9.2 a Work disclosure from an older window is not re-applied to a new page owner', async () => {
  const { vt, app } = startApp()
  const oldOwner = thinking(1, 'old run')
  app.setTranscript([oldOwner, tool(1, 'old result')], new Map(), { mode: 'history', endTurn: 1, firstTurn: 1, lastTurn: 1 })
  await vt.waitForRender()
  app.toggleWorkSpan(oldOwner)
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().has(oldOwner), true)

  const newOwner = thinking(9, 'new run')
  app.setTranscript([newOwner, tool(9, 'new result')], new Map(), { mode: 'history', endTurn: 9, firstTurn: 9, lastTurn: 9 })
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().has(newOwner), false, 'the new page owner starts collapsed')
  assert.match(vt.getViewport().join('\n'), /▸ Work · 1 tool/)
})

// --- 9.3 restored legacy Context inside a window ---------------------------

test('9.3 a restored legacy Context window presents safely with no crash', async () => {
  const { vt, app } = startApp()
  const legacyRecall: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'recalled payload', context: true,
    contextPresentation: { sourceKind: 'session-reference', role: 'recall' },
  }
  const legacyNotice: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'notice payload', label: 'legacy-notice', context: true,
    contextPresentation: { form: 'notice', sourceKind: 'subagent-settled', role: 'inject' },
  }
  const unknown: TranscriptMessage = {
    kind: 'system', turn: 1, text: 'UNKNOWN_PAYLOAD', context: true,
    contextPresentation: { sourceKind: 'future-runtime-source', role: 'inject' },
  }
  app.setTranscript([summaryRow('… restored'), legacyRecall, legacyNotice, unknown], new Map(), { mode: 'history', endTurn: 1, firstTurn: 1, lastTurn: 1 })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Session recall'), `the legacy recall is recognized:\n${view}`)
  assert.ok(view.includes('legacy-notice'), 'the notice renders its header without an invented summary')
  assert.ok(view.includes('UNKNOWN_PAYLOAD'), 'an unknown form stays a standalone generic Context row')
  assert.equal(clusterAdjacentAmbientContext([legacyRecall, legacyNotice, unknown]).clusters.length, 0,
    'none of the restored rows may cluster as ambient')
})
