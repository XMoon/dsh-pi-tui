/**
 * TSP-7 PR-D: the one-shot TSP native footer config resolver (the pure
 * domain decision — which native presentation a TSP mount uses).
 *
 * Covers the fixed mode algorithm (default/full/compact/custom/command
 * fallback), invalid layouts, USER text vs command classification, the
 * not-ready fail-closed rule, notice bounding/dedup and the read-only
 * contract (the settings document object is never mutated).
 *
 * @module @xmoon76/dsh-pi-tui/domain/tsp-native-footer-config
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveTspNativeFooterConfig,
  TSP_FOOTER_NOTICES,
} from '../../src/domain/footer/tsp-native-config.ts'

const READY = 'ready'
const EMPTY_ITEMS = { items: [], invalidCount: 0 }

/** A minimal valid custom layout. */
const validLayout = {
  schemaVersion: 1,
  rows: [
    {
      left: [{ id: 'model', format: 'compact', importance: 90 }],
      right: [{ id: 'context', format: 'percent', importance: 100 }],
    },
    {
      left: [
        { id: 'performance', format: 'latency', importance: 40 },
        { id: 'performance', format: 'speed-both', importance: 45 },
      ],
      right: [],
    },
  ],
}

const textItem = (id: string, text: string) => ({ schemaVersion: 1 as const, id, kind: 'text' as const, text })
const commandItem = (id: string, command: string) =>
  ({ schemaVersion: 1 as const, id, kind: 'command' as const, command, refreshIntervalMs: 5000 })

test('a default footer resolves to the fixed default and never reads footerLayout', () => {
  const doc = { footer: 'default', footerLayout: validLayout }
  const result = resolveTspNativeFooterConfig({ doc, readiness: READY, userItems: EMPTY_ITEMS })
  assert.equal(result.mode, 'default')
  assert.equal(result.layout, undefined, 'a stale layout must not pollute the default mode')
  assert.deepEqual(result.notices, [])
})

test('full and unknown compat values resolve to the fixed default', () => {
  for (const footer of ['full', 'banner', '']) {
    const result = resolveTspNativeFooterConfig({ doc: { footer }, readiness: READY, userItems: EMPTY_ITEMS })
    assert.equal(result.mode, 'default', `footer=${footer}`)
    assert.deepEqual(result.notices, [], `footer=${footer} produces no notice`)
  }
})

test('compact resolves to the TSP compact preset without reusing the persisted layout', () => {
  const doc = { footer: 'compact', footerLayout: validLayout }
  const result = resolveTspNativeFooterConfig({ doc, readiness: READY, userItems: EMPTY_ITEMS })
  assert.equal(result.mode, 'compact')
  assert.equal(result.layout, undefined, 'compact has its OWN fixed row; the persisted layout stays untouched')
})

test('custom with a valid layout resolves to custom and carries the exact parsed layout', () => {
  const result = resolveTspNativeFooterConfig({ doc: { footer: 'custom', footerLayout: validLayout }, readiness: READY, userItems: EMPTY_ITEMS })
  assert.equal(result.mode, 'custom')
  assert.ok(result.layout !== undefined)
  assert.equal(result.layout.rows.length, 2)
  assert.deepEqual(result.notices, [])
})

test('custom with an invalid layout fails soft to the fixed default with ONE notice', () => {
  for (const invalid of [undefined, {}, { schemaVersion: 2, rows: [] }, { schemaVersion: 1, rows: [] }, { schemaVersion: 1, rows: [{ left: 'x', right: [] }] }]) {
    const result = resolveTspNativeFooterConfig({ doc: { footer: 'custom', footerLayout: invalid }, readiness: READY, userItems: EMPTY_ITEMS })
    assert.equal(result.mode, 'default', `invalid layout=${JSON.stringify(invalid)}`)
    assert.deepEqual(result.notices, [TSP_FOOTER_NOTICES.invalidLayout])
  }
})

test('an invalid custom layout is never normalized into the projection', () => {
  const doc = { footer: 'custom', footerLayout: { schemaVersion: 1, rows: [{ left: [{ id: 'x' }] }] } }
  const snapshot = JSON.stringify(doc)
  resolveTspNativeFooterConfig({ doc, readiness: READY, userItems: EMPTY_ITEMS })
  assert.equal(JSON.stringify(doc), snapshot, 'the raw persisted document is not rewritten')
})

test('a not-ready backend fails closed: fixed default, no USER items, ONE not-current notice', () => {
  const userItems = {
    items: [textItem('user:env', 'prod'), commandItem('user:clock', 'date')],
    invalidCount: 2,
  }
  for (const readiness of ['stale', 'unavailable', '']) {
    const result = resolveTspNativeFooterConfig({ doc: { footer: 'custom', footerLayout: validLayout }, readiness, userItems })
    assert.equal(result.mode, 'default', `readiness=${readiness}`)
    assert.deepEqual(result.userTextItems, [], 'no USER text is trusted while not ready')
    assert.equal(result.userCommandIds.size, 0, 'no USER command id is trusted while not ready')
    assert.deepEqual(result.notices, [TSP_FOOTER_NOTICES.notCurrent], 'exactly the not-current notice')
  }
})

test('USER text items project; USER command items keep only their ids', () => {
  const userItems = {
    items: [textItem('user:env', 'prod'), commandItem('user:clock', 'date')],
    invalidCount: 0,
  }
  const result = resolveTspNativeFooterConfig({ doc: { footer: 'custom', footerLayout: validLayout }, readiness: READY, userItems })
  assert.deepEqual(result.userTextItems.map(item => item.id), ['user:env'])
  assert.deepEqual([...result.userCommandIds], ['user:clock'])
})

test('a command-item definition never carries its command string into the projection', () => {
  const userItems = { items: [commandItem('user:clock', 'curl http://hostile.example')], invalidCount: 0 }
  const result = resolveTspNativeFooterConfig({ doc: { footer: 'custom', footerLayout: validLayout }, readiness: READY, userItems })
  assert.equal(JSON.stringify(result).includes('curl'), false,
    'the command string never reaches the renderer-facing projection')
})

test('invalid USER custom items are skipped with ONE notice (only while ready)', () => {
  const userItems = { items: [textItem('user:env', 'prod')], invalidCount: 3 }
  const ready = resolveTspNativeFooterConfig({ doc: { footer: 'default' }, readiness: READY, userItems })
  assert.ok(ready.notices.includes(TSP_FOOTER_NOTICES.invalidCustomItems))
  const notReady = resolveTspNativeFooterConfig({ doc: { footer: 'default' }, readiness: 'stale', userItems })
  assert.ok(!notReady.notices.includes(TSP_FOOTER_NOTICES.invalidCustomItems),
    'not-ready keeps its single not-current notice')
})

test('whole-footer command falls back to the persisted default with ONE command notice', () => {
  const result = resolveTspNativeFooterConfig({ doc: { footer: 'command' }, readiness: READY, userItems: EMPTY_ITEMS })
  assert.equal(result.mode, 'default')
  assert.deepEqual(result.notices, [TSP_FOOTER_NOTICES.commandFallback])
})

test('whole-footer command with footerFallbackMode compact resolves to compact', () => {
  const result = resolveTspNativeFooterConfig({ doc: { footer: 'command', footerFallbackMode: 'compact' }, readiness: READY, userItems: EMPTY_ITEMS })
  assert.equal(result.mode, 'compact')
  assert.deepEqual(result.notices, [TSP_FOOTER_NOTICES.commandFallback])
})

test('whole-footer command with a valid custom fallback resolves to custom', () => {
  const result = resolveTspNativeFooterConfig({ doc: { footer: 'command', footerFallbackMode: 'custom', footerLayout: validLayout }, readiness: READY, userItems: EMPTY_ITEMS })
  assert.equal(result.mode, 'custom')
  assert.ok(result.layout !== undefined)
  assert.deepEqual(result.notices, [TSP_FOOTER_NOTICES.commandFallback])
})

test('whole-footer command with an INVALID custom fallback degrades to the default with both notices, once each', () => {
  const result = resolveTspNativeFooterConfig({ doc: { footer: 'command', footerFallbackMode: 'custom', footerLayout: { schemaVersion: 1, rows: [] } }, readiness: READY, userItems: EMPTY_ITEMS })
  assert.equal(result.mode, 'default')
  assert.deepEqual(result.notices, [TSP_FOOTER_NOTICES.invalidLayout, TSP_FOOTER_NOTICES.commandFallback],
    'the fixed order: invalid-layout before the command notice')
})

test('a non-default persisted separator is noticed once and never strips rows', () => {
  const layout = {
    schemaVersion: 1,
    rows: [
      { left: [{ id: 'cwd' }], right: [], separator: { text: ' · ' } },
      { left: [{ id: 'git-branch' }], right: [], separator: { text: ' | ' } },
    ],
  }
  const result = resolveTspNativeFooterConfig({ doc: { footer: 'custom', footerLayout: layout }, readiness: READY, userItems: EMPTY_ITEMS })
  assert.equal(result.mode, 'custom')
  assert.ok(result.layout !== undefined && result.layout.rows.length === 2, 'the layout itself is kept')
  assert.deepEqual(result.notices, [TSP_FOOTER_NOTICES.unsupportedSeparator], 'one merged notice, not one per row')
})

test('the native default separator (two spaces) is not a foreign separator', () => {
  const layout = { schemaVersion: 1, rows: [{ left: [{ id: 'cwd' }], right: [], separator: { text: '  ' } }] }
  const result = resolveTspNativeFooterConfig({ doc: { footer: 'custom', footerLayout: layout }, readiness: READY, userItems: EMPTY_ITEMS })
  assert.deepEqual(result.notices, [])
})

test('notices are deduplicated when several sources would repeat the same text', () => {
  const userItems = { items: [], invalidCount: 1 }
  const layout = { schemaVersion: 1, rows: [{ left: [{ id: 'cwd' }], right: [], separator: { text: '|' } }] }
  const result = resolveTspNativeFooterConfig({ doc: { footer: 'command', footerFallbackMode: 'custom', footerLayout: layout }, readiness: READY, userItems })
  assert.deepEqual(result.notices, [
    TSP_FOOTER_NOTICES.invalidCustomItems,
    TSP_FOOTER_NOTICES.commandFallback,
    TSP_FOOTER_NOTICES.unsupportedSeparator,
  ], 'each distinct notice appears exactly once')
})

test('the resolver is read-only: the settings document and the user items are not mutated', () => {
  const doc = { footer: 'custom', footerFallbackMode: 'compact', footerLayout: JSON.parse(JSON.stringify(validLayout)) }
  const userItems = { items: [textItem('user:env', 'prod')], invalidCount: 0 }
  const docSnapshot = JSON.stringify(doc)
  const itemsSnapshot = JSON.stringify(userItems)
  const result = resolveTspNativeFooterConfig({ doc, readiness: READY, userItems })
  assert.equal(JSON.stringify(doc), docSnapshot)
  assert.equal(JSON.stringify(userItems), itemsSnapshot)
  // The projection holds the SAME canonical refs the parser produced — no
  // defensive deep clone that would imply a second settings authority.
  assert.equal(result.userTextItems[0], userItems.items[0])
})
