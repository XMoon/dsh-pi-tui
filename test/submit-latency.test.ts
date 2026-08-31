/**
 * Headless tests for the submit latency tracker (plan E): the T0-T5
 * phase timeline written ONLY to the diag channel at debug level — one
 * baseline per submission, one line per phase, no proportional work, and
 * a failing sink that can never take the session down.
 * @module @xmoon76/dsh-pi-tui/submit-latency.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { SubmitLatencyTracker, type SubmitLatencySink } from '../src/submit-latency.ts'

interface RecordingSink extends SubmitLatencySink {
  lines: { message: string; fields: Record<string, unknown> | undefined }[]
}

function recordingSink(): RecordingSink {
  const lines: { message: string; fields: Record<string, unknown> | undefined }[] = []
  return {
    lines,
    debug(message, fields) { lines.push({ message, fields }) },
  }
}

function clock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000
  return { now: () => current, advance: (ms) => { current += ms } }
}

test('the tracker logs accept, each phase once, with monotonic offsets', () => {
  const sink = recordingSink()
  const time = clock()
  const tracker = new SubmitLatencyTracker({ sink, now: time.now })
  tracker.accept('session-a')
  time.advance(3)
  tracker.mark('session-a', 'dispatch')
  time.advance(60)
  tracker.mark('session-a', 'inbox.inserted')
  time.advance(20)
  tracker.mark('session-a', 'turn.start')
  time.advance(1_300)
  tracker.mark('session-a', 'user.message')
  time.advance(4_000)
  tracker.mark('session-a', 'assistant.first')
  const names = sink.lines.map(line => line.message)
  assert.deepEqual(names, [
    'submit.accept', 'submit.dispatch', 'submit.inbox.inserted',
    'submit.turn.start', 'submit.user.message', 'submit.assistant.first',
  ])
  const offsets = sink.lines.map(line => line.fields?.offset)
  assert.deepEqual(offsets, ['0ms', '3ms', '63ms', '83ms', '1383ms', '5383ms'])
  // Session + phase ride the fields (diagnostics, transcript untouched).
  assert.equal(sink.lines[1]!.fields?.session, 'session-a')
})

test('a repeated phase mark does not log twice', () => {
  const sink = recordingSink()
  const time = clock()
  const tracker = new SubmitLatencyTracker({ sink, now: time.now })
  tracker.accept('s')
  tracker.mark('s', 'turn.start')
  tracker.mark('s', 'turn.start')
  tracker.mark('s', 'turn.start')
  assert.equal(sink.lines.filter(line => line.message === 'submit.turn.start').length, 1)
})

test('marks for a DIFFERENT session are ignored', () => {
  const sink = recordingSink()
  const tracker = new SubmitLatencyTracker({ sink, now: () => 1_000 })
  tracker.accept('s1')
  tracker.mark('s2', 'turn.start')
  assert.equal(sink.lines.length, 1, 'only the accept line for s1')
})

test('marks without a baseline are ignored (turn started without a submission)', () => {
  const sink = recordingSink()
  const tracker = new SubmitLatencyTracker({ sink, now: () => 1_000 })
  tracker.mark('s', 'turn.start')
  tracker.mark(undefined, 'turn.start')
  assert.equal(sink.lines.length, 0)
})

test('reset drops the baseline: later marks are no-ops until the next accept', () => {
  const sink = recordingSink()
  const time = clock()
  const tracker = new SubmitLatencyTracker({ sink, now: time.now })
  tracker.accept('s')
  tracker.mark('s', 'turn.start')
  tracker.reset()
  time.advance(100)
  tracker.mark('s', 'user.message')
  assert.equal(sink.lines.filter(line => line.message === 'submit.user.message').length, 0,
    'no marks after the reset')
  tracker.accept('s')
  tracker.mark('s', 'user.message')
  assert.equal(sink.lines.at(-1)?.message, 'submit.user.message')
  assert.equal(sink.lines.at(-1)?.fields?.offset, '0ms', 'the new baseline starts at accept')
})

test('re-accepting the same session rebases the timeline (cancel + resubmit)', () => {
  const sink = recordingSink()
  const time = clock()
  const tracker = new SubmitLatencyTracker({ sink, now: time.now })
  // Submission 1: accepted, dispatched, never started (cancelled).
  tracker.accept('s')
  tracker.mark('s', 'dispatch')
  // Submission 2 (the resubmit): a fresh baseline.
  time.advance(2_000)
  tracker.accept('s')
  time.advance(5)
  tracker.mark('s', 'dispatch')
  const dispatches = sink.lines.filter(line => line.message === 'submit.dispatch')
  assert.equal(dispatches.length, 2)
  assert.equal(dispatches[1]!.fields?.offset, '5ms', 'the offset measures the NEW timeline')
})

test('a DEFERRED first submission: accept(undefined) arms; the first mark adopts the session', () => {
  // The deferred first submit is accepted BEFORE its session exists —
  // T0 must still arm, and the first authoritative mark (which names the
  // newly created session) adopts the id, keeping the timeline measurable.
  const sink = recordingSink()
  const time = clock()
  const tracker = new SubmitLatencyTracker({ sink, now: time.now })
  tracker.accept(undefined)
  assert.equal(sink.lines.at(-1)?.message, 'submit.accept')
  assert.equal(sink.lines.at(-1)?.fields?.session, '(pending)')
  time.advance(40)
  tracker.mark('session-created', 'dispatch')
  assert.equal(sink.lines.at(-1)?.message, 'submit.dispatch')
  assert.equal(sink.lines.at(-1)?.fields?.session, 'session-created', 'the session is adopted on the first mark')
  assert.equal(sink.lines.at(-1)?.fields?.offset, '40ms', 'the offset measures from the ORIGINAL T0')
  time.advance(10)
  tracker.mark('session-created', 'inbox.inserted')
  assert.equal(sink.lines.at(-1)?.fields?.offset, '50ms')
})

test('after adoption, a DIFFERENT session is ignored (switched session marks never pollute)', () => {
  const sink = recordingSink()
  const tracker = new SubmitLatencyTracker({ sink, now: () => 1_000 })
  tracker.accept(undefined)
  tracker.mark('s-a', 'turn.start')
  tracker.mark('s-b', 'user.message') // a foreign session must not log
  assert.equal(sink.lines.filter(line => line.message === 'submit.user.message').length, 0)
})

test('T1 dispatch is stamped BEFORE the delivery: synchronously-emitted events log in order', () => {
  // The runner marks dispatch BEFORE calling the writer, so a Direct
  // in-process followup that emits inbox/turn/user events SYNCHRONOUSLY
  // still logs accept → dispatch → inbox → turn → user → assistant in
  // order, and turn/end can never reset the timeline before T1.
  const sink = recordingSink()
  const time = clock()
  const tracker = new SubmitLatencyTracker({ sink, now: time.now })
  tracker.accept('s')
  tracker.mark('s', 'dispatch') // runner: before writer.followup(...)
  // ...the delivery happens; Direct emits its events synchronously:
  tracker.mark('s', 'inbox.inserted')
  tracker.mark('s', 'turn.start')
  tracker.mark('s', 'user.message')
  tracker.mark('s', 'assistant.first')
  assert.deepEqual(sink.lines.map(line => line.message), [
    'submit.accept', 'submit.dispatch', 'submit.inbox.inserted',
    'submit.turn.start', 'submit.user.message', 'submit.assistant.first',
  ], 'T1 must never trail T2-T5')
})

test('COALESCING (documented): a late dispatch from an older in-flight submission coalesces into the newest baseline', () => {
  const sink = recordingSink()
  const time = clock()
  const tracker = new SubmitLatencyTracker({ sink, now: time.now })
  tracker.accept('s') // submission 1
  time.advance(500)
  tracker.accept('s') // submission 2 (newest gesture owns the timeline)
  time.advance(2)
  tracker.mark('s', 'dispatch') // submission 1's delivery lands (same session id)
  assert.equal(sink.lines.filter(line => line.message === 'submit.dispatch').length, 1)
  assert.equal(sink.lines.at(-1)?.fields?.offset, '2ms',
    'the mark rides the CURRENT baseline (documented coalescing for burst submits)')
})

test('the default clock is monotonic (performance.now, never Date.now)', () => {
  const sink = recordingSink()
  const tracker = new SubmitLatencyTracker({ sink }) // NO injected clock
  tracker.accept('s')
  // Busy-wait ~10ms of REAL time, then mark: a Date.now default can read
  // the same millisecond (offset 0 even after 10ms of work); the monotonic
  // default must reflect the elapsed wall duration. The Date.now loop may
  // exit up to a tick late/early, so assert a comfortable 5ms floor.
  const stop = Date.now() + 10
  while (Date.now() < stop) { /* spin */ }
  tracker.mark('s', 'dispatch')
  const offset = Number(String(sink.lines.at(-1)?.fields?.offset).replace('ms', ''))
  assert.ok(offset >= 5,
    `the default clock must measure the elapsed real time (got ${offset}ms)`)
  assert.ok(tracker !== undefined)
})

test('the timeline SURVIVES a previous turn ending (queued submissions keep T1-T5)', () => {
  // The review's queued scenario: B is accepted while turn 12 is still
  // running, B waits in the inbox, turn 12 ENDS, and turn 13 processes B.
  // No turn/end reset exists anymore, so B's full journey is measurable
  // (this is exactly the queued → next-turn diagnostics Phase E exists
  // for). Simulated at tracker level: accept mid-turn, then the next
  // turn's events WITHOUT any reset call.
  const sink = recordingSink()
  const time = clock()
  const tracker = new SubmitLatencyTracker({ sink, now: time.now })
  tracker.accept('s') // B accepted while the previous turn runs
  tracker.mark('s', 'dispatch')
  tracker.mark('s', 'inbox.inserted')
  time.advance(2_000) // ...the previous turn ends here (no tracker call)
  tracker.mark('s', 'turn.start')
  tracker.mark('s', 'user.message')
  time.advance(3_000)
  tracker.mark('s', 'assistant.first')
  const offsets = sink.lines.filter(line => line.message !== 'submit.accept').map(line => line.fields?.offset)
  assert.deepEqual(offsets, ['0ms', '0ms', '2000ms', '2000ms', '5000ms'],
    'T1-T5 must survive the previous turn ending (2000ms = the previous turn\'s tail)')
})

test('assistant.first AUTO-COMPLETES the timeline (a new accept starts the next)', () => {
  const sink = recordingSink()
  const time = clock()
  const tracker = new SubmitLatencyTracker({ sink, now: time.now })
  tracker.accept('s')
  tracker.mark('s', 'dispatch')
  tracker.mark('s', 'inbox.inserted')
  tracker.mark('s', 'turn.start')
  tracker.mark('s', 'user.message')
  tracker.mark('s', 'assistant.first')
  time.advance(1_000)
  // Stray late marks (a second chunk, another user/message) are no-ops.
  tracker.mark('s', 'assistant.first')
  tracker.mark('s', 'user.message')
  const names = sink.lines.map(line => line.message)
  assert.equal(names.filter(name => name === 'submit.assistant.first').length, 1)
  assert.equal(names.filter(name => name === 'submit.user.message').length, 1)
  // mark() reports whether THIS call logged the phase.
  tracker.accept('s2')
  assert.equal(tracker.mark('s2', 'turn.start'), true, 'first mark logs')
  assert.equal(tracker.mark('s2', 'turn.start'), false, 'duplicate mark does not log')
  assert.equal(tracker.mark('s3', 'turn.start'), false, 'foreign session does not log')
})

test('T5 PREREQUISITE: a chunk from a STILL-STREAMING previous turn cannot steal assistant.first', () => {
  // The review's queued scenario, completed: B is accepted and dispatched
  // while turn 12 is still streaming its answer. A chunk arriving THEN is
  // turn 12\'s, not B\'s first token — it must NOT log T5 (which would
  // also auto-complete B\'s timeline before B was even processed).
  const sink = recordingSink()
  const time = clock()
  const tracker = new SubmitLatencyTracker({ sink, now: time.now })
  tracker.accept('s')
  tracker.mark('s', 'dispatch')
  tracker.mark('s', 'inbox.inserted')
  time.advance(100)
  // Turn 12 is still streaming: a chunk lands with no user.message yet.
  assert.equal(tracker.mark('s', 'assistant.first'), false,
    'T5 before T4 must be refused (the chunk belongs to the previous turn)')
  assert.equal(sink.lines.filter(line => line.message === 'submit.assistant.first').length, 0,
    'no T5 line, and the timeline is NOT auto-completed by a foreign chunk')
  // Turn 12 ends; turn 13 processes B: the real journey completes.
  time.advance(50)
  tracker.mark('s', 'turn.start')
  tracker.mark('s', 'user.message')
  time.advance(2_500)
  assert.equal(tracker.mark('s', 'assistant.first'), true,
    'the REAL first chunk (after user.message) logs T5')
  const t5 = sink.lines.filter(line => line.message === 'submit.assistant.first')
  assert.equal(t5.length, 1)
  assert.equal(t5[0]!.fields?.offset, '2650ms', 'T5 measures the true first-token latency')
  // The timeline auto-completed after the real T5.
  assert.equal(tracker.mark('s', 'user.message'), false, 'post-completion marks are no-ops')
})

test('a throwing sink never propagates (timing must not affect the session)', () => {
  const tracker = new SubmitLatencyTracker({ sink: { debug: () => { throw new Error('sink boom') } }, now: () => 1 })
  assert.doesNotThrow(() => tracker.accept('s'))
  assert.doesNotThrow(() => tracker.mark('s', 'turn.start'))
  assert.doesNotThrow(() => tracker.reset())
})