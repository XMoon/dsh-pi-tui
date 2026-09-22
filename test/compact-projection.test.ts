/**
 * Pure tests for the PR3/F4 Compact foundation: form-aware Context
 * provenance (fold level), Context presentation roles + raw-adjacency
 * clustering, and the contiguous Process Work-span projection.
 * @module @xmoon76/dsh-pi-tui/compact-projection.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  contextFormOf,
  contextPresentationKind,
  clusterAdjacentAmbientContext,
  isAmbientContext,
  isNoticeContext,
  isRecallContext,
  isRelayContext,
} from '../src/context-presentation.ts'
import { contextPresentation, isTranscriptContextForm } from '../src/context.ts'
import { projectCompact } from '../src/compact-projection.ts'
import { summarizeWorkSpan, formatWorkHeaderLine, compactWorkBody, CompactWorkComponent } from '../src/compact-work.ts'
import { contextClusterSummaryParts, formatContextClusterHeader, ContextClusterComponent } from '../src/context-cluster.ts'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'

function eventAt(type: string, data: Record<string, unknown>, time: number, seq: number): SessionEvent {
  return { type, seq, time, data } as SessionEvent
}

function apply(folder: TranscriptFolder, events: readonly SessionEvent[]): void {
  for (const event of events) folder.apply([event])
}

/** Fold one injected-context source and return the folded system row. */
function foldContext(source: Record<string, unknown>, text = 'injected body'): TranscriptMessage {
  const folder = new TranscriptFolder()
  apply(folder, [
    eventAt('turn/start', { turn: 0 }, 1000, 0),
    eventAt('user/message', {
      id: MessageId('ctx'),
      role: 'user',
      content: [{ type: 'text', text }],
      source,
    }, 1001, 1),
  ])
  const row = folder.messages().find(message => message.kind === 'system' && message.context === true)
  assert.ok(row !== undefined, 'fixture: the injected source folds to a surfaced system row')
  return row
}

/** A surfaced Context row with an explicit producer-declared form. */
function contextRow(turn: number, form: string | undefined, label?: string): TranscriptMessage {
  return {
    kind: 'system',
    turn,
    text: `${label ?? form ?? 'unknown'} body`,
    ...label === undefined ? {} : { label },
    context: true,
    contextPresentation: {
      ...form === undefined ? {} : { form: form as never },
      sourceKind: 'plugin',
      role: 'inject',
    },
  }
}

const thinking = (turn: number, text = 'reasoning'): TranscriptMessage => ({ kind: 'thinking', turn, text, running: true })
const tool = (turn: number, name = 'read'): TranscriptMessage => ({
  kind: 'tool', turn, name, args: '{}', result: 'ok', status: 'ok',
})
const assistant = (turn: number, text: string): TranscriptMessage => ({ kind: 'assistant', turn, text })
const user = (turn: number, text: string): TranscriptMessage => ({ kind: 'user', turn, text })
const attention = (turn: number): TranscriptMessage => ({
  kind: 'tool', turn, name: 'error', args: '', result: 'failed', status: 'error', origin: 'turn-error',
})

const noOptions = { expandedWorkOwners: new Set<TranscriptMessage>(), expandedClusters: new Set<TranscriptMessage>(), forcedExpanded: new Set<TranscriptMessage>() }

function kindsOf(blocks: ReturnType<typeof projectCompact>): string[] {
  return blocks.map(block => block.kind === 'message' ? block.message.kind : block.kind)
}

// --- Context provenance seam ---------------------------------------------

test('contextPresentation records the producer-declared form, kind and sender', () => {
  assert.deepEqual(contextPresentation({ kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md' }] }), {
    form: 'instructions', sourceKind: 'agent-instructions', role: 'inject',
  })
  assert.deepEqual(contextPresentation({ kind: 'skill-invocation', form: 'catalog', name: 'review-fix-loop' }), {
    form: 'catalog', sourceKind: 'skill-invocation', role: 'inject',
  })
  assert.deepEqual(contextPresentation({ kind: 'plugin', form: 'snapshot', plugin: 'runtime-context' }), {
    form: 'snapshot', sourceKind: 'plugin', role: 'inject',
  })
  assert.deepEqual(contextPresentation({ kind: 'subagent-settled', form: 'notice', summary: 'child settled', senderSessionId: 'child-1' }), {
    form: 'notice', sourceKind: 'subagent-settled', senderSessionId: 'child-1', role: 'inject',
  })
  assert.deepEqual(contextPresentation({ kind: 'agent-message', form: 'relay', senderSessionId: 'child-2' }), {
    form: 'relay', sourceKind: 'agent-message', senderSessionId: 'child-2', role: 'inject',
  })
  assert.deepEqual(contextPresentation({ kind: 'session-reference', form: 'recall', references: [{ label: 'prior work' }] }), {
    form: 'recall', sourceKind: 'session-reference', role: 'recall',
  })
})

test('unknown, missing and future forms fail open with no declared form', () => {
  assert.deepEqual(contextPresentation({ kind: 'plugin', plugin: 'legacy-injector' }), {
    sourceKind: 'plugin', role: 'inject',
  })
  assert.deepEqual(contextPresentation({ kind: 'plugin', form: 'future-form', plugin: 'p' }), {
    sourceKind: 'plugin', role: 'inject',
  })
  assert.deepEqual(contextPresentation(undefined), { role: 'inject' })
  assert.equal(isTranscriptContextForm('future-form'), false)
  assert.equal(isTranscriptContextForm('relay'), true)
})

test('the fold retains form-aware provenance on real injected sources', () => {
  const instructions = foldContext({ kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md' }] })
  assert.deepEqual(instructions.kind === 'system' ? instructions.contextPresentation : undefined, {
    form: 'instructions', sourceKind: 'agent-instructions', role: 'inject',
  })
  assert.equal(instructions.kind === 'system' ? instructions.label : undefined, 'AGENTS.md')

  const notice = foldContext({ kind: 'subagent-settled', form: 'notice', summary: 'child completed', senderSessionId: 'child-9' })
  assert.equal(notice.kind === 'system' ? notice.contextPresentation?.form : undefined, 'notice')
  assert.equal(notice.kind === 'system' ? notice.contextPresentation?.senderSessionId : undefined, 'child-9')
  assert.equal(notice.kind === 'system' ? notice.summary : undefined, 'child completed')

  const relay = foldContext({ kind: 'agent-message', form: 'relay', senderSessionId: 'child-3' })
  assert.equal(relay.kind === 'system' ? relay.contextPresentation?.form : undefined, 'relay')
  assert.equal(relay.kind === 'system' ? relay.contextPresentation?.senderSessionId : undefined, 'child-3')

  const legacy = foldContext({ kind: 'plugin', plugin: 'legacy-injector' })
  assert.equal(legacy.kind === 'system' ? legacy.contextPresentation?.form : undefined, undefined)
  assert.equal(legacy.kind === 'system' ? legacy.contextPresentation?.sourceKind : undefined, 'plugin')
})

// --- Context presentation roles ------------------------------------------

test('only instructions/catalog/snapshot are ambient; known forms stay standalone', () => {
  for (const form of ['instructions', 'catalog', 'snapshot']) {
    const row = contextRow(0, form)
    assert.equal(isAmbientContext(row), true, `${form} is ambient`)
    assert.equal(contextPresentationKind(row), 'ambient')
  }
  assert.equal(isNoticeContext(contextRow(0, 'notice')), true)
  assert.equal(isRelayContext(contextRow(0, 'relay')), true)
  assert.equal(isRecallContext(contextRow(0, 'recall')), true)
  assert.equal(contextPresentationKind(contextRow(0, 'notice')), 'notice')
  assert.equal(contextPresentationKind(contextRow(0, 'relay')), 'relay')
  assert.equal(contextPresentationKind(contextRow(0, 'recall')), 'recall')
  // Unknown/missing forms fail open to standalone generic Context, never ambient.
  assert.equal(contextPresentationKind(contextRow(0, undefined)), 'generic')
  assert.equal(isAmbientContext(contextRow(0, undefined)), false)
  // A legacy session-reference stays recall without a declared form.
  const legacyRecall: TranscriptMessage = {
    kind: 'system', turn: 0, text: 'recalled', context: true,
    contextPresentation: { sourceKind: 'session-reference', role: 'recall' },
  }
  assert.equal(isRecallContext(legacyRecall), true)
  assert.equal(isAmbientContext(legacyRecall), false)
  // Non-context rows are never a presentation role.
  assert.equal(contextPresentationKind(user(0, 'hi')), undefined)
  assert.equal(contextFormOf(user(0, 'hi')), undefined)
})

// --- Ambient raw-adjacency clustering ------------------------------------

test('ambient clusters form only from raw-adjacent same-turn ambient rows (2+)', () => {
  const a = contextRow(0, 'instructions', 'AGENTS.md')
  const b = contextRow(0, 'catalog', 'skill catalog')
  const c = contextRow(0, 'snapshot', 'runtime context')
  // instructions + catalog -> one cluster
  assert.equal(clusterAdjacentAmbientContext([a, b]).clusters.length, 1)
  // instructions + snapshot + catalog -> one cluster
  assert.equal(clusterAdjacentAmbientContext([a, c, b]).clusters.length, 1)
  // a single ambient row stays ordinary
  assert.equal(clusterAdjacentAmbientContext([a]).clusters.length, 0)
  // a hidden Process row between two ambient rows must NOT merge them
  assert.equal(clusterAdjacentAmbientContext([a, tool(0), b]).clusters.length, 0)
  // notice breaks the run: ambient / notice / ambient
  assert.equal(clusterAdjacentAmbientContext([a, contextRow(0, 'notice'), b]).clusters.length, 0)
  // unknown Context breaks the run
  assert.equal(clusterAdjacentAmbientContext([a, contextRow(0, undefined), b]).clusters.length, 0)
  // a turn boundary breaks the run
  assert.equal(clusterAdjacentAmbientContext([a, contextRow(1, 'catalog')]).clusters.length, 0)
  // relay/recall never cluster
  assert.equal(clusterAdjacentAmbientContext([a, contextRow(0, 'relay'), b]).clusters.length, 0)
  assert.equal(clusterAdjacentAmbientContext([contextRow(0, 'relay'), contextRow(0, 'recall')]).clusters.length, 0)
  // conversation/attention also break
  assert.equal(clusterAdjacentAmbientContext([a, user(0, 'hi'), b]).clusters.length, 0)
  assert.equal(clusterAdjacentAmbientContext([a, attention(0), b]).clusters.length, 0)
})

test('an ambient cluster keeps raw member order and its owner is the first member', () => {
  const a = contextRow(0, 'instructions', 'AGENTS.md')
  const b = contextRow(0, 'snapshot', 'runtime context')
  const { clusters, byMember } = clusterAdjacentAmbientContext([a, b, tool(0)])
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0]!.owner, a)
  assert.deepEqual(clusters[0]!.members, [a, b])
  assert.equal(clusters[0]!.turn, 0)
  assert.equal(byMember.get(b), clusters[0])
  assert.equal(byMember.get(a), clusters[0])
})

test('the cluster summary compresses duplicate labels for display only', () => {
  const a = contextRow(0, 'instructions', 'AGENTS.md')
  const b = contextRow(0, 'instructions', 'AGENTS.md')
  const c = contextRow(0, 'snapshot', 'runtime context')
  const { clusters } = clusterAdjacentAmbientContext([a, b, c])
  assert.deepEqual(contextClusterSummaryParts(clusters[0]!), ['AGENTS.md ×2', 'runtime context'])
  assert.match(formatContextClusterHeader(clusters[0]!, false), /Context · 3 injections/)
})

// --- Compact Work projection ---------------------------------------------

test('a contiguous Process run becomes one Work span', () => {
  const blocks = projectCompact([thinking(0), tool(0)], noOptions)
  assert.deepEqual(kindsOf(blocks), ['work'])
  const span = blocks[0]!.kind === 'work' ? blocks[0]!.span : undefined
  assert.ok(span !== undefined)
  assert.equal(span.owner, span.members[0])
  assert.equal(span.turn, 0)
})

test('Conversation, Attention, Context and turn boundaries each end a Work span', () => {
  assert.deepEqual(kindsOf(projectCompact([thinking(0), assistant(0, 'intermediate'), tool(0)], noOptions)),
    ['work', 'assistant', 'work'])
  assert.deepEqual(kindsOf(projectCompact([thinking(0), attention(0), tool(0)], noOptions)),
    ['work', 'tool', 'work'])
  assert.deepEqual(kindsOf(projectCompact([thinking(0), contextRow(0, 'notice'), tool(0)], noOptions)),
    ['work', 'system', 'work'])
  assert.deepEqual(kindsOf(projectCompact([thinking(0), tool(1)], noOptions)),
    ['work', 'work'])
})

test('Assistant intermediate narration stays visible in chronology and final stays last', () => {
  const messages: TranscriptMessage[] = [
    user(0, 'prompt'),
    thinking(0, 'first'),
    tool(0, 'read'),
    assistant(0, 'I found the failing branch.'),
    thinking(0, 'second'),
    tool(0, 'bash'),
    assistant(0, 'The remaining issue is viewport restore.'),
    tool(0, 'edit'),
    assistant(0, 'final answer'),
  ]
  const blocks = projectCompact(messages, noOptions)
  assert.deepEqual(kindsOf(blocks), ['user', 'work', 'assistant', 'work', 'assistant', 'work', 'assistant'])
  const texts = blocks.flatMap(block => block.kind === 'message' && block.message.kind === 'assistant' ? [block.message.text] : [])
  assert.deepEqual(texts, [
    'I found the failing branch.',
    'The remaining issue is viewport restore.',
    'final answer',
  ])
  // Neither intermediate assistant is absorbed into a Work span.
  const workMembers = blocks.flatMap(block => block.kind === 'work' ? [...block.span.members] : [])
  assert.ok(!workMembers.some(member => member.kind === 'assistant'))
})

test('expanding a Work span emits its members in raw order after the header', () => {
  const messages = [thinking(0, 'a'), tool(0), thinking(0, 'b')]
  const span = projectCompact(messages, noOptions)[0]
  assert.ok(span !== undefined && span.kind === 'work')
  const expanded = projectCompact(messages, {
    ...noOptions,
    expandedWorkOwners: new Set([span.span.owner]),
  })
  assert.deepEqual(kindsOf(expanded), ['work', 'thinking', 'tool', 'thinking'])
  assert.deepEqual(expanded.slice(1).map(block => block.kind === 'message' ? block.message : undefined),
    span.span.members)
})

test('a temporary search reveal opens exactly the owning Work span', () => {
  const target = tool(2, 'bash')
  const messages = [thinking(1), tool(1), assistant(1, 'between'), thinking(2), target]
  const blocks = projectCompact(messages, { ...noOptions, forcedExpanded: new Set([target]) })
  assert.deepEqual(kindsOf(blocks), ['work', 'assistant', 'work', 'thinking', 'tool'])
})

test('surfaced Context is always a Work boundary; ambient runs cluster in Compact too', () => {
  const messages: TranscriptMessage[] = [
    thinking(0), tool(0),
    contextRow(0, 'instructions', 'AGENTS.md'), contextRow(0, 'catalog', 'skills'),
    thinking(0), contextRow(0, 'notice', 'child settled'),
    tool(0), contextRow(0, 'relay', 'child-2'),
    thinking(0), assistant(0, 'final'),
  ]
  const blocks = projectCompact(messages, noOptions)
  assert.deepEqual(kindsOf(blocks),
    ['work', 'context-cluster', 'work', 'system', 'work', 'system', 'work', 'assistant'])
})

test('an expanded ambient cluster emits every member as an ordinary row', () => {
  const a = contextRow(0, 'instructions', 'AGENTS.md')
  const b = contextRow(0, 'snapshot', 'runtime context')
  const messages = [thinking(0), a, b, tool(0)]
  const collapsed = projectCompact(messages, noOptions)
  assert.deepEqual(kindsOf(collapsed), ['work', 'context-cluster', 'work'])
  const expanded = projectCompact(messages, { ...noOptions, expandedClusters: new Set([a]) })
  assert.deepEqual(kindsOf(expanded), ['work', 'context-cluster', 'system', 'system', 'work'])
})

// --- Work summary ---------------------------------------------------------

test('the Work summary counts only ITS OWN span, not the whole turn', () => {
  const messages = [thinking(0, 'first reasoning'), tool(0, 'read'), assistant(0, 'between'), thinking(0, 'second reasoning'), tool(0, 'read'), tool(0, 'search')]
  const blocks = projectCompact(messages, noOptions)
  const first = blocks[0]
  const second = blocks[2]
  assert.ok(first !== undefined && first.kind === 'work' && second !== undefined && second.kind === 'work')
  const firstSummary = summarizeWorkSpan(first.span)
  const secondSummary = summarizeWorkSpan(second.span)
  assert.equal(firstSummary.toolCount, 1)
  assert.equal(secondSummary.toolCount, 2)
  assert.equal(firstSummary.think?.text, 'first reasoning')
  assert.equal(secondSummary.think?.text, 'second reasoning')
  assert.equal(secondSummary.tool?.name, 'search')
})

test('the Activity header reports span facts, omits zero counts and degrades to width', () => {
  const span = projectCompact([thinking(0), tool(0), tool(0)], noOptions)[0]
  assert.ok(span !== undefined && span.kind === 'work')
  const summary = summarizeWorkSpan(span.span)
  // post-F6 plan §6.1/§6.3/§6.4: visible identity is `Activity` with the
  // registry work icon, the grammar is `<identity> <duration> · <stats>`,
  // and the `· thinking` marker is gone.
  assert.equal(formatWorkHeaderLine(summary, false, 80, 'symbols'), '▸ ✦ Activity · 2 tools')
  assert.equal(formatWorkHeaderLine({ toolCount: 0, subagentCount: 0 }, false, 80, 'symbols'), '▸ ✦ Activity')
  assert.equal(formatWorkHeaderLine({ toolCount: 1, subagentCount: 0 }, true, 80, 'symbols'), '▾ ✦ Activity · 1 tool')
  // The duration sits directly beside the identity (§6.3), not behind a dot.
  assert.equal(formatWorkHeaderLine(summary, false, 80, 'symbols', '18s'), '▸ ✦ Activity 18s · 2 tools')
  assert.equal(formatWorkHeaderLine(summary, false, 80, 'minimal', '18s'), '▸ Activity 18s · 2 tools')
  // Narrow: drops the LAST stat first, keeps identity + duration to the
  // end (§6.5), never wraps.
  assert.equal(formatWorkHeaderLine({ toolCount: 2, subagentCount: 1 }, false, 26, 'symbols', '18s'), '▸ ✦ Activity 18s · 2 tools')
  // Below identity+duration, the duration falls too; the bare identity is
  // the floor (then a hard truncate as the last resort).
  assert.equal(formatWorkHeaderLine({ toolCount: 2, subagentCount: 1 }, false, 14, 'symbols', '18s'), '▸ ✦ Activity')
  const narrow = formatWorkHeaderLine(summary, false, 10, 'symbols')
  assert.ok(visibleWidth(narrow) <= 10)
})

test('the collapsed Activity body renders at most one Think row and one Tool row, never a Message slot', () => {
  const span = projectCompact([thinking(0, 'checking\nsecond line'), tool(0)], noOptions)[0]
  assert.ok(span !== undefined && span.kind === 'work')
  const summary = summarizeWorkSpan(span.span)
  const lines = compactWorkBody(summary, 60, 'Read src/tui-app.ts')
  assert.equal(lines.length, 2)
  assert.match(lines[0]!, /Think:/)
  // post-F6 plan §8.2: the SETTLED Think preview reads the LATEST logical
  // line (head-truncated), never the frozen first line.
  assert.match(lines[0]!, /second line/)
  assert.ok(!lines[0]!.includes('checking'), 'the Think preview shows the latest line, not the first')
  assert.match(lines[1]!, /Tool:/)
  assert.match(lines[1]!, /Read src\/tui-app\.ts/)
  assert.ok(!lines.some(line => line.includes('Message:')), 'Compact Activity has no Message slot')
  // No tool/thinking -> no placeholder rows.
  assert.deepEqual(compactWorkBody({ toolCount: 0, subagentCount: 0 }, 60), [])
})

test('a live Preparing summary owns the Tool slot over the settled display', () => {
  const span = projectCompact([thinking(0), tool(0, 'read')], noOptions)[0]
  assert.ok(span !== undefined && span.kind === 'work')
  const summary = summarizeWorkSpan(span.span)
  const lines = compactWorkBody(summary, 80, 'Read src/index.ts', 'Preparing Bash…')
  assert.match(lines[1]!, /Preparing Bash/)
})

test('the Work component renders one header row and, collapsed, the slot rows', () => {
  const span = projectCompact([thinking(0), tool(0)], noOptions)[0]
  assert.ok(span !== undefined && span.kind === 'work')
  const collapsed = new CompactWorkComponent({ span: span.span, expanded: false, toolDisplay: 'Read a.ts', iconStyle: 'symbols' }).render(80)
  assert.equal(collapsed.length, 3, 'header + Think + Tool')
  const expanded = new CompactWorkComponent({ span: span.span, expanded: true, toolDisplay: 'Read a.ts', iconStyle: 'symbols' }).render(80)
  assert.equal(expanded.length, 1, 'expanded Work renders only the header — children render after it')
})

test('the cluster component renders the header and a width-aware summary', () => {
  const a = contextRow(0, 'instructions', 'AGENTS.md')
  const b = contextRow(0, 'catalog', 'skill catalog')
  const { clusters } = clusterAdjacentAmbientContext([a, b])
  const collapsed = new ContextClusterComponent({ cluster: clusters[0]!, expanded: false, iconStyle: 'symbols' }).render(80)
  assert.equal(collapsed.length, 2)
  assert.match(collapsed[0]!, /Context · 2 injections/)
  assert.match(collapsed[1]!, /AGENTS\.md/)
  const expanded = new ContextClusterComponent({ cluster: clusters[0]!, expanded: true, iconStyle: 'symbols' }).render(80)
  assert.equal(expanded.length, 1)
})

test('the cluster header composes the disclosure marker with the Context identity icon per style', () => {
  const a = contextRow(0, 'instructions', 'AGENTS.md')
  const b = contextRow(0, 'catalog', 'skill catalog')
  const cluster = clusterAdjacentAmbientContext([a, b]).clusters[0]!
  // Disclosure state survives every style; the Context identity icon follows it
  // and disappears under minimal without leaving a dangling separator.
  assert.equal(formatContextClusterHeader(cluster, false, 'emoji'), '▸ 📎 Context · 2 injections')
  assert.equal(formatContextClusterHeader(cluster, true, 'emoji'), '▾ 📎 Context · 2 injections')
  assert.equal(formatContextClusterHeader(cluster, false, 'symbols'), '▸ ⋅ Context · 2 injections')
  assert.equal(formatContextClusterHeader(cluster, true, 'symbols'), '▾ ⋅ Context · 2 injections')
  assert.equal(formatContextClusterHeader(cluster, false, 'minimal'), '▸ Context · 2 injections')
  assert.equal(formatContextClusterHeader(cluster, true, 'minimal'), '▾ Context · 2 injections')
  assert.ok(!formatContextClusterHeader(cluster, false, 'minimal').includes('  '), 'minimal leaves no double space')
  // The disclosure marker is never replaced by the Context identity icon.
  for (const style of ['emoji', 'symbols', 'minimal'] as const) {
    assert.ok(formatContextClusterHeader(cluster, false, style).startsWith('▸ '), `${style}: collapsed marker survives`)
    assert.ok(formatContextClusterHeader(cluster, true, style).startsWith('▾ '), `${style}: expanded marker survives`)
  }
})

test('the identity-icon cluster header never overflows any width or style', () => {
  const a = contextRow(0, 'instructions', 'AGENTS.md')
  const b = contextRow(0, 'catalog', 'skill catalog')
  const cluster = clusterAdjacentAmbientContext([a, b]).clusters[0]!
  for (const iconStyle of ['emoji', 'symbols', 'minimal'] as const) {
    for (const width of [1, 2, 3, 4, 8, 20]) {
      for (const expanded of [false, true]) {
        const rows = new ContextClusterComponent({ cluster, expanded, iconStyle }).render(width)
        assert.ok(rows.length > 0, `${iconStyle} width ${width}: the header must render`)
        for (const row of rows) {
          assert.ok(visibleWidth(row) <= width, `${iconStyle} width ${width} overflowed: ${JSON.stringify(row)}`)
        }
      }
    }
  }
})

test('the cluster header and summary never exceed a very narrow width', () => {
  const a = contextRow(0, 'instructions', 'AGENTS.md')
  const b = contextRow(0, 'catalog', 'skill catalog')
  const { clusters } = clusterAdjacentAmbientContext([a, b])
  for (const width of [1, 2, 3]) {
    const rows = new ContextClusterComponent({ cluster: clusters[0]!, expanded: false, iconStyle: 'emoji' }).render(width)
    assert.ok(rows.length > 0, `width ${width} must still render the header`)
    for (const row of rows) {
      assert.ok(visibleWidth(row) <= width, `width ${width} overflowed: ${JSON.stringify(row)}`)
    }
  }
})
