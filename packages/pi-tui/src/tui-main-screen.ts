import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteKittyImage, isImageLine, type SixelScreenPort } from "./terminal-image.ts";
import type { Terminal } from "./terminal.ts";
import { SEGMENT_RESET, type TUI, TuiBase, type TuiStopOptions } from "./tui.ts";
import { asciiVisibleWidthEarlyExit, normalizeTerminalOutput, sliceByColumn, visibleWidth } from "./utils.ts";

const KITTY_SEQUENCE_PREFIX = "\x1b_G";
const MAX_RENDER_WRITE_CHARS = 1024 * 1024;
const EMPTY_IMAGE_IDS: readonly number[] = [];

/**
 * Streams terminal output in 1 MiB chunks so a full render never forms one string large enough to exceed V8's limit.
 *
 * `append()` fills the current chunk and flushes it when full. Oversized input is split at chunk boundaries, preserving
 * surrogate pairs so each write remains valid UTF-16. Callers append synchronized-output begin/end sequences themselves;
 * the final `flush()` writes any remainder, including the end sequence.
 */
class BoundedTerminalWriter {
	private buffer = "";
	private writtenChars = 0;
	private readonly write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	/**
	 * Append terminal data, flushing full chunks as needed. Callers must call `flush()` after the final append.
	 * @param value Terminal data to write in order; oversized values are split without splitting surrogate pairs.
	 */
	append(value: string): void {
		let offset = 0;
		while (offset < value.length) {
			const capacity = MAX_RENDER_WRITE_CHARS - this.buffer.length;
			if (capacity === 0) {
				this.flush();
				continue;
			}

			let end = Math.min(value.length, offset + capacity);
			if (
				end < value.length &&
				value.charCodeAt(end - 1) >= 0xd800 &&
				value.charCodeAt(end - 1) <= 0xdbff &&
				value.charCodeAt(end) >= 0xdc00 &&
				value.charCodeAt(end) <= 0xdfff
			) {
				end--;
			}
			if (end === offset) {
				this.flush();
				continue;
			}

			this.buffer += value.slice(offset, end);
			offset = end;
			if (this.buffer.length === MAX_RENDER_WRITE_CHARS) {
				this.flush();
			}
		}
	}

	/** Write the current chunk, if any, and retain only its character count for debug output. */
	flush(): void {
		if (!this.buffer) return;
		this.write(this.buffer);
		this.writtenChars += this.buffer.length;
		this.buffer = "";
	}

	get length(): number {
		return this.writtenChars + this.buffer.length;
	}
}

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	/**
	 * Raw (pre-processing) lines of the previous frame, aligned with
	 * {@link previousLines}. Equal primitive rendered-line values let each frame
	 * reuse processed output for every untouched line, even when a component
	 * returns a fresh array. Host render-array reference stability is an
	 * incidental component-level optimization, not a prerequisite for this
	 * cache. (dsh-pi-tui divergence X035.)
	 */
	private previousRawLines: string[] = [];
	/** Per-line kitty image ids of the previous frame, aligned with previousRawLines. */
	private previousLineImageIds: ReadonlyArray<number>[] = [];
	private previousKittyImageIds = new Set<number>();
	/**
	 * Declared image rows of the previous frame, aligned with
	 * {@link previousLines}: a Kitty `r=`/registered placement row count, or a
	 * trusted SIXEL footprint. Cached instead of re-deriving from the line,
	 * because a raster whose component was disposed is no longer registered —
	 * the OLD block must still be erased (X073).
	 */
	private previousLineImageRows: number[] = [];
	/**
	 * Per-line TRUSTED SIXEL footprint height of the previous frame (0 = no
	 * SIXEL block). Unlike the Kitty row count this is exact, so it never has to
	 * be re-derived by scanning blank body rows — a scan would collapse under an
	 * overlay or a text row that landed inside the block. (X073.)
	 */
	private previousLineSixelRows: number[] = [];
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;
	/** Per-row token -> DCS the current frame materialized (X073). */
	private sixelFrameRasters = new Map<number, { line: string; dcs: string; cropTopRows: number; visibleRows: number }>();

	/**
	 * @param sixelScreen - the Client-local SIXEL trust port (X072). Absent for
	 * every non-SIXEL terminal, and then this screen is byte-for-byte upstream.
	 */
	constructor(terminal: Terminal, showHardwareCursor?: boolean, logDirectory?: string, sixelScreen?: SixelScreenPort) {
		super(terminal, showHardwareCursor, logDirectory, sixelScreen);
	}

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.previousLines = state.previousLines.map((line) => (this.isRenderableImageLine(line) ? "" : line));
		this.previousRawLines = [];
		this.previousLineImageIds = [];
		this.previousLineImageRows = [];
		this.previousLineSixelRows = [];
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
	}

	protected override resetRenderState(): void {
		this.previousLines = [];
		this.previousRawLines = [];
		this.previousLineImageIds = [];
		this.previousLineImageRows = [];
		this.previousLineSixelRows = [];
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		if (options.preserveScreen || this.previousLines.length === 0) return;
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		// Only write the spacer when the cursor must actually move: on the
		// final row a stray blank would stay visible after the TUI exits.
		// (dsh-pi-tui divergence X009.)
		if (lineDiff !== 0) this.terminal.write(" ");
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
	}

	private unionKittyImageIds(lineImageIds: ReadonlyArray<number>[]): Set<number> {
		const ids = new Set<number>();
		for (const lineIds of lineImageIds) {
			for (const id of lineIds) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	/**
	 * Project the frame's candidate markers into what this Screen may write.
	 *
	 * The component tree only ever emits an inert candidate marker per block; the
	 * final viewport decides which occurrences are granted residency. Rows above
	 * the viewport keep their previous physical line when the SAME occurrence is
	 * still there: a residency-only change must not rewrite committed scrollback
	 * (a rewrite above the viewport would force `fullRender(true)` and `3J`).
	 */
	private projectSixelCandidates(
		rawLines: readonly string[],
		height: number,
		viewportTop: number,
		width: number,
		reconcile: boolean,
	): {
		lines: string[];
		rasters: Map<number, { line: string; dcs: string; cropTopRows: number; visibleRows: number }>;
		preserved: Set<number>;
		recompose: boolean;
	} {
		const port = this.sixelScreen;
		const lines = [...rawLines];
		const rasters = new Map<number, { line: string; dcs: string; cropTopRows: number; visibleRows: number }>();
		const preserved = new Set<number>();
		if (port === undefined) return { lines, rasters, preserved, recompose: false };
		const visible: Array<{ row: number; fallback: string; cropTopRows: number; visibleRows: number }> = [];
		for (let row = viewportTop; row < Math.min(rawLines.length, viewportTop + height); row += 1) {
			const info = port.candidate(rawLines[row] ?? "");
			if (info === undefined) continue;
			const visibleRows = Math.min(info.layoutRows, viewportTop + height - row);
			if (visibleRows <= 0) continue;
			visible.push({ row, fallback: info.fallback, cropTopRows: 0, visibleRows });
		}
		// Bottom-up: the newest visible content wins a contested slot.
		visible.sort((left, right) => right.row - left.row);
		if (reconcile) {
			const changed = port.reconcileVisible(
				this,
				visible.map((entry) => ({
					line: rawLines[entry.row]!,
					cropTopRows: entry.cropTopRows,
					visibleRows: entry.visibleRows,
					physicalRow: entry.row,
				})),
			);
			if (changed) return { lines, rasters, preserved, recompose: true };
		}
		for (const entry of visible) {
			const token = rawLines[entry.row]!;
			const dcs = port.materialize(token, entry.cropTopRows, entry.visibleRows);
			if (dcs === undefined) {
				lines[entry.row] = entry.fallback;
				continue;
			}
			lines[entry.row] = dcs;
			const footprint = port.footprint(dcs);
			rasters.set(entry.row, {
				line: token,
				dcs,
				cropTopRows: entry.cropTopRows,
				visibleRows: footprint?.rows ?? entry.visibleRows,
			});
		}
		// Above the viewport: keep the previous physical line only for the SAME
		// occurrence; anything else is ordinary text.
		for (let row = 0; row < viewportTop && row < rawLines.length; row += 1) {
			const token = rawLines[row] ?? "";
			const info = port.candidate(token);
			if (info === undefined) continue;
			const previous = this.previousLines[row] ?? "";
			// A committed history row is decoupled from the registry's CURRENT
			// residency: the pixels are already in native scrollback, so a same-
			// occurrence row must not become `firstChanged` (that would force a 3J).
			// Once the record is released, the full DCS string leaves the history
			// cache too: the row's bookkeeping becomes its lightweight fallback, and
			// the diff sees the same text, so nothing is WRITTEN to scrollback.
			if (this.previousRawLines[row] === token && this.sixelFootprint(previous) !== undefined) {
				lines[row] = previous;
				preserved.add(row);
			} else if (this.previousRawLines[row] === token) {
				// The row is TEXT again: apply the SAME physical text contract as any
				// other row (width clamp + normalization + reset) BEFORE caching it, or a
				// later full render would write an over-wide fallback and wrap history.
				let fallback = info.fallback;
				if (visibleWidth(fallback) > width) fallback = sliceByColumn(fallback, 0, width, true);
				fallback = normalizeTerminalOutput(fallback) + SEGMENT_RESET;
				this.previousLines[row] = fallback;
				// Drop the cached image/sixel metadata together with the payload, or the
				// next frame re-records a plain fallback as an image block.
				this.previousLineSixelRows[row] = 0;
				this.previousLineImageRows[row] = 0;
				this.previousLineImageIds[row] = [];
				lines[row] = fallback;
				preserved.add(row);
			} else {
				lines[row] = info.fallback;
			}
		}
		return { lines, rasters, preserved, recompose: false };
	}

	/**
	 * Report the frame's physical raster set to the owner after a real write.
	 *
	 * `emitted` rasters are the ones this frame materialized; a row the diff kept
	 * (byte-identical to the previous frame) still shows its old pixels and pins
	 * its occurrence. Rows above the viewport are never reported: their pixels are
	 * native scrollback, not a frame reference.
	 */
	private commitSixelFrame(frameLines: readonly string[], viewportTop: number, height: number): void {
		const port = this.sixelScreen;
		if (port === undefined) return;
		const retained: Array<{ line: string; dcs: string; cropTopRows: number; visibleRows: number; emitted: boolean }> = [];
		for (const row of [...this.sixelFrameRasters.keys()].sort((left, right) => right - left)) {
			const raster = this.sixelFrameRasters.get(row)!;
			if (row < viewportTop || row >= viewportTop + height) continue;
			retained.push({ ...raster, emitted: true });
		}
		const last = Math.min(frameLines.length, viewportTop + height) - 1;
		for (let row = last; row >= viewportTop; row -= 1) {
			if (this.sixelFrameRasters.has(row)) continue;
			const token = this.previousRawLines[row];
			if (token === undefined || port.candidate(token) === undefined) continue;
			const previous = this.previousLines[row];
			if (previous === undefined || previous !== frameLines[row]) continue;
			const footprint = port.footprint(previous);
			if (footprint === undefined) continue;
			retained.push({ line: token, dcs: previous, cropTopRows: 0, visibleRows: footprint.rows, emitted: false });
		}
		this.sixelFrameRasters = new Map();
		port.framePainted(this, retained);
	}

	/**
	 * The image rows one line DECLARES: a Kitty `r=`/registered placement, or a
	 * trusted SIXEL footprint. `0` for a non-image line, so callers can decide
	 * "is an image" and "how tall" from one number.
	 */
	private declaredImageRows(line: string): number {
		// A candidate block declares its conservative layout reserve; once the
		// frame projects it, the DCS declares its real footprint. (X073.)
		const candidate = this.sixelScreen?.candidate(line);
		if (candidate !== undefined) return candidate.layoutRows;
		const footprint = this.sixelFootprint(line);
		if (footprint !== undefined) return footprint.rows;
		return isImageLine(line) ? extractKittyImageRows(line) : 0;
	}

	/** The trusted SIXEL footprint height of one line, or 0 when it is not a
	 *  registered raster. */
	private sixelBlockRows(line: string): number {
		const candidate = this.sixelScreen?.candidate(line);
		if (candidate !== undefined) return candidate.layoutRows;
		return this.sixelFootprint(line)?.rows ?? 0;
	}

	/**
	 * The rows an image block really occupies in `lines`, starting at `index`.
	 *
	 * `declared` is the per-line declared row count of the SAME frame (cached for
	 * the previous frame), so a raster that is no longer registered still
	 * reports its real old height. The scan stops at the first body row another
	 * image owns or at the first row with cell content.
	 */
	private getImageReservedRows(
		lines: readonly string[],
		declared: readonly number[],
		sixel: readonly number[],
		index: number,
		maxIndex = lines.length - 1,
	): number {
		const rows = declared[index] ?? 0;
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		// A trusted SIXEL footprint IS the reserved height: the encoder reserved
		// exactly those rows and the Screen must erase exactly those rows, no
		// matter what an overlay or a replacement text row did to them.
		if ((sixel[index] ?? 0) > 0) return maxRows;
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if ((declared[index + reservedRows] ?? 0) > 0 || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForImages(
		firstChanged: number,
		lastChanged: number,
		newLines: readonly string[],
		newLineImageRows: readonly number[],
		newLineSixelRows: readonly number[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (
			lines: readonly string[],
			declared: readonly number[],
			sixel: readonly number[],
		): void => {
			for (let i = 0; i < lines.length; i++) {
				if ((declared[i] ?? 0) === 0) continue;
				const blockEnd = i + this.getImageReservedRows(lines, declared, sixel, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines, this.previousLineImageRows, this.previousLineSixelRows);
		expandForLines(newLines, newLineImageRows, newLineSixelRows);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of this.previousLineImageIds[i] ?? EMPTY_IMAGE_IDS) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	/**
	 * Drop the DCS of every trusted SIXEL block that a visible overlay paints
	 * over (X073).
	 *
	 * One raster is one command covering its whole footprint, so "clear only the
	 * row the overlay touched" is impossible: the pixels would either cover the
	 * overlay text or leave a ghost. The block therefore yields this frame — the
	 * component's own identity row above it still names the attachment — and the
	 * next frame after the overlay closes restores it, because the anchor line
	 * changes and the block re-enters the changed range.
	 */
	private suppressOverlayCoveredSixelBlocks(lines: string[]): void {
		for (let i = 0; i < lines.length; i++) {
			const rows = this.sixelBlockRows(lines[i] ?? "");
			if (rows === 0) continue;
			if (!this.linesCoveredByOverlay(i, i + rows - 1, lines.length)) continue;
			lines[i] = "";
		}
	}

	/**
	 * Write every deferred trusted SIXEL anchor at its own absolute row, then
	 * leave the cursor on `finalCursorRow`.
	 *
	 * `CSI 999A` (cursor up, clamped at the top margin) is the one deterministic
	 * origin the main screen has: it cannot scroll and it lands on the physical
	 * top row, which this screen's bookkeeping maps to buffer row `viewportTop`.
	 * From there a bounded `CSI nB` reaches any visible row exactly. Each DCS is
	 * wrapped in DECSC/DECRC because its post-command cursor position is
	 * terminal-defined, never assumed to be zero.
	 *
	 * Returns false when an anchor is not inside the painted viewport; the caller
	 * then falls back to a full redraw instead of painting outside it.
	 */
	private writeDeferredSixelAnchors(
		output: BoundedTerminalWriter,
		anchors: readonly number[],
		lines: readonly string[],
		viewportTop: number,
		height: number,
		finalCursorRow: number,
	): boolean {
		for (const anchor of anchors) {
			const screenRow = anchor - viewportTop;
			if (screenRow < 0 || screenRow >= height) return false;
			output.append("\x1b[999A");
			if (screenRow > 0) output.append(`\x1b[${screenRow}B`);
			output.append("\x1b7");
			output.append(lines[anchor] ?? "");
			output.append("\x1b8");
		}
		const endScreenRow = Math.max(0, Math.min(height - 1, finalCursorRow - viewportTop));
		output.append("\x1b[999A");
		if (endScreenRow > 0) output.append(`\x1b[${endScreenRow}B`);
		output.append("\r");
		return true;
	}

	/**
	 * Write one image anchor at the cursor's current row.
	 *
	 * A Kitty placement leaves the cursor where it was; a SIXEL DCS does not, and
	 * its post-command position is terminal-defined. The anchor is therefore
	 * SAVED before the command and RESTORED after it (DECSC/DECRC), and the
	 * caller then moves the cursor explicitly — "the DCS left it at 0" is never
	 * assumed. (dsh-pi-tui divergence X073.)
	 */
	private appendImageCommand(output: BoundedTerminalWriter, line: string, sixel: boolean): void {
		if (!sixel) {
			output.append(line);
			return;
		}
		output.append("\x1b7");
		output.append(line);
		output.append("\x1b8");
	}

	protected doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		const widthChanged = this.previousWidth !== 0 && this.previousWidth !== width;
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		let prevViewportTop = heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = this.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};

		// Render all components to get new lines. In SIXEL mode these lines carry
		// inert candidate markers, not device commands: the final viewport below
		// decides which occurrences are granted pixels. (X073.)
		let rawLines = this.render(width);

		// Composite overlays into the rendered lines (before differential compare)
		if (this.hasOverlayEntries) {
			rawLines = this.compositeOverlays(rawLines, width, height);
			// An overlay that paints ANY row of a SIXEL block must win the whole
			// block: the raster is one command whose pixels cover every row, so a
			// per-row decision would paint over the overlay's own text. This frame
			// paints no pixels there; the image's identity row above stays visible
			// and the block returns as soon as the overlay is gone. (X073.)
			// `compositeLineAt` already treats a candidate marker as an empty base,
			// so a covered block yields its marker instead of compositing it as text.
			this.suppressOverlayCoveredSixelBlocks(rawLines);
		}

		// The main screen follows the tail: the physical viewport is always the last
		// `height` rows of the document it is about to write, for the first frame,
		// an append, and a resize alike. The projection and every commit use this
		// one value so a granted row is always a committed row.
		const frameViewportTop = Math.max(0, rawLines.length - height);
		let projection = this.projectSixelCandidates(rawLines, height, frameViewportTop, width, true);
		if (projection.recompose) {
			// The grant set changed with this frame's demands: the component lines
			// are unchanged (they are markers), so one more projection is the whole
			// recomposition. More than one would be a repaint storm.
			projection = this.projectSixelCandidates(rawLines, height, frameViewportTop, width, false);
		}
		this.sixelFrameRasters = projection.rasters;
		const preservedRows = projection.preserved;
		let newLines = projection.lines;

		// Extract cursor position before applying line resets (marker must be found first)
		const cursorPos = this.extractCursorPosition(newLines, height);

		// Process raw lines for output. Never write a line wider than the
		// terminal: truncate defensively instead of crashing. Extremely narrow
		// terminals can make components overflow by a column (e.g. wide
		// graphemes at width 1). Image lines are exempt (their payload is not
		// cell content). The truncation runs BEFORE the segment reset is
		// appended — sliceByColumn drops trailing zero-width codes at the cut
		// column, so the reset must land AFTER the slice or a truncated styled
		// line leaks its open style into subsequent rows. (dsh-pi-tui
		// divergence X033.)
		//
		// Lines whose raw string value equals the previous frame's reuse their
		// processed output verbatim. JavaScript string equality is value-based,
		// so a rebuilt array containing equal primitive lines also hits the cache;
		// a steady frame only pays for lines whose values changed instead of
		// re-normalizing and re-measuring the whole transcript. (dsh-pi-tui
		// divergence X035.) A width change invalidates every cached truncation.
		const reuseProcessed = !widthChanged && this.previousRawLines.length > 0;
		const processedLines: string[] = new Array(newLines.length);
		const lineImageIds: ReadonlyArray<number>[] = new Array(newLines.length);
		const lineImageRows: number[] = new Array(newLines.length);
		const lineSixelRows: number[] = new Array(newLines.length);
		for (let i = 0; i < newLines.length; i++) {
			const marker = rawLines[i] ?? "";
			const isCandidate = this.sixelScreen?.candidate(marker) !== undefined;
			if (preservedRows.has(i) || (!isCandidate && reuseProcessed && marker === this.previousRawLines[i])) {
				processedLines[i] = this.previousLines[i]!;
				lineImageIds[i] = this.previousLineImageIds[i]!;
				lineImageRows[i] = this.previousLineImageRows[i]!;
				lineSixelRows[i] = this.previousLineSixelRows[i]!;
				continue;
			}
			let line = newLines[i]!;
			let imageIds: readonly number[] = EMPTY_IMAGE_IDS;
			const sixelRows = this.sixelBlockRows(line);
			const declaredImageRows = this.declaredImageRows(line);
			if (declaredImageRows > 0) {
				imageIds = extractKittyImageIds(line);
			} else {
				const lineWidth = asciiVisibleWidthEarlyExit(line, width) ?? visibleWidth(line);
				if (lineWidth > width) {
					line = sliceByColumn(line, 0, width, true);
				}
				line = normalizeTerminalOutput(line) + SEGMENT_RESET;
			}
			processedLines[i] = line;
			lineImageIds[i] = imageIds;
			lineImageRows[i] = declaredImageRows;
			lineSixelRows[i] = sixelRows;
		}
		newLines = processedLines;

		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
			output.append("\x1b[?2026h"); // Begin synchronized output
			if (clear) {
				output.append(this.deleteKittyImages(this.previousKittyImageIds));
				output.append("\x1b[2J\x1b[H\x1b[3J"); // Clear screen, home, then clear scrollback
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) output.append("\r\n");
				const line = newLines[i];
				const isSixel = (lineSixelRows[i] ?? 0) > 0;
				const isImage = isSixel || isImageLine(line);
				const imageReservedRows = isImage ? this.getImageReservedRows(newLines, lineImageRows, lineSixelRows, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						output.append("\r\n");
					}
					output.append(`\x1b[${imageReservedRows - 1}A`);
					this.appendImageCommand(output, line, isSixel);
					output.append(`\x1b[${imageReservedRows - 1}B`);
					i += imageReservedRows - 1;
					continue;
				}
				this.appendImageCommand(output, line, isSixel);
			}
			output.append("\x1b[?2026l"); // End synchronized output
			output.flush();
			this.commitSixelFrame(newLines, frameViewportTop, height);
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousRawLines = rawLines;
			this.previousLineImageIds = lineImageIds;
			this.previousLineImageRows = lineImageRows;
			this.previousLineSixelRows = lineSixelRows;
			this.previousKittyImageIds = this.unionKittyImageIds(lineImageIds);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const redrawLogDirectory = process.env.PI_TUI_DEBUG_REDRAW === "1" ? this.logDirectory : undefined;
		const logRedraw = (reason: string): void => {
			if (redrawLogDirectory === undefined) return;
			const logPath = path.join(redrawLogDirectory, "pi-tui-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			fs.mkdirSync(path.dirname(logPath), { recursive: true });
			fs.appendFileSync(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink()
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			const expandedRange = this.expandChangedRangeForImages(
				firstChanged,
				lastChanged,
				newLines,
				lineImageRows,
				lineSixelRows,
			);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			// Processed output is unchanged, but keep the raw/image-id caches in
			// sync so future frames keep hitting the reuse fast path (e.g. the
			// cursor-marker line gets a fresh string every frame).
			this.previousRawLines = rawLines;
			this.previousLineImageIds = lineImageIds;
			this.previousLineImageRows = lineImageRows;
			this.previousLineSixelRows = lineSixelRows;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
				output.append("\x1b[?2026h");
				output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) output.append(`\x1b[${lineDiff}B`);
				else if (lineDiff < 0) output.append(`\x1b[${-lineDiff}A`);
				output.append("\r");
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					output.append(`\x1b[${clearStartOffset}B`);
				}
				for (let i = 0; i < extraLines; i++) {
					output.append("\r\x1b[2K");
					if (i < extraLines - 1) output.append("\x1b[1B");
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					output.append(`\x1b[${moveBack}A`);
				}
				output.append("\x1b[?2026l");
				output.flush();
				this.commitSixelFrame(newLines, frameViewportTop, height);
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousRawLines = rawLines;
			this.previousLineImageIds = lineImageIds;
			this.previousLineImageRows = lineImageRows;
			this.previousLineSixelRows = lineSixelRows;
			this.previousKittyImageIds = this.unionKittyImageIds(lineImageIds);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			fullRender(true);
			return;
		}

		// Render from first changed line to end
		// Keep updates wrapped in synchronized output while writing bounded chunks.
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h"); // Begin synchronized output
		output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				output.append(`\x1b[${moveToBottom}B`);
			}
			const scroll = moveTargetRow - prevViewportBottom;
			output.append("\r\n".repeat(scroll));
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			output.append(`\x1b[${lineDiff}B`); // Move down
		} else if (lineDiff < 0) {
			output.append(`\x1b[${-lineDiff}A`); // Move up
		}

		output.append(appendStart ? "\r\n" : "\r"); // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		// SIXEL anchors are written AFTER every text row of this frame (X073). A
		// write on ANY row a raster covers destroys its pixels there, so painting
		// the anchor inline would let the very next body/text row cut the picture
		// it just drew.
		const deferredSixelAnchors: number[] = [];
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) output.append("\r\n");
			const line = newLines[i];
			const isSixel = (lineSixelRows[i] ?? 0) > 0;
			const isImage = isSixel || isImageLine(line);
			const imageReservedRows = isImage ? this.getImageReservedRows(newLines, lineImageRows, lineSixelRows, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(
						`image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					fullRender(true);
					return;
				}

				output.append("\x1b[2K");
				for (let row = 1; row < imageReservedRows; row++) {
					output.append("\r\n\x1b[2K");
				}
				output.append(`\x1b[${imageReservedRows - 1}A`);
				if (isSixel) deferredSixelAnchors.push(i);
				else output.append(line);
				output.append(`\x1b[${imageReservedRows - 1}B`);
				i += imageReservedRows - 1;
				continue;
			}

			output.append("\x1b[2K"); // Clear current line
			// Note: the X033 truncation pass above already guarantees every
			// non-image line fits the terminal, so this upstream crash path
			// is unreachable for non-image lines; it is kept verbatim as the
			// upstream baseline (and would still fire for image lines if the
			// image payload were ever mis-classified).
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(this.logDirectory ?? os.tmpdir(), "pi-tui-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
				fs.writeFileSync(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			if (isSixel) deferredSixelAnchors.push(i);
			else output.append(line);
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				output.append(`\x1b[${moveDown}B`);
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				output.append("\r\n\x1b[2K");
			}
			// Move cursor back to end of new content
			output.append(`\x1b[${extraLines}A`);
		}

		if (deferredSixelAnchors.length > 0) {
			if (!this.writeDeferredSixelAnchors(output, deferredSixelAnchors, newLines, viewportTop, height, finalCursorRow)) {
				logRedraw("deferred SIXEL anchor is not inside the painted viewport");
				fullRender(true);
				return;
			}
		}

		output.append("\x1b[?2026l"); // End synchronized output

		if (process.env.PI_TUI_DEBUG === "1") {
			const debugDir = "/tmp/tui";
			fs.mkdirSync(debugDir, { recursive: true });
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				`[${output.length} chars written in bounded chunks]`,
			].join("\n");
			fs.writeFileSync(debugPath, debugData);
		}

		output.flush();
		this.commitSixelFrame(newLines, frameViewportTop, height);

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousRawLines = rawLines;
		this.previousLineImageIds = lineImageIds;
		this.previousLineImageRows = lineImageRows;
		this.previousLineSixelRows = lineSixelRows;
		this.previousKittyImageIds = this.unionKittyImageIds(lineImageIds);
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.getShowHardwareCursor()) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
