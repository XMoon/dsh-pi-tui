/**
 * The animated busy indicator shown on the row directly above the editor
 * while the agent works (a turn is streaming or a tool is running): two
 * whale emojis alternate before a dim Working label, mirroring pi's
 * WorkingStatusIndicator placement. A Text subclass whose idle text renders
 * zero rows, so the row disappears entirely when idle.
 * @module @dsh-pi-tui/tui-app/working
 */
import { Text } from '@dsh-pi-tui/pi-tui';
import { color } from "./theme.js";
/**
 * A single-row busy indicator. start() shows the first frame and animates;
 * stop() halts the timer (the text stays until the caller clears it); an
 * idle instance renders nothing at all.
 */
export class WorkingIndicator extends Text {
    ui;
    frames;
    intervalMs;
    message;
    currentFrame = 0;
    intervalId;
    constructor(ui, options = {}) {
        super('', 0, 0);
        this.ui = ui;
        this.frames = options.frames ?? ['🐋', '🐳'];
        this.intervalMs = options.intervalMs ?? 500;
        this.message = options.message ?? 'Working';
    }
    /** Show the indicator and start alternating frames. */
    start() {
        this.updateDisplay();
        this.restartAnimation();
    }
    /** Stop the animation; the text stays until the caller clears it. */
    stop() {
        if (this.intervalId !== undefined) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }
    /** Stop the animation and release the timer (containers call this on removal). */
    dispose() {
        this.stop();
    }
    restartAnimation() {
        this.stop();
        if (this.frames.length <= 1)
            return;
        this.intervalId = setInterval(() => {
            this.currentFrame = (this.currentFrame + 1) % this.frames.length;
            this.updateDisplay();
        }, this.intervalMs);
    }
    updateDisplay() {
        const frame = this.frames[this.currentFrame] ?? '';
        const indicator = frame === '' ? '' : frame + ' ';
        this.setText(indicator + color.textDim(this.message));
        this.ui.requestRender();
    }
}
