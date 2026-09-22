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

/**
 * Whether one row is a COMMAND row (a session-level slash-command record).
 *
 * A command's lifecycle is standalone: DSH appends `command/run` /
 * `command/done` as direct log-only events — "no turn wraps them" — and the
 * settled result is rendered OUTSIDE model history. The row therefore carries
 * no semantic turn ownership (its `turn` field is a legacy display-placement
 * artifact only), so it is NEVER Process aggregation evidence: not a Work
 * member, not an Action candidate/count, and not turn ActionStats input.
 * This is the ONE shared predicate for that rule.
 */
export function isCommandTool(message: TranscriptMessage): boolean {
  return message.kind === 'tool' && message.origin === 'command'
}

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
