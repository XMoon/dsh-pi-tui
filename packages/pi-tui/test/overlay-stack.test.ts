import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, type TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class FixedLines implements Component {
	lines: string[];

	constructor(lines: string[]) {
		this.lines = lines;
	}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");

async function renderAndFlush(tui: TUI, terminal: VirtualTerminal): Promise<void> {
	tui.requestRender(true);
	await new Promise<void>((resolve) => process.nextTick(resolve));
	await terminal.waitForRender();
}

describe("TUI stacked overlays", () => {
	it("a capturing overlay masks lower overlays within its rows", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new FixedLines(["BASE-0", "BASE-1", "BASE-2"]));
		tui.start();
		try {
			// Lower overlay: 5 rows (centered at rows 9-13), wide box.
			tui.showOverlay(new FixedLines(["WIDE-BOX-0", "WIDE-BOX-1", "WIDE-BOX-2", "WIDE-BOX-3", "WIDE-BOX-4"]), { width: 60 });
			// Upper overlay: 3 rows (rows 10-12), narrower box — must cover
			// the lower box in its rows instead of interleaving with it.
			tui.showOverlay(new FixedLines(["NARROW-BOX-TOP", "NARROW-BOX-MID", "NARROW-BOX-BOT"]), { width: 30 });
			await renderAndFlush(tui, terminal);

			const viewport = terminal.getViewport().map(stripAnsi);
			// The narrow box's own rows show only the narrow box: its 30-wide
			// region holds the content and both sides are blanked, so the
			// wide box's text is fully hidden there.
			const mid = viewport[10]!;
			assert.ok(mid.includes("NARROW-BOX-TOP"), `topmost overlay missing:\n${mid}`);
			assert.ok(!mid.includes("WIDE-BOX"), `lower overlay bleeds into the topmost row:\n${mid}`);
			assert.ok(mid.slice(0, 25).trim() === "", `left of the topmost box must be blank:\n${mid}`);
			assert.ok(mid.slice(55).trim() === "", `right of the topmost box must be blank:\n${mid}`);
			// Rows outside the topmost overlay keep the lower overlay.
			assert.ok(viewport[9]!.includes("WIDE-BOX-0"), `lower overlay lost above the topmost:\n${viewport[9]}`);
			assert.ok(viewport[13]!.includes("WIDE-BOX-4"), `lower overlay lost below the topmost:\n${viewport[13]}`);
		} finally {
			tui.stop();
		}
	});

	it("non-capturing overlays never mask the overlays below them", async () => {
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.addChild(new FixedLines(["BASE"]));
		tui.start();
		try {
			tui.showOverlay(new FixedLines(["WIDE-BOX-0", "WIDE-BOX-1", "WIDE-BOX-2"]), { width: 60 });
			tui.showOverlay(new FixedLines(["NONCAP-TOP", "NONCAP-MID", "NONCAP-BOT"]), { width: 30, nonCapturing: true });
			await renderAndFlush(tui, terminal);

			const viewport = terminal.getViewport().map(stripAnsi);
			// Same rows: the non-capturing overlay is composited on top, but
			// the wide box's content remains visible around it.
			const mid = viewport[11]!;
			assert.ok(mid.includes("NONCAP-MID"), `non-capturing overlay missing:\n${mid}`);
			assert.ok(mid.includes("WIDE-BOX-1"), `non-capturing overlay must not mask:\n${mid}`);
		} finally {
			tui.stop();
		}
	});
});
