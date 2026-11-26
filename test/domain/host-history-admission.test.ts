/**
 * The pure Host-admission fold for the private accepted-input history search.
 *
 * These cases pin the identity semantics the Host index depends on: one
 * occurrence per first `message.id`, queue edit/remove/steer never rewrite it,
 * fork-inherited prefix events never count, `working-directory/change` folds
 * per event (an unusable value is the explicit unknown `null`), `source.kind`
 * alone admits a user-sourced message (request correlation is ignored), and a
 * malformed required payload of an explicit user message fails the source read.
 *
 * @module @xmoon76/dsh-pi-tui/host-history-admission.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyHostAdmission,
  HostAdmissionFold,
  type HostAdmissionEventLike,
} from '../../src/domain/history/host-admission.ts'

interface TestMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: string; readonly text?: string }[] | unknown
  readonly source: { readonly kind: string; readonly rpcId?: string }
}

function message(id: string, text: string, source: { kind: string; rpcId?: string } = { kind: 'user', rpcId: `rpc-${id}` }): TestMessage {
  return { id, role: 'user', content: [{ type: 'text', text }], source }
}

function inbox(seq: number, time: number, inserted: readonly TestMessage[], extra: Record<string, unknown> = {}): HostAdmissionEventLike {
  return { type: 'agent/inbox/spliced', seq, time, data: { target: 'next-turn', start: 0, inserted, ...extra } }
}

function userMessageEvent(seq: number, time: number, value: unknown): HostAdmissionEventLike {
  return { type: 'user/message', seq, time, data: value }
}

function cwdChange(seq: number, time: number, cwd: unknown): HostAdmissionEventLike {
  return { type: 'working-directory/change', seq, time, data: { cwd } }
}

const OPTIONS = { sessionId: 'session-a', initialCwd: '/repo/a', inheritedEventCount: 0 }

test('an inbox insertion plus its later user/message is ONE accepted occurrence', () => {
  const accepted = message('msg-1', 'hello host')
  const snapshot = classifyHostAdmission(OPTIONS, [
    inbox(0, 1000, [accepted]),
    userMessageEvent(1, 1005, accepted),
  ])
  assert.equal(snapshot.occurrences.length, 1)
  assert.deepEqual(snapshot.occurrences[0], {
    sessionId: 'session-a',
    messageId: 'msg-1',
    firstEventSeq: 0,
    content: 'hello host',
    acceptedAt: 1000,
    cwd: '/repo/a',
    hasNonText: false,
  })
  assert.equal(snapshot.editedOccurrences, 0)
})

test('identical text with different message ids stays two occurrences', () => {
  const snapshot = classifyHostAdmission(OPTIONS, [
    inbox(0, 1000, [message('msg-1', 'same text')]),
    inbox(2, 1002, [message('msg-2', 'same text')]),
  ])
  assert.deepEqual(snapshot.occurrences.map(item => item.messageId).sort(), ['msg-1', 'msg-2'])
  assert.deepEqual(snapshot.occurrences.map(item => item.content), ['same text', 'same text'])
})

test('a queue edit with the same id keeps the first text and only counts one edit', () => {
  const snapshot = classifyHostAdmission(OPTIONS, [
    inbox(0, 1000, [message('msg-1', 'first version')]),
    inbox(2, 1002, [message('msg-1', 'edited version')]),
  ])
  assert.equal(snapshot.occurrences.length, 1)
  assert.equal(snapshot.occurrences[0]?.content, 'first version')
  assert.equal(snapshot.occurrences[0]?.firstEventSeq, 0)
  assert.equal(snapshot.editedOccurrences, 1)
})

test('queue remove and a later steer/consume never delete the accepted fact', () => {
  const accepted = message('msg-1', 'queued then removed')
  const snapshot = classifyHostAdmission(OPTIONS, [
    inbox(0, 1000, [accepted]),
    inbox(1, 1001, [], { start: 0, removedCount: 1 }),
    userMessageEvent(2, 1002, accepted),
    inbox(3, 1003, [message('msg-1', 'reinserted with a different body')]),
  ])
  assert.equal(snapshot.occurrences.length, 1)
  assert.equal(snapshot.occurrences[0]?.content, 'queued then removed')
  assert.equal(snapshot.editedOccurrences, 1)
})

test('fork-inherited prefix events fold cwd but never become child occurrences', () => {
  const inherited = message('parent-msg', 'parent prompt')
  const child = message('child-msg', 'child prompt')
  const snapshot = classifyHostAdmission({ ...OPTIONS, inheritedEventCount: 3 }, [
    userMessageEvent(0, 900, inherited),
    inbox(1, 901, [message('parent-msg-2', 'another parent prompt')]),
    cwdChange(2, 902, '/repo/parent'),
    inbox(3, 1000, [child]),
  ])
  assert.deepEqual(snapshot.occurrences.map(item => item.messageId), ['child-msg'])
  assert.equal(snapshot.occurrences[0]?.cwd, '/repo/parent')
})

test('working-directory/change fixes each prompt at its event-time cwd', () => {
  const snapshot = classifyHostAdmission(OPTIONS, [
    inbox(0, 1000, [message('msg-h1', 'in h1')]),
    cwdChange(1, 1001, '/repo/h2'),
    inbox(2, 1002, [message('msg-h2', 'in h2')]),
  ])
  assert.equal(snapshot.occurrences.find(item => item.messageId === 'msg-h1')?.cwd, '/repo/a')
  assert.equal(snapshot.occurrences.find(item => item.messageId === 'msg-h2')?.cwd, '/repo/h2')
  assert.equal(snapshot.occurrences.find(item => item.messageId === 'msg-h1')?.firstEventSeq, 0)
  assert.equal(snapshot.occurrences.find(item => item.messageId === 'msg-h2')?.firstEventSeq, 2)
})

test('a non-user producer notice is not a user prompt, even when it carries rpcId', () => {
  const snapshot = classifyHostAdmission(OPTIONS, [
    userMessageEvent(0, 1000, message('notice-1', 'working-directory notice', { kind: 'working-directory', rpcId: 'rpc-notice-1' })),
    inbox(1, 1001, [message('notice-2', 'another notice', { kind: 'plan-mode', rpcId: 'rpc-notice-2' })]),
    inbox(2, 1002, [message('msg-1', 'real prompt')]),
  ])
  assert.deepEqual(snapshot.occurrences.map(item => item.messageId), ['msg-1'])
})

test('a user-sourced message without rpcId is ONE accepted occurrence across inbox and user/message', () => {
  const uncorrelated = message('uncorrelated-1', 'no correlation', { kind: 'user' })
  const correlated = message('correlated-1', 'correlated prompt', { kind: 'user', rpcId: 'rpc-correlated-1' })
  const snapshot = classifyHostAdmission(OPTIONS, [
    inbox(0, 1000, [uncorrelated, correlated]),
    userMessageEvent(1, 1005, uncorrelated),
  ])
  assert.deepEqual(snapshot.occurrences.map(item => item.messageId).sort(), ['correlated-1', 'uncorrelated-1'])
  const occurrence = snapshot.occurrences.find(item => item.messageId === 'uncorrelated-1')
  assert.equal(occurrence?.content, 'no correlation')
  assert.equal(occurrence?.firstEventSeq, 0)
  assert.equal(occurrence?.acceptedAt, 1000)
  assert.equal(occurrence?.cwd, '/repo/a')
  assert.equal(snapshot.occurrences.find(item => item.messageId === 'correlated-1')?.firstEventSeq, 0)
})

test('an unusable working-directory/change makes that interval explicitly unknown', () => {
  const snapshot = classifyHostAdmission(OPTIONS, [
    inbox(0, 1000, [message('msg-a', 'in a')]),
    cwdChange(1, 1001, ''),
    inbox(2, 1002, [message('msg-unknown-1', 'after an empty change')]),
    cwdChange(3, 1003, 42),
    inbox(4, 1004, [message('msg-unknown-2', 'after a non-string change')]),
    cwdChange(5, 1005, 'relative/path'),
    inbox(6, 1006, [message('msg-unknown-3', 'after a non-absolute change')]),
    cwdChange(7, 1007, '/repo/b'),
    inbox(8, 1008, [message('msg-b', 'in b')]),
  ])
  const byId = (messageId: string) => snapshot.occurrences.find(item => item.messageId === messageId)
  assert.equal(byId('msg-a')?.cwd, '/repo/a')
  assert.equal(byId('msg-unknown-1')?.cwd, null)
  assert.equal(byId('msg-unknown-2')?.cwd, null)
  assert.equal(byId('msg-unknown-3')?.cwd, null)
  assert.equal(byId('msg-b')?.cwd, '/repo/b')
})

test('a non-text block is preserved as hasNonText while text stays searchable', () => {
  const withImage: TestMessage = {
    id: 'msg-image',
    role: 'user',
    content: [{ type: 'text', text: 'look at this' }, { type: 'image' }],
    source: { kind: 'user' },
  }
  const snapshot = classifyHostAdmission(OPTIONS, [inbox(0, 1000, [withImage])])
  assert.equal(snapshot.occurrences[0]?.content, 'look at this')
  assert.equal(snapshot.occurrences[0]?.hasNonText, true)
})

test('an empty text block list still produces a browsable occurrence', () => {
  const empty: TestMessage = {
    id: 'msg-empty',
    role: 'user',
    content: [],
    source: { kind: 'user' },
  }
  const snapshot = classifyHostAdmission(OPTIONS, [inbox(0, 1000, [empty])])
  assert.equal(snapshot.occurrences.length, 1)
  assert.equal(snapshot.occurrences[0]?.content, '')
})

test('an explicit user message with a malformed required payload fails the source read', () => {
  // The existing parser rejects these shapes; the fold must not then report a
  // complete source that silently omitted them.
  assert.throws(
    () => classifyHostAdmission(OPTIONS, [
      inbox(0, 1000, [{ id: 'bad-text', role: 'user', content: [{ type: 'text' }], source: { kind: 'user' } }]),
    ]),
    /text block without text/u,
  )
  assert.throws(
    () => classifyHostAdmission(OPTIONS, [
      userMessageEvent(0, 1000, { id: 'bad-content', role: 'user', content: 'not-an-array', source: { kind: 'user' } }),
    ]),
    /no content array/u,
  )
  assert.throws(
    () => classifyHostAdmission(OPTIONS, [
      inbox(0, 1000, [{ id: '', role: 'user', content: [], source: { kind: 'user' } }]),
    ]),
    /no message id/u,
  )
  // A recognized inbox mutation without its required array is the same class.
  assert.throws(
    () => classifyHostAdmission(OPTIONS, [
      { type: 'agent/inbox/spliced', seq: 0, time: 1000, data: { target: 'next-turn', start: 0 } },
    ]),
    /no inserted array/u,
  )
})

test('an incremental fold continues after its committed seq and drains only new evidence', () => {
  const accepted = message('msg-1', 'first prompt')
  const first = new HostAdmissionFold(OPTIONS)
  first.apply([inbox(0, 1000, [accepted]), cwdChange(1, 1001, '/repo/b')])
  const firstDelta = first.drainEvidence()
  assert.equal(firstDelta.occurrences.length, 1)
  assert.equal(first.currentCwd, '/repo/b')

  const continuation = new HostAdmissionFold({
    ...OPTIONS,
    initialCwd: '/repo/b',
    startSeq: 1,
  })
  continuation.apply([
    inbox(0, 1000, [accepted]),
    cwdChange(1, 1001, '/repo/b'),
    inbox(2, 1002, [message('msg-2', 'second prompt')]),
  ])
  const delta = continuation.drainEvidence()
  assert.deepEqual(delta.occurrences.map(item => item.messageId), ['msg-2'])
  assert.equal(delta.occurrences[0]?.cwd, '/repo/b')
  assert.equal(continuation.lastSeq, 2)
  // The drained delta is cleared: one occurrence cannot be committed twice by
  // the same fold instance.
  assert.deepEqual(continuation.drainEvidence().occurrences, [])
})

test('re-applying an overlapping live/persisted window is idempotent', () => {
  const fold = new HostAdmissionFold(OPTIONS)
  const accepted = message('msg-1', 'once')
  fold.apply([inbox(0, 1000, [accepted])])
  fold.apply([inbox(0, 1000, [accepted]), userMessageEvent(1, 1001, accepted)])
  assert.equal(fold.snapshot().occurrences.length, 1)
  assert.equal(fold.lastSeq, 1)
})

test('an invalid start seq or inherited count fails fast at the fold boundary', () => {
  assert.throws(
    () => new HostAdmissionFold({ ...OPTIONS, inheritedEventCount: -1 }),
    /inheritedEventCount must be a non-negative safe integer/u,
  )
  assert.throws(
    () => new HostAdmissionFold({ ...OPTIONS, startSeq: -2 }),
    /startSeq must be a safe integer >= -1/u,
  )
})