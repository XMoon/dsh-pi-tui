import assert from 'node:assert/strict'
import test from 'node:test'
import {
  currentFrameCopyActions,
  exactCopyOutcomes,
  qualifiesClipboardSink,
  transcriptCopyNodeId,
} from '../../scripts/tern-pane-conversation-layout.mjs'

const userPayload = 'synthetic user text\n'
const assistantPayload = 'synthetic assistant text'

const action = (id, act = 'dsh-transcript-copy') => ({ ev: 'action', sf: 'sf-main-1', id, act })
const outcome = (payload, copied = true) => ({ kind: 'client.copy.result', payload, copied })

test('a Copy PASS requires one exact current SDK action and one successful production sink outcome per payload', () => {
  const events = currentFrameCopyActions([
    action('main.s1-msg-1'),
    action('main.s1-msg-2'),
    action('main.s1-msg-3', 'dsh-visual-copy'),
  ])
  const outcomes = exactCopyOutcomes([
    outcome(userPayload),
    outcome(assistantPayload),
  ])
  assert.equal(qualifiesClipboardSink(events, outcomes, [userPayload, assistantPayload]), true)
})

test('missing node identity, duplicate payloads without an action, or failed sink outcomes never qualify', () => {
  assert.equal(qualifiesClipboardSink([action('')], [outcome(userPayload)], [userPayload]), false)
  assert.equal(qualifiesClipboardSink([action('main.s1-msg-1')], [], [userPayload]), false)
  assert.equal(qualifiesClipboardSink([action('main.s1-msg-1')], [outcome(userPayload, false)], [userPayload]), false)
  assert.equal(qualifiesClipboardSink([
    action('main.s1-msg-1'), action('main.s1-msg-1'),
  ], [outcome(userPayload), outcome(assistantPayload)], [userPayload, assistantPayload]), false)
})

const addFrame = nodes => [{ dir: 'out', verb: 'f', body: { ops: nodes.map(node => ['add', node.id, 'main', null, node]) } }]
const copyButton = id => ({ id, k: 'button', p: { role: 'dsh.transcript.copy', actions: { click: 'dsh-transcript-copy' } } })
const userMessage = (id, text) => ({
  id, k: 'message', p: { role: 'dsh.transcript.user', actions: [{ act: 'dsh-transcript-copy' }] },
  c: [{ id: `${id}.body`, k: 'md', p: { text } }],
})
const assistantCol = (id, text) => ({
  id, k: 'col', p: { role: 'dsh.transcript.assistant' },
  c: [
    { id: `${id}.body`, k: 'md', p: { text } },
    { id: `${id}.message-actions`, k: 'row', c: [copyButton(`${id}.message-actions.copy`)] },
  ],
})

test('the expected copy node id is anchored to the clicked marker, not a reverse-walk distractor', () => {
  const records = addFrame([
    userMessage('main.u-other', 'an earlier user turn without the marker'),
    assistantCol('main.a-other', 'an earlier assistant turn without the marker'),
    userMessage('main.u-mixed', 'TSP-QUESTION-MIXED the user turn under test'),
    assistantCol('main.a-final', 'TSP-ANSWER-FINAL the assistant turn under test'),
  ])
  assert.equal(transcriptCopyNodeId(records, 'user'), 'main.u-mixed')
  assert.equal(transcriptCopyNodeId(records, 'assistant'), 'main.a-final.message-actions.copy')
})

test('a transcript-root add that contains the marker still resolves to the deepest matching message', () => {
  const root = {
    id: 'main', k: 'col', p: { key: 'transcript' },
    c: [
      assistantCol('main.a-other', 'an earlier assistant turn without the marker'),
      userMessage('main.u-mixed', 'TSP-QUESTION-MIXED the user turn under test'),
      assistantCol('main.a-final', 'TSP-ANSWER-FINAL the assistant turn under test'),
    ],
  }
  const records = addFrame([root])
  assert.equal(transcriptCopyNodeId(records, 'user'), 'main.u-mixed')
  assert.equal(transcriptCopyNodeId(records, 'assistant'), 'main.a-final.message-actions.copy')
  assert.equal(transcriptCopyNodeId(addFrame([userMessage('main.u-other', 'no marker here')]), 'user'), undefined)
})
