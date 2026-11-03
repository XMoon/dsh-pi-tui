import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { setKittyProtocolActive } from "../src/keys.ts";
import {
	normalizeAppleTerminalInput,
	normalizeNativeShiftEnterInput,
	ProcessTerminal,
	resolveEscapeTimeoutMs,
	shouldKeepTerminalProgressAlive,
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
			assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b]7501;?\x1b\\\x1b[c");
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

	it("forwards device attributes replies that answer other queries", () => {
		const harness = setupNegotiation();
		try {
			harness.send("\x1b[?7u");
			harness.send("\x1b[?62;4;52c");
			assert.equal(harness.getInput(), undefined);

			// The TUI's color query uses DA1 as its own sentinel.
			harness.send("\x1b[?62;4;52c");
			assert.equal(harness.getInput(), "\x1b[?62;4;52c");
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

	// #10607
	describe("program status (OSC 7501)", () => {
		const working = "\x1b]7501;state=working:app=pi\x1b\\";
		const clear = "\x1b]7501;state=clear\x1b\\";

		function withOverride(value: string | undefined, fn: () => void): void {
			const previous = process.env.PI_PROGRAM_STATUS;
			if (value === undefined) delete process.env.PI_PROGRAM_STATUS;
			else process.env.PI_PROGRAM_STATUS = value;
			try {
				fn();
			} finally {
				if (previous === undefined) delete process.env.PI_PROGRAM_STATUS;
				else process.env.PI_PROGRAM_STATUS = previous;
			}
		}

		it("reports the latest status once the terminal answers the query before DA", () => {
			withOverride(undefined, () => {
				const harness = setupNegotiation();
				try {
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					assert.equal(harness.writes.includes(working), false);

					harness.send("\x1b]7501;?\x1b\\");
					assert.equal(harness.getInput(), undefined);
					assert.equal(harness.writes.filter((write) => write === working).length, 1);
					harness.send("\x1b[?62;4;52c");

					harness.terminal.setProgramStatus({ state: "done" });
					assert.equal(harness.writes.at(-1), "\x1b]7501;state=done\x1b\\");
				} finally {
					harness.cleanup();
				}
			});
		});

		it("reports nothing when DA arrives first and swallows late replies", () => {
			withOverride(undefined, () => {
				const harness = setupNegotiation();
				try {
					harness.send("\x1b[?62;4;52c");
					harness.send("\x1b]7501;?\x07");
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });

					assert.equal(harness.getInput(), undefined);
					assert.equal(
						harness.writes.some((write) => write.startsWith("\x1b]7501;state=")),
						false,
					);
				} finally {
					harness.cleanup();
				}
			});
		});

		it("skips the query when PI_PROGRAM_STATUS is set", () => {
			withOverride("1", () => {
				const harness = setupNegotiation();
				try {
					assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b[c");
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					assert.equal(harness.writes.at(-1), working);
				} finally {
					harness.cleanup();
				}
			});
			withOverride("0", () => {
				const harness = setupNegotiation();
				try {
					assert.equal(harness.writes[0], "\x1b[>7u\x1b[?u\x1b[c");
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					assert.equal(harness.writes.includes(working), false);
				} finally {
					harness.cleanup();
				}
			});
		});

		it("does not let a DA reply from before a restart end the new query", () => {
			withOverride(undefined, () => {
				const harness = setupNegotiation();
				try {
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					harness.terminal.stop();
					(harness.terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();

					// The first start's replies arrive late: its DA, then the second start's reply and DA.
					harness.send("\x1b[?62;4;52c");
					harness.send("\x1b]7501;?\x1b\\");
					harness.send("\x1b[?62;4;52c");
					assert.equal(harness.writes.at(-1), working);
					assert.equal(harness.getInput(), undefined);
				} finally {
					harness.cleanup();
				}
			});
		});

		it("clears the status on stop and reports it again after restart", () => {
			withOverride(undefined, () => {
				const harness = setupNegotiation();
				try {
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					harness.send("\x1b]7501;?\x1b\\");
					harness.terminal.stop();
					assert.ok(harness.writes.includes(clear));

					// Stopped: nothing is written until the restarted terminal confirms support again.
					const writesBeforeRestart = harness.writes.length;
					harness.terminal.setProgramStatus({ state: "working", app: "pi" });
					assert.equal(harness.writes.length, writesBeforeRestart);

					(harness.terminal as unknown as { queryAndEnableKittyProtocol(): void }).queryAndEnableKittyProtocol();
					harness.send("\x1b]7501;?\x1b\\");
					assert.equal(harness.writes.at(-1), working);
				} finally {
					harness.cleanup();
				}
			});
		});
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

describe("ProcessTerminal passive DA1 SIXEL observation (dsh-pi-tui divergence X071)", () => {
	const WT_DA1 = "\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52c";
	const NO_SIXEL_DA1 = "\x1b[?61;14;42c";

	/** Full lifecycle harness: real start()/stop(), stubbed process streams. */
	function setupLifecycle() {
		const terminal = new ProcessTerminal();
		const writes: string[] = [];
		const stdinDataListeners: ((data: string) => void)[] = [];
		const resizeListeners: (() => void)[] = [];
		const inputs: string[] = [];
		let cleaned = false;

		const previousWrite = process.stdout.write;
		const previousStdoutOn = process.stdout.on;
		const previousStdoutRemoveListener = process.stdout.removeListener;
		const previousStdinOn = process.stdin.on;
		const previousStdinRemoveListener = process.stdin.removeListener;
		const previousStdinSetEncoding = process.stdin.setEncoding;
		const previousStdinResume = process.stdin.resume;
		const previousStdinPause = process.stdin.pause;
		const previousSetRawModeDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "setRawMode");

		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		process.stdout.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "resize") resizeListeners.push(listener as () => void);
			return process.stdout;
		}) as typeof process.stdout.on;
		process.stdout.removeListener = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
			if (event === "resize") {
				const index = resizeListeners.lastIndexOf(listener as () => void);
				if (index >= 0) resizeListeners.splice(index, 1);
			}
			return process.stdout;
		}) as typeof process.stdout.removeListener;
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

		return {
			terminal,
			writes,
			inputs,
			stdinDataListeners,
			start(): void {
				terminal.start(
					(data) => inputs.push(data),
					() => {},
				);
			},
			send(data: string): void {
				// Deliver as stdin would: every live data listener sees it once.
				for (const listener of [...stdinDataListeners]) listener(data);
			},
			cleanup(): void {
				if (cleaned) return;
				cleaned = true;
				try {
					terminal.stop();
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
			},
		};
	}

	it("observes the SIXEL attribute of the DA1 the keyboard sentinel consumes", () => {
		const harness = setupLifecycle();
		try {
			harness.start();
			const observed: boolean[] = [];
			harness.terminal.onSixelSupport((supported) => observed.push(supported));

			harness.send(WT_DA1);

			// The keyboard sentinel still consumes the owed DA (no editor input),
			// and the fallback stays exactly as before: no Kitty flags => modifyOtherKeys.
			assert.deepEqual(harness.inputs, [], "the owed DA1 must still be consumed by the keyboard sentinel");
			assert.equal(harness.terminal.kittyProtocolActive, false);
			assert.ok(harness.writes.includes("\x1b[>4;2m"), "the modifyOtherKeys fallback must be unchanged");
			assert.deepEqual(observed, [true], "one complete DA1 yields exactly one positive observation");
		} finally {
			harness.cleanup();
		}
	});

	it("does not treat 14 or 42 as SIXEL attribute 4", () => {
		const harness = setupLifecycle();
		try {
			harness.start();
			const observed: boolean[] = [];
			harness.terminal.onSixelSupport((supported) => observed.push(supported));

			harness.send(NO_SIXEL_DA1);

			assert.deepEqual(observed, [false], "a DA1 without a whole `4` token is a negative observation");
			assert.equal(harness.terminal.kittyProtocolActive, false);
		} finally {
			harness.cleanup();
		}
	});

	it("reports the known answer to a late subscriber and never duplicates a repeated fact", () => {
		const harness = setupLifecycle();
		try {
			harness.start();
			harness.send(WT_DA1);

			const late: boolean[] = [];
			harness.terminal.onSixelSupport((supported) => late.push(supported));
			assert.deepEqual(late, [true], "a subscriber registering after the fact gets it synchronously");

			// A repeated identical DA1 must not notify again.
			harness.send(WT_DA1);
			assert.deepEqual(late, [true]);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps one physical-terminal observation across stop() and start()", () => {
		const harness = setupLifecycle();
		try {
			harness.start();
			const observed: boolean[] = [];
			harness.terminal.onSixelSupport((supported) => observed.push(supported));
			harness.send(WT_DA1);
			assert.deepEqual(observed, [true]);

			harness.terminal.stop();
			harness.start();

			// Same physical terminal: the capability cannot be un-learned by a
			// Main <-> Alt borrow, and no new query may be invented for it.
			const afterRestart: boolean[] = [];
			harness.terminal.onSixelSupport((supported) => afterRestart.push(supported));
			assert.deepEqual(afterRestart, [true], "a repeated start() keeps the observed fact");

			const queries = harness.writes.filter((chunk) => chunk.includes("\x1b[c"));
			assert.equal(queries.length, 2, "each start() sends its own query batch; no extra DA1 probe is added");
		} finally {
			harness.cleanup();
		}
	});

	it("unsubscribes idempotently and stops notifying", () => {
		const harness = setupLifecycle();
		try {
			harness.start();
			const observed: boolean[] = [];
			const unsubscribe = harness.terminal.onSixelSupport((supported) => observed.push(supported));

			unsubscribe();
			unsubscribe();
			harness.send(WT_DA1);
			assert.deepEqual(observed, [], "no observation may arrive after unsubscribe");
		} finally {
			harness.cleanup();
		}
	});

	it("ignores CSI 16t, OSC 11 and ordinary keys", () => {
		const harness = setupLifecycle();
		try {
			harness.start();
			const observed: boolean[] = [];
			harness.terminal.onSixelSupport((supported) => observed.push(supported));

			harness.send("\x1b[6;20;10t");
			harness.send("\x1b]11;rgb:2828/2c2c/3434\x1b\\");
			harness.send("x");

			assert.deepEqual(observed, [], "only a complete primary DA1 may change the observation");
		} finally {
			harness.cleanup();
		}
	});

	it("reassembles a fragmented DA1 into one observation", () => {
		const harness = setupLifecycle();
		try {
			harness.start();
			const observed: boolean[] = [];
			harness.terminal.onSixelSupport((supported) => observed.push(supported));

			// Split inside the parameter list: the negotiation buffer must hold the
			// prefix instead of leaking it to the editor.
			harness.send("\x1b[?61;4;6");
			harness.send(";7;14;21;22;23;24;28;32;42;52c");

			assert.deepEqual(harness.inputs, [], "a fragmented DA1 must not reach the editor as text");
			assert.deepEqual(observed, [true]);
		} finally {
			harness.cleanup();
		}
	});
});

describe("shouldKeepTerminalProgressAlive", () => {
	it("treats every Ghostty marker as heartbeat-required", () => {
		assert.equal(shouldKeepTerminalProgressAlive({ TERM_PROGRAM: "ghostty" }), true);
		assert.equal(shouldKeepTerminalProgressAlive({ TERM_PROGRAM: "Ghostty" }), true);
		assert.equal(shouldKeepTerminalProgressAlive({ TERM: "xterm-ghostty" }), true);
		assert.equal(
			shouldKeepTerminalProgressAlive({ GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty/1.0.0" }),
			true,
		);
	});

	it("treats every Monstar marker as heartbeat-required", () => {
		assert.equal(shouldKeepTerminalProgressAlive({ TERM_PROGRAM: "monstar" }), true);
		assert.equal(shouldKeepTerminalProgressAlive({ TERM: "monstar" }), true);
	});

	it("leaves persistent and unknown terminals without a heartbeat", () => {
		assert.equal(shouldKeepTerminalProgressAlive({ TERM_PROGRAM: "tern" }), false);
		assert.equal(shouldKeepTerminalProgressAlive({ TERM_PROGRAM: "kitty" }), false);
		assert.equal(shouldKeepTerminalProgressAlive({ TERM_PROGRAM: "wezterm" }), false);
		assert.equal(shouldKeepTerminalProgressAlive({ WT_SESSION: "a-session-id" }), false);
		assert.equal(shouldKeepTerminalProgressAlive({}), false);
	});
});

describe("ProcessTerminal progress", () => {
	/** Capture every RAW stdout write of a case, restoring the real stream. */
	const captureStdout = () => {
		const writes: string[] = [];
		const previousWrite = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			writes.push(String(chunk));
			return true;
		}) as typeof process.stdout.write;
		return {
			writes,
			restore: () => {
				process.stdout.write = previousWrite;
			},
		};
	};

	/**
	 * Build a terminal with the heartbeat-relevant environment pinned. X059
	 * snapshots the terminal identity ONCE, when `ProcessTerminal` is
	 * constructed, so the env must be in place BEFORE `new ProcessTerminal()`.
	 * Every key the policy reads is cleared first: an ambient Ghostty
	 * (`TERM_PROGRAM` / `GHOSTTY_RESOURCES_DIR`) must not silently turn the
	 * persistent-terminal negative controls green on a developer machine.
	 */
	const withTerminalEnv = <T>(env: NodeJS.ProcessEnv, run: () => T): T => {
		const keys = ["TERM_PROGRAM", "TERM", "GHOSTTY_RESOURCES_DIR"] as const;
		const previous = keys.map((key) => [key, process.env[key]] as const);
		for (const key of keys) delete process.env[key];
		for (const [key, value] of Object.entries(env)) process.env[key] = value;
		try {
			return run();
		} finally {
			for (const [key, value] of previous) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	};

	it("writes a valid OSC 9;4 clear sequence", () => {
		const terminal = new ProcessTerminal();
		const capture = captureStdout();

		try {
			terminal.setProgress(false);
			assert.deepEqual(capture.writes, ["\x1b]9;4;0\x07"]);
		} finally {
			capture.restore();
		}
	});

	it("setProgress(true/false) writes its working/clear bytes once per explicit call (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = withTerminalEnv({ TERM_PROGRAM: "tern" }, () => new ProcessTerminal());
		const capture = captureStdout();

		try {
			terminal.setProgress(true);
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07"]);
			terminal.setProgress(true);
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07", "\x1b]9;4;1;0\x07"],
				"the boolean write stays unconditional (the host owns the dedupe)");
			terminal.setProgress(false);
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07", "\x1b]9;4;1;0\x07", "\x1b]9;4;0\x07"]);
			mock.timers.tick(5000);
			assert.equal(capture.writes.length, 3, "a persistent terminal receives no periodic refresh");
		} finally {
			capture.restore();
			mock.timers.reset();
		}
	});

	it("a persistent terminal's indeterminate writes ONE 9;4;1;0 and starts no heartbeat (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = withTerminalEnv({ TERM_PROGRAM: "tern" }, () => new ProcessTerminal());
		const capture = captureStdout();

		try {
			terminal.setProgressState("indeterminate");
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07"]);
			mock.timers.tick(5000);
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07"], "no periodic 9;4;1;0 refresh");
		} finally {
			capture.restore();
			mock.timers.reset();
		}
	});

	it("snapshots the heartbeat policy at construction, so a later env change cannot flip it (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = withTerminalEnv({ TERM_PROGRAM: "tern" }, () => new ProcessTerminal());
		const previousTermProgram = process.env.TERM_PROGRAM;
		process.env.TERM_PROGRAM = "ghostty";
		const capture = captureStdout();

		try {
			terminal.setProgressState("indeterminate");
			mock.timers.tick(5000);
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07"],
				"the construction-time persistent-terminal snapshot still owns the one-shot policy");
		} finally {
			capture.restore();
			if (previousTermProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = previousTermProgram;
			mock.timers.reset();
		}
	});

	it("Ghostty keeps the 1 s indeterminate heartbeat and starts no second interval (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = withTerminalEnv({ TERM_PROGRAM: "ghostty" }, () => new ProcessTerminal());
		const capture = captureStdout();

		try {
			terminal.setProgressState("indeterminate");
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07"]);
			mock.timers.tick(1000);
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07", "\x1b]9;4;1;0\x07"],
				"the heartbeat re-asserts the state every second");
			mock.timers.tick(1000);
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07", "\x1b]9;4;1;0\x07", "\x1b]9;4;1;0\x07"]);
			terminal.setProgress(true);
			assert.equal(capture.writes.length, 4, "a repeated explicit active writes its own bytes");
			mock.timers.tick(1000);
			assert.equal(capture.writes.length, 5, "a repeated explicit active starts no SECOND interval");
		} finally {
			capture.restore();
			mock.timers.reset();
		}
	});

	it("writes OSC 9;4;4 for paused with no intermediate clear (X059)", () => {
		const terminal = new ProcessTerminal();
		const capture = captureStdout();

		try {
			terminal.setProgressState("paused");
			assert.deepEqual(capture.writes, ["\x1b]9;4;4\x07"]);
		} finally {
			capture.restore();
		}
	});

	it("indeterminate -> paused on Ghostty stops the heartbeat and writes paused directly (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = withTerminalEnv({ TERM_PROGRAM: "ghostty" }, () => new ProcessTerminal());
		const capture = captureStdout();

		try {
			terminal.setProgressState("indeterminate");
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07"]);
			mock.timers.tick(1000);
			assert.equal(capture.writes.length, 2, "the active heartbeat is running");

			terminal.setProgressState("paused");
			assert.deepEqual(capture.writes.slice(1), ["\x1b]9;4;1;0\x07", "\x1b]9;4;4\x07"],
				"paused follows active directly, with NO \u001b]9;4;0 between them");
			mock.timers.tick(5000);
			assert.equal(capture.writes.length, 3, "paused owns no heartbeat of its own");
		} finally {
			capture.restore();
			mock.timers.reset();
		}
	});

	it("a persistent terminal's indeterminate -> paused has no heartbeat and no intermediate clear (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = withTerminalEnv({ TERM_PROGRAM: "tern" }, () => new ProcessTerminal());
		const capture = captureStdout();

		try {
			terminal.setProgressState("indeterminate");
			mock.timers.tick(5000);
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07"], "no heartbeat before the wait");

			terminal.setProgressState("paused");
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07", "\x1b]9;4;4\x07"],
				"paused follows active directly, with NO \u001b]9;4;0 between them");
			mock.timers.tick(5000);
			assert.deepEqual(capture.writes, ["\x1b]9;4;1;0\x07", "\x1b]9;4;4\x07"],
				"paused owns no timer of its own");
		} finally {
			capture.restore();
			mock.timers.reset();
		}
	});

	it("Ghostty's paused -> indeterminate resumes the 1 s heartbeat (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = withTerminalEnv({ TERM_PROGRAM: "ghostty" }, () => new ProcessTerminal());
		const capture = captureStdout();

		try {
			terminal.setProgressState("paused");
			terminal.setProgressState("indeterminate");
			assert.deepEqual(capture.writes, ["\x1b]9;4;4\x07", "\x1b]9;4;1;0\x07"]);
			mock.timers.tick(1000);
			assert.deepEqual(capture.writes, ["\x1b]9;4;4\x07", "\x1b]9;4;1;0\x07", "\x1b]9;4;1;0\x07"],
				"the resumed active state keeps re-asserting itself");
		} finally {
			capture.restore();
			mock.timers.reset();
		}
	});

	it("a persistent terminal's paused -> indeterminate writes one 9;4;1;0 and starts no heartbeat (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = withTerminalEnv({ TERM_PROGRAM: "tern" }, () => new ProcessTerminal());
		const capture = captureStdout();

		try {
			terminal.setProgressState("paused");
			terminal.setProgressState("indeterminate");
			assert.deepEqual(capture.writes, ["\x1b]9;4;4\x07", "\x1b]9;4;1;0\x07"]);
			mock.timers.tick(5000);
			assert.deepEqual(capture.writes, ["\x1b]9;4;4\x07", "\x1b]9;4;1;0\x07"],
				"the resumed active state is a one-shot projection");
		} finally {
			capture.restore();
			mock.timers.reset();
		}
	});

	it("paused -> clear writes the clear sequence and stops every timer (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = new ProcessTerminal();
		const capture = captureStdout();

		try {
			terminal.setProgressState("paused");
			terminal.setProgressState("clear");
			assert.deepEqual(capture.writes, ["\x1b]9;4;4\x07", "\x1b]9;4;0\x07"]);
			mock.timers.tick(2000);
			assert.equal(capture.writes.length, 2);
		} finally {
			capture.restore();
			mock.timers.reset();
		}
	});

	it("stop() clears a PHYSICALLY paused state exactly once and leaves no keepalive (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = new ProcessTerminal();
		const capture = captureStdout();

		try {
			terminal.setProgressState("paused");
			terminal.stop();
			const clears = capture.writes.filter((chunk) => chunk === "\x1b]9;4;0\x07");
			assert.equal(clears.length, 1, "a paused state must not leak into the shell/editor");
			mock.timers.tick(2000);
			assert.deepEqual(capture.writes.filter((chunk) => chunk.startsWith("\x1b]9;4;")),
				["\x1b]9;4;4\x07", "\x1b]9;4;0\x07"], "no progress bytes after the stop");
		} finally {
			capture.restore();
			mock.timers.reset();
		}
	});

	it("stop() clears a one-shot indeterminate state and leaves no timer (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = withTerminalEnv({ TERM_PROGRAM: "tern" }, () => new ProcessTerminal());
		const capture = captureStdout();

		try {
			terminal.setProgressState("indeterminate");
			terminal.stop();
			assert.equal(capture.writes.filter((chunk) => chunk === "\x1b]9;4;1;0\x07").length, 1);
			assert.equal(capture.writes.filter((chunk) => chunk === "\x1b]9;4;0\x07").length, 1);
			const written = capture.writes.length;
			mock.timers.tick(5000);
			assert.equal(capture.writes.length, written, "no progress bytes after the stop");
		} finally {
			capture.restore();
			mock.timers.reset();
		}
	});

	it("stop() clears an ACTIVE heartbeat state and leaves no interval (X059)", () => {
		mock.timers.enable({ apis: ["setInterval"] });
		const terminal = withTerminalEnv({ TERM_PROGRAM: "ghostty" }, () => new ProcessTerminal());
		const capture = captureStdout();

		try {
			terminal.setProgressState("indeterminate");
			mock.timers.tick(1000);
			assert.equal(
				capture.writes.filter((chunk) => chunk === "\x1b]9;4;1;0\x07").length,
				2,
				"the active heartbeat is running before the stop",
			);
			terminal.stop();
			assert.equal(capture.writes.filter((chunk) => chunk === "\x1b]9;4;0\x07").length, 1);
			const written = capture.writes.length;
			mock.timers.tick(5000);
			assert.equal(capture.writes.length, written, "stop() cleared the heartbeat interval");
		} finally {
			capture.restore();
			mock.timers.reset();
		}
	});

	it("stop() after an explicit clear writes no second clear (X059)", () => {
		const terminal = new ProcessTerminal();
		const capture = captureStdout();

		try {
			terminal.setProgress(false);
			terminal.stop();
			assert.deepEqual(capture.writes.filter((chunk) => chunk === "\x1b]9;4;0\x07"), ["\x1b]9;4;0\x07"]);
		} finally {
			capture.restore();
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
