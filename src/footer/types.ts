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

/** The hard cap on footer physical rows (plan §9.5). */
export const FOOTER_MAX_LINES = 4
