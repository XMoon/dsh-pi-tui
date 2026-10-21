/**
 * Canonical transcript semantic classification and row-provenance evidence (TS7).
 *
 * Classification is source/kind driven and deliberately ignores display text,
 * tool names, and error wording. Compact and later Work-span projections consume
 * this vocabulary without rebuilding a second transcript.
 *
 * The post-turn replay sidecar lives here too: "this row materialized after its
 * owning turn's `turn/end`" is source-derived semantic provenance consumed by
 * the ONE grouping eligibility authority AND by the presentation core, so it
 * cannot live inside the folder without creating a folder <-> grouping value
 * cycle.
 * @module @xmoon76/dsh-pi-tui/domain/transcript/semantics
 */

import type {
  TranscriptMessage,
  TranscriptSystemOrigin,
  TranscriptToolOrigin,
} from './types.ts'

/** The five semantic layers used by the shared transcript projection.
 * `control` is standalone control-plane evidence (slash commands) — never
 * Process aggregation input, never Context. */
export type TranscriptSemanticClass = 'conversation' | 'process' | 'attention' | 'context' | 'control'

/** Source-derived origins for the currently ambiguous presentation rows. */
export type TranscriptSemanticOrigin =
  | TranscriptSystemOrigin
  | TranscriptToolOrigin
  | 'command'
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
      if (
        message.origin === 'turn-error'
        || message.origin === 'turn-interrupted'
        || message.origin === 'tool-not-started'
      ) {
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
    case 'command':
      // A slash command is a standalone control-plane lifecycle node: it
      // owns no model turn and is never Work/Activity/Action/ActionStats
      // input by construction — the `control` class excludes it from every
      // Process aggregation without a predicate blacklist.
      return { class: 'control', origin: 'command' }
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

/**
 * The tool names whose SETTLED card is surfaced human-interaction evidence —
 * durable human decisions, not ordinary work. PR4's authoritative set is
 * exactly these two: `ask_user_question` (the user's answers) and
 * `exit_plan_mode` (the user's Plan review / approval result). Every other
 * tool stays Process regardless of how rich its card looks or whether its
 * execution happened to require an approval.
 */
export const SURFACED_INTERACTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'ask_user_question',
  'exit_plan_mode',
])

/** Whether one tool NAME belongs to the surfaced-interaction set, regardless of
 * settled state. The fold uses this to keep such calls out of the turn's work
 * accounting even while they are running. */
export function isSurfacedInteractionToolName(name: string): boolean {
  return SURFACED_INTERACTION_TOOL_NAMES.has(name)
}

/**
 * Whether one tool row is SETTLED human-interaction evidence rather than
 * ordinary work-process evidence. The decision is source/tool identity only
 * (kind + a name in {@link SURFACED_INTERACTION_TOOL_NAMES} + settled status) —
 * never the display title or the result wording. A RUNNING question / plan
 * review is owned by its active interaction panel and must NOT become a
 * duplicate surfaced card. This orthogonal projection role deliberately does
 * NOT add a fifth semantic class, and unknown tools stay Process.
 */
export function isSurfacedInteractionTool(message: TranscriptMessage): boolean {
  return message.kind === 'tool' && isSurfacedInteractionToolName(message.name) && message.status !== 'running'
}

/**
 * Post-turn replay evidence: the rows that MATERIALIZED after their owning
 * turn's authoritative `turn/end` (weakly held sidecar — the fact dies with
 * its row). The fold is the ONLY authority that can know this: a row's
 * `turn`/`kind` alone cannot distinguish a durable row of a settled turn from
 * a replay artifact that arrived afterwards.
 *
 * The provenance is exactly "this row was NEWLY created after the turn
 * completed" — NEVER "this row was touched by a post-`turn/end` event". A
 * `tool/result` that finds its own pending/running card still settles that
 * card normally and leaves it fully legal Action evidence; only a newly
 * created row (an orphan result or a fresh synthetic call card) earns the
 * mark.
 *
 * Consumers share this ONE predicate so no surface invents its own fence:
 * - the transcript keeps the row (search / Full / expanded Focus);
 * - it is never Process aggregation evidence: it is excluded from the Action
 *   classifier, from Work-span membership, and from consecutive-read
 *   grouping (a group card is a synthesized object that could otherwise
 *   launder the provenance back into an aggregate).
 */
const postTurnReplayEvidence = new WeakSet<TranscriptMessage>()

/** Whether one row materialized after its owning turn's `turn/end` (see
 * {@link postTurnReplayEvidence}). Presentation/persistence consumers use
 * this to keep the row as transcript evidence while excluding it from the
 * settled turn's Process/Action aggregates. */
export function isPostTurnReplayEvidence(message: TranscriptMessage): boolean {
  return postTurnReplayEvidence.has(message)
}

/** Mark one newly materialized row as post-turn replay evidence
 * (fold-internal authority — called ONLY where a row is created while its
 * owning turn is already `completed`). */
export function markPostTurnReplayEvidence(message: TranscriptMessage): void {
  postTurnReplayEvidence.add(message)
}
