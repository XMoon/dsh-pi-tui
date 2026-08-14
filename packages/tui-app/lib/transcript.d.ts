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
import type { SessionEvent } from '@deepseek-ai/dsh-session';
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
    text: string;
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
}
/**
 * Collapse turns older than the display window into one leading summary
 * entry with aggregate counts. Entries at/after the boundary survive; the
 * result is a fresh array when anything collapses.
 * @param messages - the folded transcript.
 * @param maxTurns - window size in turns; entries of older turns collapse.
 * @returns the windowed transcript.
 */
export declare function windowMessages(messages: readonly TranscriptMessage[], maxTurns: number): TranscriptMessage[];
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
    /** Streaming text per (turn, step); an assistant message for that step is the same slot. */
    private readonly stepText;
    /** Streaming reasoning per (turn, step), folded into one thinking entry. */
    private readonly stepReasoning;
    /** The assistant message object per (turn, step), for in-place text updates. */
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
/**
 * Render the transcript as one Markdown document for the TUI's Markdown view.
 * Collapsible entries render in their folded form (preview lines + hint);
 * use the component view for expandable rendering.
 * @param messages - the folded transcript.
 * @param expandedTurns - turns whose collapsible entries render expanded.
 * @returns the markdown document.
 */
export declare function renderTranscript(messages: readonly TranscriptMessage[], expandedTurns?: number): string;
