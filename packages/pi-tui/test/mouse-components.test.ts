import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor, type EditorTheme } from "../src/components/editor.ts";
import { Input } from "../src/components/input.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { SelectList, type SelectListTheme } from "../src/components/select-list.ts";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { Text } from "../src/components/text.ts";
import { Box } from "../src/components/box.ts";
import { Container, CURSOR_MARKER, dispatchMouseEvent, type TuiMouseEvent, type TuiMouseEventType } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function mouse(type: TuiMouseEventType, x: number, y: number, width = 80, height = 10): TuiMouseEvent {
	return {
		type,
		button: "left",
		x,
		y,
		screenX: x,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...(type === "click" ? { clickCount: 1 } : {}),
	};
}

const selectTheme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

const settingsTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const editorTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: selectTheme,
};

class InputOverlay extends Container {
	readonly input = new Input();

	constructor() {
		super();
		this.addChild(this.input);
	}

	handleInput(data: string): void {
		this.input.handleInput(data);
	}
}

describe("mouse-aware components", () => {
	it("positions a single-line input cursor on press", () => {
		const input = new Input();
		input.setValue("hello");
		input.render(20);

		assert.strictEqual(input.handleMouse(mouse("press", 4, 0, 20, 1))?.handled, true);
		input.handleInput("X");
		assert.strictEqual(input.getValue(), "heXllo");
	});

	it("selects and activates list rows", () => {
		const list = new SelectList(
			[
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
				{ value: "c", label: "C" },
				{ value: "d", label: "D" },
				{ value: "e", label: "E" },
			],
			3,
			selectTheme,
		);
		let selected: string | undefined;
		list.onSelect = (item) => {
			selected = item.value;
		};

		assert.strictEqual(list.handleMouse(mouse("press", 1, 2, 40, 3))?.handled, true);
		assert.strictEqual(list.getSelectedItem()?.value, "c");
		assert.strictEqual(list.handleMouse(mouse("click", 1, 2, 40, 3))?.handled, true);
		assert.strictEqual(selected, "c");
	});

	it("activates settings rows", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			[
				{ id: "mode", label: "Mode", currentValue: "one", values: ["one", "two"] },
				{ id: "other", label: "Other", currentValue: "off", values: ["off", "on"] },
				{ id: "third", label: "Third", currentValue: "low", values: ["low", "high"] },
				{ id: "fourth", label: "Fourth", currentValue: "x", values: ["x", "y"] },
			],
			3,
			settingsTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
		);

		list.handleMouse(mouse("press", 1, 2, 40, 5));
		list.handleMouse(mouse("click", 1, 2, 40, 5));
		assert.deepStrictEqual(changes, [{ id: "third", value: "high" }]);
	});

	for (const row of [0, 4]) {
		it(`ignores hover and clicks visible select-list row ${row} after scrolling`, () => {
			const list = new SelectList(
				Array.from({ length: 12 }, (_, i) => ({ value: `item-${i}`, label: `Item ${i}` })),
				5,
				selectTheme,
			);
			const changes: string[] = [];
			let selected: string | undefined;
			list.onSelectionChange = (item) => changes.push(item.value);
			list.onSelect = (item) => {
				selected = item.value;
			};
			list.setSelectedIndex(5);
			list.handleMouse({ ...mouse("wheel", 1, row), wheelDelta: 1 });
			assert.strictEqual(list.getSelectedItem()?.value, "item-6");
			assert.deepStrictEqual(changes, ["item-6"]);
			const before = list.render(80);
			assert.match(before[row], new RegExp(`Item ${4 + row}$`));

			for (const y of [0, 1, 2, 3, 4, row]) {
				assert.strictEqual(list.handleMouse({ ...mouse("move", 1, y), button: "none" }), undefined);
				assert.deepStrictEqual(list.render(80), before);
			}
			assert.strictEqual(list.getSelectedItem()?.value, "item-6");
			assert.deepStrictEqual(changes, ["item-6"]);
			assert.strictEqual(selected, undefined);

			list.handleMouse(mouse("press", 1, row));
			list.render(80);
			list.handleMouse(mouse("click", 1, row));
			assert.strictEqual(selected, `item-${4 + row}`);
			assert.deepStrictEqual(changes, ["item-6", `item-${4 + row}`]);
		});

		it(`ignores hover and clicks visible settings row ${row} after scrolling`, () => {
			const changes: Array<{ id: string; value: string }> = [];
			const list = new SettingsList(
				Array.from({ length: 12 }, (_, i) => ({
					id: `item-${i}`,
					label: `Item ${i}`,
					description: `Description ${i}`,
					currentValue: "off",
					values: ["off", "on"],
				})),
				5,
				settingsTheme,
				(id, value) => changes.push({ id, value }),
				() => {},
				{ enableSearch: true },
			);
			list.selectItem("item-5");
			list.handleMouse({ ...mouse("wheel", 1, row + 2), wheelDelta: 1 });
			const before = list.render(80);
			assert.match(before[4], /^> Item 6/);
			assert.match(before[row + 2], new RegExp(`Item ${4 + row} `));

			for (const y of [0, 1, 2, 3, 4, row]) {
				assert.strictEqual(list.handleMouse({ ...mouse("move", 1, y + 2), button: "none" }), undefined);
				assert.deepStrictEqual(list.render(80), before);
			}
			assert.deepStrictEqual(changes, []);

			list.handleMouse(mouse("press", 1, row + 2));
			list.render(80);
			list.handleMouse(mouse("click", 1, row + 2));
			assert.deepStrictEqual(changes, [{ id: `item-${4 + row}`, value: "on" }]);
		});
	}

	it("keeps a delegating overlay focused when its nested input is clicked", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const overlay = new InputOverlay();
		overlay.input.setValue("hi");
		tui.start();
		tui.showOverlay(overlay, { anchor: "top-left", width: 20 });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<0;5;1m");
		terminal.sendInput("!");
		await terminal.waitForRender();

		assert.strictEqual(overlay.input.getValue(), "hi!");
		assert.strictEqual(tui.getFocusedComponent(), overlay);
		tui.stop();
	});

	it("positions and focuses the multiline editor through alternate-screen dispatch", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const editor = new Editor(tui, editorTheme);
		editor.setText("hello");
		tui.addChild(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		terminal.sendInput("X");
		await terminal.waitForRender();

		assert.strictEqual(editor.getText(), "heXllo");
		assert.strictEqual(tui.getFocusedComponent(), editor);
		tui.stop();
	});

	it("selects and copies editor text on drag instead of moving the cursor", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		const editor = new Editor(tui, editorTheme);
		editor.setText("hello world");
		tui.addChild(editor);
		tui.start();
		await terminal.waitForRender();
		const cursorBefore = editor.getCursor();

		terminal.sendInput("\x1b[<0;1;2M");
		terminal.sendInput("\x1b[<32;5;2M");
		terminal.sendInput("\x1b[<0;5;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["hello"]);
		assert.deepStrictEqual(editor.getCursor(), cursorBefore);
		tui.stop();
	});
});

describe("stale overlay mouse targets (dsh-pi-tui divergence X018 hardening)", () => {
	class RecordingOverlay extends Container {
		readonly events: string[] = [];
		constructor() {
			super();
			this.addChild(new Text("overlay content", 0, 0));
		}
		override handleMouse(event: TuiMouseEvent): { handled: true; capture?: boolean } | undefined {
			this.events.push(event.type);
			if (event.type === "press") return { handled: true, capture: true };
			return { handled: true };
		}
	}

	it("does not dispatch to an overlay hidden since the last render", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const overlay = new RecordingOverlay();
		tui.start();
		const handle = tui.showOverlay(overlay, { anchor: "top-left", width: 20 });
		await terminal.waitForRender();

		// Hide the overlay: the cached layout still describes it until the
		// next render, but a click must not reach the hidden component.
		handle.setHidden(true);
		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<0;5;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(overlay.events, [], "a hidden overlay must not receive pointer events");
		tui.stop();
	});

	it("does not route a captured drag to an overlay removed mid-gesture", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const overlay = new RecordingOverlay();
		tui.start();
		const handle = tui.showOverlay(overlay, { anchor: "top-left", width: 20 });
		await terminal.waitForRender();

		// Press captures the gesture on the overlay.
		terminal.sendInput("\x1b[<0;5;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(overlay.events, ["press"]);

		// Hide the overlay, then drag: the removed overlay must not receive
		// the captured drag (the gesture is cleared and re-dispatched).
		handle.hide();
		terminal.sendInput("\x1b[<32;7;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(overlay.events, ["press"], "a removed overlay must not receive captured drags");
		tui.stop();
	});
});

describe("stale layout mouse targets (dsh-pi-tui divergence X018 hardening)", () => {
	class RecordingLayoutOverlay extends Container {
		readonly events: string[] = [];
		constructor() {
			super();
			this.addChild(new Text("control", 0, 0));
		}
		override handleMouse(event: TuiMouseEvent): { handled: true; capture?: boolean } | undefined {
			this.events.push(event.type);
			if (event.type === "press") return { handled: true, capture: true };
			return { handled: true };
		}
	}

	it("does not route a captured drag to a layout root replaced mid-gesture", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const old = new RecordingLayoutOverlay();
		tui.setLayoutRoot(old);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M"); // press captures on the old root
		await terminal.waitForRender();
		assert.deepStrictEqual(old.events, ["press"]);

		// Replace the layout root, then drag: the old root's component must
		// not receive the captured drag (the gesture is cleared).
		tui.setLayoutRoot(new Text("new", 0, 0));
		terminal.sendInput("\x1b[<32;5;2M");
		await terminal.waitForRender();
		assert.deepStrictEqual(old.events, ["press"], "a replaced layout root must not receive captured drags");
		tui.stop();
	});

	it("does not route a captured drag to a layout node removed from the root mid-gesture", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const root = new Container();
		const old = new RecordingLayoutOverlay();
		root.addChild(old);
		tui.setLayoutRoot(root);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M"); // press captures on the child
		await terminal.waitForRender();
		assert.deepStrictEqual(old.events, ["press"]);

		// Remove the child mid-gesture (no repaint yet), then drag: the
		// removed child must not receive the captured drag. The child is a
		// layout node (Container), so a cached-frame box check would still
		// find it until the next paint — liveness must come from the live
		// component tree.
		root.removeChild(old);
		terminal.sendInput("\x1b[<32;5;2M");
		await terminal.waitForRender();
		assert.deepStrictEqual(old.events, ["press"], "a removed layout child must not receive captured drags");
		tui.stop();
	});
});

describe("stale fresh-press dispatch (dsh-pi-tui divergence X018 hardening)", () => {
	class RecordingPress extends Container {
		readonly events: string[] = [];
		constructor() {
			super();
			this.addChild(new Text("control", 0, 0));
		}
		override handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
			this.events.push(event.type);
			return { handled: true };
		}
	}

	it("does not dispatch a FRESH press to a component removed before the next paint", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const root = new Container();
		const old = new RecordingPress();
		root.addChild(old);
		tui.setLayoutRoot(root);
		tui.start();
		await terminal.waitForRender();

		// Remove the child WITHOUT repainting: the cached frame still
		// describes it, but a brand-new press must not reach it.
		root.removeChild(old);
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(old.events, [], "a removed component must not receive a fresh press before the next paint");
		tui.stop();
	});

	it("does not dispatch a click to a Container child replaced via direct children mutation", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		// EditorSeatMount-style non-owning seat: the subclass replaces
		// `children` directly, which must invalidate the Container's cached
		// mouse layout.
		const mount = new Container();
		const old = new RecordingPress();
		const fresh = new RecordingPress();
		mount.children = [old];
		tui.setLayoutRoot(mount);
		tui.start();
		await terminal.waitForRender();

		// Replace the child WITHOUT repainting: the click must hit neither
		// the removed child (stale cache) nor the not-yet-painted child
		// (a ghost click on geometry the user cannot see).
		mount.children = [fresh];
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(old.events, [], "a replaced seat child must not receive clicks via the stale mouse cache");
		assert.deepStrictEqual(fresh.events, [], "a not-yet-painted seat child must not receive a ghost click");

		// After the next real render, clicks reach the new child.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.ok(fresh.events.length > 0, "after repaint the new child must receive clicks");
		tui.stop();
	});

	it("does not dispatch a click to a Box child removed since the last render", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const box = new Box();
		const old = new RecordingPress();
		const fresh = new RecordingPress();
		box.addChild(old);
		tui.setLayoutRoot(box);
		tui.start();
		await terminal.waitForRender();

		// Replace the child WITHOUT repainting: the click must hit neither
		// the removed child (stale cache) nor the not-yet-painted child
		// (a ghost click on geometry the user cannot see).
		box.removeChild(old);
		box.addChild(fresh);
		// The Box has 1-cell padding: click the content start (0-based (1,1)).
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.deepStrictEqual(old.events, [], "a removed Box child must not receive clicks via the stale mouse cache");
		assert.deepStrictEqual(fresh.events, [], "a not-yet-painted Box child must not receive a ghost click");

		// After the next real render, clicks reach the new child.
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.ok(fresh.events.length > 0, "after repaint the new Box child must receive clicks");
		tui.stop();
	});
});

describe("nested gesture targets stay live (dsh-pi-tui divergence X018)", () => {
	it("synthesizes the click for a SelectList nested inside an overlay-root Container", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const list = new SelectList(
			[
				{ value: "a", label: "alpha" },
				{ value: "b", label: "beta" },
			],
			5,
			selectTheme,
		);
		let selected: string | undefined;
		list.onSelect = (item) => {
			selected = item.value;
		};
		const root = new Container();
		root.addChild(list);
		tui.start();
		tui.showOverlay(root, { anchor: "top-left", width: 20 });
		await terminal.waitForRender();

		// Press + release on the second row: the gesture target is the
		// SelectList (a child of the overlay root), and the release must
		// synthesize the click so onSelect fires.
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(selected, "b", "the nested SelectList click must fire onSelect");
		tui.stop();
	});

	it("synthesizes the click for a SelectList wrapped in a MouseRegion layout root", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const list = new SelectList(
			[
				{ value: "a", label: "alpha" },
				{ value: "b", label: "beta" },
			],
			5,
			selectTheme,
		);
		let selected: string | undefined;
		list.onSelect = (item) => {
			selected = item.value;
		};
		const region = new MouseRegion(list, () => undefined);
		tui.setLayoutRoot(region);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(selected, "b", "the MouseRegion-wrapped SelectList click must fire onSelect");
		tui.stop();
	});
});

describe("MouseRegion transparent keyboard forwarding (X018)", () => {
	it("forwards keystrokes to the child after a focus-requesting mouse handler", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const input = new Input();
		const region = new MouseRegion(input, () => ({ handled: true, focus: true }));
		tui.setLayoutRoot(region);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.strictEqual(tui.getFocusedComponent(), region, "the focus request lands on the wrapper");

		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(input.getValue(), "x", "keystrokes must reach the child through the wrapper");
		tui.stop();
	});
});

describe("wrapper focus ownership (X018)", () => {
	it("keeps a MouseRegion overlay root focused when its child requests focus", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const child = {
			render: () => ["control"],
			invalidate: () => {},
			handleMouse: () => ({ handled: true, focus: true }),
		};
		const region = new MouseRegion(child, () => undefined);
		tui.start();
		tui.showOverlay(region, { anchor: "top-left", width: 20 });
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.strictEqual(tui.getFocusedComponent(), region, "the focus request must land on the mounted wrapper, not the private child");
		tui.stop();
	});
});

describe("MouseRegion Focusable forwarding (X018)", () => {
	it("propagates the focused flag to a wrapped Input so CURSOR_MARKER renders", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const input = new Input();
		const region = new MouseRegion(input, () => undefined);
		tui.setLayoutRoot(region);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.strictEqual(tui.getFocusedComponent(), region, "the wrapper owns the TUI focus");
		assert.strictEqual(input.focused, true, "the focused flag must reach the wrapped Input");
		assert.ok(
			region.render(20).some((line) => line.includes(CURSOR_MARKER)),
			"the wrapped Input must emit CURSOR_MARKER while focused",
		);

		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(input.getValue(), "x", "keystrokes must still reach the Input");
		tui.stop();
	});
});

describe("selection fallback click across a repaint (X018)", () => {
	class RecordingChild extends Container {
		readonly events: string[] = [];
		constructor() {
			super();
			this.addChild(new Text("control", 0, 0));
		}
		// Click-only: presses and releases fall through to the selection
		// path, and the release's synthesized click is what activates it —
		// the v0.85.1 click-only component pattern.
		override handleMouse(event: TuiMouseEvent): { handled: true } | undefined {
			if (event.type !== "click") return undefined;
			this.events.push(event.type);
			return { handled: true };
		}
	}

	it("does not synthesize a click on a child that appeared after the press was rejected", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const mount = new Container();
		const old = new RecordingChild();
		const fresh = new RecordingChild();
		mount.children = [old];
		tui.setLayoutRoot(mount);
		tui.start();
		await terminal.waitForRender();

		// Replace the child; the press is rejected by the stale cache and
		// falls into the text-selection path, which schedules a repaint.
		mount.children = [fresh];
		terminal.sendInput("\x1b[<0;1;1M");
		// The repaint completes BEFORE the release: the screen now shows the
		// new child, but the release's synthesized click must not transfer
		// to it (the press belonged to the previous paint).
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(old.events, [], "the removed child must not receive the click");
		assert.deepStrictEqual(fresh.events, [], "a child painted after the press must not receive the synthesized click");
		tui.stop();
	});
});

describe("mouse dispatch recorder lifecycle (X018)", () => {
	it("clears the module recorder after each event (no dead-instance retention)", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.start();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();

		// After the event, the module-global recorder must be cleared: a
		// direct dispatch must not record into this (possibly stopped)
		// instance — otherwise the global closure retains it forever.
		const t = tui as unknown as { lastMouseDispatchComponents: Set<unknown> };
		t.lastMouseDispatchComponents.clear();
		const child = {
			render: () => ["x"],
			invalidate: () => {},
			handleMouse: () => ({ handled: true }),
		};
		dispatchMouseEvent(child, {
			type: "press",
			button: "left",
			x: 0,
			y: 0,
			screenX: 0,
			screenY: 0,
			width: 1,
			height: 1,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.strictEqual(t.lastMouseDispatchComponents.size, 0, "the recorder must be cleared after the event");
		tui.stop();
	});
});

describe("nested mouse dispatch isolation (X018)", () => {
	it("does not filter a nested press triggered during a synthetic click by the outer allow-set", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const tuiInternal = tui as unknown as { handleTerminalInput(data: string): void };
		const nestedEvents: string[] = [];
		const nested = {
			render: () => ["nested"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				nestedEvents.push(event.type);
				return { handled: true };
			},
		};
		const clickOnly = {
			render: () => ["click-only"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				if (event.type !== "click") return undefined;
				// Synchronously trigger a nested press on the OTHER child
				// while the outer synthetic-click allow-set is active.
				tuiInternal.handleTerminalInput("\x1b[<0;1;2M");
				return { handled: true };
			},
		};
		const root = new Container();
		root.addChild(clickOnly);
		root.addChild(nested);
		tui.setLayoutRoot(root);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.ok(nestedEvents.includes("press"), "the nested press must be dispatched unfiltered by the outer allow-set");
		tui.stop();
	});
});

describe("nested selection-fallback snapshot isolation (X018)", () => {
	it("keeps the outer gesture's press snapshot when a nested click-only press falls to selection", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const tuiInternal = tui as unknown as { handleTerminalInput(data: string): void };
		const aEvents: string[] = [];
		const clickOnlyA = {
			render: () => ["a"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				if (event.type !== "click") return undefined;
				aEvents.push(event.type);
				// Synchronously trigger a nested press on a click-only child:
				// it falls to the selection path and must NOT overwrite the
				// outer gesture's press snapshot.
				tuiInternal.handleTerminalInput("\x1b[<0;1;2M");
				return { handled: true };
			},
		};
		const clickOnlyB = {
			render: () => ["b"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				if (event.type !== "click") return undefined;
				return { handled: true };
			},
		};
		const root = new Container();
		root.addChild(clickOnlyA);
		root.addChild(clickOnlyB);
		tui.setLayoutRoot(root);
		tui.start();
		await terminal.waitForRender();

		// First gesture: the synthetic click on A triggers a nested selection
		// press on B.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(aEvents, ["click"], "the first click must reach A");
		// The outer press snapshot must persist (the nested selection press
		// must neither wipe nor overwrite it).
		const t = tui as unknown as { selectionPressDispatchComponents: Set<unknown> | undefined };
		assert.ok(t.selectionPressDispatchComponents !== undefined, "the outer press snapshot must persist after the nested event");

		// Second gesture on A: its press snapshot must be the OUTER one
		// ({root, A}), not the nested one ({root, B}) — otherwise the
		// synthetic click is filtered and A never receives it.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(aEvents, ["click", "click"], "the second click must still reach A (outer snapshot preserved)");
		tui.stop();
	});
});

describe("nested raw gesture pairing (X018)", () => {
	it("drops a nested press+release pair's synthesized click instead of misrouting it", async () => {
		// A child handler synchronously triggering a FULL nested press+release
		// mouse gesture is not a supported pattern: the nested release runs
		// after the nested press restored the outer snapshot, so its
		// synthesized click is filtered by the OUTER hit relationship and
		// dropped — never misrouted to a component outside it.
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const tuiInternal = tui as unknown as { handleTerminalInput(data: string): void };
		const aEvents: string[] = [];
		const bEvents: string[] = [];
		const clickOnlyA = {
			render: () => ["a"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				if (event.type !== "click") return undefined;
				aEvents.push(event.type);
				// Synchronously trigger a nested press+release pair on B.
				tuiInternal.handleTerminalInput("\x1b[<0;1;2M");
				tuiInternal.handleTerminalInput("\x1b[<0;1;2m");
				return { handled: true };
			},
		};
		const clickOnlyB = {
			render: () => ["b"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				if (event.type !== "click") return undefined;
				bEvents.push(event.type);
				return { handled: true };
			},
		};
		const root = new Container();
		root.addChild(clickOnlyA);
		root.addChild(clickOnlyB);
		tui.setLayoutRoot(root);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(aEvents, ["click"], "the outer click must be delivered (the gesture actually ran)");
		assert.deepStrictEqual(bEvents, [], "the nested pair's click must be dropped, never misrouted");
		tui.stop();
	});
});

describe("wheel event isolation (X018)", () => {
	it("does not accumulate components into the reached set from a top-level wheel", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const child = {
			render: () => ["x"],
			invalidate: () => {},
			handleMouse: () => ({ handled: true }),
		};
		tui.setLayoutRoot(child);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;1;1M"); // wheel up
		await terminal.waitForRender();
		const t = tui as unknown as { lastMouseDispatchComponents: Set<unknown> };
		assert.strictEqual(t.lastMouseDispatchComponents.size, 0, "a top-level wheel must not leave residual components in the reached set");
		tui.stop();
	});

	it("does not filter a nested wheel triggered during a synthetic click by the outer allow-set", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const tuiInternal = tui as unknown as { handleTerminalInput(data: string): void };
		const wheelEvents: string[] = [];
		const clickOnly = {
			render: () => ["a"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				if (event.type !== "click") return undefined;
				// Synchronously trigger a nested wheel on the OTHER child
				// while the outer synthetic-click allow-set is active.
				tuiInternal.handleTerminalInput("\x1b[<64;1;2M");
				return { handled: true };
			},
		};
		const wheelChild = {
			render: () => ["b"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				if (event.type !== "wheel") return undefined;
				wheelEvents.push(event.type);
				return { handled: true };
			},
		};
		const root = new Container();
		root.addChild(clickOnly);
		root.addChild(wheelChild);
		tui.setLayoutRoot(root);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();
		assert.ok(wheelEvents.includes("wheel"), "the nested wheel must be dispatched unfiltered by the outer allow-set");
		tui.stop();
	});
});
