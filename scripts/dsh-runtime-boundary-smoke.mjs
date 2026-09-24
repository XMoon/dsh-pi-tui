#!/usr/bin/env node
/**
 * Verify the npm/DSH runtime boundary with a real candidate tarball and a
 * published below-floor runtime. The candidate must fail on the unsupported
 * runtime. The startup row names the current matrix floor and suggests the
 * recommended published npm upgrade target (both derived from
 * src/dsh-compat-matrix.json, currently the 0.1.7-rc.1 floor).
 *
 * Usage: node scripts/dsh-runtime-boundary-smoke.mjs [path-to-candidate.tgz]
 *       pnpm smoke:boundary -- [path-to-candidate.tgz]
 *
 * Set DSH_BOUNDARY_KEEP=1 to preserve the isolated profile on failure.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import semver from 'semver'

import { cleanupTimedOutProcessTree, pnpmExecutable } from './lib/process.mjs'
import { COMPAT_MATRIX } from './lib/dsh-compat.mjs'

const PNPM_COMMAND = pnpmExecutable()
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(SCRIPT_DIR, '..')
const EXPECTED_PACKAGE_NAME = '@xmoon76/dsh-pi-tui'

// Only PUBLISHED versions can be installed by this smoke. The real
// rejection case is 0.1.1-rc.2; the exact prerelease floor is covered
// by the startup-gate unit tests.
const OLD_DSH_VERSION = '0.1.1-rc.2'
const TARGET_DSH_VERSION = COMPAT_MATRIX.current.upgradeDsh
const RAW_BOUNDARY_ERROR = /ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|does not provide an export|Cannot find module|ERR_REQUIRE_ESM/iu
const EXPECTED_BOUNDARY_IMPORT = /(?:@xmoon76\/dsh-pi-tui|dsh-pi-tui|@deepseek-ai\/dsh-(?:agent|agent-presets|authorization|cmdline|commands|credentials|goal|jobs|llm|llm-retry|permission-presets|plan-mode|sandbox-policy|session|session-log-export|session-persistence|session-title|settings|shell|skill|subagent|token-meter|tool-todo|tool-workflow|tools|user-approval|user-questions|tool-subagent|cordis-host-runner))(?=['"/]|$)/iu

function run(command, args, options = {}) {
  const detached = options.detached ?? process.platform !== 'win32'
  const result = spawnSync(command, args, { encoding: 'utf8', ...options, detached })
  cleanupTimedOutProcessTree(result, { detached })
  return result
}

function outputOf(result) {
  return [result.stdout, result.stderr, result.error?.message]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('\n')
}

function candidateArgument(value) {
  return value === '--' ? process.argv[3] : value
}

export function resolveTarball(explicit, packageRoot = PACKAGE_ROOT) {
  if (explicit !== undefined) {
    const path = resolve(explicit)
    const info = existsSync(path) ? lstatSync(path) : undefined
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error(`candidate tarball must be a regular file with exactly one link: ${explicit}`)
    return path
  }
  const candidates = readdirSync(packageRoot)
    .filter(name => /^xmoon76-dsh-pi-tui-.*\.tgz$/u.test(name))
    .map(name => join(packageRoot, name))
    .filter(path => {
      const info = lstatSync(path)
      return info.isFile() && !info.isSymbolicLink() && info.nlink === 1
    })
  if (candidates.length === 0) throw new Error(`no candidate tarball in ${packageRoot}; run pnpm pack:release first`)
  if (candidates.length > 1) throw new Error(`expected one candidate tarball, found ${candidates.map(basename).join(', ')}`)
  return candidates[0]
}

function candidatePackage(tarball) {
  const result = run('tar', ['-xOf', tarball, 'package/package.json'])
  if (result.status !== 0) throw new Error(`could not read candidate package.json:\n${outputOf(result)}`)
  const pkg = JSON.parse(result.stdout)
  if (pkg.name !== EXPECTED_PACKAGE_NAME) throw new Error(`candidate name is ${String(pkg.name)}, expected ${EXPECTED_PACKAGE_NAME}`)
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) throw new Error('candidate has no version')
  return pkg
}

function isolatedEnvironment(workDir, home, dshHome) {
  const env = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TERM: 'xterm-256color',
    HOME: home,
    DSH_HOME: dshHome,
    npm_config_registry: 'https://registry.npmjs.org',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    npm_config_minimum_release_age: '0',
    pnpm_config_minimum_release_age: '0',
    npm_config_userconfig: join(workDir, 'npmrc'),
    NPM_CONFIG_USERCONFIG: join(workDir, 'npmrc'),
  }
  for (const key of ['LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'CI']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

function installDsh(harnessDir, env) {
  const result = run(PNPM_COMMAND, [
    'install', '--ignore-scripts', '--no-frozen-lockfile', '--config.minimum-release-age=0', '--reporter=append-only',
  ], { cwd: harnessDir, env, timeout: 180_000 })
  if (result.status !== 0) throw new Error(`isolated old DSH install failed:\n${outputOf(result)}`)
}

function dshInvocation(harnessDir) {
  const entry = join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) throw new Error(`installed DSH binary entry is missing: ${entry}`)
  return [process.execPath, entry]
}

function runDsh(invocation, args, harnessDir, env) {
  return run(invocation[0], [...invocation.slice(1), ...args], {
    cwd: harnessDir,
    env,
    timeout: 30_000,
  })
}

function installCandidate(invocation, tarball, harnessDir, env) {
  const result = runDsh(invocation, ['plugin', '--profile', 'pi-tui', 'add', tarball], harnessDir, env)
  if (result.status !== 0) throw new Error(`candidate plugin install failed:\n${outputOf(result)}`)
}

// Mirrors src/startup.ts HARNESS_COMPAT: every runtime below the published
// npm floor (currently 0.1.7-rc.1, derived from the compat matrix) is
// rejected. The exact prerelease boundary is tested by startup.test.ts
// because only the 0.1.1 line is installed by this smoke.
function floorNoticeFor(oldVersion) {
  if (semver.lt(oldVersion, TARGET_DSH_VERSION)) {
    return {
      requires: TARGET_DSH_VERSION,
      // Derived from the same floor the notice names, so a version-floor move
      // cannot leave this smoke asserting a stale upgrade target.
      upgradeCommand: 'npm install -g --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs,fs-ext @deepseek-ai/dsh@'
        + TARGET_DSH_VERSION,
    }
  }
  return undefined
}

function assertBoundary(output, status, oldVersion = OLD_DSH_VERSION, expectedBundleVersion = undefined) {
  if (status === 0) throw new Error(`0.4 candidate unexpectedly started on DSH ${oldVersion}`)
  // Stale Source Mode wording is forbidden on EVERY outcome path — the
  // friendly advisory AND the concurrent-loader raw import fallback — so a
  // raw failure carrying old wording cannot slip through.
  if (output.includes('pinned master source') || output.includes('pinned DSH master source distribution')) {
    throw new Error(`boundary output must not keep Source Mode wording:\n${output}`)
  }
  const notice = floorNoticeFor(oldVersion)
  if (notice === undefined) throw new Error(`no floor notice tier for DSH ${oldVersion}`)
  const friendly = output.includes(`running dsh ${oldVersion}`)
    && output.includes(`DeepSeek Harness ${notice.requires} or later`)
  if (friendly) {
    const required = [
      'dsh-pi-tui',
      `running dsh ${oldVersion}`,
      `DeepSeek Harness ${notice.requires} or later`,
      notice.upgradeCommand,
      'dsh --profile pi-tui',
    ]
    // The candidate's OWN version label is part of the notice; when the real
    // smoke supplies the candidate tarball's version, a stale packed bundle
    // (built before a version bump) fails here instead of passing silently.
    if (expectedBundleVersion !== undefined) required.push(`dsh-pi-tui v${expectedBundleVersion}`)
    for (const text of required) {
      if (!output.includes(text)) throw new Error(`boundary output is missing ${JSON.stringify(text)}:\n${output}`)
    }
    return
  }
  // DSH Loader mounts rows concurrently, so an incompatible row may fail
  // before the advisory startup notice gets to print. In that case the raw
  // import boundary is the expected evidence; do not make message ordering a
  // release requirement.
  // A below-floor runtime that predates the declarative preset registry
  // cannot even LOAD the profile: its own bundle loader reads
  // `dsh.bundle.patch` as a single string and crashes on the array form the
  // candidate ships. That crash IS the below-floor rejection for such
  // runtimes — the candidate never starts on them, which is the contract —
  // so it is accepted as a third recognized rejection mechanism.
  const oldLoaderRejectedArrayPatch = output.includes('ERR_INVALID_ARG_TYPE')
    && output.includes('dsh-app-boot')
    && output.includes('loadProfile')
    && /"path" argument must be of type string/u.test(output)
  if (oldLoaderRejectedArrayPatch) return
  if (!RAW_BOUNDARY_ERROR.test(output) || !EXPECTED_BOUNDARY_IMPORT.test(output)) {
    throw new Error(`unsupported runtime failed without either advisory guidance or an expected TUI/DSH import boundary:\n${output}`)
  }
}

function main() {
  const tarball = resolveTarball(candidateArgument(process.argv[2]))
  const pkg = candidatePackage(tarball)
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-runtime-boundary-'))
  const home = join(workDir, 'home')
  const dshHome = join(workDir, 'dsh-home')
  const harnessDir = join(workDir, 'harness')
  mkdirSync(home, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(harnessDir, { recursive: true })
  writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const env = isolatedEnvironment(workDir, home, dshHome)
  try {
    // One published below-floor runtime rejects the candidate for real
    // (0.1.1-rc.2). The exact prerelease floor is covered by the
    // startup-gate unit tests.
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-runtime-boundary-harness',
      private: true,
      type: 'module',
      dependencies: { '@deepseek-ai/dsh': OLD_DSH_VERSION },
    }, null, 2) + '\n', 'utf8')
    installDsh(harnessDir, env)
    const dsh = dshInvocation(harnessDir)
    const version = runDsh(dsh, ['--version'], harnessDir, env)
    if (version.status !== 0 || !outputOf(version).includes(OLD_DSH_VERSION)) {
      throw new Error(`installed DSH version check failed:\n${outputOf(version)}`)
    }
    installCandidate(dsh, tarball, harnessDir, env)
    const started = runDsh(dsh, ['--profile', 'pi-tui', '--session', 'boundary-check'], harnessDir, env)
    assertBoundary(outputOf(started), started.status, OLD_DSH_VERSION, pkg.version)
    console.log(`runtime boundary smoke passed — ${basename(tarball)} × DSH ${OLD_DSH_VERSION} (rejected)`)
  } finally {
    if (process.env.DSH_BOUNDARY_KEEP !== '1') rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved boundary environment: ${workDir}`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`RUNTIME_BOUNDARY_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

export { assertBoundary }
