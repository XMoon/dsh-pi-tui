/**
 * Headless tests for the FooterLayoutV1 validator (plan §14.3): schema
 * version, row/item bounds, tone vocabulary, separator/prefix/suffix
 * limits, importance bounds, and fail-soft errors.
 * @module @xmoon76/dsh-pi-tui/footer-layout.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { isFooterLayout, parseFooterLayout } from '../src/footer/layout.ts'
import { DEFAULT_FOOTER_LAYOUT } from '../src/footer/presets.ts'

test('the builtin default layout parses as valid', () => {
  const parsed = parseFooterLayout(DEFAULT_FOOTER_LAYOUT)
  assert.ok(isFooterLayout(parsed), `default layout must parse: ${JSON.stringify(parsed)}`)
})

test('a custom layout with zones, separator, formats and tones parses', () => {
  const parsed = parseFooterLayout({
    schemaVersion: 1,
    rows: [{
      left: [
        { id: 'agent-preset', format: 'compact' },
        { id: 'model' },
        { id: 'context', format: 'full', tone: 'warning', importance: 90 },
      ],
      right: [{ id: 'focus-mode', prefix: ' ', suffix: ' ' }],
      separator: { text: ' │ ', tone: 'textDim' },
    }],
  })
  assert.ok(isFooterLayout(parsed), `custom layout must parse: ${JSON.stringify(parsed)}`)
  const layout = parsed as Exclude<typeof parsed, { kind: 'error' }>
  assert.equal(layout.rows.length, 1)
  assert.equal(layout.rows[0]!.left.length, 3)
  assert.equal(layout.rows[0]!.right.length, 1)
  assert.equal(layout.rows[0]!.separator?.text, ' │ ')
})

test('invalid documents fail soft with a message', () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /must be an object/],
    [{ schemaVersion: 2, rows: [] }, /schemaVersion/],
    [{ schemaVersion: 1, rows: [] }, /1\.\.2 rows/],
    [{ schemaVersion: 1, rows: [{}, {}, {}] }, /1\.\.2 rows/],
    [{ schemaVersion: 1, rows: [{ left: 'x' }] }, /left\/right must be arrays/],
    [{ schemaVersion: 1, rows: [{ left: [{}] }] }, /id must be a non-empty string/],
    [{ schemaVersion: 1, rows: [{ left: [{ id: 'model', tone: '#ff0000' }] }] }, /unknown tone/],
    [{ schemaVersion: 1, rows: [{ left: [{ id: 'model', importance: 5000 }] }] }, /importance/],
    [{ schemaVersion: 1, rows: [{ left: [{ id: 'model', prefix: 'x'.repeat(20) }] }] }, /prefix/],
    [{ schemaVersion: 1, rows: [{ separator: { text: 'x'.repeat(10) } }] }, /separator text/],
    [{ schemaVersion: 1, rows: [{ left: Array.from({ length: 33 }, (_, i) => ({ id: `i${i}` })) }] }, /32 items/],
  ]
  for (const [input, pattern] of cases) {
    const parsed = parseFooterLayout(input)
    assert.ok(!isFooterLayout(parsed), `must reject: ${JSON.stringify(input)}`)
    assert.match(parsed.message, pattern, `message for ${JSON.stringify(input)}`)
  }
})

test('unknown item ids are NOT a validation error (skipped at render)', () => {
  const parsed = parseFooterLayout({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'ext:kube-context/current' }, { id: 'model' }], right: [] }],
  })
  assert.ok(isFooterLayout(parsed), `unknown ids must parse (render-time skip): ${JSON.stringify(parsed)}`)
})
