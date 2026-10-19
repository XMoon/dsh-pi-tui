/**
 * Plugin Manager panel tests (P1-A1): the panel is rendering/input only. It
 * must draw the classified sections, the install dialog phases and the
 * message line, and forward semantic keys to the controller.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-panel.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PluginManagerController } from '../src/app/plugin-manager/controller.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { PluginManagerPanel } from '../src/tui/plugin-manager/panel.ts'
import { SELF_BUNDLE } from '../src/app/plugin-manager/classify.ts'
import type { PluginManagerPort, PluginManagerSnapshot } from '../src/runtime/plugin-manager-port.ts'

const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')

function snapshot(): PluginManagerSnapshot {
  return {
    bundles: [
      { name: SELF_BUNDLE, version: '0.4.8', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [] },
      { name: 'ordinary', enabled: false, installed: true, optional: false, removable: true, rows: [], overrides: [] },
    ],
    plugins: [],
    registries: { registry: 'https://r', fallbackRegistries: [], resolved: null },
    exemptions: [],
    exemptionWarnings: [],
  }
}

function port(): PluginManagerPort {
  return {
    snapshot: async () => snapshot(),
    inspect: async () => ({ status: 'accepted', kind: 'registry', name: 'pkg', version: '1', bundle: true, registry: null }),
    setBundleEnabled: async () => ({ changed: true, application: 'applied', stage: 'enable', target: '' }),
    setPluginEnabled: async () => ({ changed: true, application: 'applied', stage: 'enable', target: '' }),
    removeBundle: async () => ({ changed: true, application: 'applied', stage: 'remove', target: '' }),
    startInstall: async () => ({ changed: true, application: 'applied', stage: 'install', target: '' }),
    waitForInstall: async () => null,
    cancelInstall: async () => ({ status: 'not-running' }),
    subscribeInstall: () => () => {},
    subscribeInvalidation: () => () => {},
  }
}

async function ready(): Promise<{ controller: PluginManagerController; panel: PluginManagerPanel }> {
  const controller = new PluginManagerController(port(), {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  const panel = new PluginManagerPanel(controller, () => {})
  panel.focused = true
  panel.setMaxRows(30)
  controller.open('direct-command')
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  return { controller, panel }
}

test('renders the three classified sections with the Current TUI card protected', async () => {
  const { panel } = await ready()
  const text = panel.render(90).map(strip).join('\n')
  assert.match(text, /Current TUI/)
  assert.match(text, /DSH Plugins/)
  assert.match(text, /0\.4\.8/)
  assert.match(text, /Install…/)
  assert.match(text, /Refresh/)
  // Self card is shown, but its detail never offers Enable/Disable.
  assert.match(text, /\[active\]/)
})

test('navigation and Esc forward to the controller', async () => {
  const { controller, panel } = await ready()
  const first = controller.selectedValue()
  assert.ok(first !== undefined)
  panel.handleInput('\x1b[B') // down
  assert.notEqual(controller.selectedValue(), first)
  panel.handleInput('\r') // open detail
  assert.match(strip(panel.render(90).join('\n')), /Plugin Manager · /)
  panel.handleInput('\x1b') // back
  assert.match(strip(panel.render(90).join('\n')), /Current TUI/)
})

test('the install dialog renders the spec field, registry and then the inspection', async () => {
  const { controller, panel } = await ready()
  controller.openInstall()
  const editing = panel.render(90).map(strip).join('\n')
  assert.match(editing, /Spec/)
  assert.match(editing, /Reg/)
  assert.match(editing, /pnpm configuration default/)
  panel.handleInput('\r') // inspect with an empty spec → message
  assert.match(strip(panel.render(90).join('\n')), /Enter a package spec first/)
})

test('a long list keeps the selected row visible (selection-aware viewport)', async () => {
  const plugins = Array.from({ length: 40 }, (_, index) => ({
    entryId: `e-${index}`,
    moduleName: `plugin-${String(index).padStart(2, '0')}`,
    enabled: true,
    fiberPhase: 'active',
    patchId: `p-${index}`,
  }))
  const longPort: PluginManagerPort = {
    ...port(),
    snapshot: async () => ({
      bundles: [],
      plugins,
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
  }
  const controller = new PluginManagerController(longPort, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  const panel = new PluginManagerPanel(controller, () => {})
  panel.setMaxRows(10)
  controller.open('direct-command')
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))

  const assertSelectedVisible = (): void => {
    const value = controller.selectedValue()
    const row = controller.rows().find(candidate => candidate.value === value)
    assert.ok(row !== undefined)
    const label = strip(row.label).replace(/…$/, '').trim().slice(0, 12)
    const rendered = panel.render(80)
    const view = strip(rendered.join('\n'))
    assert.ok(view.includes(label), `selected "${label}" must stay visible:\n${view}`)
    assert.ok(rendered.length <= 10, 'the frame must respect maxRows')
  }

  assertSelectedVisible()
  for (let i = 0; i < 60; i += 1) {
    panel.handleInput('\x1b[B')
    assertSelectedVisible()
  }
  // The very end (an action row) is reachable and visible.
  assert.equal(controller.selectedValue(), 'action:close')
  for (let i = 0; i < 60; i += 1) {
    panel.handleInput('\x1b[A')
    assertSelectedVisible()
  }
  assert.equal(controller.selectedValue(), 'entry:e-0')
  const clipped = strip(panel.render(80).join('\n'))
  assert.match(clipped, /↓ more/)

  // A very short grant must never overflow: the frame is clamped (indicators
  // suppressed) even at maxRows 1..5 and 10.
  for (const rows of [1, 2, 3, 4, 5, 10]) {
    panel.setMaxRows(rows)
    const rendered = panel.render(80)
    assert.ok(rendered.length <= rows, `maxRows ${rows} must not overflow (got ${rendered.length})`)
    // The selection is still present whenever a body row fits.
    const value = controller.selectedValue()
    const row = controller.rows().find(candidate => candidate.value === value)
    if (rows >= 2 && row !== undefined) {
      const label = strip(row.label).replace(/…$/, '').trim().slice(0, 12)
      assert.ok(strip(rendered.join('\n')).includes(label), `maxRows ${rows} must keep the selection visible`)
    }
  }
})

test('an external dispose notifies the host exactly once and never closes it', async () => {
  const { controller } = await ready()
  let disposed = 0
  const panel = new PluginManagerPanel(controller, () => {}, { onDispose: () => { disposed += 1 } })
  // A surface-level teardown (Settings parent hidden) disposes the panel
  // without invoking any user close path.
  panel.dispose()
  panel.dispose()
  assert.equal(disposed, 1, 'onDispose fires exactly once')
  // The panel is inert afterwards.
  panel.handleInput('\r')
  assert.equal(disposed, 1)
})

test('hostile plugin metadata is projected before painting (no raw terminal control)', async () => {
  const hostile = 'evil\u001b]52;c;YXR0YWNr\u0007\u001b[2J\u009b2Jname'
  const hostilePort: PluginManagerPort = {
    ...port(),
    snapshot: async () => ({
      bundles: [],
      plugins: [{ entryId: 'e-x', moduleName: hostile, enabled: true, fiberPhase: 'active', patchId: 'p-x' }],
      registries: { registry: null, fallbackRegistries: [], resolved: null },
      exemptions: [],
      exemptionWarnings: [],
    }),
  }
  const controller = new PluginManagerController(hostilePort, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  const panel = new PluginManagerPanel(controller, () => {})
  panel.setMaxRows(30)
  controller.open('direct-command')
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))

  const rendered = panel.render(90)
  const text = strip(rendered.join('\n'))
  assert.ok(text.includes('evil'), `the safe plugin identity survives:\n${text}`)
  assert.ok(!text.includes('YXR0YWNr'), `no OSC payload is painted:\n${text}`)
  assert.ok(!rendered.join('').includes('\u009b'), 'no raw C1 byte reaches the frame')
  assert.ok(!rendered.join('').includes('\u001b]52'), 'no raw OSC introducer reaches the frame')
})

test('hostile package metadata is folded onto ONE physical row per list/detail field', async () => {
  // LF, CRLF, TAB and an OSC payload in package-name/title/description/registry
  // metadata: every one of them is a single-row field, so none may smuggle a
  // row break (or its payload) into the panel's row budget.
  const hostile = 'First\nSecond\r\nThird\tTabbed\u001b]52;c;YXR0YWNr\u0007tail'
  const collapsed = 'First Second Third   Tabbedtail'
  const hostilePort: PluginManagerPort = {
    ...port(),
    snapshot: async () => ({
      bundles: [{
        name: hostile,
        version: '1.0',
        title: hostile,
        description: hostile,
        enabled: true,
        installed: true,
        optional: false,
        removable: true,
        rows: [{ rowId: 'r1', moduleName: hostile, title: hostile, description: hostile, entryId: 'e1' }],
        overrides: [hostile],
      }],
      plugins: [],
      registries: { registry: hostile, fallbackRegistries: [], resolved: hostile },
      exemptions: [],
      exemptionWarnings: [hostile],
    }),
  }
  const controller = new PluginManagerController(hostilePort, {
    requestRender: () => {},
    requestClose: () => {},
    notify: () => {},
    isOpen: () => true,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
  }, { observations: () => [] })
  const panel = new PluginManagerPanel(controller, () => {})
  panel.setMaxRows(40)
  controller.open('direct-command')
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  await new Promise<void>(resolve => setTimeout(resolve, 0))

  const assertPhysicalRows = (rendered: readonly string[], where: string): string => {
    const text = rendered.map(strip).join('\n')
    for (const line of rendered) {
      assert.ok(!line.includes('\n') && !line.includes('\r'),
        `${where}: a rendered row carries an embedded line break: ${JSON.stringify(line)}`)
      assert.ok(!line.includes('YXR0YWNr'), `${where}: the OSC payload reaches a row`)
      assert.ok(!line.includes('\u009b'), `${where}: a raw C1 byte reaches a row`)
      assert.ok(!line.includes('\u001b]52'), `${where}: a raw OSC introducer reaches a row`)
    }
    return text
  }

  const listText = assertPhysicalRows(panel.render(200), 'list')
  assert.ok(listText.includes(collapsed), `the collapsed list metadata survives:\n${listText}`)

  controller.activate() // the hostile card is the only selectable row
  const detailText = assertPhysicalRows(panel.render(200), 'detail')
  assert.ok(detailText.includes(collapsed), `the collapsed detail metadata survives:\n${detailText}`)
})
