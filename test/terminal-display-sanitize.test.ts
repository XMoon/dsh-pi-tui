/**
 * Table-driven tests for the untrusted terminal-text projections
 * (`sanitizeDisplayText` / `sanitizeDisplayLog`): the shared scanner must
 * remove every recognizable terminal control, retain only whitelisted
 * complete SGR in the log policy, and normalize CR/TAB per the frozen
 * display contract.
 * @module @xmoon76/dsh-pi-tui/terminal-display-sanitize.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { sanitizeDisplayLog, sanitizeDisplayText } from '../src/tui/presentation/terminal-text.ts'
import { sanitizedPhysicalLine } from '../src/tui/presentation/lines.ts'

/** No ESC and no C0/C1/DEL other than LF may survive plain projection. */
function assertPlainSafe(value: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code !== 0x0a && code < 0x20) {
      assert.fail(`plain output kept control U+${code.toString(16)} at ${i}`)
    }
    if (code === 0x1b || (code >= 0x7f && code <= 0x9f)) {
      assert.fail(`plain output kept control U+${code.toString(16)} at ${i}`)
    }
  }
}

/** No ESC and no C0/C1/DEL other than LF and `ESC[<params>m` may survive. */
function assertLogSafe(value: string): void {
  let i = 0
  while (i < value.length) {
    const code = value.charCodeAt(i)
    if (code === 0x1b) {
      const match = /^\u001b\[[0-9;]*m/.exec(value.slice(i, i + 32))
      if (match === null) assert.fail(`log output kept a non-SGR escape at ${i}`)
      i += match[0].length
      continue
    }
    if (code !== 0x0a && code < 0x20) assert.fail(`log output kept control U+${code.toString(16)} at ${i}`)
    if (code >= 0x7f && code <= 0x9f) assert.fail(`log output kept control U+${code.toString(16)} at ${i}`)
    i++
  }
}

/** The plan §6 hostile corpus: nothing may escape as terminal control. */
const HOSTILE = [
  '\u001b]52;c;YXR0YWNr\u0007', // clipboard OSC 52
  '\u001b]0;hijacked-title\u001b\\', // title OSC 0
  '\u001b[2J\u001b[H', // screen / cursor
  '\u001b[?1049h\u001b[?1049l', // alternate screen
  '\u001b[?1000h', // mouse mode
  '\u001bPbad\u001b\\', // DCS
  '\u009b2J\u009d52;c;bad\u009c', // C1 CSI / OSC / ST
  '\u001b]52;c;unterminated', // incomplete OSC
  '\u001b[38;2;999;1;1m', // invalid SGR
  'start\r10%\r100%\n', // CR progress
]

const CONTROL_STRINGS = [
  '\u001b]0;title\u0007',
  '\u001b]2;title\u001b\\',
  '\u001b]52;c;YXR0YWNr\u0007',
  '\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007',
  '\u001bPdevice\u001b\\',
  '\u001bXapc\u001b\\',
  '\u001b^pm\u001b\\',
  '\u001b_apc\u001b\\',
  '\u001b[2J',
  '\u001b[H',
  '\u001b[?1049h',
  '\u001b[?1049l',
  '\u001b[?1000h',
  '\u001bc',
  '\u001b7',
  '\u001b8',
  '\u001b#8',
  '\u009b2J',
  '\u009d52;c;bad\u009c',
  '\u0090device\u009c',
  '\u009fapc\u009c',
]

test('hostile corpus: plain projection never emits terminal control', () => {
  for (const payload of [...HOSTILE, ...CONTROL_STRINGS]) {
    const safe = sanitizeDisplayText(payload)
    assertPlainSafe(safe)
  }
})

test('hostile corpus: log projection never emits non-whitelisted control', () => {
  for (const payload of [...HOSTILE, ...CONTROL_STRINGS]) {
    const safe = sanitizeDisplayLog(payload)
    assertLogSafe(safe)
  }
})

test('complete control sequences are removed whole, leaving no visible payload', () => {
  assert.equal(sanitizeDisplayText('a\u001b]0;PWNED\u0007b'), 'ab')
  assert.equal(sanitizeDisplayText('a\u001b[2Jb\u001b[1;1Hc'), 'abc')
  assert.equal(sanitizeDisplayText('a\u001bPbad\u001b\\b'), 'ab')
  assert.equal(sanitizeDisplayText('a\u001bXapc\u001b\\b'), 'ab')
  assert.equal(sanitizeDisplayText('a\u001b^pm\u001b\\b'), 'ab')
  assert.equal(sanitizeDisplayText('a\u001b_apc\u001b\\b'), 'ab')
  assert.equal(sanitizeDisplayText('a\u009b2Jb'), 'ab')
})

test('OSC payload with a nested ESC still consumes to its terminator', () => {
  assert.equal(sanitizeDisplayText('a\u001b]0;ti\u001btle\u0007b'), 'ab')
  assert.equal(sanitizeDisplayText('a\u001b]0;ti\u001btle\u001b\\b'), 'ab')
})

test('unterminated CSI/OSC/DCS strings consume to end of input', () => {
  assert.equal(sanitizeDisplayText('keep\u001b[31'), 'keep')
  assert.equal(sanitizeDisplayText('keep\u001b]0;title'), 'keep')
  assert.equal(sanitizeDisplayText('keep\u001bPdevice'), 'keep')
})

test('orphan and unknown ESC forms never emit their ESC', () => {
  assert.equal(sanitizeDisplayText('a\u001bb'), 'a') // ESC + final byte 'b' is removed whole
  assert.equal(sanitizeDisplayText('a\u001b'), 'a')
  assert.equal(sanitizeDisplayText('a\u001b\u00ffb'), 'a\u00ffb')
})

test('C0/DEL/BEL/BS are dropped except LF', () => {
  assert.equal(sanitizeDisplayText('a\u0000\u0007\u0008\u000bb\u007fc'), 'abc')
  assert.equal(sanitizeDisplayText('a\u0003b'), 'ab')
})

test('plain projection drops SGR and keeps the readable text', () => {
  assert.equal(sanitizeDisplayText('red \u001b[31mtext\u001b[0m'), 'red text')
})

test('log projection keeps whitelisted SGR and ends in an app-owned reset', () => {
  assert.equal(sanitizeDisplayLog('red \u001b[31mtext\u001b[0m'), 'red \u001b[31mtext\u001b[0m\u001b[0m')
})

test('log projection keeps 8/16/256/RGB colors and style attributes individually', () => {
  for (const sgr of [
    '\u001b[0m',
    '\u001b[1m',
    '\u001b[2m',
    '\u001b[3m',
    '\u001b[4m',
    '\u001b[7m',
    '\u001b[9m',
    '\u001b[22m',
    '\u001b[23m',
    '\u001b[24m',
    '\u001b[27m',
    '\u001b[29m',
    '\u001b[31m',
    '\u001b[37m',
    '\u001b[40m',
    '\u001b[47m',
    '\u001b[90m',
    '\u001b[97m',
    '\u001b[100m',
    '\u001b[107m',
    '\u001b[39m',
    '\u001b[49m',
    '\u001b[38;5;0m',
    '\u001b[38;5;196m',
    '\u001b[48;5;255m',
    '\u001b[38;2;0;0;0m',
    '\u001b[38;2;255;128;7m',
    '\u001b[48;2;1;2;3m',
    '\u001b[m',
  ]) {
    assert.equal(sanitizeDisplayLog(`x${sgr}y`), `x${sgr}y\u001b[0m`, `must keep ${JSON.stringify(sgr)}`)
  }
})

test('log projection rejects malformed, unknown or out-of-range SGR as a whole', () => {
  for (const sgr of [
    '\u001b[38;2;999;1;1m',
    '\u001b[38;5;256m',
    '\u001b[38;5m',
    '\u001b[38m',
    '\u001b[48;2;1;2m',
    '\u001b[4:3m',
    '\u001b[38:5:196m',
    '\u001b[5m',
    '\u001b[6m',
    '\u001b[8m',
    '\u001b[999m',
    '\u001b[31;99m',
    '\u001b[;;m',
    '\u001b[31;m',
    '\u001b[>4m',
  ]) {
    assert.equal(sanitizeDisplayLog(`x${sgr}y`), 'xy', `must drop ${JSON.stringify(sgr)}`)
  }
})

test('a C1 CSI expressing SGR never survives the log policy either', () => {
  assert.equal(sanitizeDisplayLog('x\u009b31my'), 'xy')
})

test('CR/TAB normalization differs between the two policies', () => {
  assert.equal(sanitizeDisplayText('a\r\nb\rc\td'), 'a\nb c   d')
  assert.equal(sanitizeDisplayLog('a\r\nb\rc\td'), 'a\nb\nc   d')
})

test('a trailing isolated CR becomes one space (plain) or one LF (log)', () => {
  assert.equal(sanitizeDisplayText('abc\r'), 'abc ')
  assert.equal(sanitizeDisplayLog('abc\r'), 'abc\n')
})

test('CR-separated records keep one line boundary each in the log policy', () => {
  assert.equal(sanitizeDisplayLog('start\r10%\r100%\n'), 'start\n10%\n100%\n')
  assert.equal(sanitizeDisplayText('start\r10%\r100%\n'), 'start 10% 100%\n')
})

test('ordinary Unicode, CJK, emoji and combining marks pass through verbatim', () => {
  for (const text of ['plain ascii', '中文字符', 'emoji 🎉 family 👨‍👩‍👧', 'e\u0301 combining', 'Ω≈ç√']) {
    assert.equal(sanitizeDisplayText(text), text)
    assert.equal(sanitizeDisplayLog(text), text)
  }
})

test('the fast path returns the exact input string', () => {
  const text = 'ordinary text without controls'
  assert.ok(sanitizeDisplayText(text) === text)
  assert.ok(sanitizeDisplayLog(text) === text)
})

test('TAB becomes three spaces and never survives', () => {
  assert.equal(sanitizeDisplayText('a\tb'), 'a   b')
  assert.equal(sanitizeDisplayLog('a\tb'), 'a   b')
})

test('a large hostile stream is bounded and deterministic', () => {
  const chunk = 'line \u001b[31mred\u001b[0m \u001b]0;t\u0007 and \u009b2J text\r\n'
  const big = chunk.repeat(30_000)
  assert.ok(big.length >= 1_000_000)
  const once = sanitizeDisplayLog(big)
  const twice = sanitizeDisplayLog(big)
  assert.equal(once, twice)
  assertLogSafe(once)
  assert.ok(once.endsWith('\u001b[0m'))
  const plain = sanitizeDisplayText(big)
  assertPlainSafe(plain)
})

test('sanitizedPhysicalLine folds any projection onto one physical row', () => {
  assert.equal(sanitizedPhysicalLine('a\r\nb\rc\td'), 'a b c   d')
  assert.equal(sanitizedPhysicalLine('\u001b]0;PWNED\u0007title'), 'title')
  assert.equal(sanitizedPhysicalLine('a\u001b[2Jb'), 'ab')
})
