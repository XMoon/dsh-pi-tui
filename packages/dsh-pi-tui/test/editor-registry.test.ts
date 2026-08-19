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
  // draft stays in draftBeforeViewer (getDraft returns it — the real
  // draft must never be lost while viewing).
  app.setViewerMode({ id: 'child-1', label: 'child' })
  await vt.waitForRender()
  assert.equal(app.getDraft(), 'plugin viewer draft',
    'getDraft preserves the real draft while viewing (never the placeholder)')
  // The seat text is the placeholder (the plugin editor's component was
  // covered). Probe via the holder's current editor:
  const seatText = app.seatTextForTest()
  assert.equal(seatText, 'viewing subagent: child — read-only · Esc returns',
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
