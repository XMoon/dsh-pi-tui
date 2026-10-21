/**
 * S4-D2 B09/B10/B11 — Session Titles, Badge Skill and Ralph over the real
 * rc.2 Optional bundle patches (implementation plan §5 D2-5).
 * @module @xmoon76/dsh-pi-tui/s4-d2-projections-workflow.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import {
  createUserMessage,
  LlmAdapter,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { readSurfaceCatalog } from '../../../src/runtime/direct/surface-catalog.ts'
import {
  skippedInstallationReason,
  startS4D2Host,
  type S4D2BundleId,
} from '../../support/s4-d2-optional-bundle-fixture.ts'

const B09 = '@deepseek-ai/dsh-experimental-session-titles-bundle' satisfies S4D2BundleId
const B10 = '@deepseek-ai/dsh-experimental-badge-skill-bundle' satisfies S4D2BundleId
const B11 = '@deepseek-ai/dsh-experimental-ralph-bundle' satisfies S4D2BundleId

const skip09 = skippedInstallationReason([B09])
const skip10 = skippedInstallationReason([B10])
const skip11 = skippedInstallationReason([B11])

function resultText(result: { content?: readonly { type?: string; text?: string }[] }): string {
  return (result.content ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join('')
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  text = 'ok'
  title: (current: string | undefined, messages: string) => string = () => 'Untitled Session'
  readonly titleRequests: string[] = []
  readonly turns: string[] = []
  holdNextTitle: Promise<void> | undefined
  releaseTitle: (() => void) | undefined

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const system = options.system ?? ''
    const messages = JSON.stringify(options.messages)
    if (system.includes('Create a concise title')) {
      this.titleRequests.push(messages)
      if (this.holdNextTitle !== undefined) {
        const hold = this.holdNextTitle
        this.holdNextTitle = undefined
        await Promise.race([
          hold,
          new Promise<never>((_resolve, reject) => {
            const signal = options.signal
            if (signal === undefined) return
            if (signal.aborted) reject(new Error('title aborted'))
            else signal.addEventListener('abort', () => reject(new Error('title aborted')), { once: true })
          }),
        ])
      }
      options.signal?.throwIfAborted()
      const current = /"currentTitle":"([^"]+)"/u.exec(messages)?.[1]
      yield* textChunks(this.title(current, messages))
      return
    }
    this.turns.push(messages)
    yield* textChunks(this.text)
  }
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function waitFor(condition: () => boolean | Promise<boolean>, turns = 2000): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    if (await condition()) return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not settle')
}

test('Session Titles: real provider projection, manual precedence, late-title isolation and disable/restart', { skip: skip09 }, async t => {
  const host = await startS4D2Host(t, { bundles: [B09] })
  const adapter = new ScriptedAdapter()
  host.ctx.llm.registerAdapter(['scripted'], adapter)
  const titleService = host.ctx.get('sessionTitle') as {
    get(session: unknown): { title: string; source: { kind: string; provider?: string } } | undefined
    rename(session: unknown, title: string): unknown
  }
  const work = join(host.root, 'work')

  // First human turn: the all-prompts provider really generates through the
  // real session-title service (no local cache, no TUI rewrite).
  adapter.title = (_current, messages) =>
    messages.includes('Hold this title request') ? 'Held Alpha Title'
      : messages.includes('replacement') ? 'Replacement Title'
        : messages.includes('beta') ? 'Beta Project'
          : messages.includes('base provider') ? 'Base Provider Title'
            : 'Alpha Project'
  const first = await host.createAgent(SessionId('s4-d2-b09-first'), { provider: 'scripted', model: 'review-model', cwd: work })
  await send(first, 'Design the alpha project')
  await waitFor(() => titleService.get(first.session)?.title === 'Alpha Project')
  const generated = titleService.get(first.session)!
  assert.equal(generated.source.kind, 'provider')
  assert.equal(generated.source.provider, 'session-title-all-prompts-llm')

  // A later topic change re-generates through the same provider.
  await send(first, 'Now work on the beta project instead')
  await waitFor(() => titleService.get(first.session)?.title === 'Beta Project')

  // Manual /title wins by the real service precedence; later human turns must
  // not overwrite the pinned user identity.
  titleService.rename(first.session, 'Manual Title')
  await send(first, 'A follow-up acknowledgement')
  await waitFor(() => titleService.get(first.session)?.title === 'Manual Title')
  assert.equal(titleService.get(first.session)?.source.kind, 'user')

  // LATE TITLE ISOLATION: a held title result for session A never paints the
  // replacement session B.
  adapter.titleRequests.length = 0
  adapter.holdNextTitle = new Promise<void>(resolve => { adapter.releaseTitle = resolve })
  const held = await host.createAgent(SessionId('s4-d2-b09-held'), { provider: 'scripted', model: 'review-model', cwd: work })
  await send(held, 'Hold this title request')
  await waitFor(() => adapter.titleRequests.some(messages => messages.includes('Hold this title request')))
  // The user title is pinned, but the held automatic request still runs; the
  // important fact is that the projection of B is untouched by A's late work.
  const replacement = await host.createAgent(SessionId('s4-d2-b09-replacement'), { provider: 'scripted', model: 'review-model', cwd: work })
  await send(replacement, 'Design the replacement')
  await waitFor(() => titleService.get(replacement.session)?.title === 'Replacement Title')
  adapter.releaseTitle?.()
  await waitFor(() => titleService.get(held.session)?.title === 'Held Alpha Title')
  assert.equal(titleService.get(replacement.session)?.title, 'Replacement Title', 'the old session late title never paints the new session')

  // OFF + restart: the base first-prompt provider is restored; B09's provider
  // source must disappear from newly generated titles.
  const disabled = await host.pluginManager.setBundleEnabled(B09, false) as { application: string }
  assert.equal(disabled.application, 'restart-required')
  const restarted = await host.restart()
  restarted.ctx.llm.registerAdapter(['scripted'], adapter)
  const after = await restarted.createAgent(SessionId('s4-d2-b09-after'), { provider: 'scripted', model: 'review-model', cwd: work })
  await send(after, 'Design the base provider session')
  const restartedTitle = restarted.ctx.get('sessionTitle') as { get(session: unknown): { title: string; source: { provider?: string } } | undefined }
  await waitFor(() => restartedTitle.get(after.session)?.title === 'Base Provider Title')
  assert.notEqual(restartedTitle.get(after.session)?.source.provider, 'session-title-all-prompts-llm',
    'the restarted composition falls back to the base title provider')
})

test('Badge Skill: real provider, skills-capable presets and no minimal skill tool', { skip: skip10 }, async t => {
  let host = await startS4D2Host(t, { bundles: [B10], presets: true })
  const work = join(host.root, 'work')
  const skills = host.ctx.get('skills') as {
    list(options?: { cwd?: string; scope?: unknown }): Promise<readonly { name: string; provider: string }[]>
    get(name: string, options?: { cwd?: string; scope?: unknown }): Promise<{ content: string } | undefined>
  }
  const presets = host.ctx.get('agentPresets') as { select(agent: unknown, preset: string): Promise<unknown> }

  const catalog = await skills.list({ cwd: work })
  const badge = catalog.find(candidate => candidate.name === 'dsh-badge')
  assert.ok(badge !== undefined, 'the Host badge provider really contributes the dsh-badge skill')
  assert.equal(badge.provider, 'dsh-badge')
  const body = await skills.get('dsh-badge')
  assert.ok(body !== undefined && body.content.length > 0, 'the real skill body is loadable')

  const standard = await host.createAgent(SessionId('s4-d2-b10-standard'), { cwd: work })
  await presets.select(standard, 'standard')
  assert.ok(host.hasTool('skill', standard), 'the skills-capable standard preset exposes the skill tool')
  const standardCatalog = await readSurfaceCatalog(standard as never, new AbortController().signal, host.ctx as never)
  assert.ok(standardCatalog.skills.some(skill => skill.name === 'dsh-badge'),
    'the existing /skill surface catalog reads the badge skill')

  const ptc = await host.createAgent(SessionId('s4-d2-b10-ptc'), { cwd: work })
  await presets.select(ptc, 'ptc')
  assert.ok(host.hasTool('skill', ptc), 'the skills-capable ptc preset exposes the skill tool')
  const ptcCatalog = await readSurfaceCatalog(ptc as never, new AbortController().signal, host.ctx as never)
  assert.ok(ptcCatalog.skills.some(skill => skill.name === 'dsh-badge'),
    'the ptc /skill surface catalog reads the badge skill')

  const minimal = await host.createAgent(SessionId('s4-d2-b10-minimal'), { cwd: work })
  await presets.select(minimal, 'minimal')
  assert.equal(host.hasTool('skill', minimal), false, 'minimal never gains a skill tool it does not declare')
  assert.equal(host.hasTool('skill', undefined), false, 'is a provider, not a global model tool')

  // OFF + restart: the provider and the catalog entry disappear from the real
  // Host registry; the preset-local skill tools are unchanged by B10.
  const disabled = await host.pluginManager.setBundleEnabled(B10, false) as { application: string }
  assert.equal(disabled.application, 'restart-required')
  host = await host.restart()
  const restartedSkills = host.ctx.get('skills') as { list(options?: { cwd?: string }): Promise<readonly { name: string }[]> }
  const after = await restartedSkills.list({ cwd: work })
  assert.equal(after.some(skill => skill.name === 'dsh-badge'), false, 'the disabled bundle no longer contributes the skill')
})

test('Ralph: one real bounded round, workflow activity and cancelled-run cleanup', { skip: skip11 }, async t => {
  const host = await startS4D2Host(t, { bundles: [B11] })
  const work = join(host.root, 'work')
  const adapter = new RalphAdapter()
  host.ctx.llm.registerAdapter(['scripted'], adapter)
  const workflowEvents: string[] = []
  host.ctx.on('workflow/start' as never, (() => { workflowEvents.push('start') }) as never)
  host.ctx.on('workflow/end' as never, (() => { workflowEvents.push('end') }) as never)
  const agent = await host.createAgent(SessionId('s4-d2-b11'), { provider: 'scripted', model: 'review-model', cwd: work })

  const result = await executeTool(host, 'ralph', agent, { objective: 'Report one completed round', maxRounds: 1 }, new AbortController().signal)
  assert.notEqual(result.isError, true, resultText(result))
  assert.match(resultText(result), /complete/i)
  assert.match(resultText(result), /round/i)
  assert.deepEqual(workflowEvents, ['start', 'end'], 'the official workflow activity pair settled once')
  assert.equal(adapter.roundPrompts.length, 1, 'maxRounds:1 executes exactly one bounded round')
  // The foreground ralph call returns its real tool result through the real
  // ToolRuntime; no background Job is created by this tool.
  await waitFor(() => host.ctx.agents.list().length === 1)
  // No duplicate settle: the pair stays exactly once after the run drains.
  await new Promise<void>(resolve => setTimeout(resolve, 250))
  assert.deepEqual(workflowEvents, ['start', 'end'], 'the settled workflow never emits a duplicate workflow/end')

  // CANCELLED RUN: an in-flight child is abandoned through the real run abort
  // and leaves no orphan Agent.
  adapter.holdNextRound = new Promise<void>(resolve => { adapter.releaseRound = resolve })
  const abort = new AbortController()
  const pending = executeTool(host, 'ralph', agent, { objective: 'Hold then cancel', maxRounds: 1 }, abort.signal)
  await waitFor(() => adapter.roundPrompts.length === 2)
  abort.abort()
  // Unblock the held child model stream BEFORE awaiting the run: the run's
  // cancellation drains the child through this stream, so awaiting first would
  // deadlock the test fixture (not the Host).
  adapter.releaseRound?.()
  const cancelled = await pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }))
  if (cancelled.ok) {
    const cancelledResult = cancelled.value as { isError?: boolean; content?: readonly { text?: string }[] }
    assert.equal(cancelledResult.isError, true, 'an aborted ralph run settles as a real error result')
    assert.match(JSON.stringify(cancelledResult), /cancel/iu)
  } else {
    assert.match(String(cancelled.error), /cancel|abort/iu)
  }
  await waitFor(() => host.ctx.agents.list().length === 1)
  assert.equal(workflowEvents.filter(event => event === 'end').length, 2, 'the cancelled run also settled its workflow/end exactly once')
  await new Promise<void>(resolve => setTimeout(resolve, 250))
  assert.equal(workflowEvents.filter(event => event === 'end').length, 2, 'the cancelled run never double-settles')
})

class RalphAdapter extends LlmAdapter {
  readonly roundPrompts: string[] = []
  holdNextRound: Promise<void> | undefined
  releaseRound: (() => void) | undefined

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const messages = JSON.stringify(options.messages)
    if (!messages.includes('Ralph round')) {
      yield* textChunks('ok')
      return
    }
    this.roundPrompts.push(messages)
    if (this.holdNextRound !== undefined) {
      const hold = this.holdNextRound
      this.holdNextRound = undefined
      await Promise.race([
        hold,
        new Promise<never>((_resolve, reject) => {
          const signal = options.signal
          if (signal === undefined) return
          if (signal.aborted) reject(new Error('round aborted'))
          else signal.addEventListener('abort', () => reject(new Error('round aborted')), { once: true })
        }),
      ])
    }
    options.signal?.throwIfAborted()
    const report = JSON.stringify({
      status: 'complete',
      summary: 'one bounded round completed',
      evidence: ['the fresh child produced a structured report'],
      nextSteps: [],
      blocker: '',
    })
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: 'structured-1' as never, name: 'structured_output', argumentsDelta: report }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: 'structured-1' as never, name: 'structured_output', arguments: report },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function executeTool(
  host: { ctx: { tools: { execute(input: unknown): Promise<unknown> } } },
  name: string,
  agent: unknown,
  args: unknown,
  signal: AbortSignal,
): Promise<{ isError?: boolean; content?: readonly { type?: string; text?: string }[] }> {
  return host.ctx.tools.execute({
    signal,
    callId: `s4-d2-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}` as never,
    name,
    arguments: args,
    agent,
  }) as never
}
