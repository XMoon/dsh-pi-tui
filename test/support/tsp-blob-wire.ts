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

/** One complete blob frame: `ESC _ tsp; b; <params>; <base64 body> ESC \`. */
const BLOB_FRAME = /\u001b_tsp;b;([\s\S]*?)\u001b\\/g

/** What a parameter key may hold (the SDK's own `keyByte` set). */
const PARAM_KEY = /^[A-Za-z0-9_-]+$/

/** The Base64 alphabet a framed body may hold. */
const BASE64 = /^[A-Za-z0-9+/=]*$/

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
    params.set(key, field.slice(at + 1))
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
  if (!BASE64.test(body)) fail(`a blob frame body is not Base64: ${JSON.stringify(body)}`)
  return { params: readParams(fields), body }
}

function decode(base64: string): Uint8Array {
  if (base64.length % 4 !== 0) fail(`the reassembled Base64 body is not a whole number of quads`)
  return new Uint8Array(Buffer.from(base64, 'base64'))
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
  for (const match of text.matchAll(BLOB_FRAME)) {
    const { params, body } = readBody(match[1]!)
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
