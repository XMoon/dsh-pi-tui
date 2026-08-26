/**
 * Headless tests for the FooterLayoutV1 validator (plan §14.3): schema
 * version, row/item bounds, tone vocabulary, separator/prefix/suffix
 * limits, importance bounds, and fail-soft errors.
 * @module @xmoon76/dsh-pi-tui/footer-layout.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { isFooterLayout, parseFooterLayout, resolveCommandFooterFallback, stripControlChars } from '../src/footer/layout.ts'
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
    // Explicit null zones are malformed (only an ABSENT zone is omitted).
    [{ schemaVersion: 1, rows: [{ left: null }] }, /left\/right must be arrays/],
    [{ schemaVersion: 1, rows: [{ right: null, left: [] }] }, /left\/right must be arrays/],
    // Terminal control characters in decoration strings are rejected (a
    // project-supplied layout must never inject ESC/OSC/C0 sequences).
    [{ schemaVersion: 1, rows: [{ left: [{ id: 'model', prefix: '\u001b]0;title\u0007' }] }] }, /control characters/],
    [{ schemaVersion: 1, rows: [{ left: [{ id: 'model', suffix: '\u001b[2J' }] }] }, /control characters/],
    [{ schemaVersion: 1, rows: [{ separator: { text: '\u001b[?1049h' } }] }, /control characters/],
    [{ schemaVersion: 1, rows: [{ separator: { text: '\u0000' } }] }, /control characters/],
    // An id with control characters is the same injection class: an
    // UNKNOWN id renders verbatim in the configurator (OSC 52 clipboard,
    // CSI title/screen control via the raw id label).
    [{ schemaVersion: 1, rows: [{ left: [{ id: '\u001b]52;c;bWFsaWNpb3Vz\u0007' }] }] }, /control characters/],
    [{ schemaVersion: 1, rows: [{ right: [{ id: '\u001b[2J' }] }] }, /control characters/],
    [{ schemaVersion: 1, rows: [{ left: [{ id: '\u0000' }] }] }, /control characters/],
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

test('a separator-less layout survives the settings-service round-trip (schemastery coerces absent object fields to {})', () => {
  // The configurator's default output has NO separator; the dsh settings
  // service coerces a missing optional object field to {} on resolve, so
  // the persisted row comes back as separator: {}. The parser must treat
  // that as "no separator", not a validation failure — otherwise every
  // separator-less custom layout silently reverts to default on reload.
  const parsed = parseFooterLayout({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'model' }], right: [{ id: 'focus-mode' }], separator: {} }],
  })
  assert.ok(isFooterLayout(parsed), `the coerced separator must parse:\n${JSON.stringify(parsed)}`)
  assert.equal(parsed.rows[0]!.separator, undefined, 'the coerced separator must be dropped, not stored')
  // A separator WITH text still parses normally.
  const withSep = parseFooterLayout({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'model' }], right: [], separator: { text: ' │ ', tone: 'textDim' } }],
  })
  assert.ok(isFooterLayout(withSep))
  assert.equal(withSep.rows[0]!.separator?.text, ' │ ')
})

test('resolveCommandFooterFallback: the command fallback restores the persisted NATIVE mode, restart-proof', () => {
  const custom = {
    schemaVersion: 1,
    rows: [{ left: [{ id: 'run-state' }], right: [] }],
  }
  // 'custom' + a valid persisted layout: the fallback is THAT layout (the
  // restart case — the memory has no "last layout").
  assert.deepEqual(resolveCommandFooterFallback({ footerFallbackMode: 'custom', footerLayout: custom }),
    { mode: 'custom', layout: custom }, 'a valid persisted custom layout must be the fallback')
  // 'custom' + an INVALID layout: degrades to the builtin default.
  assert.deepEqual(resolveCommandFooterFallback({ footerFallbackMode: 'custom', footerLayout: { schemaVersion: 9 } }),
    { mode: 'custom', layout: undefined })
  // 'compact': the compact preset survives the restart — `footer` itself
  // is overwritten by 'command', so the mode must come from the separate
  // footerFallbackMode field (the review's P2: the old resolution only
  // read footerLayout and silently fell back to the FULL default).
  assert.deepEqual(resolveCommandFooterFallback({ footerFallbackMode: 'compact' }),
    { mode: 'compact', layout: undefined }, 'a compact user must keep compact')
  // 'default' / absent field (documents predating the field): default.
  assert.deepEqual(resolveCommandFooterFallback({ footerFallbackMode: 'default' }), { mode: 'default', layout: undefined })
  assert.deepEqual(resolveCommandFooterFallback({}), { mode: 'default', layout: undefined })
  assert.deepEqual(resolveCommandFooterFallback(undefined), { mode: 'default', layout: undefined })
  // An unknown mode value is treated as default (never a crash).
  assert.deepEqual(resolveCommandFooterFallback({ footerFallbackMode: 'command' }), { mode: 'default', layout: undefined })
})

test('stripControlChars removes EVERY control character, not just the first (the review round-2 catch)', () => {
  // A non-global replace would remove only the leading ESC and leave the
  // BEL (and any later ESC/CSI) alive in the configurator label.
  const stripped = stripControlChars('a\u001b]52;c;x\u0007b\u001b[2Jc\u0000d\u009be')
  assert.equal(stripped, 'a]52;c;xb[2Jcde', `every control must go: ${JSON.stringify(stripped)}`)
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(stripped), 'no control character may survive')
  // Plain text is untouched.
  assert.equal(stripControlChars('ext:owner/id'), 'ext:owner/id')
  // The parser's own rejections (the non-global .test path) stay correct
  // for EVERY control position — a later-position control must still
  // fail the parse (the global regex used for stripping is separate from
  // the validation regex for exactly this reason).
  const parsed = parseFooterLayout({
    schemaVersion: 1,
    rows: [{ left: [{ id: 'ok\u0007id' }] }],
  })
  assert.ok(!isFooterLayout(parsed), 'a control AFTER the first char must still be rejected')
})
