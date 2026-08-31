/**
 * Footer composition types (plan M1): the builtin item registry, the
 * versioned layout shape, and the render contracts. The composer consumes
 * ONLY the StatusSnapshot plus a small host-owned surface context (editor
 * emptiness, extension chrome text) — never business state.
 * @module @xmoon76/dsh-pi-tui/footer
 */

import type { StatusSnapshot } from '../status/types.ts'

/** The semantic tones a footer span may carry (the theme token set). */
export type FooterTone =
  | 'primary' | 'accent' | 'text' | 'textStrong' | 'textDim' | 'textMuted'
  | 'border' | 'success' | 'warning' | 'error' | 'roleUser' | 'shellMode'

/** One styled run of footer text. */
export interface FooterSpan {
  readonly text: string
  readonly tone?: FooterTone
  readonly emphasis?: 'normal' | 'strong' | 'dim' | 'italic'
}

/** One rendered footer item: styled spans with layout hints. */
export interface FooterSegment {
  readonly spans: readonly FooterSpan[]
  readonly minWidth?: number
  readonly importance?: number
}

/** The density an item renders at (plan §9.2: preferred vs compact). */
export type FooterDensity = 'preferred' | 'compact'

/** One item reference in a layout (plan §8). */
export interface FooterItemRef {
  readonly id: string
  /** The item's finite formatter; absent = the definition default. */
  readonly format?: string
  /** Semantic tone override; 'auto' (default) uses the item's own tone. */
  readonly tone?: FooterTone | 'auto'
  readonly prefix?: string
  readonly suffix?: string
  /** User importance override; absent = the definition default. */
  readonly importance?: number
}

/** The separator between surviving items of one zone. */
export interface FooterSeparator {
  readonly text: string
  readonly tone?: FooterTone
}

/** One footer row: left zone, right zone, optional separator. */
export interface FooterRowLayout {
  readonly left: readonly FooterItemRef[]
  readonly right: readonly FooterItemRef[]
  readonly separator?: FooterSeparator
}

/** The versioned persisted layout (plan §8). V1 limits: 1..2 rows, no
 * template DSL, no conditions, no shell, no JS callbacks. */
export interface FooterLayoutV1 {
  readonly schemaVersion: 1
  readonly rows: readonly FooterRowLayout[]
}

/** The host-owned surface context the composer receives (NOT business
 * state — the plan's §2.2 prohibition targets permission/plan/focus/stats/
 * git/model derivation). */
export interface FooterRenderContext {
  /** Whether ↓ would open the task browser RIGHT NOW — the exact routing
   * gate: active tasks, no overlay entries, an EMPTY VISIBLE seat editor
   * in prompt mode (a shell-mode body is composing a command, and a
   * plugin replacement editor decides by its own text/mode — the host
   * editor's draft is not the gate). Drives the task badge's `↓ view`
   * hint. */
  readonly taskBrowserAvailable: boolean
  /** The extension footer segments' baked text (the ext:* synthetic item). */
  readonly extensionFooterText: string
}

/** A builtin footer item definition (plan §7). Render callbacks are pure,
 * synchronous, I/O-free and read only the snapshot + context. */
export interface FooterItemDefinition {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly defaultZone: 'left' | 'right'
  readonly defaultImportance: number
  readonly minWidth?: number
  /** The finite formatter ids this item supports. */
  readonly formats: readonly string[]
  readonly defaultFormat: string
  render(
    snapshot: StatusSnapshot,
    ref: FooterItemRef,
    density: FooterDensity,
    context: FooterRenderContext,
  ): FooterSegment | null
}

/** The footer's physical-line budget (plan 2026-08-31 §6.1): the host
 * surface owns how many TERMINAL physical lines the footer may occupy;
 * the persisted 1..2 LAYOUT-ROW schema (FooterLayoutV1) is independent of
 * it — a future Add-Row surface raises `total`, never the row renderer.
 * Both values normalize defensively: non-finite values fall back to the
 * composer defaults, finite junk floors at 1, absurd values clamp to the
 * hard capability (perRow ≤ 2, total ≤ 4). A surface granting ZERO lines
 * (its pinned chrome alone fills the viewport) renders nothing at all —
 * not even the Host instruction. */
export interface FooterPhysicalLineBudget {
  /** The max physical lines ONE logical row may occupy (1..2). */
  readonly perRow: number
  /** The max physical lines the whole footer surface may occupy
   * (0..4; 0 = render nothing). */
  readonly total: number
}

/** The max physical lines one logical row wraps into at narrow widths
 * (plan 2026-08-31 §6.1/§6.2): past the cap the row resolves overflow
 * through the semantic compact → importance-drop → ANSI-safe truncate
 * discipline — never by slicing the wrapped lines. Composer HARD
 * capability: callers may never raise this past 2. */
export const FOOTER_MAX_PHYSICAL_LINES_PER_ROW = 2

/** The Composer's HARD capacity ceiling for the footer status surface
 * (plan 2026-08-31 §6.1, revised 2026-08-31 PR #57 review): with the
 * default two-logical-row layout the CAPACITY is status ≤ 2 + stats ≤ 2.
 * This is a ceiling, NOT the everyday render height — the actual render
 * budget is decided by the SURFACE (TuiApp passes
 * `physicalLineBudget.total = min(4, currently-available footer rows)`,
 * so short viewports render fewer lines and the Host instruction is
 * never viewport-clipped). */
export const FOOTER_MAX_PHYSICAL_LINES = 4

/** The legacy physical-line cap name — physical lines, never logical
 * rows. Kept as an alias for external ABI; prefer the explicit names. */
export const FOOTER_MAX_LINES = FOOTER_MAX_PHYSICAL_LINES
