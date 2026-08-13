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
import { Box, CombinedAutocompleteProvider, Container, Editor, Markdown, ProcessTerminal, SettingsList, Text, TuiAltScreen, TuiMainScreen, matchesKey, } from '@dsh-pi-tui/pi-tui';
import { editorTheme, markdownTheme, selectListTheme, settingsListTheme, setTheme } from "./theme.js";
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
/** Context bar width in cells; pi renders `[███░░░] pct` in the footer. */
const CONTEXT_BAR_WIDTH = 12;
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
    /** The folded transcript; re-rendered into the messages view on change. */
    messages = [];
    /** Ctrl+O master switch: expand the most recent turns' collapsible entries. */
    toolOutputExpanded = false;
    /** Fullscreen (alt-screen) instance; absent in regular mode. */
    fullscreen;
    /** Footer state. */
    status = { model: '', cwd: '', branch: '', turns: 0, steps: 0, statsLine: '' };
    /** Header text (todo summary), kept for theme-swap repaints. */
    headerText = 'dsh-pi-tui';
    /** Footer text, kept for theme-swap repaints. */
    footerText = '';
    constructor(terminal, events) {
        this.terminal = terminal;
        this.events = events;
        this.tui = new TuiMainScreen(terminal);
        this.editor = new Editor(this.tui, editorTheme);
        this.editor.onSubmit = (text) => this.events.onSubmit(text);
        this.header = new Text('dsh-pi-tui', 0, 0);
        this.messagesView = new Container();
        this.footer = new Text('', 0, 0);
        this.tui.addChild(this.header);
        this.tui.addChild(this.messagesView);
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
    /** Shared key routing: approval first, then folding/mode/exit. */
    handleInput(data) {
        if (this.activeApproval !== undefined) {
            return this.handleApprovalKey(data);
        }
        if (matchesKey(data, 'ctrl+o')) {
            this.toolOutputExpanded = !this.toolOutputExpanded;
            this.rebuildMessages();
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
    /** Toggle between regular (terminal scrollback) and fullscreen (alt screen). */
    toggleFullscreen() {
        if (this.fullscreen === undefined) {
            const alt = new TuiAltScreen(this.terminal);
            for (const child of this.tui.children)
                alt.addChild(child);
            alt.addInputListener((data) => this.handleInput(data));
            this.tui.stop();
            alt.start();
            this.fullscreen = alt;
        }
        else {
            this.fullscreen.stop();
            this.fullscreen = undefined;
            this.tui.start();
        }
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
        const boundary = this.expandBoundary();
        for (const message of this.messages) {
            this.messagesView.addChild(this.renderMessage(message, boundary));
        }
        this.requestRender();
    }
    /** The turn threshold at or above which collapsible entries expand. */
    expandBoundary() {
        if (!this.toolOutputExpanded || EXPAND_RECENT_TURNS <= 0)
            return Number.POSITIVE_INFINITY;
        const turns = new Set();
        for (const message of this.messages) {
            if (message.kind === 'thinking' || message.kind === 'tool')
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
            return new Text(color.roleUser(`You: ${message.text}`), 0, 0);
        }
        if (message.kind === 'assistant') {
            return new Markdown(message.text, 0, 0, markdownTheme);
        }
        if (message.kind === 'thinking') {
            const expanded = message.turn >= boundary;
            const text = expanded
                ? `${dim('_thinking:_')} ${message.text}`
                : dim(`_thinking…_ ${preview(message.text, THINKING_PREVIEW_LINES)} (ctrl+o to expand)`);
            return new Text(text, 0, 0);
        }
        // Tool card: header line, plus args and result when expanded.
        const mark = message.status === 'ok' ? successMark('✓') : message.status === 'error' ? errorMark('✗') : dim('…');
        const card = new Container();
        const argsLine = message.args.trim() === '' ? '' : ` ${message.args.slice(0, 60)}`;
        if (message.turn >= boundary) {
            card.addChild(new Text(`${mark} ${message.name}${argsLine}`, 0, 0));
            if (message.result !== '') {
                card.addChild(new Text(message.result, 0, 0));
            }
        }
        else {
            const resultPreview = message.result === ''
                ? ''
                : ` — ${preview(message.result, RESULT_PREVIEW_LINES)}`;
            card.addChild(new Text(`${mark} ${message.name}${resultPreview}`, 0, 0));
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
        const active = todos.filter(todo => todo.status !== 'completed');
        const done = todos.length - active.length;
        if (active.length === 0) {
            this.headerText = done > 0 ? `dsh-pi-tui · ${done} todo done` : 'dsh-pi-tui';
        }
        else {
            const first = active[0];
            const label = first === undefined ? '' : first.content.length > 30 ? `${first.content.slice(0, 30)}…` : first.content;
            this.headerText = `dsh-pi-tui · ${active.length} active · ${label}`;
        }
        this.header.setText(this.headerText);
        this.requestRender();
    }
    /**
     * Update the footer: line 1 `[model] cwd · branch [ctx bar] t/steps`,
     * line 2 the stats line (turns, LLM timing, tokens). Partial updates merge.
     * @param status - the new status values.
     */
    setStatus(status) {
        this.status = { ...this.status, ...status };
        const context = this.status.contextTokens !== undefined && this.status.contextWindow !== undefined
            && this.status.contextWindow > 0
            ? contextBar(this.status.contextTokens, this.status.contextWindow)
            : '';
        const line1 = [
            this.status.model === '' ? '' : `[${this.status.model}]`,
            this.status.cwd,
            this.status.branch === '' ? '' : `git:${this.status.branch}`,
            context,
            `t${this.status.turns}/s${this.status.steps}`,
        ].filter(part => part !== '');
        const line2 = this.status.statsLine;
        this.footerText = [dim(line1.join('  ')), line2 === '' ? '' : dim(line2)].filter(line => line !== '').join('\n');
        this.footer.setText(this.footerText);
        this.requestRender();
    }
    /** Install slash-command + file-path autocompletion on the editor. */
    setCommandCompletions(commands, cwd) {
        this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider([...commands], cwd));
    }
    /**
     * Open the settings overlay as a SettingsList. The runner supplies the
     * items and reacts to changes/cancellation.
     * @param items - setting rows.
     * @param onChange - called with (id, newValue) on confirm.
     * @param onCancel - called when the user closes without applying.
     */
    openSettings(items, onChange, onCancel) {
        const settings = new SettingsList(items, 8, settingsListTheme, onChange, onCancel, { enableSearch: true });
        this.tui.showOverlay(settings, { width: 72, maxHeight: 20 });
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
        const dialog = new Box(1, 1);
        dialog.addChild(new Text(`Approve ${pending.request.toolName}?`));
        if (pending.request.reason !== undefined && pending.request.reason !== '') {
            dialog.addChild(new Text(pending.request.reason));
        }
        dialog.addChild(new Text(''));
        dialog.addChild(new Text('[y] allow once   [n] reject   [esc] cancel'));
        pending.handle = this.tui.showOverlay(dialog, { width: 60, maxHeight: 10 });
        this.activeApproval = pending;
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
        this.tui.setFocus(this.editor);
        this.showNextApproval();
    }
}
// Style helpers from the theme module's token functions.
import { color } from "./theme.js";
const dim = color.textDim;
const successMark = color.success;
const errorMark = color.error;
/** Start the TUI on the process terminal (raw-mode stdin/stdout). */
export function startProcessTui(events) {
    const app = new TuiApp(new ProcessTerminal(), events);
    app.start();
    return app;
}
