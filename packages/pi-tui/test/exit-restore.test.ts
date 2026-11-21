import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { formatProgramStatus } from "../src/program-status.ts";

const fixture = fileURLToPath(new URL("./fixtures/exit-without-stop.ts", import.meta.url));

type FixtureMode = "exit" | "stop";
type ProgramStatusMode = "unsupported" | "supported" | "working";

function runFixture(mode: FixtureMode, status: ProgramStatusMode = "unsupported"): string {
	const result = spawnSync(process.execPath, [fixture, mode, status], {
		encoding: "utf8",
		env: {
			...process.env,
			TMUX: undefined,
			STY: undefined,
			ZELLIJ: undefined,
			TERM: "xterm-256color",
			PI_PROGRAM_STATUS: status === "unsupported" ? "0" : "1",
		},
		stdio: ["pipe", "pipe", "pipe"],
		timeout: 10_000,
	});
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

// Regression for #11170: exit paths that skip stop() left mouse tracking, focus reporting,
// the Kitty keyboard protocol, bracketed paste, and the alternate screen enabled.
describe("terminal restore on process exit", () => {
	it("restores terminal modes when the process exits without stop()", () => {
		const output = runFixture("exit");
		for (const sequence of ["\x1b[?1006l", "\x1b[?1004l", "\x1b[?1003l", "\x1b[?1000l", "\x1b[<u", "\x1b[?2004l"]) {
			assert.equal(count(output, sequence), 1, JSON.stringify(sequence));
		}
		assert.ok(output.indexOf("\x1b[<u") < output.indexOf("\x1b[?1049l"), "Kitty pop must precede leaving alt screen");
		assert.ok(output.endsWith("\x1b[?1049l\x1b[?25h"));
		assert.equal(count(output, formatProgramStatus({ state: "clear" })), 0, "unsupported Program Status is not cleared");
	});

	it("clears active Program Status when the process exits without stop()", () => {
		const output = runFixture("exit", "working");
		const working = formatProgramStatus({ state: "working", app: "dsh-pi-tui" });
		const clear = formatProgramStatus({ state: "clear" });
		assert.equal(count(output, working), 1);
		assert.equal(count(output, clear), 1);
		assert.ok(output.indexOf(working) < output.lastIndexOf(clear), "the active status is cleared after it is written");
	});

	it("does not clear Program Status on process exit when no status is active", () => {
		const output = runFixture("exit", "supported");
		assert.equal(count(output, formatProgramStatus({ state: "clear" })), 0);
	});

	it("does not restore twice after a normal stop()", () => {
		const output = runFixture("stop", "working");
		for (const sequence of ["\x1b[?1006l", "\x1b[?1004l", "\x1b[<u", "\x1b[?2004l", "\x1b[?1049l"]) {
			assert.equal(count(output, sequence), 1, JSON.stringify(sequence));
		}
		assert.equal(count(output, formatProgramStatus({ state: "working", app: "dsh-pi-tui" })), 1);
		assert.equal(count(output, formatProgramStatus({ state: "clear" })), 1, "normal stop clears once; process exit does not duplicate it");
	});
});
