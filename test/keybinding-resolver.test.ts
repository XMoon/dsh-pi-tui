/**
 * The EffectiveKeymap resolver contract (plan §21): default resolve, user
 * override, disabled binding, multi-key, context filtering, source
 * priority.
 * @module @xmoon76/dsh-pi-tui/keybinding-resolver.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveKeybindingContext } from '../src/keybindings/context.ts'
import { EffectiveKeymap } from '../src/keybindings/effective-keymap.ts'
import { APP_KEYBINDINGS } from '../src/keybindings/definitions.ts'
import type { KeybindingContext } from '../src/keybindings/types.ts'

function keymap(options: Omit<ConstructorParameters<typeof EffectiveKeymap>[0], 'definitions'> = {}): EffectiveKeymap {
  return new EffectiveKeymap({
    definitions: APP_KEYBINDINGS,
    // The HOST keymap resolves the non-capturing scopes only (the manager
    // wires this); the focused-component actions never resolve here.
    includeScopes: new Set(['global', 'editor', 'agent-running']),
    // The empty-editor ↓ affordance (the manager's composition rule).
    compositionRules: [{
      action: 'app.tasks.open',
      key: 'down',
      predicate: (context) => context.focusedSeat === 'editor' && context.editorEmpty && context.tasksActive,
    }],
    ...options,
  })
}

const editorContext: KeybindingContext = deriveKeybindingContext({ focusedSeat: 'editor' })

test('default resolve: ctrl+s → app.input.steer', () => {
  const km = keymap()
  const resolution = km.resolve('\x13', editorContext) // ctrl+s
  assert.ok(resolution !== undefined)
  assert.equal(resolution.action, 'app.input.steer')
  assert.equal(resolution.source, 'builtin')
})

test('default resolve: ctrl+o → app.transcript.toggleExpand', () => {
  const km = keymap()
  const resolution = km.resolve('\x0f', editorContext) // ctrl+o
  assert.ok(resolution !== undefined)
  assert.equal(resolution.action, 'app.transcript.toggleExpand')
})

test('default resolve: shift+tab → app.permission.cycle', () => {
  const km = keymap()
  const resolution = km.resolve('\x1b[Z', editorContext) // shift+tab
  assert.ok(resolution !== undefined)
  assert.equal(resolution.action, 'app.permission.cycle')
})

test('default resolve: alt+up → app.input.dequeue', () => {
  const km = keymap()
  const resolution = km.resolve('\x1b[1;3A', editorContext) // alt+up (CSI-u)
  assert.ok(resolution !== undefined)
  assert.equal(resolution.action, 'app.input.dequeue')
})

test('multi-key action: ctrl+c and ctrl+d both resolve to app.exit.request', () => {
  const km = keymap()
  assert.equal(km.resolve('\x03', editorContext)?.action, 'app.exit.request') // ctrl+c
  assert.equal(km.resolve('\x04', editorContext)?.action, 'app.exit.request') // ctrl+d
})

test('unbound keys resolve to undefined', () => {
  const km = keymap()
  assert.equal(km.resolve('a', editorContext), undefined)
  assert.equal(km.resolve('\x1b[1;5C', editorContext), undefined) // ctrl+right
})

test('user override replaces the builtin key', () => {
  const km = keymap({ userBindings: { 'app.input.steer': 'ctrl+x' } })
  // The new key resolves…
  assert.equal(km.resolve('\x18', editorContext)?.action, 'app.input.steer') // ctrl+x
  // …and the old key no longer does.
  assert.equal(km.resolve('\x13', editorContext), undefined) // ctrl+s
})

test('user override with multiple keys', () => {
  const km = keymap({ userBindings: { 'app.input.steer': ['ctrl+s', 'ctrl+shift+s'] } })
  assert.equal(km.resolve('\x13', editorContext)?.action, 'app.input.steer')
  assert.equal(km.resolve('\x1b[115;6u', editorContext)?.action, 'app.input.steer') // ctrl+shift+s
})

test('false disables the action entirely', () => {
  const km = keymap({ userBindings: { 'app.transcript.toggleThinking': false } })
  assert.equal(km.resolve('\x1b[1;3t', editorContext), undefined) // alt+t
  assert.deepEqual(km.keysFor('app.transcript.toggleThinking'), [])
})

test('user override beats builtin (source priority)', () => {
  const km = keymap({ userBindings: { 'app.todo.toggle': 'ctrl+shift+t' } })
  const resolution = km.resolve('\x1b[116;6u', editorContext) // ctrl+shift+t
  assert.ok(resolution !== undefined)
  assert.equal(resolution.action, 'app.todo.toggle')
  assert.equal(resolution.source, 'user')
})

test('plugin rules resolve last and never beat a host rule', () => {
  const km = keymap({
    pluginRules: [{ id: 'plugin-1', action: 'submit-draft', key: 'ctrl+alt+x' }],
  })
  // A plugin-only key resolves to the plugin action.
  assert.equal(km.resolve('\x1b[120;7u', editorContext)?.action, 'submit-draft')
  // A host key stays host-owned even when a plugin claims it.
  const km2 = keymap({ pluginRules: [{ id: 'plugin-2', action: 'submit-draft', key: 'ctrl+s' }] })
  assert.equal(km2.resolve('\x13', editorContext)?.action, 'app.input.steer')
})

test('context predicate: the empty-editor ↓ affordance', () => {
  const km = keymap()
  const idle = deriveKeybindingContext({ focusedSeat: 'editor', editorEmpty: true, tasksActive: true })
  const busy = deriveKeybindingContext({ focusedSeat: 'editor', editorEmpty: false, tasksActive: true })
  const noTasks = deriveKeybindingContext({ focusedSeat: 'editor', editorEmpty: true, tasksActive: false })
  assert.equal(km.resolve('\x1b[B', idle)?.action, 'app.tasks.open') // down
  assert.equal(km.resolve('\x1b[B', busy), undefined)
  assert.equal(km.resolve('\x1b[B', noTasks), undefined)
})

test('focused-component actions never resolve in the host keymap', () => {
  const km = keymap()
  // 'down' must resolve to the host affordance, never question.cursorDown.
  const context = deriveKeybindingContext({ focusedSeat: 'editor', editorEmpty: true, tasksActive: true })
  assert.equal(km.resolve('\x1b[B', context)?.action, 'app.tasks.open')
  // 'e' (question.toggleExpand) and 'i' (tasks.interrupt) stay unbound.
  assert.equal(km.resolve('e', context), undefined)
  assert.equal(km.resolve('i', context), undefined)
})

test('safe mode ignores user overrides', () => {
  const km = keymap({ userBindings: { 'app.input.steer': 'ctrl+x' }, safeMode: true })
  assert.equal(km.resolve('\x13', editorContext)?.action, 'app.input.steer') // ctrl+s still steers
  assert.equal(km.resolve('\x18', editorContext), undefined) // ctrl+x unbound
})

test('keysFor / primaryKeyFor / keyHint reflect the effective map', () => {
  const km = keymap({ userBindings: { 'app.permission.cycle': 'alt+p' } })
  assert.deepEqual(km.keysFor('app.permission.cycle'), ['alt+p'])
  assert.equal(km.primaryKeyFor('app.permission.cycle'), 'alt+p')
  assert.equal(km.keyHint('app.permission.cycle'), 'Alt+P')
  assert.equal(km.keyHint('app.transcript.toggleFullscreen'), '')
})

test('snapshot lists every action with its effective keys and sources', () => {
  const km = keymap({ userBindings: { 'app.input.steer': 'ctrl+x' } })
  const snapshot = km.snapshot()
  assert.ok(snapshot.revision >= 1)
  const steer = snapshot.bindings.find(binding => binding.action === 'app.input.steer')
  assert.ok(steer !== undefined)
  assert.deepEqual(steer.keys, ['ctrl+x'])
  assert.equal(steer.source, 'user')
  assert.equal(steer.scope, 'agent-running')
  assert.deepEqual(snapshot.conflicts, [])
})
