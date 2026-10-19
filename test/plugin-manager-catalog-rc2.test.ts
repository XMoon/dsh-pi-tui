/**
 * rc.2 real-Host catalog qualification (S4-D1 / D1-A02):
 *
 * The official `PluginManager.listBundles()` Host service is instantiated over
 * a REAL managed profile directory + installation anchor fixture that
 * reproduces the rc.2 catalog shape: the 12 project-maintained Optional
 * bundles are shipped by the installation (available, not selected) and the 2
 * on-demand subagent bundles are discoverable as `missing` with a real
 * `installTarget`. The real Host output then travels through the shared
 * mapping -> stable identity/origin/section classifier -> model.
 *
 * `TEST STAND-INS`: ephemeral profile/installation directories and local
 * package manifests; no public npm download and no network install.
 * `DELIBERATELY ABSENT`: live npm registries, credentials and any unqualified
 * Host bundle consumer.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-catalog-rc2.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import PluginManager, { type BundleInfo } from '@deepseek-ai/dsh-plugin-manager'
import { OPTIONAL_BUNDLES, OFFICIAL_ON_DEMAND_CATALOG } from '@deepseek-ai/dsh-app-boot'
import {
  EXPERIMENTAL_BUNDLE_IDS,
  SELF_BUNDLE,
  classifyPluginPackages,
  type PluginClassificationInput,
} from '../src/app/plugin-manager/classify.ts'
import { buildPluginDetailView, buildPluginManagerModel, bundleValue } from '../src/app/plugin-manager/model.ts'
import { detachPluginManagerSnapshot } from '../src/runtime/plugin-manager-mapping.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { disposeContext } from './support/runner-harness.ts'

const ON_DEMAND = OFFICIAL_ON_DEMAND_CATALOG.map(entry => entry.packageName)

function seedProfile(workRoot: string): {
  profileContext: Record<string, unknown>
  installationAnchor: string
} {
  const profileDir = join(workRoot, 'profile')
  const installationDir = join(workRoot, 'installation')
  const installAnchor = join(installationDir, 'package.json')
  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(installationDir, { recursive: true })
  writeFileSync(installAnchor, JSON.stringify({
    name: 'rc2-catalog-fixture-installation',
    private: true,
    // The installation ships the 12 Optional bundles; the two on-demand
    // subagent bundles are catalog-only.
    dependencies: Object.fromEntries(OPTIONAL_BUNDLES.map(name => [name, '0.2.1-rc.2'])),
  }, null, 2))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'rc2-catalog-fixture-profile',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [], patch: 'cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(profilePatchPath, '[]\n')
  for (const name of OPTIONAL_BUNDLES) {
    const dir = join(profileDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '0.2.1-rc.2',
      private: true,
      dsh: { bundle: { patch: [] } },
    }, null, 2))
  }
  return {
    installationAnchor: installAnchor,
    profileContext: {
      name: 'rc2-catalog-fixture',
      dir: profileDir,
      patchPath: profilePatchPath,
      installAnchor,
      cwd: workRoot,
      home: workRoot,
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    },
  }
}

test('the REAL rc.2 Host listBundles discovers 14/14 official optional/on-demand bundles', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('rc2-catalog-')
  const seeded = seedProfile(workRoot)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('profileContext', seeded.profileContext as never)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginManager, {})

  const service = ctx.get('pluginManager') as { listBundles(): Promise<BundleInfo[]> }
  const bundles = await service.listBundles()
  const names = bundles.map(bundle => bundle.name)
  assert.equal(bundles.length, 14, `the real Host must return 14 bundles, got: ${names.join(', ')}`)
  assert.deepEqual([...names].sort(), [...EXPERIMENTAL_BUNDLE_IDS].sort(), 'catalog identity parity with the frozen rc.2 list')

  const byName = new Map(bundles.map(bundle => [bundle.name, bundle]))
  for (const name of OPTIONAL_BUNDLES) {
    const bundle = byName.get(name)!
    assert.equal(bundle.official, true)
    assert.equal(bundle.optional, true)
    assert.equal(bundle.availability, 'installation', `${name} is shipped by the installation`)
    assert.equal(bundle.installed, false, 'not selected by the profile manifest')
    assert.equal(bundle.enabled, false)
    assert.equal(bundle.removable, false)
  }
  for (const name of ON_DEMAND) {
    const bundle = byName.get(name)!
    assert.equal(bundle.official, true)
    assert.equal(bundle.optional, false, 'on-demand catalog entries are not shipped Optional bundles')
    assert.equal(bundle.availability, 'missing')
    assert.equal(bundle.installed, false)
    assert.equal(bundle.installTarget?.version, '0.2.1-rc.2')
    assert.equal(bundle.installTarget?.spec, `${name}@0.2.1-rc.2`)
  }

  // REAL Host records -> the SHARED mapping -> stable identity -> classifier.
  const snapshot = detachPluginManagerSnapshot({
    bundles,
    plugins: [],
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: { exemptions: {}, warnings: [] },
  })
  const inputs: PluginClassificationInput[] = snapshot.bundles.map(bundle => ({
    key: bundleValue(bundle.name),
    bundleName: bundle.name,
    entryIds: bundle.rows.flatMap(row => row.entryId === undefined ? [] : [String(row.entryId)]),
    official: bundle.official,
    availability: bundle.availability,
    installed: bundle.installed,
  }))
  const model = buildPluginManagerModel(snapshot, classifyPluginPackages(inputs, []))
  const experimental = model.sections.find(section => section.id === 'experimental')!.cards
  assert.equal(experimental.length, 14, 'the Experimental section carries exactly the real Host items')
  assert.deepEqual(experimental.map(card => card.name), [...EXPERIMENTAL_BUNDLE_IDS], 'the frozen B01–B14 order')
  assert.equal(experimental.at(-2)!.name, '@deepseek-ai/dsh-subagent-codex')
  assert.equal(experimental.at(-1)!.name, '@deepseek-ai/dsh-subagent-claude-code')

  for (const card of experimental) {
    assert.equal(card.section, 'experimental')
    assert.equal(card.origin, 'official')
    assert.equal(card.unverified, false)
    const detail = buildPluginDetailView(card)
    if (ON_DEMAND.includes(card.name)) {
      assert.equal(card.availability, 'missing')
      assert.equal(card.canInstall, true)
      assert.ok(detail.actions.some(action => action.value === 'action:official-install' && action.enabled))
    } else {
      assert.equal(card.availability, 'installation')
      assert.equal(card.canInstall, false)
      assert.equal(card.canToggle, true, 'a shipped Optional bundle is switchable by the Host')
      assert.equal(card.canRemove, false, 'a shipped bundle is never removable')
    }
  }
})

test('the TUI self package is the only Current-TUI card when the real Host lists it', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('rc2-self-catalog-')
  const seeded = seedProfile(workRoot)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('profileContext', seeded.profileContext as never)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginManager, {})

  // A profile-owned, non-official package the Host proves through `source`.
  const selfDir = join(workRoot, 'profile', 'node_modules', '@xmoon76', 'dsh-pi-tui')
  mkdirSync(selfDir, { recursive: true })
  writeFileSync(join(selfDir, 'package.json'), JSON.stringify({
    name: SELF_BUNDLE,
    version: '0.5.3',
    private: true,
    dsh: { bundle: { patch: [] } },
  }, null, 2))
  writeFileSync(join(workRoot, 'profile', 'package.json'), JSON.stringify({
    name: 'rc2-catalog-fixture-profile',
    private: true,
    dependencies: { [SELF_BUNDLE]: 'file:./node_modules/@xmoon76/dsh-pi-tui' },
    dsh: { profile: { bundles: [], patch: 'cordis.patch.yml' } },
  }, null, 2))

  const service = ctx.get('pluginManager') as { listBundles(): Promise<BundleInfo[]> }
  const bundles = await service.listBundles()
  const self = bundles.find(bundle => bundle.name === SELF_BUNDLE)
  assert.ok(self !== undefined, 'the Host lists the profile-owned TUI bundle')
  assert.equal(self.official, false)
  assert.equal(self.availability, 'profile')
  assert.ok(self.source !== undefined, 'the Host proves the profile-owned source')

  const snapshot = detachPluginManagerSnapshot({
    bundles,
    plugins: [],
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: { exemptions: {}, warnings: [] },
  })
  const inputs: PluginClassificationInput[] = snapshot.bundles.map(bundle => ({
    key: bundleValue(bundle.name),
    bundleName: bundle.name,
    entryIds: [],
    official: bundle.official,
    availability: bundle.availability,
    installed: bundle.installed,
    ...(bundle.source === undefined ? {} : { source: bundle.source }),
  }))
  const model = buildPluginManagerModel(snapshot, classifyPluginPackages(inputs, []))
  assert.deepEqual(model.sections.find(section => section.id === 'tui')!.cards.map(card => card.name), [SELF_BUNDLE])
  const selfCard = model.cards.find(card => card.name === SELF_BUNDLE)!
  assert.equal(selfCard.isSelf, true)
  assert.equal(selfCard.canToggle, false)
  assert.equal(selfCard.canRemove, false)
})
