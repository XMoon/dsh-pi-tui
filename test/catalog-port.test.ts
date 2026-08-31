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
import type { AgentPreset } from '@deepseek-ai/dsh-agent-presets'

function host(services: Record<string, unknown>): HostContextLike {
  return { get: (name) => services[name], on: () => {} }
}

function preset(id: string, extra: Partial<AgentPreset> = {}): AgentPreset {
  return { id, trust: 'system', ...extra } as AgentPreset
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
  assert.deepEqual(await models.resolveModelInfo('p', 'm'), {})
  assert.deepEqual(await models.discoverModels({ baseURL: 'x' }), [])
  assert.equal(models.listConfigurableProviders(), undefined)
  assert.equal(models.currentSelection(), undefined)
})

test('models surface detached provider/model DTOs and forward discovery', async () => {
  const models = port({
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async (providerId: string) => providerId === 'deepseek'
        ? [{ id: 'deepseek-chat', name: 'Chat' }]
        : [],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }),
      discoverModels: async (_ns: string, request: { baseURL?: string }) => [{ id: 'm1' }],
      listConfigurableProviders: () => [{ provider: 'openai', displayName: 'openai', settingsNs: 'llm-pi-ai', settingsPath: [] }],
    },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
      saveSelection: async (next: unknown) => { saved = next },
    },
  }).models
  let saved: unknown
  assert.equal(models.available(), true)
  assert.deepEqual(models.listProviders(), [{ id: 'deepseek', name: 'DeepSeek' }])
  assert.deepEqual(await models.listModels('deepseek'), [{ id: 'deepseek-chat', name: 'Chat' }])
  assert.deepEqual(await models.resolveModelInfo('deepseek', 'deepseek-chat'), { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } })
  assert.deepEqual(await models.discoverModels({ baseURL: 'http://x' }), [{ id: 'm1' }])
  assert.deepEqual(models.listConfigurableProviders(), [{ id: 'openai', displayName: 'openai' }])
  assert.deepEqual(models.currentSelection(), { provider: 'deepseek', model: 'deepseek-chat' })
  await models.saveSelection({ provider: 'deepseek', model: 'deepseek-chat' })
  assert.deepEqual(saved, { provider: 'deepseek', model: 'deepseek-chat' })
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
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'default-provider', model: 'default-model' }),
      saveSelection: async (next: unknown) => { savedDefault = next },
    },
  }), () => liveAgent, owner).models

  assert.deepEqual(models.defaultSelection(), { provider: 'default-provider', model: 'default-model' })
  assert.deepEqual(models.sessionSelection('session-live'), liveSelection)
  await models.selectSessionModel('session-live', { provider: 'new-provider', model: 'new-model', reasoningEffort: 'max' })
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
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
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
  await assert.rejects(stale, /stale write failed/u)
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.at(-1), 'new', 'the stale completion must not leave the global default at old')
})

test('a stale SUCCESSFUL write still reasserts the newest choice', async () => {
  let resolveFirst!: () => void
  const calls: string[] = []
  const first = new Promise<void>((resolve) => { resolveFirst = resolve })
  const models = new DirectCatalogPort(host({
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
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
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
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
  resolveFirst() // the stale write completes; its fence starts the correction
  await stale
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.at(-1), 'new', 'the correction for the newest value must be in flight')
  const newest = models.saveDefaultSelection({ provider: 'p', model: 'newest' })
  await newest
  resolveCorrection() // the held correction completes
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
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
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
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'global', model: 'default' }),
      saveSelection: async () => { throw new Error('quota exceeded') },
    },
  }), () => liveAgent, owner).models

  await assert.rejects(
    models.selectSessionModel('session-live', { provider: 'new-provider', model: 'new-model' }),
    /quota exceeded/u,
  )
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
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'global', model: 'default' }),
      saveSelection: async () => {},
    },
  }), () => liveAgent, owner).models

  await assert.rejects(
    models.selectSessionModel('session-live', { provider: 'new-provider', model: 'new-model' }),
    /append failed/u,
  )
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
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
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
  resolveFirst() // the stale write completes; its fence starts the correction
  await stale
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.at(-1), 'new', 'the correction for the newest committed value must be in flight')
  await assert.rejects(
    models.saveDefaultSelection({ provider: 'p', model: 'newest' }),
    /quota exceeded/u,
  )
  resolveCorrection() // the held correction completes
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
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}), discoverModels: async () => [], listConfigurableProviders: () => [] },
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
  await assert.rejects(failed, /quota exceeded/u) // C fails first
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
    llm: {
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
  const info = await modelsPort.resolveModelInfo('deepseek', 'deepseek-chat')
  ;(info.reasoning!.efforts as Array<{ id: string; name: string }>)[0]!.id = 'MUTATED'
  assert.equal(efforts[0]!.id, 'low', 'the reasoning metadata is never aliased')
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
  assert.deepEqual(await presets.list(), [])
  assert.deepEqual(await presets.resolve('standard'), {}, 'rosterless resolve yields no preset identity')
  await assert.rejects(presets.resolve('code'), /preset "code" is unavailable/)
  assert.equal(presets.defaultId(), undefined)
})

test('presets list/resolve/defaultId return detached roster DTOs', async () => {
  const presets = port({
    agentPresets: {
      list: async () => [preset('standard'), preset('code', { trust: 'user', name: 'PTC', broken: 'x' })],
      resolve: async (id?: string) => preset(id ?? 'standard'),
      get defaultId() { return 'standard' },
    },
  }).presets
  assert.equal(presets.available(), true)
  const roster = await presets.list()
  assert.deepEqual(roster, [
    { id: 'standard', trust: 'system' },
    { id: 'code', trust: 'user', name: 'PTC', broken: 'x' },
  ])
  assert.deepEqual(await presets.resolve(undefined), { id: 'standard' }, 'concrete id only, no setup callback')
  assert.deepEqual(await presets.resolve('code'), { id: 'code' }, 'a legal custom code id resolves as itself')
  assert.equal(presets.defaultId(), 'standard')
})

test('presets resolves an absent legacy code default as ptc but preserves explicit code semantics', async () => {
  const resolved: Array<string | undefined> = []
  const presets = port({
    agentPresets: {
      list: async () => [preset('ptc')],
      resolve: async (id?: string) => {
        resolved.push(id)
        if (id === 'code') throw Object.assign(new Error('unknown preset'), { presetId: 'code' })
        return preset(id ?? 'ptc')
      },
      get defaultId() { return 'code' },
    },
  }).presets
  assert.deepEqual(await presets.resolve(undefined), { id: 'ptc' })
  await assert.rejects(() => presets.resolve('code'), /unknown preset/u)
  assert.deepEqual(resolved, ['code', 'ptc', 'code'], 'only omitted default resolution gets the legacy fallback')
  assert.equal(presets.defaultId(), 'code', 'the synchronous default read preserves roster ambiguity')
})

test('presets.resolve propagates an unknown-preset rejection', async () => {
  const presets = port({
    agentPresets: {
      list: async () => [],
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
      standingKeyFor: async (id?: string) => { standingKey = id; return { scope: 'standing' } },
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
      standingKeyFor: async () => { throw new Error('mount broken') },
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
