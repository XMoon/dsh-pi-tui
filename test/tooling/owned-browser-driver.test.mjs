/**
 * The detached Browser driver owner must reap its process group on EVERY exit
 * path. The negative control makes the driver exceed its bound and proves the
 * kill + bounded wait actually removes the process instead of only reporting a
 * timeout (the failure path RFL-005 found in the product lane).
 *
 * @module @xmoon76/dsh-pi-tui/owned-browser-driver.test
 */

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { runOwnedDetachedDriver } from '../../scripts/lib/owned-browser-driver.mjs'
import { browserDriverExitBounded } from '../../scripts/smoke/split-process/web-helpers.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

/** Create one private fixture root through the repository's owned lifecycle. */
function fixtureRoot(t) {
  return testLifecycle(t).tempDir('owned-driver-')
}

test('a driver that exceeds its bound is killed, reaped and never leaks its group', async (t) => {
  const root = fixtureRoot(t)
  const script = join(root, 'hang.mjs')
  writeFileSync(script, [
    "process.on('SIGTERM', () => {})",
    'setInterval(() => {}, 1000)',
    '',
  ].join('\n'))
  const run = await runOwnedDetachedDriver({
    command: process.execPath,
    args: [script],
    options: { stdio: 'ignore' },
    timeoutMs: 300,
    cleanupMs: 5_000,
    bounded: browserDriverExitBounded,
    tag: 'TEST_OWNED_DRIVER',
  })
  assert.equal(run.finished.signal, 'EXIT_TIMEOUT', 'the bound must report a real timeout')
  assert.throws(() => process.kill(run.child.pid, 0), /ESRCH/u,
    'the timed-out driver process must be gone after the owner returns')
})

test('a normally exiting driver is not killed and keeps its real exit status', async (t) => {
  const root = fixtureRoot(t)
  const script = join(root, 'exit.mjs')
  writeFileSync(script, 'process.exit(0)\n')
  const run = await runOwnedDetachedDriver({
    command: process.execPath,
    args: [script],
    options: { stdio: 'ignore' },
    timeoutMs: 30_000,
    cleanupMs: 5_000,
    bounded: browserDriverExitBounded,
    tag: 'TEST_OWNED_DRIVER_OK',
  })
  assert.equal(run.finished.code, 0)
  assert.equal(run.finished.signal, null)
})
