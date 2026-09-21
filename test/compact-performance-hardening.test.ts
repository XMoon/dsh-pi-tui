/**
 * PR4/F4 hardening: large-history / grouping performance characterization.
 *
 * The F4 pure transforms must scale linearly and the presentation must not
 * resolve the active search reveal owner once per projected row (the
 * accidental O(n^2) this suite guards). The app-level guard is an operation
 * COUNT, not a wall-clock threshold, so it is stable in CI; the parser's
 * distinct-label dedup is guarded by a many-distinct smoke budget with a
 * >2000x margin.
 * @module @xmoon76/dsh-pi-tui/compact-performance-hardening.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { projectCompact } from '../src/compact-projection.ts'
import { clusterAdjacentAmbientContext } from '../src/context-presentation.ts'
import { contextClusterSummaryParts } from '../src/context-cluster.ts'
import { contextProvenance } from '../src/context.ts'
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

const noOptions = { expandedWorkOwners: new Set<TranscriptMessage>(), expandedClusters: new Set<TranscriptMessage>(), forcedExpanded: new Set<TranscriptMessage>() }

const thinking = (turn: number, index: number): TranscriptMessage => ({ kind: 'thinking', turn, text: `reason ${index}`, running: false })
const tool = (turn: number, index: number): TranscriptMessage => ({ kind: 'tool', turn, name: 'read', args: `{"p":${index}}`, result: 'ok', status: 'ok' })
const assistant = (turn: number, index: number): TranscriptMessage => ({ kind: 'assistant', turn, text: `narration ${index}` })
const user = (turn: number, index: number): TranscriptMessage => ({ kind: 'user', turn, text: `prompt ${index}` })
const attention = (turn: number): TranscriptMessage => ({ kind: 'tool', turn, name: 'error', args: '', result: 'failed', status: 'error', origin: 'turn-error' })
const ambient = (turn: number, index: number): TranscriptMessage => ({
  kind: 'system', turn, text: `context ${index}`, label: `ctx-${index}`, context: true,
  contextPresentation: { form: 'instructions', sourceKind: 'plugin', role: 'inject' },
})

/** P1 process-heavy: User + many Thinking/Tool + Assistant, repeated. */
function processHeavy(turns: number, perTurn = 8): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    out.push(user(turn, turn))
    for (let step = 0; step < perTurn; step += 1) {
      out.push(thinking(turn, step))
      out.push(tool(turn, step))
    }
    out.push(assistant(turn, turn))
  }
  return out
}

/** P2 boundary-heavy: Process / Assistant / Process / Context / Process / Attention. */
function boundaryHeavy(turns: number): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    out.push(thinking(turn, 0), tool(turn, 0), assistant(turn, 0), thinking(turn, 1), tool(turn, 1))
    out.push(ambient(turn, turn), thinking(turn, 2), tool(turn, 2), attention(turn))
  }
  return out
}

/** P3 context-heavy: ambient bursts around Process/Conversation boundaries. */
function contextHeavy(bursts: number, perBurst = 6): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (let burst = 0; burst < bursts; burst += 1) {
    for (let index = 0; index < perBurst; index += 1) out.push(ambient(burst, burst * perBurst + index))
    out.push(thinking(burst, 0), tool(burst, 0), assistant(burst, 0))
  }
  return out
}

test('the pure Compact projection scales to a large history and keeps exact membership', () => {
  const messages = processHeavy(700, 8) // ~12600 rows
  const blocks = projectCompact(messages, noOptions)
  const spans = blocks.filter(block => block.kind === 'work')
  assert.equal(spans.length, 700, 'one Work span per turn (the intervening Assistant/User are boundaries)')
  let members = 0
  for (const block of spans) members += block.kind === 'work' ? block.span.members.length : 0
  assert.equal(members, 700 * 16, 'every Process row is a member exactly once (Thinking + Tool per step)')
  // No duplicated or reordered rows.
  const seen = new Set<TranscriptMessage>()
  for (const block of spans) {
    if (block.kind !== 'work') continue
    for (const member of block.span.members) {
      assert.ok(!seen.has(member), 'a member appears in exactly one span')
      seen.add(member)
    }
    assert.equal(block.span.owner, block.span.members[0], 'the owner is the first member')
  }
})

test('a large window clusters every ambient burst exactly and never crosses a Process boundary', () => {
  // P2 boundary-heavy: exactly one ambient row per run, always isolated by a
  // Process/Conversation row — nothing may cluster across that boundary.
  const isolated = clusterAdjacentAmbientContext(boundaryHeavy(1200))
  assert.equal(isolated.clusters.length, 0, 'a single ambient row per run never clusters')
  assert.equal(isolated.byMember.size, 0)

  // P3 context-heavy: a genuinely large window of adjacent ambient bursts.
  const bursts = 1200
  const perBurst = 6
  const messages = contextHeavy(bursts, perBurst)
  const { clusters, byMember } = clusterAdjacentAmbientContext(messages)
  assert.equal(clusters.length, bursts, 'exactly one cluster per ambient burst')
  let total = 0
  for (const cluster of clusters) {
    assert.equal(cluster.members.length, perBurst, 'each burst clusters into one run')
    assert.equal(cluster.owner, cluster.members[0], 'the owner is the burst first member')
    for (const member of cluster.members) {
      assert.equal(byMember.get(member), cluster, 'stable lookup for every member')
      assert.equal(member.kind === 'system' ? member.contextPresentation?.form : undefined, 'instructions')
    }
    total += cluster.members.length
  }
  assert.equal(total, bursts * perBurst, 'every ambient row belongs to exactly one cluster')
  assert.equal(byMember.size, bursts * perBurst)
})

test('a large ambient cluster preserves every member, order and a deterministic summary', () => {
  for (const size of [2, 10, 100, 1000]) {
    const members = Array.from({ length: size }, (_, index) => ambient(0, index))
    const { clusters, byMember } = clusterAdjacentAmbientContext(members)
    assert.equal(clusters.length, 1, `size ${size}: one cluster`)
    assert.equal(clusters[0]!.owner, members[0]!, `size ${size}: owner is the first member`)
    assert.deepEqual(clusters[0]!.members, members, `size ${size}: exact order`)
    assert.equal(new Set(clusters[0]!.members).size, size, `size ${size}: every member is distinct`)
    for (const member of members) assert.equal(byMember.get(member), clusters[0], `size ${size}: stable lookup`)
    const parts = contextClusterSummaryParts(clusters[0]!)
    assert.equal(parts.length, size, `size ${size}: one summary part per distinct label`)
    assert.deepEqual(contextClusterSummaryParts(clusters[0]!), parts, `size ${size}: deterministic`)
  }
})

test('an active search resolves the reveal owner O(1) times per projection, not per row', () => {
  const messages = processHeavy(2000, 8) // ~36000 rows, ~2000 Work spans
  const vt = new VirtualTerminal(120, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset: 'compact' } })
  app.start()
  startedApps.add(app)
  app.setTranscript(messages, new Map())
  app.resetTranscriptPresentationDiagnosticsForTest()
  app.setTranscriptSearchTarget({
    query: 'reason 0',
    match: { id: 0, turn: 0, occurrence: 0, source: { kind: 'message' }, sourceOccurrence: 0 },
    message: messages[1]!, // the first Thinking member of the first Work span
  })
  const diagnostics = app.transcriptPresentationDiagnosticsForTest()
  // The whole projection may resolve the owner a small constant number of
  // times (one per projection epoch); it must NEVER be proportional to the
  // number of Work spans or rows.
  assert.ok(diagnostics.searchOwnerResolutions <= 3,
    `the reveal owner must be memoized per projection, got ${diagnostics.searchOwnerResolutions} resolutions for ${messages.length} rows`)
})

test('a many-distinct large source array dedupes in first-seen order within a linear-time smoke budget', () => {
  // Many DISTINCT labels plus a duplicate tail. The legacy `includes()` scan is
  // O(entries × distinct) and took ~32s at this size, while the Set path is
  // ~15ms — a >2000x margin, so this fails clearly on a quadratic regression
  // without being load-flaky. (A 100-distinct fixture would NOT guard it: the
  // legacy scan is then only O(entries × 100).)
  const changes = [
    ...Array.from({ length: 40000 }, (_, index) => ({ path: `file-${index}.ts` })),
    ...Array.from({ length: 100 }, (_, index) => ({ path: `file-${index}.ts` })),
  ]
  const start = performance.now()
  const provenance = contextProvenance({ kind: 'agent-instructions', form: 'instructions', changes })
  const elapsed = performance.now() - start
  assert.equal(provenance.label, Array.from({ length: 40000 }, (_, index) => `file-${index}.ts`).join(', '),
    'every distinct label keeps its first-seen order and the duplicate tail adds nothing')
  assert.ok(elapsed < 5000, `distinct-label dedup took ${elapsed.toFixed(0)}ms; expected a single linear pass`)
})
