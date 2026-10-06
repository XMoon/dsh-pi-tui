/**
 * Context-injection PRESENTATION compatibility helpers (TS7): the card-header
 * icon semantic and the notice one-line summary. The semantic form/provenance
 * parser and the carrier types now live in
 * `src/domain/transcript/context-semantics.ts`; this module consumes that one
 * parser through its low-level source readers and re-exports the canonical
 * semantic surface for its existing consumers. It never re-parses a source.
 * @module @xmoon76/dsh-pi-tui/context
 */

import { type IconSemantic } from './icons.ts'
import { asRecord, readString } from './domain/transcript/context-semantics.ts'

export {
  AMBIENT_CONTEXT_FORMS,
  contextFormOf,
  contextPresentation,
  contextProvenance,
  isAmbientContext,
  isTranscriptContextForm,
} from './domain/transcript/context-semantics.ts'
export type {
  ContextProvenance,
  TranscriptContextForm,
  TranscriptContextPresentation,
} from './domain/transcript/context-semantics.ts'

/**
 * The card-header icon SEMANTIC for one context injection, keyed by source
 * kind so a reader can tell an instruction file from a skill catalog or a
 * recalled session at a glance (the Web renders one browse icon for all of
 * them). The glyph itself resolves through src/icons.ts at render time —
 * fold state stores the semantic, never a concrete emoji/symbol, so an
 * icon-style switch repaints ALREADY-FOLDED context cards immediately.
 * @param source - the logged user/message source.
 */
export function contextIconSemantic(source: unknown): IconSemantic {
  const record = asRecord(source)
  const kind = record === null ? null : readString(record, 'kind')
  switch (kind) {
    case 'agent-instructions': return 'context-file'
    case 'skill-invocation': return 'context-skill'
    case 'plugin': {
      // A notice is a one-off account; everything else is payload.
      return readString(record ?? {}, 'form') === 'notice' ? 'context-notice' : 'context-plugin'
    }
    case 'subagent-settled': return 'context-notice'
    case 'session-reference': return 'context-recall'
    default: return 'context-generic'
  }
}

/** The producer's one-line notice summary, or null when absent. */
export function contextSummary(source: unknown): string | null {
  const record = asRecord(source)
  if (record === null) return null
  const summary = record['summary']
  return typeof summary === 'string' && summary !== '' ? summary : null
}
