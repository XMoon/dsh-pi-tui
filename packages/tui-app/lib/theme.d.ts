/**
 * Semantic color palette for the dsh-pi-tui surface, aligned with pi's
 * theme-token vocabulary (colors.ts): brand, text, surface, state, diff,
 * and role tokens. Components read tokens through the helper functions
 * below; switching palettes later only swaps this module's exports.
 * @module @dsh-pi-tui/tui-app/theme
 */
import type { EditorTheme, MarkdownTheme, SelectListTheme, SettingsListTheme } from '@dsh-pi-tui/pi-tui';
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
/** Light palette, tuned for ≥ 4.5:1 contrast on white (pi's values). */
export declare const lightColors: ColorPalette;
/** The active palette; style helpers read it on every call, so swapping is live. */
export declare let currentPalette: ColorPalette;
/** Theme selection modes: built-in palettes or a custom palette file. */
export type ThemeMode = 'dark' | 'light' | 'custom';
/** One custom theme file: optional base palette plus color overrides. */
export interface CustomThemeFile {
    /** Display name, echoed in the theme picker. */
    name: string;
    /** Base palette to inherit unset tokens from; defaults to dark. */
    base?: 'dark' | 'light';
    /** Token overrides; any subset of {@link ColorPalette}. */
    colors?: Partial<ColorPalette>;
}
/**
 * Switch the active palette; callers must invalidate rendered components.
 * `custom` uses the full palette in `customPalette`, or falls back to dark.
 * @param theme - the palette family.
 * @param custom - the resolved custom palette when `theme` is `custom`.
 */
export declare function setTheme(theme: ThemeMode, custom?: ColorPalette): void;
/** Build a full palette from a custom theme file (base + overrides). */
export declare function resolveCustomTheme(file: CustomThemeFile): ColorPalette;
/** Custom-theme directory convention: `~/.dsh-pi-tui/themes/*.json`. */
export declare function customThemesDir(): string;
/** Names of the custom theme files (basename without the extension). */
export declare function customThemeNames(): string[];
/** Load and resolve one custom theme file, or undefined when missing/broken. */
export declare function loadCustomTheme(name: string): ColorPalette | undefined;
/**
 * Classify a terminal background colour (OSC 11 reply) as dark or light by
 * relative luminance; a bright background selects the light palette.
 * @param rgb - the reported background colour.
 * @returns the matching palette family.
 */
export declare function detectThemeFromBackground(rgb: {
    r: number;
    g: number;
    b: number;
}): 'dark' | 'light';
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
/** SettingsList palette from the semantic tokens. */
export declare const settingsListTheme: SettingsListTheme;
/** Editor palette: focused border uses the brand token. */
export declare const editorTheme: EditorTheme;
/** Markdown palette for assistant messages. */
export declare const markdownTheme: MarkdownTheme;
