/**
 * Headless tests for transcript folding: thinking/tool entries render
 * collapsed by default and Ctrl+O expands the most recent turns.
 * @module @dsh-pi-tui/tui-app/folding.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { setKittyProtocolActive } from '@dsh-pi-tui/pi-tui'
import type { TranscriptMessage } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

const transcript: TranscriptMessage[] = [
  { kind: 'user', turn: 0, text: 'do the thing' },
  { kind: 'thinking', turn: 0, text: 'I need to consider carefully what to do here.\nLine two.\nLine three.' },
  { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"ls"}', result: 'a.txt\nb.txt\nc.txt\nmore.txt', status: 'ok' },
  { kind: 'assistant', turn: 0, text: 'done' },
]

test('thinking and tool entries render folded by default', async () => {
  const { vt, app } = startApp()
  app.setTranscript(transcript)
  const view = await viewport(vt)
  assert.ok(view.includes('🐳'), `folded thinking marker missing:\n${view}`)
  assert.ok(view.includes('ctrl+o to'), `expand hint missing:\n${view}`)
  assert.ok(!view.includes('Line three'), `thinking body leaked:\n${view}`)
  assert.ok(view.includes('✓ bash'), `tool header missing:\n${view}`)
  assert.ok(!view.includes('more.txt'), `tool result leaked:\n${view}`)
})

test('ctrl+o expands the recent turns collapsible entries', async () => {
  const { vt, app } = startApp()
  app.setTranscript(transcript)
  await viewport(vt)
  vt.sendInput('\x0f') // ctrl+o
  const view = await viewport(vt)
  assert.ok(view.includes('Line three'), `thinking body missing after expand:\n${view}`)
  assert.ok(view.includes('more.txt'), `tool result missing after expand:\n${view}`)
  // Toggle back collapses again.
  vt.sendInput('\x0f')
  const collapsed = await viewport(vt)
  assert.ok(!collapsed.includes('Line three'), `still expanded after toggle:\n${collapsed}`)
})

test('older turns stay folded when recent ones expand', async () => {
  const { vt, app } = startApp()
  const older: TranscriptMessage[] = [
    { kind: 'tool', turn: 0, name: 'fs', args: '', result: 'oldest result body\nline two\nline three\nhidden-line-4', status: 'ok' },
    { kind: 'tool', turn: 1, name: 'fs', args: '', result: 'older result body', status: 'ok' },
    { kind: 'tool', turn: 2, name: 'fs', args: '', result: 'old result body', status: 'ok' },
    { kind: 'thinking', turn: 3, text: 'recent thinking body' },
    { kind: 'tool', turn: 3, name: 'bash', args: '', result: 'recent result body', status: 'ok' },
  ]
  app.setTranscript(older)
  await viewport(vt)
  vt.sendInput('\x0f')
  const view = await viewport(vt)
  assert.ok(view.includes('recent thinking body'), `recent thinking not expanded:\n${view}`)
  assert.ok(view.includes('recent result body'), `recent tool not expanded:\n${view}`)
  assert.ok(!view.includes('hidden-line-4'), `old turn leaked expanded:\n${view}`)
})

test('kitty-protocol Ctrl+O fires once per press (release/repeat do not toggle)', async () => {
  const { vt, app } = startApp()
  app.setTranscript(transcript)
  await viewport(vt)
  setKittyProtocolActive(true)
  try {
    // Press: \x1b[<codepoint>;<mod>:<event>u — event 1 = press, 2 = repeat, 3 = release.
    vt.sendInput('\x1b[111;5:1u') // ctrl+o press
    await viewport(vt)
    assert.ok(app.isToolOutputExpanded(), 'press should expand')
    vt.sendInput('\x1b[111;5:3u') // ctrl+o release
    await viewport(vt)
    assert.ok(app.isToolOutputExpanded(), 'release must not collapse the fold')
    vt.sendInput('\x1b[111;5:2u') // ctrl+o key repeat
    await viewport(vt)
    assert.ok(app.isToolOutputExpanded(), 'key repeat must not toggle the fold')
    vt.sendInput('\x1b[111;5:1u') // press again
    await viewport(vt)
    assert.ok(!app.isToolOutputExpanded(), 'second press should collapse')
    vt.sendInput('\x1b[111;5:3u')
    await viewport(vt)
    assert.ok(!app.isToolOutputExpanded(), 'release after the second press must not expand')
  } finally {
    setKittyProtocolActive(false)
  }
})
