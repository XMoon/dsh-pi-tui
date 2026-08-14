/**
 * Headless tests for the P4b experience features: footer status, fullscreen
 * toggle, settings overlay, and slash-command autocompletion.
 * @module @xmoon76/tui-app/experience.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { SettingItem } from '@xmoon76/pi-tui'
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

test('plan mode shows badges in header and footer and tints the editor border', async () => {
  const { vt, app } = startApp()
  app.setStatus({ model: 'm', cwd: 'c' })
  app.setPlanMode(true)
  await vt.waitForRender()
  let view = await viewport(vt)
  assert.ok(view.includes('[plan]'), `plan badge missing:\n${view}`)
  assert.ok(view.includes('🐋 dsh-pi-tui [plan]'), `header badge missing:\n${view}`)
  app.setPlanMode(false)
  view = await viewport(vt)
  assert.ok(!view.includes('[plan]'), `badge still visible:\n${view}`)
})

test('the auto session title shows in the header and clears', async () => {
  const { vt, app } = startApp()
  app.setSessionTitle('fix the read card')
  const view = await viewport(vt)
  assert.ok(view.includes('🐋 dsh-pi-tui · fix the read card'), `title missing from header:\n${view}`)
  app.setSessionTitle(undefined)
  const cleared = await viewport(vt)
  assert.ok(!cleared.includes('fix the read card'), `title survived:\n${cleared}`)
})


test('status merges partial updates', async () => {
  const { vt, app } = startApp()
  app.setStatus({ model: 'm', cwd: 'c' })
  app.setStatus({ turns: 1 })
  const view = await viewport(vt)
  assert.ok(view.includes('t1/s0'), `merged counters missing:\n${view}`)
})

test('fullscreen renders content with the editor pinned to the bottom', async () => {
  const { vt, app } = startApp()
  app.setTranscript([{ kind: 'user', turn: 0, text: 'hello' }])
  await viewport(vt)
  app.setFullscreen(true)
  const full = await viewport(vt)
  assert.ok(full.includes('hello'), `content missing in fullscreen:\n${full}`)
  // A transcript taller than the screen must scroll INSIDE the middle pane:
  // the editor border stays pinned to the bottom of the viewport.
  app.setTranscript(Array.from({ length: 40 }, (_, i) => ({ kind: 'user', turn: i, text: `line ${i}` })))
  await viewport(vt)
  const scrolled = vt.getViewport().join('\n')
  const lines = scrolled.split('\n')
  // The editor frame must survive the shrink pass in FULL: both borders
  // visible near the bottom, never compressed to a single row.
  const editorTop = lines.findIndex(line => line.includes('─'.repeat(10)))
  assert.ok(editorTop !== -1, `editor border missing:\n${scrolled}`)
  assert.ok(
    editorTop >= lines.length - 5,
    `editor must sit at the viewport bottom, found at ${editorTop}/${lines.length}:\n${scrolled}`,
  )
  assert.ok(
    lines.slice(editorTop + 1).some(line => line.includes('─'.repeat(10))),
    `editor bottom border missing (frame compressed):\n${scrolled}`,
  )
  app.setFullscreen(false)
  const regular = await viewport(vt)
  assert.ok(regular.includes('line 39'), `content missing after exit fullscreen:\n${regular}`)
})

test('editor input routes to the alt screen in fullscreen and back', async () => {
  const vt = new VirtualTerminal(100, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: (text) => submitted.push(text), onExit: () => {} })
  app.start()
  await viewport(vt)
  app.setFullscreen(true)
  await viewport(vt)
  vt.sendInput('typed in fullscreen')
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['typed in fullscreen'], 'submit must work in fullscreen')
  app.setFullscreen(false)
  await viewport(vt)
  vt.sendInput('back in regular')
  vt.sendInput('\r')
  await viewport(vt)
  assert.deepEqual(submitted, ['typed in fullscreen', 'back in regular'], 'submit must work after exiting fullscreen')
})

test('setFullscreen reports changes and stays idempotent', async () => {
  const vt = new VirtualTerminal(100, 24)
  const changes: boolean[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onFullscreenChange: (fullscreen) => { changes.push(fullscreen) },
  })
  app.start()
  assert.equal(app.isFullscreen(), false)
  app.setFullscreen(true)
  assert.equal(app.isFullscreen(), true)
  app.setFullscreen(true) // no-op: no duplicate change
  app.setFullscreen(false)
  assert.equal(app.isFullscreen(), false)
  assert.deepEqual(changes, [true, false])
  await viewport(vt)
})

test('approval prompt survives a fullscreen toggle', async () => {
  const { vt, app } = startApp()
  const decision = app.showApprovalPrompt({ toolName: 'bash' })
  await viewport(vt)
  assert.ok((await viewport(vt)).includes('Approve bash'), 'dialog missing before toggle')
  app.setFullscreen(true) // the dialog must re-mount on the alt screen
  const full = await viewport(vt)
  assert.ok(full.includes('Approve bash'), `dialog missing in fullscreen:\n${full}`)
  vt.sendInput('y')
  assert.equal(await decision, 'allowed-once')
  // Back to regular mode: no dialog residue.
  app.setFullscreen(false)
  const regular = await viewport(vt)
  assert.ok(!regular.includes('Approve bash'), `dialog residue after exit fullscreen:\n${regular}`)
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

test('ctrl+shift+f opens transcript search; typing reports queries; escape closes', async () => {
  const vt = new VirtualTerminal(100, 24)
  const queries: string[] = []
  let closed = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSearchQuery: (query) => { queries.push(query) },
    onSearchClose: () => { closed += 1 },
  })
  app.start()
  vt.sendInput('\x1b[102;6u') // ctrl+shift+f (kitty CSI u, modifiers ctrl+shift)
  await viewport(vt)
  assert.ok(app.isSearching(), 'search overlay should open')
  vt.sendInput('needle')
  await viewport(vt)
  assert.ok(queries.includes('needle'), `queries: ${JSON.stringify(queries)}`)
  vt.sendInput('\x1b') // escape closes the search
  await viewport(vt)
  assert.equal(app.isSearching(), false)
  assert.equal(closed, 1)
  // Opening again focuses the same overlay without a second close cycle.
  vt.sendInput('\x1b[102;6u')
  await viewport(vt)
  assert.ok(app.isSearching())
  vt.sendInput('\x1b')
  await viewport(vt)
  assert.equal(closed, 2)
})

test('a single escape without overlays reaches onSingleEscape and can be consumed', async () => {
  const vt = new VirtualTerminal(80, 24)
  let singleEscapes = 0
  let cancels = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onCancel: () => { cancels += 1 },
    onSingleEscape: () => { singleEscapes += 1; return true },
  })
  app.start()
  await viewport(vt)
  vt.sendInput('\x1b')
  await viewport(vt)
  assert.equal(singleEscapes, 1, 'onSingleEscape should fire on the first Esc')
  assert.equal(cancels, 0, 'a consumed Esc must not arm the double-Esc cancel')
})

test('onSingleEscape fires on the Esc AFTER a settings panel closed', async () => {
  const vt = new VirtualTerminal(80, 24)
  let singleEscapes = 0
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onSingleEscape: () => { singleEscapes += 1; return true },
  })
  app.start()
  await viewport(vt)
  app.openSettings(
    [{ id: 'a', label: 'A', currentValue: '', values: ['x'] }],
    () => {},
    () => {},
  )
  await viewport(vt)
  vt.sendInput('\x1b') // close the panel
  await viewport(vt)
  vt.sendInput('\x1b') // should reach onSingleEscape now
  await viewport(vt)
  assert.equal(singleEscapes, 1, 'the Esc after the panel closed must reach onSingleEscape')
})
