/**
 * M7/M10/M11 integration tests: image-bearing messages fold into the
 * transcript with ordered content blocks and render as thumbnails (plan
 * §15, M10 resume, M11 tool-result).
 * @module @xmoon76/dsh-pi-tui/image-transcript.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { createToolResultMessage, ToolCallId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { TranscriptFolder } from '../../src/transcript.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { ImageLoader } from '../../src/client/media/image/loader.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import type { ImageAttachmentRefLike } from '../../src/domain/media/types.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

const IMAGE_REF: ImageAttachmentRefLike = {
  attachmentId: 'att-img-1',
  mediaType: 'image/png',
  bytes: 4,
  width: 800,
  height: 600,
  name: 'shot.png',
}

function userMessageEvent(content: unknown[], source: { kind: string } = { kind: 'user' }): never {
  return { type: 'user/message', seq: 1, time: 1, data: { content, source } } as never
}

function assistantMessageEvent(content: unknown[]): never {
  return { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 0, message: { content } } } as never
}

function toolResultEvent(blocks: unknown[]): never {
  return {
    type: 'tool/result',
    seq: 1,
    time: 1,
    data: {
      turn: 0,
      step: 0,
      message: createToolResultMessage({
        callId: ToolCallId('call-1'),
        content: blocks as readonly ContentBlock[],
        isError: false,
      }),
    },
  } as never
}

test('a user message with images folds with ordered content blocks', () => {
  const folder = new TranscriptFolder()
  folder.apply([userMessageEvent([
    { type: 'text', text: '分析 ' },
    { type: 'image', attachment: IMAGE_REF },
    { type: 'text', text: ' 的差异' },
  ])])
  const messages = folder.messages()
  assert.equal(messages.length, 1)
  const message = messages[0]!
  assert.equal(message.kind, 'user')
  if (message.kind !== 'user') return
  // The FLAT text keeps an inline marker at the image's position (search
  // and loader-less rendering consume `text`); the ordered `content` blocks
  // stay the canonical form for thumbnail rendering.
  assert.equal(message.text, '分析 🖼️ shot.png 的差异')
  assert.deepEqual(message.content?.map(block => block.type), ['text', 'image', 'text'])
  assert.equal(message.content?.[1]?.type === 'image' && message.content[1].attachment.attachmentId, 'att-img-1')
})

test('an image-only user message folds (never dropped as empty text)', () => {
  const folder = new TranscriptFolder()
  folder.apply([userMessageEvent([{ type: 'image', attachment: IMAGE_REF }])])
  const messages = folder.messages()
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.kind, 'user')
})

test('a glued draft still gets a separating space around the inline marker', () => {
  // The /image insertion leaves NO space before the placeholder
  // (`这张图是啥[image…]`), so the flat projection must add one — the
  // marker must never glue to the preceding text.
  const folder = new TranscriptFolder()
  folder.apply([userMessageEvent([
    { type: 'text', text: '这张图是啥' },
    { type: 'image', attachment: IMAGE_REF },
    { type: 'text', text: '看看' },
  ])])
  const message = folder.messages()[0]!
  assert.equal(message.kind, 'user')
  if (message.kind !== 'user') return
  assert.equal(message.text, '这张图是啥 🖼️ shot.png 看看')
})

test('an assistant image block folds without crashing and keeps its blocks', () => {
  const folder = new TranscriptFolder()
  folder.apply([assistantMessageEvent([
    { type: 'text', text: 'result:' },
    { type: 'image', attachment: IMAGE_REF },
  ])])
  const messages = folder.messages()
  const assistant = messages.find(message => message.kind === 'assistant')
  assert.ok(assistant !== undefined, 'assistant entry exists')
  if (assistant === undefined || assistant.kind !== 'assistant') return
  assert.equal(assistant.text, 'result:')
  assert.equal(assistant.content?.length, 2)
})

test('a tool result with an image keeps resultBlocks and folds [text, image]', () => {
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 0, step: 0, callId: 'call-1', name: 'read_image', arguments: '{}' } } as never,
    toolResultEvent([
      { type: 'text', text: 'caption' },
      { type: 'image', attachment: IMAGE_REF },
    ]),
  ])
  const messages = folder.messages()
  const tool = messages.find(message => message.kind === 'tool')
  assert.ok(tool !== undefined)
  if (tool === undefined || tool.kind !== 'tool') return
  assert.equal(tool.resultBlocks?.length, 2)
  assert.equal(tool.resultBlocks?.[1]?.type === 'image' && tool.resultBlocks[1].attachment?.attachmentId, 'att-img-1')
})

function startAppWithLoader(): { vt: VirtualTerminal; app: TuiApp; loader: ImageLoader } {
  const vt = new VirtualTerminal(100, 24)
  const loader = new ImageLoader(async () => ({ ref: {}, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) }))
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text) => text },
  })
  app.start()
  startedApps.add(app)
  return { vt, app, loader }
}

test('the TUI renders a user message with an image (fallback line, then inline-ready)', async () => {
  const { vt, app, loader } = startAppWithLoader()
  await vt.waitForRender()
  // Feed one folded user message through the app's public surface: rebuild
  // the transcript from the folder output (the same path the runner uses).
  const folder = new TranscriptFolder()
  folder.apply([userMessageEvent([
    { type: 'text', text: 'check ' },
    { type: 'image', attachment: IMAGE_REF },
  ])])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  // The image renders as the fallback summary line (loader resolves async;
  // the first frame shows the pending text).
  assert.ok(view.includes('🖼️ '), `thumbnail fallback visible:\n${view}`)
  assert.ok(view.includes('800×600'), `dimensions in fallback:\n${view}`)
  // The user BUBBLE itself keeps an inline `🖼️ name` marker at the image's
  // position — the message never reads as text-only with the picture
  // silently moved to its own row.
  assert.ok(view.includes('check 🖼️ shot.png'), `bubble marker missing:\n${view}`)
  // After the loader settles, a notified repaint keeps the fallback for
  // non-inline terminals (headless caps default to no images).
  await new Promise(resolve => setTimeout(resolve, 30))
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('🖼️ '), 'settled state still shows the text fallback headless')
  app.stop()
})

test('a tool-result image renders inside the tool card (generic tool)', async () => {
  const { vt, app } = startAppWithLoader()
  app.setTranscriptDetailExpanded(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 0, step: 0, callId: 'call-1', name: 'screenshot_tool', arguments: [] } } as never,
    toolResultEvent([
      { type: 'text', text: 'caption' },
      { type: 'image', attachment: IMAGE_REF },
    ]),
  ])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('🖼️ '), `tool-card image fallback visible:\n${view}`)
  assert.ok(view.includes('caption'), 'the text block still renders')
  app.stop()
})

test('a read_image tool card renders its image blocks as thumbnails', async () => {
  const { vt, app } = startAppWithLoader()
  app.setTranscriptDetailExpanded(true)
  const folder = new TranscriptFolder()
  folder.apply([
    { type: 'tool/call', seq: 1, time: 1, data: { turn: 0, step: 0, callId: 'call-1', name: 'read_image', arguments: [] } } as never,
    toolResultEvent([
      { type: 'image', attachment: IMAGE_REF },
    ]),
  ])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('🖼️ '), `read_image card shows the thumbnail:\n${view}`)
  app.stop()
})

test('a rebuild (resize) keeps the thumbnail loader subscription alive (non-owning projection)', async () => {
  // PR review round 3 blocker: rebuildMessages clears messagesView, and
  // the fork's Container.clear() DISPOSES every child. The gutter wrapper
  // must be NON-OWNING (the messageComponents cache owns the cached
  // component lifecycle), or any rebuild — the first frame and every
  // resize now rebuild — disposes the CACHED ImageThumbnail while the
  // cache reuses it: the loader subscription drops, and the settle-time
  // repaint is lost (the loading row sticks until an unrelated repaint).
  let resolveRead!: (value: { ref: unknown; data: Uint8Array }) => void
  const loader = new ImageLoader(() => new Promise<{ ref: unknown; data: Uint8Array }>(resolve => {
    resolveRead = resolve
  }))
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    imageLoader: loader,
    imageTheme: { fallbackColor: (text) => text },
  })
  app.start()
  startedApps.add(app)
  const folder = new TranscriptFolder()
  folder.apply([userMessageEvent([
    { type: 'text', text: 'check ' },
    { type: 'image', attachment: IMAGE_REF },
  ])])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  // The first geometry pass already clears + re-adds the projection: the
  // subscription count is the regression lock (pre-fix it dropped to 0
  // on the very first frame).
  assert.equal(loader.listenerCount(), 1, 'a rebuild must not dispose the cached thumbnail (non-owning projection)')
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('🖼️ shot.png · 800×600'), `the thumbnail row must render:\n${view}`)
  // A resize rebuild must keep the same cached thumbnail alive — its
  // loader subscription still reaches it.
  vt.resize(100, 24)
  await vt.waitForRender()
  assert.equal(loader.listenerCount(), 1, 'a resize must NOT drop the loader subscription')
  // The settle still reaches the live subscriber: it invalidates the
  // component, so a repaint reads the resolved state.
  resolveRead?.({ ref: {}, data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) })
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(loader.listenerCount(), 1, 'the subscriber must survive the settle')
  app.requestRender(true)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('🖼️ shot.png · 800×600'), 'the resolved thumbnail row must still render after the settle')
  app.stop()
})
// ---------------------------------------------------------------------------
// Image-6A: the source message stays the authority (refs, MIME, order, bytes)
// ---------------------------------------------------------------------------

test('a JPEG/WebP message keeps its ORIGINAL refs, block order and model-facing content', () => {
  // The preview derivation is a DISPLAY projection: the folded message must
  // keep the original MIME types, attachment ids, byte counts and dimensions,
  // and the flat marker order must still name both source images.
  const jpeg: ImageAttachmentRefLike = {
    attachmentId: 'att-jpeg',
    mediaType: 'image/jpeg',
    bytes: 968,
    width: 120,
    height: 80,
    name: 'photo.jpg',
  }
  const webp: ImageAttachmentRefLike = {
    attachmentId: 'att-webp',
    mediaType: 'image/webp',
    bytes: 138,
    width: 48,
    height: 32,
    name: 'graphic.webp',
  }
  const folder = new TranscriptFolder()
  folder.apply([userMessageEvent([
    { type: 'text', text: 'compare' },
    { type: 'image', attachment: jpeg },
    { type: 'text', text: 'with' },
    { type: 'image', attachment: webp },
  ])])
  const message = folder.messages()[0]!
  assert.equal(message.kind, 'user')
  if (message.kind !== 'user') return
  assert.deepEqual(message.content?.map(block => block.type), ['text', 'image', 'text', 'image'])
  const images = message.content?.filter(block => block.type === 'image') ?? []
  assert.equal(images[0]?.type === 'image' && images[0].attachment.mediaType, 'image/jpeg')
  assert.equal(images[0]?.type === 'image' && images[0].attachment.attachmentId, 'att-jpeg')
  assert.equal(images[0]?.type === 'image' && images[0].attachment.bytes, 968)
  assert.equal(images[0]?.type === 'image' && images[0].attachment.width, 120)
  assert.equal(images[0]?.type === 'image' && images[0].attachment.height, 80)
  assert.equal(images[0]?.type === 'image' && images[0].attachment.name, 'photo.jpg')
  assert.equal(images[1]?.type === 'image' && images[1].attachment.mediaType, 'image/webp')
  assert.equal(images[1]?.type === 'image' && images[1].attachment.attachmentId, 'att-webp')
  assert.equal(images[1]?.type === 'image' && images[1].attachment.bytes, 138)
  assert.equal(images[1]?.type === 'image' && images[1].attachment.width, 48)
  assert.equal(images[1]?.type === 'image' && images[1].attachment.height, 32)
  assert.equal(images[1]?.type === 'image' && images[1].attachment.name, 'graphic.webp')
  assert.equal(message.text, 'compare 🖼️ photo.jpg with 🖼️ graphic.webp')
})

// ── PTC image-bearing injected Context ─────────────────────────────────────

/** One real PTC Context delivery: `user/message` with producer source
 * `ptc-mode` and the nested sub-call's image-bearing content blocks. */
function ptcContextEvent(
  blocks: readonly unknown[],
  id = 'ptc-context-1',
  source: Record<string, unknown> = { kind: 'ptc-mode' },
): never {
  return {
    type: 'user/message', seq: 1, time: 1,
    data: { id, role: 'user', content: blocks, source },
  } as never
}

const IMAGE_REF_2: ImageAttachmentRefLike = {
  attachmentId: 'att-img-2',
  mediaType: 'image/png',
  bytes: 8,
  width: 320,
  height: 200,
  name: 'second.png',
}

test('a PTC context keeps its ordered text/image/text content and flat marker', () => {
  const blocks = [
    { type: 'text', text: 'before ' },
    { type: 'image', attachment: IMAGE_REF },
    { type: 'text', text: ' after' },
  ] as unknown as ContentBlock[]
  const folder = new TranscriptFolder()
  folder.apply([ptcContextEvent(blocks)])
  const messages = folder.messages()
  assert.equal(messages.length, 1)
  const message = messages[0]!
  assert.equal(message.kind, 'system')
  if (message.kind !== 'system') return
  assert.equal(message.context, true)
  assert.equal(message.contextPresentation?.sourceKind, 'ptc-mode')
  assert.equal(message.content, blocks, 'the fold keeps the ORIGINAL ordered block array')
  assert.deepEqual(message.content?.map(block => block.type), ['text', 'image', 'text'])
  assert.equal(message.text, 'before 🖼️ shot.png after', 'the flat text keeps its original marker')
})

test('an image-only or multi-image PTC context folds completely (never dropped)', () => {
  const imageOnly = [{ type: 'image', attachment: IMAGE_REF }] as unknown as ContentBlock[]
  const single = new TranscriptFolder()
  single.apply([ptcContextEvent(imageOnly)])
  const singleMessage = single.messages()[0]!
  assert.equal(singleMessage.kind, 'system')
  if (singleMessage.kind !== 'system') return
  assert.equal(singleMessage.text, '🖼️ shot.png')
  assert.equal(singleMessage.content?.length, 1)

  const twoImages = [
    { type: 'image', attachment: IMAGE_REF },
    { type: 'text', text: 'between' },
    { type: 'image', attachment: IMAGE_REF_2 },
  ] as unknown as ContentBlock[]
  const multi = new TranscriptFolder()
  multi.apply([ptcContextEvent(twoImages)])
  const multiMessage = multi.messages()[0]!
  assert.equal(multiMessage.kind, 'system')
  if (multiMessage.kind !== 'system') return
  assert.deepEqual(multiMessage.content?.map(block => block.type), ['image', 'text', 'image'])
  assert.equal(multiMessage.text, '🖼️ shot.png between 🖼️ second.png')
  assert.equal(multiMessage.content?.[2]?.type === 'image' && multiMessage.content[2].attachment.attachmentId, 'att-img-2')
})

test('a text-only PTC context and every non-PTC Context keep no structured content', () => {
  const textOnly = new TranscriptFolder()
  textOnly.apply([{
    type: 'user/message', seq: 1, time: 1,
    data: { id: 'ptc-text', role: 'user', content: [{ type: 'text', text: 'plain spill body' }], source: { kind: 'ptc-mode' } },
  } as never])
  const spill = textOnly.messages()[0]!
  assert.equal(spill.kind, 'system')
  if (spill.kind === 'system') assert.equal(spill.content, undefined)

  const foreign = new TranscriptFolder()
  foreign.apply([{
    type: 'user/message', seq: 1, time: 1,
    data: {
      id: 'foreign-image-context', role: 'user',
      content: [{ type: 'image', attachment: IMAGE_REF }],
      source: { kind: 'plugin', form: 'notice', plugin: 'foreign' },
    },
  } as never])
  const foreignRow = foreign.messages()[0]!
  assert.equal(foreignRow.kind, 'system')
  if (foreignRow.kind === 'system') assert.equal(foreignRow.content, undefined,
    'only the ptc-mode producer gets the structured image projection')
})

test('a form-bearing PTC image keeps its structured media on the generic PiTui row', async () => {
  const { vt, app } = startAppWithLoader()
  const folder = new TranscriptFolder()
  folder.apply([ptcContextEvent([
    { type: 'text', text: 'foreign before ' },
    { type: 'image', attachment: IMAGE_REF },
    { type: 'text', text: ' foreign after' },
  ], 'form-bearing-ptc', { kind: 'ptc-mode', form: 'notice', summary: 'foreign producer' })])
  const row = folder.messages().find(message => message.kind === 'system')
  assert.ok(row !== undefined && row.kind === 'system')
  assert.equal(row.contextPresentation?.form, 'notice')
  assert.equal(row.contextPresentation?.formDeclared, true)
  assert.equal(row.contextPresentation?.sameTurnNextStep, undefined,
    'a form-bearing PTC row stays independent (no carriage claim was present)')
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  vt.sendInput('\x0f')
  await vt.waitForRender()
  await new Promise(resolve => setTimeout(resolve, 30))
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Context injection ptc-mode'), `the generic labeled row is painted:\n${view}`)
  assert.ok(view.includes('🖼️ shot.png'), `the structured image is painted, not only flat text:\n${view}`)
  assert.ok(view.includes('800×600'), `the image identity line is painted:\n${view}`)
  assert.ok(view.includes('foreign before') && view.includes('foreign after'),
    'the ordered text blocks stay around the image')
  const internals = app as unknown as {
    mountedImageOccurrences(): { imageIndex: number; ref: { name?: string } }[]
  }
  const occurrences = internals.mountedImageOccurrences()
  assert.equal(occurrences.length, 1, 'the form-bearing PTC image is a real viewer occurrence')
  assert.equal(occurrences[0]?.imageIndex, 0)
  assert.equal(occurrences[0]?.ref.name, 'shot.png')
  app.stop()
})

test('an expanded PTC context renders its image inside the row and is a mounted occurrence', async () => {
  const { vt, app } = startAppWithLoader()
  const folder = new TranscriptFolder()
  folder.apply([ptcContextEvent([
    { type: 'text', text: 'before ' },
    { type: 'image', attachment: IMAGE_REF },
    { type: 'text', text: ' after' },
  ])])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Context injection ptc-mode'), `the generic Context header is painted:\n${view}`)
  assert.ok(!view.includes('800×600'), 'the collapsed row starts no image body/mount')
  vt.sendInput('\x0f') // ctrl+o expands the recent transcript folds
  await vt.waitForRender()
  await new Promise(resolve => setTimeout(resolve, 30))
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('🖼️ shot.png'), `the image body is mounted after expanding:\n${view}`)
  assert.ok(view.includes('800×600'), `the image info line is painted:\n${view}`)
  assert.ok(view.includes('before') && view.includes('after'), 'the ordered text blocks stay around the image')
  const internals = app as unknown as {
    mountedImageOccurrences(): { imageIndex: number; ref: { name?: string } }[]
  }
  const occurrences = internals.mountedImageOccurrences()
  assert.ok(occurrences.some(occurrence => occurrence.imageIndex === 0 && occurrence.ref.name === 'shot.png'),
    `the expanded Context image is a real source-ordinal occurrence:\n${occurrences.map(o => `${o.imageIndex}:${o.ref.name}`).join(', ')}`)
  app.stop()
})

test('a loader-less PTC context paints the marker and records a metadata-only occurrence', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const folder = new TranscriptFolder()
  folder.apply([ptcContextEvent([{ type: 'image', attachment: IMAGE_REF }])])
  app.setTranscript(folder.messages())
  await vt.waitForRender()
  vt.sendInput('\x0f')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Context injection ptc-mode'), `the generic Context header is painted:\n${view}`)
  assert.ok(view.includes('🖼️ shot.png'), `the loader-less image keeps its readable marker:\n${view}`)
  const internals = app as unknown as {
    mountedImageOccurrences(): { imageIndex: number; ref: { name?: string } }[]
  }
  const occurrences = internals.mountedImageOccurrences()
  assert.equal(occurrences.length, 1, 'the loader-less image is still a viewer candidate')
  assert.equal(occurrences[0]?.imageIndex, 0)
  assert.equal(occurrences[0]?.ref.name, 'shot.png')
  app.stop()
})
