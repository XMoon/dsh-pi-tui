/**
 * TSP-native transcript detail disclosure over the canonical Folder and SDK View.
 *
 * Evidence level: real TranscriptFolder output plus official SDK node identities;
 * client layout and input reachability are covered by the real-pane qualification.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { View, type JsonObject, type Tree } from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TranscriptMessage, TranscriptToolMessage } from '../../src/domain/transcript/types.ts'
import { projectTranscriptStructure } from '../../src/tui/transcript/structure.ts'
import {
  TranscriptNodeKeys,
  transcriptView,
  transcriptViewForPreset,
  visibleTranscriptMembers,
} from '../../src/tui/tsp/transcript-view.ts'

const T0 = 1_700_000_000_000
const WINDOW = { mode: 'latest', hasNewer: false } as const

function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq * 1000, data } as SessionEvent
}

function user(seq: number, text: string, id = `user-${seq}`): SessionEvent {
  return ev('user/message', {
    id: MessageId(id), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' },
  }, seq)
}

function context(seq: number, id: string, text: string, source: Record<string, unknown>): SessionEvent {
  return ev('user/message', {
    id: MessageId(id), role: 'user', content: [{ type: 'text', text }], source,
  }, seq)
}

function thinking(seq: number, step: number, text: string): SessionEvent {
  return ev('assistant/message', {
    turn: 1,
    step,
    message: {
      id: MessageId(`assistant-${step}`), role: 'assistant', content: [{ type: 'reasoning', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
      stream: [
        { type: 'chunk', time: T0 + seq * 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
        { type: 'chunk', time: T0 + seq * 1000 + 1, chunk: { type: 'reasoning-delta', index: 0, text } },
        { type: 'chunk', time: T0 + seq * 1000 + 2, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text } } },
      ],
    },
  }, seq)
}

function toolCall(seq: number, callId: string, name: string, args: string, step = 0): SessionEvent {
  return ev('tool/call', { turn: 1, step, callId: ToolCallId(callId), name, arguments: args }, seq)
}

function toolResult(seq: number, callId: string, text: string, step = 0, isError = false): SessionEvent {
  return ev('tool/result', {
    turn: 1,
    step,
    message: {
      id: MessageId(`result-${callId}`), role: 'tool', toolCallId: ToolCallId(callId),
      content: text === '' ? [] : [{ type: 'text', text }],
      ...(isError ? { isError: true, error: { name: 'ReadError', code: 'ENOENT' } } : {}),
      source: { kind: 'tool', callId },
    },
  }, seq)
}

function assistant(seq: number, step: number, text: string): SessionEvent {
  return ev('assistant/message', {
    turn: 1, step,
    message: {
      id: MessageId(`final-${step}`), role: 'assistant', content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' }, stream: [],
    },
  }, seq)
}

function folder(events: readonly SessionEvent[]): TranscriptFolder {
  const result = new TranscriptFolder()
  result.apply(events)
  return result
}

function workFolder(options: { readonly toolError?: boolean; readonly toolErrorText?: string } = {}): TranscriptFolder {
  const result = options.toolErrorText ?? (options.toolError === true ? 'ENOENT: no such file or directory' : 'file contents')
  return folder([
    ev('turn/start', { turn: 1 }, 0),
    user(1, 'inspect the repository'),
    thinking(2, 0, 'checking the file\nlatest reasoning line'),
    toolCall(3, 'read-1', 'read', '{"file_path":"src/example.ts"}'),
    toolResult(4, 'read-1', result, 0, options.toolError === true || options.toolErrorText !== undefined),
    context(5, 'snapshot-1', 'first injected payload', { kind: 'plugin', form: 'snapshot', plugin: 'repo' }),
    context(6, 'snapshot-2', 'second injected payload', { kind: 'plugin', form: 'snapshot', plugin: 'build' }),
    assistant(7, 1, 'final answer'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 8),
  ])
}

function flatten(
  messages: readonly TranscriptMessage[],
  preset: 'full' | 'compact' | 'focus',
  keys = new TranscriptNodeKeys(),
  options: Record<string, unknown> = {},
): Tree[] {
  const innerDisclosure = {
    expandedThinkingOwners: options['expandedThinkingOwners'] as ReadonlySet<TranscriptMessage> | undefined ?? new Set<TranscriptMessage>(),
    expandedContextRowOwners: options['expandedContextRowOwners'] as ReadonlySet<TranscriptMessage> | undefined ?? new Set<TranscriptMessage>(),
    expandedClusterOwners: options['expandedClusterOwners'] as ReadonlySet<TranscriptMessage> | undefined ?? new Set<TranscriptMessage>(),
    expandedCommandCompactionOwners: options['expandedCommandCompactionOwners'] as ReadonlySet<TranscriptMessage> | undefined ?? new Set<TranscriptMessage>(),
  }
  const view = View.from({ main: transcriptViewForPreset(messages, keys, {
    preset, scopePrefix: 's1-', window: WINDOW, expandedToolKeys: new Set<string>(), innerDisclosure, ...options,
  } as never) })
  const out: Tree[] = []
  const visit = (node: Tree): void => {
    out.push(node)
    for (const child of node.children) visit(child)
  }
  const root = view.regions[0]
  assert.ok(root !== undefined)
  visit(root)
  return out
}

function nodeText(node: Tree): string {
  const parts: string[] = []
  const visit = (current: Tree): void => {
    const text = current.props['text']
    const head = current.props['head']
    if (typeof text === 'string') parts.push(text)
    if (typeof head === 'string') parts.push(head)
    for (const child of current.children) visit(child)
  }
  visit(node)
  return parts.join(' ')
}

function rowOf<T extends TranscriptMessage>(messages: readonly TranscriptMessage[], predicate: (row: TranscriptMessage) => row is T): T {
  const row = messages.find(predicate)
  assert.ok(row !== undefined)
  return row
}

function toolRows(messages: readonly TranscriptMessage[]): TranscriptToolMessage[] {
  return messages.filter((row): row is TranscriptToolMessage => row.kind === 'tool')
}

test('Full stays flat while Compact and Focus preserve one canonical owner per Work and Context cluster', () => {
  const messages = workFolder().messages()
  const structure = projectTranscriptStructure(messages)
  const works = structure.filter((block): block is Extract<typeof block, { kind: 'work' }> => block.kind === 'work')
  assert.equal(works.length, 1)
  const work = works[0]!
  const clusters = structure.flatMap(block => block.kind === 'work'
    ? block.span.parts.flatMap(part => part.kind === 'context-cluster' ? [part.cluster] : [])
    : block.kind === 'context-cluster' ? [block.cluster] : [])
  const cluster = clusters[0]
  assert.ok(cluster !== undefined)

  const full = flatten(messages, 'full')
  assert.equal(full.filter(node => node.kind === 'section' && String(node.props['key']).includes('work-')).length, 0,
    'Full does not add Work chrome')
  assert.equal(full.filter(node => node.kind === 'section' && String(node.props['key']).includes('ctx-')).length, 1,
    'Full keeps one native disclosure for the canonical cluster')
  assert.ok(full.some(node => node.kind === 'tool' && node.props['name'] === 'read'), 'Full keeps the Tool row visible')

  const compact = flatten(messages, 'compact')
  assert.equal(compact.filter(node => node.kind === 'section' && String(node.props['key']).includes('work-')).length, 1,
    'Compact keeps one Activity per canonical Work')
  assert.equal(compact.filter(node => node.kind === 'section' && String(node.props['key']).includes('ctx-')).length, 0,
    'a cluster under a collapsed Work is not materialized')

  const compactOpen = flatten(messages, 'compact', new TranscriptNodeKeys(), {
    expandedWorkOwners: new Set([work.span.owner]),
    expandedClusterOwners: new Set([cluster.owner]),
  })
  const clusterNodes = compactOpen.filter(node => node.kind === 'section' && String(node.props['key']).includes('ctx-'))
  assert.equal(clusterNodes.length, 1, 'Compact emits one cluster at its canonical Work position')
  assert.equal(clusterNodes[0]!.props['collapsed'], false)
  const memberHeads = compactOpen.filter(node => node.kind === 'section'
    && (node.props['head'] === 'repo · ambient' || node.props['head'] === 'build · ambient'))
  assert.equal(memberHeads.length, 2, 'the open canonical Cluster presents each eligible member as its own Section')
  assert.ok(memberHeads.every(node => node.props['collapsible'] === true && node.props['collapsed'] === true),
    'each member starts independently collapsed')
  assert.equal(compactOpen.filter(node => node.props['text'] === 'first injected payload').length, 0)
  assert.equal(compactOpen.filter(node => node.props['text'] === 'second injected payload').length, 0,
    'opening the canonical Cluster alone materializes no member body')

  const focusClosed = flatten(messages, 'focus', new TranscriptNodeKeys(), {
    turnActivities: workFolder().turnActivities(),
  })
  const focusRoots = focusClosed.filter(node => node.kind === 'section' && String(node.props['key']).includes('focus-'))
  assert.equal(focusRoots.length, 1, `Focus has one top-level Thought root: ${JSON.stringify(focusClosed.filter(node => node.kind === 'section').map(node => node.props['key']))}`)
  assert.equal(focusClosed.filter(node => node.kind === 'tool').length, 0,
    'a closed Thought does not materialize Work tools')
  const focusOpen = flatten(messages, 'focus', new TranscriptNodeKeys(), {
    turnActivities: workFolder().turnActivities(), expandedFocusTurns: new Set([1]),
  })
  assert.equal(focusOpen.filter(node => node.kind === 'section' && String(node.props['key']).includes('focus-')).length, 1)
  assert.equal(focusOpen.filter(node => node.kind === 'section' && String(node.props['key']).includes('work-')).length, 1)
})


test('Cluster members keep one independent native disclosure owner in Full, Compact and Focus', () => {
  const messages = workFolder().messages()
  const systemRows = messages.filter((row): row is Extract<TranscriptMessage, { kind: 'system' }> => row.kind === 'system')
  const [memberA, memberB] = systemRows
  assert.ok(memberA !== undefined && memberB !== undefined)
  const structure = projectTranscriptStructure(messages)
  const work = structure.find(block => block.kind === 'work')
  assert.ok(work?.kind === 'work')
  const cluster = structure.flatMap(block => block.kind === 'work'
    ? block.span.parts.flatMap(part => part.kind === 'context-cluster' ? [part.cluster] : [])
    : block.kind === 'context-cluster' ? [block.cluster] : [])[0]
  assert.ok(cluster !== undefined)
  const presets = ['full', 'compact', 'focus'] as const
  const expandedContextRowOwners = new Set<TranscriptMessage>()
  for (const preset of presets) {
    const options = {
      turnActivities: workFolder().turnActivities(),
      expandedWorkOwners: new Set([work.span.owner]),
      expandedFocusTurns: new Set([1]),
      expandedClusterOwners: new Set([cluster.owner]),
      expandedContextRowOwners,
    }
    const countText = (nodes: Tree[], text: string): number => nodes.filter(node => node.props['text'] === text).length
    const memberSections = (nodes: Tree[]): Tree[] => nodes.filter(node => node.kind === 'section'
      && (node.props['head'] === 'repo · ambient' || node.props['head'] === 'build · ambient'))

    const closed = flatten(messages, preset, new TranscriptNodeKeys(), options)
    const closedMembers = memberSections(closed)
    assert.equal(closedMembers.length, 2, `${preset}: both member headers exist inside the open Cluster`)
    assert.ok(closedMembers.every(node => node.props['collapsible'] === true && node.props['collapsed'] === true),
      `${preset}: each member starts collapsed`)
    assert.equal(countText(closed, 'first injected payload'), 0)
    assert.equal(countText(closed, 'second injected payload'), 0)

    expandedContextRowOwners.add(memberA)
    const aOpen = flatten(messages, preset, new TranscriptNodeKeys(), options)
    assert.equal(countText(aOpen, 'first injected payload'), 1, `${preset}: opening member A materializes only A`)
    assert.equal(countText(aOpen, 'second injected payload'), 0, `${preset}: member B stays closed`)
    assert.equal(memberSections(aOpen).length, 2)
    const openedA = memberSections(aOpen).find(node => node.props['head'] === 'repo · ambient')
    assert.equal(openedA?.props['collapsed'], false)
    assert.equal(memberSections(aOpen).find(node => node.props['head'] === 'build · ambient')?.props['collapsed'], true)

    expandedContextRowOwners.add(memberB)
    const bothOpen = flatten(messages, preset, new TranscriptNodeKeys(), options)
    assert.equal(countText(bothOpen, 'first injected payload'), 1)
    assert.equal(countText(bothOpen, 'second injected payload'), 1, `${preset}: member B opens independently`)

    // Closing the canonical Cluster removes the member nodes but never rewrites
    // the members' own manual disclosure owners.
    const clusterClosed = flatten(messages, preset, new TranscriptNodeKeys(), {
      ...options, expandedClusterOwners: new Set<TranscriptMessage>(),
    })
    assert.equal(memberSections(clusterClosed).length, 0, `${preset}: a closed Cluster materializes no member nodes`)
    assert.equal(countText(clusterClosed, 'first injected payload'), 0)
    assert.equal(countText(clusterClosed, 'second injected payload'), 0)
    assert.deepEqual([...expandedContextRowOwners], [memberA, memberB],
      `${preset}: closing the Cluster preserves both member owners`)

    const reopened = flatten(messages, preset, new TranscriptNodeKeys(), options)
    const reopenedMembers = memberSections(reopened)
    assert.equal(reopenedMembers.length, 2)
    assert.ok(reopenedMembers.every(node => node.props['collapsed'] === false),
      `${preset}: reopening the Cluster restores each member's own state`)
    assert.equal(countText(reopened, 'first injected payload'), 1)
    assert.equal(countText(reopened, 'second injected payload'), 1)
    expandedContextRowOwners.clear()
  }
})

test('same-label members of different canonical Clusters never share disclosure or node identity', () => {
  const events: SessionEvent[] = []
  for (const turn of [1, 2]) {
    const base = (turn - 1) * 10
    events.push(ev('turn/start', { turn }, base))
    events.push(user(base + 1, `turn-${turn}-user`, `turn-${turn}-user`))
    events.push(context(base + 2, `same-label-${turn}-a`, `cluster ${turn} body A`, { kind: 'plugin', form: 'snapshot', plugin: 'same-label' }))
    events.push(context(base + 3, `same-label-${turn}-b`, `cluster ${turn} body B`, { kind: 'plugin', form: 'snapshot', plugin: 'same-label' }))
    events.push(ev('turn/end', { turn, reason: { kind: 'completed' } }, base + 4))
  }
  const messages = folder(events).messages()
  const systemRows = messages.filter((row): row is Extract<TranscriptMessage, { kind: 'system' }> => row.kind === 'system')
  assert.equal(systemRows.length, 4)
  const structure = projectTranscriptStructure(messages)
  const clusters = structure.filter(block => block.kind === 'context-cluster').map(block => block.cluster)
  assert.equal(clusters.length, 2)
  const keys = new TranscriptNodeKeys()
  const nodes = flatten(messages, 'full', keys, {
    expandedClusterOwners: new Set(clusters.map(cluster => cluster.owner)),
    expandedContextRowOwners: new Set([systemRows[0]!]),
  })
  const memberSections = nodes.filter(node => node.kind === 'section' && node.props['head'] === 'same-label · ambient')
  assert.equal(memberSections.length, 4, 'each Cluster materializes its own two same-label members')
  assert.equal(memberSections.filter(node => node.props['collapsed'] === false).length, 1,
    'only the exact opened message owner is expanded')
  assert.equal(nodes.filter(node => node.props['text'] === 'cluster 1 body A').length, 1)
  assert.equal(nodes.filter(node => node.props['text'] === 'cluster 1 body B').length, 0)
  assert.equal(nodes.filter(node => node.props['text'] === 'cluster 2 body A').length, 0)
  assert.equal(nodes.filter(node => node.props['text'] === 'cluster 2 body B').length, 0)
  assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length, 'member node ids stay unique across Clusters')
})


test('two Work, Thinking and Cluster occurrences keep distinct bounded structural owners', () => {
  const events: SessionEvent[] = [ev('turn/start', { turn: 1 }, 0)]
  for (let index = 0; index < 2; index += 1) {
    events.push(user(index * 10 + 1, `scale-user-${index}`, `scale-user-${index}`))
    events.push(thinking(index * 10 + 2, index, `scale-thinking-${index}`))
    events.push(toolCall(index * 10 + 3, `scale-tool-${index}`, 'read', '{}', index))
    events.push(toolResult(index * 10 + 4, `scale-tool-${index}`, `scale-result-${index}`, index))
    events.push(context(index * 10 + 5, `scale-context-${index}-a`, `scale-context-${index}-a`, { kind: 'plugin', form: 'snapshot', plugin: `scale-${index}` }))
    events.push(context(index * 10 + 6, `scale-context-${index}-b`, `scale-context-${index}-b`, { kind: 'plugin', form: 'snapshot', plugin: `scale-${index}` }))
    events.push(assistant(index * 10 + 7, index + 1, `scale-final-${index}`))
  }
  events.push(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 30))
  const source = folder(events)
  const messages = source.messages()
  const structure = projectTranscriptStructure(messages)
  const workOwners = structure.filter(block => block.kind === 'work').map(block => block.span.owner)
  const clusters = structure.flatMap(block => block.kind === 'work'
    ? block.span.parts.filter(part => part.kind === 'context-cluster').map(part => part.cluster.owner)
    : block.kind === 'context-cluster' ? [block.cluster.owner] : [])
  const thinkingOwners = messages.filter(row => row.kind === 'thinking')
  assert.equal(workOwners.length, 2)
  assert.equal(thinkingOwners.length, 2)
  assert.equal(clusters.length, 2)
  const keys = new TranscriptNodeKeys()
  const focus = flatten(messages, 'focus', keys, {
    turnActivities: source.turnActivities(),
    expandedFocusTurns: new Set([1]),
    expandedWorkOwners: new Set(workOwners),
    expandedThinkingOwners: new Set(thinkingOwners),
    expandedClusterOwners: new Set(clusters),
  })
  const ids = focus.map(node => node.id)
  assert.equal(new Set(ids).size, ids.length, 'the 2x Work/Thinking/Cluster view has no duplicate native ids')
  assert.equal(focus.filter(node => node.kind === 'section' && String(node.props['key']).includes('work-')).length, 2)
  assert.equal(focus.filter(node => node.kind === 'section' && String(node.props['key']).includes('ctx-')).length, 2)
  for (const owner of thinkingOwners) {
    const key = keys.keyFor(owner)
    assert.ok(focus.some(node => node.id.endsWith(`.${key}`) || node.id.endsWith(`-${key}`)),
      `the Thinking owner ${key} has a native occurrence in the Focus tree`)
  }
})

test('the structural source is scanned once for one and two Work/Thinking/Cluster occurrences', () => {
  const makeMessages = (count: number): readonly TranscriptMessage[] => {
    const events: SessionEvent[] = [ev('turn/start', { turn: 1 }, 0)]
    for (let index = 0; index < count; index += 1) {
      events.push(user(index * 10 + 1, `bound-user-${index}`, `bound-user-${index}`))
      events.push(thinking(index * 10 + 2, index, `bound-thinking-${index}`))
      events.push(toolCall(index * 10 + 3, `bound-tool-${index}`, 'read', '{}', index))
      events.push(toolResult(index * 10 + 4, `bound-tool-${index}`, `bound-result-${index}`, index))
      events.push(context(index * 10 + 5, `bound-context-${index}-a`, `bound-context-${index}-a`, { kind: 'plugin', form: 'snapshot', plugin: `bound-${index}` }))
      events.push(context(index * 10 + 6, `bound-context-${index}-b`, `bound-context-${index}-b`, { kind: 'plugin', form: 'snapshot', plugin: `bound-${index}` }))
      events.push(assistant(index * 10 + 7, index + 1, `bound-final-${index}`))
    }
    events.push(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, count * 10 + 9))
    return folder(events).messages()
  }
  const countIterableReads = (messages: readonly TranscriptMessage[], reads: { iterations: number; items: number; lengths: number }): readonly TranscriptMessage[] =>
    new Proxy(messages, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) reads.iterations += 1
        else if (property === 'length') reads.lengths += 1
        else if (typeof property === 'string' && /^(?:0|[1-9]\d*)$/u.test(property)) reads.items += 1
        return Reflect.get(target, property, receiver)
      },
    })
  const oneReads = { iterations: 0, items: 0, lengths: 0 }
  const twoReads = { iterations: 0, items: 0, lengths: 0 }
  const one = countIterableReads(makeMessages(1), oneReads)
  const two = countIterableReads(makeMessages(2), twoReads)
  assert.equal(projectTranscriptStructure(one).length > 0, true)
  assert.equal(projectTranscriptStructure(two).length > 0, true)
  assert.equal(oneReads.iterations, 2, 'one projection performs one Context-clustering pass and one structure pass')
  assert.equal(twoReads.iterations, oneReads.iterations, 'doubling Work/Thinking/Cluster owners does not add source passes')
  assert.ok(twoReads.items <= oneReads.items * 2 + 4,
    `indexed transcript source reads remain linear: one=${oneReads.items}, two=${twoReads.items}`)
  assert.ok(twoReads.lengths <= oneReads.lengths * 2 + 2,
    `source length reads remain linear: one=${oneReads.lengths}, two=${twoReads.lengths}`)
})

test('Thinking exposes only its bounded latest line until the stable native Section opens', () => {
  const messages = workFolder().messages()
  const thinkingRow = rowOf(messages, (row): row is Extract<TranscriptMessage, { kind: 'thinking' }> => row.kind === 'thinking')
  const keys = new TranscriptNodeKeys()
  const closed = flatten(messages, 'full', keys)
  const section = closed.find(node => node.kind === 'section' && node.props['head'] !== undefined)
  const think = closed.find(node => node.kind === 'section' && node.props['key'] === `s1-${keys.keyFor(thinkingRow)}`)
  assert.ok(think !== undefined, 'typed Thinking is a native Section')
  assert.equal(think.props['collapsible'], true)
  assert.equal(think.props['collapsed'], true)
  assert.ok(nodeText(think).includes('latest reasoning line'), 'the latest non-empty line is the collapsed summary')
  assert.ok(!nodeText(think).includes('checking the file'), 'older reasoning text is not in the head')
  assert.ok(!closed.some(node => node.id === `${think.id}.body`), 'the closed body is not materialized')
  assert.ok(section !== undefined)

  const open = flatten(messages, 'full', keys, { expandedThinkingOwners: new Set([thinkingRow]) })
  const reopened = open.find(node => node.id === think.id)
  assert.ok(reopened !== undefined)
  assert.equal(reopened.props['collapsed'], false)
  assert.ok(open.some(node => node.id === `${think.id}.body` && node.props['stream'] !== true),
    'the settled body is complete and no longer marked as streaming')
  assert.equal(reopened.id, think.id, 'the same source row keeps its SDK identity')

  const legacy = View.from({ main: transcriptView(projectTranscriptStructure(messages), new TranscriptNodeKeys()) })
  const legacySections = legacy.regions[0]?.children.filter(node => node.kind === 'section') ?? []
  assert.ok(legacySections.length > 0, 'legacy Work structure remains visible')
  assert.ok(legacySections.every(node => node.props['collapsible'] !== true),
    'the standalone mapper keeps every ownerless Section fail-open')
})

test('PTC error notes stay bounded while retaining long-output exit and signal reasons', () => {
  const longOutput = 'compiler output '.repeat(32)
  const cases = [
    { name: 'exit', isError: false, result: `${longOutput}\n[exit code: 2]`, marker: '[exit code: 2]', lifecycle: 'ok' },
    { name: 'signal', isError: false, result: `${longOutput}\n[killed by signal: SIGTERM]`, marker: '[killed by signal: SIGTERM]', lifecycle: 'ok' },
    { name: 'ordinary', isError: true, result: 'filesystem permission denied', marker: 'filesystem permission denied', lifecycle: 'error' },
  ] as const

  for (const scenario of cases) {
    const rootCallId = `root-${scenario.name}`
    const subCallId = `child-${scenario.name}`
    const args = { command: 'run deterministic failure', description: 'Exercise the PTC error note' }
    const messages = folder([
      ev('turn/start', { turn: 1 }, 0), user(1, 'run a shell child'),
      toolCall(2, rootCallId, 'run_code', '{}'),
      ev('tool/ptc-dispatch-start', {
        rootCallId: ToolCallId(rootCallId), parentCallId: ToolCallId(rootCallId), subCallId,
        name: 'bash', arguments: args,
      }, 3),
      toolResult(4, rootCallId, 'program complete'),
      ev('tool/ptc-dispatch', {
        rootCallId: ToolCallId(rootCallId), parentCallId: ToolCallId(rootCallId), subCallId,
        name: 'bash', arguments: args, isError: scenario.isError,
        content: [{ type: 'text', text: scenario.result }],
      }, 5),
      ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
    ]).messages()
    const parent = toolRows(messages)[0]!
    const child = parent.subCalls?.[0]
    assert.ok(child !== undefined)
    assert.equal(child.status, scenario.lifecycle, 'the durable PTC settlement remains unchanged')
    const keys = new TranscriptNodeKeys()
    const closed = flatten(messages, 'full', keys, { expandedToolKeys: new Set([keys.keyFor(parent)]) })
    const childNode = closed.find(node => node.kind === 'tool' && node.props['name'] === 'bash')
    assert.ok(childNode !== undefined)
    assert.equal(childNode.props['status'], 'error', `${scenario.name} is a failed display status`)
    assert.equal(childNode.props['collapsed'], true, 'the full child body remains independently collapsed')
    assert.equal(closed.some(node => node.id === `${childNode.id}.result`), false,
      'the full child output is not materialized in the collapsed card')
    const note = String(childNode.props['note'] ?? '')
    assert.ok(note.includes(scenario.marker), `${scenario.name} reason survives in the closed header: ${note}`)
    const noteLimit = scenario.name === 'ordinary' ? 180 : 96
    assert.ok(note.length <= noteLimit, `${scenario.name} header note fits its bounded client width: ${note.length}`)
    if (scenario.name === 'ordinary') {
      assert.equal(note, scenario.result, 'ordinary short failures retain their readable summary')
    } else {
      assert.equal(note, scenario.marker, 'the official terminal reason owns the compact note')
      assert.ok(note.length <= 48, `${scenario.name} terminal reason stays width-bounded: ${note.length}`)
    }
  }
})

test('ordinary Tools and PTC children hide detail until their own exact disclosure opens', () => {
  const messages = workFolder().messages()
  const row = toolRows(messages)[0]!
  const keys = new TranscriptNodeKeys()
  const closed = flatten(messages, 'full', keys)
  const tool = closed.find(node => node.kind === 'tool' && node.props['name'] === 'read')
  assert.ok(tool !== undefined)
  assert.equal(tool.props['collapsible'], true)
  assert.equal(tool.props['collapsed'], true)
  assert.ok(!nodeText(tool).includes('src/example.ts'), 'closed args are not materialized')
  assert.ok(!nodeText(tool).includes('file contents'), 'closed result is not materialized')

  const open = flatten(messages, 'full', keys, { expandedToolKeys: new Set([keys.keyFor(row)]) })
  const opened = open.find(node => node.id === tool.id)
  assert.ok(opened !== undefined)
  assert.equal(opened.props['collapsed'], false)
  assert.ok(nodeText(opened).includes('src/example.ts'))
  assert.ok(nodeText(opened).includes('file contents'))

  const ptc = folder([
    ev('turn/start', { turn: 1 }, 0), user(1, 'run nested calls'),
    toolCall(2, 'root-call', 'run_code', '{}'),
    ev('tool/ptc-dispatch-start', {
      rootCallId: ToolCallId('root-call'), parentCallId: ToolCallId('root-call'), subCallId: 'nested.child',
      name: 'read', arguments: '{"file_path":"nested.txt"}',
    }, 3),
    toolResult(4, 'root-call', 'program output'),
    ev('tool/ptc-dispatch', {
      rootCallId: ToolCallId('root-call'), parentCallId: ToolCallId('root-call'), subCallId: 'nested.child',
      name: 'read', arguments: '{"file_path":"nested.txt"}', isError: false, content: [{ type: 'text', text: 'child output' }],
    }, 5),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
  ]).messages()
  const parent = toolRows(ptc)[0]!
  const child = parent.subCalls?.[0]
  assert.ok(child !== undefined)
  const ptcKeys = new TranscriptNodeKeys()
  const ptcClosed = flatten(ptc, 'full', ptcKeys)
  const parentNode = ptcClosed.find(node => node.kind === 'tool' && node.props['name'] === 'run_code')
  assert.ok(parentNode !== undefined)
  assert.equal(ptcClosed.some(node => node.props['text'] === 'Child calls · 1'), false,
    'a closed parent has no child collection')
  const parentDisclosure = ptcKeys.keyFor(parent)
  const parentOpen = flatten(ptc, 'full', ptcKeys, { expandedToolKeys: new Set([parentDisclosure]) })
  const childNode = parentOpen.find(node => node.kind === 'tool' && node.props['name'] === 'read')
  assert.ok(childNode !== undefined)
  assert.equal(childNode.props['collapsible'], true)
  assert.equal(childNode.props['collapsed'], true)
  assert.ok(!nodeText(childNode).includes('nested.txt'), 'the independently closed child does not materialize its args')
  const childDisclosure = `${parentDisclosure}/sub-nested.child`
  const childOpen = flatten(ptc, 'full', ptcKeys, { expandedToolKeys: new Set([parentDisclosure, childDisclosure]) })
  assert.ok(childOpen.some(node => node.id === childNode.id && node.props['collapsed'] === false))
  assert.ok(nodeText(childOpen.find(node => node.id === childNode.id)!).includes('child output'))
})

test('Context row forms retain their own summary, identity and fail-open disposition', () => {
  const messages = folder([
    ev('turn/start', { turn: 1 }, 0), user(1, 'read context'),
    context(2, 'notice-with-summary', 'notice payload detail', { kind: 'subagent-settled', form: 'notice', summary: 'Agent completed', label: 'subagent' }),
    context(3, 'notice-without-summary', 'unsummarized notice detail', { kind: 'subagent-settled', form: 'notice' }),
    context(4, 'recall-row', 'recalled transcript details', { kind: 'session-reference', form: 'recall', references: [{ label: 'prior session' }] }),
    context(5, 'relay-row', 'relayed readable body', { kind: 'agent-message', form: 'relay', senderSessionId: 'agent-1' }),
    context(6, 'unknown-row', 'unknown context remains readable', { kind: 'future-producer', form: 'future-context' }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 7),
  ]).messages()
  const keys = new TranscriptNodeKeys()
  const closed = flatten(messages, 'full', keys)
  const notice = rowOf(messages, (row): row is Extract<TranscriptMessage, { kind: 'system' }> => row.kind === 'system' && row.text.includes('notice payload detail'))
  const noticeNode = closed.find(node => node.id === `main.s1-${keys.keyFor(notice)}`)
  assert.ok(noticeNode !== undefined)
  assert.equal(noticeNode.kind, 'section')
  assert.equal(noticeNode.props['collapsed'], true)
  assert.ok(nodeText(noticeNode).includes('Agent completed'), 'the trusted producer summary stays visible')
  assert.ok(!nodeText(noticeNode).includes('notice payload detail'), 'the notice payload starts closed')
  assert.ok(closed.some(node => node.props['text'] === 'unsummarized notice detail'), 'a notice without summary fails open')
  assert.ok(closed.some(node => node.props['text'] === 'relayed readable body'), 'Relay remains fully readable')
  assert.ok(closed.some(node => node.props['text'] === 'unknown context remains readable'), 'unknown Context fails open')

  const recall = rowOf(messages, (row): row is Extract<TranscriptMessage, { kind: 'system' }> => row.kind === 'system' && row.text.includes('recalled transcript details'))
  const recallKey = keys.keyFor(recall)
  const recallOpen = flatten(messages, 'full', keys, { expandedContextRowOwners: new Set([recall]) })
  const recallNode = recallOpen.find(node => node.id === `main.s1-${recallKey}`)
  assert.ok(recallNode !== undefined)
  assert.equal(recallNode.props['collapsed'], false)
  assert.ok(nodeText(recallNode).includes('recalled transcript details'))
})

test('collapsed Tool and Context details do not enter the visible image-demand set', () => {
  const attachment = { attachmentId: 'image-1', mediaType: 'image/png', bytes: 4, width: 2, height: 2 }
  const messages = folder([
    ev('turn/start', { turn: 1 }, 0), user(1, 'read an image'),
    toolCall(2, 'image-call', 'read_image', '{}'),
    ev('tool/result', { turn: 1, step: 0, message: {
      id: MessageId('image-result'), role: 'tool', toolCallId: ToolCallId('image-call'),
      content: [{ type: 'text', text: 'image result' }, { type: 'image', attachment }],
      source: { kind: 'tool', callId: 'image-call' },
    } }, 3),
    context(4, 'snapshot-image-context', 'context body', { kind: 'plugin', form: 'snapshot', plugin: 'image-context' }),
    context(5, 'snapshot-image-context-2', 'context body 2', { kind: 'plugin', form: 'snapshot', plugin: 'other-context' }),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
  ]).messages()
  const keys = new TranscriptNodeKeys()
  const tool = toolRows(messages)[0]!
  const snapshots = messages.filter((row): row is Extract<TranscriptMessage, { kind: 'system' }> => row.kind === 'system')
  const structure = projectTranscriptStructure(messages)
  const cluster = structure.flatMap(block => block.kind === 'context-cluster' ? [block.cluster]
    : block.kind === 'work' ? block.span.parts.flatMap(part => part.kind === 'context-cluster' ? [part.cluster] : []) : [])[0]!

  const closed = visibleTranscriptMembers(messages, {
    preset: 'full', window: WINDOW, expandedToolKeys: new Set<string>(),
    innerDisclosure: {
      expandedThinkingOwners: new Set(), expandedContextRowOwners: new Set(), expandedClusterOwners: new Set(),
      expandedCommandCompactionOwners: new Set(),
    },
  }, keys)
  assert.ok(!closed.has(tool), 'a closed Full Tool body does not demand its result image')
  assert.ok(!closed.has(snapshots[0]!), 'a closed cluster does not demand its hidden members')

  const toolOpen = visibleTranscriptMembers(messages, {
    preset: 'full', window: WINDOW, expandedToolKeys: new Set([keys.keyFor(tool)]),
    innerDisclosure: {
      expandedThinkingOwners: new Set(), expandedContextRowOwners: new Set(), expandedClusterOwners: new Set(),
      expandedCommandCompactionOwners: new Set(),
    },
  }, keys)
  assert.ok(toolOpen.has(tool), 'opening the exact Tool owner grants its body')
  const clusterOpen = visibleTranscriptMembers(messages, {
    preset: 'full', window: WINDOW, expandedToolKeys: new Set<string>(),
    innerDisclosure: {
      expandedThinkingOwners: new Set(), expandedContextRowOwners: new Set(), expandedClusterOwners: new Set([cluster.owner]),
      expandedCommandCompactionOwners: new Set(),
    },
  }, keys)
  assert.ok(!clusterOpen.has(snapshots[0]!), 'an open canonical Cluster alone does not claim a member body')
  assert.ok(!clusterOpen.has(cluster.members[1]!), 'each member body needs its own disclosure owner')
  const memberOpen = visibleTranscriptMembers(messages, {
    preset: 'full', window: WINDOW, expandedToolKeys: new Set<string>(),
    innerDisclosure: {
      expandedThinkingOwners: new Set(),
      expandedContextRowOwners: new Set([snapshots[0]!]),
      expandedClusterOwners: new Set([cluster.owner]),
      expandedCommandCompactionOwners: new Set(),
    },
  }, keys)
  assert.ok(memberOpen.has(snapshots[0]!), 'opening the exact member owner grants its body')
  assert.ok(!memberOpen.has(cluster.members[1]!), 'the sibling member stays hidden')

  const compact = visibleTranscriptMembers(messages, { preset: 'compact', window: WINDOW }, keys)
  assert.ok(!compact.has(tool), 'a collapsed Compact Work remains hidden')
  assert.ok(snapshots.length > 0)
})

test('unknown and unmatched Tool diagnostics stay fail-open instead of gaining a dead disclosure', () => {
  const failure = `ENOENT:${'x'.repeat(220)}:BODY-TAIL`
  const folderWithError = workFolder({ toolErrorText: failure })
  const messages = folderWithError.messages()
  const errorRow = toolRows(messages)[0]!
  const keys = new TranscriptNodeKeys()
  const closed = flatten(messages, 'full', keys)
  const errorNode = closed.find(node => node.kind === 'tool' && node.props['name'] === 'read')
  assert.ok(errorNode !== undefined)
  assert.equal(errorNode.props['status'], 'error')
  assert.ok(typeof errorNode.props['note'] === 'string' && String(errorNode.props['note']).startsWith('ENOENT:'),
    'the closed error card preserves a readable failure note')
  assert.ok(String(errorNode.props['note']).length <= 180, 'the header note is bounded')
  assert.equal(closed.some(node => node.id === `${errorNode.id}.result`), false,
    'the full failure body is not materialized while closed')
  const opened = flatten(messages, 'full', keys, { expandedToolKeys: new Set([keys.keyFor(errorRow)]) })
  assert.ok(opened.find(node => node.id === `${errorNode.id}.result`)?.props['text'] === failure,
    'the full failure payload is unchanged inside the opened body')

  const unmatched = folder([
    ev('turn/start', { turn: 1 }, 0), user(1, 'an orphan tool result'),
    ev('tool/result', { turn: 1, step: 0, message: {
      id: MessageId('orphan-result'), role: 'tool', toolCallId: ToolCallId('never-called'),
      content: [{ type: 'text', text: 'unmatched result reason' }], source: { kind: 'tool', callId: 'never-called' },
    } }, 2),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3),
  ]).messages()
  const orphan = flatten(unmatched, 'full').find(node => node.kind === 'card' && node.props['tone'] === 'warning')
  assert.ok(orphan !== undefined)
  assert.equal(orphan.props['collapsible'], undefined, 'the warning remains a directly readable diagnostic')
  assert.ok(nodeText(orphan).includes('unmatched result reason'))
  assert.ok(errorRow !== undefined)
})

test('inner disclosure preserves per-owner visibility through canonical presets and legacy mapping fails open', () => {
  const messages = workFolder().messages()
  const thinkingRow = rowOf(messages, (row): row is Extract<TranscriptMessage, { kind: 'thinking' }> => row.kind === 'thinking')
  const tool = toolRows(messages)[0]!
  const structure = projectTranscriptStructure(messages)
  const work = structure.find(block => block.kind === 'work')
  assert.ok(work?.kind === 'work')
  const base = { turnActivities: workFolder().turnActivities(), window: WINDOW }
  const keys = new TranscriptNodeKeys()
  for (const message of messages) keys.keyFor(message)
  const innerDisclosure = {
    expandedThinkingOwners: new Set<TranscriptMessage>(),
    expandedContextRowOwners: new Set<TranscriptMessage>(),
    expandedClusterOwners: new Set<TranscriptMessage>(),
    expandedCommandCompactionOwners: new Set<TranscriptMessage>(),
  }
  const rootClosed = visibleTranscriptMembers(messages, {
    preset: 'focus', ...base, expandedToolKeys: new Set<string>(), innerDisclosure,
  }, keys)
  assert.ok(!rootClosed.has(tool), 'a closed Focus root grants no Work image demand')
  const rootOpen = visibleTranscriptMembers(messages, {
    preset: 'focus', ...base, expandedToolKeys: new Set<string>(), innerDisclosure,
    expandedFocusTurns: new Set([1]),
  }, keys)
  assert.ok(!rootOpen.has(tool), 'opening only the Focus root keeps Work details hidden')
  const workOpen = visibleTranscriptMembers(messages, {
    preset: 'focus', ...base, expandedToolKeys: new Set<string>(), innerDisclosure,
    expandedFocusTurns: new Set([1]), expandedWorkOwners: new Set([work.span.owner]),
  }, keys)
  assert.ok(!workOpen.has(tool), 'opening the Work still keeps its Tool body closed')
  const toolOpen = visibleTranscriptMembers(messages, {
    preset: 'focus', ...base, expandedToolKeys: new Set([keys.keyFor(tool)]),
    innerDisclosure: { ...innerDisclosure, expandedThinkingOwners: new Set([thinkingRow]) },
    expandedFocusTurns: new Set([1]), expandedWorkOwners: new Set([work.span.owner]),
  }, keys)
  assert.ok(toolOpen.has(tool), 'the exact Tool owner is the final image-demand gate')
  assert.ok(toolOpen.has(thinkingRow), 'the requested Thinking row is the same canonical message owner')
})

function commandRun(seq: number, id: string, name: string, args?: string): SessionEvent {
  return ev('command/run', {
    commandId: CommandId(id),
    name,
    ...(args === undefined ? {} : { args }),
    source: { kind: 'user' },
  }, seq)
}

function commandDone(seq: number, id: string, kind: 'success' | 'error', text?: string): SessionEvent {
  return ev('command/done', {
    commandId: CommandId(id),
    kind,
    ...(text === undefined ? {} : { text }),
  }, seq)
}

function commandRowsOf(messages: readonly TranscriptMessage[]): TranscriptCommandRow[] {
  return messages.filter((row): row is TranscriptCommandRow => row.kind === 'command')
}

function compactionRowsOf(messages: readonly TranscriptMessage[]): TranscriptCompactionRow[] {
  return messages.filter((row): row is TranscriptCompactionRow => row.kind === 'compaction')
}

type TranscriptCommandRow = Extract<TranscriptMessage, { kind: 'command' }>
type TranscriptCompactionRow = Extract<TranscriptMessage, { kind: 'compaction' }>

test('Command rows become native Sections only when they carry real detail', () => {
  const longLine = `LONG-COMMAND-RESULT-${'x'.repeat(400)}`
  const events: SessionEvent[] = [
    commandRun(0, 'cmd-running', 'status', ' --short'),
    commandRun(1, 'cmd-ok', 'status', ' --short'),
    commandDone(2, 'cmd-ok', 'success', 'session healthy\nsecond line'),
    commandDone(3, 'cmd-fragment', 'success', 'fragment outcome'),
    commandDone(4, 'cmd-empty-error', 'error', ''),
    commandRun(5, 'cmd-long', 'report', ''),
    commandDone(6, 'cmd-long', 'success', longLine),
    commandRun(7, 'cmd-error', 'deploy', 'prod'),
    commandDone(8, 'cmd-error', 'error', 'permission denied'),
  ]
  const messages = folder(events).messages()
  const rows = commandRowsOf(messages)
  const keys = new TranscriptNodeKeys()
  const closed = flatten(messages, 'full', keys)
  const nodeOf = (row: TranscriptCommandRow, nodes = closed): Tree | undefined =>
    nodes.find(node => node.props['key'] === `s1-${keys.keyFor(row)}`)
  const staticNodeOf = (row: TranscriptCommandRow, nodes = closed): Tree | undefined =>
    nodes.find(node => node.props['key'] === `s1-${keys.keyFor(row)}-static`)

  const ok = rows.find(row => row.commandId === CommandId('cmd-ok'))!
  const okNode = nodeOf(ok)
  assert.equal(okNode?.kind, 'section', 'a settled Command with a result is a native Section')
  assert.equal(okNode?.props['collapsible'], true)
  assert.equal(okNode?.props['collapsed'], true, 'real Command detail starts collapsed')
  const okText = nodeText(okNode!)
  assert.ok(okText.includes('/status --short'), `the raw args keep their one authored separator: ${okText}`)
  assert.ok(okText.includes('OK'), 'the status word is textual, never color-only')
  assert.ok(okText.includes('session healthy'), 'the bounded preview shows the first result line')
  assert.ok(!okText.includes('second line'), 'the hidden body is not materialized')
  assert.ok(!okText.includes(' --short  --short'), 'the args separator is never doubled')
  assert.equal(closed.some(node => node.id === `${okNode!.id}.body`), false)

  const opened = flatten(messages, 'full', keys, { expandedCommandCompactionOwners: new Set([ok]) })
  const openedNode = opened.find(node => node.id === okNode!.id)
  assert.equal(openedNode?.props['collapsed'], false)
  assert.ok(opened.some(node => node.id === `${okNode!.id}.body` && node.props['text'] === 'session healthy\nsecond line'),
    'the opened body is the complete source result, not the preview')

  const running = rows.find(row => row.commandId === CommandId('cmd-running'))!
  const runningNode = staticNodeOf(running)
  assert.equal(runningNode?.kind, 'card', 'a detail-less running Command is a static card')
  assert.equal(runningNode?.props['collapsible'], undefined, 'a static card has no dead chevron')
  const runningText = nodeText(runningNode!)
  assert.ok(runningText.includes('/status --short'))
  assert.ok(runningText.includes('Running'))

  const fragment = rows.find(row => row.commandId === CommandId('cmd-fragment'))!
  const fragmentNode = nodeOf(fragment)
  assert.equal(fragmentNode?.kind, 'section')
  const fragmentText = nodeText(fragmentNode!)
  const fragmentTitle = fragmentNode!.children
    .find(child => child.props['key'] === 'head')?.children
    .find(child => child.props['key'] === 'title-row')?.children
    .find(child => child.props['key'] === 'title')
  assert.equal(fragmentTitle?.props['text'], 'Command', 'a done-only fragment invents no command name')
  assert.ok(!fragmentText.includes('/undefined') && !fragmentText.includes('/null'))
  assert.ok(fragmentText.includes('OK'))

  const emptyError = rows.find(row => row.commandId === CommandId('cmd-empty-error'))!
  const emptyErrorNode = staticNodeOf(emptyError)
  assert.equal(emptyErrorNode?.kind, 'card', 'an empty error result is a static failure card')
  assert.equal(emptyErrorNode?.props['status'], 'error')
  assert.equal(emptyErrorNode?.props['collapsible'], undefined)
  assert.ok(nodeText(emptyErrorNode!).includes('Error'), 'the empty error still shows its failed status word')
  assert.equal(closed.some(node => node.id === `${emptyErrorNode!.id}.body`), false, 'no invented failure detail')

  const error = rows.find(row => row.commandId === CommandId('cmd-error'))!
  const errorNode = nodeOf(error)
  assert.equal(errorNode?.props['collapsed'], true)
  assert.ok(nodeText(errorNode!).includes('Error'))
  const errorOpened = flatten(messages, 'full', keys, { expandedCommandCompactionOwners: new Set([error]) })
  assert.ok(errorOpened.some(node => node.id === `${errorNode!.id}.body` && node.props['text'] === 'permission denied'),
    'the failed command exposes its complete result on demand')

  const long = rows.find(row => row.commandId === CommandId('cmd-long'))!
  const longNode = nodeOf(long)
  const preview = longNode!.children.filter(child => child.props['key'] === 'head')[0]?.children
    .filter(child => String(child.props['key'] ?? '').startsWith('detail'))
    .map(child => String(child.props['text'] ?? ''))
    .join('')
  assert.ok(preview !== undefined && Array.from(preview).length <= 180, `the Command preview is width-bounded: ${preview?.length}`)
  assert.ok(preview!.endsWith('…'), 'a truncated preview is explicit')
  assert.equal(closed.some(node => node.id === `${longNode!.id}.body`), false, 'the long body stays unmaterialized while closed')

  const legacy = View.from({ main: transcriptView(projectTranscriptStructure(messages), new TranscriptNodeKeys()) })
  const legacySections = legacy.regions[0]?.children.filter(node => node.kind === 'section') ?? []
  assert.ok(legacySections.every(node => node.props['collapsible'] !== true),
    'a legacy ownerless map keeps the historical fully-readable card, never a dead head')
  assert.ok(legacy.regions[0]!.children.some(node => node.kind === 'card' && nodeText(node).includes('permission denied')))
})

test('Compaction cards follow the official lifecycle, counts and manual-compaction ownership', () => {
  const events: SessionEvent[] = [
    ev('compaction/start', { compactionId: 'cpt-run', turn: null }, 0),
    ev('compaction/start', { compactionId: 'cpt-ok', turn: null }, 1),
    ev('compaction/summary', {
      compactionId: 'cpt-ok', summary: [{ type: 'text', text: 'summarized body\nsecond summary line' }],
      shadowedSeqs: [1, 2, 3], shadowedTokenCount: 42,
    }, 2),
    ev('compaction/end', { compactionId: 'cpt-ok' }, 3),
    ev('compaction/start', { compactionId: 'cpt-error', turn: null }, 4),
    ev('compaction/end', { compactionId: 'cpt-error', error: 'summarizer failed' }, 5),
    commandRun(6, 'cmd-manual', 'compact', ''),
    ev('compaction/start', { compactionId: 'cpt-manual', sourceCommandId: CommandId('cmd-manual'), turn: null }, 7),
    ev('compaction/summary', {
      compactionId: 'cpt-manual', sourceCommandId: CommandId('cmd-manual'),
      summary: [{ type: 'text', text: 'manual summary body' }], shadowedSeqs: [4], shadowedTokenCount: 9,
    }, 8),
    ev('compaction/end', { compactionId: 'cpt-manual' }, 9),
    commandDone(10, 'cmd-manual', 'success', 'manual command result'),
  ]
  const messages = folder(events).messages()
  assert.equal(commandRowsOf(messages).length, 0, 'a fused manual Command is never a second visible row')
  const compactions = compactionRowsOf(messages)
  assert.equal(compactions.length, 4)
  const keys = new TranscriptNodeKeys()
  const closed = flatten(messages, 'full', keys)
  const nodeOf = (row: TranscriptCompactionRow, nodes = closed): Tree | undefined =>
    nodes.find(node => node.props['key'] === `s1-${keys.keyFor(row)}`)
  const staticNodeOf = (row: TranscriptCompactionRow, nodes = closed): Tree | undefined =>
    nodes.find(node => node.props['key'] === `s1-${keys.keyFor(row)}-static`)

  const running = compactions.find(row => row.items === 0 && row.tokens === 0 && row.error === undefined)!
  const runningNode = staticNodeOf(running)
  assert.equal(runningNode?.kind, 'card', 'a running count-less Compaction is a static card')
  assert.equal(runningNode?.props['collapsible'], undefined)
  assert.ok(nodeText(runningNode!).includes('Compacting context'))

  const ok = compactions.find(row => row.items === 3)!
  const okNode = nodeOf(ok)
  assert.equal(okNode?.kind, 'section')
  assert.equal(okNode?.props['collapsed'], true)
  const okText = nodeText(okNode!)
  assert.ok(okText.includes('Context compacted'))
  assert.ok(okText.includes('Compacted 3 history items (~42 tokens)'))
  assert.ok(!okText.includes('summarized body'), 'the summary is detail, not the collapsed preview')
  const okOpened = flatten(messages, 'full', keys, { expandedCommandCompactionOwners: new Set([ok]) })
  assert.ok(okOpened.some(node => node.id === `${okNode!.id}.body` && node.props['text'] === 'summarized body\nsecond summary line'))

  const failed = compactions.find(row => row.error === 'summarizer failed')!
  const failedNode = nodeOf(failed)
  assert.equal(failedNode?.kind, 'section')
  assert.ok(nodeText(failedNode!).includes('Compaction failed'))
  assert.ok(nodeText(failedNode!).includes('Error'))
  assert.ok(nodeText(failedNode!).includes('summarizer failed'), 'the failed reason stays readable while collapsed')
  const failedOpened = flatten(messages, 'full', keys, { expandedCommandCompactionOwners: new Set([failed]) })
  assert.ok(failedOpened.some(node => node.id === `${failedNode!.id}.error` && node.props['text'] === 'summarizer failed'))

  const manual = compactions.find(row => row.sourceCommand !== undefined)!
  assert.equal(manual.sourceCommand?.name, 'compact')
  const manualNode = nodeOf(manual)
  assert.equal(manualNode?.kind, 'section')
  const manualText = nodeText(manualNode!)
  assert.ok(manualText.includes('Context compacted /compact'), `the fused owner names the command: ${manualText}`)
  assert.ok(manualText.includes('Compacted 1 history item (~9 tokens)'))
  assert.ok(manualText.includes('manual command result'), 'the settled command result feeds the collapsed preview')
  const manualOpened = flatten(messages, 'full', keys, { expandedCommandCompactionOwners: new Set([manual]) })
  assert.ok(manualOpened.some(node => node.id === `${manualNode!.id}.body` && node.props['text'] === 'manual summary body'))
  assert.ok(manualOpened.some(node => node.id === `${manualNode!.id}.outcome` && node.props['text'] === 'manual command result'),
    'the linked command outcome is shown once beside the summary')

  // Negative control: a `/compact` command and a compaction WITHOUT the
  // official source-command relationship are two independent rows; nothing is
  // fused by name or by neighbouring position.
  const unrelated = folder([
    commandRun(0, 'cmd-unrelated', 'compact'),
    commandDone(1, 'cmd-unrelated', 'success', 'normal command'),
    ev('compaction/start', { compactionId: 'cpt-unrelated', turn: null }, 2),
    ev('compaction/summary', { compactionId: 'cpt-unrelated', summary: [{ type: 'text', text: 'unrelated summary' }], shadowedSeqs: [1], shadowedTokenCount: 3 }, 3),
    ev('compaction/end', { compactionId: 'cpt-unrelated' }, 4),
  ]).messages()
  assert.equal(commandRowsOf(unrelated).length, 1, 'an unproven /compact command keeps its own row')
  const unrelatedRows = compactionRowsOf(unrelated)
  assert.equal(unrelatedRows.length, 1)
  assert.equal(unrelatedRows[0]!.sourceCommand, undefined)
})

test('a manual compaction failure recognizes the command error kind even with empty text', () => {
  const messages = folder([
    commandRun(0, 'cmd-failed-manual', 'compact'),
    ev('compaction/start', { compactionId: 'cpt-failed', sourceCommandId: CommandId('cmd-failed-manual'), turn: null }, 1),
    ev('compaction/summary', {
      compactionId: 'cpt-failed', sourceCommandId: CommandId('cmd-failed-manual'),
      summary: [{ type: 'text', text: 'summary body survived the failure' }], shadowedSeqs: [2], shadowedTokenCount: 5,
    }, 2),
    ev('compaction/end', { compactionId: 'cpt-failed' }, 3),
    commandDone(4, 'cmd-failed-manual', 'error', ''),
  ]).messages()
  const row = compactionRowsOf(messages)[0]!
  assert.equal(row.sourceCommand?.outcome?.kind, 'error')
  const keys = new TranscriptNodeKeys()
  const closed = flatten(messages, 'full', keys)
  const node = closed.find(entry => entry.props['key'] === `s1-${keys.keyFor(row)}`)
  assert.equal(node?.kind, 'section')
  const text = nodeText(node!)
  assert.ok(text.includes('Compaction failed /compact'), `error kind wins without error text: ${text}`)
  assert.ok(text.includes('Error'))
  assert.ok(!text.includes('Context compacted'))
  const opened = flatten(messages, 'full', keys, { expandedCommandCompactionOwners: new Set([row]) })
  assert.ok(opened.some(entry => entry.id === `${node!.id}.body` && entry.props['text'] === 'summary body survived the failure'))
})

test('folded Tools expose only trusted, bounded human summaries from the shared helpers', () => {
  const ref = `sv2_${'a'.repeat(20)}`
  const receipt = `visual-published-v1:${JSON.stringify({ version: 1, published: [{ ref }] })}`
  const events: SessionEvent[] = [
    ev('turn/start', { turn: 1 }, 0),
    user(1, 'exercise folded tool previews'),
    toolCall(2, 'call-read', 'read', '{"file_path":"src/a.ts"}', 0),
    toolResult(3, 'call-read', '<path>src/a.ts</path>\n<type>file</type>\n<content>\n1: a\n2: b\n(End of file - total 2 lines)\n</content>', 0),
    toolCall(4, 'call-write', 'write', '{"file_path":"src/a.ts"}', 1),
    toolResult(5, 'call-write', '<path>src/a.ts</path> <type>file</type> <content>Updated file</content>', 1),
    toolCall(6, 'call-skill', 'skill', '{"name":"alpha"}', 2),
    toolResult(7, 'call-skill', '<skill_content name="alpha"><skill_resources></skill_resources><skill_instructions>\nfirst instruction\nsecond instruction\n</skill_instructions></skill_content>', 2),
    toolCall(8, 'call-image', 'read_image', '{"path":"shot.png"}', 3),
    toolResult(9, 'call-image', '<path>shot.png</path> <type>image</type> <content>\nPNG image, 800x600 px, 1234 bytes\n</content>', 3),
    toolCall(10, 'call-goal', 'update_goal', '{"status":"active"}', 4),
    toolResult(11, 'call-goal', '{"goal":{"phase":"active","revision":3,"roundsStarted":2,"maxGoalRounds":6}}', 4),
    toolCall(12, 'call-ask', 'ask_user_question', '{"questions":[]}', 5),
    toolResult(13, 'call-ask', '{"answers":[{"id":"q1","selected":["yes"]},{"id":"q2"}]}', 5),
    toolCall(14, 'call-schedule', 'schedule_list', '{}', 6),
    toolResult(15, 'call-schedule', '{"items":[],"shown":0,"total":0,"limit":10,"offset":0}', 6),
    toolCall(16, 'call-visual', 'present_visual', '{"files":[]}', 7),
    toolResult(17, 'call-visual', `Published 1 visual.\n${receipt}`, 7),
    toolCall(18, 'call-bash', 'bash', '{"command":"false"}', 8),
    toolResult(19, 'call-bash', '\u001b[31mline one\u001b[0m\rprogress 10%\rprogress 100%\nsecond', 8),
    toolCall(20, 'call-unknown', 'mystery_tool', '{}', 9),
    toolResult(21, 'call-unknown', 'human summary line\nmore detail', 9),
    toolCall(22, 'call-json', 'mystery_tool', '{}', 10),
    toolResult(23, 'call-json', '{"machine":"receipt"}', 10),
    toolCall(24, 'call-xml', 'mystery_tool', '{}', 11),
    toolResult(25, 'call-xml', '<path>machine.xml</path>', 11),
    toolCall(26, 'call-cjk', 'mystery_tool', '{}', 12),
    toolResult(27, 'call-cjk', `中文摘要${'很长'.repeat(200)}`, 12),
    toolCall(28, 'call-error', 'read', '{"file_path":"missing.ts"}', 13),
    toolResult(29, 'call-error', '<path>missing.ts</path>\n<type>file</type>\n<content>\n1: x\n(End of file - total 1 lines)\n</content>', 13, true),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 30),
  ]
  const messages = folder(events).messages()
  const keys = new TranscriptNodeKeys()
  const closed = flatten(messages, 'full', keys)
  const noteOf = (name: string, occurrence = 0): string | undefined => {
    const nodes = closed.filter(node => node.kind === 'tool' && node.props['name'] === name)
    return nodes[occurrence]?.props['note'] === undefined ? undefined : String(nodes[occurrence]!.props['note'])
  }
  assert.equal(noteOf('read'), '2 lines')
  assert.equal(noteOf('write'), 'Updated')
  assert.equal(noteOf('skill'), '2 lines of instructions')
  assert.equal(noteOf('read_image'), 'PNG image, 800x600 px, 1234 bytes')
  assert.equal(noteOf('update_goal'), 'phase active · revision 3 · 2/6 rounds')
  assert.equal(noteOf('ask_user_question'), '1/2 answered')
  assert.equal(noteOf('schedule_list'), 'no scheduled tasks')
  assert.equal(noteOf('present_visual'), 'Published 1 visual.')
  assert.ok(!(noteOf('present_visual') ?? '').includes('visual-published-v1'), 'no machine receipt becomes a note')
  assert.equal(noteOf('bash'), 'line one', 'the terminal log policy runs before the preview and strips SGR')
  assert.equal(noteOf('mystery_tool', 0), 'human summary line')
  assert.equal(noteOf('mystery_tool', 1), undefined, 'raw JSON never becomes a human note')
  assert.equal(noteOf('mystery_tool', 2), undefined, 'raw XML never becomes a human note')
  const cjk = noteOf('mystery_tool', 3)
  assert.ok(cjk !== undefined && Array.from(cjk).length <= 180, `a CJK note stays bounded: ${cjk?.length}`)
  const failed = closed.find(node => node.kind === 'tool' && node.props['name'] === 'read' && node.props['status'] === 'error')
  assert.ok(String(failed?.props['note'] ?? '').startsWith('<path>'), 'the existing error note still owns a failed row')

  // A malformed read envelope degrades to NO note, never to the raw envelope.
  const malformed = folder([
    ev('turn/start', { turn: 1 }, 0), user(1, 'malformed read'),
    toolCall(2, 'call-bad-read', 'read', '{}'), toolResult(3, 'call-bad-read', '<path>bad.ts</path><type>file</type><content>not numbered</content>'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4),
  ]).messages()
  const malformedNode = flatten(malformed, 'full').find(node => node.kind === 'tool' && node.props['name'] === 'read')
  assert.equal(malformedNode?.props['note'], undefined, 'an unparseable envelope shows no preview')

  // The note is a FOLDED-only affordance: opening the exact row reveals the
  // real body and no longer needs the one-line substitute.
  const readRow = messages.find((row): row is TranscriptToolMessage => row.kind === 'tool' && row.name === 'read' && row.status === 'ok')!
  const opened = flatten(messages, 'full', keys, { expandedToolKeys: new Set([keys.keyFor(readRow)]) })
  const openedRead = opened.find(node => node.kind === 'tool' && node.props['name'] === 'read' && node.props['collapsed'] === false)
  assert.equal(openedRead?.props['note'], undefined, 'an opened Tool drops the folded note')
  assert.equal(openedRead?.props['collapsed'], false)
  assert.ok(nodeText(openedRead!).includes('src/a.ts'), 'the opened body is the real Tool content')
})
