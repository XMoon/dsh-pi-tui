/**
 * Canonical Context semantic source (TS7): the producer-declared Context form,
 * the ambient-eligibility predicate, and the ONE parser of raw context sources.
 *
 * The producer-declared `MessageSource.form` (recorded on the folded system row
 * as `TranscriptContextPresentation`) decides WHAT one injected Context row
 * semantically is: `instructions`/`catalog`/`snapshot` are the ambient
 * foundation, `notice`/`relay`/`recall` are standalone accounts. The semantic
 * class of every row stays `Context` and `context:true` stays the surfaced
 * authority.
 *
 * The renderer-neutral PRESENTATION consequences — the presentation kind, the
 * ambient clustering and the structured summary — live under
 * `tui/transcript/**` (TS6). The card-header icon SEMANTIC and the notice
 * one-line summary consume this module's low-level source readers; they were
 * merged here in TS8-D from the retired `src/context.ts` compatibility root,
 * so exactly ONE parser for source kind / form / sender / provenance role
 * remains.
 *
 * The carrier types live in the canonical `domain/transcript/types.ts` and are
 * re-exported here for their consumers.
 * @module @xmoon76/dsh-pi-tui/domain/transcript/context-semantics
 */

import { type IconSemantic } from '../display/icons.ts'
import { isSurfacedContext } from './semantics.ts'
import type {
  ContextProvenance,
  TranscriptContextForm,
  TranscriptContextPresentation,
  TranscriptMessage,
} from './types.ts'

export type { ContextProvenance, TranscriptContextForm, TranscriptContextPresentation } from './types.ts'

/** One durable source narrowed to the readable-record shape; null for anything else. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** A record field read as a non-empty string, or null. */
export function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
} // asRecord + readString (low-level source readers)

/** Distinct non-empty `field` values of an array-valued source member, in first-seen order.
 * The `seen` Set keeps a foreign/legacy log with a very large member array
 * linear; an `includes()` scan here is an accidental O(n^2). */
function collect(source: Record<string, unknown>, member: string, field: string): string[] {
  const list = source[member]
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const names: string[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    const value = record === null ? null : readString(record, field)
    if (value !== null && !seen.has(value)) {
      seen.add(value)
      names.push(value)
    }
  }
  return names
} // collect

/** A collected name list rendered as one label; null when the list is empty. */
function joined(names: readonly string[]): string | null {
  return names.length > 0 ? names.join(', ') : null
} // joined

/**
 * Project one durable message source onto its transcript role and producer
 * name, exactly like the Web's contextProvenance: agent-instructions name
 * their changed file paths, plugins their plugin id, skill invocations their
 * skill name, session references their recalled labels; unknown kinds carry
 * the kind itself.
 * @param source - the logged user/message source, exactly as recorded.
 * @returns the role and producer name to present for this context.
 */
export function contextProvenance(source: unknown): ContextProvenance {
  const record = asRecord(source)
  const kind = record === null ? null : readString(record, 'kind')
  if (record === null || kind === null) return { role: 'inject', label: null }
  switch (kind) {
    case 'session-reference':
      return { role: 'recall', label: joined(collect(record, 'references', 'label')) ?? kind }
    case 'agent-instructions':
      return { role: 'inject', label: joined(collect(record, 'changes', 'path')) ?? kind }
    case 'plugin':
      return { role: 'inject', label: readString(record, 'plugin') ?? kind }
    case 'skill-invocation':
      return { role: 'inject', label: readString(record, 'name') ?? kind }
    default:
      return { role: 'inject', label: kind }
  }
} // contextProvenance

/** Whether a raw value is one of the declared context forms. */
export function isTranscriptContextForm(value: unknown): value is TranscriptContextForm {
  return value === 'instructions' || value === 'catalog' || value === 'snapshot'
    || value === 'notice' || value === 'relay' || value === 'recall'
} // isTranscriptContextForm

/**
 * Project one logged context source onto the presentation-only metadata the
 * transcript fold retains: the producer-declared `form` (the authority for
 * presentation role and ambient clustering), the raw `kind`, a
 * relay/notice sender, and the inject/recall role. This is the SINGLE
 * parser of raw context sources; the fold and every projection consume its
 * result. An absent/unknown form stays undefined — the caller must present
 * the row as standalone generic Context.
 * @param source - the logged user/message source, exactly as recorded.
 */
export function contextPresentation(source: unknown): TranscriptContextPresentation {
  const record = asRecord(source)
  const role = contextProvenance(source).role
  if (record === null) return { role }
  const kind = readString(record, 'kind')
  const form = record['form']
  const senderSessionId = readString(record, 'senderSessionId')
  return {
    ...isTranscriptContextForm(form) ? { form } : {},
    ...kind === null ? {} : { sourceKind: kind },
    ...senderSessionId === null ? {} : { senderSessionId },
    role,
  }
} // contextPresentation

/** The ambient foundation forms: their adjacent rows may cluster. */
export const AMBIENT_CONTEXT_FORMS: readonly TranscriptContextForm[] = ['instructions', 'catalog', 'snapshot']

/** One injected Context row's presentation provenance, or undefined. */
function presentationOf(message: TranscriptMessage): NonNullable<Extract<TranscriptMessage, { kind: 'system' }>['contextPresentation']> | undefined {
  return message.kind === 'system' ? message.contextPresentation : undefined
}

/** The producer-declared form of one row, when recorded. */
export function contextFormOf(message: TranscriptMessage): TranscriptContextForm | undefined {
  return presentationOf(message)?.form
}

/** Whether one row is ambient foundation (instructions/catalog/snapshot). */
export function isAmbientContext(message: TranscriptMessage): message is Extract<TranscriptMessage, { kind: 'system' }> & { context: true } {
  const form = contextFormOf(message)
  return isSurfacedContext(message) && form !== undefined && AMBIENT_CONTEXT_FORMS.includes(form)
}

/**
 * The card-header icon SEMANTIC for one context injection, keyed by source
 * kind so a reader can tell an instruction file from a skill catalog or a
 * recalled session at a glance (the Web renders one browse icon for all of
 * them). The glyph itself resolves through the concrete TUI palette at render
 * time — fold state stores the semantic, never a concrete emoji/symbol, so an
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
