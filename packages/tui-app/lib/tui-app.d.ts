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
import { type ColorPalette } from './theme.ts';
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
    /** Double-Esc: stop the current activity (turn, tool run). Optional. */
    onCancel?: () => void;
    /** Ctrl+S: steer the running turn with the current draft. Optional. */
    onSteer?: (text: string) => void;
    /**
     * Ctrl+G: open the external editor with the current draft. The TUI stops
     * before the call and restarts after it resolves; return the new text.
     * Optional.
     */
    openExternalEditor?: (draft: string) => Promise<string>;
    /** Fullscreen mode changed (Ctrl+F toggle or a settings-panel write). Optional. */
    onFullscreenChange?: (fullscreen: boolean) => void;
    /** The transcript-search query changed (Ctrl+Shift+F opens the search). Optional. */
    onSearchQuery?: (query: string) => void;
    /** Enter inside the search: jump to the next match. Optional. */
    onSearchNext?: () => void;
    /** Shift+Enter inside the search: jump to the previous match. Optional. */
    onSearchPrev?: () => void;
    /** The search was closed (Escape). Optional. */
    onSearchClose?: () => void;
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
/** One question in a user-questions ask (dsh shape mirrored for testability). */
export interface TuiQuestion {
    /** Stable caller-provided id, echoed in the answer. */
    id: string;
    /** The question to display. */
    question: string;
    /** Optional short heading/group label. */
    header?: string;
    /** Optional choices rendered as a numbered menu. */
    options?: readonly {
        label: string;
        description?: string;
    }[];
    /** Whether more than one option may be selected. */
    multiSelect?: boolean;
}
/** One answered question, keyed by id. */
export interface TuiQuestionAnswer {
    /** The answered question id. */
    id: string;
    /** Selected option labels. */
    selected: string[];
    /** Free-text answer for questions without options. */
    custom?: string;
}
/** Footer status data supplied by the runner. */
export interface StatusData {
    /** Provider/model label, e.g. `opencode-go/deepseek-v4-flash`. */
    model: string;
    /** The working directory, shortened for display. */
    cwd: string;
    /** Git branch name, empty when not a git checkout. */
    branch: string;
    /** Active goal badge text (e.g. `goal ● objective`), when a goal is live. */
    goal?: string;
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
    /** The active user-questions flow, if any (one at a time). */
    private activeQuestions;
    /** The folded transcript; re-rendered into the messages view on change. */
    private messages;
    /** Local (non-session) cards — e.g. `!` shell runs — rendered after the transcript. */
    private readonly localMessages;
    /** Submitted input history (newest first), mirrored for persistence. */
    private readonly inputHistory;
    /** Cap for the persisted input history per working directory. */
    private static readonly INPUT_HISTORY_LIMIT;
    /** Ctrl+O master switch: expand the most recent turns' collapsible entries. */
    private toolOutputExpanded;
    /** Alt+T: hide thinking entries entirely (they stay in the log). */
    private hideThinking;
    /** The latest todo/write snapshot; rendered as a panel when visible. */
    private todoItems;
    /** Ctrl+T: whether the todo panel between transcript and editor is shown. */
    private todoPanelVisible;
    /** The todo panel Text; empty when hidden. */
    private readonly todoPanel;
    /** Whether the Ctrl+O expansion master switch is on. */
    isToolOutputExpanded(): boolean;
    /** Set the Ctrl+O expansion master switch and repaint. */
    setToolOutputExpanded(expanded: boolean): void;
    /** Fullscreen (alt-screen) instance; absent in regular mode. */
    private fullscreen;
    /** The mounted transcript-search overlay, while one is open. */
    private searchOverlay;
    /** The search input component, while one is open (for match counts). */
    private searchComponent;
    /** Overlay handles currently mounted on the active screen, for mode switches. */
    private readonly overlayHandles;
    /** Footer state. */
    private status;
    /** Header text (todo summary), kept for theme-swap repaints. */
    private headerText;
    /** Footer text, kept for theme-swap repaints. */
    private footerText;
    /** Plan-mode badge state; appended to the header and footer when active. */
    private planMode;
    /** The editor's normal border style, restored when plan mode ends. */
    private readonly editorBorder;
    /** Todo summary segment of the header (without the base or badges). */
    private todoText;
    /** Welcome card shown above the transcript; empty renders nothing. */
    private welcomeText;
    /** Transient error line shown under the transcript; cleared by setTranscript. */
    private notifyText;
    /** Timestamp of the last Esc press, for double-Esc cancellation. */
    private lastEscapeAt;
    /** Double-Esc window in ms. */
    private static readonly ESCAPE_CANCEL_WINDOW_MS;
    constructor(terminal: Terminal, events: TuiAppEvents);
    /** Enter raw mode and start rendering. */
    start(): void;
    /** Leave raw mode and stop rendering. */
    stop(): void;
    /** Shared key routing: questions, then approval, then folding/mode/cancel/exit. */
    private handleInput;
    /** The screen currently rendering: the alt screen in fullscreen mode. */
    private get overlayHost();
    /**
     * Show an overlay on the active screen and track its handle, so a
     * fullscreen toggle can hide every mounted overlay on the old screen.
     * @param component - the overlay content.
     * @param options - overlay sizing/positioning.
     * @returns the handle; hide() also forgets the handle.
     */
    private showOverlayOnHost;
    /**
     * Launch the external editor with the current draft. The TUI stops first
     * (raw mode released) and restarts after the editor returns; a fullscreen
     * mode is not restored (the editor session ends in regular mode).
     */
    launchExternalEditor(): Promise<void>;
    /** Record a submitted line into the editor history and the persistence mirror. */
    private rememberInput;
    /**
     * Seed the editor's recall history from persisted entries (newest first).
     * @param entries - persisted entries, most recent first.
     */
    seedInputHistory(entries: readonly string[]): void;
    /** The current input history (newest first) for persistence. */
    getInputHistory(): readonly string[];
    /**
     * Append a local card rendered after the session transcript (e.g. `!`
     * shell runs). The card is always expanded (its turn is unbounded).
     * @param message - the local card to show.
     */
    pushLocalMessage(message: TranscriptMessage): void;
    /** Replace the most recent local card (running → settled). */
    updateLastLocalMessage(message: TranscriptMessage): void;
    /** Drop all local cards (session switch). */
    clearLocalMessages(): void;
    /**
     * Toggle between regular (terminal scrollback) and fullscreen (alt screen).
     * Overlays live on the active screen, so the switch hides every mounted
     * overlay; a pending approval prompt is re-rendered on the new screen.
     */
    toggleFullscreen(): void;
    /** Whether the alt screen is currently active (fullscreen mode). */
    isFullscreen(): boolean;
    /**
     * Enter or leave fullscreen (alt screen), reporting the change through
     * {@link TuiAppEvents.onFullscreenChange} so the host can persist it.
     * @param enabled - true renders the alt screen, false returns to the main screen.
     */
    setFullscreen(enabled: boolean): void;
    /**
     * Open the transcript-search overlay (Ctrl+Shift+F) and focus its input.
     * The search itself runs in the host against the folded transcript; this
     * surface only collects the query and reports navigation keys.
     */
    startTranscriptSearch(): void;
    /** Close the transcript-search overlay and report the close. */
    closeTranscriptSearch(): void;
    /** Publish the current match position for the overlay header (1-based, total). */
    setSearchResult(index: number, count: number): void;
    /** Whether the transcript search is open. */
    isSearching(): boolean;
    /**
     * Replace the transcript and rebuild the message components. Collapsible
     * entries (thinking, tool cards) render folded unless the Ctrl+O master
     * switch is on and the entry belongs to the most recent turns.
     * @param messages - the folded transcript.
     */
    setTranscript(messages: readonly TranscriptMessage[]): void;
    /** Rebuild the message component tree from the current transcript state. */
    private rebuildMessages;
    /** Show or clear plan mode: header + footer badges and a warning-tinted editor border. */
    setPlanMode(active: boolean): void;
    /** Show a transient error line under the transcript; the next repaint clears it. */
    notify(text: string): void;
    /**
     * Set the session head rendered above the transcript: one dense line with
     * the session identity, model, version, and a rule beneath. Replaces any
     * previous head.
     * @param facts - directory, session id, model, version, and the optional agent preset to display.
     */
    setWelcomeCard(facts: {
        cwd: string;
        sessionId: string;
        model: string;
        version: string;
        preset?: string;
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
    /** Toggle the todo panel between the transcript and the editor. */
    toggleTodoPanel(): boolean;
    /** Whether the todo panel is currently shown. */
    isTodoPanelVisible(): boolean;
    /**
     * Rebuild the todo panel text: a header line plus up to five rows,
     * in_progress first, then pending, then completed (strikethrough).
     */
    private renderTodoPanel;
    /** Hide/show thinking entries; the fold state is untouched. */
    toggleThinkingHidden(): boolean;
    /** Whether thinking entries are currently hidden. */
    isThinkingHidden(): boolean;
    /** Rebuild the header from base + todo summary + plan badge. */
    private renderHeader;
    /**
     * Update the footer: line 1 `[model] …/cwd branch [ctx bar] t/steps`,
     * line 2 the stats line (full preset) or nothing (compact). Partial
     * updates merge.
     * @param status - the new status values.
     */
    setStatus(status: Partial<StatusData>): void;
    /** Footer density presets: full keeps the stats line, compact drops it. */
    private footerPreset;
    /** Set the footer density preset and repaint. */
    setFooterPreset(preset: 'full' | 'compact'): void;
    /** Whether the footer currently uses the compact preset. */
    getFooterPreset(): 'full' | 'compact';
    /** Rebuild the two footer lines from the current status and plan badge. */
    private renderFooter;
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
    /** Apply a resolved custom palette and repaint everything. */
    applyPalette(palette: ColorPalette): void;
    /**
     * Query the terminal background (OSC 11) and apply the matching palette.
     * A terminal that never answers leaves the current theme untouched.
     */
    autoDetectTheme(): Promise<void>;
    /**
     * Register a live terminal-theme listener (colour-scheme reports). The
     * runner uses it to follow the terminal when the preference is `auto`.
     * @param listener - receives the detected palette family.
     * @returns a disposer.
     */
    onTerminalThemeChange(listener: (theme: 'dark' | 'light') => void): () => void;
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
    /** Build and mount the approval dialog for one prompt on the active screen. */
    private renderApprovalDialog;
    /** Route a key while a prompt is showing; every key is consumed. */
    private handleApprovalKey;
    /** Resolve one prompt, hide its dialog, and show the next in line. */
    private settleApproval;
    /**
     * Ask the user one or more questions through the dialog overlay. One
     * question is on screen at a time; numbered keys select/toggle options,
     * Enter confirms the current question, Esc (or an aborted signal) rejects.
     * Questions without options collect a typed free-text answer.
     * @param questions - the questions to ask.
     * @param signal - optional abort; settles the flow rejected.
     * @returns the answers, in question order.
     */
    askQuestions(questions: readonly TuiQuestion[], signal?: AbortSignal): Promise<TuiQuestionAnswer[]>;
    /** Build and mount the dialog for the state's current question. */
    private renderQuestion;
    /** Route a key while a question is showing; every key is consumed. */
    private handleQuestionKey;
    /** Resolve the question flow with its answers, or reject on cancel. */
    private settleQuestions;
}
/** Start the TUI on the process terminal (raw-mode stdin/stdout). */
export declare function startProcessTui(events: TuiAppEvents): TuiApp;
