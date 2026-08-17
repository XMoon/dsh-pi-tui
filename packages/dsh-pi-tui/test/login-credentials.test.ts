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
  credentialOptionsFor,
  registerTuiCommands,
  resolveCredentialArg,
  type TuiCommandRunner,
} from '../src/commands.ts'
import { createDiag } from '../src/diag.ts'
import { TuiApp } from '../src/tui-app.ts'
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

/** A fake credentials service recording every set/unset. */
function fakeCredentials() {
  const sets: string[] = []
  const unsets: string[] = []
  return {
    sets,
    unsets,
    service: {
      set: async (ref: string, key: string): Promise<void> => { sets.push(`${ref}=${key}`) },
      unset: async (ref: string): Promise<void> => { unsets.push(ref) },
    },
  }
}

/** A fake settings service serving the llm-pi-ai section. */
function fakeSettings() {
  return {
    service: {
      get: (ns: string): unknown => (ns === 'llm-pi-ai' ? LLM_PI_AI_SECTION : undefined),
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
    cwd: '/ws',
    sessionCwd: () => '/ws',
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
    enterView: async () => {},
    requestExit: () => {},
    exit: () => {},
  }
}

function invoke(rawInput: string): CommandInvocation {
  return {
    commandId: CommandId('cmd-test-1'),
    agent: undefined as unknown as Agent,
    rawInput,
    signal: new AbortController().signal,
  }
}

/** Register the TUI commands and return the /login and /logout handlers.
 * `withLlmpiAi: false` omits the settings service, so /login sees only the
 * official deepseek target (the no-settings degradation path). */
function setup(options: { key?: string; pick?: (items: readonly { value: string }[]) => string; withLlmpiAi?: boolean } = {}) {
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
  const credentials = fakeCredentials()
  ctx.provide('credentials', credentials.service as never)
  if (options.withLlmpiAi !== false) {
    ctx.provide('settings', fakeSettings().service as never)
  }
  registerTuiCommands(stubRunner(ctx, app))
  // Stub the interactive surfaces: the key-entry question returns the fixed
  // key; the credential picker resolves to the stub's choice.
  app.askQuestions = async () => [{ id: 'key', selected: [], custom: options.key ?? 'sk-test' }] as never
  app.openPicker = ((items: readonly { value: string }[], onSelect: (value: string) => void) => {
    onSelect((options.pick ?? ((rows) => rows[0]!.value))(items))
    return { close: () => {}, setItems: () => {} }
  }) as never
  const login = commands.defs.find(entry => entry.name === 'login')
  const logout = commands.defs.find(entry => entry.name === 'logout')
  assert.ok(login?.handler !== undefined, 'login handler missing')
  assert.ok(logout?.handler !== undefined, 'logout handler missing')
  const run = async <T>(def: { handler?: unknown }, rawInput: string): Promise<T> =>
    (def!.handler as (inv: CommandInvocation) => Promise<T>)(invoke(rawInput))
  return { app, credentials, run, login, logout }
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

test('/login with an unknown target lists the valid options', async () => {
  const t = setup()
  const result = await t.run<{ kind: string; text?: string }>(t.login, 'no-such-route')
  assert.equal(result.kind, 'error')
  assert.match(result.text ?? '', /deepseek official \(DEEPSEEK_API_KEY\)/)
  assert.match(result.text ?? '', /acme \(ACME_GATEWAY_API_KEY\)/)
  assert.deepEqual(t.credentials.sets, [], 'nothing must be set')
  t.app.stop()
})

test('/login with no argument and multiple targets opens the picker', async () => {
  const t = setup({ pick: rows => rows.find(row => row.value === 'OPENAI_API_KEY')!.value })
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
  const unknown = await t.run<{ kind: string; text?: string }>(t.logout, 'no-such-route')
  assert.equal(unknown.kind, 'error')
  t.app.stop()
})