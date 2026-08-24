/**
 * Headless tests for the footer configurator UI (plan §15.3/§15.8): the
 * overlay renders the draft layout + the live preview, and the keys
 * (Space/↑↓/←→/Shift+↑↓/Tab/Enter/Esc) drive the model through the app's
 * focused-component dispatch.
 * @module @xmoon76/dsh-pi-tui/footer-configurator-ui.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { FooterConfiguratorModel } from '../src/footer/configurator-model.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../src/footer/presets.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

test('the configurator renders the draft items and the live preview', async () => {
  const { vt, app } = startApp()
  app.setStatus({
    model: 'deepseek/flash',
    cwd: '/home/x/proj',
    turns: 2,
    steps: 5,
    usage: {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      performance: { llmMs: 8100, firstTokenMs: 0, tokensPerSec: 0 },
      turns: 2,
      steps: 5,
    },
  })
  const model = new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: () => {},
    onCancel: () => {},
  })
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Configure Footer'), `title missing:\n${view}`)
  assert.ok(view.includes('Row 1 · Left'), `row header missing:\n${view}`)
  assert.ok(view.includes('[x] Model'), `item row missing:\n${view}`)
  assert.ok(view.includes('Preview'), `preview section missing:\n${view}`)
  assert.ok(view.includes('deepseek/flash'), `preview must compose the real snapshot:\n${view}`)
  app.stop()
})

test('Space toggles the active item; the preview follows', async () => {
  const { vt, app } = startApp()
  const model = new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: () => {},
    onCancel: () => {},
  })
  await vt.waitForRender()
  // The first item is view-scope (renders nothing on the main subject).
  // Move the cursor onto the model item and toggle it out.
  while (model.state().layout.rows[0]!.left[model.state().activeIndex]!.id !== 'model') model.moveCursorDown()
  vt.sendInput(' ')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('[deepseek/flash]'), `the toggled item must leave the preview:\n${view}`)
  app.stop()
})

test('Enter saves the draft; Esc cancels without touching the active layout', async () => {
  const { vt, app } = startApp()
  let saved: unknown
  let cancelled = 0
  const model = new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: (layout) => { saved = layout },
    onCancel: () => { cancelled += 1 },
  })
  await vt.waitForRender()
  // Toggle the first item out, then save.
  vt.sendInput(' ')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(saved !== undefined, 'Enter must save the draft')
  const layout = saved as { rows: Array<{ left: Array<{ id: string }> }> }
  assert.ok(!layout.rows[0]!.left.some(ref => ref.id === 'view-scope'), 'the saved layout must reflect the toggle')
  assert.equal(cancelled, 0)

  // Esc cancels: the draft mutations are discarded, the active layout is
  // untouched.
  const model2 = new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model: model2,
    registry: app.getFooterItemRegistry(),
    onSave: () => {},
    onCancel: () => { cancelled += 1 },
  })
  await vt.waitForRender()
  vt.sendInput(' ')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(cancelled, 1, 'Esc must cancel')
  assert.equal(app.getFooterMode(), 'default', 'the active layout must be untouched')
  app.stop()
})

test('Shift+↑/↓ reorder and Tab switches the row', async () => {
  const { vt, app } = startApp()
  const model = new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: () => {},
    onCancel: () => {},
  })
  await vt.waitForRender()
  // Shift+Down on the first item (view-scope) moves it one position.
  vt.sendInput('\x1b[1;2B')
  await vt.waitForRender()
  const state = model.state()
  assert.equal(state.layout.rows[0]!.left[0]!.id, 'permission-preset', 'shift+down must reorder')
  assert.equal(state.layout.rows[0]!.left[1]!.id, 'view-scope')
  // Tab switches to row 2.
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.equal(model.state().activeRow, 1)
  app.stop()
})
