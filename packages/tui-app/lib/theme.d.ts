/**
 * Semantic color palette for the dsh-pi-tui surface, aligned with pi's
 * theme-token vocabulary (colors.ts): brand, text, surface, state, diff,
 * and role tokens. Components read tokens through the helper functions
 * below; switching palettes later only swaps this module's exports.
 * @module @dsh-pi-tui/tui-app/theme
 */
import type { EditorTheme, MarkdownTheme, SelectListTheme } from '@dsh-pi-tui/pi-tui';
/** Semantic palette tokens, mirroring pi's ColorPalette vocabulary. */
export interface ColorPalette {
    /** Dominant interactive/brand colour: links, inline code, selection. */
    primary: string;
    /** Secondary highlight: approval prefix, active markers. */
    accent: string;
    /** Default body text. */
    text: string;
    /** Emphasised text. */
    textStrong: string;
    /** Dimmed secondary text: thinking, hints, quotes. */
    textDim: string;
    /** Faintest text: counters, borders. */
    textMuted: string;
    /** Borders: panes, editor border. */
    border: string;
    /** Success: ✓ marks, completed states. */
    success: string;
    /** Warning. */
    warning: string;
    /** Error. */
    error: string;
    /** User-message role colour. */
    roleUser: string;
    /** Shell-mode accent (reserved for `!` shell mode). */
    shellMode: string;
}
/** Dark palette (default), tuned for ≥ 4.5:1 contrast on black. */
export declare const darkColors: ColorPalette;
/** The active palette; a light theme can swap this later. */
export declare const currentPalette: ColorPalette;
/** Style helpers by token name. */
export declare const color: {
    primary: (text: string) => string;
    accent: (text: string) => string;
    text: (text: string) => string;
    textStrong: (text: string) => string;
    textDim: (text: string) => string;
    textMuted: (text: string) => string;
    border: (text: string) => string;
    success: (text: string) => string;
    warning: (text: string) => string;
    error: (text: string) => string;
    roleUser: (text: string) => string;
    shellMode: (text: string) => string;
};
/** SelectList palette from the semantic tokens. */
export declare const selectListTheme: SelectListTheme;
/** Editor palette: focused border uses the brand token. */
export declare const editorTheme: EditorTheme;
/** Markdown palette for assistant messages. */
export declare const markdownTheme: MarkdownTheme;
