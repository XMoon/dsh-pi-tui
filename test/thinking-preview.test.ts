/**
 * The compact Thinking follow-end window (dsh-web running collapsed-reasoning
 * parity): the visible window always ends at the reasoning tail, and the
 * clip never splits a wide/grapheme cell.
 * @module @xmoon76/dsh-pi-tui/thinking-preview.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { visibleWidth } from '@xmoon76/pi-tui'
import { thinkingPreviewTail } from '../src/thinking-preview.ts'

test('thinkingPreviewTail leaves a line that fits untouched', () => {
  assert.equal(thinkingPreviewTail('hello', 5), 'hello')
  assert.equal(thinkingPreviewTail('hello', 10), 'hello')
  assert.equal(thinkingPreviewTail('', 5), '')
  assert.equal(thinkingPreviewTail('hello', 0), '')
})

test('thinkingPreviewTail ends at the final ASCII character when the line overflows', () => {
  const line = 'abcdefghijklmnopqrstuvwxyz'
  const tail = thinkingPreviewTail(line, 5)
  assert.equal(tail, 'vwxyz')
  assert.equal(visibleWidth(tail), 5)
  assert.ok(line.endsWith(tail))
})

test('thinkingPreviewTail shifts its window right as new tokens arrive', () => {
  const first = thinkingPreviewTail('abcdefghijklmnop', 6)
  const grown = thinkingPreviewTail('abcdefghijklmnopQRST', 6)
  assert.equal(first, 'klmnop')
  assert.equal(grown, 'opQRST')
  assert.ok(grown.endsWith('T'), 'the newest token must stay visible')
})

test('thinkingPreviewTail never splits a wide CJK grapheme at its left edge', () => {
  const line = '你好世界你好世界'
  const tail = thinkingPreviewTail(line, 5)
  assert.ok(visibleWidth(tail) <= 5, `the window must fit its budget: ${JSON.stringify(tail)}`)
  assert.ok(line.endsWith(tail), `the window must be a suffix of the line: ${JSON.stringify(tail)}`)
  assert.equal([...tail].every(char => line.includes(char)), true)
  // A wide grapheme is dropped whole, never half-rendered.
  assert.equal(tail.includes('\uFFFD'), false)
})

test('thinkingPreviewTail never breaks an emoji grapheme or leaves a lone surrogate', () => {
  const line = 'ok 😀 then 🎉 and finished 🚀'
  const tail = thinkingPreviewTail(line, 7)
  assert.ok(visibleWidth(tail) <= 7, JSON.stringify(tail))
  assert.ok(line.endsWith(tail), JSON.stringify(tail))
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(tail), false, `a lone high surrogate escaped: ${JSON.stringify(tail)}`)
  assert.equal(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(tail), false, `a lone low surrogate escaped: ${JSON.stringify(tail)}`)
})

test('thinkingPreviewTail with a budget of one column keeps the last character', () => {
  assert.equal(thinkingPreviewTail('abcdef', 1), 'f')
})
