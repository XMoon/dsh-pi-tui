import assert from "node:assert";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import type { TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

/**
 * Divergence X063 — the read-only Down-boundary seam
 * (`canYieldDownAtLastVisualLine`).
 *
 * The seam must classify EXACTLY the editor states a real Down press would
 * resolve through the editor's own visual-line logic, and refuse every state
 * where Down belongs to history browsing, autocomplete, jump mode or an
 * active bracketed paste. Every witness drives a REAL editor into the state
 * through its public input path and reads only the protected predicate — the
 * guard proves the host's Task Quick admission can never fire on a visual
 * boundary the fork itself would not yield.
 */

function createTestTUI(cols = 80, rows = 24): TUI {
	return new TuiMainScreen(new VirtualTerminal(cols, rows));
}

/** The layout width `render(width)` derives for THIS editor — the same
 *  formula the host predicate applies to the physical width. */
function layoutWidthFor(editor: Editor, physicalWidth: number): number {
	const paddingX = (editor as unknown as { getPaddingX(): number }).getPaddingX();
	const clampedPadding = Math.min(paddingX, Math.max(0, Math.floor((physicalWidth - 1) / 2)));
	const contentWidth = Math.max(1, physicalWidth - clampedPadding * 2);
	return Math.max(1, contentWidth - (clampedPadding ? 0 : 1));
}

/** A probe exposing the protected seam for one editor state. */
function canYield(editor: Editor, physicalWidth: number): boolean {
	const probe = editor as unknown as {
		canYieldDownAtLastVisualLine(expectedLayoutWidth: number): boolean;
	};
	return probe.canYieldDownAtLastVisualLine(layoutWidthFor(editor, physicalWidth));
}

/** Paint the frame so `lastWidth` matches the width the host classifies
 *  against — the seam's width guard must pass for a LIVE frame. */
function paint(editor: Editor, physicalWidth: number): void {
	editor.render(physicalWidth);
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";

describe("canYieldDownAtLastVisualLine (X063)", () => {
	it("is true for an empty editor at the only visual line of a live frame", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		paint(editor, 80);
		assert.strictEqual(canYield(editor, 80), true);
	});

	it("is true for a multiline draft whose cursor sits on the last visual line", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		// setText places the cursor at the END of the last line — the exact
		// state a composing user's draft is in.
		editor.setText("line1\nline2\nline3");
		paint(editor, 80);
		assert.deepStrictEqual(editor.getCursor(), { line: 2, col: 5 });
		assert.strictEqual(canYield(editor, 80), true);
	});

	it("is false on a NON-last visual line of a hard-multiline draft, true after Down reaches the bottom", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setTextAndCursor("line1\nline2\nline3", { line: 0, col: 0 });
		paint(editor, 80);
		assert.strictEqual(canYield(editor, 80), false);
		editor.handleInput(DOWN);
		assert.strictEqual(canYield(editor, 80), false);
		editor.handleInput(DOWN);
		assert.strictEqual(canYield(editor, 80), true);
	});

	it("is false in the middle of a SOFT-WRAPPED logical line, true on its last segment", () => {
		const editor = new Editor(createTestTUI(40), defaultEditorTheme);
		const long = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj";
		editor.setTextAndCursor(long, { line: 0, col: 0 });
		paint(editor, 40);
		// Walk Down to the very last visual segment of the wrapped line.
		let guard = 0;
		while (!canYield(editor, 40) && guard < 32) {
			editor.handleInput(DOWN);
			guard += 1;
		}
		assert.ok(guard > 0, "a long single logical line must wrap into several visual lines");
		assert.strictEqual(canYield(editor, 40), true);
		// One visual row up: same logical line, not the boundary any more.
		editor.handleInput(UP);
		assert.strictEqual(canYield(editor, 40), false);
	});

	it("is false while history browsing is active, and true again on the live draft", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.addToHistory("older entry");
		editor.addToHistory("newer entry");
		editor.setText("current draft");
		paint(editor, 80);
		// The draft's cursor is at the line end, so the FIRST Up jumps to the
		// line start (col 0) and only the SECOND enters history browse — the
		// exact two-press cadence a real user performs.
		editor.handleInput(UP);
		assert.strictEqual(editor.getText(), "current draft");
		editor.handleInput(UP); // enter browse (newer entry)
		assert.strictEqual(editor.getText(), "newer entry");
		assert.strictEqual(canYield(editor, 80), false);
		// Down inside browse walks back to the LIVE draft (the fork's own
		// bottom-entry behavior — the same key the seam gates on).
		editor.handleInput(DOWN);
		assert.strictEqual(editor.getText(), "current draft");
		assert.strictEqual(canYield(editor, 80), true);
	});

	it("is false while an autocomplete dropdown is open", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setAutocompleteProvider({
			getSuggestions: async () => ({
				items: [{ value: "/help", label: "/help", description: "" }],
				prefix: "/h",
			}),
			applyCompletion: (lines, cursorLine, cursorCol, item, prefix) => {
				const line = lines[cursorLine] || "";
				const before = line.slice(0, cursorCol - prefix.length);
				const after = line.slice(cursorCol);
				const newLines = [...lines];
				newLines[cursorLine] = before + item.value + after;
				return { lines: newLines, cursorLine, cursorCol: cursorCol - prefix.length + item.value.length };
			},
		});
		paint(editor, 80);
		editor.handleInput("/");
		await new Promise((resolve) => setImmediate(resolve));
		editor.handleInput("h");
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(editor.isShowingAutocomplete(), "the dropdown must be open for this witness");
		assert.strictEqual(canYield(editor, 80), false);
		editor.handleInput("\x1b"); // close the dropdown
		assert.strictEqual(canYield(editor, 80), true);
	});

	it("is false while jump mode is armed", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setText("hello world");
		paint(editor, 80);
		editor.handleInput("\x1d"); // Ctrl+] arms forward jump mode
		assert.strictEqual(canYield(editor, 80), false);
		editor.handleInput("\x1d"); // Ctrl+] cancels jump mode
		assert.strictEqual(canYield(editor, 80), true);
	});

	it("is false while a bracketed paste is being captured, and true after it completes", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		paint(editor, 80);
		editor.handleInput("\x1b[200~pasted body");
		assert.strictEqual(canYield(editor, 80), false);
		editor.handleInput("\x1b[201~");
		assert.strictEqual(canYield(editor, 80), true);
		assert.strictEqual(editor.getText(), "pasted body");
	});

	it("is false when the caller width does not match the painted frame", () => {
		const editor = new Editor(createTestTUI(60), defaultEditorTheme);
		paint(editor, 60);
		assert.strictEqual(canYield(editor, 60), true);
		assert.strictEqual(canYield(editor, 80), false, "a stale width must not classify");
		// Repainting at the new width re-syncs `lastWidth`.
		paint(editor, 80);
		assert.strictEqual(canYield(editor, 80), true);
	});

	it("does not consume or change anything: the real Down still moves the cursor", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setTextAndCursor("line1\nline2", { line: 0, col: 0 });
		paint(editor, 80);
		const textBefore = editor.getText();
		const cursorBefore = editor.getCursor();
		assert.strictEqual(canYield(editor, 80), false);
		editor.handleInput(DOWN);
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });
		assert.strictEqual(editor.getText(), textBefore);
		assert.notDeepStrictEqual(editor.getCursor(), cursorBefore);
	});
});
