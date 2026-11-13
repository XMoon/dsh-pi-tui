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
 *                 approval-allow | approval-reject | goal-armed | goal-round |
 *                 maintenance | schedule | unowned-job | web-workspace-changes | f1-shell
 *   C1_WORK_ROOT = private 0700 directory under the isolated work dir
 *   C1_HOLD_<NAME> = absolute barrier file path the smoke releases
 *   C1_HAS_LIVE_CLIENT_PROBE = set to sample Gateway.hasLiveClient() transitions
 *   C1_NON_ANSWERING_PEER_PROBE = absolute barrier path for the negative control
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'm4-c1-host-work'
export const inject = ['llm', 'tools', 'jobs', 'subagents', 'agents', 'workingDirectory', 'typertGateway', 'connection', 'commands', 'attachments']

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
  'goal-armed',
  'goal-round',
  'maintenance',
  'schedule',
  'unowned-job',
  // S5-PR5 W5-CHANGES: one real `write` tool call through the official
  // standard preset, so the official `workspace-changes` recorder observes a
  // real file intent and a real working-tree change.
  'web-workspace-changes',
  'f1-shell',
  // M6 F4: one Host-seeded Session for the real Client /attach -> official
  // receipt -> durable file proof.
  'f4-file',
  // M6 PR-C: the test-only Host /files command proving a real Client command
  // FILE delivery through the official staged-receipt resolver.
  'command-file-receipt',
  // M6-1 F6: the Skills cases only need the real Host profile; the scripted
  // model stays inert and the fault provider is gated by C1_SKILLS_FAULT_DIR.
  'skills-standing',
  'skills-recovery',
  // M6-1 F7A: register the qualification provider flows on the REAL official
  // `ctx.authorization` service. The flows commit through the official
  // `AuthorizationSession.commit` write path; this fixture is the provider
  // plugin boundary, never a replacement for the authorization seam.
  'f7a-authorization',
  // M6-1 F7B: seed stored credential RECORDS through the official
  // `ctx.credentials.modifyRecord()` write path (never a hand-edited YAML).
  'f7b-credential-records',
  // M6-1 F8: create two live Sessions and seed independent official
  // approval/sandbox policy facts; the replay scenario resumes one Session in
  // a FRESH Host to prove the durable projection replay.
  'session-policy-f8',
  'session-policy-f8-replay',
  // M6-1 F3 closure: seed the official Web settings baseline + a non-functional
  // credential sentinel through the official Services (never a hand edit).
  'web-settings-f3',
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

function textOf(value) {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('\\n')
  if (value !== null && typeof value === 'object') {
    if (Object.hasOwn(value, 'content')) return textOf(value.content)
    if (Object.hasOwn(value, 'text')) return textOf(value.text)
  }
  return ''
}

function recordPromptFacts(options) {
  const evidencePath = process.env.SPLIT_PROCESS_PROMPT_EVIDENCE
  if (typeof evidencePath !== 'string' || evidencePath === '') return
  const systemText = [options.system, ...(options.messages ?? [])
    .filter(message => message?.role === 'system')
    .map(message => message.content)]
    .map(textOf).join('\\n')
  const toolNames = Array.isArray(options.tools)
    ? options.tools.map(tool => tool?.name).filter(name => typeof name === 'string').sort()
    : []
  appendFileSync(evidencePath, JSON.stringify({
    markerCount: systemText.split('Prefer showing the primary results within your final response').length - 1,
    presentInstruction: systemText.includes('Use present to publish complete deliverables'),
    presentTool: toolNames.includes('present'),
    toolNames,
  }) + '\n', { mode: 0o600 })
}

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
    recordPromptFacts(options)
    const userText = allUserText(options.messages ?? [])
    const afterTool = Array.isArray(options.messages) && options.messages.at(-1)?.role === 'tool'
    const token = `${this.scenario}-${sessionId}`

    if (this.scenario === 'f1-shell' || this.scenario === 'f4-file') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: `${this.scenario} answer ${token}` }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `${this.scenario} answer ${token}` } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

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

    if (this.scenario === 'web-workspace-changes') {
      // The FIRST turn of a Session performs exactly ONE official `write` tool
      // call (the standard preset's real tool); the follow-up stream after its
      // result answers. Every later turn is a plain answer, and a
      // `w5-nochange` prompt runs one official `bash` tool call that changes no
      // file, so the recorder's genuine no-change path is exercised too.
      // The Host appends its OWN runtime/time context as user-role messages
      // AFTER the author's prompt, so the whole user text is matched instead of
      // a positional "last user message".
      const nonce = process.env.C1_CHANGES_NONCE ?? 'c1'
      const wrote = this.toolIssued.has(sessionId)
      const prompt = userText
      const toolCall = (id, toolName, args) => ({
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: toolName, arguments: JSON.stringify(args) },
      })
      if (prompt.includes('w5-changes2-')) {
        // The post-disable/re-enable Turn (F2): a SECOND real official `write`
        // through the same standard preset, into a different file.
        if (!this.secondIssued?.has(sessionId)) {
          this.secondIssued ??= new Set()
          this.secondIssued.add(sessionId)
          this.record('web-changes-write2-issued', { sessionId, nonce, userText: prompt })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield toolCall(`w5-write2-${sessionId}`, 'write', { file_path: 'changed2.txt', content: `w5-change2-${nonce}\n` })
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        const secondText = `w5-editing2 ${nonce}\n\n[changed2.txt](changed2.txt)\n\nw5-second answer ${nonce}`
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: secondText }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: secondText } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      if (!wrote && prompt.includes('w5-changes-')) {
        this.toolIssued.add(sessionId)
        this.record('web-changes-write-issued', { sessionId, nonce, userText: prompt })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield toolCall(`w5-write-${sessionId}`, 'write', { file_path: 'changed.txt', content: `w5-change-${nonce}\n` })
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (prompt.includes('w5-nochange') && !this.noChangeIssued?.has(sessionId)) {
        this.noChangeIssued ??= new Set()
        this.noChangeIssued.add(sessionId)
        this.record('web-changes-nochange-tool-issued', { sessionId, nonce })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield toolCall(`w5-nochange-${sessionId}`, 'read', { file_path: 'README.md' })
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      const tail = prompt.includes('w5-nochange') ? 'w5-nochange answer'
        : prompt.includes('> w5-editing') ? 'w5-quote answer' : 'w5-done answer'
      const text = `w5-editing ${nonce}\n\n[changed.txt](changed.txt) [missing-sentinel.txt](missing-sentinel.txt)\n\n![shot](shot.png)\n\n${tail} ${nonce}`
      this.record('web-changes-answer', { sessionId, nonce, tail })
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
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

    if (this.scenario === 'goal-armed' || this.scenario === 'goal-round' || this.scenario === 'maintenance' || this.scenario === 'schedule' || this.scenario === 'unowned-job') {
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
export async function apply(ctx) {
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

  // M6-1 F6 qualification fault: an EMPTY official provider that reports an
  // INCOMPLETE observation while the control file exists. The real filesystem
  // provider keeps contributing its candidates, so the catalog can prove
  // "incomplete must not replace the same-target last-good, then a complete
  // observation recovers".
  const skillsFaultDir = process.env.C1_SKILLS_FAULT_DIR
  if (skillsFaultDir !== undefined && skillsFaultDir !== '') {
    ctx.skills.registerProvider(() => ({
      name: 'c1-skills-fault',
      list: async () => {
        const readsPath = join(skillsFaultDir, 'fault-reads.jsonl')
        const record = (phase, incomplete) => appendFileSync(readsPath,
          `${JSON.stringify({ phase, incomplete, time: Date.now() })}\n`, { mode: 0o600 })
        const incomplete = existsSync(join(skillsFaultDir, 'incomplete'))
        record('start', incomplete)
        // A qualification-only HELD read: the smoke observes the painted
        // target-change state while this discovery is provably in flight,
        // then releases it explicitly. Production timing is untouched.
        if (existsSync(join(skillsFaultDir, 'slow'))) {
          const release = join(skillsFaultDir, 'release-slow')
          while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 20))
        }
        record('end', incomplete)
        return incomplete ? { candidates: [], complete: false } : { candidates: [], complete: true }
      },
      get: async () => undefined,
    }))
  }

  if (scenario === 'web-settings-f3') {
    // Seed the OFFICIAL Web settings baseline with KNOWN values through the
    // real `ctx.settings` (SettingsForms) write path, and plant a NON-FUNCTIONAL
    // unique credential sentinel through the official `ctx.credentials.set`
    // path. Nothing here is a product input; the case supplies the sentinel and
    // the base URL through its own environment and later proves neither the
    // sentinel nor a Client guess reached any observable surface.
    // The writes are FULLY DEFERRED (loader settled, own detached task): a
    // settings write from inside apply() would deadlock the plugin-row startup
    // the same way the f1-shell row reads settings only from event callbacks.
    const seedBaseURL = process.env.C1_F3_BASE_URL
    const sentinel = process.env.C1_F3_SECRET
    if (seedBaseURL === undefined || seedBaseURL === '' || sentinel === undefined || sentinel === '') {
      throw new Error('m4-c1-host-work: web-settings-f3 requires C1_F3_BASE_URL and C1_F3_SECRET')
    }
    const apiNamespace = 'web-deepseek-api'
    void (async () => {
      try {
        await new Promise(resolve => ctx.root.loader.await().then(resolve, resolve))
        await ctx.settings.mutate(apiNamespace, [
          { op: 'set', path: ['count'], value: 10 },
          { op: 'set', path: ['sendOriginalQuestion'], value: false },
          { op: 'set', path: ['baseURL'], value: seedBaseURL },
        ])
        const { credentialRef } = await import('@deepseek-ai/dsh-credentials')
        const ref = credentialRef('DEEPSEEK_API_KEY')
        // The sentinel reference is fixture state on the shared lane's ONE
        // dshHome: snapshot the prior reference value and restore the exact
        // pre-case state at row disposal (same lifecycle as the f7a/f7b record
        // seeds) so no later case inherits the sentinel.
        const previous = await ctx.credentials.resolve(ref)
        await ctx.credentials.set(ref, sentinel)
        ctx.effect(() => async () => {
          if (previous === undefined) await ctx.credentials.unset(ref)
          else await ctx.credentials.set(ref, previous.value)
          record('f3-credential-restored', { hadPrevious: previous !== undefined })
        }, 'f3-credential-restorer')
        const descriptors = ctx.settings.describe()
        const revisions = Object.fromEntries(descriptors.map(descriptor => [descriptor.ns, descriptor.revision]))
        const apiValue = descriptors.find(descriptor => descriptor.ns === apiNamespace)?.value
        const api = apiValue !== null && typeof apiValue === 'object'
          ? {
              baseURL: apiValue.baseURL,
              count: apiValue.count,
              sendOriginalQuestion: apiValue.sendOriginalQuestion,
            }
          : undefined
        // The sentinel VALUE never enters the proof: only its bounded digest proves
        // which value the store holds.
        const sentinelDigest = createHash('sha256').update(sentinel).digest('hex').slice(0, 16)
        record('f3-host-seed', {
          namespace: apiNamespace,
          api,
          revisions,
          credentialReference: 'DEEPSEEK_API_KEY',
          sentinelDigest,
        })
      } catch (error) {
        record('f3-host-seed-failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })()
  }

  if (scenario === 'f1-shell') {
    const sessionId = process.env.C1_F1_SESSION_ID
    const cwd = process.env.C1_F1_SESSION_CWD
    const otherSessionId = process.env.C1_F1_OTHER_SESSION_ID
    if (sessionId === undefined || cwd === undefined) {
      throw new Error('m4-c1-host-work: f1-shell requires its isolated Session id and Host cwd')
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: { provider: 'c1-qualification', model: 'c1' },
    })
    ctx.effect(() => () => handle.dispose())
    record('f1-host-session-created', {
      sessionId: String(handle.agent.id),
      cwd: ctx.workingDirectory.get(handle.agent.session),
    })
    if (otherSessionId !== undefined) {
      const otherHandle = await ctx.agents.create({
        sessionId: SessionId(otherSessionId),
        meta: { cwd },
        agentOptions: { provider: 'c1-qualification', model: 'c1' },
      })
      ctx.effect(() => () => otherHandle.dispose())
      record('f1-host-other-session-created', {
        sessionId: String(otherHandle.agent.id),
        cwd: ctx.workingDirectory.get(otherHandle.agent.session),
      })
    }
  }

  if (scenario === 'command-file-receipt') {
    const sessionId = process.env.C1_CFR_SESSION_ID
    const cwd = process.env.C1_CFR_SESSION_CWD
    if (sessionId === undefined || sessionId === '' || cwd === undefined || cwd === '') {
      throw new Error('m4-c1-host-work: command-file-receipt requires its isolated Session id and Host cwd')
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: { provider: 'c1-qualification', model: 'c1' },
    })
    ctx.effect(() => () => handle.dispose())
    record('cfr-host-session-created', {
      sessionId: String(handle.agent.id),
      cwd: ctx.workingDirectory.get(handle.agent.session),
    })
    // Describe ONE admitted durable block in the exact submission order. A
    // FILE is read through the official Host attachment authority (the SAME
    // `readFileStream` the F4 probe uses); an IMAGE records its admitted
    // durable metadata only.
    const describeBlock = async (block, order) => {
      if (block?.type === 'file' && block.attachment?.attachmentId !== undefined) {
        const digest = createHash('sha256')
        let bytes = 0
        let chunks = 0
        for await (const chunk of ctx.attachments.readFileStream(block.attachment)) {
          bytes += chunk.byteLength
          chunks += 1
          digest.update(chunk)
        }
        return {
          order,
          type: 'file',
          attachmentId: block.attachment.attachmentId,
          name: block.attachment.name,
          refBytes: block.attachment.bytes,
          bytes,
          chunks,
          sha256: digest.digest('hex'),
        }
      }
      if (block?.type === 'image' && block.attachment?.attachmentId !== undefined) {
        return {
          order,
          type: 'image',
          attachmentId: block.attachment.attachmentId,
          mediaType: block.attachment.mediaType,
          width: block.attachment.width,
          height: block.attachment.height,
          bytes: block.attachment.bytes,
        }
      }
      return { order, type: typeof block?.type === 'string' ? block.type : 'unknown', unsupported: true }
    }
    const runInvocation = async (name, invocation) => {
      const attachments = []
      for (let index = 0; index < invocation.attachments.length; index += 1) {
        attachments.push(await describeBlock(invocation.attachments[index], index))
      }
      record('cfr-command-invocation', {
        command: name,
        sessionId: String(invocation.agent.id),
        commandId: String(invocation.commandId),
        args: invocation.rawInput,
        attachments,
      })
      if (attachments.some(entry => entry.unsupported === true)) {
        return { kind: 'error', text: 'unsupported command attachment' }
      }
      return { kind: 'success', text: 'file verified' }
    }
    // The test-only Host command declaration: `attachments: true` is the ONE
    // official declaration a real command FILE delivery requires. It is
    // registered only in this isolated C1 Host context, never the product
    // profile.
    ctx.effect(() => ctx.commands.register({
      name: 'files',
      description: 'C1 command FILE receipt proof',
      input: { hint: '<task>', attachments: true },
      handler: invocation => runInvocation('files', invocation),
    }))
    // The negative control: a genuine Host command that does NOT declare
    // attachment support. A FILE-bearing submission must be refused by the
    // composer and never reach this handler.
    ctx.effect(() => ctx.commands.register({
      name: 'no-files',
      description: 'C1 command without attachment support',
      input: { hint: '<task>' },
      handler: invocation => runInvocation('no-files', invocation),
    }))
  }

  if (scenario === 'f4-file') {
    const sessionId = process.env.C1_F4_SESSION_ID
    const cwd = process.env.C1_F4_SESSION_CWD
    if (sessionId === undefined || sessionId === '' || cwd === undefined || cwd === '') {
      throw new Error('m4-c1-host-work: f4-file requires its isolated Session id and Host cwd')
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId(sessionId),
      meta: { cwd },
      agentOptions: { provider: 'c1-qualification', model: 'c1' },
    })
    ctx.effect(() => () => handle.dispose())
    record('f4-host-session-created', {
      sessionId: String(handle.agent.id),
      cwd: ctx.workingDirectory.get(handle.agent.session),
    })
    // Test-only Host attachment probe. The smoke writes `{sessionId, marker}`
    // into its private C1 work root; this fixture resolves the EXACT Agent and
    // durable `user/message`, then reads the stored bytes through the official
    // Host `ctx.attachments.readFileStream` authority. It never accepts a path
    // or raw bytes from the smoke.
    const probeDir = process.env.C1_F4_PROBE_DIR
    if (probeDir !== undefined && probeDir !== '') {
      const seen = new Set()
      const fileBlockOf = content => Array.isArray(content)
        ? content.find(block => block?.type === 'file' && block.attachment?.attachmentId !== undefined)
        : undefined
      const textOfContent = content => Array.isArray(content)
        ? content.map(block => block?.type === 'text' && typeof block.text === 'string' ? block.text : '').join('')
        : ''
      const runProbe = async request => {
        const marker = typeof request.marker === 'string' ? request.marker : undefined
        const requestedSession = typeof request.sessionId === 'string' ? request.sessionId : undefined
        if (marker === undefined || requestedSession === undefined) {
          record('f4-file-probe', { error: 'request-shape' })
          return
        }
        const agent = ctx.agents.get(SessionId(requestedSession))
        if (agent === undefined) {
          record('f4-file-probe', { marker, sessionId: requestedSession, error: 'no-exact-agent' })
          return
        }
        if (String(agent.id) !== requestedSession) {
          record('f4-file-probe', { marker, sessionId: requestedSession, error: 'agent-identity-mismatch', agentId: String(agent.id) })
          return
        }
        const event = agent.session.snapshotEvents().find(candidate => candidate.type === 'user/message'
          && textOfContent(candidate.data?.content).includes(marker)
          && fileBlockOf(candidate.data?.content) !== undefined)
        const ref = event === undefined ? undefined : fileBlockOf(event.data.content)?.attachment
        if (ref === undefined) {
          record('f4-file-probe', { marker, sessionId: requestedSession, error: 'no-durable-file-message' })
          return
        }
        const attachments = ctx.get('attachments')
        const digest = createHash('sha256')
        let bytes = 0
        let chunks = 0
        for await (const chunk of attachments.readFileStream(ref)) {
          bytes += chunk.byteLength
          chunks += 1
          digest.update(chunk)
        }
        record('f4-file-probe', {
          marker,
          sessionId: requestedSession,
          attachmentId: ref.attachmentId,
          name: ref.name,
          refBytes: ref.bytes,
          bytes,
          chunks,
          sha256: digest.digest('hex'),
        })
      }
      const timer = setInterval(() => {
        let names
        try {
          names = readdirSync(probeDir)
        } catch {
          return
        }
        for (const name of names) {
          if (!name.endsWith('.json') || seen.has(name)) continue
          seen.add(name)
          let request
          try {
            request = JSON.parse(readFileSync(join(probeDir, name), 'utf8'))
          } catch (error) {
            record('f4-file-probe', { request: name, error: error instanceof Error ? error.message : String(error) })
            continue
          }
          runProbe(request).catch(error => {
            record('f4-file-probe', { marker: request?.marker, error: error instanceof Error ? error.message : String(error) })
          })
        }
      }, 20)
      ctx.effect(() => () => clearInterval(timer))
    }
  }

  // Real Agent status transitions are Host facts, not a boolean this fixture
  // invents. `agent/status` is the official runtime event; the durable
  // Session events remain the smoke's final authority.
  ctx.on('agent/status', payload => {
    const statusFields = {
      agentId: payload?.agent?.id === undefined ? undefined : String(payload.agent.id),
      agentStatus: payload?.status,
    }
    if (scenario === 'f1-shell') {
      const descriptors = ctx.settings.describe()
      const settingsNamespace = process.env.C1_F1_SETTINGS_NAMESPACE ?? 'tui-app'
      const tui = descriptors.find(descriptor => descriptor.ns === settingsNamespace)
      const value = tui?.value !== null && typeof tui?.value === 'object'
        ? tui.value.localShellSandbox
        : undefined
      record('f1-host-effective-shell-policy', {
        ...statusFields,
        settingsNamespaces: descriptors.map(descriptor => descriptor.ns),
        localShellSandbox: value,
      })
    }
    record('agent-status', statusFields)
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
        stack: error instanceof Error
          ? String(error.stack ?? '').split('\n').slice(0, 12).join(' | ').slice(0, 2000)
          : undefined,
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
  if (scenario === 'goal-armed' || scenario === 'goal-round' || scenario === 'maintenance' || scenario === 'schedule') {
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
    if (scenario === 'goal-armed' || scenario === 'goal-round') {
      // Every durable Goal transition is recorded as the official Host event,
      // never as a value this fixture invents. The armed case needs the proof
      // that nothing moved the Goal; the round case needs the automatic
      // `round-limit` block that ends the armed state.
      ctx.on('goal/changed', ({ agent, change }) => {
        record('goal-changed', {
          agentId: String(agent.id),
          goalId: String(change?.ref?.id ?? ''),
          revision: change?.goal?.revision ?? change?.ref?.revision,
          operation: change?.operation,
          goalPhase: change?.goal?.phase,
          activation: change?.goal?.activation,
          roundsStarted: change?.goal?.roundsStarted,
          blockCode: change?.goal?.blockedReason?.code,
        })
      })
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
        // rc.1 Schedule API: `create(request, actorSessionId)` with a typed
        // `timing` selector, and `edit({ id, action: 'delete' }, actorSessionId)`
        // for removal. The old `create(sessionId, {...after_seconds})` /
        // `delete({sessionId,id})` shape no longer exists.
        schedule.create({
          prompt: 'M4-C2-A qualification schedule task',
          title: 'M4-C2-A qualification schedule task',
          timing: { kind: 'after', after_seconds: 600 },
        }, agent.id).then(view => {
          record('schedule-created', {
            agentId: String(agent.id),
            scheduleId: String(view.id),
            status: 'active',
          })
          const deleteBarrier = join(root, 'schedule.delete')
          const timer = setInterval(() => {
            if (!existsSync(deleteBarrier)) return
            clearInterval(timer)
            schedule.edit({ id: view.id, action: 'delete' }, agent.id).then(
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
  if (scenario === 'f7a-authorization') {
    // F7A qualification flows. The official `ctx.authorization` seam owns the
    // attempt, the mutual exclusion and the credential write; this row only
    // provides the PROVIDER bodies (the plugin boundary the seam is designed
    // around). Every step records a proof line; a secret ANSWER is never
    // recorded, only the fact that the exact prompt was answered.
    const authorization = ctx.reflect.get('authorization')
    if (authorization === undefined || typeof authorization.registerFlow !== 'function') {
      throw new Error('m4-c1-host-work: f7a-authorization requires the official ctx.authorization service')
    }
    const barrier = name => join(root, name)
    const waitFor = async (name, signal) => {
      await waitForBarrier(barrier(name), signal)
    }
    const holdIfPresent = async (holdName, releaseName, phase, signal, run) => {
      if (!existsSync(barrier(holdName))) return
      record(`f7a-${phase}-held`, { run })
      await waitFor(releaseName, signal)
      record(`f7a-${phase}-released`, { run })
    }
    const answer = async (session, prompt) => {
      const value = await session.prompt(prompt)
      // The value may be a secret: record only the prompt kind, never the text.
      record('f7a-prompt-answered', { kind: prompt.kind, message: prompt.message })
      return value
    }
    let mainRunCount = 0
    const runMain = async session => {
      mainRunCount += 1
      const run = mainRunCount
      record('f7a-run-start', { key: 'llm-pi-ai/f7a-main', run, method: session.method })
      session.notify({ message: 'F7A sign-in', url: 'https://provider.example/f7a', code: 'F7A-CODE-1' })
      await holdIfPresent('f7a-hold-before-prompt', 'f7a-release-before-prompt', 'before-prompt', session.signal, run)
      if (existsSync(barrier('f7a-withdraw'))) {
        const controller = new AbortController()
        const losing = session.prompt({
          kind: 'text',
          message: 'F7A losing prompt',
          signal: controller.signal,
        }).then(
          () => 'answered',
          () => 'withdrawn',
        )
        // Retire the losing prompt of the race, exactly as a real flow does;
        // the prompt-level withdrawal must NOT cancel the whole attempt.
        setTimeout(() => controller.abort(), 50)
        const outcome = await losing
        record('f7a-withdrawn-prompt', { outcome, run })
        if (outcome !== 'withdrawn') throw new Error('m4-c1-host-work: the losing F7A prompt was not withdrawn')
        await answer(session, { kind: 'text', message: 'F7A winning prompt' })
      }
      await answer(session, { kind: 'secret', message: 'F7A secret code', placeholder: 'F7A-SECRET' })
      const label = await answer(session, { kind: 'text', message: 'F7A account label' })
      const choice = await answer(session, {
        kind: 'select',
        message: 'F7A choose account',
        options: [{ id: 'primary', label: 'Primary' }, { id: 'secondary', label: 'Secondary' }],
      })
      await session.commit({
        kind: 'grant',
        payload: { provider: 'f7a-main', label, choice },
      })
      record('f7a-committed', { key: 'llm-pi-ai/f7a-main', run })
      await holdIfPresent('f7a-hold-after-commit', 'f7a-release-after-commit', 'after-commit', session.signal, run)
      record('f7a-run-end', { key: 'llm-pi-ai/f7a-main', run })
    }
    const runOther = async session => {
      record('f7a-run-start', { key: 'llm-pi-ai/f7a-other', method: session.method })
      session.notify({ message: 'F7A other sign-in', url: 'https://provider.example/f7a-other' })
      await answer(session, { kind: 'secret', message: 'F7A other secret' })
      await session.commit({
        kind: 'grant',
        payload: { provider: 'f7a-other' },
      })
      record('f7a-committed', { key: 'llm-pi-ai/f7a-other' })
      record('f7a-run-end', { key: 'llm-pi-ai/f7a-other' })
    }
    const register = (id, label, run) => {
      ctx.effect(() => authorization.registerFlow({
        key: credentialKey('llm-pi-ai', id),
        label,
        methods: [{ id: 'device', label: 'Continue in the browser' }],
        async run(session) {
          try {
            await run(session)
          } catch (error) {
            record('f7a-run-failed', {
              key: `llm-pi-ai/${id}`,
              aborted: session.signal.aborted,
              code: typeof error?.code === 'string' ? error.code : undefined,
            })
            throw error
          }
        },
      }), `f7a-authorization-${id}`)
    }
    register('f7a-main', 'F7A main', runMain)
    register('f7a-other', 'F7A other', runOther)
    // The committed flow records are fixture products on the shared lane's ONE
    // dshHome: snapshot and restore them through the official store at row
    // disposal so no later case inherits them (same lifecycle as the F7B
    // seeds). The case asserts the restored listing after shutdown.
    const credentials = ctx.reflect.get('credentials')
    if (credentials === undefined || typeof credentials.modifyRecord !== 'function') {
      throw new Error('m4-c1-host-work: f7a-authorization requires the official ctx.credentials service')
    }
    const flowKeys = [credentialKey('llm-pi-ai', 'f7a-main'), credentialKey('llm-pi-ai', 'f7a-other')]
    const baselineKeys = (await credentials.listRecords()).map(entry => String(entry.key)).sort()
    const baseline = []
    for (const key of flowKeys) {
      baseline.push({ key, pre: await credentials.readRecord(key) })
    }
    record('f7a-flows-registered', { keys: ['llm-pi-ai/f7a-main', 'llm-pi-ai/f7a-other'], baselineKeys })
    ctx.effect(() => async () => {
      for (const { key, pre } of baseline) {
        if (pre === undefined) await credentials.deleteRecord(key)
        else await credentials.modifyRecord(key, async () => pre)
      }
      const restored = await credentials.listRecords()
      record('f7a-records-restored', {
        baselineKeys,
        keys: restored.map(entry => String(entry.key)).sort(),
      })
    }, 'f7a-records-restorer')
  }

  if (scenario === 'f7b-credential-records') {
    // F7B stored-record qualification. The OFFICIAL `ctx.credentials` store is
    // the only authority: every seed goes through its read-modify-write path,
    // the fixture never edits the YAML file and never mounts a second
    // credential service. Sentinels live in the record payloads only; a
    // qualification proof line records keys/kinds, never a value.
    const credentials = ctx.reflect.get('credentials')
    if (credentials === undefined || typeof credentials.modifyRecord !== 'function') {
      throw new Error('m4-c1-host-work: f7b-credential-records requires the official ctx.credentials service')
    }
    const seeds = [
      {
        key: credentialKey('llm-pi-ai', 'f7b-grant'),
        record: { kind: 'grant', payload: { token: 'f7b-grant-token-sentinel-20261112' } },
      },
      {
        key: credentialKey('llm-pi-ai', 'f7b-api-key'),
        record: {
          kind: 'api-key',
          key: 'f7b-api-key-value-sentinel-20261112',
          env: { F7B_ENV: 'f7b-env-value-sentinel-20261112' },
        },
      },
      {
        key: credentialKey('other-plugin', 'f7b-orphan'),
        record: { kind: 'grant', payload: { token: 'f7b-orphan-token-sentinel-20261112' } },
      },
      {
        // The DeepSeek Account grant: seeded so the smoke can prove the generic
        // records list EXCLUDES it while the Account page owns it.
        key: credentialKey('deepseek-account-platform', 'default'),
        record: { kind: 'grant', payload: { token: 'f7b-account-token-sentinel-20261112' } },
      },
    ]
    // The shared lane reuses ONE dshHome across cases: snapshot every seed key
    // BEFORE its write so disposal can restore the exact pre-case record state
    // through the SAME official authority (a pre-existing record is written
    // back, a fixture-only record is deleted). Every path that reaches a clean
    // Host shutdown — case success, assertion failure, exception — disposes
    // this row, and the restored listing is recorded so the case can assert a
    // zero record delta before the next case boots.
    const baselineKeys = (await credentials.listRecords()).map(entry => String(entry.key)).sort()
    const baseline = []
    for (const seed of seeds) {
      baseline.push({ key: seed.key, pre: await credentials.readRecord(seed.key) })
    }
    for (const seed of seeds) {
      await credentials.modifyRecord(seed.key, async () => seed.record)
    }
    const listed = await credentials.listRecords()
    record('f7b-records-seeded', {
      keys: listed.map(entry => String(entry.key)).sort(),
      kinds: listed.map(entry => `${String(entry.key)}:${entry.kind}`).sort(),
      baselineKeys,
    })
    // The REAL official record-updated event is the observable commit proof the
    // smoke waits for after a delete (one key, never a payload).
    ctx.effect(() => ctx.on('credentials/record-updated', (key) => {
      record('f7b-record-updated', { key: String(key) })
    }), 'f7b-record-updated-observer')
    ctx.effect(() => async () => {
      for (const { key, pre } of baseline) {
        if (pre === undefined) await credentials.deleteRecord(key)
        else await credentials.modifyRecord(key, async () => pre)
      }
      const restored = await credentials.listRecords()
      record('f7b-records-restored', {
        baselineKeys,
        keys: restored.map(entry => String(entry.key)).sort(),
      })
    }, 'f7b-records-restorer')
  }

  if (scenario === 'session-policy-f8' || scenario === 'session-policy-f8-replay') {
    // M6-1 F8 exact-Session policy qualification. The OFFICIAL `ctx.approval`
    // and `ctx.sandboxPolicy` services are the only policy authority: the
    // seeds and the replayed facts are computed from THEIR projections, never
    // from a TUI mirror. The fixture records policy VALUES only (no session
    // paths, no agent objects).
    const approval = ctx.reflect.get('approval')
    const sandboxPolicy = ctx.reflect.get('sandboxPolicy')
    if (approval === undefined || sandboxPolicy === undefined) {
      throw new Error('m4-c1-host-work: session-policy-f8 requires the official ctx.approval and ctx.sandboxPolicy services')
    }
    const sessionA = process.env.C1_F8_SESSION_A
    const sessionB = process.env.C1_F8_SESSION_B
    const cwd = process.env.C1_F8_CWD
    if (sessionA === undefined || sessionA === '' || cwd === undefined || cwd === '') {
      throw new Error('m4-c1-host-work: session-policy-f8 requires its isolated Session ids and Host cwd')
    }
    const factsOf = session => ({
      approvalOverride: approval.overrideOf(session) ?? null,
      approvalEffective: approval.overrideOf(session) ?? approval.config?.policy ?? 'ask',
      sandboxOverride: sandboxPolicy.overrideOf(session) ?? null,
      sandboxEffective: sandboxPolicy.resolve({ session }).mode,
    })
    if (scenario === 'session-policy-f8-replay') {
      // DURABLE REPLAY: a FRESH Host loads the persisted Session log through
      // the official registry and the projections re-derive the facts.
      const resumed = await ctx.agents.resume({
        resumeSessionId: SessionId(sessionA),
        agentOptions: { provider: 'c1-qualification', model: 'c1' },
      })
      ctx.effect(() => () => resumed.dispose())
      record('f8-replayed', {
        sessionId: String(resumed.agent.id),
        ...factsOf(resumed.agent.session),
      })
    } else {
      const officialApproval = await import('@deepseek-ai/dsh-user-approval')
      const officialSandbox = await import('@deepseek-ai/dsh-sandbox-policy')
      const handles = []
      for (const sessionId of [sessionA, sessionB]) {
        if (sessionId === undefined || sessionId === '') {
          throw new Error('m4-c1-host-work: session-policy-f8 requires BOTH isolated Session ids')
        }
        const handle = await ctx.agents.create({
          sessionId: SessionId(sessionId),
          meta: { cwd },
          agentOptions: { provider: 'c1-qualification', model: 'c1' },
        })
        ctx.effect(() => () => handle.dispose())
        handles.push(handle)
      }
      const [a, b] = handles
      // A keeps the deployment defaults (approval ask / sandbox default); B
      // carries an INDEPENDENT approval never and a workspace-write sandbox
      // override, written through the OFFICIAL durable event path.
      officialApproval.setApprovalPolicy(b.agent.session, 'never')
      officialSandbox.setSandboxMode(b.agent.session, 'workspace-write')
      // Observe the official durable knob events (type + policy/mode only).
      ctx.effect(() => ctx.on('session/event', (session, event) => {
        if (event?.type !== 'approval/policy' && event?.type !== 'sandbox/mode') return
        record('f8-knob-event', {
          sessionId: String(session.id),
          type: event.type,
          value: event.data?.policy ?? event.data?.mode ?? null,
        })
      }), 'f8-knob-observer')
      record('f8-seeded', {
        sessions: [
          { sessionId: String(a.agent.id), ...factsOf(a.agent.session) },
          { sessionId: String(b.agent.id), ...factsOf(b.agent.session) },
        ],
      })
    }
  }
}
