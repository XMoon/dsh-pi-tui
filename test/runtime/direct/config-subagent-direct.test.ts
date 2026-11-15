/** Adapter contract evidence with controlled Settings projections and a real Cordis identity probe. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service, symbols } from '@deepseek-ai/cordis'
import {
  DirectConfigPort,
  DirectSubagentLimitsConfig,
  DirectSubagentModelSelectionConfig,
  type HostContextLike,
  type SettingsMutationOp,
  type SettingsServiceLike,
} from '../../../src/runtime/direct/config-direct.ts'

const LIMITS_NS = 'subagent'
const SELECTION_NS = 'subagent-model-selection-settings'
const route = (provider: string, model: string) => ({ provider, model })

type Descriptor = { ns: string; value: unknown; base?: unknown; user?: unknown; revision?: number }

class SettingsFixture implements SettingsServiceLike {
  descriptors: Descriptor[]
  describeCalls = 0
  readonly mutations: Array<{ ns: string; ops: readonly SettingsMutationOp[]; revision: number | undefined }> = []
  describeFailure: Error | undefined
  mutateFailureAfterApply: Error | undefined

  constructor(descriptors: Descriptor[]) {
    this.descriptors = structuredClone(descriptors)
  }

  describe(): readonly Descriptor[] {
    this.describeCalls += 1
    if (this.describeFailure !== undefined) throw this.describeFailure
    return structuredClone(this.descriptors)
  }

  async mutate(ns: string, ops: readonly SettingsMutationOp[], revision?: number): Promise<void> {
    this.mutations.push({ ns, ops: structuredClone(ops), revision })
    const descriptor = this.descriptors.find(item => item.ns === ns)
    if (descriptor === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    if (revision !== descriptor.revision) {
      throw Object.assign(new Error('settings namespace changed since it was read'), { code: 'SETTINGS_CONFLICT' })
    }
    const user = { ...(descriptor.user as Record<string, unknown> | undefined) }
    const base = descriptor.base as Record<string, unknown>
    for (const op of ops) {
      assert.equal(op.path.length, 1, 'the typed adapter only writes whole fields')
      const field = op.path[0]!
      if (op.op === 'set') user[field] = structuredClone(op.value)
      else if (Object.hasOwn(base, field)) user[field] = structuredClone(base[field])
      else Reflect.deleteProperty(user, field)
    }
    descriptor.user = user
    descriptor.value = { ...base, ...user }
    descriptor.revision = (descriptor.revision ?? 0) + 1
    if (this.mutateFailureAfterApply !== undefined) throw this.mutateFailureAfterApply
  }
}

class CordisSettingsFixture extends Service {
  private readonly backing: SettingsFixture

  constructor(ctx: Context, backing: SettingsFixture) {
    super(ctx, 'settings')
    this.backing = backing
  }

  describe(): readonly Descriptor[] {
    return this.backing.describe()
  }

  mutate(ns: string, ops: readonly SettingsMutationOp[], revision?: number): Promise<void> {
    return this.backing.mutate(ns, ops, revision)
  }
}

function makeSettings(): SettingsFixture {
  return new SettingsFixture([
    {
      ns: LIMITS_NS,
      base: { maxDepth: 1, maxActiveSubagents: 8 },
      user: { maxDepth: 0 },
      value: { maxDepth: 0, maxActiveSubagents: 8 },
      revision: 4,
    },
    {
      ns: SELECTION_NS,
      base: { enabled: false, allowedModels: [route('base', 'model')] },
      user: { enabled: true, allowedModels: [route('user', 'model')] },
      value: { enabled: true, allowedModels: [route('user', 'model')] },
      revision: 9,
    },
  ])
}

function contextWith(settings: unknown): HostContextLike {
  return { get: name => name === 'settings' ? settings : undefined }
}

test('one official descriptor projects limits and model selection without losing zero or false overrides', () => {
  const settings = makeSettings()
  const port = new DirectConfigPort(contextWith(settings), undefined, () => undefined)
  const limits = port.subagentLimits.read()
  assert.equal(settings.describeCalls, 1)
  assert.equal(limits.kind, 'ready')
  if (limits.kind !== 'ready') return
  assert.equal(limits.revision, 4)
  assert.deepEqual(limits.effective, { maxDepth: 0, maxActiveSubagents: 8 })
  assert.deepEqual(limits.inherited, { maxDepth: 1, maxActiveSubagents: 8 })
  assert.deepEqual(limits.overridden, { maxDepth: true, maxActiveSubagents: false })

  settings.descriptors[1] = {
    ns: SELECTION_NS,
    base: { enabled: true, allowedModels: [route('p', 'm')] },
    user: { enabled: false, allowedModels: [route('p', 'm')] },
    value: { enabled: false, allowedModels: [route('p', 'm')] },
    revision: 10,
  }
  const selection = port.subagentModelSelection.read()
  assert.equal(settings.describeCalls, 2)
  assert.equal(selection.kind, 'ready')
  if (selection.kind !== 'ready') return
  assert.deepEqual(selection.overridden, { enabled: true, allowedModels: false })
  assert.equal(selection.effective.enabled, false)
})

test('a missing section is unavailable while an unreadable descriptor never becomes a default', () => {
  const noService = new DirectSubagentLimitsConfig(contextWith(undefined))
  assert.equal(noService.read().kind, 'unavailable')

  const noNamespace = new DirectSubagentLimitsConfig(contextWith(new SettingsFixture([])))
  assert.equal(noNamespace.read().kind, 'unavailable')

  const malformed = new SettingsFixture([{ ns: LIMITS_NS, value: { maxDepth: 1, maxActiveSubagents: 8 }, revision: 1 }])
  assert.equal(new DirectSubagentLimitsConfig(contextWith(malformed)).read().kind, 'unreadable')
  malformed.describeFailure = new Error('descriptor failure')
  assert.equal(new DirectSubagentLimitsConfig(contextWith(malformed)).read().kind, 'unreadable')
})

test('real Cordis lookups create new proxies while the section generation stays the raw service', async () => {
  const ctx = new Context()
  const backing = makeSettings()
  const raw = new CordisSettingsFixture(ctx, backing)
  const firstProxy = ctx.get('settings') as unknown as { readonly [symbols.original]?: object }
  const nextProxy = ctx.get('settings') as unknown as { readonly [symbols.original]?: object }
  assert.notEqual(firstProxy, nextProxy)
  assert.equal(firstProxy[symbols.original], raw)

  const config = new DirectSubagentLimitsConfig(ctx)
  const read = config.read()
  const secondRead = config.read()
  assert.equal(read.kind, 'ready')
  assert.equal(secondRead.kind, 'ready')
  if (read.kind !== 'ready' || secondRead.kind !== 'ready') return
  assert.equal(read.generation, raw)
  assert.equal(secondRead.generation, raw)
  assert.deepEqual(await config.mutate({ maxDepth: { kind: 'set', value: 0 } }, read.revision, read.generation), { kind: 'accepted' })

  const replacement = makeSettings()
  ctx.set('settings', replacement)
  assert.equal((await config.mutate({ maxDepth: { kind: 'set', value: 2 } }, read.revision, read.generation)).kind, 'rejected')
  assert.equal(backing.mutations.length, 1)
  assert.equal(replacement.mutations.length, 0)
})

test('typed field edits use exact CAS and official unset without rewriting a sibling override', async () => {
  const settings = makeSettings()
  const config = new DirectSubagentModelSelectionConfig(contextWith(settings))
  const opened = config.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  const callsBefore = settings.describeCalls
  const result = await config.mutate({ allowedModels: { kind: 'reset' } }, opened.revision, opened.generation)
  assert.deepEqual(result, { kind: 'accepted' })
  assert.equal(settings.describeCalls, callsBefore)
  assert.deepEqual(settings.mutations[0], {
    ns: SELECTION_NS,
    ops: [{ op: 'unset', path: ['allowedModels'] }],
    revision: 9,
  })
  const descriptor = settings.descriptors.find(item => item.ns === SELECTION_NS)
  assert.deepEqual(descriptor?.value, { enabled: true, allowedModels: [route('base', 'model')] })
  assert.deepEqual((descriptor?.user as Record<string, unknown>).allowedModels, [route('base', 'model')])
  assert.equal((descriptor?.user as Record<string, unknown>).enabled, true)
  const readback = config.read()
  assert.equal(readback.kind, 'ready')
  if (readback.kind !== 'ready') return
  assert.deepEqual(readback.effective, { enabled: true, allowedModels: [route('base', 'model')] })
  assert.deepEqual(readback.overridden, { enabled: true, allowedModels: false })
  assert.deepEqual(await config.mutate({ allowedModels: { kind: 'reset' } }, readback.revision, readback.generation), { kind: 'accepted' })
  assert.equal(settings.mutations.length, 2)
  assert.equal(settings.mutations[1]?.revision, 10)
})

test('limit set and reset operations preserve their typed fields and stale CAS conflicts explicitly', async () => {
  const settings = makeSettings()
  const config = new DirectSubagentLimitsConfig(contextWith(settings))
  const opened = config.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  assert.deepEqual(await config.mutate({
    maxDepth: { kind: 'set', value: 0 },
    maxActiveSubagents: { kind: 'reset' },
  }, opened.revision, opened.generation), { kind: 'accepted' })
  assert.deepEqual(settings.mutations[0], {
    ns: LIMITS_NS,
    ops: [
      { op: 'set', path: ['maxDepth'], value: 0 },
      { op: 'unset', path: ['maxActiveSubagents'] },
    ],
    revision: 4,
  })

  const stale = await config.mutate({ maxDepth: { kind: 'set', value: 2 } }, opened.revision, opened.generation)
  assert.equal(stale.kind, 'conflict')
  assert.equal(settings.mutations.length, 2)
})

test('an unknown failure after the official edit remains outcome-unconfirmed', async () => {
  const settings = makeSettings()
  settings.mutateFailureAfterApply = new Error('Loader reconciliation failed after persistence')
  const config = new DirectSubagentLimitsConfig(contextWith(settings))
  const opened = config.read()
  assert.equal(opened.kind, 'ready')
  if (opened.kind !== 'ready') return
  const result = await config.mutate({ maxDepth: { kind: 'set', value: 3 } }, opened.revision, opened.generation)
  assert.equal(result.kind, 'outcome-unconfirmed')
  assert.equal(settings.mutations.length, 1)
  assert.equal((settings.descriptors[0]?.value as Record<string, unknown>).maxDepth, 3)
})
