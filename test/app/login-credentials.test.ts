/**
 * `/login` / `/logout` in Phase 3C / C2-MA.
 *
 * The commands are navigation only: they resolve the typed argument through
 * the shared Auth target resolver and open the Settings workspace at the
 * Models/Account destination. The credential writes are exercised in
 * `models-workspace.test.ts` and the Direct integration suite.
 *
 * @module @xmoon76/dsh-pi-tui/login-credentials.test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { createAuthCommands } from '../../src/tui/commands/auth.ts'
import {
  classifyCredentialArg,
  credentialOptionsFor,
  resolveCredentialArg,
} from '../../src/domain/catalog/provider.ts'
import type { AuthDestination } from '../../src/app/command/credential-workflow.ts'
import type { AuthorizationFlowTarget, CredentialProviderOption } from '../../src/runtime/config-port.ts'
import type { RegisterOne } from '../../src/commands.ts'

const LLM_PI_AI_SECTION = {
  providers: {
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' },
    acme: { apiKeyEnv: 'ACME_GATEWAY_API_KEY' },
    anthropic: { apiKeyEnv: undefined },
  },
}

const OPTIONS: readonly CredentialProviderOption[] = [
  { route: 'deepseek-official', label: 'deepseek official', ref: 'DEEPSEEK_API_KEY', configured: true, declared: false, namesCredential: true, group: 'configured', canProvisionProfile: false },
  { route: 'openai', label: 'openai', ref: 'OPENAI_API_KEY', configured: true, declared: false, namesCredential: true, group: 'configured', canProvisionProfile: true },
  { route: 'acme', label: 'acme', ref: 'ACME_GATEWAY_API_KEY', configured: true, declared: false, namesCredential: true, group: 'configured', canProvisionProfile: true },
  { route: 'anthropic', label: 'anthropic', ref: 'ANTHROPIC_API_KEY', configured: true, declared: false, namesCredential: false, group: 'configured', canProvisionProfile: true },
]

const TARGETS: readonly AuthorizationFlowTarget[] = [
  { kind: 'authorization', key: 'llm-pi-ai/anthropic', route: 'anthropic', label: 'Anthropic', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
  { kind: 'authorization', key: 'deepseek-account-platform/default', label: 'DeepSeek', methods: [{ id: 'browser', label: 'DeepSeek' }], inFlight: false },
]

function authCommands() {
  const definitions = new Map<string, (invocation: CommandInvocation) => unknown>()
  const opened: AuthDestination[] = []
  const commands = createAuthCommands({
    runner: {
      config: {
        providers: {
          available: () => true,
          listCredentialOptions: () => OPTIONS,
          readProfile: (route: string) => ({ route, configured: true, models: [] }),
          configGuide: () => ({}),
          writeProfile: async () => {},
          writeKeylessProfile: async () => ({ kind: 'written' }),
        },
        authorization: {
          available: () => true,
          listTargets: () => TARGETS,
          begin: async () => ({ kind: 'unavailable' }),
          onEvent: () => () => {},
          respond: async () => {},
          cancel: async () => {},
        },
        credentials: { available: () => true },
        account: { available: () => true },
      } as never,
    },
    registerOne: ((definition: { name: string; handler: (invocation: CommandInvocation) => unknown }) => {
      definitions.set(definition.name, definition.handler)
      return () => {}
    }) as unknown as RegisterOne,
    openAuthWorkspace: destination => {
      if (destination.kind === 'error') return { kind: 'error', text: destination.message }
      opened.push(destination)
      return { kind: 'success' }
    },
  })
  commands.registerLogin()
  commands.registerLogout()
  const invoke = async (name: string, rawInput: string): Promise<unknown> => {
    const handler = definitions.get(name)
    assert.ok(handler, `/${name} must be registered`)
    return handler({ rawInput } as CommandInvocation)
  }
  return { invoke, opened }
}

test('credentialOptionsFor lists deepseek official plus deduped llm-pi-ai routes', () => {
  const options = credentialOptionsFor(LLM_PI_AI_SECTION.providers)
  assert.deepEqual(options.map(option => option.ref), [
    'DEEPSEEK_API_KEY',
    'OPENAI_API_KEY',
    'ACME_GATEWAY_API_KEY',
  ])
})

test('classifyCredentialArg distinguishes a route from a literal reference', () => {
  assert.deepEqual(classifyCredentialArg('acme', OPTIONS), { kind: 'route', option: OPTIONS[2] })
  assert.deepEqual(classifyCredentialArg('ACME_GATEWAY_API_KEY', OPTIONS), { kind: 'ref', ref: 'ACME_GATEWAY_API_KEY' })
  assert.deepEqual(classifyCredentialArg('novel_key', OPTIONS), { kind: 'ref', ref: 'NOVEL_KEY' })
  assert.equal(classifyCredentialArg('not valid!', OPTIONS), undefined)
  assert.equal(resolveCredentialArg('acme', OPTIONS), 'ACME_GATEWAY_API_KEY')
  assert.equal(resolveCredentialArg('my_key', OPTIONS), 'MY_KEY')
})

test('/login navigates: bare list, known route, explicit ref, new route, account', async () => {
  const { invoke, opened } = authCommands()
  await invoke('login', '')
  await invoke('login', 'acme')
  await invoke('login', 'ACME_GATEWAY_API_KEY')
  await invoke('login', 'new-route')
  await invoke('login', 'deepseek-account')
  assert.deepEqual(opened, [
    { kind: 'models', view: 'list' },
    { kind: 'models', view: 'provider', route: 'acme' },
    { kind: 'models', view: 'reference', ref: 'ACME_GATEWAY_API_KEY' },
    { kind: 'models', view: 'add-provider', route: 'new-route' },
    { kind: 'account', view: 'page' },
  ])
})

test('/login rejects an unknown target without opening a targetless page', async () => {
  const { invoke, opened } = authCommands()
  const result = await invoke('login', 'not valid!') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.match(result.text, /unknown credential target/u)
  assert.deepEqual(opened, [])
})

test('/logout navigates: bare stored-credentials, exact ref, keyless record, account sign-out', async () => {
  const { invoke, opened } = authCommands()
  await invoke('logout', '')
  await invoke('logout', 'ACME_GATEWAY_API_KEY')
  await invoke('logout', 'anthropic')
  await invoke('logout', 'deepseek-account')
  assert.deepEqual(opened, [
    { kind: 'models', view: 'logout-list' },
    { kind: 'models', view: 'logout', target: { kind: 'reference', ref: 'ACME_GATEWAY_API_KEY', label: 'acme', route: 'acme' } },
    { kind: 'models', view: 'logout', target: { kind: 'record', key: 'llm-pi-ai/anthropic', label: 'Anthropic', route: 'anthropic' } },
    { kind: 'account', view: 'signout' },
  ])
})

test('/logout rejects an unknown target', async () => {
  const { invoke, opened } = authCommands()
  const result = await invoke('logout', 'not valid!') as { kind: string; text: string }
  assert.equal(result.kind, 'error')
  assert.deepEqual(opened, [])
})
