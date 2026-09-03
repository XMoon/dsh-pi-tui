/**
 * Headless tests for the Ctrl+R session-scope persist gate
 * (history-persist.ts): the deferred-start ordering contract — an
 * agent-facing submission's history row is written AFTER the session
 * exists, with the FINAL session id (the first prompt of a fresh session
 * must carry the session it creates) — plus the persist decision (dedupe,
 * image guard, sessionless rows).
 *
 * The runner's submit path uses exactly these two functions
 * (`persistAfterSession` around `ensureSession()` + the detached
 * `persistHistoryRecord` write), so the merge-gate test below pins the
 * end-to-end property: session resolution → persisted row.
 * @module @xmoon76/dsh-pi-tui/history-persist.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { join } from 'node:path'
import { historySessionIdFor, persistAfterSession, persistHistoryRecord } from '../src/history-persist.ts'
import { historyFilePath, loadHistoryRecords } from '../src/history.ts'

function tempHome(life: TestLifecycle): string {
  return life.tempDir('pi-tui-history-persist-')
}

test('merge gate: a fresh session\'s FIRST prompt persists with the FINAL session id', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const cwd = '/work/a'
  const file = historyFilePath(home, cwd)
  const order: string[] = []
  // The runner's submit path: resolveSession = ensureSession() + the
  // live agent's id; persist = the detached history write.
  await persistAfterSession(
    async () => {
      order.push('resolve')
      return 'ses_new' // the session the first prompt just created
    },
    (sessionId) => {
      order.push('persist')
      persistHistoryRecord({
        content: 'hello',
        cwd,
        sessionId,
        ts: 1,
        lastContent: undefined,
        hasImages: false,
        file,
      })
    },
  )
  assert.deepEqual(order, ['resolve', 'persist'],
    'the row must be persisted AFTER the session resolution, never before')
  const records = loadHistoryRecords(file)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.sessionId, 'ses_new',
    'the first prompt of a fresh session must carry the FINAL session id')
  assert.equal(records[0]?.content, 'hello')
})

test('a sessionless submission persists with NO sessionId field', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const cwd = '/work/a'
  const file = historyFilePath(home, cwd)
  const written = persistHistoryRecord({
    content: '/help',
    cwd,
    sessionId: undefined,
    ts: 1,
    lastContent: undefined,
    hasImages: false,
    file,
  })
  assert.equal(written, true)
  const records = loadHistoryRecords(file)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.sessionId, undefined, 'a sessionless row must not carry a sessionId')
  assert.equal(records[0]?.content, '/help')
})

test('a sessionless `!!`/bare-`!` shell row persists with NO sessionId even while a session is live', async (t) => {
  const life = testLifecycle(t)
  // Review finding: `!!` runs purely locally (no session write) and a
  // bare `!` is a no-op — their rows must never be attributed to the live
  // session (they would otherwise leak into the Current session scope).
  const home = tempHome(life)
  const cwd = '/work/a'
  const file = historyFilePath(home, cwd)
  // The runner passes `undefined` for these branches even though a live
  // session exists (the row must stay out of Current session).
  for (const content of ['!!ls', '!']) {
    persistHistoryRecord({
      content,
      cwd,
      sessionId: undefined,
      ts: 1,
      lastContent: undefined,
      hasImages: false,
      file,
    })
  }
  const records = loadHistoryRecords(file)
  assert.equal(records.length, 2)
  assert.ok(records.every(record => record.sessionId === undefined),
    'sessionless shell rows must not carry a sessionId')
})

test('a steered draft persists with the LIVE session id (Ctrl+S / steer-draft)', async (t) => {
  const life = testLifecycle(t)
  // Review finding: direct steer paths (Ctrl+S, the steer-draft extension
  // action) send the draft into the RUNNING session — the row must carry
  // the live session id, exactly like a normal submission.
  const home = tempHome(life)
  const cwd = '/work/a'
  const file = historyFilePath(home, cwd)
  const written = persistHistoryRecord({
    content: 'steer me',
    cwd,
    sessionId: 'ses_live',
    ts: 1,
    lastContent: undefined,
    hasImages: false,
    file,
  })
  assert.equal(written, true)
  const records = loadHistoryRecords(file)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.sessionId, 'ses_live', 'a steered draft carries the live session id')
  // An EMPTY draft (Ctrl+S with only a queue) persists nothing — the
  // queued messages were already persisted when originally submitted.
  assert.equal(persistHistoryRecord({
    content: '',
    cwd,
    sessionId: 'ses_live',
    ts: 1,
    lastContent: undefined,
    hasImages: false,
    file,
  }), false, 'an empty steered draft is skipped')
  assert.equal(loadHistoryRecords(file).length, 1)
})

test('a sessionless command with a LIVE session still persists sessionless (/help while a session exists)', async (t) => {
  const life = testLifecycle(t)
  // Review finding: recognized sessionless commands must never appear in
  // Current session — even when a live session exists (they dispatch
  // through the session's command service, but their rows stay
  // sessionless).
  const home = tempHome(life)
  const cwd = '/work/a'
  const file = historyFilePath(home, cwd)
  // The runner's sessionless branch with a live agent: the persist
  // closure always supplies undefined via the decision table, even
  // though the dispatch gate resolves the live session id.
  const persist = (sessionId: string | undefined): void => {
    persistHistoryRecord({
      content: '/help',
      cwd,
      sessionId: historySessionIdFor('sessionless', sessionId),
      ts: 1,
      lastContent: undefined,
      hasImages: false,
      file,
    })
  }
  await persistAfterSession(async () => 'ses_live', persist)
  const records = loadHistoryRecords(file)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.sessionId, undefined,
    'a sessionless command must not appear in Current session even with a live session')
  assert.equal(records[0]?.content, '/help')
})

test('the call-site decision table: agent-facing rows carry the session id, sessionless rows never do', () => {
  // The runner routes EVERY persist call through historySessionIdFor —
  // this table is the single source of truth for which submission kind
  // earns which session identity (a future change must update it here,
  // not silently at a call site).
  assert.equal(historySessionIdFor('agent-facing', 'ses_1'), 'ses_1')
  assert.equal(historySessionIdFor('agent-facing', undefined), undefined)
  assert.equal(historySessionIdFor('sessionless', 'ses_1'), undefined,
    'a sessionless submission must never be attributed to a session')
  assert.equal(historySessionIdFor('sessionless', undefined), undefined)
})

test('the runner\'s `!` block end to end: `!!`/bare `!` rows are sessionless, a contextual `!` row carries the FINAL session id', async (t) => {
  const life = testLifecycle(t)
  // Simulates dispatchUserInput's `!` block with the ACTUAL functions the
  // runner uses (historySessionIdFor + persistHistoryRecord + the
  // ensureSession ordering via persistAfterSession), asserting the rows
  // that land in the file.
  const home = tempHome(life)
  const cwd = '/work/a'
  const file = historyFilePath(home, cwd)
  const write = (content: string, sessionId: string | undefined): void => {
    persistHistoryRecord({ content, cwd, sessionId, ts: 1, lastContent: undefined, hasImages: false, file })
  }
  // `!!` branch: sessionless even while a session is live.
  write('!!ls', historySessionIdFor('sessionless', 'ses_live'))
  // bare `!` branch: sessionless.
  write('!', historySessionIdFor('sessionless', 'ses_live'))
  // contextual `!` branch: the FINAL id, resolved AFTER the session
  // exists (the deferred-start gate).
  await persistAfterSession(
    async () => 'ses_new',
    (sessionId) => write('!ls', historySessionIdFor('agent-facing', sessionId)),
  )
  const records = loadHistoryRecords(file)
  assert.deepEqual(records.map(record => record.sessionId), [undefined, undefined, 'ses_new'],
    'the `!` block rows carry exactly the session identities the decision table earns')
  assert.deepEqual(records.map(record => record.content), ['!!ls', '!', '!ls'])
})

test('the runner\'s steer path end to end: the draft persists with the LIVE session id after the session exists', async (t) => {
  const life = testLifecycle(t)
  // Simulates onSteer / steer-draft with the ACTUAL functions the runner
  // uses: the snapshot happens at call time (before the steer consumes
  // the staged images) and the row is written AFTER the session exists,
  // with the session id the gate resolved.
  const home = tempHome(life)
  const cwd = '/work/a'
  const file = historyFilePath(home, cwd)
  const order: string[] = []
  // The runner's makeSteerPersist: snapshot ts + image check at call
  // time, then write under the resolved session id.
  const persist = (sessionId: string | undefined): void => {
    order.push('persist')
    persistHistoryRecord({
      content: 'steer this draft',
      cwd,
      sessionId: historySessionIdFor('agent-facing', sessionId),
      ts: 1,
      lastContent: undefined,
      hasImages: false,
      file,
    })
  }
  // The runner's steerNow gate: resolve the session FIRST, then persist.
  await persistAfterSession(
    async () => {
      order.push('resolve')
      return 'ses_live'
    },
    persist,
  )
  assert.deepEqual(order, ['resolve', 'persist'], 'the row is written AFTER the session exists')
  const records = loadHistoryRecords(file)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.content, 'steer this draft')
  assert.equal(records[0]?.sessionId, 'ses_live', 'the steered draft carries the live session id')
})

test('a deferred-start steer persists with the FINAL session id (Ctrl+S / steer-draft with no live session)', async (t) => {
  const life = testLifecycle(t)
  // Review repro: steerNow creates the session on a deferred start — a
  // row written BEFORE the creation would carry no sessionId and vanish
  // from Current session. The row must be written AFTER the session
  // exists, with the FINAL id; a rejected creation writes nothing.
  const home = tempHome(life)
  const cwd = '/work/a'
  const file = historyFilePath(home, cwd)
  const order: string[] = []
  const persist = (sessionId: string | undefined): void => {
    order.push('persist')
    persistHistoryRecord({
      content: 'steer me',
      cwd,
      sessionId: historySessionIdFor('agent-facing', sessionId),
      ts: 1,
      lastContent: undefined,
      hasImages: false,
      file,
    })
  }
  await persistAfterSession(
    async () => {
      order.push('resolve')
      return 'ses_new' // the session Ctrl+S just created
    },
    persist,
  )
  assert.deepEqual(order, ['resolve', 'persist'], 'the row is written AFTER the session creation')
  const records = loadHistoryRecords(file)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.sessionId, 'ses_new',
    'a deferred-start steer carries the FINAL session id, never undefined')
  // A REJECTED creation persists nothing (the steer never reached a
  // session).
  await assert.rejects(
    persistAfterSession(
      async () => {
        throw new Error('creation failed')
      },
      persist,
    ),
    /creation failed/,
  )
  assert.equal(loadHistoryRecords(file).length, 1, 'a rejected creation must not write a row')
})

test('persistHistoryRecord skips empty, consecutive repeats and image-bearing submissions', async (t) => {
  const life = testLifecycle(t)
  const home = tempHome(life)
  const cwd = '/work/a'
  const file = historyFilePath(home, cwd)
  const base = {
    cwd,
    sessionId: 'ses_1' as string | undefined,
    ts: 1,
    lastContent: undefined,
    hasImages: false,
    file,
  }
  assert.equal(persistHistoryRecord({ ...base, content: '   ' }), false, 'empty content is skipped')
  assert.equal(persistHistoryRecord({ ...base, content: 'hello' }), true)
  assert.equal(persistHistoryRecord({ ...base, content: 'hello', lastContent: 'hello' }), false,
    'a consecutive repeat is skipped')
  assert.equal(persistHistoryRecord({ ...base, content: 'with image', hasImages: true }), false,
    'an image-bearing submission is never persisted')
  const records = loadHistoryRecords(file)
  assert.equal(records.length, 1)
  assert.equal(records[0]?.content, 'hello')
})
