/**
 * Image-8 / I8-5 — the bounded transparent-first-band normalizer for Zellij.
 *
 * Zellij may infer a SIXEL image's width from the first band's painted pixels.
 * When the first band is fully transparent the production encoder emits no
 * pixels for it, so the pane can see a zero-width first band even though the
 * raster attributes declare a real width. This module repairs exactly that
 * shape by prefixing the first band with a transparent `!N?$` run whose length
 * is the raster's declared pixel width.
 *
 * It is deliberately NOT a general SIXEL parser: only the pinned production
 * encoder's grammar is accepted. Any other grammar, a width mismatch, more
 * than one terminator, or an over-budget result refuses the raster instead of
 * forwarding bytes that were not repaired.
 * @module @xmoon76/dsh-pi-tui/tui/graphics/zellij-sixel-width
 */

import { SIXEL_MAX_OUTPUT_BYTES, type SixelRaster } from '../../client/media/sixel/types.ts'

const SIXEL_DCS_INTRODUCER = /^\x1bP[0-9;]*q/
const SIXEL_RASTER_ATTRIBUTES = /^"([0-9]+);([0-9]+);([0-9]+);([0-9]+)/
const SIXEL_COLOR = /^#([0-9]+)(?:;2;[0-9]+;[0-9]+;[0-9]+)?/
const SIXEL_REPEAT = /^!([0-9]+)([?-~])/

/**
 * Repair the production encoder's fully-transparent first band, or return the
 * raster unchanged when its first band already contains pixels.
 *
 * `undefined` means "this grammar cannot be repaired"; the caller must paint
 * text and must never register the original bytes.
 */
export function normalizeZellijSixelRaster(raster: SixelRaster): SixelRaster | undefined {
  const { sequence } = raster
  // One complete DCS: the introducer at byte 0, exactly one terminator at the
  // end, and no other ESC anywhere between them.
  if (!sequence.startsWith('\x1bP') || !sequence.endsWith('\x1b\\')) return undefined
  if (sequence.indexOf('\x1b', 1) !== sequence.length - 2) return undefined
  const introducer = SIXEL_DCS_INTRODUCER.exec(sequence)
  if (introducer === null) return undefined
  const body = sequence.slice(introducer[0].length, -2)
  const attributes = SIXEL_RASTER_ATTRIBUTES.exec(body)
  if (attributes === null) return undefined
  const declaredWidth = Number.parseInt(attributes[3]!, 10)
  if (!Number.isInteger(declaredWidth) || declaredWidth !== raster.widthPx) return undefined

  let index = attributes[0].length
  let firstDash = -1
  let firstBandHasData = false
  while (index < body.length) {
    const char = body[index]!
    if (char === '-') {
      firstDash = index
      break
    }
    if (char === '#') {
      const color = SIXEL_COLOR.exec(body.slice(index))
      if (color === null) return undefined
      index += color[0].length
      continue
    }
    if (char === '!') {
      const repeat = SIXEL_REPEAT.exec(body.slice(index))
      if (repeat === null) return undefined
      firstBandHasData = true
      index += repeat[0].length
      continue
    }
    if (char === '?' || (char >= '@' && char <= '~')) {
      firstBandHasData = true
      index += 1
      continue
    }
    if (char === '$') {
      // A horizontal reset only makes sense after a band pass; it is not a
      // palette definition, so the first band is not the empty shape.
      firstBandHasData = true
      index += 1
      continue
    }
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
      index += 1
      continue
    }
    return undefined
  }
  // No band separator means a single-band raster; a fully empty one is not a
  // valid production output, and a normal one needs no repair.
  if (firstDash === -1) return firstBandHasData ? raster : undefined
  if (firstBandHasData) return raster

  const normalized = `${sequence.slice(0, introducer[0].length + firstDash)}!${declaredWidth}?$${sequence.slice(introducer[0].length + firstDash)}`
  if (Buffer.byteLength(normalized, 'utf8') > SIXEL_MAX_OUTPUT_BYTES) return undefined
  return { ...raster, sequence: normalized }
}
