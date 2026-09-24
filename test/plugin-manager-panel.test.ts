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
