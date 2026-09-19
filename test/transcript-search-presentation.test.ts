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
  selectRenderedSearchScrollRange,
  type RenderedSearchSelector,
  type SearchSourceRegion,
} from '../src/search-presentation.ts'
import { color, darkColors, setTheme } from '../src/theme.ts'

/** The exact-current style for one run: bold + explicit themed fg/bg (never the
 * terminal's inverse attribute, plan S3 §6.2). */
const strong = (text: string): string => color.searchCurrent(text)

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
  assert.ok(decorated[0]!.includes(strong('foo')), 'second occurrence strong (themed block, no inverse)')
  assert.ok(!decorated[0]!.includes('\x1b[1;7m'), 'the strong style never uses the terminal inverse attribute')
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
  assert.ok(decorated[0]!.includes(strong('检索')))
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
  assert.ok(decorated[1]!.includes(strong('needle')))
})

test('presentation: a proven source region scopes the exact occurrence', () => {
  const lines = ['needle in header', 'body needle', 'needle in footer']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 1, rowStart: 1, rowEnd: 2 }]
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selectorForRegions(lines, 'needle', regions, 's'))
  assert.equal(selection.exact, true, 'the in-region occurrence is exact')
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(!decorated[0]!.includes(strong('needle')), 'the header occurrence is not current')
  assert.ok(decorated[1]!.includes(strong('needle')), 'the body occurrence is current')
  assert.ok(!decorated[2]!.includes(strong('needle')), 'the footer occurrence is not current')
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
  // The card top is still an ANCHOR-ONLY current: it carries the weaker wash
  // even though the card has no rendered occurrence at all.
  assert.deepEqual(highlightSearchLines(['nothing here'], selection), [color.searchAnchorBg('nothing here')])
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
  assert.ok(highlightSearchLines(lines, args)[0]!.includes(strong('needle')), 'args strong on the header')
  assert.ok(highlightSearchLines(lines, result)[1]!.includes(strong('needle')), 'result strong on the body')
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

test('presentation: exact scroll range follows the selected rendered occurrence', () => {
  const lines = ['split', 'word', 'split word again']
  const selector = wholeCardSelector(lines, 'split word')
  const matches = findAltScreenSearchMatches(lines, 'split word')
  const selection = selectRenderedSearchMatch(matches, selector)
  assert.equal(selection.exact, true)
  assert.deepEqual(selectRenderedSearchScrollRange(matches, selection, selector, [
    { sourceKey: 'message', anchorRow: 0, rowStart: 0, rowEnd: lines.length },
  ]), { startRow: 0, endRow: 1 })
})

test('presentation: anchor-only scroll range prefers source-local position regions', () => {
  const lines = ['needle top', 'filler', 'needle middle', 'needle outside']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 0, rowStart: 0, rowEnd: 3, enumerable: false }]
  const selector = selectorForRegions(lines, 'needle', regions, 's', 1)
  const matches = findAltScreenSearchMatches(lines, 'needle')
  const selection = selectRenderedSearchMatch(matches, selector)
  const range = selectRenderedSearchScrollRange(matches, selection, selector, regions)
  assert.equal(selection.selectedIndex, -1)
  assert.equal(selection.exact, false)
  assert.equal(selection.selectedRow, 0)
  assert.deepEqual(range, { startRow: 2, endRow: 2 }, 'the second in-region hit wins over an unrelated card hit')
})

test('presentation: a source region with no rendered hit falls back to its anchor', () => {
  const lines = ['needle elsewhere', 'source anchor']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 1, rowStart: 1, rowEnd: 2, enumerable: false }]
  const selector = selectorForRegions(lines, 'needle', regions, 's')
  const matches = findAltScreenSearchMatches(lines, 'needle')
  const selection = selectRenderedSearchMatch(matches, selector)
  assert.deepEqual(selectRenderedSearchScrollRange(matches, selection, selector, regions), { startRow: 1, endRow: 1 })
})

test('presentation: no source region allows card-wide approximate navigation', () => {
  const lines = ['needle first', 'filler', 'needle second']
  const selector: RenderedSearchSelector = { query: 'needle', sourceOccurrence: 1 }
  const matches = findAltScreenSearchMatches(lines, 'needle')
  const selection = selectRenderedSearchMatch(matches, selector)
  assert.equal(selection.selectedIndex, -1)
  assert.deepEqual(selectRenderedSearchScrollRange(matches, selection, selector, []), { startRow: 2, endRow: 2 })
})

test('presentation: no rendered hit keeps the honest anchor row', () => {
  const lines = ['nothing here', 'source anchor']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 1, rowStart: 1, rowEnd: 2, enumerable: false }]
  const selector = selectorForRegions(lines, 'needle', regions, 's')
  const matches = findAltScreenSearchMatches(lines, 'needle')
  const selection = selectRenderedSearchMatch(matches, selector)
  assert.deepEqual(selectRenderedSearchScrollRange(matches, selection, selector, regions), { startRow: 1, endRow: 1 })
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
  const component = new SearchHighlightComponent(child, selector, selection, 40, lines)
  const rendered = component.render(40)
  assert.equal(rendered.length, 1)
  assert.ok(rendered[0]!.includes(strong('needle')))
  assert.equal(stripTerminalSequences(rendered[0]!), 'alpha needle beta')
})

test('presentation: a width change downgrades to weak (no stale strong geometry)', () => {
  const lines = ['alpha needle beta']
  const child = linesComponent(lines)
  const selector = wholeCardSelector(lines, 'needle')
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selector)
  const component = new SearchHighlightComponent(child, selector, selection, 40, lines)
  const rendered = component.render(10)
  assert.ok(!rendered.some(line => line.includes('\x1b[1;7m')), 'no strong highlight on a width the geometry was not measured at')
})

test('presentation: a same-width content change never reuses stale strong geometry', () => {
  let lines: readonly string[] = ['needle here']
  const child: Component = { render: () => [...lines], invalidate: () => {} }
  const selector = wholeCardSelector(lines, 'needle')
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selector)
  const component = new SearchHighlightComponent(child, selector, selection, 40, lines)
  assert.ok(component.render(40)[0]!.includes(strong('needle')), 'precondition: the proven occurrence is strong')
  lines = ['foobar here']
  const second = component.render(40)
  assert.ok(!second.some(line => line.includes('\x1b[1;7m')), 'changed content must not inherit a stale strong occurrence')
  assert.ok(!second[0]!.includes('needle'), 'the old occurrence is gone from the render')
})

test('presentation: clear() stops decorating a mounted wrapper', () => {
  const lines = ['alpha needle beta']
  const child = linesComponent(lines)
  const selector = wholeCardSelector(lines, 'needle')
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selector)
  const component = new SearchHighlightComponent(child, selector, selection, 40, lines)
  component.clear()
  const rendered = component.render(40)
  assert.deepEqual(rendered, ['alpha needle beta'], 'a cleared wrapper returns the raw child lines')
})

test('presentation: an anchor-only current washes ONLY the anchor row and keeps every occurrence weak', () => {
  const lines = ['needle A', 'needle B']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 0, rowStart: 0, rowEnd: 1, enumerable: false }]
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selectorForRegions(lines, 'needle', regions, 's'))
  assert.equal(selection.selectedIndex, -1, 'no occurrence is proven')
  assert.equal(selection.selectedRow, 0, 'the anchor row is the region row')
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(decorated[0]!.includes('\x1b[4m'), 'the anchor row occurrence is still only weak')
  assert.ok(decorated[0]!.includes(color.searchAnchorBg('needle')), 'the anchor row carries the weaker current wash')
  assert.ok(decorated[0]!.includes(color.searchAnchorBg(' A')), 'the wash covers the whole anchor row, not just the occurrence')
  assert.ok(!decorated[0]!.includes(strong('needle')), 'an anchor-only selection never strong-highlights a guess')
  assert.ok(!decorated[1]!.includes(color.searchAnchorBg('needle')), 'the other rows are untouched')
  assert.ok(decorated[1]!.includes('\x1b[4m'), 'the other visible occurrence stays weak')
})

test('presentation: the exact occurrence is NOT row-washed', () => {
  const lines = ['needle A', 'needle B']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 1, rowStart: 1, rowEnd: 2 }]
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selectorForRegions(lines, 'needle', regions, 's'))
  assert.equal(selection.exact, true)
  assert.equal(selection.selectedRow, 1)
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(decorated[1]!.includes(strong('needle')), 'the exact occurrence carries the themed block')
  assert.ok(!decorated[1]!.includes(color.searchAnchorBg('needle')), 'the exact occurrence is never row-washed')
})

test('presentation: the current styles follow the active palette (light + custom)', () => {
  const lines = ['alpha needle beta']
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), wholeCardSelector(lines, 'needle'))
  try {
    setTheme('light')
    assert.ok(highlightSearchLines(lines, selection)[0]!.includes(color.searchCurrent('needle')),
      'the light palette paints the current occurrence')
    assert.equal(color.searchCurrent('needle').includes('\x1b[48;2;245;197;66m'), false,
      'the light current block is not the dark background')
    setTheme('custom', { ...darkColors, searchCurrentBg: '#123456' })
    assert.ok(highlightSearchLines(lines, selection)[0]!.includes(color.searchCurrent('needle')),
      'a custom palette override flows into the highlight')
    assert.ok(highlightSearchLines(lines, selection)[0]!.includes('\x1b[48;2;18;52;86m'),
      'the custom background is the one actually painted')
  } finally {
    setTheme('dark')
  }
})

test('presentation: an anchor-only current with NO visible occurrence still washes its anchor row', () => {
  const lines = ['nothing here', 'nor here either']
  const matches = findAltScreenSearchMatches(lines, 'needle')
  assert.equal(matches.length, 0, 'precondition: no rendered occurrence exists')
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 1, rowStart: 1, rowEnd: 2, enumerable: false }]
  const selection = selectRenderedSearchMatch(matches, selectorForRegions(lines, 'needle', regions, 's'))
  assert.equal(selection.selectedIndex, -1, 'nothing is strong-highlighted')
  assert.equal(selection.selectedRow, 1, 'the source region anchors the viewport')
  const decorated = highlightSearchLines(lines, selection)
  assert.equal(decorated[1], color.searchAnchorBg(lines[1]!), 'the anchor row is washed even with no visible occurrence')
  assert.equal(decorated[0], lines[0], 'the other rows are untouched')
  assert.ok(!decorated[1]!.includes(strong('needle')), 'no occurrence is fabricated')
})

test('presentation: a palette that predates the search tokens still paints an explicit themed block', () => {
  const { searchCurrentFg: _fg, searchCurrentBg: _bg, searchAnchorBg: _anchor, ...legacy } = darkColors
  void _fg
  void _bg
  void _anchor
  try {
    setTheme('custom', legacy as never)
    const styled = color.searchCurrent('needle')
    assert.ok(!styled.includes('\x1b[1;7m'), 'a legacy palette NEVER falls back to the terminal inverse attribute')
    assert.ok(styled.includes('\x1b[48;2;'), 'the current occurrence has an explicit inherited background')
    assert.ok(color.searchAnchorBg('needle').includes('\x1b[48;2;'), 'the anchor wash also has an explicit background')

    // The body-text luminance picks the inherited family.
    setTheme('custom', { ...legacy, text: '#1A1A1A' } as never)
    assert.ok(color.searchCurrent('x').includes('\x1b[48;2;255;215;94m'),
      'a light-family body text inherits the light search block')
  } finally {
    setTheme('dark')
  }
})
