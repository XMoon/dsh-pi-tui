/**
 * The Job Command READER (Phase 3B / B1-C): the second, mutually exclusive body
 * of the ONE Job workspace — a pure-reading page over the official shell
 * command label with its OWN viewport, its OWN Find model and a real
 * original-text drag selection.
 *
 * It owns exactly one of each concern: one `ScrollView` (`follow: 'none'`,
 * `primary: true`), one `MouseRegion` as that ScrollView's only child, one
 * {@link JobOutputSearch} over the visible Command text, one selected source
 * range and one short-lived edge auto-scroll timer. It observes no Job, reads no
 * backend, holds no clipboard and creates no second screen: the panel injects
 * `onCopy(text)` and `paintedBox(component)`, so the clipboard stays with the
 * existing `ClientActions.copySelection` capability.
 *
 * The mouse contract is the consumer-layer原文 mapping of plan §4.2: the
 * alt-screen's single native SGR parser dispatches `press/drag/release` into
 * this component, and each event is resolved to a visual row and cell from the
 * LAST PAINTED geometry ({@link TuiApp} passes the alt screen's X054
 * `getPaintedBox`) plus the LIVE `scrollTop` — never from a frozen captured
 * `event.y`, which goes stale as soon as an edge scroll moves the viewport.
 * Grapepheme-aligned offsets then produce ONE `label.slice(start, end)`.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/job-command-reader
 */

import {
  MouseRegion,
  ScrollView,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { highlightColumnRanges, type RenderedColumnHighlight } from '../components/transcript/search-presentation.ts'
import {
  commandRowSelectionColumns,
  commandSelectionRange,
  JobCommandDocument,
  type CommandPoint,
  type CommandVisualLayout,
} from './job-command-document.ts'
import { JobOutputSearch } from './job-output-search.ts'

/** The terminal-native selection presentation: reverse video changes no
 *  visible width and no row count (plan §4.2). */
const SELECTION_STYLE = (text: string): string => `\x1b[7m${text}\x1b[27m`

/** The edge auto-scroll cadence of ONE drag gesture (plan §4.2): a temporary UI
 *  gesture timer, never a second Job refresh/observer. */
const AUTO_SCROLL_MS = 50

/** The painted geometry of one mounted component (the alt screen's X054
 *  read-only query at the frame-painted boundary). */
export interface CommandPaintedBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The opener-injected seams of the Command reader. */
export interface JobCommandReaderIntents {
  /** Repaint through the owning panel/screen. */
  readonly requestRender: () => void
  /** The LAST PAINTED rect of a mounted component, or undefined when it is not
   *  part of the painted frame. */
  readonly paintedBox: (component: Component) => CommandPaintedBox | undefined
  /** The Command Copy seam: the panel forwards it to the app's existing
   *  Client-local clipboard capability. The reader never touches it directly. */
  readonly onCopy: (text: string) => void
  /** Whether the frame grants this Command's SearchRow a row. */
  readonly searchRowVisible: (width: number) => boolean
}

/** The reader's own paint face: the document rows with the Command search
 *  highlight and the selection presentation layered on top, in that order. */
class JobCommandBody implements Component {
  private readonly reader: JobCommandReader

  constructor(reader: JobCommandReader) {
    this.reader = reader
  }

  render(width: number): string[] {
    return this.reader.bodyLines(width)
  }

  invalidate(): void {
    this.reader.invalidate()
  }
}

/**
 * The Command reading page of ONE Job workspace instance.
 */
export class JobCommandReader {
  private readonly document = new JobCommandDocument()
  private readonly searchModel: JobOutputSearch
  private readonly body: JobCommandBody
  private readonly mouseRegion: MouseRegion
  private readonly scrollView: ScrollView
  private readonly intents: JobCommandReaderIntents
  /** The gesture anchor/focus points. They SURVIVE a release so the copied
   *  range stays highlighted; a new press, a source change, a resize, a view
   *  switch or dispose clears them. */
  private anchor: CommandPoint | undefined
  private focus: CommandPoint | undefined
  private gestureActive = false
  /** The pointer position of the LIVE drag: the edge timer re-resolves it
   *  against the CURRENT scrollTop after every auto-scroll step. */
  private pointerX = 0
  private pointerY = 0
  private autoScrollTimer: NodeJS.Timeout | undefined
  private autoScrollDirection: -1 | 1 = 1
  /** The width the CURRENT layout was built at — the ScrollView's own render
   *  width, so the painted rows, the offset resolution and the resize fact all
   *  read the SAME number (0 = no frame laid out yet). */
  private layoutWidth = 0
  private disposedValue = false

  constructor(intents: JobCommandReaderIntents) {
    this.intents = intents
    this.body = new JobCommandBody(this)
    this.mouseRegion = new MouseRegion(this.body, (event) => this.handleMouse(event))
    this.searchModel = new JobOutputSearch(this.document, intents.searchRowVisible, 'Find Command: ')
    // The Command viewport never follows: `Home`/`End`, the wheel and the
    // scrollbar move THIS view, and the Output's own follow intent is untouched.
    this.scrollView = new ScrollView(this.mouseRegion, { follow: 'none', primary: true, scrollbar: 'auto' })
  }

  /** The mounted Command viewport (the ONE primary ScrollView of this view). */
  get scroll(): ScrollView {
    return this.scrollView
  }

  /** The Command-local Find model (its OWN query, epoch and reveal). */
  get search(): JobOutputSearch {
    return this.searchModel
  }

  /** The original label currently laid out (the ONE copy source). */
  get source(): string {
    return this.document.source
  }

  /** Open (or re-open) the Command Find over the existing query. */
  openFind(): void {
    this.searchModel.openFind(this.scrollView.scrollTop)
  }

  /** Leave the Command Find, preserving the query for the next open. */
  exitSearch(): void {
    this.searchModel.exit()
  }

  /** Replace the original Command source. A CHANGED label invalidates any
   *  in-flight or highlighted selection: the old offsets describe other bytes.
   *  An EMPTY label is never a Command source — it clears the reader instead. */
  setSource(label: string): void {
    if (label === '') {
      this.clearSource()
      return
    }
    if (label === this.document.source) {
      this.searchModel.setSource(label, true)
      return
    }
    this.cancelSelection()
    this.document.setSource(label)
    this.searchModel.setSource(label, true)
  }

  /** The Command source no longer exists (kind changed / empty label): drop the
   *  query focus, the selection and the gesture. */
  clearSource(): void {
    this.cancelSelection()
    this.searchModel.exit()
    this.document.setSource('')
    this.searchModel.setSource('', false)
  }

  /** The rendered Command rows of one frame: the document, search-highlighted,
   *  then the selection presentation. Never changes row count or visible
   *  width. */
  bodyLines(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    // A width change re-wraps every row: no old column/offset mapping survives, so
    // the selection is dropped BEFORE this frame's rows are built — the frame that
    // notices the change is already the frame that paints the cleared highlight.
    if (this.layoutWidth !== 0 && this.layoutWidth !== safeWidth) this.cancelSelection()
    this.layoutWidth = safeWidth
    const layout = this.document.layoutAt(safeWidth)
    const lines = this.searchModel.bodyLines(safeWidth)
    const range = this.selectionRange()
    if (range === undefined) return lines
    const ranges = new Map<number, RenderedColumnHighlight[]>()
    for (let row = 0; row < layout.rows.length; row += 1) {
      const columns = commandRowSelectionColumns(layout, row, range.start, range.end)
      if (columns === undefined) continue
      ranges.set(row, [{
        range: { startCol: columns.startCol, endCol: columns.endCol },
        style: SELECTION_STYLE,
      }])
    }
    return ranges.size === 0 ? lines : highlightColumnRanges(lines, ranges)
  }

  invalidate(): void {
    this.document.invalidate()
  }

  /** Cancel an in-flight or highlighted selection and stop the edge timer.
   *  Returns whether there was anything to cancel. */
  cancelSelection(): boolean {
    const had = this.anchor !== undefined || this.focus !== undefined || this.gestureActive
    this.anchor = undefined
    this.focus = undefined
    this.gestureActive = false
    this.stopAutoScroll()
    return had
  }

  dispose(): void {
    if (this.disposedValue) return
    this.disposedValue = true
    this.cancelSelection()
    this.scrollView.dispose()
  }

  /** The layout every offset is resolved against: the ONE the painted rows were
   *  built from. */
  private layout(): CommandVisualLayout {
    return this.document.layoutAt(this.layoutWidth)
  }

  /** The single `label.slice(start, end)` of the current selection. */
  private selectionRange(): { readonly start: number; readonly end: number } | undefined {
    const anchor = this.anchor
    const focus = this.focus
    if (anchor === undefined || focus === undefined) return undefined
    return commandSelectionRange(this.layout(), anchor, focus)
  }

  /**
   * The ONE Command mouse handler (plan §4.2). Wheel events are deliberately
   * UNHANDLED so the fork's own wheel routing scrolls this viewport; presses
   * capture the gesture, drags extend it with edge auto-scroll, and a release
   * copies the captured original range synchronously (a click copies nothing).
   */
  private handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposedValue) return undefined
    // The fork owns the wheel: an unhandled wheel keeps scrolling the primary
    // Command viewport through the alt screen's native route.
    if (event.type === 'wheel' || event.type === 'move' || event.type === 'click') return undefined
    const viewport = this.intents.paintedBox(this.scrollView)
    if (viewport === undefined) return undefined
    if (event.type === 'press' && event.button !== 'left') return undefined
    if (event.type !== 'press' && !this.gestureActive) return { handled: true, render: false }
    const layout = this.layout()
    const pointer = {
      row: this.contentRow(event.screenY, viewport, layout.rows.length),
      col: this.contentColumn(event.screenX, viewport),
    }
    this.pointerX = event.screenX
    this.pointerY = event.screenY
    if (event.type === 'press') {
      this.gestureActive = true
      this.anchor = pointer
      this.focus = pointer
      // A press only anchors: the edge timer starts once the gesture has really
      // dragged (plan §6 rule 1).
      this.stopAutoScroll()
      this.intents.requestRender()
      return { handled: true, capture: true, render: false }
    }
    this.focus = pointer
    if (event.type === 'drag') {
      this.updateAutoScroll(viewport, layout.rows.length)
      this.intents.requestRender()
      return { handled: true, capture: true, render: true }
    }
    // RELEASE: capture the payload SYNCHRONOUSLY from the range the gesture
    // selected; the async clipboard settlement downstream never recomputes it.
    this.gestureActive = false
    this.stopAutoScroll()
    const range = this.selectionRange()
    this.intents.requestRender()
    if (range === undefined) return { handled: true, render: false }
    const text = this.document.source.slice(range.start, range.end)
    if (text === '') return { handled: true, render: false }
    this.intents.onCopy(text)
    return { handled: true, render: true }
  }

  /** The visual row under a screen row, clamped to the VISIBLE band: a pointer
   *  outside the body selects to the body's own edge row, and the edge timer then
   *  scrolls more content in. It never jumps to an off-screen document row — the
   *  selection can only ever grow over rows the user actually saw. */
  private contentRow(screenY: number, viewport: CommandPaintedBox, rowCount: number): number {
    const top = this.scrollView.scrollTop
    const bottom = Math.max(top, Math.min(rowCount - 1, top + Math.max(1, viewport.height) - 1))
    return Math.max(top, Math.min(bottom, screenY - viewport.y + top))
  }

  /** The content cell under a screen column, excluding a VISIBLE scrollbar
   *  column (the fork's scrollbar interaction owns that cell). */
  private contentColumn(screenX: number, viewport: CommandPaintedBox): number {
    const contentWidth = Math.max(
      1,
      this.scrollView.getContentWidth(viewport.width) - (this.scrollView.isScrollbarVisible ? 1 : 0),
    )
    return Math.max(0, Math.min(contentWidth - 1, screenX - viewport.x))
  }

  /** Start/stop/redirect the ONE edge auto-scroll timer (plan §6): a press only
   *  anchors (it never starts a timer), and once the gesture has really DRAGGED,
   *  reaching the body's visible FIRST or LAST row — or leaving the body
   *  entirely — starts the matching direction. The timer re-resolves the pointer
   *  against the CURRENT scrollTop after every step, stops as soon as the
   *  viewport cannot move further, and belongs to this gesture alone. */
  private updateAutoScroll(viewport: CommandPaintedBox, rowCount: number): void {
    const height = Math.max(1, viewport.height)
    const above = this.pointerY < viewport.y
    const below = this.pointerY >= viewport.y + height
    let direction: -1 | 1 | undefined
    if (above) direction = -1
    else if (below) direction = 1
    else if (height > 1) {
      // Inside the body only the extreme VISIBLE rows are edges. A one-row
      // viewport has no distinct edges, so the same cell can never imply both
      // directions: it scrolls only when the pointer clearly leaves the body.
      const row = this.pointerY - viewport.y
      if (row <= 0) direction = -1
      else if (row >= height - 1) direction = 1
    }
    if (direction === undefined) {
      this.stopAutoScroll()
      return
    }
    if (this.autoScrollTimer !== undefined && this.autoScrollDirection === direction) return
    this.stopAutoScroll()
    this.autoScrollDirection = direction
    const step = direction
    const timer = setInterval(() => {
      if (this.disposedValue || !this.gestureActive) {
        this.stopAutoScroll()
        return
      }
      // A tick that cannot move the real viewport must stop the timer instead of
      // looping forever at the document boundary.
      if (this.scrollView.scrollBy(step) !== 0) {
        this.stopAutoScroll()
        return
      }
      // The painted viewport may have moved (a chrome row appeared): re-read it
      // instead of trusting the box captured when the drag started.
      const fresh = this.intents.paintedBox(this.scrollView) ?? viewport
      this.focus = {
        row: this.contentRow(this.pointerY, fresh, rowCount),
        col: this.contentColumn(this.pointerX, fresh),
      }
      this.intents.requestRender()
    }, AUTO_SCROLL_MS)
    timer.unref?.()
    this.autoScrollTimer = timer
  }

  private stopAutoScroll(): void {
    if (this.autoScrollTimer === undefined) return
    clearInterval(this.autoScrollTimer)
    this.autoScrollTimer = undefined
  }
}
