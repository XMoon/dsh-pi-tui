/**
 * Transcript folding: session events → renderable message list. Pure and
 * deterministic so the headless tests can drive it without a dsh tree.
 * Renders the HUMAN transcript (append-origin events), not the model-visible
 * surface: replacement copies shadowed by compaction stay out.
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
    kind: 'tool';
    name: string;
    text: string;
};
/**
 * Fold a session event log into the transcript messages, in log order.
 * `assistant/chunk` text deltas accumulate into the message of their own
 * (turn, step); an `assistant/message` replaces the accumulated chunk text
 * for that step (identical content, now complete).
 * @param events - the session log.
 * @returns ordered renderable messages.
 */
export declare function foldTranscript(events: readonly SessionEvent[]): TranscriptMessage[];
/** Render the transcript as one Markdown document for the TUI's Markdown view. */
export declare function renderTranscript(messages: readonly TranscriptMessage[]): string;
