/**
 * Input/opt-in guard for the macOS CUA native qualification lane.
 *
 * The real native matrix lives in `scripts/smoke/macos-cua-parity.mjs` and is
 * driven by an operator on a real macOS Host. This tooling test is the L0
 * INPUT/cleanup policy guard only: it proves that rejected arguments, a
 * non-macOS host and an invalid candidate are refused before any work root,
 * isolated profile, Host, helper or OS authorization can start. It does NOT
 * prove native CUA, the Question seat, the Attachment sink or macOS TCC.
 *
 * @module macos-cua-parity.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { testLifecycle } from '../support/temp-lifecycle.ts'
import { npmDshVersion } from '../../scripts/lib/dsh-distribution.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'smoke', 'macos-cua-parity.mjs')

const OPERATOR_ENV_KEYS = [
  'MACOS_CUA_PROFILE_PATCH',
  'MACOS_CUA_CREDENTIALS',
  'MACOS_CUA_EVIDENCE_DIR',
  'MACOS_CUA_KEEP',
  'MACOS_CUA_OPERATOR_TIMEOUT_MS',
]

/** One private HOME/DSH_HOME/TMPDIR set owned by this case. */
function privateRunDirs(life) {
  return {
    home: life.tempDir('cua-private-home-'),
    dshHome: life.tempDir('cua-private-dsh-'),
    tmpRoot: life.tempDir('cua-private-tmp-'),
  }
}

function laneEnvironment(dirs) {
  const env = {
    ...process.env,
    HOME: dirs.home,
    DSH_HOME: dirs.dshHome,
    TMPDIR: dirs.tmpRoot,
    TMP: dirs.tmpRoot,
    TEMP: dirs.tmpRoot,
  }
  for (const key of OPERATOR_ENV_KEYS) delete env[key]
  return env
}

function runLane(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
}

/** Run the lane with a declared platform, without a real OS of that family. */
function runLaneAsPlatform(args, env, platform) {
  const probe = [
    `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} })`,
    `process.argv = [process.execPath, ${JSON.stringify(SCRIPT)}, ...${JSON.stringify(args)}]`,
    `await import(${JSON.stringify(SCRIPT)})`,
  ].join('\n')
  return spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
}

function workRootsIn(tmpRoot) {
  return readdirSync(tmpRoot).filter(name => name.startsWith('dsh-macos-cua-'))
}

function assertNoSideEffects(dirs) {
  assert.deepEqual(workRootsIn(dirs.tmpRoot), [], 'a refused input must not create a lane work root')
  assert.deepEqual(readdirSync(dirs.home), [], 'a refused input must not write the private account home')
  assert.deepEqual(readdirSync(dirs.dshHome), [], 'a refused input must not create an isolated DSH home')
}

/** A synthetic manifest-only tarball: an INPUT fixture, never a qualified pairing. */
function candidateFixture(life) {
  const sourcePackage = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const directory = life.tempDir('cua-candidate-fixture-')
  mkdirSync(join(directory, 'package'), { recursive: true })
  writeFileSync(join(directory, 'package', 'package.json'), JSON.stringify({
    name: sourcePackage.name,
    version: sourcePackage.version,
    devDependencies: { '@deepseek-ai/dsh-agent': npmDshVersion() },
  }, null, 2))
  const tarball = join(directory, 'candidate.tgz')
  const tar = spawnSync('tar', ['-czf', tarball, '-C', directory, 'package/package.json'], { encoding: 'utf8' })
  assert.equal(tar.status, 0, `the input fixture could not be packed: ${tar.stderr ?? ''}`)
  assert.ok(existsSync(tarball), 'the input fixture tarball is missing')
  return tarball
}

test('a missing or extra candidate is refused before a work root, profile or Host exists', (t) => {
  const life = testLifecycle(t)
  const dirs = privateRunDirs(life)
  const env = laneEnvironment(dirs)
  const fixture = candidateFixture(life)

  for (const args of [[], [fixture, fixture]]) {
    const result = runLane(args, env)
    assert.notEqual(result.status, 0, `the lane accepted ${JSON.stringify(args)}`)
    assert.match(result.stderr, /MACOS_CUA: INPUT_UNQUALIFIED/u,
      `the lane did not classify the rejected argument count: ${result.stderr.slice(-800)}`)
    assert.match(result.stderr, /exactly one candidate tarball is required/u,
      'the refusal did not name the one-candidate rule')
    assert.equal(result.stdout, '', 'a refused input must not print a report')
  }
  assertNoSideEffects(dirs)
})

test('a non-macOS host is refused before the candidate install, tmux scene or Host starts', (t) => {
  const life = testLifecycle(t)
  const dirs = privateRunDirs(life)
  const env = laneEnvironment(dirs)
  const fixture = candidateFixture(life)

  const result = runLaneAsPlatform([fixture], env, 'linux')
  assert.notEqual(result.status, 0, 'the lane accepted a non-macOS host')
  assert.match(result.stderr, /MACOS_CUA: NOT_VERIFIED/u,
    `the non-Darwin refusal was not classified: ${result.stderr.slice(-800)}`)
  assert.match(result.stderr, /requires a real macOS host/u,
    'the non-Darwin refusal did not name the missing platform')
  assert.doesNotMatch(result.stderr, /DSH Computer Use|TextEdit|Aqua/u,
    'the lane reached the macOS-only prerequisites before refusing the platform')
  assertNoSideEffects(dirs)
})

test('an invalid candidate tarball is refused before the isolated profile or any Host command runs', (t) => {
  const life = testLifecycle(t)
  const dirs = privateRunDirs(life)
  const env = laneEnvironment(dirs)
  const invalid = join(life.tempDir('cua-invalid-'), 'not-a-tarball.tgz')
  writeFileSync(invalid, 'this is not a package tarball\n')

  const result = runLane([invalid], env)
  assert.notEqual(result.status, 0, 'the lane accepted an invalid candidate tarball')
  assert.match(result.stderr, /MACOS_CUA: INPUT_UNQUALIFIED/u,
    `the invalid candidate was not classified as an input problem: ${result.stderr.slice(-800)}`)
  assert.match(result.stderr, /candidate tarball was refused/u,
    'the invalid candidate refusal did not name the candidate input')
  assertNoSideEffects(dirs)
})

test('--help alone exits zero and names the operator model/credential inputs', () => {
  const result = spawnSync(process.execPath, [SCRIPT, '--help'], {
    cwd: ROOT,
    env: { ...process.env },
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 0, `--help exited ${String(result.status)}: ${result.stderr.slice(-800)}`)
  assert.match(result.stdout, /usage: node scripts\/smoke\/macos-cua-parity\.mjs/u)
  assert.match(result.stdout, /MACOS_CUA_PROFILE_PATCH/u)
  assert.match(result.stdout, /MACOS_CUA_CREDENTIALS/u)
  assert.match(result.stdout, /never runs on Linux/u)
})

test('the native lane stays an explicit opt-in outside test, pack and ordinary smokes', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts?.['smoke:macos-cua'], 'node scripts/smoke/macos-cua-parity.mjs')
  for (const scriptName of ['test', 'pack:release', 'verify:release', 'smoke:release', 'smoke:macos-split']) {
    const body = pkg.scripts?.[scriptName]
    assert.equal(typeof body, 'string', `the ${scriptName} script is missing`)
    assert.doesNotMatch(body, /smoke:macos-cua\b|macos-cua-parity/u,
      `${scriptName} must not run the native CUA lane`)
  }
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.doesNotMatch(ci, /smoke:macos-cua|macos-cua-parity/u,
    'Linux CI must not select the native CUA lane')
})
