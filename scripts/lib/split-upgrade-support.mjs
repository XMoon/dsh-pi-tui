/**
 * Shared support for the Split Upgrade scenes.
 *
 * This module owns the ONE implementation of every helper the Vitest Upgrade
 * Scene/Supervisor and the real native qualification share: installed payload
 * identity, Host/Session facts, the side-by-side build install and the real
 * Supervisor identity/seat facts.
 *
 * Importing this module performs no I/O, creates no directory and starts no
 * process. It never imports a lane runner or a selection registry.
 *
 * @module split-upgrade-support
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

import { run } from './dsh-smoke-harness.mjs'
import { SplitSmokeAssertionError } from './split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from './split-smoke-fixtures.mjs'
import { productionBuildId, readJson, readStartIdentity, seatIsFree } from './split-smoke-processes.mjs'

/** The only package name a split-upgrade artifact may carry. */
export const EXPECTED_PACKAGE_NAME = '@xmoon76/dsh-pi-tui'

/** One lane assertion: the shared caller's own line becomes the published site. */
function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * sha256 over every regular file in one installed package tree. This proves
 * byte identity of the old installation across the side-by-side install, not
 * only that the profile still resolves the same directory path.
 */
export function installedPayloadHash(packageRoot) {
  const hash = createHash('sha256')
  const files = readdirSync(packageRoot, { recursive: true })
    .filter(name => {
      try {
        return statSync(join(packageRoot, name)).isFile()
      } catch {
        return false
      }
    })
    .map(name => relative(packageRoot, join(packageRoot, name)).split(sep).join('/'))
    .sort()
  for (const name of files) {
    hash.update(name)
    hash.update('\0')
    hash.update(sha256(join(packageRoot, ...name.split('/'))))
    hash.update('\n')
  }
  return hash.digest('hex')
}

/** Shared process identity facts re-exported for the Upgrade Supervisor/scenes. */
export { productionBuildId, seatIsFree }
export { readStartIdentity as readProcessStarttime }

export function safeIdentity(record) {
  return {
    schema: record.schema,
    scopeId: record.scopeId,
    instanceId: record.instanceId,
    hostPid: record.hostPid,
    hostStarttime: record.hostStarttime,
    origin: record.origin,
    protocol: record.protocol,
    bundleVersion: record.bundleVersion,
    dshVersion: record.dshVersion,
    buildId: record.buildId,
  }
}

export function assertIdentityKept(actual, expected, label) {
  for (const key of ['scopeId', 'instanceId', 'hostPid', 'hostStarttime', 'protocol', 'bundleVersion', 'dshVersion', 'buildId']) {
    assert(actual?.[key] === expected?.[key], `${label}: identity ${key} changed`)
  }
}

/**
 * One bounded wait for the shared C1 workload fixture. The shared default is
 * 60s; the Upgrade scenes historically wait 120s, so this wrapper fixes that
 * explicit default WITHOUT copying the shared parser or polling loop.
 */
export async function waitForUpgradeC1WorkEvent(workRoot, predicate, label, timeoutMs = 120_000) {
  return await waitForC1WorkEvent(workRoot, predicate, label, timeoutMs)
}

export function c1WorkHadRelease(workRoot) {
  return readC1WorkEvents(workRoot).some(event => event.kind === 'long-turn-released')
}

export function scopeDirOf(dshHome, scopeId) {
  return join(dshHome, 'run', 'dsh-pi-tui', scopeId)
}

/** Every durable Host Session log under the isolated DSH home (sorted). */
export function sessionLogFiles(dshHome) {
  const root = join(dshHome, 'sessions')
  if (!existsSync(root)) return []
  return readdirSync(root, { recursive: true })
    .map(name => String(name))
    .filter(name => name.endsWith('.jsonl.zstd'))
    .sort()
}

/**
 * Assert a NEW 0.5.8 side build carries its Client platform Store closure
 * inside the packed Client chunk: no runtime dependencies/peers for the three
 * packages and no external Store/Zustand/Immer import in dist.
 */
function assertBundledClientClosure(packageRoot, label) {
  const manifest = readJson(join(packageRoot, 'package.json'))
  for (const name of ['@deepseek-ai/dsh-client-store', 'zustand', 'immer']) {
    assert(manifest.dependencies?.[name] === undefined,
      `${label}: the new build declares runtime dependency ${name}`)
    assert(manifest.peerDependencies?.[name] === undefined,
      `${label}: the new build declares runtime peer ${name}`)
  }
  const distDir = join(packageRoot, 'dist')
  let storeChunk
  for (const file of readdirSync(distDir).filter(name => name.endsWith('.mjs'))) {
    const text = readFileSync(join(distDir, file), 'utf8')
    if (text.includes('createSnapshotStore') && text.includes('defineStore')) {
      assert(storeChunk === undefined, `${label}: the Store implementation is split across chunks ${storeChunk}, ${file}`)
      storeChunk = file
    }
    const external = [...text.matchAll(/(?:from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\))/gu)]
      .map(match => match[1] ?? match[2] ?? match[3] ?? match[4])
      .filter(specifier => ['@deepseek-ai/dsh-client-store', 'zustand', 'immer'].some(name => specifier === name || specifier.startsWith(`${name}/`)))
    assert(external.length === 0, `${label}: ${file} still imports the Store closure externally: ${external.join(', ')}`)
  }
  assert(storeChunk !== undefined, `${label}: no packed Client chunk carries the bundled Store`)
  return { storeChunk }
}

export function installSideBuild(dir, tarball, env, targetDshVersion, { legacyClientPeers = false } = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.npmrc'), 'registry=https://registry.npmjs.org\n', { mode: 0o600 })
  const dependencies = {
    [EXPECTED_PACKAGE_NAME]: `file:${tarball}`,
    ...(legacyClientPeers
      ? {
          '@deepseek-ai/dsh-client-store': targetDshVersion,
          zustand: '4.5.7',
          immer: '10.2.0',
        }
      : {}),
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'split-upgrade-side-build',
    private: true,
    version: '1.0.0',
    dependencies,
  }, null, 2) + '\n', 'utf8')
  const result = run('pnpm', [
    'install',
    '--ignore-scripts',
    '--no-frozen-lockfile',
    '--config.auto-install-peers=false',
    '--config.minimum-release-age=0',
    '--reporter=append-only',
  ], { cwd: dir, env, timeout: 10 * 60_000 })
  if (result.status !== 0) {
    throw new Error(`the side-by-side new-build install failed:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  const packageRoot = realpathSync(join(dir, 'node_modules', EXPECTED_PACKAGE_NAME))
  if (!existsSync(join(packageRoot, 'dist', 'local-client.mjs'))) {
    throw new Error('the side-by-side new-build install has no local Client entry')
  }
  if (!legacyClientPeers) assertBundledClientClosure(packageRoot, 'side-by-side new build')
  return packageRoot
}
