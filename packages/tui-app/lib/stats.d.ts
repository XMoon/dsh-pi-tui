/**
 * Session performance statistics folded from the event log, mirroring pi's
 * footer usage line: turns/steps, LLM wall time, first-token latency,
 * output tokens per second, cache hit rate, and token totals.
 * Pure and deterministic for headless tests.
 * @module @dsh-pi-tui/tui-app/stats
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** Aggregated session statistics. */
export interface SessionStats {
    /** Completed turns. */
    turns: number;
    /** Model requests (steps). */
    steps: number;
    /** Total model wall time (step/start → step/end), ms. */
    llmMs: number;
    /** Average time from step/start to the first text delta, ms. */
    firstTokenMsAvg: number;
    /** Output tokens per second over the streaming phases. */
    tokensPerSec: number;
    /** Cache-read share of input tokens, 0–100. */
    cacheHitPct: number;
    /** Uncached input tokens. */
    inputTokens: number;
    /** Output tokens. */
    outputTokens: number;
    /** Context window advertised by the model route, when known. */
    contextWindow?: number;
    /** Cache-read tokens (input share), accumulated while folding. */
    cacheReadTokens: number;
}
/**
 * Fold the session log into performance statistics.
 * @param events - the session log.
 * @returns aggregated statistics.
 */
export declare function computeStats(events: readonly SessionEvent[]): SessionStats;
/**
 * Incremental stats folding: apply appended events and read `snapshot()`
 * anytime. The footer refreshes on every step/turn boundary, so a per-event
 * fold keeps a long session's status line O(1) instead of re-scanning the
 * whole log (computeStats) per refresh.
 */
export declare class StatsFolder {
    private readonly stats;
    private readonly stepStart;
    private readonly firstDelta;
    private readonly lastDelta;
    private readonly outputMs;
    private firstTokenTotal;
    private firstTokenCount;
    /**
     * Apply appended events in log order (a full log on resume, suffixes after).
     * @param events - the appended session events.
     */
    apply(events: readonly SessionEvent[]): void;
    /** The derived stats as of the last applied event. */
    snapshot(): SessionStats;
    private applyEvent;
}
/** Format a token count with pi.s footer rules: 1.5k, 190k, 1.0M, 86M. */
export declare function formatTokens(count: number): string;
/**
 * Render the stats line in pi abbreviation vocabulary:
 * `↑34k ↓8.1k R520k CH93.9% | LLM 138.8s · TTFB 2.6s · 659 tok/s`
 * Cost (`$0.164`) is omitted: dsh's TokenUsage carries no price data.
 * Context pressure lives in the footer's first line (progress bar), so it
 * is not repeated here. Turn/step counters live there too.
 * @param stats - the folded statistics.
 * @returns the display line.
 */
export declare function formatStats(stats: SessionStats): string;
