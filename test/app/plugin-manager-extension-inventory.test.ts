/**
 * TUI extension observation projection tests (P1-A1.4): the read-only
 * aggregation over the shared runtime's own health records. It must report
 * detached owner facts, never a second inventory, and must carry the exact
 * owning Loader entry id when the runtime can prove it.
 * @module @xmoon76/dsh-pi-tui/plugin-manager-extension-inventory.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyCurrentClientPluginStatus, observeTuiExtensions } from '../../src/app/plugin-manager/extension-inventory.ts'

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
  assert.deepEqual(observations.map(item => item.owner), ['1:alpha', '2:beta', '3:gamma'])
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

test('classifies the CURRENT Client ./tui status without deriving it from Host enabled', () => {
  const active = [{ packageName: '@r8/a', phase: 'active' as const, entryId: 'client-a', configRevision: 2 }]
  assert.deepEqual(classifyCurrentClientPluginStatus('@r8/a', true, true, active), {
    status: 'ACTIVE',
    label: 'Active',
    entryId: 'client-a',
    configRevision: 2,
  })
  // Host selected but Client failed/reloading is still reported independently.
  assert.equal(classifyCurrentClientPluginStatus('@r8/a', true, true, [{ ...active[0]!, phase: 'error', reason: 'apply failed' }]).status, 'ERROR')
  assert.equal(classifyCurrentClientPluginStatus('@r8/a', true, true, [{ ...active[0]!, phase: 'reload-required' }]).status, 'RELOAD_REQUIRED')
  assert.equal(classifyCurrentClientPluginStatus('@r8/a', true, true, [{ ...active[0]!, phase: 'pending' }]).status, 'PENDING')
  // No observation: a normal Host plugin is NOT opted in, never an error.
  assert.equal(classifyCurrentClientPluginStatus('@r8/plain', true, true, []).status, 'NOT_OPTED_IN')
  assert.equal(classifyCurrentClientPluginStatus('@r8/plain', true, false, []).status, 'NOT_SELECTED')
  assert.equal(classifyCurrentClientPluginStatus('@r8/missing', false, true, []).status, 'UNAVAILABLE')
  // Two live observations for one bundle name are unavailable, not a guess.
  assert.equal(classifyCurrentClientPluginStatus('@r8/a', true, true, [active[0]!, { ...active[0]!, entryId: 'client-b' }]).status, 'UNAVAILABLE')
})
