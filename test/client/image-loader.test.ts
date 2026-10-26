/**
 * M8 tests: the bounded LRU image cache and the async loader (dedupe,
 * state transitions, subscriber notification, error state) — plan §16.
 * @module @xmoon76/dsh-pi-tui/image-loader.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ImageCache } from '../../src/client/media/image/cache.ts'
import { bytesToBase64, ImageLoader } from '../../src/client/media/image/loader.ts'
import {
  MAX_KITTY_THUMBNAIL_SOURCE_BYTES,
  KittyThumbnailOutputTooLargeError,
  type KittyThumbnailConverter,
  type KittyThumbnailPng,
} from '../../src/client/media/image/kitty-thumbnail.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'

function refOf(id: string, bytes = 3): ImageAttachmentRefLike {
  return { attachmentId: id, mediaType: 'image/png', bytes, width: 1, height: 1, name: `${id}.png` }
}

/** A JPEG/WebP ref (the only media types the preview scheduler accepts). */
function previewRefOf(
  id: string,
  mediaType: 'image/jpeg' | 'image/webp' = 'image/jpeg',
  bytes = 3,
): ImageAttachmentRefLike {
  return { attachmentId: id, mediaType, bytes, width: 40, height: 30, name: `${id}.jpg` }
}

function derived(width = 40, height = 30): KittyThumbnailPng {
  return { base64: 'iVBORw0KGgo=', width, height, byteLength: 8 }
}

/** Flush the loader's microtask/timer-adjacent settles deterministically. */
function flush(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

function previewLoader(
  convert: KittyThumbnailConverter,
  cache = new ImageCache(64, 64 * 1024 * 1024),
): ImageLoader {
  return new ImageLoader(async () => ({ ref: {}, data: new Uint8Array([1, 2, 3]) }), cache, convert)
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

test('the read authority is the component-passed scope, never a re-resolved environment', async () => {
  const contexts: unknown[] = []
  const loader = new ImageLoader(async (_ref, context) => {
    contexts.push(context)
    return { ref: {}, data: new Uint8Array([1]) }
  })
  const childRef = refOf('child-only')
  const childScope = { key: 'child:1:child-session' }
  const parentScope = { key: 'main:1:parent-session' }
  // The component asks for the child's bytes carrying ITS OWN immutable scope...
  loader.load(childRef, childScope)
  // ...and a later render of another presentation cannot re-route that read: the
  // deferred callback still carries the scope the ASKING component passed.
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(contexts, [childScope],
    'the deferred read carries the component-passed scope, never a re-resolved subject')
  // The bytes landed in the ASKING scope only: another presentation has its own
  // (empty) scope and must issue its own authorized read.
  assert.equal(loader.get(childRef, parentScope).state, 'idle')
  assert.equal(loader.get(childRef, childScope).state, 'ready')
})

test('regression: a FAILURE belongs to the asking scope and is never served to another', async () => {
  const reads: unknown[] = []
  const loader = new ImageLoader(async (_ref, context) => {
    reads.push((context as { key: string }).key)
    // The child's own binding is gone: the real read fails for the CHILD.
    if ((context as { key: string }).key === 'child') throw new Error('no retained Session binding for the child')
    return { ref: {}, data: new Uint8Array([7]) }
  })
  const ref = refOf('shared-content')
  const childScope = { key: 'child' }
  const parentScope = { key: 'parent' }
  loader.load(ref, childScope)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loader.get(ref, childScope).state, 'error', 'the child sees its own failure')

  // The viewing parent asks for the SAME content-addressed ref.
  assert.equal(loader.get(ref, parentScope).state, 'idle',
    'the child\'s stale failure must NOT be served to the parent (the parent must issue its own read)')
  loader.load(ref, parentScope)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(reads, ['child', 'parent'],
    'the new scope performs its own read instead of inheriting the stale outcome')
  assert.equal(loader.get(ref, parentScope).state, 'ready')
})

test('regression: a cached MAIN image is NEVER reused for the child component that references the same id', async () => {
  const reads: unknown[] = []
  const loader = new ImageLoader(async (_ref, context) => {
    reads.push((context as { sessionId: string }).sessionId)
    return { ref: {}, data: new Uint8Array([42]) }
  })
  const mainScope = { sessionId: 'main-session', key: 'main:1:main-session' }
  const childScope = { sessionId: 'child-session', key: 'child:7:child-session' }
  const shared = refOf('sha256:same-content')
  // The main presentation authorized and cached these bytes for the MAIN Session.
  loader.load(shared, mainScope)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loader.get(shared, mainScope).state, 'ready')
  assert.deepEqual(reads, ['main-session'])

  // A child transcript component whose ref is the SAME content-addressed id.
  assert.equal(loader.get(shared, childScope).state, 'idle',
    'the main authorization must not satisfy the child presentation')
  loader.load(shared, childScope)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(reads, ['main-session', 'child-session'],
    'the child MUST perform its own Session read (the official per-Session authorization is never bypassed)')
  const childState = loader.get(shared, childScope)
  assert.ok(childState.state === 'ready' && childState.bytes[0] === 42, 'the child serves its own resolved bytes')
  // The parent's state is untouched by the child's settle.
  assert.equal(loader.get(shared, mainScope).state, 'ready')
})

test('regression: a same-id binding rollover (new scope, same session id) must not reuse the retired entry', async () => {
  let reads = 0
  const loader = new ImageLoader(async () => { reads += 1; return { ref: {}, data: new Uint8Array([3]) } })
  const ref = refOf('sha256:rollover')
  const first = { sessionId: 'child-session', key: 'child:1:child-session' }
  const second = { sessionId: 'child-session', key: 'child:2:child-session' }
  loader.load(ref, first)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(reads, 1)

  // Exit + reopen the SAME child: the Client retains a NEW binding generation, so
  // the presentation scope is new even though the session id is identical.
  assert.equal(loader.get(ref, second).state, 'idle',
    'the retired generation\'s entry must not be reused by the replacement binding')
  loader.load(ref, second)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(reads, 2, 'the new binding generation issues its own read')
  assert.equal(loader.get(ref, first).state, 'ready', 'the retired scope keeps its own entry')
})

test('regression: bytes stay shared WITHIN one scope, with same-scope dedupe', async () => {
  let reads = 0
  const loader = new ImageLoader(async () => { reads += 1; return { ref: {}, data: new Uint8Array([9]) } })
  const scope = { sessionId: 'child-session', key: 'child:1:child-session' }
  const ref = refOf('shared-bytes')
  // Same scope: the concurrent loads dedupe into ONE read.
  loader.load(ref, scope)
  loader.load(ref, scope)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(reads, 1, 'one underlying read per attachment for the same presentation')
  assert.equal(loader.get(ref, scope).state, 'ready')
  // A plain re-render of the SAME presentation reuses the entry (no second read).
  loader.load(ref, scope)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(reads, 1, 'the same presentation reuses its own authorized bytes')
})

test('regression: a settle is delivered only to its OWN scope\'s subscribers, and a sibling scope sees only its own state', async () => {
  let releaseRead!: () => void
  const gate = new Promise<void>(resolve => { releaseRead = resolve })
  let reads = 0
  const loader = new ImageLoader(async (_ref, context) => {
    reads += 1
    if ((context as { key: string }).key === 'child') await gate
    return { ref: {}, data: new Uint8Array([5]) }
  })
  const ref = refOf('sha256:dual-subject')
  const childScope = { key: 'child' }
  const parentScope = { key: 'parent' }
  let childNotifies = 0
  let parentNotifies = 0
  const offChild = loader.subscribe(ref.attachmentId, () => { childNotifies += 1 }, childScope)
  const offParent = loader.subscribe(ref.attachmentId, () => { parentNotifies += 1 }, parentScope)

  // The CHILD's read settles while it is held.
  loader.load(ref, childScope)
  loader.load(ref, parentScope)
  await new Promise(resolve => setTimeout(resolve, 10))
  releaseRead()
  await new Promise(resolve => setTimeout(resolve, 10))

  assert.equal(reads, 2, 'each presentation performs exactly one authorized read')
  assert.equal(loader.get(ref, childScope).state, 'ready')
  assert.ok(childNotifies >= 1, 'the child scope\'s subscriber hears its own settle')
  assert.equal(loader.get(ref, parentScope).state, 'ready', 'the parent resolves independently')
  const parentNotifiesAfterOwnSettle = parentNotifies
  assert.ok(parentNotifiesAfterOwnSettle >= 1)
  // A late child-scope settle must not wake the parent scope\'s subscriber again.
  const before = parentNotifies
  loader.load(ref, childScope)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(parentNotifies, before, 'the child\'s settle never wakes the parent\'s subscriber')
  offChild()
  offParent()
})

test('object-scope: invalidate(id) reaches an OBJECT scope (ready -> idle + fresh read) and leaves its subscriber alone', async () => {
  const reads: string[] = []
  const loader = new ImageLoader(async ref => {
    reads.push(String(ref.attachmentId))
    return { ref: {}, data: new Uint8Array([1]) }
  })
  const scope = { key: 'child:1:A' }
  const ref = refOf('obj-invalidate')
  let wakes = 0
  const off = loader.subscribe(ref.attachmentId, () => { wakes += 1 }, scope)
  loader.load(ref, scope)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loader.get(ref, scope).state, 'ready')
  assert.deepEqual(reads, ['obj-invalidate'], 'the first load performed exactly one read')
  const wakesAfterSettle = wakes
  assert.ok(wakesAfterSettle >= 1, "the object scope's subscriber heard its own settle")

  loader.invalidate(ref.attachmentId)
  assert.equal(loader.get(ref, scope).state, 'idle',
    "invalidate(id) must drop an OBJECT scope's ready entry, not only unscoped ones")
  assert.equal(wakes, wakesAfterSettle,
    'invalidate(id) is not a broadcast: the object scope subscriber is untouched by it')

  loader.load(ref, scope)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(reads, ['obj-invalidate', 'obj-invalidate'],
    'the invalidated object scope performs a FRESH read')
  assert.equal(loader.get(ref, scope).state, 'ready')
  off()
})

test('object-scope: clear() drops OBJECT-scope state, broadcasts to its subscriber, and listenerCount() counts it', async () => {
  const loader = new ImageLoader(async ref => {
    if (ref.attachmentId === 'obj-clear-error') throw new Error('child scope failure')
    return { ref: {}, data: new Uint8Array([2]) }
  })
  const scope = { key: 'child:1:A' }
  const readyRef = refOf('obj-clear-ready')
  const errorRef = refOf('obj-clear-error')
  let wakes = 0
  const off = loader.subscribe(readyRef.attachmentId, () => { wakes += 1 }, scope)
  assert.equal(loader.listenerCount(), 1,
    "listenerCount() must count an OBJECT scope's subscriber (previously 0)")
  loader.load(readyRef, scope)
  loader.load(errorRef, scope)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loader.get(readyRef, scope).state, 'ready')
  assert.equal(loader.get(errorRef, scope).state, 'error')
  const wakesAfterSettles = wakes
  assert.equal(wakesAfterSettles, 1, 'only the subscribed attachment wakes its listener')

  loader.clear()
  assert.equal(loader.get(readyRef, scope).state, 'idle',
    "clear() must drop an OBJECT scope's ready entry")
  assert.equal(loader.get(errorRef, scope).state, 'idle',
    "clear() must drop an OBJECT scope's recorded error")
  assert.equal(wakes, wakesAfterSettles + 1,
    "clear() broadcasts exactly one wake to the OBJECT scope's subscriber")
  assert.equal(loader.listenerCount(), 1, 'the object scope subscriber survives clear()')
  off()
  assert.equal(loader.listenerCount(), 0, 'unsubscribing removes the object scope listener')
})

test('object-scope: clear() discards an in-flight settle in one scope without disturbing another scope', async () => {
  const gates: Array<() => void> = []
  const loader = new ImageLoader(async () => {
    await new Promise<void>(resolve => { gates.push(resolve) })
    return { ref: {}, data: new Uint8Array([5]) }
  })
  const s1 = { key: 'child:1:A' }
  const s2 = { key: 'child:2:A' }
  const ref = refOf('obj-inflight')
  loader.load(ref, s1)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(loader.get(ref, s1).state, 'loading')
  loader.clear() // global bump while s1's read is in flight
  gates.shift()!() // s1's read settles AFTER the clear
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(loader.get(ref, s1).state, 'idle',
    "a clear() must prevent the OBJECT scope's in-flight settle from repopulating it")

  // The OTHER scope is unaffected: a read started after the clear still resolves
  // its own bytes, and s1 stays empty (no shared state).
  loader.load(ref, s2)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(loader.get(ref, s2).state, 'loading')
  gates.shift()!()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(loader.get(ref, s2).state, 'ready', 'the other scope resolves independently')
  assert.equal(loader.get(ref, s1).state, 'idle', 'the other scope never borrows s2 bytes')
})

test('object-scope: two scopes never share bytes, failures or subscribers (both directions)', async () => {
  const loader = new ImageLoader(async (_ref, scope) => {
    if ((scope as { key: string }).key === 'child:1:A') throw new Error('A failed')
    return { ref: {}, data: new Uint8Array([9]) }
  })
  const sA = { key: 'child:1:A' }
  const sB = { key: 'child:1:B' }
  const ref = refOf('obj-shared')
  let wakesA = 0
  let wakesB = 0
  const offA = loader.subscribe(ref.attachmentId, () => { wakesA += 1 }, sA)
  const offB = loader.subscribe(ref.attachmentId, () => { wakesB += 1 }, sB)

  loader.load(ref, sA)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loader.get(ref, sA).state, 'error')
  assert.equal(loader.get(ref, sB).state, 'idle', "A's failure must not appear in B")
  assert.equal(wakesA, 1, "A's own settle wakes A")
  assert.equal(wakesB, 0, "A's settle must NOT wake B's subscriber")

  loader.load(ref, sB)
  await new Promise(resolve => setTimeout(resolve, 10))
  const stateB = loader.get(ref, sB)
  assert.equal(stateB.state, 'ready')
  assert.deepEqual(stateB.state === 'ready' ? stateB.bytes : undefined, new Uint8Array([9]),
    'B owns its own bytes')
  assert.equal(loader.get(ref, sA).state, 'error', "B's success must not overwrite A's own state")
  assert.equal(wakesA, 1, "B's settle must NOT wake A's subscriber again")
  assert.equal(wakesB, 1, "B's own settle wakes B")
  offA()
  offB()
})

// ---------------------------------------------------------------------------
// Image-6A: per-scope preview derivatives (Kitty JPEG/WebP → PNG)
// ---------------------------------------------------------------------------

test('preview scheduling waits for a READY same-scope source and dedupes requests', async () => {
  let calls = 0
  let release!: () => void
  const convert: KittyThumbnailConverter = () => {
    calls += 1
    return new Promise<KittyThumbnailPng>(resolve => { release = () => resolve(derived()) })
  }
  const loader = previewLoader(convert)
  const ref = previewRefOf('preview-dedupe')
  // No raw source yet: the preview must not start (and must not re-read).
  loader.loadKittyThumbnail(ref)
  assert.equal(loader.getKittyThumbnail(ref).state, 'idle')
  assert.equal(calls, 0)
  let notifies = 0
  loader.subscribe(ref.attachmentId, () => { notifies += 1 })
  loader.load(ref)
  await flush()
  // Two occurrence renders request the same (scope, id): ONE conversion.
  loader.loadKittyThumbnail(ref)
  loader.loadKittyThumbnail(ref)
  await flush()
  assert.equal(loader.getKittyThumbnail(ref).state, 'loading')
  assert.equal(calls, 1)
  release()
  await flush()
  const state = loader.getKittyThumbnail(ref)
  assert.equal(state.state, 'ready')
  if (state.state === 'ready') {
    assert.equal(state.width, 40)
    assert.equal(state.base64, derived().base64)
  }
  assert.equal(calls, 1, 'a READY (and loading) preview never converts again')
  assert.equal(notifies, 2, 'raw settle then preview settle, one wake each')
})

test('a converter failure records a bounded decode-failed state and keeps the native error', async () => {
  const native = new Error('libvips exploded while decoding')
  const loader = previewLoader(async () => { throw native })
  const ref = previewRefOf('preview-fail')
  loader.load(ref)
  await flush()
  loader.loadKittyThumbnail(ref)
  await flush()
  const state = loader.getKittyThumbnail(ref)
  assert.equal(state.state, 'error')
  if (state.state === 'error') {
    assert.equal(state.reason, 'decode-failed')
    assert.equal(state.error, native, 'the real error stays diagnosable inside the loader state')
  }
  assert.equal(loader.isReady(ref), true, 'the source attachment read is unaffected by a preview failure')
})

test('an over-budget derived PNG is classified output-too-large in both forms', async () => {
  // 1) the real decoder's typed failure
  const typed = previewLoader(async () => { throw new KittyThumbnailOutputTooLargeError(5 * 1024 * 1024) })
  const a = previewRefOf('preview-output-typed')
  typed.load(a)
  await flush()
  typed.loadKittyThumbnail(a)
  await flush()
  const typedState = typed.getKittyThumbnail(a)
  assert.equal(typedState.state, 'error')
  if (typedState.state === 'error') assert.equal(typedState.reason, 'output-too-large')

  // 2) an injected converter that RETURNS an oversized PNG (cache-admission seam)
  const injected = previewLoader(async () => ({
    base64: 'AAAA',
    width: 40,
    height: 30,
    byteLength: 4 * 1024 * 1024 + 1,
  }))
  const b = previewRefOf('preview-output-returned')
  injected.load(b)
  await flush()
  injected.loadKittyThumbnail(b)
  await flush()
  const injectedState = injected.getKittyThumbnail(b)
  assert.equal(injectedState.state, 'error')
  if (injectedState.state === 'error') assert.equal(injectedState.reason, 'output-too-large')
  assert.equal(injected.kittyThumbnailCacheSize(), 0, 'an over-budget derivative is never cached READY')
})

test('the REAL source byte length is checked after READY (not only the ref metadata)', async () => {
  let calls = 0
  const bytes = new Uint8Array(MAX_KITTY_THUMBNAIL_SOURCE_BYTES + 1)
  const loader = new ImageLoader(
    async () => ({ ref: {}, data: bytes }),
    new ImageCache(),
    async () => { calls += 1; return derived() },
  )
  const ref = previewRefOf('preview-real-bytes', 'image/jpeg', 1) // ref.bytes lies low on purpose
  loader.load(ref)
  await flush()
  loader.loadKittyThumbnail(ref)
  await flush()
  const state = loader.getKittyThumbnail(ref)
  assert.equal(state.state, 'error')
  if (state.state === 'error') assert.equal(state.reason, 'input-too-large')
  assert.equal(calls, 0, 'an over-budget source never reaches the decoder')
})

test('at most two conversions run and the 33rd queued request reports busy', async () => {
  const pending: Array<() => void> = []
  let active = 0
  let maxActive = 0
  const convert: KittyThumbnailConverter = () => new Promise<KittyThumbnailPng>(resolve => {
    active += 1
    maxActive = Math.max(maxActive, active)
    pending.push(() => { active -= 1; resolve(derived()) })
  })
  const loader = previewLoader(convert)
  const refs = Array.from({ length: 35 }, (_value, index) => previewRefOf(`preview-queue-${index}`))
  for (const ref of refs) loader.load(ref)
  await flush()
  assert.equal(loader.cacheSize(), 35, 'all sources are READY before any preview is requested')
  for (const ref of refs) loader.loadKittyThumbnail(ref)
  await flush()
  assert.equal(maxActive, 2, 'no more than two sharp jobs run at once')
  // 2 running + 32 queued were admitted; the 35th request is over capacity.
  const busy = loader.getKittyThumbnail(refs[34]!)
  assert.equal(busy.state, 'error')
  if (busy.state === 'error') assert.equal(busy.reason, 'busy')
  assert.equal(loader.getKittyThumbnail(refs[33]!).state, 'loading',
    'the last admitted queue slot still waits instead of failing')

  while (pending.length > 0) {
    pending.shift()!()
    await flush()
  }
  await flush()
  // The admitted burst all converted, but the READY cache keeps its own 16-item
  // LRU bound; the rest were evicted (they still converted exactly once).
  assert.equal(loader.kittyThumbnailCacheSize(), 16, 'the burst settles within the READY cache bound')
  assert.equal(maxActive, 2, 'the whole burst never exceeded the concurrency cap')
})

test('same attachmentId in different presentation scopes derives independently', async () => {
  const inputs: string[] = []
  const convert: KittyThumbnailConverter = async (input) => {
    inputs.push(String(input[0]))
    return derived()
  }
  const loader = new ImageLoader(
    async (_ref, scope) => ({ ref: {}, data: new Uint8Array([(scope as { key: string }).key === 'A' ? 7 : 9]) }),
    new ImageCache(),
    convert,
  )
  const ref = previewRefOf('preview-scopes')
  const scopeA = { key: 'A' }
  const scopeB = { key: 'B' }
  loader.load(ref, scopeA)
  loader.load(ref, scopeB)
  await flush()
  loader.loadKittyThumbnail(ref, scopeA)
  loader.loadKittyThumbnail(ref, scopeB)
  await flush()
  assert.equal(inputs.length, 2, 'each scope projects its OWN authorized bytes')
  assert.deepEqual(inputs, ['7', '9'])
  assert.equal(loader.getKittyThumbnail(ref, scopeA).state, 'ready')
  assert.equal(loader.getKittyThumbnail(ref, scopeB).state, 'ready')
})

test('invalidate(id) retires a running conversion but allows a fresh one', async () => {
  const releases: Array<() => void> = []
  let calls = 0
  const convert: KittyThumbnailConverter = () => {
    calls += 1
    return new Promise<KittyThumbnailPng>(resolve => { releases.push(() => resolve(derived(10, 10))) })
  }
  const loader = previewLoader(convert)
  const ref = previewRefOf('preview-invalidate')
  loader.load(ref)
  await flush()
  let notifies = 0
  loader.subscribe(ref.attachmentId, () => { notifies += 1 })
  loader.loadKittyThumbnail(ref)
  await flush()
  assert.equal(loader.getKittyThumbnail(ref).state, 'loading')
  loader.invalidate(ref.attachmentId)
  assert.equal(loader.getKittyThumbnail(ref).state, 'idle', 'invalidate drops the pending preview slot')
  releases.shift()!()
  await flush()
  assert.equal(loader.getKittyThumbnail(ref).state, 'idle', 'the stale settle never publishes')
  assert.equal(notifies, 0, 'invalidate is not a broadcast and the stale settle never wakes')
  // The same attachment may be read and converted again in the same scope.
  loader.load(ref)
  await flush()
  loader.loadKittyThumbnail(ref)
  await flush()
  assert.equal(loader.getKittyThumbnail(ref).state, 'loading')
  releases.shift()!()
  await flush()
  assert.equal(loader.getKittyThumbnail(ref).state, 'ready')
  assert.equal(calls, 2)
  assert.equal(notifies, 2, 'the fresh raw settle then the fresh preview settle wake exactly once each')
})

test('clear() drops queued/running preview state and its settle never wakes a component', async () => {
  let release!: () => void
  const loader = previewLoader(() => new Promise<KittyThumbnailPng>(resolve => {
    release = () => resolve(derived())
  }))
  const ref = previewRefOf('preview-clear')
  loader.load(ref)
  await flush()
  loader.loadKittyThumbnail(ref)
  await flush()
  assert.equal(loader.getKittyThumbnail(ref).state, 'loading')
  let notifies = 0
  loader.subscribe(ref.attachmentId, () => { notifies += 1 })
  loader.clear()
  assert.equal(notifies, 1, 'clear broadcasts the existing global invalidation')
  assert.equal(loader.getKittyThumbnail(ref).state, 'idle')
  release()
  await flush()
  assert.equal(loader.getKittyThumbnail(ref).state, 'idle', 'a pre-clear conversion can never publish')
  assert.equal(notifies, 1, 'the stale settle adds no wake')
  loader.load(ref)
  await flush()
  loader.loadKittyThumbnail(ref)
  await flush()
  release()
  await flush()
  assert.equal(loader.getKittyThumbnail(ref).state, 'ready', 'a post-clear request derives normally')
})

test('the preview LRU keeps at most 16 READY entries and a revisit re-derives', async () => {
  let calls = 0
  const loader = previewLoader(async () => { calls += 1; return derived() })
  const refs = Array.from({ length: 17 }, (_value, index) => previewRefOf(`preview-lru-${index}`))
  for (const ref of refs) loader.load(ref)
  await flush()
  for (const ref of refs) loader.loadKittyThumbnail(ref)
  await flush()
  assert.equal(calls, 17)
  assert.equal(loader.kittyThumbnailCacheSize(), 16, 'the 17th READY entry evicts the oldest')
  assert.equal(loader.getKittyThumbnail(refs[0]!).state, 'idle', 'the oldest derivative was evicted')
  loader.loadKittyThumbnail(refs[0]!)
  await flush()
  assert.equal(calls, 18, 'a revisit re-derives once')
  assert.equal(loader.getKittyThumbnail(refs[0]!).state, 'ready')
})

test('the preview cache enforces its 32 MiB base64 byte budget', async () => {
  const chunk = 'A'.repeat(3 * 1024 * 1024)
  const loader = previewLoader(async () => ({ base64: chunk, width: 10, height: 10, byteLength: 10 }))
  const refs = Array.from({ length: 11 }, (_value, index) => previewRefOf(`preview-bytes-${index}`))
  for (const ref of refs) loader.load(ref)
  await flush()
  for (const ref of refs) loader.loadKittyThumbnail(ref)
  await flush()
  assert.equal(loader.kittyThumbnailCacheSize(), 10, '33 MiB of base64 evicts down to the 32 MiB budget')
  assert.ok(loader.kittyThumbnailCacheBytes() <= 32 * 1024 * 1024)
  assert.equal(loader.getKittyThumbnail(refs[0]!).state, 'idle')
  assert.equal(loader.getKittyThumbnail(refs[10]!).state, 'ready')
})
