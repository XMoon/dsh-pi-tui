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
import type { StreamingToolPreview } from '../../src/app/surface/streaming-tool-preparing.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
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
        expandedCommandCompactionOwners: new Set(),
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
        expandedCommandCompactionOwners: new Set(),
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

test('the settled-answer stamp reads only the ask_user_question row', () => {
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'ask and run'),
    toolCall(2, 'call-bash', 'bash', { command: 'ls' }),
    toolResult(3, 'call-bash', 'file list'),
    toolCall(4, 'call-q', 'ask_user_question', { questions: [{ id: 'q1', question: 'Go on?', options: ['Yes'] }] }),
    toolResult(5, 'call-q', '{"answers":[]}'),
    assistantMessage(6, 'final-1', 'done'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7),
  ])
  const messages = folder.messages()
  const readCallIds: string[] = []
  const baseOptions = {
    preset: 'full',
    scopePrefix: 's1-',
    window: LATEST_WINDOW,
    settledQuestionAnswersRevision: 1,
    settledQuestionAnswersLookup: (callId: string) => {
      readCallIds.push(callId)
      return callId === 'call-q' ? [{ id: 'q1', selected: ['Yes'] }] : undefined
    },
  } as const
  const stampOf = (
    blocks: ReturnType<typeof describeTranscriptMainBlocksForPreset>,
    callId: string,
  ): readonly unknown[] | undefined =>
    blocks.find(descriptor => descriptor.owners.some(owner => owner.kind === 'tool' && owner.callId === callId))?.stamp

  const before = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), baseOptions)
  const bashStamp = stampOf(before, 'call-bash')
  const questionStamp = stampOf(before, 'call-q')
  assert.ok(bashStamp !== undefined, 'the ordinary tool row has a block')
  assert.ok(questionStamp !== undefined, 'the question row has a block')
  // The lookup was read for the QUESTION row only — never once for the
  // ordinary tool (the production lookup costs a settled-questions scan per
  // read, so a wide query would grow with every historical tool call).
  assert.deepEqual([...new Set(readCallIds)], ['call-q'])

  // A projection change re-derives the descriptors: the question row's stamp
  // moves (the revision is one of its display inputs)...
  const after = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), {
    ...baseOptions,
    settledQuestionAnswersRevision: 2,
  })
  const bashAfter = stampOf(after, 'call-bash')
  const questionAfter = stampOf(after, 'call-q')
  assert.ok(bashAfter !== undefined && questionAfter !== undefined)
  assert.notDeepEqual(questionAfter, questionStamp, 'the question row reads the settled-answer inputs')
  // ...while the ordinary tool row keeps its EXACT stamp: the journal must
  // materialize nothing for it.
  assert.deepEqual(bashAfter, bashStamp, 'the ordinary tool stamp is untouched by the projection change')
  assert.deepEqual([...new Set(readCallIds)], ['call-q'])
})

test('one Cluster member toggle changes only the owning Cluster descriptor stamp', () => {
  const contextEvent = (seq: number, id: string, text: string, plugin: string): SessionEvent => ev('user/message', {
    id: MessageId(id),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', form: 'snapshot', plugin },
  }, seq)
  const folder = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'inspect two context clusters'),
    contextEvent(2, 'cluster-1-a', 'first cluster member A', 'repo'),
    contextEvent(3, 'cluster-1-b', 'first cluster member B', 'build'),
    assistantMessage(4, 'final-1', 'the first answer', 1),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ev('turn/start', { turn: 2 }, 6),
    userMessage(7, 'user-2', 'inspect the second turn'),
    contextEvent(8, 'cluster-2-a', 'second cluster member A', 'repo'),
    contextEvent(9, 'cluster-2-b', 'second cluster member B', 'build'),
    assistantMessage(10, 'final-2', 'the second answer', 1),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 11),
  ])
  const messages = folder.messages()
  const clusters = projectTranscriptStructure(messages)
    .filter(block => block.kind === 'context-cluster')
    .map(block => block.cluster)
  assert.equal(clusters.length, 2)
  const baseOptions = {
    preset: 'full' as const,
    scopePrefix: 's1-',
    window: LATEST_WINDOW,
    innerDisclosure: {
      expandedThinkingOwners: new Set<TranscriptMessage>(),
      expandedContextRowOwners: new Set<TranscriptMessage>(),
      expandedClusterOwners: new Set(clusters.map(cluster => cluster.owner)),
      expandedCommandCompactionOwners: new Set<TranscriptMessage>(),
    },
  }
  const before = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), baseOptions)
  const after = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), {
    ...baseOptions,
    innerDisclosure: {
      ...baseOptions.innerDisclosure,
      expandedContextRowOwners: new Set([clusters[0]!.members[0]!]),
    },
  })
  assert.deepEqual(after.map(descriptor => descriptor.key), before.map(descriptor => descriptor.key),
    'one member toggle keeps every top-level descriptor identity and order')
  const changed = before.flatMap((descriptor, index) => {
    assert.ok(descriptor.key === after[index]!.key)
    return JSON.stringify(descriptor.stamp) === JSON.stringify(after[index]!.stamp) ? [] : [descriptor.key]
  })
  const clusterKey = before.find(descriptor => descriptor.owners.includes(clusters[0]!.owner))!.key
  assert.deepEqual(changed, [clusterKey],
    'only the descriptor that carries the toggled Cluster member is re-materialized')

  // The unrelated top-level rows keep their REAL SDK node ids and content; the
  // owning Cluster is the one subtree allowed to change.
  const beforeFlat = flattenMain(lazyMain(messages, new TranscriptNodeKeys(), baseOptions))
  const afterFlat = flattenMain(lazyMain(messages, new TranscriptNodeKeys(), {
    ...baseOptions,
    innerDisclosure: {
      ...baseOptions.innerDisclosure,
      expandedContextRowOwners: new Set([clusters[0]!.members[0]!]),
    } as never,
  }))
  const clusterId = beforeFlat.find(node => node.id === `main.${clusterKey}`)?.id
  assert.ok(clusterId !== undefined)
  const unaffected = (nodes: FlatNode[]): FlatNode[] => nodes.filter(node =>
    node.id !== clusterId && !node.id.startsWith(`${clusterId}.`))
  assert.deepEqual(unaffected(afterFlat), unaffected(beforeFlat),
    'unrelated User/Assistant/Cluster nodes and identities do not change')
})

test('one Command toggle changes only its own descriptor and the static key stays legal', () => {
  const commandRun = (seq: number, id: string, name: string): SessionEvent =>
    ev('command/run', { commandId: CommandId(id), name, source: { kind: 'user' } }, seq)
  const commandDone = (seq: number, id: string, text: string): SessionEvent =>
    ev('command/done', { commandId: CommandId(id), kind: 'success', text }, seq)
  const folderWith = (settled: boolean): TranscriptFolder => apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-1', 'show the command'),
    commandRun(2, 'cmd-1', 'status'),
    ...(settled ? [commandDone(3, 'cmd-1', 'all good\nmore detail')] : []),
    assistantMessage(settled ? 4 : 3, 'final-1', 'the answer', 1),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, settled ? 5 : 4),
  ])
  const settled = folderWith(true)
  const messages = settled.messages()
  const command = messages.find(message => message.kind === 'command')
  assert.ok(command !== undefined && command.kind === 'command')
  const baseOptions = {
    preset: 'full' as const,
    scopePrefix: 's1-',
    window: LATEST_WINDOW,
    innerDisclosure: {
      expandedThinkingOwners: new Set<TranscriptMessage>(),
      expandedContextRowOwners: new Set<TranscriptMessage>(),
      expandedClusterOwners: new Set<TranscriptMessage>(),
      expandedCommandCompactionOwners: new Set<TranscriptMessage>(),
    },
  }
  const before = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), baseOptions)
  const after = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), {
    ...baseOptions,
    innerDisclosure: { ...baseOptions.innerDisclosure, expandedCommandCompactionOwners: new Set([command]) },
  })
  assert.deepEqual(after.map(descriptor => descriptor.key), before.map(descriptor => descriptor.key),
    'opening one Command keeps every top-level descriptor identity and order')
  const changed = before.flatMap((descriptor, index) =>
    JSON.stringify(descriptor.stamp) === JSON.stringify(after[index]!.stamp) ? [] : [descriptor.key])
  const commandKey = before.find(descriptor => descriptor.owners.includes(command))!.key
  assert.deepEqual(changed, [commandKey], 'only the toggled Command is re-materialized')

  const beforeFlat = flattenMain(lazyMain(messages, new TranscriptNodeKeys(), baseOptions))
  const afterFlat = flattenMain(lazyMain(messages, new TranscriptNodeKeys(), {
    ...baseOptions,
    innerDisclosure: { ...baseOptions.innerDisclosure, expandedCommandCompactionOwners: new Set([command]) },
  }))
  const unaffected = (nodes: FlatNode[]): FlatNode[] => nodes.filter(node =>
    node.id !== `main.${commandKey}` && !node.id.startsWith(`main.${commandKey}.`))
  assert.deepEqual(unaffected(afterFlat), unaffected(beforeFlat),
    'the User and Assistant rows keep their exact ids and props')

  // The running card and the settled Section cannot share a Main key: the
  // journal cannot mutate a root kind in place, and the detail-less card is
  // the non-operable state. Both states keep the same ordinal position.
  const runningKeys = describeTranscriptMainBlocksForPreset(
    folderWith(false).messages(), new TranscriptNodeKeys(), baseOptions,
  ).map(descriptor => descriptor.key)
  const settledKeys = before.map(descriptor => descriptor.key)
  assert.equal(runningKeys.length, settledKeys.length)
  assert.deepEqual(runningKeys.filter(key => key !== settledKeys[runningKeys.indexOf(key)]), [`s1-msg-2-static`])
  assert.equal(settledKeys[runningKeys.indexOf('s1-msg-2-static')], 's1-msg-2')
})

// ── R13: the tool-path root is the CURRENT display-subject workspace ───────

/** The standalone mount root: the historical bug source. It must never be a
 *  display root once a workspace fact is committed, and an UNKNOWN root must
 *  keep the absolute path rather than inherit this value. */
const R13_LAUNCH_ROOT = '/r13/launch-A'
const R13_WORKSPACE_B = '/r13/workspace-B'
const R13_WORKSPACE_C = '/r13/workspace-C'
const R13_ABS_B = `${R13_WORKSPACE_B}/src/a.ts`

/** The canonical Work span owners of one projection (their disclosure keys). */
function r13WorkOwners(messages: readonly TranscriptMessage[]): TranscriptMessage[] {
  return projectTranscriptStructure(messages).flatMap(block => block.kind === 'work' ? [block.span.owner] : [])
}

/** Every materialized tool target, top-level rows and nested PTC children. */
function r13ToolTargets(
  messages: readonly TranscriptMessage[],
  preset: (typeof ALL_PRESETS)[number],
  cwd: string | undefined,
): string[] {
  const options: TranscriptPresetViewOptions = {
    preset,
    scopePrefix: 's1-',
    window: LATEST_WINDOW,
    expandedWorkOwners: new Set(r13WorkOwners(messages)),
    expandedFocusTurns: new Set([1]),
    ...(cwd === undefined ? {} : { cwd }),
  }
  return flattenMain(lazyMain(messages, new TranscriptNodeKeys(), options))
    .filter(node => node.kind === 'tool')
    .map(node => String(node.props['target']))
}

/** Every text value a materialized root carries, in document order. */
function r13TextsOf(root: Node): string[] {
  return flattenMain(root)
    .filter(node => node.kind === 'text')
    .map(node => String(node.props['text'] ?? ''))
}

/** The path text of a materialized Preparing row (` · <summary>`) or of a
 *  path-carrying `Action: Read <path>` line, with the known prefix removed. */
function r13PathTextOf(texts: readonly string[]): string | undefined {
  const carrying = texts.find(text => (text.includes('src/a.ts') || text.includes(R13_ABS_B))
    && (text.startsWith(' · ') || text.startsWith('Action: ')))
  if (carrying === undefined) return undefined
  return carrying.startsWith(' · ') ? carrying.slice(3) : carrying.slice('Action: Read '.length)
}

/** One real running tool with an absolute path and an open turn. */
function r13RunningFolder(): TranscriptFolder {
  return apply([
    ev('turn/start', { turn: 1 }, 0),
    ev('step/start', { turn: 1, step: 0 }, 1),
    userMessage(2, 'user-r13-live', 'watch the live tool'),
    toolCall(3, 'call-r13-live', 'read', { file_path: R13_ABS_B }),
  ])
}

const R13_PREVIEW: StreamingToolPreview = {
  callId: 'call-r13-stream',
  turn: 1,
  step: 0,
  index: 0,
  name: 'read',
  summary: R13_ABS_B,
  argumentBytes: 40,
}

test('R13 D1: the CURRENT workspace root relativizes an absolute tool path in every preset', () => {
  const messages = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-r13', 'read the current workspace file'),
    toolCall(2, 'call-r13-read', 'read', { file_path: R13_ABS_B }),
    toolResult(3, 'call-r13-read', 'the file body'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
  ]).messages()
  for (const preset of ALL_PRESETS) {
    // The positive control: under the committed workspace the REAL header
    // target really is the relative path (never merely "not A").
    const atB = r13ToolTargets(messages, preset, R13_WORKSPACE_B)
    assert.ok(atB.includes('src/a.ts'), `${preset}: workspace B relativizes its own absolute path`)
    assert.ok(!atB.includes(R13_ABS_B), `${preset}: the B path is not drawn twice`)
    // Another workspace must NOT abbreviate B's path, and neither does an
    // unknown root: the launch directory is not a fallback.
    for (const other of [R13_WORKSPACE_C, undefined]) {
      const label = other === undefined ? 'unknown' : other
      const targets = r13ToolTargets(messages, preset, other)
      assert.ok(targets.includes(R13_ABS_B), `${preset}: ${label} keeps B's absolute path`)
      assert.ok(!targets.includes('src/a.ts'), `${preset}: ${label} never abbreviates against B or A`)
    }
    const atLaunch = r13ToolTargets(messages, preset, R13_LAUNCH_ROOT)
    assert.ok(atLaunch.includes(R13_ABS_B), `${preset}: the launch directory cannot own B's path`)
    assert.ok(!atLaunch.includes('src/a.ts'), `${preset}: the launch directory is not a fallback root`)
  }
})

test('R13 D2: a cwd-only change invalidates the tool block stamp (and its PTC child) but not unrelated rows', () => {
  const messages = apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'user-r13-ptc', 'run the program'),
    ev('tool/call', {
      turn: 1, step: 0, callId: ToolCallId('code-r13'), name: 'run_code',
      arguments: JSON.stringify({ code: 'print(1)' }),
    }, 2),
    ev('tool/ptc-dispatch-start', {
      rootCallId: ToolCallId('code-r13'),
      parentCallId: ToolCallId('code-r13'),
      subCallId: ToolCallId('code-r13:code:1'),
      name: 'read',
      arguments: { file_path: R13_ABS_B },
    }, 3),
    toolResult(4, 'code-r13', 'program output'),
    assistantMessage(5, 'final-r13', 'the final answer', 1),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
  ]).messages()
  const optionsAt = (cwd: string | undefined): TranscriptPresetViewOptions => ({
    preset: 'full',
    scopePrefix: 's1-',
    window: LATEST_WINDOW,
    ...(cwd === undefined ? {} : { cwd }),
  })
  const before = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), optionsAt(R13_WORKSPACE_B))
  const after = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), optionsAt(R13_WORKSPACE_C))
  assert.deepEqual(after.map(descriptor => descriptor.key), before.map(descriptor => descriptor.key),
    'a cwd-only change keeps every top-level key and its order')
  const blockOfToolCall = (
    blocks: ReturnType<typeof describeTranscriptMainBlocksForPreset>,
    callId: string,
  ) => blocks.find(descriptor => descriptor.owners.some(owner => owner.kind === 'tool' && owner.callId === callId))
  const rootBefore = blockOfToolCall(before, 'code-r13')
  const rootAfter = blockOfToolCall(after, 'code-r13')
  assert.ok(rootBefore !== undefined && rootAfter !== undefined)
  assert.notDeepEqual(rootAfter.stamp, rootBefore.stamp,
    'the parent tool block re-materializes for a new root (its child target derives from it)')
  const userBefore = before.find(descriptor => descriptor.owners.some(owner => owner.kind === 'user'))
  const userAfter = after.find(descriptor => descriptor.owners.some(owner => owner.kind === 'user'))
  assert.ok(userBefore !== undefined && userAfter !== undefined)
  assert.deepEqual(userAfter.stamp, userBefore.stamp, 'an unrelated User row keeps its exact stamp')
  assert.deepEqual(userAfter.key, userBefore.key, 'an unrelated User row keeps its key')
  // The nested PTC child really inherits the parent's root: B shows the
  // relative path, C/unknown keep the absolute source path.
  for (const preset of ALL_PRESETS) {
    const childTargets = (cwd: string | undefined): string[] => {
      const options: TranscriptPresetViewOptions = {
        preset,
        scopePrefix: 's1-',
        window: LATEST_WINDOW,
        expandedToolKeys: new Set(['msg-2', 'msg-2/sub-code-r13:code:1']),
        expandedWorkOwners: new Set(r13WorkOwners(messages)),
        expandedFocusTurns: new Set([1]),
        ...(cwd === undefined ? {} : { cwd }),
      }
      const nodes = flattenMain(lazyMain(messages, new TranscriptNodeKeys(), options))
      return nodes.filter(node => node.kind === 'tool' && node.id.includes('.sub-'))
        .map(node => String(node.props['target']))
    }
    assert.deepEqual(childTargets(R13_WORKSPACE_B), ['src/a.ts'], `${preset}: the nested child target uses B`)
    assert.deepEqual(childTargets(R13_WORKSPACE_C), [R13_ABS_B], `${preset}: the nested child target keeps B's path under C`)
    assert.deepEqual(childTargets(undefined), [R13_ABS_B], `${preset}: the nested child target keeps B's path when unknown`)
  }
})

test('R13 D3: Preparing rows and Compact/Focus Action heads follow the current root without a new tool event', () => {
  const folder = r13RunningFolder()
  const messages = folder.messages()
  const optionsAt = (preset: (typeof ALL_PRESETS)[number], cwd: string | undefined, extra: Partial<TranscriptPresetViewOptions> = {}): TranscriptPresetViewOptions => ({
    preset,
    scopePrefix: 's1-',
    window: LATEST_WINDOW,
    turnActivities: folder.turnActivities(),
    ...extra,
    ...(cwd === undefined ? {} : { cwd }),
  })
  // Full: the live standalone Preparing row is its own top-level descriptor.
  const fullPreparing = (cwd: string | undefined) =>
    describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), optionsAt('full', cwd, {
      preparingPreviews: [R13_PREVIEW],
    })).filter(descriptor => descriptor.key.includes('preparing-'))
  const fullB = fullPreparing(R13_WORKSPACE_B)
  const fullC = fullPreparing(R13_WORKSPACE_C)
  assert.equal(fullB.length, 1)
  assert.equal(fullC.length, 1)
  assert.equal(r13PathTextOf(r13TextsOf(fullB[0]!.materialize())), 'src/a.ts',
    'Full: the live Preparing summary uses the committed workspace root')
  assert.equal(r13PathTextOf(r13TextsOf(fullC[0]!.materialize())), R13_ABS_B,
    'Full: another root keeps the absolute Preparing summary')
  assert.notDeepEqual(fullC[0]!.stamp, fullB[0]!.stamp, 'Full: the Preparing stamp follows the root')

  // Compact collapsed: the Activity head carries the Action of the running tool.
  const compactBlocks = (cwd: string | undefined, extra: Partial<TranscriptPresetViewOptions> = {}) =>
    describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), optionsAt('compact', cwd, extra))
  const workOf = (blocks: ReturnType<typeof describeTranscriptMainBlocksForPreset>) => {
    const work = blocks.find(descriptor => descriptor.key.includes('work-'))
    assert.ok(work !== undefined, 'the running tool projects one Compact Activity section')
    return work
  }
  const compactB = workOf(compactBlocks(R13_WORKSPACE_B))
  const compactC = workOf(compactBlocks(R13_WORKSPACE_C))
  assert.equal(r13PathTextOf(r13TextsOf(compactB.materialize())), 'src/a.ts',
    'Compact collapsed: the Activity Action uses the committed workspace root')
  assert.equal(r13PathTextOf(r13TextsOf(compactC.materialize())), R13_ABS_B,
    'Compact collapsed: another root keeps the absolute Action')
  assert.notDeepEqual(compactC.stamp, compactB.stamp, 'Compact: the Activity stamp follows the root')

  // Compact expanded: the live Preparing child row.
  const expandedWork = new Set(r13WorkOwners(messages))
  const compactExpandedB = workOf(compactBlocks(R13_WORKSPACE_B, {
    expandedWorkOwners: expandedWork, preparingPreviews: [R13_PREVIEW],
  }))
  const compactExpandedC = workOf(compactBlocks(R13_WORKSPACE_C, {
    expandedWorkOwners: expandedWork, preparingPreviews: [R13_PREVIEW],
  }))
  assert.equal(r13PathTextOf(r13TextsOf(compactExpandedB.materialize())), 'src/a.ts',
    'Compact expanded: the Preparing child uses the committed workspace root')
  assert.equal(r13PathTextOf(r13TextsOf(compactExpandedC.materialize())), R13_ABS_B,
    'Compact expanded: another root keeps the absolute Preparing child')
  assert.notDeepEqual(compactExpandedC.stamp, compactExpandedB.stamp,
    'Compact expanded: the Activity stamp covers the Preparing child root')

  // Focus collapsed: the root head carries the Action of the running tool.
  const focusRootOf = (cwd: string | undefined, extra: Partial<TranscriptPresetViewOptions> = {}) => {
    const root = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), optionsAt('focus', cwd, extra))
      .find(descriptor => descriptor.key.includes('focus-'))
    assert.ok(root !== undefined, 'the running tool projects one Focus Activity root')
    return root
  }
  const focusB = focusRootOf(R13_WORKSPACE_B)
  const focusC = focusRootOf(R13_WORKSPACE_C)
  assert.equal(r13PathTextOf(r13TextsOf(focusB.materialize())), 'src/a.ts',
    'Focus collapsed: the root Action uses the committed workspace root')
  assert.equal(r13PathTextOf(r13TextsOf(focusC.materialize())), R13_ABS_B,
    'Focus collapsed: another root keeps the absolute Action')
  assert.notDeepEqual(focusC.stamp, focusB.stamp, 'Focus: the root stamp follows the root')

  // Focus expanded: the nested Work's Preparing row.
  const focusExpandedOptions = {
    expandedFocusTurns: new Set([1]),
    expandedWorkOwners: expandedWork,
    preparingPreviews: [R13_PREVIEW],
  }
  const focusExpandedB = focusRootOf(R13_WORKSPACE_B, focusExpandedOptions)
  const focusExpandedC = focusRootOf(R13_WORKSPACE_C, focusExpandedOptions)
  assert.equal(r13PathTextOf(r13TextsOf(focusExpandedB.materialize())), 'src/a.ts',
    'Focus expanded: the nested Preparing row uses the committed workspace root')
  assert.equal(r13PathTextOf(r13TextsOf(focusExpandedC.materialize())), R13_ABS_B,
    'Focus expanded: another root keeps the absolute nested Preparing row')
  assert.notDeepEqual(focusExpandedC.stamp, focusExpandedB.stamp,
    'Focus expanded: the root stamp covers the nested Preparing row root')

  // A preview without a usable summary never invents a path.
  const withoutSummary = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), optionsAt('full', R13_WORKSPACE_B, {
    preparingPreviews: [{ ...R13_PREVIEW, summary: undefined }],
  })).filter(descriptor => descriptor.key.includes('preparing-'))
  const invented = r13TextsOf(withoutSummary[0]!.materialize()).join('\n')
  assert.ok(!invented.includes('src/a.ts') && !invented.includes(R13_ABS_B),
    'a summary-less Preparing row states no path at all')
  assert.ok(invented.includes('Preparing Read'), 'the summary-less row keeps its honest identity')
})

test('R13 D4: an unchanged workspace root never churns descriptor stamps', () => {
  const messages = twoWorkFolder().messages()
  for (const preset of ALL_PRESETS) {
    const options: TranscriptPresetViewOptions = {
      preset,
      scopePrefix: 's1-',
      window: LATEST_WINDOW,
      cwd: R13_WORKSPACE_B,
    }
    const first = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), options)
    const second = describeTranscriptMainBlocksForPreset(messages, new TranscriptNodeKeys(), options)
    assert.deepEqual(second.map(descriptor => descriptor.key), first.map(descriptor => descriptor.key))
    assert.deepEqual(second.map(descriptor => descriptor.stamp), first.map(descriptor => descriptor.stamp),
      `${preset}: an unchanged root re-derives byte-identical stamps`)
  }
})
