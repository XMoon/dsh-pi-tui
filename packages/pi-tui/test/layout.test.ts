import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { renderLayoutFrame } from "../src/layout.ts";
import { encodeKitty, registerKittyImageMetadata, type SixelScreenFootprint, type SixelScreenPort } from "../src/terminal-image.ts";
import { stripTerminalSequences, visibleWidth } from "../src/utils.ts";

function visibleLines(lines: string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trimEnd());
}

describe("viewport layout", () => {
	it("allocates vertical grow space deterministically", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("top", 0, 0), basis: 1, shrink: 0 },
				{ component: new Text("body", 0, 0), basis: 0, grow: 1 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["top", "body", "", ""]);
	});

	it("does not render fixed-basis scroll content during stack measurement", () => {
		let renderCount = 0;
		const transcript = new ScrollView({
			render: () => {
				renderCount += 1;
				return ["one", "two", "three"];
			},
			invalidate: () => {},
		});
		const root = new VStack([
			{ component: transcript, basis: 0, grow: 1 },
			{ component: new Text("dock", 0, 0), basis: "auto" },
		]);
		renderLayoutFrame(root, 10, 3, () => {});
		assert.strictEqual(renderCount, 1);
	});

	it("paints only clipped rows from very large scroll content", () => {
		const lineCount = 1_000_000_000;
		const lines: string[] = [];
		lines.length = lineCount;
		lines[lineCount - 4] = "before";
		lines[lineCount - 3] = "visible 1";
		lines[lineCount - 2] = "visible 2";
		lines[lineCount - 1] = "visible 3";
		const transcript = new ScrollView(
			{
				render: () => lines,
				invalidate: () => {},
			},
			{ follow: "end" },
		);

		const frame = renderLayoutFrame(transcript, 10, 3, () => {});
		assert.deepStrictEqual(visibleLines(frame.lines), ["visible 1", "visible 2", "visible 3"]);
	});

	it("shrinks entries to their minimum sizes", () => {
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("a1\na2\na3", 0, 0), shrink: 1, minSize: 1 },
				{ component: new Text("b1\nb2\nb3", 0, 0), shrink: 0 },
			]),
			10,
			4,
			() => {},
		);

		assert.deepStrictEqual(
			frame.root.children.map((child) => child.rect.height),
			[1, 3],
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["a1", "b1", "b2", "b3"]);
	});

	it("includes nested minimum sizes in intrinsic stack measurement", () => {
		const dock = new VStack([
			new Text("top1\ntop2\ntop3", 0, 0),
			{ component: new Text("selector", 0, 0), minSize: 3 },
			new Text("below", 0, 0),
			{ component: new Text("footer", 0, 0), minSize: 1 },
		]);
		const frame = renderLayoutFrame(
			new VStack([
				{ component: new Text("body", 0, 0), basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
			10,
			9,
			() => {},
		);

		assert.deepStrictEqual(visibleLines(frame.lines), [
			"body",
			"top1",
			"top2",
			"top3",
			"selector",
			"",
			"",
			"below",
			"footer",
		]);
	});

	it("omits gaps around invisible entries", () => {
		const stack = new VStack(
			[new Text("one", 0, 0), { component: new Text("hidden", 0, 0), visible: () => false }, new Text("two", 0, 0)],
			{ gap: 1 },
		);
		assert.deepStrictEqual(
			stack.render(10).map((line) => line.trimEnd()),
			["one", "", "two"],
		);
	});

	it("crops Kitty images at a scroll view's lower boundary", () => {
		const imageId = 124;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		const transcript = new ScrollView({
			render: () => ["one", "two", imageLine, "", ""],
			invalidate: () => {},
		});
		const frame = renderLayoutFrame(
			new VStack([{ component: transcript, basis: 0, grow: 1 }, new Text("dock", 0, 0)]),
			20,
			4,
			() => {},
		);

		assert.ok(frame.lines[2]?.includes("y=0,h=34,r=1"));
	});

	it("composes horizontal children at allocated widths", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("left", 0, 0), basis: 6, shrink: 0 },
				{ component: new Text("right", 0, 0), basis: 6, shrink: 0 },
			]),
			12,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["left  right"]);
	});

	it("does not paint zero-width horizontal children", () => {
		const frame = renderLayoutFrame(
			new HStack([
				{ component: new Text("hidden", 0, 0), basis: 0, shrink: 0 },
				{ component: new Text("shown", 0, 0), basis: 0, grow: 1 },
			]),
			5,
			1,
			() => {},
		);
		assert.deepStrictEqual(visibleLines(frame.lines), ["shown"]);
	});

	it("tracks follow-end state and returns unused scroll delta", () => {
		const scrollView = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0), {
			follow: "end",
			primary: true,
		});
		renderLayoutFrame(scrollView, 10, 3, () => {});
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);

		assert.strictEqual(scrollView.scrollBy(-2), 0);
		assert.strictEqual(scrollView.scrollTop, 1);
		assert.strictEqual(scrollView.isFollowingEnd, false);
		assert.strictEqual(scrollView.scrollBy(-3), -2);
		assert.strictEqual(scrollView.scrollTop, 0);
		assert.strictEqual(scrollView.scrollBy(10), 7);
		assert.strictEqual(scrollView.scrollTop, 3);
		assert.strictEqual(scrollView.isFollowingEnd, true);
	});

	it("(X055) a viewport growth does not re-arm follow-end after the user left the tail", () => {
		const scrollView = new ScrollView(new Text("x", 0, 0), { follow: "end", primary: true });
		// 10 content rows in a 3-row viewport: maxScrollTop 7, following the end.
		scrollView.updateLayout(10, 3, () => {});
		assert.strictEqual(scrollView.scrollTop, 7);
		assert.strictEqual(scrollView.isFollowingEnd, true);

		// The user scrolls up one row and leaves the tail.
		scrollView.scrollBy(-1);
		assert.strictEqual(scrollView.scrollTop, 6);
		assert.strictEqual(scrollView.isFollowingEnd, false);

		// Pinned chrome disappears: the viewport GROWS, maxScrollTop shrinks to
		// 5, and the clamped scroll lands exactly on the new maximum. The
		// content never changed, so follow-end must not re-arm.
		scrollView.updateLayout(10, 5, () => {});
		assert.strictEqual(scrollView.scrollTop, 5);
		assert.strictEqual(scrollView.isFollowingEnd, false);

		// A later passive repaint at the SAME geometry (no content growth) must
		// not re-arm either: the suppression is sticky until the user scrolls.
		scrollView.updateLayout(10, 5, () => {});
		assert.strictEqual(scrollView.scrollTop, 5);
		assert.strictEqual(scrollView.isFollowingEnd, false);

		// An explicit scroll-to-end clears the suppression and re-arms.
		scrollView.scrollToEnd();
		assert.strictEqual(scrollView.isFollowingEnd, true);
	});

	it("(X055) a content shrink still re-arms follow-end", () => {
		const scrollView = new ScrollView(new Text("x", 0, 0), { follow: "end", primary: true });
		scrollView.updateLayout(10, 5, () => {});
		scrollView.scrollBy(-1);
		assert.strictEqual(scrollView.isFollowingEnd, false);

		// The CONTENT shrinks (a fold) with the viewport unchanged: the clamped
		// position reaches the new maximum and follow-end re-arms.
		scrollView.updateLayout(4, 5, () => {});
		assert.strictEqual(scrollView.isFollowingEnd, true);
	});

	it("(X055) a simultaneous content shrink and viewport growth preserves the historical intent", () => {
		const scrollView = new ScrollView(new Text("x", 0, 0), { follow: "end", primary: true });
		scrollView.updateLayout(100, 20, () => {});
		scrollView.scrollBy(-1);
		assert.strictEqual(scrollView.isFollowingEnd, false);

		// Both happen in ONE layout pass: the content shrinks AND the viewport
		// grows. The viewport growth wins — a structural screen-capacity change
		// must not be read as "the user caught up to the tail" — so follow-end
		// must NOT re-arm and the historical intent is preserved.
		scrollView.updateLayout(50, 40, () => {});
		assert.strictEqual(scrollView.scrollTop, 10);
		assert.strictEqual(scrollView.isFollowingEnd, false);

		// A passive repaint at the same geometry stays historical too.
		scrollView.updateLayout(50, 40, () => {});
		assert.strictEqual(scrollView.isFollowingEnd, false);
	});

	it("renders a proportional glyph scrollbar with an expanded active thumb", async () => {
		const sourceLines = ["abcd界", "abcde2", "abcde3", "abcde4", "abcde5", "abcde6", "abcde7", "abcde8"];
		const contentBackground = "\x1b[42m";
		const trackColor = "\x1b[38;5;2m";
		const thumbColor = "\x1b[38;5;1m";
		const scrollbarTrackStyle = (text: string) => `${trackColor}${text}\x1b[39m`;
		const scrollbarThumbStyle = (text: string) => `${thumbColor}${text}\x1b[39m`;
		const content = new Text(sourceLines.join("\n"), 0, 0, (text) => `${contentBackground}${text}\x1b[49m`);
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
			scrollbarHideDelayMs: 10,
		});
		const render = () => renderLayoutFrame(scrollView, 6, 4, () => {}).lines;
		const visible = (lines: string[]) => lines.map(stripTerminalSequences);

		let lines = render();
		assert.deepStrictEqual(visible(lines), sourceLines.slice(0, 4));

		scrollView.scrollBy(2);
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde┃", "abcde┃", "abcde│"]);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(trackColor)),
			[true, false, false, true],
		);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(thumbColor)),
			[false, true, true, false],
		);

		scrollView.setScrollbarActive(true);
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde█", "abcde█", "abcde│"]);
		assert.deepStrictEqual(
			lines.map((line) => line.includes(thumbColor)),
			[false, true, true, false],
		);
		assert.ok(lines[1]!.lastIndexOf(contentBackground) < lines[1]!.lastIndexOf(thumbColor));

		scrollView.setScrollbarActive(false);
		await new Promise((resolve) => setTimeout(resolve, 30));
		lines = render();
		assert.deepStrictEqual(visible(lines), sourceLines.slice(2, 6));

		scrollView.scrollToEnd();
		lines = render();
		assert.deepStrictEqual(visible(lines), ["abcde│", "abcde│", "abcde┃", "abcde┃"]);

		scrollView.scrollToStart();
		lines = render();
		assert.strictEqual(visible(lines)[0], "abcd ┃");

		const followedContent = new Text(sourceLines.join("\n"), 0, 0);
		const followed = new ScrollView(followedContent, {
			follow: "end",
			scrollbar: "auto",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
		});
		renderLayoutFrame(followed, 6, 4, () => {});
		assert.strictEqual(followed.scrollTop, 4);
		followedContent.setText(`${sourceLines.join("\n")}\nabcde9`);
		const growthFrame = renderLayoutFrame(followed, 6, 4, () => {});
		assert.strictEqual(followed.scrollTop, 5);
		assert.ok(growthFrame.lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line))));

		const fittingContent = new Text("1\n2", 0, 0);
		const automatic = new ScrollView(fittingContent, { scrollbar: "auto", scrollbarThumbStyle });
		renderLayoutFrame(automatic, 6, 4, () => {});
		automatic.scrollBy(1);
		assert.ok(
			renderLayoutFrame(automatic, 6, 4, () => {}).lines.every((line) => !/[│┃]/.test(stripTerminalSequences(line))),
		);

		const alwaysFitting = new ScrollView(fittingContent, { scrollbar: "always", scrollbarThumbStyle });
		const alwaysFittingFrame = renderLayoutFrame(alwaysFitting, 6, 4, () => {});
		assert.strictEqual(alwaysFittingFrame.root.children[0]?.rect.width, 5);
		assert.ok(visible(alwaysFittingFrame.lines).every((line) => line.endsWith("┃")));

		const alwaysOverflowing = new ScrollView(content, {
			scrollbar: "always",
			scrollbarTrackStyle,
			scrollbarThumbStyle,
		});
		const alwaysOverflowingFrame = renderLayoutFrame(alwaysOverflowing, 6, 4, () => {});
		assert.strictEqual(alwaysOverflowingFrame.root.children[0]?.rect.width, 5);
		assert.strictEqual(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("┃")).length, 2);
		assert.strictEqual(visible(alwaysOverflowingFrame.lines).filter((line) => line.endsWith("│")).length, 2);
		for (const line of alwaysOverflowingFrame.lines) {
			const scrollbarStyleIndex = Math.max(line.lastIndexOf(trackColor), line.lastIndexOf(thumbColor));
			const reservedColumnResetIndex = line.lastIndexOf("\x1b[0m\x1b]8;;\x07", scrollbarStyleIndex);
			assert.ok(reservedColumnResetIndex > line.lastIndexOf(contentBackground));
		}

		const thumbHeightFor = (contentHeight: number) => {
			const sized = new ScrollView(new Text(Array.from({ length: contentHeight }, () => "x").join("\n"), 0, 0), {
				scrollbar: "auto",
				scrollbarThumbStyle,
			});
			renderLayoutFrame(sized, 6, 20, () => {});
			sized.scrollBy(1);
			return renderLayoutFrame(sized, 6, 20, () => {}).lines.filter((line) =>
				stripTerminalSequences(line).endsWith("┃"),
			).length;
		};
		assert.strictEqual(thumbHeightFor(21), 19);
		assert.strictEqual(thumbHeightFor(40), 10);
		assert.strictEqual(thumbHeightFor(100), 4);
		assert.strictEqual(thumbHeightFor(400), 2);
	});

	it("preserves only the underlying background beneath overlay scrollbar glyphs", () => {
		const background = "\x1b[42m";
		const borderForeground = "\x1b[31m";
		const content = {
			render: (width: number) =>
				Array.from(
					{ length: 8 },
					() => `${background}${"x".repeat(width - 1)}${borderForeground}│\x1b[39m\x1b[49m`,
				),
			invalidate: () => {},
		};
		const scrollView = new ScrollView(content, {
			scrollbar: "auto",
			scrollbarTrackStyle: (text) => text,
			scrollbarThumbStyle: (text) => text,
		});
		renderLayoutFrame(scrollView, 6, 4, () => {});
		scrollView.scrollBy(1);
		const frame = renderLayoutFrame(scrollView, 6, 4, () => {});

		assert.deepStrictEqual(frame.lines.map(stripTerminalSequences), ["xxxxx│", "xxxxx┃", "xxxxx┃", "xxxxx│"]);
		for (const line of frame.lines) {
			assert.ok(line.includes(background));
			assert.ok(!line.includes(borderForeground));
			assert.ok(line.includes(`\x1b[0m\x1b]8;;\x07${background}`));
		}
	});

	it("updates reserved scrollbar layout at runtime", () => {
		const scrollView = new ScrollView(new Text("123456", 0, 0), { scrollbar: "always" });
		const render = () => renderLayoutFrame(new HStack([scrollView], { align: "start" }), 6, 2, () => {});
		const always = render();
		assert.deepStrictEqual(visibleLines(always.lines), ["12345┃", "6    ┃"]);
		assert.strictEqual(always.root.children[0]?.rect.width, 6);
		assert.strictEqual(always.root.children[0]?.children[0]?.rect.width, 5);

		scrollView.setScrollbar("hidden");
		assert.strictEqual(render().root.children[0]?.children[0]?.rect.width, 6);
		assert.strictEqual(scrollView.isScrollbarVisible, false);
	});

	it("measures nested scroll content from constrained child geometry", () => {
		const inner = new ScrollView(new Text("1\n2\n3\n4\n5\n6", 0, 0));
		const outer = new ScrollView(new VStack([{ component: inner, basis: 2 }, new Text("tail", 0, 0)]));
		renderLayoutFrame(outer, 10, 2, () => {});

		assert.strictEqual(inner.viewportHeight, 2);
		assert.strictEqual(outer.scrollBy(10), 9);
		assert.strictEqual(outer.scrollTop, 1);
	});

	it("rebuilds geometry after content changes", () => {
		const text = new Text("one", 0, 0);
		const root = new VStack([text]);
		const first = renderLayoutFrame(root, 10, 4, () => {});
		text.setText("one\ntwo\nthree");
		const second = renderLayoutFrame(root, 10, 4, () => {});

		assert.strictEqual(first.root.children[0]?.lines?.length, 1);
		assert.strictEqual(second.root.children[0]?.lines?.length, 3);
	});
});

describe("Stack dispose clears both representations (X007 follow-up P2)", () => {
	let disposeCount = 0;
	const countingChild = {
		render: () => ["child"],
		invalidate: () => {},
		dispose: () => {
			disposeCount += 1;
		},
	};
	beforeEach(() => {
		disposeCount = 0;
	});
	// The layout entries mirror is the `entries` array the Stack feeds to
	// [LAYOUT_NODE]().entries (the fullscreen engine's representation).
	const layoutEntries = (stack: VStack | HStack): unknown[] =>
		(stack as unknown as { entries: unknown[] }).entries;

	it("VStack.dispose clears children AND the layout entries, disposing the child exactly once", () => {
		const stack = new VStack([countingChild]);
		assert.strictEqual(stack.children.length, 1);
		assert.strictEqual(layoutEntries(stack).length, 1);

		stack.dispose();
		assert.strictEqual(disposeCount, 1, "the child is disposed exactly once");
		assert.strictEqual(stack.children.length, 0, "Container.children must be cleared");
		assert.strictEqual(layoutEntries(stack).length, 0, "the layout entries must be cleared too");
	});

	it("a repeated dispose is idempotent for both representations", () => {
		const stack = new VStack([countingChild]);
		stack.dispose();
		stack.dispose();
		assert.strictEqual(disposeCount, 1, "a repeated dispose must not dispose the child again");
		assert.strictEqual(stack.children.length, 0);
		assert.strictEqual(layoutEntries(stack).length, 0, "entries stay empty after a repeated dispose");
	});

	it("HStack.dispose clears the layout entries too", () => {
		const stack = new HStack([countingChild]);
		stack.dispose();
		assert.strictEqual(disposeCount, 1);
		assert.strictEqual(stack.children.length, 0);
		assert.strictEqual(layoutEntries(stack).length, 0);
	});

	it("the fullscreen layout engine never re-layouts disposed stack children", () => {
		const stack = new VStack([
			{ component: countingChild, basis: 1, shrink: 0 },
			{ component: new Text("gone", 0, 0), basis: 1, shrink: 0 },
		]);
		stack.dispose();
		// The disposed stack renders an empty frame — its stale entries can
		// no longer be observed/layouted by the fullscreen engine.
		const frame = renderLayoutFrame(stack, 10, 4, () => {});
		assert.deepStrictEqual(
			frame.lines.map((line) => line.trimEnd()),
			["", "", "", ""],
			"the disposed stack must paint nothing",
		);
	});
});


describe("virtual placement clipping", () => {
	const placeholder = "\u{10eeee}";
	const marker = (imageId: number): string => `\x1b_pi:tmux-image:v1:i=${imageId},p=1\x1b\\`;
	const anchor = (imageId: number, rows = 3): string =>
		`\x1b_Ga=p,U=1,i=${imageId},p=1,c=2,r=${rows},q=2;\x1b\\`;
	const grid = (row: number, imageId = 42): string =>
		`\x1b[38;2;0;0;${imageId & 0xff}m\x1b[58:2::0:0:1m${placeholder}${row}${placeholder}${row}\x1b[39;59m`;
	const managed = (imageId = 42, rows = 3): string => marker(imageId) + anchor(imageId, rows) + grid(0, imageId);

	function frameFor(lines: string[], viewportHeight: number, scrollTop: number) {
		const scroll = new ScrollView({ render: () => lines, invalidate: () => {} }, { primary: true, follow: "none" });
		scroll.updateLayout(lines.length, viewportHeight, () => {});
		scroll.scrollTo(scrollTop);
		return { scroll, frame: renderLayoutFrame(scroll, 20, viewportHeight, () => {}) };
	}

	it("relocates the clipped managed anchor onto the first visible placeholder row", () => {
		const imageAnchor = anchor(42, 3);
		const lines = ["l0", "l1", managed(42, 3), grid(1), grid(2), "tail"];
		const { frame } = frameFor(lines, 3, 3);

		assert.ok(frame.lines[0]!.startsWith(imageAnchor), "the first visible row carries the exact anchor bytes");
		assert.ok(frame.lines[0]!.includes(grid(1)), "the moved anchor sits on the first visible placeholder row");
		assert.strictEqual((frame.lines.join("").match(/\x1b_Ga=p,U=1/g) ?? []).length, 1, "exactly one anchor in the frame");
		assert.strictEqual(visibleWidth(frame.lines[0]!), visibleWidth(grid(1)), "the APC adds no visible width");
		assert.ok(!frame.lines[0]!.includes("pi:tmux-image"), "the private marker never reaches the painted frame");
	});

	it("leaves a visible managed anchor in place and strips its private marker", () => {
		const imageAnchor = anchor(42, 3);
		const lines = ["l0", "l1", managed(42, 3), grid(1), grid(2), "tail"];
		const { frame } = frameFor(lines, 3, 2);

		assert.ok(frame.lines[0]!.startsWith(imageAnchor), "the original anchor row is painted");
		assert.strictEqual((frame.lines.join("").match(/\x1b_Ga=p,U=1/g) ?? []).length, 1, "no duplicate anchor");
		assert.ok(!frame.lines.join("").includes("pi:tmux-image"), "a visible anchor's marker is stripped");
	});

	it("does not relocate when no same-image placeholder row is visible", () => {
		const lines = ["l0", "l1", managed(42, 3), grid(1), grid(2), "tail"];
		const { frame } = frameFor(lines, 2, 0);

		assert.strictEqual((frame.lines.join("").match(/\x1b_Ga=p,U=1/g) ?? []).length, 0);
	});

	it("does not relocate a complete foreign virtual image that has no provenance marker", () => {
		const foreignAnchor = anchor(99, 3);
		const lines = ["l0", "l1", foreignAnchor + grid(0, 99), grid(1, 99), grid(2, 99), "tail"];
		const { frame } = frameFor(lines, 3, 3);

		assert.strictEqual((frame.lines.join("").match(/\x1b_Ga=p,U=1/g) ?? []).length, 0,
			"a foreign virtual anchor+grid must be left to the original layout");
	});

	it("relocates the managed image but leaves an adjacent foreign virtual anchor untouched", () => {
		const imageAnchor = anchor(42, 2);
		const foreignAnchor = anchor(99, 2);
		const lines = [managed(42, 2), grid(1, 42), foreignAnchor + grid(0, 99), grid(1, 99)];
		const { frame } = frameFor(lines, 2, 1);

		assert.ok(frame.lines[0]!.startsWith(imageAnchor), "the managed anchor is moved to its visible row");
		assert.ok(frame.lines[1]!.startsWith(foreignAnchor), "the foreign anchor stays on its original row");
		assert.strictEqual((frame.lines.join("").match(/\x1b_Ga=p,U=1/g) ?? []).length, 2,
			"one moved managed anchor plus the untouched foreign anchor");
	});

	it("fails fast when a marker and its adjacent anchor name different ids", () => {
		const mismatched = marker(42) + anchor(99, 2) + grid(0, 99);
		assert.throws(() => frameFor(["l0", "l1", mismatched, grid(1, 99), grid(2, 99), "tail"], 3, 3),
			/does not match its placement anchor/);
	});

	it("fails fast instead of leaking a malformed marker", () => {
		const malformed = "\x1b_pi:tmux-image:v1:i=42,p=1" + anchor(42, 2) + grid(0, 42);
		assert.throws(() => frameFor(["l0", "l1", malformed, grid(1, 42), grid(2, 42), "tail"], 3, 3),
			/managed kitty virtual marker is malformed/);
	});

	it("does not move an anchor onto a placeholder row that names another image", () => {
		const lines = ["l0", "l1", managed(42, 3), grid(1, 99), grid(2, 42), "tail"];
		const { frame } = frameFor(lines, 3, 3);

		assert.strictEqual((frame.lines.join("").match(/\x1b_Ga=p,U=1/g) ?? []).length, 0,
			"a color/identity mismatch must not adopt another image's cells");
	});

	it("does not move a bare anchor line that has no marker or placeholder cell of its own", () => {
		const imageAnchor = anchor(42, 2);
		const lines = ["l0", "l1", imageAnchor, grid(0), grid(1), "tail"];
		const { frame } = frameFor(lines, 3, 3);

		assert.strictEqual((frame.lines.join("").match(/\x1b_Ga=p,U=1/g) ?? []).length, 0,
			"a foreign anchor-only line is left to the original layout");
	});

	it("relocates an anchor that is exactly the maximum 297 rows above the viewport", () => {
		const lines = [
			managed(42, 297),
			...Array.from({ length: 296 }, (_, index) => grid(index + 1)),
			...Array.from({ length: 5 }, (_, index) => `tail ${index}`),
		];
		const { frame } = frameFor(lines, 3, 296);

		assert.ok(frame.lines[0]!.startsWith(anchor(42, 297)), "the 297-row window still finds the anchor");
		assert.ok(frame.lines[0]!.includes(grid(296)));
	});
});

describe("trusted SIXEL screen port (X074)", () => {
	/** A complete DCS the port below is the only thing that may recognize. */
	const raster = (id: string): string => `\x1bP0;1;q"1;1;40;36#0;2;100;0;0${id}\x1b\\`;
	/** The bounded variant the owner would have encoded for a crop request. */
	const variant = (id: string, cropTopRows: number, visibleRows: number): string =>
		`\x1bP0;1;q"1;1;40;6#0;2;100;0;0${id}:${cropTopRows}:${visibleRows}\x1b\\`;

	class RecordingSixelPort implements SixelScreenPort {
		readonly rasters = new Map<string, SixelScreenFootprint>();
		readonly crops = new Map<string, string>();
		readonly requests: Array<[string, number, number]> = [];
		/** When false the port has no ready variant (it would schedule one). */
		ready = true;

		register(dcs: string, footprint: SixelScreenFootprint): string {
			this.rasters.set(dcs, footprint);
			return dcs;
		}

		footprint(line: string): SixelScreenFootprint | undefined {
			return this.rasters.get(line);
		}

		crop(line: string, cropTopRows: number, visibleRows: number): string | undefined {
			this.requests.push([line, cropTopRows, visibleRows]);
			if (!this.ready) return undefined;
			const key = `${line}\u0000${cropTopRows}\u0000${visibleRows}`;
			const cached = this.crops.get(key);
			if (cached !== undefined) return cached;
			const created = variant("V", cropTopRows, visibleRows);
			this.rasters.set(created, { columns: 4, rows: visibleRows });
			this.crops.set(key, created);
			return created;
		}
		candidate(_line: string): undefined {
			return undefined;
		}

		reconcileVisible(_screen: object, _demands: readonly SixelVisibleCandidate[]): boolean {
			return false;
		}

		materialize(_line: string, _cropTopRows: number, _visibleRows: number): string | undefined {
			return undefined;
		}

		framePainted(_screen: object, _retained: readonly SixelFrameRaster[]): void {}
	}

	function frameWith(port: RecordingSixelPort, lines: string[], width: number, height: number, scrollTop: number) {
		const scroll = new ScrollView({ render: () => lines, invalidate: () => {} }, { primary: true, follow: "none" });
		scroll.updateLayout(lines.length, height, () => {});
		scroll.scrollTo(scrollTop);
		return renderLayoutFrame(scroll, width, height, () => {}, port);
	}

	it("bottom-clips a visible anchor through the port instead of cutting the DCS", () => {
		const port = new RecordingSixelPort();
		const dcs = port.register(raster("A"), { columns: 4, rows: 3 });
		const frame = frameWith(port, ["a", "b", dcs, "", "", "tail"], 20, 4, 0);

		assert.deepStrictEqual(port.requests, [[dcs, 0, 2]], "the Screen asks for two visible rows, from the top");
		assert.strictEqual(frame.lines[2], variant("V", 0, 2), "the painted row is the ready VARIANT");
		assert.ok(!frame.lines.join("").includes(dcs), "the unclipped command is never painted");
	});

	it("paints nothing at the anchor while the variant is not ready", () => {
		const port = new RecordingSixelPort();
		port.ready = false;
		const dcs = port.register(raster("B"), { columns: 4, rows: 3 });
		const frame = frameWith(port, ["a", "b", dcs, "", "", "tail"], 20, 4, 0);

		assert.deepStrictEqual(port.requests, [[dcs, 0, 2]]);
		assert.strictEqual(frame.lines[2], "", "an unready variant leaves the row empty, never clipped bytes");
	});

	it("re-encodes an anchor that scrolled above the viewport with its real top crop", () => {
		const port = new RecordingSixelPort();
		const dcs = port.register(raster("C"), { columns: 4, rows: 3 });
		const frame = frameWith(port, ["a", dcs, "", "", "tail"], 20, 2, 2);

		assert.deepStrictEqual(port.requests, [[dcs, 1, 2]], "one hidden row, two visible rows");
		assert.strictEqual(frame.lines[0], variant("V", 1, 2), "the variant is painted on the first visible row");
		assert.ok(!frame.lines.join("").includes(dcs));
	});

	it("refuses a horizontally offset box instead of compositing the command as text", () => {
		const port = new RecordingSixelPort();
		const dcs = port.register(raster("D"), { columns: 4, rows: 3 });
		const inner = { render: () => [dcs, "", ""], invalidate: () => {} };
		const root = new HStack([{ component: new Text("left", 0, 0), basis: 3 }, { component: inner, basis: 0, grow: 1 }]);
		const frame = renderLayoutFrame(root, 20, 4, () => {}, port);

		assert.deepStrictEqual(port.requests, [], "no crop is scheduled for an unpaintable box");
		assert.ok(!frame.lines.join("").includes(dcs), "the DCS is dropped, never sliced into a cell row");
	});

	it("keeps a non-overlapping SIXEL anchor when an auto scrollbar is visible", () => {
		const port = new RecordingSixelPort();
		const dcs = port.register(raster("E"), { columns: 4, rows: 3 });
		const scroll = new ScrollView(
			{ render: () => ["a", dcs, "", "", "tail"], invalidate: () => {} },
			{ primary: true, follow: "none", scrollbar: "auto" },
		);
		scroll.updateLayout(5, 4, () => {});
		scroll.scrollTo(0);
		scroll.setScrollbarActive(true);
		assert.strictEqual(scroll.isScrollbarVisible, true, "the auto scrollbar is really visible");

		const frame = renderLayoutFrame(scroll, 20, 4, () => {}, port);
		assert.strictEqual(frame.lines[1], dcs, "the trusted DCS remains intact on its anchor row");
		assert.ok(frame.lines[1]!.startsWith("\x1bP") && frame.lines[1]!.endsWith("\x1b\\"), "the DCS is never sliced");
		assert.ok(
			frame.lines.some((line, row) => row !== 1 && stripTerminalSequences(line).trimEnd().endsWith("│")),
			"other track rows still paint the scrollbar",
		);
	});

	it("still withholds an overlapping SIXEL anchor from the scrollbar column", () => {
		const port = new RecordingSixelPort();
		const dcs = port.register(raster("F"), { columns: 20, rows: 3 });
		const scroll = new ScrollView(
			{ render: () => ["a", dcs, "", "", "tail"], invalidate: () => {} },
			{ primary: true, follow: "none", scrollbar: "auto" },
		);
		scroll.updateLayout(5, 4, () => {});
		scroll.scrollTo(0);
		scroll.setScrollbarActive(true);

		const frame = renderLayoutFrame(scroll, 20, 4, () => {}, port);
		assert.ok(!frame.lines.join("").includes(dcs), "the overlapping DCS is withheld");
		assert.ok(!frame.lines.join("").includes("\x1bP"), "no truncated SIXEL fragment is emitted");
		assert.ok(frame.lines.some((line) => stripTerminalSequences(line).trimEnd().endsWith("│")), "the scrollbar is still painted");

		// A very narrow auto track is a real horizontal overlap too: fail closed.
		const narrowPort = new RecordingSixelPort();
		const narrowDcs = narrowPort.register(raster("G"), { columns: 2, rows: 1 });
		const narrow = new ScrollView(
			{ render: () => [narrowDcs, "x", "y", "z"], invalidate: () => {} },
			{ primary: true, follow: "none", scrollbar: "auto" },
		);
		narrow.updateLayout(4, 2, () => {});
		narrow.scrollTo(0);
		narrow.setScrollbarActive(true);
		const narrowFrame = renderLayoutFrame(narrow, 2, 2, () => {}, narrowPort);
		assert.ok(!narrowFrame.lines.join("").includes(narrowDcs), "a narrow raster reaching the track column is withheld");
	});
});
