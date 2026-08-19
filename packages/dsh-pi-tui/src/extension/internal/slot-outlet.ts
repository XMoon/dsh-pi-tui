/**
 * Slot outlets (M2): the bridge between the extension ledger's contributions
 * and the host's fixed chrome components. Each outlet knows ONE slot's
 * contract (header badge / dock item / footer segment), renders the current
 * ordered contributions through the host's semantic color helpers, and
 * repaints when the ledger revision or the relevant state slice changes.
 *
 * The host OWNS layout: an outlet produces the TEXT content for the host's
 * fixed header/dock/footer components; plugins never touch the root layout.
 * @module @xmoon76/dsh-pi-tui/extension/slot-outlet
 */

import { truncateToWidth, visibleWidth } from '@xmoon76/pi-tui'
import { color } from '../../theme.ts'
import { ExtensionLedger } from './ledger.ts'
import type { HeaderBadge, StyledSpan } from '../public-types.ts'

/** A render sink for one outlet (the host wires the active screen). */
export interface OutletRenderSink {
  requestRender(): void
}

/** The header badge outlet: renders `[text]` runs after the host title.
 * Host title stays host-owned; badges are appended. The host-owned width
 * budget (plan §19) bounds the badge run: on a narrow terminal the run is
 * truncated ANSI-safely instead of wrapping onto a second row. */
export class HeaderBadgeOutlet {
  private readonly ledger: ExtensionLedger
  private readonly sink: OutletRenderSink
  private revision = -1
  /** The theme revision the baked ANSI was produced under (F-14: a theme
   * switch must re-bake even when the ledger revision is unchanged). */
  private themeRevision = -1
  /** The cell-width budget for the whole badge run (host-owned; plan §19). */
  private widthBudget = 80
  private textValue = ''

  constructor(ledger: ExtensionLedger, sink: OutletRenderSink) {
    this.ledger = ledger
    this.sink = sink
  }

  /** The current badge text (host merges it into its header row). */
  text(): string {
    return this.textValue
  }

  /** Rebuild the badge text from the ledger (cheap: skipped when neither
   * the ledger revision, the theme revision nor the width budget changed).
   * Per-contribution error isolation (P1-4): a throwing contribution is
   * recorded in the health ledger and OMITTED — it can never abort the
   * chrome refresh. */
  refresh(themeRevision = 0, widthBudget = this.widthBudget): void {
    const snapshot = this.ledger.snapshot<HeaderBadge>('chrome.header.badge')
    if (snapshot.revision === this.revision && themeRevision === this.themeRevision
      && widthBudget === this.widthBudget) return
    this.revision = snapshot.revision
    this.themeRevision = themeRevision
    this.widthBudget = widthBudget
    const parts: string[] = []
    for (const record of snapshot.records) {
      try {
        const styled = styleBadge(record.value)
        if (styled !== '') parts.push(` ${styled}`)
        // A successful render clears any earlier failure (P2: recovery —
        // the next failure starts a NEW error generation).
        this.ledger.clearError('chrome.header.badge', record.id)
      } catch (error) {
        this.ledger.recordError('chrome.header.badge', record.id, safeMessage(error))
      }
    }
    // Host-owned width budget (plan §19): the badge run must never exceed
    // its budget — truncate ANSI-safely (the fork's truncateToWidth strips
    // styling, measures the visible width and re-applies the style).
    const joined = parts.join('')
    this.textValue = visibleWidth(joined) > Math.max(1, widthBudget)
      ? truncateToWidth(joined, Math.max(1, widthBudget), '…')
      : joined
    this.sink.requestRender()
  }
}

/** Style one header badge by its semantic tone. Plugin text is sanitized
 * at this choke point too (a badge text with a control sequence must never
 * reach the terminal — plan §19 item 10). */
function styleBadge(badge: HeaderBadge): string {
  const text = sanitizeSpanText(badge.text)
  if (text === '') return ''
  switch (badge.tone) {
    case 'warning': return color.warning(`[${text}]`)
    case 'error': return color.error(`[${text}]`)
    case 'success': return color.success(`[${text}]`)
    case 'info':
    default: return color.textDim(`[${text}]`)
  }
}

/** The dock item outlet: renders the current ordered dock items as dim
 * lines within a host-owned row budget AND a host-owned cell-width budget
 * (plan §19). The host's dock strip displays them; empty = nothing. Each
 * label/detail line is truncated ANSI-safely to the width budget FIRST, so
 * a long line can never wrap into extra rows (the follow-up probe: a
 * 20-column snapshot rendered 40 visible columns). When the items' total
 * rows still exceed the row budget, low-importance items are collapsed
 * first (order preserved), then the tail — so a plugin can never push the
 * dock into the editor. */
export class DockItemOutlet {
  private readonly ledger: ExtensionLedger
  private readonly sink: OutletRenderSink
  private revision = -1
  /** The theme revision the baked ANSI was produced under (F-14). */
  private themeRevision = -1
  /** The host-owned dock row budget (defaults to 2: label + detail). */
  private maxRows = 2
  /** The host-owned line cell-width budget (plan §19 item 3-4: current
   * cell width, CJK/emoji measured by the fork's ANSI-safe helpers). */
  private widthBudget = 80
  private textValue = ''

  constructor(ledger: ExtensionLedger, sink: OutletRenderSink) {
    this.ledger = ledger
    this.sink = sink
  }

  /** The current dock text (host merges it into its dock strip). */
  text(): string {
    return this.textValue
  }

  refresh(themeRevision = 0, maxRows = this.maxRows, widthBudget = this.widthBudget): void {
    const snapshot = this.ledger.snapshot('input.dock.item')
    if (snapshot.revision === this.revision && themeRevision === this.themeRevision
      && maxRows === this.maxRows && widthBudget === this.widthBudget) return
    this.revision = snapshot.revision
    this.themeRevision = themeRevision
    this.maxRows = maxRows
    this.widthBudget = widthBudget
    const lineBudget = Math.max(1, widthBudget)
    // Render every item into { label, detail, importance } rows FIRST, so
    // the budget pass can collapse whole items (never a half item). Lines
    // are truncated to the width budget at BAKE time: a rendered line is
    // exactly one display row by construction.
    interface DockRows { label: string; detail: string; importance: number }
    const items: DockRows[] = []
    for (const record of snapshot.records) {
      try {
        const item = record.value as { label?: readonly StyledSpan[]; detail?: readonly StyledSpan[]; importance?: number }
        const label = item.label === undefined ? '' : truncateToWidth(renderSpans(item.label), lineBudget, '…')
        // Visually-empty check (review finding 7): ANSI-styled spans (or
        // whitespace-only spans) can render to a non-empty string that is
        // still ZERO visible cells — a valid no-display abdication. It must
        // clear health like any successful render AND produce no row.
        if (visibleWidth(label) === 0) {
          this.ledger.clearError('input.dock.item', record.id)
          continue
        }
        const detail = item.detail === undefined ? '' : truncateToWidth(renderSpans(item.detail), lineBudget, '…')
        items.push({ label, detail, importance: item.importance ?? 0 })
        // A successful render clears any earlier failure (P2: recovery).
        this.ledger.clearError('input.dock.item', record.id)
      } catch (error) {
        // Per-contribution error isolation (P1-4).
        this.ledger.recordError('input.dock.item', record.id, safeMessage(error))
      }
    }
    const budget = Math.max(1, maxRows)
    // Deterministic importance-based collapse (review finding 6): remove
    // whole items in ASCENDING importance order (never a higher-importance
    // item before a lower one — the old greedy could delete a big
    // high-importance item when a small low-importance one alone didn't
    // reach the budget). Rendering order stays the original order.
    const rowsOf = (item: DockRows): number => item.label === '' ? 0 : 1 + (item.detail === '' ? 0 : 1)
    const total = items.reduce((sum, item) => sum + rowsOf(item), 0)
    let kept = items
    if (total > budget) {
      const byImportance = [...items].sort((a, b) => a.importance - b.importance)
      // Remove the LOWEST-importance items until the rest fits (keep at
      // least one item; ties are broken by removal order, never by
      // rendering order).
      for (const victim of byImportance) {
        if (kept.length === 1) break
        if (kept.reduce((sum, item) => sum + rowsOf(item), 0) <= budget) break
        kept = kept.filter(item => item !== victim)
      }
      // Still over budget: drop the tail (order preserved)...
      while (kept.reduce((sum, item) => sum + rowsOf(item), 0) > budget && kept.length > 1) {
        kept = kept.slice(0, -1)
      }
      // ...and a SINGLE item that still overflows (e.g. a 1-row budget with
      // a label + detail item) drops its detail line — the label always
      // survives (plan §19: a dock item keeps its identity under pressure).
      while (kept.reduce((sum, item) => sum + rowsOf(item), 0) > budget && kept.length === 1) {
        const only = kept[0]!
        if (only.detail === '') break
        only.detail = ''
      }
    }
    const lines: string[] = []
    for (const item of kept) {
      if (item.label !== '') lines.push(item.label)
      if (item.detail !== '') lines.push(item.detail)
    }
    this.textValue = lines.join('\n')
    this.sink.requestRender()
  }
}

/** The footer segment outlet: renders ordered segments joined by two-space
 * separators within a host-owned width budget (plan §8.3/§19). Collapse
 * order: compact drops negative-importance segments, a segment narrower
 * than its `minWidth` cannot render usefully (dropped), and when the total
 * exceeds the width budget low-importance segments fold first (order
 * preserved), then the tail is truncated ANSI-safely. */
export class FooterSegmentOutlet {
  private readonly ledger: ExtensionLedger
  private readonly sink: OutletRenderSink
  private revision = -1
  /** The theme revision the baked ANSI was produced under (F-14). */
  private themeRevision = -1
  private compact = false
  private widthBudget = 80
  private textValue = ''

  constructor(ledger: ExtensionLedger, sink: OutletRenderSink) {
    this.ledger = ledger
    this.sink = sink
  }

  /** The current footer segment text (host merges it into its status line). */
  text(): string {
    return this.textValue
  }

  refresh(compact = this.compact, themeRevision = 0, widthBudget = this.widthBudget): void {
    const snapshot = this.ledger.snapshot('chrome.footer.status')
    // A compact flag or budget change must re-bake even when ledger/theme
    // revisions are unchanged (round-4 finding 1: the /settings footer:
    // compact path; plan §19: resize).
    if (snapshot.revision === this.revision && themeRevision === this.themeRevision
      && compact === this.compact && widthBudget === this.widthBudget) return
    this.revision = snapshot.revision
    this.themeRevision = themeRevision
    this.compact = compact
    this.widthBudget = widthBudget
    interface Segment { text: string; importance: number; minWidth?: number }
    const segments: Segment[] = []
    for (const record of snapshot.records) {
      try {
        const segment = record.value as { spans?: readonly StyledSpan[]; importance?: number; minWidth?: number }
        if (compact && (segment.importance ?? 0) < 0) continue
        const rendered = renderSpans(segment.spans ?? [])
        if (rendered !== '') segments.push({
          text: rendered,
          importance: segment.importance ?? 0,
          minWidth: segment.minWidth,
        })
        // A successful render clears any earlier failure (P2: recovery).
        this.ledger.clearError('chrome.footer.status', record.id)
      } catch (error) {
        // Per-contribution error isolation (P1-4).
        this.ledger.recordError('chrome.footer.status', record.id, safeMessage(error))
      }
    }
    const budget = Math.max(1, widthBudget)
    // minWidth: a segment that cannot render at its declared minimum is
    // dropped (it would be unreadable anyway) — checked on the BAKED text
    // so ANSI is measured correctly.
    const minWidthOk = segments.filter(segment =>
      segment.minWidth === undefined || visibleWidth(segment.text) >= segment.minWidth)
    // Width budget: fold the LOWEST-importance segments (order preserved)
    // until the total fits, then truncate the remaining tail ANSI-safely.
    const separator = '  '
    const totalOf = (list: readonly Segment[]): number =>
      list.reduce((sum, segment, index) => sum + visibleWidth(segment.text) + (index === 0 ? 0 : visibleWidth(separator)), 0)
    let kept = minWidthOk
    if (totalOf(kept) > budget) {
      // Remove the lowest-importance segments one at a time until the rest
      // fits; keep at least one segment.
      const byImportance = [...kept].sort((a, b) => a.importance - b.importance)
      for (const victim of byImportance) {
        if (kept.length === 1) break
        const without = kept.filter(segment => segment !== victim)
        if (totalOf(without) <= budget) {
          kept = without
          break
        }
        if (totalOf(without) < totalOf(kept)) kept = without
      }
      // Still over budget: drop the tail (order preserved)...
      while (totalOf(kept) > budget && kept.length > 1) kept = kept.slice(0, -1)
      // ...then truncate the last kept segment (never the first — host
      // state reads first). A segment with a declared minWidth is NEVER
      // truncated below it (review round-3 finding 4): truncation would
      // render a half-usable segment, violating the plugin's minimum-width
      // contract — instead the segment is removed entirely (it cannot
      // render usefully at this width). Only minWidth-less segments may be
      // truncated.
      if (totalOf(kept) > budget && kept.length > 0) {
        const last = kept[kept.length - 1]!
        if (last.minWidth !== undefined) {
          // Cannot truncate: drop the segment (order preserved).
          kept = kept.slice(0, -1)
          if (totalOf(kept) > budget && kept.length > 0) {
            const last2 = kept[kept.length - 1]!
            const prefix = kept.slice(0, -1)
            const prefixWidth = totalOf(prefix)
            const room = Math.max(1, budget - prefixWidth - (prefix.length === 0 ? 0 : visibleWidth(separator)))
            // Only truncate when the surviving last segment has no minWidth.
            if (last2.minWidth === undefined) last2.text = truncateToWidth(last2.text, room, '…')
          }
        } else {
          const prefix = kept.slice(0, -1)
          const prefixWidth = totalOf(prefix)
          const room = Math.max(1, budget - prefixWidth - (prefix.length === 0 ? 0 : visibleWidth(separator)))
          last.text = truncateToWidth(last.text, room, '…')
        }
      }
    }
    this.textValue = kept.map(segment => segment.text).join(separator)
    this.sink.requestRender()
  }
}

/**
 * Strip terminal control sequences from plugin-supplied text. The public
 * contract (plan §19 item 10) forbids raw ANSI/OSC/DCS/cursor movement/
 * raw-mode escapes from reaching the terminal; `StyledSpan.text` is the
 * ONLY text channel a plugin controls, so this choke point enforces the
 * rule at render time:
 *
 * - C0 controls (except tab/newline/CR which are legal layout whitespace,
 *   and except ESC 0x1b which the ESC branch below handles as a sequence
 *   start);
 * - 8-bit CSI (0x9b) sequences and the remaining C1 controls (0x80-0x9f);
 * - ESC-led sequences: CSI `ESC [ params intermediate final`, OSC `ESC ]`
 *   to ST/BEL, DCS/PM/APC `ESC P/^/_/X` to ST/BEL. A lone ESC (or a
 *   truncated sequence) is consumed as JUST the ESC byte — never the next
 *   character — so a bare ESC can never leave an escape byte in the output
 *   and never eats a visible character.
 *
 * The host's OWN styling (applied AFTER this pass) is the only ANSI in the
 * output.
 */
const CONTROL_SEQUENCE = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]|\u009b[0-?]*[ -\/]*[@-~]|[\u0080-\u009f]|\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[P^_X][^\x07\x1b]*(?:\x07|\x1b\\))?/g

export function sanitizeSpanText(text: string): string {
  return text.replace(CONTROL_SEQUENCE, '')
}

/** Render styled spans through the host's semantic color helpers. Plugins
 * provide tokens only — the host owns ANSI compilation. Plugin-supplied
 * text is sanitized at this single choke point (no ESC/CSI/OSC can reach
 * the terminal). */
export function renderSpans(spans: readonly StyledSpan[]): string {
  return spans.map(span => {
    const text = sanitizeSpanText(span.text)
    const base = styleTone(text, span.tone)
    switch (span.emphasis) {
      case 'strong': return color.textStrong(text)
      case 'dim': return color.textDim(text)
      case 'italic': return color.italic(text)
      default: return base
    }
  }).join('')
}

function styleTone(text: string, tone: StyledSpan['tone']): string {
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
    case 'text':
    default: return color.text(text)
  }
}

/** A safe single-line error message for the health ledger (no stack
 * traces — the plan's error policy; hostile toString is handled). */
function safeMessage(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error)
    return message.replace(/\s+/g, ' ').slice(0, 200)
  } catch {
    return 'unknown contribution error'
  }
}
