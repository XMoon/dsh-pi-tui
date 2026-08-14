/**
 * Headless tests for the P5c rendering features: diff colorization, LaTeX
 * in assistant markdown, the todo panel, the thinking hide toggle,
 * user-questions dialogs, and fullscreen scrollback search.
 * @module @dsh-pi-tui/tui-app/rendering.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { isDiffResult, renderDiffLine } from '../src/diff.ts'
import { color, currentPalette } from '../src/theme.ts'
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
  assert.ok(view.includes('1) Yes'), `option missing:\n${view}`)
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
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['C', 'B'] }])
})

test('askQuestions collects free text for option-less questions', async () => {
  const { vt, app } = startApp()
  const promise = app.askQuestions([{ id: 'q1', question: 'Your name?' }])
  await viewport(vt)
  vt.sendInput('alice')
  vt.sendInput('\r')
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
  vt.sendInput('1')
  vt.sendInput('\r')
  await viewport(vt)
  view = await viewport(vt)
  assert.ok(view.includes('Second?'), `second question missing:\n${view}`)
  vt.sendInput('2')
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

test('tool card headers show the key argument instead of raw args', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{
    kind: 'tool', turn: 0, name: 'bash',
    args: '{"command":"ls -la","cwd":"/tmp"}',
    result: 'done', status: 'ok',
  }])
  const view = await viewport(vt)
  assert.ok(view.includes('command=ls -la'), `key arg missing:\n${view}`)
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
  vt.sendInput('\x06') // ctrl+f → fullscreen
  await viewport(vt)
  vt.sendInput('\x1b[102;6u') // kitty ctrl+shift+f
  const view = await viewport(vt)
  assert.ok(view.includes('Find transcript'), `search bar missing:\n${view}`)
})
