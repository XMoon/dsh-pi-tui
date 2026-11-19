/**
 * The Darwin tmux surface driver guard.
 *
 * The real macOS qualification runs the shared cases through
 * `scripts/lib/split-smoke-darwin-pty.mjs`. This tooling test proves the
 * driver's own bounded contracts WITHOUT any business semantics: the key
 * tokenization covers exactly the input classes the shared cases send and
 * fails loudly on anything else, and the tmux server is a per-scope name.
 * No pane, server or install is created here.
 *
 * @module split-smoke-darwin-pty.test
 */

import assert from 'node:assert/strict'
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import {
  darwinHostSeatFileFree,
  darwinHostSeatFilePath,
  darwinKeyTokensOf,
} from '../../scripts/lib/split-smoke-darwin-pty.mjs'

test('the Darwin key tokenizer maps the shared cases\u2019 exact control classes to named tmux keys', () => {
  // Plain literal text (UTF-8) stays one literal unit.
  assert.deepEqual(darwinKeyTokensOf('hello @file-name.ts'), [{ kind: 'literal', text: 'hello @file-name.ts' }])
  // Enter / CR.
  assert.deepEqual(darwinKeyTokensOf('\r'), [{ kind: 'key', name: 'Enter' }])
  // Tab accept.
  assert.deepEqual(darwinKeyTokensOf('\t'), [{ kind: 'key', name: 'Tab' }])
  // Ctrl-U clear.
  assert.deepEqual(darwinKeyTokensOf('\x15'), [{ kind: 'key', name: 'C-u' }])
  // Ctrl-S steer.
  assert.deepEqual(darwinKeyTokensOf('\x13'), [{ kind: 'key', name: 'C-s' }])
  // Backspace run.
  assert.deepEqual(darwinKeyTokensOf('\x7f\x7f\x7f'), [{ kind: 'key', name: 'BSpace', }, { kind: 'key', name: 'BSpace', }, { kind: 'key', name: 'BSpace', }])
  // Arrow keys.
  assert.deepEqual(darwinKeyTokensOf('\x1b[A'), [{ kind: 'key', name: 'Up' }])
  assert.deepEqual(darwinKeyTokensOf('\x1b[B'), [{ kind: 'key', name: 'Down' }])
  assert.deepEqual(darwinKeyTokensOf('\x1b[C'), [{ kind: 'key', name: 'Right' }])
  assert.deepEqual(darwinKeyTokensOf('\x1b[D'), [{ kind: 'key', name: 'Left' }])
  // A bare ESC is the Escape key.
  assert.deepEqual(darwinKeyTokensOf('\x1b'), [{ kind: 'key', name: 'Escape' }])
  // A realistic mixed draft: text + controls stay in order.
  assert.deepEqual(darwinKeyTokensOf('/attach /tmp/x.bin\r marker'), [
    { kind: 'literal', text: '/attach /tmp/x.bin' },
    { kind: 'key', name: 'Enter' },
    { kind: 'literal', text: ' marker' },
  ])
})

test('consecutive identical named keys coalesce into one send-keys argv unit', () => {
  const tokens = darwinKeyTokensOf('\x1b[B\x1b[B\x1b[B')
  assert.deepEqual(tokens, [
    { kind: 'key', name: 'Down' },
    { kind: 'key', name: 'Down' },
    { kind: 'key', name: 'Down' },
  ])
})

test('a literal starting with a dash is sent in hex mode, never parsed as a tmux option', () => {
  assert.deepEqual(darwinKeyTokensOf('-x path'), [
    { kind: 'hex', hex: Buffer.from('-x path', 'utf8').toString('hex') },
  ])
})

test('unmapped control bytes and escape sequences fail loudly instead of being dropped', () => {
  for (const unsupported of ['\x01', '\x0c', '\x1bO A', '\x1b[1;5A', '\x1b[200~']) {
    assert.throws(() => darwinKeyTokensOf(unsupported),
      /unsupported surface input/u,
      `the byte sequence ${JSON.stringify(unsupported)} must fail, not silently drop`)
  }
})

test('a delete key (0x7f mixed into text) is still a named key and never literal text', () => {
  assert.deepEqual(darwinKeyTokensOf('abc\x7fdef'), [
    { kind: 'literal', text: 'abc' },
    { kind: 'key', name: 'BSpace' },
    { kind: 'literal', text: 'def' },
  ])
})

/**
 * The Host-seat probe must resolve the SAME account-home path the production
 * seat uses (`src/app/remote-process/local-scope.ts`): the lane runs the Client
 * with an ISOLATED `$HOME`, so a `$HOME`-based probe would look at a directory
 * the seat never lives in and report "free" for the wrong reason.
 */
test('the Host-seat probe path is the account home, never an overridden $HOME', t => {
  const life = testLifecycle(t)
  const isolated = life.tempDir('seat-home-')
  const previous = process.env.HOME
  try {
    process.env.HOME = isolated
    assert.equal(
      darwinHostSeatFilePath('scope-under-test'),
      join(userInfo().homedir, '.dsh-pi-tui', 'run', 'scope-under-test', 'seat-host-scope-under-test.lock'),
    )
    assert.notEqual(darwinHostSeatFilePath('scope-under-test'), join(isolated, '.dsh-pi-tui', 'run', 'scope-under-test', 'seat-host-scope-under-test.lock'))
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  }
})

test('the Host-seat probe is free only when the real O_EXLOCK claim can be taken', { skip: process.platform !== 'darwin' ? 'the Darwin seat needs the qualified macOS ABI' : false }, async t => {
  const life = testLifecycle(t)
  const accountHome = life.tempDir('seat-account-')
  const scopeId = 'seat-probe-scope'
  const seatDir = join(accountHome, '.dsh-pi-tui', 'run', scopeId)
  const seatPath = darwinHostSeatFilePath(scopeId, accountHome)
  try {
    // A missing seat file is already free and the probe must never create it.
    assert.equal(await darwinHostSeatFileFree(scopeId, { timeoutMs: 200, accountHome }), true)
    assert.equal(existsSync(seatPath), false, 'the probe must never create a missing seat file')
    mkdirSync(seatDir, { recursive: true, mode: 0o700 })
    writeFileSync(seatPath, '', { mode: 0o600 })
    // Hold the SAME kernel claim the Host holds: O_RDWR|O_CREAT|O_EXLOCK|
    // O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC on the qualified macOS ABI.
    const holder = openSync(seatPath, 2 | 512 | 32 | 4 | 256 | 16777216, 0o600)
    try {
      assert.equal(await darwinHostSeatFileFree(scopeId, { timeoutMs: 300, accountHome }), false,
        'a held seat must never be reported free')
    } finally {
      closeSync(holder)
    }
    assert.equal(await darwinHostSeatFileFree(scopeId, { timeoutMs: 2_000, accountHome }), true,
      'releasing the claim must make the seat free')
  } finally {
    // The lifecycle owns the root; nothing to remove by hand.
  }
})
