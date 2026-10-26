/**
 * The Native Kitty rendering component and the per-terminal graphics factory
 * (Image-7A PR1).
 *
 * `NativeKittyImage` is a plain `Component`: it returns one placement anchor
 * plus the reserved blank rows the placement covers, and it NEVER writes to
 * the terminal, reads an image source, or transcode anything. The bytes it
 * returns describe intent only; the facade decides when the payload must be
 * re-transmitted and the Core owns the id/placement lifetime.
 *
 * The factory admits this path only on a terminal that already had positive
 * native Kitty evidence before this PR (Kitty itself, outside a multiplexer).
 * Every other terminal — including Kitty-compatible ones such as Ghostty and
 * WezTerm — keeps its existing legacy `Image`/text fallback path, because this
 * stage has no measured evidence for their deletion/clear behavior.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/native-image
 */

import { getCapabilities, getCellDimensions, type Component, type Terminal } from '@xmoon76/pi-tui'
import { KittyGraphicsCore, type KittyGraphicsCoreOptions, type KittyImage, type KittyImageSource } from './kitty-core.ts'
import { calculateNativeCellSize, encodeKittyPlacement, type KittyPlacementGeometry } from './kitty-native.ts'
import { KittyTerminalFacade } from './kitty-terminal.ts'

/** The options one managed image occurrence declares. */
export interface NativeKittyImageOptions {
  /** The caller's own width ceiling in cells (the fork's `maxWidthCells`). */
  readonly maxWidthCells: number
  /** The caller's own height ceiling in cells (the fork's `maxHeightCells`). */
  readonly maxHeightCells?: number
  /** The caller's already-styled text row when no pixels can be painted. */
  readonly fallback: string
}

/**
 * The minimal pixel-body face the legacy fork `Image` and the managed
 * component share. A consumer only ever paints and releases it; the
 * ownership/lifecycle decision lives behind the factory, so one branch can
 * swap the renderer without knowing which protocol implementation it got.
 */
export interface PixelBody {
  render(width: number): string[]
  invalidate(): void
  dispose?(): void
}

/** The body one render really painted (the host row mapper reads it). */
export interface NativeKittyImageBody extends KittyPlacementGeometry {
  readonly width: number
}

/** The one graphics handle the real PiTui mount owns per physical terminal. */
export interface NativeKittyGraphics {
  /** Bind one display occurrence. The returned component owns its handle. */
  image(source: KittyImageSource, options: NativeKittyImageOptions): Component
  /** The facade both screens must write through. */
  readonly terminal: Terminal
  /** Release the Core after the physical terminal is gone. Idempotent. */
  dispose(): void
}

/**
 * One occurrence's Native Kitty body.
 *
 * The component caches the painted lines by width (the fork's frames re-render
 * every mounted component) but keeps its Core handle across cache
 * invalidations: a re-render of the SAME occurrence must re-place the SAME
 * image, never mint a new id. `dispose()` is the only place that ends the
 * occurrence, and it is what `Container.clear()`/`removeChild()` call.
 */
export class NativeKittyImage implements Component {
  private readonly core: KittyGraphicsCore
  private readonly source: KittyImageSource
  private readonly options: NativeKittyImageOptions
  private handle: KittyImage | undefined
  private cachedLines: string[] | undefined
  private cachedWidth: number | undefined
  private paintedBody: NativeKittyImageBody | undefined

  constructor(core: KittyGraphicsCore, source: KittyImageSource, options: NativeKittyImageOptions) {
    this.core = core
    this.source = source
    this.options = options
  }

  /** The real painted footprint at `width`, or undefined when no pixels were
   *  painted (budget fallback). */
  paintedBodyAt(width: number): NativeKittyImageBody | undefined {
    const body = this.paintedBody
    return body !== undefined && body.width === width ? body : undefined
  }

  /** The Core image id this occurrence owns, once it was rendered. */
  get imageId(): number | undefined {
    return this.handle?.imageId
  }

  render(width: number): string[] {
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
    // the default height cap from the resulting width; mirroring it keeps the
    // managed placement the same size as the legacy one at the same width.
    const maxWidth = Math.max(1, Math.min(width - 2, this.options.maxWidthCells))
    const defaultMaxHeight = Math.max(1, Math.ceil((maxWidth * cell.widthPx) / cell.heightPx))
    const maxHeight = this.options.maxHeightCells ?? defaultMaxHeight
    const geometry = calculateNativeCellSize(
      { widthPx: this.source.widthPx, heightPx: this.source.heightPx },
      maxWidth,
      maxHeight,
      cell,
    )
    this.paintedBody = { width, columns: geometry.columns, rows: geometry.rows }
    const lines = [encodeKittyPlacement(handle.imageId, handle.placementId, geometry)]
    for (let row = 1; row < geometry.rows; row++) lines.push('')
    return lines
  }
}

const MULTIPLEXER_ENV_KEYS = ['TMUX', 'ZELLIJ', 'STY'] as const

/**
 * Whether the ONE tested native topology is present: a real Kitty terminal,
 * directly attached (no multiplexer in between).
 *
 * This is deliberately narrower than `getCapabilities().images === 'kitty'`,
 * which also covers Ghostty/WezTerm/Warp: those were never measured for the
 * scoped-delete lifecycle this Core relies on, so they keep the legacy path.
 * A `PI_IMAGE_PROTOCOL=kitty` override cannot manufacture Kitty identity —
 * the legacy env override must not bypass the admission rule.
 */
export function admitsNativeKitty(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (getCapabilities().images !== 'kitty') return false
  const termProgram = (environment.TERM_PROGRAM ?? '').toLowerCase()
  const term = (environment.TERM ?? '').toLowerCase()
  if (termProgram === 'herdr') return false
  if (termProgram !== 'kitty' && environment.KITTY_WINDOW_ID === undefined) return false
  for (const key of MULTIPLEXER_ENV_KEYS) {
    if (environment[key] !== undefined) return false
  }
  if (term.startsWith('tmux') || term.startsWith('screen')) return false
  return true
}

/**
 * Create the ONE graphics handle for a real PiTui mount, or `undefined` when
 * the terminal is not the tested native topology (every consumer then keeps
 * its existing path).
 */
export function createNativeKittyGraphics(
  terminal: Terminal,
  options: KittyGraphicsCoreOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
): NativeKittyGraphics | undefined {
  if (!admitsNativeKitty(environment)) return undefined
  const core = new KittyGraphicsCore(options)
  const facade = new KittyTerminalFacade(terminal, core)
  let disposed = false
  return {
    image: (source, imageOptions) => new NativeKittyImage(core, source, imageOptions),
    terminal: facade,
    dispose: () => {
      if (disposed) return
      disposed = true
      facade.dispose()
      core.dispose()
    },
  }
}
