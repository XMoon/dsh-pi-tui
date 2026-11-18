import assert from 'node:assert/strict'
import test from 'node:test'

import { cleanupTrackedLaunchdResource, sameLaunchdIdentity } from '../../scripts/lib/launchd-smoke-cleanup.mjs'

const IDENTITY = { dev: '16777234', ino: '991', sha256: 'a'.repeat(64) }
const TRACKED = { label: 'com.xmoon.dsh-pi-tui.test', plistPath: '/Users/test/Library/LaunchAgents/com.xmoon.dsh-pi-tui.test.plist', identity: IDENTITY }

function harness(overrides = {}) {
  const calls = []
  const printResults = overrides.printResults ?? [{ status: 113, stdout: '' }]
  const identities = overrides.identities ?? [IDENTITY, IDENTITY]
  let prints = 0
  let reads = 0
  return {
    calls,
    io: {
      print: async label => {
        calls.push(['print', label])
        const result = printResults[Math.min(prints, printResults.length - 1)]
        prints += 1
        return result
      },
      bootout: async label => {
        calls.push(['bootout', label])
        return { status: overrides.bootoutStatus ?? 0 }
      },
      readIdentity: async path => {
        calls.push(['read', path])
        const result = identities[Math.min(reads, identities.length - 1)]
        reads += 1
        return result
      },
      realpath: async path => overrides.realpath ?? path,
      unlink: async path => { calls.push(['unlink', path]) },
      sleep: async () => {},
      maxWaitAttempts: 2,
      pollMs: 0,
    },
  }
}

test('sameLaunchdIdentity compares all three recorded fields and rejects missing records', () => {
  assert.equal(sameLaunchdIdentity(IDENTITY, { ...IDENTITY }), true)
  assert.equal(sameLaunchdIdentity(IDENTITY, { ...IDENTITY, ino: 'other' }), false)
  assert.equal(sameLaunchdIdentity(undefined, IDENTITY), false)
  assert.equal(sameLaunchdIdentity(IDENTITY, undefined), false)
})

test('an unloaded, identity-matching plist is removed', async () => {
  const { calls, io } = harness()
  const result = await cleanupTrackedLaunchdResource(TRACKED, io)
  assert.deepEqual(result, { action: 'removed' })
  assert.deepEqual(calls, [
    ['print', TRACKED.label],
    ['read', TRACKED.plistPath],
    ['read', TRACKED.plistPath],
    ['unlink', TRACKED.plistPath],
  ])
})

test('an already-absent unloaded resource is not an error', async () => {
  const { calls, io } = harness({ identities: [undefined] })
  const result = await cleanupTrackedLaunchdResource(TRACKED, io)
  assert.deepEqual(result, { action: 'absent' })
  assert.equal(calls.some(([verb]) => verb === 'unlink' || verb === 'bootout'), false)
})

test('a changed plist identity is preserved without bootout or unlink', async () => {
  const { calls, io } = harness({ identities: [{ ...IDENTITY, sha256: 'b'.repeat(64) }] })
  const result = await cleanupTrackedLaunchdResource(TRACKED, io)
  assert.equal(result.action, 'preserve')
  assert.match(result.reason, /identity differs/u)
  assert.equal(calls.some(([verb]) => verb === 'bootout' || verb === 'unlink'), false)
})

test('a loaded job from another source is preserved without bootout or unlink', async () => {
  const { calls, io } = harness({
    printResults: [{ status: 0, stdout: `\tpath = /elsewhere/${TRACKED.label}.plist\n` }],
  })
  const result = await cleanupTrackedLaunchdResource(TRACKED, io)
  assert.equal(result.action, 'preserve')
  assert.match(result.reason, /source is not the recorded plist/u)
  assert.equal(calls.some(([verb]) => verb === 'bootout' || verb === 'unlink'), false)
})

test('a loaded job with no current regular plist is preserved', async () => {
  const { calls, io } = harness({
    printResults: [{ status: 0, stdout: `\tpath = ${TRACKED.plistPath}\n` }],
    identities: [undefined],
  })
  const result = await cleanupTrackedLaunchdResource(TRACKED, io)
  assert.equal(result.action, 'preserve')
  assert.match(result.reason, /recorded plist is absent/u)
  assert.equal(calls.some(([verb]) => verb === 'bootout' || verb === 'unlink'), false)
})

test('a missing recorded identity is preserved', async () => {
  const { calls, io } = harness()
  const result = await cleanupTrackedLaunchdResource({ label: TRACKED.label, plistPath: TRACKED.plistPath }, io)
  assert.equal(result.action, 'preserve')
  assert.equal(calls.some(([verb]) => verb === 'bootout' || verb === 'unlink'), false)
})

test('a failed bootout preserves the job and plist', async () => {
  const { calls, io } = harness({
    printResults: [{ status: 0, stdout: `\tpath = ${TRACKED.plistPath}\n` }],
    bootoutStatus: 1,
  })
  const result = await cleanupTrackedLaunchdResource(TRACKED, io)
  assert.equal(result.action, 'preserve')
  assert.match(result.reason, /bootout exited 1/u)
  assert.equal(calls.some(([verb]) => verb === 'unlink'), false)
})

test('a bootout that never unloads preserves the plist', async () => {
  const { calls, io } = harness({
    printResults: [
      { status: 0, stdout: `\tpath = ${TRACKED.plistPath}\n` },
      { status: 0, stdout: `\tpath = ${TRACKED.plistPath}\n` },
      { status: 0, stdout: `\tpath = ${TRACKED.plistPath}\n` },
    ],
  })
  const result = await cleanupTrackedLaunchdResource(TRACKED, io)
  assert.equal(result.action, 'preserve')
  assert.match(result.reason, /did not leave the domain/u)
  assert.equal(calls.some(([verb]) => verb === 'unlink'), false)
})

test('a bootout that unloads the verified job removes the identity-checked plist', async () => {
  const { calls, io } = harness({
    printResults: [
      { status: 0, stdout: `\tpath = ${TRACKED.plistPath}\n` },
      { status: 113, stdout: '' },
    ],
  })
  const result = await cleanupTrackedLaunchdResource(TRACKED, io)
  assert.deepEqual(result, { action: 'removed' })
  assert.deepEqual(calls.filter(([verb]) => verb === 'bootout' || verb === 'unlink'), [
    ['bootout', TRACKED.label],
    ['unlink', TRACKED.plistPath],
  ])
})

test('a plist identity that changes again before unlink is preserved', async () => {
  const { calls, io } = harness({ identities: [IDENTITY, { ...IDENTITY, ino: '992' }] })
  const result = await cleanupTrackedLaunchdResource(TRACKED, io)
  assert.equal(result.action, 'preserve')
  assert.match(result.reason, /changed again before removal/u)
  assert.equal(calls.some(([verb]) => verb === 'unlink'), false)
})

test('a manager query error preserves the resource without bootout or unlink', async () => {
  const { calls, io } = harness({ printResults: [{ status: 112, stdout: '' }] })
  const result = await cleanupTrackedLaunchdResource(TRACKED, io)
  assert.equal(result.action, 'preserve')
  assert.match(result.reason, /manager query exited 112/u)
  assert.equal(calls.some(([verb]) => verb === 'bootout' || verb === 'unlink'), false)
})
