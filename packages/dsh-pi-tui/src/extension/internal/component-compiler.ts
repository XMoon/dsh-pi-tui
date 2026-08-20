/**
 * The ComponentCompiler (M4, plan §9): compiles the public structured view
 * tree (`ExtensionView`) into private pi-tui components. Plugins describe
 * WHAT to render with semantic tokens; this module is the ONLY bridge to
 * the vendored fork's component classes, so the leak gate stays simple:
 * public declarations never name a pi-tui type, and no plugin ever imports
 * the fork.
 *
 * Contract (plan §9 / §19):
 * - synchronous, no I/O, no Promise;
 * - every view renders at the CURRENT cell width (never a captured width —
 *   the compiled component stays live across resizes and re-wraps);
 * - CJK/emoji/combining chars measure through the fork's ANSI-safe helpers;
 * - no raw ANSI/terminal escapes ever reach a plugin path;
 * - an empty view renders nothing (abdication);
 * - the compiled tree is reference-stable: an unchanged contribution keeps
 *   the same component instance, so the fork's per-frame processed-line
 *   reuse keeps hitting (AGENTS.md "never flatten a message at build time").
 * @module @xmoon76/dsh-pi-tui/extension/component-compiler
 */

import { Container, HStack, Markdown, Spacer, VStack, type Component } from '@xmoon76/pi-tui'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import { color, markdownTheme } from '../../theme.ts'
import type { ExtensionView, StyledSpan, TextView } from '../public-types.ts'
import { renderSpans, sanitizeSpanText } from './slot-outlet.ts'

/** A compiled view tree node. */
interface CompiledNode {
  readonly component: Component
  /** Whether this node renders any content at all (false = abdicate). */
  readonly isEmpty: boolean
}

/**
 * Compile one public view into a private component tree. The result is
 * frozen for the contribution's lifetime: a plugin that wants different
 * content REPLACES the contribution (handle.replace) — the host never
 * mutates a compiled tree in place, so caching and reference stability are
 * exact.
 * @param view - the public view tree (may be undefined = abdicate).
 * @returns the compiled node (isEmpty true renders nothing).
 */
export function compileView(view: ExtensionView | undefined): CompiledNode {
  if (view === undefined) return { component: new Container(), isEmpty: true }
  switch (view.kind) {
    case 'text': return compileText(view)
    case 'markdown': return compileMarkdown(view)
    case 'spacer': return compileSpacer(view)
    case 'stack': return compileStack(view)
    case 'frame': return compileFrame(view)
    case 'rows': return compileRows(view)
    default: return { component: new Container(), isEmpty: true }
  }
}

/**
 * One styled text line. Rendering is deferred to render() so a resize
 * re-wraps; the cache is keyed by (content, width) exactly like the fork's
 * Text, so unchanged content stays O(1) per frame.
 */
class CompiledText implements Component {
  private readonly spans: readonly StyledSpan[]
  private readonly wrap: boolean
  /** The raw styled string (ANSI-applied); visible width is the emptiness
   * gate (private, read through {@link raw} by the compiler). */
  private readonly rawJoined: string
  private cachedWidth = -1
  private cached: string[] | undefined

  constructor(view: TextView) {
    this.spans = view.spans
    this.wrap = view.wrap ?? true
    this.rawJoined = renderSpans(view.spans)
  }

  /** The ANSI-styled content (compiler reads it for the emptiness gate). */
  raw(): string {
    return this.rawJoined
  }

  invalidate(): void {
    this.cached = undefined
  }

  render(width: number): string[] {
    width = Math.max(1, width)
    if (this.cachedWidth === width && this.cached !== undefined) return this.cached
    this.cachedWidth = width
    const lines: string[] = []
    if (this.rawJoined === '' || visibleWidth(this.rawJoined) === 0) {
      this.cached = lines
      return lines
    }
    const wrapped = this.wrap
      ? wrapTextWithAnsi(this.rawJoined, width)
      : this.rawJoined.split('\n')
    for (const line of wrapped) {
      lines.push(line.replace(/\n$/, ''))
    }
    this.cached = lines
    return lines
  }
}

function compileText(view: TextView): CompiledNode {
  const text = new CompiledText(view)
  // Visually-empty check (M2 parity): whitespace-only spans render to a
  // non-empty raw string that is still ZERO visible cells — a valid
  // no-display abdication (the same rule the dock outlet uses).
  return { component: text, isEmpty: visibleWidth(text.raw()) === 0 }
}

/** One markdown block: the fork's Markdown caches per (text, width), so
 * unchanged content is O(1) per frame and a resize re-wraps (a live child,
 * never frozen lines). The plugin-supplied markdown string is SANITIZED at
 * compile time (plan §19 item 10: no terminal control sequence may reach
 * the terminal from plugin content — the markdown path bypasses
 * renderSpans, so it needs its own choke point). */
class CompiledMarkdown implements Component {
  /** The SANITIZED markdown (the compiled identity — a replacement
   * contribution compiles a new instance). */
  private readonly markdown: string
  private cachedWidth = -1
  private cached: string[] | undefined

  constructor(markdown: string) {
    this.markdown = sanitizeSpanText(markdown)
  }

  invalidate(): void {
    this.cached = undefined
  }

  render(width: number): string[] {
    width = Math.max(1, width)
    if (this.cachedWidth === width && this.cached !== undefined) return this.cached
    this.cachedWidth = width
    // Zero padding: the host pads widget rows; the fork's default 1-cell
    // padding would double it.
    this.cached = new Markdown(this.markdown, 0, 0, markdownTheme).render(width)
    return this.cached
  }
}

function compileMarkdown(view: { markdown: string }): CompiledNode {
  const sanitized = sanitizeSpanText(view.markdown)
  const empty = sanitized.trim() === ''
  return {
    component: empty ? new Container() : new CompiledMarkdown(sanitized),
    isEmpty: empty,
  }
}

function compileSpacer(view: { rows: number }): CompiledNode {
  const rows = Math.max(0, Math.floor(view.rows))
  return { component: new Spacer(rows), isEmpty: rows === 0 }
}

/**
 * A compiled stack. Vertical stacks use the fork's VStack with the public
 * layout hints; horizontal stacks use the fork's HStack (width-aware,
 * ANSI-safe side-by-side placement honoring the gap — never sequential
 * rows, the P1-01 layout-contract fix). Empty children render nothing; an
 * all-empty stack abdicates.
 */
function compileStack(view: {
  direction: 'vertical' | 'horizontal'
  children: readonly ExtensionView[]
  gap?: number
  basis?: number
  grow?: number
  shrink?: number
}): CompiledNode {
  const children = view.children.map(child => compileView(child))
  const visible = children.filter(child => !child.isEmpty)
  if (visible.length === 0) return { component: new Container(), isEmpty: true }
  if (view.direction === 'horizontal') {
    const stack = new HStack(visible.map(child => child.component), {
      gap: Math.max(0, Math.floor(view.gap ?? 0)),
    })
    return { component: stack, isEmpty: false }
  }
  const stack = new VStack(
    visible.map(child => child.component),
    {
      gap: Math.max(0, Math.floor(view.gap ?? 0)),
      ...(view.basis === undefined ? {} : { basis: Math.max(0, Math.floor(view.basis)) }),
      ...(view.grow === undefined ? {} : { grow: Math.max(0, Math.floor(view.grow)) }),
      ...(view.shrink === undefined ? {} : { shrink: Math.max(0, Math.floor(view.shrink)) }),
    },
  )
  return { component: stack, isEmpty: false }
}

/**
 * A bordered frame around one child. The border uses the host's border
 * token RE-READ at render time (a theme switch re-bakes); the frame is a
 * full-width rule like the host's todo panel (` ─── ` with 1-cell side
 * margins), so the border always aligns at any width.
 */
class CompiledFrame implements Component {
  private readonly child: Component
  private readonly width: number | undefined
  private cachedWidth = -1
  private cached: string[] | undefined

  constructor(child: Component, width: number | undefined) {
    this.child = child
    this.width = width
  }

  invalidate(): void {
    this.cached = undefined
  }

  render(outerWidth: number): string[] {
    outerWidth = Math.max(1, outerWidth)
    // P1-02: the frame's effective width is CLAMPED to the host budget —
    // a requested width beyond the terminal can never push the frame past
    // the surface (the public contract: `width` is a content budget, and
    // the host owns the outer budget).
    const effective = Math.min(Math.max(1, Math.floor(this.width ?? outerWidth)), outerWidth)
    const contentWidth = Math.max(1, effective - 2)
    if (this.cachedWidth === contentWidth && this.cached !== undefined) return this.cached
    this.cachedWidth = contentWidth
    const rule = ` ${'─'.repeat(contentWidth)} `
    const border = color.border(rule)
    const lines = [border]
    for (const line of this.child.render(contentWidth)) {
      // ANSI-safe padding/truncation (P1-02): padEnd on an ANSI-bearing
      // line misaligns the border; truncateToWidth pads by DISPLAY CELLS
      // (CJK/emoji exact) and truncates over-wide content to the budget.
      lines.push(` ${truncateToWidth(line, contentWidth, '', true)} `)
    }
    lines.push(border)
    this.cached = lines
    return lines
  }
}

function compileFrame(view: { child?: ExtensionView; width?: number }): CompiledNode {
  const child = view.child === undefined ? undefined : compileView(view.child)
  if (child === undefined || child.isEmpty) return { component: new Container(), isEmpty: true }
  const width = view.width === undefined ? undefined : Math.max(1, Math.floor(view.width))
  return { component: new CompiledFrame(child.component, width), isEmpty: false }
}

/** A fixed set of rows; each row renders at the current width; excess rows
 * are dropped after the budget. */
function compileRows(view: { rows: readonly ExtensionView[]; maxRows?: number }): CompiledNode {
  const rows = view.rows.map(row => compileView(row))
  const visible = rows.filter(row => !row.isEmpty)
  const budget = view.maxRows === undefined ? visible.length : Math.max(0, Math.floor(view.maxRows))
  const kept = visible.slice(0, budget)
  const container = new Container()
  for (const row of kept) container.addChild(row.component)
  return { component: container, isEmpty: kept.length === 0 }
}
