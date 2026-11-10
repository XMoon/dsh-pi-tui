import { Marked, type Token, Tokenizer, type TokenizerExtension, type Tokens, type TokensList } from "marked";
import markedCjkFriendly from "marked-cjk-friendly";
import type { AltScreenSearchSegment } from "../alt-screen-search.ts";
import { renderLatex } from "../latex.ts";
import { getCapabilities, hyperlink, isImageLine } from "../terminal-image.ts";
import type { Component } from "../tui.ts";
import {
	applyBackgroundToLine,
	cjkPunctuationRegex,
	extractAnsiCode,
	flattenLines,
	getGraphemeSegmenter,
	stripTerminalSequences,
	visibleWidth,
	wrapTextWithAnsi,
} from "../utils.ts";

const STRICT_STRIKETHROUGH_REGEX = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/;

class MarkdownTokenizer extends Tokenizer {
	override url(src: string): Tokens.Link | undefined {
		const token = super.url(src);
		if (!token) return undefined;

		// Bare URLs stop at CJK punctuation; explicit links and angle autolinks
		// use separate tokenizers and can still contain these characters.
		const punctuationIndex = token.raw.search(cjkPunctuationRegex);
		return punctuationIndex < 0 ? token : super.url(token.raw.slice(0, punctuationIndex));
	}

	override del(src: string): Tokens.Del | undefined {
		const match = STRICT_STRIKETHROUGH_REGEX.exec(src);
		if (!match) {
			return undefined;
		}

		const text = match[2];
		return {
			type: "del",
			raw: match[0],
			text,
			tokens: this.lexer.inlineTokens(text),
		};
	}
}

interface LatexToken extends Tokens.Generic {
	type: "latex" | "latexBlock";
	text: string;
	pending?: boolean;
}

function isEscaped(source: string, index: number): boolean {
	let backslashes = 0;
	for (let position = index - 1; position >= 0 && source[position] === "\\"; position--) {
		backslashes++;
	}
	return backslashes % 2 === 1;
}

function findClosingDelimiter(source: string, closing: string, start: number): number {
	let index = source.indexOf(closing, start);
	while (index >= 0 && isEscaped(source, index)) {
		index = source.indexOf(closing, index + closing.length);
	}
	return index;
}

function looksLikePendingDollarMath(source: string): boolean {
	return /\\[A-Za-z]+|[_^=+*/<>()[\]|±≤≥≠≈∈→⇒∞∫∑√-]/.test(source);
}

function tokenizeInlineLatex(source: string): LatexToken | undefined {
	let opening = "";
	let closing = "";
	if (source.startsWith("$$")) {
		opening = "$$";
		closing = "$$";
	} else if (source.startsWith("\\(")) {
		opening = "\\(";
		closing = "\\)";
	} else if (source.startsWith("\\[")) {
		opening = "\\[";
		closing = "\\]";
	} else if (source.startsWith("$") && !/^\$\s/.test(source)) {
		opening = "$";
		closing = "$";
	} else {
		return undefined;
	}

	const closingIndex = findClosingDelimiter(source, closing, opening.length);
	if (
		closingIndex >= 0 &&
		opening === "$" &&
		(/\s$/.test(source.slice(opening.length, closingIndex)) ||
			/^\d/.test(source.slice(closingIndex + 1)) ||
			(/^[A-Z_][A-Z0-9_]*(?:[^A-Za-z0-9_\s])?$/.test(source.slice(opening.length, closingIndex)) &&
				/^[A-Za-z_][A-Za-z0-9_]*/.test(source.slice(closingIndex + 1))) ||
			source.slice(opening.length, closingIndex).includes("`"))
	) {
		return undefined;
	}

	if (closingIndex < 0) {
		const pendingSource = source.slice(opening.length);
		if (opening.startsWith("\\") || looksLikePendingDollarMath(pendingSource)) {
			return { type: "latex", raw: source, text: pendingSource, pending: true };
		}
		return undefined;
	}

	const text = source.slice(opening.length, closingIndex);
	if (!text || text.includes("\n")) {
		return undefined;
	}

	const raw = source.slice(0, closingIndex + closing.length);
	return { type: "latex", raw, text };
}

const TABLE_DELIMITER_ROW_REGEX = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

// A GFM table starts with a header row followed by a delimiter row such as "|---|---|" or "| --- |".
// The header needs a "|" only when the delimiter has none: a pipe-free delimiter without a pipe in the
// header is a thematic break, not a table.
function containsTableStart(source: string): boolean {
	const lines = source.split("\n");
	for (let index = 0; index < lines.length - 1; index++) {
		const delimiterRow = lines[index + 1];
		if ((delimiterRow.includes("|") || lines[index].includes("|")) && TABLE_DELIMITER_ROW_REGEX.test(delimiterRow)) {
			return true;
		}
	}
	return false;
}

function tokenizeBlockLatex(source: string): LatexToken | undefined {
	// Display math never spans a table. Without this check, an unclosed "$$" or "\[" pairs with a later
	// opener or stays pending, swallowing the table. See https://github.com/earendil-works/pi/issues/11159.
	const dollarMatch = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*?)\$\$[ \t]*(?:\n|$)/.exec(source);
	if (dollarMatch?.[1] && !containsTableStart(dollarMatch[1])) {
		return { type: "latexBlock", raw: dollarMatch[0], text: dollarMatch[1].trim() };
	}

	const bracketMatch = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*?)\\\][ \t]*(?:\n|$)/.exec(source);
	if (bracketMatch?.[1] && !containsTableStart(bracketMatch[1])) {
		return { type: "latexBlock", raw: bracketMatch[0], text: bracketMatch[1].trim() };
	}

	const pendingBracket = /^ {0,3}\\\[[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingBracket?.[1] && !containsTableStart(pendingBracket[1])) {
		return { type: "latexBlock", raw: pendingBracket[0], text: pendingBracket[1], pending: true };
	}
	const pendingDollar = /^ {0,3}\$\$[ \t]*(?:\n)?([\s\S]*)$/.exec(source);
	if (pendingDollar?.[1] && looksLikePendingDollarMath(pendingDollar[1]) && !containsTableStart(pendingDollar[1])) {
		return { type: "latexBlock", raw: pendingDollar[0], text: pendingDollar[1], pending: true };
	}
	return undefined;
}

const LATEX_MARKDOWN_EXTENSIONS: readonly TokenizerExtension[] = [
	{
		name: "latexBlock",
		level: "block",
		start(source) {
			const match = /(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source);
			return match ? match.index + (match[0].startsWith("\n") ? 1 : 0) : undefined;
		},
		tokenizer: tokenizeBlockLatex,
	},
	{
		name: "latex",
		level: "inline",
		start(source) {
			const indices = [source.indexOf("$"), source.indexOf("\\("), source.indexOf("\\[")].filter(
				(index) => index >= 0,
			);
			return indices.length > 0 ? Math.min(...indices) : undefined;
		},
		tokenizer: tokenizeInlineLatex,
	},
];

function trimPartialClosingFences(tokens: readonly Token[]): void {
	const token = tokens[tokens.length - 1];
	if (token?.type === "list") {
		trimPartialClosingFences(token.items[token.items.length - 1]?.tokens ?? []);
		return;
	}
	if (token?.type === "blockquote") {
		trimPartialClosingFences(token.tokens ?? []);
		return;
	}
	if (token?.type !== "code") {
		return;
	}

	// Trim streamed partial closing fences so code blocks do not shrink/flicker
	// when the final fence character arrives. See https://github.com/earendil-works/pi/issues/5825.
	const marker = /^(`{3,}|~{3,})/.exec(token.raw)?.[1];
	const lastLine = token.raw.split("\n").pop();
	if (!marker || !lastLine || lastLine.length >= marker.length || lastLine !== marker[0]?.repeat(lastLine.length)) {
		return;
	}

	token.text = token.text.slice(0, -lastLine.length).replace(/\n$/, "");
}

/** Proof-mode zero-width boundary sentinels. They exist only in the disposable
 * rows of one `proveSourceSpan()` call and are always stripped before the proof
 * output is compared with the normal render. */
const PROOF_OPEN = "\u200B";
const PROOF_CLOSE = "\u200C";

/** The result of proving one component-local source range against the painted
 * cells of `Markdown.render(width)` for this component's own current source. */
export type MarkdownSourceCellProof =
	| { readonly kind: "PROVEN"; readonly segments: readonly AltScreenSearchSegment[] }
	| { readonly kind: "NOT_PAINTED"; readonly reason: "HIDDEN_LINK_TARGET" | "MARKUP_ONLY" }
	| {
			readonly kind: "UNPROVEN";
			readonly reason:
				| "SOURCE_PROJECTION"
				| "TOKEN_ORIGIN"
				| "REFLOW"
				| "RENDER_EQUIVALENCE"
				| "STALE_RENDER"
				| "COMPOSITE_OWNER";
	  };

/** Where one token's raw text lives in the current component source. */
interface TokenOrigin {
	readonly start: number;
	readonly end: number;
	/** Absolute offset of every raw line of the token (the first line's start is `start`). */
	readonly lineStarts: readonly number[];
	/** Offset of every raw line inside the token's own raw text. */
	readonly rawLineStarts: readonly number[];
}

interface LocatedToken {
	readonly token: Token;
	readonly origin: TokenOrigin;
}

interface ProofHrefTarget {
	readonly href: string;
	readonly start: number;
	readonly end: number;
}

/** The short-lived state of ONE proof render. Never survives the call. */
interface ProofState {
	/** The requested range projected onto the TAB-normalized source the parser saw. */
	readonly request: { readonly start: number; readonly end: number };
	origin: WeakMap<Token, TokenOrigin> | undefined;
	located: LocatedToken[];
	mappingFailure: string | undefined;
	/** The parsed source is not the component's own source (transform/tab change). */
	sourceProjectionFailure: boolean;
	hrefCandidates: { readonly start: number; readonly end: number }[];
	hrefTarget: ProofHrefTarget | undefined;
	wrappedLeaves: number;
	/** Suppresses sentinel wrapping while a renderer measures text it will discard. */
	suppressWrapping: boolean;
}

const proofSegmenter = getGraphemeSegmenter();

function isGraphemeBoundary(text: string, index: number): boolean {
	if (index <= 0 || index >= text.length) {
		return true;
	}
	for (const segment of proofSegmenter.segment(text)) {
		if (segment.index === index) {
			return true;
		}
	}
	return false;
}

/** Project a component-source offset onto the TAB-normalized source the parser sees. */
function projectTabOffset(text: string, index: number): number {
	let projected = index;
	for (let position = 0; position < index; position++) {
		if (text.charCodeAt(position) === 9) {
			projected += 2;
		}
	}
	return projected;
}

/** Remove the zero-width proof sentinels from one row without changing columns. */
function stripProofSentinels(line: string): string {
	if (!line.includes(PROOF_OPEN) && !line.includes(PROOF_CLOSE)) {
		return line;
	}
	return line.split(PROOF_OPEN).join("").split(PROOF_CLOSE).join("");
}

/**
 * Build a view of `content` against the raw text a block tokenizer produced it from. `content` lines are
 * prefixes-removed suffixes of the raw lines (blockquote markers, list indentation, code fences), so every line
 * must line up exactly; anything else is refused instead of guessed.
 * `offsets[viewIndex]` is the offset inside `raw` of the content character at `viewIndex`.
 */
function buildLineView(
	raw: string,
	content: string,
): { readonly text: string; readonly offsets: readonly number[] } | undefined {
	if (raw === content) {
		const offsets = new Array<number>(content.length);
		for (let index = 0; index < content.length; index++) {
			offsets[index] = index;
		}
		return { text: content, offsets };
	}
	const rawLines = raw.split("\n");
	const contentLines = content.split("\n");
	if (contentLines.length > rawLines.length) {
		return undefined;
	}
	const offsets = new Array<number>(content.length);
	let viewIndex = 0;
	let rawLineStart = 0;
	for (let line = 0; line < contentLines.length; line++) {
		const rawLine = rawLines[line];
		const contentLine = contentLines[line];
		if (rawLine === undefined || !rawLine.endsWith(contentLine)) {
			return undefined;
		}
		const prefix = rawLine.length - contentLine.length;
		for (let index = 0; index < contentLine.length; index++) {
			offsets[viewIndex] = rawLineStart + prefix + index;
			viewIndex += 1;
		}
		if (line < contentLines.length - 1) {
			offsets[viewIndex] = rawLineStart + rawLine.length;
			viewIndex += 1;
		}
		rawLineStart += rawLine.length + 1;
	}
	return viewIndex === content.length ? { text: content, offsets } : undefined;
}

/** Absolute offset of a raw-relative offset, using the token's per-line mapping. */
function absoluteFromRawOffset(origin: TokenOrigin, raw: readonly string[], rawOffset: number): number | undefined {
	for (let line = 0; line < raw.length; line++) {
		const lineStart = origin.rawLineStarts[line];
		const lineEnd = lineStart + raw[line].length;
		if (rawOffset >= lineStart && rawOffset <= lineEnd) {
			return origin.lineStarts[line] + (rawOffset - lineStart);
		}
	}
	return undefined;
}

/** Slice the visible columns `[startCol, endCol)` of an ANSI-stripped string. */
function visibleColumnSlice(visible: string, startCol: number, endCol: number): string | undefined {
	if (startCol < 0 || endCol < startCol) {
		return undefined;
	}
	let column = 0;
	let startIndex = -1;
	let endIndex = -1;
	for (const { segment, index } of proofSegmenter.segment(visible)) {
		if (column === startCol && startIndex < 0) {
			startIndex = index;
		}
		if (column === endCol) {
			endIndex = index;
			break;
		}
		column += visibleWidth(segment);
		if (column > endCol) {
			return undefined;
		}
	}
	if (startIndex < 0 && column === startCol) {
		startIndex = visible.length;
	}
	if (endIndex < 0 && column === endCol) {
		endIndex = visible.length;
	}
	if (startIndex < 0 || endIndex < 0) {
		return undefined;
	}
	return visible.slice(startIndex, endIndex);
}

/** Every grapheme-boundary column of an ANSI-stripped visible string. */
function visibleColumnBoundaries(visible: string): number[] {
	const boundaries = [0];
	let column = 0;
	for (const { segment } of proofSegmenter.segment(visible)) {
		column += visibleWidth(segment);
		boundaries.push(column);
	}
	return boundaries;
}

/** The direct child tokens of one token, in rendering order. */
function childTokensOf(token: Token): Token[] {
	if (token.type === "list") {
		return (token as Tokens.List).items;
	}
	if (token.type === "table") {
		const table = token as Tokens.Table;
		const children: Token[] = [];
		for (const cell of [...table.header, ...table.rows.flat()]) {
			children.push(...(cell.tokens ?? []));
		}
		return children;
	}
	const generic = token as Token & { tokens?: readonly Token[] };
	return generic.tokens === undefined ? [] : [...generic.tokens];
}

/** Visible content of one proof row: sentinels and terminal sequences removed, trailing padding dropped. */
function proofRowContent(line: string): string {
	return stripTerminalSequences(stripProofSentinels(line)).trimEnd();
}

type ProofRecovery =
	| { readonly segments: readonly AltScreenSearchSegment[]; readonly collected: string }
	| { readonly failure: "REFLOW" | "RENDER_EQUIVALENCE" };

/**
 * Recover the ONE sentinel-wrapped painted range from a proof render. A range may span several wrapped rows: the
 * first row contributes its tail, every further row contributes its content after the layout prefix, and the last
 * row ends exactly at the closing sentinel. The prefix width of continuation rows is not assumed: it is the one
 * boundary width that reconstructs `expected` exactly, and an ambiguous reconstruction is refused.
 */
function recoverProofSegments(rows: readonly string[], expected: string): ProofRecovery {
	let openRow = -1;
	let openIndex = -1;
	let closeRow = -1;
	let closeIndex = -1;
	for (let row = 0; row < rows.length; row++) {
		const line = rows[row];
		let cursor = 0;
		while (cursor <= line.length) {
			const open = line.indexOf(PROOF_OPEN, cursor);
			const close = line.indexOf(PROOF_CLOSE, cursor);
			if (open < 0 && close < 0) {
				break;
			}
			if (open >= 0 && (close < 0 || open < close)) {
				if (openRow >= 0) {
					return { failure: "REFLOW" };
				}
				openRow = row;
				openIndex = open;
				cursor = open + PROOF_OPEN.length;
				continue;
			}
			if (closeRow >= 0 || openRow < 0) {
				return { failure: "REFLOW" };
			}
			closeRow = row;
			closeIndex = close;
			cursor = close + PROOF_CLOSE.length;
		}
	}
	if (openRow < 0 || closeRow < 0) {
		return { failure: "REFLOW" };
	}
	const openCol = visibleWidth(rows[openRow].slice(0, openIndex));
	const closeCol = visibleWidth(rows[closeRow].slice(0, closeIndex));

	if (openRow === closeRow) {
		const visible = proofRowContent(rows[openRow]);
		const chunk = visibleColumnSlice(visible, openCol, closeCol);
		if (chunk === undefined) {
			return { failure: "REFLOW" };
		}
		if (chunk.length === 0 || chunk !== expected) {
			return { failure: "RENDER_EQUIVALENCE" };
		}
		return { segments: [{ row: openRow, startCol: openCol, endCol: openCol + visibleWidth(chunk) }], collected: chunk };
	}

	const startVisible = proofRowContent(rows[openRow]);
	if (visibleWidth(startVisible) <= openCol) {
		return { failure: "REFLOW" };
	}
	const continuationTexts: string[] = [];
	for (let row = openRow + 1; row <= closeRow; row++) {
		continuationTexts.push(proofRowContent(rows[row]));
	}
	const closeVisible = continuationTexts[continuationTexts.length - 1];
	// The first/intermediate rows may end with layout paint after the range (a table cell's padded border); the
	// continuation prefix and the row content end are searched as boundaries instead of being assumed.
	const contentEnds = visibleColumnBoundaries(startVisible).filter((column) => column > openCol);
	const prefixWidths = visibleColumnBoundaries(closeVisible).filter((column) => column < closeCol);
	const candidates: AltScreenSearchSegment[][] = [];
	const seen = new Set<string>();
	for (const prefixWidth of prefixWidths) {
		for (const contentEnd of contentEnds) {
			if (contentEnd <= prefixWidth) {
				continue;
			}
			const startChunk = visibleColumnSlice(startVisible, openCol, contentEnd);
			if (startChunk === undefined || !expected.startsWith(startChunk)) {
				continue;
			}
			let left = expected.slice(startChunk.length);
			let valid = true;
			const segments: AltScreenSearchSegment[] = [];
			if (visibleWidth(startChunk) > 0) {
				segments.push({ row: openRow, startCol: openCol, endCol: openCol + visibleWidth(startChunk) });
			}
			for (let index = 0; index < continuationTexts.length - 1; index++) {
				const visible = continuationTexts[index];
				if (visibleWidth(visible) < contentEnd) {
					valid = false;
					break;
				}
				const chunk = visibleColumnSlice(visible, prefixWidth, contentEnd);
				if (chunk === undefined || chunk.length === 0 || !left.startsWith(chunk)) {
					valid = false;
					break;
				}
				left = left.slice(chunk.length);
				segments.push({ row: openRow + 1 + index, startCol: prefixWidth, endCol: prefixWidth + visibleWidth(chunk) });
			}
			if (!valid) {
				continue;
			}
			const closeChunk = visibleColumnSlice(closeVisible, prefixWidth, closeCol);
			if (closeChunk === undefined || closeChunk.length === 0 || closeChunk !== left) {
				continue;
			}
			segments.push({ row: closeRow, startCol: prefixWidth, endCol: closeCol });
			const signature = segments.map((segment) => `${segment.row}:${segment.startCol}-${segment.endCol}`).join(",");
			if (seen.has(signature)) {
				continue;
			}
			seen.add(signature);
			candidates.push(segments);
		}
	}
	if (candidates.length !== 1) {
		return { failure: "REFLOW" };
	}
	return { segments: candidates[0]!, collected: expected };
}

const markdownParser = new Marked();
markdownParser.setOptions({
	tokenizer: new MarkdownTokenizer(),
});
markdownParser.use({
	tokenizer: { emStrong: markedCjkFriendly().tokenizer?.emStrong },
	extensions: [...LATEX_MARKDOWN_EXTENSIONS],
});

/**
 * Default text styling for markdown content.
 * Applied to all text unless overridden by markdown formatting.
 */
export interface DefaultTextStyle {
	/** Foreground color function */
	color?: (text: string) => string;
	/** Background color function */
	bgColor?: (text: string) => string;
	/** Bold text */
	bold?: boolean;
	/** Italic text */
	italic?: boolean;
	/** Strikethrough text */
	strikethrough?: boolean;
	/** Underline text */
	underline?: boolean;
}

/**
 * Theme functions for markdown elements.
 * Each function takes text and returns styled text with ANSI codes.
 */
export interface MarkdownTheme {
	heading: (text: string) => string;
	link: (text: string) => string;
	linkUrl: (text: string) => string;
	code: (text: string) => string;
	codeBlock: (text: string) => string;
	codeBlockBorder: (text: string) => string;
	quote: (text: string) => string;
	quoteBorder: (text: string) => string;
	hr: (text: string) => string;
	listBullet: (text: string) => string;
	bold: (text: string) => string;
	italic: (text: string) => string;
	strikethrough: (text: string) => string;
	underline: (text: string) => string;
	/** Highlighted lines of a code block. A Markdown component reuses the result for the same code until invalidate(). */
	highlightCode?: (code: string, lang?: string) => string[];
	/** Prefix applied to each rendered code block line (default: "  ") */
	codeBlockIndent?: string;
}

export interface MarkdownOptions {
	/** Preserve source list markers instead of normalizing them. */
	preserveOrderedListMarkers?: boolean;
	/** Preserve source backslash escapes instead of normalizing escaped punctuation. */
	preserveBackslashEscapes?: boolean;
	/** Transform source Markdown before parsing, with the exact width available for content. */
	transform?: (markdown: string, availableWidth: number) => string;
	/** Render supported LaTeX math expressions as Unicode text (default: true). */
	renderLatex?: boolean;
}

interface InlineStyleContext {
	applyText: (text: string) => string;
	stylePrefix: string;
}

/** A top-level block of the last render, keyed by its source, reused by the next render. */
interface RenderedBlock {
	/** Width and type of the following block (which decides the spacing) that the lines were rendered for. */
	width: number;
	nextTokenType: string | undefined;
	lines: string[];
	/** Highlighted lines of the block's code, keyed by language and source; they survive a resize or new spacing. */
	highlightedCode: Map<string, string[]>;
}

export class Markdown implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private defaultTextStyle?: DefaultTextStyle;
	private theme: MarkdownTheme;
	private options: MarkdownOptions;
	private defaultStylePrefix?: string;

	// Cache for rendered output
	private cachedText?: string;
	private cachedWidth?: number;
	private cachedLines?: string[];
	// Hyperlink capability the cached lines were rendered with. The render cache key never included capabilities, so a
	// proof refuses a cached render from a different capability epoch instead of pretending it is current.
	private cachedCapabilities?: boolean;
	// Parsed tokens depend only on the source, so they survive theme and width invalidation. Held weakly: a token tree is
	// about ten times the size of its source, and every message of a long transcript keeps a Markdown component. The
	// tokens survive a burst of re-renders, such as a theme preview, and are collected afterwards.
	private cachedTokens?: WeakRef<{ source: string; tokens: TokensList }>;
	// The last render's top-level blocks. While a message streams only its last block changes, so a render styles and
	// wraps only that block. Each render keeps only the blocks it used, which drops a streamed block's earlier versions.
	// Held weakly like the tokens: the blocks repeat the source in their keys and the code in their highlighting, and
	// only a burst of renders, such as streaming or a resize, needs them.
	private blocks?: WeakRef<Map<string, RenderedBlock>>;
	// Highlighted code of the block being rendered, only set while renderBlock runs.
	private blockHighlightedCode?: Map<string, string[]>;
	// Non-undefined ONLY during a proveSourceSpan() proof render.
	private proofState: ProofState | undefined;
	// Set ONLY by a proof-triggered normal render so it also fills the normal block cache; ordinary renders leave it
	// false and keep the fork's own reuse rule.
	private primingProofBlocks = false;

	constructor(
		text: string,
		paddingX: number,
		paddingY: number,
		theme: MarkdownTheme,
		defaultTextStyle?: DefaultTextStyle,
		options?: MarkdownOptions,
	) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.theme = theme;
		this.defaultTextStyle = defaultTextStyle;
		this.options = options ? { ...options } : {};
	}

	setText(text: string): void {
		this.text = text;
		this.clearRenderCache();
	}

	invalidate(): void {
		this.clearRenderCache();
		// The theme may have changed, which changes every styled line and the default style's prefix.
		this.blocks = undefined;
		this.defaultStylePrefix = undefined;
	}

	private clearRenderCache(): void {
		this.cachedText = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
		this.cachedCapabilities = undefined;
	}

	render(width: number): string[] {
		// Check cache
		if (this.cachedLines && this.cachedText === this.text && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const result = this.renderLines(width, false);
		this.cachedText = this.text;
		this.cachedWidth = width;
		this.cachedLines = result;
		this.cachedCapabilities = getCapabilities().hyperlinks;
		return result;
	}

	/**
	 * Prove ONE source-local UTF-16 range against THIS component's own current source and the painted cells of
	 * `render(width)`. The proof render runs the same parser and renderer and injects zero-width sentinels only into
	 * the emitted text of the target token; it is accepted only when the proof rows, with the sentinels removed, are
	 * byte-identical to the normal render. The normal render and block caches are never written by a proof.
	 */
	proveSourceSpan(
		range: { readonly start: number; readonly end: number },
		width: number,
	): MarkdownSourceCellProof {
		if (
			!Number.isInteger(range.start) ||
			!Number.isInteger(range.end) ||
			range.start < 0 ||
			range.end <= range.start ||
			range.end > this.text.length
		) {
			return { kind: "UNPROVEN", reason: "SOURCE_PROJECTION" };
		}
		// A source that already contains the private sentinels cannot be proven unambiguously.
		if (this.text.includes(PROOF_OPEN) || this.text.includes(PROOF_CLOSE)) {
			return { kind: "UNPROVEN", reason: "SOURCE_PROJECTION" };
		}
		const hyperlinks = getCapabilities().hyperlinks;
		if (
			this.cachedLines !== undefined &&
			this.cachedText === this.text &&
			this.cachedWidth === width &&
			this.cachedCapabilities !== undefined &&
			this.cachedCapabilities !== hyperlinks
		) {
			return { kind: "UNPROVEN", reason: "STALE_RENDER" };
		}
		// Freeze the normal rows first: the proof is valid for THIS render epoch only. A normal render performed on
		// behalf of a proof may also fill the normal block cache so the proof render can reuse every non-intersecting
		// block; ordinary renders never take this path and the proof render itself writes no cache.
		const cacheWasWarm =
			this.cachedLines !== undefined && this.cachedText === this.text && this.cachedWidth === width;
		this.primingProofBlocks = true;
		let normalRows: string[];
		try {
			normalRows = this.render(width);
		} finally {
			this.primingProofBlocks = false;
		}
		const cachedBlocks = this.blocks?.deref();
		if (cacheWasWarm && (cachedBlocks === undefined || cachedBlocks.size === 0)) {
			this.primeProofBlocks(width);
		}
		const state: ProofState = {
			request: {
				start: projectTabOffset(this.text, range.start),
				end: projectTabOffset(this.text, range.end),
			},
			origin: undefined,
			located: [],
			mappingFailure: undefined,
			sourceProjectionFailure: false,
			hrefCandidates: [],
			hrefTarget: undefined,
			wrappedLeaves: 0,
			suppressWrapping: false,
		};
		this.proofState = state;
		let proofRows: string[];
		try {
			proofRows = this.renderLines(width, true);
		} finally {
			this.proofState = undefined;
		}
		if (state.sourceProjectionFailure) {
			return { kind: "UNPROVEN", reason: "SOURCE_PROJECTION" };
		}
		if (state.mappingFailure !== undefined) {
			return { kind: "UNPROVEN", reason: "TOKEN_ORIGIN" };
		}
		if (proofRows.length !== normalRows.length) {
			return { kind: "UNPROVEN", reason: "RENDER_EQUIVALENCE" };
		}
		let sentinelRows = 0;
		for (let row = 0; row < proofRows.length; row++) {
			const proofRow = proofRows[row];
			if (proofRow.includes(PROOF_OPEN) || proofRow.includes(PROOF_CLOSE)) {
				sentinelRows += 1;
			}
			if (stripProofSentinels(proofRow) !== normalRows[row]) {
				return { kind: "UNPROVEN", reason: "RENDER_EQUIVALENCE" };
			}
		}
		if (sentinelRows === 0) {
			const request = state.request;
			if (state.hrefCandidates.some((candidate) => request.start >= candidate.start && request.end <= candidate.end)) {
				return { kind: "NOT_PAINTED", reason: "HIDDEN_LINK_TARGET" };
			}
			if (this.isMarkupOnlyRange(state)) {
				return { kind: "NOT_PAINTED", reason: "MARKUP_ONLY" };
			}
			return { kind: "UNPROVEN", reason: "TOKEN_ORIGIN" };
		}
		if (state.wrappedLeaves !== 1) {
			return { kind: "UNPROVEN", reason: "TOKEN_ORIGIN" };
		}
		const expected = this.text.slice(range.start, range.end);
		if (expected.includes("\n")) {
			return { kind: "UNPROVEN", reason: "REFLOW" };
		}
		const recovered = recoverProofSegments(proofRows, expected);
		if ("failure" in recovered) {
			return { kind: "UNPROVEN", reason: recovered.failure };
		}
		if (recovered.segments.length === 0) {
			return { kind: "UNPROVEN", reason: "SOURCE_PROJECTION" };
		}
		for (const segment of recovered.segments) {
			const normalRow = normalRows[segment.row];
			if (normalRow === undefined) {
				return { kind: "UNPROVEN", reason: "RENDER_EQUIVALENCE" };
			}
			if (segment.startCol < 0 || segment.endCol <= segment.startCol) {
				return { kind: "UNPROVEN", reason: "REFLOW" };
			}
			if (segment.endCol > visibleWidth(normalRow)) {
				return { kind: "UNPROVEN", reason: "RENDER_EQUIVALENCE" };
			}
		}
		return { kind: "PROVEN", segments: recovered.segments };
	}

	private renderLines(width: number, proofMode: boolean): string[] {
		// Calculate available width for content (subtract horizontal padding)
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const text = this.options.transform?.(this.text, contentWidth) ?? this.text;
		if (proofMode && text !== this.text) {
			// The parsed source is not the component's own source, so a component-local range has no meaning here.
			const state = this.proofState;
			if (state !== undefined) state.sourceProjectionFailure = true;
		}

		// Don't render anything if there's no actual text
		if (!text || text.trim() === "") {
			if (!proofMode) this.blocks = undefined;
			return [];
		}

		// Replace tabs with 3 spaces for consistent rendering
		const normalizedText = text.replace(/\t/g, "   ");

		// Parse markdown to HTML-like tokens
		const cached = this.cachedTokens?.deref();
		let tokens = cached?.source === normalizedText ? cached.tokens : undefined;
		if (!tokens) {
			tokens = markdownParser.lexer(normalizedText);
			trimPartialClosingFences(tokens);
			if (!proofMode) this.cachedTokens = new WeakRef({ source: normalizedText, tokens });
		}
		if (proofMode) this.prepareProof(normalizedText, tokens);

		// A reference link resolves through a definition anywhere in the text, so blocks with the same source can render
		// differently; such texts are rare in practice and render without reusing blocks.
		const reuseBlocks = Object.keys(tokens.links).length === 0;
		const previousBlocks = this.blocks?.deref();
		const blocks = new Map<string, RenderedBlock>();
		if (!proofMode) this.blocks = new WeakRef(blocks);
		const contentLines: string[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			const nextTokenType = tokens[i + 1]?.type;
			// Proof mode reuses the cached NORMAL block for every token that does not carry the requested range (its
			// lines contain no sentinel) and re-renders only the intersecting token. The local map is never stored.
			const proofTarget = proofMode && (this.proofIntersects(token) || this.proofNeedsHrefFallback(token));
			const key = proofTarget ? `${token.raw}\0proof` : token.raw;
			// A proof render reuses every cached NORMAL block that does not carry the requested range. Ordinary renders
			// keep the fork's own rule: reference-link texts disable previous-block reuse because their definitions can
			// change between renders; a proof-triggered priming render fills the cache from the current token tree, so
			// its blocks are safe to reuse for this epoch. The priming flag itself only widens what a render STORES:
			// a proof-triggered render of a text that normally caches blocks must keep reusing its unchanged blocks
			// (including their highlighted-code cache) exactly like an ordinary render.
			const readPrevious = proofMode || reuseBlocks;
			const reused = readPrevious && !proofTarget ? (blocks.get(key) ?? previousBlocks?.get(key)) : undefined;
			const block = reused ?? { width: -1, nextTokenType, lines: [], highlightedCode: new Map() };
			if (block.width !== width || block.nextTokenType !== nextTokenType) {
				this.renderBlock(block, token, nextTokenType, width, contentWidth);
			}
			if (reuseBlocks || this.primingProofBlocks) blocks.set(key, block);
			for (const line of block.lines) {
				contentLines.push(line);
			}
		}

		// Add top/bottom padding (empty lines)
		const bgFn = this.defaultTextStyle?.bgColor;
		const emptyLine = " ".repeat(width);
		const emptyLines: string[] = [];
		for (let i = 0; i < this.paddingY; i++) {
			const line = bgFn ? applyBackgroundToLine(emptyLine, width, bgFn) : emptyLine;
			emptyLines.push(line);
		}
		flattenLines(emptyLines);

		// Combine top padding, content, and bottom padding
		const result = emptyLines.concat(contentLines, emptyLines);

		return result.length > 0 ? result : [""];
	}

	/**
	 * Fill the normal block cache for this exact source/width with a normal-mode render, without touching the cached
	 * normal rows. Only a proof calls this; the cached blocks are ordinary normal blocks (no sentinel).
	 */
	private primeProofBlocks(width: number): void {
		const previous = this.primingProofBlocks;
		this.primingProofBlocks = true;
		try {
			this.renderLines(width, false);
		} finally {
			this.primingProofBlocks = previous;
		}
	}

	/** Whether this token owns a link that prints the fallback destination the request targets. */
	private proofNeedsHrefFallback(token: Token): boolean {
		const state = this.proofState;
		if (state === undefined || state.hrefTarget === undefined) {
			return false;
		}
		const href = state.hrefTarget.href;
		const pending = [token];
		while (pending.length > 0) {
			const current = pending.pop()!;
			if (current.type === "link" && (current as Token & { href?: unknown }).href === href) {
				return true;
			}
			pending.push(...childTokensOf(current));
		}
		return false;
	}

	/** Whether the requested range intersects one token's own source span. */
	private proofIntersects(token: Token): boolean {
		const state = this.proofState;
		if (state === undefined) {
			return false;
		}
		const origin = state.origin?.get(token);
		if (origin === undefined) {
			return false;
		}
		return state.request.start < origin.end && state.request.end > origin.start;
	}

	private proofFail(reason: string): void {
		const state = this.proofState;
		if (state !== undefined) {
			state.mappingFailure ??= reason;
		}
	}

	/**
	 * Map every token of the ACTUAL token tree to its absolute source span. Structural `indexOf` is only a candidate
	 * locator: child spans must stay ordered inside their parent and every stripped block view must line up line by
	 * line, or the mapping fails closed.
	 */
	private prepareProof(normalizedText: string, tokens: TokensList): void {
		const state = this.proofState;
		if (state === undefined || state.sourceProjectionFailure) {
			return;
		}
		const origin = new WeakMap<Token, TokenOrigin>();
		const located: LocatedToken[] = [];
		state.origin = origin;
		state.located = located;

		const register = (
			token: Token,
			raw: string,
			coordToAbsolute: (coordinate: number) => number | undefined,
			startCoordinate: number,
		): void => {
			const rawLines = raw.split("\n");
			const rawLineStarts: number[] = [];
			const lineStarts: number[] = [];
			let rawOffset = 0;
			for (const rawLine of rawLines) {
				rawLineStarts.push(rawOffset);
				const absolute = coordToAbsolute(startCoordinate + rawOffset);
				if (absolute === undefined) {
					state.mappingFailure ??= "token-line-unmapped";
					return;
				}
				lineStarts.push(absolute);
				rawOffset += rawLine.length + 1;
			}
			const lastLine = rawLines[rawLines.length - 1] ?? "";
			const entry: TokenOrigin = {
				start: lineStarts[0] ?? 0,
				end: (lineStarts[lineStarts.length - 1] ?? 0) + lastLine.length,
				lineStarts,
				rawLineStarts,
			};
			origin.set(token, entry);
			located.push({ token, origin: entry });
			locateChildren(token, raw, coordToAbsolute, startCoordinate);
		};

		const locateChildren = (
			token: Token,
			raw: string,
			coordToAbsolute: (coordinate: number) => number | undefined,
			startCoordinate: number,
		): void => {
			const children = childTokensOf(token);
			if (children.length === 0) {
				return;
			}
			const stripped = token.type === "blockquote" || token.type === "list_item";
			let view: { readonly text: string; readonly offsets: readonly number[] } | undefined;
			if (stripped) {
				const content = (token as Token & { text?: unknown }).text;
				if (typeof content !== "string") {
					state.mappingFailure ??= "stripped-block-content";
					return;
				}
				view = buildLineView(raw, content);
				if (view === undefined) {
					state.mappingFailure ??= "stripped-block-view";
					return;
				}
			}
			// A child of a stripped block is located in the token's stripped view; its raw text is contiguous in THAT
			// coordinate space, so the absolute offset of any child coordinate must run through the view's raw mapping.
			const childToAbsolute = (coordinate: number): number | undefined => {
				if (view === undefined) {
					return coordToAbsolute(startCoordinate + coordinate);
				}
				const rawOffset = view.offsets[coordinate];
				return rawOffset === undefined ? undefined : coordToAbsolute(startCoordinate + rawOffset);
			};
			const childText = view === undefined ? raw : view.text;
			let cursor = 0;
			for (const child of children) {
				const childRaw = typeof child.raw === "string" ? child.raw : "";
				if (childRaw === "") {
					continue;
				}
				const index = childText.indexOf(childRaw, cursor);
				if (index < 0) {
					state.mappingFailure ??= "child-raw-lookup";
					continue;
				}
				cursor = index + childRaw.length;
				register(child, childRaw, childToAbsolute, index);
			}
		};

		let topCursor = 0;
		for (const token of tokens) {
			const raw = typeof token.raw === "string" ? token.raw : "";
			if (raw === "") {
				continue;
			}
			const index = normalizedText.indexOf(raw, topCursor);
			if (index < 0) {
				state.mappingFailure ??= "top-token-raw-lookup";
				continue;
			}
			topCursor = index + raw.length;
			register(token, raw, (coordinate) => coordinate, index);
		}

		// A link/definition destination is the one non-painted source region F1 can classify: the painted label of a
		// link is a child leaf, while the destination itself is only ever hidden (OSC 8) or printed as the fallback.
		const request = state.request;
		const hyperlinks = getCapabilities().hyperlinks;
		for (const locatedToken of located) {
			const token = locatedToken.token;
			if (token.type !== "link" && token.type !== "def") {
				continue;
			}
			const href = (token as Token & { href?: unknown }).href;
			if (typeof href !== "string" || href.length === 0) {
				continue;
			}
			const rawLines = token.raw.split("\n");
			let index = token.raw.indexOf(href);
			while (index >= 0) {
				const absolute = absoluteFromRawOffset(locatedToken.origin, rawLines, index);
				const absoluteEnd = absoluteFromRawOffset(locatedToken.origin, rawLines, index + href.length);
				if (absolute !== undefined && absoluteEnd === absolute + href.length) {
					if (request.start >= absolute && request.end <= absoluteEnd) {
						if (hyperlinks) {
							state.hrefCandidates.push({ start: absolute, end: absoluteEnd });
						} else {
							const start = request.start - absolute;
							const end = request.end - absolute;
							if (isGraphemeBoundary(href, start) && isGraphemeBoundary(href, end)) {
								state.hrefTarget = { href, start, end };
							} else {
								state.mappingFailure ??= "href-grapheme-split";
							}
						}
						break;
					}
				}
				index = token.raw.indexOf(href, index + 1);
			}
		}
	}

	/**
	 * Wrap the emitted text of ONE leaf whose raw-to-emitted identity covers the request. `rawOffset` is where the
	 * emitted text starts inside the token raw (codespans and escapes print a sub-range of their raw). Anything that
	 * does not line up with a single source line fails closed; a request in the markup part of the leaf is left alone.
	 */
	private proofWrap(token: Token, emitted: string, rawOffset = 0): string {
		const state = this.proofState;
		if (state === undefined || state.suppressWrapping) {
			return emitted;
		}
		const origin = state.origin?.get(token);
		if (origin === undefined) {
			return emitted;
		}
		const request = state.request;
		if (request.end <= origin.start || request.start >= origin.end) {
			return emitted;
		}
		const raw = token.raw;
		if (raw.slice(rawOffset, rawOffset + emitted.length) !== emitted) {
			state.mappingFailure ??= "leaf-raw-text-mismatch";
			return emitted;
		}
		const rawLines = raw.split("\n");
		let line = -1;
		for (let index = 0; index < rawLines.length; index++) {
			const lineStart = origin.lineStarts[index] ?? origin.start;
			const lineEnd = lineStart + rawLines[index].length;
			if (request.start >= lineEnd || request.end <= lineStart) {
				continue;
			}
			if (request.start >= lineStart && request.end <= lineEnd) {
				line = index;
				break;
			}
			state.mappingFailure ??= "request-crosses-line";
			return emitted;
		}
		if (line < 0) {
			// The request sits in a stripped layout gap (blockquote marker or list indentation): nothing is painted.
			return emitted;
		}
		const lineStart = origin.lineStarts[line] ?? origin.start;
		const emittedStart = origin.rawLineStarts[line]! + (request.start - lineStart) - rawOffset;
		const emittedEnd = emittedStart + (request.end - request.start);
		if (emittedEnd <= 0 || emittedStart >= emitted.length) {
			return emitted;
		}
		if (emittedStart < 0 || emittedEnd > emitted.length) {
			state.mappingFailure ??= "request-crosses-leaf";
			return emitted;
		}
		if (!isGraphemeBoundary(emitted, emittedStart) || !isGraphemeBoundary(emitted, emittedEnd)) {
			state.mappingFailure ??= "grapheme-split";
			return emitted;
		}
		state.wrappedLeaves += 1;
		if (state.wrappedLeaves > 1) {
			state.mappingFailure ??= "request-spans-multiple-leaves";
		}
		return (
			emitted.slice(0, emittedStart) +
			PROOF_OPEN +
			emitted.slice(emittedStart, emittedEnd) +
			PROOF_CLOSE +
			emitted.slice(emittedEnd)
		);
	}

	/**
	 * Print a link's fallback destination. When the request targets this exact destination, the printed fallback IS
	 * the painted form of that source range, so it receives the proof sentinels.
	 */
	private printedHref(token: Token & { href: string }): string {
		const state = this.proofState;
		const href = token.href;
		if (state === undefined || state.suppressWrapping || state.hrefTarget === undefined) {
			return href;
		}
		const target = state.hrefTarget;
		if (target.href !== href) {
			return href;
		}
		state.wrappedLeaves += 1;
		if (state.wrappedLeaves > 1) {
			state.mappingFailure ??= "request-spans-multiple-leaves";
		}
		return href.slice(0, target.start) + PROOF_OPEN + href.slice(target.start, target.end) + PROOF_CLOSE + href.slice(target.end);
	}

	/** Wrap a rendered (possibly transformed) leaf only when its output is a direct source sub-range. */
	private proofWrapRendered(token: Token, emitted: string, pending: boolean): string {
		const state = this.proofState;
		if (state === undefined || state.suppressWrapping) {
			return emitted;
		}
		const origin = state.origin?.get(token);
		if (origin === undefined) {
			return emitted;
		}
		const request = state.request;
		if (request.end <= origin.start || request.start >= origin.end) {
			return emitted;
		}
		if (pending) {
			state.mappingFailure ??= "pending-math";
			return emitted;
		}
		const index = token.raw.indexOf(emitted);
		if (index < 0 || token.raw.indexOf(emitted, index + 1) >= 0) {
			state.mappingFailure ??= "rendered-text-not-in-source";
			return emitted;
		}
		return this.proofWrap(token, emitted, index);
	}

	/** Resolve the single source line/piece a code-block request maps to, inside the fence content only. */
	private proofCodeTrace(
		token: Token,
	): { readonly lineIndex: number; readonly start: number; readonly end: number } | undefined {
		const state = this.proofState;
		if (state === undefined) {
			return undefined;
		}
		const origin = state.origin?.get(token);
		if (origin === undefined) {
			return undefined;
		}
		const request = state.request;
		if (request.end <= origin.start || request.start >= origin.end) {
			return undefined;
		}
		const raw = token.raw;
		const firstNewline = raw.indexOf("\n");
		if (firstNewline < 0) {
			state.mappingFailure ??= "code-without-content";
			return undefined;
		}
		const contentBase = absoluteFromRawOffset(origin, raw.split("\n"), firstNewline + 1);
		if (contentBase === undefined) {
			state.mappingFailure ??= "code-source-offset";
			return undefined;
		}
		const codeText = (token as Tokens.Code).text;
		const view = buildLineView(raw.slice(firstNewline + 1), codeText);
		if (view === undefined) {
			state.mappingFailure ??= "code-source-mismatch";
			return undefined;
		}
		const codeLines = codeText.split("\n");
		let lineIndex = 0;
		for (let line = 0; line < codeLines.length; line++) {
			const absolute = contentBase + (view.offsets[lineIndex] ?? view.text.length);
			const lineEnd = absolute + codeLines[line].length;
			if (request.start >= lineEnd || request.end <= absolute) {
				lineIndex += codeLines[line].length + 1;
				continue;
			}
			if (request.start < absolute || request.end > lineEnd) {
				state.mappingFailure ??= "code-request-crosses-line";
				return undefined;
			}
			return { lineIndex: line, start: request.start - absolute, end: request.end - absolute };
		}
		state.mappingFailure ??= "code-fence-or-gap";
		return undefined;
	}

	/** Insert the proof sentinels into an already styled line whose visible text IS the source line. */
	private insertProofRange(styled: string, sourceLine: string, start: number, end: number, mismatchReason: string): string {
		if (stripTerminalSequences(styled) !== sourceLine || start < 0 || end > sourceLine.length || start >= end) {
			this.proofFail(mismatchReason);
			return styled;
		}
		if (!isGraphemeBoundary(sourceLine, start) || !isGraphemeBoundary(sourceLine, end)) {
			this.proofFail("grapheme-split");
			return styled;
		}
		let result = "";
		let plainIndex = 0;
		let index = 0;
		while (index < styled.length) {
			const ansi = extractAnsiCode(styled, index);
			if (ansi !== null) {
				result += ansi.code;
				index += ansi.length;
				continue;
			}
			if (plainIndex === start) {
				result += PROOF_OPEN;
			}
			if (plainIndex === end) {
				result += PROOF_CLOSE;
			}
			result += styled[index];
			plainIndex += 1;
			index += 1;
		}
		if (plainIndex !== sourceLine.length) {
			this.proofFail(mismatchReason);
			return styled;
		}
		if (plainIndex === end) {
			result += PROOF_CLOSE;
		}
		const state = this.proofState;
		if (state !== undefined) {
			state.wrappedLeaves += 1;
			if (state.wrappedLeaves > 1) {
				state.mappingFailure ??= "request-spans-multiple-leaves";
			}
		}
		return result;
	}

	/** Mark a non-inline block leaf the proof seam never traces as an explicit failure. */
	private proofUnsupported(token: Token): void {
		if (token.type === "def" || token.type === "space") {
			return;
		}
		const state = this.proofState;
		if (state === undefined) {
			return;
		}
		const origin = state.origin?.get(token);
		if (origin === undefined) {
			return;
		}
		const request = state.request;
		if (request.start < origin.end && request.end > origin.start) {
			state.mappingFailure ??= "unsupported-block-leaf";
		}
	}

	/** A request fully inside the markup delimiters of an inline wrapper is parser-proven markup only. */
	private isMarkupOnlyRange(state: ProofState): boolean {
		const wrappers = new Set(["strong", "em", "del", "link", "codespan"]);
		const request = state.request;
		for (const { token, origin } of state.located) {
			if (!wrappers.has(token.type)) {
				continue;
			}
			if (request.start < origin.start || request.end > origin.end) {
				continue;
			}
			let painted = false;
			for (const other of state.located) {
				if (other.token === token) {
					continue;
				}
				if (other.origin.start < origin.start || other.origin.end > origin.end) {
					continue;
				}
				if (other.origin.start <= request.start && other.origin.end >= request.end) {
					painted = true;
					break;
				}
			}
			if (!painted) {
				return true;
			}
		}
		return false;
	}

	/** Render one top-level block to output lines: wrapped, with margins, and padded or backgrounded to the width. */
	private renderBlock(
		block: RenderedBlock,
		token: Token,
		nextTokenType: string | undefined,
		width: number,
		contentWidth: number,
	): void {
		this.blockHighlightedCode = block.highlightedCode;
		const leftMargin = " ".repeat(this.paddingX);
		const rightMargin = " ".repeat(this.paddingX);
		const bgFn = this.defaultTextStyle?.bgColor;
		const lines: string[] = [];
		for (const line of this.renderToken(token, contentWidth, nextTokenType)) {
			if (isImageLine(line)) {
				lines.push(line);
				continue;
			}
			for (const wrappedLine of wrapTextWithAnsi(line, contentWidth)) {
				const lineWithMargins = leftMargin + wrappedLine + rightMargin;
				if (bgFn) {
					lines.push(applyBackgroundToLine(lineWithMargins, width, bgFn));
				} else {
					// No background - just pad to width
					const paddingNeeded = Math.max(0, width - visibleWidth(lineWithMargins));
					lines.push(lineWithMargins + " ".repeat(paddingNeeded));
				}
			}
		}
		this.blockHighlightedCode = undefined;
		flattenLines(lines);
		block.lines = lines;
		block.width = width;
		block.nextTokenType = nextTokenType;
	}

	/**
	 * Apply default text style to a string.
	 * This is the base styling applied to all text content.
	 * NOTE: Background color is NOT applied here - it's applied at the padding stage
	 * to ensure it extends to the full line width.
	 */
	private applyDefaultStyle(text: string): string {
		if (!this.defaultTextStyle) {
			return text;
		}

		let styled = text;

		// Apply foreground color (NOT background - that's applied at padding stage)
		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		// Apply text decorations using this.theme
		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		return styled;
	}

	private getDefaultStylePrefix(): string {
		if (!this.defaultTextStyle) {
			return "";
		}

		if (this.defaultStylePrefix !== undefined) {
			return this.defaultStylePrefix;
		}

		const sentinel = "\u0000";
		let styled = sentinel;

		if (this.defaultTextStyle.color) {
			styled = this.defaultTextStyle.color(styled);
		}

		if (this.defaultTextStyle.bold) {
			styled = this.theme.bold(styled);
		}
		if (this.defaultTextStyle.italic) {
			styled = this.theme.italic(styled);
		}
		if (this.defaultTextStyle.strikethrough) {
			styled = this.theme.strikethrough(styled);
		}
		if (this.defaultTextStyle.underline) {
			styled = this.theme.underline(styled);
		}

		const sentinelIndex = styled.indexOf(sentinel);
		this.defaultStylePrefix = sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
		return this.defaultStylePrefix;
	}

	private getStylePrefix(styleFn: (text: string) => string): string {
		const sentinel = "\u0000";
		const styled = styleFn(sentinel);
		const sentinelIndex = styled.indexOf(sentinel);
		return sentinelIndex >= 0 ? styled.slice(0, sentinelIndex) : "";
	}

	private getDefaultInlineStyleContext(): InlineStyleContext {
		return {
			applyText: (text: string) => this.applyDefaultStyle(text),
			stylePrefix: this.getDefaultStylePrefix(),
		};
	}

	private renderToken(
		token: Token,
		width: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];

		switch (token.type) {
			case "heading": {
				const headingLevel = token.depth;
				const headingPrefix = `${"#".repeat(headingLevel)} `;

				// Build a heading-specific style context so inline tokens (codespan, bold, etc.)
				// restore heading styling after their own ANSI resets instead of falling back to
				// the default text style.
				let headingStyleFn: (text: string) => string;
				if (headingLevel === 1) {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(this.theme.underline(text)));
				} else {
					headingStyleFn = (text: string) => this.theme.heading(this.theme.bold(text));
				}

				const headingStyleContext: InlineStyleContext = {
					applyText: headingStyleFn,
					stylePrefix: this.getStylePrefix(headingStyleFn),
				};

				const headingText = this.renderInlineTokens(token.tokens || [], headingStyleContext);
				const styledHeading = headingLevel >= 3 ? headingStyleFn(headingPrefix) + headingText : headingText;
				lines.push(styledHeading);
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after headings (unless space token follows)
				}
				break;
			}

			case "paragraph": {
				const paragraphText = this.renderInlineTokens(token.tokens || [], styleContext);
				lines.push(paragraphText);
				// Don't add spacing if next token is space or list
				if (nextTokenType && nextTokenType !== "list" && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "text":
				lines.push(this.renderInlineTokens([token], styleContext));
				break;

			case "latexBlock": {
				const latexToken = token as LatexToken;
				let rendered =
					!latexToken.pending && this.options.renderLatex !== false
						? renderLatex(latexToken.text, { display: true })
						: undefined;
				// A 2D layout cannot be wrapped row by row; fall back to the raw source when it does not fit.
				if (rendered === undefined || rendered.split("\n").some((line) => visibleWidth(line) > width)) {
					rendered = latexToken.raw.trim();
				}
				const tracedRendered = this.proofWrapRendered(token, rendered, latexToken.pending === true);
				for (const line of tracedRendered.split("\n")) {
					lines.push(this.applyDefaultStyle(line));
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push("");
				}
				break;
			}

			case "code": {
				const indent = this.theme.codeBlockIndent ?? "  ";
				const trace = this.proofCodeTrace(token);
				lines.push(this.theme.codeBlockBorder(`\`\`\`${token.lang || ""}`));
				const codeLines = token.text.split("\n");
				if (this.theme.highlightCode) {
					const key = `${token.lang ?? ""}\0${token.text}`;
					let highlighted = this.blockHighlightedCode?.get(key);
					if (!highlighted) {
						highlighted = this.theme.highlightCode(token.text, token.lang);
						this.blockHighlightedCode?.set(key, highlighted);
					}
					if (trace !== undefined && highlighted.length !== codeLines.length) {
						this.proofFail("code-highlight-line-count");
					}
					for (let index = 0; index < highlighted.length; index++) {
						let hlLine = highlighted[index]!;
						if (trace !== undefined && highlighted.length === codeLines.length && trace.lineIndex === index) {
							hlLine = this.insertProofRange(hlLine, codeLines[index]!, trace.start, trace.end, "code-highlight-mismatch");
						}
						lines.push(`${indent}${hlLine}`);
					}
				} else {
					// Split code by newlines and style each line
					for (let index = 0; index < codeLines.length; index++) {
						let codeLine = this.theme.codeBlock(codeLines[index]!);
						if (trace !== undefined && trace.lineIndex === index) {
							codeLine = this.insertProofRange(codeLine, codeLines[index]!, trace.start, trace.end, "code-style-mismatch");
						}
						lines.push(`${indent}${codeLine}`);
					}
				}
				lines.push(this.theme.codeBlockBorder("```"));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after code blocks (unless space token follows)
				}
				break;
			}

			case "list": {
				const listLines = this.renderList(token as Tokens.List, 0, width, styleContext);
				lines.push(...listLines);
				// Don't add spacing after lists if a space token follows
				// (the space token will handle it)
				break;
			}

			case "table": {
				const tableLines = this.renderTable(token as Tokens.Table, width, nextTokenType, styleContext);
				lines.push(...tableLines);
				break;
			}

			case "blockquote": {
				const quoteStyle = (text: string) => this.theme.quote(this.theme.italic(text));
				const quoteStylePrefix = this.getStylePrefix(quoteStyle);
				const applyQuoteStyle = (line: string): string => {
					if (!quoteStylePrefix) {
						return quoteStyle(line);
					}
					const lineWithReappliedStyle = line.replace(/\x1b\[0m/g, `\x1b[0m${quoteStylePrefix}`);
					return quoteStyle(lineWithReappliedStyle);
				};

				// With no room for another border ("│ " plus at least one content column), render the
				// nested content without one. Otherwise each extra level re-wraps every child line at
				// width 1 and the output grows exponentially with nesting depth.
				if (width < 3) {
					const quoteTokens = token.tokens || [];
					for (let i = 0; i < quoteTokens.length; i++) {
						for (const line of this.renderToken(quoteTokens[i], width, quoteTokens[i + 1]?.type, styleContext)) {
							lines.push(line);
						}
					}
					break;
				}

				// Calculate available width for quote content (subtract border "│ " = 2 chars)
				const quoteContentWidth = width - 2;

				// Blockquotes contain block-level tokens (paragraph, list, code, etc.), so render
				// children with renderToken() instead of renderInlineTokens().
				// Default message style should not apply inside blockquotes.
				const quoteInlineStyleContext: InlineStyleContext = {
					applyText: (text: string) => text,
					stylePrefix: quoteStylePrefix,
				};
				const quoteTokens = token.tokens || [];
				const renderedQuoteLines: string[] = [];
				for (let i = 0; i < quoteTokens.length; i++) {
					const quoteToken = quoteTokens[i];
					const nextQuoteToken = quoteTokens[i + 1];
					for (const line of this.renderToken(
						quoteToken,
						quoteContentWidth,
						nextQuoteToken?.type,
						quoteInlineStyleContext,
					)) {
						renderedQuoteLines.push(line);
					}
				}

				// Avoid rendering an extra empty quote line before the outer blockquote spacing.
				while (renderedQuoteLines.length > 0 && renderedQuoteLines[renderedQuoteLines.length - 1] === "") {
					renderedQuoteLines.pop();
				}

				for (const quoteLine of renderedQuoteLines) {
					const styledLine = applyQuoteStyle(quoteLine);
					const wrappedLines = wrapTextWithAnsi(styledLine, quoteContentWidth);
					for (const wrappedLine of wrappedLines) {
						lines.push(this.theme.quoteBorder("│ ") + wrappedLine);
					}
				}
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after blockquotes (unless space token follows)
				}
				break;
			}

			case "hr":
				lines.push(this.theme.hr("─".repeat(Math.min(width, 80))));
				if (nextTokenType && nextTokenType !== "space") {
					lines.push(""); // Add spacing after horizontal rules (unless space token follows)
				}
				break;

			case "html":
				// Render HTML as plain text (escaped for terminal)
				this.proofUnsupported(token);
				if ("raw" in token && typeof token.raw === "string") {
					lines.push(this.applyDefaultStyle(token.raw.trim()));
				}
				break;

			case "space":
				// Space tokens represent blank lines in markdown
				lines.push("");
				break;

			default:
				// Handle any other token types as plain text
				this.proofUnsupported(token);
				if ("text" in token && typeof token.text === "string") {
					lines.push(token.text);
				}
		}

		return lines;
	}

	private renderInlineTokens(tokens: Token[], styleContext?: InlineStyleContext): string {
		let result = "";
		const resolvedStyleContext = styleContext ?? this.getDefaultInlineStyleContext();
		const { applyText, stylePrefix } = resolvedStyleContext;
		const applyTextWithNewlines = (text: string): string => {
			const segments: string[] = text.split("\n");
			return segments.map((segment: string) => applyText(segment)).join("\n");
		};

		for (const token of tokens) {
			switch (token.type) {
				case "latex": {
					const latexToken = token as LatexToken;
					const rendered =
						!latexToken.pending && this.options.renderLatex !== false
							? (renderLatex(latexToken.text) ?? latexToken.raw)
							: latexToken.raw;
					result += applyTextWithNewlines(
						this.proofWrapRendered(token, rendered, latexToken.pending === true),
					);
					break;
				}

				case "escape": {
					const escaped = this.options.preserveBackslashEscapes ? token.raw : token.text;
					result += applyTextWithNewlines(this.proofWrap(token, escaped, Math.max(0, token.raw.indexOf(escaped))));
					break;
				}

				case "text":
					// Text tokens in list items can have nested tokens for inline formatting
					if (token.tokens && token.tokens.length > 0) {
						result += this.renderInlineTokens(token.tokens, resolvedStyleContext);
					} else {
						result += applyTextWithNewlines(this.proofWrap(token, token.text));
					}
					break;

				case "paragraph":
					// Paragraph tokens contain nested inline tokens
					result += this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					break;

				case "strong": {
					const boldContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.bold(boldContent) + stylePrefix;
					break;
				}

				case "em": {
					const italicContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.italic(italicContent) + stylePrefix;
					break;
				}

				case "codespan":
					result +=
						this.theme.code(this.proofWrap(token, token.text, Math.max(0, token.raw.indexOf(token.text)))) +
						stylePrefix;
					break;

				case "link": {
					const linkText = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					const styledLink = this.theme.link(this.theme.underline(linkText));
					if (getCapabilities().hyperlinks) {
						// OSC 8: render as a clickable hyperlink. The URL is not printed inline,
						// so we always show only the link text regardless of whether it matches href.
						result += hyperlink(styledLink, token.href) + stylePrefix;
					} else {
						// Fallback: print URL in parentheses when text differs from href.
						// Compare raw token.text (not styled) against href for the equality check.
						// For mailto: links strip the prefix (autolinked emails use text="foo@bar.com"
						// but href="mailto:foo@bar.com").
						const hrefForComparison = token.href.startsWith("mailto:") ? token.href.slice(7) : token.href;
						if (token.text === token.href || token.text === hrefForComparison) {
							result += styledLink + stylePrefix;
						} else {
							result += styledLink + this.theme.linkUrl(` (${this.printedHref(token as Tokens.Link)})`) + stylePrefix;
						}
					}
					break;
				}

				case "br":
					result += "\n";
					break;

				case "del": {
					const delContent = this.renderInlineTokens(token.tokens || [], resolvedStyleContext);
					result += this.theme.strikethrough(delContent) + stylePrefix;
					break;
				}

				case "html":
					// Render inline HTML as plain text
					if ("raw" in token && typeof token.raw === "string") {
						result += applyTextWithNewlines(this.proofWrap(token, token.raw));
					}
					break;

				default:
					// Handle any other inline token types as plain text
					if ("text" in token && typeof token.text === "string") {
						result += applyTextWithNewlines(this.proofWrap(token, token.text));
					}
			}
		}

		while (stylePrefix && result.endsWith(stylePrefix)) {
			result = result.slice(0, -stylePrefix.length);
		}

		return result;
	}

	private getOrderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})(\d{1,9}[.)])[ \t]+/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	private getUnorderedListMarker(item: Tokens.ListItem): string | undefined {
		const match = /^(?: {0,3})([-+*])(?:[ \t]+|(?=\r?\n|$))/.exec(item.raw);
		return match ? `${match[1]} ` : undefined;
	}

	/**
	 * Render a list with proper nesting support
	 */
	private renderList(token: Tokens.List, depth: number, width: number, styleContext?: InlineStyleContext): string[] {
		const lines: string[] = [];
		const indent = "    ".repeat(depth);
		// Use the list's start property (defaults to 1 for ordered lists)
		const startNumber = typeof token.start === "number" ? token.start : 1;

		for (let i = 0; i < token.items.length; i++) {
			const item = token.items[i];
			const isLastItem = i === token.items.length - 1;
			const bullet = token.ordered
				? this.options.preserveOrderedListMarkers
					? (this.getOrderedListMarker(item) ?? `${startNumber + i}. `)
					: `${startNumber + i}. `
				: this.options.preserveOrderedListMarkers
					? (this.getUnorderedListMarker(item) ?? "- ")
					: "- ";
			const taskMarker = item.task ? `[${item.checked ? "x" : " "}] ` : "";
			const marker = bullet + taskMarker;
			const firstPrefix = indent + this.theme.listBullet(marker);
			const continuationPrefix = indent + " ".repeat(visibleWidth(marker));
			const itemWidth = Math.max(1, width - visibleWidth(firstPrefix));
			let renderedAnyLine = false;

			for (const itemToken of item.tokens) {
				if (itemToken.type === "list") {
					lines.push(...this.renderList(itemToken as Tokens.List, depth + 1, width, styleContext));
					renderedAnyLine = true;
					continue;
				}

				const itemLines = this.renderToken(itemToken, itemWidth, undefined, styleContext);
				for (const line of itemLines) {
					for (const wrappedLine of wrapTextWithAnsi(line, itemWidth)) {
						const linePrefix = renderedAnyLine ? continuationPrefix : firstPrefix;
						lines.push(linePrefix + wrappedLine);
						renderedAnyLine = true;
					}
				}
			}

			if (!renderedAnyLine) {
				lines.push(firstPrefix);
			}

			if (token.loose && !isLastItem) {
				lines.push("");
			}
		}

		return lines;
	}

	/**
	 * Get the visible width of the longest word in a string.
	 */
	private getLongestWordWidth(text: string, maxWidth?: number): number {
		const words = text.split(/\s+/).filter((word) => word.length > 0);
		let longest = 0;
		for (const word of words) {
			longest = Math.max(longest, visibleWidth(word));
		}
		if (maxWidth === undefined) {
			return longest;
		}
		return Math.min(longest, maxWidth);
	}

	/**
	 * Wrap a table cell to fit into a column.
	 *
	 * Delegates to wrapTextWithAnsi() so ANSI codes + long tokens are handled
	 * consistently with the rest of the renderer.
	 */
	private wrapCellText(text: string, maxWidth: number, stylePrefix = ""): string[] {
		const lines = wrapTextWithAnsi(text, Math.max(1, maxWidth));
		return lines.map((line, index) => {
			// Reset text styles after each non-final fragment, then restore the surrounding style before padding and borders.
			const styleReset = index < lines.length - 1 ? "\x1b[22;23;24;25;27;28;29;39m" : "";
			return `${line}${styleReset}${stylePrefix}`;
		});
	}

	/**
	 * Render a table with width-aware cell wrapping.
	 * Cells that don't fit are wrapped to multiple lines.
	 */
	private renderTable(
		token: Tokens.Table,
		availableWidth: number,
		nextTokenType?: string,
		styleContext?: InlineStyleContext,
	): string[] {
		const lines: string[] = [];
		const numCols = token.header.length;

		if (numCols === 0) {
			return lines;
		}

		// Calculate border overhead: "│ " + (n-1) * " │ " + " │"
		// = 2 + (n-1) * 3 + 2 = 3n + 1
		const borderOverhead = 3 * numCols + 1;
		const availableForCells = availableWidth - borderOverhead;
		if (availableForCells < numCols) {
			// Too narrow to render a stable table. Fall back to raw markdown.
			const fallbackLines = token.raw ? wrapTextWithAnsi(token.raw, availableWidth) : [];
			if (nextTokenType && nextTokenType !== "space") {
				fallbackLines.push("");
			}
			return fallbackLines;
		}

		const maxUnbrokenWordWidth = 30;

		// Calculate natural column widths (what each column needs without constraints). These renders only measure text
		// that is thrown away, so a proof must not trace them: the real cell render below owns the single trace.
		const naturalWidths: number[] = [];
		const minWordWidths: number[] = [];
		const proofState = this.proofState;
		if (proofState !== undefined) {
			proofState.suppressWrapping = true;
		}
		try {
			for (let i = 0; i < numCols; i++) {
				const headerText = this.renderInlineTokens(token.header[i].tokens || [], styleContext);
				naturalWidths[i] = visibleWidth(headerText);
				minWordWidths[i] = Math.max(1, this.getLongestWordWidth(headerText, maxUnbrokenWordWidth));
			}
			for (const row of token.rows) {
				for (let i = 0; i < row.length; i++) {
					const cellText = this.renderInlineTokens(row[i].tokens || [], styleContext);
					naturalWidths[i] = Math.max(naturalWidths[i] || 0, visibleWidth(cellText));
					minWordWidths[i] = Math.max(
						minWordWidths[i] || 1,
						this.getLongestWordWidth(cellText, maxUnbrokenWordWidth),
					);
				}
			}
		} finally {
			if (proofState !== undefined) {
				proofState.suppressWrapping = false;
			}
		}

		let minColumnWidths = minWordWidths;
		let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

		if (minCellsWidth > availableForCells) {
			minColumnWidths = new Array(numCols).fill(1);
			const remaining = availableForCells - numCols;

			if (remaining > 0) {
				const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
				const growth = minWordWidths.map((width) => {
					const weight = Math.max(0, width - 1);
					return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
				});

				for (let i = 0; i < numCols; i++) {
					minColumnWidths[i] += growth[i] ?? 0;
				}

				const allocated = growth.reduce((total, width) => total + width, 0);
				let leftover = remaining - allocated;
				for (let i = 0; leftover > 0 && i < numCols; i++) {
					minColumnWidths[i]++;
					leftover--;
				}
			}

			minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
		}

		// Calculate column widths that fit within available width
		const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
		let columnWidths: number[];

		if (totalNaturalWidth <= availableWidth) {
			// Everything fits naturally
			columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index]));
		} else {
			// Need to shrink columns to fit
			const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
				return total + Math.max(0, width - minColumnWidths[index]);
			}, 0);
			const extraWidth = Math.max(0, availableForCells - minCellsWidth);
			columnWidths = minColumnWidths.map((minWidth, index) => {
				const naturalWidth = naturalWidths[index];
				const minWidthDelta = Math.max(0, naturalWidth - minWidth);
				let grow = 0;
				if (totalGrowPotential > 0) {
					grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
				}
				return minWidth + grow;
			});

			// Adjust for rounding errors - distribute remaining space
			const allocated = columnWidths.reduce((a, b) => a + b, 0);
			let remaining = availableForCells - allocated;
			while (remaining > 0) {
				let grew = false;
				for (let i = 0; i < numCols && remaining > 0; i++) {
					if (columnWidths[i] < naturalWidths[i]) {
						columnWidths[i]++;
						remaining--;
						grew = true;
					}
				}
				if (!grew) {
					break;
				}
			}
		}

		// Render top border
		const topBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`┌─${topBorderCells.join("─┬─")}─┐`);

		// Render header with wrapping
		const headerCellLines: string[][] = token.header.map((cell, i) => {
			const text = this.renderInlineTokens(cell.tokens || [], styleContext);
			return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
		});
		const headerLineCount = Math.max(...headerCellLines.map((c) => c.length));

		for (let lineIdx = 0; lineIdx < headerLineCount; lineIdx++) {
			const rowParts = headerCellLines.map((cellLines, colIdx) => {
				const text = cellLines[lineIdx] || "";
				const padded = text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				return this.theme.bold(padded);
			});
			lines.push(`│ ${rowParts.join(" │ ")} │`);
		}

		// Render separator
		const separatorCells = columnWidths.map((w) => "─".repeat(w));
		const separatorLine = `├─${separatorCells.join("─┼─")}─┤`;
		lines.push(separatorLine);

		// Render rows with wrapping
		for (let rowIndex = 0; rowIndex < token.rows.length; rowIndex++) {
			const row = token.rows[rowIndex];
			const rowCellLines: string[][] = row.map((cell, i) => {
				const text = this.renderInlineTokens(cell.tokens || [], styleContext);
				return this.wrapCellText(text, columnWidths[i], styleContext?.stylePrefix);
			});
			const rowLineCount = Math.max(...rowCellLines.map((c) => c.length));

			for (let lineIdx = 0; lineIdx < rowLineCount; lineIdx++) {
				const rowParts = rowCellLines.map((cellLines, colIdx) => {
					const text = cellLines[lineIdx] || "";
					return text + " ".repeat(Math.max(0, columnWidths[colIdx] - visibleWidth(text)));
				});
				lines.push(`│ ${rowParts.join(" │ ")} │`);
			}

			if (rowIndex < token.rows.length - 1) {
				lines.push(separatorLine);
			}
		}

		// Render bottom border
		const bottomBorderCells = columnWidths.map((w) => "─".repeat(w));
		lines.push(`└─${bottomBorderCells.join("─┴─")}─┘`);

		if (nextTokenType && nextTokenType !== "space") {
			lines.push(""); // Add spacing after table
		}
		return lines;
	}
}
