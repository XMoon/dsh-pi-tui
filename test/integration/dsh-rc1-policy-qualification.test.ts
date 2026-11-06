/**
 * S3-PR1 rc.1 Host policy qualification: the effective FS observation policy,
 * the loopback-capable official `web_fetch`, and the Host-wide Schedule tool
 * authority — each proved through the REAL provisioned DSH 0.2.2-rc.1 profile
 * (official base + this bundle's agent plane + the shipped presets), the real
 * AgentLoop/ToolRuntime, and a scripted model transport.
 *
 * FIXTURE (real): `startOptionalBundleHost` with `presets: true` composes the
 * official `dsh-base`, the TUI overlay's agent-plane rows and the four shipped
 * preset declarations; the tests add only the official `schedule` service row
 * the web bundle owns (the TUI overlay does not insert it). STAND-INS: the
 * scripted LLM transport and a test-owned loopback HTTP server. ABSENT: the
 * user's real DSH_HOME, network egress, credentials, physical terminal.
 * @module @xmoon76/dsh-pi-tui/dsh-rc1-policy-qualification.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  skippedInstallationReason,
  startOptionalBundleHost,
  type OptionalBundleHost,
} from '../support/optional-bundle-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

/** The rc.1 base already mounts the PTC executor only inside the `ptc`
 *  preset; the deployment default is the native executor, so the scripted
 *  model calls the model-facing tool names directly. */
class PolicyAdapter extends LlmAdapter {
  readonly scripts: Array<
    | { readonly kind: 'tool'; readonly name: string; readonly arguments: string; readonly callId: string }
    | { readonly kind: 'text'; readonly text: string }
  > = []

  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    const script = this.scripts.shift()
    if (script === undefined) {
      yield* this.text('done')
      return
    }
    if (script.kind === 'text') {
      yield* this.text(script.text)
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

  private *text(text: string): Iterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

interface PolicyHost {
  readonly host: OptionalBundleHost
  readonly adapter: PolicyAdapter
  readonly work: string
}

/** Boot ONE real rc.1 profile with the TUI agent plane, the shipped presets and
 *  the official Host-wide Schedule service row (the web bundle's own row). */
async function startPolicyHost(t: Parameters<typeof testLifecycle>[0]): Promise<PolicyHost> {
  const adapter = new PolicyAdapter()
  const host = await startOptionalBundleHost(t, {
    installationBoot: true,
    presets: true,
    patches: [{ insert: [{ id: 'schedule', name: '@deepseek-ai/dsh-schedule' }] }] as never,
  })
  host.ctx.llm.registerAdapter(['scripted'], adapter)
  const work = join(host.root, 'work')
  mkdirSync(work, { recursive: true })
  return { host, adapter, work }
}

/** Create a live Agent through the production registry with the standard preset
 *  mounted exactly like the TUI's own session composition. */
async function createStandardAgent(
  host: OptionalBundleHost,
  agentId: string,
  cwd: string,
  meta: Readonly<Record<string, unknown>> = {},
): Promise<Agent> {
  const presets = host.ctx.get('agentPresets') as { mount(ctx: never, id?: string): Promise<unknown> }
  const handle = await host.ctx.agents.create({
    sessionId: SessionId(agentId),
    meta: { cwd, ...meta } as never,
    agentOptions: { provider: 'scripted', model: 'review-model' } as never,
    setup: async (agentCtx: never) => { await presets.mount(agentCtx, 'standard') },
  } as never)
  return (handle as { readonly agent: Agent }).agent
}

/** Run one scripted model round through the REAL AgentLoop/ToolRuntime. */
async function runTurn(adapter: PolicyAdapter, agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

interface SessionEventLike {
  readonly type: string
  readonly data?: {
    readonly callId?: { readonly id?: unknown } | unknown
    readonly name?: unknown
    readonly message?: {
      readonly toolCallId?: unknown
      readonly content?: readonly { readonly type?: string; readonly text?: string }[]
    }
  }
}

function eventsOf(agent: Agent): readonly SessionEventLike[] {
  return agent.session.snapshotEvents() as unknown as readonly SessionEventLike[]
}

/** The model-facing tool result text of one exact durable call id. */
function toolResultText(agent: Agent, callId: string): string | undefined {
  for (const event of eventsOf(agent)) {
    if (event.type !== 'tool/result') continue
    const message = event.data?.message
    if (String(message?.toolCallId) !== callId) continue
    return (message?.content ?? []).map(block => block.text ?? '').join('')
  }
  return undefined
}

function assertToolResult(agent: Agent, callId: string, pattern: RegExp, what: string): string {
  const text = toolResultText(agent, callId)
  assert.ok(text !== undefined, `${what}: the exact tool call ${callId} settled as a durable tool/result`)
  assert.match(text, pattern, `${what}: ${text}`)
  return text
}

const skip = skippedInstallationReason([])

// ── FS observation policy ───────────────────────────────────────────────────

test('the effective rc.1 profile disables fs-observation-policy and a real edit needs no prior read', { skip }, async t => {
  const { host, adapter, work } = await startPolicyHost(t)

  // The RESOLVED profile composition (official base patch + the TUI overlay's
  // agent-plane layer), not a static grep of a YAML file.
  const profile = loadProfileDirectory('dsh', host.profileDir, join(host.root, 'installation', 'package.json'))
  const fsRow = profile.layers
    .flatMap(layer => layer.patches)
    .flatMap(patch => patch.insert ?? [])
    .find(row => row.id === 'fs-observation-policy')
  assert.deepEqual(fsRow, {
    id: 'fs-observation-policy',
    name: '@deepseek-ai/dsh-fs-observation-policy',
    disabled: true,
  }, 'the effective base row keeps the upstream default OFF')
  assert.equal(host.loaderEntries().find(entry => entry.id === 'fs-observation-policy')?.state, -1,
    'the real Loader never activated the observation policy')

  const agent = await createStandardAgent(host, 'policy-fs-agent', work)
  assert.equal(host.toolNames(agent).includes('edit'), true, 'the standard preset exposes the real edit tool')
  const permissions = host.ctx.get('permissionPresets') as { current(session: unknown): string | null }
  assert.equal(permissions.current(agent.session), 'workspace-write',
    'the negative below runs under the same default sandbox mode the profile ships')

  // The Session has never read this file; the edit must still succeed and the
  // durable tool call/result must agree with the filesystem outcome.
  const file = join(work, 'never-read.txt')
  writeFileSync(file, 'before\n')
  assert.equal(eventsOf(agent).some(event => event.type === 'tool/call'), false,
    'the fresh Session has issued no tool call yet (nothing was read)')
  adapter.scripts.push({
    kind: 'tool', name: 'edit', callId: 'policy-fs-edit',
    arguments: JSON.stringify({ file_path: file, old_string: 'before', new_string: 'after' }),
  }, { kind: 'text', text: 'edited' })
  await runTurn(adapter, agent, 'Edit the unread file')
  assert.equal(readFileSync(file, 'utf8'), 'after\n', 'the real edit changed the exact file content')
  assertToolResult(agent, 'policy-fs-edit', /updated successfully/u, 'the unread edit succeeded')
  assert.equal(eventsOf(agent).some(event =>
    event.type === 'tool/call' && String(event.data?.callId) === 'policy-fs-edit'),
  true, 'the edit is the Session-durable tool/call')
  assert.equal(eventsOf(agent).some(event => event.type === 'tool/call' && event.data?.name === 'read'), false,
    'no read call was needed or issued before the edit')

  // NEGATIVE: the existing sandbox/permission boundary (not the disabled FS
  // observation policy) still refuses an out-of-workspace mutation. The target
  // is a disposable test-owned file under the repository temp area, which is
  // outside the platform temp allowance and outside the Session workspace.
  const outsideDir = join(process.cwd(), 'temp')
  mkdirSync(outsideDir, { recursive: true })
  const outsideFile = join(outsideDir, `s3-pr1-outside-workspace-${process.pid}-${randomUUID()}.txt`)
  writeFileSync(outsideFile, 'outside-before\n')
  t.after(() => { rmSync(outsideFile, { force: true }) })
  adapter.scripts.push({
    kind: 'tool', name: 'edit', callId: 'policy-fs-outside',
    arguments: JSON.stringify({ file_path: outsideFile, old_string: 'outside-before', new_string: 'outside-after' }),
  }, { kind: 'text', text: 'refused' })
  await runTurn(adapter, agent, 'Edit outside the workspace')
  assertToolResult(agent, 'policy-fs-outside', /\[sandbox: file access denied under workspace-write mode\]/u,
    'the real sandbox fence refused the out-of-workspace edit')
  assert.equal(readFileSync(outsideFile, 'utf8'), 'outside-before\n',
    'the refused out-of-workspace edit changed nothing')
})

// ── web_fetch loopback ──────────────────────────────────────────────────────

test('the real web_fetch provider retrieves a loopback server body and reports the existing Host failure after close', { skip }, async t => {
  const { host, adapter, work } = await startPolicyHost(t)
  const marker = `loopback-${randomUUID()}`
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url ?? '')
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end(marker)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  t.after(() => { server.close() })
  const port = (server.address() as { readonly port: number }).port
  const url = `http://127.0.0.1:${String(port)}/loopback`
  // Keep the test's own loopback traffic off any ambient proxy while leaving
  // the user's configuration untouched after the case.
  const proxyKeys = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'NO_PROXY', 'no_proxy'] as const
  const previousProxy = new Map(proxyKeys.map(key => [key, process.env[key]]))
  const direct = [previousProxy.get('NO_PROXY'), previousProxy.get('no_proxy'), '127.0.0.1,localhost']
    .filter(value => value !== undefined && value !== '')
    .join(',')
  process.env.NO_PROXY = direct
  process.env.no_proxy = direct
  t.after(() => {
    for (const [key, value] of previousProxy) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  const agent = await createStandardAgent(host, 'policy-web-agent', work)
  assert.equal(host.toolNames(agent).includes('web_fetch'), true,
    'the standard preset exposes the real web_fetch route')
  adapter.scripts.push({
    kind: 'tool', name: 'web_fetch', callId: 'policy-web-fetch',
    arguments: JSON.stringify({ url }),
  }, { kind: 'text', text: 'fetched' })
  await runTurn(adapter, agent, 'Fetch the loopback page')
  const fetched = assertToolResult(agent, 'policy-web-fetch', new RegExp(marker, 'u'),
    'the loopback body reached the model-facing tool result')
  assert.equal(requests.length, 1, 'the test-owned loopback service really received exactly one request')
  assert.equal(requests[0], '/loopback')
  assert.equal(/WEB_BLOCKED_URL/u.test(fetched), false, 'no legacy non-public URL refusal was applied')

  // NEGATIVE: the existing Host transport failure is visible after the same
  // service closes; no new "private network" rule is invented here.
  await new Promise<void>(resolve => { server.close(() => resolve()) })
  adapter.scripts.push({
    kind: 'tool', name: 'web_fetch', callId: 'policy-web-refused',
    arguments: JSON.stringify({ url }),
  }, { kind: 'text', text: 'refused' })
  await runTurn(adapter, agent, 'Fetch the closed page')
  assertToolResult(agent, 'policy-web-refused', /web fetch failed|fetch failed|ECONNREFUSED/iu,
    'the closed service surfaces the official Host fetch failure')
})

// ── Host-wide Schedule authority ────────────────────────────────────────────

interface ScheduleTaskLike {
  readonly id: string
  readonly title: string
  readonly status: string
}
interface ScheduleServiceLike {
  catalog(): Promise<readonly ScheduleTaskLike[]>
}

const RRULE_ONCE_2030 = 'DTSTART:20300101T000000Z\nRRULE:FREQ=DAILY;COUNT=1'

test('Schedule tools are Host-wide across different Sessions and refuse a delegated subagent', { skip }, async t => {
  const { host, adapter, work } = await startPolicyHost(t)
  const a = await createStandardAgent(host, 'policy-schedule-a', work)
  const b = await createStandardAgent(host, 'policy-schedule-b', work)
  assert.notEqual(a.session.id, b.session.id, 'the two callers are DIFFERENT Sessions')
  assert.equal(host.ctx.sessions.get(a.session.id) !== undefined && host.ctx.sessions.get(b.session.id) !== undefined,
    true, 'both Sessions live on the SAME Host')
  const schedule = host.ctx.get('schedule') as ScheduleServiceLike
  assert.deepEqual(await schedule.catalog(), [], 'the isolated Host starts with no scheduled task')

  // Session A creates one real Host task for itself.
  adapter.scripts.push({
    kind: 'tool', name: 'schedule_create', callId: 'policy-schedule-create',
    arguments: JSON.stringify({
      title: 'S3 host-wide task', prompt: 'S3 host-wide prompt', target: 'this_session', rrule: RRULE_ONCE_2030,
    }),
  }, { kind: 'text', text: 'created' })
  await runTurn(adapter, a, 'Create the scheduled task')
  const createdText = assertToolResult(a, 'policy-schedule-create', /"id":"schedule-/u,
    'Session A created the Host task through the real schedule_create tool')
  const created = JSON.parse(createdText) as {
    readonly id: string
    readonly title: string
    readonly target: { readonly kind: string; readonly sessionId: string }
  }
  assert.equal(created.title, 'S3 host-wide task')
  assert.deepEqual(created.target, { kind: 'session', sessionId: String(a.session.id) })
  assert.deepEqual((await schedule.catalog()).map(task => task.id), [created.id],
    'the task is stored once in the Host Schedule service')

  // Session B sees the SAME task through the Host-wide list/view tools.
  adapter.scripts.push({
    kind: 'tool', name: 'schedule_list', callId: 'policy-schedule-list', arguments: '{}',
  }, { kind: 'text', text: 'listed' })
  await runTurn(adapter, b, 'List the host schedules')
  const listed = JSON.parse(assertToolResult(b, 'policy-schedule-list', new RegExp(created.id, 'u'),
    'Session B lists the task created by Session A')) as {
    readonly items: readonly { readonly id: string }[]
  }
  assert.deepEqual(listed.items.map(item => item.id), [created.id])

  adapter.scripts.push({
    kind: 'tool', name: 'schedule_view', callId: 'policy-schedule-view', arguments: JSON.stringify({ id: created.id }),
  }, { kind: 'text', text: 'viewed' })
  await runTurn(adapter, b, 'View the host schedule')
  const viewed = JSON.parse(assertToolResult(b, 'policy-schedule-view', new RegExp(created.id, 'u'),
    'Session B views the task created by Session A')) as { readonly id: string; readonly title: string }
  assert.equal(viewed.id, created.id)
  assert.equal(viewed.title, 'S3 host-wide task')

  // Session B manages (deletes) that task through the real Host service.
  adapter.scripts.push({
    kind: 'tool', name: 'schedule_edit', callId: 'policy-schedule-delete',
    arguments: JSON.stringify({ id: created.id, action: 'delete' }),
  }, { kind: 'text', text: 'deleted' })
  await runTurn(adapter, b, 'Delete the host schedule')
  const deleted = JSON.parse(assertToolResult(b, 'policy-schedule-delete', /"deleted":true/u,
    'Session B deletes the task created by Session A')) as { readonly id: string; readonly deleted: boolean }
  assert.equal(deleted.id, created.id)
  assert.equal(deleted.deleted, true)
  assert.deepEqual(await schedule.catalog(), [], 'the Host task set is empty after the cross-Session delete')

  // A delegated child Agent of the SAME Host is refused by the official tools.
  const child = await createStandardAgent(host, 'policy-schedule-child', work, {
    parentSession: a.session.id,
    origin: 'subagent',
    delegationDepth: 1,
  })
  assert.equal(host.toolNames(child).includes('schedule_create'), true,
    'the delegated child really sees the schedule tool before the refusal')
  adapter.scripts.push({
    kind: 'tool', name: 'schedule_create', callId: 'policy-schedule-child-create',
    arguments: JSON.stringify({
      title: 'child task', prompt: 'child prompt', target: 'this_session', rrule: RRULE_ONCE_2030,
    }),
  }, { kind: 'text', text: 'child done' })
  await runTurn(adapter, child, 'Create a child schedule')
  assertToolResult(child, 'policy-schedule-child-create',
    /"code":"subagent_session"/u, 'the delegated child is refused with the official code')
  assert.deepEqual(await schedule.catalog(), [],
    'the refused child call stored no Host task')
})
