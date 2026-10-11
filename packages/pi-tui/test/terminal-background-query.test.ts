/**
 * The narrow OSC 11 background seam (`queryTerminalBackgroundColor`) that hosts use for
 * `Theme: auto`. It is deliberately NOT the upstream full colour query: one OSC 11 write, no
 * OSC 10/OSC 4/DA1/DSR, a single in-flight observation per screen, a bounded timeout, and a
 * reply that can never reach the editor or a raw input listener.
 * @module @xmoon76/pi-tui/terminal-background-query.test
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, TuiMainScreen, type TUI } from "../src/index.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/** Records the writes the screen issues, so "exactly one OSC 11 query" stays observable. */
class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class InputRecorder implements Component {
	readonly inputs: string[] = [];

	render(_width: number): string[] {
		return [];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {}
}

const OSC11_QUERY = "\x1b]11;?\x07";

function setup(): { terminal: RecordingTerminal; tui: TUI; component: InputRecorder } {
	const terminal = new RecordingTerminal(40, 10);
	const tui: TUI = new TuiMainScreen(terminal);
	const component = new InputRecorder();
	tui.addChild(component);
	tui.setFocus(component);
	tui.start();
	return { terminal, tui, component };
}

describe("TUI.queryTerminalBackgroundColor (narrow OSC 11 seam)", () => {
	it("writes exactly one OSC 11 query and resolves on the background reply", async () => {
		const { terminal, tui } = setup();
		try {
			const before = terminal.writes.length;
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			assert.deepStrictEqual(
				terminal.writes.slice(before),
				[OSC11_QUERY],
				"the narrow seam must send one OSC 11 query and nothing else (no OSC 10/OSC 4/DA1/DSR)",
			);
			terminal.sendInput("\x1b]11;#336699\x07");
			assert.deepStrictEqual(await query, { r: 0x33, g: 0x66, b: 0x99 });
		} finally {
			tui.stop();
		}
	});

	it("shares one in-flight observation between concurrent calls", async () => {
		const { terminal, tui } = setup();
		try {
			const before = terminal.writes.length;
			const first = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			const second = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			assert.strictEqual(first, second, "the second call must reuse the observation already in flight");
			assert.deepStrictEqual(terminal.writes.slice(before), [OSC11_QUERY], "only one query is written");
			terminal.sendInput("\x1b]11;#111111\x07");
			assert.deepStrictEqual(await first, { r: 0x11, g: 0x11, b: 0x11 });
			assert.deepStrictEqual(await second, { r: 0x11, g: 0x11, b: 0x11 });
		} finally {
			tui.stop();
		}
	});

	it("resolves undefined on the timeout and still consumes a later reply", async () => {
		const { terminal, tui, component } = setup();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 10 });
			assert.strictEqual(await query, undefined);
			terminal.sendInput("\x1b]11;#ffffff\x07");
			assert.deepStrictEqual(component.inputs, [], "a late background reply never reaches the input pipeline");

			// A settled observation does not block the next one.
			const before = terminal.writes.length;
			const next = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			assert.deepStrictEqual(terminal.writes.slice(before), [OSC11_QUERY]);
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(await next, { r: 0, g: 0, b: 0 });
		} finally {
			tui.stop();
		}
	});

	it("takes a reply that arrives after a new observation started as the current observation", async () => {
		// OSC 11 carries no request id: the seam promises an observation of the CURRENT terminal
		// background, not a reply strictly attributable to one request. Callers own the
		// "still relevant?" guard (screen identity, stopped screen, newer explicit choice).
		const { terminal, tui } = setup();
		try {
			const stale = tui.queryTerminalBackgroundColor({ timeoutMs: 5 });
			assert.strictEqual(await stale, undefined);
			const fresh = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]11;#222222\x07");
			assert.deepStrictEqual(await fresh, { r: 0x22, g: 0x22, b: 0x22 });
		} finally {
			tui.stop();
		}
	});

	it("releases a pending observation on stop()", async () => {
		const { tui } = setup();
		const query = tui.queryTerminalBackgroundColor({ timeoutMs: 60_000 });
		tui.stop();
		assert.strictEqual(await query, undefined, "a stopped screen must settle its pending observation");
	});

	it("keeps ordinary keys, modified keys and other colour replies flowing", async () => {
		const { terminal, tui, component } = setup();
		try {
			const query = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			terminal.sendInput("x");
			terminal.sendInput("\x1b[1;2R"); // legacy Shift+F3 is a KEY, not a sentinel
			terminal.sendInput("\x1b]10;#ffffff\x07"); // OSC 10 is not this seam's business
			terminal.sendInput("\x1b]4;0;#000000\x07"); // nor is the palette
			assert.deepStrictEqual(component.inputs, ["x", "\x1b[1;2R", "\x1b]10;#ffffff\x07", "\x1b]4;0;#000000\x07"]);
			terminal.sendInput("\x1b]11;#336699\x07");
			assert.deepStrictEqual(await query, { r: 0x33, g: 0x66, b: 0x99 });
		} finally {
			tui.stop();
		}
	});

	it("consumes an unowned background reply that lands on another screen", async () => {
		// The physical terminal input chain is shared while an observation belongs
		// to one screen: the main screen observes and is stopped, then the reply
		// arrives at a freshly started screen that never probed. It must not
		// surface as user activity on the screen that owns the terminal now.
		const leaving = setup();
		const pending = leaving.tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
		leaving.tui.stop();
		assert.strictEqual(await pending, undefined, "stop() releases the observation");

		const fresh = setup();
		try {
			fresh.terminal.sendInput("\x1b]11;#eeeeee\x07");
			assert.deepStrictEqual(fresh.component.inputs, [], "a cross-screen background reply never reaches the input listeners");
			fresh.terminal.sendInput("\x1b]10;#ffffff\x07");
			assert.deepStrictEqual(fresh.component.inputs, ["\x1b]10;#ffffff\x07"], "other colour replies still follow upstream");
		} finally {
			fresh.tui.stop();
		}
	});

	it("shares the parse with a concurrent full query instead of starving it", async () => {
		const { terminal, tui } = setup();
		try {
			const full = tui.queryTerminalColors({ timeoutMs: 1000 });
			const narrow = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
			terminal.sendInput("\x1b]11;#445566\x07");
			assert.deepStrictEqual(await narrow, { r: 0x44, g: 0x55, b: 0x66 });
			terminal.sendInput("\x1b[c");
			assert.deepStrictEqual((await full).background, { r: 0x44, g: 0x55, b: 0x66 });
		} finally {
			tui.stop();
		}
	});
});
