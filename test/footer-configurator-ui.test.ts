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
import { FooterComposer } from '../src/footer/composer.ts'
import { FooterConfiguratorModel, sameFooterCustomItem } from '../src/footer/configurator-model.ts'
import { FooterCustomItemCatalog } from '../src/footer/custom-items.ts'
import { FooterItemRegistry } from '../src/footer/item-registry.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../src/footer/presets.ts'
import type { StatusSnapshot } from '../src/status/types.ts'
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
  assert.ok(view.includes('↑↓ Select · Enter Open · S Save · Esc Close'), `the selector help missing:\n${view}`)
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
  // Esc exits Move Mode back to the row editor too (never a page skip to
  // the Row Selector — the plan's "Enter/Esc Done").
  vt.sendInput('m')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Edit Row 1'), `Move Mode's Esc must return to the row editor:\n${view}`)
  app.stop()
})

test('A opens the Add picker; typing filters; Enter adds and closes', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  vt.sendInput('a') // → Add picker
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Add Item → Row 1 · Left'), `picker title missing (the add side is shown):\n${view}`)
  assert.ok(view.includes('Search:'), `search line missing:\n${view}`)
  // Type to filter (one chunk — the paste-burst path).
  vt.sendInput('cache')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Cache hit'), `the search must filter to the match:\n${view}`)
  assert.ok(!view.includes('Sandbox mode'), `non-matches must be filtered out:\n${view}`)
  // Enter adds AND closes the picker (ccstatusline parity): the row
  // editor shows the cursor on the added item.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.ok(model.preview().rows[0]!.left.some(ref => ref.id === 'cache-hit'), 'the item joined the draft')
  assert.equal(model.state().mode, 'row', 'a successful add closes the picker')
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Edit Row 1'), `the picker must close back into the row editor:\n${view}`)
  // Reopen: the query is FRESH, and the added item has left the pool.
  vt.sendInput('a')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, '')
  vt.sendInput('cache')
  await vt.waitForRender()
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
  // ←→ cycles the style inline: bar → percent → full.
  vt.sendInput('\x1b[C')
  await vt.waitForRender()
  assert.equal(model.preview().rows[0]!.left.find(ref => ref.id === 'context')!.format, 'percent')
  vt.sendInput('\x1b[C')
  await vt.waitForRender()
  assert.equal(model.preview().rows[0]!.left.find(ref => ref.id === 'context')!.format, 'full')
  // Enter opens the Style picker with live examples.
  vt.sendInput('\r')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Style · Context'), `style picker title missing:\n${view}`)
  assert.ok(view.includes('Bar'), `the bar example missing:\n${view}`)
  assert.ok(view.includes('Percent'), `the percent example missing:\n${view}`)
  assert.ok(view.includes('Full'), `the full example missing:\n${view}`)
  // Walk to Full, apply.
  vt.sendInput('\x1b[B')
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
  vt.sendInput('\r') // → item editor (model: Style, Tone, Advanced)
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // → Tone
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

test('the Advanced page sanitizes hand-built prefix/suffix values too', async () => {
  const { vt, app } = startApp()
  // The Advanced page shows the ref's committed prefix/suffix (and seeds
  // the inline editor from them): a hand-built ref's control characters
  // must not paint through THIS page either, and a commit of the seeded
  // buffer must persist the STRIPPED value (the draft stays parseable).
  const model = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{
      left: [{ id: 'model', prefix: '\u001b]52;c;bWFsaWNpb3Vz\u0007P', suffix: 'S\u001b[2J' }],
      right: [],
    }],
  }, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: () => {},
    onCancel: () => {},
  })
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  vt.sendInput('\r') // → item editor (single item; menu: Style, Tone, Advanced)
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // → Tone
  vt.sendInput('\x1b[B') // → Advanced…
  vt.sendInput('\r') // → the Advanced page
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\u001b') && !view.includes('\u0007'), `the advanced page must sanitize the values:\n${view}`)
  assert.ok(view.includes('bWFsaWNpb3Vz'), `the readable residue stays visible:\n${view}`)
  // The inline editor seeds from the stripped value: commit unchanged.
  vt.sendInput('\r') // edit prefix
  await vt.waitForRender()
  vt.sendInput('\r') // commit the stripped seed
  await vt.waitForRender()
  const prefix = model.preview().rows[0]!.left[0]!.prefix!
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(prefix), `the committed prefix must be control-char free:\n${JSON.stringify(prefix)}`)
  app.stop()
})

test('the Add picker refuses a FULL row with an explicit hint (the parse cap)', async () => {
  const { vt, app } = startApp()
  // 32 items is the persisted-layout parser's per-row cap: the picker
  // must say WHY Enter no longer adds, and the model must not mutate.
  const row = Array.from({ length: 32 }, (_, index) => ({ id: `pad-${index}` }))
  const model = new FooterConfiguratorModel({ schemaVersion: 1, rows: [{ left: row, right: [] }] }, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: () => {},
    onCancel: () => {},
  })
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  vt.sendInput('a') // → Add picker
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('(row is full — remove an item first)'), `the full-row hint must show:\n${view}`)
  vt.sendInput('\r') // Enter at the cap
  await vt.waitForRender()
  assert.equal(model.preview().rows[0]!.left.length, 32, `the cap refuses the 33rd item`)
  app.stop()
})

test('bracketed paste feeds the Add search (single chunk, markers included)', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  vt.sendInput('a') // → Add picker
  await vt.waitForRender()
  // A terminal wraps a paste between the 200~/201~ markers — the WHOLE
  // chunk is ESC-led, so the old "no ESC = printable" test dropped it.
  vt.sendInput('\x1b[200~cache\x1b[201~')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, 'cache', `the pasted query must land:\n${model.state().addQuery}`)
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Cache hit'), `the pasted query must filter:\n${view}`)
  app.stop()
})

test('bracketed paste feeds the Advanced prefix editor', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  while (idAt(model) !== 'model') vt.sendInput('\x1b[B')
  vt.sendInput('\r') // → item editor
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // → Tone
  vt.sendInput('\x1b[B') // → Advanced…
  vt.sendInput('\r') // → the Advanced page
  await vt.waitForRender()
  vt.sendInput('\r') // edit prefix
  await vt.waitForRender()
  vt.sendInput('\x1b[200~PROD\x1b[201~')
  await vt.waitForRender()
  assert.equal(model.state().editBuffer, 'PROD', `the paste must land in the buffer`)
  vt.sendInput('\r') // commit
  await vt.waitForRender()
  assert.equal(model.preview().rows[0]!.left.find(ref => ref.id === 'model')!.prefix, 'PROD')
  app.stop()
})

test('bracketed paste split across terminal chunks buffers until the end marker', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('a')
  await vt.waitForRender()
  // Start/content/end split across chunks (slow terminals deliver paste
  // in pieces). 'cach' filters to Cache hit (context is already IN the
  // default layout, so the pool wouldn't list it).
  vt.sendInput('\x1b[200~c')
  await vt.waitForRender()
  vt.sendInput('ac')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, '', 'the buffered paste must not leak into the query mid-stream')
  vt.sendInput('h\x1b[201~')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, 'cach', `the split paste must assemble:\n${model.state().addQuery}`)
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Cache hit'), `the assembled query must filter:\n${view}`)
  app.stop()
})

test('a bracketed-paste start marker split across chunks is recognized', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('a')
  await vt.waitForRender()
  // The start marker is split after ESC+[20; the first chunk must not leak
  // into the search and the second chunk must complete the protocol.
  vt.sendInput('\x1b[20')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, '')
  vt.sendInput('0~cach\x1b[201~')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, 'cach')
  assert.ok(vt.getViewport().join('\n').includes('Cache hit'))
  app.stop()
})

test('a bracketed-paste start marker split exactly after ESC is recognized', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('a')
  await vt.waitForRender()
  // ESC is ambiguous until the next chunk: it must stay buffered long
  // enough to join the remainder of the bracketed-paste marker.
  vt.sendInput('\x1b')
  vt.sendInput('[200~cach\x1b[201~')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, 'cach')
  assert.ok(vt.getViewport().join('\n').includes('Cache hit'))
  app.stop()
})

test('a paste start clears stale prefix state before later chunks arrive', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('a')
  await vt.waitForRender()

  // The malformed prefix before the start marker must not remain active while
  // the paste's content and end marker arrive in a later chunk.
  vt.sendInput('\x1b[20\x1b[200~')
  vt.sendInput('one\x1b[201~')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, 'one')

  // Verify that the scanner can immediately accept another split paste and
  // ordinary text after the first paste completes.
  vt.sendInput('\x1b[200~two')
  vt.sendInput('\x1b[201~')
  vt.sendInput('tail')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, 'onetwotail')
  app.stop()
})

test('a real Escape before a new same-chunk paste is not discarded', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('a')
  await vt.waitForRender()

  // The first paste ends, then Escape and a second paste follow in the same
  // terminal chunk. Escape must clear the old query before the new paste lands.
  vt.sendInput('\x1b[200~one\x1b[201~\x1b\x1b[200~two\x1b[201~')
  await vt.waitForRender()
  assert.equal(model.state().mode, 'add')
  assert.equal(model.state().addQuery, 'two')
  app.stop()
})

test('recovery rescans a valid paste marker after rejected prefixes', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('a')
  await vt.waitForRender()

  // A longer rejected prefix must not swallow a complete marker in the next
  // chunk.
  vt.sendInput('\x1b[20')
  vt.sendInput('\x1b[200~cach\x1b[201~')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, 'cach')

  // A rejected lone ESC is replayed before a fresh marker. The non-empty
  // query makes both effects observable: Escape clears it, then the marker
  // contributes the new paste text.
  vt.sendInput('seed')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  vt.sendInput('\x1b[200~hit\x1b[201~')
  await vt.waitForRender()
  assert.equal(model.state().mode, 'add')
  assert.equal(model.state().addQuery, 'hit')
  app.stop()
})

test('a lone Escape is replayed as navigation after the paste-prefix timeout', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('a')
  await vt.waitForRender()
  vt.sendInput('cache')
  await vt.waitForRender()
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, '', 'a standalone Escape must still clear the search')
  app.stop()
})

test('programmatic configurator close disposes a pending paste-prefix timer', async (t) => {
  const { vt, app } = startApp()
  const model = new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, app.getFooterItemRegistry())
  const close = app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: () => {},
    onCancel: () => {},
  })
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('a')
  await vt.waitForRender()
  vt.sendInput('cache')
  await vt.waitForRender()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => t.mock.timers.reset())
  vt.sendInput('\x1b') // arm the ambiguous paste-prefix timer
  close()
  t.mock.timers.tick(30)
  assert.equal(model.state().addQuery, 'cache', 'closing must prevent stale Escape replay')
  app.stop()
})

test('final app disposal cancels a configurator paste-prefix timer', async (t) => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('a')
  await vt.waitForRender()
  vt.sendInput('cache')
  await vt.waitForRender()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.after(() => t.mock.timers.reset())
  vt.sendInput('\x1b') // arm the ambiguous paste-prefix timer
  app.dispose()
  t.mock.timers.tick(30)
  assert.equal(model.state().addQuery, 'cache', 'final disposal must prevent stale Escape replay')
})

test('malformed paste prefixes preserve Escape, arrows, and following text', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('a')
  await vt.waitForRender()
  vt.sendInput('cache')
  await vt.waitForRender()

  // A prefix that never becomes 200~ must not consume a later Escape.
  vt.sendInput('\x1b[20')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, '', 'Escape must still clear the pending search')

  // The malformed prefix must not consume a complete arrow sequence either.
  vt.sendInput('\x1b[20')
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  assert.equal(model.state().pickerIndex, 1, 'the arrow must still move the picker')

  vt.sendInput('\x1b[20')
  vt.sendInput('x')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, 'x', 'ordinary input after the prefix must survive')
  app.stop()
})

test('CSI-u encoded printables type into the Add search and the prefix', async () => {
  const { vt, app } = startApp()
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('a')
  await vt.waitForRender()
  // Kitty flag 1 sends CSI-u for ALL keys — including plain printables.
  // '\x1b[97u' is 'a'; '\x1b[97:65;2u' is shift+a ('A' via the shifted
  // keycode). Both contain ESC: the old contains-ESC check dropped them.
  vt.sendInput('\x1b[97u')
  await vt.waitForRender()
  vt.sendInput('\x1b[97:65;2u')
  await vt.waitForRender()
  assert.equal(model.state().addQuery, 'aA', `the CSI-u printables must land:\n${JSON.stringify(model.state().addQuery)}`)
  vt.sendInput('\x1b') // clear the query
  await vt.waitForRender()
  vt.sendInput('\x1b') // back to the row
  await vt.waitForRender()
  // modifyOtherKeys shape in the prefix editor.
  while (idAt(model) !== 'model') vt.sendInput('\x1b[B')
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // → Tone
  vt.sendInput('\x1b[B') // → Advanced…
  vt.sendInput('\r')
  await vt.waitForRender()
  vt.sendInput('\r') // edit prefix
  await vt.waitForRender()
  vt.sendInput('\x1b[27;2;80~') // modifyOtherKeys shift+P → 'P'
  await vt.waitForRender()
  assert.equal(model.state().editBuffer, 'P', `the modifyOtherKeys printable must land`)
  vt.sendInput('\r') // commit
  await vt.waitForRender()
  assert.equal(model.preview().rows[0]!.left.find(ref => ref.id === 'model')!.prefix, 'P')
  app.stop()
})

test('resizing the terminal LARGER after opening does not clip the configurator', async () => {
  // The overlay's maxHeight used to be a NUMBER captured at open time:
  // opening at 40x10 clamped it to 10 rows forever, so growing to 80x40
  // let the panel re-budget itself (it thinks the active item is in its
  // viewport) while the overlay hard-cut the output to 10 rows — slicing
  // off the editable body, the preview tail and the bottom border.
  // maxHeight is a live '100%' now.
  const vt = new VirtualTerminal(40, 10)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setStatus({ model: 'deepseek/flash', cwd: '/home/x/proj' })
  openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  for (let i = 0; i < 32; i += 1) vt.sendInput('\x1b[B') // → the last item
  await vt.waitForRender()
  vt.resize(80, 40)
  await vt.waitForRender()
  const view = vt.getViewport()
  const text = view.join('\n')
  const lastNonEmpty = [...view].reverse().find(line => line.trim() !== '')
  assert.ok(lastNonEmpty !== undefined && lastNonEmpty.includes('╰'),
    `the Frame bottom border must survive the resize:\n${text}`)
  assert.ok(text.includes('Extension items'), `the active item must be visible after the resize:\n${text}`)
  assert.ok(text.includes('Preview'), `the preview must stay visible after the resize:\n${text}`)
  assert.ok(text.includes('A Add'), `the help must stay visible after the resize:\n${text}`)
  app.stop()
})

test('a legal-but-unlisted persisted tone displays as ITSELF (never Auto)', async () => {
  // The parser accepts all 12 semantic tones; the picker deliberately
  // exposes 8. A hand-written `tone: textStrong` must not collapse into
  // the 'Auto' display (the old fallback) — and applying the picker's
  // own current row must not silently DELETE the persisted token.
  const { vt, app } = startApp()
  const model = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'model', tone: 'textStrong' }], right: [] }],
  }, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: () => {},
    onCancel: () => {},
  })
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  vt.sendInput('\r') // → item editor (model: Style, Tone, Advanced)
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // → Tone
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Strong'), `the persisted token must display as itself:\n${view}`)
  assert.ok(!view.includes('Auto'), `the unlisted tone must not display as Auto:\n${view}`)
  // Enter opens the tone picker ON the persisted token (marked current):
  // applying its own row keeps the token.
  vt.sendInput('\r')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Strong  (current)'), `the picker must list and mark the persisted token:\n${view}`)
  vt.sendInput('\r') // apply the highlighted (persisted) choice
  await vt.waitForRender()
  assert.equal(model.preview().rows[0]!.left.find(ref => ref.id === 'model')!.tone, 'textStrong',
    'applying the persisted token\'s own row must keep the token')
  // The inline ←→ cycle includes the unlisted token: ← from Strong wraps
  // to the last LISTED tone (Error).
  vt.sendInput('\x1b[D')
  await vt.waitForRender()
  assert.equal(model.preview().rows[0]!.left.find(ref => ref.id === 'model')!.tone, 'error',
    'cycling ← from the unlisted token wraps to the last listed one')
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

test('KNOWN-item ref fields are sanitized too (prefix/suffix/format display boundaries)', async () => {
  const { vt, app } = startApp()
  // The item must actually RENDER in the preview (a model badge needs a
  // model in the snapshot).
  app.setStatus({ model: 'deepseek/flash', cwd: '/home/x/proj' })
  // The parser rejects control characters in ids/prefix/suffix but
  // ACCEPTS unknown format strings, and the model accepts any
  // FooterLayoutV1 — the panel is the last display boundary, so a
  // hand-built ref must not paint ESC/OSC sequences through the style
  // column, the item preview or the pickers.
  const model = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{
      left: [{
        id: 'model',
        prefix: 'P\u001b]52;c;bWFsaWNpb3Vz\u0007',
        suffix: 'S\u001b[2J',
        format: 'ba\u001bdge',
      }],
      right: [],
    }],
  }, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: () => {},
    onCancel: () => {},
  })
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1 (the style column shows the format)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\u001b'), `an ESC must never reach the row page:\n${view}`)
  assert.ok(!view.includes('\u0007'), `a BEL must never reach the row page:\n${view}`)
  assert.ok(view.includes('Badge'), `the sanitized style keeps its readable text:\n${view}`)
  // The item editor's preview renders the DECORATED item (prefix/suffix
  // applied): the same strip must hold there.
  vt.sendInput('\r')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\u001b') && !view.includes('\u0007'), `the item pages must sanitize the decoration too:\n${view}`)
  assert.ok(view.includes('bWFsaWNpb3Vz'), `the readable prefix residue stays visible:\n${view}`)
  app.stop()
})

test('a definition that ECHOES the ref format cannot paint control sequences (span strip)', async () => {
  const { vt, app } = startApp()
  app.setStatus({ model: 'deepseek/flash', cwd: '/home/x/proj' })
  // The parser ACCEPTS unknown format strings and a definition receives
  // the ref verbatim: a hostile (or merely buggy) definition that echoes
  // ref.format into its span text must not paint ESC/OSC into the item
  // preview or the style examples — the display boundary strips every
  // span's text.
  const registry = app.getFooterItemRegistry()
  registry.register({
    id: 'echo',
    label: 'Echo',
    description: 'echoes the format into its span',
    defaultZone: 'left',
    defaultImportance: 50,
    formats: ['plain', 'ba\u001bdge'],
    defaultFormat: 'plain',
    render(_snapshot, ref) {
      return { spans: [{ text: `fmt=${ref.format ?? 'plain'}` }] }
    },
  })
  const model = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'echo', format: 'ba\u001bdge' }], right: [] }],
  }, registry)
  app.openFooterConfigurator({
    model,
    registry,
    onSave: () => {},
    onCancel: () => {},
  })
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1 (single item)
  await vt.waitForRender()
  vt.sendInput('\r') // → the item editor (the preview renders the echo)
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('\u001b'), `a format echoed into a span must be stripped:\n${view}`)
  assert.ok(view.includes('fmt=badge'), `the sanitized echo keeps its readable text:\n${view}`)
  app.stop()
})

test('the whole-footer composer preview is sanitized too (SGR survives, OSC/CSI stripped)', async () => {
  // The rows/row/add pages compose the preview through the REAL
  // FooterComposer. A hand-built draft can carry prefix/suffix fields the
  // persisted-layout parser would have rejected: the composed lines must
  // pass the command mode's sanitize boundary — legitimate SGR styling
  // survives, OSC/CSI/C0 never reaches the panel. The assertion inspects
  // the PANEL RENDER output directly (not the terminal viewport).
  const { FooterConfiguratorPanel } = await import('../src/footer/configurator.ts')
  const { FooterComposer } = await import('../src/footer/composer.ts')
  const { createBuiltinFooterRegistry } = await import('../src/footer/builtin-items.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setStatus({ model: 'deepseek/flash', cwd: '/home/x/proj' })
  const model = new FooterConfiguratorModel({
    schemaVersion: 1,
    rows: [{
      left: [{ id: 'model', prefix: '\u001b]52;c;bWFsaWNpb3Vz\u0007P', suffix: 'S\u001b[2J\u001b[?25h' }],
      right: [],
    }],
  }, app.getFooterItemRegistry())
  const panel = new FooterConfiguratorPanel({
    model,
    registry: app.getFooterItemRegistry(),
    snapshot: () => (app as unknown as { statusStore: { snapshot(): StatusSnapshot } }).statusStore.snapshot(),
    composer: new FooterComposer(createBuiltinFooterRegistry()),
    taskBrowserAvailable: () => true,
    extensionFooterText: () => '',
    maxVisible: () => 100,
    onSave: () => {},
    onCancel: () => {},
  })
  const rendered = panel.render(100).join('\n')
  assert.ok(!rendered.includes('\u0007'), `a BEL must never reach the panel:\n${rendered}`)
  assert.ok(!rendered.includes('\u001b]52'), `an OSC 52 clipboard write must never reach the panel:\n${rendered}`)
  assert.ok(!rendered.includes('\u001b[2J'), `a CSI screen clear must never reach the panel:\n${rendered}`)
  assert.ok(!rendered.includes('\u001b[?25h'), `a CSI cursor show must never reach the panel:\n${rendered}`)
  assert.ok(rendered.includes('[deepseek/flash]'), `the item must still render (sanitized):\n${rendered}`)
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
      // THE key guarantee: the EDITABLE body survives — the cursor's item
      // (the last one: Extension items) must be on screen, never eaten by
      // the fixed preview.
      assert.ok(text.includes('Extension items'), `the active item must stay visible at ${cols}x${rows}:\n${text}`)
      // A long label must not break the layout (ANSI-safe truncation).
      assert.ok(!text.split('\n').some(line => line.length > cols + 20), `no line may overflow the frame at ${cols}x${rows}`)
      app.stop()
    })
  }
}

test('a 4-physical-row preview cannot eat the editable body (10-row terminal)', async () => {
  // The footer composer legally wraps a status row into up to 4 physical
  // rows: with the OLD shell-wins budget a 10-row terminal could spend
  // its entire budget on title/help/preview and show ZERO editable rows.
  // A very long model id forces the deterministic 4-row wrap.
  const vt = new VirtualTerminal(40, 10)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  app.setStatus({ model: `a-very-long-model-name/${'x'.repeat(120)}`, cwd: '/home/x/proj' })
  const model = openDefault(app)
  await vt.waitForRender()
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  for (let i = 0; i < 32; i += 1) vt.sendInput('\x1b[B') // → the last item
  await vt.waitForRender()
  const view = vt.getViewport()
  const text = view.join('\n')
  assert.ok(text.includes('A Add'), `the help must stay visible:\n${text}`)
  assert.ok(text.includes('Preview'), `the preview must stay visible:\n${text}`)
  assert.ok(text.includes('Extension items'), `the ACTIVE item must stay visible (the body must never be eaten):\n${text}`)
  app.stop()
})

/* ─── PR E: explicit save flow + unsaved-exit guard ──────────────────── */

/** Flush pending microtasks (save-promise chains) without a fixed delay. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
  await new Promise<void>(resolve => setImmediate(resolve))
}

function openWith(
  app: TuiApp,
  hooks: { onSave?: () => void | Promise<void>; onCancel?: () => void } = {},
): FooterConfiguratorModel {
  const model = new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, app.getFooterItemRegistry())
  app.openFooterConfigurator({
    model,
    registry: app.getFooterItemRegistry(),
    onSave: hooks.onSave ?? (() => {}),
    onCancel: hooks.onCancel ?? (() => {}),
  })
  return model
}

/** Enter the row, remove the first item, walk back: a reliably dirty draft
 * sitting on the Row Selector. */
async function makeDirty(vt: VirtualTerminal): Promise<void> {
  vt.sendInput('\r') // → Edit Row 1
  await vt.waitForRender()
  vt.sendInput(' ') // remove the cursor's item
  await vt.waitForRender()
  vt.sendInput('\x1b') // → selector (dirty)
  await vt.waitForRender()
}

test('PR E: the selector advertises Save changes with Unsaved / No changes', async () => {
  const { vt, app } = startApp()
  openWith(app)
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Save changes'), `the save action missing:\n${view}`)
  assert.ok(view.includes('No changes'), `the clean status missing:\n${view}`)
  await makeDirty(vt)
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Unsaved'), `the dirty status missing:\n${view}`)
  app.stop()
})

test('PR E: Enter on Save changes saves and closes the configurator', async () => {
  const { vt, app } = startApp()
  let saved = 0
  let cancelled = 0
  openWith(app, { onSave: () => { saved += 1 }, onCancel: () => { cancelled += 1 } })
  await vt.waitForRender()
  await makeDirty(vt)
  vt.sendInput('\x1b[B') // ↓ Row 2
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // ↓ Save changes
  await vt.waitForRender()
  vt.sendInput('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(saved, 1, 'Enter on the Save action saves')
  assert.equal(cancelled, 0)
  const view = vt.getViewport().join('\n')
  assert.ok(!view.includes('Configure Footer'), `a successful save closes the configurator:\n${view}`)
  app.stop()
})

test('PR E: dirty Esc opens the exit guard; Esc there keeps editing', async () => {
  const { vt, app } = startApp()
  let cancelled = 0
  openWith(app, { onCancel: () => { cancelled += 1 } })
  await vt.waitForRender()
  await makeDirty(vt)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Save changes before exiting?'), `the guard missing:\n${view}`)
  assert.ok(view.includes('Save & Exit') && view.includes('Discard & Exit') && view.includes('Keep Editing'),
    `the three actions missing:\n${view}`)
  assert.equal(cancelled, 0, 'the guard must not close')
  vt.sendInput('\x1b')
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Select row to edit'), 'Esc in the guard keeps editing')
  assert.ok(view.includes('Unsaved'), 'the draft stays dirty')
  assert.equal(cancelled, 0)
  app.stop()
})

test('PR E: Save & Exit saves; Discard & Exit closes without saving', async () => {
  // Save & Exit.
  {
    const { vt, app } = startApp()
    let saved = 0
    let cancelled = 0
    openWith(app, { onSave: () => { saved += 1 }, onCancel: () => { cancelled += 1 } })
    await vt.waitForRender()
    await makeDirty(vt)
    vt.sendInput('\x1b')
    await vt.waitForRender()
    vt.sendInput('\r') // Save & Exit (cursor 0)
    await settle()
    await vt.waitForRender()
    assert.equal(saved, 1)
    assert.equal(cancelled, 0)
    assert.ok(!vt.getViewport().join('\n').includes('Configure Footer'), 'the overlay closed after success')
    app.stop()
  }
  // Discard & Exit.
  {
    const { vt, app } = startApp()
    let saved = 0
    let cancelled = 0
    openWith(app, { onSave: () => { saved += 1 }, onCancel: () => { cancelled += 1 } })
    await vt.waitForRender()
    await makeDirty(vt)
    vt.sendInput('\x1b')
    await vt.waitForRender()
    vt.sendInput('\x1b[B') // → Discard & Exit
    await vt.waitForRender()
    vt.sendInput('\r')
    await settle()
    await vt.waitForRender()
    assert.equal(saved, 0, 'discard never persists')
    assert.equal(cancelled, 1, 'discard closes via onCancel')
    assert.ok(!vt.getViewport().join('\n').includes('Configure Footer'), 'the overlay closed')
    app.stop()
  }
})

test('PR E: Keep Editing returns to the selector with the draft intact', async () => {
  const { vt, app } = startApp()
  let saved = 0
  let cancelled = 0
  const model = openWith(app, { onSave: () => { saved += 1 }, onCancel: () => { cancelled += 1 } })
  await vt.waitForRender()
  await makeDirty(vt)
  const draftBefore = JSON.stringify(model.preview())
  vt.sendInput('\x1b')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\x1b[B') // → Keep Editing
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Select row to edit'), 'back on the selector')
  assert.equal(saved, 0)
  assert.equal(cancelled, 0)
  assert.equal(JSON.stringify(model.preview()), draftBefore, 'the draft is untouched')
  app.stop()
})

test('PR E: a failed save keeps the configurator open with the draft dirty', async () => {
  const { vt, app } = startApp()
  let attempts = 0
  let cancelled = 0
  let fail = true
  openWith(app, {
    onSave: async () => {
      attempts += 1
      if (fail) throw new Error('write failed')
    },
    onCancel: () => { cancelled += 1 },
  })
  await vt.waitForRender()
  await makeDirty(vt)
  vt.sendInput('s')
  await settle()
  await vt.waitForRender()
  assert.equal(attempts, 1)
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Configure Footer'), `a failed save keeps the editor open:\n${view}`)
  assert.ok(view.includes('Unsaved'), 'the draft stays dirty')
  // The retry succeeds.
  fail = false
  vt.sendInput('s')
  await settle()
  await vt.waitForRender()
  assert.equal(attempts, 2)
  assert.ok(!vt.getViewport().join('\n').includes('Configure Footer'), 'the successful retry closes')
  assert.equal(cancelled, 0)
  app.stop()
})

test('PR E: a save in flight refuses duplicate saves and Esc-close', async () => {
  const { vt, app } = startApp()
  let attempts = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  openWith(app, { onSave: () => { attempts += 1; return gate } })
  await vt.waitForRender()
  await makeDirty(vt)
  vt.sendInput('s')
  await settle()
  vt.sendInput('s') // duplicate — refused by the saving guard
  await settle()
  vt.sendInput('\x1b') // must not close mid-save either
  await settle()
  assert.equal(attempts, 1, 'only one persistence call')
  release?.()
  await settle()
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('Configure Footer'), 'the gated save still closes on success')
  app.stop()
})

test('PR E: the exit guard keeps all three actions visible at 40x10', async () => {
  const vt = new VirtualTerminal(40, 10)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  let cancelled = 0
  openWith(app, { onCancel: () => { cancelled += 1 } })
  await vt.waitForRender()
  await makeDirty(vt)
  vt.sendInput('\x1b')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Save changes before exiting?'), `the question must be visible:\n${view}`)
  assert.ok(view.includes('Save & Exit'), `Save & Exit must be visible:\n${view}`)
  assert.ok(view.includes('Discard & Exit'), `Discard & Exit must be visible:\n${view}`)
  assert.ok(view.includes('Keep Editing'), `Keep Editing must be visible:\n${view}`)
  assert.ok(view.includes('╰'), 'the frame must survive')
  assert.equal(cancelled, 0)
  app.stop()
})

test('PR E: a clean draft closes WITHOUT persisting (Save changes / S)', async () => {
  const { vt, app } = startApp()
  let saved = 0
  let closed = 0
  openWith(app, { onSave: () => { saved += 1 }, onCancel: () => { closed += 1 } })
  await vt.waitForRender()
  // ↓ ↓ lands on Save changes. Enter with NOTHING edited must close
  // without a save (plan §12: skip the meaningless settings replace — an
  // idle save must never flip the active default/compact footer to
  // custom).
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\x1b[B')
  await vt.waitForRender()
  vt.sendInput('\r')
  await settle()
  await vt.waitForRender()
  assert.equal(saved, 0, 'a clean save must not persist')
  assert.equal(closed, 1, 'the configurator closed as the save outcome')
  assert.ok(!vt.getViewport().join('\n').includes('Configure Footer'))
  app.stop()
})

test('PR E: S on a clean draft closes without persisting', async () => {
  const { vt, app } = startApp()
  let saved = 0
  let closed = 0
  openWith(app, { onSave: () => { saved += 1 }, onCancel: () => { closed += 1 } })
  await vt.waitForRender()
  vt.sendInput('s')
  await settle()
  await vt.waitForRender()
  assert.equal(saved, 0, 'the clean S shortcut must not persist')
  assert.equal(closed, 1)
  assert.ok(!vt.getViewport().join('\n').includes('Configure Footer'))
  app.stop()
})

test('PR E: closing during an in-flight save is safe (no unhandled rejection)', async () => {
  const vt = new VirtualTerminal(100, 30)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  let attempts = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const close = app.openFooterConfigurator({
    model: new FooterConfiguratorModel(DEFAULT_FOOTER_LAYOUT, app.getFooterItemRegistry()),
    registry: app.getFooterItemRegistry(),
    onSave: () => { attempts += 1; return gate },
    onCancel: () => {},
  })
  await vt.waitForRender()
  await makeDirty(vt)
  vt.sendInput('s')
  await settle()
  assert.equal(attempts, 1)
  close() // e.g. a session switch disposes the overlay mid-write
  release?.()
  await settle()
  await settle()
  await vt.waitForRender()
  app.stop()
})

test('PR E: the Save row stays visible at 40x10 and Saving… survives a resize', async () => {
  const vt = new VirtualTerminal(40, 10)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  let attempts = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  openWith(app, { onSave: () => { attempts += 1; return gate } })
  await vt.waitForRender()
  await makeDirty(vt)
  let view = vt.getViewport().join('\n')
  assert.ok(view.includes('Save changes'), `the save action must be visible at 40x10:\n${view}`)
  assert.ok(view.includes('Unsaved'), `the dirty status must be visible at 40x10:\n${view}`)
  vt.sendInput('s')
  await settle()
  vt.resize(80, 24)
  await vt.waitForRender()
  view = vt.getViewport().join('\n')
  assert.ok(view.includes('Saving…'), `Saving… must survive a resize mid-save:\n${view}`)
  release?.()
  await settle()
  await vt.waitForRender()
  assert.ok(!vt.getViewport().join('\n').includes('Configure Footer'), 'the released save closes on success')
  app.stop()
})
// ── PR D: custom command item UI ─────────────────────────────────────────

/** Open the configurator with a draft catalog whose value source mirrors
 * the real /footer wiring (commands.ts): the committed cache shows ONLY
 * while the draft definition is unchanged, the dim [command] placeholder
 * otherwise. */
function openWithCommand(
  app: TuiApp,
  committed: readonly import('../src/footer/custom-items.ts').FooterCustomItemSettings[],
  draft?: import('../src/footer/custom-items.ts').FooterCustomItemCatalog,
): void {
  const registry = new FooterItemRegistry(app.getFooterItemRegistry())
  const customItems = draft ?? new FooterCustomItemCatalog(committed)
  customItems.setCommandValueSource({
    value: (id) => {
      const d = customItems.get(id)
      if (d === undefined || d.kind !== 'command') return undefined
      const c = committed.find(item => item.id === id)
      if (c === undefined || !sameFooterCustomItem(d, c)) return { kind: 'placeholder' }
      const text = app.getFooterCommandItemValue(id)
      return text === undefined ? { kind: 'placeholder' } : { kind: 'value', text }
    },
  })
  registry.setCustomSource(customItems)
  const model = new FooterConfiguratorModel(
    { schemaVersion: 1, rows: [{ left: [{ id: 'user:clock' }], right: [] }] },
    registry,
    customItems,
  )
  app.openFooterConfigurator({
    model,
    registry,
    composer: new FooterComposer(registry),
    onSave: () => {},
    onCancel: () => {},
  })
}

test('PR D: the Add picker offers Create Custom Command and the flow creates + previews it', async () => {
  const { vt, app } = startApp()
  openWithCommand(app, [])
  await vt.waitForRender()
  vt.sendInput('\r') // row
  vt.sendInput('a') // add
  vt.sendInput('no-match')
  await vt.waitForRender()
  const addView = vt.getViewport().join('\n')
  assert.ok(addView.includes('+ Create Custom Text'), `the text create action must stay:\n${addView}`)
  assert.ok(addView.includes('+ Create Custom Command'), `the command create action must appear:\n${addView}`)
  assert.ok(addView.includes('Create a user-defined static footer item.'))
  vt.sendInput('\x1b[B') // down: Create Custom Command
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('Create a user-defined command item.'))
  vt.sendInput('\r') // create-name
  vt.sendInput('Clock')
  vt.sendInput('\r') // create-command
  vt.sendInput('date +%H:%M')
  vt.sendInput('\r') // create-refresh (opens on the 5s default)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('Refresh'))
  vt.sendInput('\r') // create-timeout (opens on the 300ms default)
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('Timeout'))
  vt.sendInput('\r') // create-tone
  vt.sendInput('\r') // create with Auto
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Clock'), `the created item must appear in the row:\n${view}`)
  assert.ok(view.includes('[command]'), `the draft command preview must show the dim placeholder:\n${view}`)
  app.stop()
})

test('PR D: the item editor exposes Command/Refresh/Timeout for a command item', async () => {
  const { vt, app } = startApp()
  openWithCommand(app, [{ schemaVersion: 1 as const, id: 'user:clock', kind: 'command' as const, command: 'date +%H:%M' }])
  await vt.waitForRender()
  vt.sendInput('\r') // row
  vt.sendInput('\r') // item
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('Command'), `the command editor entry missing:\n${view}`)
  assert.ok(view.includes('Refresh'), `the refresh entry missing:\n${view}`)
  assert.ok(view.includes('Timeout'), `the timeout entry missing:\n${view}`)
  assert.ok(view.includes('Default tone'), `the definition tone entry missing:\n${view}`)
  assert.ok(view.includes('Rename definition'), `the rename entry missing:\n${view}`)
  assert.ok(view.includes('Delete definition'), `the delete entry missing:\n${view}`)
  app.stop()
})

test('PR D: the preview shows the dim [command] placeholder for a draft and the committed cache when unchanged', async () => {
  const { vt, app } = startApp()
  const committed = [{ schemaVersion: 1 as const, id: 'user:clock', kind: 'command' as const, command: 'date +%H:%M' }]
  openWithCommand(app, committed)
  await vt.waitForRender()
  // No committed cache yet: the row preview shows the placeholder.
  assert.ok(vt.getViewport().join('\n').includes('[command]'), 'the draft preview must show the placeholder')
  // The runtime commits a cache: the unchanged draft now shows the value.
  app.setFooterCommandItemValue('user:clock', '14:30')
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('14:30'), `the committed cache must preview:\n${view}`)
  assert.ok(!view.includes('[command]'), 'the placeholder must disappear once the cache exists')
  app.stop()
})

test('PR D: a modified draft command never shows the old committed cache', async () => {
  const { vt, app } = startApp()
  const committed = [{ schemaVersion: 1 as const, id: 'user:clock', kind: 'command' as const, command: 'date +%H:%M' }]
  const draft = new FooterCustomItemCatalog(committed)
  openWithCommand(app, committed, draft)
  app.setFooterCommandItemValue('user:clock', '14:30')
  await vt.waitForRender()
  assert.ok(vt.getViewport().join('\n').includes('14:30'))
  // Edit the command in the draft: the preview must fall back to the
  // placeholder — never pretend the old cache is the new command's result.
  vt.sendInput('\r') // row
  vt.sendInput('\r') // item
  vt.sendInput('\r') // Command editor
  vt.sendInput('!')
  vt.sendInput('\r') // commit
  await vt.waitForRender()
  const view = vt.getViewport().join('\n')
  assert.ok(view.includes('[command]'), `a modified draft must show the placeholder:\n${view}`)
  assert.ok(!view.includes('14:30'), 'the stale cache must not be shown for a modified draft')
  app.stop()
})
