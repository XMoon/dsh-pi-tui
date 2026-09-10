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
			description: index === 0 ? "a long description " + "that wraps ".repeat(3) : undefined,
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

describe("SettingsList mouse parity (last-painted rows)", () => {
	const mouse = (type: "press" | "click", y: number, width = 80, height = 6) => ({
		type,
		button: "left" as const,
		x: 2,
		y,
		screenX: 2,
		screenY: y,
		width,
		height,
		shift: false,
		alt: false,
		ctrl: false,
		...(type === "click" ? { clickCount: 1 } : {}),
	});

	it("activates the item the user actually saw when the description shrinks the window (Case A)", () => {
		const rows = Array.from({ length: 8 }, (_, index) => ({
			id: `setting-${index}`,
			label: `setting ${index}`,
			currentValue: "on",
			values: ["on", "off"],
			description: index === 0 ? "a long description " + "that wraps ".repeat(3) : undefined,
		}));
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(rows, 10, testTheme, (id, value) => changes.push({ id, value }), () => {});
		list.setMaxRows(10);
		const rendered = list.render(30);
		// The description shrink must have reduced the window below maxVisible.
		const itemRows = rendered
			.map((line, row) => ({ row, id: /setting (\d+)/.exec(line)?.[1] }))
			.filter((entry): entry is { row: number; id: string } => entry.id !== undefined);
		assert.ok(itemRows.length >= 2, `at least two items must render:\n${rendered.join("\n")}`);
		// Clicking each PAINTED row must activate the item on THAT row.
		for (const { row, id } of itemRows) {
			changes.length = 0;
			list.handleMouse(mouse("press", row));
			list.handleMouse(mouse("click", row));
			assert.deepStrictEqual(
				changes,
				[{ id: `setting-${id}`, value: "off" }],
				`row ${row} must activate setting-${id} (the painted row), not a re-derived range:\n${rendered.join("\n")}`,
			);
		}
	});

	it("keeps the row offset correct with search enabled + shrink (Case B)", () => {
		const rows = Array.from({ length: 8 }, (_, index) => ({
			id: `setting-${index}`,
			label: `setting ${index}`,
			currentValue: "on",
			values: ["on", "off"],
			description: index === 0 ? "a long description " + "that wraps ".repeat(3) : undefined,
		}));
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(rows, 10, testTheme, (id, value) => changes.push({ id, value }), () => {}, {
			enableSearch: true,
		});
		list.setMaxRows(10);
		const rendered = list.render(60);
		const itemRows = rendered
			.map((line, row) => ({ row, id: /setting (\d+)/.exec(line)?.[1] }))
			.filter((entry): entry is { row: number; id: string } => entry.id !== undefined);
		assert.ok(itemRows.length >= 2, `at least two items must render:\n${rendered.join("\n")}`);
		for (const { row, id } of itemRows) {
			changes.length = 0;
			list.handleMouse(mouse("press", row));
			list.handleMouse(mouse("click", row));
			assert.deepStrictEqual(
				changes,
				[{ id: `setting-${id}`, value: "off" }],
				`searchable row ${row} must activate setting-${id}:\n${rendered.join("\n")}`,
			);
		}
	});

	it("keeps search blank, description rows, indicator and hint inert (Case C)", () => {
		const rows = Array.from({ length: 8 }, (_, index) => ({
			id: `setting-${index}`,
			label: `setting ${index}`,
			currentValue: "on",
			values: ["on", "off"],
			description: index === 0 ? "a long description " + "that wraps ".repeat(3) : undefined,
		}));
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(rows, 10, testTheme, (id, value) => changes.push({ id, value }), () => {}, {
			enableSearch: true,
		});
		list.setMaxRows(8);
		const rendered = list.render(80);
		const inertRows = rendered
			.map((line, row) => ({ row, line }))
			.filter(({ line }) => !/setting \d+/.test(line));
		assert.ok(inertRows.length >= 2, `inert rows must exist:\n${rendered.join("\n")}`);
		for (const { row } of inertRows) {
			changes.length = 0;
			const press = list.handleMouse(mouse("press", row));
			if (press !== undefined) {
				list.handleMouse(mouse("click", row));
			}
			assert.deepStrictEqual(changes, [], `row ${row} (${JSON.stringify(rendered[row])}) must be inert`);
		}
	});

	it("keeps the sliced-away search input out of mouse reach on a degenerate grant (Case E)", () => {
		const rows = Array.from({ length: 12 }, (_, index) => ({
			id: `setting-${index}`,
			label: `setting ${index}`,
			currentValue: "on",
			values: ["on", "off"],
		}));
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(rows, 10, testTheme, (id, value) => changes.push({ id, value }), () => {}, {
			enableSearch: true,
		});
		// Same fixture as the "degenerate 5-row searchable grant" render
		// test: search prefix(2) + item + indicator(1) + hint(2) exceed the
		// grant, so the tail slice drops the search box and keeps the
		// selected row + hint. The search Input is NOT painted.
		list.setMaxRows(5);
		const rendered = list.render(80);
		assert.ok(rendered.length <= 5, `the grant must hold (${rendered.length})`);
		assert.ok(rendered.some((line) => line.includes("setting 0")), "the selected row must survive the slice");
		// A press on the row that replaced the search box must NOT reach the
		// hidden search Input: no handled result, no focus claim — otherwise
		// the TUI would focus the list and subsequent typing would filter it
		// through a search box the user cannot see (last-painted fence).
		assert.strictEqual(
			list.handleMouse(mouse("press", 0)),
			undefined,
			"the sliced-away search row must be mouse-inert",
		);
		assert.strictEqual(list.handleMouse(mouse("click", 0)), undefined, "the click must not be handled either");
		assert.deepStrictEqual(changes, [], "nothing may be activated");
		// The item row that survived the slice stays clickable through the
		// same final-painted map.
		list.handleMouse(mouse("press", 1));
		list.handleMouse(mouse("click", 1));
		assert.deepStrictEqual(changes, [{ id: "setting-0", value: "off" }], "the surviving item row must stay clickable");
	});

	it("replaces the pressed identity on a delegated search press (no stale-latch activation)", () => {
		const rows = [
			{ id: "a", label: "A", currentValue: "on", values: ["on", "off"] },
			{ id: "b", label: "B", currentValue: "on", values: ["on", "off"] },
		];
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(rows, 10, testTheme, (id, value) => changes.push({ id, value }), () => {}, {
			enableSearch: true,
		});
		const state = list as unknown as { mousePressedId: string | undefined };
		list.render(80); // search y=0, blank y=1, item A y=2
		// 1. Press item A: the gesture latch is A.
		list.handleMouse(mouse("press", 2));
		assert.strictEqual(state.mousePressedId, "a");
		// 2. Press the search row: the Input handles it (handled+focus), but
		//    the parent's gesture identity must be REPLACED — a delegated
		//    press is a fresh gesture, not a continuation of the item press.
		list.handleMouse(mouse("press", 0));
		assert.strictEqual(state.mousePressedId, undefined, "a delegated search press must clear the old latch");
		// 3. The terminal shrinks between press and release: the tail slice
		//    drops the search box and item A moves to physical row 0.
		list.setMaxRows(4);
		list.render(80);
		// 4. Release on the same physical cell: the TUI synthesizes a click
		//    on row 0 — the stale latch (A) must NOT activate the item that
		//    moved onto the pressed cell.
		list.handleMouse(mouse("click", 0));
		assert.deepStrictEqual(changes, [], "the stale pressed identity must not activate the moved item");
	});

	it("clears the pressed identity on an inert-row press", () => {
		const rows = [
			{ id: "a", label: "A", currentValue: "on", values: ["on", "off"] },
			{ id: "b", label: "B", currentValue: "on", values: ["on", "off"] },
		];
		const list = new SettingsList(rows, 10, testTheme, () => {}, () => {}, { enableSearch: true });
		const state = list as unknown as { mousePressedId: string | undefined };
		list.render(80);
		list.handleMouse(mouse("press", 2)); // item A
		assert.strictEqual(state.mousePressedId, "a");
		list.handleMouse(mouse("press", 1)); // inert blank row
		assert.strictEqual(state.mousePressedId, undefined, "an inert-row press must clear the old latch");
	it("a main-list press cannot transfer into a newly-created submenu (mouse parity)", () => {
		const actions: string[] = [];
		const submenu = {
			render: () => ["submenu row"],
			invalidate: () => {},
			handleMouse: (event: import("../src/tui.ts").TuiMouseEvent) => {
				if (event.type === "press") return { handled: true };
				if (event.type === "click") {
					actions.push("submenu action");
					return { handled: true };
				}
				return undefined;
			},
		};
		const list = new SettingsList(
			[{ id: "s", label: "S", currentValue: "on", values: ["on", "off"], submenu: () => submenu }],
			10,
			testTheme,
			() => {},
			() => {},
		);
		list.render(80);
		console.log('DEBUG submenu test start');
		// Press the submenu row (main list): the press-time owner is the
		// main list at the current submenu generation.
		list.handleMouse(mouse("press", 0));
		// Keyboard Enter opens the submenu (generation advances).
		list.handleInput("\r");
		// Release + click on the same cell WITHOUT a repaint: the
		// newly-created submenu must NOT receive a fresh-looking activation
		// (it never got its own press).
		list.handleMouse(mouse("release", 0));
		list.handleMouse(mouse("click", 0));
		assert.deepStrictEqual(actions, [], "the newly-created submenu must not receive the stale main-list press");
		// A fresh press+click on the submenu works.
		list.handleMouse(mouse("press", 0));
		list.handleMouse(mouse("click", 0));
		assert.deepStrictEqual(actions, ["submenu action"], "a fresh submenu press must activate");
	});
	});
});

	it("keeps the mouse map in lockstep with the tail slice on a degenerate grant (Case D)", () => {
		const rows = Array.from({ length: 6 }, (_, index) => ({
			id: `setting-${index}`,
			label: `setting ${index}`,
			currentValue: "on",
			values: ["on", "off"],
		}));
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(rows, 10, testTheme, (id, value) => changes.push({ id, value }), () => {});
		// A 3-row grant with 6 items: the final painted output is the
		// scroll indicator + hint tail — the item rows are sliced away.
		list.setMaxRows(3);
		const rendered = list.render(80);
		assert.ok(rendered.length <= 3, `the grant must hold (${rendered.length})`);
		// The visible rows (indicator + hints) must be mouse-inert: a
		// press+click on row 0 must NOT activate a removed item.
		list.handleMouse({ type: "press", button: "left", x: 2, y: 0, screenX: 2, screenY: 0, width: 80, height: 3, shift: false, alt: false, ctrl: false });
		list.handleMouse({ type: "click", button: "left", x: 2, y: 0, screenX: 2, screenY: 0, width: 80, height: 3, shift: false, alt: false, ctrl: false, clickCount: 1 });
		assert.deepStrictEqual(changes, [], "the sliced-away item rows must not be clickable");
	});

	it("releases the pressed identity on click mismatch (no ghost accept without a fresh press)", () => {
		const rows = [
			{ id: "a", label: "A", currentValue: "on", values: ["on", "off"] },
			{ id: "b", label: "B", currentValue: "on", values: ["on", "off"] },
		];
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(rows, 10, testTheme, (id, value) => changes.push({ id, value }), () => {});
		list.render(80);
		// Press row 0 (item A).
		list.handleMouse({ type: "press", button: "left", x: 2, y: 0, screenX: 2, screenY: 0, width: 80, height: 4, shift: false, alt: false, ctrl: false });
		// The live items change WITHOUT a repaint: A is gone, B moves to
		// row 0. The release click on row 0 mismatches (pressed A vs row B)
		// and must RELEASE the pressed identity.
		const state = list as unknown as { items: Array<{ id: string }>; mousePressedId: string | undefined };
		state.items = [{ id: "b", label: "B", currentValue: "on", values: ["on", "off"] }];
		list.handleMouse({ type: "click", button: "left", x: 2, y: 0, screenX: 2, screenY: 0, width: 80, height: 4, shift: false, alt: false, ctrl: false, clickCount: 1 });
		assert.strictEqual(state.mousePressedId, undefined, "the pressed identity must be released on mismatch");
		assert.deepStrictEqual(changes, [], "the mismatched click must not activate anything");
		// A later click WITHOUT a fresh press must not activate (the
		// identity was released). A returns to row 0: without the release
		// the stale pressed A would match and activate.
		state.items = [
			{ id: "a", label: "A", currentValue: "on", values: ["on", "off"] },
			{ id: "b", label: "B", currentValue: "on", values: ["on", "off"] },
		];
		list.render(80);
		list.handleMouse({ type: "click", button: "left", x: 2, y: 0, screenX: 2, screenY: 0, width: 80, height: 4, shift: false, alt: false, ctrl: false, clickCount: 1 });
		assert.deepStrictEqual(changes, [], "a click without a fresh press must not activate");
	});

