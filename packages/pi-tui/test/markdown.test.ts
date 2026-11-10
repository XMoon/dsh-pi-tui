import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { Chalk } from "chalk";
import { Markdown, type MarkdownSourceCellProof, type MarkdownTheme } from "../src/components/markdown.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import type { Component, TUI } from "../src/tui.ts";
import { sliceByColumn, stripTerminalSequences } from "../src/utils.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultMarkdownTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

function getCell(terminal: VirtualTerminal, row: number, col: number) {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	assert.ok(line, `Missing buffer line at row ${row}`);
	const cell = line.getCell(col);
	assert.ok(cell, `Missing cell at row ${row} col ${col}`);
	return cell;
}

function stripAnsi(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function fgOpenAfterSgr(prev: boolean, params: string): boolean {
	if (params === "" || params === "0") {
		return false;
	}
	let open = prev;
	for (const part of params.split(";")) {
		const code = Number.parseInt(part, 10);
		if (code === 39) {
			open = false;
		} else if (code === 38 || (code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
			open = true; // 38;5;N / 38;2;R;G;B or standard 30-37 / bright 90-97
		}
	}
	return open;
}

/** Assert no box-drawing character is rendered while a foreground color is open. (dsh-pi-tui divergence X021.) */
function assertNoBordersInOpenFgColor(lines: string[]): void {
	const borderChar = /[│┌┐└┘├┤┬┴─]/;
	const sgrRegex = /\x1b\[([0-9;]*)m/g;
	for (const line of lines) {
		if (!borderChar.test(line)) {
			continue;
		}
		let fgOpen = false;
		let lastIndex = 0;
		let match: RegExpExecArray | null;
		sgrRegex.lastIndex = 0;
		while ((match = sgrRegex.exec(line)) !== null) {
			const plain = line.slice(lastIndex, match.index);
			if (fgOpen && borderChar.test(plain)) {
				assert.fail(`Border char rendered inside an open foreground color: ${JSON.stringify(line)}`);
			}
			lastIndex = sgrRegex.lastIndex;
			fgOpen = fgOpenAfterSgr(fgOpen, match[1]!);
		}
		const tail = line.slice(lastIndex);
		if (fgOpen && borderChar.test(tail)) {
			assert.fail(`Border char rendered inside an open foreground color: ${JSON.stringify(line)}`);
		}
	}
}

describe("Markdown component", () => {
	describe("Transforms", () => {
		it("caches transformed Markdown by source and available width", () => {
			const calls: Array<{ source: string; availableWidth: number }> = [];
			const markdown = new Markdown("source", 2, 0, defaultMarkdownTheme, undefined, {
				transform: (source, availableWidth) => {
					calls.push({ source, availableWidth });
					return `${source} ${availableWidth}`;
				},
			});

			assert.deepStrictEqual(
				markdown.render(80).map((line) => stripAnsi(line).trim()),
				["source 76"],
			);
			markdown.render(80);
			assert.deepStrictEqual(
				markdown.render(60).map((line) => stripAnsi(line).trim()),
				["source 56"],
			);
			assert.deepStrictEqual(calls, [
				{ source: "source", availableWidth: 76 },
				{ source: "source", availableWidth: 56 },
			]);

			markdown.setText("updated");
			assert.deepStrictEqual(
				markdown.render(60).map((line) => stripAnsi(line).trim()),
				["updated 56"],
			);
			assert.deepStrictEqual(calls.at(-1), { source: "updated", availableWidth: 56 });

			markdown.invalidate();
			markdown.render(60);
			assert.deepStrictEqual(calls.at(-1), { source: "updated", availableWidth: 56 });
			assert.strictEqual(calls.length, 4);
		});
	});

	describe("Block reuse", () => {
		afterEach(() => resetCapabilitiesCache());

		function countingTheme(calls: string[]): MarkdownTheme {
			return {
				...defaultMarkdownTheme,
				highlightCode: (code, lang) => {
					calls.push(`${lang}:${code}`);
					return code.split("\n").map((line) => chalk.green(line));
				},
			};
		}

		it("highlights a code block once across streamed text and resizes, and again after invalidate", () => {
			const calls: string[] = [];
			const markdown = new Markdown("```ts\nx\n```", 0, 0, countingTheme(calls));
			markdown.render(80);
			markdown.setText("```ts\nx\n```\n\nafter");
			markdown.render(40);
			assert.deepStrictEqual(calls, ["ts:x"]);
			markdown.invalidate();
			markdown.render(40);
			assert.deepStrictEqual(calls, ["ts:x", "ts:x"]);
		});

		it("holds rendered blocks weakly, so a full garbage collection releases them", async () => {
			setFlagsFromString("--expose-gc");
			const gc = runInNewContext("gc") as () => void;
			const calls: string[] = [];
			const markdown = new Markdown("```ts\nx\n```", 0, 0, countingTheme(calls));
			markdown.render(80);
			// A WeakRef keeps its target alive until the current job ends.
			await new Promise((resolve) => setImmediate(resolve));
			gc();
			markdown.render(40);
			assert.deepStrictEqual(calls, ["ts:x", "ts:x"]);
		});

		it("renders a block again when the block after it changes its spacing", () => {
			const markdown = new Markdown("# Title", 0, 0, defaultMarkdownTheme);
			markdown.render(80);
			markdown.setText("# Title\nfoo");
			assert.deepStrictEqual(
				markdown.render(80).map((line) => stripAnsi(line).trim()),
				["Title", "", "foo"],
			);
		});

		it("follows changed reference link definitions", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const markdown = new Markdown("[a][x]\n\n[x]: https://one.example", 0, 0, defaultMarkdownTheme);
			markdown.render(80);
			markdown.setText("[a][x]\n\n[x]: https://two.example");
			assert.ok(stripAnsi(markdown.render(80).join("\n")).includes("https://two.example"));
		});
	});

	describe("Lists", () => {
		it("should render simple nested list", () => {
			const markdown = new Markdown(
				`- Item 1
  - Nested 1.1
  - Nested 1.2
- Item 2`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			// Check that we have content
			assert.ok(lines.length > 0);

			// Strip ANSI codes for checking
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check structure
			assert.ok(plainLines.some((line) => line.includes("- Item 1")));
			assert.ok(plainLines.some((line) => line.includes("    - Nested 1.1")));
			assert.ok(plainLines.some((line) => line.includes("    - Nested 1.2")));
			assert.ok(plainLines.some((line) => line.includes("- Item 2")));
		});

		it("should render deeply nested list", () => {
			const markdown = new Markdown(
				`- Level 1
  - Level 2
    - Level 3
      - Level 4`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check proper indentation
			assert.ok(plainLines.some((line) => line.includes("- Level 1")));
			assert.ok(plainLines.some((line) => line.includes("    - Level 2")));
			assert.ok(plainLines.some((line) => line.includes("        - Level 3")));
			assert.ok(plainLines.some((line) => line.includes("            - Level 4")));
		});

		it("should render ordered nested list", () => {
			const markdown = new Markdown(
				`1. First
   1. Nested first
   2. Nested second
2. Second`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			assert.ok(plainLines.some((line) => line.includes("1. First")));
			assert.ok(plainLines.some((line) => line.includes("    1. Nested first")));
			assert.ok(plainLines.some((line) => line.includes("    2. Nested second")));
			assert.ok(plainLines.some((line) => line.includes("2. Second")));
		});

		it("should normalize ordered list markers by default", () => {
			const markdown = new Markdown("1. alpha\n1. beta\n1. gamma", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["1. alpha", "2. beta", "3. gamma"]);
		});

		it("should preserve source list markers when configured", () => {
			const markdown = new Markdown(
				"  4. forth\n  3. third\n\n10) ten\n7) seven\n\n+ plus\n* star\n- minus\n+",
				0,
				0,
				defaultMarkdownTheme,
				undefined,
				{
					preserveOrderedListMarkers: true,
				},
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, [
				"4. forth",
				"3. third",
				"",
				"10) ten",
				"7) seven",
				"",
				"+ plus",
				"* star",
				"- minus",
				"+",
			]);
		});

		it("should render mixed ordered and unordered nested lists", () => {
			const markdown = new Markdown(
				`1. Ordered item
   - Unordered nested
   - Another nested
2. Second ordered
   - More nested`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			assert.ok(plainLines.some((line) => line.includes("1. Ordered item")));
			assert.ok(plainLines.some((line) => line.includes("    - Unordered nested")));
			assert.ok(plainLines.some((line) => line.includes("2. Second ordered")));
		});

		it("should render blank lines between loose list items", () => {
			const markdown = new Markdown(
				`1. Lorem ipsum dolor sit amet.

   Ut enim ad minim veniam.

2. Duis aute irure dolor.

   Excepteur sint occaecat cupidatat.

3. Beep boop`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, [
				"1. Lorem ipsum dolor sit amet.",
				"",
				"   Ut enim ad minim veniam.",
				"",
				"2. Duis aute irure dolor.",
				"",
				"   Excepteur sint occaecat cupidatat.",
				"",
				"3. Beep boop",
			]);
		});

		it("should render task list markers", () => {
			const markdown = new Markdown("- [ ] beep\n- [x] boop", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["- [ ] beep", "- [x] boop"]);
		});

		it("should maintain numbering when code blocks are not indented (LLM output)", () => {
			// When code blocks aren't indented, marked parses each item as a separate list.
			// We use token.start to preserve the original numbering.
			const markdown = new Markdown(
				`1. First item

\`\`\`typescript
// code block
\`\`\`

2. Second item

\`\`\`typescript
// another code block
\`\`\`

3. Third item`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim());

			// Find all lines that start with a number and period
			const numberedLines = plainLines.filter((line) => /^\d+\./.test(line));

			// Should have 3 numbered items
			assert.strictEqual(numberedLines.length, 3, `Expected 3 numbered items, got: ${numberedLines.join(", ")}`);

			// Check the actual numbers
			assert.ok(numberedLines[0].startsWith("1."), `First item should be "1.", got: ${numberedLines[0]}`);
			assert.ok(numberedLines[1].startsWith("2."), `Second item should be "2.", got: ${numberedLines[1]}`);
			assert.ok(numberedLines[2].startsWith("3."), `Third item should be "3.", got: ${numberedLines[2]}`);
		});

		it("should indent wrapped unordered list lines", () => {
			const markdown = new Markdown("- alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(20).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["- alpha beta gamma", "  delta epsilon"]);
		});

		it("should indent wrapped ordered list lines", () => {
			const markdown = new Markdown("1. alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(20).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["1. alpha beta gamma", "   delta epsilon"]);
		});

		it("should indent wrapped ordered list lines with multi-digit markers", () => {
			const markdown = new Markdown("10. alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(21).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["10. alpha beta gamma", "    delta epsilon"]);
		});

		it("should indent wrapped nested list lines", () => {
			const markdown = new Markdown(`- parent\n  - alpha beta gamma delta epsilon`, 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["- parent", "    - alpha beta gamma", "      delta epsilon"]);
		});

		it("should indent wrapped nested list lines under ordered parents", () => {
			const markdown = new Markdown(`1. parent\n   - alpha beta gamma delta epsilon`, 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["1. parent", "    - alpha beta gamma", "      delta epsilon"]);
		});

		it("should render and wrap blockquotes inside list items", () => {
			const markdown = new Markdown("- > alpha beta gamma delta epsilon zeta", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["- │ alpha beta gamma", "  │ delta epsilon zeta"]);
		});

		it("should render and wrap code blocks inside list items", () => {
			const markdown = new Markdown(
				"- ```ts\n  alpha beta gamma delta epsilon zeta\n  ```",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(24).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["- ```ts", "    alpha beta gamma", "  delta epsilon zeta", "  ```"]);
		});
	});

	describe("Tables", () => {
		it("should render simple table", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check table structure
			assert.ok(plainLines.some((line) => line.includes("Name")));
			assert.ok(plainLines.some((line) => line.includes("Age")));
			assert.ok(plainLines.some((line) => line.includes("Alice")));
			assert.ok(plainLines.some((line) => line.includes("Bob")));
			// Check for table borders
			assert.ok(plainLines.some((line) => line.includes("│")));
			assert.ok(plainLines.some((line) => line.includes("─")));
		});

		it("should render row dividers between data rows", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const dividerLines = plainLines.filter((line) => line.includes("┼"));

			assert.strictEqual(dividerLines.length, 2, "Expected header + row divider");
		});

		it("should keep column width at least the longest word", () => {
			const longestWord = "superlongword";
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| ${longestWord} short | otherword |
| small | tiny |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(32);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const dataLine = plainLines.find((line) => line.includes(longestWord));
			assert.ok(dataLine, "Expected data row containing longest word");

			const segments = dataLine.split("│").slice(1, -1);
			const [firstSegment] = segments;
			assert.ok(firstSegment, "Expected first column segment");
			const firstColumnWidth = firstSegment.length - 2;

			assert.ok(
				firstColumnWidth >= longestWord.length,
				`Expected first column width >= ${longestWord.length}, got ${firstColumnWidth}`,
			);
		});

		it("should render table with alignment", () => {
			const markdown = new Markdown(
				`| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |
| Long text | Middle | End |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check headers
			assert.ok(plainLines.some((line) => line.includes("Left")));
			assert.ok(plainLines.some((line) => line.includes("Center")));
			assert.ok(plainLines.some((line) => line.includes("Right")));
			// Check content
			assert.ok(plainLines.some((line) => line.includes("Long text")));
		});

		it("should handle tables with varying column widths", () => {
			const markdown = new Markdown(
				`| Short | Very long column header |
| --- | --- |
| A | This is a much longer cell content |
| B | Short |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			// Should render without errors
			assert.ok(lines.length > 0);

			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			assert.ok(plainLines.some((line) => line.includes("Very long column header")));
			assert.ok(plainLines.some((line) => line.includes("This is a much longer cell content")));
		});

		it("should wrap table cells when table exceeds available width", () => {
			const markdown = new Markdown(
				`| Command | Description | Example |
| --- | --- | --- |
| npm install | Install all dependencies | npm install |
| npm run build | Build the project | npm run build |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at narrow width that forces wrapping
			const lines = markdown.render(50);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should fit within width
			for (const line of plainLines) {
				assert.ok(line.length <= 50, `Line exceeds width 50: "${line}" (length: ${line.length})`);
			}

			// Content should still be present (possibly wrapped across lines)
			const allText = plainLines.join(" ");
			assert.ok(allText.includes("Command"), "Should contain 'Command'");
			assert.ok(allText.includes("Description"), "Should contain 'Description'");
			assert.ok(allText.includes("npm install"), "Should contain 'npm install'");
			assert.ok(allText.includes("Install"), "Should contain 'Install'");
		});

		it("should not leak wrapped link styles into table borders or plain cells", async () => {
			const source = `| Link | Plain |
| --- | --- |
| [**one two three four five six**](https://example.com) | normal text |`;

			try {
				for (const hyperlinks of [true, false]) {
					setCapabilities({ images: null, trueColor: false, hyperlinks });
					const terminal = new VirtualTerminal(24, 16);
					const tui: TUI = new TuiMainScreen(terminal);
					tui.addChild(new Markdown(source, 0, 0, defaultMarkdownTheme));
					tui.start();

					try {
						await terminal.waitForRender();
						const viewport = terminal.getViewport();
						const row = viewport.findIndex((line) => line.includes("one") && line.includes("norm"));
						assert.notStrictEqual(row, -1, `Missing wrapped table row: ${JSON.stringify(viewport)}`);
						const line = viewport[row];
						const linkCol = line.indexOf("one");
						const separatorCol = line.indexOf("│", linkCol);
						const plainCol = line.indexOf("norm");
						assert.ok(linkCol >= 0 && separatorCol > linkCol && plainCol > separatorCol);
						assert.strictEqual(getCell(terminal, row, linkCol).isFgDefault(), false);
						assert.strictEqual(getCell(terminal, row, separatorCol).isFgDefault(), true);
						assert.strictEqual(getCell(terminal, row, plainCol).isFgDefault(), true);
						assert.notStrictEqual(getCell(terminal, row, linkCol).isBold(), 0);
						assert.strictEqual(getCell(terminal, row, separatorCol).isBold(), 0);
						assert.strictEqual(getCell(terminal, row, plainCol).isBold(), 0);

						if (!hyperlinks) {
							const urlRow = viewport.findIndex((viewportLine) => viewportLine.includes("https"));
							assert.notStrictEqual(urlRow, -1, `Missing fallback URL row: ${JSON.stringify(viewport)}`);
							const urlLine = viewport[urlRow];
							const urlCol = urlLine.indexOf("https");
							const urlSeparatorCol = urlLine.indexOf("│", urlCol);
							const urlBorderCol = urlLine.lastIndexOf("│");
							assert.ok(urlCol >= 0 && urlSeparatorCol > urlCol && urlBorderCol > urlSeparatorCol);
							assert.notStrictEqual(getCell(terminal, urlRow, urlCol).isDim(), 0);
							assert.strictEqual(getCell(terminal, urlRow, urlSeparatorCol).isDim(), 0);
							assert.strictEqual(getCell(terminal, urlRow, urlBorderCol).isDim(), 0);
						}
					} finally {
						tui.stop();
					}
				}
			} finally {
				resetCapabilitiesCache();
			}
		});

		it("should restore the enclosing style after a wrapped table link", async () => {
			const quoteColor = 0x123456;
			const theme: MarkdownTheme = {
				...defaultMarkdownTheme,
				// Use a basic wrapper that does not automatically reopen itself after nested resets.
				quote: (text) => `\x1b[38;2;18;52;86m${text}\x1b[39m`,
				link: (text) => `\x1b[38;2;129;162;190m${text}\x1b[39m`,
			};
			const source = `> | Link | Plain |
> | --- | --- |
> | [one two three four five six](https://example.com) | normal text |`;

			setCapabilities({ images: null, trueColor: true, hyperlinks: true });
			const terminal = new VirtualTerminal(28, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			tui.addChild(new Markdown(source, 0, 0, theme));
			tui.start();

			try {
				await terminal.waitForRender();
				const viewport = terminal.getViewport();
				const row = viewport.findIndex((line) => line.includes("one") && line.includes("normal"));
				assert.notStrictEqual(row, -1, `Missing wrapped blockquote table row: ${JSON.stringify(viewport)}`);
				const line = viewport[row];
				const linkCol = line.indexOf("one");
				const separatorCol = line.indexOf("│", linkCol);
				const plainCol = line.indexOf("normal");
				assert.ok(linkCol >= 0 && separatorCol > linkCol && plainCol > separatorCol);

				assert.notStrictEqual(getCell(terminal, row, linkCol).getFgColor(), quoteColor);
				assert.strictEqual(getCell(terminal, row, separatorCol).getFgColor(), quoteColor);
				assert.strictEqual(getCell(terminal, row, plainCol).getFgColor(), quoteColor);

				const finalRow = viewport.findIndex((line) => line.includes("five six"));
				assert.notStrictEqual(finalRow, -1, `Missing final wrapped link row: ${JSON.stringify(viewport)}`);
				const finalLine = viewport[finalRow];
				const finalLinkCol = finalLine.indexOf("five six");
				const finalSeparatorCol = finalLine.indexOf("│", finalLinkCol);
				const finalBorderCol = finalLine.lastIndexOf("│");
				assert.ok(finalLinkCol >= 0 && finalSeparatorCol > finalLinkCol && finalBorderCol > finalSeparatorCol);
				assert.strictEqual(getCell(terminal, finalRow, finalSeparatorCol).getFgColor(), quoteColor);
				assert.strictEqual(getCell(terminal, finalRow, finalBorderCol).getFgColor(), quoteColor);
			} finally {
				tui.stop();
				resetCapabilitiesCache();
			}
		});

		it("should not leak wrapped inline-code color into table borders", () => {
			const markdown = new Markdown(
				`| a | b |
| --- | --- |
| x | \`aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\` |
| y | z |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 40;
			const lines = markdown.render(width);

			// The long inline-code token wraps across several physical rows;
			// none of the `│`/`─` border characters may be rendered while the
			// code's foreground color is still open (regression: the wrap left
			// the color unclosed on split lines, so the borders turned colored).
			// (dsh-pi-tui divergence X021.)
			assertNoBordersInOpenFgColor(lines);
		});

		it("should wrap long cell content to multiple lines", () => {
			const markdown = new Markdown(
				`| Header |
| --- |
| This is a very long cell content that should wrap |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at width that forces the cell to wrap
			const lines = markdown.render(25);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have multiple data rows due to wrapping
			const dataRows = plainLines.filter((line) => line.startsWith("│") && !line.includes("─"));
			assert.ok(dataRows.length > 2, `Expected wrapped rows, got ${dataRows.length} rows`);

			// All content should be preserved (may be split across lines)
			const allText = plainLines.join(" ");
			assert.ok(allText.includes("very long"), "Should preserve 'very long'");
			assert.ok(allText.includes("cell content"), "Should preserve 'cell content'");
			assert.ok(allText.includes("should wrap"), "Should preserve 'should wrap'");
		});

		it("should wrap long unbroken tokens inside table cells (not only at line start)", () => {
			// Pin to no-hyperlinks so width checks work on plain text without OSC 8 sequences.
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const url = "https://example.com/this/is/a/very/long/url/that/should/wrap";
			const markdown = new Markdown(
				`| Value |
| --- |
| prefix ${url} |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 30;
			const lines = markdown.render(width);
			resetCapabilitiesCache();
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			for (const line of plainLines) {
				assert.ok(line.length <= width, `Line exceeds width ${width}: "${line}" (length: ${line.length})`);
			}

			// Borders should stay intact (exactly 2 vertical borders for a 1-col table)
			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			assert.ok(tableLines.length > 0, "Expected table rows to render");
			for (const line of tableLines) {
				const borderCount = line.split("│").length - 1;
				assert.strictEqual(borderCount, 2, `Expected 2 borders, got ${borderCount}: "${line}"`);
			}

			// Strip box drawing characters + whitespace so we can assert the URL is preserved
			// even if it was split across multiple wrapped lines.
			const extracted = plainLines.join("").replace(/[│├┤─\s]/g, "");
			assert.ok(extracted.includes("prefix"), "Should preserve 'prefix'");
			assert.ok(extracted.includes(url), "Should preserve URL");
		});

		it("should wrap styled inline code inside table cells without breaking borders", () => {
			const markdown = new Markdown(
				`| Code |
| --- |
| \`averyveryveryverylongidentifier\` |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 20;
			const lines = markdown.render(width);
			const joinedOutput = lines.join("\n");
			assert.ok(joinedOutput.includes("\x1b[33m"), "Inline code should be styled (yellow)");

			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
			for (const line of plainLines) {
				assert.ok(line.length <= width, `Line exceeds width ${width}: "${line}" (length: ${line.length})`);
			}

			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			for (const line of tableLines) {
				const borderCount = line.split("│").length - 1;
				assert.strictEqual(borderCount, 2, `Expected 2 borders, got ${borderCount}: "${line}"`);
			}
		});

		it("should handle extremely narrow width gracefully", () => {
			const markdown = new Markdown(
				`| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Very narrow width
			const lines = markdown.render(15);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should not crash and should produce output
			assert.ok(lines.length > 0, "Should produce output");

			// Lines should not exceed width
			for (const line of plainLines) {
				assert.ok(line.length <= 15, `Line exceeds width 15: "${line}" (length: ${line.length})`);
			}
		});

		it("should render table correctly when it fits naturally", () => {
			const markdown = new Markdown(
				`| A | B |
| --- | --- |
| 1 | 2 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Wide width where table fits naturally
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have proper table structure
			const headerLine = plainLines.find((line) => line.includes("A") && line.includes("B"));
			assert.ok(headerLine, "Should have header row");
			assert.ok(headerLine?.includes("│"), "Header should have borders");

			const separatorLine = plainLines.find((line) => line.includes("├") && line.includes("┼"));
			assert.ok(separatorLine, "Should have separator row");

			const dataLine = plainLines.find((line) => line.includes("1") && line.includes("2"));
			assert.ok(dataLine, "Should have data row");
		});

		it("should respect paddingX when calculating table width", () => {
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| Data 1 | Data 2 |`,
				2, // paddingX = 2
				0,
				defaultMarkdownTheme,
			);

			// Width 40 with paddingX=2 means contentWidth=36
			const lines = markdown.render(40);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should respect width
			for (const line of plainLines) {
				assert.ok(line.length <= 40, `Line exceeds width 40: "${line}" (length: ${line.length})`);
			}

			// Table rows should have left padding
			const tableRow = plainLines.find((line) => line.includes("│"));
			assert.ok(tableRow?.startsWith("  "), "Table should have left padding");
		});

		it("should not add a trailing blank line when table is the last rendered block", () => {
			const markdown = new Markdown(
				`| Name |
| --- |
| Alice |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected table to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Combined features", () => {
		it("should render lists and tables together", () => {
			const markdown = new Markdown(
				`# Test Document

- Item 1
  - Nested item
- Item 2

| Col1 | Col2 |
| --- | --- |
| A | B |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check heading
			assert.ok(plainLines.some((line) => line.includes("Test Document")));
			// Check list
			assert.ok(plainLines.some((line) => line.includes("- Item 1")));
			assert.ok(plainLines.some((line) => line.includes("    - Nested item")));
			// Check table
			assert.ok(plainLines.some((line) => line.includes("Col1")));
			assert.ok(plainLines.some((line) => line.includes("│")));
		});
	});

	describe("LaTeX math", () => {
		it("renders inline dollar and parenthesis delimiters", () => {
			const markdown = new Markdown(
				String.raw`A map $\mathbb{C}^3 \to \mathbb{C}^3$, $xy$, $x-y$, $-x$, $\frac{1}{2}$, $\rightarrow$, and \(s \to \infty\).`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["A map ℂ³ → ℂ³, xy, x-y, -x, 1/2, →, and s → ∞."]);
		});

		it("renders display dollar delimiters without Markdown escape corruption", () => {
			const markdown = new Markdown(
				String.raw`Before

$$\{3x+2y,\; x \in \{0, \pm 1\}\}$$

after`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["Before", "", "{3x+2y, x ∈ {0, ± 1}}", "", "after"]);
		});

		it("renders display bracket delimiters", () => {
			const markdown = new Markdown(
				String.raw`Before

\[
E \approx \frac{0.1\ \text{lux}}{100\ \text{lm/W}}
\]

after`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["Before", "", "    0.1 lux", "E ≈ ────────", "    100 lm/W", "", "after"]);
		});

		it("aligns matrix rows with the opening delimiter", () => {
			const markdown = new Markdown(
				String.raw`Consider the matrix

\[
A=
\begin{pmatrix}
\pi & 0\\
0 & \frac{1}{\pi}
\end{pmatrix}.
\]`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["Consider the matrix", "", "A = ⎛ π │ 0   ⎞", "    ⎝ 0 │ 1/π ⎠."]);
		});

		it("renders lower limits beneath display operators", () => {
			const markdown = new Markdown(
				String.raw`\[
\lim_{x\to 0}\frac{\frac{\sin x}{x}-1}{\frac{e^x-1}{x}-1}=0
\]`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["     (sin x)/x-1", "lim  ─────────── = 0", "x→0  (eˣ-1)/x-1"]);
		});

		it("renders math inside lists and tables", () => {
			const markdown = new Markdown(
				String.raw`- Formula: $F_1 = u^2$

| Value |
| --- |
| $\mathbb{C}^3$ |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());
			const output = lines.join("\n");

			assert.ok(output.includes("- Formula: F₁ = u²"));
			assert.ok(output.includes("│ ℂ³"));
		});

		it("does not treat currency, shell variables, or code spans as math", () => {
			const source = "Costs $5 and $10 or $8k–$12k; use `$x$`, $HOME, and $" + "{PATH}.";
			const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["Costs $5 and $10 or $8k–$12k; use $x$, $HOME, and $" + "{PATH}."]);

			const shellVariables = "Paths: $HOME/$USER and $XDG_CONFIG_HOME/$APP_CONFIG";
			const shellLines = new Markdown(shellVariables, 0, 0, defaultMarkdownTheme)
				.render(80)
				.map((line) => stripAnsi(line).trimEnd());
			assert.deepStrictEqual(shellLines, [shellVariables]);
		});

		it("preserves unsupported and incomplete LaTeX exactly", () => {
			const cases = [String.raw`Unknown $x + \unknown{y}$ after`, String.raw`Streaming $\mathbb{C}^3`];

			for (const source of cases) {
				const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());
				assert.deepStrictEqual(lines, [source]);
			}
		});

		it("preserves incomplete backslash delimiters while streaming", () => {
			const inline = new Markdown(String.raw`Map \(\mathbb{C}^3`, 0, 0, defaultMarkdownTheme);
			assert.deepStrictEqual(
				inline.render(80).map((line) => stripAnsi(line).trimEnd()),
				[String.raw`Map \(\mathbb{C}^3`],
			);

			const display = new Markdown("\\[\nx^2", 0, 0, defaultMarkdownTheme);
			assert.deepStrictEqual(
				display.render(80).map((line) => stripAnsi(line).trimEnd()),
				["\\[", "x^2"],
			);
		});

		it("does not render LaTeX inside escaped delimiters or code fences", () => {
			const source = [String.raw`Escaped \$x-y\$.`, "", "```text", String.raw`$\mathbb{C}^3$`, "```"].join("\n");
			const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, ["Escaped $x-y$.", "", "```text", "  $\\mathbb{C}^3$", "```"]);
		});

		it("allows LaTeX rendering to be disabled", () => {
			const markdown = new Markdown(
				String.raw`$$
\widetilde Y_{sf}
=
(1-w_{sf})\mu_{sf}^{\mathrm{MAR}}
$$

Inline \(A_{sf}\)`,
				0,
				0,
				defaultMarkdownTheme,
				undefined,
				{
					renderLatex: false,
				},
			);

			assert.deepStrictEqual(
				markdown.render(80).map((line) => stripAnsi(line).trimEnd()),
				[
					"$$",
					String.raw`\widetilde Y_{sf}`,
					"=",
					String.raw`(1-w_{sf})\mu_{sf}^{\mathrm{MAR}}`,
					"$$",
					"",
					String.raw`Inline \(A_{sf}\)`,
				],
			);
		});

		// Regression test for https://github.com/earendil-works/pi/issues/11483
		it("falls back to raw source when display math is wider than the content width", () => {
			const source = [
				"\\[",
				String.raw`\frac{\partial^2 u}{\partial x^2} + \frac{\partial^2 u}{\partial y^2} = \sum_{i=1}^{n} \frac{1}{i^2} + \int_0^1 f(x)\,dx`,
				"\\]",
			].join("\n");
			const render = (width: number) =>
				new Markdown(source, 0, 0, defaultMarkdownTheme).render(width).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(render(40), [
				"∂² u   ∂² u   n   1   1",
				"──── + ──── = ∑   ── +∫ f(x) dx",
				"∂ x²   ∂ y²  i=1  i²  0",
			]);

			const narrow = render(30);
			assert.strictEqual(narrow[0], "\\[");
			assert.strictEqual(narrow[narrow.length - 1], "\\]");
			assert.ok(!narrow.some((line) => line.includes("─")));
			assert.ok(narrow.every((line) => line.length <= 30));
		});

		// Regression tests for https://github.com/earendil-works/pi/issues/11159
		describe("unclosed display math before tables (#11159)", () => {
			const table = ["| A | B |", "|---|---|", "| 1 | 2 |"];
			const renderedTable = ["┌───┬───┐", "│ A │ B │", "├───┼───┤", "│ 1 │ 2 │", "└───┴───┘"];
			const render = (source: string) =>
				new Markdown(source, 0, 0, defaultMarkdownTheme).render(80).map((line) => stripAnsi(line).trimEnd());

			it("renders a table after an orphan $$ opener", () => {
				const source = ["Intro", "", "$$", "", ...table, "", "After"].join("\n");
				assert.deepStrictEqual(render(source), ["Intro", "", "$$", "", ...renderedTable, "", "After"]);
			});

			it("renders a table after an orphan $$ opener with math-like content", () => {
				const source = ["$$", "x = 1", "", ...table].join("\n");
				assert.deepStrictEqual(render(source), ["$$", "x = 1", "", ...renderedTable]);
			});

			it("does not pair an unclosed $$ with a later $$ across a table", () => {
				const source = ["Intro", "", "$$", "x = 1", "", ...table, "", "$$", "y^2", "$$"].join("\n");
				assert.deepStrictEqual(render(source), ["Intro", "", "$$", "x = 1", "", ...renderedTable, "", "y²"]);
			});

			it("renders a single-column table with a pipe-free aligned delimiter after an orphan $$", () => {
				const source = ["$$", "", "| A |", ":---:", "| 1 |"].join("\n");
				assert.deepStrictEqual(render(source), ["$$", "", "┌───┐", "│ A │", "├───┤", "│ 1 │", "└───┘"]);
			});

			it("renders a table after an orphan \\[ opener", () => {
				const source = ["\\\\[", "x^2", "", ...table].join("\n");
				assert.deepStrictEqual(render(source), ["", "\\[", "x^2", "", ...renderedTable]);
			});

			it("does not pair an unclosed \\[ with a later \\[ across a table", () => {
				const source = ["\\\\[", "x = 1", "", ...table, "", "\\\\[", "y^2", "\\\\]"].join("\n");
				assert.deepStrictEqual(render(source), [
					"",
					"\\[",
					"x = 1",
					"",
					...renderedTable,
					"",
					"\\",
					"",
					"\\[",
					"y^2",
					"\\\\]",
				]);
			});

			it("renders a table with a pipe-free header after an orphan $$", () => {
				const source = ["$$", "x^2", "", "Value", "| --- |", "1"].join("\n");
				assert.deepStrictEqual(render(source), [
					"$$",
					"x^2",
					"",
					"┌───────┐",
					"│ Value │",
					"├───────┤",
					"│ 1     │",
					"└───────┘",
				]);
			});

			it("still renders closed multi-line display math followed by a table", () => {
				const source = ["$$", "a", "+ b", "$$", "", ...table].join("\n");
				assert.deepStrictEqual(render(source), ["a + b", "", ...renderedTable]);
			});
		});

		it("switches from raw to rendered math when a streamed delimiter closes", () => {
			const markdown = new Markdown(String.raw`Map $\mathbb{C}^3`, 0, 0, defaultMarkdownTheme);
			assert.deepStrictEqual(
				markdown.render(80).map((line) => stripAnsi(line).trimEnd()),
				[String.raw`Map $\mathbb{C}^3`],
			);

			markdown.setText(String.raw`Map $\mathbb{C}^3$`);

			assert.deepStrictEqual(
				markdown.render(80).map((line) => stripAnsi(line).trimEnd()),
				["Map ℂ³"],
			);
		});
	});

	describe("Backslash escapes", () => {
		it("should normalize escaped punctuation by default", () => {
			const markdown = new Markdown(String.raw`"\"`, 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, [`""`]);
		});

		it("should preserve source backslash escapes when configured", () => {
			const markdown = new Markdown(String.raw`"\"`, 0, 0, defaultMarkdownTheme, undefined, {
				preserveBackslashEscapes: true,
			});

			const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

			assert.deepStrictEqual(lines, [String.raw`"\"`]);
		});
	});

	describe("Pre-styled text (thinking traces)", () => {
		it("should preserve gray italic styling after inline code", () => {
			// This replicates how thinking content is rendered in assistant-message.ts
			const markdown = new Markdown(
				"This is thinking with `inline code` and more text after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain the inline code block
			assert.ok(joinedOutput.includes("inline code"));

			// The output should have ANSI codes for gray (90) and italic (3)
			assert.ok(joinedOutput.includes("\x1b[90m"), "Should have gray color code");
			assert.ok(joinedOutput.includes("\x1b[3m"), "Should have italic code");

			// Verify that inline code is styled (theme uses yellow)
			const hasCodeColor = joinedOutput.includes("\x1b[33m");
			assert.ok(hasCodeColor, "Should style inline code");
		});

		it("should preserve gray italic styling after bold text", () => {
			const markdown = new Markdown(
				"This is thinking with **bold text** and more after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain bold text
			assert.ok(joinedOutput.includes("bold text"));

			// The output should have ANSI codes for gray (90) and italic (3)
			assert.ok(joinedOutput.includes("\x1b[90m"), "Should have gray color code");
			assert.ok(joinedOutput.includes("\x1b[3m"), "Should have italic code");

			// Should have bold codes (1 or 22 for bold on/off)
			assert.ok(joinedOutput.includes("\x1b[1m"), "Should have bold code");
		});

		it("should not leak styles into following lines when rendered in TUI", async () => {
			class MarkdownWithInput implements Component {
				public markdownLineCount = 0;
				private readonly markdown: Markdown;

				constructor(markdown: Markdown) {
					this.markdown = markdown;
				}

				render(width: number): string[] {
					const lines = this.markdown.render(width);
					this.markdownLineCount = lines.length;
					return [...lines, "INPUT"];
				}

				invalidate(): void {
					this.markdown.invalidate();
				}
			}

			const markdown = new Markdown("This is thinking with `inline code`", 1, 0, defaultMarkdownTheme, {
				color: (text) => chalk.gray(text),
				italic: true,
			});

			const terminal = new VirtualTerminal(80, 6);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new MarkdownWithInput(markdown);
			tui.addChild(component);
			tui.start();
			await terminal.waitForRender();

			assert.ok(component.markdownLineCount > 0);
			const inputRow = component.markdownLineCount;
			assert.strictEqual(getCell(terminal, inputRow, 0).isItalic(), 0);
			tui.stop();
		});
	});

	describe("Spacing after code blocks", () => {
		it("should have only one blank line between code block and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

\`\`\`js
const hello = "world";
\`\`\`

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const closingBackticksIndex = plainLines.indexOf("```");
			assert.ok(closingBackticksIndex !== -1, "Should have closing backticks");

			const afterBackticks = plainLines.slice(closingBackticksIndex + 1);
			const emptyLineCount = afterBackticks.findIndex((line) => line !== "");

			assert.strictEqual(
				emptyLineCount,
				1,
				`Expected 1 empty line after code block, but found ${emptyLineCount}. Lines after backticks: ${JSON.stringify(afterBackticks.slice(0, 5))}`,
			);
		});

		it("should normalize paragraph and code block spacing to one blank line", () => {
			const cases = [
				`hello this is text
\`\`\`
code block
\`\`\`
more text`,
				`hello this is text

\`\`\`
code block
\`\`\`

more text`,
			];
			const expectedLines = ["hello this is text", "", "```", "  code block", "```", "", "more text"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				assert.deepStrictEqual(
					plainLines,
					expectedLines,
					`Unexpected spacing for markdown: ${JSON.stringify(text)}`,
				);
			}
		});

		it("should not add a trailing blank line when code block is the last rendered block", () => {
			const cases = ["```js\nconst hello = 'world';\n```", "hello world\n\n```js\nconst hello = 'world';\n```"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

				assert.notStrictEqual(
					plainLines.at(-1),
					"",
					`Expected code block to end without a blank line: ${JSON.stringify(plainLines)}`,
				);
			}
		});
	});

	describe("Spacing after dividers", () => {
		it("should have only one blank line between divider and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

---

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const dividerIndex = plainLines.findIndex((line) => line.includes("─"));
			assert.ok(dividerIndex !== -1, "Should have divider");

			const afterDivider = plainLines.slice(dividerIndex + 1);
			const emptyLineCount = afterDivider.findIndex((line) => line !== "");

			assert.strictEqual(
				emptyLineCount,
				1,
				`Expected 1 empty line after divider, but found ${emptyLineCount}. Lines after divider: ${JSON.stringify(afterDivider.slice(0, 5))}`,
			);
		});

		it("should not add a trailing blank line when divider is the last rendered block", () => {
			const markdown = new Markdown("---", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected divider to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Spacing after headings", () => {
		it("should have only one blank line between heading and following paragraph", () => {
			const markdown = new Markdown(
				`# Hello

This is a paragraph`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const headingIndex = plainLines.findIndex((line) => line.includes("Hello"));
			assert.ok(headingIndex !== -1, "Should have heading");

			const afterHeading = plainLines.slice(headingIndex + 1);
			const emptyLineCount = afterHeading.findIndex((line) => line !== "");

			assert.strictEqual(
				emptyLineCount,
				1,
				`Expected 1 empty line after heading, but found ${emptyLineCount}. Lines after heading: ${JSON.stringify(afterHeading.slice(0, 5))}`,
			);
		});

		it("should not add a trailing blank line when heading is the last rendered block", () => {
			const markdown = new Markdown("# Hello", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected heading to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Spacing after blockquotes", () => {
		it("should have only one blank line between blockquote and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

> This is a quote

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const quoteIndex = plainLines.findIndex((line) => line.includes("This is a quote"));
			assert.ok(quoteIndex !== -1, "Should have blockquote");

			const afterQuote = plainLines.slice(quoteIndex + 1);
			const emptyLineCount = afterQuote.findIndex((line) => line !== "");

			assert.strictEqual(
				emptyLineCount,
				1,
				`Expected 1 empty line after blockquote, but found ${emptyLineCount}. Lines after quote: ${JSON.stringify(afterQuote.slice(0, 5))}`,
			);
		});

		it("should not add a trailing blank line when blockquote is the last rendered block", () => {
			const markdown = new Markdown("> This is a quote", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.notStrictEqual(
				plainLines.at(-1),
				"",
				`Expected blockquote to end without a blank line: ${JSON.stringify(plainLines)}`,
			);
		});
	});

	describe("Deeply nested blockquotes", () => {
		// Regression test for https://github.com/earendil-works/pi/issues/11272
		it("should render quotes nested deeper than the width allows without exploding", () => {
			const markdown = new Markdown(`${">".repeat(60)}x`, 1, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			assert.strictEqual(plainLines.length, 1, `Expected a single line: ${JSON.stringify(plainLines)}`);
			assert.ok(plainLines[0].endsWith("x"), `Expected content to be kept: ${JSON.stringify(plainLines)}`);
		});
	});

	describe("Blockquotes with multiline content", () => {
		it("should apply consistent styling to all lines in lazy continuation blockquote", () => {
			// Markdown "lazy continuation" - second line without > is still part of the quote
			const markdown = new Markdown(
				`>Foo
bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.magenta(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// Both lines should have the quote border
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));
			assert.strictEqual(quotedLines.length, 2, `Expected 2 quoted lines, got: ${JSON.stringify(plainLines)}`);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find((line) => line.includes("Foo"));
			const barLine = lines.find((line) => line.includes("bar"));
			assert.ok(fooLine, "Should have Foo line");
			assert.ok(barLine, "Should have bar line");

			// Check that both have italic (\x1b[3m) - blockquotes use theme styling, not default message color
			assert.ok(fooLine?.includes("\x1b[3m"), `Foo line should have italic: ${fooLine}`);
			assert.ok(barLine?.includes("\x1b[3m"), `bar line should have italic: ${barLine}`);

			// Blockquotes should NOT have the default message color (magenta)
			assert.ok(!fooLine?.includes("\x1b[35m"), `Foo line should NOT have magenta color: ${fooLine}`);
			assert.ok(!barLine?.includes("\x1b[35m"), `bar line should NOT have magenta color: ${barLine}`);
		});

		it("should apply consistent styling to explicit multiline blockquote", () => {
			const markdown = new Markdown(
				`>Foo
>bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.cyan(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// Both lines should have the quote border
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));
			assert.strictEqual(quotedLines.length, 2, `Expected 2 quoted lines, got: ${JSON.stringify(plainLines)}`);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find((line) => line.includes("Foo"));
			const barLine = lines.find((line) => line.includes("bar"));
			assert.ok(fooLine?.includes("\x1b[3m"), `Foo line should have italic: ${fooLine}`);
			assert.ok(barLine?.includes("\x1b[3m"), `bar line should have italic: ${barLine}`);

			// Blockquotes should NOT have the default message color (cyan)
			assert.ok(!fooLine?.includes("\x1b[36m"), `Foo line should NOT have cyan color: ${fooLine}`);
			assert.ok(!barLine?.includes("\x1b[36m"), `bar line should NOT have cyan color: ${barLine}`);
		});

		it("should render list content inside blockquotes", () => {
			const markdown = new Markdown(
				`> 1. bla bla
> - nested bullet`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const quotedLines = plainLines.filter((line) => line.startsWith("│ "));

			assert.ok(
				quotedLines.some((line) => line.includes("1. bla bla")),
				`Missing ordered list item: ${JSON.stringify(quotedLines)}`,
			);
			assert.ok(
				quotedLines.some((line) => line.includes("- nested bullet")),
				`Missing unordered list item: ${JSON.stringify(quotedLines)}`,
			);
		});

		it("should wrap long blockquote lines and add border to each wrapped line", () => {
			const longText = "This is a very long blockquote line that should wrap to multiple lines when rendered";
			const markdown = new Markdown(`> ${longText}`, 0, 0, defaultMarkdownTheme);

			// Render at narrow width to force wrapping
			const lines = markdown.render(30);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Filter to non-empty lines (exclude trailing blank line after blockquote)
			const contentLines = plainLines.filter((line) => line.length > 0);

			// Should have multiple lines due to wrapping
			assert.ok(contentLines.length > 1, `Expected multiple wrapped lines, got: ${JSON.stringify(contentLines)}`);

			// Every content line should start with the quote border
			for (const line of contentLines) {
				assert.ok(line.startsWith("│ "), `Wrapped line should have quote border: "${line}"`);
			}

			// All content should be preserved
			const allText = contentLines.join(" ");
			assert.ok(allText.includes("very long"), "Should preserve 'very long'");
			assert.ok(allText.includes("blockquote"), "Should preserve 'blockquote'");
			assert.ok(allText.includes("multiple"), "Should preserve 'multiple'");
		});

		it("should properly indent wrapped blockquote lines with styling", () => {
			const markdown = new Markdown(
				"> This is styled text that is long enough to wrap",
				0,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.yellow(text), // This should NOT be applied to blockquotes
					italic: true,
				},
			);

			const lines = markdown.render(25);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Filter to non-empty lines
			const contentLines = plainLines.filter((line) => line.length > 0);

			// All lines should have the quote border
			for (const line of contentLines) {
				assert.ok(line.startsWith("│ "), `Line should have quote border: "${line}"`);
			}

			// Check that italic is applied (from theme.quote)
			const allOutput = lines.join("\n");
			assert.ok(allOutput.includes("\x1b[3m"), "Should have italic");

			// Blockquotes should NOT have the default message color (yellow)
			assert.ok(!allOutput.includes("\x1b[33m"), "Should NOT have yellow color from default style");
		});

		it("should render inline formatting inside blockquotes and reapply quote styling after", () => {
			const markdown = new Markdown("> Quote with **bold** and `code`", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Should have the quote border
			assert.ok(
				plainLines.some((line) => line.startsWith("│ ")),
				"Should have quote border",
			);

			// Content should be preserved
			const allPlain = plainLines.join(" ");
			assert.ok(allPlain.includes("Quote with"), "Should preserve 'Quote with'");
			assert.ok(allPlain.includes("bold"), "Should preserve 'bold'");
			assert.ok(allPlain.includes("code"), "Should preserve 'code'");

			const allOutput = lines.join("\n");

			// Should have bold styling (\x1b[1m)
			assert.ok(allOutput.includes("\x1b[1m"), "Should have bold styling");

			// Should have code styling (yellow = \x1b[33m from defaultMarkdownTheme)
			assert.ok(allOutput.includes("\x1b[33m"), "Should have code styling (yellow)");

			// Should have italic from quote styling (\x1b[3m)
			assert.ok(allOutput.includes("\x1b[3m"), "Should have italic from quote styling");
		});
	});

	describe("Heading with inline code", () => {
		it("should preserve heading styling after inline code", () => {
			const markdown = new Markdown("### Why `sourceInfo` should not be optional", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// The heading theme is bold+cyan. After the yellow inline code, the heading
			// styling (bold+cyan) must be restored so subsequent text is styled correctly.
			// bold = \x1b[1m, cyan = \x1b[36m, yellow = \x1b[33m
			assert.ok(joinedOutput.includes("\x1b[33m"), "Should have yellow for inline code");

			// Find the position of "should not be optional" in the raw output.
			// It must be preceded by heading style codes (bold+cyan), not appear unstyled.
			const afterCodeIndex = joinedOutput.indexOf("should not be optional");
			assert.ok(afterCodeIndex > 0, "Should contain text after inline code");

			// Look at the ANSI codes between the code span end and "should not be optional".
			// There should be bold (\x1b[1m) and cyan (\x1b[36m) re-applied.
			const precedingChunk = joinedOutput.slice(Math.max(0, afterCodeIndex - 40), afterCodeIndex);
			assert.ok(
				precedingChunk.includes("\x1b[1m"),
				`Should re-apply bold before text after code: ${precedingChunk}`,
			);
			assert.ok(
				precedingChunk.includes("\x1b[36m"),
				`Should re-apply cyan before text after code: ${precedingChunk}`,
			);
		});

		it("should preserve heading styling after inline code for h1", () => {
			const markdown = new Markdown("# Title with `code` inside", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			const afterCodeIndex = joinedOutput.indexOf("inside");
			assert.ok(afterCodeIndex > 0, "Should contain text after inline code");

			const precedingChunk = joinedOutput.slice(Math.max(0, afterCodeIndex - 40), afterCodeIndex);
			// H1 uses heading + bold + underline
			assert.ok(precedingChunk.includes("\x1b[1m"), `Should re-apply bold for h1: ${precedingChunk}`);
			assert.ok(precedingChunk.includes("\x1b[36m"), `Should re-apply cyan for h1: ${precedingChunk}`);
			assert.ok(precedingChunk.includes("\x1b[4m"), `Should re-apply underline for h1: ${precedingChunk}`);
		});

		it("should not leak h1 underline into padding when inline code is the last token", async () => {
			const markdown = new Markdown("# Important distinction from `open()`", 0, 0, defaultMarkdownTheme);
			const terminal = new VirtualTerminal(80, 4);
			const tui: TUI = new TuiMainScreen(terminal);
			tui.addChild(markdown);
			tui.start();
			await terminal.waitForRender();

			const renderedLine = markdown.render(80)[0];
			assert.ok(renderedLine, "Should render heading line");
			const contentWidth = renderedLine.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().length;
			assert.ok(contentWidth > 0, "Should have visible heading content");

			for (let col = contentWidth; col < 80; col++) {
				assert.strictEqual(
					getCell(terminal, 0, col).isUnderline(),
					0,
					`Expected no underline in padding at col ${col}`,
				);
			}

			tui.stop();
		});

		it("should preserve heading styling after bold text", () => {
			const markdown = new Markdown("## Heading with **bold** and more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			const afterBoldIndex = joinedOutput.indexOf("and more");
			assert.ok(afterBoldIndex > 0, "Should contain text after bold");

			const precedingChunk = joinedOutput.slice(Math.max(0, afterBoldIndex - 40), afterBoldIndex);
			assert.ok(precedingChunk.includes("\x1b[1m"), `Should re-apply bold for h2: ${precedingChunk}`);
			assert.ok(precedingChunk.includes("\x1b[36m"), `Should re-apply cyan for h2: ${precedingChunk}`);
		});
	});

	describe("Strikethrough syntax", () => {
		it("should render ~~text~~ as strikethrough", () => {
			const markdown = new Markdown("Use ~~strikethrough~~ here", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");
			const joinedPlain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join(" ");

			assert.ok(joinedOutput.includes("\x1b[9m"), "Should apply strikethrough styling");
			assert.ok(joinedPlain.includes("strikethrough"), "Should include struck text content");
			assert.ok(!joinedPlain.includes("~~strikethrough~~"), "Should not render delimiters as text");
		});

		it("should keep ~text~ as plain text", () => {
			const markdown = new Markdown("Use ~strikethrough~ literally", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");
			const joinedPlain = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "")).join(" ");

			assert.ok(joinedPlain.includes("~strikethrough~"), "Single-tilde delimiters should remain visible");
			assert.ok(!joinedOutput.includes("\x1b[9m"), "Single-tilde text should not use strikethrough styling");
		});
	});

	// #10925
	describe("styled words at the wrap boundary", () => {
		it("should not start the next line with a space or carry styles into padding", () => {
			const markdown = new Markdown("aaaa **bold** next ~~strk~~ more words", 1, 0, defaultMarkdownTheme, {
				bgColor: (text) => `\x1b[44m${text}\x1b[49m`,
			});

			assert.deepStrictEqual(markdown.render(11), [
				"\x1b[44m aaaa \x1b[1mbold\x1b[22m \x1b[49m",
				"\x1b[44m next \x1b[9mstrk\x1b[29m \x1b[49m",
				"\x1b[44m more      \x1b[49m",
				"\x1b[44m words     \x1b[49m",
			]);
		});
	});

	// #10154
	describe("CJK emphasis", () => {
		const tagTheme: MarkdownTheme = {
			...defaultMarkdownTheme,
			bold: (text) => `<b>${text}</b>`,
			italic: (text) => `<i>${text}</i>`,
		};
		const render = (text: string) => new Markdown(text, 0, 0, tagTheme).render(80).map((line) => line.trimEnd());

		it("renders emphasis delimited next to CJK punctuation", () => {
			assert.deepStrictEqual(render("**这是测试。**后面"), ["<b>这是测试。</b>后面"]);
			assert.deepStrictEqual(render("**一句话说清：**一台机器"), ["<b>一句话说清：</b>一台机器"]);
			assert.deepStrictEqual(render("**要点到此为止。**20 小时"), ["<b>要点到此为止。</b>20 小时"]);
			assert.deepStrictEqual(render("字**「引用」**字"), ["字<b>「引用」</b>字"]);
			assert.deepStrictEqual(render("*斜体。*后面"), ["<i>斜体。</i>后面"]);
		});

		it("keeps CommonMark flanking rules for non-CJK text", () => {
			assert.deepStrictEqual(render("**end.**Then next"), ["**end.**Then next"]);
		});
	});

	describe("Links", () => {
		afterEach(() => {
			resetCapabilitiesCache();
		});

		it("should stop bare URLs at CJK punctuation and preserve the following text", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			for (const punctuation of "。，；：！？、“”‘’（）【】《》「」『』…—·・〈〉［］｛｝．｡｢｣､･") {
				for (const url of ["https://example.com", "https://example.com/中文?q=搜索#片段", "www.example.com"]) {
					const source = `${url}${punctuation}后面的中文`;
					const output = new Markdown(source, 0, 0, defaultMarkdownTheme).render(160).join("");
					const href = url.startsWith("www.") ? `http://${url}` : url;
					assert.ok(output.includes(`\x1b]8;;${href}\x1b\\`), source);
					assert.ok(stripAnsi(output).includes(`\x1b]8;;\x1b\\${punctuation}后面的中文`), source);
					assert.strictEqual(stripAnsi(output.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "")).trimEnd(), source);
				}
			}
		});

		it("should preserve Chinese characters without punctuation in bare URLs", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			for (const url of [
				"https://example.com紧接着中文",
				"https://example.com/中文?q=搜索#片段",
				"https://example.com/テストー한글",
			]) {
				const output = new Markdown(url, 0, 0, defaultMarkdownTheme).render(160).join("");
				assert.ok(output.includes(`\x1b]8;;${url}\x1b\\`));
			}
		});

		it("should preserve CJK punctuation in explicit links and angle autolinks", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const url = "https://example.com/中文，路径·テスト・한글…—。";
			for (const source of [`[文档](${url})`, `<${url}>`]) {
				const output = new Markdown(source, 0, 0, defaultMarkdownTheme).render(160).join("");
				assert.ok(output.includes(`\x1b]8;;${url}\x1b\\`), source);
			}
		});

		it("should preserve English punctuation trimming before Chinese punctuation", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const source = "https://example.com.，后面的中文";
			const output = new Markdown(source, 0, 0, defaultMarkdownTheme).render(160).join("");
			assert.ok(output.includes("\x1b]8;;https://example.com\x1b\\"));
			assert.ok(stripAnsi(output).includes("\x1b]8;;\x1b\\.，后面的中文"));
		});

		it("should not duplicate URL for autolinked emails", () => {
			// Hyperlinks capability does not affect the mailto: display check.
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const markdown = new Markdown("Contact user@example.com for help", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// Should contain the email once, not duplicated with mailto:
			assert.ok(joinedPlain.includes("user@example.com"), "Should contain email");
			assert.ok(!joinedPlain.includes("mailto:"), "Should not show mailto: prefix for autolinked emails");
		});

		it("should not duplicate URL for bare URLs", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// URL should appear only once
			const urlCount = (joinedPlain.match(/https:\/\/example\.com/g) || []).length;
			assert.strictEqual(urlCount, 1, "URL should appear exactly once");
		});

		it("should show URL in parentheses when hyperlinks are not supported", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const markdown = new Markdown("[click here](https://example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			assert.ok(joinedPlain.includes("click here"), "Should contain link text");
			assert.ok(joinedPlain.includes("(https://example.com)"), "Should show URL in parentheses");
		});

		it("should show mailto URL in parentheses when hyperlinks are not supported", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: false });
			const markdown = new Markdown("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			assert.ok(joinedPlain.includes("Email me"), "Should contain link text");
			assert.ok(joinedPlain.includes("(mailto:test@example.com)"), "Should show mailto URL in parentheses");
		});

		it("should emit OSC 8 hyperlink sequence when terminal supports hyperlinks", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const markdown = new Markdown("[click here](https://example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joined = lines.join("");

			// OSC 8 open: ESC ] 8 ; ; <url> ESC \
			assert.ok(joined.includes("\x1b]8;;https://example.com\x1b\\"), "Should contain OSC 8 open sequence");
			// OSC 8 close: ESC ] 8 ; ; ESC \
			assert.ok(joined.includes("\x1b]8;;\x1b\\"), "Should contain OSC 8 close sequence");
			// Visible text is present
			const plainLines = lines.map((line) => line.replace(/\x1b[^a-zA-Z]*[a-zA-Z]|\x1b\].*?\x1b\\/g, ""));
			assert.ok(plainLines.join("").includes("click here"), "Should contain link text");
			// URL is NOT printed inline as plain text
			const rawPlain = lines.map((line) =>
				line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, ""),
			);
			assert.ok(!rawPlain.join("").includes("(https://example.com)"), "URL should not appear inline in parentheses");
		});

		it("should use OSC 8 for mailto links when terminal supports hyperlinks", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const markdown = new Markdown("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joined = lines.join("");

			assert.ok(
				joined.includes("\x1b]8;;mailto:test@example.com\x1b\\"),
				"Should contain OSC 8 open with mailto URL",
			);
			assert.ok(joined.includes("\x1b]8;;\x1b\\"), "Should contain OSC 8 close sequence");
		});

		it("should use OSC 8 for bare URLs when terminal supports hyperlinks", () => {
			setCapabilities({ images: null, trueColor: false, hyperlinks: true });
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const joined = lines.join("");

			assert.ok(joined.includes("\x1b]8;;https://example.com\x1b\\"), "Should contain OSC 8 hyperlink");
			// URL should not also appear as raw parenthetical text
			const rawPlain = lines.map((line) =>
				line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, ""),
			);
			assert.ok(!rawPlain.join("").includes("(https://example.com)"), "URL should not appear twice");
		});
	});

	describe("HTML-like tags in text", () => {
		it("should render content with HTML-like tags as text", () => {
			// When the model emits something like <thinking>content</thinking> in regular text,
			// marked might treat it as HTML and hide the content
			const markdown = new Markdown(
				"This is text with <thinking>hidden content</thinking> that should be visible",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// The content inside the tags should be visible
			assert.ok(
				joinedPlain.includes("hidden content") || joinedPlain.includes("<thinking>"),
				"Should render HTML-like tags or their content as text, not hide them",
			);
		});

		it("should render HTML tags in code blocks correctly", () => {
			const markdown = new Markdown("```html\n<div>Some HTML</div>\n```", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join("\n");

			// HTML in code blocks should be visible
			assert.ok(
				joinedPlain.includes("<div>") && joinedPlain.includes("</div>"),
				"Should render HTML in code blocks",
			);
		});
	});

	describe("Streaming code fences", () => {
		it("stabilizes partial closing fence rendering", () => {
			const cases = [
				{
					input: "```ts\nconst x = 1;\n``",
					expected: ["```ts", "  const x = 1;", "```"],
				},
				{
					input: "```md\nnot a closing fence:\n``\n```",
					expected: ["```md", "  not a closing fence:", "  ``", "```"],
				},
				{
					input: "```ts\n``",
					expected: ["```ts", "", "```"],
				},
				{
					input: "````\n```",
					expected: ["```", "", "```"],
				},
				{
					input: "~~~~~\n~~~~",
					expected: ["```", "", "```"],
				},
				{
					input: "```md\nnot a closing fence:\n``\n```\n\nafter",
					expected: ["```md", "  not a closing fence:", "  ``", "```", "", "after"],
				},
			];

			for (const { input, expected } of cases) {
				const markdown = new Markdown(input, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80).map((line) => stripAnsi(line).trimEnd());

				assert.deepStrictEqual(lines, expected);
			}

			const partial = new Markdown("```ts\nconst x = 1;\n``", 0, 0, defaultMarkdownTheme);
			const complete = new Markdown("```ts\nconst x = 1;\n```", 0, 0, defaultMarkdownTheme);

			assert.strictEqual(partial.render(80).length, complete.render(80).length);
		});
	});
});

describe("CJK punctuation after bare URLs (upstream URL policy)", () => {
	it("should not absorb CJK punctuation after bare URLs into the link", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		const markdown = new Markdown(
			"PR 已开：https://example.com/app/pull/232（本地 main 已退回 origin/main 保持干净）。",
			0,
			0,
			defaultMarkdownTheme,
		);

		const lines = markdown.render(80);
		const joined = lines.join("");

		// The hyperlink target must stop at the CJK boundary…
		assert.ok(
			joined.includes("\x1b]8;;https://example.com/app/pull/232\x1b\\"),
			"OSC 8 target should end at the URL, before the full-width parenthesis",
		);
		// …and the CJK text must not be part of any hyperlink target.
		assert.ok(!joined.includes("%EF%BC%88"), "OSC 8 target should not contain encoded CJK");
		assert.ok(!/\x1b\]8;;[^\x1b]*（/.test(joined), "No hyperlink target should contain CJK characters");
		// The full source text still renders visibly.
		const rawPlain = lines.map((line) =>
			line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, ""),
		);
		assert.ok(
			rawPlain.join("").includes("https://example.com/app/pull/232（本地 main 已退回"),
			"URL and following CJK text should both render",
		);
	});

	it("should strip a trailing full-width parenthesis after a bare URL", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		const markdown = new Markdown("看这个（https://example.com/page）就知道", 0, 0, defaultMarkdownTheme);

		const lines = markdown.render(80);
		const joined = lines.join("");

		assert.ok(
			joined.includes("\x1b]8;;https://example.com/page\x1b\\"),
			"OSC 8 target should exclude the wrapping full-width parenthesis",
		);
	});

	it("should keep CJK characters inside the URL path", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		const markdown = new Markdown("见 https://example.com/wiki/测试页面 的说明", 0, 0, defaultMarkdownTheme);

		const lines = markdown.render(80);
		const joined = lines.join("");

		assert.ok(
			joined.includes("\x1b]8;;https://example.com/wiki/测试页面\x1b\\"),
			"CJK path characters remain part of the hyperlink target",
		);
	});

	it("should terminate a bare URL before a balanced full-width parenthetical", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		const source = "见 https://example.com/issues/521（说明）";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);

		const lines = markdown.render(80);
		const joined = lines.join("");

		assert.ok(
			joined.includes("\x1b]8;;https://example.com/issues/521\x1b\\"),
			"the bare URL target stops at the full-width parenthesis",
		);
		const plain = lines
			.map((line) => line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;]*m/g, ""))
			.join("");
		assert.ok(plain.includes("（说明）"), "the following parenthetical stays visible and unlinked");
		assert.strictEqual(plain.trimEnd(), source);
	});
});

describe("Source-cell proof (proveSourceSpan)", () => {
	afterEach(() => resetCapabilitiesCache());

	type ProvenProof = Extract<MarkdownSourceCellProof, { kind: "PROVEN" }>;

	const capabilities = (hyperlinks: boolean): void => {
		setCapabilities({ images: null, trueColor: false, hyperlinks });
	};

	const rangeOf = (source: string, target: string, nth = 0): { start: number; end: number } => {
		let index = -1;
		for (let occurrence = 0; occurrence <= nth; occurrence++) {
			index = source.indexOf(target, index + 1);
		}
		assert.ok(index >= 0, `target ${JSON.stringify(target)} is not in the source`);
		return { start: index, end: index + target.length };
	};

	const painted = (rows: readonly string[], segments: ProvenProof["segments"]): string =>
		segments
			.map((segment) =>
				stripTerminalSequences(sliceByColumn(rows[segment.row]!, segment.startCol, segment.endCol - segment.startCol)),
			)
			.join("");

	const proven = (
		markdown: Markdown,
		source: string,
		range: { start: number; end: number },
		width: number,
	): { proof: ProvenProof; rows: string[] } => {
		const rows = markdown.render(width);
		const before = rows.slice();
		const proof = markdown.proveSourceSpan(range, width);
		assert.strictEqual(
			proof.kind,
			"PROVEN",
			`expected PROVEN for ${JSON.stringify(source.slice(range.start, range.end))}, got ${JSON.stringify(proof)}`,
		);
		assert.strictEqual(markdown.render(width), rows, "a proof must keep the normal render cache identity");
		assert.deepStrictEqual(rows, before);
		return { proof: proof as ProvenProof, rows };
	};

	const expectPainted = (
		markdown: Markdown,
		source: string,
		target: string,
		width: number,
		nth = 0,
	): { proof: ProvenProof; rows: string[]; range: { start: number; end: number } } => {
		const range = rangeOf(source, target, nth);
		const result = proven(markdown, source, range, width);
		assert.strictEqual(painted(result.rows, result.proof.segments), target, "painted cells must be the source range");
		return { ...result, range };
	};

	const expectUnproven = (
		markdown: Markdown,
		source: string,
		target: string,
		width: number,
		nth = 0,
	): MarkdownSourceCellProof => {
		const range = rangeOf(source, target, nth);
		const proof = markdown.proveSourceSpan(range, width);
		assert.notStrictEqual(
			proof.kind,
			"PROVEN",
			`${JSON.stringify(target)} must not be proven as painted cells`,
		);
		return proof;
	};

	it("proves exactly the requested occurrence of a plain paragraph", () => {
		capabilities(false);
		const source = "needle one and needle two";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		const first = expectPainted(markdown, source, "needle", 44, 0);
		const second = expectPainted(markdown, source, "needle", 44, 1);
		assert.deepStrictEqual(first.proof.segments, [{ row: 0, startCol: 0, endCol: 6 }]);
		assert.deepStrictEqual(second.proof.segments, [{ row: 0, startCol: 15, endCol: 21 }]);
	});

	it("proves heading, strong, em and strikethrough text", () => {
		capabilities(false);
		const cases: Array<[string, string]> = [
			["## heading needle", "needle"],
			["**bold needle** after", "bold needle"],
			["*em needle* after", "em needle"],
			["~~del needle~~ after", "del needle"],
		];
		for (const [source, target] of cases) {
			const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
			expectPainted(markdown, source, target, 44);
		}
	});

	it("proves nested list items and quoted text, including continuation lines", () => {
		capabilities(false);
		const source = "- parent\n  - nested needle text\n\n> quoted needle line\n> second needle line";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		expectPainted(markdown, source, "nested needle", 44);
		expectPainted(markdown, source, "quoted needle", 44);
		expectPainted(markdown, source, "needle", 44, 1);
		expectPainted(markdown, source, "second needle", 44);
	});

	it("proves a link label and keeps the hidden destination unclaimed", () => {
		capabilities(true);
		const source = "needle [label](https://x/needle)";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		const label = expectPainted(markdown, source, "label", 44);
		assert.ok(
			label.rows.join("").includes("\x1b]8;;https://x/needle\x1b\\"),
			"the business OSC 8 target is unchanged",
		);
		const hidden = markdown.proveSourceSpan(rangeOf(source, "needle", 1), 44);
		assert.deepStrictEqual(hidden, { kind: "NOT_PAINTED", reason: "HIDDEN_LINK_TARGET" });
		// The visible homonym before the link is never highlighted by a hidden-destination request.
		assert.strictEqual(painted(label.rows, label.proof.segments), "label");
	});

	it("proves the printed destination when hyperlinks are disabled", () => {
		capabilities(false);
		const source = "[label](https://x/needle)";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		const { proof, rows } = expectPainted(markdown, source, "needle", 44);
		assert.ok(proof.segments[0]!.startCol > 0, "the destination is printed after the label");
		assert.ok(rows.join("").includes("(https://x/needle)"), "the printed href is unchanged");
	});

	it("proves a reference definition target printed by its using link", () => {
		capabilities(false);
		const source = "[label][id]\n\n[id]: https://x/needle";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		expectPainted(markdown, source, "needle", 44);
	});

	it("keeps the ordinary block/highlight cache lifecycle across a proof after setText and a resize", () => {
		capabilities(false);
		const highlights: string[] = [];
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			highlightCode: (code) => {
				highlights.push(code);
				return code.split("\n").map((line) => chalk.green(line));
			},
		};
		const stableCode = "```js\nconst stable = 1;\n```";
		const changed = `second paragraph needle\n\n${stableCode}`;
		const markdown = new Markdown(`first paragraph\n\n${stableCode}`, 0, 0, theme);
		markdown.render(80);
		assert.strictEqual(highlights.length, 1);
		markdown.setText(changed);
		// No render() before the proof: proveSourceSpan performs the first post-setText normal render itself.
		const proof = markdown.proveSourceSpan(rangeOf(changed, "needle"), 80);
		assert.strictEqual(proof.kind, "PROVEN", JSON.stringify(proof));
		assert.strictEqual(highlights.length, 1, "the proof-triggered render reuses the unchanged highlighted block");
		const resized = markdown.proveSourceSpan(rangeOf(changed, "needle"), 44);
		assert.strictEqual(resized.kind, "PROVEN", JSON.stringify(resized));
		assert.strictEqual(highlights.length, 1, "a resize proof also reuses the unchanged highlighted block");
	});


	it("reuses cached normal blocks for non-intersecting blocks in a reference-definition document", () => {
		capabilities(false);
		const highlights: string[] = [];
		const theme: MarkdownTheme = {
			...defaultMarkdownTheme,
			highlightCode: (code) => {
				highlights.push(code);
				return code.split("\n").map((line) => chalk.green(line));
			},
		};
		const source = "[label][id]\n\n[id]: https://x/needle\n\n```js\nconst other = 1;\n```";
		const markdown = new Markdown(source, 0, 0, theme);
		markdown.render(44);
		assert.strictEqual(highlights.length, 1, "the ordinary reference-link render has no block cache");
		expectPainted(markdown, source, "label", 44);
		const afterFirstProof = highlights.length;
		assert.strictEqual(afterFirstProof, 2, "the proof primes the normal block cache once");
		expectPainted(markdown, source, "label", 44);
		assert.strictEqual(highlights.length, afterFirstProof, "the next proof reuses the cached non-intersecting block");
	});

	it("keeps reference-definition destinations hidden or ambiguous instead of claiming cells", () => {
		const source = "[label][id]\n\n[id]: https://x/needle";
		capabilities(true);
		const hidden = new Markdown(source, 0, 0, defaultMarkdownTheme);
		assert.deepStrictEqual(hidden.proveSourceSpan(rangeOf(source, "needle"), 44), {
			kind: "NOT_PAINTED",
			reason: "HIDDEN_LINK_TARGET",
		});
		capabilities(false);
		// Two using links print the same destination; the visible owner is ambiguous, so the proof must fail closed.
		const shared = "[one][id] and [two][id]\n\n[id]: https://x/needle";
		const ambiguous = new Markdown(shared, 0, 0, defaultMarkdownTheme);
		// Two printed owners: the visible ownership is ambiguous, so the range is UNPROVEN, never NOT_PAINTED.
		assert.deepStrictEqual(ambiguous.proveSourceSpan(rangeOf(shared, "needle"), 44), {
			kind: "UNPROVEN",
			reason: "TOKEN_ORIGIN",
		});
	});

	it("proves fenced code text and refuses a highlighter that rewrites the glyphs", () => {
		capabilities(false);
		const source = "```js\nneedle one\nconst needle = 2;\n```";
		const plain = new Markdown(source, 0, 0, defaultMarkdownTheme);
		const second = expectPainted(plain, source, "needle", 44, 1);
		assert.ok(
			stripTerminalSequences(second.rows[second.proof.segments[0]!.row]!).includes("const needle = 2;"),
			"the second occurrence is proven inside the second code line",
		);

		const coloredTheme: MarkdownTheme = {
			...defaultMarkdownTheme,
			highlightCode: (code) => code.split("\n").map((line) => chalk.green(line)),
		};
		const colored = new Markdown(source, 0, 0, coloredTheme);
		expectPainted(colored, source, "needle", 44, 1);

		const rewrittenTheme: MarkdownTheme = {
			...defaultMarkdownTheme,
			highlightCode: (code) => code.split("\n").map((line) => line.toUpperCase()),
		};
		const rewritten = new Markdown(source, 0, 0, rewrittenTheme);
		expectUnproven(rewritten, source, "needle", 44, 1);

		const fence = new Markdown(source, 0, 0, defaultMarkdownTheme);
		expectUnproven(fence, source, "js", 44);
	});

	it("proves renderLatex:false inline and display math source text", () => {
		capabilities(false);
		const source = "$needle$ and \\(needle\\)\n\n$$\nneedle\n$$\n\n\\[\nneedle\n\\]";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme, undefined, { renderLatex: false });
		for (let occurrence = 0; occurrence < 4; occurrence++) {
			expectPainted(markdown, source, "needle", 44, occurrence);
		}
		expectUnproven(
			new Markdown("\\(needle and more", 0, 0, defaultMarkdownTheme, undefined, { renderLatex: false }),
			"\\(needle and more",
			"needle",
			44,
		);
	});

	it("returns every painted row when one occurrence spans a soft wrap", () => {
		capabilities(false);
		const source = "needleword";
		const markdown = new Markdown(source, 2, 0, defaultMarkdownTheme);
		const { proof } = expectPainted(markdown, source, "needleword", 12);
		assert.ok(proof.segments.length >= 2, "a wrapped occurrence returns one segment per painted row");
		const rows = proof.segments.map((segment) => segment.row);
		assert.deepStrictEqual(rows, [...new Set(rows)].sort((left, right) => left - right));
		assert.ok(rows.every((row, index) => index === 0 || row > rows[index - 1]!), "segments run row by row");
	});

	it("re-proves the same component after width changes", () => {
		capabilities(false);
		const source = "alpha beta needle gamma delta epsilon zeta";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		for (const width of [12, 44, 80, 120, 44]) {
			expectPainted(markdown, source, "needle", width);
		}
	});

	it("proves CJK, ZWJ and wide grapheme text without splitting a cluster", () => {
		capabilities(false);
		const source = "前缀**匹配词**后缀 家庭 👨‍👩‍👧 needle";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		for (const width of [12, 44, 80]) {
			expectPainted(markdown, source, "匹配词", width);
			expectPainted(markdown, source, "👨‍👩‍👧", width);
			expectPainted(markdown, source, "needle", width);
		}
	});

	it("proves table cell text, including a wrapped cell, and refuses a table fallback", () => {
		capabilities(false);
		const source = "| h |\n|---|\n| needlewordandsomeextralongtext |";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		expectPainted(markdown, source, "needlewordandsomeextralongtext", 12);
		expectUnproven(new Markdown(source, 0, 0, defaultMarkdownTheme), source, "needleword", 4);
	});

	it("reports markup-only delimiter ranges as not painted", () => {
		capabilities(false);
		const source = "before **needle** after";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		assert.deepStrictEqual(markdown.proveSourceSpan(rangeOf(source, "**"), 44), {
			kind: "NOT_PAINTED",
			reason: "MARKUP_ONLY",
		});
	});

	it("refuses ranges that are not one painted leaf", () => {
		capabilities(false);
		const image = "a ![alt text](x.png) b";
		expectUnproven(new Markdown(image, 0, 0, defaultMarkdownTheme), image, "alt text", 44);

		const html = "<div>needle</div>";
		expectUnproven(new Markdown(html, 0, 0, defaultMarkdownTheme), html, "needle", 44);

		const crossLeaf = "**ab** cd";
		expectUnproven(new Markdown(crossLeaf, 0, 0, defaultMarkdownTheme), crossLeaf, "ab** cd", 44);

		const escapes = "a \\*needle\\* b";
		expectUnproven(new Markdown(escapes, 0, 0, defaultMarkdownTheme), escapes, "\\*needle\\*", 44);

		const composite = "first needle\n\nsecond needle";
		const spanning = new Markdown(composite, 0, 0, defaultMarkdownTheme);
		const proof = expectUnproven(spanning, composite, "needle\n\nsecond", 44);
		assert.ok(
			proof.kind !== "UNPROVEN" || proof.reason !== "COMPOSITE_OWNER",
			"Markdown itself never claims composite-card authority",
		);
	});

	it("refuses invalid, shifted and grapheme-splitting ranges", () => {
		capabilities(false);
		const source = "a 😀 needle";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		assert.deepStrictEqual(markdown.proveSourceSpan({ start: 4, end: 4 }, 44), {
			kind: "UNPROVEN",
			reason: "SOURCE_PROJECTION",
		});
		assert.deepStrictEqual(markdown.proveSourceSpan({ start: -1, end: 2 }, 44), {
			kind: "UNPROVEN",
			reason: "SOURCE_PROJECTION",
		});
		assert.deepStrictEqual(markdown.proveSourceSpan({ start: 0, end: source.length + 1 }, 44), {
			kind: "UNPROVEN",
			reason: "SOURCE_PROJECTION",
		});
		const split = markdown.proveSourceSpan({ start: 3, end: 4 }, 44);
		assert.notStrictEqual(split.kind, "PROVEN");
	});

	it("keeps the normal render byte-identical and cached across a proof", () => {
		capabilities(false);
		const source = "before **needle** after\n\n- list\n\n```js\nconst x = 1;\n```";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		const rows = markdown.render(44);
		const snapshot = JSON.stringify(rows);
		assert.strictEqual(markdown.render(44), rows);
		expectPainted(markdown, source, "needle", 44);
		assert.strictEqual(markdown.render(44), rows, "the cached array is reused");
		assert.strictEqual(JSON.stringify(markdown.render(44)), snapshot, "the normal bytes are unchanged");
		assert.deepStrictEqual(rows, new Markdown(source, 0, 0, defaultMarkdownTheme).render(44));
		for (const row of rows) {
			assert.ok(!row.includes("\u200B") && !row.includes("\u200C"), "no proof sentinel reaches a normal row");
		}
	});

	it("drops stale proofs after setText and invalidate without stale ranges", () => {
		capabilities(false);
		const first = "needle one";
		const markdown = new Markdown(first, 0, 0, defaultMarkdownTheme);
		expectPainted(markdown, first, "needle", 80);
		markdown.setText("pre\nneedle");
		const stale = markdown.proveSourceSpan({ start: 0, end: 6 }, 80);
		assert.notStrictEqual(stale.kind, "PROVEN");
		expectPainted(markdown, "pre\nneedle", "needle", 80);
		markdown.invalidate();
		expectPainted(markdown, "pre\nneedle", "needle", 80);
	});

	it("returns STALE_RENDER across a capability change until invalidate()", () => {
		capabilities(false);
		const source = "[needle](https://x/y)";
		const markdown = new Markdown(source, 0, 0, defaultMarkdownTheme);
		markdown.render(44);
		expectPainted(markdown, source, "needle", 44);
		capabilities(true);
		assert.deepStrictEqual(markdown.proveSourceSpan(rangeOf(source, "needle"), 44), {
			kind: "UNPROVEN",
			reason: "STALE_RENDER",
		});
		markdown.invalidate();
		expectPainted(markdown, source, "needle", 44);
	});
});
