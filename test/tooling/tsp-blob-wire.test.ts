/**
 * The test-only reader for the TSP 0.2.0 Blob wire.
 *
 * Evidence: the SDK's own `encodeBlob()`/`encodeMessage()` build the frames, so
 * the input is the real wire bytes; the observer under test is the reassembly +
 * hash the six Blob consumers now share. No production code is involved, and a
 * real Tern client is not proven by any case here.
 * @module @xmoon76/dsh-pi-tui/test/tooling/tsp-blob-wire.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { concatBytes, encodeBlob } from '@stencil-hq/tern'

import { readTspBlobMessages } from '../support/tsp-blob-wire.ts'

const DECODER = new TextDecoder()

/** Deterministic pseudo-PNG bytes: every value range a Base64 body can carry. */
const PNG_BYTES = new Uint8Array(Array.from({ length: 600 }, (_, i) => (i * 7 + 3) % 256))
const SVG_BYTES = new Uint8Array(
  Array.from(
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"></svg>'.repeat(9)),
  ),
)

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function frameCount(wire: Uint8Array): number {
  return [...DECODER.decode(wire).matchAll(/\u001b_tsp;b;/g)].length
}

test('an unchunked blob frame decodes to its exact bytes and to the hash of those bytes', () => {
  const encoded = encodeBlob(PNG_BYTES, 'image/png')
  const observed = readTspBlobMessages(encoded.bytes)

  assert.equal(frameCount(encoded.bytes), 1, 'the encoder sent one frame')
  assert.deepEqual(observed, [{ id: sha256(PNG_BYTES), mime: 'image/png', bytes: PNG_BYTES }])
  // The id is a property of the bytes, not a field on the wire: 0.2.0 sends none.
  assert.equal(DECODER.decode(encoded.bytes).includes('b;id='), false,
    'the blob frame carries no id parameter')
  assert.equal(observed[0]!.id, encoded.id, 'the observed hash agrees with the id the SDK names')
})

test('a blob the encoder splits across the APC limit reassembles into one exact blob', () => {
  const encoded = encodeBlob(SVG_BYTES, 'image/svg+xml', {
    limit: 24,
    chunk: () => 'test-chunk',
  })
  const text = DECODER.decode(encoded.bytes)
  assert.equal(frameCount(encoded.bytes) > 1, true, 'the encoder really chunked this body')
  assert.equal(text.includes('c=test-chunk;'), true, 'every piece names the same chunk')
  assert.equal(text.includes('m=1;'), true, 'a non-final piece marks the continuation')

  const observed = readTspBlobMessages(encoded.bytes)
  assert.equal(observed.length, 1, 'one logical Blob came off a multi-frame write')
  assert.deepEqual(observed[0]!.bytes, SVG_BYTES, 'the reassembled bytes are the sent bytes')
  assert.equal(observed[0]!.mime, 'image/svg+xml')
  assert.equal(observed[0]!.id, sha256(SVG_BYTES), 'the hash is over the FULL reassembled bytes')
  assert.equal(observed[0]!.id, encoded.id)
})

test('a plain and a chunked blob sent back to back decode as two entries in send order', () => {
  const first = encodeBlob(PNG_BYTES)
  const second = encodeBlob(SVG_BYTES, 'image/svg+xml', { limit: 32, chunk: () => 'second' })
  const observed = readTspBlobMessages(concatBytes([first.bytes, second.bytes]))

  assert.deepEqual(observed.map(blob => blob.id), [sha256(PNG_BYTES), sha256(SVG_BYTES)],
    'the order the wire sent is the order the reader returns')
  assert.equal(observed[0]!.mime, undefined, 'a blob sent without a mime stays without one')
  assert.equal(observed[1]!.mime, 'image/svg+xml')
  assert.deepEqual(observed[1]!.bytes, SVG_BYTES)
})

test('a chunk group whose final frame never arrives throws instead of dropping the blob', () => {
  const encoded = encodeBlob(SVG_BYTES, 'image/svg+xml', { limit: 24, chunk: () => 'cut' })
  const parts = DECODER.decode(encoded.bytes).split('\u001b\\')
  assert.equal(parts.length > 3, true, 'this body really arrived in several complete frames')
  // Every frame but the last: the reassembly is left holding an unfinished group.
  const truncated = parts.slice(0, parts.length - 2).join('\u001b\\')

  assert.throws(() => readTspBlobMessages(truncated), /chunk cut never sent its final frame/)
})

test('a second chunk id opened inside a group throws instead of overwriting the open blob', () => {
  const encoded = encodeBlob(SVG_BYTES, 'image/svg+xml', { limit: 24, chunk: () => 'cut' })
  const parts = DECODER.decode(encoded.bytes).split('\u001b\\')
  const second = parts[1]!.replace('c=cut;', 'c=other;')
  assert.notEqual(second, parts[1], 'the rewritten frame really names a second chunk')
  parts[1] = second

  assert.throws(() => readTspBlobMessages(parts.join('\u001b\\')),
    /chunk other interleaves the open chunk cut/)
})
