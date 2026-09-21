/**
 * PR4/F4 hardening: search / disclosure ownership across surface transitions
 * and topology mutation. The reveal resolution and the dismissal promotion
 * read the SAME owner (`searchRevealOwnerFor`), a FLAT regular cluster never
 * mints an inoperable owner, and a structural rebuild re-resolves the current
 * container instead of a stale synthetic identity.
 * @module @xmoon76/dsh-pi-tui/compact-search-hardening.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { TranscriptMessage } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import type { DisplayState } from '../src/display-preset.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function startApp(preset: DisplayState['preset'] = 'compact'): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset } })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function clusterHeaderCount(view: string, expanded?: boolean): number {
  const glyph = expanded === undefined ? '(?:▸|▾)' : expanded ? '▾' : '▸'
  return view.split('\n').filter(line => new RegExp(`^\\s*${glyph} .*Context ·`).test(line)).length
}

function workHeaderCount(view: string, expanded?: boolean): number {
  const glyph = expanded === undefined ? '(?:▸|▾)' : expanded ? '▾' : '▸'
  return view.split('\n').filter(line => new RegExp(`^\\s*${glyph} Work(?: ·|$)`).test(line)).length
}

const ambient = (label: string, form: 'instructions' | 'catalog' | 'snapshot', text: string): TranscriptMessage => ({
  kind: 'system', turn: 1, text, label, context: true,
  contextPresentation: { form, sourceKind: 'plugin', role: 'inject' },
})

function targetFor(message: TranscriptMessage, query: string): {
  query: string
  match: { id: number; turn: number; occurrence: number; source: { kind: 'message' }; sourceOccurrence: number }
  message: TranscriptMessage
} {
  return {
    query,
    match: { id: 0, turn: 'turn' in message ? message.turn : 1, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message,
  }
}

// --- 7.3 surface transition while search is open ---------------------------

test('7.3 fullscreen cluster reveal -> regular -> dismiss never strands an owner', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const first = ambient('AGENTS.md', 'instructions', 'instructions body')
  const second = ambient('skill-catalog', 'catalog', 'CLUSTER_MEMBER_MARKER')
  app.setTranscript([first, second], new Map())
  await vt.waitForRender()
  assert.equal(clusterHeaderCount(vt.getViewport().join('\n')), 1, 'precondition: fullscreen collapses the cluster')

  app.setTranscriptSearchTarget(targetFor(second, 'CLUSTER_MEMBER_MARKER'))
  await vt.waitForRender()
  assert.equal(clusterHeaderCount(vt.getViewport().join('\n'), true), 1, 'the reveal opens the cluster')
  assert.equal(app.compactExpandedClustersForTest().size, 0, 'the reveal is presentation-only')

  // The surface loses its manual cluster owner: the members present flat and
  // the inoperable owner must NOT be promoted by the dismissal.
  app.setFullscreen(false)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.equal(clusterHeaderCount(view), 0, `regular presents flat:\n${view}`)
  assert.ok(view.includes('CLUSTER_MEMBER_MARKER'), 'the searched member is visible without a header affordance')

  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await vt.waitForRender()
  assert.equal(app.compactExpandedClustersForTest().size, 0, 'no owner is promoted on the inoperable surface')

  app.setFullscreen(true)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.equal(clusterHeaderCount(view, true), 0, `returning to fullscreen keeps the default collapsed state:\n${view}`)
  assert.equal(clusterHeaderCount(view, false), 1)
})

test('7.3 regular search -> fullscreen -> dismiss keeps a reachable, operable owner', async () => {
  const { vt, app } = startApp()
  const first = ambient('AGENTS.md', 'instructions', 'instructions body')
  const second = ambient('skill-catalog', 'catalog', 'CLUSTER_MEMBER_MARKER')
  app.setTranscript([first, second], new Map())
  await vt.waitForRender()
  // Regular: flat, the member is already visible.
  assert.equal(clusterHeaderCount(vt.getViewport().join('\n')), 0)

  app.setTranscriptSearchTarget(targetFor(second, 'CLUSTER_MEMBER_MARKER'))
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.equal(clusterHeaderCount(view, true), 1, `the capability is rechecked: the cluster opens on fullscreen:\n${view}`)
  assert.ok(view.includes('CLUSTER_MEMBER_MARKER'), 'the matched member is not hidden without an affordance')

  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await vt.waitForRender()
  assert.equal(app.compactExpandedClustersForTest().size, 1, 'the operable fullscreen owner is promoted on dismiss')
  view = vt.getViewport().join('\n')
  assert.equal(clusterHeaderCount(view, true), 1, `the promoted cluster stays open:\n${view}`)
  assert.ok(view.includes('CLUSTER_MEMBER_MARKER'))
})

// --- 7.1 regular flat cluster repeat search/dismiss -------------------------

test('7.1 a flat regular cluster never mints a persistent owner across repeated search cycles', async () => {
  const { vt, app } = startApp()
  const first = ambient('AGENTS.md', 'instructions', 'instructions body')
  const second = ambient('skill-catalog', 'catalog', 'CLUSTER_MEMBER_MARKER')
  app.setTranscript([first, second], new Map())
  await vt.waitForRender()

  for (let cycle = 0; cycle < 3; cycle += 1) {
    app.setTranscriptSearchTarget(targetFor(second, 'CLUSTER_MEMBER_MARKER'))
    await vt.waitForRender()
    assert.equal(app.compactExpandedClustersForTest().size, 0, `cycle ${cycle}: the reveal stays presentation-only`)
    app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
    await vt.waitForRender()
    assert.equal(app.compactExpandedClustersForTest().size, 0, `cycle ${cycle}: a flat cluster hides nothing, so no owner is minted`)
    assert.ok(vt.getViewport().join('\n').includes('CLUSTER_MEMBER_MARKER'), `cycle ${cycle}: the member stays visible`)
  }

  app.setFullscreen(true)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.equal(clusterHeaderCount(view, true), 0,
    `no stale expanded override survives the surface switch:\n${view}`)
  assert.equal(clusterHeaderCount(view, false), 1, `the fullscreen cluster keeps its default collapsed state:\n${view}`)
})

// --- 7.2 fullscreen collapsed cluster vs manual ownership -------------------

test('7.2 a manually opened cluster stays open through search reveal and dismiss', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  const first = ambient('AGENTS.md', 'instructions', 'instructions body')
  const second = ambient('skill-catalog', 'catalog', 'CLUSTER_MEMBER_MARKER')
  app.setTranscript([first, second], new Map())
  await vt.waitForRender()
  app.toggleContextCluster(first)
  await vt.waitForRender()
  assert.equal(app.compactExpandedClustersForTest().has(first), true, 'precondition: the cluster is manually open')

  app.setTranscriptSearchTarget(targetFor(second, 'CLUSTER_MEMBER_MARKER'))
  await vt.waitForRender()
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await vt.waitForRender()
  assert.equal(app.compactExpandedClustersForTest().has(first), true, 'search never overwrites user ownership')
  const view = vt.getViewport().join('\n')
  assert.equal(clusterHeaderCount(view, true), 1, `the manually open cluster stays open:\n${view}`)
  assert.ok(view.includes('CLUSTER_MEMBER_MARKER'))
})

// --- 7.4 Work search restoration -------------------------------------------
test('7.4 an already-open Work span stays open through search reveal and dismiss', async () => {
  const { vt, app } = startApp()
  const owner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'open reasoning' }
  const child: TranscriptMessage = { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'CHILD_MARKER', status: 'ok' }
  app.setTranscript([owner, child], new Map())
  app.setFullscreen(true)
  await vt.waitForRender()
  app.toggleWorkSpan(owner)
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 1, 'precondition: the span is manually open')
  assert.ok(vt.getViewport().join('\n').includes('Read {}'), 'the open span shows its member card')

  app.setTranscriptSearchTarget(targetFor(child, 'CHILD_MARKER'))
  await vt.waitForRender()
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await vt.waitForRender()
  assert.equal(workHeaderCount(vt.getViewport().join('\n'), true), 1, 'the span stays manually open')
  assert.ok(vt.getViewport().join('\n').includes('Read {}'))
})

test('7.4 a closed Work span re-collapses after a search reveal is dismissed', async () => {
  const { vt, app } = startApp()
  const owner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'closed reasoning' }
  const child: TranscriptMessage = { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'CHILD_MARKER', status: 'ok' }
  app.setTranscript([owner, child], new Map())
  app.setFullscreen(true)
  await vt.waitForRender()
  assert.equal(workHeaderCount(vt.getViewport().join('\n'), false), 1, 'precondition: the span is collapsed')

  app.setTranscriptSearchTarget(targetFor(child, 'CHILD_MARKER'))
  await vt.waitForRender()
  assert.equal(workHeaderCount(vt.getViewport().join('\n'), true), 1, 'the reveal opens the span')
  app.finishTranscriptSearchPresentation(new Set())
  await vt.waitForRender()
  assert.equal(workHeaderCount(vt.getViewport().join('\n'), true), 0, 'an ordinary dismiss restores the collapsed state')
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0)
})

// --- 7.5 search during topology mutation ------------------------------------

test('7.5 an Assistant boundary during a Work search re-resolves the owning container', async () => {
  const { vt, app } = startApp()
  const firstOwner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'first run reasoning' }
  const target: TranscriptMessage = { kind: 'tool', turn: 1, name: 'read', args: '{}', result: 'TARGET_MARKER', status: 'ok' }
  app.setTranscript([firstOwner, target], new Map())
  app.setFullscreen(true)
  await vt.waitForRender()
  app.setTranscriptSearchTarget(targetFor(target, 'TARGET_MARKER'))
  await vt.waitForRender()
  assert.equal(workHeaderCount(vt.getViewport().join('\n'), true), 1, 'the first run is open and shows the target')

  // A Conversation boundary splits the run: the target now belongs to a NEW
  // span whose owner is the target itself. The reveal must re-resolve against
  // the CURRENT projection, never a stale synthetic identity.
  const boundary: TranscriptMessage = { kind: 'assistant', turn: 1, text: 'intermediate narration' }
  app.setTranscript([firstOwner, boundary, target], new Map())
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Read {}'), `the revealed target card stays reachable after the split:\n${view}`)
  assert.ok(view.includes('intermediate narration'), 'the boundary renders as a standalone row')
  assert.equal(workHeaderCount(view, true), 1, 'exactly the new owning span is open')
  assert.equal(workHeaderCount(view, false), 1, 'the old span stays collapsed')
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0, 'the reveal is still presentation-only')

  // Dismissal promotes the CURRENT container (the new span owner), never the
  // stale one, so the target row remains user-controllable.
  app.finishTranscriptSearchPresentation(new Set(), { preserveCurrentReveal: true })
  await vt.waitForRender()
  const owners = app.compactExpandedWorkOwnersForTest()
  assert.equal(owners.size, 1)
  assert.equal(owners.has(target), true, 'the promoted owner is the current container owner')
  view = vt.getViewport().join('\n')
  assert.equal(workHeaderCount(view, true), 1, `the promoted span stays open:\n${view}`)
  assert.ok(view.includes('Read {}'))
})

test('7.5 a Preparing-to-pending transition during search leaves no stale owner target', async () => {
  const { vt, app } = startApp()
  const owner: TranscriptMessage = { kind: 'thinking', turn: 1, text: 'run reasoning' }
  app.setTranscript([owner], new Map(), undefined, [
    { callId: 'p-topology', argumentBytes: 3, turn: 1, step: 0, index: 0, name: 'bash', summary: 'topology call' },
  ])
  app.setFullscreen(true)
  await vt.waitForRender()
  app.setTranscriptSearchTarget(targetFor(owner, 'run reasoning'))
  await vt.waitForRender()
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0, 'the reveal opens exactly the owning span')

  // The live call becomes a PENDING Work after the boundary: the search target
  // stays durable, the structural rebuild refreshes geometry, no crash.
  app.setTranscript([
    owner,
    { kind: 'assistant', turn: 1, text: 'boundary' },
  ], new Map(), undefined, [
    { callId: 'p-topology', argumentBytes: 3, turn: 1, step: 0, index: 0, name: 'bash', summary: 'topology call' },
  ])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('run reasoning'), `the durable search target stays reachable:\n${view}`)
  assert.equal(view.split('\n').filter(line => line.includes('Preparing')).length, 1,
    `the pending Work renders exactly once:\n${view}`)
  assert.equal(app.compactExpandedWorkOwnersForTest().size, 0, 'no stale owner is written by the rebuild')
})
