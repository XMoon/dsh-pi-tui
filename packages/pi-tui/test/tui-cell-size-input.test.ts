import assert from "node:assert";
import { describe, it } from "node:test";
import { getCellDimensions, resetCapabilitiesCache, setCellDimensions } from "../src/terminal-image.ts";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class RecordingVirtualTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(): string[] {
		return [""];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

function withImageTerminal<T>(fn: () => T): T {
	const prevTermProgram = process.env.TERM_PROGRAM;
	const prevTerm = process.env.TERM;
	const prevGhosttyResourcesDir = process.env.GHOSTTY_RESOURCES_DIR;

	process.env.TERM_PROGRAM = "ghostty";
	delete process.env.TERM;
	delete process.env.GHOSTTY_RESOURCES_DIR;
	resetCapabilitiesCache();

	try {
		return fn();
	} finally {
		if (prevTermProgram === undefined) delete process.env.TERM_PROGRAM;
		else process.env.TERM_PROGRAM = prevTermProgram;
		if (prevTerm === undefined) delete process.env.TERM;
		else process.env.TERM = prevTerm;
		if (prevGhosttyResourcesDir === undefined) delete process.env.GHOSTTY_RESOURCES_DIR;
		else process.env.GHOSTTY_RESOURCES_DIR = prevGhosttyResourcesDir;
		resetCapabilitiesCache();
	}
}

describe("TUI cell size responses", () => {
	it("forwards bare escape even when a cell size query was sent at startup", () => {
		withImageTerminal(() => {
			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b");

			assert.deepStrictEqual(recorder.inputs, ["\x1b"]);
			tui.stop();
		});
	});

	it("consumes cell size responses and still forwards later user input", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();

			tui.setFocus(recorder);
			tui.start();

			terminal.sendInput("\x1b[6;20;10t");
			assert.deepStrictEqual(recorder.inputs, []);
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 });

			terminal.sendInput("q");
			assert.deepStrictEqual(recorder.inputs, ["q"]);
			tui.stop();
		});
	});

	it("consumes cell size responses BEFORE input listeners — a consume-everything listener cannot swallow them (X046)", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });

			const terminal = new VirtualTerminal(80, 24);
			const tui: TUI = new TuiMainScreen(terminal);
			const recorder = new InputRecorder();
			const listenerInputs: string[] = [];

			tui.setFocus(recorder);
			// A listener that consumes EVERY chunk (the host's
			// question/approval modal, an unstable raw capture): the
			// terminal-owned cell-size reply must be filtered BEFORE it,
			// or the reply is swallowed and the dimensions stay stale.
			tui.addInputListener((data) => {
				listenerInputs.push(data);
				return { consume: true };
			});
			tui.start();

			terminal.sendInput("\x1b[6;20;10t");
			assert.deepStrictEqual(listenerInputs, [], "the cell-size reply must never reach input listeners");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 10, heightPx: 20 }, "the dimensions must still update");
			tui.stop();
		});
	});

	it("queries only from a STARTED screen and delivers one real reply to one observer (X072)", () => {
		withImageTerminal(() => {
			setCellDimensions({ widthPx: 9, heightPx: 18 });
			const terminal = new RecordingVirtualTerminal(80, 24);
			const tui = new TuiMainScreen(terminal);
			const observed: Array<{ widthPx: number; heightPx: number }> = [];
			const unsubscribe = tui.onCellSizeObserved((cell) => observed.push(cell));

			// Before `start()` this screen does not own the terminal: a query here
			// would be answered into whoever does.
			const writesBeforeStart = terminal.writes.length;
			tui.queryCellSizeForSixel();
			assert.deepStrictEqual(terminal.writes.slice(writesBeforeStart), [], "no query before start");

			tui.start();
			const queriesBefore = terminal.writes.filter((data) => data.includes("\x1b[16t")).length;
			tui.queryCellSizeForSixel();
			const queries = terminal.writes.filter((data) => data.includes("\x1b[16t")).length;
			assert.strictEqual(queries, queriesBefore + 1, "one `CSI 16t` after start");

			// The reply goes through the ONE parser and reaches the observer once.
			terminal.sendInput("\x1b[6;40;20t");
			assert.deepStrictEqual(observed, [{ widthPx: 20, heightPx: 40 }], "the parsed value, not the wire bytes");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 20, heightPx: 40 });

			// Every REAL reply is one observation; whether an identical value is a
			// new fact is the consumer's projection (the SIXEL owner dedupes by
			// value, so a repeated reply never restarts its readiness epoch).
			terminal.sendInput("\x1b[6;40;20t");
			terminal.sendInput("\x1b[6;40;20t");
			assert.strictEqual(observed.length, 3, "each parsed reply reaches the observer once");
			assert.deepStrictEqual(observed[2], { widthPx: 20, heightPx: 40 });

			unsubscribe();
			terminal.sendInput("\x1b[6;30;15t");
			assert.strictEqual(observed.length, 3, "the unsubscribed observer hears nothing");
			assert.deepStrictEqual(getCellDimensions(), { widthPx: 15, heightPx: 30 });
			tui.stop();
		});
	});
});
