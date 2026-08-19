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

import { color } from '../../theme.ts'
import { ExtensionLedger } from './ledger.ts'
import type { HeaderBadge, StyledSpan } from '../public-types.ts'

/** A render sink for one outlet (the host wires the active screen). */
export interface OutletRenderSink {
  requestRender(): void
}

/** The header badge outlet: renders `[text]` runs after the host title.
 * Host title stays host-owned; badges are appended. */
export class HeaderBadgeOutlet {
  private readonly ledger: ExtensionLedger
  private readonly sink: OutletRenderSink
  private revision = -1
  /** The theme revision the baked ANSI was produced under (F-14: a theme
   * switch must re-bake even when the ledger revision is unchanged). */
  private themeRevision = -1
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
   * the ledger revision nor the theme revision changed). Per-contribution
   * error isolation (P1-4): a throwing contribution is recorded in the
   * health ledger and OMITTED — it can never abort the chrome refresh. */
  refresh(themeRevision = 0): void {
    const snapshot = this.ledger.snapshot<HeaderBadge>('chrome.header.badge')
    if (snapshot.revision === this.revision && themeRevision === this.themeRevision) return
    this.revision = snapshot.revision
    this.themeRevision = themeRevision
    const parts: string[] = []
    for (const record of snapshot.records) {
      try {
        const styled = styleBadge(record.value)
        if (styled !== '') parts.push(` ${styled}`)
      } catch (error) {
        this.ledger.recordError('chrome.header.badge', record.id, safeMessage(error))
      }
    }
    this.textValue = parts.join('')
    this.sink.requestRender()
  }
}

/** Style one header badge by its semantic tone. */
function styleBadge(badge: HeaderBadge): string {
  const text = badge.text
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
 * lines. The host's dock strip displays them; empty = nothing. */
export class DockItemOutlet {
  private readonly ledger: ExtensionLedger
  private readonly sink: OutletRenderSink
  private revision = -1
  /** The theme revision the baked ANSI was produced under (F-14). */
  private themeRevision = -1
  private textValue = ''

  constructor(ledger: ExtensionLedger, sink: OutletRenderSink) {
    this.ledger = ledger
    this.sink = sink
  }

  /** The current dock text (host merges it into its dock strip). */
  text(): string {
    return this.textValue
  }

  refresh(themeRevision = 0): void {
    const snapshot = this.ledger.snapshot('input.dock.item')
    if (snapshot.revision === this.revision && themeRevision === this.themeRevision) return
    this.revision = snapshot.revision
    this.themeRevision = themeRevision
    const lines: string[] = []
    for (const record of snapshot.records) {
      try {
        const item = record.value as { label?: readonly StyledSpan[]; detail?: readonly StyledSpan[] }
        const label = item.label === undefined ? '' : renderSpans(item.label)
        if (label === '') continue
        lines.push(label)
        const detail = item.detail === undefined ? '' : renderSpans(item.detail)
        if (detail !== '') lines.push(detail)
      } catch (error) {
        // Per-contribution error isolation (P1-4).
        this.ledger.recordError('input.dock.item', record.id, safeMessage(error))
      }
    }
    this.textValue = lines.join('\n')
    this.sink.requestRender()
  }
}

/** The footer segment outlet: renders ordered segments joined by two-space
 * separators, respecting importance (low-importance segments drop first when
 * the host requests a compact layout). */
export class FooterSegmentOutlet {
  private readonly ledger: ExtensionLedger
  private readonly sink: OutletRenderSink
  private revision = -1
  /** The theme revision the baked ANSI was produced under (F-14). */
  private themeRevision = -1
  private compact = false
  private textValue = ''

  constructor(ledger: ExtensionLedger, sink: OutletRenderSink) {
    this.ledger = ledger
    this.sink = sink
  }

  /** The current footer segment text (host merges it into its status line). */
  text(): string {
    return this.textValue
  }

  refresh(compact = this.compact, themeRevision = 0): void {
    const snapshot = this.ledger.snapshot('chrome.footer.status')
    // A compact flag change must re-bake even when ledger/theme revisions
    // are unchanged (round-4 finding 1: the /settings footer: compact path).
    if (snapshot.revision === this.revision && themeRevision === this.themeRevision
      && compact === this.compact) return
    this.revision = snapshot.revision
    this.themeRevision = themeRevision
    this.compact = compact
    const parts: string[] = []
    for (const record of snapshot.records) {
      try {
        const segment = record.value as { spans?: readonly StyledSpan[]; importance?: number }
        if (compact && (segment.importance ?? 0) < 0) continue
        const rendered = renderSpans(segment.spans ?? [])
        if (rendered !== '') parts.push(rendered)
      } catch (error) {
        // Per-contribution error isolation (P1-4).
        this.ledger.recordError('chrome.footer.status', record.id, safeMessage(error))
      }
    }
    this.textValue = parts.join('  ')
    this.sink.requestRender()
  }
}

/** Render styled spans through the host's semantic color helpers. Plugins
 * provide tokens only — the host owns ANSI compilation. */
export function renderSpans(spans: readonly StyledSpan[]): string {
  return spans.map(span => {
    const base = styleTone(span.text, span.tone)
    switch (span.emphasis) {
      case 'strong': return color.textStrong(span.text)
      case 'dim': return color.textDim(span.text)
      case 'italic': return color.italic(span.text)
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
