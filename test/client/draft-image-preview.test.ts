/**
 * Image UX PR1 tests: the composer draft-image preview projection (Owner
 * revision 2026-10-23: ONE card, last referenced occurrence, 44×3 wide /
 * 22×3 split, one identity row + `x` control, one-line summary fallback).
 * @module @xmoon76/dsh-pi-tui/draft-image-preview.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Image, resetCapabilitiesCache, setCapabilities, visibleWidth } from '@xmoon76/pi-tui'
import {
  DRAFT_PREVIEW_MAX_PIXEL_BYTES,
  DRAFT_PREVIEW_WIDE_CARD_WIDTH,
  DraftImagePreview,
} from '../../src/tui/components/media/draft-image-preview.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import {
  convertKittyThumbnail,
  type KittyThumbnailConverter,
  type KittyThumbnailPng,
} from '../../src/client/media/image/kitty-thumbnail.ts'
import type { DraftImage, DraftImagePreviewSource } from '../../src/client/media/image/types.ts'
import type { ImageGraphics } from '../../src/tui/graphics/native-image.ts'
import type { DraftImageOccurrence } from '../../src/client/media/image/placeholder.ts'
import { color } from '../../src/tui/theme/runtime.ts'

const THEME = { fallbackColor: (text: string) => text }

const SAMPLE_JPEG = readFileSync(new URL('../fixtures/images/transcript-sample.jpg', import.meta.url))
const SAMPLE_WEBP = readFileSync(new URL('../fixtures/images/transcript-sample.webp', import.meta.url))
const ORIENTED_JPEG = readFileSync(new URL('../fixtures/images/transcript-oriented.jpg', import.meta.url))
const CORRUPT_JPEG = readFileSync(new URL('../fixtures/images/transcript-corrupt.jpg', import.meta.url))

/** Wait for an authoritative component state, not a wall-clock window. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
}

function addImage(
  store: DraftImageStore,
  overrides: { mediaType?: DraftImage['mediaType']; width?: number; height?: number; bytes?: Uint8Array; name?: string } = {},
): DraftImage {
  return store.add({
    bytes: overrides.bytes ?? pngBytes(),
    mediaType: overrides.mediaType ?? 'image/png',
    width: overrides.width ?? 800,
    height: overrides.height ?? 100,
    ...(overrides.name === undefined ? {} : { name: overrides.name }),
  })
}

interface PreviewHarness {
  component: DraftImagePreview
  setDraft(text: string): void
  /** How many times the component asked the owning surface for a frame. */
  renders(): number
}

function harness(
  store: DraftImageStore,
  options: {
    draft?: string
    maxRows?: number
    fullscreen?: boolean
    removable?: (occurrence: DraftImageOccurrence) => boolean
    convertThumbnail?: KittyThumbnailConverter
    graphics?: ImageGraphics
  } = {},
): PreviewHarness {
  let draft = options.draft ?? ''
  let requested = 0
  const source: DraftImagePreviewSource = { values: () => store.values() }
  const component = new DraftImagePreview({
    getDraftText: () => draft,
    source,
    maxRows: () => options.maxRows ?? 4,
    fullscreenMouse: () => options.fullscreen ?? false,
    requestRender: () => { requested += 1 },
    ...(options.removable === undefined ? {} : { removable: options.removable }),
    ...(options.graphics === undefined ? {} : { graphics: options.graphics }),
  }, THEME, options.convertThumbnail)
  return { component, setDraft: (text: string) => { draft = text }, renders: () => requested }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/** The component's bounded derived-presentation state (white-box assertions). */
function internals(component: DraftImagePreview): {
  draftGeneration: number
  draftCandidate: DraftImage | undefined
  draftReady: { image: DraftImage; png: KittyThumbnailPng } | undefined
  draftFailed: DraftImage | undefined
  activeDraftConversion: { image: DraftImage } | undefined
  imageCache: Map<string, Image>
  base64Cache: Map<string, string>
} {
  return component as unknown as {
    draftGeneration: number
    draftCandidate: DraftImage | undefined
    draftReady: { image: DraftImage; png: KittyThumbnailPng } | undefined
    draftFailed: DraftImage | undefined
    activeDraftConversion: { image: DraftImage } | undefined
    imageCache: Map<string, Image>
    base64Cache: Map<string, string>
  }
}

/** The pixel dimensions the fork `Image` instance was built with. */
function imageDimensions(image: Image): { widthPx: number; heightPx: number } {
  return (image as unknown as { dimensions: { widthPx: number; heightPx: number } }).dimensions
}

/** The only cached `Image` payload (the visible card owns at most one). */
function onlyCachedImage(component: DraftImagePreview): Image {
  const cached = [...internals(component).imageCache.values()]
  assert.equal(cached.length, 1, `exactly one cached card Image, got ${cached.length}`)
  return cached[0]!
}

test('no referenced image renders no band; removing the token hides it', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = addImage(store)
  const { component, setDraft } = harness(store)
  assert.deepEqual(component.render(100), [])
  setDraft(`hello ${image.placeholder}`)
  assert.ok(component.render(100).length > 0)
  setDraft('hello')
  assert.deepEqual(component.render(100), [])
  assert.equal(component.hitMap(), undefined)
})

test('one image renders one identity row above its 44×3 card (wide)', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = addImage(store, { name: 'shot.png' })
  const { component, setDraft } = harness(store)
  setDraft(image.placeholder)
  const lines = component.render(100)
  assert.ok(lines.length >= 2 && lines.length <= 4, `bounded band: ${lines.length}`)
  assert.ok(stripAnsi(lines[0]!).startsWith('🖼️ #1/1 · 800×100 · 8 B'), `identity first: ${stripAnsi(lines[0]!)}`)
  const imageLine = lines.find(line => line.includes('\x1b_G'))
  assert.ok(imageLine !== undefined, 'kitty sequence present')
  assert.match(imageLine, /c=44(?:,|\b)/, 'wide card is 44 cells')
  assert.ok(!lines.join('\n').includes('shot.png'), 'renderable identity stays concise')
  assert.equal(component.hitMap()?.height, lines.length)
  assert.deepEqual(component.hitMap()?.removes, [])
})

test('split widths use the 22×3 card', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = addImage(store)
  const { component, setDraft } = harness(store)
  setDraft(image.placeholder)
  const lines = component.render(60)
  const imageLine = lines.find(line => line.includes('\x1b_G'))
  assert.ok(imageLine !== undefined)
  assert.match(imageLine, /c=22(?:,|\b)/, 'split card is 22 cells')
})

test('the LAST referenced occurrence is the previewed card', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const one = addImage(store, { name: 'one.png' })
  const two = addImage(store, { width: 640, height: 480, name: 'two.png' })
  const { component, setDraft } = harness(store)
  setDraft(`${one.placeholder} ${two.placeholder}`)
  const lines = component.render(100)
  const identity = stripAnsi(lines[0]!)
  assert.ok(identity.includes(`#${two.id}/2`), `last occurrence identity: ${identity}`)
  assert.ok(identity.includes('640×480'), 'last occurrence dimensions')
  assert.ok(identity.includes('+1'), 'remaining occurrence count')
  assert.ok(!identity.includes(`#${one.id}/`), 'the first occurrence is not the card')
})

test('a narrow width renders the one-line summary without a card or control', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const one = addImage(store)
  const two = addImage(store, { width: 640, height: 480 })
  const { component, setDraft } = harness(store, { fullscreen: true })
  setDraft(`${one.placeholder} ${two.placeholder}`)
  const lines = component.render(49)
  assert.equal(lines.length, 1)
  assert.ok(lines[0]!.includes('🖼️ 2 images attached'), stripAnsi(lines[0]!))
  assert.ok(lines[0]!.includes(`#${two.id} 640×480`), 'summary carries the latest identity')
  assert.ok(!lines[0]!.includes('\x1b_G'), 'no graphics escape')
  assert.ok(!stripAnsi(lines[0]!).endsWith('x'), 'no fake compact removal control')
  assert.deepEqual(component.hitMap()?.removes, [])
})

test('a one-to-three-row grant renders the summary, not a card', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = addImage(store)
  for (const maxRows of [1, 2, 3]) {
    const lines = harness(store, { maxRows, draft: image.placeholder }).component.render(100)
    assert.equal(lines.length, 1, `${maxRows}-row grant is the summary`)
    assert.ok(lines[0]!.includes('1 image attached'))
    assert.ok(!lines[0]!.includes('#1/1'), 'no card identity')
  }
})

test('fullscreen draws the width-safe x at the far right with an exact hit', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = addImage(store)
  const { component, setDraft } = harness(store, { fullscreen: true })
  const text = image.placeholder
  setDraft(text)
  const lines = component.render(100)
  const identity = lines[0]!
  assert.ok(stripAnsi(identity).endsWith('x'), `ASCII x control: ${stripAnsi(identity)}`)
  assert.equal(visibleWidth(identity), 100, 'control sits at the far right')
  const hit = component.hitMap()?.removes[0]
  assert.ok(hit !== undefined)
  assert.equal(hit.row, 0)
  assert.equal(hit.startCol, 99)
  assert.equal(hit.endCol, 100)
  assert.equal(hit.imageId, image.id)
  assert.equal(hit.startOffset, 0)
  assert.equal(hit.endOffset, image.placeholder.length)
  assert.equal(hit.draftText, text)
})

test('regular mode paints no removal control and exposes no hit', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = addImage(store)
  const { component, setDraft } = harness(store) // fullscreenMouse defaults to false
  setDraft(image.placeholder)
  const lines = component.render(100)
  const identity = stripAnsi(lines[0]!)
  assert.ok(identity.includes('#1/1 · 800×100'), 'the read-only identity is still painted')
  assert.ok(!identity.trimEnd().endsWith('x'), `regular mode must not offer x: ${identity}`)
  assert.deepEqual(component.hitMap()?.removes, [], 'no removal hit in regular mode')
})

test('a non-removable occurrence draws no x even in fullscreen', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = addImage(store)
  const { component, setDraft } = harness(store, {
    fullscreen: true,
    removable: occurrence => occurrence.image.id !== image.id,
  })
  setDraft(image.placeholder)
  const identity = component.render(100)[0]!
  assert.ok(!stripAnsi(identity).endsWith('x'))
  assert.deepEqual(component.hitMap()?.removes, [])
})

test('unsupported terminals, GIF, oversized, empty and recalled drafts keep real metadata and a reason', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const gif = addImage(store, { mediaType: 'image/gif', name: 'anim.gif' })
  const { component, setDraft, renders } = harness(store)
  setDraft(gif.placeholder)
  const gifLines = component.render(100)
  const gifIdentity = stripAnsi(gifLines[0]!)
  assert.ok(gifIdentity.includes('Preview unavailable'), `kitty GIF reason: ${gifIdentity}`)
  assert.ok(gifLines[0]!.includes(color.error('Preview unavailable')), 'the failed placeholder word uses the error ink')
  assert.ok(!gifLines[0]!.includes(color.textDim('Preview unavailable')), 'the failure word is never borrowed from the identity ink')
  assert.ok(gifIdentity.includes('image/gif'), `kitty GIF MIME: ${gifIdentity}`)
  assert.ok(gifIdentity.includes('anim.gif'), `kitty GIF name: ${gifIdentity}`)
  assert.ok(!gifLines.join('\n').includes('\x1b_G'), 'no kitty upload for a GIF')
  assert.equal(renders(), 0, 'no derivation is scheduled for an inadmissible card')

  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const jpeg = addImage(store, { mediaType: 'image/jpeg', name: 'shot.jpg' })
  setDraft(jpeg.placeholder)
  const unsupportedLines = component.render(100)
  const unsupported = stripAnsi(unsupportedLines[0]!)
  assert.ok(unsupported.includes('Preview unavailable'), `unsupported terminal reason: ${unsupported}`)
  assert.ok(unsupported.includes('image/jpeg'), `unsupported terminal MIME: ${unsupported}`)
  assert.ok(unsupported.includes('shot.jpg'), `unsupported terminal name: ${unsupported}`)
  assert.ok(unsupported.includes('800×100'), `unsupported terminal dimensions: ${unsupported}`)
  assert.ok(!unsupportedLines.join('\n').includes('\x1b_G'), 'no unsafe unsupported upload')
  assert.equal(renders(), 0)

  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const big = addImage(store, { bytes: new Uint8Array(DRAFT_PREVIEW_MAX_PIXEL_BYTES + 1), mediaType: 'image/jpeg' })
  setDraft(big.placeholder)
  assert.ok(stripAnsi(component.render(100)[0]!).includes('Preview unavailable'))
  assert.equal(renders(), 0, 'an over-budget source never starts a decoder')
  const empty = addImage(store, { bytes: new Uint8Array(0), mediaType: 'image/jpeg' })
  setDraft(empty.placeholder)
  assert.ok(stripAnsi(component.render(100)[0]!).includes('Preview unavailable'))
  assert.equal(renders(), 0)
  const recalled = store.add({
    mediaType: 'image/jpeg',
    width: 800,
    height: 100,
    source: { type: 'recalled' },
    recalledRef: { attachmentId: 'att-r', mediaType: 'image/jpeg', bytes: 10, width: 800, height: 100 },
  })
  setDraft(recalled.placeholder)
  assert.ok(stripAnsi(component.render(100)[0]!).includes('Preview unavailable'))
  assert.equal(renders(), 0, 'a recalled draft never reads the durable ref or derives pixels')
})

test('iTerm2 renders the original format through OSC 1337', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = addImage(store, { mediaType: 'image/jpeg' })
  const { component, setDraft } = harness(store)
  setDraft(image.placeholder)
  const lines = component.render(100)
  assert.ok(lines.join('\n').includes('\x1b]1337;File='), 'iTerm2 inline sequence')
  assert.ok(stripAnsi(lines[0]!).startsWith('🖼️ #1/1'), 'identity row first')
})

test('the band repaints from the current draft and the last occurrence', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const one = addImage(store, { width: 800, height: 100 })
  const two = addImage(store, { width: 640, height: 480 })
  const { component, setDraft } = harness(store)
  setDraft(one.placeholder)
  assert.ok(stripAnsi(component.render(100)[0]!).includes(`#${one.id}/1`))
  setDraft(two.placeholder)
  assert.ok(stripAnsi(component.render(100)[0]!).includes(`#${two.id}/1`))
  setDraft(`${one.placeholder} ${two.placeholder}`)
  const identity = stripAnsi(component.render(100)[0]!)
  assert.ok(identity.includes(`#${two.id}/2`), 'last occurrence after repaint')
  assert.ok(identity.includes('+1'), 'remaining count after repaint')
})

test('pixel/base64 caches are released when no card is displayed', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = addImage(store)
  const { component, setDraft } = harness(store)
  setDraft(image.placeholder)
  component.render(100)
  const caches = component as unknown as {
    imageCache: Map<string, unknown>
    base64Cache: Map<string, unknown>
  }
  assert.ok(caches.imageCache.size > 0, 'card image cached')
  assert.ok(caches.base64Cache.size > 0, 'base64 cached')
  setDraft('')
  component.render(100)
  assert.equal(caches.imageCache.size, 0, 'image cache released')
  assert.equal(caches.base64Cache.size, 0, 'base64 cache released')
})

test('a real JPEG derives one Kitty PNG after a pending frame and keeps the original identity', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = store.add({
    bytes: SAMPLE_JPEG,
    mediaType: 'image/jpeg',
    width: 120,
    height: 80,
    name: 'photo.jpg',
  })
  const { component, setDraft, renders } = harness(store)
  setDraft(image.placeholder)
  const pendingLines = component.render(100)
  const pendingIdentity = stripAnsi(pendingLines[0]!)
  assert.ok(pendingIdentity.startsWith('🖼️ #1/1 · 120×80 · 968 B'), `original pending identity: ${pendingIdentity}`)
  assert.ok(pendingIdentity.endsWith('…'), `pending marker: ${pendingIdentity}`)
  assert.ok(!pendingIdentity.includes('Preview unavailable'), 'pending is not an unavailable state')
  assert.ok(!pendingLines[0]!.includes(color.error('Preview unavailable')), 'pending is not painted as a failure')
  assert.ok(!pendingLines.join('\n').includes('\x1b_G'), 'the first frame fabricates no pixels')
  await until(() => internals(component).draftReady !== undefined, 'the draft derivative')
  const readyLines = component.render(100)
  const imageLine = readyLines.find(line => line.includes('\x1b_G'))
  assert.ok(imageLine !== undefined, 'a real Kitty placement is painted')
  const header = /\x1b_G([^;]*);/.exec(imageLine!)![1]!
  assert.ok(Number(/(?:^|,)c=(\d+)/.exec(header)![1]) <= 44, `the wide card never exceeds 44 cells: ${header}`)
  assert.ok(Number(/(?:^|,)r=(\d+)/.exec(header)![1]) <= 3, `the wide card never exceeds 3 rows: ${header}`)
  assert.match(imageLine!, /f=100(?:,|\b)/, 'a real PNG transmission, not the text fallback')
  assert.ok(readyLines.length <= 4, `the band stays bounded to four rows (${readyLines.length})`)
  const readyIdentity = stripAnsi(readyLines[0]!)
  assert.ok(readyIdentity.includes('120×80 · 968 B'), `the original identity is unchanged: ${readyIdentity}`)
  assert.ok(!readyIdentity.includes('Preview unavailable'), 'READY is not an unavailable state')
  assert.deepEqual([...store.values()[0]!.bytes], [...SAMPLE_JPEG], 'the staged submission bytes are unchanged')
  assert.equal(renders(), 1, 'the settle requested exactly one repaint')
  assert.deepEqual(imageDimensions(onlyCachedImage(component)), { widthPx: 120, heightPx: 80 })
})

test('a real WebP derives the 22×3 split card with its own dimensions', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = store.add({
    bytes: SAMPLE_WEBP,
    mediaType: 'image/webp',
    width: 120,
    height: 80,
    name: 'graphic.webp',
  })
  const { component, setDraft } = harness(store)
  setDraft(image.placeholder)
  assert.ok(stripAnsi(component.render(60)[0]!).endsWith('…'), 'split width starts pending')
  await until(() => internals(component).draftReady !== undefined, 'the WebP derivative')
  const lines = component.render(60)
  const imageLine = lines.find(line => line.includes('\x1b_G'))
  assert.ok(imageLine !== undefined, 'split-width WebP paints real pixels')
  const header = /\x1b_G([^;]*);/.exec(imageLine!)![1]!
  assert.ok(Number(/(?:^|,)c=(\d+)/.exec(header)![1]) <= 22, `the split card never exceeds 22 cells: ${header}`)
  assert.ok(Number(/(?:^|,)r=(\d+)/.exec(header)![1]) <= 3, `the split card never exceeds 3 rows: ${header}`)
  assert.ok(lines.length <= 4)
  assert.deepEqual(imageDimensions(onlyCachedImage(component)), { widthPx: 120, heightPx: 80 })
  assert.ok(stripAnsi(lines[0]!).includes('120×80 · 138 B'), 'original WebP identity')
})

test('the Draft path runs the SAME 6A EXIF-oriented decoder', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const expected = await convertKittyThumbnail(ORIENTED_JPEG, 'image/jpeg')
  const store = new DraftImageStore()
  // Stored 60×30 with orientation 6: the displayed/derived image is 30×60.
  const image = store.add({
    bytes: ORIENTED_JPEG,
    mediaType: 'image/jpeg',
    width: 60,
    height: 30,
    name: 'oriented.jpg',
  })
  const { component, setDraft } = harness(store)
  setDraft(image.placeholder)
  component.render(100)
  await until(() => internals(component).draftReady !== undefined, 'the oriented derivative')
  const ready = internals(component).draftReady!
  assert.equal(ready.png.base64, expected.base64, 'the Draft reuses the 6A converter output exactly')
  assert.deepEqual([ready.png.width, ready.png.height], [30, 60], 'EXIF orientation applied to the derivative')
  const lines = component.render(100)
  assert.deepEqual(imageDimensions(onlyCachedImage(component)), { widthPx: 30, heightPx: 60 }, 'placement uses the oriented PNG')
  assert.ok(stripAnsi(lines[0]!).includes('60×30 · 824 B'), 'identity keeps the STORED ref dimensions')
})

test('iTerm2 keeps the ORIGINAL raster through OSC 1337 and starts no decoder', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false })
  let conversions = 0
  const converter: KittyThumbnailConverter = async () => {
    conversions += 1
    throw new Error('the iTerm2 path must never decode')
  }
  const store = new DraftImageStore()
  const jpeg = store.add({ bytes: SAMPLE_JPEG, mediaType: 'image/jpeg', width: 120, height: 80, name: 'photo.jpg' })
  const webp = store.add({ bytes: SAMPLE_WEBP, mediaType: 'image/webp', width: 120, height: 80, name: 'graphic.webp' })
  const { component, setDraft } = harness(store, { convertThumbnail: converter })
  for (const image of [jpeg, webp]) {
    setDraft(image.placeholder)
    const lines = component.render(100)
    assert.ok(lines.join('\n').includes('\x1b]1337;File='), `${image.mediaType} keeps the iTerm2 inline sequence`)
    assert.ok(!lines.join('\n').includes('\x1b_G'), `${image.mediaType} is never converted for iTerm2`)
    assert.ok(stripAnsi(lines[0]!).includes('120×80'), `${image.mediaType} identity is intact`)
  }
  assert.equal(conversions, 0, 'no decoder ever starts on the iTerm2 path')
})

test('narrow, short and unsupported cards never start the JPEG/WebP decoder', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let conversions = 0
  const converter: KittyThumbnailConverter = async () => {
    conversions += 1
    throw new Error('an inadmissible card must never decode')
  }
  const store = new DraftImageStore()
  const image = store.add({ bytes: SAMPLE_JPEG, mediaType: 'image/jpeg', width: 120, height: 80 })
  const wide = harness(store, { convertThumbnail: converter })
  wide.setDraft(image.placeholder)
  for (const width of [41, 49]) {
    const lines = wide.component.render(width)
    assert.equal(lines.length, 1, `${width} columns degrade to the one-line summary`)
    assert.ok(lines[0]!.includes('1 image attached'))
    assert.ok(!lines[0]!.includes('\x1b_G'))
  }
  for (const maxRows of [1, 2, 3]) {
    const short = harness(store, { maxRows, convertThumbnail: converter })
    short.setDraft(image.placeholder)
    const lines = short.component.render(100)
    assert.equal(lines.length, 1, `${maxRows}-row grant degrades to the summary`)
    assert.deepEqual(short.component.hitMap()?.removes, [], 'no phantom x in the summary')
  }
  const gif = store.add({ bytes: SAMPLE_JPEG, mediaType: 'image/gif', width: 120, height: 80 })
  wide.setDraft(gif.placeholder)
  assert.ok(stripAnsi(wide.component.render(100)[0]!).includes('Preview unavailable'))
  assert.equal(conversions, 0, 'no decoder runs for summary/narrow/GIF cards')
})

test('a corrupt JPEG goes pending → bounded unavailable and keeps the x hit', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = store.add({
    bytes: CORRUPT_JPEG,
    mediaType: 'image/jpeg',
    width: 120,
    height: 80,
    name: 'broken.jpg',
  })
  const { component, setDraft, renders } = harness(store, { fullscreen: true })
  setDraft(image.placeholder)
  const pending = component.render(100)
  const pendingIdentity = stripAnsi(pending[0]!)
  assert.ok(pendingIdentity.endsWith('x'), 'pending still offers the existing x control')
  assert.ok(pendingIdentity.includes('…'), 'pending marker')
  assert.equal(component.hitMap()?.removes[0]?.imageId, image.id, 'the x hit is still registered')
  await until(() => internals(component).draftFailed !== undefined, 'the sanitized decode failure')
  const lines = component.render(100)
  assert.equal(lines.length, 1, 'a failed derivation paints only the identity row')
  const identity = stripAnsi(lines[0]!)
  assert.ok(identity.includes('Preview unavailable'), `bounded failure text: ${identity}`)
  assert.ok(lines[0]!.includes(color.error('Preview unavailable')), 'the failed placeholder word uses the error ink')
  assert.ok(!/corrupt|premature|Invalid/i.test(identity), `the native error never reaches the terminal: ${identity}`)
  assert.ok(identity.endsWith('x'), 'the x control survives the failure')
  assert.equal(component.hitMap()?.removes[0]?.imageId, image.id)
  assert.equal(renders(), 1, 'the failure settle requested one repaint')
})

test('two quick targets keep ONE conversion slot and a stale result never repaints the other', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const pngA = await convertKittyThumbnail(SAMPLE_JPEG, 'image/jpeg')
  const pngB = await convertKittyThumbnail(SAMPLE_WEBP, 'image/webp')
  let active = 0
  let maxActive = 0
  const gates: Deferred<KittyThumbnailPng>[] = []
  const converter: KittyThumbnailConverter = () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    const gate = deferred<KittyThumbnailPng>()
    gates.push(gate)
    return gate.promise.finally(() => { active -= 1 })
  }
  const store = new DraftImageStore()
  const a = store.add({ bytes: SAMPLE_JPEG, mediaType: 'image/jpeg', width: 120, height: 80, name: 'a.jpg' })
  const b = store.add({ bytes: SAMPLE_WEBP, mediaType: 'image/webp', width: 120, height: 80, name: 'b.webp' })
  const { component, setDraft, renders } = harness(store, { convertThumbnail: converter })
  setDraft(a.placeholder)
  assert.ok(stripAnsi(component.render(100)[0]!).endsWith('…'), 'A starts pending')
  await until(() => gates.length === 1, 'the A conversion to start')

  // Switch to B while A is still running: the single slot is still A's, so B
  // must wait for A's settle instead of starting a second decoder.
  setDraft(b.placeholder)
  const waiting = component.render(100)
  assert.ok(stripAnsi(waiting[0]!).includes(`#${b.id}/1`), 'B is the visible identity while waiting')
  assert.ok(stripAnsi(waiting[0]!).endsWith('…'), 'B paints pending, not A pixels')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(gates.length, 1, 'no second decoder starts while the slot is held')
  assert.equal(internals(component).draftCandidate, b, 'B is now the ONE candidate target')

  gates[0]!.resolve(pngA)
  await until(() => internals(component).activeDraftConversion === undefined, 'the A slot to release')
  assert.equal(internals(component).draftReady, undefined, 'the stale A result is discarded')
  assert.equal(internals(component).draftFailed, undefined)
  const next = component.render(100)
  assert.ok(!next.join('\n').includes('\x1b_G'), 'A pixels are never painted into B')
  await until(() => gates.length === 2, 'the B conversion to start')

  gates[1]!.resolve(pngB)
  await until(() => internals(component).draftReady?.image === b, 'the B derivative')
  const ready = component.render(100)
  assert.ok(ready.join('\n').includes('\x1b_G'), 'B paints its own real pixels')
  assert.equal(internals(component).draftReady!.png.base64, pngB.base64, 'B publishes the B payload, not A')
  assert.equal(internals(component).draftCandidate, b)
  assert.equal(maxActive, 1, 'at most ONE native conversion was ever in flight')
  assert.equal(renders(), 2, 'exactly one repaint request per settled conversion')
})

test('duplicate occurrences of one draft derive ONCE and keep the real last position', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let conversions = 0
  const converter: KittyThumbnailConverter = async (input, mediaType) => {
    conversions += 1
    return convertKittyThumbnail(input, mediaType)
  }
  const store = new DraftImageStore()
  const image = store.add({ bytes: SAMPLE_JPEG, mediaType: 'image/jpeg', width: 120, height: 80 })
  const { component, setDraft } = harness(store, { fullscreen: true, convertThumbnail: converter })
  const draft = `${image.placeholder} and ${image.placeholder}`
  setDraft(draft)
  assert.ok(stripAnsi(component.render(100)[0]!).includes(`#${image.id}/2`))
  await until(() => internals(component).draftReady !== undefined, 'the shared derivative')
  const lines = component.render(100)
  const identity = stripAnsi(lines[0]!)
  assert.ok(identity.includes(`#${image.id}/2`), 'the last occurrence identity')
  assert.ok(identity.includes('+1'), 'the remaining occurrence count')
  assert.ok(identity.endsWith('x'), 'the x control is on the last occurrence row')
  assert.equal(conversions, 1, 'one derivation for the same draft id')
  const hit = component.hitMap()?.removes[0]
  assert.equal(hit?.ordinal, 1, 'the x hit addresses the LAST occurrence ordinal')
  assert.equal(hit?.startOffset, draft.lastIndexOf(image.placeholder), 'the x hit offsets are the expanded real position')
  assert.equal(hit?.endOffset, draft.lastIndexOf(image.placeholder) + image.placeholder.length)
})

test('invalidate retires a pending derivation; the next visible paint starts a fresh one', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const png = await convertKittyThumbnail(SAMPLE_JPEG, 'image/jpeg')
  const gates: Deferred<KittyThumbnailPng>[] = []
  const converter: KittyThumbnailConverter = () => {
    const gate = deferred<KittyThumbnailPng>()
    gates.push(gate)
    return gate.promise
  }
  const store = new DraftImageStore()
  const image = store.add({ bytes: SAMPLE_JPEG, mediaType: 'image/jpeg', width: 120, height: 80 })
  const { component, setDraft } = harness(store, { convertThumbnail: converter })
  setDraft(image.placeholder)
  component.render(100)
  await until(() => gates.length === 1, 'the first conversion to start')
  component.invalidate()
  assert.equal(internals(component).draftCandidate, undefined, 'invalidate drops the candidate')
  assert.equal(internals(component).draftReady, undefined)
  assert.equal(internals(component).draftFailed, undefined)
  assert.equal(internals(component).imageCache.size, 0, 'invalidate drops the local pixel cache')
  assert.equal(internals(component).base64Cache.size, 0)
  gates[0]!.resolve(png)
  await until(() => internals(component).activeDraftConversion === undefined, 'the retired slot to release')
  assert.equal(internals(component).draftReady, undefined, 'the retired result is discarded')
  // The SAME DraftImage object still resolves (Undo-safe source): a later
  // visible paint derives it again from the store-owned bytes.
  component.render(100)
  await until(() => gates.length === 2, 'the fresh conversion to start')
  gates[1]!.resolve(png)
  await until(() => internals(component).draftReady?.image === image, 'the fresh derivative')
  assert.ok(component.render(100).join('\n').includes('\x1b_G'), 'the recovered card paints pixels again')
})

test('a disposed component never requests a frame or publishes a late result', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const png = await convertKittyThumbnail(SAMPLE_JPEG, 'image/jpeg')
  const gates: Deferred<KittyThumbnailPng>[] = []
  const converter: KittyThumbnailConverter = () => {
    const gate = deferred<KittyThumbnailPng>()
    gates.push(gate)
    return gate.promise
  }
  const store = new DraftImageStore()
  const image = store.add({ bytes: SAMPLE_JPEG, mediaType: 'image/jpeg', width: 120, height: 80 })
  const { component, setDraft, renders } = harness(store, { convertThumbnail: converter })
  setDraft(image.placeholder)
  component.render(100)
  await until(() => gates.length === 1, 'the conversion to start')
  component.dispose()
  gates[0]!.resolve(png)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(internals(component).draftReady, undefined, 'a disposed component publishes nothing')
  assert.equal(internals(component).draftFailed, undefined)
  assert.equal(internals(component).activeDraftConversion, undefined, 'the slot still releases')
  assert.equal(renders(), 0, 'a disposed component requests no frame')
  component.render(100)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(gates.length, 1, 'a post-dispose paint starts no decoder')
})

test('an invalidate before the conversion microtask releases the slot for the next target', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let conversions = 0
  const gates: Deferred<KittyThumbnailPng>[] = []
  const converter: KittyThumbnailConverter = () => {
    conversions += 1
    const gate = deferred<KittyThumbnailPng>()
    gates.push(gate)
    return gate.promise
  }
  const store = new DraftImageStore()
  const a = store.add({ bytes: SAMPLE_JPEG, mediaType: 'image/jpeg', width: 120, height: 80 })
  const b = store.add({ bytes: SAMPLE_WEBP, mediaType: 'image/webp', width: 120, height: 80 })
  const { component, setDraft, renders } = harness(store, { convertThumbnail: converter })
  setDraft(a.placeholder)
  component.render(100)
  assert.notEqual(internals(component).activeDraftConversion, undefined, 'fixture: the slot is claimed before the microtask')
  component.invalidate()
  await until(() => internals(component).activeDraftConversion === undefined, 'the cancelled pre-start task to release the slot')
  assert.equal(conversions, 0, 'the cancelled decoder never starts')
  assert.equal(renders(), 0, 'a retired candidate requests no frame')

  // The next visible target must still be allowed to derive (the old slot is
  // really released, not stuck pending forever).
  const pngB = await convertKittyThumbnail(SAMPLE_WEBP, 'image/webp')
  setDraft(b.placeholder)
  component.render(100)
  await until(() => gates.length === 1, 'the next target conversion to start')
  gates[0]!.resolve(pngB)
  await until(() => internals(component).draftReady?.image === b, 'the next target derivative')
  assert.ok(component.render(100).join('\n').includes('\x1b_G'), 'the next target paints real pixels')
})

test('a target switch before the conversion microtask frees the slot for the new target', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let conversions = 0
  const gates: Deferred<KittyThumbnailPng>[] = []
  const converter: KittyThumbnailConverter = () => {
    conversions += 1
    const gate = deferred<KittyThumbnailPng>()
    gates.push(gate)
    return gate.promise
  }
  const store = new DraftImageStore()
  const a = store.add({ bytes: SAMPLE_JPEG, mediaType: 'image/jpeg', width: 120, height: 80 })
  const b = store.add({ bytes: SAMPLE_WEBP, mediaType: 'image/webp', width: 120, height: 80 })
  const { component, setDraft, renders } = harness(store, { convertThumbnail: converter })
  setDraft(a.placeholder)
  component.render(100)
  // Switch and paint B in the SAME task, before A's deferred decoder starts.
  setDraft(b.placeholder)
  const waiting = component.render(100)
  assert.ok(stripAnsi(waiting[0]!).includes(`#${b.id}/1`), 'B is the visible target')
  assert.ok(stripAnsi(waiting[0]!).endsWith('…'), 'B waits for the single slot')
  assert.equal(conversions, 0, 'A never reached the decoder')
  await until(() => internals(component).activeDraftConversion === undefined, 'the pre-start A task to release the slot')
  assert.equal(conversions, 0, 'the decoder still never started')
  assert.ok(renders() >= 1, 'the settled stale slot asks for a frame for the CURRENT target')

  const pngB = await convertKittyThumbnail(SAMPLE_WEBP, 'image/webp')
  component.render(100)
  await until(() => gates.length === 1, 'the B conversion to start')
  gates[0]!.resolve(pngB)
  await until(() => internals(component).draftReady?.image === b, 'the B derivative')
  const ready = component.render(100)
  assert.ok(ready.join('\n').includes('\x1b_G'), 'B paints real pixels after the freed slot')
  assert.equal(internals(component).draftCandidate, b)
})

test('dispose before the conversion microtask releases the slot without a frame request', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let conversions = 0
  const converter: KittyThumbnailConverter = () => {
    conversions += 1
    return new Promise<KittyThumbnailPng>(() => {})
  }
  const store = new DraftImageStore()
  const a = store.add({ bytes: SAMPLE_JPEG, mediaType: 'image/jpeg', width: 120, height: 80 })
  const { component, setDraft, renders } = harness(store, { convertThumbnail: converter })
  setDraft(a.placeholder)
  component.render(100)
  assert.notEqual(internals(component).activeDraftConversion, undefined, 'fixture: the slot is claimed')
  component.dispose()
  await until(() => internals(component).activeDraftConversion === undefined, 'the disposed pre-start task to release the slot')
  assert.equal(conversions, 0, 'a disposed component never starts the decoder')
  assert.equal(renders(), 0, 'a disposed component requests no frame')
})

// === Image-8 / I8-2A: Direct SIXEL draft card (E2) ========================

/**
 * A SIXEL handle whose DCS states the card width it was granted, so the test can
 * prove the SAME bounded card box the Kitty path uses (44 / 22 cells) and that
 * no Kitty id/APC is involved.
 */
function sixelDraftGraphics(ready: () => boolean): ImageGraphics {
  const terminal = {
    writes: [] as string[], columns: 80, rows: 24, kittyProtocolActive: false,
    start() {}, stop() {}, async drainInput() {}, write() {}, moveBy() {}, hideCursor() {},
    showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {},
    setProgress() {}, setProgramStatus() {}, setProgressState() {},
  }
  return {
    mode: 'sixel',
    canPaint: () => true,
    image: (_source, options) => {
      const dcs = `\x1bP0;1;q"1;1;${options.maxWidthCells * 10};36#0;2;100;0;0~\x1b\\`
      return {
        render: () => (ready() ? [dcs] : [options.fallback]),
        invalidate: () => {},
        paintedBodyAt: (width: number) => (ready() ? { width, columns: options.maxWidthCells, rows: 1 } : undefined),
        dispose: () => {},
      }
    },
    terminal: terminal as never,
    screen: { footprint: () => undefined, crop: () => undefined },
    observeScreen: () => {},
    resample: () => {},
    dispose: () => {},
  }
}

test('a PNG draft card paints through Direct SIXEL with the same 44/22 cell box', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const image = addImage(store, { name: 'shot.png' })
  const graphics = sixelDraftGraphics(() => true)
  const wide = harness(store, { draft: image.placeholder, graphics }).component.render(100)
  const wideLine = wide.find(line => line.includes('\x1bP'))
  assert.ok(wideLine !== undefined, `a SIXEL draft card body: ${JSON.stringify(wide.slice(0, 2))}`)
  assert.match(wideLine, /"1;1;440;36/, 'the wide card is the same 44 cells')
  assert.ok(!wide.join('').includes('\x1b_G'), 'no Kitty APC in a SIXEL card')

  const split = harness(store, { draft: image.placeholder, graphics }).component.render(60)
  const splitLine = split.find(line => line.includes('\x1bP'))
  assert.ok(splitLine !== undefined)
  assert.match(splitLine, /"1;1;220;36/, 'the split card is the same 22 cells')
})

test('a JPEG draft card derives its PNG once and then paints through SIXEL', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  let conversions = 0
  const store = new DraftImageStore()
  const image = addImage(store, { mediaType: 'image/jpeg', bytes: new Uint8Array(SAMPLE_JPEG), name: 'photo.jpg' })
  let ready = false
  const graphics = sixelDraftGraphics(() => ready)
  const card = harness(store, {
    draft: image.placeholder,
    graphics,
    convertThumbnail: async (input, mediaType) => {
      conversions += 1
      return convertKittyThumbnail(input, mediaType)
    },
  })
  const pending = card.component.render(100)
  assert.ok(!pending.join('').includes('\x1bP'), 'no pixels while the derivation is pending')
  await until(() => conversions === 1, 'the derived conversion')
  await until(() => internals(card.component).draftReady !== undefined, 'the derived PNG')
  // The derived PNG is ready, but the SIXEL raster is not: still informational.
  const stillPending = card.component.render(100)
  assert.ok(!stillPending.join('').includes('\x1bP'))
  // The raster becomes ready between frames: a repaint (never an invalidate,
  // which would legitimately retire the derived presentation) picks it up.
  ready = true
  const painted = card.component.render(100)
  assert.ok(painted.some(line => line.includes('\x1bP')), 'the derived PNG reaches the SIXEL card')
  assert.ok(painted[0]!.includes('#1/1'), 'the identity row stays')
})

test('a recalled draft occurrence never paints pixels under SIXEL', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const recalled = store.add({
    mediaType: 'image/png',
    width: 800,
    height: 100,
    source: { type: 'recalled' },
    recalledRef: { attachmentId: 'att-s', mediaType: 'image/png', bytes: 10, width: 800, height: 100 },
  })
  const image = recalled
  const graphics = sixelDraftGraphics(() => true)
  const lines = harness(store, { draft: image.placeholder, graphics }).component.render(100)
  assert.ok(!lines.join('').includes('\x1bP'), 'a recalled occurrence keeps metadata only')
})
