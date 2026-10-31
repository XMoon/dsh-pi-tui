/**
 * M4-C1 isolated qualification workload.
 *
 * This module is copied into an isolated `pi-tui` profile and mounted as one
 * Loader row through `SPLIT_PROCESS_EXTRA_PATCH`. It is a TEST-ONLY Host
 * fixture: it registers a scripted `LlmAdapter` and one small tool, and it
 * observes the OFFICIAL Host services (`ctx.jobs`, `ctx.subagents`,
 * `ctx.userQuestions`, `ctx.approval`, `ctx.agents`). It never writes durable
 * Session events by hand, never creates a second Host authority and never
 * enters the published package.
 *
 * The smoke owns the barriers and the private `C1_WORK_ROOT`; this fixture
 * only records facts after the real Host entry points have been reached.
 *
 * Scenario protocol (frozen):
 *   C1_SCENARIO = long-turn | foreground-tool | job | child | question |
 *                 approval-allow | approval-reject | goal | maintenance | schedule |
 *                 unowned-job
 *   C1_WORK_ROOT = private 0700 directory under the isolated work dir
 *   C1_HOLD_<NAME> = absolute barrier file path the smoke releases
 *   C1_HAS_LIVE_CLIENT_PROBE = set to sample Gateway.hasLiveClient() transitions
 *   C1_NON_ANSWERING_PEER_PROBE = absolute barrier path for the negative control
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'm4-c1-host-work'
export const inject = ['llm', 'tools', 'jobs', 'subagents', 'agents', 'typertGateway', 'connection']

const SCENARIOS = new Set([
  'long-turn',
  'foreground-tool',
  'job',
  'child',
  'question',
  'approval-allow',
  'approval-reject',
  // Host-liveness qualification scenarios. They only reach official Host
  // services (`goals`, `schedule`, `Agent.runMaintenance`) and record facts.
  'goal',
  'maintenance',
  'schedule',
  'unowned-job',
])

/** Quote one token for the Host shell used by the harmless fixture commands. */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** Read the last user-authored text in one model request. */
function allUserText(messages) {
  const texts = []
  for (const message of messages) {
    if (message?.role !== 'user' || !Array.isArray(message.content)) continue
    texts.push(message.content.map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : '')).join(''))
  }
  return texts.join('\n')
}

/** Wait for one smoke-owned barrier file; the fixture owns no timeout policy. */
async function waitForBarrier(path, signal) {
  if (path === undefined || path === '') throw new Error('m4-c1-host-work: the barrier path is missing')
  while (!existsSync(path)) {
    if (signal?.aborted === true) throw signal.reason ?? new Error('m4-c1-host-work: request aborted')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Create/validate the private work root and its 0600 append-only proof file. */
function prepareWorkRoot(rawRoot) {
  if (typeof rawRoot !== 'string' || !isAbsolute(rawRoot)) {
    throw new Error('m4-c1-host-work: C1_WORK_ROOT must be an absolute path')
  }
  mkdirSync(rawRoot, { recursive: true, mode: 0o700 })
  const stats = statSync(rawRoot)
  if (!stats.isDirectory()) throw new Error('m4-c1-host-work: C1_WORK_ROOT is not a directory')
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error('m4-c1-host-work: C1_WORK_ROOT is not owned by this process user')
  }
  chmodSync(rawRoot, 0o700)
  const proof = join(rawRoot, 'events.jsonl')
  writeFileSync(proof, '', { mode: 0o600 })
  chmodSync(proof, 0o600)
  return { root: rawRoot, proof }
}

/** The scripted model. All work is driven through the official Agent loop. */
class C1Model extends LlmAdapter {
  constructor(scenario, proof, root, agentStatusOf) {
    super()
    this.scenario = scenario
    this.proof = proof
    this.root = root
    this.agentStatusOf = agentStatusOf
    this.toolIssued = new Set()
    this.longTurnCount = new Map()
    this.childHeld = false
  }

  record(kind, fields = {}) {
    appendFileSync(this.proof, `${JSON.stringify({ kind, scenario: this.scenario, time: Date.now(), pid: process.pid, ...fields })}\n`, { mode: 0o600 })
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async listModels() {
    return [{ provider: 'c1-qualification', id: 'c1', name: 'c1' }]
  }

  async *stream(options) {
    const signal = options.signal
    const sessionId = options.sessionId === undefined ? '' : String(options.sessionId)
    if (options.purpose === 'session-title') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'C1 qualification' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'C1 qualification' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const userText = allUserText(options.messages ?? [])
    const afterTool = Array.isArray(options.messages) && options.messages.at(-1)?.role === 'tool'
    const token = `${this.scenario}-${sessionId}`

    if (this.scenario === 'long-turn') {
      if (afterTool) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `long-turn answer ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `long-turn answer ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const attempt = (this.longTurnCount.get(sessionId) ?? 0) + 1
      this.longTurnCount.set(sessionId, attempt)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `long-turn started ${token}` }
      this.record('long-turn-held', {
        sessionId,
        attempt,
        userText: userText.slice(0, 400),
        agentStatus: this.agentStatusOf(sessionId),
      })
      await waitForBarrier(process.env.C1_HOLD_LONG_TURN, signal)
      this.record('long-turn-released', { sessionId, attempt })
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `long-turn answer ${String(attempt)} ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'foreground-tool') {
      if (!this.toolIssued.has(sessionId)) {
        this.toolIssued.add(sessionId)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `c1-foreground-${sessionId}`,
            name: 'c1_foreground_tool',
            arguments: JSON.stringify({ token }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `foreground answer ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `foreground answer ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'job') {
      if (!this.toolIssued.has(sessionId)) {
        this.toolIssued.add(sessionId)
        const release = join(this.root, 'job.release')
        const command = `while [ ! -f ${shellQuote(release)} ]; do sleep 0.05; done; printf 'c1-job-done'`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `c1-job-${sessionId}`,
            name: 'bash',
            arguments: JSON.stringify({ command, description: 'Hold the M4-C1 background job', run_in_background: true }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `job accepted ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `job accepted ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'child') {
      if (userText.includes('c1-child-task')) {
        this.childHeld = true
        this.record('child-stream-held', { sessionId, userText })
        await waitForBarrier(process.env.C1_HOLD_CHILD, signal)
        this.record('child-stream-released', { sessionId })
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: `child answer ${token}` }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `child answer ${token}` } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (!this.toolIssued.has(sessionId)) {
        this.toolIssued.add(sessionId)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `c1-child-${sessionId}`,
            name: 'subagent',
            arguments: JSON.stringify({ description: 'C1 child work', prompt: `c1-child-task ${token}` }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `child delegated ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `child delegated ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'question') {
      if (!this.toolIssued.has(sessionId)) {
        this.toolIssued.add(sessionId)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `c1-question-${sessionId}`,
            name: 'ask_user_question',
            arguments: JSON.stringify({
              questions: [{
                id: 'c1-question',
                question: 'Continue the C1 test?',
                options: [{ label: 'Proceed' }, { label: 'Cancel' }],
              }],
              ...(process.env.C1_TIMED_QUESTION === '1' ? { timeout: 1 } : {}),
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (process.env.C1_HOLD_AFTER_TIMED !== undefined && process.env.C1_HOLD_AFTER_TIMED !== '') {
        this.record('after-timed-held', { sessionId })
        await waitForBarrier(process.env.C1_HOLD_AFTER_TIMED, signal)
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `question answered ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `question answered ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'goal' || this.scenario === 'maintenance' || this.scenario === 'schedule' || this.scenario === 'unowned-job') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `${this.scenario} answer ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `${this.scenario} answer ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    if (this.scenario === 'approval-allow' || this.scenario === 'approval-reject') {
      if (!this.toolIssued.has(sessionId)) {
        this.toolIssued.add(sessionId)
        const marker = join(this.root, `${this.scenario}.marker`)
        const command = `printf 'c1-${this.scenario}' > ${shellQuote(marker)}`
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield {
          type: 'block-end',
          index: 0,
          block: {
            type: 'tool-call',
            id: `c1-${this.scenario}-${sessionId}`,
            name: 'bash',
            arguments: JSON.stringify({
              command,
              description: 'Create the harmless M4-C1 approval marker',
              sandbox_permissions: 'danger-full-access',
              justification: 'Qualification verifies the human approval decision on an isolated harmless command.',
            }),
          },
        }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `approval settled ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `approval settled ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    throw new Error(`m4-c1-host-work: unsupported scenario ${JSON.stringify(this.scenario)}`)
  }
}

/**
 * Mount the scripted workload on the Host profile. A profile without
 * `C1_SCENARIO` keeps this row inert: the ordinary B1/B2-S lanes share the
 * same installed profile and must not gain a second model route.
 */
export function apply(ctx) {
  const scenario = process.env.C1_SCENARIO
  if (scenario === undefined || scenario === '') return
  if (!SCENARIOS.has(scenario)) throw new Error(`m4-c1-host-work: unsupported C1_SCENARIO ${JSON.stringify(scenario)}`)
  const { root, proof } = prepareWorkRoot(process.env.C1_WORK_ROOT)
  const record = (kind, fields = {}) => {
    appendFileSync(proof, `${JSON.stringify({ kind, scenario, time: Date.now(), pid: process.pid, ...fields })}\n`, { mode: 0o600 })
  }
  const model = new C1Model(scenario, proof, root, sessionId => {
    const agent = ctx.agents.get(sessionId)
    return agent === undefined ? undefined : agent.status
  })

  ctx.effect(() => ctx.llm.registerAdapter(['c1-qualification'], model))

  // Real Agent status transitions are Host facts, not a boolean this fixture
  // invents. `agent/status` is the official runtime event; the durable
  // Session events remain the smoke's final authority.
  ctx.on('agent/status', payload => {
    record('agent-status', {
      agentId: payload?.agent?.id === undefined ? undefined : String(payload.agent.id),
      agentStatus: payload?.status,
    })
  })

  // Job registry lifecycle facts. The proof carries the official job id,
  // owner, kind and the registry status; it never constructs a fake job.
  ctx.jobs.events.subscribe({ owners: 'all' }, event => {
    if (event.type === 'output') return
    let output
    if (event.type === 'settled' && event.job !== undefined) {
      try {
        const read = ctx.jobs.readAt(event.job.id, 0, event.job.owner)
        output = read.chunks.map(chunk => chunk.text).join('')
      } catch {
        output = undefined
      }
    }
    record('job-event', {
      event: event.type,
      jobId: event.job?.id,
      owner: event.job?.owner === undefined ? undefined : String(event.job.owner),
      jobKind: event.job?.kind,
      label: event.job?.label,
      status: event.job?.status,
      cause: event.type === 'settled' ? event.cause : undefined,
      output,
    })
  })

  ctx.on('subagent/start', info => {
    record('subagent-start', { runId: info?.runId, provider: info?.provider, childId: info?.id === undefined ? undefined : String(info.id), local: info?.local })
  })
  ctx.on('subagent/end', info => {
    record('subagent-end', {
      runId: info?.runId,
      provider: info?.provider,
      childId: info?.id === undefined ? undefined : String(info.id),
      local: info?.local,
      stopReason: info?.stopReason,
      lastAssistantMessage: info?.lastAssistantMessage,
    })
  })

  // Observe the official Question/Approval waterfalls without claiming them:
  // each listener records the exact Host request/answer identity and then
  // delegates with `next()`, so the real C2 PiTui answerer remains the only
  // consumer. Durable `tool/call` / `tool/result` / `approval/asked` /
  // `approval/decided` events remain the final authority.
  let lastQuestionCallId
  const questionProjection = () => {
    try {
      const agent = ctx.agents.roots()[0]
      if (agent === undefined) return undefined
      const projections = ctx.get('sessionProjections')
      const state = projections?.stateOf(agent.session, 'userQuestions')
      return state?.questions?.active
    } catch {
      return undefined
    }
  }
  ctx.on('user-questions/request', async (request, next) => {
    const callId = request?.wait?.callId
    if (typeof callId === 'string') lastQuestionCallId = callId
    const sessionId = request?.agent?.id === undefined ? undefined : String(request.agent.id)
    record('question-request', {
      callId: callId === undefined ? undefined : String(callId),
      sessionId,
      timed: request?.wait?.timed === true,
      questions: request?.questions,
    })
    try {
      const answer = await next()
      record('question-settled', {
        callId: callId === undefined ? undefined : String(callId),
        sessionId,
        answers: answer?.answers,
      })
      record('question-projection', {
        callId: callId === undefined ? undefined : String(callId),
        sessionId,
        active: questionProjection(),
      })
      return answer
    } catch (error) {
      record('question-failed', {
        callId: callId === undefined ? undefined : String(callId),
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      record('question-projection', {
        callId: callId === undefined ? undefined : String(callId),
        sessionId,
        active: questionProjection(),
      })
      // The projection settles asynchronously after the timed tool result is
      // written. Poll briefly for the official `continued` transition; this is
      // evidence capture only and never drives the Host flow.
      if (callId !== undefined) {
        const started = Date.now()
        const timer = setInterval(() => {
          const active = questionProjection()
          if (Array.isArray(active) && active.some(item => item?.callId === String(callId) && item?.state === 'continued')) {
            clearInterval(timer)
            record('question-projection', {
              callId: String(callId),
              sessionId,
              active,
              phase: 'continued',
            })
          } else if (Date.now() - started > 5_000) {
            clearInterval(timer)
          }
        }, 100)
      }
      throw error
    }
  }, { prepend: true })

  ctx.on('approval/request', async (request, next) => {
    const callId = request?.callId === undefined ? undefined : String(request.callId)
    record('approval-request', {
      toolName: request?.toolName,
      callId,
      sessionId: request?.agent?.id === undefined ? undefined : String(request.agent.id),
      reason: request?.reason,
    })
    try {
      const outcome = await next()
      record('approval-settled', { toolName: request?.toolName, callId, outcome })
      return outcome
    } catch (error) {
      record('approval-failed', { toolName: request?.toolName, callId, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }, { prepend: true })

  // Qualification-only Host Agent cancel trigger: the smoke writes the
  // barrier file, and the fixture calls the official Agent cancel. It never
  // writes an approval/question event itself.
  const cancelBarrier = process.env.C1_CANCEL_AGENT
  if (cancelBarrier !== undefined && cancelBarrier !== '') {
    const timer = setInterval(() => {
      if (!existsSync(cancelBarrier)) return
      clearInterval(timer)
      for (const agent of ctx.agents.roots()) {
        record('agent-cancel-requested', { agentId: String(agent.id) })
        agent.cancel({ kind: 'user' })
      }
    }, 20)
    ctx.effect(() => () => clearInterval(timer))
  }

  // Qualification-only Host-side continued-answer probe. It calls the
  // official `ctx.userQuestions.answer` service (the same authority behind the
  // Remote namespace) at a smoke-controlled barrier and records the exact
  // boolean/error taxonomy. It never writes a question event itself.
  for (const [envName, phase] of [
    ['C1_ANSWER_PROBE_DUPLICATE', 'duplicate'],
    ['C1_ANSWER_PROBE_EXPIRED', 'expired'],
  ]) {
    const probePath = process.env[envName]
    if (probePath === undefined || probePath === '') continue
    record('answer-probe-armed', { phase, probePath })
    const timer = setInterval(() => {
      if (!existsSync(probePath)) return
      clearInterval(timer)
      try {
        const agent = ctx.agents.roots()[0]
        const userQuestions = ctx.get('userQuestions')
        if (agent === undefined || userQuestions === undefined) {
          record('answer-probe', { phase, error: agent === undefined ? 'no-root-agent' : 'no-user-questions' })
          return
        }
        const call = userQuestions.continued(agent)[0]
        const callId = call?.callId ?? lastQuestionCallId
        if (callId === undefined) {
          record('answer-probe', { phase, error: 'no-call-id' })
          return
        }
        // Call the official Host answer service even when the Projection no
        // longer lists the call: the settled-call classification must come
        // from the service return, never from local projection absence.
        const value = userQuestions.answer(agent, callId, { answers: [{ id: 'c1-question', selected: ['Proceed'] }] })
        record('answer-probe', { phase, callId, value })
      } catch (error) {
        record('answer-probe', {
          phase,
          code: error?.code,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }, 20)
    ctx.effect(() => () => clearInterval(timer))
  }

  // M4-C2-A liveness scenarios: produce one official source fact only after
  // the first real turn, so the Agent is idle at the moment the fact exists.
  // Every step uses the official Host owner; the fixture only records.
  if (scenario === 'goal' || scenario === 'maintenance' || scenario === 'schedule') {
    let sawRunning = false
    let armed = false
    const afterFirstTurn = (callback) => {
      ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'running') {
          sawRunning = true
          return
        }
        if (status !== 'idle' || !sawRunning || armed) return
        if (!ctx.agents.roots().includes(agent)) return
        armed = true
        setTimeout(() => { callback(agent) }, 0)
      })
    }
    if (scenario === 'goal') {
      // The REAL goal-round-driver owns the automatic reservation; this
      // fixture only creates the governing Goal record through the service.
      ctx.on('agent/inbox/inserted', ({ agent, message }) => {
        const source = message?.source
        if (source?.kind !== 'goal') return
        record('goal-round-observed', {
          agentId: String(agent.id),
          agentStatus: agent.status,
          goalId: String(source.goalId),
          revision: source.revision,
          round: source.round,
          inboxNextTurn: agent.inbox.nextTurn.length,
          inboxNextStep: agent.inbox.nextStep.length,
        })
      })
      afterFirstTurn(agent => {
        const goals = ctx.get('goals')
        if (goals === undefined) {
          record('goal', { phase: 'unavailable' })
          return
        }
        try {
          const view = goals.create(agent, { objective: 'M4-C2-A qualification goal', maxGoalRounds: 1 })
          record('goal-created', {
            agentId: String(agent.id),
            goalId: String(view.id),
            revision: view.revision,
            goalPhase: view.phase,
            activation: view.activation,
          })
        } catch (error) {
          record('goal-create-failed', {
            agentId: String(agent.id),
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
    }
    if (scenario === 'maintenance') {
      afterFirstTurn(agent => {
        const release = join(root, 'maintenance.release')
        record('maintenance', { phase: 'before', agentId: String(agent.id), agentStatus: agent.status })
        agent.runMaintenance(async (signal) => {
          record('maintenance', { phase: 'running', agentId: String(agent.id), agentStatus: agent.status })
          while (!existsSync(release)) {
            if (signal?.aborted === true) throw signal.reason ?? new Error('m4-c1-host-work: maintenance aborted')
            await new Promise(resolveWait => setTimeout(resolveWait, 20))
          }
          record('maintenance', { phase: 'released', agentId: String(agent.id) })
          return 'released'
        }).then(
          () => { record('maintenance', { phase: 'settled', agentId: String(agent.id), agentStatus: agent.status }) },
          error => { record('maintenance', { phase: 'failed', agentId: String(agent.id), error: error instanceof Error ? error.message : String(error) }) },
        )
      })
    }
    if (scenario === 'schedule') {
      afterFirstTurn(agent => {
        const schedule = ctx.get('schedule')
        if (schedule === undefined) {
          record('schedule', { phase: 'unavailable' })
          return
        }
        schedule.create(agent.id, {
          prompt: 'M4-C2-A qualification schedule task',
          title: 'M4-C2-A qualification schedule task',
          after_seconds: 600,
        }).then(view => {
          record('schedule-created', {
            agentId: String(agent.id),
            scheduleId: String(view.id),
            status: 'active',
          })
          const deleteBarrier = join(root, 'schedule.delete')
          const timer = setInterval(() => {
            if (!existsSync(deleteBarrier)) return
            clearInterval(timer)
            schedule.delete({ sessionId: agent.id, id: view.id }).then(
              result => { record('schedule-deleted', { scheduleId: String(view.id), deleted: result.deleted, code: result.code }) },
              error => { record('schedule-delete-failed', { scheduleId: String(view.id), error: error instanceof Error ? error.message : String(error) }) },
            )
          }, 20)
          timer.unref?.()
          ctx.effect(() => () => clearInterval(timer))
        }, error => {
          record('schedule-create-failed', {
            agentId: String(agent.id),
            error: error instanceof Error ? error.message : String(error),
          })
        })
      })
    }
  }

  // M4-C2-B B1: observe the one official Gateway eligibility fact rc.4 exposes.
  // `hasLiveClient()` reports whether ANY owner event stream is open; it never
  // identifies a request, so the proof below only records a boolean transition
  // and never infers a pending inventory or an expiry.
  const liveClientProbe = process.env.C1_HAS_LIVE_CLIENT_PROBE
  if (liveClientProbe !== undefined && liveClientProbe !== '') {
    const gateway = ctx.get('typertGateway')
    if (gateway === undefined) throw new Error('m4-c1-host-work: typertGateway is missing for the live-client probe')
    let last
    let sequence = 0
    const sample = () => {
      const value = gateway.hasLiveClient()
      if (value === last) return
      last = value
      sequence += 1
      record('has-live-client', { value, sequence })
    }
    sample()
    const timer = setInterval(sample, 20)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))
  }

  // Negative control: a real in-process Peer that is not eligible to answer
  // forwarded events must not open `$events`, and must not make
  // `hasLiveClient()` true. Both services are official Host APIs; the fixture
  // only observes the refusal and records its stable code.
  const nonAnsweringProbe = process.env.C1_NON_ANSWERING_PEER_PROBE
  if (nonAnsweringProbe !== undefined && nonAnsweringProbe !== '') {
    const timer = setInterval(() => {
      if (!existsSync(nonAnsweringProbe)) return
      clearInterval(timer)
      const gateway = ctx.get('typertGateway')
      const connection = ctx.get('connection')
      if (gateway === undefined || connection === undefined) {
        record('non-answering-peer', { opened: false, code: 'service-unavailable' })
        return
      }
      const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })
      gateway.wireStream.open('$events', { args: {} }, (async function* emptyUplink() {})(), peer, peer.signal).then(
        stream => {
          record('non-answering-peer', { opened: true, code: 'opened', liveClient: gateway.hasLiveClient() })
          stream[Symbol.asyncIterator]().return?.()
        },
        error => {
          record('non-answering-peer', { opened: false, code: error?.code ?? 'unknown', liveClient: gateway.hasLiveClient() })
        },
      ).finally(() => peer.dispose()).catch(error => {
        record('non-answering-peer-failed', { error: error instanceof Error ? error.message : String(error) })
      })
    }, 20)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))
  }

  // Host-liveness unowned-Job qualification: start one real DSH Job with no
  // Session owner and hold it until the smoke releases it. The observer must
  // see it through the unowned registry list and the official event stream.
  if (scenario === 'unowned-job') {
    const armBarrier = process.env.C1_UNOWNED_JOB_ARM
    if (armBarrier !== undefined && armBarrier !== '') {
      const timer = setInterval(() => {
        if (!existsSync(armBarrier)) return
        clearInterval(timer)
        try {
          // An unowned Job requires a global controller; the Host-only overlay
          // does not mount tool-jobs at the root, so this test fixture attaches
          // its own unscoped controller through the official registry seam.
          const detachController = ctx.jobs.attachController('c2a-unowned-job')
          ctx.effect(() => () => detachController())
          const id = ctx.jobs.start({
            kind: 'c2a-unowned',
            label: 'C2A unowned qualification job',
            run(handle) {
              record('unowned-job-created', { jobId: String(handle.id), status: 'running' })
              const release = join(root, 'unowned-job.release')
              let settle
              const done = new Promise(resolve => { settle = resolve })
              let settled = false
              let poll
              const finish = outcome => {
                if (settled) return
                settled = true
                if (poll !== undefined) clearInterval(poll)
                settle(outcome)
              }
              poll = setInterval(() => {
                if (!existsSync(release)) return
                record('unowned-job-released', { jobId: String(handle.id) })
                finish({ status: 'completed' })
              }, 20)
              poll.unref?.()
              ctx.effect(() => () => clearInterval(poll))
              return {
                cancel(reason) {
                  record('unowned-job-cancelled', { jobId: String(handle.id), reason })
                  finish({ status: 'killed', ...(reason === undefined ? {} : { detail: reason }) })
                },
                done,
              }
            },
          })
          record('unowned-job-armed', { jobId: String(id) })
        } catch (error) {
          record('unowned-job-start-failed', { error: error instanceof Error ? error.message : String(error) })
        }
      }, 20)
      timer.unref?.()
      ctx.effect(() => () => clearInterval(timer))
    }
  }

  if (scenario === 'foreground-tool') {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: 'c1_foreground_tool',
      description: 'Hold one real Host tool call until the qualification barrier is released.',
      parameters: {
        token: { type: 'string', required: true, description: 'Opaque qualification token.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args, exec) {
        record('tool-started', {
          callId: String(exec.callId),
          sessionId: exec.agent === undefined ? undefined : String(exec.agent.id),
          token: args.token,
        })
        await waitForBarrier(process.env.C1_HOLD_TOOL, exec.signal)
        record('tool-released', { callId: String(exec.callId) })
        return `c1-tool-result-${String(args.token)}`
      },
    })))
  }
}
