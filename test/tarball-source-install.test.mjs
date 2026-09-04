import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { testLifecycle } from './support/temp-lifecycle.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SMOKE = join(ROOT, 'scripts', 'tarball-smoke.mjs')
const VERSION = '0.1.2-alpha.1'
const SHA = 'a'.repeat(40)
const DSH_CLI = '@deepseek-ai/dsh'
const DSH_PRESETS = '@deepseek-ai/dsh-agent-presets'

function tarPackage(directory, fileName, metadata, files = {}) {
  const staging = join(directory, `stage-${fileName.replace(/[^a-z0-9]/giu, '-')}`)
  const packageDir = join(staging, 'package')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(metadata)}\n`)
  for (const [name, content] of Object.entries(files)) {
    const path = join(packageDir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const tarball = join(directory, fileName)
  const result = spawnSync('tar', ['-czf', tarball, '-C', staging, 'package'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  rmSync(staging, { recursive: true, force: true })
  return tarball
}

function candidateFiles() {
  return {
    'dist/index.mjs': 'export const SOURCE_PROBE = true\n',
    'dist/startup.mjs': 'export const STARTUP_PROBE = true\n',
    'dist/extensions.mjs': 'export const EXTENSIONS_PROBE = true\n',
    'dist/builtins.mjs': 'export const BUILTINS_PROBE = true\n',
    'dist/extension/advanced.mjs': 'export const ADVANCED_API_LEVEL = 1\n',
    'dist/extension/unstable.mjs': 'export const UNSTABLE_API_LEVEL = 1\n',
    'dist/index.d.mts': 'export declare const SOURCE_PROBE: boolean\n',
    'dist/startup.d.mts': 'export declare const STARTUP_PROBE: boolean\n',
    'dist/extensions.d.mts': 'export declare const EXTENSIONS_PROBE: boolean\n',
    'dist/builtins.d.mts': 'export declare const BUILTINS_PROBE: boolean\n',
    'dist/extension/advanced.d.mts': 'export declare const ADVANCED_API_LEVEL: 1\n',
    'dist/extension/unstable.d.mts': 'export declare const UNSTABLE_API_LEVEL: 1\n',
    'cordis.patch.yml': 'patch: []\n',
    'README.md': '# source probe\n',
    'README.en.md': '# source probe\n',
  }
}

function makeFixture(life, { includePresets = true, candidatePeers = { [DSH_CLI]: `>=${VERSION}` }, schemaVersion = 1 } = {}) {
  const root = life.tempDir('tarball-source-install-')
  const distribution = join(root, 'distribution')
  mkdirSync(distribution, { recursive: true })
  const packages = {}
  const cli = tarPackage(distribution, 'dsh-cli.tgz', {
    name: DSH_CLI,
    version: VERSION,
    dependencies: {
      [DSH_PRESETS]: VERSION,
    },
  })
  packages[DSH_CLI] = basename(cli)
  if (includePresets) {
    const presets = tarPackage(distribution, 'dsh-presets.tgz', {
      name: DSH_PRESETS,
      version: VERSION,
    })
    packages[DSH_PRESETS] = basename(presets)
  }
  const registryTarball = tarPackage(root, 'registry-dsh-presets.tgz', {
    name: DSH_PRESETS,
    version: VERSION,
  })
  writeFileSync(join(distribution, 'dsh-source-distribution.json'), `${JSON.stringify({
    schemaVersion,
    mode: 'source-pack',
    repository: 'deepseek-ai/deepseek-harness',
    sourceRef: SHA,
    sourceSha: SHA,
    version: VERSION,
    dirty: false,
    reproducible: true,
    packages,
  })}\n`)

  const candidate = tarPackage(root, 'candidate.tgz', {
    name: '@xmoon76/dsh-pi-tui',
    version: '0.0.0-test',
    private: false,
    type: 'module',
    main: 'dist/index.mjs',
    exports: {
      '.': './dist/index.mjs',
      './startup': './dist/startup.mjs',
      './extensions': './dist/extensions.mjs',
      './extensions/advanced': './dist/extension/advanced.mjs',
      './extensions/unstable': './dist/extension/unstable.mjs',
      './builtins': './dist/builtins.mjs',
    },
    peerDependencies: candidatePeers,
  }, candidateFiles())
  return { root, distribution, candidate, registryTarball }
}

function smokeEnvironment(fixture, registry = 'http://127.0.0.1:9/') {
  const npmrc = join(fixture.root, 'npmrc')
  writeFileSync(npmrc, `registry=${registry}\n`)
  const env = {
    ...process.env,
    NPM_CONFIG_REGISTRY: registry,
    npm_config_registry: registry,
    NPM_CONFIG_USERCONFIG: npmrc,
    npm_config_userconfig: npmrc,
    XDG_DATA_HOME: join(fixture.root, 'xdg-data'),
    XDG_CACHE_HOME: join(fixture.root, 'xdg-cache'),
  }
  delete env.DSH_SOURCE_DISTRIBUTION
  return env
}

function runSourceSmoke(fixture, { cliDistribution = fixture.distribution, envDistribution, registry, skipInstall = false } = {}) {
  const env = smokeEnvironment(fixture, registry)
  if (skipInstall) env.TARBALL_SMOKE_SKIP_INSTALL = '1'
  else delete env.TARBALL_SMOKE_SKIP_INSTALL
  if (envDistribution !== undefined) env.DSH_SOURCE_DISTRIBUTION = envDistribution
  const args = [SMOKE, fixture.candidate]
  if (cliDistribution !== undefined) args.push('--dsh-distribution', cliDistribution)
  const cwd = join(fixture.root, 'clean-cwd')
  mkdirSync(cwd, { recursive: true })
  return spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
  })
}

function runNpmSmoke(fixture) {
  const env = smokeEnvironment(fixture)
  delete env.TARBALL_SMOKE_SKIP_INSTALL
  const cwd = join(fixture.root, 'clean-cwd')
  mkdirSync(cwd, { recursive: true })
  return spawnSync(process.execPath, [SMOKE, fixture.candidate], {
    cwd,
    env,
    encoding: 'utf8',
  })
}

function outputOf(result) {
  return `${result.stdout}\n${result.stderr}`
}

function startRegistry(fixture) {
  const requestLog = join(fixture.root, 'registry-requests.log')
  writeFileSync(requestLog, '')
  const serverScript = `
const { createServer } = require('node:http')
const { appendFileSync, readFileSync } = require('node:fs')
const [tarball, log] = process.argv.slice(1)
const server = createServer((request, response) => {
  appendFileSync(log, request.url + '\\n')
  if (request.url.endsWith('.tgz')) {
    response.writeHead(200, { 'content-type': 'application/octet-stream' })
    response.end(readFileSync(tarball))
    return
  }
  const port = server.address().port
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify({
    name: '${DSH_PRESETS}',
    'dist-tags': { latest: '${VERSION}' },
    versions: {
      '${VERSION}': {
        name: '${DSH_PRESETS}',
        version: '${VERSION}',
        dist: { tarball: 'http://127.0.0.1:' + port + '/registry-dsh-presets.tgz' },
      },
    },
  }))
})
server.listen(0, '127.0.0.1', () => process.stdout.write(String(server.address().port) + '\\n'))
process.on('SIGTERM', () => server.close(() => process.exit(0)))
`
  const child = spawn(process.execPath, ['-e', serverScript, fixture.registryTarball, requestLog], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  return new Promise((resolve, reject) => {
    let output = ''
    let settled = false
    const fail = error => {
      if (settled) return
      settled = true
      reject(error)
    }
    child.once('error', fail)
    child.once('exit', code => {
      if (!settled) fail(new Error(`fixture registry exited before listening (${code})`))
    })
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      const port = output.match(/(\d+)\s*$/u)?.[1]
      if (port === undefined || settled) return
      settled = true
      resolve({ child, requestLog, url: `http://127.0.0.1:${port}/` })
    })
  })
}

async function stopRegistry(registry) {
  if (registry.child.exitCode !== null) return
  registry.child.kill('SIGTERM')
  await once(registry.child, 'exit')
}

test('source mode installs a fresh candidate and proves local DSH provenance', (t) => {
  const life = testLifecycle(t)
  const fixture = makeFixture(life)
  const result = runSourceSmoke(fixture)
  const output = outputOf(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /source distribution fresh install \(pnpm\)/)
  assert.match(output, /all reachable DSH packages resolve from local tarballs/)
  assert.match(output, /installed package contains dist/)
  assert.match(output, /all exports entries import/)
  assert.match(output, /DSH source SHA\s+: a{40}/)
  assert.match(output, /package count\s+: 2/)
})

test('source mode accepts DSH_SOURCE_DISTRIBUTION without a CLI argument', (t) => {
  const life = testLifecycle(t)
  const fixture = makeFixture(life)
  const result = runSourceSmoke(fixture, {
    cliDistribution: undefined,
    envDistribution: fixture.distribution,
  })
  const output = outputOf(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /source distribution fresh install \(pnpm\)/)
  assert.match(output, /all reachable DSH packages resolve from local tarballs/)
})

test('source distribution CLI argument takes precedence over its environment fallback', (t) => {
  const life = testLifecycle(t)
  const fixture = makeFixture(life)
  const wrongDistribution = makeFixture(life, { schemaVersion: 2 })
  const result = runSourceSmoke(fixture, { envDistribution: wrongDistribution.distribution })
  const output = outputOf(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /DSH source SHA\s+: a{40}/)
  assert.match(output, /package count\s+: 2/)
})

test('source mode rejects a skip-install override instead of bypassing fresh install', (t) => {
  const life = testLifecycle(t)
  const fixture = makeFixture(life)
  const result = runSourceSmoke(fixture, { skipInstall: true })
  const output = outputOf(result)
  assert.notEqual(result.status, 0, output)
  assert.match(output, /TARBALL_SMOKE_SKIP_INSTALL=1 cannot be combined with a DSH source distribution/)
})

test('source mode rejects a missing reachable DSH package without registry fallback', async (t) => {
  const life = testLifecycle(t)
  const fixture = makeFixture(life, { includePresets: false })
  const registry = await startRegistry(fixture)
  life.defer(() => stopRegistry(registry))
  const result = runSourceSmoke(fixture, { registry: registry.url })
  const output = outputOf(result)
  assert.notEqual(result.status, 0, output)
  assert.match(output, /@deepseek-ai\/dsh references DSH package @deepseek-ai\/dsh-agent-presets/)
  assert.doesNotMatch(output, /source distribution fresh install \(pnpm\).*ok/u)
  assert.equal(readFileSync(registry.requestLog, 'utf8'), '', 'source preflight must prevent registry fallback requests')
})

test('source mode rejects a malformed distribution', (t) => {
  const life = testLifecycle(t)
  const fixture = makeFixture(life, { schemaVersion: 2 })
  const result = runSourceSmoke(fixture)
  const output = outputOf(result)
  assert.notEqual(result.status, 0, output)
  assert.match(output, /schemaVersion must be 1/)
})

test('npm mode without a distribution keeps the existing fresh npm install path', (t) => {
  const life = testLifecycle(t)
  const fixture = makeFixture(life, { candidatePeers: {} })
  const result = runNpmSmoke(fixture)
  const output = outputOf(result)
  assert.equal(result.status, 0, output)
  assert.match(output, /tarball installs standalone \(npm install --omit=dev\)/)
  assert.match(output, /all exports entries import/)
})
