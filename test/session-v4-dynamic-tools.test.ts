/**
 * rc.2 Session V4 dynamic-tool tolerance and long-output / long-session
 * regressions (implementation plan §9–§10).
 *
 * rc.2 records `developer/message` events carrying `tool-addition` /
 * `tool-removal` blocks emitted by the Agent loop's tool-registry changes.
 * `Session.toolHistory()` owns their model-facing fold; the TUI must simply
 * tolerate them: the transcript fold, the Full/Focus/Compact projections,
 * Ctrl+F search, readable export, rewind candidates and fork identity all stay
 * healthy, and no fake user/assistant/tool row is invented.
 *
 * @module @xmoon76/dsh-pi-tui/session-v4-dynamic-tools.test
 */

import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { visibleWidth } from '@xmoon76/pi-tui'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  MessageId,
  ToolCallId,
  createDeveloperMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  type ContentBlock,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { projectCompact } from '../src/compact-projection.ts'
import { projectFocus } from '../src/focus-activity.ts'
import { resultTextLines, writeFoldedPreview } from '../src/present.ts'
import { collectRewindCandidates } from '../src/rewind.ts'
import {
  renderTranscriptMarkdown,
  transcriptSearchText,
  TranscriptFolder,
  type TranscriptMessage,
} from '../src/transcript.ts'
import { projectTranscriptStructure } from '../src/transcript-projection.ts'
import { TuiApp, transcriptContentWidth } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Every TuiApp started here must be stopped: the vendored keybindings hold
 *  one process-global live-surface slot. */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

function event(type: string, data: Record<string, unknown>, seq: number, surfaceOp?: 'append'): SessionEvent {
  return {
    type,
    seq: SessionSeq(seq),
    time: 1000 + seq,
    ...surfaceOp === undefined ? {} : { surfaceOp },
    data,
  } as unknown as SessionEvent
}

function header(tools: readonly string[], seq: number): SessionEvent {
  return event('request/header', {
    header: {
      config: { provider: 'p', model: 'm' },
      tools: tools.map(name => ({ name, description: `${name} tool`, parameters: {} })),
    },
    reason: 'change',
  }, seq)
}

/** One official-shape `developer/message` tool update (the Agent loop's own
 *  `createDeveloperMessage({ source: { kind: 'tool-registry' }, content })`). */
function developerUpdate(
  seq: number,
  blocks: readonly ({ type: 'tool-addition'; toolName: string } | { type: 'tool-removal'; toolName: string })[],
  headerSeq?: number,
  turn = 0,
): SessionEvent {
  return event('developer/message', {
    turn,
    step: 0,
    message: createDeveloperMessage({ source: { kind: 'tool-registry' } as never, content: blocks as never }),
    ...headerSeq === undefined ? {} : { headerSeq: SessionSeq(headerSeq) },
  }, seq, 'append')
}

function userMessage(seq: number, value: string): SessionEvent {
  return event('user/message', {
    id: MessageId(`u-${seq}`),
    role: 'user',
    content: [text(value)],
    source: { kind: 'user' },
  }, seq, 'append')
}

function toolCall(seq: number, callId: string, name: string): SessionEvent {
  return event('tool/call', { turn: 0, step: 0, callId: ToolCallId(callId), name, arguments: '{}' }, seq)
}

function toolResult(seq: number, callId: string, value: string): SessionEvent {
  return event('tool/result', {
    turn: 0,
    step: 0,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [text(value)], isError: false }),
  }, seq, 'append')
}

function turnStart(seq: number, turn: number): SessionEvent {
  return event('turn/start', { turn }, seq)
}

function turnEnd(seq: number, turn: number): SessionEvent {
  return event('turn/end', { turn, reason: { kind: 'completed' } }, seq)
}

/** One rc.2 session body with an addition and a removal in an already-live
 *  session (the request/header + developer/message ordering the Agent loop
 *  actually appends). */
function dynamicToolEvents(): SessionEvent[] {
  return [
    turnStart(0, 0),
    userMessage(1, 'first question'),
    header(['read'], 2),
    toolCall(3, 'c1', 'read'),
    toolResult(4, 'c1', 'read ok'),
    header(['read', 'rc2_live_tool_probe'], 5),
    developerUpdate(6, [{ type: 'tool-addition', toolName: 'rc2_live_tool_probe' }], 5),
    toolCall(7, 'c2', 'rc2_live_tool_probe'),
    toolResult(8, 'c2', 'probe ok'),
    turnEnd(9, 0),
    turnStart(10, 1),
    userMessage(11, 'second question'),
    header(['read'], 12),
    developerUpdate(13, [{ type: 'tool-removal', toolName: 'rc2_live_tool_probe' }], undefined, 1),
    turnEnd(14, 1),
  ]
}

function fold(events: readonly SessionEvent[]): { folder: TranscriptFolder; messages: TranscriptMessage[] } {
  const folder = new TranscriptFolder()
  folder.apply(events)
  return { folder, messages: folder.messages() }
}

const FOLDER_OPTIONS = {
  expandedWorkOwners: new Set<TranscriptMessage>(),
  expandedClusters: new Set<TranscriptMessage>(),
  forcedExpanded: new Set<TranscriptMessage>(),
}

test('a V4 Session with developer tool updates folds without a fake row and keeps chronology', () => {
  const { messages } = fold(dynamicToolEvents())
  // The two human prompts and the two tool cards survive; the developer
  // updates contribute no user/assistant/tool/system row.
  assert.deepEqual(messages.map(message => message.kind), ['user', 'tool', 'tool', 'user'])
  const toolNames = messages.filter(message => message.kind === 'tool').map(message => (message as { name: string }).name)
  assert.deepEqual(toolNames, ['read', 'rc2_live_tool_probe'])
  for (const message of messages) {
    const searchable = transcriptSearchText(message)
    assert.ok(!searchable.includes('tool-addition'), 'a tool-addition block must never become model-visible transcript text')
    assert.ok(!searchable.includes('tool-removal'), 'a tool-removal block must never become model-visible transcript text')
  }
})

test('cold re-read of the same V4 log is stable (idempotent fold)', () => {
  const first = fold(dynamicToolEvents()).messages
  const second = fold(dynamicToolEvents()).messages
  assert.deepEqual(
    second.map(message => ({ kind: message.kind, ...('text' in message ? { text: message.text } : {}) })),
    first.map(message => ({ kind: message.kind, ...('text' in message ? { text: message.text } : {}) })),
  )
})

test('the Full structural projection partitions the dynamic-tool transcript exactly', () => {
  const { messages } = fold(dynamicToolEvents())
  const blocks = projectTranscriptStructure(messages)
  const seen: TranscriptMessage[] = []
  for (const block of blocks) {
    if (block.kind === 'message') seen.push(block.message)
    else if (block.kind === 'work') seen.push(...block.span.members)
    else seen.push(...block.cluster.members)
  }
  assert.equal(seen.length, messages.length, 'every folded row appears exactly once')
  for (const message of messages) assert.ok(seen.includes(message))
})

test('the Focus and Compact projections render the dynamic-tool transcript without throwing or inventing rows', () => {
  const { folder, messages } = fold(dynamicToolEvents())
  const focus = projectFocus(messages, folder.turnActivities(), new Set([0, 1]), true)
  assert.ok(focus.length > 0, 'Focus produces a projection')
  const compact = projectCompact(messages, FOLDER_OPTIONS)
  assert.ok(compact.length > 0, 'Compact produces a projection')
  // Neither projection can synthesize a message the fold never produced.
  const projectedMessages = new Set<TranscriptMessage>()
  for (const block of compact) {
    if (block.kind === 'message') projectedMessages.add(block.message)
    else if (block.kind === 'work') for (const member of block.span.members) projectedMessages.add(member)
    else for (const member of block.cluster.members) projectedMessages.add(member)
  }
  for (const message of projectedMessages) assert.ok(messages.includes(message))
})

test('Ctrl+F search stays stable over the dynamic-tool transcript and matches ordinary content', () => {
  const { messages } = fold(dynamicToolEvents())
  const searchable = messages.map(message => transcriptSearchText(message)).join('\n')
  assert.ok(searchable.includes('first question'))
  assert.ok(searchable.includes('read ok'))
  assert.ok(searchable.includes('probe ok'))
  assert.ok(searchable.includes('second question'))
  assert.ok(!searchable.includes('rc2_live_tool_probe tool'), 'no tool-addition declaration leaks into search')
})

test('the readable transcript export stays stable over dynamic-tool events', () => {
  const events = dynamicToolEvents()
  const markdown = renderTranscriptMarkdown({
    header: { id: 'session-v4-dynamic-tools', cwd: '/ws', version: 4, createdAt: 0, isSeeded: false, delegationDepth: 0 },
    snapshotEvents: () => events,
  } as never)
  assert.ok(markdown.includes('first question'))
  assert.ok(markdown.includes('probe ok'))
  assert.ok(markdown.includes('second question'))
  assert.ok(!markdown.includes('tool-addition'))
  assert.ok(!markdown.includes('tool-removal'))
})

test('rewind candidates ignore developer tool updates and keep the human-turn boundaries', () => {
  const candidates = collectRewindCandidates(dynamicToolEvents())
  // The first human turn has no completed predecessor (official fork omission
  // means "latest boundary", not an empty prefix), so only turn 1 is
  // rewindable — and the developer tool updates neither add nor break it.
  assert.deepEqual(candidates.map(candidate => candidate.editorText), ['second question'])
  assert.equal(candidates[0]!.turn, 1)
})

test('a long V4 session folds and still accepts the next ordinary prompt', () => {
  const events: SessionEvent[] = []
  let seq = 0
  for (let turn = 0; turn < 300; turn += 1) {
    events.push(turnStart(seq++, turn))
    events.push(userMessage(seq++, `question ${turn}`))
    events.push(header(['read'], seq++))
    events.push(toolCall(seq++, `c${turn}`, 'read'))
    events.push(toolResult(seq++, `c${turn}`, `answer ${turn}`))
    events.push(turnEnd(seq++, turn))
  }
  const folder = new TranscriptFolder()
  folder.apply(events)
  const before = folder.messages()
  assert.equal(before.length, 300 * 2, 'each turn folds one user row and one tool card')
  // The next ordinary prompt is admitted into the same fold — no history scan
  // refuses or drops it (the Host, not transcript state, owns admission).
  folder.apply([
    turnStart(seq++, 300),
    userMessage(seq++, 'the next prompt'),
  ])
  const after = folder.messages()
  assert.equal(after.length, before.length + 1)
  const tail = after.at(-1)
  assert.equal(tail?.kind, 'user')
  if (tail?.kind === 'user') assert.equal(tail.text, 'the next prompt')
})

test('a very long multibyte tool result survives fold, search and export without malformed characters', () => {
  const ascii = 'A'.repeat(20_000)
  const cjk = '汉字测试'.repeat(2_000)
  const emoji = '🙂🚀✨'.repeat(500)
  const value = `${ascii}\n${cjk}\n${emoji}\nend`
  const events: SessionEvent[] = [
    turnStart(0, 0),
    userMessage(1, 'run it'),
    header(['read'], 2),
    toolCall(3, 'c1', 'read'),
    toolResult(4, 'c1', value),
    turnEnd(5, 0),
  ]
  const { folder, messages } = fold(events)
  const card = messages.find(message => message.kind === 'tool')
  assert.ok(card !== undefined && card.kind === 'tool')
  assert.equal(card.result, value, 'the folded result preserves every multibyte boundary exactly')
  assert.ok(!card.result.includes('\uFFFD'), 'no replacement character is introduced by folding')
  // The real projection paths consume the same card without throwing.
  assert.doesNotThrow(() => projectCompact(messages, FOLDER_OPTIONS))
  assert.doesNotThrow(() => projectFocus(messages, folder.turnActivities(), new Set([0]), true))
  // Expanded card content stays intact (the generic folded raw preview is a
  // render-time truncation in tui-app, not a pure seam — it is exercised by
  // the app rendering tests; this file proves the folded source bytes).
  const expanded = resultTextLines(card.resultBlocks ?? [])
  assert.ok(expanded.some(line => line.includes('汉字测试')), 'the expanded card keeps CJK')
  assert.ok(expanded.some(line => line.includes('🙂🚀✨')), 'the expanded card keeps emoji')
  assert.ok(expanded.every(line => !line.includes('\uFFFD')), 'no expanded line gains a replacement character')
  // Search and export read the same bytes without corruption.
  assert.ok(transcriptSearchText(card).includes('end'))
  const markdown = renderTranscriptMarkdown({
    header: { id: 'session-v4-long-utf8', cwd: '/ws', version: 4, createdAt: 0, isSeeded: false, delegationDepth: 0 },
    snapshotEvents: () => events,
  } as never)
  assert.ok(markdown.includes('汉字测试'), 'the export keeps CJK intact')
  assert.ok(markdown.includes('🙂🚀✨'), 'the export keeps emoji intact')
  assert.ok(!markdown.includes('\uFFFD'), 'the export introduces no replacement character')
  // A subsequent ordinary prompt still folds onto the same transcript.
  const after = new TranscriptFolder()
  after.apply([...events, turnStart(6, 1), userMessage(7, 'the next prompt')])
  const tail = after.messages().at(-1)
  assert.equal(tail?.kind, 'user')
  if (tail?.kind === 'user') assert.equal(tail.text, 'the next prompt')
})

test('a folded write card preview reads the envelope verb from a very long multibyte result, never the body', () => {
  const body = '汉字🙂'.repeat(5_000)
  const envelope = `<path>src/长文件名.ts</path><type>file</type><content>Created file</content>${body}`
  const preview = writeFoldedPreview(envelope)
  assert.equal(preview, ' — Created', 'the write card preview reads the envelope verb')
  assert.ok(preview.length < envelope.length, 'the preview never dumps the long body')
  assert.ok(!preview.includes('\uFFFD') && !preview.includes('汉字'), 'the preview never leaks the body bytes')
  // A raw (non-envelope) result yields no folded preview at all — the generic
  // raw-preview truncation is a render-time concern, not this pure seam.
  assert.equal(writeFoldedPreview(body), '')
})

test('a folded generic tool-result preview stays width-bounded on a long multibyte result', async () => {
  // The generic raw preview is the render-time `preview()` + `truncateToWidth()`
  // path in tui-app (RESULT_PREVIEW_LINES). Render one real folded card to prove
  // the truncation boundary never splits a CJK/emoji grapheme or dumps the body.
  const width = 60
  const vt = new VirtualTerminal(width, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const body = '汉字🙂'.repeat(4_000)
  app.setTranscript([
    { kind: 'tool', turn: 0, name: 'grep', args: JSON.stringify({ pattern: 'x' }), result: body, status: 'ok' },
  ])
  await vt.waitForRender()
  const lines = vt.getViewport()
  const joined = lines.join('\n')
  assert.ok(!joined.includes('\uFFFD'), 'no folded row gains a replacement character')
  assert.ok(!joined.includes(body), 'the collapsed card never dumps the full result')
  const previewRows = lines.filter(line => line.includes('汉字'))
  assert.ok(previewRows.length > 0, 'the collapsed card shows a valid multibyte prefix')
  for (const line of previewRows) {
    assert.ok(visibleWidth(line) <= transcriptContentWidth(width),
      `a folded multibyte preview row exceeds the transcript content width: ${JSON.stringify(line)}`)
  }
  app.stop()
})

/** A recording adapter answering every request with one text response. */
class TextAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'ok' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

test('a real long Agent/Session admits the next ordinary prompt and the TUI folds it', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new TextAdapter()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('long-admission'), { provider: 'mock', model: 'model' })

    // Build a genuinely long history through the REAL loop (not a hand-built fold).
    for (let turn = 0; turn < 60; turn += 1) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: `turn ${turn}` }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    assert.equal(adapter.requests.length, 60, 'every prior prompt was admitted')

    // The next ordinary prompt is admitted and processed on the SAME Session.
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'the next prompt' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    assert.equal(adapter.requests.length, 61, 'the next ordinary prompt was admitted and processed')
    assert.equal(agent.session.id, 'long-admission', 'the Session identity never changed')

    // The TUI fold of that real long history ends on the newly admitted prompt.
    const folder = new TranscriptFolder()
    folder.apply(agent.session.snapshotEvents())
    const lastUser = folder.messages().filter(message => message.kind === 'user').at(-1)
    assert.equal(lastUser?.kind, 'user')
    if (lastUser?.kind === 'user') assert.equal(lastUser.text, 'the next prompt')
  } finally {
    await ctx.fiber.dispose()
  }
})
