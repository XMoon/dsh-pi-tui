// MAC09-08 / run 61 root cause: the turn-completion wait must start at the
// DURABLE PROMPT of the turn it waits for. Starting at the Session length
// sampled BEFORE sending also covers the previous turn's tail, whose turn/end
// then satisfies the wait, and the scene reads a trace that is still being
// written (the measured run-61 prefix ended exactly at the typeText START).
//
// These cases call the REAL completion condition (`nextTurnEnd`) and the REAL
// anchor derivation (`turnPromptAnchor`) the lane uses — the anchor is derived
// inside the condition from the durable prompt, so a hardcoded stop position
// cannot stand in for it.
import assert from 'node:assert/strict'
import test from 'node:test'

import { nextTurnEnd, turnPromptAnchor } from '../../scripts/smoke/macos-cua-parity.mjs'

// The previous turn is still running when the next prompt is sent: the durable
// prompt lands at 8 while the previous turn's end sits at 5.
const PREVIOUS_TURN_STILL_RUNNING = [
  { type: 'turn/start', data: { turn: 1 } },        // 0
  { type: 'tool/ptc-dispatch-start', data: { name: 'cua', arguments: { method: 'screenshot' } } }, // 1
  { type: 'tool/ptc-dispatch', data: { name: 'cua', arguments: { method: 'screenshot' } } },       // 2
  { type: 'step/end', data: { turn: 1 } },          // 3
  { type: 'agent/inbox/spliced', data: {} },        // 4
  { type: 'turn/end', data: { turn: 1 } },          // 5  <- PREVIOUS turn closes here
  { type: 'turn/start', data: { turn: 2 } },        // 6
  { type: 'step/start', data: { turn: 2 } },        // 7
  { type: 'user/message', data: {} },               // 8  <- durable prompt of turn 2
  { type: 'tool/call', data: { turn: 2 } },         // 9
  { type: 'tool/ptc-dispatch-start', data: { name: 'cua', arguments: { method: 'getApp' } } }, // 10
  { type: 'tool/ptc-dispatch', data: { name: 'cua', arguments: { method: 'getApp' } } },       // 11
  { type: 'tool/ptc-dispatch-start', data: { name: 'cua', arguments: { method: 'typeText' } } }, // 12
  { type: 'tool/ptc-dispatch', data: { name: 'cua', arguments: { method: 'typeText' } } },       // 13
  { type: 'turn/end', data: { turn: 2 } },          // 14 <- the awaited turn closes here
]

const PROMPT = { index: 8 }

test('the completion condition closes on the turn that carries the prompt', () => {
  const matched = nextTurnEnd(PREVIOUS_TURN_STILL_RUNNING, PROMPT)
  assert.equal(matched.events[matched.index].data.turn, 2)
})

test('the anchor derived from the durable prompt is the position AFTER it', () => {
  assert.equal(turnPromptAnchor(PROMPT), PROMPT.index + 1)
})

test('a pre-send Session length would complete on the PREVIOUS turn (the run 61 defect)', () => {
  // Documents the discarded boundary: this is the defect shape, NOT a producer
  // regression case — the lane can no longer derive its boundary this way
  // because the condition takes the durable prompt, not a Session length.
  const preSendLength = 4
  const legacyMatch = PREVIOUS_TURN_STILL_RUNNING
    .findIndex((event, position) => position >= preSendLength && event.type === 'turn/end')
  assert.equal(PREVIOUS_TURN_STILL_RUNNING[legacyMatch].data.turn, 1)
})

// The measured run-61 shape: turn 3's end at 68, the MAC09-08 prompt at 72, and
// no turn/end after it — the lane must keep waiting instead of completing on 68.
const RUN_61_SHAPE = [
  ...Array.from({ length: 68 }, () => ({ type: 'step/start', data: {} })),
  { type: 'turn/end', data: { turn: 3 } },                                   // 68
  { type: 'turn/start', data: { turn: 4 } },                                 // 69
  { type: 'agent/inbox/spliced', data: {} },                                 // 70
  { type: 'step/start', data: { turn: 4 } },                                 // 71
  { type: 'user/message', data: {} },                                        // 72 <- the prompt
  { type: 'tool/call', data: { turn: 4 } },                                  // 73
  { type: 'tool/ptc-dispatch-start', data: { name: 'cua', arguments: { method: 'getApp' } } }, // 74
  { type: 'tool/ptc-dispatch-start', data: { name: 'cua', arguments: { method: 'typeText' } } }, // 75
]

test('the measured run-61 prefix stays pending, and completes only when turn 4 ends', () => {
  // The argument is the prompt EVIDENCE the producers return (an index), not the
  // raw user/message event: the anchor is derived from that index.
  const prompt = { index: 72 }
  assert.equal(nextTurnEnd(RUN_61_SHAPE, prompt), undefined,
    'the prefix must stay pending: turn 3 already ended and turn 4 has no end yet')
  const closed = [...RUN_61_SHAPE, { type: 'turn/end', data: { turn: 4 } }]
  const matched = nextTurnEnd(closed, prompt)
  assert.equal(matched.events[matched.index].data.turn, 4,
    'the await must close on the turn that carries this prompt')
})
