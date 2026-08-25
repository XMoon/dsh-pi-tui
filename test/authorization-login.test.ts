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
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands'
import {
  registerTuiCommands,
  type TuiCommandRunner,
} from '../src/commands.ts'
import {
  authorizationFailureText,
  authorizationTargets,
  createAuthorizationFlow,
  flowForRoute,
  formatAuthorizationNotice,
  mergeLoginTargets,
  type AuthorizationSurface,
  type AuthorizationTarget,
} from '../src/authorization.ts'
import { providerOptionsFor, type ProviderCatalogEntry } from '../src/provider-catalog.ts'
import { credentialOptionOf } from '../src/runtime/direct/config-direct.ts'
import { QuestionFlow, type QuestionFlowQuestion } from '../src/question.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

/** Flush the microtask queue (the flow's respond chain is promise-based). */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { resolve() })
  await new Promise<void>((resolve) => { resolve() })
}
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

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
function fakeAuthorization(options: {
  flows?: FakeFlow[]
  beginResult?: { status: 'authorized' | 'cancelled' }
  beginError?: Error & { code?: string }
  /** begin() THROWS SYNCHRONOUSLY (never a promise) — the port must be
   *  robust to a wire backend failing before the first await. */
  syncBeginThrow?: boolean
  /** begin() drives ONE text prompt and then NEVER settles (a wedged
   *  provider that ignores its abort signal) — the runner abort must
   *  still close the prompt UI and settle the login. */
  drivePromptAndHang?: boolean
} = {}) {
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
      begin: options.syncBeginThrow === true
        ? () => { throw new Error('wire exploded') }
        : options.drivePromptAndHang === true
          ? async (request: { key: string; method?: string; interaction: unknown; signal?: AbortSignal }) => {
              begins.push(request)
              const interaction = request.interaction as {
                notify: (n: unknown) => void
                prompt: (prompt: { kind: string; message: string; signal?: AbortSignal }) => Promise<string>
              }
              await interaction.prompt({ kind: 'text', message: 'enter' })
              return await new Promise<{ status: 'authorized' }>(() => {}) // never settles
            }
          : async (request: { key: string; method?: string; interaction: unknown; signal?: AbortSignal }) => {
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
    sessionReader: {
      list: async () => [],
      search: async () => [],
      titles: async () => new Map(),
      measureContext: () => undefined,
      readExportData: async () => ({ kind: 'none' }),
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
    hostFile: new DirectHostFilePort(() => undefined),
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'standard' }),
    refreshStatus: () => {},
    focusEnabled: () => false,
    setFocusMode: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
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
  syncBeginThrow?: boolean
  drivePromptAndHang?: boolean
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
    syncBeginThrow: options.syncBeginThrow,
    drivePromptAndHang: options.drivePromptAndHang,
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
  return { ctx, app, credentials, settings, authorization, runner, run, login, logout }
}

function flow(key: string, label: string, methods: { id: string; label: string }[], inFlight = false) {
  return { key, label, methods, inFlight }
}

// ── §17.5 target resolution (pure) ─────────────────────────────────────────

test('mergeLoginTargets: configured apiKeyEnv route wins over its flow', () => {
  const section = { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } }
  const options = providerOptionsFor(DIRECTORY, ns => (ns === 'llm-pi-ai' ? section : undefined)).map(option => credentialOptionOf(option))
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
  const options = providerOptionsFor(DIRECTORY, ns => (ns === 'llm-pi-ai' ? section : undefined)).map(option => credentialOptionOf(option))
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
  const options = providerOptionsFor(DIRECTORY, ns => (ns === 'llm-pi-ai' ? LLM_PI_AI_SECTION : undefined)).map(option => credentialOptionOf(option))
  const merged = mergeLoginTargets(options, [])
  const openrouter = merged.find(target => target.route === 'openrouter')
  assert.ok(openrouter !== undefined && openrouter.kind === 'reference')
  assert.equal(openrouter.ref, 'OPENROUTER_API_KEY')
})

test('mergeLoginTargets: foreign-scope flows are standalone targets', () => {
  const options = providerOptionsFor(DIRECTORY, ns => (ns === 'llm-pi-ai' ? LLM_PI_AI_SECTION : undefined)).map(option => credentialOptionOf(option))
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
  const flow = createAuthorizationFlow(surface, { respond: async () => {}, cancel: async () => {} })
  flow.bind('a')
  flow.onEvent({ kind: 'notice', attemptId: 'a', notice: { message: 'first progress' } })
  flow.bind('a')
  flow.onEvent({ kind: 'notice', attemptId: 'a', notice: { message: 'Open this page', url: 'https://example.com' } })
  flow.bind('a')
  flow.onEvent({ kind: 'notice', attemptId: 'a', notice: { message: 'Code time', code: '12-34' } })
  assert.equal(opened.length, 1, 'one durable panel per attempt')
  assert.ok(opened[0]!.includes('first progress'))
  flow.close()
  assert.equal(closed, 1)
})

// ── §17.8 prompt interaction ───────────────────────────────────────────────

test('a text prompt answers the typed text through the port', async () => {
  const asked: unknown[] = []
  const answered: Array<{ promptId: string; answer: string | null }> = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async (questions) => {
      asked.push(questions)
      return [{ id: 'answer', selected: [], custom: 'the-code' }]
    },
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, promptId, answer) => { answered.push({ promptId, answer }) },
    cancel: async () => {},
  })
  flow.bind('a')
  flow.onEvent({ kind: 'prompt', attemptId: 'a', promptId: 'p1', prompt: { kind: 'text', message: 'Enter the code', placeholder: 'ABCD' } })
  await settle()
  assert.deepEqual(answered, [{ promptId: 'p1', answer: 'the-code' }])
  const question = (asked[0] as { masked?: boolean }[])[0]
  assert.equal(question?.masked, undefined, 'a text prompt is not masked')
})

test('a secret prompt is masked and answers the value', async () => {
  const asked: unknown[] = []
  const answered: Array<string | null> = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async (questions) => {
      asked.push(questions)
      return [{ id: 'answer', selected: [], custom: 'sk-test-secret' }]
    },
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  flow.bind('a')
  flow.onEvent({ kind: 'prompt', attemptId: 'a', promptId: 'p1', prompt: { kind: 'secret', message: 'Paste the API key' } })
  await settle()
  assert.deepEqual(answered, ['sk-test-secret'])
  const question = (asked[0] as { masked?: boolean }[])[0]
  assert.equal(question?.masked, true, 'the secret prompt must ask masked')
})

test('a select prompt answers the option id, not its label', async () => {
  const answered: Array<string | null> = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [],
    openPicker: (items, onSelect) => {
      onSelect('oauth')
      return { close: () => {} }
    },
  }
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  flow.bind('a')
  flow.onEvent({
    kind: 'prompt',
    attemptId: 'a',
    promptId: 'p1',
    prompt: {
      kind: 'select',
      message: 'How do you want to sign in?',
      options: [
        { id: 'oauth', label: 'OAuth' },
        { id: 'api-key', label: 'API key' },
      ],
    },
  })
  await settle()
  assert.deepEqual(answered, ['oauth'])
})

test('the user cancelling a prompt is a decline (answered null)', async () => {
  const answered: Array<string | null> = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => { throw new Error('question flow cancelled') },
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  flow.bind('a')
  flow.onEvent({ kind: 'prompt', attemptId: 'a', promptId: 'p1', prompt: { kind: 'text', message: 'enter' } })
  await settle()
  assert.deepEqual(answered, [null], 'a user cancel must answer null (a decline)')
})

test('an empty typed answer is a decline, not an empty string', async () => {
  const answered: Array<string | null> = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [{ id: 'answer', selected: [], custom: '' }],
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  flow.bind('a')
  flow.onEvent({ kind: 'prompt', attemptId: 'a', promptId: 'p1', prompt: { kind: 'text', message: 'enter' } })
  await settle()
  assert.deepEqual(answered, [null], 'an empty typed answer is a decline')
})

// ── §17.9 prompt-level withdrawal ──────────────────────────────────────────

test('a prompt withdrawn by the flow is NOT answered (not a decline)', async () => {
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => {
      throw new Error('question flow cancelled')
    },
    openPicker: () => ({ close: () => {} }),
  }
  const answered: Array<string | null> = []
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  flow.bind('a')
  flow.onEvent({ kind: 'prompt', attemptId: 'a', promptId: 'p1', prompt: { kind: 'text', message: 'enter' } })
  // The flow withdraws the losing prompt BEFORE the question settles: the
  // open UI closes and the prompt is never answered (a refusal, not a
  // decline — the adapter already rejected its pending bridge).
  flow.bind('a')
  flow.onEvent({ kind: 'prompt-withdrawn', attemptId: 'a', promptId: 'p1' })
  await settle()
  assert.deepEqual(answered, [], 'a withdrawn prompt must not be answered')
})

test('a select prompt withdrawn by the flow closes the picker, non-decline', async () => {
  let closed = 0
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [],
    openPicker: () => {
      // The flow withdraws the losing prompt while the picker is open.
      return { close: () => { closed += 1 } }
    },
  }
  const answered: Array<string | null> = []
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  flow.bind('a')
  flow.onEvent({
    kind: 'prompt',
    attemptId: 'a',
    promptId: 'p1',
    prompt: { kind: 'select', message: 'How?', options: [{ id: 'oauth', label: 'OAuth' }] },
  })
  flow.bind('a')
  flow.onEvent({ kind: 'prompt-withdrawn', attemptId: 'a', promptId: 'p1' })
  await settle()
  assert.equal(closed, 1, 'the open picker must be closed on withdrawal')
  assert.deepEqual(answered, [], 'a withdrawn select prompt must not be answered')
})

test('the user cancelling a select prompt is a decline', async () => {
  const answered: Array<string | null> = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [],
    openPicker: (items, onSelect, onCancel) => {
      onCancel()
      return { close: () => {} }
    },
  }
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  flow.bind('a')
  flow.onEvent({
    kind: 'prompt',
    attemptId: 'a',
    promptId: 'p1',
    prompt: { kind: 'select', message: 'How?', options: [{ id: 'oauth', label: 'OAuth' }] },
  })
  await settle()
  assert.deepEqual(answered, [null], 'a user closing the picker is a decline')
})

test('a DUPLICATE prompt event (same attempt + prompt id) is ignored — it can never overwrite the open UI', async () => {
  const answered: Array<string | null> = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [{ id: 'answer', selected: [], custom: 'first' }],
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  flow.bind('a')
  flow.onEvent({ kind: 'prompt', attemptId: 'a', promptId: 'p1', prompt: { kind: 'text', message: 'first' } })
  // A hostile/duplicate wire event for the SAME prompt while its UI is
  // open: presenting it again would overwrite the open handle, and a late
  // callback of the old UI could answer or withdraw the NEW prompt. It
  // must be ignored — the FIRST prompt's UI stays authoritative.
  flow.onEvent({ kind: 'prompt', attemptId: 'a', promptId: 'p1', prompt: { kind: 'select', message: 'duplicate', options: [{ id: 'x', label: 'X' }] } })
  flow.onEvent({ kind: 'prompt-withdrawn', attemptId: 'a', promptId: 'p1' })
  await settle()
  assert.deepEqual(answered, [], 'the duplicate never becomes answerable; the withdrawn original is never answered')
})

// ── §17.10 flow scoping (attempt + prompt identity) ────────────────────────

test('a bound flow IGNORES another attempt\'s events (concurrent logins cannot cross)', async () => {
  const answered: Array<string | null> = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [{ id: 'answer', selected: [], custom: 'mine' }],
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  flow.bind('attempt-a')
  // Another login's prompt and settlement must never reach this flow.
  flow.onEvent({ kind: 'prompt', attemptId: 'attempt-b', promptId: 'pb', prompt: { kind: 'text', message: 'other' } })
  flow.onEvent({ kind: 'settled', attemptId: 'attempt-b', status: 'authorized' })
  await settle()
  assert.deepEqual(answered, [], 'another attempt\'s prompt is never answered')
  // This attempt's own events still flow.
  flow.onEvent({ kind: 'prompt', attemptId: 'attempt-a', promptId: 'pa', prompt: { kind: 'text', message: 'mine' } })
  await settle()
  assert.deepEqual(answered, ['mine'], 'the bound attempt\'s prompt is answered')
})

test('events buffered BEFORE the bind replay only for the bound attempt', async () => {
  const answered: Array<string | null> = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [{ id: 'answer', selected: [], custom: 'early' }],
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  // The runner subscribes BEFORE begin: events can arrive before the
  // attempt id is known. They must be buffered and replayed for the
  // matching attempt only.
  flow.onEvent({ kind: 'prompt', attemptId: 'other-attempt', promptId: 'po', prompt: { kind: 'text', message: 'other' } })
  flow.onEvent({ kind: 'prompt', attemptId: 'attempt-x', promptId: 'px', prompt: { kind: 'text', message: 'early' } })
  flow.bind('attempt-x')
  await settle()
  assert.deepEqual(answered, ['early'], 'the pre-bind event of the bound attempt replays; the other attempt is dropped')
})

test('withdrawing ONE prompt closes only ITS UI (prompt-scoped handles)', async () => {
  let closedP1 = 0
  let closedP2 = 0
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [],
    openPicker: (items, onSelect, onCancel, options) => {
      // The picker records WHICH prompt it is by its header.
      const header = options?.header ?? ''
      return { close: () => { if (header === 'p1-header') closedP1 += 1; else closedP2 += 1 } }
    },
  }
  const flow = createAuthorizationFlow(surface, { respond: async () => {}, cancel: async () => {} })
  flow.bind('a')
  flow.onEvent({
    kind: 'prompt',
    attemptId: 'a',
    promptId: 'p1',
    prompt: { kind: 'select', message: 'p1-header', options: [{ id: 'x', label: 'X' }] },
  })
  flow.onEvent({
    kind: 'prompt',
    attemptId: 'a',
    promptId: 'p2',
    prompt: { kind: 'select', message: 'p2-header', options: [{ id: 'y', label: 'Y' }] },
  })
  // Withdraw p1: p2's UI must stay open.
  flow.onEvent({ kind: 'prompt-withdrawn', attemptId: 'a', promptId: 'p1' })
  await settle()
  assert.equal(closedP1, 1, 'the withdrawn prompt\'s UI closes')
  assert.equal(closedP2, 0, 'the other prompt\'s UI stays open')
})

test('the pre-bind buffer is BOUNDED and dropped on close (a wedged begin cannot grow it)', async () => {
  const answered: Array<string | null> = []
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [{ id: 'answer', selected: [], custom: 'x' }],
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  // A wedged begin: flood events before any bind. The buffer must cap
  // (fail-closed), and close() must clear it.
  for (let i = 0; i < 200; i += 1) {
    flow.onEvent({ kind: 'notice', attemptId: 'wedged', notice: { message: `n${i}` } })
  }
  flow.close()
  // After close, no event is accepted at all.
  flow.onEvent({ kind: 'prompt', attemptId: 'wedged', promptId: 'p', prompt: { kind: 'text', message: 'x' } })
  await settle()
  assert.deepEqual(answered, [], 'no event after close is ever presented or answered')
})

test('pre-bind OVERFLOW drops non-terminal events but NEVER drops the terminal settle (bounded + no hang)', async () => {
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [{ id: 'answer', selected: [], custom: 'x' }],
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, { respond: async () => {}, cancel: async () => {} })
  // Flood beyond the buffer limit with non-terminal events: the buffer
  // stays bounded (non-terminal overflow is dropped), and the attempt's
  // SETTLED event — landing after the limit — is preserved and applied
  // at bind (the outcome resolves, never hangs).
  for (let i = 0; i < 200; i += 1) {
    flow.onEvent({ kind: 'notice', attemptId: 'flooded', notice: { message: `n${i}` } })
  }
  flow.onEvent({ kind: 'settled', attemptId: 'flooded', status: 'authorized' })
  flow.bind('flooded')
  await settle()
  assert.equal((await flow.outcome).status, 'authorized', 'the terminal settled event is preserved past the buffer limit')
})

test('pre-bind overflow still resolves when the terminal SETTLED event lands beyond the limit', async () => {
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [{ id: 'answer', selected: [], custom: 'x' }],
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, { respond: async () => {}, cancel: async () => {} })
  // 40 notices flood the 32-slot buffer, then the attempt's SETTLED event
  // arrives: the outcome must resolve (the terminal event is never
  // silently dropped).
  for (let i = 0; i < 40; i += 1) {
    flow.onEvent({ kind: 'notice', attemptId: 'late-settle', notice: { message: `n${i}` } })
  }
  flow.onEvent({ kind: 'settled', attemptId: 'late-settle', status: 'authorized' })
  flow.bind('late-settle')
  await settle()
  assert.equal((await flow.outcome).status, 'authorized')
})

test('ANOTHER attempt\'s pre-bind SETTLED event never settles this flow (attempt isolation)', async () => {
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [{ id: 'answer', selected: [], custom: 'mine' }],
    openPicker: () => ({ close: () => {} }),
  }
  const answered: Array<string | null> = []
  const flow = createAuthorizationFlow(surface, {
    respond: async (_attemptId, _promptId, answer) => { answered.push(answer) },
    cancel: async () => {},
  })
  // A concurrent login's prompt AND terminal settle arrive BEFORE this
  // flow is bound: neither may settle this flow or answer its prompt.
  flow.onEvent({ kind: 'prompt', attemptId: 'other-attempt', promptId: 'po', prompt: { kind: 'text', message: 'other' } })
  flow.onEvent({ kind: 'settled', attemptId: 'other-attempt', status: 'authorized' })
  flow.bind('attempt-a')
  await settle()
  assert.deepEqual(answered, [], 'another attempt\'s pre-bind prompt is never answered')
  // This flow's own attempt still works after the bind.
  flow.onEvent({ kind: 'prompt', attemptId: 'attempt-a', promptId: 'pa', prompt: { kind: 'text', message: 'mine' } })
  await settle()
  assert.deepEqual(answered, ['mine'], 'the bound attempt\'s prompt is answered after the foreign settle')
})

test('repeated pre-bind SETTLED events keep at most one terminal event; replay stops at settlement', async () => {
  let opened = 0
  const surface: AuthorizationSurface = {
    openOutputViewer: () => { opened += 1; return () => {} },
    askQuestions: async () => [{ id: 'answer', selected: [], custom: 'x' }],
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, { respond: async () => {}, cancel: async () => {} })
  // Multiple terminal events + notices in the pre-bind window: the buffer
  // must keep at most ONE settled (a later one replaces the earlier), and
  // replay must STOP at settlement — notices buffered after it must never
  // reopen UI after the flow closed.
  flow.onEvent({ kind: 'notice', attemptId: 'a', notice: { message: 'n1' } })
  flow.onEvent({ kind: 'settled', attemptId: 'a', status: 'cancelled' })
  flow.onEvent({ kind: 'notice', attemptId: 'a', notice: { message: 'n2' } })
  flow.onEvent({ kind: 'settled', attemptId: 'a', status: 'authorized' })
  flow.bind('a')
  await settle()
  assert.equal((await flow.outcome).status, 'authorized', 'the LAST terminal event wins')
  assert.equal(opened, 1, 'the notice before the terminal event opened the panel once; post-settle notices never reopen it')
})

test('bind() is ONE-SHOT: rebinding to another attempt is refused', async () => {
  const surface: AuthorizationSurface = {
    openOutputViewer: () => () => {},
    askQuestions: async () => [{ id: 'answer', selected: [], custom: 'x' }],
    openPicker: () => ({ close: () => {} }),
  }
  const flow = createAuthorizationFlow(surface, { respond: async () => {}, cancel: async () => {} })
  flow.bind('attempt-a')
  flow.bind('attempt-a') // idempotent for the same id
  assert.throws(
    () => flow.bind('attempt-b'),
    /already bound/,
    'a second bind to a DIFFERENT attempt is a caller bug and must fail loudly',
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

test('/login passes the runner signal into begin (the flow withdraws with it)', async () => {
  const t = setup()
  // Use a live controller so the SEMANTIC can be probed: aborting the
  // runner signal must abort the attempt's signal.
  const controller = new AbortController()
  t.runner.signal = controller.signal
  await t.run(t.login, 'anthropic')
  const received = t.authorization.begins[0]!.signal
  assert.ok(received !== undefined, 'the attempt receives the runner signal')
  // The Direct adapter COMPOSES the caller signal with its own withdraw
  // controller (AbortSignal.any): the object crossing is NOT the runner's
  // own, and it aborts WITH the runner signal. After the attempt settled
  // the adapter also finalizes its controller, so the received composite
  // is aborted — the signal really is the attempt's signal, not a
  // standalone probe (review finding).
  assert.notEqual(received, controller.signal, 'the attempt signal is a composite, never the runner signal itself')
  assert.equal(received.aborted, true, 'the received attempt signal reflects the runner abort + finalization')
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

test('an ALREADY-ABORTED start never launches the upstream flow (nothing retained)', async () => {
  // The runner signal is aborted BEFORE /login begins. The adapter must
  // finalize deterministically: report settled-cancelled immediately and
  // NEVER call the upstream begin (a provider that ignores its signal
  // would otherwise keep the attempt and the caller-abort listener
  // retained forever even though the login is already cancelled).
  const t = setup({ drivePromptAndHang: true })
  t.runner.signal = AbortSignal.abort()
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'anthropic')
  assert.equal(result.text, 'login cancelled')
  assert.equal(t.authorization.begins.length, 0, 'the upstream flow is never started under an already-aborted signal')
  t.app.stop()
})

test('/login runner abort with an ACTIVE prompt closes the UI and settles (a wedged provider never settles)', async () => {
  // The provider drives a prompt and then IGNORES its abort signal (never
  // settles). The runner abort must still: reject the pending bridge
  // immediately, emit prompt-withdrawn so the question UI closes, and
  // settle the command as 'login cancelled' — never hang on the outcome.
  const t = setup({ drivePromptAndHang: true })
  const controller = new AbortController()
  t.runner.signal = controller.signal
  let questionAborted = 0
  let releaseQuestion: (() => void) | undefined
  const questionGate = new Promise<void>((resolve) => { releaseQuestion = resolve })
  t.app.askQuestions = (async (_questions: unknown, signal?: AbortSignal) => {
    signal?.addEventListener('abort', () => { questionAborted += 1 })
    await questionGate
    return [{ id: 'answer', selected: [], custom: 'typed-late' }]
  }) as never
  const pending = t.run<{ kind: string; text?: string }>(t.login, 'anthropic')
  // Let the prompt open (the question UI is waiting on the gate).
  await settle()
  await settle()
  assert.equal(questionAborted, 0, 'the question is open before the abort')
  controller.abort() // runner teardown while the prompt UI is open
  const result = await pending
  assert.equal(result.text, 'login cancelled', 'the runner abort settles the login')
  assert.equal(questionAborted, 1, 'the open question UI closed on the abort')
  releaseQuestion!()
  t.app.stop()
})

test('a SYNCHRONOUS begin throw still unsubscribes and closes the flow UI', async () => {
  // The port contract may reject begin() synchronously (a wire backend
  // failing before the first await): the command must not leak the event
  // listener or the notice/prompt UI handles — the try/finally cleanup
  // runs on every path, and the error surfaces as stable copy.
  const t = setup({ syncBeginThrow: true })
  const controller = new AbortController()
  t.runner.signal = controller.signal
  // Count add/removeEventListener on the runner signal: the adapter must
  // dispose the caller-abort listener even when begin fails BEFORE any
  // attempt exists — a leaked listener on the long-lived runner signal
  // would accumulate across logins (review finding).
  let adds = 0
  let removes = 0
  const signal = controller.signal
  const originalAdd = signal.addEventListener.bind(signal)
  const originalRemove = signal.removeEventListener.bind(signal)
  signal.addEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type === 'abort') adds += 1
    return originalAdd(type as 'abort', listener as () => void, options as boolean | EventListenerOptions | undefined)
  }) as typeof signal.addEventListener
  signal.removeEventListener = ((type: string, listener: unknown, options?: unknown) => {
    if (type === 'abort') removes += 1
    return originalRemove(type as 'abort', listener as () => void, options as boolean | EventListenerOptions | undefined)
  }) as typeof signal.removeEventListener
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'anthropic')
  assert.equal(result.kind, 'error')
  assert.ok(result.text?.includes('sign-in failed'), result.text)
  assert.equal(adds, 1, 'the attempt registers one caller-abort listener')
  assert.equal(removes, 1, 'the synchronous failure disposes it (no leak across logins)')
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
