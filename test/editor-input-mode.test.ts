/**
 * Pure tests for the editor input-mode codec (src/editor-input-mode.ts):
 * the `!` / `!!` prefixes are editor STATE, never document text — the
 * codec serializes a mode + body back into the wire form at host
 * boundaries and decodes serialized lines (history entries, pastes,
 * restored submissions) into mode + body.
 * @module @xmoon76/dsh-pi-tui/editor-input-mode.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  editorModeFromHistoryEntry,
  serializeEditorInput,
  serializedDraftHasPayload,
  shellPrefixForMode,
} from '../src/editor-input-mode.ts'

test('shellPrefixForMode maps the three modes to their prefixes', () => {
  assert.equal(shellPrefixForMode('prompt'), '')
  assert.equal(shellPrefixForMode('shell-context'), '!')
  assert.equal(shellPrefixForMode('shell-local'), '!!')
})

test('serializeEditorInput produces the exact wire forms', () => {
  assert.equal(serializeEditorInput('prompt', 'hello'), 'hello')
  assert.equal(serializeEditorInput('shell-context', 'pwd'), '!pwd')
  assert.equal(serializeEditorInput('shell-local', 'pwd'), '!!pwd')
  // An empty body still serializes the prefix (a bare `!` / `!!` line).
  assert.equal(serializeEditorInput('shell-context', ''), '!')
  assert.equal(serializeEditorInput('shell-local', ''), '!!')
})

test('editorModeFromHistoryEntry decodes every serialized form', () => {
  assert.deepEqual(editorModeFromHistoryEntry('hello'), { mode: 'prompt', text: 'hello' })
  assert.deepEqual(editorModeFromHistoryEntry('!pwd'), { mode: 'shell-context', text: 'pwd' })
  assert.deepEqual(editorModeFromHistoryEntry('!!pwd'), { mode: 'shell-local', text: 'pwd' })
  // Bare prefixes decode to the matching shell mode with an empty body.
  assert.deepEqual(editorModeFromHistoryEntry('!'), { mode: 'shell-context', text: '' })
  assert.deepEqual(editorModeFromHistoryEntry('!!'), { mode: 'shell-local', text: '' })
})

test('the !! check runs before the ! check', () => {
  assert.deepEqual(editorModeFromHistoryEntry('!!x'), { mode: 'shell-local', text: 'x' })
  assert.deepEqual(editorModeFromHistoryEntry('!x'), { mode: 'shell-context', text: 'x' })
})

test('a literal ! inside the body is preserved, not re-parsed', () => {
  // `!echo !` decodes to shell-context with the trailing `!` as body text.
  assert.deepEqual(editorModeFromHistoryEntry('!echo !'), { mode: 'shell-context', text: 'echo !' })
  assert.deepEqual(editorModeFromHistoryEntry('!!echo !'), { mode: 'shell-local', text: 'echo !' })
  // A non-leading `!` is ordinary text.
  assert.deepEqual(editorModeFromHistoryEntry('echo !'), { mode: 'prompt', text: 'echo !' })
})

test('serialize and decode round-trip', () => {
  for (const [mode, body] of [
    ['prompt', 'hello'],
    ['shell-context', 'pwd'],
    ['shell-local', 'pwd'],
  ] as const) {
    const serialized = serializeEditorInput(mode, body)
    assert.deepEqual(editorModeFromHistoryEntry(serialized), { mode, text: body })
  }
})

test('serializedDraftHasPayload: the shared empty-input verdict', () => {
  // Plain empty + whitespace-only: no payload.
  assert.equal(serializedDraftHasPayload(''), false)
  assert.equal(serializedDraftHasPayload('   '), false)
  assert.equal(serializedDraftHasPayload('\n\t '), false)
  // A bare shell prefix IS payload (§7.6: never killed by an empty guard).
  assert.equal(serializedDraftHasPayload('!'), true)
  assert.equal(serializedDraftHasPayload('!!'), true)
  assert.equal(serializedDraftHasPayload('!pwd'), true)
  assert.equal(serializedDraftHasPayload('!!pwd'), true)
  // Normal prompts are payload.
  assert.equal(serializedDraftHasPayload('hello'), true)
  assert.equal(serializedDraftHasPayload('  hello  '), true)
})
