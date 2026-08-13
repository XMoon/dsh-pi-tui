/**
 * The dsh-pi-tui application core: a small TUI surface over the pi-tui
 * framework. The terminal is injected so tests can drive a headless
 * virtual terminal (@xterm/headless) instead of a real TTY; the process
 * entry point (startProcessTui) supplies ProcessTerminal.
 * @module @dsh-pi-tui/tui-app/tui-app
 */
import { Editor, Markdown, ProcessTerminal, Text, TuiMainScreen, matchesKey, } from '@dsh-pi-tui/pi-tui';
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
    events;
    constructor(terminal, events) {
        this.events = events;
        this.tui = new TuiMainScreen(terminal);
        this.editor = new Editor(this.tui, editorTheme);
        this.editor.onSubmit = (text) => this.events.onSubmit(text);
        this.markdown = new Markdown('', 0, 0, markdownTheme);
        this.tui.addChild(new Text('dsh-pi-tui'));
        this.tui.addChild(this.markdown);
        this.tui.addChild(this.editor);
        this.tui.setFocus(this.editor);
        this.tui.addInputListener((data) => {
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
}
/** Start the TUI on the process terminal (raw-mode stdin/stdout). */
export function startProcessTui(events) {
    const app = new TuiApp(new ProcessTerminal(), events);
    app.start();
    return app;
}
