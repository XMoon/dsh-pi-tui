/**
 * The animated busy indicator shown on the row directly above the editor
 * while the agent works (a turn is streaming or a tool is running): two
 * whale emojis alternate before a dim Working label, mirroring pi's
 * WorkingStatusIndicator placement. A Text subclass whose idle text renders
 * zero rows, so the row disappears entirely when idle.
 * @module @dsh-pi-tui/tui-app/working
 */
import { Text, type TuiMainScreen } from '@dsh-pi-tui/pi-tui';
export interface WorkingIndicatorOptions {
    /** Animation frames, alternated in order; defaults to the whale pair. */
    frames?: string[];
    /** Frame interval in milliseconds; injectable so tests stay fast. */
    intervalMs?: number;
    /** The label after the animated frame. */
    message?: string;
}
/**
 * A single-row busy indicator. start() shows the first frame and animates;
 * stop() halts the timer (the text stays until the caller clears it); an
 * idle instance renders nothing at all.
 */
export declare class WorkingIndicator extends Text {
    private readonly ui;
    private readonly frames;
    private readonly intervalMs;
    private readonly message;
    private currentFrame;
    private intervalId;
    constructor(ui: TuiMainScreen, options?: WorkingIndicatorOptions);
    /** Show the indicator and start alternating frames. */
    start(): void;
    /** Stop the animation; the text stays until the caller clears it. */
    stop(): void;
    /** Stop the animation and release the timer (containers call this on removal). */
    dispose(): void;
    private restartAnimation;
    private updateDisplay;
}
