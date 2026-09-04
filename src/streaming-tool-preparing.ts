/** Pure local operations for the live tool-call preparing projection. */

import type { StreamingToolPreview } from './tui-app.ts'

function fallbackPreviewKey(turn: number, step: number, index: number): string {
  return `\u0000streaming-tool-preview:${turn}:${step}:${index}`
}

function previewAt(
  previews: ReadonlyMap<string, StreamingToolPreview>,
  turn: number,
  step: number,
  index: number,
): [string, StreamingToolPreview] | undefined {
  for (const entry of previews) {
    if (entry[1].turn === turn && entry[1].step === step && entry[1].index === index) return entry
  }
  return undefined
}

/** Upsert one local preview, preserving a delayed name and stable position. */
export function upsertStreamingToolPreview(
  previews: Map<string, StreamingToolPreview>,
  preview: StreamingToolPreview,
): void {
  const previous = previewAt(previews, preview.turn, preview.step, preview.index)
  const key = preview.callId === ''
    ? previous?.[0] ?? fallbackPreviewKey(preview.turn, preview.step, preview.index)
    : preview.callId
  if (previous !== undefined && previous[0] !== key) previews.delete(previous[0])
  const existing = previews.get(key)
  previews.set(key, {
    callId: preview.callId === '' ? existing?.callId ?? previous?.[1].callId ?? preview.callId : preview.callId,
    turn: preview.turn,
    step: preview.step,
    index: preview.index,
    name: preview.name ?? existing?.name ?? previous?.[1].name,
  })
}

/** Remove the local preview represented by one formal tool call. */
export function removeStreamingToolPreview(
  previews: Map<string, StreamingToolPreview>,
  callId: string,
  turn: number,
  step: number,
): void {
  previews.delete(callId)
  for (const [key, preview] of previews) {
    if (preview.turn === turn && preview.step === step && preview.callId === callId) previews.delete(key)
  }
}

/** Clear all orphan previews owned by one step. */
export function clearStreamingToolPreviewsForStep(
  previews: Map<string, StreamingToolPreview>,
  turn: number,
  step: number,
): void {
  for (const [key, preview] of previews) {
    if (preview.turn === turn && preview.step === step) previews.delete(key)
  }
}

/** Clear all previews owned by one turn. */
export function clearStreamingToolPreviewsForTurn(
  previews: Map<string, StreamingToolPreview>,
  turn: number,
): void {
  for (const [key, preview] of previews) {
    if (preview.turn === turn) previews.delete(key)
  }
}

/** Return a stable model-order snapshot for one presentation owner. */
export function streamingToolPreviewSnapshot(
  previews: ReadonlyMap<string, StreamingToolPreview>,
): StreamingToolPreview[] {
  return [...previews.values()].sort((left, right) => left.index - right.index)
}
