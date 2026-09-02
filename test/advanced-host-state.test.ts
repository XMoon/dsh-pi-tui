/**
 * Phase 4 tests (plan §12/§17): the ADVANCED host-state facade — theme
 * query/select, title override, working-indicator override and tool-
 * expansion preference; stale/inert behavior after surface disposal.
 * @module @xmoon76/dsh-pi-tui/advanced-host-state.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
interface DisposableApp { isDisposed(): boolean; dispose(): void }
const startedApps = new Set<DisposableApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

async function appWithHostState() {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  return { vt, app }
}

test('host state: getTheme reflects the applied theme; setTheme applies dark/light', async () => {
  const { app } = await appWithHostState()
  const host = app.advancedHostStateForTest()
  assert.equal(host.getTheme(), 'dark', 'the default theme is dark')
  host.setTheme('light')
  assert.equal(host.getTheme(), 'light', 'setTheme(light) applies and tracks')
  host.setTheme('dark')
  assert.equal(host.getTheme(), 'dark')
  app.stop()
})

test('host state: setTitle overrides the header title; undefined clears', async () => {
  const { vt, app } = await appWithHostState()
  const host = app.advancedHostStateForTest()
  host.setTitle('my plugin title')
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const view = vt.getViewport().map(strip).join('\n')
  assert.ok(view.includes('my plugin title'), `title missing:\n${view}`)
  host.setTitle(undefined)
  await vt.waitForRender()
  const cleared = vt.getViewport().map(strip).join('\n')
  assert.ok(!cleared.includes('my plugin title'), 'undefined clears the title')
  app.stop()
})

test('host state: setWorkingMessage overrides the working label', async () => {
  const { app } = await appWithHostState()
  const host = app.advancedHostStateForTest()
  host.setWorkingMessage('custom working')
  app.setWorking(true)
  // The override label is in the indicator's rendered text.
  const text = app.workingTextForTest?.() ?? ''
  assert.ok(text.includes('custom working'), `working label missing: ${text}`)
  host.setWorkingMessage(undefined)
  app.stop()
})

test('host state: setToolsExpanded toggles the expansion master switch', async () => {
  const { app } = await appWithHostState()
  const host = app.advancedHostStateForTest()
  assert.equal(app.isToolOutputExpanded(), false)
  host.setToolsExpanded(true)
  assert.equal(app.isToolOutputExpanded(), true)
  host.setToolsExpanded(false)
  assert.equal(app.isToolOutputExpanded(), false)
  app.stop()
})

test('host state: setTheme fires the runner handler for non-built-in names; dark/light apply directly', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const requested: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    // The runner's handler (round-1 finding 2: the event must be wired —
    // it resolves plugin palettes; unknown names are a no-op).
    onAdvancedSetTheme: (name) => { requested.push(name) },
  })
  app.start()
  startedApps.add(app)
  await vt.waitForRender()
  const host = app.advancedHostStateForTest()
  // A registered plugin theme name rides the event (the runner resolves).
  host.setTheme('plugin-theme')
  assert.deepEqual(requested, ['plugin-theme'])
  // An unknown name also rides the event (the runner no-ops).
  host.setTheme('unknown-theme')
  assert.deepEqual(requested, ['plugin-theme', 'unknown-theme'])
  // Built-in names apply directly and never fire the event.
  host.setTheme('light')
  assert.equal(host.getTheme(), 'light')
  assert.deepEqual(requested, ['plugin-theme', 'unknown-theme'], 'built-in themes never fire the event')
  app.stop()
})

test('host state: a disposed surface is inert', async () => {
  const { app } = await appWithHostState()
  const host = app.advancedHostStateForTest()
  app.dispose()
  host.setTheme('light')
  host.setTitle('late')
  host.setWorkingMessage('late')
  host.setToolsExpanded(true)
  assert.equal(host.getTheme(), 'dark', 'the disposed surface keeps the last theme')
  app.stop()
})
