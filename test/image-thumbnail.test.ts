/**
 * M9 tests: the ImageThumbnail component — inline rendering vs the text
 * fallback across capability/width/load states (plan §17 + the M9
 * acceptance matrix: kitty inline, iTerm2 inline, unsupported fallback,
 * tmux fallback, narrow fallback).
 * @module @xmoon76/dsh-pi-tui/image-thumbnail.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from '@xmoon76/pi-tui'
import { ImageThumbnail, NARROW_WIDTH_THRESHOLD } from '../src/components/media/image-thumbnail.ts'
import { ImageLoader } from '../src/image/loader.ts'
import type { ImageAttachmentRefLike } from '../src/image/admission.ts'

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
  const component = new ImageThumbnail(REF, loader, THEME)
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
  const component = new ImageThumbnail(REF, loader, THEME)
  const lines = component.render(NARROW_WIDTH_THRESHOLD - 1)
  assert.ok(lines[0]!.includes('🖼️ '), `narrow fallback line: ${lines[0]}`)
})

test('an idle ref triggers the load and renders the fallback meanwhile', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([1]))
  const component = new ImageThumbnail(REF, loader, THEME)
  const lines = component.render(80)
  assert.ok(lines[0]!.includes('🖼'), 'first render falls back while idle')
})

test('a still-loading ref renders the loading hint', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = pendingLoader()
  loader.load(REF)
  const component = new ImageThumbnail(REF, loader, THEME)
  const lines = component.render(80)
  assert.ok(lines[0]!.includes('…'), `loading hint: ${lines[0]}`)
})

test('a failed read renders the fallback with the error message', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = new ImageLoader(async () => { throw new Error('storage down') })
  loader.load(REF)
  await new Promise(resolve => setTimeout(resolve, 10))
  const component = new ImageThumbnail(REF, loader, THEME)
  const lines = component.render(80)
  assert.ok(lines[0]!.includes('storage down'), `error fallback: ${lines[0]}`)
})

test('kitty-capable terminals render the inline sequence', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  loader.load(REF)
  await new Promise(resolve => setTimeout(resolve, 10))
  const component = new ImageThumbnail(REF, loader, THEME)
  const lines = component.render(80)
  const joined = lines.join('\n')
  assert.ok(joined.includes('\x1b_G'), `kitty sequence present: ${JSON.stringify(joined.slice(0, 40))}`)
})

test('iTerm2 terminals render the OSC 1337 inline sequence', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
  loader.load(REF)
  await new Promise(resolve => setTimeout(resolve, 10))
  const component = new ImageThumbnail(REF, loader, THEME)
  const lines = component.render(80)
  assert.ok(lines.join('\n').includes('\x1b]1337;File='), 'iTerm2 OSC 1337 sequence')
})

test('width-stable renders reuse the cached lines (steady-frame reuse)', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const loader = loaderOf(new Uint8Array([1]))
  loader.load(REF)
  const component = new ImageThumbnail(REF, loader, THEME)
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
  const component = new ImageThumbnail(REF, loader, THEME)
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
  const component = new ImageThumbnail(REF, loader, THEME)
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
  const component = new ImageThumbnail(REF, loader, THEME)
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
