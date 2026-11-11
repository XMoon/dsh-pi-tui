/**
 * TSP PR2 lazy Main-block equivalence.
 *
 * The chain under test is the PRODUCTION mapper: genuine `SessionEvent`s
 * through the real `TranscriptFolder`, the canonical
 * `projectTranscriptStructure`/`projectCompact`/`projectFocus` authorities, and
 * the real SDK `View.from` id derivation. The lazy per-block entry
 * (`describeTranscriptMainBlocksForPreset`) must produce EXACTLY the tree the
 * historical full-view entry (`transcriptViewForPreset`) produces: same keys,
 * same order, same kinds, same props and same children.
 *
 * Evidence level: pure projection + official SDK node identity on a scripted
 * (non-Tern) shape.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-incremental-block-descriptors.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ui, View, type JsonObject, type Node, type Tree } from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TurnActivity } from '../../src/domain/transcript/types.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import {
  TranscriptNodeKeys,
  describeTranscriptMainBlocksForPreset,
  transcriptViewForPreset,
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
}

/** Every node of one `main` region with its REAL SDK-derived id, parents first. */
function flattenMain(root: Node): FlatNode[] {
  const view = View.from({ main: root })
  const out: FlatNode[] = []
  const visit = (tree: Tree): void => {
    out.push({ id: tree.id, kind: tree.kind, props: tree.props })
    for (const child of tree.children) visit(child)
  }
  const region = view.regions[0]
  assert.ok(region !== undefined, 'the main region exists')
  visit(region)
  return out
}

const lazyMain = (
  messages: readonly TranscriptMessage[],
  keys: TranscriptNodeKeys,
  options: TranscriptPresetViewOptions,
): Node => ui.col(
  { key: 'transcript', gap: 'none' },
  ...describeTranscriptMainBlocksForPreset(messages, keys, options).map(block => block.materialize()),
)

/** Proves the lazy entry and the full-view oracle are the SAME tree. */
function assertLazyEqualsFull(
  messages: readonly TranscriptMessage[],
  options: TranscriptPresetViewOptions,
): void {
  const full = flattenMain(transcriptViewForPreset(messages, new TranscriptNodeKeys(), options))
  const lazyKeys = new TranscriptNodeKeys()
  const lazy = flattenMain(lazyMain(messages, lazyKeys, options))
  assert.deepEqual(lazy, full, `lazy blocks must equal the full view for preset ${options.preset}`)
  // The descriptor keys are the REAL top-level child keys of that same root.
  const descriptors = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), options)
  const topLevel = full.filter(node => node.id.startsWith('main.') && !node.id.slice(5).includes('.'))
  assert.deepEqual(
    descriptors.map(descriptor => `main.${descriptor.key}`),
    topLevel.map(node => node.id),
    'every descriptor key is exactly one top-level Main child id, in order',
  )
  assert.equal(new Set(descriptors.map(descriptor => descriptor.key)).size, descriptors.length, 'block keys are unique')
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

const LATEST_WINDOW = { mode: 'latest', hasNewer: false } as const

const ALL_PRESETS = ['full', 'compact', 'focus'] as const

test('lazy Main blocks equal the full view for every preset on the canonical two-Work turn', () => {
  const messages = twoWorkFolder().messages()
  for (const preset of ALL_PRESETS) {
    assertLazyEqualsFull(messages, { preset, scopePrefix: 's1-', window: LATEST_WINDOW })
  }
})

test('lazy Main blocks equal the full view with manual Work and Focus disclosure open', () => {
  const folder = twoWorkFolder()
  const messages = folder.messages()
  const workOwners = messages.filter(message => message.kind === 'thinking')
  const expandedWorkOwners = new Set(workOwners.map(message => message))
  assert.equal(expandedWorkOwners.size, 2)
  for (const preset of ALL_PRESETS) {
    assertLazyEqualsFull(messages, {
      preset,
      scopePrefix: 's1-',
      window: LATEST_WINDOW,
      expandedWorkOwners,
      expandedFocusTurns: new Set([1]),
    })
  }
})

test('lazy Main blocks equal the full view for Snapshot Context carried into a Work span', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'carry the snapshot'),
    ev('user/message', {
      id: MessageId('snap-1'),
      role: 'user',
      content: [{ type: 'text', text: 'first hidden context' }],
      source: { kind: 'agent-instructions', form: 'instructions', changes: [{ path: '/tmp/a.md' }] },
    }, 2),
    ev('user/message', {
      id: MessageId('snap-2'),
      role: 'user',
      content: [{ type: 'text', text: 'second hidden context' }],
      source: { kind: 'agent-instructions', form: 'instructions', changes: [{ path: '/tmp/b.md' }] },
    }, 3),
    toolCall(4, 'call-read', 'read', { file_path: 'src/a.ts' }, 0),
    toolResult(5, 'call-read', 'the file body', 0),
    assistantMessage(6, 'final-1', 'done', 1),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7),
  ])
  const messages = folder.messages()
  for (const preset of ALL_PRESETS) {
    assertLazyEqualsFull(messages, { preset, scopePrefix: 's1-', window: LATEST_WINDOW })
    assertLazyEqualsFull(messages, {
      preset,
      scopePrefix: 's1-',
      window: LATEST_WINDOW,
      innerDisclosure: {
        expandedThinkingOwners: new Set(),
        expandedContextRowOwners: new Set(),
        expandedClusterOwners: new Set(messages.filter(message => message.kind === 'system').map(message => message)),
      },
    })
  }
})

test('lazy Main blocks equal the full view across a Command-split Focus occurrence', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'run a command inside the turn'),
    reasoningMessage(2, 'think-a', 'thinking before the command', undefined, 0),
    ev('command/run', { commandId: CommandId('cmd-1'), name: 'status', source: { kind: 'user' } }, 3),
    ev('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'session healthy' }, 4),
    toolCall(5, 'call-read', 'read', { file_path: 'src/a.ts' }, 0),
    toolResult(6, 'call-read', 'the file body', 0),
    assistantMessage(7, 'final-1', 'the final answer', 1),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 8),
  ])
  const messages = folder.messages()
  for (const preset of ALL_PRESETS) {
    assertLazyEqualsFull(messages, { preset, scopePrefix: 's1-', window: LATEST_WINDOW })
    assertLazyEqualsFull(messages, { preset, scopePrefix: 's1-', window: LATEST_WINDOW, expandedFocusTurns: new Set([1]) })
  }
})

test('lazy Main blocks equal the full view for a nested PTC child and its own disclosure owner', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'run the program'),
    ev('tool/call', { turn: 1, step: 0, callId: ToolCallId('code-1'), name: 'run_code', arguments: JSON.stringify({ code: 'print(1)' }) }, 2),
    ev('tool/ptc-dispatch-start', {
      rootCallId: ToolCallId('code-1'),
      parentCallId: ToolCallId('code-1'),
      subCallId: ToolCallId('code-1:code:1'),
      name: 'read',
      arguments: { file_path: 'src/a.ts' },
    }, 3),
    toolResult(4, 'code-1', 'program output'),
    assistantMessage(5, 'final-1', 'the final answer', 1),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
  ])
  const messages = folder.messages()
  for (const preset of ALL_PRESETS) {
    assertLazyEqualsFull(messages, { preset, scopePrefix: 's1-', window: LATEST_WINDOW })
    // A parent disclosure plus the child's own path: both must be read by the
    // SAME block stamp, or a lazy block would keep a stale collapsed child.
    assertLazyEqualsFull(messages, {
      preset,
      scopePrefix: 's1-',
      window: LATEST_WINDOW,
      innerDisclosure: {
        expandedThinkingOwners: new Set(),
        expandedContextRowOwners: new Set(),
        expandedClusterOwners: new Set(),
      },
      expandedToolKeys: new Set(['msg-3', 'msg-3/sub-code-1:code:1']),
      expandedWorkOwners: new Set(messages.filter(message => message.kind === 'thinking')),
      expandedFocusTurns: new Set([1]),
    })
  }
})

test('lazy Main blocks equal the full view with CJK bodies and a settled image-bearing User row', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    ev('user/message', {
      id: MessageId('user-image'),
      role: 'user',
      content: [
        { type: 'text', text: '看这张图' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'att-1', mediaType: 'image/png', bytes: 2048, width: 8, height: 8,
            name: 'shot.png', source: { kind: 'inline' },
          },
        },
      ],
      source: { kind: 'user' },
    }, 1),
    ev('assistant/message', {
      turn: 1, step: 0,
      message: { id: MessageId('a-1'), role: 'assistant', content: [{ type: 'text', text: '收到，正在处理中文正文与 emoji 🚀' }], source: { kind: 'model', provider: 'p', model: 'm' }, stream: [] },
    }, 2),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ])
  const messages = folder.messages()
  const imageStates = new Map<string, { readonly state: 'loading' }>([['att-1', { state: 'loading' }]])
  for (const preset of ALL_PRESETS) {
    assertLazyEqualsFull(messages, { preset, scopePrefix: 's1-', window: LATEST_WINDOW, imageStates })
  }
})

test('an EARLIER proven Preparing start changes the Work block stamp', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    ev('step/start', { turn: 1, step: 0 }, 1),
    userMessage(2, 'user-1', 'run it'),
    // The durable call materializes the card at its own settlement time...
    ev('tool/call', { turn: 1, step: 0, callId: ToolCallId('call-timing'), name: 'bash', arguments: JSON.stringify({ command: 'ls' }) }, 3),
  ])
  const options = {
    preset: 'compact',
    scopePrefix: 's1-',
    window: LATEST_WINDOW,
    turnActivities: folder.turnActivities(),
  } as const
  const before = describeTranscriptMainBlocksForPreset(folder.messages(), new TranscriptNodeKeys(), options)
  const workBefore = before.find(descriptor => descriptor.key.includes('work-'))
  assert.ok(workBefore !== undefined, 'the running tool row projects one Activity section')

  // ...and the attempt's embedded stream proves an EARLIER start for the SAME
  // call, so the Activity lifetime (its duration input) really moves.
  folder.apply([ev('assistant/attempt', {
    turn: 1,
    step: 0,
    stream: [
      { type: 'chunk', time: T0 + 50, chunk: { type: 'block-start', index: 0, blockType: 'tool-call' } },
      { type: 'chunk', time: T0 + 100, chunk: { type: 'tool-call-delta', index: 0, id: 'call-timing', name: 'bash', argumentsDelta: '{}' } },
    ],
  }, 4)])
  const after = describeTranscriptMainBlocksForPreset(folder.messages(), new TranscriptNodeKeys(), options)
  const workAfter = after.find(descriptor => descriptor.key === workBefore.key)
  assert.ok(workAfter !== undefined)
  // Without the owning card's display stamp this comparison is equal and the
  // journal would keep painting the stale Activity header.
  assert.notDeepEqual(workAfter.stamp, workBefore.stamp, 'the earlier start changes the Work block stamp')
})
