/** Regression coverage for live-only streaming tool-call preparing rows. */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  clearStreamingToolPreviewsForStep,
  clearStreamingToolPreviewsForTurn,
  removeStreamingToolPreview,
  streamingToolPreviewSnapshot,
  upsertStreamingToolPreview,
} from '../src/streaming-tool-preparing.ts'
import { toolIconSemantic, toolTitle } from '../src/present.ts'
import { TuiApp, type StreamingToolPreview } from '../src/tui-app.ts'
import type { TurnActivity } from '../src/transcript.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function event<K extends SessionEvent['type']>(
  type: K,
  data: SessionEvent<K>['data'],
  seq: number,
): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq * 1000, data } as SessionEvent
}

function delta(
  turn: number,
  step: number,
  index: number,
  id: string,
  argumentsDelta: string,
  name?: string,
): SessionEvent {
  return event('assistant/chunk', {
    turn,
    step,
    chunk: {
      type: 'tool-call-delta',
      index,
      id: id as ToolCallId,
      argumentsDelta,
      ...(name === undefined ? {} : { name }),
    },
  }, turn * 100 + step * 10 + index) as SessionEvent
}

function applyPreviewEvent(previews: Map<string, StreamingToolPreview>, event: SessionEvent): void {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'tool-call-delta') {
    const chunk = event.data.chunk
    upsertStreamingToolPreview(previews, {
      callId: chunk.id,
      turn: event.data.turn,
      step: event.data.step,
      index: chunk.index,
      name: chunk.name,
    })
    return
  }
  if (
    event.type === 'assistant/chunk'
    && event.data.chunk.type === 'block-end'
    && event.data.chunk.block.type === 'tool-call'
  ) {
    const chunk = event.data.chunk
    const block = chunk.block as { type: 'tool-call'; id: ToolCallId; name: string }
    upsertStreamingToolPreview(previews, {
      callId: block.id,
      turn: event.data.turn,
      step: event.data.step,
      index: chunk.index,
      name: block.name,
    })
    return
  }
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
  applyPreviewEvent(previews, delta(1, 0, 1, 'call-b', '{"path"', 'write'))
  applyPreviewEvent(previews, delta(1, 0, 0, 'call-a', '{"path"'))
  applyPreviewEvent(previews, delta(1, 0, 1, 'call-b', ':"x"}'))

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
    'callId', 'turn', 'step', 'index', 'name',
  ])
})

test('empty ids use the stable chunk position and migrate to a later call id', () => {
  const previews = new Map<string, StreamingToolPreview>()
  applyPreviewEvent(previews, delta(2, 0, 1, '', '{}', 'write'))
  applyPreviewEvent(previews, delta(2, 0, 0, '', '{}', 'edit'))

  assert.deepEqual(streamingToolPreviewSnapshot(previews).map(preview => ({
    callId: preview.callId,
    index: preview.index,
    name: preview.name,
  })), [
    { callId: '', index: 0, name: 'edit' },
    { callId: '', index: 1, name: 'write' },
  ])

  applyPreviewEvent(previews, delta(2, 0, 0, 'real-edit', '{}'))
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
  applyPreviewEvent(previews, delta(3, 0, 0, '', '{', 'edit'))
  applyPreviewEvent(previews, event('assistant/chunk', {
    turn: 3,
    step: 0,
    chunk: {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'real-edit' as ToolCallId, name: 'edit', arguments: '{}' },
    },
  }, 301))
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
  applyPreviewEvent(previews, delta(4, 0, 0, '', '{', 'edit'))
  applyPreviewEvent(previews, delta(4, 0, 1, '', '{', 'write'))
  applyPreviewEvent(previews, event('assistant/chunk', {
    turn: 4,
    step: 0,
    chunk: {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'real-edit' as ToolCallId, name: 'edit', arguments: '{}' },
    },
  }, 401))
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
  applyPreviewEvent(previews, delta(4, 1, 0, 'failed-call', '{', 'edit'))
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

  applyPreviewEvent(previews, delta(4, 1, 0, 'retry-call', '{', 'write'))
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
  applyPreviewEvent(previews, delta(2, 0, 0, 'call-a', '{}', 'edit'))
  applyPreviewEvent(previews, delta(2, 1, 0, 'call-b', '{}', 'bash'))
  applyPreviewEvent(previews, delta(3, 0, 0, 'call-c', '{}', 'read'))

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
    turn: 1,
    step: 0,
    index: 0,
    name: 'edit',
  }])
  app.setFullscreen(true)
  await vt.waitForRender()

  const before = vt.getViewport().join('\n')
  const previewRow = vt.getViewport().findIndex(line => line.includes('Preparing Edit...'))
  assert.ok(previewRow >= 0, `preview row missing:\n${before}`)
  assert.deepEqual(app.focusExpandedTurnsForTest(), new Set())
  click(vt, 10, previewRow + 1)
  await vt.waitForRender()
  assert.deepEqual(app.focusExpandedTurnsForTest(), new Set(), 'preview click must not toggle a Thought')
  assert.ok(vt.getViewport().join('\n').includes('Preparing Edit...'), 'preview click must be inert')
})

test('renders preparing rows with the selected icon style and no spinner state', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  startedApps.add(app)
  app.start()
  const preview: StreamingToolPreview = {
    callId: 'call-a',
    turn: 1,
    step: 0,
    index: 0,
    name: 'edit',
  }

  const unnamedPreview: StreamingToolPreview = {
    callId: 'call-b',
    turn: 1,
    step: 0,
    index: 1,
  }
  app.setWorking(true)
  app.setTranscript([], undefined, undefined, [preview, unnamedPreview])
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('✏️  Preparing Edit...'), `emoji preview missing:\n${view}`)
  assert.ok(view.includes('🛠️  Preparing tool...'), `unnamed preview missing:\n${view}`)
  assert.ok(view.includes('Working...'), `preview must not replace the working indicator:\n${view}`)

  app.setIconStyle('symbols')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('~  Preparing Edit...'), `symbol preview missing:\n${view}`)

  app.setIconStyle('minimal')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Preparing Edit...'), `minimal preview missing:\n${view}`)
  assert.ok(!view.includes('~  Preparing Edit...'), `minimal preview kept a symbol prefix:\n${view}`)

  app.setFocusMode(true)
  app.setTranscript([], new Map(), undefined, [preview])
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('Preparing Edit...'), 'Focus must keep the ephemeral row visible')

  app.setTranscript([])
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('Preparing Edit...'), 'omitting the preview snapshot must clear old rows')
})
