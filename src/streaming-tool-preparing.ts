/** Live-only projection for tool calls while their arguments are streaming. */

import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Load the official retry event declarations for the discriminated SessionEvent union.
import type {} from '@deepseek-ai/dsh-llm-retry'
import type { StreamingToolPreview } from './tui-app.ts'

function fallbackPreviewKey(turn: number, step: number, index: number): ToolCallId {
  return `\u0000streaming-tool-preview:${turn}:${step}:${index}` as ToolCallId
}

function previewAt(
  previews: ReadonlyMap<ToolCallId, StreamingToolPreview>,
  turn: number,
  step: number,
  index: number,
): [ToolCallId, StreamingToolPreview] | undefined {
  for (const entry of previews) {
    if (entry[1].turn === turn && entry[1].step === step && entry[1].index === index) return entry
  }
  return undefined
}

function clearStep(previews: Map<ToolCallId, StreamingToolPreview>, turn: number, step: number): void {
  for (const [key, preview] of previews) {
    if (preview.turn === turn && preview.step === step) previews.delete(key)
  }
}

/** Apply one live event without entering the durable transcript or Focus state. */
export function applyStreamingToolPreviewEvent(
  previews: Map<ToolCallId, StreamingToolPreview>,
  event: SessionEvent,
): void {
  if (event.type === 'assistant/chunk' && event.data.chunk.type === 'tool-call-delta') {
    const chunk = event.data.chunk
    const previous = previewAt(previews, event.data.turn, event.data.step, chunk.index)
    const key = chunk.id === ''
      ? previous?.[0] ?? fallbackPreviewKey(event.data.turn, event.data.step, chunk.index)
      : chunk.id
    if (previous !== undefined && previous[0] !== key) previews.delete(previous[0])
    const existing = previews.get(key)
    previews.set(key, {
      callId: chunk.id === '' ? existing?.callId ?? previous?.[1].callId ?? chunk.id : chunk.id,
      turn: event.data.turn,
      step: event.data.step,
      index: chunk.index,
      name: chunk.name ?? existing?.name ?? previous?.[1].name,
    })
    return
  }
  if (event.type === 'tool/call') {
    previews.delete(event.data.callId)
    for (const [key, preview] of previews) {
      if (preview.turn === event.data.turn && preview.step === event.data.step && preview.callId === event.data.callId) {
        previews.delete(key)
      }
    }
    return
  }
  if (event.type === 'llm/retry' || event.type === 'llm/retry-started') {
    clearStep(previews, event.data.turn, event.data.step)
    return
  }
  if (event.type === 'step/end') {
    clearStep(previews, event.data.turn, event.data.step)
    return
  }
  if (event.type === 'turn/end') {
    for (const [callId, preview] of previews) {
      if (preview.turn === event.data.turn) previews.delete(callId)
    }
  }
}

/** Return a stable model-order snapshot for one presentation owner. */
export function streamingToolPreviewSnapshot(
  previews: ReadonlyMap<ToolCallId, StreamingToolPreview>,
): StreamingToolPreview[] {
  return [...previews.values()].sort((left, right) => left.index - right.index)
}
