/**
 * The footer composer (plan 2026-08-31 §6): renders a FooterLayoutV1 against
 * the StatusSnapshot into the final footer text. Row rules:
 *
 * - layout rows are POSITION-AGNOSTIC logical rows: every non-empty row
 *   goes through the SAME fitting contract of 1..FOOTER_MAX_PHYSICAL_LINES_PER_ROW
 *   physical lines inside the CALLER's global budget (the composer's hard
 *   capacity — FOOTER_MAX_PHYSICAL_LINES ≤ 4 — is a ceiling; the surface
 *   decides how many lines it actually grants, so short viewports render
 *   fewer and the Host instruction is never viewport-clipped). Past a
 *   row's cap the overflow resolves SEMANTICALLY (compact → drop by
 *   importance → ANSI-safe truncate) — never by slicing the wrapped
 *   lines and never by index-role inference (no "first row = status /
 *   last row = stats");
 * - a left-only row joins in layout order and wraps into 1..2 physical
 *   lines; a row with a right zone keeps its single-line fitZone contract
 *   (the right zone reserves first, the left fits the remainder);
 * - the Host instruction (plan §19) is an INDEPENDENT surface: it reserves
 *   its own physical line from the global budget and never replaces a
 *   user row. Allocation is sequential (plan §8): every renderable row
 *   earns a baseline line first, the leftover buys second lines for rows
 *   that demand them, in layout order — a layout wider than the budget
 *   drops its tail rows as a global-budget decision;
 * - every physical row is dimmed (the legacy footer's final pass).
 *
 * The composer consumes ONLY the StatusSnapshot + the host-owned surface
 * context (task-browser availability — the exact ↓ routing gate — and the
 * extension chrome text) — never business state (plan §2.2).
 * @module @xmoon76/dsh-pi-tui/footer/composer
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import { color } from '../theme.ts'
import type { StatusSnapshot } from '../status/types.ts'
import type { FooterItemRegistry } from './item-registry.ts'
import type {
  FooterDensity,
  FooterItemRef,
  FooterLayoutV1,
  FooterPhysicalLineBudget,
  FooterRenderContext,
  FooterRowLayout,
  FooterSegment,
  FooterSpan,
  FooterTone,
} from './types.ts'
import { FOOTER_MAX_PHYSICAL_LINES, FOOTER_MAX_PHYSICAL_LINES_PER_ROW } from './types.ts'

/** The Host instruction surface's render contract (plan §19). */
export interface FooterInstructionLike {
  readonly id: string
  readonly text: readonly FooterSpan[]
  readonly priority: number
}

/** The composer's render options. */
export interface FooterComposerOptions {
  readonly snapshot: StatusSnapshot
  readonly layout: FooterLayoutV1
  readonly width: number
  readonly context: FooterRenderContext
  /** The active Host instruction; an independent reserved line (plan §7),
   * never the replacement of a user row. */
  readonly instruction?: FooterInstructionLike
  /** The host-owned physical-line budget; defaults to the built-in
   * surface policy (plan §6.1). */
  readonly physicalLineBudget?: FooterPhysicalLineBudget
}

/** The DEFAULT surface policy (plan §6.1, PR #57 revision): two physical
 * lines per logical row, hard capacity four for the whole footer. The
 * production path (TuiApp) always passes the EFFECTIVE surface budget —
 * min(capacity, current available rows) — so this default only backs
 * direct composer callers. */
const DEFAULT_PHYSICAL_LINE_BUDGET: FooterPhysicalLineBudget = {
  perRow: FOOTER_MAX_PHYSICAL_LINES_PER_ROW,
  total: FOOTER_MAX_PHYSICAL_LINES,
}

/** Normalize one positive-integer budget input (the PR #57 review's
 * budget-normalization requirement):
 * NaN/±Infinity/out-of-range inputs fall back instead of propagating —
 * `wrapped.length <= NaN` is always false, which would hang
 * wrapFitRow's shrink loop forever. */
function normalizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.max(1, Math.floor(value))
}

/** One logical row, resolved ONCE per render: the rendered zones, the
 * preferred form and its physical-line demand (plan §6.2). */
interface ResolvedRow {
  readonly left: ZoneItem[]
  readonly right: ZoneItem[]
  readonly separator: string
  /** A right-zone row's already-fitted single physical line (its fitting
   * contract never wraps); absent for a left-only row. */
  readonly rightLine: string | undefined
  /** How many physical lines the preferred form needs (a right-zone row
   * demands exactly 1). */
  readonly demand: number
  readonly isEmpty: boolean
}

/** One resolved zone item (rendered at the preferred density). */
interface ZoneItem {
  readonly ref: FooterItemRef
  readonly def: { render(snapshot: StatusSnapshot, ref: FooterItemRef, density: FooterDensity, context: FooterRenderContext): FooterSegment | null }
  text: string
  readonly importance: number
  readonly minWidth: number | undefined
  readonly index: number
  /** Re-render at a density (the compact phase re-renders in place). */
  renderAt(density: FooterDensity): string
}

/** The footer composer. */
export class FooterComposer {
  private readonly registry: FooterItemRegistry

  constructor(registry: FooterItemRegistry) {
    this.registry = registry
  }

  /** Render the layout + instruction into the final footer text. */
  render(options: FooterComposerOptions): string {
    const { snapshot, layout, context, instruction } = options
    // The width normalizes ONCE to a finite integer ≥ 1: the app caller
    // clamps the terminal width already, but the composer is exported —
    // a direct caller handing 0/-1/NaN/Infinity gets the width-1 surface,
    // never an ill-fitted one.
    const width = Number.isFinite(options.width) ? Math.max(1, Math.floor(options.width)) : 1
    // The budget normalizes with the same defense AND is pinned to the
    // composer's hard capability ceiling — even a caller override
    // (physicalLineBudget) can never exceed perRow ≤ 2 / total ≤ 4
    // (plan 2026-08-31 §6.1): the surface decides how many of the 4
    // available lines it grants, not how many exist.
    const budget = options.physicalLineBudget ?? DEFAULT_PHYSICAL_LINE_BUDGET
    // A surface may grant ZERO lines (its pinned chrome alone already
    // fills the viewport): the composer then renders NOTHING at all —
    // not even the Host instruction. Once the chrome alone overflows, no
    // footer line can avoid the clip, and painting one would exceed the
    // granted budget; the composer must agree with its Text component
    // (zero rows). The surface owns this decision (TuiApp computes
    // total = min(capacity, available rows), which floors at 0) — and it
    // is signaled by EXACTLY 0. Negative totals are INVALID caller input
    // (arithmetic underflow, a buggy caller): they must not silently
    // hide the Host instruction, so they flow through the regular
    // normalization like every other finite junk value (floor 1).
    if (budget.total === 0) return ''
    const total = Math.min(FOOTER_MAX_PHYSICAL_LINES,
      normalizePositiveInt(budget.total, FOOTER_MAX_PHYSICAL_LINES))
    const perRow = Math.min(total, FOOTER_MAX_PHYSICAL_LINES_PER_ROW,
      normalizePositiveInt(budget.perRow, FOOTER_MAX_PHYSICAL_LINES_PER_ROW))
    // The instruction's rendered text resolves ONCE: an instruction that
    // renders nothing VISIBLE (empty spans, whitespace/blank SGR-only
    // text) is indistinguishable from an ABSENT one — it reserves no
    // budget line and paints none (the Text component renders such
    // content as zero rows; the composer must agree with its component).
    const instructionText = instruction === undefined ? undefined : renderInstruction(instruction)
    const hasInstruction = instructionText !== undefined
      && stripSgr(instructionText).trim() !== ''
    // 1. Resolve every LOGICAL row once (rendered zones + preferred form
    // + demand). An EMPTY row (every item unavailable) never enters the
    // budget at all.
    const resolved = layout.rows.map(row => this.resolveRow(row, snapshot, context, width))
    const renderable = resolved.filter(row => !row.isEmpty)
    // 2. The Host instruction reserves ONE physical line up front (plan
    // §7): it is an independent surface — never the replacement of a user
    // row — and always survives.
    const rowsBudget = Math.max(0, hasInstruction ? total - 1 : total)
    // 3. Sequential allocation (plan §8): every renderable row earns its
    // BASELINE physical line first (while the budget lasts); the leftover
    // then buys a second line for rows that demand one, in layout order,
    // capped at perRow. A layout wider than the budget drops its tail
    // rows — a global-budget decision, never an instruction row-swap — so
    // any future N-row layout flows through the same rule.
    const allowances: number[] = []
    let remaining = rowsBudget
    for (let index = 0; index < renderable.length; index += 1) {
      const baseline = Math.min(1, remaining)
      allowances.push(baseline)
      remaining -= baseline
    }
    for (let index = 0; index < renderable.length && remaining > 0; index += 1) {
      const demand = renderable[index]!.demand
      if (demand <= 1) continue
      const extra = Math.min(demand - 1, perRow - 1, remaining)
      allowances[index]! += extra
      remaining -= extra
    }
    // 4. Render every row within its allowance, in layout order.
    const physical: string[] = []
    let renderIndex = 0
    for (const row of resolved) {
      if (row.isEmpty) continue
      const allowance = allowances[renderIndex]!
      renderIndex += 1
      for (const physicalLine of this.fitLogicalRow(row, width, allowance)) {
        if (physicalLine !== '') physical.push(physicalLine)
      }
    }
    // 5. The instruction: its own line, capped to one physical row. An
    // instruction with no VISIBLE content paints nothing (and reserved
    // nothing).
    if (hasInstruction) physical.push(renderInstructionLine(instructionText!, width))
    // The legacy footer's final pass: every physical row is dimmed.
    return physical.map(row => color.textDim(row)).join('\n')
  }

  /** Resolve one LOGICAL row (plan §6.2/§6.3): render its zones exactly
   * once, classify it (empty / right-zone single-line / left-only wrap
   * candidate) and measure its preferred physical-line demand. */
  private resolveRow(
    row: FooterRowLayout,
    snapshot: StatusSnapshot,
    context: FooterRenderContext,
    width: number,
  ): ResolvedRow {
    const left = this.renderZone(row.left, snapshot, context)
    const right = this.renderZone(row.right, snapshot, context)
    // The separator's semantic tone applies to its text (the plan §8
    // separator tone — the outer dim pass still colors untoned parts).
    const separator = row.separator === undefined
      ? '  '
      : styleTone(row.separator.text, row.separator.tone)
    if (left.length === 0 && right.length === 0) {
      return { left, right, separator, rightLine: undefined, demand: 0, isEmpty: true }
    }
    // NO right zone: the left zone joins in LAYOUT ORDER — never fitted
    // to the width up front (the legacy contract: an over-wide row WRAPS
    // within its physical-line budget; an early fitZone would truncate it
    // to one line).
    if (right.length === 0) {
      const leftOnly = left.map(item => item.text).join(separator)
      return {
        left,
        right,
        separator,
        rightLine: undefined,
        demand: wrapTextWithAnsi(leftOnly, width).length,
        isEmpty: false,
      }
    }
    // With a right zone: the row keeps its single-line fitZone contract
    // (plan §6.4) — its demand is always exactly 1.
    return {
      left,
      right,
      separator,
      rightLine: this.renderRightRow(left, right, separator, width),
      demand: 1,
      isEmpty: false,
    }
  }

  /** Fit one logical row into a physical-line allowance (plan §6.2): 0 →
   * the row drops (the global budget is exhausted); a right-zone row stays
   * its single fitted line; a left-only row wraps into 1..maxPhysicalLines
   * through the compact → drop → truncate discipline. */
  private fitLogicalRow(row: ResolvedRow, width: number, maxPhysicalLines: number): string[] {
    if (row.isEmpty || maxPhysicalLines < 1) return []
    if (row.rightLine !== undefined) return [row.rightLine]
    return this.wrapFitRow(row.left, row.separator, width, maxPhysicalLines)
  }

  /** A left-only row wraps into 1..maxPhysicalLines physical lines (plan
   * §6.2): the preferred form first; when it wraps past the cap the zone
   * goes through fitZone's compact → drop → truncate discipline against a
   * MULTI-LINE CELL budget — never a slice of the wrapped lines (a slice
   * would discard content by string position instead of semantic
   * importance). Word-boundary wrap waste may need the cell budget to
   * shrink a few times; the EXPLICIT floor below (cells 1) turns any
   * residual overflow into a single ANSI-safe '…' row, so termination
   * never depends on fitZone/wrap internals staying well-behaved. */
  private wrapFitRow(items: ZoneItem[], separator: string, width: number, maxPhysicalLines: number): string[] {
    const preferred = wrapTextWithAnsi(items.map(item => item.text).join(separator), width)
    if (preferred.length <= maxPhysicalLines) return preferred
    let cells = width * maxPhysicalLines
    for (;;) {
      const wrapped = wrapTextWithAnsi(this.fitZone(items, separator, cells), width)
      if (wrapped.length <= maxPhysicalLines) return wrapped
      if (cells <= 1) {
        // Finite lower bound: one cell can only ever wrap to one line, so
        // this branch is the loop's guaranteed exit — belt and braces for
        // the termination argument even if future wrap/fit behavior drifts.
        return [capRowWithEllipsis(wrapped[0] ?? '', width)]
      }
      cells = Math.max(1, cells - Math.max(1, wrapped.length - maxPhysicalLines))
    }
  }

  /** The right-zone row's single-line contract (plan §6.4 — unchanged):
   * the right zone reserves its IDEAL width first; the left zone fits the
   * remaining width; the right zone re-fits the leftover room and drops
   * entirely when even one cell is left (never a negative gap, never
   * across the terminal width). An unavailable left zone must not drag
   * right items to the left edge — a right zone stays flush right. */
  private renderRightRow(left: ZoneItem[], right: ZoneItem[], separator: string, width: number): string {
    if (left.length === 0) {
      const fitted = this.fitZone(right, separator, width)
      const gap = ' '.repeat(Math.max(0, width - visibleWidth(fitted)))
      return `${gap}${fitted}`
    }
    const rightFull = right.map(item => item.text).join(separator)
    const rightWidth = visibleWidth(rightFull)
    const minGap = 1
    const leftBudget = Math.max(1, width - rightWidth - minGap)
    const leftText = this.fitZone(left, separator, leftBudget)
    const leftWidth = visibleWidth(leftText)
    const rightRoom = Math.max(0, width - leftWidth - minGap)
    if (rightRoom < 1) return leftText
    // The right zone fits through the SAME item-level compact → drop →
    // truncate discipline as the left (the review finding: a whole-string
    // truncate cut the RIGHTMOST item even when a LOWER-importance item
    // was the better victim — e.g. `version(10) focus(120)` on a narrow
    // screen must drop version, never the pinned focus).
    const finalRight = this.fitZone(right, separator, rightRoom)
    const gap = ' '.repeat(Math.max(0, width - leftWidth - visibleWidth(finalRight)))
    return `${leftText}${gap}${finalRight}`
  }

  /** Resolve one zone's item refs into rendered items (unknown ids and
   * throwing items are skipped — error isolation). The ref's layout
   * overrides apply: a semantic tone replaces the item's own tones, and
   * prefix/suffix wrap the rendered text (plain — the outer dim pass
   * colors them). */
  private renderZone(
    refs: readonly FooterItemRef[],
    snapshot: StatusSnapshot,
    context: FooterRenderContext,
  ): ZoneItem[] {
    const items: ZoneItem[] = []
    for (const ref of refs) {
      const def = this.registry.get(ref.id)
      if (def === undefined) continue
      const renderAt = (density: FooterDensity): string => {
        let segment: FooterSegment | null
        try {
          segment = def.render(snapshot, ref, density, context)
        } catch {
          segment = null
        }
        if (segment === null) return ''
        const override = ref.tone === undefined || ref.tone === 'auto' ? undefined : ref.tone
        const rendered = renderSpans(segment.spans, override)
        return `${ref.prefix ?? ''}${rendered}${ref.suffix ?? ''}`
      }
      let segment: FooterSegment | null = null
      try {
        segment = def.render(snapshot, ref, 'preferred', context)
      } catch {
        segment = null
      }
      if (segment === null) continue
      const text = renderAt('preferred')
      if (text === '') continue
      items.push({
        ref,
        def,
        text,
        importance: ref.importance ?? def.defaultImportance,
        minWidth: segment.minWidth ?? def.minWidth,
        index: items.length,
        renderAt,
      })
    }
    return items
  }

  /** Fit a zone into a width budget: compact → drop → truncate (plan
   * §9.2–§9.4). Deterministic: importance ASC, then reverse layout order
   * as the tie-break. */
  private fitZone(items: ZoneItem[], separator: string, budget: number): string {
    const totalOf = (list: readonly ZoneItem[]): number =>
      list.reduce((sum, item, index) => sum + visibleWidth(item.text) + (index === 0 ? 0 : visibleWidth(separator)), 0)
    if (totalOf(items) <= budget) return items.map(item => item.text).join(separator)
    let kept = items
    // 1. compact: re-render the LOWEST-importance items at the compact
    // density first (an item whose compact form is shorter helps the
    // budget; a compact form that is not shorter is discarded).
    const byImportance = [...kept].sort((a, b) =>
      a.importance - b.importance || b.index - a.index)
    for (const victim of byImportance) {
      if (totalOf(kept) <= budget) break
      const compact = victim.renderAt('compact')
      if (compact !== '' && compact !== victim.text && visibleWidth(compact) < visibleWidth(victim.text)) {
        victim.text = compact
      }
    }
    if (totalOf(kept) <= budget) return kept.map(item => item.text).join(separator)
    // 2. drop: remove the lowest-importance items (order preserved)...
    for (const victim of byImportance) {
      if (kept.length === 1) break
      const without = kept.filter(item => item !== victim)
      if (totalOf(without) <= budget) {
        kept = without
        break
      }
      if (totalOf(without) < totalOf(kept)) kept = without
    }
    // 3. drop the tail (order preserved)...
    while (totalOf(kept) > budget && kept.length > 1) kept = kept.slice(0, -1)
    // 4. ...then truncate the last kept item ANSI-safely; an item with a
    // declared minWidth is never truncated below it — it is dropped
    // instead (the FooterSegmentOutlet contract).
    if (totalOf(kept) > budget && kept.length > 0) {
      const last = kept[kept.length - 1]!
      const prefix = kept.slice(0, -1)
      const prefixWidth = totalOf(prefix)
      const room = Math.max(1, budget - prefixWidth - (prefix.length === 0 ? 0 : visibleWidth(separator)))
      if (last.minWidth !== undefined && room < last.minWidth) {
        kept = kept.slice(0, -1)
      } else {
        last.text = truncateToWidth(last.text, room, '…')
      }
    }
    return kept.map(item => item.text).join(separator)
  }
}

/** Render the instruction's spans into one line. */
function renderInstruction(instruction: FooterInstructionLike): string {
  return renderSpans(instruction.text)
}

/** Render the Host instruction as its own INDEPENDENT physical line (plan
 * 2026-08-31 §7): reserved from the global budget up front, wrapped to the
 * width and capped to one physical row (its own line contract). The
 * caller passes the ALREADY-RENDERED instruction text (empty text never
 * reaches this point). */
function renderInstructionLine(rendered: string, width: number): string {
  const wrapped = wrapTextWithAnsi(rendered, width)
  return wrapped.length > 1 ? capRowWithEllipsis(wrapped[0]!, width) : wrapped[0]!
}

/** M5: merge the Host instruction onto a COMMAND surface (the command owns
 * the Status Surface; the instruction is never user-hideable).
 *
 * Without a budget the LEGACY command contract applies: the instruction
 * replaces the second command row when present, appends otherwise.
 *
 * WITH a surface budget (PR #57 review) the command surface consumes the
 * same effective total as the native composer: the instruction reserves
 * ONE physical line first, the trusted command rows keep the FIRST
 * remaining slots in order (they carry no importance metadata — layout
 * order is the priority), and a zero-grant surface renders nothing at
 * all — the hint is never the row that gets viewport-clipped. */
export function mergeCommandSurface(
  rows: readonly string[],
  instruction: FooterInstructionLike | undefined,
  width: number,
  budget?: Pick<FooterPhysicalLineBudget, 'total'>,
): string {
  // NO budget = the legacy command contract, byte-identical: the
  // caller's width passes through EXACTLY as before (no normalization —
  // the legacy path predates the budget work and its edge-width
  // behavior is pinned by tests).
  if (budget === undefined) {
    if (instruction === undefined) return rows.join('\n')
    const legacyWrapped = wrapTextWithAnsi(renderInstruction(instruction), width)
    const legacyRow = legacyWrapped.length > 1 ? capRowWithEllipsis(legacyWrapped[0]!, width) : legacyWrapped[0]!
    const legacyMerged = rows.length > 1 ? [...rows.slice(0, -1), legacyRow] : [...rows, legacyRow]
    return legacyMerged.join('\n')
  }
  // A SUPPLIED budget normalizes its inputs ALWAYS — even a non-finite
  // total falls back to the hard capacity instead of bypassing the
  // budget: exactly 0 is the only zero-grant value, everything else
  // normalizes (floor 1) and clamps to the capability; the width
  // becomes a finite integer >= 1 so degenerate widths still bound
  // every row.
  const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1
  if (budget.total === 0) return ''
  const total = Math.min(FOOTER_MAX_PHYSICAL_LINES, normalizePositiveInt(budget.total, FOOTER_MAX_PHYSICAL_LINES))
  const truncate = (row: string): string => truncateToWidth(row, w, '…')
  if (instruction === undefined) return rows.slice(0, total).map(truncate).join('\n')
  // The instruction reserves 1 first; the trusted command rows keep the
  // remaining slots in layout order — a wrapped row would silently spend
  // a second slot and push the hint out of the budget.
  const wrapped = wrapTextWithAnsi(renderInstruction(instruction), w)
  const instructionRow = wrapped.length > 1 ? capRowWithEllipsis(wrapped[0]!, w) : wrapped[0]!
  const kept = rows.slice(0, Math.max(0, total - 1)).map(truncate)
  return [...kept, instructionRow].join('\n')
}

/** Strip SGR sequences — params may be `;`- or colon-separated (e.g.
 * `38:2::R:G:B`); the composer only ever emits SGR — used to test whether
 * an instruction carries visible content. */
function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, '')
}

/** Force a visible `…` on a wrapped row that still has hidden content
 * behind it (the legacy capRowWithEllipsis). At width 1 the ellipsis
 * alone fills the row (the legacy `max(1, width-1)` produced a 2-cell
 * row — the marker must never overflow). */
function capRowWithEllipsis(row: string, width: number): string {
  return `${truncateToWidth(row, Math.max(0, width - 1), '')}…`
}

/** Render footer spans through the host's semantic color helpers. An
 * optional tone override replaces every span's own tone (the layout's
 * semantic tone override); emphasis still applies ON TOP of the override
 * (strong = bold + the effective color, dim = the effective color,
 * italic = italic + the effective color). */
export function renderSpans(spans: readonly FooterSpan[], toneOverride?: FooterTone): string {
  return spans.map(span => {
    const text = span.text
    const effective = toneOverride ?? span.tone
    switch (span.emphasis) {
      case 'strong': return color.textStrong(text, effective)
      case 'dim': return color.textDim(text, effective)
      case 'italic': return color.italic(text, effective)
      default: return styleTone(text, effective)
    }
  }).join('')
}

function styleTone(text: string, tone: FooterTone | undefined): string {
  switch (tone) {
    case 'primary': return color.primary(text)
    case 'accent': return color.accent(text)
    case 'textStrong': return color.textStrong(text)
    case 'textDim': return color.textDim(text)
    case 'textMuted': return color.textMuted(text)
    case 'border': return color.border(text)
    case 'success': return color.success(text)
    case 'warning': return color.warning(text)
    case 'error': return color.error(text)
    case 'roleUser': return color.roleUser(text)
    case 'shellMode': return color.shellMode(text)
    // The explicit text tone applies the text token (the legacy
    // color.text badge); an ABSENT tone leaves the span uncolored so the
    // composer's final dim pass colors it (the legacy plain parts).
    case 'text': return color.text(text)
    default: return text
  }
}
