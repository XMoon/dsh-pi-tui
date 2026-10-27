/**
 * X066 — exception-safe teardown.
 *
 * `TuiBase.stop()` runs four teardown steps: the screen's own `beforeTerminalStop`
 * hook, cursor restore, physical terminal release, then `afterTerminalStop`
 * (which is where the alternate screen writes its `?1049l` exit). A throwing
 * hook used to abort the rest, stranding the terminal in raw mode with the
 * cursor hidden and the alternate screen active.
 *
 * These cases pin the contract: every step is still ATTEMPTED after an earlier
 * one throws, the FIRST failure is the one rethrown, and a recovery-only
 * failure is never reported as success.
 */
import assert from "node:assert";
import { describe, it } from "node:test";
import type { ProgramStatus, Terminal, TerminalProgressState } from "../src/terminal.ts";
import type { Component } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";

/** A terminal stub whose steps can throw on demand and record what ran. */
class StepTerminal implements Terminal {
	calls: string[] = [];
	writes: string[] = [];
	columns = 40;
	rows = 8;
	kittyProtocolActive = false;
	failShowCursor = false;
	failStop = false;

	start(): void {
		this.calls.push("start");
	}
	stop(): void {
		this.calls.push("stop");
		if (this.failStop) throw new Error("terminal.stop failed");
	}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {
		this.calls.push("showCursor");
		if (this.failShowCursor) throw new Error("showCursor failed");
	}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(_status: ProgramStatus): void {}
	setProgressState(_state: TerminalProgressState): void {}
}

class Lines implements Component {
	render(): string[] {
		return ["content"];
	}
	invalidate(): void {}
}

/** A screen whose stop hooks can throw on demand. */
class HookScreen extends TuiMainScreen {
	failBefore = false;
	failAfter = false;
	steps: string[] = [];

	protected override beforeTerminalStop(options: { preserveScreen?: boolean }): void {
		super.beforeTerminalStop(options as never);
		this.steps.push("before");
		if (this.failBefore) throw new Error("beforeTerminalStop failed");
	}

	protected override afterTerminalStop(options: { preserveScreen?: boolean }): void {
		super.afterTerminalStop(options as never);
		this.steps.push("after");
		if (this.failAfter) throw new Error("afterTerminalStop failed");
	}
}

describe("X066 exception-safe TuiBase.stop", () => {
	it("still runs the remaining teardown steps when beforeTerminalStop throws", () => {
		const terminal = new StepTerminal();
		const screen = new HookScreen(terminal);
		screen.addChild(new Lines());
		screen.start();
		screen.failBefore = true;

		assert.throws(() => screen.stop(), /beforeTerminalStop failed/);
		assert.deepStrictEqual(screen.steps, ["before", "after"], "afterTerminalStop still ran");
		assert.deepStrictEqual(
			terminal.calls.filter((call) => call === "showCursor" || call === "stop"),
			["showCursor", "stop"],
			"cursor restore and physical release still ran",
		);
	});

	it("runs every later step when showCursor throws", () => {
		const terminal = new StepTerminal();
		const screen = new HookScreen(terminal);
		screen.addChild(new Lines());
		screen.start();
		terminal.failShowCursor = true;

		assert.throws(() => screen.stop(), /showCursor failed/);
		assert.ok(terminal.calls.includes("stop"), "the terminal was still released");
		assert.deepStrictEqual(screen.steps, ["before", "after"]);
	});

	it("runs afterTerminalStop when the physical release throws, and rethrows that cause", () => {
		const terminal = new StepTerminal();
		const screen = new HookScreen(terminal);
		screen.addChild(new Lines());
		screen.start();
		terminal.failStop = true;

		assert.throws(() => screen.stop(), /terminal\.stop failed/);
		assert.deepStrictEqual(screen.steps, ["before", "after"], "afterTerminalStop still ran");
	});

	it("rethows the FIRST failure, never a later recovery failure", () => {
		const terminal = new StepTerminal();
		const screen = new HookScreen(terminal);
		screen.addChild(new Lines());
		screen.start();
		screen.failBefore = true;
		screen.failAfter = true;
		terminal.failShowCursor = true;

		// The original cause wins even though three steps failed.
		assert.throws(() => screen.stop(), /beforeTerminalStop failed/);
	});

	it("reports a recovery-only failure as a failure, not as success", () => {
		const terminal = new StepTerminal();
		const screen = new HookScreen(terminal);
		screen.addChild(new Lines());
		screen.start();
		screen.failAfter = true;

		assert.throws(() => screen.stop(), /afterTerminalStop failed/);
	});

	it("keeps the normal path order and stays silent when every step succeeds", () => {
		const terminal = new StepTerminal();
		const screen = new HookScreen(terminal);
		screen.addChild(new Lines());
		screen.start();

		assert.doesNotThrow(() => screen.stop());
		assert.deepStrictEqual(screen.steps, ["before", "after"]);
		assert.deepStrictEqual(
			terminal.calls.filter((call) => call === "showCursor" || call === "stop"),
			["showCursor", "stop"],
		);
	});
});
