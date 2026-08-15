/**
 * Headless tests for the P5c rendering features: diff colorization, LaTeX
 * in assistant markdown, the todo panel, the thinking hide toggle,
 * user-questions dialogs, and fullscreen scrollback search.
 * @module @xmoon76/dsh-pi-tui/rendering.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { isDiffResult, renderDiffLine } from '../src/diff.ts'
import { parseReadEnvelopes, toolPresenterFrom } from '../src/present.ts'
import { color, currentPalette, darkColors } from '../src/theme.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

test('diff detection and line colorization', () => {
  assert.equal(isDiffResult('edit', 'plain'), true)
  assert.equal(isDiffResult('apply_patch', 'plain'), true)
  assert.equal(isDiffResult('bash', 'diff --git a/x b/x\n@@ -1 +1 @@'), true)
  assert.equal(isDiffResult('bash', 'just output'), false)
  assert.equal(renderDiffLine('+added'), color.success('+added'))
  assert.equal(renderDiffLine('-removed'), color.error('-removed'))
  assert.equal(renderDiffLine('@@ -1,3 +1,3 @@'), color.textDim('@@ -1,3 +1,3 @@'))
  assert.equal(renderDiffLine('+++ b/x'), color.textDim('+++ b/x'))
  assert.equal(renderDiffLine(' context'), ' context')
})

test('latex renders inside assistant markdown', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'assistant', turn: 0, text: 'Energy $E=mc^2$ rules' }])
  const view = await viewport(vt)
  assert.ok(view.includes('²'), `latex not rendered:\n${view}`)
})

test('ctrl+t toggles the todo panel with markers', async () => {
  const { vt, app } = startApp()
  app.setTodoSummary([
    { content: 'fix tests', status: 'in_progress' },
    { content: 'ship it', status: 'pending' },
    { content: 'done thing', status: 'completed' },
  ])
  let view = await viewport(vt)
  assert.ok(!view.includes('─ todo ─'), `panel visible by default:\n${view}`)
  vt.sendInput('\x14') // ctrl+t
  view = await viewport(vt)
  assert.ok(view.includes('─ todo ─'), `panel missing:\n${view}`)
  // Only the first active item shows in the header; the rest prove the panel.
  assert.ok(view.includes('ship it'), `pending row missing:\n${view}`)
  assert.ok(view.includes('done thing'), `completed row missing:\n${view}`)
  vt.sendInput('\x14')
  view = await viewport(vt)
  assert.ok(!view.includes('─ todo ─'), `panel still visible:\n${view}`)
})

test('alt+t hides thinking entries', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'thinking', turn: 0, text: 'secret reasoning' }])
  let view = await viewport(vt)
  assert.ok(view.includes('secret reasoning'), `thinking missing:\n${view}`)
  vt.sendInput('\x1bt') // alt+t
  view = await viewport(vt)
  assert.ok(!view.includes('secret reasoning'), `thinking not hidden:\n${view}`)
  assert.equal(app.isThinkingHidden(), true)
  vt.sendInput('\x1bt')
  view = await viewport(vt)
  assert.ok(view.includes('secret reasoning'), `thinking not restored:\n${view}`)
})

test('askQuestions collects a single selection', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Continue?',
    options: [{ label: 'Yes' }, { label: 'No' }],
  }])
  let view = await viewport(vt)
  assert.ok(view.includes('Continue?'), `question missing:\n${view}`)
  assert.ok(view.includes('[1] Yes'), `option missing:\n${view}`)
  vt.sendInput('2')
  await viewport(vt)
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['No'] }])
})

test('askQuestions toggles multi-select options', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick some',
    multiSelect: true,
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
  }])
  await viewport(vt)
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('3')
  await viewport(vt)
  vt.sendInput('1') // toggle A off again
  await viewport(vt)
  vt.sendInput('2') // toggle B on
  await viewport(vt)
  // Multi-select Enter toggles; → pages to the review page, Enter submits.
  vt.sendInput('\x1b[C')
  await viewport(vt)
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['C', 'B'] }])
})

test('askQuestions collects free text for option-less questions', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{ id: 'q1', question: 'Your name?' }])
  await viewport(vt)
  vt.sendInput('alice')
  vt.sendInput('\r') // commit the typed answer
  await viewport(vt)
  vt.sendInput('\r') // review page: submit the batch
  assert.deepEqual(await promise, [{ id: 'q1', selected: [], custom: 'alice' }])
})

test('askQuestions walks through multiple questions', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([
    { id: 'q1', question: 'First?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Second?', options: [{ label: 'B' }, { label: 'C' }] },
  ])
  let view = await viewport(vt)
  assert.ok(view.includes('First?'), `first question missing:\n${view}`)
  // A single-select Enter advances immediately (Web parity).
  vt.sendInput('1')
  await viewport(vt)
  view = await viewport(vt)
  assert.ok(view.includes('Second?'), `second question missing:\n${view}`)
  vt.sendInput('2')
  await viewport(vt)
  // The review page: Enter submits the whole batch.
  vt.sendInput('\r')
  assert.deepEqual(await promise, [
    { id: 'q1', selected: ['A'] },
    { id: 'q2', selected: ['C'] },
  ])
})

test('esc cancels an askQuestions flow with a rejection', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{ id: 'q1', question: 'Continue?', options: [{ label: 'Yes' }] }])
  await viewport(vt)
  vt.sendInput('\x1b')
  await assert.rejects(promise, /cancelled/)
})

test('concurrent askQuestions flows queue FIFO and each settles exactly once', async () => {
  const { vt, app } = startApp()
  const first = app.askQuestions([{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }])
  const second = app.askQuestions([{ id: 'q2', question: 'Second?', options: [{ label: 'B' }] }])
  await viewport(vt)
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('First?'), `the first flow is on screen:\n${view}`)
  assert.ok(!view.includes('Second?'), 'the second flow must wait in the queue')
  vt.sendInput('1') // choose A
  await viewport(vt)
  vt.sendInput('\r') // submit the first flow
  await viewport(vt)
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Second?'), `the second flow must take the screen:\n${view}`)
  vt.sendInput('1') // choose B
  await viewport(vt)
  vt.sendInput('\r') // submit the second flow
  await viewport(vt)
  assert.deepEqual(await first, [{ id: 'q1', selected: ['A'] }])
  assert.deepEqual(await second, [{ id: 'q2', selected: ['B'] }])
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('First?') && !view.includes('Second?'), `ghost overlay after both settle:\n${view}`)
})

test('a queued askQuestions flow aborted while waiting rejects without ever showing', async () => {
  const { vt, app } = startApp()
  const first = app.askQuestions([{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }])
  const controller = new AbortController()
  const second = app.askQuestions([{ id: 'q2', question: 'Second?', options: [{ label: 'B' }] }], controller.signal)
  await viewport(vt)
  controller.abort() // cancelled while queued: never presented, promise settles
  await assert.rejects(second, /cancelled/)
  await viewport(vt)
  let view = vt.getViewport().join('\n')
  assert.ok(!view.includes('Second?'), 'the aborted flow must never be presented')
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('\r')
  assert.deepEqual(await first, [{ id: 'q1', selected: ['A'] }])
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('Second?'), 'no ghost overlay after the first settles')
})

test('aborting the ACTIVE flow rejects it and shows the next queued flow', async () => {
  const { vt, app } = startApp()
  const controller = new AbortController()
  const first = app.askQuestions([{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }], controller.signal)
  const second = app.askQuestions([{ id: 'q2', question: 'Second?', options: [{ label: 'B' }] }])
  await viewport(vt)
  controller.abort()
  await assert.rejects(first, /cancelled/)
  await viewport(vt)
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Second?'), `the queued flow must take the screen after the active one aborts:\n${view}`)
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('\r')
  assert.deepEqual(await second, [{ id: 'q2', selected: ['B'] }])
})

test('stop() cancels every pending askQuestions flow with a rejection', async () => {
  const { vt, app } = startApp()
  const first = app.askQuestions([{ id: 'q1', question: 'First?', options: [{ label: 'A' }] }])
  const second = app.askQuestions([{ id: 'q2', question: 'Second?', options: [{ label: 'B' }] }])
  await viewport(vt)
  app.stop()
  await assert.rejects(first, /cancelled/)
  await assert.rejects(second, /cancelled/)
})

test('the message component cache is pruned to the live transcript', () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const cache = (app as unknown as { messageComponents: Map<object, unknown> }).messageComponents
  const messages: { kind: 'user'; turn: number; text: string }[] = []
  for (let i = 0; i < 50; i += 1) {
    messages.push({ kind: 'user', turn: i, text: `message ${i}` })
  }
  app.setTranscript(messages)
  assert.ok(cache.size >= 50, 'the live messages are cached')
  // The window slides forward in a long session: the cache must shrink to
  // the live set instead of growing to full-history size.
  app.setTranscript(messages.slice(45))
  assert.equal(cache.size, 5, 'the cache must shrink to the live set')
  // A completely fresh window disposes the previous entries.
  app.setTranscript([{ kind: 'user', turn: 100, text: 'fresh' }])
  assert.equal(cache.size, 1, 'entries from the previous window must be disposed')
  app.stop()
})

test('local card push/replace/clear prune the component cache too', () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const cache = (app as unknown as { messageComponents: Map<object, unknown> }).messageComponents
  const locals = (app as unknown as { localMessages: object[] }).localMessages
  // 200 distinct cards, each running→settled: every replacement is a NEW
  // object, so without pruning the cache would hold the replaced running
  // card AND the settled one (400). The cache must track the LIVE locals.
  for (let i = 0; i < 200; i += 1) {
    const running = app.pushLocalMessage({
      kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'bash',
      args: `{"i":${i}}`, result: '', status: 'running',
    })
    app.updateLocalMessage(running, {
      kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'bash',
      args: `{"i":${i}}`, result: 'done', status: 'ok',
    })
  }
  assert.equal(cache.size, 200, 'each settled card cached once; replaced running objects pruned')
  assert.equal(cache.size, locals.length, 'the cache tracks the live local cards, never more')
  // Clearing the locals empties their cache entries (a bare session
  // transcript repaint is NOT required to trigger this).
  app.clearLocalMessages()
  assert.equal(cache.size, 0, 'clearLocalMessages must drop the local cache entries')
  app.stop()
})

test('tool card headers show the design title and the args summary', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'bash',
    args: '{"command":"ls -la","cwd":"/tmp"}',
    result: 'done', status: 'ok',
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Bash ls -la [ok]'), `design title missing:\n${view}`)
  assert.ok(!view.includes('command=ls -la'), `raw key-arg format leaked:\n${view}`)
})

test('footer preset hides the stats line in compact mode', async () => {
  const { vt, app } = startApp()
  app.setStatus({ model: 'm', cwd: 'c', statsLine: '5 步| LLM 8.1s' })
  let view = await viewport(vt)
  assert.ok(view.includes('5 步| LLM 8.1s'), `stats line missing in full mode:\n${view}`)
  app.setFooterPreset('compact')
  view = await viewport(vt)
  assert.ok(!view.includes('5 步| LLM 8.1s'), `stats line visible in compact mode:\n${view}`)
  assert.ok(view.includes('[m]'), `line 1 missing:\n${view}`)
  app.setFooterPreset('full')
  view = await viewport(vt)
  assert.ok(view.includes('5 步| LLM 8.1s'), `stats line not restored:\n${view}`)
})

test('autoDetectTheme resolves without changing the theme when the terminal is silent', async () => {
  const { vt, app } = startApp()
  const before = currentPalette
  await app.autoDetectTheme() // VirtualTerminal never answers OSC 11
  assert.equal(currentPalette, before, 'silent terminal must not change the palette')
})

test('fullscreen scrollback search opens with ctrl+shift+f', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'user', turn: 0, text: 'needle' }])
  await viewport(vt)
  app.setFullscreen(true)
  await viewport(vt)
  vt.sendInput('\x1b[102;6u') // kitty ctrl+shift+f
  const view = await viewport(vt)
  assert.ok(view.includes('Find transcript'), `search bar missing:\n${view}`)
})

test('ctrl+f opens and closes the transcript search (no fullscreen toggle)', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'user', turn: 0, text: 'needle' }])
  await viewport(vt)
  assert.equal(app.isFullscreen(), false)
  vt.sendInput('\x06') // ctrl+f → search, NOT fullscreen
  let view = await viewport(vt)
  assert.ok(view.includes('Find transcript'), `search bar missing:\n${view}`)
  assert.equal(app.isFullscreen(), false, 'ctrl+f must not toggle fullscreen')
  vt.sendInput('\x06') // ctrl+f again closes the overlay
  view = await viewport(vt)
  assert.ok(!view.includes('Find transcript'), `search bar still open:\n${view}`)
})

test('welcome card wraps long facts inside a full-width box', async () => {
  const { vt, app } = startApp()
  app.setWelcomeCard({
    cwd: '/very/long/working/directory/that/keeps/going',
    sessionId: `session-${'x'.repeat(40)}`,
    model: 'opencode-go/deepseek-v4-flash',
    version: '0.1.0-rc.6',
    preset: 'standard',
  })
  const view = await viewport(vt)
  // Facts render in full: the session id is never truncated, and long lines
  // wrap instead of ending in an ellipsis.
  assert.ok(view.includes(`session-${'x'.repeat(40)}`), `session id truncated:\n${view}`)
  assert.ok(view.includes('deepseek-v4-flash'), `model missing:\n${view}`)
  assert.ok(view.includes('standard'), `preset missing:\n${view}`)
  assert.ok(view.includes('0.1.0-rc.6'), `version missing:\n${view}`)
  assert.ok(view.includes('/very/long/working/directory/that/keeps/going'), `cwd truncated:\n${view}`)
  // The box spans the full terminal width, matching the editor border below.
  const lines = view.split('\n')
  const top = lines.find(line => line.includes('╭') && line.includes('╮'))
  assert.ok(top !== undefined, `box top missing:\n${view}`)
  assert.equal(top.length, 100, `box top must be full width, got ${top.length}`)
  assert.ok(lines.some(line => line.includes('╰') && line.includes('╯')), `box bottom missing:\n${view}`)
  assert.ok(lines.some(line => line.includes('│')), `box sides missing:\n${view}`)
})
test('working indicator shows on the row directly above the editor while active', async () => {
  const { vt, app } = startApp()
  app.setWorking(true)
  const view = await viewport(vt)
  const lines = view.split('\n')
  const workingIndex = lines.findIndex(line => line.includes('Working'))
  assert.ok(workingIndex !== -1, `working row missing:\n${view}`)
  const editorTop = lines.findIndex(line => line.includes('─'.repeat(10)))
  assert.ok(editorTop !== -1, `editor border missing:\n${view}`)
  assert.equal(workingIndex + 1, editorTop, `working row must sit directly above the editor border:\n${view}`)
  app.setWorking(false)
  const idle = await viewport(vt)
  assert.ok(!idle.includes('Working'), `working row survived:\n${idle}`)
})

test('working indicator alternates between the whale emojis', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { workingIntervalMs: 20 })
  app.start()
  app.setWorking(true)
  await vt.waitForRender()
  const seen = new Set<string>()
  for (let i = 0; i < 30 && seen.size < 2; i += 1) {
    const view = vt.getViewport().join('\n')
    const line = view.split('\n').find(candidate => candidate.includes('Working'))
    if (line !== undefined) {
      if (line.includes('🐋')) seen.add('🐋')
      if (line.includes('🐳')) seen.add('🐳')
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(seen.has('🐋') && seen.has('🐳'), `both whale emojis must appear, saw: ${[...seen].join(', ')}`)
  app.setWorking(false)
  app.stop()
})

test('working indicator shows above the editor in fullscreen too', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setWorking(true)
  const view = await viewport(vt)
  const lines = view.split('\n')
  const workingIndex = lines.findIndex(line => line.includes('Working'))
  assert.ok(workingIndex !== -1, `working row missing in fullscreen:\n${view}`)
  const editorTop = lines.findIndex(line => line.includes('─'.repeat(10)))
  assert.ok(editorTop !== -1, `editor border missing:\n${view}`)
  assert.equal(workingIndex + 1, editorTop, `working row must sit above the editor border in fullscreen:\n${view}`)
  app.setWorking(false)
  app.setFullscreen(false)
})
test('live theme switch recolors every surface while the content stays identical', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setStatus({ model: 'p/m', cwd: '/ws', branch: 'main', turns: 2, steps: 3, statsLine: 'llm 1s' })
  app.setPlanMode(true)
  app.setTodoSummary([{ content: 'fix the theme', status: 'in_progress' }])
  app.setTasks([{ label: 'review', status: 'running' }])
  app.setQueueItems([{ id: 'q1', text: 'hello', mode: 'followup' }])
  app.setWorking(true)
  await vt.waitForRender()
  // Locate the header row (contains the plan badge).
  const findRow = (needle: string): number => {
    const lines = vt.getViewport()
    const index = lines.findIndex(line => line.includes(needle))
    assert.ok(index !== -1, `row with ${needle} missing`)
    return index
  }
  const headerRow = findRow('[plan]')
  const badgeCol = (): number => vt.getViewport()[headerRow]!.indexOf('[plan]')
  // Dark palette: the plan badge renders with the dark warning token.
  assert.equal(vt.getCellFgRgb(headerRow, badgeCol()), 0xe8a838, 'dark plan badge must be #E8A838')
  app.applyTheme('light')
  await vt.waitForRender()
  assert.equal(vt.getCellFgRgb(headerRow, badgeCol()), 0x92660a, 'light plan badge must be #92660A')
  // Content is unchanged by the switch.
  const before = vt.getViewport().join('\n')
  app.applyTheme('dark')
  await vt.waitForRender()
  assert.equal(vt.getViewport().join('\n'), before, 'theme switch must not change content')
  // A custom palette applies too; unset tokens keep the base.
  app.applyPalette({ ...darkColors, primary: '#123456' })
  await vt.waitForRender()
  assert.equal(vt.getCellFgRgb(headerRow, badgeCol()), 0xe8a838, 'unset tokens keep the base palette')
  app.applyTheme('dark')
  app.setWorking(false)
  app.stop()
})

test('working indicator keeps animating in fullscreen and after leaving it, with a single timer', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { workingIntervalMs: 20 })
  app.start()
  app.setWorking(true)
  await vt.waitForRender()
  // Sample several ticks WHILE the alt screen renders: the repaint callback
  // must route to the active screen or the animation would freeze on the
  // first frame (the main screen is stopped in fullscreen).
  app.setFullscreen(true)
  await vt.waitForRender()
  const seenFullscreen = new Set<string>()
  for (let i = 0; i < 30 && seenFullscreen.size < 2; i += 1) {
    const line = vt.getViewport().join('\n').split('\n').find(candidate => candidate.includes('Working'))
    if (line !== undefined) {
      if (line.includes('🐋')) seenFullscreen.add('🐋')
      if (line.includes('🐳')) seenFullscreen.add('🐳')
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(seenFullscreen.has('🐋') && seenFullscreen.has('🐳'),
    `both whale emojis must appear in fullscreen, saw: ${[...seenFullscreen].join(', ')}`)
  // Leaving fullscreen: the animation continues (no duplicated timer stall).
  app.setFullscreen(false)
  await vt.waitForRender()
  const seenAfter = new Set<string>()
  for (let i = 0; i < 30 && seenAfter.size < 2; i += 1) {
    const line = vt.getViewport().join('\n').split('\n').find(candidate => candidate.includes('Working'))
    if (line !== undefined) {
      if (line.includes('🐋')) seenAfter.add('🐋')
      if (line.includes('🐳')) seenAfter.add('🐳')
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(seenAfter.has('🐋') && seenAfter.has('🐳'),
    `animation must resume after leaving fullscreen, saw: ${[...seenAfter].join(', ')}`)
  app.setWorking(false)
  app.stop()
})


test('search cards group matches by file and mark truncation', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    workspaceRoot: '/ws',
    present: {
      call: () => undefined,
      result: () => ({
        card: 'search',
        shape: 'matches',
        files: [{ path: '/ws/src/foo.ts', matches: [{ lineNumber: 12, line: 'const a = 1' }] }],
        truncated: true,
        total: 42,
      }),
    },
  })
  app.start()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'grep',
    args: '{"pattern":"const","path":"/ws/src"}',
    result: '12: const a = 1', status: 'ok', resultBlocks: [],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Search const [ok]'), `search header missing:\n${view}`)
  assert.ok(view.includes('src/foo.ts'), `relativized file group missing:\n${view}`)
  assert.ok(view.includes('12 │ const a = 1'), `match line missing:\n${view}`)
  assert.ok(view.includes('… truncated — 42 total matches'), `truncation marker missing:\n${view}`)
  assert.ok(!view.includes('/ws/src/foo.ts'), `absolute path leaked:\n${view}`)
  app.stop()
})

test('terminal cards show the output and the exit code', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: {
      call: () => undefined,
      result: () => ({ card: 'terminal', output: 'hello\nworld', exitCode: 0 }),
    },
  })
  app.start()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'bash',
    args: '{"command":"echo hi"}',
    result: 'hello\nworld', status: 'ok', resultBlocks: [],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Bash echo hi [ok]'), `terminal header missing:\n${view}`)
  assert.ok(view.includes('hello'), `output line missing:\n${view}`)
  assert.ok(view.includes('world'), `output line missing:\n${view}`)
  assert.ok(view.includes('[exit 0]'), `exit pill missing:\n${view}`)
  app.stop()
})

test('injected context renders a web-style labeled row and expands to its body', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'system', turn: 0,
    text: '# AGENTS.md\nDo the thing carefully.\nNever break the build.',
    label: 'AGENTS.md',
  }])
  // Folded: the row names the producer, the body stays hidden.
  const folded = await viewport(vt)
  assert.ok(folded.includes('Context injection AGENTS.md'), `injected label missing:\n${folded}`)
  assert.ok(!folded.includes('Do the thing'), `injected body leaked while folded:\n${folded}`)
  // Expanded: the body appears under the labeled header.
  app.setToolOutputExpanded(true)
  const expanded = await viewport(vt)
  assert.ok(expanded.includes('Context injection AGENTS.md'), `labeled header missing when expanded:\n${expanded}`)
  assert.ok(expanded.includes('Do the thing carefully.'), `injected body missing:\n${expanded}`)
})

test('a notice injection folds with its one-line summary', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'system', turn: 0,
    text: '3 files written',
    label: 'todo',
    summary: 'saved the todo list',
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Context injection todo — saved the todo list'), `notice summary missing:\n${view}`)
})

test('unlabeled system entries keep the section marker', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'system', turn: 0, text: 'llm retry 1/3 — BUSY: overloaded' }])
  const view = await viewport(vt)
  assert.ok(view.includes('§ llm retry'), `section marker missing:\n${view}`)
})





test('fullscreen mouse click toggles one card independently of the global fold', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript([
    { kind: 'user', turn: 0, text: 'hello' },
    { kind: 'thinking', turn: 0, text: 'one\ntwo\nthree' },
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"ls"}', result: 'a\nb\nc', status: 'ok' },
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"pwd"}', result: '/ws', status: 'ok' },
  ])
  await viewport(vt)
  // Rows (blank spacers between blocks): header(1) + user(2) + thinking(4)
  // + tool1(6) + tool2(8) inside the scroll pane. Click the first tool card:
  // it alone expands.
  vt.sendInput('\x1b[<0;10;8M')
  vt.sendInput('\x1b[<0;10;8m')
  let view = await viewport(vt)
  assert.ok(view.includes('\nb'), `clicked card body missing:\n${view}`)
  assert.ok(view.includes('Bash ls [ok]'), `clicked card header missing:\n${view}`)
  assert.ok(!view.includes('\nthree'), `thinking must stay folded after the click:\n${view}`)
  assert.ok(!view.includes('\n/ws'), `second tool card must stay folded:\n${view}`)
  // Clicking the same row again collapses just that card. The second click
  // waits past the alt screen's double-click window (a fast repeat selects
  // a word, like a native terminal).
  await new Promise(resolve => setTimeout(resolve, 600))
  vt.sendInput('\x1b[<0;10;8M')
  vt.sendInput('\x1b[<0;10;8m')
  view = await viewport(vt)
  assert.ok(!view.includes('\nb'), `card must collapse again:\n${view}`)
  // The keyboard Ctrl+O still expands everything, mouse state or not.
  vt.sendInput('\x0f')
  view = await viewport(vt)
  assert.ok(view.includes('\nthree'), `global expand must show thinking:\n${view}`)
  assert.ok(view.includes('\nc'), `global expand must show the tool body:\n${view}`)
  assert.ok(view.includes('\n/ws'), `global expand must show the second card:\n${view}`)
  app.setFullscreen(false)
})

test('fullscreen click on a thinking row expands it; wheel, right button, and drag stay inert', async () => {
  const { vt, app } = startApp()
  app.setFullscreen(true)
  app.setTranscript([
    { kind: 'thinking', turn: 0, text: 'line one\nline two\nline three' },
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"ls"}', result: 'a\nb\nc', status: 'ok' },
  ])
  await viewport(vt)
  // Rows: header(1) + thinking(2) + tool(3). Click the thinking row.
  vt.sendInput('\x1b[<0;5;2M')
  vt.sendInput('\x1b[<0;5;2m')
  let view = await viewport(vt)
  assert.ok(view.includes('\nline two'), `thinking body missing after click:\n${view}`)
  assert.ok(!view.includes('\nb'), `tool card must stay folded:\n${view}`)
  // A drag (press + moved release) must not toggle either card.
  vt.sendInput('\x1b[<0;5;2M')
  vt.sendInput('\x1b[<0;20;2m')
  await viewport(vt)
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('\nline two'), `a drag must not collapse the card:\n${view}`)
  assert.ok(!view.includes('\nb'), `a drag must not expand the tool card:\n${view}`)
  // A wheel scroll and a right-button press/release must not toggle anything.
  vt.sendInput('\x1b[<64;5;2M')
  vt.sendInput('\x1b[<2;5;2M')
  vt.sendInput('\x1b[<2;5;2m')
  await viewport(vt)
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('\nline two'), `wheel/right must not collapse the card:\n${view}`)
  assert.ok(!view.includes('\nb'), `wheel/right must not expand the tool card:\n${view}`)
  app.setFullscreen(false)
})



test('tool card headers carry a per-variant emoji', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'tool', turn: 0, name: 'read', args: '{"file_path":"/ws/src/foo.ts"}', result: 'x', status: 'ok' },
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"ls"}', result: 'x', status: 'ok' },
    { kind: 'tool', turn: 0, name: 'grep', args: '{"pattern":"foo"}', result: 'x', status: 'ok' },
    { kind: 'tool', turn: 0, name: 'subagent', args: 'worker', result: '', status: 'ok' },
  ])
  const view = await viewport(vt)
  assert.ok(view.includes('📖  Read /ws/src/foo.ts'), `read emoji missing:\n${view}`)
  assert.ok(view.includes('🖥️  Bash ls'), `bash emoji missing:\n${view}`)
  assert.ok(view.includes('🔍  Search foo'), `search emoji missing:\n${view}`)
  assert.ok(view.includes('🤖  Subagent worker'), `subagent emoji missing:\n${view}`)
})

test('regular mode leaves the mouse entirely to the terminal (no click handling)', async () => {
  // pi parity: regular mode never enables mouse reporting, so terminal-native
  // selection and scrollback scrolling stay intact. A stray SGR sequence is
  // still inert and never disturbs the editor.
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'tool', turn: 0, name: 'bash', args: '{"command":"ls"}', result: 'a\nb\nc', status: 'ok' },
  ])
  await viewport(vt)
  vt.sendInput('\x1b[<0;10;2M')
  vt.sendInput('\x1b[<0;10;2m')
  await viewport(vt)
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\nb'), `regular mode must not react to clicks:\n${view}`)
})

test('tool cards degrade to generic rendering when the registry lookup is absent', async () => {
  // Mirrors the production guard: the registry is read through ctx.get and
  // may be absent (or hide behind cordis's inject guard), in which case the
  // presenter yields no views and cards render generically instead of failing.
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: toolPresenterFrom(() => undefined),
  })
  app.start()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'read',
    args: '{"file_path":"/ws/src/foo.ts"}',
    result: 'line one', status: 'ok', resultBlocks: [],
  }])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Read /ws/src/foo.ts [ok]'), `generic header missing:\n${view}`)
  assert.ok(view.includes('line one'), `generic body missing:\n${view}`)
  app.stop()
})

test('injected context rows show their emoji in the viewport', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'system', turn: 0,
    text: '# AGENTS.md\nRead me first.',
    label: 'AGENTS.md',
    emoji: '📄',
  }, {
    kind: 'system', turn: 0,
    text: 'catalog',
    label: 'skill-catalog',
    emoji: '📚',
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('📄  Context injection AGENTS.md'), `instruction emoji missing:\n${view}`)
  assert.ok(view.includes('📚  Context injection skill-catalog'), `catalog emoji missing:\n${view}`)
})

test('slash command cards carry a control-panel emoji', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'tool', turn: 0, name: '/compact', args: '', result: 'executed', status: 'ok' },
  ])
  const view = await viewport(vt)
  assert.ok(view.includes('🎛️  compact [ok]'), `slash emoji missing:\n${view}`)
})






test('read envelopes parse single, merged, and non-envelope results', () => {
  const single = `<path>/ws/a.ts</path>
<type>file</type>
<content>
1: line one
2: line two

(End of file - total 2 lines)
</content>`
  const envelopes = parseReadEnvelopes(single)
  assert.equal(envelopes.length, 1)
  assert.equal(envelopes[0]?.path, '/ws/a.ts')
  assert.equal(envelopes[0]?.lines.length, 2)
  assert.equal(envelopes[0]?.lines[1]?.text, 'line two')
  assert.equal(envelopes[0]?.totalLines, 2)
  // Merged group card: two consecutive envelopes parse into two entries.
  const merged = `${single}\n\n${single.replace('/ws/a.ts', '/ws/b.ts')}`
  const mergedEnvelopes = parseReadEnvelopes(merged)
  assert.equal(mergedEnvelopes.length, 2)
  assert.equal(mergedEnvelopes[1]?.path, '/ws/b.ts')
  // Not an envelope: no entries, no throw.
  assert.equal(parseReadEnvelopes('plain output').length, 0)
  assert.equal(parseReadEnvelopes('').length, 0)
})

test('read cards preview their envelope summary, never the raw XML', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'read',
    args: '{"file_path":"/ws/a.ts"}',
    result: `<path>/ws/a.ts</path>
<type>file</type>
<content>
1: line one
2: line two

(End of file - total 2 lines)
</content>`,
    status: 'ok',
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Read /ws/a.ts [ok] — 2 lines'), `summary preview missing:\n${view}`)
  assert.ok(!view.includes('<path>'), `raw envelope leaked into the folded row:\n${view}`)
  assert.ok(!view.includes('<content>'), `raw content leaked into the folded row:\n${view}`)
})

test('merged read groups expand into one tree row per file', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    present: toolPresenterFrom(() => undefined),
    workspaceRoot: '/ws',
  })
  app.start()
  app.setToolOutputExpanded(true)
  // The merged card is what groupConsecutiveReads produces: args "N files"
  // plus the consecutive envelopes joined in the result.
  const envelopeA = `<path>/ws/a.ts</path>\n<type>file</type>\n<content>\n1: a\n\n(End of file - total 1 lines)\n</content>`
  const envelopeB = envelopeA.replace('/ws/a.ts', '/ws/b.ts').replace('1: a', '1: b')
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'read',
    args: '2 files',
    result: `${envelopeA}\n\n${envelopeB}`,
    status: 'ok',
  }])
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('├─ a.ts · 1 lines'), `first tree row missing:\n${view}`)
  assert.ok(view.includes('└─ b.ts · 1 lines'), `last tree row missing:\n${view}`)
  assert.ok(!view.includes('<path>'), `raw XML leaked:\n${view}`)
  app.stop()
})

test('assistant and user messages align continuation lines under the bullet', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'user', turn: 0, text: 'line one\nline two' },
    { kind: 'assistant', turn: 0, text: 'para one\n\npara two' },
  ])
  const view = await viewport(vt)
  const lines = view.split('\n')
  const user = lines.findIndex(line => line.includes('❯ line one'))
  assert.ok(user >= 0, `user first line missing:\n${view}`)
  assert.ok(lines[user + 1]?.includes('line two'), `user continuation must follow on the next row:\n${view}`)
  assert.ok(!lines[user + 1]!.includes('❯'), `user continuation must not repeat the bullet:\n${view}`)
  // The assistant whale leads the first paragraph; the second paragraph's
  // first line indents under the bullet (a markdown blank line sits between).
  const assistant = lines.findIndex(line => line.includes('🐋') && line.includes('para one'))
  assert.ok(assistant >= 0, `assistant first line missing:\n${view}`)
  const paraTwo = lines.findIndex(line => line.includes('para two'))
  assert.ok(paraTwo > assistant, `assistant continuation missing:\n${view}`)
  assert.ok(!lines[paraTwo]!.includes('🐋'), `continuation must not repeat the bullet:\n${view}`)
  assert.ok(lines[paraTwo]!.startsWith('    '), `continuation must indent under the bullet:\n${view}`)
})

test('workflow runs expand into a phase-grouped member tree', async () => {
  const { vt, app } = startApp()
  app.setToolOutputExpanded(true)
  app.setTranscript([{
    kind: 'tool',
    turn: 0,
    name: 'workflow',
    args: 'audit',
    result: 'stop: completed',
    status: 'ok',
    members: [
      { label: 'checker', phase: 'review', status: 'ok' },
      { label: 'patcher', phase: 'review', status: 'error' },
      { label: 'reporter', phase: 'report', status: 'ok' },
      { label: 'live-agent', status: 'running' },
    ],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Workflow audit [ok]'), `run header missing:\n${view}`)
  assert.ok(view.includes('  review'), `phase header missing:\n${view}`)
  assert.ok(view.includes('checker — completed'), `completed member missing:\n${view}`)
  assert.ok(view.includes('patcher — failed'), `failed member missing:\n${view}`)
  assert.ok(view.includes('  report'), `second phase missing:\n${view}`)
  assert.ok(view.includes('reporter — completed'), `report member missing:\n${view}`)
  assert.ok(view.includes('live-agent — running'), `running member missing:\n${view}`)
})

test('workflow runs stay a single folded row until expanded', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'tool',
    turn: 0,
    name: 'workflow',
    args: 'audit',
    result: 'stop: completed',
    status: 'ok',
    members: [{ label: 'checker', phase: 'review', status: 'ok' }],
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('Workflow audit [ok]'), `folded header missing:\n${view}`)
  assert.ok(!view.includes('checker — completed'), `members leaked while folded:\n${view}`)
})

test('askQuestions marks recommended options and renders detail blocks', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{
    id: 'q1',
    question: 'Pick one?',
    detail: 'Some context about the choice.',
    options: [
      { label: 'Plain' },
      { label: 'Best (recommended)' },
    ],
  }])
  let view = await viewport(vt)
  assert.ok(view.includes('Some context about the choice.'), `detail missing:\n${view}`)
  assert.ok(view.includes('[recommended]'), `recommended badge missing:\n${view}`)
  assert.ok(!view.includes('(recommended)'), `suffix must be stripped from the display:\n${view}`)
  vt.sendInput('\r') // the recommended row is the default highlight → review
  await viewport(vt)
  vt.sendInput('\r') // review: submit
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Best (recommended)'] }])
})

test('askQuestions skip pages through and preserves drafts', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([
    { id: 'q1', question: 'First?', options: [{ label: 'A' }] },
    { id: 'q2', question: 'Second?' },
  ])
  await viewport(vt)
  vt.sendInput('s') // skip Q1 (empty answer)
  await viewport(vt)
  let view = await viewport(vt)
  assert.ok(view.includes('Second?'), `skipped past the first question:\n${view}`)
  vt.sendInput('hello')
  vt.sendInput('\r') // commit the typed answer → review page
  await viewport(vt)
  // b returns from the review page; drafts survive the round trip.
  vt.sendInput('b')
  await viewport(vt)
  view = await viewport(vt)
  assert.ok(view.includes('Second?'), `back to the second question:\n${view}`)
  vt.sendInput('\x1b[D') // Q2 text mode: ← pages back to Q1
  await viewport(vt)
  view = await viewport(vt)
  assert.ok(view.includes('First?'), `back to the first question:\n${view}`)
  vt.sendInput('\x1b[C') // back to Q2
  await viewport(vt)
  vt.sendInput('\x1b[C') // Q2 → review
  await viewport(vt)
  vt.sendInput('\r') // submit
  assert.deepEqual(await promise, [
    { id: 'q1', selected: [] },
    { id: 'q2', selected: [], custom: 'hello' },
  ])
})

test('askQuestions review page shows every answer before submitting', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([
    { id: 'q1', question: 'One?', options: [{ label: 'X' }] },
    { id: 'q2', question: 'Two?', options: [{ label: 'Y' }] },
  ])
  await viewport(vt)
  vt.sendInput('1')
  await viewport(vt)
  vt.sendInput('1')
  await viewport(vt)
  const view = await viewport(vt)
  assert.ok(view.includes('Review your answer before submit'), `review page missing:\n${view}`)
  assert.ok(view.includes('One?'), `Q1 answer missing:\n${view}`)
  assert.ok(view.includes('Two?'), `Q2 answer missing:\n${view}`)
  assert.ok(view.includes('X'), `Q1 value missing:\n${view}`)
  assert.ok(view.includes('Y'), `Q2 value missing:\n${view}`)
  vt.sendInput('\r') // submit
  assert.deepEqual(await promise, [
    { id: 'q1', selected: ['X'] },
    { id: 'q2', selected: ['Y'] },
  ])
})

test('an aborted signal settles the question flow as cancelled', async () => {
  const { vt, app } = startApp()
  const controller = new AbortController()
  const promise = app.askQuestions([{ id: 'q1', question: 'Any?', options: [{ label: 'Yes' }] }], controller.signal)
  await viewport(vt)
  controller.abort()
  await assert.rejects(promise, /cancelled/)
  const view = await viewport(vt)
  assert.ok(!view.includes('Any?'), `dialog must close on abort:\n${view}`)
  void vt
})

test('ask_user_question cards carry the Question identity instead of Tool call', async () => {
  const { vt, app } = startApp()
  app.setTranscript([
    { kind: 'tool', turn: 0, name: 'ask_user_question', args: '{"questions":[{"id":"q","question":"Go?"}]}', result: '', status: 'running' },
  ])
  const view = await viewport(vt)
  assert.ok(view.includes('❓  Question'), `question card missing:\n${view}`)
  assert.ok(!view.includes('Tool call'), `generic card leaked:\n${view}`)
})
