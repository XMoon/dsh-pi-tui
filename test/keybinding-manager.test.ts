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

test('an ambiguous leader sequence is never advertised (review round 3)', () => {
  // Two actions bound to the SAME completing key: neither fires, so
  // neither may be advertised by keyHint. (app.session.* have no default
  // keys, so the leader sequence is their ONLY key — a clean probe.)
  const manager = managerWith({
    leader: 'ctrl+x',
    bindings: {
      'app.session.new': '<leader>n',
      'app.session.resume': '<leader>n',
    },
  })
  assert.equal(manager.keyHint('app.session.new'), '')
  assert.equal(manager.keyHint('app.session.resume'), '')
  assert.ok(manager.diagnosticsList().some(message => message.includes('ambiguous leader sequence')))
  // The leader machine itself carries no bindings.
  assert.deepEqual(manager.leaderMachine()?.leaderBindings ?? [], [])
})

test('matches() reflects a remap of a configurable action; matchesDefault() stays on defaults', () => {
  // Review finding: the search TOGGLE (app.transcript.search) is
  // configurable, so the overlay handler must match the EFFECTIVE keys
  // (matches), while the non-configurable overlay keys (close/next/
  // previous) keep their default matching (matchesDefault).
  const manager = managerWith({ 'app.transcript.search': 'ctrl+x' })
  assert.ok(manager.matches('\x18', 'app.transcript.search'), 'the remapped toggle must match')
  assert.ok(!manager.matches('\x06', 'app.transcript.search'), 'the old default must no longer match')
  assert.ok(manager.matchesDefault('\x1b', 'app.transcript.search.close'), 'the fixed overlay keys keep their defaults')
  assert.ok(manager.matchesDefault('\r', 'app.transcript.search.next'), 'the fixed overlay keys keep their defaults')
  assert.ok(manager.matchesDefault('\x1b[13;2u', 'app.transcript.search.previous'), 'the fixed overlay keys keep their defaults')
})

test('a leader-only action appears in the snapshot with its leader sequence (review round)', () => {
  // Review finding: an action with NO default keys configured only as
  // `<leader>X` (e.g. app.session.new) was advertised by keyHint but
  // absent from the /keybindings table. The snapshot now includes it with
  // the leader flag so the table renders `Leader N`.
  const manager = managerWith({
    leader: 'ctrl+x',
    bindings: { 'app.session.new': '<leader>n' },
  })
  const binding = manager.snapshot().bindings.find(entry => entry.action === 'app.session.new')
  assert.ok(binding !== undefined, 'the leader-only action must appear in the snapshot')
  assert.equal(binding!.leader, true, 'the leader-only binding is flagged for display')
  assert.deepEqual(binding!.keys, ['n'], 'the raw completing key is carried')
  assert.equal(manager.keyHint('app.session.new'), 'Leader N', 'keyHint and snapshot agree')
})
