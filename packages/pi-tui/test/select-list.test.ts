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

	describe("search (dsh-pi-tui extension)", () => {
		it("renders a search input and filters labels by case-insensitive substring", () => {
			const items = [
				{ value: "session-a", label: "alpha", description: "first" },
				{ value: "session-b", label: "zulu", description: "second" },
				{ value: "session-c", label: "mike", description: "third" },
			];
			const list = new SelectList(items, 5, testTheme, {}, { enableSearch: true, header: "sessions" });

			let rendered = list.render(80);
			assert.ok(rendered.some((line) => line.includes("sessions")), "header missing");
			assert.ok(rendered.some((line) => line.includes("> ")), "search input missing");

			list.handleInput("a");
			rendered = list.render(80);
			assert.ok(rendered.some((line) => line.includes("alpha")), "alpha should match 'a'");
			assert.ok(!rendered.some((line) => line.includes("zulu")), "zulu should not match 'a'");

			// Case-insensitive: 'Z' matches 'zulu'
			list.handleInput("\b");
			list.handleInput("Z");
			rendered = list.render(80);
			assert.ok(rendered.some((line) => line.includes("zulu")), "zulu should match 'Z'");
			assert.ok(!rendered.some((line) => line.includes("alpha")), "alpha should not match 'Z'");
		});

		it("filters by description and value text", () => {
			const items = [
				{ value: "session-abc-111", label: "one", description: "rewrite footer" },
				{ value: "session-xyz-222", label: "two", description: "add search" },
			];
			const list = new SelectList(items, 5, testTheme, {}, { enableSearch: true });

			list.handleInput("rewrite");
			let rendered = list.render(80);
			assert.ok(rendered.some((line) => line.includes("one")), "description match missed");

			for (let i = 0; i < 7; i++) list.handleInput("\b");
			list.handleInput("xyz");
			rendered = list.render(80);
			assert.ok(rendered.some((line) => line.includes("two")), "value match missed");
		});

		it("selects the filtered item on Enter", () => {
			const items = [
				{ value: "a", label: "alpha" },
				{ value: "b", label: "beta" },
			];
			const list = new SelectList(items, 5, testTheme, {}, { enableSearch: true });
			const selected: string[] = [];
			list.onSelect = (item) => { selected.push(item.value); };

			list.handleInput("b");
			list.handleInput("\r");
			assert.deepEqual(selected, ["b"]);
		});

		it("re-applies the active query when items are replaced", () => {
			const list = new SelectList([{ value: "a", label: "alpha" }], 5, testTheme, {}, { enableSearch: true });
			list.handleInput("beta");
			let rendered = list.render(80);
			assert.ok(rendered.some((line) => line.includes("No matching")), "expected no-match before setItems");

			list.setItems([
				{ value: "a", label: "alpha" },
				{ value: "b", label: "beta" },
			]);
			rendered = list.render(80);
			assert.ok(rendered.some((line) => line.includes("beta")), "setItems did not re-filter");
			assert.ok(!rendered.some((line) => line.includes("alpha")), "setItems kept non-matching item");
		});

		it("shows filtered/total counts in the header", () => {
			const list = new SelectList(
				[{ value: "a", label: "alpha" }, { value: "b", label: "zulu" }, { value: "c", label: "mike" }],
				5,
				testTheme,
				{},
				{ enableSearch: true, header: "sessions" },
			);
			list.handleInput("z");
			const rendered = list.render(80);
			assert.ok(rendered.some((line) => line.includes("1/3")), `counts missing: ${JSON.stringify(rendered)}`);
		});

		it("renders a hint footer when search is enabled", () => {
			const list = new SelectList([{ value: "a", label: "alpha" }], 5, testTheme, {}, { enableSearch: true });
			const rendered = list.render(80);
			assert.ok(rendered.some((line) => line.includes("type to filter")), "hint missing");
		});

		it("keeps the compact height without hints for inline usage", () => {
			const list = new SelectList([{ value: "a", label: "alpha" }], 5, testTheme);
			const rendered = list.render(80);
			assert.ok(!rendered.some((line) => line.includes("navigate")), "hint must not render by default");
		});
	});

	describe("group headers (dsh-pi-tui extension)", () => {
		it("renders a header with the group count before each group", () => {
			const items = [
				{ value: "a", label: "alpha", group: "me/dsh-pi-tui" },
				{ value: "b", label: "beta", group: "me/dsh-pi-tui" },
				{ value: "c", label: "gamma", group: "work/atlasx" },
			];
			const list = new SelectList(items, 5, testTheme);
			const rendered = list.render(80);
			const header1 = rendered.findIndex((line) => line.includes("me/dsh-pi-tui"));
			const header2 = rendered.findIndex((line) => line.includes("work/atlasx"));
			assert.notEqual(header1, -1, "first group header missing");
			assert.notEqual(header2, -1, "second group header missing");
			assert.ok(rendered[header1].includes("· 2"), `first group count missing: ${rendered[header1]}`);
			assert.ok(rendered[header2].includes("· 1"), `second group count missing: ${rendered[header2]}`);
			assert.ok(header1 < rendered.findIndex((line) => line.includes("alpha")), "header after its items");
			assert.ok(rendered.findIndex((line) => line.includes("alpha")) < header2, "header before next group");
		});

		it("uses the groupHeader theme when provided", () => {
			const styled: string[] = [];
			const themeWithGroup = {
				...testTheme,
				groupHeader: (text: string) => { styled.push(text); return text; },
			};
			const list = new SelectList(
				[{ value: "a", label: "alpha", group: "g" }],
				5,
				themeWithGroup,
			);
			list.render(80);
			assert.equal(styled.length, 1);
			assert.ok(styled[0].includes("g"));
		});
	});

	describe("page keys (dsh-pi-tui extension)", () => {
		it("pageDown moves the selection by one visible page", () => {
			const items = Array.from({ length: 20 }, (_, i) => ({ value: String(i), label: `item-${i}` }));
			const list = new SelectList(items, 5, testTheme);
			list.handleInput("\x1b[6~"); // pageDown
			assert.equal(list.getSelectedItem()?.value, "5");
			list.handleInput("\x1b[6~");
			assert.equal(list.getSelectedItem()?.value, "10");
			list.handleInput("\x1b[5~"); // pageUp
			assert.equal(list.getSelectedItem()?.value, "5");
		});
	});
});
