/**
 * The bounded, value-level SVG admission gate (PR-D D3).
 *
 * The gate is a strict whitelist over a mature streaming XML parser (`saxes`),
 * not a regex over SVG text. It ADMITS or REJECTS the source verbatim: the two
 * renderers must see the SAME document, so nothing is rewritten here.
 *
 * Scope: static, self-contained figures. Scripts, foreignObject, CSS, animation,
 * external references, entities/DOCTYPE and out-of-budget geometry are refused.
 * This is the pre-filter in front of the native rasterizer, not a replacement
 * for process isolation.
 * @module @xmoon76/dsh-pi-tui/domain/visual/svg-admission
 */

import { SaxesParser } from 'saxes'
import {
  SVG_MAX_RASTER_PIXELS,
  SVG_MAX_RASTER_SIDE,
  SVG_MAX_SOURCE_BYTES,
} from './constants.ts'

/** A successful admission carries the source byte count and raster dimensions. */
export interface SvgAdmissionOk {
  readonly ok: true
  readonly bytes: number
  readonly width: number
  readonly height: number
}

/** A refused source: the reason is user/model-readable and bounded. */
export interface SvgAdmissionRejected {
  readonly ok: false
  readonly reason: string
}

/** The admission verdict. */
export type SvgAdmission = SvgAdmissionOk | SvgAdmissionRejected

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const XMLNS_NS = 'http://www.w3.org/2000/xmlns/'

const LIMITS = {
  maxNodes: 5_000,
  maxDepth: 64,
  maxAttrs: 64,
  maxCoord: 100_000,
  maxDim: SVG_MAX_RASTER_SIDE,
  maxViewBoxArea: SVG_MAX_RASTER_PIXELS,
  maxPathCommands: 512,
  maxPathLength: 8_192,
} as const

const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  'svg', 'g', 'defs', 'title', 'desc', 'linearGradient', 'radialGradient', 'stop',
  'path', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'rect', 'mask',
  'clipPath', 'text', 'tspan', 'symbol', 'use',
])

const ALLOWED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'viewBox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd',
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'opacity',
  'fill-opacity', 'stroke-opacity', 'transform', 'id', 'class', 'offset', 'stop-color',
  'stop-opacity', 'gradientUnits', 'mask', 'clip-path', 'fill-rule', 'font-family',
  'font-size', 'font-weight', 'text-anchor', 'dominant-baseline', 'dx', 'dy',
  'letter-spacing',
])

const URI_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'src'])
const PAINT_ATTRIBUTES: ReadonlySet<string> = new Set(['fill', 'stroke', 'stop-color', 'clip-path', 'mask'])
const NUMBER_OR_LENGTH_ATTRIBUTES: ReadonlySet<string> = new Set([
  'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'x1', 'y1', 'x2', 'y2',
  'dx', 'dy', 'stroke-width', 'stop-opacity',
  'opacity', 'fill-opacity', 'stroke-opacity', 'font-size', 'letter-spacing',
])
const SHORT_NAME_ATTRIBUTES: ReadonlySet<string> = new Set([
  'fill-rule', 'stroke-linecap', 'stroke-linejoin', 'text-anchor', 'dominant-baseline',
  'font-weight', 'gradientUnits', 'font-family', 'class', 'id',
])

const LENGTH_PATTERN = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(px|pt|pc|mm|cm|in|em|ex|ch|rem|vw|vh|%)?$/
const NUMBER_PATTERN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/
const COLOR_PATTERN = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgb\([^)]*\)|rgba\([^)]*\)|hsl\([^)]*\))$/
const TRANSFORM_PATTERN = /^[a-zA-Z]+\([^)]*\)(?:\s*,?\s*[a-zA-Z]+\([^)]*\))*$/
const PAINT_URL_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/g
const NUMBER_TOKEN_PATTERN = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g

// The safe subset admits only ABSOLUTE length units (or a unitless user
// value). Relative units depend on a font/viewport the gate does not model;
// fixed conversion constants would let 100em of a 1000-unit font bypass the
// pixel budget.
const UNIT_PX: Readonly<Record<string, number>> = {
  px: 1, pt: 4 / 3, pc: 16, in: 96, mm: 96 / 25.4, cm: 960 / 25.4,
}
const RELATIVE_UNITS: ReadonlySet<string> = new Set(['em', 'ex', 'ch', 'rem', 'vw', 'vh', '%'])

/** Internal rejection; converted to a verdict at the boundary. */
class SvgReject extends Error {}

function reject(reason: string): never {
  throw new SvgReject(reason)
}

function checkNumber(value: string, what: string): number {
  const text = value.trim()
  if (text === '' || !NUMBER_PATTERN.test(text)) reject(`${what}: ${clip(value)} is not a finite number`)
  const number = Number(text)
  if (!Number.isFinite(number)) reject(`${what}: ${clip(value)} is not finite`)
  if (Math.abs(number) > LIMITS.maxCoord) reject(`${what}: ${number} exceeds ${LIMITS.maxCoord}`)
  return number
}

function checkLength(value: string, what: string, limit: number): number {
  const text = value.trim()
  const match = LENGTH_PATTERN.exec(text)
  if (match === null) reject(`${what}: ${clip(value)} is not a bounded length`)
  const raw = Number(match[1])
  if (!Number.isFinite(raw)) reject(`${what}: ${clip(value)} is not finite`)
  if (raw < 0) reject(`${what}: a negative length ${clip(value)}`)
  const unit = match[2]
  // Relative units resolve against a font/viewport this gate deliberately does
  // not model; converting them with fixed constants (the old 16/8/1 table)
  // let `font-size=1000; width=100em` pass as 1600px while resvg rendered
  // 100000px. The static subset therefore admits absolute units only. (A
  // gradient stop `offset` is the one fractional percentage the gate accepts,
  // validated as 0–100% in attributeProblem.)
  if (unit !== undefined && RELATIVE_UNITS.has(unit)) {
    reject(`${what}: relative units (${clip(unit)}) are outside the bounded static subset`)
  }
  const px = raw * (unit === undefined ? 1 : UNIT_PX[unit] as number)
  if (px > limit) reject(`${what}: ${clip(value)} is ${Math.round(px)}px > ${limit}px`)
  return px
}

function checkPaint(value: string, what: string): void {
  const text = value.trim()
  if (text === '' || text === 'none' || text === 'inherit') return
  // SVG/CSS values are case-insensitive for these keywords. Rejecting only
  // the canonical spelling let `currentcolor` / `VAR(--fg)` through the
  // fixed-colour subset and back to the renderer's black theme fallback.
  const lower = text.toLowerCase()
  if (lower.includes('var(') || lower.includes('currentcolor')) {
    reject(`${what}: theme-dependent paint is outside the v1 fixed-colour subset`)
  }
  for (const match of text.matchAll(PAINT_URL_PATTERN)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (!target.startsWith('#')) reject(`${what}: url(${clip(target)}) is not a local fragment`)
  }
  const residue = text.replaceAll(PAINT_URL_PATTERN, '').trim()
  for (const token of residue.split(/\s+/u)) {
    if (token === '' || token === 'none' || token === 'inherit') continue
    if (!COLOR_PATTERN.test(token)) reject(`${what}: ${clip(token)} is not a colour`)
  }
}

function checkTransform(value: string, what: string): void {
  const text = value.trim()
  if (!TRANSFORM_PATTERN.test(text)) reject(`${what}: ${clip(value)} is not a bounded transform list`)
  for (const token of text.match(NUMBER_TOKEN_PATTERN) ?? []) {
    if (Math.abs(Number(token)) > LIMITS.maxCoord) reject(`${what}: a coordinate ${clip(token)} exceeds ${LIMITS.maxCoord}`)
  }
}

function checkPath(value: string, what: string): void {
  const text = value.trim()
  if (Buffer.byteLength(text, 'utf8') > LIMITS.maxPathLength) reject(`${what}: path data exceeds ${LIMITS.maxPathLength} bytes`)
  let commands = 0
  for (const char of text) if (/[a-zA-Z]/u.test(char)) commands += 1
  if (commands > LIMITS.maxPathCommands) reject(`${what}: ${commands} commands > ${LIMITS.maxPathCommands}`)
  for (const token of text.match(NUMBER_TOKEN_PATTERN) ?? []) {
    const number = Number(token)
    if (!Number.isFinite(number) || Math.abs(number) > LIMITS.maxCoord) {
      reject(`${what}: a coordinate ${clip(token)} exceeds ${LIMITS.maxCoord}`)
    }
  }
}

function clip(text: string): string {
  return text.length > 48 ? `${text.slice(0, 48)}…` : text
}

/** Root state accumulated while the document streams through the parser. */
interface GateState {
  readonly parser: SaxesParser
  nodes: number
  depth: number
  maxDepth: number
  rootSeen: boolean
  viewBoxWidth?: number
  viewBoxHeight?: number
  rootWidth?: number
  rootHeight?: number
}

interface SaxesAttributeLike {
  readonly name: string
  readonly local: string
  readonly uri: string
  readonly value: string
}

interface SaxesTagLike {
  readonly name: string
  readonly local: string
  readonly uri: string
  readonly attributes: Readonly<Record<string, SaxesAttributeLike>>
}

function attributeProblem(attribute: SaxesAttributeLike): void {
  const { name, local, uri, value } = attribute
  const what = `attribute ${name}`
  if (value.length > 4096) reject(`${what}: value exceeds 4096 characters`)
  if (uri === XMLNS_NS) {
    if (value !== SVG_NS && value !== XLINK_NS) reject(`namespace ${name}=${clip(value)} is not the SVG or XLink namespace`)
    return
  }
  if (uri === XLINK_NS) {
    if (local !== 'href') reject(`${what} is not in the safe subset`)
    if (!value.startsWith('#')) reject(`${what}=${clip(value)} is not a local fragment`)
    return
  }
  if (uri !== '') reject(`${what} uses an unsupported namespace`)
  if (URI_ATTRIBUTES.has(local)) {
    if (!value.startsWith('#')) reject(`${what}=${clip(value)} is not a local fragment`)
    return
  }
  if (!ALLOWED_ATTRIBUTES.has(local) && !local.startsWith('data-')) reject(`${what} is not in the safe subset`)
  if (local === 'width' || local === 'height') {
    checkLength(value, what, LIMITS.maxDim)
    return
  }
  if (local === 'offset') {
    // A gradient stop offset is a FRACTION, not a viewport-relative length:
    // allow 0–1 or a bounded 0–100%.
    const text = value.trim()
    if (text.endsWith('%')) {
      const percent = Number(text.slice(0, -1))
      if (!Number.isFinite(percent) || percent < 0 || percent > 100) reject(`${what}: a stop offset must be a 0–100% fraction`)
    } else {
      const fraction = checkNumber(text, what)
      if (fraction < 0 || fraction > 1) reject(`${what}: a stop offset must be between 0 and 1`)
    }
    return
  }
  if (local === 'd') {
    checkPath(value, what)
    return
  }
  if (local === 'transform') {
    checkTransform(value, what)
    return
  }
  if (PAINT_ATTRIBUTES.has(local)) {
    checkPaint(value, what)
    return
  }
  if (NUMBER_OR_LENGTH_ATTRIBUTES.has(local)) {
    try {
      checkNumber(value, what)
    } catch (error) {
      if (!(error instanceof SvgReject)) throw error
      checkLength(value, what, LIMITS.maxDim)
    }
    return
  }
  if (SHORT_NAME_ATTRIBUTES.has(local)) {
    if (value.length > 128) reject(`${what} exceeds 128 characters`)
    if (value.includes('url(')) reject(`${what} carries a url()`)
  }
}

function rootGeometryProblem(state: GateState, attributes: ReadonlyMap<string, SaxesAttributeLike>): void {
  const viewBox = attributes.get('viewBox')
  if (viewBox !== undefined) {
    const parts = viewBox.value.replaceAll(',', ' ').trim().split(/\s+/u)
    if (parts.length !== 4) reject('viewBox needs 4 numbers')
    const numbers = parts.map(part => checkNumber(part, 'viewBox component'))
    const width = numbers[2] as number
    const height = numbers[3] as number
    if (width <= 0 || height <= 0) reject('viewBox width and height must be positive')
    if (width > LIMITS.maxDim || height > LIMITS.maxDim) {
      reject(`viewBox ${width}×${height} exceeds ${LIMITS.maxDim}px per side`)
    }
    if (width * height > LIMITS.maxViewBoxArea) reject(`viewBox area ${Math.round(width * height)} > ${LIMITS.maxViewBoxArea}`)
    state.viewBoxWidth = width
    state.viewBoxHeight = height
  }
  const width = attributes.get('width')
  const height = attributes.get('height')
  if (width !== undefined) state.rootWidth = checkLength(width.value, 'attribute width', LIMITS.maxDim)
  if (height !== undefined) state.rootHeight = checkLength(height.value, 'attribute height', LIMITS.maxDim)
}

function openTag(state: GateState, node: SaxesTagLike): void {
  state.nodes += 1
  state.depth += 1
  state.maxDepth = Math.max(state.maxDepth, state.depth)
  if (state.nodes > LIMITS.maxNodes) reject(`nodes > ${LIMITS.maxNodes}`)
  if (state.depth > LIMITS.maxDepth) reject(`depth > ${LIMITS.maxDepth}`)
  if (state.depth === 1) {
    if (node.local !== 'svg') reject(`the root is <${clip(node.local)}>, not <svg>`)
    if (node.uri !== SVG_NS) reject('the root is not in the SVG namespace')
    state.rootSeen = true
  } else if (node.uri !== SVG_NS) {
    reject(`element <${clip(node.local)}> is not in the SVG namespace`)
  }
  if (!ALLOWED_ELEMENTS.has(node.local)) reject(`element <${clip(node.local)}> is not in the safe subset`)
  const attributes = Object.values(node.attributes)
  if (attributes.length > LIMITS.maxAttrs) reject(`attribute count > ${LIMITS.maxAttrs}`)
  for (const attribute of attributes) attributeProblem(attribute)
  if (state.depth > 1 && attributes.some(attribute => attribute.local === 'viewBox')) {
    reject('viewBox is allowed only on the root')
  }
  if (state.depth === 1) {
    if (attributes.every(attribute => attribute.local !== 'xmlns' && attribute.name !== 'xmlns')) {
      reject('the root has no xmlns')
    }
    rootGeometryProblem(state, new Map(attributes.map(attribute => [attribute.local, attribute])))
  }
}

function closeTag(state: GateState): void {
  state.depth -= 1
}

function finalGeometry(state: GateState): { width: number; height: number } {
  if (state.viewBoxWidth !== undefined && state.viewBoxHeight !== undefined) {
    return { width: state.viewBoxWidth, height: state.viewBoxHeight }
  }
  if (state.rootWidth !== undefined && state.rootHeight !== undefined) {
    return { width: state.rootWidth, height: state.rootHeight }
  }
  return reject('the SVG needs a bounded viewBox or explicit width/height')
}

/**
 * Run the bounded admission gate over one SVG source.
 * @param source - the complete standalone SVG text.
 * @returns the verdict; a rejection carries a model/user-readable reason.
 */
export function admitSvg(source: string): SvgAdmission {
  const bytes = Buffer.byteLength(source, 'utf8')
  if (bytes > SVG_MAX_SOURCE_BYTES) {
    return { ok: false, reason: `SVG source ${bytes} bytes > ${SVG_MAX_SOURCE_BYTES} bytes` }
  }
  const parser = new SaxesParser({ xmlns: true })
  const state: GateState = {
    parser,
    nodes: 0,
    depth: 0,
    maxDepth: 0,
    rootSeen: false,
  }
  try {
    parser.on('error', error => reject(`XML: ${error.message}`))
    parser.on('doctype', () => reject('a DOCTYPE declaration is refused'))
    parser.on('processinginstruction', () => reject('a processing instruction is outside the safe subset'))
    parser.on('opentag', node => openTag(state, node))
    parser.on('closetag', () => closeTag(state))
    parser.write(source)
    parser.close()
    const dimensions = finalGeometry(state)
    if (dimensions.width * dimensions.height > SVG_MAX_RASTER_PIXELS) {
      reject(`raster pixels ${Math.round(dimensions.width * dimensions.height)} > ${SVG_MAX_RASTER_PIXELS}`)
    }
    return { ok: true, bytes, width: dimensions.width, height: dimensions.height }
  } catch (error) {
    if (error instanceof SvgReject) return { ok: false, reason: error.message }
    return { ok: false, reason: `XML: ${error instanceof Error ? error.message : String(error)}` }
  }
}
