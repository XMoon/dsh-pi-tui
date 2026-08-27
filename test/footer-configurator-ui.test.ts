/**
 * Headless tests for the footer configurator UI (the hierarchical
 * editor): the fixed shell (title, contextual help, live preview) with a
 * scrollable body, the page navigation through the app's focused-component
 * dispatch, the item/zone/move/add interactions, the searchable Add
 * picker, and the viewport matrix (the preview and the help never scroll
 * away at any tested terminal size).
 * @module @xmoon76/dsh-pi-tui/footer-configurator-ui.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { FooterConfiguratorModel } from '../src/footer/configurator-model.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../src/footer/presets.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(cols = 100, rows = 30): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(cols, rows)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  return { vt, app }
}

function openDefault(app: TuiApp, hooks: { onSave?: () => void; onCancel?: () => void } = {}): FooterConfiguratorModel {
  const model = new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: hooks.onSave ?? (() => {}),
    onCancel: hooks.onCancel ?? (() => {}),
  })
  return model
}

test('the configurator opens on the Row Selector with a live preview', async () => {
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
  const model = openDefault(app)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Configure Footer'), `title missing:\n${view}`)
  assert.ok(view.includes('Select row to edit'), `row selector missing:\n${view}`)
  assert.ok(view.includes('Preview'), `preview label missing:\n${view}`)
  assert.ok(view.includes('Row 1'), `the row list missing:\n${view}`)
  assert.ok(view.includes('deepseek/flash'), `preview must compose the real snapshot:\n${view}`)
  assert.ok(view.includes('↑↓ Select · Enter Edit · S Save · Esc Cancel'), `the selector help missing:\n${view}`)
  app.stop()
})

test('Enter edits the row; Esc walks back; Esc on the selector closes', async () => {
  const { vt, app } = startApp()
  let cancelled = 0
  openDefault(app, { onCancel: () => { cancelled += 1 } })
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Edit Row 1'), `Enter must open the row editor:\n${view}`)
  assert.ok(view.includes('Left') && view.includes('Right'), `the zones must both be visible:\n${view}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Configure Footer'), `Esc must return to the selector:\n${view}`)
  assert.equal(cancelled, 0)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(cancelled, 1, 'Esc on the selector closes the configurator')
  assert.equal(app.getFooterMode(), 'default', 'cancelling must not touch the active layout')
  app.stop()
})

test('S saves the draft from the Row Selector', async () => {
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
  // Enter the row, remove the first item, walk back, save.
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput(' ')
  await vt.waitForRender()
  assert.ok(!model.preview().rows[0]!.left.some(ref => ref.id === 'view-scope'), 'Space removed the item')
  vt.sendInput('\x1b') // → selector
  await vt.waitForRender()
  vt.sendInput('s')
  await vt.waitForRender()
  assert.ok(saved !== undefined, 'S must save the draft')
  const layout = saved as { rows: Array<{ left: Array<{ id: string }> }> }
  assert.ok(!layout.rows[0]!.left.some(ref => ref.id === 'view-scope'), 'the saved layout reflects the edit')
  assert.equal(cancelled, 0, 'saving must not cancel')
  app.stop()
})

test('the Edit Row page moves an item across zones with ←; Space removes; the preview follows', async () => {
  const { vt, app } = startApp()
  app.setStatus({ model: 'deepseek/flash', cwd: '/home/x/proj' })
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  // Walk onto the model item (flat cursor) and remove it.
  while (idAt(model) !== 'model') vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput(' ')
  await vt.waitForRender()
  // The FRAME's preview must drop the item (the app's real footer below
  // the frame keeps rendering the ACTIVE layout — the draft is separate).
  let view = vt.getViewport().join('\n')
  const frame = view.split('\n').filter(line => line.includes('│')).join('\n')
  assert.ok(!frame.includes('[deepseek/flash]'), `the removed item must leave the configurator preview:\n${view}`)
  assert.ok(model.availableIds().includes('model'), 'the removed item returns to the pool')
  // ←/→ move the current item to the other zone.
  vt.sendInput('\x1b[C') // → moves the (now active) item to the right zone
  await vt.waitForRender()
  assert.ok(model.preview().rows[0]!.right.length > 0, '→ moved the item to the right zone')
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Right'), `the right zone header must be visible:\n${view}`)
  app.stop()
})

/** The id at the model's flat cursor. */
function idAt(model: FooterConfiguratorModel): string | undefined {
  const state = model.state()
  const row = state.layout.rows[state.rowIndex]!
  const ref = state.cursor < row.left.length
    ? row.left[state.cursor]
    : row.right[state.cursor - row.left.length]
  return ref?.id
}

test('M enters Move Mode; arrows reorder; Enter exits', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  vt.sendInput('m') // → Move Mode
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Edit Row 1 [MOVE]'), `the move banner must show:\n${view}`)
  assert.ok(view.includes('↑↓ Move · ←→ Side · Enter/Esc Done'), `the move help must show:\n${view}`)
  vt.sendInput('\x1b[B') // ↓ reorders the first item down
  await vt.waitForRender()
  assert.equal(model.preview().rows[0]!.left[0]!.id, 'permission-preset')
  assert.equal(model.preview().rows[0]!.left[1]!.id, 'view-scope')
  vt.sendInput('\r') // exit Move Mode
  await vt.waitForRender()
  assert.equal(model.state().mode, 'row')
  app.stop()
})

test('A opens the Add picker; typing filters; Enter adds; Esc clears then back', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  vt.sendInput('a') // → Add picker
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Add Item → Row 1'), `picker title missing:\n${view}`)
  assert.ok(view.includes('Search:'), `search line missing:\n${view}`)
  // Type to filter (one chunk — the paste-burst path).
  vt.sendInput('cache')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Cache hit'), `the search must filter to the match:\n${view}`)
  assert.ok(!view.includes('Sandbox mode'), `non-matches must be filtered out:\n${view}`)
  // Enter adds; the item leaves the pool (the picker shows no more matches).
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(model.preview().rows[0]!.left.some(ref => ref.id === 'cache-hit'), 'the item joined the draft')
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('(no matching items)'), `the pool must drop the added item:\n${view}`)
  // Esc clears the search first, then returns to the row editor.
  vt.sendInput('\x1b')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('(type to filter)'), `the first Esc must clear the search:\n${view}`)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(model.state().mode, 'row')
  app.stop()
})

test('the Item Editor edits style/tone; the picker renders live examples', async () => {
  const { vt, app } = startApp()
  app.setStatus({ model: 'deepseek/flash', cwd: '/home/x/proj' })
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  // Walk onto the context item (multi-format) and open the item editor.
  while (idAt(model) !== 'context') vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Edit Item · Context'), `item editor title missing:\n${view}`)
  assert.ok(view.includes('Style'), `the style row missing:\n${view}`)
  assert.ok(view.includes('Tone'), `the tone row missing:\n${view}`)
  assert.ok(view.includes('Advanced…'), `the advanced row missing:\n${view}`)
  assert.ok(view.includes('↑↓ Select · Enter Open · ←→ Change · Esc Back'), `item help missing:\n${view}`)
  // ←→ cycles the style inline.
  vt.sendInput('\x1b[C')
  await vt.waitForRender()
  assert.equal(model.preview().rows[0]!.left.find(ref => ref.id === 'context')!.format, 'full')
  // Enter opens the Style picker with live examples.
  vt.sendInput('\r')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Style · Context'), `style picker title missing:\n${view}`)
  assert.ok(view.includes('Bar'), `the bar example missing:\n${view}`)
  assert.ok(view.includes('Full'), `the full example missing:\n${view}`)
  // Walk to Full, apply.
  vt.sendInput('\x1b[B')
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(model.preview().rows[0]!.left.find(ref => ref.id === 'context')!.format, 'full')
  assert.equal(model.state().mode, 'item')
  app.stop()
})

test('the Advanced editor edits prefix inline and shows the values', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  while (idAt(model) !== 'model') vt.sendInput('\x1b[B')
  vt.sendInput('\r') // → item editor (model: Tone first — no Style row)
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // → Advanced…
  vt.sendInput('\r')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Advanced · Model'), `advanced title missing:\n${view}`)
  assert.ok(view.includes('Prefix'), `prefix row missing:\n${view}`)
  assert.ok(view.includes('Importance'), `importance row missing:\n${view}`)
  assert.ok(view.includes('Reset to default'), `reset row missing:\n${view}`)
  // Type a prefix and confirm.
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('PR')
  vt.sendInput('OD')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('PR'), `the edit buffer must render:\n${view}`)
  vt.sendInput('\r') // commit
  await vt.waitForRender()
  assert.equal(model.preview().rows[0]!.left.find(ref => ref.id === 'model')!.prefix, 'PROD')
  app.stop()
})

test('the preview and the help NEVER scroll away (the fixed shell)', async () => {
  const { vt, app } = startApp(100, 24)
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  // Walk the cursor to the LAST item of the row (the body scrolls; the
  // shell must not).
  for (let i = 0; i < 32; i += 1) vt.sendInput('\x1b[B')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Preview'), `the preview must not scroll away:\n${view}`)
  assert.ok(view.includes('Esc Back'), `the contextual help must not scroll away:\n${view}`)
  assert.ok(view.includes('A Add'), `the help head must stay visible:\n${view}`)
  app.stop()
})

test('an UNKNOWN item id renders its label SANITIZED (control chars never reach the panel)', async () => {
  const { vt, app } = startApp()
  // The model carries a ref whose id is NOT in the registry (an unloaded
  // plugin) and contains MULTIPLE terminal control characters: the raw id
  // must never reach the panel (the parser rejects such ids in layouts —
  // this is the defense-in-depth layer for any other id source).
  const malicious = 'ext:gone/\u001b]52;c;bWFsaWNpb3Vz\u0007\u001b[2J'
  const model = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{ left: [{ id: malicious }], right: [] }],
  }, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: () => {},
    onCancel: () => {},
  })
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1 (the unknown id is listed there)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\u001b'), `an ESC must never reach the panel:\n${view}`)
  assert.ok(!view.includes('\u0007'), `a BEL must never reach the panel:\n${view}`)
  assert.ok(view.includes('ext:gone/'), `the sanitized label must still show the id text:\n${view}`)
  app.stop()
})

test('the preview context is LIVE: an extension segment update while open shows up', async () => {
  // The panel receives GETTERS for the task-browser gate and the
  // extension footer text: a change while the panel is open must be
  // reflected on the next render.
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
      return { ...snap, view: { subject: { kind: 'main' } } } as never
    },
    composer: new FooterComposer(createBuiltinFooterRegistry()),
    taskBrowserAvailable: () => true,
    extensionFooterText: () => extensionText,
    maxVisible: () => 100,
    onSave: () => {},
    onCancel: () => {},
  })
  const renderAll = (): string => panel.render(100).join('\n')
  assert.ok(!renderAll().includes('fresh-segment'), 'no extension text yet')
  // The extension host updates while the panel is open (a replace()).
  extensionText = 'fresh-segment'
  assert.ok(renderAll().includes('fresh-segment'), `the live getter must show the update`)
  app.stop()
})

test('the preview task-browser getter is LIVE: a draft typed under the panel updates the hint', async () => {
  let taskBrowserAvailable = true
  const { FooterConfiguratorPanel } = await import('../src/footer/configurator.ts')
  const { FooterComposer } = await import('../src/footer/composer.ts')
  const { createBuiltinFooterRegistry } = await import('../src/footer/builtin-items.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  const model = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'tasks' }], right: [] }],
  }, app.getFooterItemRegistry())
  const panel = new FooterConfiguratorPanel({
    model,
    registry: app.getFooterItemRegistry(),
    snapshot: () => {
      const snap = (app as unknown as { statusStore: { snapshot(): { activity?: { taskCount: number } } & Record<string, unknown> } }).statusStore.snapshot() as { activity?: { taskCount: number } } & Record<string, unknown>
      return { ...snap, view: { subject: { kind: 'main' } }, activity: { taskCount: 1 } } as never
    },
    composer: new FooterComposer(createBuiltinFooterRegistry()),
    taskBrowserAvailable: () => taskBrowserAvailable,
    extensionFooterText: () => '',
    maxVisible: () => 100,
    onSave: () => {},
    onCancel: () => {},
  })
  // The tasks badge advertises the ↓ browser ONLY while the routing gate
  // holds (the empty visible prompt editor) — the getter must be LIVE.
  assert.ok(panel.render(100).join('\n').includes('↓ view'), 'the available hint must show')
  taskBrowserAvailable = false
  assert.ok(!panel.render(100).join('\n').includes('↓ view'), 'an unavailable browser must drop the hint')
  app.stop()
})

for (const rows of [3, 4, 6, 40]) {
  test(`the configurator fits a ${rows}-row terminal (Frame borders visible, no hard cut)`, async () => {
    // Very short AND very tall terminals: the budget must leave room for
    // the Frame's two border rows AND the overlay's maxHeight must never
    // hard-cut the bottom border. The viewport ALWAYS reports `rows`
    // lines, so the meaningful assertion is that the Frame's borders are
    // actually rendered.
    const vt = new VirtualTerminal(100, rows)
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
    app.start()
    openDefault(app)
    await vt.waitForRender()
    const view = vt.getViewport()
    const lastNonEmpty = [...view].reverse().find(line => line.trim() !== '')
    assert.ok(lastNonEmpty !== undefined && lastNonEmpty.includes('╰'),
      `the Frame bottom border must be visible on a ${rows}-row terminal:\n${view.join('\n')}`)
    assert.ok(view.some(line => line.includes('╭')),
      `the Frame top border must be visible on a ${rows}-row terminal:\n${view.join('\n')}`)
    app.stop()
  })
}

for (const cols of [40, 80, 120]) {
  for (const rows of [10, 24, 40]) {
    test(`the shell holds at ${cols}x${rows}: preview + help never scroll away`, async () => {
      const vt = new VirtualTerminal(cols, rows)
      const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
      app.start()
      app.setStatus({ model: 'deepseek/flash', cwd: '/home/x/proj' })
      openDefault(app)
      await vt.waitForRender()
      // Enter Row 1 and walk the cursor to the LAST item: the body
      // windows around it while the fixed shell stays put.
      vt.sendInput('\r')
      await vt.waitForRender()
      for (let i = 0; i < 32; i += 1) vt.sendInput('\x1b[B')
      await vt.waitForRender()
      const view = vt.getViewport()
      const text = view.join('\n')
      assert.ok(view.some(line => line.includes('╭')) && view.some(line => line.includes('╰')),
        `the Frame borders must be visible at ${cols}x${rows}:\n${text}`)
      assert.ok(text.includes('Preview'), `the preview must stay visible at ${cols}x${rows}:\n${text}`)
      assert.ok(text.includes('A Add'), `the contextual help must not scroll away at ${cols}x${rows}:\n${text}`)
      // A long label must not break the layout (ANSI-safe truncation).
      assert.ok(!text.split('\n').some(line => line.length > cols + 20), `no line may overflow the frame at ${cols}x${rows}`)
      app.stop()
    })
  }
}