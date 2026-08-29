import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

import { cleanupTimedOutProcessTree, runBounded } from '../scripts/lib/process.mjs'

function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('synchronous timeout cleanup terminates the whole process tree on every platform', () => {
  const windowsCalls = []
  cleanupTimedOutProcessTree(
    { pid: 42, error: { code: 'ETIMEDOUT' } },
    { platform: 'win32', spawnSync: (...args) => windowsCalls.push(args) },
  )
  assert.deepEqual(windowsCalls[0], [
    'taskkill',
    ['/pid', '42', '/t', '/f'],
    { stdio: 'ignore', timeout: 5_000 },
  ])

  const unixCalls = []
  cleanupTimedOutProcessTree(
    { pid: 43, error: { code: 'ETIMEDOUT' } },
    { platform: 'linux', detached: true, kill: (...args) => unixCalls.push(args) },
  )
  assert.deepEqual(unixCalls, [[-43, 'SIGKILL']])
})

test('bounded process execution kills descendants after timeout', { timeout: 5_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-process-test-'))
  const pidFile = join(directory, 'child.pid')
  try {
    const childScript = [
      "const { spawn } = require('node:child_process')",
      "const fs = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'process.on(\\\"SIGTERM\\\", () => {}); setTimeout(() => {}, 60000)'], { stdio: 'ignore' })",
      `fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      'setTimeout(() => {}, 60000)',
    ].join(';')
    const result = await runBounded(process.execPath, ['-e', childScript], {
      timeoutMs: 1_000,
      label: 'process-tree-test',
    })
    assert.equal(result.timedOut, true)
    assert.equal(result.error?.code, 'ETIMEDOUT')
    assert.ok(existsSync(pidFile), 'the descendant should have started before timeout')
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    assert.ok(Number.isInteger(childPid) && childPid > 0)
    const deadline = Date.now() + 1_000
    while (isAlive(childPid) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(isAlive(childPid), false, 'timeout must not orphan the descendant')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('bounded process execution reports missing commands without hanging', async () => {
  const result = await runBounded('/definitely/missing/dsh-command', [], { timeoutMs: 1_000 })
  assert.equal(result.status, null)
  assert.equal(result.timedOut, false)
  assert.equal(result.error?.code, 'ENOENT')
})

test('test-environment preparation bounds its package-manager child tree', { timeout: 5_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-prepare-process-test-'))
  const executable = join(directory, 'fake-pnpm.mjs')
  const pidFile = join(directory, 'child.pid')
  const childCode = "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"
  writeFileSync(executable, `#!/usr/bin/env node\nimport { spawn } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nconst child = spawn(process.execPath, ['-e', ${JSON.stringify(childCode)}], { stdio: 'ignore' })\nwriteFileSync(${JSON.stringify(pidFile)}, String(child.pid))\nsetTimeout(() => {}, 60000)\n`)
  chmodSync(executable, 0o755)
  const previousExecutable = process.env.PNPM_EXECUTABLE
  process.env.PNPM_EXECUTABLE = executable
  try {
    const { runInstall } = await import(`../scripts/prepare-dsh-test-environment.mjs?process-test=${Date.now()}`)
    await assert.rejects(
      () => runInstall(directory, ['install', '--frozen-lockfile'], { timeoutMs: 1_000 }),
      /timed out/u,
    )
    assert.ok(existsSync(pidFile), 'the fake package manager should have started its descendant')
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    const deadline = Date.now() + 1_000
    while (isAlive(childPid) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(isAlive(childPid), false, 'preparation must not orphan pnpm descendants')
  } finally {
    if (previousExecutable === undefined) delete process.env.PNPM_EXECUTABLE
    else process.env.PNPM_EXECUTABLE = previousExecutable
    rmSync(directory, { recursive: true, force: true })
  }
})

test('SIGTERM lets test-environment preparation restore temporary metadata', { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-prepare-signal-test-'))
  const executable = join(directory, 'fake-pnpm.mjs')
  const driver = join(directory, 'driver.mjs')
  const pidFile = join(directory, 'child.pid')
  const workspace = join(directory, 'workspace')
  const workspaceFile = join(workspace, 'pnpm-workspace.yaml')
  const packagePath = join(workspace, 'package.json')
  const originalPackage = `${JSON.stringify({ name: 'signal-test', packageManager: 'pnpm@11.7.0' }, null, 2)}\n`
  const originalWorkspace = 'packages:\n- packages/*\n'
  let child
  try {
    mkdirSync(workspace, { recursive: true })
    writeFileSync(packagePath, originalPackage)
    writeFileSync(workspaceFile, originalWorkspace)
    writeFileSync(executable, `#!/usr/bin/env node\nimport { spawn } from 'node:child_process'\nimport { writeFileSync } from 'node:fs'\nconst child = spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)")}], { stdio: 'ignore' })\nwriteFileSync(process.env.DSH_FAKE_PID, String(child.pid))\nsetTimeout(() => {}, 60000)\n`)
    chmodSync(executable, 0o755)
    const helper = pathToFileURL(fileURLToPath(new URL('../scripts/prepare-dsh-test-environment.mjs', import.meta.url))).href
    writeFileSync(driver, `import { prepareDshTestEnvironment } from ${JSON.stringify(helper)}\ntry { await prepareDshTestEnvironment({ mode: 'npm', workspace: process.env.DSH_TEST_WORKSPACE, dshVersion: '0.1.2-alpha.1' }) } catch {}\n`)
    child = spawn(process.execPath, [driver], {
      env: { ...process.env, PNPM_EXECUTABLE: executable, DSH_TEST_WORKSPACE: workspace, DSH_FAKE_PID: pidFile },
      stdio: 'ignore',
    })
    const startedDeadline = Date.now() + 5_000
    while (!existsSync(pidFile) && Date.now() < startedDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.ok(existsSync(pidFile), 'the fake package manager should have started')
    process.kill(child.pid, 'SIGTERM')
    const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    assert.equal(result.code, 143)
    assert.equal(readFileSync(packagePath, 'utf8'), originalPackage)
    assert.equal(readFileSync(workspaceFile, 'utf8'), originalWorkspace)
    const childPid = Number(readFileSync(pidFile, 'utf8'))
    const cleanupDeadline = Date.now() + 1_000
    while (isAlive(childPid) && Date.now() < cleanupDeadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.equal(isAlive(childPid), false, 'signal cancellation must not orphan pnpm descendants')
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill('SIGKILL')
    rmSync(directory, { recursive: true, force: true })
  }
})
