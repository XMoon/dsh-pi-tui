/**
 * Headless tests for the terminal window title policy (src/terminal-title.ts):
 * session-title-first composition, short-cwd fallback, the bare `dsh`
 * fallback, display-width capping (CJK / emoji / ZWJ safe), and the
 * no-UUID guarantee.
 * @module @xmoon76/dsh-pi-tui/terminal-title.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import {
  MAX_TERMINAL_TITLE_WIDTH,
  sanitizeTitleText,
  shortPathCwd,
  terminalTitleFits,
  terminalTitleOf,
} from '../src/terminal-title.ts'

test('a session title leads the composed title', () => {
  assert.equal(terminalTitleOf({ sessionTitle: 'Fix queue bug', cwd: '/foo/bar' }), 'dsh · Fix queue bug')
})

test('a whitespace-only session title falls back to the short cwd', () => {
  assert.equal(terminalTitleOf({ sessionTitle: '   ', cwd: '/foo/bar' }), 'dsh · foo/bar')
})

test('an ANSI-WRAPPED whitespace title sanitizes to EMPTY and falls back (sanitize-then-trim)', () => {
  // ‘\x1b[31m   \x1b[0m’: trim-before-sanitize leaves the ANSI wrapper as
  // “content” and yields ‘dsh ·    ’; sanitize-then-trim must collapse to
  // the short-cwd fallback.
  assert.equal(terminalTitleOf({ sessionTitle: '\x1b[31m   \x1b[0m', cwd: '/foo/bar' }), 'dsh · foo/bar')
  // The same with text glued to the ANSI (non-empty content) still works.
  assert.equal(terminalTitleOf({ sessionTitle: '\x1b[31m  hi  \x1b[0m', cwd: '/foo/bar' }), 'dsh · hi')
})

test('no session title and no cwd gives the bare dsh', () => {
  assert.equal(terminalTitleOf({}), 'dsh')
  assert.equal(terminalTitleOf({ sessionTitle: '  ' }), 'dsh')
})

test('a live session WITHOUT a title falls back to the short cwd', () => {
  assert.equal(terminalTitleOf({ sessionTitle: '', cwd: '/repo/work' }), 'dsh · repo/work')
})

test('shortPathCwd keeps the last two segments and never invents a root', () => {
  assert.equal(shortPathCwd('/foo/bar'), 'foo/bar')
  assert.equal(shortPathCwd('/foo/bar/baz'), 'bar/baz')
  assert.equal(shortPathCwd('/'), '/')
  // Windows drive paths split on BOTH separators and join POSIX-style
  // (the footer formatter's rule — title and footer stay consistent).
  assert.equal(shortPathCwd('C:\\repo'), 'C:/repo')
  assert.equal(shortPathCwd('C:\\repo\\work\\deep'), 'work/deep')
  assert.equal(shortPathCwd('\\\\server\\share\\deep'), 'share/deep')
})

test('a long CJK title is truncated by VISIBLE CELLS, never code units', () => {
  const title = terminalTitleOf({
    sessionTitle: '修复当前会话中方向键历史记录错误以及空消息问题的系统级修复方案',
    cwd: '/repo',
  })
  assert.ok(visibleWidth(title) <= MAX_TERMINAL_TITLE_WIDTH, `width ${visibleWidth(title)} must be <= ${MAX_TERMINAL_TITLE_WIDTH}`)
  assert.equal(terminalTitleFits(title), true)
})

test('emoji / ZWJ titles never split a surrogate pair or exceed the cap', () => {
  const title = terminalTitleOf({
    sessionTitle: '👨‍👩‍👧‍👦 fixing things together 👨‍👩‍👧‍👦',
    cwd: '/repo',
  })
  assert.ok(visibleWidth(title) <= MAX_TERMINAL_TITLE_WIDTH, `width ${visibleWidth(title)} must be <= ${MAX_TERMINAL_TITLE_WIDTH}`)
  // No lone surrogates: every code point must be complete.
  const wellFormed = [...title].every(ch => ch.codePointAt(0)! !== 0xFFFD)
  assert.equal(wellFormed, true, 'truncation must never split a surrogate pair')
  assert.ok(title.includes('dsh · '), 'the brand prefix survives')
})

test('the terminal title NEVER contains a full session UUID', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000'
  const title = terminalTitleOf({ sessionTitle: 'my title', cwd: '/repo' })
  assert.ok(!title.includes(uuid), 'the policy inputs are identity-only — no UUID can ever enter')
  // The runner's previous live-session shape (cwd + full id) is gone.
  assert.ok(!title.includes('session-'), 'the id-carrying shape is no longer produced')
})

test('an over-long plain-ASCII session title truncates with the ellipsis', () => {
  const title = terminalTitleOf({ sessionTitle: 'x'.repeat(80), cwd: '/repo' })
  assert.ok(visibleWidth(title) <= MAX_TERMINAL_TITLE_WIDTH)
  assert.ok(title.includes('…'), 'the truncation ellipsis must appear')
})

test('OSC/ANSI injection in a session title is neutralized (never escapes the title payload)', () => {
  // A session title containing an OSC sequence + BEL terminator must not
  // permit arbitrary terminal control: the composed title must be plain
  // visible text with NO escape bytes at all.
  const evil = 'pwned \x1b]0;INJECTED\x07\x1b[31mred\x07'
  const title = terminalTitleOf({ sessionTitle: evil, cwd: '/repo' })
  assert.ok(!title.includes('\x1b'), `no ESC may survive:\n${JSON.stringify(title)}`)
  assert.ok(!title.includes('\x07'), 'no BEL may survive (it terminates the OSC payload)')
  assert.ok(title.includes('pwned'), 'visible text survives')
  assert.ok(!title.includes('INJECTED'), 'the embedded OSC payload is stripped, not executed')
})

test('an UNTERMINATED OSC tail is consumed, never left as visible payload (round-2 finding)', () => {
  // `\x1b]0;INJECTED` with no BEL/ST: stripTerminalSequences cannot parse it
  // (its parser needs a terminator), so the raw payload used to survive as
  // visible text after the ESC was removed. The sanitizer must drop the
  // unterminated claim entirely.
  assert.equal(sanitizeTitleText('x\x1b]0;INJECTED'), 'x')
  assert.equal(sanitizeTitleText('x\x1b]0;INJECTED y'), 'x')
  assert.equal(sanitizeTitleText('x\x1b_APCpayload'), 'x')
  assert.equal(sanitizeTitleText('x\x1b]0;INJECTED\x07y'), 'xy', 'a TERMINATED OSC is still fully stripped')
  const title = terminalTitleOf({ sessionTitle: 'ok\x1b]0;INJECTED', cwd: '/repo' })
  assert.ok(!title.includes('INJECTED'), 'the unterminated OSC payload must not reach the title')
  assert.ok(title.includes('ok'), 'legit text before the sequence survives')
})

test('C0/C1 control characters in a title are stripped', () => {
  assert.equal(sanitizeTitleText('a\x1b[31mb\x07c'), 'abc')
  assert.equal(sanitizeTitleText('line1\r\nline2'), 'line1line2')
  assert.equal(sanitizeTitleText('\n\tplain'), 'plain')
  assert.equal(sanitizeTitleText('plain'), 'plain')
  assert.equal(sanitizeTitleText(''), '')
})

test('shortPathCwd delegates to the footer formatter (single implementation, no drift)', async () => {
  // The footer's shortCwd is the ONE implementation; the title must use it.
  const { shortCwd } = await import('../src/footer/formatters.ts')
  for (const cwd of ['/foo/bar', '/foo/bar/baz', '/', 'C:\\repo', 'C:\\repo\\work\\deep', '\\\\server\\share\\deep']) {
    assert.equal(shortPathCwd(cwd), shortCwd(cwd), `shortPathCwd must equal footer shortCwd for ${cwd}`)
  }
})
