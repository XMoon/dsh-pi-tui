/**
 * The footer composer (plan §9/§13.7): renders a FooterLayoutV1 against the
 * StatusSnapshot into the final footer text. Row rules:
 *
 * - the FIRST layout row is the status row (wraps with the host row
 *   budget), any SECOND row (the stats row) caps to one physical row, and
 *   the total never exceeds FOOTER_MAX_LINES (the legacy footerRows
 *   contract);
 * - a row with a right zone reserves the right zone first; the left zone
 *   fits the remaining width by compact → drop → truncate (plan §9.1);
 * - the Host instruction (plan §19) replaces the last row slot when active
 *   and is never user-hideable;
 * - every physical row is dimmed (the legacy footer's final pass).
 *
 * The composer consumes ONLY the StatusSnapshot + the host-owned surface
 * context (editor emptiness, extension chrome text) — never business
 * state (plan §2.2).
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
  FooterRenderContext,
  FooterRowLayout,
  FooterSegment,
  FooterSpan,
  FooterTone,
} from './types.ts'
import { FOOTER_MAX_LINES } from './types.ts'

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
  /** The active Host instruction; replaces the last row slot. */
  readonly instruction?: FooterInstructionLike
}

/** One resolved zone item (rendered at the preferred density). */
interface ZoneItem {
  readonly ref: FooterItemRef
  readonly def: { render(snapshot: StatusSnapshot, ref: FooterItemRef, density: FooterDensity, context: FooterRenderContext): FooterSegment | null }
  text: string
  readonly importance: number
  readonly minWidth: number | undefined
  readonly index: number
}

/** The footer composer. */
export class FooterComposer {
  private readonly registry: FooterItemRegistry

  constructor(registry: FooterItemRegistry) {
    this.registry = registry
  }

  /** Render the layout + instruction into the final footer text. */
  render(options: FooterComposerOptions): string {
    const { snapshot, layout, width, context, instruction } = options
    // The instruction occupies the LAST row slot: it replaces the stats
    // row when the layout has one, and appends a row otherwise (the legacy
    // line-2 swap — the exit hint always survives, even in compact).
    const statusRows = instruction === undefined
      ? layout.rows
      : layout.rows.length > 1 ? layout.rows.slice(0, -1) : layout.rows
    const lines: string[] = []
    for (const row of statusRows) {
      const line = this.renderRow(row, snapshot, context, width)
      if (line !== '') lines.push(line)
    }
    if (instruction !== undefined) lines.push(renderInstruction(instruction))
    const physical: string[] = []
    lines.forEach((line, index) => {
      const isLast = index === lines.length - 1
      if (isLast && lines.length > 1) {
        // The last row (stats/instruction) caps to one physical row.
        const wrapped = wrapTextWithAnsi(line, width)
        physical.push(wrapped.length > 1 ? capRowWithEllipsis(wrapped[0]!, width) : wrapped[0]!)
        return
      }
      const budget = FOOTER_MAX_LINES - (lines.length - index - 1)
      const wrapped = wrapTextWithAnsi(line, width)
      for (let rowIndex = 0; rowIndex < Math.min(wrapped.length, budget); rowIndex += 1) {
        const row = wrapped[rowIndex]!
        physical.push(rowIndex === budget - 1 && wrapped.length > budget
          ? capRowWithEllipsis(row, width)
          : row)
      }
    })
    // The legacy footer's final pass: every physical row is dimmed.
    return physical.map(row => color.textDim(row)).join('\n')
  }

  /** Render one layout row: left zone + flexible gap + right zone. */
  private renderRow(
    row: FooterRowLayout,
    snapshot: StatusSnapshot,
    context: FooterRenderContext,
    width: number,
  ): string {
    const left = this.renderZone(row.left, snapshot, context)
    const right = this.renderZone(row.right, snapshot, context)
    const separator = row.separator?.text ?? '  '
    if (left.length === 0 && right.length === 0) return ''
    if (right.length === 0) return left.map(item => item.text).join(separator)
    if (left.length === 0) return right.map(item => item.text).join(separator)
    // Right zone first (plan §9.1): reserve it, then the left zone fits
    // the remaining width by compact → drop → truncate.
    const rightText = right.map(item => item.text).join(separator)
    const rightWidth = visibleWidth(rightText)
    const minGap = 1
    const leftBudget = Math.max(1, width - rightWidth - minGap)
    const leftText = this.fitZone(left, separator, leftBudget)
    const leftWidth = visibleWidth(leftText)
    const gap = ' '.repeat(Math.max(1, width - leftWidth - rightWidth))
    return `${leftText}${gap}${rightText}`
  }

  /** Resolve one zone's item refs into rendered items (unknown ids and
   * throwing items are skipped — error isolation). */
  private renderZone(
    refs: readonly FooterItemRef[],
    snapshot: StatusSnapshot,
    context: FooterRenderContext,
  ): ZoneItem[] {
    const items: ZoneItem[] = []
    for (const ref of refs) {
      const def = this.registry.get(ref.id)
      if (def === undefined) continue
      let segment: FooterSegment | null
      try {
        segment = def.render(snapshot, ref, 'preferred', context)
      } catch {
        segment = null
      }
      if (segment === null) continue
      const text = renderSpans(segment.spans)
      if (text === '') continue
      items.push({
        ref,
        def,
        text,
        importance: ref.importance ?? def.defaultImportance,
        minWidth: segment.minWidth ?? def.minWidth,
        index: items.length,
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
    // 1. compact: re-render the lowest-importance items at the compact
    // density (M1 items define no compact form — the step is a no-op until
    // M2 adds compact formatters).
    const byImportance = [...kept].sort((a, b) =>
      a.importance - b.importance || b.index - a.index)
    for (const victim of byImportance) {
      if (kept.length === 1) break
      const without = kept.filter(item => item !== victim)
      if (totalOf(without) <= budget) {
        kept = without
        break
      }
      if (totalOf(without) < totalOf(kept)) kept = without
    }
    // 2. drop the tail (order preserved)...
    while (totalOf(kept) > budget && kept.length > 1) kept = kept.slice(0, -1)
    // 3. ...then truncate the last kept item ANSI-safely; an item with a
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

/** Force a visible `…` on a wrapped row that still has hidden content
 * behind it (the legacy capRowWithEllipsis). */
function capRowWithEllipsis(row: string, width: number): string {
  return `${truncateToWidth(row, Math.max(1, width - 1), '')}…`
}

/** Render footer spans through the host's semantic color helpers. */
export function renderSpans(spans: readonly FooterSpan[]): string {
  return spans.map(span => {
    const text = span.text
    const base = styleTone(text, span.tone)
    switch (span.emphasis) {
      case 'strong': return color.textStrong(text)
      case 'dim': return color.textDim(text)
      case 'italic': return color.italic(text)
      default: return base
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
