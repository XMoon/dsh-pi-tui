/**
 * Headless tests for the P4b experience features: footer status, fullscreen
 * toggle, settings overlay, and slash-command autocompletion.
 * @module @dsh-pi-tui/tui-app/experience.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SettingItem } from '@dsh-pi-tui/pi-tui'
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

test('footer shows model, cwd, branch, counters, context bar, and stats', async () => {
  const { vt, app } = startApp()
  app.setStatus({
    model: 'opencode-go/deepseek-v4-flash',
    cwd: 'project/me/dsh-pi-tui',
    branch: 'main',
    turns: 2,
    steps: 5,
    statsLine: '2 轮 · 5 步| LLM 8.1s',
    contextTokens: 25_000,
    contextWindow: 100_000,
  })
  const view = await viewport(vt)
  assert.ok(view.includes('[opencode-go/deepseek-v4-flash]'), `model missing:\n${view}`)
  assert.ok(view.includes('project/me/dsh-pi-tui'), `cwd missing:\n${view}`)
  assert.ok(view.includes(' main '), `branch missing:\n${view}`)
  assert.ok(view.includes('t2/s5'), `counters missing:\n${view}`)
  assert.ok(view.includes('] 25%'), `context bar missing:\n${view}`)
  assert.ok(view.includes('2 轮 · 5 步| LLM 8.1s'), `stats line missing:\n${view}`)
})

test('status merges partial updates', async () => {
  const { vt, app } = startApp()
  app.setStatus({ model: 'm', cwd: 'c' })
  app.setStatus({ turns: 1 })
  const view = await viewport(vt)
  assert.ok(view.includes('t1/s0'), `merged counters missing:\n${view}`)
})

test('ctrl+f toggles fullscreen without crashing and renders content', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'user', text: 'hello' }])
  await viewport(vt)
  vt.sendInput('\x06') // ctrl+f
  const full = await viewport(vt)
  assert.ok(full.includes('hello'), `content missing in fullscreen:\n${full}`)
  vt.sendInput('\x06') // back to regular
  const regular = await viewport(vt)
  assert.ok(regular.includes('hello'), `content missing after exit fullscreen:\n${regular}`)
})

test('settings overlay shows items and reports changes', async () => {
  const { vt, app } = startApp()
  const changes: Array<[string, string]> = []
  const items: SettingItem[] = [
    { id: 'approval', label: 'Approval policy', currentValue: 'ask', values: ['ask', 'never'] },
    { id: 'theme', label: 'Theme', currentValue: 'dark', values: ['dark', 'light'] },
  ]
  app.openSettings(items, (id, value) => changes.push([id, value]), () => {})
  let view = await viewport(vt)
  assert.ok(view.includes('Approval policy'), `settings missing:\n${view}`)
  assert.ok(view.includes('Theme'), `settings missing:\n${view}`)
  // Enter cycles the first item's values (ask -> never).
  vt.sendInput('\r')
  view = await viewport(vt)
  assert.ok(view.includes('never'), `value did not cycle:\n${view}`)
  // Down + enter cycles the second item.
  vt.sendInput('\x1b[B')
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(changes, [['approval', 'never'], ['theme', 'light']])
})

test('slash-command autocompletion installs without breaking input', async () => {
  const { vt, app } = startApp()
  app.setCommandCompletions([{ name: 'exit', description: 'Quit' }, { name: 'settings', description: 'Panel' }], '/tmp')
  await viewport(vt)
  vt.sendInput('/')
  await viewport(vt)
  vt.sendInput('s')
  await viewport(vt)
  // The autocomplete list should offer settings; content still renders.
  const view = await viewport(vt)
  assert.ok(view.includes('/s'), `editor content missing:\n${view}`)
})
