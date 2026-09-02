/**
 * M9 tests (plan §14): the editor registry (single-winner) and the atomic
 * seat handoff — creation-first, draft/cursor transfer, create-failure
 * fallback, winner-unload draft preservation.
 * @module @xmoon76/dsh-pi-tui/editor-registry.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { EditorRegistry } from '../src/editor-registry.ts'
import { EditorSeatHolder } from '../src/editor-seat-holder.ts'
import { Text } from '@xmoon76/pi-tui'
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

function seatHostAdapter(overrides: Partial<{
  text: string
  cursor: number
  setText: (text: string) => void
  setCursor: (offset: number) => void
}> = {}): import('../src/editor-seat-holder.ts').HostEditorAdapter {
  let text = overrides.text ?? ''
  let cursor = overrides.cursor ?? 0
  const component = new Text('host', 0, 0)
  return {
    getText: () => text,
    setText: value => { if (overrides.setText !== undefined) overrides.setText(value); else text = value },
    getCursor: () => cursor,
    setCursor: value => { if (overrides.setCursor !== undefined) overrides.setCursor(value); else cursor = value },
    setTextAndCursor: (value, nextCursor) => { text = value; cursor = nextCursor },
    handleInput: () => {},
    runWithoutChange: task => task(),
    focused: true,
    borderColor: value => value,
    invalidate: () => {},
    addToHistory: () => {},
    clearHistory: () => {},
    component,
  }
}

test('EditorSeatHolder: failed host restore keeps the old plugin seat and does not dispose it', () => {
  let adapterCalls = 0
  let pluginDisposed = false
  const errors: string[] = []
  const initialHost = seatHostAdapter({ text: 'draft', cursor: 2 })
  const holder = new EditorSeatHolder({
    hostAdapter: () => {
      adapterCalls += 1
      if (adapterCalls > 1) throw new Error('host adapter unavailable')
      return initialHost
    },
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: message => errors.push(message),
    viewSwap: () => {},
  })
  const plugin = pluginEditor('plugin draft')
  holder.handoff({ id: 'plugin', create: () => plugin })
  assert.equal(holder.currentEditor().id, 'plugin')
  holder.handoff(undefined)
  assert.equal(holder.currentEditor().id, 'plugin', 'failed host construction must leave the old seat selected')
  assert.equal(plugin.disposed, false, 'failed host construction must not dispose the old editor')
  assert.deepEqual(errors, ['host adapter unavailable'])
  holder.dispose()
})

test('EditorSeatHolder: final dispose during create discards the uncommitted editor', () => {
  const holder = new EditorSeatHolder({
    hostAdapter: () => seatHostAdapter(),
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: () => {},
    viewSwap: () => {},
  })
  let createdDisposed = false
  holder.handoff({
    id: 'late',
    create: () => {
      holder.dispose()
      return {
        component: { kind: 'text', spans: [{ text: 'late' }] },
        getText: () => '',
        setText: () => {},
        dispose: () => { createdDisposed = true },
      }
    },
  })
  assert.equal(createdDisposed, true)
  assert.equal(holder.currentEditor().id, 'host')
})

test('EditorSeatHolder: create-time host mutations are inert until commit and subscriptions survive commit', () => {
  const hostAdapter = seatHostAdapter()
  const holder = new EditorSeatHolder({
    hostAdapter: () => hostAdapter,
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => true,
    notifyError: () => {},
    viewSwap: () => {},
  })
  const snapshots: string[] = []
  const plugin = pluginEditor()
  holder.handoff({
    id: 'plugin',
    create: host => {
      host.subscribe(snapshot => snapshots.push(snapshot.text))
      host.replaceText('must-not-touch-old-seat')
      assert.equal(host.dispatch('submit').kind, 'ignored')
      host.invalidate()
      return plugin
    },
  })
  assert.equal(hostAdapter.getText(), '')
  assert.equal(holder.currentEditor().id, 'plugin')
  plugin.setText('committed')
  holder.notifyChanged()
  assert.deepEqual(snapshots, ['committed'])
  holder.dispose()
})

test('EditorSeatHolder: a reentrant handoff is serialized to the latest target', () => {
  const holder = new EditorSeatHolder({
    hostAdapter: () => seatHostAdapter(),
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: () => {},
    viewSwap: () => {},
  })
  const first = pluginEditor('first')
  const second = pluginEditor('second')
  let firstCreates = 0
  holder.handoff({
    id: 'first',
    create: () => {
      firstCreates += 1
      holder.handoff({ id: 'second', create: () => second })
      return first
    },
  })
  assert.equal(firstCreates, 1)
  assert.equal(holder.currentEditor().id, 'second')
  assert.equal(first.disposed, true, 'the superseded intermediate editor is disposed')
  assert.equal(second.disposed, false)
  holder.dispose()
})

test('EditorSeatHolder: a throwing old-editor dispose cannot break the committed handoff', () => {
  const errors: string[] = []
  const holder = new EditorSeatHolder({
    hostAdapter: () => seatHostAdapter(),
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: message => errors.push(message),
    viewSwap: () => {},
  })
  const old = pluginEditor()
  old.dispose = () => { throw new Error('old dispose boom') }
  const next = pluginEditor()
  holder.handoff({ id: 'old', create: () => old })
  assert.doesNotThrow(() => holder.handoff({ id: 'next', create: () => next }))
  assert.equal(holder.currentEditor().id, 'next')
  assert.equal(next.disposed, false)
  assert.deepEqual(errors, ['old dispose boom'])
  holder.dispose()
})

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

test('EditorRegistry: a stale handle cannot dispose a same-id re-registration', () => {
  const registry = new EditorRegistry()
  const first = registry.register({ id: 'same', priority: 1, create: () => pluginEditor('first') }, 'owner-a')
  first.dispose()
  const second = registry.register({ id: 'same', priority: 2, create: () => pluginEditor('second') }, 'owner-b')
  first.dispose()
  assert.equal(registry.winner()?.id, 'same')
  second.dispose()
  assert.equal(registry.winner(), undefined)
})

test('EditorRegistry: a priority tie is an explicit error', () => {
  const registry = new EditorRegistry()
  registry.register({ id: 'a', priority: 5, create: (host: EditorHost) => pluginEditor() }, 'o1')
  assert.throws(() => registry.register({ id: 'b', priority: 5, create: (host: EditorHost) => pluginEditor() }, 'o2'), /priority tie/)
})

test('EditorRegistry: the reserved "host" id is rejected (P2-R5 review)', () => {
  const registry = new EditorRegistry()
  // 'host' is the built-in seat identity: EditorSeatHolder.performHandoff()
  // treats target.id === 'host' as RESTORATION of the host default, so a
  // plugin claiming it could never occupy the replacement seat and would
  // weaken the seat-ownership checks. It must be rejected at registration.
  assert.throws(
    () => registry.register({ id: 'host', priority: 0, create: (host: EditorHost) => pluginEditor() }, 'plugin'),
    /reserved for the built-in host editor/,
  )
  assert.equal(registry.winner(), undefined, 'a rejected registration must not become a winner')
  assert.equal(registry.hasAny(), false, 'a rejected registration must not be live')
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
  // The snapshot contract (BEFORE the submit — a submit clears the draft).
  const before = host.getSnapshot()
  assert.equal(before.text, 'draft from plugin')
  assert.equal(before.replacementId, 'dispatchy')
  // The plugin dispatches 'submit': the host's onSubmit fires AND the
  // seat draft is cleared like a normal submit (round-1 finding 2).
  const result = host.dispatch('submit')
  assert.equal(result.kind, 'accepted')
  assert.deepEqual(submitted, ['draft from plugin'])
  assert.equal(app.getDraft(), '', 'the submit cleared the seat draft')
  app.stop()
})

test('TuiApp: a stale host captured BEFORE dispose is inert after it — no seat mutation, no submission (P1-12)', async () => {
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
  registry.register({
    id: 'stale-host', priority: 0,
    create: (editorHost: EditorHost) => {
      host = editorHost
      return pluginEditor('draft')
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.ok(host !== undefined)
  // The review repro: after dispose, the OLD host's replaceText('after')
  // and dispatch('submit') must be inert — accepted=false, no submit
  // event, no seat write.
  app.dispose()
  host.replaceText('after')
  const result = host.dispatch('submit')
  assert.equal(result.kind, 'ignored', 'a stale host dispatch must be IGNORED after dispose')
  assert.deepEqual(submitted, [], 'a stale host must never fire a real submission')
  // A fresh surface's holder is a different generation: the stale host's
  // invalidate/getSnapshot are inert too (no throw, no dead-terminal touch).
  host.invalidate()
  assert.equal(app.getDraft(), '', 'the disposed seat never received the stale write')
})

test('TuiApp: setEditorText writes through the active replacement seat (P1-R9)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  const editor = pluginEditor()
  registry.register({ id: 'public-set', priority: 0, create: () => editor }, 'plugin')
  app.reconcileEditorNow()
  app.setEditorText('through-public-path')
  assert.equal(editor.getText(), 'through-public-path')
  assert.equal(app.getDraft(), 'through-public-path')
  app.dispose()
})

test('TuiApp: an old EditorHost is inert after a successful handoff (P1-R7/R8)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, { onSubmit: text => submitted.push(text), onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  let oldHost: EditorHost | undefined
  const first = registry.register({
    id: 'first', priority: 0,
    create: host => { oldHost = host; return pluginEditor('first') },
  }, 'first-owner')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.ok(oldHost !== undefined)
  const second = registry.register({
    id: 'second', priority: -1,
    create: () => pluginEditor('second'),
  }, 'second-owner')
  app.reconcileEditorNow()
  await vt.waitForRender()
  const before = app.getDraft()
  const snapshots: string[] = []
  const unsubscribe = oldHost.subscribe(snapshot => snapshots.push(snapshot.text))
  oldHost.replaceText('stale')
  assert.equal(app.getDraft(), before)
  assert.equal(oldHost.dispatch('submit').kind, 'ignored')
  oldHost.invalidate()
  assert.deepEqual(snapshots, [])
  const staleSnapshot = oldHost.getSnapshot()
  assert.equal(staleSnapshot.text, '')
  assert.equal(staleSnapshot.replacementId, undefined)
  assert.equal(staleSnapshot.focused, false)
  unsubscribe()
  second.dispose()
  first.dispose()
  app.dispose()
  assert.deepEqual(submitted, [])
})

test('TuiApp: EditorHost.replaceText notifies the current subscriber (P1-R8)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  let host: EditorHost | undefined
  const snapshots: string[] = []
  registry.register({ id: 'replace-notify', priority: 0, create: editorHost => {
    host = editorHost
    editorHost.subscribe(snapshot => snapshots.push(snapshot.text))
    return pluginEditor()
  } }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  host!.replaceText('direct')
  assert.ok(snapshots.includes('direct'))
  app.dispose()
})

test('TuiApp: the EditorHost subscription is DRIVEN by host mutations (P1-11)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  let host: EditorHost | undefined
  let unsubscribe: (() => void) | undefined
  const snapshots: string[] = []
  registry.register({
    id: 'subscriber', priority: 0,
    create: (editorHost: EditorHost) => {
      host = editorHost
      unsubscribe = editorHost.subscribe((snapshot) => snapshots.push(snapshot.text))
      return pluginEditor()
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.ok(host !== undefined)
  // The review repro: host-driven draft changes must reach the listener.
  app.setDraft('one')
  app.setDraft('two')
  assert.ok(snapshots.includes('one'), `host setDraft must notify: ${JSON.stringify(snapshots)}`)
  assert.ok(snapshots.includes('two'), `host setDraft must notify: ${JSON.stringify(snapshots)}`)
  // The host's own editor typing (through the fork onChange) notifies too:
  // feed the HOST editor directly while the seat is the host default.
  // (With the plugin winner, host writes go through seat writes — the
  // listener sees the CURRENT seat occupant's text either way.)
  const before = snapshots.length
  app.submitDraft(false)
  assert.ok(snapshots.length > before, 'a submit (draft clear) must notify subscribers')
  // Unsubscribe stops delivery (the ORIGINAL listener's disposer).
  unsubscribe!()
  app.setDraft('three')
  assert.ok(!snapshots.includes('three'), 'an unsubscribed listener must not receive changes')
  app.stop()
})

test('TuiApp: a declined replacement key falls back into the active plugin draft (P1-R3)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    editorRegistry: registry,
    // No plugin keybinding resolver: replacement routing must still reach the
    // host fallback when the editor explicitly declines the key.
  })
  app.start()
  await vt.waitForRender()
  app.setDraft('abcd')
  let text = ''
  let cursor = 0
  const snapshots: string[] = []
  registry.register({
    id: 'declining', priority: 0,
    create: (editorHost) => {
      editorHost.subscribe((snapshot) => { snapshots.push(`${snapshot.text}@${snapshot.cursor}`) })
      return {
        get component() { return { kind: 'text' as const, spans: [{ text }] } },
        getText: () => text,
        setText: (next) => { text = next },
        getCursor: () => cursor,
        setCursor: (next) => { cursor = next },
        handleInput: () => false,
        dispose: () => {},
      }
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // Put the active replacement cursor in the middle. Backspace must delete
  // 'b' in the visible replacement, not edit the hidden host at its end.
  app.seatEditorForTest().setCursor(2)
  const before = snapshots.length
  vt.sendInput('\x7f')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'acd')
  assert.equal(app.seatEditorForTest().getCursor(), 1)
  assert.deepEqual(snapshots.slice(before), ['acd@1'], 'fallback delivers one final snapshot')
  app.dispose()
})

test('TuiApp: a declined replacement printable key uses the host fallback without a plugin resolver (P1-R3)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  let text = ''
  let cursor = 0
  const snapshots: string[] = []
  registry.register({
    id: 'declining-printable', priority: 0,
    create: (editorHost) => {
      editorHost.subscribe(snapshot => snapshots.push(`${snapshot.text}@${snapshot.cursor}`))
      return {
        get component() { return { kind: 'text' as const, spans: [{ text }] } },
        getText: () => text,
        setText: (next) => { text = next },
        getCursor: () => cursor,
        setCursor: (next) => { cursor = next },
        handleInput: () => false,
        dispose: () => {},
      }
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()

  // No plugin keybinding resolver is installed. A declined printable key must
  // still use the host editor's editing semantics and update the VISIBLE
  // replacement, rather than mutating only the hidden host editor.
  const before = snapshots.length
  vt.sendInput('a')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'a')
  assert.equal(text, 'a')
  assert.equal(cursor, 1)
  assert.deepEqual(snapshots.slice(before), ['a@1'])
  app.dispose()
})

test('TuiApp: declined fallback preserves a multiline grapheme cursor (P1-R3)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  app.setDraft('one\n界👩‍💻x')
  let text = ''
  let cursor = 0
  const snapshots: string[] = []
  registry.register({
    id: 'declining-multiline', priority: 0,
    create: (editorHost) => {
      editorHost.subscribe(snapshot => snapshots.push(`${snapshot.text}@${snapshot.cursor}`))
      return {
        get component() { return { kind: 'text' as const, spans: [{ text }] } },
        getText: () => text,
        setText: (next) => { text = next },
        getCursor: () => cursor,
        setCursor: (next) => { cursor = next },
        handleInput: () => false,
        dispose: () => {},
      }
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()

  // Place the cursor immediately before x, after a CJK and a ZWJ emoji grapheme.
  // If fallback stages only setText(), the hidden host cursor lands at the end
  // and backspace deletes x instead of the preceding grapheme.
  app.seatEditorForTest().setCursor('one\n界👩‍💻'.length)
  const before = snapshots.length
  vt.sendInput('\x7f')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'one\n界x')
  assert.equal(text, 'one\n界x')
  assert.equal(cursor, 'one\n界'.length)
  assert.deepEqual(snapshots.slice(before), ['one\n界x@5'])
  app.dispose()
})

test('TuiApp: declined fallback normalizes CRLF and tabs before host editing', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  let text = ''
  let cursor = 0
  registry.register({
    id: 'declining-normalization', priority: 0,
    create: () => ({
      get component() { return { kind: 'text' as const, spans: [{ text }] } },
      getText: () => text,
      setText: next => { text = next },
      getCursor: () => cursor,
      setCursor: next => { cursor = next },
      handleInput: () => false,
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  text = 'a\r\nb\tc'
  cursor = 5
  vt.sendInput('\x7f')
  await vt.waitForRender()
  assert.equal(text, 'a\nb   c')
  assert.equal(cursor, 6)
  app.dispose()
})

test('TuiApp: declined fallback preserves autocomplete state for host completion', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  app.setCommandCompletions([
    { name: 'alpha', description: 'Alpha' },
    { name: 'alpine', description: 'Alpine' },
  ], '/tmp')
  let text = ''
  let cursor = 0
  registry.register({
    id: 'declining-autocomplete', priority: 0,
    create: () => ({
      get component() { return { kind: 'text' as const, spans: [{ text }] } },
      getText: () => text,
      setText: (next) => { text = next },
      getCursor: () => cursor,
      setCursor: (next) => { cursor = next },
      handleInput: () => false,
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  vt.sendInput('/')
  await vt.waitForRender()
  assert.equal(app.seatEditorForTest().getText(), '/')
  // A declined Tab must be handled by the host's completion path without
  // first clearing the autocomplete state during replacement staging.
  vt.sendInput('\t')
  await vt.waitForRender()
  assert.equal(app.seatEditorForTest().getText(), '/alpha ')
  assert.equal(app.seatEditorForTest().getCursor(), 7)
  vt.sendInput('a')
  await vt.waitForRender()
  assert.equal(app.seatEditorForTest().getText(), '/alpha a')
  assert.equal(app.seatEditorForTest().getCursor(), 8)
  assert.equal(app.getDraft(), '/alpha a')
  app.dispose()
})

test('TuiApp: declined fallback isolates replacement input errors', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const errors: string[] = []
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, {
    onSubmit: () => {},
    onExit: () => {},
    onExtensionError: event => errors.push(String(event.error)),
  }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  app.setDraft('draft')
  registry.register({
    id: 'throwing-fallback', priority: 0,
    create: () => ({
      component: { kind: 'text' as const, spans: [{ text: 'draft' }] },
      getText: () => 'draft',
      setText: () => { throw new Error('replacement sync failed') },
      handleInput: () => false,
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.doesNotThrow(() => vt.sendInput('a'))
  assert.ok(errors.some(error => error.includes('replacement sync failed')))
  app.dispose()
})

test('TuiApp: declined Enter preserves host autocomplete confirmation semantics', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const submitted: string[] = []
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: text => submitted.push(text), onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  app.setCommandCompletions([{ name: 'alpha', description: 'Alpha' }], '/tmp')
  let text = ''
  let cursor = 0
  registry.register({
    id: 'declining-enter-autocomplete', priority: 0,
    create: () => ({
      get component() { return { kind: 'text' as const, spans: [{ text }] } },
      getText: () => text,
      setText: next => { text = next },
      getCursor: () => cursor,
      setCursor: next => { cursor = next },
      handleInput: () => false,
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  vt.sendInput('/')
  await vt.waitForRender()
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, ['/alpha'])
  assert.equal(text, '')
  assert.equal(cursor, 0)
  app.dispose()
})

test('TuiApp: create-time EditorHost subscription survives the handoff commit', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  let host: EditorHost | undefined
  const snapshots: string[] = []
  registry.register({
    id: 'create-subscribe', priority: 0,
    create: editorHost => {
      host = editorHost
      editorHost.subscribe(snapshot => snapshots.push(snapshot.text))
      return pluginEditor()
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.ok(host !== undefined)
  app.setDraft('after-create')
  assert.deepEqual(snapshots, ['after-create'])
  app.dispose()
})

test('TuiApp: repeated declined Up events continue host history navigation', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  app.setDraft('first')
  app.submitDraft(false)
  app.setDraft('second')
  app.submitDraft(false)
  let text = ''
  let cursor = 0
  registry.register({
    id: 'declining-history', priority: 0,
    create: () => ({
      get component() { return { kind: 'text' as const, spans: [{ text }] } },
      getText: () => text,
      setText: (next) => { text = next },
      getCursor: () => cursor,
      setCursor: (next) => { cursor = next },
      handleInput: () => false,
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  vt.sendInput('\x1b[A')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'second')
  vt.sendInput('\x1b[A')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'first')
  app.dispose()
})

test('TuiApp: a plugin editor with handleInput receives SEMANTIC events, never raw bytes (P1-5)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
  }, {
    editorRegistry: registry,
    // The InputRouter gate only runs with a plugin resolver wired (M6);
    // an empty resolver keeps the routing ladder alive without any
    // binding claiming keys.
    pluginActionFor: () => undefined,
  })
  app.start()
  await vt.waitForRender()
  // A vim-like plugin editor: its OWN state machine owns every key. The
  // host routes editor events to handleInput as SEMANTIC events; the
  // plugin never sees raw terminal bytes (P1-5).
  let inputLog = ''
  const seenEvents: string[] = []
  registry.register({
    id: 'vimish', priority: 0,
    create: () => ({
      component: { kind: 'text', spans: [{ text: 'vim' }] },
      getText: () => inputLog,
      setText: (text) => { inputLog = text },
      getCursor: () => inputLog.length,
      setCursor: (offset) => { void offset },
      focused: true,
      handleInput: (event) => {
        // Accept plain printable text/key events; DECLINE Enter (the
        // host's own submit path owns submission — a plugin editor never
        // re-implements it), modifier chords and everything else.
        if (event.kind === 'key') {
          if (event.key.ctrl || event.key.alt || event.key.shift || event.key.super) return false
          if (event.key.key === 'enter') return false
          seenEvents.push(`key:${event.key.key}`)
          inputLog += event.key.key
          return true
        }
        if (event.kind === 'text') {
          seenEvents.push(`text:${event.text}`)
          inputLog += event.text
          return true
        }
        if (event.kind === 'paste') {
          seenEvents.push(`paste:${event.text}`)
          inputLog += event.text
          return true
        }
        return false
      },
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // REAL typing through the terminal: the plugin editor receives 'abc'
  // as semantic events, not the old host editor.
  vt.sendInput('a')
  vt.sendInput('b')
  vt.sendInput('c')
  await vt.waitForRender()
  assert.equal(inputLog, 'abc', 'ordinary typing must reach the PLUGIN editor (P1-5)')
  assert.ok(seenEvents.includes('key:a') && seenEvents.includes('key:b') && seenEvents.includes('key:c'),
    `typing must arrive as semantic KEY events: ${seenEvents.join(', ')}`)
  assert.equal(app.getDraft(), 'abc', 'the host reads the plugin draft')
  // Enter routes through the host submit path (the runner's onSubmit) —
  // and the submit CLEARS the plugin draft like a normal host submit.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.deepEqual(submitted, ['abc'], 'Enter submits the plugin draft through the host path')
  assert.equal(inputLog, '', 'the host submit clears the plugin draft (host-owned semantics)')
  // Events the plugin DECLINES (e.g. Ctrl+X) fall through to the host
  // (the host editor's own handler — the plugin never sees them).
  vt.sendInput('\x18') // ctrl+x — the plugin returns false
  await vt.waitForRender()
  assert.equal(inputLog, '', 'a declined event does not reach the plugin')
  app.stop()
})

test('TuiApp: terminal protocol normalization — legacy and CSI-u encodings reach the plugin as the SAME semantic key (P1-5)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, {
    editorRegistry: registry,
    pluginActionFor: () => undefined,
  })
  app.start()
  await vt.waitForRender()
  // The plugin editor records the NORMALIZED keys it receives.
  const received: string[] = []
  registry.register({
    id: 'normalizing', priority: 0,
    create: () => ({
      component: { kind: 'text', spans: [{ text: 'vim' }] },
      getText: () => '',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      focused: true,
      handleInput: (event) => {
        if (event.kind === 'key') received.push(`${event.key.key}:${event.key.ctrl ? 'c' : ''}${event.key.alt ? 'a' : ''}${event.key.shift ? 's' : ''}`)
        return true
      },
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // LEGACY encoding: arrow up = \x1b[A; Tab = \t. (Esc is a HOST-reserved
  // key — the app's double-Esc cancel consumes it before the editor route,
  // so it never reaches a plugin editor; the host owns it.)
  vt.sendInput('\x1b[A')
  vt.sendInput('\t')
  await vt.waitForRender()
  // CSI-u encoding (Kitty-style): arrow up = \x1b[1;1A; Tab = \x1b[9;1u.
  vt.sendInput('\x1b[1;1A')
  vt.sendInput('\x1b[9;1u')
  await vt.waitForRender()
  // The plugin sees the SAME normalized keys regardless of the encoding.
  assert.deepEqual(received, [
    'up:', 'tab:',
    'up:', 'tab:',
  ], `legacy and CSI-u encodings must normalize to the SAME semantic keys (P1-5): ${received.join(', ')}`)
  app.stop()
})

test('TuiApp: display-only replacement editor never routes typing into the hidden host editor (P2-R5)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const submitted: string[] = []
  const app = new TuiApp(vt, {
    onSubmit: (text) => submitted.push(text),
    onExit: () => {},
  }, {
    editorRegistry: registry,
    // An empty resolver keeps the routing ladder alive without any
    // binding claiming keys (same wiring as the P1-10 test).
    pluginActionFor: () => undefined,
  })
  app.start()
  await vt.waitForRender()
  // A display-only plugin editor: NO handleInput hook. The public contract
  // (public-types.ts:811-812) says ordinary typing is NOT silently routed
  // into the hidden host editor while this seat is visible.
  let text = ''
  registry.register({
    id: 'display-only', priority: 0,
    create: () => ({
      get component() { return { kind: 'text' as const, spans: [{ text }] } },
      getText: () => text,
      setText: (next) => { text = next },
      getCursor: () => 0,
      setCursor: () => {},
      focused: true,
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.equal(app.seatEditorForTest().id, 'display-only')
  // Ordinary typing must NOT reach the display-only editor (it owns no
  // input channel) and must NOT be routed into the hidden host editor.
  vt.sendInput('a')
  vt.sendInput('b')
  vt.sendInput('c')
  await vt.waitForRender()
  assert.equal(text, '', 'the display-only editor must not receive typing')
  assert.equal(app.hostEditorTextForTest(), '', 'typing must not leak into the hidden host editor (P2-R5)')
  assert.equal(app.getDraft(), '', 'the visible seat draft stays untouched')
  // Enter submits nothing (the seat draft is empty) and must not leak into
  // the hidden host editor either.
  vt.sendInput('\r')
  await vt.waitForRender()
  assert.equal(app.hostEditorTextForTest(), '', 'Enter must not leak into the hidden host editor')
  assert.deepEqual(submitted, [], 'an empty display-only draft submits nothing')
  app.stop()
})

test('TuiApp: the HOST seat still routes ordinary typing normally (P2-R5 guard)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  assert.equal(app.seatEditorForTest().id, 'host')
  vt.sendInput('a')
  vt.sendInput('b')
  await vt.waitForRender()
  assert.equal(app.hostEditorTextForTest(), 'ab', 'the host seat must keep normal editing')
  assert.equal(app.getDraft(), 'ab', 'the host draft is the seat draft')
  app.stop()
})

test('TuiApp: a TRANSFER throw disposes the newly created editor — no leak, current stays (P2-02)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  app.setDraft('keep me')
  let createdDisposed = false
  const created: ExtensionEditor = {
    component: { kind: 'text', spans: [{ text: 'x' }] },
    getText: () => '',
    setText: () => { throw new Error('transfer boom') }, // the transfer THROWS
    getCursor: () => 0,
    setCursor: () => {},
    focused: true,
    dispose: () => { createdDisposed = true },
  }
  registry.register({ id: 'transfer-boom', priority: 0, create: () => created }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.equal(createdDisposed, true, 'a transfer throw must dispose the created editor (P2-02)')
  assert.equal(app.getDraft(), 'keep me', 'the current editor keeps working')
  // The failed target is inert until the registry changes (no re-create loop).
  app.reconcileEditorNow()
  assert.equal(app.getDraft(), 'keep me')
  app.stop()
})

test('TuiApp: a COMPILE throw after transfer disposes the created editor too (P2-02)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  app.setDraft('keep')
  let createdDisposed = false
  const created: ExtensionEditor = {
    // The view's spans getter THROWS at COMPILE time (after the transfer
    // succeeded — the P2-02 compile-throw resource path).
    get component(): never { throw new Error('view boom') },
    getText: () => '',
    setText: () => {},
    getCursor: () => 0,
    setCursor: () => {},
    focused: true,
    dispose: () => { createdDisposed = true },
  }
  registry.register({ id: 'view-boom', priority: 0, create: () => created }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.equal(createdDisposed, true, 'a compile throw after transfer must dispose the created editor')
  assert.equal(app.getDraft(), 'keep', 'the current editor keeps working')
  app.stop()
})

// ── Round-1 regression tests ───────────────────────────────────────────────

test('TuiApp: a failed editor creation is retried after a same-id re-registration (round-1 finding 4)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  // First registration: create() throws → the guard makes it inert.
  let failing = true
  const handle1 = registry.register({
    id: 'retry-editor', priority: 0,
    create: (host: EditorHost) => {
      if (failing) throw new Error('first attempt fails')
      return pluginEditor()
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.equal(app.getDraft(), '', 'the host editor still works after the failed creation')
  // Dispose the failing registration and re-register the SAME id now
  // successful: the registry revision bumps → the guard clears.
  handle1.dispose()
  failing = false
  registry.register({
    id: 'retry-editor', priority: 0,
    create: (host: EditorHost) => pluginEditor(),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // The successful same-id editor now occupies the seat.
  app.setDraft('retried draft')
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'retried draft')
  app.stop()
})

test('TuiApp: the editor host dispatch clears the plugin draft through the host submit path (round-1 finding 2)', async () => {
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
  app.setDraft('plugin draft')
  let host: EditorHost | undefined
  registry.register({
    id: 'submitter', priority: 0,
    create: (editorHost: EditorHost) => {
      host = editorHost
      return pluginEditor()
    },
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.ok(host !== undefined)
  const result = host.dispatch('submit')
  assert.equal(result.kind, 'accepted')
  assert.deepEqual(submitted, ['plugin draft'], 'the draft submitted through the host path')
  assert.equal(app.getDraft(), '', 'the seat draft was cleared like a normal submit')
  app.stop()
})

// ── Round-2 regression tests ───────────────────────────────────────────────

test('TuiApp: the subagent viewer covers a PLUGIN editor and restores its draft (round-2 finding 1)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  app.setDraft('plugin viewer draft')
  registry.register({ id: 'viewer-editor', priority: 0, create: () => pluginEditor() }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'plugin viewer draft')
  // Enter the viewer: the SEAT shows the placeholder; the preserved
  // draft stays in mainDraftBeforeViewer (getDraft returns it — the real
  // draft must never be lost while viewing).
  app.setViewerMode({ parentSessionId: 'session-main', childSessionId: 'child-1', label: 'child', mode: 'one-shot', activity: 'running' })
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'plugin viewer draft',
    'getDraft preserves the real draft while viewing (never the placeholder)')
  // The seat text is the placeholder (the plugin editor's component was
  // covered). Probe via the holder's current editor:
  const seatText = app.seatTextForTest()
  assert.equal(seatText, 'viewing subagent: child — one-shot · read-only · Esc returns',
    'the placeholder covers the CURRENT seat occupant')
  // Exit: the draft returns to the PLUGIN editor (the current occupant).
  app.setViewerMode(undefined)
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'plugin viewer draft', 'the draft restores into the plugin editor')
  app.stop()
})

test('TuiApp: a plugin editor survives a fullscreen toggle with focus intact (round-2 finding 2)', async () => {
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
  app.setDraft('fs plugin draft')
  registry.register({ id: 'fs-editor', priority: 0, create: () => pluginEditor() }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // Fullscreen in: the plugin editor's component receives focus (text
  // input works — a submit after the toggle reads the plugin draft).
  app.setFullscreen(true)
  await vt.waitForRender()
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(submitted, ['fs plugin draft'], 'submit works in fullscreen with a plugin occupant')
  // Fullscreen out: focus returns to the seat occupant.
  app.setFullscreen(false)
  await vt.waitForRender()
  app.setDraft('after fs')
  app.submitDraft(false)
  await vt.waitForRender()
  assert.deepEqual(submitted, ['fs plugin draft', 'after fs'], 'submit works after returning to regular')
  app.stop()
})

test('TuiApp: a broken plugin view (compile throw) keeps the old editor working (round-2 finding 3)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  app.setDraft('still alive')
  // A plugin whose component view THROWS during compilation (the view's
  // spans getter explodes — the compiler's renderSpans path throws).
  registry.register({
    id: 'broken-view', priority: 0,
    create: () => ({
      component: {
        kind: 'text',
        get spans(): never { throw new Error('view compile boom') },
      } as never,
      getText: () => 'broken',
      setText: () => {},
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // The old editor keeps working (the compile throw was atomic).
  assert.equal(app.getDraft(), 'still alive', 'the old editor survives a broken plugin view')
  app.stop()
})

test('TuiApp: a plugin editor view REPAINTS after setText + invalidate (round-2 P1 live view)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  // A plugin editor whose VIEW reads the CURRENT state (a getter-backed
  // component) — the fixture pattern: the view object re-reads state.
  // The host draft transfers in at the handoff (never the plugin's own
  // initial value).
  app.setDraft('initial')
  const state = { text: 'initial' }
  registry.register({
    id: 'live-view', priority: 0,
    create: (host: import('../src/extension/public-types.ts').EditorHost) => ({
      get component(): import('../src/extension/public-types.ts').ExtensionView {
        // A FRESH view object per compile — the compiler reads spans at
        // construction; the seat recompiles on invalidate.
        return { kind: 'text', spans: [{ text: state.text }] }
      },
      getText: () => state.text,
      setText: (text) => {
        state.text = text
        // The fixture pattern: the plugin editor requests a repaint
        // through the host (the seat recompiles the live view).
        host.invalidate()
      },
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  const before = app.seatTextForTest()
  assert.equal(before, 'initial')
  // Change the text through the seat + invalidate (the fixture's editor
  // calls host.invalidate() after setText).
  app.setDraft('changed text')
  app.reconcileEditorNow()
  await vt.waitForRender()
  // The seat's invalidate recompiled the view: the seat's component now
  // renders the NEW text (probe via a fresh compile of the current view).
  // The TERMINAL must show the new text (round-3 finding 2: the repro is
  // the SCREEN, not the compiled component).
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  const screen = vt.getViewport().map(strip).join('\n')
  assert.ok(screen.includes('changed text'), `the terminal must repaint the new text:\n${screen}`)
  assert.ok(!screen.includes('initial'), `the old text must be gone:\n${screen}`)
  app.stop()
})

test('TuiApp: a compile throw inside invalidate() is isolated — the host keeps working (round-3 finding 1)', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const registry = new EditorRegistry()
  const vt = new VirtualTerminal(80, 24)
  const notices: string[] = []
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  app.setDraft('before')
  let writes = 0
  let explode = false
  let text = 'before'
  registry.register({
    id: 'exploding-view', priority: 0,
    create: (host: import('../src/extension/public-types.ts').EditorHost) => ({
      get component(): import('../src/extension/public-types.ts').ExtensionView {
        if (explode) throw new Error('view compile boom')
        return { kind: 'text', spans: [{ text }] }
      },
      getText: () => text,
      setText: (next) => {
        text = next
        // The FIRST write is the handoff transfer (must succeed — the
        // view compiles with explode still false). The SECOND write is a
        // POST-MOUNT state change: the host invalidate recompiles and
        // THROWS — the exception must not escape into the host path.
        writes += 1
        if (writes >= 2) explode = true
        host.invalidate()
      },
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  await vt.waitForRender()
  const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
  // A post-mount setText triggers the throwing recompile: the host must
  // survive (no unhandled exception escaping the input path), the failure
  // is surfaced through the host notify path, and the seat's state stays
  // consistent.
  app.setDraft('after')
  await vt.waitForRender()
  const screen = vt.getViewport().map(strip).join('\n')
  assert.equal(app.getDraft(), 'after', 'the host editor state stays consistent')
  // The notifyError → notify path surfaced the failure (round-4
  // follow-up 1): the notice line carries 'editor failed'.
  assert.ok(screen.includes('editor failed'), `the failure must surface via notify:\n${screen}`)
  // The OLD compiled component is still mounted (no swap happened — the
  // throwing recompile kept the previous component): the seat's component
  // renders the PRE-failure view.
  const seat = app.seatEditorForTest()
  const compiled = seat.component.render(80).join('\n')
  assert.ok(compiled.includes('before'), 'the previous compiled view must be retained (no swap)')
  // No infinite reconcile/render loop: one more settle completes.
  await vt.waitForRender()
  app.stop()
})

// Re-vendor lifecycle follow-up P1 (plan §4 P1-D, review-loop round 1):
// the compiled component lifecycle is OWNED by the holder — the non-owning
// seat mount never disposes, so the holder must release the superseded
// compiled component at handoff and the current one at final disposal,
// exactly once each. A compiled ROWS view is a Container: its dispose
// detaches children, which is the observable "released" state.
function rowsFixture(rows: string[]): ExtensionEditor & { doc: string } {
  const state = { doc: '' }
  // EXPLICIT ExtensionView typing: a ROWS view compiles into a Container
  // whose dispose() detaches children — the exactly-once observable.
  const editor: ExtensionEditor = {
    get component(): import('../src/extension/public-types.ts').ExtensionView {
      const rowViews: import('../src/extension/public-types.ts').ExtensionView[] = rows.map(row => ({
        kind: 'text',
        spans: [{ text: row }],
      }))
      return { kind: 'rows', rows: rowViews }
    },
    getText: () => state.doc,
    setText: (text) => { state.doc = text },
    getCursor: () => 0,
    setCursor: () => {},
    dispose: () => {},
  }
  return { ...editor, doc: state.doc }
}

test('EditorSeatHolder: the superseded compiled component is released exactly at handoff (plan P1-D)', () => {
  const holder = new EditorSeatHolder({
    hostAdapter: () => seatHostAdapter(),
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: () => {},
    viewSwap: () => {},
  })
  const a = rowsFixture(['row a1', 'row a2'])
  holder.handoff({ id: 'a', create: () => a })
  // A compiled rows view holds its children while alive.
  const compiledA = holder.currentEditor().component as unknown as { children: unknown[] }
  assert.equal(compiledA.children.length, 2, 'A compiles with its rows')
  // Handoff A → B: the superseded compiled component must be disposed
  // (Container.dispose detaches its children) EXACTLY here — the seat
  // mount never does it.
  const b = rowsFixture(['row b1'])
  holder.handoff({ id: 'b', create: () => b })
  assert.equal(compiledA.children.length, 0, 'the superseded compiled component must be released at the handoff')
  const compiledB = holder.currentEditor().component as unknown as { children: unknown[] }
  assert.equal(compiledB.children.length, 1, 'B compiles with its rows')
  // Final disposal releases the CURRENT compiled component exactly once.
  holder.dispose()
  assert.equal(compiledB.children.length, 0, 'the final holder dispose must release the current compiled component')
  // Idempotent: a repeated dispose does not double-dispose (Container is
  // idempotent — the detach is a no-op and no throw escapes).
  holder.dispose()
  assert.equal(compiledB.children.length, 0)
})

test('EditorSeatHolder: restoring the host releases the plugin compiled component exactly once (plan P1-D)', () => {
  const holder = new EditorSeatHolder({
    hostAdapter: () => seatHostAdapter(),
    surfaceId: 'test-surface',
    generation: () => 1,
    actionSink: () => false,
    notifyError: () => {},
    viewSwap: () => {},
  })
  const a = rowsFixture(['plugin row'])
  holder.handoff({ id: 'a', create: () => a })
  const compiledA = holder.currentEditor().component as unknown as { children: unknown[] }
  assert.equal(compiledA.children.length, 1)
  // Handoff back to the host default: the plugin's compiled component is
  // released at the restore (the seat mount never disposes).
  holder.handoff(undefined)
  assert.equal(holder.currentEditor().id, 'host')
  assert.equal(compiledA.children.length, 0, 'the restore-to-host handoff must release the plugin compiled component')
  // The host seat's component (the fork Editor / a plain Text) has no
  // owner release — the final dispose stays a no-op for it.
  holder.dispose()
})
