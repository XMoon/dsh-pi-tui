/**
 * M6-2C C13 fixture: a REAL Host Session turn that stays in flight.
 *
 * Unlike the internal split-process fixtures this row is installed as ordinary
 * profile configuration (`<profile>/cordis.patch.yml` plus a module inside the
 * profile), because a systemd-managed Host deliberately strips the internal
 * `SPLIT_PROCESS_EXTRA_PATCH` test channel. Its inputs therefore come from the
 * profile row's `config`, not from the environment.
 *
 * The row creates one real Agent through the official `agents` service, sends
 * one real follow-up turn and registers an offline model route whose stream
 * holds after the first chunk. It records `turn-start` when the model call is
 * actually in flight and `turn-aborted` when the Host's shutdown signal reaches
 * it, so the smoke can prove the turn existed and was never silently replayed.
 *
 * @module fixtures/daemon-control-inflight-work
 */

import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'm6-2c-inflight-work'
export const inject = ['llm', 'agents', 'tools']

class InflightAdapter extends LlmAdapter {
  constructor(record) {
    super()
    this.record = record
  }

  resolveModel(provider, model) {
    return Promise.resolve({ provider: 'c1-qualification', id: model, name: model })
  }

  listModels() {
    return Promise.resolve([{ provider: 'c1-qualification', id: 'c1', name: 'c1' }])
  }

  async *stream(options) {
    // A Session-title call carries no tools; only the real Agent turn does.
    // Answering the title immediately keeps this fixture from looking like a
    // second business turn.
    if (!Array.isArray(options?.tools) || options.tools.length === 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'C13 title' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'C13 title' } }
      return
    }
    this.record('turn-start', { model: options?.model?.id ?? 'c1' })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'C13 partial answer' }
    for (;;) {
      if (options?.signal?.aborted === true) {
        this.record('turn-aborted')
        throw options.signal.reason ?? new Error('m6-2c-inflight-work: turn aborted by Host shutdown')
      }
      await sleep(50)
    }
  }
}

export function apply(ctx, config) {
  const record = (kind, fields = {}) => {
    appendFileSync(config.proofPath, `${JSON.stringify({ kind, time: Date.now(), pid: process.pid, ...fields })}\n`, { mode: 0o600 })
  }
  ctx.llm.registerAdapter(['c1-qualification'], new InflightAdapter(record))
  // The "user" submits exactly ONCE: a restart must not resend the prompt, so
  // any further turn is the Host's own replay rather than this fixture's.
  if (existsSync(config.markerPath)) return
  // This row activates with the profile, which can be before `agent-loop` has
  // registered its agent factory. Retry the official creation until the Host is
  // actually able to host a Session; the bound is the row's own lifetime.
  const openTurn = async () => {
    let last
    for (let attempt = 0; attempt < 600; attempt += 1) {
      try {
        const created = await ctx.agents.create({
          sessionId: SessionId(config.sessionId),
          meta: { cwd: config.cwd },
          agentOptions: { provider: 'c1-qualification', model: 'c1' },
        })
        ctx.effect(() => () => created.dispose())
        record('session-created', { sessionId: String(created.agent.id) })
        writeFileSync(config.markerPath, 'submitted\n', { mode: 0o600 })
        created.agent.followup({
          id: `m6-2c-inflight-${String(Date.now())}`,
          role: 'user',
          content: [{ type: 'text', text: 'C13 in-flight turn' }],
          source: { kind: 'user' },
        })
        record('turn-submitted', { sessionId: String(created.agent.id) })
        return
      } catch (error) {
        last = error
        await sleep(100)
      }
    }
    record('session-create-failed', { message: last instanceof Error ? last.message : String(last) })
  }
  openTurn().catch(error => {
    record('session-create-failed', { message: error instanceof Error ? error.message : String(error) })
  })
}
