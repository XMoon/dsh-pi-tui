/**
 * Headless tests for the rc.1 authorization surface: the login-target merge
 * (reference vs authorization per route), the authorization interaction
 * bridge (notices, text/secret/select prompts, decline vs prompt-signal
 * withdrawal), and the /login /logout command paths through the seam —
 * including the no-accidental-auth-path-mismatch regression (an explicit
 * apiKeyEnv route must keep the reference path even with a flow present)
 * and record logout. The legacy reference behavior stays pinned in
 * test/app/login-credentials.test.ts.
 * @module @xmoon76/dsh-pi-tui/authorization-login.test
 */

import assert from 'node:assert/strict'
import { createAppLifecycleGuard } from '../support/app-lifecycle-guard.ts'
import { createClientCommandRegistry } from '../../src/app/command/client-command-registry.ts'
import { parseCommand } from '@deepseek-ai/dsh-commands'
import { afterEach, test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands'
import {
  registerTuiCommands,
  type TuiCommandRunner,
} from '../../src/commands.ts'
import {
  authorizationFailureText,
  createAuthorizationFlow,
  flowForRoute,
  formatAuthorizationNotice,
  mergeLoginTargets,
  type AuthorizationSurface,
} from '../../src/app/command/authorization.ts'
import { authorizationTargets } from '../../src/runtime/direct/config-direct.ts'
import { getPath, providerOptionsFor, providerProfileProjectionOf, type ProviderCatalogEntry } from '../../src/domain/catalog/provider.ts'
import { credentialOptionOf } from '../../src/runtime/direct/config-direct.ts'
import { QuestionFlow, type QuestionFlowQuestion } from '../../src/tui/interaction/question.ts'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { TuiApp } from '../../src/tui-app.ts'
import { DraftImageStore } from '../../src/client/media/image/draft-store.ts'
import { VirtualTerminal } from '../support/virtual-terminal.ts'
import { sessionScopeFacts } from '../support/session-scope-facts.ts'

/** Flush the microtask queue (the flow's respond chain is promise-based). */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { resolve() })
  await new Promise<void>((resolve) => { resolve() })
}
import { DirectCatalogPort } from '../../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'
import { registerTuiCommandsWithDirectSeams } from '../support/register-tui-commands.ts'


/** Re-vendor lifecycle follow-up P3: every TuiApp constructed in this file
 * is disposed after each test — the process slot (the vendored fork
 * keybindings are process-global) is released only by the FINAL dispose,
 * never by stop() (see src/tui/process-slot.ts). */
const { started: startedApps, disposeAll: disposeStartedApps } = createAppLifecycleGuard<TuiApp>()
afterEach(() => {
  disposeStartedApps()
})

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

/** A fake SettingsForms surface serving the llm-pi-ai form descriptor,
 * recording writes. */
function fakeSettings() {
  const mutations: { ns: string; ops: unknown[] }[] = []
  return {
    mutations,
    service: {
      describe: () => [{ ns: 'llm-pi-ai', value: LLM_PI_AI_SECTION, user: LLM_PI_AI_SECTION, revision: 2 }],
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
  /** Drive the REAL Host interaction (one notice plus ordered prompts) and
   *  settle authorized from the answers the mounted app returns — the
   *  positive Host service -> Direct adapter -> config port -> app flow ->
   *  question/picker/notice chain. */
  driveInteraction?: {
    notice: { message: string; url?: string; code?: string }
    prompts: readonly (
      | { kind: 'text' | 'secret'; message: string }
      | { kind: 'select'; message: string; options: readonly { id: string; label: string; description?: string }[] }
    )[]
  }
} = {}) {
  const begins: { key: string; method?: string; signal?: AbortSignal; interaction: unknown }[] = []
  /** The answers the Host interaction itself observed, in prompt order. */
  const promptAnswers: { kind: string; message: string; answer: string }[] = []
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
        : options.driveInteraction !== undefined
          ? async (request: { key: string; method?: string; interaction: unknown; signal?: AbortSignal }) => {
              begins.push(request)
              const interaction = request.interaction as {
                notify: (notice: { message: string; url?: string; code?: string }) => void
                prompt: (prompt: {
                  kind: string
                  message: string
                  options?: readonly { id: string; label: string; description?: string }[]
                  signal?: AbortSignal
                }) => Promise<string>
              }
              interaction.notify(options.driveInteraction!.notice)
              for (const prompt of options.driveInteraction!.prompts) {
                const answer = await interaction.prompt(prompt)
                promptAnswers.push({ kind: prompt.kind, message: prompt.message, answer })
              }
              return { status: 'authorized' as const }
            }
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
    promptAnswers,
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
    deliveredFilesSnapshot: () => undefined,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
        ...sessionScopeFacts(() => undefined, () => 0),
        currentSessionId: undefined,
    ensureSession: async () => {},
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: undefined,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => ({ items: [], hasMore: false }),
      projectionBatch: async () => new Map(), blank: () => undefined, measureContext: () => undefined,
      turnOutline: () => undefined,
      sessionStatus: () => undefined,
    },
    catalog: new DirectCatalogPort(ctx as never, () => undefined),
    config: new DirectConfigPort(ctx as never, undefined, () => undefined),
    commandRegistry: ctx.get('commands') as import('../../src/commands.ts').CommandRegistryLike | undefined,
    clientCommands: createClientCommandRegistry(parseCommand),
    hostFile: new DirectHostFilePort(() => undefined),
    hostShellCompletion: true,
    transcriptExportAvailable: true,
    interaction: {
      questions: {
        onRequest: () => true,
        subscribe: () => undefined,
        snapshot: () => undefined,
        claimTimedWait: async () => undefined,
        answerContinued: async () => 'not-continued' as const,
      },
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      prompt: async () => ({ kind: 'committed' as const, value: undefined }),
      updateQueue: async () => ({ kind: 'committed' as const, value: undefined }),
      cancel: async () => ({ kind: 'committed' as const, value: undefined }),
      rename: async (_sessionId: string, title: string) => ({ kind: 'committed' as const, value: { title } }),
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
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
    currentPreset: () => undefined,
    get pendingPreset() { return undefined },
    set pendingPreset(_id: string | undefined) {},
    get effectivePresetId() { return undefined },
    awaitPendingDefaultWrite: async () => {},
    trackDefaultWrite: () => {},
    get defaultIntentOutcome() { return undefined },
    setModelSelectionPending: () => {},
    reconcileDefaultIntent: () => {},
    sessionBlank: () => undefined,
    refreshStatus: () => {},
    progressUpdatesState: { mode: 'milestones' }, responseStyleState: { style: 'default' }, gitAttributionState: { mode: 'off' },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {}, currentNotificationMode: () => 'unfocused', currentNotificationMethod: () => 'auto',
    setTerminalProgressMode: () => {}, setNotificationMethod: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {}, createPluginManagerPage: () => undefined,
    openRewindPicker: () => {},
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withWriter: async <T>(_scope: unknown, task: () => T | Promise<T>) => task(),
    withPromptAdmission: async <T>(_agent: unknown, _line: string, task: () => T | Promise<T>) => task(),
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
  driveInteraction?: NonNullable<Parameters<typeof fakeAuthorization>[0]>['driveInteraction']
  /** Ordered free-text answers the stubbed question surface returns. */
  answers?: readonly string[]
  pick?: (items: readonly { value: string; label?: string; group?: string }[]) => string
} = {}) {
  const ctx = new Context()
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
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
    driveInteraction: options.driveInteraction,
  })
  ctx.provide('authorization', authorization.service as never)
  const runner = stubRunner(ctx, app)
  registerTuiCommandsWithDirectSeams(runner)
  // The mounted question/picker surfaces are recorded so a witness can prove
  // WHICH rows the real app flow asked and WHAT it answered with.
  const askedQuestions: { id: string; question: string; masked?: boolean }[][] = []
  const answers = options.answers ?? ['sk-test']
  let answerIndex = 0
  app.askQuestions = (async (questions: readonly { id: string; question: string; masked?: boolean }[]) => {
    askedQuestions.push(questions.map(question => ({ ...question })))
    const custom = answers[Math.min(answerIndex, answers.length - 1)]!
    answerIndex += 1
    return [{ id: 'key', selected: [], custom }] as never
  }) as never
  const pickedItems: { value: string; label?: string }[][] = []
  app.openPicker = ((items: readonly { value: string; label?: string; group?: string }[], onSelect: (value: string) => void) => {
    pickedItems.push(items.map(item => ({ ...item })))
    onSelect((options.pick ?? ((rows) => rows[0]!.value))(items))
    return { close: () => {}, setItems: () => {} }
  }) as never
  // Record every durable notice body while still calling the REAL renderer.
  const originalOpenOutputViewer = TuiApp.prototype.openOutputViewer
  const openedNotices: string[] = []
  app.openOutputViewer = function (this: TuiApp, viewerOptions: Parameters<typeof originalOpenOutputViewer>[0]) {
    openedNotices.push(viewerOptions.initial)
    return originalOpenOutputViewer.call(this, viewerOptions)
  } as typeof app.openOutputViewer
  const login = commands.defs.find(entry => entry.name === 'login')
  const logout = commands.defs.find(entry => entry.name === 'logout')
  assert.ok(login?.handler !== undefined, 'login handler missing')
  assert.ok(logout?.handler !== undefined, 'logout handler missing')
  const run = async <T>(def: { handler?: unknown }, rawInput: string): Promise<T> =>
    (def!.handler as (inv: CommandInvocation) => Promise<T>)(invoke(rawInput))
  return { ctx, app, credentials, settings, authorization, runner, run, login, logout, askedQuestions, pickedItems, openedNotices }
}

function flow(key: string, label: string, methods: { id: string; label: string }[], inFlight = false) {
  return { key, label, methods, inFlight }
}

/** Project one directory entry's profile out of a settings section — the
 *  adapter's single-snapshot projection. */
const readProfileOf = (section: unknown) => (entry: ProviderCatalogEntry) =>
  providerProfileProjectionOf(getPath(section, entry.settingsPath))

// ── §17.5 target resolution (pure) ─────────────────────────────────────────

test('mergeLoginTargets: configured apiKeyEnv route wins over its flow', () => {
  const section = { providers: { openai: { apiKeyEnv: 'OPENAI_API_KEY' } } }
  const options = providerOptionsFor(DIRECTORY, readProfileOf(section)).map(option => credentialOptionOf(option))
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
  const options = providerOptionsFor(DIRECTORY, readProfileOf(section)).map(option => credentialOptionOf(option))
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
  const options = providerOptionsFor(DIRECTORY, readProfileOf(LLM_PI_AI_SECTION)).map(option => credentialOptionOf(option))
  const merged = mergeLoginTargets(options, [])
  const openrouter = merged.find(target => target.route === 'openrouter')
  assert.ok(openrouter !== undefined && openrouter.kind === 'reference')
  assert.equal(openrouter.ref, 'OPENROUTER_API_KEY')
})

test('mergeLoginTargets: foreign-scope flows are standalone targets', () => {
  const options = providerOptionsFor(DIRECTORY, readProfileOf(LLM_PI_AI_SECTION)).map(option => credentialOptionOf(option))
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

test('a masked question renders bullets, never the typed value', () => {
  const question: QuestionFlowQuestion = { id: 'secret', question: 'Paste the API key', masked: true }
  const flow = new QuestionFlow([question], () => {}, () => {})
  flow.setMaxRows(12)
  flow.focused = true
  // An optionless masked question starts in free-text mode (syncEditMode).
  for (const char of 'sk-test') flow.handleInput(char)
  const lines = flow.render(60).map(stripTerminalSequences)
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
  const review = flow.render(60).map(stripTerminalSequences).join('\n')
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
