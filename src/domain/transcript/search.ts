/**
 * Canonical transcript search semantics (TS7): the searchable corpus, the
 * semantic source vocabulary, the stable occurrence identity and the ONE
 * normalized-coordinate span resolver.
 *
 * These are transport/UI-neutral facts — corpus identity, source identity,
 * occurrence identity, normalized coordinates and stable match identity. The
 * mutable live index/revision stays inside the ONE TranscriptFolder lifetime,
 * and the reveal/highlight/scroll mechanics stay presentation-owned.
 * @module @xmoon76/dsh-pi-tui/domain/transcript/search
 */

import { PTC_MAX_DEPTH } from './types.ts'
import type {
  TranscriptCommandMessage,
  TranscriptItemId,
  TranscriptMessage,
  TranscriptToolMessage,
} from './types.ts'
import { workflowPhaseKey, workflowReadablePhase } from './workflow-projection.ts'

/** The semantic origin of one searchable span inside a message's corpus.
 * Reveal/selection needs the origin, not just a character offset: a PTC hit
 * must know its ancestor `subCallIds` chain, a Workflow member hit its
 * `phaseKey`/`seq`, an assistant deliverable hit its file index. */
export type TranscriptSearchSource =
  | { readonly kind: 'message' }
  | { readonly kind: 'tool-field'; readonly field: 'name' | 'args' | 'result' }
  | { readonly kind: 'command-field'; readonly field: 'name' | 'args' | 'outcome' }
  | { readonly kind: 'subcall-field'; readonly subCallIds: readonly string[]; readonly field: 'name' | 'args' | 'result' }
  | { readonly kind: 'workflow-run'; readonly field: 'kind' | 'name' | 'status' }
  | { readonly kind: 'workflow-phase'; readonly phaseKey: string }
  | { readonly kind: 'workflow-member'; readonly phaseKey: string; readonly seq: number; readonly field: 'label' | 'status' }
  | { readonly kind: 'assistant-deliverable'; readonly index: number; readonly field: 'path' | 'description' }

/** Stable string identity of one semantic source. This is the source half of
 * {@link transcriptSearchMatchKey}; it must stay stable across re-normalization
 * (live settlement / group reflow) so the overlay can recover the current hit. */
export function transcriptSearchSourceKey(source: TranscriptSearchSource): string {
  switch (source.kind) {
    case 'message': return 'message'
    case 'tool-field': return `tool.${source.field}`
    case 'command-field': return `command.${source.field}`
    case 'subcall-field': return `subcall.${source.subCallIds.join('>')}.${source.field}`
    case 'workflow-run': return `workflow-run.${source.field}`
    case 'workflow-phase': return `workflow-phase.${source.phaseKey}`
    case 'workflow-member': return `workflow-member.${source.phaseKey}.${source.seq}.${source.field}`
    case 'assistant-deliverable': return `assistant-deliverable.${source.index}.${source.field}`
  }
}

/** One corpus chunk: the raw text plus its semantic origin. */
interface TranscriptSearchChunk {
  readonly text: string
  readonly source: TranscriptSearchSource
}

/** One span of a message corpus: NORMALIZED-coordinate bounds plus its origin.
 * `sourceKey` is the stable identity used by {@link transcriptSearchMatchKey}. */
export interface TranscriptSearchCorpusSpan {
  readonly start: number
  readonly end: number
  readonly source: TranscriptSearchSource
  readonly sourceKey: string
}

/** The full searchable corpus of one message: the legacy raw text (the
 * compatibility surface {@link transcriptSearchText} returns) plus the
 * whole-string lowercase normalized text and its source spans. */
export interface TranscriptSearchCorpus {
  readonly text: string
  readonly normalizedText: string
  readonly spans: readonly TranscriptSearchCorpusSpan[]
}

/** One full-history search hit: the current visible representative of the
 * matched logical card, its visible turn, and the OCCURRENCE identity inside
 * that card. Matches deliberately never carry `TranscriptMessage` objects:
 * live settlement replaces items and grouping reflow replaces merged cards,
 * so an object-based match would pin stale state and break Next/Prev.
 * `occurrence` counts non-overlapping hits in the representative corpus;
 * `source`/`sourceOccurrence` locate the same hit inside its semantic source
 * (PTC path, Workflow member, deliverable) for temporary reveal + highlight. */
export interface TranscriptSearchMatch {
  readonly id: TranscriptItemId
  readonly turn: number
  readonly occurrence: number
  readonly source: TranscriptSearchSource
  readonly sourceOccurrence: number
}

/** The stable occurrence identity used by the overlay's stale-refresh
 * recovery: representative id + semantic source + source-local ordinal.
 * Deliberately NOT the card id alone — one card holds many hits. */
export function transcriptSearchMatchKey(match: TranscriptSearchMatch): string {
  return `${match.id}:${transcriptSearchSourceKey(match.source)}:${match.sourceOccurrence}`
}

/** The searchable text of one message — the compatibility helper over the
 * SINGLE corpus builder (tools search `name args result`, every other kind
 * searches `text`). `summary` rows never reach `items`. A PTC root card's
 * corpus recursively includes its sub-call descendants (name/args/result). */
export function transcriptSearchText(message: TranscriptMessage, depth = 0): string {
  return transcriptSearchCorpus(message, depth).text
}

/** The full source-aware corpus of one message: raw text for compatibility
 * plus the normalized text/spans the indexed query path consumes. */
export function transcriptSearchCorpus(message: TranscriptMessage, depth = 0): TranscriptSearchCorpus {
  return buildSearchCorpus(searchChunksForMessage(message, depth))
}

function searchChunksForMessage(message: TranscriptMessage, depth: number): TranscriptSearchChunk[] {
  if (message.kind === 'tool') {
    const chunks: TranscriptSearchChunk[] = [
      { text: message.name, source: { kind: 'tool-field', field: 'name' } },
      { text: message.args, source: { kind: 'tool-field', field: 'args' } },
      { text: message.result, source: { kind: 'tool-field', field: 'result' } },
    ]
    if (message.subCalls !== undefined && message.subCalls.length > 0 && depth < PTC_MAX_DEPTH) {
      for (const child of message.subCalls) chunks.push(...searchChunksForSubCall(child, depth + 1, [child.subCallId ?? '']))
    }
    return chunks
  }
  if (message.kind === 'command') {
    return commandSearchChunks(message)
  }
  if (message.kind === 'compaction') {
    // A correlated manual compaction owns its command's searchable fields
    // (post-PR166 plan §7.4): the hidden raw command entry produces no hit
    // of its own, so search keeps finding the command through the card that
    // visibly owns it. Explicit `command-field` identity — never tool-field.
    const chunks: TranscriptSearchChunk[] = [{ text: message.text ?? '', source: { kind: 'message' } }]
    if (message.sourceCommand !== undefined) chunks.push(...commandSearchChunks(message.sourceCommand))
    return chunks
  }
  if (message.kind === 'workflow') {
    // The run's search identity (PR2 plan §13): the kind, the run name, the
    // current status, every phase's readable label (Unassigned/Empty stay
    // distinct) and every member's label + status. Machine identities
    // (childId/runId) are deliberately NOT indexed. A member hidden inside a
    // large phase's summary still hits its Workflow card (plan §13.1), and
    // the member's `phaseKey`/`seq` survive for the search-only context row.
    const chunks: TranscriptSearchChunk[] = [
      { text: 'workflow', source: { kind: 'workflow-run', field: 'kind' } },
      { text: message.name, source: { kind: 'workflow-run', field: 'name' } },
      { text: message.status, source: { kind: 'workflow-run', field: 'status' } },
    ]
    const phases = new Set<string>()
    for (const member of message.members) {
      const phaseKey = workflowPhaseKey(member.phase)
      if (phases.has(phaseKey)) continue
      phases.add(phaseKey)
      chunks.push({ text: workflowReadablePhase(member.phase), source: { kind: 'workflow-phase', phaseKey } })
    }
    if (message.members.length === 0) {
      // The legacy template always emitted BOTH group separators, so an empty
      // run's raw corpus keeps its two trailing spaces. The empty chunks carry
      // no searchable text; they only preserve `transcriptSearchText`.
      const empty = { text: '', source: { kind: 'workflow-run', field: 'kind' } } as const
      chunks.push(empty, empty)
      return chunks
    }
    for (const member of message.members) {
      const phaseKey = workflowPhaseKey(member.phase)
      chunks.push({ text: member.label, source: { kind: 'workflow-member', phaseKey, seq: member.seq, field: 'label' } })
      chunks.push({ text: member.status, source: { kind: 'workflow-member', phaseKey, seq: member.seq, field: 'status' } })
    }
    return chunks
  }
  if (message.kind === 'assistant' && message.deliverables !== undefined && message.deliverables.length > 0) {
    const chunks: TranscriptSearchChunk[] = [{ text: message.text, source: { kind: 'message' } }]
    message.deliverables.forEach((file, index) => {
      chunks.push({ text: file.path, source: { kind: 'assistant-deliverable', index, field: 'path' } })
      chunks.push({ text: file.description ?? '', source: { kind: 'assistant-deliverable', index, field: 'description' } })
    })
    return chunks
  }
  return [{ text: message.text ?? '', source: { kind: 'message' } }]
}

/** The searchable fields of one command row (post-PR166 plan §16): the
 * slash-prefixed name, the verbatim args, and the settled outcome text.
 * A running command contributes an empty outcome chunk so the spans stay
 * stable across settlement. */
function commandSearchChunks(message: TranscriptCommandMessage): TranscriptSearchChunk[] {
  return [
    { text: message.name === null ? '' : `/${message.name}`, source: { kind: 'command-field', field: 'name' } },
    { text: message.args ?? '', source: { kind: 'command-field', field: 'args' } },
    { text: message.outcome?.text ?? '', source: { kind: 'command-field', field: 'outcome' } },
  ]
}

function searchChunksForSubCall(message: TranscriptToolMessage, depth: number, path: readonly string[]): TranscriptSearchChunk[] {
  const chunks: TranscriptSearchChunk[] = [
    { text: message.name, source: { kind: 'subcall-field', subCallIds: path, field: 'name' } },
    { text: message.args, source: { kind: 'subcall-field', subCallIds: path, field: 'args' } },
    { text: message.result, source: { kind: 'subcall-field', subCallIds: path, field: 'result' } },
  ]
  if (message.subCalls !== undefined && message.subCalls.length > 0 && depth < PTC_MAX_DEPTH) {
    for (const child of message.subCalls) {
      chunks.push(...searchChunksForSubCall(child, depth + 1, [...path, child.subCallId ?? '']))
    }
  }
  return chunks
}

function buildSearchCorpus(chunks: readonly TranscriptSearchChunk[]): TranscriptSearchCorpus {
  const text = chunks.map(chunk => chunk.text).join(' ')
  const rawSpans: TranscriptSearchCorpusSpan[] = []
  let offset = 0
  for (const chunk of chunks) {
    const start = offset
    offset += chunk.text.length
    rawSpans.push({
      start,
      end: offset,
      source: chunk.source,
      sourceKey: transcriptSearchSourceKey(chunk.source),
    })
    offset += 1 // the single-space join separator
  }
  return { text, normalizedText: text.toLowerCase(), spans: normalizeSearchSpans(text, rawSpans) }
}

/** Map raw-coordinate span bounds into whole-string-lowercase coordinates.
 * The normalizer is JS `toLowerCase` over the WHOLE corpus (Unicode needs the
 * word context: a final sigma is `ς`, not `σ`), so the mapping is derived from
 * per-code-point lowercase LENGTHS — chunk-by-chunk lowercasing would change
 * the corpus (see the Greek-sigma regression test). */
function normalizeSearchSpans(raw: string, spans: readonly TranscriptSearchCorpusSpan[]): TranscriptSearchCorpusSpan[] {
  const map = rawToNormalizedIndex(raw)
  return spans.map(span => ({
    ...span,
    start: map[span.start] ?? span.start,
    end: map[span.end] ?? span.end,
  }))
}

function rawToNormalizedIndex(raw: string): number[] {
  const map = new Array<number>(raw.length + 1).fill(0)
  let normalized = 0
  let index = 0
  while (index < raw.length) {
    map[index] = normalized
    const codePoint = raw.codePointAt(index) ?? 0
    const size = codePoint > 0xffff ? 2 : 1
    normalized += raw.slice(index, index + size).toLowerCase().length
    if (size === 2) map[index + 1] = normalized
    index += size
  }
  map[raw.length] = normalized
  return map
}

/** Resolve the semantic source of one normalized-coordinate occurrence: the
 * span that owns the occurrence's START. A query crossing a chunk boundary
 * (`label` + `status`, tool name + args) keeps the FIRST chunk's owner, so a
 * cross-span Workflow member hit still reaches its run/phase/member reveal and
 * search-only context row. Only an occurrence starting INSIDE a join separator
 * (no owning span) falls back to the whole-card `message` source. */
export function resolveSearchSource(
  spans: readonly TranscriptSearchCorpusSpan[],
  matchStart: number,
): TranscriptSearchCorpusSpan | undefined {
  for (const span of spans) {
    if (span.start > matchStart) break
    if (matchStart < span.start || matchStart >= span.end) continue
    return span
  }
  return undefined
}
