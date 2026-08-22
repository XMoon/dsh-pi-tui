/**
 * Headless tests for transcript folding: thinking/tool entries render
 * collapsed by default and Ctrl+O expands the most recent turns.
 * @module @xmoon76/dsh-pi-tui/folding.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { setKittyProtocolActive, visibleWidth } from '@xmoon76/pi-tui'
import type { TranscriptMessage } from '../src/transcript.ts'
import { renderTranscriptMarkdown } from '../src/transcript.ts'
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

test('folded bash cards show the actual command on its own row', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"ls -la","description":"List files"}', result: 'a.txt\nb.txt', status: 'ok' },
  ])
  const view = await viewport(vt)
  assert.ok(view.includes('Bash List files [ok]'), `header missing:\n${view}`)
  assert.ok(view.includes('$ ls -la'), `command row missing:\n${view}`)
  assert.ok(view.includes('— a.txt b.txt'), `result preview row missing:\n${view}`)
  // The command row must be a separate line from the header (2-3 row layout).
  const lines = view.split('\n')
  const head = lines.findIndex(line => line.includes('Bash List files'))
  assert.ok(head >= 0, `header row not found:\n${view}`)
  assert.ok(lines[head + 1]?.includes('$ ls -la'), `command must follow the header:\n${view}`)
})

test('folded bash cards cap multi-line commands with a more-lines marker', async () => {
  const { vt, app } = startApp()
  const command = ['pnpm build', 'pnpm test', 'pnpm typecheck', 'git commit'].join('\n')
  app.setTranscript([
    { kind: 'tool', turn: 0, name: 'bash', args: JSON.stringify({ command }), result: 'ok', status: 'ok' },
  ])
  const view = await viewport(vt)
  assert.ok(view.includes('$ pnpm build'), `first command line missing:\n${view}`)
  assert.ok(view.includes('pnpm typecheck'), `capped command lines missing:\n${view}`)
  assert.ok(!view.includes('git commit'), `command overflowed the cap:\n${view}`)
  assert.ok(view.includes('1 more command lines (ctrl+o to expand)'), `cap marker missing:\n${view}`)
})

test('folded edit and write cards render a few diff lines by default', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'tool', turn: 0, name: 'edit', args: JSON.stringify({ file_path: 'src/a.ts', old_string: 'old line\nold two', new_string: 'new line' }), result: '', status: 'ok' },
    { kind: 'tool', turn: 0, name: 'write', args: JSON.stringify({ file_path: 'docs/plan.md', content: 'line one\nline two\nline three\nline four\nline five\nline six' }), result: '', status: 'ok' },
  ])
  const view = await viewport(vt)
  // Edit: LCS diff with +/− rows and the relativized path header.
  assert.ok(view.includes('Edit src/a.ts [ok]'), `edit header missing:\n${view}`)
  assert.ok(view.includes('src/a.ts'), `diff path header missing:\n${view}`)
  assert.ok(view.includes('+ new line'), `edit add row missing:\n${view}`)
  assert.ok(view.includes('- old line'), `edit remove row missing:\n${view}`)
  // Write: all-add diff capped at FOLDED_DIFF_LINES with a hidden-changes footer.
  assert.ok(view.includes('Write docs/plan.md [ok]'), `write header missing:\n${view}`)
  assert.ok(view.includes('+ line one'), `write add row missing:\n${view}`)
  assert.ok(view.includes('+ line four'), `write diff rows beyond the cap missing:\n${view}`)
  assert.ok(!view.includes('+ line six'), `write diff overflowed the cap:\n${view}`)
  assert.ok(view.includes('more changes hidden (ctrl+o to expand)'), `write cap marker missing:\n${view}`)
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

test('renderTranscriptMarkdown projects image blocks (review finding 4)', () => {
  const session = {
    header: { id: 'session-1' as never, cwd: '/ws', version: 1, createdAt: 0 },
    events: [
      {
        type: 'user/message',
        data: {
          content: [
            { type: 'text', text: '分析这张图:' },
            { type: 'image', attachment: { attachmentId: 'att-9', mediaType: 'image/png', bytes: 100, width: 1920, height: 1080, name: 'shot.png' } },
          ],
          source: { kind: 'user' },
        },
      },
      {
        type: 'user/message',
        data: {
          content: [{ type: 'image', attachment: { attachmentId: 'att-10', mediaType: 'image/jpeg', bytes: 50, width: 640, height: 480 } }],
          source: { kind: 'user' },
        },
      },
    ],
  }
  const md = renderTranscriptMarkdown(session as never)
  assert.ok(md.includes('> 🖼 shot.png · 1920×1080 · attachment `att-9`'), 'image line rendered')
  assert.ok(md.includes('> 🖼 image · 640×480 · attachment `att-10`'), 'image-only message renders')
  assert.ok(md.includes('分析这张图:'), 'text rides along')
})
