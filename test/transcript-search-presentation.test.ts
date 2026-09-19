/**
 * Host rendered search-presentation tests (plan §14.6): the host reuses the
 * fork's pure rendered matcher to select and decorate transcript-search
 * occurrences. The decoration must never change row count or visible width,
 * must keep the stripped text identical, and must use the native weak/current
 * styles.
 * @module @xmoon76/dsh-pi-tui/transcript-search-presentation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth, type Component } from '@xmoon76/pi-tui'
import {
  SearchHighlightComponent,
  highlightSearchLines,
  renderedSearchSelection,
  selectRenderedSearchMatch,
  type RenderedSearchSelector,
} from '../src/search-presentation.ts'

function linesComponent(lines: readonly string[]): Component {
  return {
    render: () => [...lines],
    invalidate: () => {},
  }
}

/** A selector over the whole block (no semantic range). */
function selector(query: string, sourceOccurrence = 0): RenderedSearchSelector {
  return { query, sourceOccurrence }
}

test('presentation: the current occurrence is strong, the others weak', () => {
  const lines = ['foo bar foo']
  const selection = renderedSearchSelection(lines, { query: 'foo', sourceOccurrence: 1 })
  assert.equal(selection.matches.length, 2)
  assert.equal(selection.selectedIndex, 1)
  assert.equal(selection.selectedRow, 0)
  assert.equal(selection.exact, true)
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(decorated[0]!.includes('\x1b[4mfoo\x1b[24m'), 'first occurrence weak underline')
  assert.ok(decorated[0]!.includes('\x1b[1;7mfoo\x1b[22;27m'), 'second occurrence strong')
  assert.equal(stripTerminalSequences(decorated[0]!), 'foo bar foo', 'stripped text preserved')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!), 'visible width preserved')
})

test('presentation: ANSI colored content keeps its codes and width', () => {
  const lines = ['\x1b[31mred needle\x1b[39m and needle']
  const selection = renderedSearchSelection(lines, selector('needle'))
  const decorated = highlightSearchLines(lines, selection)
  assert.equal(stripTerminalSequences(decorated[0]!), 'red needle and needle')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
  assert.ok(decorated[0]!.includes('\x1b[31m'), 'the original color survives')
})

test('presentation: CJK occurrences map to grapheme-safe columns', () => {
  const lines = ['检索 目标词 检索']
  const selection = renderedSearchSelection(lines, selector('检索', 1))
  assert.equal(selection.matches.length, 2)
  assert.equal(selection.selectedIndex, 1)
  const decorated = highlightSearchLines(lines, selection)
  assert.equal(stripTerminalSequences(decorated[0]!), '检索 目标词 检索')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
  assert.ok(decorated[0]!.includes('\x1b[1;7m检索\x1b[22;27m'))
})

test('presentation: an occurrence wrapped across two lines highlights both rows', () => {
  // The renderer wrapped the text between "split" and "word": the matcher's
  // corpus joins rendered tokens with single spaces, so the phrase is one
  // occurrence spanning two rendered rows.
  const lines = ['aaaa split', 'word bbbb']
  const selection = renderedSearchSelection(lines, selector('split word'))
  assert.equal(selection.matches.length, 1)
  assert.equal(selection.matches[0]!.segments.length, 2, 'two rendered segments')
  const decorated = highlightSearchLines(lines, selection)
  assert.equal(decorated.length, 2, 'row count unchanged')
  for (let row = 0; row < lines.length; row += 1) {
    assert.equal(visibleWidth(decorated[row]!), visibleWidth(lines[row]!))
  }
})

test('presentation: image protocol lines are never text-highlighted', () => {
  const lines = ['\x1b_Ga=T,f=100;AAAA\x1b\\', 'needle here']
  const selection = renderedSearchSelection(lines, selector('needle'))
  const decorated = highlightSearchLines(lines, selection)
  assert.equal(decorated[0], lines[0], 'the image line is untouched')
  assert.ok(decorated[1]!.includes('\x1b[1;7mneedle\x1b[22;27m'))
})

test('presentation: a semantic source range scopes the selected occurrence', () => {
  const lines = ['needle in header', 'body needle', 'needle in footer']
  const scoped: RenderedSearchSelector = {
    query: 'needle',
    range: { start: 1, end: 2 },
    sourceOccurrence: 0,
  }
  const selection = renderedSearchSelection(lines, scoped)
  assert.equal(selection.exact, true, 'the in-range occurrence is exact')
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(!decorated[0]!.includes('\x1b[1;7m'), 'the header occurrence is not current')
  assert.ok(decorated[1]!.includes('\x1b[1;7mneedle\x1b[22;27m'), 'the body occurrence is current')
  assert.ok(!decorated[2]!.includes('\x1b[1;7m'), 'the footer occurrence is not current')
})

test('presentation: no match in the semantic range falls back to the ordinal (exact false)', () => {
  const lines = ['needle A', 'needle B']
  const selectorWithMissingRange: RenderedSearchSelector = {
    query: 'needle',
    range: { start: 5, end: 6 },
    sourceOccurrence: 1,
  }
  const selection = renderedSearchSelection(lines, selectorWithMissingRange)
  assert.equal(selection.exact, false)
  assert.equal(selection.selectedIndex, 1, 'the ordinal fallback picks the second rendered occurrence')
  assert.equal(selection.selectedRow, 1)
})

test('presentation: a card with no rendered occurrence anchors its card top', () => {
  const selection = selectRenderedSearchMatch([], selector('needle'))
  assert.equal(selection.selectedIndex, -1)
  assert.equal(selection.selectedRow, 0, 'the owning card top is the fallback row')
  assert.equal(selection.exact, false)
  assert.deepEqual(highlightSearchLines(['nothing here'], selection), ['nothing here'])
})

test('presentation: a source ordinal overflowing its range falls back inexactly', () => {
  // Two occurrences on two rows; the semantic range only contains the first
  // row. Asking for the second source occurrence must NOT be clamped inside
  // the range as an exact hit.
  const lines = ['foo A', 'foo B']
  const selection = renderedSearchSelection(lines, {
    query: 'foo',
    range: { start: 0, end: 1 },
    sourceOccurrence: 1,
  })
  assert.equal(selection.exact, false, 'an out-of-range ordinal is inexact')
  assert.equal(selection.selectedRow, 1, 'the whole-card ordinal fallback selects the second occurrence')
})

test('presentation: a trailing color reset survives the highlight', () => {
  const lines = ['\x1b[31mred needle\x1b[39m']
  const selection = renderedSearchSelection(lines, selector('needle'))
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(decorated[0]!.includes('\x1b[39m'), 'the original trailing reset is preserved')
  assert.equal(stripTerminalSequences(decorated[0]!), 'red needle')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
})

test('presentation: a reset AFTER visible tail text survives a mid-line match', () => {
  const lines = ['\x1b[31mneedle and tail\x1b[39m']
  const selection = renderedSearchSelection(lines, selector('needle'))
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(decorated[0]!.includes('\x1b[39m'), 'the reset after the visible tail is preserved')
  assert.equal(stripTerminalSequences(decorated[0]!), 'needle and tail')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
})

test('presentation: a trailing OSC8 hyperlink terminator survives', () => {
  const open = '\x1b]8;;https://example.com\x1b\\'
  const close = '\x1b]8;;\x1b\\'
  const lines = [`${open}needle link${close}`]
  const selection = renderedSearchSelection(lines, selector('needle'))
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(decorated[0]!.includes(close), 'the hyperlink terminator is preserved')
  assert.equal(stripTerminalSequences(decorated[0]!), 'needle link')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
})

test('presentation: SearchHighlightComponent reuses the child render and decorates it', () => {
  const child = linesComponent(['alpha needle beta'])
  const component = new SearchHighlightComponent(child, selector('needle'))
  const rendered = component.render(40)
  assert.equal(rendered.length, 1)
  assert.ok(rendered[0]!.includes('\x1b[1;7mneedle\x1b[22;27m'))
  assert.equal(stripTerminalSequences(rendered[0]!), 'alpha needle beta')
})
