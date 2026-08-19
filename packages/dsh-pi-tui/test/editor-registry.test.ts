/**
 * M9 tests (plan §14): the editor registry (single-winner) and the atomic
 * seat handoff — creation-first, draft/cursor transfer, create-failure
 * fallback, winner-unload draft preservation.
 * @module @xmoon76/dsh-pi-tui/editor-registry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorRegistry } from '../src/editor-registry.ts'
import type { EditorHost, ExtensionEditor } from '../src/extension/public-types.ts'

/** A minimal plugin editor backed by a text state. */
function pluginEditor(initial = ''): ExtensionEditor & { text: string; cursor: number; disposed: boolean } {
  const state = { text: initial, cursor: 0, disposed: false }
  // NOTE: never spread `state` into the returned object — the OWN data
  // fields would shadow the closure (the AGENTS.md mutable-counter trap:
  // `disposed` would read the copied field, not state.disposed).
  return {
    get component() { return { kind: 'text' as const, spans: [{ text: state.text }] } },
    getText: () => state.text,
    setText: (text) => { state.text = text },
    getCursor: () => state.cursor,
    setCursor: (offset) => { state.cursor = offset },
    get focused() { return false },
    borderColor: (text) => text,
    dispose: () => { state.disposed = true },
    get text() { return state.text },
    get cursor() { return state.cursor },
    get disposed() { return state.disposed },
  }
}

/** A plugin editor with a FIXED text (contract probe — getText is the
 * plugin's own state; the transfer only works when the plugin honors
 * setText). */
function fixedTextEditor(text: string): ExtensionEditor {
  return {
    component: { kind: 'text', spans: [{ text }] },
    getText: () => text,
    setText: () => {},
    dispose: () => {},
  }
}

test('EditorRegistry: single-winner — lowest priority wins', () => {
  const registry = new EditorRegistry()
  registry.register({ id: 'a', priority: 10, create: (host: EditorHost) => pluginEditor() }, 'o1')
  registry.register({ id: 'b', priority: 1, create: (host: EditorHost) => pluginEditor() }, 'o2')
  assert.equal(registry.winner()?.id, 'b')
  registry.dispose('b')
  assert.equal(registry.winner()?.id, 'a', 'the next winner takes over after unload')
  registry.dispose('a')
  assert.equal(registry.winner(), undefined, 'no winner = host default')
})

test('EditorRegistry: a priority tie is an explicit error', () => {
  const registry = new EditorRegistry()
  registry.register({ id: 'a', priority: 5, create: (host: EditorHost) => pluginEditor() }, 'o1')
  assert.throws(() => registry.register({ id: 'b', priority: 5, create: (host: EditorHost) => pluginEditor() }, 'o2'), /priority tie/)
})

test('EditorRegistry: owner unload removes the editor; duplicate ids error', () => {
  const registry = new EditorRegistry()
  registry.register({ id: 'x', priority: 1, create: (host: EditorHost) => pluginEditor() }, 'owner-a')
  assert.throws(() => registry.register({ id: 'x', priority: 2, create: (host: EditorHost) => pluginEditor() }, 'owner-b'), /duplicate/)
  registry.disposeOwner('owner-a')
  assert.equal(registry.winner(), undefined)
})

// ── The seat handoff (via TuiApp) ──────────────────────────────────────────

test('TuiApp: a plugin editor wins the seat through the atomic handoff; unload restores the host default with the draft', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  // Type a draft through the host editor.
  app.setDraft('preserve me')
  await vt.waitForRender()
  // A plugin editor registers (wins by priority 0).
  const created: ReturnType<typeof pluginEditor>[] = []
  const handle = registry.register({
    id: 'vimlike',
    priority: 0,
    create: (host: EditorHost) => {
      const editor = pluginEditor()
      created.push(editor)
      return editor
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // The winner occupies the seat; the draft transferred.
  assert.equal(created.length, 1, 'the plugin editor was created')
  const winner = created[0]!
  assert.equal(winner.getText(), 'preserve me', 'the draft transferred to the plugin editor')
  assert.equal(winner.disposed, false)
  // The host's editor text access now reads the PLUGIN editor.
  assert.equal(app.getDraft(), 'preserve me')
  // Unload: the host default restores with the draft preserved.
  handle.dispose()
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.equal(winner.disposed, true, 'the plugin editor was disposed after the handoff')
  assert.equal(app.getDraft(), 'preserve me', 'the draft survives back into the host editor')
  app.stop()
})

test('TuiApp: a creation throw keeps the current editor working (atomic handoff)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  app.setDraft('safe draft')
  await vt.waitForRender()
  // A plugin editor whose create() throws: the host editor must survive.
  registry.register({
    id: 'exploder',
    priority: 0,
    create: (host: EditorHost) => { throw new Error('editor creation failed') },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'safe draft', 'the current editor keeps working after a creation throw')
  app.stop()
})

test('TuiApp: the editor host dispatch routes semantic actions through host paths', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
  }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  let host: EditorHost | undefined
  // The host draft transfers into the plugin editor at the handoff.
  app.setDraft('draft from plugin')
  registry.register({
    id: 'dispatchy',
    priority: 0,
    create: (editorHost: EditorHost) => {
      host = editorHost
      return pluginEditor()
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.ok(host !== undefined)
  // The plugin dispatches 'submit': the host's onSubmit fires.
  const result = host.dispatch('submit')
  assert.equal(result.kind, 'accepted')
  assert.deepEqual(submitted, ['draft from plugin'])
  // The snapshot contract.
  const snapshot = host.getSnapshot()
  assert.equal(snapshot.text, 'draft from plugin')
  assert.equal(snapshot.replacementId, 'dispatchy')
  app.stop()
})
