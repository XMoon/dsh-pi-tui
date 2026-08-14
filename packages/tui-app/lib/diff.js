/**
 * Unified-diff line rendering for tool results: `+` lines green, `-` lines
 * red, structural lines (hunk headers, file headers) dimmed. Pure functions
 * so the headless tests can drive them without a TUI.
 * @module @dsh-pi-tui/tui-app/diff
 */
import { color } from "./theme.js";
import { relativizeToCwd } from "./present.js";
/**
 * Whether a tool result should render as a diff: edit-class tools always,
 * anything else only when the text carries diff structure.
 * @param name - the tool name.
 * @param result - the tool result text.
 * @returns whether to colorize the result as a diff.
 */
export function isDiffResult(name, result) {
    if (name === 'edit' || name === 'apply_patch' || name === 'apply-patch')
        return true;
    return result.startsWith('diff --git') || result.includes('\ndiff --git') || result.includes('\n@@ ');
}
/**
 * Colorize one unified-diff line.
 * @param line - one line of a unified diff.
 * @returns the colorized line (unchanged when not diff content).
 */
export function renderDiffLine(line) {
    if (line.startsWith('+') && !line.startsWith('+++'))
        return color.success(line);
    if (line.startsWith('-') && !line.startsWith('---'))
        return color.error(line);
    if (line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')
        || line.startsWith('---') || line.startsWith('+++')) {
        return color.textDim(line);
    }
    return line;
}
/**
 * Colorize a whole diff document, one entry per line.
 * @param text - the diff document.
 * @returns the colorized lines.
 */
export function renderDiffLines(text) {
    return text.split('\n').map(renderDiffLine);
}
/**
 * Render a result-side diff view (a `card: 'diff'` presentResult intent) as
 * colored lines: one dimmed File: header per hunk, prior lines as `-` (red),
 * new lines as `+` (green). Hunks whose oldText is null (creates) show only
 * the new lines. Paths relativize against the workspace root when given.
 * @param diffs - the diff view's hunks.
 * @param cwd - workspace root for path relativization; optional.
 * @returns the colored render lines.
 */
export function renderDiffView(diffs, cwd) {
    const lines = [];
    for (const hunk of diffs) {
        lines.push(color.textDim('File: ' + relativizeToCwd(hunk.path, cwd)));
        if (hunk.oldText !== null) {
            for (const line of hunk.oldText.split('\n'))
                lines.push(renderDiffLine('-' + line));
        }
        for (const line of hunk.newText.split('\n'))
            lines.push(renderDiffLine('+' + line));
    }
    return lines;
}
