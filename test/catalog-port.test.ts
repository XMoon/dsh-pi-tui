/**
 * Adapter contract tests for the Direct catalog port
 * (runtime/direct/catalog-direct.ts, migration M1.8): the port is the
 * semantic boundary — consumers depend on `Catalog` (models/presets/
 * skills), the Direct adapter owns the `ctx` access, and a Remote adapter
 * must satisfy the SAME contract in a later milestone. These tests pin
 * the contract with a fake Host context: detached DTOs only (never a
 * service object, never an Agent), graceful degradation on missing
 * services, cancellation distinct from failure, and the skill
 * host-vs-fallback decision.
 * @module @xmoon76/dsh-pi-tui/catalog-port.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectCatalogPort, type HostContextLike } from '../src/runtime/direct/catalog-direct.ts'
import type { AgentPreset } from '@deepseek-ai/dsh-agent-preset-registry'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function host(services: Record<string, unknown>): HostContextLike {
  return { get: (name) => services[name], on: () => {} }
}

function preset(id: string, extra: Partial<AgentPreset> = {}): AgentPreset {
  return { id, ...extra }
}

const liveAgent = {
  ctx: {},
  session: { id: 'session-live', header: { cwd: '/ws' } },
}

function port(services: Record<string, unknown>): DirectCatalogPort {
  return new DirectCatalogPort(host(services), (sessionId) =>
    sessionId === 'session-live' ? liveAgent : undefined)
}

// ── models ────────────────────────────────────────────────────────────────

test('models degrade to empty DTOs when the llm service is absent', async () => {
  const models = port({}).models
  assert.equal(models.available(), false)
  assert.deepEqual(models.listProviders(), [])
  assert.deepEqual(await models.listModels('p'), [])
  assert.deepEqual(await models.loadDirectory(), { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] })
  assert.deepEqual(await models.discoverModels({ baseURL: 'x' }), [])
  assert.equal(models.listConfigurableProviders(), undefined)
  assert.equal(models.defaultSelection(), undefined)
})

test('models surface detached provider/model DTOs and forward discovery', async () => {
  let saved: unknown
  const models = port({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next,
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async (providerId: string) => providerId === 'deepseek'
        ? [{ id: 'deepseek-chat', name: 'Chat' }]
        : [],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' } }),
      discoverModels: async (_ns: string, request: { baseURL?: string }) => [{ id: 'm1' }],
      listConfigurableProviders: () => [{ provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: [] }],
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      saveSelection: async (next: unknown) => { saved = next },
    },
  }).models
  assert.equal(models.available(), true)
  assert.deepEqual(models.listProviders(), [{ id: 'deepseek', name: 'DeepSeek' }])
  assert.deepEqual(await models.listModels('deepseek'), [{ id: 'deepseek-chat', name: 'Chat' }])
  assert.deepEqual(await models.loadDirectory(), {
    default: { provider: 'deepseek', model: 'deepseek-chat' },
    routableProviders: ['deepseek'],
    groups: [{
      id: 'deepseek',
      name: 'DeepSeek',
      models: [{
        id: 'deepseek-chat',
        name: 'Chat',
        reasoning: { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' },
      }],
    }],
    failures: [],
  })
  assert.deepEqual(await models.discoverModels({ baseURL: 'http://x' }), [{ id: 'm1' }])
  assert.deepEqual(models.listConfigurableProviders(), [{ id: 'openai', displayName: 'openai' }])
  assert.deepEqual(models.defaultSelection(), { provider: 'deepseek', model: 'deepseek-chat' })
  await models.saveDefaultSelection({ provider: 'deepseek', model: 'deepseek-chat' })
  assert.deepEqual(saved, { provider: 'deepseek', model: 'deepseek-chat' })
})

test('loadDirectory keeps a failing provider as an isolated failure beside usable groups', async () => {
  const models = port({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next,
      listProviders: () => [{ id: 'good', name: 'Good' }, { id: 'bad', name: 'Bad' }],
      listModels: async (providerId: string) => {
        if (providerId === 'bad') throw new Error('route unavailable')
        return [{ id: 'm1' }]
      },
      resolveModelInfo: async () => ({}),
      discoverModels: async () => [],
      listConfigurableProviders: () => [],
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'good', model: 'm1' }),
      saveSelection: async () => {},
    },
  }).models
  const directory = await models.loadDirectory()
  assert.deepEqual(directory.groups.map(group => group.id), ['good'])
  assert.deepEqual(directory.failures, [{ id: 'bad', name: 'Bad', message: 'route unavailable' }])
  assert.deepEqual(directory.routableProviders, ['good', 'bad'])
})

test('model catalog separates global default from live Session selection', async () => {
  const appended: unknown[] = []
  let liveSelection: { provider: string; model: string; reasoningEffort?: string } = {
    provider: 'session-provider', model: 'session-model', reasoningEffort: 'high',
  }
  let savedDefault: unknown
  const owner = {
    current: () => liveSelection,
    appendSelection: (_agent: unknown, next: typeof liveSelection) => {
      appended.push({ type: 'model/selection', data: next })
    },
    setCurrent: (_agent: unknown, next: typeof liveSelection) => {
      liveSelection = next
    },
    selectForNextRequest: (_agent: unknown, next: typeof liveSelection) => {
      appended.push({ type: 'model/selection', data: next })
      liveSelection = next
    },
  }
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
      saveSelection: async (next: unknown) => { savedDefault = next },
    },
  }), () => liveAgent, owner).models

  assert.deepEqual(models.defaultSelection(), { provider: 'default-provider', model: 'default-model' })
  assert.deepEqual(models.sessionSelection('session-live'), liveSelection)
  const { outcome } = await models.selectSessionModel('session-live', { provider: 'new-provider', model: 'new-model', reasoningEffort: 'max' })
  assert.deepEqual(outcome, {
    kind: 'committed',
    value: { provider: 'new-provider', model: 'new-model', reasoningEffort: 'max' },
  })
  assert.deepEqual(appended, [{
    type: 'model/selection',
    data: { provider: 'new-provider', model: 'new-model', reasoningEffort: 'max' },
  }])
  assert.deepEqual(models.sessionSelection('session-live'), {
    provider: 'new-provider', model: 'new-model', reasoningEffort: 'max',
  })
  assert.deepEqual(savedDefault, {
    provider: 'new-provider', model: 'new-model', reasoningEffort: 'max',
  })
})

test('overlapping default writes reassert the newest choice after stale completion', async () => {
  let rejectFirst!: (error: Error) => void
  const calls: string[] = []
  const first = new Promise<never>((_resolve, reject) => { rejectFirst = reject })
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'global', model: calls.at(-1) ?? 'default' }),
      saveSelection: (next: { model: string }) => {
        calls.push(next.model)
        return next.model === 'old' ? first : Promise.resolve()
      },
    },
  }), () => undefined).models

  const stale = models.saveDefaultSelection({ provider: 'p', model: 'old' })
  const latest = models.saveDefaultSelection({ provider: 'p', model: 'new' })
  await latest
  rejectFirst(new Error('stale write failed'))
  const staleOutcome = await stale
  assert.equal(staleOutcome.kind, 'indeterminate', 'a failed default write settles indeterminate, never a rejection')
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.at(-1), 'new', 'the stale completion must not leave the global default at old')
})

test('a stale SUCCESSFUL write still reasserts the newest choice', async () => {
  let resolveFirst!: () => void
  const calls: string[] = []
  const first = new Promise<void>((resolve) => { resolveFirst = resolve })
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'global', model: calls.at(-1) ?? 'default' }),
      saveSelection: (next: { model: string }) => {
        calls.push(next.model)
        return next.model === 'old' ? first : Promise.resolve()
      },
    },
  }), () => undefined).models

  const stale = models.saveDefaultSelection({ provider: 'p', model: 'old' })
  const latest = models.saveDefaultSelection({ provider: 'p', model: 'new' })
  await latest
  resolveFirst() // the stale write SUCCEEDS after the newer one
  await stale
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.at(-1), 'new', 'a stale success must not leave the global default at old')
})

test('a selection started during the correction is reasserted after it', async () => {
  let resolveFirst!: () => void
  let resolveCorrection!: () => void
  const calls: string[] = []
  const first = new Promise<void>((resolve) => { resolveFirst = resolve })
  let correction: Promise<void> | undefined
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'global', model: calls.at(-1) ?? 'default' }),
      saveSelection: (next: { model: string }) => {
        calls.push(next.model)
        if (next.model === 'old') return first
        // The third write is the fencing correction for 'new': hold it so a
        // newer selection can start while the correction is in flight.
        if (calls.length === 3) {
          correction = new Promise<void>((resolve) => { resolveCorrection = resolve })
          return correction
        }
        return Promise.resolve()
      },
    },
  }), () => undefined).models

  const stale = models.saveDefaultSelection({ provider: 'p', model: 'old' })
  const latest = models.saveDefaultSelection({ provider: 'p', model: 'new' })
  await latest
  resolveFirst() // the stale write completes; its fence starts the held correction
  // Bounded microtask flush (never a fixed timer): the correction write must
  // have been launched before the newer selection starts.
  for (let i = 0; i < 16 && calls.length < 3; i += 1) await Promise.resolve()
  assert.equal(calls.at(-1), 'new', 'the correction for the newest value must be in flight')
  const newest = models.saveDefaultSelection({ provider: 'p', model: 'newest' })
  await newest
  resolveCorrection() // the held correction completes
  await stale // the stale promise now INCLUDES its awaited correction
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.at(-1), 'newest', 'a selection started during the correction must be reasserted after it')
})

test('a failed fencing correction is reported through the diagnostic sink', async () => {
  let resolveFirst!: () => void
  const calls: string[] = []
  const warnings: string[] = []
  const first = new Promise<void>((resolve) => { resolveFirst = resolve })
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'global', model: calls.at(-1) ?? 'default' }),
      saveSelection: (next: { model: string }) => {
        calls.push(next.model)
        if (next.model === 'old') return first
        // The third write is the fencing correction for 'new': make it fail.
        if (calls.length === 3) return Promise.reject(new Error('correction write failed'))
        return Promise.resolve()
      },
    },
  }), () => undefined, undefined, { warn: (message: string) => { warnings.push(message) } }).models

  const stale = models.saveDefaultSelection({ provider: 'p', model: 'old' })
  const latest = models.saveDefaultSelection({ provider: 'p', model: 'new' })
  await latest
  resolveFirst() // the stale write completes; its fence starts the correction
  await stale
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(warnings.length, 1, 'the failed correction must be reported, never silently swallowed')
  assert.match(warnings[0]!, /correction failed/u)
})

test('a global-default save failure does not erase a durable live Session choice', async () => {
  const appended: unknown[] = []
  let liveSelection: { provider: string; model: string } = { provider: 'old-provider', model: 'old-model' }
  const owner = {
    current: () => liveSelection,
    appendSelection: (_agent: unknown, next: { provider: string; model: string }) => {
      appended.push({ type: 'model/selection', data: next })
    },
    setCurrent: (_agent: unknown, next: { provider: string; model: string }) => {
      liveSelection = next
    },
    selectForNextRequest: (_agent: unknown, next: { provider: string; model: string }) => {
      appended.push({ type: 'model/selection', data: next })
      liveSelection = next
    },
  }
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'global', model: 'default' }),
      saveSelection: async () => { throw new Error('quota exceeded') },
    },
  }), () => liveAgent, owner).models

  // A committed Session selection stands even when the best-effort global
  // default save fails: the outcome is committed, never a rejection.
  const { outcome } = await models.selectSessionModel('session-live', { provider: 'new-provider', model: 'new-model' })
  assert.deepEqual(outcome, { kind: 'committed', value: { provider: 'new-provider', model: 'new-model' } })
  assert.deepEqual(appended, [{ type: 'model/selection', data: { provider: 'new-provider', model: 'new-model' } }])
  assert.deepEqual(models.sessionSelection('session-live'), { provider: 'new-provider', model: 'new-model' })
})

test('a failed durable append never becomes the Agent selection', async () => {
  const owner = {
    current: () => ({ provider: 'old-provider', model: 'old-model' }),
    appendSelection: () => { throw new Error('append failed') },
    setCurrent: () => { throw new Error('setCurrent must not run after a failed append') },
    selectForNextRequest: () => { throw new Error('selectForNextRequest must not run') },
  }
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'global', model: 'default' }),
      saveSelection: async () => {},
    },
  }), () => liveAgent, owner).models

  const { outcome } = await models.selectSessionModel('session-live', { provider: 'new-provider', model: 'new-model' })
  assert.equal(outcome.kind, 'rejected')
  assert.deepEqual(models.sessionSelection('session-live'), { provider: 'old-provider', model: 'old-model' },
    'a failed append must leave the Agent selection untouched')
})

test('a failed selection is never resurrected by the fencing correction', async () => {
  let resolveFirst!: () => void
  let resolveCorrection!: () => void
  const calls: string[] = []
  const first = new Promise<void>((resolve) => { resolveFirst = resolve })
  let correction: Promise<void> | undefined
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'global', model: calls.at(-1) ?? 'default' }),
      saveSelection: (next: { model: string }) => {
        calls.push(next.model)
        if (next.model === 'old') return first
        if (next.model === 'new') {
          // The second 'new' write is the fencing correction: hold it.
          if (calls.filter(call => call === 'new').length === 2) {
            correction = new Promise<void>((resolve) => { resolveCorrection = resolve })
            return correction
          }
          return Promise.resolve()
        }
        // 'newest' (the failed choice) always fails.
        return Promise.reject(new Error('quota exceeded'))
      },
    },
  }), () => undefined).models

  const stale = models.saveDefaultSelection({ provider: 'p', model: 'old' })
  const latest = models.saveDefaultSelection({ provider: 'p', model: 'new' })
  await latest
  resolveFirst() // the stale write completes; its fence starts the held correction
  // Bounded microtask flush: wait until the held correction has been launched.
  for (let i = 0; i < 16 && calls.filter(call => call === 'new').length < 2; i += 1) await Promise.resolve()
  assert.equal(calls.at(-1), 'new', 'the correction for the newest committed value must be in flight')
  const newestOutcome = await models.saveDefaultSelection({ provider: 'p', model: 'newest' })
  assert.equal(newestOutcome.kind, 'indeterminate', 'a failed default write settles indeterminate')
  resolveCorrection() // the held correction completes
  await stale // the stale promise now INCLUDES its awaited correction
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.at(-1), 'new',
    'a failed selection must never be resurrected by the correction: the persistent target stays the newest committed value')
})

test('a stale success after a failed newer attempt still reasserts the newest committed value', async () => {
  let resolveA!: () => void
  let resolveB!: () => void
  const calls: string[] = []
  const a = new Promise<void>((resolve) => { resolveA = resolve })
  const b = new Promise<void>((resolve) => { resolveB = resolve })
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'global', model: calls.at(-1) ?? 'default' }),
      saveSelection: (next: { model: string }) => {
        calls.push(next.model)
        if (next.model === 'old') return a
        if (next.model === 'new') return b
        // 'newest' (C) always fails.
        return Promise.reject(new Error('quota exceeded'))
      },
    },
  }), () => undefined).models

  const stale = models.saveDefaultSelection({ provider: 'p', model: 'old' }) // A gen1
  const mid = models.saveDefaultSelection({ provider: 'p', model: 'new' }) // B gen2
  const failed = models.saveDefaultSelection({ provider: 'p', model: 'newest' }) // C gen3
  const failedOutcome = await failed // C fails first
  assert.equal(failedOutcome.kind, 'indeterminate')
  resolveB() // B succeeds while C's generation is current
  await mid
  resolveA() // A succeeds LAST, overwriting the store with the stale value
  await stale
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.at(-1), 'new',
    'a stale success after a failed newer attempt must still reassert the newest committed value (B), never the stale A')
})

test('catalog DTOs are DETACHED — mutating a returned value never aliases Host data', async () => {
  const providers = [{ id: 'deepseek', name: 'DeepSeek' }]
  const models = [{ id: 'deepseek-chat' }]
  const efforts = [{ id: 'low', name: 'Low' }]
  const directory = [{ provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'] }]
  const modelsPort = port({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next,
      listProviders: () => providers,
      listModels: async () => models,
      resolveModelInfo: async () => ({ reasoning: { efforts } }),
      discoverModels: async () => models,
      listConfigurableProviders: () => directory,
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      saveSelection: async () => {},
    },
  }).models
  const listed = modelsPort.listProviders()
  ;(listed as Array<{ id: string; name: string }>)[0]!.name = 'MUTATED'
  assert.equal(providers[0]!.name, 'DeepSeek', 'the provider registry array is never aliased')
  const modelList = await modelsPort.listModels('deepseek')
  ;(modelList as Array<{ id: string }>)[0]!.id = 'MUTATED'
  assert.equal(models[0]!.id, 'deepseek-chat', 'the model list is never aliased')
  const modelDir = await modelsPort.loadDirectory()
  ;(modelDir.groups as unknown as Array<{ models: Array<{ id: string }> }>)[0]!.models[0]!.id = 'MUTATED'
  assert.equal(models[0]!.id, 'deepseek-chat', 'the directory model list is never aliased')
  ;(modelDir.groups as unknown as Array<{ models: Array<{ reasoning: { efforts: Array<{ id: string }> } }> }>)[0]!
    .models[0]!.reasoning.efforts[0]!.id = 'MUTATED'
  assert.equal(efforts[0]!.id, 'low', 'the directory reasoning metadata is never aliased')
  const directoryOut = modelsPort.listConfigurableProviders()!
  ;(directoryOut as unknown as Array<{ displayName: string }>)[0]!.displayName = 'MUTATED'
  assert.equal(directory[0]!.displayName, 'openai', 'the directory entries are never aliased')
  // The semantic DTO never exposes the config schema layout.
  assert.deepEqual(Object.keys(directoryOut[0]!).sort(), ['displayName', 'id'], 'no settings namespace/path in the catalog contract')
  const skillSource = {
    resourceBase: { kind: 'directory', path: '/skills', nested: { owner: 'host' } },
    invocation: { userInvocable: true, modelInvocable: true },
  }
  const skillPort = port({
    skills: {
      snapshot: async () => ({ skills: [], complete: true }),
      get: async () => ({ name: 'alpha', description: 'A', content: 'body', ...skillSource }),
    },
  }).skills
  const resolved = await skillPort.resolveSkill('session-live', 'alpha')
  assert.equal(resolved.kind, 'found')
  if (resolved.kind === 'found') {
    ;(resolved.skill.resourceBase as { nested: { owner: string } }).nested.owner = 'client-mutation'
    ;(resolved.skill.invocation as { userInvocable?: unknown }).userInvocable = false
    assert.equal(skillSource.resourceBase.nested.owner, 'host', 'nested resource metadata is detached')
    assert.equal(skillSource.invocation.userInvocable, true, 'invocation policy is detached')
  }
})

// ── presets ───────────────────────────────────────────────────────────────

test('presets degrade to unavailable without a roster service', async () => {
  const presets = port({}).presets
  assert.equal(presets.available(), false)
  assert.deepEqual(await presets.roster(), { presets: [], modeSelectionEnabled: false })
  assert.deepEqual(await presets.resolve('standard'), {}, 'rosterless resolve yields no preset identity')
  assert.deepEqual(await presets.resolve('code'), {}, 'an ordinary id is never special in a rosterless deployment')
  assert.equal(presets.defaultId(), undefined)
})

test('presets roster/resolve/defaultId return detached roster DTOs', async () => {
  const presets = port({
    agentPresets: {
      remoteExportList: async () => ({
        presets: [
          { id: 'standard', isDefault: true },
          { id: 'code', name: 'PTC', broken: 'x' },
        ],
        modeSelectionEnabled: true,
      }),
      resolve: async (id?: string) => preset(id ?? 'standard'),
      get defaultId() { return 'standard' },
    },
  }).presets
  assert.equal(presets.available(), true)
  const roster = await presets.roster()
  assert.deepEqual(roster, {
    presets: [
      { id: 'standard' },
      { id: 'code', name: 'PTC', broken: 'x' },
    ],
    defaultId: 'standard',
    modeSelectionEnabled: true,
  })
  assert.deepEqual(await presets.resolve(undefined), { id: 'standard' }, 'concrete id only, no setup callback')
  assert.deepEqual(await presets.resolve('code'), { id: 'code' }, 'a legal custom code id resolves as itself')
  assert.equal(presets.defaultId(), 'standard')
})

test('presets roster carries the Host mode-selection policy', async () => {
  const presets = port({
    agentPresets: {
      remoteExportList: async () => ({
        presets: [{ id: 'standard', isDefault: true }],
        modeSelectionEnabled: false,
      }),
      resolve: async (id?: string) => preset(id ?? 'standard'),
      get defaultId() { return 'standard' },
    },
  }).presets
  assert.deepEqual(await presets.roster(), {
    presets: [{ id: 'standard' }],
    defaultId: 'standard',
    modeSelectionEnabled: false,
  })
})

test('presets selectSessionPreset maps the official blank-session select', async () => {
  const calls: Array<{ agent: unknown; presetId: string }> = []
  const presets = port({
    agentPresets: {
      resolve: async (id?: string) => preset(id ?? 'standard'),
      get defaultId() { return 'standard' },
      select: async (agent: unknown, presetId: string) => { calls.push({ agent, presetId }); return presetId },
    },
  }).presets
  const { outcome } = await presets.selectSessionPreset('session-live', 'standard')
  assert.deepEqual(outcome, { kind: 'committed', value: { preset: 'standard' } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.agent, liveAgent, 'the adapter resolves the live Agent by session id')
})

test('presets selectSessionPreset reports the official locked refusal as rejected', async () => {
  const presets = port({
    agentPresets: {
      resolve: async (id?: string) => preset(id ?? 'standard'),
      get defaultId() { return 'standard' },
      select: async () => { throw Object.assign(new Error('session has already started'), { code: 'agent-preset/locked' }) },
    },
  }).presets
  const { outcome } = await presets.selectSessionPreset('session-live', 'minimal')
  assert.equal(outcome.kind, 'rejected')
  if (outcome.kind === 'rejected') assert.equal(outcome.error.code, 'agent-preset/locked')
})

test('presets selectSessionPreset refuses when the session is not live', async () => {
  const presets = port({
    agentPresets: {
      resolve: async (id?: string) => preset(id ?? 'standard'),
      get defaultId() { return 'standard' },
      select: async () => 'standard',
    },
  }).presets
  const { outcome } = await presets.selectSessionPreset('session-other', 'standard')
  assert.equal(outcome.kind, 'rejected')
  if (outcome.kind === 'rejected') assert.equal(outcome.error.code, 'session/not-found')
})

test('presets treats a declared code id as an ordinary preset — never rewritten, no legacy fallback', async () => {
  const resolved: Array<string | undefined> = []
  const presets = port({
    agentPresets: {
      remoteExportList: async () => ({ presets: [{ id: 'code', isDefault: true }], modeSelectionEnabled: true }),
      resolve: async (id?: string) => {
        resolved.push(id)
        if (id === 'code' || id === undefined) return preset('code')
        throw Object.assign(new Error('unknown preset'), { presetId: id })
      },
      get defaultId() { return 'code' },
    },
  }).presets
  // An explicit code resolves AS code — the registry owns identity and the
  // TUI adds no alias, no probe and no ptc fallback.
  assert.deepEqual(await presets.resolve('code'), { id: 'code' })
  assert.deepEqual(await presets.resolve(undefined), { id: 'code' }, 'the default resolves through the registry alone')
  assert.deepEqual(resolved, ['code', undefined])
})

test('presets.resolve propagates an unknown-preset rejection', async () => {
  const presets = port({
    agentPresets: {
      resolve: async () => { throw new Error('unknown preset') },
      get defaultId() { return 'standard' },
    },
  }).presets
  await assert.rejects(() => presets.resolve('nope'), /unknown preset/)
})

// ── skills ────────────────────────────────────────────────────────────────

function skillRegistry(entries: Record<string, unknown>, invocation = { userInvocable: true, modelInvocable: true }) {
  return {
    snapshot: async () => ({ skills: Object.entries(entries).map(([name, description]) => ({ name, description, invocation })), complete: true }),
    get: async (name: string) => entries[name] === undefined
      ? undefined
      : { name, description: entries[name], invocation, content: 'body of ' + name },
  }
}

test('skills listHumanSkills resolves the session agent and returns detached summaries', async () => {
  const skills = port({
    skills: skillRegistry({ alpha: 'A skill', beta: 'B skill' }),
    agentPresets: {},
  }).skills
  const catalog = await skills.listHumanSkills('session-live')
  assert.ok(catalog !== undefined)
  assert.deepEqual(catalog.skills.map(s => s.name), ['alpha', 'beta'], 'stable sort')
})

test('skills listHumanSkills returns undefined for an unresolvable session', async () => {
  const skills = port({ skills: skillRegistry({ alpha: 'A' }) }).skills
  assert.equal(await skills.listHumanSkills('session-other'), undefined)
})

test('skills resolveSkill classifies unavailable/unknown/malformed/found distinctly', async () => {
  const skills = port({
    skills: skillRegistry({ alpha: 'A', bad: 42 }),
  }).skills
  assert.deepEqual(await skills.resolveSkill('session-other', 'alpha'), { kind: 'unavailable' })
  assert.deepEqual(await skills.resolveSkill('session-live', 'nope'), { kind: 'unknown' })
  assert.deepEqual(await skills.resolveSkill('session-live', 'bad'), { kind: 'malformed' })
  const found = await skills.resolveSkill('session-live', 'alpha')
  assert.equal(found.kind, 'found')
  if (found.kind === 'found') {
    assert.deepEqual(found.skill, {
      name: 'alpha',
      description: 'A',
      content: 'body of alpha',
      invocation: { userInvocable: true, modelInvocable: true },
    }, 'detached definition DTO, never the registry object')
  }
})

test('skills hostLoadsSkillBody probes the tools loader with the resolved agent', () => {
  const calls: unknown[] = []
  const skills = port({
    tools: { get: (name: string, agent: unknown) => {
      calls.push(agent)
      return name === 'skill' ? { execute: () => {}, parameters: {} } : undefined
    } },
  }).skills
  assert.equal(skills.hostLoadsSkillBody('session-live'), true)
  assert.equal(skills.hostLoadsSkillBody('session-other'), false, 'unresolvable session -> no loader')
  assert.equal(calls.length, 1, 'the probe resolves the SESSION agent internally')
})

test('skills hostLoadsSkillBody treats a shadow named skill without a loader shape as absent', () => {
  const skills = port({
    tools: { get: () => ({ parameters: {} }) },
  }).skills
  assert.equal(skills.hostLoadsSkillBody('session-live'), false)
})

test('skills standing reads the cold catalog through the standing scope', async () => {
  let standingKey: string | undefined
  const skills = port({
    skills: skillRegistry({ cold: 'Cold skill' }),
    agentPresets: {
      acquireScope: async (id?: string) => { standingKey = id; return { key: { scope: 'standing' }, [Symbol.asyncDispose]: async () => {} } },
    },
  }).skills
  const read = await skills.standing('standard', '/ws')
  assert.equal(standingKey, 'standard')
  assert.deepEqual(read.catalog.skills.map(s => s.name), ['cold'])
  assert.equal(read.notice, undefined)
})

test('skills standing degrades to the global layer with a one-shot notice', async () => {
  const skills = port({
    skills: skillRegistry({ cold: 'Cold skill' }),
    agentPresets: {
      acquireScope: async () => { throw new Error('mount broken') },
    },
  }).skills
  const read = await skills.standing(undefined, '/ws')
  assert.deepEqual(read.catalog.skills.map(s => s.name), ['cold'])
  assert.ok(read.notice !== undefined && read.notice.includes('mount broken'))
})

test('skills standing throws when no registry is reachable', async () => {
  const skills = port({ agentPresets: {} }).skills
  await assert.rejects(() => skills.standing(undefined, '/ws'), /skill service unavailable/)
})

test('model discovery stays on the official seam (alpha.4 profile-header regression)', async () => {
  // Alpha.4 fixed the HOST to reuse a configured provider profile's custom
  // headers during discovery. The TUI's contract is unchanged and must
  // STAY unchanged: the request is forwarded VERBATIM to
  // `ctx.llm.discoverModels` (the only seam — the TUI never reconstructs
  // headers, reads stored credentials, or fetches /models itself), and the
  // answer is projected to detached id/name DTOs only.
  const seen: Array<{ ns: string; request: unknown }> = []
  const models = port({
    llm: { resolveCallConfig: async (next: { provider: string; model: string; reasoningEffort?: string }) => next,
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      discoverModels: async (ns: string, request: unknown) => {
        seen.push({ ns, request })
        return [{ id: 'profiled-model' }]
      },
      listConfigurableProviders: () => [],
    },
  }).models
  const request = { provider: 'acme-gateway', baseURL: 'https://acme.example/v1', api: 'openai' }
  const discovered = await models.discoverModels(request)
  assert.deepEqual(discovered, [{ id: 'profiled-model' }])
  assert.equal(seen.length, 1, 'exactly one official discovery call')
  assert.equal(seen[0]!.ns, 'llm-pi-ai', 'the adapter owns the settings namespace')
  assert.deepEqual(seen[0]!.request, request, 'the request crosses the seam verbatim (headers stay HOST-side)')
})

// ── D2.3 Direct model Host authority ──────────────────────────────────────

/** One Direct model catalog over a scripted Host call-config resolver. */
function modelOwnerDouble(): { owner: {
  current(): { provider: string; model: string }
  appendSelection(agent: unknown, next: { provider: string; model: string; reasoningEffort?: string }): void
  setCurrent(agent: unknown, next: { provider: string; model: string; reasoningEffort?: string }): void
  selectForNextRequest(agent: unknown, next: unknown): void
}; appended: unknown[] } {
  const appended: unknown[] = []
  let current = { provider: 'old-provider', model: 'old-model' }
  return {
    appended,
    owner: {
      current: () => current,
      appendSelection: (_agent, next) => { appended.push({ type: 'model/selection', data: next }) },
      setCurrent: (_agent, next) => { current = next },
      selectForNextRequest: () => {},
    },
  }
}

test('selectSessionModel resolves through the Host call config and refuses an unavailable model before any commit', async () => {
  const { owner, appended } = modelOwnerDouble()
  let resolvedWith: unknown
  const models = new DirectCatalogPort(host({
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      resolveCallConfig: async (request: unknown) => { resolvedWith = request; throw new Error('unknown route') },
      discoverModels: async () => [],
      listConfigurableProviders: () => [],
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'p', model: 'm' }),
      saveSelection: async () => {},
    },
  }), () => liveAgent, owner).models
  const { outcome } = await models.selectSessionModel('session-live', { provider: 'p', model: 'nope', reasoningEffort: 'low' })
  assert.deepEqual(resolvedWith, { provider: 'p', model: 'nope', reasoningEffort: 'low' },
    'the Host resolver receives the exact requested selection')
  assert.equal(outcome.kind, 'rejected')
  if (outcome.kind === 'rejected') assert.equal(outcome.error.code, 'session/model-unavailable')
  assert.deepEqual(appended, [], 'an unavailable model is refused before any durable append')
})

test('selectSessionModel commits the Host-NORMALIZED selection, never the raw request', async () => {
  const { owner, appended } = modelOwnerDouble()
  const models = new DirectCatalogPort(host({
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
      resolveCallConfig: async () => ({ provider: 'p', model: 'm1', reasoningEffort: 'high' }),
      discoverModels: async () => [],
      listConfigurableProviders: () => [],
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'p', model: 'm' }),
      saveSelection: async () => {},
    },
  }), () => liveAgent, owner).models
  const { outcome } = await models.selectSessionModel('session-live', { provider: 'p', model: 'm1' })
  assert.deepEqual(outcome, { kind: 'committed', value: { provider: 'p', model: 'm1', reasoningEffort: 'high' } })
  assert.deepEqual(appended, [{
    type: 'model/selection',
    data: { provider: 'p', model: 'm1', reasoningEffort: 'high' },
  }], 'the durable append records the Host-normalized selection')
})

test('selectSessionPreset reports an unrecognized preset failure as indeterminate, not a blind rejection', async () => {
  const presets = port({
    agentPresets: {
      resolve: async (id?: string) => preset(id ?? 'standard'),
      get defaultId() { return 'standard' },
      select: async () => { throw new Error('durable append exploded after recompose') },
    },
  }).presets
  const { outcome } = await presets.selectSessionPreset('session-live', 'minimal')
  assert.equal(outcome.kind, 'indeterminate')
  if (outcome.kind === 'indeterminate') assert.equal(outcome.error.code, 'agent-preset/select-indeterminate')
})

test('Direct selectSessionModel honours an abort during normalization (before the durable append)', async () => {
  const appended: unknown[] = []
  let release!: (value: { provider: string; model: string }) => void
  const gate = new Promise<{ provider: string; model: string }>((resolve) => { release = resolve })
  const owner = {
    current: () => undefined,
    appendSelection: (_agent: unknown, next: unknown) => { appended.push(next) },
    setCurrent: () => {},
    selectForNextRequest: () => {},
  }
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async () => gate, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: { currentSelection: () => undefined, saveSelection: async () => {} },
  }), () => liveAgent, owner).models
  const controller = new AbortController()
  const pending = models.selectSessionModel('session-live', { provider: 'p', model: 'm' }, controller.signal)
  await Promise.resolve()
  controller.abort()
  release({ provider: 'p', model: 'm' })
  const result = await pending
  assert.equal(result.ownership, 'current')
  assert.equal(result.outcome.kind, 'cancelled', 'an abort before the durable append provably did not commit')
  assert.deepEqual(appended, [])
})

test('Direct selectSessionModel reports cancelled for an already-aborted signal', async () => {
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: unknown) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
  }), () => liveAgent).models
  const controller = new AbortController()
  controller.abort()
  const result = await models.selectSessionModel('session-live', { provider: 'p', model: 'm' }, controller.signal)
  assert.deepEqual(result, { ownership: 'current', outcome: { kind: 'cancelled' } })
})

test('Direct selectSessionPreset reports cancelled for an already-aborted signal', async () => {
  const presets = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: unknown) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
  }), () => liveAgent).presets
  const controller = new AbortController()
  controller.abort()
  const result = await presets.selectSessionPreset('session-live', 'minimal', controller.signal)
  assert.deepEqual(result, { ownership: 'current', outcome: { kind: 'cancelled' } })
})

test('Direct saveDefaultSelection settles committed for the official Promise<void> success', async () => {
  // The pinned official `agentDefaultModel.saveSelection` resolves `void`; a
  // fulfilled write is a commit and must NOT be mis-settled as indeterminate.
  let saved: unknown
  const models = new DirectCatalogPort(host({
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'p', model: 'm0' }),
      saveSelection: async (next: unknown) => { saved = next },
    },
  }), () => undefined).models
  const outcome = await models.saveDefaultSelection({ provider: 'p', model: 'm1' })
  assert.deepEqual(outcome, { kind: 'committed', value: undefined })
  assert.deepEqual(saved, { provider: 'p', model: 'm1' })
})

test('Direct loadDirectory aborts after the Host awaits (never publishes a success DTO)', async () => {
  const started = deferred<void>()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const models = new DirectCatalogPort(host({
    llm: {
      resolveCallConfig: async (next: unknown) => next,
      listProviders: () => [{ id: 'p', name: 'Provider P' }],
      listModels: async () => { started.resolve(); await gate; return [{ id: 'm1' }] },
      resolveModelInfo: async () => ({}),
      discoverModels: async () => [],
      listConfigurableProviders: () => [],
    },
  }), () => undefined).models
  const controller = new AbortController()
  const pending = models.loadDirectory(controller.signal)
  await started.promise
  controller.abort()
  release()
  await assert.rejects(pending, /abort/i)
})

test('Direct roster aborts after the Host await (never opens on a cancelled read)', async () => {
  const started = deferred<void>()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const presets = new DirectCatalogPort(host({
    agentPresets: {
      remoteExportList: async () => { started.resolve(); await gate; return { presets: [], modeSelectionEnabled: true } },
    },
  }), () => undefined).presets
  const controller = new AbortController()
  const pending = presets.roster(controller.signal)
  await started.promise
  controller.abort()
  release()
  await assert.rejects(pending, /abort/i)
})

test('Direct preset resolve surfaces an abort raised during the Host read', async () => {
  const started = deferred<void>()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const calls: (string | undefined)[] = []
  const presets = new DirectCatalogPort(host({
    agentPresets: {
      defaultId: 'code',
      resolve: async (id?: string) => {
        calls.push(id)
        started.resolve()
        await gate
        return { id: 'code' }
      },
    },
  }), () => undefined).presets
  const controller = new AbortController()
  const pending = presets.resolve(undefined, controller.signal)
  await started.promise
  controller.abort()
  release()
  await assert.rejects(pending, /abort/i)
  assert.deepEqual(calls, [undefined], 'exactly one Host read — no fallback read after an abort')
})

test('Direct selectSessionModel reports cancelled (not rejected) when aborted while normalization rejects', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = deferred<void>()
  const appended: unknown[] = []
  const owner = { current: () => undefined, appendSelection: (_a: unknown, next: unknown) => { appended.push(next) }, setCurrent: () => {}, selectForNextRequest: () => {} }
  const models = new DirectCatalogPort(host({
    llm: {
      resolveCallConfig: async () => { started.resolve(); await gate; throw new Error('route gone') },
      listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [],
    },
    agentDefaultModel: { currentSelection: () => undefined, saveSelection: async () => {} },
  }), () => liveAgent, owner).models
  const controller = new AbortController()
  const pending = models.selectSessionModel('session-live', { provider: 'p', model: 'm1' }, controller.signal)
  await started.promise
  controller.abort()
  release()
  const result = await pending
  assert.deepEqual(result, { ownership: 'current', outcome: { kind: 'cancelled' } },
    'an abort during normalization is a proven pre-commit cancellation, not a rejection')
  assert.deepEqual(appended, [])
})

test('Direct selectSessionModel reports committed + superseded when aborted after the durable commit', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const saveStarted = deferred<void>()
  const appended: unknown[] = []
  const owner = { current: () => undefined, appendSelection: (_a: unknown, next: unknown) => { appended.push(next) }, setCurrent: () => {}, selectForNextRequest: () => {} }
  const models = new DirectCatalogPort(host({
    llm: { resolveCallConfig: async (next: unknown) => next, listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: { currentSelection: () => undefined, saveSelection: async () => { saveStarted.resolve(); await gate } },
  }), () => liveAgent, owner).models
  const controller = new AbortController()
  const pending = models.selectSessionModel('session-live', { provider: 'p', model: 'm1' }, controller.signal)
  await saveStarted.promise
  controller.abort()
  release()
  const result = await pending
  assert.deepEqual(appended, [{ provider: 'p', model: 'm1' }], 'the durable append already committed')
  assert.equal(result.outcome.kind, 'committed', 'a post-commit abort keeps the settlement')
  assert.equal(result.ownership, 'superseded', 'but loses local ownership')
})

test('Direct selectSessionPreset reports committed + superseded when aborted after the Host switch', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const started = deferred<void>()
  const presets = new DirectCatalogPort(host({
    agentPresets: {
      select: async () => { started.resolve(); await gate; return 'minimal' },
    },
  }), () => liveAgent).presets
  const controller = new AbortController()
  const pending = presets.selectSessionPreset('session-live', 'minimal', controller.signal)
  await started.promise
  controller.abort()
  release()
  const result = await pending
  assert.equal(result.outcome.kind, 'committed')
  assert.equal(result.ownership, 'superseded')
})
