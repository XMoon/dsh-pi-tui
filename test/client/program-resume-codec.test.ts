import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  encodeProgramResumeClear,
  encodeProgramResumeReport,
  PROGRAM_RESUME_MAX_WIRE_BYTES,
} from '../../src/client/program-resume/codec.ts'

const TOKEN = 'dummy-token-replace-me'
const PID = 74877
const TIME = 1795543200
const ESC = '\u001B]7577;'
const ST = '\u001B\\'

function frameParts(frame: string): { body: string; mac: string } {
  const match = /^\u001B\]7577;(.*):mac=([0-9a-f]{64})\u001B\\$/u.exec(frame)
  assert.ok(match, 'the frame must have the exact OSC 7577 shape')
  return { body: match[1] as string, mac: match[2] as string }
}

function decodeArg(value: string): string {
  return Buffer.from(value, 'base64').toString('utf8')
}

test('the official Neovim report vector is byte-exact', () => {
  const frame = encodeProgramResumeReport({
    token: TOKEN,
    pid: PID,
    time: TIME,
    argv: ['nvim', '-S', '/home/user/.local/state/nvim/sessions/8f2c1d.vim'],
  })
  assert.equal(
    frame,
    `${ESC}pid=74877:time=1795543200:argv=bnZpbQ==,LVM=,L2hvbWUvdXNlci8ubG9jYWwvc3RhdGUvbnZpbS9zZXNzaW9ucy84ZjJjMWQudmlt:mac=9dbb99bfb856749a87563839d7ce9062818d78cf25909db93f309e0cd3b1909b${ST}`,
  )
})

test('the official clear vector is byte-exact', () => {
  const frame = encodeProgramResumeClear({ token: TOKEN, pid: PID, time: TIME })
  assert.equal(
    frame,
    `${ESC}pid=74877:time=1795543200:clear=1:mac=c30603369f98fef581a4098be889175b0c74f0641e49f8b25f4326cb38f97c93${ST}`,
  )
})

test('the official lazygit cwd vector is byte-exact', () => {
  const frame = encodeProgramResumeReport({
    token: TOKEN,
    pid: PID,
    time: TIME,
    argv: ['lazygit'],
    cwd: '/home/user/src/project',
  })
  assert.equal(
    frame,
    `${ESC}pid=74877:time=1795543200:argv=bGF6eWdpdA==:cwd=L2hvbWUvdXNlci9zcmMvcHJvamVjdA==:mac=35cb909805c380336efd3689a125acc774a9dec8422a1d21492ebec06ca758e1${ST}`,
  )
})

test('the MAC is a plain SHA-256 over body:token and argv/cwd decode independently', () => {
  const frame = encodeProgramResumeReport({
    token: TOKEN,
    pid: 1234,
    time: 1700000000,
    argv: ['/usr/bin/env', 'A=1', 'a b', 'café', ''],
    cwd: '/tmp/work dir',
  })
  const { body, mac } = frameParts(frame)
  assert.equal(mac, createHash('sha256').update(`${body}:${TOKEN}`).digest('hex'))
  const pairs = body.split(':')
  assert.deepEqual(pairs.map(pair => pair.slice(0, pair.indexOf('='))), ['pid', 'time', 'argv', 'cwd'])
  assert.equal(pairs[0], 'pid=1234')
  assert.equal(pairs[1], 'time=1700000000')
  const argv = pairs[2].slice('argv='.length).split(',')
  assert.deepEqual(argv.map(decodeArg), ['/usr/bin/env', 'A=1', 'a b', 'café', ''])
  assert.equal(decodeArg(pairs[3].slice('cwd='.length)), '/tmp/work dir')
  assert.ok(Buffer.byteLength(frame, 'utf8') <= PROGRAM_RESUME_MAX_WIRE_BYTES)
})

test('the complete frame fits exactly up to the 2048-byte product budget and fails closed beyond it', () => {
  let longest = 0
  for (let length = 1; length <= 3000; length += 1) {
    try {
      encodeProgramResumeReport({
        token: TOKEN,
        pid: PID,
        time: TIME,
        argv: ['x', 'y'.repeat(length)],
        cwd: '/',
      })
      longest = length
    } catch (error) {
      assert.match(String(error), /2048/u)
      break
    }
  }
  assert.ok(longest > 1000, `the probe must reach the real boundary, got ${String(longest)}`)
  assert.throws(() => encodeProgramResumeReport({
    token: TOKEN,
    pid: PID,
    time: TIME,
    argv: ['x', 'y'.repeat(longest + 1)],
    cwd: '/',
  }), /exceeds 2048 bytes/u)
})

test('invalid tokens, pids, times, arguments and cwd are rejected', () => {
  const base = { token: TOKEN, pid: PID, time: TIME, argv: ['ok'], cwd: '/' }
  assert.throws(() => encodeProgramResumeReport({ ...base, token: 'short' }), /token/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, token: `${'a'.repeat(65)}` }), /token/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, pid: 0 }), /pid/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, pid: 1.5 }), /pid/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, time: -1 }), /time/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, time: Number.MAX_SAFE_INTEGER + 1 }), /time/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, argv: [] }), /1\.\.64/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, argv: ['-x'] }), /argv\[0\]/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, argv: ['bin/tool'] }), /relative/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, argv: ['ok', 'line\nbreak'] }), /control/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, argv: ['ok', '\uD800'] }), /Unicode/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, cwd: 'relative' }), /cwd must be absolute/u)
  assert.throws(() => encodeProgramResumeReport({ ...base, argv: Array.from({ length: 65 }, () => 'x') }), /1\.\.64/u)
})

test('an empty non-first argument is legal and a bare argv0 is legal', () => {
  const frame = encodeProgramResumeReport({
    token: TOKEN,
    pid: 1,
    time: 1,
    argv: ['lazygit', '', 'tail'],
  })
  const { body } = frameParts(frame)
  assert.match(body, /argv=bGF6eWdpdA==,,dGFpbA==/u)
})
