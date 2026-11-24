/**
 * The safety boundary of the selectable Host-default-environment case: a
 * pre-existing/foreign fixed drop-in is refused without a byte change, an
 * unknown kernel observation never counts as gone, and a definition this run
 * installed is stopped/restored/uninstalled only through the exact file it
 * recorded.
 *
 * This tests the extracted decisions the real selected lane consumes; it does
 * not drive a manager, Host or tool sequence.
 *
 * @module @xmoon76/dsh-pi-tui/test/tooling/host-default-environment-ownership
 */

import assert from 'node:assert/strict'
import { lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertRunAdmissionFiles,
  classifyHostExit,
  fileIdentity,
  finishOwnedDefinition,
  stopAdmittedDefinition,
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

test('captured Host exit never treats an unknown read as gone', () => {
  const linux = { platform: 'linux', pid: 42, startTicks: '100' }
  const schema2 = { schema: 2, hostPid: 42, hostKernelIdentity: linux }
  assert.equal(classifyHostExit(schema2, { kind: 'gone' }), true)
  assert.equal(classifyHostExit(schema2, { kind: 'unknown', code: 'NATIVE_UNAVAILABLE' }), false)
  assert.equal(classifyHostExit(schema2, { kind: 'alive', identity: linux }), false)
  assert.equal(classifyHostExit(schema2, { kind: 'alive', identity: { ...linux, startTicks: '101' } }), true)

  const schema1 = { schema: 1, hostPid: 42, hostStarttime: '100' }
  assert.equal(classifyHostExit(schema1, { kind: 'alive', identity: linux }), false)
  assert.equal(classifyHostExit(schema1, { kind: 'alive', identity: { ...linux, startTicks: '101' } }), true)
  assert.equal(classifyHostExit(schema1, { kind: 'unknown', code: 'NATIVE_UNAVAILABLE' }), false)
  assert.equal(classifyHostExit({ schema: 2, hostPid: 42 }, { kind: 'alive', identity: linux }), false)
  assert.equal(classifyHostExit({ schema: 1, hostPid: 42 }, { kind: 'alive', identity: linux }), false)
})

test('public stop is admitted only through an absent or unchanged run-owned definition', async t => {
  const root = testLifecycle(t).tempDir('dsh-pr1-stop-admission-')
  const unitPath = join(root, 'profile.service')
  const service = { kind: 'systemd', unitPath }
  let stops = 0
  const stop = () => {
    stops += 1
    return 'stopped'
  }

  writeFileSync(unitPath, 'foreign bytes')
  await assert.rejects(
    stopAdmittedDefinition(service, { original: undefined }, stop),
    /without proven run ownership/u,
  )
  assert.equal(stops, 0)

  writeFileSync(unitPath, 'original bytes')
  const ownership = { original: { bytes: Buffer.from('original bytes') }, current: fileIdentity(unitPath) }
  assert.equal(await stopAdmittedDefinition(service, ownership, stop), 'stopped')
  assert.equal(stops, 1)

  writeFileSync(unitPath, 'changed bytes')
  await assert.rejects(stopAdmittedDefinition(service, ownership, stop), /identity changed/u)
  assert.equal(stops, 1)

  unlinkSync(unitPath)
  assert.equal(await stopAdmittedDefinition(service, ownership, stop), 'stopped')
  assert.equal(stops, 2)
})

test('an unproven stop never restores or uninstalls an owned definition', () => {
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
