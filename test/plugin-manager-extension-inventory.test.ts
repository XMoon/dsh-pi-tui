/**
 * TUI extension observation projection tests (P1-A1.4): the read-only
 * aggregation over the shared runtime's own health records. It must report
 * detached owner facts, never a second inventory, and must carry the exact
 * owning Loader entry id when the runtime can prove it.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-extension-inventory.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { extensionOwnerName, observeTuiExtensions } from '../src/plugin-manager/extension-inventory.ts'

test('aggregates contributions per owner with health and capability use', () => {
  const observations = observeTuiExtensions({
    healthSnapshot: () => [
      { id: 'a', owner: '1:alpha', extensionPoint: 'chrome.footer.item', state: 'active' },
      { id: 'b', owner: '1:alpha', extensionPoint: 'chrome.header.badge', state: 'failed' },
      { id: 'c', owner: '2:beta', extensionPoint: 'advanced.input.capture', state: 'active' },
      { id: 'd', owner: '3:gamma', extensionPoint: 'unstable.input.raw', state: 'failed' },
    ],
    ownerEntryIds: () => new Map([['1:alpha', 'entry-alpha']]),
  })
  assert.deepEqual(observations.map(item => item.ownerName), ['alpha', 'beta', 'gamma'])
  const alpha = observations[0]!
  assert.equal(alpha.contributionCount, 2)
  assert.deepEqual([...alpha.contributionKinds], ['chrome.footer.item', 'chrome.header.badge'])
  assert.equal(alpha.health, 'mixed')
  assert.equal(alpha.entryId, 'entry-alpha')
  assert.equal(observations[1]!.usesAdvancedCapability, true)
  assert.equal(observations[1]!.entryId, undefined)
  assert.equal(observations[2]!.usesUnstableCapability, true)
  assert.equal(observations[2]!.health, 'failed')
  assert.ok(Object.isFrozen(observations[0]))
})

test('extensionOwnerName strips only the uid prefix', () => {
  assert.equal(extensionOwnerName('12:@scope/pkg'), '@scope/pkg')
  assert.equal(extensionOwnerName('plain'), 'plain')
})
