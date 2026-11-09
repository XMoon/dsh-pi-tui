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
  assert.equal(compactOpen.filter(node => node.props['text'] === 'first injected payload').length, 1)
  assert.equal(compactOpen.filter(node => node.props['text'] === 'second injected payload').length, 1,
    'the open cluster presents each member exactly once without a second row disclosure')

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
    },
  }, keys)
  assert.ok(!closed.has(tool), 'a closed Full Tool body does not demand its result image')
  assert.ok(!closed.has(snapshots[0]!), 'a closed cluster does not demand its hidden members')

  const toolOpen = visibleTranscriptMembers(messages, {
    preset: 'full', window: WINDOW, expandedToolKeys: new Set([keys.keyFor(tool)]),
    innerDisclosure: {
      expandedThinkingOwners: new Set(), expandedContextRowOwners: new Set(), expandedClusterOwners: new Set(),
    },
  }, keys)
  assert.ok(toolOpen.has(tool), 'opening the exact Tool owner grants its body')
  const clusterOpen = visibleTranscriptMembers(messages, {
    preset: 'full', window: WINDOW, expandedToolKeys: new Set<string>(),
    innerDisclosure: {
      expandedThinkingOwners: new Set(), expandedContextRowOwners: new Set(), expandedClusterOwners: new Set([cluster.owner]),
    },
  }, keys)
  assert.ok(clusterOpen.has(cluster.members[0]!), 'opening the canonical cluster grants its members')

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
