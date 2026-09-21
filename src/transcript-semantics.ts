/**
 * Stable semantic classification for the shared transcript projection.
 *
 * Classification is source/kind driven and deliberately ignores display text,
 * tool names, and error wording. Compact and later Work-span projections can
 * consume this vocabulary without rebuilding a second transcript.
 * @module @xmoon76/dsh-pi-tui/transcript-semantics
 */

import type {
  TranscriptMessage,
  TranscriptSystemOrigin,
  TranscriptToolOrigin,
} from './transcript.ts'

/** The four semantic layers used by the future Compact projection. */
export type TranscriptSemanticClass = 'conversation' | 'process' | 'attention' | 'context'

/** Source-derived origins for the currently ambiguous presentation rows. */
export type TranscriptSemanticOrigin =
  | TranscriptSystemOrigin
  | TranscriptToolOrigin
  | 'thinking'
  | 'injected-context'
  | 'workflow'
  | 'compaction'
  | 'window-summary'

/** The semantic class and optional source provenance of one message. */
export interface TranscriptSemantic {
  readonly class: TranscriptSemanticClass
  readonly origin?: TranscriptSemanticOrigin
}

/** Classify one current TranscriptMessage without consulting display text. */
export function classifyTranscriptMessage(message: TranscriptMessage): TranscriptSemantic {
  switch (message.kind) {
    case 'user':
    case 'assistant':
      return { class: 'conversation' }
    case 'thinking':
      return { class: 'process', origin: 'thinking' }
    case 'tool':
      if (message.origin === 'turn-error' || message.origin === 'turn-interrupted') {
        return { class: 'attention', origin: message.origin }
      }
      return message.origin === undefined
        ? { class: 'process' }
        : { class: 'process', origin: message.origin }
    case 'system':
      if (isSurfacedContext(message)) return { class: 'context', origin: 'injected-context' }
      if (message.origin === 'turn-max-tokens') return { class: 'attention', origin: message.origin }
      if (message.origin === 'llm-retry') return { class: 'process', origin: message.origin }
      return { class: 'context' }
    case 'workflow':
      return { class: 'context', origin: 'workflow' }
    case 'compaction':
      return { class: 'context', origin: 'compaction' }
    case 'summary':
      return { class: 'context', origin: 'window-summary' }
  }
}

/** Short alias for callers that phrase the operation as a semantic read. */
export const transcriptSemanticOf = classifyTranscriptMessage

/**
 * Whether a system row is an injected context boundary that Focus keeps
 * visible when its Thought is collapsed. The fold's authoritative `context`
 * marker intentionally covers unknown/future injection producers too.
 */
export function isSurfacedContext(message: TranscriptMessage): message is Extract<TranscriptMessage, { kind: 'system' }> & { context: true } {
  return message.kind === 'system' && message.context === true
}
