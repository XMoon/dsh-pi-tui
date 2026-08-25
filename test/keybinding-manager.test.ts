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
  assert.deepEqual(binding!.keys, [], 'no direct keys')
  assert.deepEqual(binding!.leaderKeys, ['n'], 'the raw completing key is carried')
  assert.equal(manager.keyHint('app.session.new'), 'Leader N', 'keyHint and snapshot agree')
})

test('mixed direct + leader keys both appear in the snapshot and the hint (review round)', () => {
  // Review finding: an action configured as ['ctrl+z', '<leader>h'] showed
  // only the direct key in /keybindings and keyHint — the leader sequence
  // was silently dropped. Both must render, each with its own format.
  const manager = managerWith({
    leader: 'ctrl+x',
    bindings: { 'app.history.search': ['ctrl+z', '<leader>h'] },
  })
  const binding = manager.snapshot().bindings.find(entry => entry.action === 'app.history.search')
  assert.ok(binding !== undefined)
  assert.deepEqual(binding!.keys, ['ctrl+z'], 'the direct key is carried')
  assert.deepEqual(binding!.leaderKeys, ['h'], 'the leader completing key is carried separately')
  assert.equal(manager.keyHint('app.history.search'), 'Ctrl+Z / Leader H', 'the hint shows both forms')
})

test('keysLabelFor shows ALL direct and leader keys (the /help source)', () => {
  // Review finding: /help used keysFor() (direct only) — a mixed
  // ['ctrl+z', '<leader>h'] action showed only the direct key. The
  // manager's keysLabelFor renders every effective form.
  const manager = managerWith({
    leader: 'ctrl+x',
    bindings: {
      'app.history.search': ['ctrl+z', 'ctrl+shift+z', '<leader>h'],
    },
  })
  assert.equal(manager.keysLabelFor('app.history.search'), 'Ctrl+Z / Ctrl+Shift+Z / Leader H')
  // Disabled actions advertise nothing.
  const disabled = managerWith({ 'app.history.search': false })
  assert.equal(disabled.keysLabelFor('app.history.search'), '')
})

test('keysLabelFor falls back to an overlay action default (the /help source)', () => {
  // Review finding: capturing-scope actions (search close/next/previous,
  // question/tasks flows) are excluded from the HOST keymap, so keysFor()
  // is empty and keysLabelFor must render their defaults — /help showed
  // '—' for Enter submission and the fixed overlay controls.
  const manager = managerWith({})
  assert.equal(manager.keysLabelFor('app.input.submit'), 'Enter', 'submit keeps its default label')
  assert.equal(manager.keysLabelFor('app.transcript.search.close'), 'Esc')
  assert.equal(manager.keysLabelFor('app.transcript.search.next'), 'Enter')
  assert.equal(manager.keysLabelFor('app.transcript.search.previous'), 'Shift+Enter')
  // Disabled actions still advertise nothing.
  const disabled = managerWith({ 'app.input.submit': false })
  assert.equal(disabled.keysLabelFor('app.input.submit'), '')
})

test('duplicate leader bindings of the SAME action are not ambiguous (review round)', () => {
  // Review finding: ['<leader>h', '<leader>h'] on ONE action grouped two
  // entries under the same completing key and was flagged ambiguous —
  // neither fired. Identical (action, key) pairs are deduped first.
  const manager = managerWith({
    leader: 'ctrl+x',
    bindings: { 'app.history.search': ['<leader>h', '<leader>h'] },
  })
  assert.ok(!manager.diagnosticsList().some(message => message.includes('ambiguous')), `no ambiguity expected: ${manager.diagnosticsList().join(' | ')}`)
  assert.deepEqual(manager.leaderKeysFor('app.history.search'), ['h'], 'the deduped binding fires')
  assert.equal(manager.keyHint('app.history.search'), 'Ctrl+R / Leader H', 'the default direct key plus the deduped leader')
  // Two DIFFERENT actions on the same completing key are still ambiguous.
  const ambiguous = managerWith({
    leader: 'ctrl+x',
    bindings: {
      'app.history.search': '<leader>h',
      'app.session.new': '<leader>h',
    },
  })
  assert.ok(ambiguous.diagnosticsList().some(message => message.includes('ambiguous')), 'cross-action same-key stays ambiguous')
  assert.deepEqual(ambiguous.leaderKeysFor('app.history.search'), [], 'ambiguous actions advertise no leader key')
})
