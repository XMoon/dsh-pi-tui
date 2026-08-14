/**
 * Transcript folding: session events → renderable message list. Pure and
 * deterministic so the headless tests can drive it without a dsh tree.
 * Renders the HUMAN transcript (append-origin events), not the model-visible
 * surface: replacement copies shadowed by compaction stay out.
 *
 * Thinking (`reasoning-delta` chunks) and tool calls fold into collapsible
 * entries carrying their owning turn, so the view can expand only the most
 * recent turns (pi's Ctrl+O semantics).
 *
 * `TranscriptFolder` is the stateful engine: call `apply` with appended
 * events and read the message list; `foldTranscript` is the one-shot
 * wrapper. Both support an optional display window (`maxTurns`): turns older
 * than the window collapse into one summary entry, bounding the rendered
 * component tree on long sessions.
 * @module @dsh-pi-tui/tui-app/transcript
 */
import type { SessionEvent, SessionHeader, JsonValue } from '@deepseek-ai/dsh-session';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
/** One renderable message in the TUI transcript. */
export type TranscriptMessage = {
    kind: 'user';
    turn: number;
    text: string;
} | {
    kind: 'assistant';
    turn: number;
    text: string;
} | {
    kind: 'thinking';
    turn: number;
    text: string; /** Still streaming reasoning deltas for its step. */
    running?: boolean;
}
/** Injected context (system reminders, skill content) from non-user sources. */
 | {
    kind: 'system';
    turn: number;
    text: string;
} | {
    kind: 'tool';
    turn: number;
    name: string;
    args: string;
    result: string;
    status: 'ok' | 'error' | 'running';
    /** The completed result's content blocks, for tool-owned presentation. */
    resultBlocks?: readonly ContentBlock[];
    /** The tool-private presentation payload from the tool/result event. */
    meta?: JsonValue;
}
/** Older-than-window turns collapsed into one line (windowing). */
 | {
    kind: 'summary';
    text: string;
};
/** Fold options: the display window in turns. */
export interface FoldOptions {
    /** Keep this many most-recent turns; older turns collapse into a summary entry. */
    maxTurns?: number;
    /**
     * Window ENDS at this turn instead of the newest (pairs with `maxTurns`):
     * the kept turns are `[endTurn - maxTurns + 1 .. endTurn]`. Used by the
     * transcript search to jump the view to a match deep in history.
     */
    endTurn?: number;
}
/** Text of a message's content blocks, joined; empty when there is no text. */
export declare function textOf(blocks: readonly ContentBlock[]): string;
/**
 * The turn threshold at or above which entries count as "recent": the
 * `recentTurns` most recent distinct turns among the given message kinds.
 * Shared by the display window (all kinds), the markdown view, and the
 * Ctrl+O expansion boundary (foldable kinds only).
 * @param messages - the folded transcript.
 * @param recentTurns - how many most-recent turns survive; <= 0 keeps nothing.
 * @param kinds - kinds whose turns count; undefined counts every kind.
 * @returns the oldest recent turn number; 0 when everything is recent;
 *   `Infinity` when nothing is (every entry folds).
 */
export declare function recentTurnThreshold(messages: readonly TranscriptMessage[], recentTurns: number, kinds?: readonly TranscriptMessage['kind'][]): number;
/**
 * Collapse turns older than the display window into one leading summary
 * entry with aggregate counts. Entries at/after the boundary survive; the
 * result is a fresh array when anything collapses.
 * @param messages - the folded transcript.
 * @param maxTurns - window size in turns; entries of older turns collapse.
 * @param endTurn - window end turn (newest when absent), see {@link FoldOptions}.
 * @returns the windowed transcript.
 */
export declare function windowMessages(messages: readonly TranscriptMessage[], maxTurns: number, endTurn?: number): TranscriptMessage[];
/**
 * Merge consecutive completed `read` tool cards into one card ("N files").
 * A single read stays untouched; groups break on any other kind or status.
 * @param messages - the folded transcript.
 * @returns a new list with grouped read cards (same object references).
 */
export declare function groupConsecutiveReads(messages: readonly TranscriptMessage[]): TranscriptMessage[];
/**
 * Stateful transcript folding: apply appended events incrementally and read
 * the message list. Objects are mutated in place across applies, so a caller
 * that rebuilds its view from `messages()` stays consistent at every step.
 */
export declare class TranscriptFolder {
    private readonly items;
    /** The assistant message object per (turn, step); streaming text lands in place. */
    private readonly assistantEntries;
    /** The thinking entry object per (turn, step), for in-place text updates. */
    private readonly thinkingEntries;
    /** Tool calls awaiting their result, keyed by callId with their running card. */
    private readonly pendingCalls;
    /** Tool names by callId, for result pairing. */
    private readonly callNames;
    /** Command names by commandId, from command/run events. */
    private readonly commandNames;
    /** Workflow run cards by runId, for member/run settlement. */
    private readonly workflowRuns;
    /** Workflow member cards by `${runId}/${seq}`, for agent-end settlement. */
    private readonly workflowMembers;
    /** The turn most recently opened by turn/start. */
    private currentTurn;
    /**
     * Apply appended events in log order. Safe to call repeatedly with new
     * suffixes of the log.
     * @param events - the appended session events.
     */
    apply(events: readonly SessionEvent[]): void;
    /**
     * The folded messages. Without options this is the full transcript; with
     * `maxTurns` older turns collapse into one summary entry (fresh array).
     * @param options - optional display window.
     * @returns the renderable message list.
     */
    messages(options?: FoldOptions): TranscriptMessage[];
    /** The thinking entry object for one (turn, step), created on first reasoning. */
    private thinkingEntry;
    /** The assistant entry object for one (turn, step), created on first text. */
    private assistantEntry;
    private applyEvent;
}
/**
 * Fold a session event log into the transcript messages, in log order.
 * `assistant/chunk` text deltas accumulate into the assistant message of
 * their own (turn, step); `reasoning-delta` chunks accumulate into a
 * thinking entry. A tool call and its result merge into one card; an
 * unanswered call stays `running`.
 * @param events - the session log.
 * @param options - optional display window (older turns collapse).
 * @returns ordered renderable messages.
 */
export declare function foldTranscript(events: readonly SessionEvent[], options?: FoldOptions): TranscriptMessage[];
/** Render one session's log as a readable markdown transcript for `/export md`. */
export declare function renderTranscriptMarkdown(session: {
    header: SessionHeader;
    events: readonly SessionEvent[];
}): string;
