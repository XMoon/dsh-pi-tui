/**
 * The HostKeybindingManager contract (review round 2): a DISABLED action
 * (user `false`) is never advertised — keyHint returns nothing and the
 * snapshot drops it, whether the action was direct-bound or leader-bound.
 * @module @xmoon76/dsh-pi-tui/keybinding-manager.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { HostKeybindingManager } from '../src/keybindings/manager.ts'

function managerWith(config: Record<string, unknown>): HostKeybindingManager {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(config)
  manager.setUserConfiguration(parsed)
  return manager
}

test('a disabled direct-bound action advertises no hint and no snapshot entry', () => {
  const manager = managerWith({ 'app.input.steer': false })
  assert.equal(manager.keyHint('app.input.steer'), '')
  const snapshot = manager.snapshot()
  assert.ok(!snapshot.bindings.some(binding => binding.action === 'app.input.steer'),
    'a disabled action must not appear in the snapshot')
})

test('a disabled leader-bound action advertises no hint', () => {
  const manager = managerWith({
    leader: 'ctrl+x',
    'app.tasks.open': false,
  })
  assert.equal(manager.keyHint('app.tasks.open'), '')
  const snapshot = manager.snapshot()
  assert.ok(!snapshot.bindings.some(binding => binding.action === 'app.tasks.open'))
})

test('an enabled action keeps its hint and snapshot entry', () => {
  const manager = managerWith({ 'app.input.steer': 'ctrl+x' })
  assert.equal(manager.keyHint('app.input.steer'), 'Ctrl+X')
  const snapshot = manager.snapshot()
  const steer = snapshot.bindings.find(binding => binding.action === 'app.input.steer')
  assert.ok(steer !== undefined)
  assert.deepEqual(steer.keys, ['ctrl+x'])
})

test('safe mode restores the advertised defaults for a disabled action', () => {
  const manager = managerWith({ 'app.input.steer': false })
  manager.setSafeMode(true)
  assert.equal(manager.keyHint('app.input.steer'), 'Ctrl+S')
  const snapshot = manager.snapshot()
  assert.ok(snapshot.bindings.some(binding => binding.action === 'app.input.steer'))
})
