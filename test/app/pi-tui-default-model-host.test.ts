/**
 * Contract tests for the private `piTuiDefaultModel` Host service
 * (app/host/features/default-model.ts): the Owner-only gate (refused before any
 * Host read), the profile-backing preflight that makes `saved` truthful, the
 * single official `agentDefaultModel.saveSelection` call, the DTO detachment,
 * and the service/fiber lifetime. The real Cordis Context and Typert registry
 * are used; the official service faces are structural stand-ins that RECORD how
 * they were read, because this row's contract is the write bridge, not the
 * agent-default-model behavior (the packed Split smoke keeps the real business
 * semantics).
 * @module @xmoon76/dsh-pi-tui/pi-tui-default-model-host.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { PiTuiDefaultModelHostService } from '../../src/app/host/features/default-model.ts'
import { PI_TUI_DEFAULT_MODEL_NAMESPACE } from '../../src/runtime/remote/pi-tui-default-model-contract.ts'

/** Cordis `FiberState.ACTIVE` (const enum: no runtime value). */
const FIBER_ACTIVE = 2
const abort = new AbortController().signal

/** A structural `agentDefaultModel` stand-in that records its reads/writes. */
function defaultModelSpy(options: { throw?: unknown } = {}) {
  const calls: Array<{ provider: string; model: string; reasoningEffort?: string }> = []
  let currentSelectionReads = 0
  return {
    calls,
    get currentSelectionReads(): number { return currentSelectionReads },
    service: {
      currentSelection(): { provider: string; model: string } {
        currentSelectionReads += 1
        return { provider: 'p', model: 'm' }
      },
      async saveSelection(next: { provider: string; model: string; reasoningEffort?: string }): Promise<void> {
        calls.push(next)
        if (options.throw !== undefined) throw options.throw
      },
    },
  }
}

/** A structural Loader stand-in: `entries()` records each read. */
function loaderSpy(rows: Array<{ readonly name: string; readonly active?: boolean }>) {
  let entriesCalls = 0
  return {
    get entriesCalls(): number { return entriesCalls },
    service: {
      entries() {
        entriesCalls += 1
        return rows.map(row => ({
          options: { id: row.name, name: row.name },
          fiber: { state: row.active === false ? 0 : FIBER_ACTIVE },
        }))
      },
    },
  }
}

/** The default-model row package the preflight requires. */
const ROW = '@deepseek-ai/dsh-agent-default-model'

function ownerInvocation(signal = abort): unknown {
  return { peer: { id: 'peer-owner', principal: { kind: 'owner' }, signal }, signal }
}

async function mount(options: {
  readonly invocation?: unknown
  readonly agentDefaultModel?: unknown
  readonly configEditor?: unknown
  readonly loader?: unknown
}): Promise<{ readonly service: PiTuiDefaultModelHostService; readonly ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  if (options.agentDefaultModel !== undefined) ctx.provide('agentDefaultModel', options.agentDefaultModel)
  if (options.configEditor !== undefined) ctx.provide('configEditor', options.configEditor)
  if (options.loader !== undefined) ctx.provide('loader', options.loader)
  Object.defineProperty(ctx, 'invocation', { configurable: true, value: options.invocation })
  const service = new PiTuiDefaultModelHostService(ctx)
  return { service, ctx }
}

test('a non-Owner is refused BEFORE any Host service is read', async () => {
  for (const invocation of [undefined, { peer: { id: 'viewer', principal: { kind: 'viewer' }, signal: abort }, signal: abort }]) {
    const dm = defaultModelSpy()
    const loader = loaderSpy([{ name: ROW }])
    const { service, ctx } = await mount({
      invocation,
      agentDefaultModel: dm.service,
      configEditor: {},
      loader: loader.service,
    })
    try {
      const result = await service.saveSelection({ provider: 'p', model: 'm' }, abort)
      assert.deepEqual(result, { kind: 'refused', reason: 'owner-required' })
      assert.equal(dm.calls.length, 0, 'a non-Owner never reaches the official save')
      assert.equal(dm.currentSelectionReads, 0, 'a non-Owner never reads the official service')
      assert.equal(loader.entriesCalls, 0, 'a non-Owner never reads the Host Loader')
    } finally {
      await ctx.fiber.dispose()
    }
  }
})

test('a missing default-model service is refused without an official save', async () => {
  const loader = loaderSpy([{ name: ROW }])
  const { service, ctx } = await mount({ invocation: ownerInvocation(), configEditor: {}, loader: loader.service })
  try {
    assert.deepEqual(await service.saveSelection({ provider: 'p', model: 'm' }, abort),
      { kind: 'refused', reason: 'default-model-service-unavailable' })
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a Host without a configEditor is refused profile-persistence-unavailable', async () => {
  const dm = defaultModelSpy()
  const loader = loaderSpy([{ name: ROW }])
  const { service, ctx } = await mount({ invocation: ownerInvocation(), agentDefaultModel: dm.service, loader: loader.service })
  try {
    assert.deepEqual(await service.saveSelection({ provider: 'p', model: 'm' }, abort),
      { kind: 'refused', reason: 'profile-persistence-unavailable' })
    assert.equal(dm.calls.length, 0, 'a Host that cannot persist never calls the official save')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a Host without exactly one ACTIVE profile entry is refused profile-entry-unavailable', async () => {
  for (const rows of [[], [{ name: ROW, active: false }], [{ name: ROW }, { name: ROW }]]) {
    const dm = defaultModelSpy()
    const loader = loaderSpy(rows)
    const { service, ctx } = await mount({
      invocation: ownerInvocation(),
      agentDefaultModel: dm.service,
      configEditor: {},
      loader: loader.service,
    })
    try {
      assert.deepEqual(await service.saveSelection({ provider: 'p', model: 'm' }, abort),
        { kind: 'refused', reason: 'profile-entry-unavailable' },
        `rows=${JSON.stringify(rows)}`)
      assert.equal(dm.calls.length, 0, 'a Host with no persistent profile entry never calls the official save')
    } finally {
      await ctx.fiber.dispose()
    }
  }
})

test('a supported Host saves EXACTLY once, through the official service, with a detached copy', async () => {
  const dm = defaultModelSpy()
  const loader = loaderSpy([{ name: ROW }])
  const { service, ctx } = await mount({
    invocation: ownerInvocation(),
    agentDefaultModel: dm.service,
    configEditor: {},
    loader: loader.service,
  })
  try {
    const selection = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' }
    assert.deepEqual(await service.saveSelection(selection, abort), { kind: 'saved' })
    assert.equal(dm.calls.length, 1, 'the official save runs exactly once — never a second confirmation call')
    assert.deepEqual(dm.calls[0], { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'high' })
    assert.notEqual(dm.calls[0], selection, 'the wire DTO is never passed to the official service by reference')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('a Host save that throws rejects the RPC — never a fabricated refusal', async () => {
  const dm = defaultModelSpy({ throw: new Error('profile write exploded') })
  const loader = loaderSpy([{ name: ROW }])
  const { service, ctx } = await mount({
    invocation: ownerInvocation(),
    agentDefaultModel: dm.service,
    configEditor: {},
    loader: loader.service,
  })
  try {
    await assert.rejects(service.saveSelection({ provider: 'p', model: 'm' }, abort), /profile write exploded/u)
    assert.equal(dm.calls.length, 1, 'the failed official write is not retried on the Host')
  } finally {
    await ctx.fiber.dispose()
  }
})

test('the service registers in its OWN fiber; the package contribution owns the descriptor', async () => {
  const { PI_TUI_HOST_CONTRIBUTION } = await import('../../src/runtime/remote/pi-tui-remote-contribution.ts')
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  // The built-in Host Runtime's two independent fibers: contribution + service row.
  const contribution = ctx.inject(['typert'], contributionCtx => {
    contributionCtx.effect(
      () => contributionCtx.typert.register(PI_TUI_HOST_CONTRIBUTION),
      'pi-tui-private-remote-host-test',
    )
  })
  await contribution
  const fiber = ctx.inject(PiTuiDefaultModelHostService.inject, pluginCtx => {
    new PiTuiDefaultModelHostService(pluginCtx)
  })
  await fiber
  const service = ctx.reflect.get(PI_TUI_DEFAULT_MODEL_NAMESPACE) as
    { readonly typertRemote?: { readonly serviceKey?: unknown; readonly namespace?: unknown } } | undefined
  assert.ok(service?.typertRemote !== undefined, 'the private service must expose its Typert binding')
  assert.equal(service.typertRemote.serviceKey, PI_TUI_DEFAULT_MODEL_NAMESPACE)
  assert.equal(service.typertRemote.namespace, PI_TUI_DEFAULT_MODEL_NAMESPACE)
  assert.equal(ctx.typert.local.get('piTuiDefaultModel/saveSelection')?.id,
    '@xmoon76/dsh-pi-tui#piTuiDefaultModel/saveSelection',
    'the descriptor is registered by the package contribution')
  await fiber.dispose()
  assert.equal(ctx.reflect.get(PI_TUI_DEFAULT_MODEL_NAMESPACE), undefined, 'disposing the service row withdraws the service')
  await contribution.dispose()
  assert.equal(ctx.typert.local.get('piTuiDefaultModel/saveSelection'), undefined,
    'unloading the composition withdraws the descriptor with its fiber')
  await ctx.fiber.dispose()
})
