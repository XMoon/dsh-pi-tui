/**
 * The REGULAR-surface PTC sub-call result body: the actual renderer's row
 * projection, not the helper's return value.
 *
 * MAC09/RFL-020/022: one sub-call result may be a mixed text+image block list,
 * an image-only list, a text-only list, or captured terminal stdout whose
 * whitelisted SGR must survive. The helper keeps the bytes honest; THIS file
 * proves what the app actually paints (row order, payload absence, SGR).
 * @module @xmoon76/dsh-pi-tui/subcall-result-renderer.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/transcript.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'

const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => { disposeStartedApps() })

function event(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: 1_700_000_000_000 + seq, data } as SessionEvent
}

/** One run_code root whose nested PTC child settles with `content`. */
function rootWithChild(seqBase: number, childName: string, content: readonly Record<string, unknown>[]): SessionEvent[] {
  const root = 'code-1'
  const child = `${root}:code:1`
  return [
    event('turn/start', { turn: 1 }, seqBase),
    event('user/message', {
      id: MessageId('u1'), role: 'user',
      content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' },
    }, seqBase + 1),
    event('tool/call', { turn: 1, step: 0, callId: ToolCallId(root), name: 'run_code', arguments: '{"code":"x"}' }, seqBase + 2),
    event('tool/ptc-dispatch-start', {
      rootCallId: ToolCallId(root), parentCallId: ToolCallId(root), subCallId: ToolCallId(child),
      name: childName, arguments: { command: 'make' },
    }, seqBase + 3),
    event('tool/ptc-dispatch', {
      rootCallId: ToolCallId(root), parentCallId: ToolCallId(root), subCallId: ToolCallId(child),
      name: childName, arguments: { command: 'make' }, isError: false, content,
    }, seqBase + 4),
    event('tool/result', {
      turn: 1, step: 0,
      message: {
        id: MessageId('r1'), role: 'tool', toolCallId: ToolCallId(root),
        content: [{ type: 'text', text: '(run_code completed with no output)' }],
        source: { kind: 'tool', callId: ToolCallId(root) },
      },
    }, seqBase + 5),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, seqBase + 6),
  ]
}

async function paint(events: readonly SessionEvent[], width = 100, height = 40): Promise<VirtualTerminal> {
  // The process slot allows ONE live TuiApp: each paint releases the previous.
  disposeStartedApps()
  const vt = new VirtualTerminal(width, height)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const folder = new TranscriptFolder()
  folder.apply(events)
  app.setTranscriptDetailExpanded(true)
  app.setTranscript(folder.messages(), folder.turnActivities(), undefined)
  await vt.waitForRender()
  return vt
}

const image = {
  type: 'image',
  attachment: { attachmentId: 'att-9', mediaType: 'image/png', bytes: 2048, width: 320, height: 200, name: 'shot.png' },
}

test('the painted sub-call body keeps mixed block order and no payload', async () => {
  const vt = await paint(rootWithChild(0, 'cua', [
    { type: 'text', text: 'BEFORE-TEXT {"pixelWidth":320}' },
    image,
    { type: 'text', text: 'AFTER-TEXT' },
  ]))
  const view = vt.getViewport()
  const before = view.findIndex(line => line.includes('BEFORE-TEXT'))
  const identity = view.findIndex(line => line.includes('[IMAGE] shot.png'))
  const after = view.findIndex(line => line.includes('AFTER-TEXT'))
  const joined = view.join('\n')
  assert.ok(before >= 0 && identity >= 0 && after >= 0, `mixed body missing a block:\n${joined}`)
  assert.ok(before < identity && identity < after, `blocks must paint in order:\n${view.slice(before, after + 1).join('\n')}`)
  assert.match(view[identity] ?? '', /\[IMAGE\] shot\.png · 320×200 · 2\.0 KiB/u, 'the identity row carries name · W×H · bytes')
  assert.ok(!joined.includes('att-9') && !joined.includes('iVBOR'), 'no attachment payload or id leaks into the body')
})

test('the painted image-only and text-only bodies keep their shape', async () => {
  const vt = await paint(rootWithChild(0, 'cua', [image]))
  const view = vt.getViewport()
  const identity = view.findIndex(line => line.includes('[IMAGE] shot.png'))
  assert.ok(identity >= 0, `image-only body must paint its identity row:\n${view.join('\n')}`)
  assert.ok(!view.slice(identity + 1).some(line => line.includes('[IMAGE]')), 'one image paints exactly one identity row')

  const textVt = await paint(rootWithChild(0, 'cua', [{ type: 'text', text: 'PLAIN-RESULT' }]))
  const textView = textVt.getViewport()
  assert.ok(textView.some(line => line.includes('PLAIN-RESULT')), `text-only body lost its text:\n${textView.join('\n')}`)
  assert.ok(!textView.some(line => line.includes('[IMAGE]')), 'a text-only body paints no identity row')
})

test('captured terminal stdout keeps its whitelisted SGR on the painted row', async () => {
  const vt = await paint(rootWithChild(0, 'bash', [{ type: 'text', text: 'ok \u001b[31mFAILED\u001b[0m tail' }]))
  const view = vt.getViewport()
  const row = view.findIndex(line => line.includes('FAILED'))
  assert.ok(row >= 0, `the terminal line is missing:\n${view.join('\n')}`)
  const line = view[row] ?? ''
  const plainCol = line.indexOf('ok')
  const failedCol = line.indexOf('FAILED')
  // `color.textDim` paints the row's own RGB dim; a captured SGR overrides that
  // span with a PALETTE foreground. A row that re-sanitized the projection would
  // paint BOTH with the same dim RGB.
  const dimRgb = vt.getCellFgRgb(row, plainCol)
  assert.notEqual(dimRgb, undefined, 'the plain span must carry the surface dim RGB')
  assert.equal(vt.getCellFgRgb(row, failedCol), undefined,
    'the FAILED span must carry the captured palette SGR, not the dim RGB a re-sanitized row would paint')
  assert.ok(line.includes('tail'), 'text after the SGR span stays visible')
})
