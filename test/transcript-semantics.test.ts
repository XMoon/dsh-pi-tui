/** Tests for source-derived transcript semantic classification. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyTranscriptMessage, isSurfacedContext } from '../src/transcript-semantics.ts'
import type { TranscriptMessage } from '../src/transcript.ts'

const tool = (origin?: 'command' | 'subagent-delegation' | 'turn-error' | 'turn-interrupted'): TranscriptMessage => ({
  kind: 'tool', turn: 1, name: 'synthetic', args: '', result: '', status: 'ok', ...(origin === undefined ? {} : { origin }),
})

test('classifies conversation, process, attention, and context without reading display text', () => {
  assert.deepEqual(classifyTranscriptMessage({ kind: 'user', turn: 1, text: 'attention' }), { class: 'conversation' })
  assert.deepEqual(classifyTranscriptMessage({ kind: 'assistant', turn: 1, text: 'context' }), { class: 'conversation' })
  assert.deepEqual(classifyTranscriptMessage({ kind: 'thinking', turn: 1, text: 'conversation' }), { class: 'process', origin: 'thinking' })
  assert.deepEqual(classifyTranscriptMessage(tool()), { class: 'process' })
  assert.deepEqual(classifyTranscriptMessage({ kind: 'system', turn: 1, text: 'context', context: true }), { class: 'context', origin: 'injected-context' })
  assert.deepEqual(classifyTranscriptMessage({ kind: 'summary', text: 'conversation' }), { class: 'context', origin: 'window-summary' })
})

test('marks injected context as a surfaced boundary without changing its Context class', () => {
  const injected: TranscriptMessage = { kind: 'system', turn: 1, text: 'unknown producer', context: true }
  assert.deepEqual(classifyTranscriptMessage(injected), { class: 'context', origin: 'injected-context' })
  assert.equal(isSurfacedContext(injected), true)
  assert.equal(isSurfacedContext({ kind: 'system', turn: 1, text: 'ordinary system' }), false)
  assert.equal(isSurfacedContext({ kind: 'system', turn: 1, text: 'retry', origin: 'llm-retry' }), false)
  assert.equal(isSurfacedContext({ kind: 'system', turn: 1, text: 'max', origin: 'turn-max-tokens' }), false)
  assert.equal(isSurfacedContext({ kind: 'workflow' } as TranscriptMessage), false)
  assert.equal(isSurfacedContext({ kind: 'compaction', turn: 1, text: '', items: 0, tokens: 0 } as TranscriptMessage), false)
  assert.equal(isSurfacedContext({ kind: 'summary', text: 'summary' }), false)
})

test('classifies synthetic origins by source semantics', () => {
  assert.deepEqual(classifyTranscriptMessage({ kind: 'system', turn: 1, text: 'retry', origin: 'llm-retry' }), { class: 'process', origin: 'llm-retry' })
  assert.deepEqual(classifyTranscriptMessage({ kind: 'system', turn: 1, text: 'limit', origin: 'turn-max-tokens' }), { class: 'attention', origin: 'turn-max-tokens' })
  assert.deepEqual(classifyTranscriptMessage(tool('command')), { class: 'process', origin: 'command' })
  assert.deepEqual(classifyTranscriptMessage(tool('subagent-delegation')), { class: 'process', origin: 'subagent-delegation' })
  assert.deepEqual(classifyTranscriptMessage(tool('turn-error')), { class: 'attention', origin: 'turn-error' })
  assert.deepEqual(classifyTranscriptMessage(tool('turn-interrupted')), { class: 'attention', origin: 'turn-interrupted' })
})

test('classification follows source semantics, not status or display wording', () => {
  assert.deepEqual(classifyTranscriptMessage({
    kind: 'tool', turn: 1, name: 'renamed-tool', args: 'retry', result: 'failed', status: 'error',
  }), { class: 'process' })
  for (const text of ['retry', 'provider error', 'max tokens', 'ordinary text']) {
    assert.deepEqual(classifyTranscriptMessage({ kind: 'system', turn: 1, text, origin: 'llm-retry' }), {
      class: 'process', origin: 'llm-retry',
    })
    assert.deepEqual(classifyTranscriptMessage({ kind: 'system', turn: 1, text, origin: 'turn-max-tokens' }), {
      class: 'attention', origin: 'turn-max-tokens',
    })
    assert.deepEqual(classifyTranscriptMessage({
      kind: 'tool', turn: 1, name: 'renamed-error', args: text, result: text, status: 'error', origin: 'turn-error',
    }), { class: 'attention', origin: 'turn-error' })
  }
})

test('workflow and compaction remain context rather than conversation', () => {
  assert.deepEqual(classifyTranscriptMessage({ kind: 'workflow' } as TranscriptMessage), { class: 'context', origin: 'workflow' })
  assert.deepEqual(classifyTranscriptMessage({ kind: 'compaction', turn: 1, text: '', items: 0, tokens: 0 } as TranscriptMessage), { class: 'context', origin: 'compaction' })
})
