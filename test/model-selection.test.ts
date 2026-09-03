/** Regression tests for the transport-neutral Session model-selection fold. */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  foldPendingModelSelection,
  rawSelectionFromRequestHeader,
  sameModelSelection,
  selectionFromRequestHeader,
} from '../src/model-selection.ts'

const header = (provider: string, model: string, reasoningEffort?: string, adapterDefault = false) => ({
  config: {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  },
  ...(adapterDefault ? { adapterDefaults: { reasoningEffort: true } } : {}),
})

const request = (value: ReturnType<typeof header>) => ({ type: 'request/header', data: { header: value } })

test('request headers expose raw effort for matching and omit adapter defaults for restore', () => {
  const defaulted = header('p', 'm', 'high', true)
  assert.deepEqual(rawSelectionFromRequestHeader(defaulted), {
    provider: 'p', model: 'm', reasoningEffort: 'high',
  })
  assert.deepEqual(selectionFromRequestHeader(defaulted), { provider: 'p', model: 'm' })
  assert.deepEqual(selectionFromRequestHeader(header('p', 'm', 'high')), {
    provider: 'p', model: 'm', reasoningEffort: 'high',
  })
  assert.deepEqual(selectionFromRequestHeader({
    config: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    adapterDefaults: { reasoningEffort: false },
  }), { provider: 'p', model: 'm', reasoningEffort: 'high' })
})

test('pending selection is consumed only by an exact raw request header', () => {
  const pending = { type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'high' } }
  assert.deepEqual(foldPendingModelSelection([pending, request(header('p', 'm', 'high'))]), {
    lastUsed: { provider: 'p', model: 'm', reasoningEffort: 'high' },
  })
  assert.deepEqual(foldPendingModelSelection([pending, request(header('p', 'm', 'low'))]), {
    pending: { provider: 'p', model: 'm', reasoningEffort: 'high' },
    lastUsed: { provider: 'p', model: 'm', reasoningEffort: 'low' },
  })
})

test('the newest pending selection supersedes an older intent', () => {
  assert.deepEqual(foldPendingModelSelection([
    { type: 'model/selection', data: { provider: 'p', model: 'old' } },
    { type: 'model/selection', data: { provider: 'p', model: 'new', reasoningEffort: 'max' } },
  ]), { pending: { provider: 'p', model: 'new', reasoningEffort: 'max' } })
})

test('legacy sessions use their latest request header and global fallback remains outside the fold', () => {
  assert.deepEqual(foldPendingModelSelection([
    request(header('provider-a', 'model-a', 'high')),
    { type: 'unrelated', data: {} },
  ]), { lastUsed: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' } })
  assert.equal(sameModelSelection(
    { provider: 'p', model: 'm' },
    { provider: 'p', model: 'm', reasoningEffort: undefined },
  ), true)
})

test('malformed selection events cannot poison a valid pending choice', () => {
  const valid = { type: 'model/selection', data: { provider: 'p', model: 'm' } }
  assert.deepEqual(foldPendingModelSelection([
    valid,
    { type: 'model/selection', data: { provider: '', model: 'bad' } },
    { type: 'garbage' },
  ]), { pending: { provider: 'p', model: 'm' } })
})
