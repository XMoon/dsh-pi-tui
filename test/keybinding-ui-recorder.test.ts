import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DOUBLE_ESCAPE_MS,
  KeyRecorder,
  type KeyRecorderTimer,
  validateRecordedKey,
} from '../src/keybinding-ui/recorder.ts'

function noop(): void {}

function fakeTimer(): {
  readonly timer: KeyRecorderTimer
  readonly fire: () => void
  readonly delay: () => number | undefined
} {
  let callback: (() => void) | undefined
  let scheduledDelay: number | undefined
  const timer: KeyRecorderTimer = {
    set: (next, delay) => {
      callback = next
      scheduledDelay = delay
      return Symbol('escape-timer')
    },
    clear: () => {
      callback = undefined
      scheduledDelay = undefined
    },
  }
  return {
    timer,
    fire: () => {
      const next = callback
      callback = undefined
      scheduledDelay = undefined
      next?.()
    },
    delay: () => scheduledDelay,
  }
}

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

test('ordinary recorder cancels immediately on Escape', () => {
  let captures = 0
  let cancels = 0
  const recorder = new KeyRecorder({
    purpose: 'direct',
    action: 'app.todo.toggle',
    label: 'todo panel',
    onCapture: () => { captures += 1 },
    onCancel: () => { cancels += 1 },
  })
  recorder.handleInput('\x1b')
  assert.equal(captures, 0)
  assert.equal(cancels, 1)
})

test('interrupt recorder assigns Escape only on double-Esc', () => {
  let captured: string | undefined
  let cancels = 0
  let renders = 0
  const clock = fakeTimer()
  const recorder = new KeyRecorder({
    purpose: 'direct',
    action: 'app.agent.interrupt',
    label: 'interrupt',
    onCapture: key => { captured = key },
    onCancel: () => { cancels += 1 },
    requestRender: () => { renders += 1 },
    timer: clock.timer,
  })
  const initial = recorder.render(88).join('\n')
  assert.match(initial, /double-Esc: assign Escape/)
  assert.doesNotMatch(initial, /e: use Escape/)
  recorder.handleInput('e')
  assert.equal(captured, undefined, 'the removed e shortcut must not assign Escape')
  recorder.handleInput('\x1b')
  assert.equal(clock.delay(), DOUBLE_ESCAPE_MS)
  assert.equal(cancels, 0)
  assert.equal(renders, 2, 'invalid e and the pending Escape each request a repaint')
  assert.match(recorder.render(88).join('\n'), /Esc again to assign Escape/)
  recorder.handleInput('\x1b')
  assert.equal(captured, 'escape')
  assert.equal(cancels, 0)
  clock.fire()
  assert.equal(cancels, 0, 'a captured Escape must clear the timeout')
  assert.match(validateRecordedKey('escape', { purpose: 'direct', action: 'app.todo.toggle' }).message!, /reserved/i)
})

test('a single interrupt Escape cancels after the double-press window', () => {
  let captures = 0
  let cancels = 0
  const clock = fakeTimer()
  const recorder = new KeyRecorder({
    purpose: 'direct',
    action: 'app.agent.interrupt',
    label: 'interrupt',
    onCapture: () => { captures += 1 },
    onCancel: () => { cancels += 1 },
    timer: clock.timer,
  })
  recorder.handleInput('\x1b')
  assert.equal(cancels, 0)
  clock.fire()
  assert.equal(captures, 0)
  assert.equal(cancels, 1)
})

test('Escape repeat and release do not count as the second press', () => {
  let captures = 0
  let cancels = 0
  const clock = fakeTimer()
  const recorder = new KeyRecorder({
    purpose: 'direct',
    action: 'app.agent.interrupt',
    label: 'interrupt',
    onCapture: () => { captures += 1 },
    onCancel: () => { cancels += 1 },
    timer: clock.timer,
  })
  recorder.handleInput('\x1b')
  recorder.handleInput('\x1b[27;1:3u')
  recorder.handleInput('\x1b[27;1:2u')
  assert.equal(captures, 0)
  assert.equal(cancels, 0)
  clock.fire()
  assert.equal(cancels, 1)
})

test('a non-Escape key during pending Escape cancels without capturing it', () => {
  let captures = 0
  let cancels = 0
  const clock = fakeTimer()
  const recorder = new KeyRecorder({
    purpose: 'direct',
    action: 'app.agent.interrupt',
    label: 'interrupt',
    onCapture: () => { captures += 1 },
    onCancel: () => { cancels += 1 },
    timer: clock.timer,
  })
  recorder.handleInput('\x1b')
  recorder.handleInput('\x18')
  assert.equal(captures, 0)
  assert.equal(cancels, 1)
  clock.fire()
  assert.equal(cancels, 1)
})

test('dispose clears pending Escape and blocks late callbacks or repaint', () => {
  let captures = 0
  let cancels = 0
  let renders = 0
  const clock = fakeTimer()
  const recorder = new KeyRecorder({
    purpose: 'direct',
    action: 'app.agent.interrupt',
    label: 'interrupt',
    onCapture: () => { captures += 1 },
    onCancel: () => { cancels += 1 },
    requestRender: () => { renders += 1 },
    timer: clock.timer,
  })
  recorder.handleInput('\x1b')
  assert.equal(renders, 1)
  recorder.dispose()
  clock.fire()
  assert.equal(captures, 0)
  assert.equal(cancels, 0)
  assert.equal(renders, 1)
  recorder.handleInput('\x1b')
  assert.equal(cancels, 0)
})
