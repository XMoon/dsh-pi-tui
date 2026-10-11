import assert from "node:assert";
import { describe, it } from "node:test";
import { type Terminal, type TerminalColors, TuiMainScreen, type TUI } from "../src/index.ts";

/**
 * X008: terminal color queries (OSC 10/11/4, ended by a DA1 sentinel) carry no
 * request id, so the fork serializes them — at most one query is ever
 * outstanding on the wire. A timed-out query stays the tombstone for the
 * replies that can still arrive; the next waiting query is written only after
 * the outstanding query's DA1 sentinel. These tests drive the real
 * `queryTerminalColors` API and the production reply consumer.
 */

class RecordingTerminal implements Terminal {
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	readonly writes: string[] = [];

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}

	write(data: string): void {
		this.writes.push(data);
	}

	get columns(): number {
		return 80;
	}

	get rows(): number {
		return 24;
	}

	get kittyProtocolActive(): boolean {
		return false;
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

	sendInput(data: string): void {
		this.inputHandler?.(data);
	}

	/** How many `queryTerminalColors` bursts this terminal has received. */
	colorQueryCount(): number {
		return this.writes.filter((data) => data.includes("\x1b]10;?\x07") && data.includes("\x1b]11;?\x07")).length;
	}
}

const DA1 = "\x1b[?62;22c";
const LATE = { r: 0x11, g: 0x11, b: 0x11 };
const OWN = { r: 0x33, g: 0x66, b: 0x99 };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function setup(): { terminal: RecordingTerminal; tui: TUI } {
	const terminal = new RecordingTerminal();
	const tui: TUI = new TuiMainScreen(terminal);
	tui.start();
	return { terminal, tui };
}

describe("serialized terminal color queries (X008)", () => {
	it("writes at most one color query while an earlier query is still outstanding", async () => {
		const { terminal, tui } = setup();
		try {
			// A times out unanswered but stays the tombstone for its replies.
			const first = tui.queryTerminalColors({ timeoutMs: 5 });
			assert.strictEqual((await first).background, undefined);
			assert.strictEqual(terminal.colorQueryCount(), 1);

			// B must NOT be written while A owns the wire: a concurrent query
			// would let A's late reply be attributed to B.
			const second = tui.queryTerminalColors({ timeoutMs: 500 });
			assert.strictEqual(terminal.colorQueryCount(), 1, "B was written while A was still outstanding");

			// A's late reply is consumed by A, then A's DA1 sentinel frees the
			// wire and only then is B written.
			terminal.sendInput("\x1b]11;#111111\x07");
			assert.strictEqual(terminal.colorQueryCount(), 1);
			terminal.sendInput(DA1);
			assert.strictEqual(terminal.colorQueryCount(), 2, "B must be written after A's DA1 sentinel");

			terminal.sendInput("\x1b]11;#336699\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual((await second).background, OWN);
		} finally {
			tui.stop();
		}
	});

	it("swallows a color reply that arrives after its query timed out", async () => {
		const { terminal, tui } = setup();
		try {
			const forwarded: string[] = [];
			tui.addInputListener((data) => {
				forwarded.push(data);
				return undefined;
			});
			const query = tui.queryTerminalColors({ timeoutMs: 5 });
			assert.strictEqual((await query).background, undefined);

			// The late reply is a protocol response, never editor input.
			terminal.sendInput("\x1b]11;#000000\x07");
			assert.deepStrictEqual(forwarded, [], "late color reply leaked into the input path");
		} finally {
			tui.stop();
		}
	});

	it("attributes a late reply to its own query, never to a later concurrent one", async () => {
		const { terminal, tui } = setup();
		try {
			const late: Array<TerminalColors["background"]> = [];
			const first = tui.queryTerminalColors({
				timeoutMs: 5,
				onLateReply: (colors) => late.push(colors.background),
			});
			const second = tui.queryTerminalColors({ timeoutMs: 500 });
			assert.strictEqual((await first).background, undefined);

			// A's late reply lands on A's late-reply callback, and A's DA1
			// sentinel ends A's turn before B is written.
			terminal.sendInput("\x1b]11;#111111\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual(late, [LATE], "A's late reply must be delivered to A");

			terminal.sendInput("\x1b]11;#336699\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual((await second).background, OWN, "B must resolve with its own reply");
		} finally {
			tui.stop();
		}
	});

	it("does not resolve a query issued after the timeout with an older query's late reply", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 5 });
			assert.strictEqual((await first).background, undefined);
			await wait(20);

			const second = tui.queryTerminalColors({ timeoutMs: 500 });
			// Nobody wrote B: A's late reply is still A's, and B must not take it.
			terminal.sendInput("\x1b]11;#111111\x07");
			const settled = await Promise.race([
				second.then((colors) => ({ kind: "resolved" as const, colors })),
				wait(50).then(() => ({ kind: "waiting" as const })),
			]);
			assert.strictEqual(settled.kind, "waiting", "B resolved from A's late reply");

			// A's DA1 ends A; B is written and pairs with its own reply.
			terminal.sendInput(DA1);
			terminal.sendInput("\x1b]11;#336699\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual((await second).background, OWN);
		} finally {
			tui.stop();
		}
	});

	it("keeps a very late reply from resolving a query sent long after the timeout", async () => {
		const { terminal, tui } = setup();
		try {
			const first = tui.queryTerminalColors({ timeoutMs: 5 });
			const second = tui.queryTerminalColors({ timeoutMs: 1000 });
			assert.strictEqual((await first).background, undefined);

			// No finite grace window: the tombstone persists.
			await wait(300);
			terminal.sendInput("\x1b]11;#111111\x07"); // A's very late reply
			assert.strictEqual(terminal.colorQueryCount(), 1);
			terminal.sendInput(DA1);
			terminal.sendInput("\x1b]11;#336699\x07"); // B's reply
			terminal.sendInput(DA1);
			assert.deepStrictEqual((await second).background, OWN, "B must resolve with its own reply");
		} finally {
			tui.stop();
		}
	});

	it("drops a query that times out while an earlier query still owns the wire", async () => {
		const { terminal, tui } = setup();
		try {
			const owner = tui.queryTerminalColors({ timeoutMs: 500 });
			const queued = tui.queryTerminalColors({ timeoutMs: 5 });
			assert.strictEqual(terminal.colorQueryCount(), 1, "the queued query must not be written yet");

			// The queued query settles on its own timeout while it has never been
			// written: it must be dropped, never sent later as a stale burst.
			assert.strictEqual((await queued).background, undefined);
			terminal.sendInput("\x1b]11;#336699\x07"); // the owner's reply
			terminal.sendInput(DA1); // ends the owner's turn
			assert.strictEqual(terminal.colorQueryCount(), 1, "a settled queued query must never be written");
			assert.deepStrictEqual((await owner).background, OWN);

			// A fresh query still gets the wire and its own reply.
			const third = tui.queryTerminalColors({ timeoutMs: 500 });
			assert.strictEqual(terminal.colorQueryCount(), 2);
			terminal.sendInput("\x1b]11;#111111\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual((await third).background, LATE);
		} finally {
			tui.stop();
		}
	});

	it("swallows a stray color reply and its DA1 sentinel when no query is waiting", async () => {
		const { terminal, tui } = setup();
		try {
			const forwarded: string[] = [];
			tui.addInputListener((data) => {
				forwarded.push(data);
				return undefined;
			});

			// A reply (and the DA1 that ends the same burst) for a query issued on
			// another screen — or whose tombstone was already consumed — is still a
			// protocol response, never typed input. A stray DA1 must not read as
			// user activity either.
			terminal.sendInput("\x1b]11;#000000\x07");
			terminal.sendInput("\x1b]10;#ffffff\x07");
			terminal.sendInput("\x1b]4;3;#ff0000\x07");
			terminal.sendInput(DA1);
			assert.deepStrictEqual(forwarded, [], "an unmatched color reply or DA1 leaked into the input path");
		} finally {
			tui.stop();
		}
	});
});
