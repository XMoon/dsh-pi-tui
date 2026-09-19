/**
 * Host rendered search-presentation tests (plan §14.6): the host reuses the
 * fork's pure rendered matcher to map a semantic occurrence to a PROVEN
 * rendered occurrence and decorate the visible matches. The decoration must
 * never change row count or visible width, must keep the stripped text
 * identical, and must use the native weak/current styles.
 * @module @xmoon76/dsh-pi-tui/transcript-search-presentation.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { findAltScreenSearchMatches, stripTerminalSequences, visibleWidth, type Component } from '@xmoon76/pi-tui'
import {
  SearchHighlightComponent,
  buildSourceGeometry,
  highlightSearchLines,
  selectRenderedSearchMatch,
  type RenderedSearchSelector,
  type SearchSourceRegion,
} from '../src/search-presentation.ts'

function linesComponent(lines: readonly string[]): Component {
  return {
    render: () => [...lines],
    invalidate: () => {},
  }
}

/** A selector whose single region is the whole card (a message-kind source). */
function wholeCardSelector(lines: readonly string[], query: string, sourceOccurrence = 0): RenderedSearchSelector {
  const matches = findAltScreenSearchMatches(lines, query)
  const geometry = buildSourceGeometry(matches, [{ sourceKey: 'message', anchorRow: 0, rowStart: 0, rowEnd: lines.length }], 'message')
  return { query, sourceOccurrence, ...(geometry === undefined ? {} : { geometry }) }
}

function selectorForRegions(
  lines: readonly string[],
  query: string,
  regions: readonly SearchSourceRegion[],
  sourceKey: string,
  sourceOccurrence = 0,
): RenderedSearchSelector {
  const matches = findAltScreenSearchMatches(lines, query)
  const geometry = buildSourceGeometry(matches, regions, sourceKey)
  return { query, sourceOccurrence, ...(geometry === undefined ? {} : { geometry }) }
}

test('presentation: the current occurrence is strong, the others weak', () => {
  const lines = ['foo bar foo']
  const matches = findAltScreenSearchMatches(lines, 'foo')
  const selection = selectRenderedSearchMatch(matches, wholeCardSelector(lines, 'foo', 1))
  assert.equal(matches.length, 2)
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
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), wholeCardSelector(lines, 'needle'))
  const decorated = highlightSearchLines(lines, selection)
  assert.equal(stripTerminalSequences(decorated[0]!), 'red needle and needle')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
  assert.ok(decorated[0]!.includes('\x1b[31m'), 'the original color survives')
})

test('presentation: CJK occurrences map to grapheme-safe columns', () => {
  const lines = ['检索 目标词 检索']
  const matches = findAltScreenSearchMatches(lines, '检索')
  const selection = selectRenderedSearchMatch(matches, wholeCardSelector(lines, '检索', 1))
  assert.equal(matches.length, 2)
  assert.equal(selection.selectedIndex, 1)
  const decorated = highlightSearchLines(lines, selection)
  assert.equal(stripTerminalSequences(decorated[0]!), '检索 目标词 检索')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
  assert.ok(decorated[0]!.includes('\x1b[1;7m检索\x1b[22;27m'))
})

test('presentation: an occurrence wrapped across two lines highlights both rows', () => {
  const lines = ['aaaa split', 'word bbbb']
  const matches = findAltScreenSearchMatches(lines, 'split word')
  assert.equal(matches.length, 1)
  assert.equal(matches[0]!.segments.length, 2, 'two rendered segments')
  const selection = selectRenderedSearchMatch(matches, wholeCardSelector(lines, 'split word'))
  const decorated = highlightSearchLines(lines, selection)
  assert.equal(decorated.length, 2, 'row count unchanged')
  for (let row = 0; row < lines.length; row += 1) {
    assert.equal(visibleWidth(decorated[row]!), visibleWidth(lines[row]!))
  }
})

test('presentation: image protocol lines are never text-highlighted', () => {
  const lines = ['\x1b_Ga=T,f=100;AAAA\x1b\\', 'needle here']
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), wholeCardSelector(lines, 'needle'))
  const decorated = highlightSearchLines(lines, selection)
  assert.equal(decorated[0], lines[0], 'the image line is untouched')
  assert.ok(decorated[1]!.includes('\x1b[1;7mneedle\x1b[22;27m'))
})

test('presentation: a proven source region scopes the exact occurrence', () => {
  const lines = ['needle in header', 'body needle', 'needle in footer']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 1, rowStart: 1, rowEnd: 2 }]
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selectorForRegions(lines, 'needle', regions, 's'))
  assert.equal(selection.exact, true, 'the in-region occurrence is exact')
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(!decorated[0]!.includes('\x1b[1;7m'), 'the header occurrence is not current')
  assert.ok(decorated[1]!.includes('\x1b[1;7mneedle\x1b[22;27m'), 'the body occurrence is current')
  assert.ok(!decorated[2]!.includes('\x1b[1;7m'), 'the footer occurrence is not current')
})

test('presentation: a visible source region with no provable occurrence anchors it (no strong)', () => {
  const lines = ['needle A', 'needle B']
  // The region rows do not exist in the render: the source is declared but no
  // occurrence inside it can be proven.
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 1, rowStart: 5, rowEnd: 6 }]
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selectorForRegions(lines, 'needle', regions, 's'))
  assert.equal(selection.exact, false)
  assert.equal(selection.selectedIndex, -1, 'NOTHING is strong-highlighted on an unproven mapping')
  assert.equal(selection.selectedRow, 1, 'the selection anchors at the source region row')
})

test('presentation: a source ordinal with no matching rendered occurrence anchors', () => {
  const lines = ['foo A', 'foo B']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 0, rowStart: 0, rowEnd: 1 }]
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'foo'), selectorForRegions(lines, 'foo', regions, 's', 1))
  assert.equal(selection.exact, false, 'an ordinal beyond the proven occurrences is inexact')
  assert.equal(selection.selectedIndex, -1, 'no guessed strong highlight')
  assert.equal(selection.selectedRow, 0, 'the region row is the anchor')
})

test('presentation: no geometry anchors the card top with no strong highlight', () => {
  const selection = selectRenderedSearchMatch([], { query: 'needle', sourceOccurrence: 0 })
  assert.equal(selection.selectedIndex, -1)
  assert.equal(selection.selectedRow, 0, 'the owning card top is the anchor')
  assert.equal(selection.exact, false)
  assert.deepEqual(highlightSearchLines(['nothing here'], selection), ['nothing here'])
})

test('presentation: tool args and result map through distinct proven regions', () => {
  // Header row: `bash echo needle` (name at col 0, args summary at col 5).
  // Body row: the result. Two separate source regions.
  const lines = ['bash echo needle', 'needle output']
  const regions: SearchSourceRegion[] = [
    { sourceKey: 'tool.args', anchorRow: 0, rowStart: 0, rowEnd: 1, columns: { startCol: 5, endCol: 16 } },
    { sourceKey: 'tool.result', anchorRow: 1, rowStart: 1, rowEnd: 2 },
  ]
  const args = selectRenderedSearchMatch(
    findAltScreenSearchMatches(lines, 'needle'),
    selectorForRegions(lines, 'needle', regions, 'tool.args'),
  )
  const result = selectRenderedSearchMatch(
    findAltScreenSearchMatches(lines, 'needle'),
    selectorForRegions(lines, 'needle', regions, 'tool.result'),
  )
  assert.equal(args.selectedRow, 0, 'the args hit selects the header region')
  assert.equal(args.exact, true)
  assert.equal(result.selectedRow, 1, 'the result hit selects the body region')
  assert.equal(result.exact, true)
  assert.ok(highlightSearchLines(lines, args)[0]!.includes('\x1b[1;7mneedle'), 'args strong on the header')
  assert.ok(highlightSearchLines(lines, result)[1]!.includes('\x1b[1;7mneedle'), 'result strong on the body')
})

test('presentation: an enumerable:false region anchors and never claims an occurrence', () => {
  const lines = ['Bash needle summary']
  const regions: SearchSourceRegion[] = [{ sourceKey: 'tool.args', anchorRow: 0, rowStart: 0, rowEnd: 1, columns: { startCol: 5, endCol: 11 }, enumerable: false }]
  const selector = selectorForRegions(lines, 'needle', regions, 'tool.args')
  assert.equal(selector.geometry?.occurrences.length, 0, 'a transformed projection never claims a raw ordinal')
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selector)
  assert.equal(selection.selectedIndex, -1, 'no strong highlight')
  assert.equal(selection.selectedRow, 0, 'the region row anchors the viewport')
  assert.equal(selection.exact, false)
})

test('presentation: a match crossing out of its source region is NOT proven', () => {
  const lines = ['alpha beta']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 0, rowStart: 0, rowEnd: 1, columns: { startCol: 0, endCol: 5 } }]
  const selector = selectorForRegions(lines, 'alpha beta', regions, 's')
  assert.equal(selector.geometry?.occurrences.length, 0, 'a match whose tail leaves the field is not claimed')
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'alpha beta'), selector)
  assert.equal(selection.selectedIndex, -1)
  assert.equal(selection.exact, false)
})

test('presentation: a trailing color reset survives the highlight', () => {
  const lines = ['\x1b[31mred needle\x1b[39m']
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), wholeCardSelector(lines, 'needle'))
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(decorated[0]!.includes('\x1b[39m'), 'the original trailing reset is preserved')
  assert.equal(stripTerminalSequences(decorated[0]!), 'red needle')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
})

test('presentation: a reset AFTER visible tail text survives a mid-line match', () => {
  const lines = ['\x1b[31mneedle and tail\x1b[39m']
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), wholeCardSelector(lines, 'needle'))
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(decorated[0]!.includes('\x1b[39m'), 'the reset after the visible tail is preserved')
  assert.equal(stripTerminalSequences(decorated[0]!), 'needle and tail')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
})

test('presentation: a trailing OSC8 hyperlink terminator survives', () => {
  const open = '\x1b]8;;https://example.com\x1b\\'
  const close = '\x1b]8;;\x1b\\'
  const lines = [`${open}needle link${close}`]
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), wholeCardSelector(lines, 'needle'))
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(decorated[0]!.includes(close), 'the hyperlink terminator is preserved')
  assert.equal(stripTerminalSequences(decorated[0]!), 'needle link')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
})

test('presentation: weakOnly decorates every occurrence and selects none', () => {
  const lines = ['foo bar foo']
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'foo'), { query: 'foo', sourceOccurrence: 0, weakOnly: true })
  assert.equal(selection.selectedIndex, -1, 'no occurrence is current')
  const decorated = highlightSearchLines(lines, selection)
  assert.equal(decorated[0]!.split('\x1b[4m').length - 1, 2, 'both occurrences are weak')
  assert.ok(!decorated[0]!.includes('\x1b[1;7m'), 'no strong occurrence')
  assert.equal(stripTerminalSequences(decorated[0]!), 'foo bar foo')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
})

test('presentation: SearchHighlightComponent reuses the child render and decorates it', () => {
  const lines = ['alpha needle beta']
  const child = linesComponent(lines)
  const selector = wholeCardSelector(lines, 'needle')
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selector)
  const component = new SearchHighlightComponent(child, selector, selection, 40)
  const rendered = component.render(40)
  assert.equal(rendered.length, 1)
  assert.ok(rendered[0]!.includes('\x1b[1;7mneedle\x1b[22;27m'))
  assert.equal(stripTerminalSequences(rendered[0]!), 'alpha needle beta')
})

test('presentation: a width change downgrades to weak (no stale strong geometry)', () => {
  const lines = ['alpha needle beta']
  const child = linesComponent(lines)
  const selector = wholeCardSelector(lines, 'needle')
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selector)
  const component = new SearchHighlightComponent(child, selector, selection, 40)
  const rendered = component.render(10)
  assert.ok(!rendered.some(line => line.includes('\x1b[1;7m')), 'no strong highlight on a width the geometry was not measured at')
})
