/**
 * The Image UX PR2 image workspace: ONE leased fullscreen screen with two
 * internal states.
 *
 * - LIST: the current mounted transcript window's image occurrences as a
 *   `SearchablePicker` (no full-text search; ↑/↓/Enter/Esc).
 * - VIEWER: the read-only large-image panel for the selected occurrence.
 *
 * WHY A SCREEN, NOT AN OVERLAY (Owner decision, 2026-10-24): the pinned
 * pi-tui overlay compositor drops any row whose BASE is an inline image line
 * (`compositeTuiLine` returns the base line unchanged), so a framed overlay
 * cannot reliably paint the image or cover the transcript image rows behind
 * it. The workspace renders on its own temporary alt screen — the exact
 * physical-screen lease the Settings and Job workspaces already use — where
 * the image is an ordinary BASE line and the proven `Image` path applies.
 * The screen is full-width and vertical; it never re-composites an image row
 * through a horizontal overlay compositor.
 *
 * Esc is a two-level journey: `Back [Esc]` in the Viewer returns to the SAME
 * list instance (selection preserved), `Close [Esc]` on the list closes the
 * workspace. A Viewer opened directly from a transcript click has no list
 * below and advertises `Close [Esc]`. Both painted spans are pointer targets.
 *
 * iTerm2 is deliberately scoped down in this PR2 (Owner decision): the
 * pinned AltScreen disables the iTerm2 image capability and its cursor-up
 * framing is not understood by the fork's ANSI width layer, so the Viewer
 * shows the real metadata and `Preview unavailable`; native iTerm2 pixels are
 * deferred to separate fork/protocol work. Kitty renders the fitted image.
 * @module @xmoon76/dsh-pi-tui/tui/components/media/image-workspace
 */

import { Key, getKeybindings, matchesKey, visibleWidth } from '@xmoon76/pi-tui'
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@xmoon76/pi-tui'
import { SearchablePicker } from '../../pickers/searchable-picker.ts'
import { color, selectListTheme } from '../../theme/runtime.ts'
import { formatKeyId } from '../../keybindings/hints.ts'
import { ACTION_BAR_SEPARATOR, layoutActionBarRow, type ActionBarSegment } from '../../presentation/action-bar.ts'
import type { ImageAttachmentRefLike } from '../../../domain/media/types.ts'
import type { ImageLoader } from '../../../client/media/image/loader.ts'
import type { SvgRasterLoader } from '../../../client/media/svg/raster-loader.ts'
import type { ImageGraphics } from '../../graphics/native-image.ts'
import type { ImageProtocolPreference } from '../../graphics/image-protocol-preference.ts'
import { ImageViewerPanel } from './image-viewer.ts'
import { SvgViewerPanel, type SvgViewerSource } from './svg-viewer.ts'

/** The immutable read source of one selected occurrence (resolved against the
 * CURRENT mounted batch by the app owner at selection time). */
export interface ImageWorkspaceSource {
  readonly ref: ImageAttachmentRefLike
  readonly scope: unknown
}

/** One label of the image list. The value is a transient list identity only;
 * the app's `resolve` maps it back to the live occurrence. */
export interface ImageWorkspaceCandidate {
  readonly value: string
  readonly label: string
}

export interface ImageWorkspaceInput {
  /** Current terminal rows (re-read every paint; the screen is responsive). */
  readonly rows: () => number
  /** Current terminal columns (the SVG Viewer's stale-geometry fence). */
  readonly columns?: () => number
  readonly requestRender: () => void
  readonly loader?: ImageLoader
  /** PR2.5: the ONE shared SVG raster cache (a `svg-viewer` state only). */
  readonly svgLoader?: SvgRasterLoader
  /** The ONE managed graphics owner of this physical terminal (Image-7A). */
  readonly graphics?: ImageGraphics
  /** The app's ONE startup image-protocol preference. */
  readonly imageProtocolPreference?: ImageProtocolPreference
  readonly theme: { fallbackColor(text: string): string }
  /** The mounted-window candidate snapshot, in projection order. */
  readonly candidates: readonly ImageWorkspaceCandidate[]
  /**
   * Resolve a list value to its CURRENT occurrence source. `undefined` means
   * the candidate left the mounted window: the workspace closes and the owner
   * reports it — it never re-authorizes a retired read scope.
   */
  readonly resolve: (value: string) => ImageWorkspaceSource | undefined
  /** A selected candidate is no longer part of the current mounted batch. */
  readonly onStale: () => void
  /** Close the whole workspace (list Esc, or the direct Viewer's Esc). */
  readonly onClose: () => void
  /** `list` starts on the picker; `viewer` starts on a direct occurrence;
   *  `svg-viewer` is the same leased screen's read-only SVG page set. */
  readonly initial:
    | { readonly kind: 'list' }
    | { readonly kind: 'viewer'; readonly source: ImageWorkspaceSource }
    | { readonly kind: 'svg-viewer'; readonly source: SvgViewerSource }
}

/** The complete painted LIST-bar action of the LAST frame. `value` is the
 *  selected picker identity the `View` action was painted for. */
type ImageListBarAction = 'view' | 'close'

interface ImageListBarHit {
  readonly action: ImageListBarAction
  readonly value: string | null
  readonly row: number
  readonly startCol: number
  readonly endCol: number
}

/** The ONE pointer gesture this screen root may still complete. A click is
 *  accepted only while the LAST-painted frame re-resolves the SAME target on
 *  the SAME cells/grant: a View↔Viewer transition, a resize, a repaint that
 *  moves or drops the segment, or a selection change revokes it. */
type ImageWorkspaceGesture =
  | {
      readonly kind: 'list-bar'
      readonly action: ImageListBarAction
      readonly value: string | null
      readonly row: number
      readonly startCol: number
      readonly endCol: number
      readonly width: number
      readonly height: number
    }
  | {
      readonly kind: 'viewer-exit'
      /** The exact Viewer instance that painted the span (a replaced Viewer
       *  can never inherit the old press). */
      readonly viewer: ImageViewerPanel
      readonly row: number
      readonly startCol: number
      readonly endCol: number
      readonly width: number
      readonly height: number
    }

/** The leased screen root: list state OR viewer state, never both rendered. */
export class ImageWorkspacePanel implements Component {
  private readonly input: ImageWorkspaceInput
  /** The list instance is retained across a Viewer round trip so Esc returns
   * to the exact same selection. */
  private readonly picker: SearchablePicker | undefined
  private viewPanel: ImageViewerPanel | SvgViewerPanel | undefined
  private mode: 'list' | 'viewer'
  /** The width the last paint granted (the Viewer's fallback column read). */
  private lastWidth = 1
  /** The height the last paint returned (last-painted geometry fence). */
  private lastRows = 1
  /** The clickable LIST-bar cells of the LAST paint. */
  private listBarHits: readonly ImageListBarHit[] = []
  /** Whether the LAST paint really granted the picker any rows (a 1-row
   *  screen paints only the bar: its keys must not act on an invisible row). */
  private listGridPainted = false
  /** The one press this root is still allowed to complete. */
  private gesture: ImageWorkspaceGesture | undefined

  constructor(input: ImageWorkspaceInput) {
    this.input = input
    if (input.initial.kind === 'list') {
      this.mode = 'list'
      this.picker = new SearchablePicker(
        input.candidates.map(candidate => ({ ...candidate })),
        10,
        selectListTheme,
        {},
        {
          enableSearch: false,
          header: 'Images · current transcript',
          // The LIST paints its own pinned bottom bar below (the grid must
          // FILL the grant so the bar lands on the last physical row); the
          // picker's floating hint would sit right under the last candidate.
          showHint: false,
        },
      )
      this.picker.onSelect = (item): void => {
        const source = input.resolve(item.value)
        if (source === undefined) {
          input.onStale()
          return
        }
        this.showViewer(source, true)
      }
      this.picker.onCancel = (): void => input.onClose()
      // The list's selection is painted state: keyboard navigation must
      // repaint it (the host ladder consumes the key and calls this panel
      // directly, so the fork's own post-input repaint never runs).
      this.picker.onSelectionChange = (): void => input.requestRender()
    } else if (input.initial.kind === 'svg-viewer') {
      this.mode = 'viewer'
      this.picker = undefined
      this.showSvgViewer(input.initial.source)
    } else {
      this.mode = 'viewer'
      this.picker = undefined
      this.showViewer(input.initial.source, false)
    }
  }

  /**
   * The screen root's ONE pointer entry. LIST delegates row events to the
   * picker it owns (so the picker's last-painted hit map and pressed-value
   * latch stay the single row authority) and resolves the pinned bar's
   * complete action spans itself; the raster Viewer resolves only its complete
   * painted exit span. The SVG Viewer keeps its historical
   * `onCellPress`/`onCellClick` route: this handler stays out of its way so a
   * press is never dispatched twice.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Every left press starts a fresh gesture, and a click consumes the one
    // the press armed — captured BEFORE the latch is cleared, so the click
    // can still prove its press. A rejected event also ends the old gesture.
    const clicked = event.type === 'click' ? this.gesture : undefined
    if (event.type === 'click' || (event.type === 'press' && event.button === 'left')) {
      this.gesture = undefined
    }
    if (this.mode === 'list') {
      const pickerResult = this.listGridPainted ? this.picker?.handleMouse(event) : undefined
      if (pickerResult !== undefined) return pickerResult
      return this.handleListBarMouse(event, clicked)
    }
    const panel = this.viewPanel
    if (!(panel instanceof ImageViewerPanel)) return undefined
    return this.handleViewerMouse(event, panel, clicked)
  }

  /** Forward one pointer press to the active SVG Viewer (its legacy entry). */
  onCellPress(x: number, y: number): void {
    if (this.mode !== 'viewer') return
    if (this.viewPanel instanceof SvgViewerPanel) this.viewPanel.onCellPress(x, y)
  }

  /** Forward one pointer release to the active SVG Viewer (its legacy entry). */
  onCellClick(x: number, y: number): void {
    if (this.mode !== 'viewer') return
    if (this.viewPanel instanceof SvgViewerPanel) this.viewPanel.onCellClick(x, y)
  }

  private handleListBarMouse(
    event: TuiMouseEvent,
    pressed: ImageWorkspaceGesture | undefined,
  ): TuiMouseEventResult | undefined {
    if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) return undefined
    if (event.width !== this.lastWidth || event.height !== this.lastRows) return undefined
    const hit = this.listBarHits.find(candidate =>
      candidate.row === event.y && event.x >= candidate.startCol && event.x < candidate.endCol)
    if (hit === undefined) return undefined
    if (event.type === 'press') {
      if (hit.action === 'view' && hit.value === null) return undefined
      this.gesture = {
        kind: 'list-bar',
        action: hit.action,
        value: hit.value,
        row: hit.row,
        startCol: hit.startCol,
        endCol: hit.endCol,
        width: event.width,
        height: event.height,
      }
      return { handled: true }
    }
    if (pressed?.kind !== 'list-bar') return undefined
    // Re-resolve the action against the LAST paint, never the pressed object:
    // a repaint that moved/removed the segment or changed the selection makes
    // the release inert.
    if (pressed.action !== hit.action
      || pressed.value !== hit.value
      || pressed.row !== event.y
      || pressed.startCol !== hit.startCol
      || pressed.endCol !== hit.endCol
      || pressed.width !== event.width
      || pressed.height !== event.height) return undefined
    if (hit.action === 'close') {
      this.input.onClose()
      return { handled: true }
    }
    const selected = this.picker?.paintedSelectedItem()
    if (selected === null || selected === undefined || selected.value !== hit.value) return undefined
    // Delegate to the SAME picker selection entry (`input.resolve` still proves
    // the live occurrence), never a second viewer lifecycle.
    this.picker?.onSelect?.(selected)
    return { handled: true }
  }

  private handleViewerMouse(
    event: TuiMouseEvent,
    panel: ImageViewerPanel,
    pressed: ImageWorkspaceGesture | undefined,
  ): TuiMouseEventResult | undefined {
    if (event.button !== 'left' || (event.type !== 'press' && event.type !== 'click')) return undefined
    if (event.width !== this.lastWidth || event.height !== this.lastRows) return undefined
    const hit = panel.paintedExitHit()
    if (hit === undefined || hit.width !== event.width || hit.rows !== event.height) return undefined
    if (event.y !== hit.row || event.x < hit.startCol || event.x >= hit.endCol) return undefined
    if (event.type === 'press') {
      this.gesture = {
        kind: 'viewer-exit',
        viewer: panel,
        row: hit.row,
        startCol: hit.startCol,
        endCol: hit.endCol,
        width: event.width,
        height: event.height,
      }
      return { handled: true }
    }
    if (pressed?.kind !== 'viewer-exit' || pressed.viewer !== panel) return undefined
    // The same Viewer instance must still paint the SAME complete exit span of
    // the SAME grant; the Back/Close span keeps its one immutable callback.
    if (pressed.row !== hit.row
      || pressed.startCol !== hit.startCol
      || pressed.endCol !== hit.endCol
      || pressed.width !== event.width
      || pressed.height !== event.height) return undefined
    panel.requestClose()
    return { handled: true }
  }

  invalidate(): void {
    // An invalidation revokes the frame-bound pointer authority: the cached
    // paint is no longer the frame the next event may act on, so an armed press
    // or a stale bar hit must not complete before the next render rebuilds
    // them. (The Viewer's own `invalidate` drops its painted exit span.)
    this.gesture = undefined
    this.listBarHits = []
    this.listGridPainted = false
    this.picker?.invalidate()
    this.viewPanel?.invalidate()
  }

  dispose(): void {
    // Teardown owns the screen gesture: no press may survive the lease.
    this.gesture = undefined
    this.listBarHits = []
    this.listGridPainted = false
    this.viewPanel?.dispose()
    this.viewPanel = undefined
  }

  handleInput(data: string): void {
    if (this.mode === 'list') {
      // A FIXED Esc fallback, not an alternative binding: `KeybindingsManager`
      // accepts an EMPTY key list, so `tui.select.cancel` can legally resolve to
      // no keys at all. The picker only calls `onCancel` when its binding
      // matches, so without this the workspace would have NO close route while
      // the bar advertised one. A user's own cancel binding keeps priority —
      // this fires only when no cancel key is bound.
      if (!this.cancelBound() && matchesKey(data, Key.escape)) {
        this.input.onClose()
        return
      }
      this.picker?.handleInput(data)
      return
    }
    this.viewPanel?.handleInput(data)
  }

  render(width: number): string[] {
    this.lastWidth = Math.max(1, Math.floor(width))
    const rows = Math.max(1, Math.floor(this.input.rows()))
    this.lastRows = rows
    if (this.mode === 'list' && this.picker !== undefined) {
      // The bar is ALWAYS the last physical row: grant the grid everything
      // above it, then pad the grid so a short candidate list cannot leave the
      // bar floating in the middle of the screen. The grid is painted BEFORE
      // the bar is laid out, so the bar's View target resolves against THIS
      // frame's picker hit map (never a previous frame's selection).
      const gridRows = Math.max(0, rows - 1)
      this.listGridPainted = gridRows > 0
      let grid: string[] = []
      if (gridRows > 0) {
        this.picker.setMaxRows(gridRows)
        grid = this.picker.render(width).slice(0, gridRows)
      }
      const bar = this.listBar(width, this.listGridPainted)
      this.listBarHits = bar.hits
      const padded = grid.length >= gridRows
        ? grid
        : [...grid, ...Array.from({ length: gridRows - grid.length }, () => '')]
      return rows === 1 ? [bar.line] : [...padded, bar.line]
    }
    this.listBarHits = []
    const panel = this.viewPanel
    if (panel === undefined) return []
    panel.setMaxRows(rows)
    return panel.render(width).slice(0, rows)
  }

  /** Whether the list's cancel action has ANY live key. `KeybindingsManager`
   * accepts an empty list, so this is a reachable state, not a defensive check:
   * the handler and the bar read this ONE predicate, so the advertisement can
   * never disagree with what actually closes the workspace. */
  private cancelBound(): boolean {
    return getKeybindings().getKeys('tui.select.cancel').length > 0
  }

  /**
   * The list state's pinned action bar.
   *
   * Two rules from design-language §7 govern this row and neither is optional:
   *
   * - **The advertised keys are the LIVE ones.** `SearchablePicker` matches
   *   `tui.select.*` through `getKeybindings()`, so the bar reads the SAME
   *   binding source. A hard-coded `Enter`/`Esc` would start lying the moment a
   *   user remaps the action.
   * - **Degradation is whole-segment** (§7.2). `layoutActionBarRow` compacts a
   *   segment that declares a `short` form, then drops whole segments by
   *   ascending priority — never a mid-word cut. `Esc` closes the workspace, so
   *   it carries the highest priority and survives to the narrowest width.
   *
   * The complete `View`/`Close` spans are the list's only pointer targets. The
   * `View` target exists only while the LAST picker paint really drew the
   * selected row (a hidden selection is not a visible action), and a segment
   * the layout had to COMPACT is a truthful hint but no longer a complete span,
   * so it publishes no hit either.
   */
  private listBar(width: number, listPainted: boolean): { line: string; hits: readonly ImageListBarHit[] } {
    const keybindings = getKeybindings()
    const primary = (action: 'tui.select.up' | 'tui.select.down' | 'tui.select.confirm' | 'tui.select.cancel'): string => {
      const key = keybindings.getKeys(action)[0]
      return key === undefined ? '' : formatKeyId(key)
    }
    const vertical = primary('tui.select.up')
    const down = primary('tui.select.down')
    const navigate = vertical === '' || down === '' ? '' : `${vertical}/${down}`
    const confirm = primary('tui.select.confirm')
    // When the cancel action has no key at all, the FIXED Esc fallback in
    // `handleInput` is what closes the workspace — so that is what the bar
    // advertises. Both sides read `cancelBound()`, so the hint cannot promise a
    // key that does nothing (and cannot hide a route that does work).
    const cancel = this.cancelBound() ? primary('tui.select.cancel') : ''
    const selected = listPainted ? this.picker?.paintedSelectedItem() ?? null : null
    const segments: ActionBarSegment[] = []
    const actions = new Map<number, { action: ImageListBarAction; value: string | null; fullText: string }>()
    if (navigate !== '') segments.push({ text: `${navigate} navigate`, short: navigate, priority: 4 })
    if (selected !== null) {
      const text = confirm === '' ? 'View' : `View [${confirm}]`
      actions.set(segments.length, { action: 'view', value: selected.value, fullText: text })
      segments.push({ text, short: 'View', priority: 6 })
    } else if (confirm !== '') {
      // No painted selection: keep the historical keyboard hint, but it is
      // chrome, never a target.
      segments.push({ text: `${confirm} view`, short: confirm, priority: 6 })
    }
    const closeText = cancel === '' ? 'Close [Esc]' : `Close [${cancel}]`
    actions.set(segments.length, { action: 'close', value: null, fullText: closeText })
    segments.push({ text: closeText, short: 'Close', priority: 8 })

    const layout = layoutActionBarRow(segments, Math.max(1, width))
    if (layout.truncated || layout.spans.length === 0) {
      return { line: color.textDim(layout.text), hits: [] }
    }
    const hits: ImageListBarHit[] = []
    const painted = layout.spans.map(span => {
      const target = actions.get(span.inputIndex)
      if (target === undefined) return color.textMuted(span.text)
      if (span.text === target.fullText) {
        hits.push({
          action: target.action,
          value: target.value,
          row: this.lastRows - 1,
          startCol: span.startCol,
          endCol: span.endCol,
        })
      }
      // The Image workspace is NOT one of the Owner-scoped DENSE Action Bars
      // (design-language §7.1): its affordances keep Role 14 `primary`, next to
      // the muted browsing hints.
      return color.primary(span.text)
    })
    const segmentWidth = layout.spans.reduce((sum, span) => sum + visibleWidth(span.text), 0)
      + Math.max(0, layout.spans.length - 1) * visibleWidth(ACTION_BAR_SEPARATOR)
    const padding = Math.max(0, visibleWidth(layout.text) - segmentWidth)
    const line = painted.join(color.textMuted(ACTION_BAR_SEPARATOR)) + ' '.repeat(padding)
    return { line, hits }
  }

  /** Create the Viewer state. `fromList` keeps the list (and its selection)
   * alive below, so Esc returns there; a direct open advertises `Close [Esc]`. */
  private showViewer(source: ImageWorkspaceSource, fromList: boolean): void {
    // A View/Close press belongs to the state that painted it: the new Viewer
    // must never inherit a release from the list bar.
    this.gesture = undefined
    this.listBarHits = []
    this.viewPanel?.dispose()
    this.viewPanel = new ImageViewerPanel({
      ref: source.ref,
      scope: source.scope,
      ...(this.input.loader === undefined ? {} : { loader: this.input.loader }),
      theme: this.input.theme,
      requestRender: this.input.requestRender,
      onClose: fromList ? () => this.backToList() : () => this.input.onClose(),
      closeHint: fromList ? 'back' : 'close',
      ...(this.input.graphics === undefined ? {} : { graphics: this.input.graphics }),
      ...(this.input.imageProtocolPreference === undefined
        ? {}
        : { imageProtocolPreference: this.input.imageProtocolPreference }),
    })
    this.mode = 'viewer'
    this.input.requestRender()
  }

  /** Create the read-only SVG Viewer inside THIS workspace lease. */
  private showSvgViewer(source: SvgViewerSource): void {
    this.gesture = undefined
    this.listBarHits = []
    this.viewPanel?.dispose()
    this.viewPanel = new SvgViewerPanel({
      source,
      rows: () => this.input.rows(),
      columns: () => this.input.columns?.() ?? this.lastWidth,
      requestRender: () => this.input.requestRender(),
      ...(this.input.svgLoader === undefined ? {} : { loader: this.input.svgLoader }),
      theme: this.input.theme,
      onClose: () => this.input.onClose(),
      ...(this.input.graphics === undefined ? {} : { graphics: this.input.graphics }),
      ...(this.input.imageProtocolPreference === undefined
        ? {}
        : { imageProtocolPreference: this.input.imageProtocolPreference }),
    })
    this.mode = 'viewer'
    this.input.requestRender()
  }

  /** Return from the Viewer to the SAME list state (selection preserved). */
  private backToList(): void {
    if (this.picker === undefined) {
      this.input.onClose()
      return
    }
    // A Viewer exit press is dead the moment the list is back: its old cell
    // must never complete against the restored list.
    this.gesture = undefined
    this.viewPanel?.dispose()
    this.viewPanel = undefined
    this.mode = 'list'
    this.input.requestRender()
  }
}
