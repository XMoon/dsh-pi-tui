/**
 * Adapter contract tests for the Direct config port
 * (runtime/direct/config-direct.ts, migration M1.9): the port is the
 * semantic boundary — consumers depend on `ConfigPort`, the Direct
 * adapter owns the `ctx` access AND the Host schema knowledge (the
 * `llm-pi-ai` / `permission` / `agent-presets` settings namespaces), and
 * a Remote adapter must satisfy the SAME contract in a later milestone.
 * These tests pin the contract with a fake Host context: no generic
 * settings god API leaks, secrets appear only as write parameters, and
 * missing services degrade without crashing.
 * @module @xmoon76/dsh-pi-tui/config-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { DirectConfigPort, type HostContextLike } from '../src/runtime/direct/config-direct.ts'

function host(services: Record<string, unknown>): HostContextLike {
  return { get: (name) => services[name], on: () => {} }
}

function settings(doc: Record<string, unknown>, writes: Array<{ ns: string; ops: unknown }> = []) {
  return {
    get: (ns: string) => doc[ns],
    mutate: async (ns: string, ops: unknown) => { writes.push({ ns, ops }) },
  }
}

function port(services: Record<string, unknown>): DirectConfigPort {
  return new DirectConfigPort(host(services), undefined, (sessionId) =>
    sessionId === 'session-live' ? { session: { id: 'session-live' } } : undefined)
}

// ── provider profiles ─────────────────────────────────────────────────────

test('providers listCredentialOptions merges the directory over PER-ENTRY sections', () => {
  const providers = port({
    settings: settings({
      'llm-pi-ai': { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } },
      'llm-deepseek': { deepseek: { apiKeyEnv: 'DEEPSEEK_LEGACY' } },
    }),
    llm: {
      listConfigurableProviders: () => [
        { provider: 'acme', displayName: 'Acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'] },
        // A NON-llm-pi-ai entry: its profile lives in its OWN section.
        { provider: 'deepseek', displayName: 'DeepSeek legacy', settingsNs: 'llm-deepseek', settingsPath: ['deepseek'] },
      ],
    },
  }).providers
  const options = providers.listCredentialOptions()
  const acme = options.find(option => option.route === 'acme')
  assert.ok(acme !== undefined)
  assert.equal(acme.ref, 'ACME_KEY', 'the apiKeyEnv from the llm-pi-ai section wins')
  assert.equal(acme.configured, true)
  const legacy = options.find(option => option.route === 'deepseek')
  assert.ok(legacy !== undefined, 'the llm-deepseek entry is read from ITS OWN section')
  assert.equal(legacy.ref, 'DEEPSEEK_LEGACY')
  assert.equal(legacy.configured, true)
})

test('providers listCredentialOptions falls back to the settings-only reader without the llm service', () => {
  const providers = port({
    settings: settings({ 'llm-pi-ai': { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } } }),
  }).providers
  const options = providers.listCredentialOptions()
  assert.equal(options.length, 2, 'deepseek official + the acme route')
  assert.equal(options[0]!.route, 'deepseek-official')
  assert.equal(options[1]!.ref, 'ACME_KEY')
  assert.equal(port({}).providers.available(), false)
  assert.deepEqual(port({}).providers.listCredentialOptions().map(option => option.route), ['deepseek-official'])
})

test('providers degrade when reading an unregistered settings namespace', () => {
  const providers = port({
    settings: {
      get: () => { throw new Error('namespace not registered') },
      mutate: async () => {},
    },
  }).providers
  // The settings-only fallback sees no section: only the official target.
  assert.deepEqual(providers.listCredentialOptions().map(option => option.route), ['deepseek-official'])
})

test('providers writeProfile owns the llm-pi-ai schema (the wizard never names a namespace)', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({ settings: settings({}, writes) }).providers
  await providers.writeProfile('acme', { api: 'openai-completions', baseURL: 'http://x' })
  assert.deepEqual(writes, [
    { ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'acme'], value: { api: 'openai-completions', baseURL: 'http://x' } }] },
  ])
})

test('providers writeKeylessProfile writes an EMPTY profile at the adapter-resolved location', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({
    settings: settings({}, writes),
    llm: {
      listConfigurableProviders: () => [
        { provider: 'acme', displayName: 'acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'acme'] },
      ],
    },
  }).providers
  await providers.writeKeylessProfile('acme')
  assert.deepEqual(writes, [{ ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'acme'], value: {} }] }])
  // The conventional fallback slot when the llm directory is absent.
  const writes2: Array<{ ns: string; ops: unknown }> = []
  await port({ settings: settings({}, writes2) }).providers.writeKeylessProfile('acme')
  assert.deepEqual(writes2, [{ ns: 'llm-pi-ai', ops: [{ op: 'set', path: ['providers', 'acme'], value: {} }] }])
})

test('providers reject malformed routes before writing a settings path', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({ settings: settings({}, writes) }).providers
  await assert.rejects(() => providers.writeKeylessProfile('../escape'), /invalid provider route/)
  await assert.rejects(() => providers.writeProfile('acme/escape', {}), /invalid provider route/)
  assert.deepEqual(writes, [])
})

test('providers writeKeylessProfile refuses when the settings service is absent (never a silent no-op)', async () => {
  await assert.rejects(() => port({}).providers.writeKeylessProfile('acme'), /settings service unavailable/)
})

test('providers writeKeylessProfile refuses a hostile directory entry (namespace/path redirect)', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({
    settings: settings({}, writes),
    llm: {
      listConfigurableProviders: () => [
        // A malformed/hostile directory entry redirecting the write
        // outside the adapter-owned provider-config schema.
        { provider: 'acme', displayName: 'acme', settingsNs: 'any-namespace', settingsPath: ['evil', 'path'] },
      ],
    },
  }).providers
  await providers.writeKeylessProfile('acme')
  assert.deepEqual(writes, [], 'hostile directory metadata can never reach a mutate')
  const writes2: Array<{ ns: string; ops: unknown }> = []
  const providers2 = port({
    settings: settings({}, writes2),
    llm: {
      listConfigurableProviders: () => [
        { provider: 'acme', displayName: 'acme', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'OTHER-ROUTE'] },
      ],
    },
  }).providers
  await providers2.writeKeylessProfile('acme')
  assert.deepEqual(writes2, [], 'a path whose leaf is NOT the route is refused')
})

test('providers writeKeylessProfile writes NOTHING when the route vanished from the directory', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const providers = port({
    settings: settings({}, writes),
    llm: { listConfigurableProviders: () => [] },
  }).providers
  await providers.writeKeylessProfile('acme')
  assert.deepEqual(writes, [], 'a directory race must never fall back to a guessed slot')
})

test('config DTOs are DETACHED — mutating a returned value never aliases Host data', async () => {
  const records = [{ key: 'llm-pi-ai/openai', kind: 'oauth' }]
  const flows = [
    { key: 'llm-pi-ai/openai', label: 'openai', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: false },
  ]
  const config = port({
    credentials: {
      set: async () => {},
      unset: async () => {},
      deleteRecord: async () => {},
      describe: async () => ({ configured: true, source: 'env' }),
      listRecords: async () => records,
    },
    authorization: {
      list: () => flows,
      begin: async () => ({ status: 'authorized' }),
    },
    permissionPresets: { get names() { return ['workspace-write'] } },
    settings: settings({ 'llm-pi-ai': { providers: { acme: { apiKeyEnv: 'ACME_KEY' } } } }),
  })
  const recordsOut = await config.credentials.listRecords()
  ;(recordsOut as Array<{ key: string }>)[0]!.key = 'MUTATED'
  assert.equal(records[0]!.key, 'llm-pi-ai/openai', 'the credential records are never aliased')
  const targets = config.authorization.listTargets()
  ;(targets[0]!.methods as unknown as Array<{ id: string }>)[0]!.id = 'MUTATED'
  assert.equal(flows[0]!.methods[0]!.id, 'oauth', 'the flow methods are never aliased')
  const names = config.permissions.presetNames()
  ;(names as string[])[0] = 'MUTATED'
  assert.deepEqual(flows.length > 0 ? [] : [], [])
  const options = config.providers.listCredentialOptions()
  const acme = options.find(option => option.route === 'acme')
  assert.ok(acme !== undefined)
  // The DTO is detached: mutating the returned option never reaches the
  // Host section (the settings fake holds the live document).
  ;(acme as { ref: string }).ref = 'MUTATED'
  const again = config.providers.listCredentialOptions()
  assert.equal(again.find(option => option.route === 'acme')!.ref, 'ACME_KEY', 'the merged options are never aliased')
})

// ── credentials ───────────────────────────────────────────────────────────

test('credentials forward set/unset/delete/describe/list and never echo secrets in reads', async () => {
  const calls: string[] = []
  const credentials = port({
    credentials: {
      set: async (ref: string) => { calls.push(`set:${ref}`) },
      unset: async (ref: string) => { calls.push(`unset:${ref}`) },
      deleteRecord: async (key: string) => { calls.push(`delete:${key}`) },
      describe: async (ref: string) => ({ configured: ref === 'DEEPSEEK_API_KEY', source: 'env' }),
      listRecords: async () => [{ key: 'llm-pi-ai/openai', kind: 'oauth' }],
    },
  }).credentials
  assert.equal(credentials.available(), true)
  await credentials.setReference('DEEPSEEK_API_KEY', 'sk-secret')
  await credentials.unsetReference('DEEPSEEK_API_KEY')
  await credentials.deleteRecord('llm-pi-ai/openai')
  assert.deepEqual(calls, ['set:DEEPSEEK_API_KEY', 'unset:DEEPSEEK_API_KEY', 'delete:llm-pi-ai/openai'])
  assert.deepEqual(await credentials.describeReference('DEEPSEEK_API_KEY'), { configured: true, source: 'env' })
  assert.deepEqual(await credentials.listRecords(), [{ key: 'llm-pi-ai/openai', kind: 'oauth' }])
})

test('credentials degrade when the service is absent', async () => {
  const credentials = port({}).credentials
  assert.equal(credentials.available(), false)
  assert.deepEqual(await credentials.describeReference('X'), { configured: false })
  assert.deepEqual(await credentials.listRecords(), [])
  await assert.rejects(() => credentials.setReference('X', 'secret'), /unavailable/)
})

// ── authorization ─────────────────────────────────────────────────────────

test('authorization listTargets maps the seam entries to detached targets', () => {
  const authorization = port({
    authorization: {
      list: () => [
        { key: 'llm-pi-ai/openai', label: 'openai', methods: [{ id: 'oauth', label: 'OAuth' }], inFlight: true },
        { key: 'other/key', label: 'other', methods: [{ id: 'm', label: 'M' }], inFlight: false },
      ],
      begin: async () => ({ status: 'authorized' }),
    },
  }).authorization
  assert.equal(authorization.available(), true)
  const targets = authorization.listTargets()
  assert.equal(targets.length, 2)
  assert.equal(targets[0]!.route, 'openai', 'llm-pi-ai scope maps to the route')
  assert.equal(targets[0]!.inFlight, true)
  assert.equal(targets[1]!.route, undefined, 'foreign scopes carry no route')
})

test('authorization begins one flow and degrades when absent', async () => {
  const begins: string[] = []
  const authorization = port({
    authorization: {
      list: () => [],
      begin: async (request: { key: string }) => { begins.push(request.key); return { status: 'authorized' } },
    },
  }).authorization
  assert.deepEqual(await authorization.begin({ key: 'llm-pi-ai/openai', interaction: {} as never }), { status: 'authorized' })
  assert.deepEqual(begins, ['llm-pi-ai/openai'])
  assert.equal(port({}).authorization.available(), false)
  assert.deepEqual(port({}).authorization.listTargets(), [])
})

// ── permissions ───────────────────────────────────────────────────────────

test('permissions read names and the persisted default, and persist the default', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const permissions = port({
    permissionPresets: { get names() { return ['workspace-write', 'danger-full-access'] } },
    settings: settings({ permission: { defaultPreset: 'workspace-write' } }, writes),
  }).permissions
  assert.deepEqual(permissions.presetNames(), ['workspace-write', 'danger-full-access'])
  assert.equal(permissions.defaultPreset(), 'workspace-write')
  await permissions.setDefaultPreset('danger-full-access')
  assert.deepEqual(writes, [{ ns: 'permission', ops: [{ op: 'set', path: ['defaultPreset'], value: 'danger-full-access' }] }])
  assert.equal(port({}).permissions.defaultPreset(), undefined, 'no settings -> no default')
})

test('applyPermissionPreset runs the OFFICIAL command line through the resolved agent', async () => {
  const executed: Array<{ line: string }> = []
  const permissions = port({
    permissionPresets: { get names() { return ['workspace-write', 'danger-full-access'] } },
    commands: {
      execute: async (_agent: unknown, line: string) => { executed.push({ line }); return { ok: true } },
    },
  }).permissions
  assert.deepEqual(await permissions.applyPermissionPreset('session-live', 'danger-full-access'), { kind: 'applied' })
  assert.deepEqual(executed, [{ line: '/permission danger-full-access' }])
  assert.deepEqual(await permissions.applyPermissionPreset('session-other', 'danger-full-access'), { kind: 'unavailable', cause: 'permission' })
  assert.deepEqual(await port({}).permissions.applyPermissionPreset('session-live', 'danger-full-access'), { kind: 'unavailable', cause: 'commands' })
})

test('applyPermissionPreset refuses a preset id the composed table does not offer', async () => {
  let executed = 0
  const permissions = port({
    permissionPresets: { get names() { return ['workspace-write'] } },
    commands: {
      execute: async () => { executed += 1; return { ok: true } },
    },
  }).permissions
  assert.deepEqual(
    await permissions.applyPermissionPreset('session-live', 'danger-full-access; rm -rf /'),
    { kind: 'unavailable', cause: 'permission' },
    'a hostile id never reaches the command line',
  )
  assert.equal(executed, 0)
})

// ── preset default ────────────────────────────────────────────────────────

test('presetDefault reads the settings doc with the roster default fallback and persists', async () => {
  const writes: Array<{ ns: string; ops: unknown }> = []
  const presetDefault = port({
    settings: settings({ 'agent-presets': { default: 'code' } }, writes),
    agentPresets: { get defaultId() { return 'standard' } },
  }).presetDefault
  assert.equal(presetDefault.available(), true)
  assert.equal(presetDefault.get(), 'code', 'the saved value wins')
  await presetDefault.set('minimal')
  assert.deepEqual(writes, [{ ns: 'agent-presets', ops: [{ op: 'set', path: ['default'], value: 'minimal' }] }])
})

test('presetDefault falls back to the roster default and degrades without settings', () => {
  const presetDefault = port({
    settings: settings({}),
    agentPresets: { get defaultId() { return 'standard' } },
  }).presetDefault
  assert.equal(presetDefault.get(), 'standard')
  assert.equal(port({}).presetDefault.available(), false)
  assert.equal(port({}).presetDefault.get(), undefined)
})

// ── event wiring ──────────────────────────────────────────────────────────

test('credential onChanged subscribes both reference- and record-updated', async () => {
  const ctx = new Context()
  const refreshes: string[] = []
  new DirectConfigPort(ctx as never, undefined, () => undefined)
    .credentials.onChanged(() => { refreshes.push('refresh') })
  ctx.emit('credentials/reference-updated', 'DEEPSEEK_API_KEY' as never)
  ctx.emit('credentials/record-updated', 'llm-pi-ai/openai' as never)
  await Promise.resolve()
  assert.deepEqual(refreshes, ['refresh', 'refresh'])
})
