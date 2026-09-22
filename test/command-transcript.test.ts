/**
 * Regression matrix for the post-PR166 command/descriptor convergence plan:
 *
 * - A real `kind: 'command'` transcript node: `command/run` creates one
 *   running Command, `command/done` settles the SAME row by commandId, a
 *   Command carries NO semantic turn, and an explicit `sourceEventSeq` /
 *   `sourceCommandId` relationship fuses a manual `/compact` command with
 *   its compaction card (one visible owner, search survives).
 * - `subagent/descriptor` is child identity metadata, NOT transcript
 *   content: it materializes no TranscriptMessage at all, while the
 *   parent's genuine `tool/call name=subagent` stays an ordinary Tool.
 *
 * Fold-level matrix A01–A17 / B01–B07 from the plan (rendering/extension
 * cases live in rendering.test.ts; the child-viewer identity case lives in
 * child-view.test.ts).
 * @module @xmoon76/dsh-pi-tui/command-transcript.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { TranscriptFolder, type TranscriptMessage } from '../src/transcript.ts'
import { projectFocus } from '../src/focus-activity.ts'
import { classifyTranscriptMessage } from '../src/transcript-semantics.ts'

function event<K extends string>(
  type: K,
  data: (K extends SessionEvent['type'] ? SessionEvent<K>['data'] : Record<string, unknown>) & Record<string, unknown>,
  seq: number,
): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, data } as SessionEvent
}

function rawEvent(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, data } as SessionEvent
}

function kinds(messages: readonly TranscriptMessage[]): string[] {
  return messages.map(message => message.kind)
}

function commandRows(messages: readonly TranscriptMessage[]): Array<Extract<TranscriptMessage, { kind: 'command' }>> {
  return messages.filter((message): message is Extract<TranscriptMessage, { kind: 'command' }> => message.kind === 'command')
}

function userMessage(text: string, seq: number, turn = 0): SessionEvent {
  return event('user/message', { id: MessageId(`msg-${seq}`), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, turn }, seq)
}

function assistantMessage(text: string, seq: number, turn = 0, step = 0): SessionEvent {
  return event('assistant/message', { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }], id: MessageId(`am-${seq}`), source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, seq)
}

function toolCall(name: string, callId: string, seq: number, turn = 0, step = 0, args = '{}'): SessionEvent {
  return event('tool/call', { callId: ToolCallId(callId), name, arguments: args, turn, step }, seq)
}

function toolResult(callId: string, text: string, seq: number, isError = false): SessionEvent {
  return event('tool/result', {
    turn: 0,
    step: 0,
    message: {
      id: MessageId(`msg-${seq}`),
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: ToolCallId(callId),
        content: [{ type: 'text', text }],
        isError,
      }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq)
}

function descriptor(seq: number, mode: 'continuable' | 'one-shot' = 'continuable', label = 'do the thing'): SessionEvent {
  return event('subagent/descriptor', { version: 2, mode, provider: 'in-process', label, agentModel: 'deepseek-chat' }, seq)
}

// ---------------------------------------------------------------------------
// A — command lifecycle
// ---------------------------------------------------------------------------

test('A01: command/run creates one real running Command with no semantic turn', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', args: 'hello', source: { kind: 'user' } }, 0),
  ])
  const messages = folder.messages()
  assert.deepEqual(kinds(messages), ['command'])
  const command = messages[0]
  assert.ok(command !== undefined && command.kind === 'command')
  assert.equal(command.commandId, CommandId('cmd-1'))
  assert.equal(command.name, 'title')
  assert.equal(command.args, 'hello')
  assert.equal(command.outcome, null, 'running command has a null outcome')
  assert.ok(!('turn' in command), 'a command never carries a semantic turn')
})

test('A01: a duplicated/replayed command/run with the same id never mints a second row', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', source: { kind: 'user' } }, 0),
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', source: { kind: 'user' } }, 1),
  ])
  assert.equal(commandRows(folder.messages()).length, 1)
})

test('A02: command/done settles the same row in place and dirties search', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', args: 'x', source: { kind: 'user' } }, 0),
  ])
  const running = commandRows(folder.messages())[0]
  assert.ok(running !== undefined)
  const revisionBefore = folder.searchRevision()
  folder.apply([
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'title set: hello' }, 1),
  ])
  const messages = folder.messages()
  assert.deepEqual(kinds(messages), ['command'], 'settlement must not allocate a second row')
  const settled = messages[0]
  assert.ok(settled === running, 'the settled row must be the SAME object as the running row')
  assert.ok(settled.kind === 'command' && settled.outcome !== null)
  assert.equal(settled.outcome?.kind, 'success')
  assert.equal(settled.outcome?.text, 'title set: hello')
  assert.ok(folder.searchRevision() > revisionBefore, 'settlement must dirty the search entry')
})

test('A03: an error command settles with an error outcome and no fabricated tool result', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', source: { kind: 'user' } }, 0),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'error', text: 'boom' }, 1),
  ])
  const messages = folder.messages()
  assert.deepEqual(kinds(messages), ['command'])
  const command = messages[0]
  assert.ok(command !== undefined && command.kind === 'command')
  assert.equal(command.outcome?.kind, 'error')
  assert.equal(command.outcome?.text, 'boom')
})

test('A04: a fragment-only command/done still produces one fail-soft command row', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/done', { commandId: CommandId('cmd-lost'), kind: 'success', text: 'done anyway' }, 0),
  ])
  const messages = folder.messages()
  assert.deepEqual(kinds(messages), ['command'])
  const command = messages[0]
  assert.ok(command !== undefined && command.kind === 'command')
  assert.equal(command.name, null)
  assert.equal(command.args, null)
  assert.ok(!('turn' in command), 'the fallback row never invents a turn')
  assert.equal(command.outcome?.text, 'done anyway')
})

test('A05: sourceEventSeq is retained only for a valid success relationship', () => {
  const valid = new TranscriptFolder()
  valid.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', source: { kind: 'user' } }, 0),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', sourceEventSeq: SessionSeq(7) }, 1),
  ])
  const okCommand = commandRows(valid.messages())[0]
  assert.ok(okCommand !== undefined)
  assert.equal(okCommand.outcome?.sourceEventSeq, SessionSeq(7))

  const negative = new TranscriptFolder()
  negative.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', source: { kind: 'user' } }, 0),
    rawEvent('command/done', { commandId: CommandId('cmd-1'), kind: 'success', sourceEventSeq: -3 }, 1),
  ])
  const ignored = commandRows(negative.messages())[0]
  assert.ok(ignored !== undefined)
  assert.equal(ignored.outcome?.sourceEventSeq, undefined, 'an invalid sequence value is dropped fail-soft')

  const failed = new TranscriptFolder()
  failed.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', source: { kind: 'user' } }, 0),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'error', text: 'nope', sourceEventSeq: SessionSeq(7) }, 1),
  ])
  const errored = commandRows(failed.messages())[0]
  assert.ok(errored !== undefined)
  assert.equal(errored.outcome?.sourceEventSeq, undefined, 'an error outcome never carries a success relationship')
})

// ---------------------------------------------------------------------------
// A — chronology / Focus / Compact
// ---------------------------------------------------------------------------

test('A06: an idle command after a completed turn renders after the final assistant', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    userMessage('hi', 1),
    assistantMessage('hello', 2),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 3),
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', source: { kind: 'user' } }, 4),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'title set' }, 5),
  ])
  assert.deepEqual(kinds(folder.messages()), ['user', 'assistant', 'command'])
})

test('A07: a mid-turn command splits the Focus Thought runs without touching Action stats', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    userMessage('go', 1),
    toolCall('read', 'call-a', 2),
    toolResult('call-a', 'a', 3),
    event('command/run', { commandId: CommandId('cmd-1'), name: 'model', source: { kind: 'user' } }, 4),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'switched' }, 5),
    toolCall('read', 'call-b', 6),
    toolResult('call-b', 'b', 7),
    assistantMessage('done', 8),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 9),
  ])
  const messages = folder.messages()
  const blocks = projectFocus(messages, folder.turnActivities(), new Set(), true)
  const activityIndexes = blocks.flatMap((block, index) => block.kind === 'activity' ? [index] : [])
  assert.equal(activityIndexes.length, 2, 'the command splits the turn into two Thought runs')
  const commandBlocks = blocks
    .map((block, index) => ({ block, index }))
    .filter(entry => entry.block.kind === 'message' && entry.block.message.kind === 'command')
  assert.equal(commandBlocks.length, 1, 'the command renders as a standalone Focus row')
  const commandIndex = commandBlocks[0]?.index ?? -1
  assert.ok(commandIndex > (activityIndexes[0] ?? -1) && commandIndex < (activityIndexes[1] ?? -1),
    'the command stays between the two Process runs in chronology')
  for (const index of activityIndexes) {
    const block = blocks[index]
    assert.ok(block !== undefined && block.kind === 'activity')
    // Turn-LEVEL stats count the turn's two REAL tool calls exactly: the
    // command contributes nothing (with the old fake Tool it counted as a
    // third call).
    assert.equal(block.actionStats.total, 2, 'ActionStats count real tool calls only')
  }
})

test('A07: a command is a control-class row and never Work/Activity/Action evidence', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    event('command/run', { commandId: CommandId('cmd-1'), name: 'model', source: { kind: 'user' } }, 1),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success' }, 2),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 3),
  ])
  const command = commandRows(folder.messages())[0]
  assert.ok(command !== undefined)
  assert.deepEqual(classifyTranscriptMessage(command), { class: 'control', origin: 'command' })
})

test('A08: a command-only session stays visible in full, bounded and search projections', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', args: 'x', source: { kind: 'user' } }, 0),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'title set: x' }, 1),
  ])
  assert.deepEqual(kinds(folder.messages()), ['command'])
  const window = folder.window({ maxTurns: 20 })
  assert.deepEqual(kinds(window.messages), ['command'], 'a zero-turn session must not render an empty transcript')
  // Occurrence-level results: 'title' hits both the name and the outcome.
  const matches = folder.search('title')
  assert.ok(matches.length >= 1)
  const resolved = folder.resolveSearchMatch(matches[0]!)
  assert.ok(resolved !== undefined && resolved.kind === 'command')
})

test('A09: a leading pre-turn command stays visible when the window contains the first turn', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', source: { kind: 'user' } }, 0),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'done' }, 1),
    event('turn/start', { turn: 0 }, 2),
    userMessage('hi', 3),
    assistantMessage('hello', 4),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ])
  const window = folder.window({ maxTurns: 1 })
  const windowKinds = kinds(window.messages)
  assert.ok(windowKinds.includes('command'), 'the leading standalone prefix belongs to the first-turn window')
  assert.ok(windowKinds.indexOf('command') < windowKinds.indexOf('user'))
  const full = folder.messages()
  assert.ok(kinds(full).indexOf('command') < kinds(full).indexOf('user'))
})

test('A09: an anchored search window can reveal a leading pre-turn command', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'export', source: { kind: 'user' } }, 0),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'exported' }, 1),
    event('turn/start', { turn: 0 }, 2),
    userMessage('hi', 3),
    assistantMessage('hello', 4),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ])
  const matches = folder.search('export')
  assert.ok(matches.length >= 1)
  const window = folder.window({ maxTurns: 1, endTurn: matches[0]!.turn })
  assert.ok(kinds(window.messages).includes('command'), 'the anchored window reveals the leading command')
})

test('A10: a tail command after the latest turn stays visible in the latest window', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    userMessage('hi', 1),
    assistantMessage('hello', 2),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 3),
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', source: { kind: 'user' } }, 4),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'ok' }, 5),
  ])
  const window = folder.window({ maxTurns: 1 })
  const windowKinds = kinds(window.messages)
  assert.ok(windowKinds[windowKinds.length - 1] === 'command', 'the tail command stays in the latest window')
})

test('A11: commands never inflate old-window tool-call counts', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    userMessage('old', 1),
    toolCall('read', 'call-old', 2),
    toolResult('call-old', 'old', 3),
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', source: { kind: 'user' } }, 4),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success' }, 5),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 6),
    event('turn/start', { turn: 1 }, 7),
    userMessage('new', 8),
    assistantMessage('latest', 9),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 10),
  ])
  const window = folder.window({ maxTurns: 1 })
  const summary = window.messages.find(message => message.kind === 'summary')
  assert.ok(summary !== undefined && summary.kind === 'summary')
  assert.ok(summary.text.includes('1 tool call'), summary.text)
  assert.ok(!summary.text.includes('2 tool calls'), summary.text)
})

// ---------------------------------------------------------------------------
// A — manual compaction correlation
// ---------------------------------------------------------------------------

/** The full manual /compact lifecycle: run → start → summary(seq=S) → end → done(sourceEventSeq=S). */
function manualCompactEvents(options: {
  readonly commandId?: string
  readonly compactionId?: string
  readonly withSourceCommandId?: boolean
  readonly withSourceEventSeq?: boolean
  readonly extraCompaction?: SessionEvent[]
  readonly args?: string
  readonly outcomeText?: string
} = {}): SessionEvent[] {
  const commandId = CommandId(options.commandId ?? 'cmd-1')
  const compactionId = options.compactionId ?? 'cpt-1'
  const events: SessionEvent[] = [
    event('command/run', { commandId, name: 'compact', ...(options.args === undefined ? {} : { args: options.args }), source: { kind: 'user' } }, 0),
    rawEvent('compaction/start', {
      compactionId,
      ...(options.withSourceCommandId === false ? {} : { sourceCommandId: commandId }),
      turn: null,
    }, 1),
  ]
  if (options.extraCompaction !== undefined) events.push(...options.extraCompaction)
  const summarySeq = 2 + (options.extraCompaction?.length ?? 0)
  events.push(
    rawEvent('compaction/summary', {
      compactionId,
      ...(options.withSourceCommandId === false ? {} : { sourceCommandId: commandId }),
      summary: [{ type: 'text', text: 'compacted summary body' }],
      shadowedSeqs: [0],
      shadowedTokenCount: 120,
    }, summarySeq),
    rawEvent('compaction/end', { compactionId }, summarySeq + 1),
    event('command/done', {
      commandId,
      kind: 'success',
      ...(options.outcomeText === undefined ? {} : { text: options.outcomeText }),
      ...(options.withSourceEventSeq === false ? {} : { sourceEventSeq: SessionSeq(summarySeq) }),
    }, summarySeq + 2),
  )
  return events
}

test('A12: a compaction lifecycle referencing the command id fuses the command into the card', () => {
  const folder = new TranscriptFolder()
  folder.apply(manualCompactEvents({ withSourceEventSeq: false }))
  const messages = folder.messages()
  const compactions = messages.filter(message => message.kind === 'compaction')
  assert.equal(compactions.length, 1)
  assert.equal(commandRows(messages).length, 0, 'the fused command renders no duplicate standalone row')
  const compaction = compactions[0]
  assert.ok(compaction !== undefined && compaction.kind === 'compaction')
  assert.ok(compaction.sourceCommand !== undefined, 'the correlation is inspectable on the compaction card')
  assert.equal(compaction.sourceCommand?.commandId, CommandId('cmd-1'))
})

test('A13: a sourceEventSeq pointing at the summary event resolves the exact compaction card', () => {
  const folder = new TranscriptFolder()
  folder.apply(manualCompactEvents({ withSourceCommandId: false }))
  const messages = folder.messages()
  assert.equal(commandRows(messages).length, 0, 'leg 2 alone proves the relationship')
  const compaction = messages.find(message => message.kind === 'compaction')
  assert.ok(compaction !== undefined && compaction.kind === 'compaction')
  assert.ok(compaction.sourceCommand !== undefined)
  assert.equal(compaction.sourceCommand?.outcome?.sourceEventSeq, SessionSeq(2))
})

test('A14: after authoritative correlation there is exactly one visible manual-compaction presentation', () => {
  const folder = new TranscriptFolder()
  folder.apply(manualCompactEvents())
  const messages = folder.messages()
  assert.deepEqual(kinds(messages), ['compaction'], 'one compaction card owns the whole manual compaction')
  const window = folder.window({ maxTurns: 20 })
  assert.deepEqual(kinds(window.messages).filter(kind => kind !== 'summary'), ['compaction'])
})

test('A15: search still finds the fused command through the compaction representative', () => {
  const folder = new TranscriptFolder()
  folder.apply(manualCompactEvents({ args: 'unique-arg-token', outcomeText: 'distinctive-outcome-token' }))
  // Distinctive needles that appear ONLY in the command's own fields — the
  // compaction summary body ('compacted summary body') must not be what
  // matches — proving the command-field corpus rode along into the card.
  const byArgs = folder.search('unique-arg-token')
  assert.ok(byArgs.length >= 1, 'the command args are searchable through the card')
  const byOutcome = folder.search('distinctive-outcome-token')
  assert.ok(byOutcome.length >= 1, 'the command outcome text is searchable through the card')
  for (const matches of [byArgs, byOutcome]) {
    const resolved = folder.resolveSearchMatch(matches[0]!)
    assert.ok(resolved !== undefined && resolved.kind === 'compaction', 'the hit lands on the compaction representative')
    assert.equal(matches.every(match => match.source.kind === 'command-field'), true, 'the sources keep the command-field identity')
    const commandIds = new Set(matches.map(match => match.id))
    assert.equal(commandIds.size, 1, 'no duplicate occurrences after fusion')
  }
  assert.equal(folder.messages().filter(message => message.kind === 'command').length, 0,
    'the hidden raw command never emits a second visible row')
})

test('A09/F1 regression: a settled inter-turn command in a later turn keeps its placement anchor', () => {
  // command/done necessarily marks the search entry dirty; the lazy
  // re-normalization must NOT reset the presentation anchor to 0 for a
  // turn-less row (the anchor sidecar written at append time is the
  // authority) — otherwise the anchored search window hides the command.
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 5 }, 0),
    userMessage('earlier prompt', 1, 5),
    event('turn/end', { turn: 5, reason: { kind: 'completed' } }, 2),
    event('command/run', { commandId: CommandId('cmd-1'), name: 'title', args: 'x', source: { kind: 'user' } }, 3),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'title set: x' }, 4),
    event('turn/start', { turn: 6 }, 5),
    userMessage('later prompt', 6, 6),
    event('turn/end', { turn: 6, reason: { kind: 'completed' } }, 7),
  ])
  const matches = folder.search('title')
  assert.ok(matches.length >= 1)
  const anchor = matches[0]!.turn
  assert.equal(anchor, 5, `the match anchors to the preceding turn, not 0 (got ${anchor})`)
  const window = folder.window({ maxTurns: 1, endTurn: anchor })
  assert.ok(window.messages.some(message => message.kind === 'command'),
    'the anchored window reveals the inter-turn command')
})

test('A12 reverse order: evidence arriving after a leg-2 fusion never re-decides it', () => {
  // command/done settles FIRST (leg 2 alone fuses to cpt-a); a later
  // compaction lifecycle claiming the same command id (leg 1) must neither
  // move nor revoke the established fusion.
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', source: { kind: 'user' } }, 0),
    rawEvent('compaction/start', { compactionId: 'cpt-a', turn: null }, 1),
    rawEvent('compaction/summary', { compactionId: 'cpt-a', summary: [{ type: 'text', text: 'body' }], shadowedSeqs: [0], shadowedTokenCount: 10 }, 2),
    rawEvent('compaction/end', { compactionId: 'cpt-a' }, 3),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', sourceEventSeq: SessionSeq(2) }, 4),
    rawEvent('compaction/start', { compactionId: 'cpt-b', sourceCommandId: CommandId('cmd-1'), turn: null }, 5),
    rawEvent('compaction/summary', { compactionId: 'cpt-b', sourceCommandId: CommandId('cmd-1'), summary: [{ type: 'text', text: 'other' }], shadowedSeqs: [0], shadowedTokenCount: 10 }, 6),
    rawEvent('compaction/end', { compactionId: 'cpt-b' }, 7),
  ])
  const messages = folder.messages()
  const fused = messages.filter(message => message.kind === 'compaction' && message.sourceCommand !== undefined)
  assert.equal(fused.length, 1, 'exactly one compaction owns the command')
  assert.ok(fused[0]?.kind === 'compaction' && fused[0].sourceCommand?.commandId === CommandId('cmd-1'))
  assert.equal(commandRows(messages).length, 0, 'the command stays hidden behind its established owner')
})

test('fold parity: a cold hydrate and a live apply produce the same command projection', () => {
  const events = manualCompactEvents({ args: 'unique-arg-token', outcomeText: 'distinctive-outcome-token' })
  const cold = new TranscriptFolder()
  cold.hydrate([...events])
  const live = new TranscriptFolder()
  live.apply([...events])
  const kindsCold = cold.messages().map(message => message.kind).join(',')
  const kindsLive = live.messages().map(message => message.kind).join(',')
  assert.equal(kindsCold, kindsLive)
  assert.equal(kindsCold, 'compaction')
  const searchCold = cold.search('unique-arg-token').map(match => `${match.id}:${match.source.kind}`).join('|')
  const searchLive = live.search('unique-arg-token').map(match => `${match.id}:${match.source.kind}`).join('|')
  assert.equal(searchCold, searchLive, 'cold and live search agree through the fused card')
})

test('A16: a leg-1 declaration owns immediately; a contradictory late leg 2 never re-decides', () => {
  const folder = new TranscriptFolder()
  // cpt-a's lifecycle DECLARES command cmd-1 (leg 1) — the ownership is
  // proven the moment the declaration lands, so the running command is
  // already fused into cpt-a. A later command/done whose sourceEventSeq
  // points at cpt-b's summary (contradictory leg 2) must neither move nor
  // revoke the established ownership — the fold never guesses a new winner.
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', source: { kind: 'user' } }, 0),
    rawEvent('compaction/start', { compactionId: 'cpt-a', sourceCommandId: CommandId('cmd-1'), turn: null }, 1),
    rawEvent('compaction/summary', { compactionId: 'cpt-a', summary: [{ type: 'text', text: 'a' }], shadowedSeqs: [0], shadowedTokenCount: 10 }, 2),
    rawEvent('compaction/end', { compactionId: 'cpt-a' }, 3),
    rawEvent('compaction/start', { compactionId: 'cpt-b', turn: null }, 4),
    rawEvent('compaction/summary', { compactionId: 'cpt-b', summary: [{ type: 'text', text: 'b' }], shadowedSeqs: [0], shadowedTokenCount: 10 }, 5),
    rawEvent('compaction/end', { compactionId: 'cpt-b' }, 6),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', sourceEventSeq: SessionSeq(5) }, 7),
  ])
  const messages = folder.messages()
  const owner = messages.filter(message => message.kind === 'compaction' && message.sourceCommand !== undefined)
  assert.equal(owner.length, 1, 'exactly cpt-a owns the command')
  assert.ok(owner[0]?.kind === 'compaction' && owner[0].sourceCommand?.commandId === CommandId('cmd-1'))
  assert.equal(commandRows(messages).length, 0, 'the command stays behind its established owner')
})

test('A14: the combined owner is established while the command is still RUNNING', () => {
  // The official manual /compact order: run → compaction events (carrying
  // sourceCommandId) → done. The declaration alone proves the relationship,
  // so the running period must show ONE combined card, never
  // `/compact [running]` plus `Compacting context…` side by side.
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', source: { kind: 'user' } }, 0),
    rawEvent('compaction/start', { compactionId: 'cpt-1', sourceCommandId: CommandId('cmd-1'), turn: null }, 1),
    rawEvent('compaction/summary', { compactionId: 'cpt-1', sourceCommandId: CommandId('cmd-1'), summary: [{ type: 'text', text: 'body' }], shadowedSeqs: [0], shadowedTokenCount: 10 }, 2),
  ])
  const messages = folder.messages()
  assert.deepEqual(kinds(messages), ['compaction'], 'one combined card while the command is still running')
  const compaction = messages[0]
  assert.ok(compaction !== undefined && compaction.kind === 'compaction')
  assert.ok(compaction.running === true)
  assert.ok(compaction.sourceCommand !== undefined && compaction.sourceCommand.outcome === null)
})

test('A14: settlement refreshes the combined owner search corpus', () => {
  // leg 1 fuses BEFORE settlement (outcome null); command/done then settles
  // the SAME object — the fused card's corpus must pick the outcome text up,
  // proving settlement refreshes the owner entry rather than skipping it.
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', args: 'unique-arg-token', source: { kind: 'user' } }, 0),
    rawEvent('compaction/start', { compactionId: 'cpt-1', sourceCommandId: CommandId('cmd-1'), turn: null }, 1),
    rawEvent('compaction/summary', { compactionId: 'cpt-1', sourceCommandId: CommandId('cmd-1'), summary: [{ type: 'text', text: 'body' }], shadowedSeqs: [0], shadowedTokenCount: 10 }, 2),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'distinctive-outcome-token' }, 3),
  ])
  const resolved = folder.resolveSearchMatch(folder.search('distinctive-outcome-token')[0]!)
  assert.ok(resolved !== undefined && resolved.kind === 'compaction',
    'the settled outcome is searchable through the combined owner')
})

test('A16: a failed manual command keeps its error in the combined owner', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', source: { kind: 'user' } }, 0),
    rawEvent('compaction/start', { compactionId: 'cpt-1', sourceCommandId: CommandId('cmd-1'), turn: null }, 1),
    rawEvent('compaction/end', { compactionId: 'cpt-1', error: 'summarizer failed' }, 2),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'error', text: 'compact failed: busy' }, 3),
  ])
  const messages = folder.messages()
  const compaction = messages.find(message => message.kind === 'compaction')
  assert.ok(compaction !== undefined && compaction.kind === 'compaction')
  assert.ok(compaction.sourceCommand !== undefined)
  assert.equal(compaction.sourceCommand?.outcome?.kind, 'error')
  assert.equal(compaction.sourceCommand?.outcome?.text, 'compact failed: busy',
    'the command error stays part of the combined presentation facts')
})

test('A06/Focus: an idle manual compaction keeps the real chronology outside the Thought', () => {
  // The fused manual compaction is a turn-less standalone boundary: the
  // collapsed Focus must keep `assistant final` → `Context compacted` in
  // their real order instead of lifting the card into the finished turn's
  // Thought and re-emitting the final after it.
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 7 }, 0),
    userMessage('go', 1, 7),
    assistantMessage('final answer', 2, 7),
    event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 3),
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', source: { kind: 'user' } }, 4),
    rawEvent('compaction/start', { compactionId: 'cpt-1', sourceCommandId: CommandId('cmd-1'), turn: null }, 5),
    rawEvent('compaction/summary', { compactionId: 'cpt-1', sourceCommandId: CommandId('cmd-1'), summary: [{ type: 'text', text: 'body' }], shadowedSeqs: [0], shadowedTokenCount: 10 }, 6),
    rawEvent('compaction/end', { compactionId: 'cpt-1' }, 7),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', sourceEventSeq: SessionSeq(6) }, 8),
  ])
  const messages = folder.messages()
  assert.deepEqual(kinds(messages), ['user', 'assistant', 'compaction'])
  const blocks = projectFocus(messages, folder.turnActivities(), new Set(), true)
  const shapes: string[] = []
  for (const block of blocks) {
    if (block.kind === 'message') shapes.push(block.message.kind)
    else if (block.kind === 'activity') shapes.push('<Thought>')
  }
  // The turn's own collapsed rendering (user → Thought with the final held
  // back → final) stays intact, and the manual compaction is a STANDALONE
  // block after the final — never absorbed into the Thought group and never
  // lifting the final after it.
  assert.deepEqual(shapes, ['user', '<Thought>', 'assistant', 'compaction'],
    `the collapsed Focus keeps the real chronology: ${JSON.stringify(shapes)}`)
})

test('A08: the non-monotonic defensive window keeps commands bounded by their anchor', () => {
  // A corrupt/replayed log (non-monotonic turns) takes the defensive slow
  // window path; turn-less commands there follow the SHARED placement
  // authority, so a small window must not drag every historical command in.
  // The replayed turn is carried by tool/call rows (their durable payload
  // keeps the log turn even after a regressed replay — user rows follow the
  // monotonic currentTurn fence by design).
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 8 }, 0),
    toolCall('read', 'call-8', 1, 8),
    toolResult('call-8', 'r8', 2),
    event('turn/end', { turn: 8, reason: { kind: 'completed' } }, 3),
    event('command/run', { commandId: CommandId('cmd-a'), name: 'export', args: 'token-a', source: { kind: 'user' } }, 4),
    event('command/done', { commandId: CommandId('cmd-a'), kind: 'success', text: 'done a' }, 5),
    event('turn/start', { turn: 3 }, 6),
    toolCall('read', 'call-3', 7, 3),
    toolResult('call-3', 'r3', 8),
    event('turn/end', { turn: 3, reason: { kind: 'completed' } }, 9),
    event('command/run', { commandId: CommandId('cmd-b'), name: 'export', args: 'token-b', source: { kind: 'user' } }, 10),
    event('command/done', { commandId: CommandId('cmd-b'), kind: 'success', text: 'done b' }, 11),
  ])
  const windowed = folder.window({ maxTurns: 1, endTurn: 8 })
  const windowedCommands = windowed.messages.filter(message => message.kind === 'command')
  assert.equal(windowedCommands.length, 1, `only the anchored command enters the window (got ${windowedCommands.length})`)
  assert.ok(windowedCommands[0]?.kind === 'command' && windowedCommands[0].args === 'token-a')
  const replayWindow = folder.window({ maxTurns: 1, endTurn: 3 })
  const replayCommands = replayWindow.messages.filter(message => message.kind === 'command')
  assert.equal(replayCommands.length, 1, 'the turn-3 window keeps only its own anchored command')
  assert.ok(replayCommands[0]?.kind === 'command' && replayCommands[0].args === 'token-b')
})

test('A16: a leg-2 hit on a card declaring a DIFFERENT command never fuses', () => {
  // Reverse-leg conflict: command A's sourceEventSeq points at compaction
  // B's summary, but B's own lifecycle metadata declares sourceCommandId =
  // cmd-OTHER. The card belongs to cmd-OTHER — fusing A into it would guess
  // a winner, so both rows stay standalone.
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-a'), name: 'export', source: { kind: 'user' } }, 0),
    rawEvent('compaction/start', { compactionId: 'cpt-b', sourceCommandId: CommandId('cmd-other'), turn: null }, 1),
    rawEvent('compaction/summary', { compactionId: 'cpt-b', sourceCommandId: CommandId('cmd-other'), summary: [{ type: 'text', text: 'body' }], shadowedSeqs: [0], shadowedTokenCount: 10 }, 2),
    rawEvent('compaction/end', { compactionId: 'cpt-b' }, 3),
    event('command/done', { commandId: CommandId('cmd-a'), kind: 'success', sourceEventSeq: SessionSeq(2) }, 4),
  ])
  const messages = folder.messages()
  const compaction = messages.find(message => message.kind === 'compaction')
  assert.ok(compaction !== undefined && compaction.kind === 'compaction')
  assert.equal(compaction.sourceCommand, undefined, 'the card never claims the contradicted command A')
  assert.equal(compaction.sourceCommandId, CommandId('cmd-other'), 'its own declaration is retained')
  assert.equal(commandRows(messages).length, 1, 'the command stays standalone with its relationship field')
  const command = commandRows(messages)[0]
  assert.equal(command?.outcome?.sourceEventSeq, SessionSeq(2))
})

test('A17: an unrelated sourceEventSeq keeps the command standalone while retaining the relationship', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'export', source: { kind: 'user' } }, 0),
    userMessage('some unrelated event', 1),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', text: 'exported', sourceEventSeq: SessionSeq(1) }, 2),
  ])
  const messages = folder.messages()
  const command = commandRows(messages)[0]
  assert.ok(command !== undefined)
  assert.equal(command.outcome?.sourceEventSeq, SessionSeq(1), 'the relationship is retained')
  assert.equal(messages.filter(message => message.kind === 'command').length, 1, 'the command stays standalone')
})

// ---------------------------------------------------------------------------
// B — descriptor disappearance
// ---------------------------------------------------------------------------

test('B01/B02: a subagent/descriptor materializes no TranscriptMessage regardless of placement', () => {
  const continuable = new TranscriptFolder()
  continuable.apply([
    descriptor(0, 'continuable'),
    event('turn/start', { turn: 0 }, 1),
    userMessage('child work', 2),
    assistantMessage('child answer', 3),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4),
  ])
  assert.deepEqual(kinds(continuable.messages()), ['user', 'assistant'])

  const oneShot = new TranscriptFolder()
  oneShot.apply([
    event('turn/start', { turn: 0 }, 0),
    descriptor(1, 'one-shot'),
    userMessage('child work', 2),
    assistantMessage('child answer', 3),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4),
  ])
  assert.deepEqual(kinds(oneShot.messages()), ['user', 'assistant'])
})

test('B03: a descriptor-only child log produces no transcript card', () => {
  const folder = new TranscriptFolder()
  folder.apply([descriptor(0)])
  assert.deepEqual(folder.messages(), [])
})

test('B05: the parent genuine subagent tool/call remains an ordinary Tool', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    userMessage('delegate', 1),
    toolCall('subagent', 'call-sub', 2, 0, 0, JSON.stringify({ prompt: 'do work' })),
    toolResult('call-sub', 'child finished', 3),
    assistantMessage('done', 4),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 5),
  ])
  const messages = folder.messages()
  const tools = messages.filter(message => message.kind === 'tool')
  assert.equal(tools.length, 1)
  const tool = tools[0]
  assert.ok(tool !== undefined && tool.kind === 'tool')
  assert.equal(tool.name, 'subagent')
  assert.equal(tool.origin, undefined, 'the genuine delegation stays a model tool, not a synthetic row')
})

test('B06: a descriptor never inflates old-window tool counts', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    descriptor(1, 'continuable', 'old child'),
    toolCall('read', 'call-old', 2),
    toolResult('call-old', 'old', 3),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4),
    event('turn/start', { turn: 1 }, 5),
    userMessage('new', 6),
    assistantMessage('latest', 7),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 8),
  ])
  const window = folder.window({ maxTurns: 1 })
  const summary = window.messages.find(message => message.kind === 'summary')
  assert.ok(summary !== undefined && summary.kind === 'summary')
  assert.ok(summary.text.includes('1 tool call'), summary.text)
  assert.ok(!summary.text.includes('2 tool calls'), summary.text)
})

test('B07: descriptor fields are not searchable as human transcript rows', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 0 }, 0),
    descriptor(1, 'continuable', 'secret child label'),
    userMessage('real prompt', 2),
    assistantMessage('answer', 3),
    event('turn/end', { turn: 0, reason: { kind: 'completed' } }, 4),
  ])
  assert.deepEqual(folder.search('continuable'), [])
  assert.deepEqual(folder.search('secret'), [])
  assert.deepEqual(folder.search('deepseek-chat'), [])
  assert.equal(folder.search('real prompt').length, 1)
})

test('A09/A15: a fused pre-turn manual compaction inherits the command placement anchor', () => {
  // The visible/searchable representative of a manual /compact is the
  // compaction card; when the whole lifecycle precedes the first model turn
  // the card must inherit the command's re-anchored placement (the legacy
  // fold-time currentTurn is 0 there and would send an anchored search to
  // the wrong window).
  const folder = new TranscriptFolder()
  folder.apply([
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', args: 'unique-pretoken', source: { kind: 'user' } }, 0),
    rawEvent('compaction/start', { compactionId: 'cpt-1', sourceCommandId: CommandId('cmd-1'), turn: null }, 1),
    rawEvent('compaction/summary', { compactionId: 'cpt-1', sourceCommandId: CommandId('cmd-1'), summary: [{ type: 'text', text: 'body' }], shadowedSeqs: [0], shadowedTokenCount: 10 }, 2),
    rawEvent('compaction/end', { compactionId: 'cpt-1' }, 3),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', sourceEventSeq: SessionSeq(2) }, 4),
    event('turn/start', { turn: 7 }, 5),
    userMessage('later prompt', 6, 7),
    event('turn/end', { turn: 7, reason: { kind: 'completed' } }, 7),
  ])
  const matches = folder.search('unique-pretoken')
  assert.ok(matches.length >= 1, 'the command args are searchable through the card')
  assert.equal(matches[0]!.turn, 7, `the fused card anchors to the first turn (got ${matches[0]!.turn})`)
  const window = folder.window({ maxTurns: 1, endTurn: matches[0]!.turn })
  assert.ok(window.messages.some(message => message.kind === 'compaction'),
    'the anchored window reveals the pre-turn manual-compaction card')
})

test('A08/A15: a fused manual compaction in a replayed era follows the command anchor', () => {
  // Non-monotonic replay: the compaction card's fold-time turn follows the
  // monotonic currentTurn fence (8), but the command physically settles in
  // the replayed turn-3 era (anchor 3). The combined owner must follow the
  // COMMAND anchor so the slow window keeps it with its own era.
  const folder = new TranscriptFolder()
  folder.apply([
    event('turn/start', { turn: 8 }, 0),
    toolCall('read', 'call-8', 1, 8),
    toolResult('call-8', 'r8', 2),
    event('turn/end', { turn: 8, reason: { kind: 'completed' } }, 3),
    event('turn/start', { turn: 3 }, 4),
    toolCall('read', 'call-3', 5, 3),
    toolResult('call-3', 'r3', 6),
    event('turn/end', { turn: 3, reason: { kind: 'completed' } }, 7),
    event('command/run', { commandId: CommandId('cmd-1'), name: 'compact', args: 'unique-replaytoken', source: { kind: 'user' } }, 8),
    rawEvent('compaction/start', { compactionId: 'cpt-1', sourceCommandId: CommandId('cmd-1'), turn: null }, 9),
    rawEvent('compaction/summary', { compactionId: 'cpt-1', sourceCommandId: CommandId('cmd-1'), summary: [{ type: 'text', text: 'body' }], shadowedSeqs: [0], shadowedTokenCount: 10 }, 10),
    rawEvent('compaction/end', { compactionId: 'cpt-1' }, 11),
    event('command/done', { commandId: CommandId('cmd-1'), kind: 'success', sourceEventSeq: SessionSeq(10) }, 12),
  ])
  const matches = folder.search('unique-replaytoken')
  assert.ok(matches.length >= 1)
  assert.equal(matches[0]!.turn, 3, `the fused card anchors to the replayed era (got ${matches[0]!.turn})`)
  const eraWindow = folder.window({ maxTurns: 1, endTurn: 3 })
  assert.ok(eraWindow.messages.some(message => message.kind === 'compaction'),
    'the turn-3 window keeps the fused manual compaction of its era')
  const laterWindow = folder.window({ maxTurns: 1, endTurn: 8 })
  assert.ok(!laterWindow.messages.some(message => message.kind === 'compaction'),
    'the turn-8 window does not drag the replayed-era manual compaction in')
})
