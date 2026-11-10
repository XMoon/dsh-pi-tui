/**
 * Screen-rect placement for one transcript search jump.
 *
 * The transcript viewport and the Search overlay are both painted surfaces of
 * the CURRENT frame, so "is the target readable?" is a two-dimensional
 * question: a target row can be inside the scroll viewport and still be
 * covered by the top-right Search box. This module answers exactly that,
 * with plain numbers only — the caller samples the real
 * `ScrollView` painted box and the real overlay `getBounds()`, passes the
 * current target cells and this function returns the next `scrollTop`.
 *
 * It is a pure function: no `TuiApp`, no fork import, no stored geometry, no
 * timers. Re-running it on its own result is idempotent, which is what keeps
 * a repaint/resize from oscillating between two positions.
 * @module @xmoon76/dsh-pi-tui/tui/components/transcript/search-viewport
 */

/** One painted rectangle in 0-based terminal coordinates. */
export type PhysicalRect = Readonly<{ x: number; y: number; width: number; height: number }>

/** One proven target cell band in transcript DOCUMENT rows (the welcome-card
 * offset is already applied) and rendered-line columns. A wrapped occurrence
 * contributes one segment per painted row. */
export type PaintedTargetSegment = Readonly<{
  documentRow: number
  startCol: number
  endCol: number
}>

export type SearchViewportChoice = Readonly<{
  scrollTop: number
  /** How many target segments are physically visible AND uncovered. */
  visibleSegments: number
  /** Every target segment is visible and uncovered. For an anchor-only target
   * (`segments: []`) this means the conservative full-width anchor rows are. */
  fullyReadable: boolean
}>

export interface SearchViewportInput {
  /** The ScrollView's real painted box (`getPaintedBox`), same units as
   * {@link SearchViewportInput.overlay}. */
  readonly viewport: PhysicalRect
  /** The Search overlay's real `getBounds()` rectangle; absent when the box is
   * hidden or was never painted. */
  readonly overlay?: PhysicalRect
  readonly currentScrollTop: number
  readonly maxScrollTop: number
  /** Inclusive document-row range of the current target. */
  readonly targetRows: Readonly<{ start: number; end: number }>
  /** Proven target cells. Empty means "anchor only": the conservative
   * full-viewport-width rows of {@link SearchViewportInput.targetRows} are used
   * so an occluded anchor is never claimed readable. */
  readonly segments: readonly PaintedTargetSegment[]
}

type Candidate = {
  readonly scrollTop: number
  readonly readable: number
  readonly fullyReadable: boolean
  readonly distance: number
  readonly belowOverlay: boolean
}

const isInteger = (value: number): boolean => Number.isFinite(value) && Number.isInteger(value)

const isValidRect = (rect: PhysicalRect | undefined): rect is PhysicalRect =>
  rect !== undefined
  && isInteger(rect.x) && isInteger(rect.y)
  && isInteger(rect.width) && isInteger(rect.height)
  && rect.width > 0 && rect.height > 0

const clampTop = (value: number, maxScrollTop: number): number =>
  Math.max(0, Math.min(Math.trunc(value), maxScrollTop))

/** Segment readable at `top`? It must be inside the viewport AND, on the same
 * physical row, must not horizontally overlap the overlay. Row overlap alone
 * never means occlusion. */
function isReadable(
  top: number,
  viewport: PhysicalRect,
  overlay: PhysicalRect | undefined,
  segment: PaintedTargetSegment,
): boolean {
  const y = viewport.y + segment.documentRow - top
  if (y < viewport.y || y >= viewport.y + viewport.height) return false
  const startX = viewport.x + segment.startCol
  const endX = viewport.x + segment.endCol
  if (endX <= viewport.x || startX >= viewport.x + viewport.width) return false
  if (overlay === undefined) return true
  if (y < overlay.y || y >= overlay.y + overlay.height) return true
  return endX <= overlay.x || startX >= overlay.x + overlay.width
}

/** The conservative anchor rows used when the caller has no proven cells. */
function anchorSegments(targetRows: { readonly start: number; readonly end: number }, width: number): PaintedTargetSegment[] {
  const segments: PaintedTargetSegment[] = []
  for (let row = targetRows.start; row <= targetRows.end; row += 1) {
    segments.push({ documentRow: row, startCol: 0, endCol: width })
  }
  return segments
}

/**
 * The next `scrollTop` for the current search target.
 *
 * Candidates are a FIXED small set (current position, the existing third
 * placement, target top at the viewport top, target bottom at the viewport
 * bottom, the row above the overlay's top edge, the row below the overlay's
 * bottom edge, the document top and the document bottom) — never a scan over
 * the document. The current position wins when the whole target is already
 * readable (no-jitter); otherwise the most readable candidate wins, then the
 * nearest one, then the one placed below the occluder.
 *
 * Callers should only invoke this when they really have the painted viewport
 * rect; an unavailable rect leaves the existing viewport-only placement in
 * force.
 */
export function chooseSearchViewportTop(input: SearchViewportInput): SearchViewportChoice {
  const maxScrollTop = Number.isFinite(input.maxScrollTop) ? Math.max(0, Math.trunc(input.maxScrollTop)) : 0
  const currentScrollTop = clampTop(input.currentScrollTop, maxScrollTop)
  if (!isValidRect(input.viewport) || !isInteger(input.targetRows.start) || !isInteger(input.targetRows.end)) {
    return { scrollTop: currentScrollTop, visibleSegments: 0, fullyReadable: false }
  }
  const viewport = input.viewport
  const overlay = isValidRect(input.overlay) ? input.overlay : undefined
  const targetStart = Math.min(input.targetRows.start, input.targetRows.end)
  const targetEnd = Math.max(input.targetRows.start, input.targetRows.end)
  const segments = input.segments.length === 0
    ? anchorSegments({ start: targetStart, end: targetEnd }, viewport.width)
    : input.segments

  const candidates: number[] = []
  const addCandidate = (candidateTop: number): void => {
    const clamped = clampTop(candidateTop, maxScrollTop)
    if (!candidates.includes(clamped)) candidates.push(clamped)
  }
  addCandidate(currentScrollTop)
  addCandidate(targetStart - Math.floor(viewport.height / 3))
  addCandidate(targetStart)
  addCandidate(targetEnd - viewport.height + 1)
  if (overlay !== undefined) {
    addCandidate(targetEnd + viewport.y - overlay.y + 1)
    addCandidate(targetStart + viewport.y - overlay.y - overlay.height)
  }
  addCandidate(0)
  addCandidate(maxScrollTop)

  let best: Candidate | undefined
  for (const scrollTop of candidates) {
    const readable = segments.reduce((total, segment) =>
      total + (isReadable(scrollTop, viewport, overlay, segment) ? 1 : 0), 0)
    const startY = viewport.y + targetStart - scrollTop
    const candidate: Candidate = {
      scrollTop,
      readable,
      fullyReadable: readable === segments.length,
      distance: Math.abs(scrollTop - currentScrollTop),
      belowOverlay: overlay === undefined || startY > overlay.y + overlay.height - 1,
    }
    if (best === undefined) {
      best = candidate
      continue
    }
    if (candidate.fullyReadable !== best.fullyReadable) {
      if (candidate.fullyReadable) best = candidate
      continue
    }
    if (candidate.readable !== best.readable) {
      if (candidate.readable > best.readable) best = candidate
      continue
    }
    if (candidate.distance !== best.distance) {
      if (candidate.distance < best.distance) best = candidate
      continue
    }
    if (candidate.belowOverlay && !best.belowOverlay) best = candidate
  }

  // Nothing can be brought into view at all (an empty/degenerate target range
  // outside the document): keep the existing one-third placement.
  if (best === undefined || best.readable === 0) {
    return {
      scrollTop: clampTop(targetStart - Math.floor(viewport.height / 3), maxScrollTop),
      visibleSegments: 0,
      fullyReadable: false,
    }
  }
  return {
    scrollTop: best.scrollTop,
    visibleSegments: best.readable,
    fullyReadable: best.fullyReadable,
  }
}
