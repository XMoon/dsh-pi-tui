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
 * The factory admits this path on any Direct capable Kitty protocol terminal:
 * the fork's effective `images === 'kitty'` capability is the protocol
 * authority, and no known multiplexer may be in between. `TERM` is not an
 * identity condition; it only rejects a known `tmux*`/`screen*` multiplexer.
 * The direct path never uses a terminal-brand allowlist.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/native-image
 */

import {
  getCapabilities,
  getCellDimensions,
  registerKittyImageMetadata,
  type Component,
  type Terminal,
} from '@xmoon76/pi-tui'
import { KittyGraphicsCore, type KittyGraphicsCoreOptions, type KittyImage, type KittyImageSource } from './kitty-core.ts'
import { calculateNativeCellSize, encodeKittyPlacement, type KittyPlacementGeometry } from './kitty-native.ts'
import { KittyTerminalFacade } from './kitty-terminal.ts'
import type { DirectSixelGraphics } from './sixel-image.ts'

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
  /**
   * The REAL footprint the last render at `width` painted, or `undefined` when
   * that render carried no pixels (collapsed, budget fallback, revoked
   * admission, an empty source). Only a managed component can answer it: the
   * legacy fork `Image` keeps the caller's sequence-parsing fallback, so a
   * consumer never has to know which implementation it holds.
   */
  paintedBodyAt?(width: number): NativeKittyImageBody | undefined
  dispose?(): void
}

/** The body one render really painted (the host row mapper reads it). */
export interface NativeKittyImageBody extends KittyPlacementGeometry {
  readonly width: number
}

/**
 * The one graphics handle the real PiTui mount owns per physical terminal.
 *
 * Exactly one of these exists per TUI process: `mode` is the immutable
 * transport it was admitted for, and `canPaint()` reports whether the live
 * admission still allows pixels on the current frame. A consumer asks
 * `effectiveImageProtocol()` rather than inspecting either field itself.
 */
export interface KittyGraphics {
  /** The immutable transport this handle uses. */
  readonly mode: 'native' | 'tmux-virtual'
  /** Whether the real admission still allows pixels on the current frame. */
  canPaint(): boolean
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
  /** The geometry last registered with the fork's placement metadata table,
   *  or undefined before the first successful registration. Re-registering an
   *  unchanged placement would only burn a `transmissionGeneration` value. */
  private registeredGeometry: string | undefined

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
    // The registered geometry is re-checked on the next paint, so it is kept.
    this.cachedLines = undefined
    this.cachedWidth = undefined
    this.paintedBody = undefined
  }

  dispose(): void {
    if (this.handle !== undefined) this.core.retire(this.handle)
    this.handle = undefined
    this.registeredGeometry = undefined
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
    // The vendored layout engine crops a kitty image at the viewport edges and
    // when scrolling into its middle, but only for a line whose id it can look
    // up in the fork's placement metadata table. Registering the REAL geometry
    // restores that established behavior for managed placements.
    const geometryKey = `${handle.imageId}:${handle.placementId}:${geometry.columns}:${geometry.rows}:${width}`
    if (this.registeredGeometry !== geometryKey) {
      registerKittyImageMetadata({
        imageId: handle.imageId,
        columns: geometry.columns,
        rows: geometry.rows,
        widthPx: this.source.widthPx,
        heightPx: this.source.heightPx,
      })
      this.registeredGeometry = geometryKey
    }
    const lines = [encodeKittyPlacement(handle.imageId, handle.placementId, geometry)]
    for (let row = 1; row < geometry.rows; row++) lines.push('')
    return lines
  }
}

/**
 * Every managed graphics handle a consumer may hold (Image-8 / I8-2A).
 *
 * The union exists so a media component swaps its renderer without knowing the
 * protocol: it asks `effectiveImageProtocol()` and calls the same
 * `image(source, options)` / `canPaint()` / `terminal` / `dispose()` surface.
 * Kitty keeps precedence everywhere it was admitted; SIXEL is only ever the
 * single owner of a Direct terminal that reported its own DA1 attribute.
 */
export type ImageGraphics = KittyGraphics | DirectSixelGraphics

const MULTIPLEXER_ENV_KEYS = ['TMUX', 'ZELLIJ', 'STY'] as const

/**
 * Whether the managed native topology is present: a Direct capable Kitty
 * protocol terminal, with no multiplexer in between.
 *
 * The fork's effective `images === 'kitty'` capability is deliberately the
 * protocol authority: it already covers Kitty, Ghostty, WezTerm, Warp, Tern and
 * a user's explicit `PI_IMAGE_PROTOCOL=kitty` override. No terminal-brand
 * allowlist is applied. `TERM` is not an identity fact — `xterm-ghostty`,
 * `xterm-256color`, a custom value or no `TERM` at all are accepted — it only
 * rejects a known multiplexer prefix (`tmux*`/`screen*`), alongside the
 * `TMUX`/`ZELLIJ`/`STY` keys and Herdr. Those transport exclusions are what
 * keep an inherited capability from being mistaken for a direct pane
 * protocol.
 */
export function admitsNativeKitty(environment: NodeJS.ProcessEnv = process.env): boolean {
  if (getCapabilities().images !== 'kitty') return false
  const termProgram = (environment.TERM_PROGRAM ?? '').toLowerCase()
  const term = (environment.TERM ?? '').toLowerCase()
  if (termProgram === 'herdr') return false
  for (const key of MULTIPLEXER_ENV_KEYS) {
    if (environment[key] !== undefined) return false
  }
  if (term.startsWith('tmux') || term.startsWith('screen')) return false
  return true
}

/**
 * Create the ONE graphics handle for a real PiTui mount, or `undefined` when
 * the terminal is not a Direct capable Kitty protocol topology (every consumer
 * then keeps its existing path).
 */
export function createNativeKittyGraphics(
  terminal: Terminal,
  options: KittyGraphicsCoreOptions = {},
  environment: NodeJS.ProcessEnv = process.env,
): KittyGraphics | undefined {
  if (!admitsNativeKitty(environment)) return undefined
  const core = new KittyGraphicsCore(options)
  const facade = new KittyTerminalFacade(terminal, core)
  let disposed = false
  return {
    mode: 'native',
    canPaint: () => true,
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
