/**
 * The approval action sheet presentation (Surface Phase 3C / C1-B): one
 * editor-seat blocking frame that shows the complete approval request in a
 * single scrollable reading region, with the decision actions pinned below.
 *
 * The sheet owns presentation state ONLY — the scroll offset, the expanded
 * reading size, the last-painted action hit map and the click gesture fence.
 * The approval queue, the pending promise, the one-shot settlement and the
 * Host outcome stay in `tui/interaction/approval-runtime.ts`; the sheet sends
 * its decision INTENT to the runtime and never resolves the caller itself.
 *
 * Keyboard is available in both surfaces. The action-cell hit map is built
 * only while the host reports the fullscreen pointer surface, so Regular
 * never has an approval button target even if the terminal emits an SGR
 * report. The painted frame supplies every hit cell; blank space and
 * unpainted cells are never targets.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/approval-dialog
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import { Frame } from '../components/frame.ts'
import { color } from '../theme/runtime.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { sanitizeDisplayText } from '../presentation/terminal-text.ts'

/** What an approval prompt shows; mirrors the approval/request payload. */
export interface ApprovalPromptRequest {
  /** The tool asking for permission. */
  toolName: string
  /** The asker's human-readable reason, when one exists. */
  reason?: string
  /** Aborting withdraws the prompt and settles `cancelled`. */
  signal?: AbortSignal
  /** The tool call's arguments (paired via the request's callId), when known. */
  arguments?: string
  /** A destructive command matched a danger pattern; render a warning. */
  danger?: boolean
}

/** Closed approval outcomes the user can produce at the prompt. */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled'

/** One painted action target. `copy`/`expand` are presentation-only; the
 * three decision actions go through the runtime's one settlement path. */
export type ApprovalAction = 'allow-once' | 'reject' | 'cancel' | 'copy' | 'expand'

/**
 * The press-time semantic identity of one fullscreen approval click. The
 * release is accepted only for the SAME action segment on the SAME painted
 * layout; a scroll, expand, resize, A→B replacement or abort invalidates it
 * (the layout key changes or the frame is no longer the live seat owner).
 */
export interface ApprovalMouseGesture {
  readonly action: ApprovalAction
  readonly row: number
  readonly start: number
  readonly end: number
  readonly layoutKey: string
}

/** One action label before layout. */
interface ActionLabel {
  readonly action: ApprovalAction
  readonly text: string
}

/** One cached body row. Headings are painted with the theme token at RENDER
 * time (never baked into the cache), so a palette switch cannot leave stale
 * ANSI in the scrollable projection. */
interface BodyRow {
  readonly text: string
  readonly heading: boolean
}

/** One painted action segment in sheet-content coordinates. */
interface ActionHit {
  readonly action: ApprovalAction
  readonly row: number
  readonly start: number
  readonly end: number
}

/** The sheet's rendering dependencies. */
interface ApprovalSheetOptions {
  /** Whether the host surface supports approval pointer actions. */
  mouseEnabled: () => boolean
  /** Deliver a decision INTENT to the runtime's one settle path. */
  onDecision: (outcome: ApprovalOutcome) => void
  /** Deliver the received argument bytes through the Client clipboard. */
  onCopy: (text: string) => void
}

/** The body row budget beyond which the sheet advertises a resize instead of
 * a row-range fact: the ultra-short degradation from the C1-A contract. */
const TINY_BODY_BUDGET = 6
/** The action-bar rows a normal layout may consume before secondary labels
 * are dropped (the body keeps priority on short screens). */
const PREFERRED_ACTION_ROWS = 2
/** Below this frame grant the sheet paints one truthful resize row instead of
 * a clipped box: the pinned header/footer must keep their own rows and there
 * is no honest way to show the title, a reading row AND all three decisions. */
const MIN_SHEET_FRAME_ROWS = 5

/** A blank content row (kept as a plain space so the Frame border padding
 * never becomes a zero-width row). */
const BLANK = ' '

/**
 * Split one untrusted multi-line section into width-aware rows with a fixed
 * two-space continuation indent. The source text is projected through the
 * shared display sanitizer BEFORE wrapping, so no escape sequence or control
 * byte can reach the terminal; the raw bytes stay untouched for Copy.
 */
function pushSectionRows(rows: BodyRow[], text: string, width: number): void {
  const inner = Math.max(1, width - 2)
  for (const sourceLine of text.split('\n')) {
    const wrapped = wrapTextWithAnsi(sourceLine, inner)
    if (wrapped.length === 0) {
      rows.push({ text: '  ', heading: false })
      continue
    }
    for (const line of wrapped) rows.push({ text: `  ${line}`, heading: false })
  }
}

/**
 * The ultra-short body projection: the section label rides the FIRST content
 * row (`Reason: …`) instead of spending a dedicated heading row, so a
 * three-row reading budget still shows real request text.
 */
function pushInlineSection(rows: BodyRow[], label: string, text: string, width: number): void {
  const inner = Math.max(1, width - 2)
  const prefix = `${label}: `
  const firstWidth = Math.max(1, inner - visibleWidth(prefix))
  const sourceLines = text.split('\n')
  const firstWrapped = wrapTextWithAnsi(sourceLines[0] ?? '', firstWidth)
  if (firstWrapped.length === 0) {
    rows.push({ text: prefix, heading: false })
  } else {
    rows.push({ text: `${prefix}${firstWrapped[0]}`, heading: false })
    for (let index = 1; index < firstWrapped.length; index += 1) {
      rows.push({ text: `  ${firstWrapped[index]}`, heading: false })
    }
  }
  for (let index = 1; index < sourceLines.length; index += 1) {
    const wrapped = wrapTextWithAnsi(sourceLines[index]!, inner)
    if (wrapped.length === 0) {
      rows.push({ text: '  ', heading: false })
      continue
    }
    for (const line of wrapped) rows.push({ text: `  ${line}`, heading: false })
  }
}

/**
 * Pack action labels into rows joined by the family's ` · ` separator.
 * @returns the packed rows, or undefined when one label alone is wider than
 *   the available content width (the caller then uses its short form).
 */
function packActionRows(labels: readonly ActionLabel[], width: number): ActionLabel[][] | undefined {
  const rows: ActionLabel[][] = []
  let row: ActionLabel[] = []
  let used = 0
  for (const label of labels) {
    const labelWidth = visibleWidth(label.text)
    if (labelWidth > width) return undefined
    const next = used === 0 ? labelWidth : used + 3 + labelWidth
    if (next <= width) {
      row.push(label)
      used = next
      continue
    }
    rows.push(row)
    row = [label]
    used = labelWidth
  }
  if (row.length > 0) rows.push(row)
  return rows
}

/**
 * The single scrollable approval reading surface. It renders one pinned
 * title/danger header, the unified Reason→Arguments body, an optional scroll
 * fact and the action bar. Every untrusted string is display-projected here;
 * Copy always receives the original `request.arguments` bytes.
 */
class ApprovalSheet implements Component {
  private readonly request: ApprovalPromptRequest
  private readonly options: ApprovalSheetOptions
  /** Content-row budget supplied by the seat frame before each render. */
  private maxRows = 12
  /** Unified body scroll offset in wrapped display rows. */
  private scrollTop = 0
  /** The explicit expanded reading size ('e' / a painted Expand action). */
  private expanded = false
  /** Wrapped body rows, cached by content width and the current compact mode
   * (scrolling reuses the projection; expand/resize rebuilds it). */
  private bodyCache: { width: number; compact: boolean; rows: BodyRow[] } | undefined
  /** Last-painted action segments (sheet-content coordinates). */
  private actionHits: ActionHit[] = []
  /** Last-painted body viewport rows and content width (wheel hit test). */
  private bodyTop = 0
  private bodyBottom = 0
  private lastContentWidth = 0
  /** The semantic layout identity a click gesture was pressed against. */
  private layoutKey = ''
  /** Whether the LAST render showed the title, a reading row (when content
   * exists) and all three decision actions. The seat frame replaces an
   * dishonest layout with one explicit resize row. */
  private layoutHonest = false
  /** The live press gesture (object identity is part of the release fence). */
  private mousePressGesture: ApprovalMouseGesture | undefined

  constructor(request: ApprovalPromptRequest, options: ApprovalSheetOptions) {
    this.request = request
    this.options = options
  }

  invalidate(): void {
    this.bodyCache = undefined
  }

  /** The frame's height derivation reads this before each render. */
  isExpanded(): boolean {
    return this.expanded
  }

  /** Set the content-row budget (the frame's total grant minus its borders). */
  setMaxRows(rows: number): void {
    this.maxRows = Math.max(1, Math.floor(rows))
  }

  /** The full display-safe body rows; rebuilding happens only on width/compact
   * change (scrolling reuses the wrapped projection). */
  private bodyRows(width: number): BodyRow[] {
    const compact = this.maxRows <= TINY_BODY_BUDGET
    if (this.bodyCache?.width === width && this.bodyCache.compact === compact) return this.bodyCache.rows
    const rows: BodyRow[] = []
    const reason = sanitizeDisplayText(this.request.reason ?? '')
    if (reason !== '') {
      if (compact) {
        pushInlineSection(rows, 'Reason', reason, width)
      } else {
        rows.push({ text: 'Reason', heading: true })
        pushSectionRows(rows, reason, width)
      }
    }
    const args = sanitizeDisplayText(this.request.arguments ?? '')
    if (args !== '') {
      if (compact) {
        pushInlineSection(rows, 'Arguments', args, width)
      } else {
        rows.push({ text: 'Arguments', heading: true })
        pushSectionRows(rows, args, width)
      }
    }
    this.bodyCache = { width, compact, rows }
    return rows
  }

  /** The frame's too-small degradation: no sheet is painted, only the
   * truthful resize status in the seat row. The pointer hit map is cleared so
   * no stale action cell can survive a shrink below the minimum grant. */
  clearProjection(): void {
    this.actionHits = []
    this.bodyTop = 0
    this.bodyBottom = 0
    this.lastContentWidth = 0
    this.layoutKey = ''
    this.mousePressGesture = undefined
  }

  /** Candidate action-label sets, richest first. */
  private actionVariants(hasArguments: boolean): ActionLabel[][] {
    const full: ActionLabel[] = [
      { action: 'allow-once', text: '[y] Allow once' },
      { action: 'reject', text: '[n] Reject' },
      ...hasArguments ? [{ action: 'copy' as const, text: '[c] Copy args' }] : [],
      { action: 'expand', text: this.expanded ? '[e] Collapse' : '[e] Expand' },
      { action: 'cancel', text: '[Esc] Cancel' },
    ]
    const noExpand = full.filter(label => label.action !== 'expand')
    const decisionsOnly = noExpand.filter(label => label.action !== 'copy')
    const short: ActionLabel[] = [
      { action: 'allow-once', text: '[y] Allow' },
      { action: 'reject', text: '[n] Reject' },
      { action: 'cancel', text: '[Esc] Cancel' },
    ]
    const variants: ActionLabel[][] = [full]
    if (noExpand.length !== full.length) variants.push(noExpand)
    if (decisionsOnly.length !== noExpand.length) variants.push(decisionsOnly)
    variants.push(short)
    return variants
  }

  /** Pick the richest action layout that fits the row/width budget. */
  private layoutActions(
    width: number,
    hasArguments: boolean,
    rowLimit: number,
  ): ActionLabel[][] {
    const variants = this.actionVariants(hasArguments)
    let limited: ActionLabel[][] | undefined
    let smallest: ActionLabel[][] | undefined
    for (const variant of variants) {
      const packed = packActionRows(variant, width)
      if (packed === undefined) continue
      // The variants are ordered richest → shortest. Remember the LAST one
      // that fits the width: when no variant fits the row budget, the shortest
      // form is the truthful degradation (it keeps all three decisions instead
      // of slicing off Reject/Cancel from the rich layout).
      smallest = packed
      if (packed.length <= Math.min(rowLimit, PREFERRED_ACTION_ROWS)) return packed
      if (packed.length <= rowLimit && limited === undefined) limited = packed
    }
    if (limited !== undefined) return limited
    if (smallest !== undefined) return smallest
    // An extremely narrow surface: truncate each decision label to the width
    // so the three mandatory actions stay painted and reachable by keyboard.
    const crop = (text: string): string => truncateToWidth(text, width, '…')
    return [[
      { action: 'allow-once', text: crop('[y] Allow') },
    ], [
      { action: 'reject', text: crop('[n] Reject') },
    ], [
      { action: 'cancel', text: crop('[Esc] Cancel') },
    ]]
  }

  /** The scroll fact / resize hint row. */
  private scrollHint(total: number, viewport: number, tiny: boolean): string | undefined {
    if (total <= viewport) return undefined
    if (tiny) return color.textDim('Resize to inspect more')
    const start = this.scrollTop + 1
    const end = this.scrollTop + viewport
    const more = this.scrollTop === 0
      ? '↓ more'
      : end >= total ? '↑ more' : '↑↓ more'
    return color.textDim(`rows ${start}–${end}/${total} · ${more}`)
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, Math.floor(width))
    this.lastContentWidth = contentWidth
    const maxRows = Math.max(1, this.maxRows)
    const body = this.bodyRows(contentWidth)
    const hasArguments = this.request.arguments !== undefined && this.request.arguments !== ''

    const compactHeader = maxRows <= TINY_BODY_BUDGET
    const titleText = `Approve ${sanitizedPhysicalLine(this.request.toolName)}?`
    let titleShown = truncateToWidth(titleText, contentWidth, '…')
    let dangerShown = ''
    if (this.request.danger === true) {
      if (compactHeader) {
        // Ultra-short degradation keeps BOTH facts on one row instead of
        // spending the last reading row on a separate banner. The title is
        // cropped FIRST so a long tool name can never push the danger fact out;
        // when even that row cannot fit the full banner, keep a compact tool
        // identity plus the warning glyph.
        const suffix = ' · ⚠ Dangerous command'
        if (visibleWidth(suffix) < contentWidth) {
          titleShown = `${truncateToWidth(titleText, contentWidth - visibleWidth(suffix), '…')}${suffix}`
        } else {
          const dangerTag = ' ⚠'
          const toolLabel = sanitizedPhysicalLine(this.request.toolName)
          titleShown = truncateToWidth(
            `${truncateToWidth(toolLabel, Math.max(1, contentWidth - visibleWidth(dangerTag)), '…')}${dangerTag}`,
            contentWidth,
            '…',
          )
        }
      } else {
        dangerShown = truncateToWidth('⚠ Dangerous command — review carefully', contentWidth, '…')
      }
    }

    // The action bar is pinned and mandatory; the body keeps at least one row
    // when there is something to read and the grant allows it.
    const actionRowLimit = Math.max(1, maxRows - 1 - (body.length > 0 ? 1 : 0))
    let actionRows = this.layoutActions(contentWidth, hasArguments, actionRowLimit)
    let fixed = 1 + (dangerShown === '' ? 0 : 1) + actionRows.length
    if (fixed > maxRows) {
      dangerShown = ''
      fixed = 1 + actionRows.length
    }
    if (fixed > maxRows) {
      titleShown = ''
      fixed = actionRows.length
    }
    if (fixed > maxRows) {
      actionRows = actionRows.slice(0, Math.max(1, maxRows))
      fixed = actionRows.length
    }
    const remaining = Math.max(0, maxRows - fixed)

    let viewport = 0
    let hintRow = false
    if (body.length > 0 && remaining > 0) {
      viewport = Math.min(body.length, remaining)
      // Reserve the final row for the scroll/resize fact only when the grant
      // actually has a spare row; a one-row grant keeps its reading row and
      // carries the resize fact on the title instead.
      if (body.length > remaining && remaining >= 2) {
        viewport = remaining - 1
        hintRow = true
      }
    }
    const maxScroll = Math.max(0, body.length - viewport)
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll))
    const hint = hintRow
      ? this.scrollHint(body.length, viewport, maxRows <= TINY_BODY_BUDGET)
      : undefined
    // When the grant cannot afford a dedicated scroll/resize row, carry the
    // resize fact on the title row so the reading row is never spent on it.
    // A narrow title uses the short verb form rather than an ellipsis that
    // would silently drop the fact.
    if (body.length > viewport && hint === undefined && titleShown !== '') {
      const fullSuffix = ' · Resize to inspect more'
      const shortSuffix = ' · Resize'
      if (visibleWidth(`${titleShown}${fullSuffix}`) <= contentWidth) {
        titleShown = `${titleShown}${fullSuffix}`
      } else if (visibleWidth(`${titleShown}${shortSuffix}`) <= contentWidth) {
        titleShown = `${titleShown}${shortSuffix}`
      } else {
        // Drop the "Approve…" wrapper to a compact `<tool>?` before truncating
        // the fact itself: the tool identity, the danger glyph (when present)
        // and the resize cue all stay legible.
        const toolLabel = sanitizedPhysicalLine(this.request.toolName)
        const danger = this.request.danger === true
        const warningPrefix = danger ? '⚠ ' : ''
        const compactIdentity = `${toolLabel}${danger ? '' : '?'}`
        if (visibleWidth(`${warningPrefix}${compactIdentity}${shortSuffix}`) <= contentWidth) {
          titleShown = `${warningPrefix}${compactIdentity}${shortSuffix}`
        } else {
          const titleBudget = Math.max(
            1,
            contentWidth - visibleWidth(shortSuffix) - visibleWidth(warningPrefix),
          )
          titleShown = `${warningPrefix}${truncateToWidth(compactIdentity, titleBudget, '…')}${shortSuffix}`
        }
      }
    }

    const lines: string[] = []
    if (titleShown !== '') lines.push(color.textStrong(titleShown))
    if (dangerShown !== '') lines.push(color.error(dangerShown))
    this.bodyTop = lines.length
    for (let index = 0; index < viewport; index += 1) {
      const row = body[this.scrollTop + index]
      lines.push(row === undefined ? BLANK : row.heading ? color.textDim(row.text) : row.text)
    }
    this.bodyBottom = this.bodyTop + viewport
    if (hint !== undefined && hint !== '') lines.push(hint)

    // Paint the action bar and record the REAL cell ranges of this frame. The
    // hit map is empty on the regular surface: no approval button target is
    // ever registered there.
    const hits: ActionHit[] = []
    const mouseEnabled = this.options.mouseEnabled()
    for (let rowIndex = 0; rowIndex < actionRows.length; rowIndex += 1) {
      const segments = actionRows[rowIndex] ?? []
      let plain = ''
      let painted = ''
      for (const segment of segments) {
        if (plain !== '') {
          plain += ' · '
          painted += ' · '
        }
        const start = visibleWidth(plain)
        plain += segment.text
        painted += color.primary(segment.text)
        if (mouseEnabled) {
          hits.push({
            action: segment.action,
            row: lines.length,
            start,
            end: start + visibleWidth(segment.text) - 1,
          })
        }
      }
      if (plain !== '') lines.push(painted)
    }
    this.actionHits = hits
    const paintedActions = new Set(actionRows.flat().map(label => label.action))
    const dangerHonest = this.request.danger !== true
      || dangerShown !== ''
      || titleShown.includes('⚠')
    this.layoutHonest = titleShown !== ''
      && dangerHonest
      && (body.length === 0 || viewport > 0)
      && paintedActions.has('allow-once')
      && paintedActions.has('reject')
      && paintedActions.has('cancel')
    this.layoutKey = [
      contentWidth,
      maxRows,
      this.expanded ? 'x' : 'n',
      this.scrollTop,
      viewport,
      body.length,
      mouseEnabled ? 'm' : 'k',
      actionRows.map(row => row.map(label => label.action).join(',')).join('|'),
    ].join(':')
    return lines
  }

  /** Whether the last sheet render was truthful (title, a reading row when
   * content exists, and all three decisions). */
  isLayoutHonest(): boolean {
    return this.layoutHonest
  }
  beginMousePress(row: number, x: number): ApprovalMouseGesture | undefined {
    this.mousePressGesture = undefined
    if (!this.options.mouseEnabled()) return undefined
    const hit = this.actionHits.find(candidate =>
      candidate.row === row && x >= candidate.start && x <= candidate.end)
    if (hit === undefined) return undefined
    const gesture: ApprovalMouseGesture = {
      action: hit.action,
      row: hit.row,
      start: hit.start,
      end: hit.end,
      layoutKey: this.layoutKey,
    }
    this.mousePressGesture = gesture
    return gesture
  }

  /** Complete a fullscreen action click: the release must still describe the
   * SAME painted segment of the SAME frame state. A semantic repaint that
   * moved another action onto the cell is rejected; an unrelated repaint that
   * kept this action's painted cells is not. */
  completeMouseClick(gesture: ApprovalMouseGesture | undefined, row: number, x: number): boolean {
    const pressed = this.mousePressGesture
    this.mousePressGesture = undefined
    if (gesture === undefined || pressed !== gesture) return false
    if (!this.options.mouseEnabled() || gesture.layoutKey !== this.layoutKey) return false
    const hit = this.actionHits.find(candidate =>
      candidate.row === row && x >= candidate.start && x <= candidate.end
      && candidate.action === gesture.action
      && candidate.row === gesture.row
      && candidate.start === gesture.start
      && candidate.end === gesture.end)
    if (hit === undefined) return false
    switch (hit.action) {
      case 'allow-once': this.options.onDecision('allowed-once'); return true
      case 'reject': this.options.onDecision('rejected'); return true
      case 'cancel': this.options.onDecision('cancelled'); return true
      case 'expand': this.expanded = !this.expanded; return true
      case 'copy': this.options.onCopy(this.request.arguments ?? ''); return true
    }
  }

  /** A wheel event over the painted body viewport scrolls the reading region.
   * Wheel outside the body is not an approval gesture (the host still keeps
   * the background behind the blocking modal). */
  wheelBy(delta: number, row: number, x: number): boolean {
    if (delta === 0 || x < 0 || x >= this.lastContentWidth) return false
    if (row < this.bodyTop || row >= this.bodyBottom) return false
    const viewport = this.bodyBottom - this.bodyTop
    const maxScroll = Math.max(0, this.bodyRows(this.lastContentWidth).length - viewport)
    if (maxScroll === 0) return false
    const next = Math.max(0, Math.min(this.scrollTop + delta, maxScroll))
    if (next === this.scrollTop) return false
    this.scrollTop = next
    return true
  }

  /** Whether a key is a sheet-local read-only/action key (the modal
   * inspection ladder must not claim it first). */
  ownsReadKey(data: string): boolean {
    if (matchesKey(data, 'up') || matchesKey(data, 'down')
      || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')
      || matchesKey(data, 'home') || matchesKey(data, 'end')
      || matchesKey(data, 'e')) return true
    return this.request.arguments !== undefined && this.request.arguments !== ''
      && matchesKey(data, 'c')
  }

  /** Keyboard reading/copy/expand actions. The runtime keeps the fixed
   * response keys (y/n/Esc/Ctrl+C) and calls this for everything else. */
  handleActionKey(data: string): boolean {
    if (this.lastContentWidth === 0) return false
    const bodyViewport = Math.max(0, this.bodyBottom - this.bodyTop)
    const page = Math.max(1, bodyViewport - 1)
    const maxScroll = Math.max(0, this.bodyRows(this.lastContentWidth).length - bodyViewport)
    if (matchesKey(data, 'up')) { this.scrollTop = Math.max(0, this.scrollTop - 1); return true }
    if (matchesKey(data, 'down')) { this.scrollTop = Math.min(maxScroll, this.scrollTop + 1); return true }
    if (matchesKey(data, 'pageUp')) { this.scrollTop = Math.max(0, this.scrollTop - page); return true }
    if (matchesKey(data, 'pageDown')) { this.scrollTop = Math.min(maxScroll, this.scrollTop + page); return true }
    if (matchesKey(data, 'home')) { this.scrollTop = 0; return true }
    if (matchesKey(data, 'end')) { this.scrollTop = maxScroll; return true }
    if (matchesKey(data, 'e')) { this.expanded = !this.expanded; return true }
    if (matchesKey(data, 'c') && this.request.arguments !== undefined && this.request.arguments !== '') {
      this.options.onCopy(this.request.arguments)
      return true
    }
    return false
  }
}

/** The seat-frame dependencies: terminal/seat geometry plus the host's
 * clipboard and pointer-capability facts. */
export interface ApprovalSheetFrameOptions {
  /** Total frame-row grant (borders included) for the current reading size. */
  rowsOf: (expanded: boolean) => number
  /** The live terminal row count (the resize-hint/geometry fence). */
  terminalRows: () => number
  /** Whether the host surface currently supports approval pointer actions. */
  mouseEnabled: () => boolean
  /** Deliver a decision intent to the approval runtime. */
  onDecision: (outcome: ApprovalOutcome) => void
  /** Deliver the received argument bytes through the Client clipboard. */
  onCopy: (text: string) => void
}

/**
 * The editor-seat frame for one approval request. It re-derives the sheet's
 * row budget from the LIVE seat grant on every render (a resize or an
 * expanded toggle changes the budget, never the request), and exposes the
 * last-painted terminal geometry so the fullscreen press/click fence can
 * reject a gesture that began on a frame the new size never painted.
 */
export class ApprovalSheetFrame extends Frame {
  private readonly sheet: ApprovalSheet
  private readonly options: ApprovalSheetFrameOptions
  private readonly danger: boolean
  private lastRows = 0
  private lastTermRows = 0
  private lastTermColumns = 0
  private disposed = false

  constructor(request: ApprovalPromptRequest, options: ApprovalSheetFrameOptions) {
    const sheet = new ApprovalSheet(request, {
      mouseEnabled: options.mouseEnabled,
      onDecision: options.onDecision,
      onCopy: options.onCopy,
    })
    super(sheet, true)
    this.sheet = sheet
    this.options = options
    this.danger = request.danger === true
  }

  /** The truthful one-row degradation; a dangerous request keeps its warning
   * glyph even when nothing else fits. */
  private resizeRow(width: number): string[] {
    return [truncateToWidth(
      this.danger ? '⚠ Resize to inspect more' : 'Resize to inspect more',
      Math.max(1, width),
      '…',
    )]
  }

  render(width: number): string[] {
    const grant = Math.max(1, Math.floor(this.options.rowsOf(this.sheet.isExpanded())))
    this.lastTermRows = this.options.terminalRows()
    this.lastTermColumns = width
    if (grant < MIN_SHEET_FRAME_ROWS) {
      // The seat grant cannot host an honest action sheet without taking the
      // header/footer rows or hiding a decision. Paint the explicit resize fact
      // and leave the keyboard decisions with the runtime.
      this.sheet.clearProjection()
      this.lastRows = 1
      return this.resizeRow(width)
    }
    this.sheet.setMaxRows(Math.max(1, grant - 2))
    const out = super.render(width)
    if (!this.sheet.isLayoutHonest()) {
      // The width/height combination cannot show the title, a reading row and
      // all three decisions inside the real grant. Do not paint a partial
      // action sheet; keep one truthful resize row and leave the keyboard
      // decisions to the runtime.
      this.sheet.clearProjection()
      this.lastRows = 1
      return this.resizeRow(width)
    }
    this.lastRows = out.length
    return out
  }

  /** The frame's rendered height from the last paint (0 before the first). */
  get rows(): number {
    return this.lastRows
  }

  /** The terminal height the last render used (stale-geometry fence). */
  get termRows(): number {
    return this.lastTermRows
  }

  /** The terminal width the last render used (stale-geometry fence). */
  get termColumns(): number {
    return this.lastTermColumns
  }

  /** Release the sheet's cached projection. The frame owns no external
   * resource; the idempotent latch keeps a settle/remount tail from
   * double-releasing. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.invalidate()
  }

  /** Record a press against the last-painted action cells. */
  beginMousePress(row: number, x: number): ApprovalMouseGesture | undefined {
    return this.sheet.beginMousePress(row, x)
  }

  /** Complete a press/release pair; returns whether an action ran. */
  completeMouseClick(gesture: ApprovalMouseGesture | undefined, row: number, x: number): boolean {
    return this.sheet.completeMouseClick(gesture, row, x)
  }

  /** Scroll the sheet body from a wheel event over a painted body row. */
  wheelBy(delta: number, row: number, x: number): boolean {
    return this.sheet.wheelBy(delta, row, x)
  }

  /** Whether a key belongs to the sheet before the modal inspection ladder. */
  ownsReadKey(data: string): boolean {
    return this.sheet.ownsReadKey(data)
  }

  /** Handle one read-only/action key. */
  handleActionKey(data: string): boolean {
    return this.sheet.handleActionKey(data)
  }
}
