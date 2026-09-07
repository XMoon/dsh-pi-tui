/** Regression coverage for live-only streaming tool-call preparing rows. */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  PREPARING_SCAN_MAX_CHARS,
  clearStreamingToolPreviewsForStep,
  clearStreamingToolPreviewsForTurn,
  extractPartialStringField,
  removeStreamingToolPreview,
  streamingToolPreviewSnapshot,
  upsertStreamingToolPreview,
} from '../src/streaming-tool-preparing.ts'
import { toolIconSemantic, toolSummaryKeys, toolTitle } from '../src/present.ts'
import { TuiApp, type StreamingToolPreview } from '../src/tui-app.ts'
import type { TranscriptMessage, TurnActivity } from '../src/transcript.ts'
import type { AssistantLiveChunk, AssistantLiveInput } from '../src/runtime/assistant-stream-port.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function event<K extends string>(
  type: K,
  data: (K extends SessionEvent['type'] ? SessionEvent<K>['data'] : Record<string, unknown>) & Record<string, unknown>,
  seq: number,
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq * 1000, data } as SessionEvent
}

/** One Session v2 live chunk input (the transient plane replaces durable
 * `assistant/chunk` events). */
function liveChunk(
  turn: number,
  step: number,
  chunk: AssistantLiveChunk,
  time = 1_700_000_000_000,
): AssistantLiveInput {
  return { kind: 'chunk', sessionId: 'test', attemptId: 'attempt-1', turn, step, time, chunk }
}

/** One streamed tool-call delta as a live input (Session v2). */
function delta(
  turn: number,
  step: number,
  index: number,
  id: string,
  argumentsDelta: string,
  name?: string,
): AssistantLiveInput {
  return liveChunk(turn, step, {
    type: 'tool-call-delta',
    index,
    id,
    argumentsDelta,
    ...(name === undefined ? {} : { name }),
  }, 1_700_000_000_000 + turn * 100 + step * 10 + index)
}

/** Apply one live assistant stream input to the previews (mirrors the
 * runner's `applyStreamingToolPreviewInput`: streamed tool-call deltas and
 * block-ends UPSERT previews). */
function applyPreviewInput(previews: Map<string, StreamingToolPreview>, input: AssistantLiveInput): void {
  if (input.kind !== 'chunk') return
  const chunk = input.chunk
  if (chunk.type === 'tool-call-delta') {
    upsertStreamingToolPreview(previews, {
      callId: chunk.id,
      turn: input.turn,
      step: input.step,
      index: chunk.index,
      name: chunk.name,
      argumentsDelta: chunk.argumentsDelta,
    })
    return
  }
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
    upsertStreamingToolPreview(previews, {
      callId: chunk.block.id ?? '',
      turn: input.turn,
      step: input.step,
      index: chunk.index,
      name: chunk.block.name,
    })
  }
}

/** Apply one durable session event to the previews (mirrors the runner's
 * `applyStreamingToolPreviewEvent`: only CLEARS — settled calls, retries,
 * step/turn boundaries). */
function applyPreviewEvent(previews: Map<string, StreamingToolPreview>, event: SessionEvent): void {
  if (event.type === 'tool/call') {
    removeStreamingToolPreview(previews, event.data.callId, event.data.turn, event.data.step)
    return
  }
  if (event.type === 'llm/retry' || event.type === 'llm/retry-started' || event.type === 'step/end') {
    clearStreamingToolPreviewsForStep(previews, event.data.turn, event.data.step)
    return
  }
  if (event.type === 'turn/end') clearStreamingToolPreviewsForTurn(previews, event.data.turn)
}

function click(vt: VirtualTerminal, x: number, y: number): void {
  vt.sendInput(`\x1b[<0;${x};${y}M`)
  vt.sendInput(`\x1b[<0;${x};${y}m`)
}

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of startedApps) {
    startedApps.delete(app)
    if (!app.isDisposed()) app.dispose()
  }
})

test('tracks one preview per call, preserves delayed names, and sorts by index', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewInput(previews, delta(1, 0, 1, 'call-b', '{"path"', 'write'))
  applyPreviewInput(previews, delta(1, 0, 0, 'call-a', '{"path"'))
  applyPreviewInput(previews, delta(1, 0, 1, 'call-b', ':"x"}'))

  assert.deepEqual(streamingToolPreviewSnapshot(previews).map(preview => ({
    callId: preview.callId,
    turn: preview.turn,
    step: preview.step,
    index: preview.index,
    name: preview.name,
  })), [
    { callId: 'call-a', turn: 1, step: 0, index: 0, name: undefined },
    { callId: 'call-b', turn: 1, step: 0, index: 1, name: 'write' },
  ])
  assert.deepEqual(Object.keys(previews.get('call-b' as ToolCallId)!), [
    'callId', 'turn', 'step', 'index', 'name', 'argumentBytes', 'summary',
  ])
})

test('extracts only complete JSON string fields and decodes escapes', () => {
  const encoded = JSON.stringify({ command: 'printf "hello"' })
  assert.equal(extractPartialStringField('{"command":"printf', ['command']), undefined)
  assert.equal(extractPartialStringField(encoded, ['command']), 'printf "hello"')
  assert.equal(extractPartialStringField('{"command":42}', ['command']), undefined)
})

test('preparing summary extraction uses formal keys as best available at extraction time', () => {
  // The shared order defines preference only among fields complete when the
  // partial scan runs; it is not a promise of final-card re-selection.
  assert.deepEqual(toolSummaryKeys('bash'), ['description', 'command'])
  assert.deepEqual(toolSummaryKeys('pwsh'), ['description', 'command'])
  assert.deepEqual(toolSummaryKeys('read'), ['path', 'file_path', 'url'])
  assert.deepEqual(toolSummaryKeys('web_search'), ['query', 'pattern', 'url'])
  assert.deepEqual(toolSummaryKeys('grep'), ['query', 'pattern', 'url'])
  assert.deepEqual(toolSummaryKeys('write'), ['path', 'file_path'])
  assert.deepEqual(toolSummaryKeys('edit'), ['path', 'file_path'])
})

test('accumulates exact UTF-8 argument bytes across deltas', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewInput(previews, delta(5, 0, 0, 'bytes', 'abc', 'edit'))
  applyPreviewInput(previews, delta(5, 0, 0, 'bytes', '你好'))
  assert.equal(previews.get('bytes')?.argumentBytes, Buffer.byteLength('abc你好', 'utf8'))
  assert.equal(previews.get('bytes')?.summary, undefined)
})

test('extracts a summary only after a JSON string value closes across chunks', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewInput(previews, delta(6, 0, 0, 'path', '{"pa', 'edit'))
  assert.equal(previews.get('path')?.summary, undefined)
  applyPreviewInput(previews, delta(6, 0, 0, 'path', 'th":"src/foo.ts"}'))
  assert.equal(previews.get('path')?.summary, 'src/foo.ts')
  assert.equal(previews.get('path')?.scanPrefix, undefined)
})

test('delayed names extract from the existing bounded prefix', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewInput(previews, delta(7, 0, 0, 'delayed', '{"path":"src/foo.ts"}'))
  assert.equal(previews.get('delayed')?.summary, undefined)
  applyPreviewInput(previews, delta(7, 0, 0, 'delayed', '', 'edit'))
  assert.equal(previews.get('delayed')?.summary, 'src/foo.ts')
  assert.equal(previews.get('delayed')?.argumentBytes, Buffer.byteLength('{"path":"src/foo.ts"}', 'utf8'))
})

test('delayed names retain a capped prefix for final extraction', () => {
  const previews = new Map<string, StreamingToolPreview>()
  const path = '{"path":"src/foo.ts"}'
  const first = path + 'x'.repeat(PREPARING_SCAN_MAX_CHARS - path.length)
  applyPreviewInput(previews, delta(12, 0, 0, 'delayed-cap', first))
  assert.equal(previews.get('delayed-cap')?.summary, undefined)
  assert.equal(previews.get('delayed-cap')?.scanPrefix, first)

  applyPreviewInput(previews, delta(12, 0, 0, 'delayed-cap', '', 'edit'))
  assert.equal(previews.get('delayed-cap')?.summary, 'src/foo.ts')
  assert.equal(previews.get('delayed-cap')?.scanPrefix, undefined)
  assert.equal(previews.get('delayed-cap')?.argumentBytes, Buffer.byteLength(first, 'utf8'))
})

test('empty-to-real call ids preserve bytes and summary', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewInput(previews, delta(8, 0, 0, '', '{"path":"src/foo.ts"}', 'edit'))
  applyPreviewInput(previews, delta(8, 0, 0, 'real-edit', '', 'edit'))
  assert.deepEqual(streamingToolPreviewSnapshot(previews).map(preview => ({
    callId: preview.callId,
    argumentBytes: preview.argumentBytes,
    summary: preview.summary,
  })), [{
    callId: 'real-edit',
    argumentBytes: Buffer.byteLength('{"path":"src/foo.ts"}', 'utf8'),
    summary: 'src/foo.ts',
  }])
})

test('bounded scans release the prefix but continue counting bytes', () => {
  const previews = new Map<string, StreamingToolPreview>()
  const first = 'x'.repeat(PREPARING_SCAN_MAX_CHARS)
  applyPreviewInput(previews, delta(9, 0, 0, 'capped', first, 'edit'))
  assert.equal(previews.get('capped')?.argumentBytes, Buffer.byteLength(first, 'utf8'))
  assert.equal(previews.get('capped')?.scanPrefix, undefined)
  applyPreviewInput(previews, delta(9, 0, 0, 'capped', '{"path":"late"}'))
  assert.equal(previews.get('capped')?.summary, undefined)
  assert.equal(previews.get('capped')?.argumentBytes, Buffer.byteLength(first + '{"path":"late"}', 'utf8'))
})

test('one oversized delta cannot reveal a field beyond the scan cap', () => {
  const previews = new Map<string, StreamingToolPreview>()
  const overCap = 'x'.repeat(PREPARING_SCAN_MAX_CHARS + 10) + '{"path":"late"}'
  applyPreviewInput(previews, delta(9, 0, 0, 'oversized', overCap, 'edit'))
  const preview = previews.get('oversized')!
  assert.equal(preview.summary, undefined)
  assert.equal(preview.scanPrefix, undefined)
  assert.equal(preview.argumentBytes, Buffer.byteLength(overCap, 'utf8'))
})

test('summary success releases the prefix before large later arguments', () => {
  const previews = new Map<string, StreamingToolPreview>()
  const path = '{"path":"src/foo.ts"}'
  const content = 'x'.repeat(PREPARING_SCAN_MAX_CHARS * 2)
  applyPreviewInput(previews, delta(10, 0, 0, 'released', path, 'write'))
  applyPreviewInput(previews, delta(10, 0, 0, 'released', content))
  const preview = previews.get('released')!
  assert.equal(preview.summary, 'src/foo.ts')
  assert.equal(preview.scanPrefix, undefined)
  assert.equal(preview.argumentBytes, Buffer.byteLength(path + content, 'utf8'))
})

test('parallel previews keep independent bytes and summaries', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewInput(previews, delta(11, 0, 1, 'write', '{"path":"src/b.ts"}', 'write'))
  applyPreviewInput(previews, delta(11, 0, 0, 'edit', '{"path":"src/a.ts"}', 'edit'))
  applyPreviewInput(previews, delta(11, 0, 0, 'edit', 'x'.repeat(10)))
  assert.deepEqual(streamingToolPreviewSnapshot(previews).map(preview => ({
    callId: preview.callId,
    index: preview.index,
    summary: preview.summary,
    argumentBytes: preview.argumentBytes,
  })), [
    { callId: 'edit', index: 0, summary: 'src/a.ts', argumentBytes: Buffer.byteLength('{"path":"src/a.ts"}' + 'x'.repeat(10), 'utf8') },
    { callId: 'write', index: 1, summary: 'src/b.ts', argumentBytes: Buffer.byteLength('{"path":"src/b.ts"}', 'utf8') },
  ])
})

test('empty ids use the stable chunk position and migrate to a later call id', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewInput(previews, delta(2, 0, 1, '', '{}', 'write'))
  applyPreviewInput(previews, delta(2, 0, 0, '', '{}', 'edit'))

  assert.deepEqual(streamingToolPreviewSnapshot(previews).map(preview => ({
    callId: preview.callId,
    index: preview.index,
    name: preview.name,
  })), [
    { callId: '', index: 0, name: 'edit' },
    { callId: '', index: 1, name: 'write' },
  ])

  applyPreviewInput(previews, delta(2, 0, 0, 'real-edit', '{}'))
  applyPreviewEvent(previews, event('tool/call', {
    turn: 2,
    step: 0,
    callId: 'real-edit' as ToolCallId,
    name: 'edit',
    arguments: '{}',
  }, 20))
  assert.deepEqual(streamingToolPreviewSnapshot(previews).map(preview => preview.callId), [''])

  applyPreviewEvent(previews, event('tool/call', {
    turn: 2,
    step: 0,
    callId: '' as ToolCallId,
    name: 'write',
    arguments: '{}',
  }, 21))
  assert.deepEqual(streamingToolPreviewSnapshot(previews), [])
})

test('empty-id deltas migrate to the authoritative block-end id before materialization', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewInput(previews, delta(3, 0, 0, '', '{', 'edit'))
  applyPreviewInput(previews, liveChunk(3, 0, {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'real-edit' as ToolCallId, name: 'edit' },
  }, 1_700_000_000_301))
  assert.deepEqual(streamingToolPreviewSnapshot(previews).map(preview => preview.callId), ['real-edit'])

  applyPreviewEvent(previews, event('tool/call', {
    turn: 3,
    step: 0,
    callId: 'real-edit' as ToolCallId,
    name: 'edit',
    arguments: '{}',
  }, 302))
  assert.deepEqual(streamingToolPreviewSnapshot(previews), [])
})

test('block-end materialization removes one empty-id preview without dropping its parallel peer', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewInput(previews, delta(4, 0, 0, '', '{', 'edit'))
  applyPreviewInput(previews, delta(4, 0, 1, '', '{', 'write'))
  applyPreviewInput(previews, liveChunk(4, 0, {
    type: 'block-end',
    index: 0,
    block: { type: 'tool-call', id: 'real-edit' as ToolCallId, name: 'edit' },
  }, 1_700_000_000_401))
  applyPreviewEvent(previews, event('tool/call', {
    turn: 4,
    step: 0,
    callId: 'real-edit' as ToolCallId,
    name: 'edit',
    arguments: '{}',
  }, 402))
  assert.deepEqual(streamingToolPreviewSnapshot(previews).map(preview => ({
    callId: preview.callId,
    index: preview.index,
    name: preview.name,
  })), [{ callId: '', index: 1, name: 'write' }])
})

test('retry boundaries clear partial previews before the next request attempt', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewInput(previews, delta(4, 1, 0, 'failed-call', '{', 'edit'))
  applyPreviewEvent(previews, event('llm/retry', {
    retryId: 'retry-1' as RetryId,
    turn: 4,
    step: 1,
    provider: 'provider',
    mode: 'normal',
    policyKey: 'default',
    retry: 1,
    maxRetries: 1,
    delayMs: 0,
    failure: { code: 'TEMPORARY', message: 'temporary failure' },
  }, 41))
  assert.deepEqual(streamingToolPreviewSnapshot(previews), [])

  applyPreviewInput(previews, delta(4, 1, 0, 'retry-call', '{', 'write'))
  applyPreviewEvent(previews, event('llm/retry-started', {
    retryId: 'retry-1' as RetryId,
    turn: 4,
    step: 1,
    retry: 1,
  }, 42))
  assert.deepEqual(streamingToolPreviewSnapshot(previews), [])
})

test('formal materialization and lifecycle boundaries remove only matching previews', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewInput(previews, delta(2, 0, 0, 'call-a', '{}', 'edit'))
  applyPreviewInput(previews, delta(2, 1, 0, 'call-b', '{}', 'bash'))
  applyPreviewInput(previews, delta(3, 0, 0, 'call-c', '{}', 'read'))

  applyPreviewEvent(previews, event('tool/call', {
    turn: 2,
    step: 0,
    callId: 'call-a' as ToolCallId,
    name: 'edit',
    arguments: '{}',
  }, 20))
  assert.deepEqual(streamingToolPreviewSnapshot(previews).map(preview => preview.callId), ['call-b', 'call-c'])

  applyPreviewEvent(previews, event('step/end', { turn: 2, step: 1 }, 21))
  assert.deepEqual(streamingToolPreviewSnapshot(previews).map(preview => preview.callId), ['call-c'])

  applyPreviewEvent(previews, event('turn/end', { turn: 3, reason: { kind: 'completed' } }, 22))
  assert.deepEqual(streamingToolPreviewSnapshot(previews), [])
})

test('uses the generic lowercase title only when a delta has no name', () => {
  assert.equal(toolTitle(''), 'tool')
  assert.equal(toolTitle('unregistered_tool'), 'Tool')
  assert.equal(toolTitle('__proto__'), 'Tool')
  assert.equal(toolTitle('toString'), 'Tool')
  assert.equal(toolIconSemantic('__proto__'), 'tool-generic')
  assert.equal(toolIconSemantic('toString'), 'tool-generic')
})

test('preparing rows are inert in the fullscreen hit map', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  startedApps.add(app)
  app.start()
  app.setFocusMode(true)
  const activity: TurnActivity = {
    turn: 1,
    completed: false,
    think: { text: 'still thinking' },
    assistantMessages: 0,
    toolCalls: 0,
    tools: new Map(),
    revision: 1,
  }
  app.setTranscript([{ kind: 'assistant', turn: 1, text: 'answer' }], new Map([[1, activity]]), undefined, [{
    callId: 'preview-call',
     argumentBytes: 0,
    turn: 1,
    step: 0,
    index: 0,
    name: 'edit',
  }])
  app.setFullscreen(true)
  app.expandFocusTurn(1)
  await vt.waitForRender()

  const before = vt.getViewport().join('\n')
  const previewRow = vt.getViewport().findIndex(line => line.includes('Preparing Edit...'))
  assert.ok(previewRow >= 0, `preview row missing:\n${before}`)
  assert.deepEqual(app.focusExpandedTurnsForTest(), new Set([1]))
  click(vt, 10, previewRow + 1)
  await vt.waitForRender()
  assert.deepEqual(app.focusExpandedTurnsForTest(), new Set([1]), 'preview click must not toggle a Thought')
  assert.ok(vt.getViewport().join('\n').includes('Preparing Edit...'), 'preview click must be inert')
})

test('renders preparing rows with the selected icon style and no spinner state', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  startedApps.add(app)
  app.start()
  const preview: StreamingToolPreview = {
    callId: 'call-a',
    argumentBytes: 1234,
    turn: 1,
    step: 0,
    index: 0,
    name: 'edit',
    summary: 'src/foo.ts',
  }

  const unnamedPreview: StreamingToolPreview = {
    callId: 'call-b',
    argumentBytes: 0,
    turn: 1,
    step: 0,
    index: 1,
  }
  app.setWorking(true)
  app.setTranscript([], undefined, undefined, [preview, unnamedPreview])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('✏️  Preparing Edit src/foo.ts... · 1.2 KiB'), `emoji preview missing:\n${view}`)
  assert.ok(view.includes('🛠️  Preparing tool... · 0 B'), `unnamed preview missing:\n${view}`)
  assert.ok(view.includes('Working...'), `preview must not replace the working indicator:\n${view}`)

  app.setIconStyle('symbols')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('~  Preparing Edit src/foo.ts... · 1.2 KiB'), `symbol preview missing:\n${view}`)

  app.setIconStyle('minimal')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Preparing Edit src/foo.ts... · 1.2 KiB'), `minimal preview missing:\n${view}`)
  assert.ok(!view.includes('~  Preparing Edit src/foo.ts...'), `minimal preview kept a symbol prefix:\n${view}`)

  app.setFocusMode(true)
  const focusActivity: TurnActivity = {
    turn: 1,
    completed: false,
    think: { text: 'still thinking' },
    assistantMessages: 0,
    toolCalls: 0,
    tools: new Map(),
    revision: 1,
  }
  const focusMessages: TranscriptMessage[] = [{ kind: 'assistant', turn: 1, text: 'answer' }]
  app.setTranscript(focusMessages, new Map([[1, focusActivity]]), undefined, [preview])
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Tool:    Preparing Edit…'), `Focus collapsed Tool slot missing:\n${view}`)
  assert.ok(!view.includes('src/foo.ts'), `Focus collapsed must not show the live path:\n${view}`)
  assert.ok(!view.includes('1.2 KiB'), `Focus collapsed must not show live argument bytes:\n${view}`)
  assert.ok(!view.includes('Preparing Edit src/foo.ts...'), `Focus collapsed must not render a standalone row:\n${view}`)

  app.setTranscript(focusMessages, new Map([[1, focusActivity]]))
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('Preparing'), 'omitting the preview snapshot must clear old rows')
})

test('narrow Preparing rows stay single-line while preserving the byte tail', async () => {
  const vt = new VirtualTerminal(45, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  startedApps.add(app)
  app.start()
  app.setIconStyle('minimal')
  app.setTranscript([], undefined, undefined, [{
    callId: 'narrow',
    turn: 1,
    step: 0,
    index: 0,
    name: 'edit',
    summary: 'really/long\npath',
    argumentBytes: 123456,
  }])
  await vt.waitForRender()
  const rows = vt.getViewport().filter(line => line.includes('Preparing Edit'))
  assert.equal(rows.length, 1, `narrow Preparing row wrapped:\n${vt.getViewport().join('\n')}`)
  assert.ok(rows[0]!.includes('... · 120.6 KiB'), `byte tail missing:\n${vt.getViewport().join('\n')}`)
  assert.ok(rows[0]!.includes('…'), `summary should truncate with the existing marker:\n${rows[0]}`)
})
