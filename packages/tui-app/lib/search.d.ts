/**
 * The transcript-search overlay component: a one-line query input with a
 * live match counter. Mirrors the fork's alt-screen search component shape
 * (Component + Focusable) so the main-screen overlay host can mount it; the
 * search itself runs in the runner against the folded transcript, not against
 * rendered lines (the terminal scrollback is not addressable programmatically).
 * @module @dsh-pi-tui/tui-app/search
 */
import type { Component, Focusable } from '@dsh-pi-tui/pi-tui';
/** One-line search input with a "Find transcript" title and N/M counter. */
export declare class TranscriptSearchComponent implements Component, Focusable {
    private readonly input;
    private readonly onQueryChange;
    private resultCount;
    private resultIndex;
    private _focused;
    constructor(onQueryChange: (query: string) => void);
    get focused(): boolean;
    set focused(value: boolean);
    /** Publish the current match position (1-based index, total) for the header. */
    setResult(index: number, count: number): void;
    handleInput(data: string): void;
    invalidate(): void;
    render(width: number): string[];
}
