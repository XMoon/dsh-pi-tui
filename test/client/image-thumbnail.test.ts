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
import { KittyGraphicsCore } from '../../src/tui/graphics/kitty-core.ts'
import { KittyTerminalFacade } from '../../src/tui/graphics/kitty-terminal.ts'
import { NativeKittyImage, type ImageGraphics } from '../../src/tui/graphics/native-image.ts'
import { createDirectSixelGraphics } from '../../src/tui/graphics/sixel-image.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { createTmuxKittyGraphics } from '../../src/tui/graphics/tmux-image.ts'
import { createFakeTmuxCli } from '../support/fake-tmux-cli.ts'
import { KITTY_VIRTUAL_PLACEHOLDER } from '../../src/tui/graphics/tmux-virtual.ts'

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

test('a source evicted while its preview is queued recovers on the next visible render', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const realDerived = await convertKittyThumbnail(SAMPLE_JPEG, 'image/jpeg')
  const held: Array<() => void> = []
  let conversions = 0
  const converter: KittyThumbnailConverter = () => {
    conversions += 1
    // A and B hold the two conversion slots; every later request resolves.
    if (conversions <= 2) {
      return new Promise(resolve => { held.push(() => resolve(realDerived)) })
    }
    return Promise.resolve(realDerived)
  }
  // The regression condition: the DEFAULT 32-entry raw cache.
  const loader = imageLoaderWith(SAMPLE_JPEG, converter)
  const a = { ...JPEG_REF, attachmentId: 'recover-a', name: 'a.jpg' }
  const b = { ...JPEG_REF, attachmentId: 'recover-b', name: 'b.jpg' }
  const c = { ...JPEG_REF, attachmentId: 'recover-c', name: 'recover.jpg' }
  for (const ref of [a, b, c]) loader.load(ref)
  await until(() => loader.get(a).state === 'ready' && loader.get(b).state === 'ready' && loader.get(c).state === 'ready', 'raw reads')
  loader.loadKittyThumbnail(a)
  loader.loadKittyThumbnail(b)
  await until(() => conversions === 2, 'two held conversions')
  loader.loadKittyThumbnail(c)
  assert.equal(loader.getKittyThumbnail(c).state, 'loading')
  // Evict C's raw bytes while it waits in the queue (32-entry default cache).
  const pressure = Array.from({ length: 32 }, (_value, index) => ({ ...JPEG_REF, attachmentId: `recover-p${index}`, name: `p${index}.jpg` }))
  for (const ref of pressure) loader.load(ref)
  await until(() => loader.get(c).state === 'idle', 'the raw source is evicted')
  held.shift()!()
  held.shift()!()
  await until(() => loader.getKittyThumbnail(c).state === 'idle', 'the dropped job releases its slot without a failure')
  // The next visible render goes through the ordinary raw-read path and then
  // re-requests the derivative; it must paint a REAL Kitty PNG, not remain
  // stuck on Preview unavailable.
  const component = new ImageThumbnail(c, loader, THEME, () => {})
  const first = component.render(80)
  assert.ok(first[0]!.includes('🖼️ recover.jpg · 120×80'), `the occurrence remains identifiable: ${first[0]}`)
  await until(() => loader.get(c).state === 'ready', 'the attachment is read again')
  const pending = component.render(80)
  assert.ok(pending[0]!.includes('…'), 'the fresh conversion is pending')
  await until(() => loader.getKittyThumbnail(c).state === 'ready', 'the re-derived preview')
  const lines = component.render(80)
  const body = kittyBody(lines)
  assert.ok(body !== undefined, 'the recovered attachment paints a Kitty body')
  assert.ok(body.header.includes('f=100'), 'the recovered body is a PNG transmission')
  assert.deepEqual(pngDimensions(body.png), { width: 120, height: 80 })
  assert.equal(conversions, 3, 'exactly one fresh conversion, no retry storm')
  component.render(80)
  component.render(80)
  assert.equal(conversions, 3, 'steady renders never re-convert')
})


/**
 * External review (PR #431): a raster the Kitty protocol cannot display keeps
 * the legacy text fallback and NEVER reaches the managed Core. The Core
 * transmits every payload as `f=100` (PNG), so handing it a GIF painted a
 * placement kitty could not decode — an empty image band where the fallback
 * used to be.
 */
test('a GIF keeps the text fallback and never reaches the managed core', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const writes: string[] = []
  const terminal = {
    writes, columns: 80, rows: 24, kittyProtocolActive: false,
    start() {}, stop() {}, async drainInput() {}, write(data: string) { writes.push(data) },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, setProgressState() {},
  }
  const core = new KittyGraphicsCore()
  const graphics = {
    mode: 'native' as const,
    canPaint: () => true,
    image: (source: never, options: never) => new NativeKittyImage(core, source, options),
    terminal: new KittyTerminalFacade(terminal, core),
    dispose: () => {},
  }
  const gif = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
    0x21, 0xf9, 0x04, 0x01, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
  ])
  const loader = new ImageLoader(async () => ({ ref: {}, data: gif }))
  const ref = { attachmentId: 'gif-1', mediaType: 'image/gif' as const, bytes: gif.length, width: 1, height: 1, name: 'a.gif' }
  loader.load(ref)
  const component = new ImageThumbnail(ref, loader, THEME, () => {}, undefined, undefined, undefined, graphics)
  component.render(80)
  await new Promise((resolve) => setTimeout(resolve, 25))
  const body = component.render(80).join('\n')

  assert.ok(!body.includes('\x1b_G'), 'no graphics command is emitted for a GIF')
  assert.ok(body.includes('🖼️ a.gif'), 'the identity row is still painted')
  assert.ok(body.includes('[Image: a.gif [image/gif] 1x1]'), 'and the legacy text fallback with it')
  assert.equal(component.paintedImageBody(80), undefined, 'a fallback row is never a clickable pixel body')
  assert.equal(writes.join(''), '', 'nothing reached the terminal writer')
})

/**
 * The fallback row obeys the SAME width contract as the legacy path
 * (`truncateToWidth(fallbackColor(...), width)`): a long attachment name must
 * never overrun the columns this component was granted, and never wrap into a
 * second row.
 */
test('a GIF fallback with a long name is clamped to the granted width', async () => {
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const terminal = {
    writes: [] as string[], columns: 80, rows: 24, kittyProtocolActive: false,
    start() {}, stop() {}, async drainInput() {}, write(data: string) { this.writes.push(data) },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, setProgressState() {},
  }
  const core = new KittyGraphicsCore()
  const graphics = {
    mode: 'native' as const,
    canPaint: () => true,
    image: (source: never, options: never) => new NativeKittyImage(core, source, options),
    terminal: new KittyTerminalFacade(terminal, core),
    dispose: () => {},
  }
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0])
  const loader = new ImageLoader(async () => ({ ref: {}, data: gif }))
  const ref = {
    attachmentId: 'gif-long',
    mediaType: 'image/gif' as const,
    bytes: gif.length,
    width: 1920,
    height: 1080,
    name: 'an-extremely-long-attachment-name-that-would-overflow-a-narrow-terminal.gif',
  }
  loader.load(ref)
  const component = new ImageThumbnail(ref, loader, THEME, () => {}, undefined, undefined, undefined, graphics)
  component.render(60)
  await new Promise((resolve) => setTimeout(resolve, 25))

  // Widths at or above NARROW_WIDTH_THRESHOLD take the two-row branch; below it
  // the existing narrow-terminal contract paints one identity row.
  for (const width of [60, 44, NARROW_WIDTH_THRESHOLD]) {
    const lines = component.render(width)
    assert.equal(lines.length, 2, `width ${width}: identity row plus fallback, never a wrapped extra row`)
    // The fallback row is the one this branch owns, and the legacy path clamped
    // it with `truncateToWidth`. (The identity row's own clamp is pre-existing
    // behaviour outside this branch — the screen truncates defensively.)
    const fallback = lines[1]!
    assert.ok(fallback.includes('[Image:'), `width ${width}: the fallback row is second`)
    assert.ok(
      visibleWidth(fallback) <= width,
      `width ${width}: the fallback stays inside the grant (got ${visibleWidth(fallback)})`,
    )
  }
})

/**
 * Image-7B-B: the consumer honors the EFFECTIVE protocol, not the fork's
 * process-wide capability. A tmux pane reports `images: null`, yet an admitted
 * virtual handle must paint — and its revocation must MISS the cache that held
 * the placeholder frame.
 */
test('an admitted tmux virtual handle paints where the fork reports no protocol, and revocation misses the cache', async (t) => {
  const cli = createFakeTmuxCli(t)
  const saved = new Map<string, string | undefined>()
  for (const key of [...Object.keys(cli.env), 'KITTY_WINDOW_ID', 'TERM_PROGRAM', 'ZELLIJ', 'STY', 'PI_IMAGE_PROTOCOL']) {
    saved.set(key, process.env[key])
    const value = cli.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const writes: string[] = []
  const terminal = {
    writes, columns: 80, rows: 24, kittyProtocolActive: false,
    start() {}, stop() {}, async drainInput() {}, write(data: string) { writes.push(data) },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, setProgressState() {},
  }
  const graphics = createTmuxKittyGraphics(terminal, {}, { ...cli.env })
  assert.ok(graphics, 'the scripted server is the admitted topology')
  const loader = loaderOf(SAMPLE_PNG)
  const ref = { attachmentId: 'tmux-png', mediaType: 'image/png' as const, bytes: SAMPLE_PNG.length, width: 64, height: 64, name: 'tmux.png' }
  loader.load(ref)
  await until(() => loader.get(ref).state === 'ready', 'the PNG read')
  const component = new ImageThumbnail(ref, loader, THEME, () => {}, undefined, undefined, undefined, graphics)
  const painted = component.render(80).join('\n')
  assert.ok(painted.includes(KITTY_VIRTUAL_PLACEHOLDER), `the tmux card painted placeholders: ${JSON.stringify(painted.slice(0, 80))}`)
  assert.ok(!painted.includes('Preview unavailable'))
  const body = component.paintedImageBody(80)
  assert.ok(body !== undefined, 'the managed thumbnail owns a clickable body')

  // The live binding changes: the VERY SAME component must repaint text, and its
  // cache key must miss so no previously painted placeholder row survives.
  cli.setReply('show-options', { text: 'on\n' })
  // The contract IS a time window: the 250 ms probe TTL must expire.
  await new Promise<void>(resolve => setTimeout(resolve, 260))
  const revoked = component.render(80).join('\n')
  assert.equal(revoked.includes(KITTY_VIRTUAL_PLACEHOLDER), false, 'no placeholder cell survived the revocation')
  assert.equal(revoked.includes('\x1b_G'), false, 'and no Kitty command either')
  assert.equal(component.paintedImageBody(80), undefined, 'the revoked card owns no clickable body')
  assert.ok(revoked.includes('🖼️ tmux.png'), 'the identity row is still painted')
  graphics.dispose()
})

/**
 * Image-7B-B (plan §3 B3): the fold is decided BEFORE `loader.get`/`load`. A
 * collapsed occurrence that mounts with an IDLE loader must not start a durable
 * read at all — deciding the fold after the read spends a full attachment read
 * for pixels that can never be painted.
 */
test('a COLLAPSED occurrence with an idle loader starts no read at all', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  let reads = 0
  const loader = new ImageLoader(async () => {
    reads += 1
    return { ref: {}, data: new Uint8Array([1, 2, 3]) }
  })
  const component = new ImageThumbnail(REF, loader, THEME, () => {}, () => true)
  const lines = component.render(80)
  assert.equal(reads, 0, 'a folded occurrence read no durable bytes')
  assert.equal(loader.get(REF).state, 'idle', 'the loader state was never advanced')
  assert.equal(lines.length, 1, 'only the constant info row was painted')
  assert.ok(lines[0]!.includes('🖼️ shot.png'), 'the identity row is still painted')
  assert.equal(component.paintedImageBody(80), undefined, 'a folded row is never a clickable body')

  // Expanding the SAME loader starts the read exactly once: the fold was the
  // only reason it had not started.
  const live = new ImageThumbnail(REF, loader, THEME, () => {}, () => false)
  live.render(80)
  await until(() => reads === 1, 'the expanded occurrence read')
  assert.equal(reads, 1, 'the expanded occurrence read the payload exactly once')
})

// === Image-8 / I8-2A: Direct SIXEL consumer (E1) ============================

const SIXEL_DCS = '\x1bP0;1;q"1;1;40;36#0;2;100;0;0#1;2;0;0;100#0!40~#1!40~\x1b\\'

const SIXEL_TERMINAL = {
  writes: [] as string[],
  columns: 80,
  rows: 24,
  kittyProtocolActive: false,
  start() {},
  stop() {},
  async drainInput() {},
  write(data: string) {
    this.writes.push(data)
  },
  moveBy() {},
  hideCursor() {},
  showCursor() {},
  clearLine() {},
  clearFromCursor() {},
  clearScreen() {},
  setTitle() {},
  setProgress() {},
  setProgramStatus() {},
  setProgressState() {},
}

/**
 * A SIXEL handle whose occurrence reports what the real owner would: a trusted
 * DCS plus the encoder's real footprint (`paintedBodyAt`), or nothing at all.
 *
 * `paint(width)` returns the body lines this occurrence would render; the fake
 * derives the footprint from it, so a pending/transparent/fallback render can
 * never register a clickable body.
 */
function sixelGraphics(paint: () => string[] | undefined, calls: string[] = []): ImageGraphics {
  return {
    mode: 'sixel',
    canPaint: () => true,
    image: (_source, options) => {
      calls.push(options.fallback)
      return {
        render: (_width: number) => paint() ?? [options.fallback],
        invalidate: () => {},
        paintedBodyAt: (width: number) => {
          const lines = paint()
          if (lines === undefined || !lines[0]!.startsWith('\x1bP')) return undefined
          return { width, columns: 4, rows: lines.length }
        },
        dispose: () => {},
      }
    },
    terminal: SIXEL_TERMINAL as never,
    screen: {
      footprint: (line: string) => (line === SIXEL_DCS ? { columns: 4, rows: 3 } : undefined),
      crop: () => undefined,
      candidate: () => undefined,
      reconcileVisible: () => false,
      materialize: () => undefined,
      framePainted: () => {},
    },
    observeScreen: () => {},
    resample: () => {},
    dispose: () => {},
  }
}

test('a PNG paints through Direct SIXEL even when the fork capability is null', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([1, 2, 3]))
  loader.load(REF)
  await until(() => loader.get(REF).state === 'ready', 'the attachment read')
  const graphics = sixelGraphics(() => [SIXEL_DCS, '', ''])
  const component = new ImageThumbnail(REF, loader, THEME, () => {}, undefined, undefined, undefined, graphics)
  const lines = component.render(80)

  assert.equal(lines.length, 4, 'one identity row plus the three-row raster')
  assert.ok(lines[0]!.includes('🖼️ shot.png'), 'the identity row stays constant')
  assert.equal(lines[1], SIXEL_DCS, 'the raster anchor is the encoder\'s exact string')
  assert.ok(lines.slice(2).every((line) => line === ''), 'the body rows are blank layout rows')
  assert.deepEqual(component.paintedImageBody(80), { rows: 3, endCol: 4 }, 'the REAL encoder footprint is the click body')
})

test('a pending or fallback SIXEL render registers no clickable body', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([1, 2, 3]))
  loader.load(REF)
  await until(() => loader.get(REF).state === 'ready', 'the attachment read')
  const graphics = sixelGraphics(() => undefined)
  const component = new ImageThumbnail(REF, loader, THEME, () => {}, undefined, undefined, undefined, graphics)
  const lines = component.render(80)

  assert.equal(lines.length, 2, 'the identity row and one safe fallback line')
  assert.ok(lines[0]!.includes('🖼️ shot.png'))
  assert.ok(!lines.join('').includes('\x1bP'), 'no DCS while the facts are incomplete')
  assert.equal(component.paintedImageBody(80), undefined, 'text is never a pixel body')
})

test('a JPEG under Direct SIXEL reuses the SAME derived-PNG conversion', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  let conversions = 0
  const loader = imageLoaderWith(SAMPLE_JPEG, async (input, mediaType) => {
    conversions += 1
    return convertKittyThumbnail(input, mediaType)
  })
  loader.load(JPEG_REF)
  await until(() => loader.get(JPEG_REF).state === 'ready', 'the raw JPEG read')
  const graphics = sixelGraphics(() => [SIXEL_DCS, '', ''])
  const component = new ImageThumbnail(JPEG_REF, loader, THEME, () => {}, undefined, undefined, undefined, graphics)

  const pending = component.render(80)
  assert.equal(pending.length, 1, 'no pixels before the derived PNG is ready')
  assert.ok(pending[0]!.includes('🖼️ photo.jpg · 120×80'), 'the ORIGINAL identity stays')
  assert.ok(pending[0]!.includes('…'), 'pending marker')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(conversions, 1, 'exactly one derivation, through the existing 6A path')
  await until(() => loader.getKittyThumbnail(JPEG_REF).state === 'ready', 'the derived PNG')

  const ready = component.render(80)
  assert.ok(ready[0]!.includes('🖼️ photo.jpg · 120×80'), 'still the original identity')
  assert.equal(ready[1], SIXEL_DCS, 'the derived PNG reaches the SIXEL encoder')
})

test('a GIF under Direct SIXEL keeps the text fallback and never becomes a body', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const gif = new Uint8Array([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00,
    0x21, 0xf9, 0x04, 0x01, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0x02, 0x02, 0x44, 0x01, 0x00, 0x3b,
  ])
  const loader = new ImageLoader(async () => ({ ref: {}, data: gif }))
  const ref = { attachmentId: 'gif-6a', mediaType: 'image/gif' as const, bytes: gif.length, width: 1, height: 1, name: 'a.gif' }
  loader.load(ref)
  await until(() => loader.get(ref).state === 'ready', 'the GIF read')
  const graphics = sixelGraphics(() => [SIXEL_DCS, '', ''])
  const component = new ImageThumbnail(ref, loader, THEME, () => {}, undefined, undefined, undefined, graphics)
  const lines = component.render(80)

  assert.ok(!lines.join('').includes('\x1bP'), 'a GIF is never handed to the SIXEL encoder')
  assert.ok(lines.join('').includes('[Image: a.gif [image/gif] 1x1]'), 'the legacy text fallback stays')
  assert.equal(component.paintedImageBody(80), undefined)
})

test('a collapsed or narrow SIXEL occurrence performs no attachment read', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const graphics = sixelGraphics(() => [SIXEL_DCS, '', ''])

  let collapsed = true
  const loader = loaderOf(new Uint8Array([1, 2, 3]))
  const collapsedComponent = new ImageThumbnail(
    REF, loader, THEME, () => {}, () => collapsed, undefined, undefined, graphics,
  )
  collapsedComponent.render(80)
  assert.equal(loader.get(REF).state, 'idle', 'a collapsed occurrence never starts the read')

  const narrowLoader = loaderOf(new Uint8Array([1, 2, 3]))
  const narrow = new ImageThumbnail(
    REF, narrowLoader, THEME, () => {}, undefined, undefined, undefined, graphics,
  )
  narrow.render(NARROW_WIDTH_THRESHOLD - 1)
  assert.equal(narrowLoader.get(REF).state, 'idle', 'a narrow terminal never starts the read')

  collapsed = false
  collapsedComponent.render(80)
  assert.notEqual(loader.get(REF).state, 'idle', 'expanding at a paintable width starts it')
})

/**
 * RFL-001: the transcript occurrence is the one consumer whose frame cache is
 * decided by the component itself. A SIXEL raster settles asynchronously, so the
 * frame that follows the settle must be a NEW frame — without any input, resize
 * or invalidate — or the transcript image would stay its first fallback forever.
 *
 * This uses the REAL `DirectSixelGraphics` owner and the real async encoder, not
 * a fake body, so the assertion measures the production settle path.
 */
test('a transcript PNG repaints after the async SIXEL encode settles (no invalidate)', async (t) => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const home = testLifecycle(t).tempDir('sixel-thumb-')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  const listeners = new Set<(supported: boolean) => void>()
  let cellListener: ((cell: { widthPx: number; heightPx: number }) => void) | undefined
  let repaints = 0
  const terminal = {
    writes: [] as string[], columns: 100, rows: 30, kittyProtocolActive: false,
    start() {}, stop() {}, async drainInput() {}, write(data: string) { this.writes.push(data) },
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {}, setProgressState() {},
    onSixelSupport(listener: (supported: boolean) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const screen = {
    queryCellSizeForSixel() {},
    onCellSizeObserved(listener: (cell: { widthPx: number; heightPx: number }) => void) {
      cellListener = listener
      return () => { cellListener = undefined }
    },
    async queryTerminalBackgroundColor() {
      return { r: 0x28, g: 0x2c, b: 0x34 }
    },
  }
  const graphics = createDirectSixelGraphics(terminal as never, { TERM: 'xterm-256color' }, () => { repaints += 1 })
  assert.ok(graphics !== undefined)
  t.after(() => graphics.dispose())
  graphics.observeScreen(screen, terminal.columns, terminal.rows)
  for (const listener of [...listeners]) listener(true)
  cellListener?.({ widthPx: 10, heightPx: 20 })
  await until(() => graphics.canPaint(), 'the three verified facts')

  // A real two-band PNG served by the REAL loader.
  const { default: sharp } = await import('sharp')
  const rgba = new Uint8Array(80 * 40 * 4)
  for (let y = 0; y < 40; y += 1) {
    for (let x = 0; x < 80; x += 1) {
      const offset = (y * 80 + x) * 4
      rgba[offset] = y < 20 ? 255 : 0
      rgba[offset + 2] = y < 20 ? 0 : 255
      rgba[offset + 3] = 255
    }
  }
  const png = new Uint8Array(await sharp(Buffer.from(rgba), { raw: { width: 80, height: 40, channels: 4 } }).png().toBuffer())
  const loader = new ImageLoader(async () => ({ ref: {}, data: png }))
  loader.load(REF)
  await until(() => loader.get(REF).state === 'ready', 'the attachment read')
  const component = new ImageThumbnail(REF, loader, THEME, () => {}, undefined, undefined, undefined, graphics)

  // The Screen's frame: candidates are granted, materialized and committed. The
  // component alone only ever emits the inert marker.
  const frame = (width: number): string[] => {
    const lines = component.render(width)
    const port = graphics!.screen
    const token = lines.find(line => port.candidate(line) !== undefined)
    if (token === undefined) return lines
    const info = port.candidate(token)!
    port.reconcileVisible(screen, [{ line: token, cropTopRows: 0, visibleRows: info.layoutRows, physicalRow: 0 }])
    const out = [...lines]
    const dcs = port.materialize(token, 0, info.layoutRows)
    if (dcs === undefined) {
      port.framePainted(screen, [])
      return out
    }
    out[out.indexOf(token)] = dcs
    port.framePainted(screen, [{ line: token, dcs, cropTopRows: 0, visibleRows: port.footprint(dcs)?.rows ?? info.layoutRows, emitted: true }])
    return out
  }
  const first = frame(80)
  assert.ok(!first.join('').includes('\x1bP'), `the first frame is the text fallback: ${JSON.stringify(first)}`)
  assert.equal(component.paintedImageBody(80), undefined, 'a pending raster is not a clickable body')

  // NO invalidate(): the owner's own settle must be enough for the next frame.
  // `repaints` also counts the readiness commit, so the window starts HERE.
  const settledFrom = repaints
  await until(() => repaints > settledFrom, 'the owner settle')
  await new Promise(resolve => setImmediate(resolve))
  const second = frame(80)
  assert.ok(second.join('').includes('\x1bP'), `the settled raster reaches the next frame: ${JSON.stringify(second)}`)
  const body = component.paintedImageBody(80)
  assert.notEqual(body, undefined, 'and it registers the REAL footprint as the click body')
  assert.ok(body!.rows >= 2, `the two-band raster is at least two cell rows, got ${body!.rows}`)
  assert.ok(body!.endCol > 0)
})

test('a derived SIXEL preview (JPEG/WebP) reads the last committed frame for its hit body', () => {
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([1]))
  loader.load(REF)
  const component = new ImageThumbnail(REF, loader, THEME, () => {})
  // The derived preview creates a managed SIXEL instance under `preview-sixel`;
  // its hit body must come from the owner's committed frame, not a component
  // snapshot taken before the Screen materialized.
  ;(component as unknown as { instanceKind: string }).instanceKind = 'preview-sixel'
  ;(component as unknown as { instance: unknown }).instance = {
    paintedBodyAt: (width: number) => (width === 80 ? { rows: 2, columns: 4 } : undefined),
  }
  assert.deepEqual(component.paintedImageBody(80), { rows: 2, endCol: 4 })
  assert.equal(component.paintedImageBody(40), undefined, 'only the committed width answers')
})
