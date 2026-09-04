/**
 * The leader / multi-key sequence contract (plan §6 M6): pending prefix
 * state, timeout, ambiguous prefix, cancel, paste/typing isolation, and
 * focus-transition cancellation.
 * @module @xmoon76/dsh-pi-tui/keybinding-leader.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { LeaderStateMachine } from '../src/keybindings/leader.ts'
import type { LeaderBinding, LeaderConfig } from '../src/keybindings/types.ts'

const CONFIG: LeaderConfig = { key: 'ctrl+x', timeoutMs: 1000 }
const BINDINGS: readonly LeaderBinding[] = [
  { action: 'app.tasks.open', key: 't' },
  { action: 'app.history.search', key: 'r' },
]

function createMachine(
  config: LeaderConfig = CONFIG,
  bindings: readonly LeaderBinding[] = BINDINGS,
): { machine: LeaderStateMachine; activated: string[]; activatedKeys: string[]; stateChanges: () => number } {
  const activated: string[] = []
  const activatedKeys: string[] = []
  let stateChanges = 0
  const machine = new LeaderStateMachine(config, bindings, {
    onActivate: (action, key) => { activated.push(action); activatedKeys.push(key); return true },
    onStateChange: () => { stateChanges += 1 },
  })
  // The counter is exposed as a GETTER — a by-value copy would freeze at 0
  // (the AGENTS.md mutable-counter trap).
  return { machine, activated, activatedKeys, stateChanges: () => stateChanges }
}

test('idle: the leader key arms the pending state', () => {
  const { machine, stateChanges } = createMachine()
  assert.equal(machine.pending, false)
  const result = machine.feed('\x18') // ctrl+x
  assert.deepEqual(result, { kind: 'consumed' })
  assert.equal(machine.pending, true)
  assert.ok(stateChanges() >= 1)
})

test('idle: Kitty repeat/release artifacts are consumed without arming', () => {
  const { machine, stateChanges } = createMachine()
  assert.deepEqual(machine.feed('\x1b[120;5:2u'), { kind: 'consumed' })
  assert.deepEqual(machine.feed('\x1b[120;5:3u'), { kind: 'consumed' })
  assert.equal(machine.pending, false)
  assert.equal(stateChanges(), 0, 'protocol artifacts must not repaint which-key state')
})

test('idle: other keys pass through', () => {
  const { machine } = createMachine()
  assert.deepEqual(machine.feed('a'), { kind: 'passed' })
  assert.equal(machine.pending, false)
})

test('a completing key activates the bound action', () => {
  const { machine, activated, activatedKeys } = createMachine()
  machine.feed('\x18') // leader
  const result = machine.feed('t')
  assert.deepEqual(result, { kind: 'activated', action: 'app.tasks.open', consumed: true })
  assert.deepEqual(activated, ['app.tasks.open'])
  assert.deepEqual(activatedKeys, ['t'])
  assert.equal(machine.pending, false)
})

test('a DECLINED action activation reports consumed: false (the key falls through)', () => {
  // Review finding: the leader machine must not unconditionally consume a
  // completing key when the dispatched action DECLINES (e.g. pasteMedia
  // without a clipboard handler) — the app only consumes when
  // onActivate returns true, mirroring the direct-key resolver contract.
  const bindings: LeaderBinding[] = [{ action: 'app.clipboard.pasteMedia', key: 'p' }]
  const machine = new LeaderStateMachine(CONFIG, bindings, {
    onActivate: () => false,
    onStateChange: () => {},
  })
  machine.feed('\x18') // leader
  const result = machine.feed('p')
  assert.deepEqual(result, { kind: 'activated', action: 'app.clipboard.pasteMedia', consumed: false })
  assert.equal(machine.pending, false)
})

test('a non-matching key cancels the pending state and passes through', () => {
  const { machine, activated } = createMachine()
  machine.feed('\x18')
  const result = machine.feed('z')
  assert.deepEqual(result, { kind: 'cancelled-pass' })
  assert.equal(machine.pending, false)
  assert.deepEqual(activated, [])
})

test('Esc cancels the pending state and is consumed', () => {
  const { machine } = createMachine()
  machine.feed('\x18')
  const result = machine.feed('\x1b') // escape
  assert.deepEqual(result, { kind: 'cancelled-consume' })
  assert.equal(machine.pending, false)
})

test('a paste burst cancels the pending state and passes the text through', () => {
  const { machine } = createMachine()
  machine.feed('\x18')
  const result = machine.feed('hello world')
  assert.deepEqual(result, { kind: 'cancelled-pass' })
  assert.equal(machine.pending, false)
})

test('protocol artifacts (release/repeat) are ignored while pending', () => {
  const { machine } = createMachine()
  machine.feed('\x18')
  // A release of the leader key must not cancel the sequence it armed.
  assert.deepEqual(machine.feed('\x1b[120;5:3u'), { kind: 'consumed' }) // ctrl+x release (CSI-u)
  assert.equal(machine.pending, true)
})

test('timeout cancels the pending state', async () => {
  const { machine, stateChanges } = createMachine({ key: 'ctrl+x', timeoutMs: 20 })
  machine.feed('\x18')
  assert.equal(machine.pending, true)
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(machine.pending, false)
  assert.ok(stateChanges() >= 2)
})

test('no leader key: everything passes through', () => {
  const { machine } = createMachine({ key: undefined, timeoutMs: 1000 })
  assert.deepEqual(machine.feed('\x18'), { kind: 'passed' })
  assert.equal(machine.pending, false)
})

test('focus-transition cancellation via cancel()', () => {
  const { machine, stateChanges } = createMachine()
  machine.feed('\x18')
  assert.equal(machine.pending, true)
  machine.cancel()
  assert.equal(machine.pending, false)
  assert.ok(stateChanges() >= 2)
  // Cancel is idempotent.
  machine.cancel()
})

test('dispose clears the timer and makes the machine inert', () => {
  const { machine } = createMachine()
  machine.feed('\x18')
  machine.dispose()
  assert.equal(machine.pending, false)
  assert.deepEqual(machine.feed('t'), { kind: 'passed' })
})