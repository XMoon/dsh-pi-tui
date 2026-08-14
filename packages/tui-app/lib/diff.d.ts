/**
 * Unified-diff line rendering for tool results: `+` lines green, `-` lines
 * red, structural lines (hunk headers, file headers) dimmed. Pure functions
 * so the headless tests can drive them without a TUI.
 * @module @dsh-pi-tui/tui-app/diff
 */
import type { FileDiff } from '@deepseek-ai/dsh-tools';
/**
 * Whether a tool result should render as a diff: edit-class tools always,
 * anything else only when the text carries diff structure.
 * @param name - the tool name.
 * @param result - the tool result text.
 * @returns whether to colorize the result as a diff.
 */
export declare function isDiffResult(name: string, result: string): boolean;
/**
 * Colorize one unified-diff line.
 * @param line - one line of a unified diff.
 * @returns the colorized line (unchanged when not diff content).
 */
export declare function renderDiffLine(line: string): string;
/**
 * Colorize a whole diff document, one entry per line.
 * @param text - the diff document.
 * @returns the colorized lines.
 */
export declare function renderDiffLines(text: string): string[];
/**
 * Render a result-side diff view (a `card: 'diff'` presentResult intent) as
 * colored lines: one dimmed File: header per hunk, prior lines as `-` (red),
 * new lines as `+` (green). Hunks whose oldText is null (creates) show only
 * the new lines. Paths relativize against the workspace root when given.
 * @param diffs - the diff view's hunks.
 * @param cwd - workspace root for path relativization; optional.
 * @returns the colored render lines.
 */
export declare function renderDiffView(diffs: readonly FileDiff[], cwd?: string): string[];
