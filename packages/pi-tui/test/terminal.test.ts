import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { setKittyProtocolActive } from "../src/keys.ts";
import {
	normalizeAppleTerminalInput,
	normalizeNativeShiftEnterInput,
	ProcessTerminal,
	resolveEscapeTimeoutMs,
} from "../src/terminal.ts";

describe("resolveEscapeTimeoutMs", () => {
	it("uses PI_TUI_ESC_TIMEOUT when configured", () => {
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "80" }), 80);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "80", SSH_TTY: "/dev/pts/1" }), 80);
	});

	it("ignores invalid PI_TUI_ESC_TIMEOUT values", () => {
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "abc" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "0" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "-5" }), 10);
		assert.equal(resolveEscapeTimeoutMs({ PI_TUI_ESC_TIMEOUT: "" }), 10);
	});

	it("defaults to 100ms over SSH", () => {
		assert.equal(resolveEscapeTimeoutMs({ SSH_CONNECTION: "10.0.0.1 22" }), 100);
		assert.equal(resolveEscapeTimeoutMs({ SSH_TTY: "/dev/pts/1" }), 100);
	});

	it("defaults to 10ms otherwise", () => {
		assert.equal(resolveEscapeTimeoutMs({}), 10);
	});
});

describe("normalizeNativeShiftEnterInput", () => {
	it("rewrites Return to CSI-u Shift+Enter when native Shift detection is enabled and Shift is pressed", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", true, true), "\x1b[13;2u");
	});

	it("leaves Return unchanged when native Shift detection is disabled", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", false, true), "\r");
	});

	it("leaves Return unchanged when Shift is not pressed", () => {
		assert.equal(normalizeNativeShiftEnterInput("\r", true, false), "\r");
	});

	it("leaves non-Return input unchanged", () => {
		assert.equal(normalizeNativeShiftEnterInput("\x1b[13;2u", true, true), "\x1b[13;2u");
		assert.equal(normalizeNativeShiftEnterInput("a", true, true), "a");
	});
});

describe("normalizeAppleTerminalInput", () => {
	it("rewrites Apple Terminal Return to CSI-u Shift+Enter when Shift is pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", true, true), "\x1b[13;2u");
	});

	it("leaves Apple Terminal Return unchanged when Shift is not pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", true, false), "\r");
	});

	it("leaves non-Apple Terminal Return unchanged when Shift is pressed", () => {
		assert.equal(normalizeAppleTerminalInput("\r", false, true), "\r");
	});

	it("leaves non-Return input unchanged", () => {
		assert.equal(normalizeAppleTerminalInput("\x1b[13;2u", true, true), "\x1b[13;2u");
		assert.equal(normalizeAppleTerminalInput("a", true, true), "a");
	});
});

describe("ProcessTerminal Kitty keyboard protocol negotiation", () => {
	type NegotiationHarness = {
		terminal: ProcessTerminal;
		writes: string[];
		send(data: string): void;
		getInput(): string | undefined;
		cleanup(): void;
	};

	function setupNegotiation(): NegotiationHarness {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		let input: string | undefined;
		let dataHandler: ((data: string) => void) | undefined;
		let cleaned = false;
		const previousWrite = process.stdout.write;
		const previousOn = process.stdin.on;

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "data") dataHandler = listener as (data: string) => void;
			return process.stdin;
		}) as typeof process.stdin.on;

		(
			terminal as unknown as {
				inputHandler?: (data: string) => void;
				queryAndEnableKittyProtocol(): void;
			}
		).inputHandler = (data) => {
			input = data;
		};
		(terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();

		return {
			terminal,
			writes,
			send(data: string): void {
				dataHandler?.(data);
			},
			getInput(): string | undefined {
				return input;
			},
			cleanup(): void {
				if (cleaned) return;
				cleaned = true;
				try {
					terminal.stop();
				} finally {
					process.stdout.write = previousWrite;
					process.stdin.on = previousOn;
					setKittyProtocolActive(false);
				}
			},
		};
	}

	it("queries Kitty mode before enabling modifyOtherKeys fallback", () => {
		const harness = setupNegotiation();
		try {
			assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b[c");
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			assert.equal(harness.terminal.kittyProtocolActive, false);
		} finally {
			harness.cleanup();
		}
	});

	it("activates Kitty mode for non-zero negotiated flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7u");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, true);
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);

			harness.cleanup();
			assert.equal(harness.writes.filter((write) => write === "\x1b[<u").length, 1);
			assert.equal(harness.writes.includes("\x1b[>4;0m"), false);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to modifyOtherKeys for zero Kitty flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?0u");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);

			harness.cleanup();
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;0m").length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("falls back to modifyOtherKeys for device attributes without Kitty flags", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?62;4;52c");

			assert.equal(harness.getInput(), undefined);
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.equal(harness.writes.filter((write) => write === "\x1b[>4;2m").length, 1);
		} finally {
			harness.cleanup();
		}
	});

	it("forwards normal input while waiting for Kitty response", () => {
		const harness = setupNegotiation();
		try {
			harness.send("a");

			assert.equal(harness.getInput(), "a");
			assert.equal(harness.terminal.kittyProtocolActive, false);
		} finally {
			harness.cleanup();
		}
	});

	it("tracks split Kitty confirmation", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7");
			mock.timers.tick(10);

			assert.equal(harness.getInput(), undefined);

			harness.send("u");

			assert.equal(harness.terminal.kittyProtocolActive, true);
			assert.equal(harness.writes.includes("\x1b[>4;2m"), false);
		} finally {
			harness.cleanup();
			mock.timers.reset();
		}
	});

	it("replays buffered CSI-prefix input when it is not a Kitty response", () => {
		mock.timers.enable({ apis: ["setTimeout"] });
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[");
			mock.timers.tick(50); // StdinBuffer sequence timeout, not the lone-ESC timeout

			assert.equal(harness.getInput(), undefined);

			mock.timers.tick(150);

			assert.equal(harness.getInput(), "\x1b[");
		} finally {
			harness.cleanup();
			mock.timers.reset();
		}
	});
});

describe("ProcessTerminal progress", () => {
	it("writes a valid OSC 9;4 clear sequence", () => {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		const previousWrite = process.stdout.write;

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;

		try {
			terminal.setProgress(false);
			assert.deepEqual(writes, ["\x1b]9;4;0\x07"]);
		} finally {
			process.stdout.write = previousWrite;
		}
	});
});

describe("ProcessTerminal resize listener (dsh-pi-tui divergence X016)", () => {
	it("repeated start() calls swap the resize listener instead of stacking it", () => {
		const terminal = new ProcessTerminal();
		const resizeListeners: (() => void)[] = [];

		const previousWrite = process.stdout.write;
		const previousStdoutOn = process.stdout.on;
		const previousStdoutRemoveListener = process.stdout.removeListener;
		const previousStdinOn = process.stdin.on;
		const previousStdinSetEncoding = process.stdin.setEncoding;
		const previousStdinResume = process.stdin.resume;
		const previousStdinPause = process.stdin.pause;
		const previousSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

		process.stdout.write = ((_chunk: string | Uint8Array) => true) as typeof process.stdout.write;
		process.stdout.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "resize") resizeListeners.push(listener as () => void);
			return process.stdout;
		}) as typeof process.stdout.on;
		process.stdout.removeListener = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "resize") {
				const index = resizeListeners.lastIndexOf(listener);
				if (index >= 0) resizeListeners.splice(index, 1);
			}
			return process.stdout;
		}) as typeof process.stdout.removeListener;
		process.stdin.on = (() => process.stdin) as typeof process.stdin.on;
		process.stdin.setEncoding = (() => process.stdin) as typeof process.stdin.setEncoding;
		process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
		process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause;
		Object.defineProperty(process.stdin, "setRawMode", {
			value: () => process.stdin,
			configurable: true,
		});

		try {
			const callsA: number[] = [];
			const callsB: number[] = [];
			terminal.start(
				() => {},
				() => callsA.push(1),
			);
			terminal.start(
				() => {},
				() => callsB.push(1),
			);

			// Only the CURRENT handler may stay registered: a stacked stale
			// listener fires a resize into a dead screen (and leaks per restart).
			assert.equal(resizeListeners.length, 1);
			for (const listener of [...resizeListeners]) listener();
			assert.deepEqual(callsA, []);
			assert.deepEqual(callsB, [1]);

			terminal.stop();
			assert.equal(resizeListeners.length, 0);
		} finally {
			process.stdout.write = previousWrite;
			process.stdout.on = previousStdoutOn;
			process.stdout.removeListener = previousStdoutRemoveListener;
			process.stdin.on = previousStdinOn;
			process.stdin.setEncoding = previousStdinSetEncoding;
			process.stdin.resume = previousStdinResume;
			process.stdin.pause = previousStdinPause;
			if (previousSetRawModeDescriptor) {
				Object.defineProperty(process.stdin, "setRawMode", previousSetRawModeDescriptor);
			} else {
				Reflect.deleteProperty(process.stdin, "setRawMode");
			}
			setKittyProtocolActive(false);
		}
	});

	it("repeated start() calls swap the stdin data handler instead of stacking it (X016)", () => {
		const terminal = new ProcessTerminal();
		const stdinDataListeners: ((data: string) => void)[] = [];

		const previousWrite = process.stdout.write;
		const previousStdoutOn = process.stdout.on;
		const previousStdoutRemoveListener = process.stdout.removeListener;
		const previousStdinOn = process.stdin.on;
		const previousStdinRemoveListener = process.stdin.removeListener;
		const previousStdinSetEncoding = process.stdin.setEncoding;
		const previousStdinResume = process.stdin.resume;
		const previousStdinPause = process.stdin.pause;
		const previousSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

		process.stdout.write = ((_chunk: string | Uint8Array) => true) as typeof process.stdout.write;
		process.stdout.on = (() => process.stdout) as typeof process.stdout.on;
		process.stdout.removeListener = (() => process.stdout) as typeof process.stdout.removeListener;
		process.stdin.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "data") stdinDataListeners.push(listener as (data: string) => void);
			return process.stdin;
		}) as typeof process.stdin.on;
		process.stdin.removeListener = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "data") {
				const index = stdinDataListeners.lastIndexOf(listener as (data: string) => void);
				if (index >= 0) stdinDataListeners.splice(index, 1);
			}
			return process.stdin;
		}) as typeof process.stdin.removeListener;
		process.stdin.setEncoding = (() => process.stdin) as typeof process.stdin.setEncoding;
		process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
		process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause;
		Object.defineProperty(process.stdin, "setRawMode", {
			value: () => process.stdin,
			configurable: true,
		});

		try {
			const inputsA: string[] = [];
			const inputsB: string[] = [];
			terminal.start(
				(data) => inputsA.push(data),
				() => {},
			);
			terminal.start(
				(data) => inputsB.push(data),
				() => {},
			);

			// Only the CURRENT stdin handler may stay registered: a stacked
			// stale handler would forward the same stdin event twice (its
			// StdinBuffer callback and the new one both call inputHandler).
			assert.equal(stdinDataListeners.length, 1);
			stdinDataListeners[0]!("x");
			assert.deepEqual(inputsA, [], "the stale handler must never deliver");
			assert.deepEqual(inputsB, ["x"], "one stdin event must reach the current handler exactly once");

			terminal.stop();
			assert.equal(stdinDataListeners.length, 0, "stop() must remove the current handler");
		} finally {
			process.stdout.write = previousWrite;
			process.stdout.on = previousStdoutOn;
			process.stdout.removeListener = previousStdoutRemoveListener;
			process.stdin.on = previousStdinOn;
			process.stdin.removeListener = previousStdinRemoveListener;
			process.stdin.setEncoding = previousStdinSetEncoding;
			process.stdin.resume = previousStdinResume;
			process.stdin.pause = previousStdinPause;
			if (previousSetRawModeDescriptor) {
				Object.defineProperty(process.stdin, "setRawMode", previousSetRawModeDescriptor);
			} else {
				Reflect.deleteProperty(process.stdin, "setRawMode");
			}
			setKittyProtocolActive(false);
		}
	});

	it("repeated start() keeps the ORIGINAL raw state so stop() restores cooked mode (X016)", () => {
		const terminal = new ProcessTerminal();
		const rawModeCalls: boolean[] = [];
		let isRaw = false;

		const previousWrite = process.stdout.write;
		const previousStdoutOn = process.stdout.on;
		const previousStdoutRemoveListener = process.stdout.removeListener;
		const previousStdinOn = process.stdin.on;
		const previousStdinSetEncoding = process.stdin.setEncoding;
		const previousStdinResume = process.stdin.resume;
		const previousStdinPause = process.stdin.pause;
		const previousIsRawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isRaw");
		const previousSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

		process.stdout.write = ((_chunk: string | Uint8Array) => true) as typeof process.stdout.write;
		process.stdout.on = (() => process.stdout) as typeof process.stdout.on;
		process.stdout.removeListener = (() => process.stdout) as typeof process.stdout.removeListener;
		process.stdin.on = (() => process.stdin) as typeof process.stdin.on;
		process.stdin.setEncoding = (() => process.stdin) as typeof process.stdin.setEncoding;
		process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
		process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause;
		Object.defineProperty(process.stdin, "isRaw", {
			get: () => isRaw,
			configurable: true,
		});
		Object.defineProperty(process.stdin, "setRawMode", {
			value: (raw: boolean) => {
				rawModeCalls.push(raw);
				isRaw = raw;
				return process.stdin;
			},
			configurable: true,
		});

		try {
			terminal.start(
				() => {},
				() => {},
			);
			terminal.start(
				() => {},
				() => {},
			);
			terminal.stop();

			// The FIRST start captured wasRaw=false; the second start finds
			// stdin already raw and must NOT re-capture it, so the final
			// stop() restores the ORIGINAL cooked state. Re-capturing would
			// leave the terminal in raw mode after stop.
			assert.deepEqual(rawModeCalls, [true, true, false], "start(raw), start(raw), stop(cooked)");
		} finally {
			process.stdout.write = previousWrite;
			process.stdout.on = previousStdoutOn;
			process.stdout.removeListener = previousStdoutRemoveListener;
			process.stdin.on = previousStdinOn;
			process.stdin.setEncoding = previousStdinSetEncoding;
			process.stdin.resume = previousStdinResume;
			process.stdin.pause = previousStdinPause;
			if (previousIsRawDescriptor) {
				Object.defineProperty(process.stdin, "isRaw", previousIsRawDescriptor);
			} else {
				Reflect.deleteProperty(process.stdin, "isRaw");
			}
			if (previousSetRawModeDescriptor) {
				Object.defineProperty(process.stdin, "setRawMode", previousSetRawModeDescriptor);
			} else {
				Reflect.deleteProperty(process.stdin, "setRawMode");
			}
			setKittyProtocolActive(false);
		}
	});

	it("repeated start() pushes the Kitty keyboard protocol exactly once (X016)", () => {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];

		const previousWrite = process.stdout.write;
		const previousStdoutOn = process.stdout.on;
		const previousStdoutRemoveListener = process.stdout.removeListener;
		const previousStdinOn = process.stdin.on;
		const previousStdinSetEncoding = process.stdin.setEncoding;
		const previousStdinResume = process.stdin.resume;
		const previousStdinPause = process.stdin.pause;
		const previousSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stdout.on = (() => process.stdout) as typeof process.stdout.on;
		process.stdout.removeListener = (() => process.stdout) as typeof process.stdout.removeListener;
		process.stdin.on = (() => process.stdin) as typeof process.stdin.on;
		process.stdin.setEncoding = (() => process.stdin) as typeof process.stdin.setEncoding;
		process.stdin.resume = (() => process.stdin) as typeof process.stdin.resume;
		process.stdin.pause = (() => process.stdin) as typeof process.stdin.pause;
		Object.defineProperty(process.stdin, "setRawMode", {
			value: () => process.stdin,
			configurable: true,
		});

		try {
			terminal.start(
				() => {},
				() => {},
			);
			terminal.start(
				() => {},
				() => {},
			);
			terminal.stop();

			// CSI > flags u PUSHES a keyboard-protocol layer and CSI < u
			// pops exactly one: a repeated start() must not push again, or
			// the terminal stays in Kitty enhancement mode after exit.
			const pushes = writes.filter((w) => w.includes("\x1b[>7u")).length;
			const pops = writes.filter((w) => w.includes("\x1b[<u")).length;
			assert.equal(pushes, 1, "the keyboard protocol must be pushed exactly once");
			assert.equal(pops, 1, "stop() must pop exactly once");
		} finally {
			process.stdout.write = previousWrite;
			process.stdout.on = previousStdoutOn;
			process.stdout.removeListener = previousStdoutRemoveListener;
			process.stdin.on = previousStdinOn;
			process.stdin.setEncoding = previousStdinSetEncoding;
			process.stdin.resume = previousStdinResume;
			process.stdin.pause = previousStdinPause;
			if (previousSetRawModeDescriptor) {
				Object.defineProperty(process.stdin, "setRawMode", previousSetRawModeDescriptor);
			} else {
				Reflect.deleteProperty(process.stdin, "setRawMode");
			}
			setKittyProtocolActive(false);
		}
	});
});

describe("ProcessTerminal dimensions", () => {
	it("falls back to COLUMNS and LINES before default dimensions", () => {
		const previousColumnsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
		const previousRowsDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		const previousColumns = process.env.COLUMNS;
		const previousLines = process.env.LINES;

		try {
			Object.defineProperty(process.stdout, "columns", { value: undefined, configurable: true });
			Object.defineProperty(process.stdout, "rows", { value: undefined, configurable: true });
			process.env.COLUMNS = "123";
			process.env.LINES = "45";

			const terminal = new ProcessTerminal();

			assert.equal(terminal.columns, 123);
			assert.equal(terminal.rows, 45);
		} finally {
			if (previousColumnsDescriptor) {
				Object.defineProperty(process.stdout, "columns", previousColumnsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "columns");
			}
			if (previousRowsDescriptor) {
				Object.defineProperty(process.stdout, "rows", previousRowsDescriptor);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			if (previousColumns === undefined) {
				delete process.env.COLUMNS;
			} else {
				process.env.COLUMNS = previousColumns;
			}
			if (previousLines === undefined) {
				delete process.env.LINES;
			} else {
				process.env.LINES = previousLines;
			}
		}
	});
});
