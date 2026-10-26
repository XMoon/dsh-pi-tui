/**
 * The pure Assistant placement planner: strict marker grammar, original
 * UTF-16 source spans, tail fallback and the display-only shared-definition
 * context over one continuous Markdown text run.
 *
 * Every expected span below is built from the independently known marker line
 * and the hand-written surrounding text — never from the planner's own output.
 * @module @xmoon76/dsh-pi-tui/domain/visual-placement.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  planVisualPlacement,
  type PlacementPiece,
  type TextPiece,
  type VisualPiece,
} from '../../src/domain/visual/placement.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'

const REF_A = `sv1_${'a'.repeat(20)}`
const REF_B = `sv1_${'b'.repeat(20)}`
const REF_C = `sv1_${'c'.repeat(20)}`

function marker(ref: string): string {
  return `[dsh-visual-${ref}]: <#>`
}

/** A qualified publication fixture: the planner only reads `ref`/order. */
function publication(ref: string, turn = 0): PublishedVisual {
  return {
    ref,
    turn,
    step: 1,
    stepStartSeq: 5,
    callSeq: 6,
    resultSeq: 7,
    callId: `call-${ref.slice(-4)}`,
    source: {
      ref,
      type: 'chart',
      title: 'Request latency',
      turn,
      step: 0,
      stepStartSeq: 1,
      callSeq: 2,
      resultSeq: 3,
      callId: `source-${ref.slice(-4)}`,
      chart: {
        version: 1,
        type: 'chart',
        kind: 'bars',
        title: 'Request latency',
        unit: 'ms',
        series: [{ label: 'p50', value: 42 }],
      },
      svg: undefined,
      svgSource: undefined,
      svgAdmissionWidth: undefined,
    },
  }
}

/** A simplified, JSON-comparable view of the planner output. */
function shape(pieces: readonly PlacementPiece[]): unknown[] {
  return pieces.map(piece => piece.kind === 'text'
    ? {
      kind: 'text',
      blockIndex: piece.blockIndex,
      start: piece.start,
      end: piece.end,
      source: piece.source,
    }
    : {
      kind: 'visual',
      ref: piece.ref,
      blockIndex: piece.blockIndex,
      placement: piece.placement,
      markerStart: piece.markerStart,
      markerEnd: piece.markerEnd,
    })
}

function textPieces(pieces: readonly PlacementPiece[]): TextPiece[] {
  return pieces.filter((piece): piece is TextPiece => piece.kind === 'text')
}

function visualPieces(pieces: readonly PlacementPiece[]): VisualPiece[] {
  return pieces.filter((piece): piece is VisualPiece => piece.kind === 'visual')
}

/** Independently rebuild one block's text after deleting the consumed marker
 * spans (the marker text only; the line terminator stays source content). */
function reconstructedBlock(pieces: readonly PlacementPiece[], blockIndex: number): string {
  return textPieces(pieces)
    .filter(piece => piece.blockIndex === blockIndex)
    .map(piece => piece.source)
    .join('')
}

function expectedAfterMarkers(text: string, markers: readonly { start: number; end: number }[]): string {
  let out = ''
  let cursor = 0
  for (const markerSpan of markers) {
    out += text.slice(cursor, markerSpan.start)
    cursor = markerSpan.end
  }
  return out + text.slice(cursor)
}

function definitionPrefix(plan: ReturnType<typeof planVisualPlacement>, blockIndex: number): string {
  return plan.definitions.find(definition => definition.blockIndexes.includes(blockIndex))?.prefix ?? ''
}

// ── positive placement ───────────────────────────────────────────────────

test('a marker between two paragraphs produces text, visual, text with exact UTF-16 spans', () => {
  const before = '这是依赖图。'
  const after = '如图所示。'
  const doc = `${before}\n\n${marker(REF_A)}\n\n${after}`
  const start = before.length + 2
  const end = start + marker(REF_A).length
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  assert.deepEqual(shape(plan.pieces), [
    { kind: 'text', blockIndex: 0, start: 0, end: start, source: `${before}\n\n` },
    { kind: 'visual', ref: REF_A, blockIndex: 0, placement: 'inline', markerStart: start, markerEnd: end },
    { kind: 'text', blockIndex: 0, start: end, end: doc.length, source: `\n\n${after}` },
  ])
  assert.equal(reconstructedBlock(plan.pieces, 0), `${before}\n\n\n\n${after}`)
})

test('a leading marker keeps an explicit empty first text piece', () => {
  const doc = `${marker(REF_A)}\n\nbody`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  assert.deepEqual(shape(plan.pieces), [
    { kind: 'text', blockIndex: 0, start: 0, end: 0, source: '' },
    { kind: 'visual', ref: REF_A, blockIndex: 0, placement: 'inline', markerStart: 0, markerEnd: marker(REF_A).length },
    { kind: 'text', blockIndex: 0, start: marker(REF_A).length, end: doc.length, source: `\n\nbody` },
  ])
})

test('a trailing marker keeps an explicit empty last text piece', () => {
  const doc = `body\n\n${marker(REF_A)}`
  const start = 'body\n\n'.length
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  assert.deepEqual(shape(plan.pieces), [
    { kind: 'text', blockIndex: 0, start: 0, end: start, source: 'body\n\n' },
    { kind: 'visual', ref: REF_A, blockIndex: 0, placement: 'inline', markerStart: start, markerEnd: doc.length },
    { kind: 'text', blockIndex: 0, start: doc.length, end: doc.length, source: '' },
  ])
})

test('an answer that is only one marker keeps empty pieces on both sides', () => {
  const doc = marker(REF_A)
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  assert.deepEqual(shape(plan.pieces), [
    { kind: 'text', blockIndex: 0, start: 0, end: 0, source: '' },
    { kind: 'visual', ref: REF_A, blockIndex: 0, placement: 'inline', markerStart: 0, markerEnd: doc.length },
    { kind: 'text', blockIndex: 0, start: doc.length, end: doc.length, source: '' },
  ])
})

test('two adjacent marker lines stay in source order with their newline between them', () => {
  const doc = `${marker(REF_A)}\n${marker(REF_B)}\nbody`
  const firstEnd = marker(REF_A).length
  const secondStart = firstEnd + 1
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A), publication(REF_B)] })
  assert.deepEqual(shape(plan.pieces), [
    { kind: 'text', blockIndex: 0, start: 0, end: 0, source: '' },
    { kind: 'visual', ref: REF_A, blockIndex: 0, placement: 'inline', markerStart: 0, markerEnd: firstEnd },
    { kind: 'text', blockIndex: 0, start: firstEnd, end: secondStart, source: '\n' },
    { kind: 'visual', ref: REF_B, blockIndex: 0, placement: 'inline', markerStart: secondStart, markerEnd: secondStart + marker(REF_B).length },
    { kind: 'text', blockIndex: 0, start: secondStart + marker(REF_B).length, end: doc.length, source: '\nbody' },
  ])
})

test('a figure before and after a paragraph never moves the later visual after the paragraph', () => {
  const doc = `${marker(REF_A)}\n\nmiddle\n\n${marker(REF_B)}\n\ntail`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A), publication(REF_B)] })
  const kinds = plan.pieces.map(piece => piece.kind === 'visual' ? `v:${piece.ref.slice(-1)}` : (piece.source === '' ? 'e' : 't'))
  assert.deepEqual(kinds, ['e', 'v:a', 't', 'v:b', 't'])
})

test('duplicate markers of the same ref consume only the first and never the later one', () => {
  const first = marker(REF_A)
  const doc = `${first}\n\n${first}\n\nbody`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  const visuals = visualPieces(plan.pieces)
  assert.equal(visuals.length, 1)
  assert.equal(visuals[0]?.markerStart, 0)
  assert.equal(reconstructedBlock(plan.pieces, 0), `\n\n${first}\n\nbody`)
  assert.equal(plan.pieces.some(piece => piece.kind === 'visual' && piece.placement === 'tail'), false)
})

test('a repeated ref followed by a different ref consumes the first occurrence and the second ref', () => {
  const doc = `${marker(REF_A)}\n\n${marker(REF_A)}\n\n${marker(REF_B)}\n\nbody`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A), publication(REF_B)] })
  const inline = visualPieces(plan.pieces).filter(piece => piece.placement === 'inline')
  assert.deepEqual(inline.map(piece => piece.ref), [REF_A, REF_B])
  assert.deepEqual(inline.map(piece => piece.markerStart), [
    0,
    marker(REF_A).length + 2 + marker(REF_A).length + 2,
  ])
  assert.equal(reconstructedBlock(plan.pieces, 0), `\n\n${marker(REF_A)}\n\n\n\nbody`)
})

test('a marker published twice keeps first publication order and inline position', () => {
  const doc = `before\n\n${marker(REF_A)}\n\nafter`
  const plan = planVisualPlacement({
    text: doc,
    publications: [publication(REF_A, 1), publication(REF_A, 2)],
  })
  assert.deepEqual(visualPieces(plan.pieces).map(piece => piece.publication.turn), [1])
})

test('a published ref with no marker becomes exactly one tail visual', () => {
  const doc = 'just prose'
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  assert.deepEqual(shape(plan.pieces), [
    { kind: 'text', blockIndex: 0, start: 0, end: doc.length, source: doc },
    { kind: 'visual', ref: REF_A, blockIndex: null, placement: 'tail', markerStart: undefined, markerEnd: undefined },
  ])
})

test('unconsumed publications append in first-publication order after the body', () => {
  const doc = 'prose'
  const plan = planVisualPlacement({
    text: doc,
    publications: [publication(REF_B), publication(REF_A), publication(REF_C)],
  })
  assert.deepEqual(visualPieces(plan.pieces).map(piece => piece.ref), [REF_B, REF_A, REF_C])
  assert.ok(visualPieces(plan.pieces).every(piece => piece.placement === 'tail'))
})

test('an inline publication in the middle keeps the later unconsumed refs at the tail', () => {
  const doc = `before\n\n${marker(REF_B)}\n\nafter`
  const plan = planVisualPlacement({
    text: doc,
    publications: [publication(REF_A), publication(REF_B), publication(REF_C)],
  })
  assert.deepEqual(visualPieces(plan.pieces).map(piece => `${piece.placement}:${piece.ref}`), [
    `inline:${REF_B}`,
    `tail:${REF_A}`,
    `tail:${REF_C}`,
  ])
})

// ── grammar negatives: text is preserved, nothing is drawn ───────────────

const NEGATIVE_DOCUMENTS: readonly { readonly title: string; readonly doc: string; readonly prefix?: string }[] = [
  { title: 'a fenced code block marker', doc: `before\n\n\`\`\`\n${marker(REF_A)}\n\`\`\`\n\nafter` },
  { title: 'an inline code marker', doc: `before\n\n\`${marker(REF_A)}\`\n\nafter` },
  { title: 'a one-space indented marker', doc: `before\n\n ${marker(REF_A)}\n\nafter` },
  { title: 'a tab-indented marker', doc: `before\n\n\t${marker(REF_A)}\n\nafter` },
  { title: 'a blockquote marker', doc: `before\n\n> ${marker(REF_A)}\n\nafter` },
  { title: 'a list-item marker', doc: `before\n\n- ${marker(REF_A)}\n\nafter` },
  { title: 'an inline paragraph marker without a blank line', doc: `before\n${marker(REF_A)}\nafter` },
  { title: 'a marker with a trailing space', doc: `before\n\n${marker(REF_A)} \n\nafter` },
  { title: 'a marker terminated by a lone CR', doc: `before\n\n${marker(REF_A)}\rafter` },
  { title: 'a marker with a trailing comment', doc: `before\n\n${marker(REF_A)} <!-- -->\n\nafter` },
  { title: 'a marker with an https destination', doc: `before\n\n[dsh-visual-${REF_A}]: <https://example.com>\n\nafter` },
  { title: 'a marker with a plain URL destination', doc: `before\n\n[dsh-visual-${REF_A}]: https://example.com\n\nafter` },
  { title: 'an uppercase-ref marker', doc: `before\n\n[dsh-visual-${REF_A.toUpperCase()}]: <#>\n\nafter` },
  { title: 'a short-ref marker', doc: `before\n\n[dsh-visual-sv1_abc]: <#>\n\nafter`, prefix: '[dsh-visual-sv1_abc]: <#>\n\n' },
  { title: 'an escaped-label marker', doc: `before\n\n\\[dsh-visual-${REF_A}\\]: <#>\n\nafter` },
  { title: 'a marker missing the colon', doc: `before\n\n[dsh-visual-${REF_A}] <#>\n\nafter` },
  { title: 'a marker missing the angle brackets', doc: `before\n\n[dsh-visual-${REF_A}]: #\n\nafter` },
  { title: 'a marker carrying an extra title', doc: `before\n\n[dsh-visual-${REF_A}]: <#> "title"\n\nafter` },
]

for (const negative of NEGATIVE_DOCUMENTS) {
  test(`${negative.title} stays ordinary text and draws nothing`, () => {
    const plan = planVisualPlacement({ text: negative.doc, publications: [publication(REF_A)] })
    assert.deepEqual(visualPieces(plan.pieces).map(piece => piece.placement), ['tail'])
    assert.equal(textPieces(plan.pieces).map(piece => piece.source).join(''), negative.doc)
    assert.equal(definitionPrefix(plan, 0), negative.prefix ?? '')
  })
}

test('a marker whose definition is not top-level (blockquote) is not consumed', () => {
  const doc = `before\n\n> ${marker(REF_A)}\n> after`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  assert.deepEqual(visualPieces(plan.pieces).map(piece => piece.placement), ['tail'])
  assert.equal(reconstructedBlock(plan.pieces, 0), doc)
})

test('an unpublished marker stays source text and the other published ref tails', () => {
  const doc = `before\n\n${marker(REF_A)}\n\nafter`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_B)] })
  assert.deepEqual(visualPieces(plan.pieces).map(piece => `${piece.placement}:${piece.ref}`), [`tail:${REF_B}`])
  assert.equal(reconstructedBlock(plan.pieces, 0), doc)
})

test('a marker split across two text ContentBlocks is never joined into a definition', () => {
  const prefix = `before\n\n[dsh-visual-${REF_A}`
  const content: ContentBlock[] = [
    { type: 'text', text: prefix },
    { type: 'text', text: ']: <#>\n\nafter' },
  ]
  const plan = planVisualPlacement({ text: prefix + ']: <#>\n\nafter', content, publications: [publication(REF_A)] })
  assert.deepEqual(visualPieces(plan.pieces).map(piece => piece.placement), ['tail'])
  assert.equal(reconstructedBlock(plan.pieces, 0), prefix)
  assert.equal(reconstructedBlock(plan.pieces, 1), ']: <#>\n\nafter')
})

// ── source fidelity: CRLF, tabs, CJK, emoji, multiple blocks ──────────────

test('a CRLF marker consumes only the marker text and leaves the CRLF bytes intact', () => {
  const before = '第一段\r\n\r\n'
  const after = '\r\n\r\n第二段'
  const doc = `${before}${marker(REF_A)}${after}`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  const visual = visualPieces(plan.pieces)[0]
  assert.ok(visual !== undefined)
  assert.equal(visual.markerStart, before.length)
  assert.equal(visual.markerEnd, before.length + marker(REF_A).length)
  assert.equal(plan.pieces[0]?.kind === 'text' ? plan.pieces[0].source : undefined, before)
  assert.equal(plan.pieces[2]?.kind === 'text' ? plan.pieces[2].source : undefined, after)
  assert.equal(reconstructedBlock(plan.pieces, 0), `${before}${after}`)
})

test('tabs before the marker are preserved byte for byte while the marker stays column 0', () => {
  const doc = `col1\tcol2\n\n${marker(REF_A)}\n\ncol3\tcol4`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  assert.equal(visualPieces(plan.pieces).length, 1)
  assert.equal(reconstructedBlock(plan.pieces, 0), `col1\tcol2\n\n\n\ncol3\tcol4`)
})

test('CJK and emoji offsets stay UTF-16 code-unit offsets', () => {
  const before = '图🙂\n\n'
  const after = '\n\n尾🙂'
  const doc = `${before}${marker(REF_A)}${after}`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  const visual = visualPieces(plan.pieces)[0]
  assert.ok(visual !== undefined)
  assert.equal(visual.markerStart, before.length)
  assert.equal(visual.markerEnd, before.length + marker(REF_A).length)
  assert.equal(reconstructedBlock(plan.pieces, 0), `${before}${after}`)
})

test('multiple text blocks keep their block identity and exact source slices', () => {
  const first = 'first block\n\n'
  const second = `second\n\n${marker(REF_A)}\n\nblock`
  const content: ContentBlock[] = [
    { type: 'text', text: first },
    { type: 'text', text: second },
  ]
  const plan = planVisualPlacement({
    text: first + second,
    content,
    publications: [publication(REF_A)],
  })
  const visual = visualPieces(plan.pieces)[0]
  assert.ok(visual !== undefined)
  assert.equal(visual.blockIndex, 1)
  assert.equal(visual.markerStart, 'second\n\n'.length)
  assert.deepEqual(textPieces(plan.pieces).map(piece => [piece.blockIndex, piece.start, piece.end]), [
    [0, 0, first.length],
    [1, 0, 'second\n\n'.length],
    [1, 'second\n\n'.length + marker(REF_A).length, second.length],
  ])
  assert.equal(reconstructedBlock(plan.pieces, 0), first)
  assert.equal(reconstructedBlock(plan.pieces, 1), `second\n\n\n\nblock`)
})

test('two markers in two adjacent text blocks keep both original block identities', () => {
  const content: ContentBlock[] = [
    { type: 'text', text: `intro\n\n${marker(REF_A)}\n\n` },
    { type: 'text', text: `middle\n\n${marker(REF_B)}\n\noutro` },
  ]
  const plan = planVisualPlacement({
    text: content.map(block => block.type === 'text' ? block.text : '').join(''),
    content,
    publications: [publication(REF_A), publication(REF_B)],
  })
  const inline = visualPieces(plan.pieces).filter(piece => piece.placement === 'inline')
  assert.deepEqual(inline.map(piece => [piece.ref, piece.blockIndex]), [[REF_A, 0], [REF_B, 1]])
})

test('a rendered image block ends the definitions context at the block boundary', () => {
  const content: ContentBlock[] = [
    { type: 'text', text: 'before [a] [a]\n\n[a]: https://example.com/a\n\n' },
    { type: 'image', attachment: { type: 'image', ref: 'img' } } as never,
    { type: 'text', text: 'after [a]\n\n[a]: https://example.com/b' },
  ]
  const plan = planVisualPlacement({ text: '', content, publications: [] })
  assert.deepEqual(plan.definitions.map(definition => definition.blockIndexes), [[0], [2]])
  assert.match(plan.definitions[0]?.prefix ?? '', /https:\/\/example\.com\/a/u)
  assert.match(plan.definitions[1]?.prefix ?? '', /https:\/\/example\.com\/b/u)
})

test('a reasoning block between text blocks does not split the Markdown run', () => {
  const content: ContentBlock[] = [
    { type: 'text', text: `before\n\n${marker(REF_A)}\n\n` },
    { type: 'reasoning', text: 'internal' } as never,
    { type: 'text', text: 'after [a]\n\n[a]: https://example.com/a' },
  ]
  const plan = planVisualPlacement({ text: '', content, publications: [publication(REF_A)] })
  assert.deepEqual(plan.definitions.map(definition => definition.blockIndexes), [[0, 2]])
  assert.equal(visualPieces(plan.pieces)[0]?.blockIndex, 0)
  assert.match(plan.definitions[0]?.prefix ?? '', /https:\/\/example\.com\/a/u)
})

// ── Candidate S: display-only definitions context ────────────────────────

test('ordinary link definitions become one ordered display prefix with their title', () => {
  const doc = `before [x][one] and [y][two]\n\n[one]: https://example.com/one "One"\n[two]: https://example.com/two\n\nafter`
  const plan = planVisualPlacement({ text: doc, publications: [] })
  assert.equal(
    plan.definitions[0]?.prefix,
    '[one]: https://example.com/one "One"\n[two]: https://example.com/two\n\n',
  )
})

test('duplicate ordinary definitions keep the first valid destination', () => {
  const doc = 'text [x][a]\n\n[a]: https://first.example\n\n[a]: https://second.example'
  const plan = planVisualPlacement({ text: doc, publications: [] })
  assert.equal(plan.definitions[0]?.prefix, '[a]: https://first.example\n\n')
  assert.doesNotMatch(plan.definitions[0]?.prefix ?? '', /second/u)
})

test('visual marker labels never enter the shared definition prefix, published or not', () => {
  const doc = `before\n\n${marker(REF_A)}\n\n[normal]: https://example.com/n\n\n${marker(REF_C)}\nafter`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  const prefix = plan.definitions[0]?.prefix ?? ''
  assert.equal(prefix, '[normal]: https://example.com/n\n\n')
  assert.doesNotMatch(prefix, /dsh-visual/u)
})

test('a definition after a consumed figure is still available to the earlier run prefix', () => {
  const doc = `before [x][late]\n\n${marker(REF_A)}\n\n[late]: https://example.com/late`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  assert.match(plan.definitions[0]?.prefix ?? '', /\[late\]: https:\/\/example\.com\/late/u)
})

test('a footnote-like definition is reported as unsupported and stays out of the prefix', () => {
  const doc = 'text[^1]\n\n[^1]: footnote body'
  const plan = planVisualPlacement({ text: doc, publications: [] })
  assert.equal(plan.definitions[0]?.prefix, '')
  assert.equal(reconstructedBlock(plan.pieces, 0), doc)
})

test('an empty answer produces no pieces and no definitions', () => {
  const plan = planVisualPlacement({ text: '', publications: [] })
  assert.deepEqual(plan.pieces, [])
  assert.deepEqual(plan.definitions, [])
})

test('a text-only answer with no publications is one exact text piece', () => {
  const text = 'plain markdown\n\n- item'
  const plan = planVisualPlacement({ text, publications: [] })
  assert.deepEqual(shape(plan.pieces), [{ kind: 'text', blockIndex: 0, start: 0, end: text.length, source: text }])
})

test('a published ref with a marker that is preceded by another ordinary def stays at its own position', () => {
  const doc = `[other]: https://example.com\n\n${marker(REF_A)}\n\nbody [x][other]`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A)] })
  const visual = visualPieces(plan.pieces)[0]
  assert.ok(visual !== undefined)
  assert.equal(visual.markerStart, '[other]: https://example.com\n\n'.length)
  assert.equal(plan.definitions[0]?.prefix, '[other]: https://example.com\n\n')
})

test('a plain answer with no marker but two publications appends both tails once', () => {
  const plan = planVisualPlacement({ text: 'answer', publications: [publication(REF_A), publication(REF_B)] })
  assert.deepEqual(visualPieces(plan.pieces).map(piece => piece.ref), [REF_A, REF_B])
  assert.equal(visualPieces(plan.pieces).length, 2)
})

test('a duplicated publication ref never appends the same tail twice', () => {
  const plan = planVisualPlacement({ text: 'answer', publications: [publication(REF_A), publication(REF_A), publication(REF_B)] })
  assert.deepEqual(visualPieces(plan.pieces).map(piece => piece.ref), [REF_A, REF_B])
})

test('an empty text piece between two adjacent markers is preserved and never used for pairing', () => {
  const doc = `${marker(REF_A)}\n${marker(REF_B)}`
  const plan = planVisualPlacement({ text: doc, publications: [publication(REF_A), publication(REF_B)] })
  assert.deepEqual(shape(plan.pieces), [
    { kind: 'text', blockIndex: 0, start: 0, end: 0, source: '' },
    { kind: 'visual', ref: REF_A, blockIndex: 0, placement: 'inline', markerStart: 0, markerEnd: marker(REF_A).length },
    { kind: 'text', blockIndex: 0, start: marker(REF_A).length, end: marker(REF_A).length + 1, source: '\n' },
    {
      kind: 'visual',
      ref: REF_B,
      blockIndex: 0,
      placement: 'inline',
      markerStart: marker(REF_A).length + 1,
      markerEnd: marker(REF_A).length + 1 + marker(REF_B).length,
    },
    { kind: 'text', blockIndex: 0, start: marker(REF_A).length + 1 + marker(REF_B).length, end: marker(REF_A).length + 1 + marker(REF_B).length, source: '' },
  ])
})
