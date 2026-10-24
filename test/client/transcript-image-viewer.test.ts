/**
 * The read-only transcript image viewer panel: short-window layout, loader
 * states, capability gates, scope isolation, resize and teardown.
 * @module @xmoon76/dsh-pi-tui/transcript-image-viewer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from '@xmoon76/pi-tui'
import { ImageViewerPanel } from '../../src/tui/components/media/image-viewer.ts'
import { Frame } from '../../src/tui/components/frame.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'

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

/** Override the detected graphics protocol for one test. */
function capabilities(images: 'kitty' | 'iterm2' | null): void {
  resetCapabilitiesCache()
  setCapabilities({ images, trueColor: true, hyperlinks: false })
}

/** Strip SGR so assertions compare painted content, not palette bytes. */
function stripSgr(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
}

function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 10))
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
    scope: options.scope ?? {},
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
  await settle()
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
  await settle()
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
  await settle()
  const lines = panel.render(60)
  const body = lines[1]!
  assert.ok(stripSgr(body).includes('Read failed: storage'), `error row names the failure: ${stripSgr(body)}`)
  assert.ok(stripSgr(body).includes('down'), 'the folded remainder stays visible')
  assert.ok(!body.includes('\n') && !body.includes('\t'), 'an embedded newline/tab never breaks the row')
  assert.equal(lines.length, 3, 'the error state paints exactly one status row in the body')
  assert.ok(lines.length <= 8)
  assert.ok(visibleWidth(body) <= 60)
})

test('kitty refuses non-PNG refs instead of building an Image or reading bytes', async () => {
  capabilities('kitty')
  let reads = 0
  const loader = new ImageLoader(async () => {
    reads += 1
    return { ref: {}, data: JPEG_BYTES }
  })
  const panel = panelOf(loader, { ref: JPEG_REF })
  panel.setMaxRows(8)
  const lines = panel.render(60)
  assert.ok(stripSgr(lines[1]!).includes('Preview unavailable'))
  await settle()
  assert.equal(reads, 0, 'an undisplayable ref triggers no read')
  assert.ok(!panel.render(60).join('\n').includes('\x1b_G'), 'no kitty placement for a non-PNG ref')
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
  await settle()
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
  await settle()
  assert.equal(reads, 0, 'no pointless read on an unsupported terminal')
})

test('empty ready bytes paint Preview unavailable', async () => {
  capabilities('kitty')
  const panel = panelOf(loaderOf(new Uint8Array(0)))
  panel.setMaxRows(8)
  panel.render(60)
  await settle()
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
  assert.equal(lines.length, 3, 'title + one status row + bottom row')
  assert.ok(stripSgr(lines[1]!).includes('Preview unavailable'))
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
  await settle()
  const bReady = b.render(60)
  assert.ok(bReady.join('\n').includes('\x1b_G'), 'B paints its own resolved bytes')
  assert.ok(stripSgr(a.render(60)[1]!).includes('Loading…'), 'A is still held by its own read')
  assert.equal(requestedB, 1, 'B heard only its own settle')
  pendingA.resolve()
  await settle()
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
  await settle()
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
  await settle()
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
  await settle()
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
  await settle()
  const lines = panel.render(60)
  assert.ok(lines.length <= 22, `the pre-grant default stays finite (${lines.length} <= 22)`)
  assert.equal(stripSgr(lines[0]!), 'Image · image')
})

test('unchanged inputs reuse the local Image instance instead of rebuilding it', async () => {
  capabilities('kitty')
  const panel = panelOf(loaderOf(PNG_BYTES))
  panel.setMaxRows(12)
  panel.render(60)
  await settle()
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
  await settle()
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
