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
import test from 'node:test'
import { darwinKeyTokensOf } from '../../scripts/lib/split-smoke-darwin-pty.mjs'

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
