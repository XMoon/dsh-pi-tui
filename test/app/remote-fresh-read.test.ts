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
