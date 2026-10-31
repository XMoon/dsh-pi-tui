/**
 * Headless tests for the FooterLayoutV1 validator (plan §14.3): schema
 * version, row/item bounds, tone vocabulary, separator/prefix/suffix
 * limits, importance bounds, and fail-soft errors.
 * @module @xmoon76/dsh-pi-tui/footer-layout.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultHideInTsp, hideFooterRefInTsp, isFooterLayout, parseFooterLayout, resolveCommandFooterFallback, stripControlChars } from '../../src/domain/footer/layout.ts'
import {
  COMPACT_FOOTER_LAYOUT,
  DEFAULT_FOOTER_LAYOUT,
  VIEWER_DEFAULT_FOOTER_LAYOUT,
} from '../../src/domain/footer/presets.ts'
import { createBuiltinFooterRegistry } from '../../src/tui/footer/builtin-items.ts'

test('the builtin default layout parses as valid', () => {
  const parsed = parseFooterLayout(DEFAULT_FOOTER_LAYOUT)
  assert.ok(isFooterLayout(parsed), `default layout must parse: ${JSON.stringify(parsed)}`)
  assert.deepEqual(DEFAULT_FOOTER_LAYOUT.rows[0]!.right.map(ref => ref.id), ['plan-state', 'display-preset'])
})

test('the presets never share placement objects (no cross-preset aliasing)', () => {
  // The status-row placements come from a FACTORY: mutating one preset's
  // refs (a runtime consumer ignoring the readonly types) must never
  // reach the other preset.
  const defaultRef = DEFAULT_FOOTER_LAYOUT.rows[0]!.left[0]!
  const compactRef = COMPACT_FOOTER_LAYOUT.rows[0]!.left[0]!
  assert.notEqual(defaultRef, compactRef, 'each preset owns its placement objects')
  assert.deepEqual(defaultRef, compactRef, 'the placement content is identical')
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

test('DUPLICATE item ids parse in order with every ref intact (repeated placements)', () => {
  // The ordered array IS the placement identity (rowIndex + zone + index):
  // the same definition may be placed repeatedly with independent
  // overrides — no instance id, no schema change (schemaVersion stays 1).
  const parsed = parseFooterLayout({
    schemaVersion: 1,
    rows: [{
      left: [
        { id: 'performance', format: 'latency' },
        { id: 'performance', format: 'speed' },
        { id: 'user:env', tone: 'primary' },
        { id: 'user:env', importance: 10 },
      ],
      right: [{ id: 'performance' }],
    }],
  })
  assert.ok(isFooterLayout(parsed), `duplicate placements must parse: ${JSON.stringify(parsed)}`)
  const layout = parsed as Exclude<typeof parsed, { kind: 'error' }>
  const left = layout.rows[0]!.left
  assert.deepEqual(left.map(ref => ref.id), ['performance', 'performance', 'user:env', 'user:env'])
  assert.deepEqual(left.map(ref => ref.format), ['latency', 'speed', undefined, undefined])
  assert.equal(left[2]!.tone, 'primary')
  assert.equal(left[3]!.importance, 10)
  assert.deepEqual(layout.rows[0]!.right.map(ref => ref.id), ['performance'])
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

test('TPS PR-3: the performance formats and the default speed placement', () => {
  // The definition declares the finite style vocabulary in the order the
  // `/footer` picker cycles it.
  const def = createBuiltinFooterRegistry().get('performance')!
  assert.deepEqual(def.formats, ['full', 'speed', 'speed-all', 'speed-both', 'latency'])
  // BOTH builtin default layouts keep the latency placement and switch the
  // speed placement to the combined pair (the plan's default:
  // `TTFB … · R5 … · All … tok/s`).
  for (const [label, layout] of [['default', DEFAULT_FOOTER_LAYOUT], ['viewer', VIEWER_DEFAULT_FOOTER_LAYOUT]] as const) {
    const placements = layout.rows[1]!.left.filter(ref => ref.id === 'performance')
    assert.deepEqual(placements.map(ref => ref.format), ['latency', 'speed-both'],
      `${label}: the latency placement stays and the speed placement shows the R5 + All pair`)
    // The latency placement (importance 40) drops BEFORE the pair (45), so a
    // narrow footer keeps the pair's one-fact compact form.
    assert.ok((placements[1]!.importance ?? 0) > (placements[0]!.importance ?? 0),
      `${label}: the combined placement keeps the wider drop budget`)
  }
})

test('TPS PR-3: a persisted legacy performance style survives parsing unchanged', () => {
  // A saved document from before this change uses `format: 'speed'` (and the
  // pre-PR-3 vocabulary); it must load verbatim and keep meaning the recent
  // (R5) rate — never rewritten in place.
  const parsed = parseFooterLayout({
    schemaVersion: 1,
    rows: [{
      left: [
        { id: 'performance', format: 'speed', importance: 45 },
        { id: 'performance', format: 'latency', importance: 40 },
      ],
      right: [],
    }],
  })
  assert.ok(isFooterLayout(parsed))
  assert.deepEqual(parsed.rows[0]!.left.map(ref => ref.format), ['speed', 'latency'])
})

test('hideInTsp: absent/true/false parse, and every explicit value survives', () => {
  const parsed = parseFooterLayout({
    schemaVersion: 1,
    rows: [{
      left: [
        { id: 'permission-preset' },
        { id: 'model', hideInTsp: false },
        { id: 'reasoning', hideInTsp: true },
        { id: 'cwd', hideInTsp: true },
      ],
      right: [],
    }],
  })
  assert.ok(isFooterLayout(parsed), `hideInTsp booleans must parse: ${JSON.stringify(parsed)}`)
  const left = parsed.rows[0]!.left
  assert.deepEqual(left.map(ref => ref.hideInTsp), [undefined, false, true, true])
  // The parser never canonicalizes an explicit false away (the safety
  // override for a default-On id).
  assert.equal(left[1]!.hideInTsp, false)
})

test('hideInTsp: non-boolean values fail soft instead of being coerced', () => {
  for (const bad of [1, 0, 'true', 'false', null, {}]) {
    const parsed = parseFooterLayout({
      schemaVersion: 1,
      rows: [{ left: [{ id: 'model', hideInTsp: bad }], right: [] }],
    })
    assert.equal(isFooterLayout(parsed), false, `hideInTsp ${JSON.stringify(bad)} must be rejected`)
    assert.match(String((parsed as { message?: string }).message), /hideInTsp must be a boolean/)
  }
})

test('defaultHideInTsp: permission-preset/model/reasoning default On; every other id Off', () => {
  for (const id of ['permission-preset', 'model', 'reasoning']) {
    assert.equal(defaultHideInTsp(id), true, `${id} defaults to hidden in TSP`)
  }
  for (const id of ['cwd', 'context', 'token-usage', 'user:env', 'ext:owner/item', 'completely-unknown']) {
    assert.equal(defaultHideInTsp(id), false, `${id} defaults to shown in TSP`)
  }
})

test('hideFooterRefInTsp: explicit boolean wins; absent default-On follows the matching affordance', () => {
  const noAffordances = { permission: false, model: false, reasoning: false }
  const allAffordances = { permission: true, model: true, reasoning: true }

  // Explicit values are unconditional, even against a missing control.
  assert.equal(hideFooterRefInTsp({ id: 'permission-preset', hideInTsp: true }, noAffordances), true)
  assert.equal(hideFooterRefInTsp({ id: 'model', hideInTsp: true }, noAffordances), true)
  assert.equal(hideFooterRefInTsp({ id: 'cwd', hideInTsp: true }, allAffordances), true)
  // Explicit false always attempts the normal display, never hides.
  assert.equal(hideFooterRefInTsp({ id: 'permission-preset', hideInTsp: false }, allAffordances), false)
  assert.equal(hideFooterRefInTsp({ id: 'reasoning', hideInTsp: false }, allAffordances), false)

  // Absent defaults: each id reads ONLY its own affordance (never a shared
  // boolean) and every other id stays visible regardless of capabilities.
  assert.equal(hideFooterRefInTsp({ id: 'permission-preset' }, noAffordances), false)
  assert.equal(hideFooterRefInTsp({ id: 'permission-preset' }, allAffordances), true)
  assert.equal(hideFooterRefInTsp({ id: 'model' }, noAffordances), false)
  assert.equal(hideFooterRefInTsp({ id: 'model' }, { ...noAffordances, model: true }), true)
  assert.equal(hideFooterRefInTsp({ id: 'reasoning' }, { ...noAffordances, reasoning: true }), true)
  assert.equal(hideFooterRefInTsp({ id: 'reasoning' }, { ...noAffordances, model: true }), false,
    'a model affordance must never control reasoning')
  assert.equal(hideFooterRefInTsp({ id: 'cwd' }, allAffordances), false)
  assert.equal(hideFooterRefInTsp({ id: 'user:env' }, allAffordances), false)

  // Duplicate placements are independent: the same id with different
  // explicit values produces different decisions.
  assert.equal(hideFooterRefInTsp({ id: 'context', hideInTsp: true }, noAffordances), true)
  assert.equal(hideFooterRefInTsp({ id: 'context' }, noAffordances), false)
})
