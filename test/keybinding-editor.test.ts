import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { HostKeybindingManager } from '../src/keybindings/manager.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { ActionEditorPanel } from '../src/keybinding-ui/action-editor.ts'
import { KeybindingEditorPanel, KeybindingEditorUnavailablePanel } from '../src/keybinding-ui/list.ts'
import type { KeybindingMutationResult } from '../src/keybinding-ui/controller.ts'
import { buildKeybindingEditorModel } from '../src/keybinding-ui/model.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '')
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
    assert.match(view, /Keyboard shortcuts/)
    assert.match(view, /Leader key/)
    assert.match(view, /Input/)
    assert.match(view, /Submit draft/)
    assert.match(view, /fixed/)
    assert.match(view, /Enter: details/)
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
    editor.handleInput('\r')
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
  const row = model.rows.find(candidate => candidate.id === 'app.transcript.search')!
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
    assert.match(view, /Esc: back/)
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

test('editor search is cleared by the first Escape and closes on the second', () => {
  let closed = 0
  const { manager, panel } = makePanel(() => { closed += 1 })
  try {
    panel.handleInput('todo')
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
    panel.handleInput('\x1b[B')
    panel.handleInput('\r')
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
    assert.match(view, /Keyboard shortcuts › Submit draft/)
    assert.match(view, /Action ID: app\.input\.submit/)
    assert.match(view, /Default: Enter/)
  } finally {
    manager.dispose()
  }
})
