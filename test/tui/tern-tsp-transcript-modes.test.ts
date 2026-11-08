/**
 * TSP Full/Compact transcript mode materialization.
 *
 * The chain under test is the production pure projection: genuine
 * `SessionEvent`s through the real `TranscriptFolder`, the canonical
 * `projectTranscriptStructure`/`projectCompact` authorities, the typed
 * `transcriptViewForPreset` mapper and the actual SDK `View.from` node ids.
 * Nothing here compares a hand-authored tree against another hand-authored
 * tree, and no case injects a precomputed "isCompact" decision.
 *
 * Evidence level: pure projection + official SDK node identity on a scripted
 * (non-Tern) shape. Real client layout/toggle is the separate real-pane lane.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-transcript-modes.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { View, type JsonObject, type Tree } from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder, transcriptTimingOf } from '../../src/domain/transcript/folder.ts'
import { TranscriptWindowController } from '../../src/domain/transcript/window.ts'
import { StatsFolder } from '../../src/domain/status/stats.ts'
import { applyAssistantLiveInput } from '../../src/app/surface/session-presentation.ts'
import { streamingToolPreviewSnapshot } from '../../src/app/surface/streaming-tool-preparing.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import { summarizeWorkSpan } from '../../src/tui/transcript/work-summary.ts'
import { toolSummaryKeys } from '../../src/tui/transcript/tool-presentation.ts'
import type { StreamingToolPreview } from '../../src/app/surface/streaming-tool-preparing.ts'
import {
  TranscriptNodeKeys,
  transcriptView,
  transcriptViewForPreset,
  visibleTranscriptMembers,
  type TranscriptPresetViewOptions,
} from '../../src/tui/tsp/transcript-view.ts'

const T0 = 1_700_000_000_000

function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq * 1000, data } as SessionEvent
}

function userMessage(seq: number, id: string, text: string): SessionEvent {
  return ev('user/message', { id: MessageId(id), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, seq)
}

function toolCall(seq: number, callId: string, name: string, args: Record<string, unknown> = {}, step = 0): SessionEvent {
  return ev('tool/call', { turn: 1, step, callId: ToolCallId(callId), name, arguments: JSON.stringify(args) }, seq)
}

function toolResult(seq: number, callId: string, text: string, step = 0): SessionEvent {
  return ev('tool/result', {
    turn: 1,
    step,
    message: {
      id: MessageId(`result-${callId}`),
      role: 'tool',
      toolCallId: ToolCallId(callId),
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq)
}

/** A settled assistant message whose reasoning lane carries real stream times,
 *  so the fold's OWN timing sidecar (never a fixture-invented duration) exists. */
function reasoningMessage(seq: number, id: string, reasoning: string, narration?: string, step = 0): SessionEvent {
  const content = narration === undefined
    ? [{ type: 'reasoning', text: reasoning }]
    : [{ type: 'reasoning', text: reasoning }, { type: 'text', text: narration }]
  return ev('assistant/message', {
    turn: 1,
    step,
    message: {
      id: MessageId(id),
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'p', model: 'm' },
      stream: [
        { type: 'chunk', time: T0 + seq * 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: T0 + seq * 1000 + 10, chunk: { type: 'reasoning-delta', index: 0, text: reasoning } },
        { type: 'chunk', time: T0 + seq * 1000 + 4000, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: reasoning } } },
      ],
    },
  }, seq)
}

function assistantMessage(seq: number, id: string, text: string, step = 0): SessionEvent {
  return ev('assistant/message', {
    turn: 1,
    step,
    message: { id: MessageId(id), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' }, stream: [] },
  }, seq)
}

function apply(events: readonly SessionEvent[]): TranscriptFolder {
  const folder = new TranscriptFolder()
  folder.apply(events)
  return folder
}

interface FlatNode {
  readonly id: string
  readonly kind: string
  readonly props: JsonObject
  readonly parent: string | undefined
}

/** Every node of the `main` region with its REAL SDK-derived id, parents first. */
function flatten(messages: readonly TranscriptMessage[], options: TranscriptPresetViewOptions, keys = new TranscriptNodeKeys()): FlatNode[] {
  const view = View.from({ main: transcriptViewForPreset(messages, keys, options) })
  const out: FlatNode[] = []
  const visit = (tree: Tree, parent: string | undefined): void => {
    out.push({ id: tree.id, kind: tree.kind, props: tree.props, parent })
    for (const child of tree.children) visit(child, tree.id)
  }
  const root = view.regions[0]
  assert.ok(root !== undefined, 'the main region exists')
  visit(root, undefined)
  return out
}

const nodesOf = (nodes: readonly FlatNode[], kind: string): FlatNode[] => nodes.filter(node => node.kind === kind)
const textOf = (node: FlatNode | undefined): string => String(node?.props['text'] ?? '')
const descendantText = (nodes: readonly FlatNode[], id: string): string => {
  const own = nodes.find(node => node.id === id)
  const parts = own === undefined ? [] : [textOf(own)]
  for (const node of nodes) if (node.id.startsWith(`${id}.`)) parts.push(textOf(node))
  return parts.filter(part => part !== '').join(' ')
}

/** The canonical two-Work turn: User · Think+Read · intermediate · Think+Bash · final. */
function twoWorkFolder(): TranscriptFolder {
  return apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'inspect the repository'),
    reasoningMessage(2, 'think-a', 'reading the structure first', undefined, 0),
    toolCall(3, 'call-read', 'read', { file_path: 'src/a.ts' }, 0),
    toolResult(4, 'call-read', 'the file body', 0),
    assistantMessage(5, 'mid-1', 'intermediate narration', 1),
    reasoningMessage(6, 'think-b', 'now running the command', undefined, 2),
    toolCall(7, 'call-bash', 'bash', { command: 'echo hi' }, 2),
    toolResult(8, 'call-bash', 'hi', 2),
    assistantMessage(9, 'final-1', 'the final answer', 3),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 10),
  ])
}

const rowOf = <T extends TranscriptMessage>(folder: TranscriptFolder, predicate: (message: TranscriptMessage) => message is T): T => {
  const row = folder.messages().find(predicate)
  assert.ok(row !== undefined, 'fixture row exists')
  return row
}

const LATEST_WINDOW = { mode: 'latest', hasNewer: false } as const

// ── Full: chronological flatten with no Work chrome ─────────────────────────

test('Full flattens the canonical Work members in raw order and paints no Work container', () => {
  const folder = twoWorkFolder()
  const nodes = flatten(folder.messages(), { preset: 'full', scopePrefix: 's1-' })
  assert.equal(nodesOf(nodes, 'section').length, 0, 'Full has no Work/Activity section at all')
  const topLevel = nodes.filter(node => node.parent === 'main').map(node => node.id)
  const kinds = folder.messages().map(message => message.kind)
  assert.deepEqual(kinds, ['user', 'thinking', 'tool', 'assistant', 'thinking', 'tool', 'assistant'])
  // Every raw row is a top-level node, in the SAME order as the raw window.
  const rows = nodes.filter(node => node.parent === 'main' && node.id !== 'main')
  assert.equal(rows.length, folder.messages().length, 'one top-level node per raw row')
  assert.deepEqual(rows.map(node => node.kind), ['card', 'card', 'tool', 'card', 'card', 'tool', 'card'])
  assert.ok(topLevel.some(id => id === 'main.s1-msg-1'), 'the first row keeps its scoped key')
  assert.ok(descendantText(nodes, 'main.s1-msg-4').includes('intermediate narration'), 'the intermediate Assistant keeps its own position')
  assert.ok(descendantText(nodes, 'main.s1-msg-7').includes('the final answer'), 'the final Assistant keeps its own position')
})

test('Full keeps Attention, a turn-less command and ambient Context at their raw positions outside any Process container', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'do the work'),
    ev('user/message', { id: MessageId('ctx-1'), role: 'user', content: [{ type: 'text', text: 'ambient instructions' }], source: { kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md' }] } }, 2),
    toolCall(3, 'call-read', 'read'),
    toolResult(4, 'call-read', 'body'),
    ev('command/run', { commandId: CommandId('cmd-1'), name: 'status', source: { kind: 'user' } }, 5),
    ev('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'session healthy' }, 6),
    ev('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'model_error', message: 'the turn failed' } } }, 7),
  ])
  const nodes = flatten(folder.messages(), { preset: 'full', scopePrefix: 's1-' })
  assert.equal(nodesOf(nodes, 'section').length, 0, 'no Process container may swallow a boundary row')
  const rows = nodes.filter(node => node.parent === 'main' && node.id !== 'main')
  const texts = rows.map(node => descendantText(nodes, node.id))
  const commandIndex = texts.findIndex(text => text.includes('status') || text.includes('session healthy'))
  const ambientIndex = texts.findIndex(text => text.includes('ambient') || text.includes('instructions') || text.includes('AGENTS'))
  assert.ok(commandIndex >= 0, 'the turn-less command card is visible')
  assert.ok(ambientIndex >= 0, 'the ambient Context row is visible')
  assert.ok(nodes.some(node => descendantText(nodes, node.id).includes('the turn failed')), 'the Attention error stays visible')
})

// ── Compact: one Activity per canonical Work span ───────────────────────────

test('Compact gives each canonical Work span exactly one collapsible Activity and keeps conversation outside it', () => {
  const folder = twoWorkFolder()
  const nodes = flatten(folder.messages(), { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW })
  const sections = nodesOf(nodes, 'section')
  assert.equal(sections.length, 2, 'two canonical Work spans produce exactly two Activity sections')
  for (const section of sections) {
    assert.equal(section.props['collapsible'], true)
    assert.equal(section.props['collapsed'], true, 'Compact defaults every Work collapsed')
  }
  const spans = projectTranscriptStructure(folder.messages()).flatMap(block => block.kind === 'work' ? [block.span] : [])
  assert.equal(spans.length, 2)
  const keys = new TranscriptNodeKeys()
  for (const message of folder.messages()) keys.keyFor(message)
  assert.deepEqual(sections.map(section => section.props['key']), spans.map(span => `s1-work-${keys.keyFor(span.owner)}`),
    'each section key carries its own canonical owner')
  // User, intermediate and final Assistant are top-level, never inside a section.
  for (const text of ['inspect the repository', 'intermediate narration', 'the final answer']) {
    const row = nodes.find(node => node.parent === 'main' && descendantText(nodes, node.id).includes(text))
    assert.ok(row !== undefined, `the conversation row "${text}" stays in the main reading flow`)
  }
  assert.ok(descendantText(nodes, sections[0]!.id).includes('read ×1'), 'the first Activity reports only its own read action')
  assert.ok(descendantText(nodes, sections[1]!.id).includes('bash ×1'), 'the second Activity reports only its own bash action')
})

test('Compact creates no Activity for a turn without Process and never merges spans across an intermediate Assistant', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'just talking'),
    assistantMessage(2, 'a-1', 'a plain reply'),
  ])
  const nodes = flatten(folder.messages(), { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW })
  assert.equal(nodesOf(nodes, 'section').length, 0, 'no Process means no Activity')

  const split = twoWorkFolder()
  const splitNodes = flatten(split.messages(), { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW })
  const sections = nodesOf(splitNodes, 'section')
  assert.equal(sections.length, 2, 'the intermediate Assistant splits one turn into two independent Works')
  const firstMembers = descendantText(splitNodes, sections[0]!.id)
  const secondMembers = descendantText(splitNodes, sections[1]!.id)
  assert.ok(!firstMembers.includes('bash'), 'the first Work never absorbs the second Work action')
  assert.ok(!secondMembers.includes('read ×'), 'the second Work never absorbs the first Work action')
})

test('a collapsed Compact Work builds no hidden member, tool or image node; expanding it reveals only its own raw members', () => {
  const folder = twoWorkFolder()
  const messages = folder.messages()
  const ownerA = rowOf(folder, message => message.kind === 'thinking')
  const keys = new TranscriptNodeKeys()
  const collapsed = flatten(messages, { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW }, keys)
  const sectionA = nodesOf(collapsed, 'section')[0]!
  assert.equal(nodesOf(collapsed, 'tool').length, 0, 'a collapsed Activity builds no Tool node at all')
  assert.ok(!descendantText(collapsed, sectionA.id).includes('the file body'), 'the hidden Tool result is not built')

  const expanded = flatten(messages, { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, expandedWorkOwners: new Set([ownerA]) }, keys)
  const sections = nodesOf(expanded, 'section')
  assert.equal(sections[0]!.props['collapsed'], false, 'Work A is open')
  assert.equal(sections[1]!.props['collapsed'], true, 'Work B stays collapsed')
  assert.equal(nodesOf(expanded, 'tool').length, 1, 'only Work A owns a Tool node')
  assert.ok(descendantText(expanded, sections[0]!.id).includes('the file body'), 'the expanded Work shows its own original Tool result')
  assert.ok(descendantText(expanded, sections[0]!.id).includes('reading the structure first'), 'the expanded Work shows its own Thinking body')
  assert.equal(expanded.filter(node => node.parent === sections[1]!.id && node.kind === 'tool').length, 0, 'Work B still builds no Tool node of its own')
  // Expanding must not re-key any unrelated row: the same allocator keeps ids.
  const collapsedIds = collapsed.filter(node => node.parent === 'main').map(node => node.id)
  const expandedIds = expanded.filter(node => node.parent === 'main').map(node => node.id)
  assert.deepEqual(expandedIds, collapsedIds, 'top-level identity is disclosure-independent')
})

test('a carried Snapshot Context is a flat member of the open Work and never a counted Action', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'read with a snapshot'),
    ev('user/message', { id: MessageId('snap-1'), role: 'user', content: [{ type: 'text', text: 'snapshot body' }], source: { kind: 'plugin', form: 'snapshot' } }, 2),
    toolCall(3, 'call-read', 'read'),
    toolResult(4, 'call-read', 'body'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
  ])
  const messages = folder.messages()
  const spans = projectTranscriptStructure(messages).flatMap(block => block.kind === 'work' ? [block.span] : [])
  assert.equal(spans.length, 1, 'the foldable Snapshot is carried by the same-turn Work')
  const summary = summarizeWorkSpan(spans[0]!)
  assert.equal(summary.actionStats.total, 1, 'the Snapshot contributes no Action')
  const owner = spans[0]!.owner
  const nodes = flatten(messages, { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, expandedWorkOwners: new Set([owner]) })
  const section = nodesOf(nodes, 'section')[0]!
  assert.ok(descendantText(nodes, section.id).includes('snapshot body'), 'the carried Context is restored inside the open Work')
  assert.ok(descendantText(nodes, section.id).includes('read ×1'), 'the header counts only the real read')
  assert.equal(nodes.filter(node => node.parent === section.id && node.kind === 'card' && String(node.props['head'] ?? '').startsWith('Context')).length, 0,
    'clusterHeader:false paints no second, inoperable Context disclosure root')
})

// ── Thought identity and stats authority ────────────────────────────────────

test('a settled historical think-only Work reads Thought while an orphan result keeps Activity with zero counted actions', () => {
  const thinkOnly = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'think then answer'),
    reasoningMessage(2, 'think-a', 'only reasoning here', undefined, 0),
    assistantMessage(3, 'a-1', 'the answer', 1),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
    // A later turn makes the think-only Work historical (not the window tail).
    ev('turn/start', { turn: 2 }, 5),
    userMessage(6, 'user-2', 'next question'),
    toolCall(7, 'call-later', 'read'),
    toolResult(8, 'call-later', 'later body'),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 9),
  ])
  const historicalNodes = flatten(thinkOnly.messages(), { preset: 'compact', scopePrefix: 's1-', window: { mode: 'history', hasNewer: true } })
  const historicalSection = nodesOf(historicalNodes, 'section')[0]!
  assert.ok(descendantText(historicalNodes, historicalSection.id).includes('Thought'), 'a historical think-only span uses the Thought identity')
  assert.ok(!descendantText(historicalNodes, historicalSection.id).includes('Think:'), 'a historical Work shows no preview body')

  const orphan = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'an unpaired result'),
    // The span carries BOTH reasoning and the orphan: only the Action SOURCE
    // (not the zero count) may keep it `Activity`.
    reasoningMessage(2, 'think-orphan', 'reasoning before the orphan', undefined, 0),
    ev('tool/result', {
      turn: 1, step: 0,
      message: { id: MessageId('orphan-1'), role: 'tool', toolCallId: ToolCallId('never-called'), content: [{ type: 'text', text: 'late result' }], source: { kind: 'tool', callId: ToolCallId('never-called') } },
    }, 3),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
  ])
  const orphanSpans = projectTranscriptStructure(orphan.messages()).flatMap(block => block.kind === 'work' ? [block.span] : [])
  assert.equal(orphanSpans.length, 1)
  assert.equal(summarizeWorkSpan(orphanSpans[0]!).actionStats.total, 0, 'an orphan result counts zero actions')
  assert.equal(summarizeWorkSpan(orphanSpans[0]!).action?.kind, 'orphan-tool-result', 'but it still owns the Action presentation source')
  assert.ok(summarizeWorkSpan(orphanSpans[0]!).think !== undefined, 'the same span really carries reasoning, so a count-only Thought rule would misfire')
  const orphanNodes = flatten(orphan.messages(), { preset: 'compact', scopePrefix: 's1-', window: { mode: 'history', hasNewer: true } })
  const orphanSection = nodesOf(orphanNodes, 'section')[0]!
  const orphanText = descendantText(orphanNodes, orphanSection.id)
  assert.ok(orphanText.includes('Activity'), 'an orphan-result span stays Activity, never Thought')
  assert.ok(!orphanText.includes('Thought'), 'the zero action count alone must not mint a Thought')
})

test('the Activity header reports the span action stats and a proven duration, never a fabricated 0s or token count', () => {
  const folder = twoWorkFolder()
  const messages = folder.messages()
  const spans = projectTranscriptStructure(messages).flatMap(block => block.kind === 'work' ? [block.span] : [])
  const timing = spans.flatMap(span => span.members).map(message => transcriptTimingOf(message)).find(value => value !== undefined)
  assert.ok(timing !== undefined, 'the real fold produced a timing sidecar for this fixture')
  const nodes = flatten(messages, { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, turnActivities: folder.turnActivities() })
  const header = descendantText(nodes, nodesOf(nodes, 'section')[0]!.id)
  assert.ok(header.includes('1 action'), 'the header uses the shared action-stat cardinality')
  assert.ok(!header.includes('0s'), 'no zero-second duration is painted')
  assert.ok(!/\btok\b|tokens/iu.test(header), 'no token count is invented for a Work span')
  const summary = summarizeWorkSpan(spans[0]!)
  if (summary.timing?.endedAt !== undefined && summary.timing.endedAt > summary.timing.startedAt) {
    assert.ok(/\d+s|\d+m/u.test(header), 'a proven positive span duration is displayed')
  }
})

test('only the true latest tail Work previews live Preparing; a history window and an older turn stay header-only or standalone', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'start the tool'),
    reasoningMessage(2, 'think-a', 'preparing the call'),
  ])
  const messages = folder.messages()
  const preview: StreamingToolPreview = { callId: 'live-1', turn: 1, step: 0, index: 0, name: 'bash', argumentBytes: 12 }
  const latest = flatten(messages, { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, preparingPreviews: [preview] })
  const latestSection = nodesOf(latest, 'section')[0]!
  assert.ok(descendantText(latest, latestSection.id).includes('Preparing Bash'), 'the tail Work shows exactly one bounded Preparing line')
  assert.equal(latest.filter(node => node.id.endsWith('.head.action')).length, 1, 'the preview is ONE Action row, not a second execution row')

  const history = flatten(messages, { preset: 'compact', scopePrefix: 's1-', window: { mode: 'history', hasNewer: true }, preparingPreviews: [preview] })
  const historySection = nodesOf(history, 'section')[0]!
  assert.ok(!descendantText(history, historySection.id).includes('Think:'), 'a history window shows no live preview body')

  const older: StreamingToolPreview = { callId: 'old-1', turn: 0, step: 0, index: 0, name: 'read', argumentBytes: 4 }
  const withOlder = flatten(messages, { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, preparingPreviews: [older] })
  const olderSection = nodesOf(withOlder, 'section')[0]!
  assert.ok(!descendantText(withOlder, olderSection.id).includes('Preparing'), 'an older turn Preparing never enters this Activity')
  assert.ok(withOlder.some(node => node.parent === 'main' && node.id.includes('preparing-old-1')), 'it fails open as a standalone row instead')
})

test('an expanded tail Work renders the native Preparing row once and retires the header preview', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'start the tool'),
    reasoningMessage(2, 'think-a', 'preparing the call'),
  ])
  const messages = folder.messages()
  const owner = rowOf(folder, message => message.kind === 'thinking')
  const preview: StreamingToolPreview = { callId: 'live-1', turn: 1, step: 0, index: 0, name: 'bash', argumentBytes: 12 }
  const nodes = flatten(messages, { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, preparingPreviews: [preview], expandedWorkOwners: new Set([owner]) })
  const section = nodesOf(nodes, 'section')[0]!
  assert.equal(section.props['collapsed'], false)
  assert.ok(!descendantText(nodes, `${section.id}.head`).includes('Action:'), 'the header preview retires while expanded')
  const preparingRows = nodes.filter(node => node.parent === section.id && node.id.includes('preparing-live-1'))
  assert.equal(preparingRows.length, 1, 'exactly one native Preparing row inside the open Work')
})

// ── Identity, media demand and the legacy/focus boundary ────────────────────

test('a collapsed Activity never demands a Tool SVG blob, and expanding it uses the original tool node path', () => {
  const svgSource = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'draw it'),
    toolCall(2, 'call-svg', 'dsh_pi_tui_svg', { title: 'Box', description: 'a box', svg: svgSource }),
    toolResult(3, 'call-svg', 'visual-v1:{"type":"svg","title":"Box","description":"a box","digest":"x","bytes":10}'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
  ])
  const messages = folder.messages()
  const toolRow = rowOf(folder, (message): message is Extract<TranscriptMessage, { kind: 'tool' }> => message.kind === 'tool')
  let demanded = 0
  const svgStates = new Map<Extract<TranscriptMessage, { kind: 'tool' }>, never>().set(toolRow, { state: 'ready', fact: { title: 'Box' }, source: svgSource, request: () => { demanded += 1; return 'blob-1' } } as never)
  const collapsed = flatten(messages, { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, toolSvgStates: svgStates, expandedToolKeys: new Set<string>() })
  assert.equal(demanded, 0, 'a collapsed Activity header sends no SVG blob')
  assert.equal(nodesOf(collapsed, 'image').length, 0, 'and builds no image node')
  const owner = projectTranscriptStructure(messages).find(block => block.kind === 'work')
  assert.ok(owner?.kind === 'work')
  const expanded = flatten(messages, { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, toolSvgStates: svgStates, expandedToolKeys: new Set<string>(), expandedWorkOwners: new Set([owner.span.owner]) })
  assert.equal(nodesOf(expanded, 'tool').length, 1, 'the expanded Work uses the original tool node')
  assert.equal(demanded, 0, 'opening the Work is NOT a Tool SVG disclosure: the tool card stays collapsed until its own toggle')
})

test('Focus materializes one native Thought root per occurrence and nests collapsed canonical Work', () => {
  const folder = twoWorkFolder()
  const messages = folder.messages()
  const activities = folder.turnActivities()
  const keys = new TranscriptNodeKeys()
  const collapsed = flatten(messages, {
    preset: 'focus',
    scopePrefix: 's1-',
    turnActivities: activities,
    window: LATEST_WINDOW,
  }, keys)
  const roots = nodesOf(collapsed, 'section').filter(node => node.parent === 'main')
  assert.equal(roots.length, 1, 'one consecutive turn occurrence paints one top-level Thought section')
  assert.equal(roots[0]!.props['collapsible'], true)
  assert.equal(roots[0]!.props['collapsed'], true, 'Focus roots start collapsed')
  assert.equal(nodesOf(collapsed, 'section').length, 1, 'there is no parallel top-level Action disclosure')
  assert.equal(nodesOf(collapsed, 'tool').length, 0, 'collapsed Focus materializes no hidden Work tool')
  assert.ok(descendantText(collapsed, roots[0]!.id).includes('Think:'), 'the root carries inert Think preview text')
  assert.ok(descendantText(collapsed, roots[0]!.id).includes('Action:'), 'the root carries inert Action preview text')
  assert.ok(collapsed.some(node => node.parent === 'main' && descendantText(collapsed, node.id).includes('inspect the repository')),
    'the initial input remains outside the root')
  assert.ok(collapsed.some(node => node.parent === 'main' && descendantText(collapsed, node.id).includes('the final answer')),
    'the official final remains outside the root')

  const expanded = flatten(messages, {
    preset: 'focus',
    scopePrefix: 's1-',
    turnActivities: activities,
    window: LATEST_WINDOW,
    expandedFocusTurns: new Set([1]),
  }, keys)
  const expandedRoots = nodesOf(expanded, 'section').filter(node => node.parent === 'main')
  const workSections = nodesOf(expanded, 'section').filter(node => node.parent === expandedRoots[0]!.id)
  assert.equal(expandedRoots.length, 1, 'opening reuses the same root occurrence')
  assert.equal(expandedRoots[0]!.id, roots[0]!.id, 'the root node identity is stable')
  assert.equal(expandedRoots[0]!.props['collapsed'], false)
  assert.equal(workSections.length, 2, 'the canonical two Work spans are nested under the root')
  assert.ok(workSections.every(section => section.props['collapsible'] === true && section.props['collapsed'] === true),
    'each nested Work starts independently collapsed')
  assert.equal(nodesOf(expanded, 'tool').length, 0, 'opening only the root does not materialize hidden Work members')
})

test('same-turn Focus occurrences split by a session command share expansion without merging roots', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'inspect both stages'),
    reasoningMessage(2, 'think-a', 'first stage', undefined, 0),
    toolCall(3, 'call-a', 'read', {}, 0),
    toolResult(4, 'call-a', 'first result', 0),
    ev('command/run', { commandId: CommandId('focus-boundary'), name: 'status', source: { kind: 'user' } }, 5),
    ev('command/done', { commandId: CommandId('focus-boundary'), kind: 'success', text: 'session healthy' }, 6),
    reasoningMessage(7, 'think-b', 'second stage', undefined, 1),
    toolCall(8, 'call-b', 'bash', { command: 'echo second' }, 1),
    toolResult(9, 'call-b', 'second result', 1),
    assistantMessage(10, 'final-split', 'one final answer', 2),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 11),
  ])
  const messages = folder.messages()
  const keys = new TranscriptNodeKeys()
  const collapsed = flatten(messages, {
    preset: 'focus', scopePrefix: 's1-', turnActivities: folder.turnActivities(), window: LATEST_WINDOW,
  }, keys)
  const roots = nodesOf(collapsed, 'section').filter(node => node.parent === 'main')
  assert.equal(roots.length, 2, 'the turnless command splits two distinct Thought occurrences')
  assert.notEqual(roots[0]!.id, roots[1]!.id, 'occurrence ids use distinct message owners')
  assert.ok(collapsed.some(node => node.parent === 'main' && descendantText(collapsed, node.id).includes('session healthy')),
    'the turnless command remains a standalone row between the roots')

  const expanded = flatten(messages, {
    preset: 'focus', scopePrefix: 's1-', turnActivities: folder.turnActivities(), window: LATEST_WINDOW,
    expandedFocusTurns: new Set([1]),
  }, keys)
  const expandedRoots = nodesOf(expanded, 'section').filter(node => node.parent === 'main')
  assert.deepEqual(expandedRoots.map(node => node.id), roots.map(node => node.id), 'both occurrence node identities stay stable')
  assert.ok(expandedRoots.every(node => node.props['collapsed'] === false),
    'one Turn disclosure choice opens both occurrence roots')
  assert.equal(nodesOf(expanded, 'tool').length, 0, 'the inner Work owners remain independently collapsed')
  const finals = expanded.filter(node => node.parent === 'main' && descendantText(expanded, node.id).includes('one final answer'))
  assert.equal(finals.length, 1, 'the qualified final remains one top-level Assistant card')
  assert.ok(!finals[0]!.id.startsWith(`${expandedRoots[0]!.id}.`) && !finals[0]!.id.startsWith(`${expandedRoots[1]!.id}.`),
    'the final is not absorbed by either occurrence')
})

test('Focus image demand follows the materialized root and Work members', () => {
  const folder = twoWorkFolder()
  const messages = folder.messages()
  const toolRow = rowOf(folder, (message): message is Extract<TranscriptMessage, { kind: 'tool' }> => message.kind === 'tool')
  const work = projectTranscriptStructure(messages).find(block => block.kind === 'work')
  assert.ok(work?.kind === 'work')
  const base = {
    preset: 'focus' as const,
    turnActivities: folder.turnActivities(),
    window: LATEST_WINDOW,
  }
  const collapsed = visibleTranscriptMembers(messages, base)
  assert.ok(!collapsed.has(toolRow), 'a collapsed Focus root reads no hidden Work image')
  const rootExpanded = visibleTranscriptMembers(messages, { ...base, expandedFocusTurns: new Set([1]) })
  assert.ok(!rootExpanded.has(toolRow), 'an open root with closed Work still reads no Work image')
  const workExpanded = visibleTranscriptMembers(messages, {
    ...base,
    expandedFocusTurns: new Set([1]),
    expandedWorkOwners: new Set([work.span.owner]),
  })
  assert.ok(workExpanded.has(toolRow), 'opening the owning Work makes its real member visible')
})

test('a missing Focus activity fails open and an unbound mount keeps the legacy layout', () => {
  const folder = twoWorkFolder()
  const messages = folder.messages()
  const legacy = View.from({ main: transcriptView(projectTranscriptStructure(messages), new TranscriptNodeKeys(), { scopePrefix: 's1-' }) })
  const focusWithoutActivity = flatten(messages, {
    preset: 'focus', scopePrefix: 's1-', window: LATEST_WINDOW,
  })
  assert.equal(nodesOf(focusWithoutActivity, 'section').length, 0,
    'without TurnActivity the Focus projector fails open without a phantom root')
  assert.ok(focusWithoutActivity.filter(node => node.parent === 'main' && node.id !== 'main').length >= messages.length,
    'every original row remains visible')
  const legacySection = legacy.regions[0]?.children.find(child => child.kind === 'section')
  assert.ok(legacySection !== undefined)
  assert.equal(legacySection.props['collapsible'], undefined, 'unbound standalone layout keeps its legacy Work shape')
})

test('Focus renders a live Preparing only in the latest window selected from the same Folder', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'history-user', 'an earlier prompt'),
    assistantMessage(2, 'history-answer', 'an earlier answer'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
    ev('turn/start', { turn: 2 }, 4),
    userMessage(5, 'live-user', 'prepare the next tool'),
    ev('step/start', { turn: 2, step: 0 }, 6),
  ])
  const previews = new Map<string, StreamingToolPreview>()
  applyAssistantLiveInput(folder, new StatsFolder(), previews, {
    kind: 'chunk', sessionId: 'window-preparing', attemptId: 'live-preparing', turn: 2, step: 0,
    time: T0 + 7000,
    chunk: { type: 'tool-call-delta', index: 0, id: 'window-live-bash', name: 'bash', argumentsDelta: '{"command":"echo pending"}' },
  }, toolSummaryKeys)
  const preparingPreviews = streamingToolPreviewSnapshot(previews)
  assert.equal(preparingPreviews.length, 1, 'the production live applier produced the preview')
  const controller = new TranscriptWindowController({ windowTurns: 1, stepTurns: 1, turns: folder.groupedTurns() })
  const latest = folder.window({ maxTurns: controller.windowTurns })
  assert.equal(controller.snapshot().hasNewer, false)
  assert.equal(latest.hasNewer, false)
  assert.equal(controller.anchorAt(1), true, 'the Folder controller selects the earlier turn')
  assert.equal(controller.snapshot().hasNewer, true)
  const historyEndTurn = controller.endTurn()
  assert.equal(historyEndTurn, 1)
  const history = folder.window({
    maxTurns: controller.windowTurns,
    ...(historyEndTurn === undefined ? {} : { endTurn: historyEndTurn }),
  })
  assert.equal(history.hasNewer, true)
  assert.ok(history.messages.every(message => !('turn' in message) || message.turn !== 2),
    'the selected historical Folder window excludes the current turn')
  const base = { preset: 'focus' as const, turnActivities: folder.turnActivities(), preparingPreviews }
  for (const expandedFocusTurns of [new Set<number>(), new Set([1, 2])]) {
    const latestNodes = flatten(latest.messages, { ...base, expandedFocusTurns, window: { mode: 'latest', hasNewer: latest.hasNewer } })
    assert.ok(latestNodes.some(node => textOf(node).includes('Preparing Bash')),
      'the latest window materializes its current Preparing as a summary or row')
    const historyNodes = flatten(history.messages, { ...base, expandedFocusTurns, window: { mode: 'history', hasNewer: history.hasNewer } })
    assert.ok(!historyNodes.some(node => textOf(node).includes('Preparing') || node.id.includes('preparing-window-live-bash')),
      'the actual history window never materializes the live preview, including standalone rows')
  }
})

test('an ownerless Focus Preparing stays on its real root without inventing Work', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-pending', 'prepare the next tool'),
  ])
  const messages = folder.messages()
  const preview: StreamingToolPreview = {
    callId: 'focus-ownerless', turn: 1, step: 0, index: 0, name: 'bash', argumentBytes: 12,
  }
  const options = {
    preset: 'focus' as const,
    scopePrefix: 's1-',
    turnActivities: folder.turnActivities(),
    window: LATEST_WINDOW,
    preparingPreviews: [preview],
  }
  const collapsed = flatten(messages, options)
  const root = nodesOf(collapsed, 'section')[0]!
  assert.ok(descendantText(collapsed, root.id).includes('Action: Preparing Bash'),
    'the collapsed root uses the bounded Preparing summary in its Action slot')
  assert.equal(nodesOf(collapsed, 'section').length, 1, 'no pseudo Work section is created')

  const unknownWindow = flatten(messages, { ...options, window: undefined })
  assert.ok(!unknownWindow.some(node => node.id.includes('preparing-focus-ownerless')),
    'an unproven latest window does not materialize live Preparing')

  const expanded = flatten(messages, { ...options, expandedFocusTurns: new Set([1]) })
  const expandedRoot = nodesOf(expanded, 'section')[0]!
  assert.equal(expandedRoot.props['collapsed'], false)
  assert.equal(nodesOf(expanded, 'section').length, 1, 'the open root still has no durable Work child')
  assert.equal(expanded.filter(node => node.id.includes('preparing-focus-ownerless') && node.parent === expandedRoot.id).length, 1,
    'the ownerless Preparing row remains a root child when expanded')
})

test('a new Focus Preparing after an Assistant stays outside the earlier Work', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-pending-after-work', 'inspect then continue'),
    toolCall(2, 'prior-work', 'read'),
    toolResult(3, 'prior-work', 'first result'),
    assistantMessage(4, 'before-pending', 'the first result is ready', 1),
    ev('step/start', { turn: 1, step: 2 }, 5),
  ])
  const messages = folder.messages()
  const structure = projectTranscriptStructure(messages)
  const priorWork = structure.find(block => block.kind === 'work')
  assert.ok(priorWork?.kind === 'work')
  assert.equal(structure.at(-1)?.kind, 'message', 'the new pending run has no durable Work')
  const options = {
    preset: 'focus' as const, scopePrefix: 's1-', turnActivities: folder.turnActivities(),
    window: LATEST_WINDOW,
    preparingPreviews: [{
      callId: 'focus-after-assistant', turn: 1, step: 2, index: 0, name: 'bash', argumentBytes: 12,
    }],
  }
  const collapsed = flatten(messages, options)
  assert.ok(descendantText(collapsed, nodesOf(collapsed, 'section')[0]!.id).includes('Action: Preparing Bash'))
  for (const expandedWorkOwners of [new Set<TranscriptMessage>(), new Set([priorWork.span.owner])]) {
    const expanded = flatten(messages, { ...options, expandedFocusTurns: new Set([1]), expandedWorkOwners })
    const root = nodesOf(expanded, 'section').find(node => node.parent === 'main')!
    const works = nodesOf(expanded, 'section').filter(node => node.parent === root.id)
    assert.equal(works.length, 1, 'the pending run never invents a second Work')
    assert.ok(!descendantText(expanded, works[0]!.id).includes('Preparing'), 'the earlier Work never adopts the new run')
    const rows = nodesOf(expanded, 'row').filter(node => node.id.includes('preparing-focus-after-assistant'))
    assert.equal(rows.length, 1, 'the new run stays visible exactly once with either earlier Work disclosure')
    assert.equal(rows[0]!.parent, root.id, 'Preparing is an ordinary child of the expanded Root')
  }
})

test('Focus Preparing previews attach once to the exact trailing Work owner', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-focus-preparing', 'inspect and run'),
    reasoningMessage(2, 'think-work-a', 'first work', undefined, 0),
    toolCall(3, 'call-work-a', 'read', {}, 0),
    toolResult(4, 'call-work-a', 'first result', 0),
    assistantMessage(5, 'assistant-between-works', 'intermediate reply', 1),
    reasoningMessage(6, 'think-work-b', 'second work', undefined, 2),
    toolCall(7, 'call-work-b', 'bash', { command: 'echo pending' }, 2),
  ])
  const messages = folder.messages()
  const activities = folder.turnActivities()
  assert.equal(activities.get(1)?.completed, false, 'the Turn is still running')
  const spans = projectTranscriptStructure(messages).flatMap(block => block.kind === 'work' ? [block.span] : [])
  assert.equal(spans.length, 2, 'the intermediate Assistant splits two canonical Work spans')
  const [workA, workB] = spans
  assert.ok(workA !== undefined && workB !== undefined)
  const preparing: StreamingToolPreview = {
    callId: 'focus-tail-preparing', turn: 1, step: 2, index: 0, name: 'bash', argumentBytes: 24,
  }
  const keys = new TranscriptNodeKeys()
  const collapsed = flatten(messages, {
    preset: 'focus', scopePrefix: 's1-', turnActivities: activities, window: LATEST_WINDOW,
    preparingPreviews: [preparing],
  }, keys)
  const collapsedRoot = nodesOf(collapsed, 'section').find(node => node.parent === 'main')!
  assert.ok(descendantText(collapsed, collapsedRoot.id).includes('Action: Preparing Bash'),
    'the collapsed root uses its bounded Turn Action preview')
  assert.equal(nodesOf(collapsed, 'row').filter(node => textOf(node).includes('Preparing')).length, 0,
    'the collapsed frame materializes no standalone Preparing row')

  const expanded = flatten(messages, {
    preset: 'focus', scopePrefix: 's1-', turnActivities: activities, window: LATEST_WINDOW,
    expandedFocusTurns: new Set([1]), preparingPreviews: [preparing],
  }, keys)
  const root = nodesOf(expanded, 'section').find(node => node.parent === 'main')!
  const works = nodesOf(expanded, 'section').filter(node => node.parent === root.id)
  assert.equal(works.length, 2, 'both Work occurrences remain separate native sections')
  assert.ok(!descendantText(expanded, works[0]!.id).includes('Preparing'),
    'the earlier Work never adopts the later Working preview')
  assert.ok(descendantText(expanded, works[1]!.id).includes('Action: Preparing Bash'),
    'only the exact trailing Work head owns its collapsed Preparing summary')
  assert.equal(nodesOf(expanded, 'row').filter(node => textOf(node).includes('Preparing')).length, 0,
    'the collapsed trailing Work does not build its hidden Preparing row')

  const expandedTail = flatten(messages, {
    preset: 'focus', scopePrefix: 's1-', turnActivities: activities, window: LATEST_WINDOW,
    expandedFocusTurns: new Set([1]), expandedWorkOwners: new Set([workB.owner]), preparingPreviews: [preparing],
  }, keys)
  const tailSection = nodesOf(expandedTail, 'section').find(node => node.id === works[1]!.id)!
  assert.ok(!descendantText(expandedTail, works[0]!.id).includes('Preparing'),
    'opening the tail Work never copies Preparing into the earlier Work')
  assert.equal(expandedTail.filter(node => node.id.includes('preparing-focus-tail-preparing') && node.parent === tailSection.id).length, 1,
  `opening the exact trailing Work materializes one Preparing row inside that Work: ${JSON.stringify(expandedTail.filter(node => node.id.includes('preparing-focus-tail-preparing')))}`)
})

test('a replaced source scope cannot reuse the previous Work section identity', () => {
  const folder = twoWorkFolder()
  const messages = folder.messages()
  const first = flatten(messages, { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW })
  const second = flatten(messages, { preset: 'compact', scopePrefix: 's2-', window: LATEST_WINDOW })
  const firstIds = new Set(nodesOf(first, 'section').map(node => node.id))
  const secondIds = new Set(nodesOf(second, 'section').map(node => node.id))
  assert.equal(firstIds.size, 2)
  assert.equal(secondIds.size, 2)
  for (const id of secondIds) assert.ok(!firstIds.has(id), `the new scope id ${id} shares nothing with the retired scope`)
})

test('an earlier Work of a still-open turn stays header-only while only the projected tail previews', () => {
  // ONE still-open turn, TWO canonical Work spans split by an intermediate
  // Assistant. The earlier span is historical even though the TURN is not
  // completed: a turn key is not an owner identity, and the live preview
  // belongs to the projected tail Work alone.
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'first pass'),
    reasoningMessage(2, 'think-first', 'first reasoning', undefined, 0),
    toolCall(3, 'call-first', 'read', {}, 0),
    toolResult(4, 'call-first', 'first body', 0),
    assistantMessage(5, 'mid-1', 'intermediate narration', 1),
    reasoningMessage(6, 'think-second', 'second reasoning', undefined, 2),
    toolCall(7, 'call-second', 'bash', {}, 2),
  ])
  const activities = folder.turnActivities()
  assert.equal(activities.get(1)?.completed, false, 'fixture: the owning turn is genuinely still open')
  const spans = projectTranscriptStructure(folder.messages()).flatMap(block => block.kind === 'work' ? [block.span] : [])
  assert.equal(spans.length, 2, 'fixture: two canonical Work spans in one open turn')
  const earlierPreparing: StreamingToolPreview = { callId: 'live-earlier', turn: 1, step: 0, index: 0, name: 'read', argumentBytes: 8 }
  const secondPreparing: StreamingToolPreview = { callId: 'live-second', turn: 1, step: 2, index: 0, name: 'bash', argumentBytes: 8 }
  const nodes = flatten(folder.messages(), {
    preset: 'compact',
    scopePrefix: 's1-',
    window: LATEST_WINDOW,
    preparingPreviews: [earlierPreparing, secondPreparing],
  })
  const sections = nodesOf(nodes, 'section')
  assert.equal(sections.length, 2)
  const earlier = descendantText(nodes, sections[0]!.id)
  const tail = descendantText(nodes, sections[1]!.id)
  assert.ok(!earlier.includes('Think:'), 'the earlier Work paints no Think preview')
  assert.ok(!earlier.includes('Action:'), 'the earlier Work paints no Action/Preparing preview')
  assert.ok(!earlier.includes('first reasoning'), 'its reasoning stays hidden while collapsed')
  assert.ok(tail.includes('Think: second reasoning'), 'the projected TAIL Work keeps its bounded Think preview')
  // The existing `groupPreparingPreviews` rule groups by TURN, so the trailing
  // Work of that turn adopts the same-turn group (plan §1.2: reuse the original
  // rule for the tail Work). The earlier span never receives it.
  assert.ok(tail.includes('Action: Preparing'), 'the tail Work of that turn renders the bounded Preparing line')
  assert.ok(!earlier.includes('Preparing'), 'the earlier span never receives the Preparing line')

  // A Preparing for a DIFFERENT turn must still fail open as a standalone row.
  const foreign: StreamingToolPreview = { callId: 'live-foreign', turn: 0, step: 0, index: 0, name: 'read', argumentBytes: 8 }
  const withForeign = flatten(folder.messages(), {
    preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, preparingPreviews: [foreign],
  })
  assert.ok(withForeign.some(node => node.parent === 'main' && node.id.includes('preparing-live-foreign')),
    'a non-adopted turn Preparing fails open as a standalone row')
  assert.ok(nodesOf(withForeign, 'section').every(section => !descendantText(withForeign, section.id).includes('Preparing')),
    'no Work adopts a foreign-turn Preparing')
})

test('only a truly trailing incomplete Work previews Thinking; an Assistant reply retires the preview before turn/end', () => {
  const open = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'think only'),
    reasoningMessage(2, 'think-tail', 'the only reasoning', undefined, 0),
  ])
  const openNodes = flatten(open.messages(), {
    preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, turnActivities: open.turnActivities(),
  })
  const openSection = nodesOf(openNodes, 'section')[0]!
  const openText = descendantText(openNodes, openSection.id)
  assert.ok(open.turnActivities().get(1)?.completed === false, 'fixture: the owning turn is incomplete')
  assert.ok(openText.includes('Activity'), 'an incomplete Think-only span remains Activity')
  assert.ok(openText.includes('Think: the only reasoning'), 'the incomplete trailing Work may preview Thinking')

  // Capture the frame AFTER assistant/message but BEFORE turn/end: Work is no
  // longer the canonical trailing block even though the turn remains open.
  open.apply([assistantMessage(3, 'a-1', 'the final reply', 1)])
  assert.equal(open.turnActivities().get(1)?.completed, false, 'fixture: turn/end has not arrived')
  const replyingNodes = flatten(open.messages(), {
    preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, turnActivities: open.turnActivities(),
  })
  const replyingSection = nodesOf(replyingNodes, 'section')[0]!
  const replyingText = descendantText(replyingNodes, replyingSection.id)
  assert.ok(replyingText.includes('Thought'), `a Work followed by Assistant is no longer preview-active: ${replyingText}`)
  assert.ok(!replyingText.includes('Think:'), 'the non-trailing Work preview disappears before turn/end')
  assert.ok(replyingNodes.some(node => node.parent === 'main' && descendantText(replyingNodes, node.id).includes('the final reply')),
    'the final Assistant reply stays in the reading flow')

  // The authoritative turn boundary preserves the same settled presentation.
  open.apply([ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4)])
  const settledNodes = flatten(open.messages(), {
    preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, turnActivities: open.turnActivities(),
  })
  const settledSection = nodesOf(settledNodes, 'section')[0]!
  const settledText = descendantText(settledNodes, settledSection.id)
  assert.equal(open.turnActivities().get(1)?.completed, true, 'fixture: the same turn is now settled')
  assert.ok(settledText.includes('Thought'), `a completed non-preview Think-only Work is Thought: ${settledText}`)
  assert.ok(!settledText.includes('Think:'), 'completed turn state keeps the preview retired')
})

test('a Work with a still-running member omits its duration instead of showing the settled members elapsed time', () => {
  // The previous Tool settled at T+3s while a LATER Thinking member is still
  // streaming: the Work has no proven close boundary, so its header must not
  // present `1s` as if the Activity had finished.
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'keep streaming'),
    toolCall(2, 'call-a', 'read', {}, 0),
    toolResult(3, 'call-a', 'first body', 0),
  ])
  folder.applyLiveInput({
    kind: 'chunk', sessionId: 'modes-live', attemptId: 'attempt-1', turn: 1, step: 1,
    time: T0 + 9_000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' },
  } as never)
  folder.applyLiveInput({
    kind: 'chunk', sessionId: 'modes-live', attemptId: 'attempt-1', turn: 1, step: 1,
    time: T0 + 9_100, chunk: { type: 'reasoning-delta', index: 0, text: 'still streaming' },
  } as never)
  const spans = projectTranscriptStructure(folder.messages()).flatMap(block => block.kind === 'work' ? [block.span] : [])
  assert.equal(spans.length, 1)
  const timing = summarizeWorkSpan(spans[0]!).timing
  assert.ok(timing !== undefined && timing.endedAt !== undefined, 'fixture: an earlier member really settled')
  assert.equal(timing.running, true, 'fixture: the Work has a still-running member')
  const nodes = flatten(folder.messages(), {
    preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, turnActivities: folder.turnActivities(),
  })
  const header = descendantText(nodes, nodesOf(nodes, 'section')[0]!.id)
  assert.ok(header.includes('Activity'), 'the identity stays Activity while the Work runs')
  assert.ok(!/\d+s\b/u.test(header.split('Activity')[1] ?? ''), `no settled duration is painted for a running Work: ${header}`)
  assert.ok(header.includes('Think: still streaming'), 'the live Think preview keeps following the stream')

  // The same fold with the reasoning settled proves a real duration appears.
  const settled = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'finish the work'),
    toolCall(2, 'call-a', 'read', {}, 0),
    toolResult(3, 'call-a', 'first body', 0),
    reasoningMessage(4, 'think-settled', 'the finished reasoning', undefined, 1),
    assistantMessage(5, 'a-1', 'done', 1),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
  ])
  const settledNodes = flatten(settled.messages(), {
    preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, turnActivities: settled.turnActivities(),
  })
  const settledHeader = descendantText(settledNodes, nodesOf(settledNodes, 'section')[0]!.id)
  assert.ok(/Activity( · \d+s|\s\d+s)/u.test(settledHeader), `a proven settled span paints its duration: ${settledHeader}`)
})

test('the collapsed Action line keeps the running PTC sub-call suffix and drops it once settled', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'run the program'),
    toolCall(2, 'call-code', 'run_code', { code: 'print(1)' }, 0),
    ev('tool/ptc-dispatch-start', {
      rootCallId: ToolCallId('call-code'), parentCallId: ToolCallId('call-code'), subCallId: 'call-code:bash:1', name: 'bash', arguments: { command: 'echo hi' },
    }, 3),
  ])
  const nodes = flatten(folder.messages(), {
    preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, turnActivities: folder.turnActivities(),
  })
  const header = descendantText(nodes, nodesOf(nodes, 'section')[0]!.id)
  assert.ok(header.includes('Action:'), 'the collapsed Work shows an Action preview line')
  assert.ok(/Bash running/u.test(header), `the running sub-call stays visible in the Action line: ${header}`)

  // The child settles: the suffix must disappear from the same projection.
  folder.apply([
    ev('tool/ptc-dispatch', {
      rootCallId: ToolCallId('call-code'), parentCallId: ToolCallId('call-code'), subCallId: 'call-code:bash:1',
      name: 'bash', arguments: { command: 'echo hi' }, isError: false, content: [{ type: 'text', text: 'hi' }],
    }, 4),
  ])
  const settledNodes = flatten(folder.messages(), {
    preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW, turnActivities: folder.turnActivities(),
  })
  const settledHeader = descendantText(settledNodes, nodesOf(settledNodes, 'section')[0]!.id)
  assert.ok(!/running/u.test(settledHeader), `the settled child drops the suffix: ${settledHeader}`)
  assert.ok(settledHeader.includes('Action:'), `the durable Action remains after settlement: ${settledHeader}`)
})
