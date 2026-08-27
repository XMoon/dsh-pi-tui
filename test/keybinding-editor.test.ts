import assert from 'node:assert/strict'
import test from 'node:test'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { HostKeybindingManager } from '../src/keybindings/manager.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { ActionEditorPanel } from '../src/keybinding-ui/action-editor.ts'
import { KeybindingEditorPanel, KeybindingEditorUnavailablePanel } from '../src/keybinding-ui/list.ts'
import type { KeybindingMutationResult } from '../src/keybinding-ui/controller.ts'
import { buildKeybindingEditorModel } from '../src/keybinding-ui/model.ts'

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
