/**
 * Stage C1 coverage for finalized file and generic content presentation.
 * @module @xmoon76/dsh-pi-tui/file-transcript.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  finalizedBlockFallbackText,
  fileAttachmentSummary,
  textWithAttachmentMarkers,
  userBlocksVisibleNow,
} from '../src/content-block-presentation.ts'
import { resultTextLines } from '../src/present.ts'
import { collectRewindCandidates, rewindPickerItem } from '../src/rewind.ts'
import { renderTranscriptMarkdown, TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { VirtualTerminal } from './virtual-terminal.ts'

const FILE_REF = {
  attachmentId: 'att-file-1',
  name: 'report.pdf',
  bytes: 12_600,
}
const IMAGE_REF = {
  attachmentId: 'att-image-1',
  mediaType: 'image/png',
  bytes: 4,
  width: 800,
  height: 600,
  name: 'shot.png',
}
const fileBlock = (): ContentBlock => ({ type: 'file', attachment: FILE_REF } as never)
const imageBlock = (): ContentBlock => ({ type: 'image', attachment: IMAGE_REF } as never)

function userEvent(content: readonly ContentBlock[], seq: number, time = seq): SessionEvent {
  return {
    type: 'user/message',
    seq,
    time,
    data: { content, source: { kind: 'user' } },
  } as never
}

function turnEvent(type: 'turn/start' | 'turn/end', seq: number, turn: number): SessionEvent {
  return {
    type,
    seq,
    time: seq,
    data: type === 'turn/start' ? { turn } : { turn, reason: { kind: 'completed' } },
  } as never
}

function genericBlock(payload: string): ContentBlock {
  return { type: 'future-test-block', payload } as never
}

function typedGenericBlock(type: string, payload: string): ContentBlock {
  return { type, payload } as never
}

function assistantToolResultBlock(): ContentBlock {
  return {
    type: 'tool-result',
    toolCallId: 'call-assistant-c1',
    content: [{ type: 'text', text: 'assistant tool result' }],
  } as never
}

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (!app.isDisposed()) app.dispose()
  }
})

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

test('file summaries and ordered attachment markers use durable metadata only', () => {
  assert.equal(fileAttachmentSummary({ name: 'report.pdf', bytes: 0 }), '📄 report.pdf · 0 B')
  assert.equal(fileAttachmentSummary({ name: 'report.pdf', bytes: 1_023 }), '📄 report.pdf · 1023 B')
  assert.equal(fileAttachmentSummary({ name: 'report.pdf', bytes: 1_024 }), '📄 report.pdf · 1.0 KiB')
  assert.equal(fileAttachmentSummary({ name: 'report.pdf', bytes: 1_048_576 }), '📄 report.pdf · 1.0 MiB')
  assert.equal(
    textWithAttachmentMarkers([
      { type: 'text', text: '分析' },
      fileBlock(),
      { type: 'text', text: '然后' },
      imageBlock(),
    ]),
    '分析 📄 report.pdf 然后 🖼️ shot.png',
  )
  assert.equal(textWithAttachmentMarkers([{ type: 'text', text: '先' }, fileBlock()]), '先 📄 report.pdf')
  assert.equal(textWithAttachmentMarkers([fileBlock(), { type: 'text', text: '后' }]), '📄 report.pdf 后')
  assert.equal(textWithAttachmentMarkers([fileBlock(), imageBlock()]), '📄 report.pdf 🖼️ shot.png')
  assert.equal(textWithAttachmentMarkers([imageBlock(), fileBlock()]), '🖼️ shot.png 📄 report.pdf')
})

test('file-only and unknown finalized user blocks survive folding and search', () => {
  const unknown = genericBlock('x'.repeat(21_000))
  const folder = new TranscriptFolder()
  folder.apply([userEvent([fileBlock()], 1), userEvent([unknown], 2)])

  const messages = folder.messages()
  assert.equal(messages.length, 2)
  assert.equal(messages[0]?.kind, 'user')
  assert.equal(messages[0]?.text, '📄 report.pdf')
  assert.equal(messages[1]?.kind, 'user')
  assert.equal(messages[1]?.text, '')
  assert.equal(userBlocksVisibleNow([]), false)
  assert.equal(userBlocksVisibleNow([{ type: 'text', text: '   ' }]), false)
  assert.equal(userBlocksVisibleNow([unknown]), true)
  assert.equal(folder.search('report.pdf').length, 1)

  const injected = new TranscriptFolder()
  injected.apply([{
    type: 'user/message',
    seq: 3,
    time: 3,
    data: { content: [unknown], source: { kind: 'plugin' } },
  } as never])
  assert.deepEqual(injected.messages(), [], 'an empty injected context row must stay dropped')

  const fallback = finalizedBlockFallbackText(unknown)
  assert.ok(fallback.startsWith('Unknown block: future-test-block'))
  assert.ok(fallback.includes('block payload truncated'))
  assert.ok(fallback.length < 21_000)

  const hostileTypeFallback = finalizedBlockFallbackText(typedGenericBlock(`future\n\u001b[2J${'x'.repeat(200)}`, 'payload'))
  assert.ok(!hostileTypeFallback.includes('\u001b'))
  const hostileHeading = hostileTypeFallback.split('\n', 1)[0]!
  assert.ok(!hostileHeading.includes('\n'))
  assert.ok(hostileHeading.length <= 'Unknown block: '.length + 120)
})

test('assistant finalized tool-result content uses an explicit fallback everywhere', async () => {
  const block = assistantToolResultBlock()
  const event: SessionEvent = {
    type: 'assistant/message',
    seq: 1,
    time: 1,
    data: { turn: 0, step: 0, message: { content: [block] } },
  } as never
  const folder = new TranscriptFolder()
  folder.apply([event])
  const assistant = folder.messages().find(message => message.kind === 'assistant')
  assert.ok(assistant !== undefined, 'the finalized assistant entry remains visible')
  assert.equal(assistant?.text, '')
  assert.deepEqual(assistant?.kind === 'assistant' ? assistant.content?.map(item => item.type) : [], ['tool-result'])

  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setTranscript(folder.messages())
  const view = await viewport(vt)
  assert.ok(view.includes('Unknown block: tool-result'), `assistant tool-result fallback missing:\n${view}`)

  const md = renderTranscriptMarkdown({
    header: { id: 'session-c1-tool-result' as never, cwd: '/ws', version: 1, createdAt: 0 },
    snapshotEvents: () => [event],
  } as never)
  assert.ok(md.includes('Unknown block: tool-result'))
  assert.ok(md.includes('assistant tool result'))
})

test('rewind recognizes file-only turns and generalizes the warning label', () => {
  const candidates = collectRewindCandidates([
    turnEvent('turn/start', 1, 1),
    userEvent([fileBlock()], 2),
    turnEvent('turn/end', 3, 1),
  ])
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.editorText, '')
  assert.equal(candidates[0]?.hasNonTextContent, true)
  assert.equal(rewindPickerItem(candidates[0]!).label, 'turn 1 · [attachment] (attachment only)')
})

test('result and markdown projections retain files and bound unknown blocks', () => {
  const unknown = genericBlock('payload')
  const lines = resultTextLines([
    { type: 'text', text: 'before' },
    fileBlock(),
    { type: 'text', text: 'after' },
    unknown,
  ])
  assert.ok(lines.includes('📄 report.pdf · 12.3 KiB'))
  assert.ok(lines.some(line => line.includes('Unknown block: future-test-block')))
  assert.ok(!lines.some(line => line.includes('att-file-1')))

  const markdownUnknown = genericBlock('x'.repeat(21_000))
  const md = renderTranscriptMarkdown({
    header: { id: 'session-c1' as never, cwd: '/ws', version: 1, createdAt: 0 },
    snapshotEvents: () => [userEvent([
      { type: 'text', text: 'before' },
      fileBlock(),
      { type: 'text', text: 'after' },
      markdownUnknown,
    ], 1), {
      type: 'assistant/message',
      seq: 2,
      time: 2,
      data: {
        turn: 0,
        step: 0,
        message: { content: [{ type: 'text', text: 'assistant before' }, fileBlock(), { type: 'text', text: 'assistant after' }] },
      },
    } as never, {
      type: 'tool/result',
      seq: 3,
      time: 3,
      data: {
        turn: 0,
        step: 0,
        callId: 'call-c1',
        message: {
          content: [{
            type: 'tool-result',
            toolCallId: 'call-c1',
            content: [{ type: 'text', text: 'tool before' }, fileBlock(), { type: 'text', text: 'tool after' }],
          }],
        },
      },
    } as never],
  } as never)
  assert.ok(md.indexOf('before') < md.indexOf('📄 report.pdf · 12.3 KiB'))
  assert.ok(md.indexOf('📄 report.pdf · 12.3 KiB') < md.indexOf('after'))
  assert.ok(md.includes('attachment `att-file-1`'))
  assert.ok(md.includes('Unknown block: future-test-block'))
  assert.ok(md.includes('block payload truncated'))
  assert.ok(!md.includes('x'.repeat(21_000)), 'the fallback must not dump an unbounded payload')
  assert.equal((md.match(/📄 report\.pdf · 12\.3 KiB/g) ?? []).length, 3, 'user, assistant, and nested tool-result files must export')
  assert.ok(md.includes('assistant before'))
  assert.ok(md.includes('assistant after'))
  assert.ok(md.indexOf('tool before') < md.lastIndexOf('📄 report.pdf · 12.3 KiB'))
  assert.ok(md.lastIndexOf('📄 report.pdf · 12.3 KiB') < md.indexOf('tool after'))

  const unsafeName = { type: 'file', attachment: { ...FILE_REF, name: '![x](https://example.invalid)' } } as never
  const unsafeMd = renderTranscriptMarkdown({
    header: { id: 'session-c1-unsafe' as never, cwd: '/ws', version: 1, createdAt: 0 },
    snapshotEvents: () => [userEvent([unsafeName], 4)],
  } as never)
  assert.ok(unsafeMd.includes('\\!\\[x\\]\\(https://example.invalid\\)'))
  assert.ok(!unsafeMd.includes('![x](https://example.invalid)'))
})

test('user and assistant file presentation is visible and width-safe', async () => {
  const vt = new VirtualTerminal(40, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setTranscript([{
    kind: 'user',
    turn: 0,
    text: '📄 report.pdf',
    content: [fileBlock()],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('📄 report.pdf · 12.3 KiB'), `file row missing:\n${view}`)
  for (const line of view.split('\n')) {
    assert.ok(visibleWidth(stripTerminalSequences(line)) <= 40, `line exceeds terminal width: ${line}`)
  }

  vt.resize(100, 24)
  app.setTranscript([{
    kind: 'user',
    turn: 0,
    text: 'before 📄 report.pdf after 🖼️ shot.png',
    content: [
      { type: 'text', text: 'before' },
      fileBlock(),
      { type: 'text', text: 'after' },
      genericBlock('payload'),
      imageBlock(),
    ],
  }])
  const orderedUserView = await viewport(vt)
  const orderedUserFileAt = orderedUserView.indexOf('📄 report.pdf · 12.3 KiB')
  assert.ok(orderedUserView.indexOf('before') < orderedUserFileAt)
  assert.ok(orderedUserFileAt < orderedUserView.indexOf('after'))
  assert.ok(orderedUserView.indexOf('after') < orderedUserView.indexOf('Unknown block: future-test-block'))
  assert.ok(orderedUserView.indexOf('Unknown block: future-test-block') < orderedUserView.indexOf('🖼️ shot.png'))

  app.setTranscript([{
    kind: 'assistant',
    turn: 0,
    text: 'beforeafter',
    content: [
      { type: 'text', text: 'before' },
      fileBlock(),
      { type: 'text', text: 'after' },
      genericBlock('payload'),
    ],
  }])
  const assistantView = await viewport(vt)
  const fileAt = assistantView.indexOf('📄 report.pdf · 12.3 KiB')
  assert.ok(fileAt >= 0, `assistant file row missing:\n${assistantView}`)
  assert.ok(assistantView.indexOf('before') < fileAt)
  assert.ok(fileAt < assistantView.indexOf('after'))
  assert.ok(assistantView.includes('Unknown block: future-test-block'))
})

test('generic tool-result content presents file and unknown blocks in order', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool',
    turn: 0,
    name: 'custom_tool',
    args: '{}',
    result: 'before after',
    status: 'ok',
    resultBlocks: [
      { type: 'text', text: 'before' },
      fileBlock(),
      { type: 'text', text: 'after' },
      genericBlock('payload'),
    ],
  }])
  const view = await viewport(vt)
  const fileAt = view.indexOf('📄 report.pdf · 12.3 KiB')
  assert.ok(fileAt >= 0, `tool file row missing:\n${view}`)
  assert.ok(view.indexOf('before') < fileAt)
  assert.ok(fileAt < view.indexOf('after'))
  assert.ok(view.includes('Unknown block: future-test-block'))
  assert.ok(!view.includes('att-file-1'))
})
