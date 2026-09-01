/**
 * Main-screen per-frame preprocessing benchmark (divergence X035 guard).
 *
 * Measures the cost of steady frames on TuiMainScreen: render N lines once,
 * then mutate ONLY the trailing spinner line and render repeatedly.
 * Unchanged lines keep their string references across frames, mirroring the
 * host transcript contract (BulletedComponent / ThinkingCompactComponent
 * keep their output reference-stable). The processed-line reuse cache makes
 * such frames O(#changed); without it every frame re-normalizes,
 * re-measures, and re-scans the whole transcript (O(N) with heavy constant
 * factors: ~30-370 ms/frame at 1k-10k lines on a 2026 dev box).
 *
 * Run from packages/pi-tui: node --import tsx/esm test/render-preprocess-bench.ts
 */

import { performance } from "node:perf_hooks";
import type { Terminal } from "../src/terminal.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

const COLUMNS = 100;
const ROWS = 30;
const FRAMES = 100;

/** Terminal that discards output; keeps xterm parsing out of the measurement. */
class NullTerminal implements Terminal {
	bytesWritten = 0;
	columns = COLUMNS;
	rows = ROWS;
	kittyProtocolActive = false;
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytesWritten += data.length;
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

function makeLines(count: number): string[] {
	const lines: string[] = [];
	const words = ["alpha", "bravo", "charlie", "delta", "echo"];
	for (let i = 0; i < count - 1; i++) {
		const word = words[i % words.length]!;
		const prefix = String(i).padStart(6, " ");
		if (i % 5 === 0) {
			lines.push(`\x1b[36m${prefix} ▸ ${word} says hello world, streamed token chunk follows here\x1b[0m`);
		} else if (i % 5 === 1) {
			lines.push(`${prefix} │ ${word} plain text row with a longer tail to fill the line width aa`);
		} else if (i % 5 === 2) {
			lines.push(`\x1b[33m${prefix} ✓ done ${word}\x1b[0m ${"x".repeat(30)}`);
		} else if (i % 5 === 3) {
			lines.push(`${prefix} 中文内容混排 ${word} 测试宽度计算逻辑 ·${"·".repeat(20)}`);
		} else {
			lines.push(`${prefix} ${word}`);
		}
	}
	return lines;
}

function run(lineCount: number) {
	const terminal = new NullTerminal();
	const tui = new TuiMainScreen(terminal);

	const base = makeLines(lineCount);
	let tick = 0;
	const component = {
		focused: false,
		render(_width: number): string[] {
			tick++;
			return [...base, `⠋ thinking ${tick % 10}`];
		},
		invalidate(): void {},
	};
	tui.addChild(component);
	tui.setFocus(component);

	const firstStart = performance.now();
	tui.renderNow();
	const firstMs = performance.now() - firstStart;

	for (let i = 0; i < 5; i++) tui.renderNow(); // warmup

	const start = performance.now();
	for (let i = 0; i < FRAMES; i++) tui.renderNow();
	const wall = performance.now() - start;

	tui.stop();
	console.log(
		`N=${String(lineCount).padStart(5)}  first=${firstMs.toFixed(1)}ms  ` +
			`${FRAMES} spinner frames: wall=${wall.toFixed(1)}ms (${(wall / FRAMES).toFixed(3)}ms/frame)  ` +
			`bytes=${terminal.bytesWritten}`,
	);
}

for (const n of [1000, 5000, 10000]) run(n);
