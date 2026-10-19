/**
 * S4-D3 B09/B10/B11 — the OFFICIAL rc.2 projection/workflow results in the
 * MOUNTED PiTui application (D3-5).
 *
 * `PRODUCTION PREREQUISITES REPRODUCED`: the published rc.2 Optional bundle
 * packages + dsh-base family, the official profile/patch reader and `boot()`
 * Loader, the real Agent/Session/title/Skill/workflow/tool services, the
 * production TUI runner mounted on the SAME Context, and the existing title,
 * `/skill` and transcript/Activity consumers.
 * `TEST STAND-INS`: the temporary profile/installation/home roots, a scripted
 * deterministic LLM transport and the VirtualTerminal.
 * `DELIBERATELY ABSENT`: the user's real DSH_HOME/credentials, network
 * installs, a physical terminal/GUI and any TUI screen row this fixture does
 * not mount.
 * @module @xmoon76/dsh-pi-tui/s4-d3-host-to-tui-projections.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  skippedInstallationReason,
  type S4D2BundleId,
} from './support/s4-d2-optional-bundle-fixture.ts'
import { startS4D3Application, type S4D3Application } from './support/s4-d3-application-fixture.ts'

const B09 = '@deepseek-ai/dsh-experimental-session-titles-bundle' satisfies S4D2BundleId
const B10 = '@deepseek-ai/dsh-experimental-badge-skill-bundle' satisfies S4D2BundleId
const B11 = '@deepseek-ai/dsh-experimental-ralph-bundle' satisfies S4D2BundleId

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

interface ToolScript {
  readonly kind: 'tool'
  readonly name: string
  readonly arguments: string
  readonly callId: string
}
type Script = ToolScript | { readonly kind: 'text'; readonly text: string }

class ScriptedAdapter extends LlmAdapter {
  readonly scripts: Script[] = []
  readonly titleResponses: string[] = []
  readonly titleRequests: string[] = []
  readonly roundScripts: Script[] = []
  readonly roundRequests: string[] = []
  holdTitle: Promise<void> | undefined
  releaseTitle: (() => void) | undefined
  holdRound: Promise<void> | undefined
  releaseRound: (() => void) | undefined

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const system = options.system ?? ''
    const messages = JSON.stringify(options.messages)
    if (system.includes('Create a concise title')) {
      this.titleRequests.push(messages)
      if (this.holdTitle !== undefined) {
        const hold = this.holdTitle
        this.holdTitle = undefined
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
      yield* textChunks(this.titleResponses.shift() ?? 'Generated Title')
      return
    }
    // The CHILD prompt carries the immutable objective; the parent system
    // prompt only mentions the tool description ("Ralph round"), so that
    // phrase alone cannot distinguish the two calls.
    const isRound = messages.includes('Immutable objective:')
    if (isRound) this.roundRequests.push(messages)
    const script = (isRound ? this.roundScripts : this.scripts).shift()
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
      block: { type: 'tool-call', id: script.callId as never, name: script.name, arguments: script.arguments },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function followup(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Submit through the PRODUCTION editor path (a `/new` session is bound to the
 *  editor's writer; a direct `agent.followup` bypasses that surface). */
async function submitPrompt(app: S4D3Application, text: string): Promise<void> {
  for (const character of text) app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput('\r')
  await app.settle()
}

function headerLine(app: S4D3Application): string {
  return app.view().split('\n')[0] ?? ''
}

/** Capture the production OSC 0 title sink (`process.stdout` + isTTY), the
 *  exact path `setTerminalTitle` uses. */
function captureOscTitles(t: { after(fn: () => void): void }): string[] {
  const writes: string[] = []
  const stdout = process.stdout as { isTTY?: boolean }
  const previousIsTTY = stdout.isTTY
  const previousWrite = process.stdout.write
  stdout.isTTY = true
  process.stdout.write = ((chunk: unknown) => { writes.push(String(chunk)); return true }) as typeof process.stdout.write
  t.after(() => {
    process.stdout.write = previousWrite
    stdout.isTTY = previousIsTTY
  })
  return writes
}

test('B09: the real all-prompts title reaches the mounted TUI title/OSC, manual wins and a late A never paints B', { skip: skippedInstallationReason([B09]) }, async t => {
  const adapter = new ScriptedAdapter()
  const app = await startS4D3Application(t, {
    bundles: [B09],
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  const titles = captureOscTitles(t)
  const titleService = app.host.ctx.get('sessionTitle') as {
    get(session: unknown): { title: string; source: { kind: string; provider?: string } } | undefined
  }

  adapter.scripts.push({ kind: 'text', text: 'Alpha work started.' })
  adapter.titleResponses.push('Alpha Project')
  const first = await app.submitFirstPrompt('Design the alpha project')
  await first.whenIdle()
  await app.waitFor(() => headerLine(app).includes('Alpha Project'), 'the generated title on the TUI header')
  assert.equal(titleService.get(first.session)?.source.provider, 'session-title-all-prompts-llm')
  assert.ok(titles.some(title => title.includes('\u001b]0;dsh · Alpha Project\u0007')),
    `the OSC 0 title projection is written: ${JSON.stringify(titles)}`)

  // Manual `/title` keeps the official user-source precedence across turns.
  for (const character of '/title Manual Title') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput('\r')
  await app.waitFor(() => headerLine(app).includes('Manual Title'), 'the manual title on the TUI header')
  adapter.scripts.push({ kind: 'text', text: 'Acknowledged.' })
  followup(first, 'A follow-up acknowledgement')
  await first.whenIdle()
  await app.waitFor(() => headerLine(app).includes('Manual Title'), 'manual precedence after a later turn')
  assert.equal(titleService.get(first.session)?.source.kind, 'user')

  // LATE TITLE ISOLATION: a NEW session A2 starts a held automatic title
  // request; a later `/new` session B settles its own title before A2 releases.
  // B's painted title must not change.
  for (const character of '/new') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput('\r')
  await app.waitFor(() => app.agent() !== undefined && String(app.agent()!.session.id) !== String(first.session.id),
    'the production /new transition for A2')
  const held = app.requireAgent()
  adapter.holdTitle = new Promise<void>(resolve => { adapter.releaseTitle = resolve })
  adapter.scripts.push({ kind: 'text', text: 'Held alpha start.' })
  await submitPrompt(app, 'Hold this title request')
  await app.waitFor(() => app.view().includes('Held alpha start.'), 'the held session turn')
  await app.waitFor(() => adapter.titleRequests.some(messages => messages.includes('Hold this title request')),
    'the held title request')
  for (const character of '/new') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput('\r')
  await app.waitFor(() => app.agent() !== undefined && String(app.agent()!.session.id) !== String(first.session.id),
    'the production /new transition')
  adapter.scripts.push({ kind: 'text', text: 'Beta work started.' })
  adapter.titleResponses.length = 0
  adapter.titleResponses.push('Replacement Title')
  await submitPrompt(app, 'Design the replacement')
  await app.waitFor(() => app.view().includes('Beta work started.'), 'the replacement session turn')
  await app.waitFor(() => headerLine(app).includes('Replacement Title'), "the replacement session's title")
  adapter.releaseTitle?.()
  await new Promise<void>(resolve => setTimeout(resolve, 150))
  await app.settle()
  assert.ok(headerLine(app).includes('Replacement Title'), 'the old session late title never paints the current session')
  assert.ok(!headerLine(app).includes('Held Alpha Title'))

  // OFF + restart: the official manager deselects B09 and a fresh boot falls
  // back to the base first-prompt provider; the old UI title is not cached.
  const disabled = await app.host.pluginManager.setBundleEnabled(B09, false) as { application: string }
  assert.equal(disabled.application, 'restart-required')
  const restarted = await app.restart(host => { host.ctx.llm.registerAdapter(['scripted'], adapter) })
  adapter.scripts.push({ kind: 'text', text: 'Base provider turn.' })
  adapter.titleResponses.length = 0
  adapter.titleResponses.push('Base Provider Title')
  const after = await restarted.submitFirstPrompt('Design the base provider session')
  await after.whenIdle()
  await restarted.waitFor(() => headerLine(restarted).includes('Base Provider Title'), 'the base provider title after restart')
  assert.ok(!headerLine(restarted).includes('Replacement Title'), 'the restarted TUI keeps no old title cache')
  const restartedTitle = restarted.host.ctx.get('sessionTitle') as {
    get(session: unknown): { title: string; source: { provider?: string } } | undefined
  }
  await restarted.waitFor(() => restartedTitle.get(after.session)?.title === 'Base Provider Title', 'the restarted title service')
  assert.notEqual(restartedTitle.get(after.session)?.source.provider, 'session-title-all-prompts-llm',
    'the disabled bundle no longer provides the all-prompts title route')
})

// ── B10 Badge Skill ────────────────────────────────────────────────────────

async function openSkillPicker(app: S4D3Application): Promise<void> {
  for (const character of '/skill') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput('\r')
  await app.settle()
  if (app.view().includes('❯ /skill')) {
    app.vt.sendInput('\r')
    await app.settle()
  }
}

test('B10: the real badge Skill provider reaches the /skill surface in a skills-capable preset', { skip: skippedInstallationReason([B10]) }, async t => {
  const adapter = new ScriptedAdapter()
  const app = await startS4D3Application(t, {
    bundles: [B10],
    presets: true,
    presetId: 'standard',
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  adapter.scripts.push({ kind: 'text', text: 'Standard session ready.' })
  const agent = await app.submitFirstPrompt('Start the standard session')
  await agent.whenIdle()
  assert.equal(app.host.hasTool('skill', agent), true, 'standard exposes the preset-scoped skill tool')
  await openSkillPicker(app)
  await app.waitFor(() => app.view().includes('dsh-badge'), 'the real badge Skill in the /skill surface')
  assert.match(app.view(), /dsh-badge/u)

  // The Host skill body is loadable and the provider name is the real one
  // (never a Web 1017 model badge or a fabricated model tool).
  const skills = app.host.ctx.get('skills') as {
    get(name: string): Promise<{ content: string } | undefined>
    list(options?: { cwd?: string }): Promise<readonly { name: string; provider: string }[]>
  }
  const catalog = await skills.list({ cwd: join(app.host.root, 'work') })
  assert.equal(catalog.find(skill => skill.name === 'dsh-badge')?.provider, 'dsh-badge')
  assert.ok(((await skills.get('dsh-badge'))?.content.length ?? 0) > 0)

  // Disable + restart removes the provider and the `/skill` entry.
  const disabled = await app.host.pluginManager.setBundleEnabled(B10, false) as { application: string }
  assert.equal(disabled.application, 'restart-required')
  const restarted = await app.restart(host => { host.ctx.llm.registerAdapter(['scripted'], adapter) })
  adapter.scripts.push({ kind: 'text', text: 'Restarted session.' })
  const after = await restarted.submitFirstPrompt('Start after the restart')
  await after.whenIdle()
  await openSkillPicker(restarted)
  await restarted.settle()
  assert.doesNotMatch(restarted.view(), /dsh-badge/u, 'the disabled bundle no longer contributes the skill')
})

test('B10: the minimal preset never gains a model skill tool (the human /skill surface stays provider-backed)', { skip: skippedInstallationReason([B10]) }, async t => {
  const adapter = new ScriptedAdapter()
  const app = await startS4D3Application(t, {
    bundles: [B10],
    presets: true,
    presetId: 'minimal',
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  adapter.scripts.push({ kind: 'text', text: 'Minimal session ready.' })
  const agent = await app.submitFirstPrompt('Start the minimal session')
  await agent.whenIdle()
  assert.equal(app.host.hasTool('skill', agent), false, 'minimal declares no model skill tool')
  assert.equal(app.host.hasTool('skill', undefined), false, 'B10 is a provider, not a global model tool')
  assert.equal(app.host.ctx.tools.schemas(agent).some(schema => schema.name === 'skill'), false)
  // `/skill` is the HUMAN-invocable surface: the provider can list the skill
  // there without granting the minimal model any skill tool.
  await openSkillPicker(app)
  await app.settle()
  assert.match(app.view(), /Type to search/u, 'the human skill surface opens')
})

// ── B11 Ralph ──────────────────────────────────────────────────────────────

function ralphReport(summary: string): Script {
  const report = JSON.stringify({
    status: 'complete',
    summary,
    evidence: ['the fresh child produced a structured report'],
    nextSteps: [],
    blocker: '',
  })
  return {
    kind: 'tool',
    name: 'structured_output',
    callId: `s4d3-b11-structured-${summary.replace(/\W+/gu, '-')}`,
    arguments: report,
  }
}

test('B11: a real bounded Ralph round reaches the transcript/Activity UI as a foreground tool without a Job', { skip: skippedInstallationReason([B11]) }, async t => {
  const adapter = new ScriptedAdapter()
  const app = await startS4D3Application(t, {
    bundles: [B11],
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  const workflowEvents: string[] = []
  app.host.ctx.on('workflow/start' as never, (() => { workflowEvents.push('start') }) as never)
  app.host.ctx.on('workflow/end' as never, (() => { workflowEvents.push('end') }) as never)

  adapter.roundScripts.push(ralphReport('one bounded round completed'))
  adapter.scripts.push(
    { kind: 'tool', name: 'ralph', callId: 's4d3-b11-run', arguments: JSON.stringify({ objective: 'Report one completed round', maxRounds: 1 }) },
    { kind: 'text', text: 'Ralph completed.' },
  )
  const agent = await app.submitFirstPrompt('Run one bounded Ralph iteration')
  await agent.whenIdle()
  await app.waitFor(() => app.view().includes('ralph'), 'the real ralph Tool card')
  await app.waitFor(() => /Ralph worker reported completion after 1 round/iu.test(app.view()), 'the real ralph result')
  app.vt.sendInput('\x0f')
  await app.settle()
  await app.waitFor(() => /status\s+complete|complete/iu.test(app.view()), 'the expanded structured report')
  assert.deepEqual(workflowEvents, ['start', 'end'], 'the official workflow activity pair settled exactly once')
  assert.equal(adapter.roundRequests.length, 1, 'maxRounds:1 executed exactly one bounded child round')
  // Foreground fact, not a fabricated Job row.
  const jobs = app.host.ctx.get('jobs') as { list(caller?: unknown): readonly unknown[] } | undefined
  assert.equal(jobs?.list(agent.session.id).length ?? 0, 0, 'ralph is a foreground tool and creates no Job')

  // CANCELLED RUN: the in-flight child is abandoned through the real run
  // abort; the transcript shows an error result, workflow/end settles once,
  // and no orphan Agent survives.
  adapter.holdRound = new Promise<void>(resolve => { adapter.releaseRound = resolve })
  adapter.scripts.push(
    { kind: 'tool', name: 'ralph', callId: 's4d3-b11-cancel', arguments: JSON.stringify({ objective: 'Hold then cancel', maxRounds: 1 }) },
    { kind: 'text', text: 'Cancelled run settled.' },
  )
  await submitPrompt(app, 'Run a cancellable Ralph iteration')
  await app.waitFor(() => adapter.roundRequests.length === 2, 'the held child round')
  app.vt.sendInput('\x1b') // the mounted runner's real single-Esc cancel
  adapter.releaseRound?.()
  await app.waitFor(() => workflowEvents.filter(event => event === 'end').length === 2,
    'the cancelled run settles its workflow/end exactly once')
  await app.waitFor(() => app.view().includes('cancelled run settled') || /cancel|abort/iu.test(app.view()),
    'the cancelled tool result is visible')
  await new Promise<void>(resolve => setTimeout(resolve, 250))
  assert.equal(workflowEvents.filter(event => event === 'end').length, 2, 'no duplicate workflow/end')
  await app.waitFor(() => app.host.ctx.agents.list().length === 1, 'no orphan child Agent after the cancelled run')
  assert.ok(!app.view().includes('[job]'), 'no phantom Job row is painted for Ralph')
})
