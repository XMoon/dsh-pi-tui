/**
 * Re-vendor lifecycle follow-up P1 gates: the editor seat is a NON-OWNING
 * mount slot. The vendored Container is an owning container (X007:
 * clear/removeChild/dispose release child resources), but the seat only
 * PROJECTS the current occupant — the EditorSeatHolder owns the
 * replacement editor + compiled component, the question flow state owns
 * the QuestionFrame. mount/detach ≠ dispose; only handoff / final
 * teardown dispose (plan §2, §3, §4, §17).
 *
 * Every test here uses a REAL replacement editor through the public
 * editor registry + component compiler (never a mocked seat).
 * @module @xmoon76/dsh-pi-tui/editor-seat-non-owning.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TuiApp } from '../src/tui-app.ts'
import { EditorRegistry } from '../src/editor-registry.ts'
import { EditorSeatMount } from '../src/editor-seat.ts'
import type { EditorHost, ExtensionEditor, ExtensionView } from '../src/extension/public-types.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

function startApp(registry: EditorRegistry): { vt: VirtualTerminal; app: TuiApp } {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { editorRegistry: registry })
  app.start()
  return { vt, app }
}

/** The visible viewport, stripped of ANSI, joined for substring checks. */
function viewport(vt: VirtualTerminal): string {
  return vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/g, '')).join('\n')
}

/** A replacement editor whose view is a ROWS tree (compiles into a
 * Container with child rows — the plan's Case A shape: `examples/plugins/
 * vim` extension views compile the same way). The view is a getter so a
 * fresh compile reads the CURRENT rows. The DOCUMENT (getText/setText) is
 * a separate field on purpose: the handoff transfers the previous seat's
 * draft into the document, which must never clobber the DISPLAYED rows. */
function rowsEditor(state: { rows: string[] }): ExtensionEditor {
  let doc = ''
  return {
    get component(): ExtensionView {
      return {
        kind: 'rows',
        rows: state.rows.map(row => ({ kind: 'text', spans: [{ text: row }] })),
      }
    },
    getText: () => doc,
    setText: (text) => { doc = text },
    getCursor: () => 0,
    setCursor: () => {},
    dispose: () => {},
  }
}

test('EditorSeatMount never disposes its occupant (the mount contract is non-owning)', () => {
  const mount = new EditorSeatMount()
  let disposed = 0
  const spy = {
    render: () => ['x'],
    invalidate: () => {},
    dispose: () => { disposed += 1 },
  }
  // replace() swaps the occupant WITHOUT disposing the previous one.
  mount.replace(spy)
  mount.replace({ render: () => ['y'], invalidate: () => {} })
  assert.equal(disposed, 0, 'a seat swap must never dispose the replaced occupant')
  // clear()/removeChild()/dispose() are overridden to only re-point
  // children — the owning vendored Container semantics must not leak in
  // (plan §19: any remaining `editorSeat.clear()` must be a non-owning
  // override).
  mount.replace(spy)
  mount.removeChild(spy)
  assert.equal(disposed, 0, 'removeChild must never dispose the seat occupant')
  mount.replace(spy)
  mount.clear()
  assert.equal(disposed, 0, 'clear must never dispose the seat occupant')
  mount.replace(spy)
  mount.dispose()
  assert.equal(disposed, 0, 'the mount must never dispose the seat occupant')
})

test('P1-A: a replacement editor survives a question round-trip (child tree stays alive)', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  const state = { rows: ['row one', 'row two'] }
  registry.register({ id: 'roundtrip', priority: 0, create: () => rowsEditor(state) }, 'plugin')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  let screen = viewport(vt)
  assert.ok(screen.includes('row one'), `replacement editor missing:\n${screen}`)
  assert.ok(screen.includes('row two'), `replacement editor missing:\n${screen}`)
  // The question flow REPLACES the editor in the physical seat.
  const promise = app.askQuestions([{ id: 'q1', question: 'continue?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  screen = viewport(vt)
  assert.ok(screen.includes('continue?'), `question missing:\n${screen}`)
  assert.ok(!screen.includes('row one'), `the editor must be detached while the question owns the seat:\n${screen}`)
  // Answer: confirm the option, then submit on the review page.
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  screen = viewport(vt)
  // The round-trip must NOT have disposed the compiled component tree: a
  // disposed Container renders its children list empty (the old owning
  // clear() path disposed the child tree on the question's seat takeover).
  assert.ok(screen.includes('row one'), `the compiled child tree must survive the round-trip:\n${screen}`)
  assert.ok(screen.includes('row two'), `the compiled child tree must survive the round-trip:\n${screen}`)
  app.stop()
})

test('P1-B: plugin invalidate during an active question keeps the QuestionFrame mounted; the latest view mounts after settle', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  const state = { text: 'before' }
  registry.register({
    id: 'live-view', priority: 0,
    create: (host: EditorHost) => ({
      get component(): ExtensionView {
        return { kind: 'text', spans: [{ text: state.text }] }
      },
      getText: () => state.text,
      setText: (text) => {
        state.text = text
        // The fixture pattern: the plugin requests a repaint through the
        // host (the seat recompiles the live view).
        host.invalidate()
      },
      getCursor: () => 0,
      setCursor: () => {},
      dispose: () => {},
    }),
  }, 'plugin')
  // Seed the host draft BEFORE the handoff so the transferred document is
  // `before` (the handoff never keeps the plugin's own initial value).
  app.setDraft('before')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  let screen = viewport(vt)
  assert.ok(screen.includes('before'), `replacement editor missing:\n${screen}`)
  const promise = app.askQuestions([{ id: 'q1', question: 'continue?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  screen = viewport(vt)
  assert.ok(screen.includes('continue?'), `question missing:\n${screen}`)
  // Plugin state changes while the question owns the seat: the holder
  // state may update, the PHYSICAL seat may not (plan §2.4).
  app.setDraft('after')
  await vt.waitForRender()
  screen = viewport(vt)
  assert.ok(screen.includes('continue?'), `the QuestionFrame must STILL be physically mounted:\n${screen}`)
  assert.ok(!screen.includes('after'), `the recompiled view must NOT displace the QuestionFrame while captured:\n${screen}`)
  assert.equal(app.seatTextForTest(), 'after', 'the holder state must update while captured')
  // The frame is still FOCUSED: it consumes keys and can be answered.
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  screen = viewport(vt)
  assert.ok(screen.includes('after'), `the LATEST compiled view must mount after settle:\n${screen}`)
  assert.ok(!screen.includes('before'), `the stale view must be gone:\n${screen}`)
  app.stop()
})

test('P1-C: an editor winner change during an active question keeps the QuestionFrame; the latest winner mounts after settle', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  const a = { rows: ['editor A'] }
  registry.register({ id: 'a', priority: 0, create: () => rowsEditor(a) }, 'plugin-a')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  let screen = viewport(vt)
  assert.ok(screen.includes('editor A'), `editor A missing:\n${screen}`)
  const promise = app.askQuestions([{ id: 'q1', question: 'continue?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  screen = viewport(vt)
  assert.ok(screen.includes('continue?'), `question missing:\n${screen}`)
  // The winner changes while the question owns the seat (lower priority
  // wins — the registry's winner rule).
  const b = { rows: ['editor B'] }
  registry.register({ id: 'b', priority: -1, create: () => rowsEditor(b) }, 'plugin-b')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  screen = viewport(vt)
  assert.ok(screen.includes('continue?'), `the QuestionFrame must remain mounted across the winner change:\n${screen}`)
  assert.ok(!screen.includes('editor B'), `the new winner must NOT displace the QuestionFrame while captured:\n${screen}`)
  // Answer: the frame is still focused and resolves the flow.
  vt.sendInput('\r')
  vt.sendInput('\r')
  assert.deepEqual(await promise, [{ id: 'q1', selected: ['Yes'] }])
  await vt.waitForRender()
  screen = viewport(vt)
  assert.ok(screen.includes('editor B'), `the LATEST winner must mount after settle (not the old A):\n${screen}`)
  assert.ok(!screen.includes('editor A'), `the superseded editor must be gone:\n${screen}`)
  assert.equal(app.seatEditorForTest().id, 'b', 'the holder must keep the new winner selected')
  app.stop()
})

test('P1-D: TuiApp.dispose releases the replacement editor exactly once', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  let disposeCalls = 0
  registry.register({
    id: 'once', priority: 0,
    create: () => ({
      component: { kind: 'text', spans: [{ text: 'x' }] },
      getText: () => 'x',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      dispose: () => { disposeCalls += 1 },
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  app.requestRender()
  assert.equal(app.seatEditorForTest().id, 'once')
  // FINAL teardown: the holder is the ONLY owner of the replacement — the
  // non-owning seat mount never disposes it, so the holder must release it
  // exactly once (plan Risk C).
  app.dispose()
  assert.equal(disposeCalls, 1, 'the final TuiApp dispose must release the replacement editor exactly once')
  // Idempotent: a repeated dispose is a no-op — no duplicate disposal.
  app.dispose()
  assert.equal(disposeCalls, 1, 'a repeated dispose must not double-dispose the replacement editor')
})

test('P1-D2: TuiApp.dispose releases the replacement exactly once even with a question open', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  let disposeCalls = 0
  registry.register({
    id: 'open-question', priority: 0,
    create: () => ({
      component: { kind: 'text', spans: [{ text: 'x' }] },
      getText: () => 'x',
      setText: () => {},
      getCursor: () => 0,
      setCursor: () => {},
      dispose: () => { disposeCalls += 1 },
    }),
  }, 'plugin')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  const promise = app.askQuestions([{ id: 'q1', question: 'continue?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  app.dispose()
  assert.equal(disposeCalls, 1, 'a dispose with an open question must still release the replacement exactly once')
  await assert.rejects(promise, /cancelled/)
})

test('P1-E: queued question transfer keeps the editor alive but detached until the last flow closes', async () => {
  const registry = new EditorRegistry()
  const { vt, app } = startApp(registry)
  await vt.waitForRender()
  const state = { rows: ['row one'] }
  registry.register({ id: 'queued', priority: 0, create: () => rowsEditor(state) }, 'plugin')
  app.reconcileEditorNow()
  app.requestRender()
  await vt.waitForRender()
  let screen = viewport(vt)
  assert.ok(screen.includes('row one'), `replacement editor missing:\n${screen}`)
  const first = app.askQuestions([{ id: 'q1', question: 'first?', options: [{ label: 'Yes' }] }])
  const second = app.askQuestions([{ id: 'q2', question: 'second?', options: [{ label: 'Yes' }] }])
  await vt.waitForRender()
  screen = viewport(vt)
  assert.ok(screen.includes('first?'), `first flow missing:\n${screen}`)
  // Settle the first flow: the SECOND frame mounts DIRECTLY (the editor is
  // never restored between two queued flows — and never disposed either).
  vt.sendInput('\r')
  vt.sendInput('\r')
  await vt.waitForRender()
  screen = viewport(vt)
  assert.ok(screen.includes('second?'), `second flow must mount on first settle:\n${screen}`)
  assert.ok(!screen.includes('row one'), `the editor must stay detached between queued flows:\n${screen}`)
  assert.deepEqual(await first, [{ id: 'q1', selected: ['Yes'] }])
  // Settle the second flow: the editor component comes back ALIVE (the
  // transfer never disposed it).
  vt.sendInput('\r')
  vt.sendInput('\r')
  await vt.waitForRender()
  screen = viewport(vt)
  assert.ok(screen.includes('row one'), `the editor must be restored exactly once after the last flow:\n${screen}`)
  assert.deepEqual(await second, [{ id: 'q2', selected: ['Yes'] }])
  app.stop()
})
