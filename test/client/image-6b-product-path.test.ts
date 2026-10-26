/**
 * Image-6B product-path integration (plan §6 Batch 3 / D20-D22): the REAL
 * staged draft bytes become the production-shaped prepared prompt, the same
 * bytes are read back as durable transcript attachments, the transcript paints
 * their scoped 6A derivatives, and `/view-image` opens the Viewer on those same
 * derivatives — all through one `ImageLoader`, no model/account/network and no
 * second image service or fake decoder.
 *
 * The draft card and the durable transcript are two authorities over the SAME
 * encoded bytes: the draft store keeps the Client-local staged bytes; the
 * durable ref models what the Host accepted on submit. This test proves the
 * 6A decoder is not duplicated between them and that the original media type,
 * dimensions and bytes survive the whole journey.
 * @module @xmoon76/dsh-pi-tui/image-6b-product-path.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { resetCapabilitiesCache, setCapabilities } from '@xmoon76/pi-tui'
import { TuiApp } from '../../src/tui-app.ts'
import { TranscriptFolder } from '../../src/transcript.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { preparePrompt } from '../../src/app/submission/prepared-prompt.ts'
import { ImageCache } from '../../src/client/media/image/cache.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { convertKittyThumbnail } from '../../src/client/media/image/kitty-thumbnail.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

const SAMPLE_JPEG = readFileSync(new URL('../fixtures/images/transcript-sample.jpg', import.meta.url))
const SAMPLE_WEBP = readFileSync(new URL('../fixtures/images/transcript-sample.webp', import.meta.url))

function userMessage(content: unknown[], seq: number): never {
  return { type: 'user/message', seq, time: seq, data: { content, source: { kind: 'user' } } } as never
}

/** Wait for an authoritative fact, not a wall-clock window. */
async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** Every Kitty f=100 image ID the TUI actually wrote. */
function writtenKittyImageIds(vt: VirtualTerminal): string[] {
  const ids = new Set<string>()
  for (const chunk of vt.writes) {
    for (const match of chunk.matchAll(/\x1b_G([^;\x1b]*);[^\x1b]*\x1b\\/g)) {
      if (!match[1]!.includes('f=100')) continue
      const id = /(?:^|,)i=(\d+)/.exec(match[1]!)
      if (id !== null) ids.add(id[1]!)
    }
  }
  return [...ids]
}

function startApp(
  vt: VirtualTerminal,
  loader: ImageLoader,
  store: DraftImageStore,
): TuiApp {
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    draftImagePreviewSource: { values: () => store.values() },
    draftImagePreviewLiveDraft: read => store.setLiveDraftTextSource(read),
    imageTheme: { fallbackColor: text => text },
  })
  app.start()
  startedApps.add(app)
  return app
}

test('staged JPEG/WebP → prepared prompt → transcript → /view-image paints the SAME 6A derivative', async () => {
  resetCapabilitiesCache()
  setCapabilities({ images: 'kitty', trueColor: true, hyperlinks: false })

  // 1. The REAL Client-local staged bytes (image-only; no model, no account).
  const store = new DraftImageStore()
  const stagedJpeg = store.add({
    bytes: SAMPLE_JPEG,
    mediaType: 'image/jpeg',
    width: 120,
    height: 80,
    name: 'photo.jpg',
  })
  const stagedWebp = store.add({
    bytes: SAMPLE_WEBP,
    mediaType: 'image/webp',
    width: 120,
    height: 80,
    name: 'graphic.webp',
  })

  // 2. The production-shaped submission snapshot: the SAME `preparePrompt` the
  //    local submission path uses. The accepted content must still be the
  //    ORIGINAL encoded images, in order.
  const prepared = preparePrompt('session-6b-product', `${stagedJpeg.placeholder} ${stagedWebp.placeholder}`, { images: store })
  const preparedImages = prepared.segments.filter(segment => segment.type === 'image')
  assert.equal(preparedImages.length, 2, 'the prepared prompt carries both staged images')
  assert.deepEqual([...preparedImages[0]!.image.bytes], [...SAMPLE_JPEG], 'the submitted JPEG bytes are unchanged')
  assert.deepEqual([...preparedImages[1]!.image.bytes], [...SAMPLE_WEBP], 'the submitted WebP bytes are unchanged')
  assert.deepEqual(
    preparedImages.map(segment => [segment.image.mediaType, segment.image.width, segment.image.height]),
    [['image/jpeg', 120, 80], ['image/webp', 120, 80]],
    'the submitted MIME and dimensions are the original ones',
  )

  // 3. The durable facts the Host would return, read back through the OFFICIAL
  //    image loader path (one read per attachment, no second image service).
  const jpegRef: ImageAttachmentRefLike = {
    attachmentId: 'att-6b-jpeg',
    mediaType: 'image/jpeg',
    bytes: preparedImages[0]!.image.byteLength,
    width: preparedImages[0]!.image.width,
    height: preparedImages[0]!.image.height,
    name: preparedImages[0]!.image.name,
  }
  const webpRef: ImageAttachmentRefLike = {
    attachmentId: 'att-6b-webp',
    mediaType: 'image/webp',
    bytes: preparedImages[1]!.image.byteLength,
    width: preparedImages[1]!.image.width,
    height: preparedImages[1]!.image.height,
    name: preparedImages[1]!.image.name,
  }
  const durableBytes = new Map<string, Uint8Array>([
    [jpegRef.attachmentId, preparedImages[0]!.image.bytes],
    [webpRef.attachmentId, preparedImages[1]!.image.bytes],
  ])
  const reads = new Map<string, number>()
  let conversions = 0
  const loader = new ImageLoader(
    async (ref) => {
      reads.set(ref.attachmentId, (reads.get(ref.attachmentId) ?? 0) + 1)
      const data = durableBytes.get(ref.attachmentId)
      assert.ok(data !== undefined, `unexpected attachment read: ${ref.attachmentId}`)
      return { ref: {}, data }
    },
    new ImageCache(),
    async (input, mediaType) => {
      conversions += 1
      return convertKittyThumbnail(input, mediaType)
    },
  )

  const vt = new VirtualTerminal(100, 60)
  const app = startApp(vt, loader, store)

  // 4. The composer draft card paints real pixels for the last staged image
  //    (first JPEG, then WebP after the draft grows).
  app.setDraft(stagedJpeg.placeholder)
  await until(() => writtenKittyImageIds(vt).length >= 1, 'the JPEG draft card')
  await vt.waitForRender()
  const jpegDraft = vt.getViewport().join('\n')
  assert.ok(jpegDraft.includes('🖼️ #1/1 · 120×80 · 968 B'), `the draft card keeps the original JPEG identity:\n${jpegDraft}`)
  assert.ok(!jpegDraft.includes('Preview unavailable'), 'the JPEG draft card paints pixels')

  app.setDraft(`${stagedJpeg.placeholder} ${stagedWebp.placeholder}`)
  await until(() => writtenKittyImageIds(vt).length >= 2, 'the WebP draft card')
  await vt.waitForRender()
  const webpDraft = vt.getViewport().join('\n')
  assert.ok(webpDraft.includes('🖼️ #2/2 · 120×80 · 138 B'), `the draft card follows the LAST occurrence:\n${webpDraft}`)

  // 5. The accepted submission clears the composer, then the durable
  //    transcript renders the SAME bytes as transcript image occurrences.
  app.setDraft('')
  app.setFullscreen(true)
  const folder = new TranscriptFolder()
  folder.apply([userMessage([
    { type: 'text', text: 'submitted images' },
    { type: 'image', attachment: jpegRef },
    { type: 'text', text: 'and' },
    { type: 'image', attachment: webpRef },
  ], 1)])
  app.setTranscript(folder.messages())
  await until(() => loader.getKittyThumbnail(jpegRef).state === 'ready'
    && loader.getKittyThumbnail(webpRef).state === 'ready', 'both transcript derivatives')
  await vt.waitForRender()
  const transcript = vt.getViewport().join('\n')
  assert.ok(transcript.includes('🖼️ photo.jpg · 120×80'), `the JPEG transcript row:\n${transcript}`)
  assert.ok(transcript.includes('🖼️ graphic.webp · 120×80'), `the WebP transcript row:\n${transcript}`)
  assert.deepEqual(
    [reads.get(jpegRef.attachmentId), reads.get(webpRef.attachmentId)],
    [1, 1],
    'each durable attachment is read exactly once',
  )
  const conversionsAfterThumbnails = conversions
  assert.equal(conversionsAfterThumbnails, 2, 'each READY source is converted exactly once')
  assert.equal(loader.kittyThumbnailCacheSize(), 2, 'two scoped derived entries')

  // 6. `/view-image` → list → Viewer: the Viewer consumes the SAME scoped
  //    derivative (no second read, no second conversion) and keeps the
  //    ORIGINAL ref metadata.
  const internals = app as unknown as {
    mountedImageOccurrences(): unknown[]
    canLeaseImageWorkspace(): boolean
    openTranscriptImagePicker(): void
  }
  assert.equal(internals.mountedImageOccurrences().length, 2, 'fixture: both transcript images are occurrences')
  assert.equal(internals.canLeaseImageWorkspace(), true, 'fixture: the workspace lease is free')
  internals.openTranscriptImagePicker()
  await vt.waitForRender()
  const listView = vt.getViewport().join('\n')
  assert.ok(listView.includes('Images · current transcript'), `the image list opened:\n${listView}`)
  assert.ok(listView.includes('#1 · photo.jpg · 120×80 · image/jpeg'), `the JPEG candidate:\n${listView}`)
  assert.ok(listView.includes('#2 · graphic.webp · 120×80 · image/webp'), `the WebP candidate:\n${listView}`)

  const transcriptIds = writtenKittyImageIds(vt).length
  vt.sendInput('\r')
  await vt.waitForRender()
  const jpegViewer = vt.getViewport().join('\n')
  assert.ok(jpegViewer.includes('Image · photo.jpg'), `the JPEG Viewer opened:\n${jpegViewer}`)
  assert.ok(jpegViewer.includes('120×80 · image/jpeg'), `the original JPEG metadata:\n${jpegViewer}`)
  assert.ok(!jpegViewer.includes('Preview unavailable'), `the JPEG Viewer paints pixels:\n${jpegViewer}`)
  assert.ok(jpegViewer.includes('Esc back'), 'the list-opened Viewer advertises Esc back')
  assert.ok(writtenKittyImageIds(vt).length > transcriptIds, 'the Viewer wrote its own PNG placement')
  assert.equal(conversions, conversionsAfterThumbnails, 'the Viewer added no conversion')
  assert.equal(reads.get(jpegRef.attachmentId), 1, 'the Viewer re-read no raw bytes')
  assert.equal(loader.kittyThumbnailCacheSize(), 2, 'the Viewer added no second derived cache entry')

  vt.sendInput('\x1b')
  await new Promise(resolve => setTimeout(resolve, 600))
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('Images · current transcript'), 'Esc back returns to the list')
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  const webpViewer = vt.getViewport().join('\n')
  assert.ok(webpViewer.includes('Image · graphic.webp'), `the WebP Viewer opened:\n${webpViewer}`)
  assert.ok(webpViewer.includes('120×80 · image/webp'), `the original WebP metadata:\n${webpViewer}`)
  assert.ok(!webpViewer.includes('Preview unavailable'), `the WebP Viewer paints pixels:\n${webpViewer}`)
  assert.equal(conversions, conversionsAfterThumbnails, 'the WebP Viewer added no conversion either')

  vt.sendInput('\x1b')
  await new Promise(resolve => setTimeout(resolve, 600))
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await new Promise(resolve => setTimeout(resolve, 600))
  await vt.waitForRender()
  const restored = vt.getViewport().join('\n')
  assert.ok(restored.includes('🖼️ photo.jpg · 120×80'), `the transcript is restored:\n${restored}`)
  assert.ok(restored.includes('🖼️ graphic.webp · 120×80'))
  assert.ok(!restored.includes('Images · current transcript'), 'the workspace closed')
  assert.ok(!vt.writes.join('').includes('\x1b]1337;File='), 'no iTerm2 sequence was used on Kitty')

  app.setFullscreen(false)
  app.stop()
})
