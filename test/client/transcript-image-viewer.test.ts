/**
 * The read-only transcript image viewer panel: short-window layout, loader
 * states, capability gates, scope isolation, resize and teardown.
 * @module @xmoon76/dsh-pi-tui/transcript-image-viewer.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Image, resetCapabilitiesCache, setCapabilities, visibleWidth } from '@xmoon76/pi-tui'
import { ImageViewerPanel } from '../../src/tui/components/media/image-viewer.ts'
import { Frame } from '../../src/tui/components/frame.ts'
import { ImageCache } from '../../src/client/media/image/cache.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import {
  MAX_KITTY_THUMBNAIL_SOURCE_BYTES,
  convertKittyThumbnail,
} from '../../src/client/media/image/kitty-thumbnail.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import { color } from '../../src/tui/theme/runtime.ts'

const PNG_REF: ImageAttachmentRefLike = {
  attachmentId: 'att-png',
  mediaType: 'image/png',
  bytes: 16,
  width: 800,
  height: 600,
  name: 'shot.png',
}

const JPEG_REF: ImageAttachmentRefLike = {
  attachmentId: 'att-jpeg',
  mediaType: 'image/jpeg',
  bytes: 2048,
  width: 1024,
  height: 768,
  name: 'photo.jpg',
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
const THEME = { fallbackColor: (text: string) => `[${text}]` }

const SAMPLE_JPEG = readFileSync(new URL('../fixtures/images/transcript-sample.jpg', import.meta.url))
const SAMPLE_WEBP = readFileSync(new URL('../fixtures/images/transcript-sample.webp', import.meta.url))
const ORIENTED_JPEG = readFileSync(new URL('../fixtures/images/transcript-oriented.jpg', import.meta.url))
const CORRUPT_JPEG = readFileSync(new URL('../fixtures/images/transcript-corrupt.jpg', import.meta.url))

/** A real JPEG ref (120×80, the committed fixture's stored dimensions). */
const REAL_JPEG_REF: ImageAttachmentRefLike = {
  attachmentId: 'att-real-jpeg',
  mediaType: 'image/jpeg',
  bytes: SAMPLE_JPEG.byteLength,
  width: 120,
  height: 80,
  name: 'photo.jpg',
}

/** Wait for an authoritative loader/panel state, not a wall-clock window. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** Override the detected graphics protocol for one test. */
function capabilities(images: 'kitty' | 'iterm2' | null): void {
  resetCapabilitiesCache()
  setCapabilities({ images, trueColor: true, hyperlinks: false })
}

/** Strip SGR so assertions compare painted content, not palette bytes. */
function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

/**
 * Drain the loader's settle chain to its authoritative end.
 *
 * The loader resolves through promise continuations only (no timer, no I/O),
 * so the settle notification and the cache write land within a bounded number
 * of microtask turns; the panel's `requestRender` is then observable. A
 * wall-clock wait would be a blind sleep: this awaits the actual fact.
 */
async function drainLoaderSettle(): Promise<void> {
  for (let index = 0; index < 40; index += 1) await Promise.resolve()
}

interface Gate {
  readonly promise: Promise<void>
  resolve(): void
}

function gate(): Gate {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function loaderOf(bytes: Uint8Array): ImageLoader {
  return new ImageLoader(async () => ({ ref: {}, data: bytes }))
}

function panelOf(
  loader: ImageLoader,
  options: {
    ref?: ImageAttachmentRefLike
    scope?: unknown
    requestRender?: () => void
    onClose?: () => void
  } = {},
): ImageViewerPanel {
  return new ImageViewerPanel({
    ref: options.ref ?? PNG_REF,
    // An EXPLICIT `undefined` means the loader's default scope (used by tests
    // that prime the loader's custom-cache scope directly).
    scope: 'scope' in options ? options.scope : {},
    loader,
    theme: THEME,
    requestRender: options.requestRender ?? (() => {}),
    onClose: options.onClose ?? (() => {}),
  })
}

test('a ready PNG on kitty paints title, metadata and Esc close within the grant', async () => {
  capabilities('kitty')
  const panel = panelOf(loaderOf(PNG_BYTES))
  panel.setMaxRows(14)
  const loading = panel.render(80)
  assert.ok(stripSgr(loading[1]!).includes('Loading…'), `first idle frame asks for a frame: ${loading[1]}`)
  await drainLoaderSettle()
  const lines = panel.render(80)
  assert.ok(lines.length <= 14, `rows stay inside the grant (${lines.length} <= 14)`)
  assert.equal(stripSgr(lines[0]!), 'Image · shot.png')
  const bottom = lines[lines.length - 1]!
  assert.ok(stripSgr(bottom).includes('800×600 · image/png · 16 B'), `metadata row: ${stripSgr(bottom)}`)
  assert.ok(stripSgr(bottom).endsWith('Esc close'), `right-aligned Esc close: ${stripSgr(bottom)}`)
  assert.ok(lines.join('\n').includes('\x1b_G'), 'the kitty inline sequence is painted')
  assert.ok(lines.length - 2 <= 14 - 2, `body rows stay inside maxRows - 2 (${lines.length - 2})`)
})

test('maxRows 1 and 2 keep the mandatory chrome and never paint a body', () => {
  capabilities('kitty')
  const loader = loaderOf(PNG_BYTES)
  const one = panelOf(loader)
  one.setMaxRows(1)
  const short = one.render(60)
  assert.equal(short.length, 1, 'one granted row is one painted row')
  assert.ok(short[0]!.includes('Image · shot.png'), `identity title on the short row: ${short[0]}`)
  assert.ok(short[0]!.endsWith('Esc close'), 'Esc close survives right-aligned')
  assert.ok(!short[0]!.includes('800×600'), 'metadata is dropped on the one-row layout')

  const two = panelOf(loaderOf(PNG_BYTES))
  two.setMaxRows(2)
  const lines = two.render(60)
  assert.equal(lines.length, 2, 'two granted rows: title + bottom row')
  assert.equal(stripSgr(lines[0]!), 'Image · shot.png')
  assert.ok(stripSgr(lines[1]!).endsWith('Esc close'))
  assert.ok(!lines.join('\n').includes('\x1b_G'), 'zero body rows on the two-row layout')
})

test('a row narrower than Esc close paints the widest hint prefix, never an overflow', () => {
  capabilities('kitty')
  const panel = panelOf(loaderOf(PNG_BYTES))
  panel.setMaxRows(1)
  assert.equal(stripSgr(panel.render(5)[0]!), 'Esc c')
  assert.equal(stripSgr(panel.render(3)[0]!), 'Esc')
  const bottom = panelOf(loaderOf(PNG_BYTES))
  bottom.setMaxRows(4)
  const lines = bottom.render(4)
  assert.equal(stripSgr(lines[lines.length - 1]!), 'Esc ')
  for (const line of lines) assert.ok(visibleWidth(line) <= 4)
})

test('loading → ready transition repaints on the loader settle and requests a frame', async () => {
  capabilities('kitty')
  const pending = gate()
  let reads = 0
  const loader = new ImageLoader(async () => {
    reads += 1
    await pending.promise
    return { ref: {}, data: PNG_BYTES }
  })
  let requested = 0
  const panel = panelOf(loader, { requestRender: () => { requested += 1 } })
  panel.setMaxRows(12)
  const first = panel.render(60)
  assert.ok(stripSgr(first[1]!).includes('Loading…'), `idle fires the read and paints Loading…: ${first[1]}`)
  const second = panel.render(60)
  assert.ok(stripSgr(second[1]!).includes('Loading…'), 'an in-flight read keeps painting Loading…')
  // The loader defers the read callback by one microtask; it has started long
  // before the gate settles, but has not produced a result yet.
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads, 1, 'the first render starts exactly one read')
  assert.equal(requested, 0, 'no frame was requested before the settle')
  pending.resolve()
  await drainLoaderSettle()
  assert.equal(requested, 1, 'the settle callback requested exactly one frame')
  const ready = panel.render(60)
  assert.ok(ready.join('\n').includes('\x1b_G'), 'the kitty sequence appears after the settle')
  assert.ok(ready.length <= 12)
})

test('a rejected read paints Read failed and folds hostile whitespace into one row', async () => {
  capabilities('kitty')
  const loader = new ImageLoader(async () => {
    throw new Error('storage\n\tdown')
  })
  const panel = panelOf(loader)
  panel.setMaxRows(8)
  panel.render(60)
  await drainLoaderSettle()
  const lines = panel.render(60)
  const body = lines[1]!
  assert.ok(stripSgr(body).includes('Read failed: storage'), `error row names the failure: ${stripSgr(body)}`)
  assert.ok(body.includes(color.error('Read failed:')), 'the failure word uses the error ink')
  assert.ok(stripSgr(body).includes('down'), 'the folded remainder stays visible')
  assert.ok(!body.includes('\n') && !body.includes('\t'), 'an embedded newline/tab never breaks the row')
  // The pane FILLS its grant and pins the bottom bar to the last row; the
  // single status row sits first in the body and EVERY row between it and the
  // bar is blank (the old `length === 3` proved exactly one status row; this
  // keeps that strength under the new fill layout).
  assert.equal(lines.length, 8, 'the pane fills the granted rows')
  for (let index = 2; index < lines.length - 1; index += 1) {
    assert.equal(stripSgr(lines[index]!).trim(), '', `body row ${index} is blank: a single status row`)
  }
  assert.ok(stripSgr(lines[lines.length - 1]!).endsWith('Esc close'), 'the bar is pinned to the LAST row')
  assert.ok(visibleWidth(body) <= 60)
})

test('a real JPEG reads once, derives the scoped PNG and paints it with ORIGINAL metadata', async () => {
  capabilities('kitty')
  const ref = REAL_JPEG_REF
  const scope = { key: 'viewer-jpeg:1' }
  let reads = 0
  let conversions = 0
  const loader = new ImageLoader(
    async () => {
      reads += 1
      return { ref: {}, data: SAMPLE_JPEG }
    },
    new ImageCache(),
    async (input, mediaType) => {
      conversions += 1
      return convertKittyThumbnail(input, mediaType)
    },
  )
  let requested = 0
  const panel = panelOf(loader, { ref, scope, requestRender: () => { requested += 1 } })
  panel.setMaxRows(10)
  const first = panel.render(60)
  assert.ok(stripSgr(first[1]!).includes('Loading…'), `idle JPEG body asks for the read: ${stripSgr(first[1]!)}`)
  await until(() => loader.get(ref, scope).state === 'ready', 'the raw read')
  await drainLoaderSettle()
  panel.render(60) // the next visible paint schedules the ONE conversion
  await until(() => loader.getKittyThumbnail(ref, scope).state === 'ready', 'the derived PNG')
  await drainLoaderSettle()
  const lines = panel.render(60)
  assert.equal(reads, 1, 'one scoped raw read')
  assert.equal(conversions, 1, 'one 6A conversion for the same (scope, attachment)')
  assert.ok(requested >= 1, 'the asynchronous settle requested a repaint')
  assert.ok(lines.join('\n').includes('\x1b_G'), 'the real kitty sequence is painted')
  assert.ok(lines.length <= 10, `rows stay inside the grant (${lines.length} <= 10)`)
  assert.equal(stripSgr(lines[0]!), 'Image · photo.jpg')
  const bottom = stripSgr(lines[lines.length - 1]!)
  assert.ok(bottom.includes('120×80 · image/jpeg'), `the ORIGINAL dimensions/MIME stay in metadata: ${bottom}`)
  assert.ok(bottom.includes(`${SAMPLE_JPEG.byteLength} B`), `the ORIGINAL byte count stays: ${bottom}`)
  assert.ok(bottom.endsWith('Esc close'), 'the close route is unchanged')
})

test('the derived payload drives placement while the ORIGINAL metadata is untouched', async () => {
  capabilities('kitty')
  // Stored 60×30 with EXIF orientation 6: the DERIVED png is 30×60 while the
  // durable ref keeps its stored 60×30 identity.
  const ref: ImageAttachmentRefLike = {
    attachmentId: 'att-oriented-jpeg',
    mediaType: 'image/jpeg',
    bytes: ORIENTED_JPEG.byteLength,
    width: 60,
    height: 30,
    name: 'oriented.jpg',
  }
  const scope = { key: 'viewer-jpeg:oriented' }
  const loader = new ImageLoader(async () => ({ ref: {}, data: ORIENTED_JPEG }))
  const panel = panelOf(loader, { ref, scope })
  panel.setMaxRows(12)
  panel.render(50)
  await until(() => loader.get(ref, scope).state === 'ready', 'the oriented raw read')
  panel.render(50)
  await until(() => loader.getKittyThumbnail(ref, scope).state === 'ready', 'the oriented derivative')
  const lines = panel.render(50)
  const internals = panel as unknown as { instanceWidthPx?: number; instanceHeightPx?: number }
  assert.deepEqual([internals.instanceWidthPx, internals.instanceHeightPx], [30, 60], 'placement follows the oriented PNG')
  assert.ok(lines.join('\n').includes('\x1b_G'))
  const bottom = stripSgr(lines[lines.length - 1]!)
  assert.ok(bottom.includes('60×30 · image/jpeg'), `metadata keeps the stored ref identity: ${bottom}`)
})

test('a READY 6A derivative is reused after the raw cache was evicted, without another read', async () => {
  capabilities('kitty')
  const ref: ImageAttachmentRefLike = { ...REAL_JPEG_REF, attachmentId: 'att-evicted-jpeg' }
  const filler: ImageAttachmentRefLike = {
    attachmentId: 'att-filler-webp',
    mediaType: 'image/webp',
    bytes: SAMPLE_WEBP.byteLength,
    width: 120,
    height: 80,
    name: 'filler.webp',
  }
  const reads = new Map<string, number>()
  // Small raw cache: the filler read evicts the JPEG's raw entry while the
  // DERIVED cache (a separate 6A budget) keeps the derivative. The constructor
  // cache only backs the DEFAULT scope, so this test primes that scope.
  const loader = new ImageLoader(
    async (attachmentRef) => {
      reads.set(attachmentRef.attachmentId, (reads.get(attachmentRef.attachmentId) ?? 0) + 1)
      return {
        ref: {},
        data: attachmentRef.attachmentId === ref.attachmentId ? SAMPLE_JPEG : SAMPLE_WEBP,
      }
    },
    new ImageCache(32, 2500),
  )
  loader.load(ref)
  await until(() => loader.get(ref).state === 'ready', 'the JPEG raw read')
  loader.loadKittyThumbnail(ref)
  await until(() => loader.getKittyThumbnail(ref).state === 'ready', 'the JPEG derivative')
  loader.load(filler)
  await until(() => loader.get(filler).state === 'ready', 'the filler read')
  assert.equal(loader.get(ref).state, 'idle', 'fixture: the raw JPEG entry was really evicted')
  assert.equal(loader.getKittyThumbnail(ref).state, 'ready', 'the derivative survived the raw eviction')

  const panel = panelOf(loader, { ref, scope: undefined })
  panel.setMaxRows(10)
  const lines = panel.render(60)
  assert.ok(lines.join('\n').includes('\x1b_G'), 'the first visible frame paints the READY derivative')
  assert.equal(reads.get(ref.attachmentId), 1, 'no re-read of the original bytes')

  // A DIFFERENT immutable scope never borrows this scope's derivative.
  const otherScope = { key: 'viewer-jpeg:other' }
  assert.equal(loader.getKittyThumbnail(ref, otherScope).state, 'idle', 'another scope owns no derivative')
  const otherPanel = panelOf(loader, { ref, scope: otherScope })
  otherPanel.setMaxRows(10)
  assert.ok(!otherPanel.render(60).join('\n').includes('\x1b_G'), 'another scope paints no borrowed pixels')
})

test('a corrupt JPEG degrades to the bounded unavailable row, never a native error or fake body', async () => {
  capabilities('kitty')
  const ref: ImageAttachmentRefLike = {
    attachmentId: 'att-corrupt-viewer',
    mediaType: 'image/jpeg',
    bytes: CORRUPT_JPEG.byteLength,
    width: 120,
    height: 80,
    name: 'broken.jpg',
  }
  const scope = { key: 'viewer-jpeg:corrupt' }
  const loader = new ImageLoader(async () => ({ ref: {}, data: CORRUPT_JPEG }))
  const panel = panelOf(loader, { ref, scope })
  panel.setMaxRows(8)
  panel.render(60)
  await until(() => loader.get(ref, scope).state === 'ready', 'the corrupt raw read')
  panel.render(60)
  await until(() => loader.getKittyThumbnail(ref, scope).state === 'error', 'the sanitized preview failure')
  await drainLoaderSettle()
  const lines = panel.render(60)
  const text = lines.map(line => stripSgr(line)).join('\n')
  const bodyText = lines.slice(1, -1).map(line => stripSgr(line)).join('\n')
  assert.ok(text.includes('Preview unavailable'), `safe failure row:\n${text}`)
  assert.ok(lines[1]!.includes(color.error('Preview unavailable')), 'the failed placeholder word uses the error ink')
  assert.ok(!text.includes('\x1b_G'), 'no pixel placement for a failed derivative')
  assert.ok(!/corrupt|premature|Invalid|JPEG/i.test(bodyText), `the native decoder error never reaches the terminal:\n${bodyText}`)
  assert.ok(stripSgr(lines[lines.length - 1]!).includes('120×80 · image/jpeg · 300 B'), 'original metadata survives')
  assert.ok(visibleWidth(lines[1]!) <= 60, 'the status is one bounded physical row')
})

test('over-budget JPEGs and unsupported rasters are refused before any read', async () => {
  capabilities('kitty')
  const cases: ImageAttachmentRefLike[] = [
    {
      attachmentId: 'att-too-large',
      mediaType: 'image/jpeg',
      bytes: MAX_KITTY_THUMBNAIL_SOURCE_BYTES + 1,
      width: 5001,
      height: 5000,
      name: 'huge.jpg',
    },
    {
      attachmentId: 'att-gif',
      mediaType: 'image/gif',
      bytes: 1024,
      width: 64,
      height: 40,
      name: 'anim.gif',
    },
  ]
  for (const ref of cases) {
    let reads = 0
    const loader = new ImageLoader(async () => {
      reads += 1
      return { ref: {}, data: JPEG_BYTES }
    })
    const panel = panelOf(loader, { ref })
    panel.setMaxRows(8)
    const lines = panel.render(60)
    assert.ok(stripSgr(lines[1]!).includes('Preview unavailable'), `${ref.mediaType} states the real reason`)
    assert.ok(lines[1]!.includes(color.error('Preview unavailable')), `${ref.mediaType} uses the error ink for the failure word`)
    await drainLoaderSettle()
    assert.equal(reads, 0, `${ref.mediaType} starts no read`)
    assert.ok(!panel.render(60).join('\n').includes('\x1b_G'), `${ref.mediaType} paints no fake body`)
  }
})

test('one and two granted rows start no read for a JPEG and keep the close chrome', () => {
  capabilities('kitty')
  let reads = 0
  const loader = new ImageLoader(async () => {
    reads += 1
    return { ref: {}, data: SAMPLE_JPEG }
  })
  const one = panelOf(loader, { ref: REAL_JPEG_REF })
  one.setMaxRows(1)
  const short = one.render(60)
  assert.equal(short.length, 1)
  assert.ok(short[0]!.includes('Image · photo.jpg'))
  assert.ok(short[0]!.endsWith('Esc close'))
  const two = panelOf(loader, { ref: REAL_JPEG_REF })
  two.setMaxRows(2)
  const twoLines = two.render(60)
  assert.equal(twoLines.length, 2)
  assert.ok(!twoLines.join('\n').includes('\x1b_G'), 'no body on the two-row layout')
  assert.equal(reads, 0, 'no I/O without a body grant')
})

test('iTerm2 keeps metadata + Preview unavailable (PR2 workspace scope) and never reads', async () => {
  // Owner decision (2026-10-24): the leased workspace shows real pixels on
  // Kitty only. The pinned AltScreen disables the iTerm2 image capability and
  // its cursor-up framing is not understood by the fork's ANSI width layer, so
  // native iTerm2 pixels are deferred to separate fork/protocol work.
  capabilities('iterm2')
  let reads = 0
  const loader = new ImageLoader(async () => {
    reads += 1
    return { ref: {}, data: JPEG_BYTES }
  })
  const panel = panelOf(loader, { ref: JPEG_REF })
  panel.setMaxRows(10)
  panel.render(60)
  await drainLoaderSettle()
  const lines = panel.render(60)
  const text = lines.map(line => stripSgr(line)).join('\n')
  assert.ok(text.includes('Preview unavailable'), `the workspace states the unavailable preview:\n${text}`)
  assert.ok(!lines.join('\n').includes('\x1b]1337;File='), 'no iTerm2 inline sequence is painted')
  assert.equal(reads, 0, 'an undisplayable protocol never reads the bytes')
  assert.ok(stripSgr(lines[lines.length - 1]!).includes('1024×768 · image/jpeg · 2.0 KiB'))
  assert.ok(stripSgr(lines[0]!).includes('Image · photo.jpg'))
})

test('an unsupported terminal paints Preview unavailable and never reads', async () => {
  capabilities(null)
  let reads = 0
  const loader = new ImageLoader(async () => {
    reads += 1
    return { ref: {}, data: PNG_BYTES }
  })
  const panel = panelOf(loader)
  panel.setMaxRows(8)
  const lines = panel.render(60)
  assert.ok(stripSgr(lines[1]!).includes('Preview unavailable'))
  await drainLoaderSettle()
  assert.equal(reads, 0, 'no pointless read on an unsupported terminal')
})

test('empty ready bytes paint Preview unavailable', async () => {
  capabilities('kitty')
  const panel = panelOf(loaderOf(new Uint8Array(0)))
  panel.setMaxRows(8)
  panel.render(60)
  await drainLoaderSettle()
  const lines = panel.render(60)
  assert.ok(stripSgr(lines[1]!).includes('Preview unavailable'))
  assert.ok(!lines.join('\n').includes('\x1b_G'))
})

test('a panel without a loader paints Preview unavailable and subscribes to nothing', () => {
  capabilities('kitty')
  const panel = new ImageViewerPanel({
    ref: PNG_REF,
    scope: {},
    theme: THEME,
    requestRender: () => {},
    onClose: () => {},
  })
  panel.setMaxRows(8)
  const lines = panel.render(60)
  assert.equal(lines.length, 8, 'the pane fills the grant, bottom bar last')
  assert.ok(stripSgr(lines[1]!).includes('Preview unavailable'))
  // Same strength as the error case: ONE status row, every remaining body row
  // blank (the old `length === 3` guaranteed this).
  for (let index = 2; index < lines.length - 1; index += 1) {
    assert.equal(stripSgr(lines[index]!).trim(), '', `body row ${index} is blank: a single status row`)
  }
  assert.ok(stripSgr(lines[lines.length - 1]!).endsWith('Esc close'), 'the bar is pinned to the LAST row')
  panel.dispose()
})

test('scope isolation: one scope settle never repaints another scope panel', async () => {
  capabilities('kitty')
  const scopeA = { key: 'child:1:A' }
  const scopeB = { key: 'child:1:B' }
  const pendingA = gate()
  const loader = new ImageLoader(async (_ref, scope) => {
    if (scope === scopeA) {
      await pendingA.promise
      return { ref: {}, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0a]) }
    }
    return { ref: {}, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0b]) }
  })
  let requestedA = 0
  let requestedB = 0
  const a = panelOf(loader, { scope: scopeA, requestRender: () => { requestedA += 1 } })
  const b = panelOf(loader, { scope: scopeB, requestRender: () => { requestedB += 1 } })
  a.setMaxRows(10)
  b.setMaxRows(10)
  a.render(60)
  b.render(60)
  await drainLoaderSettle()
  const bReady = b.render(60)
  assert.ok(bReady.join('\n').includes('\x1b_G'), 'B paints its own resolved bytes')
  assert.ok(stripSgr(a.render(60)[1]!).includes('Loading…'), 'A is still held by its own read')
  assert.equal(requestedB, 1, 'B heard only its own settle')
  pendingA.resolve()
  await drainLoaderSettle()
  assert.equal(requestedA, 1, 'A heard its own settle')
  assert.equal(requestedB, 1, "A's settle never wakes B")
  assert.deepEqual(b.render(60), bReady, "A's settle never changes B's painted content")
  assert.ok(a.render(60).join('\n').includes('\x1b_G'), 'A paints its own result')
})

test('dispose is idempotent and a late settle never touches the disposed panel', async () => {
  capabilities('kitty')
  const pending = gate()
  const loader = new ImageLoader(async () => {
    await pending.promise
    return { ref: {}, data: PNG_BYTES }
  })
  const scope = { key: 'dispose:1' }
  const before = loader.listenerCount()
  let requested = 0
  const panel = panelOf(loader, { scope, requestRender: () => { requested += 1 } })
  panel.setMaxRows(10)
  assert.equal(loader.listenerCount(), before + 1, 'the constructor subscribes exactly once')
  panel.render(60)
  panel.dispose()
  panel.dispose()
  assert.equal(loader.listenerCount(), before, 'dispose unsubscribes exactly once')
  pending.resolve()
  await drainLoaderSettle()
  assert.equal(requested, 0, 'a settle after dispose never requests a frame')
  // The loader cache is owned by the loader: dispose must not clear it.
  assert.equal(loader.get(PNG_REF, scope).state, 'ready')
  assert.doesNotThrow(() => panel.render(60))
})

test('every row stays inside the width at 40 and 70 while Esc close survives', async () => {
  capabilities('kitty')
  const panel = panelOf(loaderOf(PNG_BYTES))
  panel.setMaxRows(20)
  panel.render(40)
  await drainLoaderSettle()
  for (const width of [40, 70]) {
    const lines = panel.render(width)
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `row width ${visibleWidth(line)} <= ${width}: ${JSON.stringify(line)}`)
    }
    assert.ok(stripSgr(lines[lines.length - 1]!).includes('800×600 · image/png · 16 B'))
    assert.ok(stripSgr(lines[lines.length - 1]!).endsWith('Esc close'), 'the close hint is right-aligned')
    assert.ok(stripSgr(lines[0]!).includes('Image · shot.png'))
  }
})

test('setMaxRows shrink then grow reflows the body without another loader read', async () => {
  capabilities('kitty')
  let reads = 0
  const loader = new ImageLoader(async () => {
    reads += 1
    return { ref: {}, data: PNG_BYTES }
  })
  const panel = panelOf(loader)
  panel.render(70)
  await drainLoaderSettle()
  const tall = panel.render(70)
  const tallBody = tall.length - 2
  assert.ok(tallBody > 4, `the tall grant uses several image rows (${tallBody})`)
  assert.equal(reads, 1)

  panel.setMaxRows(8)
  const short = panel.render(70)
  assert.equal(short.length, 8, 'the shrink is honored exactly')
  assert.equal(short.length - 2, 6, 'six body rows after the shrink')
  assert.ok(short.length - 2 < tallBody, 'the body really shrank')

  panel.setMaxRows(22)
  const grown = panel.render(70)
  assert.equal(grown.length - 2, tallBody, 'the body grows back to the tall layout')
  assert.equal(reads, 1, 'resize never re-reads the attachment')
})

test('the constructor default budget is finite and an unnamed ref falls back to image', async () => {
  capabilities('kitty')
  const anonymous: ImageAttachmentRefLike = { ...PNG_REF, name: undefined }
  const panel = panelOf(loaderOf(PNG_BYTES), { ref: anonymous })
  panel.render(60)
  await drainLoaderSettle()
  const lines = panel.render(60)
  assert.ok(lines.length <= 22, `the pre-grant default stays finite (${lines.length} <= 22)`)
  assert.equal(stripSgr(lines[0]!), 'Image · image')
})

test('unchanged inputs reuse the local Image instance instead of rebuilding it', async () => {
  capabilities('kitty')
  const panel = panelOf(loaderOf(PNG_BYTES))
  panel.setMaxRows(12)
  panel.render(60)
  await drainLoaderSettle()
  const first = panel.render(60)
  const second = panel.render(60)
  // A rebuilt Image would allocate a fresh kitty image id and therefore emit
  // a different sequence; the identical string proves the instance was reused.
  assert.equal(first[1], second[1], 'the kitty placement is reused for unchanged inputs')
})

test('the panel paints the frame inner width and the close hint survives Frame', async () => {
  capabilities('kitty')
  const panel = panelOf(loaderOf(PNG_BYTES))
  panel.setMaxRows(14)
  const frame = new Frame(panel, true)
  panel.render(40)
  await drainLoaderSettle()
  const framed = frame.render(44)
  for (const line of framed) {
    assert.ok(visibleWidth(line) <= 44, `framed row ${visibleWidth(line)} <= 44`)
  }
  assert.ok(framed.join('\n').includes('\x1b_G'), 'the inline sequence survives the frame')
  assert.ok(stripSgr(framed[framed.length - 2]!).includes('Esc close'), 'the hint row survives the frame padding')
})

test('Esc closes; every other key is consumed locally and never forwarded', () => {
  capabilities('kitty')
  const loader = loaderOf(PNG_BYTES)
  let closes = 0
  let requested = 0
  const panel = panelOf(loader, { onClose: () => { closes += 1 }, requestRender: () => { requested += 1 } })
  panel.handleInput('\x1b')
  assert.equal(closes, 1, 'Esc invokes onClose')
  panel.handleInput('x')
  panel.handleInput('\r')
  panel.handleInput('\x1b[A')
  assert.equal(closes, 1, 'other keys never close')
  assert.equal(requested, 0, 'input handling never requests a frame')
})

test('the viewer never hands an unsanitized attachment name to the fork fallback', async () => {
  // `Image`'s text fallback interpolates `filename` into a painted row and the
  // fork does NOT strip terminal controls. Under the CURRENT admission this
  // branch is unreachable (only kitty/PNG/non-empty bytes reach `Image`, and
  // those always place a real sequence), but the name is untrusted data crossing
  // into a renderer that can paint it, so the projection is asserted directly by
  // inspecting what the panel hands the fork.
  capabilities('kitty')
  const hostile = 'evil\u001b]0;pwned\u0007photo.png'
  const seen: (string | undefined)[] = []
  const original = Image.prototype.render
  Image.prototype.render = function patched(this: Image, width: number): string[] {
    const options = (this as unknown as { options?: { filename?: string } }).options
    if (options?.filename !== undefined) seen.push(options.filename)
    return original.call(this, width)
  }
  try {
    const panel = new ImageViewerPanel({
      ref: { attachmentId: 'att-viewer', mediaType: 'image/png', bytes: 16, width: 100, height: 100, name: hostile },
      scope: {},
      loader: loaderOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
      theme: THEME,
      requestRender: () => {},
      onClose: () => {},
    })
    panel.setMaxRows(8)
    panel.render(60)
    await drainLoaderSettle()
    panel.render(60)
    panel.dispose()
  } finally {
    Image.prototype.render = original
  }
  assert.ok(seen.length > 0, 'the panel built an Image (the premise)')
  for (const name of seen) {
    assert.ok(!name!.includes('\u001b]0;'), `no OSC survives into the fork filename: ${JSON.stringify(name)}`)
    assert.ok(!name!.includes('pwned'), `no OSC payload survives: ${JSON.stringify(name)}`)
  }
})

test('the row-grant matrix stays I/O-free below three rows and clips the body to grant-2', async () => {
  capabilities('kitty')
  const ref: ImageAttachmentRefLike = { ...REAL_JPEG_REF, attachmentId: 'att-matrix-jpeg' }
  const scope = { key: 'viewer-jpeg:matrix' }
  let reads = 0
  let conversions = 0
  const loader = new ImageLoader(
    async () => { reads += 1; return { ref: {}, data: SAMPLE_JPEG } },
    new ImageCache(),
    async (input, mediaType) => { conversions += 1; return convertKittyThumbnail(input, mediaType) },
  )
  loader.load(ref, scope)
  await until(() => loader.get(ref, scope).state === 'ready', 'the matrix raw read')
  loader.loadKittyThumbnail(ref, scope)
  await until(() => loader.getKittyThumbnail(ref, scope).state === 'ready', 'the matrix derivative')
  assert.deepEqual([reads, conversions], [1, 1], 'the matrix fixture derives exactly once')

  for (const granted of [1, 2, 3, 4, 10, 24]) {
    for (const width of [40, 80]) {
      const panel = panelOf(loader, { ref, scope })
      panel.setMaxRows(granted)
      const lines = panel.render(width)
      assert.equal(lines.length, granted, `row ${granted} × width ${width} fills its grant exactly`)
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `row ${granted} × width ${width}: ${JSON.stringify(line)}`)
      }
      assert.ok(stripSgr(lines[lines.length - 1]!).endsWith('Esc close'), 'the close hint is pinned to the last granted row')
      if (granted <= 2) {
        assert.ok(!lines.join('\n').includes('\x1b_G'), `${granted} rows must not paint a body`)
      } else {
        const body = lines.slice(1, -1)
        assert.equal(body.length, granted - 2, 'the body absorbs exactly the grant minus the two chrome rows')
        const painted = body.filter(line => line.includes('\x1b_G')).length
        assert.ok(painted <= body.length, 'the image never exceeds the body grant')
      }
      panel.dispose()
    }
  }
  assert.deepEqual([reads, conversions], [1, 1], 'the whole matrix added no read/conversion')
})

test('dispose while the derived conversion is pending never repaints or keeps a local Image', async () => {
  capabilities('kitty')
  const ref: ImageAttachmentRefLike = { ...REAL_JPEG_REF, attachmentId: 'att-pending-dispose' }
  const scope = { key: 'viewer-jpeg:pending-dispose' }
  const derived = await convertKittyThumbnail(SAMPLE_JPEG, 'image/jpeg')
  let release!: (value: typeof derived) => void
  let conversions = 0
  const loader = new ImageLoader(
    async () => ({ ref: {}, data: SAMPLE_JPEG }),
    new ImageCache(),
    () => {
      conversions += 1
      return new Promise(resolve => { release = resolve })
    },
  )
  let requested = 0
  const panel = panelOf(loader, { ref, scope, requestRender: () => { requested += 1 } })
  panel.setMaxRows(10)
  const listeners = loader.listenerCount()
  panel.render(60)
  await until(() => loader.get(ref, scope).state === 'ready', 'the raw read before dispose')
  panel.render(60)
  await until(() => conversions === 1, 'the pending derived conversion')
  panel.dispose()
  panel.dispose()
  assert.equal(loader.listenerCount(), listeners - 1, 'dispose unsubscribes exactly once')
  const requestedAtDispose = requested
  release(derived)
  await drainLoaderSettle()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(requested, requestedAtDispose, 'the late derived settle requests no frame for the disposed panel')
  assert.equal((panel as unknown as { instance?: unknown }).instance, undefined, 'a disposed panel holds no local Image')
  assert.equal((panel as unknown as { unsubscribe?: unknown }).unsubscribe, undefined)
})
