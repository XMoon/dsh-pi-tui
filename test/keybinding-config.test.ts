/**
 * The user config validation contract (plan §13/§14/§21): valid scalar,
 * valid list, false, unknown id, invalid key, duplicate values, printable
 * Host-global rejection, leader sequences.
 * @module @xmoon76/dsh-pi-tui/keybinding-config.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidKeyId, isPlainPrintableKey, LEADER_PREFIX, parseUserKeybindings } from '../src/keybindings/config.ts'

test('KeyId validation accepts the fork grammar', () => {
  assert.ok(isValidKeyId('ctrl+s'))
  assert.ok(isValidKeyId('ctrl+shift+f'))
  assert.ok(isValidKeyId('alt+up'))
  assert.ok(isValidKeyId('pageUp'))
  assert.ok(isValidKeyId('f5'))
  assert.ok(isValidKeyId('super+1'))
  assert.ok(isValidKeyId('ctrl+-'))
  assert.ok(!isValidKeyId(''))
  assert.ok(!isValidKeyId('ctrl'))
  assert.ok(!isValidKeyId('ctrl+ctrl+s'))
  assert.ok(!isValidKeyId('ctrl+foo'))
  assert.ok(!isValidKeyId('ctrl+shift+'))
})

test('plain printable detection', () => {
  assert.ok(isPlainPrintableKey('a'))
  assert.ok(isPlainPrintableKey('1'))
  assert.ok(isPlainPrintableKey('/'))
  assert.ok(!isPlainPrintableKey('ctrl+a'))
  assert.ok(!isPlainPrintableKey('shift+tab'))
  assert.ok(!isPlainPrintableKey('enter'))
})

test('valid scalar', () => {
  const parsed = parseUserKeybindings({ 'app.input.steer': 'ctrl+x' })
  assert.deepEqual(parsed.bindings, { 'app.input.steer': 'ctrl+x' })
  assert.deepEqual(parsed.diagnostics, [])
})

test('valid list', () => {
  const parsed = parseUserKeybindings({ 'app.permission.cycle': ['shift+tab', 'ctrl+shift+p'] })
  assert.deepEqual(parsed.bindings, { 'app.permission.cycle': ['shift+tab', 'ctrl+shift+p'] })
})

test('false disables the action', () => {
  const parsed = parseUserKeybindings({ 'app.transcript.toggleThinking': false })
  assert.deepEqual(parsed.bindings, { 'app.transcript.toggleThinking': false })
})

test('unknown action → diagnostic + ignore', () => {
  const parsed = parseUserKeybindings({ 'app.foo.bar': 'ctrl+x', 'app.input.steer': 'ctrl+s' })
  assert.deepEqual(parsed.bindings, { 'app.input.steer': 'ctrl+s' })
  assert.equal(parsed.diagnostics.length, 1)
  assert.ok(parsed.diagnostics[0]!.includes('unknown action'))
})

test('invalid key → diagnostic + ignore', () => {
  const parsed = parseUserKeybindings({ 'app.input.steer': 'ctrl+zzz' })
  assert.deepEqual(parsed.bindings, {})
  assert.equal(parsed.diagnostics.length, 1)
  assert.ok(parsed.diagnostics[0]!.includes('invalid key'))
})

test('duplicate values in one action are deduplicated by the keymap', () => {
  const parsed = parseUserKeybindings({ 'app.input.steer': ['ctrl+s', 'ctrl+s'] })
  assert.deepEqual(parsed.bindings, { 'app.input.steer': ['ctrl+s', 'ctrl+s'] })
  // The keymap dedupes at rule level (keysFor returns unique keys).
})

test('plain printable bound to a Host action → rejected', () => {
  const parsed = parseUserKeybindings({ 'app.todo.toggle': 'x' })
  assert.deepEqual(parsed.bindings, {})
  assert.equal(parsed.diagnostics.length, 1)
  assert.ok(parsed.diagnostics[0]!.includes('text-producing'))
})

test('non-configurable action → rejected', () => {
  const parsed = parseUserKeybindings({ 'question.confirm': 'ctrl+m' })
  assert.deepEqual(parsed.bindings, {})
  assert.ok(parsed.diagnostics[0]!.includes('not user-configurable'))
})

test('malformed value → diagnostic + ignore', () => {
  const parsed = parseUserKeybindings({ 'app.input.steer': 42 })
  assert.deepEqual(parsed.bindings, {})
  assert.equal(parsed.diagnostics.length, 1)
})

test('non-object config → diagnostic + empty result', () => {
  const parsed = parseUserKeybindings('nope')
  assert.deepEqual(parsed.bindings, {})
  assert.equal(parsed.diagnostics.length, 1)
})

test('leader key + leader sequences parse', () => {
  const parsed = parseUserKeybindings({
    leader: 'ctrl+x',
    bindings: {
      'app.tasks.open': `${LEADER_PREFIX}t`,
      'app.history.search': `${LEADER_PREFIX}r`,
    },
  })
  assert.equal(parsed.leader?.key, 'ctrl+x')
  assert.deepEqual(parsed.leaderBindings, [
    { action: 'app.tasks.open', key: 't' },
    { action: 'app.history.search', key: 'r' },
  ])
  // Round 37: a LEADER-ONLY declaration emits an EMPTY-ARRAY marker per
  // action — the effective keymap sees a user declaration and REPLACES
  // the builtin default (the unified override contract: any declaration
  // replaces the builtin; only `false` removes every trigger).
  assert.deepEqual(parsed.bindings, {
    'app.tasks.open': [],
    'app.history.search': [],
  })
})

test('leader sequences without a leader key are inert with a diagnostic', () => {
  // Review round 39: a missing leader makes the sequences inert
  // (fail-soft) — the action must fall back to its builtin default. The
  // empty-array marker must NOT be left behind: a diagnosed-and-ignored
  // config must not suppress the builtin (app.todo.toggle's builtin
  // Ctrl+T survives).
  const parsed = parseUserKeybindings({ 'app.todo.toggle': `${LEADER_PREFIX}t` })
  assert.deepEqual(parsed.bindings, {}, 'no empty-array marker — the builtin survives')
  assert.deepEqual(parsed.leaderBindings, [])
  assert.equal(parsed.diagnostics.length, 1)
  assert.ok(parsed.diagnostics[0]!.includes('no "leader" key'))
})

test('an invalid leader key leaves leader-only actions on their builtin defaults', () => {
  // Review round 39: a leader that fails validation (text-producing,
  // runtime-unbindable, terminal-ambiguous) is diagnosed and ignored —
  // the same fail-soft contract as a missing leader: no empty-array
  // marker, the builtin survives.
  for (const badLeader of ['shift+a', 'shift+f5', 'ctrl+[']) {
    const parsed = parseUserKeybindings({ leader: badLeader, 'app.todo.toggle': `${LEADER_PREFIX}t` })
    assert.deepEqual(parsed.bindings, {}, `leader "${badLeader}" must not leave a marker`)
    assert.deepEqual(parsed.leaderBindings, [])
    assert.ok(parsed.diagnostics.some(message => message.includes('invalid leader key')),
      `no leader diagnostic for "${badLeader}": ${parsed.diagnostics.join(' | ')}`)
  }
})

test('a valid leader keeps the empty-array marker for leader-only actions', () => {
  // Review round 39: only a VALID leader prefix earns the marker — the
  // leader-only declaration then REPLACES the builtin (round 37 unified
  // contract). A leader that is valid at parse time but dead at runtime
  // (collision/ambiguity) keeps the marker and stays inert — no
  // fabricated fallback (covered by the manager/integration tests).
  const parsed = parseUserKeybindings({ leader: 'ctrl+x', 'app.todo.toggle': `${LEADER_PREFIX}t` })
  assert.deepEqual(parsed.bindings, { 'app.todo.toggle': [] })
  assert.equal(parsed.leader?.key, 'ctrl+x')
  assert.deepEqual(parsed.leaderBindings, [{ action: 'app.todo.toggle', key: 't' }])
})

test('invalid leader sequence → diagnostic + ignore', () => {
  const parsed = parseUserKeybindings({ leader: 'ctrl+x', 'app.tasks.open': `${LEADER_PREFIX}zzz` })
  assert.deepEqual(parsed.leaderBindings, [])
  assert.equal(parsed.diagnostics.length, 1)
})

test('a plain printable leader key is rejected (it would swallow typing)', () => {
  // Review finding: the leader machine consumes its key while idle, so a
  // printable leader (e.g. `t`) would swallow every typed `t` — the same
  // rule as a direct printable binding applies to the leader key.
  const parsed = parseUserKeybindings({ leader: 't', 'app.tasks.open': `${LEADER_PREFIX}x` })
  assert.equal(parsed.leader, undefined)
  assert.deepEqual(parsed.leaderBindings, [])
  assert.ok(parsed.diagnostics.some(message => message.includes('invalid leader key')))
  // A modifier chord stays a valid leader.
  const chord = parseUserKeybindings({ leader: 'ctrl+x', 'app.tasks.open': `${LEADER_PREFIX}x` })
  assert.equal(chord.leader?.key, 'ctrl+x')
  assert.equal(chord.leaderBindings.length, 1)
})

test('the space key is printable: rejected as a leader and as a direct binding', () => {
  // Review finding: `space` is the fork alias for the spacebar (char 32),
  // so a bare `space` leader or Host binding would swallow every typed
  // space — the printable check must cover it, not just single chars.
  const asLeader = parseUserKeybindings({ leader: 'space', 'app.tasks.open': `${LEADER_PREFIX}x` })
  assert.equal(asLeader.leader, undefined)
  assert.deepEqual(asLeader.leaderBindings, [])
  assert.ok(asLeader.diagnostics.some(message => message.includes('invalid leader key')))
  const asBinding = parseUserKeybindings({ 'app.todo.toggle': 'space' })
  assert.deepEqual(asBinding.bindings, {})
  assert.ok(asBinding.diagnostics.some(message => message.includes('text-producing key')))
  // A MODIFIED space stays bindable (ctrl+space is a chord, not typing).
  const chord = parseUserKeybindings({ 'app.todo.toggle': 'ctrl+space' })
  assert.deepEqual(chord.bindings, { 'app.todo.toggle': 'ctrl+space' })
})

test('legacy terminal collisions are REJECTED bindings', () => {
  // Convergence §4.5: a key indistinguishable from a lifecycle key on
  // legacy terminals is unsupported — rejected with a diagnostic.
  for (const key of ['ctrl+[', 'ctrl+j', 'ctrl+m']) {
    const parsed = parseUserKeybindings({ 'app.todo.toggle': key })
    assert.deepEqual(parsed.bindings, {}, `"${key}" must be rejected`)
    assert.ok(parsed.diagnostics.some(message => message.includes('legacy terminals') || message.includes('collides')),
      `no rejection diagnostic for "${key}": ${parsed.diagnostics.join(' | ')}`)
  }
})

test('nested bindings map merges with top-level entries', () => {
  const parsed = parseUserKeybindings({
    'app.input.steer': 'ctrl+s',
    bindings: { 'app.todo.toggle': 'ctrl+shift+t' },
  })
  assert.deepEqual(parsed.bindings, {
    'app.input.steer': 'ctrl+s',
    'app.todo.toggle': 'ctrl+shift+t',
  })
})

test('a duplicate action declaration is a diagnostic, never last-write-wins', () => {
  // Review round 1: the same action at the top level AND in `bindings`
  // must not silently overwrite — the FIRST declaration wins.
  const parsed = parseUserKeybindings({
    'app.input.steer': 'ctrl+s',
    bindings: { 'app.input.steer': 'ctrl+y' },
  })
  assert.deepEqual(parsed.bindings, { 'app.input.steer': 'ctrl+s' })
  assert.equal(parsed.diagnostics.length, 1)
  assert.ok(parsed.diagnostics[0]!.includes('declared more than once'))
})

test('false disables a leader sequence for the same action', () => {
  // Review round 1: `false` must win over a `<leader>X` binding of the
  // same action (the manager filters disabled actions out of the leader
  // machine).
  const parsed = parseUserKeybindings({
    leader: 'ctrl+x',
    'app.tasks.open': false,
    bindings: { 'app.tasks.open': '<leader>t' },
  })
  assert.deepEqual(parsed.bindings, { 'app.tasks.open': false })
  assert.deepEqual(parsed.leaderBindings, [])
  assert.equal(parsed.diagnostics.length, 1)
  assert.ok(parsed.diagnostics[0]!.includes('declared more than once'))
})

test('a configurable action bound to a fixed overlay key warns (the overlay wins while open)', () => {
  // Review finding: while a capturing overlay is open its non-configurable
  // keys (search close/next/previous, question/tasks flows) win by
  // precedence — a configurable action remapped to one of them is
  // eclipsed inside the overlay. Warned, never dropped: the binding still
  // works outside the overlay.
  const parsed = parseUserKeybindings({ 'app.transcript.search': 'enter' })
  assert.deepEqual(parsed.bindings, { 'app.transcript.search': 'enter' }, 'the binding is kept')
  assert.ok(parsed.diagnostics.some(message => message.includes('non-configurable overlay owns')), `no precedence warning: ${parsed.diagnostics.join(' | ')}`)
  // A non-colliding remap warns nothing.
  const clean = parseUserKeybindings({ 'app.transcript.search': 'ctrl+x' })
  assert.ok(!clean.diagnostics.some(message => message.includes('overlay owns')), `unexpected warning: ${clean.diagnostics.join(' | ')}`)
})
