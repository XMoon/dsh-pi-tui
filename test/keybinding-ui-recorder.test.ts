import assert from 'node:assert/strict'
import test from 'node:test'
import { KeyRecorder, validateRecordedKey } from '../src/keybinding-ui/recorder.ts'

function noop(): void {}

test('recorder parses terminal input and returns the canonical KeyId', () => {
  let captured: string | undefined
  const recorder = new KeyRecorder({
    purpose: 'direct',
    action: 'app.todo.toggle',
    label: 'todo panel',
    onCapture: key => { captured = key },
    onCancel: noop,
  })
  recorder.handleInput('\x1b[115;5u')
  assert.equal(captured, 'ctrl+s')
})

test('leader completions allow printable keys after the prefix', () => {
  assert.deepEqual(validateRecordedKey('t', { purpose: 'leader-completion', action: 'app.todo.toggle' }), {
    key: 't',
    message: undefined,
  })
  assert.equal(validateRecordedKey('t', { purpose: 'direct', action: 'app.todo.toggle' }).key, undefined)
})

test('recorder rejects dead, text-producing, and terminal-ambiguous keys', () => {
  assert.match(validateRecordedKey('shift+f5', { purpose: 'direct' }).message!, /cannot be matched/i)
  assert.match(validateRecordedKey('a', { purpose: 'direct' }).message!, /typing/i)
  assert.match(validateRecordedKey('ctrl+j', { purpose: 'direct' }).message!, /legacy terminals/i)
  assert.match(validateRecordedKey('shift+enter', { purpose: 'direct', action: 'app.input.submit' }).message!, /newline/i)
  assert.match(validateRecordedKey('tab', { purpose: 'direct', action: 'app.input.submit' }).message!, /before submit/i)
  assert.match(validateRecordedKey('escape', { purpose: 'leader-completion' }).message!, /cancel/i)
})

test('direct recorder can explicitly capture the legal Escape binding', () => {
  let captured: string | undefined
  const recorder = new KeyRecorder({
    purpose: 'direct',
    action: 'app.todo.toggle',
    label: 'todo panel',
    onCapture: key => { captured = key },
    onCancel: noop,
  })
  assert.match(recorder.render(88).join('\n'), /e: use Escape/)
  recorder.handleInput('e')
  assert.equal(captured, 'escape')
})

test('Escape cancels recording and never captures a binding', () => {
  let captures = 0
  let cancels = 0
  const recorder = new KeyRecorder({
    purpose: 'leader-key',
    label: 'global leader key',
    onCapture: () => { captures += 1 },
    onCancel: () => { cancels += 1 },
  })
  recorder.handleInput('\x1b')
  assert.equal(captures, 0)
  assert.equal(cancels, 1)
})
