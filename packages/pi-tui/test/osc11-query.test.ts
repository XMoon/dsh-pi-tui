import assert from "node:assert";
import { describe, it } from "node:test";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("OSC 11 background-color query lifecycle", () => {
	it("times out an unanswered query and does not leak the pending counter", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const tuiInternal = tui as unknown as { handleTerminalInput(data: string): void };
		const first = tui.queryTerminalBackgroundColor({ timeoutMs: 10 });
		// No terminal reply: the query settles undefined on timeout.
		assert.equal(await first, undefined);

		// A second query must still pair with ITS OWN reply. The timed-out
		// query stays as the active tombstone until its late reply is
		// consumed (X008 serialization), so the second query is only sent
		// after that — the reply injected here is A's late reply, and the
		// one after it is B's.
		const second = tui.queryTerminalBackgroundColor({ timeoutMs: 500 });
		tuiInternal.handleTerminalInput("\x1b]11;#000000\x07"); // A's late reply (swallowed)
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		tuiInternal.handleTerminalInput("\x1b]11;#336699\x07"); // B's reply
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

	it("does not misattribute a late reply to a concurrent query (X008)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const tuiInternal = tui as unknown as { handleTerminalInput(data: string): void };
		// Two concurrent queries: A times out quickly, B is still waiting.
		const first = tui.queryTerminalBackgroundColor({ timeoutMs: 5 });
		const second = tui.queryTerminalBackgroundColor({ timeoutMs: 500 });
		assert.equal(await first, undefined, "A must settle undefined on timeout");

		// A's LATE reply arrives while B is waiting: it must be swallowed
		// as A's own late reply, never resolve B with A's RGB. The
		// tombstone persists until consumed — no finite grace window.
		tuiInternal.handleTerminalInput("\x1b]11;#111111\x07");

		// B is sent only after A's late reply is consumed, then pairs with
		// its OWN reply.
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		tuiInternal.handleTerminalInput("\x1b]11;#336699\x07");
		assert.deepEqual(await second, { r: 0x33, g: 0x66, b: 0x99 }, "B must resolve with its own RGB, not A's late reply");
	});

	it("does not misattribute a late reply to a query issued AFTER the timeout (X008)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const tuiInternal = tui as unknown as { handleTerminalInput(data: string): void };
		// A times out with NO query waiting: the tombstone stays in the
		// active slot, so a LATER query cannot be resolved by A's late reply.
		const first = tui.queryTerminalBackgroundColor({ timeoutMs: 5 });
		assert.equal(await first, undefined, "A must settle undefined on timeout");

		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		const second = tui.queryTerminalBackgroundColor({ timeoutMs: 500 });
		// A's late reply arrives while B is waiting: swallowed, not B's.
		tuiInternal.handleTerminalInput("\x1b]11;#111111\x07");
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		tuiInternal.handleTerminalInput("\x1b]11;#336699\x07"); // B's reply
		assert.deepEqual(await second, { r: 0x33, g: 0x66, b: 0x99 }, "B must resolve with its own RGB, not A's late reply");
	});

	it("keeps a late reply from resolving a query sent long after the timeout (X008)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui = new TuiMainScreen(terminal);
		const tuiInternal = tui as unknown as { handleTerminalInput(data: string): void };
		// A times out while B is waiting; A's late reply arrives well after
		// any finite grace window would have expired — the permanent
		// tombstone still swallows it.
		const first = tui.queryTerminalBackgroundColor({ timeoutMs: 5 });
		const second = tui.queryTerminalBackgroundColor({ timeoutMs: 1000 });
		assert.equal(await first, undefined, "A must settle undefined on timeout");

		await new Promise<void>((resolve) => setTimeout(resolve, 300));
		tuiInternal.handleTerminalInput("\x1b]11;#111111\x07"); // A's very late reply
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		tuiInternal.handleTerminalInput("\x1b]11;#336699\x07"); // B's reply
		assert.deepEqual(await second, { r: 0x33, g: 0x66, b: 0x99 }, "B must resolve with its own RGB, not A's late reply");
	});
});
