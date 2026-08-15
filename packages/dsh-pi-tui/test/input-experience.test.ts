/**
 * Headless tests for the P5b input experience: fork editor keybindings
 * (undo / kill-ring), input-history seeding and recall, Ctrl+S steering,
 * the external-editor hook, and local `!` shell cards.
 * @module @xmoon76/dsh-pi-tui/input-experience.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp, type TuiAppEvents } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(overrides: Partial<TuiAppEvents> = {}): { vt: VirtualTerminal; app: TuiApp; submitted: string[] } {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    ...overrides,
  })
  app.start()
  return { vt, app, submitted }
}

async function viewport(vt: VirtualTerminal): Promise<string> {
  await vt.waitForRender()
  return vt.getViewport().join('\n')
}

test('editor undo (ctrl+-) restores text after a word deletion', async () => {
  const { vt, app, submitted } = startApp()
  vt.sendInput('abc')
  vt.sendInput('\x17') // ctrl+w: delete word backward
  vt.sendInput('\x1f') // ctrl+-: undo
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['abc'], 'undo must restore the deleted word')
  void app
})

test('kill ring yanks back killed text (ctrl+k, ctrl+y)', async () => {
  const { vt, app, submitted } = startApp()
  vt.sendInput('one two')
  vt.sendInput('\x0b') // ctrl+k: kill to line end
  vt.sendInput('\x19') // ctrl+y: yank
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['one two'], 'yank must restore the killed text')
  void app
})

test('seeded input history recalls entries with the up arrow', async () => {
  const { vt, app, submitted } = startApp()
  app.seedInputHistory(['second', 'first']) // newest first, as persisted
  vt.sendInput('\x1b[A') // up
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['second'], 'up arrow must recall the newest entry')
})

test('submitted lines land in the persisted history mirror', async () => {
  const { vt, app } = startApp()
  vt.sendInput('hello')
  vt.sendInput('\r')
  await viewport(vt)
  vt.sendInput('world')
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual([...app.getInputHistory()], ['world', 'hello'])
})

test('ctrl+s steers the draft and clears the editor', async () => {
  const vt = new VirtualTerminal(80, 24)
  const steered: string[] = []
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    onSteer: (text) => steered.push(text),
  })
  app.start()
  vt.sendInput('do better')
  vt.sendInput('\x13') // ctrl+s
  await viewport(vt)
  assert.deepEqual(steered, ['do better'], 'steer must receive the draft')
  // The editor was cleared: a follow-up submit carries only the new text.
  vt.sendInput('x')
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['x'], 'steer must clear the editor')
})

test('ctrl+s with an empty draft still fires onSteer (the runner decides)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const steered: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSteer: (text) => steered.push(text),
  })
  app.start()
  vt.sendInput('\x13') // ctrl+s with an empty editor
  await viewport(vt)
  // The queue pane is the primary steer surface: with queued messages and an
  // empty draft, the runner steers the whole queue, so the event must fire.
  assert.deepEqual(steered, [''], 'empty-draft ctrl+s must still fire onSteer')
  assert.equal(app.getDraft(), '', 'editor must stay empty after ctrl+s')
})

test('ctrl+g opens the external editor and restores its content', async () => {
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
    openExternalEditor: async (draft) => `edited: ${draft}`,
  })
  app.start()
  vt.sendInput('draft')
  vt.sendInput('\x07') // ctrl+g
  // The TUI stops and restarts around the external editor round-trip.
  await new Promise(resolve => setTimeout(resolve, 30))
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['edited: draft'], 'external editor content must replace the draft')
})

test('local shell cards render, settle in place, and clear', async () => {
  const { vt, app } = startApp()
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'ls -la', result: '', status: 'running',
  })
  let view = await viewport(vt)
  assert.ok(view.includes('Shell ls -la [running]'), `running card missing:\n${view}`)
  assert.ok(view.includes('ls -la'), `args missing:\n${view}`)
  app.updateLastLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'ls -la', result: 'total 8\n[exit 0]', status: 'ok',
  })
  view = await viewport(vt)
  assert.ok(view.includes('exit 0'), `result missing:\n${view}`)
  app.clearLocalMessages()
  view = await viewport(vt)
  assert.ok(!view.includes('Shell'), `card not cleared:\n${view}`)
})

test('a settled card updates by identity, never the newest card', async () => {
  const { vt, app } = startApp()
  // `!cmd1` running; its settle callback holds this reference.
  const first = app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'cmd1', result: '', status: 'running',
  })
  // `!cmd2` starts before cmd1 settles (cmd1 was aborted/killed).
  app.pushLocalMessage({
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'cmd2', result: '', status: 'running',
  })
  // cmd1's close event arrives late: it must touch only ITS card.
  app.updateLocalMessage(first, {
    kind: 'tool', turn: Number.POSITIVE_INFINITY, name: 'shell',
    args: 'cmd1', result: 'aborted', status: 'error',
  })
  await viewport(vt)
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('aborted'), `cmd1 settlement missing:\n${view}`)
  assert.ok(!view.includes('abortedcmd2') && view.includes('cmd2'), `cmd2 card corrupted:\n${view}`)
  assert.ok(
    !view.includes('cmd1') || view.includes('aborted'),
    `cmd1 card must show its own settlement:\n${view}`,
  )
})
