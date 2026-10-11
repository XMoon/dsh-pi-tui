#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/bench/div-cache-ab — isolated A/B benchmark for
 * the three PERF_HOST_DEPENDENT divergences: X039 (`WIDTH_CACHE_SIZE`),
 * X014 (per-frame `LayoutContext.maxWidthCache`) and X035 (main-screen
 * per-frame processed-line reuse). Measurement only: it never changes
 * production source, and no divergence status is implied by its numbers.
 *
 * The durable record of the measured verdicts lives in
 * `docs/perf-baseline.md` ("DIV cache A/B evidence: X039 / X014 / X035");
 * per-round raw data is an untracked investigation artifact under `temp/perf/`.
 *
 * Variants are built from the SAME commit in throwaway worktrees, each
 * exposing its own `packages/pi-tui/dist/index.mjs`; this harness loads exactly
 * the entry it is given (`--entry`, default: this worktree's dist) so a variant
 * can never silently measure another variant's build.
 *
 * The three families:
 *   X039 — does `WIDTH_CACHE_SIZE = 4096` (fork) beat upstream's `512` for
 *          non-ASCII (`visibleWidth` cache) workloads?
 *   X014 — does the per-frame `LayoutContext.maxWidthCache` (fork) beat
 *          upstream's repeated `renderCached(...).reduce(max visibleWidth)`
 *          in layouts that repeat a width measurement?
 *   X035 — how much does `TuiMainScreen`'s same-raw-line preprocessing fast
 *          path save on the real Regular screen, per line count and dirty
 *          fraction? (`NO_RAW_REUSE` disables ONLY that fast path.)
 *
 * Usage
 * -----
 * Worker (one variant, one workload, one trial in a FRESH process):
 *   node --expose-gc --import tsx/esm scripts/bench/div-cache-ab.mts \
 *     --entry <abs path to dist/index.mjs> --workload <id> --trial cold|warm \
 *     [--passes N] [--lines N] [--cols N] [--rows N] [--frames N] [--json out.json]
 *
 * Orchestrator (all variants, interleaved rounds, machine-readable + table):
 *   node --expose-gc --import tsx/esm scripts/bench/div-cache-ab.mts \
 *     --variants BASE=<path>,W512=<path>,NO_LAYOUT_CACHE=<path>,BOTH_OFF=<path> \
 *     --rounds 21 --out temp/perf/div-cache-ab
 *
 * ALWAYS run this harness under a hard memory + wall-clock cap, e.g.
 *   systemd-run --user --scope -p MemoryMax=2G -p MemorySwapMax=0 \
 *     timeout 120 node --expose-gc --import tsx/esm scripts/bench/div-cache-ab.mts ...
 * A workload bug must never be able to thrash the host (it did once: an
 * `i < lines || 300` precedence mistake spun forever and reached 4.2G).
 *
 * The orchestrator spawns ONE worker process per (round, variant, workload) and
 * rotates the variant order per round (Latin-square-style) so thermal drift and
 * cache warming cannot favour a single variant. Every worker reports a result
 * hash; the orchestrator asserts that all variants produce the SAME hash for a
 * workload (geometry/width equivalence) and fails loudly otherwise.
 *
 * @module div-cache-ab
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, totalmem } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')
const DEFAULT_ENTRY = join(REPO_ROOT, 'packages', 'pi-tui', 'dist', 'index.mjs')

// ── minimal structural view of the fork entry ───────────────────────────────

interface Component {
	render(width: number): string[]
	invalidate?(): void
}

interface TerminalLike {
	start(onInput: (data: string) => void, onResize: () => void): void
	stop(): void
	drainInput(maxMs?: number, idleMs?: number): Promise<void>
	write(data: string): void
	readonly columns: number
	readonly rows: number
	readonly kittyProtocolActive: boolean
	moveBy(lines: number): void
	hideCursor?(): void
	showCursor?(): void
	clearLine?(): void
	clearFromCursor?(): void
	clearScreen?(): void
	setTitle?(title: string): void
	setProgress?(active: boolean): void
	setProgramStatus?(): void
}

interface TuiLike {
	setLayoutRoot(component: Component | undefined): void
	start(): void
	renderNow(): void
	stop(): void
}

interface StackEntryLike {
	component: Component
	basis?: number | 'auto'
	grow?: number
	shrink?: number
	minSize?: number
	maxSize?: number
}

interface MainScreenLike {
	addChild(component: Component): void
	setFocus(component: Component): void
	renderNow(): void
	stop(): void
}

interface ForkEntry {
	TuiMainScreen: new (terminal: TerminalLike) => MainScreenLike
	visibleWidth(str: string): number
	wrapTextWithAnsi(str: string, width: number): string[]
	Text: new (text: string, x?: number, y?: number) => Component
	VStack: new (children: Array<Component | StackEntryLike>, options?: Record<string, unknown>) => Component
	HStack: new (children: Array<Component | StackEntryLike>, options?: Record<string, unknown>) => Component
	ScrollView: new (child: Component, options?: Record<string, unknown>) => Component
	Container: new () => Component & { addChild(child: Component): void }
	TuiAltScreen: new (
		terminal: TerminalLike,
		showHardwareCursor?: boolean,
		logDirectory?: string,
		options?: Record<string, unknown>,
	) => TuiLike
}

async function loadEntry(path: string): Promise<ForkEntry> {
	const mod = (await import(path)) as unknown as Record<string, unknown>
	for (const key of ['visibleWidth', 'wrapTextWithAnsi', 'Text', 'VStack', 'HStack', 'ScrollView', 'Container', 'TuiAltScreen', 'TuiMainScreen']) {
		if (mod[key] === undefined) throw new Error(`entry ${path} does not export ${key}`)
	}
	return mod as unknown as ForkEntry
}

/** Terminal that discards output: keeps xterm/ANSI parsing out of the timing. */
class NullTerminal implements TerminalLike {
	bytesWritten = 0
	/** FNV-1a over every byte written: cross-variant output equivalence. */
	writeHash = 0x811c9dc5
	private readonly colCount: number
	private readonly rowCount: number
	constructor(cols: number, rows: number) {
		this.colCount = cols
		this.rowCount = rows
	}
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	write(data: string): void {
		this.bytesWritten += data.length
		this.writeHash = fnv1a(data, this.writeHash)
	}
	set columns(value: number) {
		;(this as unknown as { colCount: number }).colCount = value
	}
	set rows(value: number) {
		;(this as unknown as { rowCount: number }).rowCount = value
	}
	get columns(): number {
		return this.colCount
	}
	get rows(): number {
		return this.rowCount
	}
	get kittyProtocolActive(): boolean {
		return false
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}
}

// ── deterministic corpora ───────────────────────────────────────────────────

/** Small deterministic PRNG so every variant sees byte-identical datasets. */
function makeRandom(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0
		return state / 0x1_0000_0000
	}
}

const CJK_POOL = ['宽', '字', '符', '中', '文', '消', '息', '排', '版', '合', '成', '终', '端']
const EMOJI_POOL = ['🙂', '🚀', '✅', '📦', '🧪', '🧭']

/** `count` DISTINCT non-ASCII strings (each with a unique index marker). */
function makeNonAsciiCorpus(count: number, seed: number, withAnsi: boolean): string[] {
	const random = makeRandom(seed)
	const out: string[] = new Array(count)
	for (let i = 0; i < count; i += 1) {
		const chars: string[] = []
		const length = 12 + Math.floor(random() * 20)
		for (let c = 0; c < length; c += 1) {
			chars.push(random() < 0.12 ? EMOJI_POOL[Math.floor(random() * EMOJI_POOL.length)]! : CJK_POOL[Math.floor(random() * CJK_POOL.length)]!)
		}
		const text = `${chars.join('')}#${i}`
		out[i] = withAnsi ? `\x1b[2m${text}\x1b[22m` : text
	}
	return out
}

function makeAsciiCorpus(count: number): string[] {
	const out: string[] = new Array(count)
	for (let i = 0; i < count; i += 1) {
		out[i] = `\x1b[36mchunk ${i}\x1b[39m plain ascii scaffolding line with padding ${'.'.repeat(i % 24)}`
	}
	return out
}

/** `value` when it is a positive integer, else `fallback` (never `x || n`,
 * which silently accepts a negative value or a precedence mistake). */
function positiveOr(value: number, fallback: number): number {
	if (!Number.isFinite(value) || value <= 0) return fallback
	return Math.floor(value)
}

/** Hard sanity caps: a typo must fail loudly instead of allocating the host. */
const MAX_LINES = 20_000
const MAX_FRAMES = 2_000
const MAX_ROUNDS = 200
const MAX_COLS = 1_000
const MAX_ROWS = 500
const MIN_WORKER_TIMEOUT_MS = 1_000
const MAX_WORKER_TIMEOUT_MS = 3_600_000

function bounded(value: number, fallback: number, max: number, label: string): number {
	const resolved = positiveOr(value, fallback)
	if (resolved > max) throw new Error(`${label}=${resolved} exceeds the safety cap ${max}`)
	return resolved
}

/** Clamp a numeric CLI knob into an inclusive range (fail fast, never default silently). */
function ranged(value: number, min: number, max: number, label: string): number {
	if (!Number.isFinite(value) || value < min || value > max) {
		throw new Error(`${label}=${String(value)} must be within ${min}..${max}`)
	}
	return Math.floor(value)
}

function fnv1a(text: string, seed = 0x811c9dc5): number {
	let hash = seed
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash >>> 0
}

// ── workloads ───────────────────────────────────────────────────────────────

interface Workload {
	readonly id: string
	readonly family: 'X039' | 'X014' | 'X035'
	/** Human-readable description for the report. */
	readonly description: string
	/** Runs one measured trial and returns the measured milliseconds + result hash. */
	run(entry: ForkEntry, args: Args): { ms: number; hash: number; ops: number; probe?: Record<string, number> }
}

interface Args {
	entry: string
	workload: string
	trial: 'cold' | 'warm'
	passes: number
	lines: number
	cols: number
	rows: number
	frames: number
	json?: string
}

/** X039: measure a corpus through `visibleWidth`, hashing every result. */
function widthWorkload(
	id: string,
	description: string,
	corpus: (args: Args) => string[],
	passes: (args: Args) => number,
): Workload {
	return {
		id,
		family: 'X039',
		description,
		run(entry, args) {
			const warmup = makeNonAsciiCorpus(64, 99, true)
			for (const line of warmup) entry.visibleWidth(line)
			const data = corpus(args)
			const passCount = passes(args)
			let hash = 0x811c9dc5
			let ops = 0
			const start = performance.now()
			for (let pass = 0; pass < passCount; pass += 1) {
				for (let i = 0; i < data.length; i += 1) {
					const width = entry.visibleWidth(data[i]!)
					hash = fnv1a(`${width}:`, hash)
					ops += 1
				}
			}
			const ms = performance.now() - start
			return { ms, hash, ops }
		},
	}
}

const X039_WORKLOADS: Workload[] = [
	widthWorkload(
		'width-ascii-control',
		'4000 styled ASCII lines — visibleWidth fast path (cache bypassed): control workload',
		args => makeAsciiCorpus(bounded(args.lines, 4000, MAX_LINES, 'lines')),
		() => 1,
	),
	widthWorkload(
		'width-cjk-warm-1024',
		'1024 distinct styled CJK/emoji lines, warm repeated pass (above the 512-entry cache, below 4096)',
		args => makeNonAsciiCorpus(bounded(args.lines, 1024, MAX_LINES, 'lines'), 7, true),
		args => (args.trial === 'warm' ? 2 : 1),
	),
	widthWorkload(
		'width-cjk-warm-4096',
		'4096 distinct styled CJK/emoji lines, warm repeated pass (exactly the fork cache size)',
		args => makeNonAsciiCorpus(bounded(args.lines, 4096, MAX_LINES, 'lines'), 11, true),
		args => (args.trial === 'warm' ? 2 : 1),
	),
	widthWorkload(
		'width-cjk-distinct-8192',
		'8192 distinct styled CJK/emoji lines (above BOTH cache sizes): eviction stress, cold single pass',
		args => makeNonAsciiCorpus(bounded(args.lines, 8192, MAX_LINES, 'lines'), 13, true),
		() => 1,
	),
	widthWorkload(
		'width-cjk-plain-long',
		'1000 distinct plain (unstyled) long CJK lines, warm repeated pass — the transcript text path',
		args => makeNonAsciiCorpus(bounded(args.lines, 1000, MAX_LINES, 'lines'), 17, false),
		args => (args.trial === 'warm' ? 2 : 1),
	),
	{
		id: 'width-wrapped-transcript-pass',
		family: 'X039',
		description: 'wrapTextWithAnsi + per-row visibleWidth over a 600-line CJK transcript: one representative render pass',
		run(entry, args) {
			const corpus = makeNonAsciiCorpus(bounded(args.lines, 600, MAX_LINES, 'lines'), 23, true)
			const wrapped: string[][] = corpus.map(line => entry.wrapTextWithAnsi(line, args.cols))
			const warmup = entry.wrapTextWithAnsi(makeNonAsciiCorpus(1, 99, true)[0]!, args.cols)
			for (const line of warmup) entry.visibleWidth(line)
			let hash = 0x811c9dc5
			let ops = 0
			const start = performance.now()
			for (const rows of wrapped) {
				for (const row of rows) {
					hash = fnv1a(`${entry.visibleWidth(row)}:`, hash)
					ops += 1
				}
			}
			return { ms: performance.now() - start, hash, ops }
		},
	},
]

interface LayoutParts {
	root: Component
	frame(i: number): void
}

/** X014 layout shapes, built with the fork's own components. */
function buildLayout(entry: ForkEntry, shape: string, args: Args): LayoutParts {
	const { Text, VStack, HStack, ScrollView, Container } = entry
	const cols = args.cols
	if (shape === 'auto-hstack') {
		// Every entry has no numeric basis -> one measureWidth call each, and the
		// same (component,width) is never measured twice in a frame.
		const rowOf = (n: number): Component => {
			const children: Component[] = []
			for (let i = 0; i < n; i += 1) {
				children.push(new Text(makeNonAsciiCorpus(1, 100 + i, false)[0]!.repeat(1) + ` col${i}`, 0, 0))
			}
			return new HStack(children, { gap: 1 })
		}
		const rows: Component[] = []
		for (let i = 0; i < 12; i += 1) rows.push(rowOf(8))
		const root = new VStack(rows.map(component => ({ component, shrink: 0 })))
		return { root, frame: () => {} }
	}
	if (shape === 'aliased-hstack') {
		// The cache's BEST case: one component instance measured from several
		// auto entries in the same frame (repeat factor > 1).
		const longCjk = makeNonAsciiCorpus(1, 31, false)[0]!.repeat(6)
		const shared = new Text(longCjk, 0, 0)
		const sharedSecond = new Text(longCjk + 'b', 0, 0)
		const hstack = new HStack(
			[
				{ component: shared, basis: 'auto' },
				{ component: shared, basis: 'auto' },
				{ component: sharedSecond, basis: 'auto' },
				{ component: sharedSecond, basis: 'auto' },
				{ component: shared, basis: 'auto' },
			],
			{ gap: 1 },
		)
		const root = new VStack([{ component: hstack, shrink: 0 }])
		return { root, frame: () => {} }
	}
	if (shape === 'host-tree') {
		// Mirrors the host's fullscreen tree: NO auto-basis entry exists, so
		// measureWidth is never called (the fork cache is inert here).
		const transcript = new Container()
		const transcriptLines = bounded(args.lines, 300, MAX_LINES, 'lines')
		for (let i = 0; i < transcriptLines; i += 1) {
			transcript.addChild(new Text(makeNonAsciiCorpus(1, 200 + i, false)[0]!, 1, 0))
		}
		const scrollView = new ScrollView(transcript, { follow: 'end', primary: true, overscroll: 'chain', scrollbar: 'auto' })
		const status = new Text('\x1b[2mstatus: idle\x1b[22m', 1, 0)
		const footer = new Text('\x1b[2m~/workspaces/pi  main  100k tokens\x1b[22m', 1, 0)
		const dock = new VStack([
			{ component: status, shrink: 1, minSize: 1 },
			{ component: footer, shrink: 1, minSize: 1 },
		])
		const root = new VStack([
			{ component: scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, shrink: 1, minSize: 1 },
		])
		return { root, frame: () => {} }
	}
	// shape === 'auto-hstack-churn': REAL auto-basis HStack rows whose text value
	// changes every frame, so renderLayoutFrame re-measures every
	// (component,width) pair through the X014 path on every frame. The previous
	// version of this shape was a padded VStack of plain Texts: it never called
	// measureWidth at all and therefore was not an X014 churn control.
	const churnCells: ChurnText[] = []
	const churnRows: Component[] = []
	for (let row = 0; row < 10; row += 1) {
		const entries: Array<{ component: Component; basis: 'auto' }> = []
		for (let cell = 0; cell < 6; cell += 1) {
			const text = new ChurnText(makeNonAsciiCorpus(1, 300 + row * 10 + cell, false)[0]!, entry.wrapTextWithAnsi)
			churnCells.push(text)
			entries.push({ component: text, basis: 'auto' })
		}
		churnRows.push(new HStack(entries, { gap: 1 }))
	}
	const root = new VStack(churnRows.map(component => ({ component, shrink: 0 })))
	let churnFrame = 0
	return {
		root,
		frame: () => {
			churnFrame += 1
			// Stream-like churn: every cell's value changes, so it re-renders and
			// its (component,width) pair is measured again by the layout engine.
			for (const cell of churnCells) cell.setValue(`${cell.value}.`)
		},
	}
}

/** Minimal mutable text component for the churn workload (no fork internals). */
class ChurnText implements Component {
	value: string
	private readonly wrapText: (text: string, width: number) => string[]
	private cachedWidth = -1
	private cachedValue = ''
	private cachedLines: string[] = []
	constructor(value: string, wrapText: (text: string, width: number) => string[]) {
		this.value = value
		this.wrapText = wrapText
	}
	setValue(next: string): void {
		this.value = next
	}
	render(width: number): string[] {
		if (this.cachedWidth === width && this.cachedValue === this.value) return this.cachedLines
		this.cachedLines = this.wrapText(this.value, Math.max(1, width))
		this.cachedWidth = width
		this.cachedValue = this.value
		return this.cachedLines
	}
	invalidate(): void {
		this.cachedWidth = -1
	}
}

function layoutWorkload(id: string, description: string, shape: string): Workload {
	return {
		id,
		family: 'X014',
		description,
		run(entry, args) {
			const terminal = new NullTerminal(ranged(args.cols, 20, MAX_COLS, 'cols'), ranged(args.rows, 5, MAX_ROWS, 'rows'))
			const tui = new entry.TuiAltScreen(terminal, false, '/tmp/div-cache-ab')
			const parts = buildLayout(entry, shape, args)
			tui.setLayoutRoot(parts.root)
			// The fork's own render-churn bench starts the screen before any
			// renderNow(); rendering a screen that was never started throws.
			tui.start()
			// Discarded warmup frames (JIT + first-paint costs).
			for (let i = 0; i < 5; i += 1) {
				parts.frame(i)
				tui.renderNow()
			}
			const frames = bounded(args.frames, 120, MAX_FRAMES, 'frames')
			const start = performance.now()
			for (let i = 0; i < frames; i += 1) {
				parts.frame(i)
				tui.renderNow()
			}
			const ms = performance.now() - start
			tui.stop()
			// Equivalence sink: every byte the ALT SCREEN wrote for these frames.
			// `root.render()` would NOT prove layout equivalence: X014 lives inside
			// renderLayoutFrame()'s measureWidth, so a different measured width can
			// change HStack allocation, clipping and the painted rows while the
			// root's own render() stays identical.
			return { ms, hash: terminal.writeHash, ops: frames, ...probePayload() }
		},
	}
}

const X014_WORKLOADS: Workload[] = [
	layoutWorkload(
		'layout-auto-hstack',
		'12 rows × 8 auto-basis (no numeric basis) CJK HStack entries — one measureWidth per entry per frame',
		'auto-hstack',
	),
	layoutWorkload(
		'layout-aliased-hstack',
		'ALIASED HStack: two component instances reused across 5 auto entries — the cache best case (repeat factor > 1)',
		'aliased-hstack',
	),
	layoutWorkload(
		'layout-host-tree',
		'host-like fullscreen tree (VStack + ScrollView transcript + dock): no auto-basis entry, so measureWidth never runs',
		'host-tree',
	),
	layoutWorkload(
		'layout-auto-hstack-churn',
		'auto-basis HStack rows invalidated every frame (stream/editor churn)',
		'auto-hstack-churn',
	),
]

// ── X035: main-screen per-frame processed-line reuse ────────────────────────

type X035Corpus = 'ascii' | 'mixed' | 'wide'

/** Deterministic main-screen transcript: 1 in 5 rows is ANSI-styled, mixed
 * corpora add CJK rows, `wide` rows are far wider than the terminal. */
function makeMainScreenLines(count: number, corpus: X035Corpus): string[] {
	const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo']
	const lines: string[] = []
	for (let i = 0; i < count; i += 1) {
		const word = words[i % words.length]!
		const prefix = String(i).padStart(6, ' ')
		if (corpus === 'ascii') {
			// Truly ASCII visible characters only (SGR escapes are ASCII bytes);
			// no box-drawing, check marks or CJK, so this stays an insensitive
			// control for the non-ASCII width cache.
			if (i % 5 === 0) lines.push(`\x1b[36m${prefix} > ${word} says hello world, streamed token chunk follows here\x1b[0m`)
			else if (i % 5 === 1) lines.push(`${prefix} | ${word} plain text row with a longer tail to fill the line width aa`)
			else if (i % 5 === 2) lines.push(`\x1b[33m${prefix} * done ${word}\x1b[0m ${'x'.repeat(30)}`)
			else lines.push(`${prefix} ${word}`)
			continue
		}
		if (corpus === 'wide' && i % 7 === 0) {
			lines.push(`\x1b[35m${prefix} ▸ ${'wide '.repeat(60)}${word}\x1b[0m`)
			continue
		}
		if (i % 5 === 3) { // mixed/wide only (the ascii case returned above)
			lines.push(`${prefix} 中文内容混排 ${word} 测试宽度计算逻辑 ·${'·'.repeat(20)}`)
			continue
		}
		if (i % 5 === 0) lines.push(`\x1b[36m${prefix} ▸ ${word} says hello world, streamed token chunk follows here\x1b[0m`)
		else if (i % 5 === 1) lines.push(`${prefix} │ ${word} plain text row with a longer tail to fill the line width aa`)
		else if (i % 5 === 2) lines.push(`\x1b[33m${prefix} ✓ done ${word}\x1b[0m ${'x'.repeat(30)}`)
		else lines.push(`${prefix} ${word}`)
	}
	return lines
}

/** Scratch-probe counters, non-zero only in an instrumented build. */
function probePayload(): { probe?: Record<string, number> } {
	const g = globalThis as unknown as { __x035?: Record<string, number>; __x035e?: Record<string, number> }
	const probe: Record<string, number> = {}
	if (g.__x035 !== undefined) Object.assign(probe, g.__x035)
	if (g.__x035e !== undefined) {
		for (const [key, value] of Object.entries(g.__x035e)) probe[`early_${key}`] = value
	}
	const meaningful = (probe.frames ?? 0) > 0 || (probe.early_calls ?? 0) > 0
	return meaningful ? { probe } : {}
}

/** Zero the scratch-probe counters before one measured workload. */
function resetProbeCounters(): void {
	const g = globalThis as unknown as { __x035?: Record<string, number>; __x035e?: Record<string, number> }
	g.__x035 = { frames: 0, processed: 0, reused: 0, preprocessMs: 0, arrays: 0, earlyHit: 0, earlyFallback: 0 }
	g.__x035e = { calls: 0, hit: 0, fallback: 0, ms: 0 }
}

/** A kitty graphics line carrying image id `id` (r=1 rows). */
function kittyImageLine(id: number): string {
	return `\x1b_Ga=T,f=100,i=${id},r=1;QUJD\x1b\\`
}

interface X035Mode {
	readonly corpus: X035Corpus
	/** Fraction (0..1) of NON-tail lines whose value changes every frame. */
	readonly dirty: number
	readonly tail: 'spinner' | 'append-shrink'
	readonly resizeWidths?: readonly number[]
	readonly kitty?: boolean
}

function x035Workload(id: string, description: string, lines: number, mode: X035Mode): Workload {
	return {
		id,
		family: 'X035',
		description,
		run(entry, args) {
			resetProbeCounters()
			const terminal = new NullTerminal(ranged(args.cols, 20, MAX_COLS, 'cols'), ranged(args.rows, 5, MAX_ROWS, 'rows'))
			const tui = new entry.TuiMainScreen(terminal)
			const count = bounded(args.lines, lines, MAX_LINES, 'lines')
			const base = makeMainScreenLines(count, mode.corpus)
			const kittyIds = mode.kitty === true ? [7, 11, 13] : []
			const kittyPositions = [1, Math.floor(count / 2), count - 2]
			let frame = 0
			let extra = 0
			const component = {
				focused: false,
				invalidate: (): void => {},
				render: (): string[] => {
					frame += 1
					const out = base.slice()
					for (let k = 0; k < kittyIds.length; k += 1) {
						const id = kittyIds[k]!
						// One image line moves one slot per frame (insert/move/delete churn).
						out[(kittyPositions[k]! + frame) % count] = kittyImageLine(id)
					}
					const dirtyCount = Math.floor(count * mode.dirty)
					for (let d = 0; d < dirtyCount; d += 1) {
						const index = (frame * 7919 + d * 37) % count
						out[index] = `${out[index]!} ⟳${frame}`
					}
					if (mode.tail === 'append-shrink') {
						extra = (extra + 1) % 2
						if (extra === 1) out.push(`⠋ thinking ${frame}`, `  appended ${frame}`)
						else out.push(`⠋ thinking ${frame}`)
					} else {
						out.push(`⠋ thinking ${frame}`)
					}
					return out
				},
			}
			tui.addChild(component as unknown as Component)
			tui.setFocus(component as unknown as Component)
			tui.renderNow()
			for (let i = 0; i < 3; i += 1) tui.renderNow()
			const frames = bounded(args.frames, 30, MAX_FRAMES, 'frames')
			const widths = mode.resizeWidths
			const start = performance.now()
			// Spread the widths across the measured frames (a fixed period of 5
			// covered only two of three widths in a 10-frame window).
			const period = widths === undefined ? 0 : Math.max(1, Math.floor(frames / widths.length))
			for (let i = 0; i < frames; i += 1) {
				if (widths !== undefined) terminal.columns = widths[Math.floor(i / period) % widths.length]!
				tui.renderNow()
			}
			const ms = performance.now() - start
			tui.stop()
			// Equivalence: the whole byte stream the screen produced must match
			// across variants (the screen's own writes are the observable sink).
			return { ms, hash: terminal.writeHash, ops: frames, ...probePayload() }
		},
	}
}

const X035_WORKLOADS: Workload[] = [
	x035Workload('x035-steady-1k', '1k-line transcript, only the trailing spinner changes', 1000, { corpus: 'mixed', dirty: 0, tail: 'spinner' }),
	x035Workload('x035-steady-5k', '5k-line transcript, only the trailing spinner changes', 5000, { corpus: 'mixed', dirty: 0, tail: 'spinner' }),
	x035Workload('x035-steady-10k', '10k-line transcript, only the trailing spinner changes', 10000, { corpus: 'mixed', dirty: 0, tail: 'spinner' }),
	x035Workload('x035-dirty-1pct', '5k lines, 1% of non-tail lines change every frame', 5000, { corpus: 'mixed', dirty: 0.01, tail: 'spinner' }),
	x035Workload('x035-dirty-10pct', '5k lines, 10% of non-tail lines change every frame', 5000, { corpus: 'mixed', dirty: 0.1, tail: 'spinner' }),
	x035Workload('x035-dirty-100pct', '5k lines, every non-tail line changes every frame', 5000, { corpus: 'mixed', dirty: 1, tail: 'spinner' }),
	x035Workload('x035-corpus-ascii', '5k plain/styled ASCII lines, spinner-only change', 5000, { corpus: 'ascii', dirty: 0, tail: 'spinner' }),
	x035Workload('x035-corpus-wide', '5k lines with over-wide rows needing truncation, spinner-only change', 5000, { corpus: 'wide', dirty: 0, tail: 'spinner' }),
	x035Workload('x035-append-shrink', '5k lines, the transcript grows and shrinks every other frame', 5000, { corpus: 'mixed', dirty: 0, tail: 'append-shrink' }),
	x035Workload('x035-kitty-move', '5k lines with three kitty image lines moving every frame', 5000, { corpus: 'mixed', dirty: 0, tail: 'spinner', kitty: true }),
	x035Workload('x035-width-resize', '5k lines, terminal width cycles 80/120/160 every five frames', 5000, { corpus: 'mixed', dirty: 0, tail: 'spinner', resizeWidths: [80, 120, 160] }),
]

const WORKLOADS = [...X039_WORKLOADS, ...X014_WORKLOADS, ...X035_WORKLOADS]
const WORKLOAD_BY_ID = new Map(WORKLOADS.map(workload => [workload.id, workload]))

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string> {
	const out: Record<string, string> = {}
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i]!
		if (!token.startsWith('--')) continue
		const key = token.slice(2)
		const next = argv[i + 1]
		if (next === undefined || next.startsWith('--')) out[key] = '1'
		else {
			out[key] = next
			i += 1
		}
	}
	return out
}

function workerArgs(raw: Record<string, string>): Args {
	const entry = resolve(raw.entry ?? DEFAULT_ENTRY)
	return {
		entry,
		workload: raw.workload ?? '',
		trial: raw.trial === 'warm' ? 'warm' : 'cold',
		passes: Number(raw.passes ?? '1'),
		lines: Number(raw.lines ?? '0'),
		cols: Number(raw.cols ?? '120'),
		rows: Number(raw.rows ?? '40'),
		frames: Number(raw.frames ?? '120'),
		...(raw.json === undefined ? {} : { json: resolve(raw.json) }),
	}
}

// ── worker mode ─────────────────────────────────────────────────────────────

async function runWorker(args: Args): Promise<void> {
	const workload = WORKLOAD_BY_ID.get(args.workload)
	if (workload === undefined) throw new Error(`unknown workload ${args.workload} (known: ${[...WORKLOAD_BY_ID.keys()].join(', ')})`)
	const entry = await loadEntry(args.entry)
	const result = workload.run(entry, args)
	const payload = {
		workload: workload.id,
		family: workload.family,
		entry: args.entry,
		trial: args.trial,
		ms: Number(result.ms.toFixed(4)),
		hash: result.hash,
		ops: result.ops,
		node: process.version,
		...(result.probe === undefined ? {} : { probe: result.probe }),
	}
	if (args.json !== undefined) writeFileSync(args.json, `${JSON.stringify(payload, null, 1)}\n`)
	console.log(`RESULT ${JSON.stringify(payload)}`)
}

// ── orchestrator mode ───────────────────────────────────────────────────────

interface Measurement {
	round: number
	variant: string
	workload: string
	family: string
	trial: string
	ms: number
	hash: number
	ops: number
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function percentile(values: number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b)
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
	return sorted[index]!
}

async function runOrchestrator(raw: Record<string, string>): Promise<void> {
	const variants = (raw.variants ?? '').split(',').filter(Boolean).map(part => {
		const at = part.indexOf('=')
		if (at <= 0) throw new Error(`--variants entries must be LABEL=PATH, got ${part}`)
		return { label: part.slice(0, at), entry: resolve(part.slice(at + 1)) }
	})
	if (variants.length === 0) throw new Error('--variants LABEL=PATH,... is required in orchestrator mode')
	const rounds = ranged(Number(raw.rounds ?? '7'), 1, MAX_ROUNDS, 'rounds')
	// Untracked investigation artifact by convention (see docs/perf-baseline.md):
	// the durable verdicts live in the doc, the raw rounds stay out of git.
	const outDir = resolve(raw.out ?? join(REPO_ROOT, 'temp', 'perf', 'div-cache-ab'))
	mkdirSync(outDir, { recursive: true })
	const selected = (raw.workloads ?? WORKLOADS.map(w => w.id).join(',')).split(',').filter(Boolean)
	const trials: Array<'cold' | 'warm'> = (raw.trials ?? 'cold,warm').split(',').filter(Boolean) as Array<'cold' | 'warm'>
	const cols = String(ranged(Number(raw.cols ?? '120'), 20, MAX_COLS, 'cols'))
	const rows = String(ranged(Number(raw.rows ?? '40'), 5, MAX_ROWS, 'rows'))
	const lines = raw.lines ?? '0'
	const frames = raw.frames ?? '120'

	const measurements: Measurement[] = []
	for (let round = 1; round <= rounds; round += 1) {
		// Latin-square rotation: every round starts one variant later.
		const order = [...variants.slice(round % variants.length), ...variants.slice(0, round % variants.length)]
		for (const workloadId of selected) {
			const workload = WORKLOAD_BY_ID.get(workloadId)
			if (workload === undefined) throw new Error(`unknown workload ${workloadId}`)
			const roundTrials = workload.family === 'X039' ? trials : (['warm'] as Array<'cold' | 'warm'>)
			for (const trial of roundTrials) {
				for (const variant of order) {
					const jsonPath = join(outDir, `.worker-${variant.label}-${workloadId}-${trial}.json`)
					const result = spawnSync(
						process.execPath,
						[
							'--expose-gc',
							'--import',
							'tsx/esm',
							fileURLToPath(import.meta.url),
							'--entry',
							variant.entry,
							'--workload',
							workloadId,
							'--trial',
							trial,
							'--cols',
							cols,
							'--rows',
							rows,
							'--lines',
							lines,
							'--frames',
							frames,
							'--json',
							jsonPath,
						],
						// A hung worker must die quickly: the whole harness is
						// additionally expected to run under a cgroup memory cap.
						{
							cwd: REPO_ROOT,
							encoding: 'utf8',
							timeout: ranged(Number(raw['worker-timeout-ms'] ?? '120000'), MIN_WORKER_TIMEOUT_MS, MAX_WORKER_TIMEOUT_MS, 'worker-timeout-ms'),
						},
					)
					if (result.status !== 0) {
						throw new Error(`worker failed for ${variant.label}/${workloadId}/${trial}:\n${result.stdout}\n${result.stderr}`)
					}
					const payload = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
						ms: number
						hash: number
						ops: number
					}
					// The per-worker hand-off file is scratch: never leave it behind.
					rmSync(jsonPath, { force: true })
					measurements.push({
						round,
						variant: variant.label,
						workload: workloadId,
						family: workload.family,
						trial,
						ms: payload.ms,
						hash: payload.hash,
						ops: payload.ops,
					})
				}
			}
		}
		console.log(`round ${round}/${rounds} done (${measurements.length} measurements)`)
	}

	// Geometry/width equivalence across variants.
	const hashMismatches: string[] = []
	const byKey = new Map<string, Measurement[]>()
	for (const measurement of measurements) {
		const key = `${measurement.workload}|${measurement.trial}`
		const list = byKey.get(key) ?? []
		list.push(measurement)
		byKey.set(key, list)
	}
	for (const [key, list] of byKey) {
		const hashes = new Set(list.map(entry => entry.hash))
		if (hashes.size !== 1) hashMismatches.push(`${key}: ${[...hashes].join(' vs ')}`)
	}

	const rowsOut: string[] = []
	const summary: Array<Record<string, unknown>> = []
	for (const [key, list] of [...byKey].sort()) {
		const [workloadId, trial] = key.split('|') as [string, string]
		const perVariant = new Map<string, number[]>()
		for (const measurement of list) {
			const values = perVariant.get(measurement.variant) ?? []
			values.push(measurement.ms)
			perVariant.set(measurement.variant, values)
		}
		const base = perVariant.get('BASE')
		for (const variant of variants) {
			const values = perVariant.get(variant.label)
			if (values === undefined || values.length === 0) continue
			const med = median(values)
			summary.push({
				workload: workloadId,
				trial,
				variant: variant.label,
				rounds: values.length,
				medianMs: Number(med.toFixed(4)),
				p95Ms: Number(percentile(values, 95).toFixed(4)),
				minMs: Number(Math.min(...values).toFixed(4)),
				maxMs: Number(Math.max(...values).toFixed(4)),
				relativeToBase: base === undefined ? null : Number((med / median(base)).toFixed(4)),
				hash: list[0]!.hash,
			})
			rowsOut.push(
				`${workloadId.padEnd(30)} ${trial.padEnd(4)} ${variant.label.padEnd(18)} n=${String(values.length).padStart(2)} ` +
					`median=${med.toFixed(3)}ms p95=${percentile(values, 95).toFixed(3)}ms ` +
					`min=${Math.min(...values).toFixed(3)} max=${Math.max(...values).toFixed(3)}` +
					(base === undefined || variant.label === 'BASE' ? '' : ` rel=${(med / median(base)).toFixed(3)}×`),
			)
		}
		rowsOut.push('')
	}

	const meta = {
		generatedAt: new Date().toISOString(),
		node: process.version,
		platform: `${process.platform} ${process.arch}`,
		cpu: cpus()[0]?.model ?? 'unknown',
		cpuCount: cpus().length,
		totalMemBytes: totalmem(),
		loadavg: loadavg(),
		rounds,
		cols,
		rows,
		lines,
		frames,
		workloads: selected,
		trials,
		variants: variants.map(variant => ({ label: variant.label, entry: variant.entry })),
		hashMismatches,
	}
	writeFileSync(join(outDir, 'raw.json'), `${JSON.stringify({ meta, measurements, summary }, null, 1)}\n`)
	const csv = ['workload,trial,variant,rounds,median_ms,p95_ms,min_ms,max_ms,relative_to_base,hash']
	for (const row of summary) {
		csv.push(
			[
				row.workload,
				row.trial,
				row.variant,
				row.rounds,
				row.medianMs,
				row.p95Ms,
				row.minMs,
				row.maxMs,
				row.relativeToBase ?? '',
				row.hash,
			].join(','),
		)
	}
	writeFileSync(join(outDir, 'summary.csv'), `${csv.join('\n')}\n`)
	console.log(rowsOut.join('\n'))
	if (hashMismatches.length > 0) {
		console.error(`HASH MISMATCH — variants do not produce equivalent output:\n${hashMismatches.join('\n')}`)
		process.exitCode = 1
	}
	console.log(`wrote ${join(outDir, 'raw.json')} and ${join(outDir, 'summary.csv')}`)
}

const raw = parseArgs(process.argv.slice(2))
if (raw.variants !== undefined) await runOrchestrator(raw)
else await runWorker(workerArgs(raw))
