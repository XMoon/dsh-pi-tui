/**
 * Subagent settings over the REAL Remote wire.
 *
 * REAL: remote Host fixture, generated `settings` Remote, official
 * SettingsForms/ConfigEditor over the disposable subagent profile, production
 * RemoteConfigPort and its ONE shared settings mirror.
 * ABSENT: physical terminal, real user DSH_HOME.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { createRemoteClientRuntime } from '../support/m3-inprocess/client-runtime.ts'
import { createRemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import { createRemoteBackendRuntime } from '../../src/app/remote/runtime.ts'
import { RemoteConfigPort } from '../../src/runtime/remote/config-remote.ts'
import {
  createRemoteApplicationHostFixture,
  testPromptSerializer,
} from '../support/remote-application-fixture.ts'
import { mountSubagentSectionPlane } from '../support/subagent-section-fixture.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import type { SectionRead } from '../../src/runtime/config-port.ts'

const LIMITS_NS = 'subagent'
const SELECTION_NS = 'subagent-model-selection-settings'

interface HostSettings {
  describe(): readonly { ns: string; revision?: number }[]
  mutate(
    ns: string,
    ops: readonly { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[],
    expectedRevision?: number,
  ): Promise<unknown>
}

function ready<T extends object>(read: SectionRead<T>) {
  assert.equal(read.kind, 'ready', `the section must be readable: ${read.kind === 'ready' ? '' : read.reason}`)
  if (read.kind !== 'ready') throw new Error('unreachable')
  return read
}

test('the Remote wire reads both sections, writes each exact CAS batch and resets through official unset', async t => {
  const life = testLifecycle(t)
  const host = await createRemoteApplicationHostFixture(life, 'subagent-settings-remote-wire')
  const plane = await mountSubagentSectionPlane(host.ctx, join(host.workRoot, 'subagent-plane'), {
    enabled: false,
    allowedModels: [{ provider: 'alpha', model: 'fast' }],
    limits: { maxDepth: 2, maxActiveSubagents: 4 },
  })
  const hostSettings = (host.ctx as unknown as { settings: HostSettings }).settings

  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const assembled = await createRemoteBackendRuntime({
    runtime: client,
    promptSerializer: testPromptSerializer,
    fetch: hostRuntime.carrier.fetch,
  })
  t.after(async () => {
    assembled.dispose()
    await client.dispose()
    await hostRuntime.dispose()
    await host.dispose()
  })

  const config = assembled.backend.config
  assert.ok(config instanceof RemoteConfigPort)
  assert.equal(config.configReadiness(), 'ready')

  // Both official namespaces are projected from the ONE mirror, not a second
  // settings read.
  const limits = ready(config.subagentLimits.read())
  const selection = ready(config.subagentModelSelection.read())
  assert.deepEqual(limits.effective, { maxDepth: 2, maxActiveSubagents: 4 })
  assert.deepEqual(limits.inherited, { maxDepth: 2, maxActiveSubagents: 4 })
  assert.deepEqual(selection.effective, { enabled: false, allowedModels: [{ provider: 'alpha', model: 'fast' }] })

  // One namespace write at the read revision. The Host profile really changes
  // and the adapter's readback (never an ACK-only value) reflects it.
  const limitsWrite = await config.subagentLimits.mutate({
    maxDepth: { kind: 'set', value: 0 },
    maxActiveSubagents: { kind: 'set', value: 3 },
  }, limits.revision, limits.generation)
  assert.deepEqual(limitsWrite, { kind: 'accepted' })
  assert.deepEqual(ready(config.subagentLimits.read()).effective, { maxDepth: 0, maxActiveSubagents: 3 })
  assert.deepEqual(plane.userConfig(LIMITS_NS), { maxDepth: 0, maxActiveSubagents: 3 })

  // A sibling USER override makes Reset's official unset materialize the
  // inherited list in the USER patch. Effective inheritance is the contract.
  const firstEnabled = ready(config.subagentModelSelection.read())
  assert.deepEqual(await config.subagentModelSelection.mutate({
    enabled: { kind: 'set', value: true },
  }, firstEnabled.revision, firstEnabled.generation), { kind: 'accepted' })
  const firstRoutes = ready(config.subagentModelSelection.read())
  assert.deepEqual(await config.subagentModelSelection.mutate({
    allowedModels: { kind: 'set', value: [{ provider: 'beta', model: 'edit' }] },
  }, firstRoutes.revision, firstRoutes.generation), { kind: 'accepted' })
  const beforeReset = ready(config.subagentModelSelection.read())
  assert.deepEqual(beforeReset.effective, { enabled: true, allowedModels: [{ provider: 'beta', model: 'edit' }] })

  assert.deepEqual(await config.subagentModelSelection.mutate({
    allowedModels: { kind: 'reset' },
  }, beforeReset.revision, beforeReset.generation), { kind: 'accepted' })
  const afterReset = ready(config.subagentModelSelection.read())
  assert.deepEqual(afterReset.effective, { enabled: true, allowedModels: [{ provider: 'alpha', model: 'fast' }] })
  const materialized = plane.userConfig(SELECTION_NS) as {
    enabled?: boolean
    allowedModels?: readonly { provider: string; model: string }[]
  }
  assert.equal(materialized.enabled, true, 'the sibling USER override is preserved')
  assert.deepEqual(materialized.allowedModels, [{ provider: 'alpha', model: 'fast' }],
    'rc.3 materializes the inherited Reset value in the USER patch; it is not Reset failure')

  // An external Host edit between the decision read and dispatch is a definite
  // conflict. The stale intent writes nothing and the external value survives.
  const stale = ready(config.subagentModelSelection.read())
  const live = hostSettings.describe().find(entry => entry.ns === SELECTION_NS)
  await hostSettings.mutate(SELECTION_NS, [{ op: 'set', path: ['enabled'], value: false }], live?.revision)
  const staleOutcome = await config.subagentModelSelection.mutate({
    enabled: { kind: 'set', value: true },
  }, stale.revision, stale.generation)
  assert.equal(staleOutcome.kind, 'conflict')
  assert.equal(ready(config.subagentModelSelection.read()).effective.enabled, false)

  // Independent namespaces: a Limits success is not rolled back by a stale
  // Selection intent, and Selection keeps the winner's value.
  const freshLimits = ready(config.subagentLimits.read())
  const staleSelection = ready(config.subagentModelSelection.read())
  await hostSettings.mutate(SELECTION_NS, [{ op: 'set', path: ['enabled'], value: true }])
  const first = await config.subagentLimits.mutate({
    maxDepth: { kind: 'reset' },
  }, freshLimits.revision, freshLimits.generation)
  assert.deepEqual(first, { kind: 'accepted' })
  const second = await config.subagentModelSelection.mutate({
    enabled: { kind: 'set', value: false },
  }, staleSelection.revision, staleSelection.generation)
  assert.equal(second.kind, 'conflict')
  assert.equal(ready(config.subagentModelSelection.read()).effective.enabled, true,
    'the external winner survives the stale selection intent')
  assert.equal(ready(config.subagentLimits.read()).effective.maxDepth, 2,
    'the accepted Limits reset is not rolled back')
})
