/**
 * Web-parity tool-card presentation for the TUI. The card header is the same
 * row model the Web derives in @deepseek-ai/dsh-client-ui-tool's tool-call
 * model (design titles per tool variant, SUMMARY_KEYS summaries, workspace-
 * relative paths), and the card body follows the tool-owned render intents
 * (presentCall/presentResult) exactly as the host apiproxy invokes them, so
 * a TUI card renders from the same source as a Web card. All pure: the
 * real tool registry is injected by the runner through toolPresenterFrom.
 * @module @dsh-pi-tui/tui-app/present
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { JsonValue } from '@deepseek-ai/dsh-session';
import type { ToolCallView, ToolDefinition, ToolResultView } from '@deepseek-ai/dsh-tools';
/** Figma row titles per variant (design literals, not translatable copy). */
declare const VARIANT_TITLES: {
    readonly search: "Search";
    readonly read: "Read";
    readonly bash: "Bash";
    readonly write: "Write";
    readonly edit: "Edit";
    readonly code: "Code";
    readonly others: "Tool call";
};
/** One row variant in the Web's vocabulary. */
export type ToolVariant = keyof typeof VARIANT_TITLES;
/** The first line of a text (the Web's ReasoningRow summary for settled rows). */
export declare function firstLine(text: string): string;
/** The last line of a text (the Web's running-reasoning summary). */
export declare function latestLine(text: string): string;
/**
 * Strip the workspace root from a workspace-rooted absolute path (display
 * only), exactly like the Web's relativizeToCwd: only the workspace-root
 * prefix is peeled, both `/` and `\` separators are handled, and a path
 * outside the root is returned unchanged.
 * @param text - the path to shorten.
 * @param cwd - session workspace root; absent or empty leaves the path unchanged.
 * @returns the path relative to the workspace root, or unchanged when it is not rooted there.
 */
export declare function relativizeToCwd(text: string, cwd: string | undefined): string;
/** Classify a tool name into its row variant; unknown names are `others`. */
export declare function classifyTool(name: string): ToolVariant;
/** The rendered card header: design title plus the relativized args summary. */
export interface ToolCardHeader {
    /** Design title (e.g. Read, Search, Bash, a tool-owned title). */
    title: string;
    /** The args-derived summary, workspace-relative; empty when there are no args. */
    summary: string;
}
/**
 * The Web row-model header for one tool card: title = tool-owned title or the
 * variant design title; summary = SUMMARY_KEYS-derived args summary relativized
 * to the workspace root. Unknown variants carry the tool name alongside the
 * summary (the Web's `toolName · base` rule), with the separator dropped when
 * there is no summary text. Slash-command names render without their slash.
 * @param name - the tool name.
 * @param argsRaw - the raw arguments JSON string ('' when absent).
 * @param cwd - workspace root for relativization; optional.
 */
export declare function toolCardHeader(name: string, argsRaw: string, cwd?: string): ToolCardHeader;
/** The completed-result input handed to ToolPresenter.result. */
export interface ToolResultInput {
    /** The final model-facing content blocks. */
    content: readonly ContentBlock[];
    /** Whether the call failed. */
    isError: boolean;
    /** The tool-private presentation payload, when the tool attached one. */
    meta?: JsonValue;
}
/**
 * The presentation bridge the render layer consults: tool-owned render
 * intents (presentCall/presentResult), or undefined for the generic card.
 * Wired by the runner to the live tool registry; pure and replay-safe.
 */
export interface ToolPresenter {
    /** The pending-call view for one tool call, or undefined. */
    call(name: string, argsRaw: string): ToolCallView | undefined;
    /** The completed-call view for one tool result, or undefined. */
    result(name: string, argsRaw: string, result: ToolResultInput): ToolResultView | undefined;
}
/**
 * Build the presentation bridge over a tool-definition lookup (the runner
 * passes `name => ctx.tools.get(name, scope)`). Mirrors the host apiproxy's
 * presenter invocations: args are JSON-parsed and the callbacks are guarded so
 * a throwing tool presenter degrades to the generic card.
 * @param get - resolve one tool definition by name (scope already applied).
 */
export declare function toolPresenterFrom(get: (name: string) => ToolDefinition | undefined): ToolPresenter;
export {};
