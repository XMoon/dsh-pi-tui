/**
 * The HostKeybindingManager contract (review round 2): a DISABLED action
 * (user `false`) is never advertised — keyHint returns nothing and the
 * snapshot drops it, whether the action was direct-bound or leader-bound.
 * @module @xmoon76/dsh-pi-tui/keybinding-manager.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { parseUserKeybindings } from '../../src/tui/keybindings/config.ts'
import { deriveKeybindingContext } from '../../src/tui/keybindings/context.ts'
import { HostKeybindingManager } from '../../src/tui/keybindings/manager.ts'

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
  // neither may be advertised by keyHint. (app.transcript.toggleFullscreen
  // and app.tasks.open are configurable actions whose <leader>n is a
  // leader-only trigger — a clean probe.)
  const manager = managerWith({
    leader: 'ctrl+x',
    bindings: {
      'app.transcript.toggleFullscreen': '<leader>n',
      'app.tasks.open': '<leader>n',
    },
  })
  assert.equal(manager.keyHint('app.transcript.toggleFullscreen'), '')
  // app.tasks.open keeps its SEPARATE down affordance (a composition key,
  // not the ambiguous leader — convergence §4.5/§6.5: leader bindings are
  // additive triggers, never a predicate bypass).
  assert.equal(manager.keyHint('app.tasks.open'), 'Down')
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

test('the default transcript search actions resolve to distinct View and Full scopes', () => {
  const manager = managerWith({})
  const context = deriveKeybindingContext()
  assert.equal(manager.resolve('\x06', context)?.action, 'app.transcript.search.view')
  assert.equal(manager.resolve('\x1b[102;6u', context)?.action, 'app.transcript.search')
  assert.deepEqual(manager.keysFor('app.transcript.search.view'), ['ctrl+f'])
  assert.deepEqual(manager.keysFor('app.transcript.search'), ['ctrl+shift+f'])
  assert.equal(manager.keyHint('app.transcript.search.view'), 'Ctrl+F')
  assert.equal(manager.keyHint('app.transcript.search'), 'Ctrl+Shift+F')
})

test('a stored Full Ctrl+F override shadows the View builtin and remains Full', () => {
  const manager = managerWith({ 'app.transcript.search': 'ctrl+f' })
  assert.equal(manager.resolve('\x06', deriveKeybindingContext())?.action, 'app.transcript.search')
  assert.deepEqual(manager.keysFor('app.transcript.search.view'), [])
  assert.deepEqual(manager.keysFor('app.transcript.search'), ['ctrl+f'])
  assert.ok(!manager.matches('\x1b[102;6u', 'app.transcript.search'),
    'a replaced Full default is not fabricated as a fallback')
})

test('a remapped Full trigger coexists with default View and a disabled Full leaves View active', () => {
  const remapped = managerWith({ 'app.transcript.search': 'alt+s' })
  assert.equal(remapped.resolve('\x1b[115;3u', deriveKeybindingContext())?.action, 'app.transcript.search')
  assert.equal(remapped.resolve('\x06', deriveKeybindingContext())?.action, 'app.transcript.search.view')
  assert.ok(!remapped.matches('\x1b[102;6u', 'app.transcript.search'))

  const disabled = managerWith({ 'app.transcript.search': false })
  assert.equal(disabled.resolve('\x06', deriveKeybindingContext())?.action, 'app.transcript.search.view')
  assert.equal(disabled.resolve('\x1b[102;6u', deriveKeybindingContext()), undefined)
})

test('same-chord user overrides conflict without last-write routing', () => {
  const manager = managerWith({
    'app.transcript.search': 'ctrl+y',
    'app.transcript.search.view': 'ctrl+y',
  })
  assert.equal(manager.resolve('\x19', deriveKeybindingContext()), undefined)
  assert.ok(manager.diagnosticsList().some(message => message.includes('conflict')))
})

test('safe mode restores the distinct builtin search winners', () => {
  const manager = managerWith({ 'app.transcript.search': 'ctrl+f' })
  manager.setSafeMode(true)
  assert.equal(manager.resolve('\x06', deriveKeybindingContext())?.action, 'app.transcript.search.view')
  assert.equal(manager.resolve('\x1b[102;6u', deriveKeybindingContext())?.action, 'app.transcript.search')
})
test('a leader-only action appears in the snapshot with its leader sequence (review round)', () => {
  // Review finding: an action with NO default keys configured only as
  // `<leader>X` (e.g. app.transcript.toggleFullscreen) was advertised by
  // keyHint but absent from the /keybindings table. The snapshot now
  // includes it with the leader flag so the table renders `Leader N`.
  const manager = managerWith({
    leader: 'ctrl+x',
    bindings: { 'app.transcript.toggleFullscreen': '<leader>n' },
  })
  const binding = manager.snapshot().bindings.find(entry => entry.action === 'app.transcript.toggleFullscreen')
  assert.ok(binding !== undefined, 'the leader-only action must appear in the snapshot')
  assert.deepEqual(binding!.keys, [], 'no direct keys')
  assert.deepEqual(binding!.leaderKeys, ['n'], 'the raw completing key is carried')
  assert.equal(manager.keyHint('app.transcript.toggleFullscreen'), 'Leader N', 'keyHint and snapshot agree')
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
  assert.equal(manager.keysLabelFor('app.transcript.search.close'), 'Esc / Ctrl+C',
    'search close advertises its full default set (the overlay Input swallows Ctrl+C otherwise)')
  assert.equal(manager.keysLabelFor('app.transcript.search.next'), 'Enter')
  assert.equal(manager.keysLabelFor('app.transcript.search.scope'), 'Tab')
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
  // Round 37: a leader-only declaration REPLACES the builtin default —
  // the deduped leader is the ONLY trigger (no Ctrl+R advertised).
  assert.equal(manager.keyHint('app.history.search'), 'Leader H', 'the leader-only declaration replaced the builtin Ctrl+R')
  // Two DIFFERENT actions on the same completing key are still ambiguous.
  const ambiguous = managerWith({
    leader: 'ctrl+x',
    bindings: {
      'app.history.search': '<leader>h',
      'app.transcript.toggleFullscreen': '<leader>h',
    },
  })
  assert.ok(ambiguous.diagnosticsList().some(message => message.includes('ambiguous')), 'cross-action same-key stays ambiguous')
  assert.deepEqual(ambiguous.leaderKeysFor('app.history.search'), [], 'ambiguous actions advertise no leader key')
})
