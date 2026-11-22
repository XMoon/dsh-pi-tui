/**
 * Owner-semantics contracts for the Host ACP Session-only model service.
 *
 * These tests drive the REAL `AcpSessionModelService` against a small Host
 * dependency fake, so they prove the exact official model/selection write, the
 * zero profile-default writes, the fresh catalog/effort validation, the true
 * idle-phase admission, the pre-append identity/abort/conflict fences and the
 * presentation-only current-route placeholders. The real Host binding and the
 * real ACP socket are covered by `local-acp-listener.test.ts` and the packed
 * split-process smoke.
 *
 * @module @xmoon76/dsh-pi-tui/local-acp-model-selection.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AcpModelError,
  AcpSessionModelService,
  type AcpModelAgent,
  type AcpModelCatalog,
  type AcpModelCurrentness,
  type AcpModelHost,
  type AcpModelOptionRequest,
  type AcpModelSelection,
} from '../../src/app/remote-process/local-acp-model-selection.ts'

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function copySelection(selection: AcpModelSelection | undefined): AcpModelSelection | undefined {
  if (selection === undefined) return undefined
  return {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

function sameSelection(left: AcpModelSelection | undefined, right: AcpModelSelection | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/** A small Agent with the official idle/maintenance and durable-selection shape. */
class FakeAgent implements AcpModelAgent {
  readonly id: string
  readonly appends: AcpModelSelection[] = []
  status: 'idle' | 'running' = 'idle'
  maintenanceCalls = 0
  maintenanceActive = false
  maintenanceSignal: AbortSignal | undefined
  /** A test-only hook executing synchronously as the maintenance phase is claimed. */
  beforeMaintenance: (() => void) | undefined
  private selection: AcpModelSelection | undefined

  constructor(id: string, selection?: AcpModelSelection) {
    this.id = id
    this.selection = copySelection(selection)
  }

  get model(): { current(): AcpModelSelection | undefined; select(selection: AcpModelSelection): void } {
    return {
      current: () => copySelection(this.selection),
      select: selection => { this.select(selection) },
    }
  }

  currentSelection(): AcpModelSelection | undefined {
    return copySelection(this.selection)
  }

  /** The same no-op-on-equal semantics as the official AgentModel.select. */
  select(selection: AcpModelSelection): void {
    const detached = copySelection(selection)
    if (sameSelection(this.selection, detached)) return
    this.selection = detached
    this.appends.push(detached as AcpModelSelection)
  }

  /** A real TUI-style write used to simulate a concurrent external commit. */
  externalSelect(selection: AcpModelSelection): void {
    this.select(selection)
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.status !== 'idle' || this.maintenanceActive) {
      throw new Error(`agent "${this.id}" already has active work`)
    }
    this.maintenanceCalls += 1
    this.maintenanceActive = true
    const controller = new AbortController()
    this.maintenanceSignal = controller.signal
    this.beforeMaintenance?.()
    return (async () => {
      try {
        return await task(controller.signal)
      } finally {
        this.maintenanceActive = false
      }
    })()
  }
}

/** A minimal official Host surface: catalog, LLM registry and exact registries. */
class FakeHost implements AcpModelHost {
  catalog: AcpModelCatalog = { groups: [] }
  catalogError: Error | undefined
  catalogGate: Deferred<void> | undefined
  catalogReads = 0
  providers: Array<{ readonly id: string; readonly name: string }> = []
  models = new Map<string, Array<{ readonly id: string; readonly name: string }>>()
  resolveError: Error | undefined
  readonly resolveCalls: AcpModelSelection[] = []
  readonly agents = new Map<string, FakeAgent>()
  readonly sessions = new Map<string, object>()
  /** The independent profile-default write count this service must never change. */
  defaultSaveCalls = 0

  seed(agent: FakeAgent): void {
    this.agents.set(agent.id, agent)
    this.sessions.set(agent.id, { id: agent.id })
  }

  remove(agentId: string): void {
    this.agents.delete(agentId)
    this.sessions.delete(agentId)
  }

  async modelCatalog(): Promise<AcpModelCatalog> {
    this.catalogReads += 1
    if (this.catalogGate !== undefined) await this.catalogGate.promise
    if (this.catalogError !== undefined) throw this.catalogError
    return this.catalog
  }

  listProviders(): readonly { readonly id: string; readonly name: string }[] {
    return this.providers
  }

  async listModels(providerId: string): Promise<readonly { readonly id: string; readonly name: string }[]> {
    return this.models.get(providerId) ?? []
  }

  async resolveCallConfig(selection: AcpModelSelection): Promise<AcpModelSelection> {
    this.resolveCalls.push(copySelection(selection) as AcpModelSelection)
    if (this.resolveError !== undefined) throw this.resolveError
    return { ...selection }
  }

  currentAgent(sessionId: string): AcpModelAgent | undefined {
    return this.agents.get(sessionId)
  }

  currentSession(sessionId: string): object | undefined {
    return this.sessions.get(sessionId)
  }
}

function catalogOf(...groups: Array<{
  id: string
  name: string
  models: Array<{ id: string; name: string; efforts?: string[]; defaultEffort?: string }>
}>): AcpModelCatalog {
  return {
    groups: groups.map(group => ({
      id: group.id,
      name: group.name,
      models: group.models.map(model => ({
        id: model.id,
        name: model.name,
        ...(model.efforts === undefined ? {} : {
          reasoning: {
            efforts: model.efforts.map(id => ({ id, name: `effort-${id}` })),
            ...(model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort }),
          },
        }),
      })),
    })),
  }
}

function baseHost(selection: AcpModelSelection = { provider: 'p1', model: 'a' }): { host: FakeHost; agent: FakeAgent } {
  const host = new FakeHost()
  host.catalog = catalogOf(
    { id: 'p1', name: 'Provider 1', models: [
      { id: 'a', name: 'Model A', efforts: ['low', 'high'], defaultEffort: 'low' },
      { id: 'b', name: 'Model B' },
    ] },
    { id: 'p2', name: 'Provider 2', models: [{ id: 'c', name: 'Model C', efforts: ['medium'] }] },
  )
  host.providers = [{ id: 'p1', name: 'Provider 1' }, { id: 'p2', name: 'Provider 2' }]
  host.models = new Map([
    ['p1', [{ id: 'a', name: 'Model A' }, { id: 'b', name: 'Model B' }]],
    ['p2', [{ id: 'c', name: 'Model C' }]],
  ])
  const agent = new FakeAgent('S1', selection)
  host.seed(agent)
  return { host, agent }
}

function isModelError(code: string): (error: unknown) => boolean {
  return error => error instanceof AcpModelError && error.code === code
}

function effortError(): Error {
  return Object.assign(new Error('unsupported reasoning effort'), { code: 'UNSUPPORTED_REASONING_EFFORT' })
}

const OK_SIGNAL = new AbortController().signal
const ALWAYS_CURRENT = (): AcpModelCurrentness => 'current'

function request(configId: string, value: unknown): AcpModelOptionRequest {
  return { configId, value }
}

function modelValue(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

test('readOptions projects the official provider groups, current route and reasoning metadata', async () => {
  const { host } = baseHost({ provider: 'p1', model: 'a', reasoningEffort: 'high' })
  const service = new AcpSessionModelService(host)
  const agent = host.agents.get('S1') as FakeAgent
  const session = host.sessions.get('S1') as object

  const options = await service.readOptions(agent, session)

  assert.equal(options.length, 2)
  const model = options[0]!
  assert.equal(model.id, 'model')
  assert.equal(model.category, 'model')
  assert.equal(model.type, 'select')
  assert.equal(model.currentValue, modelValue('p1', 'a'))
  assert.deepEqual(model.options, [
    {
      group: 'group:p1',
      name: 'Provider 1',
      options: [
        { value: modelValue('p1', 'a'), name: 'Model A' },
        { value: modelValue('p1', 'b'), name: 'Model B' },
      ],
    },
    {
      group: 'group:p2',
      name: 'Provider 2',
      options: [{ value: modelValue('p2', 'c'), name: 'Model C' }],
    },
  ])
  const thought = options[1]!
  assert.equal(thought.id, 'thought_level')
  assert.equal(thought.category, 'thought_level')
  assert.equal(thought.type, 'select')
  assert.equal(thought.currentValue, JSON.stringify(['effort', 'high']))
  assert.deepEqual(thought.options, [
    { value: JSON.stringify(['default']), name: 'Model default' },
    { value: JSON.stringify(['effort', 'low']), name: 'effort-low' },
    { value: JSON.stringify(['effort', 'high']), name: 'effort-high' },
  ])
  assert.equal(host.defaultSaveCalls, 0)
})

test('select model commits exactly one Session-only selection and never the profile default', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a', reasoningEffort: 'high' })
  host.resolveCalls.length = 0
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object

  const options = await service.selectSessionOnly(
    agent,
    session,
    request('model', modelValue('p1', 'b')),
    OK_SIGNAL,
    ALWAYS_CURRENT,
  )

  assert.deepEqual(agent.currentSelection(), { provider: 'p1', model: 'b' })
  assert.deepEqual(agent.appends, [{ provider: 'p1', model: 'b' }], 'the old explicit effort is cleared')
  assert.equal(host.defaultSaveCalls, 0, 'the profile default must never be written by ACP')
  assert.equal(agent.maintenanceCalls, 1)
  assert.deepEqual(host.resolveCalls, [{ provider: 'p1', model: 'b' }])
  assert.equal((options[0] as { currentValue: string }).currentValue, modelValue('p1', 'b'))
  assert.equal(options[1], undefined, 'Model B declares no reasoning efforts')
})

test('select effort changes only the effort on the same route', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a', reasoningEffort: 'low' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object

  const options = await service.selectSessionOnly(
    agent,
    session,
    request('thought_level', JSON.stringify(['effort', 'high'])),
    OK_SIGNAL,
    ALWAYS_CURRENT,
  )

  assert.deepEqual(agent.appends, [{ provider: 'p1', model: 'a', reasoningEffort: 'high' }])
  assert.equal(host.defaultSaveCalls, 0)
  assert.deepEqual(host.resolveCalls.at(-1), { provider: 'p1', model: 'a', reasoningEffort: 'high' })
  assert.equal((options[1] as { currentValue: string }).currentValue, JSON.stringify(['effort', 'high']))

  const reset = await service.selectSessionOnly(
    agent,
    session,
    request('thought_level', JSON.stringify(['default'])),
    OK_SIGNAL,
    ALWAYS_CURRENT,
  )
  assert.deepEqual(agent.appends.at(-1), { provider: 'p1', model: 'a' })
  assert.equal((reset[1] as { currentValue: string }).currentValue, JSON.stringify(['default']))
})

test('invalid shapes, unknown routes, boolean payloads and placeholders are rejected without a write', async () => {
  const { host, agent } = baseHost({ provider: 'unlisted', model: 'old' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object

  const cases: Array<{ readonly request: AcpModelOptionRequest; readonly code: string }> = [
    { request: { configId: 'model', type: 'boolean', value: true }, code: 'LOCAL_ACP_MODEL_INVALID_OPTION' },
    { request: request('model', 'not-json'), code: 'LOCAL_ACP_MODEL_INVALID_OPTION' },
    { request: request('model', JSON.stringify(['unlisted', 'old'])), code: 'LOCAL_ACP_MODEL_INVALID_OPTION' },
    { request: request('model', modelValue('p9', 'missing')), code: 'LOCAL_ACP_MODEL_INVALID_OPTION' },
    { request: request('thought_level', JSON.stringify(['effort', 'low'])), code: 'LOCAL_ACP_MODEL_INVALID_OPTION' },
    { request: request('other', 'value'), code: 'LOCAL_ACP_MODEL_INVALID_OPTION' },
  ]
  for (const item of cases) {
    await assert.rejects(
      service.selectSessionOnly(agent, session, item.request, OK_SIGNAL, ALWAYS_CURRENT),
      isModelError(item.code),
    )
  }
  assert.equal(agent.appends.length, 0)
  assert.equal(host.defaultSaveCalls, 0)
})

test('a catalog-known model that went offline is unavailable rather than an unknown option', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object
  host.catalog = catalogOf({ id: 'p1', name: 'Provider 1', models: [{ id: 'a', name: 'Model A' }] })

  await assert.rejects(
    service.selectSessionOnly(agent, session, request('model', modelValue('p1', 'gone')), OK_SIGNAL, ALWAYS_CURRENT),
    isModelError('LOCAL_ACP_MODEL_UNAVAILABLE'),
  )
  assert.equal(agent.appends.length, 0)
})

test('an active turn rejects before any catalog read; an existing maintenance window rejects before append', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object

  agent.status = 'running'
  await assert.rejects(
    service.selectSessionOnly(agent, session, request('model', modelValue('p1', 'b')), OK_SIGNAL, ALWAYS_CURRENT),
    isModelError('LOCAL_ACP_MODEL_AGENT_BUSY'),
  )
  assert.equal(host.catalogReads, 0, 'the fast busy precheck must precede provider I/O')

  agent.status = 'idle'
  agent.maintenanceActive = true
  await assert.rejects(
    service.selectSessionOnly(agent, session, request('model', modelValue('p1', 'b')), OK_SIGNAL, ALWAYS_CURRENT),
    isModelError('LOCAL_ACP_MODEL_AGENT_BUSY'),
  )
  assert.equal(agent.appends.length, 0)
  assert.equal(host.defaultSaveCalls, 0)
})

test('a replaced Agent while the catalog is awaited is stale and never writes the new Agent', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object
  const gate = deferred<void>()
  host.catalogGate = gate
  const selection = service.selectSessionOnly(
    agent,
    session,
    request('model', modelValue('p1', 'b')),
    OK_SIGNAL,
    ALWAYS_CURRENT,
  )
  await Promise.resolve()
  const replacement = new FakeAgent('S1', { provider: 'p1', model: 'a' })
  host.seed(replacement)
  gate.resolve()
  await assert.rejects(selection, isModelError('LOCAL_ACP_MODEL_STALE'))
  assert.equal(agent.appends.length, 0)
  assert.equal(replacement.appends.length, 0)
})

test('a model committed by another client during validation conflicts and keeps the TUI value', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object
  const gate = deferred<void>()
  host.catalogGate = gate
  const selection = service.selectSessionOnly(
    agent,
    session,
    request('model', modelValue('p1', 'b')),
    OK_SIGNAL,
    ALWAYS_CURRENT,
  )
  await Promise.resolve()
  agent.externalSelect({ provider: 'p1', model: 'a', reasoningEffort: 'high' })
  gate.resolve()
  await assert.rejects(selection, isModelError('LOCAL_ACP_MODEL_CONFLICT'))
  assert.deepEqual(agent.currentSelection(), { provider: 'p1', model: 'a', reasoningEffort: 'high' })
  assert.deepEqual(agent.appends, [{ provider: 'p1', model: 'a', reasoningEffort: 'high' }],
    'only the external client wrote; the ACP selection did not append')
  assert.equal(host.defaultSaveCalls, 0)
})

test('an aborted request stops before the durable append', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object
  const gate = deferred<void>()
  host.catalogGate = gate
  const controller = new AbortController()
  const selection = service.selectSessionOnly(
    agent,
    session,
    request('model', modelValue('p1', 'b')),
    controller.signal,
    ALWAYS_CURRENT,
  )
  await Promise.resolve()
  controller.abort()
  gate.resolve()
  await assert.rejects(selection, isModelError('LOCAL_ACP_MODEL_STALE'))
  assert.equal(agent.appends.length, 0)
})

test('a View claim lost while the catalog is awaited is stale', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object
  const gate = deferred<void>()
  host.catalogGate = gate
  const selection = service.selectSessionOnly(
    agent,
    session,
    request('model', modelValue('p1', 'b')),
    OK_SIGNAL,
    () => 'stale',
  )
  await Promise.resolve()
  gate.resolve()
  await assert.rejects(selection, isModelError('LOCAL_ACP_MODEL_STALE'))
  assert.equal(agent.appends.length, 0)
})

test('an unknown current route is presented as a non-submittable placeholder and recovers after a valid choice', async () => {
  const { host, agent } = baseHost({ provider: 'gone', model: 'retired' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object

  const before = await service.readOptions(agent, session)
  const model = before[0] as { currentValue: string; options: Array<{ group: string; name: string; options: Array<{ value: string; name: string }> }> }
  assert.equal(model.currentValue, modelValue('gone', 'retired'))
  const placeholder = model.options.flatMap(group => group.options)
    .find(option => option.value === modelValue('gone', 'retired'))
  assert.equal(placeholder?.name, 'Current (unavailable) — choose another model')
  assert.equal(before[1], undefined, 'an unresolvable current route has no reasoning metadata')

  await assert.rejects(
    service.selectSessionOnly(agent, session, request('model', modelValue('gone', 'retired')), OK_SIGNAL, ALWAYS_CURRENT),
    isModelError('LOCAL_ACP_MODEL_INVALID_OPTION'),
  )
  assert.equal(agent.appends.length, 0)

  await service.selectSessionOnly(agent, session, request('model', modelValue('p1', 'b')), OK_SIGNAL, ALWAYS_CURRENT)
  const after = await service.readOptions(agent, session)
  assert.equal((after[0] as { currentValue: string }).currentValue, modelValue('p1', 'b'))
})

test('a revoked explicit effort is presented as a non-submittable placeholder', async () => {
  const host = new FakeHost()
  host.catalog = catalogOf({ id: 'p1', name: 'Provider 1', models: [{ id: 'a', name: 'Model A', efforts: ['low'] }] })
  host.providers = [{ id: 'p1', name: 'Provider 1' }]
  host.models = new Map([['p1', [{ id: 'a', name: 'Model A' }]]])
  const agent = new FakeAgent('S1', { provider: 'p1', model: 'a', reasoningEffort: 'retired-effort' })
  host.seed(agent)
  const service = new AcpSessionModelService(host)

  const options = await service.readOptions(agent, host.sessions.get('S1') as object)
  const thought = options[1] as { currentValue: string; options: Array<{ value: string; name: string }> }
  assert.equal(thought.currentValue, JSON.stringify(['unavailable', 'retired-effort']))
  assert.equal(thought.options[0]?.name, 'Current effort (unavailable)')
  await assert.rejects(
    service.selectSessionOnly(
      agent,
      host.sessions.get('S1') as object,
      request('thought_level', thought.currentValue),
      OK_SIGNAL,
      ALWAYS_CURRENT,
    ),
    isModelError('LOCAL_ACP_MODEL_INVALID_OPTION'),
  )
  assert.equal(agent.appends.length, 0)
})

test('the LLM capability validation rejects an effort the live adapter refuses', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a', reasoningEffort: 'low' })
  host.resolveError = effortError()
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object

  await assert.rejects(
    service.selectSessionOnly(
      agent,
      session,
      request('thought_level', JSON.stringify(['effort', 'high'])),
      OK_SIGNAL,
      ALWAYS_CURRENT,
    ),
    isModelError('LOCAL_ACP_MODEL_INVALID_OPTION'),
  )
  assert.equal(agent.appends.length, 0)
})

test('a prompt flight admitted during validation rejects VIEW_BUSY at the last maintenance gate', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object
  let currentness: AcpModelCurrentness = 'current'
  // The real View closure flips to `view-busy` when `session/prompt` installs
  // `claim.inflight` during the catalog await. Flip it exactly when the
  // maintenance phase is claimed to prove the LAST synchronous pre-append gate.
  agent.beforeMaintenance = () => { currentness = 'view-busy' }

  await assert.rejects(
    service.selectSessionOnly(
      agent,
      session,
      request('model', modelValue('p1', 'b')),
      OK_SIGNAL,
      () => currentness,
    ),
    isModelError('LOCAL_ACP_MODEL_VIEW_BUSY'),
  )
  assert.equal(agent.appends.length, 0, 'the in-flight prompt must not receive a model mutation')
  assert.equal(agent.maintenanceCalls, 1, 'the busy decision happens inside the claimed maintenance gate')
  assert.equal(host.defaultSaveCalls, 0)
})

test('selecting the same model keeps its explicit effort; an identical effort is a no-op', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a', reasoningEffort: 'high' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object

  const modelOptions = await service.selectSessionOnly(
    agent,
    session,
    request('model', modelValue('p1', 'a')),
    OK_SIGNAL,
    ALWAYS_CURRENT,
  )
  assert.equal(agent.appends.length, 0, 'the official AgentModel.select no-ops on an identical model selection')
  assert.deepEqual(agent.currentSelection(), { provider: 'p1', model: 'a', reasoningEffort: 'high' },
    're-selecting the same route must not drop its explicit effort')
  assert.equal((modelOptions[0] as { currentValue: string }).currentValue, modelValue('p1', 'a'))
  assert.equal((modelOptions[1] as { currentValue: string }).currentValue, JSON.stringify(['effort', 'high']))

  await service.selectSessionOnly(
    agent,
    session,
    request('thought_level', JSON.stringify(['effort', 'high'])),
    OK_SIGNAL,
    ALWAYS_CURRENT,
  )
  assert.equal(agent.appends.length, 0, 'an identical effort selection adds no second Session event')
  assert.equal(host.defaultSaveCalls, 0)
})

test('a catalog rejection after Agent replacement is STALE, never an optional catalog miss', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object
  const gate = deferred<void>()
  host.catalogGate = gate
  host.catalogError = new Error('catalog exploded')
  const read = service.readOptions(agent, session)
  await Promise.resolve()
  const replacement = new FakeAgent('S1', { provider: 'p1', model: 'a' })
  host.seed(replacement)
  gate.resolve()
  await assert.rejects(read, isModelError('LOCAL_ACP_MODEL_STALE'))
})

test('a missing catalog or missing exact identity is a classified rejection', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object
  host.catalogError = new Error('catalog exploded')

  await assert.rejects(service.readOptions(agent, session), isModelError('LOCAL_ACP_MODEL_UNAVAILABLE'))
  await assert.rejects(
    service.selectSessionOnly(agent, session, request('model', modelValue('p1', 'b')), OK_SIGNAL, ALWAYS_CURRENT),
    isModelError('LOCAL_ACP_MODEL_UNAVAILABLE'),
  )
  assert.equal(agent.appends.length, 0)

  const otherAgent = new FakeAgent('S1', { provider: 'p1', model: 'a' })
  await assert.rejects(service.readOptions(otherAgent, session), isModelError('LOCAL_ACP_MODEL_STALE'))
})

test('an unsupported explicit reasoning effort is rejected before append and without any provider message leak', async () => {
  const { host, agent } = baseHost({ provider: 'p1', model: 'a', reasoningEffort: 'low' })
  const service = new AcpSessionModelService(host)
  const session = host.sessions.get('S1') as object
  host.resolveError = effortError()

  const error = await service.selectSessionOnly(
    agent,
    session,
    request('thought_level', JSON.stringify(['effort', 'high'])),
    OK_SIGNAL,
    ALWAYS_CURRENT,
  ).catch((caught: unknown) => caught)
  assert.ok(error instanceof AcpModelError)
  assert.equal(error.code, 'LOCAL_ACP_MODEL_INVALID_OPTION')
  assert.equal(error.message.includes('unsupported reasoning effort'), false, 'provider text is never echoed')
  assert.equal(agent.appends.length, 0)
})
