/**
 * Image-8 / I8-1C test support — an INDEPENDENT SIXEL oracle.
 *
 * The production codec is `sixel@0.16.0`. Decoding its output with that same
 * library's decoder would only prove the library agrees with itself, so this
 * file implements the small DEC STD 070 subset the encoder actually emits and
 * reports the painted pixels. It is deliberately dumb and strict: anything it
 * cannot represent is an error, never a silent skip.
 *
 * Supported grammar: `ESC P <params> q`, raster attributes `"Pan;Pad;Ph;Pv`,
 * color introducers `#n` and `#n;2;r;g;b`, sixel characters `?`..`~`, repeat
 * `!<n><char>`, band separator `-`, and the `ESC \` string terminator.
 * @module @xmoon76/dsh-pi-tui/test/sixel-oracle
 */

export interface DecodedSixel {
  readonly width: number
  readonly height: number
  /** RGBA pixels; alpha 0 means "never painted". */
  readonly rgba: Uint8Array
  /** Painted bounding box, or `null` when the payload painted nothing. */
  readonly paintedBounds: { left: number; top: number; right: number; bottom: number } | null
}

interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

/** Decode one complete SIXEL DCS produced by the production encoder. */
export function decodeSixel(sequence: string): DecodedSixel {
  if (!sequence.startsWith('\x1bP')) throw new Error('oracle: payload does not start a DCS')
  if (!sequence.endsWith('\x1b\\')) throw new Error('oracle: payload does not end with ST')
  const introducer = /^\x1bP[0-9;]*q/.exec(sequence)
  if (introducer === null) throw new Error('oracle: payload has no q introducer')
  const body = sequence.slice(introducer[0].length, -2)

  const raster = /^"([0-9]+);([0-9]+);([0-9]+);([0-9]+)/.exec(body)
  if (raster === null) throw new Error('oracle: payload has no raster attributes')
  const width = Number.parseInt(raster[3]!, 10)
  const height = Number.parseInt(raster[4]!, 10)
  const rgba = new Uint8Array(width * height * 4)
  const palette = new Map<number, Rgb>()
  let bounds: { left: number; top: number; right: number; bottom: number } | null = null

  let cursorX = 0
  let bandTop = 0
  let currentColor: Rgb | undefined
  let index = raster[0]!.length

  const paint = (x: number, y: number): void => {
    if (x < 0 || x >= width || y < 0 || y >= height) {
      throw new Error(`oracle: payload paints outside its declared ${width}x${height} raster at ${x},${y}`)
    }
    if (currentColor === undefined) throw new Error('oracle: sixel data before any color introducer')
    const offset = (y * width + x) * 4
    rgba[offset] = currentColor.r
    rgba[offset + 1] = currentColor.g
    rgba[offset + 2] = currentColor.b
    rgba[offset + 3] = 255
    bounds =
      bounds === null
        ? { left: x, top: y, right: x, bottom: y }
        : {
            left: Math.min(bounds.left, x),
            top: Math.min(bounds.top, y),
            right: Math.max(bounds.right, x),
            bottom: Math.max(bounds.bottom, y),
          }
  }

  while (index < body.length) {
    const char = body[index]!
    if (char === '-') {
      bandTop += 6
      cursorX = 0
      index += 1
      continue
    }
    if (char === '$') {
      cursorX = 0
      index += 1
      continue
    }
    if (char === '#') {
      const match = /^#([0-9]+)(?:;2;([0-9]+);([0-9]+);([0-9]+))?/.exec(body.slice(index))
      if (match === null) throw new Error('oracle: malformed color introducer')
      const id = Number.parseInt(match[1]!, 10)
      if (match[2] !== undefined) {
        palette.set(id, {
          r: Math.round((Number.parseInt(match[2], 10) * 255) / 100),
          g: Math.round((Number.parseInt(match[3]!, 10) * 255) / 100),
          b: Math.round((Number.parseInt(match[4]!, 10) * 255) / 100),
        })
      }
      const color = palette.get(id)
      if (color === undefined) throw new Error(`oracle: color ${id} selected before it was defined`)
      currentColor = color
      index += match[0].length
      continue
    }
    let bits: number
    let advance = 1
    if (char === '!') {
      const match = /^!([0-9]+)([?-~])/.exec(body.slice(index))
      if (match === null) throw new Error('oracle: malformed repeat')
      const count = Number.parseInt(match[1]!, 10)
      bits = match[2]!.charCodeAt(0) - 0x3f
      for (let repeat = 0; repeat < count; repeat += 1) {
        for (let bit = 0; bit < 6; bit += 1) {
          if ((bits & (1 << bit)) !== 0) paint(cursorX, bandTop + bit)
        }
        cursorX += 1
      }
      index += match[0].length
      continue
    }
    if (char >= '?' && char <= '~') {
      bits = char.charCodeAt(0) - 0x3f
      for (let bit = 0; bit < 6; bit += 1) {
        if ((bits & (1 << bit)) !== 0) paint(cursorX, bandTop + bit)
      }
      cursorX += advance
      index += 1
      continue
    }
    // Whitespace is legal and ignored by the DEC parser.
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
      index += 1
      continue
    }
    throw new Error(`oracle: unsupported SIXEL token ${JSON.stringify(char)}`)
  }

  return { width, height, rgba, paintedBounds: bounds }
}

/** Read one RGBA pixel from a decoded raster. */
export function pixelAt(decoded: DecodedSixel, x: number, y: number): [number, number, number, number] {
  const offset = (y * decoded.width + x) * 4
  return [decoded.rgba[offset]!, decoded.rgba[offset + 1]!, decoded.rgba[offset + 2]!, decoded.rgba[offset + 3]!]
}
