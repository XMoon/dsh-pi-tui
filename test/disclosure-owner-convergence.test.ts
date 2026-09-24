/**
 * PR6/F6 pure tests for the neutral transcript container-owner vocabulary
 * (`transcript-disclosure.ts`) and the canonical Work membership index.
 * @module @xmoon76/dsh-pi-tui/disclosure-owner-convergence.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  deepestCommonTranscriptContainer,
  sameTranscriptContainerOwner,
  sameTranscriptContainerPath,
  type TranscriptContainerOwner,
} from '../src/transcript-disclosure.ts'
import { projectTranscriptStructure, workByMemberOf } from '../src/transcript-projection.ts'
import type { TranscriptMessage } from '../src/transcript.ts'

const thinking = (turn: number, text = 'reasoning'): TranscriptMessage => ({ kind: 'thinking', turn, text, running: true })
const tool = (turn: number, name = 'read'): TranscriptMessage => ({
  kind: 'tool', turn, name, args: '{}', result: 'ok', status: 'ok',
})
const assistant = (turn: number, text: string): TranscriptMessage => ({ kind: 'assistant', turn, text })

const work = (owner: TranscriptMessage): TranscriptContainerOwner => ({ kind: 'work', owner })
const cluster = (owner: TranscriptMessage): TranscriptContainerOwner => ({ kind: 'context-cluster', owner })
const root = (turn: number): TranscriptContainerOwner => ({ kind: 'focus-root', turn })

// --- owner equality --------------------------------------------------------

test('focus-root owners compare by turn number', () => {
  assert.equal(sameTranscriptContainerOwner(root(3), root(3)), true)
  assert.equal(sameTranscriptContainerOwner(root(3), root(4)), false)
  assert.equal(sameTranscriptContainerOwner(root(3), cluster(thinking(3))), false)
})

test('work and cluster owners compare by message object identity, never by shape', () => {
  const first = thinking(1)
  const sameShapeTwin = thinking(1)
  assert.equal(sameTranscriptContainerOwner(work(first), work(first)), true)
  assert.equal(sameTranscriptContainerOwner(work(first), work(sameShapeTwin)), false)
  assert.equal(sameTranscriptContainerOwner(work(first), cluster(first)), false)
  assert.equal(sameTranscriptContainerOwner(cluster(first), cluster(first)), true)
})

test('path equality is order-sensitive and prefix-strict', () => {
  const first = tool(1)
  const second = tool(1, 'write')
  assert.equal(sameTranscriptContainerPath([root(1), work(first)], [root(1), work(first)]), true)
  assert.equal(sameTranscriptContainerPath([root(1), work(first)], [work(first), root(1)]), false)
  assert.equal(sameTranscriptContainerPath([root(1), work(first)], [root(1)]), false)
  assert.equal(sameTranscriptContainerPath([root(1), work(first)], [root(1), work(second)]), false)
  assert.equal(sameTranscriptContainerPath([], []), true)
})

// --- deepest common container ---------------------------------------------

test('a spacer inside nested Work is owned by the Work, not the Thought', () => {
  const span = tool(1)
  const deepest = deepestCommonTranscriptContainer([root(1), work(span)], [root(1), work(span)])
  assert.deepEqual(deepest, { kind: 'work', owner: span })
})

test('a spacer between a Work member and the next non-Work process row is owned by the Thought', () => {
  const span = tool(1)
  const deepest = deepestCommonTranscriptContainer([root(1), work(span)], [root(1)])
  assert.deepEqual(deepest, { kind: 'focus-root', turn: 1 })
})

test('a spacer with no shared container is inert', () => {
  const span = tool(1)
  assert.equal(deepestCommonTranscriptContainer([work(span)], []), undefined)
  assert.equal(deepestCommonTranscriptContainer([root(1)], [root(2)]), undefined)
})

test('a spacer between two members of one cluster is owned by the cluster', () => {
  const owner = tool(1)
  assert.deepEqual(
    deepestCommonTranscriptContainer([cluster(owner)], [cluster(owner)]),
    { kind: 'context-cluster', owner },
  )
})

test('a spacer between two different Work spans in one Thought is owned by the Thought', () => {
  const first = tool(1)
  const second = tool(1, 'write')
  assert.deepEqual(
    deepestCommonTranscriptContainer([root(1), work(first)], [root(1), work(second)]),
    { kind: 'focus-root', turn: 1 },
  )
})

// --- canonical Work membership index --------------------------------------

test('workByMemberOf maps every member of every canonical span by identity', () => {
  const first = thinking(1)
  const inSpan = tool(1)
  const outside = assistant(1, 'intermediate')
  const second = tool(2)
  const structure = projectTranscriptStructure([first, inSpan, outside, second])
  const byMember = workByMemberOf(structure)
  assert.equal(byMember.get(first)?.owner, first)
  assert.equal(byMember.get(inSpan)?.owner, first)
  assert.equal(byMember.get(outside), undefined)
  assert.equal(byMember.get(second)?.owner, second)
  assert.equal(byMember.size, 3)
})

test('workByMemberOf never merges two same-turn spans across a boundary', () => {
  const first = tool(1)
  const boundary = assistant(1, 'narration')
  const second = thinking(1)
  const structure = projectTranscriptStructure([first, boundary, second])
  const byMember = workByMemberOf(structure)
  assert.equal(byMember.get(first)?.members.length, 1)
  assert.equal(byMember.get(second)?.members.length, 1)
  assert.notEqual(byMember.get(first)?.owner, byMember.get(second)?.owner)
})
