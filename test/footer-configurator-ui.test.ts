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
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Configure Footer'), `title missing:\n${view}`)
  assert.ok(view.includes('Row 1 · Left'), `row header missing:\n${view}`)
  assert.ok(view.includes('[x] Model'), `item row missing:\n${view}`)
  // The content windows around the cursor: scroll to the BOTTOM (the last
  // available item) so the preview comes into view. Direct model moves
  // need an explicit render (the fork re-renders only after handleInput).
  while (!model.state().cursorInAvailable) model.moveCursorDown()
  for (let i = 0; i < 12; i += 1) model.moveCursorDown()
  app.requestRender()
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
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

test('the preview context is LIVE: an extension segment update while open shows up', async () => {
  // The panel receives GETTERS for the editor-empty flag and the
  // extension footer text: a change while the panel is open (a segment
  // updated, a draft typed) must be reflected on the next render.
  let extensionText = ''
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  // Avoid the real extension host: drive the panel directly with getters.
  const { FooterConfiguratorPanel } = await import('../src/footer/configurator.ts')
  const { FooterComposer } = await import('../src/footer/composer.ts')
  const { createBuiltinFooterRegistry } = await import('../src/footer/builtin-items.ts')
  const model = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'ext:*' }], right: [] }],
  }, app.getFooterItemRegistry())
  const panel = new FooterConfiguratorPanel({
    model,
    registry: app.getFooterItemRegistry(),
    snapshot: () => {
      const snap = (app as unknown as { statusStore: { snapshot(): { context?: unknown } & Record<string, unknown> } }).statusStore.snapshot() as { context?: unknown } & Record<string, unknown>
      // Give the preview subjects (the main subject shows the extension text).
      return { ...snap, view: { subject: { kind: 'main' } } } as never
    },
    composer: new FooterComposer(createBuiltinFooterRegistry()),
    editorEmpty: () => true,
    extensionFooterText: () => extensionText,
    maxVisible: () => 100,
    onSave: () => {},
    onCancel: () => {},
  })
  // The layout's ext:* item renders the extension footer text. Window the
  // panel to its TAIL (the preview section) so the assertion sees it.
  const renderTail = (): string => panel.render(100).join('\n')
  const first = renderTail()
  assert.ok(!first.includes('fresh-segment'), 'no extension text yet')
  // The extension host updates while the panel is open (a replace()).
  extensionText = 'fresh-segment'
  const second = renderTail()
  assert.ok(second.includes('fresh-segment'), `the live getter must show the update:\n${second}`)
  app.stop()
})
