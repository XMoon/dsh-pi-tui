/** Pure local operations for the live tool-call preparing projection. */

import type { StreamingToolPreview } from './tui-app.ts'
import { toolSummaryKeys } from './present.ts'

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
