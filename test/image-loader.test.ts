/**
 * M8 tests: the bounded LRU image cache and the async loader (dedupe,
 * state transitions, subscriber notification, error state) — plan §16.
 * @module @xmoon76/dsh-pi-tui/image-loader.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ImageCache } from '../src/image/cache.ts'
import { bytesToBase64, ImageLoader } from '../src/image/loader.ts'
import type { ImageAttachmentRefLike } from '../src/image/admission.ts'

function refOf(id: string, bytes = 3): ImageAttachmentRefLike {
  return { attachmentId: id, mediaType: 'image/png', bytes, width: 1, height: 1, name: `${id}.png` }
}

test('the cache stores ready entries and reports size/bytes', () => {
  const cache = new ImageCache(4, 1024)
  assert.equal(cache.get('a'), undefined)
  cache.set('a', { state: 'ready', bytes: new Uint8Array([1]), base64: 'AQ==', byteLength: 1 })
  assert.equal(cache.get('a')?.state, 'ready')
  assert.equal(cache.size(), 1)
  assert.ok(cache.bytes() > 0)
  cache.delete('a')
  assert.equal(cache.get('a'), undefined)
})

test('ImageCache evicts by entry count and byte budget (LRU)', () => {
  const cache = new ImageCache(2, 1024)
  cache.set('a', { state: 'ready', bytes: new Uint8Array(10), base64: 'x', byteLength: 10 })
  cache.set('b', { state: 'ready', bytes: new Uint8Array(10), base64: 'x', byteLength: 10 })
  cache.set('c', { state: 'ready', bytes: new Uint8Array(10), base64: 'x', byteLength: 10 })
  assert.equal(cache.size(), 2)
  assert.equal(cache.get('a'), undefined, 'oldest entry evicted')
  // Touching b makes it newest; inserting d evicts c.
  cache.get('b')
  cache.set('d', { state: 'ready', bytes: new Uint8Array(10), base64: 'x', byteLength: 10 })
  assert.equal(cache.get('c'), undefined)
  assert.equal(cache.get('b')?.state, 'ready')
  // Byte-budget eviction.
  const tiny = new ImageCache(10, 30)
  tiny.set('big', { state: 'ready', bytes: new Uint8Array(50), base64: 'x', byteLength: 50 })
  assert.equal(tiny.size(), 0, 'an over-budget entry evicts immediately')
})

test('ImageLoader lazily resolves, dedupes concurrent loads and notifies once', async () => {
  let reads = 0
  const loader = new ImageLoader(async () => {
    reads += 1
    await new Promise(resolve => setTimeout(resolve, 5))
    return { ref: {}, data: new Uint8Array([1, 2, 3]) }
  })
  const ref = refOf('a')
  assert.equal(loader.get(ref).state, 'idle')
  let notified = 0
  loader.subscribe(ref.attachmentId, () => { notified += 1 })
  // Two components load the SAME ref concurrently: one underlying read.
  loader.load(ref)
  loader.load(ref)
  assert.equal(loader.get(ref).state, 'loading')
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(reads, 1)
  assert.equal(notified, 1)
  const state = loader.get(ref)
  assert.equal(state.state, 'ready')
  if (state.state === 'ready') {
    assert.equal(state.base64, 'AQID')
  }
})

test('ImageLoader caches settled reads: a second get never re-reads', async () => {
  let reads = 0
  const loader = new ImageLoader(async () => {
    reads += 1
    return { ref: {}, data: new Uint8Array([9]) }
  })
  const ref = refOf('b')
  loader.load(ref)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(reads, 1)
  assert.equal(loader.get(ref).state, 'ready')
  loader.load(ref) // no-op
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(reads, 1)
})

test('a failed read lands in the error state and notifies subscribers', async () => {
  const loader = new ImageLoader(async () => {
    throw new Error('storage unavailable')
  })
  const ref = refOf('c')
  let notified = 0
  loader.subscribe(ref.attachmentId, () => { notified += 1 })
  loader.load(ref)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(notified, 1)
  const state = loader.get(ref)
  assert.equal(state.state, 'error')
  if (state.state === 'error') assert.equal(state.error.message, 'storage unavailable')
  // A reload after invalidation retries.
  loader.invalidate(ref.attachmentId)
  assert.equal(loader.get(ref).state, 'idle')
})

test('clear drops every cached entry', () => {
  const loader = new ImageLoader(async () => ({ ref: {}, data: new Uint8Array([1]) }))
  loader.load(refOf('d'))
  loader.load(refOf('e'))
  // (settle asynchronously; clear() must still wipe the cache state)
  loader.clear()
  assert.equal(loader.cacheSize(), 0)
})

test('bytesToBase64 handles buffers larger than one chunk', () => {
  const big = new Uint8Array(0x10000)
  big[0] = 0xde
  big[0xffff] = 0xad
  assert.equal(bytesToBase64(big), Buffer.from(big).toString('base64'))
})

test('a SYNCHRONOUS read throw becomes an error state, never an escape', async () => {
  const loader = new ImageLoader(() => {
    throw new Error('service gone')
  })
  const ref = refOf('sync')
  loader.load(ref) // must not throw synchronously
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loader.get(ref).state, 'error')
})

test('the error map is bounded (long transcripts cannot grow it unboundedly)', async () => {
  const loader = new ImageLoader(async () => {
    throw new Error('boom')
  })
  for (let index = 0; index < 100; index += 1) {
    loader.load(refOf(`f${index}`))
  }
  await new Promise(resolve => setTimeout(resolve, 30))
  // Only the newest 64 failures are retained; the oldest are gone.
  assert.equal(loader.get(refOf('f0')).state, 'idle')
  assert.notEqual(loader.get(refOf('f99')).state, 'idle')
})

test('replacing an entry with a different size keeps bytesHeld exact (round-3 finding 1)', () => {
  const cache = new ImageCache(10, 1024 * 1024)
  cache.set('a', { state: 'ready', bytes: new Uint8Array(100), base64: 'x', byteLength: 100 })
  const before = cache.bytes()
  cache.set('a', { state: 'ready', bytes: new Uint8Array(50), base64: 'x', byteLength: 50 })
  const after = cache.bytes()
  assert.ok(before > after, `replacement shrinks held bytes (${before} → ${after})`)
  // Exact: one entry of 50 bytes + ~33% base64 overhead.
  assert.equal(after, Math.ceil(50 + 50 * 1.33))
})

test('an invalidate during an in-flight read drops the stale settle (round-4 finding 4)', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const loader = new ImageLoader(async () => {
    await gate
    return { ref: {}, data: new Uint8Array([7, 7]) }
  })
  const ref = refOf('stale')
  loader.load(ref)
  await new Promise(resolve => setTimeout(resolve, 5)) // the read is now awaiting the gate
  assert.equal(loader.get(ref).state, 'loading')
  loader.invalidate(ref.attachmentId) // bump the epoch while in flight
  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  // The stale settle must NOT repopulate the cache.
  assert.equal(loader.get(ref).state, 'idle')
  // A fresh load works normally.
  loader.load(ref)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loader.get(ref).state, 'ready')
})

test('settle fan-out is per-attachment (review finding 8)', async () => {
  const loader = new ImageLoader(async (ref) => {
    await new Promise(resolve => setTimeout(resolve, 5))
    return { ref: {}, data: new Uint8Array([ref.attachmentId.charCodeAt(0)]) }
  })
  let aNotified = 0
  let bNotified = 0
  loader.subscribe('a', () => { aNotified += 1 })
  loader.subscribe('b', () => { bNotified += 1 })
  loader.load(refOf('a'))
  loader.load(refOf('b'))
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(aNotified, 1, 'a settles exactly once')
  assert.equal(bNotified, 1, 'b settles exactly once')
  assert.equal(loader.listenerCount(), 2)
  // clear() broadcasts globally.
  loader.clear()
  assert.equal(loader.listenerCount(), 2, 'listeners survive a clear')
})

test('unsubscribing removes only that attachment listener', () => {
  const loader = new ImageLoader(async () => ({ ref: {}, data: new Uint8Array([1]) }))
  const offA = loader.subscribe('a', () => {})
  const offB = loader.subscribe('b', () => {})
  assert.equal(loader.listenerCount(), 2)
  offA()
  assert.equal(loader.listenerCount(), 1, 'a removed, b stays')
  offB()
  assert.equal(loader.listenerCount(), 0, 'the empty per-id set is pruned')
})

test('invalidating one attachment never discards an unrelated in-flight settle (review finding 3)', async () => {
  let releaseA!: () => void
  const gateA = new Promise<void>(resolve => { releaseA = resolve })
  const reads: string[] = []
  const loader = new ImageLoader(async (ref) => {
    reads.push(ref.attachmentId)
    if (ref.attachmentId === 'a') await gateA
    return { ref: {}, data: new Uint8Array([1]) }
  })
  loader.load(refOf('a'))
  loader.load(refOf('b'))
  await new Promise(resolve => setTimeout(resolve, 5))
  loader.invalidate('a') // bumps ONLY a's generation
  releaseA()
  await new Promise(resolve => setTimeout(resolve, 20))
  // b's settle survived the per-id invalidation; a's was discarded.
  assert.equal(loader.get(refOf('b')).state, 'ready', 'b settles despite invalidate(a)')
  assert.equal(loader.get(refOf('a')).state, 'idle', 'a is invalidated')
  // A fresh read of a works.
  loader.load(refOf('a'))
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loader.get(refOf('a')).state, 'ready')
})

test('clear() invalidates even attachments that were locally invalidated before (review finding)', async () => {
  let releaseA!: () => void
  const gateA = new Promise<void>(resolve => { releaseA = resolve })
  const loader = new ImageLoader(async (ref) => {
    if (ref.attachmentId === 'a') await gateA
    return { ref: {}, data: new Uint8Array([9]) }
  })
  const ref = refOf('a')
  loader.invalidate('a') // local generation for a
  loader.load(ref)       // captures the binary epoch {global:0, local:1}
  await new Promise(resolve => setTimeout(resolve, 5))
  loader.clear()         // global bump + per-id reset
  releaseA()
  await new Promise(resolve => setTimeout(resolve, 20))
  // The pre-clear read must NOT repopulate the cache after a clear.
  assert.equal(loader.get(ref).state, 'idle', 'a clear wins over a stale local epoch')
  // A fresh load works.
  loader.load(ref)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loader.get(ref).state, 'ready')
})
