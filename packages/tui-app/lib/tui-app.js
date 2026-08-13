/**
 * The dsh-pi-tui application core: a small TUI surface over the pi-tui
 * framework. The terminal is injected so tests can drive a headless
 * virtual terminal (@xterm/headless) instead of a real TTY; the process
 * entry point (startProcessTui) supplies ProcessTerminal.
 * @module @dsh-pi-tui/tui-app/tui-app
 */
import { Box, Editor, Markdown, ProcessTerminal, Text, TuiMainScreen, matchesKey, } from '@dsh-pi-tui/pi-tui';
import { editorTheme, markdownTheme } from "./theme.js";
/**
 * The minimal interactive surface: a header line plus a multiline editor.
 * Owns the TUI lifecycle; input routing and rendering decisions live here
 * so they are testable without a real terminal.
 */
export class TuiApp {
    tui;
    editor;
    markdown;
    header;
    events;
    /** Prompts awaiting the user's decision; one is shown at a time. */
    approvalQueue = [];
    /** The prompt currently on screen, if any. */
    activeApproval;
    constructor(terminal, events) {
        this.events = events;
        this.tui = new TuiMainScreen(terminal);
        this.editor = new Editor(this.tui, editorTheme);
        this.editor.onSubmit = (text) => this.events.onSubmit(text);
        this.markdown = new Markdown('', 0, 0, markdownTheme);
        this.header = new Text('dsh-pi-tui');
        this.tui.addChild(this.header);
        this.tui.addChild(this.markdown);
        this.tui.addChild(this.editor);
        this.tui.setFocus(this.editor);
        this.tui.addInputListener((data) => {
            if (this.activeApproval !== undefined) {
                return this.handleApprovalKey(data);
            }
            if (matchesKey(data, 'ctrl+c')) {
                this.events.onExit();
                return { consume: true };
            }
            return undefined;
        });
    }
    /** Enter raw mode and start rendering. */
    start() {
        this.tui.start();
    }
    /** Leave raw mode and stop rendering. */
    stop() {
        this.tui.stop();
    }
    /** Replace the transcript body and request a re-render. */
    setTranscript(text) {
        this.markdown.setText(text);
        this.tui.requestRender();
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
            this.header.setText(done > 0 ? `dsh-pi-tui · ${done} todo done` : 'dsh-pi-tui');
        }
        else {
            const first = active[0];
            const label = first === undefined ? '' : first.content.length > 30 ? `${first.content.slice(0, 30)}…` : first.content;
            this.header.setText(`dsh-pi-tui · ${active.length} active · ${label}`);
        }
        this.tui.requestRender();
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
/** Start the TUI on the process terminal (raw-mode stdin/stdout). */
export function startProcessTui(events) {
    const app = new TuiApp(new ProcessTerminal(), events);
    app.start();
    return app;
}
