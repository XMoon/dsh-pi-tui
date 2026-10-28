/**
 * The shared copy-boundary control guard (C3 About + C4 Diagnostics).
 * A copied report may keep its own generated line breaks, but no copied
 * external field may inject a terminal control, and TAB/LF/CR must survive as
 * visible escapes rather than raw line/field boundaries.
 * @module @xmoon76/dsh-pi-tui/domain/copy-safe.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { copySafe } from '../../src/domain/terminal/copy-safe.ts'

test('copySafe leaves ordinary text and Unicode untouched', () => {
  assert.equal(copySafe('plain owner:1 failed'), 'plain owner:1 failed')
  assert.equal(copySafe('鲸🙂 ö'), '鲸🙂 ö')
  assert.equal(copySafe(''), '')
})

test('copySafe drops ESC/C1 CSI, OSC, DCS and generic ESC sequences whole', () => {
  assert.equal(copySafe('a\u001b[31mRED\u001b[0mb'), 'aREDb')
  assert.equal(copySafe('a\u009b31mRED\u009b0mb'), 'aREDb')
  assert.equal(copySafe('a\u001b]52;c;ZWNobyBoaQ==\u0007b'), 'ab')
  assert.equal(copySafe('a\u001bPqdcs\u001b\\b'), 'ab')
  assert.equal(copySafe('a\u001b(Bb'), 'ab')
  // An invalid CSI stops at the first non-CSI byte; the ordinary Unicode
  // character that follows is retained (the C3 lexical-category contract).
  assert.equal(copySafe('a\u001b[鲸-post'), 'a鲸-post')
  // An unterminated OSC drops to the end.
  assert.equal(copySafe('a\u001b]52;c;evil'), 'a')
})

test('copySafe escapes TAB/LF/CR visibly and drops the other C0/C1 controls', () => {
  assert.equal(copySafe('a\tb\nc\rd'), 'a\\tb\\nc\\rd')
  assert.equal(copySafe('a\u0000\u0007\u000b\u000c\u007f\u0080\u009cb'), 'ab')
  // A real newline in a field must never become a report line boundary.
  assert.equal(copySafe('owner\nEntry: forged'), 'owner\\nEntry: forged')
})
