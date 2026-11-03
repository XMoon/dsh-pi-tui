/**
 * The real DSH `0.2.1-rc.5` JSONL durability settlement that the Direct
 * retirement ordering has to respect.
 *
 * DSH's `session/flush` listener runs `drainLive()` (which is deliberately NOT
 * gated by the handle's `closing` flag, because close itself drains) and THEN
 * `writer.flush()`. `flush()` re-checks `assertOpen` inside its chained turn,
 * so a flush that was issued while the handle was still open is REJECTED when
 * a concurrent `close()` sets `closing` first. This test pins that settlement
 * against the installed package, because it is the fact the pi-tui sequencing
 * is derived from — not a guess about DSH internals.
 *
 * The second half pins the consequence that decides the ORDER of the pi-tui
 * checkpoint: `close()` drains what was appended, but it does NOT materialize
 * an empty, never-appended session. "Close takes over durability" is therefore
 * false for a freshly committed empty `/new` session, which is exactly why the
 * checkpoint has to run before a shutdown can close the handle.
 * @module @xmoon76/dsh-pi-tui/test/runtime/direct/session-flush-close-race.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { disposeContext, event } from '../../support/runner-harness.ts'
import { testLifecycle } from '../../support/temp-lifecycle.ts'

interface JsonlHandle {
  flush(options?: { signal?: AbortSignal }): Promise<void>
  append(events: readonly unknown[]): Promise<void>
  close(): Promise<void>
}

interface JsonlPersistence {
  create(header: unknown, options?: unknown): Promise<JsonlHandle>
  list(): Promise<ReadonlyArray<{ header: { id: string } }>>
}

async function mountPersistence(root: string): Promise<{ ctx: Context; persistence: JsonlPersistence }> {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'persistence') })
  const persistence = ctx.get('sessionPersistence') as JsonlPersistence
  return { ctx, persistence }
}

const header = (root: string, id: string): unknown => ({
  id: SessionId(id),
  cwd: root,
  createdAt: Date.UTC(2026, 10, 3),
  version: SESSION_FORMAT_VERSION,
  isSeeded: false,
})

test('a flush issued while the handle is open is REJECTED by a concurrent close (real DSH settlement)', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-flush-close-race-')
  const { ctx, persistence } = await mountPersistence(root)
  life.defer(() => disposeContext(ctx))
  const id = 'session-flush-close-race'
  const handle = await persistence.create(header(root, id))

  // The exact interleaving: the flush is ISSUED while the handle is open (its
  // call-time assertOpen passes), and close() starts before the flush's chained
  // turn runs. The chained turn re-checks assertOpen and refuses.
  const flush = handle.flush()
  const close = handle.close()
  await assert.rejects(flush, (error: unknown) => {
    const name = (error as { constructor?: { name?: string } } | null)?.constructor?.name
    assert.equal(name, 'SessionHandleClosedError',
      `the real DSH flush must refuse on a closing handle, got ${name}: ${String(error)}`)
    return true
  }, 'the in-flight flush must be the one that loses the race')
  // The close itself still settles: it is the shutdown's own durable drain.
  await close
})

test('close() does NOT materialize a never-appended empty session (it only drains)', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-close-empty-')
  const { ctx, persistence } = await mountPersistence(root)
  life.defer(() => disposeContext(ctx))
  const id = 'session-close-empty'
  const handle = await persistence.create(header(root, id))

  // Close WITHOUT any prior flush: no event was ever appended, so there is
  // nothing for close to drain and it does not write the header-only artifact.
  await handle.close()
  const listed = await persistence.list()
  assert.equal(listed.some(snapshot => snapshot.header.id === id), false,
    'close() must not be treated as a durability owner for a fresh empty session')

  // A SECOND empty session proves the positive control on the same backend:
  // the explicit flush IS what materializes the artifact.
  const flushedId = 'session-flush-empty'
  const flushed = await persistence.create(header(root, flushedId))
  await flushed.flush()
  await flushed.close()
  const after = await persistence.list()
  assert.equal(after.some(snapshot => snapshot.header.id === flushedId), true,
    'an explicit flush materializes the empty session, which is the checkpoint contract')
})

test('a flush issued while the handle is open still SUCCEEDS when no close intervenes', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-flush-open-')
  const { ctx, persistence } = await mountPersistence(root)
  life.defer(() => disposeContext(ctx))
  const id = 'session-flush-open'
  const handle = await persistence.create(header(root, id))
  await handle.flush()
  await handle.close()
  const listed = await persistence.list()
  assert.equal(listed.some(snapshot => snapshot.header.id === id), true,
    'the ordering claim must not degrade the ordinary live case')
})

test('appended events survive close() even when an in-flight flush is rejected', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-close-drains-')
  const { ctx, persistence } = await mountPersistence(root)
  life.defer(() => disposeContext(ctx))
  const id = 'session-close-drains'
  const handle = await persistence.create(header(root, id))
  // A real append first materializes the artifact, so close now has something
  // to drain. This is DSH's own `flushAll` rationale ("close drained durably"),
  // and the reason a shutdown-overtaken flush of a MATERIALIZED session is not
  // a durability failure.
  await handle.append([event('session/end-seed', {}, 0)])
  const flush = handle.flush()
  const close = handle.close()
  await assert.rejects(flush, () => true, 'the flush still loses the race')
  await close
  const listed = await persistence.list()
  assert.equal(listed.some(snapshot => snapshot.header.id === id), true,
    'a materialized session stays durable through close')
})
