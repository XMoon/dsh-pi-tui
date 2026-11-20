/**
 * R8-E PR-3 Client-local mount-owner contract tests.
 *
 * These cases run a REAL Cordis `Context` with the REAL official
 * `@deepseek-ai/cordis-plugin-loader` (`Loader.create/resolve/remove/update`)
 * and the REAL `piTuiExtensions` service. The fixture `./tui` modules are
 * ordinary Cordis plugins installed in a test-owned `node_modules` tree, so:
 *
 * - two packages produce two independent Entry/Fiber instances and their
 *   Footer/Command contributions are visible on the SAME service ledger;
 * - disable removes exactly one package's contributions and re-enable creates
 *   a genuinely NEW Fiber;
 * - a changed `./tui` file cannot be hot-imported in the same PID and becomes
 *   `reload-required` while the old Entry stays live;
 * - an import/apply failure leaves no entry and never blocks the sibling;
 * - disposal awaits every fiber and is idempotent.
 *
 * @module @xmoon76/dsh-pi-tui/client-extension-mount-owner.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { pathToFileURL } from 'node:url'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { ExtensionConfigsConfig, ExtensionConfigRead } from '../../src/runtime/config-port.ts'
import type { PluginManagerSnapshot } from '../../src/runtime/plugin-manager-port.ts'
import { CLIENT_MANIFEST_VERSION, EXTENSION_CONFIG_MODULE, extensionConfigRowId } from '../../src/app/plugin-manager/client-extension-discovery.ts'
import { createClientExtensionMountOwner, type ClientExtensionMountOwner } from '../../src/app/client-extensions/mount-owner.ts'
import { PI_TUI_EXTENSIONS_SERVICE, type PiTuiExtensionService } from '../../src/extensions.ts'
import { apply as applyExtensionHost } from '../../src/extensions.ts'
import { TUI_STARTUP_SERVICE } from '../../src/startup.ts'
import { disposeContext } from '../support/runner-harness.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const FIXTURE_ROOT = '@r8-pr3-fixture'
const SENTINEL_ENV = 'R8_PR3_MOUNT_SENTINEL'

interface FixturePackage {
  readonly name: string
  readonly dir: string
}

interface TestConfig extends ExtensionConfigsConfig {
  readonly values: Map<string, { revision: number; effective: unknown; generation: object }>
  refreshCount: number
}

function createTestConfig(): TestConfig {
  const values = new Map<string, { revision: number; effective: unknown; generation: object }>()
  return {
    values,
    refreshCount: 0,
    read(packageName: string): ExtensionConfigRead {
      const value = values.get(packageName)
      if (value === undefined) {
        return { kind: 'unavailable', reason: `the "${extensionConfigRowId(packageName)}" extension Config row is not mounted` }
      }
      return {
        kind: 'ready',
        packageName,
        generation: value.generation,
        revision: value.revision,
        effective: value.effective,
        inherited: value.effective,
        user: value.effective,
        userDataPresent: false,
      }
    },
    async refresh(): Promise<void> {
      this.refreshCount += 1
    },
    async mutate(): Promise<never> {
      throw new Error('unexpected Config mutation in a mount-owner test')
    },
  }
}

function writePackage(root: string, name: string, tuiSource: string): FixturePackage {
  const short = name.slice(name.lastIndexOf('/') + 1)
  const dir = join(root, 'node_modules', FIXTURE_ROOT, short)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    exports: { './tui': './dist/tui.mjs' },
    dshPiTui: { manifestVersion: CLIENT_MANIFEST_VERSION, entrypoints: { './tui': 'tui-local' } },
  }, undefined, 2)}\n`)
  writeFileSync(join(dir, 'dist', 'tui.mjs'), tuiSource)
  return { name, dir }
}

/** A fixture `./tui` that proves real contribution registration/lifecycle. */
function contributingTui(label: string): string {
  return `import { appendFileSync } from 'node:fs'

const sentinel = process.env.${SENTINEL_ENV}

function record(event, extra = {}) {
  if (sentinel === undefined || sentinel === '') return
  appendFileSync(sentinel, JSON.stringify({ event, package: '${label}', pid: process.pid, ...extra }) + '\\n')
}

record('import')

export const name = '${label}-tui'
export const inject = ['piTuiExtensions']

export function apply(ctx, config) {
  record('apply', { config: JSON.stringify(config ?? null) })
  ctx.effect(() => () => record('dispose'))
  const service = ctx.piTuiExtensions
  service.register('chrome.footer.status', {
    id: '${label}-footer',
    order: 0,
    description: '${label} footer',
  }, { spans: [{ text: '${label.toUpperCase()}-LIVE', tone: 'success' }] })
  service.registerCommand({
    id: '${label}-command',
    name: 'r8-${label}',
    description: '${label} command',
    sessionless: true,
    handler: () => {
      record('command-call')
      return { kind: 'success', text: '${label}' }
    },
  })
}
`
}

function fixtureLookup(packages: readonly FixturePackage[], calls: Array<{ specifier: string; parentURL: string }> = []) {
  return {
    packageOf(specifier: string, parentURL: string) {
      calls.push({ specifier, parentURL })
      const found = packages.find(candidate => candidate.name === specifier)
      if (found === undefined) return undefined
      return {
        name: found.name,
        dir: found.dir,
        manifest: JSON.parse(readFileSync(join(found.dir, 'package.json'), 'utf8')) as Record<string, unknown>,
      }
    },
  }
}

function snapshotOf(packages: readonly FixturePackage[], disabled: ReadonlySet<string> = new Set()): PluginManagerSnapshot {
  return {
    bundles: packages.map(pkg => ({
      name: pkg.name,
      official: false,
      availability: 'profile',
      enabled: !disabled.has(pkg.name),
      installed: true,
      optional: false,
      removable: true,
      rows: [],
      overrides: [],
    })),
    plugins: packages.map((pkg, index) => ({
      entryId: `host-entry-${String(index)}`,
      moduleName: EXTENSION_CONFIG_MODULE,
      enabled: true,
      fiberPhase: 'active',
      patchId: extensionConfigRowId(pkg.name),
    })),
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: [],
    exemptionWarnings: [],
  }
}

interface MountHarness {
  readonly context: Context
  readonly loader: Loader
  readonly owner: ClientExtensionMountOwner
  readonly config: TestConfig
  readonly sentinel: string
  readonly service: PiTuiExtensionService
  serviceLedgerIds(slot: string): readonly string[]
  commandHandler(name: string): ((invocation: { commandId: string; rawInput: string; signal: AbortSignal }) => unknown) | undefined
}

async function mountHarness(
  t: TestContext,
  packages: readonly FixturePackage[],
  options: { readonly configs?: ReadonlyMap<string, unknown>; readonly baseUrl?: string; readonly root?: string; readonly life?: TestLifecycle } = {},
): Promise<MountHarness> {
  const life = options.life ?? testLifecycle(t)
  const root = options.root ?? life.tempDir('dsh-r8-pr3-mount-')
  const sentinel = join(root, 'sentinel.jsonl')
  process.env[SENTINEL_ENV] = sentinel
  const baseUrl = options.baseUrl ?? pathToFileURL(join(root, 'package.json')).href
  const context = new Context()
  life.defer(async () => {
    await disposeContext(context)
    delete process.env[SENTINEL_ENV]
  })
  await context.plugin(Loader, { baseUrl })
  const loader = context.get('loader') as Loader
  const startupFiber = context.plugin(clientCtx => {
    clientCtx.provide(TUI_STARTUP_SERVICE, {})
  })
  await startupFiber
  const hostFiber = context.plugin(applyExtensionHost)
  await hostFiber
  const service = context.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService
  assert.ok(service !== undefined)
  const config = createTestConfig()
  for (const pkg of packages) {
    config.values.set(pkg.name, {
      revision: 1,
      effective: options.configs?.get(pkg.name) ?? { label: pkg.name },
      generation: { package: pkg.name },
    })
  }
  const owner = createClientExtensionMountOwner({
    context,
    loader,
    pluginPackages: fixtureLookup(packages),
    config,
    parentURL: baseUrl,
  })
  life.defer(() => owner.dispose().catch(() => {}))
  return {
    context,
    loader,
    owner,
    config,
    sentinel,
    service,
    serviceLedgerIds(slot: string): readonly string[] {
      return (service as unknown as { _ledger(): { snapshot(name: string): { records: Array<{ id: string }> } } })
        ._ledger().snapshot(slot).records.map(record => record.id)
    },
    commandHandler(name: string) {
      return (service as unknown as { commands: { handlerFor(name: string): unknown } }).commands.handlerFor(name) as never
    },
  }
}

function sentinelEvents(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
  } catch {
    return []
  }
}

function fiberOf(loader: Loader, entryId: string): Fiber {
  const fiber = loader.resolve(entryId).fiber
  assert.ok(fiber !== undefined, `entry ${entryId} has no live fiber`)
  return fiber
}

/** A package pair created under a fresh temp root. */
async function packagePair(t: TestContext): Promise<{
  life: TestLifecycle
  root: string
  a: FixturePackage
  b: FixturePackage
}> {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-r8-pr3-fixture-')
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"r8-pr3-fixture-root","private":true}\n')
  const a = writePackage(root, `${FIXTURE_ROOT}/a`, contributingTui('a'))
  const b = writePackage(root, `${FIXTURE_ROOT}/b`, contributingTui('b'))
  return { life, root, a, b }
}

test('two real ./tui packages mount as independent active Fibers with their own contributions', async (t) => {
  const { life, root, a, b } = await packagePair(t)
  const harness = await mountHarness(t, [a, b], { life, root, baseUrl: pathToFileURL(join(root, 'package.json')).href })
  await harness.owner.reconcile(snapshotOf([a, b]))

  const observation = harness.owner.observation()
  const activeA = observation.find(entry => entry.packageName === a.name)
  const activeB = observation.find(entry => entry.packageName === b.name)
  assert.equal(activeA?.phase, 'active')
  assert.equal(activeB?.phase, 'active')
  assert.ok(activeA?.entryId?.startsWith('pi-tui-client-'))
  assert.ok(activeB?.entryId?.startsWith('pi-tui-client-'))
  assert.notEqual(activeA?.entryId, activeB?.entryId)
  assert.equal(fiberOf(harness.loader, activeA!.entryId!).state, 2)
  assert.equal(fiberOf(harness.loader, activeB!.entryId!).state, 2)
  assert.notEqual(fiberOf(harness.loader, activeA!.entryId!).uid, fiberOf(harness.loader, activeB!.entryId!).uid)

  assert.ok(harness.serviceLedgerIds('chrome.footer.status').includes('a-footer'))
  assert.ok(harness.serviceLedgerIds('chrome.footer.status').includes('b-footer'))
  assert.equal(harness.commandHandler('r8-a')?.({ commandId: 'a', rawInput: '', signal: new AbortController().signal }) !== undefined, true)
  const events = sentinelEvents(harness.sentinel)
  assert.deepEqual(events.filter(event => event.event === 'apply').map(event => event.package).sort(), ['a', 'b'])
  const appliedConfigs = events.filter(event => event.event === 'apply')
  assert.equal(appliedConfigs.find(event => event.package === 'a')?.config, JSON.stringify({ label: a.name }),
    'package A applies its OWN effective Config value verbatim')
  assert.equal(appliedConfigs.find(event => event.package === 'b')?.config, JSON.stringify({ label: b.name }),
    'package B applies its OWN effective Config value verbatim')
  assert.equal(harness.config.refreshCount, 1)
})

test('disabling one package removes exactly its contributions and re-enabling creates a new Fiber', async (t) => {
  const { life, root, a, b } = await packagePair(t)
  const harness = await mountHarness(t, [a, b], { life, root, baseUrl: pathToFileURL(join(root, 'package.json')).href })
  await harness.owner.reconcile(snapshotOf([a, b]))
  const firstA = harness.owner.observation().find(entry => entry.packageName === a.name)!.entryId!
  const firstUid = fiberOf(harness.loader, firstA).uid

  await harness.owner.reconcile(snapshotOf([a, b], new Set([a.name])))
  assert.deepEqual(harness.owner.observation().find(entry => entry.packageName === a.name), undefined)
  assert.ok(!harness.serviceLedgerIds('chrome.footer.status').includes('a-footer'))
  assert.ok(harness.serviceLedgerIds('chrome.footer.status').includes('b-footer'))
  assert.equal(Object.hasOwn(harness.loader.store, firstA), false)
  assert.equal(sentinelEvents(harness.sentinel).filter(event => event.event === 'dispose' && event.package === 'a').length, 1)

  await harness.owner.reconcile(snapshotOf([a, b]))
  const secondA = harness.owner.observation().find(entry => entry.packageName === a.name)!.entryId!
  assert.equal(secondA, firstA)
  const secondUid = fiberOf(harness.loader, secondA).uid
  assert.notEqual(secondUid, firstUid)
  assert.ok(harness.serviceLedgerIds('chrome.footer.status').includes('a-footer'))
  assert.equal(harness.serviceLedgerIds('chrome.footer.status').length, 2)
})

test('an unchanged package keeps its Fiber and applies a changed Config through Loader.update', async (t) => {
  const { life, root, a, b } = await packagePair(t)
  const harness = await mountHarness(t, [a, b], {
    life,
    root,
    baseUrl: pathToFileURL(join(root, 'package.json')).href,
    configs: new Map([[a.name, { label: 'alpha' }], [b.name, { label: 'bravo' }]]),
  })
  await harness.owner.reconcile(snapshotOf([a, b]))
  const entryId = harness.owner.observation().find(entry => entry.packageName === a.name)!.entryId!
  const before = fiberOf(harness.loader, entryId)

  harness.config.values.set(a.name, { revision: 2, effective: { label: 'alpha-2', limit: 0 }, generation: { package: a.name } })
  await harness.owner.reconcile(snapshotOf([a, b]))
  const after = fiberOf(harness.loader, entryId)
  assert.equal(after.uid, before.uid, 'a Config-only update keeps the same Fiber')
  assert.deepEqual(after.effectiveConfig, { label: 'alpha-2', limit: 0 })
  const observed = harness.owner.observation().find(entry => entry.packageName === a.name)
  assert.equal(observed?.phase, 'active')
  assert.equal(observed?.configRevision, 2)
})

test('changed ./tui bytes become reload-required without hot-importing the new file', async (t) => {
  const { life, root, a, b } = await packagePair(t)
  const harness = await mountHarness(t, [a, b], { life, root, baseUrl: pathToFileURL(join(root, 'package.json')).href })
  await harness.owner.reconcile(snapshotOf([a, b]))
  const entryId = harness.owner.observation().find(entry => entry.packageName === a.name)!.entryId!
  const before = fiberOf(harness.loader, entryId)
  const importsBefore = sentinelEvents(harness.sentinel).filter(event => event.event === 'import' && event.package === 'a').length

  writeFileSync(join(a.dir, 'dist', 'tui.mjs'), `${contributingTui('a')}\n// changed bytes\n`)
  await harness.owner.reconcile(snapshotOf([a, b]))

  const observed = harness.owner.observation().find(entry => entry.packageName === a.name)
  assert.equal(observed?.phase, 'reload-required')
  assert.equal(observed?.entryId, entryId)
  assert.equal(fiberOf(harness.loader, entryId).uid, before.uid, 'the old Bytes stay ACTIVE')
  assert.equal(
    sentinelEvents(harness.sentinel).filter(event => event.event === 'import' && event.package === 'a').length,
    importsBefore,
    'the new file is never imported in the same PID',
  )
  // A config change must not be applied to the old bytes while reload is pending.
  harness.config.values.set(a.name, { revision: 3, effective: { label: 'new' }, generation: { package: a.name } })
  await harness.owner.reconcile(snapshotOf([a, b]))
  assert.equal(harness.owner.observation().find(entry => entry.packageName === a.name)?.phase, 'reload-required')
})

test('an import failure leaves no entry and never blocks the sibling package', async (t) => {
  const { life, root, a, b } = await packagePair(t)
  const bad = writePackage(root, `${FIXTURE_ROOT}/bad-import`, 'throw new Error("r8-pr3 import boom")\n')
  const harness = await mountHarness(t, [bad, b], { life, root, baseUrl: pathToFileURL(join(root, 'package.json')).href })
  await harness.owner.reconcile(snapshotOf([bad, b]))

  const failed = harness.owner.observation().find(entry => entry.packageName === bad.name)
  assert.equal(failed?.phase, 'error')
  assert.equal(Object.hasOwn(harness.loader.store, `pi-tui-client-${extensionConfigRowId(bad.name).slice('pi-tui-extcfg-'.length)}`), false)
  assert.equal(harness.owner.observation().find(entry => entry.packageName === b.name)?.phase, 'active')
  assert.ok(harness.serviceLedgerIds('chrome.footer.status').includes('b-footer'))
  assert.ok(!harness.serviceLedgerIds('chrome.footer.status').includes('a-footer'))
})

test('an apply failure is an error, cleans its entry and preserves the sibling', async (t) => {
  const { life, root, b } = await packagePair(t)
  const badApply = writePackage(root, `${FIXTURE_ROOT}/bad-apply`, `export const name = 'bad-apply'
export const inject = ['piTuiExtensions']
export function apply() { throw new Error('r8-pr3 apply boom') }
`)
  const harness = await mountHarness(t, [badApply, b], { life, root, baseUrl: pathToFileURL(join(root, 'package.json')).href })
  await harness.owner.reconcile(snapshotOf([badApply, b]))
  const failed = harness.owner.observation().find(entry => entry.packageName === badApply.name)
  assert.equal(failed?.phase, 'error')
  assert.equal(Object.hasOwn(harness.loader.store, `pi-tui-client-${extensionConfigRowId(badApply.name).slice('pi-tui-extcfg-'.length)}`), false)
  assert.equal(harness.owner.observation().find(entry => entry.packageName === b.name)?.phase, 'active')
})

test('dispose unloads every owned entry in reverse order and is idempotent', async (t) => {
  const { life, root, a, b } = await packagePair(t)
  const harness = await mountHarness(t, [a, b], { life, root, baseUrl: pathToFileURL(join(root, 'package.json')).href })
  await harness.owner.reconcile(snapshotOf([a, b]))
  const entries = harness.owner.observation().flatMap(entry => entry.entryId === undefined ? [] : [entry.entryId])
  assert.equal(entries.length, 2)
  await harness.owner.dispose()
  for (const id of entries) assert.equal(Object.hasOwn(harness.loader.store, id), false)
  assert.deepEqual(harness.owner.observation(), [])
  await harness.owner.dispose()
  await assert.rejects(harness.owner.reconcile(snapshotOf([a, b])), /disposed/)
})

test('a cleanup failure in one package does not strand the other package', async (t) => {
  const { life, root, b } = await packagePair(t)
  const badDispose = writePackage(root, `${FIXTURE_ROOT}/bad-dispose`, `export const name = 'bad-dispose'
export const inject = ['piTuiExtensions']
export function apply(ctx) {
  ctx.effect(() => () => { throw new Error('r8-pr3 dispose boom') })
  ctx.piTuiExtensions.register('chrome.footer.status', { id: 'bad-dispose-footer', order: 0 }, { spans: [{ text: 'BAD' }] })
}
`)
  const harness = await mountHarness(t, [badDispose, b], { life, root, baseUrl: pathToFileURL(join(root, 'package.json')).href })
  await harness.owner.reconcile(snapshotOf([badDispose, b]))
  assert.equal(harness.owner.observation().find(entry => entry.packageName === b.name)?.phase, 'active')
  // Cordis isolates a throwing effect disposer (it logs and continues), so
  // the owner still removes every entry; the sibling must never be stranded.
  await harness.owner.dispose()
  for (const packageName of [badDispose.name, b.name]) {
    const entryId = `pi-tui-client-${extensionConfigRowId(packageName).slice('pi-tui-extcfg-'.length)}`
    assert.equal(Object.hasOwn(harness.loader.store, entryId), false)
  }
})

test('a dispose during an in-flight Config refresh publishes no entry and leaves no orphan', async (t) => {
  const { life, root, a } = await packagePair(t)
  const harness = await mountHarness(t, [a], { life, root, baseUrl: pathToFileURL(join(root, 'package.json')).href })
  let releaseRefresh: (() => void) | undefined
  harness.config.refresh = () => new Promise(resolve => { releaseRefresh = resolve })
  const pending = harness.owner.reconcile(snapshotOf([a]))
  await new Promise(resolve => setTimeout(resolve, 10))
  const disposal = harness.owner.dispose()
  releaseRefresh?.()
  await pending.catch(() => undefined)
  await disposal
  assert.deepEqual(harness.owner.observation(), [])
  assert.equal(Object.hasOwn(harness.loader.store, `pi-tui-client-${extensionConfigRowId(a.name).slice('pi-tui-extcfg-'.length)}`), false)
})
