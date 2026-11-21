/**
 * The Remote fresh authoritative Backend read and the exit-time Host-stop gate.
 *
 * F1 Path 3 (A14): the production `RemoteConfigPort.backendStartupPreference.readFresh()`
 * over the real mirror (fake official transport) forces a NEW official settings read
 * — never a stale snapshot or a previously-started in-flight refresh — so a concurrent
 * revert by another Client (with its notification still delayed) is observed before
 * any Host stop is authorized. The read result feeds the REAL Host-stop eligibility
 * decision (the production `hostStopEligible` shape).
 *
 * Evidence: real Remote config adapter + mirror freshness + the eligibility decision
 * (L5 composition). No PTY needed.
 * @module @xmoon76/dsh-pi-tui/remote-fresh-read.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { RemoteConfigPort } from '../../src/runtime/remote/config-remote.ts'
import { createExitController } from '../../src/app/bootstrap/exit.ts'
import { createExitIntentCoordinator } from '../../src/app/bootstrap/exit-intent.ts'
import type { ExitChoiceModel, SurfaceExitChoiceSeam } from '../../src/app/surface/exit-choice.ts'
import { createDiag } from '../../src/runtime/process/diagnostics.ts'
import { createObservableGenerationHarness } from '../support/remote-generation.ts'

interface FakeNamespace { ns: string; value: Record<string, unknown>; user?: Record<string, unknown>; revision: number }

function remotePort(seed: (state: {
  namespaces: Map<string, FakeNamespace>
  describeFailure: { code: string; message: string } | undefined
  describeCount: { n: number }
}) => void) {
  const generation = createObservableGenerationHarness({ id: 'gen-1' })
  const state = {
    namespaces: new Map<string, FakeNamespace>(),
    describeFailure: undefined as { code: string; message: string } | undefined,
    describeCount: { n: 0 },
  }
  seed(state)
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const wire: Record<string, unknown> = {}
  const remote = {
    settings: {
      describe: async () => {
        state.describeCount.n += 1
        if (state.describeFailure !== undefined) return { ok: false as const, error: state.describeFailure }
        return {
          ok: true as const,
          value: {
            writable: true, hasDocument: true,
            namespaces: [...state.namespaces.values()].map(e => ({ ns: e.ns, value: structuredClone(e.value), ...(e.user === undefined ? {} : { user: structuredClone(e.user) }), revision: e.revision })),
          },
        }
      },
      mutate: async () => ({ ok: true as const, value: {} }),
    },
    llm: { listConfigurableProviders: async () => ({ ok: true as const, value: [] }) },
    permissionPresets: { catalog: async () => ({ ok: true as const, value: { options: [] } }) },
    agentPresets: { list: async () => ({ ok: true as const, value: { presets: [] } }) },
    $on(this: unknown, event: string, listener: (...args: unknown[]) => void) {
      if (this !== wire) throw new TypeError('unbound event seat')
      let set = listeners.get(event)
      if (set === undefined) { set = new Set(); listeners.set(event, set) }
      set.add(listener)
      return () => { set!.delete(listener) }
    },
  }
  for (const [key, value] of Object.entries(remote)) Object.defineProperty(wire, key, { get: () => value, enumerable: false, configurable: false })
  const port = new RemoteConfigPort({ remote: wire as never, connection: { generation: generation.source } })
  return { port, state, generation }
}

// The production `hostStopEligible` shape (bootstrap): a FRESH authoritative read
// that still confirms `direct` with a ready configuration authorizes asking.
function eligibleFactory(port: RemoteConfigPort) {
  return async (): Promise<boolean> => {
    // The production verify helper wraps hostStopEligible in try/catch (a read
    // failure/throw refuses the stop); mirror that so a failure is never an
    // authorization.
    try {
      const state = await port.backendStartupPreference.readFresh()
      if (port.configReadiness() !== 'ready') return false
      return state?.backend === 'direct'
    } catch {
      return false
    }
  }
}

test('a fresh authoritative read observes another Client\'s daemon revert (delayed notification) and refuses the Host stop', async () => {
  // A saved daemon→direct (the profile reads `direct`); A earned the exit intent.
  const { port, state } = remotePort(s => {
    s.namespaces.set('tui-startup', { ns: 'tui-startup', value: { backend: 'direct' }, user: { backend: 'direct' }, revision: 3 })
  })
  const hostStopEligible = eligibleFactory(port)
  // The initial fresh read confirms the transition.
  assert.equal(await hostStopEligible(), true, 'a fresh read of `direct` authorizes asking about the old Host')

  // ANOTHER Client reverts the Profile to `daemon` (its write landed on the Host),
  // but the settings/document-updated notification is still DELAYED (not fired).
  const ns = state.namespaces.get('tui-startup')!
  ns.value = { backend: 'daemon' }
  ns.user = { backend: 'daemon' }
  ns.revision += 1
  // No invalidation event fired: the mirror's last snapshot may still read `direct`.
  const describesBefore = state.describeCount.n
  // A's Stop click: the fresh authoritative read must NOT reuse the stale snapshot
  // (or a previously-started in-flight refresh) — it forces a NEW official read and
  // observes the revert, so the Host stop is refused.
  assert.equal(await hostStopEligible(), false, 'a fresh read observes the revert and refuses the Host stop')
  assert.ok(state.describeCount.n > describesBefore, 'the fresh read forced a NEW official settings describe')
})

test('a stale snapshot alone would authorize the stop — only the fresh read catches the revert', async () => {
  const { port, state } = remotePort(s => {
    s.namespaces.set('tui-startup', { ns: 'tui-startup', value: { backend: 'direct' }, user: { backend: 'direct' }, revision: 3 })
  })
  // Establish the mirror's committed snapshot as `direct`.
  await port.backendStartupPreference.readFresh()
  // Another Client reverts to `daemon` with a delayed notification.
  const ns = state.namespaces.get('tui-startup')!
  ns.value = { backend: 'daemon' }; ns.user = { backend: 'daemon' }; ns.revision += 1
  // The STALE mirror read still shows `direct` (the notification never arrived).
  assert.equal(port.backendStartupPreference.read()?.backend, 'direct', 'the un-refreshed snapshot is stale')
  // Only the FRESH authoritative read observes the revert.
  assert.equal((await port.backendStartupPreference.readFresh())?.backend, 'daemon', 'the fresh read is authoritative')
})

test('a configuration read failure never authorizes the Host stop', async () => {
  const { port, state } = remotePort(s => {
    s.namespaces.set('tui-startup', { ns: 'tui-startup', value: { backend: 'direct' }, revision: 3 })
    s.describeFailure = { code: 'settings/unavailable', message: 'boom' }
  })
  const hostStopEligible = eligibleFactory(port)
  assert.equal(await hostStopEligible(), false, 'a failed fresh read refuses the Host stop')
  void state
})


// ── the connector F5 asked for: real Remote fresh read -> real Coordinator -> real exit root

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

/**
 * Drive the PRODUCTION exit-intent coordinator over the REAL Remote config port
 * and let its commit enter the REAL exit controller. This is the missing seam
 * between "the Remote fresh read refuses a stale stop" and "no admin stop ran":
 * every decision below is made by production code; only the official wire is a
 * fixture (the same one the tests above use).
 */
async function driveHostStopThroughProduction(options: {
  readonly seed: Parameters<typeof remotePort>[0]
  readonly revertBeforeStop: boolean
}) {
  const { port, state } = remotePort(options.seed)
  const diag = createDiag({ filePath: undefined, stderrLevel: 'off', sinks: [{ write: () => {} }] })
  const adminStops: string[] = []
  const exitCodes: number[] = []
  const commits: Array<{ workStopped: boolean; hostStopRequested?: boolean }> = []
  const models: ExitChoiceModel[] = []
  let open: ExitChoiceModel | undefined
  const seam: SurfaceExitChoiceSeam = {
    open: model => { open = model; models.push(model) },
    update: model => { open = model; models.push(model) },
    close: () => { open = undefined },
  }
  const { requestExit } = createExitController({
    diag,
    cleanup: () => {},
    hint: () => {},
    resumeHint: () => undefined,
    exit: code => { exitCodes.push(code) },
    adminStop: async () => {
      adminStops.push('stop')
      return { code: 0, stdout: '', stderr: '' }
    },
  })
  // The production `hostStopEligible` shape from bootstrap.ts, over the REAL port.
  const coordinator = createExitIntentCoordinator({
    diag,
    facts: {
      currentBackend: () => 'daemon' as const,
      capture: () => ({ scope: { sessionId: undefined } as never, live: undefined, activity: 'idle' as const, shellRunning: false }),
      isScopeCurrent: () => true,
      hostStopIntentCurrent: () => true,
      hostStopReadinessCurrent: () => port.configReadiness() === 'ready',
      hostStopEligible: async () => {
        const fresh = await port.backendStartupPreference.readFresh()
        if (port.configReadiness() !== 'ready') return false
        return fresh?.backend === 'direct'
      },
    },
    commit: (options_) => {
      commits.push(options_)
      requestExit(options_.hostStopRequested === true ? { hostStopRequested: true } : undefined)
    },
    presenter: () => seam,
    stopCurrentWork: async () => ({ kind: 'stopped' }),
  })
  coordinator.request('slash')
  await tick()
  if (options.revertBeforeStop) {
    // ANOTHER Client reverts the Profile to `daemon` with the notification still
    // delayed, exactly like the tests above.
    const ns = state.namespaces.get('tui-startup')!
    ns.value = { backend: 'daemon' }
    ns.user = { backend: 'daemon' }
    ns.revision += 1
  }
  await tick()
  // The user's Stop click, on whatever the coordinator decided to present.
  if (open !== undefined) open.select('stop-host-and-exit')
  await tick()
  await tick()
  coordinator.dispose()
  return { adminStops, exitCodes, commits, models, state }
}

test('the production Coordinator refuses the Stop on a fresh read that lost `direct`: ZERO admin stops', async () => {
  const run = await driveHostStopThroughProduction({
    seed: s => {
      s.namespaces.set('tui-startup', { ns: 'tui-startup', value: { backend: 'direct' }, user: { backend: 'direct' }, revision: 3 })
    },
    revertBeforeStop: true,
  })
  assert.ok(run.models.some(model => model.kind === 'daemon-host-stop'),
    'the confirm was offered while the read still said `direct`')
  assert.deepEqual(run.commits, [{ workStopped: false }],
    'the ACCEPT-time fresh read observed the revert, so the click commits a plain detach')
  assert.deepEqual(run.adminStops, [], 'the exit root ran NO admin stop')
  assert.deepEqual(run.exitCodes, [0], 'the Client exits as a plain detach')
})

test('the same connector runs exactly ONE admin stop when the fresh read still confirms `direct`', async () => {
  const run = await driveHostStopThroughProduction({
    seed: s => {
      s.namespaces.set('tui-startup', { ns: 'tui-startup', value: { backend: 'direct' }, user: { backend: 'direct' }, revision: 3 })
    },
    revertBeforeStop: false,
  })
  assert.ok(run.models.some(model => model.kind === 'daemon-host-stop'),
    'the fresh read confirms the conversion, so the confirm is offered')
  assert.deepEqual(run.commits, [{ workStopped: false, hostStopRequested: true }])
  assert.deepEqual(run.adminStops, ['stop'], 'exactly one admin stop')
  assert.deepEqual(run.exitCodes, [0], 'the control-plane verdict is the exit code')
})
