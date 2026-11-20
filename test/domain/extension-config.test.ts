/** Pure per-package extension-config projection and row-id contract evidence. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extensionConfigRowId } from '../../src/domain/extension-config/row-id.ts'
import {
  extensionConfigUserDataPresent,
  projectExtensionConfigData,
} from '../../src/domain/extension-config/data.ts'

test('the single row-id rule hashes the exact UTF-8 package name into 32 lowercase hex characters', () => {
  assert.equal(extensionConfigRowId('@r8-pr1-fixture/a'), 'pi-tui-extcfg-d7fa9de1d5de190a92d683a273637c09')
  assert.equal(extensionConfigRowId('@r8-pr1-fixture/b'), 'pi-tui-extcfg-108a6d566a5644018065668ae0539701')
  assert.match(extensionConfigRowId('@scope/pkg'), /^pi-tui-extcfg-[0-9a-f]{32}$/u)
  assert.notEqual(extensionConfigRowId('@scope/pkg'), extensionConfigRowId('@scope/other'))
})

test('absent, null, false, zero and array data projections keep their exact identity', () => {
  assert.deepEqual(projectExtensionConfigData(undefined), { kind: 'ok', value: undefined })
  assert.deepEqual(projectExtensionConfigData({}), { kind: 'ok', value: undefined })
  assert.deepEqual(projectExtensionConfigData({ data: null }), { kind: 'ok', value: null })
  assert.deepEqual(projectExtensionConfigData({ data: false }), { kind: 'ok', value: false })
  assert.deepEqual(projectExtensionConfigData({ data: 0 }), { kind: 'ok', value: 0 })
  assert.deepEqual(projectExtensionConfigData({ data: [1, 'two', null] }), { kind: 'ok', value: [1, 'two', null] })
  assert.deepEqual(projectExtensionConfigData({ data: { nested: { flag: true } } }), { kind: 'ok', value: { nested: { flag: true } } })
})

test('the projection is a detached owned tree', () => {
  const source = { data: { nested: { list: [1, 2] } } }
  const projected = projectExtensionConfigData(source)
  assert.equal(projected.kind, 'ok')
  if (projected.kind !== 'ok') return
  ;(projected.value as { nested: { list: number[] } }).nested.list.push(3)
  assert.deepEqual(source, { data: { nested: { list: [1, 2] } } })
})

test('non-JSON values are invalid rather than silently coerced', () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  for (const value of [new Date(), 1n, Number.NaN, Number.POSITIVE_INFINITY, () => 1, circular, new Map()]) {
    assert.equal(projectExtensionConfigData({ data: value }).kind, 'invalid', String(value))
  }
})

test('userDataPresent is own-field presence at data, never value inequality', () => {
  assert.equal(extensionConfigUserDataPresent({ data: undefined }), true)
  assert.equal(extensionConfigUserDataPresent({ data: null }), true)
  assert.equal(extensionConfigUserDataPresent({ data: false }), true)
  assert.equal(extensionConfigUserDataPresent({}), false)
  assert.equal(extensionConfigUserDataPresent(undefined), false)
  assert.equal(extensionConfigUserDataPresent([]), false)
})
