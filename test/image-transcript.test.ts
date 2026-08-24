/**
 * M7/M10/M11 integration tests: image-bearing messages fold into the
 * transcript with ordered content blocks and render as thumbnails (plan
 * §15, M10 resume, M11 tool-result).
 * @module @xmoon76/dsh-pi-tui/image-transcript.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { ImageLoader } from '../src/image/loader.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import type { ImageAttachmentRefLike } from '../src/image/admission.ts'

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
      callId: 'call-1',
      message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: blocks }] },
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
  app.setToolOutputExpanded(true)
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
  app.setToolOutputExpanded(true)
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
