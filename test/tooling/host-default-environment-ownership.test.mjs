/**
 * The safety boundary of the selectable Host-default-environment case: a
 * pre-existing/foreign fixed drop-in is refused without a byte change, and a
 * definition this run installed is restored/uninstalled only after a positive
 * Host-stop proof.
 *
 * This tests the TWO extracted decisions the real selected lane consumes; it
 * does not drive a manager, Host or tool sequence.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/host-default-environment-ownership
 */

import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertRunAdmissionFiles,
  finishOwnedDefinition,
} from '../../scripts/smoke/split-process/host-default-environment.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

test('admission refuses a pre-existing fixed drop-in without changing its bytes', t => {
  const root = testLifecycle(t).tempDir('dsh-pr1-admission-')
  const dropInDir = join(root, 'service.d')
  mkdirSync(dropInDir)
  const dropInPath = join(dropInDir, '50-pr1-host-environment.conf')
  writeFileSync(dropInPath, 'FOREIGN BYTES\n', { mode: 0o600 })
  const service = { kind: 'systemd', dropInDir, dropInPath }
  assert.throws(() => assertRunAdmissionFiles(service), /pre-existing test drop-in/u)
  assert.equal(readFileSync(dropInPath, 'utf8'), 'FOREIGN BYTES\n')
  assert.doesNotThrow(() => assertRunAdmissionFiles({ kind: 'launchd' }))
})

test('admission refuses a dangling drop-in link and a non-empty drop-in directory', t => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-pr1-admission-link-')
  mkdirSync(join(root, 'service.d'))
  const dropInPath = join(root, 'service.d', '50-pr1-host-environment.conf')
  symlinkSync(join(root, 'missing-target'), dropInPath)
  assert.throws(
    () => assertRunAdmissionFiles({ kind: 'systemd', dropInDir: join(root, 'service.d'), dropInPath }),
    /pre-existing test drop-in/u,
  )
  assert.equal(lstatSync(dropInPath).isSymbolicLink(), true)

  const foreignRoot = life.tempDir('dsh-pr1-admission-dir-')
  mkdirSync(join(foreignRoot, 'service.d'))
  writeFileSync(join(foreignRoot, 'service.d', 'foreign.conf'), '[Service]\n')
  assert.throws(
    () => assertRunAdmissionFiles({ kind: 'systemd', dropInDir: join(foreignRoot, 'service.d'), dropInPath: join(foreignRoot, 'service.d', '50-pr1-host-environment.conf') }),
    /foreign files/u,
  )
  assert.equal(readFileSync(join(foreignRoot, 'service.d', 'foreign.conf'), 'utf8'), '[Service]\n')
})

test('admission accepts an empty drop-in directory', t => {
  const root = testLifecycle(t).tempDir('dsh-pr1-admission-empty-')
  mkdirSync(join(root, 'service.d'))
  assert.doesNotThrow(() => assertRunAdmissionFiles({
    kind: 'systemd',
    dropInDir: join(root, 'service.d'),
    dropInPath: join(root, 'service.d', '50-pr1-host-environment.conf'),
  }))
})

test('an owned definition is never restored or uninstalled without a positive stop proof', () => {
  const calls = []
  const ownership = { original: { bytes: Buffer.from('original') }, current: {}, dropIn: undefined }
  const actions = {
    assertCurrentIdentity: () => calls.push('assert'),
    restore: () => calls.push('restore'),
    uninstall: () => calls.push('uninstall'),
    assertAbsent: () => calls.push('absent'),
  }
  assert.deepEqual(finishOwnedDefinition(false, ownership, actions), {
    action: 'preserved',
    reason: 'the owned service definition was preserved because the Host stop was not proven',
  })
  assert.deepEqual(calls, [], 'an unproven stop must not mutate the definition')
  assert.deepEqual(finishOwnedDefinition(false, { original: undefined }, actions), { action: 'not-applicable' })
  assert.deepEqual(calls, [])
})

test('a confirmed stop restores, uninstalls and verifies absence in order', () => {
  const calls = []
  const ownership = { original: { bytes: Buffer.from('original') }, current: {}, dropIn: undefined }
  assert.deepEqual(finishOwnedDefinition(true, ownership, {
    assertCurrentIdentity: () => calls.push('assert'),
    restore: () => calls.push('restore'),
    uninstall: () => calls.push('uninstall'),
    assertAbsent: () => calls.push('absent'),
  }), { action: 'removed' })
  assert.deepEqual(calls, ['assert', 'restore', 'uninstall', 'absent'])
})

test('a changed definition identity stops the finish before any mutation', () => {
  const calls = []
  assert.throws(() => finishOwnedDefinition(true, { original: { bytes: Buffer.from('original') } }, {
    assertCurrentIdentity: () => { throw new Error('identity changed') },
    restore: () => calls.push('restore'),
    uninstall: () => calls.push('uninstall'),
    assertAbsent: () => calls.push('absent'),
  }), /identity changed/u)
  assert.deepEqual(calls, [])
})
