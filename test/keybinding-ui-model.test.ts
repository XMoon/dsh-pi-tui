import assert from 'node:assert/strict'
import test from 'node:test'
import { parseUserKeybindings } from '../src/keybindings/config.ts'
import { HostKeybindingManager } from '../src/keybindings/manager.ts'
import {
  buildKeybindingEditorModel,
  searchKeybindingRows,
} from '../src/keybinding-ui/model.ts'

function modelFor(raw: unknown) {
  const manager = new HostKeybindingManager()
  const parsed = parseUserKeybindings(raw)
  manager.setUserConfiguration(parsed)
  const model = buildKeybindingEditorModel(manager, parsed)
  return { manager, model }
}

test('editor model preserves defaults and exposes real category sections', () => {
  const { manager, model } = modelFor(undefined)
  try {
    const submit = model.rows.find(row => row.id === 'app.input.submit')!
    assert.equal(submit.customized, false)
    assert.deepEqual(submit.effective.map(binding => binding.key), ['enter'])
    assert.equal(submit.status, 'default')
    const unbound = model.rows.find(row => row.id === 'app.tasks.open')!
    assert.deepEqual(unbound.defaults, [])
    assert.deepEqual(unbound.effective, [{ kind: 'direct', key: 'down' }])
    assert.equal(unbound.status, 'unbound')
    const trulyUnbound = model.rows.find(row => row.id === 'app.transcript.toggleFullscreen')!
    assert.deepEqual(trulyUnbound.effective, [])
    assert.equal(trulyUnbound.status, 'unbound')
    assert.deepEqual(model.sections.map(section => section.category), [
      'Input', 'Agent', 'Transcript', 'Editor', 'Permission', 'Panels', 'Session', 'Question', 'Tasks',
    ])
    assert.ok(model.sections.every(section => section.rows.length > 0))
    assert.equal(model.leader.key, undefined)
  } finally {
    manager.dispose()
  }
})

test('search matches action ids, effective keys, and replaced defaults', () => {
  const { manager, model } = modelFor({ 'app.todo.toggle': 'ctrl+y' })
  try {
    const oldKeyMatches = searchKeybindingRows(model.rows, 'ctrl+t')
    assert.ok(oldKeyMatches.some(match => match.row.id === 'app.todo.toggle'))
    assert.ok(oldKeyMatches.find(match => match.row.id === 'app.todo.toggle')!.fields.includes('defaults'))

    const actionMatches = searchKeybindingRows(model.rows, 'todo ctrl+y')
    assert.deepEqual(actionMatches.map(match => match.row.id), ['app.todo.toggle'])
    assert.equal(model.rows.find(row => row.id === 'app.todo.toggle')!.status, 'customized')
  } finally {
    manager.dispose()
  }
})

test('model marks disabled, fixed, leader, and conflicting states distinctly', () => {
  const { manager, model } = modelFor({
    leader: 'ctrl+q',
    'app.todo.toggle': false,
    'app.transcript.toggleExpand': 'ctrl+y',
    'app.history.search': 'ctrl+y',
    'app.input.steer': '<leader>t',
  })
  try {
    const disabled = model.rows.find(row => row.id === 'app.todo.toggle')!
    const fixed = model.rows.find(row => row.id === 'question.confirm')!
    const conflict = model.rows.find(row => row.id === 'app.transcript.toggleExpand')!
    const leader = model.rows.find(row => row.id === 'app.input.steer')!
    assert.equal(disabled.status, 'disabled')
    assert.deepEqual(disabled.effective, [])
    assert.equal(fixed.status, 'fixed')
    assert.equal(fixed.fixed, true)
    assert.equal(conflict.conflict, true)
    assert.equal(conflict.status, 'conflict')
    assert.deepEqual(leader.effective, [{ kind: 'leader', key: 't' }])
    assert.equal(model.leader.key, 'ctrl+q')
    assert.match(model.summary, /customized/)
    assert.match(model.summary, /disabled/)
    assert.match(model.summary, /conflict/)
  } finally {
    manager.dispose()
  }
})
