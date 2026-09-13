/**
 * Headless tests for the semantic queue-pane projection.
 * @module @xmoon76/dsh-pi-tui/queue-notices.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { foldQueueRows, isPlainExitPrompt, type QueueInboxMessage } from '../src/index.ts'

/** One minimal semantic pending-input item for foldQueueRows tests. */
function msg(id: string, text = 'hello'): QueueInboxMessage {
  return { id, content: [{ type: 'text', text }] as never }
}

test('foldQueueRows preserves every semantic queued occurrence in order', () => {
  const result = foldQueueRows([
    msg('u1', 'user input'),
    msg('r1', 'background report'),
    msg('b1', 'job completion'),
  ], 'followup')

  assert.deepEqual(result.rows.map(row => row.id), ['u1', 'r1', 'b1'])
  assert.deepEqual(result.rows.map(row => row.text), ['user input', 'background report', 'job completion'])
  assert.ok(result.rows.every(row => !Object.hasOwn(row, 'notice')))
})

test('foldQueueRows preserves the delivery mode', () => {
  const result = foldQueueRows([msg('s1')], 'steer')
  assert.equal(result.rows[0]?.mode, 'steer')
})

test('the queue gesture selects semantic queued placement only', () => {
  const inbox = [
    { ...msg('queued-a'), placement: 'queued' as const },
    { ...msg('steering-b'), placement: 'steering' as const },
    { ...msg('context-c'), placement: 'context' as const },
    { ...msg('queued-d'), placement: 'queued' as const },
  ]
  const queued = inbox.filter(item => item.placement === 'queued')
  assert.deepEqual(queued.map(item => item.id), ['queued-a', 'queued-d'])
})

test('an empty semantic pending batch produces an empty pane', () => {
  assert.deepEqual(foldQueueRows([], 'followup').rows, [])
})

test('isPlainExitPrompt matches only the exact trimmed lowercase word', () => {
  assert.ok(isPlainExitPrompt('exit'))
  assert.ok(isPlainExitPrompt('  exit  '))
  assert.ok(!isPlainExitPrompt('exit!'), 'punctuation must not match')
  assert.ok(!isPlainExitPrompt('Exit'), 'case must not match')
  assert.ok(!isPlainExitPrompt('exit now'), 'extra words must not match')
  assert.ok(!isPlainExitPrompt('/exit'), 'the command form is separate')
  assert.ok(!isPlainExitPrompt(''), 'empty must not match')
})

test('foldQueueRows shows image blocks in the queue row', () => {
  const imageBlock = {
    type: 'image',
    attachment: { attachmentId: 'att-1', mediaType: 'image/png', bytes: 10, width: 800, height: 600, name: 'shot.png' },
  }
  const result = foldQueueRows([{
    id: 'mixed',
    content: [{ type: 'text', text: 'analyze this' }, imageBlock],
  } as never, {
    id: 'image-only',
    content: [imageBlock],
  } as never], 'steer')
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[0]!.text, 'analyze this 🖼️ shot.png', 'mixed row advertises its image')
  assert.equal(result.rows[1]!.text, '🖼️ shot.png', 'image-only row is never empty')
})

test('foldQueueRows shows generic file blocks in the queue row', () => {
  const fileBlock = {
    type: 'file',
    attachment: { attachmentId: 'sha256:file', name: 'report.pdf', bytes: 12345 },
  }
  const result = foldQueueRows([{
    id: 'file-only',
    content: [fileBlock],
  } as never], 'steer')
  assert.equal(result.rows[0]!.text, '📄 report.pdf · 12.1 KiB')
})
