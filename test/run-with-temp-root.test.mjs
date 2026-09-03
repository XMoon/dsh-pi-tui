/**
 * Regression tests for the disposable temp-root runner: exit-code and
 * signal passthrough, TMPDIR containment, glob expansion (the child is
 * spawned without a shell), keep-mode, and root removal.
 * @module @xmoon76/dsh-pi-tui/run-with-temp-root.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { buildSpawnPlan } from '../scripts/run-with-temp-root.mjs'

const RUNNER = fileURLToPath(new URL('../scripts/run-with-temp-root.mjs', import.meta.url))

function run(args, options = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', ...options })
}

test('the runner passes the child exit code through and removes its root', async (t) => {
  const life = testLifecycle(t)
  const before = countRunnerRoots()
  const ok = run(['node', '-e', 'process.exit(0)'])
  assert.equal(ok.status, 0)
  const failed = run(['node', '-e', 'process.exit(5)'])
  assert.equal(failed.status, 5)
  assert.equal(countRunnerRoots(), before, 'a normal run must not leave a runner root behind')
})

test('a child killed by a signal maps to 128+signo', () => {
  const result = run(['node', '-e', "process.kill(process.pid, 'SIGTERM')"])
  assert.equal(result.status, 143)
})

test('the child sees TMPDIR/TMP/TEMP pointed at the disposable root', () => {
  const result = run(['node', '-e', "console.log(process.env.TMPDIR + '|' + process.env.TMP + '|' + process.env.TEMP)"])
  assert.equal(result.status, 0)
  const [tmpdirValue, tmpValue, tempValue] = result.stdout.trim().split('|')
  assert.match(tmpdirValue, /dsh-pi-tui-test-run-/u)
  assert.equal(tmpValue, tmpdirValue)
  assert.equal(tempValue, tmpdirValue)
})

test('glob arguments are expanded by the runner (no shell involved)', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-runner-glob-')
  writeFileSync(join(dir, 'a.test.ts'), '')
  writeFileSync(join(dir, 'b.test.ts'), '')
  writeFileSync(join(dir, 'notes.md'), '')
  const pattern = join(dir, '*.test.ts')
  const result = run(['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', pattern])
  assert.equal(result.status, 0)
  const received = JSON.parse(result.stdout.trim())
  assert.deepEqual(received, [join(dir, 'a.test.ts'), join(dir, 'b.test.ts')])
})

test('a glob with no matches passes through literally for the command to report', async (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('dsh-runner-nomatch-')
  const pattern = join(dir, '*.missing')
  const result = run(['node', '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', pattern])
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout.trim()), [pattern])
})

test('DSH_TEST_KEEP_TMP=1 keeps and prints the run root', async (t) => {
  const life = testLifecycle(t)
  const result = run(['node', '-e', 'process.exit(0)'], { env: { ...process.env, DSH_TEST_KEEP_TMP: '1' } })
  assert.equal(result.status, 0)
  const match = result.stderr.match(/keeping (\S+) \(DSH_TEST_KEEP_TMP=1\)/u)
  assert.ok(match !== null, `keep mode must print the root, got: ${result.stderr}`)
  const kept = match[1]
  assert.ok(existsSync(kept), 'keep mode must retain the root')
  rmSync(kept, { recursive: true, force: true })
})

function countRunnerRoots() {
  // Inspect the ACTUAL temp root (os.tmpdir honors TMPDIR, so this works
  // under the outer runner's containment and on Windows) with Node fs APIs.
  return readdirSync(tmpdir()).filter(name => name.startsWith('dsh-pi-tui-test-run-')).length
}

// ── Windows spawn-plan resolution (unit-tested from any host) ──────────────

const WIN = { platform: 'win32', comspec: 'C:\\Windows\\System32\\cmd.exe', pathEnv: 'C:\\tools;C:\\Windows\\System32', pathextEnv: '.COM;.EXE;.BAT;.CMD' }

test('buildSpawnPlan runs commands directly on POSIX', () => {
  const plan = buildSpawnPlan(['node', '--test', 'a.test.ts'])
  assert.deepEqual(plan, { command: 'node', args: ['--test', 'a.test.ts'], shell: false })
})

test('buildSpawnPlan delegates a resolved .cmd shim to cmd.exe with a cmd-safe quoted line', async (t) => {
  const life = testLifecycle(t)
  const tools = life.tempDir('dsh-runner-win-')
  // A path WITH SPACES: cmd /d /s /c strips the first and last quote of
  // the command line, so the line must carry an outer quote pair for the
  // inner per-argument quotes to survive.
  const spaced = join(tools, 'with space')
  mkdirSync(spaced)
  writeFileSync(join(spaced, 'pnpm.cmd'), '@echo off\r\n')
  const plan = buildSpawnPlan(['pnpm', '--dir', 'packages/pi-tui', 'test'], {
    ...WIN,
    pathEnv: `${spaced};C:\\Windows\\System32`,
  })
  assert.equal(plan.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.equal(plan.shell, false)
  assert.equal(plan.args[0], '/d')
  assert.equal(plan.args[1], '/s')
  assert.equal(plan.args[2], '/c')
  const line = plan.args[3]
  assert.ok(line.startsWith('"') && line.endsWith('"'), `the line must carry an outer quote pair: ${line}`)
  assert.ok(line.includes(`"${join(spaced, 'pnpm.cmd')}"`), `the shim must be quoted: ${line}`)
  assert.ok(line.includes('"--dir"'), `args must be quoted: ${line}`)
  assert.ok(line.includes('"packages/pi-tui"'), `args must be quoted: ${line}`)
})

test('buildSpawnPlan quotes embedded double quotes with cmd doubling', async (t) => {
  const life = testLifecycle(t)
  const tools = life.tempDir('dsh-runner-winquote-')
  writeFileSync(join(tools, 'pnpm.cmd'), '@echo off\r\n')
  const plan = buildSpawnPlan(['pnpm', 'a"b'], { ...WIN, pathEnv: `${tools};C:\\Windows\\System32` })
  const line = plan.args[3]
  assert.ok(line.startsWith('"') && line.endsWith('"'), `the line must carry an outer quote pair: ${line}`)
  assert.ok(line.includes('"a""b"'), `embedded quotes must be doubled: ${line}`)
})

test('buildSpawnPlan runs a resolved real executable directly on Windows', async (t) => {
  const life = testLifecycle(t)
  const tools = life.tempDir('dsh-runner-winexe-')
  writeFileSync(join(tools, 'node.exe'), 'MZ')
  const plan = buildSpawnPlan(['node', '--version'], { ...WIN, pathEnv: `${tools};C:\\Windows\\System32` })
  assert.equal(plan.command, join(tools, 'node.exe'))
  assert.deepEqual(plan.args, ['--version'])
  assert.equal(plan.shell, false)
})

test('buildSpawnPlan passes an unresolvable command through on Windows', () => {
  const plan = buildSpawnPlan(['definitely-not-a-command', 'x'], { ...WIN, pathEnv: 'C:\\empty' })
  assert.deepEqual(plan, { command: 'definitely-not-a-command', args: ['x'], shell: false })
})

test('buildSpawnPlan honors an empty PATH entry as the current directory', async (t) => {
  const life = testLifecycle(t)
  const cwd = life.tempDir('dsh-runner-winpath-')
  writeFileSync(join(cwd, 'pnpm.cmd'), '@echo off\r\n')
  // PATH starts with an empty component (current directory on Windows).
  const plan = buildSpawnPlan(['pnpm', '--version'], { ...WIN, pathEnv: ';C:\\Windows\\System32', cwd })
  assert.equal(plan.command, 'C:\\Windows\\System32\\cmd.exe')
  const line = plan.args[3]
  assert.ok(line.includes(`"${join(cwd, 'pnpm.cmd')}"`), `the cwd shim must be resolved: ${line}`)
})
