/**
 * The tmux virtual Kitty component and its per-terminal factory (Image-7B-A).
 *
 * `TmuxKittyImage` is a real text component: it emits ONE virtual placement
 * anchor (`U=1`) on the first row and a full `U+10EEEE` placeholder grid on
 * every row, so the image participates in the terminal's ordinary text layout.
 * Unlike the Native component it does NOT register fork placement metadata:
 * that table crops a cursor-positioned pixel rectangle, while the virtual image
 * is cropped by the text cells themselves.
 *
 * The factory is the ONLY way to construct this backend. It probes the real
 * tmux server before it creates a Core, and every render re-checks the live
 * admission before it returns cached placeholder bytes.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/tmux-image
 */

import { getCellDimensions, type Component, type Terminal } from '@xmoon76/pi-tui'
import {
  KittyGraphicsCore,
  type KittyGraphicsCoreOptions,
  type KittyImage,
  type KittyImageSource,
} from './kitty-core.ts'
import { calculateNativeCellSize } from './kitty-native.ts'
import type { KittyGraphics, NativeKittyImageBody, NativeKittyImageOptions } from './native-image.ts'
import { KittyTerminalFacade } from './kitty-terminal.ts'
import { TmuxKittyAdmission, probeTmuxKittyIdentity } from './tmux-admission.ts'
import {
  KITTY_VIRTUAL_GRID_MARKER,
  KITTY_VIRTUAL_MAX_CELLS,
  encodeKittyPlaceholderGrid,
  encodeKittyVirtualPlacement,
} from './tmux-virtual.ts'

/** The private provenance prefix shared with the fork layout (X067). */
const MANAGED_VIRTUAL_MARKER_PREFIX = '\x1b_pi:tmux-image:v1:i='
const MANAGED_VIRTUAL_MARKER_TERMINATOR = '\x1b\\'

/** Encode the zero-width provenance marker for ONE live Core handle. */
function encodeManagedVirtualMarker(imageId: number, placementId: number): string {
  return `${MANAGED_VIRTUAL_MARKER_PREFIX}${imageId},p=${placementId}${MANAGED_VIRTUAL_MARKER_TERMINATOR}`
}

/**
 * One occurrence's tmux virtual Kitty body.
 *
 * The stable Core handle lives until `dispose()`: `invalidate()` only drops the
 * painted lines, and a width/theme repaint re-places the SAME image id. The
 * cache is checked AFTER the live admission, so a revoked handle can never
 * return previously cached placeholder rows.
 */
export class TmuxKittyImage implements Component {
  private readonly core: KittyGraphicsCore
  private readonly source: KittyImageSource
  private readonly options: NativeKittyImageOptions
  private readonly admission: TmuxKittyAdmission
  private handle: KittyImage | undefined
  private cachedLines: string[] | undefined
  private cachedWidth: number | undefined
  private paintedBody: NativeKittyImageBody | undefined

  constructor(
    core: KittyGraphicsCore,
    source: KittyImageSource,
    options: NativeKittyImageOptions,
    admission: TmuxKittyAdmission,
  ) {
    this.core = core
    this.source = source
    this.options = options
    this.admission = admission
  }

  /** The real painted footprint at `width`, or undefined when no pixels were
   *  painted (revoked admission, budget fallback or an empty source). */
  paintedBodyAt(width: number): NativeKittyImageBody | undefined {
    const body = this.paintedBody
    return body !== undefined && body.width === width ? body : undefined
  }

  /** The Core image id this occurrence owns, once it was painted. */
  get imageId(): number | undefined {
    return this.handle?.imageId
  }

  render(width: number): string[] {
    // The admission check comes BEFORE the cache: within the short TTL this is
    // one real probe per frame at most, and after revocation no cached
    // placeholder bytes may be returned again.
    if (!this.admission.isAllowed(false)) {
      this.cachedLines = undefined
      this.cachedWidth = undefined
      this.paintedBody = undefined
      return [this.options.fallback]
    }
    if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines
    const lines = this.paint(width)
    this.cachedLines = lines
    this.cachedWidth = width
    return lines
  }

  invalidate(): void {
    // The handle survives: a theme/width repaint re-places the same image.
    this.cachedLines = undefined
    this.cachedWidth = undefined
    this.paintedBody = undefined
  }

  dispose(): void {
    if (this.handle !== undefined) this.core.retire(this.handle)
    this.handle = undefined
    this.cachedLines = undefined
    this.cachedWidth = undefined
    this.paintedBody = undefined
  }

  private paint(width: number): string[] {
    this.paintedBody = undefined
    // No payload means no image command at all: a placement for an id that was
    // never (and cannot be) transmitted would only paint an empty rectangle.
    if (this.source.pngBase64 === '') return [this.options.fallback]
    this.handle ??= this.core.register(this.source)
    const handle = this.handle
    if (handle === undefined) return [this.options.fallback]
    const cell = getCellDimensions()
    // The fork's `Image.render()` clamps its ceiling to `width - 2` and derives
    // the default height cap from the resulting width; the virtual body must
    // occupy the same cells as the Native one.
    const maxWidth = Math.max(1, Math.min(width - 2, this.options.maxWidthCells))
    const defaultMaxHeight = Math.max(1, Math.ceil((maxWidth * cell.widthPx) / cell.heightPx))
    const maxHeight = this.options.maxHeightCells ?? defaultMaxHeight
    const geometry = calculateNativeCellSize(
      { widthPx: this.source.widthPx, heightPx: this.source.heightPx },
      maxWidth,
      maxHeight,
      cell,
    )
    // The component bounds the geometry before the encoder sees it: a 298-cell
    // row would otherwise be silently clamped inside the pure encoder while the
    // painted body still claimed 298 columns.
    const columns = Math.max(1, Math.min(KITTY_VIRTUAL_MAX_CELLS, geometry.columns))
    const rows = Math.max(1, Math.min(KITTY_VIRTUAL_MAX_CELLS, geometry.rows))
    this.paintedBody = { width, columns, rows }
    const grid = encodeKittyPlaceholderGrid(handle.imageId, handle.placementId, columns, rows)
    const marker = encodeManagedVirtualMarker(handle.imageId, handle.placementId)
    const lines = [marker + encodeKittyVirtualPlacement(handle.imageId, handle.placementId, columns, rows) + grid[0]!]
    for (let row = 1; row < rows; row++) lines.push(KITTY_VIRTUAL_GRID_MARKER + grid[row]!)
    return lines
  }
}

/**
 * Create the ONE tmux virtual graphics handle for a real PiTui mount, or
 * `undefined` when the live server is not the single admitted topology. The
 * admission is re-probed before every managed physical write (facade) and, at
 * most once per 250 ms, before a component paints.
 */
export function createTmuxKittyGraphics(
  terminal: Terminal,
  options: KittyGraphicsCoreOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
): KittyGraphics | undefined {
  const identity = probeTmuxKittyIdentity(environment)
  if (identity === undefined) return undefined
  const admission = new TmuxKittyAdmission(identity, environment)
  const core = new KittyGraphicsCore({ ...options, placementMode: 'tmux-virtual' })
  const facade = new KittyTerminalFacade(terminal, core, {
    placementMode: 'tmux-virtual',
    admission,
  })
  let disposed = false
  return {
    mode: 'tmux-virtual',
    canPaint: () => admission.isAllowed(false),
    image: (source, imageOptions) => new TmuxKittyImage(core, source, imageOptions, admission),
    terminal: facade,
    dispose: () => {
      if (disposed) return
      disposed = true
      facade.dispose()
      core.dispose()
    },
  }
}
