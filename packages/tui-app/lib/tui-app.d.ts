/**
 * The dsh-pi-tui application core: a small TUI surface over the pi-tui
 * framework. The terminal is injected so tests can drive a headless
 * virtual terminal (@xterm/headless) instead of a real TTY; the process
 * entry point (startProcessTui) supplies ProcessTerminal.
 * @module @dsh-pi-tui/tui-app/tui-app
 */
import { type Terminal } from '@dsh-pi-tui/pi-tui';
/** Callbacks the application surface reports to its host (the dsh bundle). */
export interface TuiAppEvents {
    /** The user submitted a line in the editor. */
    onSubmit: (text: string) => void;
    /** The user asked to quit (Ctrl+C in the TUI's own raw mode). */
    onExit: () => void;
}
/** What an approval prompt shows; mirrors the approval/request payload. */
export interface ApprovalPromptRequest {
    /** The tool asking for permission. */
    toolName: string;
    /** The asker's human-readable reason, when one exists. */
    reason?: string;
    /** Aborting withdraws the prompt and settles `cancelled`. */
    signal?: AbortSignal;
}
/** Closed approval outcomes the user can produce at the prompt. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled';
/** One todo entry as logged by todo/write; statuses and text verbatim. */
export interface TodoItem {
    content: string;
    status: 'pending' | 'in_progress' | 'completed';
}
/**
 * The minimal interactive surface: a header line plus a multiline editor.
 * Owns the TUI lifecycle; input routing and rendering decisions live here
 * so they are testable without a real terminal.
 */
export declare class TuiApp {
    private readonly tui;
    private readonly editor;
    private readonly markdown;
    private readonly header;
    private readonly events;
    /** Prompts awaiting the user's decision; one is shown at a time. */
    private readonly approvalQueue;
    /** The prompt currently on screen, if any. */
    private activeApproval;
    constructor(terminal: Terminal, events: TuiAppEvents);
    /** Enter raw mode and start rendering. */
    start(): void;
    /** Leave raw mode and stop rendering. */
    stop(): void;
    /** Replace the transcript body and request a re-render. */
    setTranscript(text: string): void;
    /**
     * Reflect the todo list in the header line: active (non-completed) count
     * and, when the list is non-empty, the first active item's text.
     * @param todos - the latest todo/write snapshot.
     */
    setTodoSummary(todos: readonly TodoItem[]): void;
    /**
     * Queue an approval prompt and resolve when the user decides. Requests
     * queue FIFO; only one dialog is on screen at a time. An aborted signal
     * settles the prompt `cancelled` immediately.
     * @param request - the tool, reason, and optional abort signal.
     * @returns the user's decision.
     */
    showApprovalPrompt(request: ApprovalPromptRequest): Promise<ApprovalOutcome>;
    /** Render the next queued prompt, if any and none is showing. */
    private showNextApproval;
    /** Route a key while a prompt is showing; every key is consumed. */
    private handleApprovalKey;
    /** Resolve one prompt, hide its dialog, and show the next in line. */
    private settleApproval;
}
/** Start the TUI on the process terminal (raw-mode stdin/stdout). */
export declare function startProcessTui(events: TuiAppEvents): TuiApp;
