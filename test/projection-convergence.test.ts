/**
 * PR5/F5 Projection Convergence.
 *
 * The canonical transcript structure (`transcript-projection.ts`) is the ONE
 * authority for where a raw chronology forms a Work span, a Context cluster
 * and a surfaced-interaction boundary. Compact, Full and expanded Focus
 * materialize that same structure with different presentation depth; none of
 * them may re-derive the boundaries. This suite is the semantic oracle future
 * disclosure/search work (F6) builds on.
 * @module @xmoon76/dsh-pi-tui/projection-convergence.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { projectCompact } from '../src/compact-projection.ts'
import { summarizeWorkSpan } from '../src/compact-work.ts'
import { clusterAdjacentAmbientContext } from '../src/context-presentation.ts'
import { focusExpandedTailStructure, focusThoughtLeadBoundary, projectFocus } from '../src/focus-activity.ts'
import {
  clusterByMemberOf,
  isTranscriptWorkMember,
  projectTranscriptStructure,
  type TranscriptStructureBlock,
  type TranscriptWorkSpan,
} from '../src/transcript-projection.ts'
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

const TURN = 1

const user = (text: string): TranscriptMessage => ({ kind: 'user', turn: TURN, text })
const thinking = (text: string): TranscriptMessage => ({ kind: 'thinking', turn: TURN, text, running: false })
const tool = (name: string, result: string): TranscriptMessage => ({
  kind: 'tool', turn: TURN, name, args: '{}', result, status: 'ok',
})
const assistant = (text: string): TranscriptMessage => ({ kind: 'assistant', turn: TURN, text })
const ambient = (label: string, form: 'instructions' | 'catalog' | 'snapshot'): TranscriptMessage => ({
  kind: 'system', turn: TURN, text: `${label} body`, label, context: true,
  contextPresentation: { form, sourceKind: 'plugin', role: 'inject' },
})
const notice = (label: string): TranscriptMessage => ({
  kind: 'system', turn: TURN, text: `${label} notice`, label, context: true,
  contextPresentation: { form: 'notice', sourceKind: 'subagent-settled', role: 'inject' },
})
const relay = (): TranscriptMessage => ({
  kind: 'system', turn: TURN, text: 'relay body', context: true,
  contextPresentation: { form: 'relay', sourceKind: 'agent-message', role: 'inject' },
})
const interaction = (name: 'ask_user_question' | 'exit_plan_mode'): TranscriptMessage => ({
  kind: 'tool', turn: TURN, name, args: '{}', result: 'ok', status: 'ok',
})

interface ConvergenceFixture {
  readonly messages: TranscriptMessage[]
  readonly rows: {
    readonly user: TranscriptMessage
    readonly thinkA: TranscriptMessage
    readonly toolA: TranscriptMessage
    readonly intermediate: TranscriptMessage
    readonly ambient1: TranscriptMessage
    readonly ambient2: TranscriptMessage
    readonly thinkB: TranscriptMessage
    readonly toolB: TranscriptMessage
    readonly notice: TranscriptMessage
    readonly thinkC: TranscriptMessage
    readonly question: TranscriptMessage
    readonly thinkD: TranscriptMessage
    readonly toolD: TranscriptMessage
    readonly relay: TranscriptMessage
    readonly thinkE: TranscriptMessage
    readonly plan: TranscriptMessage
    readonly thinkF: TranscriptMessage
    readonly toolF: TranscriptMessage
    readonly final: TranscriptMessage
  }
}

/** The comprehensive raw chronology: Process runs split by Conversation,
 * ambient Context, notice, relay, and both settled surfaced interactions. */
function convergenceFixture(): ConvergenceFixture {
  const rows = {
    user: user('prompt'),
    thinkA: thinking('A'),
    toolA: tool('read', 'A'),
    intermediate: assistant('intermediate narration'),
    ambient1: ambient('AGENTS.md', 'instructions'),
    ambient2: ambient('skill-catalog', 'catalog'),
    thinkB: thinking('B'),
    toolB: tool('bash', 'B'),
    notice: notice('job'),
    thinkC: thinking('C'),
    question: interaction('ask_user_question'),
    thinkD: thinking('D'),
    toolD: tool('edit', 'D'),
    relay: relay(),
    thinkE: thinking('E'),
    plan: interaction('exit_plan_mode'),
    thinkF: thinking('F'),
    toolF: tool('grep', 'F'),
    final: assistant('final answer'),
  }
  const messages = [
    rows.user,
    rows.thinkA, rows.toolA,
    rows.intermediate,
    rows.ambient1, rows.ambient2,
    rows.thinkB, rows.toolB,
    rows.notice,
    rows.thinkC,
    rows.question,
    rows.thinkD, rows.toolD,
    rows.relay,
    rows.thinkE,
    rows.plan,
    rows.thinkF, rows.toolF,
    rows.final,
  ]
  return { messages, rows }
}

function flattenStructure(structure: readonly TranscriptStructureBlock[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const block of structure) {
    if (block.kind === 'message') out.push(block.message)
    else if (block.kind === 'work') out.push(...block.span.members)
    else out.push(...block.cluster.members)
  }
  return out
}

function workSpansOf(structure: readonly TranscriptStructureBlock[]): TranscriptWorkSpan[] {
  return structure.flatMap(block => block.kind === 'work' ? [block.span] : [])
}

function assertSameSpans(left: readonly TranscriptWorkSpan[], right: readonly TranscriptWorkSpan[]): void {
  assert.equal(left.length, right.length, 'same Work span count')
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    assert.equal(a.owner, b.owner, `span ${index}: same owner identity`)
    assert.equal(a.turn, b.turn, `span ${index}: same turn`)
    assert.equal(a.members.length, b.members.length, `span ${index}: same member count`)
    for (let member = 0; member < a.members.length; member += 1) {
      assert.equal(a.members[member], b.members[member], `span ${index}: member ${member} keeps raw identity and order`)
    }
  }
}

// --- Canonical structure ---------------------------------------------------

test('the canonical structure segments the comprehensive fixture into the exact boundary sequence', () => {
  const { messages } = convergenceFixture()
  const kinds = projectTranscriptStructure(messages).map(block => block.kind)
  assert.deepEqual(kinds, [
    'message',      // user
    'work',         // A
    'message',      // intermediate assistant
    'context-cluster', // ambient 1+2
    'work',         // B
    'message',      // notice
    'work',         // C
    'message',      // settled question
    'work',         // D
    'message',      // relay
    'work',         // E
    'message',      // settled plan review
    'work',         // F
    'message',      // final
  ])
})

test('the canonical structure partitions the raw window exactly: no row dropped, duplicated or reordered', () => {
  const { messages } = convergenceFixture()
  const flattened = flattenStructure(projectTranscriptStructure(messages))
  assert.equal(flattened.length, messages.length)
  for (let index = 0; index < messages.length; index += 1) {
    assert.equal(flattened[index], messages[index], `row ${index} keeps its exact identity and position`)
  }
})

test('Work owner and members always reference the original rows; the owner is the first member', () => {
  const { messages } = convergenceFixture()
  const spans = workSpansOf(projectTranscriptStructure(messages))
  assert.equal(spans.length, 6, 'A/B/C/D/E/F')
  for (const span of spans) {
    assert.equal(span.owner, span.members[0], 'the owner is the first raw member')
    assert.ok(span.members.every(member => messages.includes(member)), 'every member is an original row')
  }
})

test('isTranscriptWorkMember accepts Process rows and rejects settled surfaced interactions', () => {
  assert.equal(isTranscriptWorkMember(thinking('x')), true)
  assert.equal(isTranscriptWorkMember(tool('read', 'ok')), true)
  assert.equal(isTranscriptWorkMember(assistant('x')), false)
  assert.equal(isTranscriptWorkMember(ambient('AGENTS.md', 'instructions')), false)
  // A settled question / plan review is a boundary; a running one stays Process.
  assert.equal(isTranscriptWorkMember(interaction('ask_user_question')), false)
  assert.equal(isTranscriptWorkMember(interaction('exit_plan_mode')), false)
  const running: TranscriptMessage = { kind: 'tool', turn: TURN, name: 'ask_user_question', args: '{}', result: '', status: 'running' }
  assert.equal(isTranscriptWorkMember(running), true)
  // A turn-less row (window summary) never enters Work.
  assert.equal(isTranscriptWorkMember({ kind: 'summary', text: 'older turns' }), false)
})

test('the canonical structure owns both Work and cluster membership', () => {
  const { messages } = convergenceFixture()
  const structure = projectTranscriptStructure(messages)
  const canonical = clusterByMemberOf(structure)
  const expected = clusterAdjacentAmbientContext(messages)
  assert.equal(canonical.size, expected.byMember.size, 'every clustered member is present')
  for (const [member, cluster] of expected.byMember) {
    const found = canonical.get(member)
    assert.ok(found !== undefined, 'the canonical structure exposes a cluster for every clustered member')
    assert.equal(found.owner, cluster.owner, 'same cluster owner identity')
    assert.deepEqual(found.members, cluster.members, 'same member order')
  }
  const clusterBlocks = structure.filter(block => block.kind === 'context-cluster')
  assert.equal(clusterBlocks.length, 1)
  assert.equal(clusterBlocks[0]!.kind === 'context-cluster' ? clusterBlocks[0]!.cluster.members.length : -1, 2)
})

test('a hidden Process row between two ambient rows never clusters (raw adjacency authority)', () => {
  const first = ambient('AGENTS.md', 'instructions')
  const second = ambient('skill-catalog', 'catalog')
  const structure = projectTranscriptStructure([first, thinking('between'), second])
  assert.deepEqual(structure.map(block => block.kind), ['message', 'work', 'message'], 'no false cluster')
  assert.equal(clusterByMemberOf(structure).size, 0)
  // The same rows ARE raw-adjacent and cluster.
  assert.equal(projectTranscriptStructure([first, second])[0]!.kind, 'context-cluster')
})

// --- Compact consumes the canonical structure ------------------------------

test('Compact materializes exactly the canonical Work spans (owner and member identity)', () => {
  const { messages } = convergenceFixture()
  const canonical = workSpansOf(projectTranscriptStructure(messages))
  const compact = projectCompact(messages, {
    expandedWorkOwners: new Set(), expandedClusters: new Set(), forcedExpanded: new Set(),
  }).flatMap(block => block.kind === 'work' ? [block.span] : [])
  assertSameSpans(compact, canonical)
})

test('a settled interaction is never a Work member, count or Tool preview in any projection', () => {
  const { messages, rows } = convergenceFixture()
  const structure = projectTranscriptStructure(messages)
  for (const span of workSpansOf(structure)) {
    assert.ok(!span.members.includes(rows.question), 'the settled question never joins a span')
    assert.ok(!span.members.includes(rows.plan), 'the settled Plan review never joins a span')
    const summary = summarizeWorkSpan(span)
    assert.notEqual(summary.tool?.name, 'ask_user_question')
    assert.notEqual(summary.tool?.name, 'exit_plan_mode')
  }
  // The question and plan review are standalone message blocks in raw order.
  const blocks = projectCompact(messages, {
    expandedWorkOwners: new Set(), expandedClusters: new Set(), forcedExpanded: new Set(),
  })
  assert.deepEqual(blocks.map(block => block.kind), [
    'message', 'work', 'message', 'context-cluster', 'work', 'message', 'work', 'message',
    'work', 'message', 'work', 'message', 'work', 'message',
  ])
  const standalone = blocks.flatMap(block => block.kind === 'message' ? [block.message] : [])
  assert.equal(standalone.indexOf(rows.question), 3, 'the question renders standalone between Work C and Work D')
  assert.equal(standalone.indexOf(rows.plan), 5, 'the plan review renders standalone between Work E and Work F')
})

// --- Full consumes the canonical structure ---------------------------------

test('Full materialization is the canonical flat chronology: Work expands, no Work chrome', () => {
  const { messages } = convergenceFixture()
  // Full is the canonical structure with Work flattened and clusters presented
  // by surface capability. Its message chronology MUST equal the raw window.
  const flattened = flattenStructure(projectTranscriptStructure(messages))
  assert.deepEqual(flattened, messages)
})

// --- Expanded Focus consumes the canonical structure -----------------------

test('expanded Focus materializes the canonical tail structure as nested Work (boundary identity, not strings)', () => {
  const { messages } = convergenceFixture()
  // The tail slice segments IDENTICALLY to the full window: same Work owners,
  // same members, same boundary sequence (plan §25). This pins the segmentation
  // contract the Focus tail consumes; display strings are deliberately not
  // compared. F6 emits each canonical span as a nested Work container, so the
  // emitted row chronology is recovered by flattening those spans.
  const boundary = focusThoughtLeadBoundary(messages)
  const tailStructure = focusExpandedTailStructure(messages, boundary)
  assertSameSpans(workSpansOf(tailStructure), workSpansOf(projectTranscriptStructure(messages)))

  const tailRows = flattenStructure(tailStructure)
  const prefix = messages.slice(0, messages.length - tailRows.length)
  const expected = [...prefix, ...tailRows]
  const blocks = projectFocus(messages, new Map(), new Set([TURN]), true)
  const emitted = blocks.flatMap(block => block.kind === 'work'
    ? [...block.span.members]
    : block.kind === 'message' ? [block.message] : [])
  assert.equal(emitted.length, messages.length, 'every row is emitted exactly once')
  for (let index = 0; index < prefix.length; index += 1) {
    assert.equal(emitted[index], prefix[index], `the lead prefix is emitted verbatim at row ${index}`)
  }
  for (let index = prefix.length; index < messages.length; index += 1) {
    assert.equal(emitted[index], expected[index], `expanded Focus keeps the canonical chronology at row ${index}`)
  }
  assert.ok(blocks.some(block => block.kind === 'work'), 'expanded Focus materializes nested canonical Work')
})

test('expanded Focus emits nested Work containers and leaves persistent rows outside them', () => {
  const { messages, rows } = convergenceFixture()
  const blocks = projectFocus(messages, new Map(), new Set([TURN]), true)
  // F6 materializes every canonical Process run as a nested Work container
  // owned by the expanded Thought; its members no longer appear as flat rows.
  const workBlocks = blocks.filter(block => block.kind === 'work')
  assert.ok(workBlocks.length > 0, 'expanded Focus materializes canonical Work')
  const workMembers = new Set<TranscriptMessage>()
  for (const block of workBlocks) {
    if (block.kind !== 'work') continue
    assert.equal(block.focusOwnerTurn, TURN, 'nested Work belongs to the expanded Thought')
    for (const member of block.span.members) workMembers.add(member)
  }
  for (const process of [rows.thinkA, rows.toolA, rows.thinkB, rows.toolB, rows.thinkC, rows.thinkD, rows.toolD, rows.thinkE, rows.thinkF, rows.toolF]) {
    assert.equal(workMembers.has(process), true, 'each Process row is a member of a nested Work span')
  }
  const containerOf = (message: TranscriptMessage): readonly { kind: string }[] | undefined => {
    const block = blocks.find(candidate => candidate.kind === 'message' && candidate.message === message)
    return block?.kind === 'message' ? block.containerPath : undefined
  }
  for (const persistent of [rows.user, rows.ambient1, rows.ambient2, rows.notice, rows.question, rows.relay, rows.plan]) {
    assert.equal(containerOf(persistent), undefined, 'a persistent row is never owned by the Thought container')
  }
})

// --- Preparing convergence (plan §29) --------------------------------------

test('the canonical trailing Work is the Preparing run owner and every boundary closes it', () => {
  const run = [thinking('run reasoning'), tool('read', 'ok')]
  const open = projectTranscriptStructure(run)
  const trailing = open.at(-1)
  assert.ok(trailing?.kind === 'work', 'the trailing Process run is a Work span')
  assert.equal(trailing.kind === 'work' ? trailing.span.owner : undefined, run[0], 'the run owner is the first Process row')
  assert.equal(trailing.kind === 'work' ? trailing.span.members.at(-1) : undefined, run[1], 'the last member is the trailing Process row')
  // The live Preparing ownership reads the SAME predicate, so an open run is
  // exactly one whose trailing row is a Work member.
  assert.equal(isTranscriptWorkMember(run[1]!), true)

  // Every semantic boundary closes the trailing run, so a following live call
  // starts a NEW pending Work instead of jumping back before it.
  const boundaries: TranscriptMessage[] = [
    assistant('turn done'),
    interaction('ask_user_question'),
    interaction('exit_plan_mode'),
    ambient('AGENTS.md', 'instructions'),
    notice('job settled'),
  ]
  for (const boundary of boundaries) {
    const structure = projectTranscriptStructure([...run, boundary])
    assert.equal(structure.at(-1)?.kind, 'message', `a ${boundary.kind} boundary ends the trailing Work run`)
    assert.equal(isTranscriptWorkMember(boundary), false, 'the boundary row is never a Work member')
  }
})

// --- Surface presentation --------------------------------------------------

function startApp(preset: 'focus' | 'compact' | 'full'): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(120, 40)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset } })
  app.start()
  startedApps.add(app)
  return { vt, app }
}

function show(app: TuiApp, messages: readonly TranscriptMessage[]): void {
  app.setTranscript(messages, new Map())
}

const workHeader = (view: string): boolean => view.split('\n').some(line => /^\s*[▸▾] Work(?: ·|$)/.test(line))

/** A short window that fits one viewport: one Work span, one ambient cluster
 * and a trailing Work span, so surface presentation is directly observable. */
function surfaceFixture(): { messages: TranscriptMessage[]; process: TranscriptMessage } {
  const process = tool('read', 'SURFACE_TOOL')
  const messages = [
    user('prompt'),
    thinking('surface reasoning'),
    process,
    ambient('AGENTS.md', 'instructions'),
    ambient('skill-catalog', 'catalog'),
    thinking('tail reasoning'),
    tool('bash', 'TAIL_TOOL'),
    assistant('surface final'),
  ]
  return { messages, process }
}

test('regular Full renders no Work chrome and collapses ambient clusters behind an operable header', async () => {
  const { vt, app } = startApp('full')
  const { messages } = surfaceFixture()
  show(app, messages)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!workHeader(view), `Full never adds a Work header:\n${view}`)
  // Context is not Process: after F6 the regular surface has a keyboard cluster
  // owner, so Full collapses the cluster without changing its Process default.
  assert.ok(view.includes('Context · 2 injections'), `regular Full collapses the cluster behind its header:\n${view}`)
  assert.ok(view.includes('Read {}'), 'Process rows render in full detail')
  assert.ok(view.includes('surface reasoning'), 'Thinking renders in full detail')
})

test('fullscreen Full keeps the existing collapsed cluster header and still no Work chrome', async () => {
  const { vt, app } = startApp('full')
  const { messages } = surfaceFixture()
  show(app, messages)
  app.setFullscreen(true)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!workHeader(view), `Full never adds a Work header:\n${view}`)
  assert.ok(view.includes('Context · 2 injections'), `fullscreen Full collapses the cluster behind its header:\n${view}`)
})

test('a Full search never mints a Work disclosure owner (Work is flat)', async () => {
  const { vt, app } = startApp('full')
  const { messages, process } = surfaceFixture()
  show(app, messages)
  app.setFullscreen(true)
  await vt.waitForRender()
  app.setTranscriptSearchTarget({
    query: 'SURFACE_TOOL',
    match: { id: 0, turn: TURN, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: process,
  })
  await vt.waitForRender()
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'Full has no Work disclosure owner')
  assert.equal(app.expandedContextClusterOwnersForTest().size, 0, 'a Process target is never promoted as a cluster owner')
})

test('an expanded-Focus search reveals the nested Work without minting a manual owner', async () => {
  const { vt, app } = startApp('focus')
  const { messages, process } = surfaceFixture()
  show(app, messages)
  app.setFullscreen(true)
  app.expandFocusTurn(TURN)
  await vt.waitForRender()
  app.setTranscriptSearchTarget({
    query: 'SURFACE_TOOL',
    match: { id: 0, turn: TURN, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: process,
  })
  await vt.waitForRender()
  const revealed = vt.getViewport().join('\n')
  assert.equal(app.expandedWorkOwnersForTest().size, 0, 'the nested Work reveal is presentation-only')
  assert.ok(revealed.includes('▾ Work'), `expanded Focus must reveal the nested Work that hides the matched row:\n${revealed}`)
  assert.equal(app.expandedContextClusterOwnersForTest().size, 0, 'a Process target is never promoted as a cluster owner')
})

// --- Window boundary -------------------------------------------------------

test('a partial window folds and clusters only its visible rows', () => {
  const midRun = [thinking('mid-run reasoning'), tool('read', 'RESULT')]
  const structure = projectTranscriptStructure(midRun)
  assert.deepEqual(structure.map(block => block.kind), ['work'])
  assert.equal(structure[0]!.kind === 'work' ? structure[0]!.span.members.length : -1, 2, 'no off-window member is invented')

  // A window-summary marker splits the same turn and never joins Work.
  const withSummary = projectTranscriptStructure([{ kind: 'summary', text: 'older turns' }, ...midRun])
  assert.deepEqual(withSummary.map(block => block.kind), ['message', 'work'])

  // A cluster at the left edge owns the first VISIBLE member.
  const first = ambient('left-edge-a', 'instructions')
  const second = ambient('left-edge-b', 'catalog')
  const edge = projectTranscriptStructure([first, second, thinking('after')])
  assert.equal(edge[0]!.kind, 'context-cluster')
  assert.equal(edge[0]!.kind === 'context-cluster' ? edge[0]!.cluster.owner : undefined, first)
})

// --- Performance -----------------------------------------------------------

function largeWindow(turns: number): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    out.push(user(`prompt ${turn}`))
    for (let step = 0; step < 4; step += 1) out.push(thinking(`reason ${turn}-${step}`), tool('read', 'ok'))
    out.push(assistant(`narration ${turn}`))
  }
  return out
}

test('the canonical projector and Compact adapter scale through 50k rows without quadratic blowup', () => {
  const noOptions = { expandedWorkOwners: new Set<TranscriptMessage>(), expandedClusters: new Set<TranscriptMessage>(), forcedExpanded: new Set<TranscriptMessage>() }
  const measure = (rows: number): number => {
    const messages = largeWindow(Math.ceil(rows / 10))
    const start = performance.now()
    const structure = projectTranscriptStructure(messages)
    projectCompact(messages, noOptions)
    const elapsed = performance.now() - start
    // Exact membership is preserved at every size, not just the small one.
    assert.equal(flattenStructure(structure).length, messages.length)
    return elapsed
  }
  measure(1000) // warm up
  const smallMs = Math.max(measure(1000), 0.5)
  const midMs = measure(10000)
  const largeMs = measure(50000)
  // Each step is a broad upper bound, not an absolute-ms gate, so CI scheduling
  // noise cannot make this flaky while a quadratic regression still fails it.
  assert.ok(midMs < smallMs * 100 + 100, `10x input took ${midMs.toFixed(1)}ms vs ${smallMs.toFixed(2)}ms`)
  assert.ok(largeMs < smallMs * 400 + 200, `50x input took ${largeMs.toFixed(1)}ms vs ${smallMs.toFixed(2)}ms`)
})
