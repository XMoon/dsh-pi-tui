/**
 * The display-only `/copy` projection over the shared visual placement planner.
 *
 * These cases pin the two dangerous directions: a consumed marker must vanish,
 * and EVERY byte that is not a consumed marker must survive exactly (CRLF, CJK,
 * tabs, code fences, ordinary definitions, unpublished/duplicate markers). The
 * expected strings are built from hand-written source text — never from the
 * planner's own output — so a planner regression cannot move the expectation
 * with it.
 * @module @xmoon76/dsh-pi-tui/domain/visual-display-copy.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { visibleAssistantTextForCopy } from '../../src/domain/visual/display-copy.ts'
import type { PublishedVisual } from '../../src/domain/visual/publication.ts'

const REF_A = `sv1_${'a'.repeat(20)}`
const REF_B = `sv1_${'b'.repeat(20)}`

function marker(ref: string): string {
  return `[dsh-visual-${ref}]: <#>`
}

/** A qualified publication: the copy projection only reads `ref`/order. */
function publication(ref: string, title = 'Request latency'): PublishedVisual {
  return {
    ref,
    turn: 0,
    step: 1,
    stepStartSeq: 5,
    callSeq: 6,
    resultSeq: 7,
    callId: `present-${ref.slice(-1)}`,
    source: {
      ref,
      type: 'chart',
      title,
      turn: 0,
      step: 0,
      stepStartSeq: 1,
      callSeq: 2,
      resultSeq: 3,
      callId: `chart-${ref.slice(-1)}`,
      chart: {
        version: 1,
        type: 'chart',
        kind: 'bars',
        title,
        unit: 'ms',
        series: [{ label: 'p50', value: 42 }],
      },
      svg: undefined,
      svgSource: undefined,
      svgAdmissionWidth: undefined,
    },
  }
}

test('no publications returns the original flat text even when it looks like a marker', () => {
  const text = `Keep ${marker(REF_A)} exactly.`
  assert.equal(visibleAssistantTextForCopy({ text, publications: [] }), text)
})

test('a consumed inline marker is removed and the surrounding CRLF/CJK/tab bytes survive', () => {
  const text = `第一段。\r\n\r\n${marker(REF_A)}\r\n\r\n\t第二段 😀 保持。\r\n`
  const content: ContentBlock[] = [{ type: 'text', text }]
  assert.equal(
    visibleAssistantTextForCopy({ text, content, publications: [publication(REF_A)] }),
    '第一段。\r\n\r\n\r\n\r\n\t第二段 😀 保持。\r\n',
  )
})

test('a marker-only answer copies nothing while its text block contributes no fake row', () => {
  const text = marker(REF_A)
  assert.equal(
    visibleAssistantTextForCopy({ text, publications: [publication(REF_A)] }),
    '',
  )
})

test('text blocks join in original block order with the marker spans gone', () => {
  const content: ContentBlock[] = [
    { type: 'text', text: `Before.\n\n${marker(REF_A)}\n\n` },
    { type: 'reasoning', text: 'internal reasoning' },
    { type: 'text', text: 'After.' },
  ]
  assert.equal(
    visibleAssistantTextForCopy({ text: '', content, publications: [publication(REF_A)] }),
    'Before.\n\n\n\nAfter.',
  )
})

test('an unpublished marker-shaped line and an ordinary definition keep their bytes', () => {
  const text = `Intro.\n\n${marker(REF_B)}\n\n[link]: https://example.com/x "Title"\n\nEnd.`
  assert.equal(
    visibleAssistantTextForCopy({ text, publications: [publication(REF_A)] }),
    text,
  )
})

test('a repeated marker keeps the first consumed span and the duplicate line as text', () => {
  const text = `${marker(REF_A)}\n\nMiddle.\n\n${marker(REF_A)}\n\nEnd.`
  assert.equal(
    visibleAssistantTextForCopy({ text, publications: [publication(REF_A)] }),
    '\n\nMiddle.\n\n' + marker(REF_A) + '\n\nEnd.',
  )
})

test('a fenced code sample that resembles a marker is never consumed', () => {
  const text = `Example:\n\n\`\`\`\n${marker(REF_A)}\n\`\`\`\n\nDone.`
  assert.equal(
    visibleAssistantTextForCopy({ text, publications: [publication(REF_A)] }),
    text,
  )
})

test('a tail-only publication adds no text and removes no marker-shaped prose', () => {
  const text = 'Plain answer with no marker.'
  assert.equal(
    visibleAssistantTextForCopy({ text, publications: [publication(REF_A)] }),
    text,
  )
})

test('a definition-shaped line without the exact visual destination stays literal', () => {
  const text = `[dsh-visual-${REF_A}]: <https://example.com/not-a-marker>\n\nBody.`
  assert.equal(
    visibleAssistantTextForCopy({ text, publications: [publication(REF_A)] }),
    text,
  )
})
