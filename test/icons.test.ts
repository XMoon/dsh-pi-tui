/**
 * Icon registry tests: the symbols palette MUST stay one terminal cell per
 * glyph (the plan's width safety gate — a wider symbol would drift every
 * layout that measures by visible width); the minimal palette hides every
 * decorative icon and keeps only 1-cell state/interaction markers; the
 * emoji palette preserves the historical glyphs exactly; and unknown/
 * missing persisted values fail safe to emoji.
 * @module @xmoon76/dsh-pi-tui/icons.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { ALL_ICON_SEMANTICS, iconFor, iconPrefix, iconStyleOf } from '../src/icons.ts'

/** The ONLY semantics allowed to show a glyph under minimal (the plan §34
 * visibility set — guards against someone silently stuffing decorative
 * icons back into minimal). */
const MINIMAL_VISIBLE: ReadonlySet<string> = new Set([
  'error',
  'interrupted',
  'question',
  'disclosure-collapsed',
  'disclosure-expanded',
  'working-a',
  'working-b',
])

test('every symbols glyph measures exactly ONE terminal cell', () => {
  for (const semantic of ALL_ICON_SEMANTICS) {
    const glyph = iconFor(semantic, 'symbols')
    assert.equal(visibleWidth(glyph), 1, `symbols glyph for ${semantic} must be 1 cell (got ${JSON.stringify(glyph)})`)
  }
})

test('minimal hides every decorative icon and keeps 1-cell state markers', () => {
  for (const semantic of ALL_ICON_SEMANTICS) {
    const glyph = iconFor(semantic, 'minimal')
    if (MINIMAL_VISIBLE.has(semantic)) {
      assert.equal(visibleWidth(glyph), 1, `minimal marker for ${semantic} must be 1 cell (got ${JSON.stringify(glyph)})`)
    } else {
      assert.equal(glyph, '', `minimal must hide the decorative icon for ${semantic} (got ${JSON.stringify(glyph)})`)
    }
  }
})

test('iconPrefix never emits a dangling separator for hidden icons', () => {
  // A hidden (minimal) icon contributes NOTHING — no leading space, no
  // double space: `${iconPrefix(...)}Read` must equal `Read`.
  assert.equal(`${iconPrefix('tool-read', 'minimal')}Read`, 'Read')
  assert.equal(`${iconPrefix('context-file', 'minimal')}AGENTS.md`, 'AGENTS.md')
  assert.equal(`${iconPrefix('slash-command', 'minimal')}/settings`, '/settings')
  // Visible icons keep their historical two-space trail (byte-identical
  // emoji default rendering).
  assert.equal(`${iconPrefix('tool-read', 'emoji')}Read`, '📖  Read')
  assert.equal(`${iconPrefix('tool-read', 'symbols')}Read`, '▤  Read')
  assert.equal(`${iconPrefix('error', 'minimal')}Error`, '×  Error')
})

test('every symbols glyph measures exactly ONE terminal cell', () => {
  for (const semantic of ALL_ICON_SEMANTICS) {
    const glyph = iconFor(semantic, 'symbols')
    assert.equal(visibleWidth(glyph), 1, `symbols glyph for ${semantic} must be 1 cell (got ${JSON.stringify(glyph)})`)
  }
})

test('the emoji palette preserves the historical glyphs', () => {
  // The default style must be pixel-identical to the pre-feature UI: these
  // are the exact glyphs the old hard-coded maps returned.
  const expected: Record<string, string> = {
    'tool-read': '📖',
    'tool-search': '🔍',
    'tool-shell': '🖥️',
    'tool-write': '📝',
    'tool-edit': '✏️',
    'tool-code': '⚙️',
    'tool-generic': '🛠️',
    subagent: '🤖',
    workflow: '🧵',
    error: '❌',
    interrupted: '⏹️',
    question: '❓',
    'slash-command': '🎛️',
    'context-file': '📄',
    'context-skill': '📚',
    'context-plugin': '📦',
    'context-notice': '📌',
    'context-recall': '🕘',
    'context-generic': '📎',
    'disclosure-collapsed': '🐋',
    'disclosure-expanded': '🐳',
    'working-a': '🐋',
    'working-b': '🐳',
  }
  for (const semantic of ALL_ICON_SEMANTICS) {
    assert.equal(iconFor(semantic, 'emoji'), expected[semantic], `emoji glyph for ${semantic}`)
  }
})

test('the symbols palette is the documented compact vocabulary', () => {
  const expected: Record<string, string> = {
    'tool-read': '▤',
    'tool-search': '⌕',
    'tool-shell': '›',
    'tool-write': '+',
    'tool-edit': '~',
    'tool-code': '◆',
    'tool-generic': '•',
    subagent: '◆',
    workflow: '◇',
    error: '×',
    interrupted: '■',
    question: '?',
    'slash-command': '›',
    'context-file': '▤',
    'context-skill': '◆',
    'context-plugin': '◇',
    'context-notice': '!',
    'context-recall': '↶',
    'context-generic': '·',
    'disclosure-collapsed': '▸',
    'disclosure-expanded': '▾',
    'working-a': '•',
    'working-b': '◦',
  }
  for (const semantic of ALL_ICON_SEMANTICS) {
    assert.equal(iconFor(semantic, 'symbols'), expected[semantic], `symbols glyph for ${semantic}`)
  }
})

test('iconStyleOf normalizes every persisted value', () => {
  // Missing field (old settings file): emoji.
  assert.equal(iconStyleOf(undefined), 'emoji')
  assert.equal(iconStyleOf(null), 'emoji')
  assert.equal(iconStyleOf(''), 'emoji')
  // Valid values pass through.
  assert.equal(iconStyleOf('emoji'), 'emoji')
  assert.equal(iconStyleOf('symbols'), 'symbols')
  assert.equal(iconStyleOf('minimal'), 'minimal')
  // Unknown/legacy values fail safe to emoji.
  assert.equal(iconStyleOf('hello'), 'emoji')
  assert.equal(iconStyleOf('1'), 'emoji')
})
