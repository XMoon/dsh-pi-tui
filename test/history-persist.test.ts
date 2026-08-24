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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistAfterSession, persistHistoryRecord } from '../src/history-persist.ts'
import { historyFilePath, loadHistoryRecords } from '../src/history.ts'

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'pi-tui-history-persist-'))
}

test('merge gate: a fresh session\'s FIRST prompt persists with the FINAL session id', async () => {
  const home = tempHome()
  try {
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
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a sessionless submission persists with NO sessionId field', async () => {
  const home = tempHome()
  try {
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
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('persistHistoryRecord skips empty, consecutive repeats and image-bearing submissions', async () => {
  const home = tempHome()
  try {
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
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
