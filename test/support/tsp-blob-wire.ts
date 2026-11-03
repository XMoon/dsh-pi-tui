/**
 * The TSP 0.2.0 Blob wire, read back the way a Tern client reads it.
 *
 * SDK 0.2.0 stopped putting the blob id on the wire: `encodeBlob()` frames only
 * the Base64 body (plus `mime=` when the caller passed one), and the id a client
 * names an image by is the SHA-256 of the bytes IT decoded. So a test can no
 * longer grep `b;id=` — it has to reassemble the `b` APC frames of a write and
 * hash the result, which is what this module does. It is TEST-ONLY support: no
 * production module imports it, and it deliberately shares no code with the
 * SDK's own `blobId()` so the observed hash stays an independent fact.
 * @module test/support/tsp-blob-wire
 */

import { createHash } from 'node:crypto'

const DECODER = new TextDecoder()

/** Where one APC frame starts. */
const APC = '\u001b_tsp;'
/** The terminator that closes an APC frame. */
const STRING_TERMINATOR = '\u001b\\'
/** The blob verb, right after the frame start. */
const BLOB = 'b;'

/** What a parameter key may hold (the SDK's own `keyByte` set). */
const PARAM_KEY = /^[A-Za-z0-9_-]+$/

/** A logical blob reassembled from the wire: the exact bytes, their MIME and hash. */
export interface ObservedTspBlob {
  /** The lowercase hex SHA-256 over the fully decoded bytes. */
  readonly id: string
  /** The `mime` parameter of the blob's FIRST frame, when it sent one. */
  readonly mime: string | undefined
  /** The exact bytes the wire carried. */
  readonly bytes: Uint8Array
}

/** One logical blob being reassembled from its `c` chunk frames. */
interface OpenBlob {
  readonly chunk: string
  readonly mime: string | undefined
  parts: string[]
}

function fail(message: string): never {
  throw new Error(`tsp blob wire: ${message}`)
}

/** The Base64 alphabet one framed piece may hold (a piece of a chunked body is
 *  not itself a canonical Base64 string, so this is the per-piece check and
 *  {@link CANONICAL_BASE64} is the check on the reassembled body). */
const BASE64_CHARS = /^[A-Za-z0-9+/=]*$/

/** The `key=value` parameters before a frame's body, keyed in send order. */
function readParams(fields: readonly string[]): Map<string, string> {
  const params = new Map<string, string>()
  for (const field of fields) {
    const at = field.indexOf('=')
    if (at <= 0 || !PARAM_KEY.test(field.slice(0, at))) {
      fail(`a blob frame holds a non-parameter segment ${JSON.stringify(field)}`)
    }
    const key = field.slice(0, at)
    if (params.has(key)) fail(`a blob frame repeats the ${key} parameter`)
    const value = field.slice(at + 1)
    // The SDK writes what it was given: `mime=` only carries a real media type,
    // and `c=` only carries the chunk id it chose, so an empty one is a torn frame.
    if (key === 'mime' && value === '') fail('a blob frame sends an empty mime parameter')
    if (key === 'c' && value === '') fail('a blob frame sends an empty chunk parameter')
    params.set(key, value)
  }
  for (const key of params.keys()) {
    if (key !== 'mime' && key !== 'c' && key !== 'm') fail(`a blob frame carries the unknown parameter ${key}`)
  }
  return params
}

/** The Base64 body of one frame; `;` can never appear inside it. */
function readBody(content: string): { readonly params: Map<string, string>; readonly body: string } {
  const fields = content.split(';')
  const body = fields.pop()!
  if (!BASE64_CHARS.test(body)) fail(`a blob frame body holds a character outside the Base64 alphabet`)
  return { params: readParams(fields), body }
}

function decode(base64: string): Uint8Array {
  // Canonical Base64 (RFC 4648) checked WITHOUT a backtracking pattern: a real
  // attachment body is megabytes long, and a nested-quantifier regex overflows
  // the stack on it. Quads only, and `=` may appear solely as the last one or
  // two characters of the final quad.
  const length = base64.length
  if (length % 4 !== 0) fail('the reassembled Base64 body is not a whole number of quads')
  const firstPad = base64.indexOf('=')
  if (firstPad !== -1) {
    const pads = length - firstPad
    if (pads > 2) fail(`a Base64 body holds ${pads} padding characters in its final quad`)
    for (let at = firstPad; at < length; at++) {
      if (base64[at] !== '=') fail('a Base64 body holds padding before its final quad')
    }
  }
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

/**
 * The content (parameters plus body, without the `b;` verb) of every complete
 * blob frame, in physical order.
 *
 * Frames are located by their own boundaries rather than by a lazy match, so a
 * blob frame whose terminator never arrives — the write was cut short, or the
 * next frame began inside it — throws instead of disappearing from the result.
 * The other verbs are skipped: this reader observes Blobs only.
 */
function readBlobFrames(text: string): string[] {
  const starts: number[] = []
  for (let at = text.indexOf(APC); at >= 0; at = text.indexOf(APC, at + APC.length)) starts.push(at)
  const frames: string[] = []
  starts.forEach((at, index) => {
    const body = at + APC.length
    if (!text.startsWith(BLOB, body)) return
    const content = body + BLOB.length
    const end = text.indexOf(STRING_TERMINATOR, content)
    if (end < 0) fail('a blob frame never reached its terminator')
    const next = index + 1 < starts.length ? starts[index + 1]! : text.length
    if (next < end) fail('a blob frame was cut short by the frame that followed it')
    frames.push(text.slice(content, end))
  })
  return frames
}

function observe(mime: string | undefined, base64: string): ObservedTspBlob {
  const bytes = decode(base64)
  return { id: createHash('sha256').update(bytes).digest('hex'), mime, bytes }
}

/**
 * Every logical Blob this wire carried, in physical send order.
 *
 * A write may hold several `b` messages and any of them may be chunked across
 * consecutive frames by the SDK's `encodeMessage` (`c=<chunk-id>` on every
 * piece, `m=1` on every non-final piece); one logical Blob yields exactly one
 * entry. An incomplete, repeated, interleaved or contradictory chunk
 * structure throws instead of being skipped: a test must not silently lose a
 * Blob the SDK really sent.
 */
export function readTspBlobMessages(wire: string | Uint8Array): readonly ObservedTspBlob[] {
  const text = typeof wire === 'string' ? wire : DECODER.decode(wire)
  const blobs: ObservedTspBlob[] = []
  let open: OpenBlob | undefined
  for (const content of readBlobFrames(text)) {
    const { params, body } = readBody(content)
    const chunk = params.get('c')
    const more = params.get('m')
    if (more !== undefined && more !== '1') fail(`a blob chunk marks continuation with ${JSON.stringify(more)}`)
    if (chunk === undefined) {
      if (more !== undefined) fail('a blob frame with m=1 has to name its chunk')
      if (open !== undefined) fail(`a whole blob arrived while chunk ${open.chunk} was still open`)
      blobs.push(observe(params.get('mime'), body))
      continue
    }
    if (open === undefined) {
      // The SDK only writes `c` when it split the body, so a chunk id always
      // starts a group with at least one continuation frame behind it.
      if (more === undefined) fail(`chunk ${chunk} ended without ever starting`)
      open = { chunk, mime: params.get('mime'), parts: [body] }
      continue
    }
    if (open.chunk !== chunk) fail(`chunk ${chunk} interleaves the open chunk ${open.chunk}`)
    if (params.has('mime')) fail(`chunk ${chunk} repeats mime after its first frame`)
    open.parts.push(body)
    if (more === undefined) {
      blobs.push(observe(open.mime, open.parts.join('')))
      open = undefined
    }
  }
  if (open !== undefined) fail(`chunk ${open.chunk} never sent its final frame`)
  return blobs
}
