/**
 * Headless tests for the rc.1 authorization surface: the login-target merge
 * (reference vs authorization per route), the authorization interaction
 * bridge (notices, text/secret/select prompts, decline vs prompt-signal
 * withdrawal), and the /login /logout command paths through the seam —
 * including the no-accidental-auth-path-mismatch regression (an explicit
 * apiKeyEnv route must keep the reference path even with a flow present)
 * and record logout. The legacy reference behavior stays pinned in
 * test/login-credentials.test.ts.
 * @module @xmoon76/dsh-pi-tui/authorization-login.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands'
import {
  registerTuiCommands,
  type TuiCommandRunner,
} from '../src/commands.ts'
import {
  authorizationFailureText,
  authorizationTargets,
  createAuthorizationInteraction,
  flowForRoute,
  formatAuthorizationNotice,
  mergeLoginTargets,
  type AuthorizationSurface,
  type AuthorizationTarget,
} from '../src/authorization.ts'
import { providerOptionsFor, type ProviderCatalogEntry } from '../src/provider-catalog.ts'
import { QuestionFlow, type QuestionFlowQuestion } from '../src/question.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** The llm-pi-ai settings section: openai names its key explicitly,
 * anthropic is keyless (record auth), openrouter has NO profile yet (the
 * authorize-then-provision case). */
const LLM_PI_AI_SECTION = {
  providers: {
    openai: { apiKeyEnv: 'CUSTOM_OPENAI_KEY' },
    anthropic: { apiKeyEnv: undefined },
  },
}

/** A fake credentials service recording set/unset/deleteRecord. */
function fakeCredentials(records: { key: string; kind?: string }[] = [{ key: 'llm-pi-ai/openai', kind: 'api-key' }]) {
  const sets: string[] = []
  const unsets: string[] = []
  const deletes: string[] = []
  return {
    sets,
    unsets,
    deletes,
    service: {
      set: async (ref: string, key: string): Promise<void> => { sets.push(`${ref}=${key}`) },
      unset: async (ref: string): Promise<void> => { unsets.push(ref) },
      describe: async (): Promise<{ configured: boolean; source?: string }> => ({ configured: true }),
      listRecords: async (): Promise<{ key: string; kind?: string }[]> => [...records],
      deleteRecord: async (key: string): Promise<void> => { deletes.push(key) },
    },
  }
}

/** A fake settings service serving the llm-pi-ai section, recording writes. */
function fakeSettings() {
  const mutations: { ns: string; ops: unknown[] }[] = []
  return {
    mutations,
    service: {
      get: (ns: string): unknown => (ns === 'llm-pi-ai' ? LLM_PI_AI_SECTION : undefined),
      mutate: async (ns: string, ops: unknown[]): Promise<void> => { mutations.push({ ns, ops }) },
    },
  }
}

type FakeFlow = { key: string; label: string; methods: { id: string; label: string }[]; inFlight?: boolean }

/** A fake authorization service recording begin calls; the test drives the
 *  outcome and errors. */
function fakeAuthorization(options: { flows?: FakeFlow[]; beginResult?: { status: 'authorized' | 'cancelled' }; beginError?: Error & { code?: string } } = {}) {
  const begins: { key: string; method?: string; signal?: AbortSignal; interaction: unknown }[] = []
  const flows = options.flows ?? [
    { key: 'llm-pi-ai/anthropic', label: 'Anthropic', methods: [{ id: 'oauth', label: 'OAuth' }] },
    { key: 'llm-pi-ai/openrouter', label: 'openrouter', methods: [{ id: 'oauth', label: 'OAuth' }] },
  ]
  return {
    begins,
    service: {
      list: () => flows.map(flow => ({
        key: flow.key,
        label: flow.label,
        methods: flow.methods,
        inFlight: flow.inFlight === true,
      })),
      describe: (key: string) => {
        const flow = flows.find(candidate => candidate.key === key)
        return flow === undefined ? undefined : { key: flow.key, label: flow.label, methods: flow.methods, inFlight: false }
      },
      begin: async (request: { key: string; method?: string; interaction: unknown; signal?: AbortSignal }) => {
        begins.push(request)
        if (options.beginError !== undefined) throw options.beginError
        return options.beginResult ?? { status: 'authorized' }
      },
      cancel: () => {},
    },
  }
}

/** A fake llm service exposing a configurable-provider directory. */
function fakeLlm(directory: ProviderCatalogEntry[]) {
  return {
    service: {
      listConfigurableProviders: () => directory,
      discoverModels: async () => [{ id: 'm1' }],
    },
  }
}

const DIRECTORY: ProviderCatalogEntry[] = [
  { provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] },
  { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
  { provider: 'openrouter', displayName: 'openrouter', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openrouter'] },
]

/** A stub runner with the same surface preset-command.test.ts uses. */
function stubRunner(ctx: Context, app: TuiApp): TuiCommandRunner {
  return {
    ctx,
    app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return undefined },
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: undefined,
    agents: {} as never,
    sessions: { flush: async () => {} },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    compose: async () => ({ setup: () => {} }),
    switchSession: async () => undefined,
    swapTo: async () => undefined,
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
}

function invoke(rawInput: string): CommandInvocation {
  return {
    commandId: CommandId('cmd-test-1'),
    agent: undefined as unknown as Agent,
    rawInput,
    attachments: [],
    signal: new AbortController().signal,
  }
}

/** Register the TUI commands with fake services and return the handlers. */
function setup(options: {
  flows?: FakeFlow[]
  records?: { key: string; kind?: string }[]
  begin?: { status: 'authorized' | 'cancelled' }
  beginError?: Error & { code?: string }
  pick?: (items: readonly { value: string; label?: string; group?: string }[]) => string
} = {}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const commands = {
    defs: [] as { name: string; handler?: unknown }[],
    service: {
      register: (def: { name: string; handler?: unknown }): (() => void) => { commands.defs.push(def); return () => {} },
      list: () => [{ name: 'builtin', description: 'a builtin', input: { hint: '' } }],
      find: () => undefined,
      execute: async () => undefined,
    },
  }
  ctx.provide('commands', commands.service as never)
  const credentials = fakeCredentials(options.records)
  ctx.provide('credentials', credentials.service as never)
  const settings = fakeSettings()
  ctx.provide('settings', settings.service as never)
  const llm = fakeLlm(DIRECTORY)
  ctx.provide('llm', llm.service as never)
  const authorization = fakeAuthorization({
    flows: options.flows,
    beginResult: options.begin,
    beginError: options.beginError,
  })
  ctx.provide('authorization', authorization.service as never)
  const runner = stubRunner(ctx, app)
  registerTuiCommands(runner)
  app.askQuestions = async () => [{ id: 'key', selected: [], custom: 'sk-test' }] as never
  app.openPicker = ((items: readonly { value: string; label?: string; group?: string }[], onSelect: (value: string) => void) => {
    onSelect((options.pick ?? ((rows) => rows[0]!.value))(items))
    return { close: () => {}, setItems: () => {} }
  }) as never
  const login = commands.defs.find(entry => entry.name === 'login')
  const logout = commands.defs.find(entry => entry.name === 'logout')
  assert.ok(login?.handler !== undefined, 'login handler missing')
  assert.ok(logout?.handler !== undefined, 'logout handler missing')
  const run = async <T>(def: { handler?: unknown }, rawInput: string): Promise<T> =>
    (def!.handler as (inv: CommandInvocation) => Promise<T>)(invoke(rawInput))
  return { app, credentials, settings, authorization, runner, run, login, logout }
}

function flow(key: string, label: string, methods: { id: string; label: string }[], inFlight = false) {
  return { key, label, methods, inFlight }
}

// ── §17.5 target resolution (pure) ─────────────────────────────────────────

test('mergeLoginTargets: configured apiKeyEnv route wins over its flow', () => {
  const section = { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } }
  const options = providerOptionsFor(DIRECTORY, ns => (ns === 'llm-pi-ai' ? section : undefined))
  const targets = authorizationTargets([{
    key: credentialKey('llm-pi-ai', 'openai'),
    label: 'openai',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    inFlight: false,
  }])
  const merged = mergeLoginTargets(options, targets)
  assert.equal(
    merged.find(target => target.kind === 'authorization' && target.route === 'openai'),
    undefined,
    'a flow must not be offered as a second default entry for a route that names its key',
  )
  const reference = merged.find(target => target.kind === 'reference' && target.route === 'openai')
  assert.ok(reference !== undefined && reference.kind === 'reference')
  assert.equal(reference.ref, 'OPENAI_API_KEY')
})

test('mergeLoginTargets: keyless route with a flow wins the authorization target', () => {
  const section = { providers: { anthropic: {} } }
  const options = providerOptionsFor(DIRECTORY, ns => (ns === 'llm-pi-ai' ? section : undefined))
  const targets = authorizationTargets([{
    key: credentialKey('llm-pi-ai', 'anthropic'),
    label: 'Anthropic',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    inFlight: false,
  }])
  const merged = mergeLoginTargets(options, targets)
  const anthropic = merged.find(target => target.route === 'anthropic')
  assert.ok(anthropic !== undefined && anthropic.kind === 'authorization')
  assert.equal(merged.find(target => target.kind === 'reference' && target.route === 'anthropic'), undefined,
    'a keyless route with a flow must not offer the derived reference as a default')
})

test('mergeLoginTargets: a route without a flow keeps the derived reference fallback', () => {
  const options = providerOptionsFor(DIRECTORY, ns => (ns === 'llm-pi-ai' ? LLM_PI_AI_SECTION : undefined))
  const merged = mergeLoginTargets(options, [])
  const openrouter = merged.find(target => target.route === 'openrouter')
  assert.ok(openrouter !== undefined && openrouter.kind === 'reference')
  assert.equal(openrouter.ref, 'OPENROUTER_API_KEY')
})

test('mergeLoginTargets: foreign-scope flows are standalone targets', () => {
  const options = providerOptionsFor(DIRECTORY, ns => (ns === 'llm-pi-ai' ? LLM_PI_AI_SECTION : undefined))
  const targets = authorizationTargets([{
    key: credentialKey('acme-vendor', 'chatgpt'),
    label: 'ChatGPT (vendor)',
    methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }],
    inFlight: false,
  }])
  const merged = mergeLoginTargets(options, targets)
  const standalone = merged.find(target => target.kind === 'authorization' && target.route === undefined)
  assert.ok(standalone !== undefined, 'a foreign-scope flow must still be offered')
  assert.equal(standalone.label, 'ChatGPT (vendor)')
})

test('flowForRoute maps llm-pi-ai flow keys to routes', () => {
  const targets = authorizationTargets([{
    key: credentialKey('llm-pi-ai', 'openai'),
    label: 'openai',
    methods: [{ id: 'oauth', label: 'OAuth' }],
    inFlight: false,
  }])
  assert.equal(flowForRoute(targets, 'openai')?.key, 'llm-pi-ai/openai')
  assert.equal(flowForRoute(targets, 'acme'), undefined)
})

// ── §17.7 notice rendering ─────────────────────────────────────────────────

test('formatAuthorizationNotice covers message-only, url and device code', () => {
  assert.equal(formatAuthorizationNotice({ message: 'Signing in…' }), 'Signing in…')
  const withUrl = formatAuthorizationNotice({ message: 'Continue in your browser', url: 'https://example.com/auth' })
  assert.ok(withUrl.includes('Open this page to continue:'))
  assert.ok(withUrl.includes('https://example.com/auth'))
  const withCode = formatAuthorizationNotice({ message: 'Enter this code', url: 'https://example.com/verify', code: 'ABCD-EFGH' })
  assert.ok(withCode.includes('Code: ABCD-EFGH'))
  assert.ok(withCode.indexOf('https://example.com/verify') < withCode.indexOf('ABCD-EFGH'))
})

test('notices reuse one durable panel and refresh its body; close hides it', () => {
  const opened: string[] = []
  let closed = 0
  const surface: AuthorizationSurface = {
    openOutputViewer: (options) => {
      opened.push(options.initial)
      return () => { closed += 1 }
    },
    askQuestions: async () => [{ id: 'answer', selected: [], custom: 'x' }],
    openPicker: () => ({ close: () => {} }),
  }
  const { interaction, close } = createAuthorizationInteraction(surface)
  interaction.notify({ message: 'first progress' })
  interaction.notify({ message: 'Open this page', url: 'https://example.com' })
  interaction.notify({ message: 'Code time', code: '12-34' })
  assert.equal(opened.length, 1, 'one durable panel per attempt')
  assert.ok(opened[0]!.includes('first progress'))
  close()
  assert.equal(closed, 1)
})

// ── §17.8 prompt interaction ───────────────────────────────────────────────

test('a text prompt returns the typed text', async () => {
  const asked: unknown[] = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async (questions) => {
      asked.push(questions)
      return [{ id: 'answer', selected: [], custom: 'the-code' }]
    },
    openPicker: () => ({ close: () => {} }),
  }
  const { interaction } = createAuthorizationInteraction(surface)
  const value = await interaction.prompt({ kind: 'text', message: 'Enter the code', placeholder: 'ABCD' })
  assert.equal(value, 'the-code')
  const question = (asked[0] as { masked?: boolean }[])[0]
  assert.equal(question?.masked, undefined, 'a text prompt is not masked')
})

test('a secret prompt is masked and returns the value', async () => {
  const asked: unknown[] = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async (questions) => {
      asked.push(questions)
      return [{ id: 'answer', selected: [], custom: 'sk-test-secret' }]
    },
    openPicker: () => ({ close: () => {} }),
  }
  const { interaction } = createAuthorizationInteraction(surface)
  const value = await interaction.prompt({ kind: 'secret', message: 'Paste the API key' })
  assert.equal(value, 'sk-test-secret')
  const question = (asked[0] as { masked?: boolean }[])[0]
  assert.equal(question?.masked, true, 'the secret prompt must ask masked')
})

test('a select prompt returns the option id, not its label', async () => {
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [],
    openPicker: (items, onSelect) => {
      onSelect('oauth')
      return { close: () => {} }
    },
  }
  const { interaction } = createAuthorizationInteraction(surface)
  const value = await interaction.prompt({
    kind: 'select',
    message: 'How do you want to sign in?',
    options: [
      { id: 'oauth', label: 'OAuth' },
      { id: 'api-key', label: 'API key' },
    ],
  })
  assert.equal(value, 'oauth')
})

test('the user cancelling a prompt is a decline (AuthorizationDeclinedError)', async () => {
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => { throw new Error('question flow cancelled') },
    openPicker: () => ({ close: () => {} }),
  }
  const { interaction } = createAuthorizationInteraction(surface)
  await assert.rejects(
    interaction.prompt({ kind: 'text', message: 'enter' }),
    (error) => error instanceof AuthorizationDeclinedError,
    'a user cancel must reject with AuthorizationDeclinedError',
  )
})

test('an empty typed answer is a decline, not an empty string', async () => {
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [{ id: 'answer', selected: [], custom: '' }],
    openPicker: () => ({ close: () => {} }),
  }
  const { interaction } = createAuthorizationInteraction(surface)
  await assert.rejects(
    interaction.prompt({ kind: 'text', message: 'enter' }),
    (error) => error instanceof AuthorizationDeclinedError,
  )
})

// ── §17.9 prompt-level signal ──────────────────────────────────────────────

test('a prompt withdrawn by its own signal is NOT a decline', async () => {
  const controller = new AbortController()
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => {
      controller.abort(new Error('losing race'))
      throw new Error('question flow cancelled')
    },
    openPicker: () => ({ close: () => {} }),
  }
  const { interaction } = createAuthorizationInteraction(surface)
  await assert.rejects(
    interaction.prompt({ kind: 'text', message: 'enter', signal: controller.signal }),
    (error) => !(error instanceof AuthorizationDeclinedError),
    'a withdrawn prompt must reject with a non-decline error',
  )
})

test('a select prompt withdrawn by its signal closes the picker, non-decline', async () => {
  const controller = new AbortController()
  let closed = 0
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [],
    openPicker: (items, onSelect, onCancel) => {
      // The flow withdraws the losing prompt while the picker is open.
      controller.abort(new Error('browser callback won'))
      return { close: () => { closed += 1 } }
    },
  }
  const { interaction } = createAuthorizationInteraction(surface)
  await assert.rejects(
    interaction.prompt({
      kind: 'select',
      message: 'How?',
      options: [{ id: 'oauth', label: 'OAuth' }],
      signal: controller.signal,
    }),
    (error) => !(error instanceof AuthorizationDeclinedError),
    'a withdrawn select prompt must reject with a non-decline error',
  )
  assert.equal(closed, 1, 'the open picker must be closed on withdrawal')
})

test('the user cancelling a select prompt is a decline', async () => {
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [],
    openPicker: (items, onSelect, onCancel) => {
      onCancel()
      return { close: () => {} }
    },
  }
  const { interaction } = createAuthorizationInteraction(surface)
  await assert.rejects(
    interaction.prompt({
      kind: 'select',
      message: 'How?',
      options: [{ id: 'oauth', label: 'OAuth' }],
    }),
    (error) => error instanceof AuthorizationDeclinedError,
  )
})

// ── §17.6 method selection ─────────────────────────────────────────────────

test('/login runs the flow directly when it offers one method', async () => {
  const t = setup()
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'anthropic')
  assert.equal(result.kind, 'success')
  assert.equal(t.authorization.begins.length, 1)
  assert.equal(t.authorization.begins[0]!.key, 'llm-pi-ai/anthropic')
  assert.equal(t.authorization.begins[0]!.method, 'oauth')
  t.app.stop()
})

test('/login opens a method picker when a flow offers several methods', async () => {
  const t = setup({
    flows: [flow('llm-pi-ai/openrouter', 'openrouter', [
      { id: 'oauth', label: 'OAuth' },
      { id: 'api-key', label: 'API key' },
    ])],
    pick: () => 'api-key',
  })
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'openrouter')
  assert.equal(result.kind, 'success')
  assert.equal(t.authorization.begins.length, 1)
  assert.equal(t.authorization.begins[0]!.method, 'api-key')
  t.app.stop()
})

// ── §17.12 no accidental auth-path mismatch ────────────────────────────────

test('/login <route with apiKeyEnv> goes reference even with a flow present', async () => {
  const t = setup({
    flows: [flow('llm-pi-ai/openai', 'openai', [{ id: 'oauth', label: 'OAuth' }])],
  })
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'openai')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.sets, ['CUSTOM_OPENAI_KEY=sk-test'])
  assert.equal(t.authorization.begins.length, 0, 'authorization.begin must not run for a named-key route')
  t.app.stop()
})

test('/login <env-var> keeps the escape hatch even with a same-named flow', async () => {
  const t = setup({
    flows: [flow('llm-pi-ai/anthropic', 'Anthropic', [{ id: 'oauth', label: 'OAuth' }])],
  })
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'MY_CUSTOM_KEY')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.sets, ['MY_CUSTOM_KEY=sk-test'])
  assert.equal(t.authorization.begins.length, 0)
  t.app.stop()
})

// ── §12.1 keyless profile provisioning ─────────────────────────────────────

test('a successful keyless sign-in records a minimal provider profile', async () => {
  const t = setup()
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'openrouter')
  assert.equal(result.kind, 'success')
  assert.ok(result.text?.includes('signed in to openrouter'), result.text)
  // The minimal profile must NOT carry apiKeyEnv (the runtime keeps reading
  // the credential record).
  assert.equal(t.settings.mutations.length, 1)
  assert.deepEqual(t.settings.mutations[0], {
    ns: 'llm-pi-ai',
    ops: [{ op: 'set', path: ['providers', 'openrouter'], value: {} }],
  })
  t.app.stop()
})

test('an already-configured route gets no profile write after sign-in', async () => {
  const t = setup()
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'anthropic')
  assert.equal(result.kind, 'success')
  assert.equal(t.settings.mutations.length, 0, 'a configured route needs no provisioning')
  t.app.stop()
})

// ── §15 error semantics ────────────────────────────────────────────────────

test('/login maps NO_FLOW to stable copy', async () => {
  const t = setup({ beginError: Object.assign(new Error('no flow'), { code: 'NO_FLOW' }) })
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'openrouter')
  assert.equal(result.text, 'login method is no longer available')
  t.app.stop()
})

test('/login refuses to start a second attempt for an in-flight flow', async () => {
  const t = setup({
    flows: [flow('llm-pi-ai/openrouter', 'openrouter', [{ id: 'oauth', label: 'OAuth' }], true)],
  })
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'openrouter')
  assert.equal(result.kind, 'error')
  assert.ok(result.text?.includes('already in progress') === true, result.text)
  assert.equal(t.authorization.begins.length, 0)
  t.app.stop()
})

test('/login maps NOT_COMMITTED without leaking provider internals', async () => {
  const t = setup({
    beginError: Object.assign(new Error('provider exploded'), { code: 'NOT_COMMITTED' }),
  })
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'openrouter')
  assert.equal(result.text, 'sign-in finished without storing a credential')
  t.app.stop()
})

test('/login user decline reports login cancelled', async () => {
  const t = setup({
    beginError: Object.assign(new Error('declined'), { code: 'DECLINED' }),
  })
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'openrouter')
  assert.equal(result.text, 'login cancelled')
  t.app.stop()
})

// ── §17.10 whole-attempt cancellation ──────────────────────────────────────

test('/login passes the runner signal into begin', async () => {
  const t = setup()
  await t.run(t.login, 'anthropic')
  assert.equal(t.authorization.begins[0]!.signal, t.runner.signal)
  t.app.stop()
})

test('/login aborted mid-attempt reports login cancelled', async () => {
  const t = setup({
    beginError: Object.assign(new Error('aborted'), { name: 'AbortError' }),
  })
  t.runner.signal = AbortSignal.abort()
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'anthropic')
  assert.equal(result.text, 'login cancelled')
  t.app.stop()
})

// ── §17.11 record logout ───────────────────────────────────────────────────

test('/logout <keyless route> deletes the stored record, never unsets', async () => {
  const t = setup({
    flows: [flow('llm-pi-ai/anthropic', 'Anthropic', [{ id: 'oauth', label: 'OAuth' }])],
  })
  const result = await t.run<{ kind: string; text?: string }>(t.logout, 'anthropic')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.deletes, ['llm-pi-ai/anthropic'])
  assert.deepEqual(t.credentials.unsets, [])
  assert.ok(result.text?.includes('signed out locally') === true, result.text)
  t.app.stop()
})

test('/logout <named-key route> still unsets the reference', async () => {
  const t = setup({
    flows: [flow('llm-pi-ai/openai', 'openai', [{ id: 'oauth', label: 'OAuth' }])],
  })
  const result = await t.run<{ kind: string; text?: string }>(t.logout, 'openai')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.unsets, ['CUSTOM_OPENAI_KEY'])
  assert.deepEqual(t.credentials.deletes, [])
  t.app.stop()
})

test('/logout with no argument picks stored records and clears them', async () => {
  const t = setup({
    pick: (items) => items.find(item => item.value.includes('llm-pi-ai/openai'))!.value,
  })
  const result = await t.run<{ kind: string; text?: string }>(t.logout, '')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.deletes, ['llm-pi-ai/openai'])
  t.app.stop()
})

test('/logout picker deduplicates records and labels flow-owned ones', async () => {
  let rows: { value: string; label?: string; group?: string }[] | undefined
  const t = setup({
    // The store reports the same record twice (a hostile/duplicated store
    // must not produce two rows), and the key belongs to a registered flow.
    records: [
      { key: 'llm-pi-ai/anthropic', kind: 'grant' },
      { key: 'llm-pi-ai/anthropic', kind: 'grant' },
    ],
    flows: [flow('llm-pi-ai/anthropic', 'Anthropic', [{ id: 'oauth', label: 'OAuth' }])],
    pick: (items) => {
      rows = items.map(item => ({ ...item }))
      return items.find(item => item.value.includes('llm-pi-ai/anthropic'))!.value
    },
  })
  const result = await t.run<{ kind: string; text?: string }>(t.logout, '')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.deletes, ['llm-pi-ai/anthropic'])
  const recordRows = rows!.filter(row => row.value.includes('llm-pi-ai/anthropic'))
  assert.equal(recordRows.length, 1, 'duplicate records must collapse to one row')
  assert.ok(recordRows[0]!.label?.includes('Anthropic'), `flow label must name the owner: ${recordRows[0]!.label}`)
  assert.ok(recordRows[0]!.label?.includes('stored credential'), recordRows[0]!.label)
  t.app.stop()
})

// ── the masked question rendering (host surface, not the fork) ────────────

function stripAnsi(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '')
}

test('a masked question renders bullets, never the typed value', () => {
  const question: QuestionFlowQuestion = { id: 'secret', question: 'Paste the API key', masked: true }
  const flow = new QuestionFlow([question], () => {}, () => {})
  flow.setMaxRows(12)
  flow.focused = true
  // An optionless masked question starts in free-text mode (syncEditMode).
  for (const char of 'sk-test') flow.handleInput(char)
  const lines = flow.render(60).map(stripAnsi)
  const joined = lines.join('\n')
  assert.ok(!joined.includes('sk-test'), 'the secret must never render in plaintext')
  assert.ok(joined.includes('•'), 'the masked row must render bullets')
  // The real value stays in the INPUT's memory (the answer returns it) —
  // only the display is masked.
  const input = (flow as unknown as { otherInput: { getValue(): string } }).otherInput
  assert.equal(input.getValue(), 'sk-test')
  // Commit → the review page must stay masked too (the answer is confirmed
  // as "typed", never re-shown in plaintext).
  flow.handleInput('\r')
  const review = flow.render(60).map(stripAnsi).join('\n')
  assert.ok(!review.includes('sk-test'), 'the review page must not re-show the secret')
  assert.ok(review.includes('•'), 'the review page keeps the masked answer')
})

// ── §15 authorizationFailureText mapping ───────────────────────────────────

test('authorizationFailureText maps the stable taxonomy', () => {
  assert.equal(authorizationFailureText({ code: 'NO_FLOW' }, 'x'), 'login method is no longer available')
  assert.equal(authorizationFailureText({ code: 'UNKNOWN_METHOD' }, 'x'), 'selected login method is no longer available')
  assert.equal(authorizationFailureText({ code: 'ALREADY_IN_FLIGHT' }, 'x'), 'sign-in already in progress')
  assert.equal(authorizationFailureText({ code: 'NOT_COMMITTED' }, 'x'), 'sign-in finished without storing a credential')
  assert.equal(authorizationFailureText({ code: 'DECLINED' }, 'x'), 'login cancelled')
  assert.equal(authorizationFailureText(new Error('boom'), 'safe boom'), 'sign-in failed: safe boom')
})
