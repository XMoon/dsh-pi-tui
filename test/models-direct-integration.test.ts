/**
 * Phase 3C / C2-MA — the Models credential path over the REAL Direct adapters.
 *
 * PRODUCTION PREREQUISITES REPRODUCED:
 *   - `DirectConfigPort` / `DirectProviderProfileConfig` / `DirectCredentialConfig`
 *     over the live `ctx` services;
 *   - the official `@deepseek-ai/dsh-credentials-local` store (a real 0600 file);
 *   - the official `@deepseek-ai/dsh-authorization` registry.
 *
 * TEST STAND-INS: the Host SettingsForms service (a path-scoped form store with
 * revisions) and the llm configurable-provider directory. The Settings contract
 * itself is the Direct adapter's read/write path.
 *
 * @module @xmoon76/dsh-pi-tui/models-direct-integration.test
 */

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { CredentialWorkflow } from '../src/app/command/credential-workflow.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

interface FakeSettings {
  section: { providers: Record<string, Record<string, unknown>> }
  revision: number
}

function fakeSettings(initial: FakeSettings) {
  const service = {
    describe: () => [{ ns: 'llm-pi-ai', value: initial.section, user: initial.section, revision: initial.revision }],
    mutate: async (ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[]) => {
      assert.equal(ns, 'llm-pi-ai')
      for (const operation of ops) {
        assert.equal(operation.op, 'set')
        let target: Record<string, unknown> = initial.section as unknown as Record<string, unknown>
        for (const segment of operation.path.slice(0, -1)) {
          const next = target[segment]
          assert.equal(typeof next, 'object')
          target = next as Record<string, unknown>
        }
        target[operation.path[operation.path.length - 1]!] = operation.value
      }
      initial.revision += 1
    },
  }
  return service
}

test('REAL Direct adapters: provider facts, API-key set/re-read, and the Add Provider atomic write', async t => {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-pi-tui-c2-models-')
  const ctx = new Context()
  life.defer(() => ctx.fiber.dispose())
  {
    const settingsState: FakeSettings = {
      section: {
        providers: {
          acme: {
            apiKeyEnv: 'ACME_API_KEY',
            api: 'openai-completions',
            baseURL: 'https://acme.example/v1',
            models: [{ id: 'acme-1' }, { id: 'acme-2' }],
          },
        },
      },
      revision: 1,
    }
    ctx.provide('settings', fakeSettings(settingsState) as never)
    ctx.provide('llm', {
      listConfigurableProviders: () => [{
        provider: 'acme',
        displayName: 'Acme Gateway',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'acme'],
        declared: false,
      }],
    } as never)
    ctx.provide('profileContext', { patchPath: '/home/u/.dsh/profiles/pi-tui/cordis.patch.yml' } as never)
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(AuthorizationService)

    const port = new DirectConfigPort(ctx as never, undefined, () => undefined)
    const options = port.providers.listCredentialOptions()
    const acme = options.find(option => option.route === 'acme')
    assert.ok(acme !== undefined)
    assert.equal(acme.namesCredential, true)
    assert.equal(acme.canProvisionProfile, true)

    const facts = port.providers.readProfile('acme')
    assert.equal(facts.configured, true)
    assert.equal(facts.api, 'openai-completions')
    assert.equal(facts.baseURL, 'https://acme.example/v1')
    assert.deepEqual(facts.models, ['acme-1', 'acme-2'])
    assert.equal(port.providers.configGuide().profilePatchPath, '/home/u/.dsh/profiles/pi-tui/cordis.patch.yml')

    const workflow = new CredentialWorkflow({
      providers: port.providers,
      credentials: port.credentials,
      authorization: port.authorization,
      account: port.account,
      catalog: { models: { available: () => true, discoverModels: async () => [] } },
      signal: new AbortController().signal,
      diag: { error: () => {}, warn: () => {} },
    })

    await workflow.setReference('ACME_API_KEY', 'sk-test-1')
    const described = await workflow.describeReference('ACME_API_KEY')
    assert.equal(described.configured, true)
    const store = await readFile(join(home, '.credentials.yaml'), 'utf8')
    assert.match(store, /ACME_API_KEY: sk-test-1/u)
    assert.equal((await stat(join(home, '.credentials.yaml'))).mode & 0o077, 0, 'the credential store is not group/world readable')

    const duplicate = await workflow.createProvider({
      route: 'acme',
      api: 'openai-completions',
      baseURL: 'https://other.example/v1',
      displayName: '',
      models: ['m'],
      apiKey: '',
    })
    assert.equal(duplicate.kind, 'rejected')
    assert.match(duplicate.kind === 'rejected' ? duplicate.text : '', /already exists/u)

    const created = await workflow.createProvider({
      route: 'new-route',
      api: 'anthropic-messages',
      baseURL: 'https://new.example/v1',
      displayName: 'New Route',
      models: ['new-1'],
      apiKey: 'sk-test-2',
    })
    assert.equal(created.kind, 'created', created.kind === 'created' ? '' : created.text)
    const stored = settingsState.section.providers['new-route'] as Record<string, unknown>
    assert.equal(stored.api, 'anthropic-messages')
    assert.equal(stored.baseURL, 'https://new.example/v1')
    assert.equal(stored.displayName, 'New Route')
    assert.deepEqual(stored.models, [{ id: 'new-1' }])
    assert.equal(stored.apiKeyEnv, 'NEW_ROUTE_API_KEY')
    assert.equal((await workflow.describeReference('NEW_ROUTE_API_KEY')).configured, true)

    const profileFacts = port.providers.readProfile('new-route')
    assert.equal(profileFacts.configured, true)
    assert.equal(profileFacts.displayName, 'New Route')
    assert.deepEqual(profileFacts.models, ['new-1'])

  }
})
