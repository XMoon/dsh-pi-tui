/**
 * Phase 2 tests (plan §14): the ADVANCED editor controls — get/set/insert/
 * paste/focus through the host's editor seat, state preserved across seat
 * handoff, and stale-host inertness.
 * @module @xmoon76/dsh-pi-tui/advanced-editor.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

test('advanced editor controls: get/set/cursor/insert/paste through the seat', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  const controls = app.advancedEditorControlsForTest()
  // getEditorState reflects the live seat.
  assert.deepEqual(controls.getEditorState(), { text: '', cursor: 0, focused: true, replacementId: undefined, composing: false })
  // setEditorText replaces the draft.
  controls.setEditorText('hello')
  assert.equal(app.seatTextForTest(), 'hello')
  assert.equal(controls.getEditorState().text, 'hello')
  // setEditorCursor moves the cursor.
  controls.setEditorCursor(2)
  assert.equal(controls.getEditorState().cursor, 2)
  // insertEditorText inserts at the cursor by default.
  controls.insertEditorText('XX')
  assert.equal(app.seatTextForTest(), 'heXXllo')
  assert.equal(controls.getEditorState().cursor, 4)
  // insertEditorText at an explicit offset.
  controls.insertEditorText('!', 0)
  assert.equal(app.seatTextForTest(), '!heXXllo')
  // pasteToEditor inserts at the cursor.
  controls.setEditorCursor(0)
  controls.pasteToEditor('P')
  assert.equal(app.seatTextForTest(), 'P!heXXllo')
  app.stop()
})

test('advanced editor controls: state is preserved across a plugin-editor seat handoff', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const { EditorRegistry } = await import('../src/editor-registry.ts')
  const vt = new VirtualTerminal(80, 24)
  const registry = new EditorRegistry()
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  await vt.waitForRender()
  const controls = app.advancedEditorControlsForTest()
  controls.setEditorText('draft before handoff')
  // A plugin editor wins the seat (the atomic handoff transfers the draft).
  let pluginText = ''
  registry.register({
    id: 'plugin-editor',
    priority: 1,
    create: () => ({
      component: { kind: 'text', spans: [{ text: pluginText }] },
      getText: () => pluginText,
      setText: (text) => { pluginText = text },
      getCursor: () => 0,
      setCursor: () => {},
      dispose: () => {},
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  assert.equal(app.seatEditorForTest().id, 'plugin-editor')
  assert.equal(app.seatTextForTest(), 'draft before handoff', 'the draft survived the handoff')
  // The advanced controls now drive the PLUGIN editor through the seat.
  controls.setEditorText('driven by advanced')
  assert.equal(pluginText, 'driven by advanced')
  assert.equal(controls.getEditorState().text, 'driven by advanced')
  // Winner unload restores the host default, preserving the draft.
  registry.dispose('plugin-editor')
  app.reconcileEditorNow()
  assert.equal(app.seatEditorForTest().id, 'host')
  assert.equal(app.seatTextForTest(), 'driven by advanced', 'the draft survived the restore')
  app.stop()
})

test('advanced editor controls: a disposed surface is inert', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  const controls = app.advancedEditorControlsForTest()
  app.dispose()
  // Every control must be a safe no-op on the dead surface.
  controls.setEditorText('late')
  controls.setEditorCursor(1)
  controls.insertEditorText('x')
  controls.pasteToEditor('y')
  controls.requestEditorFocus()
  assert.equal(controls.getEditorState().text, '')
})

test('advanced editor controls: requestEditorFocus is a no-op while a capturing flow owns the seat', async () => {
  const { VirtualTerminal } = await import('./virtual-terminal.ts')
  const { TuiApp } = await import('../src/tui-app.ts')
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  await vt.waitForRender()
  const controls = app.advancedEditorControlsForTest()
  // An ADVANCED interactive overlay owns the seat: requestEditorFocus must
  // not steal focus from it.
  const lease = app.showAdvancedInteractiveOverlay({
    render: () => ({ kind: 'text', spans: [{ text: 'overlay' }] }),
    dispose: () => {},
  })
  await vt.waitForRender()
  assert.equal(lease.focused, true, 'the interactive overlay owns focus')
  controls.requestEditorFocus()
  assert.equal(lease.focused, true, 'requestEditorFocus must not steal the overlay focus')
  lease.close()
  app.stop()
})
