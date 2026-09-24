/**
 * rc.2 real-composition JobController proof (implementation plan §12.3).
 *
 * The pi-tui bundle mounts the official `job-controller` row
 * (`@deepseek-ai/dsh-api-job-controller`, asserted from `cordis.patch.yml` by
 * the adapter suite). This test composes the REAL upstream job stack — the
 * official `LocalJobRegistry` + `JobController` host service — and drives the
 * TUI's `DirectJobObservationPort` against it:
 *
 * - `ctx.jobController` exists and `follow()` opens for a real registered job;
 * - the observer is NON-CONSUMING: the model-side `jobs.read()` cursor is
 *   untouched, so the model still receives every unread byte afterwards.
 *
 * @module @xmoon76/dsh-pi-tui/job-controller-composition.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import JobController from '@deepseek-ai/dsh-api-job-controller'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { JobHandle, JobOutcome } from '@deepseek-ai/dsh-jobs'
import { DirectJobObservationPort } from '../src/runtime/direct/job-observation-direct.ts'
import type { JobObservedSnapshot } from '../src/runtime/job-observation-port.ts'
import { createDiag } from '../src/diag.ts'

const diag = createDiag({ filePath: undefined, stderrLevel: 'off' })

async function flush(times = 12): Promise<void> {
  for (let index = 0; index < times; index += 1) await new Promise<void>(resolve => setTimeout(resolve, 0))
}

test('the real job stack composes ctx.jobController and observation is non-consuming', async () => {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(JobController, {})
  ctx.jobs.attachController('job-controller-composition-test')

  // Register a live agent for the observing session (the registry fences reads
  // by owning session, so a real caller identity must exist).
  const scopeFiber = ctx.plugin(() => {})
  const id = SessionId('job-composition-session')
  const agent: Agent = {
    id,
    options: {},
    session: Session.create(id),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scopeFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: (task: (signal: AbortSignal) => unknown) => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  } as unknown as Agent
  await ctx.agents.register(agent)

  // One real running job owned by that session.
  let handle!: JobHandle
  let settle!: (outcome: JobOutcome) => void
  const jobId = ctx.jobs.start({
    kind: 'bash',
    label: 'composition probe',
    owner: id,
    run: (job) => {
      handle = job
      return {
        cancel: () => settle({ status: 'killed' }),
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }
    },
  })
  handle.append('retained line one\n')
  handle.append('retained line two\n')

  const controller = (ctx as unknown as { jobController: unknown }).jobController
  assert.ok(controller !== undefined, 'the real composition exposes ctx.jobController')

  const port = new DirectJobObservationPort(ctx as never, diag)
  const seen: JobObservedSnapshot[] = []
  const close = port.open('job-composition-session', String(jobId), snapshot => seen.push(snapshot))
  await flush()
  const observed = seen.at(-1)
  assert.ok(observed !== undefined, 'follow() opens for a real registered job')
  assert.equal(observed.label, 'composition probe')
  assert.equal(observed.text, 'retained line one\nretained line two\n')

  // The observer read only the retained ring: the model-facing consuming read
  // is untouched and still hands out every byte.
  const modelRead = ctx.jobs.read(jobId, id)
  assert.equal(modelRead.chunks.map(chunk => chunk.text).join(''), 'retained line one\nretained line two\n',
    'the model cursor is unchanged by the TUI observation')

  close()
  settle({ status: 'completed', result: 'done' })
  await flush()
  await scopeFiber.dispose()
  await ctx.fiber.dispose()
})
