/**
 * Headless tests for transcript folding: thinking/tool entries render
 * collapsed by default and Ctrl+O expands the most recent turns.
 * @module @xmoon76/dsh-pi-tui/folding.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { setKittyProtocolActive, visibleWidth } from '@xmoon76/pi-tui'
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
  assert.ok(view.includes('Bash ls [ok]'), `tool header missing:\n${view}`)
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


test('running thinking folds to the latest line and settles to the first line', async () => {
  const { vt, app } = startApp()
  // While the step streams, the folded row follows the LATEST reasoning line.
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'first line\nsecond line\nlatest line', running: true }])
  const running = await viewport(vt)
  assert.ok(running.includes('latest line'), `latest line missing while running:\n${running}`)
  assert.ok(!running.includes('first line'), `stale first line shown while running:\n${running}`)
  // Once settled (assistant/message or turn/end), the row shows the FIRST line.
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'first line\nsecond line\nlatest line' }])
  const settled = await viewport(vt)
  assert.ok(settled.includes('first line'), `first line missing after settle:\n${settled}`)
  assert.ok(!settled.includes('latest line'), `latest line still shown after settle:\n${settled}`)
})

test('folded thinking holds exactly two content rows plus a hint and never wraps', async () => {
  const vt = new VirtualTerminal(40, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  // Three long lines: running shows the LAST two (truncated), settled the first two.
  app.setTranscript([{
    kind: 'thinking', turn: 0,
    text: `${'a'.repeat(90)}\n${'b'.repeat(90)}\n${'c'.repeat(90)}`,
    running: true,
  }])
  await vt.waitForRender()
  let lines = vt.getViewport()
  let start = lines.findIndex(line => line.includes('🐳'))
  assert.ok(start >= 0, `thinking block missing:\n${lines.join('\n')}`)
  let block = lines.slice(start, start + 3)
  assert.equal(block.length, 3, `running block must be exactly 3 rows:\n${block.join('\n')}`)
  for (const line of block) {
    assert.ok(visibleWidth(line) <= 40, `folded row exceeds 40 cols: ${JSON.stringify(line)}`)
  }
  assert.ok(block[0]!.includes('bbb'), `latest reasoning missing on row 1:\n${block[0]}`)
  assert.ok(block[1]!.includes('ccc'), `latest reasoning missing on row 2:\n${block[1]}`)
  assert.ok(block[2]!.includes('ctrl+o'), `hint row missing:\n${block[2]}`)
  // Settled: same three-row geometry, first two lines, hint keeps its height.
  app.setTranscript([{
    kind: 'thinking', turn: 0,
    text: `${'a'.repeat(90)}\n${'b'.repeat(90)}\n${'c'.repeat(90)}`,
  }])
  await vt.waitForRender()
  lines = vt.getViewport()
  start = lines.findIndex(line => line.includes('🐳'))
  block = lines.slice(start, start + 3)
  assert.equal(block.length, 3, `settled block must be exactly 3 rows:\n${block.join('\n')}`)
  assert.ok(block[0]!.includes('aaa'), `first line missing after settle:\n${block[0]}`)
  assert.ok(!block[0]!.includes('ccc'), `latest line leaked after settle:\n${block[0]}`)
  assert.ok(block[2]!.includes('1 more'), `remaining hint missing:\n${block[2]}`)
  app.stop()
})

test('folded thinking keeps its three-row height even with little content', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'only one line' }])
  const view = await viewport(vt)
  const lines = view.split('\n')
  const start = lines.findIndex(line => line.includes('🐳'))
  assert.ok(start >= 0, `thinking block missing:\n${view}`)
  const block = lines.slice(start, start + 3)
  assert.equal(block.length, 3, `short block must stay 3 rows:\n${block.join('\n')}`)
  assert.ok(block[2]!.includes('ctrl+o'), `hint row missing:\n${block[2]}`)
})
