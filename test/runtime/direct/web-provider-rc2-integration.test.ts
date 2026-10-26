/**
 * S2/PR-B §3.1/§3.4 — the Web Search / Fetch Host execution qualification (L5).
 *
 * SOURCE → DECISION → SINK: the OFFICIAL `web` seam selects a provider at CALL
 * time from its live volatile configuration; the TUI's `WebProviderConfig`
 * writes the official `web` / `web-deepseek-api` settings sections through the
 * real Loader/ConfigEditor/SettingsForms plane; the NEXT call therefore reaches
 * the other provider's endpoint, with the count, the credential and the
 * triggering question the configuration declares — and the real `tool-web`
 * delivers that outcome to the model-facing tool result.
 *
 * FIXTURE (real): the official Agent-loop prerequisites, the real configuration
 * plane (`test/support/web-provider-plane.ts`) mounting the SAME rows `dsh-base`
 * mounts, the real `dsh-credentials-local` store, a real Agent/Session and the
 * real `tool-web`. STAND-IN: the OUTER HTTP transport (`globalThis.fetch`) only
 * — no provider, credential, selection or settings behaviour is replaced.
 * ABSENT: a real DeepSeek account, network egress, the user's real DSH_HOME.
 *
 * @module @xmoon76/dsh-pi-tui/web-provider-rc2-integration.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness, type AgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { DirectWebProviderConfig } from '../../../src/runtime/direct/config-direct.ts'
import { mountWebProviderPlane } from '../../support/web-provider-plane.ts'
import { testLifecycle, type TestLifecycle } from '../../support/temp-lifecycle.ts'
import { selectSettingsCategory } from '../../support/settings-rail.ts'

const SESSION = 'session-web-l5'
const QUESTION = 'what changed in the last release of the harness?'
const MESSAGES_ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages'
const SEARCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/search'
const FETCH_ENDPOINT = 'https://api.deepseek.com/v1/tools/fetch'
/** The base the NEW test confirms through the UI endpoint editor. */
const CONSUMER_BASE = 'https://gateway.example.test/r4/v1/tools'

interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly authorization: string | undefined
  readonly body: Record<string, unknown> | undefined
}

interface Transport {
  readonly requests: RecordedRequest[]
  /** Per-endpoint scripted outcome; the default answers every endpoint. */
  respond: (url: string) => { readonly status: number; readonly json: unknown }
  restore(): void
}

/** Install the OUTER transport stand-in: the only replaced boundary. */
function installTransport(): Transport {
  const requests: RecordedRequest[] = []
  const original = globalThis.fetch
  const transport: Transport = {
    requests,
    respond: (url: string) => {
      if (url === MESSAGES_ENDPOINT) {
        return {
          status: 200,
          json: {
            content: [{
              type: 'web_search_tool_result',
              content: [{ type: 'web_search_result', url: 'https://example.test/messages', title: 'Messages result', page_age: '2026-02-01' }],
            }],
          },
        }
      }
      if (url === SEARCH_ENDPOINT) {
        return { status: 200, json: { results: [{ url: 'https://example.test/api', title: 'API result', snippet: 'api snippet', date: null }] } }
      }
      if (url === FETCH_ENDPOINT) return { status: 200, json: { content: '# fetched page' } }
      if (url === `${CONSUMER_BASE}/search`) {
        return { status: 200, json: { results: [{ url: 'https://example.test/r4-consumer', title: 'R4 consumer result', snippet: 'r4', date: null }] } }
      }
      if (url === `${CONSUMER_BASE}/fetch`) return { status: 200, json: { content: '# r4 fetched page' } }
      return { status: 404, json: { error: { message: `unexpected endpoint ${url}` } } }
    },
    restore() { globalThis.fetch = original },
  }
  globalThis.fetch = (async (input: string | URL | { url?: string }, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input.url)
    const headers = (init?.headers ?? {}) as Record<string, string>
    requests.push({
      url,
      method: init?.method ?? 'GET',
      authorization: headers.authorization ?? headers.Authorization,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined,
    })
    const outcome = transport.respond(url)
    return new Response(JSON.stringify(outcome.json), { status: outcome.status, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return transport
}

interface Booted {
  readonly ctx: Context
  readonly agent: Agent
  readonly config: DirectWebProviderConfig
  readonly transport: Transport
}

/** Mount the real Web provider composition over the real configuration plane. */
async function boot(life: TestLifecycle): Promise<Booted> {
  const workRoot = life.tempDir('dsh-s2b-web-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Loader)
  await ctx.plugin(LocalCredentials, { path: join(workRoot, '.credentials.yaml'), watch: false })
  await mountWebProviderPlane(ctx, workRoot)
  const harness: AgentLoopTestHarness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(SESSION), {}, { cwd: workRoot })
  // One completed human turn: the official provider reads the latest human
  // prompt of the INITIATING session for `ori_question`.
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', {
    id: 'user-l5' as never,
    role: 'user',
    content: [{ type: 'text', text: QUESTION }],
    source: { kind: 'user' },
  } as never, { surfaceOp: 'append' } as never)
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  await (ctx.get('credentials') as { set(ref: unknown, secret: string): Promise<unknown> })
    .set(credentialRef('DEEPSEEK_API_KEY'), 'l5-test-key')
  const transport = installTransport()
  life.defer(transport.restore)
  return { ctx, agent, config: new DirectWebProviderConfig(ctx as never), transport }
}

/** One search inside the OFFICIAL initiator boundary (the same boundary the
 *  agent loop establishes for a tool dispatch). */
function searchAsInitiator(booted: Booted, query: string): Promise<{ sources: readonly { url: string; title?: string }[] }> {
  const agents = booted.ctx.get('agents') as { withInitiator<T>(agent: Agent, operation: () => T): T }
  return agents.withInitiator(booted.agent, () =>
    (booted.ctx.get('web') as { search(request: { query: string; maxResults?: number }): Promise<{ sources: readonly { url: string; title?: string }[] }> })
      .search({ query }))
}

test('the shipped defaults select the Messages search and the HTTP fetch providers', async t => {
  const life = testLifecycle(t)
  const booted = await boot(life)

  const result = await searchAsInitiator(booted, 'release notes')
  assert.deepEqual(result.sources.map(source => source.url), ['https://example.test/messages'])
  assert.deepEqual(booted.transport.requests.map(request => request.url), [MESSAGES_ENDPOINT])
  assert.equal(booted.transport.requests[0]?.authorization, 'Bearer l5-test-key',
    'the official credential store supplies the key; no literal key is configured')

  // The default FETCH provider is the anonymous HTTP fetcher: it refuses a
  // non-public destination LOCALLY (no request leaves the process), which is
  // how this fixture proves the selection without network egress.
  const web = booted.ctx.get('web') as { fetch(request: { url: string }): Promise<unknown> }
  await assert.rejects(web.fetch({ url: 'http://127.0.0.1:9/page' }), (error: unknown) => {
    assert.match(String((error as Error).message), /non-public IP/u)
    return true
  })
  assert.deepEqual(booted.transport.requests.map(request => request.url), [MESSAGES_ENDPOINT],
    'the HTTP provider never reached the outer transport')
})

test('a TUI settings write switches the NEXT search to the DeepSeek Search API with its options', async t => {
  const life = testLifecycle(t)
  const booted = await boot(life)

  await booted.config.setSearchProvider('deepseek-search-api')
  await booted.config.setSearchApiCount(20)
  assert.deepEqual(await booted.config.read(), {
    searchProvider: 'deepseek-search-api',
    fetchProvider: 'http',
    api: { baseURL: 'https://api.deepseek.com/v1/tools', count: 20, sendOriginalQuestion: true },
    credential: { configured: true, source: 'file' },
  }, 'the read-back is the authority the UI displays')

  const result = await searchAsInitiator(booted, 'second query')
  assert.deepEqual(result.sources.map(source => source.url), ['https://example.test/api'])
  assert.deepEqual(booted.transport.requests.map(request => request.url), [SEARCH_ENDPOINT],
    'the NEXT search uses the newly selected provider — the change is live, not a restart')
  assert.deepEqual(booted.transport.requests[0]?.body, {
    query: 'second query',
    count: 20,
    need_content: false,
    ori_question: QUESTION,
  }, 'the count and the initiating human question ride the request')
  assert.equal(booted.transport.requests[0]?.authorization, 'Bearer l5-test-key')

  // sendOriginalQuestion=false removes the field on the next call only.
  await booted.config.setSendOriginalQuestion(false)
  await searchAsInitiator(booted, 'third query')
  assert.deepEqual(booted.transport.requests[1]?.body, { query: 'third query', count: 20, need_content: false })

  // A custom endpoint is used verbatim (the human confirmed it in the UI), and
  // the reset back to the default provider reaches the Messages endpoint again.
  await booted.config.setSearchApiBaseURL('https://gateway.example.test/deepseek/v1/tools')
  const respondDefault = booted.transport.respond
  booted.transport.respond = url => url === 'https://gateway.example.test/deepseek/v1/tools/search'
    ? { status: 200, json: { results: [{ url: 'https://example.test/gateway', title: 'Gateway result', snippet: '', date: null }] } }
    : respondDefault(url)
  const custom = await searchAsInitiator(booted, 'fourth query')
  assert.deepEqual(custom.sources.map(source => source.url), ['https://example.test/gateway'])
  assert.equal(booted.transport.requests[2]?.url, 'https://gateway.example.test/deepseek/v1/tools/search')
  await booted.config.setSearchProvider('deepseek-official')
  await searchAsInitiator(booted, 'fifth query')
  assert.equal(booted.transport.requests[3]?.url, MESSAGES_ENDPOINT, 'the reset is live too')
})

test('the real web_search tool delivers the selected provider result to the model-facing outcome', async t => {
  const life = testLifecycle(t)
  const booted = await boot(life)
  await booted.config.setSearchProvider('deepseek-search-api')

  const result = await booted.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId('web-l5-tool-call'),
    name: 'web_search',
    arguments: { queries: ['harness release'] },
    agent: booted.agent,
  })
  const text = ((result.content ?? []) as readonly { readonly text?: string }[]).map(block => block.text ?? '').join('\n')
  assert.match(text, /https:\/\/example\.test\/api/u, `the tool result carries the selected provider's source:\n${text}`)
  assert.equal(booted.transport.requests.length, 1)
  assert.equal(booted.transport.requests[0]?.url, SEARCH_ENDPOINT)
})

test('a missing credential fails with the official error and NEVER falls back to the other provider', async t => {
  const life = testLifecycle(t)
  const booted = await boot(life)
  await booted.config.setSearchProvider('deepseek-search-api')
  await (booted.ctx.get('credentials') as { unset(ref: unknown): Promise<unknown> })
    .unset(credentialRef('DEEPSEEK_API_KEY'))

  await assert.rejects(searchAsInitiator(booted, 'no credential'), (error: unknown) => {
    const webError = error as { code?: string; message: string }
    assert.equal(webError.code, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    assert.match(webError.message, /DEEPSEEK_API_KEY/u)
    return true
  })
  assert.deepEqual(booted.transport.requests, [], 'no silent fallback and no dispatched request')
})

test('endpoint failures keep the official error shape and switch nothing', async t => {
  const life = testLifecycle(t)
  const booted = await boot(life)
  await booted.config.setSearchProvider('deepseek-search-api')

  booted.transport.respond = () => ({ status: 401, json: { error: { message: 'invalid api key' } } })
  await assert.rejects(searchAsInitiator(booted, 'rejected'), (error: unknown) => {
    const webError = error as { code?: string; message: string }
    assert.equal(webError.code, 'WEB_PROVIDER_ERROR')
    assert.match(webError.message, /invalid api key/u)
    return true
  })
  booted.transport.respond = () => ({ status: 500, json: { error: { message: 'upstream exploded' } } })
  await assert.rejects(searchAsInitiator(booted, 'server error'), /upstream exploded/u)
  assert.deepEqual(booted.transport.requests.map(request => request.url), [SEARCH_ENDPOINT, SEARCH_ENDPOINT],
    'every failure stayed on the selected provider')
  // The configuration is untouched by a call-time failure.
  assert.equal((await booted.config.read())?.searchProvider, 'deepseek-search-api')
})

test('cancellation and the DeepSeek Fetch API path keep their official semantics', async t => {
  const life = testLifecycle(t)
  const booted = await boot(life)
  const web = booted.ctx.get('web') as {
    search(request: { query: string }, signal?: AbortSignal): Promise<unknown>
    fetch(request: { url: string }, signal?: AbortSignal): Promise<unknown>
  }

  const aborted = new AbortController()
  aborted.abort(new Error('test cancellation'))
  await assert.rejects(web.search({ query: 'cancelled' }, aborted.signal), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'WEB_ABORTED')
    return true
  })
  assert.equal(booted.transport.requests.length, 0, 'a cancelled call never dispatches')

  await booted.config.setFetchProvider('deepseek-fetch-api')
  const fetched = await web.fetch({ url: 'https://example.test/page' }) as {
    readonly url: string
    readonly statusCode: number
    readonly body: unknown
  }
  assert.deepEqual(booted.transport.requests.map(request => request.url), [FETCH_ENDPOINT])
  assert.deepEqual(booted.transport.requests[0]?.body, { url: 'https://example.test/page' })
  assert.equal(booted.transport.requests[0]?.authorization, 'Bearer l5-test-key')
  assert.deepEqual(fetched.body, { kind: 'text', content: '# fetched page' })
  assert.equal(fetched.statusCode, 200)
})

// ── D3-2: the settings change → next real tool → mounted TUI sink ──────────

import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { startS4D3Application, type S4D3Application } from '../../support/application-fixture.ts'
import { skippedInstallationReason } from '../../support/optional-bundle-fixture.ts'

class WebL6Adapter extends LlmAdapter {
  private queue: Array<{ readonly kind: 'tool'; name: string; arguments: string; callId: string } | { readonly kind: 'text'; text: string }> = []
  push(script: { readonly kind: 'tool'; name: string; arguments: string; callId: string } | { readonly kind: 'text'; text: string }): void {
    this.queue.push(script)
  }
  override resolveModel(provider: string, model: string): Promise<{ provider: string; id: string; name: string }> {
    return Promise.resolve({ provider, id: model, name: model })
  }
  override async *stream(): AsyncIterable<StreamChunk> {
    const script = this.queue.shift()
    if (script === undefined) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (script.kind === 'text') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: script.text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: script.text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id: script.callId as never, name: script.name, argumentsDelta: script.arguments }
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'tool-call', id: script.callId as never, name: script.name, arguments: script.arguments },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** Read the exact durable tool result of one call id from the same Agent. */
function toolResultOf(agent: Agent, callId: string): string | undefined {
  for (const event of agent.session.snapshotEvents() as readonly { readonly type?: string; readonly data?: unknown }[]) {
    if (event.type !== 'tool/result') continue
    const message = (event.data as { message?: { toolCallId?: unknown; content?: readonly { text?: string }[] } }).message
    if (String(message?.toolCallId) !== callId) continue
    return (message?.content ?? []).map(block => block.text ?? '').join('')
  }
  return undefined
}

const KEY = { down: '\x1b[B', home: '\x1b[H', enter: '\r', esc: '\x1b', clearLine: '\x15' } as const

/** The optional extra fields the real UI flow confirms (all DEFAULT off, so the
 *  original tool test keeps its own settings). */
interface WebTuiWrites {
  /** Confirm Share Original Question `off` (the request must omit ori_question). */
  readonly oriOff?: boolean
  /** Confirm the DeepSeek Fetch API provider. */
  readonly fetchDeepSeekApi?: boolean
  /** Replace the endpoint draft with this base and confirm it. */
  readonly endpoint?: string
}

/** Drive the REAL `/settings → Tools → Web Search / Fetch` page (C2-R4):
 *  confirm the DeepSeek Search API provider and the 20-result count (plus the
 *  optional writes), then leave the workspace. The real ConfigPort + Host
 *  settings mutate/readback performs every write; no Direct config object is
 *  used here. */
async function writeWebSettingsThroughTui(
  app: S4D3Application,
  config: DirectWebProviderConfig,
  writes: WebTuiWrites = {},
): Promise<void> {
  for (const character of '/settings') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput(KEY.enter)
  await app.settle()
  if (app.view().includes('❯ /settings')) {
    app.vt.sendInput(KEY.enter)
    await app.settle()
  }
  await app.waitFor(() => app.view().includes('Settings ·'), 'the Settings workspace')
  // The workspace home is About: walk the rail to Tools, then its Rows level.
  await selectSettingsCategory(app.vt, 'Tools')
  for (const key of [KEY.enter, KEY.down, KEY.enter]) {
    app.vt.sendInput(key)
    await app.settle()
  }
  await app.waitFor(() => app.view().includes('Web Search Provider') && !app.view().includes('Loading…'),
    'the real Web Search / Fetch page')
  // Row 1: Enter opens the Detail, Down highlights DeepSeek Search API, Enter
  // is the ONE explicit confirm. The painted Verified proves the read-back.
  for (const key of [KEY.enter, KEY.down, KEY.enter]) {
    app.vt.sendInput(key)
    await app.settle()
  }
  await app.waitFor(() => app.view().includes('Current: DeepSeek Search API') && app.view().includes('Verified'),
    'the verified search provider write')
  // Back to the list, then row 3 (Search API Result Count): 10 -> 20.
  for (const key of [KEY.esc, KEY.home, KEY.down, KEY.down, KEY.enter, KEY.down, KEY.enter]) {
    app.vt.sendInput(key)
    await app.settle()
  }
  await app.waitFor(() => app.view().includes('Current: 20') && app.view().includes('Verified'),
    'the verified count write')

  /** Back to the page list, first row. */
  const listTop = async (): Promise<void> => {
    for (const key of [KEY.esc, KEY.home]) {
      app.vt.sendInput(key)
      await app.settle()
    }
  }
  /** Home + Down*index + Enter: open one frozen row's Detail. */
  const openRow = async (index: number): Promise<void> => {
    for (let step = 0; step < index; step += 1) app.vt.sendInput(KEY.down)
    app.vt.sendInput(KEY.enter)
    await app.settle()
  }

  if (writes.oriOff === true) {
    await listTop()
    await openRow(3) // Share Original Question
    app.vt.sendInput(KEY.down) // on -> off
    app.vt.sendInput(KEY.enter)
    await app.settle()
    await app.waitFor(() => app.view().includes('Current: off') && app.view().includes('Verified'),
      'the verified Share Original Question off write')
  }
  if (writes.fetchDeepSeekApi === true) {
    await listTop()
    await openRow(1) // Web Fetch Provider
    app.vt.sendInput(KEY.down) // HTTP -> DeepSeek Fetch API
    app.vt.sendInput(KEY.enter)
    await app.settle()
    await app.waitFor(() => app.view().includes('Current: DeepSeek Fetch API') && app.view().includes('Verified'),
      'the verified fetch provider write')
  }
  if (writes.endpoint !== undefined) {
    await listTop()
    await openRow(4) // the endpoint row opens its editor on Enter
    await app.settle()
    app.vt.sendInput(KEY.clearLine) // replace the seeded draft
    for (const character of writes.endpoint) app.vt.sendInput(character)
    await app.settle()
    app.vt.sendInput(KEY.enter)
    await app.settle()
    await app.waitFor(() => app.view().includes(`Current: ${writes.endpoint}`) && app.view().includes('Verified'),
      'the verified endpoint write')
  }
  app.vt.sendInput(KEY.esc) // Detail/editor -> list
  await app.settle()
  // A pending authoritative reload may swallow a close gesture; Esc is
  // idempotent, so close until the workspace really leaves the frame.
  for (let attempt = 0; attempt < 6 && app.view().includes('Settings ·'); attempt += 1) {
    app.vt.sendInput(KEY.esc)
    await app.settle()
  }
  await app.waitFor(() => !app.view().includes('Settings ·'), 'the Settings workspace closes')
}

/** Open `/settings → Tools → Web Search / Fetch` and select the credential row
 *  (Home + five Downs inside the page list). */
async function openWebCredentialRowInApp(app: S4D3Application): Promise<void> {
  for (const character of '/settings') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput(KEY.enter)
  await app.settle()
  if (app.view().includes('❯ /settings')) {
    app.vt.sendInput(KEY.enter)
    await app.settle()
  }
  await app.waitFor(() => app.view().includes('Settings ·'), 'the Settings workspace')
  await selectSettingsCategory(app.vt, 'Tools')
  for (const key of [KEY.enter, KEY.down, KEY.enter]) {
    app.vt.sendInput(key)
    await app.settle()
  }
  await app.waitFor(() => app.view().includes('Web Search Provider') && !app.view().includes('Loading…'),
    'the Web Search / Fetch page')
  for (const key of [KEY.home, KEY.down, KEY.down, KEY.down, KEY.down, KEY.down, KEY.enter]) {
    app.vt.sendInput(key)
    await app.settle()
  }
  await app.waitFor(() => app.view().includes('Reference: DEEPSEEK_API_KEY'),
    'the Web credential row Detail')
}

/** Leave the Settings surface with the real Esc ladder. */
async function closeSettingsInApp(app: S4D3Application): Promise<void> {
  for (let attempt = 0; attempt < 8 && app.view().includes('Settings ·'); attempt += 1) {
    app.vt.sendInput(KEY.esc)
    await app.settle()
  }
  await app.waitFor(() => !app.view().includes('Settings ·'), 'the Settings workspace closes')
}

test('a TUI Web settings write reaches the NEXT real tool call and the mounted transcript', { skip: skippedInstallationReason([]) }, async t => {
  const adapter = new WebL6Adapter()
  const app = await startS4D3Application(t, {
    bundles: [],
    columns: 140,
    rows: 40,
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: async host => {
      host.ctx.llm.registerAdapter(['scripted'], adapter)
      await (host.ctx.get('credentials') as { set(ref: unknown, secret: string): Promise<unknown> })
        .set(credentialRef('DEEPSEEK_API_KEY'), 'd3-web-key')
    },
  })
  const transport = installTransport()
  t.after(transport.restore)
  const config = new DirectWebProviderConfig(app.host.ctx as never)
  await writeWebSettingsThroughTui(app, config)
  // The settings recompose re-read the persisted profile: re-pin the scripted
  // transport (the official default-model write path) before the next turn.
  await (app.host.ctx.get('agentDefaultModel') as { saveSelection(next: unknown): Promise<void> })
    .saveSelection({ provider: 'scripted', model: 'review-model' })
  const written = await config.read()
  assert.equal(written?.searchProvider, 'deepseek-search-api', 'the UI write is the authoritative Host value')
  assert.equal(written?.api.count, 20, 'the UI count write is the authoritative Host value')
  assert.equal(written?.api.sendOriginalQuestion, true, 'the official rc.2 default stays true')
  assert.equal(written?.credential.configured, true)

  adapter.push({ kind: 'tool', name: 'web_search', callId: 's4d3-web-call', arguments: JSON.stringify({ queries: ['harness release'] }) })
  adapter.push({ kind: 'text', text: 'Search complete.' })
  const agent = await app.submitFirstPrompt('Search the release notes')
  await agent.whenIdle()
  await app.waitFor(() => app.view().includes('Search {"queries"'), 'the real web_search Tool card')
  app.vt.sendInput('\x0f') // the existing global expand reveals the full sources
  await app.waitFor(() => app.view().includes('https://example.test/api'), 'the selected provider result in the TUI Tool card')
  assert.equal(transport.requests.length, 1)
  assert.equal(transport.requests[0]?.url, SEARCH_ENDPOINT, 'the NEXT call used the settings-selected endpoint')
  assert.equal(transport.requests[0]?.authorization, 'Bearer d3-web-key')
  assert.deepEqual(transport.requests[0]?.body, {
    query: 'harness release',
    // The web_search TOOL declares its own smaller per-request bound (8), which
    // the row copy documents as winning over the configured 20.
    count: 8,
    need_content: false,
    ori_question: 'Search the release notes',
  }, 'the effective count and the triggering human question ride the official request')
  assert.equal(written?.api.count, 20, 'the configured count is still the authoritative settings value')
  // The original Tool result is the TUI-visible sink; no local provider truth.
  assert.match(app.view(), /https:\/\/example\.test\/api/u)
})

test('a TUI Web settings write reaches the real search and fetch consumers with the confirmed payload', { skip: skippedInstallationReason([]) }, async t => {
  const adapter = new WebL6Adapter()
  const app = await startS4D3Application(t, {
    bundles: [],
    columns: 140,
    rows: 40,
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: async host => {
      host.ctx.llm.registerAdapter(['scripted'], adapter)
      await (host.ctx.get('credentials') as { set(ref: unknown, secret: string): Promise<unknown> })
        .set(credentialRef('DEEPSEEK_API_KEY'), 'd3-r4-key')
    },
  })
  const transport = installTransport()
  t.after(transport.restore)
  const config = new DirectWebProviderConfig(app.host.ctx as never)
  // EVERY write below is an explicit confirm in the real Web page: search
  // provider, count, Share Original Question off, DeepSeek Fetch API and a new
  // endpoint base.
  await writeWebSettingsThroughTui(app, config, {
    oriOff: true,
    fetchDeepSeekApi: true,
    endpoint: CONSUMER_BASE,
  })
  // The settings recompose re-read the persisted profile: re-pin the scripted
  // transport before the next turn (the official default-model write path).
  await (app.host.ctx.get('agentDefaultModel') as { saveSelection(next: unknown): Promise<void> })
    .saveSelection({ provider: 'scripted', model: 'review-model' })
  const written = await config.read()
  assert.equal(written?.searchProvider, 'deepseek-search-api', 'the UI write is the authoritative search provider')
  assert.equal(written?.fetchProvider, 'deepseek-fetch-api', 'the UI write is the authoritative fetch provider')
  assert.equal(written?.api.count, 20, 'the UI count write is the authoritative settings value')
  assert.equal(written?.api.sendOriginalQuestion, false, 'the UI off write is the authoritative question-sharing value')
  assert.equal(written?.api.baseURL, CONSUMER_BASE, 'the UI endpoint write is the authoritative base')

  // ONE real Session/Agent anchors the initiator boundary the official Web
  // service reads for ori_question.
  adapter.push({ kind: 'text', text: 'ready' })
  const agent = await app.submitFirstPrompt('R4 consumer question')
  await agent.whenIdle()
  const web = app.host.ctx.get('web') as {
    search(request: { query: string }): Promise<{ sources: readonly { url: string }[] }>
    fetch(request: { url: string }): Promise<{ readonly url: string; readonly statusCode: number; readonly body: unknown }>
  }
  const agents = app.host.ctx.get('agents') as { withInitiator<T>(agent: Agent, operation: () => T): T }

  // The REAL search consumer: count 20 is the actual request value (no tool
  // per-request clamp masks it), the custom endpoint is the HTTP target, and
  // Share Original Question off omits ori_question entirely.
  const search = await agents.withInitiator(agent, () => web.search({ query: 'r4 query' }))
  assert.deepEqual(search.sources.map(source => source.url), ['https://example.test/r4-consumer'])
  const searchRequest = transport.requests.at(-1)
  assert.equal(searchRequest?.url, `${CONSUMER_BASE}/search`, 'the UI-confirmed endpoint is the real search target')
  assert.deepEqual(searchRequest?.body, {
    query: 'r4 query',
    count: 20,
    need_content: false,
  }, 'the UI-confirmed count and off value reach the official request')
  assert.equal(searchRequest?.authorization, 'Bearer d3-r4-key')

  // The REAL fetch consumer: the UI-confirmed DeepSeek Fetch API provider and
  // the same endpoint base are what the next fetch uses.
  const fetched = await web.fetch({ url: 'https://example.test/r4-page' })
  const fetchRequest = transport.requests.at(-1)
  assert.equal(fetchRequest?.url, `${CONSUMER_BASE}/fetch`, 'the UI-confirmed fetch provider/base is the real fetch target')
  assert.deepEqual(fetchRequest?.body, { url: 'https://example.test/r4-page' })
  assert.equal(fetchRequest?.authorization, 'Bearer d3-r4-key')
  assert.equal(fetched.url, 'https://example.test/r4-page')
  assert.equal(fetched.statusCode, 200)
  assert.deepEqual(fetched.body, { kind: 'text', content: '# r4 fetched page' })
})

test('the Web credential deeplink completes a real store set and clear and the page re-reads the fresh presence', { skip: skippedInstallationReason([]) }, async t => {
  const adapter = new WebL6Adapter()
  const app = await startS4D3Application(t, {
    bundles: [],
    columns: 140,
    rows: 40,
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  const transport = installTransport()
  t.after(transport.restore)
  const config = new DirectWebProviderConfig(app.host.ctx as never)
  assert.equal((await config.read())?.credential.configured, false, 'the fixture starts without the key')

  // 1) Web credential row → Configure in Models… → the masked input → the REAL
  //    official credential store.
  await openWebCredentialRowInApp(app)
  app.vt.sendInput(KEY.enter) // Configure in Models…
  await app.settle()
  await app.waitFor(() => app.view().includes('Settings · Models') && app.view().includes('API Key Reference'),
    'the Models reference page')
  app.vt.sendInput(KEY.enter) // open the masked key prompt
  await app.settle()
  await app.waitFor(() => /Enter the API key/u.test(app.view()), 'the masked key prompt')
  for (const character of 'r4-store-key') app.vt.sendInput(character)
  await app.settle()
  app.vt.sendInput(KEY.enter)
  await app.settle()
  app.vt.sendInput(KEY.enter)
  await app.settle()
  await app.waitFor(() => app.view().includes('Verified'), 'the verified credential set')
  assert.doesNotMatch(app.view(), /r4-store-key/u, 'the secret is never rendered back')
  const afterSet = await config.read()
  assert.equal(afterSet?.credential.configured, true, 'the REAL credential store reports the reference configured')

  // 2) Re-enter the Web page: the fresh official presence is Configured.
  await closeSettingsInApp(app)
  await openWebCredentialRowInApp(app)
  assert.match(app.view(), /State: Configured/u, `the Web page reads the fresh presence:\n${app.view()}`)

  // 3) A real search authenticates with the key the UI just stored. The search
  //    PROVIDER is arranged through the port here (this case's subject is the
  //    credential chain); the search path itself is the production consumer.
  await closeSettingsInApp(app)
  await config.setSearchProvider('deepseek-search-api')
  await (app.host.ctx.get('agentDefaultModel') as { saveSelection(next: unknown): Promise<void> })
    .saveSelection({ provider: 'scripted', model: 'review-model' })
  adapter.push({ kind: 'text', text: 'ready' })
  const agent = await app.submitFirstPrompt('R4 credential question')
  await agent.whenIdle()
  const web = app.host.ctx.get('web') as {
    search(request: { query: string }): Promise<{ sources: readonly { url: string }[] }>
  }
  const agents = app.host.ctx.get('agents') as { withInitiator<T>(agent: Agent, operation: () => T): T }
  await agents.withInitiator(agent, () => web.search({ query: 'credentialed query' }))
  const credentialed = transport.requests.at(-1)
  assert.equal(credentialed?.url, SEARCH_ENDPOINT)
  assert.equal(credentialed?.authorization, 'Bearer r4-store-key', 'the stored key is the auth material')

  // 4) Web credential row → Clear in Models… → the REAL unset; the page then
  //    reads Not configured and the next real search fails closed (no fallback).
  await openWebCredentialRowInApp(app)
  assert.match(app.view(), /State: Configured/u)
  app.vt.sendInput(KEY.down) // Configure -> the enabled Clear in Models…
  app.vt.sendInput(KEY.enter)
  await app.settle()
  await app.waitFor(() => app.view().includes('Settings · Models') && /Clear credential/u.test(app.view()),
    'the Models clear confirmation')
  app.vt.sendInput(KEY.enter) // the ONE explicit clear confirmation
  await app.settle()
  await app.waitFor(() => /cleared/u.test(app.view()), 'the confirmed clear result')
  const afterClear = await config.read()
  assert.equal(afterClear?.credential.configured, false, 'the REAL credential store reports the reference cleared')
  await closeSettingsInApp(app)
  await openWebCredentialRowInApp(app)
  assert.match(app.view(), /State: Not configured/u, `the Web page reads the fresh absence:\n${app.view()}`)

  const requestsBefore = transport.requests.length
  await assert.rejects(agents.withInitiator(agent, () => web.search({ query: 'no credential' })), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'WEB_PROVIDER_CREDENTIAL_MISSING')
    return true
  })
  assert.equal(transport.requests.length, requestsBefore, 'no silent fallback and no dispatched request')
})

test('the missing-credential error reaches the TUI and the selected provider is never bypassed', { skip: skippedInstallationReason([]) }, async t => {
  const adapter = new WebL6Adapter()
  const app = await startS4D3Application(t, {
    bundles: [],
    columns: 140,
    rows: 40,
    patches: [{ id: 'agent-default-model', config: { provider: 'scripted', model: 'review-model' } }] as never,
    prepareHost: host => { host.ctx.llm.registerAdapter(['scripted'], adapter) },
  })
  const transport = installTransport()
  t.after(transport.restore)
  const config = new DirectWebProviderConfig(app.host.ctx as never)
  await writeWebSettingsThroughTui(app, config)
  assert.equal((await config.read())?.searchProvider, 'deepseek-search-api')
  await (app.host.ctx.get('agentDefaultModel') as { saveSelection(next: unknown): Promise<void> })
    .saveSelection({ provider: 'scripted', model: 'review-model' })
  adapter.push({ kind: 'tool', name: 'web_search', callId: 's4d3-web-missing', arguments: JSON.stringify({ queries: ['no credential'] }) })
  adapter.push({ kind: 'text', text: 'Search failed.' })
  const agent = await app.submitFirstPrompt('Search without a credential')
  await agent.whenIdle()
  const refused = toolResultOf(agent, 's4d3-web-missing')
  assert.ok(refused !== undefined, `the exact web_search call settles as a tool result:\n${String(refused)}`)
  assert.match(refused!, /DEEPSEEK_API_KEY|MISSING_CREDENTIAL|no API key/iu,
    'the official missing-credential error is the TOOL result, not the user prompt')
  await app.waitFor(() => /DEEPSEEK_API_KEY|MISSING_CREDENTIAL|no API key/iu.test(app.view()),
    'the same official error is painted in the TUI')
  assert.deepEqual(transport.requests, [], 'no silent fallback and no dispatched request')
})
