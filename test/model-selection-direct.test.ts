/** Direct owner tests for Agent-local model-selection isolation. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectModelSelectionOwner } from '../src/runtime/direct/model-selection-direct.ts'

function fakeAgent(events: readonly unknown[], header: unknown) {
  const appended: unknown[] = []
  const agent = {
    ctx: { on: () => () => {} },
    session: {
      events,
      requestHeader: () => header,
      append: (type: string, data: unknown) => { appended.push({ type, data }) },
    },
  }
  return { agent, appended }
}

const request = (provider: string, model: string, reasoningEffort: string, adapterDefault = false) => ({
  type: 'request/header',
  data: {
    header: {
      config: { provider, model, reasoningEffort },
      ...(adapterDefault ? { adapterDefaults: { reasoningEffort: true } } : {}),
    },
  },
})

test('each Agent gets an independent installed selection and resumed history wins over the global default', () => {
  const owner = new DirectModelSelectionOwner({
    currentSelection: () => ({ provider: 'global', model: 'default', reasoningEffort: 'low' as never }),
  })
  const first = fakeAgent([request('provider-a', 'model-a', 'high')], {
    config: { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' },
  })
  const second = fakeAgent([request('provider-b', 'model-b', 'max')], {
    config: { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' },
  })

  const firstSelection = owner.installForAgent(first.agent as never)
  const secondSelection = owner.installForAgent(second.agent as never)
  assert.notEqual(firstSelection, secondSelection)
  assert.deepEqual(firstSelection.current, { provider: 'provider-a', model: 'model-a', reasoningEffort: 'high' })
  assert.deepEqual(secondSelection.current, { provider: 'provider-b', model: 'model-b', reasoningEffort: 'max' })
})

test('an Agent without history reads the current global default dynamically', () => {
  let fallback = { provider: 'global', model: 'old-default' }
  const owner = new DirectModelSelectionOwner({ currentSelection: () => fallback })
  const empty = fakeAgent([], undefined)
  const selection = owner.installForAgent(empty.agent as never)
  assert.deepEqual(selection.current, fallback)
  fallback = { provider: 'global', model: 'new-default' }
  assert.deepEqual(selection.current, fallback)
})

test('durable pending intent survives until its exact request header and then falls back to the logged value', () => {
  const owner = new DirectModelSelectionOwner({
    currentSelection: () => ({ provider: 'global', model: 'default' }),
  })
  const pending = fakeAgent([{ type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'high' } }], {
    config: { provider: 'p', model: 'm', reasoningEffort: 'low' },
    adapterDefaults: { reasoningEffort: true },
  })
  const selection = owner.installForAgent(pending.agent as never)
  assert.deepEqual(selection.current, { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal(selection.consume('p', 'm', 'low'), false)
  assert.deepEqual(selection.current, { provider: 'p', model: 'm', reasoningEffort: 'high' })
  assert.equal(selection.consume('p', 'm', 'high'), true)
  assert.deepEqual(selection.current, { provider: 'p', model: 'm' })
})

test('selectForNextRequest appends durable intent before changing only that Agent', () => {
  const owner = new DirectModelSelectionOwner({ currentSelection: () => ({ provider: 'global', model: 'default' }) })
  const first = fakeAgent([], undefined)
  const second = fakeAgent([], undefined)
  owner.installForAgent(first.agent as never)
  owner.installForAgent(second.agent as never)
  owner.selectForNextRequest(first.agent, { provider: 'p', model: 'm', reasoningEffort: 'max' })
  assert.deepEqual(first.appended, [{ type: 'model/selection', data: { provider: 'p', model: 'm', reasoningEffort: 'max' } }])
  assert.deepEqual(owner.current(first.agent), { provider: 'p', model: 'm', reasoningEffort: 'max' })
  assert.deepEqual(owner.current(second.agent), { provider: 'global', model: 'default' })
})
