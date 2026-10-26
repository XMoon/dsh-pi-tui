/**
 * M9 tests: the ImageThumbnail component — inline rendering vs the text
 * fallback across capability/width/load states (plan §17 + the M9
 * acceptance matrix: kitty inline, iTerm2 inline, unsupported fallback,
 * tmux fallback, narrow fallback).
 * @module @xmoon76/dsh-pi-tui/image-thumbnail.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from '@xmoon76/pi-tui'
import { ImageThumbnail, NARROW_WIDTH_THRESHOLD } from '../../src/tui/components/media/image-thumbnail.ts'
import { ImageCache } from '../../src/client/media/image/cache.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import {
  MAX_KITTY_THUMBNAIL_SOURCE_BYTES,
  convertKittyThumbnail,
  type KittyThumbnailConverter,
} from '../../src/client/media/image/kitty-thumbnail.ts'
import { imagePixelsSupported, type ImageAttachmentRefLike } from '../../src/domain/media/types.ts'

const REF: ImageAttachmentRefLike = {
  attachmentId: 'att-1',
  mediaType: 'image/png',
  bytes: 16,
  width: 800,
  height: 600,
  name: 'shot.png',
}

const THEME = { fallbackColor: (text: string) => `[${text}]` }

/** A loader whose underlying read resolves immediately to the given bytes. */
function loaderOf(bytes: Uint8Array): ImageLoader {
  return new ImageLoader(async () => ({ ref: {}, data: bytes }))
}

/** A loader whose read never settles (stays loading). */
function pendingLoader(): ImageLoader {
  return new ImageLoader(() => new Promise(() => {}))
}

test('an unsupported terminal renders the text fallback (tmux/unknown)', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([1, 2, 3]))
  loader.load(REF)
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  const lines = component.render(80)
  assert.equal(lines.length, 1)
  // The marker is `🖼️ ` (U+1F5BC + U+FE0F + a space): U+1F5BC alone has no
  // default emoji presentation, so the width math measures it 1 cell while
  // emoji fonts render it 2 — the overhang eats the space and overlaps the
  // name. VS16 forces the 2-cell render the math expects.
  assert.ok(lines[0]!.includes('🖼️ shot.png'), `fallback names the file: ${lines[0]}`)
  assert.equal(visibleWidth('🖼️ '), 3, 'the VS16 marker measures 2 cells + the space')
  assert.ok(lines[0]!.includes('800×600'), `fallback carries dimensions: ${lines[0]}`)
})

test('a narrow terminal falls back to text even with kitty support', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([1]))
  loader.load(REF)
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  const lines = component.render(NARROW_WIDTH_THRESHOLD - 1)
  assert.ok(lines[0]!.includes('🖼️ '), `narrow fallback line: ${lines[0]}`)
})

test('an idle ref triggers the load and renders the fallback meanwhile', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([1]))
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  const lines = component.render(80)
  assert.ok(lines[0]!.includes('🖼'), 'first render falls back while idle')
})

test('a still-loading ref renders the loading hint', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = pendingLoader()
  loader.load(REF)
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  const lines = component.render(80)
  assert.ok(lines[0]!.includes('…'), `loading hint: ${lines[0]}`)
})

test('a failed read renders the fallback with the error message', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = new ImageLoader(async () => { throw new Error('storage down') })
  loader.load(REF)
  await new Promise(resolve => setTimeout(resolve, 10))
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  const lines = component.render(80)
  assert.ok(lines[0]!.includes('storage down'), `error fallback: ${lines[0]}`)
})

test('kitty-capable terminals render the inline sequence', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  loader.load(REF)
  await new Promise(resolve => setTimeout(resolve, 10))
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  const lines = component.render(80)
  const joined = lines.join('\n')
  assert.ok(joined.includes('\x1b_G'), `kitty sequence present: ${JSON.stringify(joined.slice(0, 40))}`)
  // The constant info bar leads the image rows — the attachment identity
  // never disappears, even while the picture is showing.
  assert.ok(lines[0]!.includes('🖼️ shot.png · 800×600 · 16 B'), `info bar above the image: ${lines[0]}`)
})

test('iTerm2 terminals render the OSC 1337 inline sequence', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  loader.load(REF)
  await new Promise(resolve => setTimeout(resolve, 10))
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  const lines = component.render(80)
  assert.ok(lines.join('\n').includes('\x1b]1337;File='), 'iTerm2 OSC 1337 sequence')
})

test('width-stable renders reuse the cached lines (steady-frame reuse)', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([1]))
  loader.load(REF)
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  const first = component.render(80)
  const second = component.render(80)
  assert.equal(first, second, 'same width returns the identical array reference')
})

test('unsupported terminals never trigger a load (round-2 finding 4)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  let loads = 0
  const loader = new ImageLoader(async () => {
    loads += 1
    return { ref: {}, data: new Uint8Array([1]) }
  })
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  const lines = component.render(80)
  assert.ok(lines[0]!.includes('🖼'), 'fallback line renders')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loads, 0, 'no pointless read for an unsupported terminal')
})

test('dispose releases the loader subscription (round-2 finding 2/7)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  loader.load(REF)
  await new Promise(resolve => setTimeout(resolve, 10))
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  component.dispose()
  component.dispose() // idempotent
  component.render(80) // disposed render must not crash
  assert.ok(true)
})

test('a capability flip (kitty → unsupported) drops the cached inline lines', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  loader.load(REF)
  await new Promise(resolve => setTimeout(resolve, 10))
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  const inline = component.render(80)
  assert.ok(inline.join('\n').includes('\x1b_G'), 'inline first')
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const after = component.render(80)
  assert.ok(after.join('\n').includes('🖼'), 'capability flip falls back to text')
  // And back again: the cache is keyed per capability.
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const again = component.render(80)
  assert.ok(again.join('\n').includes('\x1b_G'), 'kitty returns after the flip')
})

test('collapsed mode keeps the info bar and drops only the image rows', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  loader.load(REF)
  await new Promise(resolve => setTimeout(resolve, 10))
  let collapsed = false
  const component = new ImageThumbnail(REF, loader, THEME, () => {}, () => collapsed)
  const expanded = component.render(80)
  assert.ok(expanded.join('\n').includes('\x1b_G'), 'expanded renders the image rows')
  assert.ok(expanded[0]!.includes('🖼️ shot.png · 800×600 · 16 B'), 'the info bar leads the expanded rows')
  // The toggle is read at render time: the cache key carries the bit, so a
  // flipped getter re-renders WITHOUT invalidate.
  collapsed = true
  const collapsedLines = component.render(80)
  assert.equal(collapsedLines.length, 1, 'collapsed renders exactly the info bar')
  assert.ok(collapsedLines[0]!.includes('🖼️ shot.png · 800×600 · 16 B'), 'the info bar survives the collapse')
  assert.ok(!collapsedLines.join('\n').includes('\x1b_G'), 'no image placement while collapsed')
  // And back: the same instance expands again.
  collapsed = false
  const again = component.render(80)
  assert.ok(again.join('\n').includes('\x1b_G'), 're-expand restores the image rows')
})

// ---------------------------------------------------------------------------
// Image-6A: Kitty JPEG/WebP preview body (derived PNG) and its pixel hit
// ---------------------------------------------------------------------------

const SAMPLE_JPEG = readFileSync(new URL('../fixtures/images/transcript-sample.jpg', import.meta.url))
const SAMPLE_WEBP = readFileSync(new URL('../fixtures/images/transcript-sample.webp', import.meta.url))
const SAMPLE_PNG = readFileSync(new URL('../fixtures/images/transcript-sample.png', import.meta.url))
const SAMPLE_GIF = readFileSync(new URL('../fixtures/images/transcript-sample.gif', import.meta.url))
const ORIENTED_JPEG = readFileSync(new URL('../fixtures/images/transcript-oriented.jpg', import.meta.url))
const CORRUPT_JPEG = readFileSync(new URL('../fixtures/images/transcript-corrupt.jpg', import.meta.url))

const JPEG_REF: ImageAttachmentRefLike = {
  attachmentId: 'att-jpeg',
  mediaType: 'image/jpeg',
  bytes: SAMPLE_JPEG.byteLength,
  width: 120,
  height: 80,
  name: 'photo.jpg',
}

const WEBP_REF: ImageAttachmentRefLike = {
  attachmentId: 'att-webp',
  mediaType: 'image/webp',
  bytes: SAMPLE_WEBP.byteLength,
  width: 48,
  height: 32,
  name: 'graphic.webp',
}

/** Wait for a real event (a loader state), never for a wall-clock window. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

function imageLoaderWith(bytes: Uint8Array, convert?: KittyThumbnailConverter): ImageLoader {
  return new ImageLoader(async () => ({ ref: {}, data: bytes }), new ImageCache(), convert)
}

/**
 * TEST-ONLY ownership probe: the local `Image` the component currently
 * retains. It must be gone immediately after a non-pixel render (collapse /
 * narrow / unsupported / pending / error) or dispose — the point is that no
 * loader event or asynchronous completion is involved in that release.
 */
function retainedImage(component: ImageThumbnail): { readonly base64Data?: string } | undefined {
  return (component as unknown as { instance?: { base64Data?: string } }).instance
}

/** The first Kitty APC of a rendered body, decoded to its header + PNG. */
function kittyBody(lines: readonly string[]): { header: string; png: Buffer } | undefined {
  const match = /^\x1b_G([^;\x1b]*);([^\x1b]*)\x1b\\/.exec(lines[1] ?? '')
  if (match === null) return undefined
  return { header: match[1]!, png: Buffer.from(match[2]!, 'base64') }
}

/** PNG IHDR width/height (offset 16..24 after the 8-byte signature + IHDR chunk). */
function pngDimensions(png: Buffer): { width: number; height: number } {
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'valid PNG',
  )
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

test('a JPEG on Kitty stays informational until the derived PNG is READY, then paints it', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let conversions = 0
  const loader = imageLoaderWith(SAMPLE_JPEG, async (input, mediaType) => {
    conversions += 1
    return convertKittyThumbnail(input, mediaType)
  })
  loader.load(JPEG_REF)
  await until(() => loader.get(JPEG_REF).state === 'ready', 'the raw JPEG read')
  const component = new ImageThumbnail(JPEG_REF, loader, THEME, () => {})
  // Raw READY + preview idle: the info row gains the pending marker and NO
  // pixels; the conversion starts exactly once.
  const pending = component.render(80)
  assert.equal(pending.length, 1)
  assert.ok(pending[0]!.includes('🖼️ photo.jpg · 120×80'), `original info bar while pending: ${pending[0]}`)
  assert.ok(pending[0]!.includes('…'), 'pending marker')
  assert.ok(!pending.join('\n').includes('\x1b_G'), 'no pixel body before READY')
  assert.equal(component.paintedImageBody(80), undefined, 'no clickable body before READY')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(conversions, 1)
  await until(() => loader.getKittyThumbnail(JPEG_REF).state === 'ready', 'the derived PNG')
  const ready = component.render(80)
  const body = kittyBody(ready)
  assert.ok(body !== undefined, `a real Kitty APC body: ${JSON.stringify(ready.slice(0, 2))}`)
  assert.ok(body.header.includes('f=100'), 'PNG transmission (f=100)')
  const derived = pngDimensions(body.png)
  assert.deepEqual(derived, { width: 120, height: 80 }, 'the body payload is the derived PNG')
  assert.ok(ready[0]!.includes('🖼️ photo.jpg · 120×80'), 'the info bar keeps the ORIGINAL ref')
  const hit = component.paintedImageBody(80)
  assert.ok(hit !== undefined, 'ready pixels register a body hit')
  assert.equal(hit.endCol, Number(/c=(\d+)/.exec(body.header)![1]), 'the hit uses the painted c=')
  // A re-render is a cache hit: no second conversion, no second frame churn.
  component.render(80)
  component.render(80)
  assert.equal(conversions, 1, 'the render hot path never re-runs the decoder')
})

test('EXIF orientation: original info dimensions stay, the derived body uses the oriented ones', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const ref: ImageAttachmentRefLike = {
    attachmentId: 'att-oriented',
    mediaType: 'image/jpeg',
    bytes: ORIENTED_JPEG.byteLength,
    width: 60,
    height: 30,
    name: 'turned.jpg',
  }
  const loader = imageLoaderWith(ORIENTED_JPEG)
  loader.load(ref)
  await until(() => loader.get(ref).state === 'ready', 'the raw oriented JPEG')
  const component = new ImageThumbnail(ref, loader, THEME, () => {})
  component.render(80)
  await until(() => loader.getKittyThumbnail(ref).state === 'ready', 'the oriented derivative')
  const lines = component.render(80)
  const body = kittyBody(lines)
  assert.ok(body !== undefined)
  assert.deepEqual(pngDimensions(body.png), { width: 30, height: 60 }, 'the body is the EXIF-oriented PNG')
  assert.ok(lines[0]!.includes('🖼️ turned.jpg · 60×30'), 'the info bar keeps the stored original dimensions')
})

test('a WebP preview renders its derived PNG, and the info bar keeps image/webp identity', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = imageLoaderWith(SAMPLE_WEBP)
  loader.load(WEBP_REF)
  await until(() => loader.get(WEBP_REF).state === 'ready', 'the raw WebP read')
  const component = new ImageThumbnail(WEBP_REF, loader, THEME, () => {})
  component.render(80)
  await until(() => loader.getKittyThumbnail(WEBP_REF).state === 'ready', 'the WebP derivative')
  const lines = component.render(80)
  const body = kittyBody(lines)
  assert.ok(body !== undefined)
  assert.deepEqual(pngDimensions(body.png), { width: 120, height: 80 })
  assert.ok(lines[0]!.includes('🖼️ graphic.webp · 48×32'), 'WebP info row keeps media identity by ref, not derived dims')
})

test('a failed conversion is a sanitized informational row with NO pixel body', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = imageLoaderWith(CORRUPT_JPEG, async () => {
    throw new Error('native decoder exploded at /private/path/photo.jpg')
  })
  const ref = { ...JPEG_REF, attachmentId: 'att-fail', name: 'broken.jpg' }
  loader.load(ref)
  await until(() => loader.get(ref).state === 'ready', 'the raw bytes (the read itself is fine)')
  const component = new ImageThumbnail(ref, loader, THEME, () => {})
  component.render(80)
  await until(() => loader.getKittyThumbnail(ref).state === 'error', 'the preview failure')
  const lines = component.render(80)
  assert.equal(lines.length, 1)
  assert.ok(lines[0]!.includes('Preview unavailable'), 'the bounded reason is shown')
  assert.ok(!lines[0]!.includes('/private/path'), 'the raw native message/path is NOT printed')
  assert.ok(!lines.join('\n').includes('\x1b_G'), 'no pixels')
  assert.equal(component.paintedImageBody(80), undefined, 'no clickable body for a text row')
})

test('a busy preview names the bounded busy fallback and has no pixel body', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const ready = { state: 'ready' as const, bytes: new Uint8Array([1]), base64: 'AQ==' }
  const fake = {
    get: () => ready,
    load: () => {},
    subscribe: () => () => {},
    getKittyThumbnail: () => ({ state: 'error' as const, reason: 'busy' as const }),
    loadKittyThumbnail: () => {},
  } as unknown as ImageLoader
  const component = new ImageThumbnail(JPEG_REF, fake, THEME, () => {})
  const lines = component.render(80)
  assert.equal(lines.length, 1)
  assert.ok(lines[0]!.includes('Preview unavailable (busy)'), `busy fallback: ${lines[0]}`)
  assert.equal(component.paintedImageBody(80), undefined)
})

test('a collapsed JPEG never starts a conversion and paints no body', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let conversions = 0
  const loader = imageLoaderWith(SAMPLE_JPEG, async (input, mediaType) => {
    conversions += 1
    return convertKittyThumbnail(input, mediaType)
  })
  loader.load(JPEG_REF)
  await until(() => loader.get(JPEG_REF).state === 'ready', 'the raw JPEG')
  const component = new ImageThumbnail(JPEG_REF, loader, THEME, () => {}, () => true)
  const lines = component.render(80)
  assert.equal(lines.length, 1)
  assert.ok(lines[0]!.includes('🖼️ photo.jpg · 120×80'), 'collapsed keeps only the info row')
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(conversions, 0, 'a collapsed occurrence never starts a conversion')
  assert.equal(component.paintedImageBody(80), undefined)
})

test('an over-budget ref is refused BEFORE the attachment read', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let reads = 0
  let conversions = 0
  const loader = new ImageLoader(
    async () => { reads += 1; return { ref: {}, data: SAMPLE_JPEG } },
    new ImageCache(),
    async (input, mediaType) => { conversions += 1; return convertKittyThumbnail(input, mediaType) },
  )
  const ref: ImageAttachmentRefLike = {
    attachmentId: 'att-too-large',
    mediaType: 'image/jpeg',
    bytes: MAX_KITTY_THUMBNAIL_SOURCE_BYTES + 1,
    width: 120,
    height: 80,
    name: 'huge.jpg',
  }
  const component = new ImageThumbnail(ref, loader, THEME, () => {})
  const lines = component.render(80)
  assert.equal(lines.length, 1)
  assert.ok(lines[0]!.includes('Preview unavailable'), `cheap preflight fallback: ${lines[0]}`)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(reads, 0, 'the cheap preflight never reads the full attachment')
  assert.equal(conversions, 0)
  assert.equal(component.paintedImageBody(80), undefined)
})

test('PNG still uses the original raw payload and never calls the converter', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let conversions = 0
  const ref: ImageAttachmentRefLike = {
    ...JPEG_REF,
    attachmentId: 'att-png',
    mediaType: 'image/png',
    name: 'native.png',
  }
  const loader = imageLoaderWith(SAMPLE_PNG, async (input, mediaType) => {
    conversions += 1
    return convertKittyThumbnail(input, mediaType)
  })
  loader.load(ref)
  await until(() => loader.get(ref).state === 'ready', 'the raw PNG read')
  const component = new ImageThumbnail(ref, loader, THEME, () => {})
  const lines = component.render(80)
  assert.ok(lines.join('\n').includes('\x1b_G'), 'PNG paints through the unchanged raw path')
  assert.equal(conversions, 0, 'PNG never enters the JPEG/WebP preview pipeline')
  assert.ok(component.paintedImageBody(80) !== undefined)
})

test('iTerm2 JPEG keeps the original OSC 1337 path and never converts', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false })
  let conversions = 0
  const loader = imageLoaderWith(SAMPLE_JPEG, async (input, mediaType) => {
    conversions += 1
    return convertKittyThumbnail(input, mediaType)
  })
  loader.load(JPEG_REF)
  await until(() => loader.get(JPEG_REF).state === 'ready', 'the raw JPEG read')
  const component = new ImageThumbnail(JPEG_REF, loader, THEME, () => {})
  const lines = component.render(80)
  assert.ok(lines.join('\n').includes('\x1b]1337;File='), 'iTerm2 carries the ORIGINAL MIME image')
  assert.equal(conversions, 0, 'iTerm2 never schedules a Kitty conversion')
  assert.ok(component.paintedImageBody(80) !== undefined, 'the OSC footprint is a real pixel body')
})

test('GIF on Kitty keeps the fork text fallback and never converts', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let conversions = 0
  const ref: ImageAttachmentRefLike = {
    ...JPEG_REF,
    attachmentId: 'att-gif',
    mediaType: 'image/gif',
    name: 'motion.gif',
  }
  const loader = imageLoaderWith(SAMPLE_GIF, async (input, mediaType) => {
    conversions += 1
    return convertKittyThumbnail(input, mediaType)
  })
  loader.load(ref)
  await until(() => loader.get(ref).state === 'ready', 'the raw GIF read')
  const component = new ImageThumbnail(ref, loader, THEME, () => {})
  const lines = component.render(80)
  assert.ok(lines.join('\n').includes('[Image:'), 'the fork text fallback is kept')
  assert.equal(conversions, 0, 'GIF stays out of the JPEG/WebP preview pipeline')
  assert.equal(component.paintedImageBody(80), undefined, 'a text fallback is never a pixel hit')
})

test('two occurrences of one JPEG share ONE conversion but paint independent Kitty IDs', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let conversions = 0
  const loader = imageLoaderWith(SAMPLE_JPEG, async (input, mediaType) => {
    conversions += 1
    return convertKittyThumbnail(input, mediaType)
  })
  loader.load(JPEG_REF)
  await until(() => loader.get(JPEG_REF).state === 'ready', 'the raw JPEG')
  const first = new ImageThumbnail(JPEG_REF, loader, THEME, () => {})
  const second = new ImageThumbnail(JPEG_REF, loader, THEME, () => {})
  first.render(80)
  second.render(80)
  await until(() => loader.getKittyThumbnail(JPEG_REF).state === 'ready', 'the shared derivative')
  const firstBody = kittyBody(first.render(80))
  const secondBody = kittyBody(second.render(80))
  assert.ok(firstBody !== undefined && secondBody !== undefined)
  assert.equal(conversions, 1, 'the same (scope, id) derives once')
  const firstId = /i=(\d+)/.exec(firstBody.header)![1]
  const secondId = /i=(\d+)/.exec(secondBody.header)![1]
  assert.notEqual(firstId, secondId, 'each occurrence owns its own Kitty placement/id')
  assert.ok(first.paintedImageBody(80) !== undefined && second.paintedImageBody(80) !== undefined)
})

test('the shared MIME table stays PNG-only for Kitty (the 6B Viewer boundary)', () => {
  // Image-6A derives a PNG for the THUMBNAIL only; it must not widen the shared
  // protocol/MIME answer the Viewer uses, or 6B would silently claim support.
  assert.equal(imagePixelsSupported('kitty', 'image/jpeg'), false)
  assert.equal(imagePixelsSupported('kitty', 'image/webp'), false)
  assert.equal(imagePixelsSupported('kitty', 'image/png'), true)
  assert.equal(imagePixelsSupported('iterm2', 'image/jpeg'), true)
})

test('dispose during a pending conversion releases the subscription: no settle repaint', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let releaseDerived!: () => void
  const loader = imageLoaderWith(SAMPLE_JPEG, () => new Promise(resolve => {
    releaseDerived = () => resolve({
      base64: '',
      width: 120,
      height: 80,
      byteLength: 0,
    })
  }))
  loader.load(JPEG_REF)
  await until(() => loader.get(JPEG_REF).state === 'ready', 'the raw JPEG')
  let repaints = 0
  const component = new ImageThumbnail(JPEG_REF, loader, THEME, () => { repaints += 1 })
  component.render(80)
  await new Promise(resolve => setImmediate(resolve))
  component.dispose()
  releaseDerived()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(repaints, 0, 'a disposed occurrence is never woken by a late conversion')
})

test('a failed RAW read on a JPEG keeps the read error and never starts a decoder', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let conversions = 0
  const loader = new ImageLoader(
    async () => { throw new Error('storage down') },
    new ImageCache(),
    async (input, mediaType) => { conversions += 1; return convertKittyThumbnail(input, mediaType) },
  )
  const ref = { ...JPEG_REF, attachmentId: 'att-read-fail', name: 'unreachable.jpg' }
  loader.load(ref)
  await until(() => loader.get(ref).state === 'error', 'the raw read failure')
  const component = new ImageThumbnail(ref, loader, THEME, () => {})
  const lines = component.render(80)
  assert.ok(lines[0]!.includes('storage down'), `the RAW read error is reported, not a decode failure: ${lines[0]}`)
  assert.equal(conversions, 0, 'a read failure never reaches the decoder')
  assert.equal(loader.getKittyThumbnail(ref).state, 'idle', 'no preview state is fabricated for a failed read')
  assert.equal(component.paintedImageBody(80), undefined)
})

test('a capability flip rebuilds the body for the NEW protocol (derived PNG vs original MIME)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = imageLoaderWith(SAMPLE_JPEG)
  loader.load(JPEG_REF)
  await until(() => loader.get(JPEG_REF).state === 'ready', 'the raw JPEG')
  const component = new ImageThumbnail(JPEG_REF, loader, THEME, () => {})
  component.render(80)
  await until(() => loader.getKittyThumbnail(JPEG_REF).state === 'ready', 'the derived PNG')
  const kitty = component.render(80)
  assert.ok(kitty.join('\n').includes('\x1b_G'), 'Kitty paints the derived PNG')
  assert.ok(!kitty.join('\n').includes('\x1b]1337;File='), 'no iTerm2 sequence while Kitty')
  // Flip to iTerm2: the SAME component must render the ORIGINAL MIME image,
  // not the cached derived-PNG placement.
  resetCapabilitiesCache()
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false })
  const iterm2 = component.render(80)
  assert.ok(iterm2.join('\n').includes('\x1b]1337;File='), 'iTerm2 paints the original image')
  assert.ok(!iterm2.join('\n').includes('\x1b_G'), 'the derived Kitty placement is gone')
  assert.ok(component.paintedImageBody(80) !== undefined, 'iTerm2 registers its real OSC footprint')
  // And back: Kitty must repaint the DERIVED PNG, not the fork JPEG fallback.
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const again = component.render(80)
  const body = kittyBody(again)
  assert.ok(body !== undefined, 'Kitty repaints a real APC')
  assert.ok(body.header.includes('f=100'), 'the repaint is the derived PNG payload')
  assert.deepEqual(pngDimensions(body.png), { width: 120, height: 80 })
  assert.ok(component.paintedImageBody(80) !== undefined)
})

test('a collapsed preview re-derives its payload after invalidation (no retained old bytes)', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const first = await convertKittyThumbnail(SAMPLE_JPEG, 'image/jpeg')
  const second = await convertKittyThumbnail(ORIENTED_JPEG, 'image/jpeg')
  let conversions = 0
  const loader = imageLoaderWith(SAMPLE_JPEG, async () => {
    conversions += 1
    return conversions === 1 ? first : second
  })
  const ref = { ...JPEG_REF, attachmentId: 'att-release', name: 'release.jpg' }
  loader.load(ref)
  await until(() => loader.get(ref).state === 'ready', 'the raw JPEG')
  let collapsed = false
  const component = new ImageThumbnail(ref, loader, THEME, () => {}, () => collapsed)
  component.render(80)
  await until(() => loader.getKittyThumbnail(ref).state === 'ready', 'the first derivative')
  const expanded = component.render(80)
  const firstBody = kittyBody(expanded)
  assert.ok(firstBody !== undefined)
  assert.deepEqual(pngDimensions(firstBody.png), { width: 120, height: 80 })
  assert.ok(retainedImage(component) !== undefined, 'the painted occurrence owns a local Image')
  // Collapsing returns an info-only frame: the local Image (and its base64
  // reference) is dropped IMMEDIATELY by that render — no loader event or
  // asynchronous completion participates in this assertion.
  collapsed = true
  const folded = component.render(80)
  assert.equal(folded.length, 1)
  assert.ok(!folded.join('\n').includes('\x1b_G'))
  assert.equal(retainedImage(component), undefined, 'collapse itself drops the local Image')
  assert.equal(component.paintedImageBody(80), undefined)
  // A trim/invalidation drops the raw and derived cache entries. If the
  // collapsed occurrence had retained its Image, re-expanding would paint the
  // OLD payload; the new derivative deliberately has different dimensions.
  loader.invalidate(ref.attachmentId)
  collapsed = false
  component.render(80)
  await until(() => loader.get(ref).state === 'ready', 'the fresh raw read')
  component.render(80)
  await until(() => loader.getKittyThumbnail(ref).state === 'ready', 'the second derivative')
  const again = component.render(80)
  const secondBody = kittyBody(again)
  assert.ok(secondBody !== undefined)
  assert.deepEqual(pngDimensions(secondBody.png), { width: 30, height: 60 },
    'the rebuilt body comes from the NEW derivative, not a retained payload')
  assert.equal(conversions, 2)
})

test('narrow Kitty and unknown/tmux never READ or CONVERT a real JPEG/WebP', async () => {
  for (const images of ['kitty', null] as const) {
    resetCapabilitiesCache()
    setCapabilities({ images, trueColor: true, hyperlinks: false })
    let reads = 0
    let conversions = 0
    const loader = new ImageLoader(
      async () => { reads += 1; return { ref: {}, data: SAMPLE_JPEG } },
      new ImageCache(),
      async () => { conversions += 1; return { base64: '', width: 1, height: 1, byteLength: 0 } },
    )
    const width = images === 'kitty' ? NARROW_WIDTH_THRESHOLD - 1 : 80
    for (const ref of [JPEG_REF, WEBP_REF]) {
      const component = new ImageThumbnail(ref, loader, THEME, () => {})
      const lines = component.render(width)
      assert.equal(lines.length, 1)
      assert.ok(lines[0]!.includes('🖼️ '), `info-only row for ${ref.mediaType} at ${String(images)}: ${lines[0]}`)
      assert.ok(!lines.join('\n').includes('\x1b_G'))
      assert.equal(component.paintedImageBody(width), undefined)
    }
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(reads, 0, `no attachment read for ${refsLabel(images)}`)
    assert.equal(conversions, 0, `no conversion for ${refsLabel(images)}`)
  }
})

function refsLabel(images: 'kitty' | null): string {
  return images === 'kitty' ? 'narrow Kitty' : 'unknown/tmux'
}

test('iTerm2 WebP keeps the original OSC 1337 payload and never converts', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false })
  let conversions = 0
  const loader = imageLoaderWith(SAMPLE_WEBP, async (input, mediaType) => {
    conversions += 1
    return convertKittyThumbnail(input, mediaType)
  })
  loader.load(WEBP_REF)
  await until(() => loader.get(WEBP_REF).state === 'ready', 'the raw WebP read')
  const component = new ImageThumbnail(WEBP_REF, loader, THEME, () => {})
  const lines = component.render(80)
  assert.ok(lines.join('\n').includes('\x1b]1337;File='), 'iTerm2 carries the ORIGINAL WebP MIME image')
  assert.ok(!lines.join('\n').includes('\x1b_G'), 'no Kitty conversion payload')
  assert.equal(conversions, 0, 'iTerm2 WebP never schedules a Kitty conversion')
  assert.ok(component.paintedImageBody(80) !== undefined, 'the OSC footprint is a real pixel body')
})

test('dispose drops the local Image reference immediately', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = imageLoaderWith(SAMPLE_JPEG)
  const ref = { ...JPEG_REF, attachmentId: 'att-dispose-payload', name: 'dispose.jpg' }
  loader.load(ref)
  await until(() => loader.get(ref).state === 'ready', 'the raw JPEG')
  const component = new ImageThumbnail(ref, loader, THEME, () => {})
  component.render(80)
  await until(() => loader.getKittyThumbnail(ref).state === 'ready', 'the derivative')
  component.render(80)
  assert.ok(retainedImage(component) !== undefined, 'the painted occurrence owns a local Image')
  component.dispose()
  assert.equal(retainedImage(component), undefined, 'dispose drops the local Image without any loader settle')
})
