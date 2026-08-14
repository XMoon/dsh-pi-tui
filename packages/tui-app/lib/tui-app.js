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
import { Box, CombinedAutocompleteProvider, Container, Editor, Markdown, ProcessTerminal, SelectList, SettingsList, Text, TuiAltScreen, TuiMainScreen, matchesKey, truncateToWidth, visibleWidth, } from '@dsh-pi-tui/pi-tui';
import { detectThemeFromBackground, editorTheme, markdownTheme, selectListTheme, settingsListTheme, setTheme, } from "./theme.js";
import { isDiffResult, renderDiffLines } from "./diff.js";
import { TranscriptSearchComponent } from "./search.js";
/** How many most-recent turns Ctrl+O expands; mirrors pi's default. */
export const EXPAND_RECENT_TURNS = 3;
/** Folded preview lines for thinking blocks; mirrors pi's THINKING_PREVIEW_LINES. */
export const THINKING_PREVIEW_LINES = 2;
/** Folded preview lines for tool results; mirrors pi's RESULT_PREVIEW_LINES. */
export const RESULT_PREVIEW_LINES = 3;
/** First lines of a multi-line text, joined for folded previews. */
function preview(text, lines) {
    const parts = text.split('\n');
    const first = parts.slice(0, lines).join(' ').trim();
    const rest = parts.length > lines ? '…' : '';
    return `${first.slice(0, 120)}${rest}`;
}
/**
 * The key argument for a tool card header: the primary field per tool name
 * (e.g. bash → command, write → file_path), falling back to the first
 * string value, then to the raw args JSON.
 * @param name - the tool name.
 * @param args - the raw arguments JSON.
 * @returns a short display string.
 */
function keyArg(name, args) {
    let parsed;
    try {
        parsed = JSON.parse(args);
    }
    catch {
        return args;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return args;
    const record = parsed;
    const fields = {
        bash: ['command', 'cmd', 'script'],
        write: ['file_path', 'path', 'file'],
        edit: ['file_path', 'path', 'file'],
        read: ['file', 'file_path', 'path'],
        grep: ['pattern', 'regex', 'query'],
        glob: ['pattern', 'path'],
        fetch: ['url', 'uri'],
        web: ['query', 'url'],
        skill: ['name', 'skill'],
        ask_user_question: ['question'],
    };
    for (const field of fields[name] ?? []) {
        const value = record[field];
        if (typeof value === 'string' && value !== '')
            return `${field}=${value}`;
    }
    for (const value of Object.values(record)) {
        if (typeof value === 'string' && value !== '')
            return value;
    }
    return args;
}
/** Context bar width in cells; pi renders `[███░░░] pct` in the footer. */
const CONTEXT_BAR_WIDTH = 12;
/**
 * Rounded-frame wrapper for overlay content: `╭─╮` border in the border
 * token, one cell of padding, width sized to the content. Keyboard input
 * forwards to the wrapped component.
 */
export class Frame {
    child;
    constructor(child) {
        this.child = child;
    }
    invalidate() {
        this.child.invalidate?.();
    }
    handleInput(data) {
        this.child.handleInput?.(data);
    }
    get wantsKeyRelease() {
        return this.child.wantsKeyRelease;
    }
    render(width) {
        const inner = Math.max(1, Math.floor(width) - 4);
        const lines = this.child.render(inner).map(line => truncateToWidth(line, inner, '…'));
        const contentWidth = Math.min(inner, Math.max(1, ...lines.map(line => visibleWidth(line))));
        const frameWidth = contentWidth + 4;
        const b = color.border;
        const out = [b(`╭${'─'.repeat(frameWidth - 2)}╮`)];
        for (const line of lines) {
            const vis = visibleWidth(line);
            // Row shape is `│ line pad │`: borders and one padding cell each side
            // are fixed, so padding only tops the content up to `inner` — the row
            // is then exactly frameWidth cells and the right border survives
            // compositing.
            const pad = Math.max(0, inner - vis);
            out.push(`${b('│')} ${line}${' '.repeat(pad)} ${b('│')}`);
        }
        out.push(b(`╰${'─'.repeat(frameWidth - 2)}╯`));
        return out;
    }
}
/** Pi-style context progress bar: `[███░░░░░░░░░] 25%`. */
function contextBar(used, window) {
    const ratio = Math.min(1, Math.max(0, used / window));
    const filled = Math.round(ratio * CONTEXT_BAR_WIDTH);
    const pct = Math.min(100, Math.max(0, Math.ceil(ratio * 100)));
    const bar = '█'.repeat(filled) + '░'.repeat(CONTEXT_BAR_WIDTH - filled);
    return `${color.primary(`[${bar}]`)} ${pct}%`;
}
/**
 * The interactive surface: header, transcript, editor, footer. Owns the
 * TUI lifecycle, mode switching, folding, approval dialogs, and settings
 * overlay; input routing and rendering decisions live here so they are
 * testable without a real terminal.
 */
export class TuiApp {
    terminal;
    tui;
    editor;
    header;
    messagesView;
    footer;
    events;
    /** Prompts awaiting the user's decision; one is shown at a time. */
    approvalQueue = [];
    /** The prompt currently on screen, if any. */
    activeApproval;
    /** The active user-questions flow, if any (one at a time). */
    activeQuestions;
    /** The folded transcript; re-rendered into the messages view on change. */
    messages = [];
    /** Local (non-session) cards — e.g. `!` shell runs — rendered after the transcript. */
    localMessages = [];
    /** Submitted input history (newest first), mirrored for persistence. */
    inputHistory = [];
    /** Cap for the persisted input history per working directory. */
    static INPUT_HISTORY_LIMIT = 100;
    /** Ctrl+O master switch: expand the most recent turns' collapsible entries. */
    toolOutputExpanded = false;
    /** Alt+T: hide thinking entries entirely (they stay in the log). */
    hideThinking = false;
    /** The latest todo/write snapshot; rendered as a panel when visible. */
    todoItems = [];
    /** Ctrl+T: whether the todo panel between transcript and editor is shown. */
    todoPanelVisible = false;
    /** The todo panel Text; empty when hidden. */
    todoPanel;
    /** Whether the Ctrl+O expansion master switch is on. */
    isToolOutputExpanded() {
        return this.toolOutputExpanded;
    }
    /** Set the Ctrl+O expansion master switch and repaint. */
    setToolOutputExpanded(expanded) {
        this.toolOutputExpanded = expanded;
        this.rebuildMessages();
    }
    /** Fullscreen (alt-screen) instance; absent in regular mode. */
    fullscreen;
    /** The mounted transcript-search overlay, while one is open. */
    searchOverlay;
    /** The search input component, while one is open (for match counts). */
    searchComponent;
    /** Overlay handles currently mounted on the active screen, for mode switches. */
    overlayHandles = new Set();
    /** Footer state. */
    status = { model: '', cwd: '', branch: '', turns: 0, steps: 0, statsLine: '' };
    /** Header text (todo summary), kept for theme-swap repaints. */
    headerText = '🐋 dsh-pi-tui';
    /** Footer text, kept for theme-swap repaints. */
    footerText = '';
    /** Plan-mode badge state; appended to the header and footer when active. */
    planMode = false;
    /** The editor's normal border style, restored when plan mode ends. */
    editorBorder;
    /** Todo summary segment of the header (without the base or badges). */
    todoText = '';
    /** Welcome card shown above the transcript; empty renders nothing. */
    welcomeText = '';
    /** Transient error line shown under the transcript; cleared by setTranscript. */
    notifyText = '';
    /** Timestamp of the last Esc press, for double-Esc cancellation. */
    lastEscapeAt;
    /** Double-Esc window in ms. */
    static ESCAPE_CANCEL_WINDOW_MS = 400;
    constructor(terminal, events) {
        this.terminal = terminal;
        this.events = events;
        this.tui = new TuiMainScreen(terminal);
        this.editor = new Editor(this.tui, editorTheme);
        this.editorBorder = this.editor.borderColor;
        this.editor.onSubmit = (text) => {
            this.rememberInput(text);
            this.events.onSubmit(text);
        };
        this.header = new Text('🐋 dsh-pi-tui', 0, 0);
        this.messagesView = new Container();
        this.todoPanel = new Text('', 0, 0);
        this.footer = new Text('', 0, 0);
        this.tui.addChild(this.header);
        this.tui.addChild(this.messagesView);
        this.tui.addChild(this.todoPanel);
        this.tui.addChild(this.editor);
        this.tui.addChild(this.footer);
        this.tui.setFocus(this.editor);
        this.tui.addInputListener((data) => this.handleInput(data));
    }
    /** Enter raw mode and start rendering. */
    start() {
        this.tui.start();
    }
    /** Leave raw mode and stop rendering. */
    stop() {
        this.tui.stop();
        this.fullscreen?.stop();
        this.fullscreen = undefined;
    }
    /** Shared key routing: questions, then approval, then folding/mode/cancel/exit. */
    handleInput(data) {
        if (this.activeQuestions !== undefined) {
            return this.handleQuestionKey(data);
        }
        if (this.activeApproval !== undefined) {
            return this.handleApprovalKey(data);
        }
        // Transcript search owns these keys while its overlay is up; everything
        // else falls through to the focused search input.
        if (this.searchOverlay !== undefined) {
            if (matchesKey(data, 'escape')) {
                this.closeTranscriptSearch();
                return { consume: true };
            }
            if (matchesKey(data, 'enter')) {
                this.events.onSearchNext?.();
                return { consume: true };
            }
            if (matchesKey(data, 'shift+enter')) {
                this.events.onSearchPrev?.();
                return { consume: true };
            }
            if (matchesKey(data, 'ctrl+f')) {
                // Fullscreen hides every overlay; close the search first.
                this.closeTranscriptSearch();
                this.toggleFullscreen();
                return { consume: true };
            }
            return undefined;
        }
        if (matchesKey(data, 'ctrl+shift+f')) {
            this.startTranscriptSearch();
            return { consume: true };
        }
        if (matchesKey(data, 'escape')) {
            // Overlays (pickers, settings) own Esc while they are up.
            if (this.overlayHost.hasOverlayEntries)
                return undefined;
            // The host may consume the first Esc (runner-owned modes like the
            // subagent viewer); otherwise it arms the double-Esc cancel.
            if (this.events.onSingleEscape?.() === true)
                return { consume: true };
            const now = Date.now();
            if (this.lastEscapeAt !== undefined && now - this.lastEscapeAt < TuiApp.ESCAPE_CANCEL_WINDOW_MS) {
                this.lastEscapeAt = undefined;
                this.events.onCancel?.();
            }
            else {
                this.lastEscapeAt = now;
            }
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+o')) {
            this.toolOutputExpanded = !this.toolOutputExpanded;
            this.rebuildMessages();
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+t')) {
            // Todo panel toggle (kimi semantics; Ctrl+T never reaches the editor).
            this.toggleTodoPanel();
            return { consume: true };
        }
        if (matchesKey(data, 'alt+t')) {
            // Hide/show thinking entries independently of the Ctrl+O fold.
            this.toggleThinkingHidden();
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+s')) {
            // Steer: send the draft into the running turn and clear the editor.
            if (this.overlayHost.hasOverlayEntries)
                return { consume: true };
            const draft = this.editor.getText();
            if (draft.trim() === '')
                return { consume: true };
            this.editor.setText('');
            this.events.onSteer?.(draft);
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+g')) {
            // External editor; overlays own Ctrl+G while up (alt-screen search).
            if (this.overlayHost.hasOverlayEntries)
                return { consume: true };
            void this.launchExternalEditor();
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+f')) {
            this.toggleFullscreen();
            return { consume: true };
        }
        if (matchesKey(data, 'ctrl+c')) {
            this.events.onExit();
            return { consume: true };
        }
        return undefined;
    }
    /** The screen currently rendering: the alt screen in fullscreen mode. */
    get overlayHost() {
        return this.fullscreen ?? this.tui;
    }
    /**
     * Show an overlay on the active screen and track its handle, so a
     * fullscreen toggle can hide every mounted overlay on the old screen.
     * @param component - the overlay content.
     * @param options - overlay sizing/positioning.
     * @returns the handle; hide() also forgets the handle.
     */
    showOverlayOnHost(component, options) {
        const handle = this.overlayHost.showOverlay(component, options);
        this.overlayHandles.add(handle);
        return {
            ...handle,
            hide: () => {
                this.overlayHandles.delete(handle);
                handle.hide();
            },
        };
    }
    /**
     * Launch the external editor with the current draft. The TUI stops first
     * (raw mode released) and restarts after the editor returns; a fullscreen
     * mode is not restored (the editor session ends in regular mode).
     */
    async launchExternalEditor() {
        const open = this.events.openExternalEditor;
        if (open === undefined)
            return;
        const draft = this.editor.getText();
        this.stop();
        try {
            const next = await open(draft);
            if (next !== '')
                this.editor.setText(next);
        }
        finally {
            this.start();
        }
    }
    /** Record a submitted line into the editor history and the persistence mirror. */
    rememberInput(text) {
        const trimmed = text.trim();
        if (trimmed === '')
            return;
        this.editor.addToHistory(trimmed);
        if (this.inputHistory[0] === trimmed)
            return;
        this.inputHistory.unshift(trimmed);
        if (this.inputHistory.length > TuiApp.INPUT_HISTORY_LIMIT)
            this.inputHistory.pop();
    }
    /**
     * Seed the editor's recall history from persisted entries (newest first).
     * @param entries - persisted entries, most recent first.
     */
    seedInputHistory(entries) {
        // addToHistory unshifts, so seed oldest→newest to keep the persisted order.
        for (let index = entries.length - 1; index >= 0; index -= 1) {
            const entry = entries[index];
            if (entry === undefined)
                continue;
            const trimmed = entry.trim();
            if (trimmed !== '')
                this.editor.addToHistory(trimmed);
        }
    }
    /** The current input history (newest first) for persistence. */
    getInputHistory() {
        return [...this.inputHistory];
    }
    /**
     * Append a local card rendered after the session transcript (e.g. `!`
     * shell runs). The card is always expanded (its turn is unbounded).
     * @param message - the local card to show.
     */
    pushLocalMessage(message) {
        this.localMessages.push(message);
        this.rebuildMessages();
    }
    /** Replace the most recent local card (running → settled). */
    updateLastLocalMessage(message) {
        const index = this.localMessages.length - 1;
        if (index < 0)
            return;
        this.localMessages[index] = message;
        this.rebuildMessages();
    }
    /** Drop all local cards (session switch). */
    clearLocalMessages() {
        if (this.localMessages.length === 0)
            return;
        this.localMessages.length = 0;
        this.rebuildMessages();
    }
    /**
     * Toggle between regular (terminal scrollback) and fullscreen (alt screen).
     * Overlays live on the active screen, so the switch hides every mounted
     * overlay; a pending approval prompt is re-rendered on the new screen.
     */
    toggleFullscreen() {
        this.setFullscreen(this.fullscreen === undefined);
    }
    /** Whether the alt screen is currently active (fullscreen mode). */
    isFullscreen() {
        return this.fullscreen !== undefined;
    }
    /**
     * Enter or leave fullscreen (alt screen), reporting the change through
     * {@link TuiAppEvents.onFullscreenChange} so the host can persist it.
     * @param enabled - true renders the alt screen, false returns to the main screen.
     */
    setFullscreen(enabled) {
        const active = this.fullscreen !== undefined;
        if (enabled === active)
            return;
        const pending = this.activeApproval;
        pending?.handle?.hide();
        for (const handle of this.overlayHandles)
            handle.hide();
        this.overlayHandles.clear();
        if (enabled) {
            const alt = new TuiAltScreen(this.terminal);
            for (const child of this.tui.children)
                alt.addChild(child);
            alt.addInputListener((data) => this.handleInput(data));
            this.tui.stop();
            alt.start();
            this.fullscreen = alt;
        }
        else {
            this.fullscreen?.stop();
            this.fullscreen = undefined;
            this.tui.start();
        }
        this.events.onFullscreenChange?.(enabled);
        if (pending !== undefined)
            this.renderApprovalDialog(pending);
    }
    /**
     * Open the transcript-search overlay (Ctrl+Shift+F) and focus its input.
     * The search itself runs in the host against the folded transcript; this
     * surface only collects the query and reports navigation keys.
     */
    startTranscriptSearch() {
        if (this.searchOverlay !== undefined) {
            this.searchOverlay.focus();
            return;
        }
        const component = new TranscriptSearchComponent((query) => {
            this.events.onSearchQuery?.(query);
        });
        this.searchComponent = component;
        this.searchOverlay = this.showOverlayOnHost(component, {
            anchor: 'top-right',
            width: '40%',
            minWidth: 24,
            margin: 1,
        });
    }
    /** Close the transcript-search overlay and report the close. */
    closeTranscriptSearch() {
        if (this.searchOverlay === undefined)
            return;
        this.searchOverlay.hide();
        this.searchOverlay = undefined;
        this.searchComponent = undefined;
        this.events.onSearchClose?.();
    }
    /** Publish the current match position for the overlay header (1-based, total). */
    setSearchResult(index, count) {
        this.searchComponent?.setResult(index, count);
        this.searchComponent?.invalidate();
    }
    /** Whether the transcript search is open. */
    isSearching() {
        return this.searchOverlay !== undefined;
    }
    /**
     * Replace the transcript and rebuild the message components. Collapsible
     * entries (thinking, tool cards) render folded unless the Ctrl+O master
     * switch is on and the entry belongs to the most recent turns.
     * @param messages - the folded transcript.
     */
    setTranscript(messages) {
        this.messages = messages;
        this.rebuildMessages();
    }
    /** Rebuild the message component tree from the current transcript state. */
    rebuildMessages() {
        this.messagesView.clear();
        if (this.welcomeText !== '') {
            this.messagesView.addChild(new Text(this.welcomeText, 0, 0));
        }
        const boundary = this.expandBoundary();
        for (const message of this.messages) {
            // Alt+T hides thinking entries without touching the fold state.
            if (message.kind === 'thinking' && this.hideThinking)
                continue;
            this.messagesView.addChild(this.renderMessage(message, boundary));
        }
        for (const message of this.localMessages) {
            this.messagesView.addChild(this.renderMessage(message, boundary));
        }
        if (this.notifyText !== '') {
            this.messagesView.addChild(new Text(color.error(`✗ ${this.notifyText}`), 0, 0));
        }
        this.renderTodoPanel();
        this.requestRender();
    }
    /** Show or clear plan mode: header + footer badges and a warning-tinted editor border. */
    setPlanMode(active) {
        this.planMode = active;
        this.renderHeader();
        this.renderFooter();
        this.editor.borderColor = active ? color.warning : this.editorBorder;
        this.editor.invalidate();
        this.requestRender();
    }
    /** Show a transient error line under the transcript; the next repaint clears it. */
    notify(text) {
        this.notifyText = text;
        this.rebuildMessages();
    }
    /**
     * Set the session head rendered above the transcript: one dense line with
     * the session identity, model, version, and a rule beneath. Replaces any
     * previous head.
     * @param facts - directory, session id, model, version, and the optional agent preset to display.
     */
    setWelcomeCard(facts) {
        const shortId = facts.sessionId.length > 24 ? `${facts.sessionId.slice(0, 24)}…` : facts.sessionId;
        const items = [
            `session ${color.textDim(shortId)}`,
            color.text(facts.model),
            ...facts.preset === undefined ? [] : [color.textMuted(`preset ${facts.preset}`)],
            `v${facts.version}`,
            color.textMuted(facts.cwd),
        ].join('  ·  ');
        const width = Math.max(20, Math.min(80, visibleWidth(items) + 2));
        this.welcomeText = [
            `${color.primary('🐋')} ${items}`,
            color.border('─'.repeat(width)),
        ].join('\n');
        this.rebuildMessages();
    }
    /** The turn threshold at or above which collapsible entries expand. */
    expandBoundary() {
        if (!this.toolOutputExpanded || EXPAND_RECENT_TURNS <= 0)
            return Number.POSITIVE_INFINITY;
        const turns = new Set();
        for (const message of this.messages) {
            if (message.kind === 'thinking' || message.kind === 'system' || message.kind === 'tool')
                turns.add(message.turn);
        }
        const sorted = [...turns].sort((a, b) => b - a);
        if (sorted.length <= EXPAND_RECENT_TURNS)
            return 0;
        return sorted[EXPAND_RECENT_TURNS - 1] ?? 0;
    }
    /** Render one transcript message as a pi-tui component. */
    renderMessage(message, boundary) {
        if (message.kind === 'user') {
            // Terminal-prompt style: the user's line reads like a shell command.
            return new Text(`${color.roleUser('❯')} ${message.text}`, 0, 0);
        }
        if (message.kind === 'assistant') {
            // The whale bullet is its own Text so it never reflows into the body.
            const row = new Container();
            row.addChild(new Text(`${color.primary('🐋')} `, 0, 0));
            row.addChild(new Markdown(message.text, 0, 0, markdownTheme));
            return row;
        }
        if (message.kind === 'thinking') {
            const expanded = message.turn >= boundary;
            const text = expanded
                ? `${color.textDim('🐳')} ${message.text}`
                : color.textDim(`🐳 ${preview(message.text, THINKING_PREVIEW_LINES)} (ctrl+o to expand)`);
            return new Text(text, 0, 0);
        }
        if (message.kind === 'system') {
            const expanded = message.turn >= boundary;
            const text = expanded
                ? `${color.textMuted('§')} ${message.text}`
                : color.textMuted(`§ ${preview(message.text, 2)} (ctrl+o to expand)`);
            return new Text(text, 0, 0);
        }
        if (message.kind === 'summary') {
            // Windowing: turns older than the display window collapse to one line.
            return new Text(color.textDim(message.text), 0, 0);
        }
        // Tool card: header line, plus args and result when expanded.
        const mark = message.status === 'ok' ? successMark('✓') : message.status === 'error' ? errorMark('✗') : dim('…');
        const card = new Container();
        const key = message.args.trim() === '' ? '' : ` ${keyArg(message.name, message.args).slice(0, 60)}`;
        if (message.turn >= boundary) {
            card.addChild(new Text(`${mark} ${message.name}${key}`, 0, 0));
            if (message.result !== '') {
                if (isDiffResult(message.name, message.result)) {
                    for (const line of renderDiffLines(message.result)) {
                        card.addChild(new Text(line, 0, 0));
                    }
                }
                else {
                    card.addChild(new Text(message.result, 0, 0));
                }
            }
        }
        else {
            const resultPreview = message.result === ''
                ? ''
                : ` — ${preview(message.result, RESULT_PREVIEW_LINES)}`;
            card.addChild(new Text(`${mark} ${message.name}${key}${resultPreview}`, 0, 0));
        }
        return card;
    }
    /** Request a render on the active screen. */
    requestRender() {
        ;
        (this.fullscreen ?? this.tui).requestRender();
    }
    /**
     * Reflect the todo list in the header line: active (non-completed) count
     * and, when the list is non-empty, the first active item's text.
     * @param todos - the latest todo/write snapshot.
     */
    setTodoSummary(todos) {
        this.todoItems = todos;
        const active = todos.filter(todo => todo.status !== 'completed');
        const done = todos.length - active.length;
        if (active.length === 0) {
            this.todoText = done > 0 ? ` · ${done} todo done` : '';
        }
        else {
            const first = active[0];
            const label = first === undefined ? '' : first.content.length > 30 ? `${first.content.slice(0, 30)}…` : first.content;
            this.todoText = ` · ${active.length} active · ${label}`;
        }
        this.renderHeader();
        if (this.todoPanelVisible)
            this.renderTodoPanel();
    }
    /** Toggle the todo panel between the transcript and the editor. */
    toggleTodoPanel() {
        this.todoPanelVisible = !this.todoPanelVisible;
        this.renderTodoPanel();
        this.requestRender();
        return this.todoPanelVisible;
    }
    /** Whether the todo panel is currently shown. */
    isTodoPanelVisible() {
        return this.todoPanelVisible;
    }
    /**
     * Rebuild the todo panel text: a header line plus up to five rows,
     * in_progress first, then pending, then completed (strikethrough).
     */
    renderTodoPanel() {
        if (!this.todoPanelVisible) {
            this.todoPanel.setText('');
            return;
        }
        const mark = (todo) => todo.status === 'in_progress'
            ? color.primary('●')
            : todo.status === 'completed' ? color.success('✓') : color.textDim('○');
        const ordered = [
            ...this.todoItems.filter(todo => todo.status === 'in_progress'),
            ...this.todoItems.filter(todo => todo.status === 'pending'),
            ...this.todoItems.filter(todo => todo.status === 'completed'),
        ].slice(0, 5);
        if (ordered.length === 0) {
            this.todoPanel.setText(color.border('─ todo ─'));
            return;
        }
        const lines = ordered.map(todo => {
            const body = todo.status === 'completed' ? `\x1b[9m${todo.content}\x1b[29m` : todo.content;
            return `${mark(todo)} ${body}`;
        });
        this.todoPanel.setText([color.border('─ todo ─'), ...lines].join('\n'));
    }
    /** Hide/show thinking entries; the fold state is untouched. */
    toggleThinkingHidden() {
        this.hideThinking = !this.hideThinking;
        this.rebuildMessages();
        return this.hideThinking;
    }
    /** Whether thinking entries are currently hidden. */
    isThinkingHidden() {
        return this.hideThinking;
    }
    /** Rebuild the header from base + todo summary + plan badge. */
    renderHeader() {
        const badge = this.planMode ? ` ${color.warning('[plan]')}` : '';
        this.headerText = `🐋 dsh-pi-tui${this.todoText}${badge}`;
        this.header.setText(this.headerText);
        this.requestRender();
    }
    /**
     * Update the footer: line 1 `[model] …/cwd branch [ctx bar] t/steps`,
     * line 2 the stats line (full preset) or nothing (compact). Partial
     * updates merge.
     * @param status - the new status values.
     */
    setStatus(status) {
        this.status = { ...this.status, ...status };
        this.renderFooter();
    }
    /** Footer density presets: full keeps the stats line, compact drops it. */
    footerPreset = 'full';
    /** Set the footer density preset and repaint. */
    setFooterPreset(preset) {
        this.footerPreset = preset;
        this.renderFooter();
    }
    /** Whether the footer currently uses the compact preset. */
    getFooterPreset() {
        return this.footerPreset;
    }
    /** Rebuild the two footer lines from the current status and plan badge. */
    renderFooter() {
        const context = this.status.contextTokens !== undefined && this.status.contextWindow !== undefined
            && this.status.contextWindow > 0
            ? contextBar(this.status.contextTokens, this.status.contextWindow)
            : '';
        const line1 = [
            this.planMode ? color.warning('[plan]') : '',
            this.status.goal === undefined || this.status.goal === '' ? '' : color.primary(this.status.goal),
            this.status.model === '' ? '' : `[${this.status.model}]`,
            this.status.cwd,
            this.status.branch === '' ? '' : this.status.branch,
            context,
            `t${this.status.turns}/s${this.status.steps}`,
        ].filter(part => part !== '');
        // Line 2: the stats line only; context pressure is the bar on line 1.
        const line2 = this.footerPreset === 'compact' ? '' : this.status.statsLine;
        this.footerText = [dim(line1.join('  ')), line2 === '' ? '' : dim(line2)].filter(line => line !== '').join('\n');
        this.footer.setText(this.footerText);
        this.requestRender();
    }
    /** Install slash-command + file-path autocompletion on the editor. */
    setCommandCompletions(commands, cwd) {
        this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands], cwd));
    }
    /**
     * Open a single-choice picker overlay (SelectList). Selecting calls
     * `onSelect` with the item value and closes; Esc calls `onCancel`.
     * @param items - choice rows.
     * @param onSelect - confirmed choice.
     * @param onCancel - dismissed without a choice.
     */
    openPicker(items, onSelect, onCancel) {
        const list = new SelectList(items.map(item => ({ ...item })), 10, selectListTheme);
        const handle = this.showOverlayOnHost(new Frame(list), { width: 64, maxHeight: 24 });
        list.onSelect = (item) => {
            handle.hide();
            onSelect(item.value);
        };
        list.onCancel = () => {
            handle.hide();
            onCancel();
        };
    }
    /**
     * Open the settings overlay as a SettingsList. The runner supplies the
     * items and reacts to changes/cancellation.
     * @param items - setting rows.
     * @param onChange - called with (id, newValue) on confirm.
     * @param onCancel - called when the user closes without applying.
     */
    openSettings(items, onChange, onCancel) {
        // SettingsList fires onCancel on Esc/ctrl+c; the overlay must close too,
        // so the cancel callback closes the handle captured after mounting.
        let handle;
        const settings = new SettingsList(items, 6, settingsListTheme, onChange, () => {
            handle?.hide();
            onCancel();
        }, { enableSearch: true });
        handle = this.showOverlayOnHost(new Frame(settings), { width: 72, maxHeight: 28 });
    }
    /** Switch the active color theme and repaint everything. */
    applyTheme(theme) {
        setTheme(theme);
        // Rebuild messages (fresh component instances) and refresh text caches.
        this.rebuildMessages();
        this.header.setText(this.headerText);
        this.footer.setText(this.footerText);
        this.editor.invalidate();
        this.requestRender();
    }
    /** Apply a resolved custom palette and repaint everything. */
    applyPalette(palette) {
        setTheme('custom', palette);
        this.rebuildMessages();
        this.header.setText(this.headerText);
        this.footer.setText(this.footerText);
        this.editor.invalidate();
        this.requestRender();
    }
    /**
     * Query the terminal background (OSC 11) and apply the matching palette.
     * A terminal that never answers leaves the current theme untouched.
     */
    async autoDetectTheme() {
        const rgb = await this.tui.queryTerminalBackgroundColor({ timeoutMs: 800 });
        if (rgb === undefined)
            return;
        this.applyTheme(detectThemeFromBackground(rgb));
    }
    /**
     * Register a live terminal-theme listener (colour-scheme reports). The
     * runner uses it to follow the terminal when the preference is `auto`.
     * @param listener - receives the detected palette family.
     * @returns a disposer.
     */
    onTerminalThemeChange(listener) {
        return this.tui.onTerminalColorSchemeChange((scheme) => listener(scheme));
    }
    /**
     * Queue an approval prompt and resolve when the user decides. Requests
     * queue FIFO; only one dialog is on screen at a time. An aborted signal
     * settles the prompt `cancelled` immediately.
     * @param request - the tool, reason, and optional abort signal.
     * @returns the user's decision.
     */
    showApprovalPrompt(request) {
        return new Promise((resolve) => {
            const pending = { request, resolve };
            if (request.signal !== undefined) {
                const onAbort = () => this.settleApproval(pending, 'cancelled');
                pending.onAbort = onAbort;
                request.signal.addEventListener('abort', onAbort, { once: true });
                if (request.signal.aborted) {
                    this.settleApproval(pending, 'cancelled');
                    return;
                }
            }
            this.approvalQueue.push(pending);
            this.showNextApproval();
        });
    }
    /** Render the next queued prompt, if any and none is showing. */
    showNextApproval() {
        if (this.activeApproval !== undefined || this.approvalQueue.length === 0)
            return;
        const pending = this.approvalQueue.shift();
        if (pending === undefined)
            return;
        this.renderApprovalDialog(pending);
        this.activeApproval = pending;
    }
    /** Build and mount the approval dialog for one prompt on the active screen. */
    renderApprovalDialog(pending) {
        const dialog = new Box(1, 1);
        dialog.addChild(new Text(`Approve ${pending.request.toolName}?`));
        if (pending.request.danger === true) {
            dialog.addChild(new Text(color.error('⚠ DANGEROUS COMMAND — confirm carefully')));
        }
        if (pending.request.arguments !== undefined && pending.request.arguments !== '') {
            const preview = pending.request.arguments.split('\n').slice(0, 6).join('\n');
            dialog.addChild(new Text(color.textDim(preview.length > 240 ? `${preview.slice(0, 240)}…` : preview)));
        }
        if (pending.request.reason !== undefined && pending.request.reason !== '') {
            dialog.addChild(new Text(pending.request.reason));
        }
        dialog.addChild(new Text(''));
        dialog.addChild(new Text('[y] allow once   [n] reject   [esc/ctrl+c] cancel'));
        pending.handle = this.showOverlayOnHost(new Frame(dialog), { width: 60, maxHeight: 16 });
    }
    /** Route a key while a prompt is showing; every key is consumed. */
    handleApprovalKey(data) {
        const pending = this.activeApproval;
        if (pending === undefined)
            return undefined;
        if (matchesKey(data, 'y'))
            this.settleApproval(pending, 'allowed-once');
        else if (matchesKey(data, 'n'))
            this.settleApproval(pending, 'rejected');
        else if (matchesKey(data, 'escape'))
            this.settleApproval(pending, 'cancelled');
        else if (matchesKey(data, 'ctrl+c'))
            this.settleApproval(pending, 'cancelled');
        return { consume: true };
    }
    /** Resolve one prompt, hide its dialog, and show the next in line. */
    settleApproval(pending, outcome) {
        if (this.activeApproval !== pending)
            return;
        this.activeApproval = undefined;
        pending.handle?.hide();
        pending.onAbort !== undefined && pending.request.signal !== undefined
            && pending.request.signal.removeEventListener('abort', pending.onAbort);
        pending.resolve(outcome);
        this.overlayHost.setFocus(this.editor);
        this.showNextApproval();
    }
    /**
     * Ask the user one or more questions through the dialog overlay. One
     * question is on screen at a time; numbered keys select/toggle options,
     * Enter confirms the current question, Esc (or an aborted signal) rejects.
     * Questions without options collect a typed free-text answer.
     * @param questions - the questions to ask.
     * @param signal - optional abort; settles the flow rejected.
     * @returns the answers, in question order.
     */
    askQuestions(questions, signal) {
        return new Promise((resolve, reject) => {
            if (questions.length === 0) {
                resolve([]);
                return;
            }
            const state = {
                questions,
                index: 0,
                selected: new Map(),
                custom: new Map(),
                customText: '',
                resolve,
                reject,
                signal,
            };
            if (signal?.aborted === true) {
                reject(new Error('question flow aborted'));
                return;
            }
            if (signal !== undefined) {
                const onAbort = () => this.settleQuestions(state, 'cancelled');
                state.onAbort = onAbort;
                signal.addEventListener('abort', onAbort, { once: true });
            }
            this.activeQuestions = state;
            this.renderQuestion(state);
        });
    }
    /** Build and mount the dialog for the state's current question. */
    renderQuestion(state) {
        const question = state.questions[state.index];
        if (question === undefined) {
            this.settleQuestions(state, 'done');
            return;
        }
        const dialog = new Box(1, 1);
        if (question.header !== undefined && question.header !== '') {
            dialog.addChild(new Text(color.textDim(question.header)));
        }
        dialog.addChild(new Text(question.question));
        const options = question.options ?? [];
        if (options.length > 0) {
            options.forEach((option, index) => {
                const checked = state.selected.get(question.id)?.has(option.label) === true ? color.success('✓') : ' ';
                dialog.addChild(new Text(`${checked} ${index + 1}) ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`));
            });
        }
        else if (question.multiSelect !== true) {
            dialog.addChild(new Text(`> ${state.customText}`));
            dialog.addChild(new Text('(type an answer, enter to confirm)'));
        }
        dialog.addChild(new Text(''));
        const verb = question.multiSelect === true ? 'toggle' : 'select';
        dialog.addChild(new Text(`[1-9] ${verb}   [enter] confirm   [esc] cancel   (${state.index + 1}/${state.questions.length})`));
        state.handle?.hide();
        state.handle = this.showOverlayOnHost(new Frame(dialog), { width: 72, maxHeight: 24 });
    }
    /** Route a key while a question is showing; every key is consumed. */
    handleQuestionKey(data) {
        const state = this.activeQuestions;
        if (state === undefined)
            return undefined;
        const question = state.questions[state.index];
        if (question === undefined) {
            this.settleQuestions(state, 'done');
            return { consume: true };
        }
        const options = question.options ?? [];
        const digit = /^[1-9]$/.exec(data);
        if (digit !== null) {
            const option = options[Number(digit[0]) - 1];
            if (option !== undefined) {
                const selected = state.selected.get(question.id) ?? new Set();
                if (question.multiSelect === true) {
                    if (selected.has(option.label))
                        selected.delete(option.label);
                    else
                        selected.add(option.label);
                }
                else {
                    selected.clear();
                    selected.add(option.label);
                }
                state.selected.set(question.id, selected);
                this.renderQuestion(state);
            }
            return { consume: true };
        }
        if (matchesKey(data, 'enter')) {
            if (options.length > 0) {
                state.index += 1;
                this.renderQuestion(state);
            }
            else if (question.multiSelect !== true) {
                // Free-text answer collected above the hint line.
                state.custom.set(question.id, state.customText);
                state.customText = '';
                state.index += 1;
                this.renderQuestion(state);
            }
            return { consume: true };
        }
        if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) {
            this.settleQuestions(state, 'cancelled');
            return { consume: true };
        }
        // Free-text input for no-option questions; a chunk may carry several
        // printable characters (paste-like delivery), so append every one.
        if (options.length === 0 && question.multiSelect !== true) {
            if (data === '\x7f' || data === '\b') {
                state.customText = [...state.customText].slice(0, -1).join('');
                this.renderQuestion(state);
            }
            else {
                let appended = false;
                for (const char of data) {
                    if (char.charCodeAt(0) >= 32) {
                        state.customText += char;
                        appended = true;
                    }
                }
                if (appended)
                    this.renderQuestion(state);
            }
        }
        return { consume: true };
    }
    /** Resolve the question flow with its answers, or reject on cancel. */
    settleQuestions(state, outcome) {
        if (this.activeQuestions !== state)
            return;
        this.activeQuestions = undefined;
        state.handle?.hide();
        if (state.onAbort !== undefined && state.signal !== undefined) {
            state.signal.removeEventListener('abort', state.onAbort);
        }
        this.overlayHost.setFocus(this.editor);
        if (outcome === 'cancelled') {
            state.reject(new Error('question flow cancelled'));
            return;
        }
        const answers = state.questions.map(question => {
            const selected = [...(state.selected.get(question.id) ?? [])];
            const custom = (question.options ?? []).length === 0 && question.multiSelect !== true
                ? state.custom.get(question.id)
                : undefined;
            return custom === undefined ? { id: question.id, selected } : { id: question.id, selected, custom };
        });
        state.resolve(answers);
    }
}
// Style helpers from the theme module's token functions.
import { Chalk } from 'chalk';
import { color, currentPalette } from "./theme.js";
const dim = color.textDim;
const successMark = color.success;
const errorMark = color.error;
const chalk = new Chalk({ level: 3 });
const chalkBoldDim = (text) => chalk.bold.hex(currentPalette.textDim)(text);
/** Start the TUI on the process terminal (raw-mode stdin/stdout). */
export function startProcessTui(events) {
    const app = new TuiApp(new ProcessTerminal(), events);
    app.start();
    return app;
}
