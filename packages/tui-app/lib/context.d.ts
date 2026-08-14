/**
 * Context-injection presentation for the TUI: the same provenance projection
 * the Web derives in @deepseek-ai/dsh-client-runtime's contextProvenance, so
 * an injected-context row names its producer the same way a Web row does
 * (AGENTS.md, @deepseek-ai/dsh-system-prompt, skill-catalog, ...). Pure and
 * tolerant: a source arrives as opaque JSON (MessageSource is merge-
 * extensible), so every unreadable shape degrades to `inject` with whatever
 * name the record still carries.
 * @module @dsh-pi-tui/tui-app/context
 */
/** The role and producer name to present for one logged context source. */
export interface ContextProvenance {
    /** recall for a cross-session reference; inject for everything else. */
    role: 'inject' | 'recall';
    /** The producer name (file path, plugin name, skill name); null when unreadable. */
    label: string | null;
}
/**
 * Project one durable message source onto its transcript role and producer
 * name, exactly like the Web's contextProvenance: agent-instructions name
 * their changed file paths, plugins their plugin id, skill invocations their
 * skill name, session references their recalled labels; unknown kinds carry
 * the kind itself.
 * @param source - the logged user/message source, exactly as recorded.
 * @returns the role and producer name to present for this context.
 */
export declare function contextProvenance(source: unknown): ContextProvenance;
/**
 * The one-line account a `notice` form puts on its collapsed row, when the
 * source records one (the Web's noticeSummary).
 * @param source - the logged user/message source.
 * @returns the account, or null when absent or empty.
 */
export declare function contextSummary(source: unknown): string | null;
