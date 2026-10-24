/**
 * real-Host catalog qualification (S4-D1 / D1-A02):
 *
 * The official `PluginManager.listBundles()` Host service is instantiated over
 * a REAL managed profile directory + installation anchor fixture that
 * reproduces the official catalog shape: the 12 project-maintained Optional
 * bundles are shipped by the installation (available, not selected) and the 2
 * on-demand subagent bundles are discoverable as `missing` with a real
 * `installTarget`. The real Host output then travels through the shared
 * mapping -> stable identity/origin/section classifier -> model.
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the real `@deepseek-ai/dsh-plugin-manager`
 * Host service, its real profile/patch/installation records, the real
 * `pnpm`-backed profile package operations (local fixture package only), the
 * shared Direct adapter/mapping and the real controller/page below.
 * `TEST STAND-INS`: ephemeral profile/installation directories and local
 * package manifests; no public npm download and no network install.
 * `DELIBERATELY ABSENT`: live npm registries, credentials, a real external
 * bundle consumer and S4-D2/D3 Host/TUI feature qualification.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-catalog-rc2.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import PluginManager, { type BundleInfo } from '@deepseek-ai/dsh-plugin-manager'
import { OPTIONAL_BUNDLES, OFFICIAL_ON_DEMAND_CATALOG, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
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
import { PluginManagerWorkspacePanel } from '../../src/tui/plugin-manager/workspace.ts'
import { openWorkspace, plain } from '../support/plugin-workspace-harness.ts'
import { disposeContext } from '../support/runner-harness.ts'

const ON_DEMAND = OFFICIAL_ON_DEMAND_CATALOG.map(entry => entry.packageName)
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
    name: 'catalog-fixture-installation',
    private: true,
    // The installation ships the 12 Optional bundles; the two on-demand
    // subagent bundles are catalog-only.
    dependencies: Object.fromEntries(OPTIONAL_BUNDLES.map(name => [name, RUNTIME_VERSION])),
  }, null, 2))
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'catalog-fixture-profile',
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

test('the REAL Host listBundles discovers 14/14 official optional/on-demand bundles', async (t) => {
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
    assert.equal(bundle.installTarget?.version, RUNTIME_VERSION)
    assert.equal(bundle.installTarget?.spec, `${name}@${RUNTIME_VERSION}`)
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
      assert.equal(card.canInstall, true)
      assert.ok(detail.actions.some(action => action.value === 'action:official-install' && action.enabled))
      assert.equal(card.installTarget?.spec, `${card.name}@${RUNTIME_VERSION}`)
      assert.equal(upgrade!.value,
        `Install: Use the official offered target ${card.name}@${RUNTIME_VERSION} (version ${RUNTIME_VERSION}); this is not an in-place update.`)
      assert.match(upgrade!.value, /this is not an in-place update/)
      assert.equal(facts.find(fact => fact.label === 'Current version')?.value, 'unavailable')
    } else {
      assert.equal(card.availability, 'installation')
      assert.equal(card.canInstall, false)
      assert.equal(card.canToggle, true, 'a shipped Optional bundle is switchable by the Host')
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
  const port = new DirectPluginManagerPort({ get: name => name === 'pluginManager' ? service : undefined, on: () => () => {} })

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
  const port = new DirectPluginManagerPort({ get: name => name === 'pluginManager' ? service : undefined, on: () => () => {} })

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
    await harness.settle(rounds)
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
  await waitFor(() => /Enabled\s+No/u.test(frame()),
    'the toggled row is painted')
  assert.match(frame(), /Enabled\s+No/)

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
  const port = new DirectPluginManagerPort({ get: name => name === 'pluginManager' ? service : undefined, on: () => () => {} })

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
