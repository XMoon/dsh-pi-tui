import type { ScrollView } from "./components/scroll-view.ts";
import { allocateStackSizes, visibleStackEntries } from "./components/stack.ts";
import { getLayoutNode } from "./layout-node.ts";
import {
	cropKittyImageLine,
	getKittyImageMetadata,
	MANAGED_KITTY_VIRTUAL_MARKER_PREFIX,
	getKittyVirtualPlacementAnchor,
	getManagedKittyVirtualMarker,
	isImageLine,
	isKittyVirtualPlaceholderLine,
	matchesKittyVirtualPlaceholderIdentity,
	type SixelScreenPort,
	type SixelVisibleCandidate,
} from "./terminal-image.ts";
import { type Component, CURSOR_MARKER, compositeTuiLine } from "./tui.ts";
import {
	extractAnsiCode,
	getActiveBackgroundAnsi,
	getGraphemeCellRange,
	sliceByColumn,
	visibleWidth,
} from "./utils.ts";

const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:\x07|\x1b\\))+/;

export interface LayoutRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LayoutBox {
	component: Component;
	rect: LayoutRect;
	clip: LayoutRect;
	children: LayoutBox[];
	parent?: LayoutBox;
	lines?: readonly string[];
	lineOffset?: number;
	scrollView?: ScrollView;
	scrollContentLines?: readonly string[];
	layer: number;
}

export interface LayoutFrame {
	root: LayoutBox;
	width: number;
	height: number;
	lines: string[];
	primaryScrollView?: ScrollView;
	/** The visible SIXEL candidates this frame's final layout really shows (X072/X074). */
	sixelDemands: SixelVisibleCandidate[];
}

export interface ScrollbarGeometry {
	column: number;
	trackTop: number;
	trackHeight: number;
	thumbTop: number;
	thumbHeight: number;
	maxScrollTop: number;
}

interface LayoutContext {
	viewport: { width: number; height: number };
	renderCache: Map<Component, Map<number, string[]>>;
	/** Max visible line width per (component, width), for measureWidth. (dsh-pi-tui divergence X014.) */
	maxWidthCache: Map<Component, Map<number, number>>;
	requestRender: () => void;
	primaryScrollView: ScrollView | undefined;
	/** The Client-local SIXEL trust port (X072), or undefined. */
	sixelScreen: SixelScreenPort | undefined;
	/** Visible candidates collected while painting this frame. */
	sixelDemands: SixelVisibleCandidate[];
}

/** The largest number of image body rows an upward crop search may cross (X074). */
const MAX_SIXEL_CROP_SCAN_ROWS = 12;

function intersect(a: LayoutRect, b: LayoutRect): LayoutRect {
	const x = Math.max(a.x, b.x);
	const y = Math.max(a.y, b.y);
	const right = Math.min(a.x + a.width, b.x + b.width);
	const bottom = Math.min(a.y + a.height, b.y + b.height);
	return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function renderCached(context: LayoutContext, component: Component, width: number): string[] {
	const safeWidth = Math.max(1, Math.floor(width));
	let widths = context.renderCache.get(component);
	if (!widths) {
		widths = new Map<number, string[]>();
		context.renderCache.set(component, widths);
	}
	let lines = widths.get(safeWidth);
	if (!lines) {
		lines = component.render(safeWidth);
		widths.set(safeWidth, lines);
	}
	return lines;
}

function measureHeight(context: LayoutContext, component: Component, width: number): number {
	return renderCached(context, component, width).length;
}

function measureWidth(context: LayoutContext, component: Component, width: number): number {
	const safeWidth = Math.max(1, Math.floor(width));
	let widths = context.maxWidthCache.get(component);
	if (!widths) {
		widths = new Map<number, number>();
		context.maxWidthCache.set(component, widths);
	}
	let max = widths.get(safeWidth);
	if (max === undefined) {
		// Scan the cached lines once per (component, width) per frame instead
		// of re-running visibleWidth over them at every call site.
		// (dsh-pi-tui divergence X014.)
		max = renderCached(context, component, safeWidth).reduce((m, line) => Math.max(m, visibleWidth(line)), 0);
		widths.set(safeWidth, max);
	}
	return max;
}

function withParent(box: LayoutBox, parent: LayoutBox): LayoutBox {
	box.parent = parent;
	return box;
}

function translateBox(box: LayoutBox, deltaY: number): void {
	box.rect.y += deltaY;
	for (const child of box.children) translateBox(child, deltaY);
}

function updateClips(box: LayoutBox, parentClip: LayoutRect): void {
	box.clip = intersect(parentClip, box.rect);
	for (const child of box.children) updateClips(child, box.clip);
}

function layoutComponent(
	context: LayoutContext,
	component: Component,
	x: number,
	y: number,
	width: number,
	height: number | undefined,
	clip: LayoutRect,
): LayoutBox {
	const safeWidth = Math.max(1, Math.floor(width));
	const node = getLayoutNode(component);
	if (!node) {
		const lines = renderCached(context, component, safeWidth);
		const allocatedHeight = height === undefined ? lines.length : Math.max(0, Math.floor(height));
		let lineOffset = 0;
		if (lines.length > allocatedHeight && allocatedHeight > 0) {
			const cursorLine = lines.findIndex((line) => line.includes(CURSOR_MARKER));
			if (cursorLine >= allocatedHeight) lineOffset = cursorLine - allocatedHeight + 1;
		}
		return {
			component,
			rect: { x, y, width: safeWidth, height: allocatedHeight },
			clip: intersect(clip, { x, y, width: safeWidth, height: allocatedHeight }),
			children: [],
			lines,
			lineOffset,
			layer: 0,
		};
	}

	if (node.type === "scroll") {
		const previousScrollTop = node.state.scrollTop;
		const contentWidth = node.state.getContentWidth(safeWidth);
		const childBox = layoutComponent(
			context,
			node.component,
			x,
			y - previousScrollTop,
			contentWidth,
			undefined,
			clip,
		);
		const contentHeight = childBox.rect.height;
		const viewportHeight = height === undefined ? contentHeight : Math.max(0, Math.floor(height));
		node.state.updateLayout(contentHeight, viewportHeight, context.requestRender);
		translateBox(childBox, previousScrollTop - node.state.scrollTop);
		const scrollView = node.state as ScrollView;
		if (node.state.primary || !context.primaryScrollView) context.primaryScrollView = scrollView;
		const rect = { x, y, width: safeWidth, height: viewportHeight };
		const childClip = intersect(clip, rect);
		const box: LayoutBox = {
			component,
			rect,
			clip: childClip,
			children: [childBox],
			scrollView,
			scrollContentLines: renderCached(context, node.component, contentWidth),
			layer: 0,
		};
		childBox.parent = box;
		updateClips(childBox, childClip);
		return box;
	}

	const entries = visibleStackEntries(node.entries, context.viewport);
	const gapTotal = Math.max(0, entries.length - 1) * node.gap;
	if (node.type === "vstack") {
		const intrinsicHeights = entries.map((entry) =>
			typeof entry.basis === "number" ? entry.basis : measureHeight(context, entry.component, safeWidth),
		);
		const sizes = allocateStackSizes(entries, intrinsicHeights, height, node.gap);
		const naturalHeight = sizes.reduce((sum, size) => sum + size, 0) + gapTotal;
		const allocatedHeight = height === undefined ? naturalHeight : Math.max(0, Math.floor(height));
		const rect = { x, y, width: safeWidth, height: allocatedHeight };
		const box: LayoutBox = {
			component,
			rect,
			clip: intersect(clip, rect),
			children: [],
			layer: 0,
		};
		let childY = y;
		for (let index = 0; index < entries.length; index++) {
			box.children.push(
				withParent(
					layoutComponent(context, entries[index]!.component, x, childY, safeWidth, sizes[index]!, box.clip),
					box,
				),
			);
			childY += sizes[index]! + node.gap;
		}
		return box;
	}

	const intrinsicWidths = entries.map((entry) =>
		typeof entry.basis === "number" ? entry.basis : measureWidth(context, entry.component, safeWidth),
	);
	const widths = allocateStackSizes(entries, intrinsicWidths, safeWidth, node.gap);
	const intrinsicHeights = entries.map((entry, index) =>
		measureHeight(context, entry.component, Math.max(1, widths[index]!)),
	);
	const allocatedHeight =
		height === undefined
			? intrinsicHeights.reduce((max, childHeight) => Math.max(max, childHeight), 0)
			: Math.max(0, height);
	const rect = { x, y, width: safeWidth, height: allocatedHeight };
	const box: LayoutBox = {
		component,
		rect,
		clip: intersect(clip, rect),
		children: [],
		layer: 0,
	};
	let childX = x;
	for (let index = 0; index < entries.length; index++) {
		const naturalChildHeight = intrinsicHeights[index]!;
		const childHeight = node.align === "stretch" ? allocatedHeight : Math.min(allocatedHeight, naturalChildHeight);
		let childY = y;
		if (node.align === "center") childY += Math.floor((allocatedHeight - childHeight) / 2);
		else if (node.align === "end") childY += allocatedHeight - childHeight;
		const childWidth = widths[index]!;
		if (childWidth === 0) {
			box.children.push({
				component: entries[index]!.component,
				rect: { x: childX, y: childY, width: 0, height: childHeight },
				clip: { x: childX, y: childY, width: 0, height: 0 },
				children: [],
				parent: box,
				layer: 0,
			});
		} else {
			box.children.push(
				withParent(
					layoutComponent(context, entries[index]!.component, childX, childY, childWidth, childHeight, box.clip),
					box,
				),
			);
		}
		childX += childWidth + node.gap;
	}
	return box;
}

function replaceScrollbarCell(
	line: string,
	column: number,
	totalWidth: number,
	replacement: string,
	preserveTargetBackground: boolean,
): string {
	if (isImageLine(line)) return line;

	const graphemeRange = getGraphemeCellRange(line, column);
	const start = graphemeRange?.start ?? column;
	const end = graphemeRange?.end ?? column + 1;
	const before = sliceByColumn(line, 0, start, true);
	const target = sliceByColumn(line, start, end - start, true);
	const after = sliceByColumn(line, end, Math.max(0, totalWidth - end), true);

	let targetPrefix = "";
	let targetIndex = 0;
	while (targetIndex < target.length) {
		const ansi = extractAnsiCode(target, targetIndex);
		if (!ansi) break;
		targetPrefix += ansi.code;
		targetIndex += ansi.length;
	}
	const beforePadding = " ".repeat(Math.max(0, start - visibleWidth(before)));
	const cellPaddingBefore = " ".repeat(Math.max(0, column - start));
	const cellPaddingAfter = " ".repeat(Math.max(0, end - column - 1));
	const targetStyle = `\x1b[0m\x1b]8;;\x07${preserveTargetBackground ? getActiveBackgroundAnsi(targetPrefix) : ""}`;
	return `${before}${beforePadding}${targetStyle}${cellPaddingBefore}${replacement}${cellPaddingAfter}${after}`;
}

export function getScrollbarGeometry(box: LayoutBox, includeHiddenAuto = false): ScrollbarGeometry | undefined {
	if (!box.scrollView || box.rect.width <= 0 || box.rect.height <= 0) return undefined;

	const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines?.length ?? 0;
	const trackHeight = box.rect.height;
	const canRevealHiddenAuto = includeHiddenAuto && box.scrollView.scrollbar === "auto" && contentHeight > trackHeight;
	if (!box.scrollView.isScrollbarVisible && !canRevealHiddenAuto) return undefined;

	const minThumbHeight = Math.min(2, trackHeight);
	const thumbHeight = Math.max(
		minThumbHeight,
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
	);
	const maxScrollTop = Math.max(0, contentHeight - trackHeight);
	const maxThumbTop = trackHeight - thumbHeight;
	const thumbOffset = maxScrollTop === 0 ? 0 : Math.round((box.scrollView.scrollTop / maxScrollTop) * maxThumbTop);
	const column = box.rect.x + box.rect.width - 1;
	if (column < box.clip.x || column >= box.clip.x + box.clip.width) return undefined;

	return {
		column,
		trackTop: box.rect.y,
		trackHeight,
		thumbTop: box.rect.y + thumbOffset,
		thumbHeight,
		maxScrollTop,
	};
}

function paintScrollbar(
	box: LayoutBox,
	screen: string[],
	totalWidth: number,
	sixelScreen: SixelScreenPort | undefined,
): void {
	const geometry = getScrollbarGeometry(box);
	if (!geometry || !box.scrollView) return;

	for (let offset = 0; offset < geometry.trackHeight; offset++) {
		const row = geometry.trackTop + offset;
		if (row < box.clip.y || row >= box.clip.y + box.clip.height || row < 0 || row >= screen.length) continue;
		const isThumb = row >= geometry.thumbTop && row < geometry.thumbTop + geometry.thumbHeight;
		const replacement = isThumb
			? box.scrollView.scrollbarThumbStyle(box.scrollView.isScrollbarActive ? "█" : "┃")
			: box.scrollView.scrollbarTrackStyle("│");
		// A trusted SIXEL anchor is a device command: slicing it to place one glyph
		// would emit a corrupted command, so the glyph is drawn on a blank row
		// instead and the caller has already withheld the block's DCS because its
		// columns reach this reserved column. (X074.)
		const base = sixelScreen?.footprint(screen[row] ?? "") === undefined ? (screen[row] ?? "") : "";
		screen[row] = replaceScrollbarCell(
			base,
			geometry.column,
			totalWidth,
			replacement,
			box.scrollView.scrollbar !== "always",
		);
	}
}

/** The managed virtual image row bound; only this window may be scanned. */
const MAX_RELOCATABLE_VIRTUAL_ROWS = 297;

interface RelocatedVirtualAnchor {
	/** The source line index that must receive the anchor in this frame. */
	readonly sourceIndex: number;
	/** The exact source anchor APC; never a rebuilt command. */
	readonly sequence: string;
}

/**
 * Preserve ONE managed virtual placement whose anchor line is vertically
 * clipped above this box's visible range. The only legal relocation target is
 * the first really visible placeholder row of the SAME image block. The
 * anchor bytes are reused verbatim; this helper invents no geometry, id or
 * extra row. It scans at most the 297-row component bound above the first
 * visible source line, so a viewport scroll never scans the whole transcript.
 */
function findRelocatedVirtualAnchor(
	box: LayoutBox,
	firstRow: number,
	lastRow: number,
): RelocatedVirtualAnchor | undefined {
	if (box.lines === undefined || firstRow >= lastRow) return undefined;
	const offset = box.lineOffset ?? 0;
	const firstSource = offset + firstRow - box.rect.y;
	const lastSource = offset + lastRow - 1 - box.rect.y;
	if (firstSource <= 0 || firstSource > lastSource) return undefined;
	const firstLine = box.lines[firstSource];
	// A visible Native image line, an already-anchored line, or a non-placeholder
	// line is never a relocation target.
	if (firstLine === undefined || isImageLine(firstLine) || !isKittyVirtualPlaceholderLine(firstLine)) return undefined;
	const scanStart = Math.max(0, firstSource - MAX_RELOCATABLE_VIRTUAL_ROWS);
	for (let index = firstSource - 1; index >= scanStart; index--) {
		const line = box.lines[index];
		if (line === undefined) continue;
		const marker = getManagedKittyVirtualMarker(line);
		if (marker === undefined) {
			if (line.startsWith(MANAGED_KITTY_VIRTUAL_MARKER_PREFIX)) {
				throw new Error("managed kitty virtual marker is malformed");
			}
			continue;
		}
		const anchor = getKittyVirtualPlacementAnchor(line.slice(marker.sequence.length));
		if (
			anchor === undefined
			|| anchor.imageId !== marker.imageId
			|| anchor.placementId !== marker.placementId
		) {
			throw new Error("managed kitty virtual marker does not match its placement anchor");
		}
		// Our managed component keeps the row-0 placeholder cells on the anchor
		// line itself. A different producer's bare anchor remains untouched.
		if (!isKittyVirtualPlaceholderLine(line)) continue;
		if (index + anchor.rows - 1 < firstSource) continue;
		if (!matchesKittyVirtualPlaceholderIdentity(firstLine, anchor.imageId, anchor.placementId)) continue;
		return { sourceIndex: firstSource, sequence: anchor.sequence };
	}
	return undefined;
}

/**
 * Paint one box's own lines, then its children, then its scrollbar.
 *
 * A trusted SIXEL raster may only be painted in a full-width box at x=0 whose
 * clip still contains its visible part. Everything else paints NO pixels this
 * frame — a DCS is never sliced, shifted or reflowed like text. The scrollbar
 * pass owns the same rule from the other side: a reserved column replaces the
 * anchor with its glyph instead of cutting the command. (X074.)
 */
/** One SIXEL block in a component's lines: a candidate marker or a trusted DCS. */
type SixelBlock =
	| { readonly kind: "candidate"; readonly rows: number; readonly fallback: string }
	| { readonly kind: "dcs"; readonly rows: number };

function sixelBlock(line: string, port: SixelScreenPort | undefined): SixelBlock | undefined {
	if (port === undefined) return undefined;
	const candidate = port.candidate(line);
	if (candidate !== undefined) return { kind: "candidate", rows: candidate.layoutRows, fallback: candidate.fallback };
	const footprint = port.footprint(line);
	if (footprint !== undefined) return { kind: "dcs", rows: footprint.rows };
	return undefined;
}

function paintBox(
	box: LayoutBox,
	screen: string[],
	totalWidth: number,
	context: LayoutContext,
): void {
	const sixelScreen = context.sixelScreen;
	if (box.lines) {
		const offset = box.lineOffset ?? 0;
		const firstRow = Math.max(box.rect.y, box.clip.y, 0);
		const lastRow = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, screen.length);
		const relocated = findRelocatedVirtualAnchor(box, firstRow, lastRow);
		for (let row = firstRow; row < lastRow; row++) {
			const sourceIndex = offset + row - box.rect.y;
			const sourceLine = box.lines[sourceIndex];
			if (sourceLine === undefined) continue;
			let line = sourceLine.replace(OSC133_ZONE_PREFIX, "");
			if (line.startsWith(MANAGED_KITTY_VIRTUAL_MARKER_PREFIX)) {
				const marker = getManagedKittyVirtualMarker(line);
				if (marker === undefined) {
					throw new Error("managed kitty virtual marker is malformed");
				}
				const anchor = getKittyVirtualPlacementAnchor(line.slice(marker.sequence.length));
				if (
					anchor === undefined
					|| anchor.imageId !== marker.imageId
					|| anchor.placementId !== marker.placementId
				) {
					throw new Error("managed kitty virtual marker does not match its placement anchor");
				}
				line = line.slice(marker.sequence.length);
			}
			if (relocated !== undefined && sourceIndex === relocated.sourceIndex) line = relocated.sequence + line;
			const block = sixelBlock(line, sixelScreen);
			if (block !== undefined) {
				// A reserved scrollbar column owns this row: `paintScrollbar` draws its
				// glyph onto a blank base, so the block yields this frame rather than
				// cutting the command. (X074.)
				const fullWidthCell = box.rect.x === 0 && box.rect.width >= totalWidth;
				const clipBottom = Math.min(screen.length, box.clip.y + box.clip.height);
				const visibleRows = Math.min(block.rows, clipBottom - row);
				// A block whose row a visible scrollbar claims yields WITHOUT a demand:
				// it paints no pixels, so it must not hold a residency slot either.
				const scrollbar = box.scrollView === undefined ? undefined : getScrollbarGeometry(box);
				// The TRACK spans its rows; a block whose ANCHOR is above the track but
				// whose body rows intersect it still yields (paintScrollbar owns those
				// rows), so compare the whole visible range, not just the anchor row.
				const scrollbarClaimsRow =
					scrollbar !== undefined &&
					row <= scrollbar.trackTop + scrollbar.trackHeight - 1 &&
					row + visibleRows - 1 >= scrollbar.trackTop;
				if (block.kind === "candidate") {
					if (fullWidthCell && visibleRows > 0 && !scrollbarClaimsRow) {
						context.sixelDemands.push({ line, cropTopRows: 0, visibleRows, physicalRow: row });
						// The owner answers only for a GRANTED occurrence; anything else
						// (pending, revoked, over budget) becomes this block's own text.
						screen[row] = sixelScreen?.materialize(line, 0, visibleRows) ?? block.fallback;
					} else {
						screen[row] = block.fallback;
					}
					continue;
				}
				if (fullWidthCell && visibleRows > 0) {
					if (visibleRows >= block.rows) {
						screen[row] = line;
					} else {
						// A bottom-clipped block is re-encoded from its own source at the
						// SAME scale; clipping this DCS string would paint pixels outside
						// the box. Until the variant is ready the row stays empty.
						const cropped = sixelScreen?.crop(line, 0, visibleRows);
						screen[row] = cropped ?? "";
					}
				}
				continue;
			}
			const imageMetadata = getKittyImageMetadata(line);
			if (imageMetadata) {
				const clipBottom = Math.min(screen.length, box.clip.y + box.clip.height);
				const visibleRows = Math.min(imageMetadata.rows, clipBottom - row);
				if (visibleRows < imageMetadata.rows) line = cropKittyImageLine(line, 0, visibleRows);
			}
			// Fast path: a full-width box painting onto an untouched row can use the
			// source line reference directly. Compositing here would rebuild the row
			// string through ANSI/grapheme segmentation every frame; padding is
			// unnecessary because rows are written with erase-line and the final
			// width clamp still truncates over-wide lines.
			if (box.rect.x === 0 && box.rect.width >= totalWidth && (isImageLine(line) || !screen[row])) {
				screen[row] = line;
			} else {
				screen[row] = compositeTuiLine(screen[row] ?? "", line, box.rect.x, box.rect.width, totalWidth);
			}
		}
	}
	for (const child of box.children) paintBox(child, screen, totalWidth, context);

	if (box.scrollView && box.scrollContentLines && box.scrollView.scrollTop > 0 && box.rect.height > 0) {
		const scanFloor = Math.max(0, box.scrollView.scrollTop - MAX_SIXEL_CROP_SCAN_ROWS);
		for (let imageRow = box.scrollView.scrollTop - 1; imageRow >= 0; imageRow--) {
			const imageLine = box.scrollContentLines[imageRow] ?? "";
			const block = sixelBlock(imageLine, sixelScreen);
			if (block !== undefined) {
				const hiddenRows = box.scrollView.scrollTop - imageRow;
				const visibleRows = Math.min(box.rect.height, block.rows - hiddenRows);
				if (
					hiddenRows < block.rows
					&& visibleRows > 0
					&& box.rect.x === 0
					&& box.rect.width >= totalWidth
				) {
					// The anchor scrolled above the viewport: re-encode the SAME source
					// from its real top crop instead of relocating the unclipped DCS
					// (which would paint above the box).
					if (block.kind === "candidate") {
						context.sixelDemands.push({
							line: imageLine,
							cropTopRows: hiddenRows,
							visibleRows,
							physicalRow: box.rect.y,
						});
						screen[box.rect.y] = sixelScreen?.materialize(imageLine, hiddenRows, visibleRows) ?? block.fallback;
					} else {
						const cropped = sixelScreen?.crop(imageLine, hiddenRows, visibleRows);
						if (cropped !== undefined) screen[box.rect.y] = cropped;
					}
				}
				break;
			}
			const metadata = getKittyImageMetadata(imageLine);
			if (metadata) {
				const hiddenRows = box.scrollView.scrollTop - imageRow;
				if (hiddenRows < metadata.rows) {
					const visibleRows = Math.min(box.rect.height, metadata.rows - hiddenRows);
					const cropped = cropKittyImageLine(imageLine, hiddenRows, visibleRows);
					if (box.rect.x === 0 && box.rect.width >= totalWidth) screen[box.rect.y] = cropped;
				}
				break;
			}
			if (imageLine !== "") break;
			// A SIXEL block never spans further than the owner's own body budget, so
			// the upward search is bounded instead of scanning the whole corpus.
			// Kitty keeps its upstream unbounded contiguous-blank scan.
			if (sixelScreen !== undefined && imageRow <= scanFloor) break;
		}
	}

	paintScrollbar(box, screen, totalWidth, sixelScreen);
}

export function renderLayoutFrame(
	root: Component,
	width: number,
	height: number,
	requestRender: () => void,
	sixelScreen?: SixelScreenPort,
): LayoutFrame {
	const safeWidth = Math.max(1, Math.floor(width));
	const safeHeight = Math.max(1, Math.floor(height));
	const context: LayoutContext = {
		viewport: { width: safeWidth, height: safeHeight },
		renderCache: new Map(),
		maxWidthCache: new Map(),
		requestRender,
		primaryScrollView: undefined,
		sixelScreen,
		sixelDemands: [],
	};
	const rootBox = layoutComponent(context, root, 0, 0, safeWidth, safeHeight, {
		x: 0,
		y: 0,
		width: safeWidth,
		height: safeHeight,
	});
	const lines = Array.from({ length: safeHeight }, () => "");
	paintBox(rootBox, lines, safeWidth, context);
	return {
		root: rootBox,
		width: safeWidth,
		height: safeHeight,
		lines,
		sixelDemands: context.sixelDemands,
		...(context.primaryScrollView === undefined ? {} : { primaryScrollView: context.primaryScrollView }),
	};
}

function containsPoint(rect: LayoutRect, x: number, y: number): boolean {
	return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** Return the visual hit path from the deepest component to the layout root. */
export function getLayoutBoxesAt(frame: LayoutFrame, x: number, y: number): LayoutBox[] {
	const result: Array<{ box: LayoutBox; depth: number }> = [];
	const visit = (box: LayoutBox, depth: number): void => {
		if (!containsPoint(box.clip, x, y)) return;
		result.push({ box, depth });
		for (const child of box.children) visit(child, depth + 1);
	};
	visit(frame.root, 0);
	result.sort((a, b) => b.box.layer - a.box.layer || b.depth - a.depth);
	return result.map(({ box }) => box);
}

export function getScrollViewBox(frame: LayoutFrame, scrollView: ScrollView): LayoutBox | undefined {
	const visit = (box: LayoutBox): LayoutBox | undefined => {
		if (box.scrollView === scrollView) return box;
		for (const child of box.children) {
			const match = visit(child);
			if (match) return match;
		}
		return undefined;
	};
	return visit(frame.root);
}

export function getScrollViewsAt(frame: LayoutFrame, x: number, y: number): ScrollView[] {
	const result: Array<{ scrollView: ScrollView; depth: number }> = [];
	const visit = (box: LayoutBox, depth: number): void => {
		if (!containsPoint(box.clip, x, y)) return;
		if (box.scrollView && containsPoint(box.rect, x, y)) result.push({ scrollView: box.scrollView, depth });
		for (const child of box.children) visit(child, depth + 1);
	};
	visit(frame.root, 0);
	result.sort((a, b) => b.depth - a.depth);
	return result.map((entry) => entry.scrollView);
}
