/**
 * Renderer-neutral process/action presentation facts (post-F6 addendum v2).
 *
 * This module owns the ONE collapsed `Action:` SOURCE authority and its
 * cardinality aggregate: which durable Process row is an Action candidate,
 * which candidate wins by chronology, and how counted occurrences aggregate
 * into the `N actions · subtype ×count` stats parts shared by the Focus header
 * and the Activity header.
 *
 * It is deliberately width/component/theme-free. The physical slot line, the
 * Preparing summary, the presenter bridge and the component cache signatures
 * belong to `tui/components/transcript/compact-process-preview.ts`; the
 * renderer-neutral Work summary lives in `tui/transcript/work-summary.ts`.
 *
 * `Action` is PRESENTATION ONLY — it never enters persistence/wire state and
 * never becomes a transcript semantic class.
 * @module @xmoon76/dsh-pi-tui/tui/transcript/process-summary
 */

import { isPostTurnReplayEvidence } from '../../domain/transcript/semantics.ts'
import type { TranscriptMessage, TranscriptToolMessage } from '../../domain/transcript/types.ts'
import { isSurfacedInteractionToolName } from '../../domain/transcript/semantics.ts'

/**
 * Human elapsed duration from millis: seconds under a minute, `m s` above.
 * The Focus turn timer and the Activity wall-span timer share one format so
 * the same label never means two shapes.
 */
export function formatCompactDuration(ms: number | undefined): string | undefined {
  if (ms === undefined) return undefined
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

// ── Shared collapsed-Action authority (addendum v2) ─────────────────────

/**
 * The presentation-only source of one collapsed `Action:` slot (addendum v2
 * §7): WHICH durable Process row the slot summarizes. `Action` is
 * pure presentation — this union never enters persistence/wire state and
 * never becomes a transcript semantic class. A live Preparing run is NOT a
 * source kind: it stays the ephemeral override the callers already render as
 * the shared Preparing summary.
 */
export type CompactActionSource =
  | { readonly kind: 'tool'; readonly message: TranscriptToolMessage }
  | { readonly kind: 'retry'; readonly message: Extract<TranscriptMessage, { kind: 'system' }> }
  | { readonly kind: 'orphan-tool-result'; readonly message: TranscriptToolMessage }

/**
 * Classify one transcript row as a collapsed-Action candidate
 * (presentation-convergence addendum v2 §8). The decision is source-driven
 * ONLY (kind + provenance + explicit call cardinality + the existing
 * surfaced-interaction predicate):
 *
 * - genuine `tool/call` (`origin` absent, `callCount > 0`) → `tool`;
 * - orphan result (`origin` absent, explicit `callCount === 0`) →
 *   `orphan-tool-result`;
 * - `origin: 'llm-retry'` system row → `retry`;
 * - surfaced-interaction tools (`ask_user_question` / `exit_plan_mode`)
 *   return `undefined` — their active/settled panel is the interaction
 *   owner and must never be duplicated as an Action (addendum v2 §5);
 * - a COMMAND row is a turn-less control-plane node (`kind: 'command'`,
 *   never `kind: 'tool'`), so it never reaches the tool branch below and is
 *   never an Action candidate;
 * - Thinking / Conversation / Context / Control / Workflow / Compaction /
 *   attention rows return `undefined`.
 */
export function compactActionSourceOf(message: TranscriptMessage): CompactActionSource | undefined {
  // Post-turn replay evidence is transcript/diagnostic evidence only: it
  // never counts as an action and never owns the collapsed Action slot
  // (the fold's late-replay fence, shared with Work membership and read
  // grouping).
  if (isPostTurnReplayEvidence(message)) return undefined
  if (message.kind === 'system') {
    return message.origin === 'llm-retry' ? { kind: 'retry', message } : undefined
  }
  if (message.kind !== 'tool' || isSurfacedInteractionToolName(message.name)) return undefined
  if (message.origin !== undefined) return undefined
  return (message.callCount ?? 1) > 0 ? { kind: 'tool', message } : { kind: 'orphan-tool-result', message }
}

/**
 * The latest eligible Action candidate in canonical chronology
 * (presentation-convergence addendum v2 §6/§9): ONE forward pass, the last
 * existing candidate wins — never a per-type score or a "Tool always beats
 * Retry" rule. Callers must pass only rows the collapsed surface
 * actually HIDES (Focus: the rows hidden under the collapsed Thought root;
 * Activity: the span's own members), so the slot never duplicates a row
 * already visible outside. This helper is presentation-only.
 */
export function latestCompactAction(
  messages: readonly TranscriptMessage[],
): CompactActionSource | undefined {
  let candidate: CompactActionSource | undefined
  for (const message of messages) {
    const source = compactActionSourceOf(message)
    if (source !== undefined) candidate = source
  }
  return candidate
}

// ── Shared Action statistics (presentation-convergence addendum v2 §13) ──

/** The presentation-only action aggregate both headers render: the TOTAL
 * counted action occurrences and the per-subtype counts (`read`, `bash`,
 * `subagent`, `retry`). Presentation-only —
 * never stored on `TurnActivity` or persisted (addendum v2 §17). */
export interface CompactActionStats {
  readonly total: number
  readonly types: ReadonlyMap<string, number>
}

/** The mutable accumulator {@link compactActionStatsOf} and the Activity
 * member walk share; exported so `summarizeWorkSpan` can fold the SAME
 * cardinality authority into its existing single pass (addendum v2 §23). */
export interface CompactActionStatsAccumulator {
  total: number
  types: Map<string, number>
}

/** Start one empty accumulator. */
export function newCompactActionStats(): CompactActionStatsAccumulator {
  return { total: 0, types: new Map() }
}

/** Fold ONE Action source into an accumulator using the shared action
 * cardinality rules (addendum v2 §14): a genuine tool contributes its
 * `callCount`; a subagent and a retry occurrence
 * contribute one each; an orphan result is diagnostic evidence and
 * contributes NOTHING. Preparing and surfaced interactions never reach
 * here (they are not `CompactActionSource`s). */
export function addCompactActionStats(
  stats: CompactActionStatsAccumulator,
  source: CompactActionSource,
): void {
  switch (source.kind) {
    case 'tool': {
      const calls = source.message.callCount ?? 1
      stats.total += calls
      stats.types.set(source.message.name, (stats.types.get(source.message.name) ?? 0) + calls)
      break
    }
    case 'retry':
      stats.total += 1
      stats.types.set('retry', (stats.types.get('retry') ?? 0) + 1)
      break
    case 'orphan-tool-result':
      break
  }
}

/**
 * Aggregate the Action stats of one message sequence through the shared
 * classifier + cardinality rules (addendum v2 §13/§14). This is the plan's
 * named neutral aggregator and the direct expression of the shared
 * cardinality contract — the test matrix consumes it as the counting oracle.
 * Production deliberately does NOT call it: Focus folds the WHOLE turn in
 * one turn-keyed pre-pass (`focusActionStatsByTurn`) and Activity folds its
 * span in `summarizeWorkSpan`'s existing single member walk (addendum v2
 * §23/§63 — no second scan). The scope decision (WHICH rows) always belongs
 * to the caller.
 */
export function compactActionStatsOf(messages: readonly TranscriptMessage[]): CompactActionStats {
  const stats = newCompactActionStats()
  for (const message of messages) {
    const source = compactActionSourceOf(message)
    if (source !== undefined) addCompactActionStats(stats, source)
  }
  return stats
}

/** The max action-subtype names the header stats show before the `+N` tail
 * (addendum v2 §15 — the Focus rule, now shared). */
export const COMPACT_ACTION_SUMMARY_MAX_TYPES = 3

/**
 * The header stat parts (`7 actions`, `read ×3`, …, `+1`): types sorted
 * count-desc / name-asc, capped at {@link COMPACT_ACTION_SUMMARY_MAX_TYPES},
 * with a `+N` remainder counting the OTHER action SUBTYPES (not
 * occurrences). Focus and Activity share this ONE formatter (addendum v2
 * §12/§15); an empty aggregate yields no parts (never a fake `0 actions`).
 */
export function compactActionStatParts(stats: CompactActionStats): string[] {
  if (stats.total <= 0) return []
  const parts = [`${stats.total} action${stats.total === 1 ? '' : 's'}`]
  const types = [...stats.types.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  for (const [name, count] of types.slice(0, COMPACT_ACTION_SUMMARY_MAX_TYPES)) {
    parts.push(`${name} ×${count}`)
  }
  if (types.length > COMPACT_ACTION_SUMMARY_MAX_TYPES) {
    parts.push(`+${types.length - COMPACT_ACTION_SUMMARY_MAX_TYPES}`)
  }
  return parts
}
