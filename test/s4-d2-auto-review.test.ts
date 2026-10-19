/**
 * S4-D2 B03 — Auto Review Host qualification over the real rc.2 Optional
 * bundle patch (implementation plan §5 D2-2).
 *
 * The REAL `@deepseek-ai/dsh-experimental-auto-review` plugin installs its
 * `tools/pre-execute` gate and `permissionPresets.registerAuto` contribution;
 * a scripted LLM transport answers both the agent turn and the fixed review
 * prompt. A REAL `write` tool body is the observable sink: an allowed call
 * creates the file, a refused/aborted/errored call executes no body at all and
 * leaves a durable `tool/result` error.
 * @module @xmoon76/dsh-pi-tui/s4-d2-auto-review.test
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DirectPermissionConfig } from '../src/runtime/direct/config-direct.ts'
import {
  S4_D2_BUNDLE_IDS,
  profileSelectsBundle,
  skippedInstallationReason,
  startS4D2Host,
  type S4D2BundleId,
} from './support/s4-d2-optional-bundle-fixture.ts'

const B03 = '@deepseek-ai/dsh-experimental-auto-review' satisfies S4D2BundleId
const skip = skippedInstallationReason([B03])

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

interface ToolCallScript {
  readonly kind: 'tool'
  readonly name: string
  readonly arguments: string
  readonly callId: string
}

type AgentScript = ToolCallScript | { readonly kind: 'text'; readonly text: string }
type ReviewScript = 'allow' | 'deny' | 'error'

/** Deterministic LLM transport: one queue for agent turns, one for reviews. */
class ScriptedAdapter extends LlmAdapter {
  readonly agentScripts: AgentScript[] = []
  readonly reviews: ReviewScript[] = []
  readonly reviewRequests: GenerateOptions[] = []
  readonly modelRequests: GenerateOptions[] = []
  gate: Promise<void> | undefined
  gateRelease: (() => void) | undefined

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    if ((options.system ?? '').includes('REVIEW_POLICY')) {
      this.reviewRequests.push(options)
      if (this.gate !== undefined) {
        // A held review must still settle when the Host is torn down: the
        // real Auto integration aborts its lifecycle signal and awaits drain.
        await Promise.race([
          this.gate,
          new Promise<never>((_resolve, reject) => {
            const signal = options.signal
            if (signal === undefined) return
            if (signal.aborted) reject(new Error('review aborted'))
            else signal.addEventListener('abort', () => reject(new Error('review aborted')), { once: true })
          }),
        ])
      }
      options.signal?.throwIfAborted()
      const decision = this.reviews.shift() ?? 'allow'
      if (decision === 'error') throw new Error('scripted reviewer failure')
      const text = decision === 'allow'
        ? '{"risk":"low","decision":"allow"}'
        : '{"risk":"high","decision":"deny","reason":"scripted high risk"}'
      for (const chunk of textChunks(text)) yield chunk
      return
    }
    this.modelRequests.push(options)
    const script = this.agentScripts.shift()
    if (script === undefined) {
      yield* textChunks('done')
      return
    }
    if (script.kind === 'text') {
      yield* textChunks(script.text)
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield {
      type: 'tool-call-delta',
      index: 0,
      id: script.callId as never,
      name: script.name,
      argumentsDelta: script.arguments,
    }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: script.callId as never,
        name: script.name,
        arguments: script.arguments,
      },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function resultText(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return (result.content ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join('')
}

test('B03 Auto Review: native allow/deny/ask/error and durable body evidence', { skip }, async t => {
  const host = await startS4D2Host(t, { bundles: [B03], presets: false })
  const adapter = new ScriptedAdapter()
  host.ctx.llm.registerAdapter(['scripted'], adapter)
  const approvalRequests: Array<{ outcome(): void }> = []
  let approvalDecision: 'allowed-once' | 'rejected' = 'rejected'
  host.ctx.on('approval/request', async () => {
    approvalRequests.push({ outcome: () => {} })
    return approvalDecision
  })

  const autoCatalog = host.ctx.get('permissionPresets') as {
    names: readonly string[]
    set(session: unknown, name: string): void
    current(session: unknown): string | null
  }
  assert.ok(autoCatalog.names.includes('auto'), 'the real Auto preset is advertised only while B03 is mounted')

  const work = join(host.root, 'work')

  async function scenario(id: string, input: {
    readonly review: ReviewScript
    readonly approval?: 'allowed-once' | 'rejected' | 'never'
    readonly script?: AgentScript[]
  }): Promise<{ agent: Agent; file: string; toolResult: Record<string, unknown> | undefined }> {
    const file = join(work, `${id}.txt`)
    const agent = await host.createAgent(SessionId(`s4-d2-b03-${id}`), {
      provider: 'scripted',
      model: 'review-model',
      cwd: work,
    })
    autoCatalog.set(agent.session, 'auto')
    assert.equal(autoCatalog.current(agent.session), 'auto')
    if (input.approval === 'never') {
      const approval = host.ctx.get('approval') as { setPolicy(agent: unknown, policy: 'never'): void }
      approval.setPolicy(agent, 'never')
    }
    approvalDecision = input.approval === 'allowed-once' ? 'allowed-once' : 'rejected'
    const scripts = input.script ?? [
      {
        kind: 'tool' as const,
        name: 'write',
        arguments: JSON.stringify({ file_path: file, content: `body:${id}` }),
        callId: `call-${id}`,
      },
      { kind: 'text' as const, text: 'turn complete' },
    ]
    adapter.agentScripts.push(...scripts)
    adapter.reviews.push(input.review)
    approvalRequests.length = 0
    await send(agent, `scenario ${id}`)
    const events = agent.session.snapshotEvents() as readonly {
      readonly type: string
      readonly data?: Record<string, unknown>
    }[]
    const resultEvent = events.find(event => event.type === 'tool/result'
      && (event.data?.['message'] as { toolCallId?: string } | undefined)?.toolCallId === `call-${id}`)
    return { agent, file, toolResult: resultEvent?.data as Record<string, unknown> | undefined }
  }

  // 1. Low-risk ALLOW: the body really runs.
  const allowed = await scenario('allow', { review: 'allow' })
  assert.equal(existsSync(allowed.file), true, 'an allowed native call executes its body')
  assert.equal(adapter.reviewRequests.length >= 1, true, 'the real review prompt ran')

  // 2. High-risk DENY under `never`: final denial, no user prompt, no body.
  approvalRequests.length = 0
  const denied = await scenario('deny', { review: 'deny', approval: 'never' })
  assert.equal(existsSync(denied.file), false, 'a denied body never executes')
  assert.equal(approvalRequests.length, 0, 'never policy never asks the user')
  assert.match(JSON.stringify(denied.toolResult ?? {}), /Auto review rejected|AutoReviewDeniedError/i)

  // 3. High-risk DENY under `ask`: a REAL user approval is requested and a
  //    rejection keeps the body at zero.
  const rejected = await scenario('ask-reject', { review: 'deny', approval: 'rejected' })
  assert.equal(approvalRequests.length, 1, 'the deny reached the user approval seat exactly once')
  assert.equal(existsSync(rejected.file), false, 'a user rejection keeps the body unexecuted')
  const rejectedEvents = rejected.agent.session.snapshotEvents() as readonly { readonly type: string }[]
  assert.ok(rejectedEvents.some(event => event.type === 'approval/asked'))
  assert.ok(rejectedEvents.some(event => event.type === 'approval/decided'))

  // 4. The same ask policy grants once: the body then runs, proving the deny is
  //    not a blanket refusal of the tool.
  const granted = await scenario('ask-allow', { review: 'deny', approval: 'allowed-once' })
  assert.equal(approvalRequests.length, 1)
  assert.equal(existsSync(granted.file), true, 'an explicit user grant lets the reviewed body run')

  // 5. Reviewer failure fails closed: no body and no user prompt.
  approvalRequests.length = 0
  const errored = await scenario('error', { review: 'error', approval: 'allowed-once' })
  assert.equal(existsSync(errored.file), false, 'a reviewer failure never executes the body')
  assert.equal(approvalRequests.length, 0, 'a reviewer failure denies before the approval seat')
  assert.match(JSON.stringify(errored.toolResult ?? {}), /Auto review of tool|failed/i)

  // The exact 14 identities remain the frozen set.
  assert.equal(S4_D2_BUNDLE_IDS.length, 14)
})

test('B03 Auto Review: started PTC inner tools are reviewed; the outer run_code is not', { skip }, async t => {
  const host = await startS4D2Host(t, { bundles: [B03], presets: true })
  const adapter = new ScriptedAdapter()
  host.ctx.llm.registerAdapter(['scripted'], adapter)
  const approval = host.ctx.get('approval') as { setPolicy(agent: unknown, policy: 'never'): void }
  const presets = host.ctx.get('agentPresets') as {
    select(agent: Agent, preset: string): Promise<unknown>
  }
  const permissions = host.ctx.get('permissionPresets') as {
    set(session: unknown, name: string): void
    current(session: unknown): string | null
  }
  const work = join(host.root, 'work')

  async function ptcScenario(id: string, review: ReviewScript, program?: string): Promise<{ agent: Agent; file: string }> {
    const file = join(work, `${id}.txt`)
    const agent = await host.createAgent(SessionId(`s4-d2-b03-ptc-${id}`), {
      provider: 'scripted',
      model: 'review-model',
      cwd: work,
    })
    await presets.select(agent, 'ptc')
    assert.ok(host.hasTool('run_code', agent), 'the ptc preset exposes the official run_code transport')
    permissions.set(agent.session, 'auto')
    approval.setPolicy(agent, 'never')
    const code = program ?? `return await tools.write(${JSON.stringify({ file_path: file, content: `inner:${id}` })})`
    adapter.agentScripts.push(
      { kind: 'tool', name: 'run_code', arguments: JSON.stringify({ code, description: `inner write ${id}` }), callId: `ptc-${id}` },
      { kind: 'text', text: 'ptc complete' },
    )
    adapter.reviews.push(review)
    adapter.reviewRequests.length = 0
    await send(agent, `pc scenario ${id}`)
    return { agent, file }
  }

  const allowed = await ptcScenario('allow', 'allow')
  assert.equal(existsSync(allowed.file), true, 'the reviewed inner tool body ran')
  assert.equal(adapter.reviewRequests.length, 1, 'exactly the inner started tool was reviewed (the outer run_code was not)')
  const allowedEvents = allowed.agent.session.snapshotEvents() as readonly { readonly type: string; readonly data?: Record<string, unknown> }[]
  assert.ok(allowedEvents.some(event => event.type === 'tool/ptc-dispatch-start'),
    'the official PTC dispatch start was recorded before the inner tool ran')

  const denied = await ptcScenario('deny', 'deny')
  assert.equal(existsSync(denied.file), false, 'a denied inner body never executes')
  assert.equal(adapter.reviewRequests.length, 1, 'the denied scenario also reviewed only the inner call')
  const deniedEvents = denied.agent.session.snapshotEvents() as readonly { readonly type: string; readonly data?: Record<string, unknown> }[]
  const ptcDenial = deniedEvents.filter(event => event.type === 'tool/ptc-dispatch')
  assert.ok(ptcDenial.length > 0, 'the inner denial produced a durable PTC dispatch record')
  assert.match(JSON.stringify(ptcDenial), /Auto review rejected|AUTO_REVIEW_DENIED/i)

  // NEGATIVE boundary: a run_code program that performs no inner tool call is
  // NOT Auto-reviewed. The outer transport is not the reviewed object, so
  // arbitrary JS effects outside the inner-tool bridge carry no Auto claim.
  const plain = await ptcScenario('plain', 'deny', 'return 6 * 7')
  assert.equal(existsSync(plain.file), false)
  assert.equal(adapter.reviewRequests.length, 0, 'the outer run_code and non-tool JS effects are not reviewed')
})

test('B03 Auto Review: teardown migrates live Auto sessions to Full access and drains in-flight reviews', { skip }, async t => {
  let host = await startS4D2Host(t, { bundles: [B03], presets: false })
  const adapter = new ScriptedAdapter()
  host.ctx.llm.registerAdapter(['scripted'], adapter)
  const permissions = host.ctx.get('permissionPresets') as {
    names: readonly string[]
    set(session: unknown, name: string): void
    current(session: unknown): string | null
  }

  const autoAgent = await host.createAgent(SessionId('s4-d2-b03-auto'), { provider: 'scripted', model: 'review-model', cwd: join(host.root, 'work') })
  const otherAgent = await host.createAgent(SessionId('s4-d2-b03-other'), { provider: 'scripted', model: 'review-model', cwd: join(host.root, 'work') })
  permissions.set(autoAgent.session, 'auto')
  assert.equal(permissions.current(autoAgent.session), 'auto')
  assert.equal(permissions.current(otherAgent.session), 'workspace-write', 'a non-Auto session starts at the composition default')

  // A held review: the tool call is waiting inside the REAL Auto gate.
  const heldFile = join(host.root, 'work', 'held.txt')
  adapter.gate = new Promise<void>(resolve => { adapter.gateRelease = resolve })
  adapter.agentScripts.push(
    { kind: 'tool', name: 'write', arguments: JSON.stringify({ file_path: heldFile, content: 'held' }), callId: 'held-call' },
    { kind: 'text', text: 'held complete' },
  )
  adapter.reviews.push('allow')
  const autoTurn = send(autoAgent, 'held turn')
  await waitFor(() => adapter.reviewRequests.length > 0 && adapter.gate !== undefined)

  // OFF: the official manager deselects the bundle (startup-only profile).
  const disabled = await host.pluginManager.setBundleEnabled(B03, false) as { application: string }
  assert.equal(disabled.application, 'restart-required')
  assert.equal(profileSelectsBundle(host.profileDir, B03), false)

  // RESTART = the official Host teardown: the auto-review integration migrates
  // every live Auto session before it drains, then a FRESH profile composition
  // no longer carries the Auto preset.
  const previousHome = process.env.DSH_HOME
  host = await host.restart()
  assert.equal(process.env.DSH_HOME, previousHome)
  await autoTurn
  assert.equal(existsSync(heldFile), false, 'the in-flight reviewed body never executes after teardown')

  const presetEvents = (agent: Agent): readonly string[] =>
    (agent.session.snapshotEvents() as readonly { readonly type: string; readonly data?: { readonly preset?: string } }[])
      .filter(event => event.type === 'permission/preset')
      .map(event => event.data?.preset ?? '')
  assert.equal(presetEvents(autoAgent).at(-1), 'danger-full-access',
    'the official teardown migrated the live Auto session to Full access')
  assert.equal(presetEvents(otherAgent).at(-1), 'workspace-write',
    'a session that was not Auto keeps its permission identity')

  const restarted = host.ctx.get('permissionPresets') as { names: readonly string[] }
  assert.equal(restarted.names.includes('auto'), false, 'the restarted composition no longer advertises Auto')
})

/** Poll one in-process condition a bounded number of event-loop turns. */
async function waitFor(condition: () => boolean, turns = 200): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (condition()) return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not settle')
}

test('B03 /permission: the real Auto preset is visible and applies through the Direct port', { skip }, async t => {
  const host = await startS4D2Host(t, { bundles: [B03], presets: false })
  const sessionId = 's4-d2-b03-permission'
  const agent = await host.createAgent(SessionId(sessionId), { provider: 'scripted', model: 'review-model', cwd: join(host.root, 'work') })
  const config = new DirectPermissionConfig(host.ctx as never, id => id === sessionId ? agent : undefined)
  assert.ok(config.presetNames().includes('auto'), 'the real composed catalog exposes Auto to the Direct port')
  assert.deepEqual(await config.applyPermissionPreset(sessionId, 'auto', new AbortController().signal), { kind: 'applied' })
  const permissions = host.ctx.get('permissionPresets') as { current(session: unknown): string | null }
  assert.equal(permissions.current(agent.session), 'auto', 'the official apply really selected Auto')
  assert.equal(config.approvalOverrideOf(sessionId), 'ask', 'the official Auto spec pinned the ask policy')
})

test('B03 /permission: without the bundle the Auto id is not offered and cannot be applied', { skip }, async t => {
  const host = await startS4D2Host(t, { bundles: [] })
  const sessionId = 's4-d2-b03-permission-off'
  const agent = await host.createAgent(SessionId(sessionId), { provider: 'scripted', model: 'review-model', cwd: join(host.root, 'work') })
  const config = new DirectPermissionConfig(host.ctx as never, id => id === sessionId ? agent : undefined)
  assert.equal(config.presetNames().includes('auto'), false, 'Auto is advertised only while the real integration is mounted')
  assert.deepEqual(await config.applyPermissionPreset(sessionId, 'auto', new AbortController().signal), { kind: 'unavailable', cause: 'permission' })
  const permissions = host.ctx.get('permissionPresets') as { current(session: unknown): string | null }
  assert.equal(permissions.current(agent.session), 'workspace-write', 'a refused apply never changes the session')
})
