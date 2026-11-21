import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { afterEach, test } from 'node:test'
import { parseUserKeybindings } from '../../src/tui/keybindings/config.ts'
import { HostKeybindingManager } from '../../src/tui/keybindings/manager.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { ActionEditorPanel } from '../../src/tui/keybindings/ui/action-editor.ts'
import { KeybindingEditorPanel, KeybindingEditorUnavailablePanel } from '../../src/tui/keybindings/ui/list.ts'
import { KeyRecorder } from '../../src/tui/keybindings/ui/recorder.ts'
import type { KeybindingMutationResult } from '../../src/tui/keybindings/ui/controller.ts'
import { buildKeybindingEditorModel } from '../../src/tui/keybindings/ui/model.ts'
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import { mountEmbeddedPage } from '../support/embedded-page-harness.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

function plain(text: string): string {
  // U1 fake-cursor markers are terminal sequences too; strip the full set.
  return stripTerminalSequences(text)
}

function makePanel(onClose: () => void) {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const panel = new KeybindingEditorPanel({
    model,
    onClose,
    runMutation: () => {},
    maxRows: () => 30,
  })
  return { manager, panel }
}

test('editor renders an action-first list with a non-selectable leader row and category headers', () => {
  let closed = 0
  const { manager, panel } = makePanel(() => { closed += 1 })
  try {
    const view = panel.render(88).join('\n')
    assert.match(view, /Leader key/)
    assert.match(view, /Input/)
    assert.match(view, /Submit draft/)
    assert.match(view, /fixed/)
    assert.match(view, /Enter details/)
    assert.equal(closed, 0)
  } finally {
    manager.dispose()
  }
})

test('action details label an unbound configurable action distinctly', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.transcript.toggleFullscreen')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
  })
  try {
    assert.match(plain(editor.render(88).join('\\n')), /Status: Unbound/)
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('untouched defaults are selectable and recorder replacement names the default', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.todo.toggle')!
  const mutations: Array<{ kind: string; previous?: { key: string } }> = []
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: mutation => { mutations.push(mutation as unknown as { kind: string; previous?: { key: string } }) },
    onModelChange: () => {},
    onBack: () => {},
  })
  try {
    assert.match(plain(editor.render(88).join('\n')), /Ctrl\+T \(default\)/)
    editor.handleInput('\r')
    editor.render(88) // the recorder frame
    editor.handleInput('\x1b[121;5u')
    assert.deepEqual(mutations, [{
      kind: 'replace',
      action: 'app.todo.toggle',
      previous: { kind: 'direct', key: 'ctrl+t' },
      binding: { kind: 'direct', key: 'ctrl+y' },
    }])
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('shadowed defaults are reference-only and Add does not select them', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({ 'app.history.search': 'ctrl+t' })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.todo.toggle')!
  const mutations: Array<{ kind: string; binding?: { key: string } }> = []
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: mutation => { mutations.push(mutation as unknown as { kind: string; binding?: { key: string } }) },
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 30,
  })
  try {
    const view = plain(editor.render(88).join('\n'))
    assert.match(view, /Default: Ctrl\+T/)
    assert.match(view, /Effective now: Unbound/)
    assert.doesNotMatch(view, /› Ctrl\+T \(default\)/)
    assert.match(view, /› \+ Add shortcut/)
    editor.handleInput('\r')
    editor.render(88) // the choose-binding frame
    editor.handleInput('\r')
    editor.render(88) // the recorder frame
    editor.handleInput('\x1b[121;5u')
    assert.deepEqual(mutations, [{ kind: 'add', action: 'app.todo.toggle', binding: { kind: 'direct', key: 'ctrl+y' } }])
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('interrupt action detail assigns Escape with double-Esc', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({ 'app.agent.interrupt': 'ctrl+x' })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.agent.interrupt')!
  const mutations: Array<{ kind: string; previous?: { key: string }; binding?: { key: string } }> = []
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: mutation => { mutations.push(mutation as unknown as { kind: string; previous?: { key: string }; binding?: { key: string } }) },
    onModelChange: () => {},
    onBack: () => {},
  })
  try {
    editor.handleInput('\r')
    assert.match(plain(editor.render(88).join('\n')), /double-Esc: assign Escape/)
    editor.handleInput('\x1b')
    editor.handleInput('\x1b')
    assert.deepEqual(mutations, [{
      kind: 'replace',
      action: 'app.agent.interrupt',
      previous: { kind: 'direct', key: 'ctrl+x' },
      binding: { kind: 'direct', key: 'escape' },
    }])
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('short action details keep the selected binding in the viewport', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.transcript.search.view')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 8,
  })
  try {
    const view = plain(editor.render(88).join('\n'))
    assert.match(view, /› Ctrl\+F \(default\)/)
    assert.match(view, /Back \[Esc\]/)
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('conditional task affordances are labeled separately from configured shortcuts', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.handleInput('tasks')
    assert.match(plain(panel.render(88).join('\n')), /Down \(conditional\)/)
    panel.handleInput('\r')
    const detail = plain(panel.render(88).join('\n'))
    assert.match(detail, /Conditional shortcuts/)
    assert.match(detail, /Down \(when the editor is empty and tasks are active\)/)
    assert.doesNotMatch(detail, /Shortcuts\n  Unbound/)
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('a configured Down task shortcut is still rendered as conditional', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({ 'app.tasks.open': 'down' })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.tasks.open')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 30,
  })
  try {
    const view = plain(editor.render(88).join('\n'))
    assert.match(view, /Configured shortcuts/)
    assert.match(view, /Down \(conditional\)/)
    assert.match(view, /when the editor is empty and tasks are active/)
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('← on the query-less root list is the back verb; a non-empty query keeps the cursor move', () => {
  let closed = 0
  const { manager, panel } = makePanel(() => { closed += 1 })
  try {
    panel.render(88)
    assert.match(plain(panel.render(88).join('\n')), /← Back/, 'the root bar advertises the accepted ← verb')
    panel.handleInput('\x1b[D')
    assert.equal(closed, 1, 'an empty query means ← returns to the source row')

    const second = makePanel(() => { closed += 1 })
    try {
      second.panel.render(88)
      second.panel.handleInput('sub') // non-empty query
      const input = (second.panel as unknown as { searchInput: { getValue(): string; cursorIndex?: number } }).searchInput
      second.panel.render(88)
      const before = (input as unknown as { cursor?: number }).cursor
      second.panel.handleInput('\x1b[D')
      assert.equal(closed, 1, 'with a query, ← must never leave the page')
      assert.equal((second.panel as unknown as { query: string }).query, 'sub', 'the query is untouched (only the cursor moved)')
      if (before !== undefined) assert.equal((input as unknown as { cursor?: number }).cursor, Math.max(0, before - 1))
      assert.doesNotMatch(plain(second.panel.render(88).join('\n')), /← Back/,
        'a non-empty query never advertises the back verb')
    } finally {
      second.panel.dispose()
      second.manager.dispose()
    }
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('the action detail and leader views keep their own ← meaning', () => {
  const { manager, panel } = makePanel(() => {})
  const model = buildKeybindingEditorModel(manager, parseUserKeybindings(undefined))
  const row = model.rows.find(candidate => candidate.id === 'app.input.submit')!
  let back = 0
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => { back += 1 },
    maxRows: () => 30,
  })
  try {
    editor.render(88)
    editor.handleInput('\x1b[D')
    assert.equal(back, 0, '← in the detail view is never the page back')
    editor.handleInput('\x1b')
    assert.equal(back, 1, 'Esc still leaves the detail')
  } finally {
    editor.dispose()
    manager.dispose()
  }
  panel.dispose()
})

test('editor search is cleared by the first Escape and closes on the second', () => {
  let closed = 0
  const { manager, panel } = makePanel(() => { closed += 1 })
  try {
    const emptyIdentity = panel.gestureIdentity()
    panel.handleInput('todo')
    assert.notEqual(panel.gestureIdentity(), emptyIdentity,
      'the query stage changes the page gesture identity')
    const filtered = panel.render(88).join('\n')
    assert.match(filtered, /Toggle todo panel/)
    assert.doesNotMatch(filtered, /Submit draft/)
    panel.handleInput('\x1b')
    assert.match(panel.render(88).join('\n'), /Submit draft/)
    assert.equal(closed, 0)
    panel.handleInput('\x1b')
    assert.equal(closed, 1)
  } finally {
    manager.dispose()
  }
})

test('binding choice arrows move in their named direction', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.handleInput('\x1b[B')
    panel.handleInput('\r')
    const detailIdentity = panel.gestureIdentity()
    panel.handleInput('\x1b[B')
    panel.handleInput('\r')
    // The detail page's choose-binding sub-mode changes what its Esc does even
    // when the bar cells repeat; the gesture identity must follow it.
    assert.notEqual(panel.gestureIdentity(), detailIdentity,
      'the choose-binding submode changes the page gesture identity')
    let view = plain(panel.render(88).join('\n'))
    assert.match(view, /› Direct shortcut/)
    panel.handleInput('\x1b[B')
    view = plain(panel.render(88).join('\n'))
    assert.match(view, /› Leader completion/)
    panel.handleInput('\x1b[A')
    view = plain(panel.render(88).join('\n'))
    assert.match(view, /› Direct shortcut/)
  } finally {
    manager.dispose()
  }
})

test('late action results are ignored after a newer mutation or disposal', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.todo.toggle')!
  const results: Array<(result: KeybindingMutationResult) => void> = []
  let changes = 0
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: (_mutation, onResult) => { results.push(onResult) },
    onModelChange: () => { changes += 1 },
    onBack: () => {},
  })
  const applied: KeybindingMutationResult = {
    kind: 'applied',
    model,
    parsed,
    message: 'saved',
  }
  try {
    editor.handleInput('\r')
    editor.handleInput('d')
    editor.handleInput('\x1b[115;5u')
    assert.equal(results.length, 1)
    results[0]!(applied)
    assert.equal(changes, 1)
    // The real surface paints the settlement frame before the next key; the
    // pinned result is what makes the next edit legitimate.
    editor.render(88)

    editor.handleInput('r')
    assert.equal(results.length, 2)
    results[0]!(applied)
    assert.equal(changes, 1)

    editor.dispose()
    results[1]!(applied)
    assert.equal(changes, 1)
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('a late action recorder cancel after disposal cannot repaint the panel', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.todo.toggle')!
  let renders = 0
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    requestRender: () => { renders += 1 },
  })
  try {
    editor.handleInput('\x1b[B')
    editor.handleInput('\r')
    editor.handleInput('\r')
    const recorder = (editor as unknown as {
      recorder?: { handleInput(data: string): void }
    }).recorder!
    const beforeDispose = renders
    editor.dispose()
    recorder.handleInput('\x1b')
    assert.equal(renders, beforeDispose)
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('late leader results are ignored after the editor is disposed', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const results: Array<(result: KeybindingMutationResult) => void> = []
  let changes = 0
  const panel = new KeybindingEditorPanel({
    model,
    runMutation: (_mutation, onResult) => { results.push(onResult) },
    onClose: () => {},
    onModelChange: () => { changes += 1 },
  })
  try {
    panel.handleInput('\r')
    panel.handleInput('\r')
    panel.handleInput('\x1b[120;5u')
    assert.equal(results.length, 1)
    panel.dispose()
    results[0]!(
      { kind: 'applied', model, parsed, message: 'saved' },
    )
    assert.equal(changes, 0)
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('a late leader capture after disposal cannot start a mutation', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const results: Array<(result: KeybindingMutationResult) => void> = []
  const panel = new KeybindingEditorPanel({
    model,
    runMutation: (_mutation, onResult) => { results.push(onResult) },
    onClose: () => {},
  })
  try {
    panel.handleInput('\r')
    panel.handleInput('\r')
    const recorder = (panel as unknown as {
      leaderRecorder?: { handleInput(data: string): void }
    }).leaderRecorder!
    panel.dispose()
    recorder.handleInput('\x1b[120;5u')
    assert.equal(results.length, 0)
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('safe mode presents an ignored leader and never starts its recorder', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({ leader: 'ctrl+q' })
  manager.setSafeMode(true)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const results: Array<(result: KeybindingMutationResult) => void> = []
  const panel = new KeybindingEditorPanel({
    model,
    runMutation: (_mutation, onResult) => { results.push(onResult) },
    onClose: () => {},
  })
  try {
    assert.equal(model.leader.key, undefined)
    assert.equal(model.leader.customized, true)
    assert.match(plain(panel.render(88).join('\n')), /Ignored by safe mode/)
    panel.handleInput('\r')
    assert.match(plain(panel.render(88).join('\n')), /Safe mode ignores persisted keyboard shortcuts/)
    panel.handleInput('\r')
    assert.equal(results.length, 0)
    assert.doesNotMatch(plain(panel.render(88).join('\n')), /record a new leader key/)
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('safe mode makes action details read-only', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({ 'app.todo.toggle': 'ctrl+y' })
  manager.setSafeMode(true)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.todo.toggle')!
  const mutations: string[] = []
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: mutation => { mutations.push(mutation.kind) },
    onModelChange: () => {},
    onBack: () => {},
  })
  try {
    const view = plain(editor.render(88).join('\n'))
    assert.match(view, /Editing is disabled until safe mode is turned off/)
    assert.doesNotMatch(view, /Add shortcut/)
    editor.handleInput('a')
    editor.handleInput('r')
    editor.handleInput('d')
    editor.handleInput('\x1b[3~')
    assert.deepEqual(mutations, [])
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('fullscreen teardown disposes a pending tracked editor before late results can repaint it', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const results: Array<(result: KeybindingMutationResult) => void> = []
  let changes = 0
  const panel = new KeybindingEditorPanel({
    model,
    runMutation: (_mutation, onResult) => { results.push(onResult) },
    onClose: () => {},
    onModelChange: () => { changes += 1 },
  })
  const app = new TuiApp(new VirtualTerminal(80, 24), { onSubmit: () => {}, onExit: () => {} })
  try {
    app.start()
    startedApps.add(app)
    app.trackKeybindingEditor(panel)
    panel.handleInput('\r')
    panel.handleInput('\r')
    panel.handleInput('\x1b[120;5u')
    assert.equal(results.length, 1)
    // The fullscreen transition disposes the tracked editor BEFORE this late
    // mutation result can repaint it.
    app.setFullscreen(true)
    results[0]({ kind: 'applied', model, parsed, message: 'saved' })
    assert.equal(changes, 0)
  } finally {
    app.dispose()
    manager.dispose()
  }
})

test('unavailable settings render a closable fallback instead of a dead row', () => {
  let closed = 0
  const panel = new KeybindingEditorUnavailablePanel(() => { closed += 1 })
  assert.match(panel.render(40).join('\n'), /Keyboard shortcuts unavailable/)
  panel.handleInput('\x1b')
  assert.equal(closed, 1)
})

test('Enter opens the selected action detail without making category headers selectable', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.handleInput('\x1b[B')
    panel.handleInput('\r')
    const view = panel.render(88).join('\n')
    assert.match(view, /Action ID: app.input.submit/)
    assert.match(view, /Action ID: app\.input\.submit/)
    assert.match(view, /Default: Enter/)
  } finally {
    manager.dispose()
  }
})

// ── WP4: /keybindings search uses the shared Input (plan §5) ────────────

test('editor search query edits mid-text with Left/Home/End/Delete', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.handleInput('abc')
    panel.handleInput('\x1b[D') // Left
    panel.handleInput('X')
    assert.match(plain(panel.render(88).join('\n')), /Search: abXc/, 'Left + X must insert mid-query')
    // Home / End.
    panel.handleInput('\x1bOH') // Home
    panel.handleInput('Z')
    assert.match(plain(panel.render(88).join('\n')), /Search: ZabXc/, 'Home + Z must prefix')
    panel.handleInput('\x1bOF') // End
    panel.handleInput('Y')
    assert.match(plain(panel.render(88).join('\n')), /Search: ZabXcY/, 'End + Y must append')
    // Delete removes forward; Backspace backward.
    panel.handleInput('\x1bOH') // Home
    panel.handleInput('\x1b[3~') // Delete removes Z
    assert.match(plain(panel.render(88).join('\n')), /Search: abXcY/, 'Delete must remove forward')
    panel.handleInput('\x7f') // Backspace — cursor is at index 0, no-op
    assert.match(plain(panel.render(88).join('\n')), /Search: abXcY/, 'Backspace at the start is a no-op')
    panel.handleInput('\x1bOF') // End
    panel.handleInput('\x7f') // Backspace removes Y
    assert.match(plain(panel.render(88).join('\n')), /Search: abXc/, 'Backspace must remove backward')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('editor search query responds to Ctrl+A/E/B/F and word movement', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.handleInput('hello world')
    // Ctrl+A / Ctrl+E (Emacs line home/end).
    panel.handleInput('\x01') // Ctrl+A
    panel.handleInput('Z')
    assert.match(plain(panel.render(88).join('\n')), /Search: Zhello world/, 'Ctrl+A + Z must prefix')
    panel.handleInput('\x05') // Ctrl+E
    panel.handleInput('Y')
    assert.match(plain(panel.render(88).join('\n')), /Search: Zhello worldY/, 'Ctrl+E + Y must append')
    // Ctrl+B / Ctrl+F (Emacs char movement).
    panel.handleInput('\x02') // Ctrl+B — one left from the end
    panel.handleInput('X')
    assert.match(plain(panel.render(88).join('\n')), /Search: Zhello worldXY/, 'Ctrl+B + X must insert before Y')
    panel.handleInput('\x06') // Ctrl+F — back to the end
    panel.handleInput('W')
    assert.match(plain(panel.render(88).join('\n')), /Search: Zhello worldXYW/, 'Ctrl+F + W must append')
    // Word move: Alt+Left lands at the previous word start.
    panel.handleInput('\x1bB') // Alt+Left
    panel.handleInput('V')
    // Zhello worldXYW → Alt+Left from the end lands before 'world', so V
    // inserts there: Zhello VworldXYW.
    assert.match(plain(panel.render(88).join('\n')), /Search: Zhello VworldXYW/, 'Alt+Left + V must insert at the word boundary')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('editor search hint switches between Esc clear and Esc close', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    let view = plain(panel.render(88).join('\n'))
    assert.match(view, /Back \[Esc\]/, 'empty query advertises Back [Esc]')
    panel.handleInput('todo')
    view = plain(panel.render(88).join('\n'))
    assert.match(view, /Clear \[Esc\]/, 'non-empty query advertises Clear [Esc]')
    assert.doesNotMatch(view, /Back \[Esc\]/, 'non-empty query must not advertise Back [Esc]')
    // First Esc clears (not closes); the hint flips back to the back verb.
    panel.handleInput('\x1b')
    view = plain(panel.render(88).join('\n'))
    assert.match(view, /Back \[Esc\]/, 'after clear the hint returns to Back [Esc]')
    // Second Esc closes.
    let closed = 0
    const { manager: m2, panel: p2 } = makePanel(() => { closed += 1 })
    try {
      p2.handleInput('todo')
      p2.handleInput('\x1b') // clear
      p2.handleInput('\x1b') // close
      assert.equal(closed, 1, 'second Esc must close the panel (query was cleared first)')
    } finally {
      p2.dispose()
      m2.dispose()
    }
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('editor search: list navigation keys stay parent-owned while editing', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.handleInput('submit')
    // A filtered list: the matching action row is present.
    assert.match(plain(panel.render(88).join('\n')), /Submit draft/, 'search must filter to submit')
    // Up/Down move the selection through the filtered list (not query text).
    panel.handleInput('\x1b[B')
    panel.handleInput('\r') // Enter opens the selected action (not a newline)
    const detail = plain(panel.render(88).join('\n'))
    assert.match(detail, /shortcut/i, 'Enter must open the selected action details')
    assert.doesNotMatch(detail, /Search:/, 'the detail view replaces the list (search row gone)')
    // Esc back: the list returns with the query preserved.
    panel.handleInput('\x1b')
    assert.match(plain(panel.render(88).join('\n')), /Search: submit/, 'query must survive the detail round trip')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('editor search row never overflows the panel width (narrow terminals)', () => {
  // The search row combines the 'Search: ' label with the shared Input's
  // render; at narrow widths the joined row must still fit the panel
  // (the Input's own render pads to its granted width, and the stripped
  // prompt re-added to the label used to exceed the request).
  for (const width of [4, 8, 10, 12, 20, 40]) {
    const { manager, panel } = makePanel(() => {})
    try {
      panel.handleInput('abc')
      panel.handleInput('\x1b[D') // a cursor position inside the text
      for (const line of panel.render(width)) {
        if (!line.includes('Search:')) continue
        assert.ok(visibleWidth(line) <= width,
          `search row overflows width ${width} (visible ${visibleWidth(line)}): ${JSON.stringify(line)}`)
      }
    } finally {
      panel.dispose()
      manager.dispose()
    }
  }
})

/** A minimal mouse event for direct component tests. */
function mouse(
  type: 'press' | 'click' | 'wheel',
  x: number,
  y: number,
  width = 88,
  height = 30,
  wheelDelta?: number,
): import('@xmoon76/pi-tui').TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
    ...(type === 'wheel' ? { wheelDelta: wheelDelta ?? 1 } : {}),
  }
}

test('keybinding list: mouse click selects and activates a row (mouse parity)', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    const rendered = panel.render(88)
    const row = rendered.findIndex(line => line.includes('Submit draft'))
    assert.ok(row >= 0, `Submit draft row missing:\n${rendered.join('\n')}`)
    const press = panel.handleMouse(mouse('press', 10, row, 88, 30))
    assert.ok(press?.handled, 'press on an action row must be handled')
    assert.equal(press?.focus, true, 'press must request focus')
    panel.handleMouse(mouse('click', 10, row, 88, 30))
    const after = panel.render(88).join('\n')
    assert.ok(after.includes('Action ID:'), 'clicking an action row must open the action editor')
  } finally {
    manager.dispose()
  }
})

test('keybinding list: wheel moves the selection (mouse parity)', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.render(88)
    // Wheel on a selectable row (row 6: Submit draft — rows 0-4 are
    // title/hint/search/blank/leader, row 5 is the Input header).
    const down = panel.handleMouse(mouse('wheel', 10, 6, 88, 30, 1))
    assert.ok(down?.handled, 'wheel must be handled')
    const rendered = panel.render(88)
    const marked = rendered.findIndex(line => line.includes('›'))
    assert.ok(marked >= 0)
    assert.ok(!rendered[marked]?.includes('Leader key'), 'wheel down must move past the leader row')
  } finally {
    manager.dispose()
  }
})

test('keybinding list: headers and hint are inert (mouse parity)', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    const rendered = panel.render(88).map(plain)
    const headerRow = rendered.findIndex(line => line.trim() === 'Input')
    const hintRow = rendered.findIndex(line => line.includes('Enter details'))
    assert.ok(headerRow >= 0 && hintRow >= 0, `chrome rows missing:\n${rendered.join('\n')}`)
    assert.equal(panel.handleMouse(mouse('press', 10, headerRow, 88, 30)), undefined, 'category header must be inert')
    assert.equal(panel.handleMouse(mouse('press', 10, hintRow, 88, 30)), undefined, 'hint must be inert')
  } finally {
    manager.dispose()
  }
})

test('keybinding list: search Input click repositions the query cursor (mouse parity)', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.render(88)
    panel.handleInput('ab')
    let rendered = panel.render(88).map(plain)
    // The search row is "Search: " (8 cols) + the query directly (the
    // Input has an EMPTY prompt): rendered geometry == mouse geometry ==
    // the Input's own geometry. Locate the visible column of 'a' and
    // click ONE column AFTER it (between a and b).
    const searchRow = rendered.findIndex(line => line.startsWith('Search:'))
    assert.ok(searchRow >= 0, `search row missing:\n${rendered.join('\n')}`)
    // Locate the QUERY text (the first 'a' is inside the 'Search' label).
    const abCol = rendered[searchRow]!.indexOf('ab')
    assert.ok(abCol >= 0, 'query text missing in the search row')
    // Click one column after 'a' (between a and b).
    const result = panel.handleMouse(mouse('press', abCol + 1, searchRow, 88, 30))
    assert.ok(result?.handled, 'press on the search row must be handled')
    panel.handleInput('X')
    rendered = panel.render(88).map(plain)
    assert.ok(rendered.some(line => line.includes('aXb')), `typing after the click must insert at the clicked query column:\n${rendered.join('\n')}`)
  } finally {
    manager.dispose()
  }
})

test('keybinding recorder never records SGR mouse bytes as a keybinding (mouse parity)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  startedApps.add(app)
  await vt.waitForRender()
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const panel = new KeybindingEditorPanel({
    model,
    onClose: () => {},
    runMutation: () => {},
    maxRows: () => 18,
  })
  const mount = mountEmbeddedPage(vt, panel)
  await vt.waitForRender()
  // Open the first action's editor and start recording a direct shortcut.
  let viewport = vt.getViewport()
  const actionRow = viewport.findIndex(line => line.includes('Submit draft'))
  assert.ok(actionRow >= 0, `action row missing:\n${viewport.join('\n')}`)
  const leftBorder = 0
  vt.sendInput(`\x1b[<0;${leftBorder + 3};${actionRow + 1}M`)
  vt.sendInput(`\x1b[<0;${leftBorder + 3};${actionRow + 1}m`)
  await vt.waitForRender()
  viewport = vt.getViewport()
  const bindingRow = viewport.findIndex(line => line.includes('(default)'))
  assert.ok(bindingRow >= 0, `binding row missing:\n${viewport.join('\n')}`)
  vt.sendInput(`\x1b[<0;${leftBorder + 3};${bindingRow + 1}M`)
  vt.sendInput(`\x1b[<0;${leftBorder + 3};${bindingRow + 1}m`)
  await vt.waitForRender()
  viewport = vt.getViewport()
  assert.ok(viewport.some(line => line.includes('Record shortcut')), 'the recorder must be active')
  // An SGR mouse press+release must NOT become a recorded binding.
  vt.sendInput(`\x1b[<0;${leftBorder + 3};${bindingRow + 1}M`)
  vt.sendInput(`\x1b[<0;${leftBorder + 3};${bindingRow + 1}m`)
  await vt.waitForRender()
  viewport = vt.getViewport()
  assert.ok(viewport.some(line => line.includes('Record shortcut')), 'the recorder must still be waiting (mouse bytes are not a key)')
  // A real (non-printable) key still records — printable keys are
  // reserved for typing and rejected by the recorder.
  vt.sendInput('\x18') // Ctrl+X
  await vt.waitForRender()
  viewport = vt.getViewport()
  assert.ok(!viewport.some(line => line.includes('Record shortcut')), 'a real key must complete the recording')
  mount.close()
  app.dispose()
})

test('action editor: scrolled viewport preserves the selectable ordinal on click (mouse parity)', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({
    'app.input.submit': ['alt+1', 'alt+2', 'alt+3', 'alt+4', 'alt+5', 'alt+6'],
  })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.input.submit')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 6,
  })
  try {
    // Move the selection to the LAST binding (Alt+6) so the viewport
    // scrolls and the "↑ N more" marker REPLACES the first visible
    // binding (Alt+5) — the case that shifts the selectable ordinal.
    for (let i = 0; i < 5; i += 1) editor.handleInput('\x1b[B')
    const rendered = editor.render(88)
    const markerRow = rendered.findIndex(line => line.includes('↑'))
    assert.ok(markerRow >= 0, `scroll marker missing:\n${rendered.join('\n')}`)
    // Click the Alt+6 row (the LAST binding): the press must select
    // ordinal 5, not 0 (the marker must not shift the ordinal).
    const alt6Row = rendered.findIndex(line => line.includes('Alt+6'))
    assert.ok(alt6Row >= 0, `Alt+6 row missing:\n${rendered.join('\n')}`)
    const press = editor.handleMouse(mouse('press', 10, alt6Row, 88, 6))
    assert.ok(press?.handled, 'press on a binding row must be handled')
    // The press must select the LAST binding (ordinal 5), not the
    // first: the scroll marker must not shift the selectable ordinal.
    assert.equal(
      (editor as unknown as { selectedIndex: number }).selectedIndex,
      5,
      'clicking Alt+6 must select the last binding, not the first',
    )
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('keybinding list: query change WITHOUT a repaint between press and click cannot activate a different action (mouse parity)', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    const rendered = panel.render(88)
    const row = rendered.findIndex(line => line.includes('Submit draft'))
    assert.ok(row >= 0, `Submit draft row missing:\n${rendered.join('\n')}`)
    panel.handleMouse(mouse('press', 10, row, 88, 30))
    // Query change WITHOUT a repaint: the hit map is still last-painted
    // geometry, but the current selectable list no longer contains the
    // pressed action. The click must be dropped, not activate whatever
    // moved into the stale row.
    panel.handleInput('q')
    panel.handleMouse(mouse('click', 10, row, 88, 30))
    const after = panel.render(88).join('\n')
    assert.ok(!after.includes('Action ID:'), 'the click must not open an action editor for a different action')
  } finally {
    manager.dispose()
  }
})

test('keybinding list: query shrink WITHOUT a repaint between paint and press rejects the stale press (mouse parity)', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    const rendered = panel.render(88)
    const row = rendered.findIndex(line => line.includes('Submit draft'))
    assert.ok(row >= 0)
    // Query shrink WITHOUT a repaint: the pressed action is no longer in
    // the current selectable list, so the press must be rejected.
    panel.handleInput('q')
    const press = panel.handleMouse(mouse('press', 10, row, 88, 30))
    assert.equal(press, undefined, 'a press on a row whose action no longer exists must be rejected')
  } finally {
    manager.dispose()
  }
})

test('action editor: mouse input is frozen while a mutation is pending (mouse parity)', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.todo.toggle')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => { /* never resolves: the mutation stays pending */ },
    onModelChange: () => {},
    onBack: () => {},
  })
  try {
    // Start an async mutation that never settles: the edit surface freezes.
    const startMutation = (editor as unknown as { startMutation(m: { kind: string }): void }).startMutation
    startMutation.call(editor, { kind: 'disable-action', action: row.id })
    let rendered = editor.render(88)
    assert.ok(rendered.map(plain).join('\n').includes('Saving…'), `precondition — pending mutation:\n${rendered.map(plain).join('\n')}`)

    // wheel: the selection must not move.
    const before = (editor as unknown as { selectedIndex: number }).selectedIndex
    editor.handleMouse(mouse('wheel', 10, 9, 88, 30, 1))
    assert.strictEqual((editor as unknown as { selectedIndex: number }).selectedIndex, before, 'wheel must be frozen while pending')

    // press / click: rejected — no selection move, no recorder start.
    assert.strictEqual(editor.handleMouse(mouse('press', 10, 9, 88, 30)), undefined, 'press must be rejected while pending')
    assert.strictEqual(editor.handleMouse(mouse('click', 10, 9, 88, 30)), undefined, 'click must be rejected while pending')
    const state = editor as unknown as { recorder: unknown; pending: boolean }
    assert.strictEqual(state.recorder, undefined, 'a click while pending must not start a recorder')
    assert.strictEqual(state.pending, true, 'the pending mutation must stay armed')
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('keybinding panel: the focused flag reaches the search Input (CURSOR_MARKER)', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.focused = true
    panel.handleInput('ab')
    const rendered = panel.render(88).join('\n')
    assert.ok(rendered.includes(CURSOR_MARKER), `the focused search Input must emit the cursor marker:\n${rendered}`)
    panel.focused = false
    const rendered2 = panel.render(88).join('\n')
    assert.ok(!rendered2.includes(CURSOR_MARKER), 'an unfocused panel must not emit the marker')
  } finally {
    manager.dispose()
  }
})

test('keybinding panel: the embedded page forwards focus to the search Input (CURSOR_MARKER)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  startedApps.add(app)
  await vt.waitForRender()
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const panel = new KeybindingEditorPanel({
    model,
    onClose: () => {},
    runMutation: () => {},
    maxRows: () => 18,
  })
  const mount = mountEmbeddedPage(vt, panel)
  await vt.waitForRender()
  // Type a query: the search row then renders the Input (with its fake
  // cursor) instead of the empty-query placeholder.
  vt.sendInput('a')
  await vt.waitForRender()
  const viewport = vt.getViewport()
  assert.ok(viewport.some(line => line.includes('Search: a')), `the search row must show the query:\n${viewport.join('\n')}`)
  // The root hands the page the keyboard; the page must forward that flag to
  // its private search Input (the alt screen extracts the CURSOR_MARKER into
  // the terminal cursor position, so the marker is not visible in the rows).
  const state = panel as unknown as { searchInput: { focused: boolean } }
  assert.strictEqual(state.searchInput.focused, true, 'the mounted page must forward focus to the search Input')
  mount.close()
  app.stop()
})

test('action editor: an async model replacement cannot transfer a click to another binding (mouse parity)', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.todo.toggle')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
  })
  try {
    const lines = editor.render(88).map(plain)
    const bindingRow = lines.findIndex(line => line.includes('Ctrl+T'))
    assert.ok(bindingRow >= 0, `binding row missing:\n${lines.join('\n')}`)
    // An async model replacement swaps the row to a DIFFERENT binding
    // WITHOUT a repaint: the screen still shows Ctrl+T.
    const parsed2 = parseUserKeybindings({ 'app.todo.toggle': 'ctrl+y' })
    const model2 = buildKeybindingEditorModel(manager, parsed2)
    const row2 = model2.rows.find(candidate => candidate.id === 'app.todo.toggle')!
    ;(editor as unknown as { row: unknown }).row = row2
    // A press+click on the stale Ctrl+T row must NOT start a recorder for
    // the replacement binding (Ctrl+Y).
    editor.handleMouse(mouse('press', 10, bindingRow, 88, 30))
    const click = editor.handleMouse(mouse('click', 10, bindingRow, 88, 30))
    assert.equal(click, undefined, 'the click must not transfer to the replacement binding')
    const state = editor as unknown as { recorder: unknown }
    assert.equal(state.recorder, undefined, 'no recorder must start from the stale row')
    // After the repaint the painted binding works normally.
    const lines2 = editor.render(88).map(plain)
    const yRow = lines2.findIndex(line => line.includes('Ctrl+Y'))
    assert.ok(yRow >= 0, `replacement binding row missing:\n${lines2.join('\n')}`)
    editor.handleMouse(mouse('press', 10, yRow, 88, 30))
    editor.handleMouse(mouse('click', 10, yRow, 88, 30))
    assert.ok((editor as unknown as { recorder: unknown }).recorder !== undefined, 'the painted binding must start the recorder')
    // The stale-latch release: the OLD binding returns and repaints; a
    // click WITHOUT a fresh press must not start a recorder (the pressed
    // identity was released on the mismatch). Esc cancels the recorder
    // through the real onCancel path (exactly-once lifecycle).
    editor.handleInput('\x1b')
    assert.strictEqual((editor as unknown as { recorder: unknown }).recorder, undefined, 'Esc must cancel the recorder')
    ;(editor as unknown as { row: unknown }).row = row
    const lines3 = editor.render(88).map(plain)
    const tRow = lines3.findIndex(line => line.includes('Ctrl+T'))
    assert.ok(tRow >= 0, `restored binding row missing:\n${lines3.join('\n')}`)
    editor.handleMouse(mouse('click', 10, tRow, 88, 30))
    assert.strictEqual((editor as unknown as { recorder: unknown }).recorder, undefined, 'a click without a fresh press must not start a recorder')
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('keybinding list: a click on an inert row releases the pressed identity (no stale activation)', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    const rendered = panel.render(88)
    const row = rendered.findIndex(line => line.includes('Submit draft'))
    assert.ok(row >= 0, `action row missing:\n${rendered.join('\n')}`)
    panel.handleMouse(mouse('press', 10, row, 88, 30))
    // A click on an INERT row (the header) must release the pressed
    // identity.
    const headerRow = rendered.findIndex(line => plain(line).trim() === 'Input')
    assert.ok(headerRow >= 0)
    panel.handleMouse(mouse('click', 10, headerRow, 88, 30))
    const state = panel as unknown as { mousePressedId: string | undefined }
    assert.strictEqual(state.mousePressedId, undefined, 'the pressed identity must be released on an inert click')
    // A later click on the action row WITHOUT a fresh press must not
    // activate it.
    panel.handleMouse(mouse('click', 10, row, 88, 30))
    const opened = panel.render(88).map(plain)
    assert.ok(!opened.some(line => line.includes('Record shortcut')), 'a click without a fresh press must not open the recorder')
  } finally {
    manager.dispose()
  }
})

test('keyboard mode transition cancels a pending mouse identity (mouse parity)', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.todo.toggle')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
  })
  try {
    // Edit mode: find the "+ Add shortcut" row.
    const rendered = plain(editor.render(88).join('\n'))
    const addRow = rendered.split('\n').findIndex(line => line.includes('Add shortcut'))
    assert.ok(addRow >= 0, 'Add shortcut row missing')
    // Press "+ Add shortcut" (no release yet): the press-time identity
    // is the edit-mode "add" key.
    const press = editor.handleMouse(mouse('press', 10, addRow, 88, 30))
    assert.ok(press?.handled, 'press on Add must be handled')
    // Keyboard Enter: the current selection is Add → mode switches to
    // choose-binding. The keyboard transition must CANCEL the pending
    // mouse identity (an edit-mode press must never be reinterpreted as
    // a choose-binding choice on release).
    editor.handleInput('\r')
    // DO NOT render: the hit map is still the edit-mode paint.
    // Release on the same cell: the click must NOT start a leader
    // recorder from the stale edit-mode press.
    editor.handleMouse(mouse('click', 10, addRow, 88, 30))
    const state = editor as unknown as { mode: string; recorder: unknown }
    assert.equal(state.mode, 'choose-binding', 'the mode must stay choose-binding')
    assert.equal(state.recorder, undefined, 'no recorder may start from the stale press')
    // A fresh press on a choose-binding row still works.
    const directRow = plain(editor.render(88).join('\n')).split('\n').findIndex(line => line.includes('Direct shortcut'))
    assert.ok(directRow >= 0, 'Direct shortcut row missing')
    editor.handleMouse(mouse('press', 10, directRow, 88, 30))
    editor.handleMouse(mouse('click', 10, directRow, 88, 30))
    assert.ok((editor as unknown as { recorder: unknown }).recorder !== undefined, 'a fresh press must start the recorder')
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('keybinding editor: keyboard mode transition before repaint cannot start a leader recorder (mouse parity)', async () => {
  const vt = new VirtualTerminal(80, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  startedApps.add(app)
  await vt.waitForRender()
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({ leader: 'ctrl+q' })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const panel = new KeybindingEditorPanel({
    model,
    onClose: () => {},
    runMutation: () => {},
    maxRows: () => 18,
  })
  const mount = mountEmbeddedPage(vt, panel)
  await vt.waitForRender()
  // Open the first action's editor (edit mode).
  let viewport = vt.getViewport()
  const actionRow = viewport.findIndex(line => line.includes('Submit draft'))
  assert.ok(actionRow >= 0, `action row missing:\n${viewport.join('\n')}`)
  const leftBorder = 0
  vt.sendInput(`\x1b[<0;${leftBorder + 3};${actionRow + 1}M`)
  vt.sendInput(`\x1b[<0;${leftBorder + 3};${actionRow + 1}m`)
  await vt.waitForRender()
  // The ActionEditor is open in edit mode: find "+ Add shortcut".
  viewport = vt.getViewport()
  const addRow = viewport.findIndex(line => line.includes('Add shortcut'))
  assert.ok(addRow >= 0, `Add shortcut row missing:\n${viewport.join('\n')}`)
  // ONE continuous input batch: press Add, Enter (mode → choose-binding),
  // release Add — all BEFORE the next repaint. The stale edit-mode
  // press must NOT be reinterpreted as a choose-binding leader choice.
  vt.sendInput(`\x1b[<0;${leftBorder + 3};${addRow + 1}M`)
  vt.sendInput('\r')
  vt.sendInput(`\x1b[<0;${leftBorder + 3};${addRow + 1}m`)
  await vt.waitForRender()
  // The editor stays on the choose-binding page; no recorder starts.
  viewport = vt.getViewport()
  assert.ok(viewport.some(line => line.includes('Choose what to record')), `the choose-binding page must show:\n${viewport.join('\n')}`)
  assert.ok(!viewport.some(line => line.includes('Record shortcut')), 'no recorder may start from the stale press')
  mount.close()
  app.stop()
})

// ── Phase 3A / PR-C: the live content-row grant (setMaxRows) ────────────

test('keybinding editor: the parent grant caps the standalone budget without resetting the query or selection', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    for (const character of 'submit') panel.handleInput(character)
    const standalone = panel.render(88)
    const marked = plain(standalone.join('\n')).split('\n').find(line => line.includes('›'))
    assert.ok(marked !== undefined, 'the selected row must be painted')
    assert.ok(standalone.length <= 30, 'the standalone budget applies before any parent grant')

    panel.setMaxRows(4)
    const nested = panel.render(88)
    assert.ok(nested.length <= 4, `the parent grant must cap the frame (got ${nested.length})`)
    const nestedText = plain(nested.join('\n'))
    assert.match(nestedText, /Search: submit/, 'setMaxRows must not reset the query')
    assert.match(nestedText, /Clear \[Esc\]/, 'the operation hint must survive the grant')
    assert.equal(nestedText.split('\n').find(line => line.includes('›')), marked, 'setMaxRows must not reset the selection')

    // A non-finite parent grant restores the standalone budget exactly.
    panel.setMaxRows(Number.POSITIVE_INFINITY)
    assert.deepEqual(panel.render(88), standalone)
  } finally {
    manager.dispose()
  }
})

test('keybinding editor: degenerate grants keep the operation hint and only paint real hits', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.setMaxRows(1)
    let view = panel.render(88).map(plain)
    assert.equal(view.length, 1)
    assert.match(view[0]!, /Back \[Esc\]/)
    assert.equal(panel.handleMouse(mouse('press', 10, 0, 88, 30)), undefined, 'the hint row is inert')

    panel.setMaxRows(2)
    view = panel.render(88).map(plain)
    assert.equal(view.length, 2)
    assert.match(view[0]!, /^Search: /, 'the editable search row survives a two-row grant')
    assert.match(view[1]!, /Back \[Esc\]/)

    panel.setMaxRows(3)
    view = panel.render(88).map(plain)
    assert.deepEqual(view.length, 3)
    assert.match(view[0]!, /^View: \[All\] · Conflicts \(0 affected actions\)$/u, 'the mode row is the first-row survivor')
    assert.match(view[1]!, /^Search: /, 'the search row is the second-row survivor')
    assert.match(view[2]!, /Back \[Esc\]/)
    assert.ok(panel.handleMouse(mouse('press', 7, 0, 88, 30))?.handled, 'the painted mode span must stay clickable')
    assert.ok(panel.handleMouse(mouse('press', 10, 1, 88, 30))?.handled, 'the painted search row must stay clickable')
    assert.equal(panel.handleMouse(mouse('press', 10, 2, 88, 30)), undefined, 'the hint row is inert')
  } finally {
    manager.dispose()
  }
})

test('keybinding editor: a short grant keeps a real error over the optional chrome', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const panel = new KeybindingEditorPanel({
    model,
    runMutation: (_mutation, _onResult, onError) => onError(new Error('could not save the leader key')),
    onClose: () => {},
    maxRows: () => 30,
  })
  try {
    panel.handleInput('\r') // leader editor
    panel.handleInput('\r') // start the recorder
    panel.handleInput('\x1b[121;5u') // capture ctrl+y → the failing mutation
    const full = plain(panel.render(88).join('\n'))
    assert.match(full, /could not save the leader key/)
    panel.setMaxRows(5)
    const short = plain(panel.render(88).join('\n'))
    assert.match(short, /could not save the leader key/, 'a real error must survive the short grant')
    assert.match(short, /Back \[Esc\]/, 'the operation row must survive the short grant')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('keybinding editor: the leader editor keeps Esc back and Saving… instead of blank spacers', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const panel = new KeybindingEditorPanel({
    model,
    runMutation: () => {}, // never settles: the panel stays pending
    onClose: () => {},
    maxRows: () => 30,
  })
  try {
    panel.handleInput('\r') // leader editor
    panel.handleInput('\r') // start the recorder
    panel.handleInput('\x1b[121;5u') // capture ctrl+y → the pending mutation
    let view = panel.render(88).map(plain)
    assert.match(view.join('\n'), /Saving…/, 'the bar states the frozen write')
    assert.doesNotMatch(view.join('\n'), /Enter record/, 'no key that the pending write ignores may be advertised')

    panel.setMaxRows(4)
    view = panel.render(88).map(plain)
    assert.ok(view.length <= 4, `the grant must cap the leader editor (got ${view.length})`)
    assert.match(view.join('\n'), /Saving…/, 'the pending state must not be displaced by blank spacers')

    panel.setMaxRows(1)
    view = panel.render(88).map(plain)
    assert.deepEqual(view.length, 1)
    assert.match(view[0]!, /Saving…/, 'a one-row grant shows only the real bar')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('action editor: a short choose-binding grant keeps the painted choice hit map', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.input.submit')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 4,
  })
  try {
    editor.handleInput('a') // enter choose-binding
    const view = editor.render(88).map(plain)
    assert.ok(view.length <= 4, `the grant must cap the binding choice (got ${view.length})`)
    assert.match(view.join('\n'), /Back \[Esc\]/, 'the binding-choice hint must survive the short grant')
    const directRow = view.findIndex(line => line.includes('Direct shortcut'))
    assert.ok(directRow >= 0, `the Direct choice must stay painted:\n${view.join('\n')}`)
    assert.notEqual(directRow, 3, 'the hit map must follow the painted rows, not a fixed row index')
    assert.ok(editor.handleMouse(mouse('press', 10, directRow, 88, 4))?.handled, 'the painted Direct row is clickable')
    editor.handleMouse(mouse('click', 10, directRow, 88, 4))
    assert.match(plain(editor.render(88).join('\n')), /Record shortcut/, 'the painted Direct row must start its recorder')
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('keybinding editor: the unavailable fallback degrades to its Esc row on a short grant', () => {
  const panel = new KeybindingEditorUnavailablePanel(() => {})
  assert.equal(panel.render(40).length, 4, 'an ample grant keeps the four-row fallback verbatim')
  panel.setMaxRows(3)
  assert.deepEqual(panel.render(40).map(plain), [
    'Keyboard shortcuts unavailable',
    'The settings service could not be read.',
    'Esc back',
  ])
  panel.setMaxRows(2)
  assert.deepEqual(panel.render(40).map(plain), ['Keyboard shortcuts unavailable', 'Esc back'])
  panel.setMaxRows(1)
  assert.deepEqual(panel.render(40).map(plain), ['Esc back'])
  panel.setMaxRows(Number.POSITIVE_INFINITY)
  assert.equal(panel.render(40).length, 4, 'a non-finite grant restores the full fallback')
})

test('action editor: the scrolled choose-binding Leader row keeps its painted ordinal (mouse parity)', () => {
  const manager = new HostKeybindingManager()
  // A configured leader key keeps the Leader choice available.
  const parsed = parseUserKeybindings({ leader: 'ctrl+q' })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.input.submit')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 5,
  })
  try {
    editor.handleInput('a') // choose-binding: Direct is selected
    editor.render(60)
    editor.handleInput('\x1b[B') // Down: Leader selected, the window re-centers
    const view = editor.render(60).map(plain)
    const leaderRow = view.findIndex(line => line.includes('Leader completion'))
    assert.ok(leaderRow >= 0, `the scrolled Leader choice must stay painted:\n${view.join('\n')}`)
    assert.notEqual(leaderRow, 4, 'the scrolled window must not assume the fixed row 4')
    assert.ok(editor.handleMouse(mouse('press', 10, leaderRow, 60, 5))?.handled, 'the painted Leader row is clickable')
    editor.handleMouse(mouse('click', 10, leaderRow, 60, 5))
    // The recorder title is SHARED with the direct recorder, so the
    // discriminating evidence is the leader-completion copy: a mis-mapped
    // ordinal would start the direct recorder ('Press a key for Submit draft.').
    const recording = plain(editor.render(60).join('\n'))
    assert.match(recording, /Press a key for the leader completion\./, 'the painted Leader row must start the LEADER recorder')
    assert.match(recording, /This key completes the leader sequence\./)
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('keybinding editor: the key recorder keeps its Esc line as the last granted row', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.handleInput('\r') // leader editor
    panel.handleInput('\r') // start the recorder
    const full = plain(panel.render(60).join('\n'))
    assert.match(full, /Record shortcut/, 'the recorder must be active')
    assert.match(full, /Cancel \[Esc\]/, 'the recorder bar names its own cancel')
    panel.setMaxRows(2)
    const short = panel.render(60).map(plain)
    assert.equal(short.length, 2)
    assert.match(short[0]!, /Waiting for one key/, 'the status is the survivor above the bar')
    assert.match(short[1]!, /Cancel \[Esc\]/, 'the recorder bar is the LAST granted row')
    panel.setMaxRows(1)
    const barOnly = panel.render(60).map(plain)
    assert.equal(barOnly.length, 1)
    assert.match(barOnly[0]!, /Cancel \[Esc\]/, 'a bar-only grant still shows the way out')
  } finally {
    manager.dispose()
  }
})

test('a pending action mutation owns the page: Esc cannot strand its result', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.todo.toggle')!
  let backs = 0
  const pending: Array<{ done?: (result: unknown) => void }> = []
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: (_mutation, onResult) => {
      pending.push({
        done: result => {
          onResult(result as never)
        },
      })
    },
    onModelChange: () => {},
    onBack: () => { backs += 1 },
    maxRows: () => 30,
  })
  try {
    editor.render(88)
    editor.handleInput('r') // reset → an in-flight write
    editor.render(88)
    assert.equal((editor as unknown as { pending: boolean }).pending, true, 'precondition — the write is pending')
    editor.handleInput('\x1b')
    assert.equal(backs, 0, 'Esc while pending must not leave the detail')
    assert.equal((editor as unknown as { disposed: boolean }).disposed, false, 'the editor must not be disposed while pending')
    const bar = plain(editor.render(88).join('\n'))
    assert.match(bar, /Saving…/, 'the bar states the frozen write')
    assert.doesNotMatch(bar, /Back \[Esc\]/, 'no exit verb is advertised while the write owns the page')
    // The settlement re-opens navigation.
    pending[0]!.done!({
      kind: 'rejected',
      message: 'the write was refused by the authority',
    })
    const settled = plain(editor.render(88).join('\n'))
    assert.match(settled, /the write was refused by the authority/, 'the failure reason is visible')
    assert.match(settled, /Back \[Esc\]/, 'navigation resumes once the write settles')
    editor.handleInput('\x1b')
    assert.equal(backs, 1, 'Esc leaves only after the settlement')
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('Esc after a mutation settles but BEFORE its frame paints is still refused', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.todo.toggle')!
  let backs = 0
  let settled: ((result: unknown) => void) | undefined
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: (_mutation, onResult) => {
      settled = result => { onResult(result as never) }
    },
    onModelChange: () => {},
    onBack: () => { backs += 1 },
    maxRows: () => 30,
  })
  try {
    editor.render(88)
    editor.handleInput('r') // in-flight write
    editor.render(88)
    // The write settles with a rejection message, and its frame is still only
    // QUEUED (requestRender is asynchronous in the real TUI).
    settled!({ kind: 'rejected', message: 'the authority refused the reset' })
    assert.equal((editor as unknown as { pending: boolean }).pending, false, 'the write itself has settled')
    editor.handleInput('\x1b')
    assert.equal(backs, 0, 'the result has not painted yet, so Esc must not leave the page')
    assert.equal((editor as unknown as { disposed: boolean }).disposed, false)
    // A NON-Esc key must not be able to erase the unread result either: Down
    // moves the selection and clears `message`, which would let the queued frame
    // paint nothing and release the lock.
    const selectedBefore = (editor as unknown as { selectedIndex: number }).selectedIndex
    editor.handleInput('\x1b[B')
    assert.equal((editor as unknown as { selectedIndex: number }).selectedIndex, selectedBefore,
      'Down cannot act before the result paints')
    editor.handleMouse(mouse('wheel', 10, 9, 88, 30, 1))
    assert.equal((editor as unknown as { selectedIndex: number }).selectedIndex, selectedBefore,
      'mouse wheel is frozen for the same window')
    const stillPending = editor.render(88)
    assert.match(plain(stillPending.join('\n')), /the authority refused the reset/u,
      'the first frame after settlement really carries the result')
    assert.equal((editor as unknown as { settlementAwaitingPaint: boolean }).settlementAwaitingPaint, false)
    editor.handleInput('\x1b[B')
    assert.notEqual((editor as unknown as { selectedIndex: number }).selectedIndex, selectedBefore,
      'normal editing resumes after the result painted')
    // The settle frame painted the reason; Esc may leave now.
    editor.handleInput('\x1b')
    assert.equal(backs, 1, 'Esc leaves exactly once after the result is on screen')
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('a settled action mutation restores Esc; repeated Esc while pending never leaves twice', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.todo.toggle')!
  let backs = 0
  let settled: ((result: unknown) => void) | undefined
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: (_mutation, onResult) => {
      settled = result => { onResult(result as never) }
    },
    onModelChange: () => {},
    onBack: () => { backs += 1 },
    maxRows: () => 30,
  })
  try {
    editor.render(88)
    editor.handleInput('r')
    editor.render(88)
    // Three Escs while the write is in flight: not one may leave or dispose.
    for (let i = 0; i < 3; i += 1) editor.handleInput('\x1b')
    assert.equal(backs, 0)
    assert.equal((editor as unknown as { disposed: boolean }).disposed, false)
    // A successful settlement restores navigation.
    const next = buildKeybindingEditorModel(manager, { ...parsed, bindings: { ...parsed.bindings, 'app.todo.toggle': [] } } as never)
    settled!({
      kind: 'applied',
      model: next,
      parsed,
      message: 'Shortcut reset.',
    })
    assert.match(plain(editor.render(88).join('\n')), /Back \[Esc\]/, 'the exit verb returns with the settlement')
    editor.handleInput('\x1b')
    assert.equal(backs, 1, 'exactly one back after the write settled')
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('a bar-only leader editor accepts only its painted Esc', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const mutations: unknown[] = []
  const panel = new KeybindingEditorPanel({
    model,
    runMutation: mutation => { mutations.push(mutation) },
    onClose: () => {},
    maxRows: () => 30,
  })
  try {
    panel.render(88)
    panel.handleInput('\r') // leader editor
    panel.setMaxRows(1)
    const bar = plain(panel.render(88).join('\n'))
    assert.match(bar, /Back \[Esc\]/, 'the bar-only leader view keeps the way back')
    assert.doesNotMatch(bar, /Enter record|r reset/, 'no hidden leader verb is advertised')
    panel.handleInput('r')
    panel.handleInput('\r')
    assert.deepEqual(mutations, [], 'no hidden reset write or recorder may start')
    assert.equal((panel as unknown as { leaderRecorder: unknown }).leaderRecorder, undefined)
    panel.handleInput('\x1b')
    assert.equal((panel as unknown as { leaderEditing: boolean }).leaderEditing, false, 'the painted Esc still returns')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('a bar-only keybinding list accepts no hidden Enter action', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  let closed = 0
  const panel = new KeybindingEditorPanel({
    model,
    onClose: () => { closed += 1 },
    runMutation: () => {},
    maxRows: () => 1,
  })
  try {
    const lines = panel.render(88)
    assert.equal(lines.length, 1)
    assert.match(plain(lines[0]!), /Back \[Esc\]/u)
    assert.doesNotMatch(plain(lines[0]!), /Enter details/u)
    assert.doesNotMatch(plain(lines[0]!), /type search/u,
      'the one-row bar must not advertise the search it refuses')
    assert.match(plain(lines[0]!), /← Back/u, 'the admitted root back verb is advertised')
    panel.handleInput('\r')
    assert.equal((panel as unknown as { leaderEditing: boolean }).leaderEditing, false,
      'Enter cannot open the hidden leader editor from a bar-only frame')
    assert.equal(closed, 0)
    // The advertised root back verb really works from that same frame.
    panel.handleInput('\x1b[D')
    assert.equal(closed, 1, 'the painted ← Back closes the bar-only root list')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('a settled detail result keeps the page navigation lock until its frame paints', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  let settled: ((result: unknown) => void) | undefined
  const panel = new KeybindingEditorPanel({
    model,
    onClose: () => {},
    runMutation: (_mutation, onResult) => {
      settled = result => { onResult(result as never) }
    },
    maxRows: () => 30,
  })
  try {
    panel.render(88)
    panel.handleInput('submit')
    panel.render(88)
    panel.handleInput('\r') // action detail
    panel.render(88)
    assert.equal(panel.blocksParentNavigation(), true, 'the detail already blocks the root')
    panel.handleInput('r') // in-flight write
    panel.render(88)
    settled!({ kind: 'rejected', message: 'the authority refused the reset' })
    assert.equal(panel.blocksParentNavigation(), true,
      'a settled-but-unpainted detail result still refuses a category change')
    const painted = plain(panel.render(88).join('\n'))
    assert.match(painted, /the authority refused the reset/u)
    assert.equal(panel.blocksParentNavigation(), true, 'the detail itself still owns the page')
    panel.handleInput('\x1b') // detail -> list
    panel.render(88)
    assert.equal((panel as unknown as { settlementAwaitingPaint: boolean }).settlementAwaitingPaint, false,
      'the painted result releases the settlement lock')
    assert.equal((panel as unknown as { actionEditor?: unknown }).actionEditor, undefined,
      'the detail really closed')
    // The page still blocks the root for its own reason: the query is kept.
    assert.equal(panel.blocksParentNavigation(), true, 'the preserved query still blocks navigation')
    panel.handleInput('\x1b') // clear the query
    panel.render(88)
    assert.equal(panel.blocksParentNavigation(), false, 'the cleared list releases the root again')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('a bar-only root list with a query neither clears it nor claims the back verb', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  let closed = 0
  const panel = new KeybindingEditorPanel({
    model,
    onClose: () => { closed += 1 },
    runMutation: () => {},
    maxRows: () => 30,
  })
  try {
    panel.render(88)
    panel.handleInput('submit') // a real query on a normal grant
    panel.setMaxRows(1)
    const bar = plain(panel.render(88).join('\n'))
    assert.doesNotMatch(bar, /← Back|type search/u,
      `a bar-only query state advertises only the Esc it accepts: ${bar}`)
    assert.match(bar, /Clear \[Esc\]/u)
    panel.handleInput('\x1b[D')
    assert.equal(closed, 0, 'a non-empty query keeps ← away from the page back')
    assert.equal((panel as unknown as { query: string }).query, 'submit', 'the invisible query is untouched')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('a bar-only action detail refuses a hidden Enter and Add until its body paints', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.input.submit')!
  const mutations: unknown[] = []
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: mutation => { mutations.push(mutation) },
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 1,
  })
  try {
    const lines = editor.render(88)
    assert.equal(lines.length, 1)
    assert.match(plain(lines[0]!), /Back \[Esc\]/u)
    editor.handleInput('\r')
    editor.handleInput('a')
    assert.deepEqual(mutations, [], 'no hidden recorder or choose-binding transition ran')
    assert.equal((editor as unknown as { mode: string }).mode, 'edit')
    assert.equal((editor as unknown as { recorder: unknown }).recorder, undefined)
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('a bar-only key recorder accepts only its painted Esc, never a hidden key', () => {
  const captured: string[] = []
  let cancelled = 0
  const recorder = new KeyRecorder({
    purpose: 'direct',
    label: 'the test shortcut',
    maxRows: () => 1,
    requestRender: () => {},
    onCapture: key => { captured.push(key) },
    onCancel: () => { cancelled += 1 },
  })
  const lines = recorder.render(60)
  assert.equal(lines.length, 1)
  assert.match(plain(lines[0]!), /Cancel \[Esc\]/u)
  recorder.handleInput('\x18')
  assert.deepEqual(captured, [], 'a key is not captured while only the bar is painted')
  recorder.handleInput('\x1b')
  assert.equal(cancelled, 1, 'the painted Esc still cancels')
})

test('the list bar publishes the ONE painted Esc span and never a half token', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    // Paint the frame FIRST: the span always describes the last completed paint.
    const bar = (): string => plain(panel.render(88).at(-1)!)
    const expectVerb = (verb: string): void => {
      const painted = bar()
      const span = panel.paintedEscapeSpan()
      assert.ok(span !== undefined, `the ${verb} affordance is complete`)
      assert.equal(painted.slice(span.startCol, span.endCol), `${verb} [Esc]`,
        `the span covers exactly the plain ${verb} token`)
      assert.equal(span.endCol - span.startCol, visibleWidth(`${verb} [Esc]`),
        'painting the affordance never changes its visible width')
    }

    // Empty query: the root list's Esc returns to Settings.
    expectVerb('Back')
    // A non-empty query: Esc clears the search and never closes the page.
    panel.handleInput('todo')
    expectVerb('Clear')
    // No whole wording fits: the historical fallback carries no geometry.
    panel.render(5)
    assert.equal(panel.paintedEscapeSpan(), undefined, 'a cut bar is never clickable')
    panel.handleInput('\x1b') // clear the query
    expectVerb('Back')
    // The detail page owns its bar; the list delegates that page-local span.
    panel.handleInput('\x1b[B')
    panel.handleInput('\r')
    const detailBar = plain(panel.render(88).at(-1)!)
    const detailSpan = panel.paintedEscapeSpan()
    assert.ok(detailSpan !== undefined, 'the detail span is delegated to the list')
    assert.equal(detailBar.slice(detailSpan.startCol, detailSpan.endCol), 'Back [Esc]')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('the leader editor publishes its own Back [Esc] span and none while saving', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.handleInput('\r') // leader editor
    const verbSpan = (): { readonly text: string; readonly startCol: number; readonly endCol: number } => {
      const painted = plain(panel.render(88).at(-1)!)
      const span = panel.paintedEscapeSpan()
      assert.ok(span !== undefined, 'the leader bar advertises a complete Esc affordance')
      return { text: painted, startCol: span.startCol, endCol: span.endCol }
    }
    const full = verbSpan()
    assert.equal(full.text.slice(full.startCol, full.endCol), 'Back [Esc]')

    // A bar-only grant keeps the same truthful span after its own paint.
    panel.setMaxRows(1)
    assert.equal(panel.paintedEscapeSpan(), undefined, 'the new grant has not painted yet')
    const short = verbSpan()
    assert.equal(short.text.slice(short.startCol, short.endCol), 'Back [Esc]')

    // A pending leader write freezes input: facts only, no Esc geometry.
    panel.setMaxRows(30)
    panel.render(88)
    panel.handleInput('r') // a reset write that never settles
    assert.match(plain(panel.render(88).join('\n')), /Saving…/)
    assert.equal(panel.paintedEscapeSpan(), undefined, 'the frozen write advertises no clickable Esc')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('the action detail publishes its own Back [Esc] span and none when cut', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.transcript.search.view')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 30,
  })
  try {
    assert.equal(editor.paintedEscapeSpan(), undefined, 'no frame has been painted yet')
    const painted = plain(editor.render(88).at(-1)!)
    const span = editor.paintedEscapeSpan()
    assert.ok(span !== undefined, 'the detail bar advertises a complete Esc affordance')
    assert.equal(painted.slice(span.startCol, span.endCol), 'Back [Esc]',
      'the span covers exactly the plain detail Esc token')
    assert.equal(span.endCol - span.startCol, visibleWidth('Back [Esc]'),
      'painting the affordance never changes its visible width')

    // A width where not even the fallback fits: no half token is clickable.
    editor.render(7)
    assert.equal(editor.paintedEscapeSpan(), undefined, 'a cut detail bar publishes no span')
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('the list delegates the action detail span unchanged', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.render(88)
    panel.handleInput('\x1b[B') // the first action row
    panel.handleInput('\r') // open its detail
    const lines = panel.render(88)
    const span = panel.paintedEscapeSpan()
    const painted = plain(lines.at(-1)!)
    assert.ok(span !== undefined, 'the delegated detail span survives the list render')
    assert.equal(painted.slice(span.startCol, span.endCol), 'Back [Esc]')
    const detail = (panel as unknown as { actionEditor?: ActionEditorPanel }).actionEditor
    assert.ok(detail !== undefined)
    assert.deepEqual(span, detail.paintedEscapeSpan(),
      'the list reports the SAME page-local span its detail page painted')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('the recorder publishes Cancel [Esc] for a real cancel, never for interrupt assignment', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({ 'app.agent.interrupt': 'ctrl+x' })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const detail = model.rows.find(candidate => candidate.id === 'app.transcript.search.view')!
  const editor = new ActionEditorPanel({
    model,
    action: detail,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 30,
  })
  const interruptRow = model.rows.find(candidate => candidate.id === 'app.agent.interrupt')!
  const interrupt = new ActionEditorPanel({
    model,
    action: interruptRow,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 30,
  })
  try {
    // The ordinary recorder's Esc really cancels back to the detail.
    editor.handleInput('\r') // start the recorder on the selected binding
    const painted = plain(editor.render(88).at(-1)!)
    const span = editor.paintedEscapeSpan()
    assert.ok(span !== undefined, 'the recorder cancel is a complete affordance')
    assert.equal(painted.slice(span.startCol, span.endCol), 'Cancel [Esc]',
      'the span covers exactly the plain Cancel token')
    // A cut recorder row publishes no geometry.
    editor.render(5)
    assert.equal(editor.paintedEscapeSpan(), undefined)

    // The interrupt recorder's Escape window ASSIGNS a key when pressed twice:
    // it stays a raw-input state hint and publishes no mouse geometry.
    interrupt.handleInput('\r')
    const interruptBar = plain(interrupt.render(88).at(-1)!)
    assert.match(interruptBar, /Esc: cancel/, 'the interrupt raw-input hint stays')
    assert.match(interruptBar, /double-Esc: assign Escape/u, 'the assignment hint stays discoverable')
    assert.equal(interrupt.paintedEscapeSpan(), undefined,
      'the recorder never manufactures a mouse key press')
  } finally {
    editor.dispose()
    interrupt.dispose()
    manager.dispose()
  }
})

// ── UX PR2: All / Conflicts view modes and readonly runtime records ────────

function conflictPanel(options: { readonly initialFilter?: 'all' | 'conflicts' } = {}) {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({
    'app.input.submit': 'ctrl+shift+h',
    'app.todo.toggle': 'ctrl+shift+h',
  })
  manager.setUserConfiguration(parsed)
  const mutations: unknown[] = []
  const panel = new KeybindingEditorPanel({
    model: buildKeybindingEditorModel(manager, parsed),
    initialFilter: options.initialFilter,
    onClose: () => {},
    runMutation: mutation => { mutations.push(mutation) },
    maxRows: () => 30,
  })
  return { manager, panel, mutations }
}

test('keybinding editor: Tab switches All ↔ Conflicts without a write and preserves the query', () => {
  const { manager, panel, mutations } = conflictPanel()
  try {
    let view = plain(panel.render(88).join('\n'))
    assert.match(view, /View: \[All\] · Conflicts \(2 affected actions\)/u)
    assert.match(view, /Leader key/u, 'All keeps the leader row')
    panel.handleInput('\t')
    view = plain(panel.render(88).join('\n'))
    assert.match(view, /View: All · \[Conflicts \(2 affected actions\)\]/u)
    assert.match(view, /Affected actions/u)
    assert.match(view, /Submit draft/u)
    assert.match(view, /Toggle todo/u)
    assert.doesNotMatch(view, /Leader key/u, 'Conflicts never paints the leader configuration row')
    assert.doesNotMatch(view, /Search full transcript history/u, 'unaffected actions are filtered out')

    // The mode switch is presentation-only and keeps the ONE query.
    panel.handleInput('todo')
    panel.handleInput('\t')
    view = plain(panel.render(88).join('\n'))
    assert.match(view, /View: \[All\] · Conflicts \(2 affected actions\)/u)
    assert.match(view, /Search: todo/u, 'the query survives a mode switch')
    assert.deepEqual(mutations, [], 'no filter transition may ever write settings')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('keybinding editor: plugin-only runtime conflicts stay read-only and readable', () => {
  const manager = new HostKeybindingManager()
  manager.setPluginRules([
    { id: 'plugin-a', action: 'submit-draft', key: 'ctrl+alt+x' },
    { id: 'plugin-b', action: 'open-search', key: 'ctrl+alt+x' },
  ])
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const mutations: unknown[] = []
  const panel = new KeybindingEditorPanel({
    model: buildKeybindingEditorModel(manager, parsed),
    initialFilter: 'conflicts',
    onClose: () => {},
    runMutation: mutation => { mutations.push(mutation) },
    maxRows: () => 30,
  })
  try {
    let view = plain(panel.render(88).join('\n'))
    assert.match(view, /View: All · \[Conflicts \(0 affected actions\)\]/u)
    assert.match(view, /Other runtime conflicts · 1 runtime conflict records/u)
    assert.match(view, /Key Ctrl\+Alt\+X · 2 actions/u)
    panel.handleInput('\r') // the only selectable row is the readonly record
    view = plain(panel.render(88).join('\n'))
    assert.match(view, /Runtime conflict record/u)
    assert.match(view, /Key: Ctrl\+Alt\+X/u)
    assert.match(view, /submit-draft/u)
    assert.match(view, /open-search/u)
    assert.match(view, /Scope: global · Source: plugin/u)
    panel.handleInput('r')
    panel.handleInput('\r')
    assert.deepEqual(mutations, [], 'the readonly record detail has no writer route')
    panel.handleInput('\x1b')
    view = plain(panel.render(88).join('\n'))
    assert.match(view, /Other runtime conflicts/u, 'Esc returns to the filtered list')
    assert.match(view, /View: All · \[Conflicts/u)
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('keybinding editor: zero conflicts opens the empty Conflicts page and leaves All reachable', () => {
  const { manager, panel } = makePanel(() => {})
  try {
    panel.handleInput('\t') // render first so the mode row is painted
    const first = plain(panel.render(88).join('\n'))
    assert.match(first, /View: \[All\]/u)
    panel.handleInput('\t')
    let view = plain(panel.render(88).join('\n'))
    assert.match(view, /View: All · \[Conflicts \(0 affected actions\)\]/u)
    assert.match(view, /No conflicts in the current keymap\./u)
    assert.doesNotMatch(view, /Other runtime conflicts/u)
    panel.handleInput('\t')
    view = plain(panel.render(88).join('\n'))
    assert.match(view, /View: \[All\]/u)
    assert.match(view, /Leader key/u, 'All is reachable again')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('keybinding editor: mode spans are the only clickable cells and stale gestures are inert', () => {
  const { manager, panel } = conflictPanel()
  try {
    let view = panel.render(88)
    const plainView = view.map(plain)
    const modeRow = plainView.findIndex(line => line.startsWith('View: '))
    assert.ok(modeRow >= 0)
    // `View: [All] · Conflicts (...)` — the All span is [6,11), the separator
    // is inert, and the Conflicts span starts after ` · `.
    assert.equal(panel.handleMouse(mouse('press', 11, modeRow, 88, 30)), undefined,
      'the separator between the two spans is inert')
    assert.ok(panel.handleMouse(mouse('press', 7, modeRow, 88, 30))?.handled)
    assert.ok(panel.handleMouse(mouse('click', 7, modeRow, 88, 30))?.handled)
    // No-op: already All. The click must not write anything.
    panel.render(88)
    assert.ok(panel.handleMouse(mouse('press', 15, modeRow, 88, 30))?.handled)
    assert.ok(panel.handleMouse(mouse('click', 15, modeRow, 88, 30))?.handled)
    let now = plain(panel.render(88).join('\n'))
    assert.match(now, /View: All · \[Conflicts/u, 'a press + same-span release switches mode')
    // A release on the OTHER span must not switch anything.
    const conflictsModeRow = panel.render(88).map(plain).findIndex(line => line.startsWith('View: '))
    assert.ok(panel.handleMouse(mouse('press', 7, conflictsModeRow, 88, 30))?.handled)
    assert.equal(panel.handleMouse(mouse('click', 15, conflictsModeRow, 88, 30)), undefined,
      'a different span on release is rejected')
    now = plain(panel.render(88).join('\n'))
    assert.match(now, /View: All · \[Conflicts/u)
    // A query change between press and release makes the old gesture inert.
    assert.ok(panel.handleMouse(mouse('press', 7, conflictsModeRow, 88, 30))?.handled)
    panel.handleInput('q')
    assert.equal(panel.handleMouse(mouse('click', 7, conflictsModeRow, 88, 30)), undefined,
      'an empty → non-empty query change under the gesture refuses the stale release')
    // Non-empty → non-empty is a REAL query change too: the identity must not
    // collapse every non-empty query into one state.
    panel.render(88)
    assert.ok(panel.handleMouse(mouse('press', 7, conflictsModeRow, 88, 30))?.handled)
    panel.handleInput('r')
    assert.equal(panel.handleMouse(mouse('click', 7, conflictsModeRow, 88, 30)), undefined,
      'a non-empty → non-empty query change refuses the stale release')
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('keybinding editor: a narrow/absent mode row makes Tab and spans inert', () => {
  const { manager, panel } = conflictPanel()
  try {
    const narrow = plain(panel.render(20).join('\n'))
    assert.match(narrow, /View: \[All\]/u, 'the narrow row states the active mode read-only')
    panel.handleInput('\t')
    assert.match(plain(panel.render(20).join('\n')), /View: \[All\]/u, 'Tab is inert without painted spans')
    // The 2-row grant has no mode row at all; Tab must not switch a hidden mode,
    // even when the PREVIOUS frame was a fully painted mode row.
    panel.setMaxRows(30)
    panel.render(88)
    panel.setMaxRows(2)
    const two = plain(panel.render(88).join('\n'))
    assert.match(two, /^Search: /mu)
    assert.doesNotMatch(two, /Tab view/u, 'the two-row bar must not advertise the hidden mode switch')
    panel.handleInput('\t')
    assert.match(plain(panel.render(88).join('\n')), /^Search: /mu)
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('action editor: a runtime record with a non-builtin counterpart is stated read-only', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  const base = buildKeybindingEditorModel(manager, parsed)
  // Display projection only: the current resolver priority table shadows a
  // plugin rule below a builtin/user rule, so this record shape is not produced
  // by the live manager today. The read-only projection must still never drop a
  // non-builtin counterpart if one is present in the model.
  const model = {
    ...base,
    runtimeConflictRecords: [{
      key: 'ctrl+alt+x' as const,
      actions: [
        { action: 'app.input.submit', scope: 'editor' as const, source: 'user' as const, ruleId: 'builtin:user' },
        { action: 'submit-draft', scope: 'global' as const, source: 'plugin' as const, ruleId: 'plugin:plugin-a' },
      ],
    }],
  }
  const row = model.rows.find(candidate => candidate.id === 'app.input.submit')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
  })
  try {
    const view = plain(editor.render(88).join('\n'))
    assert.match(view, /Related runtime conflicts/u)
    assert.match(view, /Key Ctrl\+Alt\+X: app\.input\.submit \(editor, user\) vs submit-draft \(global, plugin\)/u)
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('keybinding editor: a short-grant readonly record detail keeps every field reachable', () => {
  const manager = new HostKeybindingManager()
  manager.setPluginRules([
    { id: 'plugin-a', action: 'submit-draft-with-a-very-long-action-name', key: 'ctrl+alt+x' },
    { id: 'plugin-b', action: 'open-search-with-another-very-long-action-name', key: 'ctrl+alt+x' },
  ])
  const parsed = parseUserKeybindings(undefined)
  manager.setUserConfiguration(parsed)
  let rows = 30
  const panel = new KeybindingEditorPanel({
    model: buildKeybindingEditorModel(manager, parsed),
    initialFilter: 'conflicts',
    onClose: () => {},
    runMutation: () => {},
    maxRows: () => rows,
  })
  try {
    panel.render(36)
    panel.handleInput('\r') // open the readonly record at the full grant
    rows = 3 // then exercise its short-grant scroll port
    const seen: string[] = []
    for (let step = 0; step < 12; step += 1) {
      seen.push(plain(panel.render(36).join('\n')))
      panel.handleInput('\x1b[6~') // PageDown
    }
    const bodies = seen.map(frame => frame.split('\n').slice(0, -1).join('')).join('\n')
    assert.match(bodies, /submit-draft-with-a-very-long-action-name/u, 'the first long action is reachable across its wrapped lines')
    assert.match(bodies, /open-search-with-another-very-long-action-name/u, 'the second long action is reachable across its wrapped lines')
    assert.match(bodies, /Scope: global · Source: plugin/u, 'the scope/source line is reachable')
    // The back row stays the ONE last row on every short frame.
    for (const frame of seen) assert.match(frame.split('\n').at(-1)!, /Back \[Esc\]/u)
    // Every short frame still contains at least one real content line, never
    // two scroll markers with no field text.
    for (const frame of seen) {
      const body = frame.split('\n').slice(0, -1)
      if (body.length > 0) assert.ok(body.some(line => !/^[↑↓] \d+ more lines$/u.test(line)), 'a marker must not consume the whole body')
    }
  } finally {
    panel.dispose()
    manager.dispose()
  }
})

test('action editor: a short conflict detail reaches both real participants through c details', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({
    'app.input.submit': 'ctrl+shift+h',
    'app.todo.toggle': 'ctrl+shift+h',
  })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.input.submit')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 6,
  })
  try {
    const editFrame = plain(editor.render(60).join('\n'))
    assert.match(editFrame, /c details/u, 'the short detail bar advertises the read-only conflict reader')
    editor.handleInput('c')
    const frame = plain(editor.render(60).join('\n'))
    assert.match(frame, /keybinding conflict on Ctrl\+Shift\+H/u)
    assert.match(frame, /app\.input\.submit@user:ctrl\+shift\+h \(editor, user\)/u)
    assert.match(frame, /app\.todo\.toggle@user:ctrl\+shift\+h \(global, user\)/u,
      'the counterpart is readable at a short grant, not hidden below the shortcut row')
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('action editor: a long conflict diagnostic is scrollable in the read-only reader', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({
    'app.input.submit': 'ctrl+shift+h',
    'app.todo.toggle': 'ctrl+shift+h',
  })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.input.submit')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 4,
  })
  try {
    editor.render(36)
    editor.handleInput('c')
    const frames: string[] = []
    for (let step = 0; step < 12; step += 1) {
      frames.push(plain(editor.render(36).join('\n')))
      editor.handleInput('\x1b[6~')
    }
    const bodies = frames.map(frame => frame.split('\n').slice(0, -1).join('')).join('\n')
    assert.match(bodies, /app\.input\.submit@user:ctrl\+shift\+h\s*\(editor, user\)/u)
    assert.match(bodies, /app\.todo\.toggle@user:ctrl\+shift\+h\s*\(global, user\)/u)
    for (const frame of frames) assert.match(frame.split('\n').at(-1)!, /Back \[Esc\]/u)
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('action editor: a failed write result stays painted on a short conflict detail', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({
    'app.input.submit': 'ctrl+shift+h',
    'app.todo.toggle': 'ctrl+shift+h',
  })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.input.submit')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: (_mutation, _onResult, onError) => onError(new Error('save failed')),
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 5,
  })
  try {
    editor.render(60)
    editor.handleInput('r')
    const frame = plain(editor.render(60).join('\n'))
    assert.match(frame, /save failed/u, 'the failed result is visible even below a short grant')
    assert.match(frame, /Back \[Esc\]/u)
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('action editor: c details is inert while choose-binding owns the keys', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({
    'app.input.submit': 'ctrl+shift+h',
    'app.todo.toggle': 'ctrl+shift+h',
  })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.input.submit')!
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: () => {},
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => 30,
  })
  try {
    editor.render(60)
    editor.handleInput('a') // choose-binding sub-view
    const choice = plain(editor.render(60).join('\n'))
    assert.match(choice, /Choose what to record/u)
    editor.handleInput('c') // must stay in the choice view
    const after = plain(editor.render(60).join('\n'))
    assert.match(after, /Choose what to record/u)
    assert.doesNotMatch(after, /Conflict details/u)
  } finally {
    editor.dispose()
    manager.dispose()
  }
})

test('action editor: a one-row grant paints the failed settlement before unlocking', () => {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings({
    'app.input.submit': 'ctrl+shift+h',
    'app.todo.toggle': 'ctrl+shift+h',
  })
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  const row = model.rows.find(candidate => candidate.id === 'app.input.submit')!
  let failWrite!: () => void
  let rows = 30
  const editor = new ActionEditorPanel({
    model,
    action: row,
    runMutation: (_mutation, _onResult, onError) => { failWrite = () => onError(new Error('save failed')) },
    onModelChange: () => {},
    onBack: () => {},
    maxRows: () => rows,
  })
  try {
    editor.render(60)
    editor.handleInput('r') // pending reset
    assert.match(plain(editor.render(60).join('\n')), /Saving…/u)
    rows = 1
    editor.render(60)
    failWrite()
    const frame = plain(editor.render(60).join('\n'))
    assert.match(frame, /save failed/u, 'the one-row frame paints the failure itself')
    assert.match(frame, /Back \[Esc\]/u, 'the one-row frame still exposes its ONE exit affordance')
    assert.ok(editor.paintedEscapeSpan() !== undefined, 'the visible Back span is a real pointer target')
    assert.doesNotMatch(frame, /Saving…/u)
    for (const narrow of [10, 11, 12]) {
      const narrowFrame = plain(editor.render(narrow).join('\n'))
      assert.match(narrowFrame, /Back \[Esc\]/u, `the full exit segment survives a ${narrow}-column one-row grant`)
      assert.ok(editor.paintedEscapeSpan() !== undefined, `the ${narrow}-column Back span is a real pointer target`)
    }
  } finally {
    editor.dispose()
    manager.dispose()
  }
})
