/**
 * Presentation-classification and self-protection tests (P1-A1/A2):
 *  - Current TUI is exactly `@xmoon76/dsh-pi-tui`, appears once, and its
 *    effective capabilities are narrowed without forging Host facts.
 *  - TUI Extensions require an exact + UNIQUE live-owner association; a name
 *    heuristic never classifies, and an ambiguous owner falls back.
 *  - One bundle produces exactly one card.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-classify.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SELF_BUNDLE, classifyPluginPackages, type PluginClassificationInput } from '../src/plugin-manager/classify.ts'
import type { TuiExtensionObservation } from '../src/plugin-manager/extension-inventory.ts'
import {
  buildPluginManagerModel,
  bundleValue,
  entryValue,
} from '../src/plugin-manager/model.ts'
import type { PluginBundleFact, PluginManagerSnapshot, PluginRowFact } from '../src/runtime/plugin-manager-port.ts'

function observation(overrides: Partial<TuiExtensionObservation> = {}): TuiExtensionObservation {
  return {
    owner: '1:mine',
    ownerName: 'mine',
    contributionKinds: ['chrome.footer.item'],
    contributionCount: 1,
    health: 'active',
    usesAdvancedCapability: false,
    usesUnstableCapability: false,
    ...overrides,
  }
}

function bundle(overrides: Partial<PluginBundleFact> = {}): PluginBundleFact {
  return {
    name: 'ordinary',
    enabled: true,
    installed: true,
    optional: false,
    removable: true,
    rows: [],
    overrides: [],
    ...overrides,
  }
}

function row(overrides: Partial<PluginRowFact> = {}): PluginRowFact {
  return {
    entryId: 'e1',
    moduleName: 'm1',
    enabled: true,
    fiberPhase: 'active',
    ...overrides,
  }
}

function snapshot(bundles: PluginBundleFact[], plugins: PluginRowFact[]): PluginManagerSnapshot {
  return {
    bundles,
    plugins,
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: [],
    exemptionWarnings: [],
  }
}

function inputs(list: readonly { key: string; bundleName?: string; identities: readonly string[] }[]): PluginClassificationInput[] {
  return list.map(item => ({ ...item }))
}

test('SELF_BUNDLE always classifies as current-tui, even with a matching observation', () => {
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, identities: [SELF_BUNDLE] }]),
    [observation({ ownerName: SELF_BUNDLE, entryId: SELF_BUNDLE })],
  )
  assert.equal(claims.get(bundleValue(SELF_BUNDLE))?.role, 'current-tui')
  assert.equal(claims.get(bundleValue(SELF_BUNDLE))?.observation, undefined)
})

test('an exact + unique entryId association classifies a TUI extension', () => {
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue('my-ext'), bundleName: 'my-ext', identities: ['my-ext', 'e-ext'] }]),
    [observation({ owner: '9:my-ext', ownerName: 'my-ext', entryId: 'e-ext' })],
  )
  assert.equal(claims.get(bundleValue('my-ext'))?.role, 'tui-extension')
  assert.equal(claims.get(bundleValue('my-ext'))?.observation?.entryId, 'e-ext')
})

test('an ambiguous owner (claimed by two cards) classifies neither', () => {
  const claims = classifyPluginPackages(
    inputs([
      { key: bundleValue('a'), bundleName: 'a', identities: ['e-shared'] },
      { key: bundleValue('b'), bundleName: 'b', identities: ['e-shared'] },
    ]),
    [observation({ ownerName: 'shared', entryId: 'e-shared' })],
  )
  assert.equal(claims.get(bundleValue('a'))?.role, 'dsh-plugin')
  assert.equal(claims.get(bundleValue('b'))?.role, 'dsh-plugin')
})

test('package-name heuristics never classify (only whole-identity equality does)', () => {
  const claims = classifyPluginPackages(
    inputs([
      { key: bundleValue('tui-widgets'), bundleName: 'tui-widgets', identities: ['tui-widgets'] },
      { key: bundleValue('@xmoon76/other'), bundleName: '@xmoon76/other', identities: ['@xmoon76/other'] },
    ]),
    [
      observation({ ownerName: 'tui-extension-runtime' }),
      observation({ ownerName: 'terminal-thing' }),
    ],
  )
  assert.equal(claims.get(bundleValue('tui-widgets'))?.role, 'dsh-plugin')
  assert.equal(claims.get(bundleValue('@xmoon76/other'))?.role, 'dsh-plugin')
})

test('model sections are ordered Current TUI → TUI Extensions → DSH Plugins, and self is self-protected', () => {
  const snap = snapshot(
    [
      bundle({
        name: SELF_BUNDLE,
        version: '0.4.8',
        removable: true,
        rows: [{ rowId: 'tui-app', moduleName: SELF_BUNDLE, entryId: 'e-app' }],
      }),
      bundle({ name: 'my-ext', rows: [{ rowId: 'r', moduleName: 'my-ext', entryId: 'e-ext' }] }),
      bundle({ name: 'ordinary' }),
    ],
    [
      row({ entryId: 'e-app', moduleName: SELF_BUNDLE, patchId: 'tui-app' }),
      row({ entryId: 'e-ext', moduleName: 'my-ext', patchId: 'r' }),
    ],
  )
  const claims = classifyPluginPackages(
    inputs([
      { key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, identities: [SELF_BUNDLE, 'e-app'] },
      { key: bundleValue('my-ext'), bundleName: 'my-ext', identities: ['my-ext', 'e-ext'] },
      { key: bundleValue('ordinary'), bundleName: 'ordinary', identities: ['ordinary'] },
    ]),
    [observation({ ownerName: 'my-ext', entryId: 'e-ext' })],
  )
  const model = buildPluginManagerModel(snap, claims)
  assert.deepEqual(model.currentTui.map(card => card.name), [SELF_BUNDLE])
  assert.deepEqual(model.tuiExtensions.map(card => card.name), ['my-ext'])
  assert.deepEqual(model.dshPlugins.map(card => card.name), ['ordinary'])

  const self = model.currentTui[0]!
  // Host fact preserved exactly…
  assert.equal(self.removable, true)
  assert.equal(self.readOnlyReason, undefined)
  // …while the effective capability is narrowed to false.
  assert.equal(self.canToggle, false)
  assert.equal(self.canRemove, false)
  assert.equal(self.rows[0]!.canToggle, false)

  const ordinary = model.dshPlugins[0]!
  assert.equal(ordinary.canToggle, true)
  assert.equal(ordinary.canRemove, true)

  const extension = model.tuiExtensions[0]!
  assert.equal(extension.observation?.entryId, 'e-ext')
  // A TUI extension uses the SAME official mutation authority.
  assert.equal(extension.canToggle, true)
  assert.equal(extension.rows[0]!.canToggle, true)
})

test('a bundle row is never emitted as a second standalone card', () => {
  const snap = snapshot(
    [bundle({ name: 'holder', rows: [{ rowId: 'r', moduleName: 'm', entryId: 'e-r' }] })],
    [row({ entryId: 'e-r', moduleName: 'm', patchId: 'r' }), row({ entryId: 'e-free', moduleName: 'free', patchId: 'free' })],
  )
  const model = buildPluginManagerModel(snap, new Map())
  const values = [...model.currentTui, ...model.tuiExtensions, ...model.dshPlugins].map(card => card.value)
  assert.ok(values.includes(bundleValue('holder')))
  assert.ok(values.includes(entryValue('e-free')))
  assert.ok(!values.includes(entryValue('e-r')))
})

test('a self-owned standalone entry cannot be toggled', () => {
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, rows: [{ rowId: 'r', moduleName: 'helper', entryId: 'e-helper' }] })],
    [
      row({ entryId: 'e-helper', moduleName: 'helper', patchId: 'r' }),
      // A standalone entry that imports the self package itself is self-owned.
      row({ entryId: 'e-self', moduleName: SELF_BUNDLE, patchId: 'self' }),
    ],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, identities: [SELF_BUNDLE, 'e-helper'] }]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  assert.equal(model.currentTui[0]!.rows[0]!.canToggle, false)
  const selfEntry = model.currentTui.find(card => card.value === entryValue('e-self'))
  assert.ok(selfEntry !== undefined)
  assert.equal(selfEntry.canToggle, false)
  assert.equal(selfEntry.rows[0]!.canToggle, false)
})
