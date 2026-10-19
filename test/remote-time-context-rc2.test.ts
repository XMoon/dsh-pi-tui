/**
 * S3 §C5 — real rc.2 Time Context qualification (L5/L6-adjacent).
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - the ordinary real rc.2 Host fixture (real persistence, storage, presets,
 *   AgentLoop harness, Session Controller, Gateway, RemoteAccess)
 * - the OFFICIAL published `@deepseek-ai/dsh-time-context` plugin, mounted into
 *   that Host graph exactly as the official `standard`/`ptc`/`cordis` scoped
 *   presets do
 * - the official in-process Client/Gateway path over the real carrier; the user
 *   message is submitted through the PUBLIC `SessionFace.prompt()` (the same
 *   verb the TUI Remote writer uses), so the Host-side `clientTimeZone` comes
 *   from the official Client's resolved IANA zone
 * - the real AgentLoop pre-step waterfall (`agent/pre-step`)
 *
 * TEST STAND-INS
 * - a controlled process clock (`Date.now`): the official plugin's own
 *   `Date.now()` sampling and the session-event timeline are the scheduling
 *   authority; only the clock reading is controlled so the default 600000 ms
 *   refresh window is provable without a ten-minute test
 * - `TZ=UTC` in this test process: the controlled browser/process zone the
 *   official Client resolves into `clientTimeZone`
 * - a capturing LLM adapter (no network): the Host emits REAL agent events and
 *   the plugin's REAL injection; only the model is synthetic
 *
 * DELIBERATELY ABSENT
 * - the official preset LOADER path: this suite mounts the published plugin
 *   module directly (the dev dependency is resolvable; see the generated
 *   preset mirrors below). The real `standard`/`minimal` preset assembly is
 *   owned by the separate request-zone/preset PR, so this suite does not claim
 *   it; the preset COMPOSITION presence is asserted separately against the
 *   generated official mirrors.
 * - external providers, real accounts, Tern GUI
 *
 * @module @xmoon76/dsh-pi-tui/remote-time-context-rc2.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { LlmAdapter, createUserMessage, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteSessionLifecycle } from '../src/runtime/remote/session-lifecycle-remote.ts'
import { loadExperimentalRemoteRuntime } from '../src/runtime/backend-loader.ts'
import { TranscriptFolder } from '../src/transcript.ts'
import { TuiApp } from '../src/tui-app.ts'
import { createRemoteApplicationHostFixture, waitFor } from './support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

// The controlled browser/process zone. node:test runs each file in its own
// process, so this cannot leak into another suite.
process.env.TZ = 'UTC'

const SESSION = 's3-time-context-main'
const HOST_ZONE = 'UTC'
/** The official plugin's PUBLISHED default `refreshIntervalMs` (600000). The
 *  fixture does NOT pass it: the two-sided window assertions below bracket the
 *  real default (> 1000 ms and <= 601000 ms of clock advance). */
const REFRESH_MS = 600_000

interface RequestShape {
  readonly [key: string]: unknown
}

/** Captures the EXACT request messages the Host hands the model. */
class CapturingLlmAdapter extends LlmAdapter {
  readonly requests: RequestShape[][] = []

  override resolveModel(_provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider: 'smoke', id: model, name: model })
  }

  override listModels(provider: string): Promise<Array<{ provider: string; id: string; name: string }>> {
    return Promise.resolve([{ provider, id: 'smoke', name: 'smoke' }])
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options.messages as unknown as RequestShape[])
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'time-context reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'time-context reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A FULLY controlled `Date.now` for the official plugin's scheduling reads:
 *  the durable event time and the plugin's `now` are both sampled from this
 *  clock, so the default refresh window can be bracketed at exact millisecond
 *  boundaries (599999 vs 600000) instead of "some default in a wide range".
 *  The host work itself is driven by real timers (libuv), not by this clock. */
function installClock(): { advanceTo(ms: number): void; restore(): void } {
  const original = Date.now
  const base = original()
  let offset = 0
  Date.now = () => base + offset
  return {
    advanceTo: (ms: number): void => { offset = ms },
    restore: (): void => { Date.now = original },
  }
}

/** Mount the OFFICIAL plugin (its own `apply`/`inject`) on the real Host.
 *  The config is passed through EXACTLY as given: omitting `refreshIntervalMs`
 *  exercises the plugin's own published default, and omitting `timeZone`
 *  exercises its process-zone fallback. */
async function mountTimeContext(ctx: Context, config: { timeZone?: string; refreshIntervalMs?: number }): Promise<void> {
  const module = await import('@deepseek-ai/dsh-time-context') as {
    readonly name: string
    readonly inject: readonly string[]
    readonly apply: unknown
    readonly Config: unknown
  }
  assert.equal(module.name, 'time-context')
  assert.deepEqual([...module.inject], ['agents', 'sessionProjections'])
  await ctx.plugin(module as never, config as never)
}

interface HostEvent {
  readonly type: string
  readonly time?: number
  readonly data: {
    readonly source?: {
      readonly kind?: unknown
      readonly rpcId?: unknown
      readonly clientTimeZone?: unknown
      readonly form?: unknown
      readonly sections?: readonly { readonly name?: unknown; readonly text?: unknown }[]
    }
    readonly turn?: unknown
    readonly message?: { readonly content?: readonly { readonly type?: string; readonly text?: string }[] }
    readonly content?: readonly { readonly type?: string; readonly text?: string }[]
  }
}

function hostEvents(host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>): HostEvent[] {
  const session = host.ctx.sessions.get(SessionId(SESSION)) as unknown as {
    snapshotEvents(): HostEvent[]
  }
  return session.snapshotEvents()
}

function hostText(event: HostEvent): string {
  const content = event.data.message?.content ?? event.data.content ?? []
  return content.map(part => part.type === 'text' ? part.text ?? '' : `[${part.type ?? '?'}]`).join('')
}

function requestText(message: RequestShape): string {
  const content = message.content
  if (!Array.isArray(content)) return ''
  return (content as Array<{ type?: string; text?: string }>)
    .map(part => part.type === 'text' ? part.text ?? '' : `[${part.type ?? '?'}]`)
    .join('')
}

function requestSource(message: RequestShape): { kind?: unknown; form?: unknown } | undefined {
  const source = message.source
  return typeof source === 'object' && source !== null ? source as { kind?: unknown; form?: unknown } : undefined
}

function timeContextMessages(messages: readonly RequestShape[]): RequestShape[] {
  return messages.filter(message => requestSource(message)?.kind === 'time-context')
}

async function promptViaClient(
  sessions: { binding(id: SessionId): { session: { prompt(content: { type: 'text'; text: string }[], mode: 'queue' | 'steer'): Promise<{ ok: boolean; error?: unknown }> } } | undefined },
  text: string,
): Promise<void> {
  const binding = sessions.binding(SessionId(SESSION))
  assert.ok(binding !== undefined, 'the created Session must be retained before a prompt')
  const result = await binding.session.prompt([{ type: 'text', text }], 'queue')
  assert.equal(result.ok, true, `the official prompt must be accepted: ${JSON.stringify(result.error)}`)
}

async function waitForTurnEnd(host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>, turn: number): Promise<void> {
  await waitFor(`turn ${turn} to end`, () =>
    hostEvents(host).some(event => event.type === 'turn/end' && event.data.turn === turn), 20_000)
}

/** The real Host + official Client fixture this suite runs on. `plugin:false`
 *  mounts no time-context row at all (the composition state the official
 *  `minimal` preset produces — asserted separately from the generated preset
 *  mirrors, NOT run through the official preset Loader); the default mount
 *  deliberately omits `refreshIntervalMs` so the official plugin's OWN default
 *  window is the one under test. */
async function prepareTimeContextHost(
  life: TestLifecycle,
  options: { readonly plugin: boolean; readonly config?: { timeZone?: string; refreshIntervalMs?: number } },
) {
  const clock = installClock()
  life.defer(() => clock.restore())
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC',
    'this fixture requires the controlled UTC process zone')
  const llm = new CapturingLlmAdapter()
  const host = await createRemoteApplicationHostFixture(life, 's3-time-context-preset', { llmAdapter: llm })
  if (options.plugin) await mountTimeContext(host.ctx, options.config ?? { timeZone: HOST_ZONE })
  const runtime = await (await loadExperimentalRemoteRuntime()).createExperimentalRemoteRuntime({
    hostContext: host.ctx,
    waitForHostPrerequisites: async () => {},
  })
  life.defer(() => runtime.dispose().catch(() => {}))
  const sessions = runtime.client.sessions
  const created = await new RemoteSessionLifecycle(sessions, runtime.client.connection.generation)
    .create({ sessionId: SESSION, cwd: host.anchorDir })
  assert.equal(created.outcome.kind, 'created',
    `the real create must publish the Session: ${created.ownership}/${created.outcome.kind}`)
  return { host, sessions, clock, llm }
}

test('L5: the official time-context plugin injects one durable snapshot per eligible step over the real Host/Client wire', async (t) => {
  const life = testLifecycle(t)
  const { host, sessions, clock, llm } = await prepareTimeContextHost(life, { plugin: true })

  // ── Turn 1: the eligible first step carries ONE time-context reading ──────
  await promptViaClient(sessions, 'first question alpha')
  await waitFor('the first model request', () => llm.requests.length >= 1, 20_000)
  await waitForTurnEnd(host, 1)

  const first = llm.requests[0]!
  const injected = timeContextMessages(first)
  assert.equal(injected.length, 1, `exactly one time-context message per step, got ${injected.length}: ${JSON.stringify(first.map(requestText))}`)
  const text = requestText(injected[0]!)
  const timestamp = /Time sampled while preparing turn 1, step 1: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})\[([^\]]+)\]/u.exec(text)
  assert.ok(timestamp !== null, `the reading must carry a timestamp with offset and IANA zone: ${text}`)
  assert.equal(timestamp?.[3], 'UTC', 'the resolved IANA zone is the controlled UTC zone')
  assert.ok(text.includes('Browser time zone for this request: UTC.'), text)
  assert.ok(text.includes('Interpret otherwise-unqualified dates and times in this zone.'), text)
  // The FIRST model-visible message of the Turn has no predecessor, so the
  // official plugin reports the gap as unavailable rather than inventing one.
  assert.ok(text.includes('Elapsed since the preceding model-visible message: unavailable.'), text)

  // The user's own message is untouched: the reading is a SEPARATE source, never
  // merged into the human text.
  const userRequest = first.find(message => requestSource(message)?.kind === 'user')
  assert.ok(userRequest !== undefined, 'the user message must reach the model with its own source')
  assert.equal(requestText(userRequest), 'first question alpha')

  // Host-side durable facts: the user-rpc entry carries the official Client's
  // resolved browser zone, and the reading is a durable time-context event.
  const events = hostEvents(host)
  const userEvent = events.find(event => event.type === 'user/message' && event.data.source?.kind === 'user')
  assert.ok(userEvent !== undefined, 'the Host must persist the ordinary user message')
  assert.equal(userEvent?.data.source?.clientTimeZone, 'UTC',
    'the Host persists the Client-resolved browser zone, never the process fallback')
  assert.equal(typeof userEvent?.data.source?.rpcId, 'string')
  const injectedEvents = events.filter(event => event.type === 'user/message' && event.data.source?.kind === 'time-context')
  assert.equal(injectedEvents.length, 1, 'exactly one durable time-context event')
  assert.equal(injectedEvents[0]?.data.source?.form, 'snapshot')
  assert.equal(injectedEvents[0]?.data.source?.sections?.[0]?.name, 'time-context')

  // The derived history CARRIES every earlier durable reading, so "a new
  // injection happened" is proven by the reading's own turn label, not by the
  // mere presence of a time-context message in the request.
  const readingsOf = (messages: readonly RequestShape[]): string[] => timeContextMessages(messages).map(requestText)

  // ── Turn 2: ONE millisecond below the default window → NO new reading ─────
  clock.advanceTo(REFRESH_MS - 1)
  await promptViaClient(sessions, 'second question beta')
  await waitFor('the second model request', () => llm.requests.length >= 2, 20_000)
  await waitForTurnEnd(host, 2)
  const second = readingsOf(llm.requests[1]!)
  assert.equal(second.length, 1, `turn 2 carries only the earlier durable reading: ${JSON.stringify(second)}`)
  assert.equal(second.some(reading => reading.includes('preparing turn 2')), false,
    'a step inside the window adds no new time reading (so the default is GREATER than 599999 ms)')

  // ── Turn 3: exactly AT the window → a NEW reading with the elapsed gap ────
  clock.advanceTo(REFRESH_MS)
  await promptViaClient(sessions, 'third question gamma')
  await waitFor('the third model request', () => llm.requests.length >= 3, 20_000)
  await waitForTurnEnd(host, 3)
  const third = readingsOf(llm.requests[2]!)
  const turn3 = third.filter(reading => reading.includes('preparing turn 3'))
  assert.equal(turn3.length, 1,
    `a step exactly at the window injects one new reading (so the default is NOT GREATER than 600000 ms): ${JSON.stringify(third)}`)
  assert.equal(third.length, 2, 'the new reading joins the carried earlier one')
  assert.ok(turn3[0]!.includes('Time sampled while preparing turn 3, step 1:'), turn3[0])
  // The preceding model-visible message is turn 2's own assistant reply, so the
  // gap is 1 ms here — the exact value is not the point; the interval bracket is.
  assert.ok(/Elapsed since the preceding model-visible message: (?:\d+d )?(?:\d+h )?(?:\d+m )?\d+s\./u.test(turn3[0]!), turn3[0])

  assert.equal(hostEvents(host).filter(event => event.type === 'user/message' && event.data.source?.kind === 'time-context').length, 2,
    'the durable log holds exactly the two injected readings')
})

test('L5 negative: with NO time-context plugin mounted, no reading is ever injected', async (t) => {
  // This is the "no plugin row" control (the state the official `minimal`
  // composition produces, evidenced separately by the generated-preset
  // composition assertion below) — NOT a run of the official minimal preset.
  const life = testLifecycle(t)
  const { host, sessions, llm } = await prepareTimeContextHost(life, { plugin: false })

  await promptViaClient(sessions, 'no plugin question')
  await waitFor('the model request', () => llm.requests.length >= 1, 20_000)
  await waitForTurnEnd(host, 1)
  assert.equal(timeContextMessages(llm.requests[0]!).length, 0)
  assert.equal(hostEvents(host).some(event => event.type === 'user/message' && event.data.source?.kind === 'time-context'), false,
    'a composition without the plugin never produces a time-context reading')
})

test('L5 negative: a message with no Client zone reports the browser zone unavailable, never the process zone', async (t) => {
  const life = testLifecycle(t)
  // No `timeZone` config either: the plugin falls back to the PROCESS zone
  // (UTC in this suite) for the timestamp label, which must NOT be presented as
  // the user's browser zone.
  const { host, llm } = await prepareTimeContextHost(life, { plugin: true, config: {} })

  // A Host-local (TUI-free) user message carries no official Client zone.
  const agent = await host.harness.create(
    SessionId('s3-time-context-nozone'),
    { provider: 'smoke', model: 'smoke' },
    { cwd: host.anchorDir },
  )
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'no browser zone' }], source: { kind: 'user' } }))
  await waitFor('the no-zone model request', () => llm.requests.length >= 1, 20_000)

  const readings = timeContextMessages(llm.requests[0]!).map(requestText)
  assert.equal(readings.length, 1)
  const text = readings[0]!
  assert.ok(text.includes('Browser time zone for this request: unavailable.'), text)
  assert.ok(text.includes('Ask the user to clarify otherwise-unqualified dates and times.'), text)
  // The fallback process zone still labels the TIMESTAMP: the two facts stay
  // distinct, which is exactly the conflation the plan forbids.
  assert.ok(text.includes('[UTC]'), text)
})

test('L6: the real durable reading folds into ONE legal Context row and survives every display preset', async (t) => {
  const life = testLifecycle(t)
  const { host, sessions } = await prepareTimeContextHost(life, { plugin: true })
  await promptViaClient(sessions, 'presentation question delta')
  await waitForTurnEnd(host, 1)

  // The REAL official durable events, folded by the PRODUCTION folder.
  const folder = new TranscriptFolder()
  folder.apply(hostEvents(host) as unknown as SessionEvent[])
  const messages = folder.messages()
  const contextRows = messages.filter(message => message.kind === 'system'
    && message.contextPresentation?.sourceKind === 'time-context')
  assert.equal(contextRows.length, 1, 'exactly one folded Context row for the durable reading')
  const row = contextRows[0]!
  assert.equal(row.kind, 'system')
  if (row.kind !== 'system') throw new Error('unreachable')
  assert.equal(row.contextPresentation?.form, 'snapshot')
  assert.equal(row.contextPresentation?.role, 'inject')
  assert.ok(row.text.includes('Time sampled while preparing turn 1, step 1:'), row.text)

  const views: Record<string, string> = {}
  for (const preset of ['full', 'compact', 'focus'] as const) {
    const vt = new VirtualTerminal(100, 30)
    // The TUI claims a process-global slot: one live surface at a time.
    const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} }, { displayState: { preset } })
    app.start()
    try {
      app.setTranscript(messages, folder.turnActivities())
      await vt.waitForRender()
      views[preset] = vt.getViewport().map(line => line.replace(/\x1b\[[0-9;]*m/gu, '')).join('\n')
    } finally {
      app.dispose()
    }
  }
  // Ambient context collapses by default in every preset; the DURABLE row is
  // proven present by the fold assertions above, and the surface must name the
  // producer without losing or duplicating it.
  assert.ok(views.full!.includes('time-context'), views.full)
  assert.ok(views.full!.includes('Context'), views.full)
  assert.match(views.compact!, /Context/u)
  assert.match(views.focus!, /Context/u)
})

test('the generated official presets enable time-context exactly once, and minimal not at all', () => {
  const root = join(import.meta.dirname, '..', 'generated', 'dsh-presets')
  const count = (file: string): number =>
    (readFileSync(join(root, file), 'utf8').match(/@deepseek-ai\/dsh-time-context/gu) ?? []).length
  assert.equal(count('standard.patch.yml'), 1)
  assert.equal(count('ptc.patch.yml'), 1)
  assert.equal(count('cordis.patch.yml'), 1)
  assert.equal(count('minimal.patch.yml'), 0)
})
