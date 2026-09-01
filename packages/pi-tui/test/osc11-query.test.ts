import assert from "node:assert";
import { describe, it } from "node:test";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("OSC 11 background-color query lifecycle", () => {
	it("times out an unanswered query and does not leak the pending counter", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const first = tui.queryTerminalBackgroundColor({ timeoutMs: 10 });
		// No terminal reply: the query settles undefined on timeout.
		assert.equal(await first, undefined);

		// A second query must still pair with ITS OWN reply. Before the fix,
		// the timed-out query leaked +1 into the pending counter, so the
		// first reply was consumed against a settled query and the second
		// query never resolved.
		const second = tui.queryTerminalBackgroundColor({ timeoutMs: 500 });
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		(tui as unknown as { handleTerminalInput(data: string): void }).handleTerminalInput("\x1b]11;#336699\x07");
		assert.deepEqual(await second, { r: 0x33, g: 0x66, b: 0x99 });
	});

	it("swallows a reply that arrives after its query timed out", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const query = tui.queryTerminalBackgroundColor({ timeoutMs: 10 });
		assert.equal(await query, undefined);
		// A late reply must be consumed as a protocol response, never
		// forwarded to input listeners as typed text.
		const forwarded: string[] = [];
		tui.addInputListener((data) => {
			forwarded.push(data);
			return undefined;
		});
		(tui as unknown as { handleTerminalInput(data: string): void }).handleTerminalInput("\x1b]11;#000000\x07");
		assert.deepEqual(forwarded, [], "late OSC 11 reply leaked into the input path");
	});
});
