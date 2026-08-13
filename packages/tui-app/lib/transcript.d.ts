/**
 * Transcript folding: session events → renderable message list. Pure and
 * deterministic so the headless tests can drive it without a dsh tree.
 * Renders the HUMAN transcript (append-origin events), not the model-visible
 * surface: replacement copies shadowed by compaction stay out.
 *
 * Thinking (`reasoning-delta` chunks) and tool calls fold into collapsible
 * entries carrying their owning turn, so the view can expand only the most
 * recent turns (pi's Ctrl+O semantics).
 * @module @dsh-pi-tui/tui-app/transcript
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** One renderable message in the TUI transcript. */
export type TranscriptMessage = {
    kind: 'user';
    text: string;
} | {
    kind: 'assistant';
    text: string;
} | {
    kind: 'thinking';
    turn: number;
    text: string;
} | {
    kind: 'tool';
    turn: number;
    name: string;
    args: string;
    result: string;
    status: 'ok' | 'error' | 'running';
};
/**
 * Fold a session event log into the transcript messages, in log order.
 * `assistant/chunk` text deltas accumulate into the assistant message of
 * their own (turn, step); `reasoning-delta` chunks accumulate into a
 * thinking entry. A tool call and its result merge into one card; an
 * unanswered call stays `running`.
 * @param events - the session log.
 * @returns ordered renderable messages.
 */
export declare function foldTranscript(events: readonly SessionEvent[]): TranscriptMessage[];
/**
 * Render the transcript as one Markdown document for the TUI's Markdown view.
 * Collapsible entries render in their folded form (preview lines + hint);
 * use the component view for expandable rendering.
 * @param messages - the folded transcript.
 * @param expandedTurns - turns whose collapsible entries render expanded.
 * @returns the markdown document.
 */
export declare function renderTranscript(messages: readonly TranscriptMessage[], expandedTurns?: number): string;
