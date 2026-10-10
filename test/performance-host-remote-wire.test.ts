/**
 * PR-1 L5 evidence: the bundle's own Host projection is reachable through the
 * REAL Remote Host → official Client wire, not only through a unit test.
 *
 * ```text
 * real Host Session.append (committed durable events)
 *   -> pi-tui-performance-host unit (production fold)
 *   -> official session-projection registry / control-frame projection
 *   -> official Client ProjectionValueStore.faceOf('piTuiPerformance')
 *   -> baseline snapshot on retain + live frame on the next committed turn
 * ```
 *
 * FIXTURE MANIFEST
 * - REAL: `createRemoteApplicationHostFixture`'s rc.2 Host Context (persistence,
 *   storage, credentials, workspace, fs, sessions, jobs, the AgentLoop harness),
 *   `createRemoteHostRuntime(host.ctx)` (the production Remote Host composition,
 *   which mounts the production `pi-tui-performance-host` row),
 *   `createRemoteClientRuntime({ carrier })` (the official in-process Client /
 *   Gateway), the official `ProjectionValueStore` faces, and real
 *   `Session.append` commits that fire the real `session/event` drive.
 * - SYNTHETIC: nothing on this path. No model turn runs, so no LLM stand-in is
 *   involved: the seeded turns are REAL committed durable events (the same
 *   shape the AgentLoop commits), and only their wall time is test-local.
 * - NOT COVERED HERE: the TUI Client wiring that consumes the value
 *   (`SessionStatusProjection.performance` → `derivePerformance`, PR-2) and the
 *   Footer / `/status` formats (PR-3).
 * @module @xmoon76/dsh-pi-tui/performance-host-remote-wire.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { createRemoteClientRuntime, type RemoteClientRuntime } from '../src/app/remote/client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from '../src/app/remote/host-runtime.ts'
import {
  PI_TUI_PERFORMANCE_KEY,
  type PiTuiPerformanceProjection,
} from '../src/domain/status/performance-view.ts'
import { createRemoteApplicationHostFixture, waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

const SESSION_ID = 'perf-host-wire-session'

/** Append one REAL completed durable turn through the official Session API. */
async function appendRealTurn(session: Session, turn: number, outputTokens: number): Promise<void> {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 0 })
  // A real model request takes real wall time; wait so the paired wall time is
  // positive (a zero-duration step is legitimately not a TPS sample).
  await new Promise(resolve => setTimeout(resolve, 5))
  session.append('assistant/message', {
    turn,
    step: 0,
    message: {
      id: MessageId(`wire-${turn}`),
      role: 'assistant',
      content: [{ type: 'text', text: 'ok' }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
    stream: [{ type: 'chunk', time: Date.now() - 1, chunk: { type: 'text-delta', index: 0, text: 'x' } }],
    usage: { inputTokens: 3, outputTokens },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 0 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

test('L5: real Host committed events reach the Client piTuiPerformance projection face', async (t) => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'perf-host-wire')
  await host.harness.create(SessionId(SESSION_ID), undefined, { cwd: host.workRoot })
  const session = host.ctx.sessions.get(SessionId(SESSION_ID))
  assert.ok(session !== undefined, 'the fixture must own the seeded Host Session')
  // Cold history: committed BEFORE the Client connects, so the retain-time
  // baseline (not a later frame) must already carry the accumulated value.
  await appendRealTurn(session, 0, 120)

  const hostRuntime: RemoteHostRuntime = await createRemoteHostRuntime(host.ctx)
  const client: RemoteClientRuntime = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  t.after(async () => {
    await client.dispose()
    await hostRuntime.dispose()
    await host.dispose()
  })

  await waitFor('the seeded Session to appear in the Client list', () =>
    client.sessions.list.getSnapshot().ids.map(String).includes(SESSION_ID))
  const reference = client.sessions.retain(SessionId(SESSION_ID), { source: 'tuiMainView' })
  t.after(() => { reference.release() })
  await reference.ready

  const face = reference.binding.session.projections.faceOf(PI_TUI_PERFORMANCE_KEY)
  const invalidations: string[] = []
  const off = face.subscribe(() => invalidations.push('frame'))
  t.after(() => off())

  await waitFor('the piTuiPerformance baseline to publish', () => face.getSnapshot() !== undefined)
  const baseline = face.getSnapshot() as PiTuiPerformanceProjection
  assert.equal(baseline.all.samples, 1, 'the cold baseline carries the committed step')
  assert.equal(baseline.all.outputTokens, 120)
  assert.ok(baseline.all.modelMs > 0, 'the committed wall time is positive')
  assert.equal(baseline.recent.samples, 1)
  assert.equal(baseline.recent.firstTokenSamples, 1, 'the committed first-token evidence crossed the wire')

  // Live: one more real committed turn reaches the SAME face.
  await appendRealTurn(session, 1, 30)
  await waitFor('the live projection frame to advance the face', () =>
    (face.getSnapshot() as PiTuiPerformanceProjection | undefined)?.all.samples === 2)
  const live = face.getSnapshot() as PiTuiPerformanceProjection
  assert.equal(live.all.outputTokens, 150)
  assert.equal(live.recent.outputTokens, 150)
  assert.ok(invalidations.length > 0, 'the face subscription observed the live projection frame')
})
