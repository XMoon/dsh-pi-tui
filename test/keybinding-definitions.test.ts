/**
 * The action definition table contract (plan §21): unique ids, valid
 * default keys, protected actions, and no accidental duplicate overlapping
 * defaults. This is the M0 gate — the defaults MUST match the
 * pre-migration behavior.
 * @module @xmoon76/dsh-pi-tui/keybinding-definitions.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { APP_KEYBINDINGS, NON_CONFIGURABLE_ACTIONS, PROTECTED_HOST_ACTIONS, VIEWER_BLOCKED_PARENT_ACTIONS } from '../src/keybindings/definitions.ts'
import { isValidKeyId } from '../src/keybindings/config.ts'
import { scopesOverlap } from '../src/keybindings/conflicts.ts'
import type { AppKeybindingId } from '../src/keybindings/types.ts'

test('every action id is unique and matches its own key', () => {
  const ids = Object.keys(APP_KEYBINDINGS)
  assert.equal(new Set(ids).size, ids.length, 'action ids must be unique')
  for (const [id, definition] of Object.entries(APP_KEYBINDINGS)) {
    assert.equal(definition.id, id, 'definition.id must equal its key')
  }
})

test('every default key is a valid KeyId', () => {
  for (const [id, definition] of Object.entries(APP_KEYBINDINGS)) {
    for (const key of definition.defaultKeys) {
      assert.ok(isValidKeyId(key), `default key "${key}" of "${id}" must be a valid KeyId`)
    }
  }
})

test('every definition carries description, category and scope', () => {
  for (const [id, definition] of Object.entries(APP_KEYBINDINGS)) {
    assert.ok(definition.description.length > 0, `"${id}" needs a description`)
    assert.ok(definition.category.length > 0, `"${id}" needs a category`)
    assert.ok(definition.scope.length > 0, `"${id}" needs a scope`)
  }
})

test('the M0 gate: default keys match the pre-migration behavior', () => {
  const defaults = (id: AppKeybindingId): readonly string[] => APP_KEYBINDINGS[id].defaultKeys
  assert.deepEqual(defaults('app.input.submit'), ['enter'])
  assert.deepEqual(defaults('app.input.queue'), ['ctrl+enter'])
  assert.deepEqual(defaults('app.input.steer'), ['ctrl+s'])
  assert.deepEqual(defaults('app.input.dequeue'), ['alt+up'])
  assert.deepEqual(defaults('app.agent.interrupt'), ['escape'])
  assert.deepEqual(defaults('app.exit.request'), ['ctrl+c', 'ctrl+d'])
  assert.deepEqual(defaults('app.transcript.search'), ['ctrl+f', 'ctrl+shift+f'])
  assert.deepEqual(defaults('app.transcript.toggleExpand'), ['ctrl+o'])
  assert.deepEqual(defaults('app.transcript.toggleThinking'), ['alt+t'])
  assert.deepEqual(defaults('app.transcript.toggleFullscreen'), [])
  assert.deepEqual(defaults('app.editor.external'), ['ctrl+g'])
  assert.deepEqual(defaults('app.clipboard.pasteMedia'), ['ctrl+v'])
  assert.deepEqual(defaults('app.permission.cycle'), ['shift+tab'])
  assert.deepEqual(defaults('app.todo.toggle'), ['ctrl+t'])
  assert.deepEqual(defaults('app.tasks.open'), [])
  assert.deepEqual(defaults('app.history.search'), ['ctrl+r'])
  assert.deepEqual(defaults('app.shell.dismissSettled'), ['alt+k'])
})

test('no accidental duplicate overlapping defaults within the host keymap', () => {
  const byKey = new Map<string, string[]>()
  for (const [id, definition] of Object.entries(APP_KEYBINDINGS)) {
    for (const key of definition.defaultKeys) {
      const list = byKey.get(key) ?? []
      list.push(id)
      byKey.set(key, list)
    }
  }
  for (const [key, ids] of byKey) {
    if (ids.length < 2) continue
    // Same key on multiple actions is legal ONLY when the scopes are
    // disjoint (they live in different keymaps or contexts).
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const left = APP_KEYBINDINGS[ids[i] as AppKeybindingId]
        const right = APP_KEYBINDINGS[ids[j] as AppKeybindingId]
        assert.ok(
          !scopesOverlap(left.scope, right.scope),
          `default key "${key}" overlaps between "${ids[i]}" (${left.scope}) and "${ids[j]}" (${right.scope})`,
        )
      }
    }
  }
})

test('protected host actions are a subset of the definitions', () => {
  for (const action of PROTECTED_HOST_ACTIONS) {
    assert.ok(action in APP_KEYBINDINGS, `protected action "${action}" must be defined`)
  }
  assert.ok(PROTECTED_HOST_ACTIONS.has('app.exit.request'))
  assert.ok(PROTECTED_HOST_ACTIONS.has('app.agent.interrupt'))
  assert.ok(PROTECTED_HOST_ACTIONS.has('app.input.submit'))
})

test('viewer-blocked parent actions are all defined and configurable', () => {
  for (const action of VIEWER_BLOCKED_PARENT_ACTIONS) {
    assert.ok(action in APP_KEYBINDINGS, `viewer-blocked action "${action}" must be defined`)
  }
  // The viewer guard must cover every parent-owned chord of the current
  // implementation (M1 gate: the physical-key blacklist is fully replaced).
  assert.ok(VIEWER_BLOCKED_PARENT_ACTIONS.has('app.input.steer'))
  assert.ok(VIEWER_BLOCKED_PARENT_ACTIONS.has('app.input.queue'))
  assert.ok(VIEWER_BLOCKED_PARENT_ACTIONS.has('app.input.dequeue'))
  assert.ok(VIEWER_BLOCKED_PARENT_ACTIONS.has('app.permission.cycle'))
  assert.ok(VIEWER_BLOCKED_PARENT_ACTIONS.has('app.transcript.search'))
  assert.ok(VIEWER_BLOCKED_PARENT_ACTIONS.has('app.exit.request'))
  assert.ok(VIEWER_BLOCKED_PARENT_ACTIONS.has('app.editor.external'))
  assert.ok(VIEWER_BLOCKED_PARENT_ACTIONS.has('app.todo.toggle'))
  assert.ok(VIEWER_BLOCKED_PARENT_ACTIONS.has('app.transcript.toggleThinking'))
  assert.ok(VIEWER_BLOCKED_PARENT_ACTIONS.has('app.clipboard.pasteMedia'))
  assert.ok(VIEWER_BLOCKED_PARENT_ACTIONS.has('app.tasks.open'))
})

test('non-configurable actions are the focused-component set plus the reserved session/model tier', () => {
  for (const action of NON_CONFIGURABLE_ACTIONS) {
    assert.ok(action.startsWith('question.') || action.startsWith('tasks.')
      || action.startsWith('app.transcript.search.')
      // The RESERVED session/model actions are not implemented this
      // version — never user-configurable no-op keys (convergence §7).
      || action.startsWith('app.session.') || action === 'app.model.open',
    `unexpected non-configurable action "${action}"`)
  }
  // Every non-configurable action must be either a fixed component
  // contract or explicitly marked reserved.
  for (const action of NON_CONFIGURABLE_ACTIONS) {
    const definition = APP_KEYBINDINGS[action]
    if (action.startsWith('app.session.') || action === 'app.model.open') {
      assert.equal(definition.availability, 'reserved', `"${action}" must be availability:reserved`)
    }
  }
})
