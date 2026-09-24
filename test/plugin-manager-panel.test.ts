/**
 * Plugin Manager panel tests (P1-A1): the panel is rendering/input only. It
 * must draw the classified sections, the install dialog phases and the
 * message line, and forward semantic keys to the controller.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-panel.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { PluginManagerController } from '../src/plugin-manager/controller.ts'
import { createDiag } from '../src/diag.ts'
import { PluginManagerPanel } from '../src/plugin-manager/panel.ts'
import { SELF_BUNDLE } from '../src/plugin-manager/classify.ts'
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
  // suppressed) even at maxRows 1..6.
  for (let rows = 1; rows <= 6; rows += 1) {
    panel.setMaxRows(rows)
    assert.ok(panel.render(80).length <= rows, `maxRows ${rows} must not overflow`)
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
