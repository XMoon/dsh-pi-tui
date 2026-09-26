/**
 * Pure local operations for the live tool-call preparing projection: the
 * preview map operations plus the two appliers that fold a durable session
 * event or one transient assistant-stream input onto them.
 */

import type { StreamingToolPreview } from './tui-app.ts'
import { toolSummaryKeys } from './present.ts'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantLiveInput } from './runtime/assistant-stream-port.ts'

/** Hard cap for the partial argument prefix retained for summary extraction. */
export const PREPARING_SCAN_MAX_CHARS = 4096

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

/** Extract one complete, non-empty JSON string field from a partial object. */
export function extractPartialStringField(
  raw: string,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const encodedKey = JSON.stringify(key)
    let searchFrom = 0
    while (searchFrom < raw.length) {
      const keyStart = raw.indexOf(encodedKey, searchFrom)
      if (keyStart === -1) break
      let cursor = keyStart + encodedKey.length
      while (/\s/.test(raw[cursor] ?? '')) cursor += 1
      if (raw[cursor] !== ':') {
        searchFrom = cursor
        continue
      }
      cursor += 1
      while (/\s/.test(raw[cursor] ?? '')) cursor += 1
      if (raw[cursor] !== '"') {
        searchFrom = cursor
        continue
      }
      const valueStart = cursor
      cursor += 1
      while (cursor < raw.length) {
        if (raw[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (raw[cursor] === '"') {
          try {
            const value: unknown = JSON.parse(raw.slice(valueStart, cursor + 1))
            if (typeof value === 'string' && value !== '') return value
          } catch {
            // The value is not a valid complete JSON string yet.
          }
          break
        }
        cursor += 1
      }
      searchFrom = keyStart + encodedKey.length
    }
  }
  return undefined
}

export interface StreamingToolPreviewInput {
  readonly callId: string
  readonly turn: number
  readonly step: number
  readonly index: number
  readonly name?: string
  /** One decoded argumentsDelta from the live assistant stream. */
  readonly argumentsDelta?: string
  /** The chunk's time: the FIRST delta records the preview's start, so the
   * elapsed seconds survive the Preparing → durable handoff (post-F6 plan
   * §12.14). */
  readonly time?: number
}

/** Upsert one local preview, preserving streamed state across identity/name delays. */
export function upsertStreamingToolPreview(
  previews: Map<string, StreamingToolPreview>,
  input: StreamingToolPreviewInput,
): void {
  const previous = previewAt(previews, input.turn, input.step, input.index)
  const key = input.callId === ''
    ? previous?.[0] ?? fallbackPreviewKey(input.turn, input.step, input.index)
    : input.callId
  if (previous !== undefined && previous[0] !== key) previews.delete(previous[0])
  const existing = previews.get(key)
  const prior = existing ?? previous?.[1]
  const name = input.name ?? prior?.name
  const previousArgumentBytes = prior?.argumentBytes ?? 0
  const argumentBytes = previousArgumentBytes
    + (input.argumentsDelta === undefined ? 0 : Buffer.byteLength(input.argumentsDelta, 'utf8'))
  let summary = prior?.summary
  let scanPrefix = prior?.scanPrefix

  // `scanPrefix === undefined` with received bytes and no summary means a
  // known-name scan already hit its cap. An unknown name keeps its capped
  // prefix so a later name can perform one final extraction attempt.
  const canScan = summary === undefined && (scanPrefix !== undefined || previousArgumentBytes === 0)
  if (canScan) {
    const boundedPrefix = scanPrefix?.slice(0, PREPARING_SCAN_MAX_CHARS)
    const candidate = input.argumentsDelta === undefined
      ? boundedPrefix
      : `${boundedPrefix ?? ''}${input.argumentsDelta.slice(
        0,
        Math.max(0, PREPARING_SCAN_MAX_CHARS - (boundedPrefix?.length ?? 0)),
      )}`
    if (candidate !== undefined) {
      // The formal key order is a preference among fields complete at this
      // extraction point; partial streams do not promise a later re-selection.
      const extracted = name === undefined
        ? undefined
        : extractPartialStringField(candidate, toolSummaryKeys(name))
      if (extracted !== undefined) {
        summary = extracted
        scanPrefix = undefined
      } else if (candidate.length >= PREPARING_SCAN_MAX_CHARS) {
        scanPrefix = name === undefined ? candidate : undefined
      } else {
        scanPrefix = candidate
      }
    }
  }

  previews.set(key, {
    callId: input.callId === '' ? prior?.callId ?? input.callId : input.callId,
    turn: input.turn,
    step: input.step,
    index: input.index,
    ...(name === undefined ? {} : { name }),
    argumentBytes,
    ...(summary === undefined ? {} : { summary }),
    ...(scanPrefix === undefined ? {} : { scanPrefix }),
    // First-wins: the earliest delta owns the start.
    ...(prior?.startedAt === undefined
      ? input.time === undefined ? {} : { startedAt: input.time }
      : { startedAt: prior.startedAt }),
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

/** Translate official DSH events into the local preview operations. The
 * STREAMED tool-call deltas arrive through the live assistant stream seam
 * (`applyStreamingToolPreviewInput`); this durable-event path only CLEARS
 * previews (settled calls, retries, step/turn boundaries). */
export function applyStreamingToolPreviewEvent(
  previews: Map<string, StreamingToolPreview>,
  event: { readonly type: string; readonly data: unknown },
): void {
  if (event.type === 'tool/call') {
    const data = event.data as { readonly callId: ToolCallId; readonly turn: number; readonly step: number }
    removeStreamingToolPreview(previews, data.callId, data.turn, data.step)
    return
  }
  // `assistant/attempt` (Session v2, typed STRUCTURALLY): the attempt's
  // tool-call deltas never materialized — its step's previews must not
  // survive as ghost rows.
  if ((event.type as string) === 'assistant/attempt') {
    const data = event.data as { turn: number; step: number }
    clearStreamingToolPreviewsForStep(previews, data.turn, data.step)
    return
  }
  if (event.type === 'llm/retry' || event.type === 'llm/retry-started') {
    const data = event.data as { readonly turn: number; readonly step: number }
    clearStreamingToolPreviewsForStep(previews, data.turn, data.step)
    return
  }
  if (event.type === 'step/end') {
    const data = event.data as { readonly turn: number; readonly step: number }
    clearStreamingToolPreviewsForStep(previews, data.turn, data.step)
    return
  }
  if (event.type === 'turn/end') {
    const data = event.data as { readonly turn: number }
    clearStreamingToolPreviewsForTurn(previews, data.turn)
  }
}

/** Translate one live assistant stream input (Session v2 transient plane)
 * into the streaming tool preview operations. The CLEAR paths stay on the
 * durable session-event plane (`tool/call`, `llm/retry`, `step/end`,
 * `turn/end`); only the streamed tool-call deltas and block-ends arrive
 * here. */
export function applyStreamingToolPreviewInput(
  previews: Map<string, StreamingToolPreview>,
  input: AssistantLiveInput,
): void {
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
      time: input.time,
    })
    return
  }
  if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') {
    const callId = typeof chunk.block.id === 'string' ? chunk.block.id : ''
    const name = typeof chunk.block.name === 'string' ? chunk.block.name : undefined
    upsertStreamingToolPreview(previews, {
      callId,
      turn: input.turn,
      step: input.step,
      index: chunk.index,
      name,
      time: input.time,
    })
  }
}
