/**
 * The direct-empty-retirement smoke's qualification assertions: the profile
 * user-patch layer must be EXACTLY the empty list (the check runs before the
 * first boot), and the DSH process status must be a clean zero — a vanished
 * tmux pane is not a successful exit.
 * @module @xmoon76/dsh-pi-tui/tooling/direct-empty-retirement-smoke.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertCleanDshExit,
  userPatchViolations,
} from '../../scripts/direct-empty-session-retirement-smoke.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

test('the fresh profile user patch layer is exactly the empty list', () => {
  assert.deepEqual(userPatchViolations('[]\n'), [])
  assert.deepEqual(userPatchViolations('# only comments\n\n[]\n'), [])
})

test("ANY row in the user patch layer is rejected, including the candidate's own config row", () => {
  // The check runs before the first boot, so a row here means something wrote a
  // user patch. Tolerating a "known" row would make the assertion weaker than
  // the claim it supports.
  const row = [
    '- id: tui-app',
    '  name: "@xmoon76/dsh-pi-tui"',
    '  config:',
    '    sessionId: ""',
  ].join('\n')
  assert.deepEqual(userPatchViolations(row), [
    '- id: tui-app',
    'name: "@xmoon76/dsh-pi-tui"',
    'config:',
    'sessionId: ""',
  ], 'a config row is not the expected empty layer')
})

test('insert / disabled / override / foreign / unknown rows are all rejected', () => {
  const forms = [
    '- insert:\n    - id: evil\n      name: evil-plugin',
    '- disabled: true',
    '- override:\n    id: tui-app',
    '- id: tui-app\n  override: everything',
    '- id: other-plugin\n  name: "other-plugin"',
    '- whatever:\n    id: tui-app',
  ]
  for (const form of forms) {
    assert.ok(userPatchViolations(form).length > 0, `must reject: ${JSON.stringify(form)}`)
  }
})

test('a clean DSH exit status of 0 passes', () => {
  assert.doesNotThrow(() => assertCleanDshExit('0', 'a'))
  assert.doesNotThrow(() => assertCleanDshExit('0\n', 'a'))
})

test('a controlled non-zero DSH exit status FAILS the smoke (a vanished pane is not success)', () => {
  // The controlled non-zero case the qualification requires: the assertion the
  // real launcher feeds must reject 7 instead of treating an ended session as
  // a pass.
  assert.throws(() => assertCleanDshExit('7', 'a'), /exited with status 7/u)
  assert.throws(() => assertCleanDshExit('1', 'a'), /exited with status 1/u)
})

test('a missing or malformed exit status fails closed (never a silent pass)', () => {
  for (const value of ['', '  ', 'signal', '-1', '0x0']) {
    assert.throws(() => assertCleanDshExit(value, 'a'), /was not recorded/u, `must fail closed on ${JSON.stringify(value)}`)
  }
})

test('the real launcher template RECORDS a controlled non-zero exit and the assertion rejects it', async (t) => {
  // End-to-end over the same shell plumbing the smoke uses: the launcher must
  // capture the TUI's status (no `set -e` shortcut) and the assertion must
  // reject it, so an abnormal DSH exit can never look like a clean one.
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { spawnSync } = await import('node:child_process')
  const { writeLauncher } = await import('../../scripts/direct-empty-session-retirement-smoke.mjs')
  const life = testLifecycle(t)
  const root = life.tempDir('smoke-launcher-exit-')
  const launcher = join(root, 'run-fault.sh')
  const exitCodeFile = join(root, 'run-fault.exit-code')
  const env = { HOME: join(root, 'home'), DSH_HOME: join(root, 'dsh-home') }
  writeLauncher(launcher, ['sh', '-c', 'exit 7'], env, exitCodeFile)
  const run = spawnSync('sh', [launcher], { encoding: 'utf8' })
  assert.equal(run.status, 7, 'the launcher must propagate the command status')
  assert.equal(readFileSync(exitCodeFile, 'utf8').trim(), '7',
    'the launcher must RECORD the real status for the smoke to assert on')
  assert.throws(() => assertCleanDshExit(readFileSync(exitCodeFile, 'utf8'), 'fault'), /exited with status 7/u)
})
