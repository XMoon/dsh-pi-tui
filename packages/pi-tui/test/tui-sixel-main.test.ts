import assert from "node:assert";
import { describe, it } from "node:test";
import type { Terminal } from "../src/terminal.ts";
import type { SixelScreenFootprint, SixelScreenPort } from "../src/terminal-image.ts";
import { type Component, type TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import type { TuiStopOptions } from "../src/tui.ts";

/**
 * A trusted SIXEL raster string. Its bytes are irrelevant to the Screen: the
 * port below is the only thing that may recognize it (X072), and the Screen
 * never parses a DCS.
 */
function sixel(id: string): string {
	return `\x1bP0;1;q"1;1;40;36#0;2;100;0;0#1;2;0;0;100#0!40~#1!40~\x1b\\${id}`;
}

/** A port that trusts exactly the rasters this test registered. */
class TestSixelPort implements SixelScreenPort {
	private readonly rasters = new Map<string, SixelScreenFootprint>();
	private readonly crops = new Map<string, string>();

	register(dcs: string, footprint: SixelScreenFootprint): string {
		this.rasters.set(dcs, footprint);
		return dcs;
	}

	/** Register the ready crop variant a Screen would ask for. */
	registerCrop(line: string, cropTopRows: number, visibleRows: number, dcs: string): string {
		this.rasters.set(dcs, { columns: this.rasters.get(line)?.columns ?? 1, rows: visibleRows });
		this.crops.set(`${line}\u0000${cropTopRows}\u0000${visibleRows}`, dcs);
		return dcs;
	}

	footprint(line: string): SixelScreenFootprint | undefined {
		return this.rasters.get(line);
	}

	crop(line: string, cropTopRows: number, visibleRows: number): string | undefined {
		return this.crops.get(`${line}\u0000${cropTopRows}\u0000${visibleRows}`);
	}

	/** The new X072 candidate surface: these fixtures exercise the DCS trust path. */
	candidate(_line: string): undefined {
		return undefined;
	}

	reconcileVisible(_screen: object, _demands: readonly SixelVisibleCandidate[]): boolean {
		return false;
	}

	materialize(_line: string, _cropTopRows: number, _visibleRows: number): string | undefined {
		return undefined;
	}

	framePainted(_screen: object, _retained: readonly SixelFrameRaster[]): void {}
}

/**
 * A candidate-mode port: components emit tokens, the Screen materializes a DCS
 * only for the blocks the final viewport really shows. The Owner side is this
 * test's map from token to a ready raster and from grant to visibility.
 */
class CandidateSixelPort implements SixelScreenPort {
	private readonly rasters = new Map<string, SixelScreenFootprint>();
	private readonly tokens = new Map<string, { fallback: string; rows: number }>();
	private readonly dcsByToken = new Map<string, string>();
	private readonly grants = new Map<string, number>();
	private seq = 0;

	registerSource(fallback: string, rows: number): string {
		const token = `\u2063SIXC:test${++this.seq}\u2063`;
		this.tokens.set(token, { fallback, rows });
		return token;
	}

	bindRaster(token: string, dcs: string, footprint: SixelScreenFootprint): void {
		this.dcsByToken.set(token, dcs);
		this.rasters.set(dcs, footprint);
	}

	candidate(line: string): { id: string; fallback: string; layoutRows: number } | undefined {
		const token = this.tokens.get(line);
		if (token === undefined) return undefined;
		return { id: line, fallback: token.fallback, layoutRows: token.rows };
	}

	reconcileVisible(_screen: object, demands: readonly SixelVisibleCandidate[]): boolean {
		this.grants.clear();
		const demanded = new Set(demands.map((demand) => demand.line));
		// Stand in for the owner's post-write release: an occurrence the frame no
		// longer shows loses its raster (a later frame must not replay its DCS).
		for (const [token, dcs] of [...this.dcsByToken]) {
			if (demanded.has(token)) continue;
			this.rasters.delete(dcs);
			this.dcsByToken.delete(token);
		}
		for (const demand of demands) this.grants.set(demand.line, demand.visibleRows);
		return false;
	}

	materialize(line: string, _cropTopRows: number, _visibleRows: number): string | undefined {
		if (!this.grants.has(line)) return undefined;
		return this.dcsByToken.get(line);
	}

	framePainted(_screen: object, _retained: readonly SixelFrameRaster[]): void {}

	footprint(line: string): SixelScreenFootprint | undefined {
		return this.rasters.get(line);
	}

	crop(): string | undefined {
		return undefined;
	}

	/** How many distinct rasters the frame materialized. */
	materializedCount(): number {
		return [...this.grants.keys()].filter(token => this.dcsByToken.has(token)).length;
	}
}

class RecordingTerminal implements Terminal {
	readonly writes: string[] = [];
	columns = 40;
	rows = 12;
	readonly kittyProtocolActive = false;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}

	output(): string {
		return this.writes.join("");
	}

	clear(): void {
		this.writes.length = 0;
	}
}

class Document implements Component {
	lines: string[] = [];

	render(_width: number): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

class TestableMainScreen extends TuiMainScreen {
	constructor(terminal: Terminal, port: SixelScreenPort) {
		super(terminal, false, undefined, port);
	}

	renderNow(): void {
		const internals = this as unknown as { doRender: () => void };
		internals.doRender();
	}

	stopWith(options: TuiStopOptions): void {
		const internals = this as unknown as { beforeTerminalStop: (value: TuiStopOptions) => void };
		internals.beforeTerminalStop(options);
	}
}

async function frame(tui: TestableMainScreen): Promise<void> {
	tui.renderNow();
	// `requestRender` schedules; the direct `doRender` above is the frame.
	await Promise.resolve();
}

describe("TuiMainScreen trusted SIXEL footprint (X073)", () => {
	it("reserves the whole block, writes ONE DCS and restores the frame cursor", async () => {
		const terminal = new RecordingTerminal();
		const port = new TestSixelPort();
		const tui = new TestableMainScreen(terminal, port);
		const document = new Document();
		const dcs = port.register(sixel("A"), { columns: 4, rows: 3 });
		document.lines = ["info", dcs, "", "", "tail"];
		tui.addChild(document);
		tui.start();
		await frame(tui);

		const output = terminal.output();
		assert.strictEqual(
			output.split(dcs).length - 1,
			1,
			"the anchor is written exactly once",
		);
		assert.ok(output.includes("\x1b7"), "the anchor's cursor is saved before the command");
		assert.ok(output.includes("\x1b8"), "and restored after it");
		// The FIRST frame renders the whole document through the full-redraw path,
		// so the anchor is placed inline there; the deferred positioning is proven
		// by the incremental cases below.
		// The body rows are reserved and left blank; the DCS lands on the anchor's row.
		assert.strictEqual(tui.captureRenderState().previousLines.length, 5);
		tui.stop();
	});

	it("clears the OLD footprint rows and repaints the raster AFTER the text that replaced it", async () => {
		const terminal = new RecordingTerminal();
		const port = new TestSixelPort();
		const tui = new TestableMainScreen(terminal, port);
		const document = new Document();
		const dcs = port.register(sixel("B"), { columns: 4, rows: 3 });
		document.lines = ["info", dcs, "", "", "tail"];
		tui.addChild(document);
		tui.start();
		await frame(tui);

		// The body rows become text (the picture shrank back to one row of text).
		terminal.clear();
		document.lines = ["info", "text-1", "text-2", "text-3", "tail"];
		await frame(tui);

		const output = terminal.output();
		assert.ok(!output.includes(dcs), "the disposed raster is not painted again");
		const rowClears = output.split("\x1b[2K").length - 1;
		assert.ok(rowClears >= 3, `every old footprint row is cleared with CSI 2K, got ${rowClears}`);
		assert.ok(output.includes("text-1") && output.includes("text-3"), "the replacement text is written");
		tui.stop();
	});

	it("repaints the raster LAST in the frame that makes it ready", async () => {
		const terminal = new RecordingTerminal();
		const port = new TestSixelPort();
		const tui = new TestableMainScreen(terminal, port);
		const document = new Document();
		// Frame 1: the component has no raster yet and paints text rows instead.
		document.lines = ["info", "pending-text", "x", "y", "tail"];
		tui.addChild(document);
		tui.start();
		await frame(tui);

		// Frame 2: the raster is ready AND a text row after the block changes in the
		// SAME frame. The picture must be painted after every text row of the frame,
		// otherwise the next text write would cut the rows it just covered.
		const dcs = port.register(sixel("C"), { columns: 4, rows: 3 });
		terminal.clear();
		document.lines = ["info", dcs, "", "", "tail-changed"];
		await frame(tui);

		const output = terminal.output();
		const anchorAt = output.indexOf(dcs);
		const textAt = output.indexOf("tail-changed");
		assert.ok(anchorAt >= 0, "the raster is painted when it becomes ready");
		assert.ok(textAt >= 0, "the trailing text change is written");
		assert.ok(textAt < anchorAt, "the raster is painted AFTER every text row of the frame");
		assert.ok(
			!output.slice(anchorAt + dcs.length).includes("\x1b[2K"),
			"nothing clears a covered row after the DCS",
		);
		assert.ok(output.includes("\x1b[999A"), "the deferred anchor is positioned from the top margin");
		tui.stop();
	});

	it("keeps the exact footprint cache across a raster-painting diff and erases it later (three frames)", async () => {
		const terminal = new RecordingTerminal();
		const port = new TestSixelPort();
		const tui = new TestableMainScreen(terminal, port);
		const document = new Document();
		document.lines = ["info", "pending", "x", "y", "tail"];
		tui.addChild(document);
		tui.start();
		await frame(tui);

		// Frame 2: the raster becomes ready and the DIFF path paints it.
		const dcs = port.register(sixel("G"), { columns: 4, rows: 3 });
		document.lines = ["info", dcs, "", "", "tail"];
		await frame(tui);
		assert.ok(terminal.output().includes(dcs), "the diff frame paints the command");
		const internals = tui as unknown as {
			previousLineImageRows: number[];
			previousLineSixelRows: number[];
		};
		assert.strictEqual(
			internals.previousLineSixelRows[1],
			3,
			"the SAME sixel cache that the full-redraw path keeps must be maintained by the diff tail",
		);
		assert.strictEqual(internals.previousLineImageRows[1], 3);

		// Frame 3: the block is replaced by three text rows; every old row is erased.
		terminal.clear();
		document.lines = ["info", "a", "b", "c", "tail"];
		await frame(tui);
		const output = terminal.output();
		assert.ok(!output.includes(dcs), "the retired command is not repainted");
		assert.ok((output.match(/\x1b\[2K/g) ?? []).length >= 3, "all three old footprint rows are cleared");
		tui.stop();
	});

	it("writes no SIXEL control for a text-only frame", async () => {
		const terminal = new RecordingTerminal();
		const port = new TestSixelPort();
		const tui = new TestableMainScreen(terminal, port);
		const document = new Document();
		const dcs = port.register(sixel("D"), { columns: 4, rows: 3 });
		document.lines = ["info", dcs, "", "", "tail"];
		tui.addChild(document);
		tui.start();
		await frame(tui);

		terminal.clear();
		document.lines = ["info", dcs, "", "", "tail", "appended"];
		await frame(tui);

		const output = terminal.output();
		assert.ok(!output.includes(dcs), "an unchanged block is not repainted");
		assert.ok(!output.includes("\x1b[999A"), "and no anchor positioning is emitted");
		tui.stop();
	});

	it("suppresses a block a visible overlay paints over, and restores it afterwards", async () => {
		const terminal = new RecordingTerminal();
		const port = new TestSixelPort();
		const tui = new TestableMainScreen(terminal, port);
		const document = new Document();
		const dcs = port.register(sixel("E"), { columns: 4, rows: 3 });
		document.lines = ["info", dcs, "", "", "tail"];
		tui.addChild(document);
		tui.start();
		await frame(tui);

		const overlay: Component = { render: () => ["OVERLAY"], invalidate: () => {} };
		const handle = tui.showOverlay(overlay, { row: 2, col: 0, width: 10 });
		terminal.clear();
		await frame(tui);
		assert.ok(!terminal.output().includes(dcs), "an overlay over any block row wins the whole block this frame");

		tui.hideOverlay(handle);
		terminal.clear();
		await frame(tui);
		assert.ok(terminal.output().includes(dcs), "the block returns when the overlay is gone");
		tui.stop();
	});

	it("keeps the full-redraw contract when the terminal is resized", async () => {
		const terminal = new RecordingTerminal();
		const port = new TestSixelPort();
		const tui = new TestableMainScreen(terminal, port);
		const document = new Document();
		const dcs = port.register(sixel("F"), { columns: 4, rows: 3 });
		document.lines = ["info", dcs, "", "", "tail"];
		tui.addChild(document);
		tui.start();
		await frame(tui);

		terminal.clear();
		terminal.columns = 30;
		await frame(tui);
		assert.ok(terminal.output().includes("\x1b[2J\x1b[H\x1b[3J"), "a width change still clears viewport and scrollback");
		tui.stop();
	});
});

it("keeps native scrollback when a painted image leaves the viewport (X073)", async () => {
	const terminal = new RecordingTerminal();
	terminal.rows = 12;
	const port = new CandidateSixelPort();
	const screen = new TestableMainScreen(terminal, port);
	const document = new Document();
	const tokens: string[] = [];
	for (let index = 0; index < 24; index += 1) {
		const token = port.registerSource(`image ${index}`, 3);
		port.bindRaster(token, sixel(`many-${index}`), { columns: 4, rows: 3 });
		tokens.push(token);
	}
	// 24 three-row blocks: the viewport (12 rows) shows exactly the last four.
	document.lines = tokens.flatMap((token) => [token, "", ""]);
	screen.addChild(document);
	await frame(screen);
	assert.equal(port.materializedCount(), 4, "only the visible tail is materialized");
	const firstFrame = terminal.output();
	assert.ok(firstFrame.includes(sixel("many-23")), "the newest visible image painted");

	// Append one text line: the oldest visible image moves above the viewport.
	// Its pixels are already in native scrollback; a residency-only projection
	// change must not rewrite that history (no `2J`/`3J`).
	terminal.clear();
	document.lines = [...document.lines, "tail text"];
	await frame(screen);
	const wire = terminal.output();
	assert.ok(!wire.includes("\x1b[3J"), "no scrollback clear for a residency-only change");
	assert.ok(!wire.includes("\x1b[2J"), "no full screen clear for a residency-only change");
	assert.ok(wire.includes("tail text"), "the real content change is written");

	// The NEXT ordinary repaint must not turn the released record into
	// `firstChanged` above the viewport: history is decoupled from residency.
	terminal.clear();
	await frame(screen);
	const repaint = terminal.output();
	assert.ok(!repaint.includes("\x1b[3J"), "no scrollback clear on the repaint after a release");
	assert.ok(!repaint.includes("\x1b[2J"), "no full clear on the repaint after a release");
	// The released DCS must leave the history cache too: the Screen keeps only the
	// lightweight fallback, so a long session cannot retain old encoded payloads.
	const history = (screen as unknown as { previousLines: string[] }).previousLines;
	assert.ok(!history.some(line => line.includes("many-20")), "the released DCS is not retained in previousLines");

	// A later full render (a width change) must not replay a released record's
	// DCS: the above-viewport block that lost its grant becomes its own text.
	terminal.clear();
	terminal.rows = 10;
	await frame(screen);
	const fullWire = terminal.output();
	assert.ok(!fullWire.includes("many-20"), "a released raster is never replayed by a full render");
	assert.ok(!fullWire.includes("SIXC"), "no candidate marker reaches the terminal");
	assert.ok(fullWire.includes("image 20"), "the released block is written as its ordinary fallback text");
	const rows = (screen as unknown as { previousLineSixelRows: number[] }).previousLineSixelRows;
	assert.equal(rows[60] ?? 0, 0, "the released history row is no longer recorded as a SIXEL block");
});

it("an overlay over a candidate block's body row yields the whole block (X073)", async () => {
	const terminal = new RecordingTerminal();
	terminal.rows = 12;
	const port = new CandidateSixelPort();
	const screen = new TestableMainScreen(terminal, port);
	const document = new Document();
	const token = port.registerSource("image", 3);
	port.bindRaster(token, sixel("cand"), { columns: 4, rows: 3 });
	document.lines = ["info", token, "", "", "tail"];
	screen.addChild(document);
	screen.start();
	await frame(screen);
	assert.ok(terminal.output().includes(sixel("cand")), "the candidate paints before the overlay");

	const overlay: Component = { render: () => ["OVERLAY"], invalidate: () => {} };
	const handle = screen.showOverlay(overlay, { row: 2, col: 0, width: 10 });
	terminal.clear();
	await frame(screen);
	const covered = terminal.output();
	assert.ok(!covered.includes(sixel("cand")), "a block whose body row an overlay covers paints no DCS");
	assert.ok(!covered.includes("SIXC"), "and no candidate marker reaches the terminal");

	screen.hideOverlay(handle);
	// The fake has no encoder: re-arm the same source the way the real owner
	// re-encodes a released occurrence on its next grant.
	port.bindRaster(token, sixel("cand"), { columns: 4, rows: 3 });
	terminal.clear();
	await frame(screen);
	assert.ok(terminal.output().includes(sixel("cand")), "the block returns when the overlay is gone");
	screen.stop();
});

it("24 images appended one at a time never keep a released DCS in the history cache (X073)", async () => {
	const terminal = new RecordingTerminal();
	terminal.rows = 12;
	const port = new CandidateSixelPort();
	const screen = new TestableMainScreen(terminal, port);
	const document = new Document();
	screen.addChild(document);
	screen.start();
	const tokens: string[] = [];
	for (let index = 0; index < 24; index += 1) {
		const token = port.registerSource(`image ${index}`, 1);
		port.bindRaster(token, sixel(`seq-${index}`), { columns: 4, rows: 1 });
		tokens.push(token);
		document.lines = [...tokens, "tail"];
		terminal.clear();
		await frame(screen);
		assert.ok(!terminal.output().includes("\x1b[3J"), `append ${index} must not clear native scrollback`);
		// The history cache may hold only the rasters still in the viewport; every
		// released payload is swapped to its lightweight fallback, so a long session
		// cannot accumulate old encoded strings in `previousLines`.
		const history = (screen as unknown as { previousLines: string[] }).previousLines;
		const retainedRasters = history.filter((line) => line.includes("\x1bP"));
		assert.ok(retainedRasters.length <= terminal.rows, `at most one viewport of rasters is retained, got ${retainedRasters.length}`);
	}
	screen.stop();
});
