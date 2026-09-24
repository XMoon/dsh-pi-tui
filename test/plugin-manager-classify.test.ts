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

function inputs(list: readonly { key: string; bundleName?: string; entryIds: readonly string[] }[]): PluginClassificationInput[] {
  return list.map(item => ({ ...item }))
}

test('SELF_BUNDLE always classifies as current-tui, even with a matching observation', () => {
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: [] }]),
    [observation({ entryId: SELF_BUNDLE })],
  )
  assert.equal(claims.get(bundleValue(SELF_BUNDLE))?.role, 'current-tui')
  assert.equal(claims.get(bundleValue(SELF_BUNDLE))?.extension, undefined)
})

test('a proven Loader entryId association classifies a TUI extension', () => {
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue('my-ext'), bundleName: 'my-ext', entryIds: ['e-ext'] }]),
    [observation({ owner: '9:my-ext', entryId: 'e-ext' })],
  )
  assert.equal(claims.get(bundleValue('my-ext'))?.role, 'tui-extension')
  assert.deepEqual([...claims.get(bundleValue('my-ext'))!.extension!.entryIds], ['e-ext'])
})

test('an observation WITHOUT a proven entryId never classifies, even when its owner name equals the package', () => {
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue('my-ext'), bundleName: 'my-ext', entryIds: ['e-ext'] }]),
    [observation({ owner: '9:my-ext', })],
  )
  assert.equal(claims.get(bundleValue('my-ext'))?.role, 'dsh-plugin')
  assert.equal(claims.get(bundleValue('my-ext'))?.extension, undefined)
})

test('a module-name collision is not Loader-entry proof', () => {
  // The card exposes NO proven entry id; the observation's entryId merely
  // happens to equal a module specifier the card carries. Module specifiers
  // are never part of the proven id set, so this must not classify.
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue('collide'), bundleName: 'collide', entryIds: [] }]),
    [observation({ owner: '1:collide', entryId: 'e-collide' })],
  )
  assert.equal(claims.get(bundleValue('collide'))?.role, 'dsh-plugin')
})

test('two proven entryIds of ONE bundle aggregate into one TUI extension card', () => {
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue('foo'), bundleName: 'foo', entryIds: ['e-a', 'e-b'] }]),
    [
      observation({ owner: '1:foo-a', entryId: 'e-a', contributionKinds: ['chrome.footer.item'], contributionCount: 1 }),
      observation({ owner: '1:foo-b', entryId: 'e-b', contributionKinds: ['command'], contributionCount: 2, usesAdvancedCapability: true }),
    ],
  )
  const classification = claims.get(bundleValue('foo'))!
  assert.equal(classification.role, 'tui-extension')
  assert.deepEqual([...classification.extension!.entryIds], ['e-a', 'e-b'])
  assert.deepEqual([...classification.extension!.contributionKinds], ['chrome.footer.item', 'command'])
  assert.equal(classification.extension!.contributionCount, 3)
  assert.equal(classification.extension!.usesAdvancedCapability, true)
})

test('an ambiguous entryId (claimed by two cards) classifies neither', () => {
  const claims = classifyPluginPackages(
    inputs([
      { key: bundleValue('a'), bundleName: 'a', entryIds: ['e-shared'] },
      { key: bundleValue('b'), bundleName: 'b', entryIds: ['e-shared'] },
    ]),
    [observation({ entryId: 'e-shared' })],
  )
  assert.equal(claims.get(bundleValue('a'))?.role, 'dsh-plugin')
  assert.equal(claims.get(bundleValue('b'))?.role, 'dsh-plugin')
})

test('an unproven observation never classifies (no name heuristic)', () => {
  const claims = classifyPluginPackages(
    inputs([
      { key: bundleValue('tui-widgets'), bundleName: 'tui-widgets', entryIds: [] },
      { key: bundleValue('@xmoon76/other'), bundleName: '@xmoon76/other', entryIds: [] },
    ]),
    [
      observation({ }),
      observation({ }),
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
      { key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: ['e-app'] },
      { key: bundleValue('my-ext'), bundleName: 'my-ext', entryIds: ['e-ext'] },
      { key: bundleValue('ordinary'), bundleName: 'ordinary', entryIds: [] },
    ]),
    [observation({ entryId: 'e-ext' })],
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
  assert.deepEqual([...extension.extension!.entryIds], ['e-ext'])
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

test('Current TUI is the self BUNDLE card only; a same-module standalone entry stays visible', () => {
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, rows: [{ rowId: 'tui-app', moduleName: SELF_BUNDLE, entryId: 'include:tui-app' }] })],
    [
      row({ entryId: 'include:tui-app', moduleName: SELF_BUNDLE, patchId: 'tui-app' }),
      // A DIFFERENT Loader row that merely imports the same module: it is not
      // owned by the self bundle and must not be swallowed by a name match.
      row({ entryId: 'include:other', moduleName: SELF_BUNDLE, patchId: 'other' }),
    ],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: ['include:tui-app'] }]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  assert.deepEqual(model.currentTui.map(card => card.value), [bundleValue(SELF_BUNDLE)])
  // The row owned by the self bundle is inside that card…
  assert.ok(model.currentTui[0]!.rows.some(entry => entry.entryId === 'include:tui-app'))
  // …while the independent same-module entry remains its own DSH Plugin card.
  // It stays VISIBLE and MANAGEABLE: same module name is not proof of self
  // ownership (its patch row `other` is not one the self bundle declares).
  assert.deepEqual(model.dshPlugins.map(card => card.value), [entryValue('include:other')])
  assert.equal(model.dshPlugins[0]!.canToggle, true)
  assert.equal(model.dshPlugins[0]!.isSelf, false)
})

test('a bundle row module shared with an unrelated standalone entry never swallows it', () => {
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, rows: [
      { rowId: 'workspace', moduleName: '@deepseek-ai/dsh-workspace', entryId: 'include:workspace' },
    ] })],
    [
      row({ entryId: 'include:workspace', moduleName: '@deepseek-ai/dsh-workspace', patchId: 'workspace' }),
      // An unrelated user row importing the SAME module.
      row({ entryId: 'include:user-workspace', moduleName: '@deepseek-ai/dsh-workspace', patchId: 'user-workspace' }),
    ],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: ['include:workspace'] }]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  const values = [...model.currentTui, ...model.tuiExtensions, ...model.dshPlugins].map(card => card.value)
  assert.ok(values.includes(entryValue('include:user-workspace')), 'the unrelated workspace entry must stay visible')
  assert.deepEqual(model.dshPlugins.map(card => card.value), [entryValue('include:user-workspace')])
  // A shared HOST package is NOT a TUI module: the independent row stays manageable.
  assert.equal(model.dshPlugins[0]!.canToggle, true)
  assert.equal(model.dshPlugins[0]!.isSelf, false)
})

test('an unproven self-bundle row protects its live entry by patchId proof, not module name', () => {
  // The self-bundle row exposes NO entryId (abnormal composition), so the live
  // entry cannot be excluded by id. `patchId === rowId` is the official proof
  // that this is the row the bundle declares. It stays VISIBLE but protected.
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, rows: [{ rowId: 'pi-tui-builtins', moduleName: `${SELF_BUNDLE}/builtins` }] })],
    [row({ entryId: 'include:pi-tui-builtins', moduleName: `${SELF_BUNDLE}/builtins`, patchId: 'pi-tui-builtins' })],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: [] }]),
    [observation({ owner: '1:builtins', entryId: 'include:pi-tui-builtins' })],
  )
  const model = buildPluginManagerModel(snap, claims)
  const card = [...model.currentTui, ...model.tuiExtensions, ...model.dshPlugins]
    .find(candidate => candidate.value === entryValue('include:pi-tui-builtins'))
  assert.ok(card !== undefined, 'the entry must stay visible')
  assert.equal(card.canToggle, false, 'a proven self row must never be toggleable')
  assert.equal(card.isSelf, true)
  assert.equal(card.rows[0]!.canToggle, false)
})

test('the same TUI module with an unrelated patch row stays manageable (no package-name protection)', () => {
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, rows: [{ rowId: 'pi-tui-builtins', moduleName: `${SELF_BUNDLE}/builtins` }] })],
    [row({ entryId: 'include:my-own', moduleName: `${SELF_BUNDLE}/builtins`, patchId: 'unrelated-row' })],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: [] }]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  const card = model.dshPlugins.find(candidate => candidate.value === entryValue('include:my-own'))
  assert.ok(card !== undefined)
  assert.equal(card.canToggle, true, 'a different patch row must not inherit self protection')
  assert.equal(card.isSelf, false)
})

test('a shared Host package row declared by the self bundle is protected by patchId proof', () => {
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, rows: [{ rowId: 'workspace', moduleName: '@deepseek-ai/dsh-workspace' }] })],
    [row({ entryId: 'include:workspace', moduleName: '@deepseek-ai/dsh-workspace', patchId: 'workspace' })],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: [] }]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  const card = [...model.currentTui, ...model.tuiExtensions, ...model.dshPlugins]
    .find(candidate => candidate.value === entryValue('include:workspace'))
  assert.ok(card !== undefined)
  // A package name outside the TUI package is protected ONLY because the self
  // bundle provably declares this row.
  assert.equal(card.canToggle, false)
  assert.equal(card.isSelf, true)
})

test('a standalone entry unrelated to the self modules keeps its toggle', () => {
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, rows: [{ rowId: 'builtins', moduleName: `${SELF_BUNDLE}/builtins` }] })],
    [row({ entryId: 'include:other', moduleName: 'unrelated-plugin', patchId: 'other' })],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: [] }]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  const card = model.dshPlugins.find(candidate => candidate.value === entryValue('include:other'))
  assert.ok(card !== undefined)
  assert.equal(card.canToggle, true)
  assert.equal(card.isSelf, false)
})

test('without the self bundle there is no Current TUI card and no guessed fallback', () => {
  const snap = snapshot(
    [],
    [row({ entryId: 'include:tui-app', moduleName: SELF_BUNDLE, patchId: 'tui-app' })],
  )
  const model = buildPluginManagerModel(snap, new Map())
  assert.deepEqual(model.currentTui, [])
  // The self-module entry is shown as an ordinary DSH plugin, never guessed
  // into the Current TUI section.
  assert.deepEqual(model.dshPlugins.map(card => card.value), [entryValue('include:tui-app')])
})
