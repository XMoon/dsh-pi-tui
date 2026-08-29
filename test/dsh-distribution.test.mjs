import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DSH_CLI_PACKAGE,
  DshDistributionError,
  assertNoSourceLeak,
  buildDshOverrides,
  loadDshDistributionManifest,
  packageMapFromTarballs,
  prepareDshInstall,
  requiredDshPackages,
  restoreDshInstall,
  sourceInstallPackages,
  validateSourceDistribution,
  writeDshWorkspaceOverrides,
} from '../scripts/lib/dsh-distribution.mjs'

const VERSION = '0.1.2-alpha.1'
const SHA = 'a'.repeat(40)

function tarPackage(directory, fileName, metadata, files = {}) {
  const staging = join(directory, `stage-${fileName.replace(/[^a-z0-9]/giu, '-')}`)
  const packageDir = join(staging, 'package')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(metadata)}\n`)
  for (const [name, content] of Object.entries(files)) {
    const path = join(packageDir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  const tarball = join(directory, fileName)
  const result = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  rmSync(staging, { recursive: true, force: true })
  return tarball
}

function tarPackageWithSymlink(directory, fileName, metadata, target) {
  const staging = join(directory, `stage-${fileName.replace(/[^a-z0-9]/giu, '-')}`)
  const packageDir = join(staging, 'package')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(metadata)}\n`)
  symlinkSync(target, join(packageDir, 'loader'))
  const tarball = join(directory, fileName)
  const result = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  rmSync(staging, { recursive: true, force: true })
  return tarball
}

function packageJsonFor(required = [DSH_CLI_PACKAGE]) {
  return {
    peerDependencies: Object.fromEntries(required.filter(name => name !== DSH_CLI_PACKAGE).map(name => [name, `>=${VERSION}`])),
    devDependencies: Object.fromEntries(required.includes(DSH_CLI_PACKAGE) ? [[DSH_CLI_PACKAGE, VERSION]] : []),
  }
}

function makeDistribution({ required = [DSH_CLI_PACKAGE], include = required, fileNames = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-distribution-test-'))
  const packages = {}
  for (const [index, name] of include.entries()) {
    const fileName = fileNames[name] ?? `misleading-artifact-${index}.tgz`
    tarPackage(directory, fileName, { name, version: VERSION })
    packages[name] = fileName
  }
  const manifest = {
    schemaVersion: 1,
    mode: 'source-pack',
    repository: 'deepseek-ai/deepseek-harness',
    sourceRef: SHA,
    sourceSha: SHA,
    version: VERSION,
    packages,
  }
  writeFileSync(join(directory, 'dsh-source-distribution.json'), `${JSON.stringify(manifest)}\n`)
  return { directory, manifest, packageJson: packageJsonFor(required) }
}

function expectDistributionFailure(fn, pattern) {
  assert.throws(fn, error => error instanceof DshDistributionError && pattern.test(error.message), pattern)
}

test('source distribution validates embedded package identity, not filenames', () => {
  const fixture = makeDistribution({ required: [DSH_CLI_PACKAGE, '@deepseek-ai/dsh-agent'], fileNames: { [DSH_CLI_PACKAGE]: 'not-the-cli-name.tgz' } })
  try {
    const distribution = validateSourceDistribution({ manifest: fixture.manifest, directory: fixture.directory }, { packageJson: fixture.packageJson })
    assert.equal(distribution.kind, 'source-pack')
    assert.deepEqual([...distribution.packages.keys()], [DSH_CLI_PACKAGE, '@deepseek-ai/dsh-agent'])
    assert.equal(distribution.packages.get(DSH_CLI_PACKAGE).fileName, 'not-the-cli-name.tgz')
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('source distribution requires the CLI and every peer/dev DSH package', () => {
  const missingCli = makeDistribution({ required: [DSH_CLI_PACKAGE], include: [] })
  try {
    expectDistributionFailure(
      () => validateSourceDistribution({ manifest: missingCli.manifest, directory: missingCli.directory }, { packageJson: missingCli.packageJson }),
      /missing required CLI/u,
    )
  } finally {
    rmSync(missingCli.directory, { recursive: true, force: true })
  }

  const required = [DSH_CLI_PACKAGE, '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session']
  const missingDev = makeDistribution({ required, include: required.slice(0, 2) })
  try {
    expectDistributionFailure(
      () => validateSourceDistribution({ manifest: missingDev.manifest, directory: missingDev.directory }, { packageJson: missingDev.packageJson }),
      /dsh-session/u,
    )
  } finally {
    rmSync(missingDev.directory, { recursive: true, force: true })
  }
})

test('source distribution rejects wrong SHA, version, duplicate paths, and non-family packages', () => {
  const fixture = makeDistribution({ required: [DSH_CLI_PACKAGE] })
  try {
    expectDistributionFailure(
      () => validateSourceDistribution({ manifest: { ...fixture.manifest, sourceSha: 'b'.repeat(40) }, directory: fixture.directory }, { packageJson: fixture.packageJson }),
      /sourceRef and sourceSha/u,
    )
    expectDistributionFailure(
      () => validateSourceDistribution({ manifest: { ...fixture.manifest, sourceRef: 'short' }, directory: fixture.directory }, { packageJson: fixture.packageJson }),
      /full 40-character/u,
    )
    expectDistributionFailure(
      () => validateSourceDistribution({ manifest: { ...fixture.manifest, version: '0.1.3' }, directory: fixture.directory }, { packageJson: fixture.packageJson }),
      /has version/u,
    )
    expectDistributionFailure(
      () => validateSourceDistribution({ manifest: { ...fixture.manifest, packages: { [DSH_CLI_PACKAGE]: fixture.manifest.packages[DSH_CLI_PACKAGE], '@deepseek-ai/dsh-agent': fixture.manifest.packages[DSH_CLI_PACKAGE] } }, directory: fixture.directory }, { packageJson: fixture.packageJson }),
      /more than one package/u,
    )
    const nonFamily = makeDistribution({ required: [DSH_CLI_PACKAGE], include: [DSH_CLI_PACKAGE, '@deepseek-ai/cordis'] })
    try {
      expectDistributionFailure(
        () => validateSourceDistribution({ manifest: nonFamily.manifest, directory: nonFamily.directory }, { packageJson: nonFamily.packageJson }),
        /non-DSH package/u,
      )
    } finally {
      rmSync(nonFamily.directory, { recursive: true, force: true })
    }

    const extraFile = makeDistribution({ required: [DSH_CLI_PACKAGE] })
    try {
      writeFileSync(join(extraFile.directory, 'publish-order.txt'), 'unexpected\n')
      expectDistributionFailure(
        () => loadDshDistributionManifest(extraFile.directory, { packageJson: extraFile.packageJson }),
        /unexpected top-level/u,
      )
    } finally {
      rmSync(extraFile.directory, { recursive: true, force: true })
    }

    const extraTarball = makeDistribution({ required: [DSH_CLI_PACKAGE] })
    try {
      tarPackage(extraTarball.directory, 'unlisted.tgz', { name: DSH_CLI_PACKAGE, version: VERSION })
      expectDistributionFailure(
        () => loadDshDistributionManifest(extraTarball.directory, { packageJson: extraTarball.packageJson }),
        /unlisted tarball/u,
      )
    } finally {
      rmSync(extraTarball.directory, { recursive: true, force: true })
    }
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('source distribution rejects tarball symlinks outside the artifact root', () => {
  const fixture = makeDistribution({ required: [DSH_CLI_PACKAGE] })
  const external = mkdtempSync(join(tmpdir(), 'dsh-external-artifact-test-'))
  try {
    const fileName = fixture.manifest.packages[DSH_CLI_PACKAGE]
    const externalTarball = tarPackage(external, fileName, { name: DSH_CLI_PACKAGE, version: VERSION })
    rmSync(join(fixture.directory, fileName))
    symlinkSync(externalTarball, join(fixture.directory, fileName))
    expectDistributionFailure(
      () => loadDshDistributionManifest(fixture.directory, { packageJson: fixture.packageJson }),
      /regular file/u,
    )
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
    rmSync(external, { recursive: true, force: true })
  }
})

test('source distribution overrides have exact package coverage and fail before install targets disappear', () => {
  const required = [DSH_CLI_PACKAGE, '@deepseek-ai/dsh-agent']
  const fixture = makeDistribution({ required })
  try {
    const distribution = loadDshDistributionManifest(fixture.directory, { packageJson: fixture.packageJson })
    const overrides = buildDshOverrides(distribution)
    assert.deepEqual(Object.keys(overrides).sort(), required.slice().sort())
    for (const name of required) assert.match(overrides[name], /\.tgz$/u)
    rmSync(join(fixture.directory, fixture.manifest.packages['@deepseek-ai/dsh-agent']))
    assert.throws(() => buildDshOverrides(distribution), /override target is missing/u)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
  }
})

test('temporary workspace overrides are generated without changing the package contract', () => {
  const fixture = makeDistribution({ required: [DSH_CLI_PACKAGE] })
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-workspace-test-'))
  try {
    const original = 'packages:\n- packages/*\nallowBuilds:\n  esbuild: true\n'
    writeFileSync(join(workspace, 'pnpm-workspace.yaml'), original)
    const distribution = loadDshDistributionManifest(fixture.directory, { packageJson: fixture.packageJson })
    writeDshWorkspaceOverrides(workspace, distribution)
    const generated = readFileSync(join(workspace, 'pnpm-workspace.yaml'), 'utf8')
    assert.match(generated, /BEGIN DSH SOURCE OVERRIDES/u)
    assert.match(generated, /misleading-artifact-0\.tgz/u)
    assert.match(generated, /allowBuilds/u)
    assert.equal(JSON.stringify(fixture.packageJson), JSON.stringify(fixture.packageJson))
    writeDshWorkspaceOverrides(workspace, { kind: 'npm', version: VERSION })
    assert.equal(readFileSync(join(workspace, 'pnpm-workspace.yaml'), 'utf8'), original)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('source install materializes local peers temporarily and restores package metadata', () => {
  const required = [DSH_CLI_PACKAGE, '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session']
  const fixture = makeDistribution({ required })
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-package-materialize-test-'))
  try {
    const packagePath = join(workspace, 'package.json')
    const original = {
      name: 'temporary-tui',
      private: true,
      packageManager: 'pnpm@11.7.0',
      ...fixture.packageJson,
      peerDependencies: { ...fixture.packageJson.peerDependencies, '@deepseek-ai/cordis': '^4.0.1' },
    }
    const originalText = `${JSON.stringify(original, null, 2)}\n`
    writeFileSync(packagePath, originalText)
    const distribution = loadDshDistributionManifest(fixture.directory, { packageJson: fixture.packageJson })
    assert.deepEqual(sourceInstallPackages(distribution, original), required.slice().sort())
    const prepared = prepareDshInstall(distribution, workspace, { materializeSourceDependencies: true, stripPackageManager: true })
    const generated = JSON.parse(readFileSync(packagePath, 'utf8'))
    assert.equal(generated.packageManager, undefined)
    assert.equal(generated.devDependencies['@deepseek-ai/cordis'], '^4.0.1')
    assert.match(generated.devDependencies[DSH_CLI_PACKAGE], /^file:/u)
    assert.match(generated.devDependencies['@deepseek-ai/dsh-session'], /^file:/u)
    restoreDshInstall(prepared)
    assert.equal(readFileSync(packagePath, 'utf8'), originalText)
    assert.equal(existsSync(join(workspace, 'pnpm-workspace.yaml')), false)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('failed temporary preparation restores the original workspace file', () => {
  const fixture = makeDistribution({ required: [DSH_CLI_PACKAGE] })
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-prepare-failure-test-'))
  try {
    const originalWorkspace = 'packages:\n- packages/*\n'
    writeFileSync(join(workspace, 'pnpm-workspace.yaml'), originalWorkspace)
    writeFileSync(join(workspace, 'package.json'), '{ invalid json\n')
    const distribution = loadDshDistributionManifest(fixture.directory, { packageJson: fixture.packageJson })
    assert.throws(
      () => prepareDshInstall(distribution, workspace, { stripPackageManager: true }),
      /could not be read/u,
    )
    assert.equal(readFileSync(join(workspace, 'pnpm-workspace.yaml'), 'utf8'), originalWorkspace)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('workspace restoration proceeds when package restoration fails', () => {
  const fixture = makeDistribution({ required: [DSH_CLI_PACKAGE] })
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-restore-order-test-'))
  try {
    const packagePath = join(workspace, 'package.json')
    const workspacePath = join(workspace, 'pnpm-workspace.yaml')
    const originalWorkspace = 'packages:\n- packages/*\n'
    writeFileSync(packagePath, JSON.stringify({ name: 'restore-order' }))
    writeFileSync(workspacePath, originalWorkspace)
    const distribution = loadDshDistributionManifest(fixture.directory, { packageJson: fixture.packageJson })
    const prepared = prepareDshInstall(distribution, workspace, { stripPackageManager: true })
    rmSync(packagePath, { force: true })
    mkdirSync(packagePath)
    assert.throws(() => restoreDshInstall(prepared), /EISDIR|directory/u)
    assert.equal(readFileSync(workspacePath, 'utf8'), originalWorkspace)
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true })
    rmSync(workspace, { recursive: true, force: true })
  }
})

test('package family discovery includes peers and devDependencies but excludes Cordis', () => {
  const names = requiredDshPackages({
    peerDependencies: { '@deepseek-ai/dsh-agent': '*', '@deepseek-ai/cordis': '*' },
    devDependencies: { '@deepseek-ai/dsh-session': '*' },
  })
  assert.deepEqual(names, [DSH_CLI_PACKAGE, '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session'])
})

test('source leak gate accepts prose but rejects source dependency specs and paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-leak-test-'))
  try {
    const clean = tarPackage(directory, 'clean.tgz', {
      name: '@xmoon76/dsh-pi-tui',
      version: '0.4.0-alpha.1',
      peerDependencies: { '@deepseek-ai/dsh-agent': '>=0.1.2-alpha.1' },
    }, { 'README.md': 'The words file:, deepseek-harness, dsh-source-pack, and https://example.invalid can appear in ordinary prose.\n' })
    assert.doesNotThrow(() => assertNoSourceLeak(clean))

    const badPeer = tarPackage(directory, 'bad-peer.tgz', {
      name: '@xmoon76/dsh-pi-tui',
      version: '0.4.0-alpha.1',
      peerDependencies: { '@deepseek-ai/dsh-agent': 'file:/tmp/dsh-agent.tgz' },
    })
    expectDistributionFailure(() => assertNoSourceLeak(badPeer), /source leak/u)

    const badPath = tarPackage(directory, 'bad-path.tgz', {
      name: '@xmoon76/dsh-pi-tui',
      version: '0.4.0-alpha.1',
    }, { 'dist/index.mjs': 'const source = "/tmp/dsh-source-pack/deepseek-harness"\n' })
    expectDistributionFailure(() => assertNoSourceLeak(badPath), /source leak/u)

    const sourceRoot = '/home/fixture/deepseek-harness'
    const badMap = tarPackage(directory, 'bad-map.tgz', {
      name: '@xmoon76/dsh-pi-tui',
      version: '0.4.0-alpha.1',
    }, { 'dist/index.mjs.map': JSON.stringify({ sources: [`${sourceRoot}/packages/index.ts`] }) })
    expectDistributionFailure(() => assertNoSourceLeak(badMap, { sourcePaths: [sourceRoot] }), /source leak/u)

    const badExtensionless = tarPackage(directory, 'bad-extensionless.tgz', {
      name: '@xmoon76/dsh-pi-tui',
      version: '0.4.0-alpha.1',
    }, { 'dist/loader': `${sourceRoot}/packages/loader.js\n` })
    expectDistributionFailure(() => assertNoSourceLeak(badExtensionless, { sourcePaths: [sourceRoot] }), /source leak/u)

    const badBinary = tarPackage(directory, 'bad-binary.tgz', {
      name: '@xmoon76/dsh-pi-tui',
      version: '0.4.0-alpha.1',
    }, { 'dist/loader': Buffer.from([0, ...Buffer.from('/home/runner/work/dsh-pi-tui/dsh-pi-tui')]) })
    expectDistributionFailure(() => assertNoSourceLeak(badBinary), /source leak/u)

    const badSymlink = tarPackageWithSymlink(directory, 'bad-symlink.tgz', {
      name: '@xmoon76/dsh-pi-tui',
      version: '0.4.0-alpha.1',
    }, '/tmp/dsh-source-pack/deepseek-harness')
    expectDistributionFailure(() => assertNoSourceLeak(badSymlink), /unsafe archive link target/u)

    const badTraversalLink = tarPackageWithSymlink(directory, 'bad-traversal-link.tgz', {
      name: '@xmoon76/dsh-pi-tui',
      version: '0.4.0-alpha.1',
    }, '../../outside')
    expectDistributionFailure(() => assertNoSourceLeak(badTraversalLink), /unsafe archive link target/u)

    const badArchivePath = tarPackage(directory, 'bad-archive-path.tgz', {
      name: '@xmoon76/dsh-pi-tui',
      version: '0.4.0-alpha.1',
    }, { 'deepseek-harness/README.md': 'archive path must be rejected\n' })
    expectDistributionFailure(() => assertNoSourceLeak(badArchivePath), /forbidden archive path token/u)

    const badWindows = tarPackage(directory, 'bad-windows.tgz', {
      name: '@xmoon76/dsh-pi-tui',
      version: '0.4.0-alpha.1',
    }, { 'dist/index.mjs': 'const source = "C:\\runner\\deepseek-harness"\n' })
    expectDistributionFailure(() => assertNoSourceLeak(badWindows), /source leak/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('package map derives names from tarball metadata and rejects duplicate names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-map-test-'))
  try {
    tarPackage(directory, 'one.tgz', { name: DSH_CLI_PACKAGE, version: VERSION })
    tarPackage(directory, 'two.tgz', { name: DSH_CLI_PACKAGE, version: VERSION })
    assert.throws(() => packageMapFromTarballs(directory, VERSION), /duplicate package name/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})