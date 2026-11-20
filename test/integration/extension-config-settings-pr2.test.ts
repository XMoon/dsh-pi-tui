/**
 * R8-E PR-2 official-chain evidence: a REAL Host Settings/ConfigEditor plane
 * over two per-package Config carrier rows, and the PRODUCT RemoteConfigPort
 * formed by `createRemoteBackendRuntime` over the generated `settings` Remote.
 *
 * REAL: official SettingsForms/ConfigEditor over a disposable profile, the
 * trusted `@xmoon76/dsh-pi-tui/extension-config` carrier module, the official
 * generated settings Remote and the ONE shared settings mirror.
 * STAND-INS: the fixture profile/bundle layout (no user DSH_HOME) and the
 * prompt serializer stand-in required by the shared in-process Host fixture.
 * ABSENT: a physical terminal and a second operating-system Client process.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import SettingsForms from '@deepseek-ai/dsh-settings'
import { loadProfileDirectory, mountRootInclude } from '@deepseek-ai/dsh-app-boot'
import { createRemoteClientRuntime } from '../support/m3-inprocess/client-runtime.ts'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteBackendRuntime } from '../../src/app/remote/runtime.ts'
import { RemoteConfigPort } from '../../src/runtime/remote/config-remote.ts'
import {
  createRemoteApplicationHostFixture,
  testPromptSerializer,
} from '../support/remote-application-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { extensionConfigRowId } from '../../src/domain/extension-config/row-id.ts'

const PACKAGE_A = '@r8-pr1-fixture/a'
const PACKAGE_B = '@r8-pr1-fixture/b'
const NS_A = extensionConfigRowId(PACKAGE_A)
const NS_B = extensionConfigRowId(PACKAGE_B)
const BUNDLE = 'r8-pr2-extension-config-bundle'
const PROFILE = 'r8-pr2-extension-config-profile'

interface HostSettings {
  describe(): readonly { ns: string; revision?: number }[]
  mutate(
    ns: string,
    ops: readonly { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[],
    expectedRevision?: number,
  ): Promise<unknown>
}

interface ExtensionConfigPlane {
  readonly settings: HostSettings
  userConfig(namespace: string): unknown
}

/** Mount the real official Settings/ConfigEditor plane over two carrier rows. */
async function mountExtensionConfigPlane(ctx: Context, root: string): Promise<ExtensionConfigPlane> {
  const profileDir = join(root, 'profile')
  const bundleDir = join(root, 'bundle')
  const installedPackage = join(profileDir, 'node_modules', '@xmoon76', 'dsh-pi-tui')
  const patchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(bundleDir, { recursive: true })
  mkdirSync(installedPackage, { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: PROFILE,
    private: true,
    dsh: { profile: { bundles: [BUNDLE], patch: 'cordis.patch.yml' } },
  }, null, 2))
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: BUNDLE,
    version: '0.0.0',
    private: true,
    dsh: { bundle: { patch: ['./cordis.patch.yml'] } },
  }, null, 2))
  writeFileSync(join(installedPackage, 'package.json'), JSON.stringify({
    name: '@xmoon76/dsh-pi-tui',
    version: '0.0.0',
    private: true,
    type: 'module',
    exports: { './extension-config': './extension-config.mjs' },
  }, null, 2))
  writeFileSync(join(installedPackage, 'extension-config.mjs'), [
    `export { name, Config, apply } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/app/host/extension-config-carrier.ts')).href)}`,
    '',
  ].join('\n'))
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), [
    '- insert:',
    `    - id: ${NS_A}`,
    "      name: '@xmoon76/dsh-pi-tui/extension-config'",
    '      config:',
    '        data:',
    '          label: alpha',
    '          limit: 3',
    `    - id: ${NS_B}`,
    "      name: '@xmoon76/dsh-pi-tui/extension-config'",
    '      config:',
    '        data:',
    '          label: bravo',
    '          limit: 7',
    '',
  ].join('\n'))
  symlinkSync(bundleDir, join(profileDir, 'node_modules', BUNDLE), 'dir')
  writeFileSync(patchPath, '[]\n')
  const anchor = join(profileDir, 'package.json')
  const profileContext = {
    name: PROFILE,
    dir: profileDir,
    patchPath,
    installAnchor: anchor,
    cwd: root,
    home: root,
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  }
  ctx.provide('profileContext', profileContext as never)
  await ctx.plugin(ConfigEditor)
  await ctx.plugin(SettingsForms)
  const profile = loadProfileDirectory('dsh', profileDir, anchor)
  await mountRootInclude(
    ctx,
    patchPath,
    [...profile.layers.flatMap(layer => layer.patches), ...profile.patches],
    pathToFileURL(anchor).href,
    'dsh',
  )
  await ctx.loader.await()
  return {
    settings: (ctx as unknown as { settings: HostSettings }).settings,
    userConfig: namespace => loadProfileDirectory('dsh', profileDir, anchor).patches
      .findLast(row => row.id === namespace && row.config !== undefined)?.config,
  }
}

test('the generated settings Remote and the production ConfigPort read/write two per-package rows', async t => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'extension-config-pr2')
  const plane = await mountExtensionConfigPlane(host.ctx, join(host.workRoot, 'extension-plane'))

  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const assembled = await createRemoteBackendRuntime({
    runtime: client,
    promptSerializer: testPromptSerializer,
    fetch: hostRuntime.carrier.fetch,
  })
  t.after(async () => {
    assembled.dispose()
    await client.dispose()
    await hostRuntime.dispose()
    await host.dispose()
  })

  const config = assembled.backend.config
  assert.ok(config instanceof RemoteConfigPort, 'the application wired the production Remote ConfigPort')
  assert.equal(config.configReadiness(), 'ready')

  const a = config.extensionConfigs.read(PACKAGE_A)
  assert.equal(a.kind, 'ready', a.kind === 'ready' ? '' : a.reason)
  if (a.kind !== 'ready') return
  assert.deepEqual(a.effective, { label: 'alpha', limit: 3 })
  assert.deepEqual(a.inherited, { label: 'alpha', limit: 3 })
  assert.equal(a.user, undefined)
  assert.equal(a.userDataPresent, false)

  const b = config.extensionConfigs.read(PACKAGE_B)
  assert.equal(b.kind, 'ready')
  if (b.kind !== 'ready') return
  assert.deepEqual(b.effective, { label: 'bravo', limit: 7 })

  assert.deepEqual(await config.extensionConfigs.mutate(PACKAGE_A, [
    { op: 'set', path: ['label'], value: 'alpha-2' },
    { op: 'set', path: ['nested', 'flag'], value: false },
  ], a.revision, a.generation), { kind: 'accepted' })
  // The official form edit projects the full carrier datum: the USER patch is
  // the complete data document with this batch applied.
  assert.deepEqual(plane.userConfig(NS_A), { data: { label: 'alpha-2', limit: 3, nested: { flag: false } } })
  const afterA = config.extensionConfigs.read(PACKAGE_A)
  assert.equal(afterA.kind, 'ready')
  if (afterA.kind !== 'ready') return
  assert.deepEqual(afterA.effective, { label: 'alpha-2', limit: 3, nested: { flag: false } })
  assert.equal(afterA.userDataPresent, true)
  const bAfterA = config.extensionConfigs.read(PACKAGE_B)
  assert.equal(bAfterA.kind, 'ready')
  if (bAfterA.kind !== 'ready') return
  assert.deepEqual(bAfterA.effective, { label: 'bravo', limit: 7 })
  assert.equal(plane.userConfig(NS_B), undefined)

  assert.deepEqual(await config.extensionConfigs.mutate(PACKAGE_B, [
    { op: 'set', path: ['limit'], value: 9 },
  ], bAfterA.revision, bAfterA.generation), { kind: 'accepted' })
  const aFinal = config.extensionConfigs.read(PACKAGE_A)
  const bFinal = config.extensionConfigs.read(PACKAGE_B)
  assert.equal(aFinal.kind, 'ready')
  assert.equal(bFinal.kind, 'ready')
  if (aFinal.kind !== 'ready' || bFinal.kind !== 'ready') return
  assert.deepEqual(aFinal.effective, { label: 'alpha-2', limit: 3, nested: { flag: false } })
  assert.deepEqual(bFinal.effective, { label: 'bravo', limit: 9 })
  assert.deepEqual(plane.userConfig(NS_B), { data: { label: 'bravo', limit: 9 } })

  // A real Host write after the port read makes the captured revision stale.
  const staleRead = config.extensionConfigs.read(PACKAGE_A)
  assert.equal(staleRead.kind, 'ready')
  if (staleRead.kind !== 'ready') return
  const hostRow = plane.settings.describe().find(row => row.ns === NS_A)
  assert.notEqual(hostRow?.revision, undefined)
  await plane.settings.mutate(NS_A, [{ op: 'set', path: ['data', 'label'], value: 'external' }], hostRow?.revision)
  assert.equal((await config.extensionConfigs.mutate(PACKAGE_A, [
    { op: 'set', path: ['label'], value: 'loser' },
  ], staleRead.revision, staleRead.generation)).kind, 'conflict')
  const external = config.extensionConfigs.read(PACKAGE_A)
  assert.equal(external.kind, 'ready')
  if (external.kind !== 'ready') return
  assert.equal((external.effective as { label: string }).label, 'external')

  // The carrier row id is derived from the real package name, not a caller URI.
  assert.equal(config.extensionConfigs.read('@r8-pr1-fixture/missing').kind, 'unavailable')
})
