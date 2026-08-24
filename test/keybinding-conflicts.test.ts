/**
 * The conflict model contract (plan §15/§21): same key + same scope →
 * conflict; same key + disjoint scope → legal; user override vs builtin →
 * user wins; plugin fallback vs Host → Host wins. Conflicts are
 * deactivated with a diagnostic — never silent last-write-wins.
 * @module @xmoon76/dsh-pi-tui/keybinding-conflicts.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveKeybindingContext } from '../src/keybindings/context.ts'
import { EffectiveKeymap } from '../src/keybindings/effective-keymap.ts'
import { APP_KEYBINDINGS } from '../src/keybindings/definitions.ts'
import { scopesOverlap } from '../src/keybindings/conflicts.ts'

const editorContext = deriveKeybindingContext({ focusedSeat: 'editor' })

test('scope overlap: editor and agent-running overlap, capturing scopes are disjoint', () => {
  assert.ok(scopesOverlap('editor', 'agent-running'))
  assert.ok(scopesOverlap('global', 'editor'))
  assert.ok(scopesOverlap('question', 'question'))
  assert.ok(!scopesOverlap('question', 'tasks'))
  assert.ok(!scopesOverlap('search', 'viewer'))
  assert.ok(!scopesOverlap('editor', 'question'), 'a capturing scope never conflicts with a non-capturing one')
  assert.ok(!scopesOverlap('agent-running', 'search'))
})

test('same key + same scope + same priority → conflict, neither fires', () => {
  const diagnostics: string[] = []
  const km = new EffectiveKeymap({
    definitions: APP_KEYBINDINGS,
    userBindings: {
      'app.history.search': 'ctrl+shift+h',
      'app.todo.toggle': 'ctrl+shift+h',
    },
    onDiagnostic: (message) => diagnostics.push(message),
  })
  assert.equal(km.resolve('\x1b[104;6u', editorContext), undefined, 'conflicting rules must not fire')
  assert.equal(km.keysFor('app.history.search').length, 0)
  assert.equal(km.keysFor('app.todo.toggle').length, 0)
  assert.equal(km.conflictsList().length, 1)
  const conflict = km.conflictsList()[0]!
  assert.equal(conflict.key, 'ctrl+shift+h')
  assert.equal(conflict.actions.length, 2)
  assert.ok(diagnostics.some(message => message.includes('conflict')))
})

test('same key + disjoint scope → legal (both stay active)', () => {
  // A user rule (priority 200) never conflicts with a builtin (100) —
  // the user wins (plan §21: "user override vs builtin → user wins").
  const km = new EffectiveKeymap({
    definitions: APP_KEYBINDINGS,
    userBindings: { 'app.todo.toggle': 'enter' },
  })
  assert.equal(km.conflictsList().length, 0)
  assert.equal(km.resolve('\r', editorContext)?.action, 'app.todo.toggle')
  // A truly disjoint pair: a host action bound to a key a capturing
  // surface owns (search.previous's shift+enter) is legal.
  const km2 = new EffectiveKeymap({
    definitions: APP_KEYBINDINGS,
    userBindings: { 'app.todo.toggle': 'shift+enter' },
  })
  assert.equal(km2.conflictsList().length, 0)
  assert.equal(km2.resolve('\x1b[13;2u', editorContext)?.action, 'app.todo.toggle') // shift+enter
})

test('user override vs builtin: user wins, no conflict', () => {
  const km = new EffectiveKeymap({
    definitions: APP_KEYBINDINGS,
    userBindings: { 'app.input.steer': 'ctrl+x' },
  })
  assert.equal(km.conflictsList().length, 0)
  assert.equal(km.resolve('\x18', editorContext)?.action, 'app.input.steer')
})

test('plugin fallback vs Host: Host wins, no conflict', () => {
  const km = new EffectiveKeymap({
    definitions: APP_KEYBINDINGS,
    pluginRules: [{ id: 'plugin', action: 'submit-draft', key: 'ctrl+s' }],
  })
  assert.equal(km.conflictsList().length, 0)
  assert.equal(km.resolve('\x13', editorContext)?.action, 'app.input.steer')
})

test('two plugin rules on the same key → conflict', () => {
  const diagnostics: string[] = []
  const km = new EffectiveKeymap({
    definitions: APP_KEYBINDINGS,
    pluginRules: [
      { id: 'plugin-a', action: 'submit-draft', key: 'ctrl+alt+x' },
      { id: 'plugin-b', action: 'open-search', key: 'ctrl+alt+x' },
    ],
    onDiagnostic: (message) => diagnostics.push(message),
  })
  assert.equal(km.resolve('\x1b[120;7u', editorContext), undefined)
  assert.equal(km.conflictsList().length, 1)
  assert.ok(diagnostics.some(message => message.includes('plugin-a') && message.includes('plugin-b')))
})

test('conflict diagnostics are fail-soft: other rules keep working', () => {
  const km = new EffectiveKeymap({
    definitions: APP_KEYBINDINGS,
    userBindings: {
      'app.history.search': 'ctrl+shift+h',
      'app.todo.toggle': 'ctrl+shift+h', // conflicts with the above
      'app.input.steer': 'ctrl+x', // unaffected
    },
  })
  assert.equal(km.resolve('\x18', editorContext)?.action, 'app.input.steer')
  assert.equal(km.resolve('\x13', editorContext), undefined, 'the replaced ctrl+s is gone')
})
