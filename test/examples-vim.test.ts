/**
 * Phase 5 tests (plan §18): the VIM example plugin's REAL behavior —
 * the modal state machine driven through the public editor SDK (semantic
 * EditorInputEvent only, never raw bytes), proving the Advanced editor
 * seam is sufficient for a production-class modal editor prototype.
 * @module @xmoon76/dsh-pi-tui/examples-vim.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { EditorHost, EditorInputEvent, ExtensionEditor, NormalizedKey } from '../src/extension/public-types.ts'

/** A normalized key helper. */
function key(name: string, modifiers: Partial<NormalizedKey> = {}): NormalizedKey {
  return { key: name, ctrl: false, alt: false, shift: false, super: false, ...modifiers }
}

/** A mock EditorHost (the seat's host contract). */
function mockHost(initial = ''): EditorHost & { dispatched: string[]; invalidations: number } {
  const state = { dispatched: [] as string[], invalidations: 0 }
  return {
    surfaceId: 'test',
    generation: 1,
    getSnapshot: () => ({ text: initial, cursor: 0, focused: true, composing: false }),
    replaceText: () => {},
    dispatch: (action) => { state.dispatched.push(action); return { kind: 'accepted' } },
    subscribe: () => () => {},
    invalidate: () => { state.invalidations += 1 },
    get dispatched() { return state.dispatched },
    get invalidations() { return state.invalidations },
  }
}

/** Load the vim example and create its editor through the public SDK. */
async function createVimEditor(initial = ''): Promise<{ editor: ExtensionEditor; host: ReturnType<typeof mockHost> }> {
  const { apply } = await import('../examples/plugins/vim/src/index.ts')
  const contributions: Array<{ create(host: EditorHost): ExtensionEditor }> = []
  const mockService = {
    api: () => ({ capabilities: new Set(['slot.chrome.header.badge']) }),
    registerEditor: (contribution: { create(host: EditorHost): ExtensionEditor }) => {
      contributions.push(contribution)
      return { id: 'example-vim', dispose: () => {} }
    },
  }
  apply({ get: () => mockService } as never)
  assert.equal(contributions.length, 1, 'the vim example registers one editor')
  const host = mockHost(initial)
  const editor = contributions[0]!.create(host)
  return { editor, host }
}

/** Send one semantic key event. */
function press(editor: ExtensionEditor, name: string, modifiers: Partial<NormalizedKey> = {}): void {
  editor.handleInput?.({ kind: 'key', key: key(name, modifiers) })
}

test('vim example: insert mode types text; Esc returns to normal; x deletes', async () => {
  const { editor } = await createVimEditor('hello world')
  // i → insert mode; typing inserts at the cursor (0).
  press(editor, 'i')
  editor.handleInput?.({ kind: 'text', text: 'X' })
  assert.equal(editor.getText(), 'Xhello world')
  // Esc → normal (cursor moves back one); $ → line end; x deletes the
  // char AT the cursor.
  press(editor, 'escape')
  press(editor, '$')
  press(editor, 'x')
  assert.equal(editor.getText(), 'Xhello worl')
  press(editor, 'x')
  assert.equal(editor.getText(), 'Xhello wor')
})

test('vim example: word movement, line ops, undo/redo, yank/paste', async () => {
  const { editor } = await createVimEditor('one two three')
  // 0 → line start; w → the next word START (vim semantics); x deletes
  // the 't' of 'two'.
  press(editor, '0')
  press(editor, 'w')
  press(editor, 'x')
  assert.equal(editor.getText(), 'one wo three')
  // u → undo restores the 't'.
  press(editor, 'u')
  assert.equal(editor.getText(), 'one two three')
  // Ctrl+R → redo re-deletes it.
  press(editor, 'r', { ctrl: true })
  assert.equal(editor.getText(), 'one wo three')
  // 0 → line start; yy yanks the line; p pastes after the cursor.
  press(editor, '0')
  press(editor, 'y')
  press(editor, 'p')
  assert.equal(editor.getText(), 'one wo threeone wo three')
  // dd deletes the line.
  press(editor, 'd')
  assert.equal(editor.getText(), '')
})

test('vim example: multi-line editing (o, Enter, j/k movement)', async () => {
  const { editor } = await createVimEditor('line1')
  // o opens a new line below in insert mode.
  press(editor, 'o')
  editor.handleInput?.({ kind: 'text', text: 'line2' })
  assert.equal(editor.getText(), 'line1\nline2')
  // Esc → normal; k moves up (the preserved column clamps to the target
  // line's LAST char); a appends at the end of line1.
  press(editor, 'escape')
  press(editor, 'k')
  press(editor, 'a')
  editor.handleInput?.({ kind: 'text', text: '!' })
  assert.equal(editor.getText(), 'line1!\nline2')
  // Esc → normal; j moves down; a appends at the end of line2; Enter
  // inserts a newline; typing fills the new line.
  press(editor, 'escape')
  press(editor, 'j')
  press(editor, 'a')
  editor.handleInput?.({ kind: 'key', key: key('enter') })
  editor.handleInput?.({ kind: 'text', text: 'line3' })
  assert.equal(editor.getText(), 'line1!\nline2\nline3')
})

test('vim example: paste events insert in insert mode; Enter in normal mode submits', async () => {
  const { editor, host } = await createVimEditor('')
  press(editor, 'i')
  editor.handleInput?.({ kind: 'paste', text: 'pasted' })
  assert.equal(editor.getText(), 'pasted')
  // Esc → normal; Enter dispatches the host-owned submit action.
  press(editor, 'escape')
  press(editor, 'enter')
  assert.deepEqual(host.dispatched, ['submit'], 'Enter in normal mode dispatches submit')
})

test('vim example: c changes the char at the cursor (DoD x/d/c)', async () => {
  const { editor } = await createVimEditor('abc')
  // c deletes the char at the cursor and enters insert mode.
  press(editor, 'c')
  editor.handleInput?.({ kind: 'text', text: 'X' })
  assert.equal(editor.getText(), 'Xbc')
  // Esc → normal; u undoes the typing, a second u undoes the c.
  press(editor, 'escape')
  press(editor, 'u')
  assert.equal(editor.getText(), 'bc')
  press(editor, 'u')
  assert.equal(editor.getText(), 'abc')
})

test('vim example: w advances to the next line at a line end; b lands on the previous word start', async () => {
  const { editor } = await createVimEditor('one\ntwo')
  // w from the last word of line 0 advances to line 1 col 0.
  press(editor, 'w')
  assert.equal(editor.getCursor?.() ?? 0, 4, 'w from the line end lands on the next line start')
  // b from the start of line 1 lands on the previous word start (col 0).
  press(editor, 'b')
  assert.equal(editor.getCursor?.() ?? 0, 0, 'b lands on the previous word start')
})

test('vim example: o is undoable (round-1 finding)', async () => {
  const { editor } = await createVimEditor('line1')
  press(editor, 'o')
  editor.handleInput?.({ kind: 'text', text: 'line2' })
  assert.equal(editor.getText(), 'line1\nline2')
  press(editor, 'escape')
  press(editor, 'u')
  assert.equal(editor.getText(), 'line1\n', 'u undoes the typing, leaving the o-opened line')
  press(editor, 'u')
  assert.equal(editor.getText(), 'line1', 'a second u undoes the o-opened line')
})

test('vim example: the flat cursor offset round-trips through the seat shape', async () => {
  const { editor } = await createVimEditor('ab\ncd')
  // The cursor starts at 0; move to the second line via j.
  press(editor, 'j')
  assert.equal(editor.getCursor?.() ?? 0, 3, 'the flat offset of line 2 col 0 is 3')
  // setCursor(4) → line 2 col 1.
  editor.setCursor?.(4)
  assert.equal(editor.getText(), 'ab\ncd')
  // The rendered component reflects the buffer (a getter — fresh each read).
  const view = editor.component
  assert.equal(view.kind, 'rows')
})
