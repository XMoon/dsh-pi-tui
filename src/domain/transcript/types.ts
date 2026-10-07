/**
 * Canonical transcript semantic carrier types (TS7).
 *
 * The transport/UI-neutral shapes the ONE transcript fold produces and every
 * consumer reads: message carriers, timing/activity facts, fold options, the
 * Context form/provenance carriers and the shared constants. Behaviour lives in
 * the sibling domain modules; this module owns no mutable state.
 * @module @xmoon76/dsh-pi-tui/domain/transcript/types
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Load the official event declarations the carriers are derived from.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type { IconSemantic } from '../../icons.ts'
import type { TokenUsageTotals } from './usage.ts'
import type { TranscriptWorkflowMessage } from './workflow-projection.ts'

/**
 * A JSON-serializable value (the tool-private presentation payload shape).
 * DSH 0.1.2-alpha.2 moved `JsonValue` from `@deepseek-ai/dsh-session` to
 * `@deepseek-ai/dsh-util-values`; the TUI keeps a local type-only copy so the
 * presentation surface needs no new peer dependency. Identical to the official
 * recursive definition. Canonical owner since TS7 — `src/present.ts` re-exports
 * it for compatibility.
 */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * The producer-declared context-form vocabulary of `@deepseek-ai/dsh-llm`.
 * Kept as a local structural union instead of an imported type: the fold
 * records the SEMANTIC value it saw, and an unknown future value must
 * degrade to `undefined` (standalone generic Context), never be coerced
 * into an ambient role.
 */
export type TranscriptContextForm =
  | 'instructions'
  | 'catalog'
  | 'snapshot'
  | 'notice'
  | 'relay'
  | 'recall'

/** The presentation-only context provenance a folded system row retains. */
export interface TranscriptContextPresentation {
  /** The producer-declared form; undefined for unknown/legacy producers. */
  readonly form?: TranscriptContextForm
  /** The raw source `kind` (who produced it), when readable. */
  readonly sourceKind?: string
  /** The sending session for relay/notice forms, when present. */
  readonly senderSessionId?: string
  /** recall for a cross-session reference; inject for everything else. */
  readonly role: 'inject' | 'recall'
}

/** The role and producer name to present for one logged context source. */
export interface ContextProvenance {
  /** recall for a cross-session reference; inject for everything else. */
  role: 'inject' | 'recall'
  /** The producer name (file path, plugin name, skill name); null when unreadable. */
  label: string | null
}

/**
 * Presentation-only Assistant blocks. An `open-opaque` item records that a
 * block has started without inventing a finalized ContentBlock or payload.
 */
export type AssistantDisplayBlock =
  | { readonly kind: 'content'; readonly block: ContentBlock }
  | { readonly kind: 'open-opaque'; readonly blockType: string }

/** A file declared by the durable `deliverables/presented` event. */
export interface PresentedFilePresentation {
  readonly path: string
  readonly description?: string
}

/** Source-derived origins for synthetic system presentation rows. */
export type TranscriptSystemOrigin = 'llm-retry' | 'turn-max-tokens'

/** Source-derived origins for synthetic tool presentation rows. */
export type TranscriptToolOrigin = 'turn-error' | 'turn-interrupted' | 'tool-not-started'

/** The official command pairing identity (`command/run`/`command/done`),
 * derived from the official event payload — never a plain-string alias. */
export type CommandId = Extract<SessionEvent, { type: 'command/run' }>['data']['commandId']

/** The official durable event sequence identity (a branded integer). */
export type SessionEventSeq = SessionEvent['seq']

/** One settled command outcome: the handler's verbatim result plus, for a
 * success, the optional earlier authoritative domain event that owns a
 * richer presentation (the official `sourceEventSeq` relationship). */
export interface TranscriptCommandOutcome {
  readonly kind: 'success' | 'error'
  readonly text?: string
  readonly sourceEventSeq?: SessionEventSeq
}

/**
 * A real session-level slash-command transcript node: `command/run` creates
 * the running row, `command/done` settles the SAME row in place, paired by
 * {@link CommandId}. It mirrors the official CommandNode semantics and
 * deliberately carries NO semantic `turn` — DSH appends the command
 * lifecycle as direct log-only events, so the row is standalone
 * control-plane evidence, never model-turn Process/Action input. Window and
 * search placement is a presentation concern resolved from the physical log
 * position, never stored here as an owning turn.
 */
export interface TranscriptCommandMessage {
  kind: 'command'
  /** The `command/run` pairing identity. */
  readonly commandId: CommandId
  /** The run event's seq/time; the done event's for a fragment-only fallback. */
  readonly seq: SessionEventSeq
  readonly time: number
  /** Null only for a `command/done` fragment whose run event is unavailable. */
  readonly name: string | null
  readonly args: string | null
  /** Null between command/run and command/done. */
  outcome: TranscriptCommandOutcome | null
}

/**
 * The bounded reasoning tail cap: previews never buffer the full reasoning
 * stream. Shared with the compact Think preview (post-F6 plan §8.3) so the
 * preview bound comes from the ONE existing constant, never a duplicate
 * magic number.
 */
export const THINKING_TAIL_CAP = 400

/**
 * Presentation-only timing sidecar for one transcript row (post-F6 plan
 * §12.4): the wall-clock span its OWN durable Process evidence covers, from
 * `SessionEvent.time` (never a second clock). `running` is true while the
 * row's authoritative end has not landed; an `endedAt` may be missing even
 * when settled (an abandoned attempt has no authoritative end) — consumers
 * treat unknown as UNKNOWN, never zero (plan §12.16).
 */
export interface TranscriptTiming {
  readonly startedAt: number
  readonly endedAt?: number
  readonly running: boolean
}

/** One renderable message in the TUI transcript. */
export type TranscriptMessage =
  /**
   * A direct human prompt. `text` is the flat text (search/title/queue
   * recall); `content` carries the FULL ordered blocks when the message had
   * non-text content — attachment and generic presentation renders it in
   * order (plan §15).
   */
  | {
    kind: 'user'
    turn: number
    text: string
    content?: readonly ContentBlock[]
    /** Presentation-only marker for a next-step input inserted during this turn. */
    steer?: true
  }
  /**
   * One step's model output. `text` is the flat markdown; `content` is the
   * settled message's full blocks when the step carried any role-neutral
   * non-text content (attachments and future blocks render rather than crash,
   * plan §15.3). `displayBlocks` is presentation-only evidence for an open
   * opaque block and is never durable model content.
   */
  | {
    kind: 'assistant'
    turn: number
    text: string
    content?: readonly ContentBlock[]
    /** Ordered presentation blocks while an opaque block is still open. */
    displayBlocks?: readonly AssistantDisplayBlock[]
    /** Durable interruption evidence; presentation metadata, not body text. */
    interrupted?: true
    /** Explicit files delivered before this closing assistant message. */
    deliverables?: readonly PresentedFilePresentation[]
  }
  | { kind: 'thinking'; turn: number; text: string; /** Still streaming reasoning deltas for its step. */ running?: boolean }
  /**
   * Injected context (system reminders, skill content) from non-user sources.
   * Labeled entries carry the Web-provenance producer name (e.g. AGENTS.md,
   * @deepseek-ai/dsh-system-prompt, skill-catalog), a source-kind icon
   * SEMANTIC (never a concrete glyph — the renderer resolves the palette),
   * and, for notice forms, the producer's one-line summary. `context` is the
   * source-derived semantic marker distinguishing injected context from
   * other `kind: 'system'` presentation rows (llm/retry, max-tokens), which
   * are orchestration and must never be treated as turn foundation.
   */
  | {
    kind: 'system'
    turn: number
    text: string
    label?: string
    summary?: string
    icon?: IconSemantic
    context?: true
    origin?: TranscriptSystemOrigin
    /**
     * Presentation-only provenance for an injected Context row: the
     * producer-declared form, the raw source kind and a relay/notice
     * sender. Never part of the semantic class — `context` stays the
     * surfaced authority.
     */
    contextPresentation?: TranscriptContextPresentation
  }
  | TranscriptToolMessage
  | TranscriptWorkflowMessage
  /** Older-than-window turns collapsed into one line (windowing). */
  | { kind: 'summary'; text: string }
  /**
   * A context-compaction card: created at `compaction/start` (running),
   * filled by `compaction/summary` (shadowed item/token counts + the
   * summary body), settled by `compaction/end` (error on failure). The
   * collapsed card shows the title + the counts; expanding reveals the
   * summary markdown.
   */
  | {
    kind: 'compaction'
    turn: number
    /** The summary body (markdown), filled when compaction/summary lands. */
    text: string
    /** Shadowed history items (the shadowedSeqs count). */
    items: number
    /** Shadowed token estimate. */
    tokens: number
    /** In-progress until compaction/end settles it. */
    running?: boolean
    /** Non-empty when compaction/end carried an error. */
    error?: string
    /**
     * Presentation-only manual-compaction correlation (post-PR166 plan §7.1):
     * the initiating command identity when the official compaction lifecycle
     * events carry `sourceCommandId`, the `compaction/summary` event seq, and
     * the fused `kind: 'command'` row once an authoritative relationship is
     * proven. Never new Session facts — the card is the sole visible owner of
     * a correlated manual compaction.
     */
    sourceCommandId?: CommandId
    summaryEventSeq?: SessionEventSeq
    sourceCommand?: TranscriptCommandMessage
  }
  | TranscriptCommandMessage

/**
 * One tool card — a top-level surface item OR a PTC nested sub-call.
 * Nested sub-calls (DSH `tool/ptc-dispatch` events) are recursively
 * attached to their parent card via `subCalls` and NEVER join the top-level
 * surface flow (upstream PTC contract: sub-calls never join nodes). Each
 * child reuses the ordinary tool-card shape and carries its durable
 * `subCallId` so renderers can rebuild the recursive tree from card
 * identity.
 */
export interface TranscriptToolMessage {
  kind: 'tool'
  turn: number
  name: string
  args: string
  result: string
  status: 'ok' | 'error' | 'running'
  /** Source-derived provenance for synthetic non-model tool rows. */
  origin?: TranscriptToolOrigin
  /**
   * Genuine model `tool/call` cardinality: HOW MANY real tool/call events
   * this card carries. Only a MERGED read-group card sets it (the merged
   * sum — two grouped reads are still TWO calls, never `"2 files" → 1`);
   * a plain card is one call by definition, so absence means 1. Synthetic
   * rows carry `origin` instead and never count toward `tools`.
   */
  callCount?: number
  /** The completed result's content blocks, for tool-owned presentation. */
  resultBlocks?: readonly ContentBlock[]
  /** The tool-private presentation payload from the tool/result event. */
  meta?: JsonValue
  /** The PRIMARY model `tool/call` identity (M3-3B): lets a presentation
   *  consumer key authoritative out-of-band evidence (the `userQuestions`
   *  settled projection) to this exact card. Absent on synthetic rows. */
  callId?: string
  /** The structured internal failure identity (`{name, code}`), when the
   * tool/result event carried one (e.g. `UserQuestionError` with
   * `ASK_CANCELLED` / `ASK_ABORTED` for a cancelled question flow). */
  error?: { name: string; code: string }
  /** PTC nested sub-calls, recursively attached to this card. */
  subCalls?: TranscriptToolMessage[]
  /** PTC sub-call identity (the durable `subCallId`), for tree rebuilds. */
  subCallId?: string
  /** PTC sub-call topology: the immediate parent call identity and the
   * outer `run_code` call identity, preserved from the durable event
   * payload so replay and tree rebuilds keep the full parent chain. */
  parentCallId?: string
  rootCallId?: string
  /** PTC subtree mutation revision: bumped on every sub-call start/settle
   * under this card. The render cache compares it so live PTC updates
   * (in-place child mutations) invalidate the component even though the
   * `subCalls` array reference never changes. */
  subtreeRevision?: number
}

/** Stable identity of one raw transcript item within ONE TranscriptFolder
 * lifetime. The raw item's index doubles as its id: `items` is strictly
 * append-only, so an id keeps pointing at the same logical source through
 * streaming, settlement and read-group reflow — the visible card OBJECT may
 * be replaced (or merged into a group), the id never is. Ids are
 * session-local by construction: a new folder starts a fresh namespace.
 * @see TranscriptSearchMatch
 */
export type TranscriptItemId = number

/** The turn-end reason surface Focus reads (structural — never a full
 * dsh type import; the official kind names are kept verbatim). */
export interface TurnEndReason {
  readonly kind: string
  readonly error?: { readonly code: string; readonly message: string }
}

/** The official turn-end reason kinds (Harness TurnEndReason): Focus maps
 * them for presentation but NEVER invents names of its own (plan §13.2). */
export const TURN_END_REASON_KINDS = [
  'completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted',
] as const

/**
 * One turn's aggregated activity for the Focus projection (plan §10):
 * timing from `SessionEvent.time` (never a second clock), tool statistics
 * counted on `tool/call` ONLY (a call/result pair is one call), and the
 * three compact process slots — Think / Message / Tool — plus the per-turn
 * token usage. Maintained incrementally by {@link TranscriptFolder.apply}
 * alongside the message fold — never a rescan of the session log.
 *
 * The slots are SEMANTIC, decided by the event stream (plan §57):
 * `reasoning-delta` → Think, assistant text → Message, `tool/call` → Tool.
 * Presentation (whale icons, titles, truncation) lives in the Focus
 * presentation layer, never here.
 */
export interface TurnActivity {
  /** The owning turn number. */
  readonly turn: number
  /** `turn/start.time` (Unix epoch ms). Absent for legacy/corrupt logs. */
  readonly startedAt?: number
  /** `turn/end.time`; absent while the turn is still open. */
  readonly endedAt?: number
  /** Settled by the authoritative `turn/end` event. */
  readonly completed: boolean
  /** The OFFICIAL harness reason kind (completed/aborted/blocked/error/
   * max-tokens/interrupted) — never an invented name. */
  readonly reason?: TurnEndReason
  /** The Think slot: the latest meaningful line of the bounded reasoning
   * tail (compact preview only — never the raw reasoning stream), plus the
   * authoritative reasoning lifecycle fact: `running` is true only while
   * that step's reasoning entry still streams. A turn can keep running
   * (tool execution, further model output) after reasoning settled, so the
   * Focus follow-end gate reads THIS, never `completed`. */
  readonly think?: { readonly text: string; readonly running: boolean }
  /** The Message slot: the bounded LATEST TAIL of the current candidate /
   * confirmed intermediate assistant text, kept MULTILINE (the Focus
   * renderer wraps it to the current width and shows the last three
   * visual rows — a single-line flatten would destroy that). The FINAL
   * answer never enters this slot (it renders outside the Thought). */
  readonly message?: { readonly text: string }
  /** The Tool slot: the LATEST real `tool/call` (any name — event-first
   * classification), settled by its own `tool/result` only. */
  readonly tool?: {
    readonly callId: string
    readonly name: string
    readonly args: string
    readonly status: 'running' | 'ok' | 'error'
    /** PTC active descendants (running sub-calls), aggregated by tool
     * name in durable dispatch order — presentation metadata ONLY: never
     * part of the tool stats, never the root Tool slot. */
    readonly activeSubCalls?: readonly { readonly name: string; readonly count: number }[]
  }
  /** The per-turn token totals (committed steps + open steps' current
   * usage); absent when the turn has no usage fact at all. */
  readonly usage?: TokenUsageTotals
  /** The display total (input + cache read + cache write + output). */
  readonly totalTokens?: number
  /** Whether the exact last assistant has a visible Assistant projection.
   * This remains separate from the visible row list so an empty authoritative
   * settlement cannot make final selection fall back to an earlier answer. */
  readonly lastAssistantVisible?: boolean
  /** Settled assistant/message count for the turn. */
  readonly assistantMessages: number
  /** tool/call count (never double-counted on tool/result). */
  readonly toolCalls: number
  /** Per-tool call counts, for the `read ×4 · search ×3` header stats. */
  readonly tools: ReadonlyMap<string, number>
  /** Monotonic revision, bumped on every visible change — the Focus
   * render-cache key (plan §39). */
  readonly revision: number
}

/** The internal mutable activity; exposed snapshots are read-only views. */
export interface MutableTurnActivity {
  turn: number
  startedAt?: number
  endedAt?: number
  completed: boolean
  reason?: TurnEndReason
  /** The rolling reasoning tail (preview only, bounded). */
  thinkingTail: string
  /** The materialized Think slot (latest meaningful line) plus the live
   * reasoning-running fact mirrored from its thinking entry. */
  think?: { text: string; running: boolean }
  /** The step that currently owns the Focus reasoning preview. */
  thinkingStep?: number
  /** The streaming assistant text of the CURRENT step (bounded tail —
   * the authoritative settled text replaces the tail once
   * assistant/message lands; never a second full copy of the output,
   * plan §34). */
  messageCandidate?: {
    step: number
    tail: string
  }
  /** An earlier candidate confirmed as an intermediate message (by a
   * later tool/call, a later step, or later output). */
  messageConfirmed?: string
  /** The step of the LATEST confirmed intermediate message: a late
   * authoritative message for THAT step updates the confirmed text in
   * place (never a stale streamed fragment). */
  messageConfirmedStep?: number
  /** Every step whose candidate was confirmed: a late message for an
   * OLDER confirmed step is ignored (the slot shows the latest
   * intermediate) and never resurrects a candidate (review finding). */
  confirmedSteps: Set<number>
  /** Every step whose output was AUTHORITATIVELY settled by an
   * assistant/message: a later text-delta for it is a replay artifact and
   * is ignored — it must never corrupt the settled preview (review
   * finding). */
  settledSteps: Set<number>
  /** The exact previous assistant step that may become persistent when the
   * next step admits a same-turn human steer. */
  pendingPreSteerAnswerStep?: number
  /** First visible Assistant output timestamp per step. This is private
   * timing evidence for the steer boundary, not a rendered fact. */
  firstVisibleAssistantTimes: Map<number, number>
  /** Assistant steps that crossed an admitted human-steer boundary and are
   * therefore persistent conversation answers rather than Focus process. */
  committedAnswerSteps: Set<number>
  /** The step of the turn's LAST assistant output (streaming or settled)
   * — the turn/end final-answer check compares the candidate's step
   * against this. */
  lastAssistantStep?: number
  /** Whether the exact last assistant has a visible Assistant projection. */
  lastAssistantVisible?: boolean
  /** The materialized Message slot (candidate ?? confirmed, bounded
   * multiline tail). */
  message?: { text: string }
  /** The Tool slot: the latest real tool/call, settled by its own result. */
  tool?: {
    callId: string
    name: string
    args: string
    status: 'running' | 'ok' | 'error'
    /** PTC active descendants (running sub-calls), aggregated by tool
     * name in durable dispatch order — presentation metadata ONLY: never
     * part of the tool stats, never the root Tool slot. */
    activeSubCalls?: readonly { name: string; count: number }[]
  }
  /** The per-turn token totals (committed + open steps' current usage). */
  usage?: TokenUsageTotals
  /** The display total (input + cache read + cache write + output). */
  totalTokens?: number
  assistantMessages: number
  toolCalls: number
  tools: Map<string, number>
  revision: number
}

/** Fold options: the display window in turns. */
export interface FoldOptions {
  /** Keep this many most-recent turns; older turns collapse into a summary entry. */
  maxTurns?: number
  /**
   * Window ENDS at this turn instead of the newest (pairs with `maxTurns`):
   * the kept turns are `[endTurn - maxTurns + 1 .. endTurn]`. Used by the
   * transcript search to jump the view to a match deep in history.
   */
  endTurn?: number
}

/** The PTC sub-call tree depth cap (upstream alpha.2 Web MAX_DEPTH): the
 * ingestion gate in {@link attachSubCall} rejects any edge that would push
 * a sub-call past this depth (root = depth 1, so at most 255 child levels),
 * and the recursive consumers keep a defensive guard at the same bound — a
 * corrupted/replayed input can never overflow the stack. */
export const PTC_MAX_DEPTH = 256
