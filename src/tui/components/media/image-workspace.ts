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
 * Esc is a two-level journey: `Esc back` in the Viewer returns to the SAME
 * list instance (selection preserved), `Esc close` on the list closes the
 * workspace. A Viewer opened directly from a transcript click has no list
 * below and advertises `Esc close`.
 *
 * iTerm2 is deliberately scoped down in this PR2 (Owner decision): the
 * pinned AltScreen disables the iTerm2 image capability and its cursor-up
 * framing is not understood by the fork's ANSI width layer, so the Viewer
 * shows the real metadata and `Preview unavailable`; native iTerm2 pixels are
 * deferred to separate fork/protocol work. Kitty renders the fitted image.
 * @module @xmoon76/dsh-pi-tui/tui/components/media/image-workspace
 */

import { Key, getKeybindings, matchesKey } from '@xmoon76/pi-tui'
import type { Component } from '@xmoon76/pi-tui'
import { SearchablePicker } from '../../pickers/searchable-picker.ts'
import { color, selectListTheme } from '../../theme/runtime.ts'
import { formatKeyId } from '../../keybindings/hints.ts'
import { renderActionBarRow, type ActionBarSegment } from '../../presentation/action-bar.ts'
import type { ImageAttachmentRefLike } from '../../../domain/media/types.ts'
import type { ImageLoader } from '../../../client/media/image/loader.ts'
import { ImageViewerPanel } from './image-viewer.ts'

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
  readonly requestRender: () => void
  readonly loader?: ImageLoader
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
  /** `list` starts on the picker; `viewer` starts on a direct occurrence. */
  readonly initial:
    | { readonly kind: 'list' }
    | { readonly kind: 'viewer'; readonly source: ImageWorkspaceSource }
}

/** The leased screen root: list state OR viewer state, never both rendered. */
export class ImageWorkspacePanel implements Component {
  private readonly input: ImageWorkspaceInput
  /** The list instance is retained across a Viewer round trip so Esc returns
   * to the exact same selection. */
  private readonly picker: SearchablePicker | undefined
  private viewPanel: ImageViewerPanel | undefined
  private mode: 'list' | 'viewer'

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
    } else {
      this.mode = 'viewer'
      this.picker = undefined
      this.showViewer(input.initial.source, false)
    }
  }

  invalidate(): void {
    this.picker?.invalidate()
    this.viewPanel?.invalidate()
  }

  dispose(): void {
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
    const rows = Math.max(1, Math.floor(this.input.rows()))
    if (this.mode === 'list' && this.picker !== undefined) {
      // The bar is ALWAYS the last physical row: grant the grid everything
      // above it, then pad the grid so a short candidate list cannot leave the
      // bar floating in the middle of the screen.
      const bar = this.listBar(width)
      const gridRows = Math.max(0, rows - 1)
      this.picker.setMaxRows(gridRows)
      const grid = this.picker.render(width).slice(0, gridRows)
      const padded = grid.length >= gridRows
        ? grid
        : [...grid, ...Array.from({ length: gridRows - grid.length }, () => '')]
      return rows === 1 ? [bar] : [...padded, bar]
    }
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
   * - **Degradation is whole-segment** (§7.2). `renderActionBarRow` compacts a
   *   segment that declares a `short` form, then drops whole segments by
   *   ascending priority — never a mid-word cut. `Esc` closes the workspace, so
   *   it carries the highest priority and survives to the narrowest width.
   */
  private listBar(width: number): string {
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
    const segments: ActionBarSegment[] = []
    if (navigate !== '') segments.push({ text: `${navigate} navigate`, short: navigate, priority: 4 })
    if (confirm !== '') segments.push({ text: `${confirm} view`, short: confirm, priority: 6 })
    segments.push({
      text: cancel === '' ? 'Esc close' : `${cancel} close`,
      short: cancel === '' ? 'Esc' : cancel,
      priority: 8,
    })
    return color.textDim(renderActionBarRow(segments, Math.max(1, width)))
  }

  /** Create the Viewer state. `fromList` keeps the list (and its selection)
   * alive below, so Esc returns there; a direct open advertises `Esc close`. */
  private showViewer(source: ImageWorkspaceSource, fromList: boolean): void {
    this.viewPanel?.dispose()
    this.viewPanel = new ImageViewerPanel({
      ref: source.ref,
      scope: source.scope,
      ...(this.input.loader === undefined ? {} : { loader: this.input.loader }),
      theme: this.input.theme,
      requestRender: this.input.requestRender,
      onClose: fromList ? () => this.backToList() : () => this.input.onClose(),
      closeHint: fromList ? 'back' : 'close',
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
    this.viewPanel?.dispose()
    this.viewPanel = undefined
    this.mode = 'list'
    this.input.requestRender()
  }
}
