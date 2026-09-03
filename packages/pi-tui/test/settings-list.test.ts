import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme, type RowBudgetAware } from "../src/components/settings-list.ts";
import type { Component } from "../src/tui.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

describe("SettingsList", () => {
	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});
});

describe("SettingsList setMaxRows (dsh-pi-tui extension)", () => {
	it("keeps the selected row and hint when a long description exceeds a small budget", () => {
		const rows = Array.from({ length: 12 }, (_, index) => ({
			id: `setting-${index}`,
			label: `setting ${index}`,
			currentValue: "on",
			values: ["on", "off"],
			// A long description wraps to several rows: unaccounted by the
			// item-window budget, it must be capped so the hint survives.
			description: "this row has a long description that wraps " + "across many lines ".repeat(6),
		}));
		const list = new SettingsList(rows, 10, testTheme, () => {}, () => {});
		list.setMaxRows(8);
		const rendered = list.render(80);
		assert.ok(rendered.length <= 8, `settings list must fit the grant (${rendered.length})`);
		assert.ok(rendered.some((line) => line.includes("Esc to cancel")), "hint must remain visible");
		assert.ok(rendered.some((line) => line.includes("setting 0")), "selected row must remain visible");
	});

	it("keeps the hint with search enabled under a small budget", () => {
		const rows = Array.from({ length: 12 }, (_, index) => ({
			id: `setting-${index}`,
			label: `setting ${index}`,
			currentValue: "on",
		}));
		const list = new SettingsList(rows, 10, testTheme, () => {}, () => {}, { enableSearch: true });
		list.setMaxRows(6);
		const rendered = list.render(80);
		assert.ok(rendered.length <= 6, `searchable settings list must fit the grant (${rendered.length})`);
		assert.ok(rendered.some((line) => line.includes("Esc to cancel")), "hint must remain visible");
	});

	it("keeps the hint tail on a degenerate 5-row searchable grant", () => {
		const rows = Array.from({ length: 12 }, (_, index) => ({
			id: `setting-${index}`,
			label: `setting ${index}`,
			currentValue: "on",
		}));
		const list = new SettingsList(rows, 10, testTheme, () => {}, () => {}, { enableSearch: true });
		// 5-row grant: search prefix(2) + one item + indicator(1) + hint(2)
		// already exceed it; the tail slice must keep the hint and the
		// selected row rather than the search box (settings is always
		// search-enabled, so this is the host-reachable ≤7-row terminal).
		list.setMaxRows(5);
		const rendered = list.render(80);
		assert.ok(rendered.length <= 5, `settings list must fit the grant (${rendered.length})`);
		assert.ok(rendered.some((line) => line.includes("Esc to cancel")), "hint must survive the tail slice");
		assert.ok(rendered.some((line) => line.includes("setting 0")), "selected row must survive the tail slice");
	});

	it("restores the full window after moving off a described row (no render-time ratchet)", () => {
		const rows = Array.from({ length: 12 }, (_, index) => ({
			id: `setting-${index}`,
			label: `setting ${index}`,
			currentValue: "on",
			// Only the FIRST row carries a long description, so selecting it
			// shrinks the window; moving to a plain row must restore it.
			description: index === 0 ? "a long description " + "that wraps ".repeat(40) : undefined,
		}));
		const list = new SettingsList(rows, 10, testTheme, () => {}, () => {});
		list.setMaxRows(10); // budget: no search prefix + indicator 1 + hint 2 -> 7
		list.render(80);
		for (let index = 0; index < 5; index++) list.handleInput("\x1b[B"); // -> setting 5 (no description)
		const rendered = list.render(80);
		assert.ok(rendered.some((line) => line.includes("setting 5")), "selected row must be visible");
		assert.ok(rendered.some((line) => line.includes("setting 8")),
			`the full window must return after moving off the described row (${JSON.stringify(rendered)})`);
	});

	it("forwards the row grant to an open submenu that accepts it", () => {
		const received: number[] = [];
		const child = { setMaxRows: (rows: number) => { received.push(rows); } } as unknown as RowBudgetAware;
		const list = new SettingsList(
			[{
				id: "a",
				label: "Alpha",
				currentValue: "",
				submenu: () => child as unknown as Component,
			}],
			5,
			testTheme,
			() => {},
			() => {},
		);
		list.handleInput("\r"); // Enter: open the submenu
		assert.deepStrictEqual(received, [Number.POSITIVE_INFINITY], "submenu must inherit the grant at open");
		list.setMaxRows(8);
		assert.deepStrictEqual(received, [Number.POSITIVE_INFINITY, 8], "a grant change must reach the open submenu");
		list.setMaxRows(12);
		assert.deepStrictEqual(received, [Number.POSITIVE_INFINITY, 8, 12], "every grant change must forward");
	});

	it("fits the no-match state to a small searchable grant", () => {
		const rows = [
			{ id: "a", label: "alpha", currentValue: "on" },
			{ id: "b", label: "beta", currentValue: "on" },
		];
		const list = new SettingsList(rows, 10, testTheme, () => {}, () => {}, { enableSearch: true });
		list.setMaxRows(4); // search 2 + message 1 + hint 2 = 5 > 4
		list.handleInput("z"); // no match
		const rendered = list.render(80);
		assert.ok(rendered.length <= 4, `no-match must fit the grant (${rendered.length})`);
		assert.ok(rendered.some((line) => line.includes("No matching settings")), "message must survive");
		assert.ok(rendered.some((line) => line.includes("Esc to cancel")), "hint must survive");
	});
});
