/**
 * real-Host catalog qualification (S4-D1 / D1-A02):
 *
 * The official `PluginManager.listBundles()` Host service is instantiated over
 * a REAL managed profile directory + installation anchor fixture that
 * reproduces the official catalog shape: EVERY project-maintained Optional
 * bundle is shipped by the installation (available, not selected) and every
 * on-demand catalog entry is discoverable as `missing` with a real
 * `installTarget`; the catalog size is read from the official rosters, never
 * hardcoded. The real Host output then travels through the shared
 * mapping -> stable identity/origin/section classifier -> model.
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the real `@deepseek-ai/dsh-plugin-manager`
 * Host service, its real profile/patch/installation records, the real
 * `pnpm`-backed profile package operations, the shared Direct adapter/mapping,
 * the real controller/page and the official `listVersions`/`updateBundle`/
 * `plugin-manager/update-state` update path over a real registry install.
 * `TEST STAND-INS`: ephemeral profile/installation directories, isolated
 * HOME/XDG/npm caches, a loopback npm registry and two inert test-only versions
 * of one registry bundle (the real `pnpm add` still runs).
 * `DELIBERATELY ABSENT`: public npm credentials/endpoints, user profiles,
 * native OS permissions, and the physical split-process network qualification.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-catalog-rc2.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { Context, symbols } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import PluginManager, { type BundleInfo } from '@deepseek-ai/dsh-plugin-manager'
import { EXPERIMENTAL_BUNDLES, OFFICIAL_ON_DEMAND_CATALOG, OPTIONAL_BUNDLES } from '@deepseek-ai/dsh-official-bundles'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import {
  EXPERIMENTAL_BUNDLE_IDS,
  SELF_BUNDLE,
  classifyPluginPackages,
  type PluginClassificationInput,
} from '../../src/app/plugin-manager/classify.ts'
import { buildPluginDetailView, buildPluginManagerModel, bundleValue } from '../../src/app/plugin-manager/model.ts'
import { detachPluginManagerSnapshot } from '../../src/runtime/plugin-manager-mapping.ts'
import { DirectPluginManagerPort, type PluginManagerServiceLike } from '../../src/runtime/direct/plugin-manager-direct.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { createRemoteApplicationHostFixture } from '../support/remote-application-fixture.ts'
import { packFixturePackage, startLocalNpmRegistry, type AdditionalRegistryVersion, type LocalNpmRegistryControl } from '../support/local-npm-registry.ts'
import { PluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import type { WorkspaceHarness } from '../support/plugin-workspace-harness.ts'
import { openWorkspace, plain } from '../support/plugin-workspace-harness.ts'
import { disposeContext } from '../support/runner-harness.ts'

const ON_DEMAND = OFFICIAL_ON_DEMAND_CATALOG.map(entry => entry.packageName)
/** The release-only Experimental identities (present upstream, absent from the
 *  frozen legacy Bxx order), in the REAL Host catalog order: shipped Optional
 *  order first, then the on-demand entries. The Experimental section appends
 *  them after the legacy Bxx order in exactly this order. */
const RELEASE_ONLY_EXPERIMENTAL = [...OPTIONAL_BUNDLES, ...ON_DEMAND]
  .filter(name => EXPERIMENTAL_BUNDLES.has(name) && !EXPERIMENTAL_BUNDLE_IDS.includes(name))
/** The legacy Bxx order first, then the release-only members in Host order. */
const EXPERIMENTAL_CATALOG = [...EXPERIMENTAL_BUNDLE_IDS, ...RELEASE_ONLY_EXPERIMENTAL]
/** The COMPLETE official catalog this Host advertises: shipped Optional
 *  bundles plus the on-demand catalog entries, deduplicated by package name. */
const OFFICIAL_CATALOG = [...new Set([...OPTIONAL_BUNDLES, ...ON_DEMAND])]
/** The exact installed DSH runtime this checkout develops against. The Host
 *  derives every install target and exemption grant from this same value, so
 *  the fixture must never hardcode a released version of it. */
const RUNTIME_VERSION = getDshRuntimeVersion()

/** Render the embedded page at ONE explicit local grant: the Settings root
 *  always calls `setViewport` before `render(width)`, and `render` throws
 *  unless the width matches the granted viewport. */
function renderAt(
  page: PluginManagerWorkspacePanel,
  width: number,
  rows: number,
  allowDual = false,
): string[] {
  page.setViewport({ width, rows, allowDual })
  return page.render(width)
}

function seedProfile(workRoot: string, selectedBundles: readonly string[] = []): {
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
    name: 'catalog-fixture-installation',
    private: true,
    // The installation ships every official Optional bundle; the on-demand
    // catalog entries are catalog-only.
    dependencies: Object.fromEntries(OPTIONAL_BUNDLES.map(name => [name, RUNTIME_VERSION])),
  }, null, 2))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'catalog-fixture-profile',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...selectedBundles], patch: 'cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(profilePatchPath, '[]\n')
  for (const name of OPTIONAL_BUNDLES) {
    const dir = join(profileDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: RUNTIME_VERSION,
      private: true,
      dsh: { bundle: { patch: [] } },
    }, null, 2))
  }
  return {
    installationAnchor: installAnchor,
    profileContext: {
      name: 'catalog-fixture',
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

/** A minimal real profile + local bundle fixture for the Host package lifecycle.
 *  No network is needed: pnpm installs the local directory link. */
function seedInstallProfile(workRoot: string): {
  profileContext: Record<string, unknown>
  bundleDir: string
  bundleName: string
} {
  const profileDir = join(workRoot, 'profile')
  const installationDir = join(workRoot, 'installation')
  const bundleDir = join(workRoot, 'fixture-bundle')
  const installAnchor = join(installationDir, 'package.json')
  const profilePatchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(profileDir, { recursive: true })
  mkdirSync(installationDir, { recursive: true })
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(installAnchor, JSON.stringify({ name: 'install-fixture-installation', private: true, dependencies: {} }, null, 2))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'install-fixture-profile',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [], patch: 'cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(profilePatchPath, '[]\n')
  writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(bundleDir, 'index.js'), 'export default function fixtureBundle() {}\n')
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: 'dsh-s4d1-local-fixture-bundle',
    version: '1.0.0',
    main: 'index.js',
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }, null, 2))
  return {
    bundleDir,
    bundleName: 'dsh-s4d1-local-fixture-bundle',
    profileContext: {
      name: 'install-fixture',
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

const CUA_BUNDLE = '@deepseek-ai/dsh-cua-bundle'

interface RealHostPage {
  readonly harness: WorkspaceHarness
  readonly controller: WorkspaceHarness['controller']
  readonly frame: () => string
  readonly waitFor: (predicate: () => boolean, label: string, timeoutMs?: number) => Promise<void>
}

/** The REAL Host service + Direct port + the production Settings→Plugins page
 *  over ONE fixture profile. The test owns teardown; `ready` means the first
 *  authoritative inventory read already happened. */
async function mountRealHostPage(t: TestContext, profileContext: Record<string, unknown>): Promise<RealHostPage> {
  const life = testLifecycle(t)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('profileContext', profileContext as never)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginManager, {})
  const service = ctx.get('pluginManager') as unknown as PluginManagerServiceLike
  const port = new DirectPluginManagerPort({ get: name => name === 'pluginManager' ? service : undefined, on: () => () => false })
  const harness = await openWorkspace({ port })
  life.defer(() => {
    try { harness.close() } catch {}
    try { harness.controller.dispose() } catch {}
    try { harness.app.dispose() } catch {}
  })
  const frame = (): string => plain(harness.vt.getViewport())
  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      await harness.vt.waitForRender()
    }
    throw new Error(`timed out waiting for ${label}: ${frame()}`)
  }
  await waitFor(() => harness.controller.status().state === 'ready', 'the real Host inventory read')
  await harness.waitForFrame()
  return { harness, controller: harness.controller, frame, waitFor }
}

/** Type a search query through the page's own `/` seat and apply it. */
function searchFor(harness: WorkspaceHarness, query: string): void {
  harness.vt.sendInput('/')
  for (const character of query) harness.vt.sendInput(character)
  harness.vt.sendInput('\r')
}

test('the REAL Host listBundles discovers the complete official optional/on-demand catalog', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('catalog-')
  const seeded = seedProfile(workRoot)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('profileContext', seeded.profileContext as never)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginManager, {})

  const service = ctx.get('pluginManager') as { listBundles(): Promise<BundleInfo[]> }
  const bundles = await service.listBundles()
  const names = bundles.map(bundle => bundle.name)
  assert.equal(bundles.length, OFFICIAL_CATALOG.length,
    `the real Host must return every official bundle (${OFFICIAL_CATALOG.length}), got: ${names.join(', ')}`)
  assert.deepEqual([...names].sort(), [...OFFICIAL_CATALOG].sort(),
    'catalog identity parity with the official Optional + on-demand rosters')

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
  for (const entry of OFFICIAL_ON_DEMAND_CATALOG) {
    const bundle = byName.get(entry.packageName)!
    assert.equal(bundle.official, true)
    assert.equal(bundle.optional, false, 'on-demand catalog entries are not shipped Optional bundles')
    assert.equal(bundle.availability, 'missing')
    assert.equal(bundle.installed, false)
    assert.equal(bundle.installTarget?.version, RUNTIME_VERSION)
    assert.equal(bundle.installTarget?.spec, `${entry.packageName}@${RUNTIME_VERSION}`)
    // A platform-scoped entry stays OUT of the default listing: being in the
    // Host roster is not a claim that the TUI can enable it here.
    assert.equal(bundle.listedByDefault, entry.listedByDefault === false ? false : undefined,
      `${entry.packageName} keeps its official default-listing decision`)
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
  // The section is DERIVED from the release rosters: the frozen B01–B14 order
  // first, then every release-added Experimental identity in Host order. A
  // release that adds or drops a member changes this expectation without a
  // local fixed-size snapshot.
  assert.deepEqual(experimental.map(card => card.name), EXPERIMENTAL_CATALOG,
    'the Experimental section is the legacy Bxx order plus the release-only members')
  assert.equal(experimental.length, EXPERIMENTAL_CATALOG.length)
  for (const card of experimental) {
    assert.ok(OFFICIAL_CATALOG.includes(card.name), `${card.name} is a real official catalog identity`)
  }
  // The legacy Bxx block keeps its exact tail (B13/B14) and the release-only
  // members are appended after it, never interleaved.
  assert.equal(experimental[EXPERIMENTAL_BUNDLE_IDS.length - 2]!.name, '@deepseek-ai/dsh-subagent-codex')
  assert.equal(experimental[EXPERIMENTAL_BUNDLE_IDS.length - 1]!.name, '@deepseek-ai/dsh-subagent-claude-code')
  assert.deepEqual(experimental.slice(EXPERIMENTAL_BUNDLE_IDS.length).map(card => card.name), RELEASE_ONLY_EXPERIMENTAL)

  for (const card of experimental) {
    assert.equal(card.section, 'experimental')
    assert.equal(card.origin, 'official')
    assert.equal(card.unverified, false)
    const detail = buildPluginDetailView(card)
    const facts = detail.groups.flatMap(group => group.facts)
    const surface = facts.find(fact => fact.label === 'TUI surface')
    assert.ok(surface !== undefined, `${card.name} carries the bounded TUI surface fact`)
    assert.equal(surface!.tone, 'normal')
    assert.ok(!facts.some(fact => fact.value.includes('Host capability not yet qualified for TUI')),
      `${card.name} never shows the stale generic capability warning`)
    const upgrade = facts.find(fact => fact.label === 'Upgrade')
    assert.ok(upgrade !== undefined, `${card.name} states the F10 route from real Host facts`)
    if (ON_DEMAND.includes(card.name)) {
      assert.equal(card.availability, 'missing')
      assert.equal(card.installTarget?.spec, `${card.name}@${RUNTIME_VERSION}`)
      assert.equal(facts.find(fact => fact.label === 'Current version')?.value, 'unavailable')
      const installAction = detail.actions.find(action => action.value === 'action:official-install')!
      if (card.error?.code === 'unsupported-platform') {
        // The Host's OWN platform refusal (for example the darwin-only CUA
        // bundle on this Host) is not an install route: the official catalog
        // Install stays disabled with the Host reason and the guidance says so.
        assert.equal(card.canInstall, false)
        assert.match(card.installBlockedReason ?? '', /unsupported-platform/u)
        assert.equal(installAction.enabled, false)
        assert.match(installAction.reason ?? '', /unsupported-platform/u)
        assert.equal(upgrade!.value, `Install unavailable: ${card.installBlockedReason}`)
      } else {
        assert.equal(card.canInstall, true)
        assert.equal(installAction.enabled, true)
        assert.equal(upgrade!.value,
          `Install: Use the official offered target ${card.name}@${RUNTIME_VERSION} (version ${RUNTIME_VERSION}); this is not an in-place update.`)
        assert.match(upgrade!.value, /this is not an in-place update/)
      }
    } else {
      assert.equal(card.availability, 'installation')
      assert.equal(card.canInstall, false)
      assert.equal(
        card.canToggle,
        true,
        `${card.name}: ${card.toggleBlockedReason ?? 'no blocked reason'}; Host error: ${JSON.stringify(card.error ?? null)}`,
      )
      assert.equal(card.canRemove, false, 'a shipped bundle is never removable')
      assert.equal(upgrade!.value, 'Upgrade: Shipped with DSH. Upgrade the DSH installation to change this bundle version; Plugin Manager cannot update it in place.')
      assert.ok(!detail.actions.some(action => action.value === 'action:remove'), 'F10 never adds a Remove action to a shipped bundle')
    }
  }
  // The two external on-demand rows carry their verified-boundary copy through
  // the REAL Host catalog (not a static section flag).
  for (const name of ['@deepseek-ai/dsh-subagent-codex', '@deepseek-ai/dsh-subagent-claude-code']) {
    const card = experimental.find(candidate => candidate.name === name)!
    const risk = buildPluginDetailView(card).groups.flatMap(group => group.facts).find(fact => fact.label === 'Risk')
    assert.match(risk?.value ?? '', /no Continue\/Resume/u)
    assert.doesNotMatch(risk?.value ?? '', /EXTERNAL_UNVERIFIED/u)
  }
})

test('the TUI self package is the only Current-TUI card when the real Host lists it', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('self-catalog-')
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
    name: 'catalog-fixture-profile',
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


test('the REAL Host install/toggle/remove lifecycle flows through the ONE Direct port', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('install-')
  const seeded = seedInstallProfile(workRoot)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('profileContext', seeded.profileContext as never)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginManager, {})
  const service = ctx.get('pluginManager') as unknown as PluginManagerServiceLike
  const port = new DirectPluginManagerPort({ get: name => name === 'pluginManager' ? service : undefined, on: () => () => false })

  const inspection = await port.inspect(seeded.bundleDir)
  assert.equal(inspection.status, 'accepted')
  assert.equal(inspection.kind, 'path')
  assert.equal(inspection.bundle, true)
  assert.equal(inspection.name, seeded.bundleName)
  assert.equal(inspection.version, '1.0.0')

  const installed = await port.startInstall({
    requestId: 'local-install',
    spec: seeded.bundleDir,
    registry: null,
    enabled: true,
  })
  assert.equal(installed.application, 'restart-required')
  assert.equal(installed.restartReason, 'no-hmr')
  assert.equal(installed.bundle, seeded.bundleName)
  assert.equal(installed.version, '1.0.0')
  assert.deepEqual([...(installed.registries ?? [])], [null])
  assert.equal(installed.packageResult?.exitCode, 0)
  assert.equal(installed.packageResult?.truncated, false)
  assert.ok((installed.packageResult?.output ?? '').includes('Done'))
  assert.equal('logPath' in (installed.packageResult ?? {}), false, 'no profile log path crosses the port')

  const afterInstall = await port.snapshot()
  const installedCard = afterInstall.bundles.find(bundle => bundle.name === seeded.bundleName)
  assert.ok(installedCard !== undefined)
  assert.equal(installedCard.availability, 'profile')
  assert.equal(installedCard.installed, true)
  assert.equal(installedCard.enabled, true)
  assert.equal(installedCard.removable, true)
  assert.equal(installedCard.version, '1.0.0')
  assert.match(installedCard.source ?? '', /^link:/)

  const disabled = await port.setBundleEnabled(seeded.bundleName, false)
  assert.equal(disabled.changed, true)
  assert.equal(disabled.application, 'restart-required')
  const afterDisable = await port.snapshot()
  assert.equal(afterDisable.bundles.find(bundle => bundle.name === seeded.bundleName)?.enabled, false)

  const removed = await port.removeBundle(seeded.bundleName)
  assert.equal(removed.stage, 'remove')
  assert.equal(removed.changed, true)
  assert.equal(removed.application, 'restart-required')
  assert.equal('logPath' in (removed.packageResult ?? {}), false)
  const afterRemove = await port.snapshot()
  assert.equal(afterRemove.bundles.find(bundle => bundle.name === seeded.bundleName), undefined)
})


test('the REAL Host -> Direct port -> controller -> workspace page install chain reaches the UI', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('ui-install-')
  const seeded = seedInstallProfile(workRoot)
  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('profileContext', seeded.profileContext as never)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginManager, {})
  const service = ctx.get('pluginManager') as unknown as PluginManagerServiceLike
  const port = new DirectPluginManagerPort({ get: name => name === 'pluginManager' ? service : undefined, on: () => () => false })

  // The ONE real Settings lease hosts the embedded page through the REAL
  // `Settings → Plugins` factory; it owns the controller's claim and grants the
  // page's local viewport per frame (no second TuiApp, no hand-built owner).
  const harness = await openWorkspace({ port })
  life.defer(() => {
    try { harness.close() } catch {}
    try { harness.controller.dispose() } catch {}
    try { harness.app.dispose() } catch {}
  })
  const { vt, controller, panel } = harness

  const settle = async (rounds = 10): Promise<void> => {
    await harness.waitForFrame(rounds)
  }
  const frame = (): string => plain(vt.getViewport())
  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      await vt.waitForRender()
    }
    throw new Error(`timed out waiting for ${label}: ${frame()}`)
  }

  await settle()
  assert.match(frame(), /Settings · Plugins/)

  vt.sendInput('i')
  await settle()
  for (const character of seeded.bundleDir) vt.sendInput(character)
  await settle()
  vt.sendInput('\r') // Inspect
  await waitFor(() => controller.installView()?.phase === 'confirm', 'the real Host inspection')
  // The controller's phase is set BEFORE it asks for a repaint, so the state
  // can be 'confirm' while the terminal still shows the inspecting frame.
  // The Install key is refused in that window (the workspace requires the
  // install action to be PAINTED), so the confirmation is waited for as a
  // FRAME, not as controller state.
  await waitFor(() => /offered version 1\.0\.0/u.test(frame()),
    'the confirmation frame is painted')
  assert.match(frame(), /offered version 1\.0\.0/)
  vt.sendInput('\r') // Install
  await waitFor(() => controller.installView()?.phase === 'done', 'the real Host local install')
  await waitFor(() => controller.status().state === 'ready', 'the authoritative install reread')
  // The controller's state leads the repaint, so the result is waited for as
  // a FRAME: the outcome summary is what the case actually asserts.
  await waitFor(() => /installed version 1\.0\.0/u.test(frame()),
    'the install outcome frame is painted')
  const view = frame()
  assert.match(view, /installed version 1\.0\.0/)
  assert.equal((view.match(/Done in/g) ?? []).length, 1, 'the Host package output is shown once, not twice')
  assert.equal((view.match(/enable (applied|restart-required)/g) ?? []).length, 1, 'the outcome summary is shown once, not twice')
  const reread = await port.snapshot()
  const bundle = reread.bundles.find(candidate => candidate.name === seeded.bundleName)
  assert.equal(bundle?.installed, true)
  assert.equal(bundle?.enabled, true)

  // The SAME real chain now toggles and removes through the authoritative
  // reread and the visible list/detail (no direct controller shortcut).
  vt.sendInput('\x1b') // leave the install result view
  await settle()
  vt.sendInput('/')
  await settle()
  for (const character of seeded.bundleName) vt.sendInput(character)
  await settle()
  vt.sendInput('\r') // apply search
  await settle()
  vt.sendInput('\r') // Details
  await waitFor(() => frame().includes('[Details]'), 'the Details focus frame')
  // Re-anchor the painted frame with the current authoritative model before the
  // action key: an invalidation read may have settled after the last queued paint.
  // Keep the rendered frame as evidence that the action is actually visible.
  const disableFrame = plain(renderAt(panel, 96, 36, true))
  assert.match(disableFrame, /> Disable…/, 'the toggle action is painted before it is invoked')
  await vt.waitForRender()
  assert.match(frame(), /> Disable…/,
    'the mounted VirtualTerminal viewport shows the toggle action before the key')
  vt.sendInput('\r') // Disable…
  await waitFor(() => controller.model().cards.find(card => card.name === seeded.bundleName)?.enabled === false,
    'the real Host disable + authoritative reread')
  // The controller's state leads the repaint: the toggled row is waited for
  // as a FRAME, so the case never reads a frame painted before the change.
  await waitFor(() => /Selected in profile/u.test(frame()) && /> Enable…/u.test(frame()),
    'the toggled row is painted')
  // The value column wraps onto the next physical row on this frame, so the
  // painted evidence is the honest Status label plus the flipped action.
  assert.match(frame(), /Selected in profile/)
  assert.match(frame(), /> Enable…/)

  vt.sendInput('\x1b[B') // Enable… -> Remove…
  await settle()
  vt.sendInput('\r') // open confirmation
  await settle()
  vt.sendInput('\x1b[A') // Cancel -> Remove
  await settle()
  const confirmFrame = plain(renderAt(panel, 120, 36))
  assert.match(confirmFrame, /> Remove/, 'the selected Remove action is painted before confirmation')
  await vt.waitForRender()
  assert.match(frame(), /> Remove/,
    'the mounted VirtualTerminal viewport shows the selected Remove action')
  vt.sendInput('\r') // confirm
  await waitFor(() => controller.model().cards.every(card => card.name !== seeded.bundleName),
    'the real Host removal + authoritative reread')
  // The controller's state leads the repaint: the emptied list is waited for
  // as a FRAME, so the case never reads a frame painted before the removal.
  await waitFor(() => /No matching plugins|No plugins/u.test(frame()),
    'the emptied plugin list is painted')
  assert.match(frame(), /No matching plugins|No plugins/)
  assert.equal((await port.snapshot()).bundles.find(candidate => candidate.name === seeded.bundleName), undefined)
})


test('an APPLIED real-Host version exemption reaches the card Detail without an incompatible error', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('exempt-')
  const seeded = seedInstallProfile(workRoot)
  const profileDir = seeded.profileContext.dir as string
  // This package requires an impossible engines.dsh; the profile's exact
  // package-version exemption is the only reason the Host accepts it. The
  // accepted row therefore has NO incompatible error, but its exemption must
  // still be visible in the Detail.
  writeFileSync(join(seeded.bundleDir, 'package.json'), JSON.stringify({
    name: seeded.bundleName,
    version: '1.0.0',
    main: 'index.js',
    engines: { dsh: '>=9' },
    dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(profileDir, 'compatibility.json'), JSON.stringify({
    [`${seeded.bundleName}@1.0.0`]: [RUNTIME_VERSION],
  }, null, 2))

  const ctx = new Context()
  life.defer(() => disposeContext(ctx))
  ctx.provide('profileContext', seeded.profileContext as never)
  await ctx.plugin(Loader)
  await ctx.plugin(PluginManager, {})
  const service = ctx.get('pluginManager') as unknown as PluginManagerServiceLike
  const port = new DirectPluginManagerPort({ get: name => name === 'pluginManager' ? service : undefined, on: () => () => false })

  const installed = await port.startInstall({
    requestId: 'exempt-install',
    spec: seeded.bundleDir,
    registry: null,
    enabled: true,
  })
  assert.equal(installed.application, 'restart-required')
  const snapshot = await port.snapshot()
  const row = snapshot.bundles.find(bundle => bundle.name === seeded.bundleName)
  assert.ok(row !== undefined)
  assert.equal(row.error, undefined, 'the Host accepted the exempted package without an incompatible error')
  assert.deepEqual(snapshot.exemptions, [
    { packageVersion: `${seeded.bundleName}@1.0.0`, runtimeVersions: [RUNTIME_VERSION] },
  ])

  const inputs: PluginClassificationInput[] = snapshot.bundles.map(bundle => ({
    key: bundleValue(bundle.name),
    bundleName: bundle.name,
    entryIds: bundle.rows.flatMap(entry => entry.entryId === undefined ? [] : [String(entry.entryId)]),
    official: bundle.official,
    availability: bundle.availability,
    installed: bundle.installed,
    ...(bundle.source === undefined ? {} : { source: bundle.source }),
  }))
  const model = buildPluginManagerModel(snapshot, classifyPluginPackages(inputs, []))
  const card = model.cards.find(candidate => candidate.name === seeded.bundleName)!
  const detail = buildPluginDetailView(card, snapshot.exemptions)
  assert.ok(detail.groups.some(group => group.facts.some(fact =>
    fact.label === 'Exemption' && fact.tone === 'success' && fact.value.includes(`${seeded.bundleName}@1.0.0`))),
  'the applied real-Host exemption is visible on the card')
})

test('a real Host platform refusal stays out of the default list and never installs', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('cua-default-')
  const seeded = seedProfile(workRoot)
  const page = await mountRealHostPage(t, seeded.profileContext)
  const profileDir = seeded.profileContext.dir as string
  const refused = process.platform !== 'darwin'
  const card = page.controller.model().cards.find(candidate => candidate.name === CUA_BUNDLE)!
  const painted = card.title ?? card.name

  // The REAL Host facts the page consumes.
  assert.equal(card.enabled, false)
  assert.equal(card.installed, false)
  assert.equal(card.listedByDefault, false, 'the Host default-listing decision survives Host -> port -> model')
  if (refused) {
    assert.equal(card.error?.code, 'unsupported-platform')
    assert.equal(card.canInstall, false, 'the Host platform refusal blocks the official catalog Install')
  }

  // A: the untouched list is the Host default listing, and ONE existing hint
  // line names the explicit search route without adding a second catalog page.
  assert.doesNotMatch(page.frame(), new RegExp(painted))
  assert.match(page.frame(), /\/ searches hidden official bundles/u)

  // The explicit search reads the SAME model card.
  searchFor(page.harness, CUA_BUNDLE)
  await page.harness.waitForFrame()
  await page.waitFor(() => page.frame().includes(painted), 'the explicit search finds the hidden bundle')
  if (refused) assert.match(page.frame(), /\[error\]/)

  page.harness.vt.sendInput('\r') // Details
  await page.waitFor(() => page.frame().includes('[Details]'), 'the Details focus frame')
  // The CUA card's Detail is longer than the pane: the Status/Source facts are
  // read on the initial frame, then one navigation reveals the Actions block.
  assert.match(page.frame(), /Default listing/u)
  page.harness.vt.sendInput('\x1b[B')
  page.harness.vt.sendInput('\x1b[A')
  await page.harness.waitForFrame()
  if (refused) {
    await page.waitFor(() => /unsupported-platform/u.test(page.frame()), 'the Host error is painted in Detail')
    // Enter on the disabled Install action explains the Host refusal and
    // creates NOTHING: no request id, no install dispatch, no profile write.
    page.harness.vt.sendInput('\r')
    await page.waitFor(() => /unsupported-platform/u.test(page.frame()), 'the refusal is explained')
    assert.equal(page.controller.installView(), undefined, 'no official install request was created')
  } else {
    assert.match(page.frame(), /> Install…/u, 'a supported platform keeps the real Install route')
  }
  const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(profile.dependencies, {}, 'the refused platform caused no package write')
  assert.deepEqual(profile.dsh.profile.bundles, [], 'the refused platform caused no selection')

  // Matrix E control: an ordinary on-demand entry the Host does not refuse
  // keeps its Install capability in the same real catalog.
  const codex = page.controller.model().cards.find(candidate => candidate.name === '@deepseek-ai/dsh-subagent-codex')!
  assert.equal(codex.canInstall, true)
  assert.equal(codex.installBlockedReason, undefined)
})

test('a selected bundle the Host refuses is disabled through the Host and leaves the default list', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('cua-selected-')
  const seeded = seedProfile(workRoot, [CUA_BUNDLE])
  const page = await mountRealHostPage(t, seeded.profileContext)
  const profileDir = seeded.profileContext.dir as string
  const refused = process.platform !== 'darwin'
  const cardOf = (): ReturnType<WorkspaceHarness['controller']['model']>['cards'][number] | undefined =>
    page.controller.model().cards.find(candidate => candidate.name === CUA_BUNDLE)
  const painted = cardOf()!.title ?? CUA_BUNDLE

  // B: a SELECTED bundle stays listed (and manageable) whatever its default
  // listing says.
  assert.equal(cardOf()!.enabled, true)
  await page.waitFor(() => page.frame().includes(painted), 'the selected bundle is painted')
  if (refused) assert.match(page.frame(), /\[error\]/)

  searchFor(page.harness, CUA_BUNDLE)
  await page.harness.waitForFrame()
  page.harness.vt.sendInput('\r') // Details
  await page.waitFor(() => page.frame().includes('[Details]'), 'the Details focus frame')
  assert.match(page.frame(), /Selected in profile/u)
  // A missing bundle's actions are `Install…` then `Disable…`: one navigation
  // selects the recovery action and reveals the Actions block.
  page.harness.vt.sendInput('\x1b[B')
  await page.harness.waitForFrame()
  const detail = page.frame()
  assert.match(detail, /> Disable…/u, 'a selected refused bundle keeps an executable Disable')
  if (refused) assert.match(detail, /unsupported-platform/u)

  page.harness.vt.sendInput('\r') // Disable…
  await page.waitFor(() => cardOf()?.enabled === false, 'the real Host disable + authoritative reread')
  // The real profile selection is gone.
  const profile = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.deepEqual(profile.dsh.profile.bundles, [])
  // The explicit query still matches the card, so clearing it (the page's own
  // Esc-clear seat) is what restores the Host default listing.
  page.harness.vt.sendInput('/')
  await page.harness.waitForFrame()
  page.harness.vt.sendInput('\x1b')
  await page.harness.waitForFrame()
  await page.waitFor(() => !page.frame().includes(painted), 'the default list hides the unselected bundle')

  // The card is NOT deleted from the Host catalog / model: an explicit search
  // reads it again with its Host facts intact, and no hidden card becomes the
  // selected target of the list frame behind it.
  searchFor(page.harness, CUA_BUNDLE)
  await page.harness.waitForFrame()
  await page.waitFor(() => page.frame().includes(painted), 'the explicit search still reaches it')
  assert.equal(cardOf()!.enabled, false)
  assert.equal(cardOf()!.error?.code, refused ? 'unsupported-platform' : undefined)
})

test('a profile-owned bundle the Host refuses keeps Disable and the Host-permitted Remove separately executable', async (t) => {
  const life = testLifecycle(t)
  const workRoot = life.tempDir('cua-profile-owned-')
  const seeded = seedProfile(workRoot, [CUA_BUNDLE])
  const profileDir = seeded.profileContext.dir as string
  // Narrow deterministic INPUT control (not darwin hardware evidence): this
  // profile's OWN dependency declares the platform, so the REAL Host reports
  // availability:'profile', installed:true, selected:true, removable:true and
  // the unsupported-platform error on every platform.
  const packageDir = join(profileDir, 'node_modules', CUA_BUNDLE)
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: CUA_BUNDLE,
    version: RUNTIME_VERSION,
    dsh: { bundle: { patch: [], platforms: ['darwin'] } },
  }, null, 2))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'catalog-fixture-profile',
    private: true,
    dependencies: { [CUA_BUNDLE]: `file:./node_modules/${CUA_BUNDLE}` },
    dsh: { profile: { bundles: [CUA_BUNDLE], patch: 'cordis.patch.yml' } },
  }, null, 2))

  const page = await mountRealHostPage(t, seeded.profileContext)
  const cardOf = (): ReturnType<WorkspaceHarness['controller']['model']>['cards'][number] | undefined =>
    page.controller.model().cards.find(candidate => candidate.name === CUA_BUNDLE)

  // C: the Host proves every fact the recovery actions depend on.
  const card = cardOf()!
  const painted = card.title ?? CUA_BUNDLE
  assert.equal(card.availability, 'profile')
  assert.equal(card.installed, true)
  assert.equal(card.enabled, true)
  assert.equal(card.removable, true)
  assert.equal(card.error?.code, 'unsupported-platform')
  assert.equal(card.canToggle, true, 'the enable error does not lock Disable')
  assert.equal(card.canRemove, true, 'the enable error does not lock Remove')

  searchFor(page.harness, CUA_BUNDLE)
  await page.harness.waitForFrame()
  page.harness.vt.sendInput('\r') // Details
  await page.waitFor(() => page.frame().includes('[Details]'), 'the Details focus frame')
  assert.match(page.frame(), new RegExp(painted))
  // One navigation reveals the Actions block; the next enters Remove.
  page.harness.vt.sendInput('\x1b[B') // Disable… -> Remove… (reveals Actions)
  await page.harness.waitForFrame()
  const detail = page.frame()
  assert.match(detail, /> Remove…/u)
  assert.match(detail, /Disable…/u)
  assert.match(detail, /unsupported-platform/u)
  page.harness.vt.sendInput('\r')
  await page.waitFor(() => page.frame().includes('Cancel'), 'the destructive Remove confirmation')
  page.harness.vt.sendInput('\x1b') // cancel
  await page.harness.waitForFrame()
  assert.match(page.frame(), /> Remove…/u, 'the confirmation returns to the same action')
  const afterCancel = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(afterCancel.dependencies[CUA_BUNDLE], `file:./node_modules/${CUA_BUNDLE}`,
    'cancel dispatched no Host removal')

  // Disable is independent: the same card is disabled through the real Host
  // while the Remove capability stays Host-permitted and the refusal visible.
  page.harness.vt.sendInput('\x1b[A') // Remove… -> Disable…
  await page.harness.waitForFrame()
  assert.match(page.frame(), /> Disable…/u)
  page.harness.vt.sendInput('\r')
  await page.waitFor(() => cardOf()?.enabled === false, 'the real Host disable + authoritative reread')
  assert.equal(cardOf()!.error?.code, 'unsupported-platform',
    'the real Host error is never erased by the local disable result')
  assert.equal(cardOf()!.canRemove, true, 'Remove remains available after the disable result')
})

// ── S5-PR2: REAL Host registry update qualification (L5) ────────────────────

/** The test-owned registry bundle name (never a production package). */
const UPDATE_FIXTURE_BUNDLE = 'dsh-s5-pr2-update-fixture'
/** The published versions the update tests install and offer. */
const UPDATE_FIXTURE_FROM = '1.0.0'
const UPDATE_FIXTURE_TO = '1.1.0'

interface UpdateFixture {
  readonly host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>
  readonly registry: LocalNpmRegistryControl
  readonly port: DirectPluginManagerPort
  readonly profileDir: string
}

interface UpdateFixtureOptions {
  /** Publish versions newer than 1.0.0 (default: one compatible bundle 1.1.0). */
  readonly additional?: readonly {
    readonly version: string
    readonly bundle?: boolean
    readonly enginesDsh?: string
    readonly deprecated?: string
    readonly prerelease?: boolean
  }[]
  /** Withhold the target tarball body (the deterministic cancel window). */
  readonly slowTarball?: boolean
  /** Provide the HMR service the Host's remove/install/restore branch needs. */
  readonly hmr?: boolean
}

function updateFixturePackage(
  root: string,
  version: string,
  options: { readonly bundle?: boolean; readonly enginesDsh?: string } = {},
): { manifest: Record<string, unknown>; packed: ReturnType<typeof packFixturePackage> } {
  const manifest: Record<string, unknown> = {
    name: UPDATE_FIXTURE_BUNDLE,
    version,
    main: 'index.js',
    ...(options.bundle === false ? {} : { dsh: { bundle: { patch: 'cordis.patch.yml' } } }),
    ...(options.enginesDsh === undefined ? {} : { engines: { dsh: options.enginesDsh } }),
  }
  const packed = packFixturePackage(root, {
    name: UPDATE_FIXTURE_BUNDLE,
    version,
    manifest,
    files: options.bundle === false
      ? { 'index.js': 'export default function noBundle() {}\n' }
      : { 'cordis.patch.yml': '[]\n', 'index.js': 'export default function bundle() {}\n' },
  }, { directory: 'package', tarballDirectory: 'tarball' })
  return { manifest, packed }
}

/**
 * A REAL `@deepseek-ai/dsh-plugin-manager` Host over an isolated managed
 * profile, seeded with a REAL registry install of 1.0.0 from a loopback
 * registry that also serves the update targets.
 */
async function startUpdateFixture(
  t: TestContext,
  presetId: string,
  options: UpdateFixtureOptions = {},
): Promise<UpdateFixture> {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, presetId, {
    pluginManagerProfile: { emptyProfile: true },
    isolateHome: true,
  })
  if (options.hmr !== false) {
    // The official Host reads this service to decide between its in-place
    // install and the remove/install/restore branch. The stand-in provides
    // exactly that seam (exclusive execution + no restart requirement).
    host.ctx.provide('hmr', {
      runExclusive: <T>(fn: () => Promise<T>) => fn(),
      reconcileProfile: async () => ({ warnings: [], pending: [] }),
    })
  }
  const packRoot = life.tempDir(`${presetId}-pack-`)
  const from = updateFixturePackage(join(packRoot, 'from'), UPDATE_FIXTURE_FROM)
  const additional = (options.additional ?? [{ version: UPDATE_FIXTURE_TO }]).map((entry) => {
    const target = updateFixturePackage(join(packRoot, `to-${entry.version}`), entry.version, {
      ...(entry.bundle === undefined ? {} : { bundle: entry.bundle }),
      ...(entry.enginesDsh === undefined ? {} : { enginesDsh: entry.enginesDsh }),
    })
    const version: AdditionalRegistryVersion = {
      packed: target.packed,
      manifest: target.manifest,
      publishedAt: '2026-02-03T00:00:00.000Z',
      tags: ['latest'],
      ...(entry.deprecated === undefined ? {} : { deprecated: entry.deprecated }),
    }
    return version
  })
  const registry = await startLocalNpmRegistry(from.packed, {
    manifest: from.manifest,
    ...(options.slowTarball === true ? { slowTarball: true } : {}),
    additionalVersions: additional,
  })
  life.defer(() => registry.close())
  const port = new DirectPluginManagerPort(host.ctx)
  const seeded = await port.startInstall({
    requestId: 'seed-1.0.0',
    spec: `${UPDATE_FIXTURE_BUNDLE}@${UPDATE_FIXTURE_FROM}`,
    registry: registry.url,
    enabled: true,
  })
  assert.equal(seeded.application, options.hmr === false ? 'restart-required' : 'applied')
  assert.equal(seeded.version, UPDATE_FIXTURE_FROM)
  return { host, registry, port, profileDir: host.pluginManager!.profileDir }
}

function readProfileDependencies(profileDir: string): Record<string, string> {
  const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  return manifest.dependencies ?? {}
}

test('the REAL Host TUI path lists versions, confirms one exact target and updates 1.0.0 → 1.1.0', async (t) => {
  const fixture = await startUpdateFixture(t, 's5-pr2-real-update-ui')
  // Count the REAL Host updateBundle dispatches on the unwrapped service.
  const proxy = fixture.host.ctx.get('pluginManager') as unknown as Record<symbol, unknown> & {
    updateBundle(name: string, version: string, options?: unknown): Promise<unknown>
  }
  const service = (proxy[symbols.original] ?? proxy) as typeof proxy
  const originalUpdate = service.updateBundle
  let updateDispatches = 0
  service.updateBundle = function patchedUpdate(this: unknown, name: string, version: string, options?: unknown): Promise<unknown> {
    updateDispatches += 1
    return originalUpdate.call(this, name, version, options)
  }
  t.after(() => { service.updateBundle = originalUpdate })
  const harness = await openWorkspace({ port: fixture.port })
  t.after(() => {
    try { harness.close() } catch {}
    try { harness.controller.dispose() } catch {}
    try { harness.app.dispose() } catch {}
  })
  // A bounded RENDER wait (not a blind sleep): the frame must have landed.
  const paint = async (rounds = 10): Promise<void> => { await harness.waitForFrame(rounds) }
  const frame = (): string => plain(harness.vt.getViewport())
  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise<void>(resolve => setTimeout(resolve, 10))
      await harness.vt.waitForRender()
    }
    throw new Error(`timed out waiting for ${label}: ${frame()}`)
  }
  await waitFor(() => harness.controller.status().state === 'ready', 'the real Host inventory read')
  await paint()
  const card = harness.controller.model().cards.find(candidate => candidate.name === UPDATE_FIXTURE_BUNDLE)
  assert.ok(card !== undefined, 'the real registry install is listed')
  assert.equal(card.updatable, true, 'the Host declares the profile registry dependency updatable')

  // The REAL user path: search -> Details -> Check updates….
  searchFor(harness, UPDATE_FIXTURE_BUNDLE)
  await paint()
  harness.vt.sendInput('\r') // Details
  await waitFor(() => frame().includes('[Details]'), 'the Details focus frame')
  harness.vt.sendInput('\x1b[B') // Disable… -> Check updates…
  await paint()
  harness.vt.sendInput('\r')
  await waitFor(() => harness.panel.currentView() === 'update', 'the Check updates… entry')
  await waitFor(() => /Update bundle · dsh-s5-pr2-update-fixture/u.test(frame()), 'the Update page identity')
  await waitFor(() => /\b1\.1\.0\b/u.test(frame()), 'the Host listVersions target')
  assert.match(frame(), /Installed\s+1\.0\.0/u)
  assert.match(frame(), /http:\/\/127\.0\.0\.1:\d+\//u, 'the Host-answered registry is shown')
  assert.doesNotMatch(frame(), /secret/u)

  // Enter: select the exact version and open the confirmation.
  harness.vt.sendInput('\r')
  await waitFor(() => harness.controller.updateView()?.phase === 'confirm', 'the confirmation')
  await waitFor(() => /From\s+1\.0\.0/u.test(frame()), 'the confirmation facts frame')
  assert.match(frame(), /To\s+1\.1\.0/u)
  assert.match(frame(), /> Cancel/u, 'Cancel is the default choice')
  harness.vt.sendInput('\x1b[A') // Cancel -> Confirm update
  await paint()
  harness.vt.sendInput('\r')
  await waitFor(() => harness.controller.updateView()?.phase === 'running', 'the running update')
  await waitFor(() => harness.controller.updateView()?.readback === 'ready', 'the authoritative reread')
  await waitFor(() => harness.controller.updateView()?.phase === 'done', 'the official update result')
  await waitFor(() => /Observed installed version\s+1\.1\.0/u.test(frame()), 'the fresh installed version frame')
  const view = frame()
  assert.match(view, /Target result/u)
  assert.match(view, /Outcome\s+applied/u)
  assert.match(view, /Restore result/u)
  assert.match(view, /Not required; the Host did not reinstall the former version\./u)

  // The authoritative Host truth: package version and profile dependency.
  const reread = await fixture.port.snapshot()
  assert.equal(reread.bundles.find(candidate => candidate.name === UPDATE_FIXTURE_BUNDLE)?.version, UPDATE_FIXTURE_TO)
  assert.equal(readProfileDependencies(fixture.profileDir)[UPDATE_FIXTURE_BUNDLE], UPDATE_FIXTURE_TO)
  assert.equal(updateDispatches, 1, 'the real Host updateBundle ran exactly once')
})

test('the REAL Host no-HMR update reports restart-required and still installs the target', async (t) => {
  const fixture = await startUpdateFixture(t, 's5-pr2-real-update-nohmr', { hmr: false })
  const list = await fixture.port.listVersions(UPDATE_FIXTURE_BUNDLE)
  assert.equal(list.status, 'listed')
  if (list.status !== 'listed') return
  assert.equal(list.versions[0]?.version, UPDATE_FIXTURE_TO)
  assert.equal(list.registry, `${fixture.registry.url}/`, 'the Host normalizes the answered registry')
  const result = await fixture.port.updateBundle(UPDATE_FIXTURE_BUNDLE, UPDATE_FIXTURE_TO, list.registry, 'req-nohmr')
  assert.equal(result.step, 'install')
  assert.equal(result.result.application, 'restart-required')
  assert.equal(result.result.restartReason, 'no-hmr')
  assert.equal(result.restore, undefined, 'no removal/restore happens without HMR')
  const snapshot = await fixture.port.snapshot()
  assert.equal(snapshot.bundles.find(candidate => candidate.name === UPDATE_FIXTURE_BUNDLE)?.version, UPDATE_FIXTURE_TO)
  assert.equal(readProfileDependencies(fixture.profileDir)[UPDATE_FIXTURE_BUNDLE], UPDATE_FIXTURE_TO)
})

test('the REAL Host refuses an older, a non-bundle and an incompatible target with zero profile writes', async (t) => {
  const fixture = await startUpdateFixture(t, 's5-pr2-real-update-refusals', {
    additional: [
      { version: UPDATE_FIXTURE_TO },
      { version: '1.2.0', bundle: false },
      { version: '1.3.0', enginesDsh: '>=9' },
    ],
  })
  const before = readFileSync(join(fixture.profileDir, 'package.json'), 'utf8')
  const list = await fixture.port.listVersions(UPDATE_FIXTURE_BUNDLE)
  assert.equal(list.status, 'listed')
  if (list.status !== 'listed') return
  const byVersion = new Map(list.versions.map(version => [version.version, version]))
  assert.equal(byVersion.get('1.2.0')?.bundle, false)
  assert.equal(byVersion.get('1.3.0')?.incompatible?.requirements['engines.dsh'], '>=9')

  // A version newer than the installed one is required.
  const older = await fixture.port.updateBundle(UPDATE_FIXTURE_BUNDLE, '0.9.0', list.registry, 'req-older')
  assert.equal(older.step, 'check')
  assert.equal(older.result.application, 'failed')
  assert.match(older.result.error?.diagnostic ?? '', /not a version newer/u)
  // A published version without a bundle cannot replace one.
  const nonBundle = await fixture.port.updateBundle(UPDATE_FIXTURE_BUNDLE, '1.2.0', list.registry, 'req-nonbundle')
  assert.equal(nonBundle.step, 'check')
  assert.equal(nonBundle.result.error?.code, 'not-bundle')
  // A Host-incompatible version is refused before any removal.
  const incompatible = await fixture.port.updateBundle(UPDATE_FIXTURE_BUNDLE, '1.3.0', list.registry, 'req-incompatible')
  assert.equal(incompatible.step, 'check')
  assert.equal(incompatible.result.error?.code, 'incompatible-version')
  assert.equal(incompatible.result.error?.incompatible?.[0]?.requirements['engines.dsh'], '>=9')
  assert.equal(readFileSync(join(fixture.profileDir, 'package.json'), 'utf8'), before,
    'every refused target left the profile manifest byte-identical')
  const snapshot = await fixture.port.snapshot()
  assert.equal(snapshot.bundles.find(candidate => candidate.name === UPDATE_FIXTURE_BUNDLE)?.version, UPDATE_FIXTURE_FROM)
})

test('a REAL slow target install cancelled through the Host restores 1.0.0 (independent restore result)', async (t) => {
  const fixture = await startUpdateFixture(t, 's5-pr2-real-update-cancel', { slowTarball: true })
  const requestId = 'req-cancel-target'
  const pending = fixture.port.updateBundle(UPDATE_FIXTURE_BUNDLE, UPDATE_FIXTURE_TO, fixture.registry.url, requestId)
  await fixture.registry.waitForTarballRequest(60_000)
  const cancellation = await fixture.port.cancelInstall(requestId)
  assert.equal(cancellation.status, 'cancelled')
  const result = await pending
  assert.equal(result.result.application, 'cancelled', 'the target installation was cancelled')
  assert.equal(result.restore?.application, 'applied', 'the Host restored the former version separately')
  assert.equal(result.restore?.version, UPDATE_FIXTURE_FROM)
  const snapshot = await fixture.port.snapshot()
  assert.equal(snapshot.bundles.find(candidate => candidate.name === UPDATE_FIXTURE_BUNDLE)?.version, UPDATE_FIXTURE_FROM)
  assert.equal(readProfileDependencies(fixture.profileDir)[UPDATE_FIXTURE_BUNDLE], UPDATE_FIXTURE_FROM)
})

test('a REAL failed target install plus a failed restore are reported as two independent failures', async (t) => {
  const fixture = await startUpdateFixture(t, 's5-pr2-real-update-restore-failure', { slowTarball: true })
  // Fault injection through the NATIVE Host method: only the restore's exact
  // previous spec fails; the update target still runs through the real pnpm.
  const proxy = fixture.host.ctx.get('pluginManager') as unknown as Record<symbol, unknown> & {
    installBundle(spec: string, options?: { saveExact?: boolean }): Promise<unknown>
  }
  const service = (proxy[symbols.original] ?? proxy) as typeof proxy
  const original = service.installBundle
  service.installBundle = async function patchedInstall(this: unknown, spec: string, options?: { saveExact?: boolean }): Promise<unknown> {
    if (spec === `${UPDATE_FIXTURE_BUNDLE}@${UPDATE_FIXTURE_FROM}` && options?.saveExact === true) {
      return {
        changed: false,
        application: 'failed',
        stage: 'install',
        target: spec,
        error: { code: 'operation-error', diagnostic: 'restore fault injected' },
      }
    }
    return original.call(this, spec, options)
  }
  t.after(() => { service.installBundle = original })

  const requestId = 'req-restore-failure'
  const pending = fixture.port.updateBundle(UPDATE_FIXTURE_BUNDLE, UPDATE_FIXTURE_TO, fixture.registry.url, requestId)
  await fixture.registry.waitForTarballRequest(60_000)
  const cancellation = await fixture.port.cancelInstall(requestId)
  assert.equal(cancellation.status, 'cancelled')
  const result = await pending
  assert.equal(result.result.application, 'cancelled')
  assert.equal(result.restore?.application, 'failed', 'a failed restoration is NOT merged into the target result')
  assert.equal(result.restore?.error?.diagnostic, 'restore fault injected')
})
