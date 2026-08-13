/**
 * Minimal theme for the dsh-pi-tui surface, in the same style as pi-tui's
 * test themes. Chalk level 3 (truecolor) matches modern terminals.
 * @module @dsh-pi-tui/tui-app/theme
 */
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@dsh-pi-tui/pi-tui';
/** SelectList palette: selection, description, scroll, and empty-state hints. */
export declare const selectListTheme: SelectListTheme;
/** Editor palette: only the border is styled; the rest is the terminal default. */
export declare const editorTheme: EditorTheme;
/** Markdown palette for assistant messages. */
export declare const markdownTheme: MarkdownTheme;
