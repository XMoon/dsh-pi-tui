/**
 * Headless tests for the footer command output sanitizer (plan §17.10):
 * SGR + OSC 8 hyperlinks survive; cursor movement, screen clears, OSC
 * title/clipboard, device control and unknown escapes are stripped.
 * @module @xmoon76/dsh-pi-tui/footer-ansi-sanitize.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeCommandOutput } from '../src/footer/ansi-sanitize.ts'

test('plain text and SGR styling survive', () => {
  const out = sanitizeCommandOutput('\x1b[31mred\x1b[0m plain \x1b[38;2;255;0;0mtruecolor\x1b[39m')
  assert.equal(out, '\x1b[31mred\x1b[0m plain \x1b[38;2;255;0;0mtruecolor\x1b[39m')
})

test('OSC 8 hyperlinks survive', () => {
  const out = sanitizeCommandOutput('\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\')
  assert.equal(out, '\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\')
})

test('cursor movement and screen clears are stripped', () => {
  const out = sanitizeCommandOutput('a\x1b[2Jb\x1b[1;1Hc\x1b[Kd')
  assert.equal(out, 'abcd')
})

test('OSC title and OSC 52 clipboard are stripped', () => {
  const out = sanitizeCommandOutput('x\x1b]0;title\x07y\x1b]52;c;base64\x07z')
  assert.equal(out, 'xyz')
})

test('device control and unknown ESC sequences are stripped', () => {
  const out = sanitizeCommandOutput('a\x1bPdevice\x1b\\b\x1bXapc\x1b\\c\x1b[?25ld')
  assert.equal(out, 'abcd')
})

test('a lone ESC is consumed without eating the next character', () => {
  const out = sanitizeCommandOutput('a\x1bb')
  assert.equal(out, 'ab')
})

test('C0 controls are stripped (tab/newline/CR survive as layout whitespace)', () => {
  const out = sanitizeCommandOutput('a\x00b\x07c\td\ne\rf')
  assert.equal(out, 'abc\td\ne\rf')
})

test('a truncated OSC payload consumes just the ESC (the payload is not reliably a control sequence)', () => {
  const out = sanitizeCommandOutput('a\x1b]52;clipboard')
  assert.equal(out, 'a]52;clipboard')
})

test('bare C1 controls (0x80-0x9F) are stripped, including C1 CSI/OSC lead bytes', () => {
  // 0x9B is the C1 CSI lead byte, 0x9D the OSC lead — even WITHOUT the
  // ESC prefix they must never reach the terminal (many terminals accept
  // them as 8-bit controls). The payload TEXT between them is plain data
  // and survives; every control byte itself is removed.
  const out = sanitizeCommandOutput('a\u009b2;3Hb\u009dc\u009d52;clipboard\u009c')
  assert.equal(out, 'a2;3Hbc52;clipboard')
  assert.ok(!/[\u0080-\u009f]/.test(out), `no C1 byte may survive:\n${JSON.stringify(out)}`)
})
