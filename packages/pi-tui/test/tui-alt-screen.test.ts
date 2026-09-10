import assert from "node:assert";
import { describe, it } from "node:test";
import {
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	findAltScreenSearchMatches,
} from "../src/alt-screen-search.ts";
import { Box } from "../src/components/box.ts";
import { Container } from "../src/tui.ts";
import { Input } from "../src/components/input.ts";
import { HStack } from "../src/components/h-stack.ts";
import { Image } from "../src/components/image.ts";
import { MouseRegion } from "../src/components/mouse-region.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { SelectList } from "../src/components/select-list.ts";
import { SettingsList } from "../src/components/settings-list.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import {
	encodeKitty,
	hyperlink,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import type { TuiMouseEvent } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";

class InputOverlay {
	focused = false;
	inputs: string[] = [];

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return ["overlay"];
	}

	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	readonly events: Array<{ type: "write"; data: string } | { type: "start" } | { type: "stop" }> = [];

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.events.push({ type: "start" });
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.events.push({ type: "write", data });
		super.write(data);
	}

	override stop(): void {
		this.events.push({ type: "stop" });
		super.stop();
	}
}

describe("TuiAltScreen", () => {
	it("renders a terminal-height viewport and preserves manual scroll position", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const text = new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "line 9", "line 10"],
		);
		assert.strictEqual(tui.isFollowingOutput, true);

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);
		assert.strictEqual(tui.viewportTop, 5);
		assert.strictEqual(tui.isFollowingOutput, false);

		text.setText(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 6", "line 7", "line 8", "line 9"],
		);

		tui.stop();
	});

	it("shows a clickable jump-to-end indicator on the transcript's last row while scrolled up", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => "\x1b[7m ↓ Jump to end \x1b[27m",
		});
		const transcript = new ScrollView(
			new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: new Text("editor\nfooter", 0, 0), basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);
		assert.strictEqual(terminal.getViewport()[3], "line 7  ↓ Jump to end         ");
		assert.strictEqual(terminal.getViewport()[4]?.trimEnd(), "editor");

		// Pressing next to the label starts a selection instead of jumping.
		terminal.sendInput("\x1b[<0;2;4M");
		terminal.sendInput("\x1b[<0;2;4m");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);

		terminal.sendInput("\x1b[<0;15;4M");
		terminal.sendInput("\x1b[<0;15;4m");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, true);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "editor", "footer"],
		);
		tui.stop();
	});

	it("leaves the scrollbar clickable when the jump-to-end indicator spans the transcript", async () => {
		const terminal = new VirtualTerminal(30, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => "↓".repeat(30),
		});
		const transcript = new ScrollView(
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true, scrollbar: "always" },
		);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: new Text("editor\nfooter", 0, 0), basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);

		// The indicator must not intercept a press on the scrollbar's last column.
		terminal.sendInput("\x1b[<0;30;4M");
		terminal.sendInput("\x1b[<0;30;4m");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);
		tui.stop();
	});

	it("never shows the jump-to-end indicator for a primary scroll view without follow-end", async () => {
		const terminal = new VirtualTerminal(30, 3);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			scrollToEndIndicator: () => " ↓ Jump to end ",
		});
		const transcript = new ScrollView(new Text("one\ntwo\nthree\nfour\nfive", 0, 0), { primary: true });
		tui.setLayoutRoot(transcript);
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(transcript.isFollowingEnd, false);
		assert.ok(!terminal.getViewport().some((line) => line.includes("Jump to end")));
		tui.stop();
	});

	it("keeps an explicit dock fixed while the transcript scrolls", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const dock = new VStack([new Text("editor", 0, 0), new Text("footer", 0, 0)]);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "editor", "footer"],
		);

		// Wheel over the dock falls back to the primary transcript scroll view.
		terminal.sendInput("\x1b[<64;1;6M");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 4", "line 5", "line 6", "line 7", "editor", "footer"],
		);
		assert.strictEqual(transcript.isFollowingEnd, false);

		transcriptText.setText(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 4", "line 5", "line 6", "line 7", "editor", "footer"],
		);

		tui.scrollToBottom();
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 7", "line 8", "line 9", "line 10", "editor", "footer"],
		);
		tui.stop();
	});

	it("invalidates overlays with an explicit layout root", () => {
		const tui = new TuiAltScreen(new VirtualTerminal());
		const overlay = new Text("overlay", 0, 0);
		let invalidated = false;
		overlay.invalidate = () => {
			invalidated = true;
		};
		tui.setLayoutRoot(new Text("root", 0, 0));
		tui.showOverlay(overlay);

		tui.invalidate();

		assert.strictEqual(invalidated, true);
		tui.stop();
	});

	it("routes wheel input to the scroll view under the pointer", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const left = new ScrollView(new Text("a1\na2\na3\na4\na5\na6\na7", 0, 0), {
			follow: "end",
			primary: true,
		});
		const right = new ScrollView(new Text("b1\nb2\nb3\nb4\nb5\nb6\nb7", 0, 0), { follow: "end" });
		tui.setLayoutRoot(
			new HStack([
				{ component: left, basis: 10, shrink: 0 },
				{ component: right, basis: 10, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;15;1M");
		await terminal.waitForRender();
		assert.strictEqual(left.scrollTop, 3);
		assert.strictEqual(right.scrollTop, 2);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["a4        b3", "a5        b4", "a6        b5", "a7        b6"],
		);
		tui.stop();
	});

	it("scrolls faster while Alt is held during wheel input", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const text = new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 8);

		// Alt modifier sets bit 8 on the wheel button (72 = 64 + 8).
		terminal.sendInput("\x1b[<72;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 3);
		tui.stop();
	});

	it("does not vertically redispatch misses through horizontal layout containers", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		let selections = 0;
		const list = new SelectList(
			[
				{ value: "a", label: "A" },
				{ value: "b", label: "B" },
			],
			2,
			{
				selectedPrefix: (text) => text,
				selectedText: (text) => text,
				description: (text) => text,
				scrollInfo: (text) => text,
				noMatch: (text) => text,
			},
		);
		list.onSelect = () => {
			selections += 1;
		};
		tui.setLayoutRoot(
			new HStack([
				{ component: list, basis: 10 },
				{ component: new Text("plain", 0, 0), basis: 10 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;15;1M");
		terminal.sendInput("\x1b[<0;15;1m");
		await terminal.waitForRender();
		assert.strictEqual(selections, 0);
		tui.stop();
	});

	it("uses button-motion tracking inside terminal multiplexers", () => {
		const environmentKeys = ["TMUX", "ZELLIJ", "STY", "TERM"] as const;
		const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
		try {
			for (const key of environmentKeys) delete process.env[key];
			process.env.TERM = "xterm-256color";
			const directTerminal = new RecordingTerminal();
			const directTui = new TuiAltScreen(directTerminal);
			directTui.start();
			const directWrites = directTerminal.events
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(directWrites.includes("\x1b[?1003h"));
			directTui.stop();

			const multiplexers = [
				{ name: "tmux environment", environment: { TMUX: "/tmp/tmux/default,1,0" } },
				{ name: "tmux TERM", environment: { TERM: "tmux-256color" } },
				{ name: "Zellij environment", environment: { ZELLIJ: "0" } },
				{ name: "Screen environment", environment: { STY: "123.session" } },
				{ name: "Screen TERM", environment: { TERM: "screen-256color" } },
			];
			for (const { name, environment } of multiplexers) {
				for (const key of environmentKeys) delete process.env[key];
				for (const [key, value] of Object.entries(environment)) process.env[key] = value;
				const terminal = new RecordingTerminal();
				const tui = new TuiAltScreen(terminal);
				tui.start();
				const writes = terminal.events
					.filter((event): event is { type: "write"; data: string } => event.type === "write")
					.map((event) => event.data)
					.join("");
				assert.ok(writes.includes("\x1b[?1002h"), `${name} should enable button-motion tracking`);
				assert.ok(!writes.includes("\x1b[?1003h"), `${name} should not enable all-motion tracking`);
				assert.ok(writes.includes("\x1b[?1006h"), `${name} should enable SGR mouse encoding`);
				tui.stop();
			}
		} finally {
			for (const key of environmentKeys) {
				const value = previousEnvironment.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("invokes the right-click paste handler only on Windows outside VS Code", () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const termProgram = process.env.TERM_PROGRAM;
		assert.ok(platformDescriptor);
		const terminal = new VirtualTerminal();
		let pasteCount = 0;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onRightClickPaste: () => {
				pasteCount += 1;
			},
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			delete process.env.TERM_PROGRAM;
			tui.start();
			terminal.sendInput("\x1b[<2;1;1M");
			terminal.sendInput("\x1b[<2;1;1m");
			assert.strictEqual(pasteCount, 1);

			process.env.TERM_PROGRAM = "vscode";
			terminal.sendInput("\x1b[<2;1;1M");
			assert.strictEqual(pasteCount, 1);

			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			delete process.env.TERM_PROGRAM;
			terminal.sendInput("\x1b[<2;1;1M");
			assert.strictEqual(pasteCount, 1);
		} finally {
			tui.stop();
			Object.defineProperty(process, "platform", platformDescriptor);
			if (termProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = termProgram;
		}
	});

	it("reveals an auto scrollbar when the pointer enters its hidden track", async () => {
		const terminal = new RecordingTerminal(10, 5);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "auto", scrollbarHideDelayMs: 20 },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, false);

		terminal.sendInput("\x1b[<35;10;3M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, true);
		assert.strictEqual(scrollView.isScrollbarActive, true);
		assert.ok(terminal.getViewport().some((line) => /[│█]/.test(line)));

		terminal.sendInput("\x1b[<35;9;3M");
		await new Promise((resolve) => setTimeout(resolve, 40));
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, false);
		tui.stop();
	});

	it("jumps to a scrollbar track position and continues dragging from there", async () => {
		const terminal = new RecordingTerminal(10, 10);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "always" },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 0);

		terminal.sendInput("\x1b[<0;10;6M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 20);

		terminal.sendInput("\x1b[<32;10;10M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 40);

		terminal.sendInput("\x1b[<0;10;10m");
		await terminal.waitForRender();
		assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")));
		tui.stop();
	});

	it("chains unused wheel delta to an outer scroll view", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
		const inner = new ScrollView(new Text("i1\ni2\ni3\ni4\ni5\ni6", 0, 0));
		const outer = new ScrollView(
			new VStack([{ component: inner, basis: 2 }, new Text("tail1\ntail2\ntail3\ntail4\ntail5", 0, 0)]),
			{ primary: true },
		);
		tui.setLayoutRoot(outer);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 3);
		assert.strictEqual(outer.scrollTop, 0);

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 4);
		assert.strictEqual(outer.scrollTop, 2);
		tui.stop();
	});

	it("supports configurable keyboard viewport navigation with four rows of page overlap", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[57421u");
		terminal.sendInput("\x1b[57421;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		terminal.sendInput("\x1b[57422u");
		terminal.sendInput("\x1b[57422;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		terminal.sendInput("\x1bOH");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		terminal.sendInput("\x1bOF");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		tui.stop();
	});

	it("searches normalized rendered transcript text across rows", () => {
		assert.deepStrictEqual(findAltScreenSearchMatches(["alpha QUICK", "brown fox"], "quick brown"), [
			{
				segments: [
					{ row: 0, startCol: 6, endCol: 11 },
					{ row: 1, startCol: 0, endCol: 5 },
				],
			},
		]);
	});

	it("maps normalized ASCII and Unicode search matches back to rendered columns", () => {
		assert.deepStrictEqual(findAltScreenSearchMatches(["\x1b[31mfoo  bar\x1b[0m", "A界🙂éZ"], "oo   bar\nA界🙂é"), [
			{
				segments: [
					{ row: 0, startCol: 1, endCol: 3 },
					{ row: 0, startCol: 5, endCol: 8 },
					{ row: 1, startCol: 0, endCol: 6 },
				],
			},
		]);
	});

	it("reuses indexed transcript matches until the query or rendered lines change", () => {
		const index = new AltScreenSearchIndex();
		const initial = index.search(["alpha needle", "omega"], "needle");
		assert.strictEqual(initial.changed, true);
		assert.strictEqual(initial.matches.length, 1);

		const cached = index.search(["alpha needle", "omega"], "needle");
		assert.strictEqual(cached.changed, false);
		assert.strictEqual(cached.matches, initial.matches);

		const changedQuery = index.search(["alpha needle", "omega"], "omega");
		assert.strictEqual(changedQuery.changed, true);
		assert.notStrictEqual(changedQuery.matches, initial.matches);
		assert.deepStrictEqual(changedQuery.matches[0]?.segments, [{ row: 1, startCol: 0, endCol: 5 }]);

		const changedLines = index.search(["alpha needle", "no match"], "omega");
		assert.strictEqual(changedLines.changed, true);
		assert.deepStrictEqual(changedLines.matches, []);
	});

	it("renders transcript search with a muted placeholder and right-aligned controls", () => {
		const component = new AltScreenSearchComponent(() => {});
		const rendered = component.render(48);
		const lines = rendered.map((line) => stripTerminalSequences(line));

		assert.strictEqual(lines.length, 3);
		assert.ok(lines.every((line) => visibleWidth(line) === 48));
		assert.match(lines[0] ?? "", /^┌─+┐$/);
		assert.match(lines[1] ?? "", /^│ Find in transcript +│$/);
		assert.ok(rendered[1]?.includes("\x1b[2m"));
		assert.match(lines[2] ?? "", /^└─+ ↑ Shift\+Enter · ↓ Enter ─┘$/);
		const controls = lines[2] ?? "";
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("↑")), -1);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("Shift+Enter") + 5), -1);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("·")), undefined);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.indexOf("↓")), 1);
		assert.strictEqual(component.getNavigationDirectionAt(2, controls.lastIndexOf("Enter") + 2), 1);

		component.handleInput("n");
		component.setResult(0, 2);
		const populatedRender = component.render(48);
		const populated = populatedRender.map((line) => stripTerminalSequences(line));
		assert.ok(populated[1]?.includes("n"));
		assert.ok(populated[1]?.includes("1/2"));
		assert.ok(populatedRender[1]?.includes("\x1b[2m 1/2 \x1b[22m"));
		assert.ok(!populated.some((line) => line.includes("Find in transcript")));
	});

	it("positions the search query cursor on mouse press (X049)", () => {
		let query = "";
		const component = new AltScreenSearchComponent((next) => {
			query = next;
		});
		component.render(48);
		component.handleInput("hello");
		component.render(48);
		// Content starts at col 1 (left border); the Input prompt " " is one
		// column, so value column 2 (between e and l) is at component col 4.
		const result = component.handleMouse({
			type: "press",
			button: "left",
			x: 4,
			y: 1,
			screenX: 4,
			screenY: 1,
			width: 48,
			height: 3,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.ok(result?.handled, "press on the query row must be handled");
		assert.strictEqual(result?.focus, true, "press must request focus");
		component.handleInput("X");
		assert.strictEqual(query, "heXllo", "typing after the click must insert at the clicked column");
	});

	it("keeps the search result-count suffix and borders inert (X049)", () => {
		const component = new AltScreenSearchComponent(() => {});
		component.render(48);
		component.handleInput("needle");
		component.setResult(0, 2);
		component.render(48);
		const press = (x: number, y: number) =>
			component.handleMouse({
				type: "press",
				button: "left",
				x,
				y,
				screenX: x,
				screenY: y,
				width: 48,
				height: 3,
				shift: false,
				alt: false,
				ctrl: false,
			});
		// The result-count suffix (" 1/2 ") sits after the Input (which ends
		// at component col 41 for this render); a press on the suffix must
		// not reach the Input.
		assert.strictEqual(press(45, 1), undefined, "result-count suffix must be inert");
		// Top and bottom borders (rows 0 and 2) are inert.
		assert.strictEqual(press(4, 0), undefined, "top border must be inert");
		assert.strictEqual(press(4, 2), undefined, "navigation-button row must be inert here");
	});

	it("navigates transcript search with hoverable arrow buttons and toggles it with its shortcut", async () => {
		const terminal = new RecordingTerminal(120, 6);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			searchNavigationButtonStyle: (text, hovered) => `${hovered ? "\x1b[45m" : "\x1b[44m"}${text}\x1b[49m`,
		});
		tui.addChild(new Text("needle one\nmiddle\nneedle two\nend", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("1/2")));
		assert.ok(viewport.some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		let arrowRow = viewport.findIndex((line) => line.includes("↑") && line.includes("↓"));
		let arrowColumn = viewport[arrowRow]?.lastIndexOf("Enter") ?? -1;
		assert.ok(arrowRow >= 0 && arrowColumn >= 0);
		const hoverEventCount = terminal.events.length;
		terminal.sendInput(`\x1b[<35;${arrowColumn + 1};${arrowRow + 1}M`);
		await terminal.waitForRender();
		assert.ok(
			terminal.events
				.slice(hoverEventCount)
				.some((event) => event.type === "write" && event.data.includes("\x1b[45m↓ Enter\x1b[49m")),
		);
		terminal.sendInput(`\x1b[<0;${arrowColumn + 1};${arrowRow + 1}M`);
		await terminal.waitForRender();
		viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("2/2")));
		assert.ok(viewport.some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		arrowRow = viewport.findIndex((line) => line.includes("↑") && line.includes("↓"));
		arrowColumn = (viewport[arrowRow]?.indexOf("Shift+Enter") ?? -3) + 3;
		assert.ok(arrowRow >= 0 && arrowColumn >= 0);
		terminal.sendInput(`\x1b[<0;${arrowColumn + 1};${arrowRow + 1}M`);
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));

		terminal.sendInput("\x1b[102;6u");
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		tui.stop();
	});

	it("positions the fullscreen search query cursor on mouse click (X049)", async () => {
		const terminal = new RecordingTerminal(120, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("needle one\nmiddle\nneedle two\nend", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		const contentRow = viewport.findIndex((line) => line.includes("1/2"));
		assert.ok(contentRow >= 0, "search overlay content row must be visible");
		// The transcript may also contain "needle"; the overlay's query is
		// the LAST occurrence on the content row.
		const needleCol = viewport[contentRow]?.lastIndexOf("needle") ?? -1;
		assert.ok(needleCol >= 0);
		// Click on the "e" cell (between n and e): the overlay content starts
		// at col 1 (border) plus the Input prompt " " (col 2 = n), so the e
		// cell is needleCol + 2. SGR coordinates are 1-based.
		terminal.sendInput(`\x1b[<0;${needleCol + 2};${contentRow + 1}M`);
		await terminal.waitForRender();
		terminal.sendInput("X");
		await terminal.waitForRender();
		viewport = terminal.getViewport();
		assert.ok(
			viewport.some((line) => line.includes("nXeedle")),
			"typing after the click must insert at the clicked query column",
		);
		tui.stop();
	});

	it("does not treat transcript box drawing as search navigation buttons", async () => {
		const terminal = new VirtualTerminal(80, 10);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(
			new Text(
				[
					"needle one",
					"middle",
					"needle two",
					"filler",
					"┌────────────────────────────────────────┐",
					"│ box                                    │",
					"└────────────────────────────────────────┘",
					"end",
				].join("\n"),
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("1/2")));
		assert.ok(!viewport.some((line) => line.includes("2/2")));

		const boxBottomRow = viewport.findIndex((line) => line.startsWith("└"));
		assert.ok(boxBottomRow >= 0);
		terminal.sendInput(`\x1b[<0;24;${boxBottomRow + 1}M`);
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		assert.ok(viewport.some((line) => line.includes("1/2")));
		assert.ok(!viewport.some((line) => line.includes("2/2")));
		tui.stop();
	});

	it("uses configured styles for current and non-current search matches", async () => {
		const terminal = new RecordingTerminal(60, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			searchMatchStyle: (text) => `\x1b[41m${text}\x1b[49m`,
			searchCurrentMatchStyle: (text) => `\x1b[42m${text}\x1b[49m`,
		});
		tui.addChild(new Text("needle first\nmiddle\nneedle second\nend", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();

		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[42mneedle\x1b[49m")),
		);
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[41mneedle\x1b[49m")),
		);
		tui.stop();
	});

	it("searches the transcript with Ctrl+Shift+F and restores editor focus on close", async () => {
		const terminal = new RecordingTerminal(60, 8);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(
			Array.from({ length: 12 }, (_, index) => {
				if (index === 4) return "line 5 needle one";
				if (index === 9) return "line 10 needle two";
				return `line ${index + 1}`;
			}).join("\n"),
			0,
			0,
		);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		assert.strictEqual(transcript.isFollowingEnd, false);
		assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		assert.ok(terminal.getViewport().some((line) => line.includes("line 10 needle two")));
		assert.deepStrictEqual(editorInputs, []);
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[1;7mneedle\x1b[22;27m")),
		);

		for (let index = 0; index < 6; index++) terminal.sendInput("\x1b[<64;1;4M");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.ok(terminal.getViewport().some((line) => line.includes("needle") && line.includes("2/2")));

		terminal.sendInput("\x07");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("1/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("line 5 needle one")));

		terminal.sendInput("\x1b[103;6u");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("2/2")));
		assert.ok(terminal.getViewport().some((line) => line.includes("line 10 needle two")));

		terminal.sendInput("\x1b");
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.ok(!terminal.getViewport().some((line) => line.includes("↑ Shift+Enter · ↓ Enter")));
		assert.deepStrictEqual(editorInputs, ["x"]);

		tui.stop();
	});

	it("scrolls the transcript by half a page with custom bindings", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.halfPageUp": "ctrl+u",
				"tui.altScreen.halfPageDown": "ctrl+d",
			}),
		);
		try {
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);

			terminal.sendInput("\x15");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 15);

			terminal.sendInput("\x04");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});

	it("scrolls the transcript by one line with custom bindings", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.lineUp": "ctrl+y",
				"tui.altScreen.lineDown": "ctrl+e",
			}),
		);
		try {
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);

			terminal.sendInput("\x19");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 19);

			terminal.sendInput("\x05");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});

	it("routes Ctrl-modified viewport navigation to the focused component", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1bOH");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.deepStrictEqual(editorInputs, []);

		const modifiedInputs = ["\x1b[1;5H", "\x1b[1;5F", "\x1b[5;5~", "\x1b[6;5~", "\x1b[57423;5u"];
		for (const input of modifiedInputs) terminal.sendInput(input);
		terminal.sendInput("\x1b[57423;5:3u");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.deepStrictEqual(editorInputs, modifiedInputs);

		terminal.sendInput("\x1b[6~");
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 1);
		assert.deepStrictEqual(editorInputs, modifiedInputs);

		tui.stop();
	});

	it("jumps between OSC 133 semantic prompt markers", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(
			new Text(
				[1, 2, 3, 4].flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"]).join("\n"),
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 5);

		terminal.sendInput("\x1b[57419;6u");
		terminal.sendInput("\x1b[57419;6:3u");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		terminal.sendInput("\x1b[1;6A");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 2);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 2");

		terminal.sendInput("\x1b[57420;6u");
		terminal.sendInput("\x1b[57420;6:3u");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.strictEqual(terminal.getViewport()[0]?.trimEnd(), "message 3");

		terminal.sendInput("\x1b[1;6B");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 5);
		assert.strictEqual(terminal.getViewport()[1]?.trimEnd(), "message 4");
		assert.strictEqual(tui.isFollowingOutput, true);

		tui.stop();
	});

	it("does not emit Kitty graphics commands or OSC 133 zones in iTerm2", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			tui.addChild({
				render: () => ["\x1b]133;B\x07\x1b]133;C\x07\x1b]133;A\x07content"],
				invalidate: () => {},
			});
			tui.addChild(
				new Image(
					"AAAA",
					"image/png",
					{ fallbackColor: (value) => value },
					{ filename: "example.png" },
					{ widthPx: 10, heightPx: 10 },
				),
			);
			tui.start();
			await terminal.waitForRender();
			tui.stop();
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b_G")));
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]133;")));
			assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]1337;File=")));
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("[Image:")));
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("clears stale iTerm2 image placements when they leave the viewport", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			const imageLine = "\x1b]1337;File=inline=1;width=2;height=auto:AAAA\x07";
			tui.addChild({
				render: () => [imageLine, "", "", "after", "more", "end"],
				invalidate: () => {},
			});
			tui.start();
			await terminal.waitForRender();
			tui.scrollToTop();
			await terminal.waitForRender();
			const eventCount = terminal.events.length;

			tui.scrollBy(1);
			await terminal.waitForRender();
			assert.ok(
				terminal.events.slice(eventCount).some((event) => event.type === "write" && event.data.includes("\x1b[2J")),
			);
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("crops a Kitty image whose first line is above the viewport", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		const imageId = 123;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		tui.addChild({
			render: () => ["before", imageLine, "", "", "after", "end"],
			invalidate: () => {},
		});
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(tui.viewportTop, 3);
		assert.ok(
			terminal.events.some(
				(event) => event.type === "write" && event.data.includes("i=123") && event.data.includes("y=66,h=34,r=1"),
			),
		);

		tui.stop();
	});

	it("reuses moved Kitty images without dropping HStack siblings", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			const label = new Text("left", 0, 0);
			const image = new Image(
				"A".repeat(8192),
				"image/png",
				{ fallbackColor: (value) => value },
				{},
				{ widthPx: 100, heightPx: 100 },
			);
			const header = new Text("header", 0, 0);
			const row = new HStack([
				{ component: label, basis: 10 },
				{ component: image, basis: 10 },
			]);
			tui.setLayoutRoot(
				new VStack([
					{ component: header, basis: "auto" },
					{ component: row, basis: 4 },
				]),
			);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			const eventCount = terminal.events.length;
			label.setText("changed");
			header.setText("header\nsecond");
			tui.requestRender();
			await terminal.waitForRender();
			const redrawWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			const placementIndex = redrawWrites.indexOf("\x1b_Ga=p,q=2");
			assert.ok(redrawWrites.includes("\x1b_Ga=d,d=a,q=2\x1b\\"));
			assert.ok(placementIndex > redrawWrites.indexOf("changed"));
			assert.ok(!redrawWrites.includes("\x1b_Ga=T"));
			assert.ok(redrawWrites.length < 2000, `expected placement-only redraw, got ${redrawWrites.length} bytes`);
			assert.ok(terminal.getViewport().some((line) => line.trimEnd() === "changed"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("retains recently offscreen Kitty images for placement-only reuse", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const imageId = 321;
			const imageLine = encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => [imageLine, "after"],
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")));

			const eventCount = terminal.events.length;
			tui.scrollBy(1);
			await terminal.waitForRender();
			tui.scrollBy(-1);
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(reentryWrites.includes("\x1b_Ga=p,q=2"));
			assert.ok(!reentryWrites.includes("\x1b_Ga=T"));
			assert.ok(!reentryWrites.includes(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts the least recently visible Kitty image when the cache is full", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 500;
			const imageLines = Array.from({ length: 18 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => imageLines,
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			assert.ok(
				terminal.events.some(
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			);

			const eventCount = terminal.events.length;
			tui.scrollToTop();
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			assert.ok(reentryWrites.includes("\x1b_Ga=T"));
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts offscreen Kitty images when decoded raster memory exceeds the cache quota", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 600;
			const imageLines = Array.from({ length: 4 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 3840, heightPx: 2160 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => imageLines,
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			assert.ok(
				terminal.events.some(
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			);
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("opens an OSC 8 hyperlink with specific or generic release codes, but not on drag", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const openedUrls: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			openUrl: (url) => openedUrls.push(url),
		});
		const url = "https://example.com/path?q=1";
		const belUrl = "https://example.com/bel";
		const emojiUrl = "https://example.com/emoji";
		tui.addChild(
			new Text(
				`${hyperlink("link", url)}\n\x1b]8;;${belUrl}\x07link\x1b]8;;\x07\n${hyperlink("🙂", emojiUrl)}`,
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<3;2;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url]);

		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl]);

		terminal.sendInput("\x1b[<0;2;3M");
		terminal.sendInput("\x1b[<0;2;3m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		assert.deepStrictEqual(openedUrls, [url, belUrl, emojiUrl]);

		tui.stop();
	});

	it("selects visible text with the mouse and copies it with OSC 52 after a generic release", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("\x1b[1mal\x1b[0mpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<3;4;2m");
		await terminal.waitForRender();

		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from("alpha\nbeta").toString("base64")}\x07`;
		const clipboardWrites = terminal.events.filter(
			(event) => event.type === "write" && event.data.includes("\x1b]52;c;"),
		);
		assert.ok(
			clipboardWrites.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
			JSON.stringify(clipboardWrites),
		);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m")));
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes("al\x1b[0m\x1b[7mpha")),
			"selection inverse must be reapplied after a reset inside the selection",
		);
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		tui.stop();
	});

	it("uses an injected copySelection handler instead of OSC 52 and reports success", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		assert.ok(
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
			"must not emit OSC 52 when a copySelection handler is provided",
		);
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		tui.stop();
	});

	it("leaves selections visible without copying when copyOnSelect is disabled", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copyOnSelect: false,
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, []);
		assert.strictEqual(tui.hasActiveSelection(), true);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m")));
		assert.ok(terminal.getViewport().every((line) => !line.includes("Copied!")));

		tui.stop();
	});

	it("copies an active selection programmatically", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		assert.strictEqual(tui.hasActiveSelection(), false);
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), false);

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		assert.strictEqual(tui.hasActiveSelection(), true);

		copied.length = 0;
		assert.strictEqual(await tui.copyActiveSelectionToClipboard(), true);
		await terminal.waitForRender();

		assert.deepStrictEqual(copied, ["alpha\nbeta"]);
		assert.ok(terminal.getViewport().some((line) => line.includes("Copied!")));

		tui.stop();
	});

	it("flashes an error when the injected copySelection handler fails", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async () => false,
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		assert.ok(terminal.getViewport().some((line) => line.includes("Copy failed")));
		assert.ok(
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
			"must not emit OSC 52 when a copySelection handler is provided",
		);

		tui.stop();
	});

	it("does not append whitespace to double-click word highlighting", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;3;1M");
		await terminal.waitForRender();

		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo\x1b[27m")));
		tui.stop();
	});

	it("coalesces slash and hyphen separated segments for double-click word selection", async () => {
		for (const { line, needle } of [
			{ line: "extensions/starline/fixed-editor/compositor.ts", needle: "starline" },
			{ line: "earendil-works/pi-tui", needle: "works" },
		]) {
			const copied: string[] = [];
			const terminal = new RecordingTerminal(80, 1);
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			tui.addChild(new Text(line, 0, 0));
			tui.start();
			await terminal.waitForRender();

			const oneBasedClickColumn = line.indexOf(needle) + 1;
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1M`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1m`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1M`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1m`);
			await terminal.waitForRender();

			assert.deepStrictEqual(copied, [line]);
			tui.stop();
		}
	});

	it("highlights a complete whitespace segment during a word drag", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		await terminal.waitForRender();

		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("foo  \x1b[27m")));
		tui.stop();
	});

	it("selects whole words on double click, extends word drags, and selects lines on triple click", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("zero alpha beta\ngamma delta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		// The second click lands on a different character in alpha.
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<0;6;1m");
		terminal.sendInput("\x1b[<0;10;1M");
		terminal.sendInput("\x1b[<0;10;1m");
		await terminal.waitForRender();
		const alpha = `\x1b]52;c;${Buffer.from("alpha").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(alpha)));

		// A double-click drag includes each word touched, rather than partial words.
		terminal.sendInput("\x1b[<0;12;1M");
		terminal.sendInput("\x1b[<0;12;1m");
		terminal.sendInput("\x1b[<0;14;1M");
		terminal.sendInput("\x1b[<32;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		await terminal.waitForRender();
		const words = `\x1b]52;c;${Buffer.from("beta\ngamma").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(words)));

		terminal.sendInput("\x1b[<0;7;2M");
		terminal.sendInput("\x1b[<0;7;2m");
		terminal.sendInput("\x1b[<0;9;2M");
		terminal.sendInput("\x1b[<0;9;2m");
		terminal.sendInput("\x1b[<0;11;2M");
		terminal.sendInput("\x1b[<0;11;2m");
		await terminal.waitForRender();
		const line = `\x1b]52;c;${Buffer.from("gamma delta").toString("base64")}\x07`;
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(line)));

		tui.stop();
	});

	it("does not repaint idle or zero-width selections on focus loss", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const writeCount = () => terminal.events.filter((event) => event.type === "write").length;
		const clipboardWriteCount = () =>
			terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;")).length;

		const idleWriteCount = writeCount();
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		assert.strictEqual(writeCount(), idleWriteCount);

		// A completed click leaves a zero-width anchor, but later orphaned drag/release events must not extend it.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(clipboardWriteCount(), 0);

		// Losing focus after a press without a drag cancels the press without repainting.
		terminal.sendInput("\x1b[<0;1;3M");
		await terminal.waitForRender();
		const pressedWriteCount = writeCount();
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		assert.strictEqual(writeCount(), pressedWriteCount);
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(clipboardWriteCount(), 0);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004h")));

		tui.stop();
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004l")));
	});

	it("clears an active visible selection on focus loss and ignores orphan events", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		await terminal.waitForRender();
		const focusLossEventCount = terminal.events.length;
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		const focusLossWrites = terminal.events
			.slice(focusLossEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(focusLossWrites.includes("alpha"));
		assert.ok(focusLossWrites.includes("beta"));
		assert.ok(!focusLossWrites.includes("\x1b[7m"));

		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.ok(terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")));
		tui.stop();
	});

	it("releases the selection press-time component snapshot when the selection ends (X018 lifecycle)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const snapshotOf = (): Set<unknown> | undefined =>
			(tui as unknown as { selectionPressDispatchComponents: Set<unknown> | undefined }).selectionPressDispatchComponents;

		// Press on empty space (row 4, below the text): the selection press
		// snapshots the reached set.
		terminal.sendInput("\x1b[<0;1;4M");
		await terminal.waitForRender();
		assert.ok(snapshotOf() !== undefined, "the selection press must snapshot the reached set");

		// Drag + release: the gesture ends and the snapshot must be
		// released (no dead component references retained).
		terminal.sendInput("\x1b[<32;4;4M");
		terminal.sendInput("\x1b[<3;4;4m");
		await terminal.waitForRender();
		assert.equal(snapshotOf(), undefined, "the press-time snapshot must be released when the selection ends");
		tui.stop();
	});

	it("retains a completed visible selection across focus changes", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		const completedWriteCount = terminal.events.filter((event) => event.type === "write").length;
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		assert.strictEqual(terminal.events.filter((event) => event.type === "write").length, completedWriteCount);

		const redrawEventCount = terminal.events.length;
		tui.renderNow(true);
		const redrawWrites = terminal.events
			.slice(redrawEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		assert.ok(redrawWrites.includes("alpha"));
		assert.ok(redrawWrites.includes("beta"));
		assert.ok(redrawWrites.includes("\x1b[7m"));
		tui.stop();
	});

	it("stacks flash messages and collapses them as they expire", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("one\ntwo\nthree\nfour", 0, 0));
		tui.start();
		await terminal.waitForRender();

		tui.flash("First", 80);
		tui.flash("Second", 500);
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		assert.ok(viewport[0]?.endsWith(" First "));
		assert.ok(viewport[1]?.endsWith(" Second "));

		await new Promise((resolve) => setTimeout(resolve, 100));
		await terminal.waitForRender();
		viewport = terminal.getViewport();
		assert.ok(viewport[0]?.endsWith(" Second "));
		assert.ok(!viewport.some((line) => line.includes("First")));

		tui.stop();
	});

	it("auto-scrolls and extends a drag selection held at the viewport edge", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 6);

		terminal.sendInput("\x1b[<0;1;3M");
		terminal.sendInput("\x1b[<32;1;1M");
		await new Promise((resolve) => setTimeout(resolve, 130));
		await terminal.waitForRender();

		const selectionTop = tui.viewportTop;
		assert.ok(selectionTop < 6, `expected auto-scroll above row 6, got ${selectionTop}`);
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();

		const selectedLines = Array.from({ length: 8 - selectionTop }, (_, index) => `line ${selectionTop + index + 1}`);
		selectedLines.push("l");
		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from(selectedLines.join("\n")).toString("base64")}\x07`;
		assert.ok(
			terminal.events.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
			JSON.stringify(terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;"))),
		);
		tui.stop();
	});

	it("snaps mouse selection to CJK, emoji, and combining grapheme boundaries", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("A界🙂éZ", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const wideSelection = `\x1b]52;c;${Buffer.from("界🙂").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;3;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		assert.strictEqual(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			1,
		);

		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<32;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.strictEqual(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
			2,
		);

		const combiningSelection = `\x1b]52;c;${Buffer.from("éZ").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<32;7;1M");
		terminal.sendInput("\x1b[<0;7;1m");
		await terminal.waitForRender();
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes(combiningSelection)));

		tui.stop();
	});

	it("ignores horizontal trackpad wheel events", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<66;1;1M");
		terminal.sendInput("\x1b[<67;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(tui.viewportTop, 4);
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8"],
		);

		tui.stop();
	});

	it("dispatches clicks to nested mouse regions without breaking drag selection", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		let clicks = 0;
		tui.addChild(
			new MouseRegion(new Text("clickable\nselectable", 0, 0), (event) => {
				if (event.type !== "click") return undefined;
				clicks += 1;
				return { handled: true };
			}),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		assert.strictEqual(clicks, 1);

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		assert.strictEqual(clicks, 1);
		assert.ok(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b]52;c;")));
		tui.stop();
	});

	it("focuses and captures drag gestures for mouse-aware components", async () => {
		const terminal = new VirtualTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		const events: string[] = [];
		const component = {
			render: () => ["control"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				events.push(event.type);
				return event.type === "press" ? { handled: true, capture: true, focus: true } : { handled: true };
			},
		};
		tui.addChild(component);
		tui.start();
		try {
			await terminal.waitForRender();

			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;5;2M");
			terminal.sendInput("\x1b[<0;5;2m");
			await terminal.waitForRender();

			assert.deepStrictEqual(events, ["press", "drag", "release"]);
			// Boolean identity assertion: a strictEqual failure would print
			// the WHOLE TUI object in the diff and hang the test runner.
			assert.ok(tui.getFocusedComponent() === component, "mouse focus must target the clicked component");
		} finally {
			tui.stop();
		}
	});

	it("reports consecutive click counts to component-owned controls", async () => {
		const terminal = new VirtualTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		const clickCounts: number[] = [];
		tui.addChild({
			render: () => ["control"],
			invalidate: () => {},
			handleMouse: (event) => {
				if (event.type === "press") return { handled: true };
				if (event.type === "click") {
					clickCounts.push(event.clickCount ?? 0);
					return { handled: true };
				}
				return undefined;
			},
		});
		tui.start();
		await terminal.waitForRender();

		for (let count = 0; count < 3; count++) {
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<0;1;1m");
		}
		await terminal.waitForRender();
		assert.deepStrictEqual(clickCounts, [1, 2, 3]);
		tui.stop();
	});

	it("does not rerender for handled no-op pointer motion", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		let renderCount = 0;
		tui.addChild({
			render: () => {
				renderCount += 1;
				return ["hover target"];
			},
			invalidate: () => {},
			handleMouse: (event) => (event.type === "move" ? { handled: true } : undefined),
		});
		tui.start();
		await terminal.waitForRender();
		const renderedBeforeMotion = renderCount;
		const writesBeforeMotion = terminal.events.filter((event) => event.type === "write").length;

		terminal.sendInput("\x1b[<35;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(renderCount, renderedBeforeMotion);
		assert.strictEqual(terminal.events.filter((event) => event.type === "write").length, writesBeforeMotion);
		tui.stop();
	});

	it("lets mouse-aware components consume wheel events before viewport scrolling", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		let wheelEvents = 0;
		tui.addChild(
			new MouseRegion(
				new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
				(event) => {
					if (event.type !== "wheel") return undefined;
					wheelEvents += 1;
					return { handled: true };
				},
			),
		);
		tui.start();
		await terminal.waitForRender();
		const viewportTop = tui.viewportTop;

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(wheelEvents, 1);
		assert.strictEqual(tui.viewportTop, viewportTop);
		tui.stop();
	});

	it("restores keyboard state before leaving alt mode and prints the full document", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("first\nsecond\nthird\nfourth\nfifth\nsixth", 0, 0));
		tui.start();
		await terminal.waitForRender();
		tui.stop();

		const startIndex = terminal.events.findIndex((event) => event.type === "start");
		const altScreenEnterIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049h"),
		);
		const stopIndex = terminal.events.findIndex((event) => event.type === "stop");
		const mouseDisableIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1006l"),
		);
		const mainScreenRestoreIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049l"),
		);
		assert.ok(altScreenEnterIndex >= 0 && altScreenEnterIndex < startIndex);
		assert.ok(mouseDisableIndex >= 0 && mouseDisableIndex < stopIndex);
		assert.ok(mainScreenRestoreIndex > stopIndex);

		const restoreEvent = terminal.events[mainScreenRestoreIndex];
		assert.strictEqual(restoreEvent?.type, "write");
		if (restoreEvent?.type === "write") {
			assert.ok(restoreEvent.data.includes("first"));
			assert.ok(restoreEvent.data.includes("second"));
			assert.ok(restoreEvent.data.includes("third"));
			assert.ok(restoreEvent.data.includes("fourth"));
			assert.ok(restoreEvent.data.includes("fifth"));
			assert.ok(restoreEvent.data.includes("sixth"));
			assert.ok(restoreEvent.data.indexOf("first") < restoreEvent.data.indexOf("sixth"));
		}
	});

	it("gives wheel and viewport keys to a focused overlay", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		const overlay = new InputOverlay();
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;
		const handle = tui.showOverlay(overlay);
		await terminal.waitForRender();
		assert.strictEqual(overlay.focused, true);

		const wheel = "\x1b[<64;10;3M";
		const keys = ["\x1b[5~", "\x1b[6~", "\x1bOH", "\x1bOF", wheel];
		for (const key of keys) terminal.sendInput(key);
		await terminal.waitForRender();

		assert.deepStrictEqual(overlay.inputs, keys);
		assert.strictEqual(tui.viewportTop, topBefore);

		handle.hide();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		assert.ok(tui.viewportTop < topBefore);
		tui.stop();
	});

	it("keeps viewport scrolling when an overlay is not focused", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const editor = new InputOverlay();
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;

		const hidden = tui.showOverlay(new InputOverlay());
		hidden.setHidden(true);
		const nonCapturing = new InputOverlay();
		tui.showOverlay(nonCapturing, { nonCapturing: true });
		const unfocused = new InputOverlay();
		const unfocusedHandle = tui.showOverlay(unfocused);
		unfocusedHandle.unfocus();
		await terminal.waitForRender();
		assert.strictEqual(nonCapturing.focused, false);
		assert.strictEqual(unfocused.focused, false);

		terminal.sendInput("\x1b[5~");
		terminal.sendInput("\x1b[<64;10;3M");
		await terminal.waitForRender();
		assert.ok(tui.viewportTop < topBefore);
		assert.deepStrictEqual(nonCapturing.inputs, []);
		assert.deepStrictEqual(unfocused.inputs, []);
		tui.stop();
	});

	it("keeps viewport scrolling while transcript search is focused", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;

		terminal.sendInput("\x1b[102;6u");
		await terminal.waitForRender();
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ ↓")));

		terminal.sendInput("\x1b[5~");
		terminal.sendInput("\x1b[<64;1;4M");
		await terminal.waitForRender();
		assert.ok(tui.viewportTop < topBefore);
		assert.ok(terminal.getViewport().some((line) => line.includes("↑ ↓")));
		tui.stop();
	});
});

	it("notifies the host when dragging the primary scrollbar to an edge", async () => {
		const terminal = new RecordingTerminal(10, 5);
		const boundaries: Array<[-1 | 1, "wheel" | "page" | "scrollbar"]> = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onScrollBoundary: (direction, source) => {
				boundaries.push([direction, source]);
				return true;
			},
		});
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "auto" },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();

		// A wheel event reveals the scrollbar and leaves its thumb at the top.
		terminal.sendInput("\x1b[<65;10;1M");
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;10;1M");
		terminal.sendInput("\x1b[<32;10;5M");
		await terminal.waitForRender();
		assert.deepStrictEqual(boundaries, [[1, "scrollbar"]]);
		tui.stop();
	});

	it("chains unused wheel delta to an outer scroll view", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
		const inner = new ScrollView(new Text("i1\ni2\ni3\ni4\ni5\ni6", 0, 0));
		const outer = new ScrollView(
			new VStack([{ component: inner, basis: 2 }, new Text("tail1\ntail2\ntail3\ntail4\ntail5", 0, 0)]),
			{ primary: true },
		);
		tui.setLayoutRoot(outer);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 3);
		assert.strictEqual(outer.scrollTop, 0);

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		assert.strictEqual(inner.scrollTop, 4);
		assert.strictEqual(outer.scrollTop, 2);
		tui.stop();
	});


	it("notifies the host when PageUp and wheel reach viewport boundaries", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const boundaries: Array<[-1 | 1, "wheel" | "page" | "scrollbar"]> = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onScrollBoundary: (direction, source) => {
				boundaries.push([direction, source]);
				return true;
			},
		});
		tui.addChild(new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		for (let press = 0; press < 4; press += 1) {
			terminal.sendInput("\x1b[57421u");
			await terminal.waitForRender();
		}
		assert.deepStrictEqual(boundaries, [[-1, "page"]]);

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		assert.deepStrictEqual(boundaries, [[-1, "page"], [-1, "wheel"]]);
		tui.stop();
	});

	it("supports configurable keyboard viewport navigation with four rows of page overlap", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[57421u");
		terminal.sendInput("\x1b[57421;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		terminal.sendInput("\x1b[57422u");
		terminal.sendInput("\x1b[57422;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		terminal.sendInput("\x1bOH");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 1", "line 2", "line 3", "line 4", "line 5", "line 6", "line 7", "line 8"],
		);

		terminal.sendInput("\x1bOF");
		await terminal.waitForRender();
		assert.deepStrictEqual(
			terminal.getViewport().map((line) => line.trimEnd()),
			["line 5", "line 6", "line 7", "line 8", "line 9", "line 10", "line 11", "line 12"],
		);

		tui.stop();
	});


	it("host semantic viewport actions can clear built-in transcript search", async () => {
		const terminal = new RecordingTerminal(60, 8);
		let claimed = false;
		let tui!: TuiAltScreen;
		tui = new TuiAltScreen(terminal, undefined, undefined, {
			onBeforeViewportInput: (data) => {
				if (data !== "\x1b[1;5F") return false;
				claimed = tui.clearSearch();
				return claimed;
			},
		});
		tui.addChild(new Text("needle in the transcript", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		// v0.85.1 renders the search query in the panel (the "Find in
		// transcript" placeholder is replaced once text is typed), so the
		// always-visible navigation hint proves the panel is open.
		assert.ok(terminal.getViewport().some((line) => line.includes("Shift+Enter")));

		terminal.sendInput("\x1b[1;5F");
		await terminal.waitForRender();
		assert.strictEqual(claimed, true);
		assert.ok(!terminal.getViewport().some((line) => line.includes("Shift+Enter")));
		tui.stop();
	});

	it("lets a focused overlay keep a host-claimed viewport key (X028 defer priority)", async () => {
		const terminal = new RecordingTerminal(60, 8);
		let claimed = false;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onBeforeViewportInput: (data) => {
				if (data !== "\x1b[1;5F") return false; // Ctrl+End
				claimed = true;
				return true;
			},
		});
		tui.addChild(new Text("transcript", 0, 0));
		tui.start();
		await terminal.waitForRender();

		// Without an overlay the seam claims the key.
		terminal.sendInput("\x1b[1;5F");
		await terminal.waitForRender();
		assert.strictEqual(claimed, true);

		// With a focused non-search overlay the SAME key must fall through
		// to the overlay (upstream shouldDeferViewportInputToOverlay
		// priority), never to the host seam.
		claimed = false;
		const received: string[] = [];
		const overlay = {
			render: () => ["OVERLAY"],
			handleInput: (data: string) => {
				received.push(data);
			},
			invalidate: () => {},
		};
		tui.showOverlay(overlay);
		await terminal.waitForRender();
		terminal.sendInput("\x1b[1;5F");
		await terminal.waitForRender();
		assert.strictEqual(claimed, false, "the host seam must not claim a key while a non-search overlay is focused");
		assert.deepStrictEqual(received, ["\x1b[1;5F"], "the focused overlay must receive the key");
		tui.stop();
	});

	it("scrolls the transcript by half a page with custom bindings", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.halfPageUp": "ctrl+u",
				"tui.altScreen.halfPageDown": "ctrl+d",
			}),
		);
		try {
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);

			terminal.sendInput("\x15");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 15);

			terminal.sendInput("\x04");
			await terminal.waitForRender();
			assert.strictEqual(tui.viewportTop, 20);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});


	it("lets viewport navigation keys reach the focused component when nothing can scroll", async () => {
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		// Content fits the viewport: the primary scroll view cannot scroll, so
		// navigation keys belong to the focused component (e.g. a full-screen
		// viewer mounted as the layout root with its own scrolling).
		const transcript = new ScrollView(new Text("fits", 0, 0), { follow: "end", primary: true });
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		const inputs = ["\x1b[5~", "\x1b[6~", "\x1b[H", "\x1b[F"];
		for (const input of inputs) terminal.sendInput(input);
		await terminal.waitForRender();
		assert.strictEqual(transcript.scrollTop, 0);
		assert.deepStrictEqual(editorInputs, inputs);

		tui.stop();
	});


	it("fires onCellClick for a same-cell primary press+release without a drag", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const clicks: Array<{ x: number; y: number }> = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onCellClick: (x, y) => clicks.push({ x, y }),
		});
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;5;3M"); // primary press (SGR 1-based)
		terminal.sendInput("\x1b[<0;5;3m"); // release at the same cell
		await terminal.waitForRender();
		// The callback receives 0-based screen coordinates.
		assert.deepStrictEqual(clicks, [{ x: 4, y: 2 }]);
		tui.stop();
	});

	it("does not fire onCellClick for a drag, a wheel, or a secondary button", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const clicks: Array<{ x: number; y: number }> = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onCellClick: (x, y) => clicks.push({ x, y }),
		});
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;5;3M"); // press
		terminal.sendInput("\x1b[<0;9;3m"); // release elsewhere = a drag
		terminal.sendInput("\x1b[<64;5;3M"); // wheel up
		terminal.sendInput("\x1b[<2;5;3M"); // secondary press
		terminal.sendInput("\x1b[<2;5;3m"); // secondary release
		await terminal.waitForRender();
		assert.deepStrictEqual(clicks, []);
		tui.stop();
	});


	it("copies line-head selections without the emoji-column indent", async () => {
		const terminal = new RecordingTerminal(20, 5);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("🐋  first line\n   second line\n    indented\nlast line", 0, 0));
		tui.start();
		await terminal.waitForRender();

		// Drag from (col 1, row 1) to (col 1, row 4): the selection covers
		// all four rows from their line heads. Continuation lines carry the
		// emoji-column padding (3 spaces) — those must be dropped, while a
		// 4+ space content indent (the code-block case) retains residual space
		// after the bounded 1-to-3-space strip.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;1;4M");
		terminal.sendInput("\x1b[<0;1;4m");
		await terminal.waitForRender();

		const expectedClipboard = Buffer.from("🐋  first line\nsecond line\n indented\nl").toString("base64");
		const clipboardWrites = terminal.events.filter(
			(event) => event.type === "write" && event.data.includes("\x1b]52;c;"),
		);
		assert.ok(
			clipboardWrites.some((event) => event.type === "write" && event.data.includes(`\x1b]52;c;${expectedClipboard}\x07`)),
			JSON.stringify(clipboardWrites),
		);
		tui.stop();
	});

	it("keeps leading spaces when the selection starts mid-line", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("aa   second line", 0, 0));
		tui.start();
		await terminal.waitForRender();

		// Drag from (col 4, row 1) to (col 10, row 1): the selection starts
		// INSIDE the line — its leading spaces are content, not the emoji
		// column, and must be copied verbatim.
		terminal.sendInput("\x1b[<0;4;1M");
		terminal.sendInput("\x1b[<32;10;1M");
		terminal.sendInput("\x1b[<0;10;1m");
		await terminal.waitForRender();

		const expectedClipboard = Buffer.from("  secon").toString("base64");
		const clipboardWrites = terminal.events.filter(
			(event) => event.type === "write" && event.data.includes("\x1b]52;c;"),
		);
		assert.ok(
			clipboardWrites.some((event) => event.type === "write" && event.data.includes(`\x1b]52;c;${expectedClipboard}\x07`)),
			JSON.stringify(clipboardWrites),
		);
		tui.stop();

});

describe("TuiAltScreen viewport listener registration order (X043)", () => {
	it("registers the viewport listener in the constructor by default (host listeners see consumed scroll keys last)", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const seen: string[] = [];
		tui.addInputListener((data) => {
			seen.push(data);
			return undefined;
		});
		const text = new Text(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"), 0, 0);
		tui.setLayoutRoot(new VStack([{ component: new ScrollView(text, { follow: "end", primary: true }), basis: 0, grow: 1 }]));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;1;1M"); // wheel up — the viewport consumes it
		await terminal.waitForRender();
		assert.strictEqual(seen.length, 0, "with the default order the viewport listener consumes wheel events before later host listeners");
		assert.ok(tui.viewportTop < 6, "the viewport actually scrolled");
		tui.stop();
	});

	it("deferViewportListener lets the host install its router FIRST", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { deferViewportListener: true });
		const seen: string[] = [];
		tui.addInputListener((data) => {
			seen.push(data);
			return undefined;
		});
		tui.installViewportListener();
		const text = new Text(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"), 0, 0);
		tui.setLayoutRoot(new VStack([{ component: new ScrollView(text, { follow: "end", primary: true }), basis: 0, grow: 1 }]));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;1;1M"); // wheel up — the host listener now sees it first
		await terminal.waitForRender();
		assert.deepStrictEqual(seen, ["\x1b[<64;1;1M"], "the host router must see raw chunks before the viewport consumes them");
		assert.ok(tui.viewportTop < 6, "the unconsumed chunk still reaches the viewport and scrolls");
		tui.stop();
	});

	it("installViewportListener is idempotent", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { deferViewportListener: true });
		tui.installViewportListener();
		tui.installViewportListener();
		const text = new Text(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n"), 0, 0);
		tui.setLayoutRoot(new VStack([{ component: new ScrollView(text, { follow: "end", primary: true }), basis: 0, grow: 1 }]));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		// A duplicated viewport listener would scroll TWICE per wheel event.
		assert.strictEqual(tui.viewportTop, 5, "one wheel event must scroll exactly one line-step (no double listener)");
		tui.stop();
	});
});

	it("releases the selection press-time snapshot on focus-out (X018 lifecycle)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const snapshotOf = (): Set<unknown> | undefined =>
			(tui as unknown as { selectionPressDispatchComponents: Set<unknown> | undefined }).selectionPressDispatchComponents;

		// Press on empty space (row 4, below the text): the selection press
		// snapshots the reached set.
		terminal.sendInput("\x1b[<0;1;4M");
		await terminal.waitForRender();
		assert.ok(snapshotOf() !== undefined, "the selection press must snapshot the reached set");

		// Focus leaves mid-gesture: the snapshot must be released.
		terminal.sendInput("\x1b[O");
		await terminal.waitForRender();
		assert.equal(snapshotOf(), undefined, "focus-out must release the press-time snapshot");
		tui.stop();
	});

	it("releases the selection press-time snapshot on stop (X018 lifecycle)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const snapshotOf = (): Set<unknown> | undefined =>
			(tui as unknown as { selectionPressDispatchComponents: Set<unknown> | undefined }).selectionPressDispatchComponents;

		// Press on empty space (row 4, below the text): the selection press
		// snapshots the reached set.
		terminal.sendInput("\x1b[<0;1;4M");
		await terminal.waitForRender();
		assert.ok(snapshotOf() !== undefined, "the selection press must snapshot the reached set");

		// Stop mid-gesture: the snapshot must be released.
		tui.stop();
		assert.equal(snapshotOf(), undefined, "stop must release the press-time snapshot");
	});

	it("blocks transcript selection under an inert capturing overlay (X018 modal isolation)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		// A plain Text overlay (no handleMouse) mounted over the transcript:
		// it is a capturing overlay, so a drag over it must NOT select/copy
		// the hidden underlying text.
		tui.showOverlay(new Text("overlay", 0, 0));
		await terminal.waitForRender();
		// Press on the overlay, drag, release.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;8;2M");
		terminal.sendInput("\x1b[<3;8;2m");
		await terminal.waitForRender();
		const clipboardWrites = terminal.events.filter(
			(event) => event.type === "write" && event.data.includes("\x1b]52;c;"),
		);
		assert.equal(clipboardWrites.length, 0, "a drag over an inert capturing overlay must not copy the hidden background");
		tui.stop();
	});

	it("forwards focus and keyboard to an Input inside a plain Container overlay root (X051)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		// A plain Container (no FocusForwardingFrame) as the overlay root,
		// containing a real Input: the public showOverlay contract must
		// reach the interactive child.
		const input = new Input();
		const root = new Container();
		root.addChild(input);
		tui.showOverlay(root);
		await terminal.waitForRender();
		// Press on the Input (the overlay's content row — the overlay
		// renders at screen row 1, so SGR row 2).
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(input.focused, true, "the Input inside the Container root must receive the focused flag");
		// A key must reach the Input through the Container root.
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(input.getValue(), "x", "the Input must receive keyboard input through the Container root");
		tui.stop();
	});

	it("forwards focus and keyboard to the CLICKED child only in a multi-child Container overlay root (X051)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const first = new Input();
		const second = new Input();
		const root = new Container();
		root.addChild(first);
		root.addChild(second);
		tui.showOverlay(root);
		await terminal.waitForRender();
		// Press on the SECOND Input (the overlay renders two rows at screen
		// rows 1-2, so SGR row 3 hits the second child).
		terminal.sendInput("\x1b[<0;2;3M");
		terminal.sendInput("\x1b[<0;2;3m");
		await terminal.waitForRender();
		assert.strictEqual(second.focused, true, "the clicked Input must receive the focused flag");
		assert.strictEqual(first.focused, false, "the unclicked Input must NOT receive the focused flag");
		// A key must reach ONLY the clicked child.
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(second.getValue(), "x", "the clicked Input must receive the key");
		assert.strictEqual(first.getValue(), "", "the unclicked Input must NOT receive the key");
		tui.stop();
	});

	it("forwards focus and keyboard to an Input inside a plain Box overlay root (X051)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const input = new Input();
		const root = new Box();
		root.addChild(input);
		tui.showOverlay(root);
		await terminal.waitForRender();
		// The Box has default padding (1,1): the Input renders at the
		// content area. Press on the Input row.
		const viewport = terminal.getViewport();
		const inputRow = viewport.findIndex(line => line.includes(">"));
		assert.ok(inputRow >= 0, `input row missing:\n${viewport.join('\n')}`);
		terminal.sendInput(`\x1b[<0;2;${inputRow + 1}M`);
		terminal.sendInput(`\x1b[<0;2;${inputRow + 1}m`);
		await terminal.waitForRender();
		assert.strictEqual(input.focused, true, "the Input inside the Box root must receive the focused flag");
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(input.getValue(), "x", "the Input must receive keyboard input through the Box root");
		tui.stop();
	});

	it("cancels an in-flight selection gesture when the drag lands on a capturing overlay (X018 lifecycle)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		tui.showOverlay(new Text("overlay", 0, 0));
		await terminal.waitForRender();
		const snapshotOf = (): Set<unknown> | undefined =>
			(tui as unknown as { selectionPressDispatchComponents: Set<unknown> | undefined }).selectionPressDispatchComponents;

		// Press OUTSIDE the overlay (row 0), drag INTO the overlay (row 1),
		// release on the overlay: the in-flight selection gesture must be
		// cancelled — no copy, no armed press state, no retained snapshot.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;8;2M");
		terminal.sendInput("\x1b[<3;8;2m");
		await terminal.waitForRender();
		const clipboardWrites = terminal.events.filter(
			(event) => event.type === "write" && event.data.includes("\x1b]52;c;"),
		);
		assert.equal(clipboardWrites.length, 0, "a drag landing on a capturing overlay must not copy the background");
		assert.equal(snapshotOf(), undefined, "the in-flight selection snapshot must be released");
		const state = tui as unknown as { selectionPressActive: boolean };
		assert.equal(state.selectionPressActive, false, "the in-flight selection gesture must be cancelled");
		tui.stop();
	});

	it("clears children exactly once when a child dispose reenters clear (X007)", async () => {
		const box = new Box();
		const disposed: string[] = [];
		const reentrant = {
			render: () => [],
			invalidate: () => {},
			dispose: () => {
				disposed.push("reentrant");
				// Reenter: clear the box again while it is mid-clear.
				box.clear();
			},
		};
		const plain = {
			render: () => [],
			invalidate: () => {},
			dispose: () => {
				disposed.push("plain");
			},
		};
		box.addChild(reentrant);
		box.addChild(plain);
		box.clear();
		assert.deepStrictEqual(disposed, ["reentrant", "plain"], "each child must be disposed exactly once");
		assert.strictEqual(box.children.length, 0, "the box must be empty after clear");
	});

	it("cancels an in-flight scrollbar drag when the pointer lands on a capturing overlay (X018 lifecycle)", async () => {
		const terminal = new RecordingTerminal(10, 10);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "always" },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		// Press on the track: starts a scrollbar drag.
		terminal.sendInput("\x1b[<0;10;6M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 20);
		// A capturing overlay appears covering the scrollbar column; drag
		// onto it: the in-flight drag must be cancelled.
		tui.showOverlay(new Text("overlay", 9, 0));
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<32;5;4M");
		await terminal.waitForRender();
		assert.strictEqual(scrollView.scrollTop, 20, "the drag must not scroll while the pointer is on the overlay");
		const state = tui as unknown as { scrollbarDrag: unknown };
		assert.strictEqual(state.scrollbarDrag, undefined, "the in-flight scrollbar drag must be cancelled when the pointer lands on the overlay");
		terminal.sendInput("\x1b[<0;5;4m");
		await terminal.waitForRender();
		tui.stop();
	});

	it("jumps a hidden auto scrollbar track on a stationary first press (X018)", async () => {
		const terminal = new RecordingTerminal(10, 5);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "auto", scrollbarHideDelayMs: 20 },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(scrollView.isScrollbarVisible, false);
		const before = scrollView.scrollTop;

		// A stationary FIRST press on the hidden track column must jump the
		// scroll position immediately (includeHiddenAuto on the press path) —
		// no hover reveal + second press needed.
		terminal.sendInput("\x1b[<0;10;3M");
		await terminal.waitForRender();
		assert.ok(scrollView.scrollTop > before, "the first press must jump the hidden auto scrollbar track");
		terminal.sendInput("\x1b[<0;10;3m");
		await terminal.waitForRender();
		tui.stop();
	});

	it("honors the showHardwareCursor constructor parameter (upstream v0.85.1 removed the PI_HARDWARE_CURSOR env knob)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, true);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		assert.strictEqual(tui.getShowHardwareCursor(), true, "the constructor parameter must enable the hardware cursor");
		tui.setShowHardwareCursor(false);
		assert.strictEqual(tui.getShowHardwareCursor(), false, "setShowHardwareCursor must toggle the flag");
		tui.stop();
	});

	it("treats an Input under a Box root as mounted (X051 liveness)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.start();
		await terminal.waitForRender();
		const input = new Input();
		const root = new Box();
		root.addChild(input);
		tui.setLayoutRoot(root);
		await terminal.waitForRender();
		// The blocked-overlay focus restore path calls isComponentMounted:
		// an Input under a Box root must be reported as mounted (the
		// structural walk covers Box children, not just Container).
		const t = tui as unknown as { isComponentMounted(c: unknown): boolean };
		assert.strictEqual(t.isComponentMounted(input), true, "an Input under a Box root must be reported as mounted");
		tui.stop();
	});

	it("ignores the legacy PI_HARDWARE_CURSOR env knob (upstream v0.85.1 removed coding-agent config reads)", async () => {
		process.env.PI_HARDWARE_CURSOR = "1";
		try {
			const terminal = new RecordingTerminal(20, 4);
			const tui = new TuiAltScreen(terminal);
			tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
			tui.start();
			await terminal.waitForRender();
			assert.strictEqual(tui.getShowHardwareCursor(), false, "the legacy env knob must not control the default");
			tui.stop();
		} finally {
			delete process.env.PI_HARDWARE_CURSOR;
		}
	});

	it("keeps the replacement focused when an Input under a Box root blocks overlay focus (X051 liveness)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.start();
		await terminal.waitForRender();
		const input = new Input();
		const box = new Box();
		box.addChild(input);
		const a = new Text("a", 0, 0);
		const c = new Text("c", 0, 0);
		tui.addChild(box);
		tui.addChild(a);
		tui.addChild(c);
		const overlay = new Text("overlay", 0, 0);
		const r = new Text("r", 0, 0);
		// r is the current focus when the overlay appears: it becomes the
		// overlay's preFocus (the focus to restore when the overlay closes).
		tui.setFocus(r);
		tui.showOverlay(overlay);
		await terminal.waitForRender();
		// The overlay owns the focus while visible.
		assert.strictEqual(tui.getFocusedComponent(), overlay, "the overlay must own the focus while visible");
		// a blocks the overlay focus.
		tui.setFocus(a);
		assert.strictEqual(tui.getFocusedComponent(), a, "a must own the focus");
		// The Input under the Box root blocks it too: it must be reported
		// as MOUNTED (structural walk covers Box children), so the overlay
		// focus restore must NOT hijack the next focus.
		tui.setFocus(input);
		assert.strictEqual(tui.getFocusedComponent(), input, "the Input under the Box root must own the focus");
		// c must keep the focus — the blocked overlay must not regain it
		// because the Input was (wrongly) considered unmounted.
		tui.setFocus(c);
		assert.strictEqual(tui.getFocusedComponent(), c, "the replacement must keep the focus (Box subtree is live)");
		tui.stop();
	});

	it("releases the selection press-time snapshot when a scrollbar press ends the selection (X018 lifecycle)", async () => {
		const terminal = new RecordingTerminal(10, 5);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ primary: true, scrollbar: "always" },
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		const snapshotOf = (): Set<unknown> | undefined =>
			(tui as unknown as { selectionPressDispatchComponents: Set<unknown> | undefined }).selectionPressDispatchComponents;

		// A selection press on empty space snapshots the reached set.
		terminal.sendInput("\x1b[<0;1;1M");
		await terminal.waitForRender();
		assert.ok(snapshotOf() !== undefined, "the selection press must snapshot the reached set");

		// A scrollbar press ends the in-flight selection gesture: the
		// snapshot must be released too.
		terminal.sendInput("\x1b[<0;10;3M");
		await terminal.waitForRender();
		assert.equal(snapshotOf(), undefined, "the scrollbar press must release the selection press-time snapshot");
		terminal.sendInput("\x1b[<0;10;3m");
		await terminal.waitForRender();
		tui.stop();
	});

	it("forwards key releases to a wantsKeyRelease child through a Container overlay root (X051)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const received: string[] = [];
		const child = {
			wantsKeyRelease: true,
			render: () => ["child"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => (event.type === "press" ? { handled: true, focus: true } : undefined),
			handleInput: (data: string) => {
				received.push(data);
			},
		};
		const root = new Container();
		root.addChild(child);
		tui.showOverlay(root);
		await terminal.waitForRender();
		// Press on the child (the overlay renders at screen row 1).
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(tui.getFocusedComponent(), root, "the Container root must own the focus");
		// A Kitty key release must reach the child through the container
		// root (the root forwards wantsKeyRelease).
		terminal.sendInput("\x1b[97;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(received, ["\x1b[97;1:3u"], "the wantsKeyRelease child must receive the key release");
		tui.stop();
	});

	it("forwards key releases to a wantsKeyRelease child through a Box overlay root (X051)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const received: string[] = [];
		const child = {
			wantsKeyRelease: true,
			render: () => ["child"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => (event.type === "press" ? { handled: true, focus: true } : undefined),
			handleInput: (data: string) => {
				received.push(data);
			},
		};
		const root = new Box();
		root.addChild(child);
		tui.showOverlay(root);
		await terminal.waitForRender();
		// Press on the child (the Box has default padding (1,1): the child
		// renders at screen row 1, col 1 = SGR row 2, col 2).
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(tui.getFocusedComponent(), root, "the Box root must own the focus");
		// A Kitty key release must reach the child through the Box root.
		terminal.sendInput("\x1b[97;1:3u");
		await terminal.waitForRender();
		assert.deepStrictEqual(received, ["\x1b[97;1:3u"], "the wantsKeyRelease child must receive the key release");
		tui.stop();
	});

	it("drops a focused child replaced via direct children mutation in a Container (X051 liveness)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const first = new Input();
		const second = new Input();
		const root = new Container();
		root.addChild(first);
		tui.showOverlay(root);
		await terminal.waitForRender();
		// Press the Input: the Container forwards focus/input to it.
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(first.focused, true, "the pressed Input must receive the focused flag");
		// Direct structural replacement (the public children mutation
		// contract): the old focused child is detached.
		root.children = [second];
		tui.requestRender();
		await terminal.waitForRender();
		// Keyboard input must NOT reach the detached child, and the
		// replacement must NOT silently inherit focus.
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(first.getValue(), "", "the detached child must not receive keyboard input");
		assert.strictEqual(second.getValue(), "", "the replacement must not implicitly receive keyboard input");
		assert.strictEqual(second.focused, false, "the replacement must not implicitly receive focus");
		// A fresh press names the new focus owner.
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(second.getValue(), "x", "a fresh press must re-establish the focus owner");
		tui.stop();
	});

	it("drops a focused child replaced via direct children mutation in a Box (X051 liveness)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const first = new Input();
		const second = new Input();
		const root = new Box();
		root.addChild(first);
		tui.showOverlay(root);
		await terminal.waitForRender();
		// Press the Input (the Box has default padding (1,1): the child
		// renders at screen row 1, col 1 = SGR row 2, col 2).
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(first.focused, true, "the pressed Input must receive the focused flag");
		// Direct structural replacement (the public children mutation
		// contract): the old focused child is detached.
		root.children = [second];
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(first.getValue(), "", "the detached child must not receive keyboard input");
		assert.strictEqual(second.getValue(), "", "the replacement must not implicitly receive keyboard input");
		assert.strictEqual(second.focused, false, "the replacement must not implicitly receive focus");
		// A fresh press names the new focus owner.
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(second.getValue(), "x", "a fresh press must re-establish the focus owner");
		tui.stop();
	});

	it("does not leak wantsKeyRelease from a detached focused child (X051 liveness)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const received: string[] = [];
		const first = {
			wantsKeyRelease: true,
			render: () => ["first"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => (event.type === "press" ? { handled: true, focus: true } : undefined),
			handleInput: (data: string) => {
				received.push(data);
			},
		};
		const second = {
			render: () => ["second"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => (event.type === "press" ? { handled: true, focus: true } : undefined),
			handleInput: (data: string) => {
				received.push(data);
			},
		};
		const root = new Container();
		root.addChild(first);
		tui.showOverlay(root);
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(root.wantsKeyRelease, true, "the pressed child's capability must forward");
		// Direct replacement: the detached child's capability must not leak.
		root.children = [second];
		tui.requestRender();
		await terminal.waitForRender();
		assert.strictEqual(root.wantsKeyRelease, undefined, "a detached child's wantsKeyRelease must not leak");
		tui.stop();
	});

	it("does not resurrect a stale focus owner after A→B→A replacement in a Container (X051 liveness)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const first = new Input();
		const second = new Input();
		const root = new Container();
		root.addChild(first);
		tui.showOverlay(root);
		await terminal.waitForRender();
		// Press the Input: the Container forwards focus/input to it.
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(first.focused, true, "the pressed Input must receive the focused flag");
		// A → B + repaint: the paint itself must invalidate the old
		// forwarding identity (not lazily on the next keyboard event).
		root.children = [second];
		tui.requestRender();
		await terminal.waitForRender();
		// A → A again + repaint: the stale owner must NOT resurrect.
		root.children = [first];
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(first.getValue(), "", "the stale focus owner must not resurrect on keyboard input");
		assert.strictEqual(first.focused, false, "the detached child must not keep the focused flag");
		// A fresh press names the new focus owner.
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(first.getValue(), "x", "a fresh press must re-establish the focus owner");
		tui.stop();
	});

	it("does not resurrect a stale focus owner after A→B→A replacement in a Box (X051 liveness)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const first = new Input();
		const second = new Input();
		const root = new Box();
		root.addChild(first);
		tui.showOverlay(root);
		await terminal.waitForRender();
		// Press the Input (the Box has default padding (1,1): the child
		// renders at screen row 1, col 1 = SGR row 2, col 2).
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(first.focused, true, "the pressed Input must receive the focused flag");
		root.children = [second];
		tui.requestRender();
		await terminal.waitForRender();
		root.children = [first];
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(first.getValue(), "", "the stale focus owner must not resurrect on keyboard input");
		assert.strictEqual(first.focused, false, "the detached child must not keep the focused flag");
		// A fresh press names the new focus owner.
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		terminal.sendInput("x");
		await terminal.waitForRender();
		assert.strictEqual(first.getValue(), "x", "a fresh press must re-establish the focus owner");
		tui.stop();
	});

	it("clears the focused flag on removeChild/clear/dispose in a Container (X051 liveness)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const first = new Input();
		const root = new Container();
		root.addChild(first);
		tui.showOverlay(root);
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(first.focused, true, "the pressed Input must receive the focused flag");
		// removeChild: the detached child must not keep the focused flag
		// (IME/hardware-cursor state) — a re-mount elsewhere must not show
		// a stale CURSOR_MARKER.
		root.removeChild(first);
		assert.strictEqual(first.focused, false, "removeChild must clear the focused flag");
		// clear: same contract.
		const second = new Input();
		root.addChild(second);
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(second.focused, true, "the pressed Input must receive the focused flag");
		root.clear();
		assert.strictEqual(second.focused, false, "clear must clear the focused flag");
		// dispose: same contract.
		const third = new Input();
		root.addChild(third);
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(third.focused, true, "the pressed Input must receive the focused flag");
		root.dispose();
		assert.strictEqual(third.focused, false, "dispose must clear the focused flag");
		tui.stop();
	});

	it("clears the focused flag on removeChild/clear in a Box (X051 liveness)", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const first = new Input();
		const root = new Box();
		root.addChild(first);
		tui.showOverlay(root);
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(first.focused, true, "the pressed Input must receive the focused flag");
		root.removeChild(first);
		assert.strictEqual(first.focused, false, "removeChild must clear the focused flag");
		const second = new Input();
		root.addChild(second);
		tui.requestRender();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		assert.strictEqual(second.focused, true, "the pressed Input must receive the focused flag");
		root.clear();
		assert.strictEqual(second.focused, false, "clear must clear the focused flag");
		tui.stop();
	});

	it("does not synthesize a click on a still-mounted overlay that moved (X018 painted-placement liveness)", async () => {
		const terminal = new RecordingTerminal(40, 20);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta\nepsilon\nzeta\neta\ntheta\niota\nkappa\nlambda\nmu\nnu\nxi\nomicron\npi\nrho\nsigma\ntau\nupsilon", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const changes: string[] = [];
		const list = new SettingsList(
			[
				{ id: "a", label: "A", currentValue: "on", values: ["on", "off"] },
				{
					id: "b",
					label: "B",
					currentValue: "on",
					values: ["on", "off"],
					description: "long description " + "that wraps ".repeat(3),
				},
			],
			10,
			{
				label: (text) => text,
				value: (text) => text,
				description: (text) => text,
				cursor: "> ",
				hint: (text) => text,
			},
			(id, value) => changes.push(`${id}:${value}`),
			() => {},
		);
		tui.showOverlay(list, { anchor: "center" });
		await terminal.waitForRender();
		// Record B's absolute row.
		const view = terminal.getViewport();
		const rowB = view.findIndex(line => line.includes("B"));
		assert.ok(rowB >= 0, `B row missing:\n${view.join("\n")}`);
		// Press B: the press selects B, its description renders, and the
		// CENTERED overlay grows and moves up.
		terminal.sendInput(`\x1b[<0;2;${rowB + 1}M`);
		await terminal.waitForRender();
		const after = terminal.getViewport();
		const rowB2 = after.findIndex(line => line.includes("B"));
		assert.notEqual(rowB2, rowB, "B must move after the press repaint");
		// Release at the ORIGINAL absolute row: the synthetic click must
		// NOT activate B (the painted placement moved — the release cell
		// is no longer the pressed cell).
		terminal.sendInput(`\x1b[<0;2;${rowB + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(changes, [], "the moved overlay must not receive the ghost click");
		// A fresh press+release at B's NEW row works.
		terminal.sendInput(`\x1b[<0;2;${rowB2 + 1}M`);
		terminal.sendInput(`\x1b[<0;2;${rowB2 + 1}m`);
		await terminal.waitForRender();
		assert.deepStrictEqual(changes, ["b:off"], "a fresh press at the new row must activate B");
		tui.stop();
	});

	it("synthesizes the click for a child nested inside a padded Box overlay root (X018 painted-placement)", async () => {
		const terminal = new RecordingTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();
		const received: string[] = [];
		const child = {
			render: () => ["child"],
			invalidate: () => {},
			handleMouse: (event: TuiMouseEvent) => {
				if (event.type === "press") return { handled: true, focus: true };
				if (event.type === "click") {
					received.push("click");
					return { handled: true };
				}
				return undefined;
			},
		};
		const root = new Box();
		root.addChild(child);
		tui.showOverlay(root);
		await terminal.waitForRender();
		// The Box has default padding (1,1): the child renders at screen
		// row 2, col 1 (0-based) = SGR row 3, col 2.
		terminal.sendInput("\x1b[<0;2;3M");
		terminal.sendInput("\x1b[<0;2;3m");
		await terminal.waitForRender();
		assert.deepStrictEqual(received, ["click"], "the padded Box child must receive the synthetic click");
		tui.stop();
	});
