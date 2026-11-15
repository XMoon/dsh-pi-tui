/**
 * Pure allowlist projection tests: official provider-grouped directory rows,
 * exact `(provider, model)` identity, per-provider failure isolation, and the
 * saved-route absence claim. The retired instant-write picker class is no
 * longer exercised here; the single staged Subagent settings page owns the
 * current interaction coverage.
 * @module @xmoon76/dsh-pi-tui/subagent-model-menu.test
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allowlistRouteKey,
  allowlistSummary,
  lastRouteWhileEnabled,
  projectSubagentAllowlist,
  type AllowlistCatalogState,
} from '../../src/tui/pickers/subagent-model-menu.ts'
import type { ModelDirectoryDto } from '../../src/runtime/catalog-port.ts'
import type { SubagentAllowedModelRoute } from '../../src/runtime/config-port.ts'

/** One provider group spec for the fixture directory. */
interface GroupSpec {
  readonly id: string
  readonly name?: string
  readonly models: readonly { readonly id: string; readonly name?: string }[]
}

/** Build the official directory DTO shape the projection consumes. */
function directoryOf(options: {
  groups?: readonly GroupSpec[]
  failures?: readonly { id: string; name: string; message: string }[]
}): ModelDirectoryDto {
  return {
    default: { provider: 'dflt', model: 'dflt' },
    routableProviders: (options.groups ?? []).map(group => group.id),
    groups: (options.groups ?? []).map(group => ({
      id: group.id,
      name: group.name ?? group.id,
      models: group.models.map(model => ({
        id: model.id,
        name: model.name ?? model.id,
        ...model.name === undefined ? {} : { description: `${model.id} description` },
      })),
    })),
    failures: options.failures ?? [],
  }
}

test('allowlistSummary and lastRouteWhileEnabled are pure', () => {
  assert.equal(allowlistSummary([]), '0 routes')
  assert.equal(allowlistSummary([{ provider: 'p', model: 'm' }]), '1 route')
  assert.equal(allowlistSummary([{ provider: 'p', model: 'm' }, { provider: 'q', model: 'n' }]), '2 routes')
  const only: readonly SubagentAllowedModelRoute[] = [{ provider: 'p', model: 'm' }]
  assert.equal(lastRouteWhileEnabled(true, only, { provider: 'p', model: 'm' }), true)
  assert.equal(lastRouteWhileEnabled(false, only, { provider: 'p', model: 'm' }), false)
  assert.equal(lastRouteWhileEnabled(true, [...only, { provider: 'q', model: 'n' }], { provider: 'p', model: 'm' }), false)
})

test('projection flattens directory groups in catalog order with full-identity allowed markers', () => {
  const projection = projectSubagentAllowlist({
    catalog: { state: 'ready', directory: directoryOf({
      groups: [
        { id: 'p1', name: 'One', models: [{ id: 'shared' }] },
        { id: 'p2', name: 'Two', models: [{ id: 'shared' }] },
      ],
    }) },
    allowed: [{ provider: 'p2', model: 'shared' }],
  })
  assert.deepEqual(projection.models.map(row => allowlistRouteKey(row.providerId, row.modelId)), [
    'p1\u0000shared', 'p2\u0000shared',
  ])
  assert.equal(projection.models[0]!.allowed, false, 'a same-id model under another provider is not allowed')
  assert.equal(projection.models[1]!.allowed, true)
})

test('projection keeps a failed provider as an inert failure row beside the loaded groups', () => {
  const projection = projectSubagentAllowlist({
    catalog: { state: 'ready', directory: directoryOf({
      groups: [{ id: 'a', models: [{ id: 'm' }] }],
      failures: [{ id: 'b', name: 'Bad', message: 'boom' }],
    }) },
    allowed: [],
  })
  assert.deepEqual(projection.models.map(row => row.providerId), ['a'])
  assert.deepEqual(projection.failures, [{ providerId: 'b', providerName: 'Bad', message: 'boom' }])
})

test('only a READY directory can claim a saved route absent', () => {
  const ready: AllowlistCatalogState = {
    state: 'ready',
    directory: directoryOf({ groups: [{ id: 'p', name: 'P', models: [{ id: 'm1' }] }] }),
  }
  const allowed = [{ provider: 'p', model: 'm1' }, { provider: 'gone', model: 'old-model' }] as const
  const projection = projectSubagentAllowlist({ catalog: ready, allowed })
  assert.deepEqual(projection.models.map(row => allowlistRouteKey(row.providerId, row.modelId)), [
    'p\u0000m1',
    'gone\u0000old-model',
  ])
  assert.equal(projection.models[0]!.savedRoute, undefined, 'a listed route is a normal row')
  assert.equal(projection.models[1]!.savedRoute, 'absent', 'the ready directory provably omits it')
  assert.equal(projection.models[1]!.allowed, true)
})

test('a loading catalog never claims absence — saved routes stay saved, unverified', () => {
  const projection = projectSubagentAllowlist({
    catalog: { state: 'loading' },
    allowed: [{ provider: 'gone', model: 'old-model' }],
  })
  assert.equal(projection.models.length, 1, 'the saved route stays representable')
  assert.equal(projection.models[0]!.savedRoute, 'catalog-loading', 'absence is never claimed while loading')
  assert.deepEqual(projection.failures, [])
})

test('a failed whole-directory read never claims absence', () => {
  const projection = projectSubagentAllowlist({
    catalog: { state: 'failed', reason: 'remote connection is not connected' },
    allowed: [{ provider: 'p', model: 'm1' }],
  })
  assert.equal(projection.models[0]!.savedRoute, 'catalog-unavailable')
  assert.deepEqual(projection.failures, [{
    providerId: 'model-directory',
    providerName: 'Model directory',
    message: 'remote connection is not connected',
  }])
})

test('a provider-side failure never claims that provider\'s saved routes absent', () => {
  const projection = projectSubagentAllowlist({
    catalog: { state: 'ready', directory: directoryOf({
      groups: [{ id: 'ok', name: 'Ok', models: [{ id: 'm' }] }],
      failures: [{ id: 'anthropic', name: 'Anthropic', message: 'lookup failed' }],
    }) },
    allowed: [
      { provider: 'anthropic', model: 'claude-x' },
      { provider: 'ok', model: 'really-gone' },
    ],
  })
  const anthropic = projection.models.find(row => row.providerId === 'anthropic')!
  const okGone = projection.models.find(row => row.providerId === 'ok' && row.modelId === 'really-gone')!
  assert.equal(anthropic.savedRoute, 'provider-unavailable',
    'the failed provider\'s catalog could not answer — absence is not a fact')
  assert.equal(okGone.savedRoute, 'absent',
    'the loaded provider\'s omission IS provable')
})
