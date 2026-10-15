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

	it("notifies 'navigation' on visual-cursor transitions (Up/Down/Page always; the host reads the state itself)", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setTextAndCursor("line1\nline2", { line: 0, col: 0 });
		paint(editor, 80);
		const events: string[] = [];
		editor.onVisualLineBoundaryChanged = (reason) => {
			events.push(reason);
		};
		const probe = editor as unknown as { isOnLastVisualLine(): boolean };
		// Down crosses ONTO the last visual line: notify 'navigation'.
		editor.handleInput(DOWN);
		assert.deepStrictEqual(events, ["navigation"], "the crossing Down notifies navigation");
		assert.strictEqual(probe.isOnLastVisualLine(), true, "the state after the move is the last line");
		// A no-op Down at the bottom STILL dispatches: the admission fact may
		// not have moved but the move ran — the host re-reads the live facts.
		editor.handleInput(DOWN);
		assert.deepStrictEqual(events, ["navigation", "navigation"], "the bottom Down still dispatches");
		// An intra-line Left (line-end → mid-line) dispatches too (the event
		// is cheap for the host to drop; no wrap-map budget is spent twice).
		editor.handleInput("\x1b[D");
		assert.deepStrictEqual(events, ["navigation", "navigation", "navigation"], "an intra-line Left dispatches navigation");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 4 });
		// PageDown dispatches (a viewport-page move).
		editor.handleInput("\x1b[6~");
		assert.deepStrictEqual(events, ["navigation", "navigation", "navigation", "navigation"], "PageDown dispatches");
		assert.strictEqual(probe.isOnLastVisualLine(), true, "still on the last line after the page move");
		// Printable input never dispatches.
		editor.handleInput("x");
		assert.deepStrictEqual(events, ["navigation", "navigation", "navigation", "navigation"], "printable input does not dispatch");
	});

	it("Left/Right across a visual-line boundary notify 'navigation' (the host re-reads the state)", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setTextAndCursor("line1\nline2", { line: 1, col: 0 });
		paint(editor, 80);
		const events: string[] = [];
		editor.onVisualLineBoundaryChanged = (reason) => {
			events.push(reason);
		};
		const probe = editor as unknown as { isOnLastVisualLine(): boolean };
		assert.strictEqual(probe.isOnLastVisualLine(), true);
		// Left from the second line's start wraps back to the first line's
		// end: OFF the last visual line.
		editor.handleInput("\x1b[D");
		assert.deepStrictEqual(events, ["navigation"], "the wrapping Left notifies navigation");
		assert.strictEqual(probe.isOnLastVisualLine(), false, "OFF the last line after the wrap");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		// Right from the first line's end wraps forward: ONTO the last
		// visual line again.
		editor.handleInput("\x1b[C");
		assert.deepStrictEqual(events, ["navigation", "navigation"], "the wrapping Right notifies navigation");
		assert.strictEqual(probe.isOnLastVisualLine(), true, "ON the last line after the wrap");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });
		// The intra-line walk (col0 → col1 → col0 on the LAST line) stays ON
		// the last line: the events still fire (cheap drop), the boundary
		// fact the host reads is unchanged.
		editor.handleInput("\x1b[C");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 1 });
		editor.handleInput("\x1b[D");
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });
		assert.strictEqual(probe.isOnLastVisualLine(), true, "the intra-line walk never leaves the last line");
		// The wrap-point Left (from the line START the walk landed on) wraps
		// back again — the boundary fact flips.
		editor.handleInput("\x1b[D");
		assert.deepStrictEqual(events, ["navigation", "navigation", "navigation", "navigation", "navigation"], "the wrap-point Left dispatches again");
		assert.deepStrictEqual(editor.getCursor(), { line: 0, col: 5 });
		assert.strictEqual(probe.isOnLastVisualLine(), false);
	});


	it("dispatches 'autocomplete' on the open flip and 'programmatic' on cursor/text replacement", () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		editor.setTextAndCursor("line1\nline2", { line: 1, col: 0 });
		paint(editor, 80);
		const events: string[] = [];
		editor.onVisualLineBoundaryChanged = (reason) => {
			events.push(reason);
		};
		// setCursor (programmatic): the boundary fact may move with no
		// keyboard event.
		editor.setCursor({ line: 0, col: 0 });
		assert.deepStrictEqual(events, ["programmatic"], "setCursor dispatches programmatic");
		// setTextAndCursor (programmatic replacement).
		editor.setTextAndCursor("a\nb", { line: 1, col: 0 });
		assert.deepStrictEqual(events, ["programmatic", "programmatic"], "setTextAndCursor dispatches programmatic");
		// The document/cursor are exactly what the host asked for.
		assert.deepStrictEqual(editor.getCursor(), { line: 1, col: 0 });
		assert.strictEqual(editor.getText(), "a\nb");
	});

	it("dispatches 'autocomplete' on the dropdown open AND close with an unchanged visual state", async () => {
		const editor = new Editor(createTestTUI(), defaultEditorTheme);
		const provider = {
			getSuggestions: async () => ({
				prefix: "/",
				items: [{ id: "t1", label: "tasks", description: "", prefix: "/", insertText: "tasks", value: "/tasks" } as never],
			}),
			applyCompletion: (lines: string[]) => ({ lines, cursorLine: lines.length - 1, cursorCol: 0 }),
		};
		editor.setAutocompleteProvider(provider as never);
		editor.setTextAndCursor("line1\n/", { line: 1, col: 1 });
		paint(editor, 80);
		const events: Array<{ reason: string; onLast: boolean }> = [];
		editor.onVisualLineBoundaryChanged = (reason, onLast) => {
			events.push({ reason, onLast });
		};
		const probe = editor as unknown as { isOnLastVisualLine(): boolean };
		assert.strictEqual(probe.isOnLastVisualLine(), true, "the cursor sits on the last visual line");
		editor.handleInput("a"); // refresh while closed: no open flip, no event
		assert.deepStrictEqual(events, [], "typing with no dropdown dispatches nothing");
		// Trigger the dropdown: the slash menu opens only on LINE 0 — use a
		// SINGLE-line document whose only line is both the first and the
		// LAST visual line: the visual state is trivially unchanged by the
		// open (the same-bool property the host's equality gate would have
		// collapsed).
		editor.setTextAndCursor("", { line: 0, col: 0 });
		events.length = 0;
		paint(editor, 80);
		editor.handleInput("/");
		await new Promise((resolve) => setTimeout(resolve, 120));
		assert.strictEqual(editor.isShowingAutocomplete(), true, "the '/' must open the dropdown");
		const openEvent = events.filter((e) => e.reason === "autocomplete").at(-1);
		assert.ok(openEvent, "the open flip dispatches 'autocomplete'");
		assert.strictEqual(openEvent.onLast, true, "the visual state is UNCHANGED (still the last line)");
		// Esc closes: the close flip dispatches 'autocomplete' again — same
		// visual truth, a DISTINCT event the host must not drop.
		events.length = 0;
		editor.handleInput("\x1b");
		assert.strictEqual(editor.isShowingAutocomplete(), false, "Esc closes the dropdown");
		const closeEvents = events.filter((e) => e.reason === "autocomplete");
		assert.ok(closeEvents.length >= 1, "the close dispatches 'autocomplete' (the TuiEditor head-cancel + the base branch may each fire; the host coalesces)");
	});
});
