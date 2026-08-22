/**
 * M1 tests: the draft image store, the placeholder format, and the strict
 * placeholder expansion (plan §6 + the M1 acceptance matrix).
 * @module @xmoon76/dsh-pi-tui/image-placeholder.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { ImageTooLargeError } from '../src/image/errors.ts'
import { expandImagePlaceholders, formatImagePlaceholder, type DraftSegment } from '../src/image/placeholder.ts'
import type { DraftImage, DraftImageInput } from '../src/image/types.ts'

/** One canonical PNG-ish draft (bytes content is irrelevant to M1). */
function addImage(store: DraftImageStore, width = 800, height = 600, name?: string): DraftImage {
  const input: DraftImageInput = {
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: 'image/png',
    width,
    height,
    ...(name !== undefined ? { name } : {}),
  }
  return store.add(input)
}

function textOf(segments: readonly DraftSegment[]): string[] {
  return segments.filter(segment => segment.type === 'text').map(segment => (segment as Extract<DraftSegment, { type: 'text' }>).text)
}

test('formatImagePlaceholder emits the canonical [image #N (W×H)] shape', () => {
  assert.equal(formatImagePlaceholder(1, 1920, 1080), '[image #1 (1920×1080)]')
  assert.equal(formatImagePlaceholder(12, 800, 600), '[image #12 (800×600)]')
})

test('a single image alone expands to one image segment', () => {
  const store = new DraftImageStore()
  const image = addImage(store)
  const segments = expandImagePlaceholders(image.placeholder, store)
  assert.equal(segments.length, 1)
  assert.equal(segments[0]!.type, 'image')
})

test('text around a single image keeps order: text → image → text', () => {
  const store = new DraftImageStore()
  const image = addImage(store, 800, 600)
  const segments = expandImagePlaceholders(`foo ${image.placeholder} bar`, store)
  assert.deepEqual(textOf(segments), ['foo ', ' bar'])
  assert.deepEqual(segments.map(segment => segment.type), ['text', 'image', 'text'])
})

test('two images with text between and after keep both positions', () => {
  const store = new DraftImageStore()
  const one = addImage(store, 800, 600)
  const two = addImage(store, 640, 480)
  const segments = expandImagePlaceholders(`A ${one.placeholder} B ${two.placeholder} C`, store)
  assert.deepEqual(segments.map(segment => segment.type), ['text', 'image', 'text', 'image', 'text'])
  assert.equal(segments[1]!.type === 'image' && segments[1]!.image.id, one.id)
  assert.equal(segments[3]!.type === 'image' && segments[3]!.image.id, two.id)
})

test('adjacent images expand to image → image with no empty text segment', () => {
  const store = new DraftImageStore()
  const one = addImage(store, 800, 600)
  const two = addImage(store, 640, 480)
  const segments = expandImagePlaceholders(`${one.placeholder}${two.placeholder}`, store)
  assert.deepEqual(segments.map(segment => segment.type), ['image', 'image'])
  assert.equal(textOf(segments).length, 0)
})

test('a fake image id stays ordinary text', () => {
  const store = new DraftImageStore()
  const text = '[image #99 (800×600)]'
  const segments = expandImagePlaceholders(text, store)
  assert.deepEqual(segments, [{ type: 'text', text }])
})

test('hand-edited dimensions stop resolving (strict placeholder match)', () => {
  const store = new DraftImageStore()
  addImage(store, 800, 600)
  const edited = '[image #1 (999×999)]'
  const segments = expandImagePlaceholders(edited, store)
  assert.deepEqual(segments, [{ type: 'text', text: edited }])
})

test('a removed draft leaves its placeholder as plain text (missing attachment)', () => {
  const store = new DraftImageStore()
  const image = addImage(store, 800, 600)
  store.remove(image.id)
  const segments = expandImagePlaceholders(`see ${image.placeholder} now`, store)
  assert.deepEqual(segments, [{ type: 'text', text: `see ${image.placeholder} now` }])
})

test('unicode around a placeholder is preserved verbatim', () => {
  const store = new DraftImageStore()
  const image = addImage(store, 800, 600)
  const text = `分析 ${image.placeholder} 的差异 🔍`
  const segments = expandImagePlaceholders(text, store)
  assert.deepEqual(textOf(segments), ['分析 ', ' 的差异 🔍'])
  assert.equal(segments[1]!.type, 'image')
})

test('the same placeholder text appearing twice expands to two image segments', () => {
  const store = new DraftImageStore()
  const image = addImage(store, 800, 600)
  const text = `${image.placeholder} and again ${image.placeholder}`
  const segments = expandImagePlaceholders(text, store)
  assert.deepEqual(segments.map(segment => segment.type), ['image', 'text', 'image'])
})

test('empty text expands to no segments; whitespace-only stays one text segment', () => {
  const store = new DraftImageStore()
  assert.deepEqual(expandImagePlaceholders('', store), [])
  assert.deepEqual(expandImagePlaceholders('   ', store), [{ type: 'text', text: '   ' }])
})

test('an empty store keeps the whole text as one segment', () => {
  const store = new DraftImageStore()
  assert.deepEqual(expandImagePlaceholders('plain prompt', store), [{ type: 'text', text: 'plain prompt' }])
})

test('draft ids increment and drafts are addressable by id', () => {
  const store = new DraftImageStore()
  const one = store.add({ bytes: new Uint8Array([1]), mediaType: 'image/png', width: 1, height: 1 })
  const two = store.add({ bytes: new Uint8Array([2]), mediaType: 'image/jpeg', width: 2, height: 2 })
  assert.equal(one.id, 1)
  assert.equal(two.id, 2)
  assert.equal(store.get(1), one)
  assert.equal(store.get(2), two)
  assert.equal(store.get(3), undefined)
  assert.equal(store.size(), 2)
})

test('clear drops every draft; remove reports membership', () => {
  const store = new DraftImageStore()
  const one = addImage(store, 1, 1)
  const two = addImage(store, 2, 2)
  assert.equal(store.remove(one.id), true)
  assert.equal(store.remove(one.id), false)
  assert.equal(store.size(), 1)
  store.clear()
  assert.equal(store.size(), 0)
  assert.equal(store.get(two.id), undefined)
  assert.deepEqual(store.values(), [])
})

test('draft byteLength mirrors the staged bytes', () => {
  const store = new DraftImageStore()
  const image = store.add({ bytes: new Uint8Array([9, 9, 9]), mediaType: 'image/gif', width: 3, height: 3 })
  assert.equal(image.byteLength, 3)
})

test('the draft store enforces its entry and byte caps (plan §21)', () => {
  const store = new DraftImageStore(2, 100)
  store.add({ bytes: new Uint8Array(10), mediaType: 'image/png', width: 1, height: 1 })
  store.add({ bytes: new Uint8Array(10), mediaType: 'image/png', width: 1, height: 1 })
  assert.throws(
    () => store.add({ bytes: new Uint8Array(10), mediaType: 'image/png', width: 1, height: 1 }),
    /Too many staged images/,
  )
  const tight = new DraftImageStore(4, 15)
  tight.add({ bytes: new Uint8Array(10), mediaType: 'image/png', width: 1, height: 1 })
  assert.throws(
    () => tight.add({ bytes: new Uint8Array(10), mediaType: 'image/png', width: 1, height: 1 }),
    ImageTooLargeError,
  )
  // Removing frees the budget again.
  const image = tight.values()[0]!
  tight.remove(image.id)
  tight.add({ bytes: new Uint8Array(10), mediaType: 'image/png', width: 1, height: 1 })
  assert.equal(tight.size(), 1)
})

test('a recalled draft stages without local bytes and reuses its durable ref', () => {
  const store = new DraftImageStore()
  const ref = { attachmentId: 'att-9', mediaType: 'image/png' as const, bytes: 1234, width: 800, height: 600, name: 'old.png' }
  const draft = store.add({ mediaType: ref.mediaType, width: ref.width, height: ref.height, source: { type: 'recalled' }, recalledRef: ref })
  assert.equal(draft.source.type, 'recalled')
  assert.equal(draft.recalledRef?.attachmentId, 'att-9')
  assert.equal(draft.byteLength, 1234)
  assert.equal(draft.bytes.byteLength, 0, 'no local copy')
  assert.equal(draft.placeholder, '[image #1 (800×600)]')
  // The placeholder resolves against the store like any draft.
  const segments = expandImagePlaceholders(draft.placeholder, store)
  assert.equal(segments[0]!.type, 'image')
  // Removing frees the (conservative) byte budget.
  store.remove(draft.id)
  assert.equal(store.size(), 0)
})
