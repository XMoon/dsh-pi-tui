/**
 * R8-E PR-1 pure Client-extension qualification tests.
 *
 * Every case drives the PURE function with official-resolution-shaped data:
 *  - the row id is the exact package-name hash and two packages never share it;
 *  - a plain DSH Host package (no `dshPiTui`) is never a Client extension, and
 *    neither is an installed-but-unselected one;
 *  - an opted-in package loses ONLY its Client qualification on every
 *    declaration/row defect, with the exact reason;
 *  - a package with a legitimate `./host` row stays a candidate (a Host row is
 *    not a Client claim), and a native installed/enabled fact is never read as
 *    a Client ACTIVE state.
 * @module @xmoon76/dsh-pi-tui/client-extension-discovery.test
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  CLIENT_MANIFEST_VERSION,
  EXTENSION_CONFIG_MODULE,
  discoverClientExtension,
  extensionConfigRowId,
  type ClientExtensionDiscovery,
  type ClientExtensionPackage,
  type ClientExtensionRow,
} from '../../src/app/plugin-manager/client-extension-discovery.ts'
import {
  discoverCurrentClientExtensions,
  type CurrentClientPackage,
  type CurrentClientPackageLookup,
} from '../../src/app/client-extensions/discovery.ts'
import type { PluginManagerSnapshot } from '../../src/runtime/plugin-manager-port.ts'

function packageManifest(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    version: '1.0.0',
    type: 'module',
    exports: { './tui': './dist/tui.mjs' },
    dshPiTui: { manifestVersion: CLIENT_MANIFEST_VERSION, entrypoints: { './tui': 'tui-local' } },
    ...overrides,
  }
}

function identity(name: string, overrides: Record<string, unknown> = {}): ClientExtensionPackage {
  return { name, manifest: packageManifest(name, overrides) }
}

function rowFor(name: string): ClientExtensionRow {
  return { id: extensionConfigRowId(name), name: EXTENSION_CONFIG_MODULE }
}

function discover(
  packageIdentity: ClientExtensionPackage,
  rows: readonly ClientExtensionRow[],
  selectedBundle = true,
): ClientExtensionDiscovery {
  return discoverClientExtension({ package: packageIdentity, selectedBundle, effectiveRows: rows })
}

test('the row id is the exact UTF-8 package-name SHA-256 prefix', () => {
  const name = '@r8-pr1-fixture/a'
  assert.equal(extensionConfigRowId(name), 'pi-tui-extcfg-d7fa9de1d5de190a92d683a273637c09')
  assert.equal(
    extensionConfigRowId(name),
    `pi-tui-extcfg-${createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 32)}`,
  )
  assert.match(extensionConfigRowId(name), /^pi-tui-extcfg-[0-9a-f]{32}$/u)
})

test('two packages derive two distinct ids and each stays a candidate through its own row', () => {
  const a = '@r8-pr1-fixture/a'
  const b = '@r8-pr1-fixture/b'
  assert.notEqual(extensionConfigRowId(a), extensionConfigRowId(b))
  assert.deepEqual(discover(identity(a), [rowFor(a), rowFor(b)]), {
    kind: 'candidate',
    packageName: a,
    configRowId: extensionConfigRowId(a),
    tuiSpecifier: `${a}/tui`,
  })
  assert.deepEqual(discover(identity(b), [rowFor(a), rowFor(b)]), {
    kind: 'candidate',
    packageName: b,
    configRowId: extensionConfigRowId(b),
    tuiSpecifier: `${b}/tui`,
  })
})

test('a plain DSH Host package without dshPiTui is never a Client extension', () => {
  const plain = identity('@r8-pr1-fixture/plain', {})
  Reflect.deleteProperty(plain.manifest, 'dshPiTui')
  assert.deepEqual(discover(plain, []), { kind: 'not-opted-in' })
  // Native installed/enabled state (selected bundle, mounted rows) never
  // upgrades a non-opted-in package into a Client candidate.
  assert.deepEqual(discover(plain, [rowFor('@r8-pr1-fixture/a')], true), { kind: 'not-opted-in' })
})

test('an installed but unselected package contributes no Client opt-in', () => {
  assert.deepEqual(discover(identity('@r8-pr1-fixture/a'), [rowFor('@r8-pr1-fixture/a')], false), { kind: 'not-opted-in' })
  // A malformed declaration cannot matter for a package the active profile does
  // not select: it still has no opt-in in this profile.
  const malformed = identity('@r8-pr1-fixture/a', { dshPiTui: 'garbage' })
  assert.deepEqual(discover(malformed, [], false), { kind: 'not-opted-in' })
})

test('an opted-in package with a wrong manifestVersion loses Client qualification', () => {
  const pkg = identity('@r8-pr1-fixture/a', {
    dshPiTui: { manifestVersion: 2, entrypoints: { './tui': 'tui-local' } },
  })
  assert.deepEqual(discover(pkg, [rowFor('@r8-pr1-fixture/a')]), {
    kind: 'invalid-opt-in',
    reason: 'dshPiTui.manifestVersion is not 1',
  })
})

test('an opted-in package without the ./tui entrypoint loses Client qualification', () => {
  const pkg = identity('@r8-pr1-fixture/a', {
    dshPiTui: { manifestVersion: CLIENT_MANIFEST_VERSION, entrypoints: {} },
  })
  assert.deepEqual(discover(pkg, [rowFor('@r8-pr1-fixture/a')]), {
    kind: 'invalid-opt-in',
    reason: 'dshPiTui.entrypoints["./tui"] is not "tui-local"',
  })
})

test('an opted-in package without the ./tui export loses Client qualification', () => {
  const pkg = identity('@r8-pr1-fixture/a', { exports: { '.': './dist/index.mjs' } })
  assert.deepEqual(discover(pkg, [rowFor('@r8-pr1-fixture/a')]), {
    kind: 'invalid-opt-in',
    reason: 'package exports declare no "./tui" entry',
  })
})

test('a config row mounted under another package hash loses Client qualification', () => {
  assert.deepEqual(discover(identity('@r8-pr1-fixture/a'), [rowFor('@r8-pr1-fixture/b')]), {
    kind: 'invalid-opt-in',
    reason: `profile has no Loader row "${extensionConfigRowId('@r8-pr1-fixture/a')}"`,
  })
})

test('a config row mounted twice or through another module loses Client qualification', () => {
  const name = '@r8-pr1-fixture/a'
  assert.deepEqual(discover(identity(name), [rowFor(name), rowFor(name)]), {
    kind: 'invalid-opt-in',
    reason: `profile mounts "${extensionConfigRowId(name)}" 2 times`,
  })
  const id = extensionConfigRowId(name)
  assert.deepEqual(discover(identity(name), [{ id, name: '@r8-pr1-fixture/a/tui' }]), {
    kind: 'invalid-opt-in',
    reason: `Load row "${id}" mounts "@r8-pr1-fixture/a/tui", not "${EXTENSION_CONFIG_MODULE}"`,
  })
})

test('a legitimate ./host row never blocks or fakes a Client candidate', () => {
  const name = '@r8-pr1-fixture/dual'
  const pkg: ClientExtensionPackage = {
    name,
    manifest: packageManifest(name, {
      exports: { './tui': './dist/tui.mjs', './host': './dist/host.mjs' },
    }),
  }
  assert.deepEqual(discover(pkg, [rowFor(name), { id: 'r8-pr1-fixture-dual-host', name: `${name}/host` }]), {
    kind: 'candidate',
    packageName: name,
    configRowId: extensionConfigRowId(name),
    tuiSpecifier: `${name}/tui`,
  })
})

/* ------------------------------------------------------------------ *
 * Current-Client discovery over the official Host snapshot
 * ------------------------------------------------------------------ */

function bundleFact(name: string, enabled: boolean): PluginManagerSnapshot['bundles'][number] {
  return {
    name,
    official: false,
    availability: 'profile',
    enabled,
    installed: true,
    optional: false,
    removable: true,
    rows: [],
    overrides: [],
  }
}

function pluginRow(
  patchId: string | undefined,
  moduleName: string,
  fiberPhase: string | null = 'active',
  enabled = true,
): PluginManagerSnapshot['plugins'][number] {
  return {
    entryId: `entry-${moduleName}-${String(patchId)}`,
    moduleName,
    enabled,
    fiberPhase,
    ...(patchId === undefined ? {} : { patchId }),
  }
}

function snapshotOf(
  bundles: readonly PluginManagerSnapshot['bundles'][number][],
  plugins: readonly PluginManagerSnapshot['plugins'][number][] = [],
): PluginManagerSnapshot {
  return {
    bundles,
    plugins,
    registries: { registry: null, fallbackRegistries: [], resolved: null },
    exemptions: [],
    exemptionWarnings: [],
  }
}

function packageLookup(
  packages: Readonly<Record<string, CurrentClientPackage>>,
  calls: Array<{ specifier: string; parentURL: string }> = [],
): CurrentClientPackageLookup {
  return {
    packageOf(specifier, parentURL) {
      calls.push({ specifier, parentURL })
      return packages[specifier]
    },
  }
}

function livePackages(...names: readonly string[]): Record<string, CurrentClientPackage> {
  return Object.fromEntries(names.map(name => [name, {
    name,
    dir: `/profile/node_modules/${name}`,
    manifest: packageManifest(name),
  }]))
}

test('an enabled opt-in bundle becomes a candidate through its live carrier row', () => {
  const name = '@r8-pr1-fixture/a'
  const calls: Array<{ specifier: string; parentURL: string }> = []
  const outcomes = discoverCurrentClientExtensions(
    snapshotOf(
      [bundleFact(name, true)],
      [pluginRow(extensionConfigRowId(name), EXTENSION_CONFIG_MODULE)],
    ),
    packageLookup(livePackages(name), calls),
    'file:///profile/node_modules/@xmoon76/dsh-pi-tui/dist/local-client.mjs',
  )
  assert.deepEqual(outcomes, [{
    kind: 'candidate',
    bundleName: name,
    packageName: name,
    packageDir: `/profile/node_modules/${name}`,
    configRowId: extensionConfigRowId(name),
    tuiSpecifier: `${name}/tui`,
  }])
  assert.deepEqual(calls, [{
    specifier: name,
    parentURL: 'file:///profile/node_modules/@xmoon76/dsh-pi-tui/dist/local-client.mjs',
  }])
})

test('a bundle alias resolves through the installed manifest name', () => {
  const alias = '@r8-alias/tui-display-name'
  const installed = '@r8-pr1-fixture/a'
  const outcomes = discoverCurrentClientExtensions(
    snapshotOf(
      [bundleFact(alias, true)],
      [pluginRow(extensionConfigRowId(installed), EXTENSION_CONFIG_MODULE)],
    ),
    {
      packageOf: specifier => specifier === alias
        ? { name: installed, dir: '/profile/node_modules/@r8-pr1-fixture/a', manifest: packageManifest(installed) }
        : undefined,
    },
    'file:///profile/node_modules/@xmoon76/dsh-pi-tui/dist/local-client.mjs',
  )
  assert.equal(outcomes[0]?.kind, 'candidate')
  assert.equal(outcomes[0]?.kind === 'candidate' ? outcomes[0].packageName : undefined, installed)
  assert.equal(outcomes[0]?.kind === 'candidate' ? outcomes[0].configRowId : undefined, extensionConfigRowId(installed))
})

test('an unselected bundle contributes no Client outcome even when installed', () => {
  const name = '@r8-pr1-fixture/a'
  const outcomes = discoverCurrentClientExtensions(
    snapshotOf(
      [bundleFact(name, false)],
      [pluginRow(extensionConfigRowId(name), EXTENSION_CONFIG_MODULE)],
    ),
    packageLookup(livePackages(name)),
    'file:///profile/package.json',
  )
  assert.deepEqual(outcomes, [])
})

test('a carrier row that is not live loses Client qualification only', () => {
  const name = '@r8-pr1-fixture/a'
  for (const fiberPhase of ['pending', 'failed', 'unloading', null]) {
    const outcomes = discoverCurrentClientExtensions(
      snapshotOf(
        [bundleFact(name, true)],
        [pluginRow(extensionConfigRowId(name), EXTENSION_CONFIG_MODULE, fiberPhase)],
      ),
      packageLookup(livePackages(name)),
      'file:///profile/package.json',
    )
    assert.equal(outcomes[0]?.kind, 'invalid-opt-in')
    assert.equal(
      outcomes[0]?.kind === 'invalid-opt-in' ? outcomes[0].reason : undefined,
      `profile has no Loader row "${extensionConfigRowId(name)}"`,
    )
  }
})

test('a disabled carrier row does not qualify an opted-in package', () => {
  const name = '@r8-pr1-fixture/a'
  const outcomes = discoverCurrentClientExtensions(
    snapshotOf(
      [bundleFact(name, true)],
      [pluginRow(extensionConfigRowId(name), EXTENSION_CONFIG_MODULE, 'active', false)],
    ),
    packageLookup(livePackages(name)),
    'file:///profile/package.json',
  )
  assert.equal(outcomes[0]?.kind, 'invalid-opt-in')
})

test('two enabled bundles resolving to one manifest package fail closed', () => {
  const name = '@r8-pr1-fixture/a'
  const outcomes = discoverCurrentClientExtensions(
    snapshotOf(
      [bundleFact('@r8-alias/one', true), bundleFact('@r8-alias/two', true)],
      [pluginRow(extensionConfigRowId(name), EXTENSION_CONFIG_MODULE)],
    ),
    {
      packageOf: () => ({ name, dir: '/profile/node_modules/@r8-pr1-fixture/a', manifest: packageManifest(name) }),
    },
    'file:///profile/package.json',
  )
  assert.equal(outcomes.length, 2)
  for (const outcome of outcomes) {
    assert.equal(outcome.kind, 'invalid-opt-in')
    assert.equal(
      outcome.kind === 'invalid-opt-in' ? outcome.reason : undefined,
      `multiple enabled bundles resolve to package "${name}"`,
    )
  }
})

test('a selected bundle the Client cannot resolve is unresolved, not opted-in', () => {
  const outcomes = discoverCurrentClientExtensions(
    snapshotOf([bundleFact('@r8-pr1-fixture/missing', true)]),
    packageLookup({}),
    'file:///profile/package.json',
  )
  assert.deepEqual(outcomes, [{
    kind: 'unresolved',
    bundleName: '@r8-pr1-fixture/missing',
    reason: 'the Client process cannot resolve bundle "@r8-pr1-fixture/missing"',
  }])
})

test('a plain Host bundle stays not-opted-in through the live snapshot', () => {
  const name = '@r8-pr1-fixture/plain'
  const outcomes = discoverCurrentClientExtensions(
    snapshotOf(
      [bundleFact(name, true)],
      [pluginRow('r8-pr1-fixture-plain-host', `${name}/host`)],
    ),
    packageLookup({
      [name]: {
        name,
        dir: `/profile/node_modules/${name}`,
        manifest: { name, version: '1.0.0', type: 'module', exports: { './host': './dist/host.mjs' } },
      },
    }),
    'file:///profile/package.json',
  )
  assert.deepEqual(outcomes, [{ kind: 'not-opted-in', bundleName: name, packageName: name }])
})
