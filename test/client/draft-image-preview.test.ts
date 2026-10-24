/**
 * Image UX PR1 tests: the composer draft-image preview projection (Owner
 * revision 2026-10-23: ONE card, last referenced occurrence, 44×3 wide /
 * 22×3 split, one identity row + `x` control, one-line summary fallback).
 * @module @xmoon76/dsh-pi-tui/draft-image-preview.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from '@xmoon76/pi-tui'
import {
  DRAFT_PREVIEW_MAX_PIXEL_BYTES,
  DRAFT_PREVIEW_WIDE_CARD_WIDTH,
  DraftImagePreview,
} from '../../src/tui/components/media/draft-image-preview.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import type { DraftImage, DraftImagePreviewSource } from '../../src/client/media/image/types.ts'
import type { DraftImageOccurrence } from '../../src/client/media/image/placeholder.ts'

const THEME = { fallbackColor: (text: string) => text }

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
}

function harness(
  store: DraftImageStore,
  options: {
    draft?: string
    maxRows?: number
    fullscreen?: boolean
    removable?: (occurrence: DraftImageOccurrence) => boolean
  } = {},
): PreviewHarness {
  let draft = options.draft ?? ''
  const source: DraftImagePreviewSource = { values: () => store.values() }
  const component = new DraftImagePreview({
    getDraftText: () => draft,
    source,
    maxRows: () => options.maxRows ?? 4,
    fullscreenMouse: () => options.fullscreen ?? false,
    ...(options.removable === undefined ? {} : { removable: options.removable }),
  }, THEME)
  return { component, setDraft: (text: string) => { draft = text } }
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
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

test('unsupported, non-PNG, oversized and recalled drafts keep real metadata and a reason', () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })
  const store = new DraftImageStore()
  const jpeg = addImage(store, { mediaType: 'image/jpeg', name: 'shot.jpg' })
  const { component, setDraft } = harness(store)
  setDraft(jpeg.placeholder)
  for (const capabilities of ['kitty', null] as const) {
    resetCapabilitiesCache()
    setCapabilities({ images: capabilities, trueColor: true, hyperlinks: false })
    const lines = component.render(100)
    const identity = stripAnsi(lines[0]!)
    assert.ok(identity.includes('Preview unavailable'), `reason: ${identity}`)
    assert.ok(identity.includes('image/jpeg'), `MIME: ${identity}`)
    assert.ok(identity.includes('shot.jpg'), `name: ${identity}`)
    assert.ok(identity.includes('800×100'), `dimensions: ${identity}`)
    assert.ok(!lines.join('\n').includes('\x1b_G'), 'no unsafe kitty/unsupported upload')
  }
  const big = addImage(store, { bytes: new Uint8Array(DRAFT_PREVIEW_MAX_PIXEL_BYTES + 1) })
  setDraft(big.placeholder)
  assert.ok(stripAnsi(component.render(100)[0]!).includes('Preview unavailable'))
  const recalled = store.add({
    mediaType: 'image/png',
    width: 800,
    height: 100,
    source: { type: 'recalled' },
    recalledRef: { attachmentId: 'att-r', mediaType: 'image/png', bytes: 10, width: 800, height: 100 },
  })
  setDraft(recalled.placeholder)
  assert.ok(stripAnsi(component.render(100)[0]!).includes('Preview unavailable'))
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
