/**
 * The native Kitty graphics wire and the pure placement geometry of the
 * managed graphics Core (Image-7A PR1).
 *
 * This module owns the EXACT bytes of the Native backend: the quiet
 * (`q=2`) transmit chunks, the `a=p,C=1` placement anchor, and the scoped
 * delete forms the Core is allowed to emit. It deliberately does not own
 * terminal state, image ids, residency or layout — those belong to
 * `kitty-core.ts`, `kitty-terminal.ts` and the rendering component.
 *
 * Geometry is a consumer-side copy of the vendored fork's
 * `calculateImageCellSize(..., optimizeAspectRatio = true)` formula: the
 * fork's `Image.render()` remains the reference implementation for the
 * legacy/iTerm2 paths and for cross-testing, but the managed path may not
 * re-derive placement from a private fork import. `getCellDimensions()` is
 * the package's public metric face and the single source of cell size.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/kitty-native
 */

import { getCellDimensions, type CellDimensions, type ImageDimensions } from '@xmoon76/pi-tui'

/** The APC introducer that starts every Kitty graphics command. */
export const KITTY_APC_INTRODUCER = '\x1b_G'
/** The string terminator (ST) that closes every Kitty graphics command. */
export const KITTY_APC_TERMINATOR = '\x1b\\'
/**
 * The protocol's chunk ceiling for one base64 payload: chunks are at most
 * 4096 bytes and every chunk except the last is a multiple of 4 (kitty
 * graphics protocol, "Remote client").
 */
export const KITTY_TRANSMIT_CHUNK_CHARS = 4096

/** The cell footprint one Native placement really occupies. */
export interface KittyPlacementGeometry {
  readonly columns: number
  readonly rows: number
}

/** One parsed Kitty graphics command: its control map and its payload. */
export interface KittyApc {
  readonly controls: Readonly<Record<string, string>>
  readonly payload: string
}

/**
 * Parse one complete `<ESC>_G<controls>[;<payload>]<ESC>\` command.
 *
 * Returns `undefined` for anything that is not a complete, well-formed Kitty
 * graphics APC — the caller keeps foreign/unknown sequences untouched rather
 * than guessing. An empty payload (the `a=p` placement form) is legal.
 */
export function parseKittyApc(apc: string): KittyApc | undefined {
  if (!apc.startsWith(KITTY_APC_INTRODUCER) || !apc.endsWith(KITTY_APC_TERMINATOR)) return undefined
  const body = apc.slice(KITTY_APC_INTRODUCER.length, apc.length - KITTY_APC_TERMINATOR.length)
  if (body.includes('\x1b')) return undefined
  const separator = body.indexOf(';')
  const controlText = separator === -1 ? body : body.slice(0, separator)
  const payload = separator === -1 ? '' : body.slice(separator + 1)
  const controls: Record<string, string> = {}
  for (const part of controlText.split(',')) {
    if (part === '') continue
    const equals = part.indexOf('=')
    if (equals <= 0) continue
    controls[part.slice(0, equals)] = part.slice(equals + 1)
  }
  return { controls, payload }
}

/**
 * Encode the FULL image transmission as quiet chunks.
 *
 * One `a=t,f=100,i=<id>` per image; the payload is split into
 * {@link KITTY_TRANSMIT_CHUNK_CHARS} pieces and EVERY chunk carries `q=2`,
 * including the final one — a silent continuation chunk would let kitty's
 * `Gi=0;OK`/error replies reach the TUI's stdin parser. Continuation chunks
 * carry only `m` and `q`, which is exactly what the protocol allows.
 */
export function encodeKittyTransmit(pngBase64: string, imageId: number): string[] {
  const prefix = `${KITTY_APC_INTRODUCER}`
  const suffix = KITTY_APC_TERMINATOR
  if (pngBase64.length <= KITTY_TRANSMIT_CHUNK_CHARS) {
    return [`${prefix}a=t,f=100,i=${imageId},q=2;${pngBase64}${suffix}`]
  }
  const chunks: string[] = []
  for (let offset = 0; offset < pngBase64.length; offset += KITTY_TRANSMIT_CHUNK_CHARS) {
    const chunk = pngBase64.slice(offset, offset + KITTY_TRANSMIT_CHUNK_CHARS)
    const last = offset + KITTY_TRANSMIT_CHUNK_CHARS >= pngBase64.length
    const more = last ? 0 : 1
    chunks.push(offset === 0
      ? `${prefix}a=t,f=100,i=${imageId},q=2,m=${more};${chunk}${suffix}`
      : `${prefix}m=${more},q=2;${chunk}${suffix}`)
  }
  return chunks
}

/**
 * Encode one placement anchor. `C=1` keeps the cursor on the anchor cell so
 * the screen writer's own row accounting stays authoritative; the trailing
 * `;` is required by the fork's main-screen image-line parser (its
 * `parseKittyImageHeader()` only sees an id when the control area is
 * terminated), so the line is a real tracked image row.
 */
export function encodeKittyPlacement(
  imageId: number,
  placementId: number,
  geometry: KittyPlacementGeometry,
): string {
  return `${KITTY_APC_INTRODUCER}a=p,i=${imageId},p=${placementId},c=${geometry.columns},r=${geometry.rows},C=1,q=2;${KITTY_APC_TERMINATOR}`
}

/**
 * Hard retirement: delete the image WITH its data. Only the Core may emit
 * this, and only for an id the Core still owns.
 */
export function encodeKittyDeleteImage(imageId: number): string {
  return `${KITTY_APC_INTRODUCER}a=d,d=I,i=${imageId},q=2${KITTY_APC_TERMINATOR}`
}

/**
 * Scoped placement removal: the image disappears from the screen while its
 * data stays resident, so a later re-show needs no re-transmission.
 */
export function encodeKittyDeletePlacement(imageId: number): string {
  return `${KITTY_APC_INTRODUCER}a=d,d=i,i=${imageId},q=2${KITTY_APC_TERMINATOR}`
}

function chooseLessDistortedCellCount(upperCount: number, idealCount: number): number {
  if (upperCount <= 1) return upperCount

  const lowerCount = upperCount - 1
  const upperDistortion = Math.max(upperCount / idealCount, idealCount / upperCount)
  const lowerDistortion = Math.max(lowerCount / idealCount, idealCount / lowerCount)
  return lowerDistortion < upperDistortion ? lowerCount : upperCount
}

/**
 * Fit one image into the given cell budget.
 *
 * This is the vendored fork's `calculateImageCellSize()` with
 * `optimizeAspectRatio = true` (the fork's Kitty branch): the managed
 * placement must occupy exactly the cells the legacy `Image` would have
 * occupied, so a surface's painted body and its click band cannot drift
 * apart when the terminal capability is what changed, not the layout.
 * `tests/tui/kitty-native-protocol.test.ts` cross-checks the formula against
 * the real `Image.render()` output instead of trusting this copy.
 */
export function calculateNativeCellSize(
  imageDimensions: ImageDimensions,
  maxWidthCells: number,
  maxHeightCells: number | undefined,
  cellDimensions: CellDimensions = getCellDimensions(),
): KittyPlacementGeometry {
  const maxWidth = Math.max(1, Math.floor(maxWidthCells))
  const maxHeight = maxHeightCells === undefined ? undefined : Math.max(1, Math.floor(maxHeightCells))
  const imageWidth = Math.max(1, imageDimensions.widthPx)
  const imageHeight = Math.max(1, imageDimensions.heightPx)

  const widthScale = (maxWidth * cellDimensions.widthPx) / imageWidth
  const heightScale = maxHeight === undefined ? widthScale : (maxHeight * cellDimensions.heightPx) / imageHeight
  const scale = Math.min(widthScale, heightScale)

  const scaledWidthPx = imageWidth * scale
  const scaledHeightPx = imageHeight * scale
  let columns = Math.max(1, Math.min(maxWidth, Math.ceil(scaledWidthPx / cellDimensions.widthPx)))
  const heightRows = scaledHeightPx / cellDimensions.heightPx
  let rows = Math.max(1, Math.ceil(heightRows))
  if (maxHeight !== undefined) {
    rows = Math.min(maxHeight, rows)
  }

  if (widthScale <= heightScale) {
    const idealRows = (columns * cellDimensions.widthPx * imageHeight) / (imageWidth * cellDimensions.heightPx)
    rows = chooseLessDistortedCellCount(rows, idealRows)
  } else {
    const idealColumns = (rows * cellDimensions.heightPx * imageWidth) / (imageHeight * cellDimensions.widthPx)
    columns = chooseLessDistortedCellCount(columns, idealColumns)
  }

  return { columns, rows }
}
