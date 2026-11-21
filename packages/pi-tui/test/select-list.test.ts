import assert from "node:assert";
import { describe, it } from "node:test";
import { SelectList } from "../src/components/select-list.ts";
import { visibleWidth } from "../src/utils.ts";

const testTheme = {
	selectedPrefix: (text: string) => text,
	selectedText: (text: string) => text,
	description: (text: string) => text,
	scrollInfo: (text: string) => text,
	noMatch: (text: string) => text,
};

const visibleIndexOf = (line: string, text: string): number => {
	const index = line.indexOf(text);
	assert.notEqual(index, -1);
	return visibleWidth(line.slice(0, index));
};

describe("SelectList", () => {
	it("normalizes multiline descriptions to single line", () => {
		const items = [
			{
				value: "test",
				label: "test",
				description: "Line one\nLine two\nLine three",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(100);

		assert.ok(rendered.length > 0);
		assert.ok(!rendered[0].includes("\n"));
		assert.ok(rendered[0].includes("Line one Line two Line three"));
	});

	it("keeps descriptions aligned when the primary text is truncated", () => {
		const items = [
			{ value: "short", label: "short", description: "short description" },
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "long description",
			},
		];

		const list = new SelectList(items, 5, testTheme);
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "short description"), visibleIndexOf(rendered[1], "long description"));
	});

	it("uses the configured minimum primary column width", () => {
		const items = [
			{ value: "a", label: "a", description: "first" },
			{ value: "bb", label: "bb", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(rendered[0].indexOf("first"), 14);
		assert.equal(rendered[1].indexOf("second"), 14);
	});

	it("uses the configured maximum primary column width", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 20,
		});
		const rendered = list.render(80);

		assert.equal(visibleIndexOf(rendered[0], "first"), 22);
		assert.equal(visibleIndexOf(rendered[1], "second"), 22);
	});

	it("allows overriding primary truncation while preserving description alignment", () => {
		const items = [
			{
				value: "very-long-command-name-that-needs-truncation",
				label: "very-long-command-name-that-needs-truncation",
				description: "first",
			},
			{ value: "short", label: "short", description: "second" },
		];

		const list = new SelectList(items, 5, testTheme, {
			minPrimaryColumnWidth: 12,
			maxPrimaryColumnWidth: 12,
			truncatePrimary: ({ text, maxWidth }) => {
				if (text.length <= maxWidth) {
					return text;
				}

				return `${text.slice(0, Math.max(0, maxWidth - 1))}…`;
			},
		});
		const rendered = list.render(80);

		assert.ok(rendered[0].includes("…"));
		assert.equal(visibleIndexOf(rendered[0], "first"), visibleIndexOf(rendered[1], "second"));
	});

	it("moves by one visible page with selection page keys (#7629)", () => {
		const items = Array.from({ length: 12 }, (_, index) => ({ value: `item-${index}`, label: `Item ${index}` }));
		const list = new SelectList(items, 5, testTheme);
		const selections: string[] = [];
		list.onSelectionChange = (item) => selections.push(item.value);

		for (const key of ["\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[6~", "\x1b[5~"]) list.handleInput(key);

		assert.deepStrictEqual(selections, ["item-5", "item-10", "item-11", "item-6"]);

		list.setFilter("no match");
		list.handleInput("\x1b[6~");
		assert.deepStrictEqual(selections, ["item-5", "item-10", "item-11", "item-6"]);
	});
});

describe("SelectList mouse parity (last-painted rows)", () => {
	const mouse = (type: "press" | "click", y: number, width = 40, height = 5) => ({
		type,
		button: "left" as const,
		x: 1,
		y,
		screenX: 1,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...(type === "click" ? { clickCount: 1 } : {}),
	});

	it("hits the last-painted row, not the live visible range (no repaint)", () => {
		const items = Array.from({ length: 12 }, (_, i) => ({ value: `item-${i}`, label: `Item ${i}` }));
		const list = new SelectList(items, 5, testTheme);
		const selected: string[] = [];
		list.onSelectionChange = (item) => selected.push(item.value);
		// Last paint: selectedIndex 0 → row 0 = item-0.
		list.render(40);
		// Live state moves the selection WITHOUT a repaint: the visible
		// range now centers on item-6, but the user still sees item-0 on
		// row 0. The press must resolve to the PAINTED item, never a
		// re-derived live range.
		list.setSelectedIndex(6);
		const press = list.handleMouse(mouse("press", 0));
		assert.strictEqual(press?.handled, true);
		assert.strictEqual(list.getSelectedItem()?.value, "item-0", "the press must hit the last-painted row");
		assert.deepStrictEqual(selected, ["item-0"]);
	});

	it("does not transfer a pressed item to whatever repainted into its row", () => {
		const items = [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
			{ value: "c", label: "C" },
		];
		const list = new SelectList(items, 5, testTheme);
		let selected: string | undefined;
		list.onSelect = (item) => {
			selected = item.value;
		};
		list.render(40); // row 0 = A
		// Press A.
		list.handleMouse(mouse("press", 0));
		// The filter changes and repaints: row 0 is now B.
		list.setFilter("b");
		list.render(40);
		// Release on the same physical cell: the synthesized click must
		// NOT activate B — only the exact pressed identity may fire.
		list.handleMouse(mouse("click", 0));
		assert.strictEqual(selected, undefined, "the repainted row must not receive the pressed item's click");
	});

	it("retires a pressed row when an effective wheel moves the selection (X079)", () => {
		const items = Array.from({ length: 6 }, (_, i) => ({ value: `item-${i}`, label: `Item ${i}` }));
		const list = new SelectList(items, 5, testTheme);
		let applied: string | undefined;
		list.onSelect = (item) => {
			applied = item.value;
		};
		list.render(40); // row 0 = item-0, row 1 = item-1 (selection 0)
		list.handleMouse(mouse("press", 0));
		// An effective wheel notch moves the selection to item-1 while the
		// painted window keeps its start: row 0 still shows item-0.
		list.handleMouse({
			type: "wheel",
			button: "none",
			x: 1,
			y: 1,
			screenX: 1,
			screenY: 1,
			width: 40,
			height: 5,
			wheelDelta: 1,
			shift: false,
			alt: false,
			ctrl: false,
		});
		assert.strictEqual(list.getSelectedItem()?.value, "item-1", "the wheel moved the live selection");
		list.render(40);
		// The same-cell release on the still-painted pressed row must NOT
		// activate the pre-wheel item.
		list.handleMouse(mouse("click", 0));
		assert.strictEqual(applied, undefined, "the stale pressed item must not be activated after an effective wheel");
		// A fresh gesture on the newly selected row still applies.
		list.handleMouse(mouse("press", 1));
		list.handleMouse(mouse("click", 1));
		assert.strictEqual(applied, "item-1", "a fresh click still applies the live selection");
	});

	it("keeps a pressed row across a boundary wheel that cannot move (X079)", () => {
		const items = Array.from({ length: 3 }, (_, i) => ({ value: `item-${i}`, label: `Item ${i}` }));
		const list = new SelectList(items, 5, testTheme);
		let applied: string | undefined;
		list.onSelect = (item) => {
			applied = item.value;
		};
		list.render(40);
		list.handleMouse(mouse("press", 0));
		// Wheel UP at the first item: selection clamps, nothing moves.
		list.handleMouse({
			type: "wheel",
			button: "none",
			x: 1,
			y: 0,
			screenX: 1,
			screenY: 0,
			width: 40,
			height: 5,
			wheelDelta: -1,
			shift: false,
			alt: false,
			ctrl: false,
		});
		list.handleMouse(mouse("click", 0));
		assert.strictEqual(applied, "item-0", "a zero-effect boundary wheel keeps the existing same-cell gesture");
	});

	it("clears the pressed identity when the filter empties the list", () => {
		const items = [
			{ value: "a", label: "A" },
			{ value: "b", label: "B" },
		];
		const list = new SelectList(items, 5, testTheme);
		let selected: string | undefined;
		list.onSelect = (item) => {
			selected = item.value;
		};
		list.render(40); // row 0 = A
		// Press A: the gesture latch is A.
		list.handleMouse(mouse("press", 0));
		// The filter empties the list and repaints: a press on the empty
		// screen is a fresh gesture and must REPLACE the old latch (the
		// TUI keeps the old press target when the empty press returns
		// undefined, so a later release on the same cell still
		// synthesizes a click).
		list.setFilter("zz");
		list.render(40);
		list.handleMouse(mouse("press", 0));
		// The filter restores and repaints: row 0 is A again.
		list.setFilter("");
		list.render(40);
		// A click without a fresh press on A must NOT activate it — the
		// empty-state press cleared the old latch.
		list.handleMouse(mouse("click", 0));
		assert.strictEqual(selected, undefined, "the empty-state press must clear the old latch");
	});
});
