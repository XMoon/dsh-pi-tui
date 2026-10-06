/**
 * State-free approval presentation contract (TS4 plan §25): the approval
 * request/outcome/geometry types, the wrapped-height capping helpers and the
 * approval content surface that rebuilds when the live geometry budget changes.
 *
 * Moved verbatim out of `tui-app.ts`. This module renders/builds approval body
 * geometry only: the approval queue, the pending promise, the overlay lease,
 * input precedence, yes/no/cancel routing, settlement and the
 * question/approval modal arbitration stay in `TuiApp` for TS5.
 * @module @xmoon76/dsh-pi-tui/tui/panels/approval-dialog
 */

import { truncateToWidth, wrapTextWithAnsi } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import { color } from '../../theme.ts'

/**
 * Longest prefix of `text` whose WRAPPED height fits `budget` rows at
 * `width`, with an ellipsis marking a cut — the approval dialog's height
 * budget must count wrapped rows, not raw lines, because a single long
 * line can wrap across many display rows. Wrapped height is monotonic in
 * the prefix length, so a binary search bounds the wrap calls. The
 * ellipsis reserves its own row when truncating (a full last row would
 * otherwise push it onto a new row and overflow the budget).
 * @param text - the candidate text ('' yields '').
 * @param width - the wrap width.
 * @param budget - the row budget; 0 or negative yields '…' for non-empty.
 * @returns the fitted text and whether it was truncated.
 */
export function capWrappedToHeight(text: string, width: number, budget: number): { text: string; truncated: boolean } {
  if (text === '') return { text: '', truncated: false }
  // No row budgeted: nothing can render — the caller skips the child
  // (a single '…' row would overflow the budget it was promised).
  if (budget <= 0) return { text: '', truncated: true }
  const fits = (candidate: string, rows: number): boolean => wrapTextWithAnsi(candidate, width).length <= rows
  if (fits(text, budget)) return { text, truncated: false }
  // A single row: width-crop the text so the leading part stays readable
  // (a bare '…' row would lose everything).
  if (budget === 1) return { text: truncateToWidth(text, width, '…'), truncated: true }
  // More rows: the longest prefix fitting `budget - 1` rows, with the
  // ellipsis appended to the cut (it joins the last row when it has room,
  // or wraps to the reserved final row — never overflows the budget).
  const target = budget - 1
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (fits(text.slice(0, mid), target)) low = mid
    else high = mid - 1
  }
  return { text: `${text.slice(0, low)}…`, truncated: true }
}

/**
 * Fit `text` into `budget` wrapped rows for the approval dialog, ending with
 * a dimmed `... N more` marker row when the content is cut. The marker rides
 * INSIDE the budget (content rows cap at budget−1, the marker itself is
 * width-cropped so it can never wrap), so a section can never silently
 * overflow the dialog's maxHeight — same marker semantics as the
 * question flow's `appendWrappedBudgeted`. A single-row budget keeps
 * the old width-cropped ellipsis (a bare marker row would waste the row).
 * @returns the display text (rows joined with '\n') and the hidden row count.
 */
export function capWrappedToMarker(text: string, width: number, budget: number): { text: string; hidden: number } {
  if (text === '' || budget <= 0) return { text: '', hidden: 0 }
  const total = wrapTextWithAnsi(text, width).length
  if (total <= budget) return { text, hidden: 0 }
  if (budget === 1) return { text: truncateToWidth(text, width, '…'), hidden: total - 1 }
  // The longest prefix fitting budget−1 rows; the marker takes the last row.
  const target = budget - 1
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (wrapTextWithAnsi(text.slice(0, mid), width).length <= target) low = mid
    else high = mid - 1
  }
  const hidden = total - target
  const marker = truncateToWidth(color.textDim(`... ${hidden} more line${hidden > 1 ? 's' : ''}`), width, '…')
  return {
    text: `${text.slice(0, low)}\n${marker}`,
    hidden,
  }
}

/**
 * The state-free approval content surface. It rebuilds from the original
 * request when the live width/height budget changes, while keeping the
 * pending promise and modal handle untouched.
 */
export class ApprovalDialogSurface implements Component {
  private readonly request: ApprovalPromptRequest
  private readonly geometryOf: () => ApprovalOverlayGeometry
  private readonly build: (request: ApprovalPromptRequest, geometry: ApprovalOverlayGeometry) => Component
  private cached: Component | undefined
  private cacheKey = ''

  constructor(
    request: ApprovalPromptRequest,
    geometryOf: () => ApprovalOverlayGeometry,
    build: (request: ApprovalPromptRequest, geometry: ApprovalOverlayGeometry) => Component,
  ) {
    this.request = request
    this.geometryOf = geometryOf
    this.build = build
  }

  invalidate(): void {
    this.cached?.invalidate?.()
    this.cached = undefined
    this.cacheKey = ''
  }

  render(width: number): string[] {
    const geometry = this.geometryOf()
    const contentWidth = Math.max(1, Math.floor(width))
    const key = `${geometry.maxHeight}:${contentWidth}`
    if (this.cached === undefined || this.cacheKey !== key) {
      this.cached?.dispose?.()
      this.cached = this.build(this.request, {
        ...geometry,
        contentWidth: Math.min(geometry.contentWidth, contentWidth),
      })
      this.cacheKey = key
    }
    return this.cached.render(contentWidth)
  }

  dispose(): void {
    this.cached?.dispose?.()
    this.cached = undefined
  }
}

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

/** The live geometry budget for the approval overlay. */
export interface ApprovalOverlayGeometry {
  width: number
  maxHeight: number
  contentWidth: number
}

/** Derive approval geometry from the CURRENT terminal dimensions. */
export function approvalOverlayGeometry(columns: number, rows: number): ApprovalOverlayGeometry {
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1
  const height = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 1
  const maxHeight = Math.max(1, Math.min(height, 16, Math.max(8, height - 2)))
  return { width, maxHeight, contentWidth: Math.max(1, width - 8) }
}
