/**
 * The model-selection owner's in-flight marker follows the SESSION owner, not
 * the in-process Agent (M4-B2-S external review P2).
 *
 * On the split Remote Client there is a live Session and no Direct Agent object.
 * A `/model` write on that active Session records `setPending(...)`; the footer
 * marker must then read that pending/unconfirmed state instead of falling back
 * to the sessionless default intent.
 *
 * @module @xmoon76/dsh-pi-tui/model-selection-owner.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelSelectionOwner } from '../../src/app/command/model-selection.ts'
import type { ModelSelectionValue } from '../../src/domain/session/model-selection.ts'

const SELECTION: ModelSelectionValue = { provider: 'provider', model: 'model' }

function createOwner(options: { readonly liveAgent: boolean; readonly hasSession: boolean; readonly generation?: () => number }) {
  return createModelSelectionOwner<ModelSelectionValue>({
    liveAgent: () => options.liveAgent ? { session: { id: 'session-a' } } : undefined,
    hasSession: () => options.hasSession,
    generation: options.generation ?? (() => 1),
    currentDefault: () => undefined,
    currentOf: () => SELECTION,
    setCurrentOf: () => {},
  })
}

test('an active Remote Session (no in-process Agent) shows its pending model marker', () => {
  const owner = createOwner({ liveAgent: false, hasSession: true })
  assert.equal(owner.currentMarker(), undefined, 'no marker before the write starts')
  owner.setPending(SELECTION, 7)
  assert.deepEqual(owner.currentMarker(), { selection: SELECTION, status: 'pending' })
  owner.setPending(SELECTION, 8, 'unresolved')
  assert.deepEqual(owner.currentMarker(), { selection: SELECTION, status: 'unresolved' })
})

test('a sessionless surface does not leak a pending Session marker into the default-intent branch', () => {
  const owner = createOwner({ liveAgent: false, hasSession: false })
  owner.setPending(SELECTION, 7)
  assert.equal(owner.currentMarker(), undefined)
})

test('the marker stays generation-fenced', () => {
  let generation = 1
  const owner = createOwner({ liveAgent: false, hasSession: true, generation: () => generation })
  owner.setPending(SELECTION, 7)
  assert.notEqual(owner.currentMarker(), undefined)
  generation = 2
  assert.equal(owner.currentMarker(), undefined)
})
