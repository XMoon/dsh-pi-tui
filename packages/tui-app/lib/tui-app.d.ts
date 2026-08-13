/**
 * The dsh-pi-tui application core: the interactive surface over the pi-tui
 * framework. The terminal is injected so tests can drive a headless
 * virtual terminal (@xterm/headless) instead of a real TTY; the process
 * entry point (startProcessTui) supplies ProcessTerminal.
 *
 * Surface layout (regular mode): header (todo status), message transcript,
 * editor, footer status line. Fullscreen mode (Ctrl+F) renders the same
 * component tree through TuiAltScreen's layout engine, where the transcript
 * scrolls inside the alt screen.
 *
 * Keys: Enter submit, Ctrl+C exit, Ctrl+O expand/collapse recent turns,
 * Ctrl+F toggle fullscreen, Tab autocomplete (slash commands + paths).
 * @module @dsh-pi-tui/tui-app/tui-app
 */
import { type Component, type SettingItem, type SlashCommand, type Terminal } from '@dsh-pi-tui/pi-tui';
import type { TranscriptMessage } from './transcript.ts';
/** How many most-recent turns Ctrl+O expands; mirrors pi's default. */
export declare const EXPAND_RECENT_TURNS = 3;
/** Folded preview lines for thinking blocks; mirrors pi's THINKING_PREVIEW_LINES. */
export declare const THINKING_PREVIEW_LINES = 2;
/** Folded preview lines for tool results; mirrors pi's RESULT_PREVIEW_LINES. */
export declare const RESULT_PREVIEW_LINES = 3;
/**
 * Rounded-frame wrapper for overlay content: `╭─╮` border in the border
 * token, one cell of padding, width sized to the content. Keyboard input
 * forwards to the wrapped component.
 */
export declare class Frame implements Component {
    private readonly child;
    constructor(child: Component);
    invalidate(): void;
    handleInput(data: string): void;
    get wantsKeyRelease(): boolean | undefined;
    render(width: number): string[];
}
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
/** Footer status data supplied by the runner. */
export interface StatusData {
    /** Provider/model label, e.g. `opencode-go/deepseek-v4-flash`. */
    model: string;
    /** The working directory, shortened for display. */
    cwd: string;
    /** Git branch name, empty when not a git checkout. */
    branch: string;
    /** Completed turns and steps so far. */
    turns: number;
    /** Steps (model requests) so far. */
    steps: number;
    /** Stats line (pi vocabulary), preformatted by the runner. */
    statsLine: string;
    /** Current context pressure in tokens, when measured. */
    contextTokens?: number;
    /** Context window in tokens, when known. */
    contextWindow?: number;
}
/**
 * The interactive surface: header, transcript, editor, footer. Owns the
 * TUI lifecycle, mode switching, folding, approval dialogs, and settings
 * overlay; input routing and rendering decisions live here so they are
 * testable without a real terminal.
 */
export declare class TuiApp {
    private readonly terminal;
    private readonly tui;
    private readonly editor;
    private readonly header;
    private readonly messagesView;
    private readonly footer;
    private readonly events;
    /** Prompts awaiting the user's decision; one is shown at a time. */
    private readonly approvalQueue;
    /** The prompt currently on screen, if any. */
    private activeApproval;
    /** The folded transcript; re-rendered into the messages view on change. */
    private messages;
    /** Ctrl+O master switch: expand the most recent turns' collapsible entries. */
    private toolOutputExpanded;
    /** Whether the Ctrl+O expansion master switch is on. */
    isToolOutputExpanded(): boolean;
    /** Set the Ctrl+O expansion master switch and repaint. */
    setToolOutputExpanded(expanded: boolean): void;
    /** Fullscreen (alt-screen) instance; absent in regular mode. */
    private fullscreen;
    /** Footer state. */
    private status;
    /** Header text (todo summary), kept for theme-swap repaints. */
    private headerText;
    /** Footer text, kept for theme-swap repaints. */
    private footerText;
    /** Welcome card shown above the transcript; empty renders nothing. */
    private welcomeText;
    /** Transient error line shown under the transcript; cleared by setTranscript. */
    private notifyText;
    constructor(terminal: Terminal, events: TuiAppEvents);
    /** Enter raw mode and start rendering. */
    start(): void;
    /** Leave raw mode and stop rendering. */
    stop(): void;
    /** Shared key routing: approval first, then folding/mode/exit. */
    private handleInput;
    /** Toggle between regular (terminal scrollback) and fullscreen (alt screen). */
    toggleFullscreen(): void;
    /**
     * Replace the transcript and rebuild the message components. Collapsible
     * entries (thinking, tool cards) render folded unless the Ctrl+O master
     * switch is on and the entry belongs to the most recent turns.
     * @param messages - the folded transcript.
     */
    setTranscript(messages: readonly TranscriptMessage[]): void;
    /** Rebuild the message component tree from the current transcript state. */
    private rebuildMessages;
    /** Show a transient error line under the transcript; the next repaint clears it. */
    notify(text: string): void;
    /**
     * Set the session head rendered above the transcript: one dense line with
     * the session identity, model, version, and a rule beneath. Replaces any
     * previous head.
     * @param facts - directory, session id, model, and version to display.
     */
    setWelcomeCard(facts: {
        cwd: string;
        sessionId: string;
        model: string;
        version: string;
    }): void;
    /** The turn threshold at or above which collapsible entries expand. */
    private expandBoundary;
    /** Render one transcript message as a pi-tui component. */
    private renderMessage;
    /** Request a render on the active screen. */
    private requestRender;
    /**
     * Reflect the todo list in the header line: active (non-completed) count
     * and, when the list is non-empty, the first active item's text.
     * @param todos - the latest todo/write snapshot.
     */
    setTodoSummary(todos: readonly TodoItem[]): void;
    /**
     * Update the footer: line 1 `[model] …/cwd branch [ctx bar] t/steps`,
     * line 2 the stats line left-aligned with the context readout right-
     * aligned (kimi layout). Partial updates merge.
     * @param status - the new status values.
     */
    setStatus(status: Partial<StatusData>): void;
    /** Install slash-command + file-path autocompletion on the editor. */
    setCommandCompletions(commands: readonly SlashCommand[], cwd: string): void;
    /**
     * Open a single-choice picker overlay (SelectList). Selecting calls
     * `onSelect` with the item value and closes; Esc calls `onCancel`.
     * @param items - choice rows.
     * @param onSelect - confirmed choice.
     * @param onCancel - dismissed without a choice.
     */
    openPicker(items: readonly {
        value: string;
        label: string;
        description?: string;
    }[], onSelect: (value: string) => void, onCancel: () => void): void;
    /**
     * Open the settings overlay as a SettingsList. The runner supplies the
     * items and reacts to changes/cancellation.
     * @param items - setting rows.
     * @param onChange - called with (id, newValue) on confirm.
     * @param onCancel - called when the user closes without applying.
     */
    openSettings(items: SettingItem[], onChange: (id: string, value: string) => void, onCancel: () => void): void;
    /** Switch the active color theme and repaint everything. */
    applyTheme(theme: 'dark' | 'light'): void;
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
