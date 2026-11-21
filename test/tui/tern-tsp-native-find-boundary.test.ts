/**
 * T3-A: the boundary between the CLIENT-owned Native Find and the application's
 * semantic search authority.
 *
 * The two questions are different and must not be collapsed:
 *   - the Tern client's native Find searches the document the CLIENT has
 *     committed to its pane (its own scrollback), so a row whose body the
 *     preset never materialized is not in that document;
 *   - `TranscriptFolder.search()` owns the SEMANTIC corpus of the messages the
 *     Client has loaded, including text that lives inside a collapsed card.
 *
 * This file asserts that DIFFERENCE on the production pure projection: real
 * official SessionEvents through the real `TranscriptFolder`, the real
 * preset mapper (`transcriptViewForPreset`) and real SDK node identities.
 * It never fakes a Tern client, never invents a Find index, and never claims a
 * client pixel/behaviour fact — the real-client lane owns that.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-native-find-boundary.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { View, type JsonObject, type Tree } from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import {
  TranscriptNodeKeys,
  transcriptViewForPreset,
  type TranscriptPresetViewOptions,
} from '../../src/tui/tsp/transcript-view.ts'

const T0 = 1_700_000_000_000
const ARCHIVE = 'T3A_MAIN_ARCHIVE_7C19'
const SHARED = 'T3A_MAIN_SHARED_3A4D'
const TAIL = 'T3A_MAIN_TAIL_8E02'
const INNER_ONLY = 'T3A_INNER_ONLY_2D73'

function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq * 1000, data } as SessionEvent
}

interface FlatNode {
  readonly id: string
  readonly kind: string
  readonly props: JsonObject
  readonly parent: string | undefined
}

/** Every node of the `main` region with its REAL SDK-derived id. */
function flatten(
  messages: readonly TranscriptMessage[],
  options: TranscriptPresetViewOptions,
  keys = new TranscriptNodeKeys(),
): FlatNode[] {
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

const textOf = (node: FlatNode | undefined): string => String(node?.props['text'] ?? '')
/** Every text prop in the materialized subtree rooted at `id`. */
const subtreeText = (nodes: readonly FlatNode[], id: string): string => nodes
  .filter(node => node.id === id || node.id.startsWith(`${id}.`))
  .map(textOf)
  .join('\n')

/**
 * The T3-A seed shape in miniature: an old ARCHIVE user row, two assistant
 * SHARED rows in DIFFERENT turns, a tail TAIL row and one Tool whose LONG
 * result body carries INNER_ONLY. Every row is an official event.
 */
function nativeFindFolder(): TranscriptFolder {
  const folder = new TranscriptFolder()
  const events: SessionEvent[] = []
  let seq = 0
  const turn = (n: number, userText: string, assistantText: string): void => {
    events.push(ev('turn/start', { turn: n }, seq++))
    events.push(ev('user/message', {
      id: MessageId(`t3a-u-${n}`), role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user' },
    }, seq++))
    events.push(ev('step/start', { turn: n, step: 0 }, seq++))
    events.push(ev('assistant/message', {
      turn: n,
      step: 0,
      message: {
        id: MessageId(`t3a-a-${n}`),
        role: 'assistant',
        content: [{ type: 'text', text: assistantText }],
        source: { kind: 'model', provider: 'scripted', model: 'scripted' },
      },
      stream: [],
    }, seq++))
    events.push(ev('step/end', { turn: n, step: 0 }, seq++))
    events.push(ev('turn/end', { turn: n, reason: { kind: 'completed' } }, seq++))
  }
  turn(1, `an old archive request referencing ${ARCHIVE}`, 'a plain answer')
  turn(2, 'a middle request', `the shared answer carries ${SHARED}`)
  // The Turn-3 Tool: its result body is long and carries INNER_ONLY.
  events.push(ev('turn/start', { turn: 3 }, seq++))
  events.push(ev('user/message', {
    id: MessageId('t3a-u-3'), role: 'user', content: [{ type: 'text', text: 'read the example file' }], source: { kind: 'user' },
  }, seq++))
  events.push(ev('step/start', { turn: 3, step: 0 }, seq++))
  events.push(ev('tool/call', {
    turn: 3, step: 0, callId: ToolCallId('call-t3a-inner'), name: 'read',
    arguments: JSON.stringify({ file_path: 'src/t3a-inner-example.ts' }),
  }, seq++))
  events.push(ev('tool/result', {
    turn: 3,
    step: 0,
    message: {
      id: MessageId('t3a-tool-3'),
      role: 'tool',
      toolCallId: ToolCallId('call-t3a-inner'),
      content: [{ type: 'text', text: [
        '<path>src/t3a-inner-example.ts</path>',
        '<type>file</type>',
        '<content>',
        ...Array.from({ length: 14 }, (_, line) => `${line + 1}: inner file line ${line + 1}`),
        `9: ${INNER_ONLY} lives inside this collapsed Tool result body`,
        ...Array.from({ length: 6 }, (_, line) => `${line + 15}: inner file line ${line + 15}`),
        '(End of file - total 20 lines)',
        '</content>',
      ].join('\n') }],
      source: { kind: 'tool', callId: ToolCallId('call-t3a-inner') },
    },
  }, seq++))
  events.push(ev('assistant/message', {
    turn: 3,
    step: 0,
    message: {
      id: MessageId('t3a-a-3'),
      role: 'assistant',
      content: [{ type: 'text', text: 'a plain answer' }],
      source: { kind: 'model', provider: 'scripted', model: 'scripted' },
    },
    stream: [],
  }, seq++))
  events.push(ev('step/end', { turn: 3, step: 0 }, seq++))
  events.push(ev('turn/end', { turn: 3, reason: { kind: 'completed' } }, seq++))
  turn(4, 'a later request', `the shared answer again carries ${SHARED}`)
  turn(5, 'the last request', `the final tail answer carries ${TAIL}`)
  folder.apply(events)
  return folder
}

const LATEST_WINDOW = { mode: 'latest', hasNewer: false } as const

test('the seeded markers are readable Main rows in every reading preset', () => {
  const folder = nativeFindFolder()
  for (const preset of ['full', 'compact', 'focus'] as const) {
    const nodes = flatten(folder.messages(), { preset, scopePrefix: 's1-', window: LATEST_WINDOW })
    const all = nodes.map(textOf).join('\n')
    assert.ok(all.includes(ARCHIVE), `${preset}: the old ARCHIVE row is materialized`)
    assert.ok(all.includes(TAIL), `${preset}: the tail TAIL row is materialized`)
    // SHARED lives in TWO different turns, so a client Find counting
    // occurrences must be able to reach two distinct rows.
    const sharedRows = nodes.filter(node => textOf(node).includes(SHARED))
    assert.ok(sharedRows.length >= 2, `${preset}: SHARED appears in two distinct rows`)
  }
})

test('the Folder corpus owns the Tool body text that a client may not index', () => {
  const folder = nativeFindFolder()
  // The SEMANTIC authority owns the text of a collapsed card body in every
  // preset: this is the fact T3-B builds on.
  for (const preset of ['full', 'compact', 'focus'] as const) {
    void preset
    const hits = folder.search(INNER_ONLY)
    assert.equal(hits.length, 1, `${preset}: TranscriptFolder.search owns the Tool body`)
    assert.equal(hits[0]?.turn, 3, 'the semantic hit keeps its real turn')
  }
  // Compact's default document is the bounded Activity head: the body is NOT
  // in the materialized document until the Work owner is expanded.
  const compactDefault = flatten(folder.messages(), { preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW })
  assert.ok(!compactDefault.map(textOf).join('\n').includes(INNER_ONLY),
    'compact: the collapsed Activity head keeps the Tool body out of the document')
  // The real-pane lane (round 5) drives Focus through the REAL Thought →
  // Work → Tool chain — three verified client toggles — and measured ONE
  // native Find hit once the body materializes; full and compact measure the
  // same after their own disclosure clicks. The mapper output differs per
  // preset in HOW the body is reachable, and that difference is what this
  // unit test owns: the client decides what its own Find document indexes;
  // this test never asserts a client hit count.
  // Per-preset DEFAULT materialization boundary in the real (assistant-completed)
  // turn shape: full keeps the tool row flat (its result node is in the
  // document), while compact wraps the turn in a collapsible Work root and
  // focus wraps it in a collapsible Thought root whose folded default keeps
  // the text OUT of the document until the user opens it.
  const fullDefault = flatten(folder.messages(), { preset: 'full', scopePrefix: 's1-', window: LATEST_WINDOW })
  assert.ok(fullDefault.some(node => node.kind === 'code' && textOf(node).includes(INNER_ONLY)),
    'full: the tool result node is materialized in the document')
  for (const preset of ['compact', 'focus'] as const) {
    const nodes = flatten(folder.messages(), {
      preset, scopePrefix: 's1-', window: LATEST_WINDOW, turnActivities: folder.turnActivities(),
    })
    assert.ok(!nodes.some(node => node.kind === 'code' && textOf(node).includes(INNER_ONLY)),
      `${preset}: the folded default document excludes the Tool body`)
    // The REAL disclosure chain the client toggles (the round-5 real-pane lane
    // drove exactly this): the FOCUS layer expands through its turn, the WORK
    // layer through its owner — the mapper must materialize the body once the
    // matching layer is expanded, without any search-only side door.
    const focusOpened = flatten(folder.messages(), {
      preset, scopePrefix: 's1-', window: LATEST_WINDOW, turnActivities: folder.turnActivities(),
      expandedFocusTurns: new Set([3]), expandedWorkOwners: new Set(folder.messages()),
    })
    assert.ok(focusOpened.map(textOf).join('\n').includes(INNER_ONLY),
      `${preset}: expanding the Thought and Work owners materializes the body`)
  }
})

test('opening the Compact Work owner materializes the Tool body without changing the Folder corpus', () => {
  const folder = nativeFindFolder()
  const before = folder.search(INNER_ONLY).length
  // Compact: the owner is the containing Work span; opening it must reveal the
  // same body through the SAME mapper (no second search-only expansion path).
  const openedCompact = flatten(folder.messages(), {
    preset: 'compact', scopePrefix: 's1-', window: LATEST_WINDOW,
    expandedWorkOwners: new Set(folder.messages()),
  })
  assert.ok(openedCompact.map(textOf).join('\n').includes(INNER_ONLY),
    'Compact materializes the body once the Work owner is expanded')
  assert.equal(folder.search(INNER_ONLY).length, before,
    'the semantic corpus is unchanged by a presentation disclosure decision')
})

test('the mapper never grows a Find index: its only text authority is the message rows', () => {
  const folder = nativeFindFolder()
  const nodes = flatten(folder.messages(), { preset: 'full', scopePrefix: 's1-', window: LATEST_WINDOW })
  // No node kind carries a search/match/cursor payload: the document is text,
  // and the client owns query state entirely.
  const forbidden = /find|search|match|query/i
  for (const node of nodes) {
    for (const key of Object.keys(node.props)) {
      assert.ok(!forbidden.test(key),
        `node ${node.id} (${node.kind}) must not carry a search-shaped prop: ${key}`)
    }
  }
})
