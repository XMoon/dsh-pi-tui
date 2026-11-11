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
import { Text, findAltScreenSearchMatches, stripTerminalSequences, visibleWidth, type Component } from '@xmoon76/pi-tui'
import {
  SearchHighlightComponent,
  buildSourceGeometry,
  highlightColumnRanges,
  highlightSearchLines,
  selectRenderedSearchMatch,
  selectRenderedSearchScrollRange,
  type RenderedSearchSelector,
  type SearchSourceRegion,
} from '../../src/tui/components/transcript/search-presentation.ts'
import {
  preparePlainTextSourceProbe,
  provePlainTextPaintedSegments,
} from '../../src/tui/components/transcript/plain-text-source-proof.ts'
import { rawSourceRangeForNormalizedMatch } from '../../src/domain/transcript/search.ts'
import { sanitizeDisplayText } from '../../src/tui/presentation/terminal-text.ts'
import { darkColors } from '../../src/domain/display/theme.ts'
import { color, setTheme } from '../../src/tui/theme/runtime.ts'

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
function sourceRangeFor(sourceText: string | undefined, query: string, sourceOccurrence: number): { start: number; end: number } | undefined {
  if (sourceText === undefined) return undefined
  const needle = query.trim().toLowerCase()
  if (needle === '') return undefined
  let start = 0
  let occurrence = 0
  while (true) {
    const index = sourceText.toLowerCase().indexOf(needle, start)
    if (index < 0) return undefined
    if (occurrence === sourceOccurrence) return { start: index, end: index + needle.length }
    occurrence += 1
    start = index + Math.max(1, needle.length)
  }
}

/** A single rendered line can act as direct-source evidence in these pure
 * presentation cases. Multi-row fixtures stay position-only. */
function wholeCardSelector(lines: readonly string[], query: string, sourceOccurrence = 0): RenderedSearchSelector {
  const matches = findAltScreenSearchMatches(lines, query)
  const regions: SearchSourceRegion[] = lines.length === 1
    ? [{
        sourceKey: 'message', anchorRow: 0, rowStart: 0, rowEnd: 1,
        columns: { startCol: 0, endCol: visibleWidth(lines[0]!) },
        sourceText: stripTerminalSequences(lines[0]!),
      }]
    : [{ sourceKey: 'message', anchorRow: 0, rowStart: 0, rowEnd: lines.length, enumerable: false }]
  const geometry = buildSourceGeometry(matches, lines, regions, 'message', query)
  return {
    query,
    sourceOccurrence,
    ...(sourceRangeFor(regions[0]?.sourceText, query, sourceOccurrence) === undefined
      ? {}
      : { normalizedSourceRange: sourceRangeFor(regions[0]?.sourceText, query, sourceOccurrence)! }),
    ...(geometry === undefined ? {} : { geometry }),
  }
}

function selectorForRegions(
  lines: readonly string[],
  query: string,
  regions: readonly SearchSourceRegion[],
  sourceKey: string,
  sourceOccurrence = 0,
): RenderedSearchSelector {
  const matches = findAltScreenSearchMatches(lines, query)
  const sourceTexts = regions.filter(region => region.sourceKey === sourceKey && region.sourceText !== undefined)
  const normalizedSourceRange = sourceTexts.length === 1
    ? sourceRangeFor(sourceTexts[0]!.sourceText, query, sourceOccurrence)
    : undefined
  const geometry = buildSourceGeometry(matches, lines, regions, sourceKey, query)
  return {
    query,
    sourceOccurrence,
    ...(normalizedSourceRange === undefined ? {} : { normalizedSourceRange }),
    ...(geometry === undefined ? {} : { geometry }),
  }
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
  assert.ok(decorated[0]!.includes(color.searchMatch('foo')), 'first occurrence has the ordinary yellow block')
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

test('presentation: overlapping matches in one ZWJ grapheme paint once with the strong style', () => {
  const lines = ['👩‍👩‍👦 needle']
  const matches = findAltScreenSearchMatches(lines, '👩')
  assert.equal(matches.length, 2, 'both semantic regex hits map onto the family grapheme')
  assert.deepEqual(matches.map(match => match.segments), [
    [{ row: 0, startCol: 0, endCol: 2 }],
    [{ row: 0, startCol: 0, endCol: 2 }],
  ])
  const decorated = highlightSearchLines(lines, { matches, selectedIndex: 1, selectedRow: 0, exact: true })
  assert.equal(stripTerminalSequences(decorated[0]!), lines[0], 'the shared grapheme is never duplicated')
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]!))
  assert.ok(decorated[0]!.includes(strong('👩‍👩‍👦')), 'the overlapping current hit wins over the weak hit')
  assert.ok(!decorated[0]!.includes(color.searchMatch('👩‍👩‍👦')), 'the merged interval is not also painted yellow')
})

test('presentation: the shared painter clamps overlapping Job-style ranges to original cells', () => {
  const lines = ['abcdef']
  const ranges = new Map([[0, [
    { range: { startCol: 1, endCol: 4 }, style: (text: string) => `\x1b[31m${text}\x1b[39m` },
    { range: { startCol: 3, endCol: 6 }, style: (text: string) => `\x1b[32m${text}\x1b[39m` },
  ]]])
  const painted = highlightColumnRanges(lines, ranges)
  assert.equal(stripTerminalSequences(painted[0]!), 'abcdef')
  assert.equal(visibleWidth(painted[0]!), visibleWidth(lines[0]!))
})

test('presentation: image protocol lines are never text-highlighted', () => {
  const lines = ['\x1b_Ga=T,f=100;AAAA\x1b\\', 'needle here']
  const regions: SearchSourceRegion[] = [{
    sourceKey: 'message', anchorRow: 1, rowStart: 1, rowEnd: 2,
    columns: { startCol: 0, endCol: visibleWidth('needle here') }, sourceText: 'needle here',
  }]
  const selector = selectorForRegions(lines, 'needle', regions, 'message')
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selector)
  const decorated = highlightSearchLines(lines, selection)
  assert.equal(decorated[0], lines[0], 'the image line is untouched')
  assert.ok(decorated[1]!.includes(strong('needle')))
})

test('presentation: a proven source region scopes the exact occurrence', () => {
  const lines = ['needle in header', 'body needle', 'needle in footer']
  const regions: SearchSourceRegion[] = [{
    sourceKey: 's', anchorRow: 1, rowStart: 1, rowEnd: 2,
    columns: { startCol: 0, endCol: visibleWidth('body needle') }, sourceText: 'body needle',
  }]
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selectorForRegions(lines, 'needle', regions, 's'))
  assert.equal(selection.exact, true, 'the in-region occurrence is exact')
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(!decorated[0]!.includes(strong('needle')), 'the header occurrence is not current')
  assert.ok(decorated[1]!.includes(strong('needle')), 'the body occurrence is current')
  assert.ok(!decorated[2]!.includes(strong('needle')), 'the footer occurrence is not current')
})

test('presentation: normalized source offset selects the matching cell in one direct field', () => {
  const sourceText = 'needle needle'
  const startCol = visibleWidth('Workflow name ')
  const lines = [`Workflow name ${sourceText}`]
  const regions: SearchSourceRegion[] = [{
    sourceKey: 'workflow-name', anchorRow: 0, rowStart: 0, rowEnd: 1,
    columns: { startCol, endCol: startCol + visibleWidth(sourceText) }, sourceText,
  }]
  const matches = findAltScreenSearchMatches(lines, 'needle')
  const selector = selectorForRegions(lines, 'needle', regions, 'workflow-name', 1)
  const selection = selectRenderedSearchMatch(matches, selector)
  assert.deepEqual(selector.normalizedSourceRange, { start: 7, end: 13 })
  assert.equal(selection.exact, true)
  assert.equal(selection.selectedIndex, 1)
  assert.deepEqual(selection.matches[selection.selectedIndex]!.segments, [{ row: 0, startCol: startCol + 7, endCol: startCol + 13 }])
})

test('presentation: source proof rejects Unicode, whitespace, ANSI, truncation and grapheme ambiguity', () => {
  const cases = [
    { line: 'İ i', sourceText: 'İ i', query: 'i' },
    { line: 'ſ s', sourceText: 'ſ s', query: 's' },
    { line: 'alpha  beta', sourceText: 'alpha  beta', query: 'alpha  beta' },
    { line: '👩‍👩‍👦 needle', sourceText: '👩‍👩‍👦 needle', query: '👩' },
    { line: 'safe field', sourceText: 'safe\u001b[2J field', query: 'field' },
    { line: 'needle…', sourceText: 'needle after truncation', query: 'needle' },
  ]
  for (const item of cases) {
    const lines = [item.line]
    const regions: SearchSourceRegion[] = [{
      sourceKey: 'field', anchorRow: 0, rowStart: 0, rowEnd: 1,
      columns: { startCol: 0, endCol: visibleWidth(item.line) }, sourceText: item.sourceText,
    }]
    const selector = selectorForRegions(lines, item.query, regions, 'field')
    const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, item.query), selector)
    assert.equal(selection.exact, false, `${JSON.stringify(item)} must not claim exact provenance`)
    assert.equal(selection.selectedIndex, -1, `${JSON.stringify(item)} must remain anchor-only`)
    assert.equal(selector.geometry?.occurrences.length, 0, `${JSON.stringify(item)} produces no proven geometry`)
  }
})

test('presentation: multiple direct regions for one source do not create ambiguous geometry', () => {
  const lines = ['needle needle']
  const sourceText = 'needle needle'
  const region = {
    sourceKey: 'field', anchorRow: 0, rowStart: 0, rowEnd: 1,
    columns: { startCol: 0, endCol: visibleWidth(sourceText) }, sourceText,
  }
  const selector = selectorForRegions(lines, 'needle', [region, region], 'field')
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selector)
  assert.equal(selection.exact, false)
  assert.equal(selection.selectedIndex, -1)
  assert.equal(selector.geometry?.occurrences.length, 0)
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
  const regions: SearchSourceRegion[] = [{
    sourceKey: 's', anchorRow: 0, rowStart: 0, rowEnd: 1,
    columns: { startCol: 0, endCol: visibleWidth('foo A') }, sourceText: 'foo A',
  }]
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
    {
      sourceKey: 'tool.args', anchorRow: 0, rowStart: 0, rowEnd: 1,
      columns: { startCol: 5, endCol: 16 }, sourceText: 'echo needle',
    },
    {
      sourceKey: 'tool.result', anchorRow: 1, rowStart: 1, rowEnd: 2,
      columns: { startCol: 0, endCol: visibleWidth('needle output') }, sourceText: 'needle output',
    },
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
  const lines = ['split word once']
  const selector = wholeCardSelector(lines, 'split')
  const matches = findAltScreenSearchMatches(lines, 'split')
  const selection = selectRenderedSearchMatch(matches, selector)
  assert.equal(selection.exact, true)
  assert.deepEqual(selectRenderedSearchScrollRange(matches, selection, selector, [
    {
      sourceKey: 'message', anchorRow: 0, rowStart: 0, rowEnd: lines.length,
      columns: { startCol: 0, endCol: visibleWidth(lines[0]!) }, sourceText: 'split word once',
    },
  ]), { startRow: 0, endRow: 0 })
})

test('presentation: anchor-only navigation does not infer an ordinal from multiple source hits', () => {
  const lines = ['needle top', 'filler', 'needle middle', 'needle outside']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 0, rowStart: 0, rowEnd: 3, enumerable: false }]
  const selector = selectorForRegions(lines, 'needle', regions, 's', 1)
  const matches = findAltScreenSearchMatches(lines, 'needle')
  const selection = selectRenderedSearchMatch(matches, selector)
  const range = selectRenderedSearchScrollRange(matches, selection, selector, regions)
  assert.equal(selection.selectedIndex, -1)
  assert.equal(selection.exact, false)
  assert.equal(selection.selectedRow, 0)
  assert.deepEqual(range, { startRow: 0, endRow: 0 }, 'multiple possible rows stay on the source anchor')
})

test('presentation: one candidate after a card header is navigable but remains anchor-only', () => {
  const lines = ['card header', 'needle in source']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 1, rowStart: 1, rowEnd: 2, enumerable: false }]
  const selector = selectorForRegions(lines, 'needle', regions, 's', 0)
  const matches = findAltScreenSearchMatches(lines, 'needle')
  const selection = selectRenderedSearchMatch(matches, selector)
  const range = selectRenderedSearchScrollRange(matches, selection, selector, regions)
  assert.equal(selection.selectedIndex, -1)
  assert.equal(selection.exact, false)
  assert.equal(selection.selectedRow, 1)
  assert.deepEqual(range, { startRow: 1, endRow: 1 })
})

test('presentation: a source region with no rendered hit falls back to its anchor', () => {
  const lines = ['needle elsewhere', 'source anchor']
  const regions: SearchSourceRegion[] = [{ sourceKey: 's', anchorRow: 1, rowStart: 1, rowEnd: 2, enumerable: false }]
  const selector = selectorForRegions(lines, 'needle', regions, 's')
  const matches = findAltScreenSearchMatches(lines, 'needle')
  const selection = selectRenderedSearchMatch(matches, selector)
  assert.deepEqual(selectRenderedSearchScrollRange(matches, selection, selector, regions), { startRow: 1, endRow: 1 })
})

test('presentation: no source region falls back to the card top', () => {
  const lines = ['needle first', 'filler', 'needle second']
  const selector: RenderedSearchSelector = { query: 'needle', sourceOccurrence: 1 }
  const matches = findAltScreenSearchMatches(lines, 'needle')
  const selection = selectRenderedSearchMatch(matches, selector)
  assert.equal(selection.selectedIndex, -1)
  assert.deepEqual(selectRenderedSearchScrollRange(matches, selection, selector, []), { startRow: 0, endRow: 0 })
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
  assert.equal(decorated[0]!.split(color.searchMatch('foo')).length - 1, 2, 'both occurrences are weak')
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

test('presentation: stale Thinking geometry suppresses title and hint matches after width or content changes', () => {
  const sourceLines = ['🌊 Thinking', '  thinking body', '  click to expand']
  const selectors: RenderedSearchSelector[] = [
    { query: 'thinking', sourceOccurrence: 0, weakOnly: true, suppressMatchesOnStaleGeometry: true },
    {
      query: 'thinking', sourceOccurrence: 0, suppressMatchesOnStaleGeometry: true,
      geometry: { sourceKey: 'message', anchorRow: 1, occurrences: [] },
    },
  ]
  const initialMatches = findAltScreenSearchMatches(sourceLines, 'thinking')
    .filter(match => match.segments.every(segment => segment.row === 1))
  assert.equal(initialMatches.length, 1, 'the current Thinking body row is initially eligible')

  for (const selector of selectors) {
    const initialSelection = selectRenderedSearchMatch(initialMatches, selector)
    for (const stale of [
      { width: 10, lines: ['🌊', 'Thinking', '  thinking', '  click to expand'] },
      { width: 40, lines: ['🌊 Thinking', '  thinking body changed', '  click to expand'] },
    ]) {
      let renderedInitial = false
      const child: Component = {
        render: () => {
          if (renderedInitial) return [...stale.lines]
          renderedInitial = true
          return [...sourceLines]
        },
        invalidate: () => {},
      }
      const component = new SearchHighlightComponent(child, selector, initialSelection, 40, sourceLines)
      const before = component.render(40)
      if (selector.weakOnly) {
        assert.ok(before[1]!.includes(color.searchMatch('thinking')), 'the non-current body is yellow')
      } else {
        assert.ok(before[1]!.includes(color.searchAnchorBg('  ')), 'the current body source has its anchor wash')
      }

      const after = component.render(stale.width)
      assert.deepEqual(after.map(stripTerminalSequences), [...stale.lines], 'stale geometry preserves every rendered row verbatim')
      assert.ok(after.every(line => !line.includes(color.searchMatch('Thinking')) && !line.includes('\x1b[1;7m')),
        'stale Thinking geometry suppresses matches rather than highlighting title or hint chrome')
      assert.ok(after.every(line => !line.includes(color.searchAnchorBg('Thinking'))),
        'stale Thinking geometry cannot row-wash the wrapped title')
    }
  }
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
  assert.ok(decorated[0]!.includes(color.searchMatch('needle')), 'the anchor row occurrence is still only yellow')
  assert.ok(decorated[0]!.includes(color.searchAnchorBg(' A')), 'legacy callers retain the weaker row wash')
  assert.ok(!decorated[0]!.includes(strong('needle')), 'an anchor-only selection never strong-highlights a guess')
  assert.ok(!decorated[1]!.includes(color.searchAnchorBg('needle')), 'the other rows are untouched')
  assert.ok(decorated[1]!.includes(color.searchMatch('needle')), 'the other visible occurrence stays yellow')
})

test('presentation: the exact occurrence is NOT row-washed', () => {
  const lines = ['needle A', 'needle B']
  const regions: SearchSourceRegion[] = [{
    sourceKey: 's', anchorRow: 1, rowStart: 1, rowEnd: 2,
    columns: { startCol: 0, endCol: visibleWidth('needle B') }, sourceText: 'needle B',
  }]
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), selectorForRegions(lines, 'needle', regions, 's'))
  assert.equal(selection.exact, true)
  assert.equal(selection.selectedRow, 1)
  const decorated = highlightSearchLines(lines, selection)
  assert.ok(decorated[1]!.includes(strong('needle')), 'the exact occurrence carries the themed block')
  assert.ok(!decorated[1]!.includes(color.searchAnchorBg('needle')), 'the exact occurrence is never row-washed')
})

test('presentation: the current styles follow the active palette (light + custom)', () => {
  const lines = ['alpha needle and needle beta']
  const selection = selectRenderedSearchMatch(findAltScreenSearchMatches(lines, 'needle'), wholeCardSelector(lines, 'needle', 1))
  try {
    setTheme('light')
    assert.ok(highlightSearchLines(lines, selection)[0]!.includes(color.searchMatch('needle')),
      'the light palette paints ordinary occurrences')
    assert.ok(color.searchMatch('needle').includes('\x1b[48;2;255;230;138m'),
      'the light ordinary block uses the pale yellow background')
    assert.ok(highlightSearchLines(lines, selection)[0]!.includes(color.searchCurrent('needle')),
      'the light palette paints the current occurrence')
    assert.ok(color.searchCurrent('needle').includes('\x1b[48;2;174;80;5m'),
      'the light current block uses the orange background')
    setTheme('custom', { ...darkColors, searchCurrentBg: '#123456' })
    assert.ok(highlightSearchLines(lines, selection)[0]!.includes(color.searchMatch('needle')),
      'a custom palette keeps its ordinary yellow block')
    assert.ok(highlightSearchLines(lines, selection)[0]!.includes(color.searchCurrent('needle')),
      'a custom palette override flows into the highlight')
    assert.ok(highlightSearchLines(lines, selection)[0]!.includes('\x1b[48;2;18;52;86m'),
      'the custom current background is the one actually painted')
  } finally {
    setTheme('dark')
  }
})

test('presentation: a current card anchor is orange while visible query words stay yellow', () => {
  const lines = ['Read result needle and needle']
  const matches = findAltScreenSearchMatches(lines, 'needle')
  const decorated = highlightSearchLines(lines, {
    matches,
    selectedIndex: -1,
    selectedRow: undefined,
    exact: false,
    cardAnchor: { row: 0, startCol: 0, endCol: visibleWidth('Read result') },
  })
  const yellow = color.searchMatch('needle')
  const orangeAnchor = color.searchCardAnchor('\x1b[22mRead result')
  assert.ok(decorated[0]!.includes(yellow), 'every visible body match remains yellow')
  assert.ok(decorated[0]!.includes(orangeAnchor), 'only the actual card header columns use the orange anchor')
  assert.ok(!decorated[0]!.includes(color.searchCurrent('Read result')), 'the card anchor never claims the bold exact style')
  assert.equal(stripTerminalSequences(decorated[0]!), lines[0])
  assert.equal(visibleWidth(decorated[0]!), visibleWidth(lines[0]))
})

test('presentation: a bold first line never makes the card anchor bold', () => {
  const lines = ['\x1b[1mHeading needle\x1b[22m']
  const decorated = highlightSearchLines(lines, {
    matches: [],
    selectedIndex: -1,
    selectedRow: 0,
    exact: false,
    cardAnchor: { row: 0, startCol: 0, endCol: 7 },
  })
  assert.equal(stripTerminalSequences(decorated[0]!), 'Heading needle', 'visible text is unchanged')
  assert.ok(decorated[0]!.includes('\x1b[22mHeading'), 'the content bold is neutralised inside the anchor')
  assert.ok(!decorated[0]!.includes('\x1b[1mHeading'), 'the anchor text itself never starts bold')
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
  const { searchMatchFg: _matchFg, searchMatchBg: _matchBg, searchCurrentFg: _fg, searchCurrentBg: _bg, searchAnchorBg: _anchor, ...legacy } = darkColors
  void _matchFg
  void _matchBg
  void _fg
  void _bg
  void _anchor
  try {
    setTheme('custom', legacy as never)
    const styled = color.searchCurrent('needle')
    assert.ok(color.searchMatch('needle').includes('\x1b[48;2;245;197;66m'),
      'a legacy dark palette inherits the ordinary yellow block')
    assert.ok(!styled.includes('\x1b[1;7m'), 'a legacy palette NEVER falls back to the terminal inverse attribute')
    assert.ok(styled.includes('\x1b[48;2;229;138;36m'), 'the current dark occurrence inherits the orange block')
    assert.ok(color.searchAnchorBg('needle').includes('\x1b[48;2;'), 'the anchor wash also has an explicit background')

    setTheme('custom', { ...legacy, text: '#1A1A1A' } as never)
    assert.ok(color.searchMatch('x').includes('\x1b[48;2;255;230;138m'),
      'a legacy light-family palette inherits the light ordinary block')
    assert.ok(color.searchCurrent('x').includes('\x1b[48;2;174;80;5m'),
      'a light-family palette inherits the orange current block')
  } finally {
    setTheme('dark')
  }
})

// ── plain-text source-to-cell proof (PR-B) ─────────────────────────────────

/** The disposable witness URL is the ONLY source-cell evidence; it must never
 * reach a painted line. */
const PROBE_URL = 'https://dsh-pi-tui-search-proof.invalid/current'

/** Prepare a source, render the original and the tagged probe through the SAME
 * Text layout, and hand both to the proof. */
function plainTextProof(
  sourceText: string,
  needle: string,
  occurrence = 0,
  width = 40,
): { lines: string[]; probe: string[]; expected: string; segments: ReturnType<typeof provePlainTextPaintedSegments> } | undefined {
  const normalized = sourceText.toLowerCase()
  let start = 0
  let found = 0
  let range: { start: number; end: number } | undefined
  while (true) {
    const index = normalized.indexOf(needle, start)
    if (index < 0) break
    if (found === occurrence) {
      range = { start: index, end: index + needle.length }
      break
    }
    found += 1
    start = index + Math.max(1, needle.length)
  }
  if (range === undefined) return undefined
  const prepared = preparePlainTextSourceProbe(sourceText, range, needle)
  if (prepared === undefined) return undefined
  const lines = new Text(sanitizeDisplayText(sourceText), 0, 0).render(width)
  const probe = new Text(prepared.taggedDisplayText, 0, 0).render(width)
  return {
    lines,
    probe,
    expected: prepared.expectedVisibleMatch,
    segments: provePlainTextPaintedSegments(lines, probe, prepared.expectedVisibleMatch),
  }
}

test('proof: normalized offsets resolve only to real codepoint boundaries', () => {
  // `İ` lowercases to TWO code units; the first `i` sits inside the
  // expansion and has no raw codepoint boundary.
  assert.equal(rawSourceRangeForNormalizedMatch('İ i', { start: 0, end: 1 }), undefined)
  assert.deepEqual(rawSourceRangeForNormalizedMatch('İ i', { start: 3, end: 4 }), { start: 2, end: 3 })
  // A whole astral codepoint (surrogate pair) is a real boundary; its interior
  // UTF-16 index is never considered.
  assert.deepEqual(rawSourceRangeForNormalizedMatch('👩 needle', { start: 0, end: 2 }), { start: 0, end: 2 })
  assert.equal(rawSourceRangeForNormalizedMatch('abc', { start: 1.5, end: 2 }), undefined)
  assert.equal(rawSourceRangeForNormalizedMatch('abc', { start: 1, end: 1 }), undefined)
  assert.equal(rawSourceRangeForNormalizedMatch('abc', { start: 0, end: 4 }), undefined)
  assert.equal(rawSourceRangeForNormalizedMatch('abc', { start: -1, end: 2 }), undefined)
})

test('proof: preparation rejects expansion interiors, grapheme splits, whitespace-only and split escapes', () => {
  assert.equal(preparePlainTextSourceProbe('İ i', { start: 0, end: 1 }, 'i'), undefined,
    'a lowercase expansion interior is not a source span')
  assert.ok(preparePlainTextSourceProbe('İ i', { start: 3, end: 4 }, 'i') !== undefined,
    'the second, real codepoint is proveable')
  assert.equal(preparePlainTextSourceProbe('👩‍👩‍👦 needle', { start: 0, end: 2 }, '👩'), undefined,
    'a ZWJ family interior is not a grapheme boundary')
  assert.equal(preparePlainTextSourceProbe('e\u0301 needle', { start: 0, end: 1 }, 'e'), undefined,
    'a combining-mark interior is not a grapheme boundary')
  assert.ok(preparePlainTextSourceProbe('👩 needle', { start: 0, end: 2 }, '👩') !== undefined)
  assert.ok(preparePlainTextSourceProbe('检索 needle', { start: 0, end: 2 }, '检索') !== undefined)
  assert.equal(preparePlainTextSourceProbe('a b', { start: 1, end: 2 }, ' '), undefined,
    'a whitespace-only match has no painted cell to prove')
  assert.equal(preparePlainTextSourceProbe('a\x1b[31mb', { start: 3, end: 4 }, '3'), undefined,
    'a range crossing half an escape sequence cannot project consistently')
  assert.equal(preparePlainTextSourceProbe('needle', { start: 0, end: 6 }, 'other'), undefined,
    'a stale normalized offset never proves the CURRENT query')
})

test('proof: ANSI/CRLF/TAB sources recover their real painted cells', () => {
  for (const item of [
    { source: 'line one\r\nneedle line two', needle: 'needle' },
    { source: 'col\tneedle\tend', needle: 'needle' },
    { source: 'before \x1b[31mneedle\x1b[39m after', needle: 'needle' },
    { source: 'prefix needle middle needle tail', needle: 'needle', occurrence: 1 },
    { source: '检索 目标词 检索', needle: '检索', occurrence: 1 },
  ]) {
    const proved = plainTextProof(item.source, item.needle, item.occurrence ?? 0, 40)
    assert.ok(proved !== undefined, `precondition: ${JSON.stringify(item)} prepares a witness`)
    assert.ok(proved.segments !== undefined && proved.segments.length > 0, JSON.stringify(item))
    assert.deepEqual(proved.probe.map(stripTerminalSequences), proved.lines.map(stripTerminalSequences),
      'the witness never changes the visible source text')
    assert.deepEqual(proved.probe.map(visibleWidth), proved.lines.map(visibleWidth),
      'the witness never changes the painted width')
    assert.ok(proved.probe.every(line => !stripTerminalSequences(line).includes(PROBE_URL)),
      'the witness URL is zero-width and never visible')
  }
})

test('proof: a match broken by the real soft wrap yields one segment per painted row', () => {
  const proved = plainTextProof('needleword suffix', 'needleword', 0, 6)
  assert.ok(proved !== undefined)
  assert.ok(proved.segments !== undefined, `the split word still proves its cells:\n${proved.probe.join('\n')}`)
  assert.equal(new Set(proved.segments!.map(segment => segment.row)).size, 2, 'two painted rows own the match')
  assert.deepEqual(proved.probe.map(stripTerminalSequences), proved.lines.map(stripTerminalSequences))
  assert.deepEqual(proved.probe.map(visibleWidth), proved.lines.map(visibleWidth))
})

test('proof: any probe/render divergence fails closed', () => {
  const proved = plainTextProof('alpha needle beta', 'needle', 0, 40)
  assert.ok(proved !== undefined)
  assert.ok(proved.segments !== undefined, 'precondition: the baseline witness proves')
  assert.equal(provePlainTextPaintedSegments(proved.lines, [...proved.probe, ''], proved.expected), undefined,
    'an extra probe row is not the same render')
  assert.equal(provePlainTextPaintedSegments([...proved.lines, 'extra'], proved.probe, proved.expected), undefined,
    'an extra live row is not the same render')
  assert.equal(provePlainTextPaintedSegments(
    proved.lines,
    proved.probe.map((line, index) => index === 0 ? line.replace('needle', 'other!') : line),
    proved.expected,
  ), undefined, 'different visible text is not a proof')
  assert.equal(provePlainTextPaintedSegments(proved.lines, proved.probe.map(line => `${line} `), proved.expected), undefined,
    'a different visible width is not the same frame')
  assert.equal(provePlainTextPaintedSegments(proved.lines, proved.probe, 'wrong'), undefined,
    'the recovered graphemes must equal the projected match')
  assert.equal(provePlainTextPaintedSegments(proved.lines, proved.probe, ''), undefined,
    'an empty expectation is never a proof')
})

test('proof: a weak occurrence never widens the proven strong range', () => {
  // The semantic corpus lowercases (U+017F stays U+017F), so `ss` is a hit at
  // source [1,3); the rendered matcher is Unicode ignore-case (U+017F folds to
  // `s`), so it reports the OVERLAPPING `ſs` at [0,2). The strong block must stay
  // exactly the proven cells, and the weak occurrence may only keep the cells
  // the proof did not claim.
  const lines = ['ſss']
  const matches = findAltScreenSearchMatches(lines, 'ss')
  assert.deepEqual(matches.map(match => match.segments), [[{ row: 0, startCol: 0, endCol: 2 }]],
    'fixture: the rendered matcher sees the overlapping long-s occurrence')
  const decorated = highlightSearchLines(lines, {
    matches,
    selectedIndex: -1,
    selectedRow: 0,
    exact: true,
    exactPaintedSegments: [{ row: 0, startCol: 1, endCol: 3 }],
  })
  assert.equal(stripTerminalSequences(decorated[0]!), 'ſss', 'the painted text is unchanged')
  assert.equal(visibleWidth(decorated[0]!), 3, 'the painted width is unchanged')
  assert.ok(decorated[0]!.includes(color.searchCurrent('ss')), 'only the two proven cells are strong')
  assert.ok(!decorated[0]!.includes(color.searchCurrent('ſ')), 'the overlapping weak cell is never upgraded')
  assert.ok(decorated[0]!.includes(color.searchMatch('ſ')), 'the weak occurrence keeps its uncovered cell')

  // A weak occurrence fully covered by the proof disappears instead of
  // duplicating the strong style.
  const covered = highlightSearchLines(lines, {
    matches,
    selectedIndex: -1,
    selectedRow: 0,
    exact: true,
    exactPaintedSegments: [{ row: 0, startCol: 0, endCol: 2 }],
  })
  assert.ok(covered[0]!.includes(strong('ſs')), 'the proven cells stay strong')
  assert.ok(!covered[0]!.includes(color.searchMatch('ſs')), 'a fully covered weak candidate paints nothing')

  // The same rule on the other side: the proof starts first and the weak range
  // only keeps its tail.
  const tail = highlightSearchLines(['xssy'], {
    matches: findAltScreenSearchMatches(['xssy'], 'ss'),
    selectedIndex: -1,
    selectedRow: 0,
    exact: true,
    exactPaintedSegments: [{ row: 0, startCol: 1, endCol: 2 }],
  })
  assert.ok(tail[0]!.includes(strong('s')), 'the proven cell is strong')
  assert.ok(tail[0]!.includes(color.searchMatch('s')), 'the unproven weak cell stays yellow')
})

test('proof: exactPaintedSegments paints only the proven cell and never anchor-washes', () => {
  const lines = ['alpha needle beta needle']
  const matches = findAltScreenSearchMatches(lines, 'needle')
  const selection = highlightSearchLines(lines, {
    matches,
    selectedIndex: -1,
    selectedRow: 0,
    exact: true,
    exactPaintedSegments: [{ row: 0, startCol: 18, endCol: 24 }],
  })
  assert.equal(stripTerminalSequences(selection[0]!), lines[0], 'the painted text is unchanged')
  assert.equal(visibleWidth(selection[0]!), visibleWidth(lines[0]!), 'the painted width is unchanged')
  assert.ok(selection[0]!.includes(strong('needle')), 'the proven second occurrence is current')
  assert.equal(selection[0]!.split(strong('needle')).length - 1, 1, 'exactly ONE occurrence is current')
  assert.ok(selection[0]!.includes(color.searchMatch('needle')), 'the unproven first occurrence stays yellow')
  assert.ok(!selection[0]!.includes(color.searchAnchorBg('alpha')), 'an exact selection is never row-washed')

  const overlapping = highlightSearchLines(lines, {
    matches,
    selectedIndex: -1,
    selectedRow: 0,
    exact: true,
    exactPaintedSegments: [{ row: 0, startCol: 6, endCol: 12 }],
  })
  assert.ok(overlapping[0]!.includes(strong('needle')), 'the proven cell wins over its weak candidate')
  assert.ok(overlapping[0]!.includes(color.searchMatch('needle')), 'the uncovered occurrence remains yellow')
  assert.ok(!overlapping[0]!.includes('\x1b[4m'), 'the painted ranges do not use underline')

  const range = selectRenderedSearchScrollRange(matches, {
    matches,
    selectedIndex: -1,
    selectedRow: 0,
    exact: true,
    exactPaintedSegments: [{ row: 0, startCol: 18, endCol: 24 }],
  }, { query: 'needle', sourceOccurrence: 1 }, [])
  assert.deepEqual(range, { startRow: 0, endRow: 0 }, 'the exact scroll range follows the painted cells')
})
