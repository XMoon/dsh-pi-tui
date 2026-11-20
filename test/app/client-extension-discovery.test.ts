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
