/**
 * Presentation-classification and self-protection tests (S4-D1):
 *  - The four frozen sections keep their order; Experimental is always last.
 *  - Current TUI is exactly `@xmoon76/dsh-pi-tui`, appears once, and its
 *    effective capabilities are narrowed without forging Host facts.
 *  - TUI Extensions require an exact + UNIQUE live-owner association; a name
 *    heuristic never classifies, and an ambiguous owner falls back.
 *  - Official evidence comes from real Host facts or the exact rc.2 base ids,
 *    never from a `@deepseek-ai/` scope or an `experimental` substring.
 *  - One bundle produces exactly one card, and one primary card per package.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-classify.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  EXPERIMENTAL_BUNDLE_IDS,
  SELF_BUNDLE,
  classifyPluginPackages,
  type PluginClassificationInput,
} from '../../src/app/plugin-manager/classify.ts'
import type { TuiExtensionObservation } from '../../src/app/plugin-manager/extension-inventory.ts'
import {
  AUTO_REVIEW_DISABLE_WARNING,
  PLUGIN_ACTION,
  buildPluginDetailView,
  buildPluginManagerModel,
  bundleValue,
  entryValue,
  rowToggleValue,
  type PluginCardView,
  type PluginManagerModel,
} from '../../src/app/plugin-manager/model.ts'
import { detachPluginManagerSnapshot } from '../../src/runtime/plugin-manager-mapping.ts'
import type { PluginBundleFact, PluginManagerSnapshot, PluginRowFact } from '../../src/runtime/plugin-manager-port.ts'

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
    official: false,
    availability: 'profile',
    source: 'file:/tmp/ordinary',
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

function inputs(list: readonly PluginClassificationInput[]): PluginClassificationInput[] {
  return list.map(item => ({ ...item }))
}

function cardsOf(model: PluginManagerModel, id: PluginManagerModel['sections'][number]['id']): readonly PluginCardView[] {
  return model.sections.find(section => section.id === id)?.cards ?? []
}

function cardByName(model: PluginManagerModel, name: string): PluginCardView | undefined {
  return model.cards.find(card => card.name === name)
}

test('the four sections keep the FROZEN order, Experimental last', () => {
  const model = buildPluginManagerModel(snapshot([bundle()], []), new Map())
  assert.deepEqual(model.sections.map(section => section.id), ['tui', 'official', 'third-party', 'experimental'])
  assert.deepEqual(model.sections.map(section => section.label), ['TUI & Extensions', 'Official DSH', 'Third-party', 'Experimental'])
})

test('SELF_BUNDLE always classifies as current-tui and stays the first TUI card', () => {
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: [], official: false, availability: 'profile', installed: true, source: 'file:/tui' }]),
    [observation({ entryId: SELF_BUNDLE })],
  )
  const claim = claims.get(bundleValue(SELF_BUNDLE))!
  assert.equal(claim.role, 'current-tui')
  assert.equal(claim.section, 'tui')
  assert.equal(claim.extension, undefined)
})

test('a proven Loader entryId association classifies a TUI extension in the TUI section', () => {
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue('my-ext'), bundleName: 'my-ext', entryIds: ['e-ext'], availability: 'profile', installed: true, source: 'file:/ext' }]),
    [observation({ owner: '9:my-ext', entryId: 'e-ext' })],
  )
  const claim = claims.get(bundleValue('my-ext'))!
  assert.equal(claim.role, 'tui-extension')
  assert.equal(claim.section, 'tui')
  assert.equal(claim.origin, 'third-party')
  assert.deepEqual([...claim.extension!.entryIds], ['e-ext'])
})

test('an observation WITHOUT a proven entryId never classifies, even when its owner name equals the package', () => {
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue('my-ext'), bundleName: 'my-ext', entryIds: ['e-ext'], availability: 'profile', installed: true, source: 'file:/ext' }]),
    [observation({ owner: '9:my-ext' })],
  )
  const claim = claims.get(bundleValue('my-ext'))!
  assert.equal(claim.role, 'dsh-plugin')
  assert.equal(claim.section, 'third-party')
  assert.equal(claim.extension, undefined)
})

test('a module-name collision is not Loader-entry proof', () => {
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue('collide'), bundleName: 'collide', entryIds: [], availability: 'profile', installed: true, source: 'file:/c' }]),
    [observation({ owner: '1:collide', entryId: 'e-collide' })],
  )
  assert.equal(claims.get(bundleValue('collide'))?.role, 'dsh-plugin')
})

test('two proven entryIds of ONE bundle aggregate into one TUI extension card', () => {
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue('foo'), bundleName: 'foo', entryIds: ['e-a', 'e-b'], availability: 'profile', installed: true, source: 'file:/foo' }]),
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
      { key: bundleValue('a'), bundleName: 'a', entryIds: ['e-shared'], availability: 'profile', installed: true, source: 'file:/a' },
      { key: bundleValue('b'), bundleName: 'b', entryIds: ['e-shared'], availability: 'profile', installed: true, source: 'file:/b' },
    ]),
    [observation({ entryId: 'e-shared' })],
  )
  assert.equal(claims.get(bundleValue('a'))?.role, 'dsh-plugin')
  assert.equal(claims.get(bundleValue('b'))?.role, 'dsh-plugin')
})

test('an unproven observation never classifies (no name heuristic)', () => {
  const claims = classifyPluginPackages(
    inputs([
      { key: bundleValue('tui-widgets'), bundleName: 'tui-widgets', entryIds: [], availability: 'profile', installed: true, source: 'file:/w' },
      { key: bundleValue('@xmoon76/other'), bundleName: '@xmoon76/other', entryIds: [], availability: 'profile', installed: true, source: 'file:/o' },
    ]),
    [observation({}), observation({})],
  )
  assert.equal(claims.get(bundleValue('tui-widgets'))?.role, 'dsh-plugin')
  assert.equal(claims.get(bundleValue('@xmoon76/other'))?.role, 'dsh-plugin')
})

test('model sections are ordered TUI → Official → Third-party → Experimental, and self is self-protected', () => {
  const snap = snapshot(
    [
      bundle({
        name: SELF_BUNDLE,
        version: '0.4.8',
        source: 'file:/tui',
        removable: true,
        rows: [{ rowId: 'tui-app', moduleName: SELF_BUNDLE, entryId: 'e-app' }],
      }),
      bundle({ name: 'my-ext', source: 'file:/ext', rows: [{ rowId: 'r', moduleName: 'my-ext', entryId: 'e-ext' }] }),
      bundle({ name: '@deepseek-ai/dsh-base', availability: 'installation', source: undefined }),
      bundle({ name: 'ordinary', source: 'file:/ordinary' }),
      bundle({
        name: '@deepseek-ai/dsh-experimental-auto-review',
        official: true,
        availability: 'missing',
        installed: false,
        optional: true,
        removable: false,
        source: undefined,
        installTarget: { spec: '@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2', version: '0.2.1-rc.2' },
      }),
    ],
    [
      row({ entryId: 'e-app', moduleName: SELF_BUNDLE, patchId: 'tui-app' }),
      row({ entryId: 'e-ext', moduleName: 'my-ext', patchId: 'r' }),
    ],
  )
  const claims = classifyPluginPackages(
    inputs([
      { key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: ['e-app'], availability: 'profile', installed: true, source: 'file:/tui' },
      { key: bundleValue('my-ext'), bundleName: 'my-ext', entryIds: ['e-ext'], availability: 'profile', installed: true, source: 'file:/ext' },
      { key: bundleValue('@deepseek-ai/dsh-base'), bundleName: '@deepseek-ai/dsh-base', entryIds: [], official: false, availability: 'installation' },
      { key: bundleValue('ordinary'), bundleName: 'ordinary', entryIds: [], availability: 'profile', installed: true, source: 'file:/ordinary' },
      { key: bundleValue('@deepseek-ai/dsh-experimental-auto-review'), bundleName: '@deepseek-ai/dsh-experimental-auto-review', entryIds: [], official: true, availability: 'missing', installed: false },
    ]),
    [observation({ entryId: 'e-ext' })],
  )
  const model = buildPluginManagerModel(snap, claims)
  assert.deepEqual(cardsOf(model, 'tui').map(card => card.name), [SELF_BUNDLE, 'my-ext'])
  assert.deepEqual(cardsOf(model, 'official').map(card => card.name), ['@deepseek-ai/dsh-base'])
  assert.deepEqual(cardsOf(model, 'third-party').map(card => card.name), ['ordinary'])
  assert.deepEqual(cardsOf(model, 'experimental').map(card => card.name), ['@deepseek-ai/dsh-experimental-auto-review'])

  const self = cardByName(model, SELF_BUNDLE)!
  // Host fact preserved exactly…
  assert.equal(self.removable, true)
  assert.equal(self.readOnlyReason, undefined)
  // …while the effective capability is narrowed to false.
  assert.equal(self.canToggle, false)
  assert.equal(self.canRemove, false)
  assert.equal(self.rows[0]!.canToggle, false)

  const ordinary = cardByName(model, 'ordinary')!
  assert.equal(ordinary.canToggle, true)
  assert.equal(ordinary.canRemove, true)
  assert.equal(ordinary.origin, 'third-party')
  assert.equal(ordinary.canInstall, false)

  const extension = cardByName(model, 'my-ext')!
  assert.deepEqual([...extension.extension!.entryIds], ['e-ext'])
  assert.equal(extension.canToggle, true)
  assert.equal(extension.rows[0]!.canToggle, true)

  const experimental = cardByName(model, '@deepseek-ai/dsh-experimental-auto-review')!
  assert.equal(experimental.section, 'experimental')
  assert.equal(experimental.canToggle, false)
  assert.equal(experimental.canInstall, true)
  assert.deepEqual(experimental.installTarget, {
    spec: '@deepseek-ai/dsh-experimental-auto-review@0.2.1-rc.2',
    version: '0.2.1-rc.2',
  })
})

test('the official Experimental identities keep the rc.2 B01–B14 order, Codex/Claude last', () => {
  const snap = snapshot(
    EXPERIMENTAL_BUNDLE_IDS.map(name => bundle({
      name,
      official: true,
      availability: 'missing',
      installed: false,
      optional: true,
      removable: false,
      source: undefined,
      installTarget: { spec: `${name}@0.2.1-rc.2`, version: '0.2.1-rc.2' },
    })),
    [],
  )
  const claims = classifyPluginPackages(
    inputs(EXPERIMENTAL_BUNDLE_IDS.map(name => ({ key: bundleValue(name), bundleName: name, entryIds: [], official: true, availability: 'missing' as const, installed: false }))),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  assert.deepEqual(cardsOf(model, 'experimental').map(card => card.name), [...EXPERIMENTAL_BUNDLE_IDS])
  assert.equal(cardsOf(model, 'experimental').at(-2)!.name, '@deepseek-ai/dsh-subagent-codex')
  assert.equal(cardsOf(model, 'experimental').at(-1)!.name, '@deepseek-ai/dsh-subagent-claude-code')
})

test('a real Host catalog row reaches the section through shared mapping, not a static card list', () => {
  const mapped = detachPluginManagerSnapshot({
    bundles: [
      {
        name: '@deepseek-ai/dsh-experimental-voice-input-bundle',
        official: true,
        availability: 'missing',
        installTarget: { spec: '@deepseek-ai/dsh-experimental-voice-input-bundle@0.2.1-rc.2', version: '0.2.1-rc.2' },
        enabled: false,
        installed: false,
        optional: true,
        removable: false,
        rows: [],
        overrides: [],
      },
      {
        name: '@xmoon76/dsh-pi-tui',
        official: false,
        availability: 'profile',
        source: 'file:/repo/dsh-pi-tui',
        version: '0.5.3',
        enabled: true,
        installed: true,
        optional: false,
        removable: true,
        rows: [],
        overrides: [],
      },
    ],
    plugins: [],
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: { exemptions: {}, warnings: [] },
  })
  const claims = classifyPluginPackages(
    inputs([
      {
        key: bundleValue('@deepseek-ai/dsh-experimental-voice-input-bundle'),
        bundleName: '@deepseek-ai/dsh-experimental-voice-input-bundle',
        entryIds: [],
        official: true,
        availability: 'missing',
        installed: false,
      },
      {
        key: bundleValue('@xmoon76/dsh-pi-tui'),
        bundleName: '@xmoon76/dsh-pi-tui',
        entryIds: [],
        official: false,
        availability: 'profile',
        installed: true,
        source: 'file:/repo/dsh-pi-tui',
      },
    ]),
    [],
  )
  const model = buildPluginManagerModel(mapped, claims)
  assert.deepEqual(cardsOf(model, 'experimental').map(card => card.name), ['@deepseek-ai/dsh-experimental-voice-input-bundle'])
  assert.deepEqual(cardsOf(model, 'tui').map(card => card.name), [SELF_BUNDLE])
  // A missing row is never rendered as an "installation-provided" card.
  const voice = cardByName(model, '@deepseek-ai/dsh-experimental-voice-input-bundle')!
  assert.equal(voice.availability, 'missing')
  assert.equal(voice.installed, false)
  assert.equal(buildPluginDetailView(voice).actions.some(action => action.value === PLUGIN_ACTION.officialInstall && action.enabled), true)
})

test('official:false on a shipped base bundle is not third-party evidence', () => {
  const model = buildPluginManagerModel(
    snapshot([bundle({ name: '@deepseek-ai/dsh-base', availability: 'installation', installed: true, source: undefined })], []),
    classifyPluginPackages(inputs([{ key: bundleValue('@deepseek-ai/dsh-base'), bundleName: '@deepseek-ai/dsh-base', entryIds: [], official: false, availability: 'installation' }]), []),
  )
  const base = cardByName(model, '@deepseek-ai/dsh-base')!
  assert.equal(base.section, 'official')
  assert.equal(base.origin, 'official')
  assert.equal(base.unverified, false)
})

test('a Host incompatible error states whether an exact-version exemption applies', () => {
  const incompatible = { name: 'pkg', version: '2.0.0', runtimeVersion: '0.2.1-rc.2', requirements: { 'engines.dsh': '>=9' } }
  const snap = snapshot([
    bundle({
      name: 'incompatible',
      error: { code: 'incompatible-version', incompatible: [incompatible] },
    }),
  ], [])
  const model = buildPluginManagerModel(snap, new Map())
  const card = cardByName(model, 'incompatible')!
  const without = buildPluginDetailView(card)
  assert.ok(without.groups.some(group => group.facts.some(fact => /no exact-version exemption applies/.test(fact.value))),
    'an incompatible package with no exemption says so')
  const withExemption = buildPluginDetailView(card, [
    { packageVersion: 'pkg@2.0.0', runtimeVersions: ['0.2.1-rc.2'] },
  ])
  assert.ok(withExemption.groups.some(group => group.facts.some(fact =>
    fact.label === 'Exemption' && fact.tone === 'success' && /exempted for DSH 0\.2\.1-rc\.2/.test(fact.value))),
  'the exact accepted package-version exemption is shown')

  // The REAL Host accepts an exempted package WITHOUT an incompatible error;
  // the applied exemption still has to be visible on its card.
  const accepted = buildPluginManagerModel(
    snapshot([bundle({ name: 'accepted', version: '1.0.0', error: undefined })], []),
    new Map(),
  )
  const acceptedCard = cardByName(accepted, 'accepted')!
  const acceptedDetail = buildPluginDetailView(acceptedCard, [
    { packageVersion: 'accepted@1.0.0', runtimeVersions: ['0.2.1-rc.2'] },
  ])
  assert.ok(acceptedDetail.groups.some(group => group.facts.some(fact =>
    fact.label === 'Exemption' && fact.tone === 'success' && /accepted@1\.0\.0/.test(fact.value))),
  'an applied exemption is visible even when the Host emitted no incompatible error')
})

test('installation, missing and standalone-entry cards never offer Remove', () => {
  const snap = snapshot([
    bundle({ name: '@deepseek-ai/dsh-base', availability: 'installation', source: undefined }),
    bundle({
      name: '@deepseek-ai/dsh-experimental-auto-review',
      official: true,
      availability: 'missing',
      installed: false,
      optional: true,
      removable: false,
      source: undefined,
      installTarget: { spec: 'x@1', version: '1' },
    }),
  ], [row({ entryId: 'e-free', moduleName: 'free', patchId: 'free' })])
  const model = buildPluginManagerModel(snap, new Map())
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-auto-review']) {
    const card = cardByName(model, name)!
    assert.ok(!buildPluginDetailView(card).actions.some(action => action.value === PLUGIN_ACTION.remove),
      `${name} must not offer Remove (availability ${card.availability})`)
  }
  const entry = model.cards.find(card => card.value === entryValue('e-free'))!
  assert.ok(!buildPluginDetailView(entry).actions.some(action => action.value === PLUGIN_ACTION.remove),
    'a standalone Loader entry has no Remove action')
})

test('a @deepseek-ai scope never proves official and an experimental substring never proves Experimental', () => {
  const claims = classifyPluginPackages(
    inputs([
      { key: bundleValue('@deepseek-ai/evil'), bundleName: '@deepseek-ai/evil', entryIds: [], availability: 'profile', installed: true, source: 'file:/evil' },
      { key: bundleValue('@deepseek-ai/dsh-my-experimental-tool'), bundleName: '@deepseek-ai/dsh-my-experimental-tool', entryIds: [], availability: 'profile', installed: true, source: 'file:/tool' },
    ]),
    [],
  )
  const evil = claims.get(bundleValue('@deepseek-ai/evil'))!
  assert.equal(evil.section, 'third-party')
  assert.equal(evil.experimental, false)
  const fake = claims.get(bundleValue('@deepseek-ai/dsh-my-experimental-tool'))!
  assert.equal(fake.section, 'third-party')
  assert.equal(fake.experimental, false)
})

test('a standalone entry without provenance is Third-party → Unverified origin', () => {
  const model = buildPluginManagerModel(
    snapshot([], [row({ entryId: 'include:free', moduleName: 'free', patchId: 'free' })]),
    new Map(),
  )
  const card = cardByName(model, 'free')!
  assert.equal(card.section, 'third-party')
  assert.equal(card.origin, 'unknown')
  assert.equal(card.unverified, true)
  assert.equal(card.canToggle, true)
  const detail = buildPluginDetailView(card)
  assert.ok(detail.groups.some(group => group.facts.some(fact => /Source unknown/.test(fact.value))))
})

test('a bundle row is never emitted as a second standalone card', () => {
  const snap = snapshot(
    [bundle({ name: 'holder', rows: [{ rowId: 'r', moduleName: 'm', entryId: 'e-r' }] })],
    [row({ entryId: 'e-r', moduleName: 'm', patchId: 'r' }), row({ entryId: 'e-free', moduleName: 'free', patchId: 'free' })],
  )
  const model = buildPluginManagerModel(snap, new Map())
  const values = model.cards.map(card => card.value)
  assert.ok(values.includes(bundleValue('holder')))
  assert.ok(values.includes(entryValue('e-free')))
  assert.ok(!values.includes(entryValue('e-r')))
})

test('Current TUI is the self BUNDLE card only; a same-module standalone entry stays visible', () => {
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, source: 'file:/tui', rows: [{ rowId: 'tui-app', moduleName: SELF_BUNDLE, entryId: 'include:tui-app' }] })],
    [
      row({ entryId: 'include:tui-app', moduleName: SELF_BUNDLE, patchId: 'tui-app' }),
      // A DIFFERENT Loader row that merely imports the same module: it is not
      // owned by the self bundle and must not be swallowed by a name match.
      row({ entryId: 'include:other', moduleName: SELF_BUNDLE, patchId: 'other' }),
    ],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: ['include:tui-app'], availability: 'profile', installed: true, source: 'file:/tui' }]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  assert.deepEqual(cardsOf(model, 'tui').map(card => card.value), [bundleValue(SELF_BUNDLE)])
  // The row owned by the self bundle is inside that card…
  assert.ok(cardByName(model, SELF_BUNDLE)!.rows.some(entry => entry.entryId === 'include:tui-app'))
  // …while the independent same-module entry remains its own (unverified)
  // Third-party card and stays manageable.
  const other = model.cards.find(card => card.value === entryValue('include:other'))!
  assert.equal(other.section, 'third-party')
  assert.equal(other.canToggle, true)
  assert.equal(other.isSelf, false)
})

test('a bundle row module shared with an unrelated standalone entry never swallows it', () => {
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, source: 'file:/tui', rows: [
      { rowId: 'workspace', moduleName: '@deepseek-ai/dsh-workspace', entryId: 'include:workspace' },
    ] })],
    [
      row({ entryId: 'include:workspace', moduleName: '@deepseek-ai/dsh-workspace', patchId: 'workspace' }),
      // An unrelated user row importing the SAME module.
      row({ entryId: 'include:user-workspace', moduleName: '@deepseek-ai/dsh-workspace', patchId: 'user-workspace' }),
    ],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: ['include:workspace'], availability: 'profile', installed: true, source: 'file:/tui' }]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  const values = model.cards.map(card => card.value)
  assert.ok(values.includes(entryValue('include:user-workspace')), 'the unrelated workspace entry must stay visible')
  const card = model.cards.find(candidate => candidate.value === entryValue('include:user-workspace'))!
  // A shared HOST package is NOT a TUI module: the independent row stays manageable.
  assert.equal(card.canToggle, true)
  assert.equal(card.isSelf, false)
})

test('an unproven self-bundle row protects its live entry by patchId proof, not module name', () => {
  // The self-bundle row exposes NO entryId (abnormal composition), so the live
  // entry cannot be excluded by id. `patchId === rowId` is the official proof
  // that this is the row the bundle declares. It stays VISIBLE but protected.
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, source: 'file:/tui', rows: [{ rowId: 'pi-tui-builtins', moduleName: `${SELF_BUNDLE}/builtins` }] })],
    [row({ entryId: 'include:pi-tui-builtins', moduleName: `${SELF_BUNDLE}/builtins`, patchId: 'pi-tui-builtins' })],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: [], availability: 'profile', installed: true, source: 'file:/tui' }]),
    [observation({ owner: '1:builtins', entryId: 'include:pi-tui-builtins' })],
  )
  const model = buildPluginManagerModel(snap, claims)
  const card = model.cards.find(candidate => candidate.value === entryValue('include:pi-tui-builtins'))
  assert.ok(card !== undefined, 'the entry must stay visible')
  assert.equal(card.canToggle, false, 'a proven self row must never be toggleable')
  assert.equal(card.isSelf, true)
  assert.equal(card.rows[0]!.canToggle, false)
})

test('the same TUI module with an unrelated patch row stays manageable (no package-name protection)', () => {
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, source: 'file:/tui', rows: [{ rowId: 'pi-tui-builtins', moduleName: `${SELF_BUNDLE}/builtins` }] })],
    [row({ entryId: 'include:my-own', moduleName: `${SELF_BUNDLE}/builtins`, patchId: 'unrelated-row' })],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: [], availability: 'profile', installed: true, source: 'file:/tui' }]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  const card = model.cards.find(candidate => candidate.value === entryValue('include:my-own'))
  assert.ok(card !== undefined)
  assert.equal(card.canToggle, true, 'a different patch row must not inherit self protection')
  assert.equal(card.isSelf, false)
})

test('a shared Host package row declared by the self bundle is protected by patchId proof', () => {
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, source: 'file:/tui', rows: [{ rowId: 'workspace', moduleName: '@deepseek-ai/dsh-workspace' }] })],
    [row({ entryId: 'include:workspace', moduleName: '@deepseek-ai/dsh-workspace', patchId: 'workspace' })],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: [], availability: 'profile', installed: true, source: 'file:/tui' }]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  const card = model.cards.find(candidate => candidate.value === entryValue('include:workspace'))
  assert.ok(card !== undefined)
  // A package name outside the TUI package is protected ONLY because the self
  // bundle provably declares this row.
  assert.equal(card.canToggle, false)
  assert.equal(card.isSelf, true)
})

test('a base bundle row overridden by the Current TUI bundle is protected in place', () => {
  // The REAL inventory shape: an overridden base row (tool-bash) belongs to the
  // dsh-base bundle card, and the TUI bundle merely lists it in `overrides`.
  const snap = snapshot(
    [
      bundle({
        name: '@deepseek-ai/dsh-base',
        availability: 'installation',
        source: undefined,
        rows: [
          { rowId: 'tool-bash', moduleName: '@deepseek-ai/dsh-tool-bash', entryId: 'include:tool-bash' },
          { rowId: 'timer', moduleName: '@deepseek-ai/dsh-timer', entryId: 'include:timer' },
        ],
      }),
      bundle({
        name: SELF_BUNDLE,
        source: 'file:/tui',
        rows: [{ rowId: 'tui-app', moduleName: SELF_BUNDLE, entryId: 'include:tui-app' }],
        overrides: ['tool-bash'],
      }),
    ],
    [
      row({ entryId: 'include:tool-bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: false, patchId: 'tool-bash' }),
      row({ entryId: 'include:timer', moduleName: '@deepseek-ai/dsh-timer', patchId: 'timer' }),
      row({ entryId: 'include:tui-app', moduleName: SELF_BUNDLE, patchId: 'tui-app' }),
    ],
  )
  const claims = classifyPluginPackages(
    inputs([
      { key: bundleValue('@deepseek-ai/dsh-base'), bundleName: '@deepseek-ai/dsh-base', entryIds: ['include:tool-bash', 'include:timer'], official: false, availability: 'installation' },
      { key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: ['include:tui-app'], availability: 'profile', installed: true, source: 'file:/tui' },
    ]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  const base = cardByName(model, '@deepseek-ai/dsh-base')!
  assert.equal(base.section, 'official')
  const toolBash = base.rows.find(entry => entry.entryId === 'include:tool-bash')!
  assert.equal(toolBash.canToggle, false, 'the overridden base row must not be toggleable')
  assert.equal(toolBash.selfProtected, true)
  const timer = base.rows.find(entry => entry.entryId === 'include:timer')!
  assert.equal(timer.canToggle, true, 'a row the TUI does not override keeps its Host capability')
  assert.equal(timer.selfProtected, false)
  // The overridden row exposes no toggle-row action but IS explained; the
  // untouched row exposes its toggle and no protection note.
  const detail = buildPluginDetailView(base)
  assert.ok(!detail.actions.some(action => action.value === rowToggleValue('include:tool-bash')))
  assert.ok(detail.actions.some(action => action.value === rowToggleValue('include:timer')))
  assert.ok(detail.groups.some(group => group.facts.some(fact => fact.value.includes('Protected by the Current TUI composition'))))
  // The bundled row never becomes a standalone card.
  assert.ok(!model.cards.some(card => card.value === entryValue('include:tool-bash')))
})

test('a base row the self bundle overrides is protected by patchId proof', () => {
  // `cordis.patch.yml` disables base rows such as `tool-bash`; those ids land
  // in BundleInfo.overrides. The TUI bundle's own patch layer must not be
  // undone from its own screen.
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, source: 'file:/tui', rows: [], overrides: ['tool-bash', 'tool-web'] })],
    [row({ entryId: 'include:tool-bash', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: false, patchId: 'tool-bash' })],
  )
  const model = buildPluginManagerModel(snap, classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: [], availability: 'profile', installed: true, source: 'file:/tui' }]),
    [],
  ))
  const card = model.cards.find(candidate => candidate.value === entryValue('include:tool-bash'))
  assert.ok(card !== undefined, 'the overridden base row stays visible')
  assert.equal(card.canToggle, false)
  assert.equal(card.isSelf, true)
})

test('a standalone entry unrelated to the self modules keeps its toggle', () => {
  const snap = snapshot(
    [bundle({ name: SELF_BUNDLE, source: 'file:/tui', rows: [{ rowId: 'builtins', moduleName: `${SELF_BUNDLE}/builtins` }] })],
    [row({ entryId: 'include:other', moduleName: 'unrelated-plugin', patchId: 'other' })],
  )
  const claims = classifyPluginPackages(
    inputs([{ key: bundleValue(SELF_BUNDLE), bundleName: SELF_BUNDLE, entryIds: [], availability: 'profile', installed: true, source: 'file:/tui' }]),
    [],
  )
  const model = buildPluginManagerModel(snap, claims)
  const card = model.cards.find(candidate => candidate.value === entryValue('include:other'))
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
  assert.deepEqual(cardsOf(model, 'tui'), [])
  const card = model.cards.find(candidate => candidate.value === entryValue('include:tui-app'))!
  // The self-module entry is shown as an ordinary (unverified) Third-party
  // card, never guessed into the Current TUI section.
  assert.equal(card.section, 'third-party')
  assert.equal(card.unverified, true)
})

// ── D3-0: bounded rc.2 product-support copy ────────────────────────────────

const B01 = '@deepseek-ai/dsh-experimental-agent-team-profile'
const B02 = '@deepseek-ai/dsh-experimental-voice-input-bundle'
const B04 = '@deepseek-ai/dsh-experimental-inspector-profile'
const B06 = '@deepseek-ai/dsh-experimental-cot-translation-bundle'
const B07 = '@deepseek-ai/dsh-experimental-terminal-bundle'
const B11 = '@deepseek-ai/dsh-experimental-ralph-bundle'
const B12 = '@deepseek-ai/dsh-experimental-plugin-market-bundle'
const B13 = '@deepseek-ai/dsh-subagent-claude-code'
const B14 = '@deepseek-ai/dsh-subagent-codex'

function experimentalBundles(
  state: { readonly availability: 'installation' | 'profile' | 'missing'; readonly installed: boolean; readonly enabled: boolean } = {
    availability: 'missing',
    installed: false,
    enabled: false,
  },
): PluginBundleFact[] {
  return EXPERIMENTAL_BUNDLE_IDS.map(name => bundle({
    name,
    official: true,
    availability: state.availability,
    installed: state.installed,
    enabled: state.enabled,
    optional: state.availability !== 'profile',
    removable: false,
    source: state.availability === 'profile' ? `file:/tmp/${name.split('/').at(-1)}` : undefined,
    ...(state.availability === 'missing'
      ? { installTarget: { spec: `${name}@0.2.1-rc.2`, version: '0.2.1-rc.2' } }
      : {}),
  }))
}

function experimentalModel(options: {
  readonly extraBundles?: readonly PluginBundleFact[]
  readonly extraRows?: readonly PluginRowFact[]
  readonly state?: { readonly availability: 'installation' | 'profile' | 'missing'; readonly installed: boolean; readonly enabled: boolean }
} = {}): PluginManagerModel {
  const state = options.state ?? { availability: 'missing' as const, installed: false, enabled: false }
  const extraBundles = options.extraBundles ?? []
  const snap = snapshot([...experimentalBundles(state), ...extraBundles], [...(options.extraRows ?? [])])
  const claims = classifyPluginPackages(
    inputs([
      ...EXPERIMENTAL_BUNDLE_IDS.map(name => ({
        key: bundleValue(name),
        bundleName: name,
        entryIds: [],
        official: true,
        availability: state.availability,
        installed: state.installed,
      })),
      ...extraBundles.map(item => ({
        key: bundleValue(item.name),
        bundleName: item.name,
        entryIds: item.rows.flatMap(itemRow => itemRow.entryId === undefined ? [] : [String(itemRow.entryId)]),
        official: item.official,
        availability: item.availability,
        installed: item.installed,
        ...(item.source === undefined ? {} : { source: item.source }),
      })),
    ]),
    [],
  )
  return buildPluginManagerModel(snap, claims)
}

function fact(card: PluginCardView, label: string) {
  for (const group of buildPluginDetailView(card).groups) {
    for (const entry of group.facts) if (entry.label === label) return entry
  }
  return undefined
}

test('all 14 rc.2 Experimental identities carry an exact TUI surface fact and never the stale generic copy', () => {
  const model = experimentalModel()
  assert.equal(cardsOf(model, 'experimental').length, 14)
  for (const name of EXPERIMENTAL_BUNDLE_IDS) {
    const card = cardByName(model, name)!
    const detail = buildPluginDetailView(card)
    const surface = fact(card, 'TUI surface')
    assert.ok(surface !== undefined, `${name} must state its real TUI surface`)
    assert.equal(surface!.tone, 'normal', `${name} surface copy is neutral text`)
    assert.ok(surface!.value.length > 0)
    if (name === '@deepseek-ai/dsh-experimental-auto-review') {
      // B03's only hazard statement is the Owner-frozen danger confirmation on
      // the ENABLED Host row; the static table must not add a second one.
      assert.equal(fact(card, 'Limit'), undefined)
      assert.equal(fact(card, 'Risk'), undefined)
    } else {
      assert.ok(detail.groups.some(group => group.facts.some(entry => entry.label === 'Limit' || entry.label === 'Risk')),
        `${name} must state its limitation/risk`)
    }
    assert.ok(!detail.groups.some(group => group.facts.some(entry =>
      entry.value.includes('Host capability not yet qualified for TUI'))),
    `${name} must not keep the stale generic capability warning`)
    // Availability stays the separate Host fact (these fixtures are missing).
    assert.equal(card.availability, 'missing')
  }
})

test('hazardous rc.2 limitations use warning tone while plain limitations stay dim', () => {
  const model = experimentalModel()
  for (const name of [B02, B04, B06, B11, B13, B14]) {
    assert.equal(fact(cardByName(model, name)!, 'Risk')?.tone, 'warning', `${name} carries a real risk`)
  }
  for (const name of [B01, B07]) {
    assert.equal(fact(cardByName(model, name)!, 'Limit')?.tone, 'dim', `${name} is a neutral limitation`)
  }
  // B03 keeps its existing Owner-frozen danger confirmation as the ONLY hazard
  // statement; the capability copy must not duplicate a conflicting one.
  const autoReview = cardByName(model, '@deepseek-ai/dsh-experimental-auto-review')!
  assert.ok(fact(autoReview, 'TUI surface') !== undefined)
  assert.equal(fact(autoReview, 'Risk'), undefined)
  assert.equal(fact(autoReview, 'Limit'), undefined)
})

test('the bounded copy never changes with installed/enabled state (no fake dynamic qualification)', () => {
  const disabled = experimentalModel()
  const enabled = experimentalModel({ state: { availability: 'installation', installed: false, enabled: true } })
  const supportCopy = (card: PluginCardView) => buildPluginDetailView(card).groups
    .flatMap(group => group.facts)
    // The B03 Owner-frozen danger confirmation is intentionally tied to the
    // ENABLED Host row; it is a separate warning, not capability copy.
    .filter(entry => entry.value !== AUTO_REVIEW_DISABLE_WARNING)
    .filter(entry => entry.label === 'TUI surface' || entry.label === 'Limit' || entry.label === 'Risk')
  for (const name of EXPERIMENTAL_BUNDLE_IDS) {
    assert.deepEqual(supportCopy(cardByName(disabled, name)!), supportCopy(cardByName(enabled, name)!),
      `${name} support copy is static, not derived from enablement`)
  }
  // The disabled host row is not presented as a TUI capability PASS either.
  const enabledCard = cardByName(enabled, B07)!
  assert.equal(enabledCard.enabled, true)
  assert.equal(fact(enabledCard, 'TUI surface')?.value.includes('terminal_*'), true)
})

test('same-name official:false packages and standalone entries never inherit the official copy', () => {
  const fakeBundle = bundle({
    name: B01,
    official: false,
    availability: 'profile',
    installed: true,
    removable: true,
    source: 'file:/tmp/not-official',
  })
  const fakeName = buildPluginManagerModel(
    snapshot([fakeBundle], []),
    classifyPluginPackages(inputs([{
      key: bundleValue(B01),
      bundleName: B01,
      entryIds: [],
      availability: 'profile',
      installed: true,
      source: 'file:/tmp/not-official',
    }]), []),
  )
  const fake = fakeName.cards.find(card => card.name === B01 && card.section === 'third-party')
  assert.ok(fake !== undefined, 'the same-name non-official package is a Third-party card')
  assert.equal(fact(fake!, 'TUI surface'), undefined)

  const entryModel = experimentalModel({ extraRows: [row({ entryId: 'include:fake-b01', moduleName: B01, patchId: 'fake-b01' })] })
  const entry = entryModel.cards.find(card => card.value === entryValue('include:fake-b01'))!
  assert.equal(fact(entry, 'TUI surface'), undefined)
})

test('state their WEB_ONLY boundaries and expose no phantom terminal page action', () => {
  const model = experimentalModel()
  assert.match(fact(cardByName(model, B02)!, 'TUI surface')!.value, /not available in PiTui/)
  assert.match(fact(cardByName(model, B06)!, 'TUI surface')!.value, /not translated reasoning/)
  assert.match(fact(cardByName(model, B12)!, 'TUI surface')!.value, /no PiTui Discover page/)
  for (const name of [B02, B06, B12]) {
    const actions = buildPluginDetailView(cardByName(model, name)!).actions
    assert.deepEqual(actions.map(action => action.value), [PLUGIN_ACTION.officialInstall, PLUGIN_ACTION.back],
      `${name} must not invent a page action`)
  }
})

test('keeps its WEB_ONLY/not-qualified host limit, B13/B14 state their verified provider boundaries, and B11 states foreground/no-guaranteed-Job', () => {
  const model = experimentalModel()
  const b04 = fact(cardByName(model, B04)!, 'Risk')
  assert.ok(b04 !== undefined, 'B04 states its WEB_ONLY host limitation')
  assert.match(b04!.value, /Host activation is not qualified here/u)
  assert.doesNotMatch(b04!.value, /EXTERNAL_UNVERIFIED/u)
  const b13 = fact(cardByName(model, B13)!, 'Risk')
  const b14 = fact(cardByName(model, B14)!, 'Risk')
  assert.ok(b13 !== undefined && b14 !== undefined, 'B13/B14 state their external boundaries')
  assert.match(b13!.value, /DeepSeek Anthropic-compatible endpoint/u)
  assert.match(b13!.value, /no Continue\/Resume/u)
  assert.match(b14!.value, /ChatGPT OAuth/u)
  assert.match(b14!.value, /no Continue\/Resume/u)
  assert.doesNotMatch(b13!.value, /EXTERNAL_UNVERIFIED/u)
  assert.doesNotMatch(b14!.value, /EXTERNAL_UNVERIFIED/u)
  assert.match(fact(cardByName(model, B11)!, 'TUI surface')!.value, /foreground tool/u)
  assert.match(fact(cardByName(model, B11)!, 'Risk')!.value, /No dedicated Ralph UI or guaranteed Job/u)
})
