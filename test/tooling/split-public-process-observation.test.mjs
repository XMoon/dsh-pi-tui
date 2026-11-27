/**
 * Low-level regression for the public-process observation seam.
 *
 * This file protects the deterministic parts: strict argv/env framing,
 * tri-state admission and exact path presence. It does NOT claim any OS
 * qualification; the real ABI/ctty/parent-edge proof lives in the opt-in
 * authority control that drives the real Supervisor.
 */

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { testLifecycle } from '../support/temp-lifecycle.ts'

import {
  admitPublicObservation,
  parseDarwinProcargs,
  parseDarwinProcargsArgv,
  parseLinuxCommandLine,
  parseLinuxEnvironment,
  publicAdmissionDisposition,
  publicCaptureDisposition,
  decodePidSlots,
  publicPathPresence,
} from '../support/split-public-process-observation.mjs'

function procargs({ argc, execPath = '/usr/bin/node', argv = [], env = [], apple = [], pad = 0, trailing = Buffer.alloc(0) }) {
  const parts = [Buffer.from(execPath), Buffer.alloc(1)]
  parts.push(Buffer.alloc(pad))
  for (const value of argv.slice(0, argc)) {
    parts.push(Buffer.from(value), Buffer.alloc(1))
  }
  for (const value of env) parts.push(Buffer.from(value), Buffer.alloc(1))
  parts.push(Buffer.alloc(16))
  if (apple.length > 0) {
    parts.push(Buffer.alloc(1))
    for (const value of apple) parts.push(Buffer.from(value), Buffer.alloc(1))
  }
  parts.push(trailing)
  const body = Buffer.concat(parts)
  const header = Buffer.alloc(4)
  header.writeInt32LE(argc, 0)
  const buffer = Buffer.concat([header, body])
  return { buffer, used: buffer.length }
}

test('Darwin procargs preserves interior empty argv entries and exact environment values', () => {
  const { buffer, used } = procargs({
    argc: 3,
    argv: ['node', '', '--profile=pi-tui'],
    env: ['DSH_HOME=/tmp/home', 'P1D_EMPTY=', 'P1D_SPACE=a b c', 'P1D_ASSIGN=x=y=z'],
  })
  const parsed = parseDarwinProcargs(buffer, used)
  assert.equal(parsed.kind, 'ok')
  assert.deepEqual(parsed.argv, ['node', '', '--profile=pi-tui'])
  assert.equal(parsed.envMap.get('P1D_EMPTY'), '')
  assert.equal(parsed.envMap.get('P1D_SPACE'), 'a b c')
  assert.equal(parsed.envMap.get('P1D_ASSIGN'), 'x=y=z')
})

test('Darwin argv-only decoding respects the actual copied length boundary', () => {
  const { buffer, used } = procargs({ argc: 2, argv: ['node', 'child'] })
  const capacity = Buffer.concat([buffer, Buffer.from('\0outside-used\0')])
  const complete = parseDarwinProcargsArgv(capacity, used)
  assert.equal(complete.kind, 'ok')
  assert.deepEqual(complete.argv, ['node', 'child'])

  // The capacity still contains the final argv NUL, but used ends inside the
  // final argument. Bytes outside [0, used) must never complete argv.
  const cut = buffer.indexOf(Buffer.from('child')) + Buffer.byteLength('child')
  const truncated = parseDarwinProcargsArgv(capacity, cut)
  assert.equal(truncated.kind, 'unknown')
  assert.equal(truncated.code, 'ARGV_FRAMING')
})

test('Darwin procargs records the real env section bytes and a real apple tail', () => {
  const { buffer, used } = procargs({
    argc: 2,
    argv: ['node', 'child'],
    env: ['A=1', 'B=two'],
    apple: ['ptr_munge=0x1', 'main_stack=0x2'],
  })
  const parsed = parseDarwinProcargs(buffer, used)
  assert.equal(parsed.kind, 'ok')
  assert.equal(parsed.envEntries.length, 2)
  assert.ok(parsed.envSectionBytes > 0)
  assert.deepEqual(parsed.appleKeys, ['ptr_munge', 'main_stack'])
  assert.ok(parsed.appleSectionBytes > 0)
})

test('Darwin procargs still rejects a duplicate env key before the apple tail', () => {
  const { buffer, used } = procargs({
    argc: 2,
    argv: ['node', 'child'],
    env: ['FOO=one', 'FOO=two'],
    apple: ['ptr_munge=0x1'],
  })
  assert.equal(parseDarwinProcargs(buffer, used).code, 'DUPLICATE_ENV_KEY')
})

test('Darwin procargs treats apple strings after an empty env as non-env', () => {
  const { buffer, used } = procargs({
    argc: 2,
    argv: ['node', 'child'],
    env: [],
    apple: ['ptr_munge=0x1', 'main_stack=0x2'],
  })
  const parsed = parseDarwinProcargs(buffer, used)
  assert.equal(parsed.kind, 'ok')
  assert.equal(parsed.envPresent, false)
  assert.deepEqual(parsed.envEntries, [])
  assert.deepEqual(parsed.appleKeys, ['ptr_munge', 'main_stack'])
})

test('Darwin procargs rejects duplicate keys, malformed entries and trailing garbage after padding', () => {
  const duplicate = procargs({ argc: 2, argv: ['node', 'child'], env: ['FOO=1', 'FOO=2'] })
  assert.equal(parseDarwinProcargs(duplicate.buffer, duplicate.used).kind, 'unknown')
  assert.equal(parseDarwinProcargs(duplicate.buffer, duplicate.used).code, 'DUPLICATE_ENV_KEY')

  const malformed = procargs({ argc: 2, argv: ['node', 'child'], env: ['NOEQUALS'] })
  assert.equal(parseDarwinProcargs(malformed.buffer, malformed.used).code, 'MALFORMED_ENV_ITEM')

  const garbage = procargs({ argc: 2, argv: ['node', 'child'], env: ['A=1'], trailing: Buffer.from('X') })
  assert.equal(parseDarwinProcargs(garbage.buffer, garbage.used).code, 'ENV_FRAMING')
})

test('Darwin procargs rejects truncated argv and invalid UTF-8', () => {
  const header = Buffer.alloc(4)
  header.writeInt32LE(2, 0)
  const truncated = Buffer.concat([header, Buffer.from('node\0'), Buffer.alloc(1), Buffer.from('child')])
  assert.equal(parseDarwinProcargs(truncated, truncated.length).code, 'ARGV_FRAMING')

  const invalid = procargs({ argc: 2, argv: ['node', 'child'], env: ['BAD=AB'] })
  invalid.buffer[invalid.buffer.indexOf(Buffer.from('BAD=AB')) + 4] = 0xff
  assert.equal(parseDarwinProcargs(invalid.buffer, invalid.used).code, 'INVALID_UTF8')
})

test('Linux cmdline preserves empty interior arguments and requires a trailing NUL', () => {
  const parsed = parseLinuxCommandLine(Buffer.from('node\0\0--profile=pi-tui\0'))
  assert.equal(parsed.kind, 'ok')
  assert.deepEqual(parsed.argv, ['node', '', '--profile=pi-tui'])
  assert.equal(parseLinuxCommandLine(Buffer.from('node\0child')).code, 'ARGV_FRAMING')
  assert.equal(parseLinuxCommandLine(Buffer.from('\0child\0')).code, 'ARGV_FRAMING')
})

test('Linux environment keeps exact values and rejects duplicate/malformed/empty keys', () => {
  const parsed = parseLinuxEnvironment(Buffer.from('A=1\0B=\0C=a b\0D=x=y\0'))
  assert.equal(parsed.kind, 'ok')
  assert.equal(parsed.envMap.get('B'), '')
  assert.equal(parsed.envMap.get('C'), 'a b')
  assert.equal(parsed.envMap.get('D'), 'x=y')
  assert.equal(parseLinuxEnvironment(Buffer.from('A=1\0A=2\0')).code, 'DUPLICATE_ENV_KEY')
  assert.equal(parseLinuxEnvironment(Buffer.from('NOEQUALS\0')).code, 'MALFORMED_ENV_ITEM')
  assert.equal(parseLinuxEnvironment(Buffer.from('=value\0')).code, 'MALFORMED_ENV_ITEM')
})

test('path presence is absent only for a real ENOENT and unknown for an unreadable component', (t) => {
  const root = testLifecycle(t).tempDir('public-observation-path-')
  assert.equal(publicPathPresence(join(root, 'missing')), 'absent')
  const present = join(root, 'present.json')
  writeFileSync(present, '{}', { mode: 0o600 })
  assert.equal(publicPathPresence(present), 'present')
  const locked = join(root, 'locked')
  mkdirSync(locked, { mode: 0o700 })
  writeFileSync(join(locked, 'child'), '{}', { mode: 0o600 })
  chmodSync(locked, 0o000)
  assert.throws(() => publicPathPresence(join(locked, 'child')), error => error.code === 'PATH_UNKNOWN')
  chmodSync(locked, 0o700)
})

const REAL_ENTRY = fileURLToPath(import.meta.url)
const OTHER_ENTRY = process.execPath

function observation(overrides = {}) {
  return {
    kind: 'alive',
    pid: 4321,
    birth: 'birth-a',
    ppid: 4320,
    pgid: 4321,
    sid: 4321,
    uid: 501,
    argv: [process.execPath, REAL_ENTRY],
    envMap: new Map([
      ['DSH_HOME', '/tmp/dsh-home'],
      ['SPLIT_PROCESS_PROFILE', 'pi-tui'],
      ['SPLIT_PROCESS_DSH_ANCHOR', '/tmp/anchor'],
    ]),
    envPresent: true,
    tty: {
      platform: 'linux',
      ttyNr: 0,
      fd0: '/dev/null',
      fd0Readable: true,
      hasControllingTty: false,
      noControllingTty: true,
      fd0IsPts: false,
    },
    parentEdge: { proven: true, parentPid: 4320, parentBirth: 'parent-birth' },
    ...overrides,
  }
}

const expected = {
  birth: 'birth-a',
  entry: REAL_ENTRY,
  home: '/tmp/dsh-home',
  profile: 'pi-tui',
  anchor: '/tmp/anchor',
  uid: 501,
  parentPid: 4320,
  parentBirth: 'parent-birth',
  tty: { kind: 'detached' },
  groupLeader: true,
}

test('admission accepts one exact same-live detached public entry', () => {
  const result = admitPublicObservation(observation(), expected)
  assert.equal(result.admitted, true)
  assert.equal(result.reason, 'admitted')
})

test('admission refuses wrong birth, entry, home, profile, anchor and uid', () => {
  assert.equal(admitPublicObservation(observation({ birth: 'birth-b' }), expected).reason, 'birth-mismatch')
  assert.equal(admitPublicObservation(observation({ argv: [process.execPath, OTHER_ENTRY] }), expected).reason, 'canonical-entry-mismatch')
  assert.equal(admitPublicObservation(observation({
    envMap: new Map(expected.envMap ?? []).set('DSH_HOME', '/tmp/other'),
  }), expected).reason, 'dsh-home-mismatch')
  assert.equal(admitPublicObservation(observation({
    envMap: new Map([['DSH_HOME', '/tmp/dsh-home'], ['SPLIT_PROCESS_DSH_ANCHOR', '/tmp/anchor']]),
  }), expected).reason, 'env-missing')
  assert.equal(admitPublicObservation(observation({ uid: 0 }), expected).reason, 'uid-mismatch')
})

test('admission refuses gone, unknown, unproven parent edge and a foreground tty mismatch', () => {
  assert.equal(admitPublicObservation({ kind: 'gone' }, expected).reason, 'observation-gone')
  assert.equal(admitPublicObservation({ kind: 'unknown', code: 'ACCESS_DENIED' }, expected).reason, 'observation-unknown')
  assert.equal(admitPublicObservation(observation({ parentEdge: { proven: false, reason: 'ppid-mismatch' } }), expected).reason, 'parent-edge-unproven')
  assert.equal(admitPublicObservation(observation({
    tty: {
      platform: 'darwin', eTdev: 268435474, hasControllingTty: true, noControllingTty: false,
    },
    parentEdge: { proven: true, parentPid: 4320, parentBirth: 'parent-birth' },
  }), expected).reason, 'tty-mismatch')
})


test('only a positive admission mismatch may exclude a candidate', () => {
  assert.equal(publicAdmissionDisposition({ admitted: true, reason: 'admitted' }), 'admitted')
  assert.equal(publicAdmissionDisposition({ admitted: false, reason: 'tty-mismatch' }), 'not-target')
  assert.equal(publicAdmissionDisposition({ admitted: false, reason: 'canonical-entry-mismatch' }), 'not-target')
  assert.equal(publicAdmissionDisposition({ admitted: false, reason: 'tty-unproven' }), 'unknown')
  assert.equal(publicAdmissionDisposition({ admitted: false, reason: 'parent-edge-unproven' }), 'unknown')
  assert.equal(publicAdmissionDisposition({ admitted: false, reason: 'parent-edge-unproven', definitive: true }), 'not-target')
  assert.equal(publicAdmissionDisposition({ admitted: false, reason: 'canonical-entry-unreadable' }), 'unknown')
  assert.equal(publicAdmissionDisposition({ admitted: false, reason: 'observation-unknown' }), 'unknown')
})


test('capture rejects a torn birth and an unproven admission as unknown', () => {
  const light = { kind: 'alive', pid: 7, birth: 'linux:100' }
  const full = { kind: 'alive', pid: 7, birth: 'linux:100' }
  assert.equal(publicCaptureDisposition(light, full, { admitted: true, reason: 'admitted' }), 'captured')
  assert.equal(publicCaptureDisposition(light, { ...full, birth: 'linux:101' }, { admitted: true, reason: 'admitted' }), 'unknown')
  assert.equal(publicCaptureDisposition(light, full, { admitted: false, reason: 'tty-unproven' }), 'unknown')
  assert.equal(publicCaptureDisposition(light, full, { admitted: false, reason: 'tty-mismatch' }), 'not-target')
  assert.equal(publicCaptureDisposition(light, { kind: 'unknown', code: 'TORN_OBSERVATION' }, { admitted: false, reason: 'tty-unproven' }), 'unknown')
})


test('PID slot framing keeps empty holes distinct from malformed entries', () => {
  assert.deepEqual(decodePidSlots([1, 0, 2]), { kind: 'ok', pids: [1, 2], emptySlots: 1 })
  assert.equal(decodePidSlots([1, -1]).code, 'ENUMERATION_FRAMING')
  assert.equal(decodePidSlots([0, 0]).pids.length, 0)
  assert.equal(decodePidSlots([1, 0, 2]).emptySlots, 1)
})
