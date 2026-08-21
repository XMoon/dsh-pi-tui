/**
 * Unit tests for the tmux ANSI→HTML converter's color mapping and SGR
 * handling: 16-color and 256-color indexes must map to real CSS colors
 * (the old build emitted invalid `color:ansi(31)`), SGR 22 clears both
 * bold and dim, and underline + strike combine into one text-decoration.
 * Run with `node --test ansi2html.test.mjs` from this directory.
 * @module docs/tmux/ansi2html.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { ansi256ToRgb, applySgr, convertAnsiToHtml, freshStyle, styleCss } from './ansi2html.mjs'

test('16-color indexes map to real CSS colors', () => {
  const fg = freshStyle()
  applySgr(fg, [31])
  assert.equal(fg.fg, '#CD0000', 'ANSI red must be a real color')
  assert.ok(styleCss(fg).startsWith('color:'), 'the style must be valid CSS')
  const bg = freshStyle()
  applySgr(bg, [47])
  assert.equal(bg.bg, '#E5E5E5', 'ANSI white background')
  const bright = freshStyle()
  applySgr(bright, [92])
  assert.equal(bright.fg, '#00FF00', 'bright green must map into the 16-color table')
})

test('bright background 100-107 maps to a real CSS color', () => {
  // Regression: `code >= 90` used to catch 100-107 first, so e.g. 104
  // indexed past the 16-color table and the background silently vanished.
  const brightBlack = freshStyle()
  applySgr(brightBlack, [100])
  assert.equal(brightBlack.bg, '#7F7F7F', 'bright black background (100)')
  assert.ok(styleCss(brightBlack).includes('background-color:'), 'bg style must be valid CSS')
  const brightWhite = freshStyle()
  applySgr(brightWhite, [107])
  assert.equal(brightWhite.bg, '#FFFFFF', 'bright white background (107)')
  assert.equal(brightWhite.fg, '', 'a background code must not touch the foreground')
  // The bright-foreground range still maps fg, not bg.
  const brightFg = freshStyle()
  applySgr(brightFg, [97])
  assert.equal(brightFg.fg, '#FFFFFF', 'bright white foreground (97)')
  assert.equal(brightFg.bg, '', 'a foreground code must not touch the background')
})

test('256-color indexes map through the xterm cube and grey ramp', () => {
  assert.equal(ansi256ToRgb(0), '#000000')
  assert.equal(ansi256ToRgb(15), '#FFFFFF')
  // Cube: level 0/3/5 -> 0/135/255.
  assert.equal(ansi256ToRgb(16), 'rgb(0,0,0)')
  assert.equal(ansi256ToRgb(87), 'rgb(95,255,255)')
  assert.equal(ansi256ToRgb(231), 'rgb(255,255,255)')
  // Grey ramp: 232 -> 8, 255 -> 238.
  assert.equal(ansi256ToRgb(232), 'rgb(8,8,8)')
  assert.equal(ansi256ToRgb(255), 'rgb(238,238,238)')
  const state = freshStyle()
  applySgr(state, [38, 5, 123])
  assert.equal(state.fg, ansi256ToRgb(123), 'SGR 38;5;N must apply the mapped color')
})

test('SGR 22 clears both bold and dim', () => {
  const state = freshStyle()
  applySgr(state, [1, 2])
  assert.equal(state.bold, true)
  assert.equal(state.dim, true)
  applySgr(state, [22])
  assert.equal(state.bold, false, '22 must clear bold')
  assert.equal(state.dim, false, '22 must also clear dim/faint')
})

test('underline and strike combine into one text-decoration', () => {
  const state = freshStyle()
  applySgr(state, [4, 9])
  const css = styleCss(state)
  assert.ok(css.includes('text-decoration:underline line-through'), `both must survive: ${css}`)
  assert.equal((css.match(/text-decoration/g) ?? []).length, 1, 'one decoration property only')
})

test('the converter renders truecolor and 16-color spans', () => {
  const html = convertAnsiToHtml('\x1b[38;2;1;2;3mhi\x1b[0m \x1b[31mred\x1b[0m\n')
  assert.ok(html.includes('color:rgb(1,2,3)'), 'truecolor must render')
  assert.ok(html.includes('color:#CD0000'), '16-color must render as a real color')
  assert.ok(html.includes('<span'), 'styled spans must exist')
})

test('a styled background survives a wrapped continuation row', () => {
  // tmux's incremental captures omit a redundant background re-open on a
  // continuation row; the state must carry across the line break.
  const html = convertAnsiToHtml('\x1b[48;2;44;44;47m❯\x1b[39m body\n  cont')
  const continuation = html.split('\n').at(-1)
  assert.ok(continuation.includes('background-color:rgb(44,44,47)'), `continuation must keep the bubble:\n${html}`)
})

test('a styled trailing newline emits no stray empty span', () => {
  const html = convertAnsiToHtml('\x1b[48;2;44;44;47mrow\n')
  assert.ok(!html.includes('span style="background-color:rgb(44,44,47)"></span>'), `no empty re-open at EOF:\n${html}`)
  assert.ok(!html.endsWith('<span'), `no unclosed span at EOF:\n${html}`)
})

test('consecutive styled newlines emit no empty span between blank rows', () => {
  const html = convertAnsiToHtml('\x1b[48;2;44;44;47mrow\n\n')
  assert.ok(!html.includes('span style="background-color:rgb(44,44,47)"></span>'), `no empty span between blank rows:\n${html}`)
})
