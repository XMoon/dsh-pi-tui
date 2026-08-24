/**
 * Headless tests for the /login and /logout credential surface: the pure
 * target resolution (deepseek official + llm-pi-ai provider routes keyed by
 * their apiKeyEnv refs) and the handler paths that set/unset through the
 * credentials service. The key-entry question dialog is stubbed (the
 * user-types-a-key flow itself lives in question.ts); the llm-pi-ai section
 * read is driven through a fake settings service.
 * @module @xmoon76/dsh-pi-tui/login-credentials.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { CommandId } from '@deepseek-ai/dsh-commands'
import {
  registerTuiCommands,
  type TuiCommandRunner,
} from '../src/commands.ts'
import { credentialOptionsFor, resolveCredentialArg } from '../src/provider-catalog.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { VirtualTerminal } from './virtual-terminal.ts'

// themeOptOut() skips terminal queries under NO_COLOR / FORCE_COLOR=0 /
// CI=true — clear all three so the render paths under test stay live.
process.env.NO_COLOR = ''
process.env.FORCE_COLOR = ''
process.env.CI = ''

/** The llm-pi-ai settings section the adapter would register. */
const LLM_PI_AI_SECTION = {
  providers: {
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    acme: { apiKeyEnv: 'ACME_GATEWAY_API_KEY' },
    // A route that never names a credential (provider-native discovery).
    anthropic: { apiKeyEnv: undefined },
  },
}

/** A fake credentials service recording every set/unset and serving the
 * rc.1 record enumeration /logout's picker reads. */
function fakeCredentials(options: { failSet?: boolean } = {}) {
  const sets: string[] = []
  const unsets: string[] = []
  const deletes: string[] = []
  const records: { key: string; kind?: string }[] = []
  return {
    sets,
    unsets,
    deletes,
    records,
    service: {
      set: async (ref: string, key: string): Promise<void> => {
        if (options.failSet === true) throw new Error('ref is shadowed read-only by the environment')
        sets.push(`${ref}=${key}`)
      },
      unset: async (ref: string): Promise<void> => { unsets.push(ref) },
      describe: async (ref: string): Promise<{ configured: boolean; source?: string }> => ({ configured: true }),
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
    sessionReader: {
      list: async () => [],
      search: async () => [],
      titles: async () => new Map(),
    },
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      followup: () => {},
      steer: async () => 'ok' as const,
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
    compose: async () => ({ setup: () => {} }),
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

/** Register the TUI commands and return the /login and /logout handlers.
 * `withLlmpiAi: false` omits the settings service, so /login sees only the
 * official deepseek target (the no-settings degradation path).
 * `questions` replaces the key-entry question stub with a full answer list
 * (used by the add-provider wizard tests).
 * `llm` provides a fake llm service with a configurable-provider directory. */
function setup(options: {
  key?: string
  pick?: (items: readonly { value: string; label?: string }[]) => string
  withLlmpiAi?: boolean
  failSet?: boolean
  questions?: () => { id: string; selected: string[]; custom?: string }[]
  llm?: ReturnType<typeof fakeLlm>
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
  const credentials = fakeCredentials({ failSet: options.failSet })
  ctx.provide('credentials', credentials.service as never)
  let settings: ReturnType<typeof fakeSettings> | undefined
  if (options.withLlmpiAi !== false) {
    settings = fakeSettings()
    ctx.provide('settings', settings.service as never)
  }
  if (options.llm !== undefined) {
    ctx.provide('llm', options.llm.service as never)
  }
  const runner = stubRunner(ctx, app)
  registerTuiCommands(runner)
  // Stub the interactive surfaces: the key-entry question returns the fixed
  // key; the credential picker resolves to the stub's choice.
  app.askQuestions = async () => (options.questions?.() ?? [
    { id: 'key', selected: [], custom: options.key ?? 'sk-test' },
  ]) as never
  const pickerRows: { value: string; label?: string; group?: string }[] = []
  app.openPicker = ((items: readonly { value: string; label?: string; group?: string }[], onSelect: (value: string) => void) => {
    pickerRows.push(...items.map(item => ({ ...item })))
    onSelect((options.pick ?? ((rows) => rows[0]!.value))(items))
    return { close: () => {}, setItems: () => {} }
  }) as never
  const login = commands.defs.find(entry => entry.name === 'login')
  const logout = commands.defs.find(entry => entry.name === 'logout')
  assert.ok(login?.handler !== undefined, 'login handler missing')
  assert.ok(logout?.handler !== undefined, 'logout handler missing')
  const run = async <T>(def: { handler?: unknown }, rawInput: string): Promise<T> =>
    (def!.handler as (inv: CommandInvocation) => Promise<T>)(invoke(rawInput))
  return { app, credentials, settings, llm: options.llm, signal: runner.signal, pickerRows, run, login, logout }
}

test('credentialOptionsFor lists deepseek official plus deduped llm-pi-ai routes', () => {
  const options = credentialOptionsFor(LLM_PI_AI_SECTION.providers)
  assert.deepEqual(options, [
    { label: 'deepseek official', ref: 'DEEPSEEK_API_KEY' },
    { label: 'openai', ref: 'OPENAI_API_KEY' },
    { label: 'acme', ref: 'ACME_GATEWAY_API_KEY' },
  ])
  // The deepseek route's ref is already the official ref: deduped away.
  assert.equal(options.filter(option => option.ref === 'DEEPSEEK_API_KEY').length, 1)
  // No llm-pi-ai section: only the official target.
  assert.deepEqual(credentialOptionsFor(undefined), [
    { label: 'deepseek official', ref: 'DEEPSEEK_API_KEY' },
  ])
})

test('resolveCredentialArg matches routes case-insensitively, then env-var names', () => {
  const options = credentialOptionsFor(LLM_PI_AI_SECTION.providers)
  assert.equal(resolveCredentialArg('acme', options), 'ACME_GATEWAY_API_KEY')
  assert.equal(resolveCredentialArg('AcMe', options), 'ACME_GATEWAY_API_KEY')
  assert.equal(resolveCredentialArg('deepseek', options), 'DEEPSEEK_API_KEY')
  // An env-var-looking name not in the options is used verbatim, uppercased
  // (the old escape hatch for arbitrary credential refs).
  assert.equal(resolveCredentialArg('OPENAI_API_KEY', options), 'OPENAI_API_KEY')
  assert.equal(resolveCredentialArg('MY_CUSTOM_KEY', options), 'MY_CUSTOM_KEY')
  // Lowercase env-var-looking names are uppercased too (old behavior).
  assert.equal(resolveCredentialArg('my_custom_key', options), 'MY_CUSTOM_KEY')
  // Unknown words are rejected.
  assert.equal(resolveCredentialArg('no-such-route', options), undefined)
  assert.equal(resolveCredentialArg('', options), undefined)
})

test('/login <route> sets that route\'s apiKeyEnv credential', async () => {
  const t = setup()
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'acme')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.sets, ['ACME_GATEWAY_API_KEY=sk-test'])
  t.app.stop()
})

test('/login <env-name> sets the named env credential directly', async () => {
  const t = setup()
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'OPENAI_API_KEY')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.sets, ['OPENAI_API_KEY=sk-test'])
  t.app.stop()
})

test('/login <novel-env-name> sets that name verbatim, never re-derived', async () => {
  // The documented escape hatch: a name that matches NO catalog option ref
  // must be stored under exactly that name — re-deriving it through
  // deriveKeyRef would corrupt `MY_CUSTOM_KEY` into `MY_CUSTOM_KEY_API_KEY`.
  const t = setup()
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'MY_CUSTOM_KEY')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.sets, ['MY_CUSTOM_KEY=sk-test'])
  assert.match(result.text ?? '', /MY_CUSTOM_KEY set/)
  t.app.stop()
})

test('/login with a malformed unknown target lists the valid options', async () => {
  const t = setup()
  // `No-Such-Route` is not a valid route pattern (uppercase) and not an
  // env-var-looking name: the old "list the valid options" error path.
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'No-Such-Route')
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /deepseek official \(DEEPSEEK_API_KEY\)/)
  assert.match(result.text ?? '', /acme \(ACME_GATEWAY_API_KEY\)/)
  assert.deepEqual(t.credentials.sets, [], 'nothing must be set')
  t.app.stop()
})

test('/login with no argument and multiple targets opens the picker', async () => {
  // Picker rows now carry the ROUTE as value (openai), not the ref.
  const t = setup({ pick: rows => rows.find(row => row.value === 'openai')!.value })
  const result = await t.run<{ kind: string; text?: string }>(t.login, '')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.sets, ['OPENAI_API_KEY=sk-test'])
  t.app.stop()
})

test('/login with no argument and only the official target skips the picker', async () => {
  // No settings service → no llm-pi-ai section → exactly one target, so the
  // picker must never open (sabotaged: it would throw).
  const t = setup({ key: 'sk-official', withLlmpiAi: false })
  t.app.openPicker = (() => { throw new Error('picker must not open') }) as never
  const result = await t.run<{ kind: string; text?: string }>(t.login, '')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.sets, ['DEEPSEEK_API_KEY=sk-official'])
  t.app.stop()
})

test('/login with an empty pasted key sets nothing', async () => {
  const t = setup({ key: '' })
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'acme')
  assert.equal(result.kind, 'error')
  assert.deepEqual(t.credentials.sets, [])
  t.app.stop()
})

test('/logout resolves the same targets and unsets', async () => {
  const t = setup()
  const byRoute = await t.run<{ kind: string; text?: string }>(t.logout, 'acme')
  assert.equal(byRoute.kind, 'success')
  const byEnv = await t.run<{ kind: string; text?: string }>(t.logout, 'MY_CUSTOM_KEY')
  assert.equal(byEnv.kind, 'success')
  const defaultRun = await t.run<{ kind: string; text?: string }>(t.logout, '')
  assert.equal(defaultRun.kind, 'success')
  assert.deepEqual(t.credentials.unsets, ['ACME_GATEWAY_API_KEY', 'MY_CUSTOM_KEY', 'DEEPSEEK_API_KEY'])
  const unknown = await t.run<{ kind: string; text?: string }>(t.logout, 'No-Such-Route')
  assert.equal(unknown.kind, 'error')
  t.app.stop()
})

/** A fake llm service with a configurable-provider directory. */
function fakeLlm(directory: { provider: string; displayName: string; settingsNs: string; settingsPath: string[]; declared?: boolean }[]) {
  const probes: { settingsNs: string; request: unknown }[] = []
  return {
    probes,
    service: {
      listConfigurableProviders: () => directory,
      discoverModels: async (settingsNs: string, request: unknown) => {
        probes.push({ settingsNs, request })
        return [{ id: 'acme-large' }, { id: 'acme-think' }]
      },
    },
  }
}

test('/login with the llm directory offers unconfigured catalog routes', async () => {
  const t = setup({
    llm: fakeLlm([
      { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
    ]),
    key: 'sk-ant',
  })
  // anthropic is in the directory (unconfigured) → /login anthropic sets the
  // DERIVED ref (ANTHROPIC_API_KEY), not a settings-section listing.
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'anthropic')
  assert.equal(result.kind, 'success')
  assert.deepEqual(t.credentials.sets, ['ANTHROPIC_API_KEY=sk-ant'])
  t.app.stop()
})

test('/login picker rows are grouped via the group field with the Add row last', async () => {
  const t = setup({
    llm: fakeLlm([
      { provider: 'anthropic', displayName: 'anthropic', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'anthropic'] },
      // A hand-declared route with no profile yet.
      { provider: 'acme-gateway', displayName: 'Acme Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme-gateway'], declared: true },
    ]),
    pick: rows => rows[0]!.value,
  })
  const result = await t.run<{ kind: string; text?: string }>(t.login, '')
  assert.equal(result.kind, 'success')
  // Every provider row carries a group label; no synthetic header row value
  // may be selectable; the Add New Platform row is last and ungrouped.
  // anthropic has a stored profile in the section (apiKeyEnv undefined →
  // derived ref) so it is configured; acme-gateway has no profile → custom.
  // Reference rows all live under the `API key` category so the picker
  // separates them from provider sign-in rows at a glance.
  assert.equal(t.pickerRows[0]?.group, 'API key · configured') // deepseek official
  assert.equal(t.pickerRows[1]?.group, 'API key · configured') // anthropic
  assert.equal(t.pickerRows[2]?.group, 'API key · custom') // acme-gateway
  const add = t.pickerRows.at(-1)
  assert.equal(add?.label, '[ Add New Platform ]')
  assert.equal(add?.group, undefined)
  assert.equal(t.pickerRows.some(row => row.value.startsWith('\u0000group-')), false,
    'no synthetic group-header row may be a selectable picker item')
  t.app.stop()
})

test('/login <new-route> runs the add-provider wizard and persists the profile', async () => {
  const t = setup({
    llm: fakeLlm([]),
    questions: () => [
      // Wizard answers: (route pre-filled) api → baseURL → displayName →
      // key, then the models question (multi-select, selected acme-large).
      { id: 'api', selected: ['openai-completions'], custom: '' },
      { id: 'baseURL', selected: [], custom: 'https://gateway.acme.example/v1' },
      { id: 'displayName', selected: [], custom: 'Acme Gateway' },
      { id: 'key', selected: [], custom: 'sk-acme' },
      { id: 'models', selected: ['acme-large'], custom: '' },
    ],
  })
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'acme-gateway')
  assert.equal(result.kind, 'success')
  assert.match(result.text ?? '', /ACME_GATEWAY_API_KEY set · provider acme-gateway added/)
  // The endpoint was probed with the draft fields (signal is the runner's).
  assert.equal(t.llm!.probes.length, 1)
  assert.deepEqual(t.llm!.probes[0]?.request, {
    baseURL: 'https://gateway.acme.example/v1',
    api: 'openai-completions',
    apiKey: 'sk-acme',
    signal: t.signal,
  })
  // The profile was persisted through settings.mutate + the key stored.
  assert.equal(t.settings!.mutations.length, 1)
  assert.equal(t.settings!.mutations[0]?.ns, 'llm-pi-ai')
  assert.deepEqual(t.settings!.mutations[0]?.ops, [{
    op: 'set',
    path: ['providers', 'acme-gateway'],
    value: {
      displayName: 'Acme Gateway',
      api: 'openai-completions',
      baseURL: 'https://gateway.acme.example/v1',
      models: [{ id: 'acme-large' }],
      apiKeyEnv: 'ACME_GATEWAY_API_KEY',
    },
  }])
  assert.deepEqual(t.credentials.sets, ['ACME_GATEWAY_API_KEY=sk-acme'])
  t.app.stop()
})

test('/login wizard reports a profile that persisted but whose key write failed', async () => {
  const t = setup({
    llm: fakeLlm([]),
    failSet: true,
    questions: () => [
      { id: 'api', selected: ['openai-completions'], custom: '' },
      { id: 'baseURL', selected: [], custom: 'https://gateway.acme.example/v1' },
      { id: 'displayName', selected: [], custom: '' },
      { id: 'key', selected: [], custom: 'sk-acme' },
      { id: 'models', selected: ['acme-large'], custom: '' },
    ],
  })
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'acme-gateway')
  // The profile was persisted; only the key write failed, and the message
  // must say so honestly instead of claiming the whole add failed.
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /provider acme-gateway added, but storing the key failed/)
  assert.equal(t.settings!.mutations.length, 1)
  t.app.stop()
})

test('/login Add New Platform rejects a malformed route id', async () => {
  // Picker selects the Add New Platform row; the wizard's route question is
  // answered with a digit-leading id, which fails ROUTE_PATTERN.
  const t = setup({
    pick: rows => rows.find(row => row.label === '[ Add New Platform ]')!.value,
    questions: () => [
      { id: 'route', selected: [], custom: '1acme' },
      { id: 'api', selected: ['openai-completions'], custom: '' },
      { id: 'baseURL', selected: [], custom: 'https://x' },
      { id: 'displayName', selected: [], custom: '' },
      { id: 'key', selected: [], custom: '' },
    ],
  })
  const result = await t.run<{ kind: string; text?: string }>(t.login, '')
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /invalid provider route/)
  assert.deepEqual(t.credentials.sets, [])
  t.app.stop()
})